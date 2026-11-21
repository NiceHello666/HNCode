// Two status rows in the transcript: the compaction card and a reasoning ("thinking") block.
//
// Both return rows that may carry `color` instead of `raw: true` — the caller paints them by wrapping the text in that
// colour, which is what keeps a cached row cheap to re-render.

import { C } from './colors.js';
import { col, visualCol, wrapWords } from './text.js';
import { fmtTokens } from './format.js';
import { SPIN_PLACEHOLDER } from './animate.js';

/**
 * The compaction card:
 *
 *   running   -> blinking bullet + "Compacting context…" (+ optional instruction)
 *   done      -> solid green bullet + "Compaction complete (X → Y tokens)" + a Ctrl-O hint
 *   cancelled -> warning bullet + "Compaction cancelled"
 *
 * Expanded state is the SHARED Ctrl+O one, so one key reveals tool output and compaction summaries alike.
 */
export function compactionRows(msg, width, expanded, spin) {
  const INDENT = '  ';
  const done = msg.phase === 'done';
  const canceled = msg.phase === 'cancelled';
  const bulletColor = done ? C.green : canceled ? C.yellow : C.white;
  // Blink off `spin` — the same monotonic tick the tool-call bullets use. It has to be a STATE-driven phase, NOT
  // `Date.now()`: the render cache is validated against the spin key, so a clock-derived phase changes without
  // invalidating the cache and the bullet renders once and then freezes.
  const on = ((spin || 0) >> 3) % 2 === 0;
  const bullet = (!done && !canceled && !on) ? '  ' : col('● ', bulletColor);
  let head;
  if (done) {
    const detail = (msg.tokensBefore != null && msg.tokensAfter != null)
      ? col(` (${fmtTokens(msg.tokensBefore)} → ${fmtTokens(msg.tokensAfter)} tokens)`, C.gray) : '';
    const hint = (msg.text || '').trim()
      ? col(` (Ctrl-O to ${expanded ? 'hide' : 'show'} compaction summary)`, C.gray) : '';
    head = bullet + col('Compaction complete', C.green + C.bold) + detail + hint;
  } else if (canceled) {
    head = bullet + col('Compaction cancelled', C.yellow + C.bold)
      + (msg.reason ? col(' (' + msg.reason + ')', C.gray) : '');
  } else {
    head = bullet + col('Compacting context…', C.cyan + C.bold);
  }
  const out = [{ text: head, ind: '', raw: true }];
  if (msg.instruction) {
    out.push({ text: INDENT + col(String(msg.instruction), C.gray), ind: INDENT, raw: true });
  }
  if (done && expanded && (msg.text || '').trim()) {
    const bodyW = Math.max(1, width - visualCol(INDENT));
    for (const ln of String(msg.text).replace(/\r\n/g, '\n').split('\n')) {
      if (ln === '') { out.push({ text: '', ind: INDENT, raw: true }); continue; }
      for (const w of wrapWords(ln, bodyW)) {
        out.push({ text: INDENT + col(w, C.gray), ind: INDENT, raw: true });
      }
    }
  }
  return out;
}

/**
 * A reasoning block:
 *
 *   live      -> "<spinner> thinking…" then the LAST 2 content lines, indented
 *   finalized -> "● " marker on the first line, up to 2 preview lines, then a "… (N more lines)" hint
 *
 * All of it is dim text, and the body is italic.
 */
export function thinkingRows(msg, width, expanded) {
  const INDENT = '  ';
  const bodyW = Math.max(1, width - visualCol(INDENT));
  const contentLines = [];
  for (const ln of String(msg.text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (ln === '') { contentLines.push(''); continue; }
    for (const w of wrapWords(ln, bodyW)) contentLines.push(w);
  }
  // AN EMPTY REASONING BLOCK DRAWS NOTHING.
  //
  // A model may emit a `think` event with no text, and the block that spans a tool call can be left with nothing in it —
  // the tool boundary finalises the block, so when the model reasons again it opens a NEW one. Either way the old code
  // drew a bare `●` row (or a lone "thinking…" spinner), which reads as a rendering bug: there is no thought to show.
  //
  // Only the RENDERING is suppressed. The block stays in `state.chat`, so the next `think` event APPENDS to it rather
  // than opening another one — the state machine, and the row cache that keys on it, is unchanged.
  if (!contentLines.some((l) => l.trim() !== '')) return [];
  const PREVIEW = expanded ? Infinity : 2;
  // The reasoning BODY is italic; the "thinking…" label and the "N more lines" hint are NOT. Closed with endItalic
  // rather than a reset, so the row keeps the dim grey it is drawn in.
  const it = (s) => (s === '' ? s : C.italic + s + C.endItalic);
  const out = [];
  if (msg.pending) {
    // The spinner frame is NOT baked in here: a glyph that changes every tick would invalidate this row's cache and
    // re-wrap the whole reasoning block each time, which is what made long thinking look laggy. The caller substitutes
    // the live frame outside the cache instead.
    out.push({ text: SPIN_PLACEHOLDER + ' thinking…', ind: '', color: C.gray });
    const vis = contentLines.length > PREVIEW ? contentLines.slice(-PREVIEW) : contentLines;
    for (const l of vis) out.push({ text: it(l), ind: INDENT, color: C.gray });
  } else {
    const shown = contentLines.slice(0, PREVIEW);
    shown.forEach((l, i) => out.push({ text: it(l), ind: i === 0 ? '● ' : INDENT, color: C.gray }));
    if (contentLines.length > PREVIEW) {
      out.push({ text: `… (${contentLines.length - PREVIEW} more lines, ctrl+o to expand)`, ind: INDENT, color: C.gray });
    }
  }
  return out;
}
