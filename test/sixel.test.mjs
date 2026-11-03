// The Sixel encoder, checked by round-tripping through a decoder written from the spec.
//
// A picture that arrives stretched, shifted, blank, or six rows too high looks perfectly plausible in the
// encoder's own source, so nothing here inspects the bytes: each image is encoded, decoded again, and
// compared pixel for pixel with the input.
//
// The decoder is deliberately NOT the one from the `sixel` package. Measured, that one reports an 8x6 image
// as 10x6 — it is the reference implementation's own encoder output it misreads — so a test built on it
// would either pass on a broken encoder or fail on a correct one. This decoder handles exactly the subset
// this encoder emits and throws on anything else, which turns an encoder bug into an error instead of a
// plausible picture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSixel, introducer, FINALIZER, BAND } from '../src/tex/sixel.js';

/**
 * Read a Sixel sequence back into pixels.
 *
 *   DCS      ESC P P1;P2;P3; q
 *   raster   " Pan;Pad;Ph;Pv          exactly four parameters
 *   colour   # register ; space ; r ; g ; b     space 2 = RGB, components as percentages
 *   data     6 bits per character, 63 (`?`) is empty
 *
 * @param {string} seq
 * @returns {{width: number, height: number, pixels: Int16Array, palette: Map<number, object>, dcsParams: string}}
 */
function decodeSixel(seq) {
  const dcs = /^\x1bP([0-9;]*)q/.exec(seq);
  assert.ok(dcs, 'the sequence opens with a DCS introducer');
  assert.ok(seq.endsWith(FINALIZER), 'and closes with the string terminator');
  const body = seq.slice(dcs[0].length, seq.length - FINALIZER.length);

  const palette = new Map();
  let raster = null;
  const bands = [];
  let current = new Map();   // colour -> Map<column, bits>
  let x = 0;
  let colour = 0;

  let i = 0;
  while (i < body.length) {
    const ch = body[i];

    if (ch === '"') {
      const m = /^"([0-9;]*)/.exec(body.slice(i));
      const parts = m[1].split(';').map(Number);
      assert.equal(parts.length, 4, `raster attributes take exactly 4 parameters, got "${m[1]}"`);
      raster = { pan: parts[0], pad: parts[1], width: parts[2], height: parts[3] };
      i += m[0].length;
      continue;
    }

    if (ch === '#') {
      const m = /^#(\d+)(?:;(\d+);(\d+);(\d+);(\d+))?/.exec(body.slice(i));
      assert.ok(m, `malformed colour at ${i}`);
      colour = Number(m[1]);
      if (m[2] !== undefined) {
        assert.equal(Number(m[2]), 2, 'a colour must be declared in the RGB space');
        palette.set(colour, {
          r: Math.round(Number(m[3]) * 255 / 100),
          g: Math.round(Number(m[4]) * 255 / 100),
          b: Math.round(Number(m[5]) * 255 / 100),
        });
      }
      i += m[0].length;
      continue;
    }

    if (ch === '!') {
      const m = /^!(\d+)(.{1})/s.exec(body.slice(i));
      assert.ok(m, `malformed repeat at ${i}`);
      const count = Number(m[1]);
      const bits = m[2].charCodeAt(0) - 63;
      assert.ok(bits >= 0 && bits <= 63, `repeat of something that is not sixel data: ${JSON.stringify(m[2])}`);
      let mask = current.get(colour);
      if (!mask) { mask = new Map(); current.set(colour, mask); }
      for (let k = 0; k < count; k++) { mask.set(x, (mask.get(x) || 0) | bits); x++; }
      i += m[0].length;
      continue;
    }

    if (ch === '$') { x = 0; i++; continue; }
    if (ch === '-') { bands.push(current); current = new Map(); x = 0; i++; continue; }

    const code = body.charCodeAt(i);
    assert.ok(code >= 63 && code <= 126, `unexpected character ${JSON.stringify(ch)} at ${i}`);
    let mask = current.get(colour);
    if (!mask) { mask = new Map(); current.set(colour, mask); }
    mask.set(x, (mask.get(x) || 0) | (code - 63));
    x++;
    i++;
  }
  bands.push(current);

  let width = raster ? raster.width : 0;
  let height = raster ? raster.height : 0;
  if (!raster) {
    for (const band of bands) {
      for (const mask of band.values()) for (const column of mask.keys()) width = Math.max(width, column + 1);
    }
    height = bands.length * BAND;
  }

  const pixels = new Int16Array(width * height).fill(-1);
  for (let b = 0; b < bands.length; b++) {
    for (const [index, mask] of bands[b]) {
      for (const [column, bits] of mask) {
        for (let r = 0; r < BAND; r++) {
          if (!(bits & (1 << r))) continue;
          const y = b * BAND + r;
          if (column < width && y < height) pixels[y * width + column] = index;
        }
      }
    }
  }
  return { width, height, pixels, palette, dcsParams: dcs[1] };
}

