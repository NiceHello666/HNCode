// Session store. Sessions persist under ~/.hncode/sessions/<id>.json.
// A session records: id, title, cwd (workspace), model, createdAt, updatedAt,
// and the message list (canonical, same shape the agent loop uses).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_DIR = () => path.join(os.homedir(), '.hncode', 'sessions');
function dir(custom) { return custom || process.env.HNCODE_SESSIONS_DIR || DEFAULT_DIR(); }

/** The resolved session store directory. Exported so the web daemon can read it. */
export function sessionsDir(custom) { return dir(custom); }

// ---- metadata cache --------------------------------------------------------
// Enumerating sessions (listSessions / latestSession / --continue) re-read every
// session file to grab its id/title/workspace/timestamps. With hundreds of
// sessions that is hundreds of open+read+parse per call. Since session files are
// only ever written through THIS module (saveSession/deleteSession), we cache the
// parsed metadata per directory and invalidate the affected entries on write. A
// caller that knows the dir changed externally (another hncode instance) can call
// invalidateSessionCache(). The cache never stores message content — only the
// cheap metadata head.
const _metaCache = new Map(); // key: storeDir (string) -> Map<fullPath, {meta, hasMessages}>
function cacheFor(storeDir, create = true) {
  const d = dir(storeDir);
  let c = _metaCache.get(d);
  if (!c && create) { c = new Map(); _metaCache.set(d, c); }
  return c;
}
export function invalidateSessionCache(storeDir) {
  _metaCache.delete(dir(storeDir));
}
// Public types do not change; this is used by the TUI/headless before a re-list
// if external state is suspected. Our own save/delete already invalidate.

// FIX: single place for the error log so save/load failures are never silent.
function errorLogFile() {
  return path.join(os.homedir(), '.hncode', 'session-errors.log');
}
function logSessionError(op, detail) {
  try {
    fs.mkdirSync(path.dirname(errorLogFile()), { recursive: true });
    fs.appendFileSync(
      errorLogFile(),
      `[${new Date().toISOString()}] ${op}: ${detail}\n`,
      'utf8',
    );
  } catch { /* logging must never throw */ }
}

