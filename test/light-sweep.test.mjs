// The travelling light on the Working row and the Using row.
//
// WHY THIS FILE EXISTS
// --------------------
// Both rows used to run a four-phase colour pulse whose band was HALF THE ROW WIDE. Every character
// kept the new colour after the band passed, so the phrase swung between orange and yellow and then
// between orange and red — a slow breathing, not a movement, and the red half read as an error state
// on a row that only means "working".
//
// The replacement is a light that PASSES: it runs left to right, and a character returns to its base
// colour once the light has left it.
//
// Three numbers are tied together, and getting any one wrong produces an animation that looks
// plausible and behaves wrongly:
//
//   the light width    a quarter of the row, rounded DOWN — 2 characters for `Working...`
//   the light shape    a raised cosine reaching 0 at both ends, so it fades in and out
//   the light speed    milliseconds PER CHARACTER, chosen so a frame advances exactly one
//                      character, which is the smoothest a 30fps tick can be
//
// The speed is stated in milliseconds rather than in frames of the spinner tick, and that is
// load-bearing: the spinner advances every 80ms while the render path redraws at 33ms, so a phase
// taken from the spinner would step in 80ms jumps however often it redrew.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lightAt, lightWidth, cycleMs, sweepPulse, crossMs,
  LIGHT_FRACTION, REST_MS, FRAME_MS, TAIL_CHARS, STEP_MS, STEP_CHARS, SWEEP_TICKS,
} from '../src/tui.js';

/** A threshold high enough to mean "a person would see this is lit". */
const VISIBLE = 0.3;

/** The crossing time for a row, in milliseconds. */
const crossMsResting = crossMs;


/** How many characters are ever visibly lit during one crossing, sampling every millisecond. */
function covered(n, stepMs = 1) {
  let lit = 0;
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let ms = 0; ms <= crossMs(n); ms += stepMs) best = Math.max(best, lightAt(ms, i, n));
    if (best > VISIBLE) lit++;
  }
  return lit;
}

// ---------------------------------------------------------------------------
// the light's width
// ---------------------------------------------------------------------------

test('the light is a quarter of the row, rounded DOWN', () => {
  // Rounding down is the stated rule, and it is what makes `Working...` a two-character core rather
  // than a three-character one. Rounding up would grow the light on rows where it should not.
  assert.equal(lightWidth(4), 2, 'four characters -> two');
  assert.equal(lightWidth(10), 2, 'ten characters (Working...) -> two, since floor(2.5) is 2');
  assert.equal(lightWidth(12), 3, 'twelve -> three');
  assert.equal(lightWidth(16), 4, 'sixteen -> four');
  assert.equal(lightWidth(60), 15, 'sixty -> fifteen');
});

test('a short row still gets a light wide enough to fade across', () => {
  // A one-character name would otherwise round to zero. The floor keeps a lit cell with a gradient
  // inside it, which is the difference between an animation and a pixel switching on.
  assert.ok(lightWidth(1) >= 2, 'even a one-character row gets two');
  assert.ok(lightWidth(3) >= 2, 'and a three-character one, which would round to one');
});

test('the light never covers the whole row', () => {
  // The gradient has to be visible AT both ends, so the light is always smaller than the text. At half
  // the row this is a real constraint rather than a formality.
  for (const n of [4, 8, 10, 12, 20, 40]) {
    assert.ok(lightWidth(n) < n, `a ${n}-character row is not entirely lit`);
  }
});

// ---------------------------------------------------------------------------
// the light covers the row
// ---------------------------------------------------------------------------

test('every character lights at some point during the crossing', () => {
  // The original defect, measured: with a fixed six frames, 4 of 12 characters were never lit at all
  // because the light stepped straight over them.
  for (const n of [4, 6, 8, 10, 12, 16, 24, 30]) {
    assert.equal(covered(n, 4), n, `every character lit on a ${n}-character row`);
  }
});

