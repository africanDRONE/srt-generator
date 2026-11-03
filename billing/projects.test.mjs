import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import {
  makeProjects, jsonBodyParser, isProjectSave, MSG, MAX_CUES, MAX_TITLE, SHARE_TTL_MS,
  FREE_STORAGE_BYTES, PAID_STORAGE_BYTES, MAX_TRANSLATIONS, MAX_LINE_CHARS, MAX_SOURCE_URL,
} from "./projects.mjs";

// ---------------------------------------------------------------------------
// Fake Supabase: in-memory projects and share_links tables. Supports only the
// supabase-js chains projects.mjs uses. Builders are thenables like the real
// PostgrestBuilder, and return only the selected columns.
// ---------------------------------------------------------------------------

function makeSupabase({ projects = [], share_links = [] } = {}) {
  const tables = { projects: structuredClone(projects), share_links: structuredClone(share_links) };
  const failOn = new Set(); // "select:projects", "update:projects", "insert:share_links", ...
  const ops = [];
  let nextId = 1;
  const boom = { data: null, count: null, error: { message: 'relation "secret_internal" does not exist', code: "42P01" } };

  const pick = (row, cols) => Object.fromEntries(cols.split(",").map((c) => c.trim()).map((k) => [k, row[k]]));
  const defaults = {
    projects: () => ({ id: `p${nextId++}`, created_at: "2020-01-01T00:00:00.000Z" }),
    share_links: () => ({ created_at: new Date(1_000_000 + nextId++).toISOString(), can_edit: true, label: null, expires_at: null }),
  };

  function from(table) {
    assert.ok(table in tables, `unexpected table ${table}`);
    const rows = tables[table];

    function builder(op, payload, opts = {}) {
      const filters = [];
      const state = { cols: op === "select" ? payload : null, order: null, limit: null, single: false };
      const matches = (r) => filters.every(([c, v]) => r[c] === v);
      async function run() {
        ops.push({ table, op, filters: [...filters] });
        if (failOn.has(`${op}:${table}`)) return boom;
        if (op === "select") {
          let hit = rows.filter(matches);
          if (opts.head) return { data: null, count: opts.count ? hit.length : null, error: null };
          if (state.order) {
            const [col, asc] = state.order;
            hit = [...hit].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (state.limit !== null) hit = hit.slice(0, state.limit);
          const out = hit.map((r) => pick(r, state.cols));
          if (state.single) {
            if (out.length > 1) return { data: null, error: { message: "multiple rows" } };
            return { data: out[0] || null, error: null };
          }
          return { data: out, error: null };
        }
        if (op === "update" || op === "delete") {
          if (!filters.length) throw new Error(`fake: ${op} without a filter would hit every row`);
          const hit = rows.filter(matches);
          if (op === "update") for (const r of hit) Object.assign(r, structuredClone(payload));
          else {
            tables[table] = rows.filter((r) => !matches(r));
            // on delete cascade
            if (table === "projects") tables.share_links = tables.share_links.filter((l) => !hit.some((p) => p.id === l.project_id));
          }
          return { data: state.cols ? hit.map((r) => pick(r, state.cols)) : null, error: null };
        }
        if (op === "insert") {
          if (table === "share_links" && rows.some((r) => r.token === payload.token)) return { data: null, error: { message: "duplicate key", code: "23505" } };
          rows.push({ ...defaults[table](), ...structuredClone(payload) });
          return { data: null, error: null };
        }
        if (op === "upsert") {
          assert.equal(opts.onConflict, "owner,source_key");
          let row = rows.find((r) => r.owner === payload.owner && r.source_key === payload.source_key);
          if (row) Object.assign(row, structuredClone(payload));
          else rows.push((row = { ...defaults[table](), ...structuredClone(payload) }));
          return { data: state.cols ? [pick(row, state.cols)] : null, error: null };
        }
        throw new Error(`fake: unsupported op ${op}`);
      }
      const b = {
        eq(col, val) { filters.push([col, val]); return b; },
        order(col, { ascending = true } = {}) { state.order = [col, ascending]; return b; },
        limit(n) { state.limit = n; return b; },
        maybeSingle() { state.single = true; return b; },
        select(cols) { state.cols = cols; return b; },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      return b;
    }

    return {
      select: (cols, opts) => builder("select", cols, opts),
      update: (fields) => builder("update", fields),
      delete: () => builder("delete"),
      insert: (row) => builder("insert", row),
      upsert: (row, opts) => builder("upsert", row, opts),
    };
  }

  return {
    client: { from },
    failOn,
    ops,
    writes: () => ops.filter((o) => o.op !== "select"),
    rows: (table) => tables[table],
    project: (owner, key) => tables.projects.find((p) => p.owner === owner && p.source_key === key),
    link: (token) => tables.share_links.find((l) => l.token === token),
    snapshot: () => structuredClone(tables),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const cues = (n) => Array.from({ length: n }, (_, i) => ({ s: i, e: i + 1, x: `line ${i}` }));
const projectRow = (id, owner, source_key, extra = {}) => ({
  id, owner, source_key, source_url: `https://youtu.be/${source_key}`, title: source_key, thumb: null,
  caption_count: 2, data: { c: cues(2), t: {} }, updated_at: T0, created_at: T0, ...extra,
});
const link = (token, project_id, extra = {}) => ({ token, project_id, can_edit: true, label: null, created_at: T0, expires_at: null, ...extra });

function setup({ projects = [], share_links = [], maxProjects, tiers = {}, freeStorage, paidStorage, tierForUser } = {}) {
  const db = makeSupabase({ projects, share_links });
  const clock = { t: NOW };
  const logged = [];
  const log = { log() {}, warn() {}, error: (...args) => logged.push(args) };
  const api = makeProjects({
    supabase: db.client, clock: () => clock.t, log, maxProjects, freeStorage, paidStorage,
    tierForUser: tierForUser || (async (owner) => tiers[owner] || "free"),
  });
  return { db, api, clock, logged };
}

const save = (key, data = { c: cues(3), t: {} }, extra = {}) => ({ source_key: key, source_url: `https://youtu.be/${key}`, title: key, data, ...extra });

// ---------------------------------------------------------------------------
// 1. Body size
// ---------------------------------------------------------------------------

test("1a. only POST /projects and PUT /share/:token get the large body limit", () => {
  for (const [m, p] of [["POST", "/projects"], ["POST", "/projects/"], ["POST", "/PROJECTS"], ["PUT", "/share/abc"], ["PUT", "/share/abc/"]]) {
    assert.equal(isProjectSave(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/projects"], ["POST", "/projects/k/share"], ["PUT", "/projects"], ["GET", "/share/abc"],
    ["POST", "/share/abc"], ["PUT", "/share/a/b"], ["POST", "/billing/checkout"], ["POST", "/billing/webhook"], ["POST", "/projectsx"]]) {
    assert.equal(isProjectSave(m, p), false, `${m} ${p}`);
  }
});

test("1b. a 150 KB project save is accepted, other routes keep the 100 KB limit, 2 MB is the ceiling", async (t) => {
  const app = express();
  app.use(jsonBodyParser());
  app.use((req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = (kb) => JSON.stringify({ source_key: "k", data: { c: [], pad: "x".repeat(kb * 1024) } });
  const post = (method, path, b) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: b }).then((r) => r.status);

  assert.equal(await post("POST", "/projects", body(150)), 200, "150 KB owner save");
  assert.equal(await post("PUT", "/share/tok", body(210)), 200, "210 KB translator save");
  assert.equal(await post("POST", "/projects", body(1900)), 200, "1.9 MB owner save");
  assert.equal(await post("POST", "/projects", body(2100)), 413, "over 2 MB");
  assert.equal(await post("POST", "/billing/checkout", body(150)), 413, "other routes keep 100 KB");
  assert.equal(await post("POST", "/projects/k/share", body(150)), 413, "share mint keeps 100 KB");
  assert.equal(await post("POST", "/billing/checkout", body(50)), 200, "small bodies still parse");
});

// ---------------------------------------------------------------------------
// 2. Validation
// ---------------------------------------------------------------------------

test("2a. missing source_key or data keeps the old 400", async () => {
  const { api, db } = setup();
  assert.deepEqual(await api.save("u1", { data: { c: [] } }), { status: 400, body: { error: "source_key and data required" } });
  assert.deepEqual(await api.save("u1", { source_key: "k" }), { status: 400, body: { error: "source_key and data required" } });
  assert.deepEqual(await api.save("u1", undefined), { status: 400, body: { error: "source_key and data required" } });
  assert.equal(db.writes().length, 0);
});

test("2b. data must be an object whose c is an array", async () => {
  const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const before = db.snapshot();
  for (const data of ["text", [1, 2], { t: {} }, { c: "nope" }, { c: { 0: "x" } }]) {
    const r = await api.save("u1", save("yt_a", data));
    assert.equal(r.status, 400, JSON.stringify(data));
    assert.match(r.body.error, /data/);
    const s = await api.saveShare("tok", { data });
    assert.equal(s.status, 400, JSON.stringify(data));
  }
  assert.deepEqual(await api.saveShare("tok", {}), { status: 400, body: { error: "data required" } });
  assert.deepEqual(db.snapshot(), before, "nothing written");
});

test("2c. at most 20,000 cues", async () => {
  const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const over = await api.save("u1", save("yt_new", { c: cues(MAX_CUES + 1) }));
  assert.equal(over.status, 400);
  assert.match(over.body.error, /20,000 captions/);
  assert.equal((await api.saveShare("tok", { data: { c: cues(MAX_CUES + 1) } })).status, 400);
  assert.equal(db.project("u1", "yt_new"), undefined);
  assert.equal(db.project("u1", "yt_a").caption_count, 2);

  assert.equal((await api.save("u1", save("yt_new", { c: cues(MAX_CUES) }))).status, 200);
  assert.equal(db.project("u1", "yt_new").caption_count, MAX_CUES);
});

test("2d. source_key over 300 characters is refused; a long title is cut to 300", async () => {
  const { api, db } = setup();
  const r = await api.save("u1", save("k".repeat(301)));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /source_key/);
  assert.equal((await api.save("u1", { ...save("k".repeat(300)) })).status, 200);
  assert.equal(db.rows("projects").length, 1);

  // Today's client sends the source URL as the title; a long signed URL must still save.
  const longUrl = "https://cdn.example.com/video.mp4?" + "sig=abc&".repeat(80);
  assert.equal((await api.save("u1", save("h5_x", { c: [] }, { title: longUrl, source_url: longUrl }))).status, 200);
  assert.equal(db.project("u1", "h5_x").title.length, MAX_TITLE);
  assert.equal(db.project("u1", "h5_x").source_url, longUrl);
});

test("2e. a malformed base_updated_at is a 400", async () => {
  const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  for (const bad of ["yesterday", 12345, { at: T0 }]) {
    assert.equal((await api.save("u1", save("yt_a", undefined, { base_updated_at: bad }))).status, 400);
    assert.equal((await api.saveShare("tok", { data: { c: [] }, base_updated_at: bad })).status, 400);
  }
  assert.equal(db.writes().length, 0);
});

test("2f. a valid save stores the same columns as before", async () => {
  const { api, db, clock } = setup();
  const data = { c: cues(4), t: { fr: {} }, th: "data:image/jpeg;base64,AAAA", ts: 1, uid: "u1" };
  const r = await api.save("u1", save("yt_a", data));
  assert.deepEqual(r, { status: 200, body: { ok: true, updated_at: new Date(clock.t).toISOString() } });
  const row = db.project("u1", "yt_a");
  assert.equal(row.caption_count, 4);
  assert.equal(row.thumb, data.th);
  assert.equal(row.title, "yt_a");
  assert.equal(row.source_url, "https://youtu.be/yt_a");
  assert.deepEqual(row.data, data);
});

// ---------------------------------------------------------------------------
// 3. Per-user quota
// ---------------------------------------------------------------------------

test("3a. a new project past the cap gets 403 and is not written", async () => {
  const { api, db } = setup({ maxProjects: 3 });
  for (const k of ["a", "b", "c"]) assert.equal((await api.save("u1", save(k))).status, 200);
  const r = await api.save("u1", save("d"));
  assert.deepEqual(r, { status: 403, body: { error: "You have reached the limit of 3 saved projects. Delete some old ones to save new ones." } });
  assert.equal(db.project("u1", "d"), undefined);
  assert.equal(db.rows("projects").length, 3);
});

test("3b. updating an existing project past the cap still succeeds", async () => {
  // Four projects already (saved before the cap existed), cap of 3.
  const { api, db, clock } = setup({ maxProjects: 3, projects: ["a", "b", "c", "d"].map((k, i) => projectRow(`p${i}`, "u1", k)) });
  clock.t += 1000;
  const r = await api.save("u1", save("b", { c: cues(9) }));
  assert.equal(r.status, 200);
  assert.equal(db.project("u1", "b").caption_count, 9);
  assert.equal(db.project("u1", "b").updated_at, new Date(clock.t).toISOString());
  assert.equal((await api.save("u1", save("e"))).status, 403);
});

test("3c. the default cap is 500, and only the caller's own projects count", async () => {
  assert.equal(MSG.quota(500), "You have reached the limit of 500 saved projects. Delete some old ones to save new ones.");
  const { api, db } = setup({ maxProjects: 2, projects: [projectRow("p1", "u2", "a"), projectRow("p2", "u2", "b"), projectRow("p3", "u2", "c")] });
  assert.equal((await api.save("u1", save("a"))).status, 200);
  assert.equal((await api.save("u1", save("b"))).status, 200);
  assert.equal((await api.save("u1", save("c"))).status, 403);
  assert.equal(db.rows("projects").filter((p) => p.owner === "u2").length, 3);
});

test("3d. deleting a project frees a slot", async () => {
  const { api } = setup({ maxProjects: 1 });
  assert.equal((await api.save("u1", save("a"))).status, 200);
  assert.equal((await api.save("u1", save("b"))).status, 403);
  assert.deepEqual(await api.remove("u1", "a"), { status: 200, body: { ok: true } });
  assert.equal((await api.save("u1", save("b"))).status, 200);
});

// ---------------------------------------------------------------------------
// 4. Share links: expiry, list, revoke
// ---------------------------------------------------------------------------

test("4a. minting is Team only, needs a saved project, and sets a 30-day expiry", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], tiers: { u1: "team", u2: "solo" } });
  assert.deepEqual(await api.mintShare("u2", "yt_a", {}), { status: 403, body: { error: MSG.teamOnly } });
  assert.deepEqual(await api.mintShare("u1", "missing", {}), { status: 404, body: { error: "Save the project before sharing it." } });
  assert.equal(db.rows("share_links").length, 0);

  const r = await api.mintShare("u1", "yt_a", { canEdit: true, label: "Ana (French)" });
  assert.equal(r.status, 200);
  assert.match(r.body.token, /^[0-9a-f]{36}$/);
  assert.equal(r.body.expires_at, new Date(clock.t + SHARE_TTL_MS).toISOString());
  assert.equal(SHARE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(db.link(r.body.token), { ...db.link(r.body.token), project_id: "p1", can_edit: true, label: "Ana (French)", expires_at: r.body.expires_at });

  const viewOnly = await api.mintShare("u1", "yt_a", { canEdit: false });
  assert.equal(db.link(viewOnly.body.token).can_edit, false);
  assert.notEqual(viewOnly.body.token, r.body.token);
});

test("4b. a link works until it expires, then GET and PUT get 410 and nothing is written", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], tiers: { u1: "team" } });
  const { body: { token } } = await api.mintShare("u1", "yt_a", {});
  clock.t += SHARE_TTL_MS - 1;
  assert.equal((await api.openShare(token)).status, 200);
  assert.equal((await api.saveShare(token, { data: { c: cues(5) } })).status, 200);

  clock.t += 1;
  const before = db.snapshot();
  assert.deepEqual(await api.openShare(token), { status: 410, body: { error: "This share link has expired." } });
  assert.deepEqual(await api.saveShare(token, { data: { c: cues(7) } }), { status: 410, body: { error: "Link expired" } });
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.project("u1", "yt_a").caption_count, 5);
});

