// The working row's restraint: a subtle glint, late tokens, and a stall signal.
//
// WHY THIS FILE EXISTS
// --------------------
// Three behaviours copied from Claude Code's spinner, each because the local version misbehaved:
//
// 1. THE GLINT WAS A DIFFERENT COLOUR. `[255,240,120]` against orange `[255,140,0]` is a hue change — the
//    eye reads "this text is yellow now", a state change, rather than a ripple passing over it. Claude
//    Code keeps its pair a shade apart and lets the MOTION carry the effect. The same applied to the
//    Using row's `[150,255,255]` against `[0,215,255]`.
//
// 2. TOKENS APPEARED IMMEDIATELY. A count ticking up several times a second is noise on a four-second
//    turn. Claude Code's `SHOW_TOKENS_AFTER_MS = 30000` is why its row is bare at first.
//
// 3. A QUIET TURN LOOKED IDENTICAL TO A HUNG ONE. `useStalledAnimation` fades toward a warning colour
//    after three seconds of no output — and never while a tool runs, because an `npm install` that takes
//    a minute is working, not stuck.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The two rows that carry a GLINT no longer live in one file: the Working row is still in tui.js, while the Using row
// moved to src/tool-line.js. Both are read so the pair can still be compared. The token and time formatters moved on to
// src/format.js, and the stall thresholds and the interpolation site went with them.
const tuiSrc = fs.readFileSync(path.resolve('src/tui.js'), 'utf8')
  + fs.readFileSync(path.resolve('src/tool-line.js'), 'utf8')
  + fs.readFileSync(path.resolve('src/format.js'), 'utf8');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Euclidean distance on the 0-255 RGB cube. */
function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * The xterm-256 index a truecolor triple paints as — the same quantisation `src/colors.js` applies.
 *
 * Reproduced rather than imported because `ansi256` is not exported, and the point of the assertion is
 * precisely what the PALETTE does to the colour, which RGB distance cannot answer.
 */
function ansi256(r, g, b) {
  const cube = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 12) {
    const avg = (r + g + b) / 3;
    return 232 + Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  }
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
}

/**
 * Every `const NAME = [r, g, b]` in the source, in order of appearance.
 *
 * PLURAL, because two rows declare a `GLINT`: the Using row's cyan and the Working row's orange. Taking
 * the first match compared a cyan glint against orange and reported a distance of 310 — a failing test
 * about the wrong value, which is worse than no test at all.
 */
function coloursOf(name) {
  const out = [];
  for (const m of tuiSrc.matchAll(new RegExp(`const ${name} = \\[(\\d+), (\\d+), (\\d+)\\]`, 'g'))) {
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return out;
}

const ORANGE = [255, 140, 0];

// ---------------------------------------------------------------------------
// 1. the glint is a shade, not a hue
// ---------------------------------------------------------------------------

test('the Working glint is a visible step in 256 colours', () => {
  // MEASURED IN THE PAINTED INDEX, not in RGB distance. A 0-255 separation can vanish entirely once the
  // colour is quantised to the xterm palette — `[255,140,0]` and `[255,172,60]` differ by 68 in RGB and
  // still land on the same two or three indices. What a reader sees is the index gap, so that is what this
  // asserts: Claude Code's own pair (`rgb(215,119,87)` / `rgb(245,149,117)`) differs by 7.
  const all = coloursOf('GLINT');
  assert.equal(all.length, 2, 'both rows declare a GLINT');
  const glint = all.reduce((best, c) => (distance(c, ORANGE) < distance(best, ORANGE) ? c : best));

  const baseIdx = ansi256(...ORANGE);
  const glintIdx = ansi256(...glint);
  const gap = glintIdx - baseIdx;
  assert.ok(gap >= 3, `the glint is only ${gap} index steps brighter — invisible on screen`);
  assert.ok(gap <= 20, `the glint is ${gap} steps brighter — a different colour, not a sheen`);
});

test('the Using glint is in the same hue as its base', () => {
  // Cyan base [0,215,255]. The previous pale [150,255,255] lifted the red channel by 150, which reads as
  // "the name turned pale" rather than "a light passed over it".
  const all = coloursOf('GLINT');
  const glint = all.reduce((best, c) => (distance(c, [0, 215, 255]) < distance(best, [0, 215, 255]) ? c : best));
  const base = coloursOf('BASE')[0] || [0, 215, 255];
  assert.ok(distance(glint, base) < 130, 'the glint is a shade of the base, not another colour');
});

test('tokens are shown from the first frame, with a direction arrow', () => {
  // The count used to be held back for thirty seconds. That was wrong for this row: the tail is the only
  // place the number exists, and a count that appears partway through reads as something that just
  // started rather than as a running total. The arrow marks it as tokens RECEIVED, which is not the same
  // quantity as the context gauge beside it.
  const at = tuiSrc.indexOf('function elapsedTail(ms, tokens)');
  assert.ok(at > 0, 'elapsedTail is present');
  const body = tuiSrc.slice(at, tuiSrc.indexOf('\n}', at));
  assert.match(body, /↓/, 'the count carries a downward arrow');
  assert.match(body, /fmtTokensShort\(tokens\)/, "and is the token count");
  assert.doesNotMatch(body, /SHOW_TOKENS_AFTER_MS|if \(ms </, 'there is no time threshold');
});

// ---------------------------------------------------------------------------
// 3. stalls are visible
// ---------------------------------------------------------------------------

test('a stall starts after three seconds and fades in', () => {
  assert.match(tuiSrc, /const STALL_AFTER_MS = 3000/);
  assert.match(tuiSrc, /const STALL_FADE_MS = 2000/);
});

test('a running tool is never a stall', () => {
  // The distinguishing case: a long command produces no tokens for minutes and is the picture of health.
  const at = tuiSrc.indexOf('function stallIntensity(');
  assert.ok(at > 0);
  const body = tuiSrc.slice(at, tuiSrc.indexOf('\n}', at));
  assert.match(body, /if \(hasActiveTools\) return 0/, 'a tool suppresses the signal entirely');
});

test('the intensity is interpolated, not switched', () => {
  // A slow model must not look broken for one frame and healthy the next.
  //
  // The CALL site, not the definition: the first occurrence of `stallIntensity(` is the declaration, whose
  // body contains no colour at all.
  const call = tuiSrc.lastIndexOf('const stall = stallIntensity({');
  assert.ok(call > 0, 'the paint path consults it');
  assert.match(tuiSrc.slice(call, call + 400), /lerpColor/, 'and blends the result into the base colour');
});

test('both stamps are written where the events arrive', () => {
  // `lastTokenAt` and `hasActiveTools` are read on the paint path, which cannot tell "slow" from "quiet" —
  // only the event stream can, so the stamps have to be there.
  assert.match(tuiSrc, /if \(e\.type === 'data'\) \{[\s\S]{0,1400}state\.lastTokenAt = Date\.now\(\)/);
  assert.match(tuiSrc, /if \(e\.type === 'tool_start'\) \{[\s\S]{0,300}state\.hasActiveTools = true/);
  assert.match(tuiSrc, /if \(e\.type === 'tool_result'\) \{[\s\S]{0,300}state\.hasActiveTools = false/);
});
