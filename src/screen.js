/**
 * A screen buffer of individual cells, and the diff that turns two of them into terminal bytes.
 *
 * WHY CELLS AND NOT LINES
 * -----------------------
 * A frame used to be an array of strings, and the painter compared those strings. That worked while every row
 * was text and every change was coarse, but it cannot express two things a terminal actually has: a bitmap,
 * which occupies a RECTANGLE and no row of characters, and a style change, which alters what is drawn without
 * altering which characters are drawn.
 *
 * Comparing whole rows also means a one-character change rewrites the entire row, and any consumer that
 * wants to know "did anything under this rectangle change" has to re-derive it from string offsets.
 *
 * So a frame is a grid. Each cell is two integers — a pooled character id and a pooled style id — which makes
 * a comparison an integer compare and makes a rectangle an index range. That is the same shape dsh-tui uses,
 * and it is what lets an image be handled as a region rather than as a special row.
 */

/** Cell width markers, matching the terminal's own notion. */
export const CELL_WIDTH = { narrow: 1, wide: 2, spacer: 0 };

/**
 * Character pool: interned strings so a cell comparison is an integer comparison.
 *
 * Index 0 is a space and index 1 is the empty "spacer" that follows a wide character, so both have stable ids
 * that no ordinary character can take.
 */
export class CharPool {
  constructor() {
    this.strings = [' ', ''];
    this.ids = new Map([[' ', 0], ['', 1]]);
    this.ascii = new Int32Array(128).fill(-1);
    this.ascii[32] = 0;
  }

  intern(ch) {
    if (ch.length === 1) {
      const code = ch.charCodeAt(0);
      if (code < 128) {
        const hit = this.ascii[code];
        if (hit !== -1) return hit;
        const id = this.strings.length;
        this.strings.push(ch);
        this.ascii[code] = id;
        return id;
      }
    }
    const hit = this.ids.get(ch);
    if (hit !== undefined) return hit;
    const id = this.strings.length;
    this.strings.push(ch);
    this.ids.set(ch, id);
    return id;
  }

  get(id) {
    return this.strings[id] ?? ' ';
  }
}

/**
 * Style pool: an SGR prefix per distinct style, so a cell stores an id rather than a string.
 *
 * The value is the SGR sequence that ENTERS the style; the diff writes `ESC[0m` plus the next cell's prefix
 * when the style changes, which is simpler than a minimal-diff of two SGR strings and cannot be wrong.
 */
export class StylePool {
  constructor() {
    this.strings = [''];
    this.ids = new Map([['', 0]]);
  }

  intern(sgr) {
    const s = sgr || '';
    const hit = this.ids.get(s);
    if (hit !== undefined) return hit;
    const id = this.strings.length;
    this.strings.push(s);
    this.ids.set(s, id);
    return id;
  }

  get(id) {
    return this.strings[id] ?? '';
  }
}

/** A rectangle in cell coordinates. */
export const rect = (x, y, width, height) => ({ x, y, width, height });

/** The union of two rectangles, or whichever is non-null. */
export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** True when the two rectangles share any cell. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * A frame's painted surface.
 *
 * `cells` holds two Int32 per cell: `[charId, styleId]`. A wide character's second column holds the SPACER
 * id so that a later write cannot split it, and the diff skips those columns when emitting.
 */
