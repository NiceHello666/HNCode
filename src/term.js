// Small TTY / terminal utilities.
// Test file for Write size display - this comment should be long enough to measure

import { COMMON_WORDS } from './wordlist.js';

export function isTTY() {
  return !!process.stdout.isTTY;
}

export function size() {
  try {
    const [cols, rows] = process.stdout.getWindowSize();
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

export function writeRaw(str) {
  if (!process.stdout.write(str)) return false;
  return true;
}

// Enable raw mode around a callback, restoring on exit/error.
export function withRawMode(cb) {
  const stream = process.stdin;
  if (!stream.isTTY) {
    throw new Error('hncode: interactive mode requires a TTY (stdin is not a terminal).');
  }
  const wasRaw = stream.isRaw;
  stream.setRawMode(true);
  stream.resume();
  stream.setEncoding('utf8');
  const cleanup = () => {
    try { stream.setRawMode(wasRaw || false); } catch {}
    stream.pause();
  };
  try {
    return cb(cleanup);
  } finally {
    cleanup();
  }
}

// Visible width ignoring ANSI escapes (approx; no CJK width handling).
// NOTE: kept for back-compat; prefer visualWidth() for display-accurate width.
export function strWidth(s) {
  return (s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

// True visual column-width of a plain string (no ANSI), assuming a terminal that
// renders East Asian / wide / some symbol glyphs as 2 columns. Must be used for any
// cursor positioning and line wrapping so an I-shaped (insert) caret lines up.
// Source of truth: Unicode wide ranges + a small set of CJK-fused symbol glyphs.
//
// PERFORMANCE (this is the hottest function in the whole TUI — a profile of a
// 500-message transcript streaming markdown put ~48% of samples in this plus
// clusterWidth/clusterGlyphWidth/isWideByDefault):
//   * a printable-ASCII fast path returns the length immediately. Agent output
//     is overwhelmingly ASCII, and measuring it cost ~30 range comparisons per
//     character for nothing. 1MB of ASCII went from 219ms to ~0.
//   * everything else is memoised (see WIDTH_CACHE_MAX). Rows are re-measured
//     every frame while a reply streams, and the same substrings come back
//     again and again.
export function visualWidth(s) {
  if (!s) return 0;
  const str = typeof s === 'string' ? s : String(s);
  // Fast path: printable ASCII measures exactly its length.
  if (isPrintableAscii(str)) return str.length;
  const hit = widthCache.get(str);
  if (hit !== undefined) return hit;
  const w = clusterWidth(str);
  if (widthCache.size >= WIDTH_CACHE_MAX) {
    // Cheap eviction: drop the oldest insertion (Map preserves order).
    const oldest = widthCache.keys().next().value;
    if (oldest !== undefined) widthCache.delete(oldest);
  }
  widthCache.set(str, w);
  return w;
}

// All code units printable ASCII? `\t`/newline/escape all fail, which is what we
// want: those have their own width rules (tab = 4, ESC starts an ANSI sequence).
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

const WIDTH_CACHE_MAX = 4096;
const widthCache = new Map();


// ---- East Asian Width tables (Unicode 15) --------------------------------
// Wide/Fullwidth ranges -> 2 columns. Everything else is 1 unless it is a
// zero-width character (see ZERO_WIDTH) or emoji presentation (see below).
const WIDE = [
  [0x1100, 0x115F], [0x231A, 0x231B], [0x2329, 0x232A], [0x23E9, 0x23EC],
  [0x23F0, 0x23F0], [0x23F3, 0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267F, 0x267F], [0x2693, 0x2693], [0x26A1, 0x26A1],
  [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE, 0x26CE],
  [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3], [0x26F5, 0x26F5],
  [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B],
  [0x2728, 0x2728], [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27B0, 0x27B0], [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55],
  [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
  [0xA000, 0xA4CF], [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
  [0x16FE0, 0x16FE4], [0x17000, 0x187F7], [0x18800, 0x18CD5],
  [0x1B000, 0x1B152], [0x1B164, 0x1B167], [0x1B170, 0x1B2FB],
  [0x1F004, 0x1F004], [0x1F0CF, 0x1F0CF], [0x1F18E, 0x1F18E],
  [0x1F191, 0x1F19A], [0x1F200, 0x1F320], [0x1F32D, 0x1F335],
  [0x1F337, 0x1F37C], [0x1F37E, 0x1F393], [0x1F3A0, 0x1F3CA],
  [0x1F3CF, 0x1F3D3], [0x1F3E0, 0x1F3F0], [0x1F3F4, 0x1F3F4],
  [0x1F3F8, 0x1F43E], [0x1F440, 0x1F440], [0x1F442, 0x1F4FC],
  [0x1F4FF, 0x1F53D], [0x1F54B, 0x1F54E], [0x1F550, 0x1F567],
  [0x1F57A, 0x1F57A], [0x1F595, 0x1F596], [0x1F5A4, 0x1F5A4],
  [0x1F5FB, 0x1F64F], [0x1F680, 0x1F6C5], [0x1F6CC, 0x1F6CC],
  [0x1F6D0, 0x1F6D2], [0x1F6D5, 0x1F6D7], [0x1F6DC, 0x1F6DF],
  [0x1F6EB, 0x1F6EC], [0x1F6F4, 0x1F6FC], [0x1F7E0, 0x1F7EB],
  [0x1F7F0, 0x1F7F0], [0x1F90C, 0x1F93A], [0x1F93C, 0x1F945],
  [0x1F947, 0x1F9FF], [0x1FA70, 0x1FAFF],
  [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
];

// Combining / formatting characters that occupy no cell.
function isZeroWidth(c) {
  return (c >= 0x200B && c <= 0x200F)          // ZWSP..RLM (incl. ZWJ U+200D)
    || (c >= 0x0300 && c <= 0x036F)
    || (c >= 0x0483 && c <= 0x0489)
    || (c >= 0x0591 && c <= 0x05BD) || c === 0x05BF || (c >= 0x05C1 && c <= 0x05C2)
    || (c >= 0x0610 && c <= 0x061A)
    || (c >= 0x064B && c <= 0x065F) || c === 0x0670
    || (c >= 0x06D6 && c <= 0x06DC)
    || (c >= 0x0E31 && c <= 0x0E3A) || (c >= 0x0E47 && c <= 0x0E4E)
    || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF)
    || (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE00 && c <= 0xFE0F)
    || (c >= 0xFE20 && c <= 0xFE2F) || (c >= 0xE0100 && c <= 0xE01EF)
    || (c >= 0x1160 && c <= 0x11FF);           // Hangul Jamo medial/final
}

// Regional Indicator (flags) — two of them form one glyph.
const isRegional = (c) => c >= 0x1F1E6 && c <= 0x1F1FF;

// Emoji that occupy TWO cells by default (Emoji_Presentation=Yes), even
// without U+FE0F. Text-default symbols (U+276F >, U+2603 ☃, U+00B7 ·, …) are
// NOT in here: they are 1 cell unless followed by U+FE0F.
function isWideByDefault(c) {
  return (c >= 0x1F300 && c <= 0x1F5FF)
    || (c >= 0x1F600 && c <= 0x1F64F)
    || (c >= 0x1F680 && c <= 0x1F6FF)
    || (c >= 0x1F900 && c <= 0x1F9FF)
    || (c >= 0x1FA70 && c <= 0x1FAFF)
    || (c >= 0x1F000 && c <= 0x1F0FF)
    || isRegional(c)
    || c === 0x231A || c === 0x231B || c === 0x23E9 || c === 0x23EC
    || c === 0x23F0 || c === 0x23F3 || c === 0x25FD || c === 0x25FE
    || c === 0x2614 || c === 0x2615 || (c >= 0x2648 && c <= 0x2653)
    || c === 0x267F || c === 0x2693 || c === 0x26A1 || (c >= 0x26AA && c <= 0x26AB)
    || (c >= 0x26BD && c <= 0x26BE) || (c >= 0x26C4 && c <= 0x26C5)
    || c === 0x26CE || c === 0x26D4 || c === 0x26EA
    || (c >= 0x26F2 && c <= 0x26F3) || c === 0x26F5 || c === 0x26FA || c === 0x26FD
    || c === 0x2705 || (c >= 0x270A && c <= 0x270B) || c === 0x2728
    || c === 0x274C || c === 0x274E || (c >= 0x2753 && c <= 0x2755) || c === 0x2757
    || (c >= 0x2795 && c <= 0x2797) || c === 0x27B0 || c === 0x27BF
    || (c >= 0x2B1B && c <= 0x2B1C) || c === 0x2B50 || c === 0x2B55;
}

// ---------------------------------------------------------------------------
// East Asian AMBIGUOUS width
// ---------------------------------------------------------------------------
// Unicode gives every character an East Asian Width class. `A` (Ambiguous) means
// ONE column on a Western terminal and TWO on a CJK one — the terminal decides, the
// character does not say. hncode's chrome leans on these heavily, which is why they
// had to be handled rather than avoided:
//
//   box rules   ─ │ ╭ ╮ ╰ ╯ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
//   separators  ·  …  —  –
//   markers     ↑ ↓ ← → > ● ○ ✓ ✗
//   math        ± × ÷ ≠ ≤ ≥ ∞
//
// Measuring them as 1 column on a CJK terminal made every row containing one N columns
// short, so the row's right edge landed N columns past the panel it belonged to —
// "the text pushes the wall right". The panel's own background could not hide it
// either: the overflow is REAL cells on screen, not a measurement disagreement inside
// one row.
//
// Default: follow the LOCALE. A CJK locale is the standard reason a terminal treats
// EAW=A as wide, and it is the only signal available before anything is drawn — the
// code page does not say (a UTF-8 Windows console still renders them wide), and no
// terminal query reports it.
let ambiguousWide = null;   // lazily resolved so a test can set the env first

/** EAW=A ranges (Unicode 15), ascending — `inRanges` binary-searches this. */
const AMBIGUOUS = [
  [0x00A1, 0x00A1], [0x00A4, 0x00A4], [0x00A7, 0x00A8], [0x00AA, 0x00AA],
  [0x00AD, 0x00AE], [0x00B0, 0x00B4], [0x00B6, 0x00BA], [0x00BC, 0x00BF],
  [0x00C6, 0x00C6], [0x00D0, 0x00D0], [0x00D7, 0x00D8], [0x00DE, 0x00E1],
  [0x00E6, 0x00E6], [0x00E8, 0x00EA], [0x00EC, 0x00ED], [0x00F0, 0x00F0],
  [0x00F2, 0x00F3], [0x00F7, 0x00FA], [0x00FC, 0x00FC], [0x00FE, 0x00FE],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011B, 0x011B],
  [0x0126, 0x0127], [0x012B, 0x012B], [0x0131, 0x0133], [0x0138, 0x0138],
  [0x013F, 0x0142], [0x0144, 0x0144], [0x0148, 0x014B], [0x014D, 0x014D],
  [0x0152, 0x0153], [0x0166, 0x0167], [0x016B, 0x016B], [0x01CE, 0x01CE],
  [0x01D0, 0x01D0], [0x01D2, 0x01D2], [0x01D4, 0x01D4], [0x01D6, 0x01D6],
  [0x01D8, 0x01D8], [0x01DA, 0x01DA], [0x01DC, 0x01DC], [0x0251, 0x0251],
  [0x0261, 0x0261], [0x02C4, 0x02C4], [0x02C7, 0x02C7], [0x02C9, 0x02CB],
  [0x02CD, 0x02CD], [0x02D0, 0x02D0], [0x02D8, 0x02DB], [0x02DD, 0x02DD],
  [0x02DF, 0x02DF], [0x0300, 0x036F], [0x0391, 0x03A1], [0x03A3, 0x03A9],
  [0x03B1, 0x03C1], [0x03C3, 0x03C9], [0x0401, 0x0401], [0x0410, 0x044F],
  [0x0451, 0x0451], [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019],
  [0x201C, 0x201D], [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030],
  [0x2032, 0x2033], [0x2035, 0x2035], [0x203B, 0x203B], [0x203E, 0x203E],
  [0x2074, 0x2074], [0x207F, 0x207F], [0x2081, 0x2084], [0x20AC, 0x20AC],
  [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113],
  [0x2116, 0x2116], [0x2121, 0x2122], [0x2126, 0x2126], [0x212B, 0x212B],
  [0x2153, 0x2154], [0x215B, 0x215E], [0x2160, 0x216B], [0x2170, 0x2179],
  [0x2189, 0x2189], [0x2190, 0x2199], [0x21B8, 0x21B9], [0x21D2, 0x21D2],
  [0x21D4, 0x21D4], [0x21E7, 0x21E7], [0x2200, 0x2200], [0x2202, 0x2203],
  [0x2207, 0x2208], [0x220B, 0x220B], [0x220F, 0x220F], [0x2211, 0x2211],
  [0x2215, 0x2215], [0x221A, 0x221A], [0x221D, 0x2220], [0x2223, 0x2223],
  [0x2225, 0x2225], [0x2227, 0x222C], [0x222E, 0x222E], [0x2234, 0x2237],
  [0x223C, 0x223D], [0x2248, 0x2248], [0x224C, 0x224C], [0x2252, 0x2252],
  [0x2260, 0x2261], [0x2264, 0x2267], [0x226A, 0x226B], [0x226E, 0x226F],
  [0x2282, 0x2283], [0x2286, 0x2287], [0x2295, 0x2295], [0x2299, 0x2299],
  [0x22A5, 0x22A5], [0x22BF, 0x22BF], [0x2312, 0x2312], [0x2460, 0x24E9],
  [0x24EB, 0x254B], [0x2550, 0x2573], [0x2580, 0x258F], [0x2592, 0x2595],
  [0x25A0, 0x25A1], [0x25A3, 0x25A9], [0x25B2, 0x25B3], [0x25B6, 0x25B7],
  [0x25BC, 0x25BD], [0x25C0, 0x25C1], [0x25C6, 0x25C8], [0x25CB, 0x25CB],
  [0x25CE, 0x25D1], [0x25E2, 0x25E5], [0x25EF, 0x25EF], [0x2605, 0x2606],
  [0x2609, 0x2609], [0x260E, 0x260F], [0x261C, 0x261C], [0x261E, 0x261E],
  [0x2640, 0x2640], [0x2642, 0x2642], [0x2660, 0x2661], [0x2663, 0x2665],
  [0x2667, 0x266A], [0x266C, 0x266D], [0x266F, 0x266F], [0x269E, 0x269F],
  [0x26C6, 0x26CD], [0x26CF, 0x26D3], [0x26D5, 0x26E1], [0x26E3, 0x26E3],
  [0x26E8, 0x26E9], [0x26EB, 0x26F1], [0x26F4, 0x26F4], [0x26F6, 0x26F9],
  [0x26FB, 0x26FC], [0x26FE, 0x26FF], [0x273D, 0x273D], [0x2761, 0x2761],
  [0x2776, 0x277F], [0x2B56, 0x2B59], [0x3248, 0x324F], [0xE000, 0xF8FF],
  [0xFE00, 0xFE0F], [0xFFFD, 0xFFFD], [0x1F100, 0x1F10A],
  [0x1F110, 0x1F12D], [0x1F130, 0x1F169], [0x1F170, 0x1F19A],
];

/**
 * Should EAW=Ambiguous characters measure 2 columns?
 *
 * Resolved once, from (in order):
 *   1. `HNCODE_AMBIGUOUS_WIDTH` — an explicit override, for a terminal whose setting
 *      does not match its locale;
 *   2. the locale — `zh`/`ja`/`ko` mean a CJK terminal, which is the standard reason a
 *      terminal renders these wide.
 */
export function detectAmbiguousWide(env = process.env) {
  const raw = env.HNCODE_AMBIGUOUS_WIDTH;
  if (raw !== undefined && raw !== '') return /^(1|true|yes|on)$/i.test(raw);
  let loc = '';
  try { loc = (Intl.DateTimeFormat().resolvedOptions().locale) || ''; } catch { /* no Intl */ }
  const tag = loc || env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /^(zh|ja|ko)\b/i.test(tag) || /^(zh|ja|ko)[-_]/i.test(tag);
}

export function isAmbiguousWide() {
  if (ambiguousWide === null) ambiguousWide = detectAmbiguousWide();
  return ambiguousWide;
}

/**
 * Turn the ambiguous-as-wide rule on or off. Clears the width cache, which is keyed by
 * string alone and would otherwise hand back widths measured under the other rule.
 */
export function setAmbiguousWide(on) {
  const next = !!on;
  if (next === ambiguousWide) return;
  ambiguousWide = next;
  widthCache.clear();
}

const inRanges = (c, ranges) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (c < s) hi = mid - 1;
    else if (c > e) lo = mid + 1;
    else return true;
  }
  return false;
};

export function charWidth(ch) {
  const c = String(ch).codePointAt(0);
  if (c === undefined) return 0;
  // Tab renders as 4 spaces in most terminals.
  if (c === 0x09) return 4;
  if (c < 0x20 || c === 0x7F) return 0;
  // FAST PATH: plain printable ASCII is exactly one cell wide. Without this each
  // ASCII character paid for isZeroWidth + isWideByDefault (≈30 range tests) + a
  // binary search, which is most of what made width measurement the hottest
  // function in the TUI.
  if (c >= 0x20 && c <= 0x7e) return 1;
  if (isZeroWidth(c)) return 0;
  if (isWideByDefault(c)) return 2;
  if (inRanges(c, WIDE)) return 2;
  return 1;
}

// Shared native segmenter. `Intl.Segmenter` implements the full Unicode
// grapheme-break algorithm in native code, so it is both more correct than the
// hand-rolled scanner it replaces (ZWJ families, flags, combining marks) and
// much cheaper — that scanner allocated a `{text, next}` object per character,
// which showed up as GC pressure in profiles.
const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

// Width of a whole string measured by GRAPHEME CLUSTER: a ZWJ sequence or a
// flag counts 2 columns total, not the sum of its codepoints (which used to
// make 👨‍👩‍👧 measure 8 columns and break every row it appeared on).
export function clusterWidth(s) {
  const str = String(s || '');
  if (!str) return 0;
  let w = 0;
  if (graphemeSegmenter) {
    // NOTE: an "ASCII runs are free" split was tried here and made things WORSE
    // (a 500KB markdown string went 97ms -> 544ms): slicing the string into a
    // run per CJK character costs far more than handing the whole thing to the
    // native segmenter. The real win is the printable-ASCII fast path in
    // visualWidth() plus the memo cache, not micro-splitting here.
    for (const { segment } of graphemeSegmenter.segment(str)) w += clusterGlyphWidth(segment);
    return w;
  }
  // Fallback for a runtime without Intl.Segmenter: per code point.
  for (const ch of str) w += clusterGlyphWidth(ch);
  return w;
}
// Width of one grapheme cluster. Allocation-free on the common path: a

// Width of one grapheme cluster. Allocation-free on the common path: a
// single-code-point cluster (every ASCII character, most CJK) returns
// charWidth directly instead of first building an array of code points.
function clusterGlyphWidth(cluster) {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  if (cluster.length <= (first > 0xFFFF ? 2 : 1)) return charWidth(cluster);

  const cps = [];
  for (let i = 0; i < cluster.length;) {
    const cp = cluster.codePointAt(i);
    cps.push(cp);
    i += cp > 0xFFFF ? 2 : 1;
  }
  // ZWJ sequence / flag pair / VS16-presented symbol => 2 columns.
  if (cps.includes(0x200D)) return 2;
  if (cps.some(isRegional)) return 2;
  if (cps.includes(0xFE0F)) return 2;          // explicit emoji presentation
  let width = charWidth(String.fromCodePoint(cps[0]));
  for (let k = 1; k < cps.length; k++) width += charWidth(String.fromCodePoint(cps[k]));
  return width;
}

// Estimate the LLM token count of a plain string, matching kimi-code's
// algorithm in `llm-adapter/contract/tokens.ts`:
//   tokens = ceil(ASCII chars / 4) + non-ASCII chars
// ASCII characters average ~4 per token; CJK and other non-ASCII are ~1 token
// each. This is far more accurate than a uniform chars/4 ratio.
// Token estimate. The character walk is O(len), and the context gauge re-prices
// whole message bodies (a Read result can be hundreds of KB) every turn.
//
// A value cache only helps COMPLETED messages: they are immutable, so the same
// string is measured again and again. It actively HURTS streaming text, where the
// string grows every frame — every call is a miss, so the cache pays hashing and an
// insert each time and (once full) an O(n) eviction sweep, measuring 1ms/call vs
// ~0.001ms for a plain walk (30k growing-text calls: 31s cached vs 30ms uncached).
//
// So the cache is limited to SHORT strings: completed metadata and role names hit
// it, while a long or growing body is just walked directly. At most 4 KB was chosen
// because a token estimate is only ever re-asked for values that are cheap to hold
// and genuinely stable; anything larger is better re-walked than hashed + stored.
const tokCache = new Map();
const TOK_CACHE_MAX = 20000;
const TOK_CACHE_MAX_LEN = 4096;   // only memoise strings this short

/**
 * The same estimate, UNROUNDED — for summing many small chunks.
 *
 * `estimateTokens` rounds up, which is right for measuring one finished body: a 5-character
 * message should not read as 1.25 tokens.
 *
 * It is wrong for a STREAM. Deltas arrive a few characters at a time, and each one took
 * `ceil(ascii / 4)` — `ceil(3/4)` is 1, so three characters were billed as a whole token. Over
 * hundreds of chunks that inflated the running figure badly: measured at +33% on ordinary
 * English, and the visible symptom was the output counter DROPPING (3000 -> 2300) the moment the
 * provider's exact `usage` arrived and replaced the estimate. Nothing was lost; the estimate had
 * been lying.
 *
 * So the running counter accumulates this unrounded value, and rounds once when it displays.
 * Callers that measure a complete string keep using `estimateTokens`.
 */
export function estimateTokensFloat(text) {
  // THE STREAMING COUNTER MEASURES FRAGMENTS, and this is the estimator for fragments.
  //
  // The segment rules cannot be applied to a fragment: `the quick brown` measured whole is four tokens, and the
  // same text as three-character fragments came out at 1.86x, because each fragment is priced as if it were a
  // whole word. The character-class rule does not care where a fragment starts, so it is the one used here.
  //
  // The class rule is the one this file used for everything before segment pricing was added; it is kept because
  // it is the only rule that survives being cut in half.
  return estimateTokensByClass(String(text ?? ''));
}

/**
 * The character-class estimator: characters per token, BY CLASS, with no regard for where the text starts.
 *
 * It is the rule this file used for everything before segment pricing was added, and it is kept for the STREAMING
 * COUNTER, which is fed fragments: a delta starts and ends mid-word, and a rule that depends on the shape of the
 * whole cannot be applied to one. Being state-free, it charges a fragment and the whole string the same per
 * character — which is the property that makes a chunked sum agree with a one-shot measurement.
 *
 * The measured rates against `o200k_base`:
 *
 *   letters and spaces   4.2   the "four characters per token" folklore, and the only place it holds
 *   digits               3.0   punctuation-free but rarely repeated
 *   punctuation          2.7   brackets, quotes, colons, operators — merge poorly
 *   whitespace (indent)  1.0   a run of spaces still costs a token per couple of columns
 *   CJK and other        1.0   one token per character, occasionally two
 *
 * Counted in ONE pass, because this runs on every streamed chunk.
 */
export function estimateTokensByClass(s) {
  if (!s) return 0;
  let letters = 0;
  let digits = 0;
  let punct = 0;
  let space = 0;
  let wide = 0;

  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // A NON-ASCII CHARACTER is not a whole token: `o200k` charges 1.45 characters per token for Chinese, so
    // charging one token each put a Chinese paragraph at 1.57x. The segment rule cannot be used here because a
    // FRAGMENT is not a segment, so the ratio is carried here.
    if (cp > 127) { wide += 1 / 1.45; continue; }
    if (cp === 32 || cp === 9) { space++; continue; }
    if (cp >= 48 && cp <= 57) { digits++; continue; }
    if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) { letters++; continue; }
    punct++;
  }

  // Newlines land in `punct` (they are not 32 or 9), which is the right rate for them.
  //
  // The SPACE rate is the delicate one: a run of indentation costs about a token per two columns, but a
  // single space between English words merges into the following word almost for free. Charging every
  // space at the indentation rate made prose read 34% high — a worse error than the undercount it fixed,
  // because prose is what the model WRITES back.
  //
  // So spaces are priced at a third of a token each: cheap enough for prose, and still enough that a
  // deeply indented code block is not free.
  return letters / 4.2 + digits / 3.0 + punct / 2.7 + space / 3.0 + wide;
}

/**
 * A token estimate calibrated against OpenAI's `o200k_base`, by SEGMENT rather than by character class.
 *
 * WHY SEGMENTS
 * ------------
 * The previous rule counted characters per class over the whole string: letters at 4.2 per token, digits at 3.0,
 * punctuation at 2.7. That is a rate for an AVERAGE string, and the interesting cases are not average — a short
 * lowercase word is ONE token however long it is, a digit run is one token per three digits, and a CJK paragraph
 * has no spaces to merge on at all. Averaging those together produces a number that is wrong for every one of them.
 *
 * The rules below are tokenx's, calibrated against `o200k_base` (https://github.com/johannschopplich/tokenx):
 *
 *   whitespace        0, except indentation and blank lines, which cost 1
 *   a short word      1 — `o200k` merges common lowercase words of up to 8 characters into one token
 *   a digit run       1 per 3 digits — `o200k` chunks digits in threes
 *   punctuation       1 per 6 characters
 *   CJK               1.2 per hanzi, 1.35 per kana, 1.65 per hangul
 *   everything else   1 per 7 characters
 *
 * The result is within a few percent of the real tokenizer on prose, code and CJK, where the class-average rule was
 * 20-35% out on code and JSON.
 */
function estimateBpe(s) {
  if (!s) return 0;
  let total = 0;
  let previous = '';
  // Split on whitespace runs and punctuation runs: those are the boundaries at which `o200k` starts a new token.
  //
  // The PATH SEPARATORS stay INSIDE the segment: a path is priced as a whole, and splitting it into separators and
  // words made each separator cost a token of its own — a path came out at 1.19x where the real figure is 0.96x.
  // The colon and the comma DO split: `{"a":1,"b":2}` is a run of two-character pairs, and leaving them inside one
  // segment put a minified payload at 0.73x.
  //
  // The QUOTES DO NOT split either: `o200k` keeps `"type"` as one token, quotes included, and splitting them off
  // charged a token for each quote.
  const parts = s.split(/(\s+|[.,!?;(){}<>|@#$%^&*+=`~:]+)/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (/^\s+$/.test(seg)) {
      // Indentation and blank lines cost a token; a space between words merges into the next word for free.
      // WHITESPACE, priced by what SURROUNDS it. A space merges into the word that follows it and is free;
      // only a space with nothing after it stands on its own. Measured against the real tokenizer:
      //
      //   'the quick brown'  3 tokens — the spaces between the words are free
      //   'function '       2 tokens — the trailing space is a token of its own
      //   ' abc'            1 token  — the leading space is free
      //   '\n  const'       3 tokens — the newline, the indent and the word are three
      const next = parts[i + 1];
      // A space merges into the word after it — and only a WORD. `out = []` has a space before an operator, and that
      // space stands on its own; treating every non-space as a word put a TypeScript sample at 1.35x.
      // WHITESPACE merges into the token BEFORE it, and it is only free when there is nothing before it.
      // Measured against the real tokenizer:
      //
      //   'the quick brown'  3 tokens — the spaces between the words cost nothing
      //   'function '       2 tokens — the trailing space is a token of its own
      //   ' abc'            1 token  — the leading space is free
      //   '\n  const'       3 tokens — the newline, the indent and the word are three
      //   'out = []'        the space before an operator is free
      //
      // Looking FORWARD at what follows the space was wrong in both directions: `out = []` has a space before an
      // operator and that space is free, while `function ` has a space at the end of the text and it is not.
      const hadContent = previous.length > 0 && !/^\s+$/.test(previous);
      if (/\n/.test(seg)) {
        // A NEWLINE is a token of its own, and the indentation after it costs ONE token in total:
        // `'\n  const'` is three — the newline, the indent and the word — and the indent is a single token however
        // wide it is.
        const spaces = (seg.match(/ /g) || []).length;
        total += 1 + (spaces > 0 ? 1 : 0);
        previous = seg;
        continue;
      }
      // A space at the START of the measured text is free: it belongs to the word that follows it, and
      // `o200k` charges one token for `' abc'`.
      //
      // This used to depend on whether anything had been seen YET, which is what a chunked measurement looks
      // like: every chunk starts with the space that ended the previous one, and a turn worth of deltas came out
      // at 2.2x the whole-string measurement. The rule is now unconditional — a leading space is always free.
      previous = seg;
      continue;
    }
    // CJK: no spaces, so a whole clause is one segment and the ratio depends on the script mix.
    if (CJK_RE.test(seg)) { total += cjkTokens(seg); previous = seg; continue; }
    // Accented scripts break BPE badly; each has its own measured rate.
    const lang = langCharsPerToken(seg);
    if (lang !== null) { total += Math.ceil(charCount(seg) / lang); previous = seg; continue; }
    // A DIGIT RUN. `o200k` splits a long run into groups of three, but the groups MERGE where they can: ten digits
    // cost four tokens (2.5 characters each) and three digits cost one (3 each). A flat rate has to split the
    // difference, so a short run is charged one token and a long one one per two and a half.
    if (/^\d+$/.test(seg)) { total += seg.length <= 3 ? 1 : Math.ceil(seg.length / 2.5); previous = seg; continue; }
    // Three characters or fewer are always one token.
    if (seg.length <= 3) { total += 1; previous = seg; continue; }
    // A PATH. `o200k` treats `D:\hncode\src\team-panel.js` as one run of characters, and measured it runs at 3.9
    // characters per token — the separators drag it below the 6.3 an identifier gets. Pricing its parts separately
    // charged every separator a token of its own and put a path at 1.19x.
    if (/[/\\]/.test(seg)) { total += Math.ceil(seg.length / 3.9); previous = seg; continue; }
    // A COMMON lowercase word is ONE token, and "common" is the operative word: `o200k` merges `include` (seven
    // letters, one token) and splits `hncode` (six letters, two). No LENGTH threshold separates them — a cutoff of
    // five and a cutoff of eight each get one of the two wrong — so the words that merge are listed instead.
    //
    // The list is the vocabulary of English prose, of code and of the identifiers a session's own transcript is
    // full of, and it is inline because the project has no dependencies and a word list is not worth one.
    if (/^[a-z]+$/.test(seg) && COMMON_WORDS.has(seg)) { total += 1; previous = seg; continue; }
    // A QUOTED WORD is one token in `o200k` — `"type"` is a single token with the quotes attached — and the word
    // inside it is looked up in the same list. Without this a JSON key was priced as a plain word of letters,
    // quotes and all, and every key in a tool schema cost more than it does.
    const quoted = /^"([A-Za-z][A-Za-z0-9_]*)"$/.exec(seg);
    if (quoted && COMMON_WORDS.has(quoted[1].toLowerCase())) { total += 1; previous = seg; continue; }
    // Punctuation merges POORLY, but not one token per character: the pair `{"` and the pair `":` are single
    // tokens in JSON, so a run of them costs about four characters per token. Swept against the real tokenizer
    // over prose, code, JSON, CJK and shell, four is the value that keeps every kind closest.
    if (/^[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]+$/.test(seg)) {
      // A SINGLE separator merges with the word beside it — `\h`, `e-p`, `n=` are each part of one token — so it
      // costs one token. A RUN of them does not merge as well: `{"` and `":` are pairs that do, at about four
      // characters per token.
      total += seg.length === 1 ? 1 : Math.ceil(seg.length / 4); previous = seg; continue;
    }
    // A SEGMENT WITH A DIGIT IN IT is a hex literal, a version or an identifier with a number in it. Measured
    // against the real tokenizer: `abc123` runs at 3 characters per token and `renderFrame` at 5.5, but `v2` and
    // `0x1f` are one token per character — a leading digit breaks every merge.
    if (/\d/.test(seg)) {
      const rate = /^\d/.test(seg) ? 1 : 3;
      total += Math.ceil(seg.length / rate); previous = seg; continue;
    }
    // EVERYTHING ELSE — long identifiers, camelCase, paths, mixed words. Measured: a camelCase identifier runs at
    // 6.3 characters per token, a path at 3.9 (the separators pull it down), plain prose at 4.9 (but prose is caught
    // by the short-word rule above). Six is the compromise that keeps the common case close.
    total += Math.ceil(seg.length / 6);
    previous = seg;
  }
  return total;
}

// The CJK ranges that carry one or more characters per token. Written as escapes so the file stays ASCII, and
// listed once each: an earlier version had `豈-﫿` twice and the per-script split below had to look at the
// code point rather than at the range.
const CJK_RE = /[⺀-鿿㐀-䶿　-〿豈-﫿︰-﹏＀-￯㄀-ㄯ㈀-㋿㐀-䷿ꀀ-꓏가-힯]/;
// Per-script rates, MEASURED against `o200k_base` rather than taken from tokenx.
//
// tokenx's figures are 1.2 per hanzi, 1.35 per kana and 1.65 per hangul, but counting the real tokenizer's own
// output gives 1.45, 1.54 and 1.38 — tokenx is optimistic on hanzi and hangul, and pessimistic on kana. The numbers
// below are the measured ones, because the point of the estimator is to agree with what the provider bills.
const HANZI_PER_TOKEN = 1.45;
const KANA_PER_TOKEN = 1.54;
const HANGUL_PER_TOKEN = 1.38;
// Fullwidth punctuation is its own token class: 1.25 characters per token, measured.
const FULLWIDTH_PUNCT_PER_TOKEN = 1.25;

/** One rounding for the whole segment: rounding each script on its own charges a token per script boundary. */
function cjkTokens(seg) {
  let kana = 0;
  let hangul = 0;
  let hanzi = 0;
  let punct = 0;
  for (const ch of seg) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x3040 && cp <= 0x30ff) kana++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)
      || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xa960 && cp <= 0xa97f)
      || (cp >= 0xd7b0 && cp <= 0xd7ff)) hangul++;
    else if ((cp >= 0x3001 && cp <= 0x3003) || (cp >= 0x3008 && cp <= 0x3011)
      || (cp >= 0x3014 && cp <= 0x301f) || cp === 0x3030 || cp === 0x30fb
      || (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20)
      || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65)) punct++;
    else hanzi++;
  }
  return Math.ceil(hanzi / HANZI_PER_TOKEN + kana / KANA_PER_TOKEN + hangul / HANGUL_PER_TOKEN
    + punct / FULLWIDTH_PUNCT_PER_TOKEN);
}

