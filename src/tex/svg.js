/**
 * TeX → SVG.
 *
 * Every glyph is a `<path>` built from the actual STIX Two Math outline, so the document is vector art in
 * the same sense MathJax's SVG output is: no text elements, no font references, nothing that depends on what
 * the viewer has installed. Rules (fraction bars, radical bars) are `<rect>`, and the delimiters a matrix or
 * `cases` needs are the font's own bracket and brace glyphs stretched to the height they must span.
 *
 * The layout is not this module's business: `layout.js` has already measured the formula in font units, so
 * this only has to place what it is given. That is deliberate — the terminal bitmap and the SVG come out of
 * ONE layout, so a picture on screen and an SVG exported from it cannot disagree.
 */
import { loadBundledFont } from './font.js';
import { parseTex } from './parse.js';
import { layout } from './layout.js';

/** Margin around the ink, in em fractions. Bracket arms sit on the box edge, so this cannot be zero. */
const PAD_EM = 0.16;
/** Stroke width for a rule (fraction bar, radical bar), in em fractions. */
const RULE_EM = 0.045;
/** Editor/version tag the SVG carries; also what makes the output reproducible byte for byte. */
const GENERATOR = 'hncode tex-svg';

/** Two decimals is more precision than a pixel ever shows, and it keeps the file readable. */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

let fontCache = null;

function font() {
  if (!fontCache) fontCache = loadBundledFont();
  return fontCache;
}

/**
 * One glyph outline as an SVG path, with the font's up-is-positive y flipped to SVG's down-is-positive.
 *
 * TrueType contours mix on-curve and off-curve points; two off-curve points in a row imply an on-curve point
 * halfway between them, which is why the midpoint case has to be emitted explicitly rather than skipped.
 *
 * @param {Array<Array<{x:number,y:number,on:boolean}>>} contours
 * @param {(x:number)=>number} tx
 * @param {(y:number)=>number} ty
 * @returns {string}
 */
export function outlineToPath(contours, tx, ty) {
  const parts = [];
  for (const contour of contours) {
    const count = contour.length;
    if (count < 2) continue;

    // A contour need not begin on a curve point. When it does not, it begins at the midpoint between the
    // first two off-curve points, which is where the closing segment has to end too.
    let startAt = contour.findIndex((p) => p.on);
    let start;
    if (startAt < 0) {
      start = { x: (contour[0].x + contour[1].x) / 2, y: (contour[0].y + contour[1].y) / 2 };
      startAt = 0;
    } else {
      start = contour[startAt];
    }

    parts.push(`M${n(tx(start.x))} ${n(ty(start.y))}`);
    let control = null;
    for (let k = 1; k <= count; k++) {
      const point = contour[(startAt + k) % count];
      if (point.on) {
        if (control) {
          parts.push(`Q${n(tx(control.x))} ${n(ty(control.y))} ${n(tx(point.x))} ${n(ty(point.y))}`);
          control = null;
        } else {
          parts.push(`L${n(tx(point.x))} ${n(ty(point.y))}`);
        }
      } else if (control) {
        const midX = (control.x + point.x) / 2;
        const midY = (control.y + point.y) / 2;
        parts.push(`Q${n(tx(control.x))} ${n(ty(control.y))} ${n(tx(midX))} ${n(ty(midY))}`);
        control = point;
      } else {
        control = point;
      }
    }
    if (control) parts.push(`Q${n(tx(control.x))} ${n(ty(control.y))} ${n(tx(start.x))} ${n(ty(start.y))}`);
    parts.push('Z');
  }
  return parts.join('');
}

/**
 * A delimiter drawn from the font's own glyph, stretched vertically to the height it must span.
 *
 * A matrix's bracket is taller than any single glyph the font ships at text size, and the extensible pieces
 * in the MATH table are out of scope here. Stretching the base glyph is what a fallback typesetter does, and
 * it reads correctly because the arms keep their shape and only the straight run grows.
 *
 * @param {string} ch The delimiter character.
 * @param {{x:number,y:number,width:number,height:number,depth:number}} box Where it has to land, in pixels.
 * @param {number} px Em size in pixels.
 */
