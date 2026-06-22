# Monetization plan

The pivot makes the economics cleaner, not messier. The hero product (the captioning editor) runs entirely in the browser, so it costs essentially nothing to serve. That means the free tier is a genuine gift with near-zero marginal cost: great for acquisition, SEO, and word of mouth. The only part that costs real money to run is translation, because that calls an LLM. So translation is both the cost center and the upsell. You monetize the cheap-to-serve commodity feature and give away the expensive-to-build, cheap-to-run hero.

## 1. Where the costs actually are

| Part of the product | Where it runs | Marginal cost to you |
|---|---|---|
| Captioning editor (load video, time captions, edit, export) | Browser (client-side) | ~$0. YouTube serves the video; captions live in localStorage. |
| Translation | Cloudflare Worker -> Claude API | Real per-job API cost (below) |
| Static hosting (pages, SEO) | Cloudflare Pages / Netlify | ~$0 to a few dollars/mo |

This is the important strategic point: the thing people come for is free to run, so you can be generous with it and let it drive traffic. You only meter the part that has a unit cost.

## 2. Translation unit economics

Estimated API cost per translation job, by model (about 25 input + 28 output tokens per cue, small system prompt per 40-cue batch). **Estimates; re-measure on real files before scaling.**

| Job size | Opus 4.8 ($5/$25) | Sonnet 4.6 ($3/$15) | Haiku 4.5 ($1/$5) |
|---|---|---|---|
| Free translation (200 lines) | $0.17 | $0.10 | **$0.03** |
| 10-min video (~180 lines) | $0.15 | $0.09 | $0.03 |
| Feature film (~1,500 lines) | $1.27 | $0.76 | $0.25 |
| Per 1,000 lines | $0.84 | $0.51 | $0.17 |

**Model recommendation:**
- **Free translation -> Haiku 4.5** (~$0.03/job). Cheap enough to survive abuse, and subtitle quality is good. The inline editor covers the gap.
- **Pro translation -> Sonnet 4.6**, with an optional "Max quality (Opus)" toggle.
- The Worker ships with `MODEL=claude-opus-4-8` (the build default). **Change it to `claude-haiku-4-5` for the free path before pointing real traffic at it** (one line in `wrangler.toml`). Opus on a free public endpoint will bleed money.

## 3. Three tiers (priced to undercut the field)

Competitor pricing as of mid-2026: VEED $12-24/mo, Kapwing $16, Submagic $14-60, Happy Scribe $17-89, Maestra $23-79, Checksub ~€19, Subly $16/seat. Almost all are auto-transcription engines carrying real per-minute ASR cost. Our hero (manual captioning) is client-side and free to serve, so we can sit far below them and stay profitable.

**Free (no signup):**
- Caption any video by hand, up to **45 minutes**, saved locally
- Export .srt and .vtt, no watermark
- **One translation per video**, 50+ languages

**Solo, $5/mo (or $48/yr):**
- AI auto-captions (Whisper) for any language
- Full-length videos (no 45-min cap)
- Unlimited translations, several at once
- Burned-in video export (1080p)
- Batch files

**Team, $18/mo:**
- **Hand off to a translator with a share link** (the vendor-replacement feature)
- Cloud-saved projects across devices
- 4K / long-form burned-in export
- Priority processing

Why this shape: $5 Solo is an impulse "yes" for anyone already paying $60-90 for Adobe, undercuts every competitor, and is low enough that self-coding it isn't worth the hassle. The real money is Team: it replaces a $5-15/min subtitling vendor, so the willingness to pay is anchored to vendor savings (hundreds to thousands per film), not to "a subtitle app." Margin stays high because captioning is free to serve and the only variable costs (translation cents, Whisper ~$0.006/min, burn-in compute) are cappable.