test("4c. links minted before expiry existed (expires_at null) keep working", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("old", "p1")] });
  clock.t += 10 * 365 * 24 * 60 * 60 * 1000;
  const r = await api.openShare("old");
  assert.equal(r.status, 200);
  assert.equal(r.body.canEdit, true);
  assert.equal(r.body.expires_at, null);
  assert.equal((await api.saveShare("old", { data: { c: cues(4), t: {} } })).status, 200);
  assert.equal(db.project("u1", "yt_a").caption_count, 4);
});

test("4d. view-only and unknown links keep their old answers", async () => {
  const { api } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("ro", "p1", { can_edit: false })] });
  assert.deepEqual(await api.saveShare("ro", { data: { c: [] } }), { status: 403, body: { error: "This link is view-only" } });
  assert.equal((await api.openShare("ro")).body.canEdit, false);
  assert.deepEqual(await api.openShare("nope"), { status: 404, body: { error: "This share link is invalid or was revoked." } });
  assert.deepEqual(await api.saveShare("nope", { data: { c: [] } }), { status: 404, body: { error: "Invalid share link" } });
});

test("4e. the owner lists a project's links; another user with the same source_key sees only their own", async () => {
  const { api, clock } = setup({
    projects: [projectRow("p1", "u1", "yt_a"), projectRow("p2", "u2", "yt_a")],
    share_links: [link("old", "p1"), link("theirs", "p2")],
    tiers: { u1: "team" },
  });
  clock.t += 1000;
  const { body: minted } = await api.mintShare("u1", "yt_a", { label: "Ana" });
  const r = await api.listShares("u1", "yt_a");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.shares.map((s) => s.token).sort(), ["old", minted.token].sort());
  const fresh = r.body.shares.find((s) => s.token === minted.token);
  assert.deepEqual(
    { label: fresh.label, can_edit: fresh.can_edit, expires_at: fresh.expires_at, expired: fresh.expired },
    { label: "Ana", can_edit: true, expires_at: minted.expires_at, expired: false },
  );
  assert.equal(r.body.shares.find((s) => s.token === "old").expires_at, null);

  assert.deepEqual((await api.listShares("u2", "yt_a")).body.shares.map((s) => s.token), ["theirs"]);
  assert.deepEqual(await api.listShares("u3", "yt_a"), { status: 404, body: { error: "Not found" } });

  clock.t += SHARE_TTL_MS;
  assert.equal((await api.listShares("u1", "yt_a")).body.shares.find((s) => s.token === minted.token).expired, true);
});