function stretchedDelimiter(ch, box, px) {
  const face = font();
  const gid = face.glyphIndex(ch.codePointAt(0));
  if (!gid) return '';
  const contours = face.outline(gid);
  if (!contours.length) return '';

  // The glyph's own ink box, so the stretch is measured against what it actually draws.
  let left = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const contour of contours) {
    for (const p of contour) {
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y > top) top = p.y;
      if (p.y < bottom) bottom = p.y;
    }
  }
  if (!(right > left) || !(top > bottom)) return '';

  const inkWidth = (right - left) / face.unitsPerEm * px;
  const inkHeight = (top - bottom) / face.unitsPerEm * px;
  // Fit inside the box the layout reserved, keeping the glyph's own width when there is room.
  const scaleX = (box.width || inkWidth) / inkWidth;
  const scaleY = (box.height + box.depth) / inkHeight;
  const originX = box.x;
  const originY = box.y + box.height;   // the top of the box, in SVG coordinates

  // y is flipped for SVG, so the glyph's ink bottom maps to the BOTTOM of the box.
  const tx = (x) => originX + (x - left) * scaleX;
  const ty = (y) => originY + (top - y) * scaleY;
  return outlineToPath(contours, tx, ty);
}

/** Run the same stretch over the outermost style the SVG root carries. */
/**
 * The SVG document for one formula.
 *
 * @param {string} tex TeX without delimiters.
 * @param {object} [opts]
 * @param {number} [opts.px] Em size in pixels. Defaults to 16, a browser body-text size.
 * @param {string} [opts.colour] Ink colour as a CSS colour. Defaults to `currentColor`, so the document
 *   inherits the colour of whatever displays it.
 * @returns {{svg: string, width: number, height: number, baseline: number}|null} Null when the TeX is outside
 *   the subset this project can lay out.
 */
export function texToSvg(tex, opts = {}) {
  let box;
  try {
    box = layout(parseTex(tex), font(), 1000);
  } catch {
    return null;
  }
  if (!(box.width > 0) || !(box.height + box.depth > 0)) return null;

  const face = font();
  const px = Math.max(6, opts.px || 16);
  const color = opts.colour || 'currentColor';
  const pad = Math.round(px * PAD_EM);

  // Em unit → pixel, and the baseline row the whole tree hangs from.
  const em = px / 1000;
  const width = Math.ceil(box.width * em) + pad * 2;
  const height = Math.ceil((box.height + box.depth) * em) + pad * 2;
  const baseline = Math.ceil(box.height * em) + pad;
  const stroke = Math.max(0.6, px * RULE_EM);

  const paths = [];
  const rects = [];

  const walk = (node, ox, oy) => {
    if (!node) return;
    const x = ox + (node.x || 0) * em;
    const y = oy - (node.y || 0) * em;   // font y grows up, SVG y grows down

    if (node.kind === 'glyph' && node.gid) {
      const contours = face.outline(node.gid);
      if (contours.length) {
        const k = (node.size * em) / face.unitsPerEm;
        const d = outlineToPath(contours, (gx) => x + gx * k, (gy) => y - gy * k);
        if (d) paths.push(d);
      }
    } else if (node.kind === 'rule') {
      rects.push({
        x,
        y,
        width: Math.max(0.5, node.width * em),
        height: stroke,
      });
    } else if (node.kind === 'bracket' || node.kind === 'brace') {
      // The layout reserves the box; the font supplies the shape.
      const ch = node.kind === 'brace' ? '{' : (node.side === 'right' ? ']' : '[');
      const d = stretchedDelimiter(ch, {
        x,
        y,
        width: (node.width || px * 0.3) * em,
        height: node.height * em,
        depth: node.depth * em,
      }, px);
      if (d) paths.push(d);
    }

    if (node.items) for (const child of node.items) walk(child, x, y);
  };
  walk(box, pad, baseline);

  const body = [
    `<g fill="${color}" stroke="none">`,
    ...rects.map((r) => `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"/>`),
    ...paths.map((d) => `<path d="${d}"/>`),
    '</g>',
  ].join('\n');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
      + ` viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(tex.trim())}">`,
    `<title>${escapeText(tex.trim())}</title>`,
    `<desc>${GENERATOR}: STIX Two Math glyph outlines</desc>`,
    body,
    '</svg>',
  ].join('\n');

  return { svg, width, height, baseline };
}

/** Text content: the three characters that end an element or start a reference. */
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Attribute content: the same plus the quote that delimits it. */
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}
