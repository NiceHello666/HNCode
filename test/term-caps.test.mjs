// The capability probe's PARSER and its protocol.
//
// WHY A PARSER TEST AND NOT JUST THE HARNESS
// ------------------------------------------
// The end-to-end harness (tools/check_term_probe.mjs, driven by
// test/term-probe-e2e.test.mjs) is what proves the wiring, but it only ever feeds it
// the handful of replies one terminal emits. The parser is the part that has to be
// right about every shape a reply can take — four hex digits vs two, BEL vs ST, a
// reply split across TCP-sized reads, a keystroke arriving in the middle of one — so
// it is tested directly here. The protocol side (what gets written, and that keystrokes
// are never eaten) is covered by the sibling file, which drives the real module
// against streams.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProbeReplies, stripProbeReplies, isLightBg, terminalFamily,
  setTerminalCaps, syncOutputUsable, kittyKeysUsable, terminalCaps,
  PROBE_QUERY, SYNC_OUTPUT_MODE,
} from '../src/term-caps.js';

test('a four-digit-per-component background is scaled to 8 bits, not truncated', () => {
  // xterm sends `ffff`; taking the low byte would turn white into mid-grey and darken
  // the theme decision. Every component scale is what makes the light/dark split right.
  const { found } = parseProbeReplies('\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.deepEqual(found.bg, { r: 255, g: 255, b: 255 });
  const dark = parseProbeReplies('\x1b]11;rgb:0000/0a0a/1212\x07').found.bg;
  assert.deepEqual(dark, { r: 0, g: 10, b: 18 });
});

test('a two-digit background is read as 8 bits, not scaled by 65535', () => {
  // The opposite failure: treating `ff` as `00ff` gives 0 and inverts the decision.
  assert.deepEqual(parseProbeReplies('\x1b]11;rgb:ff/80/00\x07').found.bg, { r: 255, g: 128, b: 0 });
});

test('the background reply is accepted with either terminator', () => {
  // BEL is xterm; ST (`ESC \`) is the general form, and terminals use both.
  const bel = parseProbeReplies('\x1b]11;rgb:ffff/ffff/ffff\x07');
  const st = parseProbeReplies('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
  assert.deepEqual(bel.found.bg, st.found.bg);
  assert.equal(st.rest, '', 'an ST-terminated reply must be fully consumed, not left as input');
});

test('the `#rrggbb` background spelling is accepted too', () => {
  // Not xterm's, but several terminals answer OSC 11 this way; there is no reason to
  // throw the reading away and fall back to "unknown".
  assert.deepEqual(parseProbeReplies('\x1b]11;#ff8800\x07').found.bg, { r: 255, g: 136, b: 0 });
});

test('kitty flags of 0 still mean the protocol is supported', () => {
  // 0 is "supported, nothing enabled" — the state the query is asked from. Reading it
  // as "unsupported" would disable the protocol on exactly the terminals that have it.
  assert.equal(parseProbeReplies('\x1b[?0u').found.kitty, true);
  assert.equal(parseProbeReplies('\x1b[?31u').found.kitty, true);
});

test('DECRPM distinguishes "knows the mode" from "has never heard of it"', () => {
  const set = parseProbeReplies(`\x1b[?${SYNC_OUTPUT_MODE};1$y`).found;
  const reset = parseProbeReplies(`\x1b[?${SYNC_OUTPUT_MODE};2$y`).found;
  const unknown = parseProbeReplies(`\x1b[?${SYNC_OUTPUT_MODE};0$y`).found;
  assert.equal(set.sync, true);
  assert.equal(reset.sync, true, 'a terminal reporting RESET knows the mode just as well');
  assert.equal(unknown.sync, false, 'status 0 is the one that means "not recognised"');
});

test('the DA1 sentinel is what completes the batch', () => {
  // This is the whole reason there is no timeout guessing: every terminal answers DA1,
  // so its reply bounds the replies to everything asked before it.
  assert.equal(parseProbeReplies('\x1b[?62;4;22c').complete, true);
  assert.equal(parseProbeReplies('\x1b[?3u').complete, false, 'without the sentinel, more may come');
});

test('the DA1 parameter list identifies a VT level and its extensions', () => {
  const { found } = parseProbeReplies('\x1b[?62;4;6;22c');
  assert.equal(found.level, 'vt220');
  assert.deepEqual(found.extensions, ['sixel', 'selective-erase', 'ansi-color']);
  assert.deepEqual(found.da1, [62, 4, 6, 22]);
});

test('an unknown VT level is reported rather than dropped', () => {
  // Better an honest "vt?200" than a null that reads as "the terminal said nothing".
  const { found } = parseProbeReplies('\x1b[?200c');
  assert.equal(found.level, 'vt?200');
  assert.deepEqual(found.extensions, []);
});

test('a reply split across chunks is assembled, and nothing is lost', () => {
  // Reply bytes arrive in whatever sizes the pipe hands over, so every boundary inside
  // a reply has to be survivable. The accumulation is how `probeTerminal` actually
  // does it: buffer, parse, keep only what is NOT a reply, repeat.
  const whole = '\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?3u\x1b[?2026;1$y\x1b[?62;22c';
  const full = parseProbeReplies(whole).found;
  for (let cut = 1; cut < whole.length; cut++) {
    const found = {};
    let buf = '';
    let complete = false;
    for (const chunk of [whole.slice(0, cut), whole.slice(cut)]) {
      buf += chunk;
      const parsed = parseProbeReplies(buf);
      Object.assign(found, parsed.found);
      buf = parsed.rest;
      if (parsed.complete) complete = true;
    }
    assert.deepEqual(found.bg, full.bg, `split at ${cut}: background`);
    assert.equal(found.kitty, full.kitty, `split at ${cut}: kitty`);
    assert.equal(found.sync, full.sync, `split at ${cut}: sync`);
    assert.equal(complete, true, `split at ${cut}: the sentinel must still complete the batch`);
    assert.equal(buf, '', `split at ${cut}: nothing may be left behind`);
  }
});

test('keystrokes arriving between replies survive as input', () => {
  // The probe owns the same stream the keyboard uses; a reply must be removed and
  // nothing else may be.
  const { found, rest } = parseProbeReplies('ab\x1b[?62;c' + '\x1b[A' + 'cd');
  assert.equal(found.level, 'vt220');
  assert.equal(rest, 'ab\x1b[A' + 'cd');
});

test('a partial reply at the end is NOT treated as input', () => {
  // The dangerous case: a half-arrived `\x1b[?62` handed to the key parser would be
  // typed into the composer. `probeTerminal` drops that tail; the parser only has to
  // leave it in `rest` so the caller can recognise it.
  const { rest } = parseProbeReplies('hi\x1b[?62');
  assert.equal(rest, 'hi\x1b[?62');
  assert.ok(rest.endsWith('\x1b[?62'));
});

test('ordinary typing is passed straight through by the late-reply filter', () => {
  // The filter runs on every keystroke for a short window after the probe, so it must
  // be inert for input and cheap for the common case.
  assert.equal(stripProbeReplies('hello'), 'hello');
  assert.equal(stripProbeReplies(''), '');
  // A real arrow key is NOT a probe reply and must survive.
  assert.equal(stripProbeReplies('\x1b[A'), '\x1b[A');
  // A CSI that merely starts the same way is not a reply either.
  assert.equal(stripProbeReplies('\x1b[?25l'), '\x1b[?25l');
});

test('a late reply is removed from the keystroke stream', () => {
  // The terminal that missed the probe's deadline and answered afterwards: without this
  // its bytes reach the key parser and are typed as garbage.
  assert.equal(stripProbeReplies('\x1b]11;rgb:ffff/ffff/ffff\x07abc'), 'abc');
  assert.equal(stripProbeReplies('\x1b[?3uabc'), 'abc');
  assert.equal(stripProbeReplies('abc\x1b[?62;22c'), 'abc');
});

test('the light/dark split uses luma, and only knows what it was told', () => {
  assert.equal(isLightBg({ r: 255, g: 255, b: 255 }), true);
  assert.equal(isLightBg({ r: 240, g: 240, b: 240 }), true);
  // Mid grey is the ambiguous case, and luma puts it just OVER the line: 128*1.0 = 128.
  // A saturated colour of the same average reads very differently, which is why a
  // plain per-channel mean is not used — a pure blue at (0,0,255) averages 85 and would
  // be called dark, yet it reads as a dark background.
  assert.equal(isLightBg({ r: 128, g: 128, b: 128 }), true);
  assert.equal(isLightBg({ r: 127, g: 127, b: 127 }), false);
  assert.equal(isLightBg({ r: 0, g: 0, b: 255 }), false);
  assert.equal(isLightBg({ r: 255, g: 255, b: 0 }), true, 'yellow reads light');
  assert.equal(isLightBg({ r: 0, g: 0, b: 0 }), false);
  // The frame paints no background of its own, so "unknown" must NOT be "light": a
  // wrong guess here is white text on white.
  assert.equal(isLightBg(null), false);
});

test('the terminal family comes from the environment, with TERM_PROGRAM ahead of TERM', () => {
  assert.equal(terminalFamily({ WT_SESSION: 'abc' }), 'Windows Terminal');
  assert.equal(terminalFamily({ TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' }), 'VS Code');
  assert.equal(terminalFamily({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(terminalFamily({ TERM: 'xterm-256color' }), 'xterm');
  assert.equal(terminalFamily({ TERM: 'screen' }), 'screen');
  assert.equal(terminalFamily({}), null);
});

test('an unknown answer keeps the OLD default rather than becoming a NO', () => {
  // This is the load-bearing contract of the whole feature: the probe must never
  // silently change what a terminal that says nothing receives.
  setTerminalCaps({ probed: false, kitty: null, sync: null });
  assert.equal(kittyKeysUsable(), true, 'no information must keep Kitty keyboard on');
  assert.equal(syncOutputUsable(), true, 'no information must keep synchronized output on');

  setTerminalCaps({ kitty: false, sync: false });
  assert.equal(kittyKeysUsable(), false, 'an explicit NO must be honoured');
  assert.equal(syncOutputUsable(), false);
});

test('a second probe does not inherit the first probe\'s answers', () => {
  // Stale flags on a changed terminal would be worse than no flags at all. (The reset
  // itself lives in probeTerminal; this pins that setTerminalCaps merges rather than
  // replaces, which is what makes `probed` sticky.)
  setTerminalCaps({ bg: { r: 1, g: 2, b: 3 } });
  const merged = setTerminalCaps({ kitty: true });
  assert.deepEqual(merged.bg, { r: 1, g: 2, b: 3 }, 'an unmentioned field is kept');
  assert.equal(merged.kitty, true);
});

test('the query batch ends with the Device Attributes request', () => {
  // The protocol's whole no-timeout design depends on this ordering.
  assert.ok(PROBE_QUERY.endsWith('\x1b[c'), 'DA1 must be last');
  assert.ok(PROBE_QUERY.includes('\x1b]11;?'), 'the background is asked for');
  assert.ok(PROBE_QUERY.includes('\x1b[?u'), 'kitty keyboard is asked for');
  assert.ok(PROBE_QUERY.includes(`\x1b[?${SYNC_OUTPUT_MODE}$p`), 'synchronized output is asked for');
});

test('the cell size is asked for with XTWINOPS 16, and 14 as a cross-check', () => {
  // This is the query that makes images possible at all, and it went wrong twice.
  //
  // First it asked through DECRPM (`CSI ? 2026;2$p`) and parsed for opcodes that never
  // arrive, so it matched nothing and every image refused to draw. Then it asked `CSI 14 t`
  // — which is the TEXT AREA — and parsed for 14/18, so it still matched nothing.
  //
  // The CELL is XTWINOPS 16 (dsh-TUI's terminal-querier.ts, `terminalCellSizePixels`). Both
  // replies are `CSI 6 ; w ; h t`, so the parser matches the REPORT opcode: 6 for the cell,
  // 4 for the text area.
  assert.ok(PROBE_QUERY.includes('\x1b[16t'), 'the cell size must be asked for, and 16 is it');
  assert.ok(PROBE_QUERY.includes('\x1b[14t'), 'and 14 as a cross-check for the text area');
  assert.ok(!PROBE_QUERY.includes('\x1b[18t'), '18 is not a query op and must be gone');
  const { found, rest } = parseProbeReplies('\x1b[6;8;17t\x1b[4;800;600t\x1b[?62c');
  assert.deepEqual(found.cell, { w: 17, h: 8 }, 'opcode 6 reports height first, then width');
  assert.deepEqual(found.textArea, { w: 600, h: 800 }, 'and so does opcode 4');
  assert.equal(rest, '', 'and both are consumed, not left for the key parser');
});

test('the graphics query is the protocol escape code, not a keyboard variant', () => {
  // `CSI ? 1u` was guessed as a kitty-graphics query. It is really a variant of the
  // KEYBOARD query, so it collided with the keyboard probe — and because an unanswered
  // query is inferred as "not supported" once the sentinel arrives, that turned images OFF
  // on exactly the terminals that support them. The real query is an APC.
assert.ok(PROBE_QUERY.includes('\x1b_G'), 'the graphics query is an APC (ESC _G)');
  assert.ok(PROBE_QUERY.includes('a=q'), 'and it asks action=q, "query support"');
  assert.ok(!PROBE_QUERY.includes('\x1b[?1u'), 'the colliding keyboard variant must be gone');
  // It must carry a REAL payload, and the one the renderer actually uploads with. A probe
  // that asks about a format we would not send reports on a format we would not send: this
  // one was `f=24` (PNG in a file), while `kittyImageSequence` sends `f=100` file bytes and
  // dsh-TUI probes `f=32,o=z` — direct RGBA over zlib. Probing that path is what actually
  // tells us whether the terminal will take what we send.
  assert.ok(PROBE_QUERY.includes('f=32'), 'probe direct RGBA, the format the renderer uses');
  assert.ok(PROBE_QUERY.includes('o=z'), 'and the compression we would use');
assert.ok(/;[A-Za-z0-9+/=]{8,}\x1b\\/.test(PROBE_QUERY),
    'with an actual encoded payload, not an empty query');
});

test('a terminal that answers nothing about graphics is not treated as having it', () => {
  // The inference that made the collision harmful: a sentinel arriving means every query
  // was answered in order, so silence about graphics means "no". Inference happens in
  // probeTerminal, not here — this pins the parse half, so a silent terminal yields no
  // kittyGraphics field and the caller draws the text fallback.
  const plain = parseProbeReplies('\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[4;800;600t\x1b[6;8;17t\x1b[?1;2c');
  assert.equal(plain.found.kittyGraphics, undefined);
  assert.equal(plain.complete, true, 'the sentinel arrived');
  assert.equal(plain.rest, '', 'and nothing leaked to the key parser');
});

test('the graphics reply is consumed even when it carries no cell size', () => {
  // The `OK` reply lists supported formats and image ids — not a cell size. An earlier
  // version read a cell out of it by pattern, which never matched anything, and the caller
  // fell back on a `kittyGraphicsCell` that was therefore always null. The cell size comes
  // from XTWINOPS only; this pins that the reply is still fully consumed either way, so a
  // terminal that answers it does not leak bytes into the key parser.
  const { found, rest } = parseProbeReplies('\x1b[_Gi=31;OK,f=24,s=32,v=1,cols=100;(\x1b\\\x1b[6;8;17t\x1b[?62;4c');
  assert.equal(found.kittyGraphics, true);
  assert.deepEqual(found.cell, { w: 17, h: 8 }, 'opcode 6 reports height first, then width');
  assert.equal(rest, '', 'and nothing leaked');
});

test('the stored caps are readable and always carry the full shape', () => {
  setTerminalCaps({ kitty: true });
  const caps = terminalCaps();
  for (const k of ['probed', 'bg', 'kitty', 'sync', 'level', 'extensions', 'da1', 'family']) {
    assert.ok(k in caps, `caps must always carry ${k}`);
  }
});