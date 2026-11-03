/**
 * Cloud projects and translator share links, kept separate from Express so the rules
 * can be tested against a fake Supabase client (see projects.test.mjs).
 *
 * Every function returns { status, body } for the route to send. A database error is
 * logged with its details and answered with a generic 503, so raw Postgres messages
 * never reach the browser.
 *
 * Optimistic concurrency is opt-in. GET /projects/:key and GET /share/:token return the
 * row's updated_at. A save that sends it back as base_updated_at only lands if nobody
 * else saved in between; otherwise it gets a 409 and writes nothing. A save without
 * base_updated_at overwrites, which is how the client behaved before this existed.
 * Clients must echo updated_at exactly as received (it can carry microseconds that a
 * JavaScript Date would drop).
 */
import express from "express";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

// Owner saves and translator saves carry a whole project. 700 to 1,000 cues, or 600
// cues plus a translation, is 120 to 210 KB, which the default 100 KB limit rejected
// with a 413 the client never showed. Every other route keeps the 100 KB default.
export const PROJECT_BODY_LIMIT = "2mb";
export const MAX_CUES = 20000;
export const MAX_SOURCE_KEY = 300;
export const MAX_TITLE = 300;
export const MAX_LABEL = 300;
export const MAX_PROJECTS = 500;
// Per-account storage: the summed size of an owner's saved projects (JSON of data, in
// bytes). Paid means Solo or Team. Translator saves count against the owner's cap.
export const FREE_STORAGE_BYTES = 25 * 1024 * 1024;
export const PAID_STORAGE_BYTES = 250 * 1024 * 1024;
export const PAID_TIERS = new Set(["solo", "team"]);
export const MAX_LANG_NAME = 100;
// The editor offers 44 languages; this leaves room for more without letting a payload
// carry thousands of columns.
export const MAX_TRANSLATIONS = 60;
// One caption line. The editor keeps lines to about 42 characters; a raw transcript
// cue can be longer before it is split.
export const MAX_LINE_CHARS = 5000;
// Signed video links can run to a few thousand characters.
export const MAX_SOURCE_URL = 8192;
export const MAX_LANG_FLAG = 32;
export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LIST_LIMIT = 60;

export const MSG = {
  generic: "Something went wrong on our side. Please try again.",
  quota: (n) => `You have reached the limit of ${n} saved projects. Delete some old ones to save new ones.`,
  conflict: "This project changed somewhere else. Reload to get the latest version.",
  teamOnly: "Sharing with a translator is a Team plan feature. Upgrade to Team to hand off projects.",
  storage: (bytes, paid) => `Your saved projects have used up your account's ${Math.round(bytes / 1024 / 1024)} MB of storage. Delete some old projects to save this one.` +
    (paid ? "" : ` Solo and Team plans include ${Math.round(PAID_STORAGE_BYTES / 1024 / 1024)} MB.`),
  storageShare: "The project owner's account is out of storage, so this change could not be saved. Ask the owner to free up space.",
};

// True for the two routes that carry a whole project: POST /projects (owner save) and
// PUT /share/:token (translator save). Matched without case and with an optional
// trailing slash, the way Express routes them.
export function isProjectSave(method, path) {
  if (method === "POST") return /^\/projects\/?$/i.test(path);
  if (method === "PUT") return /^\/share\/[^/]+\/?$/i.test(path);
  return false;
}

// One JSON body parser for the whole app: 2 MB for project saves, the 100 KB default
// for everything else. A body over the limit fails with the parser's own 413, which
// the app's error handler passes through. The Stripe webhook is registered before
// this and reads the raw body.
export function jsonBodyParser() {
  const small = express.json();
  const large = express.json({ limit: PROJECT_BODY_LIMIT });
  return (req, res, next) => (isProjectSave(req.method, req.path) ? large : small)(req, res, next);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const bad = (error) => reply(400, { error });

// Translation columns are keyed by language code ("es", "pt-BR", "zh-TW"). 35 characters
// is the longest tag BCP 47 asks software to handle. A leading letter rules out "__proto__".
const LANG_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,34}$/;
// The thumbnails the client makes: a YouTube or Vimeo https URL, or a JPEG data URL.
const safeThumb = (v) => typeof v === "string" && /^(https:|data:image\/)/i.test(v.trim());
const isText = (v, max) => v === undefined || v === null || (typeof v === "string" && v.length <= max);

