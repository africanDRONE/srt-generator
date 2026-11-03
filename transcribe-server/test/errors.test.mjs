// Error responses must not leak command lines, stderr, temp paths or the egress
// proxy port. Runs the real server with stub yt-dlp / ffprobe / ffmpeg / Whisper
// on PATH and localhost, so nothing touches the network. Needs express installed
// (npm install).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const SECRET = "LEAKME-/tmp/subcap-abc --proxy http://127.0.0.1:54321";

let stubs, srv, base, whisperSrv, logs = "";

// yt-dlp: fails with noisy stderr for "fail" URLs, otherwise writes in.m4a.
// ffprobe prints nothing (unknown duration). ffmpeg writes one chunk file.
const STUBS = {
  "yt-dlp": `#!/bin/sh
for a in "$@"; do last="$a"; done
case "$last" in *fail*) echo "ERROR: ${SECRET}" >&2; exit 1;; esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && : > "$(echo "$out" | sed 's/%(ext)s/m4a/')"
exit 0
`,
  ffprobe: "#!/bin/sh\nexit 1\n",
  ffmpeg: `#!/bin/sh
for a in "$@"; do last="$a"; done
: > "$(echo "$last" | sed 's/%03d/000/')"
exit 0
`,
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  stubs = await fs.mkdtemp(path.join(os.tmpdir(), "subcap-stubs-"));
  for (const [name, body] of Object.entries(STUBS)) await fs.writeFile(path.join(stubs, name), body, { mode: 0o755 });

  // Whisper stand-in that fails with a body echoing a key, like a real 401 does.
  whisperSrv = http.createServer((req, res) => { req.resume(); res.writeHead(401).end(`Incorrect API key provided: ${SECRET}`); });
  await new Promise((r) => whisperSrv.listen(0, "127.0.0.1", r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, [SERVER], {
    env: {
      PATH: `${stubs}:/usr/bin:/bin`, HOME: os.homedir(), PORT: String(port),
      DEV_ALLOW_ALL: "true", OPENAI_API_KEY: "test-key", WHISPER_BASE: `http://127.0.0.1:${whisperSrv.address().port}/v1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stderr.on("data", (d) => { logs += d; });
  await new Promise((resolve, reject) => {
    srv.on("exit", (c) => reject(new Error(`server exited ${c}: ${logs}`)));
    srv.stdout.on("data", (d) => { logs += d; if (String(d).includes("listening")) resolve(); });
  });
});

after(async () => {
  srv?.kill();
  whisperSrv?.close();
  if (stubs) await fs.rm(stubs, { recursive: true, force: true });
});

const post = async (route, body, raw) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const assertClean = (text) => {
  for (const bad of ["LEAKME", "/tmp", "127.0.0.1", "yt-dlp", "proxy", "ERROR", "Incorrect API key"]) {
    assert.ok(!text.includes(bad), `response leaks "${bad}": ${text}`);
  }
  assert.doesNotMatch(text, /\n\s+at /, "response contains a stack trace");
};
// A public IP literal skips DNS; the stubs never really fetch it.
const SRC = "https://93.184.216.34/fail.mp4";

test("download failures return a short message, detail only in the log", async () => {
  for (const [route, body] of [["/transcribe", { url: SRC }], ["/peaks", { url: SRC }], ["/burn", { url: SRC, srt: "1\n00:00:00,000 --> 00:00:01,000\nhi\n" }]]) {
    const r = await post(route, body);
    assert.equal(r.status, 502, route);
    assert.equal(JSON.parse(r.text).error, "We couldn't read that video. Check the link plays in your browser and try again.");
    assertClean(r.text);
  }
  assert.ok(logs.includes("LEAKME"), "the detail should still be logged");
});

test("upstream Whisper error body is not passed to the browser", async () => {
  const r = await post("/transcribe", { url: "https://93.184.216.34/ok.mp4" });
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.text).error, "The transcription service didn't respond. Please try again in a moment.");
  assertClean(r.text);
});

test("malformed JSON gets a JSON 400 without a stack trace", async () => {
  const r = await post("/transcribe", null, "{not json");
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.text), { error: "Bad request" });
  assertClean(r.text);
});

test("user-meaningful errors are unchanged", async () => {
  const blocked = await post("/peaks", { url: "http://169.254.169.254/latest/meta-data/" });
  assert.deepEqual([blocked.status, JSON.parse(blocked.text).error], [400, "That link points to a private or internal address"]);
  const height = await post("/burn", { url: SRC, srt: "1\n", maxHeight: 4320 });
  assert.equal(height.status, 400);
  assert.match(JSON.parse(height.text).error, /maxHeight must be one of/);
});
