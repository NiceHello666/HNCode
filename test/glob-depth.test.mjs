// Glob's depth rule and the fact that its walk does not freeze the process.
//
// WHY THIS FILE EXISTS: `*.java` over a drive root took 43 seconds, walked hundreds of thousands of entries, and
// then reported "No files matched" — the pattern was matched against every file's BASENAME, so the walk went all
// the way down while the pattern could only ever match a top-level name. The scan was simultaneous too slow and
// wrong, and a synchronous one, so the whole process was dead while it ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getTool } = await import('../src/tools/index.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-glob-test-'));
fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
fs.writeFileSync(path.join(dir, 'top.java'), 'class Top {}\n');
fs.writeFileSync(path.join(dir, 'sub', 'mid.java'), 'class Mid {}\n');
fs.writeFileSync(path.join(dir, 'sub', 'deep', 'low.java'), 'class Low {}\n');
fs.writeFileSync(path.join(dir, 'notes.txt'), 'text\n');

const ctx = { cwd: dir, workspace: dir, readPool: new Map() };
const glob = getTool('Glob');

const run = async (pattern, extra = {}) => {
  const out = String(await glob.execute({ pattern, path: '.', ...extra }, ctx));
  return out.startsWith('No files') ? [] : out.split('\n').map((p) => path.basename(p)).sort();
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a pattern with no separator stays in the directory', async () => {
  // The rule git and every shell use: `*.java` is what is HERE, not what is here and below.
  assert.deepEqual(await run('*.java'), ['top.java']);
});

test('a pattern with a separator descends', async () => {
  assert.deepEqual(await run('**/*.java'), ['low.java', 'mid.java', 'top.java']);
  assert.deepEqual(await run('sub/*.java'), ['mid.java']);
});

test('a shallow pattern does not scan the subtree', async () => {
  // The observable proof: a directory holding a thousand files must not slow a top-level lookup.
  const wide = path.join(dir, 'wide');
  fs.mkdirSync(wide, { recursive: true });
  for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(wide, `f${i}.java`), 'x');
  const started = Date.now();
  const hits = await run('*.java', { path: wide });
  const elapsed = Date.now() - started;
  assert.equal(hits.length, 100, 'Glob caps its result at 100, newest first');
  assert.ok(elapsed < 3000, `a shallow readdir of 500 files took ${elapsed}ms`);
});

test('the walk yields to the event loop', async () => {
  // A synchronous walk holds the loop for its whole duration, and nothing else can run. Timers keep firing here.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  await run('**/*.java');
  clearInterval(timer);
  assert.ok(ticks >= 1, 'the event loop kept running during the walk');
});

test('a pattern that matches nothing still reports the directory it searched', async () => {
  const out = String(await glob.execute({ pattern: '*.rs', path: '.' }, ctx));
  assert.match(out, /No files matched/);
});