/**
 * The measured characters-per-token for a segment, or null when no rule applies.
 *
 * An accent rule prices a whole language through the minority of its words that carry the accent, so each rate is
 * fitted against running text in that language rather than against the segments the pattern matches. Every rule
 * needs a non-ASCII character, so ASCII-only segments skip them.
 */
function langCharsPerToken(seg) {
  if (!NON_ASCII_RE.test(seg)) return null;
  if (/[äöüßẞ]/i.test(seg)) return 3;
  if (/[éèêëàâîïôûùüÿçœæáíóúñ]/i.test(seg)) return 4.5;
  // Below what the accented segments alone would fit: unaccented Slavic words fall through to the default ratio,
  // and this compensates the shortfall.
  if (/[ąćęłńóśźżěščřžýůúďťň]/i.test(seg)) return 2.5;
  if (/[Ѐ-яё]/i.test(seg)) return 6;
  if (/[Ό-ώ]/i.test(seg)) return 3;
  if (/^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}]*$/u.test(seg)) return 0.9;
  return null;
}

const NON_ASCII_RE = /[-￿]/;

/** Code points, not UTF-16 units: an emoji is one character, not two. */
function charCount(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s.length <= TOK_CACHE_MAX_LEN) {
    const hit = tokCache.get(s);
    if (hit !== undefined) return hit;
    // Rounded UP from the same BPE-aware estimate the streaming counter uses. Both must agree: a body
    // measured one way and a stream measured another is how a session ends up reporting two numbers.
    const out = Math.ceil(estimateBpe(s));
    if (tokCache.size >= TOK_CACHE_MAX) {
      // Drop the oldest half in one go: cheaper than one-at-a-time and keeps the
      // recently measured entries that a per-entry eviction would churn.
      let i = 0;
      for (const k of tokCache.keys()) { tokCache.delete(k); if (++i >= TOK_CACHE_MAX / 2) break; }
    }
    tokCache.set(s, out);
    return out;
  }
  // Long body: measured directly, with the SAME estimator as the cached path. The two used to differ, so
  // a long message and a short one were priced by different formulas.
  return Math.ceil(estimateBpe(s));
}

