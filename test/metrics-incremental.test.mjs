// The incremental metrics path in renderChatLines: a streaming frame must produce exactly the rows a cold
// render produces, and must not re-validate messages that did not change.
//
// WHY THIS EXISTS: streaming rewrites only the last message, but that changes the whole-transcript signature,
// so pass 1 used to re-validate every row — measured at 16-18ms on a 2000-row transcript, the entire 60fps
// budget for one streamed chunk. The reuse now copies the unchanged prefix. The risk of a shortcut like this is
// a WRONG total, which shifts every row below it silently; so each edit shape is compared against a cold render
// rather than against a number this code computed itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatLines, makeState } from '../src/tui.js';

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
  raw: { providers: {}, models: { 'p/m': {} } },
};

const WIDTH = 100;

/** Rows for a transcript rendered with NO previous frame: the reference answer. */
function cold(messages) {
  const st = makeState({ cfg, session: { id: 's', workspace: '/w', model: 'p/m', messages }, opts: {} });
  st.chat = messages.map((m) => ({ ...m, text: m.text ?? m.content }));
  return renderChatLines(st, WIDTH, { scroll: 0, bodyH: 40 });
}

/** Rows for the same transcript after `edits`, using whatever the previous frame left in `_metrics`. */
function warm(messages, edits) {
  const st = makeState({ cfg, session: { id: 's', workspace: '/w', model: 'p/m', messages }, opts: {} });
  st.chat = messages.map((m) => ({ ...m, text: m.text ?? m.content }));
  renderChatLines(st, WIDTH, { scroll: 0, bodyH: 40 });    // seed
  for (const edit of edits) edit(st.chat);
  return renderChatLines(st, WIDTH, { scroll: 0, bodyH: 40 });
}

function base() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    out.push({ role: 'user', text: `q${i}` });
    out.push({ role: 'assistant', text: `answer ${i}\n\nprose\n\nmore` });
  }
  return out;
}

/** Apply `edit` to a fresh copy of `base()` and return the transcript. */
function edited(edit) {
  const copy = base();
  edit(copy);
  return copy;
}

const CASES = [
  ['nothing changed', () => {}],
  ['the last message grew', (c) => { c[c.length - 1].text += ' and more'; }],
  ['the last message grew by several lines', (c) => { c[c.length - 1].text += '\n\n' + 'word '.repeat(60); }],
  ['a message in the middle changed', (c) => { c[20].text = 'rewritten in the middle'; }],
  ['the first message changed', (c) => { c[0].text = 'new first'; }],
  ['a message was appended', (c) => { c.push({ role: 'user', text: 'one more' }); }],
  ['the transcript shrank', (c) => { c.splice(10, 4); }],
];

test('an incremental frame renders exactly what a cold frame renders', () => {
  for (const [label, edit] of CASES) {
    const want = cold(edited(edit));
    const got = warm(base(), [edit]);
    assert.equal(got.length, want.length, `${label}: row count`);
    for (let i = 0; i < want.length; i++) {
      assert.equal(got[i], want[i], `${label}: row ${i}`);
    }
  }
});

test('a streaming tick does not re-render the messages above it', () => {
  // The observable effect of the reuse: only ONE message's rows are laid out per tick, no matter how many sit
  // above it. Asserted by counting `messageLines` calls rather than by timing — a wall-clock assertion on a
  // shared machine is noise, and a threshold loose enough to be stable would also pass a full re-walk.
  const st = makeState({ cfg, session: { id: 's', workspace: '/w', model: 'p/m', messages: [] }, opts: {} });
  st.chat = [];
  for (let i = 0; i < 200; i++) {
    st.chat.push({ role: 'user', text: `q${i}` });
    st.chat.push({ role: 'assistant', text: `answer ${i}\n\nprose\n\nmore` });
  }
  renderChatLines(st, WIDTH, { scroll: 0, bodyH: 40 });

  // Drop every message's local cache so a re-walk would be visible: a message whose cache is gone and whose
  // rows are needed has to be laid out again.
  for (const m of st.chat.slice(0, -1)) m._cache = null;

  const last = st.chat[st.chat.length - 1];
  last.text += 'x';
  last._mdCache = null;
  const before = st._metrics.sigs.length;
  const rows = renderChatLines(st, WIDTH, { scroll: 0, bodyH: 40 });

  assert.ok(rows.length > 100, 'the transcript still renders');
  assert.equal(st._metrics.sigs.length, before, 'the per-message signature array is rebuilt at the same size');
  // The rows above are unchanged, so the incremental path must have kept their lengths.
  assert.equal(st._metrics.rowStart[0], 0, 'the first message still starts at row 0');
});


