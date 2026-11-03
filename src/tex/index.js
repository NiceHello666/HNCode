/**
 * The public face of the bitmap renderer: the policy that decides whether a formula is drawn as a picture,
 * how large its raster is, and what to do when it cannot be drawn at all.
 *
 * The pieces below it know nothing about terminals. `parse.js` builds the node tree, `layout.js` measures it
 * in font units, `render.js` turns it into RGBA and `sixel.js` encodes that for the terminal. This module is
 * where the terminal's facts arrive — its protocol and its cell size — so the same formula lands on whole
 * cells on every display.
 *
 * The bundled face is STIX Two Math: it carries the repertoire this pipeline uses (fractions, big operators
 * with limits, radicals, braces), so a formula typeset here looks like the one in a paper rather than like
 * assembled ASCII.
 */
import { loadBundledFont } from './font.js';
import { parseTex } from './parse.js';
import { layout } from './layout.js';
import { renderBox } from './render.js';
import { encodeSixel } from './sixel.js';
import { kittyTransmit, kittyPlace, kittyImageId } from './kitty.js';

/**
 * Ex per cell height. A formula is set to the same size as the text around it by matching the x-HEIGHT, not
 * the em: a terminal cell is about twice as tall as it is wide, and a font's em is roughly twice its
 * x-height, so one ex per cell height lands the two on the same scale. dsh-tui uses 0.5 of the cell height
 * for body text and 0.72 for display math (src/math/layout.ts there); 0.55 is the display value here.
 */
const EX_PER_CELL_HEIGHT = 0.55;
/** Margin around the ink, in pixels. A bracket's arms sit exactly on the box edge, so this is not optional. */
const PAD = 4;
/** A formula taller than this many rows is a matrix to scroll, not a picture to paint. */
const MAX_ROWS = 12;
/** Cells to measure with when the terminal never reported its cell size (XTWINOPS 16). */
const FALLBACK_CELL = { w: 10, h: 20 };

/** The font is ~900 KB, so it is read on the first formula that needs it, never at startup. */
let fontCache = null;
/** The font's x-height as a fraction of its em, measured from the `x` glyph rather than assumed. */
let exRatio = null;

function font() {
  if (!fontCache) fontCache = loadBundledFont();
  return fontCache;
}

/** Fraction of the em occupied by the x-height. Measured once, from the glyph itself. */
function xHeightRatio(face) {
  if (exRatio !== null) return exRatio;
  let top = 0;
  const gid = face.glyphIndex('x'.codePointAt(0));
  for (const contour of face.outline(gid)) for (const p of contour) if (p.y > top) top = p.y;
  // A font with no usable `x` falls back to a typical maths face's x-height.
  exRatio = top > 0 ? top / face.unitsPerEm : 0.47;
  return exRatio;
}

/** Laid-out boxes, keyed by source: parsing and laying out is the expensive half and is size-independent. */
const layoutCache = new Map();
const LAYOUT_CACHE_MAX = 128;

/**
 * Whether the parse kept a command as literal source text.
 *
 * `parse.js` does not throw on a command it does not know: it emits the command as an atom so nothing is
 * lost. For a BITMAP that is the wrong answer — the picture would spell `\notacommand` in STIX glyphs — so a
 * formula carrying one is declined and the caller falls back to the text form, which shows the same source
 * in the code style the reader expects.
 */
function hasUnknownCommand(nodes) {
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    if (node.cls === 'raw') return true;
    if (Array.isArray(node) && hasUnknownCommand(node)) return true;
    for (const key of ['body', 'num', 'den', 'index', 'scripts', 'rows']) {
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        if (hasUnknownCommand(value)) return true;
        if (value.some((row) => Array.isArray(row) && hasUnknownCommand(row))) return true;
      } else if (typeof value === 'object') {
        if (hasUnknownCommand(value.sup) || hasUnknownCommand(value.sub)) return true;
      }
    }
  }
  return false;
}

