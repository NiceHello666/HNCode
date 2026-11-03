/**
 * Glyph outlines → antialiased coverage.
 *
 * The rasteriser is a scanline fill with 4×4 supersampling: for each pixel row, every contour crossing adds
 * a sub-sample hit, and a pixel's coverage is the fraction of its 16 sub-samples inside the shape. That is
 * enough for text at the sizes a formula uses, and it avoids the winding-number machinery a vector
 * renderer would carry.
 *
 * Coverage, not colour: the caller decides what colour to composite, which keeps one raster useful for any
 * theme.
 */

/** Sub-samples per pixel axis. 4 gives 16 levels of antialiasing. */
const SS = 4;

/**
 * An axis-aligned path flattened from a glyph outline.
 *
 * TrueType contours mix on-curve and off-curve points; consecutive off-curve points imply the control point
 * halfway between them. Flattening to line segments first keeps the fill loop simple.
 */
function flattenContours(contours, scale, offsetX, offsetY, scaleY) {
  const polys = [];
  for (const contour of contours) {
    if (contour.length < 2) continue;
    const pts = [];
    const n = contour.length;

    // A contour need not start on a curve point; when it does not, the start is the midpoint between
    // the first two off-curve points.
    let startIdx = contour.findIndex((p) => p.on);
    let startX, startY;
    if (startIdx < 0) {
      startX = (contour[0].x + contour[1].x) / 2;
      startY = (contour[0].y + contour[1].y) / 2;
      startIdx = 0;
    } else {
      startX = contour[startIdx].x;
      startY = contour[startIdx].y;
    }
    const toX = (x) => x * scale + offsetX;
    const toY = (y) => y * scaleY + offsetY;
    pts.push([toX(startX), toY(startY)]);

    let prevX = startX;
    let prevY = startY;
    let ctrl = null;

    for (let k = 1; k <= n; k++) {
      const p = contour[(startIdx + k) % n];
      if (p.on) {
        if (ctrl) {
          emitQuad(pts, prevX, prevY, ctrl.x, ctrl.y, p.x, p.y, toX, toY);
          ctrl = null;
        } else {
          pts.push([toX(p.x), toY(p.y)]);
        }
        prevX = p.x; prevY = p.y;
      } else {
        if (ctrl) {
          // Two off-curve points in a row imply an on-curve point halfway between them.
          const mx = (ctrl.x + p.x) / 2;
          const my = (ctrl.y + p.y) / 2;
          emitQuad(pts, prevX, prevY, ctrl.x, ctrl.y, mx, my, toX, toY);
          prevX = mx; prevY = my;
        }
        ctrl = p;
      }
    }

    // Close the contour back to where it started.
    if (ctrl) emitQuad(pts, prevX, prevY, ctrl.x, ctrl.y, startX, startY, toX, toY);
    polys.push(pts);
  }
  return polys;
}

/** Flatten one quadratic bezier into line segments, appending to `pts`. */
function emitQuad(pts, x0, y0, cx, cy, x1, y1, toX, toY) {
  const steps = Math.max(2, Math.min(16, Math.ceil(Math.hypot(toX(x1) - toX(x0), toY(y1) - toY(y0)) / 2) || 2));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    pts.push([toX(x), toY(y)]);
  }
}

/**
 * Rasterise contours into a coverage bitmap.
 *
 * @param {Array<Array<{x:number,y:number,on:boolean}>>} contours Glyph outline in font units.
 * @param {number} scale Font units → pixels.
 * @param {number} offsetX Where the glyph origin lands, in pixels.
 * @param {number} offsetY Where the baseline lands, in pixels (y grows DOWN in the output).
 * @param {number} width Bitmap width in pixels.
 * @param {number} height Bitmap height in pixels.
 * @returns {Float32Array} Coverage 0..1 per pixel, row-major.
 */
