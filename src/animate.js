// The travelling-light animation, and the spinner that goes with it.
//
// Everything here is geometry: a phase in milliseconds becomes a brightness per character. No module here knows what
// a transcript is, which is what lets the same sweep drive the Working row and a pending tool row without the two
// drifting apart — they were once two hand-written copies of the same loop, and one of them stepped at a different
// rate until its light never finished a round.

import { lerpColor } from './colors.js';
import { col } from './text.js';

// Braille spinner frames for the "Working" indicator (orange).
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// The REDUCED-MOTION spinner: a single dot that breathes on a slow cycle rather than rotating a glyph. A fully static
// glyph reads as "hung", so the slow brightness change is what says "still working" without any motion. Two seconds
// is slow enough not to draw the eye.
export const REDUCED_MOTION_DOT = '●';
export const REDUCED_MOTION_CYCLE_MS = 2000;

// Stand-in for the LIVE spinner glyph inside a CACHED row. A pending thinking block must not be re-wrapped by the
// spin tick, so its preview is cached with this sentinel and the real frame is substituted afterwards. It occupies
// zero columns, so the swap never disturbs the layout.
export const SPIN_PLACEHOLDER = '\u0000';

/** Is reduced motion on for this session? Read from the state, or the env override. */
export function reducedMotionOn(state) {
  if (!state) return false;
  if (state.reducedMotion !== undefined) return !!state.reducedMotion;
  const env = process.env.HNCODE_REDUCED_MOTION;
  if (env !== undefined) return /^(1|true|yes|on)$/i.test(env);
  return !!(state.cfg && state.cfg.reducedMotion);
}

/**
 * The frames a SPINNER-style animation shows: { glyph, dim }.
 *
 * In normal mode the glyph rotates and is never dim. In reduced motion the glyph is a constant dot whose brightness
 * flips once per second. Returning both pieces means every caller — the Working row, a pending tool, a thinking
 * preview — gets the same treatment from one place.
 */
export function spinnerFrame(state, tick) {
  if (reducedMotionOn(state)) {
    const t = tick !== undefined ? tick : (state && state.spin) || 0;
    return { glyph: REDUCED_MOTION_DOT, dim: Math.floor(t / (REDUCED_MOTION_CYCLE_MS / 80)) % 2 === 1 };
  }
  const n = SPINNER.length;
  const i = ((tick !== undefined ? tick : (state && state.spin) || 0) % n + n) % n;
  return { glyph: SPINNER[i], dim: false };
}

/**
 * A sweep that SETTLES: a character the band has passed stays at 1.
 *
 * The shape the Working row's colour phase needs, and two earlier attempts got it wrong by reusing a travelling
 * PULSE: a ramp DOWN as the head passes makes a character light up and then go dark again, so the phrase never
 * becomes orange at all.
 *
 * The convention, stated once:
 *
 *   `dist >= 0`          the band is past this character -> 1 (settled)
 *   `-half < dist < 0`   the band is on it -> ramp 0 -> 1
 *   `dist <= -half`      not reached yet -> 0
 *
 * `dist` is `head - position`, so a LARGER `dist` means "further behind the head". `edge` shapes only the transition:
 * `cosine` keeps both ends gentle, `linear` is sharpest at the settle point.
 */
export function sweepSettle(dist, half, edge = 'cosine') {
  const h = Math.max(1e-6, half);
  if (dist >= 0) return 1;              // passed: stays lit
  if (dist <= -h) return 0;             // not yet reached
  const x = (dist + h) / h;             // 0 at the far edge, 1 at the settle point
  return edge === 'linear' ? x : 0.5 * (1 - Math.cos(Math.PI * x));
}

/**
 * A sweep that PASSES: a character lights up under the band and returns to 0 after it.
 *
 * The counterpart to `sweepSettle`, and the difference is the whole point:
 *
 *   sweepSettle  a character the band has passed STAYS at 1 — paint being laid down
 *   sweepPulse   a character returns to 0 once the band leaves — a light moving over
 *
 * `half` is the HALF-width of the light, so `2 * half` is its full width, and `flat` is the half-width of its FULLY
 * LIT CORE:
 *
 *   |dist| <= flat          the core, at 1
 *   flat < |dist| < half    a shoulder, falling from 1 to 0
 *
 * Both outer ends reach 0, which is what makes the light arrive and leave without a seam. `flat = 0` ramps across
 * the whole width leaving a single bright point; `flat = half` is a solid block with no fade.
 */
