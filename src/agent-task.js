// Background task registry — the single place tasks are created, listed, stopped
// and read. Mirrors kimi-code's task model:
//
//   TaskInfo = base fields + a `kind`-discriminated payload
//     kind 'process'  -> { command, pid, exitCode }        (Bash run_in_background)
//     kind 'agent'    -> { agentId, subagentType, model, thinkingEffort }  (Agent)
//     kind 'question' -> { questionCount, toolCallId }     (AskUserQuestion bg)
//
// Statuses match kimi exactly so the UI can share one vocabulary:
//   running | completed | failed | timed_out | killed | lost
//
// Bash used to keep its own ad-hoc objects ('done'/'failed', `id`, `start`), which
// is why the task panel could not show the same fields as kimi's. Everything now
// goes through `createTask`, so a task always has the same shape no matter which
// tool spawned it.

import { uiText } from './i18n.js';

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'killed', 'lost']);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

// `{prefix}-{8 chars}` like kimi's VALID_TASK_ID. Unique even for two tasks
// created in the same millisecond (a bare Date.now() collided).
let seq = 0;
export function newTaskId(prefix = 'task') {
  seq = (seq + 1) % 1e9;
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const s = String(seq).padStart(4, '0');
  return `${prefix}-${(Date.now().toString(36) + s).slice(-8)}-${rand}`;
}

