/**
 * TeX → a laid-out box tree, measured in font units.
 *
 * The output of this module is geometric, not pixels: each node knows where it goes relative to its parent
 * and how big it is, so the rasteriser only has to walk the tree once. Sizes follow TeX's rules — a
 * superscript is 0.7 of its base, a sub-subscript 0.5 — because matching them is what makes a formula look
 * typeset rather than assembled.
 *
 * Scope: the constructs that appear in discussion rather than in a paper. Fractions, roots, sub- and
 * superscripts, big operators with limits, matrices and `cases`, accents, and text runs. Anything else
 * degrades to its own source rather than to a half-drawn box.
 */

import { SYMBOLS } from '../latex.js';

const SCRIPT_RATIO = 0.7;
const SCRIPT_SCRIPT_RATIO = 0.55;

/** Vertical space around a fraction bar, in em fractions. */
const FRAC_GAP = 0.12;
/** Gap between a big operator and its limits. */
const LIMIT_GAP = 0.08;
/** Space either side of a binary operator, in em. */
const BIN_SPACE = 0.22;
/** Space after a comma in a list. */
const PUNCT_SPACE = 0.16;

/** Glyph classes that need spacing around them. */
const BINARY = new Set(['+', '−', '-', '±', '∓', '×', '÷', '·', '∗', '∪', '∩', '∧', '∨', '⊕', '⊗']);
const RELATION = new Set(['=', '≠', '≈', '≡', '≤', '≥', '<', '>', '∈', '∉', '⊂', '⊃', '⊆', '⊇', '→', '←', '↔', '⇒', '⇐', '⇔', '∝']);
const RELATION_NAMES = new Set(['leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'sim', 'simeq',
  'propto', 'in', 'notin', 'subset', 'supset', 'subseteq', 'supseteq', 'to', 'rightarrow', 'leftarrow',
  'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'implies', 'iff', 'mapsto']);
const BINARY_NAMES = new Set(['pm', 'mp', 'times', 'div', 'cdot', 'ast', 'cup', 'cap', 'wedge', 'vee',
  'oplus', 'otimes', 'land', 'lor', 'setminus']);

/** Operators that take their limits above and below rather than to the right. */
const BIG_OPERATORS = new Set(['sum', 'prod', 'int', 'oint', 'bigcup', 'bigcap', 'coprod']);
const BIG_GLYPHS = { sum: '∑', prod: '∏', int: '∫', oint: '∮', bigcup: '⋃', bigcap: '⋂', coprod: '∐' };

/** Accent commands and the combining variant a terminal font carries. */
const ACCENTS = {
  hat: '\u0302', widehat: '\u0302',
  bar: '\u0304', overline: '\u0304',
  vec: '\u20d7', overrightarrow: '\u20d7',
  tilde: '\u0303', widetilde: '\u0303',
  dot: '\u0307', ddot: '\u0308',
};

/**
 * A box: width/height/depth in font units, plus the children that paint into it.
 * `x`/`y` on a child are relative to this box's origin at its baseline on the left edge.
 */
function box(width, height, depth) {
  return { width, height, depth, children: [] };
}

const em = (n) => Math.round(n);

/**
 * Tokenise TeX into commands, groups and single characters.
 * Braces become explicit tokens so the parser can follow them.
 */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (!m) { i++; continue; }
      out.push({ type: 'cmd', name: m[1] });
      i += m[0].length;
      // A control word swallows the space that follows it.
      if (/^[A-Za-z]+$/.test(m[1])) while (src[i] === ' ') i++;
      continue;
    }

    if (ch === '{') { out.push({ type: 'open' }); i++; continue; }
    if (ch === '}') { out.push({ type: 'close' }); i++; continue; }
    if (ch === '^') { out.push({ type: 'sup' }); i++; continue; }
    if (ch === '_') { out.push({ type: 'sub' }); i++; continue; }
    if (ch === '&') { out.push({ type: 'align' }); i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }

    // Group surrogate pairs so an emoji or a rare symbol stays one token.
    const cp = src.codePointAt(i);
    const str = String.fromCodePoint(cp);
    out.push({ type: 'char', value: str });
    i += str.length;
  }
  return out;
}

/**
 * Parse a token stream into an unmeasured node list.
 * Nodes are the semantic pieces: atom, fraction, root, scripts, bigop, row, matrix.
 */
