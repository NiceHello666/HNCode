// TaskInput: the model can drive a background command's stdin.
//
// WHY THIS FILE EXISTS
// --------------------
// A background command's stdin is /dev/null by design — leaving it as an open pipe made `cat` and
// `npm init` block until the timeout. That decision also meant a command that WANTS input could never be
// given any: a REPL, a prompt-driven generator, a server reading commands.
//
// Three separate things had to be true, and each was broken on its own:
//
//   1. `Bash {interactive: true}` must open a stdin pipe (it was `ignore`).
//   2. The tool must be able to reach that pipe from a task id alone.
//   3. The task must NOT be detached — measured on Windows, `detached: true` with piped stdout returns
//      exit 0 and NO output at all, so an interactive run would be deaf and mute.
//
// The tests below drive a real child process. Nothing is mocked: the pipe is the process's own stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-tinput-'));
process.env.HNCODE_HOME = HOME;

const bash = (await import('../src/tools/bash.js')).spec;
const { TaskInputSpec } = await import('../src/tools/tasks.js');

const ctx = { tasks: {}, cwd: process.cwd(), workspace: process.cwd() };

/**
 * Start a child that echoes each stdin line, and exits on "quit".
 *
 * Plain `data` handlers rather than `readline`: the child runs inside PowerShell, and a throw there
 * (a missing module, a path quirk) means it exits with no output at all — which looks exactly like the
 * pipe being broken. Fewer moving parts keeps a failure pointing at the tool.
 */
function startEcho() {
  const script = [
    "process.stdin.setEncoding('utf8');",
    "let buf = '';",
    "process.stdin.on('data', (d) => {",
    "  buf += d;",
    "  let i;",
    "  while ((i = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
    "    if (line === 'quit') process.exit(0);",
    "    process.stdout.write('echo:' + line + '\\n');",
    "  }",
    "});",
    "process.stdin.resume();",
  ].join('\n');
  const file = path.join(HOME, `echo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
  fs.writeFileSync(file, script);
  return `node "${file}"`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the flag
// ---------------------------------------------------------------------------

test('interactive refuses a foreground run', async () => {
  // A foreground command has nobody to type at it; opening a pipe there would only risk the deadlock the
  // /dev/null default exists to prevent.
  const r = await bash.execute({ command: 'echo hi', interactive: true }, ctx);
  assert.match(String(r), /requires `run_in_background/);
});

test('an interactive task has a stdin pipe; a plain one does not', async () => {
  const a = await bash.execute({ command: startEcho(), run_in_background: true, interactive: true }, ctx);
  const aId = Object.keys(ctx.tasks)[0];
  assert.ok(ctx.tasks[aId].stdin, 'interactive opens a pipe');
  void a;

  await bash.execute({ command: 'echo plain', run_in_background: true }, ctx);
  const plainId = Object.keys(ctx.tasks).find((k) => k !== aId);
  assert.equal(ctx.tasks[plainId].stdin, undefined, 'a plain background task gets none');
});

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

test('text reaches the process, and Enter is what delivers it', async () => {
  await bash.execute({ command: startEcho(), run_in_background: true, interactive: true }, ctx);
  const id = Object.keys(ctx.tasks).slice(-1)[0];
  // Wait for the child to be reading, not for a fixed 400ms. The task is ready when it has a stdin pipe;
  // a short settle then covers the gap between the pipe existing and the script subscribing to it.
  for (let i = 0; i < 60 && !ctx.tasks[id].stdin; i++) await wait(50);
  await wait(200);

  await TaskInputSpec.execute({ task_id: id, text: 'hello' }, ctx);
  await TaskInputSpec.execute({ task_id: id, text: 'world', enter: false }, ctx);
  // Poll for the echo instead of sleeping: the write has to travel through a pipe and back as stdout.
  for (let i = 0; i < 60 && !/echo:hello/.test(String(ctx.tasks[id].output || '')); i++) await wait(50);

  let out = String(ctx.tasks[id].output || '');
  assert.match(out, /echo:hello/, 'the first line round-tripped');
  assert.doesNotMatch(out, /echo:world/, 'a write without Enter is not delivered yet');

  await TaskInputSpec.execute({ task_id: id, text: '' }, ctx);
  for (let i = 0; i < 60 && !/echo:world/.test(String(ctx.tasks[id].output || '')); i++) await wait(50);
  out = String(ctx.tasks[id].output || '');
  assert.match(out, /echo:world/, 'and lands once Enter arrives');
});

test('an unknown task is refused by name', async () => {
  const r = await TaskInputSpec.execute({ task_id: 'nope', text: 'x' }, ctx);
  assert.match(String(r), /No such task: nope/);
});

test('a task without a pipe says WHY, not just "failed"', async () => {
  // The two causes are different and a caller cannot guess between them.
  await bash.execute({ command: 'echo plain', run_in_background: true }, ctx);
  const id = Object.keys(ctx.tasks).slice(-1)[0];
  await wait(300);
  const r = await TaskInputSpec.execute({ task_id: id, text: 'x' }, ctx);
  // It may have finished already, which is the other honest answer.
  assert.match(String(r), /interactive: true|is (completed|failed|killed)/);
});

test('a finished task is refused rather than silently accepted', async () => {
  const r = await bash.execute({ command: 'echo done', run_in_background: true, interactive: true }, ctx);
  void r;
  const id = Object.keys(ctx.tasks).slice(-1)[0];
  // Wait for the task to actually reach a terminal state: `echo done` exits on its own, but the exit signal
  // lands at whatever speed the machine allows, and a fixed sleep raced it under a parallel test run.
  for (let i = 0; i < 60 && ctx.tasks[id] && !["completed", "failed", "killed"].includes(ctx.tasks[id].status); i++) {
    await wait(50);
  }
  const out = await TaskInputSpec.execute({ task_id: id, text: 'x' }, ctx);
  assert.match(String(out), /no stdin|is completed|closed its stdin/);
});

// ---------------------------------------------------------------------------
// the detach hazard
// ---------------------------------------------------------------------------

test('an interactive task is NOT detached', () => {
  // Measured: `detached: true` with piped stdout returns exit 0 and no output on Windows, so an
  // interactive run would be deaf and mute. The source is pinned because the failure is invisible —
  // the command "succeeds" and prints nothing.
  const src = fs.readFileSync(path.resolve('src/agent.js'), 'utf8') && fs.readFileSync(path.resolve('src/tools/bash.js'), 'utf8');
  assert.match(src, /detached: !args\.interactive/, 'the spawn opts out of detach when interactive');
});

test('the shell is not started with -NonInteractive', () => {
  // PowerShell in non-interactive mode closes stdin immediately, so the child reads EOF and exits before
  // anything can be written. The flag has to come off for the pipe to mean anything.
  const src = fs.readFileSync(path.resolve('src/tools/shell.js'), 'utf8');
  assert.match(src, /if \(!opts\.interactive\) args\.push\('-NonInteractive'\)/);
});

test.after(async () => {
  // Let each child go before removing the directory.
  //
  // The write is PROBED, not attempted blind: a task whose process has already exited has a closed
  // stream, and writing to it emits an 'error' event — an unhandled one fails the whole run even though
  // every test passed. `writableEnded`/`destroyed` answer that without producing an event at all.
  for (const t of Object.values(ctx.tasks)) {
    const s = t.stdin;
    if (!s || s.destroyed || s.writableEnded) continue;
    try { s.write('quit\n'); } catch { /* closed between the check and the write */ }
  }
  await new Promise((r) => setTimeout(r, 150));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* a live child still holds it */ }
});
