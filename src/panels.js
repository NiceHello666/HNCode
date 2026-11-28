// The stacked panels above the composer: the title strip, the todo list and the queue.
//
// Each pair of functions here is a HEIGHT and a RENDERER for the same panel. Keeping them in one module is what stops
// them disagreeing: a reserved height that does not match the drawn rows shifts every row below it by one.

import { C } from './colors.js';
import { col, fitAnsi, wrapWords } from './text.js';
import { uiText } from './i18n.js';

// ---- title strip ----------------------------------------------------------

/**
 * The title strip along the top of the screen.
 *
 * `maxRows` is how many rows of name to show. A name that fits on one row uses one; a longer one WRAPS, and the rows it
 * needs are reserved for it — a terminal is narrow, and cutting a session name to its first forty characters loses the
 * part that told them apart. The last visible row ends in `…` when the name continues below.
 *
 * `state.titleRows` is the height the user dragged the rule to. `0` or unset means "as many as the name needs", which
 * is what a fresh session wants. The rule is always the LAST row, so it is always in the same place to grab.
 */
export function renderTitleBar(state, w, hover, maxRows) {
  const title = String(state.sessionTitle || '').trim();
  // A NAMELESS SESSION IS NOT A BLANK BAND. `Untitled` says the strip is there and can be clicked; an empty row reads
  // as a rendering gap.
  const label = title || 'Untitled';
  const out = [];
  // ONE LEADING SPACE, matching the transcript's own left margin so the name lines up with the messages below.
  const PAD = ' ';
  const room = Math.max(1, w - PAD.length);
  const rows = Math.max(1, Math.round(maxRows) || 1);
  // Wrap the name to the width, keeping ANSI out of it — the colour is applied per row below.
  const wrapped = wrapWords(label, room);
  const shownRows = wrapped.slice(0, rows);
  // A name with more rows than the band can show ends in `…` on its last visible row.
  const more = wrapped.length > shownRows.length;
  // THE PLACEHOLDER IS THE SAME COLOUR AS A REAL NAME. Dimming it made a fresh session's band look disabled — as if the
  // strip were not there to be clicked. The word already says the session has no name.
  const textColor = hover ? C.heading : C.cyan;
  const ruleColor = hover ? C.cyan : C.border;
  for (let i = 0; i < shownRows.length; i++) {
    let line = shownRows[i];
    if (i === shownRows.length - 1 && more) {
      // Trim one column so the ellipsis fits inside the width instead of pushing the row over.
      line = fitAnsi(line, room - 1).trimEnd() + '…';
    }
    out.push(fitAnsi(PAD + col(line, textColor + C.bold), w));
  }
  out.push(col('─'.repeat(w), ruleColor));
  return out;
}

/** How many rows the title needs at this width, ignoring any drag. */
export function titleRowsNeeded(state, w) {
  const title = String(state.sessionTitle || '').trim() || 'Untitled';
  const room = Math.max(1, w - 1);
  return Math.max(1, wrapWords(title, room).length);
}

/**
 * Name rows currently shown: the dragged height when set, otherwise as many as the name needs.
 *
 * Reading it from `state.titleRows` rather than from the frame keeps the drag arithmetic independent of what was last
 * painted.
 */
export function titleRowCount(state) {
  const need = titleRowsNeeded(state, state.cols || process.stdout.columns || 80);
  const set = Math.round(Number(state.titleRows) || 0);
  return set > 0 ? Math.min(set, need) : need;
}

// ---- todo panel -----------------------------------------------------------

/** How many todo rows the panel shows when nothing has been dragged. */
export const TODO_MAX_VISIBLE = 5;

/**
 * The first `max` entries, in the order they were written.
 *
 * This used to RANK: in-progress first, then one done item, then pending. On a status change the panel therefore
 * reshuffled — the item being worked on jumped to the top and a finished one followed it — and the list stopped
 * describing the order the work was planned in. A task list is a sequence; a view that reorders it is showing something
 * other than what was written.
 */
