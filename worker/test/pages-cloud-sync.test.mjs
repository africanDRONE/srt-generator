// Offline tests for the editor's account saves and translator saves in index.html:
// the updated_at version sent back as base_updated_at, what a 409 does, the error
// messages, the translator save retry schedule, the share link list, the Frame.io
// transcription URL and the hero video pause. The page's inline script runs in node:vm
// with a stubbed DOM, fake timers and a scripted fetch. No network access.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HTML = fs.readFileSync(ROOT + "index.html", "utf8");
const SOURCE = (() => {
  const start = HTML.indexOf("<script>\n");
  const end = HTML.indexOf("(function init(){", start);
  assert.ok(start !== -1 && end !== -1, "inline script not found in index.html");
  return HTML.slice(start + "<script>\n".length, end);
})();

// Versions as Postgres returns them, with microseconds a Date would drop.
const V1 = "2026-11-03T10:00:00.123456+00:00";
const V2 = "2026-11-03T10:00:05.000001+00:00";
const V3 = "2026-11-03T10:00:09.999999+00:00";
const API = "https://subcaptions.onrender.com";

function fakeElement(tag = "div") {
  const classes = new Set();
  const attrs = {};
  const found = {};
  const el = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], parentNode: null,
    textContent: "", innerHTML: "", value: "", disabled: false, paused: false, id: "", className: "",
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
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
    querySelector(sel) { return found[sel] || (found[sel] = fakeElement()); },
    closest: () => null, click() {}, focus() {}, select() {}, scrollIntoView() {}, load() {},
    pause() { el.paused = true; },
    play() { el.paused = false; return Promise.resolve(); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    insertBefore(c) { el.children.unshift(c); c.parentNode = el; return c; },
    remove() {
      if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el);
      el.removed = true;
    },
    get firstChild() { return el.children[0] || null; },
  };
  return el;
}

// Loads the inline script up to its init block, signed in as user u1.
function loadEditor() {
  const elements = new Map();
  const timers = [];
  let nextTimer = 1;
  const calls = [];
  const store = new Map();
  const toasts = [];
  const opened = [];
  let reloads = 0;
  let handler = () => { throw new Error("no fetch handler set"); };

  const sandbox = {
    console, AbortController, URLSearchParams, URL,
    setTimeout: (fn, ms) => { const t = { id: nextTimer++, fn, ms: ms || 0 }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
    setInterval: () => 0, clearInterval() {},
    fetch: async (url, opts = {}) => {
      const call = { url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers || {} };
      calls.push(call);
      const res = await handler(call);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => (res.body === undefined ? null : res.body) };
    },
    document: {
      getElementById: (id) => { if (!elements.has(id)) { const e = fakeElement(); e.id = id; elements.set(id, e); } return elements.get(id); },
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, removeEventListener() {}, createElement: (tag) => fakeElement(tag),
      body: fakeElement("body"),
    },
    location: { href: "", search: "", hostname: "subcaptions.com", origin: "https://subcaptions.com", reload() { reloads++; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    open: (url) => { opened.push(url); },
    SubAuth: { user: { id: "u1" }, token: "t", tier: "team" },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: "index.html" }).runInContext(context);
  const run = (src) => new vm.Script(src).runInContext(context);
  context.__toasts = toasts;
  context.__confirm = true;
  run(`
    toast = (m, t) => __toasts.push({ m, t });
    renderColumns = () => {};
    buildWaveform = () => {};
    confirmModal = async () => __confirm;
  `);
  const page = {
    context, run, calls, store, toasts, opened, elements,
    el: (id) => context.document.getElementById(id),
    get reloads() { return reloads; },
    set: (vars) => run(Object.keys(vars).map((k) => `${k} = ${JSON.stringify(vars[k])};`).join("\n")),
    get: (expr) => { const v = run(`JSON.stringify(${expr})`); return v === undefined ? undefined : JSON.parse(v); },
    respond: (fn) => { handler = fn; },
    timers: () => timers.map((t) => t.ms),
    // Run the oldest pending timer (optionally checking its delay), then let promises settle.
    fire: async (ms) => {
      assert.ok(timers.length, "expected a pending timer");
      const t = timers.shift();
      if (ms !== undefined) assert.equal(t.ms, ms);
      t.fn();
      await flush();
    },
  };
  return page;
}

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const CAPS = [{ start: 1, end: 2, line1: "Hello", line2: "" }];

// An owner editing a YouTube project, signed in.
function ownerPage() {
  const page = loadEditor();
  page.set({ currentKey: "yt_abcdefghijk", currentSourceUrl: "https://youtu.be/abcdefghijk", captions: CAPS, translations: {} });
  return page;
}

// A translator who opened a share link that can edit.
async function translatorPage(get = { status: 200, body: { title: "Clip", source_url: "", data: { c: CAPS, t: {} }, canEdit: true, updated_at: V1, expires_at: null } }) {
  const page = loadEditor();
  page.respond(() => get);
  await page.run(`enterReviewer("tok1")`);
  await flush();
  page.calls.length = 0;
  page.toasts.length = 0;
  return page;
}

/* ---------- owner saves ---------- */

test("owner: the first save sends no base_updated_at, later saves echo the last updated_at exactly", async () => {
  const page = ownerPage();
  const versions = [V1, V2];
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: versions.shift() } }));

  page.run("cloudSave()");
  assert.deepEqual(page.timers(), [1500]);
  await page.fire(1500);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, API + "/projects");
  assert.equal(page.calls[0].method, "POST");
  assert.equal("base_updated_at" in page.calls[0].body, false);
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V1);
  assert.equal(page.run("typeof _cloudVersion.yt_abcdefghijk"), "string");

  page.run("cloudSave()");
  await page.fire(1500);
  assert.equal(page.calls[1].body.base_updated_at, V1);

  page.run("cloudSave()");
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: V3 } }));
  await page.fire(1500);
  assert.equal(page.calls[2].body.base_updated_at, V2);
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V3);
});

