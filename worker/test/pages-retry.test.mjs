// Offline unit tests for the retry/split logic that translate.html and index.html
// each keep inline in a classic <script> tag: translateError, requestBatch,
// requestWithRetry, translateBatch and translateLines. No network access happens
// here: fetch is a stub passed into a fresh node:vm context for every call, and
// all five functions are extracted from the real page source, never re-implemented
// in this file.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const PAGES = ["translate.html", "index.html"];
const PAGE_PATHS = {
  "translate.html": path.join(ROOT, "translate.html"),
  "index.html": path.join(ROOT, "index.html"),
};

// ---- Extraction: pull the five functions out of the real page source ----
// The bodies contain string, template and (one) regex literals, so a plain
// brace count would misfire on a brace inside a string. skipStringLiteral and
// skipTemplateLiteral let the brace matcher step over those safely.

function skipStringLiteral(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i++;
  }
  return i;
}

function skipTemplateLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") return i;
    if (source[i] === "$" && source[i + 1] === "{") {
      // Walk the ${...} expression, tracking its own brace depth and any
      // strings or nested template literals inside it.
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'") i = skipStringLiteral(source, i, c);
        else if (c === "`") i = skipTemplateLiteral(source, i);
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

// Extract a function declaration as literal source text, from the marker up to
// the matching closing brace of the function body. Tries "async function NAME("
// first, then falls back to a plain "function NAME(" (translateError is not async).
function extractFunction(source, name) {
  const asyncMarker = "async function " + name + "(";
  const plainMarker = "function " + name + "(";
  let start = source.indexOf(asyncMarker);
  if (start === -1) start = source.indexOf(plainMarker);
  if (start === -1) {
    throw new Error('could not find a function declaration for "' + name + '" in the page source');
  }

  // Walk the parameter list to its closing ")".
  let i = source.indexOf("(", start);
  let parenDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  while (source[i] !== "{") i++;

  // Walk the function body to its matching closing "}", skipping over
  // strings, template literals and comments so their braces are ignored.
  let braceDepth = 0;
  let j = i;
  for (; j < source.length; j++) {
    const ch = source[j];
    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        j++;
        break;
      }
    } else if (ch === '"' || ch === "'") {
      j = skipStringLiteral(source, j, ch);
    } else if (ch === "`") {
      j = skipTemplateLiteral(source, j);
    } else if (ch === "/" && source[j + 1] === "/") {
      const nl = source.indexOf("\n", j);
      j = nl === -1 ? source.length : nl;
    } else if (ch === "/" && source[j + 1] === "*") {
      const end = source.indexOf("*/", j + 2);
      j = end === -1 ? source.length : end + 1;
    }
  }
  if (braceDepth !== 0) {
    throw new Error('brace matching failed for function "' + name + '" (unbalanced braces)');
  }
  return source.slice(start, j);
}

function verifyParses(text, label) {
  try {
    // A function declaration is a valid statement in a function body, so this
    // throws a SyntaxError if the extracted text is not well-formed on its own.
    new Function(text);
  } catch (err) {
    throw new Error("extracted source for " + label + " does not parse: " + err.message);
  }
}

// Read each page once, extract and verify the five functions, and compile
// one reusable vm.Script per page. A fresh context is still created for
// every call, per the spec; only the parsed script itself is cached.
const pageScripts = {};
for (const page of PAGES) {
  const source = fs.readFileSync(PAGE_PATHS[page], "utf8");
  const translateErrorSrc = extractFunction(source, "translateError");
  const requestBatchSrc = extractFunction(source, "requestBatch");
  const requestWithRetrySrc = extractFunction(source, "requestWithRetry");
  const translateBatchSrc = extractFunction(source, "translateBatch");
  const translateLinesSrc = extractFunction(source, "translateLines");
  verifyParses(translateErrorSrc, page + ":translateError");
  verifyParses(requestBatchSrc, page + ":requestBatch");
  verifyParses(requestWithRetrySrc, page + ":requestWithRetry");
  verifyParses(translateBatchSrc, page + ":translateBatch");
  verifyParses(translateLinesSrc, page + ":translateLines");
  const combined = [translateErrorSrc, requestBatchSrc, requestWithRetrySrc, translateBatchSrc, translateLinesSrc].join(
    "\n"
  );
  pageScripts[page] = new vm.Script(combined, { filename: page + ":retry-functions" });
}

