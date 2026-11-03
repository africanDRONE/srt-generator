// Test helpers for the translate.js request guard.
// No network calls happen here: installFetchStub replaces globalThis.fetch with a
// local router, and fakeQuotaNamespace emulates the Durable Object binding in memory.

// ---------------------------------------------------------------------------
// fakeStorage: a Map-backed stand-in for DurableObjectStorage.
// ---------------------------------------------------------------------------
export function fakeStorage() {
  const store = new Map();
  const self = {
    alarmAt: null,
    deleteAllCalls: 0,
    async get(key) {
      if (!store.has(key)) return undefined;
      return structuredClone(store.get(key));
    },
    async put(key, value) {
      store.set(key, structuredClone(value));
    },
    async deleteAll() {
      self.deleteAllCalls += 1;
      store.clear();
    },
    async setAlarm(ms) {
      self.alarmAt = ms;
    },
    async getAlarm() {
      return self.alarmAt;
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// fakeQuotaNamespace: emulates a Durable Object namespace bound to QuotaClass.
// One instance per name, calls to the same instance are serialised the way a
// real Durable Object would serialise them (one request at a time).
// ---------------------------------------------------------------------------
export function fakeQuotaNamespace(QuotaClass, options = {}) {
  const instances = new Map();
  const calls = [];

  function idFromName(name) {
    return { name };
  }

  function get(id) {
    const name = id.name;
    return {
      // Not async on purpose: the entry lookup and chain update below must run
      // synchronously so two calls for the same name can never both see a
      // missing entry and both create one.
      fetch(url, init) {
        let entry = instances.get(name);
        if (!entry) {
          const storage = fakeStorage();
          const object = new QuotaClass({ storage });
          entry = { object, storage, chain: Promise.resolve() };
          instances.set(name, entry);
        }

        const runTask = async () => {
          const req = new Request(url, init);
          let bodyText = "";
          try {
            bodyText = await req.clone().text();
          } catch {
            bodyText = "";
          }
          let bodyParsed = bodyText;
          try {
            bodyParsed = bodyText ? JSON.parse(bodyText) : null;
          } catch {
            // Keep the raw text if it was not JSON.
          }
          calls.push({ name, body: bodyParsed });

          // fail breaks every counter, failNames only the counters with those names.
          if (options.fail || (options.failNames || []).includes(name)) {
            throw new Error("Quota namespace failure (simulated)");
          }
          return entry.object.fetch(req);
        };

        const result = entry.chain.then(runTask, runTask);
        entry.chain = result.then(
          () => {},
          () => {}
        );
        return result;
      },
    };
  }

  return { idFromName, get, instances, calls };
}

// ---------------------------------------------------------------------------
// fakeRateLimiter / throwingRateLimiter: stand-ins for a Workers rate limit
// binding.
// ---------------------------------------------------------------------------
export function fakeRateLimiter(limit) {
  const counts = new Map();
  const calls = [];
  return {
    calls,
    async limit({ key }) {
      calls.push({ key });
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}

export function throwingRateLimiter() {
  return {
    calls: [],
    async limit() {
      throw new Error("rate limiter unavailable (simulated)");
    },
  };
}

// ---------------------------------------------------------------------------
// installFetchStub: replaces globalThis.fetch with a local router covering
// the Anthropic Messages endpoint and the two Supabase endpoints translate.js
// talks to. Any other URL throws, so a real network attempt fails loudly.
// ---------------------------------------------------------------------------
export function installFetchStub(config = {}) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async function stubFetch(input, init = {}) {
    const url = typeof input === "string" ? input : String(input.url || input);
    const headers = plainHeaders(init.headers);
    calls.push({ url, headers, body: typeof init.body === "string" ? init.body : null });

    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      return anthropicResponse(init);
    }
    if (url.startsWith("https://supabase.test/auth/v1/user")) {
      return supabaseUserResponse(headers, config);
    }
    if (url.startsWith("https://supabase.test/rest/v1/profiles")) {
      return supabaseProfilesResponse(url, config);
    }
    throw new Error("Unexpected fetch to " + url);
  };

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === "function" && typeof h.get === "function") {
    h.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(h)) out[key] = value;
  return out;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function anthropicResponse(init) {
  const body = JSON.parse(init.body);
  const userMsg = body.messages[0].content;
  const cueLines = userMsg.split("\n").filter((line) => /^\[\d+\]\s/.test(line));
  const n = cueLines.length;
  const itemType = body.output_config.format.schema.properties.translations.items.type;

  let translations;
  if (itemType === "object") {
    translations = Array.from({ length: n }, (_, i) => ({ n: i + 1, text: "T" + (i + 1) }));
  } else {
    translations = Array.from({ length: n }, (_, i) => "T" + (i + 1));
  }

  const anthropicBody = {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ translations }) }],
  };
  return new Response(JSON.stringify(anthropicBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function supabaseUserResponse(headers, config) {
  const users = config.users || {};
  const auth = headerValue(headers, "authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)$/);
  const token = m ? m[1] : null;
  const entry = token !== null ? users[token] : undefined;

  if (entry === undefined) {
    return new Response(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (entry === "throw") {
    throw new Error("Simulated Supabase network failure");
  }
  if (typeof entry === "number") {
    return new Response(JSON.stringify({ error: "supabase error" }), {
      status: entry,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(entry), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function supabaseProfilesResponse(url, config) {
  if (config.profilesStatus) {
    return new Response(JSON.stringify([]), {
      status: config.profilesStatus,
      headers: { "content-type": "application/json" },
    });
  }
  const parsed = new URL(url);
  const idParam = parsed.searchParams.get("id") || "";
  const match = idParam.match(/^eq\.(.+)$/);
  const id = match ? match[1] : null;
  const tiers = config.tiers || {};
  const tier = id ? tiers[id] : undefined;
  const rows = tier ? [{ tier }] : [];
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// baseEnv: the default set of env bindings, with an override mechanism where
// an explicit `undefined` value removes the key entirely.
// ---------------------------------------------------------------------------
export function baseEnv(QuotaClass, overrides = {}) {
  const env = {
    ANTHROPIC_API_KEY: "test-key-not-real",
    MODEL: "claude-haiku-4-5",
    ALLOWED_ORIGIN:
      "https://subcaptions.com,https://www.subcaptions.com,https://subcaptions.johnnie-miller.workers.dev",
    ALLOW_LOCALHOST: "true",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "anon-test-not-real",
    QUOTA: fakeQuotaNamespace(QuotaClass),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// makeRequest: builds a Request against the worker's fetch handler.
// ---------------------------------------------------------------------------
export function makeRequest(options = {}) {
  const {
    path = "/translate",
    method = "POST",
    origin = "https://subcaptions.com",
    ip = "203.0.113.10",
    token,
    authorization,
    body = { source: "auto", target: "es", cues: ["Hello there", "How are you?"] },
  } = options;

  const headers = { "Content-Type": "application/json" };
  if (origin !== null) headers["Origin"] = origin;
  if (ip !== null) headers["CF-Connecting-IP"] = ip;
  if (authorization !== undefined) {
    headers["Authorization"] = authorization;
  } else if (token !== undefined) {
    headers["Authorization"] = "Bearer " + token;
  }

  const init = { method, headers };
  if (method !== "GET" && method !== "OPTIONS") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return new Request("https://worker.test" + path, init);
}

// ---------------------------------------------------------------------------
// uniqueToken: a fresh token on every call, so the module-level plan cache in
// translate.js never leaks a result from one test into another.
// ---------------------------------------------------------------------------
let tokenCounter = 0;

export function uniqueToken(label) {
  tokenCounter += 1;
  const base = String(label || "tok").replace(/[^A-Za-z0-9._-]/g, "") || "tok";
  const unique = base + "." + tokenCounter.toString(36) + "." + Math.random().toString(36).slice(2);
  if (unique.length >= 24) return unique;
  return unique + "-".repeat(24 - unique.length);
}
