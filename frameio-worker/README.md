# Frame.io connector (Worker)

Turns a pasted Frame.io link into a direct media URL using the user's own Frame.io
account, via Adobe IMS OAuth. The site (index.html) calls this Worker at
`FRAMEIO_BASE`. The client secret and user tokens live here, never in the browser.

## One-time setup (the parts only you can do)

1. **Register an Adobe Developer Console project with the Frame.io API.**
   - Go to the Adobe Developer Console, create a project, add the **Frame.io API**.
   - Add an **OAuth Web App** credential.
   - Set the **Redirect URI** to:
     `https://subcaptions-frameio.johnnie-miller.workers.dev/callback`
   - Copy the **Client ID** and **Client Secret**.

2. **Create the KV namespace and set secrets** (from `frameio-worker/`):
   ```bash
   wrangler kv namespace create TOKENS      # paste the id into wrangler.toml
   wrangler secret put IMS_CLIENT_ID         # paste Client ID
   wrangler secret put IMS_CLIENT_SECRET     # paste Client Secret
   ```

3. **Deploy:**
   ```bash
   wrangler deploy
   ```
   Confirm `GET /health` returns `{ "ok": true, "configured": true }`.

## Notes / what still needs a real link to finalize

- `parseFrameioLink()` in `frameio.js` extracts the file id (and account id if
  present) from the pasted URL. Frame.io's web/share URL shapes are not publicly
  documented and vary, so this uses the common id-bearing patterns plus a UUID
  fallback. **Paste one real Frame.io link from your account** and confirm
  `/resolve?link=...` returns a `download_url`; if not, adjust the regexes there.
- `media_links.original.download_url` is the field we read. If Frame.io returns it
  under a different include or needs an `api-version` header on your plan, that's
  the one spot to tweak (see `resolve()` / `fioGet()`).
- Cookies are `SameSite=None; Secure` so the site (different origin) can send them;
  `ALLOWED_ORIGIN` must be the exact site origin for credentialed CORS to work.