// A caption time: the editor saves seconds as a number. A string is let through for
// projects saved by older versions; neither can make the page throw.
const isTime = (v) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 32);

// What is wrong with one caption, or null. The client stores { start, end, line1, line2 }.
// An object where text or a time belongs makes the editor throw on every open.
function captionProblem(cue, i) {
  if (!isPlainObject(cue)) return "Every caption in data.c must be an object.";
  if (!isTime(cue.start) || !isTime(cue.end)) return `Caption ${i + 1} must have its start and end times in seconds.`;
  for (const k of ["line1", "line2", "text"]) {
    if (!isText(cue[k], MAX_LINE_CHARS)) return `The text of caption ${i + 1} must be at most ${MAX_LINE_CHARS.toLocaleString("en-US")} characters per line.`;
  }
  return null;
}

// What is wrong with one translation column, or null. The client stores
// { name, flag, lines: [text per caption] }; a line never filled in is saved as null.
// A column with no lines gets an empty list, because the page reads tr.lines[i].
function translationProblem(code, tr) {
  if (!isPlainObject(tr)) return `data.t.${code} must be an object.`;
  if (!isText(tr.name, MAX_LANG_NAME)) return `The name of translation ${code} must be text of at most ${MAX_LANG_NAME} characters.`;
  if (!isText(tr.flag, MAX_LANG_FLAG)) return `The flag of translation ${code} must be text of at most ${MAX_LANG_FLAG} characters.`;
  if (tr.lines === undefined || tr.lines === null) tr.lines = [];
  else if (!Array.isArray(tr.lines) || !tr.lines.every((l) => l === null || typeof l === "string")) {
    return `data.t.${code}.lines must be the list of translated lines.`;
  }
  return null;
}

// Why a project payload is unusable, or null when it is fine. The page renders the
// translations and the thumbnail, and a translator with an edit link can save both, so
// they are checked here too. An unsafe thumbnail is blanked rather than refused, so a
// project saved before this check still saves.
function dataProblem(data) {
  if (!isPlainObject(data)) return "data must be an object.";
  if (!Array.isArray(data.c)) return "data.c must be the list of captions.";
  if (data.c.length > MAX_CUES) return `A project can hold at most ${MAX_CUES.toLocaleString("en-US")} captions. This one has ${data.c.length.toLocaleString("en-US")}.`;
  for (let i = 0; i < data.c.length; i++) {
    const problem = captionProblem(data.c[i], i);
    if (problem) return problem;
  }
  if (data.t !== undefined && data.t !== null) {
    if (!isPlainObject(data.t)) return "data.t must be the translations, keyed by language code.";
    if (Object.keys(data.t).length > MAX_TRANSLATIONS) return `A project can hold at most ${MAX_TRANSLATIONS} translations.`;
    for (const [code, tr] of Object.entries(data.t)) {
      if (!LANG_KEY.test(code)) return `"${code.slice(0, 40)}" is not a language code. Translations must be keyed by language code, such as es or pt-BR.`;
      const problem = translationProblem(code, tr);
      if (problem) return problem;
    }
  }
  if (data.th !== undefined && data.th !== "" && !safeThumb(data.th)) data.th = "";
  return null;
}

// The size a project counts for against its owner's storage: its data plus the link and
// title stored beside it.
const projectBytes = (data, sourceUrl, title) =>
  Buffer.byteLength(JSON.stringify(data) + (sourceUrl || "") + (title || ""), "utf8");

// base_updated_at is optional. Absent or null means "overwrite", as before.
function readBase(body) {
  const v = body?.base_updated_at;
  if (v === undefined || v === null) return { base: null };
  if (typeof v !== "string" || v.length > 64 || Number.isNaN(Date.parse(v))) {
    return { error: "base_updated_at must be the updated_at value this server returned." };
  }
  return { base: v };
}

