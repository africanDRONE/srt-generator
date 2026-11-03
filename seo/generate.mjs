/**
 * Programmatic-SEO page generator.
 *
 * Run:  node seo/generate.mjs
 *
 * Produces, in the project root:
 *   /translate-srt-to-<lang>/index.html   (one per TARGET_LANGUAGES row)
 *   /<use-case-slug>/index.html           (one per USE_CASES row)
 *   /languages/index.html                 (index of all language pages)
 *   /pricing.html, /privacy.html, /terms.html  (served at /pricing, /privacy, /terms)
 *   /styles/pages.css                     (shared stylesheet)
 *   /sitemap.xml, /robots.txt
 *
 * Each page has unique copy, a how-to, an FAQ with FAQPage structured data,
 * and a deep-linked CTA into the tool (/?from=en&to=<code>) so the page is a
 * real, useful entry point, not a thin doorway.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SITE, TARGET_LANGUAGES, DEFAULT_SOURCE, USE_CASES, CAPTIONER_PAGES, LANGUAGE_COUNT } from "./data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function write(relPath, content) {
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log("  wrote", relPath);
}

/* ---------- shared shell ---------- */
function page({ title, metaDesc, canonical, h1, bodyHtml, jsonLd, extraHead }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(metaDesc)}" />
<meta property="og:type" content="website" />
<link rel="stylesheet" href="/styles/pages.css" />
<link rel="icon" type="image/svg+xml" href="/assets/logo.svg" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/logo-32.png" />
<link rel="apple-touch-icon" href="/assets/logo-180.png" />
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}${extraHead || ""}
</head>
<body>
<header class="nav"><div class="wrap nav-inner">
  <a class="brand" href="/"><img class="mark" src="/assets/logo.svg" width="40" height="40" alt="" /> <span class="brand-name">${esc(SITE.name)}</span></a>
  <nav class="nav-links">
    <a href="/" class="nav-caption">Caption</a>
    <a href="/translate">Translate</a>
    <a href="/pricing">Pricing</a>
    <a href="#" id="account-link" data-account>Sign in</a>
  </nav>
</div></header>
<div class="wrap">
  <main>${bodyHtml}</main>
  <footer class="site">
    <div><a href="/">Caption</a> · <a href="/translate">Translate</a> · <a href="/pricing">Pricing</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></div>
  </footer>