export function sweepPulse(dist, half, edge = 'cosine', flat = 0) {
  const h = Math.max(1e-6, half);
  if (dist <= -h || dist >= h) return 0;   // outside the light
  const core = Math.max(0, Math.min(h, flat));
  const a = Math.abs(dist);
  if (a <= core) return 1;
  const x = (a - core) / (h - core);       // 0 where the core ends, 1 at the outer edge
  if (edge === 'linear') return 1 - x;
  return 0.5 * (1 + Math.cos(Math.PI * x)); // raised cosine from 1 down to 0
}

/**
 * The light's CORE width as a fraction of the row.
 *
 * Claude Code's shimmer has no core at all — a single index is bright. A glint is a point travelling along the row,
 * not a wash sweeping over it.
 */
export const LIGHT_FRACTION = 1 / 4;

/** Milliseconds per unit of `state.spin`. The spinner advances every 80ms, so a caller holding a tick count needs
 *  this to convert — named here so the timer and the geometry cannot drift apart. */
export const SPIN_TICK_MS = 80;

/**
 * The light's FULLY LIT CORE, in characters: a quarter of the row, rounded down.
 *
 * Rounding down is deliberate: `Working...` is ten characters, so its core is two. A fractional width is something
 * no terminal draws. The floor of 2 keeps a short row visible — a one-character core with a fade either side barely
 * registers.
 *
 * This is the core, NOT the total extent: `TAIL_CHARS` of fade is added either side.
 */
export function lightWidth(n) {
  return Math.max(2, Math.floor(n * LIGHT_FRACTION));
}

/** The fade either side of the core, in characters. Two, not one: a band of one character is wide enough in
 *  truecolor but vanishes under 256 colours, where a single lit cell is a blink. */
export const TAIL_CHARS = 4;

/**
 * The light's half-width, INCLUDING the fade. This is the extent `lightAt` sweeps.
 *
 * THE TAILS ARE CAPPED so the light stays narrower than the row: the total is held to `n - 1`, which keeps at least
 * one dark column at each end. Those dark columns are what make the light read as an object with edges instead of as
 * a row that brightens and dims.
 *
 * The CORE gives way first — `coreHalf` shrinks with the cap — because the fade is what makes the light arrive and
 * leave smoothly, and a short row needs that more than a wide middle.
 */
function totalHalf(n) {
  const want = lightWidth(n) + 2 * TAIL_CHARS;
  const capped = Math.min(want, Math.max(2, n - 1));
  return capped / 2;
}

/** The half-width of the fully lit core, for `sweepPulse`'s `flat` parameter. */
function coreHalf(n) {
  return Math.min(lightWidth(n), totalHalf(n) * 2) / 2;
}

/** The animation's frame rate: 30fps, the whole program's rate for animated rows. */
export const ANIM_FPS = 30;
export const FRAME_MS = 1000 / ANIM_FPS;

/**
 * How long one step of the light lasts, in milliseconds.
 *
 * FIXED, rather than following the output rate. That was tried and dropped: a model writing slowly got a sweep so
 * slow it looked stuck, a fast one got a blur, and the same row changed pace between turns for no reason the reader
 * could see. One rate is calmer and predictable, which is what an ambient indicator needs to be.
 */
export const STEP_MS = 65;

/**
 * The step for a TOOL name, slower than the Working row's.
 *
 * A tool name is short — `Read` is four characters — so at the Working row's rate the light crosses it quickly and
 * the row is dark for the rest of the cycle, which reads as a single flash rather than as movement.
 */
export const TOOL_STEP_MS = 150;