export function newId() {
  // compact, mostly-sorted id (like a timestamp+rand ULID-ish)
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function sessionFile(id, storeDir) {
  return path.join(dir(storeDir), `${id}.json`);
}

/**
 * One `session.messages` entry -> the transcript ROW(s) that mirror it.
 *
 * Returns an ARRAY because an assistant turn with tool calls becomes the
 * assistant row PLUS one `tool` row per call. Both the TUI transcript and the
 * Web UI's read-only view of a finished session render from these rows, so the
 * expansion lives here — in the session data layer — rather than in either
 * front-end. It also keeps the Web daemon off the TUI's import graph: the daemon
 * needs this conversion but must NOT pull in the renderer, the agent and the LLM
 * client to get it.
 *
 * Callers must FLATTEN the result (`flatMap`), not spread it into an object.
 */
export function convRowFor(m) {
  if (!m || typeof m !== 'object') return [];
  const text = typeof m.content === 'string' ? m.content : '';
  if (m.role === 'user') return [{ role: 'user', text }];
  if (m.role === 'tool') return [{ role: 'tool_result', text }];
  if (m.role === 'assistant') {
    const rows = [{ role: 'assistant', text }];
    for (const tc of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
      if (!tc || typeof tc !== 'object') continue;
      rows.push({ role: 'tool', toolName: tc.name, toolArgs: tc.args || {}, pending: false });
    }
    return rows;
  }
  return [];
}
// FIX: build the serialized object with a FIXED key order so `updatedAt`
// always lands BEFORE `messages`. readSessionMeta() stops scanning at the
// `"messages"` key, so a session whose updatedAt sits after the transcript
// would report updatedAt = 0 and the session list / --continue would sort
// wrongly (or pick the wrong session). Key order here is authoritative.
//
// `transcript` goes LAST — after `messages`, not merely after the metadata block.
// It is the one value here with no size limit: every persisted reasoning block is
// stored whole, and the head reader gives up after META_MAX_BYTES. Written ahead of
// `messages` a multi-megabyte `transcript` pushed the key out of reach and the session
// became unlistable, which is what made intact conversations vanish from /sessions.
// Behind `messages` the reader never has to cross it.
function serializableSession(session) {
  const out = {};
  out.id = session.id;
  out.title = session.title || '';
  out.workspace = session.workspace || '';
  out.model = session.model || '';
  out.createdAt = session.createdAt || Date.now();
  out.updatedAt = Date.now();
  // Everything else (rounds, steps, plan, focus, swarm, effort, …) is copied AFTER
  // updatedAt. `messages` and `transcript` in particular must come after the metadata
  // block, and they are appended below in that order.
  for (const k of Object.keys(session)) {
    if (k in out) continue;
    if (k === 'messages' || k === 'transcript') continue;
    out[k] = session[k];
  }
  out.messages = Array.isArray(session.messages) ? session.messages : [];
  if (Array.isArray(session.transcript)) out.transcript = session.transcript;
  return out;
}

// ---- saving -----------------------------------------------------------------
//
// SAVING IS ON THE PER-TURN PATH, SO IT MUST NOT BLOCK THE FRAME.
//
// `saveSession` used to do the whole thing synchronously: `JSON.stringify` of the entire history, then `writeFileSync`,
// then `renameSync`. On a 2.5 MB session that is a visible stall between the user pressing Enter and anything appearing
// on screen — and it is paid TWICE per turn, once for the user message and once at each step boundary
// (`persistTurnProgress`). A slow disk multiplies all of it.
//
// The write is now scheduled, and calls that land in the same tick coalesce into ONE write: the session object is the
// same reference every time, so the last call is the one worth writing.
//
// ORDERING IS KEPT. `serialize` runs INSIDE the scheduled callback, not at call time, so the bytes written always
// describe the session as it is when the write happens — never an older snapshot queued behind a newer one.
//
// A CALLER THAT MUST HAVE THE BYTES ON DISK uses `saveSessionNow` (used on exit).
let pendingSave = null;      // { session, storeDir }
let pendingScheduled = false;
let saveTimer = null;

/**
 * How long a queued save may wait.
 *
 * A turn saves once per step boundary plus once at the end, a few seconds apart — long enough that `setImmediate` never
 * coalesced any of them. Three seconds is short enough that a crash loses at most the last step, and long enough that a
 * burst of steps becomes one write.
 */
const SAVE_DELAY_MS = 3000;

// Declared before its first use: `writeSessionSync` records a failure, and a `let` further down the file would
// put it in the temporal dead zone.
let saveFailure = null;

// ---- incremental serialisation ------------------------------------------------
//
// A SAVE USED TO RE-SERIALISE EVERY MESSAGE, WHICH IS THE WHOLE HISTORY EVERY TIME.
//
// Measured on the real session: 19.8ms of JSON.stringify per save, 43ms including the write, and a turn saves several
// times. Deferring it only moved the stall to a later frame — during streaming, which is the worst moment for one.
//
// A turn appends a few messages and leaves the rest untouched, so each message's JSON is worth keeping. `WeakMap` on
// the message object is the right home for it: the entry dies with the message, and a message that is REPLACED (a
// compaction rebuilds the array, /undo swaps objects) simply misses. A message that is MUTATED IN PLACE is the one case
// a WeakMap cannot see — that is what `bumpMessage` is for, and the call sites that edit an existing message use it.
//
// Measured: 15.97ms cold for the whole array, 0.14ms once the cache is warm. That is the difference between a stall the
// user can see and one they cannot.
const messageJson = new WeakMap();

/** JSON for one message, cached on the object. */
function jsonOf(m) {
  let j = messageJson.get(m);
  if (j === undefined) { j = JSON.stringify(m); messageJson.set(m, j); }
  return j;
}

/**
 * Forget a message's cached JSON. Call after editing one IN PLACE.
 *
 * A rename of the field itself would be a compile error; this cannot be, so the discipline is: anything that writes to
 * a message that may already have been saved calls this. Missing one means that edit is not persisted until the message
 * object is replaced — not corruption, but a stale field on the next resume.
 */
export function bumpMessage(m) {
  if (m && typeof m === 'object') messageJson.delete(m);
}

/**
 * `JSON.stringify(session)` without re-serialising messages that have not changed.
 *
 * The outer object is small (a dozen scalars), so it is rebuilt every time; only `messages` — and a `transcript` array,
 * when there is one — come from the per-message cache. The result is byte-identical to one `JSON.stringify` call, which
 * is what the reader on the other side expects.
 */
function stringifySession(session) {
  const obj = serializableSession(session);
  const messages = obj.messages;
  // The rest of the object is tiny, so it is serialised normally with a placeholder standing in for the arrays.
  const PLACE = '\u0000HNCODE_PLACEHOLDER\u0000';
  const shallow = { ...obj, messages: PLACE };
  if (Array.isArray(obj.transcript)) shallow.transcript = PLACE;
  const text = JSON.stringify(shallow);
  const messagesJson = '[' + messages.map((m) => (m && typeof m === 'object' ? jsonOf(m) : JSON.stringify(m))).join(',') + ']';
  let out = text.replace(JSON.stringify(PLACE), messagesJson);
  if (Array.isArray(obj.transcript)) {
    const tr = obj.transcript;
    const trJson = '[' + tr.map((m) => (m && typeof m === 'object' ? jsonOf(m) : JSON.stringify(m))).join(',') + ']';
    out = out.replace(JSON.stringify(PLACE), trJson);
  }
  return out;
}

function writeSessionSync(session, storeDir) {
  if (!session || !session.id) return session;
  // Keep the live object's updatedAt in sync for callers that read it back.
  session.updatedAt = Date.now();
  try {
    fs.mkdirSync(dir(storeDir), { recursive: true });
    const target = sessionFile(session.id, storeDir);
    // FIX: unique temp name so two concurrent saves of the same session cannot
    // clobber each other's temp file mid-write.
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    // Compact JSON, no indentation. `null, 2` made the file ~30% larger for a
    // human who never reads it (the reader is JSON.parse), and the pretty-printer
    // itself costs real time on a large transcript — measured ~22ms for 5.7MB, all
    // of it spent inserting whitespace.
    const json = stringifySession(session);
    fs.writeFileSync(tmp, json, 'utf8');
    // Atomic replace. If this throws (EXDEV etc.) the temp is cleaned up below.
    fs.renameSync(tmp, target);
    cacheFor(storeDir, false)?.delete(sessionFile(session.id, storeDir));
    // A save that worked clears any earlier failure, so /save-report speaks about the
    // CURRENT state rather than a problem the user already resolved by being told.
    saveFailure = null;
  } catch (e) {
    // FIX: never fail silently. Previously an empty catch {} in the TUI meant a
    // serialization error (circular ref, disk full, permissions) lost the turn
    // with no signal at all.
    const detail = e && e.message ? e.message : String(e);
    logSessionError('save', `${session.id}: ${detail}`);
    // The log alone was not enough. A session whose transcript had grown past the V8
    // string limit failed EVERY save for an hour and a half — the turn was lost each
    // time and all the file recorded was `Invalid string length`, in a log nobody opens.
    // The flag is what lets the TUI say so out loud; this module never reaches into the UI.
    if (!saveFailure) saveFailure = { at: Date.now(), id: session.id, detail };
    return session;
  }
  return session;
}

/**
 * Queue a save for the next event-loop tick, coalescing with any other call that lands before then.
 *
 * THIS IS THE ONE THE TUI USES. `saveSession` stays synchronous because its contract is "the file is on disk when
 * this returns", and several callers depend on that — the store-integrity tests among them. On the per-turn path that
 * contract is what costs a visible stall: a 1.3 MB session measured 38 ms of `JSON.stringify` + `writeFileSync`
 * between Enter and the first frame, paid twice a turn, on a slow disk much worse.
 *
 * The session object is the same reference every time, so the last call is the one worth writing. `serialize` runs
 * inside the scheduled callback, never at call time, so the bytes written always describe the session as it is when
 * the write happens.
 */
export function saveSessionSoon(session, storeDir) {
  if (!session || !session.id) return session;
  // Update the timestamp NOW so the object a caller reads back is already stamped — the same
  // guarantee the synchronous version gave.
  session.updatedAt = Date.now();
  pendingSave = { session, storeDir };
  // A SHORT DELAY, NOT THE NEXT TICK.
  //
  // `setImmediate` coalesced calls made in one tick, which is not what a turn looks like: a turn's saves are spread
  // across seconds (one per step boundary, then the turn end), so every one of them ran a full `JSON.stringify` plus
  // write on the main thread — 17-38 ms each on a real session, and each one is a frame the user sees stop.
  //
  // Nothing reads a session file while the program is running: `loadSession` is called at startup and from `/sessions`,
  // both by the same process that already holds the live object. So the file only has to be CURRENT ENOUGH for a crash,
  // and a few seconds of coalescing costs at most the last couple of steps of a session that died — against a stall the
  // user pays on every single turn.
  //
  // `flushSaves` (exit) and `saveSession` (callers that need the bytes now) still write immediately.
  if (!pendingScheduled) {
    pendingScheduled = true;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      pendingScheduled = false;
      const job = pendingSave;
      pendingSave = null;
      if (job) writeSessionSync(job.session, job.storeDir);
    }, SAVE_DELAY_MS);
    // The timer must not hold the process open by itself.
    if (saveTimer.unref) saveTimer.unref();
  }
  return session;
}

