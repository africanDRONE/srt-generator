import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTiers, CACHE_MS, CACHE_MAX, PAID_STATUSES } from "./tiers.mjs";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const log = { log() {}, warn() {}, error() {} };
const priceToTier = { price_solo_m: "solo", price_team_m: "team" };
// The product each price belongs to. price_unknown is a SubCaptions price that no
// PRICE_* env var maps (a config mistake); the others belong to the account's other
// products. Unlisted ids default to another product.
const PRODUCT = { price_solo_m: "prod_subcap", price_team_m: "prod_subcap", price_unknown: "prod_subcap" };
const productOf = (price) => PRODUCT[price] || "prod_other";

// Fake Stripe. list() returns an async iterable, like the real SDK's auto-paging
// lists. Filters by params.customer and params.status ("all" or absent = no filter).
// beforeList, when set, runs inside each subscriptions.list() call before iteration,
// so a test can change Stripe's state between two reads.
function makeStripe({ subscriptions = [], sessions = [] } = {}) {
  const data = {
    subscriptions: structuredClone(subscriptions),
    sessions: structuredClone(sessions),
  };
  const fail = { subscriptions: false, prices: false };
  const hooks = { beforeList: null };
  const priceCalls = [];
  const calls = []; // params of every subscriptions.list() call
  const matches = (item, params) =>
    (params.customer === undefined || item.customer === params.customer) &&
    (params.status === undefined || params.status === "all" || item.status === params.status);
  async function* iterate(items, params) {
    for (const item of items) if (matches(item, params)) yield structuredClone(item);
  }
  const client = {
    subscriptions: {
      list(params = {}) {
        calls.push(params);
        if (fail.subscriptions) throw new Error("stripe is down");
        hooks.beforeList?.(params, data);
        return iterate(data.subscriptions, params);
      },
      async retrieve(id) {
        if (fail.subscriptions) throw new Error("stripe is down");
        const found = data.subscriptions.find((s) => s.id === id);
        if (!found) throw new Error(`No such subscription: '${id}'`);
        return structuredClone(found);
      },
    },
    prices: {
      async retrieve(id) {
        priceCalls.push(id);
        if (fail.prices) throw new Error("stripe is down");
        return { id, object: "price", product: productOf(id) };
      },
    },
    checkout: {
      sessions: {
        list(params = {}) {
          return iterate(data.sessions, params);
        },
      },
    },
  };
  return { client, data, fail, hooks, calls, priceCalls, callsFor: (customer) => calls.filter((c) => c.customer === customer).length };
}

