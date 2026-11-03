// Offline tests for the free line limit in translate.html: it applies to signed-out and Free
// users only, waits for a plan that is still loading, never redirects, and links to /pricing.
// The page's own inline script runs in node:vm with a stubbed DOM, a stubbed window.SubAuth
// and a stubbed fetch, as in pages-columns.test.mjs. No network access happens here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HTML = fs.readFileSync(fileURLToPath(new URL("../../translate.html", import.meta.url)), "utf8");

function fakeElement() {
  const classes = new Set();
  return {
    style: {}, dataset: {}, textContent: "", innerHTML: "", value: "", disabled: false,
    scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
    selectedOptions: [{ textContent: "German" }],
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    closest: () => null, click() {}, focus() {}, scrollBy() {},
  };
}

// Runs the inline script up to its init block. subAuth is window.SubAuth (undefined while
// lib/auth.js has not loaded). emit() fires a "subauth" event the way lib/auth.js does.
function loadPage(count, subAuth) {
  const start = HTML.indexOf("<script>\n");
  const end = HTML.indexOf("(function init(){", start);
  assert.ok(start !== -1 && end !== -1, "inline script not found in translate.html");
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const listeners = [];
  const location = { href: "", search: "" };
  const sandbox = {
    console, clearTimeout, AbortController, URLSearchParams, location,
    // Waits are cut to 5 ms so the tests run fast.
    setTimeout: (fn, ms, ...rest) => setTimeout(fn, Math.min(ms, 5), ...rest),
    fetch: async () => { throw new Error("no fetch stub set for this test"); },
    document: {
      getElementById, querySelectorAll: () => [], querySelector: () => null, createElement: () => fakeElement(),
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i !== -1) listeners.splice(i, 1); },
    },
  };
  sandbox.window = sandbox;
  if (subAuth) sandbox.SubAuth = subAuth;
  const context = vm.createContext(sandbox);
  new vm.Script(HTML.slice(start + "<script>\n".length, end), { filename: "translate.html" }).runInContext(context);
  new vm.Script(`cues = ${JSON.stringify(Array.from({ length: count }, (_, i) => ({ text: "line" + i, start: i, end: i + 1 })))}; langCols = [];`).runInContext(context);
  getElementById("tgt-lang").value = "de";
  getElementById("translate-btn").textContent = "+ Add translation";
  const toasts = [];
  context.toast = (msg, type, link) => toasts.push({ msg, type, link });
  let calls = 0;
  context.fetch = async (_url, opts) => { calls++; const cues = JSON.parse(opts.body).cues; return { ok: true, status: 200, json: async () => ({ translations: cues.map((t) => "TR:" + t) }) }; };
  return {
    context, toasts, location, getElementById,
    calls: () => calls,
    cols: () => JSON.parse(new vm.Script("JSON.stringify(langCols)").runInContext(context)),
    emit: () => listeners.filter((l) => l.type === "subauth").forEach((l) => l.fn()),
  };
}

test("L1: a signed-out user over 200 lines is refused with a lasting note and a pricing link, no redirect", async () => {
  const page = loadPage(201, { user: null, tier: "free" });
  await page.context.addTranslation();
  assert.equal(page.calls(), 0);
  assert.equal(page.location.href, "");
  assert.deepEqual(page.cols(), []);
  const last = page.toasts.at(-1);
  assert.equal(last.msg, "This file has 201 lines, and the free limit is 200 lines per file.");
  assert.equal(last.type, "error");
  assert.equal(last.link.href, "/pricing");
  const note = page.getElementById("limit-note");
  assert.ok(note.classList.contains("warn"));
  assert.match(note.innerHTML, /<strong>201<\/strong> lines, and the free limit is 200 lines per file/);
  assert.match(note.innerHTML, /href="\/pricing"/);
  assert.match(note.innerHTML, /data-account/); // signed out, so it offers sign-in too
  assert.equal(page.getElementById("translate-btn").disabled, false);
});

test("L2: Solo and Team users translate a file over 200 lines", async () => {
  for (const tier of ["solo", "team"]) {
    const page = loadPage(450, { user: { id: "u1" }, tier });
    await page.context.addTranslation();
    assert.ok(page.calls() > 0, tier);
    assert.equal(page.cols()[0].lines.length, 450);
    assert.ok(page.cols()[0].lines.every((l, i) => l === "TR:line" + i), tier);
    assert.deepEqual(page.toasts.at(-1), { msg: "German added", type: "success", link: undefined });
    page.context.updateLimitNote();
    assert.ok(!page.getElementById("limit-note").classList.contains("warn"), tier);
  }
});

test("L3: a signed-in user whose plan is still loading waits for it, then translates as Solo", async () => {
  const auth = { user: { id: "u1" }, tier: "free" };
  const page = loadPage(201, auth);
  const run = page.context.addTranslation();
  assert.equal(page.getElementById("translate-btn").textContent, "Checking your plan…");
  auth.tier = "solo";
  page.emit();
  await run;
  assert.ok(page.calls() > 0);
  assert.equal(page.cols()[0].lines.length, 201);
  assert.equal(page.toasts.at(-1).type, "success");
  assert.equal(page.getElementById("translate-btn").textContent, "+ Add translation");
});

test("L4: a signed-in user who stays on Free is refused after the wait, with no sign-in link", async () => {
  const page = loadPage(201, { user: { id: "u1" }, tier: "free" });
  await page.context.addTranslation();
  assert.equal(page.calls(), 0);
  assert.equal(page.toasts.at(-1).link.href, "/pricing");
  const note = page.getElementById("limit-note").innerHTML;
  assert.match(note, /href="\/pricing"/);
  assert.doesNotMatch(note, /data-account/);
  assert.equal(page.getElementById("translate-btn").textContent, "+ Add translation");
});

test("L5: a free user with exactly 200 lines is not limited", async () => {
  const page = loadPage(200, { user: null, tier: "free" });
  await page.context.addTranslation();
  assert.equal(page.cols()[0].lines.length, 200);
  assert.equal(page.toasts.at(-1).type, "success");
});

test("L6: a plan-limit error from the Worker links to /pricing; other errors do not", async () => {
  const quota = loadPage(5, { user: null, tier: "free" });
  quota.context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ code: "daily_quota", error: "Daily free translation limit reached. It resets at midnight UTC. A paid plan has a higher limit." }) });
  await quota.context.addTranslation();
  assert.equal(quota.toasts.at(-1).msg, "Daily free translation limit reached. It resets at midnight UTC. A paid plan has a higher limit.");
  assert.equal(quota.toasts.at(-1).link.href, "/pricing");

  const pool = loadPage(5, { user: null, tier: "free" });
  pool.context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ code: "free_pool", error: "Free translation is at capacity for today." }) });
  await pool.context.addTranslation();
  assert.equal(pool.toasts.at(-1).link.href, "/pricing");

  const broken = loadPage(5, { user: null, tier: "free" });
  broken.context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Translation provider error" }) });
  await broken.context.addTranslation();
  assert.equal(broken.toasts.at(-1).link, undefined);
});

test("L7: the drop zone hint matches the plan", () => {
  const free = loadPage(1, { user: null, tier: "free" });
  free.context.updateHint();
  assert.equal(free.getElementById("dz-hint").textContent, ".srt and .vtt, up to 200 lines on Free, no line limit on Solo and Team");
  const team = loadPage(1, { user: { id: "u1" }, tier: "team" });
  team.context.updateHint();
  assert.equal(team.getElementById("dz-hint").textContent, ".srt and .vtt, no line limit on your Team plan");
});
