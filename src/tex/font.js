/**
 * A TrueType font reader: the tables a rasteriser needs, and glyph outlines as flat contours.
 *
 * Only the `glyf` outline format is read. STIX Two ships CFF outlines in its OpenType build (`.otf`), whose
 * Type 2 charstrings are a postfix program with subroutines, flex operators and hint masks; the TrueType
 * build (`.ttf`) holds the same outlines as quadratic `glyf` contours, which is a fraction of the surface
 * area. That is the one bundled here, and it is what `tools/otf-to-ttf.py` produces from the CFF original.
 *
 * Nothing here tries to be a full font engine. Hints, kerning and shaping are absent on purpose: a formula
 * is laid out by its own rules, and the size is fixed, so none of them affect the raster.
 */
import fs from 'node:fs';

/** Read a big-endian uint16 / int16 / uint32 helpers over a Buffer. */
const u16 = (b, o) => b.readUInt16BE(o);
const i16 = (b, o) => b.readInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

/** Decode a UTF-16BE string of `len` bytes at `o`. */
function utf16be(buf, o, len) {
  let s = '';
  for (let i = 0; i < len; i += 2) s += String.fromCharCode(buf.readUInt16BE(o + i));
  return s;
}

export class TrueTypeFont {
  /**
   * @param {Buffer} buf The whole file.
   */
  constructor(buf) {
    this.buf = buf;
    const numTables = u16(buf, 4);
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = buf.toString('latin1', rec, rec + 4);
      this.tables.set(tag, { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) });
    }

    const head = this.table('head');
    this.unitsPerEm = u16(head, 18);
    this.indexToLocFormat = i16(head, 50);

    const hhea = this.table('hhea');
    this.numHMetrics = u16(hhea, 34);
    this.ascender = i16(hhea, 4);
    this.descender = i16(hhea, 6);

    this.numGlyphs = u16(this.table('maxp'), 4);
    this._cmap = this._readCmap();
    this._loca = null;
    this._outlineCache = new Map();
  }

  table(tag) {
    const t = this.tables.get(tag);
    if (!t) throw new Error('font is missing the ' + tag + ' table');
    return this.buf.subarray(t.offset, t.offset + t.length);
  }

  /**
   * The Unicode → glyph id map, from the best `cmap` subtable available.
   * Prefers a full-repertoire format 12 over the BMP-only format 4.
   */
  _readCmap() {
    const cmap = this.table('cmap');
    const count = u16(cmap, 2);
    let best = null;
    for (let i = 0; i < count; i++) {
      const rec = 4 + i * 8;
      const platform = u16(cmap, rec);
      const encoding = u16(cmap, rec + 2);
      const offset = u32(cmap, rec + 4);
      const format = u16(cmap, offset);
      // Unicode full repertoire: platform 3 encoding 10, or platform 0 encoding 4/6.
      if (format === 12 && ((platform === 3 && encoding === 10) || (platform === 0 && (encoding === 4 || encoding === 6)))) {
        best = { offset, format };
      }
      if (!best && format === 4 && (platform === 3 && encoding === 1 || platform === 0)) {
        best = { offset, format };
      }
    }
    if (!best) throw new Error('font has no usable cmap subtable');
    return best;
  }

  /** Glyph id for a code point, or 0 when the font has none. */
  glyphIndex(cp) {
    const cmap = this.table('cmap');
    const { offset, format } = this._cmap;

    if (format === 12) {
      const nGroups = u32(cmap, offset + 12);
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = offset + 16 + mid * 12;
        const start = u32(cmap, g);
        const end = u32(cmap, g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return u32(cmap, g + 8) + (cp - start);
      }
      return 0;
    }

    // Format 4: segmented into 16-bit ranges.
    const segX2 = u16(cmap, offset + 6);
    const segCount = segX2 / 2;
    const endAt = offset + 14;
    const startAt = endAt + segX2 + 2;
    const deltaAt = startAt + segX2;
    const rangeAt = deltaAt + segX2;
    for (let s = 0; s < segCount; s++) {
      if (cp > u16(cmap, endAt + s * 2)) continue;
      const start = u16(cmap, startAt + s * 2);
      if (cp < start) return 0;
      const delta = i16(cmap, deltaAt + s * 2);
      const rangeOffset = u16(cmap, rangeAt + s * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const glyphAt = rangeAt + s * 2 + rangeOffset + (cp - start) * 2;
      const g = u16(cmap, glyphAt);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  }

  /** Advance width of a glyph, in font units. */
  advance(gid) {
    const hmtx = this.table('hmtx');
    const n = Math.min(gid, this.numHMetrics - 1);
    return u16(hmtx, n * 4);
  }

  _locaTable() {
    if (this._loca) return this._loca;
    const buf = this.table('loca');
    const n = this.numGlyphs + 1;
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.indexToLocFormat === 0 ? u16(buf, i * 2) * 2 : u32(buf, i * 4);
    }
    this._loca = out;
    return out;
  }

  /**
   * The contours of a glyph in font units, with y pointing UP.
   *
   * Each contour is an array of points `{x, y, on}` where `on` marks a point on the curve; consecutive
   * off-curve points imply a quadratic control point between them, which is how TrueType stores curves.
   * Composite glyphs are resolved by recursing into their components.
   */
  outline(gid, depth = 0) {
    if (this._outlineCache.has(gid)) return this._outlineCache.get(gid);
    const contours = this._readGlyph(gid, depth);
    this._outlineCache.set(gid, contours);
    return contours;
  }

  _readGlyph(gid, depth) {
    if (depth > 8 || gid >= this.numGlyphs) return [];
    const loca = this._locaTable();
    const glyf = this.table('glyf');
    const start = loca[gid];
    const end = loca[gid + 1];
    if (end <= start) return [];   // empty glyph, e.g. a space

    const g = glyf.subarray(start, end);
    const numberOfContours = i16(g, 0);

    if (numberOfContours < 0) return this._readComposite(g, depth);
    return this._readSimple(g, numberOfContours);
  }

  _readSimple(g, numberOfContours) {
    const endPts = [];
    for (let i = 0; i < numberOfContours; i++) endPts.push(u16(g, 10 + i * 2));
    const nPoints = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
    if (nPoints === 0) return [];

    let p = 10 + numberOfContours * 2;
    const instructionLength = u16(g, p);
    p += 2 + instructionLength;

    // Flags, with the repeat bit collapsing runs of identical ones.
    const flags = new Uint8Array(nPoints);
    for (let i = 0; i < nPoints;) {
      const f = g[p++];
      flags[i++] = f;
      if (f & 0x08) {
        let repeat = g[p++];
        while (repeat-- > 0 && i < nPoints) flags[i++] = f;
      }
    }

    // X coordinates.
    const xs = new Int32Array(nPoints);
    let x = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x02) {
        const d = g[p++];
        x += (f & 0x10) ? d : -d;
      } else if (!(f & 0x10)) {
        x += i16(g, p);
        p += 2;
      }
      xs[i] = x;
    }

    // Y coordinates.
    const ys = new Int32Array(nPoints);
    let y = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x04) {
        const d = g[p++];
        y += (f & 0x20) ? d : -d;
      } else if (!(f & 0x20)) {
        y += i16(g, p);
        p += 2;
      }
      ys[i] = y;
    }

    const contours = [];
    let first = 0;
    for (const last of endPts) {
      const pts = [];
      for (let i = first; i <= last; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
      if (pts.length) contours.push(pts);
      first = last + 1;
    }
    return contours;
  }

  _readComposite(g, depth) {
    const out = [];
    let p = 10;
    for (;;) {
      const flags = u16(g, p);
      const glyphIndex = u16(g, p + 2);
      p += 4;

      let dx = 0;
      let dy = 0;
      if (flags & 0x0001) {
        // ARG_1_AND_2_ARE_WORDS
        dx = i16(g, p); dy = i16(g, p + 2); p += 4;
      } else {
        dx = (g[p] << 24) >> 24; dy = (g[p + 1] << 24) >> 24; p += 2;
      }

      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 0x0008) {
        a = d = i16(g, p) / 16384; p += 2;
      } else if (flags & 0x0040) {
        a = i16(g, p) / 16384; d = i16(g, p + 2) / 16384; p += 4;
      } else if (flags & 0x0080) {
        a = i16(g, p) / 16384; b = i16(g, p + 2) / 16384;
        c = i16(g, p + 4) / 16384; d = i16(g, p + 6) / 16384;
        p += 8;
      }

      // ARGS_ARE_XY_VALUES: dx/dy are offsets. Otherwise they are point indices, which no math glyph uses.
      for (const contour of this._readGlyph(glyphIndex, depth + 1)) {
        out.push(contour.map((pt) => ({
          x: a * pt.x + c * pt.y + dx,
          y: b * pt.x + d * pt.y + dy,
          on: pt.on,
        })));
      }

      if (!(flags & 0x0020)) break;   // MORE_COMPONENTS
    }
    return out;
  }
}

/** Load a font from disk. */
export function loadFont(file) {
  return new TrueTypeFont(fs.readFileSync(file));
}

/** The bundled formula font. It is ~900 KB, so it is read on the first formula that needs it, never at startup. */
export const BUNDLED_FONT = new URL('./fonts/STIX2Math.ttf', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function loadBundledFont() {
  return loadFont(BUNDLED_FONT);
}
