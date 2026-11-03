// The streaming path must actually go THROUGH the paced buffer.
//
// The buffer has its own unit tests, but those pass whether or not the TUI uses it: a
// regression that reverted a call site to `appendAssistant(e.text)` would leave the
// buffer perfect and unused, and the smoothing would silently stop. `startTUI` builds
// its handlers inside a closure, so the wiring is asserted at the source level — the
// same technique `picker-hints.test.mjs` uses to keep hints honest.
//
// The file is CRLF, so every pattern below matches whitespace with `\s` rather than a
// literal `\n`, and the assertions use `assert.ok(RE.test(src), msg)` so a failure
// reports the message instead of dumping 800KB of source into the output.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TUI = path.join(import.meta.dirname, '..', 'src', 'tui.js');
const src = fs.readFileSync(TUI, 'utf8');

const has = (re, msg) => assert.ok(re.test(src), msg);

test('the answer and reasoning deltas are pushed into the buffer, not painted directly', () => {
  // The `data` handler is the answer-text path.
  const data = /if \(e\.type === 'data'\) \{([\s\S]*?)\s{8}\}/.exec(src);
  assert.ok(data, "the 'data' handler was not found");
  assert.ok(/sessHost\.streamBuf\.pushText\(e\.text\)/.test(data[1]),
    "the 'data' handler must feed the buffer rather than call appendAssistant directly");
  assert.ok(!/appendAssistant\(e\.text\)/.test(data[1]),
    "the 'data' handler still paints the delta directly, bypassing the pacing");

  // The `think` handler is the reasoning path.
  const think = /if \(e\.type === 'think'\) \{([\s\S]*?)\s{8}\}/.exec(src);
  assert.ok(think, "the 'think' handler was not found");
  assert.ok(/sessHost\.streamBuf\.pushReasoning\(e\.text\)/.test(think[1]),
    "the 'think' handler must feed the buffer so reasoning is paced with the answer");
  assert.ok(!/appendThinking\(e\.text\)/.test(think[1]),
    "the 'think' handler still paints the delta directly");
});

