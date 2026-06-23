# Upload Worker

Mints presigned PUT URLs so a Solo user uploads a video **direct to R2** from the
browser, then mints short-lived signed GET URLs for playback / auto-transcribe.

## What's already done

- R2 bucket `subcaptions-uploads` created.
- 7-day expiry lifecycle rule applied.
- CORS rule applied for the site origin.
- Worker code and config written.

## One-time setup steps you still need to do

1. **Create an R2 API token** (gives the Worker its access keys).
   - Cloudflare dashboard → R2 → **Manage R2 API Tokens** → **Create API token**.
   - Permission: **Object Read & Write**.
   - Scope: this bucket (`subcaptions-uploads`).
   - Copy the **Access Key ID** and **Secret Access Key**.

2. **Set the secrets** (from `upload-worker/`):
   ```bash
   npx wrangler secret put R2_ACCESS_KEY_ID
   # paste the Access Key ID, Enter
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   # paste the Secret Access Key, Enter
   npx wrangler secret put SUPABASE_ANON_KEY
   # paste the Supabase anon/publishable key (same one the site uses), Enter
   ```

3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   Confirm `/health` says `{ ok: true, configured: true }`.

## Endpoints

- `POST /sign-upload` `{ filename, contentType, size }` → `{ uploadUrl, key, playbackUrl }`
- `POST /playback`    `{ key }` → `{ url, expiresAt }` (re-sign before transcribe)
- `POST /delete`      `{ key }` → `{ ok: true }`
- `GET  /quota`       → `{ used, limit, files: [...] }`
- `GET  /health`

## Limits

- 2 GB per file (PUT size).
- 10 GB per user (enforced by listing the user's prefix in R2).
- 7-day automatic expiry in R2 + client `/delete` on export.
