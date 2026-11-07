// Edit tool — mirrors the hncode Edit tool schema & behavior.
// Snippet-based exact replacement (old_string -> new_string), NOT a whole-file rewrite,
// so edits stay token-cheap (unlike kimi-code-cli's whole-file Edit).

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, ensureDir, checkpointBeforeWrite } from './utils.js';
import { hashStr, normalizeText } from './read.js';

// Typographic quotes -> straight quotes. A model almost always emits ASCII
// quotes, but docs/blog/markdown often use curly ones; without this the edit
// fails with "old_string not found" even though the text is visibly there.
// Mirrors Claude Code's normalizeQuotes.
const CURLY = [
  ['\u2018', "'"], ['\u2019', "'"],   // ‘ ’
  ['\u201c', '"'], ['\u201d', '"'],   // “ ”
];
export function normalizeQuotes(s) {
  let out = String(s);
  for (const [from, to] of CURLY) out = out.split(from).join(to);
  return out;
}

// Re-exported from read.js so the staleness guard has ONE definition of the
// region hash. Previously read.js and edit.js each had their own copy; any
// drift between them would silently disable staleness detection.
import { hashRegion as hashLines } from './read.js';

export const spec = {
  name: 'Edit',
  description: `Edit a file. Three shapes: LINE-RANGE (path + start_line + end_line + new_string),
SUBSTRING (path + old_string + new_string, unique unless replace_all), RANGED SUBSTRING (the same plus
start_line + end_line, which narrows where old_string is searched).

BOTH BOUNDS ARE INCLUSIVE: start_line=3, end_line=5 covers lines 3, 4 and 5 — three lines, so new_string must
have exactly three lines.

TO DELETE, SEND AN EMPTY new_string. start_line=7, end_line=7 with new_string="" removes line 7 and nothing
else. That is the ONLY correct way to delete. Restating the next line as the replacement COPIES it, the file
then holds that line twice, and because the duplicate looks like damage the retry restates another neighbour —
the duplicates multiply. Never copy a neighbouring line into new_string to stand in for deleting.

new_string is written VERBATIM — no indentation is added, removed or re-derived. Every line carries its own
leading whitespace, the FIRST one included; copy it from the Read output after the tab that follows each line
number (Read prints '12' then a tab, then the indented code, so you send the leading spaces yourself).

COUNT FIRST: in line-range mode new_string must have exactly end_line - start_line + 1 lines, and every line
you write must be one you are replacing. A line outside the range is not deleted and survives as a duplicate.

Omitting new_string entirely is an error — pass "" to delete.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace and newlines. Omit for pure line-range mode. COMBINE it with start_line/end_line to replace only the occurrence inside that range.' },
      new_string: { type: 'string', description: 'Replacement text, written VERBATIM in BOTH modes — no indentation is added, removed, or re-derived. Write the leading spaces on EVERY line yourself, including the FIRST one, copying them from the Read output after its `N\\t` line-number prefix (Read prints `12\\t    return x`, so you send `    return x`). In LINE-RANGE mode it must contain EXACTLY the lines being replaced: a line that sits outside [start_line, end_line] is not deleted, so restating it here leaves a duplicate. Count them first: new_string must have exactly end_line - start_line + 1 lines. In SUBSTRING mode it replaces old_string, which is itself matched exactly including its own indentation.' },

      replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string.' },
      start_line: { type: 'integer', minimum: 1, description: 'PREFERRED MODE. 1-based first line to replace, INCLUSIVE — the range covers start_line and end_line and every line between them. Requires end_line and new_string. With old_string too, it is the first line to SEARCH for it in.' },
      end_line: { type: 'integer', minimum: 1, description: 'PREFERRED MODE. 1-based last line to replace, INCLUSIVE (requires start_line). start_line=3, end_line=5 replaces lines 3, 4 AND 5 — three lines, so new_string must have three lines. If your new_string has four, one of them is outside the range and will survive as a duplicate. With old_string too, it is the last line to search in.' },
    },
    // Three accepted shapes:
    //   line-range        start_line + end_line + new_string
    //   exact-substring   old_string + new_string
    //   rangedToWindow-substring  start_line + end_line + old_string + new_string
    // Line-range is the preferred route; the third exists for "one of several copies".
    anyOf: [
      { required: ['path', 'start_line', 'end_line', 'new_string'] },
      { required: ['path', 'old_string', 'new_string'] },
    ],
  },
  async execute(args, ctx) {
    // Validate BEFORE resolving the path. `resolvePath(undefined)` resolves to the
    // workspace root rather than failing, so a truncated tool call (agent.js falls
    // back to `{ raw, _rawLen }` when the streamed JSON will not parse) could
    // target a DIRECTORY and produce a confusing EISDIR/ENOENT instead of "retry
    // the call".
    if (typeof args.path !== 'string' || !args.path.trim()) {
      const truncated = args && args.raw
        ? ` The arguments did not parse as JSON${args._rawLen ? ` (${args._rawLen} characters received)` : ''} — the call was most likely truncated. Retry, and keep \`old_string\` / \`new_string\` small (edit in several passes rather than one large replacement).`
        : '';
      return `Error: \`path\` is required and must be a non-empty string.${truncated}`;
    }
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    // A Jupyter notebook is JSON, not text: a snippet edit corrupts it. Point the
    // model at the notebook-aware tool instead (mirrors Claude Code errorCode 5).
    if (String(p).toLowerCase().endsWith('.ipynb')) {
      return `Error: ${args.path} is a Jupyter notebook, and its .ipynb is JSON — a text replacement would corrupt it. Use NotebookEdit instead: \`{ path: ${JSON.stringify(args.path)}, action: "list" }\` to see the cells, then action "replace" with the cell index.`;
    }
    let content;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return `Error reading ${args.path}: file does not exist.${similarFileHint(p)}`;
      }
      return `Error reading ${args.path}: ${e.message}`;
    }
    const { start_line, end_line } = args;
    // THREE shapes, not two.
    //
    //   line-range  start_line + end_line + new_string
    //   substring   old_string + new_string
    //   RANGED SUB   start_line + end_line + old_string + new_string
    //
    // The third is what the first two cannot express: replace ONE occurrence of a snippet that
    // appears several times, without `replace_all` (which would hit every copy) and without
    // counting lines by hand. The range narrows WHERE to look; `old_string` says WHAT to replace
    // inside it. Rejecting the combination sent callers to `replace_all` as their only option,
    // which is how the wrong copy gets edited.
    //
    // `old_string` alongside a range is therefore not a mistake — but a range with NEITHER
    // old_string nor new_string still is, and is reported below.
    const hasRangeKeys = args.start_line != null || args.end_line != null;
    const hasSubKeys = args.old_string != null;
    const hasNewString = (args.new_string != null) || (args.new_content != null);
    if (hasRangeKeys && hasSubKeys && !hasNewString) {
      return 'Error: a rangedToWindow edit needs new_string as well as old_string.';
    }

    // ---- RANGED SUBSTRING ---------------------------------------------------
    // A range AND an old_string: search for the snippet only INSIDE the range. Handled here,
    // before the pure line-range path, because that path replaces whole lines and would ignore
    // the snippet entirely — the very ambiguity the old mutual-exclusion check was avoiding.
    //
    // The range is validated, then the substring path below does the matching with the search
    // window clamped to it. Splitting the work this way keeps ONE implementation of matching
    // (quote-normalized retry, staleness, whitespace tolerance) instead of a second, weaker copy.
    // A HALF-GIVEN RANGE with an old_string is not a reason to refuse: the snippet locates the
    // edit by itself, and the single bound is a hint that failed to pair. Callers add `start_line`
    // from the schema's own wording ("1-based first line to replace") expecting it to help, so
    // refusing rejected a request that was already complete.
    //
    // `rangedToWindow` is set even though no window is applied. It means "the range question has been
    // settled", which is what the line-range guard below tests — leaving it false made that guard
    // see the same unpaired bound and reject the call one block later.
    let searchFrom = 0;
    let searchTo = 0;      // 0,0 = the whole file
    // A real window was validated, so the search below is confined to it. Distinct from
    // `rangeHandled`: this one means "clamp", and setting it for a snippet with no window made
    // every search run inside 0..0 and find nothing.
    let rangedToWindow = false;
    // The range question is answered — either a window was applied, or the caller gave an
    // `old_string` that locates the edit on its own and a half-given bound was ignored.
    let rangeHandled = hasSubKeys;
    if (hasRangeKeys && hasSubKeys && hasNewString) {
      if ((start_line != null) !== (end_line != null)) {
        // Ignore the unpaired bound; `searchFrom`/`searchTo` stay at the whole file and `rangedToWindow`
        // was already set above.
        searchFrom = 0;
        searchTo = 0;
      } else {
        // The range was given in full: validate it, then confine the search to it.
        const start = Number(start_line) | 0, end = Number(end_line) | 0;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
          return `Error: invalid line range ${start_line}-${end_line} (expected 1-based, start <= end).`;
        }
        {
          const all = content.split(/\r\n|\r|\n/);
          if (end > all.length) {
            return `Error: end_line ${end_line} exceeds file length (${all.length} lines).`;
          }
        }
        rangedToWindow = true;
        rangeHandled = true;
        searchFrom = start;
        searchTo = end;
      }
    }

    // ---- LINE-RANGE mode ---------------------------------------------------
    // `start_line`..`end_line` replace the lines at those 1-based positions,
    // with NO old_string involved at all. This is the path for "change line 12"
    // where spelling out the exact current text is awkward.
    if (!rangeHandled && (start_line != null) !== (end_line != null)) {
      return 'Error: line-range mode needs BOTH start_line and end_line.';
    }
    if (!rangeHandled && start_line != null && end_line != null) {
      // Accept both spellings so old new_content callers keep working.
      const new_string = args.new_string != null ? args.new_string : args.new_content;
      // new_string is required — a missing one would put the literal string
      // "undefined" in the file.
      if (new_string == null) return `Error: new_string is required for line-range mode (pass an empty string to delete the lines).`;
      if (typeof new_string !== 'string') {
        return `Error: new_string must be a string (got ${new_string === null ? 'null' : typeof new_string}).`;
      }
      const start = Number(start_line) | 0, end = Number(end_line) | 0;
      if (start < 1 || end < start) {
        return `Error: invalid line range ${start_line}-${end_line} (expected 1-based, start <= end).`;
      }
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      const lines = content.split(/\r\n|\r|\n/);
      if (end > lines.length) {
        return `Error: end_line ${end_line} exceeds file length (${lines.length} lines).`;
      }
      // STALENESS: the range must sit inside a region this turn actually Read and
      // that still matches. Same guarantee as the substring path, checked here
      // directly (no old_string to search for).
      const stale = checkStaleRange(p, lines, start, end, ctx);
      if (stale) return stale;

      // AN EMPTY new_string DELETES THE RANGE. No line survives, so the replacement is nothing at all.
      //
      // `''.split('\n')` is `['']` — ONE EMPTY STRING — not an empty array. The splice therefore replaced the
      // range with a single blank line, so "delete these lines" left a hole and shifted everything below it.
      // Deleting has to mean deleting: when there is no replacement text, the range is removed outright.
      //
      // This is also the answer to the mistake that keeps appearing in edits: to remove one line, send an EMPTY
      // new_string over that one line. Restating the neighbour instead copies it, and the file ends up with the
      // line twice — the duplicate is a symptom of having no delete, not of carelessness.
      const inserted = new_string === '' ? [] : normalizeText(new_string).split('\n');

      // The lines being REPLACED, captured before the splice. The TUI renders an Edit's diff from the tool
      // ARGUMENTS, and line-range mode has no `old_string` to diff against — so without reporting them here the
      // edit drew NO diff at all.
      const replacedText = lines.slice(start - 1, end).join('\n');
      const out = [...lines.slice(0, start - 1), ...inserted, ...lines.slice(end)];
      const normUpdated = out.join('\n');
      const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;

      // Checkpoint the pre-edit content so /undo can put it back (file-history.js).
      checkpointBeforeWrite(p, ctx);
      try {
        ensureDir(p);
        fs.writeFileSync(p, updated, 'utf8');
      } catch (e) { return `Error writing ${args.path}: ${e.message}`; }
      // NO READ-SNAPSHOT REFRESH. The write changed the file, so every region the model was holding is now a
      // record of text that no longer exists — including the span just written, whose current content the
      // model has never seen. Regenerating trust from the arguments would let it edit again on top of a change
      // it only THINKS it knows. It reads the file instead.
      const removed = end - start + 1;
      if (ctx) ctx.lastEditDiff = buildEditDiff({ fileLines: lines, oldText: replacedText, newText: inserted.join('\n'), startLine: start });
      return `Edited ${args.path}: replaced lines ${start}-${end} (${removed} line${removed === 1 ? '' : 's'}) with ${inserted.length} line${inserted.length === 1 ? '' : 's'}.`;
    }

    // ---- SUBSTRING mode (old_string -> new_string) --------------------------
    // `new_content` is accepted as an alias of `new_string` — the validation above
    // already counts it, so refusing it here sent a confusing "new_string is
    // required" for an argument the mode's own checks accepted.
    let { old_string, new_string, replace_all = false } = args;
    if (new_string == null && args.new_content != null) new_string = args.new_content;
    // Reaching here means neither mode was usable: line-range needs
    // start_line+end_line (handled above) and substring needs old_string. When
    // BOTH are absent, say so — "old_string must not be empty" sends the model
    // hunting for a stray empty string it never sent.
    if (old_string == null && new_string == null) {
      return 'Error: no edit mode given. Pass EITHER (start_line, end_line, new_string) OR (old_string, new_string).';
    }
    if (old_string === '' || old_string == null) return `Error: old_string must not be empty.`;
    if (new_string == null) return `Error: new_string is required for substring mode.`;

    // --- Newline normalization (Windows CRLF) ---
    // The Read tool normalizes \r\n -> \n, so an agent builds old_string/new_string
    // with LF. But the file on disk may be CRLF, making a raw LF match fail. We
    // normalize the FILE content to LF for matching, then restore the file's own
    // line ending style when writing back, so we never corrupt or mix endings.
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normContent = content.split(/\r\n|\r|\n/).join('\n');
    const normOld = normalizeText(old_string);
    const normNew = normalizeText(new_string);

    // A RANGED edit searches only inside the given lines. `windowStart` is the character offset of
    // the range's first line in `normContent`, and `windowEnd` the end of its last line; the whole
    // file is the window when no range was given. Every match, count and replacement below uses
    // this window, so a snippet that appears elsewhere in the file is neither found nor touched —
    // which is the entire point, and what `replace_all` cannot express.
    let windowStart = 0;
    let windowEnd = normContent.length;
    if (rangedToWindow) {
      const allLines = normContent.split('\n');
      // Offset of line N's first character: the sum of the lengths of lines 1..N-1 plus their
      // newlines. Computed by walking, because a single `indexOf` would find the wrong copy of a
      // line that also occurs earlier in the file.
      const offsetOfLine = (n) => {
        let at = 0;
        for (let i = 0; i < n - 1 && i < allLines.length; i++) at += allLines[i].length + 1;
        return at;
      };
      windowStart = offsetOfLine(searchFrom);
      const lastLineStart = offsetOfLine(searchTo);
      windowEnd = Math.min(normContent.length, lastLineStart + (allLines[searchTo - 1] || '').length);
    }
    /** Occurrences of `needle` inside the window. */
    const countInWindow = (needle) => {
      if (!needle) return 0;
      const seg = normContent.slice(windowStart, windowEnd);
      return seg.split(needle).length - 1;
    };

    let matchOld = normOld;    // the string that will actually be matched/replaced
    let matchNew = normNew;
    let count = countInWindow(matchOld);
    if (count === 0) {
      // Quote-normalized retry: the file may use curly quotes while the model sent
      // straight ones. Match on the normalized forms, then replace the ACTUAL
      // substring found in the file so typography is preserved. normalizeQuotes is
      // 1 char -> 1 char, so indices line up between the two strings.
      const normFileQ = normalizeQuotes(normContent);
      if (normFileQ !== normContent) {
        const normOldQ = normalizeQuotes(normOld);
        // Search the NORMALIZED window for the normalized snippet, then take the real text at
        // that place so the replacement keeps the file's own typography.
        const idx = normFileQ.indexOf(normOldQ, windowStart);
        if (idx >= 0 && idx + normOldQ.length <= windowEnd) {
          matchOld = normContent.slice(idx, idx + normOldQ.length);
          matchNew = normNew;   // keep the model's new_string as written
          count = countInWindow(matchOld);
        }
      }
    }
    if (count === 0) {
      if (rangedToWindow) {
        // Say WHERE it was looked for, so a snippet that exists elsewhere is not reported as
        // missing outright — that sends the caller hunting for a typo that is not there.
        const elsewhere = normContent.split(normOld).length - 1;
        const hint = elsewhere
          ? ` It appears ${elsewhere} time(s) elsewhere in the file, outside lines ${searchFrom}-${searchTo}. Broaden the range, or correct the range.`
          : '';
        return `Error: old_string not found within lines ${searchFrom}-${searchTo} of ${args.path}.${hint}`;
      }
      const near = nearestLineHint(normContent, normOld);
      return `Error: old_string not found in ${args.path}.${near}`;
    }
    if (count > 1 && !replace_all) {
      if (rangedToWindow) {
        return `Error: old_string matched ${count} occurrences within lines ${searchFrom}-${searchTo} of ${args.path}. Narrow the range, or use replace_all=true to change all of them.`;
      }
      return `Error: old_string matched ${count} occurrences in ${args.path}. Use replace_all=true or make old_string unique.`;
    }
    // --- Staleness guard: the AI must edit against content it actually Read.
    // We stored per-region + whole-file hashes in ctx.readPool when Read ran.
    // If the file changed on disk since (external edit, stream, Ctrl-C side
    // effect), reject so a snippet edit cannot silently corrupt the file. ---
    const stale = checkStale(p, normContent, matchOld, ctx);
    if (stale) return stale;

    // Replace INSIDE the window only. A rangedToWindow edit must not touch an identical snippet sitting
    // before or after the range — replacing across the whole file is the failure the range exists
    // to prevent. With no range the window IS the whole file, so non-rangedToWindow callers are unchanged.
    //
    // The replacement is passed as a FUNCTION: a string second argument makes JS interpret
    // `$&`, `` $` ``, `$'` and `$$` in the NEW text, so an edit whose new_string contains them
    // (regex examples, Makefile `$$`, shell code) silently wrote the wrong file.
    const normUpdated = (() => {
      const head = normContent.slice(0, windowStart);
      const body = normContent.slice(windowStart, windowEnd);
      const tail = normContent.slice(windowEnd);
      const literal = () => matchNew;
      return head + (replace_all ? body.replaceAll(matchOld, literal) : body.replace(matchOld, literal)) + tail;
    })();
    // The replaced text's actual character offset in normContent (first occurrence
    // inside the window — guaranteed >= 0, the count above found it). Everything
    // before the match is unchanged, so this one offset anchors BOTH the diff and
    // the Read-pool re-arm below to the real edit site. Locating the site by
    // matching its first LINE (the old approach) collapsed to line 1 when
    // old_string starts mid-line, and pointed at an earlier copy when the file
    // repeats that line — the diff then drew context from the top of the file.
    const matchAt = normContent.indexOf(matchOld, windowStart);
    const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;
    // Checkpoint the pre-edit content so /undo can put it back (file-history.js).
    checkpointBeforeWrite(p, ctx);
    try {
      ensureDir(p);
      fs.writeFileSync(p, updated, 'utf8');
    } catch (e) { return `Error writing ${args.path}: ${e.message}`; }
    // NO READ-SNAPSHOT REFRESH — see the note on the line-range path above. Whatever the model was holding is
    // now a record of a file that no longer exists, so the next edit of these lines has to be preceded by a
    // Read of them.
    const occurrences = replace_all ? count : 1;
    // Publish the diff for the UI (same contract as the line-range path above).
    // `startLine` comes from the actual match offset, so a snippet that starts
    // mid-line or a file with repeated lines still anchors the context rows at
    // the place that was really edited.
    if (ctx) {
      const startLine = matchAt >= 0 ? normContent.slice(0, matchAt).split('\n').length : 1;
      ctx.lastEditDiff = buildEditDiff({
        fileLines: normContent.split('\n'),
        oldText: old_string,
        newText: new_string,
        startLine,
      });
    }
    return `Edited ${args.path}: replaced ${occurrences} occurrence(s).`;
  },
};

