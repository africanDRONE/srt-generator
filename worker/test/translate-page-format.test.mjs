// Offline tests for the subtitle formatting in translate.html: timestamps (tcToSeconds,
// secondsToTc), import (vttToPlain, parseSubtitles) and export (cueText, buildCol). The
// functions are extracted from the real page source, as in pages-retry.test.mjs, and run in
// a fresh node:vm context. Nothing is re-implemented here.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = fs.readFileSync(fileURLToPath(new URL("../../translate.html", import.meta.url)), "utf8");

// ---- Extraction (same approach as pages-retry.test.mjs) ----

function skipStringLiteral(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === quote) return i;
    i++;
  }
  return i;
}

function skipTemplateLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === "`") return i;
    if (source[i] === "$" && source[i + 1] === "{") {
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

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start === -1) throw new Error('could not find "function ' + name + '(" in translate.html');
  let i = source.indexOf("(", start);
  for (let depth = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) { i++; break; }
  }
  while (source[i] !== "{") i++;
  let depth = 0, j = i;
  for (; j < source.length; j++) {
    const ch = source[j];
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) { j++; break; } }
    else if (ch === '"' || ch === "'") j = skipStringLiteral(source, j, ch);
    else if (ch === "`") j = skipTemplateLiteral(source, j);
    else if (ch === "/" && source[j + 1] === "/") { const nl = source.indexOf("\n", j); j = nl === -1 ? source.length : nl; }
    else if (ch === "/" && source[j + 1] === "*") { const end = source.indexOf("*/", j + 2); j = end === -1 ? source.length : end + 1; }
  }
  if (depth !== 0) throw new Error('unbalanced braces extracting "' + name + '"');
  const text = source.slice(start, j);
  new Function(text); // throws if the extracted text is not a whole declaration
  return text;
}

const NAMES = ["tcToSeconds", "secondsToTc", "vttToPlain", "cueText", "parseSubtitles", "buildCol"];
const SCRIPT = new vm.Script(NAMES.map((n) => extractFunction(PAGE, n)).join("\n"), { filename: "translate.html:format" });

// A fresh context per call. cues and langCols are the page globals buildCol reads.
function page(cues = [], langCols = []) {
  const ctx = vm.createContext({ cues, langCols, SOURCE_KEY: "__source__" });
  SCRIPT.runInContext(ctx);
  return ctx;
}

// The expected timecode, built from an integer millisecond count with no float maths.
function tcFromMs(total, sep = ",") {
  const p = (n, l) => String(n).padStart(l, "0");
  return `${p(Math.floor(total / 3600000), 2)}:${p(Math.floor(total / 60000) % 60, 2)}:${p(Math.floor(total / 1000) % 60, 2)}${sep}${p(total % 1000, 3)}`;
}

// ---- Timestamps ----

test("F1: secondsToTc is exact for every millisecond in the first 10 minutes", () => {
  const { secondsToTc } = page();
  let wrong = 0, firstWrong = null;
  for (let ms = 0; ms <= 600000; ms++) {
    const got = secondsToTc(ms / 1000);
    if (got !== tcFromMs(ms)) { wrong++; firstWrong ??= `${ms} ms gave ${got}`; }
  }
  assert.equal(wrong, 0, `first wrong value: ${firstWrong}`);
});

test("F2: values the old code got wrong, hour-long times and the VTT separator", () => {
  const { secondsToTc } = page();
  assert.equal(secondsToTc(1.239), "00:00:01,239");
  assert.equal(secondsToTc(1.005), "00:00:01,005");
  assert.equal(secondsToTc(4.35), "00:00:04,350");
  assert.equal(secondsToTc(59.9996), "00:01:00,000"); // never ",1000"
  assert.equal(secondsToTc(3599.9999), "01:00:00,000");
  assert.equal(secondsToTc(3723.456, true), "01:02:03.456");
  assert.equal(secondsToTc(36000 + 0.001), "10:00:00,001");
});

test("F3: missing, NaN and negative times export as zero", () => {
  const { secondsToTc } = page();
  for (const v of [null, undefined, NaN, -1, -0.0004]) assert.equal(secondsToTc(v), "00:00:00,000");
});

test("F4: a timecode survives import and export unchanged, for SRT and VTT forms", () => {
  const { secondsToTc, tcToSeconds } = page();
  for (let ms = 0; ms < 7200000; ms += 997) {
    const tc = tcFromMs(ms);
    assert.equal(secondsToTc(tcToSeconds(tc)), tc);
    assert.equal(secondsToTc(tcToSeconds(tc.replace(",", ".")), true), tc.replace(",", "."));
  }
  assert.equal(secondsToTc(tcToSeconds("01:02.345")), "00:01:02,345"); // VTT short form
});

// ---- VTT export escaping ----

