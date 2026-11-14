// Bash tool — mirrors the kimi-code Bash tool schema & behavior.
// Runs commands via PowerShell (pwsh). Supports
// timeout/cwd/run_in_background/disable_timeout. Background tasks are tracked so
// TaskList/TaskOutput can inspect them.

import fs from 'node:fs';
import cp from 'node:child_process';
import { resolvePath, truncateBuf } from './utils.js';
import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';
import { shellSpawnArgs } from './shell.js';

// kimi-code's timeout policy (agent-core-v2/agent/tools/os/bash/bash.ts).
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 5 * 60;
export const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
export const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;



// ---- output sanitizing -------------------------------------------------------
// Captured output can contain terminal control sequences (colours, cursor
// moves, `\r` spinners, bells, …). hncode's renderer passes result strings to
// the terminal verbatim, so a surviving escape fights the differential
// renderer ("text bleeding onto the next row"). It also inflates the token
// count of what we send back to the model. Strip everything a terminal would
// interpret as a command, keeping only `\n` and `\t`.
const OSC_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_RE = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
const ESC_SINGLE_RE = /\u001B(?:[ -/][0-~]|[0-~])/g;
const C0_RE = /[\u0000-\u0008\u000B-\u001F]/g;

export function sanitizeShellOutput(text) {
  const s = String(text ?? '');
  if (!s) return s;
  return s
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(C0_RE, '');
}

// PowerShell emits UTF-8 by default, so decode output as UTF-8.
function decodeBuffer(buf) {
  if (buf.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  }
}

/**
 * Byte budget for a RUNNING command's captured output.
 *
 * `truncateBuf` only runs when the command FINISHES, so the whole run's output
 * sits in memory until then — and a build or a full test suite emits hundreds of
 * megabytes. The ring below keeps only a bounded TAIL while the command runs,
 * which is also the part a reader wants.
 *
 * The HEAD is dropped rather than the tail, and the dropped count is remembered
 * so the finished result can still report it instead of silently looking like a
 * short run.
 */
const LIVE_RING_BYTES = 512 * 1024;

/** Keep only the LAST `limit` bytes of an array of Buffers, in place. Returns
    how many bytes were dropped. */
function trimChunkRing(chunks, limit) {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total <= limit) return 0;
  const dropped = total - limit;
  let drop = dropped;
  while (drop > 0 && chunks.length) {
    const head = chunks[0];
    if (head.length <= drop) { chunks.shift(); drop -= head.length; }
    else { chunks[0] = head.subarray(drop); drop = 0; }
  }
  return dropped;
}

function decodeChunks(chunks) {
  // Tolerant of a restored task: after a session round-trip the chunks are
  // `{type:'Buffer',data:[…]}` objects (JSON has no Buffer) or absent entirely.
  // `Buffer.concat` would throw on either, and this getter runs while the output
  // panel is being drawn — i.e. a throw here takes the TUI down too.
  if (chunks == null) return '';
  const list = Array.isArray(chunks) ? chunks : [chunks];
  if (!list.length) return '';
  const items = list.map((c) => {
    if (Buffer.isBuffer(c)) return c;
    if (c && c.type === 'Buffer' && Array.isArray(c.data)) return Buffer.from(c.data);
    return Buffer.from(String(c));
  });
  try { return decodeBuffer(items.length === 1 ? items[0] : Buffer.concat(items)); }
  catch { return items.map((c) => c.toString('utf8')).join(''); }
}


/**
 * Kill a child.
 *
 * `tree` is OFF for an interactive run, and that is not a style choice: a non-detached interactive child
 * lives INSIDE our process tree, so `taskkill /t` walks up and kills the parent too — the TUI would die
 * while stopping a background command. Both halves are pinned by `test/task-input.test.mjs`.
 *
 * A detached background job has no such risk: it was started as its own tree root, so `/t` reaches its
 * children and nothing above it.
 */