export class Screen {
  constructor(width, height, charPool, stylePool) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    this.charPool = charPool;
    this.stylePool = stylePool;
    this.cells = new Int32Array(this.width * this.height * 2);
    /** Bounding box of everything written since the last reset, or null when nothing was. */
    this.damage = null;
  }

  /** Fill the buffer with spaces in the given style and clear the damage. */
  reset(styleId = 0) {
    this.cells.fill(0);
    for (let i = 1; i < this.cells.length; i += 2) this.cells[i] = styleId;
    this.damage = null;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * Write one character.
   * @param {number} x
   * @param {number} y
   * @param {string} ch
   * @param {number} styleId
   * @param {number} [width] 1 for narrow, 2 for wide.
   */
  set(x, y, ch, styleId, width = 1) {
    if (!this.inBounds(x, y)) return;
    const at = (y * this.width + x) * 2;
    this.cells[at] = this.charPool.intern(ch);
    this.cells[at + 1] = styleId;

    if (width === 2) {
      // The second column is a spacer, never a character of its own.
      if (this.inBounds(x + 1, y)) {
        const next = (y * this.width + x + 1) * 2;
        this.cells[next] = 1;
        this.cells[next + 1] = styleId;
      }
    }
    this._mark(x, y, width);
  }

  /** Write a run of characters starting at x, returning the column after the last one. */
  write(x, y, text, styleId) {
    let col = x;
    for (const ch of text) {
      const w = charWidth(ch);
      if (col + w > this.width) break;
      this.set(col, y, ch, styleId, w);
      col += w;
    }
    return col;
  }

  /** Blank a rectangle in the given style. */
  clear(x, y, width, height, styleId = 0) {
    for (let row = y; row < Math.min(y + height, this.height); row++) {
      for (let col = x; col < Math.min(x + width, this.width); col++) {
        if (col < 0 || row < 0) continue;
        const at = (row * this.width + col) * 2;
        this.cells[at] = 0;
        this.cells[at + 1] = styleId;
      }
    }
    this._mark(x, y, Math.max(0, width), Math.max(0, height));
  }

  /** Rows this screen claims to have painted, so a later diff can tell a moved layout from an edited one. */
  get rowCount() {
    return this._rowCount === undefined ? -1 : this._rowCount;
  }

  _mark(x, y, width, height = 1) {
    const r = rect(Math.max(0, x), Math.max(0, y), Math.max(1, width), Math.max(1, height));
    this.damage = unionRect(this.damage, r);
  }

  /** The character at a cell, and its style. */
  at(x, y) {
    const at = (y * this.width + x) * 2;
    return { ch: this.charPool.get(this.cells[at]), styleId: this.cells[at + 1] };
  }

  /** True when this cell is the second half of a wide character. */
  isSpacer(x, y) {
    return this.cells[(y * this.width + x) * 2] === 1;
  }

  /**
   * Every cell that differs from `other`, row by row.
   *
   * @param {Screen|null} other The previous frame, or null for a full paint.
   * @param {(x:number, y:number, rowEnd:number)=>void} onRow Called once per row that has any change, with the
   *   first differing column and the column after the last one.
   * @returns {boolean} Whether anything differed.
   */
  diffRows(other, onRow) {
    if (!other || other.width !== this.width || other.height !== this.height) {
      for (let y = 0; y < this.height; y++) onRow(0, y, this.width);
      return this.height > 0;
    }

    // `damage` may only narrow the scan when it already covers the whole grid: a row that lost its text is
    // not written by anyone, so it never enters damage, and bounding by damage would skip exactly the rows
    // that changed.
    const covered = this.damage && this.damage.y <= 0 && this.damage.y + this.damage.height >= this.height;
    const from = covered ? 0 : 0;
    const to = this.height;

    let any = false;
    const a = other.cells;
    const b = this.cells;
    for (let y = from; y < to; y++) {
      const base = y * this.width * 2;
      let first = -1;
      let last = -1;
      for (let i = 0; i < this.width; i++) {
        const at = base + i * 2;
        if (a[at] !== b[at] || a[at + 1] !== b[at + 1]) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first >= 0) {
        any = true;
        onRow(first, y, last + 1);
      }
    }
    return any;
  }
}

/** Terminal columns a code point occupies. Narrow unless it is East Asian wide or an emoji. */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 1;
  // Combining marks attach to the previous cell and take no column of their own.
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f)      // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0xa4cf)   // CJK radicals … Yi
    || (cp >= 0xac00 && cp <= 0xd7a3)   // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff)   // CJK compatibility ideographs
    || (cp >= 0xfe30 && cp <= 0xfe6f)   // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60)   // Fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) // emoji
    || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** A shareable pool pair, so screens in one session can be compared cheaply. */
export const pools = () => ({ charPool: new CharPool(), stylePool: new StylePool() });

/** Create a screen over the given pools. */
export function createScreen(width, height, charPool, stylePool) {
  return new Screen(width, height, charPool, stylePool);
}
