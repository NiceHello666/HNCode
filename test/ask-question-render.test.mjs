// AskUserQuestion must RENDER for every shape it accepts.
//
// WHY THIS EXISTS: a short-circuit bug shipped in 0.6.3. `showHint` was declared inside one branch and read
// from another, guarded by `!cur.freeText && ... showHint`. `&&` evaluates left to right, so for an ORDINARY
// question the left side was true and the right side threw ReferenceError — and the process handler turns that
// into exit(1). The whole TUI died the moment a model asked a normal question. The free-text case survived,
// which is exactly why it passed review: the one shape that was tested was the one that did not crash.
//
// Rendering each shape and asserting nothing throws is the check that would have caught it.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

const tui = await import('../src/tui.js');

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: os.tmpdir(),
  raw: { providers: {}, models: { 'p/m': {} } },
};

const OPTIONS = [{ label: 'Alpha', description: 'first' }, { label: 'Beta', description: 'second' }];

/** Render one question and return the frame with escapes removed. */
function renderQuestion(question) {
  const st = tui.makeState({
    cfg, session: { id: 's', workspace: os.tmpdir(), model: 'p/m', messages: [] }, opts: {},
  });
  st.chat = [];
  st.question = {
    items: [question], index: 0, sel: 0, picked: new Set(), answers: {},
    editing: null, editingText: '', editingCaret: 0, otherText: '', supplement: '', resolve: () => {},
  };
  return tui.composeFrame(st, 80, 24).lines
    .map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, ''))
    .join('\n');
}

test('a single-select question renders with its option list and hint', () => {
  const painted = renderQuestion({ question: 'Pick one?', header: 'A', options: OPTIONS });
  assert.match(painted, /Alpha/, 'the options are listed');
  assert.match(painted, /Enter select/, 'and the keyboard hint is shown');
});

test('a multi-select question renders with its own hint', () => {
  const painted = renderQuestion({ question: 'Pick many?', header: 'B', options: OPTIONS, multiSelect: true });
  assert.match(painted, /Alpha/);
  assert.match(painted, /Space toggle/, 'the multi-select hint names the toggle key');
});

test('a free-text question renders a field and no option list', () => {
  const painted = renderQuestion({ question: 'Name it?', header: 'C', options: [], freeText: true });
  assert.match(painted, /Name it\?/, 'the question is shown');
  assert.match(painted, /type your answer/, 'the field carries its placeholder');
  assert.doesNotMatch(painted, /Other/, 'and there is no option list beside it');
});
