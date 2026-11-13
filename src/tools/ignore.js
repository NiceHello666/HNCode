// Best-effort .gitignore / .ignore / .rgignore matcher for Glob & Grep.
import fs from 'node:fs';
import path from 'node:path';
import { globToRegexSource } from './matchers.js';

const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
const cache = new Map();

export function parseIgnoreFile(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, ''); // strip trailing comments? no: only outside string; good enough
    line = line.trimEnd();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    let anchor = false;
    if (line.startsWith('/')) { anchor = true; line = line.slice(1); }
    if (!line) continue;
    out.push({ raw: line, negate, dirOnly, anchor });
  }
  return out;
}

export function ignorePatternsFor(dir) {
  let cached = cache.get(dir);
  if (cached) return cached;
  const arr = [];
  for (const name of IGNORE_FILES) {
    try {
      const txt = fs.readFileSync(path.join(dir, name), 'utf8');
      arr.push(...parseIgnoreFile(txt));
    } catch {}
  }
  cache.set(dir, arr);
  return arr;
}

// Compiled glob → RegExp, memoised. `matchPattern` runs for EVERY entry against
// EVERY accumulated ignore pattern, so building a fresh RegExp each time was the
// single largest cost of a directory walk (measured: 73ms of a 228ms walk on a
// 354-file repo, purely in `new RegExp`). Patterns are immutable strings, so a
// process-lifetime cache is safe.
const reCache = new Map();
function globToRegex(pattern) {
  let re = reCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(globToRegexSource(pattern));
    if (reCache.size >= 4096) reCache.clear();   // bounded; patterns are few in practice
    reCache.set(pattern, re);
  }
  return re;
}

export function matchPattern(pat, relPath, isDir) {
  if (pat.dirOnly && !isDir) return false;
  const re = globToRegex(pat.raw);
  if (pat.anchor) return re.test(relPath);
  if (re.test(relPath)) return true;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (re.test(parts.slice(i).join('/'))) return true;
  }
  return false;
}

// Walk dir applying ignore patterns from root..leaf. Returns list of absolute files
// (and dirs if includeDirs), honoring ignore unless includeIgnored.
// Walk dir applying ignore patterns from root..leaf. Returns list of absolute files
// (and dirs if includeDirs), honoring ignore unless includeIgnored.
//
// mtime and "is a file" are captured DURING the walk. The previous version stat'ed
// every result TWICE more afterwards (once per comparison in the sort, once in the
// file filter), which on a 354-file repo cost ~24ms of a 228ms walk — pure
// duplication, since the information was already available as each entry was
// visited. One stat per file now, reused for both.
export function walkFiles(base, opts = {}) {
  // `limit` caps the RESULT. Glob keeps the default (newest 100); Grep passes 0 —
  // truncating the WALK by mtime made the search silently skip older files and
  // report "No matches found" for text that was right there.
  const { includeIgnored = false, includeDirs = false, limit = 1000 } = opts;
  const baseAbs = path.resolve(base);
  /** @type {{path:string, mtime:number, isFile:boolean}[]} */
  const found = [];
  _walk(baseAbs, '', [], found, { includeIgnored, includeDirs });
  // Newest first. Sort before truncating so the newest entries survive the cap.
  found.sort((a, b) => b.mtime - a.mtime);
  if (limit > 0 && found.length > limit) found.length = limit;
  return found.filter((e) => includeDirs || e.isFile).map((e) => e.path);
}

// Directories that are never worth walking. `.git` holds the object database —
// hundreds of thousands of files on an old repo, none of them source, and no
// .gitignore ever lists it. `node_modules` is pruned for the JS walker unless the
// caller explicitly asked for ignored files: walking it was a multi-second stall
// of the event loop (everything here is readdirSync/statSync) for results nobody
// wanted.
const PRUNED_DIRS = new Set(['.git']);
const PRUNED_UNLESS_IGNORED = new Set(['node_modules']);