test("owner: the account load sets the version the next save builds on", async () => {
  const page = ownerPage();
  page.store.set("subcap-yt_abcdefghijk", JSON.stringify({ c: CAPS, t: {}, ts: 5000 }));
  page.respond((c) => c.method === "GET"
    ? { status: 200, body: { data: { c: [{ start: 0, end: 1, line1: "Old", line2: "" }], ts: 1000 }, updated_at: V1 } }
    : { status: 200, body: { ok: true, updated_at: V2 } });
  const changed = await page.run(`cloudHydrate("yt_abcdefghijk")`);
  assert.equal(changed, false, "the local copy is newer, so it is kept");
  assert.equal(page.get("captions[0].line1"), "Hello");
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V1);
  page.run("cloudSave()");
  await page.fire(1500);
  assert.equal(page.calls.at(-1).body.base_updated_at, V1);
});

test("owner: a later load that finds a newer account copy keeps the old version, so the next save gets a 409", async () => {
  const page = ownerPage();
  page.run(`_cloudVersion.yt_abcdefghijk = ${JSON.stringify(V1)}`);
  page.store.set("subcap-yt_abcdefghijk", JSON.stringify({ c: CAPS, t: {}, ts: 9000 }));
  page.respond(() => ({ status: 200, body: { data: { c: CAPS, ts: 1000 }, updated_at: V2 } }));
  await page.run(`cloudHydrate("yt_abcdefghijk")`);
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V1);
});

test("owner: a newer account copy is adopted along with its version", async () => {
  const page = ownerPage();
  page.store.set("subcap-yt_abcdefghijk", JSON.stringify({ c: CAPS, t: {}, ts: 1000 }));
  page.respond(() => ({ status: 200, body: { data: { c: [{ start: 0, end: 1, line1: "From the translator", line2: "" }], t: {}, ts: 9000 }, updated_at: V2 } }));
  assert.equal(await page.run(`cloudHydrate("yt_abcdefghijk")`), true);
  assert.equal(page.get("captions[0].line1"), "From the translator");
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V2);
});