// Fake Supabase with an in-memory profiles table. Supports only the chains the
// module uses, and returns only the selected columns like the real client does.
function makeSupabase(initialRows = []) {
  const rows = structuredClone(initialRows);
  const fail = { reads: false, updates: false };
  const writes = [];
  const boom = { data: null, error: { message: "boom" } };

  const project = (row, cols) => {
    if (cols.trim() === "*") return structuredClone(row);
    return Object.fromEntries(cols.split(",").map((c) => c.trim()).map((k) => [k, row[k]]));
  };

  function from(table) {
    assert.equal(table, "profiles", "module should only touch the profiles table");
    return {
      update(fields) {
        const filters = [];
        const match = [];
        const builder = {
          eq(col, val) {
            filters.push((r) => r[col] === val);
            match.push([col, val]);
            return builder;
          },
          async select(cols) {
            if (fail.updates) return boom;
            if (!filters.length) throw new Error("fake: update without a filter would hit every row");
            const hit = rows.filter((r) => filters.every((f) => f(r)));
            for (const r of hit) Object.assign(r, fields);
            writes.push({ match, fields, matched: hit.length });
            return { data: hit.map((r) => project(r, cols)), error: null };
          },
        };
        return builder;
      },
      select(cols) {
        const filters = [];
        const builder = {
          eq(col, val) {
            filters.push((r) => r[col] === val);
            return builder;
          },
          in(col, values) {
            filters.push((r) => values.includes(r[col]));
            return builder;
          },
          async maybeSingle() {
            if (fail.reads) return boom;
            const hit = rows.filter((r) => filters.every((f) => f(r)));
            if (hit.length > 1) {
              return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
            }
            return { data: hit.length ? project(hit[0], cols) : null, error: null };
          },
          async not(col, op, val) {
            assert.equal(op, "is", "fake only supports .not(col, 'is', null)");
            assert.equal(val, null, "fake only supports .not(col, 'is', null)");
            if (fail.reads) return boom;
            const hit = rows.filter((r) => filters.every((f) => f(r)) && r[col] !== null && r[col] !== undefined);
            return { data: hit.map((r) => project(r, cols)), error: null };
          },
        };
        return builder;
      },
    };
  }

  return {
    client: { from },
    fail,
    writes,
    row: (id) => rows.find((r) => r.id === id),
    snapshot: () => structuredClone(rows),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2020-01-01T00:00:00.000Z";
const profile = (id, tier, stripe_customer_id = null) => ({ id, tier, stripe_customer_id, updated_at: T0 });

// prices (a list) overrides price for multi-item subscriptions.
const sub = ({ id, customer, status = "active", price = "price_solo_m", prices = [price], metadata = {} }) => ({
  id,
  object: "subscription",
  customer,
  status,
  items: { data: prices.map((p) => ({ price: { id: p, product: productOf(p) } })) },
  metadata,
});

const subEvent = (type, { customer, status, price = "price_solo_m", metadata = {} }) => ({
  id: `evt_${type}`,
  type,
  data: { object: sub({ id: "sub_in_event", customer, status, price, metadata }) },
});

const checkoutEvent = ({ clientReferenceId, customer, subscription }) => ({
  id: "evt_checkout",
  type: "checkout.session.completed",
  data: {
    object: { id: "cs_1", object: "checkout.session", client_reference_id: clientReferenceId, customer, subscription, status: "complete" },
  },
});

function setup({ profiles = [], subscriptions = [], sessions = [], reconcileWrites } = {}) {
  const stripe = makeStripe({ subscriptions, sessions });
  const db = makeSupabase(profiles);
  const clock = { t: 1_000_000 };
  const tiers = makeTiers({ stripe: stripe.client, supabase: db.client, priceToTier, log, clock: () => clock.t, reconcileWrites });
  return { stripe, db, tiers, clock };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test("1. a stale incomplete subscription.created event cannot downgrade a paid profile", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  await tiers.handleEvent(subEvent("customer.subscription.created", { customer: "c1", status: "incomplete", price: "price_solo_m" }));
  assert.equal(db.row("u1").tier, "solo");
  assert.equal(db.row("u1").stripe_customer_id, "c1");
});

test("2. subscription.updated before checkout.session.completed changes nothing, then checkout links the user", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free"), profile("u2", "free", "c2")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  const before = db.snapshot();

  await assert.doesNotReject(
    tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m" }))
  );
  assert.deepEqual(db.snapshot(), before, "no profile may change while the customer is unlinked and the event has no metadata");

  await tiers.handleEvent(checkoutEvent({ clientReferenceId: "u1", customer: "c1" }));
  assert.equal(db.row("u1").stripe_customer_id, "c1");
  assert.equal(db.row("u1").tier, "solo");
  assert.deepEqual(db.row("u2"), before.find((r) => r.id === "u2"), "unrelated profile is untouched");
});

test("3. subscription event carrying metadata.supabase_user_id links the user immediately", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free"), profile("u2", "free")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m", metadata: { supabase_user_id: "u1" } })],
  });
  await tiers.handleEvent(
    subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m", metadata: { supabase_user_id: "u1" } })
  );
  assert.equal(db.row("u1").stripe_customer_id, "c1");
  assert.equal(db.row("u1").tier, "solo");
  assert.equal(db.row("u2").stripe_customer_id, null);
  assert.equal(db.row("u2").tier, "free");
});