test("4f. the owner revokes a link and it stops working", async () => {
  const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1"), link("keep", "p1")] });
  assert.deepEqual(await api.revokeShare("u1", "yt_a", "tok"), { status: 200, body: { ok: true } });
  assert.equal(db.link("tok"), undefined);
  assert.equal((await api.openShare("tok")).status, 404);
  assert.equal((await api.saveShare("tok", { data: { c: [] } })).status, 404);
  assert.equal((await api.openShare("keep")).status, 200, "other links on the project are untouched");
  assert.deepEqual(await api.revokeShare("u1", "yt_a", "tok"), { status: 404, body: { error: "Share link not found." } });
});

test("4g. revoke by a non-owner is a 404 and deletes nothing", async () => {
  // u2 has a project with the same source_key (same YouTube video), so the owner
  // lookup succeeds for u2 but must not reach u1's link.
  const { api, db } = setup({
    projects: [projectRow("p1", "u1", "yt_a"), projectRow("p2", "u2", "yt_a")],
    share_links: [link("tok", "p1")],
  });
  const before = db.snapshot();
  assert.deepEqual(await api.revokeShare("u2", "yt_a", "tok"), { status: 404, body: { error: "Share link not found." } });
  assert.deepEqual(await api.revokeShare("u3", "yt_a", "tok"), { status: 404, body: { error: "Share link not found." } });
  assert.deepEqual(await api.revokeShare("u1", "yt_b", "tok"), { status: 404, body: { error: "Share link not found." } }, "right owner, wrong project");
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await api.openShare("tok")).status, 200);
});