test("owner: overlapping saves go out one at a time, each building on the one before", async () => {
  const page = ownerPage();
  let release;
  page.respond(() => new Promise((r) => { release = () => r({ status: 200, body: { ok: true, updated_at: V1 } }); }));
  page.run("queueCloudPost()");
  await flush();
  assert.equal(page.calls.length, 1, "the first save is in flight");
  page.run("queueCloudPost()");
  await flush();
  assert.equal(page.calls.length, 1, "the second save waits for the first");
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: V2 } }));
  release();
  await flush();
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls[1].body.base_updated_at, V1);
});

test("owner: a 409 stops autosave, keeps the local copy, marks it stale and shows a notice with Reload", async () => {
  const page = ownerPage();
  page.respond(() => ({ status: 409, body: { error: "This project changed somewhere else. Reload to get the latest version.", updated_at: V2 } }));
  page.run("persist()");
  assert.equal(JSON.parse(page.store.get("subcap-yt_abcdefghijk")).c[0].line1, "Hello");
  await page.fire(1500);

  assert.equal(page.get("_cloudConflict.yt_abcdefghijk"), true);
  assert.equal(page.toasts.length, 0, "the notice replaces the error toast");
  const editor = page.el("editor");
  const note = editor.children[0];
  assert.equal(note.id, "conflict-note");
  assert.equal(note.getAttribute("role"), "alert");
  assert.ok(note.innerHTML.includes("This project was changed somewhere else (another tab or your translator). Reload to get the latest version. Your edits since then are kept on this device until you reload."));
  assert.ok(note.innerHTML.includes(">Reload</button>"));
  note.querySelector("button").onclick();
  assert.equal(page.reloads, 1);

  // Later edits are still kept in this browser, marked so a reload takes the account copy.
  page.set({ captions: [{ start: 1, end: 2, line1: "Edited after", line2: "" }] });
  page.run("persist()");
  const rec = JSON.parse(page.store.get("subcap-yt_abcdefghijk"));
  assert.equal(rec.c[0].line1, "Edited after");
  assert.equal(rec.stale, 1);
  assert.deepEqual(page.timers(), [], "no more autosaves for this project");
  const before = page.calls.length;
  assert.equal((await page.run("queueCloudPost()")).status, 409);
  assert.equal(await page.run(`cloudHydrate("yt_abcdefghijk")`), false);
  assert.equal(page.calls.length, before, "nothing more is sent");
  page.run(`showConflictNotice("again")`);
  assert.equal(editor.children.length, 1, "the notice is shown once");
});

test("owner: after a reload, the stale local copy gives way to the account copy", async () => {
  const page = ownerPage();
  page.store.set("subcap-yt_abcdefghijk", JSON.stringify({ c: CAPS, t: {}, ts: 9000, stale: 1 }));
  page.run("persist()");
  assert.equal(JSON.parse(page.store.get("subcap-yt_abcdefghijk")).stale, 1, "an edit before the load keeps the mark");
  page.respond(() => ({ status: 200, body: { data: { c: [{ start: 0, end: 1, line1: "Account copy", line2: "" }], ts: 1000 }, updated_at: V2 } }));
  assert.equal(await page.run(`cloudHydrate("yt_abcdefghijk")`), true);
  assert.equal(page.get("captions[0].line1"), "Account copy");
  assert.equal(page.get("_cloudVersion.yt_abcdefghijk"), V2);
  assert.equal(JSON.parse(page.store.get("subcap-yt_abcdefghijk")).stale, undefined);
});

/* ---------- error messages ---------- */

