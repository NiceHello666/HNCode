// Selecting a chat row must not include its left margin.
//
// WHY THIS FILE EXISTS
// --------------------
// Every chat row is drawn with one column of left margin — the `PAD` the renderer prepends — so a drag
// that begins at the left edge of the text paints that space too. Copying a reply then puts a leading
// space on the clipboard, on every line of a multi-paragraph answer.
//
// THE RULE IS ONE COLUMN, ALWAYS. An earlier attempt measured a per-row "indent width" and skipped all
// of it: a tool row's ` ● ` bullet, a user box's `│ > ` wall. That was wrong, and the tests below say so.
// Those columns are part of what the row DRAWS, and a selection beginning on one of them is a selection
// the user made deliberately. The margin is different only because it is not content at all — so the
// rule is "column 0 is never selection", applied to every row whatever sits there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFrame, renderChatLines } from '../src/tui.js';
import { C } from '../src/colors.js';

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The visual columns of a row carrying a selection BACKGROUND.
 *
 * Walked character by character so the escape parameter is READ rather than pattern-matched on the
 * finished string: a row holds several backgrounds, and only `48;...` is the selection.
 */
function selectedColumns(row) {
  const s = String(row);
  const cols = [];
  let col = 0;
  let inSel = false;
  let i = 0;
  // The selection colour, in RGB. A plain row is painted with exactly this; a diff row is painted with a blend
  // of this and its own red/green wash, so the test accepts a colour that LEANS towards the selection rather
  // than demanding an exact match.
  const sel = /48;2;(\d+);(\d+);(\d+)/.exec(C.selBg);
  const selRgb = sel ? [Number(sel[1]), Number(sel[2]), Number(sel[3])] : null;
  const isSel = (rgb) => {
    if (!rgb || !selRgb) return false;
    // A blend keeps seven parts of the selection colour, so it stays within a small distance of it. The diff
    // washes are far away (dark red / dark green), which is what makes this a reliable discriminator.
    return Math.abs(rgb[0] - selRgb[0]) + Math.abs(rgb[1] - selRgb[1]) + Math.abs(rgb[2] - selRgb[2]) < 120;
  };
  while (i < s.length) {
    const m = /^\x1b\[([0-9;]*)m/.exec(s.slice(i));
    if (m) {
      const p = m[1];
      const bg = /48;2;(\d+);(\d+);(\d+)/.exec(p);
      if (bg) inSel = isSel([Number(bg[1]), Number(bg[2]), Number(bg[3])]);
      else if (p === '49' || p === '0') inSel = false;
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i);
    if (inSel) cols.push(col);
    col += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return cols;
}

/**
 * Render one message under a selection, and hand back the line matching `re`.
 *
 * The selection is placed on the row the message ACTUALLY lands on, found first. A user message is
 * drawn in a box, so its content row is several rows down — anchoring every case at row 0 selected
 * nothing for it, and the assertion then read as a failure of the rule rather than of the test.
 *
 * One row only: a cross-row drag makes `c1` infinite, which is a separate case where a zero-width
 * selection still paints to the end of the line.
 */
function rowFor(msg, re, { col0 = 0, col1 = 50 } = {}) {
  const base = {
    chat: [msg], cwd: process.cwd(), cfg: { shimmerEdge: 'cosine' }, queued: [], todos: [],
    running: false, spin: 0, _forceFullRender: true,
  };
  const plain = composeFrame(base, 60, 30);
  const bare = (Array.isArray(plain) ? plain : plain.lines || []).map(String);
  const screenRow = bare.findIndex((l) => re.test(strip(l)));
  assert.ok(screenRow >= 0, `the row matching ${re} is present`);

  // The TRANSCRIPT row carrying that text — found from the same rows the painter sees, because a
  // message's rows are not one-to-one with messages: a user message is a three-row box whose content
  // sits on row 1. Selecting row 0 highlighted the top border and left the text alone, which read as a
  // broken rule rather than a mis-targeted test.
  //
  // Two coordinate systems meet here: `state.selection` carries TRANSCRIPT rows (`mouseToCell` converts
  // the pointer's screen row before recording it), while the frame is indexed by SCREEN row.
  const chatRows = renderChatLines(base, 60).map(String);
  const bodyRow = chatRows.findIndex((l) => re.test(strip(l)));
  assert.ok(bodyRow >= 0, `the transcript row matching ${re} is present`);

  const state = { ...base, selection: { anchor: { row: bodyRow, col: col0 }, head: { row: bodyRow, col: col1 } } };
  const f = composeFrame(state, 60, 30);
  const out = (Array.isArray(f) ? f : f.lines || []).map(String);
  const line = out[screenRow];
  assert.ok(line && re.test(strip(line)), `row ${screenRow} still matches ${re} under a selection`);
  return { text: strip(line), cols: selectedColumns(line) };
}

// ---------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------

test('a drag from the left edge skips column 0 on an assistant reply', () => {
  const row = rowFor({ role: 'assistant', text: 'a reply' }, /a reply/);
  assert.equal(row.text[0], ' ', 'the row really does begin with the margin');
  assert.equal(row.cols[0], 1, `the first selected column is the text (got ${row.cols[0]})`);
  assert.ok(!row.cols.includes(0), 'column 0 — the margin — is not selection');
});

test('the rest of the text is still fully selectable', () => {
  // The guard must not cost the content: everything from column 1 on is selected.
  const row = rowFor({ role: 'assistant', text: 'a reply' }, /a reply/);
  for (let c = 1; c <= 7; c++) {
    assert.ok(row.cols.includes(c), `column ${c} is selected`);
  }
});

test('ONE column is skipped, not the row\'s whole indent', () => {
  // The correction. A tool row is drawn as ` ● Used Bash (…)`: the margin is column 0, the bullet is
  // column 1. Skipping the bullet as well — which the first attempt did, by measuring the row's prefix —
  // silently drops a character the user dragged across.
  const row = rowFor(
    { role: 'tool', toolName: 'Bash', toolArgs: { command: 'ls' }, pending: false },
    /Used Bash/,
  );
  assert.ok(!row.cols.includes(0), 'the margin is not selection');
  assert.ok(row.cols.includes(1), 'the bullet IS selection — it is part of the row');
  assert.ok(row.cols.includes(2), 'and so is the space after it');
});

test('a boxed row keeps its walls selectable', () => {
  // Same reason: `│` and `>` are drawn, not padding. Only the leading space is dropped.
  const row = rowFor({ role: 'user', text: 'hi' }, /> hi/);
  assert.ok(!row.cols.includes(0), 'the margin is not selection');
  assert.ok(row.cols.includes(1), 'the left wall is');
  assert.ok(row.cols.includes(2), 'and the prompt glyph');
});

// ---------------------------------------------------------------------------
// what must not change
// ---------------------------------------------------------------------------

test('a selection that starts away from the margin is unaffected', () => {
  // The clamp applies only where a range reaches column 0. An ordinary drag inside the text behaves as
  // before.
  const row = rowFor({ role: 'assistant', text: 'a reply' }, /a reply/, { col0: 4, col1: 8 });
  assert.deepEqual(row.cols, [4, 5, 6, 7], 'exactly the dragged columns');
});

test('a selection that ends at column 0 paints nothing', () => {
  // The degenerate case: a selection whose whole extent is the margin. There is no content there, so
  // nothing is painted.
  const row = rowFor({ role: 'assistant', text: 'a reply' }, /a reply/, { col0: 0, col1: 0 });
  assert.deepEqual(row.cols, [], 'the margin alone is not a selection');
});

test('column 0 is skipped on EVERY row type, not only replies', () => {
  // The rule is uniform, so a new message type cannot quietly opt out.
  const cases = [
    [{ role: 'assistant', text: 'a reply' }, /a reply/],
    [{ role: 'tool', toolName: 'Bash', toolArgs: { command: 'ls' }, pending: false }, /Used Bash/],
    [{ role: 'user', text: 'hi' }, /> hi/],
    [{ role: 'thinking', text: 'hmm', pending: false }, /hmm/],
  ];
  for (const [msg, re] of cases) {
    const row = rowFor(msg, re);
    assert.ok(!row.cols.includes(0), `${msg.role}: column 0 is not selection`);
    assert.ok(row.cols.length > 0, `${msg.role}: something else IS selected`);
  }
});