/**
 * How far outside the row the light starts and ends, in characters.
 *
 * TEN, exactly as Claude Code's `messageWidth + 20` splits into ten either side. This is what sets the pace of a
 * round: a 10-character row travels 30 cells, so a round is 1500ms. A shorter margin made the sweep finish sooner and
 * read as a twitch. It must not be shorter than the light's own half-width either, or the light would still be
 * lighting the last characters when the round ended; `lightMargin` takes the larger of the two.
 */
export const ENTRY_EXIT_CHARS = 10;

/**
 * The margin for a row of `n` characters: the target ten, or the light's half-width if that is larger — but CAPPED so
 * the light reaches the text in reasonable time.
 *
 * Ten cells either side is what makes the timing match on a long row. On a SHORT row it is most of the cycle: `Edit`
 * is four characters, so the light spends its first several steps still outside the text, showing nothing. A row that
 * looks frozen and then blinks once reads as broken.
 */
export function lightMargin(n) {
  const half = totalHalf(Math.max(1, n));
  return Math.max(1, Math.min(ENTRY_EXIT_CHARS, Math.max(half, Math.ceil(Math.max(1, n) / 4))));
}

/**
 * The crossing time for a row of `count` characters — ONE FULL ROUND, entry and exit included.
 *
 * `SWEEP_TICKS` IS THE RESOLUTION KNOB. At a lower value a ten-character row crossed in too few frames, and the light
 * traversed its own band in a third of that, so each glyph took only a handful of distinct brightness values and the
 * fade read as a step. Every doubling of the tick count doubles the frames each glyph is under the light, which is
 * the only way to make the fade finer without changing its shape or its speed across the row.
 */
export function crossMs(count, stepMs = STEP_MS) {
  const cells = Math.max(1, count) + 2 * lightMargin(count);
  return cells * stepMs * (SWEEP_TICKS / 10);
}

/**
 * The rest between rounds, in milliseconds.
 *
 * NOT zero. With `REST_MS = 0` the sweep wrapped straight back to the start the instant it left the right edge, so
 * the row went from "light on the last letter" to "light on nothing" to "light on the first letter" within two frames
 * — which reads as the animation resetting rather than restarting.
 */
export const REST_MS = 300;

/** The full cycle for a row: one crossing, then the rest. `count` enters into it, because a longer row has more
 *  characters to light. */
export function cycleMs(count, stepMs = STEP_MS) {
  return crossMs(count, stepMs) + REST_MS;
}

/**
 * The wall-clock time the light's animation began, for a row anchored at this tick.
 *
 * `spin` advances every SPIN_TICK_MS while the render path redraws far more often, so a phase taken straight from the
 * tick count steps in 80ms jumps. Converting the anchor ONCE to a wall-clock origin lets every later frame measure
 * real elapsed time instead.
 *
 * The store is MODULE-LEVEL, and deliberately not a field on `state`: the caller for a pending tool row is
 * `formatToolLine`, which has no access to `state`, and reading it there threw "state is not defined" and took the
 * whole TUI down through the unhandledRejection handler. The key is the anchor tick, so a new turn gets a new origin.
 */
const lightOrigins = new Map();

/**
 * @param {string} key     identifies the animation — `tool:12`, `work:12` — so two rows anchored on the same tick
 *                         keep separate origins.
 * @param {number} anchor  the tick the animation began on.
 * @param {number} now     the tick it is being drawn at.
 *
 * `key` and `anchor` are separate arguments on purpose. An earlier version took only the anchor and derived the key
 * from it, so a caller passing an already-prefixed `tool:0` produced `(0 - 'tool:0') * 80` — arithmetic on a string,
 * which is NaN. The origin became NaN, every colour became an invalid escape, and the terminal drew the row in the
 * default colour: a silent failure that looked like the animation simply not running.
 */
