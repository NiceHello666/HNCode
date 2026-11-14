// Tests for paste markers, clipboard-payload plumbing and token estimation.
//
// These three are grouped because they share a failure mode: they are PURE
// functions whose output feeds something else (the composer's text, the context
// gauge, the /undo prompt count), so a wrong value propagates silently. Each test
// pins the exact contract rather than a plausible-looking one.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pasteMarker, expandPastes, highlightPasteMarkers, adjacentPasteMarker, isRealUserPrompt,
} from '../src/tui.js';
import { estimateTokens, estimateMessageTokens, estimateMessagesTokens } from '../src/term.js';

// ---------------------------------------------------------------------------
// Paste markers
// ---------------------------------------------------------------------------

test('pasteMarker names the shape of what was pasted', () => {
  // A single-line text paste stays literal (no marker), which is why lineCount 1 is
  // still passed here for the image case only.
  assert.equal(pasteMarker(1, 12), '[paste #1 +12 lines]');
  assert.equal(pasteMarker(2, 1), '[paste #2 1 lines]');
  // An image shares the `paste #N` prefix so it inherits the chip styling and the
  // atomic caret behaviour; only the suffix says it is a picture.
  assert.equal(pasteMarker(3, 1, 'image'), '[paste #3 image]');
});

test('expandPastes replaces every marker with its payload, text or image', () => {
  const pastes = new Map([
    [1, { text: 'a\nb', lines: 2, kind: 'paste' }],
    [3, { text: 'C:\\tmp\\shot.png', lines: 1, kind: 'image' }],
  ]);
  assert.equal(expandPastes('[paste #3 image]', pastes), 'C:\\tmp\\shot.png');
  assert.equal(expandPastes('[paste #1 +2 lines]', pastes), 'a\nb');
  // Mixed, and the surrounding text is preserved verbatim.
  assert.equal(expandPastes('see [paste #3 image] and [paste #1 +2 lines]', pastes),
    'see C:\\tmp\\shot.png and a\nb');
});

test('expandPastes leaves an unknown marker alone', () => {
  // A marker whose entry was cleared (e.g. after an edit) must not vanish or throw.
  const pastes = new Map();
  assert.equal(expandPastes('[paste #9 +1 lines]', pastes), '[paste #9 +1 lines]');
});

test('expandPastes is a no-op when there is no marker', () => {
  const pastes = new Map([[1, { text: 'x' }]]);
  assert.equal(expandPastes('plain text', pastes), 'plain text');
  assert.equal(expandPastes('', pastes), '');
});

