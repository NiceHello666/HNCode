// Grep tool — mirrors the hncode Grep tool schema & behavior.
// Primary path uses ripgrep (`rg`) for full fidelity; falls back to a pure-JS
// walker when rg is unavailable or multiline searching is requested.

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { isProbablyTextFile, truncateBuf, resolvePath } from './utils.js';
import { walkFilesAsync } from './ignore.js';
import { matchGlob } from './matchers.js';

export const spec = {
  name: 'Grep',
  description: 'Search file contents by regex. output_mode: content (default) | files_with_matches | count_matches. Honors ignore files unless include_ignored.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search (default: cwd).', default: '.' },
      glob: { type: 'string', description: 'Glob filter for which files are searched (e.g. *.ts).' },
      type: { type: 'string', description: 'File-type filter (ripgrep -t, e.g. ts, py, go).' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count_matches'], default: 'content', description: 'Matching lines, matching files, or per-file counts.' },
      '-i': { type: 'boolean', default: false, description: 'Case-insensitive search.' },
      '-n': { type: 'boolean', default: false, description: 'Prefix each match with its 1-based line number.' },
      '-A': { type: 'integer', minimum: 0, description: 'Lines of context after each match.' },
      '-B': { type: 'integer', minimum: 0, description: 'Lines of context before each match.' },
      '-C': { type: 'integer', minimum: 0, description: 'Lines of context around each match (alias for -A/-B).' },
      head_limit: { type: 'integer', minimum: 0, description: 'Limit output to the first N matches/lines.' },
      offset: { type: 'integer', minimum: 0, description: 'Leading matches/lines to skip.' },
      multiline: { type: 'boolean', default: false, description: 'Match across newlines.' },
      include_ignored: { type: 'boolean', default: false, description: 'Search ignored files too.' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    // Same workspace boundary as Read/Write/Edit. Grep resolved `path` directly,
    // so `Grep { pattern: 'KEY', path: 'C:/Users/...' }` searched any directory
    // on disk — the search tools had no gate at all.
    let base;
    try { base = resolvePath(args.path || '.', ctx); } catch (e) { return `Error: ${e.message}`; }
    if (!fs.existsSync(base)) return `Error: path does not exist: ${args.path}`;
    if (!args.multiline && hasRg()) return await grepRg(args, base, ctx);
    return await grepJs(args, base, ctx);
  },
};

// Is ripgrep on PATH? Probed once and memoised: the probe itself is a spawn, and
// running it on every Grep call was a pointless synchronous stall.
let _hasRg = null;
function hasRg() {
  if (_hasRg !== null) return _hasRg;
  try {
    // spawnSync does NOT throw when the binary is missing — it returns
    // { error: ENOENT, status: null }. The old try/catch therefore always
    // reported "rg available", and grepRg() then returned an empty stdout as
    // "No matches found" instead of falling back to the JS walker.
    const r = cp.spawnSync('rg', ['--version'], { stdio: 'ignore' });
    _hasRg = !r.error && r.status === 0;
  } catch { _hasRg = false; }
  return _hasRg;
}

function buildRgArgs(args, base) {
  // --crlf: an end anchor (`;$`) must match a line that ends `\r\n`, exactly as
  // it does in an LF file — and as the JS fallback already does. Without it the
  // rg path reported "No matches found" for patterns the user could SEE ending
  // the line, on this repo's own CRLF files.
  const a = ['--no-heading', '--line-number', '--no-config', '--crlf', '-e', args.pattern];
  if (args['-i']) a.push('-i');
  const before = args['-B'] || (args['-C'] || 0);
  const after = args['-A'] || (args['-C'] || 0);
  if (before) a.push('-B', String(before));
  if (after) a.push('-A', String(after));
  if (args.glob) a.push('-g', args.glob);
  if (args.type) a.push('-t', args.type);
  if (args.output_mode === 'files_with_matches') a.push('-l');
  else if (args.output_mode === 'count_matches') a.push('-c');
  if (args.include_ignored) a.push('--no-ignore');
  a.push('--', base);
  return a;
}

