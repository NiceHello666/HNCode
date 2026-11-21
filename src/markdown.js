// Markdown → ANSI rows.
//
// One block in, a list of painted rows out. Nothing here knows about a transcript, a session or a screen: a caller
// hands over text and a width, which is what lets the same renderer serve a chat row, a tool result and a table cell.
//
// The incremental path exists because streaming rewrites only the LAST block of a growing reply. Splitting at blank
// lines outside a fence makes every earlier block final, so only the tail is re-rendered — verified to produce the
// same rows as a whole-document render, which is the property the cache depends on.

import { C } from './colors.js';
import { renderLatex } from './latex.js';
import { measureTex, encodeTexImage, TEX_MAX_ROWS } from './tex/index.js';
import { render as renderMermaid, sourceBox as mermaidSourceBox, toAnsi as mermaidAnsi } from './mermaid/index.js';
import { encodeImageRow } from './image-row.js';
import { terminalCaps } from './term-caps.js';
import { col, visualCol, wrapWords } from './text.js';

/**
 * Version of the markdown renderer, part of the incremental cache key.
 *
 * That cache is validated on the INPUT — text, width, colours — which cannot see that the renderer itself now produces
 * different rows for the same input. A session that cached a block before a fence type learned to draw kept showing
 * the old output, so the change looked like it had not shipped. Bump this whenever what `renderMdText` produces for
 * the same input changes.
 */
export const MD_RENDER_VERSION = 7;   // 7: an image row carries the TeX that produced it

/**
 * Render a growing markdown text, re-rendering only the last block.
 *
 * @param {object} msg   carries `_mdCache` between calls
 * @param {string} text
 * @param {number} width
 * @param {string} fg     body colour
 * @param {string} codeFg inline-code colour
 * @returns {{headRows: string[], tailRows: string[], headCut: number}}
 */
export function renderMdIncremental(msg, text, width, fg, codeFg) {
  const src = text.replace(/\r\n/g, '\n');
  let c = msg._mdCache;
  // Layout identity: same width/colours and the same text. Comparing the text (not just its length) is required — a
  // same-length replacement must re-render.
  if (c && c.v === MD_RENDER_VERSION && c.width === width && c.fg === fg && c.codeFg === codeFg && c.text === src) {
    return { headRows: c.headRows, tailRows: c.tailRows, headCut: c.headCut };
  }
  if (!c || c.v !== MD_RENDER_VERSION || c.width !== width || c.fg !== fg || c.codeFg !== codeFg) {
    c = msg._mdCache = { v: MD_RENDER_VERSION, width, fg, codeFg };
  }

  const parts = splitBlocks(src);
  // A block is final once a LATER block exists; the last one is still growing.
  const headCount = Math.max(0, parts.length - 1);
  // THE CACHED BLOCKS BELONG TO A VERSION OF THE RENDERER. Without that check a request for the same text, width and
  // colours reuses rows produced by an OLDER renderer: the fast path above rejects them on `c.v`, but it leaves `c`
  // untouched (its width and colours still match), and this reuse test then finds the block texts identical and hands
  // back the old rows.
  const canReuse = c.v === MD_RENDER_VERSION
    && Array.isArray(c.blocks)
    && Array.isArray(c.blockTexts)
    && c.blockTexts.length >= headCount
    && parts.length >= headCount
    && c.blockTexts.slice(0, headCount).every((t, i) => t === parts[i]);

  const blocks = canReuse ? c.blocks.slice(0, headCount) : parts.slice(0, headCount).map((b) => renderMdText(b, width, fg, codeFg));
  const headRows = [];
  for (const b of blocks) for (const r of b) headRows.push(r);
  const tailRows = renderMdText(parts.length ? parts[parts.length - 1] : '', width, fg, codeFg);
  const headCut = parts.length > 1 ? parts.slice(0, headCount).join('\n').length : 0;

  msg._mdCache = {
    v: MD_RENDER_VERSION,
    text: src, width, fg, codeFg,
    blocks, blockTexts: parts.slice(0, headCount),
    headRows, tailRows, headCut,
  };
  return { headRows, tailRows, headCut };
}

/**
 * Split at blank lines OUTSIDE a fence.
 *
 * The blank line(s) begin the NEXT block, so every block renders the same whether or not later blocks exist — that is
 * the property the incremental cache depends on.
 */