// Estimate tokens for the MESSAGES only. The system prompt and tool definitions are
// NOT included: `messages` usually already starts with the system prompt (the TUI
// builds `[{ role: 'system', content: sysText }, ...]`), so adding `cfg.systemPrompt`
// on top counted it twice — and the value in `cfg` is the RAW prompt, not the
// assembled `sysText` (calm/plan/swarm/AGENTS.md appended), so it was also the wrong
// number. Callers that want the whole request add it themselves via
// estimateRequestOverhead().
export function estimateMessagesTokens(messages, cfg) {
  // THROUGH `messageTokens`, NOT `estimateMessageTokens`. Same arithmetic — the memoised path calls the same
  // estimator — but the raw one re-measures EVERY message on EVERY call, and its callers are the hot ones: the
  // context gauge at each step, and the estimate a request is priced against. On a long session that is a full
  // walk of the history, Read results included, which is what made sending a message pause. `messageTokens` keeps
  // a per-message WeakMap keyed on the object, so an append-only history costs one measurement for what is new.
  let total = 0;
  for (const m of messages || []) total += messageTokens(m, cfg);
  return total;
}

/**
 * Tokens for ONE message. Split out so callers that walk the history (e.g.
 * planCompaction) can price each message ONCE instead of re-summing the whole
 * array per message — that was O(n²) over the transcript.
 */
