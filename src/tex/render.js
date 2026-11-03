/**
 * A laid-out formula → an RGBA image.
 *
 * The box tree from `layout.js` is in font units, so the first decision is the scale: the caller asks for a
 * pixel size, and everything below is that scale applied once. Walking the tree means every `glyph` item
 * gets its outline rasterised at `size * scale` and composited at its own offset.
 *
 * Colour is a parameter rather than a style: the caller composites the formula onto whatever background its
 * terminal already has, so the raster must not assume one.
 */
import { rasterize, composite } from './raster.js';

/**
 * Render a laid-out box to pixels.
 *
 * @param {{width:number,height:number,depth:number,items:object[]}} box Output of `layout()`.
 * @param {object} font A `TrueTypeFont`.
 * @param {object} opts
 * @param {number} opts.px Target pixel size of one em.
 * @param {{r:number,g:number,b:number}} [opts.colour] Ink colour. Defaults to black.
 * @param {number} [opts.padding] Blank pixels around the formula.
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number}}
 */
export function renderBox(box, font, opts) {
  const px = Math.max(4, Math.round(opts.px || 24));
  const colour = opts.colour || { r: 0, g: 0, b: 0 };
  // A MARGIN IS PART OF THE IMAGE, not decoration. A bracket's arms are two pixels thick and sit exactly on
  // the content's bounding edge, so a small margin left the last arm flush with the bottom of the bitmap —
  // it read as clipped even though every row was drawn. Antialiased glyph edges reach a pixel past their
  // outline, so the margin has to be wider than the stroke.
  const pad = Math.max(4, Math.round(opts.padding ?? 8));

  // Font units per pixel. The layout works in a 1000-unit em regardless of the font's own em size.
  const emUnits = 1000;
  const scale = px / emUnits;

  const width = Math.max(1, Math.ceil(box.width * scale) + pad * 2);
  const height = Math.max(1, Math.ceil((box.height + box.depth) * scale) + pad * 2);
  const baseline = Math.ceil(box.height * scale) + pad;

  const rgba = new Uint8ClampedArray(width * height * 4);

  // Each glyph is cached by (gid, pixel size): a formula repeats letters, and rasterising is the expensive
  // part.
  const cache = new Map();

  const paint = (item, originX, originY) => {
    if (item.kind === 'glyph') {
      const sizePx = Math.max(1, Math.round(item.size * scale));   // glyph size in px
      const key = item.gid + ':' + sizePx;
      let hit = cache.get(key);
      if (!hit) {
        const outline = font.outline(item.gid);
        const k = sizePx / font.unitsPerEm;
        // Rasterise into a patch sized from the glyph's own metrics, with the baseline at `asc`.
        const asc = Math.ceil(Math.max(item.height, 1) * k) + 1;
        const desc = Math.ceil(Math.max(item.depth, 1) * k) + 1;
        const w = Math.max(1, Math.ceil(item.width * k) + 2);
        const h = Math.max(1, asc + desc);
        const cover = rasterize(outline, k, 1, asc, w, h);
        hit = { cover, w, h, baseline: asc };
        cache.set(key, hit);
      }
      composite(rgba, hit.cover, hit.w, hit.h, width, colour, {
        x: originX - 1,
        y: originY - hit.baseline,
      });
      return;
    }

    if (item.kind === 'rule') {
      // A bar: one or two pixels thick, drawn as plain pixels rather than as a glyph.
      const x0 = Math.max(0, originX);
      const y0 = Math.max(0, originY);
      const wpx = Math.max(1, Math.round(item.width * scale));
      const px1 = Math.max(1, Math.round(2));
      for (let y = y0; y < Math.min(height, y0 + px1); y++) {
        for (let x = x0; x < Math.min(width, x0 + wpx); x++) {
          const i = (y * width + x) * 4;
          rgba[i] = colour.r;
          rgba[i + 1] = colour.g;
          rgba[i + 2] = colour.b;
          rgba[i + 3] = 255;
        }
      }
      return;
    }

    if (item.kind === 'bracket') {
      // A BRACKET IS A VERTICAL STROKE WITH TWO ARMS POINTING INWARD.
      //
      // The stroke position depends on the side: a left bracket draws its stroke at the left edge and its
      // arms to the right; a right bracket mirrors that. Drawing both at `x0` produced two left brackets,
      // which is what made a matrix look like `[ … [` instead of `[ … ]`.
      const x0 = originX;
      const top = originY - item.height * scale;
      const bottom = originY + item.depth * scale;
      const wpx = Math.max(1, Math.round(item.width * scale));
      const arm = Math.max(2, Math.round(wpx * 0.8));
      const thick = Math.max(1, Math.round(2));
      const draw = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const i = (y * width + x) * 4;
        rgba[i] = colour.r;
        rgba[i + 1] = colour.g;
        rgba[i + 2] = colour.b;
        rgba[i + 3] = 255;
      };

      // The stroke sits at the outer edge of the bracket's own box.
      const strokeX = item.side === 'left' ? Math.round(x0) : Math.round(x0) + wpx - thick;
      const top0 = Math.max(0, Math.round(top));
      const bot0 = Math.min(height - 1, Math.round(bottom));
      for (let y = top0; y <= bot0; y++) {
        for (let t = 0; t < thick; t++) draw(strokeX + t, y);
      }

      // Arms start at the stroke and reach inward.
      const armStart = item.side === 'left' ? strokeX : strokeX - arm + thick;
      for (let a = 0; a < arm; a++) {
        for (let t = 0; t < thick; t++) {
          draw(armStart + a, top0 + t);
          draw(armStart + a, bot0 - t);
        }
      }
      return;
    }

    if (item.kind === 'brace') {
      // A left brace as a column of `{`-shaped pixels would take a real glyph; the env renderer uses a
      // bracket for `cases` too, so this only runs if a caller asks for a brace explicitly.
      return;
    }
  };

  const walk = (node, ox, oy) => {
    // The node's x/y are measured in the parent's space, in font units.
    const x = ox + Math.round((node.x || 0) * scale);
    const y = oy - Math.round((node.y || 0) * scale);
    if (node.kind) paint(node, x, y);
    if (node.items) for (const child of node.items) walk(child, x, y);
  };

  walk(box, pad, baseline);   // the tree is in FONT UNITS; `paint` and `walk` scale as they go

  // CROP FROM EITHER EDGE, if a caller asked for it.
  //
  // A picture that straddles the top of the window must be drawn from its first VISIBLE row, and a sixel
  // payload can only be cropped on a six-pixel band boundary. Cropping the ENCODED payload therefore leaves
  // between 0 and 5 pixels of the picture above the window — up to a quarter of a cell — so the formula
  // visibly slides as the view scrolls and snaps back when the leftover happens to be zero. Cropping the
  // PIXELS instead makes the first drawn row the first visible row, with no leftover to hide.
  //
  // The BOTTOM is the same problem at the panel's other edge: the transcript ends where the composer begins,
  // and a picture clipped to one visible row still drew its remaining rows over the input box. `maxHeight` is
  // the pixels that may remain; anything past it is dropped here rather than encoded and drawn.
  const skip = Math.max(0, Math.round(opts.skipTop || 0));
  const limit = opts.maxHeight > 0 ? Math.max(1, Math.round(opts.maxHeight)) : Infinity;
  if (skip > 0 || limit < height) {
    const kept = Math.max(1, Math.min(height - skip, limit));
    const cropped = new Uint8ClampedArray(width * kept * 4);
    cropped.set(rgba.subarray(skip * width * 4, (skip + kept) * width * 4));
    return { rgba: cropped, width, height: kept };
  }

  return { rgba, width, height };
}