// Decode a task's buffered chunks for display. Buffer chunks (Bash) are UTF-8;
// string chunks (Agent/AgentSwarm) are already text.
//
// Tolerant of a RESTORED task: after a session round-trip the chunks may be
// strings, Buffers, `{type:'Buffer',data:[…]}` objects (what JSON.stringify does
// to a Buffer), or nothing at all. Anything unrecognisable is stringified rather
// than thrown on — a display helper must never be able to take the TUI down, and
// the output panel is exactly where a half-restored task shows up.
function decodeTaskOutput(chunks) {
  if (chunks == null) return '';
  const list = Array.isArray(chunks) ? chunks : [chunks];
  if (!list.length) return '';
  const normalize = (c) => {
    if (Buffer.isBuffer(c)) return c;
    if (c && c.type === 'Buffer' && Array.isArray(c.data)) return Buffer.from(c.data);
    if (typeof c === 'string') return c;
    return String(c);
  };
  const items = list.map(normalize);
  try { return Buffer.concat(items.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8'); }
  catch { return items.map((c) => String(c)).join(''); }
}

// The task store lives on the agent ctx (`ctx.tasks`), so every tool and the TUI
// see the same map.
function store(ctx) {
  if (!ctx) return {};
  if (!ctx.tasks) ctx.tasks = {};
  return ctx.tasks;
}

/**
 * Register a task. `kind` selects the payload group; the returned object is the
 * live record (mutate `status`/`endedAt`/`stopReason` as it runs).
 *
 * options:
 *   description  short human label
 *   detached     true when it runs in the background (Ctrl+B or run_in_background)
 *   timeoutMs    optional cap
 *   command/pid/exitCode            (kind 'process')
 *   agentId/subagentType/model/thinkingEffort  (kind 'agent')
 *   questionCount/toolCallId        (kind 'question')
 *   output       initial output text
 */
export function createTask(ctx, kind, options = {}) {
  const tasks = store(ctx);
  // A teammate is its own kind rather than falling through to 'question': the id prefix is
  // what a reader of a task list uses to tell at a glance what kind of work it is.
  const PREFIX = { process: 'bash', agent: 'agent', teammate: 'mate' };
  const prefix = PREFIX[kind] || 'question';
  const task = {
    taskId: newTaskId(prefix),
    kind,
    description: String(options.description || ''),
    status: 'running',
    detached: options.detached !== false,
    startedAt: Date.now(),
    endedAt: null,
    stopReason: undefined,
    timeoutMs: options.timeoutMs,
    // Output is buffered here and exposed through `output` below. Kept as chunks
    // so the decoder can run lazily (a chatty task costs nothing until read).
    _chunks: options._chunks || [],
    _bytes: 0,
    // THE NOTIFICATION CALLBACK TRAVELS WITH THE TASK.
    //
    // `settleTask` is called from the tool that owns the process and has no ctx to look one up on, so the callback is
    // captured here, where the ctx still is. Absent in a headless run, which is why every use of it is guarded.
    _onDone: ctx && typeof ctx._onBackgroundTaskDone === 'function' ? ctx._onBackgroundTaskDone : null,
  };
  if (kind === 'process') {
    task.command = String(options.command || '');
    task.pid = options.pid || 0;
    task.exitCode = null;
  } else if (kind === 'agent') {
    task.agentId = options.agentId;
    task.subagentType = options.subagentType;
    task.model = options.model;
    task.thinkingEffort = options.thinkingEffort;
  } else if (kind === 'teammate') {
    task.teamName = options.teamName;
    task.memberName = options.memberName;
    task.agentId = options.agentId;
  } else if (kind === 'question') {
    task.questionCount = options.questionCount || 0;
    task.toolCallId = options.toolCallId;
  }
  // WHICH TASK THIS ONE BELONGS TO. A swarm's subagents are tasks of their own so /tasks can show
  // what each is doing, and this is what groups them under the swarm that launched them. Absent
  // for a top-level task, which is the common case.
  if (options.parentTaskId) task.parentTaskId = String(options.parentTaskId);
  // Every task exposes its buffered output through `output`. The chunks are
  // stored raw and decoded lazily:
  //   * a process appends Buffer chunks -> decode as UTF-8
  //   * an agent/swarm appends strings  -> join
  // Callers may override this getter when they need a different decoding.
  defineOutputGetter(task);
  tasks[task.taskId] = task;
  return task;
}

// Install the lazy `output` getter. Extracted so a RESTORED task can have it
// reinstalled: JSON.stringify resolves the getter into a plain string property, so
// a reloaded record carries a frozen snapshot instead of a live view (see
// appendTaskOutput, which repairs both `_chunks` and the getter). `configurable`
// must stay true or the reinstall would throw on an already-defined property.
export function defineOutputGetter(task) {
  Object.defineProperty(task, 'output', {
    enumerable: true,
    configurable: true,
    get() { return decodeTaskOutput(this._chunks); },
  });
  return task;
}

// Cap retained output per task; a runaway command must not exhaust memory.
export const MAX_TASK_OUTPUT_BYTES = 2 * 1024 * 1024;

// Append raw bytes/chunks to a task, trimming the oldest past the cap.
//
// `_chunks` is repaired rather than assumed. The task store is reachable from
// three directions — created in-process, restored with a SESSION
// (`state.tasks`/`ctx.tasks` are copied verbatim into the session JSON and read
// back), and handed around between tools — so a record can arrive here without an
// array. A session round-trip also turns Buffers into `{type:'Buffer',data:[…]}`
// plain objects (JSON has no Buffer), and a record that never produced output can
// come back with no `_chunks` at all.
//
// This matters beyond tidiness: the only production callers are stdout/stderr
// 'data' listeners on a ChildProcess, and a throw inside an event listener is NOT
// caught by the surrounding tool. A missing array therefore surfaces as an
// unhandledRejection that kills the whole TUI mid-tool-call, with nothing printed
// (the exit handler wipes the alternate screen). Both observed shapes —
// "undefined.push" and "null.push" — come from exactly this line.
export function appendTaskOutput(task, chunk) {
  if (!task || chunk == null) return;
  if (!Array.isArray(task._chunks)) {
    // Salvage whatever the old value held: a single chunk, an array-like, or a
    // serialized Buffer object. A Buffer must be revived from its JSON form or the
    // decoder would later try to concat a plain object.
    const prev = task._chunks;
    const revived = [];
    if (prev != null) {
      const items = Array.isArray(prev) ? prev : [prev];
      for (const item of items) {
        if (item && item.type === 'Buffer' && Array.isArray(item.data)) revived.push(Buffer.from(item.data));
        else if (item != null) revived.push(item);
      }
    }
    task._chunks = revived;
    // `_bytes` may be missing too on a restored record; recount from what we kept
    // so the size cap works from here on instead of comparing against undefined.
    task._bytes = revived.reduce((n, c) => n + (c.length || 0), 0);
  }
  // `JSON.stringify` does not preserve the `output` GETTER: it reads the getter and
  // stores the resulting STRING as an ordinary own property. A restored task's
  // `_chunks` is still an array, so the repair above does NOT run for it — but its
  // `output` is a frozen snapshot that no longer tracks `_chunks`, and would keep
  // reporting the pre-save text (or `undefined`) for the rest of the session.
  // Reinstall the live getter whenever the property is a data value rather than an
  // accessor. Checked on every append; after the first repair it is an accessor and
  // this is a cheap no-op.
  try {
    const desc = Object.getOwnPropertyDescriptor(task, 'output');
    if (!desc || !desc.get) {
      if (desc) delete task.output;
      defineOutputGetter(task);
    }
  } catch { /* a frozen record still appends correctly, only its display lags */ }
  task._chunks.push(chunk);
  task._bytes = (task._bytes || 0) + (chunk.length || 0);
  while (task._bytes > MAX_TASK_OUTPUT_BYTES && task._chunks.length > 1) {
    task._bytes -= task._chunks[0].length || 0;
    task._chunks.shift();
  }
}

// Settle a task. `status` is one of the kimi statuses; a task that was already
// stopped keeps 'killed' (mirrors kimi: a deliberate stop must not be relabelled
// as a failure by the process's non-zero exit).
export function settleTask(task, status, extra = {}) {
  if (!task) return;
  // A task that already reached a TERMINAL state must not be relabelled: a
  // deliberate stop ('killed') must not turn into 'failed' when the killed
  // process reports a non-zero exit, and a 'completed' task must not be
  // downgraded by a late error. Only a still-running task settles.
  if (isTerminal(task.status)) {
    if (extra.exitCode !== undefined && task.kind === 'process') task.exitCode = extra.exitCode;
    return;
  }
  task.status = status;
  task.endedAt = Date.now();
  if (extra.stopReason !== undefined) task.stopReason = extra.stopReason;
  if (extra.exitCode !== undefined && task.kind === 'process') task.exitCode = extra.exitCode;
  // NOTIFY — A TASK THAT FINISHES IN THE BACKGROUND MUST SAY SO.
  //
  // Only the subagent path called a callback (`ctx._onBackgroundTaskDone`); a Bash task settled through here and nothing
  // was told. The row sat in /tasks and the transcript never changed, so a command the user backgrounded with Ctrl+B
  // finished silently — they could not tell success from a crash, and the model was never handed the output.
  //
  // The callback lives on the ctx the tools were given, so it is installed by the TUI and absent in a headless run.
  const cb = typeof task._onDone === 'function' ? task._onDone : null;
  if (cb) {
    // After the state is final, and guarded: a broken callback must not undo a settled task.
    try { cb(task); } catch { /* a notification is not worth failing the settle for */ }
  }
}

export function listTasks(ctx) {
  return Object.values(store(ctx));
}

export function getTask(ctx, id) {
  return store(ctx)[id] || null;
}

// Newest-first for display (mirrors kimi's compareTasks: running first, then by
// most recent activity).
export function sortedTasks(ctx) {
  const tasks = listTasks(ctx);
  return tasks.slice().sort((a, b) => {
    const at = isTerminal(a.status), bt = isTerminal(b.status);
    if (at !== bt) return at ? 1 : -1;
    if (!at) return a.startedAt - b.startedAt;
    return (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt);
  });
}

// Human label for a status, matching kimi's STATUS_LABEL.
export const STATUS_LABEL = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  killed: 'killed',
  lost: 'lost',
};

// Colour token for a status (the TUI maps it to a theme colour).
export function statusColor(status) {
  if (status === 'running') return 'green';
  if (status === 'completed') return 'gray';
  return 'red';
}

// ---- background-task transcript card (mirrors kimi-code) --------------------
// A background task reports its lifecycle as a one-line card in the transcript:
//
//     ● agent task completed in background (review the diff)
//     ✗ bash task failed in background (npm test · exit 1)
//
// `phase` drives the bullet colour (started / completed / failed); `headline`
// and the dim `detail` carry the rest. Ported from kimi-code's
// formatBackgroundTaskTranscript (apps/kimi-code/src/tui/utils/background-task-status.ts)
// so the two tools read the same way.

const BG_DETAIL_MAX = 240;

function bgTruncate(value) {
  if (value === undefined || value === null) return undefined;
  const collapsed = String(value).trim().replace(/\s+/g, ' ');
  if (!collapsed) return undefined;
  return collapsed.length <= BG_DETAIL_MAX ? collapsed : collapsed.slice(0, BG_DETAIL_MAX - 1) + '…';
}

export function backgroundTaskPhase(status) {
  if (status === 'running') return 'started';
  if (status === 'completed') return 'completed';
  return 'failed';   // failed / timed_out / killed / lost
}

function bgSubject(kind) {
  if (kind === 'agent') return uiText('agent task');
  if (kind === 'question') return uiText('question task');
  return uiText('bash task');
}

function bgHeadline(status, kind) {
  const subject = bgSubject(kind);
  switch (status) {
    case 'running': return `${subject} ${uiText('started in background')}`;
    case 'completed': return `${subject} ${uiText('completed in background')}`;
    case 'failed': return `${subject} ${uiText('failed in background')}`;
    case 'timed_out': return `${subject} ${uiText('timed out')}`;
    case 'killed': return `${subject} ${uiText('stopped')}`;
    case 'lost': return `${subject} ${uiText('lost')}`;
    default: return `${subject} ${status}`;
  }
}

function bgDetail(task) {
  const parts = [];
  const description = bgTruncate(task.description);
  if (description !== undefined) parts.push(description);

  if (task.status === 'completed' || task.status === 'failed') {
    if (task.kind === 'process' && task.exitCode !== null && task.exitCode !== undefined) {
      parts.push(`exit ${task.exitCode}`);
    }
  }
  if (task.status === 'killed') {
    const reason = bgTruncate(task.stopReason);
    parts.push(reason !== undefined ? `stopped — ${reason}` : 'stopped');
  }
  if (task.status === 'failed') {
    const reason = bgTruncate(task.stopReason);
    if (reason !== undefined) parts.push(reason);
  }
  if (task.status === 'timed_out') parts.push(uiText('timed out'));
  if (task.status === 'lost') parts.push(uiText('session restarted before completion'));

  return parts.length ? parts.join(' · ') : undefined;
}

// Build the card payload for a task snapshot.
export function backgroundTaskCard(task) {
  return {
    phase: backgroundTaskPhase(task.status),
    headline: bgHeadline(task.status, task.kind),
    detail: bgDetail(task),
  };
}
