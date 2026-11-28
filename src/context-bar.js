// The segmented context bar: used tokens by content type, then the remainder as one free
// segment whose right edge carries the usage readout.
//
// WHY A BAR AND NOT A NUMBER
// -------------------------
// `context: 12% (1.2k/97.7k)` says how full the window is and nothing about what filled
// it. The bar answers the question people actually have — "why is this getting full" — by
// making the composition readable: a session that grew from tool output looks different
// from one that grew from long answers, without reading a single figure.
//
// THE SHAPE OF THE ALLOCATION
// --------------------------
// Two passes, because plain rounding is wrong in both directions:
//
//   1. Every non-zero segment is guaranteed ONE column. Without this, a segment holding
//      0.3% of the window rounds to zero columns and disappears — and "thinking is a small
//      share" is exactly the fact a user is looking for.
//   2. The remaining columns are shared proportionally by LARGEST REMAINDER. Rounding each
//      share independently gives a total that is off by one or two, so the bar either falls
//      short of the row or overruns it.
//
// THE THREE-STEP LABEL
// -------------------
// Each segment says as much about itself as fits, because the segments are often only a
// few columns wide and there are three different things it could say:
//
//   1. `name + value` when the segment is wide enough for both — `ast 4.4k`
//   2. the name alone when only that fits — `ast`
//   3. nothing at all when not even the abbreviation does
//
// Steps 2 and 3 are not dead ends: every segment's columns are returned as a hit span, so
// pointing at one prints its full name and value in the row below the bar. That is why step
// 3 is acceptable — the information stays one pointer away.

import { C } from './colors.js';
import { uiText } from './i18n.js';

/** The segments, in the order they are drawn. Order is part of the reading: the session
 *  grows from left to right in the same sequence the context does. */
export const SEGMENTS = [
  { key: 'system', name: 'system prompt', fill: C.ctxSystem },
  { key: 'prompt', name: 'user messages', fill: C.ctxPrompt },
  { key: 'assistant', name: 'assistant', fill: C.ctxAssistant },
  { key: 'thinking', name: 'thinking', fill: C.ctxThinking },
  { key: 'tools', name: 'tool results', fill: C.ctxTools },
];

// `labelFor` closes over `compactTokens`, which is declared below — hoisted function
// declarations make that safe, and keeping the forms next to the metadata is what stops the
// on-bar label and the hover caption from drifting apart.
//
// There is no abbreviation: `ast` says nothing to somebody who does not already know what
// the bar is, and a full word that does not fit is handled by DROPPING it, not by
// shortening it into a private code. The three-step degradation in `paintBar` is what makes
// that affordable — a wide segment gets `assistant 4.4k`, a narrow one gets `assistant`, and
// a very narrow one gets nothing and relies on the hover caption instead.
for (const seg of SEGMENTS) {
  seg.labelFor = (tokens) => {
    const v = compactTokens(tokens);
    // Translate at render time, not at definition: uiLang is set when the TUI starts.
    const name = uiText(seg.name);
    return { name, full: `${name} ${v}`, value: v, title: name };
  };
}
/** The caption a hovered segment produces: `assistant 4.4k`. */
/** The caption a hovered segment produces: `assistant 4.4k`. */
export function segmentCaption(key, tokens) {
  const seg = SEGMENTS.find((s) => s.key === key);
  return `${uiText(seg.name)} ${compactTokens(tokens)}`;
}

/**
 * Give every non-zero segment at least one column, then share the rest proportionally.
 *
 * @param {readonly number[]} values one per segment, plus the free segment last.
 * @param {number} width columns available.
 * @returns {number[]} columns per entry, summing to at most `width`.
 */
export function allocateBarColumns(values, width) {
  const used = SEGMENTS
    .map((_, i) => i)
    .filter((i) => (values[i] || 0) > 0);
  if (used.length === 0 || used.length >= width) return shareLargestRemainder(values, width);

  const minimum = values.map(() => 0);
  for (const i of used) minimum[i] = 1;
  const rest = shareLargestRemainder(values, width - used.length);
  return minimum.map((m, i) => m + (rest[i] || 0));
}

/**
 * Proportional split by LARGEST REMAINDER: floor each share, then hand the columns left
 * over to the biggest fractional parts, largest first. This is what makes the parts sum to
 * exactly `width`; rounding each independently does not.
 */
