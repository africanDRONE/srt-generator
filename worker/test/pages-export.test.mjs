// Offline tests for the caption editor's import and export helpers in index.html:
// timestamp rounding, WebVTT escaping, .srt/.vtt import tag handling, download names,
// and keeping translation lines aligned when captions are re-sorted or replaced.
// The page's inline script runs in node:vm with a stubbed DOM. No network access.

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
    closest: () => null, click() {}, focus() {},
  };
}

// Runs index.html's inline script up to its init block, so every function and
// top-level variable exists but nothing has started.
function loadEditor(where = { hostname: "subcaptions.com", search: "" }) {
  const html = fs.readFileSync(ROOT + "index.html", "utf8");
  const start = html.indexOf("<script>\n");
  const end = html.indexOf("(function init(){", start);
  assert.ok(start !== -1 && end !== -1, "inline script not found in index.html");
  const source = html.slice(start + "<script>\n".length, end);
  const elements = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, URLSearchParams, URL,
    fetch: async () => { throw new Error("no network in these tests"); },
    document: {
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); },
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, createElement: () => fakeElement(),
    },
    location: { href: "", search: where.search, hostname: where.hostname },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: "index.html" }).runInContext(context);
  const run = (src) => new vm.Script(src).runInContext(context);
  return {
    context, run,
    set: (vars) => run(Object.keys(vars).map((k) => `${k} = ${JSON.stringify(vars[k])};`).join("\n")),
    get: (expr) => JSON.parse(run(`JSON.stringify(${expr})`)),
  };
}

const page = loadEditor();
const { context } = page;

test("formatTime rounds to whole milliseconds before splitting", () => {
  // 1.001 is stored as 1.000999..., which used to print as 00:00:01,000.
  assert.equal(context.formatTime(1.001, true), "00:00:01,001");
  assert.equal(context.formatTime(2.3, true), "00:00:02,300");
  assert.equal(context.formatTime(3661.5, false), "01:01:01.500");
});

test("formatTime carries a rounded-up millisecond into seconds, minutes and hours", () => {
  assert.equal(context.formatTime(59.9996, true), "00:01:00,000");
  assert.equal(context.formatTime(3599.9999, true), "01:00:00,000");
  assert.equal(context.formatTime(10.0004, false), "00:00:10.000");
});

test("formatTime clamps negatives to zero and keeps the empty placeholder", () => {
  assert.equal(context.formatTime(-0.2, true), "00:00:00,000");
  assert.equal(context.formatTime(null, true), "--:--:--");
  assert.equal(context.formatTime(NaN, false), "--:--:--");
});

test("escapeVttText escapes &, < and > but keeps <i>, <b> and <u>", () => {
  assert.equal(context.escapeVttText("Tom & Jerry <3 > you"), "Tom &amp; Jerry &lt;3 &gt; you");
  assert.equal(context.escapeVttText("<i>hi</i> <b>x</b> <u>y</u>"), "<i>hi</i> <b>x</b> <u>y</u>");
  assert.equal(context.escapeVttText("<I>Loud</I>"), "<i>Loud</i>");
  assert.equal(context.escapeVttText('<font color="red">x</font>'), '&lt;font color="red"&gt;x&lt;/font&gt;');
  assert.equal(context.escapeVttText("&amp;"), "&amp;amp;");
  assert.equal(context.escapeVttText(""), "");
});

test("SRT import keeps <i>, <b> and <u> and strips other tags", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:02,500",
    '<i>Hello</i> <font color="#ffffff">world</font>',
    "<B>Line two</B> & <u>more</u>",
    "",
    "2",
    "00:00:03,000 --> 00:00:04,000",
    "Plain",
    "",
  ].join("\r\n");
  const cues = JSON.parse(JSON.stringify(context.parseSubs(srt)));
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: "<i>Hello</i> world\n<b>Line two</b> & <u>more</u>" },
    { start: 3, end: 4, text: "Plain" },
  ]);
});

test("VTT import decodes entities, drops voice and class tags, keeps styling tags", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:01.000 --> 00:02.000 align:start line:90%",
    "<v Bob>Tom &amp; Jerry &lt;3</v>",
    "<i.loud>Hey</i>&nbsp;there",
    "",
  ].join("\n");
  const cues = JSON.parse(JSON.stringify(context.parseSubs(vtt)));
  assert.deepEqual(cues, [{ start: 1, end: 2, text: "Tom & Jerry <3\n<i>Hey</i> there" }]);
});

test("buildSubs escapes VTT text, leaves SRT text alone, and never writes a blank line inside a cue", () => {
  page.set({ captions: [{ start: 1.001, end: 2.3, line1: "", line2: "" }] });
  const texts = ["<i>Tom</i> & Jerry\n\n<3"];
  assert.equal(context.buildSubs(true, texts), "WEBVTT\n\n1\n00:00:01.001 --> 00:00:02.300\n<i>Tom</i> &amp; Jerry\n&lt;3\n");
  assert.equal(context.buildSubs(false, texts), "1\n00:00:01,001 --> 00:00:02,300\n<i>Tom</i> & Jerry\n<3\n");
});

