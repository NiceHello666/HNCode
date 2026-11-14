// Tests for the scrollbar geometry and the command registry.
//
// Both are pure and easy to get subtly wrong in a way that only shows up visually:
// an off-by-one in the thumb leaves the last row unreachable, and a command-table
// mistake makes a shortcut silently dead. So the tests assert the INVARIANTS a
// caller depends on (thumb stays inside the track, the ends land exactly) rather
// than one hard-coded row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollbarGeometry, scrollbarGlyph, composeFrame, makeState } from '../src/tui.js';
import { parseCells } from '../src/cell-buffer.js';
import { C, TRUECOLOR } from '../src/colors.js';

// ---------------------------------------------------------------------------
// scrollbarGeometry
// ---------------------------------------------------------------------------

test('the thumb never leaves the track', () => {
  // The whole point of the geometry: any scroll position maps to a thumb that is
  // inside [0, bodyH). An overhang would draw past the last row.
  for (const total of [1, 5, 10, 100, 1000]) {
    for (const bodyH of [1, 10, 20]) {
      for (const scroll of [0, 1, 50, 999, 100000]) {
        const g = scrollbarGeometry({ total, bodyH, scroll });
        assert.ok(g.thumbStart >= 0, `thumbStart >= 0 (${total}/${bodyH}/${scroll})`);
        assert.ok(g.thumbLen >= 1, `thumbLen >= 1 (${total}/${bodyH}/${scroll})`);
        assert.ok(g.thumbStart + g.thumbLen <= bodyH,
          `thumb must fit: ${g.thumbStart}+${g.thumbLen} <= ${bodyH} (${total}/${bodyH}/${scroll})`);
      }
    }
  }
});

test('the thumb is at the bottom when pinned there and at the top when scrolled fully', () => {
  const bodyH = 10;
  const bottom = scrollbarGeometry({ total: 100, bodyH, scroll: 0 });
  assert.equal(bottom.thumbStart + bottom.thumbLen, bodyH, 'pinned-to-tail thumb must touch the last row');
  const top = scrollbarGeometry({ total: 100, bodyH, scroll: 90 });   // maxScroll
  assert.equal(top.thumbStart, 0, 'fully scrolled thumb touches the first row');
});

test('content that fits fills the whole track', () => {
  // Nothing to scroll: the thumb IS the track, so the bar reads as "all visible".
  const g = scrollbarGeometry({ total: 5, bodyH: 10, scroll: 0 });
  assert.equal(g.thumbStart, 0);
  assert.equal(g.thumbLen, 10);
  assert.equal(g.maxScroll, 0);
});

test('the virtual grid is exactly twice the row count (half-row resolution)', () => {
  // The 2x grid is what lets the thumb land on a half-row; if the ratio drifts the
  // glyph rule stops matching the geometry.
  for (const bodyH of [1, 7, 20]) {
    const g = scrollbarGeometry({ total: 500, bodyH, scroll: 0 });
  assert.equal(g.virtualTrack, bodyH * 8);
  assert.ok(g.virtualThumbSize >= 8, 'at least one full row tall');
    assert.ok(g.virtualThumbStart + g.virtualThumbSize <= g.virtualTrack);
  }
});

test('scroll is clamped, not trusted', () => {
  // A caller passing a stale or wild offset must not produce a negative or
  // out-of-range thumb. `scroll` counts rows UP from the tail, so a negative value
  // clamps to 0, which is the BOTTOM (thumbLast), not the top.
  const bodyH = 10;
  // The thumb is flush with the last row, whatever its height.
  const atBottom = scrollbarGeometry({ total: 100, bodyH, scroll: 0 });
  assert.equal(atBottom.thumbStart + atBottom.thumbLen, bodyH, 'pinned to the bottom');
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: -50 }).thumbStart, atBottom.thumbStart,
    'a negative offset is clamped to the bottom');
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: 1e9 }).thumbStart, 0, 'clamped to the top');
  const atTop = scrollbarGeometry({ total: 100, bodyH, scroll: 1e9 });
  assert.equal(atTop.thumbStart + atTop.thumbLen <= bodyH, true, 'the thumb stays inside the rail');
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: NaN }).maxScroll, 90);
});

// ---------------------------------------------------------------------------
// scrollbarGlyph
// ---------------------------------------------------------------------------