test("4. past_due keeps solo, a canceled subscription makes the webhook set free", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "past_due", price: "price_solo_m" })],
  });
  await tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "past_due", price: "price_solo_m" }));
  assert.equal(db.row("u1").tier, "solo", "past_due still has access");

  stripe.data.subscriptions[0].status = "canceled";
  await tiers.handleEvent(subEvent("customer.subscription.deleted", { customer: "c1", status: "canceled", price: "price_solo_m" }));
  assert.equal(db.row("u1").tier, "free", "canceled loses access");
});

test("5. a customer with an active solo and an active team subscription gets team", async () => {
  const solo = sub({ id: "sub_solo", customer: "c1", status: "active", price: "price_solo_m" });
  const team = sub({ id: "sub_team", customer: "c1", status: "active", price: "price_team_m" });

  for (const subscriptions of [[solo, team], [team, solo]]) {
    const { db, tiers } = setup({ profiles: [profile("u1", "free", "c1")], subscriptions });
    assert.equal(await tiers.tierForCustomer("c1"), "team");
    await tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m" }));
    assert.equal(db.row("u1").tier, "team");
  }
});

test("6. tierForUser heals stored free to the live solo tier and writes it to the table", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  assert.equal(await tiers.tierForUser("u1"), "solo");
  assert.equal(db.row("u1").tier, "solo");
  assert.equal(db.writes.length, 1);
});

test("7. tierForUser never downgrades: stored solo with a canceled Stripe subscription stays solo", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "canceled", price: "price_solo_m" })],
  });
  const before = db.snapshot();
  assert.equal(await tiers.tierForUser("u1"), "solo");
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes.length, 0);
});

test("8. tierForUser returns the stored tier when the Stripe list throws", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1"), profile("u2", "free", "c2")],
    subscriptions: [sub({ id: "sub_2", customer: "c2", status: "active", price: "price_team_m" })],
  });
  stripe.fail.subscriptions = true;
  const before = db.snapshot();
  assert.equal(await tiers.tierForUser("u1"), "solo");
  assert.equal(await tiers.tierForUser("u2"), "free", "no healing is possible while Stripe is down");
  assert.deepEqual(db.snapshot(), before);
});

test("9. tierForUser rejects when the Supabase read fails", async () => {
  const { db, tiers } = setup({ profiles: [profile("u1", "solo", "c1")] });
  db.fail.reads = true;
  await assert.rejects(tiers.tierForUser("u1"), /profiles read failed: boom/);
});

test("10. handleEvent rejects when the Supabase update fails, so the webhook can return 500", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  db.fail.updates = true;
  await assert.rejects(
    tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m" })),
    /profiles update failed: boom/
  );
  await assert.rejects(tiers.handleEvent(checkoutEvent({ clientReferenceId: "u1", customer: "c1" })), /profiles update failed: boom/);
  assert.equal(db.row("u1").tier, "free");
});

test("11. reconcile links a paying unlinked customer through subscription metadata and reports it", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u9", "free")],
    subscriptions: [sub({ id: "sub_9", customer: "c9", status: "active", price: "price_team_m", metadata: { supabase_user_id: "u9" } })],
  });
  const changes = await tiers.reconcile();
  assert.equal(db.row("u9").stripe_customer_id, "c9");
  assert.equal(db.row("u9").tier, "team");
  assert.deepEqual(changes, [{ user: "u9", customer: "c9", from: "unlinked", to: "team" }]);
});

