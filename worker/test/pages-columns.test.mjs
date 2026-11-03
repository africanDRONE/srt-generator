// Offline tests for what the two pages do with a translation column after a run:
// addTranslation() in translate.html and translateCaptions() in index.html.
// Each test loads the page's own inline script into node:vm with a stubbed DOM and a
// stubbed fetch. No network access happens here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fakeElement() {
  const classes = new Set();
  return {
    style: {}, dataset: {}, children: [],
    textContent: "", innerHTML: "", value: "", disabled: false,
    scrollLeft: 0, scrollWidth: 0,
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
    closest: () => null, click() {}, focus() {}, scrollBy() {}, scrollTo() {},
  };
}

// Runs the page's inline script up to its init block, so every function and top-level
// variable exists but nothing has started. Returns helpers to set and read that state.
function loadPage(fileName) {
  const html = fs.readFileSync(ROOT + fileName, "utf8");
  const start = html.indexOf("<script>\n");
  const end = html.indexOf("(function init(){", start);
  assert.ok(start !== -1 && end !== -1, `inline script not found in ${fileName}`);
  const source = html.slice(start + "<script>\n".length, end);

  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const stored = {};
  const sandbox = {
    console, clearTimeout, setInterval, clearInterval, AbortController, URLSearchParams,
    // Waits between attempts are cut to 5 ms so the tests run fast.
    setTimeout: (fn, ms, ...rest) => setTimeout(fn, Math.min(ms, 5), ...rest),
    fetch: async () => { throw new Error("no fetch stub set for this test"); },
    document: {
      getElementById, querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, createElement: () => fakeElement(),
    },
    location: { href: "", search: "" },
    localStorage: {
      getItem: (k) => (k in stored ? stored[k] : null),
      setItem: (k, v) => { stored[k] = String(v); },
      removeItem: (k) => { delete stored[k]; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: fileName }).runInContext(context);

  const toasts = [];
  context.toast = (msg, type) => toasts.push({ msg, type });
  return {
    context, getElementById, toasts,
    // Top-level let and const variables are not properties of the context object, so
    // they are set and read by a script that runs inside the same context.
    set: (vars) => {
      const src = Object.keys(vars).map((k) => `${k} = ${JSON.stringify(vars[k])};`).join("\n");
      new vm.Script(src).runInContext(context);
    },
    get: (expr) => JSON.parse(new vm.Script(`JSON.stringify(${expr})`).runInContext(context)),
  };
}

const ok = (texts) => ({ ok: true, status: 200, json: async () => ({ translations: texts.map((t) => "TR:" + t) }) });
const serverError = () => ({ ok: false, status: 500, json: async () => ({ error: "Translation provider error" }) });
const declined = () => ({ ok: false, status: 422, json: async () => ({ error: "Content was declined by the translator." }) });
const sentCues = (opts) => JSON.parse(opts.body).cues;

// Answers the first batch and fails every request after it.
function failAfterFirstBatch() {
  let n = 0;
  return async (_url, opts) => (++n === 1 ? ok(sentCues(opts)) : serverError());
}
// Declines every request that contains the given text and answers the rest.
function declineText(text) {
  return async (_url, opts) => (sentCues(opts).includes(text) ? declined() : ok(sentCues(opts)));
}

// ---- translate.html ----

function loadTranslator(count) {
  const page = loadPage("translate.html");
  page.set({ cues: Array.from({ length: count }, (_, i) => ({ text: `line${i}`, start: i, end: i + 1 })), langCols: [] });
  page.getElementById("tgt-lang").value = "de";
  return page;
}

test("C1 (translate.html): a failure on the first batch removes the column and shows the error", async () => {
  const page = loadTranslator(5);
  page.context.fetch = async () => serverError();
  await page.context.addTranslation();
  assert.equal(page.get("langCols").length, 0);
  assert.deepEqual(page.toasts.at(-1), { msg: "Translation failed (500). Please try again.", type: "error" });
});

test("C2 (translate.html): a failure on the second batch keeps the first 20 lines", async () => {
  const page = loadTranslator(45);
  page.context.fetch = failAfterFirstBatch();
  await page.context.addTranslation();
  const cols = page.get("langCols");
  assert.equal(cols.length, 1);
  assert.deepEqual(cols[0].lines.slice(0, 20), Array.from({ length: 20 }, (_, i) => "TR:line" + i));
  assert.ok(cols[0].lines.slice(20).every((v) => v === ""));
  assert.equal(cols[0].lines.length, 45);
  const last = page.toasts.at(-1);
  assert.equal(last.type, "error");
  assert.match(last.msg, /^German stopped after 20 of 45 lines\. Translation failed \(500\)\. The translated lines were kept\./);
});

test("C3 (translate.html): a line that is declined every time is left empty, the rest land in order", async () => {
  const page = loadTranslator(5);
  page.context.fetch = declineText("line2");
  await page.context.addTranslation();
  const cols = page.get("langCols");
  assert.deepEqual(cols[0].lines, ["TR:line0", "TR:line1", "", "TR:line3", "TR:line4"]);
  assert.equal(page.toasts.at(-1).type, "error");
  assert.match(page.toasts.at(-1).msg, /^German added, but 1 line could not be translated\./);
});

test("C4 (translate.html): a clean run fills every line and shows the success message", async () => {
  const page = loadTranslator(45);
  page.context.fetch = async (_url, opts) => ok(sentCues(opts));
  await page.context.addTranslation();
  assert.deepEqual(page.get("langCols")[0].lines, Array.from({ length: 45 }, (_, i) => "TR:line" + i));
  assert.deepEqual(page.toasts.at(-1), { msg: "German added", type: "success" });
});

// ---- index.html ----

function loadEditor(count, existingLines, isPro = true) {
  const page = loadPage("index.html");
  page.set({
    captions: Array.from({ length: count }, (_, i) => ({ start: i, end: i + 1, line1: `src${i}`, line2: "" })),
    translations: existingLines ? { de: { name: "German", flag: "", lines: existingLines } } : {},
    IS_PRO: isPro,
  });
  page.getElementById("tgt-lang").value = "de";
  return page;
}

test("C5 (index.html): a new column that fails on the second batch keeps the first 20 lines", async () => {
  const page = loadEditor(45, null);
  page.context.fetch = failAfterFirstBatch();
  await page.context.translateCaptions();
  const lines = page.get("translations.de.lines");
  assert.equal(lines.length, 45);
  assert.deepEqual(lines.slice(0, 20), Array.from({ length: 20 }, (_, i) => "TR:src" + i));
  assert.ok(lines.slice(20).every((v) => v === ""));
  assert.equal(page.toasts.at(-1).msg, "German stopped after 20 of 45 lines. Translation failed (500). The translated lines were kept. Press Translate to retry.");
});

test("C6 (index.html): a re-translate that fails on the second batch leaves the column as it was", async () => {
  const old = Array.from({ length: 45 }, (_, i) => "OLD" + i);
  const page = loadEditor(45, old);
  page.context.fetch = failAfterFirstBatch();
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), old);
  assert.equal(page.toasts.at(-1).msg, "German stopped after 20 of 45 lines. Translation failed (500). Your German column was left as it was. Press Translate to retry.");
});