</div>
<script type="module" src="/lib/auth.js"></script>
</body>
</html>`;
}

function faqBlock(faq) {
  const items = faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("\n");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return { html: `<section class="faqs"><h2>Frequently asked questions</h2>${items}</section>`, jsonLd };
}

function stepsBlock(steps) {
  return `<section class="steps"><h2>How it works</h2><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`;
}

function cta(href, label) {
  return `<a class="cta" href="${esc(href)}">${esc(label)}</a>`;
}

/* ---------- language-pair pages ---------- */
function langPage(lang) {
  const slug = `translate-srt-to-${slugify(lang.name)}`;
  const canonical = `${SITE.origin}/${slug}/`;
  const title = `Translate SRT to ${lang.name}, Free Subtitle Translator`;
  const metaDesc = `Translate .srt and .vtt subtitle files from ${DEFAULT_SOURCE.name} to ${lang.name} (${lang.native}) free. AI translation, timecodes preserved, no signup.`;
  const h1 = `Translate SRT subtitles to ${lang.name}`;
  const deep = `/translate?from=${DEFAULT_SOURCE.code}&to=${encodeURIComponent(lang.code)}`;

  const intro = `Translate your <strong>.srt</strong> or <strong>.vtt</strong> subtitles from ${DEFAULT_SOURCE.name} into ${lang.name} (${esc(lang.native)}) in a couple of clicks. ${lang.name} reaches roughly <strong>${esc(lang.speakers)} speakers</strong>, ${esc(lang.note)}. The translation keeps your exact timecodes, and you can edit any line before you export.`;

  const steps = [
    `Drop your ${DEFAULT_SOURCE.name} .srt or .vtt file onto the page (or paste the text).`,
    `${lang.name} is pre-selected as the target, just hit Translate.`,
    `Review the ${lang.name} translation and tweak any line inline.`,
    `To check reading speed and line length on the picture, import the file into the captioner on the home page.`,
    `Download your ${lang.name} subtitles as .srt or .vtt.`,
  ];
  const faq = [
    [`Is the ${DEFAULT_SOURCE.name}-to-${lang.name} translation any good?`, `It's powered by a large language model that translates for natural spoken register, not word-for-word, which matters for subtitles, where literal translations read awkwardly. You can edit any line before exporting, so you stay in control of the final ${lang.name} text.`],
    [`Will the timing still match after translating to ${lang.name}?`, `Yes. Only the text is translated; every start and end timecode is preserved exactly, so the ${lang.name} track stays in sync. Use the video preview to confirm the ${lang.name} lines are short enough to read in the time available.`],
    [`Is it really free to translate SRT to ${lang.name}?`, `Files up to 200 lines are free with no signup. Solo and Team plans add unlimited translations, AI auto-captions, and video upload in the captioner on the home page.`],
    [`Are my files uploaded to a server?`, `The file is read in your browser and is not uploaded as a file. The caption text is sent to our translation service, which passes it to Anthropic's API to be translated. Our service does not store or log the text.`],
  ];

  const { html: faqHtml, jsonLd } = faqBlock(faq);
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <a href="/languages/">Languages</a> › <span>${esc(lang.name)}</span></nav>
    <h1>${esc(h1)}</h1>
    <p class="lede">${intro}</p>
    <div class="cta-row">${cta(deep, `Translate to ${lang.name} →`)}<span class="cta-note">🔒 Free up to 200 lines · no signup</span></div>
    ${stepsBlock(steps)}
    ${faqHtml}
    <section class="related"><h2>Translate to other languages</h2><div class="chips">${TARGET_LANGUAGES.filter((l) => l.code !== lang.code).slice(0, 12).map((l) => `<a href="/translate-srt-to-${slugify(l.name)}/">${esc(l.name)}</a>`).join("")}</div></section>
  `;
  return { slug, canonical, html: page({ title, metaDesc, canonical, h1, bodyHtml, jsonLd }) };
}

/* ---------- use-case pages ---------- */
function useCasePage(uc) {
  const canonical = `${SITE.origin}/${uc.slug}/`;
  const title = `${uc.title}, ${SITE.name}`;
  const { html: faqHtml, jsonLd } = faqBlock(uc.faq);
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>${esc(uc.title)}</span></nav>
    <h1>${esc(uc.h1)}</h1>
    <p class="lede">${esc(uc.intro)}</p>
    <div class="cta-row">${cta("/translate", "Open the translator →")}<span class="cta-note">🔒 Free up to 200 lines · no signup</span></div>
    ${stepsBlock(uc.steps)}
    ${faqHtml}
    <section class="related"><h2>Popular language pairs</h2><div class="chips">${TARGET_LANGUAGES.slice(0, 12).map((l) => `<a href="/translate-srt-to-${slugify(l.name)}/">SRT to ${esc(l.name)}</a>`).join("")}</div></section>
  `;
  return { slug: uc.slug, canonical, html: page({ title, metaDesc: uc.metaDesc, canonical, h1: uc.h1, bodyHtml, jsonLd }) };
}