// ---------------------------------------------------------------------------
// 5. Optimistic concurrency (opt-in base_updated_at)
// ---------------------------------------------------------------------------

test("5a. GET /projects/:key and GET /share/:token return updated_at", async () => {
  const { api } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const g = await api.get("u1", "yt_a");
  assert.deepEqual(g, { status: 200, body: { data: { c: cues(2), t: {} }, updated_at: T0 } });
  assert.equal((await api.openShare("tok")).body.updated_at, T0);
  assert.deepEqual(await api.get("u2", "yt_a"), { status: 404, body: { error: "Not found" } });
});

test("5b. a matching base saves and returns the new updated_at; a stale base gets 409 and writes nothing", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")] });
  clock.t += 5000;
  const ok = await api.save("u1", save("yt_a", { c: cues(5) }, { base_updated_at: T0 }));
  assert.equal(ok.status, 200);
  const v2 = new Date(clock.t).toISOString();
  assert.deepEqual(ok.body, { ok: true, updated_at: v2 });

  clock.t += 5000;
  const before = db.snapshot();
  const stale = await api.save("u1", save("yt_a", { c: cues(1) }, { base_updated_at: T0 }));
  assert.deepEqual(stale, { status: 409, body: { error: MSG.conflict, updated_at: v2 } });
  assert.deepEqual(db.snapshot(), before, "nothing written");
  assert.equal(db.project("u1", "yt_a").caption_count, 5);

  // The check is in the UPDATE itself (filtered on updated_at), not a separate read.
  const update = db.ops.filter((o) => o.op === "update").at(-1);
  assert.deepEqual(update.filters, [["owner", "u1"], ["source_key", "yt_a"], ["updated_at", T0]]);
});

test("5c. without base_updated_at the save overwrites, as before", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  clock.t += 1000;
  assert.equal((await api.saveShare("tok", { data: { c: cues(6) } })).status, 200);
  clock.t += 1000;
  const r = await api.save("u1", save("yt_a", { c: cues(3) }));
  assert.deepEqual(r, { status: 200, body: { ok: true, updated_at: new Date(clock.t).toISOString() } });
  assert.equal(db.project("u1", "yt_a").caption_count, 3, "last write wins when no base is sent");
  // null counts as absent.
  clock.t += 1000;
  assert.equal((await api.save("u1", save("yt_a", { c: cues(8) }, { base_updated_at: null }))).status, 200);
  assert.equal((await api.saveShare("tok", { data: { c: cues(9) }, base_updated_at: null })).status, 200);
  assert.equal(db.project("u1", "yt_a").caption_count, 9);
});

test("5d. translator saves with a stale base get 409 and write nothing", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const opened = await api.openShare("tok");
  // The owner saves (old client, no base) while the translator has the project open.
  clock.t += 1000;
  const owner = await api.save("u1", save("yt_a", { c: cues(4) }));
  clock.t += 1000;
  const before = db.snapshot();
  const r = await api.saveShare("tok", { data: { c: cues(1) }, base_updated_at: opened.body.updated_at });
  assert.deepEqual(r, { status: 409, body: { error: MSG.conflict, updated_at: owner.body.updated_at } });
  assert.deepEqual(db.snapshot(), before);

  const ok = await api.saveShare("tok", { data: { c: cues(2) }, base_updated_at: owner.body.updated_at });
  assert.deepEqual(ok, { status: 200, body: { ok: true, updated_at: new Date(clock.t).toISOString() } });
  assert.equal(db.project("u1", "yt_a").caption_count, 2);
});

