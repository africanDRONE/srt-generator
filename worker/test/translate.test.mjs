// Offline unit tests for the Subtitle Translator Cloudflare Worker.
// No network access happens here: globalThis.fetch is stubbed in every test
// and restored right after, and the only "key" used is the dummy "test-key".

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../translate.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

function baseEnv(overrides = {}) {
  return {
    ANTHROPIC_API_KEY: "test-key",
    MODEL: "claude-haiku-4-5",
    ALLOWED_ORIGIN: "*",
    MAX_CUES: "60",
    ...overrides,
  };
}

function makeRequest({ method = "POST", body } = {}) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = body;
  return new Request("https://worker.test/translate", init);
}

function postCues({ source = "auto", target = "de", cues }) {
  return makeRequest({ body: JSON.stringify({ source, target, cues }) });
}

// Stub factory for globalThis.fetch. handler(call, callIndex) returns a
// Response, or throws to simulate a network error. Every call is recorded,
// and any URL other than the Anthropic endpoint is a hard failure.
function makeFetchStub(handler) {
  const calls = [];
  const stub = async (url, init = {}) => {
    if (url !== ENDPOINT) {
      throw new Error("unexpected fetch url: " + url);
    }
    const body = JSON.parse(init.body);
    const record = { url, headers: init.headers || {}, body, signal: init.signal };
    calls.push(record);
    return handler(record, calls.length);
  };
  stub.calls = calls;
  return stub;
}

// Parse the numbered entries out of an upstream call's user message.
function parseEntries(call) {
  const content = call.body.messages[0].content;
  const entries = [];
  for (const line of content.split("\n")) {
    const m = /^\[(\d+)\] (.*)$/.exec(line);
    if (m) entries.push({ n: Number(m[1]), text: m[2] });
  }
  return entries;
}

// Build a correct items array (n = 1..count, text = "T:" + source text)
// for whatever cues a given upstream call contained.
function perfect(call) {
  return parseEntries(call).map((e) => ({ n: e.n, text: "T:" + e.text }));
}

// Build a successful upstream Response carrying the given items.
function upstreamOk(items) {
  return new Response(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ translations: items }) }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// A promise that never resolves on its own, and rejects with an AbortError
// once the given signal aborts. Used to simulate an upstream call that hangs
// before the response headers ever arrive.
function hangUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);
  });
}

// A response whose headers arrive right away (ok, status 200) but whose body
// read stalls until the given signal aborts. Used to simulate the case the
// Worker's timer now also has to cover: json() stalling after a good status line.
function stalledBody(signal) {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal && signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort);
      }),
  };
}

const originalFetch = globalThis.fetch;

async function withStub(stub, fn) {
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- 1. Happy path ----

test("happy path: 3 cues, perfect upstream, returns translations in order", async () => {
  const stub = makeFetchStub((call) => upstreamOk(perfect(call)));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a", "b", "c"] }), baseEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a", "T:b", "T:c"]);
    assert.equal(stub.calls.length, 1);

    const call = stub.calls[0];
    assert.equal(call.headers["x-api-key"], "test-key");
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    assert.equal(call.body.model, "claude-haiku-4-5");
    assert.equal(call.body.output_config.format.type, "json_schema");
    const items = call.body.output_config.format.schema.properties.translations.items;
    assert.equal(items.properties.n.type, "integer");
    assert.equal(items.properties.text.type, "string");
  });
});

// ---- 2. Out of order items ----

test("items returned out of order are placed back in input order", async () => {
  const stub = makeFetchStub((call) => {
    const items = perfect(call); // [n=1, n=2, n=3]
    return upstreamOk([items[1], items[0], items[2]]); // 2, 1, 3
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a", "b", "c"] }), baseEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a", "T:b", "T:c"]);
  });
});

// ---- 3. Line break marker ----

test("line break marker is sent on the wire and restored on the way back", async () => {
  let sentMessage = "";
  const stub = makeFetchStub((call) => {
    sentMessage = call.body.messages[0].content;
    return upstreamOk([{ n: 1, text: "eins ⏎ zwei" }]);
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["line one\nline two"] }), baseEnv());
    assert.ok(sentMessage.includes("[1] line one ⏎ line two"), "sent message: " + sentMessage);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["line one\nline two".replace("line one\nline two", "eins\nzwei")]);
  });
});

// ---- 4. Mismatch variants, each a 502 after exactly one upstream call ----
// The Worker no longer splits a batch or retries after a mismatch. Any
// alignment failure (wrong count, duplicate n, n out of range, n not an
// integer, text not a string, empty text for a cue that had text) answers
// with the same stable error string after exactly one call to Anthropic.

