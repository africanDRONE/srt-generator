# SubCaptions — Overnight Report & Launch Runbook
_Prepared overnight. Read top to bottom; the launch checklist is at the end._

---

## 1. What I did overnight

- **Fixed the hero captions to 42-char wrapping** (matches the editor's product standard), re-burned, deployed. Clean 2-line, standard-size captions, no 3-line overflow.
- **Diagnosed the Render deploy problem** (section 2) — it's a 2-minute dashboard fix.
- **Ran a 5-person advisory panel** (MBA strategist, pro video editor, casual creator, professional translator, investor) and synthesized it (section 3).
- **Fixed a launch-blocking honesty problem** the panel unanimously flagged: the pricing page was selling features that aren't built. I labeled them "coming soon" and removed the false "cloud-saved across devices" claim. **Review this — see section 4.**

---

## 2. Why Render won't auto-deploy (and the fix)

**Diagnosis (confirmed):** Both GitHub repos (`africanDRONE/srt-generator` and `millejoh24021/SubCaptions`) have your latest commit, and your *manual* "Deploy latest commit" works — so the code reaches GitHub fine. That means the only possible cause is **Auto-Deploy is turned off on the Render services**, or the Render↔GitHub webhook was never wired. There's no `render.yaml` in the repo, so the services were created by hand in the dashboard, and the setting lives there.

**Fix (do this first thing — 2 min each):**
1. Render dashboard → **`subcaptions-transcribe`** → **Settings → Build & Deploy**.
2. Set **Auto-Deploy = "On Commit"**, confirm **Branch = `main`** and the connected repo is the one you push to.
3. If there's a "Repository" connection warning, click **reconnect** (re-authorize the Render GitHub app on that repo — that recreates the missing webhook).
4. Repeat for **`subcaptions`** (the billing service).
5. Optional but tidy: set each service's **Root Directory** (`transcribe-server` and `billing`) so a push only rebuilds the service whose files changed.

After this, my pushes deploy automatically. **Until you do it, you must "Manual Deploy" the transcribe server to pick up the latest captioning code** (see runbook step 3 — there's pending server code not yet live).

---

## 3. Advisory panel — what 5 experts said

I briefed each on the real product, including the honest limitations. The headline: **strong, unanimous signals.**

### The one thing everyone agreed on (4 of 5, unprompted)
**You were advertising features that don't exist** — burn-in, translator handoff, and "cloud-saved across devices." The translator and investor both called it the fastest way to burn trust; the MBA called it the #1 launch blocker. **I fixed this tonight** (section 4). Do not undo it.

### Per-persona takeaways

**MBA / business strategist — verdict: fix-then-launch.**
- Positioning is aimed at the wrong buyer. "Caption any video" is a war you lose to free CapCut/YouTube. Your real wedge is the **festival / translator / exotic-language** subtitler who needs clean SRT, 42-char discipline, no watermark, and languages the big tools don't support.
- **Prices are too low and signal "toy."** Suggests Solo **$9–12**, Team **$20–29** (once Team features exist). Your buyer compares you to Rev/Veed, not to free.
- Auto-captions are your **highest-cost, weakest-differentiated** feature and you're running them on a free box that will fall over. Don't lead with them.
- First-100-users GTM: r/Filmmakers, No Film School, festival-submission Discords, translator/ProZ forums, a 30-sec demo video. Free tier is the ad.

**Pro video editor — would use free tier, wouldn't pay $6 yet.**
- "Caption on the live video" is the right idea but it **lacks a waveform**, so timing is sloppier than free Subtitle Edit. A scrubbable waveform is the single highest-leverage add.
- **Per-browser storage is a hard dealbreaker** for paid client work — needs cloud-persistent projects.
- Frame.io pull is the standout feature, but it dead-ends at SRT (no write-back, no handoff yet).
- To make auto-captions usable by pros: **speaker labels (diarization), custom dictionary, frame-accurate timing in project frame rate, split/merge/nudge/ripple keyboard editing.**

**Casual creator — would bounce off free tier, wouldn't pay $6.**
- "Type captions in time with the video" is **the exact chore they're trying to escape.** Casual users want one-click auto-caption, free.
- They already get auto-captions + burn-in **free in CapCut and YouTube**, inside the app they already edit in. $6/mo for a separate tool that doesn't even burn-in yet doesn't compute.
- Killer friction: **"YouTube/Vimeo can't be auto-transcribed"** — that's the only link they have. And "paste a direct/S3 link" / "Frame.io" reads as "not for me."
- What would win them: free **one-click auto-caption taste**, burn-in that works from a YouTube/upload link, and selling translation as **"go global with your videos"** (or pay-per-use, not a sub).

**Professional translator — useful for creators, a toy for pro subtitling (today).**
- "AI translate then human edit" is a legitimate pro workflow (MTPE) — not an insult. But the tool **inherits English line breaks across every language**, which is backwards: segmentation/timing should be a locked grid that translations reflow into.
- **Missing the one thing that makes a subtitle a subtitle: reading-speed (CPS) enforcement** computed from the timecode, per language. Without it, the AI gives a text translation, not subtitles.
- The **42-char rule is a Latin-script assumption** — wrong for CJK (count full-width glyphs, ~13/line), Arabic/Hebrew (needs real RTL), Thai (no spaces). The "works for 50+ languages" claim is quietly wrong for many.
- Translator-handoff-via-link is the **most valuable idea in the product** and isn't built. Build it before cloud sync.

**Investor — pass for venture; plausible as a small lifestyle business.**
- Core is commoditized (Whisper wrappers at ~$0.005/min, free everywhere). No moat on the surface.
- The **one defensible niche**: low-resource / unsupported languages + festival/NGO-grade discipline + human-in-the-loop handoff. But that's a hypothesis layered on a generic captioner today.
- Realistic outcomes: **~65% nothing, ~30% small lifestyle business ($1–5k MRR), ~4% real SMB SaaS, <1% venture.** The near-zero cost base is what keeps the lifestyle outcome alive (no burn = infinite runway).
- 90-day test to believe: **10 paying strangers from one named niche, zero vapor features, one workflow (handoff) working on real infra.**

### My synthesis (the through-line)
All five, from totally different angles, point to the **same two moves**:
1. **Stop selling vapor** (done tonight) and **stabilize the paid feature's infra** (the $7 Render box).
2. **Pick the niche** — festival / translator / unsupported-language subtitling — and reposition around it, instead of fighting CapCut for "caption any video." That's the only path off the free-tool floor, and it's the one place you're nearly alone.

These are recommendations, not changes I made. The repositioning is your call.

---

## 4. What I changed on the pricing page tonight (review this)

To remove the launch-blocking false claims, I labeled unbuilt features **"coming soon"** and dropped one false claim. Live now:
- **Solo:** added "Video file upload (up to 2 GB)" (real), marked **"Burned-in video export — coming soon"**, removed "Batch multiple files" (not built).
- **Team:** now reads "Everything in Solo" + **"Hand off to a translator — coming soon"**, **"Cloud-saved projects — coming soon"**, **"4K & long-form burn-in — coming soon"**, **"Priority processing — coming soon."**

**Honest consequence you must decide on:** with the vapor removed, **Team currently offers nothing beyond Solo.** Two clean options for tomorrow:
- **(Recommended) Hide the Team tier at launch** (or label the card "Coming soon — join the waitlist"), so you're not charging $12 for "same as Solo." Sell only Free + Solo.
- Or leave Team visible as "early access" at a founder price, knowing buyers get Solo features for now.

---

## 5. Decisions only you can make (before/at launch)
1. **Reposition to the niche, or launch generic?** (Panel strongly says niche.)
2. **Raise prices?** (Panel: Solo $9–12, Team $20–29.) If yes, it's a 5-min change + new Stripe prices.
3. **Hide Team for launch?** (Recommended — see section 4.)
4. **Spend $7/mo on Render Starter now?** (Recommended — auto-transcribe is a paid feature on a free box that cold-starts and can OOM.) $25 Standard only if you want burn-in live at launch (panel says don't — keep it "coming soon").
5. **Free-tier hook:** add a free one-click auto-caption taste? (Casual creator says the hand-caption free tier makes them bounce.)

---

## 6. LAUNCH RUNBOOK — step by step for tomorrow morning

Ordered. Each step has a verify. Stripe is the part that actually takes money, so it gets the most detail.

### ⚠️ Critical corrections from launch review (do NOT skip — these break launches)
- **P0 — The BILLING service must NOT be on Render free tier.** It receives the Stripe webhook that flips a paid user to Solo. A free-tier cold start (30–60s) can exceed Stripe's webhook timeout, so the customer pays but their tier never updates. Put `subcaptions` (billing) on an always-on paid plan **tonight**. (This is separate from the transcribe $7 bump.)
- **P0 — The live webhook signing secret is unique to the live endpoint.** Pasting the test-mode `whsec_…` makes every live webhook fail signature check → no tier flip. After creating the LIVE endpoint, copy *that* endpoint's secret, set it, redeploy, then **Stripe → Send test webhook → confirm a 200** before any real payment.
- **P0 — Stripe account must be fully ACTIVATED in live mode** (business profile + bank + identity). This can take hours to a day, so verify "payments enabled" tonight, not at 9am.
- **P0 — Live Customer Portal must list the LIVE prices** in its switch-plans set (the test products won't carry over).
- **P1 — Wipe stale test-mode `stripe_customer_id`/tier rows in Supabase `profiles`** before launch, or the portal 404s for those users (test customers don't exist in live mode).
- **P1 — Frame.io login uses a third-party cookie.** Safari (and hardened Chrome) block third-party cookies, so if the site and the frameio worker are on *different* registrable domains, Frame.io sign-in fails. Mitigation: host the frameio worker on a **same-site subdomain** (e.g. `frameio.subcaptions.com`) when you move domains. Test Frame.io login in Safari before relying on it. (Frame.io is not core to launch — you can soft-launch without it.)
- **P1 — Confirm `main` is exactly the commit you want live BEFORE enabling Render auto-deploy** (step 1), or turning it on ships whatever is on main immediately.
- **P1 — SCA/3-D Secure:** the success page should show "activating…" / poll the tier rather than assume `profiles.tier` is already flipped at redirect (the webhook may land a beat later).

### Step 0 — Decide the launch domain
- **If launching on `subcaptions.com`:** do step 6 (domain) — several configs must change.
- **If launching on `subcaptions.johnnie-miller.workers.dev` for now:** skip step 6; everything already points there. (Fine for a soft launch.)

### Step 1 — Turn on Render auto-deploy
- Section 2 above. Both services. (So you stop manually deploying.)

### Step 2 — Decide Team + prices (section 4 & 5)
- If hiding Team: tell me in the morning, it's a 2-line change.
- If raising prices: create the new Stripe prices (step 4) at the new numbers and update the page.

### Step 3 — Get the latest transcribe code live + bump infra
- Render → `subcaptions-transcribe` → **Manual Deploy → Deploy latest commit** (the captioning-quality code `cues-v3-pro` is pushed but NOT yet live).
- Verify: `curl -s https://subcaptions-transcribe.onrender.com/healthz` → should show `"build":"2026-06-24-cues-v3-pro"`.
- **Recommended:** Settings → Instance Type → **Starter ($7/mo)** to kill cold starts/OOM for paying users.
- Smoke test: open the site → **Try it now → Auto-generate** → captions appear, punctuated, 2 lines, well-timed.

### Step 4 — Stripe: switch to LIVE and take real money
This is the critical one. Right now you may be in **test mode**.
1. In Stripe, flip to **Live mode** (top toggle).
2. **Live API keys:** copy the live `sk_live_…` secret key.
3. **Create the prices in LIVE mode** (test-mode prices don't work with live keys): Solo $6/mo + $60/yr, Team $12/mo + $120/yr (or your new numbers). Copy the 4 `price_…` IDs.
4. On the **billing** Render service → Environment, set for live:
   - `STRIPE_SECRET_KEY` = live secret key
   - `PRICE_SOLO_MONTHLY`, `PRICE_SOLO_YEARLY`, `PRICE_TEAM_MONTHLY`, `PRICE_TEAM_YEARLY` = the 4 live price IDs
   - `APP_URL` = your launch origin (workers.dev URL or `https://subcaptions.com`)
   - `ALLOWED_ORIGIN` = same origin
5. **Webhook (live):** Stripe → Developers → Webhooks → add endpoint `https://subcaptions.onrender.com/billing/webhook`, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret → set `STRIPE_WEBHOOK_SECRET` on the billing service.
6. **Customer Portal (live mode):** Settings → Billing → Customer portal → use the **classic** view (the next-gen beta wasn't ready), enable "Customers can switch plans," add the Solo + Team products, enable cancel, **Save**.
7. Redeploy billing service. Verify: signed-in test → `Go Solo` opens Stripe Checkout at the right price; after paying, tier flips to Solo (the webhook updates it).

### Step 5 — Confirm the other services are live-ready
- **Frame.io worker:** `curl …/health` → `{"ok":true,"configured":true}`. (Done. If you change domain, update redirect URI — step 6.)
- **Upload worker:** `curl …/health` → `configured:true`. (Done.)
- **Translate worker:** translation is **live** (not simulated — the investor's brief was wrong on this; you wired it to the real worker). Confirm a translation column fills in.

### Step 6 — (Only if launching on subcaptions.com) point the domain + update origins
**Ordering matters: add the domain and let SSL fully issue FIRST, then flip env vars. If you change `ALLOWED_ORIGIN`/`APP_URL` before the cert is live, every cross-origin call and redirect fails during the gap. Do the domain + SSL the night before.** Also update: **Supabase → Auth → Site URL AND Additional Redirect URLs** (`https://subcaptions.com/*`), the **Adobe Developer Console redirect URI** (add the new one before cutover, it can take minutes to propagate), and host the **frameio worker on a same-site subdomain** to keep its login cookie working (see P1 above). Google Cloud's OAuth redirect points at Supabase's own domain, so it doesn't change, but verify it's present.
1. Cloudflare → the `subcaptions` Worker → **Custom Domains** → add `subcaptions.com` (and `www`). DNS must be on Cloudflare. **Wait for status "Active" / cert issued, and load the site over HTTPS on the new domain, before touching any env var.**
2. Update these to the new origin:
   - Billing service: `APP_URL`, `ALLOWED_ORIGIN` = `https://subcaptions.com`
   - Frame.io worker vars: `ALLOWED_ORIGIN`, `SELF_ORIGIN` = the real domains; **Adobe Developer Console → redirect URI** = `https://subcaptions-frameio.johnnie-miller.workers.dev/callback` stays the same (the worker keeps its own domain), but **`ALLOWED_ORIGIN` must be `https://subcaptions.com`** so the site can call it.
   - Upload worker var: `ALLOWED_ORIGIN` = `https://subcaptions.com` (and add it to the R2 bucket CORS list).
   - Supabase → Auth → URL config: add `https://subcaptions.com` to allowed redirect URLs.
   - In `index.html`/`translate.html`, the worker base URLs stay the same; only origins/CORS change.
3. Redeploy affected workers/services.

### Step 7 — Final smoke test (do the whole funnel as a real user)
- [ ] Home page loads; hero video autoplays with 2-line captions; "Try it now" is above the video.
- [ ] Try it now → editor opens on the clean clip → **Auto-generate** → good captions.
- [ ] Add a translation column → fills in.
- [ ] Export .srt and .vtt → open the file, looks right.
- [ ] Sign in (Google) → **Go Solo** → pay with a real card → tier flips to Solo → auto-transcribe works.
- [ ] On a second device/browser, confirm the experience (note: projects are per-browser — expected until cloud sync ships).
- [ ] Pricing page shows "coming soon" tags; no feature claim is false.

### Step 8 — Launch
- Post the 30-sec demo + free-tier link to the niche communities (r/Filmmakers, No Film School, a translator forum). Free tier is the ad.

---

## 7. Known limitations to keep "coming soon" (don't promise these at launch)
- **Burn-in** (needs the $25 Render box + the buffering→streaming fix; greyed in the UI).
- **Translator handoff** and **cross-device cloud sync** (not built; the panel says handoff is the most valuable thing to build next).
- **Auto-transcribe on YouTube/Vimeo** (blocked by their datacenter-IP policy — uploads/Dropbox/Drive/Frame.io/S3 work).
- **Per-language caption rules** (CPS enforcement, CJK/RTL handling) — currently Latin-script 42-char only.

---

## 8. If I had to pick the things that matter most

**The single most likely thing to go wrong tomorrow** (per the launch review): a customer pays, the charge succeeds in Stripe, but **their tier never flips to Solo** — because the live webhook failed signature check (wrong/test signing secret) or the billing service cold-started on free tier past Stripe's timeout. They're stuck on Free, you find out from an angry first customer. **Prevent it:** billing service always-on (paid), live endpoint's own signing secret set, and a Stripe "Send test webhook" returning 200 — all confirmed before you post anywhere.

**Tonight (night before), in order:**
1. Stripe live **account activation** (business + bank) — can take a day, so start now.
2. Move the **billing service off free tier** (always-on).
3. Create the 4 **live prices**, the **live webhook** + its own signing secret, **send a test webhook → 200**, configure the **live Customer Portal** with the live prices.
4. Reset stale **test customer rows** in Supabase `profiles`.
5. If moving to subcaptions.com: add the domain + let **SSL issue overnight**, update Supabase/Adobe redirects, move frameio to a same-site subdomain.

**Tomorrow morning:** confirm `main` is right → enable Render auto-deploy → manual-deploy transcribe (verify build string) → bump transcribe to $7 → full funnel smoke test with a **real card** → only then post to communities.

**Top 3 if you can only do three:** (1) Stripe live + billing always-on + tested webhook; (2) pricing honest (done) + decide Team (hide/"early access"); (3) transcribe on $7 Starter.

Everything else (repositioning, price increase, waveform, translator handoff, per-language CPS) is post-launch iteration. You can go live tomorrow on **Free + Solo**, honestly, and start learning from real users — which the whole panel agrees is the right move.