test("12. reconcile links a paying customer with no metadata through a complete checkout session", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u8", "free"), profile("uX", "free")],
    subscriptions: [sub({ id: "sub_8", customer: "c8", status: "active", price: "price_solo_m" })],
    sessions: [
      // An abandoned session must be ignored even though it lists first.
      { id: "cs_open", customer: "c8", client_reference_id: "uX", status: "open" },
      { id: "cs_done", customer: "c8", client_reference_id: "u8", status: "complete" },
    ],
  });
  const changes = await tiers.reconcile();
  assert.equal(db.row("u8").stripe_customer_id, "c8");
  assert.equal(db.row("u8").tier, "solo");
  assert.equal(db.row("uX").stripe_customer_id, null);
  assert.equal(db.row("uX").tier, "free");
  assert.deepEqual(changes, [{ user: "u8", customer: "c8", from: "unlinked", to: "solo" }]);
});

test("13. reconcile downgrades a solo profile whose only subscription is canceled", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u5", "solo", "c5")],
    subscriptions: [sub({ id: "sub_5", customer: "c5", status: "canceled", price: "price_solo_m" })],
  });
  const changes = await tiers.reconcile();
  assert.equal(db.row("u5").tier, "free");
  assert.deepEqual(changes, [{ user: "u5", customer: "c5", from: "solo", to: "free" }]);
});

test("14. reconcile leaves a manually granted profile with no stripe_customer_id untouched", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u6", "solo", null), profile("u7", "team", null)],
  });
  const before = db.snapshot();
  const changes = await tiers.reconcile();
  assert.deepEqual(changes, []);
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes.length, 0);
});

test("15. reconcile returns [] and writes nothing when everything is consistent", async () => {
  const { db, tiers } = setup({
    profiles: [
      profile("u1", "solo", "c1"),
      profile("u2", "team", "c2"),
      profile("u3", "solo", "c3"),
      profile("u4", "free"),
      profile("u5", "team"), // manual grant
      profile("u6", "free", "c6"), // former customer
    ],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_2", customer: "c2", status: "trialing", price: "price_team_m" }),
      sub({ id: "sub_3", customer: "c3", status: "past_due", price: "price_solo_m" }),
      sub({ id: "sub_6", customer: "c6", status: "canceled", price: "price_solo_m" }),
    ],
  });
  const before = db.snapshot();
  const changes = await tiers.reconcile();
  assert.deepEqual(changes, []);
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes.length, 0);
});

test("16. an unmapped price on a paid subscription throws and never downgrades", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1"), profile("u2", "team", "c2")],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_unknown" }),
      sub({ id: "sub_2", customer: "c2", status: "active", price: "price_team_m" }),
    ],
  });
  const before = db.snapshot();
  await assert.rejects(tiers.tierForCustomer("c1"), /unmapped price price_unknown on sub_1/);
  await assert.rejects(
    tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_unknown" })),
    /unmapped price/,
    "linked customer: the webhook must fail so Stripe retries"
  );
  await assert.rejects(tiers.handleEvent(checkoutEvent({ clientReferenceId: "u1", customer: "c1" })), /unmapped price/);
  assert.equal(await tiers.tierForUser("u1"), "solo", "read path keeps the stored tier");

  const changes = await tiers.reconcile();
  assert.equal(db.row("u1").tier, "solo", "reconcile must not downgrade it");
  assert.deepEqual(changes, [{ user: "u1", customer: "c1", error: "unmapped price price_unknown on sub_1" }]);
  assert.deepEqual(db.snapshot(), before);

  // Unmapped price on a canceled subscription is irrelevant: it grants nothing either way.
  stripe.data.subscriptions[0].status = "canceled";
  assert.equal(await tiers.tierForCustomer("c1"), "free");
});

test("17. a subscription event for another product's customer is acknowledged, not retried", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_x", customer: "c_other", status: "active", price: "price_other_product" })],
  });
  const before = db.snapshot();
  await assert.doesNotReject(
    tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c_other", status: "active", price: "price_other_product" }))
  );
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes.length, 0);
  // Metadata naming a SubCaptions user does not make another product's subscription
  // ours: it must not relink u1 to c_other or downgrade them.
  await assert.doesNotReject(
    tiers.handleEvent(
      subEvent("customer.subscription.updated", { customer: "c_other", status: "active", price: "price_other_product", metadata: { supabase_user_id: "u1" } })
    )
  );
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes.length, 0);
});