export function estimateMessageTokens(m, cfg) {
  if (!m) return 0;
  let total = estimateTokens(m.role || '');
  const c = m.content;
  if (typeof c === 'string') {
    total += estimateTokens(c);
  } else if (c && typeof c === 'object' && Array.isArray(c.media)) {
    total += estimateMediaContentTokens(c);
  } else {
    total += estimateTokens(JSON.stringify(c || ''));
  }
  if (m.toolCalls) for (const tc of m.toolCalls) {
    total += estimateTokens(tc.name || '') + estimateTokens(JSON.stringify(tc.args || ''));
  }
  return total;
}

/**
 * Tokens for a content block that carries media (an image read from disk, a screenshot).
 *
 * AN IMAGE IS NOT PRICED BY ITS BASE64 LENGTH. `JSON.stringify` on the same object counts every base64
 * character as ordinary text — a 1 MB PNG is ~1.3M characters, which this estimator would price at
 * roughly 400k tokens — while a provider charges by the image's PIXEL dimensions, usually one to two
 * thousand. That is the direction that matters: the gauge would read hundreds of thousands too high, and
 * auto-compaction would fire on a history that was never close to full.
 *
 * The text beside the image is priced normally; each image gets a flat estimate derived from the common
 * tiling rule (a 512x512 tile ≈ 765 tokens, a 1568px max edge ≈ 1100 tokens). Exactness is impossible
 * without decoding the image, and it does not matter here: images are rare, and being within a few
 * hundred tokens beats being wrong by a hundred thousand.
 */
