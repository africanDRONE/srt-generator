// Unit tests for guard.mjs. DNS and fetch are stubbed; the only sockets opened
// are to the egress proxy on 127.0.0.1, and every request it gets is refused
// before it would dial out.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connect as netConnect } from "node:net";
import {
  GuardError, PlanCheckError, isBlockedIp, validateMediaUrl, startEgressGuard,
  tierFor, isSignedIn, authConfigWarnings, burnHeightFor, makeRateLimiter,
} from "../guard.mjs";

// Fake resolver: hostname -> list of addresses. Unknown names fail like ENOTFOUND.
const fakeDns = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const lookup = fakeDns({
  "media.example.com": ["93.184.216.34", "2606:2800:220:1::1"],
  "rebind.example.com": ["10.0.0.5"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
  "metadata.example.com": ["169.254.169.254"],
  "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
});

async function refused(url, pattern) {
  await assert.rejects(validateMediaUrl(url, { lookup }), (e) => {
    assert.ok(e instanceof GuardError, `expected GuardError for ${url}, got ${e}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

/* ---------- URL validator ---------- */

test("public host is accepted and normalized", async () => {
  const u = await validateMediaUrl("  https://media.example.com/clip.mp4?x=1 ", { lookup });
  assert.equal(u.href, "https://media.example.com/clip.mp4?x=1");
  const v = await validateMediaUrl("http://media.example.com:80/a", { lookup });
  assert.equal(v.href, "http://media.example.com/a"); // default port is dropped, so allowed
});

test("loopback, private, link-local and metadata IP literals are refused", async () => {
  for (const url of [
    "http://127.0.0.1/", "http://127.1.2.3/x", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://0.0.0.0/",
    "http://[::1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
  ]) await refused(url, /private or internal/);
});

test("numeric and hex IPv4 spellings are normalized and refused", async () => {
  await refused("http://2130706433/", /private or internal/);   // 127.0.0.1
  await refused("http://0x7f.0.0.1/", /private or internal/);
  await refused("http://0177.0.0.1/", /private or internal/);
});

test("hostnames resolving to internal addresses are refused", async () => {
  await refused("https://rebind.example.com/v.mp4", /private or internal/);
  await refused("https://mapped.example.com/v.mp4", /private or internal/);
  await refused("https://metadata.example.com/", /private or internal/);
  await refused("https://mixed.example.com/v.mp4", /private or internal/); // any bad answer taints the host
});

test("localhost and internal-only names are refused without a lookup", async () => {
  let called = false;
  const spy = async () => { called = true; return [{ address: "93.184.216.34", family: 4 }]; };
  for (const url of ["http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://intranet/",
    "http://printer.local/", "http://db.internal/", "http://nas.lan/", "http://router.home.arpa/"]) {
    await assert.rejects(validateMediaUrl(url, { lookup: spy }), /private or internal/);
  }
  assert.equal(called, false);
});

test("non-default ports are refused", async () => {
  await refused("https://media.example.com:8443/v.mp4", /non-standard ports/);
  await refused("http://media.example.com:443/v.mp4", /non-standard ports/);
  await refused("https://media.example.com:80/v.mp4", /non-standard ports/);
});

test("non-http schemes, credentials and junk are refused", async () => {
  await refused("file:///etc/passwd", /Only http and https/);
  await refused("ftp://media.example.com/v.mp4", /Only http and https/);
  await refused("gopher://media.example.com/", /Only http and https/);
  await refused("https://user:pw@media.example.com/v.mp4", /username or password/);
  await refused("not a url", /Valid url required/);
  await refused("", /Valid url required/);
  await refused("https://media.example.com/" + "a".repeat(9000), /Valid url required/);
  for (const bad of [undefined, null, 42, { href: "https://media.example.com/" }]) {
    await assert.rejects(validateMediaUrl(bad, { lookup }), /Valid url required/);
  }
});

test("unresolvable host gets a clear error", async () => {
  await refused("https://nope.example.org/v.mp4", /Could not resolve/);
});

test("isBlockedIp covers the special ranges and allows public addresses", () => {
  for (const ip of ["100.64.0.1", "224.0.0.1", "0.0.0.0", "255.255.255.255", "198.18.0.1",
    "fd00:ec2::254", "fe80::1%en0", "ff02::1", "::", "::ffff:169.254.169.254", "64:ff9b::a00:1", "::ffff:0:a00:1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
  assert.equal(isBlockedIp("not-an-ip"), true);
});

/* ---------- egress proxy ---------- */

function connectThrough(port, target) {
  return new Promise((resolve, reject) => {
    const s = netConnect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => { buf += d; });
    s.on("end", () => resolve(buf));
    s.on("close", () => resolve(buf));
    s.on("error", reject);
  });
}

test("egress proxy refuses internal and non-443 targets", async () => {
  const logs = [];
  const g = await startEgressGuard({ lookup, log: (m) => logs.push(m) });
  try {
    assert.match(await connectThrough(g.port, "169.254.169.254:443"), /^HTTP\/1\.1 403/);
    assert.match(await connectThrough(g.port, "rebind.example.com:443"), /^HTTP\/1\.1 403/);
    assert.match(await connectThrough(g.port, "[::1]:443"), /^HTTP\/1\.1 403/);
    assert.match(await connectThrough(g.port, "media.example.com:8443"), /^HTTP\/1\.1 403/);
    assert.match(await connectThrough(g.port, "media.example.com:22"), /^HTTP\/1\.1 403/);

    const status = (path) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: g.port, path }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject);
    });
    assert.equal(await status("http://169.254.169.254/latest/meta-data/"), 403);
    assert.equal(await status("http://localhost/"), 403);
    assert.equal(await status("http://media.example.com:8080/"), 403);
    assert.equal(await status("/not-a-proxy-request"), 403);
    assert.ok(logs.length >= 5);
  } finally {
    await g.close();
  }
});

/* ---------- plan checks ---------- */

const req = (auth) => ({ get: (h) => (h.toLowerCase() === "authorization" ? auth : undefined) });
const SB = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Stub Supabase: auth endpoint answers `auth`, profiles endpoint answers `prof`.
const fakeFetch = (auth, prof) => async (url) => {
  if (url.includes("/auth/v1/user")) { if (auth instanceof Error) throw auth; return auth; }
  if (url.includes("/rest/v1/profiles")) { if (prof instanceof Error) throw prof; return prof; }
  throw new Error(`unexpected fetch ${url}`);
};
const noFetch = async () => { throw new Error("fetch must not be called"); };

test("tierFor: unset config is free, DEV_ALLOW_ALL is the only way to all-team", async () => {
  assert.equal(await tierFor(req("Bearer anything"), { env: {}, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req(undefined), { env: {}, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req(undefined), { env: { DEV_ALLOW_ALL: "1" }, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req(undefined), { env: { DEV_ALLOW_ALL: "true" }, fetchImpl: noFetch }), "team");
});

test("tierFor: PRO_TOKEN must match exactly", async () => {
  const env = { PRO_TOKEN: "s3cret", DEV_ALLOW_ALL: "true" };
  assert.equal(await tierFor(req("Bearer s3cret"), { env, fetchImpl: noFetch }), "team");
  assert.equal(await tierFor(req("Bearer wrong"), { env, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req(undefined), { env, fetchImpl: noFetch }), "free");
});

test("tierFor: Supabase answers map to tiers", async () => {
  const user = reply(200, { id: "u1" });
  assert.equal(await tierFor(req(undefined), { env: SB, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req("Basic abc"), { env: SB, fetchImpl: noFetch }), "free");
  assert.equal(await tierFor(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(reply(401, {}), null) }), "free");
  assert.equal(await tierFor(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(user, reply(200, [{ tier: "solo" }])) }), "solo");
  assert.equal(await tierFor(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(user, reply(200, [{ tier: "team" }])) }), "team");
  assert.equal(await tierFor(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(user, reply(200, [])) }), "free");
  // DEV_ALLOW_ALL has no effect once Supabase is configured
  assert.equal(await tierFor(req(undefined), { env: { ...SB, DEV_ALLOW_ALL: "true" }, fetchImpl: noFetch }), "free");
});

test("tierFor: Supabase or network failure throws PlanCheckError (fail closed, never free)", async () => {
  const user = reply(200, { id: "u1" });
  const cases = [
    fakeFetch(new TypeError("fetch failed"), null),
    fakeFetch(reply(500, {}), null),
    fakeFetch(user, reply(503, {})),
    fakeFetch(user, new TypeError("socket hang up")),
    fakeFetch(user, reply(200, { message: "not an array" })),
    fakeFetch(user, { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }),
  ];
  for (const fetchImpl of cases) {
    await assert.rejects(tierFor(req("Bearer t"), { env: SB, fetchImpl }), PlanCheckError);
  }
});

test("isSignedIn follows the same fail-closed rules", async () => {
  assert.equal(await isSignedIn(req("Bearer t"), { env: {}, fetchImpl: noFetch }), false);
  assert.equal(await isSignedIn(req(undefined), { env: { DEV_ALLOW_ALL: "true" }, fetchImpl: noFetch }), true);
  assert.equal(await isSignedIn(req(undefined), { env: SB, fetchImpl: noFetch }), false);
  assert.equal(await isSignedIn(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(reply(200, { id: "u1" })) }), true);
  assert.equal(await isSignedIn(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(reply(403, {})) }), false);
  await assert.rejects(isSignedIn(req("Bearer t"), { env: SB, fetchImpl: fakeFetch(reply(502, {})) }), PlanCheckError);
});

test("authConfigWarnings flags risky config", () => {
  assert.match(authConfigWarnings({}).join("\n"), /FREE/);
  assert.match(authConfigWarnings({ DEV_ALLOW_ALL: "true" }).join("\n"), /TEAM/);
  assert.match(authConfigWarnings({ SUPABASE_URL: "x", DEV_ALLOW_ALL: "true" }).join("\n"), /ignored/);
  assert.match(authConfigWarnings({ SUPABASE_URL: "x" }).join("\n"), /SERVICE_ROLE_KEY/);
  assert.deepEqual(authConfigWarnings(SB), []);
  assert.deepEqual(authConfigWarnings({ PRO_TOKEN: "x" }), []);
});

/* ---------- burn height ---------- */

test("burnHeightFor: free is refused, paid tiers are capped", () => {
  assert.deepEqual(burnHeightFor("free", 720), { status: 402, error: "Pro required" });
  assert.deepEqual(burnHeightFor("solo", undefined), { height: 1080 });
  assert.deepEqual(burnHeightFor("solo", ""), { height: 1080 });
  assert.deepEqual(burnHeightFor("solo", 720), { height: 720 });
  assert.equal(burnHeightFor("solo", 1440).status, 402);
  assert.equal(burnHeightFor("solo", 2160).status, 402);
  assert.deepEqual(burnHeightFor("team", 2160), { height: 2160 });
  assert.deepEqual(burnHeightFor("team", "1440"), { height: 1440 });
  assert.equal(burnHeightFor("enterprise", 2160).status, 402); // unknown paid tier gets the Solo cap
});

test("burnHeightFor: only the listed heights are accepted", () => {
  for (const bad of [1000, 4320, 0, -1080, 1080.5, "abc", "1080p", NaN, Infinity, [1080], {}]) {
    assert.equal(burnHeightFor("team", bad).status, 400, String(bad));
  }
});

/* ---------- rate limit ---------- */

test("makeRateLimiter counts per key and resets after the window", () => {
  let t = 1_000_000;
  const hit = makeRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
  assert.equal(hit("a").ok, true);
  assert.equal(hit("a").ok, true);
  const third = hit("a");
  assert.equal(third.ok, false);
  assert.equal(third.retryAfterSec, 60);
  assert.equal(hit("b").ok, true); // other clients are unaffected
  t += 60_000;
  assert.equal(hit("a").ok, true);
});
