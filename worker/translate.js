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

    // Number the cues so the model returns one translation per entry, in order.
    const numbered = cues.map((t, i) => `[${i + 1}] ${String(t).replace(/\n/g, " ⏎ ")}`).join("\n");

    const system =
      "You are a professional subtitle translator. You translate spoken-dialogue captions " +
      "for video. Translate naturally for the spoken register of the target language, not word-for-word. " +
      "Keep each translation concise enough to read on screen in the same time. Preserve the line-break " +
      "marker ⏎ where it appears (it separates the two on-screen lines). Do not add notes, numbering, or " +
      "commentary. Return exactly one translation per input entry, in the same order.";

    const userMsg =
      `Translate these ${cues.length} subtitle entries from ${srcLabel} into ${target}. ` +
      `Return JSON only.\n\n${numbered}`;

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
              translations: { type: "array", items: { type: "string" } },
            },
            required: ["translations"],
            additionalProperties: false,
          },
        },
      },
    };

    // Retry transient upstream failures (network error, 429, 5xx) up to 3 times
    // so a momentary Anthropic blip doesn't fail the whole translation.
    const callAnthropic = async () => {
      try {
        return await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        return null;
      }
    };
    let resp = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      resp = await callAnthropic();
      if (resp && resp.ok) break;
      const retryable = !resp || resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    if (!resp) return json({ error: "Upstream request failed" }, 502, cors);
    if (!resp.ok) {
      if (resp.status === 429) return json({ error: "Rate limited upstream" }, 429, cors);
      return json({ error: "Translation provider error", status: resp.status }, 502, cors);
    }

    const data = await resp.json();
    if (data.stop_reason === "refusal") {
      return json({ error: "Content was declined by the translator." }, 422, cors);
    }

    // output_config.format guarantees the first text block is valid JSON for the schema.
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let translations;
    try {
      translations = JSON.parse(textBlock.text).translations;
    } catch {
      return json({ error: "Could not parse translation" }, 502, cors);
    }

    // Restore the line-break marker the model was asked to preserve.
    translations = translations.map((t) => String(t).replace(/\s*⏎\s*/g, "\n"));

    if (translations.length !== cues.length) {
      return json({ error: "Translation count mismatch" }, 502, cors);
    }

    return json({ translations }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