export function splitBlocks(src) {
  if (src === '') return [''];
  const lines = src.split('\n');
  const out = [];
  let cur = [];
  let fence = false;
  for (const ln of lines) {
    const isFence = /^\s*(```+|~~~+)/.test(ln);
    const blank = ln.trim() === '';
    if (blank && !fence) {
      if (cur.length) { out.push(cur); cur = []; }
      cur.push(ln);
      continue;
    }
    if (isFence) fence = !fence;
    cur.push(ln);
  }
  if (cur.length) out.push(cur);
  return out.map((b) => b.join('\n'));
}

/** Render a whole markdown document to painted rows. */
export function renderMdText(text, width, fg, codeFg) {
  const src = String(text).replace(/\r\n/g, '\n');
  const para = src.split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}.*\|/.test(l) || /^\s*\|[-: ]+\|/.test(l);
  const splitCells = (l) => {
    const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map((c) => c.trim());
  };

  while (i < para.length) {
    const line = para[i];
    const t = line.replace(/\s+$/, '');
    // DISPLAY MATH: `$$ ... $$` and `\[ ... \]`.
    //
    // A fence is what a model writes when it wants a code block, but a formula usually arrives as `$$`. It is laid out
    // here as the formula it describes — stacked fractions, limits above a sum — and its source is what remains when
    // the subset cannot express it, exactly as a math fence behaves. The opener has to start the line and the closer
    // has to end one, so `cost is $$x$$ total` stays prose and is handled as inline math by the line renderer below.
    const mathOpen = /^\s*(\$\$|\\\[)/.exec(t);
    if (mathOpen) {
      const open = mathOpen[1];
      const close = open === '$$' ? '$$' : '\\]';
      const after = t.slice(mathOpen.index + mathOpen[0].length);
      let body = null;
      let used = 0;
      let closed = true;
      // One-line form: `$$x = 1$$` with nothing but whitespace after the closer.
      const oneLine = after.indexOf(close);
      if (oneLine >= 0 && after.slice(oneLine + close.length).trim() === '') {
        body = after.slice(0, oneLine);
        used = 1;
      } else if (after.trim() === '') {
        // Multi-line form: everything up to the line that ends with the closer.
        const collected = [];
        let k = i + 1;
        let found = false;
        while (k < para.length) {
          const cl = para[k].replace(/\s+$/, '');
          if (cl.trimEnd().endsWith(close)) {
            collected.push(cl.slice(0, cl.lastIndexOf(close)));
            k++;
            found = true;
            break;
          }
          collected.push(para[k]);
          k++;
        }
        body = collected.join('\n');
        used = k - i;
        // Still streaming: no closer yet, so the body is prose plus half a formula.
        closed = found;
      }
      if (body !== null && closed) {
        i += used;
        // Same three fallbacks as a math fence: bitmap, Unicode layout, then the source.
        const rows = mathBlockRows(body, width, true);
        if (rows) {
          out.push(...rows);
        } else {
          // Unsupported: show the TeX so the reader still gets the formula's meaning.
          for (const l of body.split('\n')) out.push(col('  ' + l.slice(0, Math.max(1, width - 2)), C.white));
        }
        continue;
      }
    }
    // Fenced code block. Rendered with a rule ABOVE (labelled with the language) and a matching full-width rule BELOW,
    // so the block is visibly delimited.
    const fm = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(t);
    if (fm) {
      const lang = fm[2] || '';
      i++;
      const buf = [];
      const fenceChar = fm[1][0];
      const fenceLen = fm[1].length;
      const isCloser = (s) => {
        const m = /^\s*(`{3,}|~{3,})\s*$/.exec(s);
        return !!m && m[1][0] === fenceChar && m[1].length >= fenceLen;
      };
      while (i < para.length && !isCloser(para[i])) { buf.push(para[i]); i++; }
      // Whether the closing fence was actually reached: an open fence means the text is still streaming.
      const fenceClosed = i < para.length;
      i++; // closing fence (no-op when the fence is still open)
      const rule = (s) => col(s, C.gray);
      // MATH FENCES ARE TYPESET. A `latex`/`tex`/`math` fence is TeX, not code: it is drawn as the formula it
      // describes, and when the terminal speaks an image protocol it is drawn as a TYPESET BITMAP rather than as
      // flattened Unicode.
      //
      // Three fallbacks, in order, and each one keeps the formula: the bitmap; the Unicode layout when the picture
      // cannot be placed (no protocol, no cell size, too wide, too tall); the SOURCE when the subset cannot express
      // the TeX at all.
      if (/^(latex|tex|math)$/i.test(lang)) {
        const tex = buf.join('\n').trim();
        const rendered = mathBlockRows(tex, width, fenceClosed);
        if (rendered) {
          out.push(...rendered);
          continue;
        }
        // Falls through to the plain code block: the source is all we have.
      }
      if (/^mermaid$/i.test(lang)) {
        const diagramSrc = buf.join('\n');
        let art = null;
        try { art = renderMermaid(diagramSrc); } catch { art = null; }
        // Wider than the panel: the frame is the honest answer, since truncating art would cut a box in half rather
        // than say the diagram does not fit.
        if (art && art.width <= width) {
          // `toAnsi` keeps the role of every span, so the frame stays dim and the connectors cyan instead of the
          // whole diagram arriving as plain white text.
          const coloured = mermaidAnsi(art);
          for (const l of coloured) out.push(l);
          continue;
        }
        try {
          for (const l of mermaidSourceBox(diagramSrc, width).plain) out.push(col(l, C.white));
          continue;
        } catch { /* fall through to the plain code block */ }
      }
      // Opening rule: `─ <lang> ` then `─` padding out to the FULL width.
      if (lang) {
        const head = `\u2500 ${lang} `;
        out.push(rule(head + '─'.repeat(Math.max(1, width - visualCol(head)))));
      } else {
        out.push(rule('─'.repeat(Math.max(1, width))));
      }
      // Fenced code block CONTENT is plain body text — the default terminal colour, not the theme's cyan. The cyan is
      // reserved for UI chrome and the language label; a large code block in cyan reads as "everything is the theme
      // colour".
      for (const cl of buf) out.push(col(cl.slice(0, width), C.white));
      // Closing rule, matching the opening one.
      out.push(rule('─'.repeat(Math.max(1, width))));
      continue;
    }
    // Table: a header line followed by a separator line
    if (t.includes('|') && i + 1 < para.length && isTableSep(para[i + 1])) {
      const header = splitCells(t);
      const sep = splitCells(para[i + 1]);
      const body = [];
      i += 2;
      while (i < para.length && para[i].trim().includes('|') && !isTableSep(para[i])) { body.push(splitCells(para[i])); i++; }
      renderTable(out, header, body, sep.length, width, fg);
      continue;
    }
    // Fall through to single-line renderer
    const rows = markdownLineToRows(t, width, fg, codeFg, false);
    out.push(...rows);
    i++;
  }
  return out;
}