function killTree(child, opts = {}) {
  try {
    const exit = child.exitCode !== null || child.signalCode !== null;
    if (exit || child.killed) return;
    if (process.platform === 'win32') {
      const args = ['/pid', String(child.pid), '/f'];
      if (opts.tree !== false) args.splice(2, 0, '/t');
      try { cp.spawnSync('taskkill', args, { stdio: 'ignore' }); } catch {}
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
  // The SIGKILL follow-up must not keep the process alive on its own: unref it,
  // so a child that exits politely still lets the process quit on time.
  const followUp = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
  if (followUp.unref) followUp.unref();
}

export const spec = {
  name: 'Bash',
  description: 'Run a shell command via pwsh. Returns combined stdout+stderr. timeout default 60s (max 300s); run_in_background detaches and returns a task id.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      description: { type: 'string', description: 'Short description (shown in task lists; required for background tasks).' },
      timeout: { type: 'integer', minimum: 1, description: 'Seconds before the command is killed. Foreground default 60s/max 300s; background default 600s/max 86400s.' },
      cwd: { type: 'string', description: 'Working directory (default: workspace/project root).' },
      run_in_background: { type: 'boolean', default: false, description: 'Run detached and return a task id instead of waiting.' },
      interactive: { type: 'boolean', default: false, description: 'With run_in_background: keep stdin open so TaskInput can write to it — for a command that prompts.' },
      disable_timeout: { type: 'boolean', default: false, description: 'Disable the timeout (background only).' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    if (!args.command || !String(args.command).length) return 'Command cannot be empty.';
    const cwdRaw = args.cwd || ctx.workspace;
    let cwd;
    try { cwd = resolvePath(cwdRaw, ctx); } catch (e) { return e.message; }
    if (!fs.existsSync(cwd)) return `Error: cwd does not exist: ${cwdRaw}`;

    if (args.run_in_background) return spawnBackground(args, cwd, ctx);

    const bg = false;
    const cap = bg ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
    const def = bg ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
    const timeoutMs = args.disable_timeout ? undefined : Math.min(args.timeout ?? def, cap) * 1000;
const command = args.command;
    // stdin is 'ignore' by default (NUL / /dev/null): leaving it as an open pipe made any command that
    // reads stdin (`cat`, `npm init`, …) block until the timeout.
    //
    // `interactive` OPTS INTO A PIPE, and only for a background run: a foreground command has nobody to
    // type at it, while a background one can be fed through TaskInput. The pipe is closed by that tool
    // when it is done, which is what keeps `cat` and friends from hanging.
    if (args.interactive && !args.run_in_background) {
      return 'Error: `interactive` requires `run_in_background: true` — a foreground run has no way to receive input.';
    }
    let shell;
    try { shell = shellSpawnArgs(command); } catch (e) { return `Error: ${e.message}`; }
    // Check the turn's signal BEFORE spawning. The check below ran only after the
    // child existed: an abort landing in that window returned "Interrupted by user"
    // while leaving the child RUNNING with open pipes until the timeout timer fired,
    // and Esc could not stop it.
    if (ctx.signal && ctx.signal.aborted) return 'Interrupted by user';
    const child = cp.spawn(shell.bin, shell.args, {
      cwd, stdio: [args.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env },
    });

    const chunks = [];
    let settled = false;
    // Bytes shed by the live ring, reported on the finished result so a trimmed
    // run does not look like a short one.
    let chunksDropped = 0;
    // Live stream sink: hand decoded output to the agent (ctx.onOutput) so the UI
    // can show a running command's output in real time, exactly like the
    // finished "Used Bash" row does. Foreground runs only — a background task's
    // output is read through TaskOutput.
    //

    //
    // Decoding is STREAMING (a multi-byte char can be split across chunks), and
    // sanitizing runs over complete LINES rather than the whole accumulated text.
    // The old form re-ran the escape regexes over everything received so far on
    // EVERY chunk — O(n²) over the run, plus a fresh full-length string per chunk
    // — which is what made a chatty command slow the process down and double its
    // peak memory.
    //
    // Line-by-line is also what keeps an escape sequence from being cut in half:
    // a sequence never contains a newline, so a complete line is always safe to
    // sanitize, and the trailing partial line waits for more input.
    // THE LIVE STREAM MUST DECODE EXACTLY THE WAY THE FINAL RESULT DOES.
    //
    // The finished output goes through `decodeBuffer`, which tries strict UTF-8 and FALLS BACK TO GBK. The
    // live sink used a plain non-fatal UTF-8 decoder, so a command whose output is not UTF-8 — PowerShell on a
    // Chinese Windows writes GBK for native tools — streamed as replacement characters while it ran and then
    // turned correct the moment it finished. That is the "garbled while running, fine afterwards" report.
    //
    // The live path cannot buffer the whole run, so it decides from the first chunk that proves itself: valid
    // UTF-8 keeps the UTF-8 decoder, anything else pins GBK for the rest of the stream. A chunk boundary
    // through the middle of a multi-byte character looks invalid too, so a failed probe is retried once with
    // the remaining bytes before the encoding is pinned.
    const sink = typeof ctx.onOutput === 'function' ? ctx.onOutput : null;
    let liveDecoder = sink ? new TextDecoder('utf-8') : null;
    let livePending = '';
    let liveUndecided = !!sink;      // the probe has not committed yet
    const push = (d) => {
      chunks.push(d);
      const dropped = trimChunkRing(chunks, LIVE_RING_BYTES);
      if (dropped) chunksDropped += dropped;

      if (!sink || settled) return;
      try {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
        if (liveUndecided) {
          // A trailing partial character makes a valid UTF-8 chunk look invalid. Only a chunk that still
          // fails after its own tail is set aside is evidence.
          let valid = false;
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(buf);
            valid = true;
          } catch {
            // Trim up to three trailing bytes and try once more: that is the longest an incomplete UTF-8
            // sequence can be.
            for (let cut = 1; cut <= 3 && cut < buf.length; cut++) {
              try {
                new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - cut));
                valid = true;
                break;
              } catch { /* keep trimming */ }
            }
          }
          if (!valid) liveDecoder = new TextDecoder('gbk');
          liveUndecided = false;
        }
        // One decoder for the whole stream, in streaming mode: a GBK character is two bytes and will be split
        // across chunks just as often as a UTF-8 one.
        livePending += liveDecoder.decode(buf, { stream: true });
        const nl = livePending.lastIndexOf('\n');
        if (nl < 0) return;
        const complete = livePending.slice(0, nl + 1);
        livePending = livePending.slice(nl + 1);
        const clean = sanitizeShellOutput(complete);
        if (clean) sink(clean);
      } catch { /* display is best-effort; the result below is authoritative */ }
    };
if (child.stdout) child.stdout.on('data', push);
    if (child.stderr) child.stderr.on('data', push);

    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { killTree(child); }, timeoutMs);

    // Esc / Ctrl-C in the TUI aborts the turn: kill the running command too,
    // otherwise a long command keeps running after the user interrupted.
    const signal = ctx.signal;
    const onAbort = () => { killTree(child); };
    if (signal) {
      if (signal.aborted) return 'Interrupted by user';
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    return new Promise((resolve) => {
      // Expose a detach hook so the TUI's ctrl+b can move a long-running
      // foreground command into the background WITHOUT killing it: the child
      // keeps running, gets registered as a task, and this promise resolves
      // immediately with a "moved to background" note so the agent continues.
      if (ctx) {
        // THE HOOK BELONGS TO THE NEWEST FOREGROUND COMMAND. Replacing it here is what makes the identity check
        // above correct: a command that finishes later compares `ctx._foreground.child` against its own child and
        // leaves someone else's hook alone.
        ctx._foreground = {
          command: args.command,
          description: args.description || args.command,
          child, chunks,
          detach: () => {
            if (settled) return null;
            settled = true;
            cleanup();
            // Stop treating this as foreground: drop the abort listener so an
            // Esc after detaching does not kill the now-background task.
            if (signal) signal.removeEventListener('abort', onAbort);
            // AND DROP THE HOOK. `child.on('close')` clears it for a command that finishes on its own, but a
            // detached one resolves HERE and never reaches that path — so the hook stayed set, and a second Ctrl+B
            // called `detach` again, got null, and did nothing at all.
            if (ctx && ctx._foreground && ctx._foreground.child === child) ctx._foreground = null;
            const id = registerBackgroundTask(args, child, ctx, chunks);
            resolve(`Moved to background as task #${id}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${id}"}.`);
            return id;
          },
        };
      }
      child.on('close', (code) => {
        cleanup();
        if (ctx && ctx._foreground && ctx._foreground.child === child) ctx._foreground = null;
        if (settled) return;
        settled = true;
        // Flush the last partial line the live sink was holding back.
        if (sink && livePending) {
          try { sink(sanitizeShellOutput(livePending)); } catch { /* best-effort */ }
          livePending = '';
        }
        if (signal && signal.aborted) { resolve('Interrupted by user'); return; }
        let out = truncateBuf(sanitizeShellOutput(decodeChunks(chunks)));
        // A trimmed run says so; otherwise the result would look complete while
        // quietly missing its head.
        if (chunksDropped) out = `...[dropped ${chunksDropped} bytes of earlier output]\n` + out;
        out += `\n[exit code: ${code === null ? 'killed' : code}]`;
        resolve(out);
      });
      child.on('error', (e) => {
        cleanup();
        // Same identity check as `close`: a failing command must not take another command's hook with it.
        if (ctx && ctx._foreground && ctx._foreground.child === child) ctx._foreground = null;
        if (settled) return;
        settled = true;
        resolve(truncateBuf(sanitizeShellOutput(decodeChunks(chunks))) + `\n[error: ${e.message}]`);
      });
    });
  },
};

