// Glob tool — mirrors the hncode Glob tool schema & behavior.
// Recursive glob from `path` (default cwd), honoring .gitignore/.ignore/.rgignore
// unless include_ignored. Returns up to 100 matches sorted most-recent-modified first.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from './utils.js';
import { walkFilesAsync } from './ignore.js';
import { globToRegexSource, expandBraces } from './matchers.js';

/**
 * Entries directly inside `dir` — no recursion.
 *
 * This is what a pattern with no separator asks for, and answering it with a full tree walk is how a one-line
 * lookup turned into a 43-second scan of a drive.
 */
function shallowEntries(dir, includeDirs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!includeDirs && !ent.isFile()) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

export const spec = {
  name: 'Glob',
  description: 'Find files by glob pattern. Honors ignore files unless include_ignored. Up to 100 matches, newest first.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts).' },
      path: { type: 'string', description: 'Directory to search from (default: project root).', default: '.' },
      include_ignored: { type: 'boolean', default: false, description: 'Also match git-ignored paths.' },
      include_dirs: { type: 'boolean', default: false, description: 'Include directories in results.' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    // `pattern` is required, but the model can still omit it. Return an error
    // string like every other tool instead of throwing — an uncaught throw here
    // aborts the whole turn.
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) {
      return 'Error: `pattern` is required (e.g. "src/**/*.ts").';
    }
    const fromDir = typeof args.path === 'string' && args.path ? args.path : '.';
    let base;
    // Same workspace boundary as Read/Write/Edit. Glob resolved `path` directly,
    // so `Glob { pattern: '**', path: 'C:\\Users\\...' }` walked any directory on
    // disk with no permission gate at all.
    try { base = resolvePath(fromDir, ctx); } catch (e) { return `Error: ${e.message}`; }
    if (!fs.existsSync(base)) return `Error: path does not exist: ${fromDir}`;
    if (!fs.statSync(base).isDirectory()) return `Error: --path is not a directory: ${fromDir}`;

const alts = expandBraces(args.pattern);
    // Each alt is already anchored (globToRegexSource includes ^ and $), so
    // join them into one anchored alternation. The previous code inferred the
    // anchors by slicing the first/last char off globRegex(), which was fragile:
    // a brace pattern has per-alt anchors that slicing stripped into the wrong
    // shape.
    const re = new RegExp('^(?:' + alts.map((a) => globToRegexSource(a)).join('|') + ')$');


    // HOW DEEP TO WALK IS DECIDED BY THE PATTERN, not by the matcher.
    //
    // `*.java` contains no slash, so it describes entries DIRECTLY inside `path`. Matching it against every
    // file's basename made it hit the whole subtree — which is why one call over a drive root took 43 seconds and
    // still reported "no files matched", having walked hundreds of thousands of entries to reject them all.
    //
    // A pattern with a separator (`src/**/*.ts`, `**/*.java`) is asking to descend, and gets the full walk. A bare
    // one is answered by a single readdir.
    const wantsDeep = alts.some((a) => a.includes('/') || a.includes(path.sep));
    let candidates;
    if (wantsDeep) {
      // ASYNC: a synchronous walk over a large tree freezes the loop it runs on — no paint, no keystroke, no
      // timer, for as long as it takes.
      candidates = await walkFilesAsync(base, {
        includeIgnored: !!args.include_ignored,
        includeDirs: !!args.include_dirs,
      });
    } else {
      candidates = shallowEntries(base, !!args.include_dirs);
    }

    const matches = [];
    for (const abs of candidates) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      // Match the RELATIVE PATH only. The absolute path and the bare basename were both accepted before, and
      // both were wrong: an absolute path lets `tmp/*.log` match a directory that merely appears in the middle of
      // it, and the basename turns a pattern that names no directory into a recursive search.
      if (re.test(rel)) matches.push(abs);
    }
    if (matches.length > 100) matches.length = 100;
    if (matches.length === 0) return `No files matched \`${args.pattern}\` in ${fromDir}`;
    return matches.join('\n');
  },
};