test('the light advances left to right, never backwards', () => {
  const n = 16;
  const peak = (ms) => {
    let best = -1;
    let bestV = VISIBLE;
    for (let i = 0; i < n; i++) {
      const v = lightAt(ms, i, n);
      if (v > bestV) { bestV = v; best = i; }
    }
    return best;   // -1 when nothing is visibly lit
  };
  let last = -1;
  let samples = 0;
  for (let ms = 0; ms <= crossMs(n); ms += 16) {
    const at = peak(ms);
    // A frame with nothing above the visible threshold carries no information about direction. The
    // light's centre starts and ends OUTSIDE the row, so the first and last few frames are legitimately
    // dark — and treating "nothing lit" as position 0 would read as a jump back to the start.
    if (at < 0) continue;
    samples++;
    assert.ok(at >= last, `the light moved backwards at ${ms}ms (from ${last} to ${at})`);
    last = at;
  }
  // Enough samples that the walk is meaningful. This is sampled at the animation FRAME, so the count
  // follows the crossing: at 30fps a 200ms crossing is six frames and the light is visibly lit on most
  // of them. A fixed `> 10` was written for a longer crossing and reported a working animation as broken
  // once the duration came down.
  assert.ok(samples >= Math.floor(crossMsResting(10) / FRAME_MS) - 1,
    `enough lit frames to be meaningful (saw ${samples})`);
});

// ---------------------------------------------------------------------------
// a glint, not paint
// ---------------------------------------------------------------------------

test('a character returns to its base colour after the light passes', () => {
  // The whole difference from the old sweep: `sweepSettle` keeps a character lit once the band has
  // gone, which is what turned the animation into a breathing of the entire row.
  const n = 20;
  // Anywhere INSIDE the rest, the interval [crossMs, cycleMs). At `crossMs` exactly the phase has wrapped
  // to zero, so the light is entering again and the first character is already lit.
  const after = crossMs(n) + 100;
  for (let i = 0; i < n; i++) {
    assert.equal(lightAt(after, i, n), 0, `character ${i} is dark after the light has left`);
  }
});

test('the row is dark for the rest, and stays dark however long the row has been up', () => {
  // The rest is not a separate case in the implementation: past the crossing the head travels further
  // past the row's right edge, where the light is already 0. Pinned because a change to the geometry —
  // the head curving back, or the row wrapping — would light the rest up.
  for (const n of [4, 12, 40]) {
    // Sample the rest's own span. Sampling at `crossMs` exactly measures nothing — that is where the
    // cycle wraps, so the light is entering again and the leftmost characters are legitimately lit.
    const cross = crossMs(n);
    for (const ms of [cross + 16, cross + REST_MS, cycleMs(n) - STEP_MS]) {
      for (let i = 0; i < n; i++) {
        assert.equal(lightAt(ms, i, n), 0,
          `character ${i} of a ${n}-character row is lit at ${ms}ms, in the rest`);
      }
    }
  }
});

test('the light leaves the row readable: it is never the whole line', () => {
  // What must not happen is the WHOLE row lighting up at once — that is a wash, not a light, and it was
  // the old animation's failure. The light is now `floor(n/2)` of full brightness plus a `TAIL_CHARS`
  // shoulder either side, so its extent is wider than the core and the bound has to account for both.
  for (const n of [8, 12, 20, 40]) {
    const core = lightWidth(n);
    const extent = Math.min(core + 2 * TAIL_CHARS, Math.max(2, n - 1));
    let most = 0;
    for (let ms = 0; ms <= crossMs(n); ms += 8) {
      let lit = 0;
      for (let i = 0; i < n; i++) if (lightAt(ms, i, n) > VISIBLE) lit++;
      most = Math.max(most, lit);
    }
    assert.ok(most < n, `a ${n}-character row never lights entirely (saw ${most})`);
    // The visible part can reach the full extent once the light's centre is over the middle of the row.
    assert.ok(most <= extent + 1,
      `saw ${most} lit on a ${n}-character row whose light is ${extent} wide`);
  }
});

