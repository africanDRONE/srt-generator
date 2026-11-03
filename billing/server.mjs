/**
 * SubCaptions billing service.
 *
 * Connects Stripe subscriptions to Supabase user tiers. Three jobs:
 *   POST /billing/checkout { plan }   -> Stripe Checkout URL (auth required)
 *   POST /billing/portal              -> Stripe Customer Portal URL (auth required)
 *   POST /billing/webhook             -> Stripe -> here; this is what sets the tier
 *   POST /billing/confirm { session_id } -> links a finished checkout at once (auth required)
 *   GET  /billing/me                  -> { tier } for the signed-in user
 *
 * Auth: the browser sends the user's Supabase access token as `Authorization:
 * Bearer <token>`. We validate it with the Supabase admin client.
 *
 * Env:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   APP_URL                       (e.g. https://subcaptions.com, for redirects)
 *   ALLOWED_ORIGIN                (default *; set to your domain)
 *   PRICE_SOLO_MONTHLY, PRICE_SOLO_YEARLY, PRICE_TEAM_MONTHLY, PRICE_TEAM_YEARLY
 *   RECONCILE_WRITE               ("true" lets the 6-hourly reconcile fix tiers; anything
 *                                 else only logs what it would change)
 */
import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { makeTiers } from "./tiers.mjs";
import { makeProjects, jsonBodyParser } from "./projects.mjs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PLAN_TO_PRICE = {
  solo_monthly: process.env.PRICE_SOLO_MONTHLY,
  solo_yearly: process.env.PRICE_SOLO_YEARLY,
  team_monthly: process.env.PRICE_TEAM_MONTHLY,
  team_yearly: process.env.PRICE_TEAM_YEARLY,
};
// Built only from the PRICE_* vars that are set: an unset var used to add a key
// "undefined" to this map.
const PRICE_ENV_TIERS = { PRICE_SOLO_MONTHLY: "solo", PRICE_SOLO_YEARLY: "solo", PRICE_TEAM_MONTHLY: "team", PRICE_TEAM_YEARLY: "team" };
const PRICE_TO_TIER = {};
const missingPrices = [];
for (const [name, tier] of Object.entries(PRICE_ENV_TIERS)) {
  if (process.env[name]) PRICE_TO_TIER[process.env[name]] = tier;
  else missingPrices.push(name);
}
// Loud but not fatal. A paid subscription on an unmapped price makes tier checks throw
// (webhook 500, Stripe retries, nobody is downgraded), and checkout for that plan
// answers "Unknown plan", so the rest of the service keeps working.
if (missingPrices.length) {
  console.error(`BILLING CONFIG ERROR: ${missingPrices.join(", ")} not set. Subscriptions on those prices cannot be mapped to a tier until it is fixed.`);
}

// Shown by /healthz so a deploy can be checked against what is live.
const BUILD = "2026-11-03-billing-projects";

const RECONCILE_WRITE = process.env.RECONCILE_WRITE === "true";
const tiers = makeTiers({ stripe, supabase, priceToTier: PRICE_TO_TIER, reconcileWrites: RECONCILE_WRITE });

// Express 4 does not catch a rejected promise from an async handler: the request hangs
// and the process can crash. Every async route goes through route(), so a failed
// Stripe or Supabase call reaches the error handler at the bottom instead.
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const app = express();
// ALLOWED_ORIGIN can be "*" or a comma-separated list, e.g.
//   https://subcaptions.com,https://subcaptions.pages.dev
const ORIGINS = (process.env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (ORIGINS.includes("*")) {
    res.set("Access-Control-Allow-Origin", "*");
  } else if (origin && ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Stripe webhook needs the raw body, so it's registered before express.json().
app.post("/billing/webhook", express.raw({ type: "application/json" }), route(async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature error: ${e.message}`);
  }
  // Any failure returns 500 so Stripe retries. Retries are safe because the handler
  // reads the customer's live subscriptions instead of the event's snapshot.
  try { await tiers.handleEvent(event); }
  catch (e) { console.error("webhook handling error", event.type, event.id, e); return res.status(500).send("handler error"); }
  res.json({ received: true });
}));

// JSON bodies: 2 MB for POST /projects and PUT /share/:token, which carry a whole
// project, and the 100 KB default everywhere else (see jsonBodyParser in projects.mjs).
app.use(jsonBodyParser());

// Validate the Supabase access token and return the user, or null.
async function getUser(req) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

app.get("/billing/me", route(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  // A failed lookup is an error, never "free": answering "free" on a database hiccup
  // told paying users they had lost their plan.
  try { res.json({ tier: await tiers.tierForUser(user.id) }); }
  catch (e) { console.error("billing/me failed", e); res.status(503).json({ error: "Could not load your plan. Please try again." }); }
}));

app.post("/billing/checkout", route(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const price = PLAN_TO_PRICE[req.body?.plan];
  if (!price) return res.status(400).json({ error: "Unknown plan" });

  // Decided from the self-healed live tier (tiers.checkoutPlan). Any read error is a
  // 503: a failed profile read used to fall through to customer_email below, creating
  // a second Stripe customer and a second subscription for someone already paying.
  let plan;
  try { plan = await tiers.checkoutPlan(user.id); }
  catch (e) { console.error("billing/checkout plan check failed", e); return res.status(503).json({ error: "Could not load your plan. Please try again." }); }

  // Already on a paid plan: never open a second checkout (it would create a
  // duplicate subscription and double-charge). Send them to the billing portal
  // to change or cancel the existing subscription instead.
  if (plan.portal) {
    const portal = await stripe.billingPortal.sessions.create({
      customer: plan.customer,
      return_url: `${process.env.APP_URL}/`,
    });
    return res.json({ url: portal.url, portal: true });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    // Lets the webhook and reconcile() find this user even if checkout.session.completed is lost.
    subscription_data: { metadata: { supabase_user_id: user.id } },
    ...(plan.customer ? { customer: plan.customer } : { customer_email: user.email }),
    allow_promotion_codes: true,
    // Don't force a card when nothing is due now and never will be (e.g. a 100%-off
    // forever promo code for a friend/influencer). Paying customers still get the card
    // prompt because their amount due is > 0.
    payment_method_collection: "if_required",
    // session_id lets the page call /billing/confirm on return, so the plan shows up
    // even when the webhook is late or failed during a cold start.
    success_url: `${process.env.APP_URL}/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/pricing`,
  });
  res.json({ url: session.url });
}));

// Called by the page when Stripe sends the user back from checkout. Links the payment
// to the account straight away instead of waiting for the webhook. Safe to repeat.
app.post("/billing/confirm", route(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const id = String(req.body?.session_id || "");
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: "Bad checkout session id" });
  let session;
  try { session = await stripe.checkout.sessions.retrieve(id); }
  catch (e) {
    if (e?.statusCode === 404) return res.status(404).json({ error: "Checkout session not found" });
    throw e;
  }
  // Only the account that started the checkout can claim it.
  if (session.client_reference_id !== user.id) return res.status(403).json({ error: "This checkout belongs to another account" });
  if (session.mode !== "subscription") return res.status(400).json({ error: "Not a subscription checkout" });
  if (session.status !== "complete") return res.status(409).json({ error: "Checkout is not complete yet" });
  const tier = await tiers.linkCheckout(session);
  res.json({ tier: tier || (await tiers.tierForUser(user.id)) });
}));

app.post("/billing/portal", route(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data: profile, error } = await supabase.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
  if (error) { console.error("billing/portal profile read failed", error); return res.status(503).json({ error: "Could not load your plan. Please try again." }); }
  if (!profile?.stripe_customer_id) return res.status(400).json({ error: "No subscription yet" });
  const portal = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.APP_URL}/`,
  });
  res.json({ url: portal.url });
}));

