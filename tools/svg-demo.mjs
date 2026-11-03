/**
 * Write one SVG per sample formula, plus an index page to look at them all.
 *
 * This is a demo, not a test: the point is to look at the output in a browser and see that the glyphs are
 * STIX Two Math outlines rather than text, that a fraction really is stacked, and that the baseline is where
 * the layout said it would be. Run it as
 *
 *   node tools/svg-demo.mjs
 *
 * and open `demo/latex/index.html`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { texToSvg } from '../src/tex/svg.js';

const OUT = path.join('demo', 'latex');

/** Formulas chosen for what they stress: glyph coverage, stacking, limits, nesting, stretching. */
const SAMPLES = [
  ['pythagoras', 'E = mc^2', 'a single superscript'],
  ['quadratic', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', 'a fraction with a nested radical'],
  ['sum', '\\sum_{i=0}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}', 'limits above and below a big operator'],
  ['integral', '\\int_0^\\infty e^{-x}\\,dx = 1', 'an integral with both limits'],
  ['limit', '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', 'a limit under a named operator'],
  ['cases', 'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}', 'a brace stretched over two rows'],
  ['matrix', 'A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'brackets stretched over a grid'],
  ['greek', '\\alpha + \\beta = \\gamma, \\quad \\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}', 'Greek letters and an accent'],
  ['blackboard', '\\forall x \\in \\mathbb{R}: x^2 \\ge 0', 'blackboard bold'],
  ['aligned', '\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}', 'aligned rows'],
];

fs.mkdirSync(OUT, { recursive: true });

const cells = [];
for (const [name, tex, note] of SAMPLES) {
  const svg = texToSvg(tex, { px: 40 });
  if (!svg) {
    console.log(`  SKIP  ${name}: the subset cannot lay this out`);
    continue;
  }
  fs.writeFileSync(path.join(OUT, `${name}.svg`), svg.svg, 'utf8');
  const paths = (svg.svg.match(/<path /g) || []).length;
  const rects = (svg.svg.match(/<rect /g) || []).length;
  console.log(`  ${name.padEnd(12)} ${String(svg.width).padStart(4)}x${String(svg.height).padStart(3)}`
    + `  ${String(paths).padStart(3)} paths  ${rects} rects  ${note}`);
  cells.push({ name, note, tex, svg: svg.svg, width: svg.width, height: svg.height });
}

// The index: each formula in its own row, on a light and a dark background, because the ink is
// `currentColor` and a formula that only reads on one of them is a formula with a colour problem.
const rows = cells.map((c) => `
  <section>
    <h2>${c.name}</h2>
    <p class="note">${c.note}</p>
    <pre class="tex">${c.tex.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
    <div class="pair">
      <div class="light">${c.svg}</div>
      <div class="dark">${c.svg}</div>
    </div>
  </section>`).join('\n');

const html = `<!doctype html>
<meta charset="utf-8">
<title>hncode — LaTeX as SVG</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 32px; max-width: 1100px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { color: #666; margin: 0 0 28px; }
  section { border-top: 1px solid #8884; padding: 18px 0; }
  h2 { font-size: 15px; margin: 0; font-family: ui-monospace, monospace; }
  .note { color: #666; margin: 2px 0 8px; }
  .tex { background: #8881; padding: 6px 8px; border-radius: 4px; overflow-x: auto; margin: 0 0 10px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .light { background: #fff; color: #111; }
  .dark { background: #111; color: #eee; }
  .light, .dark { padding: 14px; border-radius: 6px; display: flex; align-items: center; }
  svg { max-width: 100%; height: auto; }
</style>
<h1>LaTeX as SVG</h1>
<p class="lead">Every glyph is a &lt;path&gt; from the STIX Two Math outline. No &lt;text&gt;, no font
reference, no image. Ink is <code>currentColor</code>, so the same file reads on a light or a dark page.</p>
${rows}
`;
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
console.log(`\nwrote ${cells.length} samples + index.html to ${OUT}`);
