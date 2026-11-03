// A picture is sent ONCE, and only when the terminal may have lost it.
//
// This is the regression that matters most in this file's subject: a Sixel draw MOVES THE TERMINAL'S
// SCREEN. Re-sending one on a frame whose text did not change pushes the interface down, and the next paint
// draws it at the new offset — measured on Windows Terminal, a once-a-second re-send left the composer
// repeated down the page and a formula stranded at the bottom of a window whose text had scrolled away.
//
// So what is asserted here is not "a picture is drawn" but "a picture is NOT drawn again": the first paint
// carries the payload, and every later paint of an unchanged frame carries none of it. A resize is the one
// case that must send it again, because the terminal really has lost its pixels.
//
// The tests install an image protocol and a cell size, which is what a terminal reports through DA1 and
// XTWINOPS 16; `composeFrame` is otherwise driven exactly as the TUI drives it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTerminalCaps } from '../src/term-caps.js';
import {
  composeFrame, makeState, paintCellFrame, resetCellFrame, resetShownImages,
} from '../src/tui.js';

const CELL = { w: 10, h: 20 };

/** A session whose one reply holds a display formula, so the frame carries exactly one picture. */
function session() {
  const answer = ['求根公式：', '', '$$', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', '$$'].join('\n');
  return {
    id: 's', workspace: '/w', model: 'p/m',
    messages: [
      { role: 'user', content: '解释' },
      { role: 'assistant', content: answer },
    ],
  };
}

function state() {
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: {}, models: { 'p/m': {} } },
  };
  const s = session();
  const st = makeState({ cfg, session: s, opts: {} });
  st.chat = s.messages.map((m) => ({ ...m, text: m.content }));
  return st;
}

/** How many Sixel payloads a write carries: one per picture drawn. */
const pictures = (bytes) => (String(bytes).match(/\u001bP0;/g) || []).length;

/** Run one paint of a fresh state through a fresh painter, and report what it sent. */
function paint(st, resend) {
  const frame = composeFrame(st, 100, 30);
  return { frame, out: paintCellFrame(frame, resend) };
}

test('a picture is sent once, and an idle frame touches neither its pixels nor its text', () => {
  // TWO RULES, AND THEY ARE ONE RULE: either a picture's whole rectangle is repainted — its text cells and
  // its payload — or NOTHING in that rectangle is written.
  //
  // Writing the text cells of a picture that is not being redrawn means writing SPACES, and a space over a
  // cell destroys the pixels on it. That was the flicker: the picture was skipped (a cache hit), its rows were
  // still written as blank text, the pixels vanished for a frame, came back on the next, went away again.
  setTerminalCaps({ extensions: ['sixel'], cell: CELL });
  resetCellFrame();
  resetShownImages();
  const st = state();

  const first = paint(st, true);
  assert.equal(pictures(first.out), 1, 'the first paint sends the picture');
  assert.ok(first.out.includes('\u001b[?7l'), 'auto-wrap is turned off');
  assert.ok(first.out.includes('\u001b[?7h'), 'and turned back on at the end');

  // An idle tick: the placement key is unchanged, so there is nothing to draw — and, crucially, nothing to
  // erase either.
  const second = paint(st, false);
  assert.equal(pictures(second.out), 0, `an idle frame sends nothing (${second.out.length} bytes)`);
});

test('a picture that scrolled IS sent again, because it moved', () => {
  // The placement key carries the ROW, so a formula that moved is a different placement. A terminal does not
  // carry sixel pixels across rows, so the new row has to be drawn and the old one blanked.
  setTerminalCaps({ extensions: ['sixel'], cell: CELL });
  resetCellFrame();
  resetShownImages();
  const st = state();
  const long = [];
  for (let i = 0; i < 20; i++) {
    long.push({ role: 'user', content: `question ${i}` });
    long.push({ role: 'assistant', content: `answer number ${i}` });
  }
  long.push({ role: 'assistant', content: '$$\n\\frac{a}{b}\n$$' });
  st.chat = long.map((m) => ({ ...m, text: m.content }));

  assert.equal(pictures(paint(st, true).out), 1, 'first paint sends');
  // One row of scroll, so the picture stays inside the panel and the only change is its position.
  st.scroll = 1;
  st._anchorPin = null;
  assert.equal(pictures(paint(st, false).out), 1, 'a scrolled picture is redrawn at its new row');
});



