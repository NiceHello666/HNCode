// A shell passthrough (`!ls`) typed MID-TURN must not end the turn.
//
// WHY
// ---
// `state.running` is what the Working row, the stall timer, the queue-instead-of-send test and the busy flag all
// read. The shell path used to set it unconditionally and clear it in a `finally`, so an `!ls` during a streaming
// reply looked like the turn had finished: the spinner went red while the model was still producing, and the
// stream kept arriving into a transcript the UI had already settled.
//
// The behaviour lives in a closure (`runShellCommand`), so the invariant is asserted at the source level, on the
// exact statements this function makes — their indentation included, because that is what tells a guarded raise
// from an unconditional one.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
const lines = src.split(/\r?\n/);

/** The body of a `  async function NAME(` declaration inside startTUI. */
function bodyOf(name) {
  const at = lines.findIndex((l) => new RegExp(`^  async function ${name}\\(`).test(l));
  assert.ok(at > 0, `${name} is where this test expects it`);
  for (let i = at + 1; i < lines.length; i++) {
    if (/^  \}/.test(lines[i])) return lines.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

test('the shell passthrough takes state.running only if it is free', () => {
  const body = bodyOf('runShellCommand');
  const text = body.join('\n');
  assert.match(text, /const tookRunning = state\.running !== true/,
    'the flag is read before it is set');
  assert.match(text, /if \(tookRunning\) \{\r?\n\s+state\.running = true;/,
    'the raise is inside the guard');
  assert.match(text, /if \(tookRunning\) state\.running = false;/,
    'and the clear is guarded too');
});

test('no unguarded assignment to state.running remains in the shell path', () => {
  const body = bodyOf('runShellCommand');
  // A statement at the function's own indent (4 spaces) runs unconditionally. Anything deeper is inside a block,
  // which is the only form this function may use now.
  const bare = body.filter((l) => /^ {4}state\.running = (true|false);/.test(l));
  assert.deepEqual(bare, [], `unguarded assignment(s): ${JSON.stringify(bare)}`);
  const raises = body.filter((l) => /^ {6}state\.running = true;/.test(l));
  const clears = body.filter((l) => /^ {6}if \(tookRunning\) state\.running = false;/.test(l));
  assert.equal(raises.length, 1, `one guarded raise, got ${raises.length}`);
  assert.equal(clears.length, 1, `one guarded clear, got ${clears.length}`);
});
