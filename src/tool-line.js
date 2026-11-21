// The `Using Tool (arg)` row, and the colour a transcript row is drawn in.
//
// Both are pure: a message object in, an ANSI string out. Nothing here reads a session, which is what lets the tool
// line animate from a wall clock instead of from a render tick.

import { C } from './colors.js';
import { col, sanitizeText } from './text.js';
import { cycleMs, lightOrigin, shimmerText, TOOL_STEP_MS } from './animate.js';
import { fmtDuration } from './format.js';

/** The colour a transcript row is drawn in, by role. */
export function msgColorFor(role, text) {
  // 'rich' output (e.g. /context, /usage panels) carries its OWN ANSI colours — do not wrap it in a single role colour,
  // or the whole panel comes out one shade.
  if (role === 'rich') return '';
  if (role === 'system' && typeof text === 'string' && text.startsWith('[turn took')) return C.gray;
  // System/status lines are NEUTRAL grey, not the brand teal: the deep teal showed up on every command result and
  // one-line notice, and at that frequency it read as noise. Grey keeps them quiet; the accents stay for user, tool
  // and working rows.
  if (role === 'system') return C.gray;
  if (role === 'user') return C.cyan;
  if (role === 'bash') return C.shellMode;   // ! shell-mode echo: violet
  if (role === 'warn') return C.orange;      // unfinished-turn warning
  if (role === 'queued') return C.gray;      // pending, not yet sent
  if (role === 'steer') return C.yellow;     // injected into the running turn
  if (role === 'tool') return C.blue;
  if (role === 'tool_result') return C.gray;
  if (role === 'skill') return C.blue;
  if (role === 'image') return C.gray;       // the row names a file, it is not prose
  return C.fg;
}

// Which argument best identifies a call, so a tool line reads `Using Read (src/tui.js)`.
const KEY_ARG = {
  Bash: ['command'],
  Read: ['path', 'file_path'],
  Write: ['path', 'file_path'],
  Edit: ['path', 'file_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  FileLines: ['path', 'file_path'],
  FetchURL: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'prompt'],
  TaskOutput: ['task_id'],
  TaskStop: ['task_id'],
};

const MAX_ARG = 60;

/**
 * The one argument worth showing next to a tool's name. `expanded` lifts the length cut.
 *
 * The cut exists so the single `● Used Bash (…)` row stays readable: a `node -e "…"` one-liner is routinely hundreds
 * of characters, and printing it whole wrapped the row across the screen for every call. Ctrl+O is the escape hatch —
 * whoever expands tool output to read it wants to see the command they are reading the output OF.
 */
export function keyArgument(name, args, workspace, expanded = false) {
  if (!args || typeof args !== 'object') return '';
  const keys = KEY_ARG[name] || Object.keys(args);
  // Expanded: the whole value, with newlines kept, so a multi-line script shows as the lines it was written as rather
  // than being flattened to its first line.
  if (expanded) {
    for (const k of keys) {
      const v = args[k];
      if (typeof v !== 'string' || !v.length) continue;
      const full = sanitizeText(v).replace(/\r\n/g, '\n');
      return (k === 'path' || k === 'file_path') ? full.replace(/\\/g, '/') : full;
    }
    return '';
  }
  for (const k of keys) {
    const v = args[k];
    if (typeof v !== 'string' || !v.length) continue;
    // Neutralise escapes BEFORE measuring: sanitizeText turns ESC into the two visible characters `^[`, so truncating
    // first and sanitizing after made a long command come out wider than MAX_ARG — and a trailing ESC cut at the
    // boundary left the row ending in a bare `^` instead of a proper `…`.
    const valueLines = sanitizeText(v).replace(/\r\n/g, '\n').split('\n');
    // A trailing blank line is not extra content: a command ending in a newline — how a heredoc is usually written —
    // split into a final empty element, and counting it claimed `(+1 line)` for a command with no second line at all.
    while (valueLines.length > 1 && valueLines[valueLines.length - 1].trim() === '') valueLines.pop();
    let text = valueLines[0];
    const rest = valueLines.length > 1 ? valueLines.length - 1 : 0;
    if (text.length > MAX_ARG) {
      text = (k === 'path' || k === 'file_path')
          ? '…' + text.slice(text.length - (MAX_ARG - 1))
          : text.slice(0, MAX_ARG - 1) + '…';
    } else if (rest) {
      // Make room for the marker before adding it, so the row never overflows: the count is dropped first because the
      // ellipsis already carries the important half of the message.
      const withCount = `… (+${rest} line${rest === 1 ? '' : 's'})`;
      text += text.length + withCount.length <= MAX_ARG
        ? withCount
        : '…';
    }
    // Display paths with forward slashes (consistent across platforms).
    if (k === 'path' || k === 'file_path') text = text.replace(/\\/g, '/');
    return text;
  }
  return '';
}

/**
 * The `● Using Name (arg)` row.
 *
 * A pending call's name carries a travelling light; a finished one is plain cyan. The light runs off a WALL CLOCK
 * rather than the tick count: the spinner advances every 80ms while the render path redraws far more often, so a phase
 * derived from the tick steps in 80ms jumps however often it is redrawn — which is the per-cell hopping this replaced.
 */
