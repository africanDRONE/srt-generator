# Translation Worker

A small Cloudflare Worker that holds the Anthropic API key and translates batches
of subtitle cues. The browser never sees the key. Caption text passes through and
is not stored or logged. The Worker does keep daily usage counters (see Protection).

## Deploy

```bash
cd /Users/johnniemiller/Downloads/srt-translator/worker

# 1. Set the secrets (paste each value when prompted)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_ANON_KEY

# 2. Deploy (wrangler 4.36.0 or later)
npx wrangler deploy

# 3. Check what is switched on (no secrets or setting values, plus the caller's own quota key)
curl https://subtitle-translate.johnnie-miller.workers.dev/health
```

The deploy has to run inside `worker/`. The same command in the folder above
deploys the website instead.

The first deploy of this version creates the `Quota` Durable Object class
(migration `v1` in `wrangler.toml`). Once that migration has been applied, leave
the `v1` entry in place and add new migrations after it.

`SUPABASE_ANON_KEY` is the same publishable key the upload Worker uses. Without
it the plan check is off and paid users get the free limits.

## Protection

Every request passes these checks, in this order, before any call to Anthropic.

| Check | Rejects with | Notes |
|-------|--------------|-------|
| Route | 404, 405 | Only `POST /translate` translates. `GET /health` reports configuration. |
| Origin allow-list | 403 | The `Origin` header must be one of the sites in `ALLOWED_ORIGIN`, or localhost when `ALLOW_LOCALHOST` is `true`. This blocks other websites in a browser. A script can forge the header, so the quotas below do not rely on it. |
| Size caps | 413 | Body over 256 KB, more than `MAX_CUES` cues, a cue over `MAX_CUE_CHARS`, or a request over `MAX_REQUEST_CHARS`. |
| Language | 400 | `target` and `source` must be language codes such as `es`, `pt-BR` or `zh-CN` (`source` may also be `auto`). Language names are not accepted, because the value goes into the prompt. |
| Burst limit | 429 | Rate limit binding `RL_IP`, 120 requests per minute per IP address, counted per Cloudflare location. Optional. |
| Plan | never | A Supabase session token in the `Authorization` header is verified with Supabase, then the tier is read from `profiles`. No token, a bad token or a Supabase outage all mean the free plan. |
| Daily quota | 429 | Durable Object counters: per IP address on the free plan, per account on Solo and Team, plus one pool shared by all free traffic. Required. If the counter is missing or failing the Worker refuses to translate (500 or 503). |

Rejections have a JSON body `{ "error": "...", "code": "..." }`. The pages show
the `error` text for 403, 413 and 429.

### Quota unit

One request costs 500 plus the length of each caption, with 40 as the minimum
per caption. Characters other than printable ASCII (accented letters, Cyrillic,
Arabic, Thai, Chinese, Japanese, Korean, emoji, control characters) count three
times, because they cost more to translate per character than plain English
text. The factor is an estimate. A line break inside a caption counts as five,
because the Worker sends it to the model as a three character marker. A
200-line English file (about 8,000 characters) sent in batches of 20 costs
about 13,000. A Russian file of the same length costs about 27,000. Counters
reset at midnight UTC. A rejected request costs nothing. A request that fails
at Anthropic is not refunded.

### Output cap

The Worker sets `max_tokens` for each Anthropic call from what the request was
charged: 400, plus 3 for each unit charged for the captions, and never more
than 16,000. The cap is always below 3 tokens per unit charged. A normal
translation uses a small part of it. The cap stops a short request from asking
for a very long reply.

### What is stored

One `{ day, used }` record per counter. The counter is named after the IP
address (IPv6 by its /64 prefix) or the Supabase account id. No caption text is
stored. A counter deletes itself about two days after its last day of use.

## Configuration

| Var | Where | Default | Notes |
|-----|-------|---------|-------|
| `ANTHROPIC_API_KEY` | secret | none | Required. |
| `SUPABASE_ANON_KEY` | secret | none | Turns the plan check on, together with `SUPABASE_URL`. |
| `SUPABASE_URL` | `[vars]` | none | Supabase project URL. |
| `MODEL` | `[vars]` | `claude-opus-4-8` | Premium. `wrangler.toml` sets `claude-haiku-4-5`. |
| `ALLOWED_ORIGIN` | `[vars]` | the three SubCaptions sites | Comma-separated origins. `*` is ignored. |
| `ALLOW_LOCALHOST` | `[vars]` | off | `true` allows `http://localhost`, `127.0.0.1` and `[::1]` on any port. |
| `MAX_CUES` | `[vars]` | `60` | Cues per request. The pages send 20. |
| `MAX_CUE_CHARS` | `[vars]` | `1000` | Characters per cue. |
| `MAX_REQUEST_CHARS` | `[vars]` | `20000` | Characters per request. |
| `FREE_DAILY_CHARS` | `[vars]` | `150000` | Daily quota per IP address, free plan. |
| `FREE_POOL_DAILY_CHARS` | `[vars]` | `3000000` | Daily quota for all free traffic together. This is the ceiling on free spend per day. |
| `SOLO_DAILY_CHARS` | `[vars]` | `1000000` | Daily quota per Solo account. |
| `TEAM_DAILY_CHARS` | `[vars]` | `2000000` | Daily quota per Team account. |

## Tests

```bash
cd /Users/johnniemiller/Downloads/srt-translator
node --test worker/test/*.test.mjs
```

The tests use fake bindings and a stubbed `fetch`. They make no network calls and
need no API key.

## Still open

- **Spend alert.** Set a budget alert in the Anthropic console. The quotas cap
  usage by characters, which bounds spend but is not a dollar limit.
- **Browser limits.** The 200-line limit in `translate.html` and the one
  translation rule in `index.html` still run in the browser only. The Worker
  enforces daily quotas per IP address and per account, which is a different and
  looser limit.
- **Bot checks.** About 20 IP addresses sending the largest allowed requests can
  use up the shared free pool for a day. Free translation then stops until
  midnight UTC, paid accounts keep working, and the spend stays inside the pool.
  A [Turnstile](https://developers.cloudflare.com/turnstile/) token check on
  anonymous requests would make this harder. A larger `FREE_POOL_DAILY_CHARS` or
  a smaller `FREE_DAILY_CHARS` changes how many addresses it takes.
- **Upstream retries.** One charged request can lead to up to three calls to
  Anthropic when the first ones fail. The quota counts the request once.