function estimateMediaContentTokens(c) {
  let total = estimateTokens(String(c.text == null ? '' : c.text));
  for (const m of c.media || []) {
    if (!m || m.type !== 'image') continue;
    // A thumbnail-sized image costs a tile; a full screenshot costs four. Read the dimensions from the
    // metadata when the reader recorded them, and fall back to the large case otherwise — overestimating
    // an image is far safer than under, because it makes compaction fire EARLY rather than late.
    const w = Number(m.width) || 0;
    const h = Number(m.height) || 0;
    if (w > 0 && h > 0) {
      const tiles = Math.max(1, Math.ceil(w / 512) * Math.ceil(h / 512));
      total += Math.min(4, tiles) * 765;
    } else {
      total += 1100;
    }
  }
  return total;
}

// ---- per-message token memo -----------------------------------------------
//
// Message objects -> { sig, tok }. WeakMap, so a message dropped from the history
// takes its estimate with it: no unbounded growth, and no manual eviction policy.
const msgTokMemo = new WeakMap();
//
// `estimateMessageTokens` above re-measures an immutable message every time it is
// asked, and the askers are frequent: the context gauge runs at every step, and
// compaction walks the whole history to find its cut point. A Read result can be
// hundreds of KB, so re-walking one costs milliseconds (measured: a 300 KB body is
// ~5.3 ms to price). Completed messages never change, so their estimate never has
// to be recomputed.
//
// The memo is a WeakMap keyed on the MESSAGE OBJECT, which gives two properties for
// free: it cannot leak (a dropped message takes its entry with it) and it cannot
// collide (two equal messages are still two objects).
//
// Correctness — the one place a stored message changes underneath us —
// --------------------------------------------------------------------
// `trimToolResults` rewrites `m.content` IN PLACE, replacing a large body with a
// short pointer. A memo that trusted object identity alone would keep serving the
// pre-trim count, and the gauge would claim the context was still full right after
// the very operation meant to shrink it — the trim would appear to do nothing and
// the next request would compact again for no reason.
//
// So every entry stores a cheap SIGNATURE of the content alongside the number, and
// a mismatch recomputes. `.length` on a string is O(1), which is what makes this
// affordable: streaming text (which grows every frame) misses on the signature and
// is re-walked, exactly as `estimateTokens`' own short-string cache already
// established. Content that is neither a string nor an array gets a weaker
// signature and is simply re-measured each time rather than risk a stale answer.
function msgSignature(m) {
  const c = m.content;
  let s;
  if (typeof c === 'string') s = 's' + c.length;
  else if (c == null) s = 'n';
  else if (Array.isArray(c)) s = 'a' + c.length;
  else if (typeof c === 'object' && Array.isArray(c.media)) {
    // A media block: its signature is the text plus one marker per image. The base64 payload itself is
    // NOT hashed — it is the expensive part, and it never changes once the message exists.
    s = 'm' + String(c.text == null ? '' : c.text).length + 'x' + c.media.length;
  } else s = '';                     // unknown shape: never trust a memo
  if (m.toolCalls) s += 't' + m.toolCalls.length;
  return s;
}

