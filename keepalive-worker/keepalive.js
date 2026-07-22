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
 * Config: vars SUPABASE_URL, SUPABASE_ANON_KEY (publishable/browser-safe key only).
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ping(env).then(
        (r) => console.log("keepalive ping", JSON.stringify(r)),
        (e) => console.log("keepalive FAILED", e && e.message)
      )
    );
  },
  // Manual check: hitting this Worker's URL runs the same ping and shows the result.
  async fetch(request, env) {
    const r = await ping(env).catch((e) => ({ ok: false, error: e.message }));
    return new Response(JSON.stringify(r, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