/** Render a Markdown table as aligned columns. Header bolded, rows readable. */
export function renderTable(out, header, body, colCount, width, fg) {
  const cols = Math.max(header.length, colCount, ...body.map((r) => r.length));
  const B = C.border;
  const val = (r, c) => (r && r[c] !== undefined ? String(r[c]) : '');
  // Per-column natural width (visual columns), reserving 2 padding each side.
  const natural = Array.from({ length: cols }, (_, c) => {
    let m = 0;
    const consider = (v) => { m = Math.max(m, visualCol(v)); };
    consider(val(header, c));
    for (const r of body) consider(val(r, c));
    return m;
  });
  // Cap total table width to the available width (minus borders).
  const availInner = Math.max(cols, width - (cols + 1));
  const totalNatural = natural.reduce((a, b) => a + 2 + b, 0);
  let widths;
  if (totalNatural <= availInner) {
    widths = natural;
  } else {
    // Scale down proportionally, but never below MIN_COL. A column squeezed to 1 is a column whose content is
    // unreadable, so the shrink stops at a width a word can still use and the ROW grows taller instead.
    const MIN_COL = 4;
    const over = totalNatural - availInner;
    const surplus = natural.reduce((a, b) => a + (b > MIN_COL ? b - MIN_COL : 0), 0);
    widths = natural.map((n) => {
      const shrink = over > 0 && surplus > 0 ? Math.round((Math.max(0, n - MIN_COL)) * (over / surplus)) : 0;
      return Math.max(Math.min(MIN_COL, n), n - shrink);
    });
  }
  // WRAP, DO NOT TRUNCATE. A cell whose text does not fit its column used to be emitted at full length, which pushed
  // every border after it to the right and broke the table's alignment for the rest of the row. The row now grows
  // taller: each cell is wrapped to its column, and every line is padded to the same width.
  const wrapCell = (text, w) => {
    if (!text) return [''];
    return wrapWords(text, Math.max(1, w));
  };
  // A cell renders its INLINE MARKDOWN (bold, code, links) — a table of `**name**` and `` `value` `` used to show the
  // asterisks and backticks verbatim, which is not what the author wrote.
  const styled = (text, w, bold) => {
    const plain = wrapCell(text, w);
    const paint = bold ? C.white + C.bold : C.gray;
    return plain.map((lineText) => {
      // Render the markdown FIRST, then pad the RESULT.
      //
      // The pad has to be measured on what the cell will actually PRINT, not on the source: `` `--verbose` `` is 11
      // characters of source but 9 on screen once the backticks become a colour, so padding by the source width left
      // the column short by two and every border after it moved left.
      const md = inlineMarkdown(lineText, C.gray, bold ? C.white : C.gray);
      const printed = visualCol(String(md).replace(/\x1b\[[0-9;]*m/g, ''));
      const pad = Math.max(0, w - printed);
      return col(' ', paint) + col(md, paint) + col(' '.repeat(pad) + ' ', paint);
    });
  };
  const rule = (left, mid, right) => col(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right, B);
  // One logical row, as several physical lines when any cell wraps.
  const oneRow = (cells, bold) => {
    const rendered = [];
    for (let c = 0; c < cols; c++) rendered.push(styled(val(cells, c), widths[c], bold));
    const height = Math.max(1, ...rendered.map((r) => r.length));
    for (let lineIdx = 0; lineIdx < height; lineIdx++) {
      const parts = rendered.map((r, c) => (r[lineIdx] !== undefined
        ? r[lineIdx]
        : col(' ' + ' '.repeat(widths[c]) + ' ', bold ? C.white + C.bold : C.gray)));
      out.push(col('│', B) + parts.join(col('│', B)) + col('│', B));
    }
  };
  out.push(rule('╭', '┬', '╮'));
  oneRow(header, true);
  out.push(rule('├', '┼', '┤'));
  for (const r of body) oneRow(r, false);
  out.push(rule('╰', '┴', '╯'));
}

/** One line of markdown to rows: headings, rules, quotes, lists, then inline styles. */
export function markdownLineToRows(line, width, fg, codeFg, isContinuation) {
  const out = [];
  const t = line.replace(/\s+$/, '');

  // Headings: `# Title`
  let m = /^(\s*)(#{1,6})\s+(.*)$/.exec(t);
  if (m && !isContinuation) {
    const hashCount = m[2].length;
    // h1 is bold white, h2 is plain white, h3+ is gray. Only h1 carries BOLD.
    const size = hashCount === 1 ? C.white + C.bold : hashCount === 2 ? C.white : C.gray;
    for (const w of wrapWords(m[3], width)) {
      out.push(col(w, size));
    }
    return out;
  }
  // Thematic break
  if (/^\s*(-{3,}|\*{3,}|_{3,})$/.test(t)) {
    out.push(col('─'.repeat(Math.min(width, Math.max(8, width))), C.gray));
    return out;
  }
  // Blockquote
  //
  // THE RULE AND THE TEXT ARE DIFFERENT COLOURS. The rule takes the theme colour, so a quote reads as a distinct block
  // in the transcript; the text takes the comment grey, so quoted material is visibly not the reply's own voice.
  // Colouring both the same made a quote indistinguishable from an indented paragraph.
  if (/^\s*>\s?/.test(t)) {
    const content = t.replace(/^\s*>\s?/, '');
    for (const w of wrapWords(content, Math.max(1, width - 2))) {
      out.push(col('▍ ', C.cyan) + col(w, C.comment));
    }
    return out;
  }
  // Unordered/ordered list — bold the bullet, keep content plain. Also handles task checkboxes.
  {
    const task = /^(\s*)([-*+]\s+)?\[( |x|X)\]\s+(.*)$/.exec(t);
    if (task && !isContinuation) {
      const checked = task[3] !== ' ';
      const box = checked ? col('✓', C.green) : col('○', C.gray);
      const content = col(' ' + inlineMarkdown(task[4], codeFg, fg), fg);
      for (const w of wrapWords(task[4], Math.max(1, width - 4))) {
        out.push(col('  ', C.gray) + box + (w === task[4] ? content : col(' ' + w, fg)));
      }
      return out;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (li && !isContinuation) {
      const isOrdered = /^\d/.test(li[2]);
      const bullet = isOrdered ? col(li[2], C.cyan) : col('•', C.cyan);
      const pad = isOrdered ? ' '.repeat(visualCol(li[2])) + ' ' : '  ';
      let first = true;
      for (const w of wrapWords(inlineMarkdown(li[3], codeFg, fg), Math.max(1, width - 2))) {
        out.push((first ? col('', C.gray) + bullet + ' ' : col(pad, C.gray)) + col(w, fg));
        first = false;
      }
      return out;
    }
  }
  // Inline styles: **bold**, *italic*, `code`, [text](url), $math$
  if (/[*`\[$]|\\\(/.test(t)) {
    for (const w of wrapWords(t, width)) out.push(col(inlineMarkdown(w, codeFg, fg), fg));
    return out;
  }
  // Plain - apply default foreground color
  for (const w of wrapWords(t, width)) out.push(col(w, fg));
  return out;
}

/**
 * Whether the terminal can receive a formula as a picture.
 *
 * Both halves are required: a protocol the terminal reported (Sixel today) and a cell size it reported (XTWINOPS 16).
 * Without the cell size the picture would be measured in guessed cells, which is what put a formula on the wrong rows
 * before — so a missing cell size falls back to text rather than guess.
 */
export function mathImageCapable() {
  const caps = terminalCaps();
  if (!caps) return null;
  // KITTY FIRST. A terminal that speaks both (Kitty can be built with Sixel support) handles Kitty far better: the
  // pixels are uploaded once and every later frame is a placement, while a Sixel has to be retransmitted and moves the
  // cursor when it is drawn.
  const protocol = caps.kittyGraphics
    ? 'kitty'
    : (Array.isArray(caps.extensions) && caps.extensions.includes('sixel') ? 'sixel' : null);
  if (!protocol) return null;
  const cell = caps.cell && caps.cell.w > 0 && caps.cell.h > 0 ? caps.cell : null;
  return cell ? { protocol, cell } : null;
}

/** Ink colour for a typeset formula: the body text colour, so a picture sits in the text rather than beside it. */
export const MATH_INK = { r: 220, g: 220, b: 220 };

/**
 * The terminal's cell height in pixels, for cropping a picture that straddles the top of the window.
 *
 * A crop has to convert CELL ROWS to six-pixel BANDS; without the cell height the two units get confused and the image
 * is drawn from the wrong point in its own payload. 20 is the conventional monospace cell height and matches the
 * fallback `src/tex/` uses when the terminal never answers XTWINOPS 16.
 */
export function mathCellHeight() {
  const caps = terminalCaps();
  const cell = caps && caps.cell;
  return cell && cell.h > 0 ? cell.h : 20;
}

/**
 * Rows for one display formula: a typeset bitmap when the terminal can show one, the Unicode layout when it cannot,
 * and nothing when the TeX is outside the subset (the caller then shows the source).
 *
 * @param {string} tex TeX without delimiters.
 * @param {number} width Columns available.
 * @param {boolean} closed The closing delimiter arrived. A formula still streaming keeps to the text form: a picture of
 *   half a formula is worse than the TeX of half a formula.
 * @returns {string[]|null}
 */
export function mathBlockRows(tex, width, closed) {
  const src = stripMathDelimiters(tex);
  if (!src) return null;
  // A picture sits where the text form does: one column of indent, and no wider than the panel.
  const room = Math.max(8, width - 2);
  if (closed) {
    const placed = placeTex(src, room);
    if (placed) return placed;
  }
  const rendered = renderLatex(src, { display: true });
  if (rendered === undefined) return null;
  return rendered
    .split('\n')
    .map((l) => col(l.slice(0, width), C.white));
}

/**
 * Remove the delimiters a formula may still be wrapped in.
 *
 * A `$$…$$` block and a ```latex fence both reach the typesetter, and the fence's content may carry the delimiters too
 * — a model writes the fence around `$$…$$` often enough that it is the common case, not the odd one. Typesetting the
 * delimiters along with the formula draws them as glyphs inside the picture.
 *
 * Only a delimiter that spans the WHOLE body is removed: a `$$` in the middle is TeX the author meant, and stripping it
 * would change the formula. The loop runs because a doubled wrapper leaves one pair behind after the first pass.
 */
export function stripMathDelimiters(tex) {
  let s = String(tex || '').trim();
  for (;;) {
    const before = s;
    if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) {
      s = s.slice(2, -2).trim();
    } else if (s.startsWith('\\[') && s.endsWith('\\]') && s.length > 4) {
      s = s.slice(2, -2).trim();
    } else if (s.startsWith('\\(') && s.endsWith('\\)') && s.length > 4) {
      s = s.slice(2, -2).trim();
    }
    if (s === before) return s;
  }
}

/**
 * Typeset a formula into a frame row, or null when it cannot be placed as a picture here.
 *
 * The picture is one row of TEXT plus a payload: the row is the sentinel `image-row.js` understands, the rows below it
 * are blank, and the frame writer turns them into a cursor move and a graphics sequence. Every reason to decline is a
 * reason the caller already has a text fallback for, so this never throws.
 */
export function placeTex(tex, room) {
  const capable = mathImageCapable();
  if (!capable) return null;
  try {
    // Measured first, because laying out is what rejects TeX outside the subset: a raster would be paid for and then
    // thrown away.
    const measured = measureTex(tex, { cell: capable.cell });
    if (!measured || measured.columns > room || measured.rows > TEX_MAX_ROWS) return null;
    const image = encodeTexImage(tex, { protocol: capable.protocol, cell: capable.cell, colour: MATH_INK });
    if (!image) return null;
    // THE SOURCE TRAVELS WITH THE ROW. A picture that straddles the top of the window has to be redrawn from its first
    // VISIBLE row, and only the TeX can produce that raster: cropping the encoded payload can only land on a six-pixel
    // band boundary, which leaves up to a quarter of a cell of the formula above the window and makes it slide as the
    // view scrolls. The frame writer reads this back and re-renders with `skipTop` when a picture needs cropping.
    const rows = [encodeImageRow(image.sequence, image.rows, image.columns, tex)];
    for (let r = 1; r < image.rows; r++) rows.push('');
    return rows;
  } catch {
    // A bitmap that cannot be drawn is a reason to show text, never a reason to lose the frame.
    return null;
  }
}

/**
 * Whether a `$...$` body is a formula rather than prose.
 *
 * Prices, shell variables and identifiers all use `$`: `costs $5 and $10`, `$HOME`, `${VAR}`. A body that starts or
 * ends with a space, is a bare number or an all-caps word is prose, and so is one with no TeX command and no operator
 * in it — `vitamin $C$` stays text while `$x^2$` becomes a formula.
 */
export function looksLikeInlineMath(body) {
  if (/^\s/.test(body) || /\s$/.test(body)) return false;
  if (body.startsWith('{') || body.includes('`')) return false;
  if (/^\d+([.,]\d+)?$/.test(body)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(body)) return false;
  return /\\[A-Za-z]+|[=+\-*/<>^_]/.test(body) || (/^[A-Za-z]$/.test(body));
}

/**
 * Apply inline markdown to a single line: `code`, **bold**, *italic*, ~~strike~~, [text](url).
 *
 * Order matters so inner tokens are handled safely. `base` is the surrounding foreground colour; every inline style
 * re-asserts it after its own reset, otherwise the bare `\e[0m` would cancel the base colour for the REST of the line
 * — plain text after a **bold** run used to lose its colour and fall back to the terminal default.
 */
export function inlineMarkdown(s, codeFg, base) {
  const fb = base || '';
  let r = s;
  // Inline code first so it is not mangled by * [] ~.
  r = r.replace(/`([^`]+)`/g, (_, c) => col(c, codeFg) + fb);
  // INLINE MATH. After the code spans, so a formula inside backticks stays code, and before emphasis, so `*` and `_`
  // inside TeX cannot turn into italics. `\(...\)` is the other inline form models use.
  r = r.replace(/\$([^$\n]+?)\$|\\\(([^\n]+?)\\\)/g, (m, dollar, paren) => {
    const tex = dollar !== undefined ? dollar : paren;
    // A price or a shell variable is not math: `$5 and $10`, `$HOME`, `${VAR}`.
    if (dollar !== undefined && !looksLikeInlineMath(tex)) return m;
    const out = renderLatex(tex, { display: false });
    // Unsupported or multi-line: the source stands, because inline math sits inside wrapped prose.
    if (out === undefined || out.includes('\n')) return m;
    return out;
  });
  // Bold
  r = r.replace(/\*\*([^*]+)\*\*/g, (_, c) => C.bold + c + C.reset + fb);
  // Strikethrough
  r = r.replace(/~~([^~]+)~~/g, (_, c) => '\x1b[9m' + c + '\x1b[29m');
  // Italic
  r = r.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, c) => pre + '\x1b[3m' + c + '\x1b[23m');
  // Links: [text](url) -> text (cyan); autolink bare http(s) urls
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt) => col(txt, C.cyan) + fb);
  r = r.replace(/(^|\s)(https?:\/\/[^\s]+)/g, (_, pre, url) => pre + col(url, C.cyan));
  return r;
}
