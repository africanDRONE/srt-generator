/**
 * Programmatic-SEO page generator.
 *
 * Run:  node seo/generate.mjs
 *
 * Produces, in the project root:
 *   /translate-srt-to-<lang>/index.html   (one per TARGET_LANGUAGES row)
 *   /<use-case-slug>/index.html           (one per USE_CASES row)
 *   /languages/index.html                 (index of all language pages)
 *   /pricing.html                         (free vs Pro)
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
import { SITE, TARGET_LANGUAGES, DEFAULT_SOURCE, USE_CASES, CAPTIONER_PAGES } from "./data.mjs";

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
function page({ title, metaDesc, canonical, h1, bodyHtml, jsonLd }) {
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
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
</head>
<body>
<header class="nav"><div class="wrap nav-inner">
  <a class="brand" href="/"><img class="mark" src="/assets/logo.svg" width="40" height="40" alt="" /> ${esc(SITE.name)}</a>
  <nav class="nav-links">
    <a href="/">Caption</a>
    <a href="/translate.html">Translate</a>
    <a href="/pricing.html">Pricing</a>
    <a href="#" id="account-link" data-account>Sign in</a>
  </nav>
</div></header>
<div class="wrap">
  <main>${bodyHtml}</main>
  <footer class="site">
    <div><a href="/">Caption a video</a> · <a href="/translate.html">Translate</a> · <a href="/languages/">All languages</a> · <a href="/pricing.html">Pricing</a></div>
    <div class="fine">${esc(SITE.name)}, ${esc(SITE.tagline)} Files are parsed in your browser and never stored.</div>
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
  const metaDesc = `Translate .srt and .vtt subtitle files from ${DEFAULT_SOURCE.name} to ${lang.name} (${lang.native}) free. AI translation, preview on video, no signup, files never stored.`;
  const h1 = `Translate SRT subtitles to ${lang.name}`;
  const deep = `/translate.html?from=${DEFAULT_SOURCE.code}&to=${encodeURIComponent(lang.code)}`;

  const intro = `Translate your <strong>.srt</strong> or <strong>.vtt</strong> subtitles from ${DEFAULT_SOURCE.name} into ${lang.name} (${esc(lang.native)}) in a couple of clicks. ${lang.name} reaches roughly <strong>${esc(lang.speakers)} speakers</strong>, ${esc(lang.note)}. The translation keeps your exact timecodes, and you can preview the ${lang.name} captions on the real video before you export.`;

  const steps = [
    `Drop your ${DEFAULT_SOURCE.name} .srt or .vtt file onto the page (or paste the text).`,
    `${lang.name} is pre-selected as the target, just hit Translate.`,
    `Review the ${lang.name} translation and tweak any line inline.`,
    `Preview it on the actual video to check reading speed and line length.`,
    `Download your ${lang.name} subtitles as .srt or .vtt.`,
  ];
  const faq = [
    [`Is the ${DEFAULT_SOURCE.name}-to-${lang.name} translation any good?`, `It's powered by a large language model that translates for natural spoken register, not word-for-word, which matters for subtitles, where literal translations read awkwardly. You can edit any line before exporting, so you stay in control of the final ${lang.name} text.`],
    [`Will the timing still match after translating to ${lang.name}?`, `Yes. Only the text is translated; every start and end timecode is preserved exactly, so the ${lang.name} track stays in sync. Use the video preview to confirm the ${lang.name} lines are short enough to read in the time available.`],
    [`Is it really free to translate SRT to ${lang.name}?`, `Single files up to the free line limit are free with no signup. Larger files and batch jobs are covered by the paid Pro tier.`],
    [`Are my files uploaded to a server?`, `No. Your subtitle file is parsed entirely in your browser. Only the caption text is sent to the translation engine, and it is never stored or logged.`],
  ];

  const { html: faqHtml, jsonLd } = faqBlock(faq);
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <a href="/languages/">Languages</a> › <span>${esc(lang.name)}</span></nav>
    <h1>${esc(h1)}</h1>
    <p class="lede">${intro}</p>
    <div class="cta-row">${cta(deep, `Translate to ${lang.name} →`)}<span class="cta-note">🔒 Free · no signup · files never stored</span></div>
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
    <div class="cta-row">${cta("/translate.html", "Open the translator →")}<span class="cta-note">🔒 Free · no signup · files never stored</span></div>
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
    <section class="related"><h2>Or translate subtitles</h2><div class="chips"><a href="/translate.html">Translate a file</a>${TARGET_LANGUAGES.slice(0, 8).map((l) => `<a href="/translate-srt-to-${slugify(l.name)}/">SRT to ${esc(l.name)}</a>`).join("")}</div></section>
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
    <h1>Translate subtitles into any language</h1>
    <p class="lede">Pick a language to translate your .srt or .vtt subtitles into. Every page opens the tool with that language pre-selected.</p>
    <div class="lang-grid">${rows}</div>
    <section class="related"><h2>Captioning guides</h2>${guideChips()}</section>
  `;
  return page({ title: `Translate Subtitles, All Languages | ${SITE.name}`, metaDesc: `Translate .srt and .vtt subtitle files into ${TARGET_LANGUAGES.length}+ languages free. Spanish, French, Japanese, Hindi, Arabic, and more.`, canonical, h1: "All languages", bodyHtml });
}

/* ---------- pricing ---------- */
function pricingPage() {
  const canonical = `${SITE.origin}/pricing.html`;
  const bodyHtml = `
    <nav class="crumbs"><a href="/">Home</a> › <span>Pricing</span></nav>
    <h1>Pricing that undercuts everyone</h1>
    <p class="lede">Caption by hand for free. Solo adds AI auto-captions, unlimited translations, and burned-in export for a fraction of the usual price. Team lets you hand a project to a translator who works right on the video.</p>
    <div class="bill-toggle">
      <button type="button" class="bill-opt active" data-bill="monthly">Monthly</button>
      <button type="button" class="bill-opt" data-bill="yearly">Yearly <span class="bill-save">save 20%</span></button>
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
          <li>50+ languages</li>
          <li>No signup</li>
        </ul>
        <a class="cta" href="/">Caption a video →</a>
        <p class="price-fine">No card required.</p>
      </div>
      <div class="price-card featured">
        <div class="badge">Most popular</div>
        <h2>Solo</h2>
        <div class="price" data-mo="5" data-yr="48">$5<span>/mo</span></div>
        <ul>
          <li>AI auto-captions (any language)</li>
          <li>Full-length videos, no cap</li>
          <li>Unlimited translations, many at once</li>
          <li>Burned-in video export (1080p)</li>
          <li>Batch multiple files</li>
          <li>Everything in Free</li>
        </ul>
        <a class="cta" href="#" data-plan="solo_monthly" data-plan-monthly="solo_monthly" data-plan-yearly="solo_yearly">Go Solo →</a>
        <p class="price-fine" data-mo-fine="Or $48/year." data-yr-fine="$48/year · save $12">Or $48/year.</p>
      </div>
      <div class="price-card">
        <h2>Team</h2>
        <div class="price" data-mo="18" data-yr="180">$18<span>/mo</span></div>
        <ul>
          <li>Hand off to a translator with a share link</li>
          <li>Cloud-saved projects across devices</li>
          <li>4K and long-form burned-in export</li>
          <li>Priority processing</li>
          <li>Everything in Solo</li>
        </ul>
        <a class="cta" href="#" data-plan="team_monthly" data-plan-monthly="team_monthly" data-plan-yearly="team_yearly">Go Team →</a>
        <p class="price-fine" data-mo-fine="Or $180/year (2 months free)." data-yr-fine="$180/year · 2 months free">Or $180/year (2 months free).</p>
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
      }
      document.querySelectorAll(".bill-opt").forEach(function (o) {
        o.addEventListener("click", function () { apply(o.dataset.bill); });
      });
    })();
    </script>

    <h2 style="text-align:center;margin-top:44px;">What makes SubCaptions different</h2>
    <div class="lang-grid">
      <div class="lang-card"><strong>Caption on the live video</strong><span>Type in time with the picture, not a wall of text in a side panel.</span></div>
      <div class="lang-card"><strong>Any language</strong><span>Including ones auto-captions and the big editors don't support.</span></div>
      <div class="lang-card"><strong>Hand off to a translator</strong><span>They work right on the video, with no file round-trips.</span></div>
      <div class="lang-card"><strong>Festival-ready by default</strong><span>Enforces 42-character lines and readable timing automatically.</span></div>
      <div class="lang-card"><strong>Stays in your browser</strong><span>Your files are parsed locally and never uploaded.</span></div>
      <div class="lang-card"><strong>No signup to start</strong><span>Caption and export for free, instantly.</span></div>
    </div>

    <p class="lede" style="margin-top:24px;font-size:14px;">Higher volume or API access for an agency? <a href="/">Get in touch.</a></p>
    <script type="module" src="/lib/auth.js"></script>
  `;
  return page({ title: `Pricing | ${SITE.name}`, metaDesc: "SubCaptions pricing. Caption free; Solo $5/mo for AI captions, full-length, and burned-in export; Team $18/mo for translator handoff and 4K burn-in.", canonical, h1: "Pricing", bodyHtml });
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
.crumbs{color:var(--muted);font-size:13px;margin-bottom:16px}.crumbs span{color:var(--text)}
h1{font-family:var(--fd);font-size:clamp(28px,4vw,40px);font-weight:700;letter-spacing:-0.8px;margin-bottom:16px;line-height:1.12}
h2{font-family:var(--fd);font-size:23px;margin:34px 0 14px;letter-spacing:-0.3px}
.lede{color:var(--text-soft);font-size:17px;margin-bottom:24px}.lede strong{color:var(--text)}
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
const urls = [`${SITE.origin}/`, `${SITE.origin}/translate.html`, `${SITE.origin}/languages/`, `${SITE.origin}/pricing.html`];

write("styles/pages.css", CSS);
write("languages/index.html", languagesIndex());
write("pricing.html", pricingPage());

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