const dbError = (what, error) => Object.assign(new Error(`${what}: ${error?.message || "unknown error"}`), { db: error });

export function makeProjects({
  supabase, clock = Date.now, log = console, maxProjects = MAX_PROJECTS, tierForUser, shareTtlMs = SHARE_TTL_MS,
  freeStorage = FREE_STORAGE_BYTES, paidStorage = PAID_STORAGE_BYTES,
}) {
  // Saves for one owner run one at a time, so two saves sent together cannot both pass
  // the storage cap or the project count by reading the total before either writes.
  // This holds while billing runs as a single instance, as it does on Render.
  const queues = new Map();
  function oneAtATime(owner, fn) {
    const run = (queues.get(owner) || Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    queues.set(owner, tail);
    tail.then(() => { if (queues.get(owner) === tail) queues.delete(owner); });
    return run;
  }

  // The new updated_at for a save. With a base, it is always later than the base, so
  // two saves in the same millisecond cannot leave the version unchanged.
  const stamp = (base) => new Date(base ? Math.max(clock(), Date.parse(base) + 1) : clock()).toISOString();
  const expired = (link) => !!link.expires_at && Date.parse(link.expires_at) <= clock();

  async function ownedProject(owner, key, cols = "id") {
    const { data, error } = await supabase.from("projects").select(cols).eq("owner", owner).eq("source_key", key).maybeSingle();
    if (error) throw dbError("project lookup failed", error);
    return data;
  }

  async function findLink(token) {
    const { data, error } = await supabase.from("share_links").select("project_id, can_edit, expires_at").eq("token", token).maybeSingle();
    if (error) throw dbError("share link lookup failed", error);
    return data;
  }

  async function projectById(id, cols) {
    const { data, error } = await supabase.from("projects").select(cols).eq("id", id).maybeSingle();
    if (error) throw dbError("project lookup by id failed", error);
    return data;
  }

  // UPDATE ... RETURNING updated_at. With a base, the row must still carry that
  // updated_at, so the version check and the write are one statement and a save that
  // lost the race matches no row.
  async function updateWhere(match, base, fields) {
    let q = supabase.from("projects").update(fields);
    for (const [col, val] of Object.entries(match)) q = q.eq(col, val);
    if (base) q = q.eq("updated_at", base);
    const { data, error } = await q.select("updated_at");
    if (error) throw dbError("project update failed", error);
    return data?.[0] || null;
  }

  // A 413 reply when saving `bytes` as the owner's project sourceKey would take the owner
  // past their storage cap, otherwise null. The project's own old size is left out, so
  // re-saving a project only counts its new size. The tier is looked up only when the
  // total is over the free cap, and a failed lookup falls back to the free cap rather
  // than failing the save. A failed size read throws, so the cap is never skipped.
  async function storageFull(owner, sourceKey, bytes, message) {
    const { data, error } = await supabase.from("projects").select("source_key, bytes").eq("owner", owner).limit(maxProjects);
    if (error) throw dbError("project size lookup failed", error);
    let total = bytes;
    for (const p of data || []) if (p.source_key !== sourceKey) total += Number(p.bytes) || 0;
    if (total <= freeStorage) return null;
    let paid = false;
    try { paid = PAID_TIERS.has(await tierForUser(owner)); }
    catch (e) { log.error("projects: tier lookup failed, using the free storage cap:", e); }
    const cap = paid ? paidStorage : freeStorage;
    return total > cap ? reply(413, { error: message(cap, paid) }) : null;
  }

  async function list(owner) {
    const { data, error } = await supabase.from("projects")
      .select("source_key, source_url, title, thumb, caption_count, updated_at")
      .eq("owner", owner).order("updated_at", { ascending: false }).limit(LIST_LIMIT);
    if (error) throw dbError("project list failed", error);
    return reply(200, { projects: (data || []).map((p) => ({
      key: p.source_key, url: p.source_url, title: p.title, th: p.thumb || "",
      count: p.caption_count || 0, ts: new Date(p.updated_at).getTime(),
    })) });
  }

  async function get(owner, key) {
    const row = await ownedProject(owner, key, "data, updated_at");
    if (!row) return reply(404, { error: "Not found" });
    return reply(200, { data: row.data, updated_at: row.updated_at });
  }

  async function save(owner, body) {
    const { source_key, source_url, title, data } = body || {};
    if (!source_key || !data) return bad("source_key and data required");
    if (typeof source_key !== "string" || source_key.length > MAX_SOURCE_KEY) return bad(`source_key must be text of at most ${MAX_SOURCE_KEY} characters.`);
    if (source_url != null && (typeof source_url !== "string" || source_url.length > MAX_SOURCE_URL)) {
      return bad(`The video link must be text of at most ${MAX_SOURCE_URL.toLocaleString("en-US")} characters.`);
    }
    const problem = dataProblem(data);
    if (problem) return bad(problem);
    const { base, error: baseError } = readBase(body);
    if (baseError) return bad(baseError);
    return oneAtATime(owner, () => saveChecked(owner, { source_key, source_url, title, data, base }));
  }

  async function saveChecked(owner, { source_key, source_url, title, data, base }) {
    // Today's client sends the pasted source URL as the title, and signed video URLs
    // can run past 300 characters, so a long title is cut rather than refused.
    const titleText = typeof title === "string" ? title.slice(0, MAX_TITLE) || null : null;
    const bytes = projectBytes(data, source_url, titleText);
    const full = await storageFull(owner, source_key, bytes, MSG.storage);
    if (full) return full;

    const updated_at = stamp(base);
    const fields = {
      source_url: source_url || null,
      title: titleText,
      thumb: typeof data.th === "string" ? data.th.slice(0, 200000) || null : null,
      caption_count: data.c.length,
      bytes,
      data,
      updated_at,
    };
    const match = { owner, source_key };

    if (base) {
      const row = await updateWhere(match, base, fields);
      if (row) return reply(200, { ok: true, updated_at: row.updated_at || updated_at });
      // Nothing matched: someone else saved first, or the project was deleted.
      const current = await ownedProject(owner, source_key, "updated_at");
      return reply(409, { error: MSG.conflict, updated_at: current?.updated_at ?? null });
    }

    // No base: overwrite, as before. Updating a project the user already has is always
    // allowed, even past the quota.
    const row = await updateWhere(match, null, fields);
    if (row) return reply(200, { ok: true, updated_at: row.updated_at || updated_at });

    // A new project. The count and the insert are separate statements; oneAtATime keeps
    // two saves by the same owner from both passing the cap.
    const { count, error: countError } = await supabase.from("projects").select("id", { count: "exact", head: true }).eq("owner", owner);
    if (countError) throw dbError("project count failed", countError);
    if (typeof count === "number" && count >= maxProjects) return reply(403, { error: MSG.quota(maxProjects) });
    // Upsert, not insert: if another request created this key since the update above,
    // this updates it instead of failing on the unique (owner, source_key) index.
    const { data: rows, error } = await supabase.from("projects")
      .upsert({ ...match, ...fields }, { onConflict: "owner,source_key" }).select("updated_at");
    if (error) throw dbError("project insert failed", error);
    return reply(200, { ok: true, updated_at: rows?.[0]?.updated_at || updated_at });
  }

  async function remove(owner, key) {
    const { error } = await supabase.from("projects").delete().eq("owner", owner).eq("source_key", key);
    if (error) throw dbError("project delete failed", error);
    return reply(200, { ok: true });
  }

  // Team only. The link lasts shareTtlMs (30 days). Links minted before expiry existed
  // have expires_at null and keep working.
  async function mintShare(owner, key, body) {
    if ((await tierForUser(owner)) !== "team") return reply(403, { error: MSG.teamOnly });
    const proj = await ownedProject(owner, key);
    if (!proj) return reply(404, { error: "Save the project before sharing it." });
    const token = randomBytes(18).toString("hex");
    const expires_at = new Date(clock() + shareTtlMs).toISOString();
    const { error } = await supabase.from("share_links").insert({
      token, project_id: proj.id, can_edit: body?.canEdit !== false,
      label: typeof body?.label === "string" ? body.label.slice(0, MAX_LABEL) || null : null,
      expires_at,
    });
    if (error) throw dbError("share link insert failed", error);
    return reply(200, { token, expires_at });
  }

  // The owner's links for one project, newest first, expired ones included and marked.
  async function listShares(owner, key) {
    const proj = await ownedProject(owner, key);
    if (!proj) return reply(404, { error: "Not found" });
    const { data, error } = await supabase.from("share_links")
      .select("token, label, can_edit, expires_at, created_at")
      .eq("project_id", proj.id).order("created_at", { ascending: false });
    if (error) throw dbError("share link list failed", error);
    return reply(200, { shares: (data || []).map((l) => ({
      token: l.token, label: l.label, can_edit: l.can_edit, expires_at: l.expires_at,
      created_at: l.created_at, expired: expired(l),
    })) });
  }

  // Revoking deletes the row. The delete is filtered by the caller's own project, so a
  // token on someone else's project matches nothing and gets the same 404 as a token
  // that does not exist.
  async function revokeShare(owner, key, token) {
    const notFound = reply(404, { error: "Share link not found." });
    const proj = await ownedProject(owner, key);
    if (!proj) return notFound;
    const { data, error } = await supabase.from("share_links").delete().eq("token", token).eq("project_id", proj.id).select("token");
    if (error) throw dbError("share link delete failed", error);
    return data?.length ? reply(200, { ok: true }) : notFound;
  }

  async function openShare(token) {
    const link = await findLink(token);
    if (!link) return reply(404, { error: "This share link is invalid or was revoked." });
    if (expired(link)) return reply(410, { error: "This share link has expired." });
    const proj = await projectById(link.project_id, "title, source_url, data, updated_at");
    if (!proj) return reply(404, { error: "The shared project no longer exists." });
    return reply(200, {
      title: proj.title, source_url: proj.source_url, data: proj.data, canEdit: link.can_edit,
      updated_at: proj.updated_at, expires_at: link.expires_at ?? null,
    });
  }

  async function saveShare(token, body) {
    const link = await findLink(token);
    if (!link) return reply(404, { error: "Invalid share link" });
    if (!link.can_edit) return reply(403, { error: "This link is view-only" });
    if (expired(link)) return reply(410, { error: "Link expired" });
    const data = body?.data;
    if (!data) return bad("data required");
    const problem = dataProblem(data);
    if (problem) return bad(problem);
    const { base, error: baseError } = readBase(body);
    if (baseError) return bad(baseError);
    // The save counts against the project owner's storage, and waits behind the owner's
    // own saves.
    const proj = await projectById(link.project_id, "owner, source_key, source_url, title");
    if (!proj) return reply(404, { error: "The shared project no longer exists." });
    return oneAtATime(proj.owner, () => saveShareChecked(link, proj, data, base));
  }

  async function saveShareChecked(link, proj, data, base) {
    const bytes = projectBytes(data, proj.source_url, proj.title);
    const full = await storageFull(proj.owner, proj.source_key, bytes, () => MSG.storageShare);
    if (full) return full;

    const updated_at = stamp(base);
    const row = await updateWhere({ id: link.project_id }, base, { data, caption_count: data.c.length, bytes, updated_at });
    if (row) return reply(200, { ok: true, updated_at: row.updated_at || updated_at });
    const current = base ? await projectById(link.project_id, "updated_at") : null;
    if (current) return reply(409, { error: MSG.conflict, updated_at: current.updated_at });
    return reply(404, { error: "The shared project no longer exists." });
  }

  // Any failure (a database error, or a bug) is logged with its details and answered
  // with a generic 503. Logged messages never include the share token.
  const guard = (name, fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      log.error(`projects.${name} failed:`, e);
      return reply(503, { error: MSG.generic });
    }
  };

  return {
    list: guard("list", list),
    get: guard("get", get),
    save: guard("save", save),
    remove: guard("remove", remove),
    mintShare: guard("mintShare", mintShare),
    listShares: guard("listShares", listShares),
    revokeShare: guard("revokeShare", revokeShare),
    openShare: guard("openShare", openShare),
    saveShare: guard("saveShare", saveShare),
  };
}
