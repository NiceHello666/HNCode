/**
 * RGBA → a Sixel image sequence.
 *
 * Sixel is a raster format where a row of six pixels is one character: 63 (`?`) is blank and successive
 * bits set pixels top-down, so `@` lights the top pixel of the band and `B` the top two. The encoder walks
 * the image in bands of six rows, quantises colours to a palette, and emits one `#n` colour select followed
 * by the run-encoded pixels for that colour.
 *
 * THE THREE SEQUENCES, and getting them wrong is how a sixel arrives stretched, shifted or blank:
 *
 *   DCS      `ESC P P1;P2;P3; q`   — P2 is the BACKGROUND SELECT, the only one most terminals implement
 *   raster   `" Pan;Pad;Ph;Pv`     — exactly four parameters: aspect, aspect, width, height
 *   finalize `ESC \`               — returns the terminal to normal operation
 *
 * The raster attribute carries NO background parameter. Putting one there (as this encoder used to) makes a
 * decoder read the height as the wrong field, and the image comes out wider than it is: measured, an 8-pixel
 * wide picture decoded as 10.
 *
 * A BAND WITH NOTHING IN IT STILL ADVANCES. Sixel draws relative to wherever the cursor sits, so a band is
 * positioned by the `-` characters before it, not by its own content. Skipping the `-` for an empty band
 * pulls everything below it UP by six rows, which is what put a formula's descenders inside the line above.
 *
 * The palette is built with a median cut over the image's own colours rather than a fixed 256-colour cube.
 * A formula is a handful of greys plus antialiased edges, and a cube would spend its entries on colours that
 * never appear.
 */

/** Bands are six pixel rows tall by definition. */
const BAND = 6;

/** DCS: pixel aspect 0 (default), background select, no horizontal grid. */
const introducer = (transparent) => `\x1bP0;${transparent ? 1 : 0};0;q`;
/** String Terminator. */
const FINALIZER = '\x1b\\';

/**
 * Build a palette from the distinct opaque colours in the image, at most `max` of them.
 * Median cut: repeatedly split the box with the widest channel spread at its median.
 */
function buildPalette(rgba, background, max = 255) {
  // Flatten alpha onto the background so the antialiased edges become SHADES rather than the ink colour at
  // a lower alpha. Sixel has no partial alpha; without this every edge painted solid.
  const bgColour = background || { r: 0, g: 0, b: 0 };
  const shade = (i) => {
    const a = rgba[i + 3] / 255;
    return {
      r: Math.round(rgba[i] * a + bgColour.r * (1 - a)),
      g: Math.round(rgba[i + 1] * a + bgColour.g * (1 - a)),
      b: Math.round(rgba[i + 2] * a + bgColour.b * (1 - a)),
    };
  };

  const seen = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;      // fully transparent: not part of the picture at all
    const s = shade(i);
    const key = (s.r << 16) | (s.g << 8) | s.b;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  if (seen.size === 0) return [{ r: 0, g: 0, b: 0 }];

  // DROP THE BACKGROUND SHADE BEFORE ANY EARLY RETURN.
  //
  // A shade identical to the background is indistinguishable from the unpainted area, so selecting it for
  // ink paints nothing. It has to go before the "few colours, use them all" shortcut below, or the darkest
  // shade keeps the background's colour and the formula loses its dark side.
  if (bgColour) {
    const bgKey = (bgColour.r << 16) | (bgColour.g << 8) | bgColour.b;
    if (seen.size > 1) seen.delete(bgKey);
  }

  if (seen.size <= max) {
    return [...seen.keys()].map((k) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 }));
  }

  let boxes = [[...seen.entries()].map(([k, n]) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, n }))];

  while (boxes.length < max) {
    // Split the box with the largest weighted extent.
    let bestIdx = -1;
    let bestSpread = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      const spread = ['r', 'g', 'b'].reduce((m, ch) => {
        let lo = 255;
        let hi = 0;
        for (const c of box) { if (c[ch] < lo) lo = c[ch]; if (c[ch] > hi) hi = c[ch]; }
        return Math.max(m, hi - lo);
      }, 0);
      if (spread > bestSpread) { bestSpread = spread; bestIdx = b; }
    }
    if (bestIdx < 0) break;

    const box = boxes[bestIdx];
    // Split on the channel with the widest range.
    let channel = 'r';
    let widest = 0;
    for (const ch of ['r', 'g', 'b']) {
      let lo = 255;
      let hi = 0;
      for (const c of box) { if (c[ch] < lo) lo = c[ch]; if (c[ch] > hi) hi = c[ch]; }
      if (hi - lo > widest) { widest = hi - lo; channel = ch; }
    }
    box.sort((a, b) => a[channel] - b[channel]);
    let cut = 0;
    let total = 0;
    for (const c of box) total += c.n;
    let acc = 0;
    for (let i = 0; i < box.length; i++) {
      acc += box[i].n;
      if (acc >= total / 2) { cut = Math.max(1, Math.min(box.length - 1, i + 1)); break; }
    }
    const left = box.slice(0, cut);
    const right = box.slice(cut);
    if (!left.length || !right.length) { boxes.splice(bestIdx, 1); continue; }
    boxes.splice(bestIdx, 1, left, right);
  }

  // Each box becomes its weighted mean.
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  });
}

