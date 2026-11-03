/**
 * SubCaptions upload connector (Cloudflare Worker).
 *
 * Lets a signed-in Solo user upload a video DIRECTLY to R2 from the browser
 * (presigned PUT URL), then play it back / auto-transcribe it via short-lived
 * signed GET URLs. The browser never receives our R2 access keys; this Worker
 * signs URLs server-side and validates auth/quota.
 *
 * Endpoints (all CORS-aware, JSON):
 *   POST /sign-upload   { filename, contentType, size } -> { uploadUrl, key, playbackUrl, expiresAt }
 *   POST /playback      { key }                         -> { url, expiresAt }   (re-sign before transcribe)
 *   POST /delete        { key }                         -> { ok: true }
 *   GET  /quota                                          -> { used, limit, files: [...] }
 *   GET  /health                                         -> { ok, configured }
 *
 * Per-file cap: 2 GB (per plan, see MAX_FILE_BY_TIER). Per-user quota: 10 GB.
 * The PUT URL signs Content-Length (and Content-Type for video/* types), so R2
 * rejects an upload larger than the size that was checked here. R2 bucket has a
 * 7-day expiry rule (set via wrangler), and clients SHOULD call /delete once
 * they've exported.
 *
 * Required setup (see upload-worker/README.md):
 *   - R2 bucket "subcaptions-uploads" + lifecycle expire-after-7d + CORS
 *   - R2 API token (Access Key ID + Secret): paste into secrets below
 *   - secrets: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, SUPABASE_ANON_KEY
 *   - vars: R2_ACCOUNT_ID, R2_BUCKET, SUPABASE_URL, BILLING_BASE, ALLOWED_ORIGIN
 */

const MAX_FILE = 2 * 1024 * 1024 * 1024;  // 2 GB per file
const MAX_FILE_BY_TIER = { solo: MAX_FILE, team: MAX_FILE };
const QUOTA = 10 * 1024 * 1024 * 1024;    // 10 GB per user
const UPLOAD_EXPIRES = 60 * 60;            // 1h to finish PUT
const PLAYBACK_EXPIRES = 60 * 60 * 6;      // 6h playback URL
const ALLOWED_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const VIDEO_TYPE = /^video\/[a-z0-9.+-]+$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const _allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
    const _reqOrigin = request.headers.get("Origin") || "";
    const origin = _allowed.includes("*") ? "*" : (_allowed.includes(_reqOrigin) ? _reqOrigin : _allowed[0]);
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const configured = !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);
    if (url.pathname === "/health") return json({ ok: true, configured }, 200, cors);
    if (!configured) return json({ error: "Upload Worker is not fully configured yet." }, 501, cors);

    try {
      // All real endpoints require a Solo/Team plan.
      const auth = await requireSolo(request, env);
      if (auth.error) return json({ error: auth.error }, auth.status, cors);

      if (url.pathname === "/sign-upload" && request.method === "POST") return await signUpload(request, env, auth.userId, auth.tier, cors);
      if (url.pathname === "/playback" && request.method === "POST") return await playback(request, env, auth.userId, cors);
      if (url.pathname === "/delete" && request.method === "POST") return await deleteObject(request, env, auth.userId, cors);
      if (url.pathname === "/quota") return await quota(env, auth.userId, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.message || "Server error" }, 500, cors);
    }
  },
};

/* ---------- auth ---------- */

