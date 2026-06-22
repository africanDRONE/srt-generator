# Wiring up Stripe (Solo $5 / Team $18)

## The one prerequisite
Stripe can take the money on day one, but to *gate features* it has to tie a
subscription to a specific user. The app has no accounts yet (entitlement is a
client-side `IS_PRO` flag). So you need one of two bridges between "Stripe says
they paid" and "this browser gets Pro." Two paths, fastest first.

Either way, one rule is non-negotiable: **the features that cost money (translation
Worker, Whisper auto-caption, burn-in) must check entitlement server-side.** The
client `IS_PRO` flag is only for showing/hiding UI. Never trust it for billing.

---

## Path A: License key (fastest, no accounts) — good for launch
No login. The user pays, gets a key, pastes it once.

1. **Stripe Dashboard → Products.** Create products and recurring Prices:
   - Solo: $5/mo and $48/yr. Team: $18/mo and $180/yr. Copy the four `price_...` IDs.
2. **Payment Links.** For each price, create a Stripe Payment Link (no code). Set its post-payment redirect to `https://subcaptions.com/activate?session_id={CHECKOUT_SESSION_ID}`. Point the pricing page buttons (`Go Solo` / `Go Team`) at these links.
3. **Webhook + key issuing.** Add a small backend (you already run `transcribe-server`; put it there or in a Cloudflare Worker). On the `checkout.session.completed` event, generate a random key, store `{ key -> {tier, stripe_customer_id, status} }` in a KV store (Cloudflare KV or a Supabase table), and keep it keyed by the `session_id` too.
4. **/activate page.** Reads `session_id`, calls your backend to fetch the key for that session, shows it to the user, and stores it in `localStorage` (`subcap_license`).
5. **Gating.** The editor sets `IS_PRO` from the presence of a key. The translation Worker and transcribe-server require the key in an `Authorization` header and look it up in KV (reject if missing/inactive).
6. **Cancellations.** Handle `customer.subscription.deleted` / `...updated` to flip the key's `status` to inactive, so the Workers stop honoring it.

Tradeoff: simple, but no self-serve "manage my subscription," and a key on one device. Fine to launch and validate, then graduate to Path B.

---

## Path B: Accounts + Stripe Checkout + Customer Portal (the real thing)
This is also what the translator handoff needs (see `handoff-architecture.md`), so do it when you build accounts. Recommended store: **Supabase** (Postgres + Auth).

### 1. Stripe Dashboard
- Create the same four Prices. Note the IDs.
- Turn on the **Customer Portal** (Settings → Billing → Customer portal) so users can cancel/upgrade themselves.

### 2. Three backend endpoints (Stripe Node SDK: `npm i stripe`)

**Create a checkout session** (called when they click Go Solo/Team):
```js
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  line_items: [{ price: priceId, quantity: 1 }],   // the chosen plan's price_...
  customer_email: user.email,                       // or customer: user.stripeCustomerId
  client_reference_id: user.id,                     // ties the payment back to your user
  allow_promotion_codes: true,
  success_url: "https://subcaptions.com/account?upgraded=1",
  cancel_url: "https://subcaptions.com/pricing.html",
});
return session.url;   // redirect the browser here
```

**Webhook** (Stripe -> you; this is what actually sets the tier). Use the raw body:
```js
const event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
const tierForPrice = { [SOLO_M]: "solo", [SOLO_Y]: "solo", [TEAM_M]: "team", [TEAM_Y]: "team" };

switch (event.type) {
  case "checkout.session.completed": {
    const s = event.data.object;
    await db.setUser(s.client_reference_id, { stripe_customer_id: s.customer });
    break; // subscription.* (below) sets the tier
  }
  case "customer.subscription.created":
  case "customer.subscription.updated":
  case "customer.subscription.deleted": {
    const sub = event.data.object;
    const active = sub.status === "active" || sub.status === "trialing";
    const tier = active ? tierForPrice[sub.items.data[0].price.id] : "free";
    await db.setTierByCustomer(sub.customer, tier);
    break;
  }
}
return new Response("ok", { status: 200 });
```

**Customer portal** (the "Manage subscription" button):
```js
const portal = await stripe.billingPortal.sessions.create({
  customer: user.stripeCustomerId,
  return_url: "https://subcaptions.com/account",
});
return portal.url;
```

### 3. Entitlement, enforced server-side
- Store `tier` on the user row in Supabase.
- The browser sends the user's Supabase access token (JWT) with each paid request.
- **Translation Worker** and **transcribe-server** verify that JWT (Supabase signs with a secret you hold) and read `tier`. If the feature isn't allowed for that tier, return `402`. The front end maps `tier` to `IS_PRO` only for UI.

Example guard in the Worker / transcribe-server:
```js
const tier = await verifyAndGetTier(req.headers.get("authorization")); // throws on bad token
if (feature === "autocaption" && tier === "free") return json({ error: "Pro required" }, 402);
```

---

## Env vars (both paths)
```
STRIPE_SECRET_KEY=sk_live_...        # sk_test_... while developing
STRIPE_WEBHOOK_SECRET=whsec_...      # from the webhook endpoint you register
PRICE_SOLO_MONTHLY=price_...
PRICE_SOLO_YEARLY=price_...
PRICE_TEAM_MONTHLY=price_...
PRICE_TEAM_YEARLY=price_...
```

## Test then go live
1. Use **test mode** keys and Stripe's test card `4242 4242 4242 4242` end to end.
2. Register the webhook endpoint in the Dashboard (or `stripe listen --forward-to localhost:.../stripe-webhook` locally) and confirm tier flips on subscribe and cancel.
3. Flip to live keys, re-create the Prices/Payment Links in live mode (test and live are separate), and register the live webhook.

## What to change in this repo when you build it
- Pricing page buttons (`Go Solo` / `Go Team`, currently `href="/"`) point to checkout (Path A: the Payment Link; Path B: your `/create-checkout-session`).
- `index.html`: derive `IS_PRO` from the stored license key (Path A) or the signed-in user's tier (Path B), instead of the `?pro=1` placeholder.
- `worker/translate.js` and `transcribe-server/server.mjs`: replace the placeholder `PRO_TOKEN` check with real tier verification.