test("18. every item on a subscription counts, not only items[0]", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free", "c1"), profile("u2", "free", "c2"), profile("u3", "free", "c3")],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", prices: ["price_addon", "price_team_m"] }),
      sub({ id: "sub_2", customer: "c2", prices: ["price_solo_m", "price_addon"] }),
      sub({ id: "sub_3", customer: "c3", prices: ["price_solo_m", "price_team_m"] }),
    ],
  });
  assert.equal(await tiers.tierForCustomer("c1"), "team");
  assert.equal(await tiers.tierForCustomer("c2"), "solo");
  assert.equal(await tiers.tierForCustomer("c3"), "team");
  const changes = await tiers.reconcile();
  assert.deepEqual(changes, [
    { user: "u1", customer: "c1", from: "free", to: "team" },
    { user: "u2", customer: "c2", from: "free", to: "solo" },
    { user: "u3", customer: "c3", from: "free", to: "team" },
  ]);
  assert.equal(db.row("u1").tier, "team");
});

test("19. one customer's failed profile read does not stop reconcile or the downgrade sweep", async () => {
  const { db, tiers } = setup({
    profiles: [
      // Two profiles share c1 (no unique constraint), so maybeSingle fails for c1.
      profile("u1a", "solo", "c1"),
      profile("u1b", "solo", "c1"),
      profile("u2", "free", "c2"),
      profile("u3", "solo", "c3"),
    ],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_team_m" }),
      sub({ id: "sub_2", customer: "c2", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_3", customer: "c3", status: "canceled", price: "price_solo_m" }),
    ],
  });
  const changes = await tiers.reconcile();
  assert.deepEqual(changes, [
    { user: null, customer: "c1", error: "profiles read failed: multiple rows returned for maybeSingle" },
    { user: "u2", customer: "c2", from: "free", to: "solo" },
    { user: "u3", customer: "c3", from: "solo", to: "free" },
  ]);
  assert.equal(db.row("u1a").tier, "solo", "c1 still pays, so the sweep leaves its profiles alone");
  assert.equal(db.row("u1b").tier, "solo");
  assert.equal(db.row("u2").tier, "solo");
  assert.equal(db.row("u3").tier, "free");
});

test("20. tierForUser caches the live tier for 60s; handleEvent and reconcile read fresh", async () => {
  const { stripe, db, tiers, clock } = setup({
    profiles: [profile("u1", "free", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "incomplete", price: "price_solo_m" })],
  });
  assert.equal(await tiers.tierForUser("u1"), "free");
  assert.equal(stripe.callsFor("c1"), 1);

  stripe.data.subscriptions[0].status = "active"; // first payment clears
  clock.t += CACHE_MS - 1;
  assert.equal(await tiers.tierForUser("u1"), "free", "within 60s the cached tier is used");
  assert.equal(stripe.callsFor("c1"), 1, "no Stripe call on a cache hit");

  await tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m" }));
  assert.equal(stripe.callsFor("c1"), 2, "the webhook ignores the cache");
  assert.equal(db.row("u1").tier, "solo");
  assert.equal(await tiers.tierForUser("u1"), "solo", "stored tier wins over a stale cached free");

  await tiers.reconcile();
  assert.equal(stripe.calls.filter((c) => c.customer === undefined).length, PAID_STATUSES.size, "reconcile lists Stripe fresh");

  // Expiry: a cache entry older than 60s is refetched.
  db.row("u1").tier = "free";
  clock.t += CACHE_MS + 1;
  const callsBefore = stripe.callsFor("c1");
  assert.equal(await tiers.tierForUser("u1"), "solo");
  assert.equal(stripe.callsFor("c1"), callsBefore + 1);
});

