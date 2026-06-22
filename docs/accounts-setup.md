# Turn on accounts + payments (step by step)

This makes sign-in and the $5 / $18 subscriptions actually work. No coding. You
will mostly be copying values from one website and pasting them into another.

Plan for about an hour. Do the steps in order. Do not skip ahead.

## What you are doing, in one breath
You will create two free accounts (Supabase for logins, Stripe for payments),
copy a handful of secret values out of them, paste those values into one small
program (the "billing service") and one file (`lib/auth.js`), and put that
program online. That is the whole job.

### A notepad to fill in as you go
Open a blank note and keep these labels. You will collect a value for each one
and use them near the end. Treat anything with "secret" or "service" in the name
like a password: never paste it into the website front-end or share it.

```
SUPABASE_URL          = 
SUPABASE_ANON_KEY     =        (this one is safe to be public)
SUPABASE_SERVICE_ROLE_KEY =    (SECRET)
STRIPE_SECRET_KEY     =        (SECRET)
STRIPE_WEBHOOK_SECRET =        (SECRET, you get this in Part 4)
PRICE_SOLO_MONTHLY    = 
PRICE_SOLO_YEARLY     = 
PRICE_TEAM_MONTHLY    = 
PRICE_TEAM_YEARLY     = 
BILLING_URL           =        (you get this in Part 3)
```

---

## Part 1: Supabase (this is the logins)

1. [ ] Go to supabase.com and sign up (free). Click **New project**. Give it any name. Pick a password and region. Wait a minute for it to finish.
2. [ ] In the left menu open **Project Settings** (gear icon), then **API**.
3. [ ] Copy three things into your notepad:
   - **Project URL** -> `SUPABASE_URL`
   - **anon public** key -> `SUPABASE_ANON_KEY`
   - **service_role** key -> `SUPABASE_SERVICE_ROLE_KEY` (this is secret)
4. [ ] In the left menu open **SQL Editor**, click **New query**. Open the file `supabase/schema.sql` from this project, copy everything in it, paste it into the box, and click **Run**.
5. [ ] In the left menu open **Authentication** -> **Providers** and make sure **Email** is enabled (it usually is by default).

**How you know Part 1 worked:** under **Table Editor** you now see a table called `profiles`. Your notepad has the three Supabase values filled in.

---

## Part 2: Stripe (this is the money)

Stay in **Test mode** the whole time (there is a toggle, usually top-right). You switch to live at the very end.

1. [ ] Go to stripe.com and sign up. Confirm you are in **Test mode**.
2. [ ] Left menu: **Product catalog** -> **Add product**.
   - Name it `SubCaptions Solo`. Under pricing, add a **recurring** price of **$5 / month**. Save.
   - On that product, add a **second** recurring price of **$48 / year**. Save.
3. [ ] Add another product `SubCaptions Team` the same way: a **$18 / month** price and a **$180 / year** price.
4. [ ] Now collect the four **price IDs** (they look like `price_1Nxxxx`). Click each price; the ID is on its page or via the "..." menu. Put them in your notepad:
   - Solo monthly -> `PRICE_SOLO_MONTHLY`
   - Solo yearly -> `PRICE_SOLO_YEARLY`
   - Team monthly -> `PRICE_TEAM_MONTHLY`
   - Team yearly -> `PRICE_TEAM_YEARLY`
5. [ ] Left menu: **Developers** -> **API keys**. Copy the **Secret key** (starts `sk_test_`) -> `STRIPE_SECRET_KEY`.
6. [ ] Left menu: **Settings** -> search "Customer portal" -> turn it **on** and save. (This is what lets customers cancel by themselves.)

**How you know Part 2 worked:** your notepad has four `price_...` IDs and one `sk_test_...` key.

---

## Part 3: Put the billing program online

The `billing/` folder is a tiny program. It needs to live on the internet. The
easiest free-ish host is Render. (Railway or Fly work the same way.)

1. [ ] Put this whole project in a GitHub repo if it is not already (github.com -> New repository -> follow their upload steps, or use GitHub Desktop).
2. [ ] Go to render.com, sign up, click **New** -> **Web Service**, and connect that GitHub repo.
3. [ ] In the settings for the service:
   - **Root Directory:** `billing`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. [ ] Find the **Environment** / **Environment Variables** section and add one row per line below, pasting the value from your notepad. (`APP_URL` is your website address; use it even if the site is not live yet, you can change it later.)
   ```
   STRIPE_SECRET_KEY         = (your sk_test_ key)
   SUPABASE_URL              = (your project URL)
   SUPABASE_SERVICE_ROLE_KEY = (your service_role key)
   APP_URL                   = https://subcaptions.com
   ALLOWED_ORIGIN            = https://subcaptions.com
   PRICE_SOLO_MONTHLY        = price_...
   PRICE_SOLO_YEARLY         = price_...
   PRICE_TEAM_MONTHLY        = price_...
   PRICE_TEAM_YEARLY         = price_...
   ```
   Leave `STRIPE_WEBHOOK_SECRET` out for now. You add it in Part 4.