/* ============================ CLOUD PROJECTS ============================ */
// Cross-device project storage. The client saves here when signed in; the
// resume list and "open" pull from here. All queries are scoped by owner. The rules
// (validation, the 500-project quota, the per-account storage cap, base_updated_at
// conflicts) live in projects.mjs.

// tierForUser is the same self-healing check /billing/me answers with, so a user the
// page shows as Team can mint a share link, and a paying user gets the larger storage cap.
const projects = makeProjects({ supabase, tierForUser: tiers.tierForUser });

// Signed-in routes: 401 without a valid token, otherwise send what projects.mjs returns.
const asOwner = (fn) => route(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const out = await fn(user.id, req);
  res.status(out.status).json(out.body);
});

app.get("/projects", asOwner((owner) => projects.list(owner)));
app.get("/projects/:key", asOwner((owner, req) => projects.get(owner, req.params.key)));
app.post("/projects", asOwner((owner, req) => projects.save(owner, req.body)));
app.delete("/projects/:key", asOwner((owner, req) => projects.remove(owner, req.params.key)));

/* ===================== TRANSLATOR HANDOFF (share links) ===================== */
// Owner mints a scoped token for ONE project; a translator opens it with no
// account and edits translations. The token is the credential (no user auth).
// Links expire 30 days after minting; the owner can list and revoke them.

app.post("/projects/:key/share", asOwner((owner, req) => projects.mintShare(owner, req.params.key, req.body)));
app.get("/projects/:key/shares", asOwner((owner, req) => projects.listShares(owner, req.params.key)));
app.delete("/projects/:key/share/:token", asOwner((owner, req) => projects.revokeShare(owner, req.params.key, req.params.token)));

app.get("/share/:token", route(async (req, res) => {
  const out = await projects.openShare(req.params.token);
  res.status(out.status).json(out.body);
}));

app.put("/share/:token", route(async (req, res) => {
  const out = await projects.saveShare(req.params.token, req.body);
  res.status(out.status).json(out.body);
}));

// Cheap endpoint for uptime checks and keep-warm pings.
app.get("/healthz", (req, res) => res.json({ ok: true, build: BUILD }));

// Errors from route() handlers and from express.json(). Body-parser errors carry their
// own 4xx status (bad JSON, body too large); anything else is ours, so the browser gets
// a plain "try again" and the log gets the details.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status >= 400 && err?.status < 500 ? err.status : 503;
  if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err?.stack || err);
  res.status(status).json({ error: status >= 500 ? "Something went wrong on our side. Please try again." : err.message });
});

// Sweep Stripe against Supabase on every start (a cold start is exactly when webhook
// deliveries are most likely to have failed) and every 6 hours while running.
async function runReconcile() {
  try {
    const changes = await tiers.reconcile();
    const failed = changes.filter((c) => c.error);
    const fixed = changes.filter((c) => !c.error);
    if (failed.length) console.error("reconcile: rows skipped on error", JSON.stringify(failed));
    if (fixed.length) {
      console.warn(RECONCILE_WRITE ? "TIER DRIFT reconciled" : "TIER DRIFT found, not changed (report only; set RECONCILE_WRITE=true to apply)", JSON.stringify(fixed));
    }
    if (!changes.length) console.log("reconcile: no drift");
  } catch (e) { console.error("reconcile failed", e); }
}
setTimeout(runReconcile, 5000);
setInterval(runReconcile, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log(`billing service on :${PORT}`));