test("5e. the owner's stale base loses to a translator save", async () => {
  const { api, db, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const mine = await api.get("u1", "yt_a");
  clock.t += 1000;
  const theirs = await api.saveShare("tok", { data: { c: cues(6) }, base_updated_at: mine.body.updated_at });
  assert.equal(theirs.status, 200);
  clock.t += 1000;
  const r = await api.save("u1", save("yt_a", { c: cues(1) }, { base_updated_at: mine.body.updated_at }));
  assert.deepEqual(r, { status: 409, body: { error: MSG.conflict, updated_at: theirs.body.updated_at } });
  assert.equal(db.project("u1", "yt_a").caption_count, 6);
});

test("5f. a base for a project that no longer exists is a 409 with updated_at null, and nothing is created", async () => {
  const { api, db } = setup();
  const r = await api.save("u1", save("yt_gone", undefined, { base_updated_at: T0 }));
  assert.deepEqual(r, { status: 409, body: { error: MSG.conflict, updated_at: null } });
  assert.equal(db.rows("projects").length, 0);
});

test("5g. two saves in the same millisecond still move updated_at forward", async () => {
  const { api, clock } = setup({ projects: [projectRow("p1", "u1", "yt_a", { updated_at: new Date(NOW).toISOString() })] });
  const r = await api.save("u1", save("yt_a", undefined, { base_updated_at: new Date(clock.t).toISOString() }));
  assert.equal(r.status, 200);
  assert.ok(Date.parse(r.body.updated_at) > NOW);
  // A Postgres value with microseconds is accepted as a base.
  const micro = "2026-11-03T12:00:00.000999+00:00";
  const { api: api2 } = setup({ projects: [projectRow("p1", "u1", "yt_a", { updated_at: micro })] });
  const r2 = await api2.save("u1", save("yt_a", undefined, { base_updated_at: micro }));
  assert.equal(r2.status, 200);
  assert.ok(Date.parse(r2.body.updated_at) > Date.parse(micro));
});

test("5h. without a base, a translator save to a deleted project is a 404, not a silent ok", async () => {
  const { api, db } = setup({ share_links: [link("orphan", "p_missing")] });
  assert.deepEqual(await api.saveShare("orphan", { data: { c: [] } }), { status: 404, body: { error: "The shared project no longer exists." } });
  assert.deepEqual(await api.openShare("orphan"), { status: 404, body: { error: "The shared project no longer exists." } });
  assert.equal(db.rows("projects").length, 0);
});

// ---------------------------------------------------------------------------
// 6. Database errors are logged, never sent to the browser
// ---------------------------------------------------------------------------

test("6. database errors give a generic 503 and the details go to the log", async () => {
  const calls = [
    ["select:projects", (api) => api.list("u1")],
    ["select:projects", (api) => api.get("u1", "yt_a")],
    ["update:projects", (api) => api.save("u1", save("yt_a"))],
    ["select:projects", (api) => api.save("u1", save("yt_new"))],
    ["upsert:projects", (api) => api.save("u1", save("yt_new"))],
    ["select:projects", (api) => api.save("u1", save("yt_a", undefined, { base_updated_at: "2020-01-01T00:00:00Z" }))],
    ["delete:projects", (api) => api.remove("u1", "yt_a")],
    ["insert:share_links", (api) => api.mintShare("u1", "yt_a", {})],
    ["select:share_links", (api) => api.listShares("u1", "yt_a")],
    ["delete:share_links", (api) => api.revokeShare("u1", "yt_a", "tok")],
    ["select:share_links", (api) => api.openShare("tok")],
    ["select:share_links", (api) => api.saveShare("tok", { data: { c: [] } })],
    ["update:projects", (api) => api.saveShare("tok", { data: { c: [] } })],
  ];
  for (const [fail, call] of calls) {
    const { api, db, logged } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")], tiers: { u1: "team" } });
    db.failOn.add(fail);
    const r = await call(api);
    assert.deepEqual(r, { status: 503, body: { error: MSG.generic } }, `${fail} ${call}`);
    assert.doesNotMatch(JSON.stringify(r.body), /secret_internal|relation/);
    assert.equal(logged.length, 1, `${fail} logged once`);
    assert.match(String(logged[0][1]?.message), /secret_internal/, "details are in the log");
    assert.doesNotMatch(logged[0].map(String).join(" "), /\btok\b/, "the share token is not logged");
  }
});

test("6b. a failed tier lookup is a 503, not a misleading upgrade prompt", async () => {
  const db = makeSupabase({ projects: [projectRow("p1", "u1", "yt_a")] });
  const logged = [];
  const api = makeProjects({
    supabase: db.client, log: { error: (...a) => logged.push(a) },
    tierForUser: async () => { throw new Error("profiles read failed: boom"); },
  });
  assert.deepEqual(await api.mintShare("u1", "yt_a", {}), { status: 503, body: { error: MSG.generic } });
  assert.equal(db.rows("share_links").length, 0);
  assert.equal(logged.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Translations and thumbnail: the page renders both, and an edit link can save both
// ---------------------------------------------------------------------------

// The languages the editor offers ([name, code, flag]), read from index.html so a new
// language the server would refuse fails here. Falls back to a few if the page is not there.
function clientLanguages() {
  try {
    const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const block = html.match(/const LANGUAGES = \[([\s\S]*?)\n\];/);
    const langs = block ? [...block[1].matchAll(/\["([^"]*)","([^"]+)","([^"]*)"\]/g)].map((m) => m.slice(1)) : [];
    if (langs.length > 10) return langs;
  } catch {}
  return [["Spanish", "es", "🇪🇸"], ["Portuguese (Brazil)", "pt-BR", "🇧🇷"], ["Chinese (Traditional)", "zh-TW", "🇹🇼"], ["Hebrew", "he", "🇮🇱"]];
}

test("7a. bad translations are a 400 on both save paths and nothing is written", async () => {
  const bad = [
    ["not an object", "x"],
    ["an array", [{ name: "Spanish" }]],
    ["a key that is not a code", { '"><img src=x onerror=alert(1)>': { name: "x", flag: "x", lines: [] } }],
    ["a __proto__ key", JSON.parse('{"__proto__": {"name": "x", "flag": "x", "lines": []}}')],
    ["an over-long key", { ["a".repeat(36)]: { lines: [] } }],
    ["a value that is not an object", { es: "<img src=x onerror=alert(1)>" }],
    ["a value that is an array", { es: ["hola"] }],
    ["a name that is not text", { es: { name: { toString: 1 }, flag: "x", lines: [] } }],
    ["an over-long name", { es: { name: "n".repeat(101), flag: "x", lines: [] } }],
    ["a flag that is not text", { es: { name: "Spanish", flag: 7, lines: [] } }],
    ["an over-long flag", { es: { name: "Spanish", flag: "<img src=x onerror=alert(1)>".repeat(2), lines: [] } }],
    ["lines that is not a list", { es: { name: "Spanish", flag: "x", lines: "hola" } }],
    ["a line that is a number", { es: { name: "Spanish", flag: "x", lines: ["hola", 5] } }],
    ["a line that is an object", { es: { name: "Spanish", flag: "x", lines: [{ x: "hola" }] } }],
  ];
  for (const [what, t] of bad) {
    const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
    const before = db.snapshot();
    const r1 = await api.save("u1", save("yt_a", { c: cues(1), t }));
    assert.equal(r1.status, 400, `owner save, ${what}`);
    assert.equal(typeof r1.body.error, "string");
    assert.doesNotMatch(r1.body.error, /undefined|\[object/, `plain message, ${what}`);
    const r2 = await api.saveShare("tok", { data: { c: cues(1), t } });
    assert.equal(r2.status, 400, `share save, ${what}`);
    assert.deepEqual(db.snapshot(), before, `nothing written, ${what}`);
    assert.equal(db.writes().length, 0);
  }
});

test("7b. what the editor really saves is accepted on both paths", async () => {
  const langs = clientLanguages();
  const codes = langs.map((l) => l[1]);
  assert.ok(codes.includes("pt-BR") && codes.includes("zh-TW"), "the real list was read");
  const t = Object.fromEntries(langs.map(([name, code, flag]) => [code, { name, flag, lines: ["Hola", "", null] }]));
  t.es = { name: "Spanish", flag: "🇪🇸" };             // a column not translated yet
  const thumbs = ["https://img.youtube.com/vi/abc/mqdefault.jpg", " https://i.vimeocdn.com/video/1.jpg", "data:image/jpeg;base64,/9j/4AAQ", "DATA:IMAGE/JPEG;base64,/9j/4AAQ", ""];
  for (const th of thumbs) {
    const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
    const data = { c: cues(3), t, th, ts: 1762171200000, uid: "u1" };
    assert.equal((await api.save("u1", save("yt_a", structuredClone(data)))).status, 200, `owner save, th ${JSON.stringify(th)}`);
    const stored = structuredClone(data);
    stored.t.es.lines = [];                                  // filled in by the server
    assert.deepEqual(db.project("u1", "yt_a").data, stored, "stored as sent");
    assert.equal(db.project("u1", "yt_a").thumb, th || null);
    assert.equal((await api.saveShare("tok", { data: structuredClone(data) })).status, 200, `share save, th ${JSON.stringify(th)}`);
    assert.deepEqual(db.project("u1", "yt_a").data, stored);
  }
  // t may be missing or null, as in older projects.
  const { api } = setup();
  assert.equal((await api.save("u1", save("yt_b", { c: cues(1) }))).status, 200);
  assert.equal((await api.save("u1", save("yt_c", { c: cues(1), t: null }))).status, 200);
});

test("7c. an unsafe thumbnail is blanked, not refused, on both paths", async () => {
  const unsafe = ["javascript:alert(1)", ' "><img src=x onerror=alert(1)>', "http://example.com/a.jpg", "data:text/html,<script>alert(1)</script>", "//evil.example/a.jpg", 5, { src: "x" }, ["https://a"]];
  for (const th of unsafe) {
    const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a", { thumb: "https://img.youtube.com/vi/old/mqdefault.jpg" })], share_links: [link("tok", "p1")] });
    assert.equal((await api.save("u1", save("yt_a", { c: cues(1), t: {}, th }))).status, 200, `owner save, th ${JSON.stringify(th)}`);
    assert.equal(db.project("u1", "yt_a").data.th, "");
    assert.equal(db.project("u1", "yt_a").thumb, null);
    assert.equal((await api.saveShare("tok", { data: { c: cues(1), t: {}, th } })).status, 200, `share save, th ${JSON.stringify(th)}`);
    assert.equal(db.project("u1", "yt_a").data.th, "");
  }
});

test("7d. captions that are not objects are a 400 on both paths, so an edit link cannot break the owner's page", async () => {
  for (const c of [[null], ["hola"], [5], [[]], [{ s: 0, e: 1, x: "a" }, null]]) {
    const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
    const before = db.snapshot();
    assert.equal((await api.save("u1", save("yt_a", { c, t: {} }))).status, 400, `owner save, c ${JSON.stringify(c)}`);
    assert.equal((await api.saveShare("tok", { data: { c, t: {} } })).status, 400, `share save, c ${JSON.stringify(c)}`);
    assert.deepEqual(db.snapshot(), before);
  }
});

// ---------------------------------------------------------------------------
// 8. Per-account storage
// ---------------------------------------------------------------------------

// A project whose data serializes to about `kb` KB.
const sized = (kb) => ({ c: [{ s: 0, e: 1, x: "x".repeat(kb * 1024) }], t: {} });
const bytesOf = (data) => Buffer.byteLength(JSON.stringify(data), "utf8");
// The stored size of `data` saved under `key`: the data plus the link and title that save()
// and projectRow() give it.
const storedBytes = (data, key = "yt_a") => bytesOf(data) + Buffer.byteLength(`https://youtu.be/${key}${key}`, "utf8");

test("8a. the defaults are 25 MB free and 250 MB paid", () => {
  assert.equal(FREE_STORAGE_BYTES, 25 * 1024 * 1024);
  assert.equal(PAID_STORAGE_BYTES, 250 * 1024 * 1024);
});

test("8b. a save is stored with its size", async () => {
  const { api, db } = setup();
  const data = { c: cues(2), t: { es: { name: "Español", flag: "🇪🇸", lines: ["ñ", "é"] } } };
  assert.equal((await api.save("u1", save("yt_a", data))).status, 200);
  assert.equal(db.project("u1", "yt_a").bytes, storedBytes(data), "UTF-8 bytes, not characters");
  assert.ok(bytesOf(data) > JSON.stringify(data).length);
});

test("8c. an owner save past the cap gets 413 and is not written", async () => {
  const { api, db } = setup({
    freeStorage: 10_000, paidStorage: 100_000,
    projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 }), projectRow("p2", "u2", "yt_z", { bytes: 9_000 })],
  });
  const before = db.snapshot();
  const r = await api.save("u1", save("yt_b", sized(5)));
  assert.equal(r.status, 413);
  assert.equal(r.body.error, MSG.storage(10_000, false));
  assert.match(r.body.error, /storage/);
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.writes().length, 0);
  // Another user's projects do not count.
  assert.equal((await api.save("u3", save("yt_b", sized(5)))).status, 200);
});

test("8d. re-saving a project counts its new size, not old plus new", async () => {
  const { api, db } = setup({ freeStorage: 10_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 }), projectRow("p2", "u1", "yt_b", { bytes: 1_000 })] });
  const r = await api.save("u1", save("yt_a", sized(8)));
  assert.equal(r.status, 200, "1,000 + about 8,200 fits; 6,000 + 1,000 + 8,200 would not");
  assert.equal(db.project("u1", "yt_a").bytes, storedBytes(sized(8)));
  // Growing it past the cap is still refused.
  assert.equal((await api.save("u1", save("yt_a", sized(9)))).status, 413);
  assert.equal(db.project("u1", "yt_a").bytes, storedBytes(sized(8)));
});

