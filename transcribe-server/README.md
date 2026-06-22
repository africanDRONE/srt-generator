# Transcription + burn-in service (Pro)

Two Pro endpoints that both need `yt-dlp` + `ffmpeg`, which Cloudflare Workers can't run:

- **`POST /transcribe` { url, language? } -> { cues }`**: auto-captions. Pulls the
  audio for any source with `yt-dlp` and runs Whisper.
- **`POST /burn` { url, srt, maxHeight? } -> video/mp4`**: renders the subtitles
  permanently into the picture (the Team "burned-in export"). Fetches the video,
  runs ffmpeg's `subtitles` filter, downscales to a height cap, and streams back an
  mp4. Cost controls: height cap (1080 Solo / up to 2160 Team), `veryfast` x264
  preset, and a duration limit, so CPU time and output size (bandwidth) stay bounded.
  Burn-in is the one feature with real per-render cost; for short 1080p clips,
  doing it in the browser with ffmpeg.wasm is a zero-cost alternative worth adding.

This is a separate service from the translation Worker on purpose: it needs
`yt-dlp` and `ffmpeg`, which Cloudflare Workers can't run. Deploy it on a normal
container host.

## What it does
1. `yt-dlp` downloads the best audio track for the URL.
2. `ffmpeg` converts to 16kHz mono mp3 and splits it into 10-minute chunks (to stay under Whisper's 25MB upload limit).
3. Each chunk goes to Whisper (`verbose_json`), timestamps are offset per chunk and merged.
4. Returns `{ cues: [{start, end, text}] }`, which the editor drops straight into the caption list.

## Run locally
```bash
cd transcribe-server
npm install
# needs yt-dlp + ffmpeg on PATH:  brew install yt-dlp ffmpeg
export OPENAI_API_KEY=sk-...
export PRO_TOKEN=dev-secret
node server.mjs
# POST http://localhost:8080/transcribe  { "url": "https://youtu.be/..." }
```
Then point the front end at it in `index.html`:
```js
const TRANSCRIBE_BASE = "https://your-service-host";
```
(The front end sends the Pro token once real auth exists; for now `PRO_TOKEN` is a shared secret.)

## Deploy (Docker, e.g. Fly.io / Render / Cloud Run)
```bash
docker build -t subcaptions-transcribe .
# set OPENAI_API_KEY, PRO_TOKEN, ALLOWED_ORIGIN as secrets on your host
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... -e PRO_TOKEN=... subcaptions-transcribe
```

## Config
| Env | Default | Notes |
|-----|---------|-------|
| `OPENAI_API_KEY` | required | Whisper key (or a Groq key, with `WHISPER_BASE`) |
| `WHISPER_BASE` | `https://api.openai.com/v1` | Point at Groq for cheaper/faster `whisper-large-v3` |
| `WHISPER_MODEL` | `whisper-1` | `whisper-large-v3` on Groq |
| `PRO_TOKEN` | unset | Shared secret; auto-captions are Pro-only |
| `ALLOWED_ORIGIN` | `*` | Set to your domain before launch |
| `MAX_MINUTES` | `240` | Hard cap to bound cost/abuse |
| `YTDLP_PROXY` | unset | Proxy for yt-dlp (see the caveat below) |

## Cost
Whisper is about **$0.006/minute** on OpenAI (a 45-min video ≈ $0.27; an hour ≈ $0.36).
Groq's `whisper-large-v3` is meaningfully cheaper and faster. Since auto-captions
are Pro-only, this cost sits behind the paywall.

## Read this before relying on YouTube/Vimeo

**Pulling audio from YouTube/Vimeo is against their Terms of Service**, and YouTube
in particular blocks datacenter IP ranges hard. On a fresh cloud host, YouTube
requests will often fail with a bot check almost immediately. To make YouTube/Vimeo
reliable at any scale you will need:
- **Residential or rotating proxies** via `YTDLP_PROXY` (this is the real operational cost and risk, not the Whisper bill).
- To keep `yt-dlp` updated (YouTube changes break it regularly).
- A considered view on the ToS/legal posture, since you'd be downloading third-party content server-side.

**Direct-file sources (Dropbox, Drive, Rushes, .mp4) have none of these problems** and
are the clean, low-risk path. A reasonable product stance: offer auto-captions
freely for uploaded/direct files, and treat YouTube/Vimeo auto-caption as
best-effort (or require the user to provide a file) until you've decided how to
handle the proxy/ToS question. The front end already supports both; this is a
business/ops decision, not a code limitation.