/** How many unchanged lines to show on each side of a changed region. */
const DIFF_CONTEXT = 5;



/** The line's leading whitespace, for the same-indent closer rule. */
function leadingWs(s) {
  const m = /^\s*/.exec(String(s == null ? '' : s));
  return m ? m[0] : '';
}


/**
 * Build the diff payload, including the unchanged lines around the change.
 *
 * The replaced lines alone do not tell a reader WHERE the edit landed: a four-line block quoted with no
 * surroundings could be anywhere in a 500-line file, so neither the model nor the user could tell a
 * correct edit from one applied at the right text in the wrong place — and with repeated code (several
 * similar blocks, two `}` in a row) the same text appears in many places.
 *
 * `context` carries the file's own lines so the renderer can draw them unmarked, above and below.
 *
 * `fileLines` is the content BEFORE the edit, for the replaced region's START LINE to be meaningful:
 * `startLine` is a line number in that same file.
 */
function buildEditDiff({ fileLines, oldText, newText, startLine }) {
  const lines = Array.isArray(fileLines) ? fileLines : [];
  const before = [];
  const after = [];
  const replacedCount = normalizeText(oldText).split('\n').length;
  // `startLine` is 1-based; the replaced block occupies [startLine, startLine + n - 1].
  const lastReplaced = startLine + replacedCount - 1;
  for (let n = startLine - DIFF_CONTEXT; n < startLine; n++) {
    if (n >= 1 && n <= lines.length) before.push({ n, text: lines[n - 1] });
  }
  // The AFTER context is drawn from the file BEFORE the edit, but its line numbers must describe the file
  // AFTER it — that is the file a reader has open when they read the diff.
  //
  // Using the pre-edit numbers looked right for a same-size replacement and drifted by one per added line
  // otherwise: an edit that grew the file by three shifted every context row, so the diff showed line
  // numbers that did not exist where it claimed, or repeated ones that did.
  //
  // `net` is the number of lines the edit added (negative when it shrank the file), so every line below
  // the replaced block moves by exactly that much.
  const net = normalizeText(newText).split('\n').length - replacedCount;
  for (let n = lastReplaced + 1; n <= lastReplaced + DIFF_CONTEXT; n++) {
    if (n >= 1 && n <= lines.length) after.push({ n: n + net, text: lines[n - 1] });
  }
  return {
    old: normalizeText(oldText),
    new: normalizeText(newText),
    startLine,
    context: { before, after },
  };
}