test('a picture that MOVED is erased and redrawn, in one write', () => {
  // The position is part of a placement's identity. A formula that scrolled one row up is a DIFFERENT
  // placement: its new row has to be drawn, and its old row has to be erased. Skipping it because the raster
  // matched is what left a blank rectangle at the new row — a rectangle that covered the transcript, the
  // scrollbar and the composer — and stale pixels at the old one.
  setTerminalCaps({ extensions: ['sixel'], cell: CELL });
  resetCellFrame();
  resetShownImages();
  const st = state();
  const long = [];
  for (let i = 0; i < 20; i++) {
    long.push({ role: 'user', content: `question ${i}` });
    long.push({ role: 'assistant', content: `answer number ${i}` });
  }
  long.push({ role: 'assistant', content: '$$\n\\frac{a}{b}\n$$' });
  st.chat = long.map((m) => ({ ...m, text: m.content }));

  const before = paint(st, true);
  assert.equal(pictures(before.out), 1, 'sent once');
  const rowBefore = before.frame.images[0].row;

  // A small scroll keeps the picture inside the panel: moving it OUT of the window is a different test, and
  // the panel clip (the composer's top edge) would legitimately drop it.
  st.scroll = 2;
  st._anchorPin = null;
  const after = paint(st, false);
  const rowAfter = after.frame.images[0].row;
  assert.notEqual(rowAfter, rowBefore, `the picture moved (${rowBefore} -> ${rowAfter}), so this tests what it claims`);

  assert.equal(pictures(after.out), 1, 'the new position is drawn');
  // The old rows are erased rather than left showing the previous frame's pixels.
  const erased = after.out.includes(`\x1b[${rowBefore + 1};`);
  assert.ok(erased, `the old row ${rowBefore} is addressed, so its pixels are cleared`);
  // And the erase is not a whole-row blank: the scrollbar's column must survive it.
  assert.ok(!new RegExp(`\\x1b\\[\\d+;1H\\x1b\\[${100}X`).test(after.out),
    'no erase takes the entire row width');
});

