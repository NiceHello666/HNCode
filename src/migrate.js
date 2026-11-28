// Export and import every piece of hncode state a person would want on another machine.
//
// WHAT TRAVELS AND WHAT DOES NOT
// ------------------------------
// The distinction is not size, it is MEANING. A session or a skill is something the user made; a paint log or a Chromium
// cache is something this machine produced on their behalf and can produce again. So the list is explicit rather than
// "everything under ~/.hncode", which would ship 174 MB of paint.log and 16 MB of browser profile.
//
// CROSS-MACHINE PATHS
// -------------------
// A session records `workspace` as an absolute path, and one saved on another machine points at a directory that does not
// exist here. The import therefore does not silently keep it: it either keeps the old path (for a machine with the same
// layout) or maps it onto a directory the user names. `tool-results` is dropped for the same reason — those files are
// referred to by absolute path from inside session histories, so copying the directory alone would leave every pointer
// aimed at a path that no longer exists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { INDEX_ENTRY, renderIndex, parseIndex, mapPath } from './migrate-index.js';

/** The root every path here is relative to. `HNCODE_HOME` wins, like everywhere else in the program. */
// The last four bytes of an archive. Latin-1 rather than UTF-8 so a reader does not have to agree with a decoder about
// how many bytes a character took — this is a tag, not text.
export const MARKER = 'HNB1';

export function hncodeHome() {
  return process.env.HNCODE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.hncode');
}

/**
 * What a migration carries.
 *
 * `dir` entries are copied whole; `file` entries only when they exist. `config*.toml*` is matched by pattern so the
 * rolling backups a user may want to come back to travel with the live file.
 */
export const PORTABLE = [
  { name: 'config.toml', kind: 'file', what: 'settings, providers, models' },
  { name: 'config.toml.backup', kind: 'file', what: 'previous settings' },
  { name: 'sessions', kind: 'dir', what: 'conversations' },
  { name: 'history.json', kind: 'file', what: 'prompt history' },
  { name: 'history', kind: 'dir', what: 'prompt history, per session' },
  { name: 'MEMORY.md', kind: 'file', what: 'agent memory' },
  { name: 'PERSONAL.md', kind: 'file', what: 'personal preferences' },
  { name: 'mcp.json', kind: 'file', what: 'MCP servers' },
  { name: 'skills', kind: 'dir', what: 'installed skills' },
  { name: 'plugins', kind: 'dir', what: 'installed plugins' },
  { name: 'teams', kind: 'dir', what: 'team rosters' },
  { name: 'file-history', kind: 'dir', what: 'snapshots for /undo' },
];

/** Entries that are deliberately left behind, with the reason, so a report can say why. */
export const EXCLUDED = [
  { name: 'browser-profile', why: 'the plugin browser\'s Chromium profile — machine-local, rebuilt on use' },
  { name: 'tool-results', why: 'spilled tool output, addressed by absolute paths from inside the sessions' },
  { name: '*.log', why: 'debug logs (paint.log alone is over 170 MB)' },
  { name: 'teleport', why: 'sessions already exported as standalone files' },
];

/** Every config backup this machine has, since `/reload` can restore one. */
function configBackups(home) {
  try {
    return fs.readdirSync(home)
      .filter((f) => /^config\.toml\.(bak.*|backup)$/.test(f))
      .map((f) => ({ name: f, kind: 'file', what: 'settings backup' }));
  } catch { return []; }
}

/** Size of a file or a directory tree, in bytes, without following symlinks. */
export function sizeOf(p) {
  let total = 0;
  const walk = (q) => {
    let st;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(q); } catch { return; }
      for (const e of entries) walk(path.join(q, e));
    } else {
      total += st.size;
    }
  };
  walk(p);
  return total;
}

/** Human-readable bytes, at the precision a migration report needs. */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * What an export WOULD include: one entry per portable item that exists, with its size.
 *
 * Returned rather than printed so a caller can show a summary before writing anything — a 190 MB archive is worth
 * confirming.
 */