/** Nearest palette entry, by squared distance. */
function nearest(palette, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (p.r - r) * (p.r - r) + (p.g - g) * (p.g - g) + (p.b - b) * (p.b - b);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** A sixel data character for one column's six-bit mask. */
const sixelChar = (bits) => String.fromCharCode(63 + bits);

/**
 * Write the band-major body of a sequence from a per-pixel colour register.
 *
 * Every band ends with `-`, an empty one included: the separator advances the cursor by six rows and is the
 * only thing that says where the next band starts. Skipping it for an empty band pulls everything below it
 * UP by six rows, which is what put a formula's descenders inside the line above.
 *
 * @param {Int16Array} indices One entry per pixel: a colour register, or -1 for "not painted".
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function encodeBands(indices, w, h) {
  let out = '';
  let written = 0;
  for (let by = 0; by < h; by += BAND) {
    const rows = Math.min(BAND, h - by);

    // Which colours appear in this band, and the six-bit column masks that paint them.
    const masks = new Map();
    for (let x = 0; x < w; x++) {
      for (let r = 0; r < rows; r++) {
        const idx = indices[(by + r) * w + x];
        if (idx < 0) continue;
        let m = masks.get(idx);
        if (!m) { m = new Uint8Array(w); masks.set(idx, m); }
        m[x] |= 1 << r;
      }
    }

    if (written > 0) out += '-';
    written++;
    if (masks.size === 0) continue;

    let first = true;
    for (const [idx, mask] of masks) {
      const chars = new Array(w);
      for (let x = 0; x < w; x++) chars[x] = sixelChar(mask[x]);
      // Within a band a second colour restarts at column 0: that is what `$` does.
      if (!first) out += '$';
      first = false;
      out += '#' + idx + encodeRun(chars);
    }
  }
  return out;
}

/**
 * Encode a single-colour coverage mask: one ink register, one bit per pixel.
 *
 * This is the form a typeset formula takes. The raster is antialiased COVERAGE, and Sixel has no partial
 * alpha, so a pixel either reaches `threshold` and is painted in full `ink` or is not painted at all. A hard
 * mask is what keeps a hairline stroke — a fraction bar, a radical overline — continuous, where encoding the
 * antialiased ramp as greys dissolves it into speckle. dsh-tui settles on the same rule (src/ink/
 * sixel-codec.ts, `sixelCoveragePaintsThreshold`: a 25% bar).
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {{transparent: boolean, background: {r:number,g:number,b:number}, threshold: number,
 *   ink: {r:number,g:number,b:number}}} opts
 * @returns {string}
 */
function encodeMask(rgba, w, h, opts) {
  const { transparent, background: bg, threshold, ink } = opts;
  const indices = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // An opaque background paints every pixel; a transparent one paints only the covered ones.
      if (transparent && rgba[i + 3] < threshold) continue;
      indices[y * w + x] = transparent ? 0 : 1;
    }
  }

  let out = introducer(transparent);
  out += `"1;1;${w};${h}`;
  if (!transparent) {
    out += '#0;2;' + Math.round(bg.r * 100 / 255) + ';' + Math.round(bg.g * 100 / 255) + ';'
      + Math.round(bg.b * 100 / 255);
  }
  out += '#' + (transparent ? 0 : 1) + ';2;'
    + Math.round(ink.r * 100 / 255) + ';' + Math.round(ink.g * 100 / 255) + ';'
    + Math.round(ink.b * 100 / 255);
  return out + encodeBands(indices, w, h) + FINALIZER;
}

