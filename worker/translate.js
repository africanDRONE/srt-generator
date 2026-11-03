/**
 * Subtitle Translator, Cloudflare Worker translation proxy.
 *
 * Holds the Anthropic API key server-side and translates a batch of subtitle
 * cues with Claude. The browser never sees the key; only caption text transits
 * this Worker, and no caption text is stored or logged here. The request guard
 * (documented above guardRequest, below json()) keeps daily usage counters.
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler secret put ANTHROPIC_API_KEY      (paste your key)
 *   3. wrangler deploy
 *   4. Put the resulting *.workers.dev URL into index.html's API_BASE.
 *
 * Env vars (wrangler.toml [vars] or secrets):
 *   ANTHROPIC_API_KEY  (secret, required)
 *   MODEL              (optional, default claude-opus-4-8, see cost note below)
 *   ALLOWED_ORIGIN     (optional, comma-separated site origins; "*" is ignored, see the guard)
 *   MAX_CUES           (optional, default 60, hard cap per request, abuse guard)
 *   UPSTREAM_TIMEOUT_MS (optional, default 30000, longest wait for one Anthropic call)
 *   DEADLINE_MS        (optional, default 40000, no Anthropic call runs past this point in a
 *                       request; keep it below the pages' 45 second request timeout)
 *
 * Cost note: claude-opus-4-8 is premium ($5/$25 per MTok). For a high-volume
 * free tool you will almost certainly want MODEL=claude-haiku-4-5 ($1/$5) or
 * claude-sonnet-4-6 ($3/$15). Quality on subtitle translation is very good on
 * all three; see docs/monetization.md for the unit-economics breakdown.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export default {
  async fetch(request, env) {
    // Every request passes the guard before any paid work: origin allow-list, size caps,
    // burst limit, plan lookup and daily quota. It answers OPTIONS and /health itself.
    const guard = await guardRequest(request, env);
    if (guard.response) return guard.response;
    const { cors } = guard;
    const { source, target, cues } = guard.payload;

    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server not configured" }, 500, cors);

    const model = env.MODEL || DEFAULT_MODEL;
    const srcLabel = source && source !== "auto" ? source : "the source language (auto-detect it)";

    // Number the cues. The model returns each translation with its entry number, so a merged,
    // split or dropped entry is detected by number and never shifts the lines after it.
    const texts = cues.map((t) => String(t));
    const numbered = texts.map((t, i) => `[${i + 1}] ${t.replace(/\n/g, " ⏎ ")}`).join("\n");

    const system =
      "You are a professional subtitle translator. You translate spoken-dialogue captions " +
      "for video. Translate naturally for the spoken register of the target language, not word-for-word. " +
      "Keep each translation concise enough to read on screen in the same time. Preserve the line-break " +
      "marker ⏎ where it appears (it separates the two on-screen lines). Do not add notes or commentary. " +
      "The entries are consecutive captions cut from continuous speech, so one sentence often runs " +
      "across several entries. Each entry is shown on screen at its own time, so every entry needs its " +
      "own translation: never merge two entries into one, never split one entry into two, and never " +
      "leave an entry out or empty, even when the sentence continues in the next entry. When the target " +
      "language needs a different word order, keep each entry's share of the sentence in that entry. " +
      "Return one item per entry, in order, with n set to the entry number and text set to its translation.";

    const userMsg =
      `Translate these ${texts.length} subtitle entries from ${srcLabel} into ${target}. ` +
      `Return JSON only, with exactly ${texts.length} items numbered 1 to ${texts.length}.\n\n${numbered}`;

    const body = {
      model,
      max_tokens: guard.maxTokens, // sized to the request by the guard, never above 16000
      thinking: { type: "disabled" }, // translation is a transform, not a reasoning task
      system,
      messages: [{ role: "user", content: userMsg }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              translations: {
                type: "array",
                items: {
                  type: "object",
                  properties: { n: { type: "integer" }, text: { type: "string" } },
                  required: ["n", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["translations"],
            additionalProperties: false,
          },
        },
      },
    };

    // No Anthropic call runs past the deadline, so the Worker stops working on a request
    // around the time the page gives up on it.
    const upstreamTimeoutMs = positiveInt(env.UPSTREAM_TIMEOUT_MS, 30000);
    const deadline = Date.now() + positiveInt(env.DEADLINE_MS, 40000);

    // One Anthropic call. Returns { ok, status, data }, or null for a network error or a timeout.
    const callAnthropic = async () => {
      // Give up on a call that hangs. The timer also covers reading the body, which can
      // stall after the headers arrive.
      const ctrl = new AbortController();
      const wait = Math.max(1, Math.min(upstreamTimeoutMs, deadline - Date.now()));
      const timer = setTimeout(() => ctrl.abort(), wait);
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        let data = null;
        if (resp.ok) {
          try {
            data = await resp.json();
          } catch {
            if (ctrl.signal.aborted) return null;
          }
        }
        return { ok: resp.ok, status: resp.status, data };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // Retry transient upstream failures (network error, timeout, 429, 5xx) up to 3 times
    // so a momentary Anthropic blip doesn't fail the whole translation.
    let resp = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      resp = await callAnthropic();
      if (resp && resp.ok) break;
      const retryable = !resp || resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt === 3) break;
      // Skip the pause and the next call when the pause itself would reach the deadline.
      const pause = 500 * attempt;
      if (Date.now() + pause >= deadline) break;
      await new Promise((r) => setTimeout(r, pause));
    }
    if (!resp) return json({ error: "Upstream request failed" }, 502, cors);
    if (!resp.ok) {
      if (resp.status === 429) return json({ error: "Rate limited upstream" }, 429, cors);
      return json({ error: "Translation provider error", status: resp.status }, 502, cors);
    }

    const data = resp.data;
    if (!data) return json({ error: "Could not parse translation" }, 502, cors);
    if (data.stop_reason === "refusal") {
      return json({ error: "Content was declined by the translator." }, 422, cors);
    }

    // output_config.format guarantees the first text block is valid JSON for the schema.
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let items;
    try {
      items = JSON.parse(textBlock.text).translations;
    } catch {
      return json({ error: "Could not parse translation" }, 502, cors);
    }

    // The pages match on this exact error string, then split the batch and send the parts
    // again, so keep it stable.
    const translations = alignByNumber(items, texts);
    if (!translations) return json({ error: "Translation count mismatch" }, 502, cors);

    // Restore the line-break marker the model was asked to preserve.
    return json({ translations: translations.map((t) => t.replace(/\s*⏎\s*/g, "\n")) }, 200, cors);
  },
};