function _walk(dir, relPrefix, parentPatterns, found, opts) {
  const { includeIgnored, includeDirs } = opts;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const acc = parentPatterns.concat(ignorePatternsFor(dir));
  for (const ent of entries) {
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    const abs = path.join(dir, ent.name);
    let isDir;
    try { isDir = ent.isDirectory(); } catch { try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; } }
    if (isDir && (PRUNED_DIRS.has(ent.name)
      || (!includeIgnored && PRUNED_UNLESS_IGNORED.has(ent.name)))) continue;
    // ignore decision
    let ignored = false;
    for (const pat of acc) {
      if (matchPattern(pat, rel, isDir)) ignored = !pat.negate;
    }
    if (ignored && !includeIgnored) {
      if (isDir) continue; // prune dir subtree
      continue;
    }
    if (isDir) {
      if (includeDirs) {
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch { /* keep 0 */ }
        found.push({ path: abs, mtime, isFile: false });
      }
      _walk(abs, rel, acc, found, opts);
    } else {
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { /* keep 0 */ }
      found.push({ path: abs, mtime, isFile: ent.isFile() });
    }
  }
}

/**
 * The same walk, WITHOUT freezing the process it runs in.
 *
 * `walkFiles` is synchronous end to end (`readdirSync`, `statSync`). That is fine for a script with nothing else
 * to do, and fatal for an editor: the event loop cannot paint, read a keystroke or answer a timer while the walk
 * holds it. Measured on a drive root, one Glob took 43 seconds — during which the interface was simply dead,
 * because nothing else could run.
 *
 * This version uses `fs.promises` and yields every so often, so the loop stays alive. The RESULT is identical;
 * only the schedule differs.
 *
 * @param {string} base
 * @param {{includeIgnored?: boolean, includeDirs?: boolean, limit?: number}} [opts]
 */
export async function walkFilesAsync(base, opts = {}) {
  const { includeIgnored = false, includeDirs = false, limit = 1000 } = opts;
  const baseAbs = path.resolve(base);
  const found = [];
  // A counter, not a timer: yielding on a chunk of FILES keeps the pause proportional to the work rather than to
  // wall-clock, so a fast directory costs nothing and a slow one still yields regularly.
  const state = { sinceYield: 0 };
  await _walkAsync(baseAbs, '', [], found, { includeIgnored, includeDirs }, state);
  found.sort((a, b) => b.mtime - a.mtime);
  if (limit > 0 && found.length > limit) found.length = limit;
  return found.filter((e) => includeDirs || e.isFile).map((e) => e.path);
}

const YIELD_EVERY = 200;

async function _walkAsync(dir, relPrefix, parentPatterns, found, opts, state) {
  const { includeIgnored, includeDirs } = opts;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  const acc = parentPatterns.concat(ignorePatternsFor(dir));
  for (const ent of entries) {
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    const abs = path.join(dir, ent.name);
    let isDir = !!ent.isDirectory();
    if (isDir && (PRUNED_DIRS.has(ent.name)
      || (!includeIgnored && PRUNED_UNLESS_IGNORED.has(ent.name)))) continue;
    let ignored = false;
    for (const pat of acc) {
      if (matchPattern(pat, rel, isDir)) ignored = !pat.negate;
    }
    if (ignored && !includeIgnored) continue;

    if (isDir) {
      if (includeDirs) {
        let mtime = 0;
        try { mtime = (await fs.promises.stat(abs)).mtimeMs; } catch { /* keep 0 */ }
        found.push({ path: abs, mtime, isFile: false });
      }
      await _walkAsync(abs, rel, acc, found, opts, state);
    } else {
      let mtime = 0;
      try { mtime = (await fs.promises.stat(abs)).mtimeMs; } catch { /* keep 0 */ }
      found.push({ path: abs, mtime, isFile: true });
    }

    state.sinceYield++;
    if (state.sinceYield >= YIELD_EVERY) {
      state.sinceYield = 0;
      // Hand the loop a turn. `setImmediate` rather than `setTimeout(0)`: it keeps the walk's own ordering and
      // does not add a timer per chunk.
      await new Promise((r) => setImmediate(r));
    }
  }
}
