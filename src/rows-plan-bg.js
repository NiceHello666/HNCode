// Two transcript row kinds that are self-contained: the Plan card and a background task's lifecycle card.
//
// Both turn one message into a list of `{ text, ind, raw }` rows. `raw: true` means the text already carries its own
// ANSI and must be painted verbatim.

import { C } from './colors.js';
import { col, fitAnsi, visualCol, wrapWords } from './text.js';
import { uiText } from './i18n.js';
import { renderMdText } from './markdown.js';

/**
 * A Plan, drawn as a bordered card.
 *
 * `width` is the transcript's inner width (the caller already removed the one-column margin); the card lands at
 * `width - 2`.
 *
 * Rows must be `{text, ind, raw}` OBJECTS — that is the contract the caller's `rowToLine` reads. Pushing plain strings
 * here made it read `undefined` and the whole block rendered as blank lines.
 */
export function planRows(msg, width) {
  const tableW = Math.max(12, width - 2);
  const out = [];
  const bar = (ch) => col(ch, C.border);
  const inner = Math.max(1, tableW - 2);
  const full = (l, r) => bar(l + '─'.repeat(inner) + r);
  // Header: the card's single column is captioned "Plan".
  out.push({ text: full('╭', '╮'), ind: '', raw: true });
  out.push({ text: bar('│') + fitAnsi(col(' ' + uiText('Plan'), C.cyan + C.bold), inner) + bar('│'), ind: '', raw: true });
  out.push({ text: bar('├' + '─'.repeat(inner) + '┤'), ind: '', raw: true });
  const lines = String(msg.text || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const textW = Math.max(1, inner - 2);
  for (const raw of lines) {
    if (raw.trim() === '') {
      out.push({ text: bar('│') + ' '.repeat(inner) + bar('│'), ind: '', raw: true });
      continue;
    }
    // Headings are emphasised; everything else renders as Markdown body text so **bold**, `code` and bullets work.
    const isHead = /^\s*#{1,6}\s/.test(raw);
    const shown = isHead ? raw.replace(/^\s*#{1,6}\s*/, '') : raw;
    for (const r of renderMdText(shown, textW, isHead ? (C.cyan + C.bold) : C.white, C.cyan)) {
      out.push({ text: bar('│') + ' ' + fitAnsi(r, textW) + ' ' + bar('│'), ind: '', raw: true });
    }
  }
  out.push({ text: full('╰', '╯'), ind: '', raw: true });
  return out;
}

/**
 * A background task's lifecycle card:
 *
 *     ● agent task completed in background (review the diff)
 *     ✗ bash task failed in background (npm test · exit 1)
 *
 * The bullet is `●` normally and `✗` for a failure; the colour follows the phase. The task's conclusion sits underneath,
 * indented, and is capped like a tool result so one chatty subagent cannot flood the transcript.
 */
export function bgTaskRows(msg, width, expanded) {
  const card = msg.card || { phase: 'completed', headline: 'background task finished', detail: undefined };
  const tone = card.phase === 'started' ? C.cyan : card.phase === 'completed' ? C.green : C.red;
  const bullet = card.phase === 'failed' ? '✗ ' : '● ';
  const out = [];
  const detail = card.detail ? col(` (${card.detail})`, C.gray) : '';
  out.push({ text: col(bullet, tone) + col(card.headline, tone) + detail, ind: '', raw: true });
  const body = String(msg.text || '').trim();
  if (body) {
    const indent = '  ';
    const avail = Math.max(1, width - visualCol(indent));
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    // No cap once expanded: a silent ceiling left a long result stopping short with a hint telling the user to press
    // the key they had already pressed.
    const MAX = expanded ? lines.length : 6;
    for (const ln of lines.slice(0, MAX)) {
      for (const w of (ln === '' ? [''] : wrapWords(ln, avail))) {
        out.push({ text: col(w, C.gray), ind: indent, raw: true });
      }
    }
    if (lines.length > MAX) {
      // Only reachable while COLLAPSED: expanded, `MAX` is the whole list and this cannot fire.
      out.push({ text: col(uiText(`… ${lines.length - MAX} more lines, ctrl+o to expand`), C.gray), ind: indent, raw: true });
    }
  }
  return out;
}