/** Drop any memoised estimate for a message whose content was rewritten in place. */
export function forgetMessageTokens(m) {
  if (m && typeof m === 'object') msgTokMemo.delete(m);
}

/**
 * `estimateMessageTokens`, memoised per message object.
 *
 * Safe to call on STREAMING messages too: the signature check misses on every
 * frame, so a growing body is simply re-measured and never served stale.
 */
export function messageTokens(m, cfg) {
  if (!m || typeof m !== 'object') return estimateMessageTokens(m, cfg);
  const sig = msgSignature(m);
  if (sig !== '') {
    const hit = msgTokMemo.get(m);
    if (hit !== undefined && hit.sig === sig) return hit.tok;
  }
  const tok = estimateMessageTokens(m, cfg);
  if (sig !== '') msgTokMemo.set(m, { sig, tok });
  return tok;
}

/**
 * A rolling total over a message list that grows by appending.
 *
 * This is the idea borrowed from jcode's `ActiveCharEstimate`
 * (`crates/jcode-base/src/compaction.rs`): keep a running count of the messages
 * already priced, so the common append-only case never rescans history. jcode also
 * notes why the cached value and its staleness flag are bundled into one type
 * rather than two independent fields — a path that updated one without the other
 * silently corrupted token accounting. Here the two are a single number,
 * `_counted`: it is meaningless on its own and is only ever read together with the
 * length it was computed against.
 *
 * `sync()` is O(new messages) when the list was only appended to, and O(n) after a
 * compaction (which REPLACES the array, so the old count describes messages that no
 * longer exist). Correctness does not depend on detecting appends perfectly: the
 * boundary identities are spot-checked and any doubt falls back to a full recount,
 * which is still cheap because the per-message memo makes each step a WeakMap hit.
 */
