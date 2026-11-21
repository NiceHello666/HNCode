// Diff construction and syntax colouring for a diff body.
//
// Both halves of one job: an Edit reports what it replaced, and this module turns that into numbered rows and paints
// them. Nothing here knows about the transcript, so a caller can diff without a screen.

import { highlightLine, langForPath } from './highlight.js';

/**
 * How many unchanged lines to keep either side of a change, when a diff is elided.
 *
 * FIVE, not three: three was too few to place a change among near-identical neighbours — several small functions, or
 * two `}` a couple of rows apart, look the same inside a three-row window — and the rows just past the window are
 * exactly what a reader uses to tell one site from another.
 *
 * Shared by both builders so a change can never be shown with one amount of surrounding context in the model's tool
 * result and another on screen.
 */
export const DIFF_CONTEXT_LINES = 5;

/**
 * Colour one line of code, carrying block-comment state across rows.
 *
 * The state matters: a block comment that opens on one row and closes on the next left the second row looking like
 * ordinary code, so `extends` and `const` inside a comment were coloured as keywords.
 *
 * @param {string} text The row.
 * @param {object} lang The language entry, or null.
 * @param {string} bg The background colour, or '' for none.
 * @param {boolean} [inComment] Whether the previous row ended inside a block comment.
 * @returns {{text: string, inComment: boolean}}
 */
export function paintCode(text, lang, bg, inComment = false) {
  const result = lang ? highlightLine(text, lang, inComment) : { text: String(text), inComment: false };
  const raw = result.text;
  if (!bg) return result;
  // THE BACKGROUND GOES ON BEFORE ANY TOKEN COLOUR AND COMES BACK AFTER EVERY RESET.
  //
  // Prefixing only after `\x1b[0m` left the run of text BEFORE the first token uncoloured — a comment line has its
  // whole body inside one token, so it drew with no wash at all while the code below it was washed, and the block
  // looked striped. Seeding the background at the front covers that first run; the replacement covers every run after
  // it, because each token closes with a reset that would otherwise drop back to the page background.
  //
  // ESC[39m, NOT ESC[0m: a bare reset clears the background too, and the row's wash must survive past the last token.
  // The final glyph is still inside the coloured run, so nothing is left over to clear.
  return { text: bg + raw.replace(/\x1b\[0m/g, `\x1b[0m${bg}`) + '\x1b[39m', inComment: result.inComment };
}

/**
 * Align two line arrays into `same` / `del` / `add` steps (longest common subsequence).
 *
 * The table is O(n*m), which is right for the block an edit replaces — a handful of lines — and wrong for a whole
 * file. Past the cap on either side it falls back to "everything replaced", which is exactly what the old code always
 * did, so a pathological case is no worse than before and the common one is much better.
 */
export function alignLines(a, b) {
  const n = a.length;
  const m = b.length;
  const MAX = 400;
  const all = () => [
    ...a.map((_, i) => ({ op: 'del', a: i, b: 0 })),
    ...b.map((_, j) => ({ op: 'add', a: 0, b: j })),
  ];
  if (n * m > MAX * MAX) return all();

  // `dp[i][j]` is the LCS length of a[i..] against b[j..], filled from the bottom right.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const steps = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { steps.push({ op: 'same', a: i, b: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { steps.push({ op: 'del', a: i, b: j }); i++; }
    else { steps.push({ op: 'add', a: i, b: j }); j++; }
  }
  while (i < n) { steps.push({ op: 'del', a: i, b: j }); i++; }
  while (j < m) { steps.push({ op: 'add', a: i, b: j }); j++; }
  return steps;
}

/**
 * Drop context rows further than DIFF_CONTEXT_LINES from any change, one `gap` per run.
 *
 * Shared by both diff builders so a change can never be shown with one amount of surrounding context in the model's
 * tool result and another on screen.
 */
export function elideContext(raw) {
  const isChange = (k) => raw[k] && raw[k].type !== 'ctx';
  const out = [];
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== 'ctx') { out.push(raw[k]); continue; }
    // Distance to the NEAREST change on either side; keep when within the window.
    let dist = Infinity;
    for (let t = k - 1; t >= 0 && t >= k - DIFF_CONTEXT_LINES; t--) { if (isChange(t)) { dist = Math.min(dist, k - t); break; } }
    for (let t = k + 1; t < raw.length && t <= k + DIFF_CONTEXT_LINES; t++) { if (isChange(t)) { dist = Math.min(dist, t - k); break; } }
    if (dist <= DIFF_CONTEXT_LINES) { out.push(raw[k]); continue; }
    // Elide this context row, marking the gap once.
    if (out.length && out[out.length - 1].type !== 'gap') out.push({ type: 'gap' });
  }
  return out;
}