test("owner save errors use the server's text when it sends one", () => {
  const { context } = loadEditor();
  const local = " Your work is still saved in this browser.";
  assert.equal(context.cloudSaveFailMessage(400, "source_key and data required"), "Couldn't save to your account. source_key and data required." + local);
  assert.equal(context.cloudSaveFailMessage(400), "Couldn't save to your account. The server could not read this project." + local);
  assert.equal(context.cloudSaveFailMessage(403, "You can keep up to 500 projects in your account."), "Couldn't save to your account. You can keep up to 500 projects in your account." + local);
  assert.equal(context.cloudSaveFailMessage(403), "Couldn't save to your account. You have reached the limit of saved projects. Delete some old ones to save new ones." + local);
  assert.equal(context.cloudSaveFailMessage(413, "request entity too large"), "Couldn't save to your account. This project is too large to save." + local);
  assert.equal(context.cloudSaveFailMessage(503, "Something went wrong on our side. Please try again."), "Couldn't save to your account. Something went wrong on our side. Please try again." + local);
  assert.equal(context.cloudSaveFailMessage(503), "Couldn't save to your account. Something went wrong on our side. Please try again." + local);
  assert.equal(context.cloudSaveFailMessage(500), "Couldn't save to your account (error 500)." + local);
  assert.equal(context.cloudSaveFailMessage(0), "Couldn't save to your account." + local);
});

test("translator save and share link errors", () => {
  const { context } = loadEditor();
  assert.equal(context.reviewerFailMessage(404, "Invalid share link"), "This share link is no longer valid. Ask the owner to send a new one.");
  assert.equal(context.reviewerFailMessage(410, "Link expired"), "This share link has expired. Ask the owner to send a new one.");
  assert.equal(context.reviewerFailMessage(403, "This link is view-only"), "Couldn't save. This link is view-only.");
  assert.equal(context.reviewerFailMessage(400, "data required"), "Couldn't save. data required.");
  assert.equal(context.reviewerFailMessage(413), "Couldn't save. This project is too large to save.");
  assert.equal(context.shareOpenMessage(410, "This share link has expired."), "This share link has expired. Ask the owner to send a new one.");
  assert.equal(context.shareOpenMessage(404, "This share link is invalid or was revoked."), "This share link is no longer valid. Ask the owner to send a new one.");
  assert.equal(context.shareOpenMessage(503, "Something went wrong on our side. Please try again."), "Something went wrong on our side. Please try again.");
  assert.equal(context.shareOpenMessage(500), "Couldn't open this link (error 500).");
  assert.equal(context.shareOpenMessage(0), "Couldn't reach the server. Check your connection and reload the page.");
});

test("each kind of save failure is toasted once until a save works", () => {
  const page = loadEditor();
  page.run(`noteCloudSave(503, "Something went wrong on our side. Please try again.")`);
  page.run(`noteCloudSave(503, "Something went wrong on our side. Please try again.")`);
  assert.equal(page.toasts.length, 1);
  page.run(`noteCloudSave(413)`);
  page.run(`noteCloudSave(400, "source_key and data required")`);
  page.run(`noteCloudSave(409)`);
  assert.equal(page.toasts.length, 3, "503, 413 and 400 once each; 409 has its own notice");
  assert.ok(page.toasts.every((t) => t.t === "error"));
  page.run(`noteCloudSave(200)`);
  page.run(`noteCloudSave(503)`);
  assert.equal(page.toasts.length, 4, "a good save resets it");
});

test("opening an expired or revoked share link shows the plain message", async () => {
  for (const [status, msg] of [[410, "This share link has expired. Ask the owner to send a new one."], [404, "This share link is no longer valid. Ask the owner to send a new one."]]) {
    const page = loadEditor();
    page.respond(() => ({ status, body: { error: "server text" } }));
    await page.run(`enterReviewer("tok1")`);
    assert.equal(page.el("editor").innerHTML, '<div class="rev-banner err">' + msg + "</div>");
  }
});

/* ---------- translator saves ---------- */

test("translator: base_updated_at comes from the share load, then from each save", async () => {
  const page = await translatorPage();
  assert.equal(page.get("_shareVersion"), V1);
  const versions = [V2, V3];
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: versions.shift() } }));
  page.run("reviewerSave()");
  assert.ok(page.store.has("subcap_share:tok1"), "edits are kept on this device until saved");
  await page.fire(1200);
  assert.equal(page.calls[0].url, API + "/share/tok1");
  assert.equal(page.calls[0].method, "PUT");
  assert.equal(page.calls[0].body.base_updated_at, V1);
  assert.equal(page.el("rev-status").textContent, "All changes saved");
  assert.equal(page.store.has("subcap_share:tok1"), false);
  page.run("reviewerSave()");
  await page.fire(1200);
  assert.equal(page.calls[1].body.base_updated_at, V2);
  assert.equal(page.get("_shareVersion"), V3);
});