test("21. the tier cache is capped and evicts the oldest entry", async () => {
  const n = CACHE_MAX + 1;
  const { stripe, tiers } = setup({
    profiles: Array.from({ length: n }, (_, i) => profile(`u${i}`, "free", `c${i}`)),
  });
  for (let i = 0; i < n; i++) await tiers.tierForUser(`u${i}`);
  assert.equal(stripe.calls.length, n);
  await tiers.tierForUser(`u${n - 1}`); // newest: cached
  assert.equal(stripe.calls.length, n);
  await tiers.tierForUser("u0"); // oldest: evicted when the map was full
  assert.equal(stripe.calls.length, n + 1);
});

test("22. checkoutPlan: portal for payers, checkout otherwise, and it throws on any read error", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [
      profile("u1", "solo", "c1"),
      profile("u2", "free", "c2"), // drift: stored free, Stripe says solo
      profile("u3", "free", "c3"), // former customer
      profile("u4", "free"), // never paid
      profile("u5", "team"), // manual grant, no Stripe customer
    ],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_2", customer: "c2", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_3", customer: "c3", status: "canceled", price: "price_solo_m" }),
    ],
  });
  assert.deepEqual(await tiers.checkoutPlan("u1"), { customer: "c1", portal: true });
  assert.deepEqual(await tiers.checkoutPlan("u2"), { customer: "c2", portal: true }, "self-heals before deciding");
  assert.equal(db.row("u2").tier, "solo");
  assert.deepEqual(await tiers.checkoutPlan("u3"), { customer: "c3", portal: false });
  assert.deepEqual(await tiers.checkoutPlan("u4"), { customer: null, portal: false });
  assert.deepEqual(await tiers.checkoutPlan("u5"), { customer: null, portal: false });

  // Checkout reads Stripe fresh even when /billing/me has a cached tier.
  db.row("u3").tier = "free";
  assert.equal(await tiers.tierForUser("u3"), "free");
  stripe.data.subscriptions[2].status = "active";
  assert.deepEqual(await tiers.checkoutPlan("u3"), { customer: "c3", portal: true });

  stripe.fail.subscriptions = true;
  await assert.rejects(tiers.checkoutPlan("u3"), /stripe is down/, "a failed live check is an error, not a guess");
  stripe.fail.subscriptions = false;
  db.fail.reads = true;
  await assert.rejects(tiers.checkoutPlan("u4"), /profiles read failed: boom/);
});

test("23. a one-off payment checkout on the shared Stripe account writes nothing", async () => {
  const { db, tiers } = setup({ profiles: [profile("u1", "free")] });
  const event = checkoutEvent({ clientReferenceId: "not-a-subcaptions-user", customer: "c_shop" });
  event.data.object.mode = "payment";
  await tiers.handleEvent(event);
  assert.equal(db.writes.length, 0);
  assert.equal(db.row("u1").tier, "free");
});

test("24. a SubCaptions customer who also pays for another product keeps their tier everywhere", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_shop", customer: "c1", status: "active", price: "price_other_product" }),
    ],
  });
  assert.equal(await tiers.tierForCustomer("c1"), "solo");
  assert.deepEqual(await tiers.checkoutPlan("u1"), { customer: "c1", portal: true });
  await tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_other_product" }));
  assert.equal(db.row("u1").tier, "solo");
  assert.deepEqual(await tiers.reconcile(), []);

  // They cancel SubCaptions and keep the other product: free, not an error.
  stripe.data.subscriptions[0].status = "canceled";
  assert.equal(await tiers.tierForCustomer("c1"), "free");
  await tiers.handleEvent(subEvent("customer.subscription.deleted", { customer: "c1", status: "canceled", price: "price_solo_m" }));
  assert.equal(db.row("u1").tier, "free");
});

