/**
 * SubCaptions transcription service (auto-captions / Whisper).
 *
 * Why this exists as a separate server (not the Cloudflare Worker):
 * transcribing a YouTube or Vimeo video needs the AUDIO, which the browser
 * cannot reach inside an embed. This service pulls the audio for ANY source
 * with yt-dlp (YouTube, Vimeo, Rushes, direct files, 1000+ sites), extracts and
 * chunks it with ffmpeg, runs Whisper, and returns timed cues. Workers can't run
 * yt-dlp/ffmpeg, so this runs on a normal container host (Fly.io / Render / Cloud Run).
 *
 * POST /transcribe  { url, language? }  ->  { cues: [{start, end, text}] }
 *   Authorization: Bearer <PRO_TOKEN>   (auto-captions are Pro-only)
 *
 * Env:
 *   OPENAI_API_KEY   required. Whisper key (or a Groq key if WHISPER_BASE points to Groq).
 *   WHISPER_BASE     default https://api.openai.com/v1 . Set to Groq for cheaper/faster.
 *   WHISPER_MODEL    default whisper-1 (use whisper-large-v3 on Groq).
 *   PRO_TOKEN        shared secret the front end sends until real per-user auth exists.
 *   ALLOWED_ORIGIN   default * . Set to your domain before launch.
 *   MAX_MINUTES      default 240. Hard cap to bound cost/abuse, checked BEFORE downloading.
 *   YTDLP_PROXY      optional. http(s) proxy for yt-dlp (needed for reliable YouTube at scale).
 *                    When set, yt-dlp bypasses the egress guard (see guard.mjs).
 *   DEV_ALLOW_ALL    "true" treats every caller as Team, but only when SUPABASE_URL and
 *                    PRO_TOKEN are both unset. Local testing only.
 *   PEAKS_PER_10MIN  default 20. /peaks requests per client IP per 10 minutes.
 *   TRUST_PROXY_HOPS default 1. Proxies in front of this app (Render's), so req.ip is the client.
 *
 * Every URL is checked by guard.mjs (http(s), default port, public address only) and
 * yt-dlp / ffprobe / ffmpeg reach the network only through its egress proxy.
 *
 * Cost: Whisper is ~$0.006/min on OpenAI (cheaper on Groq). A 45-min video ~ $0.27.
 *
 * IMPORTANT: downloading YouTube/Vimeo audio is against their Terms of Service,
 * and YouTube blocks datacenter IPs aggressively. For anything beyond light use
 * you will need residential/rotating proxies (YTDLP_PROXY) and should review the
 * legal posture. Direct-file sources (Dropbox, Drive, Rushes, mp4) have none of
 * these issues.
 */
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GuardError, PlanCheckError, validateMediaUrl, startEgressGuard, tierFor, isSignedIn,
  burnHeightFor, makeRateLimiter, authConfigWarnings,
} from "./guard.mjs";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "1", 10));

for (const w of authConfigWarnings()) console.error(w);

// Loopback proxy that re-checks every connection the child processes open.
const egress = await startEgressGuard();
console.log(`egress guard on ${egress.url}`);

// Child processes get a minimal environment: no API keys to leak, and all their
// HTTP(S) traffic goes through the egress guard (ffmpeg reads http_proxy).
const CHILD_ENV = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
  http_proxy: egress.url, https_proxy: egress.url, HTTP_PROXY: egress.url, HTTPS_PROXY: egress.url, no_proxy: "", NO_PROXY: "",
}).filter(([, v]) => v !== undefined));
const exec = promisify(execFile);
const run = (cmd, args, opts = {}) => exec(cmd, args, { env: CHILD_ENV, ...opts });

const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const WHISPER_BASE = (process.env.WHISPER_BASE || "https://api.openai.com/v1").replace(/\/$/, "");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const MAX_MINUTES = parseInt(process.env.MAX_MINUTES || "240", 10);
const CHUNK_SECONDS = 600; // 10-min chunks keep each upload well under Whisper's 25MB limit

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ORIGIN);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const BUILD = "2026-11-03-hardening"; // bump on deploy to verify what's live
app.get("/healthz", (_req, res) => res.json({ ok: true, build: BUILD }));