/* ---------- captioner guide pages (HERO intent -> the editor at /) ---------- */
function guideChips(exceptSlug) {
  return `<div class="chips">${CAPTIONER_PAGES.filter((c) => c.slug !== exceptSlug).map((c) => `<a href="/${c.slug}/">${esc(c.h1)}</a>`).join("")}</div>`;
}
function captionerPage(cp) {
  const canonical = `${SITE.origin}/${cp.slug}/`;
  const title = `${cp.title} | ${SITE.name}`;
  const { html: faqHtml, jsonLd } = faqBlock(cp.faq);
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>${esc(cp.title)}</span></nav>
    <h1>${esc(cp.h1)}</h1>
    <p class="lede">${esc(cp.intro)}</p>
    <div class="cta-row">${cta("/", "Caption a video →")}<span class="cta-note">🔒 Free · no signup · saved in your browser</span></div>
    ${stepsBlock(cp.steps)}
    ${faqHtml}
    <section class="related"><h2>More guides</h2>${guideChips(cp.slug)}</section>
    <section class="related"><h2>Or translate subtitles</h2><div class="chips"><a href="/translate">Translate a file</a>${TARGET_LANGUAGES.slice(0, 8).map((l) => `<a href="/translate-srt-to-${slugify(l.name)}/">SRT to ${esc(l.name)}</a>`).join("")}</div></section>
  `;
  return { slug: cp.slug, canonical, html: page({ title, metaDesc: cp.metaDesc, canonical, h1: cp.h1, bodyHtml, jsonLd }) };
}

/* ---------- languages index ---------- */
function languagesIndex() {
  const canonical = `${SITE.origin}/languages/`;
  const rows = [...TARGET_LANGUAGES]
    .sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name))
    .map((l) => `<a class="lang-card" href="/translate-srt-to-${slugify(l.name)}/"><strong>${esc(l.name)}</strong><span>${esc(l.native)} · ${esc(l.speakers)}</span></a>`)
    .join("");
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>Languages</span></nav>
    <h1>Translate subtitles into ${LANGUAGE_COUNT} languages</h1>
    <p class="lede">Pick a language to translate your .srt or .vtt subtitles into. Every page opens the tool with that language pre-selected. These ${TARGET_LANGUAGES.length} pages cover the most requested languages, and the translator offers ${LANGUAGE_COUNT} in total.</p>
    <div class="lang-grid">${rows}</div>
    <section class="related"><h2>Captioning guides</h2>${guideChips()}</section>
  `;
  return page({ title: `Translate Subtitles, All Languages | ${SITE.name}`, metaDesc: `Translate .srt and .vtt subtitle files into ${LANGUAGE_COUNT} languages free. Spanish, French, Japanese, Hindi, Arabic, and more.`, canonical, h1: "All languages", bodyHtml });
}