test('every path that ends a turn drains the buffer first', () => {
  // Leaving text buffered past the end of its turn is the visible failure mode: the
  // reply keeps trickling out behind the tool row, or behind the next turn.
  const drains = [
    // The window is generous because the handler carries a long comment explaining WHY the drain is here.
    // A tight window made this assertion pass on the code being present and fail on it being documented.
    [/if \(e\.type === 'tool_start'\) \{[\s\S]{0,2000}?flushStream\(\)/, 'tool_start'],
    // `aborted` (the LLM stream) and `stopped` (the agent loop, which is what Esc does while a tool runs)
    // share one branch, so the pattern accepts either guard.
    [/if \(e\.type === 'aborted'[^\n]*\{[\s\S]{0,600}?flushStream\(\)/, 'aborted/stopped'],
    // The turn teardown: `finishAnim`/`startAnim` are cleared, then the buffer drains,
    // then `running` flips false.
    [/state\.startAnim = null;[\s\S]{0,400}?flushStream\(\);[\s\S]{0,40}?state\.running = false;/, 'turn end'],
  ];
  for (const [re, what] of drains) has(re, `${what} must call flushStream() before the turn is torn down`);
});

test('a paced tick exists and is a no-op when the buffer is empty', () => {
  // The tick is what drains a lone burst when no further delta arrives. It must stand
  // down when there is nothing buffered, or an idle session spins for nothing.
  const tick = /const streamTimer = setInterval\(\(\) => \{([\s\S]*?)\}, STREAM_TICK_MS\);/.exec(src);
  assert.ok(tick, 'the paced reveal tick was not found');
  assert.ok(/if \(streamBuf\.isEmpty\) return;/.test(tick[1]),
    'the tick must return early when the buffer is empty');
  assert.ok(/drainStream\(\)/.test(tick[1]), 'the tick must actually drain the buffer');

  // And it must be cleared on exit, like every other timer.
  has(/clearInterval\(streamTimer\)/, 'the paced tick must be cleared on exit');
});

test('the delta handlers apply the ops the push hands back', () => {
  // The push methods do not only queue: they return the characters the pacing controller
  // says are due RIGHT NOW, and those characters are already off the queue when they come
  // back. A handler that calls the push for its side effect alone drops them — measured as
  // the first 32 characters of a coalesced reply, which also swallowed the leading prose
  // and the `<|plan|>` tag, so Plan mode saw no plan at all. The behavioural half of this
  // check is tools/check_stream_paint.mjs (driven by stream-e2e.test.mjs); this one fails
  // FAST and names the call site.
  const data = /if \(e\.type === 'data'\) \{([\s\S]*?)\s{8}\}/.exec(src);
  assert.ok(data, "the 'data' handler was not found");
  assert.ok(/applyStreamOps\(sessHost\.streamBuf\.pushText\(e\.text\)\)/.test(data[1]),
    'the returned ops of streamBuf.pushText must be APPLIED, not dropped');

  const think = /if \(e\.type === 'think'\) \{([\s\S]*?)\s{8}\}/.exec(src);
  assert.ok(think, "the 'think' handler was not found");
  assert.ok(/applyStreamOps\(sessHost\.streamBuf\.pushReasoning\(e\.text\)\)/.test(think[1]),
    'the returned ops of streamBuf.pushReasoning must be APPLIED, not dropped');
});

test('the plan finalize drains the paced buffer before it reads the transcript', () => {
  // The review prompt and the plan the user APPROVES are taken out of the bubbles, while
  // the buffer can still be holding the tail of the reply (a provider that coalesces its
  // deltas drains over seconds). Reading first summarised — and approved — a truncated
  // plan. The block's own comment promised this drain; the code never did it.
  const start = src.indexOf('// ---- PLAN MODE: finalize the plan and ask to proceed');
  assert.ok(start > 0, 'the plan finalize block was not found');
  const end = src.indexOf('// Approved plan: Plan mode OFF', start);
  const block = src.slice(start, end > 0 ? end : start + 4000);
  const flush = block.indexOf('flushStream();');
  const read = block.indexOf('const lastAssistant =');
  assert.ok(flush >= 0, 'the plan finalize must drain the buffer');
  assert.ok(read >= 0, 'the plan finalize must read the transcript');
  assert.ok(flush < read,
    'the buffer must be drained BEFORE the transcript is read, or the approved plan is whatever had trickled out by then');
});

test('the buffer is constructed once, and the tick interval is finer than the spinner', () => {
  assert.match(src, /streamBuf = sessHost\.streamBuf|new StreamBuffer\(\)/,
    'the TUI must reach the one buffer, not build its own');

  // Exactly ONE construction, across the files that could hold it: two buffers would each
  // release the same characters and the transcript would show them twice.
  const owners = ['tui.js', 'session-host.js', 'stream-buffer.js']
    .map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
    .join('\n');
  const builds = owners.match(/new StreamBuffer\(\)/g) || [];
  assert.equal(builds.length, 1, `expected one buffer construction, found ${builds.length}`);
  const ms = /const STREAM_TICK_MS = (\d+);/.exec(src);
  assert.ok(ms, 'the tick interval constant was not found');
  const tickMs = Number(ms[1]);
  // The spinner tick is 80ms. Draining at that rate reveals a burst in ~48-character
  // steps, which is the stair-step the buffer exists to remove, so the reveal tick has
  // to be meaningfully finer.
  assert.ok(tickMs <= 32,
    `a ${tickMs}ms reveal tick is too coarse to look smooth (the spinner tick is 80ms)`);
  assert.ok(tickMs >= 8,
    `a ${tickMs}ms reveal tick would burn CPU for no visible gain`);
});