test("an exported VTT file imports back to the same text", () => {
  page.set({ captions: [{ start: 0.5, end: 1.75, line1: "", line2: "" }] });
  const original = "<b>A & B</b> <c> 1 < 2";
  const cues = JSON.parse(JSON.stringify(context.parseSubs(context.buildSubs(true, [original]))));
  assert.deepEqual(cues, [{ start: 0.5, end: 1.75, text: original }]);
});

test("export file names come from the video title", () => {
  page.set({ videoTitle: "My Film: Part 1 / Final cut" });
  assert.equal(context.exportBase(), "My-Film-Part-1-Final-cut");
  page.set({ videoTitle: "Café über 東京" });
  assert.equal(context.exportBase(), "Café-über-東京");
  page.set({ videoTitle: "" });
  assert.equal(context.exportBase(), "captions");
  page.set({ videoTitle: "???" });
  assert.equal(context.exportBase(), "captions");
  page.set({ videoTitle: "x".repeat(120) });
  assert.equal(context.exportBase().length, 80);
});

test("titleFromUrl takes the file name from a video link or storage key", () => {
  assert.equal(context.titleFromUrl("https://cdn.example.com/a/My%20Clip.mp4?sig=1"), "My Clip");
  assert.equal(context.titleFromUrl("u/123/abc/interview.mov"), "interview");
  assert.equal(context.titleFromUrl("https://www.youtube.com/watch?v=abc"), "");
  assert.equal(context.titleFromUrl(""), "");
});

test("sortCaptions keeps every translation line with its caption", () => {
  page.set({
    captions: [
      { start: 5, end: 6, line1: "late", line2: "" },
      { start: 1, end: 2, line1: "early", line2: "" },
      { start: 3, end: 4, line1: "middle", line2: "" },
    ],
    translations: { de: { name: "German", flag: "", lines: ["spät", "früh", "Mitte"] } },
  });
  page.run("sortCaptions();");
  assert.deepEqual(page.get("captions.map(c => c.line1)"), ["early", "middle", "late"]);
  assert.deepEqual(page.get("translations.de.lines"), ["früh", "Mitte", "spät"]);
});

test("carryTranslations keeps lines for unchanged captions and drops empty columns", () => {
  const oldCaps = [
    { start: 1, end: 2, line1: "Hello", line2: "" },
    { start: 3, end: 4, line1: "World", line2: "" },
  ];
  const oldTr = {
    de: { name: "German", flag: "", lines: ["Hallo", "Welt"] },
    fr: { name: "French", flag: "", lines: ["", "Monde"] },
  };
  // The second caption changed text, and a new caption was added in front.
  page.set({
    captions: [
      { start: 0, end: 0.5, line1: "Intro", line2: "" },
      { start: 1, end: 2, line1: "Hello", line2: "" },
      { start: 3, end: 4, line1: "World!", line2: "" },
    ],
  });
  const carried = JSON.parse(JSON.stringify(context.carryTranslations(oldCaps, oldTr)));
  assert.deepEqual(carried, { de: { name: "German", flag: "", lines: ["", "Hallo", ""] } });
});

test("?pro=1 unlocks paid features only on a local dev server", () => {
  assert.equal(loadEditor({ hostname: "subcaptions.com", search: "?pro=1" }).get("DEV_PRO"), false);
  assert.equal(loadEditor({ hostname: "localhost", search: "?pro=1" }).get("DEV_PRO"), true);
  assert.equal(loadEditor({ hostname: "127.0.0.1", search: "?pro=1" }).get("DEV_PRO"), true);
  assert.equal(loadEditor({ hostname: "localhost.evil.com", search: "?pro=1" }).get("DEV_PRO"), false);
  assert.equal(loadEditor({ hostname: "localhost", search: "" }).get("DEV_PRO"), false);
});

test("the length lock follows the plan: it clears when a paid tier arrives after the video", () => {
  const p = loadEditor();
  p.set({ IS_PRO: false, videoDuration: 50 * 60 });
  p.run("updateLengthLock();");
  assert.equal(p.get("lengthLocked"), true);
  assert.equal(p.context.document.getElementById("length-lock").classList.contains("show"), true);
  p.set({ IS_PRO: true });
  p.run("updateLengthLock();");
  assert.equal(p.get("lengthLocked"), false);
  assert.equal(p.context.document.getElementById("length-lock").classList.contains("show"), false);
  p.set({ IS_PRO: false, videoDuration: 10 * 60 });
  p.run("updateLengthLock();");
  assert.equal(p.get("lengthLocked"), false);
});
