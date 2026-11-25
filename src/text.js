// Text measurement, colouring and wrapping.
//
// These are the leaves of the renderer: they take a string and some numbers and return a string. Nothing here knows
// what a transcript is, so the same helpers serve a chat row, a popup and the composer.

import { C } from './colors.js';
import { visualWidth, expandTabs } from './term.js';

// The ESC byte, as its own string. Every escape scan starts by comparing against this rather than writing '\x1b',
// which keeps the regexes and the string walks recognisably the same test.
export const ESC = '\x1b';

export { expandTabs };

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[0-9;?]* [a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

// Make UNTRUSTED text safe to paint: file contents from Read, command output from Bash, diff bodies, tool arguments.
//
// The goal is to keep the content as ORIGINAL as possible while stopping the terminal from OBEYING it. Only the ESC
// byte is rewritten — every following byte (the `[31m`, the `[10;20H` parameters) is shown verbatim, so nothing is
// lost:
//
//     file contains:  ESC [ 3 1 m E R R O R ESC [ 0 m
//     screen shows :  ^[ [ 3 1 m E R R O R ^[ [ 0 m
//
// A terminal cannot act on a sequence whose ESC has been split into `^[`, so `ESC[31m` no longer recolours half the
// transcript, `ESC[0m` no longer resets the row mid-line, and `ESC[10;20H` no longer moves the cursor.
//
// `^[` is the convention `cat -v`, `less` and `bat` use for ESC, so it reads as "there is an escape here" rather
// than as content.
export function sanitizeText(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b/g, '^[')
    .replace(/\x07/g, '^G')
    .replace(/\x08/g, '^H')
    .replace(/[\x0b\x0c]/g, ' ')
    .replace(/[\x00-\x06\x0e-\x1f\x7f]/g, '');
}

/**
 * How much of a running command's output to KEEP, not just display.
 *
 * This string is mirrored into the hub row (and so into the SSE patch the browser applies on every frame), which
 * means an unbounded buffer grows the terminal's row, the hub's row and the browser's copy at the same time. Only
 * the tail is ever drawn, so only the tail is worth holding.
 */
export const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;

/** The last `max` CHARACTERS of `s`, cut on a line boundary so the tail never starts mid-line. */
export function tailChars(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  const cut = str.slice(str.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

/**
 * Visible width of a string that may carry ANSI escapes.
 *
 * THE PRINTABLE-ASCII FAST PATH IS THE COMMON CASE BY A WIDE MARGIN. Most rows in a frame are plain ASCII with no
 * escapes — the filler, the padding, a notice, the composer's own text — and for those the width IS the length.
 *
 * The range is 0x20..0x7e, NOT everything below 0x7f. A first attempt accepted every code point under 0x7f and broke
 * the frame: TAB (0x09) is below the bound but `visualWidth` counts it as zero columns while `length` counts one, so a
 * row containing a tab was measured one column too wide and `fitAnsi` padded it short — the painted screen then
 * diverged from the frame by exactly the tab's width. Control characters in general are zero-width, so they have to
 * fall through.
 */
export function visualCol(s) {
  const str = String(s);
  const len = str.length;
  let i = 0;
  while (i < len) {
    const c = str.charCodeAt(i);
    // Printable ASCII only: below 0x20 is a control, 0x7f is DEL, above is non-ASCII.
    if (c < 0x20 || c > 0x7e) break;
    i++;
  }
  if (i === len) return len;
  // NO ESCAPE, NO STRIPPING. The scan above stopped on a non-ASCII or control character, which is NOT the same thing as
  // a styled row: a row with one CJK character or one TAB fell through to `stripAnsi`, which allocated a fresh string
  // through three regex passes just to hand it to a width walk. Only a row that actually contains ESC needs that.
  if (str.indexOf('\x1b') < 0) return visualWidth(str);
  return visualWidth(stripAnsi(str));
}

/** Wrap `text` in colour `c`, closing with a full reset. */
export function col(text, c) { return c + String(text) + C.reset; }

/**
 * Pad or truncate to exactly `w` VISIBLE columns, carrying escapes through untouched.
 *
 * Padding is what makes a row's background reach the edge; truncation keeps a long line from wrapping and pushing
 * the layout down a row.
 */
export function fitAnsi(s, w) {
  const str = String(s);
  const v = visualCol(str);
  if (v < w) return str + ' '.repeat(w - v);
  if (v === w) return str;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i))
        || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(str.slice(i))
        || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    if (n + cw > w) break;
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  if (n < w) out += ' '.repeat(w - n);
  return out;
}

/**
 * Greedy word wrap to `width` VISIBLE columns.
 *
 * The running width is ACCUMULATED rather than re-measured. Recomputing `visualCol(line + ' ' + w)` per word is O(line)
 * per word and therefore O(n²) per paragraph — a single long streamed paragraph cost ~46ms at 20KB and froze the UI on
 * every markdown chunk. Widths are additive for the plain text this receives, because no ANSI is present until
 * `inlineMarkdown` runs later.
 *
 * A word longer than the line is hard-split BY VISUAL COLUMNS, not by `.length`: CJK characters occupy two cells, so
 * slicing by length emitted lines twice as wide as the box and let the terminal wrap them.
 */
export function wrapWords(str, width) {
  width = Math.max(1, width | 0);
  const out = [];
  let line = '';
  let lineW = 0;
  // Tabs are expanded first: `visualCol` counts '\t' as 0 columns while the terminal advances to the next stop, which
  // made the row wider than computed and wrapped it onto the following line.
  const words = expandTabs(str).split(' ');
  for (const w of words) {
    const wW = visualCol(w);
    if (wW > width) {
      if (line) { out.push(line); line = ''; lineW = 0; }
      let chunk = '';
      let cw = 0;
      for (const ch of w) {
        const chw = visualCol(ch);
        if (cw + chw > width) { out.push(chunk); chunk = ''; cw = 0; }
        chunk += ch; cw += chw;
      }
      if (chunk) { line = chunk; lineW = cw; }
      continue;
    }
    const sep = line ? 1 : 0;
    if (lineW + sep + wW <= width) {
      line = line ? line + ' ' + w : w;
      lineW += sep + wW;
    } else {
      if (line) out.push(line);
      line = w;
      lineW = wW;
    }
  }
  if (line) out.push(line);
  else if (out.length === 0) out.push('');
  return out;
}