const mismatchCases = [
  ["wrong count, too few items", (call) => perfect(call).slice(0, -1)],
  [
    "wrong count, too many items",
    (call) => {
      const items = perfect(call);
      return items.concat([{ n: items.length + 1, text: "T:extra" }]);
    },
  ],
  ["duplicate n", () => [{ n: 1, text: "T:x" }, { n: 1, text: "T:y" }]],
  ["n out of range", () => [{ n: 1, text: "T:x" }, { n: 3, text: "T:y" }]],
  ["n not an integer", () => [{ n: 1, text: "T:x" }, { n: 2.5, text: "T:y" }]],
  ["text not a string", () => [{ n: 1, text: 123 }, { n: 2, text: "T:y" }]],
  ["empty text for a cue that had text", () => [{ n: 1, text: "" }, { n: 2, text: "T:y" }]],
];

for (const [label, buildItems] of mismatchCases) {
  test("mismatch (" + label + ") answers 502 after exactly one upstream call", async () => {
    const stub = makeFetchStub((call) => upstreamOk(buildItems(call)));
    await withStub(stub, async () => {
      const res = await worker.fetch(postCues({ cues: ["x", "y"] }), baseEnv());
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.deepEqual(body, { error: "Translation count mismatch" });
      assert.equal(stub.calls.length, 1);
    });
  });
}

// ---- 5. Persistent 429 ----

test("upstream 429 on every attempt returns 429 to the browser", async () => {
  const stub = makeFetchStub(() => new Response("{}", { status: 429 }));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "Rate limited upstream");
    assert.equal(stub.calls.length, 3);
  });
});

// ---- 6. 500 then success ----

test("upstream 500 then a good answer succeeds on retry", async () => {
  let callCount = 0;
  const stub = makeFetchStub((record) => {
    callCount++;
    if (callCount === 1) return new Response("{}", { status: 500 });
    return upstreamOk(perfect(record));
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a"]);
    assert.equal(stub.calls.length, 2);
  });
});

// ---- 7. Non-retryable 400 ----

test("upstream 400 is a non-retryable provider error", async () => {
  const stub = makeFetchStub(() => new Response("{}", { status: 400 }));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Translation provider error");
    assert.equal(body.status, 400);
    assert.equal(stub.calls.length, 1);
  });
});

// ---- 8. Network error every time ----

test("fetch throwing on every attempt returns an upstream request failed error", async () => {
  const stub = makeFetchStub(() => {
    throw new Error("network down");
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Upstream request failed");
    assert.equal(stub.calls.length, 3);
  });
});

// ---- 9. Refusal ----

test("refusal stop reason returns 422", async () => {
  const stub = makeFetchStub(
    () =>
      new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 422);
  });
});

// ---- 10. Invalid JSON text block ----

test("upstream 200 with an invalid JSON text block returns could not parse translation", async () => {
  const stub = makeFetchStub(
    () =>
      new Response(
        JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "not json{" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Could not parse translation");
    assert.equal(stub.calls.length, 1);
  });
});

// ---- 11. Request validation, no upstream call in any of these ----

function noUpstreamStub() {
  return makeFetchStub(() => {
    throw new Error("upstream should not be called");
  });
}

test("OPTIONS returns 204 with the CORS header", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const res = await worker.fetch(makeRequest({ method: "OPTIONS" }), baseEnv());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(stub.calls.length, 0);
  });
});

test("GET returns 405", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const res = await worker.fetch(makeRequest({ method: "GET" }), baseEnv());
    assert.equal(res.status, 405);
    assert.equal(stub.calls.length, 0);
  });
});

test("invalid JSON body returns 400", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const res = await worker.fetch(makeRequest({ body: "{not valid json" }), baseEnv());
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  });
});

test("empty cues array returns 400", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: [] }), baseEnv());
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  });
});

test("missing target returns 400", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const req = makeRequest({ body: JSON.stringify({ source: "auto", cues: ["a"] }) });
    const res = await worker.fetch(req, baseEnv());
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  });
});

test("61 cues returns 413", async () => {
  const stub = noUpstreamStub();
  const cues = Array.from({ length: 61 }, (_, i) => "cue" + i);
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues }), baseEnv());
    assert.equal(res.status, 413);
    assert.equal(stub.calls.length, 0);
  });
});

test("missing ANTHROPIC_API_KEY returns 500", async () => {
  const stub = noUpstreamStub();
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ ANTHROPIC_API_KEY: undefined })
    );
    assert.equal(res.status, 500);
    assert.equal(stub.calls.length, 0);
  });
});

// ---- 12. CORS header on success and error responses ----

test("CORS header present on a 200 response", async () => {
  const stub = makeFetchStub((call) => upstreamOk(perfect(call)));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });
});

test("CORS header present on a 502 response", async () => {
  const stub = makeFetchStub(() => new Response("{}", { status: 400 }));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });
});

