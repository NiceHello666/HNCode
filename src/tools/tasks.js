// TaskList / TaskOutput / TaskStop / TaskWait — manage background tasks spawned
// by Bash (run_in_background) and Agent (run_in_background). The task records
// live in the shared registry (src/agent-task.js), so the CLI tools and the
// /tasks panel read exactly the same data.

import cp from 'node:child_process';
import { isTerminal, settleTask, STATUS_LABEL } from '../agent-task.js';

function taskLine(t) {
  const extra = t.stopReason ? ` (${t.stopReason})` : '';
  const label = STATUS_LABEL[t.status] || t.status;
  const what = t.kind === 'process' ? (t.description || t.command) : t.description;
  return `#${t.taskId} [${label}${extra}] pid=${t.pid || '-'} ${what}`;
}

export const TaskListSpec = {
  name: 'TaskList',
  description: 'List background tasks (from Bash or Agent run_in_background). Reports task id, status, description.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const tasks = Object.values(ctx.tasks || {}).sort((a, b) => b.startedAt - a.startedAt);
    if (tasks.length === 0) return 'No background tasks.';
    return tasks.map(taskLine).join('\n');
  },
};

export const TaskOutputSpec = {
  name: 'TaskOutput',
  description: 'Read what a background task has printed so far, and its status. Call this FIRST — before TaskWait, and again after it. head_limit caps the lines returned; omit it to see everything.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id returned when the task was started.' },
      head_limit: { type: 'integer', minimum: 0, description: 'Max output lines returned.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const t = (ctx.tasks || {})[args.task_id];
    if (!t) return `No such task: ${args.task_id}`;
    const text = t.output || '';
    const lines = text ? text.split('\n').filter((l) => l.length > 0) : [];
    const capped = args.head_limit ? lines.slice(0, args.head_limit) : lines;
    const tail = lines.length > capped.length;
    const label = STATUS_LABEL[t.status] || t.status;
    const head = `#${t.taskId} [${label}] (pid ${t.pid || '-'})`;
    let out = capped.length ? `${head}\n${capped.join('\n')}` : `${head}\n(no output yet)`;
    if (tail) out += `\n... [${lines.length - capped.length} more lines; use head_limit]`;
    return out;
  },
};

