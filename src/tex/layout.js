/**
 * The layout pass: node tree → measured boxes.
 *
 * Every box carries `width`, `height` (above the baseline) and `depth` (below it) in font units, plus the
 * glyph placements that paint it. A row stacks its children left to right on a shared baseline; a fraction
 * centres a bar between two shifted rows; a script raises or lowers a scaled-down row.
 *
 * The numbers follow TeX's own proportions closely enough that a formula reads correctly: a superscript is
 * 0.7 of the base, a sub-subscript 0.55, a fraction's numerator is raised by its own depth plus a gap.
 */
import {
  FRAC_GAP, LIMIT_GAP, BIN_SPACE, PUNCT_SPACE,
  SCRIPT_RATIO, SCRIPT_SCRIPT_RATIO, BINARY, RELATION,
} from './parse.js';

/** The advance and outline of one glyph, resolved through the font. */
function glyphFor(font, ch, size) {
  const cp = ch.codePointAt(0);
  const gid = font.glyphIndex(cp);
  if (!gid) return null;
  const units = font.advance(gid);
  // The glyph's real ink extents differ from the em box: a radical's tail rises above the advance height,
  // and a bar placed at the em height would sit below that tail instead of continuing it.
  const ink = inkExtent(font, gid, size);
  return {
    kind: 'glyph',
    ch,
    gid,
    size,
    width: Math.round(units * size / font.unitsPerEm),
    height: Math.round(font.ascender * size / font.unitsPerEm),
    depth: Math.round(-font.descender * size / font.unitsPerEm),
    inkTop: ink.top,
    inkBottom: ink.bottom,
  };
}

/** Measure a glyph's real ink extent, so a row's height is the ink it draws and not the em box. */
function inkExtent(font, gid, size) {
  const outline = font.outline(gid);
  if (!outline.length) return { top: 0, bottom: 0 };
  let top = -Infinity;
  let bottom = Infinity;
  for (const contour of outline) {
    for (const p of contour) {
      if (p.y > top) top = p.y;
      if (p.y < bottom) bottom = p.y;
    }
  }
  if (top === -Infinity) return { top: 0, bottom: 0 };
  const k = size / font.unitsPerEm;
  return { top: Math.round(top * k), bottom: Math.round(bottom * k) };
}

function emptyBox() {
  return { width: 0, height: 0, depth: 0, items: [] };
}

function hbox(items, width, height, depth) {
  return { width, height, depth, items };
}

/** Lay out a list of nodes as a horizontal row on one baseline. */
function layoutRow(nodes, font, size, opts, ctx) {
  const items = [];
  let pen = 0;
  let height = 0;
  let depth = 0;

  // Spacing depends on the pair of classes around each atom, which TeX decides by looking on both sides.
  const clsOf = (node) => {
    if (node.cls) return node.cls;
    if (node.kind === 'atom') {
      if (BINARY.has(node.value)) return 'bin';
      if (RELATION.has(node.value)) return 'rel';
      if (node.value === ',') return 'punct';
    }
    if (node.kind === 'bigop') return 'op';
    return 'ord';
  };

  let prevCls = 'ord';
  let prevNode = null;

  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    const cls = clsOf(node);

    // Space before, from the pair (previous, this). Relations and binaries are the two that open up.
    if (prevNode !== null) {
      if (cls === 'rel' || prevCls === 'rel') pen += Math.round(BIN_SPACE * 1.1 * size);
      else if (cls === 'bin' || prevCls === 'bin') pen += Math.round(BIN_SPACE * size);
      else if (cls === 'punct' && prevNode.kind === 'atom' && prevNode.value === ',') pen += Math.round(PUNCT_SPACE * size);
      else if (cls === 'op') pen += Math.round(BIN_SPACE * 0.6 * size);
    }

    const box = layoutNode(node, font, size, opts, ctx);
    if (!box) continue;

    box.x = pen;
    items.push(box);
    pen += box.width;
    if (box.height > height) height = box.height;
    if (box.depth > depth) depth = box.depth;

    prevCls = cls;
    prevNode = node;
  }

  return hbox(items, pen, height, depth);
}