test("25. a subscription checkout for another product writes nothing; ours still links", async () => {
  const { db, tiers } = setup({
    profiles: [profile("u1", "free")],
    subscriptions: [
      sub({ id: "sub_shop", customer: "c_shop", status: "active", price: "price_other_product" }),
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" }),
    ],
  });
  const other = checkoutEvent({ clientReferenceId: "u1", customer: "c_shop", subscription: "sub_shop" });
  other.data.object.mode = "subscription";
  await tiers.handleEvent(other);
  assert.equal(db.writes.length, 0, "must not link u1 to another product's customer");

  const ours = checkoutEvent({ clientReferenceId: "u1", customer: "c1", subscription: "sub_1" });
  ours.data.object.mode = "subscription";
  assert.equal(await tiers.linkCheckout(ours.data.object), "solo");
  assert.equal(db.row("u1").tier, "solo");
  assert.equal(db.row("u1").stripe_customer_id, "c1");
});

test("26. the SubCaptions product list is fetched once, and a failed fetch makes the webhook retry", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  const otherEvent = subEvent("customer.subscription.updated", { customer: "c_x", status: "active", price: "price_other_product" });
  stripe.fail.prices = true;
  await assert.rejects(tiers.handleEvent(otherEvent), /stripe is down/);
  stripe.fail.prices = false;
  await tiers.handleEvent(otherEvent);
  await tiers.handleEvent(otherEvent);
  const lookups = stripe.priceCalls.length;
  assert.equal(lookups, 1 + Object.keys(priceToTier).length, "one failed attempt, then one lookup per mapped price");
  // Events on our own mapped prices never need the lookup.
  await tiers.handleEvent(subEvent("customer.subscription.updated", { customer: "c1", status: "active", price: "price_solo_m" }));
  assert.equal(stripe.priceCalls.length, lookups);
  assert.equal(db.row("u1").tier, "solo");
});

test("27. the webhook clears the cache, so a cached paid tier cannot heal a cancellation back", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "solo", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  assert.equal(await tiers.tierForUser("u1"), "solo"); // caches solo for c1
  stripe.data.subscriptions[0].status = "canceled";
  await tiers.handleEvent(subEvent("customer.subscription.deleted", { customer: "c1", status: "canceled", price: "price_solo_m" }));
  assert.equal(db.row("u1").tier, "free");
  assert.equal(await tiers.tierForUser("u1"), "free");
  assert.equal(db.row("u1").tier, "free");
});

test("28. with reconcileWrites false, reconcile reports what it would change and writes nothing", async () => {
  const { db, tiers } = setup({
    reconcileWrites: false,
    profiles: [profile("u1", "free", "c1"), profile("u2", "free"), profile("u3", "team", "c3")],
    subscriptions: [
      sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" }),
      sub({ id: "sub_2", customer: "c2", status: "active", price: "price_solo_m", metadata: { supabase_user_id: "u2" } }),
      sub({ id: "sub_3", customer: "c3", status: "canceled", price: "price_team_m" }),
    ],
  });
  const before = db.snapshot();
  const changes = await tiers.reconcile();
  assert.deepEqual(changes, [
    { user: "u1", customer: "c1", from: "free", to: "solo", dryRun: true },
    { user: "u2", customer: "c2", from: "unlinked", to: "solo", dryRun: true },
    { user: "u3", customer: "c3", from: "team", to: "free", dryRun: true },
  ]);
  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.snapshot(), before);
});

test("29. reconcile re-reads Stripe before writing, so a change during the sweep wins", async () => {
  const { stripe, db, tiers } = setup({
    profiles: [profile("u1", "free", "c1")],
    subscriptions: [sub({ id: "sub_1", customer: "c1", status: "active", price: "price_solo_m" })],
  });
  // The sweep sees an active solo; the customer cancels before the per-customer re-read.
  stripe.hooks.beforeList = (params, data) => { if (params.customer === "c1") data.subscriptions[0].status = "canceled"; };
  assert.deepEqual(await tiers.reconcile(), []);
  assert.equal(db.row("u1").tier, "free");
  assert.equal(db.writes.length, 0);
});