export function formatToolLine(msg, workspace, spin, pulseStart, shimmerEdge, expanded = false, reducedMotion = false, width = 0) {
  const name = msg.toolName || '';
  const arg = keyArgument(name, msg.toolArgs, workspace, expanded);
  const verb = msg.pending ? 'Using' : 'Used';
  let nameDisplay;
  if (msg.pending) {
    // `??`, NOT `||`: tick 0 is a legitimate anchor at the START of a turn, and `0 || spin` would collapse the elapsed
    // time to zero so the light never moved at all.
    const anchorSpin = pulseStart ?? spin;
    // THE KEY IS THE ROW'S OWN IDENTITY, and nothing else.
    //
    // It used to carry `anchorSpin` too, on the reasoning that the same message re-animated on a new tick should get a
    // new origin. The opposite happened: when the caller passes no `pulseStart`, `anchorSpin` IS the tick counter, so
    // every frame built a new key, `lightOrigin` created a fresh origin, and the elapsed time stayed at 0 — the light
    // sat still except for the one frame after the row content changed.
    //
    // A row animates from the moment it appears until it stops being pending, and its id is stable across that life.
    const rowKey = msg && (msg.id || msg.toolId) ? `tool:${msg.id || msg.toolId}` : `tool:${name}`;
    const elapsedMs = Math.max(0, Date.now() - lightOrigin(rowKey, anchorSpin, spin));
    const phaseMs = elapsedMs % cycleMs(name.length, TOOL_STEP_MS);

    // The same restraint as the Working row's glint: the light is the base colour with a small lift in the SAME hue,
    // not a jump to white. A pale white against cyan reads as a state change; a shade brighter reads as a sheen.
    const BASE = [0, 215, 255];      // cyan: the name's resting colour
    const GLINT = [110, 240, 255];   // the same hue, a shade brighter

    // A pending tool's name is decoration, so reduced motion drops it rather than freezing it mid-sweep.
    nameDisplay = reducedMotion
      ? col(name, C.cyan)
      : shimmerText(name, phaseMs, BASE, GLINT, shimmerEdge || 'cosine', TOOL_STEP_MS);
  } else {
    nameDisplay = col(name, C.cyan);
  }
  // Streamed size for a Write in flight.
  let sizeStr = '';
  if (name === 'Write' && typeof msg.streamContent === 'string' && msg.streamContent.length) {
    const bytes = Buffer.byteLength(msg.streamContent, 'utf8');
    sizeStr = bytes >= 1048576 ? ` ${(bytes / 1048576).toFixed(1)}MB`
      : bytes >= 1024 ? ` ${(bytes / 1024).toFixed(1)}KB`
      : ` ${bytes}B`;
  }
  // +xx -xx for a finished Edit. The diff itself is rendered under the `↳` receipt, so prefer the counts the
  // tool_result handler copied over.
  let diffStr = '';
  const edDiff = (Array.isArray(msg.diff) && msg.diff.length) ? msg.diff : msg._diffCounts;
  if (name === 'Edit' && !msg.pending && Array.isArray(edDiff) && edDiff.length) {
    const adds = edDiff.filter((d) => d.type === 'add').length;
    const deletes = edDiff.filter((d) => d.type === 'del').length;
    if (adds || deletes) {
      diffStr = ' ' + (adds ? col(`+${adds}`, C.green) : '') + ' ' + (deletes ? col(`-${deletes}`, C.red) : '');
    }
  }
  // COLORED PER LINE, not around the whole string.
  //
  // `col(text)` writes one escape pair around everything, so a multi-line argument — exactly what Ctrl+O reveals, the
  // body of a script — had its colour open on line 1 and none after the newline: the terminal's reset made every line
  // below the first render in the DEFAULT foreground. Splitting on the newline and colouring each piece keeps the whole
  // block the same grey. The parentheses still wrap the WHOLE value, so a multi-line script reads as one bracketed
  // argument rather than as several.
  let argText = '';
  if (arg) {
    const argLines = `${arg}`.split('\n');
    const painted = argLines.map((l, i) => col(
      (i === 0 ? '(' : '') + l + (i === argLines.length - 1 ? ')' : ''),
      C.gray,
    ));
    argText = ' ' + painted.join('\n');
  }
  // HOW LONG IT TOOK, at the very end of the line.
  //
  // A running call counts up from its start, so a slow tool shows progress rather than looking frozen; a finished one
  // shows the total. Same slot either way, so the line does not reflow when the call lands.
  //
  // Nothing is shown when the start is unknown — an older session, or a restored transcript — because a duration
  // invented from "now" would be a lie that grows every frame.
  let timeStr = '';
  if (typeof msg.startAt === 'number' && msg.startAt > 0) {
    const ended = typeof msg.endedAt === 'number' && msg.endedAt > 0
      ? msg.endedAt
      : (msg.pending ? Date.now() : 0);
    if (ended >= msg.startAt) timeStr = ' ' + col(`(${fmtDuration(ended - msg.startAt)})`, C.gray);
  }
  return col(verb, C.white) + ' ' + nameDisplay + argText + col(sizeStr, C.gray) + diffStr + timeStr;
}