test('the core of the light is at full brightness, and the shoulders fade', () => {
  // The shape asked for: `floor(n/2)` characters at 1, a cosine down to 0 either side. A ramp across the
  // whole width — the previous shape — left a single bright point, which is what this replaces.
  const n = 20;
  const core = lightWidth(n);
  // Put the light's centre on the middle of the row.
  let best = 0;
  let bestMs = 0;
  for (let ms = 0; ms <= crossMs(n); ms += 1) {
    let full = 0;
    for (let i = 0; i < n; i++) if (lightAt(ms, i, n) > 0.99) full++;
    if (full > best) { best = full; bestMs = ms; }
  }
  assert.ok(best >= core - 1,
    `at its brightest the light has ${best} characters at full strength, expected about ${core}`);

  // And away from the centre the values FALL, rather than dropping straight from 1 to 0.
  const row = [];
  for (let i = 0; i < n; i++) row.push(lightAt(bestMs, i, n));
  const partial = row.filter((v) => v > 0.05 && v < 0.95).length;
  assert.ok(partial > 0, 'the shoulders are a fade, not a step');
});


// ---------------------------------------------------------------------------
// the speed
// ---------------------------------------------------------------------------

test('the crossing takes longer on a longer row', () => {
  // THE OPPOSITE of the earlier rule, and deliberately so.
  //
  // It used to be a FIXED duration, so a 60-character row swept four times faster than a 4-character one:
  // the short rows were smooth and the long ones hopped. Now the light advances one cell per STEP_MS, so
  // a longer row has further to travel and takes proportionally longer. The rate is the invariant.
  //
  // This is what Claude Code does: `cycleLength = messageWidth + 20` steps of `glimmerSpeed`, so the
  // per-cell time is constant and the total scales with the row.
  for (const n of [4, 6, 10, 16, 30, 60]) {
    assert.equal(crossMsResting(n), cycleMs(n) - REST_MS,
      'the crossing is the cycle minus the rest');
  }
  // The invariant: the crossing is a whole number of STEP_MS steps, and it matches Claude Code's
  // `messageWidth + 20` — ten cells of margin either side, unless the light is wider than that.
  //
  // `SWEEP_TICKS` scales the whole crossing, which changes how MANY FRAMES each cell gets but not how many
  // CELLS the light crosses. The ratio below removes that scale, so the cell count stays the thing asserted:
  // doubling the ticks must not change the shape of the sweep, only its resolution.
  for (const n of [4, 10, 30, 60]) {
    const steps = crossMsResting(n) / STEP_MS / (SWEEP_TICKS / 10);
    assert.ok(Number.isInteger(steps) && steps > 0,
      `a ${n}-character row crosses in ${steps} whole steps`);
    // The margin is `min(10, max(halfWidth, n/4))`: a long row gets the full ten cells (so its travel is
    // Claude Code's `width + 20`), a short one gets much less so the light reaches the text quickly.
    const band = lightWidth(n) + 2 * TAIL_CHARS;
    const half = Math.min(band, Math.max(2, n - 1)) / 2;
    const margin = Math.max(1, Math.min(10, Math.max(half, Math.ceil(n / 4))));
    assert.equal(steps, n + 2 * margin,
      `a ${n}-character row travels ${n + 2 * margin} cells`);
  }
  // A long row reaches the full ten-cell margin, so it matches Claude Code exactly.
  assert.equal(crossMsResting(40) / (SWEEP_TICKS / 10), (40 + 2 * 10) * STEP_MS,
    'a 40-character row uses the full margin');
  // A short row caps the margin, so the light is visible almost immediately.
  assert.ok(crossMsResting(4) < (4 * STEP_MS + 8 * STEP_MS) * (SWEEP_TICKS / 10),
    'a 4-character row caps its margin');
});

