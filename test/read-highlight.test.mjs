import assert from 'node:assert/strict';
import test from 'node:test';
import { composeFrame, makeState } from '../src/tui.js';
import { C } from '../src/colors.js';

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function frameFor(toolName, file, text) {
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', workspace: '/w',
    maxContextTokens: 100000, raw: { providers: {}, models: { 'p/m': {} } },
  };
  const state = makeState({ cfg, session: { id: 's', messages: [] }, opts: {} });
  state.chat = [
    { role: 'tool', toolName, toolArgs: { path: file }, pending: false },
    // `readPath` is the field the tool_result handler sets, and it is set ONLY for Read: the renderer colours
    // the numbered lines when the result carries a path, and every other tool leaves it empty.
    { role: 'tool_result', toolName, readPath: toolName === 'Read' ? file : '', text },
  ];
  return composeFrame(state, 100, 30).lines.map(String);
}

test('Read source rows use the file language without colouring the header or changing the model result', () => {
  const rows = frameFor('Read', 'sample.js', 'sample.js (lines 1-2 of 2)\n1\tconst value = 42;\n2\t// note\n');
  assert.ok(rows.some((r) => /1\s+const value = 42;/.test(plain(r)) && r.includes(C.cyan)));
  assert.ok(rows.some((r) => /2\s+\/\/ note/.test(plain(r)) && r.includes(C.comment)));
  assert.ok(rows.some((r) => plain(r).includes('sample.js (lines 1-2 of 2)') && !r.includes(C.cyan)));
});

test('unknown Read file and non-Read output stay uncoloured', () => {
  const content = 'sample.unknown (lines 1-1 of 1)\n1\tconst value = 42;\n';
  for (const [tool, file] of [['Read', 'sample.unknown'], ['Bash', 'sample.js']]) {
    const rows = frameFor(tool, file, content);
    assert.ok(rows.some((r) => plain(r).includes('const value = 42;') && !r.includes(C.cyan)), tool);
  }
});
