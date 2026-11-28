// TasksBrowser - the full-screen background-task panel (/tasks), mirroring
// kimi-code's TasksBrowserApp.
//
// Layout:
//   TASK BROWSER  filter=ALL  2 running  3 total
//   +-- Tasks [all] --+  +-- Detail ----------+
//   | > bash-x  run   |  | Task ID:  ...      |
//   |   agent-y compl  |  +-- Preview Output -+
//   |                  |  | <live tail>       |
//   +------------------+  +-------------------+
//   Up/Down select  Enter/O output  S stop  R refresh  Tab filter  Q/Esc close
//
// This module is pure rendering + key handling. It returns ACTION STRINGS to the
// caller instead of touching the task store, so all state stays in one place.
import { C } from './colors.js';
import { visualWidth } from './term.js';
import { STATUS_LABEL } from './agent-task.js';
import { uiText } from './i18n.js';

const ELLIPSIS = '\u2026';
const ESC = '\x1b';
// visWidth() counts ANSI bytes, so strip escapes before measuring: every
// string here carries colour codes and would otherwise measure far too wide.
function visWidth(s) { return visualWidth(String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')); }
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;
const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

export function statusColorToken(status) {
  if (status === 'running') return C.green;
  if (status === 'completed') return C.gray;
  return C.red;
}

function truncateToWidth(s, width) {
  const str = String(s);
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
    const cw = visWidth(ch);
    if (n + cw > width - 1) {
      // Pad after the ellipsis so the row is EXACTLY `width` columns: a short
      // row breaks the frame's right border alignment.
      const used = n + 1;
      return out + ELLIPSIS + ' '.repeat(Math.max(0, width - used));
    }
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

function padToWidth(s, width) {
  const w = visWidth(s);
  if (w === width) return s;
  if (w > width) return truncateToWidth(s, width);
  return s + ' '.repeat(width - w);
}

function fitExactly(line, width) {
  let s = String(line);
  if (visWidth(s) > width) s = truncateToWidth(s, width);
  return padToWidth(s, width) + C.reset;
}

function singleLine(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }

function relativeTime(ts) {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
  const d = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (d < 60) return uiText('just now');
  const m = Math.floor(d / 60);
  if (m < 60) return m + uiText('m ago');
  const h = Math.floor(m / 60);
  if (h < 24) return h + uiText('h ago');
  return Math.floor(h / 24) + uiText('d ago');
}

export function visibleTasks(tasks, filter) {
  if (filter === 'active') return tasks.filter((t) => t.status === 'running');
  return tasks.slice();
}

function countByStatus(tasks) {
  const c = { running: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === 'running') c.running++;
    else if (t.status === 'completed') c.completed++;
    else c.failed++;
  }
  return c;
}

// A framed box: top/bottom rules + side walls, exactly width x height cells.
function renderFrame(title, content, width, height) {
  if (height < 2 || width < 4) return Array.from({ length: height }, () => ' '.repeat(width));
  const innerW = width - 2;
  const innerH = height - 2;
  const t = String(title || '');
  const topMid = t
    ? C.border + '\u2500 ' + C.cyan + C.bold + t + C.reset + C.border + ' '
      + '\u2500'.repeat(Math.max(0, innerW - visWidth(t) - 3)) + C.reset
    : C.border + '\u2500'.repeat(innerW) + C.reset;
  const lines = [C.border + '\u250c' + topMid + C.border + '\u2510' + C.reset];
  for (let i = 0; i < innerH; i++) {
    lines.push(C.border + '\u2502' + C.reset + fitExactly(content[i] ?? '', innerW) + C.border + '\u2502' + C.reset);
  }
  lines.push(C.border + '\u2514' + '\u2500'.repeat(innerW) + '\u2518' + C.reset);
  return lines;
}

export function renderTasksBrowser(state, cols, rows) {
  if (cols < MIN_WIDTH || rows < MIN_HEIGHT) {
    const lines = [fitExactly(C.red + 'Terminal too small (need >= ' + MIN_WIDTH + ' x ' + MIN_HEIGHT + ')' + C.reset, cols)];
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(cols));
    return lines;
  }
  const visible = visibleTasks(state.tasks, state.filter);
  const counts = countByStatus(visible);

  const segs = [C.cyan + C.bold + uiText(' TASK BROWSER ') + C.reset, C.gray + ' filter=' + uiText(state.filter === 'all' ? 'ALL' : 'ACTIVE') + ' ' + C.reset];
  if (counts.running) segs.push(C.green + ' ' + counts.running + uiText(' running ') + C.reset);
  if (counts.completed) segs.push(C.gray + ' ' + counts.completed + uiText(' completed ') + C.reset);
  if (counts.failed) segs.push(C.red + ' ' + counts.failed + uiText(' interrupted ') + C.reset);
  segs.push(C.gray + ' ' + visible.length + uiText(' total ') + C.reset);
  const header = fitExactly(segs.join(''), cols);

  const key = (s) => C.cyan + C.bold + s + C.reset;
  const dim = (s) => C.gray + s + C.reset;
  // The footer doubles as a TOOLBAR: each `KEY label` pair is clickable, so the
  // whole pair is recorded as one span. `cursor` tracks the column so the spans stay
  // correct as the parts are concatenated by `join('  ')`.
  const footerHits = [];
  let footer;
  if (state.pendingStop) {
    // The confirm prompt is a toolbar too: Y / N / Esc each do something, so each
    // gets a clickable span. `c` tracks the column so the spans land exactly on the
    // rendered words — the original drew `N/esc cancel` as one run, so the two keys
    // share the single "cancel" label and are measured as one span.
    const prefix = ' ' + C.orange + C.bold + uiText('Stop') + C.reset + ' ' + C.white + state.pendingStop + C.reset + '? ';
    let c = visWidth(prefix);
    const yPart = key('Y') + ' ' + dim(uiText('confirm'));
    footerHits.push({ keyWord: 'Y', label: 'confirm', action: 'confirmStop', col0: c, col1: c + visWidth(yPart) - 1 });
    c += visWidth(yPart) + 2;
    const nPart = key('N') + dim('/') + key('esc') + ' ' + dim(uiText('cancel'));
    footerHits.push({ keyWord: 'N/esc', label: 'cancel', action: 'cancelStop', col0: c, col1: c + visWidth(nPart) - 1 });
    footer = fitExactly(prefix + yPart + '  ' + nPart + ' ', cols);
  } else {
    const specs = [
      ['↑↓', uiText('select'), 'select'],
      ['Enter/O', uiText('output'), 'openOutput'],
      ['S', uiText('stop'), 'requestStop'],
      ['R', uiText('refresh'), 'refresh'],
      ['Tab', uiText('filter'), 'toggleFilter'],
      ['Q/Esc', uiText('close'), 'close'],
    ];
    const parts = [];
    let cursor = 1;
    for (const [kw, label, action] of specs) {
      const piece = key(kw) + ' ' + dim(label);
      const w = visWidth(piece);
      // `col1` is the LAST included column (hitboxes use an inclusive range, see
      // hitAt), so a piece starting at `cursor` spanning `w` cells ends at
      // `cursor + w - 1`. Using `cursor + w` made the span one column too wide, so a
      // hover tinted the following space as well.
      footerHits.push({ keyWord: kw, label, action, col0: cursor, col1: cursor + w - 1 });
      cursor += w + 2;             // the `parts.join('  ')` separator
      parts.push(piece);
    }
    const left = ' ' + parts.join('  ');
    const flash = state.flash ? C.orange + ' ' + state.flash + ' ' + C.reset : '';
    const total = visWidth(left) + visWidth(flash);
    footer = total <= cols ? left + ' '.repeat(cols - total) + flash : fitExactly(left, cols);
  }

  const bodyH = rows - 2;
  const listW = Math.max(LIST_COL_MIN, Math.min(LIST_COL_MAX, Math.floor(cols * LIST_COL_RATIO)));
  const rightW = cols - listW;

  // left: task list
  const listInnerH = Math.max(0, bodyH - 2);
  const listInnerW = listW - 2;
  let listLines;
  if (!visible.length) {
    listLines = [C.gray + uiText(state.filter === 'active' ? 'No active tasks. Tab = show all.' : 'No background tasks in this session.') + C.reset];
  } else {
    listLines = visible.map((t, i) => {
      const selected = i === state.selectedIndex;
      // Hover highlight, mirroring the rest of the TUI: the row under the pointer is
      // tinted by the generic hover pass in tui.js (composeFrame), which needs a
      // hitbox to aim at — those are recorded in state._taskHits below.
      const hot = state.hoverIndex === i;
      const ptr = selected ? C.cyan + '\u276f ' + C.reset : (hot ? C.hover + '\u276f ' + C.reset : '  ');
      // A sub-task is drawn under its parent, indented, so a swarm reads as one unit of work with
      // visible parts rather than as N unrelated rows. `parentTaskId` is set by AgentSwarm.
      const lead = t.parentTaskId ? C.gray + '  \u2514 ' + C.reset : '';
      const idCol = t.kind === 'agent' ? C.green : t.kind === 'question' ? C.orange : C.blue;
      const idText = selected ? idCol + C.bold + t.taskId + C.reset : idCol + t.taskId + C.reset;
      const pad = ' '.repeat(Math.max(0, 20 - visWidth(t.taskId)));
      const badge = statusColorToken(t.status) + uiText(STATUS_LABEL[t.status] || t.status) + C.reset;
      const prefix = lead + ptr + idText + pad + ' ' + badge;
      const budget = Math.max(0, listInnerW - visWidth(prefix) - 1);
      if (budget < 4) return fitExactly(prefix, listInnerW);
      const desc = singleLine(t.description) || singleLine(t.command) || '(no description)';
      return fitExactly(prefix + ' ' + C.white + truncateToWidth(desc, budget) + C.reset, listInnerW);
    });
  }
  // Click targets. Coordinates are FRAME cells: line 0 is the header, line 1 is the
  // list box's TOP RULE, so the first content row is line 2 — using `1 + i` put the
  // hitboxes one row high, which highlighted the border instead of the task and made
  // a click select the wrong row. Columns match the box interior (`│` + 1 cell of
  // padding), and `col1` is the LAST included column.
  state._taskHits = [];
  for (let i = 0; i < Math.min(visible.length, listInnerH); i++) {
    state._taskHits.push({ row: 2 + i, col0: 1, col1: listInnerW, kind: 'taskRow', index: i });
  }
  for (const h of footerHits) {
    state._taskHits.push({ row: rows - 1, col0: h.col0, col1: h.col1, kind: 'taskFooter', action: h.action });
  }
  while (listLines.length < listInnerH) listLines.push('');
  const listFrame = renderFrame('Tasks [' + state.filter + ']', listLines.slice(0, listInnerH), listW, bodyH);

  // right: detail + preview
  const detailH = Math.min(Math.max(10, Math.min(Math.floor(bodyH * 0.4), bodyH - 5)), Math.max(3, bodyH - 3));
  const previewH = bodyH - detailH;
  const rightInnerW = rightW - 2;
  const task = visible[state.selectedIndex];

  const detailLines = [];
  if (!task) {
    detailLines.push(C.gray + 'Select a task from the list.' + C.reset);
  } else {
    const label = (s) => C.gray + s.padEnd(14) + C.reset;
    const val = (s) => C.white + String(s) + C.reset;
    detailLines.push(label('Task ID:') + val(task.taskId));
    detailLines.push(label('Kind:') + val(task.kind));
    detailLines.push(label(uiText('Status:')) + statusColorToken(task.status) + uiText(STATUS_LABEL[task.status] || task.status) + C.reset);
    detailLines.push(label('Description:') + val(singleLine(task.description) || '-'));
    if (task.kind === 'process') {
      if (task.command && task.command !== task.description) detailLines.push(label('Command:') + val(singleLine(task.command)));
      if (task.pid) detailLines.push(label('Pid:') + C.gray + task.pid + C.reset);
      if (task.exitCode != null) detailLines.push(label('Exit code:') + C.gray + task.exitCode + C.reset);
    }
    if (task.kind === 'agent') {
      if (task.agentId) detailLines.push(label('Agent ID:') + val(task.agentId));
      if (task.subagentType) detailLines.push(label('Agent type:') + val(task.subagentType));
      if (task.model) detailLines.push(label('Model:') + val(task.model));
      if (task.thinkingEffort) detailLines.push(label('Effort:') + val(task.thinkingEffort));
    }
    if (task.kind === 'question') {
      detailLines.push(label('Questions:') + C.gray + task.questionCount + C.reset);
      if (task.toolCallId) detailLines.push(label('Tool call:') + C.gray + task.toolCallId + C.reset);
    }
    const timing = task.status === 'running'
      ? 'running ' + relativeTime(task.startedAt)
      : (task.endedAt ? 'finished ' + relativeTime(task.endedAt) : '');
    if (timing) detailLines.push(label('Time:') + C.gray + timing + C.reset);
    if (task.stopReason) detailLines.push(label('Reason:') + C.gray + singleLine(task.stopReason) + C.reset);
  }
  while (detailLines.length < Math.max(0, detailH - 2)) detailLines.push('');
  const detailFrame = renderFrame('Detail', detailLines, rightW, detailH);

  const previewInnerH = Math.max(0, previewH - 2);
  let previewLines;
  const tail = task ? String(task.output || '') : '';
  if (!task) previewLines = [C.gray + 'No task selected.' + C.reset];
  else if (!tail.length) previewLines = [C.gray + '[no output captured]' + C.reset];
  else previewLines = tail.replace(/\r\n/g, '\n').split('\n').slice(-previewInnerH).map((l) => C.gray + truncateToWidth(l, rightInnerW) + C.reset);
  while (previewLines.length < previewInnerH) previewLines.push('');
  const previewFrame = renderFrame('Preview Output', previewLines, rightW, previewH);

  const out = [header];
  for (let i = 0; i < bodyH; i++) {
    const right = i < detailH ? (detailFrame[i] ?? ' '.repeat(rightW)) : (previewFrame[i - detailH] ?? ' '.repeat(rightW));
    out.push((listFrame[i] ?? ' '.repeat(listW)) + right);
  }
  out.push(footer);
  return out;
}

// Handle one key. Returns an ACTION STRING for the caller (all state stays in
// the caller): 'close' | 'refresh' | 'toggleFilter' | 'openOutput' |
// 'requestStop' | 'confirmStop' | 'cancelStop' | 'select' | null
export function handleTasksBrowserKey(state, t) {
  const visible = visibleTasks(state.tasks, state.filter);
  const ch = t.ch;
  if (state.pendingStop) {
    if (ch === 'y' || ch === 'Y') { state.pendingStop = null; return 'confirmStop'; }
    state.pendingStop = null;
    return 'cancelStop';
  }
  if (t.key === 'escape' || ch === 'q' || ch === 'Q') return 'close';
  if (t.key === 'up' || ch === 'k') {
    if (!visible.length) return null;
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    return 'select';
  }
  if (t.key === 'down' || ch === 'j') {
    if (!visible.length) return null;
    state.selectedIndex = Math.min(visible.length - 1, state.selectedIndex + 1);
    return 'select';
  }
  if (t.key === 'home') { state.selectedIndex = 0; return 'select'; }
  if (t.key === 'end') { state.selectedIndex = Math.max(0, visible.length - 1); return 'select'; }
  if (t.key === 'tab') return 'toggleFilter';
  if (ch === 'r' || ch === 'R') return 'refresh';
  if (ch === 's' || ch === 'S') {
    const task = visible[state.selectedIndex];
    if (!task) return null;
    if (task.status !== 'running') return 'stopIgnored';
    state.pendingStop = task.taskId;
    return 'requestStop';
  }
  if (ch === 'o' || ch === 'O' || t.key === 'enter') return 'openOutput';
  return null;
}