// ---- 13. Non-string cues ----

test("non-string cues are stringified before translation and do not crash the worker", async () => {
  let sentMessage = "";
  const stub = makeFetchStub((call) => {
    sentMessage = call.body.messages[0].content;
    return upstreamOk(perfect(call));
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: [42, null, { a: 1 }, "ok"] }), baseEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.translations.length, 4);
    assert.deepEqual(body.translations, ["T:42", "T:null", "T:[object Object]", "T:ok"]);
    assert.ok(sentMessage.includes("[1] 42"), "sent message: " + sentMessage);
  });
});

// ---- 14. Every upstream call carries an abort signal ----

test("every upstream call receives an AbortSignal", async () => {
  const stub = makeFetchStub((call) => upstreamOk(perfect(call)));
  await withStub(stub, async () => {
    const res = await worker.fetch(postCues({ cues: ["a"] }), baseEnv());
    assert.equal(res.status, 200);
    assert.ok(stub.calls[0].signal instanceof AbortSignal, "expected an AbortSignal on the first call");
  });
});

// ---- 15. A hung upstream call is aborted, then a retry succeeds ----

test("a hung upstream call is aborted by UPSTREAM_TIMEOUT_MS and the retry succeeds", async () => {
  const stub = makeFetchStub((call, n) => {
    if (n === 1) return hangUntilAborted(call.signal);
    return upstreamOk(perfect(call));
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "50", DEADLINE_MS: "5000" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a"]);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].signal.aborted, true);
  });
});

// ---- 16. Every upstream call hangs ----

test("every upstream call hanging past UPSTREAM_TIMEOUT_MS gives up with upstream request failed", async () => {
  const stub = makeFetchStub((call) => hangUntilAborted(call.signal));
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "50", DEADLINE_MS: "5000" })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Upstream request failed");
    assert.equal(stub.calls.length, 3);
  });
});

// ---- 17. Stalled response body: the timer now also covers reading json() ----
// callAnthropic's timer no longer just covers waiting for headers, it covers
// the whole call including the body read, so a response whose headers arrive
// fine but whose json() stalls is aborted and counted as a failed attempt.

test("a stalled response body on every attempt is aborted and gives up with upstream request failed after 3 calls", async () => {
  const stub = makeFetchStub((call) => stalledBody(call.signal));
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "30", DEADLINE_MS: "5000" })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Upstream request failed");
    assert.equal(stub.calls.length, 3);
  });
});

test("a stalled response body with a short deadline allows only one call before giving up", async () => {
  const stub = makeFetchStub((call) => stalledBody(call.signal));
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "30", DEADLINE_MS: "100" })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Upstream request failed");
    assert.equal(stub.calls.length, 1);
  });
});

test("a stalled response body on the first attempt, then a good answer, succeeds after 2 calls", async () => {
  const stub = makeFetchStub((call, n) => {
    if (n === 1) return stalledBody(call.signal);
    return upstreamOk(perfect(call));
  });
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "30", DEADLINE_MS: "5000" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a"]);
    assert.equal(stub.calls.length, 2);
  });
});

// ---- 18. Invalid env values fall back to defaults ----

test("invalid UPSTREAM_TIMEOUT_MS and DEADLINE_MS values fall back to their defaults", async () => {
  const stub = makeFetchStub((call) => upstreamOk(perfect(call)));
  await withStub(stub, async () => {
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "abc", DEADLINE_MS: "-5" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.translations, ["T:a"]);
  });
});

// ---- 19. The pause between attempts never runs past the deadline ----

test("hung upstream calls: the Worker answers before the deadline and skips a pause that would pass it", async () => {
  const stub = makeFetchStub((call) => hangUntilAborted(call.signal));
  await withStub(stub, async () => {
    const started = Date.now();
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "50", DEADLINE_MS: "700" })
    );
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Upstream request failed");
    // Call 1 (50 ms), pause (500 ms), call 2 (50 ms). The second pause (1000 ms) would
    // pass the deadline, so the Worker answers right after call 2.
    assert.equal(stub.calls.length, 2);
    assert.ok(elapsed < 750, `answered after ${elapsed} ms, deadline was 700 ms`);
  });
});

test("fast 500 answers: the Worker answers before the deadline and skips a pause that would pass it", async () => {
  const stub = makeFetchStub(() => new Response("{}", { status: 500 }));
  await withStub(stub, async () => {
    const started = Date.now();
    const res = await worker.fetch(
      postCues({ cues: ["a"] }),
      baseEnv({ UPSTREAM_TIMEOUT_MS: "50", DEADLINE_MS: "700" })
    );
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Translation provider error");
    assert.equal(stub.calls.length, 2);
    assert.ok(elapsed < 750, `answered after ${elapsed} ms, deadline was 700 ms`);
  });
});
