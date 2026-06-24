/**
 * SubCaptions Frame.io connector (Cloudflare Worker).
 *
 * Turns a pasted Frame.io link into a direct, time-limited media URL using the
 * user's own Frame.io account via Adobe IMS OAuth. The browser never sees the
 * client secret; this Worker holds it and the user's tokens (in KV).
 *
 * Flow:
 *   GET /start?return=<url>   -> redirect to Adobe IMS consent
 *   GET /callback?code&state  -> exchange code for tokens, set session cookie, bounce back
 *   GET /resolve?link=<url>   -> { download_url } for the asset (401 if not connected)
 *   GET /health               -> { ok, configured }
 *   POST /disconnect          -> clear the session
 *
 * Required setup (see frameio-worker/README.md):
 *   - KV namespace bound as TOKENS
 *   - secrets: IMS_CLIENT_ID, IMS_CLIENT_SECRET
 *   - vars: ALLOWED_ORIGIN (your site), SELF_ORIGIN (this Worker's URL)
 */

const IMS = "https://ims-na1.adobelogin.com";
const IMS_AUTHORIZE = IMS + "/ims/authorize/v2";
const IMS_TOKEN = IMS + "/ims/token/v3";
const SCOPES = "openid email profile offline_access additional_info.roles";
const FIO_API = "https://api.frame.io/v4";
const COOKIE = "sc_fio";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const _allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
    const _reqOrigin = request.headers.get("Origin") || "";
    const origin = _allowed.includes("*") ? "*" : (_allowed.includes(_reqOrigin) ? _reqOrigin : _allowed[0]);
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const configured = !!(env.IMS_CLIENT_ID && env.IMS_CLIENT_SECRET && env.TOKENS);
    const self = (env.SELF_ORIGIN || url.origin).replace(/\/$/, "");

    try {
      if (url.pathname === "/health") return json({ ok: true, configured }, 200, cors);
      if (!configured) return json({ error: "Frame.io connector is not configured on the server yet." }, 501, cors);

      if (url.pathname === "/reset") {
        const headers = new Headers({ "Content-Type": "text/html" });
        headers.append("Set-Cookie", setCookie(self, "", 0));
        return new Response("<h2>Frame.io connection reset.</h2><p>You can close this tab and reconnect from the app.</p>", { status: 200, headers });
      }
      if (url.pathname === "/status") {
        const session = cookie(request, COOKIE);
        let connected = false;
        if (session) { try { connected = !!(await freshAccessToken(env, session)); } catch { connected = false; } }
        return json({ connected, hasCookie: !!session }, 200, cors);
      }
      if (url.pathname === "/start") return await start(url, env, self);
      if (url.pathname === "/callback") return await callback(url, env, self);
      if (url.pathname === "/resolve") return await resolve(request, url, env, cors);
      if (url.pathname === "/disconnect" && request.method === "POST") return await disconnect(request, env, cors, origin, self);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.message || "Server error" }, 500, cors);
    }
  },
};

// Step 1: bounce the user to Adobe IMS, remembering where to send them back.
async function start(url, env, self) {
  const ret = url.searchParams.get("return") || (env.ALLOWED_ORIGIN || "/").split(",")[0].trim();
  const state = crypto.randomUUID();
  await env.TOKENS.put("state:" + state, ret, { expirationTtl: 600 });
  const a = new URL(IMS_AUTHORIZE);
  a.searchParams.set("client_id", env.IMS_CLIENT_ID);
  a.searchParams.set("redirect_uri", self + "/callback");
  a.searchParams.set("scope", SCOPES);
  a.searchParams.set("response_type", "code");
  a.searchParams.set("state", state);
  // Force the account/login screen instead of silently single-sign-on-ing the
  // currently-logged-in Adobe account, so the user can pick the one tied to Frame.io.
  a.searchParams.set("prompt", "login");
  return Response.redirect(a.toString(), 302);
}

