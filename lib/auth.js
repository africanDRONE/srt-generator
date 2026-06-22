/**
 * SubCaptions front-end auth + billing glue.
 *
 * Shows a branded sign-in modal (Google first, email magic-link as fallback),
 * exposes the user's tier, and wires the pricing buttons to Stripe Checkout via
 * the billing service. Supabase loads lazily.
 */
const CONFIG = {
  SUPABASE_URL: "https://knuprwhbesymksfcaqav.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_XY_o9FB8t6SLX5GF0Cb6yg_Ow-7EPrg", // publishable (browser-safe) key only
  BILLING_BASE: "https://subcaptions.onrender.com",
};

const enabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const billing = (p) => CONFIG.BILLING_BASE.replace(/\/$/, "") + p;
const state = { user: null, tier: "free", token: null };
let sb = null;

async function client() {
  if (sb || !enabled) return sb;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      storage: window.localStorage,   // force on-disk storage, not in-memory (which dies on navigation)
      storageKey: "subcaptions-auth", // fixed key so every page reads the same session
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  // Keep the nav in sync when the user signs in or out without a full reload.
  sb.auth.onAuthStateChange(() => refresh());
  return sb;
}

async function refresh() {
  if (!enabled) { broadcast(); return; }
  const c = await client();
  const { data: { session } } = await c.auth.getSession();
  state.user = session?.user || null;
  state.token = session?.access_token || null;
  if (!state.user) state.tier = "free";
  broadcast(); // reflect signed-in/out state right away, before the slower tier lookup
  if (state.user) {
    try {
      const r = await fetch(billing("/billing/me"), { headers: { Authorization: "Bearer " + state.token } });
      if (r.ok) { state.tier = (await r.json()).tier || "free"; broadcast(); }
    } catch (e) {}
  }
  if (document.getElementById("sc-overlay")?.classList.contains("open")) renderModal();
}
function broadcast() {
  document.dispatchEvent(new CustomEvent("subauth", { detail: { user: state.user, tier: state.tier, token: state.token } }));
  const el = document.getElementById("account-link");
  if (state.user) {
    const meta = state.user.user_metadata || {};
    const full = meta.full_name || meta.name || (state.user.email || "Account").split("@")[0];
    const name = String(full).trim().split(/\s+/)[0] || "Account";
    try { localStorage.setItem("sc_nav", JSON.stringify({ name, tier: state.tier })); } catch (e) {}
    if (el) { el.textContent = name; el.title = state.tier[0].toUpperCase() + state.tier.slice(1) + " plan"; }
  } else {
    try { localStorage.removeItem("sc_nav"); } catch (e) {}
    if (el) { el.textContent = "Sign in"; el.removeAttribute("title"); }
  }
}

/* ---------- branded modal ---------- */
const GOOGLE_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

function ensureModal() {
  if (document.getElementById("sc-overlay")) return;
  const style = document.createElement("style");
  style.textContent = `
    .sc-overlay{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(20,20,40,.5);backdrop-filter:blur(4px);font-family:-apple-system,"Segoe UI",system-ui,sans-serif}
    .sc-overlay.open{display:flex}
    .sc-modal{background:#fff;width:min(380px,92vw);border-radius:18px;padding:30px 26px 26px;box-shadow:0 30px 70px rgba(20,20,40,.35);position:relative;text-align:center}
    .sc-close{position:absolute;top:12px;right:14px;border:none;background:none;font-size:24px;line-height:1;color:#9a9fb0;cursor:pointer}
    .sc-close:hover{color:#444}
    .sc-logo{width:46px;height:46px;border-radius:13px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:24px;background:linear-gradient(135deg,#6366f1,#a855f7 55%,#ec4899);box-shadow:0 8px 20px rgba(124,58,237,.3)}
    .sc-modal h3{font-size:20px;margin:0 0 4px;color:#161731;font-weight:700}
    .sc-sub{font-size:13.5px;color:#7d8099;margin:0 0 20px}
    .sc-google{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;border:1px solid #dadce0;border-radius:11px;padding:12px;font-size:15px;font-weight:600;color:#3c4043;cursor:pointer;font-family:inherit}
    .sc-google:hover{background:#f7f8fa;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .sc-or{display:flex;align-items:center;gap:10px;color:#9a9fb0;font-size:12px;margin:16px 0}
    .sc-or::before,.sc-or::after{content:"";flex:1;height:1px;background:#e7e8f3}
    .sc-input{width:100%;border:1px solid #d8dae9;border-radius:11px;padding:12px 14px;font-size:15px;outline:none;font-family:inherit;color:#161731}
    .sc-input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12)}
    .sc-grad{width:100%;margin-top:10px;background:linear-gradient(135deg,#6366f1,#a855f7 55%,#ec4899);color:#fff;border:none;border-radius:11px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
    .sc-grad:hover{filter:brightness(1.05)}
    .sc-ghost{width:100%;margin-top:10px;background:#f3f4fb;border:1px solid #e7e8f3;border-radius:11px;padding:11px;font-size:14px;font-weight:600;color:#41435f;cursor:pointer;font-family:inherit}
    .sc-ghost:hover{background:#eceef7}
    .sc-tier{display:inline-block;margin:0 0 16px;font-size:12.5px;font-weight:700;color:#a855f7;background:rgba(168,85,247,.1);padding:5px 12px;border-radius:999px;text-transform:capitalize}
    .sc-note{font-size:12px;color:#7d8099;margin-top:14px}
  `;
  document.head.appendChild(style);
  const o = document.createElement("div");
  o.className = "sc-overlay"; o.id = "sc-overlay";
  o.innerHTML = `<div class="sc-modal"><button class="sc-close" id="sc-close" aria-label="Close">&times;</button><div class="sc-logo"><img src="/assets/logo.svg" width="46" height="46" alt="" style="display:block;border-radius:13px" /></div><div id="sc-body"></div></div>`;
  document.body.appendChild(o);
  o.addEventListener("click", (e) => { if (e.target === o) closeModal(); });
  document.getElementById("sc-close").addEventListener("click", closeModal);
}
function openModal() { ensureModal(); document.getElementById("sc-overlay").classList.add("open"); renderModal(); }
function closeModal() { document.getElementById("sc-overlay")?.classList.remove("open"); }

