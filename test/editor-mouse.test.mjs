// The full-screen editor's mouse support: drag-to-select and the right-click menu.
//
// WHY THIS IS A SUBPROCESS TEST: the mouse handlers live inside `startTUI`'s closure, so nothing can call them
// directly. The only honest check is to push real terminal input into a real TUI and read the result off a
// screen model — which is what these two scripts do. They were written because three separate bugs shipped in
// this area (a drag that never reached its handler, a menu with no editor actions, and a menu that would not
// close after a click) while every unit test stayed green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** Run one harness script and return its stdout. */
function run(script, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tools', script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out`)); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('dragging across the editor selects the text under the pointer', async () => {
  const { out } = await run('check_editor_mouse.mjs');
  assert.match(out, /editor opened : yes/, 'the editor opened');
  // The harness drags columns 1..12 of a line holding "hello world this is editable".
  assert.match(out, /selection\s*: cols 0\.\.10 = "hello world"/,
    'the drag must highlight exactly the text it crossed');
});

test('right-clicking the editor offers its own actions', async () => {
  const { out } = await run('check_editor_mouse.mjs');
  for (const label of ['Copy', 'Cut', 'Paste', 'Select all']) {
    assert.match(out, new RegExp(`${label}\\s+present`), `the menu must offer ${label}`);
  }
});

test('the context menu CLOSES after an item is picked', async () => {
  // `onPick` returning undefined left the menu on screen: `openPicker` reads a falsy return as "do not close".
  const { out } = await run('check_menu_close.mjs');
  assert.match(out, /menu open\s*: yes/, 'the menu opened');
  assert.match(out, /menu closed\s*: yes/, 'the menu must close after a pick');
});