test("translator: a failed save is retried after 2, 5 and 15 seconds, then stops with a message that stays", async () => {
  const page = await translatorPage();
  page.respond(() => ({ status: 503, body: { error: "Something went wrong on our side. Please try again." } }));
  page.run("reviewerSave()");
  await page.fire(1200);
  assert.deepEqual(page.timers(), [2000]);
  assert.equal(page.el("rev-status").textContent, "Couldn't save. Trying again in 2 s…");
  page.run("reviewerSave()"); // an edit while a retry waits does not add another timer
  assert.deepEqual(page.timers(), [2000]);
  await page.fire(2000);
  assert.deepEqual(page.timers(), [5000]);
  await page.fire(5000);
  assert.deepEqual(page.timers(), [15000]);
  await page.fire(15000);
  assert.deepEqual(page.timers(), [], "no more retries");
  assert.equal(page.calls.length, 4);
  assert.equal(page.el("rev-status").textContent, "Couldn't save. Your work is kept on this device.");
  assert.deepEqual(page.toasts.map((t) => t.m), ["Couldn't save. Your work is kept on this device."]);
  assert.ok(page.store.has("subcap_share:tok1"));

  // A later edit tries once, without a new retry run, and the message stays up.
  page.run("reviewerSave()");
  assert.equal(page.el("rev-status").textContent, "Couldn't save. Your work is kept on this device.");
  await page.fire(1200);
  assert.deepEqual(page.timers(), []);
  assert.equal(page.toasts.length, 1);

  // Once a save works, the message clears.
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: V2 } }));
  page.run("reviewerSave()");
  await page.fire(1200);
  assert.equal(page.el("rev-status").textContent, "All changes saved");
});

test("translator: network failures and 429 are retried", async () => {
  const page = await translatorPage();
  page.respond(() => { throw new TypeError("Failed to fetch"); });
  page.run("reviewerSave()");
  await page.fire(1200);
  assert.deepEqual(page.timers(), [2000]);
  page.respond(() => ({ status: 429, body: { error: "Too many requests" } }));
  await page.fire(2000);
  assert.deepEqual(page.timers(), [5000]);
  page.respond(() => ({ status: 200, body: { ok: true, updated_at: V2 } }));
  await page.fire(5000);
  assert.deepEqual(page.timers(), []);
  assert.equal(page.el("rev-status").textContent, "All changes saved");
  assert.equal(page.get("_revRetry"), 0);
});

test("translator: a 4xx other than 429 is not retried", async () => {
  for (const [status, error, msg, stops] of [
    [400, "data required", "Couldn't save. data required.", false],
    [413, "request entity too large", "Couldn't save. This project is too large to save.", false],
    [403, "This link is view-only", "Couldn't save. This link is view-only.", true],
    [410, "Link expired", "This share link has expired. Ask the owner to send a new one.", true],
    [404, "Invalid share link", "This share link is no longer valid. Ask the owner to send a new one.", true],
  ]) {
    const page = await translatorPage();
    page.respond(() => ({ status, body: { error } }));
    page.run("reviewerSave()");
    await page.fire(1200);
    assert.deepEqual(page.timers(), [], status + " is not retried");
    assert.equal(page.calls.length, 1);
    assert.equal(page.el("rev-status").textContent, msg);
    assert.deepEqual(page.toasts.map((t) => t.m), [msg]);
    page.run("reviewerSave()");
    assert.deepEqual(page.timers(), stops ? [] : [1200], status + (stops ? " stops saving" : " lets a later edit try again"));
  }
});