const TOO_LONG = { error: `Video exceeds the ${MAX_MINUTES}-minute limit` };

// Failed jobs answer with a short fixed message. The detail (command lines,
// stderr, temp paths, the egress proxy port, upstream error bodies) goes to the
// log only. A JobError carries the message meant for the user.
const READ_FAILED = "We couldn't read that video. Check the link plays in your browser and try again.";
class JobError extends Error {
  constructor(userMessage, detail) { super(detail || userMessage); this.userMessage = userMessage; }
}
function sendJobError(res, tag, e, fallback) {
  console.error(`[${tag}] ERROR: ${(e && e.message) || e}`);
  if (!res.headersSent) res.status(502).json({ error: e instanceof JobError ? e.userMessage : fallback });
}

// Plan for the caller, or null after answering 503 when Supabase can't be
// reached (a paying user must not be treated as free during an outage).
async function planOr503(req, res) {
  try { return await tierFor(req); }
  catch (e) {
    console.error(`[plan] ${e instanceof PlanCheckError ? "" : "unexpected: "}${e.message}`);
    res.status(503).json({ error: "Could not check your plan, please try again" });
    return null;
  }
}

// Common yt-dlp flags. --proxy sends every request through the egress guard, or
// through YTDLP_PROXY when that is set (then only the up-front URL check applies).
const ytdlpCommon = () => ["--no-playlist", "--proxy", process.env.YTDLP_PROXY || egress.url];

// Media length in seconds read WITHOUT downloading, or null if unknown.
// ffprobe first: for a direct file it reads the header (plus the index at the
// end via a range request), not the whole body. Pages that need an extractor
// (YouTube, Vimeo, large Drive files) fall through to yt-dlp's metadata.
async function remoteDuration(url) {
  const p = await run("ffprobe", [
    "-v", "error", "-protocol_whitelist", "http,https,tls,tcp,httpproxy", "-rw_timeout", "15000000",
    "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url,
  ], { timeout: 45000 }).catch(() => null);
  const d = p ? parseFloat(p.stdout.trim()) : NaN;
  if (d > 0) return d;
  const m = await run("yt-dlp", [...ytdlpCommon(), "--print", "duration", "--", url], { timeout: 60000 }).catch(() => null);
  const d2 = m ? parseFloat(m.stdout.trim()) : NaN; // "NA" when the site gives no duration
  return d2 > 0 ? d2 : null;
}

// Length of a downloaded file. -protocol_whitelist file stops a downloaded
// playlist (HLS, concat) from making ffmpeg fetch anything else.
async function localDuration(inPath) {
  const probe = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]).catch(() => null);
  return probe ? parseFloat(probe.stdout.trim()) || 0 : 0;
}

// Validate the request's url and refuse over-cap media before any download.
// Returns the normalized URL string, or null after sending the error response.
async function checkSource(req, res) {
  let u;
  try { u = await validateMediaUrl((req.body || {}).url); }
  catch (e) {
    res.status(e instanceof GuardError ? e.status : 400).json({ error: e instanceof GuardError ? e.message : "Valid url required" });
    return null;
  }
  const d = await remoteDuration(u.href);
  if (d && d > MAX_MINUTES * 60) { res.status(413).json(TOO_LONG); return null; }
  return u.href;
}

// Download with yt-dlp into dir; returns the file path or throws a JobError.
async function download(url, dir, format, timeout) {
  try {
    await run("yt-dlp", ["-f", format, ...ytdlpCommon(), "-o", path.join(dir, "in.%(ext)s"), "--", url], { timeout });
  } catch (e) { throw new JobError(READ_FAILED, `yt-dlp failed: ${e.message}`); }
  const f = (await fs.readdir(dir)).find((n) => n.startsWith("in."));
  if (!f) throw new JobError(READ_FAILED, "yt-dlp produced no file");
  return path.join(dir, f);
}

