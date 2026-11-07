// A styled span must not end with a bare reset when text follows it.
//
// WHY THIS FILE EXISTS
// --------------------
// `ESC[0m` clears EVERY style. When a chip — a `[paste #N …]` marker, a `**bold**` run — ends with
// one and more text follows, that text loses the foreground its caller had set and falls back to the
// terminal default. The comment above `inlineMarkdown` records the bold case happening for real:
// "plain text after a **bold** run used to lose its colour and fall back to the terminal default".
//
// `highlightPasteMarkers` had the same defect and was missed by that earlier fix: the row read
// `… ESC[48;5;23m [paste #1 +12 lines] ESC[0m and then normal text`, so the tail of the composer
// line came out grey instead of the prompt's colour.
import assert from 'node:assert/strict';
import test from 'node:test';

const { highlightPasteMarkers } = await import('../src/tui.js');
const { C } = await import('../src/colors.js');

/** A row of the composer, as the caller would hand it in. */
const body = (line) => highlightPasteMarkers(line);

test('the chip does not end with a bare reset', () => {
  const out = body('[paste #1 +12 lines] and then normal text');
  assert.ok(out.includes(C.selBg), 'the chip has its selection background');
  const afterChip = out.slice(out.indexOf(']') + 1);
  assert.ok(!afterChip.includes(C.reset),
    `nothing after the chip may carry a bare reset, which would clear the following run: ${JSON.stringify(out)}`);
});

test('the tail keeps whatever colour the caller set', () => {
  // Reconstruct what the composer does: colour the whole line, then chip the marker. String
  // concat means the chip's own escapes land in the middle of that coloured run.
  const line = C.cyan + 'note this ' + C.white + '[paste #1 image]' + C.cyan + ' and more' + C.reset;
  const out = body(line);
  assert.ok(out.includes(C.bgReset), 'the chip closes its own background');
  // The chip must not cancel the cyan that follows it.
  const chipEnd = out.indexOf(']') + 1;
  const tail = out.slice(chipEnd);
  assert.ok(!tail.startsWith(C.reset),
    `the chip must not reset the styles of what follows: ${JSON.stringify(tail.slice(0, 20))}`);
});

test('every marker in a row is chipped, and none leaves a reset behind', () => {
  const out = body('a [paste #1 +2 lines] b [paste #2 image] c');
  // Either 256-colour or truecolor, depending on the theme — the assertion is that BOTH markers got a
  // background, not which encoding carried it. Pinning the exact index made this fail on truecolor while the
  // behaviour was correct.
  assert.equal((out.match(/48;(?:5;\d+|2;\d+;\d+;\d+)/g) || []).length, 2, 'both markers got a background');
  assert.equal((out.match(/\[0m/g) || []).length, 0, 'no bare reset anywhere in the row');
});
test('a row with no marker is returned untouched', () => {

  // The guard has to stay cheap and exact: a row without a marker must not be rewritten at all.
  assert.equal(body('just ordinary text'), 'just ordinary text');
  assert.equal(body(''), '');
});
test('the background is restored, not merely cleared', () => {
  // `C.bgReset` is ESC[49m: close the selection background, leave the foreground alone. That is the
  // distinction the whole file is about, so it is asserted directly rather than inferred.
  const out = body('[paste #1 1 lines] tail');
  assert.ok(out.includes(C.bgReset), 'the chip closes with the background-only reset');
  assert.equal(C.bgReset, '\x1b[49m', 'which is ESC[49m');
  assert.notEqual(C.bgReset, C.reset, 'and not the full reset');
});