/** Lay out one node, with its scripts if it has any. */
function layoutNode(node, font, size, opts, ctx) {
  if (!node) return null;

  if (node.kind === 'space') {
    return hbox([], Math.round(node.width * size), 0, 0);
  }

  if (node.kind === 'align') {
    return hbox([], Math.round(1.5 * size), 0, 0);
  }

  if (node.kind === 'atom') {
    const base = node.value ? glyphFor(font, node.value, size) : emptyBox();
    if (!base) return null;
    if (!node.value) { base.height = 0; base.depth = 0; }
    else {
      const ink = inkExtent(font, base.gid, size);
      base.height = Math.max(base.height, ink.top);
      base.depth = Math.max(base.depth, -ink.bottom);
    }
    return attachScripts(base, node.scripts, font, size, opts, ctx);
  }

  if (node.kind === 'delim') {
    // Delimiters are drawn at the base size; growing them to the content needs MATH table data, which is
    // out of scope — a slightly small bracket reads better than a mis-sized one.
    const g = glyphFor(font, node.value, size);
    if (!g) return null;
    const ink = inkExtent(font, g.gid, size);
    g.height = Math.max(g.height, ink.top);
    g.depth = Math.max(g.depth, -ink.bottom);
    return g;
  }

  if (node.kind === 'row') {
    const inner = layoutRow(node.body, font, size, opts, ctx);
    return attachScripts(inner, node.scripts, font, size, opts, ctx);
  }

  if (node.kind === 'frac') {
    const numSize = Math.round(size * 0.85);
    const denSize = Math.round(size * 0.85);
    const num = layoutRow(node.num, font, numSize, opts, ctx);
    const den = layoutRow(node.den, font, denSize, opts, ctx);
    const gap = Math.round(FRAC_GAP * size);
    const pad = Math.round(size * 0.12);
    const width = Math.max(num.width, den.width) + pad * 2;

    // The bar is the origin. The numerator's BASELINE goes above it by its depth plus the gap; the
    // denominator's by its ascender plus the gap on the other side.
    const numShift = num.depth + gap;      // positive y raises
    const denShift = -(den.height + gap);  // negative y lowers

    const items = [
      { ...num, x: Math.round((width - num.width) / 2), y: numShift },
      { kind: 'rule', x: pad, y: 0, width: width - pad * 2, height: 1, depth: 0 },
      { ...den, x: Math.round((width - den.width) / 2), y: denShift },
    ];

    const box = hbox(
      items,
      width,
      Math.max(num.height + numShift, Math.round(size * 0.6)),
      Math.max(den.depth - denShift, Math.round(size * 0.5)),
    );
    return attachScripts(box, node.scripts, font, size, opts, ctx);
  }

  if (node.kind === 'root') {
    const body = layoutRow(node.body, font, size, opts, ctx);
    const rad = glyphFor(font, '√', size) || emptyBox();

    // THE BAR COVERS THE RADICAND'S BASE, NOT ITS SCRIPTS.
    //
    // `body.width` includes any superscript the radicand carries — `\sqrt{x^2}` measures `x` plus the `2`
    // raised beside it — so a bar drawn across the full width runs straight over the exponent. That is the
    // overlap: the tail of the radical meeting the `2`, not two bars meeting each other.
    //
    // TeX ends the bar where the base glyph ends. The base width is recovered here as the right edge of the
    // widest item sitting on the baseline; a raised script is excluded because it has a non-zero y.
    // TeX ends the bar where the base glyph ends. The base width is recovered by walking the radicand's
    // items and taking the right edge of everything sitting ON the baseline; a raised script is excluded
    // because it carries a non-zero y. Nested boxes are recursed into, since `layoutRow` wraps a run of
    // glyphs in a box of its own.
    const baseRight = (node, offset) => {
      let right = 0;
      for (const item of node.items || []) {
        const x = offset + (item.x || 0);
        if (item.y) continue;                        // raised or lowered: a script, not the base
        if (item.kind === 'glyph' || item.kind === 'rule') {
          right = Math.max(right, x + (item.width || 0));
        } else if (item.items) {
          right = Math.max(right, baseRight(item, x));
        }
      }
      return right;
    };
    let baseW = baseRight(body, 0);
    if (baseW === 0) baseW = body.width;

    // THE BAR MUST MEET THE RADICAL'S TAIL AT ITS HEIGHT.
    //
    // Measured on STIX Two Math, the radical's ink top is at y=922 while the em is 1000, and its tail ends
    // at x=829 — past the 794 advance. A bar placed at the radicand's height sits BELOW that tail, which is
    // the gap this fixes.
    //
    // The height is looked up from the FONT rather than taken from the glyph item: `layoutRow` may re-wrap
    // the item in a box that carries only its metrics, and a missing `inkTop` silently became zero.
    const radGid = font.glyphIndex(0x221a);
    const radInk = radGid ? inkExtent(font, radGid, size) : null;
    const radTop = radInk && radInk.top > 0 ? radInk.top : Math.round(size * 0.92);
    const radW = rad.width ? Math.max(rad.width, Math.round(size * 0.5)) : Math.round(size * 0.5);
    const overlap = Math.round(size * 0.1);
    const barPad = Math.round(size * 0.06);
    const barW = baseW + barPad;
    const width = radW + Math.max(barW, body.width);

    // THE RADICAND SITS BELOW THE BAR, INCLUDING ITS SCRIPTS.
    //
    // The bar is drawn at the radical's tail height (922 on STIX). The radicand's own height already exceeds
    // that once it carries a superscript — `x^2` measures 1099 — so placing it at y=0 put the exponent above
    // the bar and the bar cut through the formula instead of capping it.
    //
    // The whole radicand is therefore lowered so its top clears the bar by a small gap.
    const barY = radTop;
    const bodyGap = Math.round(size * 0.06);
    const bodyTop = body.height;
    const bodyDrop = Math.max(0, bodyTop + bodyGap - barY);

    const items = [
      { ...body, x: radW, y: -bodyDrop },
      {
        kind: 'rule',
        x: radW - overlap,
        y: barY,
        width: barW + overlap,
        height: 1,
        depth: 0,
      },
      { ...rad, x: 0, y: 0 },
    ];

    const box = hbox(items, width, barY + 1, body.depth + bodyDrop);
    return attachScripts(box, node.scripts, font, size, opts, ctx);
  }

  if (node.kind === 'bigop') {
    // Big operators are drawn larger than body text and centre their limits above and below.
    const opSize = Math.round(size * 1.35);
    const op = glyphFor(font, node.value, opSize);
    if (!op) return null;
    const ink = inkExtent(font, op.gid, opSize);
    op.height = Math.max(op.height, ink.top);
    op.depth = Math.max(op.depth, -ink.bottom);

    const s = node.scripts;
    if (!s) return op;

    const limitSize = Math.round(size * 0.65);
    const upper = s.sup ? layoutRow(s.sup, font, limitSize, opts, ctx) : null;
    const lower = s.sub ? layoutRow(s.sub, font, limitSize, opts, ctx) : null;
    const width = Math.max(op.width, upper ? upper.width : 0, lower ? lower.width : 0);
    const gap = Math.round(LIMIT_GAP * size);

    const items = [{ ...op, x: Math.round((width - op.width) / 2), y: 0 }];
    let height = op.height;
    let depth = op.depth;

    if (upper) {
      const y = op.height + gap + upper.depth;   // positive: above the operator
      items.push({ ...upper, x: Math.round((width - upper.width) / 2), y });
      height = y + upper.height;
    }
    if (lower) {
      const y = -(op.depth + gap + lower.height);   // negative: below the operator
      items.push({ ...lower, x: Math.round((width - lower.width) / 2), y });
      depth = -y + lower.depth;
    }

    return hbox(items, width, height, depth);
  }

  if (node.kind === 'accent') {
    const body = layoutRow(node.body, font, size, opts, ctx);
    const mark = glyphFor(font, node.accent, size);
    const width = body.width;
    const items = [{ ...body, x: 0, y: 0 }];
    let height = body.height;
    if (mark) {
      const y = body.height + Math.round(size * 0.12);   // above the base
      items.push({ ...mark, x: Math.round((width - mark.width) / 2), y });
      height = y + mark.height;
    }
    return hbox(items, width, height, body.depth);
  }

  if (node.kind === 'env') {
    return layoutEnvironment(node, font, size, opts, ctx);
  }

  return null;
}