// ---- vm runtime: one fresh context per call, with a fetch stub and a fast setTimeout ----

// Build a fresh context for `page`, wire in `fetchStub`, and return the live
// translateError/requestBatch/requestWithRetry/translateBatch/translateLines
// functions plus the recorded setTimeout delays (the *requested* delay, not
// the shortened real wait).
function createPageRuntime(page, fetchStub) {
  const setTimeoutCalls = [];
  const sandbox = {
    DEMO: false,
    API_BASE: "https://worker.test",
    REQUEST_TIMEOUT_MS: 50,
    SPLIT_BUDGET: 12,
    BATCH_SIZE: 20,
    fetch: fetchStub,
    AbortController,
    clearTimeout: globalThis.clearTimeout,
    // Records the requested delay, then actually waits at most 5ms so tests run fast.
    setTimeout: (fn, delay, ...args) => {
      setTimeoutCalls.push(delay);
      return globalThis.setTimeout(() => fn(...args), Math.min(delay, 5));
    },
  };
  const context = vm.createContext(sandbox);
  pageScripts[page].runInContext(context);
  return {
    page,
    translateError: sandbox.translateError,
    requestBatch: sandbox.requestBatch,
    requestWithRetry: sandbox.requestWithRetry,
    translateBatch: sandbox.translateBatch,
    translateLines: sandbox.translateLines,
    setTimeoutCalls,
  };
}

// One adapter so every scenario can call translateBatch the same way on both pages.
function callTranslateBatch(runtime, texts, budget) {
  if (runtime.page === "translate.html") return runtime.translateBatch(texts, "auto", "de", budget);
  return runtime.translateBatch(texts, "de", budget);
}

// One adapter so every scenario can call translateLines the same way on both pages.
// translate.html also takes an onBatch progress callback; index.html does not.
function callTranslateLines(runtime, texts, lines, onBatch) {
  if (runtime.page === "translate.html") return runtime.translateLines(texts, "auto", "de", lines, onBatch);
  return runtime.translateLines(texts, "de", lines);
}

// ---- fetch stub ----
// handler(call, callNumber) returns a Response, a Promise, or throws to
// simulate a network error. Every call is recorded. callNumber is 1-based.
function makePageFetchStub(handler) {
  const calls = [];
  const urlErrors = [];
  const stub = async (url, init = {}) => {
    if (url !== "https://worker.test/translate") {
      // Recorded rather than thrown: throwing here would be swallowed by
      // requestBatch's own catch block and reported as a network error,
      // hiding the real problem.
      urlErrors.push(url);
    }
    const body = JSON.parse(init.body);
    const record = { size: body.cues.length, texts: body.cues, signal: init.signal };
    calls.push(record);
    return handler(record, calls.length);
  };
  stub.calls = calls;
  stub.urlErrors = urlErrors;
  return stub;
}

function assertNoUrlErrors(stub) {
  assert.deepEqual(stub.urlErrors, [], "fetch stub was called with an unexpected url");
}

