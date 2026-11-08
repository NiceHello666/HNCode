// The PTC sandbox's guarantees, pinned.
//
// WHY THIS FILE EXISTS: the sandbox is the only thing standing between model-written code and the machine. Its
// promises are easy to state and easy to lose in a refactor — an import added at the top of ptc-worker.js, a
// `require` reaching the host, a `while(true)` that hangs the caller. Each one is cheap to check and expensive to
// discover in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runProgrammatic, CALLABLE_TOOLS } = await import('../src/ptc.js');
const { spec } = await import('../src/tools/ptc.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-ptc-test-'));
const ctx = { cwd: dir, workspace: dir, readPool: new Map() };

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('code can call a tool and print, and only the print comes back', async () => {
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(4000) + '\nNEEDLE\n', 'utf8');
  const r = await runProgrammatic([
    "const text = await callTool('Read', { path: 'big.txt' });",
    "print('length ' + String(text).length);",
    "print(String(text).includes('NEEDLE') ? 'found' : 'missing');",
  ].join('\n'), ctx);

  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /length \d+/);
  assert.match(r.output, /found/);
  // The 4KB body stayed in the sandbox; that is the whole point.
  assert.ok(r.output.length < 200, `output should be small, got ${r.output.length} chars`);
  assert.deepEqual(r.calls, ['Read']);
});

test('a tool that is not on the allowlist is refused, not run', async () => {
  const r = await runProgrammatic("await callTool('Bash', { command: 'echo pwned' });", ctx);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not callable from code/);
  // A refusal must not count as a call either.
  assert.deepEqual(r.calls, []);
});

test('the sandbox has no reach to the host', async () => {
  const probes = [
    "print(typeof require)",
    "print(typeof process)",
    "print(typeof module)",
    "print(typeof (await import('node:fs')))",
  ];
  for (const code of probes) {
    const r = await runProgrammatic(code, ctx, { timeoutMs: 8000 });
    const shown = r.ok ? String(r.output).trim() : `ERR ${r.error}`;
    assert.ok(!/^object$|^function$/.test(shown) || /not specified/.test(shown),
      `${code} reached the host: ${shown}`);
  }
});

test('an infinite loop is killed rather than hanging the caller', async () => {
  const started = Date.now();
  const r = await runProgrammatic('while (true) {}', ctx, { timeoutMs: 1200 });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, false);
  assert.match(String(r.error), /timed out/i);
  assert.ok(elapsed < 15000, `should stop near the timeout, took ${elapsed}ms`);
});

test('a syntax error is reported without running anything', async () => {
  const r = await runProgrammatic('const x = ;', ctx);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Syntax error/);
});

test('the tool result reports how many calls ran', async () => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n', 'utf8');
  const out = String(await spec.execute({
    code: [
      "for (const f of ['a.txt', 'b.txt']) await callTool('Read', { path: f });",
      "print('done');",
    ].join('\n'),
  }, ctx));
  assert.match(out, /done/);
  assert.match(out, /\(2 tool calls\)/, 'the saving is stated, and a 0 would mean the code never reached a tool');
});

test('an empty body is refused before a sandbox is started', async () => {
  assert.match(String(await spec.execute({ code: '   ' }, ctx)), /empty/);
});

test('Bash is deliberately absent from the allowlist', () => {
  // A shell inside the sandbox would hand the model the machine and no structure — the opposite of the point.
  assert.ok(!CALLABLE_TOOLS.includes('Bash'));
  assert.ok(!CALLABLE_TOOLS.includes('Write'));
  assert.ok(!CALLABLE_TOOLS.includes('Edit'));
});
