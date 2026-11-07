// A git tool call must be interruptible.
//
// WHY THIS FILE EXISTS
// --------------------
// `git.js` used `runGit`, which is `spawnSync`. That BLOCKS the event loop for the whole command,
// and an AbortSignal cannot fire while the loop is held — measured, `spawnSync` accepts a `signal`
// option and ignores it, waiting out the full timeout.
//
// So while `git log` ran on a large history the TUI was frozen and Esc did nothing, because the
// keypress could not even be read. The log and diff paths allowed 120s, which made that a
// two-minute freeze in the worst case. The tool now calls `runGitAsync` with the turn's signal.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const { runGitAsync } = await import('../src/git.js');
const { spec } = await import('../src/tools/git.js');

const CWD = path.resolve('.');

test('an aborted signal stops the command and says it was interrupted', async () => {
  const ctrl = new AbortController();
  const started = Date.now();
  const p = runGitAsync(['log', '--all', '--format=%H%s'], CWD, { signal: ctrl.signal, timeoutMs: 60000 });
  // Abort on the next tick: the child is spawned but its output is not collected yet, so the interrupt
  // always lands while the command is still running. A fixed delay raced a fast `git log` on a small repo.
  setImmediate(() => ctrl.abort());
  const r = await p;
  assert.equal(r.error, 'interrupted', `the reason is the interrupt, not a timeout: ${r.error}`);
  assert.ok(Date.now() - started < 5000, 'it stopped promptly rather than waiting the timeout out');
});

test('an already-aborted signal does not start the command', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await runGitAsync(['log'], CWD, { signal: ctrl.signal });
  assert.equal(r.error, 'interrupted');
});

test('a timeout is reported differently from an interrupt', async () => {
  // The two are told apart so the caller can say "you stopped it" versus "it hung". A single
  // generic error would lose that.
  const r = await runGitAsync(['log'], CWD, { timeoutMs: 1 });
  assert.equal(r.error, 'git timed out', 'a 1ms budget times out rather than being interrupted');
});

test('without a signal the command still runs normally', async () => {
  // The interrupt support must not have broken the ordinary path.
  const r = await runGitAsync(['rev-parse', '--is-inside-work-tree'], CWD);
  assert.equal(r.ok, true, `git ran: ${JSON.stringify(r).slice(0, 160)}`);
});

test('the Git tool passes the turn signal to git', () => {
  // The link that makes the above reachable from a keypress. Asserted at the source because the
  // tool's `execute` needs a real repository and an abort mid-call.
  const src = fs.readFileSync(path.resolve('src/tools/git.js'), 'utf8');
  const calls = [...src.matchAll(/git\.runGit(?:Async)?\(/g)].map((m) => m[0]);
  assert.ok(calls.length > 0, 'the tool calls into git');
  // Every slow call (log, diff) must be the async form with a signal; the fast ones may stay sync.
  for (const site of ['log', 'diff']) {
    const at = src.indexOf(`case '${site}'`);
    assert.ok(at > 0, `the ${site} case exists`);
    const block = src.slice(at, at + 700);
    if (block.includes('runGit(')) {
      assert.fail(`the ${site} case still uses the blocking runGit`);
    }
    if (block.includes('runGitAsync')) {
      assert.match(block, /signal: ctx && ctx\.signal/, `the ${site} case passes the turn signal`);
    }
  }
});

test('the Git tool reports an interrupt as such', async () => {
  // End to end through the tool: a pre-aborted signal must yield a sentence, not a stack trace.
  const ctrl = new AbortController();
  ctrl.abort();
  const out = String(await spec.execute({ action: 'log', count: 5 }, { workspace: CWD, signal: ctrl.signal }));
  assert.match(out, /Interrupted by user/);
});
