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
  res.set("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
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
      // Set BOTH the customer link and the tier here, keyed by our user id
      // (client_reference_id). Doing the tier in this event avoids a race where
      // the subscription event arrives before the customer has been linked,
      // which would leave a paying user stuck on "free".
      if (s.client_reference_id) {
        let tier = "free";
        try {
          if (s.subscription) {
            const sub = await stripe.subscriptions.retrieve(s.subscription);
            tier = PRICE_TO_TIER[sub.items.data[0].price.id] || "free";
          }
        } catch (e) { console.error("subscription retrieve failed", e); }
        await supabase.from("profiles").update({
          stripe_customer_id: s.customer || null,
          tier,
          updated_at: new Date().toISOString(),
        }).eq("id", s.client_reference_id);
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

  const { data: profile } = await supabase.from("profiles").select("stripe_customer_id, tier").eq("id", user.id).single();

  // Already on a paid plan: never open a second checkout (it would create a
  // duplicate subscription and double-charge). Send them to the billing portal
  // to change or cancel the existing subscription instead.
  if ((profile?.tier === "solo" || profile?.tier === "team") && profile?.stripe_customer_id) {
    const portal = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.APP_URL}/`,
    });
    return res.json({ url: portal.url, portal: true });
  }

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

/* ============================ CLOUD PROJECTS ============================ */
// Cross-device project storage. The client saves here when signed in; the
// resume list and "open" pull from here. All queries are scoped by owner.

app.get("/projects", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data, error } = await supabase.from("projects")
    .select("source_key, source_url, title, thumb, caption_count, updated_at")
    .eq("owner", user.id).order("updated_at", { ascending: false }).limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: (data || []).map((p) => ({
    key: p.source_key, url: p.source_url, title: p.title, th: p.thumb || "",
    count: p.caption_count || 0, ts: new Date(p.updated_at).getTime(),
  })) });
});

app.get("/projects/:key", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data, error } = await supabase.from("projects")
    .select("data").eq("owner", user.id).eq("source_key", req.params.key).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ data: data.data });
});

app.post("/projects", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { source_key, source_url, title, data } = req.body || {};
  if (!source_key || !data) return res.status(400).json({ error: "source_key and data required" });
  const row = {
    owner: user.id, source_key, source_url: source_url || null, title: title || null,
    thumb: (data.th || "").slice(0, 200000) || null,
    caption_count: Array.isArray(data.c) ? data.c.length : 0,
    data, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("projects").upsert(row, { onConflict: "owner,source_key" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/projects/:key", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { error } = await supabase.from("projects").delete().eq("owner", user.id).eq("source_key", req.params.key);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ===================== TRANSLATOR HANDOFF (share links) ===================== */
// Owner mints a scoped token for ONE project; a translator opens it with no
// account and edits translations. The token is the credential (no user auth).

function randToken() { return [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

app.post("/projects/:key/share", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  const { data: proj, error: e1 } = await supabase.from("projects")
    .select("id").eq("owner", user.id).eq("source_key", req.params.key).maybeSingle();
  if (e1) return res.status(500).json({ error: e1.message });
  if (!proj) return res.status(404).json({ error: "Save the project before sharing it." });
  const token = randToken();
  const { error } = await supabase.from("share_links").insert({
    token, project_id: proj.id, can_edit: req.body?.canEdit !== false, label: req.body?.label || null,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ token });
});

app.get("/share/:token", async (req, res) => {
  const { data: link } = await supabase.from("share_links")
    .select("project_id, can_edit, expires_at").eq("token", req.params.token).maybeSingle();
  if (!link) return res.status(404).json({ error: "This share link is invalid or was revoked." });
  if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: "This share link has expired." });
  const { data: proj } = await supabase.from("projects").select("title, source_url, data").eq("id", link.project_id).maybeSingle();
  if (!proj) return res.status(404).json({ error: "The shared project no longer exists." });
  res.json({ title: proj.title, source_url: proj.source_url, data: proj.data, canEdit: link.can_edit });
});

app.put("/share/:token", async (req, res) => {
  const { data: link } = await supabase.from("share_links").select("project_id, can_edit, expires_at").eq("token", req.params.token).maybeSingle();
  if (!link) return res.status(404).json({ error: "Invalid share link" });
  if (!link.can_edit) return res.status(403).json({ error: "This link is view-only" });
  if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: "Link expired" });
  const data = req.body?.data;
  if (!data) return res.status(400).json({ error: "data required" });
  const { error } = await supabase.from("projects").update({
    data, caption_count: Array.isArray(data.c) ? data.c.length : 0, updated_at: new Date().toISOString(),
  }).eq("id", link.project_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log(`billing service on :${PORT}`));