export function rasterize(contours, scale, offsetX, offsetY, width, height) {
  const cover = new Float32Array(width * height);
  if (!contours.length || width <= 0 || height <= 0) return cover;

  // The outline's y grows up; the bitmap's grows down, so the offset flips it.
  // Negating the y scale flips the outline into bitmap space, so `offsetY` is a real baseline row.
  const polys = flattenContours(contours, scale, offsetX, offsetY, -scale);
  if (!polys.length) return cover;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of polys) for (const [, y] of poly) { if (y < minY) minY = y; if (y > maxY) maxY = y; }

  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));

  // Horizontal edges never contribute a crossing; skip them.
  const edges = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      if (ay === by) continue;
      edges.push(ax < bx ? [ax, ay, bx, by] : [bx, by, ax, ay]);
    }
  }
  if (!edges.length) return cover;

  const rowHits = new Map();   // pixel index -> sub-sample hits

  for (let py = y0; py <= y1; py++) {
    for (let sy = 0; sy < SS; sy++) {
      const y = py + (sy + 0.5) / SS;
      const xs = [];
      for (const [ax, ay, bx, by] of edges) {
        if ((y >= ay && y < by) || (y >= by && y < ay)) {
          const t = (y - ay) / (by - ay);
          xs.push(ax + (bx - ax) * t);
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      // Even-odd fill: spans between crossing pairs are inside.
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const spanFrom = xs[i];
        const spanTo = xs[i + 1];
        if (spanTo <= spanFrom) continue;
        const pxFrom = Math.max(0, Math.floor(spanFrom));
        const pxTo = Math.min(width - 1, Math.ceil(spanTo) - 1);
        for (let px = pxFrom; px <= pxTo; px++) {
          // Sub-sample coverage of this pixel by this span.
          const left = Math.max(spanFrom, px);
          const right = Math.min(spanTo, px + 1);
          if (right <= left) continue;
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) / SS;
            if (x >= left && x < right) {
              const key = py * width + px;
              rowHits.set(key, (rowHits.get(key) || 0) + 1);
            }
          }
        }
      }
    }
  }

  const total = SS * SS;
  for (const [key, hits] of rowHits) cover[key] = Math.min(1, hits / total);
  return cover;
}

/**
 * Composite a coverage bitmap onto an RGBA buffer.
 *
 * @param {Uint8ClampedArray} rgba Destination, length width*height*4.
 * @param {Float32Array} cover Coverage 0..1, row-major.
 * @param {number} width Bitmap width.
 * @param {number} height Bitmap height.
 * @param {{r:number,g:number,b:number}} colour Ink colour.
 * @param {{x:number,y:number}} at Where the coverage bitmap's top-left goes.
 */
/**
 * Composite a coverage bitmap onto an RGBA buffer.
 *
 * `stride` is the destination width, which is not the coverage width: the glyph is a small patch placed
 * inside a larger image, and using one width for both wrote every row at the wrong offset.
 *
 * @param {Uint8ClampedArray} rgba Destination, length stride*height*4.
 * @param {Float32Array} cover Coverage 0..1, row-major, width*height.
 * @param {number} width Coverage width.
 * @param {number} height Coverage height.
 * @param {number} stride Destination width in pixels.
 * @param {{r:number,g:number,b:number}} colour Ink colour.
 * @param {{x:number,y:number}} at Where the coverage patch goes, in destination pixels.
 */
export function composite(rgba, cover, width, height, stride, colour, at) {
  for (let y = 0; y < height; y++) {
    const dy = at.y + y;
    if (dy < 0) continue;
    for (let x = 0; x < width; x++) {
      const a = cover[y * width + x];
      if (a <= 0) continue;
      const dx = at.x + x;
      if (dx < 0 || dx >= stride) continue;
      const i = (dy * stride + dx) * 4;
      if (i + 3 >= rgba.length) continue;
      const dstA = rgba[i + 3] / 255;
      const outA = a + dstA * (1 - a);
      if (outA <= 0) continue;
      rgba[i] = (colour.r * a + rgba[i] * dstA * (1 - a)) / outA;
      rgba[i + 1] = (colour.g * a + rgba[i + 1] * dstA * (1 - a)) / outA;
      rgba[i + 2] = (colour.b * a + rgba[i + 2] * dstA * (1 - a)) / outA;
      rgba[i + 3] = outA * 255;
    }
  }
}