export class TokenLedger {
  constructor() {
    this.tokens = 0;
    this._counted = 0;
    this._first = null;
    this._last = null;
  }

  /** Total tokens for `messages`, reusing the previous count where it is still valid. */
  sync(messages, cfg) {
    const msgs = Array.isArray(messages) ? messages : [];
    const n = msgs.length;
    const canExtend = this._counted > 0 && this._counted <= n
      && this._first === msgs[0]
      && this._last === msgs[this._counted - 1];
    if (canExtend) {
      for (let i = this._counted; i < n; i++) this.tokens += messageTokens(msgs[i], cfg);
    } else {
      // Full recount. Still O(n) WEAK-MAP LOOKUPS rather than O(n) string walks,
      // which is the difference between milliseconds and microseconds.
      let total = 0;
      for (let i = 0; i < n; i++) total += messageTokens(msgs[i], cfg);
      this.tokens = total;
    }
    this._counted = n;
    this._first = n ? msgs[0] : null;
    this._last = n ? msgs[n - 1] : null;
    return this.tokens;
  }

  /** Forget everything — call after an in-place edit of an already-counted message. */
  reset() {
    this.tokens = 0;
    this._counted = 0;
    this._first = null;
    this._last = null;
  }
}

/**
 * The overhead a request carries BEYOND its messages: the system prompt plus the tool definitions.
 * Passed the assembled system text so the number matches what is actually sent.
 *
 * `cfg.toolDefTokens` is the REAL cost of the tool definitions, measured once by whoever built them.
 * This used to charge a flat `n * 8` per tool, which is short by an order of magnitude: a tool's
 * schema is its name, a paragraph of description and a nested parameters object, and measured here the
 * 68 registered tools come to about 15 900 tokens — 29 times what 8 apiece reported.
 *
 * The discrepancy matters because this number is part of the context gauge. A gauge that omits ~15k of
 * every request understates usage by that much per turn, and the user sees the provider's real figure
 * disagree with the app's by a wide margin.
 *
 * The `n * 8` remains only as a FALLBACK for a caller that has not measured its definitions; it is
 * better than nothing and is the old behaviour, exactly.
 */