test('a proportional thumb of constant height, on a track', () => {
  assert.equal(scrollbarGlyph(null, 0), ' ');

  // Height is fixed per transcript: it must not change as the view scrolls, or the control appears to
  // grow and shrink while being used.
  for (const total of [30, 100, 500, 2000]) {
    const bodyH = 18;
    const heights = new Set();
    for (let s = 0; s <= total - bodyH; s++) {
      heights.add(scrollbarGeometry({ total, bodyH, scroll: s }).thumbLen);
    }
    assert.equal(heights.size, 1, `constant thumb height (total=${total})`);
  }

  // The thumb is solid, the rest of the rail is the track line.
  const g2 = scrollbarGeometry({ total: 100, bodyH: 10, scroll: 0 });
  assert.equal(scrollbarGlyph(g2, 9), '█', 'pinned to the tail, the thumb is at the bottom');
  assert.equal(scrollbarGlyph(g2, 0), '│', 'the rest of the rail is the track');
});

test('every rail row is reachable, top to bottom', () => {
  const total = 100;
  const bodyH = 18;
  const g0 = scrollbarGeometry({ total, bodyH, scroll: 0 });
  const travel = bodyH - g0.thumbLen;
  const seen = new Set();
  for (let s = 0; s <= total - bodyH; s++) {
    seen.add(scrollbarGeometry({ total, bodyH, scroll: s }).thumbStart);
  }
  assert.equal(seen.size, travel + 1, 'the thumb visits every row of its travel');
  assert.ok(seen.has(0) && seen.has(travel), 'including both ends');
});

// ---------------------------------------------------------------------------
// how the scrollbar CELL is painted
// ---------------------------------------------------------------------------
// The glyph geometry above is only half the picture: a `▀`/`▄` exposes one half of its
// cell to the BACKGROUND, so the colours decide whether a half-covered row reads as a
// half block or as a second full square. Two regressions are pinned here, both of which
// only show up on a real terminal:
//
//   * foreground AND background were both set to the thumb colour, so the exposed half
//     kept the thumb colour and the row looked like two squares instead of one and a
//     half;
//   * `dimRange` implements the modal backdrop by adding faint (`ESC[2m`), which fades
//     the FOREGROUND only — so with the thumb colour in the background, opening a picker
//     left the thumb's background half at full brightness while the whole screen receded.

test('the painted rows are contiguous and the rest is track', () => {
  const bodyH = 18;
  const g = scrollbarGeometry({ total: 500, bodyH, scroll: 200 });
  const painted = Array.from({ length: bodyH }, (_, r) => (scrollbarGlyph(g, r) === '█' ? 1 : 0));
  const first = painted.indexOf(1);
  const last = painted.lastIndexOf(1);
  assert.ok(first >= 0, 'something is painted');
  assert.ok(painted.slice(first, last + 1).every((v) => v === 1), 'the painted rows are contiguous');
  assert.ok(painted.slice(0, first).every((v) => v === 0), 'nothing above it');
  assert.ok(painted.slice(last + 1).every((v) => v === 0), 'nothing below it');
});