// Suggest a near-miss filename when a path does not exist: same directory, an
// exact case-insensitive match, same stem with a different extension, or a
// prefix match. Saves the model a round-trip of guessing (Claude Code's
// "Did you mean X?").
function similarFileHint(missingPath) {
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

// When old_string is not found, look for the closest line in the file and name
// it, so the model can see what the text actually is instead of guessing.
function nearestLineHint(content, oldStr) {
  const want = String(oldStr).split('\n')[0].trim();
  if (!want || want.length < 3) return '';
  const lines = String(content).split('\n');
  // Character bigrams: robust to small differences and cheap on long lines.
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const wantGrams = grams(want);
  if (!wantGrams.size) return '';
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const g = grams(lines[i].trim());
    if (!g.size) continue;
    let hit = 0;
    for (const t of wantGrams) if (g.has(t)) hit++;
    const score = hit / wantGrams.size;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best >= 0 && bestScore >= 0.5) {
    return ` The closest line is line ${best + 1}: ${JSON.stringify(lines[best].trim().slice(0, 120))}`;
  }
  return '';
}

// Returns an error message when the edit is stale, else null (safe to edit).
function checkStale(p, normContent, normOld, ctx) {
  if (!ctx || !ctx.readPool) return null; // no Read happened; nothing to verify
  const entry = ctx.readPool.get(p);
  if (!entry) return null; // this file was never Read this turn; allow

  const curLines = normContent.split('\n');
  const curFileHash = hashStr(normContent);

  // Locate the edit target's first line in the CURRENT file (1-based).
  //
  // An EXACT line match first, then a line that merely CONTAINS it. The exact match alone
  // missed every edit whose `old_string` begins mid-line — `old_string: "return 1;"` against
  // a line `  return 1;` found nothing, so `editLine` was -1 and step (1) below was skipped
  // entirely: the edit was then reported as stale (branch 2) or, with the whole-file hash
  // also differing, rejected as though the file had changed. Two-line `old_string`s are the
  // common case for a range edit, and their first line usually IS whole, which is why this
  // only showed up on single-line and indented-prefix edits.
  const firstLine = String(normOld).split('\n')[0];
  let idx = curLines.indexOf(firstLine);
  if (idx < 0 && firstLine) idx = curLines.findIndex((l) => l.includes(firstLine));
  const editLine = idx >= 0 ? idx + 1 : -1;

  // (1) The edit target must sit inside a region the AI actually Read, and that
  //     region's content must still match what was Read. Reading the WHOLE file
  //     records a region covering every line, so this also covers "read full,
  //     edit a part". This is what rejects "read lines 1-3, edit line 7".
  if (editLine > 0) {
    const coveredByIntactRegion = entry.regions.some(
      (r) => editLine >= r.start && editLine <= r.end && hashLines(curLines, r.start, r.end) === r.hash,
    );
    if (coveredByIntactRegion) return null;
  }

  // (2) Whole file unchanged since Read, but the edit target was never Read
  //     (no region covers it). Name the exact lines so the model reads the right
  //     window instead of guessing.
  if (curFileHash === entry.fileHash) {
    const span = String(normOld).split('\n').length;
    const at = editLine > 0 ? editLine : 1;
    return `Edit rejected: you have not read the lines you are editing in ${p}. The target is around line ${at} (${span} line${span === 1 ? '' : 's'}). Read it first — ${args_readHint(p, at, span)} — then Edit.`;
  }

  // (3) The file changed on disk since it was Read and the edit target is not in
  //     an intact Read region. Reject so a stale snippet cannot corrupt the file.
  const at3 = editLine > 0 ? ` (target line ${editLine})` : '';
  return `Edit rejected: ${p} changed since it was Read${at3}, and the edited region is not in an intact Read snapshot. Re-run ${args_readHint(p, editLine > 0 ? editLine : 1, String(normOld).split('\n').length)} to get the current content, then Edit.`;
}