function okResponse(translations) {
  return new Response(JSON.stringify({ translations }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function mismatchResponse() {
  return new Response(JSON.stringify({ error: "Translation count mismatch" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}
function statusResponse(status, bodyObj) {
  return new Response(JSON.stringify(bodyObj || {}), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function notJsonResponse() {
  return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
}

// A promise that never resolves on its own, and rejects with an AbortError
// once the given signal aborts. Used to simulate an upstream call that hangs.
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
// read hangs until the given signal aborts. requestBatch's timer covers the
// body read as well as the connection, so this should behave the same as a
// fully hung connection.
function stalledBody(signal) {
  return {
    ok: true,
    status: 200,
    json: () => hangUntilAborted(signal),
  };
}

const LINES20 = Array.from({ length: 20 }, (_, i) => "l" + (i + 1));
const perfectFor = (texts) => texts.map((t) => "T:" + t);

// ================= P1: all fine =================

for (const page of PAGES) {
  test(`P1 (${page}): every line translates in one request`, async () => {
    const stub = makePageFetchStub((call) => okResponse(perfectFor(call.texts)));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.equal(stub.calls.length, 1);
  });
}

// ================= P2: mismatch on the full batch, halves fine =================

async function runP2(page) {
  const stub = makePageFetchStub((call) => (call.size === 20 ? mismatchResponse() : okResponse(perfectFor(call.texts))));
  const runtime = createPageRuntime(page, stub);
  const budget = { left: 12 };
  const result = await callTranslateBatch(runtime, LINES20, budget);
  return { result, stub, budget };
}

for (const page of PAGES) {
  test(`P2 (${page}): mismatch on the 20-line request splits into two fine halves`, async () => {
    const { result, stub, budget } = await runP2(page);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 3);
    assert.deepEqual(stub.calls.map((c) => c.size), [20, 10, 10]);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.equal(budget.left, 10);
  });
}

// ================= P3: every request mismatches =================

for (const page of PAGES) {
  test(`P3 (${page}): every request mismatches, gives up with all nulls instead of throwing`, async () => {
    const stub = makePageFetchStub(() => mismatchResponse());
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 12 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(result.length, 20);
    assert.ok(result.every((r) => r === null), "expected every entry to be null");
    assert.ok(stub.calls.length <= 13, "expected at most 13 upstream calls, got " + stub.calls.length);
    assert.ok(budget.left >= 0, "expected budget.left to stay >= 0, got " + budget.left);
  });
}

// ================= P4: one bad pair =================

async function runP4(page) {
  const stub = makePageFetchStub((call) =>
    call.texts.includes("l7") && call.texts.includes("l8") ? mismatchResponse() : okResponse(perfectFor(call.texts))
  );
  const runtime = createPageRuntime(page, stub);
  const budget = { left: 12 };
  const result = await callTranslateBatch(runtime, LINES20, budget);
  return { result, stub, budget };
}

for (const page of PAGES) {
  test(`P4 (${page}): a request mismatches only when it holds both l7 and l8, everything still lands`, async () => {
    const { result, stub } = await runP4(page);
    assertNoUrlErrors(stub);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.ok(!result.some((r) => r === null), "expected no null entries");
    assert.ok(stub.calls.length <= 13, "expected at most 13 upstream calls, got " + stub.calls.length);
  });
}

// ================= P5: one line rejected even alone =================

async function runP5(page) {
  const stub = makePageFetchStub((call) => (call.texts.includes("l5") ? mismatchResponse() : okResponse(perfectFor(call.texts))));
  const runtime = createPageRuntime(page, stub);
  const budget = { left: 12 };
  const result = await callTranslateBatch(runtime, LINES20, budget);
  return { result, stub, budget };
}

for (const page of PAGES) {
  test(`P5 (${page}): a line that mismatches even alone comes back null, the rest land in order`, async () => {
    const { result, stub } = await runP5(page);
    assertNoUrlErrors(stub);
    assert.equal(result.length, 20);
    assert.equal(result[4], null);
    const expected = perfectFor(LINES20);
    for (let i = 0; i < result.length; i++) {
      if (i === 4) continue;
      assert.equal(result[i], expected[i], "mismatch at index " + i);
    }
  });
}

// ================= P6: budget 0, full-batch mismatch =================

for (const page of PAGES) {
  test(`P6 (${page}): budget.left is 0, one request, 20 nulls, does not throw`, async () => {
    const stub = makePageFetchStub(() => mismatchResponse());
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 0 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 1);
    assert.equal(result.length, 20);
    assert.ok(result.every((r) => r === null));
    assert.equal(budget.left, 0);
  });
}

// ================= P7: budget 1, full-batch mismatch (a split needs 2) =================

for (const page of PAGES) {
  test(`P7 (${page}): budget.left is 1, one request, 20 nulls, budget stays 1`, async () => {
    const stub = makePageFetchStub(() => mismatchResponse());
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 1 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 1);
    assert.equal(result.length, 20);
    assert.ok(result.every((r) => r === null));
    assert.equal(budget.left, 1);
  });
}

// ================= P8: 429 then fine =================

for (const page of PAGES) {
  test(`P8 (${page}): a 429 then a good answer, retried once, waits 4000ms`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? statusResponse(429) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.ok(runtime.setTimeoutCalls.includes(4000), "expected a recorded 4000ms wait, got " + runtime.setTimeoutCalls);
  });
}

// ================= P9: 429 twice =================

for (const page of PAGES) {
  test(`P9 (${page}): a 429 on both attempts rejects with the rate limit message`, async () => {
    const stub = makePageFetchStub(() => statusResponse(429));
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "Rate limit reached. Try again shortly."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P10: 500 then fine =================

for (const page of PAGES) {
  test(`P10 (${page}): a 500 then a good answer, retried once, waits 1200ms`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? statusResponse(500) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.ok(runtime.setTimeoutCalls.includes(1200), "expected a recorded 1200ms wait, got " + runtime.setTimeoutCalls);
  });
}

// ================= P11: 500 twice =================

for (const page of PAGES) {
  test(`P11 (${page}): a 500 on both attempts rejects with the translation failed message`, async () => {
    const stub = makePageFetchStub(() => statusResponse(500, { error: "Translation provider error" }));
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "Translation failed (500). Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P12: 400 and 413: no retry, straight to a hard error =================
// 422 is deliberately not tested here: the page now treats 422 as a split
// signal (see P20/P21 below), not a flat non-retryable failure.

for (const page of PAGES) {
  for (const status of [400, 413]) {
    test(`P12 (${page}, ${status}): a non-retryable status rejects after exactly one request`, async () => {
      const stub = makePageFetchStub(() => statusResponse(status));
      const runtime = createPageRuntime(page, stub);
      await assert.rejects(
        callTranslateBatch(runtime, LINES20, { left: 12 }),
        (err) => err.message === "Translation failed (" + status + "). Please try again."
      );
      assertNoUrlErrors(stub);
      assert.equal(stub.calls.length, 1);
    });
  }
}

// ================= P13: fetch rejects with a TypeError =================

for (const page of PAGES) {
  test(`P13 (${page}): fetch rejecting once then answering fine still completes`, async () => {
    const stub = makePageFetchStub((call, n) => {
      if (n === 1) throw new TypeError("Failed to fetch");
      return okResponse(perfectFor(call.texts));
    });
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
  });

  test(`P13 (${page}): fetch rejecting twice rejects with the connection message`, async () => {
    const stub = makePageFetchStub(() => {
      throw new TypeError("Failed to fetch");
    });
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "Couldn't reach the translation server. Check your connection and try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P14: hung upstream call =================

for (const page of PAGES) {
  test(`P14 (${page}): a hung call once then answering fine still completes`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? hangUntilAborted(call.signal) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
  });

  test(`P14 (${page}): a hung call twice rejects with the took-too-long message`, async () => {
    const stub = makePageFetchStub((call) => hangUntilAborted(call.signal));
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "The translation server took too long to answer. Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P15: 200 with a translations array one entry short =================

for (const page of PAGES) {
  test(`P15 (${page}): a 200 with one entry missing on the 20-line request is treated as a mismatch and splits`, async () => {
    const stub = makePageFetchStub((call) => {
      if (call.size === 20) return okResponse(perfectFor(call.texts).slice(0, -1));
      return okResponse(perfectFor(call.texts));
    });
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 3);
    assert.deepEqual(stub.calls.map((c) => c.size), [20, 10, 10]);
    assert.deepEqual(result, perfectFor(LINES20));
  });
}

// ================= P16: 200 with a body that is not JSON =================

for (const page of PAGES) {
  test(`P16 (${page}): a non-JSON 200 body once then a good answer still completes`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? notJsonResponse() : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
  });

  test(`P16 (${page}): a non-JSON 200 body twice rejects with the unexpected response message`, async () => {
    const stub = makePageFetchStub(() => notJsonResponse());
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "Unexpected response from the translation server. Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P17: mismatch inside a split, then a hard provider error =================

for (const page of PAGES) {
  test(`P17 (${page}): a mismatch on a single line followed by a provider error stays a hard error, not a null`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? mismatchResponse() : statusResponse(400)));
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, ["x"], { left: 12 }),
      (err) => err.message === "Translation failed (400). Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P18: parity between the two pages for translateBatch =================

test("P18 parity: P2 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP2(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

test("P18 parity: P4 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP4(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

test("P18 parity: P5 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP5(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

// ================= P19: a stalled response body is treated like a hung connection =================
// requestBatch's timer now also covers the body read, so a response whose
// headers arrive fine but whose json() call hangs should behave exactly like
// a fully hung connection: transient, retried once, then a hard failure.

for (const page of PAGES) {
  test(`P19 (${page}): a stalled response body once then answering fine still completes`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? stalledBody(call.signal) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
  });

  test(`P19 (${page}): a stalled response body twice rejects with the took-too-long message`, async () => {
    const stub = makePageFetchStub((call) => stalledBody(call.signal));
    const runtime = createPageRuntime(page, stub);
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, { left: 12 }),
      (err) => err.message === "The translation server took too long to answer. Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
  });
}

// ================= P20: a 422 on the full batch splits exactly like a count mismatch =================

for (const page of PAGES) {
  test(`P20 (${page}): a 422 on the 20-line request splits into two fine halves`, async () => {
    const stub = makePageFetchStub((call) => (call.size === 20 ? statusResponse(422) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 12 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 3);
    assert.deepEqual(stub.calls.map((c) => c.size), [20, 10, 10]);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.equal(budget.left, 10);
  });
}

// ================= P21: a 422 on every request gives up with all nulls =================

for (const page of PAGES) {
  test(`P21 (${page}): a 422 on every request gives up with all nulls instead of throwing`, async () => {
    const stub = makePageFetchStub(() => statusResponse(422));
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 12 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(result.length, 20);
    assert.ok(result.every((r) => r === null), "expected every entry to be null");
    assert.ok(stub.calls.length <= 13, "expected at most 13 upstream calls, got " + stub.calls.length);
    assert.ok(budget.left >= 0, "expected budget.left to stay >= 0, got " + budget.left);
  });
}

// ================= P22: budget 0, a transient 500 gets no retry either =================
// requestWithRetry's retry is paid from the same budget as a split, so
// budget.left < 1 also blocks the one extra attempt a 500 would normally get.

for (const page of PAGES) {
  test(`P22 (${page}): budget.left is 0, a persistent 500 gets no retry and rejects after one call`, async () => {
    const stub = makePageFetchStub(() => statusResponse(500, { error: "Translation provider error" }));
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 0 };
    await assert.rejects(
      callTranslateBatch(runtime, LINES20, budget),
      (err) => err.message === "Translation failed (500). Please try again."
    );
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 1);
    assert.equal(budget.left, 0);
  });
}

// ================= P23: a retry and repeated splits share one hard cap =================
// The first call spends the retry budget on a 500; every call after that
// mismatches. The 1 + SPLIT_BUDGET cap on total calls must still hold even
// though the budget was spent on a mix of a retry and splits.

for (const page of PAGES) {
  test(`P23 (${page}): a 500 that spends a retry, then persistent mismatches, still respects the call cap`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? statusResponse(500) : mismatchResponse()));
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 12 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(result.length, 20);
    assert.ok(result.every((r) => r === null), "expected every entry to be null");
    assert.ok(stub.calls.length <= 13, "expected at most 13 upstream calls, got " + stub.calls.length);
    assert.ok(budget.left >= 0, "expected budget.left to stay >= 0, got " + budget.left);
  });
}

// ================= P24: translateLines batches 45 lines into 20, 20, 5 =================

async function runP24(page) {
  const stub = makePageFetchStub((call) => okResponse(perfectFor(call.texts)));
  const runtime = createPageRuntime(page, stub);
  const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const r = await callTranslateLines(runtime, texts, lines);
  return { r, stub, lines, texts };
}

for (const page of PAGES) {
  test(`P24 (${page}): translateLines batches 45 lines into 20, 20, 5 and fills every line`, async () => {
    const { r, stub, lines, texts } = await runP24(page);
    assertNoUrlErrors(stub);
    assert.deepEqual(stub.calls.map((c) => c.size), [20, 20, 5]);
    assert.equal(r.translated, 45);
    assert.equal(r.missing, 0);
    assert.equal(r.error, null);
    assert.deepEqual(lines, perfectFor(texts));
  });
}

// ================= P25: a hard failure partway through translateLines =================

async function runP25(page) {
  const stub = makePageFetchStub((call, n) => (n === 1 ? okResponse(perfectFor(call.texts)) : statusResponse(400)));
  const runtime = createPageRuntime(page, stub);
  const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const r = await callTranslateLines(runtime, texts, lines);
  return { r, stub, lines, texts };
}

for (const page of PAGES) {
  test(`P25 (${page}): a hard failure on the second batch keeps the first batch's lines`, async () => {
    const { r, stub, lines, texts } = await runP25(page);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.equal(r.translated, 20);
    assert.equal(r.missing, 0);
    assert.ok(r.error, "expected an error to be returned");
    assert.equal(r.error.message, "Translation failed (400). Please try again.");
    assert.deepEqual(lines.slice(0, 20), perfectFor(texts.slice(0, 20)));
    assert.deepEqual(lines.slice(20), texts.slice(20).map(() => ""));
  });
}

// ================= P26: a hard failure on the very first batch =================

async function runP26(page) {
  const stub = makePageFetchStub(() => statusResponse(400));
  const runtime = createPageRuntime(page, stub);
  const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const r = await callTranslateLines(runtime, texts, lines);
  return { r, stub, lines, texts };
}

for (const page of PAGES) {
  test(`P26 (${page}): a hard failure on the very first batch leaves every line untranslated`, async () => {
    const { r, stub, lines, texts } = await runP26(page);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 1);
    assert.equal(r.translated, 0);
    assert.equal(r.missing, 0);
    assert.ok(r.error, "expected an error to be returned");
    assert.deepEqual(lines, texts.map(() => ""));
  });
}

// ================= P27: one line that always mismatches, inside translateLines =================

async function runP27(page) {
  const stub = makePageFetchStub((call) => (call.texts.includes("l5") ? mismatchResponse() : okResponse(perfectFor(call.texts))));
  const runtime = createPageRuntime(page, stub);
  const texts = Array.from({ length: 25 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const r = await callTranslateLines(runtime, texts, lines);
  return { r, stub, lines, texts };
}

for (const page of PAGES) {
  test(`P27 (${page}): one line that always mismatches comes back as a single missing entry, the run continues`, async () => {
    const { r, stub, lines, texts } = await runP27(page);
    assertNoUrlErrors(stub);
    assert.equal(r.translated, 24);
    assert.equal(r.missing, 1);
    assert.equal(r.error, null);
    assert.equal(lines[4], "");
    const expected = perfectFor(texts);
    for (let i = 0; i < texts.length; i++) {
      if (i === 4) continue;
      assert.equal(lines[i], expected[i], "mismatch at index " + i);
    }
  });
}

// ================= P28: each batch inside translateLines gets a fresh split budget =================

for (const page of PAGES) {
  test(`P28 (${page}): a second 20-line batch does not inherit the first batch's spent budget`, async () => {
    let sawSplit = false;
    let batch2StartIndex = -1;
    const stub = makePageFetchStub((call, n) => {
      if (call.size === 20 && sawSplit && batch2StartIndex === -1) batch2StartIndex = n - 1;
      if (call.size < 20) sawSplit = true;
      return mismatchResponse();
    });
    const runtime = createPageRuntime(page, stub);
    const texts = Array.from({ length: 40 }, (_, i) => "m" + (i + 1));
    const lines = texts.map(() => "");
    const r = await callTranslateLines(runtime, texts, lines);
    assertNoUrlErrors(stub);
    assert.equal(r.translated, 0);
    assert.equal(r.missing, 40);
    assert.equal(r.error, null);
    assert.notEqual(batch2StartIndex, -1, "expected a second size-20 call after the first batch started splitting");
    const batch2Sizes = stub.calls.slice(batch2StartIndex).map((c) => c.size);
    assert.ok(batch2Sizes.some((s) => s < 20), "expected the second batch to attempt splits too, got sizes " + batch2Sizes);
  });
}

// ================= P29: onBatch progress callback (translate.html only) =================
// index.html's translateLines has no onBatch parameter.

test("P29 (translate.html): onBatch fires once per batch with the running total translated", async () => {
  const stub = makePageFetchStub((call) => okResponse(perfectFor(call.texts)));
  const runtime = createPageRuntime("translate.html", stub);
  const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const progress = [];
  const r = await callTranslateLines(runtime, texts, lines, (done) => progress.push(done));
  assertNoUrlErrors(stub);
  assert.deepEqual(progress, [20, 40, 45]);
  assert.equal(r.translated, 45);
  assert.equal(r.missing, 0);
  assert.equal(r.error, null);
});

test("P29 (translate.html): onBatch does not fire for a batch that hard-fails", async () => {
  const stub = makePageFetchStub((call, n) => (n === 1 ? okResponse(perfectFor(call.texts)) : statusResponse(400)));
  const runtime = createPageRuntime("translate.html", stub);
  const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
  const lines = texts.map(() => "");
  const progress = [];
  const r = await callTranslateLines(runtime, texts, lines, (done) => progress.push(done));
  assertNoUrlErrors(stub);
  assert.deepEqual(progress, [20]);
  assert.equal(r.translated, 20);
  assert.ok(r.error, "expected an error to be returned");
});

// ================= P30: parity between the two pages for the translateLines scenarios =================

test("P30 parity: P24 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP24(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

test("P30 parity: P25 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP25(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

test("P30 parity: P27 request size sequence matches between translate.html and index.html", async () => {
  const sizes = {};
  for (const page of PAGES) {
    const { stub } = await runP27(page);
    sizes[page] = stub.calls.map((c) => c.size);
  }
  assert.deepEqual(sizes["translate.html"], sizes["index.html"]);
});

// ================= P31: a line declined with a 422 even alone =================

for (const page of PAGES) {
  test(`P31 (${page}): a line that gets a 422 even alone comes back null, the rest land in order`, async () => {
    const stub = makePageFetchStub((call) => (call.texts.includes("l7") ? statusResponse(422) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const result = await callTranslateBatch(runtime, LINES20, { left: 12 });
    assertNoUrlErrors(stub);
    const expected = perfectFor(LINES20);
    expected[6] = null;
    assert.deepEqual(result, expected);
    assert.ok(stub.calls.length <= 13, "expected at most 13 requests, got " + stub.calls.length);
  });
}

// ================= P32: the transient retry is paid from the budget =================

for (const page of PAGES) {
  test(`P32 (${page}): budget.left is 1, a 500 then a good answer completes and leaves the budget at 0`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? statusResponse(500) : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 1 };
    const result = await callTranslateBatch(runtime, LINES20, budget);
    assertNoUrlErrors(stub);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(result, perfectFor(LINES20));
    assert.equal(budget.left, 0);
    assert.deepEqual(runtime.setTimeoutCalls.filter((d) => d === 1200), [1200]);
  });
}

// ================= P33: the worst mix of failures stays inside the cap =================
// Every payload fails with a 500 the first time it is sent and with a count
// mismatch the second time, so each request costs a retry and then a split.

for (const page of PAGES) {
  test(`P33 (${page}): a 500 then a mismatch on every payload never exceeds 13 requests`, async () => {
    const seen = new Set();
    const stub = makePageFetchStub((call) => {
      const key = call.texts.join("|");
      if (!seen.has(key)) {
        seen.add(key);
        return statusResponse(500);
      }
      return mismatchResponse();
    });
    const runtime = createPageRuntime(page, stub);
    const budget = { left: 12 };
    let settled = "resolved";
    try {
      const result = await callTranslateBatch(runtime, LINES20, budget);
      assert.equal(result.length, 20);
    } catch (err) {
      settled = "rejected";
    }
    assertNoUrlErrors(stub);
    assert.ok(["resolved", "rejected"].includes(settled));
    assert.ok(stub.calls.length <= 13, "expected at most 13 requests, got " + stub.calls.length);
    assert.ok(budget.left >= 0, "expected budget.left to stay >= 0, got " + budget.left);
  });
}

// ================= P34: a server failure on the second batch, after its retry =================

for (const page of PAGES) {
  test(`P34 (${page}): a 500 on both attempts of batch 2 stops the run, keeps batch 1 and skips batch 3`, async () => {
    const stub = makePageFetchStub((call, n) => (n === 1 ? okResponse(perfectFor(call.texts)) : statusResponse(500)));
    const runtime = createPageRuntime(page, stub);
    const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
    const lines = texts.map(() => "KEEP");
    const r = await callTranslateLines(runtime, texts, lines);
    assertNoUrlErrors(stub);
    assert.deepEqual(stub.calls.map((c) => c.size), [20, 20, 20]);
    assert.deepEqual(stub.calls[2].texts, stub.calls[1].texts);
    assert.equal(r.translated, 20);
    assert.equal(r.missing, 0);
    assert.equal(r.error.reason, "Translation failed (500).");
    assert.equal(r.error.message, "Translation failed (500). Please try again.");
    assert.deepEqual(lines.slice(0, 20), perfectFor(texts.slice(0, 20)));
    assert.deepEqual(lines.slice(20), texts.slice(20).map(() => "KEEP"));
  });
}

// ================= P35: a line that could not be translated keeps what was in its box =================

for (const page of PAGES) {
  test(`P35 (${page}): a line that always mismatches leaves its entry untouched`, async () => {
    const stub = makePageFetchStub((call) => (call.texts.includes("l5") ? mismatchResponse() : okResponse(perfectFor(call.texts))));
    const runtime = createPageRuntime(page, stub);
    const texts = Array.from({ length: 45 }, (_, i) => "l" + (i + 1));
    const lines = texts.map(() => "KEEP");
    const r = await callTranslateLines(runtime, texts, lines);
    assertNoUrlErrors(stub);
    assert.equal(r.translated, 44);
    assert.equal(r.missing, 1);
    assert.equal(r.error, null);
    const expected = perfectFor(texts);
    expected[4] = "KEEP";
    assert.deepEqual(lines, expected);
  });
}
