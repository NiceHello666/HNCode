// Ctrl+A selects the composer, and Ctrl+click expands a collapsed paste.
//
// WHY THIS FILE EXISTS
// --------------------
// Two absent gestures, both of which an editor is expected to have.
//
// Ctrl+A: Ctrl+X, Ctrl+C and Ctrl+V all operated on a composer selection that no keyboard gesture could
// create — the only way to select text was to drag with the mouse. `c-a` was already taken INSIDE an
// approval dialog ("approve for the rest of the session"), so the new binding has to stand down while a
// dialog is open.
//
// Ctrl+click on a paste chip: a `[paste #1 +12 lines]` marker stands in for content the user cannot see,
// and the only way to read it back was to delete the chip. The expansion is a DISPLAY change —
// `expandPastes` runs at submit either way — so what is sent is identical, which is the property that
// makes the gesture safe to add.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const { expandPasteMarkerAt, expandPastes, pasteMarker, highlightPasteMarkers, pasteMarkerIdAt } = await import('../src/tui.js');
const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');

// ---------------------------------------------------------------------------
// Ctrl+A
// ---------------------------------------------------------------------------

test('Ctrl+A is bound to select all in the composer', () => {
  // The guard matters: `c-a` means "approve for this session" while a dialog owns the keyboard, and the
  // new binding must not fire there.
  const m = /if \(t\.key === 'c-a' && !state\.approvalPending && !state\.editor\) \{/.exec(src);
  assert.ok(m, 'the select-all branch exists and stands down for a dialog');

  const at = m.index;
  const body = src.slice(at, at + 900);
  assert.match(body, /state\.composerSel = \{ anchor: 0, head: cur\.length \}/,
    'it selects the whole input');
  assert.match(body, /state\.caret = cur\.length/,
    'and leaves the caret at the END, so the next keystroke replaces the selection');
});

test('Ctrl+A says so when there is nothing to select', () => {
  // Doing nothing silently reads as a dead key.
  const at = src.indexOf("if (t.key === 'c-a' && !state.approvalPending");
  const body = src.slice(at, at + 900);
  assert.match(body, /notice\('Nothing to select'/, 'an empty composer reports it');
});

test('the composer selection the key sets is the shape copy and cut expect', () => {
  // One representation: the same `{anchor, head}` a mouse drag produces, so every consumer agrees.
  const at = src.indexOf("if (t.key === 'c-a' && !state.approvalPending");
  assert.match(src.slice(at, at + 900), /anchor: 0, head:/);
  // And the cut path reads exactly those two fields.
  const cut = src.indexOf("if (t.key === 'c-x' || t.key === 'c-s-x')");
  assert.match(src.slice(cut, cut + 500), /sel\.anchor !== sel\.head/);
});

// ---------------------------------------------------------------------------
// Ctrl+click on a paste chip
// ---------------------------------------------------------------------------

const body = 'line one\nline two\nline three\nline four';
const chip = pasteMarker(1, 4);
const INPUT = `please look at ${chip} then continue`;
const CHIP_AT = INPUT.indexOf(chip);

function stateFor(input = INPUT) {
  return { input, caret: 0, pastes: new Map([[1, { text: body, lines: 4, kind: 'paste' }]]), pasteCounter: 1 };
}

test('clicking any character of the chip expands it', () => {
  for (const offset of [0, 1, 9, chip.length - 1]) {
    const s = stateFor();
    assert.equal(expandPasteMarkerAt(s, CHIP_AT + offset), true,
      `offset ${offset} is on the chip`);
    assert.ok(s.input.includes(body), 'the paste text replaced the chip');
    assert.ok(!s.input.includes(chip), 'and the chip is gone');
  }
});

test('clicking away from the chip does nothing', () => {
  // The bounds. A click before the chip must not expand it, and neither must one after.
  for (const idx of [0, CHIP_AT - 1, CHIP_AT + chip.length + 1, INPUT.length]) {
    const s = stateFor();
    assert.equal(expandPasteMarkerAt(s, idx), false, `index ${idx} is off the chip`);
    assert.equal(s.input, INPUT, 'the input is untouched');
  }
});

test('the caret lands after the expanded text', () => {
  // So the next keystroke continues where the paste ends rather than landing inside it.
  const s = stateFor();
  expandPasteMarkerAt(s, CHIP_AT);
  assert.equal(s.caret, CHIP_AT + body.length);
  assert.equal(s.input.slice(s.caret), ' then continue', 'the rest of the line follows the caret');
});

test('what is SENT is identical before and after expanding', () => {
  // The property that makes this safe: the chip was always a display stand-in for this text.
  const s = stateFor();
  expandPasteMarkerAt(s, CHIP_AT);
  assert.equal(expandPastes(s.input, s.pastes), expandPastes(INPUT, s.pastes));
});

test('a click on a marker with no stored paste is refused', () => {
  // The map and the text can disagree — a session restored from disk, say. Refusing beats replacing the
  // chip with nothing.
  const s = { input: INPUT, caret: 0, pastes: new Map(), pasteCounter: 1 };
  assert.equal(expandPasteMarkerAt(s, CHIP_AT), false);
  assert.equal(s.input, INPUT);
});

test('two chips in one input expand independently', () => {
  const two = `${pasteMarker(1, 4)} and ${pasteMarker(2, 2)}`;
  const s = {
    input: two, caret: 0, pasteCounter: 2,
    pastes: new Map([
      [1, { text: 'AAAA', lines: 4, kind: 'paste' }],
      [2, { text: 'BB', lines: 2, kind: 'paste' }],
    ]),
  };
  // The SECOND chip, whose index shifts once the first is expanded.
  const secondAt = two.indexOf(pasteMarker(2, 2));
  assert.equal(expandPasteMarkerAt(s, secondAt), true);
  assert.equal(s.input, `${pasteMarker(1, 4)} and BB`, 'only the second chip expanded');
});

test('the mouse token carries Ctrl from the SGR button bits', () => {
  // Ctrl is bit 16 of the button parameter. Without it the handler cannot tell a Ctrl+click from a plain
  // one, and the expansion would fire on every click or on none.
  assert.match(src, /const ctrl = \(btn & 16\) === 16;/, 'the modifier is decoded');
  assert.match(src, /out\.push\(\{ key: 'mousedown', button: 'left', col: mcol, row: mrow, ctrl \}\)/,
    'and carried on the mousedown token');
  // Hover carries it too, which is what lets the highlight follow a Ctrl-drag rather than a plain move.
  assert.match(src, /out\.push\(\{ key: 'mousehover', col: mcol, row: mrow, ctrl \}\)/,
    'and on the hover token');
});

// ---------------------------------------------------------------------------
// hover on a chip
// ---------------------------------------------------------------------------

test('the chip under the pointer is drawn differently', () => {
  // Without this the chip looks like ordinary text and the gesture is undiscoverable — nothing says it
  // can be clicked at all, let alone with Ctrl.
  const chip = pasteMarker(1, 4);
  const row = `❯ please look at ${chip} then`;
  const plain = highlightPasteMarkers(row, null);
  const hover = highlightPasteMarkers(row, 1);
  assert.notEqual(plain, hover, 'the hovered chip renders differently');
  // Only the hovered one. A second chip in the same row must be untouched.
  const two = `❯ ${pasteMarker(1, 4)} and ${pasteMarker(2, 2)}`;
  const h1 = highlightPasteMarkers(two, 1);
  assert.match(h1, /1m/, 'the hovered chip takes the bright foreground');
  assert.notEqual(h1, highlightPasteMarkers(two, null));
});

test('the hovered chip keeps its background', () => {
  // `C.hover` is a FOREGROUND (bold + bright), not a background, so it goes alongside the chip's own
  // `selBg` rather than replacing it — the two would otherwise fight and the chip would lose its chip-ness.
  const chip = pasteMarker(1, 4);
  const hover = highlightPasteMarkers(`❯ ${chip}`, 1);
  // The colour may be 256-colour (`48;5;n`) or truecolor (`48;2;r;g;b`) depending on the theme, so the pattern
  // takes either form. Pinning it to 256 colours made this fail on every truecolor theme while the behaviour was
  // correct — the chip kept its background exactly as intended.
  assert.match(hover, /48;(?:5;\d+|2;\d+;\d+;\d+)m/, 'the selection background is still there');
  assert.match(hover, /\[49m/, 'and closed with a background reset, not a full reset');
});

test('pasteMarkerIdAt names the chip under the index, and nothing else', () => {
  const chip = pasteMarker(1, 4);
  const input = `please look at ${chip} then continue`;
  const at = input.indexOf(chip);
  assert.equal(pasteMarkerIdAt(input, at - 1), null, 'before the chip');
  assert.equal(pasteMarkerIdAt(input, at), 1, 'on its first character');
  assert.equal(pasteMarkerIdAt(input, at + 8), 1, 'inside it');
  assert.equal(pasteMarkerIdAt(input, at + chip.length), 1, 'on its end, where a click rounds to');
  assert.equal(pasteMarkerIdAt(input, at + chip.length + 1), null, 'after it');
  assert.equal(pasteMarkerIdAt('no chips here', 3), null, 'and nothing when there is no chip');
});

test('the hover cue is a notice that says what to press', () => {
  // The highlight says WHICH; the notice says WHAT a click would do.
  assert.match(src, /notice\('Ctrl\+Click to expand it', 'info'\)/, 'the hint names the gesture');
  // And it is taken DOWN when the pointer leaves, rather than running its own four-second timer.
  assert.match(src, /else clearNotice\(\)/, 'and cleared on the way out');
  assert.match(src, /function clearNotice\(\) \{/, 'clearNotice exists');
});