test("8e. rows saved before the size column count as 0", async () => {
  const { api } = setup({ freeStorage: 10_000, projects: [projectRow("p1", "u1", "yt_a"), projectRow("p2", "u1", "yt_b", { bytes: null })] });
  assert.equal((await api.save("u1", save("yt_c", sized(8)))).status, 200);
});

test("8f. Solo and Team get the paid cap; the tier is only looked up past the free cap", async () => {
  for (const tier of ["solo", "team"]) {
    let lookups = 0;
    const { api } = setup({
      freeStorage: 10_000, paidStorage: 30_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 })],
      tierForUser: async () => { lookups++; return tier; },
    });
    assert.equal((await api.save("u1", save("yt_b", sized(1)))).status, 200);
    assert.equal(lookups, 0, "under the free cap, no tier lookup");
    assert.equal((await api.save("u1", save("yt_c", sized(10)))).status, 200, `${tier} fits under the paid cap`);
    assert.equal(lookups, 1);
    const r = await api.save("u1", save("yt_d", sized(20)));
    assert.equal(r.status, 413);
    assert.equal(r.body.error, MSG.storage(30_000, true));
    assert.doesNotMatch(r.body.error, /plans include/, "no upgrade pitch to a paying user");
  }
  const { api } = setup({ freeStorage: 10_000, paidStorage: 30_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 })] });
  assert.equal((await api.save("u1", save("yt_c", sized(10)))).status, 413, "free stays at the free cap");
});