// A ready-to-use Read call for the hint. Keeps the model from guessing line ranges.
function args_readHint(p, at, span) {
  const from = Math.max(1, at - 3);
  const n = Math.max(span + 6, 10);
  return `Read { path: ${JSON.stringify(p)}, start_line: ${from}, end_line: ${from + n - 1} }`;
}
// ---- helpers for the line-range path ---------------------------------------

// Same guarantee as checkStale, but for an explicit [start, end] line range:
// every line in the range must sit inside a region that was Read this turn and
// whose content still matches. Returns an error string, or null when safe.
function checkStaleRange(p, curLines, start, end, ctx) {
  if (!ctx || !ctx.readPool) return null; // no Read happened; nothing to verify
  const entry = ctx.readPool.get(p);
  if (!entry) return null;                // never Read this turn; allow

  const normContent = curLines.join('\n');
  const curFileHash = hashStr(normContent);

  // A range is "read" when the regions the model has SEEN cover it — not only when
  // a single region spans it. A file read in two passes (5-10 then 11-16) must
  // allow editing 5-16: the two slices are contiguous, both still intact, so the
  // written range is fully known. Requiring one enclosing region rejected that
  // perfectly safe edit and forced a third Read.
  //
  // Only regions whose hash STILL matches count: a region whose text changed is no
  // longer what the model saw, so it cannot vouch for anything. The cover must also
  // be SEAMLESS — a gap (5-10 and 12-16 with 11 unread) leaves 11 unknown, so it
  // does NOT count, and the edit is correctly refused.
  const intact = entry.regions
    .filter((r) => hashLines(curLines, r.start, r.end) === r.hash)
    .sort((a, b) => a.start - b.start);
  let reach = start - 1;                       // highest line known to be covered
  for (const r of intact) {
    if (r.end < start) continue;               // entirely before the target
    if (r.start > reach + 1) break;            // a gap opens before this region: stop
    if (r.end > reach) reach = r.end;
    if (reach >= end) return null;             // reached the end: fully covered
  }

  if (curFileHash === entry.fileHash) {
    // No "(read so far: …)" listing: the range is what the model must act on, and
    // echoing the regions it HAS read only invited it to reason about them instead
    // of re-reading the target lines.
    return `Edit rejected: lines ${start}-${end} were not read in ${p}. Read them first — ${args_readHint(p, start, end - start + 1)} — then Edit.`;
  }
  return `Edit rejected: ${p} changed since it was Read (lines ${start}-${end} are not in an intact Read snapshot). Re-run ${args_readHint(p, start, end - start + 1)} to get the current content, then Edit.`;
}


