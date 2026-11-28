// The input line: its prompt, its collapsed pastes, and its selection.
//
// Nothing here paints a screen or reads a session. A caller hands in the state object and gets back the prefix, the
// marker text, or a row with a span recoloured — which is what lets the same rules serve the TUI's composer and any
// other front end that wants them.

import { C } from './colors.js';

/**
 * What the composer shows for this state: the buffer, the caret, and the prompt prefix.
 *
 * SHELL MODE (`!`) is modelled on kimi-code's editor. Typing `!` on an EMPTY composer flips a mode flag instead of
 * inserting the character; the `!` is rendered as the PREFIX. That is what keeps it from appearing twice: the buffer
 * holds only the command, the caret never has to step over a marker it is not editing, and submit never has to strip
 * anything.
 *
 * STDIN MODE takes `▸`, the same glyph the hint row under a running command uses, so one idea has one symbol.
 */
export function composerInput(state) {
  const shell = state.inputMode === 'bash';
  const prefix = state.stdinMode ? '▸ ' : (shell ? '! ' : '> ');
  return { text: state.input || '', caret: state.caret || 0, prefix };
}

/**
 * Marker text for a collapsed paste.
 *
 * Only a multi-line TEXT paste collapses; an IMAGE always collapses, because its payload is a temp file path that
 * should never be shown as if the user typed it.
 *
 *   text, multi-line : [paste #1 +12 lines]
 *   text, one line   : [paste #1 1 lines]
 *   image            : [paste #1 image]
 *
 * The `image` form keeps the same `paste #N` prefix on purpose: expansion, chipping and caret movement all key off
 * it, so images get the styling and atomic behaviour for free.
 */
export function pasteMarker(id, lineCount, kind = 'paste') {
  if (kind === 'image') return `[paste #${id} image]`;
  return lineCount > 1 ? `[paste #${id} +${lineCount} lines]` : `[paste #${id} ${lineCount} lines]`;
}