/** Write any queued save NOW and wait for it. For exit paths, where there is no next tick. */
export function flushSaves() {
  const job = pendingSave;
  pendingSave = null;
  pendingScheduled = false;
  // The timer would fire into an empty queue anyway; clearing it keeps the process from lingering for its sake.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (job) writeSessionSync(job.session, job.storeDir);
}

/**
 * Save the session, synchronously. The file is on disk when this returns.
 *
 * Kept as the default because that is its documented contract and callers rely on it — reading the file straight
 * back, listing sessions right after a rename, and asserting on a write failure all need the bytes to be there. The
 * per-turn path uses `saveSessionSoon` instead; see it for why that matters on a large session.
 */
export function saveSession(session, storeDir) {
  return writeSessionSync(session, storeDir);
}

/** Save synchronously. Only for callers that cannot wait for the next tick (exit). */
export function saveSessionNow(session, storeDir) {
  return writeSessionSync(session, storeDir);
}

// The most recent save failure, or null. Set once per failure so a caller can report it
// (the TUI shows a warning) without this module reaching into the UI.

/** The last save failure `{ at, id, detail }`, or null when saving has been clean. */
export function lastSaveFailure() { return saveFailure; }
/** Clear the recorded failure, after a save has succeeded. */
export function clearSaveFailure() { saveFailure = null; }