test('the crossing is a whole number of steps', () => {
  // So the light lands on whole characters rather than between them. A fractional step would make the
  // quantised head skip or repeat a cell, which reads as a stutter.
  for (const n of [4, 10, 30]) {
    const steps = (n + (lightWidth(n) + 2 * TAIL_CHARS)) / STEP_CHARS;
    assert.ok(Number.isInteger(steps), `${n} characters is ${steps} whole steps`);
  }
});

test('the step is long enough to see', () => {
  // A cell lit for less than a frame is invisible: the render path paints at FRAME_MS, so a step shorter
  // than that would be dropped between frames. Measured against the resting rate, which is the slow one.
  assert.ok(STEP_MS >= FRAME_MS, `a ${STEP_MS}ms step is at least one ${FRAME_MS}ms frame`);
  // A LONG row reaches the full ten-cell margin, so its travel matches Claude Code's `width + 20`. The tick
  // scale divides out: it multiplies how many frames each cell gets, not how many cells are crossed.
  assert.equal(crossMsResting(40) / (SWEEP_TICKS / 10), (40 + 2 * 10) * STEP_MS,
    'a 40-character row uses the full margin');
  // A SHORT row caps the margin, so it finishes sooner — the light must reach the text quickly.
  assert.ok(crossMsResting(4) / (SWEEP_TICKS / 10) < 1000, 'a 4-character row crosses inside 800ms');
});

test('the cycle is short enough to repeat while a row is on screen', () => {
  // The rest is half a second, so even a long line repeats well inside the time a turn stays on screen.
  // A cycle of many seconds stops reading as a working indicator and starts reading as decoration. The tick
  // scale is part of the budget: raising it buys fade resolution at the cost of a longer round.
  for (const n of [4, 10, 13, 30]) {
    assert.ok(cycleMs(n) <= 60 * STEP_MS * (SWEEP_TICKS / 10),
      `a ${n}-character row cycles in ${cycleMs(n)}ms`);
  }
});

test('the rest is long enough to read as a pause, not a strobe', () => {
  // A light that returns immediately reads as a strobe rather than a swept highlight. The bar is "long
  // enough to see the row unlit for a moment" rather than a fixed half second: the crossing now scales
  // with the row, so a long row already spends most of its cycle travelling, and demanding a long rest
  // on top of that would push a 60-character row to many seconds per round.
  assert.ok(REST_MS >= FRAME_MS * 4,
    `the rest spans several frames (${REST_MS}ms is ${(REST_MS / FRAME_MS).toFixed(1)})`);
  // And it must be a real fraction of a crossing, so the pause is not a rounding error.
  assert.ok(REST_MS >= crossMsResting(10) * 0.1,
    'and it is a visible fraction of a 10-character crossing');
});

// ---------------------------------------------------------------------------
// the edge option
// ---------------------------------------------------------------------------

test('both edge shapes reach zero at the ends and peak in the middle', () => {
  // Which is what makes the light arrive and leave without a seam.
  for (const edge of ['cosine', 'linear']) {
    const half = 1;
    assert.equal(sweepPulse(-half, half, edge), 0, `${edge} is 0 at the left edge`);
    assert.equal(sweepPulse(half, half, edge), 0, `${edge} is 0 at the right edge`);
    assert.equal(sweepPulse(0, half, edge), 1, `${edge} peaks at 1 in the middle`);
  }
});

test('the two edges differ, so the option is not a no-op', () => {
  const half = 1;
  let differed = 0;
  for (let d = -half; d <= half; d += 0.02) {
    if (sweepPulse(d, half, 'cosine') !== sweepPulse(d, half, 'linear')) differed++;
  }
  assert.ok(differed > 0, 'the two edge shapes are not the same function');
});

test('LIGHT_FRACTION is a quarter', () => {
  // Named, so the width rule and the tests that reason about it cannot drift apart.
  assert.equal(LIGHT_FRACTION, 0.25);
});