/**
 * Rows for an Edit, from the tool's own diff payload.
 *
 * The tool KNOWS what it replaced, so there is nothing to infer: the surrounding lines it reports are context, its
 * `old` is what went, its `new` is what arrived. Running the spliced text through `lineDiff`'s LCS instead made it
 * MIS-READ them — a context block prepended to the old text and appended to the new has a different shape on each
 * side, so the LCS paired the wrong lines and rendered five unchanged context rows as `-`/`+` pairs.
 *
 * Rows are numbered from the real file: `before` carries its own line numbers, and the change starts at `startLine`.
 */
export function editDiffRows(diff) {
  if (!diff || typeof diff.old !== 'string' || typeof diff.new !== 'string') return [];
  // An empty side is ZERO lines and a trailing newline is not a line: `''.split('\n')` is `['']`, which drew a
  // phantom blank row, and `'a\n'` split to `['a', '']`, which drew one past the end.
  const split = (s) => {
    const t = String(s).replace(/\r\n/g, '\n').replace(/\n$/, '');
    return t === '' ? [] : t.split('\n');
  };
  const ctx = diff.context || {};
  const before = Array.isArray(ctx.before) ? ctx.before : [];
  const after = Array.isArray(ctx.after) ? ctx.after : [];
  const startLine = Number(diff.startLine) > 0 ? Number(diff.startLine) : 1;

  // AN EDIT THAT CHANGED ONE LINE SHOWS ONE LINE CHANGED.
  //
  // Emitting every old line as `del` and every new line as `add` meant replacing three lines whose last one changed
  // produced three deletions and three additions — the two identical lines scrolled past as noise and the one real
  // change was buried. Aligning the two sides and emitting the unchanged pairs as CONTEXT is what a diff is.
  const oldLines = split(diff.old);
  const newLines = split(diff.new);

  const out = [];
  for (const c of before) out.push({ type: 'ctx', text: String(c.text), no: c.n });
  let oldNo = startLine;
  let newNo = startLine;
  const steps = alignLines(oldLines, newLines);
  for (let k = 0; k < steps.length; k++) {
    const step = steps[k];
    if (step.op === 'same') { out.push({ type: 'ctx', text: oldLines[step.a], no: newNo }); oldNo++; newNo++; continue; }
    if (step.op === 'del') { out.push({ type: 'del', text: oldLines[step.a], no: oldNo++ }); continue; }
    out.push({ type: 'add', text: newLines[step.b], no: newNo++ });
  }
  for (const c of after) out.push({ type: 'ctx', text: String(c.text), no: c.n });
  // THE LANGUAGE TRAVELS WITH THE ROWS. The renderer draws a diff several layers away from the tool call, with no
  // path of its own, so resolving the highlighter here — from the diff's own `path` — is the only place that still
  // knows what file this is.
  const lang = diff.path ? langForPath(diff.path) : null;
  if (lang) for (const r of out) r.lang = lang;
  return elideContext(out);
}

/**
 * A diff between two whole strings, for callers that have the text rather than a tool payload.
 *
 * Same window rule as `editDiffRows`, from the one helper: a change must never be shown with a different amount of
 * surrounding context on screen and in the model's tool result.
 */
export function lineDiff(oldStr, newStr, startLine = 1) {
  const a = String(oldStr == null ? '' : oldStr).replace(/\r\n/g, '\n').split('\n');
  const b = String(newStr == null ? '' : newStr).replace(/\r\n/g, '\n').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw = [];
  let i = 0, j = 0;
  // Line numbers as they appear in the real file (startLine = first old line).
  let oldNo = startLine, newNo = startLine;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ type: 'ctx', text: a[i], no: oldNo }); i++; j++; oldNo++; newNo++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ type: 'del', text: a[i], no: oldNo }); i++; oldNo++; }
    else { raw.push({ type: 'add', text: b[j], no: newNo }); j++; newNo++; }
  }
  while (i < n) { raw.push({ type: 'del', text: a[i], no: oldNo }); i++; oldNo++; }
  while (j < m) { raw.push({ type: 'add', text: b[j], no: newNo }); j++; newNo++; }
  return elideContext(raw);
}