// Resolve the bearer token to { userId, tier } via Supabase + profiles, and
// require a paying tier. Mirrors the transcribe server's check, including
// failing closed: if Supabase can't answer, a paying user gets 503 (try again),
// never a 402 telling them they have no plan.
const PLAN_UNAVAILABLE = { error: "Couldn't check your plan. Try again in a moment.", status: 503 };
async function requireSolo(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/);
  if (!m) return { error: "Sign in to upload.", status: 401 };
  const token = m[1];

  // Supabase user identity
  let userRes;
  try {
    userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (e) { return PLAN_UNAVAILABLE; }
  if (userRes.status === 401 || userRes.status === 403) return { error: "Sign-in expired. Please sign in again.", status: 401 };
  if (!userRes.ok) return PLAN_UNAVAILABLE;
  const u = await userRes.json().catch(() => null);
  if (!u || !u.id) return { error: "Sign-in invalid.", status: 401 };

  // Tier from profiles row
  let rows;
  try {
    const profRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=tier`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!profRes.ok) return PLAN_UNAVAILABLE;
    rows = await profRes.json();
  } catch (e) { return PLAN_UNAVAILABLE; }
  if (!Array.isArray(rows)) return PLAN_UNAVAILABLE;
  const tier = rows[0] ? rows[0].tier : "free";
  if (tier !== "solo" && tier !== "team") return { error: "Uploading videos needs a Solo plan.", status: 402 };
  return { userId: u.id, tier };
}

/* ---------- endpoints ---------- */

async function signUpload(request, env, userId, tier, cors) {
  const { filename, contentType, size } = await request.json().catch(() => ({}));
  if (typeof filename !== "string" || !ALLOWED_EXT.test(filename)) {
    return json({ error: "Unsupported file type. Use .mp4, .m4v, .mov, .webm, .mkv, or .avi." }, 415, cors);
  }
  const sz = typeof size === "number" || typeof size === "string" ? Number(size) : NaN;
  if (!Number.isSafeInteger(sz) || sz <= 0) return json({ error: "Missing file size." }, 400, cors);
  const maxFile = MAX_FILE_BY_TIER[tier] || MAX_FILE;
  if (sz > maxFile) return json({ error: `File too large. The maximum is ${Math.round(maxFile / 1024 ** 3)} GB per upload.` }, 413, cors);

  // Headers bound into the PUT signature. Content-Length always, so the upload
  // can't be bigger than the size checked above. Content-Type only for video/*:
  // the browser sends a File's own type, and sends no Content-Type at all when
  // the type is empty (the site then declares application/octet-stream), so
  // that case stays unsigned.
  const putHeaders = { "content-length": String(sz) };
  const ct = typeof contentType === "string" ? contentType.trim() : "";
  if (VIDEO_TYPE.test(ct)) putHeaders["content-type"] = ct;
  else if (ct && ct.toLowerCase() !== "application/octet-stream") {
    return json({ error: "Unsupported content type." }, 415, cors);
  }

  // Enforce 10 GB per-user quota by listing existing objects under their prefix.
  const used = await usedBytes(env, userId);
  if (used + sz > QUOTA) {
    return json({ error: `You've used ${Math.round(used / 1e9 * 10) / 10} GB of your 10 GB upload quota. Delete an old upload (or wait for 7-day auto-expire) and try again.` }, 413, cors);
  }

  const key = `u/${userId}/${randomId()}/${safeName(filename)}`;
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${env.R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const uploadUrl = await presign({
    method: "PUT", host, path, headers: putHeaders,
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY,
    expiresIn: UPLOAD_EXPIRES,
  });
  // Bake the playback URL once so the client can play immediately after upload.
  const playbackUrl = await presign({
    method: "GET", host, path,
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY,
    expiresIn: PLAYBACK_EXPIRES,
  });
  return json({
    uploadUrl, key, playbackUrl,
    expiresAt: new Date(Date.now() + PLAYBACK_EXPIRES * 1000).toISOString(),
  }, 200, cors);
}

async function playback(request, env, userId, cors) {
  const { key } = await request.json().catch(() => ({}));
  if (!key || !key.startsWith(`u/${userId}/`)) return json({ error: "Forbidden" }, 403, cors);
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${env.R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const url = await presign({
    method: "GET", host, path,
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY,
    expiresIn: PLAYBACK_EXPIRES,
  });
  return json({ url, expiresAt: new Date(Date.now() + PLAYBACK_EXPIRES * 1000).toISOString() }, 200, cors);
}

async function deleteObject(request, env, userId, cors) {
  const { key } = await request.json().catch(() => ({}));
  if (!key || !key.startsWith(`u/${userId}/`)) return json({ error: "Forbidden" }, 403, cors);
  // Use the R2 binding for delete; it's simpler than signing a DELETE and works fine.
  await env.R2.delete(key);
  return json({ ok: true }, 200, cors);
}

async function quota(env, userId, cors) {
  const list = await env.R2.list({ prefix: `u/${userId}/` });
  const files = (list.objects || []).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
  const used = files.reduce((a, b) => a + (b.size || 0), 0);
  return json({ used, limit: QUOTA, files }, 200, cors);
}

async function usedBytes(env, userId) {
  const list = await env.R2.list({ prefix: `u/${userId}/` });
  return (list.objects || []).reduce((a, b) => a + (b.size || 0), 0);
}

/* ---------- AWS sig v4 presigner (inline, Web Crypto) ---------- */

// `headers` are extra request headers to bind into the signature; the client
// must then send exactly these values or R2 answers 403.
async function presign({ method, host, path, accessKey, secretKey, headers = {}, region = "auto", service = "s3", expiresIn = 300 }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const algo = "AWS4-HMAC-SHA256";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signed = Object.entries({ ...headers, host })
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = signed.map(([k]) => k).join(";");
  const params = [
    ["X-Amz-Algorithm", algo],
    ["X-Amz-Credential", `${accessKey}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  params.sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQuery = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v}\n`).join("");
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const stringToSign = [algo, amzDate, scope, await sha256hex(canonicalRequest)].join("\n");
  const kDate = await hmac("AWS4" + secretKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function hmac(key, msg) {
  const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const m = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const ck = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, m));
}
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toHex(new Uint8Array(b));
}
function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/* ---------- small helpers ---------- */

function randomId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
function safeName(name) {
  return String(name).normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(0, 80);
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