export function planExport(home = hncodeHome()) {
  const items = [];
  const all = [...PORTABLE, ...configBackups(home)];
  const seen = new Set();
  for (const item of all) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    const p = path.join(home, item.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (item.kind === 'dir' && !st.isDirectory()) continue;
    if (item.kind === 'file' && !st.isFile()) continue;
    items.push({ ...item, size: sizeOf(p) });
  }
  return items;
}


/**
 * Write a migration archive.
 *
 * FORMAT: a one-line JSON manifest followed by a newline, then every file's bytes back to back. No dependency, no
 * compression, and the manifest is readable with `head -1` — which matters when the only thing available on the target
 * machine is the hncode that is not installed yet.
 *
 *   {"version":1,"createdAt":...,"home":...,"items":[{name,kind,size}],"files":[{path,size,offset}]}
 *   <bytes><bytes><bytes>…
 *
 * `offset` is absolute from the start of the file, so a reader can seek straight to one entry without walking the rest.
 *
 * @param {string} out   path to write
 * @param {object} [opts] `home`, `items` (from planExport), `onProgress(done, total, name)`
 * @returns {{path: string, files: number, bytes: number, items: object[]}}
 */
/**
 * Write a migration archive.
 *
 * FORMAT: the files' bytes back to back, then a JSON manifest, then an 8-byte little-endian length and the marker
 * `HNB1`. The manifest goes LAST on purpose — its offsets are from the start of the file, so writing it first would
 * mean knowing every size before a single byte was copied, and padding the numbers to a guessed width so the header
 * length could not move. Writing it last makes both problems disappear.
 *
 *       <file bytes><file bytes>…<manifest json><8-byte length><HNB1>
 *
 * @param {string} out   path to write
 * @param {object} [opts] `home`, `items` (from planExport), `onProgress(done, total, name)`
 * @returns {{path: string, files: number, bytes: number, items: object[]}}
 */
export function writeArchive(out, opts = {}) {
  const home = opts.home || hncodeHome();
  const items = opts.items || planExport(home);
  const files = [];
  const collect = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(abs); } catch { return; }
      for (const e of entries) collect(path.join(abs, e), rel ? rel + '/' + e : e);
    } else if (st.isFile()) {
      files.push({ abs, rel, size: st.size });
    }
  };
  for (const item of items) collect(path.join(home, item.name), item.name);

  // THE INDEX TRAVELS AS AN ORDINARY ENTRY, so it can be extracted and edited with nothing but a text editor. It is
  // built from the sessions that were just collected rather than from a second walk of the store.
  const sessionIndex = [];
  for (const f of files) {
    const m = /^sessions\/([^/]+)\.json$/.exec(f.rel);
    if (!m) continue;
    let meta = { id: m[1], title: '', workspace: '' };
    try {
      // The file is small enough to read whole here — this is the export, not a frame.
      const s = JSON.parse(fs.readFileSync(f.abs, 'utf8'));
      meta = { id: s.id || m[1], title: s.title || '', workspace: s.workspace || '' };
    } catch { /* a session that will not parse is still listed by id */ }
    sessionIndex.push({ ...meta, file: f.rel });
  }
  const indexBody = Buffer.from(renderIndex({
    home,
    createdAt: opts.createdAt || Date.now(),
    mapping: opts.mapping || [],
    sessions: sessionIndex,
  }), 'utf8');
  files.unshift({ abs: null, rel: INDEX_ENTRY, size: indexBody.length, body: indexBody });

  const fd = fs.openSync(out, 'w');
  let offset = 0;
  const records = [];
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      records.push({ path: f.rel, size: f.size, offset });
      // A GENERATED ENTRY HAS ITS BYTES IN MEMORY. `index.yml` is not on disk to read from, so it is written
      // straight from the buffer the caller handed over; everything else streams from its file.
      if (f.body) {
        fs.writeSync(fd, f.body, 0, f.body.length);
        offset += f.body.length;
        if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, files.length, f.rel);
        continue;
      }

      const src = fs.openSync(f.abs, 'r');
      try {
        let left = f.size;
        let pos = 0;
        while (left > 0) {
          const n = fs.readSync(src, buf, 0, Math.min(buf.length, left), pos);
          if (n <= 0) break;
          fs.writeSync(fd, buf, 0, n);
          pos += n;
          left -= n;
          offset += n;
        }
      } finally {
        fs.closeSync(src);
      }
      if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, files.length, f.rel);
    }

    const manifest = Buffer.from(JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      home,
      items: items.map((i) => ({ name: i.name, kind: i.kind, size: i.size })),
      files: records,
    }), 'utf8');
    fs.writeSync(fd, manifest);
    const tail = Buffer.alloc(12);
    tail.writeBigUInt64LE(BigInt(manifest.length), 0);
    tail.write(MARKER, 8, 'latin1');
    fs.writeSync(fd, tail);
    offset += manifest.length + tail.length;
  } finally {
    fs.closeSync(fd);
  }
  return { path: out, files: files.length, bytes: offset, items };
}