function shareLargestRemainder(values, width) {
  const total = values.reduce((a, b) => a + (b || 0), 0);
  if (!(total > 0) || !(width > 0)) return values.map(() => 0);

  const exact = values.map((v) => ((v || 0) / total) * width);
  const floors = exact.map((x) => Math.floor(x));
  let left = width - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);   // stable on index for equal fractions
  for (let k = 0; left > 0; k++, left--) floors[order[k % order.length].i]++;
  return floors;
}

/**
 * The bar and its readout, filling exactly `width` columns together.
 *
 * THE READOUT GETS ITS SPACE FIRST, AND THE BAR IS WHAT GIVES UP. Laying it out the other
 * way round — bar across the full row, readout painted on top of the free segment — means
 * the readout disappears the moment the window fills, because a full window has no free
 * segment at all. That is the one moment the figure matters most, and it was the one moment
 * it could not be seen.
 *
 * So the row is split: the readout claims the columns it needs (one gap before it, so the
 * figures do not read as part of a segment), and the bar takes whatever is left. The bar can
 * therefore never reach the readout, at any fill level, and the readout is never truncated
 * into nonsense like `11.7k/97`.
 *
 * @param {Record<string, number>} segments tokens per content type.
 * @param {number} usedTokens total used, driving the readout.
 * @param {number} window the context window, or 0 when unknown.
 * @param {number} width columns to fill.
 * @param {string} [readout] the caller's own wording, e.g. `context: 12% (11.7k/97.7k)`.
 *   Preferred over the derived one because it is what the status line already said; when the
 *   row is too narrow for it, the derived form takes over, and failing that just the
 *   percentage — a readout that is always SOMETHING beats one that is sometimes absent.
 * @returns {{ text: string, hits: Array<{col0: number, col1: number, data: string}> }}
 *   `text` occupies exactly `width` columns; `hits` cover the bar's segments only.
 */
export function renderContextBar(segments, usedTokens, window, width, readout) {
  if (!(width > 0) || !(window > 0)) return { text: '', hits: [] };
  // Widest form first, then the derived ones, so the row always carries SOMETHING. A
  // half-printed `11.7k/97` is worse than a bare percentage, so each step is a complete
  // alternative rather than a truncation.
  const pct = `${((usedTokens / window) * 100).toFixed(1)}%`;
  const figures = `${compactTokens(usedTokens)}/${compactTokens(window)}`;
  const own = typeof readout === 'string' ? readout : '';
  const forms = [...new Set([own, `${figures} ${pct}`, pct].filter(Boolean))];
  const text = forms.find((f) => f.length + 1 <= width) || '';
  const barWidth = Math.max(0, width - text.length - 1);

  if (barWidth <= 0) {
    // Too narrow for a bar AND a gap: the readout has the row to itself. Padded to exactly
    // `width` because every row of the frame is, and a short one shifts everything below it.
    return { text: text ? C.white + text.padEnd(width) : ' '.repeat(width), hits: [] };
  }

  const free = Math.max(0, window - usedTokens);
  const values = [...SEGMENTS.map((s) => segments[s.key] || 0), free];
  const cols = allocateBarColumns(values, barWidth);
  return paintBar(cols, cols[cols.length - 1] || 0, '', values, text, width);
}

/**
 * Paint the allocated columns, then the readout.
 *
 * Each segment carries as much of its own label as fits, measured against the segment's OWN
 * width, so a label can never spill into its neighbour and shift every segment to the right
 * of it.
 *
 * @param {number[]} cols columns per entry, the last being the free segment.
 * @param {number} freeCols the free segment's width, already included in `cols`.
 * @param {string} _unused kept for call-shape stability; the readout no longer lives inside
 *   the free segment, so nothing is painted into it here.
 * @param {number[]} values tokens per segment, driving each label.
 * @param {string} readout the text set after the bar, on the page background rather than on
 *   any fill — so it is legible at every fill level, including a completely full bar.
 * @param {number} width the whole row, bar plus readout.
 */