/** An RGBA buffer whose opaque pixels are the ones `inkAt` names. */
function image(width, height, inkAt) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inkAt(x, y)) continue;
      const i = (y * width + x) * 4;
      rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Encode, decode, and assert every pixel survived in the right place. */
function assertRoundTrip(width, height, inkAt, label) {
  const seq = encodeSixel(image(width, height, inkAt), width, height);
  const back = decodeSixel(seq);
  assert.equal(back.width, width, `${label}: width survives`);
  assert.equal(back.height, height, `${label}: height survives`);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const painted = back.pixels[y * width + x] >= 0;
      assert.equal(painted, Boolean(inkAt(x, y)), `${label}: pixel ${x},${y}`);
    }
  }
  return back;
}

test('the raster attribute carries exactly four parameters, with no background flag', () => {
  // A fifth parameter shifts every field a decoder reads: the height is taken as something else and the
  // image comes back the wrong shape. It belongs in the DCS, not here.
  const back = assertRoundTrip(8, 6, () => true, 'solid');
  assert.match(back.dcsParams, /^0;[01];0;$/, `DCS carries aspect, background select, grid: "${back.dcsParams}"`);
});

test('a solid image round-trips', () => {
  assertRoundTrip(8, 6, () => true, 'one band');
  assertRoundTrip(8, 12, () => true, 'two bands');
  // A height that is not a multiple of six: the last band is partial.
  assertRoundTrip(5, 7, () => true, 'partial band');
});

test('ink lands on the rows and columns it was drawn on', () => {
  // A diagonal: any column shift or band offset shows up as a mismatch.
  assertRoundTrip(10, 12, (x, y) => x === y, 'diagonal');
  // A pixel in the last row of several bands, which is where a band offset would move it.
  assertRoundTrip(8, 18, (x, y) => x === 7 && y % 6 === 5, 'band bottoms');
  assertRoundTrip(4, 7, (x, y) => x === 2 && y === 6, 'a single low pixel');
});

test('a band with nothing in it still advances the cursor', () => {
  // Sixel is positioned RELATIVE to the cursor: a band is placed by the `-` separators before it, not by its
  // own content. Dropping the separator for an empty band pulls everything below it up by six rows, which
  // put a formula's descenders inside the line above.
  assertRoundTrip(6, 18, (x, y) => (y < 6 ? x === 1 : y >= 12 ? x === 4 : false), 'blank middle band');
  assertRoundTrip(8, 18, (x, y) => y >= 12 && x < 4, 'blank first bands');
});

test('a transparent image paints nothing where the ink is not', () => {
  // The default: unpainted pixels are left alone so the terminal's own background shows through. A pixel
  // with no alpha is not part of the picture at all.
  const seq = encodeSixel(image(9, 6, (x) => x === 4), 9, 6);
  const back = decodeSixel(seq);
  assert.equal(back.pixels.filter((p) => p >= 0).length, 6, 'one column of six pixels');
  assert.equal(decodeSixel(seq).dcsParams.split(';')[1], '1', 'background select says "leave what is behind"');
});