/**
 * Read an archive's manifest without extracting anything.
 *
 * Used to SHOW the user what they are about to import, and to refuse a file that is not one of ours before anything is
 * written over their state.
 */
/**
 * Read an archive's manifest without extracting anything.
 *
 * The manifest is the last thing in the file, immediately before a 12-byte tail holding its length and the marker, so
 * it is found by seeking to the end rather than by scanning.
 */
export function readArchiveManifest(from) {
  const fd = fs.openSync(from, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 12) throw new Error('not a hncode archive: too short');
    const tail = Buffer.alloc(12);
    fs.readSync(fd, tail, 0, 12, size - 12);
    if (tail.subarray(8).toString('latin1') !== MARKER) throw new Error('not a hncode archive: the end marker is missing');
    const len = Number(tail.readBigUInt64LE(0));
    if (!Number.isFinite(len) || len <= 0 || len > size - 12) throw new Error('not a hncode archive: the manifest length is wrong');
    const body = Buffer.alloc(len);
    fs.readSync(fd, body, 0, len, size - 12 - len);
    let m;
    try { m = JSON.parse(body.toString('utf8')); } catch { throw new Error('not a hncode archive: the manifest is not JSON'); }
    if (!m || m.version !== 1 || !Array.isArray(m.files)) throw new Error('not a hncode archive: unsupported version');
    return { manifest: m };
  } finally {
    fs.closeSync(fd);
  }
}


/**
 * Extract an archive into a hncode home.
 *
 * SAFE BY DEFAULT. Nothing is overwritten unless `overwrite` is set: an existing session with the same id is kept and
 * reported, because importing is often "bring my other machine's history in beside this one", not "replace it".
 *
 * PATH REWRITING. A session stores its `workspace` as an absolute path. Imported from another machine that path almost
 * certainly does not exist here, and leaving it means every session opens onto a directory that is not there. Two
 * choices, both explicit:
 *
 *   `workspace: "/some/dir"`  every imported session is pointed at that directory
 *   omitted                   the original paths are kept (right for a machine with the same layout)
 *
 * Only `workspace` is rewritten. Everything else a session holds — messages, tool arguments, todos — is conversation,
 * and rewriting paths inside it would corrupt what the model was told.
 *
 * @param {string} from archive path
 * @param {object} [opts] `home`, `overwrite`, `workspace`, `dryRun`, `onProgress(done, total, path)`
 * @returns {{written: number, skipped: number, bytes: number, sessionsRewritten: number, errors: string[]}}
 */
