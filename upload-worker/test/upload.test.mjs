// Checks that /sign-upload binds the declared size (and video Content-Type)
// into the presigned PUT. Supabase is a stubbed fetch, R2 a stub binding, and
// the signature is recomputed here with node:crypto, so nothing touches the
// network and no real keys are used.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import worker from "../upload.js";

const env = {
  R2_ACCOUNT_ID: "acct", R2_BUCKET: "bucket", R2_ACCESS_KEY_ID: "AKIDTEST", R2_SECRET_ACCESS_KEY: "test-secret",
  SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", ALLOWED_ORIGIN: "*",
  R2: { list: async () => ({ objects: [] }) },
};

let tier = "solo";
const realFetch = globalThis.fetch;
beforeEach(() => {
  tier = "solo";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
    if (u.includes("/rest/v1/profiles")) return Response.json([{ tier }]);
    throw new Error(`unexpected fetch ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const sign = (body) => worker.fetch(new Request("https://upload.test/sign-upload", {
  method: "POST",
  headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
  body: JSON.stringify(body),
}), env);

// Independent SigV4 query-signature check for the request the browser would send.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (k, m) => createHmac("sha256", k).update(m).digest();
function verify(uploadUrl, method, sentHeaders) {
  const u = new URL(uploadUrl);
  const q = [...u.searchParams].filter(([k]) => k !== "X-Amz-Signature").sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const get = (k) => u.searchParams.get(k);
  const names = get("X-Amz-SignedHeaders").split(";");
  const all = { host: u.host, ...sentHeaders };
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n] ?? "").trim()}\n`).join("");
  const canonical = [method, u.pathname, q.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"),
    canonicalHeaders, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const [, date, region, service] = get("X-Amz-Credential").split("/");
  const sts = ["AWS4-HMAC-SHA256", get("X-Amz-Date"), `${date}/${region}/${service}/aws4_request`,
    createHash("sha256").update(canonical).digest("hex")].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + env.R2_SECRET_ACCESS_KEY, date), region), service), "aws4_request");
  return hmac(key, sts).toString("hex") === get("X-Amz-Signature");
}

test("PUT URL binds Content-Length and video Content-Type", async () => {
  const size = 123_456_789;
  const r = await sign({ filename: "clip.mp4", contentType: "video/mp4", size });
  assert.equal(r.status, 200);
  const { uploadUrl, playbackUrl } = await r.json();
  assert.equal(new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
  assert.equal(verify(uploadUrl, "PUT", { "content-length": String(size), "content-type": "video/mp4" }), true);
  assert.equal(verify(uploadUrl, "PUT", { "content-length": String(size + 1), "content-type": "video/mp4" }), false);
  assert.equal(verify(uploadUrl, "PUT", { "content-length": String(size), "content-type": "text/html" }), false);
  // playback GET stays host-only so <video> and the transcribe server can fetch it
  assert.equal(new URL(playbackUrl).searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(verify(playbackUrl, "GET", {}), true);
});

test("untyped files sign Content-Length only", async () => {
  for (const contentType of ["application/octet-stream", "", undefined]) {
    const r = await sign({ filename: "clip.mkv", contentType, size: 1000 });
    assert.equal(r.status, 200, String(contentType));
    const { uploadUrl } = await r.json();
    assert.equal(new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
    assert.equal(verify(uploadUrl, "PUT", { "content-length": "1000" }), true);
    assert.equal(verify(uploadUrl, "PUT", { "content-length": "1001" }), false);
  }
});

test("bad content type, size and tier are refused", async () => {
  assert.equal((await sign({ filename: "clip.mp4", contentType: "text/html", size: 1000 })).status, 415);
  assert.equal((await sign({ filename: "page.html", contentType: "video/mp4", size: 1000 })).status, 415);
  assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 2 * 1024 ** 3 + 1 })).status, 413);
  assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 2 * 1024 ** 3 })).status, 200);
  for (const size of [1.5, 0, -5, "abc", null, undefined, [1000], 2 ** 60]) {
    assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size })).status, 400, String(size));
  }
  tier = "team";
  assert.equal((await sign({ filename: "clip.mov", contentType: "video/quicktime", size: 1000 })).status, 200);
  tier = "free";
  assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 1000 })).status, 402);
});

test("plan lookup failures answer 503, never 402", async () => {
  const user = () => Response.json({ id: "user-1" });
  const cases = {
    "auth network error": (u) => { throw new TypeError("fetch failed"); },
    "auth 500": (u) => new Response("oops", { status: 500 }),
    "profiles network error": (u) => { if (u.endsWith("/auth/v1/user")) return user(); throw new TypeError("fetch failed"); },
    "profiles 503": (u) => (u.endsWith("/auth/v1/user") ? user() : new Response("down", { status: 503 })),
    "profiles bad json": (u) => (u.endsWith("/auth/v1/user") ? user() : new Response("<html>", { status: 200 })),
    "profiles not an array": (u) => (u.endsWith("/auth/v1/user") ? user() : Response.json({ message: "x" })),
  };
  for (const [name, impl] of Object.entries(cases)) {
    globalThis.fetch = async (url) => impl(String(url));
    const r = await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 1000 });
    assert.equal(r.status, 503, name);
    assert.deepEqual(await r.json(), { error: "Couldn't check your plan. Try again in a moment." }, name);
  }
  // An expired token is still a sign-in problem, and no profile row is still free.
  globalThis.fetch = async () => new Response("", { status: 401 });
  assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 1000 })).status, 401);
  globalThis.fetch = async (url) => (String(url).endsWith("/auth/v1/user") ? user() : Response.json([]));
  assert.equal((await sign({ filename: "clip.mp4", contentType: "video/mp4", size: 1000 })).status, 402);
});
