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
    const origin = env.ALLOWED_ORIGIN || request.headers.get("Origin") || "*";
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

      if (url.pathname === "/start") return start(url, env, self);
      if (url.pathname === "/callback") return callback(url, env, self);
      if (url.pathname === "/resolve") return resolve(request, url, env, cors);
      if (url.pathname === "/disconnect" && request.method === "POST") return disconnect(request, env, cors, origin);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.message || "Server error" }, 500, cors);
    }
  },
};

// Step 1: bounce the user to Adobe IMS, remembering where to send them back.
async function start(url, env, self) {
  const ret = url.searchParams.get("return") || env.ALLOWED_ORIGIN || "/";
  const state = crypto.randomUUID();
  await env.TOKENS.put("state:" + state, ret, { expirationTtl: 600 });
  const a = new URL(IMS_AUTHORIZE);
  a.searchParams.set("client_id", env.IMS_CLIENT_ID);
  a.searchParams.set("redirect_uri", self + "/callback");
  a.searchParams.set("scope", SCOPES);
  a.searchParams.set("response_type", "code");
  a.searchParams.set("state", state);
  return Response.redirect(a.toString(), 302);
}

// Step 2: exchange the code for tokens, store them under a fresh session id, set cookie.
async function callback(url, env, self) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("Missing code/state", { status: 400 });
  const ret = await env.TOKENS.get("state:" + state);
  if (!ret) return new Response("Expired or invalid state", { status: 400 });
  await env.TOKENS.delete("state:" + state);

  const tok = await exchange(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: self + "/callback",
  });
  const session = crypto.randomUUID();
  await saveTokens(env, session, tok);

  const headers = new Headers({ Location: ret });
  headers.append("Set-Cookie", `${COOKIE}=${session}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL}`);
  return new Response(null, { status: 302, headers });
}

// Step 3: resolve a frame.io link to a direct media URL using the stored token.
async function resolve(request, url, env, cors) {
  const session = cookie(request, COOKIE);
  if (!session) return json({ error: "Not connected" }, 401, cors);
  const access = await freshAccessToken(env, session);
  if (!access) return json({ error: "Not connected" }, 401, cors);

  const link = url.searchParams.get("link") || "";
  const ids = parseFrameioLink(link);
  if (!ids.fileId) return json({ error: "Couldn't find a Frame.io file id in that link. Open the asset and copy its link, or paste the file's share link." }, 422, cors);

  // Frame.io V4 calls are scoped to an account. Use the id from the link if present,
  // else fall back to the user's first account.
  let accountId = ids.accountId;
  if (!accountId) {
    const accts = await fioGet(`${FIO_API}/accounts`, access);
    accountId = (accts && accts.data && accts.data[0] && accts.data[0].id) || null;
  }
  if (!accountId) return json({ error: "No Frame.io account found for this user." }, 422, cors);

  const file = await fioGet(`${FIO_API}/accounts/${accountId}/files/${ids.fileId}?include=media_links.original`, access);
  const dl =
    file?.data?.media_links?.original?.download_url ||
    file?.data?.media_links?.original?.url ||
    file?.media_links?.original?.download_url || null;
  if (!dl) return json({ error: "That asset has no downloadable original media (it may still be processing)." }, 422, cors);
  return json({ download_url: dl, name: file?.data?.name || null }, 200, cors);
}

async function disconnect(request, env, cors, origin) {
  const session = cookie(request, COOKIE);
  if (session) await env.TOKENS.delete("sess:" + session);
  const headers = new Headers({ "Content-Type": "application/json", ...cors });
  headers.append("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/* ---------- helpers ---------- */

// Extract a Frame.io file id (and account id if present) from a pasted link.
// NOTE: Frame.io V4 web URL shapes vary; this handles the common id-bearing forms
// and any embedded UUID. Verify against a real link from your account; adjust the
// patterns here if your share links use a different shape.
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
  if (!r.ok) throw new Error("Adobe IMS token exchange failed (" + r.status + ")");
  return r.json();
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
