// A session that already has a name must never be renamed by the auto-namer, and the namer must not overwrite a
// name typed while its request was in flight.
//
// WHY THIS NEEDS ITS OWN FILE
// ---------------------------
// The gate is `!session.title`, and THREE surfaces can write that field: `/title`, the title band, and the namer
// itself. Reading the gate alone does not prove any of them is honoured, and the in-flight case cannot be seen in
// the gate at all — the check happens before a request that takes seconds, so the answer can arrive after the name
// has been set by hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
const lines = src.split(/\r?\n/);

test('the auto-namer only runs for an UNNAMED session', () => {
  const at = lines.findIndex((l) => /const needsTitle = /.test(l));
  assert.ok(at > 0, 'the gate is where this test expects it');
  const gate = lines.slice(at, at + 2).join(' ');
  assert.match(gate, /!session\.title/, 'an existing name blocks the naming request');
  assert.match(gate, /cfg\.autoTitle !== false/, 'and the setting can block it too');
});

test('the namer re-checks the name before writing, so an in-flight rename wins', () => {
  const fn = lines.findIndex((l) => /async function generateTitle\(/.test(l));
  assert.ok(fn > 0, 'generateTitle is where this test expects it');
  let to = lines.length;
  for (let i = fn + 1; i < lines.length; i++) {
    if (/^  }/.test(lines[i])) { to = i; break; }
  }
  const body = lines.slice(fn, to).join('\n');
  const write = body.indexOf('session.title = title');
  assert.ok(write > 0, 'the assignment is in this function');
  // The guard has to sit between the request and the write — anywhere earlier is before the answer exists, and
  // anywhere later is after the name is already gone.
  const before = body.slice(0, write);
  const guard = before.lastIndexOf('if (session.title) return;');
  assert.ok(guard > 0, 'the name is re-checked immediately before it is written');
  assert.ok(before.slice(guard).length < 400, 'and the check is adjacent to the write, not far above it');

  // The request itself must come before the guard, or the guard would be protecting a name nothing had asked for.
  const request = before.indexOf('await llm.requestText(');
  assert.ok(request > 0 && request < guard, 'the check follows the request');
});