test("8g. a failed tier lookup falls back to the free cap and is logged", async () => {
  const { api, db, logged } = setup({
    freeStorage: 10_000, paidStorage: 30_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 })],
    tierForUser: async () => { throw new Error("profiles read failed: boom"); },
  });
  const r = await api.save("u1", save("yt_b", sized(10)));
  assert.equal(r.status, 413);
  assert.equal(r.body.error, MSG.storage(10_000, false));
  assert.equal(db.project("u1", "yt_b"), undefined);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1]?.message), /boom/);
});

test("8h. a failed size lookup is a 503 and nothing is written", async () => {
  for (const call of [(api) => api.save("u1", save("yt_a")), (api) => api.saveShare("tok", { data: { c: cues(1) } })]) {
    const { api, db, logged } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
    // Let the project lookups through and fail only the size lookup.
    const failing = { eq: () => failing, limit: () => failing, then: (res) => res({ data: null, error: { message: 'relation "secret_internal" does not exist' } }) };
    const from = db.client.from;
    db.client.from = (table) => {
      const t = from(table);
      return { ...t, select: (cols, opts) => (cols === "source_key, bytes" ? failing : t.select(cols, opts)) };
    };
    const r = await call(api);
    assert.deepEqual(r, { status: 503, body: { error: MSG.generic } });
    assert.equal(db.writes().length, 0);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][1]?.message), /secret_internal/);
  }
});

test("8i. a translator save counts against the owner's cap and gets 413 past it", async () => {
  const { api, db } = setup({
    freeStorage: 10_000, paidStorage: 30_000, tiers: { u1: "team" },
    projects: [projectRow("p1", "u1", "yt_a", { bytes: 1_000 }), projectRow("p2", "u1", "yt_b", { bytes: 20_000 })],
    share_links: [link("tok", "p1")],
  });
  const before = db.snapshot();
  const r = await api.saveShare("tok", { data: sized(12) });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, MSG.storageShare);
  assert.deepEqual(db.snapshot(), before);
  // Under the owner's (Team) cap, and replacing p1's own 1,000 bytes: saved with its size.
  const ok = await api.saveShare("tok", { data: sized(8) });
  assert.equal(ok.status, 200);
  assert.equal(db.project("u1", "yt_a").bytes, storedBytes(sized(8)));
});

test("8j. a translator save to a free owner uses the free cap", async () => {
  const { api } = setup({ freeStorage: 10_000, paidStorage: 30_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 1_000 }), projectRow("p2", "u1", "yt_b", { bytes: 5_000 })], share_links: [link("tok", "p1")] });
  assert.equal((await api.saveShare("tok", { data: sized(3) })).status, 200);
  assert.equal((await api.saveShare("tok", { data: sized(5) })).status, 413);
});

// ---------------------------------------------------------------------------
// 9. Shapes and sizes an edit link could abuse, and saves that race
// ---------------------------------------------------------------------------