export const TaskStopSpec = {
  name: 'TaskStop',
  description: 'Stop a running background task by task_id. Use only when the task must be cancelled.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task id to stop.' },
      reason: { type: 'string', description: 'Short reason recorded on stop.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const t = (ctx.tasks || {})[args.task_id];
    if (!t) return `No such task: ${args.task_id}`;
    if (isTerminal(t.status)) return `Task ${t.taskId} already ${STATUS_LABEL[t.status] || t.status}.`;
    const reason = args.reason || 'Stopped by TaskStop';
    try {
      // An agent OR teammate task aborts through its controller; a process is killed.
      // Keyed on the handle, not the kind — a teammate task carries `_abort` too
      // (see spawnTeammate), and gating on kind==='agent' left teammates unstoppable.
      if (typeof t._abort === 'function') {
        t._abort();
      } else if (t.pid) {
        if (process.platform === 'win32') {
          try { cp.spawnSync('taskkill', ['/pid', String(t.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
        } else {
          try { process.kill(t.pid, 'SIGTERM'); } catch {}
        }
      }
    } catch (e) {
      return `Failed to stop ${t.taskId}: ${e.message}`;
    }
    // 'killed' — a deliberate stop, distinct from a failure (kimi's vocabulary).
    settleTask(t, 'killed', { stopReason: reason });
    return `Stopped task ${t.taskId}. reason: ${reason}`;
  },
};

/**
 * Write to a background task started with `Bash {interactive: true}`.
 *
 * WHY THIS EXISTS
 * ---------------
 * A background command's stdin is /dev/null by default — deliberately, because leaving it as an open pipe
 * made `cat` and `npm init` block until the timeout. That also meant a command that WANTS input could never
 * be given any: a REPL, a prompt-driven generator, or a server reading commands had no way in.
 *
 * `interactive` opts ONE run into a real pipe and this tool is the other end of it. Both are needed: the
 * flag without the tool leaves a pipe nobody can write to, and the tool without the flag has no pipe to
 * find.
 *
 * ENTER is a parameter rather than something baked into `text`, because a prompt-driven program
 * distinguishes "line entered" from "line still being typed", and a caller sending three lines then a bare
 * Enter should not have to remember to write a trailing newline.
 */
export const TaskInputSpec = {
  name: 'TaskInput',
  description: [
    'Send text to the stdin of a background task started with `Bash {interactive: true}`.',
    '',
    '`text` is written verbatim. `enter` (default true) appends a newline, which is what a prompt-driven',
    'program needs to accept the line; pass `enter: false` to type without submitting.',
    '',
    'The task must still be running: a finished one has no stdin, and this says so rather than pretending',
    'the write landed. Read the reply with TaskOutput.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task id (from Bash with interactive: true).' },
      text: { type: 'string', description: 'Text to write, verbatim.' },
      enter: { type: 'boolean', default: true, description: 'Append a newline so the program accepts the line. False types without submitting.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const t = (ctx.tasks || {})[args.task_id];
    if (!t) return `No such task: ${args.task_id}`;
    if (isTerminal(t.status)) {
      return `Task ${t.taskId} is ${STATUS_LABEL[t.status] || t.status} — it has no stdin to write to.`;
    }
    if (!t.stdin) {
      // The two ways to have no pipe, told apart: the task was never interactive, or its process closed
      // stdin by itself. Naming which one saves a round of guessing.
      return t.interactive
        ? `Task ${t.taskId} closed its stdin — the process is no longer reading input.`
        : `Task ${t.taskId} was not started with \`interactive: true\`, so it has no stdin. Restart it with that flag.`;
    }

    const text = args.text == null ? '' : String(args.text);
    const payload = args.enter === false ? text : `${text}\n`;
    if (!payload) return 'Nothing to write.';

    try {
      // Resolve on the WRITE CALLBACK, not on the return value: `write` returns false when the buffer is
      // full, and the callback fires once the bytes are actually out. Awaiting it is the difference
      // between "we called write" and "the write landed".
      await new Promise((resolve, reject) => {
        t.stdin.write(payload, (err) => (err ? reject(err) : resolve()));
      });
    } catch (e) {
      // EPIPE: the process exited between the status check and the write. Not a failure of the tool.
      t.stdin = null;
      return `Task ${t.taskId} stopped reading input: ${e.message}`;
    }

    return `Wrote ${payload.length} character(s) to ${t.taskId}. Read the reply with TaskOutput.`;
  },
};
// Wait for background tasks to finish. A timeout is not an error; the result
// lists the tasks still running so the caller can wait again.
export const TaskWaitSpec = {
  name: 'TaskWait',
  description: 'Block until a background task finishes, or until the timeout expires. WAITING IS NOT READING: it tells you whether the task is done, not what it did. Read TaskOutput first to see progress, and again afterwards to get the result — usually a task that is still running is better advanced by reading its output than by blocking on it. A timeout is not an error; the still-running tasks are listed so you can decide.',
  parameters: {
    type: 'object',
    properties: {
      timeout: { type: 'integer', minimum: 1, maximum: 600, description: 'Max seconds to wait (1-600).' },
      task_id: { type: 'string', description: 'Task id to wait for; omit to wait for any running task.' },
    },
    required: ['timeout'],
  },
  async execute(args, ctx) {
    const tasks = ctx.tasks || {};
    const target = args.task_id ? tasks[args.task_id] : null;
    if (args.task_id && !target) return `No such task: ${args.task_id}`;
    const secs = Math.max(1, Math.min(600, Number(args.timeout) || 1));
    const deadline = Date.now() + secs * 1000;
    const signal = ctx && ctx.signal;

    const isDone = (t) => t && isTerminal(t.status);
    const anyRunning = () => Object.values(tasks).some((t) => t.status === 'running');

    if (args.task_id) {
      if (isDone(target)) return `Task ${target.taskId} already ${STATUS_LABEL[target.status] || target.status}${target.exitCode != null ? ` (exit ${target.exitCode})` : ''}.`;
    } else if (!anyRunning()) {
      return 'No background tasks are running.';
    }

    await new Promise((resolve) => {
      const tick = setInterval(() => {
        const done = args.task_id ? isDone(target) : !anyRunning();
        if (done || Date.now() >= deadline || (signal && signal.aborted)) {
          clearInterval(tick);
          resolve();
        }
      }, 100);
    });

    if (signal && signal.aborted) return 'Interrupted by user';
    const still = Object.values(tasks).filter((t) => t.status === 'running');
    if (args.task_id) {
      if (isDone(target)) {
        return `Task ${target.taskId} finished: ${STATUS_LABEL[target.status] || target.status}${target.exitCode != null ? ` (exit ${target.exitCode})` : ''}${target.stopReason ? ` — ${target.stopReason}` : ''}.`;
      }
      return `Task ${target.taskId} still running after ${secs}s.`;
    }
    if (!still.length) return 'All background tasks have finished.';
    const list = still.map((t) => `#${t.taskId} ${t.description || t.command || ''}`).join('; ');
    return `Timeout after ${secs}s; still running: ${list}`;
  },
};