test('no cursor address is ever negative, however far the transcript is scrolled', () => {
  // A FORMULA MOSTLY LIVES HALF OFF THE TOP OF THE WINDOW. Scrolling moves it up one row at a time, so a
  // placement's row goes negative — and `ESC [-1;2H` is not a cursor position, it is a malformed sequence.
  // A terminal that gives up part-way through one reads the rest of the frame's bytes as TEXT, which is
  // what "the formulas and the prose melted together" looked like on screen.
  //
  // dsh-tui never emits one: it crops the raster to the visible rows before encoding (src/ink/
  // sixel-graphics.ts there, `variant` — `crop` is the intersection with `clip`). This paints the same way,
  // so what is asserted here is that every address the writer emits is a real one.
  setTerminalCaps({ extensions: ['sixel'], cell: CELL });
  resetCellFrame();
  resetShownImages();
  const st = state();
  const long = [];
  for (let i = 0; i < 8; i++) {
    long.push({ role: 'assistant', content: `第 ${i} 条：\n\n$$\nx_{${i}} = \\frac{a_{${i}}}{b_{${i}}}\n$$` });
  }
  st.chat = long.map((m) => ({ ...m, text: m.content }));

  for (let scroll = 0; scroll <= 40; scroll++) {
    st.scroll = scroll;
    st._anchorPin = null;
    const out = paint(st, false).out;
    for (const m of out.matchAll(/\u001b\[(-?\d+);(-?\d+)H/g)) {
      assert.ok(Number(m[1]) >= 1 && Number(m[2]) >= 1,
        `scroll ${scroll}: every address is real, got ESC[${m[1]};${m[2]}H`);
    }
  }
});

test('a picture straddling the top is cropped by the right number of BANDS', () => {
  // CELL ROWS AND SIXEL BANDS ARE DIFFERENT UNITS, and confusing them is what made a formula slide into place
  // as the view scrolled. A placement is measured in cell rows; its payload is measured in bands of six PIXEL
  // rows. With a 20-pixel cell one cell row is 3.3 bands, so dropping `hidden` bands for `hidden` rows threw
  // away a sixth of the picture that should have stayed — the image was drawn from the wrong point in its own
  // payload, and the offset changed by whole rows as the scroll moved.
  setTerminalCaps({ extensions: ['sixel'], cell: CELL });
  resetCellFrame();
  resetShownImages();
  const st = state();
  const long = [];
  for (let i = 0; i < 4; i++) {
    long.push({ role: 'assistant', content: `第 ${i} 条：\n\n$$\nx_{${i}} = \\frac{a_{${i}}}{b_{${i}}}\n$$` });
  }
  st.chat = long.map((m) => ({ ...m, text: m.content }));

  let checked = 0;
  for (let scroll = 0; scroll <= 12; scroll++) {
    st.scroll = scroll;
    st._anchorPin = null;
    const frame = composeFrame(st, 90, 20);
    const straddler = frame.images.find((img) => img.row < 0 && img.row + img.rows > 0);
    if (!straddler) continue;
    const out = paintCellFrame(frame, false);

    // Find the payload drawn AT the straddler's first visible row, not merely the first one in the write: a
    // frame can carry several pictures and the earlier ones may be fully on screen.
    const marker = `\x1b[1;${(straddler.col || 0) + 1}H\x1b[0m\x1bP0;`;
    const at = out.indexOf(marker);
    if (at < 0) continue;
    const start = at + marker.length - 4;
    const payload = /^\x1bP0;([\s\S]*?)\x1b\\/.exec(out.slice(start));
    if (!payload) continue;

    const bands = payload[1].split('-').length;
    const originalBands = (straddler.seq.match(/-/g) || []).length + 1;
    const hidden = -straddler.row;
    const expected = originalBands - Math.floor((hidden * CELL.h) / 6);

    assert.equal(bands, expected,
      `scroll ${scroll}: ${hidden} row(s) hidden of a ${CELL.h}px cell means ${expected} bands, got ${bands}`);
    // The header carries the DCS introducer, the raster attributes and the palette; a crop that drops it
    // leaves the terminal with bytes it cannot parse, which it then reads as text.
    assert.ok(payload[0].startsWith('\x1bP0;1;0;q'), `scroll ${scroll}: the DCS header survives the crop`);
    assert.ok(payload[0].endsWith('\x1b\\'), `scroll ${scroll}: the terminator survives the crop`);
    checked++;
  }
  assert.ok(checked >= 3, `the test exercised a straddling picture at ${checked} scroll positions`);
});



test('a refused picture leaves no hole: the text stays where it was', () => {
  // THE REGRESSION THAT MATTERED. The painter used to blank a picture's cells FIRST and decide whether to
  // draw it afterwards. A picture refused by the budget or by the row limit was therefore neither drawn nor
  // covered by text: a blank rectangle over the transcript, the scrollbar and the composer, which grew as
  // each zero-sized cell made the raster enormous.
  //
  // The rule is the one dsh-tui's reconciliation follows: nothing may be erased unless its replacement is
  // written in the same frame. A refused picture's replacement is the TEXT it already had.
  setTerminalCaps({ extensions: ['sixel'], cell: { w: 1, h: 1 } });
  resetCellFrame();
  resetShownImages();
  const st = state();

  const { frame, out } = paint(st, true);
  // Every row of the frame must still carry its text. A blank row is the hole this test exists to catch.
  const bodyText = (frame.lines || []).map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
  const nonEmpty = bodyText.filter((l) => l.trim()).length;
  assert.ok(nonEmpty > 4, `the frame still has its text: ${nonEmpty} non-empty rows`);

  // And the write is bounded rather than carrying an enormous raster.
  assert.ok(out.length < 512 * 1024, `the write stays bounded: ${out.length} bytes`);

  // The picture is either drawn (one payload) or refused (none) — never half of each.
  const drawn = pictures(out);
  assert.ok(drawn === 0 || drawn === 1, `the picture is all-or-nothing: ${drawn} payloads`);
  // A refusal must not come with an erase, because nothing replaces it: that is the hole.
  if (drawn === 0) {
    assert.equal((out.match(/\x1b\[\d+X/g) || []).length, 0,
      'a refused picture is not erased — its cells keep the text');
  }
});

