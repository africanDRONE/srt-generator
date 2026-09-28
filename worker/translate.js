/**
 * Subtitle Translator, Cloudflare Worker translation proxy.
 *
 * Holds the Anthropic API key server-side and translates a batch of subtitle
 * cues with Claude. The browser never sees the key; only caption text transits
 * this Worker, and nothing is stored or logged here.
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler secret put ANTHROPIC_API_KEY      (paste your key)
 *   3. wrangler deploy
 *   4. Put the resulting *.workers.dev URL into index.html's API_BASE.
 *
 * Env vars (wrangler.toml [vars] or secrets):
 *   ANTHROPIC_API_KEY  (secret, required)
 *   MODEL              (optional, default claude-opus-4-8, see cost note below)
 *   ALLOWED_ORIGIN     (optional, default "*"; set to your domain in production)
 *   MAX_CUES           (optional, default 60, hard cap per request, abuse guard)
 *   UPSTREAM_TIMEOUT_MS (optional, default 30000, longest wait for one Anthropic call)
 *   DEADLINE_MS        (optional, default 40000, no Anthropic call runs past this point in a
 *                       request; keep it below the pages' 45 second request timeout)
 *
 * Cost note: claude-opus-4-8 is premium ($5/$25 per MTok). For a high-volume
 * free tool you will almost certainly want MODEL=claude-haiku-4-5 ($1/$5) or
 * claude-sonnet-4-6 ($3/$15). Quality on subtitle translation is very good on
 * all three; see docs/monetization.md for the unit-economics breakdown.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }

    const { source, target, cues } = payload || {};
    if (!Array.isArray(cues) || cues.length === 0) return json({ error: "No cues provided" }, 400, cors);
    if (!target || typeof target !== "string") return json({ error: "Missing target language" }, 400, cors);

    const maxCues = parseInt(env.MAX_CUES || "60", 10);
    if (cues.length > maxCues) return json({ error: `Too many cues in one request (max ${maxCues})` }, 413, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server not configured" }, 500, cors);

    const model = env.MODEL || DEFAULT_MODEL;
    const srcLabel = source && source !== "auto" ? source : "the source language (auto-detect it)";

    // Number the cues. The model returns each translation with its entry number, so a merged,
    // split or dropped entry is detected by number and never shifts the lines after it.
    const texts = cues.map((t) => String(t));
    const numbered = texts.map((t, i) => `[${i + 1}] ${t.replace(/\n/g, " ⏎ ")}`).join("\n");

    const system =
      "You are a professional subtitle translator. You translate spoken-dialogue captions " +
      "for video. Translate naturally for the spoken register of the target language, not word-for-word. " +
      "Keep each translation concise enough to read on screen in the same time. Preserve the line-break " +
      "marker ⏎ where it appears (it separates the two on-screen lines). Do not add notes or commentary. " +
      "The entries are consecutive captions cut from continuous speech, so one sentence often runs " +
      "across several entries. Each entry is shown on screen at its own time, so every entry needs its " +
      "own translation: never merge two entries into one, never split one entry into two, and never " +
      "leave an entry out or empty, even when the sentence continues in the next entry. When the target " +
      "language needs a different word order, keep each entry's share of the sentence in that entry. " +
      "Return one item per entry, in order, with n set to the entry number and text set to its translation.";

    const userMsg =
      `Translate these ${texts.length} subtitle entries from ${srcLabel} into ${target}. ` +
      `Return JSON only, with exactly ${texts.length} items numbered 1 to ${texts.length}.\n\n${numbered}`;

    const body = {
      model,
      max_tokens: 16000,
      thinking: { type: "disabled" }, // translation is a transform, not a reasoning task
      system,
      messages: [{ role: "user", content: userMsg }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              translations: {
                type: "array",
                items: {
                  type: "object",
                  properties: { n: { type: "integer" }, text: { type: "string" } },
                  required: ["n", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["translations"],
            additionalProperties: false,
          },
        },
      },
    };

    // No Anthropic call runs past the deadline, so the Worker stops working on a request
    // around the time the page gives up on it.
    const upstreamTimeoutMs = positiveInt(env.UPSTREAM_TIMEOUT_MS, 30000);
    const deadline = Date.now() + positiveInt(env.DEADLINE_MS, 40000);

    // One Anthropic call. Returns { ok, status, data }, or null for a network error or a timeout.
    const callAnthropic = async () => {
      // Give up on a call that hangs. The timer also covers reading the body, which can
      // stall after the headers arrive.
      const ctrl = new AbortController();
      const wait = Math.max(1, Math.min(upstreamTimeoutMs, deadline - Date.now()));
      const timer = setTimeout(() => ctrl.abort(), wait);
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        let data = null;
        if (resp.ok) {
          try {
            data = await resp.json();
          } catch {
            if (ctrl.signal.aborted) return null;
          }
        }
        return { ok: resp.ok, status: resp.status, data };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // Retry transient upstream failures (network error, timeout, 429, 5xx) up to 3 times
    // so a momentary Anthropic blip doesn't fail the whole translation.
    let resp = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      resp = await callAnthropic();
      if (resp && resp.ok) break;
      const retryable = !resp || resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt === 3) break;
      // Skip the pause and the next call when the pause itself would reach the deadline.
      const pause = 500 * attempt;
      if (Date.now() + pause >= deadline) break;
      await new Promise((r) => setTimeout(r, pause));
    }
    if (!resp) return json({ error: "Upstream request failed" }, 502, cors);
    if (!resp.ok) {
      if (resp.status === 429) return json({ error: "Rate limited upstream" }, 429, cors);
      return json({ error: "Translation provider error", status: resp.status }, 502, cors);
    }

    const data = resp.data;
    if (!data) return json({ error: "Could not parse translation" }, 502, cors);
    if (data.stop_reason === "refusal") {
      return json({ error: "Content was declined by the translator." }, 422, cors);
    }

    // output_config.format guarantees the first text block is valid JSON for the schema.
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let items;
    try {
      items = JSON.parse(textBlock.text).translations;
    } catch {
      return json({ error: "Could not parse translation" }, 502, cors);
    }

    // The pages match on this exact error string, then split the batch and send the parts
    // again, so keep it stable.
    const translations = alignByNumber(items, texts);
    if (!translations) return json({ error: "Translation count mismatch" }, 502, cors);

    // Restore the line-break marker the model was asked to preserve.
    return json({ translations: translations.map((t) => t.replace(/\s*⏎\s*/g, "\n")) }, 200, cors);
  },
};

// Place each returned item on its entry number. Returns null unless every entry from 1 to
// texts.length arrives exactly once, with text for every cue that had text. An empty text is
// rejected because a model that merges two entries tends to leave the second one empty.
function alignByNumber(items, texts) {
  if (!Array.isArray(items) || items.length !== texts.length) return null;
  const out = new Array(texts.length).fill(null);
  for (const item of items) {
    const n = item && item.n;
    if (!Number.isInteger(n) || n < 1 || n > texts.length || out[n - 1] !== null) return null;
    if (typeof item.text !== "string") return null;
    if (!item.text.trim() && texts[n - 1].trim()) return null;
    out[n - 1] = item.text;
  }
  return out;
}

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