export function loadSession(id, storeDir) {
  const file = sessionFile(id, storeDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT is "no such session" (normal). Anything else is a real read error.
    if (e && e.code !== 'ENOENT') logSessionError('load', `${id}: ${e.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // FIX: a corrupt file is NOT the same as a missing session. Log it so the
    // user can find the damaged file instead of silently "losing" the session.
    logSessionError('parse', `${id}: ${e.message} (file: ${file})`);
    return null;
  }
}

// Most recent session for a workspace, or globally.
// `opts.skipEmpty` ignores sessions with no messages: hncode creates an empty
// session shell on every launch, so without this `--continue` would "resume"
// a brand-new empty session instead of the user's last real conversation.
//
// Only metadata is read (see readSessionMeta): the full parse was 370 ms on 40
// realistic sessions, pure waste since the caller needs a title and a timestamp.
export function latestSession(cwd, storeDir, opts = {}) {
  const entries = scanCached(storeDir);
  const wantWs = cwd !== undefined ? path.resolve(cwd) : null;
  let best = null;          // { meta, file }
  let bestEmpty = null;
  const stamp = (m) => (m && (m.updatedAt || m.createdAt)) || 0;
  for (const { meta, hasMessages, file } of entries) {
    if (wantWs !== null && meta.workspace !== wantWs) continue;
    const up = stamp(meta);
    if (!best || up > stamp(best.meta)) best = { meta, file };
    // hasMessages comes from the same cache entry (single head-read per file),
    // so we do not reopen anything to test emptiness.
    if (hasMessages && (!bestEmpty || up > stamp(bestEmpty.meta))) bestEmpty = { meta, file };
  }
  const pick = opts.skipEmpty ? (bestEmpty || best) : best;
  if (!pick) return null;
  // The caller wants a usable session, so load the chosen one in full — one file,
  // not forty.
  const loaded = loadSession(pick.meta.id || path.basename(pick.file, '.json'), storeDir);
  if (loaded) return loaded;
  // If the full load failed (corrupt), fall back to the metadata we already have
  // so the caller still gets an id/title/workspace instead of null.
  return pick.meta;
}

// Enumerate the session directory, reading each file's metadata head ONCE per
// file per process (cached). Repeated calls — listSessions then latestSession,
// or the /sessions picker — reuse the parsed metadata instead of re-opening
// every file. Entries are deleted from the cache when saveSession/deleteSession
// touches that file, and stale paths are pruned here when the directory shrinks.
// Returns [{ file, meta, hasMessages }].
function scanCached(storeDir) {
  const d = dir(storeDir);
  const map = cacheFor(storeDir);
  let names;
  try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { map.clear(); return []; }
  // Prune cached paths that no longer exist on disk.
  const live = new Set(names);
  for (const p of map.keys()) if (!live.has(path.basename(p))) map.delete(p);
  // Read only the files we have not cached yet.
  const out = [];
  for (const f of names) {
    const full = path.join(d, f);
    let got = map.get(full);
    if (!got) {
      got = _readMetaOnce(full);
      if (got) map.set(full, got);
    }
    if (got) out.push({ file: full, meta: got.meta, hasMessages: got.hasMessages });
  }
  return out;
}

// Read ONLY a session's metadata (id/title/workspace/timestamps), never its
// messages — and never the whole FILE. Two costs had to go:
//   * `JSON.parse` of the entire session: listing 40 realistic sessions measured
//     528 ms, `--continue` 370 ms, to read a title and a date;
//   * even `readFileSync` of the whole file: a session with a long transcript is
//     megabytes, and pulling it into a string is itself the stall.
//
// FIX: the previous version scanned for the bare `"messages"` key and stopped,
// which is wrong in two ways:
//   1. it assumes no metadata follows messages, but saveSession USED TO append
//      `updatedAt` after `messages` (object key insertion order), so updatedAt
//      was never seen and every session sorted as 0;
//   2. it cut the head mid-key, so the JSON.parse fixup was fragile.
// Now we stop at `"messages": [` (the array VALUE), not the key, so any key
// between the metadata block and the messages array is still included.
//
// Returns null when the file is not a readable session.
const META_HEAD_BYTES = 64 * 1024;
const META_MAX_BYTES = 4 * 1024 * 1024;   // give up rather than scan a giant file

export function readSessionMeta(file) {
  const res = _readMetaOnce(file);
  return res ? res.meta : null;
}

// Metadata for `file`, plus whether it holds any message. Reads the file head
// ONE time: latestSession needs both the timestamp (to sort) and the
// non-empty rule (for --continue's skipEmpty). Doing them in two passes —
// readSessionMeta then hasMessages — opened every candidate file twice.
// Returns { meta, hasMessages } or null.
function _readMetaOnce(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(META_HEAD_BYTES);
    let text = '';
    let read = 0;
    let cut = -1;
    // Grow in chunks until the `"messages"` VALUE starts, or the cap is hit.
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      if (n <= 0) break;
      text += buf.toString('utf8', 0, n);
      read += n;
      cut = findMessagesValueStart(text);
      if (cut >= 0 || read >= META_MAX_BYTES) break;
    }
    // Non-empty check from the SAME buffered head: true when a real "role" line
    // follows the messages-array opening. Mirrors hasMessages().
    const nonEmpty = !!(cut >= 0 && /"role"/.test(text.slice(cut)));
    // Take everything BEFORE the messages array (which is the metadata block),
    // then close the truncated JSON object.
    const head = cut > 0 ? text.slice(0, cut) : text;
    try {
      // `head` ends right after `"messages":` (no value), so append `[]}` to
      // close it cleanly. Also handle the case where the array value already
      // started but the head stops elsewhere.
      const json = head.replace(/,\s*$/, '').replace(/"messages"\s*:\s*$/, '"messages": []')
        + (head.trimEnd().endsWith('{') || head.trimEnd().endsWith(',') ? '}' : '}');
      const parsed = JSON.parse(json);
      delete parsed.messages;
      return { meta: parsed, hasMessages: nonEmpty };
    } catch {
      // Fallback: parse as much of the file as we have, drop messages.
      try {
        const m = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
        delete m.messages;
        return { meta: m, hasMessages: nonEmpty };
      } catch {
        // Neither parse can work here, and the reason is structural rather than
        // corrupt: the cap was hit before the `"messages"` key, so `text` stops
        // inside some earlier value. That is what a session carrying a large
        // `transcript` looked like while `serializableSession` wrote it ahead of
        // `messages` — and returning null for it made the file UNLISTABLE, so a
        // perfectly intact session silently disappeared from /sessions and from
        // `--continue`. The metadata is all at the front and every field a listing
        // needs is a top-level scalar, so read those directly instead of giving up.
        const meta = scanMetaHead(text);
        // `hasMessages` is taken as true here on purpose. Reaching the cap without
        // seeing the `"messages"` key means some earlier value was megabytes long, and
        // the only value that grows like that is a transcript — which a session only
        // accumulates by having had a conversation. Reading it as empty instead would
        // make `--continue --skipEmpty` pass over a session full of real work.
        if (meta) return { meta, hasMessages: true };
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Locate the index of the character right after `"messages"` (whitespace and
// the `:` included) so the metadata head can be closed with `"messages": []}`.
// Returns -1 when the key is not present in `text`.
function findMessagesValueStart(text) {
  const key = text.indexOf('"messages"');
  if (key < 0) return -1;
  let i = key + '"messages"'.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === ':') i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;   // may point at `[` (or be end-of-text; caller handles both)
}

// The metadata a LISTING needs, read out of a head that stopped mid-value.
//
// Only top-level keys are taken, and only while the scanner is at depth 1: a `"title"`
// nested inside a todo or a transcript row must never be mistaken for the session's own.
// The values pulled out are strings and numbers, so the scan can step over an oversized
// value with `skipJsonValue` instead of trying to read it.
const HEAD_SCALAR_KEYS = new Set([
  'id', 'title', 'workspace', 'model', 'createdAt', 'updatedAt',
  'rounds', 'steps', 'lastTurnMs', 'forkedFrom',
]);

function scanMetaHead(text) {
  const out = {};
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') { depth--; i++; continue; }
    if (c !== '"') { i++; continue; }
    const key = readJsonString(text, i);
    if (!key) return Object.keys(out).length ? out : null;
    i = key.end;
    // Only a KEY of the root object counts, and only when a colon follows.
    if (depth !== 1) {
      const skip = skipJsonValue(text, i);
      if (skip < 0) return Object.keys(out).length ? out : null;
      i = skip;
      continue;
    }
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ':') {
      const skip = skipJsonValue(text, i);
      if (skip < 0) return Object.keys(out).length ? out : null;
      i = skip;
      continue;
    }
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (HEAD_SCALAR_KEYS.has(key.value)) {
      if (text[j] === '"') {
        const s = readJsonString(text, j);
        if (!s) return Object.keys(out).length ? out : null;
        out[key.value] = s.value;
        i = s.end;
      } else {
        let k = j;
        while (k < text.length && !',}]\n'.includes(text[k])) k++;
        const n = Number(text.slice(j, k).trim());
        if (Number.isFinite(n)) out[key.value] = n;
        i = k;
      }
      continue;
    }
    const skip = skipJsonValue(text, j);
    if (skip < 0) return Object.keys(out).length ? out : null;
    i = skip;
  }
  return Object.keys(out).length ? out : null;
}

// A JSON string literal starting at `at` (which must be the opening quote), decoded.
// Returns { value, end } with `end` past the closing quote, or null when the literal
// runs off the end of `text` — the normal case for a value the head cap cut in half.
function readJsonString(text, at) {
  let i = at + 1;
  let raw = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === undefined) return null;
      if (n === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        raw += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      raw += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      i += 2;
      continue;
    }
    if (c === '"') return { value: raw, end: i + 1 };
    raw += c;
    i++;
  }
  return null;
}

// Step over one JSON value starting at `at`, returning the index just past it, or -1
// when the value is not complete in `text`. Strings and containers are both handled, so
// an oversized array is crossed without building it.
function skipJsonValue(text, at) {
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return -1;
  const c = text[i];
  if (c === '"') {
    const s = readJsonString(text, i);
    return s ? s.end : -1;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        const s = readJsonString(text, i);
        if (!s) return -1;
        i = s.end - 1;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  // A literal (number, true/false/null): up to the next delimiter.
  let k = i;
  while (k < text.length && !',}]'.includes(text[k])) k++;
  return k > i ? k : -1;
}

// Non-empty detection now lives in _readMetaOnce (it reads the file head once
// for both the metadata and the emptiness rule), so the old separate
// hasMessages() scan is gone — latestSession no longer reopens each candidate.

// The session list for the /sessions picker. Metadata only — see readSessionMeta
// for why. Entries carry no `messages`, which every caller already treats as
// "not loaded yet".
export function listSessions(storeDir) {
  const out = [];
  for (const { meta } of scanCached(storeDir)) {
    // FIX: fall back to createdAt so a legacy session written with a
    // post-messages updatedAt still sorts reasonably instead of as 0.
    if (!meta.updatedAt && meta.createdAt) meta.updatedAt = meta.createdAt;
    out.push(meta);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export function deleteSession(id, storeDir) {
  // Drop the cached entry if present (before unlink, so the path is known).
  try { cacheFor(storeDir, false)?.delete(sessionFile(id, storeDir)); } catch {}
  try { fs.unlinkSync(sessionFile(id, storeDir)); return true; } catch { return false; }
}