/** Raise a box by a superscript, lower it by a subscript, or both. */
function attachScripts(base, scripts, font, size, opts, ctx) {
  if (!scripts) return base;

  const supSize = Math.round(size * SCRIPT_RATIO);
  const sup = scripts.sup ? layoutRow(scripts.sup, font, supSize, opts, ctx) : null;
  const sub = scripts.sub ? layoutRow(scripts.sub, font, subSizeFor(size), opts, ctx) : null;

  const items = [{ ...base, x: 0, y: 0 }];
  let width = base.width;
  let height = base.height;
  let depth = base.depth;

  // TeX's placement: a superscript clears the base's height by about three quarters of its own, and a
  // subscript drops by about a fifth of the base size. Both then grow the box.
  if (sup) {
    const y = base.height - Math.round(supSize * 0.28);   // already positive: raises
    items.push({ ...sup, x: base.width + Math.round(size * 0.02), y });
    width = Math.max(width, base.width + Math.round(size * 0.02) + sup.width);
    height = Math.max(height, y + sup.height);
  }
  if (sub) {
    const y = -(Math.round(size * 0.18) + sub.height);   // negative: lowers
    items.push({ ...sub, x: base.width + Math.round(size * 0.02), y });
    width = Math.max(width, base.width + Math.round(size * 0.02) + sub.width);
    depth = Math.max(depth, -y + sub.depth);
  }

  return hbox(items, width, height, depth);
}

