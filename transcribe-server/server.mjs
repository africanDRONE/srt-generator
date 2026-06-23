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
 *   MAX_MINUTES      default 240. Hard cap to bound cost/abuse.
 *   YTDLP_PROXY      optional. http(s) proxy for yt-dlp (needed for reliable YouTube at scale).
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

const run = promisify(execFile);
const app = express();
app.use(express.json({ limit: "1mb" }));

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

const BUILD = "2026-06-24-cues-v3-pro"; // bump on deploy to verify what's live
app.get("/healthz", (_req, res) => res.json({ ok: true, build: BUILD }));

// Resolve the caller's subscription tier from their Supabase access token.
// Dev fallback: if SUPABASE_URL isn't set, use the simple PRO_TOKEN shared secret
// (or allow everything if neither is configured, for local testing).
async function tierFor(req) {
  if (!process.env.SUPABASE_URL) {
    if (process.env.PRO_TOKEN) {
      const a = req.get("authorization") || "";
      return a === `Bearer ${process.env.PRO_TOKEN}` ? "team" : "free";
    }
    return "team";
  }
  const a = req.get("authorization") || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : null;
  if (!token) return "free";
  try {
    const ures = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      // Fall back to the service-role key as apikey so this works even if
      // SUPABASE_ANON_KEY isn't set on this service.
      headers: { apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!ures.ok) return "free";
    const user = await ures.json();
    if (!user?.id) return "free";
    const pres = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=tier`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!pres.ok) return "free";
    const rows = await pres.json();
    return rows[0]?.tier || "free";
  } catch (e) {
    return "free";
  }
}

app.post("/transcribe", async (req, res) => {
  // Pro gate
  if ((await tierFor(req)) === "free") return res.status(402).json({ error: "Pro required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server not configured" });

  const { url, language } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Valid url required" });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subcap-"));
  const t0 = Date.now();
  const log = (m) => console.log(`[transcribe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  try {
    log(`start url=${url}`);
    // 1. Pull the best audio for any source.
    const ytdlpArgs = ["-f", "bestaudio/best", "--no-playlist", "-o", path.join(dir, "in.%(ext)s")];
    if (process.env.YTDLP_PROXY) ytdlpArgs.push("--proxy", process.env.YTDLP_PROXY);
    ytdlpArgs.push(url);
    await run("yt-dlp", ytdlpArgs, { timeout: 1000 * 60 * 10 });

    const downloaded = (await fs.readdir(dir)).find((f) => f.startsWith("in."));
    if (!downloaded) throw new Error("Could not fetch audio for that link");
    const inPath = path.join(dir, downloaded);
    log(`downloaded ${downloaded}`);

    // 2. Guard duration.
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]).catch(() => null);
    const duration = probe ? parseFloat(probe.stdout.trim()) : 0;
    if (duration && duration > MAX_MINUTES * 60) {
      return res.status(413).json({ error: `Video exceeds the ${MAX_MINUTES}-minute limit` });
    }
    log(`duration=${duration}s, extracting audio`);

    // 3. Normalize to 16kHz mono mp3 and split into chunks Whisper can swallow.
    await run("ffmpeg", [
      "-i", inPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
      "-reset_timestamps", "1", path.join(dir, "chunk_%03d.mp3"),
    ], { timeout: 1000 * 60 * 10 });

    const chunks = (await fs.readdir(dir)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error("No audio extracted");
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
    console.error(`[transcribe +${((Date.now() - t0) / 1000).toFixed(1)}s] ERROR: ${e.message}`);
    res.status(502).json({ error: e.message || "Transcription failed" });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

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
    throw new Error(e.name === "AbortError" ? "Whisper request timed out" : `Whisper request failed: ${e.message}`);
  } finally { clearTimeout(timer); }
  if (!r.ok) { const detail = await r.text().catch(() => ""); throw new Error(`Whisper error ${r.status} ${detail.slice(0, 200)}`); }
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
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    const flat = c.text.replace(/\n/g, " ");
    const tooSmall = flat.length < MIN_CHARS || (c.end - c.start) < 0.7;
    if (prev && tooSmall) {
      const combined = prev.text.replace(/\n/g, " ") + " " + flat;
      if (combined.length <= MAX_CHARS && (c.end - prev.start) <= MAX_DUR) { prev.text = wrap2(combined); prev.end = c.end; continue; }
    }
    merged.push({ ...c });
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
  if ((await tierFor(req)) === "free") return res.status(402).json({ error: "Pro required" });
  const { url, srt, maxHeight } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Valid url required" });
  if (!srt || typeof srt !== "string") return res.status(400).json({ error: "srt text required" });
  const height = Math.min(parseInt(maxHeight || "1080", 10) || 1080, 2160); // Solo 1080, Team up to 2160

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "burn-"));
  try {
    await fs.writeFile(path.join(dir, "subs.srt"), srt, "utf8");
    const ytdlpArgs = ["-f", "bv*+ba/b", "--no-playlist", "-o", path.join(dir, "in.%(ext)s")];
    if (process.env.YTDLP_PROXY) ytdlpArgs.push("--proxy", process.env.YTDLP_PROXY);
    ytdlpArgs.push(url);
    await run("yt-dlp", ytdlpArgs, { timeout: 1000 * 60 * 10 });
    const downloaded = (await fs.readdir(dir)).find((f) => f.startsWith("in."));
    if (!downloaded) throw new Error("Could not fetch the video for that link");
    const inPath = path.join(dir, downloaded);

    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]).catch(() => null);
    const duration = probe ? parseFloat(probe.stdout.trim()) : 0;
    if (duration && duration > MAX_MINUTES * 60) return res.status(413).json({ error: `Video exceeds the ${MAX_MINUTES}-minute limit` });

    const outPath = path.join(dir, "out.mp4");
    // subtitles filter renders the .srt into the picture; scale caps the height (and cost).
    await run("ffmpeg", [
      "-i", inPath,
      "-vf", `scale=-2:'min(${height},ih)',subtitles='${path.join(dir, "subs.srt")}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath,
    ], { timeout: 1000 * 60 * 30 });

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", 'attachment; filename="subcaptions-burned.mp4"');
    const buf = await fs.readFile(outPath);
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message || "Render failed" });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`transcribe-server listening on :${PORT}`));