/* ---------- pricing ---------- */
// Inline copy of the .soon badge style; the committed styles/pages.css does not include it.
const SOON_STYLE = `<style>.soon{font-style:normal;font-size:11px;font-weight:700;color:#9a3412;background:#ffedd5;border-radius:6px;padding:1px 7px;margin-left:4px;vertical-align:middle;white-space:nowrap}</style>`;
function pricingPage() {
  const canonical = `${SITE.origin}/pricing`;
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>Pricing</span></nav>
    <h1>Pricing</h1>
    <p class="lede">Caption by hand for free. Solo adds AI auto-captions (for uploaded files and for direct, Dropbox, Google Drive, and Frame.io links) and unlimited translations. Team adds translator handoff, where you send a link and your translator subtitles in their browser. On any plan, a free account keeps your projects in sync across devices.</p>
    <div class="bill-toggle">
      <button type="button" class="bill-opt active" data-bill="monthly">Monthly</button>
      <button type="button" class="bill-opt" data-bill="yearly">Yearly <span class="bill-save">2 months free</span></button>
    </div>
    <div class="price-grid">
      <div class="price-card">
        <h2>Free</h2>
        <div class="price">$0</div>
        <ul>
          <li>Caption any video up to 45 minutes</li>
          <li>Captions saved in your browser</li>
          <li>.srt &amp; .vtt export, no watermark</li>
          <li>One translation per video</li>
          <li>${LANGUAGE_COUNT} languages</li>
          <li>No signup, or a free account to sync projects across devices</li>
        </ul>
        <a class="cta" href="/">Caption a video →</a>
        <p class="price-fine">No card required.</p>
      </div>
      <div class="price-card featured">
        <div class="badge">Most popular</div>
        <h2>Solo</h2>
        <div class="price" data-mo="6" data-yr="60">$6<span>/mo</span></div>
        <ul>
          <li>AI auto-captions for uploads and direct, Dropbox, Drive, and Frame.io links (not YouTube or Vimeo)</li>
          <li>Full-length videos, no cap</li>
          <li>Unlimited translations (fair-use daily limit)</li>
          <li>Video file upload (up to 2&nbsp;GB, deleted after 7 days)</li>
          <li>Burned-in video export (1080p) <em class="soon">coming soon</em></li>
          <li>Everything in Free</li>
        </ul>
        <a class="cta" href="#" data-plan="solo_monthly" data-plan-monthly="solo_monthly" data-plan-yearly="solo_yearly">Go Solo →</a>
        <p class="price-fine" data-mo-fine="Or $60/year (2 months free)." data-yr-fine="$60/year · 2 months free">Or $60/year (2 months free).</p>
      </div>
      <div class="price-card">
        <h2>Team</h2>
        <div class="price" data-mo="12" data-yr="120">$12<span>/mo</span></div>
        <ul>
          <li>Everything in Solo</li>
          <li>Hand off to a translator with a share link</li>
          <li>4K &amp; long-form burned-in export <em class="soon">coming soon</em></li>
          <li>Priority processing <em class="soon">coming soon</em></li>
        </ul>
        <a class="cta" href="#" data-plan="team_monthly" data-plan-monthly="team_monthly" data-plan-yearly="team_yearly">Go Team →</a>
        <p class="price-fine" data-mo-fine="Or $120/year (2 months free)." data-yr-fine="$120/year · 2 months free">Or $120/year (2 months free).</p>
      </div>
    </div>
    <script>
    (function () {
      function apply(bill) {
        var yearly = bill === "yearly";
        document.querySelectorAll(".bill-opt").forEach(function (o) { o.classList.toggle("active", o.dataset.bill === bill); });
        document.querySelectorAll(".price[data-mo]").forEach(function (p) {
          p.innerHTML = "$" + (yearly ? p.dataset.yr : p.dataset.mo) + "<span>" + (yearly ? "/yr" : "/mo") + "</span>";
        });
        document.querySelectorAll(".cta[data-plan-monthly]").forEach(function (c) {
          c.setAttribute("data-plan", yearly ? c.dataset.planYearly : c.dataset.planMonthly);
        });
        document.querySelectorAll(".price-fine[data-mo-fine]").forEach(function (f) {
          f.textContent = yearly ? f.dataset.yrFine : f.dataset.moFine;
        });
        // Changing data-plan resets the tier-aware label, so re-apply it.
        if (window.SubAuth && window.SubAuth.relabelPlans) window.SubAuth.relabelPlans();
      }
      function wire() {
        document.querySelectorAll(".bill-opt").forEach(function (o) {
          o.addEventListener("click", function (e) { e.preventDefault(); apply(o.dataset.bill); });
        });
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
      else wire();
    })();
    </script>

    <h2 style="text-align:center;margin-top:44px;">What makes SubCaptions different</h2>
    <div class="lang-grid">
      <div class="lang-card"><strong>Caption on the live video</strong><span>Type in time with the picture, not a wall of text in a side panel.</span></div>
      <div class="lang-card"><strong>Any language</strong><span>Including ones auto-captions and the big editors don't support.</span></div>
      <div class="lang-card"><strong>Hand off to a translator</strong><span>Team plan. They work right on the video, with no file round-trips.</span></div>
      <div class="lang-card"><strong>Subtitle limits built in</strong><span>Lines are capped at 42 characters and two per caption, and the editor warns when a caption is too fast to read.</span></div>
      <div class="lang-card"><strong>Short-lived video storage</strong><span>Linked videos play from their own site. Uploaded files are deleted after 7 days. See the <a href="/privacy">privacy policy</a>.</span></div>
      <div class="lang-card"><strong>No signup to start</strong><span>Caption and export for free, instantly.</span></div>
    </div>

    <p class="lede" style="margin-top:24px;font-size:14px;">Need higher volume for an agency or team? <a href="mailto:support@subcaptions.com">Get in touch.</a></p>
    <script type="module" src="/lib/auth.js"></script>
  `;
  return page({ title: `Pricing | ${SITE.name}`, metaDesc: "SubCaptions pricing. Caption free; Solo $6/mo adds AI auto-captions, full-length videos, and unlimited translations; Team $12/mo adds translator handoff.", canonical, h1: "Pricing", bodyHtml, extraHead: SOON_STYLE });
}

/* ---------- shared stylesheet ---------- */
const CSS = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');
:root{--bg:#f5f6fd;--surface:#fff;--surface-2:#f3f4fb;--border:#e7e8f3;--border-strong:#d8dae9;--text:#161731;--text-soft:#41435f;--muted:#7d8099;--brand1:#6366f1;--brand2:#a855f7;--brand3:#ec4899;--grad:linear-gradient(135deg,#6366f1 0%,#a855f7 55%,#ec4899 100%);--grad-soft:linear-gradient(135deg,rgba(99,102,241,.12),rgba(236,72,153,.12));--success:#10b981;--gold:#f5b94a;--radius:16px;--shadow-sm:0 2px 8px rgba(80,70,160,.06);--shadow:0 14px 40px rgba(80,70,160,.12);--fd:"Space Grotesk",system-ui,sans-serif;--fb:"Inter",-apple-system,system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--fb);background:var(--bg);color:var(--text);line-height:1.6;font-size:15px;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(680px 520px at 12% -5%,rgba(99,102,241,.16),transparent 60%),radial-gradient(600px 520px at 100% 0%,rgba(236,72,153,.12),transparent 55%)}
a{color:var(--brand1);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:840px;margin:0 auto;padding:18px 20px 60px}
header.site{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--fd);font-weight:700;font-size:18px;color:var(--text)}.brand:hover{text-decoration:none}
.brand .logo{width:30px;height:30px;border-radius:8px;background:var(--grad);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:var(--shadow-sm)}
header.site nav a{color:var(--text-soft);margin-left:20px;font-size:14px;font-weight:500}header.site nav a:hover{color:var(--text);text-decoration:none}
header.nav{position:sticky;top:0;z-index:50;backdrop-filter:saturate(180%) blur(14px);background:rgba(245,246,253,.78);border-bottom:1px solid var(--border);margin-bottom:30px}
header.nav .nav-inner{max-width:1180px;margin:0 auto;padding:0 22px;display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
header.nav .brand{font-size:19px}
header.nav .brand .mark{width:40px;height:40px;border-radius:11px;background:var(--grad);box-shadow:var(--shadow-sm);display:block;flex:none;padding:0;border:0}
header.nav .nav-links{display:flex;align-items:center;gap:26px}
header.nav .nav-links a{color:var(--text-soft);font-size:14.5px;font-weight:500;margin:0}header.nav .nav-links a:hover{color:var(--text);text-decoration:none}
#account-link{background:var(--grad);color:#fff;padding:8px 16px;border-radius:10px;font-weight:600;box-shadow:var(--shadow-sm)}#account-link:hover{filter:brightness(1.06);color:#fff;text-decoration:none}
@media(max-width:560px){header.nav .nav-links{gap:16px}header.nav .nav-links a{font-size:13px}}
/* Phones: keep the header inside 375px with no sideways scroll, as on the home page. */
@media(max-width:480px){.brand .mark{width:34px;height:34px}.brand-name{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}header.nav .nav-links{gap:12px}#account-link{padding:6px 10px}}
@media(max-width:400px){.nav-caption{display:none}}
.crumbs{color:var(--muted);font-size:13px;margin-bottom:16px}.crumbs span{color:var(--text)}
h1{font-family:var(--fd);font-size:clamp(28px,4vw,40px);font-weight:700;letter-spacing:-0.8px;margin-bottom:16px;line-height:1.12}
h2{font-family:var(--fd);font-size:23px;margin:34px 0 14px;letter-spacing:-0.3px}
.lede{color:var(--text-soft);font-size:17px;margin-bottom:24px}.lede strong{color:var(--text)}
.legal .lede{font-size:13.5px!important;line-height:1.6;margin-bottom:14px}.legal h2{font-size:17px;margin-top:22px}
.cta-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:6px 0 8px}
.cta{display:inline-block;background:var(--grad);color:#fff;font-weight:600;padding:14px 28px;border-radius:12px;font-size:15px;box-shadow:0 8px 22px rgba(124,58,237,.32);transition:transform .12s}
.cta:hover{transform:translateY(-2px);text-decoration:none}
.cta-note{color:var(--success);font-size:13px;font-weight:500}
.steps ol{padding-left:22px}.steps li{margin-bottom:9px;color:var(--text-soft)}
.faqs{margin-top:38px}
details.faq{border:1px solid var(--border);border-radius:12px;margin-bottom:9px;background:var(--surface);box-shadow:var(--shadow-sm)}
details.faq summary{cursor:pointer;padding:15px 18px;font-weight:600;list-style:none}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary:before{content:"+ ";color:var(--brand1);font-weight:700}details.faq[open] summary:before{content:"– "}
details.faq p{padding:0 18px 16px;color:var(--text-soft)}
.related{margin-top:38px}
.chips{display:flex;flex-wrap:wrap;gap:9px}
.chips a{background:var(--surface);border:1px solid var(--border);padding:8px 15px;border-radius:999px;font-size:13px;color:var(--text-soft);box-shadow:var(--shadow-sm)}
.chips a:hover{border-color:var(--brand1);color:var(--brand1);text-decoration:none}
.lang-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin-top:20px}
.lang-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;display:flex;flex-direction:column;gap:3px;box-shadow:var(--shadow-sm);transition:transform .14s,box-shadow .14s}
.lang-card:hover{transform:translateY(-3px);box-shadow:var(--shadow);text-decoration:none}.lang-card strong{font-family:var(--fd);font-size:16px}.lang-card span{color:var(--muted);font-size:12.5px}
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:20px;width:min(1000px,94vw);position:relative;left:50%;transform:translateX(-50%)}
.price-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px;position:relative;box-shadow:var(--shadow-sm);display:flex;flex-direction:column}
.soon{font-style:normal;font-size:11px;font-weight:700;color:#9a3412;background:#ffedd5;border-radius:6px;padding:1px 7px;margin-left:4px;vertical-align:middle;white-space:nowrap}
.price-card.featured{border-color:transparent;box-shadow:0 20px 50px rgba(124,58,237,.18);background:linear-gradient(var(--surface),var(--surface)) padding-box,var(--grad) border-box;border:2px solid transparent}
.price-card .badge{position:absolute;top:-12px;left:28px;background:var(--grad);color:#fff;font-size:11px;font-weight:700;padding:4px 12px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px}
.price-card h2{font-family:var(--fd);margin:0 0 6px}.price{font-family:var(--fd);font-size:42px;font-weight:700;margin-bottom:16px}.price span{font-size:16px;color:var(--muted);font-weight:400}
.price-card ul{list-style:none;margin-bottom:20px;flex:1 1 auto}.price-card li{padding:7px 0 7px 26px;position:relative;color:var(--text-soft);font-size:14px}
.price-card .cta{margin-top:auto}.price-fine{min-height:18px}
.price-card li:before{content:"✓";position:absolute;left:0;color:var(--success);font-weight:700}
.price-card .cta{width:100%;text-align:center}
.price-fine{color:var(--muted);font-size:12.5px;margin-top:12px;text-align:center}
.bill-toggle{display:flex;justify-content:center;gap:4px;margin:6px auto 0;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:4px;width:max-content}
.bill-opt{border:none;background:none;font-family:inherit;font-size:14px;font-weight:600;color:var(--text-soft);padding:8px 18px;border-radius:999px;cursor:pointer}
.bill-opt.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.bill-save{font-size:11px;color:var(--success);font-weight:700;margin-left:4px}
footer.site{margin-top:50px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:13px;text-align:center}
footer.site a{color:var(--text-soft);margin:0 7px}.fine{margin-top:10px}
@media(max-width:720px){.price-grid{grid-template-columns:1fr;width:100%;left:auto;transform:none}}
@media(max-width:640px){header.site nav a{margin-left:14px}}`;

/* ---------- run ---------- */
console.log("Generating SEO pages…");
const urls = [`${SITE.origin}/`, `${SITE.origin}/translate`, `${SITE.origin}/languages/`, `${SITE.origin}/pricing`, `${SITE.origin}/subtitle-specs/`, `${SITE.origin}/privacy`, `${SITE.origin}/terms`];

function legalPage(slug, h1, inner) {
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>${esc(h1)}</span></nav>
    <h1>${esc(h1)}</h1>
    <div class="legal">${inner}</div>
    <p class="lede" style="font-size:13px;margin-top:34px;color:var(--muted);">Questions about this? Email <a href="mailto:support@subcaptions.com">support@subcaptions.com</a>.</p>`;
  return page({ title: `${h1} | ${SITE.name}`, metaDesc: `${h1} for ${SITE.name}, the browser-based subtitle and caption editor.`, canonical: `${SITE.origin}/${slug}`, h1, bodyHtml });
}

function privacyPage() {
  return legalPage("privacy", "Privacy Policy", `
    <p class="lede">Last updated: November 3, 2026. This explains what SubCaptions collects, how it is used, and the choices you have. SubCaptions is a browser-based subtitle and caption editor.</p>

    <h2>The short version</h2>
    <p class="lede" style="font-size:15px;">Captions you write are saved in your browser on your device. If you sign in, your projects are also saved to your account on our servers. Videos you link from sites such as YouTube or Vimeo play from those sites. Videos you send for AI auto-captions, or upload on a paid plan, are handled on our servers as described below. We collect what we need to run accounts and billing (your email and plan), and we use a few outside services for sign-in, payments, hosting, translation, and speech-to-text. We do not sell your data.</p>

    <h2>What we collect</h2>
    <p class="lede" style="font-size:15px;"><strong>Account.</strong> If you sign in, we store your email address and (from Google sign-in) your display name, plus your plan tier. Sign-in is handled by Supabase. <strong>Billing.</strong> Payments are handled by Stripe; we receive your subscription status and a customer ID, never your full card number. <strong>Projects.</strong> If you are signed in, we save each project to our database: its captions, any translations, the video link, and a small thumbnail image. <strong>Uploaded videos.</strong> On a Solo or Team plan you can upload a video file of up to 2 GB. It is stored in Cloudflare R2 storage and deleted automatically after 7 days, or sooner if you delete it. <strong>Basic technical data.</strong> Like most sites, our hosts may log standard request information (such as IP address and browser type) for security and reliability.</p>

    <h2>What we do not do</h2>
    <p class="lede" style="font-size:15px;">We do not sell personal data and we do not use third-party advertising cookies. When you paste a link, the video plays in your browser from the site that hosts it, and we do not copy it unless you ask for AI auto-captions.</p>

    <h2>How your caption content is handled</h2>
    <p class="lede" style="font-size:15px;"><strong>Subtitle files.</strong> A subtitle file you open on the translate page is read in your browser and is not uploaded as a file. <strong>Translation.</strong> When you use translation, the caption text is sent to our translation service, which passes it to Anthropic's API to produce the translation. Our service does not store or log the text, and Anthropic's own terms apply to its handling of that data. <strong>AI auto-captions (Solo and Team).</strong> Your uploaded file or video link is sent to our transcription server, which downloads the video temporarily, extracts the audio, and sends the audio to a third-party speech-to-text provider to generate the text. The temporary files are deleted when processing ends, and the provider's own terms apply to the audio it receives. <strong>Share links (Team).</strong> If you create a share link for a translator, anyone who has the link can open the shared project and, by default, edit its captions without signing in. Each link stops working 30 days after you create it, and you can revoke a link sooner from the share window.</p>

    <h2>Services we rely on</h2>
    <p class="lede" style="font-size:15px;">We rely on a small set of third-party providers to run the service: Cloudflare (hosting, content delivery, and upload storage), Render (application servers), Supabase (sign-in and the project database), Stripe (payments), Anthropic (AI translation), a speech-to-text provider (auto-captions), Google (Google sign-in and Google Fonts), esm.sh (delivers the sign-in code library), and Frame.io if you connect your account to load video from it. Videos from YouTube and Vimeo load those services' own embedded players. Each receives the data needed for its function, under its own privacy terms.</p>

    <h2>Cookies and local storage</h2>
    <p class="lede" style="font-size:15px;">We use your browser's local storage to keep you signed in and to save your captions on your device. We do not use advertising or cross-site tracking cookies.</p>

    <h2>Retention and your choices</h2>
    <p class="lede" style="font-size:15px;">We keep account and billing data while your account is active. Projects stay in your account until you delete them: removing a project from your recent projects list in the editor also removes its cloud copy. Uploaded videos expire after 7 days and can be deleted sooner from the editor. Captions saved in your browser stay there until you delete the project or clear your browser's site data. To access, correct, or delete your account data, email us and we will action it.</p>

    <h2>Children</h2>
    <p class="lede" style="font-size:15px;">SubCaptions is not directed to children under 13, and we do not knowingly collect their data.</p>

    <h2>Changes</h2>
    <p class="lede" style="font-size:15px;">If we update this policy we will post the new version here with a revised date.</p>`);
}

function termsPage() {
  return legalPage("terms", "Terms of Service", `
    <p class="lede">Last updated: June 22, 2026. These terms govern your use of SubCaptions. By using the site, you agree to them.</p>

    <h2>The service</h2>
    <p class="lede" style="font-size:15px;">SubCaptions is a browser-based tool for creating, editing, and translating subtitles and captions for video. Some features are free; others require a paid plan.</p>

    <h2>Your account</h2>
    <p class="lede" style="font-size:15px;">You can sign in with Google or an email link. You are responsible for activity under your account. Keep your access secure and let us know if you suspect misuse.</p>

    <h2>Plans and billing</h2>
    <p class="lede" style="font-size:15px;">Free has no charge. Solo and Team are subscriptions billed monthly or yearly through Stripe. Paid plans renew automatically until you cancel. You can cancel any time from the billing portal; cancellation stops future charges and your access continues until the end of the period you already paid for. Refunds are handled case by case and as required by law.</p>

    <h2>Your content and rights</h2>
    <p class="lede" style="font-size:15px;">You keep ownership of the captions you create. You are responsible for having the rights to caption or translate the videos you use, and for complying with the terms of any platform a video comes from. You grant us a limited license to process your content solely to provide the service to you.</p>

    <h2>Acceptable use</h2>
    <p class="lede" style="font-size:15px;">Do not use SubCaptions for unlawful content, to infringe others' rights, to download or process material you do not have the rights to, to resell the service, or to abuse or overload the system.</p>

    <h2>AI features</h2>
    <p class="lede" style="font-size:15px;">AI translation and auto-captions are provided to help you work faster, but they can contain errors. Review the output before you rely on or publish it.</p>

    <h2>Availability and changes</h2>
    <p class="lede" style="font-size:15px;">The service is provided on an "as is" and "as available" basis. We may change, add, or discontinue features.</p>

    <h2>Disclaimers and liability</h2>
    <p class="lede" style="font-size:15px;">To the fullest extent permitted by law, SubCaptions is provided without warranties, and we are not liable for indirect or consequential damages. Our total liability is limited to the amount you paid us in the twelve months before the claim.</p>

    <h2>Termination</h2>
    <p class="lede" style="font-size:15px;">We may suspend or end access for violations of these terms. You can stop using the service at any time.</p>

    <h2>Governing law</h2>
    <p class="lede" style="font-size:15px;">These terms are governed by the laws of the State of Michigan, United States, without regard to its conflict-of-laws rules.</p>`);
}

write("styles/pages.css", CSS);
write("languages/index.html", languagesIndex());
write("pricing.html", pricingPage());
write("privacy.html", privacyPage());
write("terms.html", termsPage());

for (const cp of CAPTIONER_PAGES) {
  const p = captionerPage(cp);
  write(`${p.slug}/index.html`, p.html);
  urls.push(p.canonical);
}
for (const lang of TARGET_LANGUAGES) {
  const p = langPage(lang);
  write(`${p.slug}/index.html`, p.html);
  urls.push(p.canonical);
}
for (const uc of USE_CASES) {
  const p = useCasePage(uc);
  write(`${p.slug}/index.html`, p.html);
  urls.push(p.canonical);
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}
</urlset>`;
write("sitemap.xml", sitemap);
write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE.origin}/sitemap.xml\n`);

console.log(`\nDone. ${urls.length} URLs. Set SITE.origin in seo/data.mjs to your real domain before deploying.`);
