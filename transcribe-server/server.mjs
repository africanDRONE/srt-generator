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

app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
  try {
    // 1. Pull the best audio for any source.
    const ytdlpArgs = ["-f", "bestaudio/best", "--no-playlist", "-o", path.join(dir, "in.%(ext)s")];
    if (process.env.YTDLP_PROXY) ytdlpArgs.push("--proxy", process.env.YTDLP_PROXY);
    ytdlpArgs.push(url);
    await run("yt-dlp", ytdlpArgs, { timeout: 1000 * 60 * 10 });

    const downloaded = (await fs.readdir(dir)).find((f) => f.startsWith("in."));
    if (!downloaded) throw new Error("Could not fetch audio for that link");
    const inPath = path.join(dir, downloaded);

    // 2. Guard duration.
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]).catch(() => null);
    const duration = probe ? parseFloat(probe.stdout.trim()) : 0;
    if (duration && duration > MAX_MINUTES * 60) {
      return res.status(413).json({ error: `Video exceeds the ${MAX_MINUTES}-minute limit` });
    }

    // 3. Normalize to 16kHz mono mp3 and split into chunks Whisper can swallow.
    await run("ffmpeg", [
      "-i", inPath, "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
      "-reset_timestamps", "1", path.join(dir, "chunk_%03d.mp3"),
    ], { timeout: 1000 * 60 * 10 });

    const chunks = (await fs.readdir(dir)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error("No audio extracted");

    // 4. Transcribe each chunk, offsetting timestamps by the chunk's position.
    const cues = [];
    for (let i = 0; i < chunks.length; i++) {
      const offset = i * CHUNK_SECONDS;
      const segs = await whisper(path.join(dir, chunks[i]), language);
      for (const s of segs) {
        const text = (s.text || "").trim();
        if (text) cues.push({ start: +(s.start + offset).toFixed(3), end: +(s.end + offset).toFixed(3), text });
      }
    }

    res.json({ cues });
  } catch (e) {
    res.status(502).json({ error: e.message || "Transcription failed" });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function whisper(filePath, language) {
  const buf = await fs.readFile(filePath);
  const fd = new FormData();
  fd.append("model", WHISPER_MODEL);
  fd.append("response_format", "verbose_json"); // includes per-segment timestamps
  if (language) fd.append("language", language);
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");

  const r = await fetch(`${WHISPER_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`Whisper error ${r.status}`);
  const data = await r.json();
  return data.segments || [];
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