test("translator: a 409 stops saving for the session and shows the notice", async () => {
  const page = await translatorPage();
  page.respond(() => ({ status: 409, body: { error: "This project changed somewhere else. Reload to get the latest version.", updated_at: V2 } }));
  page.run("reviewerSave()");
  await page.fire(1200);
  assert.deepEqual(page.timers(), []);
  assert.equal(page.get("_revStop"), true);
  const note = page.el("editor").children[0];
  assert.equal(note.id, "conflict-note");
  assert.ok(note.innerHTML.includes("This project was changed somewhere else (another tab or the project owner). Reload to get the latest version. Your edits since then are kept on this device until you reload."));
  page.run("reviewerSave()");
  assert.deepEqual(page.timers(), [], "no save after a 409");
  assert.ok(page.store.has("subcap_share:tok1"), "the edits stay on this device");
  assert.equal(page.calls.length, 1);
});

test("translator: unsaved edits come back after a reload when nobody saved in between", async () => {
  const backup = JSON.stringify({ c: [{ start: 1, end: 2, line1: "Unsaved", line2: "" }], t: {}, ts: 1, base: V1 });
  const page = loadEditor();
  page.store.set("subcap_share:tok1", backup);
  page.respond((c) => c.method === "GET"
    ? { status: 200, body: { title: "Clip", source_url: "", data: { c: CAPS, t: {} }, canEdit: true, updated_at: V1 } }
    : { status: 200, body: { ok: true, updated_at: V2 } });
  await page.run(`enterReviewer("tok1")`);
  await flush();
  assert.equal(page.get("captions[0].line1"), "Unsaved");
  await page.fire(1200);
  assert.equal(page.calls.at(-1).body.data.c[0].line1, "Unsaved");

  const later = loadEditor();
  later.store.set("subcap_share:tok1", backup);
  later.respond(() => ({ status: 200, body: { title: "Clip", source_url: "", data: { c: CAPS, t: {} }, canEdit: true, updated_at: V2 } }));
  await later.run(`enterReviewer("tok1")`);
  await flush();
  assert.equal(later.get("captions[0].line1"), "Hello", "the project changed since, so the server copy wins");
  assert.equal(later.store.has("subcap_share:tok1"), false);
});

/* ---------- share modal ---------- */