export function lightOrigin(key, anchor, now) {
  let origin = lightOrigins.get(key);
  if (origin === undefined) {
    // THE ORIGIN IS "NOW", NOT BACK-DATED FROM THE TICK COUNT.
    //
    // Back-dating picked up the phase the anchor implied, but the first frame a row is DRAWN is not the tick its
    // anchor was set on — the start animation runs first, several ticks earlier. That made the sweep begin part-way
    // across, so the light appeared to jump forward and then restart from the left.
    //
    // `anchor` and `now` stay in the signature because callers pass them and the shape is part of the contract.
    void anchor;
    void now;
    origin = Date.now();
    if (!Number.isFinite(origin)) origin = Date.now();
    // EVICT THE OLDEST, never clear the map. Clearing dropped the origin of the row currently on screen, which was
    // then recreated with a fresh timestamp — the light restarted from the left edge roughly once a second.
    if (lightOrigins.size > 64) {
      const oldest = lightOrigins.keys().next().value;
      lightOrigins.delete(oldest);
    }
    lightOrigins.set(key, origin);
  }
  return origin;
}

/**
 * How lit one character is, given its index and the row length.
 *
 * Returns 0..1. The position arrives as an INDEX and the row length rather than a pre-divided fraction, because the
 * light's width is itself a fraction of the row — both are then in the same unit of "characters", so the light cannot
 * be scaled twice by accident.
 *
 * `phaseMs` is MILLISECONDS within the cycle, not a tick count. Time is the right unit because the light's smoothness
 * depends on how far it moves per RENDERED frame, and the frame rate is not the caller's spinner tick. Stepping by
 * that tick forced a many-second crossing on a long row.
 */
export function lightAt(phaseMs, index, count, edge = 'cosine', stepMs = STEP_MS) {
  const n = Math.max(1, count);
  // `half` is the OUTER edge (core plus the fade either side) and `core` is the part that stays at full brightness.
  const half = totalHalf(n);
  const core = coreHalf(n);
  // The character's centre. Measuring against the left edge would make the light peak BETWEEN characters, so each
  // would flash at less than full strength.
  const centre = index + 0.5;
  // The centre crosses from fully off the left of the row to fully off its right, so the light slides in and out
  // rather than popping into existence on the first character.
  //
  // THE REST HALF NEEDS NO SPECIAL CASE. Past the crossing the progress exceeds 1 and the head travels further past
  // the row's right edge — where `sweepPulse` is already 0 — so the light is dark by the same arithmetic that makes it
  // leave.
  const margin = lightMargin(n);
  const travel = n + 2 * margin;
  // THE HEAD IS CONTINUOUS, NOT QUANTISED TO WHOLE STEPS. Rounding here made a ten-character row offer the light
  // about twenty distinct positions, so each glyph saw a handful of brightness values — a visible step ramp. The
  // position is a FLOAT: the pulse is already continuous in `dist`, so every frame lands the light somewhere between
  // two cells and the fade is as fine as the frame rate allows.
  const progress = Math.max(0, Math.min(1, phaseMs / crossMs(n, stepMs)));
  const head = (-margin + progress * travel) * STEP_CHARS;
  // `edge` shapes the shoulder: a raised cosine leaves its outer end gentle, a linear one is sharpest where it meets
  // the core. It arrives as a PARAMETER rather than being read from config, because this is a module-level function
  // and the TUI state lives in a closure — the trap that once made a pending tool row throw and take the TUI down.
  return sweepPulse(head - centre, half, edge, core);
}

/**
 * Paint `text` with the travelling light already mixed into each glyph.
 *
 * ONE FUNCTION FOR BOTH ANIMATED ROWS — the Working row and a pending tool's "Using <Tool>" — because they were two
 * hand-written copies of the same loop. That is how they drifted: one stepped at a different rate inside a different
 * cycle length, and the slow one could not finish a round before its own modulus wrapped.
 *
 * Everything about the light is decided here — the rate, the shoulder shape, the band width — so a change lands on
 * both rows at once.
 *
 * @param {string}   text     the row's text
 * @param {number}   phaseMs  milliseconds into the cycle
 * @param {number[]} base     resting colour, [r, g, b]
 * @param {number[]} glint    the colour the light lifts the text toward
 * @param {string}   edge     shoulder shape: 'cosine' (default) or 'linear'
 * @returns {string}          ANSI, ready to splice into a row
 */
