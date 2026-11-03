/**
 * SubCaptions Supabase keepalive (Cloudflare Worker, cron-triggered).
 *
 * Supabase pauses Free Plan projects after 7 days of low DATABASE activity, which
 * would take down auth, tier checks, cloud projects and translator share links all at
 * once. Dashboard visits don't count; only real queries do. This runs a tiny query
 * once a day so the inactivity clock never gets close to 7 days.
 *
 * This is a stopgap for the low-traffic period. Once the app has steady real users (or
 * you move to Supabase Pro, which never pauses), it becomes redundant and can be removed.
 *
 * The same run also wakes the billing server once a day. On Render's free plan it sleeps
 * after 15 idle minutes, and its tier reconcile only runs while it is awake (5 seconds
 * after start, then every 6 hours), so without this a quiet week could pass with no
 * reconcile at all. It is deliberately NOT a 10-minute keep-warm: Render's 750 free
 * hours are shared by every free service in the workspace, and keeping one service up
 * all month uses about 744 of them, which would get the transcribe service suspended.
 *
 * Config: vars SUPABASE_URL, SUPABASE_ANON_KEY (publishable/browser-safe key only),
 * BILLING_URL (optional; the billing server's base URL).
 */

async function ping(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + env.SUPABASE_ANON_KEY,
      Accept: "application/json",
    },
  });
  // RLS may return an empty set for an anonymous caller. That's fine: the query still
  // executed against Postgres, which is what resets the inactivity timer.
  return { ok: r.ok, status: r.status, at: new Date().toISOString() };
}

// A cold start takes about a minute, so allow 90 seconds before giving up.
async function wakeBilling(env) {
  if (!env.BILLING_URL) return { skipped: true };
  const r = await fetch(`${env.BILLING_URL}/healthz`, { signal: AbortSignal.timeout(90000) });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, build: body && body.build, at: new Date().toISOString() };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        ping(env).then(
          (r) => console.log("keepalive ping", JSON.stringify(r)),
          (e) => console.log("keepalive FAILED", e && e.message)
        ),
        wakeBilling(env).then(
          (r) => console.log("billing wake", JSON.stringify(r)),
          (e) => console.log("billing wake FAILED", e && e.message)
        ),
      ])
    );
  },
  // Manual check: hitting this Worker's URL runs the Supabase ping and shows the result.
  // It does not wake billing, so a stranger loading this URL can't spend Render hours.
  async fetch(request, env) {
    const r = await ping(env).catch((e) => ({ ok: false, error: e.message }));
    return new Response(JSON.stringify(r, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
