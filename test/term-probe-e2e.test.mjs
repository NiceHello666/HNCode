// The TUI must ACT on what the terminal says.
//
//   node tools/check_term_probe.mjs <friendly|hostile|light|silent|typing>
//
// WHY THIS EXISTS
// ---------------
// `src/term-caps.js` has parser unit tests and `term-caps.test.mjs` passes whether or
// not the TUI does anything with the result. The entire value of asking the terminal is
// in the wiring — the synchronized-output wrapper, the Kitty keyboard sequence, and the
// theme that has to match the terminal's background — so this runs the real startup
// against a scripted terminal that answers the queries, then reads back what was
// actually written to stdout.
//
// ONE SCENARIO PER PROCESS. `term-caps.js` holds the detected capabilities in module
// state, and `startTUI` arms timers, takes raw mode and installs stdin handlers; a
// second run in one process would be measuring leftovers from the first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src', 'tui.js');
const CHECK = path.join(import.meta.dirname, '..', 'tools', 'check_term_probe.mjs');
const SCENARIOS = ['friendly', 'hostile', 'light', 'silent', 'typing'];

const readTui = () => fs.readFileSync(SRC, 'utf8');

for (const scenario of SCENARIOS) {
  test(`the terminal's answers drive the TUI: ${scenario}`, () => {
    const run = spawnSync(process.execPath, [CHECK, scenario], { encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0,
      `the TUI ignored what the terminal said:\n${run.stdout || ''}${run.stderr || ''}`);
  });
}

test('the probe runs BEFORE the first paint, and before the alternate screen', () => {
  // Order is the whole point of the light-theme fix: probing afterwards would flash a
  // frame of white-on-white to anyone with a light terminal. The queries have to be
  // written before the first full repaint, and the alternate-screen switch after.
  const src = readTui();
  const probe = src.indexOf('await probeTerminal(');
  const altScreen = src.indexOf('alternateScreen(true)', probe);
  const firstPaint = src.indexOf('renderFrame()', altScreen);
  assert.ok(probe > 0, 'the TUI must probe');
  assert.ok(altScreen > probe, 'the probe must come before the alternate screen is entered');
  assert.ok(firstPaint > altScreen, 'the first paint must come after the alternate screen');
});

test('synchronized output and the Kitty sequence are both gated on the probe', () => {
  // Pinned at the source level so a re-gate cannot quietly become unconditional again.
  const src = readTui();
  assert.ok(/kittyKeysUsable\(\)/.test(src),
    'the Kitty keyboard sequence must be gated on what the terminal reported');
  assert.ok(/syncOutputUsable\(\) \? SYNC_BEGIN : ''/.test(src),
    'the synchronized-output wrapper must be gated on what the terminal reported');
  assert.ok(!/\x1b\[\?2026h'/.test(src.replace(/const SYNC_BEGIN = [^\n]*/, '')),
    'the raw 2026 sequence must not be written anywhere else');
});

test('a key typed during the probe is dispatched, not just buffered', () => {
  // The probe owns stdin while it runs and hands the keys back; seeding them into the
  // key buffer alone would leave them unparsed until the user pressed something else.
  const src = readTui();
  assert.ok(/let keyBuf = probe\.rest \|\| ''/.test(src),
    'the keys the probe handed back must seed the key buffer');
  const drain = /if \(keyBuf\) \{\s*setImmediate/.exec(src);
  assert.ok(drain, 'the seeded keys must be dispatched without waiting for another keystroke');
});