// Place each returned item on its entry number. Returns null unless every entry from 1 to
// texts.length arrives exactly once, with text for every cue that had text. An empty text is
// rejected because a model that merges two entries tends to leave the second one empty.
function alignByNumber(items, texts) {
  if (!Array.isArray(items) || items.length !== texts.length) return null;
  const out = new Array(texts.length).fill(null);
  for (const item of items) {
    const n = item && item.n;
    if (!Number.isInteger(n) || n < 1 || n > texts.length || out[n - 1] !== null) return null;
    if (typeof item.text !== "string") return null;
    if (!item.text.trim() && texts[n - 1].trim()) return null;
    out[n - 1] = item.text;
  }
  return out;
}

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

/* =================== REQUEST GUARD ===================
 *
 * Runs before every translation. Each step rejects with a JSON body of the form
 * { error, code } so the pages can show the message.
 *
 *   1. Route          POST /translate translates, GET /health reports which protections
 *                     are configured, anything else is 404.
 *   2. Origin         The Origin header must be on the allow-list (403 otherwise). This
 *                     stops other websites from using the endpoint in a browser. A script
 *                     can forge the header, so the limits below do not depend on it.
 *   3. Size caps      Body bytes, cue count, characters per cue and per request (413).
 *   4. Burst limit    Optional Workers rate limit binding RL_IP, keyed by IP (429).
 *   5. Plan           A Supabase session token in the Authorization header is checked
 *                     against Supabase and the profiles table. No token, a bad token or a
 *                     Supabase outage all mean the free plan, so anonymous use keeps working.
 *   6. Daily quota    A Durable Object counter per IP (free) or per account (paid), plus
 *                     one shared pool for all free traffic. Required: the Worker refuses to
 *                     translate when the QUOTA binding is missing or failing.
 *
 * Quota unit: one request costs REQUEST_OVERHEAD plus the length of each cue, with
 * MIN_CUE_COST as the floor per cue. Characters other than printable ASCII count three
 * times, and a line break inside a cue counts as five (it is sent as a three character
 * marker). Counters reset at midnight UTC. A rejected request costs nothing, and a
 * request that fails upstream is not refunded.
 *
 * Output cap: max_tokens for the Anthropic call is OUTPUT_BASE_TOKENS plus
 * OUTPUT_TOKENS_PER_UNIT for each unit charged for the cues, up to MAX_OUTPUT_TOKENS, so
 * what a request can spend is tied to what it was charged.
 *
 * What is stored: one { day, used } record per counter, inside a Durable Object named after
 * the IP address (IPv6 by its /64 prefix) or the account id. No caption text. Idle counters
 * delete themselves about two days after their last day of use.
 *
 * Env vars, all optional unless marked:
 *   ALLOWED_ORIGIN         comma-separated origins; unset or "*" means DEFAULT_ORIGINS
 *   ALLOW_LOCALHOST        "true" also allows http://localhost, 127.0.0.1 and [::1], any port
 *   MAX_CUES               cues per request, default 60
 *   MAX_CUE_CHARS          characters per cue, default 1000
 *   MAX_REQUEST_CHARS      characters per request, default 20000
 *   FREE_DAILY_CHARS       daily quota per IP on the free plan, default 150000
 *   FREE_POOL_DAILY_CHARS  daily quota shared by all free traffic, default 3000000
 *   SOLO_DAILY_CHARS       daily quota per Solo account, default 1000000
 *   TEAM_DAILY_CHARS       daily quota per Team account, default 2000000
 *   SUPABASE_URL           project URL; with SUPABASE_ANON_KEY it turns the plan check on
 *   SUPABASE_ANON_KEY      the public publishable key, set in wrangler.toml [vars]
 * Bindings:
 *   QUOTA                  Durable Object namespace for class Quota (required)
 *   RL_IP                  rate limit binding (optional)
 */