test("9a. a caption with an object where text or a time belongs is a 400 on both paths", async () => {
  const bad = [
    { start: {}, end: 1, line1: "a" },
    { start: 0, end: [1], line1: "a" },
    { start: "1".repeat(33), end: 1, line1: "a" },
    { start: 0, end: 1, line1: { toString: 1 } },
    { start: 0, end: 1, line1: "a", line2: ["b"] },
    { start: 0, end: 1, text: 5 },
    { start: 0, end: 1, line1: "a".repeat(MAX_LINE_CHARS + 1) },
  ];
  for (const cue of bad) {
    const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
    const before = db.snapshot();
    const r1 = await api.save("u1", save("yt_a", { c: [cue], t: {} }));
    assert.equal(r1.status, 400, `owner save, ${JSON.stringify(cue).slice(0, 60)}`);
    assert.match(r1.body.error, /caption 1/i);
    assert.equal((await api.saveShare("tok", { data: { c: [cue], t: {} } })).status, 400, `share save, ${JSON.stringify(cue).slice(0, 60)}`);
    assert.deepEqual(db.snapshot(), before);
  }
  const good = [
    { start: 0, end: 1.5, line1: "Hola", line2: "" },
    { start: "00:00:01,000", end: "00:00:02,000", line1: "a", line2: null },
    { start: 0, end: 1, line1: "a".repeat(MAX_LINE_CHARS) },
    { s: 0, e: 1, x: "older shape" },
  ];
  const { api } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  assert.equal((await api.save("u1", save("yt_a", { c: good, t: {} }))).status, 200);
  assert.equal((await api.saveShare("tok", { data: { c: good, t: {} } })).status, 200);
});

test("9b. more than MAX_TRANSLATIONS translations is a 400 on both paths", async () => {
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { name: `L${i}`, flag: "x", lines: [] }]));
  const { api, db } = setup({ projects: [projectRow("p1", "u1", "yt_a")], share_links: [link("tok", "p1")] });
  const before = db.snapshot();
  const r = await api.save("u1", save("yt_a", { c: cues(1), t: many(MAX_TRANSLATIONS + 1) }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, new RegExp(`at most ${MAX_TRANSLATIONS} translations`));
  assert.equal((await api.saveShare("tok", { data: { c: cues(1), t: many(MAX_TRANSLATIONS + 1) } })).status, 400);
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await api.save("u1", save("yt_a", { c: cues(1), t: many(MAX_TRANSLATIONS) }))).status, 200);
  assert.equal((await api.saveShare("tok", { data: { c: cues(1), t: many(MAX_TRANSLATIONS) } })).status, 200);
});

test("9c. a video link that is not text, or longer than MAX_SOURCE_URL, is a 400", async () => {
  for (const source_url of [5, { href: "https://a" }, ["https://a"], "https://a/" + "x".repeat(MAX_SOURCE_URL)]) {
    const { api, db } = setup();
    const r = await api.save("u1", save("yt_a", undefined, { source_url }));
    assert.equal(r.status, 400, `source_url ${JSON.stringify(source_url).slice(0, 40)}`);
    assert.match(r.body.error, /video link/);
    assert.equal(db.writes().length, 0);
  }
  for (const source_url of [null, undefined, "", "h".repeat(MAX_SOURCE_URL)]) {
    const { api } = setup();
    assert.equal((await api.save("u1", save("yt_a", undefined, { source_url }))).status, 200, `source_url ${String(source_url).slice(0, 20)}`);
  }
});

test("9d. the link and the title count toward storage; a long title counts as cut", async () => {
  const data = sized(3);
  const room = 10_000 - 6_000 - bytesOf(data) - "yt_b".length;
  const url = (n) => "https://youtu.be/" + "a".repeat(n - "https://youtu.be/".length);
  const fresh = () => setup({ freeStorage: 10_000, projects: [projectRow("p1", "u1", "yt_a", { bytes: 6_000 })] });
  let { api, db } = fresh();
  assert.equal((await api.save("u1", save("yt_b", data, { source_url: url(room) }))).status, 200, "exactly at the cap fits");
  assert.equal(db.project("u1", "yt_b").bytes, 10_000 - 6_000);
  ({ api } = fresh());
  assert.equal((await api.save("u1", save("yt_b", data, { source_url: url(room + 1) }))).status, 413, "one byte of link over");
  // The title is stored cut to MAX_TITLE, and counted as stored.
  ({ api, db } = setup());
  assert.equal((await api.save("u1", save("yt_b", data, { title: "t".repeat(MAX_TITLE + 500) }))).status, 200);
  assert.equal(db.project("u1", "yt_b").bytes, bytesOf(data) + "https://youtu.be/yt_b".length + MAX_TITLE);
});

test("9e. parallel owner saves cannot pass the storage cap together", async () => {
  const data = sized(4);
  const one = storedBytes(data, "yt_a");
  const { api, db } = setup({ freeStorage: 2 * one + 100 });
  const results = await Promise.all(["yt_a", "yt_b", "yt_c"].map((k) => api.save("u1", save(k, sized(4)))));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 413]);
  const total = ["yt_a", "yt_b", "yt_c"].reduce((sum, k) => sum + (db.project("u1", k)?.bytes || 0), 0);
  assert.ok(total <= 2 * one + 100, `stored ${total}`);
});

test("9f. a translator save and an owner save running together cannot pass the cap", async () => {
  const one = storedBytes(sized(5), "yt_b");
  const cap = 1_000 + one + 500;    // either save fits alone; both together do not
  const { api, db } = setup({ freeStorage: cap, projects: [projectRow("p1", "u1", "yt_a", { bytes: 1_000 })], share_links: [link("tok", "p1")] });
  const [owner, share] = await Promise.all([api.save("u1", save("yt_b", sized(5))), api.saveShare("tok", { data: sized(5) })]);
  assert.deepEqual([owner.status, share.status].sort(), [200, 413]);
  const total = (db.project("u1", "yt_a")?.bytes || 0) + (db.project("u1", "yt_b")?.bytes || 0);
  assert.ok(total <= cap, `stored ${total}`);
});