// Register an already-spawned child (foreground -> background detach) as a task.
// Reuses the same task shape and lazy output decoding as spawnBackground. The
// foreground path's existing stdout/stderr listeners keep writing into the SAME
// `existingChunks` array the task reads, so we must NOT add new listeners here
// (doing so doubled every line of output).
function registerBackgroundTask(args, child, ctx, existingChunks) {
  const task = createTask(ctx, 'process', {
    description: args.description || args.command,
    command: args.command,
    pid: child.pid,
    detached: true,
    _chunks: existingChunks || [],
  });
  defineOutput(task);
  child.on('close', (code) => {
    // A task already settled (TaskStop -> 'killed') keeps its status; the
    // process's non-zero kill exit must not relabel a deliberate stop.
    if (task.status === 'running') {
      settleTask(task, code === 0 ? 'completed' : 'failed', { exitCode: code });
    } else {
      task.exitCode = code;
    }
  });
  return task.taskId;
}

function spawnBackground(args, cwd, ctx) {
  const command = args.command;
  // Detached + piped stdio is not a real detach: when the parent exits, the
  // pipes close and the child gets SIGPIPE. Redirect stdout/stderr to the
  // task's output file instead, so the process survives and TaskOutput can
  // still read it. (In the TUI the parent rarely exits, but headless -p mode
  // does, and a background job should outlive the prompt.)
  //
  // AN INTERACTIVE RUN CANNOT BE DETACHED. Measured on Windows: `detached: true` with piped stdout
  // returns exit 0 and NO output, while the same command not detached returns its output normally — the
  // detached process gets no working pipe back to us. Interactive needs that pipe in both directions, so
  // it stays attached. The trade: it will not outlive the parent, which is the same lifetime its stdin
  // already has.
  let shell;
  try { shell = shellSpawnArgs(command, { interactive: args.interactive }); } catch (e) { return `Error: ${e.message}`; }
  const child = cp.spawn(shell.bin, shell.args, {
    cwd, detached: !args.interactive, stdio: [args.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
  const task = createTask(ctx, 'process', {
    description: args.description || args.command,
    command: args.command,
    pid: child.pid,
    detached: !args.interactive,
  });
  // The stdin pipe, when the caller asked for one. Kept on the TASK so `TaskInput` can reach it from a
  // task id alone — a tool receives an id, not a handle. Only `interactive` gets here, so a plain
  // background job is unaffected and cannot be fed input by accident.
  if (args.interactive && child.stdin) {
    task.stdin = child.stdin;
    task.interactive = true;
    // A closed pipe is normal at the end of a run; writing afterwards would throw EPIPE.
    child.stdin.on('error', () => { task.stdin = null; });
    child.on('close', () => { task.stdin = null; });
  }
  defineOutput(task);
  const push = (d) => appendTaskOutput(task, d);
  if (child.stdout) child.stdout.on('data', push);
  if (child.stderr) child.stderr.on('data', push);
  child.on('close', (code) => {
    if (task.status === 'running') {
      settleTask(task, code === 0 ? 'completed' : 'failed', { exitCode: code });
    } else {
      task.exitCode = code;
    }
  });
  // Background timeout: default 600s, capped at 86400s; `disable_timeout` removes
  // it. The timer is unref'd so it never keeps the process alive on its own.
  if (!args.disable_timeout) {
    const bgTimeoutMs = Math.min(args.timeout ?? DEFAULT_BACKGROUND_TIMEOUT_S, MAX_BACKGROUND_TIMEOUT_S) * 1000;
    const t = setTimeout(() => {
      killTree(child);
      settleTask(task, 'timed_out', { stopReason: 'timed out' });
    }, bgTimeoutMs);
    if (t.unref) t.unref();
  }
  child.unref();
  return `Background task ${task.taskId} started (pid ${child.pid}): ${args.description || args.command}
Inspect with TaskList (running tasks) and TaskOutput {task_id: "${task.taskId}"} (output).`;
}

// Lazy output: the accumulated bytes are decoded only when actually read, so a
// chatty background task costs nothing until queried.
function defineOutput(task) {
  Object.defineProperty(task, 'output', {
    enumerable: true,
    get() { return sanitizeShellOutput(decodeChunks(this._chunks)); },
  });
}