const DEFAULT_ORIGINS = [
  "https://subcaptions.com",
  "https://www.subcaptions.com",
  "https://subcaptions.johnnie-miller.workers.dev",
];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_OVERHEAD = 500;
const MIN_CUE_COST = 40;

// Every character other than printable ASCII (letters, digits, punctuation, space) counts
// three times: accented letters, Cyrillic, Arabic, Thai, Chinese, Japanese, Korean, emoji,
// control characters and so on. They cost more to translate per character than plain
// English text. The factor is an estimate, not a measured rate.
const HEAVY_RE = /[^\x20-\x7E]/gu;
const HEAVY_EXTRA = 2;

// The handler sends each line break inside a cue to the model as this marker, so a cue is
// weighed in that form. Keep it the same as the marker in the handler above.
const NEWLINE_MARK = " ⏎ ";

// The reply may not be longer than the request justifies. Without this a short request
// could ask the model for a very long answer and spend far more than its quota cost.
// Past the base allowance, max_tokens is OUTPUT_TOKENS_PER_UNIT for each unit charged.
const MAX_OUTPUT_TOKENS = 16000;
const OUTPUT_BASE_TOKENS = 400;
const OUTPUT_TOKENS_PER_UNIT = 3;
const FREE_POOL_NAME = "pool:free";
const PAID_TIERS = new Set(["solo", "team"]);

// A language code such as "es", "pt-BR" or "zh-CN", which is what the pages send. The
// value ends up inside the prompt, so nothing but a short code is accepted.
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{20,4096}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPABASE_TIMEOUT_MS = 4000;
const TIER_TTL_MS = 5 * 60 * 1000;
const TIER_MISS_TTL_MS = 60 * 1000;
const TIER_CACHE_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// Best-effort cache of plan lookups, keyed by a hash of the token so the token itself is
// not kept in memory longer than the request. It lives only as long as this isolate does.
const tierCache = new Map();