test("F5: VTT cue text escapes &, < and > and keeps <i>, <b> and <u>", () => {
  const { cueText } = page();
  assert.equal(cueText("Tom & Jerry", true), "Tom &amp; Jerry");
  assert.equal(cueText("I <3 you > them", true), "I &lt;3 you &gt; them");
  assert.equal(cueText("a --> b", true), "a --&gt; b");
  assert.equal(cueText("<i>Hi</i>, <b>bold</b> and <u>under</u>", true), "<i>Hi</i>, <b>bold</b> and <u>under</u>");
  assert.equal(cueText("<I>Shout</I>", true), "<i>Shout</i>");
  assert.equal(cueText("<script>x</script> <img src=y>", true), "&lt;script&gt;x&lt;/script&gt; &lt;img src=y&gt;");
  assert.equal(cueText('<font color="red">Red</font> & <i>it</i>', true), "Red &amp; <i>it</i>");
  assert.equal(cueText("&amp; stays literal", true), "&amp;amp; stays literal");
});

test("F6: SRT cue text goes out as written, and a blank line inside a cue is closed up", () => {
  const { cueText } = page();
  assert.equal(cueText("Tom & Jerry <i>x</i> <3", false), "Tom & Jerry <i>x</i> <3");
  assert.equal(cueText("one\n\n  \ntwo", false), "one\ntwo");
  assert.equal(cueText("one\n\ntwo", true), "one\ntwo");
  assert.equal(cueText(undefined, true), "");
});

// ---- Import ----

test("F7: SRT import keeps <i>, <b>, <u> and literal characters", () => {
  const { parseSubtitles } = page();
  const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> & <b>bye</b>\n<u>x</u> <3\n\n2\n00:00:03,000 --> 00:00:04,000\nPlain");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "<i>Hello</i> & <b>bye</b>\n<u>x</u> <3");
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].text, "Plain");
});

test("F8: VTT import decodes entities once, keeps <i>, <b>, <u> and drops VTT-only tags", () => {
  const { parseSubtitles } = page();
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:02.000 align:start",
    "<v Bob>Tom &amp; Jerry &lt;3</v>",
    "",
    "00:00:03.000 --> 00:00:04.000",
    "<i.loud>Hey</i> <c.yellow>you</c> <00:00:03.500><b>now</b>",
    "",
    "00:00:05.000 --> 00:00:06.000",
    "&amp;lt; is not &lt; &#38; &#x26; &nbsp;x &bogus;",
  ].join("\n");
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, "Tom & Jerry <3");
  assert.equal(cues[1].text, "<i>Hey</i> you <b>now</b>");
  assert.equal(cues[2].text, "&lt; is not < & &  x &bogus;");
});

test("F9: VTT in, VTT out does not double-escape, and a second pass changes nothing", () => {
  const src = "WEBVTT\n\n00:00:01.239 --> 00:00:02.005\nTom &amp; Jerry &lt;3 <i>yes</i>\n";
  const first = page(page().parseSubtitles(src));
  const out = first.buildCol("__source__", true);
  assert.equal(out, "WEBVTT\n\n1\n00:00:01.239 --> 00:00:02.005\nTom &amp; Jerry &lt;3 <i>yes</i>\n");
  const second = page(page().parseSubtitles(out));
  assert.equal(second.buildCol("__source__", true), out);
});

test("F10: SRT in, VTT out escapes once; SRT out is unchanged", () => {
  const src = "1\n00:00:01,000 --> 00:00:02,000\n<i>Fish</i> & chips <3\n";
  const p = page(page().parseSubtitles(src), [{ code: "fr", name: "French", lines: ["<i>Poisson</i> & frites"] }]);
  assert.equal(p.buildCol("__source__", false), src);
  assert.equal(p.buildCol("__source__", true), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<i>Fish</i> &amp; chips &lt;3\n");
  assert.equal(p.buildCol("fr", true), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<i>Poisson</i> &amp; frites\n");
});

// ---- Copy ----

test("F11: the page states the real language count and has no stale plan or upload wording", () => {
  const count = JSON.parse(PAGE.match(/const LANGUAGES = (\[.*?\]\]);/)[1]).length;
  const title = PAGE.match(/<title>([^<]*)<\/title>/)[1];
  const meta = PAGE.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.match(title, new RegExp(`\\b${count} Languages\\b`));
  assert.match(meta, new RegExp(`\\b${count} languages\\b`));
  assert.doesNotMatch(PAGE, /\d+\+ languages/i);
  assert.doesNotMatch(PAGE, /\bPro\b/);
  assert.doesNotMatch(PAGE, /never (stored|uploaded)/i);
  assert.doesNotMatch(PAGE, /save 20/i);
  assert.doesNotMatch(PAGE, /\u2014/); // no em dashes
});