test('the palette keeps the shades that make an edge readable', () => {
  // Antialiased edges are a ramp of one colour, not many hues. A formula drawn with two registers would be
  // a silhouette; the encoder must keep the ramp's steps apart on a gradient.
  const width = 64;
  const rgba = new Uint8ClampedArray(width * 6 * 4);
  for (let x = 0; x < width; x++) {
    const shade = Math.round(x * 255 / (width - 1));
    for (let y = 0; y < 6; y++) {
      const i = (y * width + x) * 4;
      rgba[i] = shade; rgba[i + 1] = shade; rgba[i + 2] = shade; rgba[i + 3] = 255;
    }
  }
  const back = decodeSixel(encodeSixel(rgba, width, 6));
  const greys = new Set();
  for (let x = 0; x < width; x++) {
    const entry = back.palette.get(back.pixels[x]);
    assert.ok(entry, `column ${x} is painted`);
    greys.add(entry.r);
  }
  // 64 distinct levels in, at least 32 out: a median cut over a smooth ramp should lose almost nothing.
  assert.ok(greys.size >= 32, `the ramp keeps its steps: ${greys.size} distinct shades of 64`);
});

test('an empty image is still a well-formed sequence', () => {
  const seq = encodeSixel(new Uint8ClampedArray(0), 0, 0);
  assert.ok(seq.startsWith(introducer(true)), 'introducer present');
  assert.ok(seq.endsWith(FINALIZER), 'terminator present');
});

test('line art is a one-bit mask in the ink colour', () => {
  // A formula is one colour drawn with antialiasing. Encoding its coverage as a grey ramp spends dozens of
  // registers and, once the terminal fits it, turns hairline strokes into speckle — so a `lineArt` raster
  // must come out as ONE register, and every pixel either fully painted in it or not painted at all.
  const width = 24;
  const height = 6;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      // A coverage ramp along x: 0 at the left edge, fully covered in the middle, and a hairline at the very
      // last column whose coverage sits BELOW the threshold.
      const coverage = x < 8 ? 0 : x < 16 ? 255 : x === 23 ? 40 : 90;
      const i = (y * width + x) * 4;
      rgba[i] = 220; rgba[i + 1] = 220; rgba[i + 2] = 220; rgba[i + 3] = coverage;
    }
  }
  const ink = { r: 220, g: 220, b: 220 };
  const back = decodeSixel(encodeSixel(rgba, width, height, { transparent: true, lineArt: true, ink }));

  assert.equal(back.palette.size, 1, `one register, not a ramp: ${back.palette.size}`);
  const only = [...back.palette.values()][0];
  // Sixel states colour components as percentages, so a byte value survives the round trip only to within
  // that quantisation — one step of 1/100 of the range.
  for (const channel of ['r', 'g', 'b']) {
    assert.ok(Math.abs(only[channel] - ink[channel]) <= 3,
      `the register is the ink colour: ${channel} ${only[channel]} vs ${ink[channel]}`);
  }

  const cols = (y) => Array.from({ length: width }, (_, x) => back.pixels[y * width + x] >= 0);
  const row = cols(0);
  for (let x = 0; x < 8; x++) assert.equal(row[x], false, `column ${x}: below the threshold, not painted`);
  for (let x = 8; x < 23; x++) assert.equal(row[x], true, `column ${x}: painted`);
  assert.equal(row[23], false, 'coverage under 25% is not painted');
});

test('the same raster without lineArt keeps its shades', () => {
  // The rule is opt-in: a picture that is not line art still gets a palette, which is what makes a
  // photograph or a UI sprite readable.
  const width = 32;
  const rgba = new Uint8ClampedArray(width * 6 * 4);
  for (let x = 0; x < width; x++) {
    const shade = Math.round(x * 255 / (width - 1));
    for (let y = 0; y < 6; y++) {
      const i = (y * width + x) * 4;
      rgba[i] = shade; rgba[i + 1] = shade; rgba[i + 2] = shade; rgba[i + 3] = 255;
    }
  }
  const back = decodeSixel(encodeSixel(rgba, width, 6));
  assert.ok(back.palette.size >= 16, `a ramp keeps its registers: ${back.palette.size}`);
});
