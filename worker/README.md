# Translation Worker

A tiny Cloudflare Worker that holds the Anthropic API key and translates batches
of subtitle cues. The browser never sees the key. No file is stored; only caption
text passes through, and this Worker logs none of it.

## Deploy (5 minutes)

```bash
npm i -g wrangler
wrangler login
cd /Users/johnniemiller/Downloads/srt-translator

# 1. Set the secret (paste your Anthropic key when prompted)
wrangler secret put ANTHROPIC_API_KEY

# 2. Deploy
wrangler deploy
```

`wrangler deploy` prints a URL like `https://subtitle-translate.<you>.workers.dev`.
Put that into `index.html`:

```js
const API_BASE = "https://subtitle-translate.<you>.workers.dev";
```

When `API_BASE` is empty the front end runs in **demo mode** (simulated
translations) so the UI works without a key, useful for local development.

## Configuration

| Var | Where | Default | Notes |
|-----|-------|---------|-------|
| `ANTHROPIC_API_KEY` | secret |, | Required. `wrangler secret put ANTHROPIC_API_KEY` |
| `MODEL` | `[vars]` | `claude-opus-4-8` | Premium. Use `claude-haiku-4-5` or `claude-sonnet-4-6` for cheaper, still-excellent subtitle quality. |
| `ALLOWED_ORIGIN` | `[vars]` | `*` | Set to your domain before launch. |
| `MAX_CUES` | `[vars]` | `60` | Hard per-request cap. The front end batches at 40. |

## What's NOT in here yet (add before heavy traffic)

- **Rate limiting / abuse protection.** A public translation endpoint backed by a
  paid API is abusable. Add one of: Cloudflare [Rate Limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/),
  a [Turnstile](https://developers.cloudflare.com/turnstile/) token check, or a
  per-IP counter in [Workers KV](https://developers.cloudflare.com/kv/). This is
  the single most important hardening step, see `docs/monetization.md` for why.
- **Daily spend cap.** Set a budget alert in the Anthropic console.
- **Pro auth.** The free/Pro split (larger files, batches) is gated in the front
  end today. Real enforcement belongs here once payments exist (check a token /
  Stripe customer before allowing large `MAX_CUES`).
