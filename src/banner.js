// The startup mark: an HNCODE wordmark, drawn once when a session has nothing in it yet.
//
// WHY ALL CAPITALS. A lowercase letter needs a smaller x-height, and at bitmap sizes that means its top rows are
// blank — which shifts it against the capitals and makes the word look broken rather than typeset. One height for
// every letter is the only thing that lines up.
//
// THE ALPHABET IS BUILT FROM HALF BLOCKS. `▀` (U+2580) fills the upper half of a cell and `▄` (U+2584) the lower,
// so one terminal row carries TWO rows of the drawing and every joint is a straight edge. Full blocks and
// quadrants were tried: `█` rows read as solid slabs, and the quadrant characters carry padding on all sides so a
// row of them came out as scattered dots.
//
// AUTHORING. Each glyph is a picture, five rows of five cells, and the mark is scaled up from that. Writing it at
// 1x and multiplying is the only way to keep it correct: a hand-written bitmap at the larger size has hundreds of
// characters per letter, and one wrong one produces a letter that is malformed on screen but looks fine in source.
//
// THE SCALE IS CHOSEN PER CALL from the space available — the largest of 1, 2 and 3 that fits. A fixed 3 is 105
// columns and disappears on a terminal narrower than that, which is most of them; a fixed 1 is cramped on a wide
// one. Every cell of the 5x5 picture becomes `scale` cells.
//
// THE DROP SHADOW is the same picture offset by one cell down and one across, drawn dim. It is what makes the
// wordmark sit ON the page rather than float in it, and at this size a shadow costs one extra column and one
// extra terminal row.
const BASE = {
  H: [
    '#...#',
    '#...#',
    '#####',
    '#...#',
    '#...#',
  ],
  N: [
    '#...#',
    '##..#',
    '#.#.#',
    '#..##',
    '#...#',
  ],
  C: [
    '#####',
    '#....',
    '#....',
    '#....',
    '#####',
  ],
  O: [
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ],
  D: [
    '####.',
    '#...#',
    '#...#',
    '#...#',
    '####.',
  ],
  E: [
    '#####',
    '#....',
    '####.',
    '#....',
    '#####',
  ],
};

const WORD = ['H', 'N', 'C', 'O', 'D', 'E'];
const UP = '\u2580';      // upper half
const DOWN = '\u2584';    // lower half
const BOTH = '\u2588';    // both halves
const NONE = ' ';

/** The size the mark is drawn at. Fixed: one size, chosen once, rather than four variants to keep correct. */
export const SCALE = 2;

/** How many columns the mark occupies, counting the shadow's offset on the right. */
export function bannerWidthAt(scale = SCALE) {
  const s = Math.max(1, Math.round(scale) || 1);
  // Five cells of ink per letter, one cell between letters, and two half-cells on the right for the shadow.
  return WORD.length * 5 * s + (WORD.length - 1) * 2 + 2;
}

/** 0 when the mark does not fit at its one size, so a caller can skip it entirely. */
export function bannerScaleFor(width) {
  return Number(width) >= bannerWidthAt() ? SCALE : 0;
}

/** Blow the glyphs up to `scale` and lay them side by side, as one picture of `#` and `.`. */
function buildPicture(scale) {
  const s = Math.max(1, Math.round(scale) || 1);
  const glyphs = WORD.map((ch) => {
    const rows = [];
    for (const row of BASE[ch]) {
      let line = '';
      for (const c of row) line += (c === '#' ? '#' : '.').repeat(s);
      for (let i = 0; i < s; i++) rows.push(line);
    }
    return rows;
  });
  // ONE CHARACTER CELL BETWEEN LETTERS. The gap is in half-cells, so one cell is two of them — and it has to be
  // at least that, or each letter's shadow lands on the next letter's ink.
  const gap = '.'.repeat(2);
  const height = glyphs[0].length;
  const rows = [];
  for (let r = 0; r < height; r++) {
    rows.push(glyphs.map((g, i) => g[r] + (i === glyphs.length - 1 ? '' : gap)).join(''));
  }
  // Room on the right and at the bottom for the shadow, which is two half-cells in each direction.
  const width = Math.max(...rows.map((l) => l.length)) + 2;
  for (let i = 0; i < rows.length; i++) rows[i] = rows[i].padEnd(width, '.');
  return rows;
}