app.post("/transcribe", async (req, res) => {
  // Pro gate
  const tier = await planOr503(req, res);
  if (!tier) return;
  if (tier === "free") return res.status(402).json({ error: "Pro required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server not configured" });

  const { language } = req.body || {};
  const url = await checkSource(req, res);
  if (!url) return;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subcap-"));
  const t0 = Date.now();
  const log = (m) => console.log(`[transcribe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  try {
    log(`start host=${new URL(url).host}`); // not the full URL: signed links carry tokens
    // 1. Pull the best audio for any source.
    const inPath = await download(url, dir, "bestaudio/best", 1000 * 60 * 10);
    log(`downloaded ${path.basename(inPath)}`);

    // 2. Guard duration again (backstop for sources whose length was unknown up front).
    const duration = await localDuration(inPath);
    if (duration && duration > MAX_MINUTES * 60) return res.status(413).json(TOO_LONG);
    log(`duration=${duration}s, extracting audio`);

    // 3. Normalize to 16kHz mono mp3 and split into chunks Whisper can swallow.
    await run("ffmpeg", [
      "-protocol_whitelist", "file", "-i", inPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
      "-reset_timestamps", "1", path.join(dir, "chunk_%03d.mp3"),
    ], { timeout: 1000 * 60 * 10 });

    const chunks = (await fs.readdir(dir)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new JobError("We couldn't find any audio in that video.", "No audio extracted");
    log(`chunked into ${chunks.length}, transcribing`);

    // 4. Transcribe each chunk, offsetting timestamps by the chunk's position.
    const cues = [];
    for (let i = 0; i < chunks.length; i++) {
      const offset = i * CHUNK_SECONDS;
      log(`whisper chunk ${i + 1}/${chunks.length}`);
      const { segments, words } = await whisper(path.join(dir, chunks[i]), language);
      for (const c of buildCues(segments, words)) {
        const text = (c.text || "").trim();
        if (text) cues.push({ start: +(c.start + offset).toFixed(3), end: +(c.end + offset).toFixed(3), text });
      }
    }
    log(`done, ${cues.length} cues`);

    res.json({ cues });
  } catch (e) {
    sendJobError(res, `transcribe +${((Date.now() - t0) / 1000).toFixed(1)}s`, e, "Transcription failed. Please try again in a moment.");
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const WHISPER_FAILED = "The transcription service didn't respond. Please try again in a moment.";
async function whisper(filePath, language) {
  const buf = await fs.readFile(filePath);
  const fd = new FormData();
  fd.append("model", WHISPER_MODEL);
  fd.append("response_format", "verbose_json");
  // Ask for word-level timestamps in addition to segments. Segment start times
  // sit in the silence before speech (captions appear too early); word timings
  // let us snap each caption to the actual first/last spoken word.
  fd.append("timestamp_granularities[]", "segment");
  fd.append("timestamp_granularities[]", "word");
  if (language) fd.append("language", language);
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");

  // Hard timeout so a stalled upstream can't hang the whole request indefinitely.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1000 * 60 * 4);
  let r;
  try {
    r = await fetch(`${WHISPER_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new JobError(WHISPER_FAILED, e.name === "AbortError" ? "Whisper request timed out" : `Whisper request failed: ${e.message}`);
  } finally { clearTimeout(timer); }
  if (!r.ok) { const detail = await r.text().catch(() => ""); throw new JobError(WHISPER_FAILED, `Whisper error ${r.status} ${detail.slice(0, 200)}`); }
  const data = await r.json();
  return { segments: data.segments || [], words: data.words || [] };
}

// Caption styling rules, Netflix-style: at most two lines, ~42 chars per line,
// so a single long Whisper segment becomes several short, well-timed cues
// instead of one block that wraps to three or four lines on screen.
// Rules derived from professional broadcast captions (analysed against NASA's
// official SRT for this footage): two FILLED lines per cue (~44 chars/line),
// ~6s average on screen, ~15 chars/sec reading speed, don't fragment at every
// sentence, break lines at punctuation/balanced points without dangling words.
const MAX_LINE = 42;          // characters per line (Netflix standard; NASA ran to ~50)
const MAX_CHARS = MAX_LINE * 2; // a cue is at most two lines
const HARD_MAX_DUR = 16;     // a cue can linger this long on slow speech (NASA hit ~18)
const FILL = 50;             // only break early at a sentence end once the cue is this full
const GAP = 0.85;            // a silent pause longer than this forces a new cue
const CPS = 15;              // target reading speed (chars/sec) -> drives min on-screen time
// Short function words we avoid leaving stranded at the end of line one.
const FUNC = new Set(["a","an","the","of","to","in","on","at","and","or","but","for","with","is","are","was","were","we","i","he","she","it","you","they","that","this","my","your","our","as","so","be","by"]);

// Join word tokens into clean text (Whisper returns words without spacing).
function textOf(toks) {
  return toks.map((w) => (w.word || "").trim()).join(" ")
    .replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
}

// Break into at most two lines at the best point: balanced length, strongly
// preferring a break right after punctuation, and never leaving a short function
// word stranded at the end of line one.
function wrap2(text) {
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_LINE) return text;
  const w = text.split(" ");
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < w.length - 1; i++) {
    const l1 = w.slice(0, i + 1).join(" "), l2 = w.slice(i + 1).join(" ");
    if (l1.length > MAX_LINE) break;       // line one already too long; no point going further
    if (l2.length > MAX_LINE) continue;     // line two wouldn't fit; try a later split
    let score = Math.abs(l1.length - l2.length);            // prefer balanced lines
    if (/[,.!?;:]$/.test(w[i])) score -= 20;                 // strongly prefer breaking after punctuation
    if (FUNC.has(w[i].toLowerCase().replace(/[^a-z']/g, ""))) score += 12; // avoid dangling function word
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) { // nothing fit two lines cleanly; fall back to a middle break
    const mid = Math.floor(text.length / 2);
    const l = text.lastIndexOf(" ", mid), r = text.indexOf(" ", mid);
    const s = l > 0 ? l : r;
    return s > 0 ? text.slice(0, s) + "\n" + text.slice(s + 1) : text;
  }
  return w.slice(0, best + 1).join(" ") + "\n" + w.slice(best + 1).join(" ");
}

const MIN_DUR = 1.3;   // a cue shouldn't flash for less than this
const MIN_CHARS = 18;  // merge a cue shorter than this into a neighbour (kills orphan words)

function tokenize(text) { return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean); }
function joinTokens(toks) { return toks.join(" ").replace(/\s+([,.!?;:])/g, "$1"); }

// Turn Whisper output into screen-ready cues. Caption TEXT comes from the segment
// text (keeps punctuation + capitalization); each display word is paired with its
// word-level timestamp so every cue is timed to the actual speech. Cues break at
// sentence ends, natural pauses, line-length, and max duration; a final pass
// merges orphan/too-short cues and enforces a sane minimum on-screen time.
function buildCues(segments, words) {
  const segs = Array.isArray(segments) ? segments : [];
  const hasWords = Array.isArray(words) && words.length;
  let out = [];
  for (const s of segs) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const inside = hasWords ? words.filter((w) => w.end > s.start && w.start < s.end) : [];
    const disp = tokenize(text);
    // Best path: display words (with punctuation) line up 1:1 with timed words.
    if (inside.length && inside.length === disp.length) {
      out.push(...packTimed(disp.map((tok, i) => ({ tok, start: inside[i].start, end: inside[i].end }))));
      continue;
    }
    // Fallback: keep punctuation, approximate timing from the segment span.
    let start = s.start, end = s.end;
    if (inside.length) { start = inside[0].start; end = inside[inside.length - 1].end; }
    if (text.length <= MAX_CHARS) { out.push({ start, end, text: wrap2(text) }); continue; }
    const pieces = []; let cur = "";
    for (const w of disp) { const n = cur ? cur + " " + w : w; if (cur && n.length > MAX_CHARS) { pieces.push(cur); cur = w; } else cur = n; }
    if (cur) pieces.push(cur);
    const totalLen = pieces.reduce((n, p) => n + p.length, 0) || 1, span = Math.max(0, end - start);
    let t = start;
    pieces.forEach((p, i) => { const pe = i === pieces.length - 1 ? end : t + span * (p.length / totalLen); out.push({ start: t, end: pe, text: wrap2(p) }); t = pe; });
  }
  if (!out.length && hasWords) out = packTimed(words.map((w) => ({ tok: w.word || "", start: w.start, end: w.end })));
  return cleanup(out);
}

// Pack timed tokens into <=2-line cues, breaking at sentence ends, pauses, length, duration.
function packTimed(toks) {
  const cues = [];
  let cur = [];
  const flush = () => { if (cur.length) { cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: wrap2(joinTokens(cur.map((x) => x.tok))) }); cur = []; } };
  for (const tk of toks) {
    if (cur.length) {
      const curText = joinTokens(cur.map((x) => x.tok));
      const prospective = joinTokens(cur.concat([tk]).map((x) => x.tok));
      const gap = tk.start - cur[cur.length - 1].end;
      const dur = tk.end - cur[0].start;
      const sentenceEnd = /[.!?]["')\]]?$/.test(curText);
      // Break when: the two lines are full, a real pause occurs, the cue would
      // run too long, or a sentence ends AND the cue is already well-filled
      // (so we don't fragment on every short sentence the way we used to).
      if (prospective.length > MAX_CHARS || gap > GAP || dur > HARD_MAX_DUR || (sentenceEnd && curText.length >= FILL)) flush();
    }
    cur.push(tk);
  }
  flush();
  return cues;
}

// Merge orphan/too-short cues into a neighbour and enforce a minimum on-screen time.
function cleanup(cues) {
  const small = (c) => c.text.replace(/\n/g, " ").length < MIN_CHARS || (c.end - c.start) < 0.7;
  // Pass 1: merge a too-short cue BACKWARD into the previous one when it fits.
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && small(c)) {
      const combined = prev.text.replace(/\n/g, " ") + " " + c.text.replace(/\n/g, " ");
      if (combined.length <= MAX_CHARS && (c.end - prev.start) <= HARD_MAX_DUR) { prev.text = wrap2(combined); prev.end = c.end; continue; }
    }
    merged.push({ ...c });
  }
  // Pass 2: a short cue that couldn't merge back (e.g. a leading orphan) merges FORWARD into the next.
  for (let i = 0; i < merged.length - 1; i++) {
    const c = merged[i], next = merged[i + 1];
    if (small(c)) {
      const combined = c.text.replace(/\n/g, " ") + " " + next.text.replace(/\n/g, " ");
      if (combined.length <= MAX_CHARS && (next.end - c.start) <= HARD_MAX_DUR) { next.text = wrap2(combined); next.start = c.start; merged.splice(i, 1); i--; }
    }
  }
  // Hold each cue on screen long enough to read it (reading-speed floor), without
  // overlapping the next cue. This is what gives the professional ~6s-average feel.
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i], next = merged[i + 1];
    const chars = c.text.replace(/\n/g, " ").length;
    const need = Math.max(MIN_DUR, chars / CPS);
    if (c.end - c.start < need) {
      const want = c.start + need;
      c.end = next ? Math.max(c.start + 0.4, Math.min(want, next.start - 0.04)) : want;
    }
  }
  return merged;
}