function renderModal() {
  const body = document.getElementById("sc-body");
  if (!body) return;
  if (state.user) {
    const paid = state.tier === "solo" || state.tier === "team";
    const action = paid
      ? `<button class="sc-grad" id="sc-portal">Manage subscription</button>`
      : `<a class="sc-grad" id="sc-upgrade" href="/pricing.html" style="display:block;text-decoration:none;box-sizing:border-box">Upgrade plan</a>`;
    body.innerHTML = `
      <h3>Your account</h3>
      <p class="sc-sub">Signed in as <b>${state.user.email || "your account"}</b></p>
      <div class="sc-tier">${state.tier} plan</div>
      ${action}
      <button class="sc-ghost" id="sc-signout">Sign out</button>`;
    if (paid) document.getElementById("sc-portal").addEventListener("click", () => { closeModal(); portal(); });
    else document.getElementById("sc-upgrade").addEventListener("click", () => closeModal());
    document.getElementById("sc-signout").addEventListener("click", () => { closeModal(); signOut(); });
  } else {
    body.innerHTML = `
      <h3>Sign in to SubCaptions</h3>
      <p class="sc-sub">Save your work and unlock Pro features.</p>
      <button class="sc-google" id="sc-google">${GOOGLE_SVG} Continue with Google</button>
      <div class="sc-or"><span>or</span></div>
      <input class="sc-input" type="email" id="sc-email" placeholder="you@email.com" autocomplete="email" />
      <button class="sc-grad" id="sc-email-btn">Email me a sign-in link</button>
      <p class="sc-note">No passwords. We never store your videos.</p>`;
    document.getElementById("sc-google").addEventListener("click", signInWithGoogle);
    document.getElementById("sc-email-btn").addEventListener("click", emailLink);
    document.getElementById("sc-email").addEventListener("keydown", (e) => { if (e.key === "Enter") emailLink(); });
  }
}

/* ---------- auth actions ---------- */
async function signInWithGoogle() {
  if (!enabled) { alert("Sign-in isn't configured yet."); return; }
  const c = await client();
  const { error } = await c.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
  if (error) alert(error.message);
}
async function emailLink() {
  const email = document.getElementById("sc-email")?.value.trim();
  if (!email) return;
  const c = await client();
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  const body = document.getElementById("sc-body");
  if (error) { alert(error.message); return; }
  if (body) body.innerHTML = `<h3>Check your email</h3><p class="sc-sub">We sent a sign-in link to <b>${email}</b>. Open it on this device.</p>`;
}
async function signOut() { if (enabled) { (await client()).auth.signOut(); refresh(); } }

async function checkout(plan) {
  if (!enabled) { alert("Checkout isn't configured yet."); return; }
  if (!state.user) { openModal(); return; }
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
  if (!state.user) { openModal(); return; }
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
  signIn: openModal, signOut, checkout, portal, refresh, open: openModal,
};

document.addEventListener("click", (e) => {
  const plan = e.target.closest("[data-plan]");
  if (plan) { e.preventDefault(); checkout(plan.dataset.plan); return; }
  const acct = e.target.closest("[data-account]");
  if (acct) { e.preventDefault(); openModal(); }
});

// Show the remembered account on the nav immediately, so a full page navigation
// doesn't flash "Sign in" while Supabase loads over the network. refresh() then
// reconciles against the real session (and clears this if actually signed out).
(function primeNav() {
  let hint;
  try { hint = JSON.parse(localStorage.getItem("sc_nav") || "null"); } catch (e) {}
  if (!hint || !hint.name) return;
  const apply = () => {
    const el = document.getElementById("account-link");
    if (el) {
      el.textContent = hint.name;
      if (hint.tier) el.title = hint.tier[0].toUpperCase() + hint.tier.slice(1) + " plan";
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
})();

refresh();