export function selectVisibleTodos(todos, max = TODO_MAX_VISIBLE) {
  const list = Array.isArray(todos) ? todos : [];
  const limit = Number.isFinite(max) ? Math.max(0, Math.round(max)) : TODO_MAX_VISIBLE;
  if (list.length <= limit) return { rows: list, hidden: 0, counts: {} };
  const rows = list.slice(0, limit);
  const counts = { done: 0, in_progress: 0, pending: 0 };
  for (let i = limit; i < list.length; i++) {
    const s = list[i] && list[i].status;
    counts[s] = (counts[s] || 0) + 1;
  }
  return { rows, hidden: list.length - rows.length, counts };
}

/** One todo line: a status mark and the title, coloured by status. */
export function todoRow(todo, w) {
  const mark = todo.status === 'in_progress' ? col('●', C.cyan + C.bold)
    : todo.status === 'done' ? col('✓', C.green)
    : col('○', C.gray);
  const title = todo.status === 'in_progress' ? col(todo.title, C.white + C.bold)
    : todo.status === 'done' ? col(todo.title, C.gray)
    : col(todo.title, C.white);
  return '  ' + mark + ' ' + fitAnsi(title, Math.max(1, w - 4));
}

/**
 * Is this list FINISHED — every item done, and at least one item?
 *
 * A finished list is DROPPED, not merely hidden: it has stopped being a list of what is left to do, so the data goes as
 * well as the panel. Hiding alone left the array to be persisted with the session and handed back to the model as
 * `cfg.todoState`, which is a finished plan being described as current work.
 *
 * `every` on an EMPTY array is true, so the length check is load-bearing: this must not fire for "no todos", which is a
 * different state with its own handling everywhere else.
 */
export function todosAllComplete(list) {
  const todos = Array.isArray(list) ? list : [];
  return todos.length > 0 && todos.every((t) => t && t.status === 'done');
}

/** The same question, asked of a TUI state object rather than a bare array. */
export function todoListFinished(state) {
  return todosAllComplete(state && state.todos);
}

/**
 * How many todo ROWS the panel shows.
 *
 * `state.todoRows` (set by dragging the top rule) wins when present; otherwise the automatic heuristic decides. Always
 * clamped to [1, todos.length]: at least ONE row, never more than exist.
 */
export function todoRowCount(state) {
  const todos = state.todos || [];
  if (!todos.length) return 0;
  // A finished list has no rows: see `todoListFinished`.
  if (todoListFinished(state)) return 0;
  const manual = state.todoRows;
  let rows;
  if (typeof manual === 'number' && Number.isFinite(manual)) {
    rows = Math.round(manual);
  } else {
    rows = state.todosExpanded ? todos.length : selectVisibleTodos(todos).rows.length;
  }
  return Math.max(1, Math.min(todos.length, rows));
}

/** Height (in rows) the todo panel will occupy, for layout math. */
export function todoPanelHeight(state) {
  const todos = state.todos || [];
  if (!todos.length) return 0;
  // Zero once everything is done, so the chrome shrinks by the panel's whole height rather than leaving a blank gap.
  // Both this and the renderer ask the same predicate, so the reserved height and the drawn rows cannot disagree — a
  // mismatch there shifts every row below.
  if (todoListFinished(state)) return 0;
  const rows = todoRowCount(state);
  const extra = todos.length > rows ? 1 : 0; // the "… +N more" hint
  return 2 + rows + extra; // rule + heading + rows (+ hint)
}

