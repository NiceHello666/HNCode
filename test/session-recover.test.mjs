// A session file that does not parse is recovered, not written off.
//
// WHAT THIS GUARDS
// ----------------
// `stringifySession` spliced the message array in with `String.replace(pattern, json)`,
// and a replacement STRING expands `$&`, `` $` ``, `$'` and `$$`. A conversation that
// mentioned `sed s/x/$&/g` spliced a copy of the session's own metadata head into its own
// JSON. The file then failed to parse, `latestSession` fell back to the metadata head, and
// the next save wrote `messages: []` over the history — the conversation was gone, while
// rounds/steps/usage still looked healthy.
//
// What is tested here fails independently:
//   * the WRITE no longer damages the file — a `$` form in a message round-trips;
//   * a file damaged that way LOADS, with its messages, and keeps a `.bak`;
//   * a file damaged across many saves yields every message object that still parses.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-recover-'));
process.env.HNCODE_SESSIONS_DIR = store;

const { saveSession, loadSession } = await import('../src/session.js');
const { recoverSessionText, salvageMessages, sanitizeToolPairs } = await import('../src/session-recover.js');

// The placeholder as it appears INSIDE a JSON string, quotes included: escaped NUL, not a
// raw one. This is also the text `$&` expands to.
const PLACE_QUOTED = '"\\u0000HNCODE_PLACEHOLDER\\u0000"';

const base = {
  id: 'base', title: 'a talk about sed', workspace: '/w', model: 'p/m', createdAt: 1,
  rounds: 12, steps: 40,
  messages: [
    { role: 'user', content: 'how do I keep the matched text?' },
    { role: 'assistant', content: 'In sed a backslash-escaped ampersand does it.' },
  ],
};

// Splice a copy of the metadata head into the middle of a message body, which is the shape
// `` $` `` produced. The bytes are inserted verbatim, so undoing the insertion restores the
// file exactly — an unrecoverable file is built by the salvage test below instead.
function spliceHeadCopy(session, id) {
  saveSession({ ...session, id });
  const file = path.join(store, `${id}.json`);
  const text = fs.readFileSync(file, 'utf8');
  const open = text.indexOf('"messages":');
  const arrayStart = text.indexOf('[', open);
  const head = text.slice(0, arrayStart);
  const bodyStart = text.indexOf('"content":"', arrayStart) + '"content":"'.length;
  const damaged = text.slice(0, bodyStart) + head + text.slice(bodyStart);
  fs.writeFileSync(file, damaged, 'utf8');
  return file;
}

test('a message containing $& round-trips through a real save', () => {
  const id = 'dollar-amp';
  saveSession({ ...base, id, messages: [{ role: 'user', content: 'sed s/x/$&/g' }] });
  const back = loadSession(id);
  assert.ok(back, 'the file loads');
  assert.equal(back.messages.length, 1);
  assert.equal(back.messages[0].content, 'sed s/x/$&/g', 'the text is unchanged, not expanded');
});

test("a message containing $`, $' and $$ round-trips through a real save", () => {
  const id = 'dollar-others';
  const text = "one `$` two, cost $' three, echo $$ four";
  saveSession({ ...base, id, messages: [{ role: 'user', content: text }] });
  const back = loadSession(id);
  assert.ok(back, 'the file loads');
  assert.equal(back.messages[0].content, text);
});

test('a damaged file still loads, with its messages and its metadata', () => {
  const file = spliceHeadCopy(base, 'damaged');
  assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'the fixture really is broken');

  const back = loadSession('damaged');
  assert.ok(back, 'the damaged file still produced a session');
  assert.equal(back.title, 'a talk about sed', 'the metadata survived');
  assert.equal(back.rounds, 12);
  assert.equal(back.messages.length, 2, 'both messages came back');
  assert.equal(back.messages[0].content, base.messages[0].content, 'the text is intact');
});

test('recovering a damaged file keeps the original as .bak', () => {
  const file = spliceHeadCopy(base, 'keep-bak');
  const before = fs.readFileSync(file, 'utf8');
  loadSession('keep-bak');
  assert.ok(fs.existsSync(`${file}.bak`), 'the damaged original is kept');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before, 'byte for byte');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'the file is valid again');
});

test('the expanded placeholder is removed, not left in the text', () => {
  const doc = { ...base, id: 'ph', messages: [{ role: 'user', content: 'a $& b' }] };
  saveSession(doc);
  const file = path.join(store, 'ph.json');
  const text = fs.readFileSync(file, 'utf8');
  // Rebuild what the old write produced: the head, then the array spliced in through a
  // replacement string, which is what turned `$&` into a copy of the placeholder.
  const head = text.slice(0, text.indexOf('[', text.indexOf('"messages":')));
  const array = '[' + doc.messages.map((m) => JSON.stringify(m)).join(',') + ']';
  const broken = head + array.replace('$&', PLACE_QUOTED) + '}';
  fs.writeFileSync(file, broken, 'utf8');
  assert.ok(fs.readFileSync(file, 'utf8').includes(PLACE_QUOTED), 'the fixture carries the expansion');

  const got = recoverSessionText(fs.readFileSync(file, 'utf8'));
  assert.ok(got);
  assert.equal(got.session.messages.length, 1);
  assert.ok(!JSON.stringify(got.session).includes('HNCODE_PLACEHOLDER'));
});

test('an unrecoverable file is still not a session', () => {
  const file = path.join(store, 'rubbish.json');
  fs.writeFileSync(file, 'not json at all', 'utf8');
  assert.equal(recoverSessionText('not json at all'), null);
  assert.equal(loadSession('rubbish'), null);
  assert.ok(!fs.existsSync(`${file}.bak`), 'nothing to keep, so nothing was written');
});

test('salvage keeps every message object that still parses', () => {
  // The shape a file damaged across MANY saves has: real text interleaved with a copy of
  // the head, at offsets no longer known. Only whole objects can be trusted.
  const one = { role: 'user', content: 'one' };
  const two = { role: 'assistant', content: 'two' };
  const text = '{"id":"m","messages":['
    + JSON.stringify(one) + ',{"role":"assistant","content":"half a head ' + PLACE_QUOTED
    + JSON.stringify(two) + ']}';
  const got = salvageMessages(text);
  assert.equal(got.messages.length, 2, 'both intact objects were read out');
  assert.equal(got.messages[0].content, 'one');
  assert.equal(got.messages[1].content, 'two');
  assert.ok(got.dropped >= 1, 'the shredded one was counted, not invented');
});

test('a salvaged list never holds half a tool exchange', () => {
  // A save resumed after the damage keeps the assistant row but can lose the result that
  // answered one of its calls. Every provider rejects the leftover pair, so the salvage
  // drops the unmatched half rather than sending a request that 400s.
  const { messages, orphaned } = sanitizeToolPairs([
    { role: 'user', content: 'go' },
    { role: 'tool', toolCallId: 'no-call', content: 'stray result' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'A', args: {} }, { id: 'b', name: 'B', args: {} }] },
    { role: 'tool', toolCallId: 'a', content: 'kept' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[1].toolCalls.length, 1, 'only the answered call is kept');
  assert.equal(messages[1].toolCalls[0].id, 'a');
  assert.equal(messages[2].toolCallId, 'a');
  assert.equal(orphaned, 2, 'the stray result and the unanswered call were counted');
});