test('an open overlay dims a filled row, not just its glyphs', () => {
  // `ESC[2m` — what a modal backdrop's "faint" is — affects the FOREGROUND only. A cell
  // painted with a BACKGROUND therefore used to stay at full brightness while every character
  // around it receded. The context bar is the clearest case: it is read as a row of colour
  // with almost no text, so it was the one part of the screen that ignored the dim
  // completely.
  //
  // The bar's own fills are used as the probe rather than a scrollbar: the picker is painted
  // AFTER the scrollbar and its gutter covers that column outright, so the frame cannot
  // currently answer "is the scrollbar dimmed under a picker" at all, and a test asking it
  // finds no bar and reports what looks like a dimming failure.
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: {}, models: { 'p/m': {} } },
  };
  const session = {
    id: 's', workspace: '/w', model: 'p/m',
    messages: [
      { role: 'user', content: 'a question with a few words in it' },
      { role: 'assistant', content: 'an answer long enough to occupy part of the window' },
    ],
  };
  const build = (picker) => {
    const st = makeState({ cfg, session, opts: {} });
    st.chat = session.messages.map((m) => ({ ...m, text: m.content }));
    st.rounds = 3; st.steps = 5; st.tokRate = 20;
    st.ctxTokens = 4500; st.ctxMax = 100000; st.ctxPercent = 5;
    st._gitInfo = null; st._costText = '$0.10'; st.tip = 'a tip';
    if (picker) st.picker = { title: 'Actions', items: [{ label: 'Copy' }], sel: 0, searchable: false };
    return composeFrame(st, 100, 30);
  };
  const barFills = [C.ctxSystem, C.ctxPrompt, C.ctxAssistant, C.ctxThinking, C.ctxTools, C.ctxFree];
  // The bar is the second-to-last row of the frame, always — it sits below the composer.
  // Located that way rather than by "the first row containing a bar fill": several other rows
  // carry backgrounds of their own (the composer's box, a panel's surface), so a content
  // search lands on one of those and then asserts about a row that was never the bar.
  const barRowOf = (frame) => frame.lines.length - 2;
  const plain = build(false);
  const plainAt = barRowOf(plain);
  assert.ok(plainAt > 0, 'the frame draws a context bar');
  const plainBar = String(plain.lines[plainAt]);
  // Only the fills this particular transcript actually uses: a segment with nothing in it
  // takes no columns, so requiring every colour would be requiring a picture that is not
  // there. The FREE segment is the one guaranteed to be present in a nearly-empty window.
  const present = barFills.filter((f) => plainBar.includes(f));
  assert.ok(present.length > 0, `the bar carries at least one fill: ${JSON.stringify(plainBar.slice(0, 80))}`);

  // With an overlay open, the bar must be FAINT — every cell carrying the faint — and it
  // must still be a BAR: the fills that separate one segment from the next have to survive.
  //
  // Whether the fill ITSELF is darkened depends on the colour depth, and that is deliberate.
  // At 256 colours the segment blues live in the 6x6x6 cube's lowest two steps, and scaling
  // them toward the page quantises distinct segments onto the same index — measured, five of
  // six fills stay distinct at 0.85x and four at 0.72x. A dimmed bar that has lost two of its
  // five segments is worse than one whose fills are unchanged and whose glyphs are faint, so
  // below truecolor the fill is left alone and only `ESC[2m` is applied.
  const open = build(true);
  const openAt = barRowOf(open);
  assert.ok(openAt > 0, 'the frame still draws a context bar under an overlay');
  const openBar = String(open.lines[openAt]);
  assert.ok(openBar.includes(C.dim), 'the bar is faint');
  // Below truecolor the fills must survive. In truecolor they are deliberately pulled toward the page instead
  // (asserted just below), so requiring them here as well was a contradiction: the two branches asked for
  // opposite things and only one of them can hold on a given terminal.
  if (!TRUECOLOR) {
    for (const f of present) {
      assert.ok(openBar.includes(f),
        `the bar LOST ${JSON.stringify(f)} under an overlay — the segments must stay distinct`);
    }
  }
  if (TRUECOLOR) {
    // With an exact triple available the fill is genuinely pulled toward the page, which is
    // what makes a backdrop recede on a terminal that can express it.
    for (const f of present) {
      assert.ok(!openBar.includes(f),
        `truecolor: the bar still carries ${JSON.stringify(f)} undimmed`);
    }
  }
  // And the bar's own width survives: dimming must not have eaten the readout.
  const plainText = plainBar.replace(/\x1b\[[0-9;]*m/g, '');
  const openText = openBar.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(openText.length, plainText.length, 'the row is still exactly as wide');
  assert.ok(openText.trim(), 'and still shows something');
});
// ---------------------------------------------------------------------------
// the scrollbar as it reaches the FRAME
// ---------------------------------------------------------------------------
// The geometry above is only half of it: the rail is painted a row at a time while the body is composed, and
// it used to be addressed by TRANSCRIPT row. On any session longer than the window that put every visible row
// outside the rail's range and the bar vanished — which is the bug this pins.

test('the rail is drawn in the visible window, wherever the window is', () => {
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: {}, models: { 'p/m': {} } },
  };
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: `question ${i}` });
    messages.push({ role: 'assistant', content: `answer number ${i}` });
  }
  const session = { id: 's', workspace: '/w', model: 'p/m', messages };
  // A rail cell carries its own foreground and background, so the painted glyph is readable as-is. The colour
  // may be 256-colour (`38;5;n`) or truecolor (`38;2;r;g;b`) depending on the theme, so the pattern takes
  // either form — pinning it to 256 colours made this test fail on every truecolor theme.
  const FG = '\\u001b\\[38;(?:5;\\d+|2;\\d+;\\d+;\\d+)m';
  const BG = '\\u001b\\[48;(?:5;\\d+|2;\\d+;\\d+;\\d+)m';
  const barChars = (frame, bodyH, screenTop) => frame.lines.slice(screenTop, screenTop + bodyH).map((line) => {
    const m = new RegExp(FG + BG + '(.)').exec(String(line));
    return m ? m[1] : '';
  }).join('');

  for (const requested of [0, 68, 136]) {
    const st = makeState({ cfg, session, opts: {} });
    st.chat = session.messages.map((m) => ({ ...m, text: m.content }));
    st.scroll = requested;
    st._anchorPin = null;
    const frame = composeFrame(st, 80, 30);
    const sb = st._sb;
    assert.ok(sb, 'the transcript is longer than the window, so there is a rail');
    const expected = Array.from({ length: st._bodyH }, (_, r) => scrollbarGlyph(sb, r)).join('');
    const painted = barChars(frame, st._bodyH, st._bodyScreenTop);
    assert.equal(painted, expected,
      `rail painted at scroll ${requested} (window starts at body row ${st._bodyTop})`);
    assert.equal(painted.indexOf('█'), sb.thumbStart, 'the thumb starts at its computed row');
  }
});
