# SubCaptions

A free, in-browser tool to **subtitle YouTube videos**. Paste a link and build
captions on top of the video: play, mark each line's in and out point with a
keystroke, type it, and see it on screen. Export `.srt` or `.vtt`. Then translate
into 50+ languages in one click. Captions stay in your browser; only translation
text transits the Worker.

The captioning editor is the hero. Translation is a secondary feature (commodity
tech, so it isn't the headline) and the paid upsell.

## What's here

```
index.html                  The captioning editor (HERO). Set API_BASE before deploy.
translate.html              File translator (.srt/.vtt). Secondary tool + SEO target.
captioner.html              The original timing tool, preserved (now superseded by index.html).
worker/translate.js         Cloudflare Worker that holds the API key and calls Claude.
worker/README.md            Worker deploy + hardening guide.
wrangler.toml               Worker config (model, origin, caps).
seo/data.mjs                Languages, captioner guides, use-cases (edit to add pages).
seo/generate.mjs            Generator. Run: node seo/generate.mjs
add-subtitles-to-youtube-video/, youtube-subtitle-editor/, ...   Captioner-intent guide pages.
translate-srt-to-*/, *-translator*/, languages/   Translation SEO pages.
pricing.html                Generated pricing page.
styles/pages.css            Shared stylesheet for generated pages.
sitemap.xml, robots.txt     Generated (34 URLs).
launch/                     Product Hunt, directory, and community launch copy.
docs/monetization.md        Unit economics + pricing plan.
```

## Run locally
Any static server works:
```bash
python3 -m http.server -d . 8799
# open http://localhost:8799
```
With `API_BASE` empty, both tools run in **demo mode** (simulated translations).
Captioning, timing, and export are fully live without a key.

## Go live (in order)
1. **Deploy the Worker** (`worker/README.md`). Set the `ANTHROPIC_API_KEY` secret.
2. **Switch the model**: set `MODEL` to `claude-haiku-4-5` in `wrangler.toml` for the free path (see `docs/monetization.md`; Opus on a free endpoint is expensive).
3. **Point both tools at it**: set `API_BASE` in `index.html` and `translate.html` to your Worker URL.
4. **Set your domain**: edit `SITE.origin` in `seo/data.mjs`, re-run `node seo/generate.mjs`.
5. **Add abuse controls**: rate limiting + Turnstile + a spend cap (`worker/README.md`). The translation endpoint is the cost risk; captioning is client-side and free to serve. Do this before any marketing.
6. **Deploy the static site**: Cloudflare Pages / Netlify / GitHub Pages.
7. **Launch**: work through `launch/`.

## The honest version
The wedge is the editor: captioning on top of the video is the part that's hard
to find elsewhere and pleasant to use, and it's free to run because it's all
client-side. Translation is commodity tech (an LLM call), so it isn't the
headline; it's the metered feature that funds the free tool. Don't over-invest in
the model. Invest in the editor's feel, more landing pages, and the two or three
Pro features people actually ask for. See `docs/monetization.md`.
