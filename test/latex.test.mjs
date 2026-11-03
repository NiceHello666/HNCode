// LaTeX rendering: the text layout and the two places the transcript calls it.
//
// The invariants here are the ones a reader notices: a formula must not be silently swallowed (it either
// renders or shows its source), prose that merely uses `$` must stay prose, and a display block must be
// laid out across rows rather than flattened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLatex } from '../src/latex.js';
import { measureTex, renderTexImage } from '../src/tex/index.js';
import { renderMdText } from '../src/tui.js';
import { C } from '../src/colors.js';

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const render = (src, width = 70) => renderMdText(src, width, C.white, C.gray).map(strip);

/** Pixels of ink in a raster. A blank picture that claims cells is the failure this counts. */
const inkPixels = (image) => {
  let n = 0;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] > 0) n++;
  return n;
};

test('common constructs render as text', () => {
  assert.equal(renderLatex('E = mc^2'), 'E = mc²');
  assert.equal(renderLatex('\\alpha + \\beta = \\gamma'), 'α + β = γ');
  assert.equal(renderLatex('\\mathbb{R}'), 'ℝ');
  assert.equal(renderLatex('\\sqrt[3]{x}'), '∛x');
});

test('display mode stacks a fraction over a rule', () => {
  const lines = renderLatex('\\frac{a}{b}', { display: true }).split('\n');
  assert.equal(lines.length, 3, 'numerator, rule, denominator');
  assert.equal(lines[0].trim(), 'a');
  assert.match(lines[1], /─/);
  assert.equal(lines[2].trim(), 'b');
});

test('display mode puts an operator limit above the operator', () => {
  const lines = renderLatex('\\sum_{i=0}^{n} i^2', { display: true }).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].trim(), 'n');
  assert.match(lines[1], /∑/);
  assert.equal(lines[2].trim(), 'i=0');
});

test('unsupported or malformed source is undefined, never half-rendered', () => {
  assert.equal(renderLatex('\\notacommand{x}'), undefined);
  assert.equal(renderLatex('{unbalanced'), undefined);
});

test('a $$ block is laid out, one line of prose per row above it', () => {
  const rows = render('before\n\n$$\n\\frac{a}{b}\n$$\n\nafter').map((r) => r.trim());
  assert.deepEqual(rows, ['before', '', 'a', '─', 'b', '', 'after']);
});

test('a \\[ block renders too', () => {
  const rows = render('\\[\nx = 1\n\\]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trim(), 'x = 1');
});

test('an unclosed $$ block keeps its source while streaming', () => {
  const rows = render('$$\n\\frac{a}{b}');
  assert.ok(rows.some((r) => r.includes('\\frac{a}{b}')), `source is shown: ${JSON.stringify(rows)}`);
});

test('inline $...$ renders, and prose that uses $ does not', () => {
  assert.deepEqual(render('Energy is $E = mc^2$ for a body at rest.'), ['Energy is E = mc² for a body at rest.']);
  assert.deepEqual(render('The price is $5 and $10 for two.'), ['The price is $5 and $10 for two.']);
  assert.deepEqual(render('A shell var $HOME and ${PATH} should stay.'), ['A shell var $HOME and ${PATH} should stay.']);
  assert.deepEqual(render('Let \\(\\alpha + \\beta\\) be the sum.'), ['Let α + β be the sum.']);
});

test('a display formula keeps its own rows and fits the width it was given', () => {
  const rows = render('$$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$', 40);
  assert.ok(rows.length >= 3, `stacked layout survives: ${JSON.stringify(rows)}`);
  for (const r of rows) assert.ok(r.length <= 40, `row fits: ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------------------
// the typeset bitmap
// ---------------------------------------------------------------------------
// The same TeX comes out two ways: STIX Two Math through the bitmap pipeline, or the Unicode layout. Both
// have to exist, because a terminal without graphics gets the second one, and both must refuse TeX the
// subset cannot express rather than draw part of it.

test('the bitmap pipeline typesets a formula and measures it in cells', () => {
  const cell = { w: 10, h: 20 };
  const measured = measureTex('\\frac{a}{b}', { cell });
  assert.ok(measured, 'a fraction is inside the subset');
  assert.ok(measured.columns >= 1 && measured.rows >= 2,
    `a fraction is taller than one row: ${JSON.stringify(measured)}`);

  const image = renderTexImage('\\frac{a}{b}', { cell, colour: { r: 220, g: 220, b: 220 } });
  assert.ok(image, 'it renders');
  assert.equal(image.columns, measured.columns, 'the raster claims the cells it was measured at');
  assert.ok(inkPixels(image) > 20, `the raster has ink, not just a margin: ${inkPixels(image)} pixels`);
});

test('the bitmap is set at the size of the text around it', () => {
  // Matching the x-HEIGHT, not the em: a cell is about twice as tall as it is wide, so an em-sized formula
  // comes out at roughly half the surrounding text. The x-height of the rendered picture must therefore be
  // the fraction of the cell the policy asked for, to within a pixel.
  const cell = { w: 10, h: 20 };
  const m = measureTex('E = mc^2', { cell });
  assert.ok(m.rows >= 2 && m.rows <= 3, `body-height formula occupies 2-3 rows: ${JSON.stringify(m)}`);

  const inkRows = (image, minAlpha = 40) => {
    let top = Infinity;
    let bottom = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.rgba[(y * image.width + x) * 4 + 3] > minAlpha) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    return bottom < 0 ? 0 : bottom - top + 1;
  };
  // `x` is exactly the x-height, so its ink height IS the ex the formula is set in.
  const x = renderTexImage('x', { cell, colour: { r: 255, g: 255, b: 255 } });
  const ex = inkRows(x);
  assert.ok(Math.abs(ex - cell.h * 0.55) <= 1.5,
    `x-height is 0.55 of the cell (${ex}px in a ${cell.h}px cell)`);
  // And a capital is taller than the x-height, which is what tells a reader the formula is typeset at all.
  const cap = renderTexImage('E', { cell, colour: { r: 255, g: 255, b: 255 } });
  assert.ok(inkRows(cap) > ex * 1.2, `a capital rises above the x-height: ${inkRows(cap)} vs ${ex}`);
});

test('the bitmap declines what it cannot draw', () => {
  const cell = { w: 10, h: 20 };
  assert.equal(measureTex('\\notacommand{x}', { cell }), null, 'unknown TeX has no layout');
  assert.equal(renderTexImage('\\notacommand{x}', { cell }), null, 'and no raster');
  // A formula that cannot fit the room is refused rather than clipped: one column is not enough for it.
  assert.equal(renderTexImage('\\frac{a}{b}', { cell, maxWidth: 1 }), null, 'too wide for the room given');
  // And a plausible one shrinks to fit rather than overflowing.
  const shrunk = renderTexImage('\\frac{a}{b}', { cell, maxWidth: 3 });
  if (shrunk) assert.ok(shrunk.columns <= 3, `shrunk into the room: ${JSON.stringify({ columns: shrunk.columns })}`);
});

test('a terminal that cannot show a bitmap gets the text layout', () => {
  // No probe has run in a test process, so no image protocol is known and the frame must stay text.
  const rows = render('$$\\frac{a}{b}$$');
  assert.ok(rows.length >= 3, JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.includes('\u0001')), 'no image sentinel in the text form');
});
