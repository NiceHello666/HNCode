// Read tool — mirrors the hncode Read tool schema & behavior.

import fs from 'node:fs';
import { resolvePath, isProbablyTextFile } from './utils.js';

// Normalize newlines so a text file's hash is stable regardless of CRLF/LF.
export function normalizeText(s) {
  return String(s).split(/\r\n|\r|\n/).join('\n');
}
// FNV-1a-ish 32-bit hash of a string (cheap, deterministic).
export function hashStr(s) {
  const str = normalizeText(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
// Hash the exact <start..end> 1-based line slice of `lines`.
function hashLines(lines, start, end) {
  const slice = (lines.slice(start - 1, end) || []).join('\n');
  return hashStr(slice);
}
// Public alias so edit.js (and the line-range path) share ONE implementation.
export const hashRegion = hashLines;

// Reset the Read snapshot pool after files were rewound on disk. The pool holds
// per-file content hashes plus the line regions the model has "seen"; once /undo
// has put an older version back, every hash in it describes content that is no
// longer there. Keeping them made the NEXT Edit fail with a staleness rejection
// against a file the model had just watched being restored.
export function forgetReadPool(ctx) {
  if (ctx && ctx.readPool && typeof ctx.readPool.clear === 'function') ctx.readPool.clear();
}
export const spec = {
  name: 'Read',
  description: 'Read a text file. With no line arguments it returns the whole file; pass start_line and '
    + 'end_line for a range. BOTH BOUNDS ARE INCLUSIVE: start_line=3, end_line=5 returns THREE lines — 3, 4 '
    + 'and 5. A negative start_line counts from the end (-100 = the last 100 lines). Every returned line is '
    + 'prefixed with its 1-based number.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the text file.' },
      start_line: {
        type: 'integer',
        description: '1-based FIRST line to return, INCLUSIVE — it is a line that is returned, not the line '
          + 'before the first one. Omit to start at the first line, or pass a negative value to count from the '
          + 'end (-100 = last 100 lines).',
      },
      end_line: { type: 'integer', minimum: 1, description: '1-based LAST line to return, INCLUSIVE — it is a line that is returned, not the line after the last one. start_line=3, end_line=5 returns lines 3, 4 and 5. Omit to read to the end of the file.' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    // A missing `path` used to reach resolvePath(undefined), which resolves to the
    // workspace ROOT — so the failure surfaced as an EISDIR from fs.readFileSync
    // instead of "you forgot the path". Cheap to check, and it tells the model
    // exactly what to fix.
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return 'Error: `path` is required and must be a non-empty string.';
    }
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    let buf;
    try { buf = fs.readFileSync(p); } catch (e) { return `Error reading ${args.path}: ${e.message}`; }
    if (!isProbablyTextFile(buf)) {
      return `Cannot read: ${args.path} appears to be a binary file (use a tool suited for binary).`;
    }
    let st = null;
    try { st = fs.statSync(p); } catch { /* stat is advisory only */ }
    // NO truncation: the caller asked for the file, so the whole file is returned
    // (line ranges still work via line_offset / n_lines). The old 1000-line and
    // 128 KB caps silently cut the content, which also corrupted the
    // staleness hashes recorded below because they were computed from the
    // TRUNCATED text rather than the file on disk.
    const text = buf.toString('utf8');
    // A FILE ENDING IN A NEWLINE HAS ONE FEWER LINE THAN `split` REPORTS.
    //
    // `"a\nb\n".split("\n")` is `["a", "b", ""]` — the trailing newline leaves an empty element, and
    // counting it made a ten-line file report `lines 1-11 of 11`. The numbers on each line were right;
    // the TOTAL was one too high, so a caller planning an edit at the end of the file aimed at a row that
    // does not exist.
    //
    // Only the element the trailing newline produced is dropped: a file that genuinely ends with a blank
    // line (`"a\n\n"`) keeps it, because that is real content.
    const lines = normalizeText(text).split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    // Default: every line. `start_line` / `end_line` narrow the window, and either may be omitted.
    let start = args.start_line !== undefined ? Number(args.start_line) : 1;
    if (start < 0) start = Math.max(1, total + 1 + start);
    start = Math.max(1, Math.min(start, total));
    const end = args.end_line !== undefined
      ? Math.min(Math.max(start, Number(args.end_line)), total)
      : total;
    let out = '';
    out += `${args.path} (lines ${start}-${end} of ${total})\n`;
    // THE NUMBER IS LEFT-ALIGNED AND PADDED ON THE RIGHT, not the other way round. `padStart` put the padding in
    // FRONT, so `1` arrived as `" 1"` and the gutter read as right-aligned. The tab after it is what aligns the
    // code, so all a number needs is to start in column 0.
    for (let i = start; i <= end; i++) out += `${i}\t${lines[i - 1]}\n`;
    // No trailing "truncated" banner: without an explicit end_line every line is returned, so the only way
    // to stop early is a deliberate range request — the header already states which lines those were.

    // --- Record a hash fingerprint so a later Edit can verify the AI is
    // editing against the same content it read (snippet-staleness guard). ---
    // Store the FULL file's normalized content hash plus this call's line
    // range + region hash. Edit compares old_string's location against these.
    if (ctx) {
      const pool = (ctx.readPool = ctx.readPool || new Map());
      let entry = pool.get(p);
      if (!entry) {
        entry = {
          mtimeMs: st ? st.mtimeMs : 0,
          size: st ? st.size : 0,
          fileHash: hashStr(text),
          lines: total,            // current total line count at read time
          regions: [],             // {start, end, hash} of each read slice
        };
        pool.set(p, entry);
      }
      entry.mtimeMs = st ? st.mtimeMs : entry.mtimeMs;
      entry.size = st ? st.size : entry.size;
      entry.fileHash = hashStr(text);
      entry.lines = total;
      // Record this call's exact region (only the lines actually returned).
      entry.regions.push({ start, end, hash: hashLines(lines, start, end) });
    }
    return out;
  },
};