async function guardRequest(request, env) {
  const url = new URL(request.url);
  const reqOrigin = request.headers.get("Origin") || "";
  const originOk = isAllowedOrigin(reqOrigin, env);
  const cors = corsHeaders(originOk ? reqOrigin : "");
  const reject = (status, error, code, extra) =>
    ({ response: json({ error, code }, status, { ...cors, ...(extra || {}) }) });

  if (request.method === "OPTIONS") return { response: new Response(null, { status: 204, headers: cors }) };

  if (url.pathname === "/health") {
    if (request.method !== "GET") return reject(405, "Method not allowed", "method");
    return { response: json({ ...healthReport(env), clientKey: clientIpKey(request) }, 200, cors) };
  }
  if (url.pathname !== "/translate") return reject(404, "Not found", "not_found");
  if (request.method !== "POST") return reject(405, "Method not allowed", "method");
  if (!originOk) return reject(403, "This site is not allowed to use the translator.", "origin");

  const body = await readBodyCapped(request, MAX_BODY_BYTES);
  if (body.tooLarge) return reject(413, "Request is too large.", "too_large");
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return reject(400, "Invalid JSON", "bad_request");
  }
  const checked = validatePayload(parsed, env);
  if (checked.error) return reject(checked.status, checked.error, checked.code);

  // Fail closed: without the quota counter nothing bounds the spend on the API key.
  if (!env.QUOTA) return reject(500, "Server not configured", "not_configured");

  const ipKey = clientIpKey(request);

  // The burst limiter is a cheap first filter. If it errors the request carries on,
  // because the daily quota below is the limit that bounds spend.
  if (env.RL_IP) {
    let allowed = true;
    try {
      allowed = (await env.RL_IP.limit({ key: "ip:" + ipKey })).success !== false;
    } catch {
      allowed = true;
    }
    if (!allowed) {
      return reject(429, "Too many requests. Wait a minute and try again.", "rate_limited", { "Retry-After": "60" });
    }
  }

  const plan = await resolveTier(request, env);
  const paid = PAID_TIERS.has(plan.tier) && !!plan.userId;
  const cueCost = checked.payload.cues.reduce((n, cue) => n + Math.max(MIN_CUE_COST, cueWeight(cue)), 0);
  const cost = REQUEST_OVERHEAD + cueCost;
  const maxTokens = Math.min(MAX_OUTPUT_TOKENS, OUTPUT_BASE_TOKENS + OUTPUT_TOKENS_PER_UNIT * cueCost);
  const busy = () =>
    reject(503, "Translator is busy. Try again in a moment.", "limiter_unavailable", { "Retry-After": "30" });
  const retry = { "Retry-After": String(secondsToUtcMidnight(Date.now())) };

  try {
    if (paid) {
      const limit = plan.tier === "team"
        ? intVar(env.TEAM_DAILY_CHARS, 2000000, 0)
        : intVar(env.SOLO_DAILY_CHARS, 1000000, 0);
      const own = await chargeQuota(env, "user:" + plan.userId.toLowerCase(), cost, limit);
      if (!own.ok) {
        return reject(429, "Daily translation limit reached for this account. It resets at midnight UTC.", "daily_quota", retry);
      }
    } else {
      const own = await chargeQuota(env, "ip:" + ipKey, cost, intVar(env.FREE_DAILY_CHARS, 150000, 0));
      if (!own.ok) {
        return reject(429, "Daily free translation limit reached. It resets at midnight UTC. A paid plan has a higher limit.", "daily_quota", retry);
      }
      let pool = null;
      try {
        pool = await chargeQuota(env, FREE_POOL_NAME, cost, intVar(env.FREE_POOL_DAILY_CHARS, 3000000, 0));
      } catch {
        pool = null;
      }
      if (!pool || !pool.ok) {
        // The request is not going ahead, so the address gets its units back.
        try { await refundQuota(env, "ip:" + ipKey, cost); } catch { /* best effort */ }
        if (!pool) return busy();
        return reject(429, "Free translation is at capacity for today. It resets at midnight UTC. Paid plans are not affected.", "free_pool", retry);
      }
    }
  } catch {
    return busy();
  }

  return { cors, payload: checked.payload, tier: paid ? plan.tier : "free", maxTokens };
}

function cueWeight(cue) {
  const sent = cue.replace(/\n/g, NEWLINE_MARK);
  const heavy = sent.match(HEAVY_RE);
  return sent.length + (heavy ? HEAVY_EXTRA * heavy.length : 0);
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function allowedOrigins(env) {
  const listed = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s && s !== "*");
  return listed.length ? listed : DEFAULT_ORIGINS;
}

function isAllowedOrigin(origin, env) {
  if (!origin || origin === "null") return false;
  if (allowedOrigins(env).includes(origin)) return true;
  if (String(env.ALLOW_LOCALHOST || "").toLowerCase() !== "true") return false;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname) && u.origin === origin;
}

