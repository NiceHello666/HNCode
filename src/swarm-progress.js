// AgentSwarm live progress block, mirroring kimi-code's AgentSwarmProgress.
//
// kimi does NOT render a swarm as a tool line plus a text dump. It renders a live
// BLOCK in the transcript:
//
//   ─ Agent Swarm ─ two subagents each replied hi ─ coder
//
//     001 [#---------------] Working…   Inspecting src/tui.js
//     002 [###-------------] Queued…
//     003 [################] Completed.
//
//    Completed.  ━━━━━━━━━━━━━━━━━━━━━
//
// Structure (all of it from kimi's component):
//   * header   - "Agent Swarm" + " ─ " + description + " ─ " + model, padded with ─
//   * grid     - one CELL per subagent: an index, a progress bar, a phase label
//                and the latest line of that subagent's output
//   * status   - the overall label plus a segmented "pip bar": one ━ per subagent,
//                coloured by that subagent's phase, in STATUS_BAR_ORDER
//
// This module is PURE: it takes a snapshot and returns lines. No timers, no
// state — the TUI owns the member list and calls renderSwarmProgress().

import { C } from './colors.js';
import { visualWidth } from './term.js';
import { uiText } from './i18n.js';

const ESC = '\x1b';
function visWidth(s) { return visualWidth(String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')); }
const ELLIPSIS = '\u2026';
function col(text, c) { return c + String(text) + C.reset; }

// The order kimi lays the pip-bar segments in, so the bar always reads
// completed-first regardless of which subagent finished when.
const STATUS_BAR_ORDER = ['completed', 'working', 'suspended', 'queued', 'cancelled', 'failed'];

// phase -> (label, colour). kimi's labels, verbatim.
const PHASE = {
  queued:     { label: 'Queued\u2026',     color: C.gray },
  prompting:  { label: 'Prompting\u2026',  color: C.cyan },
  working:    { label: 'Working\u2026',    color: C.cyan },
  suspended:  { label: 'Rate limited\u2026', color: C.yellow },
  completed:  { label: 'Completed.',       color: C.green },
  failed:     { label: 'Failed.',          color: C.red },
  cancelled:  { label: 'Cancelled.',       color: C.gray },
};
export function phaseInfo(phase) {
  const p = PHASE[phase] || PHASE.working;
  return { ...p, label: uiText(p.label) };
}

const BAR_EMPTY = '-';
const BAR_FULL = '#';
const STATUS_BAR_CHAR = '\u2501';   // ━
const SUCCESS_MARK = '\u2714';      // ✔
const FAILURE_MARK = '\u2716';      // ✖
const CANCELLED_MARK = '\u2716';

// ---- helpers ---------------------------------------------------------------

function truncateToWidth(s, width) {
  const str = String(s);
  if (width <= 0) return '';
  if (visWidth(str) <= width) return str;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    if (n + cw > width - 1) break;   // leave a cell for the ellipsis
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  return out + ELLIPSIS;
}

function padTo(s, width) {
  const w = visWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function collapseWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// ---- the model -> phases ---------------------------------------------------

// A background "agent" task carries the swarm in ctx: we track members from the
// progress lines the AgentSwarm tool appends (`[n/m] finished`) plus, when the
// caller has richer data, an explicit member list. Members are normalised here so
// the renderer never has to guess.
export function normalizeMember(m, i) {
  const src = m || {};                        // a half-built member must not crash the grid
  const phase = PHASE[src.phase] ? src.phase : 'queued';
  return {
    index: i + 1,
    phase,
    // Carried through, not dropped: `renderCell` reads it for the bar, and omitting it
    // here meant every cell fell back to the placeholder ratio no matter what the agent
    // reported — the wire carried a real figure and the renderer never saw one.
    ratio: typeof src.ratio === 'number' && Number.isFinite(src.ratio) ? src.ratio : null,
    latestText: collapseWhitespace(src.latestText || src.text || ''),
    label: src.label || '',
  };
}


// Overall status of the swarm: failed wins over aborted over working/completed.
// `members` is normally an array, but this is also reachable from a rebuilt session
// where it can be null — guard rather than crash the whole render.
export function totalStatus(members, flags = {}) {
  if (flags && flags.failed) return 'failed';
  if (flags && flags.aborted) return 'aborted';
  if (!Array.isArray(members) || !members.length) return 'working';
  const phaseOf = (m) => (m && m.phase) || 'queued';   // a null member is "queued", not a crash
  if (members.some((m) => phaseOf(m) === 'failed')) return 'failed';
  if (members.every((m) => phaseOf(m) === 'completed')) return 'completed';
  if (members.every((m) => ['completed', 'cancelled', 'failed'].includes(phaseOf(m)))) return 'completed';
  return 'working';
}

const TOTAL_LABEL = {
  working: 'Working\u2026',
  completed: 'Completed.',
  failed: 'Failed.',
  aborted: 'Aborted.',
  cancelled: 'Cancelled.',
};

// ---- grid layout (kimi's calculateAgentSwarmGridLayout, simplified) --------

export function computeGridLayout(input) {
  const { width, height, count } = input || {};
  // Every input is coerced: a caller that passes nothing (or a NaN width) would
  // otherwise produce NaN rows/cells and a frame full of garbage.
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : Number.POSITIVE_INFINITY;
  // Try the widest sensible column count whose cells still hold a readable bar.
  // Then clamp the ROWS back to the height budget: kimi falls back to COMPACT
  // bars rather than spilling. We keep the text cells but cap the row count, so a
  // 128-subagent swarm cannot push the transcript off screen.
  const MIN_CELL = 22;
  const GAP = 2;
  let best = { columns: 1, rows: safeCount, cellWidth: safeWidth };
  for (let columns = 1; columns <= safeCount; columns++) {
    const cellWidth = Math.floor((safeWidth - GAP * (columns - 1)) / columns);
    if (cellWidth < MIN_CELL) break;
    best = { columns, rows: Math.ceil(safeCount / columns), cellWidth };
  }
  // Visible rows never exceed the budget. The caller adds one "+N more" line.
  // Visible rows never exceed the budget. The caller adds one "+N more" line.
  const maxRows = Number.isFinite(safeHeight) ? Math.max(1, safeHeight) : best.rows;
  const shownRows = Math.min(best.rows, maxRows);
  return {
    columns: best.columns,
    rows: shownRows,
    cellWidth: best.cellWidth,
    totalRows: best.rows,
    truncated: best.rows > shownRows,
    // How many cells actually get drawn, so the caller can report the rest.
    visibleCount: Math.min(safeCount, shownRows * best.columns),
    count: safeCount,
  };
}

// ---- cells -----------------------------------------------------------------

function renderBar(ratio, cells, color) {
  const n = Math.max(0, Math.round(ratio * cells));
  return col(BAR_FULL.repeat(n), color) + col(BAR_EMPTY.repeat(Math.max(0, cells - n)), C.gray);
}

// One cell:  `001 [####----] Working…  <latest text>`
// The cell is truncated to EXACTLY `cellWidth` visible columns, so joining cells
// with a gap cannot overflow the row (kimi truncates every cell the same way).
function renderCell(member, cellWidth) {
  const idx = String(member.index).padStart(3, '0');
  const info = phaseInfo(member.phase);
  const label = info.label;
  // A working cell with no ratio from its agent shows a near-empty bar, not a confident
  // half. `0.5` was a fixed placeholder: every running agent drew the same half-filled bar
  // for its whole life, which read as "halfway done" and was simply untrue — a swarm of
  // seven showed seven identical 50% bars and then jumped straight to 100%.
  const ratio = member.phase === 'completed' ? 1
    : member.phase === 'queued' ? 0
      : (member.ratio != null ? Math.max(0, Math.min(1, member.ratio)) : 0.05);
  // Budget: "001 [" + bar + "] " + label + optional "  " + text.
  const fixed = 3 + 2 + 2 + visWidth(label);
  const barCells = Math.max(0, Math.min(20, cellWidth - fixed));
  let cell = col(idx, C.gray) + ' [' + renderBar(ratio, barCells, info.color) + '] '
    + col(label, info.color);
  const room = cellWidth - visWidth(cell);
  if (room > 3 && member.latestText) {
    cell += '  ' + col(truncateToWidth(member.latestText, room - 2), C.gray);
  }
  return padTo(truncateToWidth(cell, cellWidth), cellWidth);
}

// ---- the status pip bar ----------------------------------------------------

function renderPipBar(members, width) {
  const counts = new Map();
  for (const m of members) {
    const p = STATUS_BAR_ORDER.includes(m.phase) ? m.phase : 'working';
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const segs = STATUS_BAR_ORDER.filter((p) => counts.get(p)).map((p) => ({ p, n: counts.get(p) }));
  if (!segs.length) return col(STATUS_BAR_CHAR.repeat(Math.max(1, width)), C.gray);
  const total = segs.reduce((a, s) => a + s.n, 0);
  let used = 0;
  return segs.map((s, i) => {
    const w = i === segs.length - 1 ? width - used : Math.round((s.n / total) * width);
    used += w;
    if (w <= 0) return '';
    return col(STATUS_BAR_CHAR.repeat(w), phaseInfo(s.p).color);
  }).join('');
}

// ---- public renderer -------------------------------------------------------

/**
 * Render the swarm block. `snapshot`:
 *   { description, model, members: [{phase, ratio, latestText}], failed, aborted }
 * Returns an array of already-coloured lines, ALREADY indented by `indent`.
 */
export function renderSwarmProgress(snapshot, width, opts = {}) {
  const snap = snapshot || {};
  const desc = collapseWhitespace(snap.description || '');
  const model = collapseWhitespace(snap.model || '');
  const members = (Array.isArray(snap.members) ? snap.members : []).map(normalizeMember);
  const indent = opts.indent == null ? ' ' : opts.indent;
  const innerW = Math.max(10, width - visWidth(indent));
  const lines = [];

  // ---- header: `─ Agent Swarm ─ desc ─ model ─────` ----
  const title = col('Agent Swarm', C.spring + C.bold);
  const suffix = [];
  if (desc) suffix.push(col(' \u2500 ', C.spring) + col(desc, C.white));
  if (model) suffix.push(col(' \u2500 ', C.spring) + col(model, C.gray));
  const used = 3 + visWidth(title) + visWidth(suffix.join(''));
  const tail = Math.max(0, innerW - used);
  const header = col(' \u2500 ', C.spring) + title + suffix.join('') + (tail > 1 ? col(' ' + '\u2500'.repeat(tail - 1), C.spring) : '');
  lines.push(indent + truncateToWidth(header, innerW));

  // ---- optional blank + grid, exactly like kimi's [ '', header, '', grid, '', status, '' ] ----
  lines.push(indent + '');
  const gridH = Number.isFinite(opts.availableGridHeight) ? opts.availableGridHeight : undefined;
  const layout = computeGridLayout({ width: innerW, height: gridH, count: members.length });
  if (!members.length) {
    lines.push(indent + col('Orchestrating\u2026', C.cyan));
  } else {
    for (let r = 0; r < layout.rows; r++) {
      const cells = [];
      for (let c = 0; c < layout.columns; c++) {
        const m = members[r * layout.columns + c];
        if (!m) continue;
        cells.push(renderCell(m, layout.cellWidth));
      }
      if (cells.length) lines.push(indent + cells.join('  '));
    }
    // A swarm taller than the budget reports the remainder instead of spilling.
    if (layout.truncated) {
      lines.push(indent + col(`\u2026 +${layout.count - layout.visibleCount} more`, C.gray));
    }
  }
  lines.push(indent + '');

  // ---- status: mark + label + pip bar ----
  const status = totalStatus(members, { failed: snap.failed, aborted: snap.aborted });
  const mark = status === 'completed' ? SUCCESS_MARK
    : status === 'failed' ? FAILURE_MARK
    : status === 'aborted' ? CANCELLED_MARK
    : '';
  const label = TOTAL_LABEL[status] || TOTAL_LABEL.working;
  const lc = status === 'completed' ? C.green
    : status === 'failed' ? C.red
    : status === 'aborted' ? C.gray
    : C.cyan;
  const head = (mark ? col(mark + ' ', lc) : '  ') + col(label, lc);
  const barW = Math.max(0, innerW - visWidth(head) - 2);
  lines.push(indent + head + (barW > 0 ? '  ' + renderPipBar(members, barW) : ''));
  lines.push(indent + '');
  return lines;
}

// Derive a member list from the progress lines the AgentSwarm tool appends to a
// task's output (`[n/m] finished`). Used as the fallback when the caller has no
// richer per-subagent data — e.g. rebuilding the block after a session reload.
export function membersFromOutput(output, total) {
  const text = String(output || '');
  // Each line names its agent, and the agent it names is the one it is about:
  //   `[#i] started`        this agent began
  //   `[#i] progress <pct>` this agent is pct% through its own work
  //   `[#i] finished [n/m]` this agent, with a running total for readers that only count
  //
  // Reading a bare `[n/m]` as "the first n are done" was the earlier mistake: workers pull
  // from a shared queue, so agent 3 can finish before agent 1, and the count says nothing
  // about which. A `[n/m]`-only line is still accepted, for output written before this
  // named its agent, and is counted but not attributed.
  const started = new Set();
  const doneSet = new Set();
  const ratioOf = new Map();
  let bareDone = 0;
  for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
    let m = /^\[#(\d+)\] started$/.exec(line);
    if (m) { started.add(Number(m[1])); continue; }
    m = /^\[#(\d+)\] progress (\d+)$/.exec(line);
    if (m) { ratioOf.set(Number(m[1]), Math.max(0, Math.min(100, Number(m[2]))) / 100); continue; }
    m = /^\[#(\d+)\] finished(?: \[\d+\/\d+\])?$/.exec(line);
    if (m) { doneSet.add(Number(m[1])); continue; }
    if (/^\[\d+\/\d+\] finished$/.test(line)) bareDone++;
  }
  // A named finish also counts as "an agent started", so a log that lost its `started` lines
  // still attributes the finish instead of leaving the cell stuck on "working" forever.
  for (const idx of doneSet) started.add(idx);
  // Bounded. `highest` comes off the wire, and one malformed line (`[#999999] progress 1`)
  // would otherwise allocate an array that size and hang the render on every frame.
  const MAX_MEMBERS = 128;
  const highest = Math.min(MAX_MEMBERS, Math.max(0, ...started, ...doneSet, ...ratioOf.keys()));
  const n = Math.min(MAX_MEMBERS, Math.max(total || 0, bareDone, highest));
  // The lines no name claims are the OLD format's only evidence of who finished, so they are
  // attributed to the agents that have not spoken for themselves — counting from the front
  // and skipping any agent that announced itself, rather than refusing to attribute them at
  // all whenever a single named line is present.
  let unattributed = Math.max(0, bareDone - doneSet.size);
  const legacyDone = new Set();
  for (let idx = 1; idx <= n && unattributed > 0; idx++) {
    if (started.has(idx) || doneSet.has(idx) || ratioOf.has(idx)) continue;
    legacyDone.add(idx);
    unattributed--;
  }
  return Array.from({ length: n }, (_, i) => {
    const idx = i + 1;
    const completed = doneSet.has(idx) || legacyDone.has(idx);
    const phase = completed ? 'completed'
      : started.has(idx) ? 'working'
        : 'queued';
    const out = { phase, latestText: '' };
    // `ratioOf` only ever holds a finite value, so the extra `isFinite` test was dead — and
    // it turned a genuine 0 into `null`, which the renderer reads as "no figure at all".
    if (ratioOf.has(idx) && !completed) out.ratio = ratioOf.get(idx);
    return out;
  });
}