function layoutOf(tex) {
  const hit = layoutCache.get(tex);
  if (hit !== undefined) return hit;
  let box = null;
  try {
    const nodes = parseTex(tex);
    box = hasUnknownCommand(nodes) ? null : layout(nodes, font(), 1000);
    if (box && !(box.width > 0 && box.height + box.depth > 0)) box = null;
  } catch {
    box = null;
  }
  if (layoutCache.size >= LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
  layoutCache.set(tex, box);
  return box;
}

/**
 * The cell box a formula occupies at its natural size, without rasterising it.
 *
 * @param {string} tex TeX without delimiters.
 * @param {{cell?: {w: number, h: number}}} [opts] The terminal's cell size in pixels.
 * @returns {{columns: number, rows: number, px: number, width: number, height: number}|null} Null when the
 *   TeX is outside the subset.
 */
export function measureTex(tex, opts = {}) {
  const box = layoutOf(tex);
  if (!box) return null;
  const cell = opts.cell && opts.cell.w > 0 && opts.cell.h > 0 ? opts.cell : FALLBACK_CELL;
  const face = font();
  // One ex is this many pixels, and the em the rasteriser wants is the em that PRODUCES that x-height.
  const exPx = Math.max(3, cell.h * EX_PER_CELL_HEIGHT);
  const px = Math.max(6, Math.round(exPx / xHeightRatio(face)));
  // Round UP: a picture a pixel taller than its box must claim the extra row rather than be clipped.
  const width = Math.ceil(box.width * px / face.unitsPerEm) + PAD * 2;
  const height = Math.ceil((box.height + box.depth) * px / face.unitsPerEm) + PAD * 2;
  return {
    columns: Math.max(1, Math.ceil(width / cell.w)),
    rows: Math.max(1, Math.ceil(height / cell.h)),
    px,
    width,
    height,
  };
}

/** Rendered rasters, keyed by source + size + colour. A formula is redrawn on every frame it stays on screen. */
const rasterCache = new Map();
const RASTER_CACHE_MAX = 48;

/**
 * Encoded Sixel sequences, keyed by the raster they came from.
 *
 * The raster cache saves the layout and the glyph rasterising; this one saves the ENCODING, which walks every
 * pixel again with a palette pass and run-length coding. Scrolling moves a formula up and down without changing
 * what it depicts, so without this the same picture was re-encoded on every frame of a scroll.
 */
const sequenceCache = new Map();
const SEQUENCE_CACHE_MAX = 64;


/** Below this fraction of the natural size a formula is unreadable; the caller keeps the text form instead. */
const MIN_SCALE = 0.55;

/**
 * Render a formula as an RGBA image, shrunk uniformly when it would not fit.
 *
 * The size policy is dsh-tui's (src/math/layout.ts there): set the formula at ONE base size tied to the
 * terminal's cell, then shrink it UNIFORMLY — never stretch it, never enlarge it — only as far as it must to
 * fit the columns and rows it is allowed. Below a legibility floor the picture is refused, so the caller
 * falls back to text instead of drawing something unreadable.
 *
 * @param {string} tex TeX without delimiters.
 * @param {object} [opts]
 * @param {{w: number, h: number}} [opts.cell] The terminal's cell size in pixels.
 * @param {{r:number,g:number,b:number}} [opts.colour] Ink colour.
 * @param {number} [opts.maxWidth] Columns the picture may occupy.
 * @param {number} [opts.maxRows] Rows the picture may occupy.
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number, columns: number, rows: number}|null}
 */
export function renderTexImage(tex, opts = {}) {
  const cell = opts.cell && opts.cell.w > 0 && opts.cell.h > 0 ? opts.cell : FALLBACK_CELL;
  const natural = measureTex(tex, { cell });
  if (!natural) return null;
  const maxColumns = opts.maxWidth || Infinity;
  const maxRows = Math.min(MAX_ROWS, opts.maxRows || MAX_ROWS);

  // Shrink by whichever axis overflows, and only by the amount needed.
  const fit = Math.min(
    natural.columns > maxColumns ? maxColumns / natural.columns : 1,
    natural.rows > maxRows ? maxRows / natural.rows : 1,
  );
  if (fit < MIN_SCALE) return null;
  const px = Math.max(6, Math.round(natural.px * fit));
  // Measured again at the FINAL size, so the cells claimed are the cells the raster covers.
  const box = layoutOf(tex);
  const em = font().unitsPerEm;
  const columns = Math.max(1, Math.ceil((Math.ceil(box.width * px / em) + PAD * 2) / cell.w));
  const rows = Math.max(1, Math.ceil((Math.ceil((box.height + box.depth) * px / em) + PAD * 2) / cell.h));
  if (columns > maxColumns || rows > maxRows) return null;

  const colour = opts.colour || { r: 220, g: 220, b: 220 };
  // A crop is part of a raster's identity: the same formula cut at a different pixel row is a different
  // picture, and serving the uncropped one from the cache would put it back where it started.
  const skipTop = Math.max(0, Math.round(opts.skipTop || 0));
  // `maxHeight` is an exact PIXEL limit, not a row limit: it is what a picture clipped by the transcript panel
  // needs, and it has to cut the raster itself — a band crop cannot express it.
  const maxHeight = opts.maxHeight > 0 ? Math.round(opts.maxHeight) : 0;
  const key = [tex, px, skipTop, maxHeight, colour.r, colour.g, colour.b].join('\u0000');
  const hit = rasterCache.get(key);
  if (hit) return hit;

  let image = null;
  try {
    const rendered = renderBox(box, font(), { px, colour, padding: PAD, skipTop, maxHeight });
    // The claimed cell box shrinks with the crop: what is left is what gets drawn.
    const drawnRows = Math.max(1, Math.ceil(rendered.height / cell.h));
    image = { ...rendered, columns, rows: drawnRows };
  } catch {
    image = null;
  }
  if (rasterCache.size >= RASTER_CACHE_MAX) {
    const oldest = rasterCache.keys().next().value;
    if (oldest !== undefined) rasterCache.delete(oldest);
  }
  rasterCache.set(key, image);
  return image;
}

/**
 * A formula as the terminal sequence that draws it, with the cell box it covers.
 *
 * @param {string} tex TeX without delimiters.
 * @param {object} opts As `renderTexImage`, plus `protocol` ('sixel' or 'kitty').
 * @returns {{sequence: string, width: number, height: number, columns: number, rows: number, kittyId?: number,
 *   kittyPlacement?: string}|null}
 */
export function encodeTexImage(tex, opts = {}) {
  const image = renderTexImage(tex, opts);
  if (!image) return null;
  const protocol = opts.protocol || 'sixel';
  if (protocol !== 'sixel' && protocol !== 'kitty') return null;
  const colour = opts.colour || { r: 220, g: 220, b: 220 };

  // THE SEQUENCE IS CACHED TOO, keyed by the raster it comes from.
  //
  // Encoding is the expensive half of the pipeline — a palette pass for Sixel, a base64 stream for Kitty —
  // and it was paid on EVERY frame even when the raster itself came from a cache. Scrolling changes a
  // placement's ROW, not the picture it draws, so the same formula was re-encoded dozens of times while the
  // view moved. The key is the raster's own identity, so a hit can only return bytes for exactly these pixels.
  const key = `${protocol}\u0000${image.width}x${image.height}\u0000${tex}\u0000${Math.round(opts.skipTop || 0)}`
    + `\u0000${colour.r},${colour.g},${colour.b}`;
  const hit = sequenceCache.get(key);
  if (hit) {
    sequenceCache.delete(key);            // refresh its position: the least recently used goes first
    sequenceCache.set(key, hit);
    return { ...hit, columns: image.columns, rows: image.rows };
  }

  // KITTY IS TWO PARTS, AND ONLY ONE OF THEM IS RESENT. `kittyId` owns the uploaded pixels; `kittyPlacement`
  // is the twenty-byte command that puts them at a cell. A frame that only moves a picture re-sends the
  // placement and leaves the pixels alone — which is the whole point of the protocol.
  const built = protocol === 'kitty'
    ? {
      sequence: kittyTransmit(kittyImageId(image.rgba, image.width, image.height), image.rgba, image.width, image.height),
      kittyId: kittyImageId(image.rgba, image.width, image.height),
      kittyPlacement: (x, y, columns, rows) => kittyPlace(kittyImageId(image.rgba, image.width, image.height), 1, x, y, columns, rows),
      width: image.width,
      height: image.height,
      columns: image.columns,
      rows: image.rows,
    }
    : {
      // A FORMULA IS LINE ART: one ink colour, and the raster is its antialiased coverage. Encoding that as a
      // grey ramp dissolves hairline strokes into speckle once the terminal fits it, so the coverage is
      // promoted to a one-bit mask in that single ink colour — the rule dsh-tui applies for the same reason
      // (src/ink/sixel-codec.ts, `lineArt`).
      sequence: encodeSixel(image.rgba, image.width, image.height, {
        transparent: true,
        lineArt: true,
        ink: colour,
      }),
      width: image.width,
      height: image.height,
      columns: image.columns,
      rows: image.rows,
    };
  sequenceCache.set(key, built);
  while (sequenceCache.size > SEQUENCE_CACHE_MAX) {
    const oldest = sequenceCache.keys().next().value;
    if (oldest === undefined) break;
    sequenceCache.delete(oldest);
  }
  return built;
}


/** Drop the font and the caches; for tests and for a settings change. */
export function resetTexRenderer() {
  fontCache = null;
  layoutCache.clear();
  rasterCache.clear();
  sequenceCache.clear();
}

export { MAX_ROWS as TEX_MAX_ROWS };
