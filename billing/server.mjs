/**
 * SubCaptions billing service.
 *
 * Connects Stripe subscriptions to Supabase user tiers. Three jobs:
 *   POST /billing/checkout { plan }   -> Stripe Checkout URL (auth required)
 *   POST /billing/portal              -> Stripe Customer Portal URL (auth required)
 *   POST /billing/webhook             -> Stripe -> here; this is what sets the tier
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
 */
import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

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
const PRICE_TO_TIER = {
  [process.env.PRICE_SOLO_MONTHLY]: "solo",
  [process.env.PRICE_SOLO_YEARLY]: "solo",
  [process.env.PRICE_TEAM_MONTHLY]: "team",
  [process.env.PRICE_TEAM_YEARLY]: "team",
};

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
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Stripe webhook needs the raw body, so it's registered before express.json().
app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature error: ${e.message}`);
  }
  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      // Link the Stripe customer to our user (set at checkout via client_reference_id).
      if (s.client_reference_id && s.customer) {
        await supabase.from("profiles").update({ stripe_customer_id: s.customer, updated_at: new Date().toISOString() }).eq("id", s.client_reference_id);
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const sub = event.data.object;
      const active = sub.status === "active" || sub.status === "trialing";
      const tier = active ? (PRICE_TO_TIER[sub.items.data[0].price.id] || "free") : "free";
      await supabase.from("profiles").update({ tier, updated_at: new Date().toISOString() }).eq("stripe_customer_id", sub.customer);
    }
  } catch (e) {
    console.error("webhook handling error", e);
    return res.status(500).send("handler error");
  }
  res.json({ received: true });
});

app.use(express.json());

// Validate the Supabase access token and return the user, or null.
async function getUser(req) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

app.get("/billing/me", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data } = await supabase.from("profiles").select("tier").eq("id", user.id).single();
  res.json({ tier: data?.tier || "free" });
});

app.post("/billing/checkout", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const price = PLAN_TO_PRICE[req.body?.plan];
  if (!price) return res.status(400).json({ error: "Unknown plan" });

  // Reuse the user's Stripe customer if we have one, else let Checkout create it.
  const { data: profile } = await supabase.from("profiles").select("stripe_customer_id").eq("id", user.id).single();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    ...(profile?.stripe_customer_id ? { customer: profile.stripe_customer_id } : { customer_email: user.email }),
    allow_promotion_codes: true,
    success_url: `${process.env.APP_URL}/?upgraded=1`,
    cancel_url: `${process.env.APP_URL}/pricing.html`,
  });
  res.json({ url: session.url });
});

app.post("/billing/portal", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data: profile } = await supabase.from("profiles").select("stripe_customer_id").eq("id", user.id).single();
  if (!profile?.stripe_customer_id) return res.status(400).json({ error: "No subscription yet" });
  const portal = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.APP_URL}/`,
  });
  res.json({ url: portal.url });
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log(`billing service on :${PORT}`));