function parse(tokens, opts = {}) {
  const rows = [];
  let i = 0;

  const parseGroup = () => {
    // Called with `i` just past an `open`; consumes through its matching `close`.
    const inner = [];
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      if (tokens[i].type === 'open') depth++;
      else if (tokens[i].type === 'close') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      inner.push(tokens[i]);
      i++;
    }
    return parse(inner, opts);
  };

  const parseArg = () => {
    // One argument: a braced group, a single token, or a command.
    if (i >= tokens.length) return [];
    if (tokens[i].type === 'open') { i++; return parseGroup(); }
    const t = tokens[i++];
    return parse([t], opts);
  };

  while (i < tokens.length) {
    const t = tokens[i];

    if (t.type === 'char') {
      i++;
      // Attach scripts to the character just read.
      const node = { kind: 'atom', value: t.value };
      node.scripts = parseScripts();
      rows.push(node);
      continue;
    }

    if (t.type === 'cmd') {
      const name = t.name;
      i++;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const num = parseArg();
        const den = parseArg();
        const node = { kind: 'frac', num, den };
        node.scripts = parseScripts();
        rows.push(node);
        continue;
      }

      if (name === 'sqrt') {
        // An optional index `\sqrt[3]{x}`.
        let index = null;
        if (tokens[i] && tokens[i].type === 'char' && tokens[i].value === '[') {
          i++;
          const idxTokens = [];
          while (i < tokens.length && !(tokens[i].type === 'char' && tokens[i].value === ']')) idxTokens.push(tokens[i++]);
          i++;
          index = parse(idxTokens, opts);
        }
        const body = parseArg();
        const node = { kind: 'root', body, index };
        node.scripts = parseScripts();
        rows.push(node);
        continue;
      }

      if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'mathit' || name === 'operatorname') {
        const body = parseArg();
        rows.push({ kind: 'row', body, upright: true });
        continue;
      }

      if (name === 'begin') {
        const env = readEnvName();
        const matrix = parseEnvironment(env);
        rows.push(matrix);
        continue;
      }

      if (ACCENTS[name]) {
        const body = parseArg();
        const node = { kind: 'accent', accent: ACCENTS[name], body };
        node.scripts = parseScripts();
        rows.push(node);
        continue;
      }

      if (BIG_OPERATORS.has(name)) {
        const node = { kind: 'bigop', value: BIG_GLYPHS[name], name };
        node.scripts = parseScripts();
        rows.push(node);
        continue;
      }

      if (name === 'left' || name === 'right') {
        // Delimiter sizing is ignored; the delimiter itself is the next token.
        if (tokens[i] && tokens[i].type === 'char') {
          const delim = tokens[i].value;
          i++;
          if (name === 'left') rows.push({ kind: 'delim', value: delim, side: 'left' });
          else rows.push({ kind: 'delim', value: delim, side: 'right' });
        }
        continue;
      }

      if (name === 'quad') { rows.push({ kind: 'space', width: 1 }); continue; }
      if (name === 'qquad') { rows.push({ kind: 'space', width: 2 }); continue; }
      if (name === ',' || name === ';' || name === ':' || name === '!') { rows.push({ kind: 'space', width: 0.17 }); continue; }

      const sym = SYMBOLS[name];
      if (sym !== undefined) {
        const node = { kind: 'atom', value: sym };
        node.scripts = parseScripts();
        if (RELATION_NAMES.has(name)) node.cls = 'rel';
        else if (BINARY_NAMES.has(name)) node.cls = 'bin';
        rows.push(node);
        continue;
      }

      // Unknown command: show its own source rather than dropping it silently.
      rows.push({ kind: 'atom', value: '\\' + name, cls: 'raw' });
      continue;
    }

    if (t.type === 'sup' || t.type === 'sub') {
      // A script with nothing before it: keep it attached to an empty atom.
      const node = { kind: 'atom', value: '' };
      node.scripts = parseScripts();
      rows.push(node);
      continue;
    }

    if (t.type === 'align') {
      i++;
      rows.push({ kind: 'align' });
      continue;
    }

    // open/close outside a group: treat as grouping noise.
    i++;
  }

  return rows;

  function parseScripts() {
    const s = { sup: null, sub: null };
    for (;;) {
      if (i < tokens.length && (tokens[i].type === 'sup' || tokens[i].type === 'sub')) {
        const which = tokens[i].type;
        i++;
        const arg = parseArg();
        if (which === 'sup') s.sup = arg; else s.sub = arg;
      } else break;
    }
    return (s.sup || s.sub) ? s : null;
  }

  function readEnvName() {
    // `\begin{name}`: the name arrives as a group of characters.
    if (!(tokens[i] && tokens[i].type === 'open')) return '';
    i++;
    let name = '';
    while (i < tokens.length && tokens[i].type !== 'close') {
      if (tokens[i].type === 'char') name += tokens[i].value;
      else if (tokens[i].type === 'cmd') name += tokens[i].name;
      i++;
    }
    i++;
    return name;
  }

  function parseEnvironment(env) {
    // Collect the body up to the matching `\end{env}`, splitting on `\\` and `&`.
    const cells = [[[]]];
    let depth = 1;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'cmd' && tok.name === 'begin') {
        depth++;
        cells[cells.length - 1][cells[cells.length - 1].length - 1].push(tok);
        i++;
        continue;
      }
      if (tok.type === 'cmd' && tok.name === 'end') {
        depth--;
        i++;
        // Consume `{env}`.
        if (tokens[i] && tokens[i].type === 'open') {
          i++;
          while (i < tokens.length && tokens[i].type !== 'close') i++;
          i++;
        }
        if (depth === 0) break;
        continue;
      }
      if (tok.type === 'cmd' && tok.name === '\\') {
        cells.push([[]]);
        i++;
        continue;
      }
      if (tok.type === 'align') {
        cells[cells.length - 1].push([]);
        i++;
        continue;
      }
      cells[cells.length - 1][cells[cells.length - 1].length - 1].push(tok);
      i++;
    }

    const kind = /matrix|array/.test(env) ? 'matrix'
      : /cases/.test(env) ? 'cases'
        : /align|gather|split/.test(env) ? 'align'
          : 'matrix';

    return {
      kind: 'env',
      env: kind,
      rows: cells.map((row) => row.map((cell) => parse(cell, opts))),
    };
  }
}

/** Parse TeX source into an unmeasured node tree. */
export function parseTex(src) {
  return parse(tokenize(src));
}

export { FRAC_GAP, LIMIT_GAP, BIN_SPACE, PUNCT_SPACE, SCRIPT_RATIO, SCRIPT_SCRIPT_RATIO, BINARY, RELATION };
