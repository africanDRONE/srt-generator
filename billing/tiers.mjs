/**
 * Tier logic for the billing service, kept separate from Express so it can be tested
 * with fake Stripe and Supabase clients.
 *
 * Rule: Stripe is the source of truth for who has paid. We never trust the snapshot
 * inside a webhook event, because Stripe does not guarantee event order and a retried
 * event carries its ORIGINAL snapshot. A late retry of `customer.subscription.created`
 * (status "incomplete", taken before the first payment cleared) used to overwrite a
 * freshly paid profile back to "free". Every write now re-reads the customer's live
 * subscriptions, so the order and age of events no longer matter.
 */

export const RANK = { free: 0, solo: 1, team: 2 };

// Statuses that keep access. past_due keeps access while Stripe retries a failed
// renewal; access ends only when Stripe gives up (unpaid / canceled). "incomplete"
// is a first payment that has not cleared yet, so it grants nothing. This relies on
// the account's billing setting "If all retries for a payment fail: cancel the
// subscription" (checked 3 Nov 2026). Under "leave as past-due" access would never end.
export const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

// tierForUser (the /billing/me read path) caches each customer's live tier this long.
// Webhooks, reconcile() and checkout always read Stripe fresh.
export const CACHE_MS = 60 * 1000;
export const CACHE_MAX = 1000;

const now = () => new Date().toISOString();
// Own keys only, so a missing price id never matches "undefined" or Object.prototype.
const own = (obj, key) => typeof key === "string" && Object.hasOwn(obj, key);