/**
 * Encode an RGBA image as a Sixel sequence.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels, width*height*4.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {{transparent?: boolean, background?: {r:number,g:number,b:number}}} [opts]
 *   `transparent` (the default) leaves uncovered pixels alone so the terminal's own background shows through;
 *   pass `false` to paint the whole box in `background`.
 * @returns {string} The sequence, ready to write to the terminal.
 */
export function encodeSixel(rgba, width, height, opts = {}) {
  const w = Math.max(0, width | 0);
  const h = Math.max(0, height | 0);
  if (!w || !h) return introducer(true) + FINALIZER;

  const bg = opts.background || { r: 0, g: 0, b: 0 };
  const transparent = opts.transparent !== false;

  // LINE ART IS A ONE-BIT MASK, not a gradient.
  //
  // A formula is a single ink colour drawn with antialiasing, and Sixel has no partial alpha. Encoding the
  // antialiased ramp as dozens of grey registers costs a large payload, and the terminal's own fitting then
  // turns those middle greys into speckle. dsh-tui reaches the same conclusion (src/ink/sixel-codec.ts,
  // `sixelCoveragePaintsThreshold`): with `lineArt` the coverage is promoted at one threshold, so a hairline
  // stroke — a fraction bar, a radical overline, a superscript — stays continuous instead of fading out.
  const lineArt = opts.lineArt === true;
  const ink = opts.ink || null;
  if (lineArt || ink) {
    return encodeMask(rgba, w, h, {
      transparent,
      background: bg,
      threshold: lineArt ? 64 : 0,          // 25% coverage, the same bar dsh-tui uses
      ink: ink || { r: 220, g: 220, b: 220 },
    });
  }

  const palette = buildPalette(rgba, transparent ? null : bg);

  // Map every pixel through the SAME flattening the palette was built with. Comparing the raw ink colour
  // against background-blended shades put nearly every pixel on one of two entries, and the formula lost its
  // edges. `-1` means "not painted", which is how a transparent pixel is expressed.
  const indices = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      if (a <= 0.02 && transparent) continue;
      const r = Math.round(rgba[i] * a + bg.r * (1 - a));
      const g = Math.round(rgba[i + 1] * a + bg.g * (1 - a));
      const b = Math.round(rgba[i + 2] * a + bg.b * (1 - a));
      indices[y * w + x] = nearest(palette, r, g, b);
    }
  }

  let out = introducer(transparent);
  // Raster attributes: aspect ratio, then the drawing area in pixels, and NOTHING else.
  out += `"1;1;${w};${h}`;

  // Colour registers. An opaque image owns register 0 for the background; a transparent one uses all of
  // them for ink, because nothing is painted behind the picture.
  const firstRegister = transparent ? 0 : 1;
  if (!transparent) {
    out += '#0;2;' + Math.round(bg.r * 100 / 255) + ';' + Math.round(bg.g * 100 / 255) + ';'
      + Math.round(bg.b * 100 / 255);
  }
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    // Sixel colour components are percentages, 0..100, not bytes.
    out += '#' + (i + firstRegister) + ';2;'
      + Math.round(p.r * 100 / 255) + ';'
      + Math.round(p.g * 100 / 255) + ';'
      + Math.round(p.b * 100 / 255);
  }

  // Register numbers: an opaque image reserves register 0 for its background, so the ink registers start at
  // 1. Shifting the indices once keeps the band writer unaware of that.
  if (firstRegister !== 0) {
    for (let i = 0; i < indices.length; i++) if (indices[i] >= 0) indices[i] += firstRegister;
  }
  return out + encodeBands(indices, w, h) + FINALIZER;
}

/** Run-encode one colour's row of sixel characters. */
function encodeRun(chars) {
  let out = '';
  let run = 1;
  for (let x = 1; x <= chars.length; x++) {
    if (x < chars.length && chars[x] === chars[x - 1]) { run++; continue; }
    const ch = chars[x - 1];
    out += run >= 4 ? '!' + run + ch : ch.repeat(run);
    run = 1;
  }
  return out;
}

export { introducer, FINALIZER, BAND };
