/**
 * SubCaptions front-end auth + billing glue.
 *
 * Loads on the app pages (index.html, pricing.html). Handles Supabase email
 * sign-in, exposes the user's tier, and wires the pricing buttons to Stripe
 * Checkout via the billing service. Until the three constants below are filled
 * in, it stays inert (everyone is treated as free; the ?pro=1 dev override on
 * the editor still works). Supabase is loaded lazily, so an unconfigured site
 * makes no network calls here.
 *
 * Fill these in after you create the Supabase project and deploy billing/:
 */
const CONFIG = {
  SUPABASE_URL: "https://knuprwhbesymksfcaqav.supabase.co",        // 
  SUPABASE_ANON_KEY: "sb_publishable_XY_o9FB8t6SLX5GF0Cb6yg_Ow-7EPrg",   // 
  BILLING_BASE: "https://subcaptions.onrender.com",        // 
};

const enabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const billing = (p) => CONFIG.BILLING_BASE.replace(/\/$/, "") + p;
const state = { user: null, tier: "free", token: null };
let sb = null;

async function client() {
  if (sb || !enabled) return sb;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return sb;
}

async function refresh() {
  if (!enabled) { broadcast(); return; }
  const c = await client();
  const { data: { session } } = await c.auth.getSession();
  state.user = session?.user || null;
  state.token = session?.access_token || null;
  state.tier = "free";
  if (state.user && CONFIG.BILLING_BASE) {
    try {
      const r = await fetch(billing("/billing/me"), { headers: { Authorization: "Bearer " + state.token } });
      if (r.ok) state.tier = (await r.json()).tier || "free";
    } catch (e) {}
  }
  broadcast();
}
function broadcast() {
  document.dispatchEvent(new CustomEvent("subauth", { detail: { user: state.user, tier: state.tier, token: state.token } }));
  const el = document.getElementById("account-link");
  if (el) el.textContent = state.user
    ? (state.tier === "free" ? "Account" : state.tier[0].toUpperCase() + state.tier.slice(1) + " · Account")
    : "Sign in";
}

async function signIn(email) {
  if (!enabled) { alert("Accounts aren't configured yet."); return; }
  if (!email) return;
  const c = await client();
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  alert(error ? error.message : "Check your email for a sign-in link.");
}
async function signOut() { if (enabled) { (await client()).auth.signOut(); refresh(); } }

async function checkout(plan) {
  if (!enabled) { alert("Checkout isn't configured yet."); return; }
  if (!state.user) { signIn(prompt("Enter your email to sign in, then click again:")); return; }
  try {
    const r = await fetch(billing("/billing/checkout"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ plan }),
    });
    const d = await r.json();
    if (d.url) location.href = d.url; else alert(d.error || "Checkout failed");
  } catch (e) { alert("Checkout failed"); }
}
async function portal() {
  if (!state.user) { signIn(prompt("Enter your email to sign in:")); return; }
  try {
    const r = await fetch(billing("/billing/portal"), { method: "POST", headers: { Authorization: "Bearer " + state.token } });
    const d = await r.json();
    if (d.url) location.href = d.url; else alert(d.error || "No subscription yet");
  } catch (e) { alert("Could not open the billing portal"); }
}

window.SubAuth = {
  get user() { return state.user; },
  get tier() { return state.tier; },
  get token() { return state.token; },
  signIn, signOut, checkout, portal, refresh,
};

// Delegate clicks: [data-plan] -> checkout, [data-account] -> portal/sign-in.
document.addEventListener("click", (e) => {
  const plan = e.target.closest("[data-plan]");
  if (plan) { e.preventDefault(); checkout(plan.dataset.plan); return; }
  const acct = e.target.closest("[data-account]");
  if (acct) { e.preventDefault(); state.user ? portal() : signIn(prompt("Enter your email to sign in:")); }
});

refresh();