5. [ ] Click **Create / Deploy**. When it finishes, Render shows a web address like `https://subcaptions-billing.onrender.com`. Copy it into your notepad as `BILLING_URL`.

**How you know Part 3 worked:** open `BILLING_URL` + `/billing/me` in your browser (e.g. `https://...onrender.com/billing/me`). You should see a small message like `{"error":"Not signed in"}`. That error is correct, it means the program is alive.

---

## Part 4: Connect Stripe's webhook (so payments update the account)

A "webhook" is just Stripe phoning your billing program when someone pays.

Note: Stripe renamed this. What used to be "Webhooks" is now under **"Event destinations,"** and the new flow asks for events first, then the URL.

1. [ ] Make sure the toggle is on **Test mode**, then go straight to this address in your browser: `https://dashboard.stripe.com/test/webhooks` (this opens the page directly, no menu hunting). Or via menu: **Developers** -> **Event destinations**.
2. [ ] Click **+ Add destination** (it may say "Add endpoint" or "Create").
3. [ ] When it asks **which events**, search for and tick these four:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. [ ] For the **destination type**, choose **"Webhook endpoint"** (not "Amazon EventBridge" or the other options).
5. [ ] For the **endpoint URL**, paste your `BILLING_URL` followed by `/billing/webhook` (e.g. `https://subcaptions-billing.onrender.com/billing/webhook`). Create it.
6. [ ] On the destination's page, find **Signing secret** and click **Reveal**. Copy that value (starts `whsec_`) -> `STRIPE_WEBHOOK_SECRET`.
7. [ ] Go back to Render, add one more environment variable `STRIPE_WEBHOOK_SECRET = (the whsec_ value)`, and let it redeploy.

**How you know Part 4 worked:** Render finishes redeploying with no errors.

---

## Part 5: Tell the website about all this

1. [ ] Open the file `lib/auth.js` in this project. At the very top, fill in the three blanks from your notepad:
   ```js
   const CONFIG = {
     SUPABASE_URL: "https://xxxx.supabase.co",
     SUPABASE_ANON_KEY: "your anon public key",
     BILLING_BASE: "https://subcaptions-billing.onrender.com",
   };
   ```
   Use the **anon public** key here, never the service_role one.
2. [ ] Give the auto-caption server the same logins. Wherever `transcribe-server` is hosted, add these environment variables:
   ```
   SUPABASE_URL              = (your project URL)
   SUPABASE_ANON_KEY         = (anon public key)
   SUPABASE_SERVICE_ROLE_KEY = (service_role key)
   ```
3. [ ] Re-upload / redeploy the website so the new `lib/auth.js` is live.

**How you know Part 5 worked:** on your site, the top menu now says **Sign in**, and clicking a pricing button asks you to sign in instead of saying "not configured."

---

## Part 6: Test it (still in Stripe Test mode)

1. [ ] On your site, click **Sign in**, type your email, and click the link Supabase emails you.
2. [ ] Go to Pricing, click **Go Solo**. On Stripe's payment page use the fake test card: number `4242 4242 4242 4242`, any future date, any 3-digit code, any zip.
3. [ ] After paying, check Supabase **Table Editor** -> `profiles`: your row's `tier` should now say `solo`. That means everything is wired correctly.
4. [ ] On the editor, the **Auto-generate captions** and **Export burned-in video** buttons should now work for you instead of saying "Pro feature."
5. [ ] Click **Account** -> cancel in the Stripe portal. Within a moment, `profiles.tier` should go back to `free`.

If `tier` flips to `solo` and back to `free`, you are done with testing.

---

## Part 7: Go live (real money)

1. [ ] In Stripe, flip from **Test mode** to **Live mode**.
2. [ ] Re-create the two products and four prices in Live mode (test and live are separate worlds). Copy the new live `price_...` IDs.
3. [ ] Get the live **Secret key** (`sk_live_...`) and create the webhook again in Live mode for a live `whsec_...`.
4. [ ] Update those four price IDs, the `sk_live_` key, and the live `whsec_` in your billing service's environment variables. Redeploy.
5. [ ] Do one real purchase on yourself with a real card to confirm, then refund it from the Stripe dashboard.

That's it. People can now subscribe.

---

## If something goes wrong (quick fixes)
- **Pricing button says "checkout isn't configured":** the three blanks in `lib/auth.js` are empty or the site wasn't re-uploaded.
- **Paid but tier didn't change:** the webhook (Part 4) is wrong. In Stripe -> Webhooks, open your endpoint and look at recent deliveries for red errors. Re-check the URL ends in `/billing/webhook` and the `whsec_` is set in Render.
- **"Not signed in" when clicking checkout:** sign in first (top-right menu), then click the plan again.
- **Never paste the `service_role` key or `sk_` key into `lib/auth.js`.** Those go only in the server's environment variables. The browser only gets the `anon public` key.