// Reports what is switched on, never a secret or a setting's value, so the endpoint is
// safe to leave public. The caller also gets back the quota key for their own address.
function healthReport(env) {
  return {
    ok: true,
    translator: !!env.ANTHROPIC_API_KEY,
    protections: {
      origins: allowedOrigins(env).length,
      localhost: String(env.ALLOW_LOCALHOST || "").toLowerCase() === "true",
      quota: !!env.QUOTA,
      rateLimit: !!env.RL_IP,
      planCheck: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
    },
  };
}

function intVar(value, fallback, min) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value).trim())) return fallback;
  const n = parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

// Reads the body but stops as soon as it passes maxBytes, so an oversized upload is
// never buffered or parsed.
async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* the stream is already closed */ }
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

function validatePayload(parsed, env) {
  const bad = (status, error, code) => ({ status, error, code });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad(400, "Invalid request body", "bad_request");
  const { source, target, cues } = parsed;

  if (!Array.isArray(cues) || cues.length === 0) return bad(400, "No cues provided", "bad_request");
  if (!target || typeof target !== "string") return bad(400, "Missing target language", "bad_request");
  if (!LANG_RE.test(target)) return bad(400, "Unsupported target language", "bad_request");
  let src = "auto";
  if (source !== undefined && source !== null && source !== "" && source !== "auto") {
    if (typeof source !== "string" || !LANG_RE.test(source)) return bad(400, "Unsupported source language", "bad_request");
    src = source;
  }

  const maxCues = intVar(env.MAX_CUES, 60, 1);
  const maxCueChars = intVar(env.MAX_CUE_CHARS, 1000, 1);
  const maxRequestChars = intVar(env.MAX_REQUEST_CHARS, 20000, 1);
  if (cues.length > maxCues) return bad(413, `Too many cues in one request (max ${maxCues})`, "too_many_cues");

  let total = 0;
  for (const cue of cues) {
    if (typeof cue !== "string") return bad(400, "Each cue must be text", "bad_request");
    if (cue.length > maxCueChars) {
      return bad(413, `A caption is longer than ${maxCueChars} characters. Split it and try again.`, "cue_too_long");
    }
    total += cue.length;
  }
  if (total > maxRequestChars) {
    return bad(413, `Too much text in one request (max ${maxRequestChars} characters).`, "too_large");
  }
  return { payload: { source: src, target, cues } };
}