// Step 2: exchange the code for tokens, store them under a fresh session id, set cookie.
async function callback(url, env, self) {
  // Surface Adobe's own error instead of silently flashing past it.
  const adobeErr = url.searchParams.get("error");
  if (adobeErr) {
    const desc = url.searchParams.get("error_description") || "";
    return htmlError("Adobe sign-in error", adobeErr + (desc ? "\n\n" + desc : ""));
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError("Sign-in incomplete", "Adobe didn't return an authorization code. This usually means the redirect URI or scopes on the Adobe credential don't match.");
  const ret = await env.TOKENS.get("state:" + state);
  if (!ret) return htmlError("Session expired", "The sign-in attempt expired or was already used. Start over from the app.");
  await env.TOKENS.delete("state:" + state);

  let tok;
  try {
    tok = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: self + "/callback" });
  } catch (e) {
    return htmlError("Token exchange failed", e.message || "Adobe rejected the token request.");
  }
  const session = crypto.randomUUID();
  await saveTokens(env, session, tok);

  // Set the cookie on a first-party 200 page on THIS worker, then redirect to the app
  // with JS. A Set-Cookie on a 302 that bounces straight to another origin is dropped
  // by both Chrome and Safari, which is why the session never stuck.
  let dest = ret;
  if (!/^https?:\/\//i.test(dest)) dest = (env.ALLOWED_ORIGIN || "/").split(",")[0].trim();
  const html = `<!doctype html><meta charset="utf-8"><title>Connecting…</title>
<meta http-equiv="refresh" content="1;url=${escapeHtml(dest)}">
<body style="font:15px/1.5 system-ui;margin:64px auto;max-width:420px;text-align:center;color:#333">
<p>Frame.io connected. Returning to SubCaptions…</p>
<p style="color:#888;font-size:13px">If this doesn't redirect, <a href="${escapeHtml(dest)}">click here</a>.</p>
<script>location.replace(${JSON.stringify(dest)});</script></body>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append("Set-Cookie", setCookie(self, session, SESSION_TTL));
  return new Response(html, { status: 200, headers });
}

// Step 3: resolve a frame.io link to a direct media URL using the stored token.
async function resolve(request, url, env, cors) {
  const session = cookie(request, COOKIE);
  if (!session) return json({ error: "Not connected" }, 401, cors);
  const access = await freshAccessToken(env, session);
  if (!access) return json({ error: "Not connected" }, 401, cors);

  const debug = url.searchParams.get("debug");
  const link = url.searchParams.get("link") || "";
  let ids = parseFrameioLink(link);
  let expanded = link;
  // Short share links (f.io/XXXX) carry no id; follow the redirect to the full
  // share URL, which contains /view/<file_id>, then parse that.
  if (!ids.fileId) {
    expanded = await expandLink(link);
    if (expanded && expanded !== link) ids = parseFrameioLink(expanded);
  }

  // Frame.io V4 calls are scoped to an account. Use the id from the link if present,
  // else fall back to the user's accounts.
  let accountsRaw = null;
  if (!ids.accountId) {
    accountsRaw = await fioGetRaw(`${FIO_API}/accounts`, access);
    ids.accountId = accountsRaw.body?.data?.[0]?.id || accountsRaw.body?.[0]?.id || null;
  }

  // Try to resolve the file. A share asset may live under a different account than
  // the first one, so on 404 we try each account the user has.
  let fileRaw = null;
  const tryAccounts = [];
  if (ids.accountId) tryAccounts.push(ids.accountId);
  const all = accountsRaw?.body?.data || accountsRaw?.body || [];
  for (const a of all) { if (a?.id && !tryAccounts.includes(a.id)) tryAccounts.push(a.id); }
  for (const acct of tryAccounts) {
    if (!ids.fileId) break;
    fileRaw = await fioGetRaw(`${FIO_API}/accounts/${acct}/files/${ids.fileId}?include=media_links.original`, access);
    fileRaw.accountTried = acct;
    if (fileRaw.status === 200) { ids.accountId = acct; break; }
  }

  if (debug) {
    return json({ debug: true, expanded, accountId: ids.accountId, fileId: ids.fileId,
      accountsStatus: accountsRaw?.status, accounts: all.map(a => ({ id: a.id, name: a.name || a.display_name })),
      fileStatus: fileRaw?.status, fileBody: fileRaw?.body }, 200, cors);
  }

  if (!ids.fileId) return json({ error: "Couldn't find a Frame.io file id in that link." }, 422, cors);
  if (!fileRaw || fileRaw.status !== 200) return json({ error: "Frame.io couldn't find that file under your account (status " + (fileRaw?.status || "?") + "). The asset may be in a different workspace, or shares may need a different lookup." }, 422, cors);
  const file = fileRaw.body;
  const dl =
    file?.data?.media_links?.original?.download_url ||
    file?.data?.media_links?.original?.url ||
    file?.media_links?.original?.download_url || null;
  if (!dl) return json({ error: "That asset has no downloadable original media (it may still be processing)." }, 422, cors);
  return json({ download_url: dl, name: file?.data?.name || null }, 200, cors);
}

async function disconnect(request, env, cors, origin, self) {
  const session = cookie(request, COOKIE);
  if (session) await env.TOKENS.delete("sess:" + session);
  const headers = new Headers({ "Content-Type": "application/json", ...cors });
  headers.append("Set-Cookie", setCookie(self, "", 0));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// Session cookie. Now that this Worker lives on frameio.subcaptions.com, the cookie is
// scoped to the parent domain with SameSite=Lax, so it's first-party to the app and
// Safari keeps it. (SameSite=None looked cross-site and Safari dropped it.)
function setCookie(self, value, maxAge) {
  let dom = "";
  try { if (/(^|\.)subcaptions\.com$/i.test(new URL(self).hostname)) dom = "; Domain=.subcaptions.com"; } catch {}
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax${dom}; Path=/; Max-Age=${maxAge}`;
}