test("formatExpiry gives a local date, or nothing for a missing or bad value", () => {
  const { context } = loadEditor();
  const iso = "2026-12-03T10:00:00.000Z";
  assert.equal(context.formatExpiry(iso), new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  assert.match(context.formatExpiry(iso), /2026/);
  assert.equal(context.formatExpiry(null), "");
  assert.equal(context.formatExpiry(""), "");
  assert.equal(context.formatExpiry("not a date"), "");
});

test("the share modal shows the expiry date and lists the project's links", async () => {
  const page = ownerPage();
  const exp = "2026-12-03T10:00:00.000Z";
  page.respond(() => ({ status: 200, body: { shares: [
    { token: "new1", label: null, can_edit: true, expires_at: exp, expired: false },
    { token: "old1", label: "Maria <FR>", can_edit: false, expires_at: "2026-10-01T00:00:00.000Z", expired: true },
    { token: "old2", label: "Legacy", can_edit: true, expires_at: null, expired: false },
  ] } }));
  page.run(`shareModal("https://subcaptions.com/?share=new1", ${JSON.stringify(exp)}, "new1")`);
  await flush();
  const date = new Date(exp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  assert.ok(page.el("share-ov").innerHTML.includes('<p class="share-exp" id="share-exp">Link expires on ' + date + "</p>"));
  assert.ok(page.el("share-ov").innerHTML.includes("<h4>Manage links</h4>"));
  assert.equal(page.calls[0].url, API + "/projects/yt_abcdefghijk/shares");
  const list = page.el("share-links").innerHTML;
  assert.ok(list.includes("Untitled link (this link)"));
  assert.ok(list.includes("Can edit · Expires " + date));
  assert.ok(list.includes("Maria &lt;FR&gt;"));
  assert.ok(list.includes("View only · Expired "));
  assert.ok(list.includes("Can edit · No expiry date"));
  assert.equal((list.match(/>Revoke</g) || []).length, 3);
});

test("revoking a link asks first, then deletes it and removes the row", async () => {
  const page = ownerPage();
  const box = page.context.document.createElement("div");
  const row = page.context.document.createElement("div");
  box.appendChild(row);
  const btn = page.context.document.createElement("button");
  page.context.__row = row; page.context.__btn = btn;
  page.respond(() => ({ status: 200, body: { ok: true } }));

  page.context.__confirm = false;
  await page.run(`revokeShareLink("yt_abcdefghijk", "old1", __row, __btn, "new1")`);
  assert.equal(page.calls.length, 0, "cancel sends nothing");

  page.context.__confirm = true;
  await page.run(`revokeShareLink("yt_abcdefghijk", "old1", __row, __btn, "new1")`);
  assert.equal(page.calls[0].method, "DELETE");
  assert.equal(page.calls[0].url, API + "/projects/yt_abcdefghijk/share/old1");
  assert.equal(row.removed, true);
  assert.equal(box.children.length, 0);
});

test("revoking the link just made blanks it in the modal", async () => {
  const page = ownerPage();
  const row = page.context.document.createElement("div");
  page.context.document.createElement("div").appendChild(row);
  page.context.__row = row; page.context.__btn = page.context.document.createElement("button");
  page.el("share-url").value = "https://subcaptions.com/?share=new1";
  page.respond(() => ({ status: 404, body: { error: "Share link not found." } }));
  await page.run(`revokeShareLink("yt_abcdefghijk", "new1", __row, __btn, "new1")`);
  assert.equal(row.removed, true, "a link that is already gone is removed too");
  assert.equal(page.el("share-url").value, "");
  assert.equal(page.el("share-copy").disabled, true);
});

test("a failed revoke keeps the row and says so", async () => {
  const page = ownerPage();
  const row = page.context.document.createElement("div");
  page.context.document.createElement("div").appendChild(row);
  const btn = page.context.document.createElement("button");
  page.context.__row = row; page.context.__btn = btn;
  page.respond(() => ({ status: 503, body: { error: "Something went wrong on our side. Please try again." } }));
  await page.run(`revokeShareLink("yt_abcdefghijk", "old1", __row, __btn, "new1")`);
  assert.notEqual(row.removed, true);
  assert.equal(btn.disabled, false);
  const err = row.querySelector(".sl-meta").children[0];
  assert.equal(err.textContent, "Couldn't revoke that link. Try again.");
});

/* ---------- Frame.io and the hero video ---------- */

test("Frame.io: the signed media URL survives mount, and transcription re-resolves it", async () => {
  const page = loadEditor();
  const link = "https://app.frame.io/reviews/abc-123/def";
  let n = 0;
  page.respond((c) => {
    assert.ok(c.url.startsWith("https://frameio.subcaptions.com/resolve?link="));
    n++;
    return { status: 200, body: { download_url: "https://cdn.example.com/clip.mp4?sig=" + n } };
  });
  page.set({ currentSourceUrl: link });
  await page.run(`mountFrameio(resolveSource(${JSON.stringify(link)}))`);
  await flush();
  assert.equal(page.get("kind"), "html5");
  assert.equal(page.get("currentMediaUrl"), "https://cdn.example.com/clip.mp4?sig=1");
  const url = await page.run("freshMediaUrl()");
  assert.equal(url, "https://cdn.example.com/clip.mp4?sig=2");
  assert.notEqual(url, link);
  assert.match(HTML, /const fetchUrl = await freshMediaUrl\(\);/, "autoTranscribe uses freshMediaUrl");
});

test("the hero video pauses when an editor opens", () => {
  const page = loadEditor();
  const hv = page.el("hero-video");
  hv.paused = false;
  page.run(`openInNewTab("https://youtu.be/abcdefghijk")`);
  assert.deepEqual(page.opened, ["/?v=" + encodeURIComponent("https://youtu.be/abcdefghijk")]);
  assert.equal(hv.paused, true);
  hv.paused = false;
  page.run("pauseHeroVideo()");
  assert.equal(hv.paused, true);
});

/* ---------- project data from the cloud is escaped ---------- */

// A translator with an edit link can save any translation code, flag and thumbnail.
const EVIL = '"><img src=x onerror=alert(1)>';
const EVIL_ESC = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";

test("a translation column escapes its code and flag", () => {
  const page = loadEditor();
  page.set({ captions: CAPS });
  const html = page.context.colHtml(EVIL, EVIL, EVIL, false, [EVIL], false);
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes(`<span class="flag">${EVIL_ESC}</span>`), "flag escaped");
  const attrs = [...html.matchAll(/data-(rm|show|dl|col)="([^"]*)"/g)];
  assert.deepEqual(attrs.map((m) => m[1]).sort(), ["col", "dl", "dl", "rm", "show"]);
  for (const m of attrs) assert.equal(m[2], EVIL_ESC, `data-${m[1]}`);
  // Real codes and flags come out as before.
  const plain = page.context.colHtml("pt-BR", "Portuguese (Brazil)", "🇧🇷", false, ["Olá"], false);
  assert.match(plain, /<span class="flag">🇧🇷<\/span>Portuguese \(Brazil\)/);
  assert.match(plain, /data-rm="pt-BR"/);
  assert.match(plain, /data-col="pt-BR"/);
});

test("the recent projects list shows only an https or image data thumbnail, escaped", async () => {
  const page = loadEditor();
  const local = (th, ts) => JSON.stringify({ c: CAPS, t: {}, u: "https://youtu.be/aaaaaaaaaaa", ts, th, uid: "u1" });
  page.store.set("subcap-yt_local", local("javascript:alert(1)", 9));
  page.respond((call) => {
    assert.equal(call.url, API + "/projects");
    return { status: 200, body: { projects: [
      { key: "k1", url: "https://example.com/1.mp4", count: 1, ts: 8, th: EVIL },
      { key: "k2", url: "https://example.com/2.mp4", count: 1, ts: 7, th: 'https://i.vimeocdn.com/a.jpg" onerror="alert(1)' },
      { key: "k3", url: "https://example.com/3.mp4", count: 1, ts: 6, th: " data:image/jpeg;base64,AAAA" },
      { key: "k4", url: "https://example.com/4.mp4", count: 1, ts: 5, th: "JavaScript:alert(1)" },
    ] } };
  });
  await page.run("renderRecent()");
  const html = page.el("recent-projects").innerHTML;
  assert.doesNotMatch(html, /onerror="|javascript:|<img src=x/i);
  const srcs = [...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, [
    "https://img.youtube.com/vi/aaaaaaaaaaa/mqdefault.jpg", // local: unsafe th, falls back to the YouTube thumbnail
    "https://i.vimeocdn.com/a.jpg&quot; onerror=&quot;alert(1)", // https, so used, but escaped
    "data:image/jpeg;base64,AAAA",
  ]);
  assert.equal((html.match(/🎬/g) || []).length, 2, "k1 and k4 show no image");
});

test("a 413 from the storage check shows the server's text; the body parser's 413 does not", () => {
  const { context } = loadEditor();
  const local = " Your work is still saved in this browser.";
  const full = "Your saved projects have used up your account's 25 MB of storage. Delete some old projects to save this one. Solo and Team plans include 250 MB.";
  assert.equal(context.cloudSaveFailMessage(413, full), "Couldn't save to your account. " + full + local);
  assert.equal(context.cloudSaveFailMessage(413, "Request entity too large"), "Couldn't save to your account. This project is too large to save." + local);
  assert.equal(context.cloudSaveFailMessage(413), "Couldn't save to your account. This project is too large to save." + local);
  const owner = "The project owner's account is out of storage, so this change could not be saved. Ask the owner to free up space.";
  assert.equal(context.reviewerFailMessage(413, owner), "Couldn't save. " + owner);
  assert.equal(context.reviewerFailMessage(413, "request entity too large"), "Couldn't save. This project is too large to save.");
});