export function shimmerText(text, phaseMs, base, glint, edge = 'cosine', stepMs = STEP_MS) {
  const s = String(text == null ? '' : text);
  const n = s.length;
  if (!n) return '';
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, lightAt(phaseMs, i, n, edge, stepMs)));
    const r = Math.round(base[0] + (glint[0] - base[0]) * t);
    const g = Math.round(base[1] + (glint[1] - base[1]) * t);
    const b = Math.round(base[2] + (glint[2] - base[2]) * t);
    out.push(col(s[i], lerpColor(r, g, b, r, g, b, 0)));
  }
  return out.join('');
}

/** How far the light advances in one step, in characters. One is the most literal reading of "move by letters": the
 *  light lands on a glyph, lights it and its neighbours, then moves on. A larger step reads as a coarser crawl. */
export const STEP_CHARS = 1;

export const SWEEP_TICKS = 20;          // ticks per half-sweep

/** How far past the band the head travels, in band widths. The Working row computes its own head and needs this too, so
 *  it is exported rather than kept private — two copies of the constant would drift. */
export const SWEEP_TRAVEL_PAD = 1;       // head runs from -BAND to 1

/**
 * Band width in characters, scaled to the row so every row is equally smooth.
 *
 * HALF THE ROW, with a floor of 3 characters. Because the band is then always `n/2`, `BAND = 0.5` for every row of 6+
 * characters, so frames-per-character — and therefore the visual smoothness — is the SAME for a short tool name and a
 * long phrase. An earlier version capped the band at 6 characters, which made BAND shrink as the row grew: a long row
 * got fewer frames per character, so the cap defeated the very scaling it was part of.
 */
export function bandCharsFor(n) {
  return Math.max(3, n / 2);
}

/** Frames each character spends inside the band — the smoothness measure. */
export function framesPerChar(n, ticks = SWEEP_TICKS) {
  const BAND = bandCharsFor(n) / n;
  return (BAND * ticks) / (1 + BAND * SWEEP_TRAVEL_PAD);
}


/**
 * A slow, even breath between two colours, for a surface that is WAITING on the user.
 *
 * The screen has exactly one state where the user is the bottleneck: a prompt that blocks the agent until they answer
 * (a tool approval, a plan review, a question). Those boxes are currently drawn in a flat border colour, which reads as
 * ordinary chrome — and a reader busy in another window has no cue that the program has stopped for them.
 *
 * NOT the travelling light. A sweep says "work is happening", which is the opposite of the truth here: nothing is
 * happening until someone presses a key. A breath is the shape for waiting.
 *
 * `t` is a 0..1 triangle over the cycle, so the two ends meet exactly and there is no visible seam when it repeats.
 * Reduced motion collapses this to the resting colour: a surface that fades in and out is motion, and the point of
 * the setting is that there is none.
 *
 * @param {string} rest  the colour the surface rests at (an SGR foreground or background run)
 * @param {string} peak  the colour it breathes toward
 * @param {number} phaseMs milliseconds into the cycle
 * @param {number} cycleMs length of one full breath
 * @param {boolean} [reduced] true to return `rest` unchanged
 */
export function breatheColour(rest, peak, phaseMs, cycleMs = 2400, reduced = false) {
  if (reduced || !peak) return rest;
  // A triangle, not a sine: the two are indistinguishable at this speed and the triangle needs no trig per frame.
  const half = cycleMs / 2;
  const at = ((phaseMs % cycleMs) + cycleMs) % cycleMs;
  const t = at < half ? at / half : 1 - (at - half) / half;
  // The colours arrive as SGR runs, so the blend happens on the NUMBERS inside them rather than on the strings.
  const a = /38;2;(\d+);(\d+);(\d+)/.exec(rest);
  const b = /38;2;(\d+);(\d+);(\d+)/.exec(peak);
  if (!a || !b) return rest;   // a named colour, not truecolor: nothing to interpolate, so leave it alone
  const mix = (i) => Math.round(Number(a[i]) + (Number(b[i]) - Number(a[i])) * t);
  return `\x1b[38;2;${mix(1)};${mix(2)};${mix(3)}m`;
}
