// A tool result row: the `↳` block under the tool line.
//
// The shape is the same for every tool, and the parts differ:
//
//   ● Used Edit (a.js) +1 -1                 <- the tool line, counts only
//   ↳  179 - old line                        <- ONE `↳` on the FIRST body row
//      179 + new line
//   Edited a.js: replaced 1 occurrence(s).    <- receipt LAST
//
// An Edit's DIFF is the body and carries the marker, with the receipt moved to the bottom; every other tool's output
// IS the body and carries the marker on its first line.

import { C } from './colors.js';
import { col, expandTabs, fitAnsi, sanitizeText, visualCol, wrapWords } from './text.js';
import { langForPath } from './highlight.js';
import { paintCode } from './diff.js';

export function toolResultRows(msg, width, expanded) {
  // The marker sits in the SAME COLUMN as the tool bullet `●` (columns 0-1), so `↳ ` starts at column 0 and the output
  // text is indented to the tool text column. ONE `↳` per result, however many lines it has.
  const pre = '↳ ';
  const cont = '  ';
  const bodyW = Math.max(1, width - visualCol(cont));
  // Strip escapes BEFORE splitting: a file or a command can emit raw cursor codes, and letting them through made the
  // terminal OBEY them — recolouring the transcript, resetting styles mid-row, clearing the screen over the composer.
  const rawLines = sanitizeText(msg.text).replace(/\r\n/g, '\n').split('\n');
  // A TAB counts as ZERO columns in our width maths but advances to the next tab stop in a real terminal. A row
  // containing one was therefore padded short and the terminal kept the old frame's glyphs in the gap — the "residue"
  // under tool output. Read rows are the exception: their first tab is the line-number separator and is handled in the
  // Read branch below, where the CONTENT half is expanded too.
  if (!msg.readPath) for (let k = 0; k < rawLines.length; k++) rawLines[k] = expandTabs(rawLines[k]);
  // Trim blank lines at BOTH ends: commands typically emit a trailing newline, and some tools emit a leading one. A
  // stray blank line would render as a lone "↳ " with no content.
  while (rawLines.length && rawLines[0].trim() === '') rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
  // COLLAPSED IS A GLANCE; EXPANDED IS A READ, NOT A DUMP.
  //
  // Expanded used to be `Infinity`, so Ctrl+O on a command that printed 3000 lines put all 3000 into the transcript: the
  // conversation above it scrolled away, the scrollbar became meaningless, and every frame afterwards paid to lay out
  // rows nobody would read. The cap here is what a person can actually scan; past that the output belongs in a file,
  // which is what the hint says.
  const MAX_RESULT_LINES = expanded ? 400 : 12;
  // The exit-code line is bookkeeping for the AGENT and is NEVER shown to the user — success or failure. A failure is
  // already legible from the RED result text below. `[error: …]` is kept: it carries the message, not just a code.
  const visible = rawLines.filter((ln) => !/^\[exit code:/.test(ln.trim()));
  const failed = msg.failed === true;
  // A silent Bash keeps the ONE empty output row it had while running. Only Bash has this area: an empty Read/Grep
  // result must not grow a phantom line merely because the command itself printed nothing.
  const shown = visible.length ? visible.slice(0, MAX_RESULT_LINES) : (msg.toolName === 'Bash' ? [''] : []);

  const diffRows = [];
  const receiptRows = [];
  const hasDiff = Array.isArray(msg.diff);   // empty array => receipt-only (Write)

  if (hasDiff) {
    // Same collapse rule as elsewhere: a short preview by default, everything once Ctrl+O expands. 16 rows (not 12)
    // because a change renders as a PAIR: `- old` then `+ new`.
    const MAX = expanded ? 400 : 16;
    // Show the unified diff WITH context rows (ctx = dim) so a change is not two orphaned blocks; `gap` rows mark where
    // unchanged lines were elided.
    const total = msg.diff.length;
    const wNo = Math.max(1, ...msg.diff.map((d) => String(d.no || 0).length));
    // THE COMMENT STATE TRAVELS BETWEEN THE ROWS of one diff, so a block comment that opens on a context row and closes
    // on a changed one stays grey across both.
    let inComment = false;
    let emitted = 0;
    for (const d of msg.diff) {
      if (emitted >= MAX) break;
      if (d.type === 'gap') {
        diffRows.push({ text: col('  ⋮', C.gray), ind: cont, raw: true });
        emitted++;
        continue;
      }
      const no = String(d.no || 0).padStart(wNo);
      const mark = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
      // TABS ARE EXPANDED FIRST: `visualCol` counts one as zero columns, so an indented row measured short and its
      // background stopped before the right edge — the strip of page colour seen on Go diffs.
      const text = expandTabs(sanitizeText(d.text));

      // The sign, line number and content share the line's addition/deletion background; syntax highlighting changes
      // only the foreground. The wash runs to the right edge so adjacent changed rows read as one block.
      const isAdd = d.type === 'add';
      const isDel = d.type === 'del';
      const lineBg = isAdd ? C.diffAddBg : isDel ? C.diffDelBg : '';
      const fg = isAdd ? C.diffAddFg : isDel ? C.diffDelFg : C.white;
      const lead = col(`${no} ${mark} `, lineBg ? fg + lineBg : fg);

      if (!lineBg) {
        // CONTEXT LINES ARE CODE TOO. They are most of a diff and the part a reader scans to place the change, so they
        // get the same highlighter, on the CODE SURFACE rather than the raw page — a changed block sits on one recessed
        // field. The +/- rows around it keep their green/red wash.
        const ctxPainted = paintCode(text, d.lang, '', inComment);
        inComment = ctxPainted.inComment;
        const ctxRow = (lead + ctxPainted.text).replace(/\x1b\[0m/g, `\x1b[0m${C.codeBg}`);
        diffRows.push({ text: C.codeBg + fitAnsi(ctxRow, bodyW) + C.bgReset, ind: cont, raw: true });
        emitted++;
        continue;
      }

      // Keep only the line-level wash and syntax foreground. Positional word pairing can highlight the wrong token when
      // lines are reordered or punctuation changes, so no word tint is applied.
      const painted = paintCode(text, d.lang, lineBg, inComment);
      inComment = painted.inComment;
      const used = visualCol(`${no} ${mark} `) + visualCol(painted.text);
      const pad = ' '.repeat(Math.max(0, bodyW - used));
      // The padding is INSIDE the wash, so it must not end with a bare reset: `col()` closes with ESC[0m, which would
      // drop the background on the last column and leave a strip of page colour at the right edge.
      diffRows.push({ text: lead + painted.text + lineBg + pad + '\x1b[39m', ind: cont, raw: true });
      emitted++;
    }
    if (total > emitted) {
      diffRows.push({
        // A DEAD-END Ctrl+O IS WORSE THAN NO HINT. Collapsed it expands; already expanded there is nothing left to
        // reveal, so the line says how much was withheld instead of inviting a key that would do nothing.
        text: col(expanded
          ? `… (${total - emitted} more lines not shown; the full diff went to the model)`
          : `… (${total - emitted} more lines, ctrl+o to expand)`, C.gray),
        ind: cont, raw: true,
      });
    }
    if (total === 0) diffRows.push({ text: col('(no changes)', C.gray), ind: cont, raw: true });
    // The receipt: one line per source line of the tool's own message.
    for (const ln of shown) {
      const color = failed ? C.red : C.gray;
      for (const t of (ln === '' ? [''] : wrapWords(ln, bodyW))) {
        receiptRows.push({ text: t, ind: cont, color });
      }
    }
  } else {
    // No diff: the tool's own output is the body.
    //
    // A READ RESULT IS SOURCE CODE, so its numbered lines are syntax-coloured — the file's own language, carried on the
    // message by the tool_result handler, which is the last place that still knows the path. The header and any error
    // keep the plain grey: those are the tool's own words, not the file's.
    const readLang = msg.readPath ? langForPath(msg.readPath) : null;
    // THE GUTTER IS ONE WIDTH FOR THE WHOLE BLOCK. The tool sends `N<TAB>text`, and the tab is what used to place the
    // code — so `1` and `10` started their text at different columns once the tab was expanded. Padding the NUMBER to
    // the widest one in this block keeps the digits left-aligned and the code aligned under itself.
    const numW = shown.reduce((w, ln) => {
      const m = /^(\d+)\t/.exec(ln);
      return m ? Math.max(w, m[1].length) : w;
    }, 0);
    let inComment = false;
    shown.forEach((ln, idx) => {
      const isErr = /^\[error:/.test(ln.trim());
      // A failed run is red throughout so it cannot be skimmed past.
      const color = isErr ? C.red : (failed ? C.red : C.gray);
      // `N<TAB>text` is the Read tool's own line format; only those rows are file content.
      const numbered = readLang && !isErr ? /^(\d+)\t([\s\S]*)$/.exec(ln) : null;
      if (numbered) {
        // A READ CAN START INSIDE A BLOCK COMMENT. The `/**` may sit above the first visible row, so no cross-row state
        // can tell the highlighter the first row is a comment — it coloured `of`, `switch`, `from` in a JSDoc paragraph
        // as keywords. A row that is plainly part of a block comment (` * …`, an opening `/**`, or the closing `*/`) is
        // painted as a comment on its own merits; the opener also seeds the rows that follow.
        const content = expandTabs(numbered[2]);
        const isBlockCommentRow = /^\s*(?:\/\*|\*|\*\/|\*\*)/.test(content);
        const painted = paintCode(content, readLang, '', inComment || isBlockCommentRow);
        if (/\/\*/.test(content) && !/\*\//.test(content)) inComment = true;
        else if (/\*\//.test(content)) inComment = false;
        // The separator is a SPACE: the number is padded to the block's widest, so every row's code starts in the same
        // column.
        const text = `${col(numbered[1].padStart(numW), C.white)} ${painted.text}`;
        // A Read row is TRUNCATED, not wrapped. Wrapping folded an overlong line onto a second row without a line
        // number, and that second row was exactly what a differential painter could not reconcile with the previous
        // frame: the leftover glyphs stayed under it as residue. One source line is one display row.
        //
        // The background has to survive the row's own resets: every syntax token closes with `ESC[0m`, and the padding
        // `fitAnsi` adds sits AFTER the last one. Re-asserting after each reset — the same trick `paintCode` uses for a
        // diff wash — keeps the surface on the padding too, so the block reads solid.
        const surfaced = text.replace(/\x1b\[0m/g, `\x1b[0m${C.codeBg}`);
        diffRows.push({ text: C.codeBg + fitAnsi(surfaced, bodyW) + C.bgReset, ind: idx === 0 ? pre : cont, raw: true });
        return;
      }
      const wrapped = ln === '' ? [''] : wrapWords(ln, bodyW);
      // BASH OUTPUT SITS ON THE TERMINAL SURFACE, like text inside a real terminal emulator: the darkest recess on
      // screen. Other tools keep the plain page background, so a command's output reads as "a terminal ran this" rather
      // than as an ordinary result.
      const termSurface = msg.toolName === 'Bash' || msg.toolName === 'Shell';
      wrapped.forEach((t, i) => {
        if (termSurface) {
          const surfaced = t.replace(/\x1b\[0m/g, `\x1b[0m${C.termBg}${color}`);
          // A FOREGROUND IS NOT OPTIONAL HERE.
          //
          // This set only the background, so the text fell back to the terminal's own default colour. Against the very
          // dark `termBg` that is readable on a light default and invisible on a dark one — which is exactly what a
          // dark-background terminal showed: a solid dark block with no words in it.
          //
          // The `\x1b[0m` inside the row closes EVERYTHING, background included, so both have to be re-asserted after
          // each one: the wash and the colour.
          diffRows.push({ text: C.termBg + color + fitAnsi(surfaced, bodyW) + C.bgReset, ind: idx === 0 && i === 0 ? pre : cont, raw: true });
        } else {
          diffRows.push({ text: t, ind: idx === 0 && i === 0 ? pre : cont, color });
        }
      });
    });
    if (visible.length > MAX_RESULT_LINES) {
      // THE HINT SAYS HOW TO SEE THE REST, and what "the rest" is depends on where we are.
      //
      // Collapsed: Ctrl+O expands — that is the whole point of the line.
      // Already expanded: there is no more to reveal here, so inviting another Ctrl+O would be a dead end. Say how much
      // was withheld and where it does live, which is the tool result the model was given (and, when the result was
      // spilled, the file it was written to).
      const rest = visible.length - MAX_RESULT_LINES;
      const text = expanded
        ? `… ${rest} more line${rest === 1 ? '' : 's'} not shown; the full output went to the model (ctrl+o to collapse)`
        : `… ${rest} more lines, ctrl+o to expand`;
      diffRows.push({
        text,
        ind: cont,
        color: failed ? C.red : C.gray,
      });
    }
  }

  const out = [];
  for (const r of diffRows) out.push(r);
  for (const r of receiptRows) out.push(r);
  // Put the `↳` on the FIRST rendered row (diff or output) — never on the receipt, which sits last.
  if (out.length && out[0].ind === cont && Array.isArray(msg.diff) && msg.diff.length > 0) {
    out[0] = { ...out[0], ind: pre };
  }
  // The TOOL ROW may already have drawn this result's body — a Write streams the file's content up there — in which
  // case the receipt below is the whole result and must NOT open a second `↳` block:
  //     ● Used Write (a.txt) 1.3KB
  //     ↳  1 <content>                     <- the body, marked on the tool row
  //     ↳ File written: a.txt (1372 bytes) <- the stray second `↳`, now plain
  // One body, one marker. `bodyOnToolRow` is set by the tool_result handler, the only place that knows whether the tool
  // row had content to show.
  if (msg.bodyOnToolRow && out.length && out[0].ind === pre) {
    out[0] = { ...out[0], ind: cont };
  }
  // Nothing to show (empty output) -> render no row at all rather than a dangling "↳ ".
  return out;
}