### Cost controls on the two paid-but-costly features
- **Auto-captions** live in `transcribe-server/` (needs yt-dlp + ffmpeg, which the Worker can't run). ~$0.006/min (a 45-min video ≈ $0.27). The real risk for YouTube/Vimeo is proxies + ToS, not the Whisper bill, so direct files are the clean path.
- **Burn-in** is the one feature that breaks the ~100% margin (a full re-encode + bandwidth for big files). Handle it smart: do short 1080p renders **in the browser** with ffmpeg.wasm where possible (zero cost to us, uses the user's machine), and route 4K/long renders to the server, capped to a height limit and a fast x264 preset, gated to Team. The `/burn` endpoint downscales and bounds duration so cost stays predictable.

The translator-referral idea is dropped; the handoff is monetized directly inside Team instead (see `docs/handoff-architecture.md`).

## 4. Pricing recommendation

**$9/month, $79/year.** Reasoning:
- It clears the "cheaper than my time" bar for anyone captioning or translating for work, without inviting "why isn't this free" pushback, because the core captioning genuinely is free.
- Annual at $79 (about 27% off) pulls cash forward and cuts churn. Subtitle work is bursty (subscribe for a project, forget to cancel), so annual is a feature, not a refund magnet.
- Leave room above for an **Agency / API tier at $29-49/mo** for shops translating client libraries. Build it only when asked twice.

Avoid per-file or credit pricing at launch: it adds friction and makes people ration usage, which is the opposite of what you want for a habit-forming free tool.

### Fair-use cap on Pro
Set a soft cap (about 50,000 translated lines/month) so one user can't run a $400 bill on a $9 plan. At Sonnet rates that's about $25 of cost at the extreme, which is why the cap exists. Throttle past it rather than hard-blocking, and reach out to consistent over-users about the Agency tier.

## 5. Rough P&L sketch (sanity check, not a forecast)
Assume 30,000 captioning sessions/month (free, ~$0 to serve), 8,000 free translation jobs/month, and 200 Pro subs:
- Captioning cost: ~$0 (client-side)
- Free translation cost (Haiku, $0.03): ~$240/mo
- Pro revenue (200 x ~$8 blended): ~$1,600/mo
- Pro translation cost (Sonnet, avg ~5k lines/user/mo): ~$500/mo
- Hosting: ~$5-25/mo
- **Net: roughly +$850/mo**, scaling with Pro conversions while the free captioner keeps pulling in traffic for free.

The free captioner being zero-cost is what makes this work: you can grow the top of the funnel without growing your bill.

## 6. Abuse control (before any marketing push)
Captioning has no server cost, so it isn't the risk. **The translation endpoint is.** Without limits, someone scripts it and runs up a bill. Mitigations, in priority order:
1. **Daily global spend cap / budget alert** in the Anthropic console. Non-negotiable backstop.
2. **Per-IP rate limiting** on the Worker (Cloudflare Rate Limiting rules or a KV counter).
3. **Cloudflare Turnstile** token on the translate call.
4. **`MAX_CUES` cap** (already in the Worker) plus the 200-line free gate in the front end.
5. **Pro gating in the Worker** once payments exist, so large jobs require a valid token.

See `worker/README.md` for where these hook in.

## 7. Why this works
- **The wedge is the editor.** Captioning on top of the video is the part that's hard to find elsewhere and pleasant to use. It earns the visit and the bookmark.
- **The free tier is free to run.** Client-side captioning means you can be generous without a cost penalty, which fuels SEO and sharing.
- **You monetize the commodity, not the wedge.** Translation is everywhere and cheap, but it's the part with a real per-use cost, so metering it is fair and legible to users.
- **SEO owns both intents.** Captioning-intent pages ("add subtitles to a YouTube video," "make an SRT file") funnel to the free editor; translation-intent pages ("translate SRT to Spanish") funnel to the paid path. See `seo/`.

None of this is a hard moat. It's a better experience plus a head start on the search intent, which for a small profitable tool is enough. Invest in the editor's speed and feel, more landing pages, and the two or three Pro features people actually ask for.