function paintBar(cols, freeCols, _unused, values, readout, width) {
  let out = '';
  let at = 0;                       // visible column the next segment starts at
  const hits = [];

  for (let i = 0; i < SEGMENTS.length; i++) {
    const n = cols[i] || 0;
    if (!n) continue;
    const seg = SEGMENTS[i];
    const label = seg.labelFor(values[i]);
    // One blank column on EACH side of the label. The right one keeps two adjacent short
    // labels from running together (`thinkingtool results`) and making the boundary between
    // them invisible; the left one stops the text from sitting hard against the edge of its
    // own fill, which reads as if the label belonged to the segment before it. The first
    // segment's left column is the row's own margin, so both cost the same.
    const room = n - 2;
    const inner = room >= label.full.length
      ? label.full
      : (room >= label.name.length ? label.name : '');
    // `room` columns of label, a blank on the left and one on the right: `n`.
    out += seg.fill + (inner ? ' ' + C.white + inner.padEnd(room, ' ') + ' ' : ' '.repeat(n));
    hits.push({ col0: at, col1: at + n - 1, data: seg.key });
    at += n;
  }
  // The free segment needs SPACES, not just its fill colour: a background colour on its own
  // paints nothing, so the "how much room is left" band vanished the moment the readout moved
  // out of it. It was only ever visible because the readout used to sit on those cells.
  if (freeCols) { out += C.ctxFree + ' '.repeat(freeCols); at += freeCols; }

  // The readout goes AFTER the bar, on the page background, in the columns the caller
  // reserved for it. `C.reset` first: the last thing the bar emitted was a fill, and a
  // background colour behind the figures would be a band nobody asked for.
  //
  // `at` is the bar's visible width and the row is `width` wide, so the gap is whatever is
  // left minus the figures — at least one column, which is what keeps `11.7k/97` from reading
  // as a continuation of a segment's fill.
  const gap = Math.max(1, width - at - readout.length);
  out += C.reset + ' '.repeat(gap) + C.white + readout;

  return { text: out + C.reset, hits };
}

/**
 * The right-hand readout, stepped down as its segment narrows: the full form, then the
 * percentage alone, then nothing. A half-printed `11.7k/97` is worse than no number.
 */
export function formatReadout(used, window, freeCols) {
  const pct = `${((used / window) * 100).toFixed(1)}%`;
  const full = `${compactTokens(used)}/${compactTokens(window)} ${pct}`;
  // The thresholds match the renderer's own condition exactly (`freeCols >= length`). They
  // used to ask for one more, which is how the bar came up a column short: the readout was
  // accepted HERE and then not written THERE.
  if (freeCols >= full.length) return full;
  if (freeCols >= pct.length) return pct;
  return '';
}

/**
 * A token count as a compact string: `1200` -> `1.2k`, `97000` -> `97k`, `3400000` -> `3.4M`.
 *
 * Deliberately the SAME shape `fmtTokensShort` produces for the working row, because both appear
 * in one frame — the context bar and the live turn counter would otherwise disagree about the same
 * quantity. Two rules:
 *
 *   * one decimal while it carries information, dropped when it is a zero (`97000` is `97k`, not
 *     `97.0k` — the trailing `.0` is three characters saying nothing);
 *   * K/M/B/T suffixes, with only the kilo lower-case, so `3.4M` here and `3.4M` on the working row
 *     read as one vocabulary.
 *
 * The previous version kept `.0` and disagreed with the working row on units entirely: it divided
 * by 1024 where the row divided by 1000, so a 97k context read `94.7k` beside a `97k` turn.
 */
export function compactTokens(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const units = [
    { at: 1e12, suffix: 'T' },
    { at: 1e9, suffix: 'B' },
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'k' },
  ];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (v < u.at) continue;
    // The identical scaling rule the working row and the /ctx readout use: one decimal below 100,
    // whole numbers above. Three formatters render token counts into one frame, so a single rule is
    // the only way `262k` cannot appear beside `262.1k` for the same quantity.
    const shown = scaleUnit(v / u.at);
    // Rounding can reach the next unit (`999999` is `1000k`, which is `1m`), and showing `1000k`
    // makes the reader convert a unit themselves.
    if (Number(shown) >= 1000 && i > 0) return `${scaleUnit(v / units[i - 1].at)}${units[i - 1].suffix}`;
    return `${shown}${u.suffix}`;
  }
  return String(v);
}

/**
 * One unit's worth of a count: `1.2`, `97`, `262`.
 *
 * Duplicated from tui.js rather than imported, because `context-bar.js` must stay a leaf module the
 * TUI can import without a cycle. The two are pinned together by test/context-bar.test.mjs and
 * test/working-tokens.test.mjs, which assert the same table of values through both.
 */
function scaleUnit(v) {
  return v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
}