// Run ripgrep ASYNCHRONOUSLY. `spawnSync` blocked the event loop for the whole
// search — on a large repo that froze the TUI (the spinner stopped, input lagged)
// for as long as rg ran, which is exactly the "working indicator stalls" symptom.
// Streaming the output with an async spawn keeps the UI responsive.
function grepRg(args, base, ctx) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn('rg', buildRgArgs(args, base), { cwd: ctx.cwd || ctx.workspace });
    } catch {
      grepJs(args, base, ctx).then((r) => resolve(r), (e) => resolve(`Error: ${e.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // spawn failure (ENOENT, etc.): fall back to the JS walker rather than
    // reporting an empty result as "No matches found".
    child.on('error', () => done(() => grepJs(args, base, ctx).then((r) => resolve(r), (e) => resolve(`Error: ${e.message}`))));
    child.on('close', (code) => done(() => {
      if (code > 1 && stderr) resolve(`rg error: ${stderr.trim()}`);
      else if (!stdout.trim() && args.pattern.includes('$')) {
        // A zero-match END-ANCHORED query may be a LONE-CR file (old-Mac endings),
        // which rg cannot treat as line breaks at all. The JS walker handles every
        // ending, so it gets the final word — only for `$` patterns that found
        // nothing, so ordinary searches never pay for the extra pass.
        grepJs(args, base, ctx).then((r) => resolve(r), (e) => resolve(`Error: ${e.message}`));
      }
      else resolve(paginate(stdout, args));
    }));
    // Honour an aborted turn (Esc): kill rg instead of leaving it running.
    if (ctx && ctx.signal) {
      const onAbort = () => { try { child.kill(); } catch { /* already gone */ } done(() => resolve(paginate(stdout, args))); };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function grepJs(args, base, ctx) {
  const flags = 'g' + (args['-i'] ? 'i' : '') + (args.multiline ? 's' : '');
  const re = new RegExp(args.pattern, flags);
  // ASYNC, for the same reason as Glob: a synchronous walk over a large tree freezes everything else that shares
  // the process.
  const files = await walkFilesAsync(base, { includeIgnored: !!args.include_ignored, includeDirs: false, limit: 0 });
  const filtered = files.filter((abs) => {
    if (args.glob) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (!matchGlob(args.glob, rel) && !matchGlob(args.glob, path.basename(abs))) return false;
    }
    if (args.type) {
      const ext = path.extname(abs).toLowerCase().slice(1);
      if (ext !== args.type) return false;
    }
    return true;
  });

  const out = [];
  for (const abs of filtered) {
    let txt;
    try {
      const buf = fs.readFileSync(abs);
      if (!isProbablyTextFile(buf)) continue;
      // The WHOLE file, not `truncateBuf(buf)`. That helper caps a tool RESULT at
      // 128 KB, which is right for what is handed back to the model and wrong as the
      // haystack: on this repo it cut src/tui.js (878 KB) to its first 15%, so any
      // pattern appearing later in the file reported "No matches found" — a silent
      // false negative on the biggest, most-edited file there is. Real ripgrep
      // searches everything and caps only its OUTPUT, which is what happens here now:
      // the rows are collected in full and `paginate` + `head_limit` bound the result.
      txt = buf.toString('utf8');
    } catch { continue; }
    const mode = args.output_mode;

    // Normalise CRLF -> LF BEFORE anything else. Splitting on '\n' alone left a
    // '\r' at the end of every line in a CRLF file (which every file in this repo
    // is), and a '\r' is a real character to a regex:
    //   * `foo$` and `^foo$` matched NOTHING, because the line really ends "\r";
    //   * every returned match line carried a stray '\r', cleaned up by paginate()
    //     only for the final output — after the matching had already gone wrong.
    // One normalisation here is what `rg` does internally, and it makes the JS
    // path agree with it.
    const normalized = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    txt = normalized;

    if (args.multiline) {
      const ms = Array.from(txt.matchAll(re));
      if (ms.length === 0) continue;
      if (mode === 'files_with_matches') { out.push(abs); continue; }
      if (mode === 'files_with_matches') { out.push(abs); continue; }
      if (mode === 'count_matches') { out.push(`${abs}:${ms.length}`); continue; }
      const lines = txt.split('\n');
      for (const mm of ms) {
        const lineNo = txt.slice(0, mm.index).split('\n').length; // 1-based
        emitContext(out, abs, lineNo - 1, lines, args);
      }
    } else {
      const lines = txt.split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        // `re` carries the `g` flag, so RegExp.test() advances lastIndex and
        // the NEXT call starts mid-string — every other matching line was
        // skipped. Reset lastIndex before each test.
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          count++;
          if (mode === 'files_with_matches') { out.push(abs); break; }
          if (mode === 'count_matches') continue;
          emitContext(out, abs, i, lines, args);
        }
      }
      if (count > 0 && mode === 'count_matches') out.push(`${abs}:${count}`);
    }
  }
  return paginate(out.join('\n'), args);
}

function emitContext(out, file, idx, lines, a) {
  const before = a['-C'] || a['-B'] || 0;
  const after = a['-C'] || a['-A'] || 0;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length - 1, idx + after);
  for (let k = start; k <= end; k++) {
    if (k === idx) out.push(`${file}:${k + 1}:${lines[k]}`);
    else out.push(`${file}-${k + 1}-${lines[k]}`);
  }
}

function paginate(raw, args) {
  if (raw === '' || raw === undefined || raw === null) return 'No matches found.';
  // Split on either newline style and drop the trailing empty element a final
  // CRLF leaves behind — `rg` always ends with one, and it rendered as a stray
  // blank line under the last match.
  let lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (args.offset) lines = lines.slice(args.offset);
  if (args.head_limit) lines = lines.slice(0, args.head_limit);
  if (lines.length === 0) return 'No matches found.';
  return lines.join('\n').replace(/\r/g, '');
}