/** The mark's picture at `scale`, plus its shadow, as one grid of `#` (ink), `s` (shadow) and `.`. */
function withShadow(picture, shadowRows, shadowCols) {
  const height = picture.length + shadowRows;
  const width = Math.max(...picture.map((l) => l.length)) + shadowCols;
  const grid = [];
  for (let r = 0; r < height; r++) {
    const line = [];
    for (let c = 0; c < width; c++) {
      const ink = picture[r] && picture[r][c] === '#';
      const sh = picture[r - shadowRows] && picture[r - shadowRows][c - shadowCols] === '#';
      // Ink wins where they overlap, so the shadow reads as being BEHIND the letter.
      line.push(ink ? '#' : sh ? 's' : '.');
    }
    grid.push(line);
  }
  return grid;
}

/** Fold two grid rows into one terminal row, where the character says which colour runs. */
function foldRow(upper, lower) {
  let out = '';
  for (let c = 0; c < upper.length; c++) {
    const u = upper[c];
    const d = lower ? lower[c] : '.';
    // A cell is described by the pair (upper, lower). `#` means ink, `s` shadow, `.` empty.
    out += u + d;
  }
  return out;
}

/**
 * The mark as terminal rows, each a string of cells.
 *
 * A cell is returned as a two-character token naming its halves so the painter can colour the ink and the shadow
 * differently: `##` both ink, `#.` ink above only, `.#` ink below only, `ss`/`s.`/`.s` the same for shadow, and
 * `..` empty. `bannerLines` turns these into the actual block characters.
 */
export function bannerCells(scale = SCALE) {
  const picture = buildPicture(scale);
  const s = Math.max(1, Math.round(scale) || 1);
  // THE SHADOW IS ALWAYS ONE CHARACTER DOWN AND ONE ACROSS — two half-cells, whatever the scale.
  //
  // A character cell is two half-cells by definition, so this offset is the same at 1x, 2x and 3x. What changes is
  // the STROKE: at 1x one character wide, at 3x three. The ratio is what makes the shadow read as an edge — at
  // 1x the shadow is as wide as the stroke, which is why that size looked right, and at 2x it is half as wide.
  //
  // Halving the offset per scale would restore the ratio but put the shadow inside the stroke, where the ink covers
  // it. Keeping one full character keeps it BESIDE the stroke, which is the only thing that stays legible.
  const grid = withShadow(picture, 2, 2);
  const out = [];
  for (let r = 0; r < grid.length; r += 2) out.push(foldRow(grid[r], grid[r + 1]));
  return out;
}

/** The mark as plain rows at a given scale — no colour, for tests and callers that only want the shape. */
export function bannerShape(scale = SCALE) {
  return bannerCells(scale).map((row) => {
    let line = '';
    for (let i = 0; i < row.length; i += 2) {
      const u = row[i];
      const d = row[i + 1];
      const ink = u === '#' || d === '#';
      if (!ink) { line += NONE; continue; }
      line += u === '#' && d === '#' ? BOTH : u === '#' ? UP : DOWN;
    }
    return line;
  });
}

/** The width the mark needs at the largest scale, for callers that only want to know whether it fits at all. */
export const BANNER_WIDTH = bannerWidthAt(SCALE);

/**
 * The lines to draw, with the ink painted in `paint` and the shadow in `shadow`.
 *
 * @param {number} width The space available, in columns. The scale is reduced to fit; when even 1x does not fit
 *   the mark is DROPPED rather than truncated — half a wordmark reads as a rendering bug, and the session works
 *   fine without it.
 * @param {(s: string) => string} paint Applies the accent colour to the letters.
 * @param {(s: string) => string} [shadow] Applies the shadow colour. Without it the shadow is drawn as ink.
 * @returns {string[]} rows, or `[]` when they do not fit.
 */
export function bannerLines(width, paint, shadow) {
  const scale = bannerScaleFor(width);
  if (!scale) return [];
  const dim = typeof shadow === 'function' ? shadow : paint;
  return bannerCells(scale).map((row) => {
    let line = '';
    for (let i = 0; i < row.length; i += 2) {
      const u = row[i];
      const d = row[i + 1];
      const isInk = u === '#' || d === '#';
      const isShadow = !isInk && (u === 's' || d === 's');
      let ch;
      if (isInk) ch = u === '#' && d === '#' ? BOTH : u === '#' ? UP : DOWN;
      else if (isShadow) ch = u === 's' && d === 's' ? BOTH : u === 's' ? UP : DOWN;
      else { line += NONE; continue; }
      line += isInk ? paint(ch) : dim(ch);
    }
    return line;
  });
}

/** How tall the mark is at the largest scale that fits, for layout maths that runs before the text exists. */
export function bannerHeight(width) {
  const scale = bannerScaleFor(width);
  return scale ? bannerCells(scale).length : 0;
}
