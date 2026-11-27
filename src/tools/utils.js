// Shared helpers for the hncode toolbelt.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { recordBeforeWrite } from '../file-history.js';

export const MAX_OUTPUT_BYTES = 128 * 1024; // cap tool results to avoid token blowup

export function truncateBuf(buf) {
  if (Buffer.isBuffer(buf)) {
    if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString('utf8');
    return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + `\n...[truncated ${buf.length - MAX_OUTPUT_BYTES} bytes]`;
  }
  const s = String(buf);
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  // The cap is a BYTE budget, but `s.length` is UTF-16 code units. Slicing by
  // code units both under-counts non-ASCII (a 3-byte CJK char costs 1 unit)
  // and can split a surrogate pair, emitting a lone half. Truncate by BYTES
  // and back off to the nearest code-point boundary.
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= MAX_OUTPUT_BYTES) return s;
  const cut = Buffer.from(s, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
  // A trailing lone surrogate (from a split pair) is dropped by decoding; the
  // replacement char U+FFFD at the tail is also stripped so the marker is clean.
  const safe = cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
  return safe + `\n...[truncated ${bytes - MAX_OUTPUT_BYTES} bytes]`;
}

// Expand ~ and map Git-Bash /c/x -> C:\x style paths, then resolve against cwd.
export function normalizeInput(p) {
  let s = String(p);
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  // Windows only: under Git Bash an agent writes `/d/hncode/src` for `D:\hncode\src`.
  // Gated on the platform because on Linux `/c/x` is a perfectly ordinary absolute
  // path, and rewriting it to `C:\x` turned it into a relative garbage filename.
  if (process.platform === 'win32') {
    const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) return path.join(`${m[1].toUpperCase()}:\\`, ...m[2].split('/'));
  }
  return s;
}

export function resolvePath(input, ctx) {
  const raw = normalizeInput(input);
  let p = path.resolve(ctx.cwd || ctx.workspace, raw);
  try { p = fs.realpathSync(p); } catch {} // resolve symlinks if present
  const ws = path.resolve(ctx.cwd || ctx.workspace);
  if (!ctx.allowExternal) {
    let rel = path.relative(ws, p);
    if (rel === '') return p;
    // ESCAPE check, not a prefix check: the first path segment must not be `..`.
    // A plain startsWith('..') also rejected files INSIDE the workspace whose
    // names merely begin with dots — `..notes.md` — while `...` / `..a` are
    // legitimate relative names that stay below the root.
    if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) {
      throw new Error(`Path outside workspace: ${input}. Run hncode from that directory or set HNCODE_ALLOW_EXTERNAL=1.`);
    }
  }
  return p;
}

export function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Checkpoint `p` before a write tool modifies it, so /undo can put it back (see
// file-history.js). The record is taken ONCE per turn, so what is captured is the
// file as it stood before ANY of this turn's changes — the state the user would
// expect "Undid 1 prompt" to restore.
//
// ctx.sessionId identifies the checkpoint store. A caller without one (a
// subagent's own context, a test) simply gets no checkpoint rather than an error:
// losing the safety net must never fail the actual write.
export function checkpointBeforeWrite(p, ctx) {
  if (!ctx || !ctx.sessionId) return false;
  try { return recordBeforeWrite(ctx.sessionId, p); } catch { return false; }
}

// Read a file fully, returning its string. Throws if not a file.
export function readFileBytes(p) {
  const st = fs.statSync(p);
  if (!st.isFile() && !st.isFIFO()) throw new Error(`Not a file: ${p}`);
  return fs.readFileSync(p);
}

// Visible width ignoring ANSI escapes (approx).
export function visibleWidth(s) {
  return (s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

export function isProbablyTextFile(buf) {
  // Treat as text if mostly printable ASCII/UTF-8 and few NULs.
  if (buf.length === 0) return true;
  let nulls = 0;
  for (let i = 0; i < Math.min(buf.length, 8192); i++) if (buf[i] === 0) nulls++;
  if (nulls > 0) return false;
  let bad = 0;
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    const b = buf[i];
    if (b < 9 || (b > 13 && b < 32) || b > 254) bad++;
  }
  return bad / Math.min(buf.length, 8192) < 0.10;
}




export function similarFileHint(missingPath) {
  const dir = path.dirname(missingPath);
  const base = path.basename(missingPath);
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return ''; }
  const lower = base.toLowerCase();
  // Levenshtein distance, capped — enough to catch a typo (confg -> config).
  const lev = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  };
  let cand = entries.find((e) => e.toLowerCase() === lower);
  if (!cand) {
    let best = null, bestD = 3;
    for (const e of entries) {
      const d = lev(stem, e.replace(/\.[^.]*$/, '').toLowerCase());
      if (d < bestD) { bestD = d; best = e; }
    }
    cand = best;
  }
  if (cand && cand !== base) return ` Did you mean "${path.join(dir, cand)}"?`;
  return '';
}