/** The tail of any collapsed-paste marker: `+L lines`, `L lines`, or `image`. */
export const PASTE_MARKER_RE = /\[paste #(\d+) (?:\+\d+ lines|\d+ lines|image)\]/g;

const MARKER_LEFT_RE = /\[paste #(\d+) (?:\+\d+ lines|\d+ lines|image)\]$/;
const MARKER_RIGHT_RE = /^\[paste #(\d+) (?:\+\d+ lines|\d+ lines|image)\]/;

/** Expand every `[paste #N …]` marker in `text` back to its real content. */
export function expandPastes(text, pastes) {
  if (!pastes || !text || !text.includes('[paste #')) return text;
  return text.replace(PASTE_MARKER_RE, (whole, id) => {
    const entry = pastes.get(Number(id));
    return entry ? entry.text : whole;
  });
}

/**
 * Chip each collapsed-paste marker with a selection background, leaving non-marker text untouched.
 *
 * The chip ends with `C.bgReset` and then the caller's SURFACE, not with a bare reset: `ESC[0m` clears EVERY style, so
 * it also wiped the foreground the caller had applied to the text after the chip — the rest of the line came out in
 * the terminal's default grey instead of the prompt's colour. `ESC[49m` gives the background back to the terminal
 * rather than to the theme, so the caller's own surface has to follow it immediately or the rest of the row shows
 * whatever background the user's terminal happens to have.
 *
 * `hoverId` is the paste number the pointer is over, when it is over one; that chip keeps the hover accent.
 * `surface` is the background the caller is about to paint under this row, or '' when the row has none.
 */
export function highlightPasteMarkers(row, hoverId = null, surface = C.bg) {
  const s = String(row);
  if (!s.includes('[paste #')) return s;
  return s.replace(PASTE_MARKER_RE, (m, id) => {
    const after = C.bgReset + surface;
    if (Number(id) === hoverId) return C.hover + C.selBg + m + after;
    return C.selBg + m + after;
  });
}

/**
 * Which paste number, if any, occupies this input index. Returns null when none does.
 *
 * The companion to `expandPasteMarkerAt`: that one acts on the chip under the pointer, this one merely names it so the
 * row can be drawn differently. Both need the same bounds, and a chip is inclusive of its end because the caret index
 * rounds to the position after the last character.
 */
export function pasteMarkerIdAt(input, idx) {
  const cur = String(input == null ? '' : input);
  if (!cur.includes('[paste #')) return null;
  for (const m of cur.matchAll(PASTE_MARKER_RE)) {
    const at = m.index;
    if (idx >= at && idx <= at + m[0].length) return Number(m[1]);
  }
  return null;
}

/**
 * Expand the collapsed paste the caret index lands on, in place. Returns true when one was expanded.
 *
 * `onChanged` is called after a successful expansion so the host can re-run whatever menu or completion refresh it
 * owns — this module does not know about menus.
 *
 * Takes the ALREADY-CONVERTED index. An earlier version took the row and column and converted itself, which
 * double-subtracted the row's prefix width — every click landed two columns left of the pointer and a click on the
 * chip's first character expanded nothing.
 *
 * `state.pastes` keeps its entry: expansion is a no-op for text with no marker, so leaving it costs nothing, and
 * dropping it would break a later marker that still refers to the same paste.
 */
export function expandPasteMarkerAt(state, idx, onChanged) {
  const cur = state.input || '';
  if (!cur.includes('[paste #')) return false;

  for (const m of cur.matchAll(PASTE_MARKER_RE)) {
    const at = m.index;
    const end = at + m[0].length;
    // Clicking any character of the chip targets it — including the character after the last one, which is where a
    // click on the closing bracket rounds to.
    if (idx < at || idx > end) continue;
    const entry = state.pastes && state.pastes.get(Number(m[1]));
    if (!entry) return false;
    state.input = cur.slice(0, at) + entry.text + cur.slice(end);
    // The caret goes AFTER the expanded text, so the next keystroke continues where it ends rather than landing in the
    // middle of the paste the user just revealed.
    state.caret = at + entry.text.length;
    state.composerSel = null;
    if (typeof onChanged === 'function') onChanged();
    return true;
  }
  return false;
}

/**
 * Apply a selection background to the text portion of a composer row.
 *
 * `text` is the visible text on this row (after the prefix), `textStart` is the character offset of `text[0]` in the
 * full input string, and `[selAnchor, selHead]` is the selection range in the full input.
 *
 * Selection changes only the BACKGROUND; the foreground keeps its own colour. Leaving the selection restores the
 * PAGE instead of emitting a full reset, for two reasons: a bare reset also kills the foreground, and `ESC[49m` hands
 * the background back to the TERMINAL — which showed its own colour for the rest of the line.
 */
export function highlightSelection(text, textStart, selAnchor, selHead) {
  if (!text) return text;
  const a = Math.min(selAnchor, selHead);
  const h = Math.max(selAnchor, selHead);
  let out = '';
  let inSel = false;
  for (let i = 0; i < text.length; i++) {
    const globalIdx = textStart + i;
    const want = globalIdx >= a && globalIdx < h;
    if (want && !inSel) { out += C.selBg; inSel = true; }
    else if (!want && inSel) { out += C.bg; inSel = false; }
    out += text[i];
  }
  if (inSel) out += C.reset;
  return out;
}

/**
 * The collapsed-paste marker adjacent to the caret, in the given direction.
 *
 * The composer treats a marker as ONE atomic unit: moving the caret across it jumps over the whole thing, and
 * deleting it removes the entire marker.
 *
 * @param {string} text  the buffer
 * @param {number} caret character index
 * @param {number} dir   -1 looks left of the caret, +1 looks right
 * @returns {{start:number, end:number, id:number}|null}
 */
export function adjacentPasteMarker(text, caret, dir) {
  const s = String(text || '');
  const c = Math.max(0, Math.min(s.length, caret));
  if (dir < 0) {
    const m = MARKER_LEFT_RE.exec(s.slice(0, c));
    if (m) return { start: c - m[0].length, end: c, id: Number(m[1]) };
  } else {
    const m = MARKER_RIGHT_RE.exec(s.slice(c));
    if (m) return { start: c, end: c + m[0].length, id: Number(m[1]) };
  }
  return null;
}