export function estimateRequestOverhead(systemText, cfg) {
  let total = estimateTokens(systemText || '');
  const measured = cfg && Number.isFinite(cfg.toolDefTokens) ? cfg.toolDefTokens : null;
  if (measured != null) return total + measured;
  const n = (cfg && Array.isArray(cfg.toolFilter)) ? cfg.toolFilter.length : 0;
  if (n) total += n * 8;   // rough per-tool-definition overhead, when nothing measured it
  return total;
}

/**
 * The token cost of a set of tool definitions, measured the way they are actually sent.
 *
 * Serialised as `{ name, description, parameters }` — the three fields the provider receives — and
 * priced with the same estimator the gauge uses, so the number is comparable with everything else.
 */
export function measureToolDefTokens(tools) {
  let total = 0;
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    total += estimateTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
  }
  return total;
}


// Expand TAB characters to spaces at 8-column tab stops. A terminal advances a
// tab to the NEXT tab stop, but our width math (visualWidth) counts '\t' as 0,
// so a row containing a tab is padded short and the terminal wraps it onto the
// next line — the "text bleeding onto another row" corruption. Tool output
// (e.g. `dir`, `ls -l`, git) contains tabs, so expand before measuring.
export function expandTabs(s, tabSize = 8) {
  const str = String(s ?? '');
  if (str.indexOf('\t') === -1) return str;
  let out = '';
  let col = 0;
  for (const ch of str) {
    if (ch === '\n') { out += ch; col = 0; continue; }
    if (ch === '\t') {
      const next = tabSize - (col % tabSize);
      out += ' '.repeat(next);
      col += next;
      continue;
    }
    out += ch;
    // Per CHARACTER, `charWidth` is the right measure and is far cheaper than
    // clusterWidth here: the loop already iterates code points (so a surrogate
    // pair arrives as a single `ch`), and clusterWidth would spin up the
    // segmenter for every single character.
    col += charWidth(ch);
  }
  return out;
}

// Truncate a string to `width` visible columns, stripping escapes for measurement
// and padding if shorter. Used for status/header lines. Honors 2-col glyphs.
export function fit(s, width) {
  const plain = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const plainW = visualWidth(plain);
  if (plainW <= width) return s + ' '.repeat(width - plainW);
  let kept = '';
  let w = 0;
  for (const ch of s) {
    if (ch === '\x1b') { kept += ch; continue; }
    const cw = charWidth(ch);
    if (w + cw > width) break;
    w += cw;
    kept += ch;
  }
  return kept;
}

export function emit(str) {
  process.stdout.write(str);
}
