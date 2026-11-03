/**
 * Request guards for the transcription service. Kept free of Express so the
 * unit tests in test/ can import it directly.
 *
 * - validateMediaUrl: the user-supplied URL must be http(s) on the default port
 *   and resolve only to public addresses (no loopback, private, link-local,
 *   CGNAT, multicast, unspecified or cloud-metadata ranges, IPv4 or IPv6).
 * - startEgressGuard: a loopback-only HTTP proxy that yt-dlp, ffprobe and ffmpeg
 *   are pointed at. It repeats the address check on EVERY connection they open
 *   and connects to the address it checked, so redirects (yt-dlp and ffmpeg both
 *   follow them), URLs found inside fetched pages or playlists, and DNS answers
 *   that change between our check and their fetch are all covered.
 *   What it does not cover: when YTDLP_PROXY is set, yt-dlp talks to that
 *   upstream proxy instead and only the up-front check applies to yt-dlp; and
 *   non-HTTP protocols an extractor might pick (rtmp, rtsp, mms) do not go
 *   through any proxy.
 * - tierFor / isSignedIn: plan lookups that fail closed. Missing config means
 *   "free" (or "team" only with DEV_ALLOW_ALL=true and no SUPABASE_URL); a
 *   Supabase or network error throws PlanCheckError so the route answers 503.
 * - burnHeightFor: burn-in output height, validated and capped by plan.
 * - makeRateLimiter: fixed-window in-memory limiter (per process).
 */
import http from "node:http";
import { BlockList, isIP, connect as netConnect } from "node:net";
import { promises as dns } from "node:dns";

export class GuardError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export class PlanCheckError extends Error {}

const MAX_URL_LENGTH = 8192; // signed Frame.io / R2 links run to a couple of KB

// Address ranges no media fetch may reach.
const V4_BLOCKED = [
  ["0.0.0.0", 8],       // "this network" / unspecified
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // CGNAT (also Alibaba Cloud metadata 100.100.100.200)
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],   // private
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // documentation
  ["192.88.99.0", 24],  // 6to4 relay anycast
  ["192.168.0.0", 16],  // private
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24],  // documentation
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved + broadcast
];
const V6_BLOCKED = [
  ["::", 128],          // unspecified
  ["::1", 128],         // loopback
  ["64:ff9b:1::", 48],  // local-use NAT64
  ["100::", 64],        // discard-only
  ["2001::", 23],       // IETF protocol assignments (Teredo, ORCHID, benchmarking)
  ["2001:db8::", 32],   // documentation
  ["2002::", 16],       // 6to4 (embeds an IPv4 address)
  ["fc00::", 7],        // unique local (includes AWS metadata fd00:ec2::254)
  ["fe80::", 10],       // link-local
  ["fec0::", 10],       // old site-local
  ["ff00::", 8],        // multicast
];
const BLOCKED = new BlockList();
for (const [net, bits] of V4_BLOCKED) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of V6_BLOCKED) BLOCKED.addSubnet(net, bits, "ipv6");

// "::ffff:a00:1" -> [0,0,0,0,0,0xffff,0x0a00,0x0001]. Input must already pass isIP() === 6.
function ipv6Groups(addr) {
  let a = addr;
  if (a.includes(".")) { // trailing dotted quad, e.g. ::ffff:10.0.0.1
    const cut = a.lastIndexOf(":");
    const q = a.slice(cut + 1).split(".").map(Number);
    a = a.slice(0, cut + 1) + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  if (tail === undefined) return h.map((g) => parseInt(g, 16));
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => parseInt(g, 16));
}

// IPv4 address carried inside an IPv6 one (mapped, compatible, SIIT-translated,
// NAT64 well-known prefix), so ::ffff:10.0.0.1 is judged as 10.0.0.1.
function embeddedV4(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  const carries = (zero(0, 5) && (g[5] === 0xffff || g[5] === 0))
    || (zero(0, 4) && g[4] === 0xffff && g[5] === 0)
    || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6));
  return carries ? `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}` : null;
}

export function isBlockedIp(addr) {
  const a = String(addr).split("%")[0]; // drop an IPv6 zone id
  const fam = isIP(a);
  if (fam === 4) return BLOCKED.check(a, "ipv4");
  if (fam !== 6) return true; // not an address at all: refuse
  const v4 = embeddedV4(ipv6Groups(a));
  if (v4) return BLOCKED.check(v4, "ipv4");
  return BLOCKED.check(a, "ipv6");
}

const defaultLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

// Resolve a hostname and return one address to connect to, refusing the host if
// ANY of its addresses is internal. IPv4 is preferred for the connection.
export async function resolvePublic(hostname, lookup = defaultLookup) {
  const host = String(hostname).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new GuardError("That link points to a private or internal address");
    return host;
  }
  // Single-label and internal-only names never belong to a public media host.
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) {
    throw new GuardError("That link points to a private or internal address");
  }
  let addrs;
  try { addrs = await lookup(host); } catch (e) { throw new GuardError("Could not resolve that link's host"); }
  if (!Array.isArray(addrs) || !addrs.length) throw new GuardError("Could not resolve that link's host");
  if (addrs.some((a) => isBlockedIp(a.address))) throw new GuardError("That link points to a private or internal address");
  return (addrs.find((a) => isIP(a.address) === 4) || addrs[0]).address;
}

// Check a user-supplied media URL. Returns the parsed URL; callers must pass
// url.href (the normalized form) to yt-dlp and ffmpeg, never the raw string, so
// tricks like "http://2130706433/" or "http://a.com\@127.0.0.1/" are judged and
// fetched as the same host.
export async function validateMediaUrl(raw, { lookup = defaultLookup } = {}) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_LENGTH) throw new GuardError("Valid url required");
  let u;
  try { u = new URL(raw.trim()); } catch (e) { throw new GuardError("Valid url required"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new GuardError("Only http and https links are supported");
  if (u.port) throw new GuardError("Links on non-standard ports are not supported"); // URL drops :80 / :443 for its own scheme
  if (u.username || u.password) throw new GuardError("Links with a username or password are not supported");
  await resolvePublic(u.hostname, lookup);
  return u;
}

// Loopback HTTP proxy for child processes. Plain http arrives as an absolute-form
// request ("GET http://host/path"), https as "CONNECT host:443". Each one is
// resolved, checked and then connected to the checked address (DNS pinning).
export function startEgressGuard({ lookup = defaultLookup, log = (m) => console.warn(m) } = {}) {
  const server = http.createServer(async (req, res) => {
    let u = null;
    try { u = new URL(req.url); } catch (e) { /* origin-form request: not a proxy request */ }
    if (!u || u.protocol !== "http:" || u.port || u.username || u.password) { res.writeHead(403).end(); return; }
    let ip;
    try { ip = await resolvePublic(u.hostname, lookup); }
    catch (e) { log(`[egress] refused http ${u.hostname}: ${e.message}`); res.writeHead(403).end(); return; }
    const headers = { ...req.headers, host: u.host };
    delete headers["proxy-connection"]; delete headers["proxy-authorization"];
    const up = http.request({ host: ip, port: 80, method: req.method, path: u.pathname + u.search, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });

  server.on("connect", async (req, sock, head) => {
    sock.on("error", () => {});
    const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/.exec(req.url || "");
    const host = m && (m[1] || m[2]);
    if (!m || m[3] !== "443") { log(`[egress] refused CONNECT ${req.url}`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    let ip;
    try { ip = await resolvePublic(host, lookup); }
    catch (e) { log(`[egress] refused CONNECT ${host}: ${e.message}`); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    let open = false;
    const up = netConnect(443, ip, () => {
      open = true;
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    const kill = () => { sock.destroy(); up.destroy(); };
    up.on("error", () => { if (open) kill(); else sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    sock.on("error", kill);
    sock.on("close", () => up.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* ---------- plan checks ---------- */

// Supabase user for a bearer token: the user object, null when the token is not
// valid (401/403), or PlanCheckError when Supabase can't answer.
async function supabaseUser(token, env, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
      // Fall back to the service-role key as apikey so this works even if
      // SUPABASE_ANON_KEY isn't set on this service.
      headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (e) { throw new PlanCheckError(`auth lookup failed: ${e.message}`); }
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new PlanCheckError(`auth lookup returned ${r.status}`);
  const user = await r.json().catch(() => null);
  return user && user.id ? user : null;
}

const bearer = (req) => { const a = req.get("authorization") || ""; return a.startsWith("Bearer ") ? a.slice(7) : null; };

// Without SUPABASE_URL: PRO_TOKEN (shared secret) if set, else everyone is free
// unless DEV_ALLOW_ALL=true (local testing only).
function devTier(req, env) {
  if (env.PRO_TOKEN) return req.get("authorization") === `Bearer ${env.PRO_TOKEN}` ? "team" : "free";
  return env.DEV_ALLOW_ALL === "true" ? "team" : "free";
}

// Resolve the caller's subscription tier from their Supabase access token.
// Throws PlanCheckError on a Supabase or network error, so a paying user is
// never silently downgraded to free during an outage.
export async function tierFor(req, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.SUPABASE_URL) return devTier(req, env);
  const token = bearer(req);
  if (!token) return "free";
  const user = await supabaseUser(token, env, fetchImpl);
  if (!user) return "free";
  let rows;
  try {
    const r = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=tier`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) throw new PlanCheckError(`profile lookup returned ${r.status}`);
    rows = await r.json();
  } catch (e) { throw e instanceof PlanCheckError ? e : new PlanCheckError(`profile lookup failed: ${e.message}`); }
  if (!Array.isArray(rows)) throw new PlanCheckError("profile lookup returned no rows array");
  return rows[0]?.tier || "free";
}

// Is the caller a valid signed-in user (any tier)? Light gate for /peaks.
// Same fail-closed rules as tierFor.
export async function isSignedIn(req, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.SUPABASE_URL) return devTier(req, env) === "team";
  const token = bearer(req);
  if (!token) return false;
  return !!(await supabaseUser(token, env, fetchImpl));
}

// Loud startup lines for risky auth config (printed by server.mjs at boot).
export function authConfigWarnings(env = process.env) {
  const w = [];
  if (!env.SUPABASE_URL && !env.PRO_TOKEN) {
    w.push(env.DEV_ALLOW_ALL === "true"
      ? "!!! AUTH: DEV_ALLOW_ALL=true and no SUPABASE_URL/PRO_TOKEN: EVERY caller is treated as TEAM. Local testing only, never in production."
      : "!!! AUTH: SUPABASE_URL and PRO_TOKEN are both unset: every caller is treated as FREE (paid routes answer 402). Set SUPABASE_URL to enable plans.");
  }
  if (env.SUPABASE_URL && env.DEV_ALLOW_ALL === "true") w.push("!!! AUTH: DEV_ALLOW_ALL is ignored because SUPABASE_URL is set.");
  if (env.SUPABASE_URL && !env.SUPABASE_SERVICE_ROLE_KEY) w.push("!!! AUTH: SUPABASE_SERVICE_ROLE_KEY is unset: plan lookups will fail and paid routes will answer 503.");
  return w;
}

/* ---------- burn-in height ---------- */

export const BURN_HEIGHTS = [480, 720, 1080, 1440, 2160];
const BURN_CAP = { solo: 1080, team: 2160 };

// Output height for /burn: one of BURN_HEIGHTS, default 1080, capped by plan
// (Solo 1080, Team 2160; any other paid tier gets the Solo cap).
// Returns { height } or { status, error } for the route to send.
export function burnHeightFor(tier, requested) {
  if (tier === "free") return { status: 402, error: "Pro required" };
  const cap = BURN_CAP[tier] || BURN_CAP.solo;
  const h = requested === undefined || requested === null || requested === "" ? 1080
    : typeof requested === "number" || typeof requested === "string" ? Number(requested) : NaN;
  if (!BURN_HEIGHTS.includes(h)) return { status: 400, error: `maxHeight must be one of ${BURN_HEIGHTS.join(", ")}` };
  if (h > cap) return { status: 402, error: `${h}p export needs the Team plan` };
  return { height: h };
}

/* ---------- rate limit ---------- */

// Fixed-window counter per key. In-memory, so it resets on restart and is per
// instance; good enough to stop one client hammering a single Render box.
export function makeRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return function hit(key) {
    const t = now();
    let e = hits.get(key);
    if (!e || t >= e.reset) { e = { count: 0, reset: t + windowMs }; hits.set(key, e); }
    e.count++;
    if (hits.size > 10000) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
    return { ok: e.count <= limit, retryAfterSec: Math.ceil((e.reset - t) / 1000) };
  };
}
