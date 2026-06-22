# Translator handoff: architecture and build scope

This is the feature that turns SubCaptions from a free tool into a business. The
willingness to pay is anchored to replacing a $5-15/minute subtitling vendor, so
the buyer is the Team subscriber, and the value is letting their translator work
in-tool instead of round-tripping files. It is also the first feature that needs
a real backend, because today everything is client-side (captions live in the
filmmaker's browser localStorage, invisible to anyone else).

## What it needs (the gating build)
1. **Accounts.** Email + password or magic link. The Team subscriber owns the account.
2. **Cloud-stored projects.** A project = { source video URL, cues, translation columns, owner }. Today this lives in localStorage; it must move to a server DB so a translator on another machine can open it.
3. **Scoped share tokens.** The owner generates a link like `/edit/<project-id>?token=<random>`. The token grants edit access to **that one project's editor only**. It must NOT grant account access, billing, or visibility of other projects. Optionally time-limited and revocable.
4. **Payments.** Stripe (or similar) for the $5 Solo and $18 Team subscriptions, with entitlement checked server-side. The client `IS_PRO` flag is a placeholder; real gating moves to the API.

## Security note (correcting the original "log into your account" idea)
Do not have the translator log into the owner's account or share real credentials.
That exposes billing and every other project. Use a **scoped project-share token**:
same UX (the translator clicks a link and starts typing), but it only unlocks that
single project's translation columns. Treat the token like a capability URL: long,
random, revocable, optionally expiring.

## Suggested stack (cheapest path that scales)
- **Supabase** (Postgres + auth + row-level security) or **Cloudflare D1 + Workers**. Supabase gives you auth, DB, and RLS out of the box, which is most of this feature.
- Tables: `users`, `projects` (owner_id, source_url, data jsonb, updated_at), `share_tokens` (project_id, token_hash, role, expires_at).
- RLS: owners read/write their projects; a valid share token grants write to one project's translation fields only.
- **Stripe Checkout + a webhook** that sets the user's tier. Gate auto-caption, burn-in, and share-link creation by tier in the API, not the client.
- The editor (index.html) gains: sign-in, "Save to cloud," "Share with a translator" (creates a token + copies the link), and a translator view that loads a project by token and writes back the translation column.

## Phasing (smallest first, to validate before over-building)
1. **Phase 0 (no backend):** prove demand. Add a "Copy a project handoff link" button that encodes the project (source URL + cues) into a long URL or a downloadable `.subcap` file the owner sends to a translator, who opens it in the same tool. Crude (no live sync, no auth), but it tests whether filmmakers actually want the handoff before you build accounts.
2. **Phase 1:** Supabase auth + cloud projects + scoped share tokens (the real handoff). Gate by a manual Team flag.
3. **Phase 2:** Stripe subscriptions + server-side entitlement. Now it's a business.
4. **Phase 3 (only if Phase 1-2 show traction):** a thin marketplace matching filmmakers to rare-language translators, taking a cut. This is the only piece with a defensible moat (two-sided liquidity + a supply of rare-language translators), and the only path to a revenue ceiling worth chasing. Do not build it on spec.

## Honest note
Phases 1-2 are a few days of real work plus a hosting/payments setup, and they are
the prerequisite for any meaningful revenue. Everything shipped so far (editor,
translation, auto-caption service, burn-in, pricing, SEO) is the funnel; this is
the cash register. Validate with Phase 0 before committing to the full build.