// reconcileWrites: false makes reconcile() report what it would change without writing,
// for the first run against production.
export function makeTiers({ stripe, supabase, priceToTier, log = console, clock = Date.now, reconcileWrites = true }) {
  const priceIds = (sub) => (sub.items?.data || []).map((item) => item?.price?.id).join(",") || "none";
  const productId = (price) => (typeof price?.product === "string" ? price.product : price?.product?.id) || null;

  // The Stripe account also sells other products. SubCaptions' products are the ones
  // our mapped prices belong to, looked up once from Stripe. A failed lookup is not
  // cached, so the caller throws and Stripe retries.
  let ourProducts = null;
  async function subcaptionsProducts() {
    if (ourProducts) return ourProducts;
    const found = new Set();
    for (const id of Object.keys(priceToTier)) found.add(productId(await stripe.prices.retrieve(id)));
    found.delete(null);
    return (ourProducts = found);
  }

  // Whether a subscription has any item on a SubCaptions product.
  async function isOurs(sub) {
    if (subTier(sub)) return true;
    const products = await subcaptionsProducts();
    return (sub.items?.data || []).some((item) => products.has(productId(item?.price)));
  }

  // The best tier among a subscription's items, or null when none of its prices is ours.
  // Every item counts: a subscription can carry add-ons, and ours is not always items[0].
  function subTier(sub) {
    let best = null;
    for (const item of sub.items?.data || []) {
      const id = item?.price?.id;
      const tier = own(priceToTier, id) ? priceToTier[id] : null;
      if (own(RANK, tier) && (best === null || RANK[tier] > RANK[best])) best = tier;
    }
    return best;
  }

  // The best tier any of this customer's live subscriptions entitles them to.
  // Subscriptions to the account's other products are skipped. A paid SubCaptions
  // subscription with no mapped price throws instead of counting as free: it means a
  // PRICE_* env var is missing or a new price was never added, and "free" would
  // downgrade someone who is paying. The webhook then returns 500 so Stripe retries,
  // and tierForUser keeps the stored tier.
  async function tierForCustomer(customerId) {
    let best = "free";
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
      if (!PAID_STATUSES.has(sub.status)) continue;
      const tier = subTier(sub);
      if (!tier) {
        if (!(await isOurs(sub))) continue;
        throw Object.assign(new Error(`unmapped price ${priceIds(sub)} on ${sub.id}`), { unmapped: true });
      }
      if (RANK[tier] > RANK[best]) best = tier;
    }
    return best;
  }

  // tierForCustomer behind a short cache, for the read path only. Errors are not cached.
  // When the map is full, expired entries are pruned and then the oldest entry goes, so
  // it cannot grow without bound.
  const cache = new Map(); // customerId -> { tier, at }
  async function cachedTierForCustomer(customerId) {
    const hit = cache.get(customerId);
    if (hit && clock() - hit.at < CACHE_MS) return hit.tier;
    const tier = await tierForCustomer(customerId);
    cache.delete(customerId); // re-insert at the end, so the first key is always the oldest
    if (cache.size >= CACHE_MAX) for (const [k, v] of cache) if (clock() - v.at >= CACHE_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(customerId, { tier, at: clock() });
    return tier;
  }

  // Supabase errors must surface: a swallowed write error used to return 200 to Stripe,
  // which then never retried, and the payment was silently lost.
  async function updateProfile(match, fields) {
    let q = supabase.from("profiles").update({ ...fields, updated_at: now() });
    for (const [col, val] of Object.entries(match)) q = q.eq(col, val);
    const { data, error } = await q.select("id");
    if (error) throw new Error(`profiles update failed: ${error.message}`);
    return data || [];
  }

  // Which SubCaptions user a Stripe customer belongs to, for customers whose profile
  // was never linked (for example, checkout.session.completed failed every retry).
  async function findUserIdForCustomer(customerId) {
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
      if (sub.metadata?.supabase_user_id) return sub.metadata.supabase_user_id;
    }
    for await (const s of stripe.checkout.sessions.list({ customer: customerId, limit: 100 })) {
      if (s.client_reference_id && s.status === "complete") return s.client_reference_id;
    }
    return null;
  }

  // Links a completed checkout to the user who started it and sets their tier. Used by
  // the webhook and by /billing/confirm when the browser returns from Stripe. Returns
  // the tier written, or null when the session is not a SubCaptions subscription.
  async function linkCheckout(s) {
    if (!s.client_reference_id || !s.customer) return null;
    // SubCaptions only sells subscriptions. A one-off payment on the shared Stripe
    // account is another product's, and its client_reference_id is not our user id.
    if (s.mode && s.mode !== "subscription") { log.log(`checkout ${s.id} ignored: mode=${s.mode}`); return null; }
    cache.delete(s.customer);
    const tier = await tierForCustomer(s.customer);
    // A subscription checkout for another product may also carry a client_reference_id.
    if (tier === "free" && s.subscription) {
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      if (!(await isOurs(await stripe.subscriptions.retrieve(subId)))) { log.log(`checkout ${s.id} ignored: not a SubCaptions product`); return null; }
    }
    await updateProfile({ id: s.client_reference_id }, { stripe_customer_id: s.customer, tier });
    log.log(`checkout linked user=${s.client_reference_id} customer=${s.customer} tier=${tier}`);
    return tier;
  }

  async function handleEvent(event) {
    if (event.type === "checkout.session.completed") {
      await linkCheckout(event.data.object);
    } else if (event.type.startsWith("customer.subscription.")) {
      const customerId = event.data.object.customer;
      const userId = event.data.object.metadata?.supabase_user_id;
      // Another product's subscription. The tier is computed from all of the customer's
      // subscriptions, so skipping this event loses nothing, and a 500 would make Stripe
      // retry an event that is not ours for days.
      if (!(await isOurs(event.data.object))) {
        log.log(`${event.type} ${event.data.object.id} ignored: not a SubCaptions product`);
        return;
      }
      // The read path must not heal back a tier this event is about to lower.
      cache.delete(customerId);
      const tier = await tierForCustomer(customerId);
      const rows = await updateProfile({ stripe_customer_id: customerId }, { tier });
      if (!rows.length) {
        // Profile not linked yet (this event beat checkout.session.completed). Link it
        // now if the subscription says whose it is; otherwise checkout will link it.
        if (userId) await updateProfile({ id: userId }, { stripe_customer_id: customerId, tier });
      }
      log.log(`${event.type} customer=${customerId} tier=${tier} rows=${rows.length}`);
    }
  }

  // Self-heal on read. If the stored tier is lower than what Stripe says the customer
  // pays for, fix it now so a paying user never sees "Free". Downgrades are left to the
  // webhook and reconcile(), so a Stripe hiccup here can never take access away.
  // strict (checkout) reads Stripe fresh and lets a failed check throw; otherwise the
  // live tier comes from the short cache and a failed check falls back to the stored tier.
  async function userPlan(userId, { strict = false } = {}) {
    const { data, error } = await supabase.from("profiles").select("tier, stripe_customer_id").eq("id", userId).maybeSingle();
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    const stored = data?.tier || "free";
    const customer = data?.stripe_customer_id || null;
    if (!customer || stored === "team") return { tier: stored, customer };
    let live;
    try { live = await (strict ? tierForCustomer : cachedTierForCustomer)(customer); }
    catch (e) {
      if (strict) throw e;
      log.error("live tier check failed", e);
      return { tier: stored, customer };
    }
    if (RANK[live] > RANK[stored]) {
      await updateProfile({ id: userId }, { tier: live });
      log.warn(`TIER DRIFT healed on read user=${userId} ${stored} -> ${live}`);
      return { tier: live, customer };
    }
    return { tier: stored, customer };
  }

  async function tierForUser(userId) {
    return (await userPlan(userId)).tier;
  }

  // What /billing/checkout should do. Any read error throws so the route answers 503:
  // falling through to a new checkout after a failed read could create a second Stripe
  // customer (customer_email) or a second subscription, and charge the user twice.
  async function checkoutPlan(userId) {
    const { tier, customer } = await userPlan(userId, { strict: true });
    return { customer, portal: RANK[tier] > RANK.free && customer !== null };
  }

  // Full sweep: every paying Stripe customer must have a matching paid profile, and
  // every paid profile linked to Stripe must still be paying. Returns what it changed.
  // Each customer and each profile is handled on its own: one bad row (for example two
  // profiles sharing a stripe_customer_id, which makes maybeSingle fail) is reported in
  // the result as { user, customer, error } and the sweep continues.
  async function reconcile() {
    const changes = [];
    const dry = reconcileWrites ? {} : { dryRun: true };
    const paying = new Map(); // customerId -> tier
    for (const status of PAID_STATUSES) {
      for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
        // No SubCaptions price: one of the account's other products.
        const tier = subTier(sub);
        if (!tier) continue;
        const current = paying.get(sub.customer);
        if (!current || RANK[tier] > RANK[current]) paying.set(sub.customer, tier);
      }
    }
    for (const [customerId, swept] of paying) {
      let user = null;
      try {
        const { data: profile, error } = await supabase.from("profiles").select("id, tier").eq("stripe_customer_id", customerId).maybeSingle();
        if (error) throw new Error(`profiles read failed: ${error.message}`);
        if (profile) {
          user = profile.id;
          if (profile.tier === swept) continue;
          // The sweep's list can be minutes old by now. Re-read before writing, so a
          // cancel or upgrade that landed mid-sweep is not overwritten.
          const tier = await tierForCustomer(customerId);
          if (profile.tier === tier) continue;
          if (reconcileWrites) await updateProfile({ id: profile.id }, { tier });
          changes.push({ user: profile.id, customer: customerId, from: profile.tier, to: tier, ...dry });
          continue;
        }
        user = await findUserIdForCustomer(customerId);
        if (!user) { changes.push({ user: null, customer: customerId, from: null, to: swept, note: "paying customer with no SubCaptions user found" }); continue; }
        const tier = await tierForCustomer(customerId);
        if (!reconcileWrites) { changes.push({ user, customer: customerId, from: "unlinked", to: tier, ...dry }); continue; }
        const linked = await updateProfile({ id: user }, { stripe_customer_id: customerId, tier });
        changes.push(linked.length
          ? { user, customer: customerId, from: "unlinked", to: tier }
          : { user, customer: customerId, from: null, to: tier, note: "paying customer points to a user with no profile row" });
      } catch (e) {
        changes.push({ user, customer: customerId, error: e.message });
      }
    }
    // Paid profiles whose Stripe customer no longer pays. Profiles with no
    // stripe_customer_id are manual grants and are left alone.
    const { data: paid, error } = await supabase.from("profiles").select("id, tier, stripe_customer_id").in("tier", ["solo", "team"]).not("stripe_customer_id", "is", null);
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    for (const p of paid || []) {
      if (paying.has(p.stripe_customer_id)) continue;
      try {
        const live = await tierForCustomer(p.stripe_customer_id); // double-check before taking access away
        if (live === p.tier) continue;
        if (reconcileWrites) await updateProfile({ id: p.id }, { tier: live });
        changes.push({ user: p.id, customer: p.stripe_customer_id, from: p.tier, to: live, ...dry });
      } catch (e) {
        changes.push({ user: p.id, customer: p.stripe_customer_id, error: e.message });
      }
    }
    return changes;
  }

  return { tierForCustomer, handleEvent, linkCheckout, tierForUser, checkoutPlan, reconcile };
}