function subSizeFor(size) {
  return Math.round(size * SCRIPT_RATIO);
}

/**
 * Lay out a matrix-like environment: cells on a grid, equal column widths, rows on fixed pitch.
 */
function layoutEnvironment(node, font, size, opts, ctx) {
  const cellSize = Math.round(size * 0.9);
  const grid = node.rows.map((row) => row.map((cell) => layoutRow(cell, font, cellSize, opts, ctx)));

  const cols = Math.max(...grid.map((r) => r.length), 1);
  const colW = new Array(cols).fill(0);
  for (const row of grid) {
    row.forEach((cell, c) => { colW[c] = Math.max(colW[c], cell.width); });
  }

  const colGap = Math.round(size * 0.7);
  const rowGap = Math.round(size * 0.35);
  const pad = Math.round(size * 0.25);

  const innerW = colW.reduce((a, b) => a + b, 0) + colGap * (cols - 1);

  // Row pitch is a row's own height plus the gap BETWEEN rows. Using `height + depth` for both the box and
  // the step counted the descent twice, so each row landed further down than the box was tall and the last
  // one fell outside the bitmap — the matrix was clipped at its bottom edge.
  const rowTops = grid.map((row) => Math.max(...row.map((c) => c.height), Math.round(size * 0.6)));
  const rowBottoms = grid.map((row) => Math.max(...row.map((c) => c.depth), Math.round(size * 0.2)));
  const innerH = rowTops.reduce((a, b) => a + b, 0)
    + rowBottoms.reduce((a, b) => a + b, 0)
    + rowGap * (grid.length - 1);

  const items = [];
  // The first row's baseline sits just below the top of the content block.
  let y = Math.round(innerH / 2) - rowTops[0];
  for (let r = 0; r < grid.length; r++) {
    let x = 0;
    for (let c = 0; c < grid[r].length; c++) {
      const cell = grid[r][c];
      items.push({ ...cell, x: x + Math.round((colW[c] - cell.width) / 2), y });
      x += colW[c] + colGap;
    }
    // The next row's baseline is one row height plus one gap lower.
    y -= rowTops[r] + rowBottoms[r] + rowGap;
  }

  const width = innerW + pad * 2;

  // THE BOX IS THE UNION OF WHAT THE CELLS OCCUPY, PLUS A MARGIN.
  //
  // Sizing it as `innerH/2 + pad` on both sides assumed the content is symmetric about the baseline, which
  // it is not: two rows of digits leave more ink above than below, so the depth came out too small and the
  // bottom bracket arm was clipped. Measuring the placed items is exact for any number of rows.
  let top = 0;
  let bottom = 0;
  for (const it of items) {
    if (it.y + (it.height || 0) > top) top = it.y + (it.height || 0);
    if (-it.y + (it.depth || 0) > bottom) bottom = -it.y + (it.depth || 0);
  }
  const height = top + pad;
  const depth = bottom + pad;

  // THE BRACKETS ARE DELIBERATELY TALLER THAN THE CELLS.
  //
  // Their arms are drawn as horizontal strokes two pixels thick, and a stroke whose top edge coincides with
  // the content's bounding row puts half of itself — plus its antialiased edge — outside the bitmap. A small
  // overshoot keeps the arms fully inside, which is what TeX does too: a matrix bracket always overhangs its
  // contents slightly.
  const bracketPad = Math.round(size * 0.12);
  const bracketH = height + bracketPad;
  const bracketD = depth + bracketPad;

  const bracketW = Math.round(size * 0.3);
  const totalW = width + bracketW * 2;
  const left = node.env === 'cases'
    ? { kind: 'brace', x: 0, y: 0, width: bracketW, height: bracketH, depth: bracketD }
    : { kind: 'bracket', side: 'left', x: 0, y: 0, width: bracketW, height: bracketH, depth: bracketD };
  const right = node.env === 'cases'
    ? null
    : { kind: 'bracket', side: 'right', x: totalW - bracketW, y: 0, width: bracketW, height: bracketH, depth: bracketD };

  const shifted = items.map((it) => ({ ...it, x: it.x + bracketW }));
  const out = [left, ...shifted];
  if (right) out.push(right);

  return hbox(out, totalW, bracketH, bracketD);
}

/**
 * Lay out a parsed formula.
 *
 * @param {object[]} nodes Output of `parseTex`.
 * @param {object} font A `TrueTypeFont`.
 * @param {number} size Em size in font units (1000 for Noto Sans Math).
 * @returns {{width:number,height:number,depth:number,items:object[]}}
 */
export function layout(nodes, font, size = 1000) {
  return layoutRow(nodes, font, size, {}, {});
}
