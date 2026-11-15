// /hooks is a REFERENCE: it lists every event the core emits, not only the ones with something configured.
//
// WHY: with an empty config the old panel printed one line — "No hooks configured." — and two file paths, leaving
// the whole screen blank. A reader could not tell what events existed, so the panel did not answer the question
// that made them open it. Claude Code's /hooks lists the full set; this pins that behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describeHooks, HOOK_EVENTS, HOOK_EVENT_HINTS } from '../src/hooks.js';

const lines = (hooks) => describeHooks({ hooks }, path.join(os.homedir(), 'workspace')).join('\n');

test('every event is listed even when nothing is configured', () => {
  const text = lines({});
  for (const ev of HOOK_EVENTS) {
    assert.match(text, new RegExp(`\\b${ev}\\b`), `${ev} must appear`);
    assert.match(text, new RegExp(`${ev}[^\\n]*\\(none\\)`), `${ev} must say it is empty`);
  }
  assert.match(text, /0 hooks configured across 16 events/);
});

test('each event carries a hint, so the panel explains what it is', () => {
  const text = lines({});
  for (const ev of HOOK_EVENTS) {
    assert.ok(HOOK_EVENT_HINTS[ev], `${ev} needs a hint`);
    assert.ok(text.includes(HOOK_EVENT_HINTS[ev]), `${ev}'s hint must be shown`);
  }
});

test('configured hooks show their matcher, command and source', () => {
  const text = lines({
    PreToolUse: [{ command: 'echo check', source: 'project', matcher: 'Bash' }],
    Stop: [{ command: 'notify', source: 'global' }],
  });
  assert.match(text, /2 hooks configured/);
  assert.match(text, /PreToolUse[^\n]*1 configured/);
  assert.match(text, /\[Bash\] echo check/);
  assert.match(text, /\(project\)/);
  assert.match(text, /Stop[^\n]*1 configured/);
  assert.match(text, /notify/);
  assert.match(text, /\(global\)/);
  // The events with nothing are still there.
  assert.match(text, /SessionStart[^\n]*\(none\)/);
});

test('the two config file paths are always shown', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-hooks-'));
  try {
    const text = describeHooks({ hooks: {} }, ws).join('\n');
    assert.match(text, /Global file:/);
    assert.match(text, /Project file:/);
    assert.ok(text.includes(ws), 'the project path uses the workspace the command was run in');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a hand-built hook entry without a timeout still runs', async () => {
  // The TUI-side notifications build their entries by hand, not through loadHooks, so they carry no timeoutMs.
  // An undefined timeout made setTimeout fire immediately and reported "timed out after NaNs" without ever
  // running the command.
  const { runShellHooks } = await import('../src/hooks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-hooks-'));
  const marker = path.join(dir, 'fired.txt');
  try {
    const res = await runShellHooks({ hooks: {
      ConfigChange: [{ command: `echo yes > ${JSON.stringify(marker)}`, source: 'test' }],
    } }, 'ConfigChange', { key: 'theme' }, dir);
    assert.equal(res.blocked, false);
    assert.equal(res.results.length, 1);
    assert.ok(res.results[0].ok, `the hook must run, got ${res.results[0].message}`);
    assert.ok(fs.existsSync(marker), 'the command actually executed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