/* ---------- helpers ---------- */

// Extract a Frame.io file id (and account id if present) from a pasted link.
// NOTE: Frame.io V4 web URL shapes vary; this handles the common id-bearing forms
// and any embedded UUID. Verify against a real link from your account; adjust the
// patterns here if your share links use a different shape.
// Follow a short/share link's redirects to its final URL (e.g. f.io/XXXX ->
// next.frame.io/share/<share>/view/<file_id>) so we can read the id out of it.
async function expandLink(link) {
  try {
    const r = await fetch(link, { method: "GET", redirect: "follow", headers: { "User-Agent": "SubCaptions/1.0" } });
    return r.url || link;
  } catch { return link; }
}
function parseFrameioLink(link) {
  const out = { accountId: null, fileId: null };
  if (!link) return out;
  let m = link.match(/\/accounts\/([0-9a-f-]{36})/i); if (m) out.accountId = m[1];
  m = link.match(/\/files\/([0-9a-f-]{36})/i) ||
      link.match(/\/(?:player|assets?|view)\/([0-9a-f-]{36})/i) ||
      link.match(/[?&](?:asset_id|file_id|fileId)=([0-9a-f-]{36})/i);
  if (m) { out.fileId = m[1]; return out; }
  const uuids = link.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  // Last UUID in the path is most often the asset; account (if any) is captured above.
  const fileCandidate = uuids.filter((u) => u !== out.accountId).pop();
  if (fileCandidate) out.fileId = fileCandidate;
  return out;
}

async function exchange(env, params) {
  const body = new URLSearchParams({
    client_id: env.IMS_CLIENT_ID,
    client_secret: env.IMS_CLIENT_SECRET,
    ...params,
  });
  const r = await fetch(IMS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error("Adobe IMS token exchange failed (" + r.status + "). " + detail.slice(0, 300));
  }
  return r.json();
}

function htmlError(title, detail) {
  const body = `<div style="font:15px/1.5 system-ui;max-width:560px;margin:60px auto;padding:0 20px">
    <h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>
    <pre style="white-space:pre-wrap;background:#f6f6f8;border:1px solid #e3e3ea;border-radius:8px;padding:12px;color:#b91c1c">${escapeHtml(detail)}</pre>
    <p>Close this tab and try again from the app once it's fixed.</p></div>`;
  return new Response(body, { status: 400, headers: { "Content-Type": "text/html" } });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function saveTokens(env, session, tok) {
  const rec = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000,
  };
  await env.TOKENS.put("sess:" + session, JSON.stringify(rec), { expirationTtl: SESSION_TTL });
}

async function freshAccessToken(env, session) {
  const raw = await env.TOKENS.get("sess:" + session);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  if (rec.access_token && Date.now() < rec.expires_at) return rec.access_token;
  if (!rec.refresh_token) return null;
  const tok = await exchange(env, { grant_type: "refresh_token", refresh_token: rec.refresh_token });
  // IMS may or may not return a new refresh token; keep the old one if not.
  if (!tok.refresh_token) tok.refresh_token = rec.refresh_token;
  await saveTokens(env, session, tok);
  return tok.access_token;
}

// Like fioGet but never throws: returns { status, body } so callers can branch.
async function fioGetRaw(u, access) {
  const r = await fetch(u, { headers: { Authorization: "Bearer " + access, Accept: "application/json" } });
  let body = null;
  try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, body };
}
async function fioGet(u, access) {
  const r = await fetch(u, { headers: { Authorization: "Bearer " + access, Accept: "application/json" } });
  if (r.status === 401) throw new Error("Frame.io rejected the token (re-connect needed).");
  if (!r.ok) throw new Error("Frame.io API error (" + r.status + ")");
  return r.json();
}

function cookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  const m = h.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