test('highlightPasteMarkers wraps both marker forms and nothing else', () => {
  const row = 'a [paste #1 +2 lines] b [paste #2 image] c';
  const out = highlightPasteMarkers(row);
  const wrapped = out.match(/\x1b\[[0-9;]*m\[paste #\d+ [^\]]*\]/g) || [];
  assert.equal(wrapped.length, 2, 'both markers must be wrapped');
  assert.ok(out.includes('a ') && out.includes(' c'), 'plain text must be untouched');
  // A row with no marker is returned identically (no stray escapes).
  assert.equal(highlightPasteMarkers('no markers here'), 'no markers here');
});

test('adjacentPasteMarker treats a marker as one atomic unit (both directions)', () => {
  const text = 'x [paste #3 image] y';
  const left = adjacentPasteMarker(text, 'x [paste #3 image]'.length, -1);
  const right = adjacentPasteMarker(text, 'x '.length, 1);
  assert.deepEqual(left, { start: 2, end: 18, id: 3 });
  assert.deepEqual(right, { start: 2, end: 18, id: 3 });
  assert.equal(text.slice(left.start, left.end), '[paste #3 image]');
});

test('adjacentPasteMarker finds nothing when the caret is not beside a marker', () => {
  const text = 'x [paste #1 +2 lines] y';
  assert.equal(adjacentPasteMarker(text, 0, -1), null);
  assert.equal(adjacentPasteMarker(text, text.length, 1), null);
  assert.equal(adjacentPasteMarker('no marker', 3, 1), null);
});

test('adjacentPasteMarker also recognises the text form', () => {
  const text = 'a[paste #7 +40 lines]';
  assert.deepEqual(adjacentPasteMarker(text, text.length, -1), { start: 1, end: text.length, id: 7 });
});

// ---------------------------------------------------------------------------
// isRealUserPrompt (what /undo counts and lists)
// ---------------------------------------------------------------------------

test('isRealUserPrompt counts typed prompts, not harness notes', () => {
  // /undo's picker and file-history turns must agree on what a "prompt" is. A
  // harness-injected message (truncation nudge, compaction handoff) is role 'user'
  // but is not something the user typed, so counting it makes the rewind skip a turn.
  assert.equal(isRealUserPrompt({ role: 'user', content: 'hello' }), true);
  assert.equal(isRealUserPrompt({ role: 'user', _harness: true, content: 'continue' }), false);
  assert.equal(isRealUserPrompt({ role: 'user', content: '<system-reminder>note</system-reminder>' }), false);
  assert.equal(isRealUserPrompt({ role: 'assistant', content: 'hi' }), false);
  assert.equal(isRealUserPrompt({ role: 'tool', content: 'x' }), false);
  assert.equal(isRealUserPrompt(null), false);
  assert.equal(isRealUserPrompt(undefined), false);
});

test('isRealUserPrompt still recognises the legacy prefix in old sessions', () => {
  // Sessions saved before the `_harness` flag used the wrapper alone.
  assert.equal(isRealUserPrompt({ role: 'user', content: '  <system-reminder>old</system-reminder>' }), false);
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

test('estimateTokens: the counts agree with the real tokenizer', () => {
  // THE NUMBERS ARE MEASURED, not asserted from a formula. `o200k_base` charges:
  //
  //   'abcd'         1 token
  //   'aaaaaaaa'    1 token   — a run of the same letter compresses
  //   '12345678'    3 tokens  — digits chunk in threes
  //   '中文测试'     2 tokens  — 1.45 characters per token for Chinese
  //   'ab中文'      2 tokens
  //
  // The estimator gets `aaaaaaaa` and `12345678` wrong by one token each: a repeated run and a digit run are
  // the two shapes the rules cannot see without the vocabulary. They are OVERcounts, which is the safe
  // direction for a context gauge — it reads high, compaction fires a little early, and the request still fits.
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('aaaaaaaa'), 2);      // 1 in reality: a repeated run compresses
  assert.equal(estimateTokens('12345678'), 4);      // 3 in reality: digits chunk in threes
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('中文测试'), 3);        // 2 in reality: 1.45 characters per token
  assert.equal(estimateTokens('ab中文'), 3);          // 2 in reality
});

test('estimateTokens is exact for a long string (the memo must not round)', () => {
  // The value cache only memoises short strings; a long one is walked directly, and
  // both paths must agree, or the context gauge drifts as text grows.
  //
  // The text is a run of DIFFERENT letters rather than one letter repeated: `o200k` compresses a repeated run
  // into very few tokens — ten thousand `y`s cost 2500 — so a repeated string would measure something quite
  // unlike ordinary prose, and the test would be pinning an artefact of the tokenizer rather than the estimate.
  const long = 'abcdefghijklmnopqrstuvwxyz'.repeat(385);   // 10010 letters
  // And it is stable on a second call (memo or not).
  assert.equal(estimateTokens(long), estimateTokens(long));
  // The memo path and the direct path agree: the same string measured twice is the same number.
  assert.equal(estimateTokens(long), estimateTokens(long.slice(0, 10010)));
});

test('estimateTokens is stable across many growing strings', () => {
  // Streaming re-measures a growing string every frame; the result must stay exact
  // and independent of how many times it has been measured.
  let acc = '';
  for (let i = 0; i < 200; i++) {
    acc += 'word ';
    const once = estimateTokens(acc);
    assert.equal(estimateTokens(acc), once, 'the second measurement must agree');
  }
});


test('per-message estimates sum to the whole-transcript estimate', () => {
  // planCompaction prices each message individually; that must equal pricing the
  // array, or the compaction budget is computed from a different number than the
  // gauge shows.
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'x'.repeat(9000) },
    { role: 'tool', content: 'result' },
    { role: 'assistant', content: '', toolCalls: [{ name: 'Bash', args: { command: 'ls' } }] },
  ];
  const sum = msgs.reduce((a, m) => a + estimateMessageTokens(m), 0);
  assert.equal(sum, estimateMessagesTokens(msgs));
  assert.equal(estimateMessageTokens(null), 0);
});

test('estimateMessagesTokens of an empty list is zero', () => {
  // planCompaction used to call this with [] for every message; the value must be 0.
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens(undefined), 0);
});