export function renderTodoPanel(state, w, hoverTop, dragTop) {
  const todos = state.todos || [];
  if (!todos.length) return [];
  // A finished list draws NOTHING, matching `todoPanelHeight` returning 0 for the same state.
  if (todoListFinished(state)) return [];
  const out = [];
  const ruleColor = dragTop ? C.scrollThumbActive : (hoverTop ? C.hover : C.border);
  out.push(col('─'.repeat(w), ruleColor));
  out.push(col(uiText('  Todo'), C.cyan + C.bold));
  const want = todoRowCount(state);
  // CREATION ORDER, ALWAYS. Which rows fit is still the panel's decision — it takes the first `want` in order.
  const rows = todos.slice(0, want);
  for (const t of rows) out.push(todoRow(t, w));
  const hidden = todos.length - rows.length;
  if (hidden > 0) {
    const counts = { done: 0, in_progress: 0, pending: 0 };
    for (const t of todos) if (!rows.includes(t)) counts[t.status] = (counts[t.status] || 0) + 1;
    const dist = [['done', 'done'], ['in_progress', 'in progress'], ['pending', 'pending']]
      .filter(([k]) => counts[k] > 0).map(([k, label]) => `${counts[k]} ${uiText(label)}`).join(', ');
    // The hint appears exactly when rows are hidden — which is exactly when Ctrl+T is useful — so this is where the key
    // has to be discoverable.
    out.push(col(`  ${uiText(`… +${hidden} more`)}${dist ? ` (${dist})` : ''} ${uiText('· ctrl+t to expand · drag the top rule to resize')}`, C.gray));
  }
  return out;
}

// ---- queue panel ----------------------------------------------------------

/** How many queued messages the panel shows when nothing has been dragged. */
export const QUEUE_MAX_VISIBLE = 5;

/**
 * How many queue ROWS the panel shows.
 *
 * `state.queueRows` (set by dragging the top rule) wins when present; otherwise show all items up to the cap. Always
 * clamped to [1, queued.length]: at least ONE row, never more than exist.
 */
export function queueRowCount(state) {
  const queued = state.queued || [];
  if (!queued.length) return 0;
  const manual = state.queueRows;
  let rows;
  if (typeof manual === 'number' && Number.isFinite(manual)) {
    rows = Math.round(manual);
  } else {
    rows = Math.min(queued.length, QUEUE_MAX_VISIBLE);
  }
  return Math.max(1, Math.min(queued.length, rows));
}

/** Height (in rows) the queue panel will occupy, for layout math. */
export function queuePanelHeight(state) {
  const queued = state.queued || [];
  if (!queued.length) return 0;
  const rows = queueRowCount(state);
  const extra = queued.length > rows ? 1 : 0; // the "… +N more" hint
  return 2 + rows + extra; // rule + heading + rows (+ hint)
}

/**
 * The queue pane: one rule, one line per queued message, one dim hint line.
 *
 * Queued input is held while the agent is streaming and is injected by Ctrl+S (or by the agent itself at the next tool
 * boundary). Supports auto-collapse and drag-to-resize like the todo panel.
 */
export function renderQueuePanel(state, w, hoverTop, dragTop) {
  const queued = state.queued || [];
  if (!queued.length) return [];

  const out = [];
  const ruleColor = dragTop ? C.scrollThumbActive : (hoverTop ? C.hover : C.border);
  out.push(col('─'.repeat(w), ruleColor));
  out.push(col(uiText('  Queue'), C.cyan + C.bold));

  const want = queueRowCount(state);
  const rows = queued.slice(0, want);
  for (const text of rows) {
    // Collapse to a single line, so one queued message is one row however it was typed.
    const single = String(text).replace(/\s+/g, ' ').trim();
    out.push(col('  ', C.cyan) + col('> ', C.cyan) + col(fitAnsi(single, Math.max(1, w - 6)), C.white));
  }

  const hidden = queued.length - rows.length;
  if (hidden > 0) {
    const more = uiText(`… +${hidden} more`);
    const hint = state.running
      ? `${more} · ${uiText('↑ to edit · ctrl-s to steer immediately')} · ${uiText('drag top rule to resize')}`
      : `${more} · ${uiText('↑ to edit · will send now')} · ${uiText('drag top rule to resize')}`;
    out.push(col('  ' + hint, C.gray));
  } else {
    const hint = state.running ? uiText('↑ to edit · ctrl-s to steer immediately') : uiText('↑ to edit · will send now');
    out.push(col('  ' + hint, C.gray));
  }

  return out;
}