export function readArchive(from, opts = {}) {
  const home = opts.home || hncodeHome();
  const { manifest } = readArchiveManifest(from);
  const result = {
    written: 0, skipped: 0, bytes: 0, sessionsRewritten: 0, errors: [],
    indexFound: false, mapped: 0,
  };
  // `--workspace` still wins when given: it is the blunt "put everything here" the user typed on this command line.
  const rewriteTo = typeof opts.workspace === 'string' && opts.workspace.trim() ? path.resolve(opts.workspace.trim()) : null;

  const fd = fs.openSync(from, 'r');
  const readEntry = (f) => {
    const buf = Buffer.allocUnsafe(Math.max(1, f.size));
    let read = 0;
    while (read < f.size) {
      const n = fs.readSync(fd, buf, read, f.size - read, f.offset + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  };
  try {
    // THE INDEX IS READ FIRST, because it decides where every session lands. It travels as an ordinary entry, so a
    // person can extract it, correct the paths and put it back — or hand `--index <file>` an edited copy from outside.
    let index = null;
    if (opts.index !== false) {
      const entry = manifest.files.find((f) => f.path === INDEX_ENTRY);
      if (entry) {
        try {
          index = parseIndex(readEntry(entry).toString('utf8'));
          result.indexFound = !!index;
        } catch { /* a damaged index must not stop the import */ }
      }
      if (typeof opts.indexFile === 'string' && opts.indexFile.trim()) {
        try { index = parseIndex(fs.readFileSync(path.resolve(opts.indexFile.trim()), 'utf8')); result.indexFound = !!index; }
        catch (e) { result.errors.push(`could not read --index file: ${(e && e.message) || e}`); }
      }
    }
    const mapping = (index && index.mapping) || [];

    for (const f of manifest.files) {
      // A path in the manifest is data from a file, so it is checked before it is joined to anything: an entry holding
      // `..` would otherwise write outside the hncode home.
      const rel = String(f.path || '');
      if (!rel || rel.startsWith('/') || rel.includes('..') || /^[A-Za-z]:/.test(rel)) {
        result.errors.push(`refused an unsafe path: ${rel}`);
        continue;
      }
      const dest = path.join(home, rel);
      const isSession = /(^|\/)sessions\/[^/]+\.json$/.test(rel);
      if (!opts.overwrite && fs.existsSync(dest)) { result.skipped++; continue; }
      if (opts.dryRun) {
        result.written++;
        result.bytes += f.size;
        if (isSession && (rewriteTo || mapping.length)) result.sessionsRewritten++;
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = readEntry(f);
      // A SESSION IS REWRITTEN, NOT COPIED VERBATIM — its `workspace` is an absolute path from another machine.
      if (isSession && (rewriteTo || mapping.length)) {
        try {
          const s = JSON.parse(buf.toString('utf8'));
          if (s && typeof s === 'object') {
            if (rewriteTo) {
              s.workspace = rewriteTo;
              if (s.cwd) s.cwd = rewriteTo;
            } else {
              const before = s.workspace;
              if (s.workspace) s.workspace = mapPath(s.workspace, mapping);
              if (s.cwd) s.cwd = mapPath(s.cwd, mapping);
              if (s.workspace && s.workspace !== before) result.mapped++;
            }
            const out = Buffer.from(JSON.stringify(s), 'utf8');
            fs.writeFileSync(dest, out);
            result.written++;
            result.bytes += out.length;
            result.sessionsRewritten++;
            if (typeof opts.onProgress === 'function') opts.onProgress(result.written, manifest.files.length, rel);
            continue;
          }
        } catch { /* not JSON we can rewrite; fall through and copy it as-is */ }
      }
      fs.writeFileSync(dest, buf);
      result.written++;
      result.bytes += buf.length;
      if (typeof opts.onProgress === 'function') opts.onProgress(result.written, manifest.files.length, rel);
    }
  } finally {
    fs.closeSync(fd);
  }
  return result;
}