// CF-Connecting-IP is the address Cloudflare saw the request come from. GET /health returns
// the key computed here for the caller, which makes it easy to confirm on the live Worker
// that a forged header is not honoured. The free pool caps spend even if an IP is wrong.
// IPv6 is keyed by its /64 prefix because one connection usually owns the whole /64.
// Anything that is not a well-formed address gives "unknown", and all such requests share
// one counter.
function clientIpKey(request) {
  let ip = (request.headers.get("CF-Connecting-IP") || "").trim().toLowerCase().split("%")[0];
  if (!ip || ip.length > 64) return "unknown";
  if (!ip.includes(":")) return ipv4Octets(ip) ? ipv4Octets(ip).join(".") : "unknown";

  // An IPv6 address may end in a dotted IPv4 part. An IPv4-mapped address is keyed as
  // the IPv4 address itself, any other form has the part rewritten as two hex groups.
  const dotted = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const o = ipv4Octets(dotted[2]);
    if (!o) return "unknown";
    if (/^(?:::ffff:|0:0:0:0:0:ffff:)$/.test(dotted[1])) return o.join(".");
    ip = dotted[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }

  const parts = ip.split("::");
  if (parts.length > 2) return "unknown";
  const front = parts[0] ? parts[0].split(":") : [];
  const back = parts[1] ? parts[1].split(":") : [];
  const count = front.length + back.length;
  if (parts.length === 2 ? count > 7 : count !== 8) return "unknown";
  if (![...front, ...back].every((g) => IPV6_GROUP_RE.test(g))) return "unknown";
  const groups = [...front, ...Array(8 - count).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

// The four numbers of a dotted IPv4 address, or null when the text is not one. Going
// through numbers drops leading zeros, so "203.0.113.010" and "203.0.113.10" give one key.
function ipv4Octets(text) {
  if (!IPV4_RE.test(text)) return null;
  const octets = text.split(".").map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

// Same check as the upload Worker and the transcribe server: ask Supabase who the token
// belongs to, then read that user's tier from profiles (row level security lets a user
// read their own row). Any failure means the free plan.
async function resolveTier(request, env) {
  const anonymous = { tier: "free", userId: null };
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return anonymous;
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/);
  if (!m || !TOKEN_RE.test(m[1])) return anonymous;
  const token = m[1];

  const cacheKey = await sha256Hex(token);
  const now = Date.now();
  const hit = tierCache.get(cacheKey);
  if (hit && hit.until > now) return hit.value;
  tierCache.delete(cacheKey);

  let value = anonymous;
  let ttl = 0;
  try {
    const base = String(env.SUPABASE_URL).replace(/\/+$/, "");
    const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: "application/json" };
    const userRes = await fetch(`${base}/auth/v1/user`, { headers, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
    if (userRes.ok) {
      const user = await userRes.json();
      if (user && typeof user.id === "string" && UUID_RE.test(user.id)) {
        const profRes = await fetch(`${base}/rest/v1/profiles?id=eq.${user.id}&select=tier`, {
          headers,
          signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
        });
        if (profRes.ok) {
          const rows = await profRes.json();
          const tier = Array.isArray(rows) && rows[0] ? rows[0].tier : "free";
          value = { tier: PAID_TIERS.has(tier) ? tier : "free", userId: user.id };
          ttl = value.tier === "free" ? TIER_MISS_TTL_MS : TIER_TTL_MS;
        }
      }
    } else if (userRes.status === 401 || userRes.status === 403) {
      ttl = TIER_MISS_TTL_MS; // expired or invalid token
    }
  } catch {
    return anonymous; // Supabase unreachable or slow; do not cache
  }

  if (ttl > 0) {
    if (tierCache.size >= TIER_CACHE_MAX) tierCache.delete(tierCache.keys().next().value);
    tierCache.set(cacheKey, { value, until: now + ttl });
  }
  return value;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function chargeQuota(env, name, cost, limit) {
  return quotaCall(env, name, "charge", { cost, limit });
}

async function refundQuota(env, name, cost) {
  return quotaCall(env, name, "refund", { cost });
}

async function quotaCall(env, name, action, input) {
  const stub = env.QUOTA.get(env.QUOTA.idFromName(name));
  const res = await stub.fetch("https://quota.internal/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Quota counter failed (" + res.status + ")");
  return res.json();
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(ms) {
  return Math.max(1, Math.ceil((DAY_MS - (ms % DAY_MS)) / 1000));
}

/**
 * Daily usage counter. One instance per key (an IP, an account, or the free pool).
 * A Durable Object handles one request at a time per instance, so read, compare and
 * write cannot interleave and two parallel requests cannot both slip under the limit.
 * Reachable only through the QUOTA binding, never from the internet.
 */
export class Quota {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let input;
    try {
      input = await request.json();
    } catch {
      return quotaJson({ error: "Invalid JSON" }, 400);
    }
    const { cost, limit } = input || {};
    const refund = new URL(request.url).pathname === "/refund";
    if (!Number.isSafeInteger(cost) || cost <= 0) return quotaJson({ error: "Invalid charge" }, 400);
    if (!refund && (!Number.isSafeInteger(limit) || limit < 0)) return quotaJson({ error: "Invalid charge" }, 400);

    const now = Date.now();
    const today = utcDay(now);
    const stored = await this.state.storage.get("usage");
    const fresh = !stored || stored.day !== today;
    const used = fresh ? 0 : stored.used;

    // A refund gives back units charged earlier today. There is nothing to give back
    // once the day has rolled over.
    if (refund) {
      const left = Math.max(0, used - cost);
      if (!fresh) await this.state.storage.put("usage", { day: today, used: left });
      return quotaJson({ ok: true, used: left }, 200);
    }

    if (used + cost > limit) return quotaJson({ ok: false, used, limit }, 200);

    await this.state.storage.put("usage", { day: today, used: used + cost });
    if (fresh) await this.state.storage.setAlarm(now + 2 * DAY_MS);
    return quotaJson({ ok: true, used: used + cost, limit }, 200);
  }

  // Clears a counter that has gone unused, so an IP address does not stay on record.
  async alarm() {
    const stored = await this.state.storage.get("usage");
    if (stored && stored.day === utcDay(Date.now())) {
      await this.state.storage.setAlarm(Date.now() + 2 * DAY_MS);
      return;
    }
    await this.state.storage.deleteAll();
  }
}

function quotaJson(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