// Burn subtitles permanently into the video (Pro). Server-side because it needs
// the source file and a full re-encode. Cost controls: we downscale to a height
// cap (1080 for Solo, up to 2160 for Team) and use a fast x264 preset, so CPU
// time and the output file (the bandwidth cost) stay bounded. This is the one
// feature with real per-render cost, which is why it sits behind the paid tiers.
app.post("/burn", async (req, res) => {
  const tier = await planOr503(req, res);
  if (!tier) return;
  const { srt, maxHeight } = req.body || {};
  // Height must be one of BURN_HEIGHTS; Solo is capped at 1080, Team at 2160, Free refused.
  const h = burnHeightFor(tier, maxHeight);
  if (h.error) return res.status(h.status).json({ error: h.error });
  const height = h.height;
  // Must start like SRT (a cue number): the subtitles filter probes the file's format,
  // and this keeps a playlist or ffconcat file from being passed off as subtitles.
  if (!srt || typeof srt !== "string" || !/^﻿?\s*\d+[ \t]*\r?\n/.test(srt)) return res.status(400).json({ error: "srt text required" });
  const url = await checkSource(req, res);
  if (!url) return;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "burn-"));
  try {
    await fs.writeFile(path.join(dir, "subs.srt"), srt, "utf8");
    const inPath = await download(url, dir, "bv*+ba/b", 1000 * 60 * 10);

    const duration = await localDuration(inPath);
    if (duration && duration > MAX_MINUTES * 60) return res.status(413).json(TOO_LONG);

    const outPath = path.join(dir, "out.mp4");
    // subtitles filter renders the .srt into the picture; scale caps the height (and cost).
    await run("ffmpeg", [
      "-protocol_whitelist", "file", "-i", inPath,
      "-vf", `scale=-2:'min(${height},ih)',subtitles='${path.join(dir, "subs.srt")}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath,
    ], { timeout: 1000 * 60 * 30 });

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", 'attachment; filename="subcaptions-burned.mp4"');
    const buf = await fs.readFile(outPath);
    res.send(buf);
  } catch (e) {
    sendJobError(res, "burn", e, "We couldn't render that video. Please try again.");
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// Waveform peaks for any source the server can fetch (direct/S3/Dropbox/Drive/R2/Frame.io).
// Just an audio download + a fast ffmpeg PCM pass, no Whisper, so it's cheap. Returns a
// small {duration, peaks[0..1]} the browser draws. (YouTube/Vimeo excluded, same as transcribe.)
// Stays open to signed-in Free accounts: the free editor's waveform falls back to this
// route whenever the browser can't decode the file itself (index.html buildWaveform).
// Cost is bounded by the URL guard, the duration cap and a per-IP rate limit.
const peaksLimit = makeRateLimiter({ limit: parseInt(process.env.PEAKS_PER_10MIN || "20", 10), windowMs: 10 * 60 * 1000 });
app.post("/peaks", async (req, res) => {
  const rl = peaksLimit(req.ip || "unknown");
  if (!rl.ok) { res.set("Retry-After", String(rl.retryAfterSec)); return res.status(429).json({ error: "Too many waveform requests, please wait a few minutes." }); }
  let signedIn;
  try { signedIn = await isSignedIn(req); }
  catch (e) { console.error(`[plan] ${e.message}`); return res.status(503).json({ error: "Could not check your plan, please try again" }); }
  if (!signedIn) return res.status(401).json({ error: "Sign in to load the waveform for this source." });
  const url = await checkSource(req, res);
  if (!url) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "peaks-"));
  try {
    const inPath = await download(url, dir, "bestaudio/best", 1000 * 60 * 8);
    const duration = await localDuration(inPath);
    if (duration && duration > MAX_MINUTES * 60) return res.status(413).json(TOO_LONG);
    const pcmPath = path.join(dir, "a.pcm");
    await run("ffmpeg", ["-protocol_whitelist", "file", "-i", inPath, "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", pcmPath], { timeout: 1000 * 60 * 8 });
    const b = await fs.readFile(pcmPath);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    const samples = new Int16Array(ab);
    const N = 800, win = Math.max(1, Math.floor(samples.length / N)), peaks = [];
    for (let i = 0; i < N; i++){ let max = 0; const s = i * win; for (let j = 0; j < win; j++){ const v = Math.abs(samples[s + j] || 0); if (v > max) max = v; } peaks.push(+(max / 32768).toFixed(3)); }
    res.json({ duration: duration || samples.length / 4000, peaks });
  } catch(e){ sendJobError(res, "peaks", e, "We couldn't build the waveform for that video."); }
  finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

// Anything that reaches Express's own error handler (a malformed JSON body, an
// oversized one) gets a short JSON answer instead of the default page, which
// outside NODE_ENV=production includes the stack trace.
app.use((err, req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  console.error(`[${req.method} ${req.path}] ${status}: ${err.message}`);
  if (res.headersSent) return;
  res.set("Access-Control-Allow-Origin", ORIGIN);
  res.status(status).json({ error: status === 413 ? "Request too large" : status < 500 ? "Bad request" : "Server error" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`transcribe-server listening on :${PORT}`));
