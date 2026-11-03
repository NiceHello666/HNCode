/**
 * Text and styled strings → a Screen.
 *
 * The frame composer produces rows of ANSI-decorated strings, because that is how every surface in this app was
 * written. Rather than rewrite all of them at once, this module paints those rows into a cell grid: it parses
 * the SGR runs, interns each style once, and writes the characters with their widths.
 *
 * The result is what the painter wants — a grid it can diff cell by cell, and in which a bitmap is a region
 * with no characters in it rather than a row with bytes in it.
 */
import { charWidth, CELL_WIDTH } from './screen.js';

/** Matches an SGR sequence: `ESC [ params m`. */
const SGR = /\x1b\[([0-9;]*)m/g;

/** Matches any other escape sequence, which the painter does not place as text. */
const OTHER_ESCAPE = /\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

/**
 * Split a line into runs of `{ text, styleId }`, interning each style.
 *
 * Styles are tracked as the CURRENT sgr string in effect, accumulated until a reset. Two runs that end up with
 * the same accumulated string share an id, so a row of plain text costs one lookup.
 *
 * @param {string} line
 * @param {import('./screen.js').StylePool} stylePool
 * @returns {Array<{text: string, styleId: number}>}
 */
export function styledRuns(line, stylePool) {
  const runs = [];
  let current = '';
  let pos = 0;
  SGR.lastIndex = 0;

  const push = (text) => {
    if (!text) return;
    runs.push({ text, styleId: stylePool.intern(current) });
  };

  let m;
  while ((m = SGR.exec(line))) {
    push(line.slice(pos, m.index));
    const params = m[1];
    // `0` and an empty parameter both mean "reset everything".
    if (params === '' || params === '0') current = '';
    else current += `\x1b[${params}m`;
    pos = m.index + m[0].length;
  }
  push(line.slice(pos));
  return runs;
}

/** Strip every escape sequence from a string, leaving what the terminal would draw as text. */
export function stripEscapes(line) {
  return String(line)
    .replace(SGR, '')
    .replace(OTHER_ESCAPE, '')
    .replace(/\x1b/g, '');
}

/** Terminal width of a string once its escapes are ignored. */
export function displayWidth(line) {
  let w = 0;
  for (const ch of stripEscapes(line)) {
    const cw = charWidth(ch);
    if (cw > 0) w += cw;
  }
  return w;
}

/**
 * Paint rows of styled text into a screen.
 *
 * @param {import('./screen.js').Screen} screen Destination, already the right size.
 * @param {string[]} rows One string per row; extra rows are ignored, missing ones stay blank.
 * @param {import('./screen.js').StylePool} stylePool
 */
export function paintRows(screen, rows, stylePool) {
  screen._rowCount = rows.length;
  const n = Math.min(rows.length, screen.height);
  for (let y = 0; y < n; y++) {
    const line = rows[y];
    if (!line) continue;
    let x = 0;
    for (const run of styledRuns(line, stylePool)) {
      for (const ch of run.text) {
        const w = charWidth(ch);
        if (w === 0) continue;                 // a combining mark has no column of its own
        if (x + w > screen.width) break;
        screen.set(x, y, ch, run.styleId, w);
        x += w;
      }
      if (x >= screen.width) break;
    }
    screen._mark(0, y, screen.width);
  }
}

/**
 * Turn a screen back into rows of ANSI strings, for the paths that still expect text.
 *
 * This is the inverse of `paintRows` and is meant for the web mirror and for plugins that read the frame's
 * lines; the terminal itself is written from the cell diff, not from these strings.
 *
 * @param {import('./screen.js').Screen} screen
 * @returns {string[]}
 */
export function screenToRows(screen) {
  const rows = [];
  for (let y = 0; y < screen.height; y++) {
    let out = '';
    let styleId = -1;
    for (let x = 0; x < screen.width; x++) {
      if (screen.isSpacer(x, y)) continue;
      const cell = screen.at(x, y);
      if (cell.styleId !== styleId) {
        out += '\x1b[0m' + screen.stylePool.get(cell.styleId);
        styleId = cell.styleId;
      }
      out += cell.ch;
    }
    if (styleId !== -1) out += '\x1b[0m';
    rows.push(out);
  }
  return rows;
}

export { CELL_WIDTH };