test("C7 (index.html): a re-translate keeps the earlier text of a line that is declined every time", async () => {
  const page = loadEditor(5, ["OLD0", "OLD1", "TYPED BY HAND", "OLD3", "OLD4"]);
  page.context.fetch = declineText("src2");
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), ["TR:src0", "TR:src1", "TYPED BY HAND", "TR:src3", "TR:src4"]);
  assert.deepEqual(page.toasts.at(-1), {
    msg: "Updated German column, but 1 line could not be translated and was left as it was.",
    type: "error",
  });
});

test("C8 (index.html): a re-translate with two declined lines says so in the plural", async () => {
  const page = loadEditor(5, ["OLD0", "OLD1", "OLD2", "", "OLD4"]);
  page.context.fetch = async (_url, opts) => {
    const cues = sentCues(opts);
    return cues.includes("src1") || cues.includes("src3") ? declined() : ok(cues);
  };
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), ["TR:src0", "OLD1", "TR:src2", "", "TR:src4"]);
  assert.equal(page.toasts.at(-1).msg, "Updated German column, but 2 lines could not be translated and were left as they were.");
});

test("C9 (index.html): a new column leaves a declined line empty and asks for it to be filled in", async () => {
  const page = loadEditor(5, null);
  page.context.fetch = declineText("src2");
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), ["TR:src0", "TR:src1", "", "TR:src3", "TR:src4"]);
  assert.equal(page.toasts.at(-1).msg, "Added German column, but 1 line could not be translated. Fill it in by hand.");
});

test("C10 (index.html): a re-translate where every line is declined leaves the column as it was", async () => {
  const old = ["OLD0", "OLD1", "OLD2"];
  const page = loadEditor(3, old);
  page.context.fetch = async () => declined();
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), old);
  assert.deepEqual(page.toasts.at(-1), { msg: "None of the lines could be translated. Please try again.", type: "error" });
});

test("C11 (index.html): a clean re-translate replaces every line, including a column shorter than the captions", async () => {
  const page = loadEditor(5, ["OLD0", "OLD1"]);
  page.context.fetch = async (_url, opts) => ok(sentCues(opts));
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), Array.from({ length: 5 }, (_, i) => "TR:src" + i));
  assert.deepEqual(page.toasts.at(-1), { msg: "Updated German column", type: "success" });
});

test("C14 (index.html): a clean run for a new language says the column was added", async () => {
  const page = loadEditor(5, null);
  page.context.fetch = async (_url, opts) => ok(sentCues(opts));
  await page.context.translateCaptions();
  assert.deepEqual(page.get("translations.de.lines"), Array.from({ length: 5 }, (_, i) => "TR:src" + i));
  assert.deepEqual(page.toasts.at(-1), { msg: "Added German column", type: "success" });
});

test("C12 (index.html): the free plan blocks a second language without sending a request", async () => {
  const page = loadEditor(1, ["OLD0"], false);
  page.getElementById("tgt-lang").value = "fr";
  let calls = 0;
  page.context.fetch = async (_url, opts) => { calls++; return ok(sentCues(opts)); };
  await page.context.translateCaptions();
  assert.equal(calls, 0);
  assert.equal(page.toasts.at(-1).type, "error");
  assert.equal(page.get("Object.keys(translations)").join(), "de");
});

test("C13 (index.html): a new language where every line is declined adds no column", async () => {
  const page = loadEditor(3, null);
  page.context.fetch = async () => declined();
  await page.context.translateCaptions();
  assert.deepEqual(page.get("Object.keys(translations)"), []);
  assert.deepEqual(page.toasts.at(-1), { msg: "None of the lines could be translated. Please try again.", type: "error" });
});
