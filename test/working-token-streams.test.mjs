// The working row counts EVERY stream the model produces.
//
// WHY
// ---
// A turn's output is not just the answer. It thinks, then it calls tools, and a tool's arguments
// are model output in full — a Write's file content can dwarf the prose around it. Only `data` was
// counted, so during a step that reasoned first and then wrote a file the number sat almost still
// and only settled when the `usage` event arrived, after the tool had already run.
//
// The counter is asserted through the SOURCE for the three call sites (they are wired inside the
// agent's event handler, which needs a live stream), and the arithmetic is asserted directly.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { makeState, composeFrame } from '../src/tui.js';

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
// The session machinery both front ends share; the token counter lives there now.
const hostSrc = fs.readFileSync(new URL('../src/session-host.js', import.meta.url), 'utf8');

test('the answer, the reasoning and the tool arguments all count', () => {
  // The UNROUNDED measure: each delta is a few characters, and rounding every one up billed three
  // characters as a token, so a step read about a third high and dropped when the exact count
  // replaced it. `estimateTokensFloat` is what the running total accumulates.
  const calls = [...src.matchAll(/countOutputTokens\(estimateTokensFloat\((e\.[a-z]+)\)\);/g)].map((m) => m[1]);
  assert.equal(calls.filter((c) => c === 'e.text').length, 2,
    'the answer and the reasoning stream both arrive as e.text and both must count');
  assert.ok(calls.includes('e.chunk'), 'a tool call\'s arguments count');
  assert.ok(!/countOutputTokens\(estimateTokens\(e\./.test(src),
    'and no streaming site still sums the ROUNDED value');
});

test('the tool\'s OUTPUT does not count', () => {
  // `tool_output` is the tool running, and a `tool_result` is the next request's input. Neither
  // is a token this model produced — the distinction the tok/s meter already makes.
  assert.doesNotMatch(src, /countOutputTokens\(estimateTokens(Float)?\(e\.(output|result)\)\)/);
});

test('the counting goes through one helper', () => {
  // Three call sites with the arithmetic written out three times is how `think` got left out of
  // the first version.
  assert.match(hostSrc, /^  countOutputTokens\(n\) \{/m, 'the helper exists on the host');
  assert.equal((hostSrc.match(/st\.turnOutputEstimate = \(st\.turnOutputEstimate \|\| 0\) \+ add;/g) || []).length, 1,
    'the accumulation happens in exactly one place, on the host both front ends share');
});

test('the counter never goes backwards across the steps of a turn', () => {
  // The visible failure of getting this wrong: it restarts at each step, so the number a user
  // watches is of the current request rather than of the turn.
  const cfg = { provider: 'p', model: 'm', endpoint: 'x', apiKey: 'k', workspace: process.cwd(), raw: {} };
  const s = makeState({ cfg, session: { id: 'p', messages: [], transcript: [] }, opts: {} });
  s.cfg = cfg;
  s.chat = [];
  s.running = true;
  s.workMsg = 'Accelerating...';
  s.turnStart = Date.now() - 5000;
  s.turnOutputTokens = 0;
  s.turnOutputSettled = 0;
  s.turnOutputEstimate = 0;
  s.startAnim = null;
  s.pulseStart = 0;

  const shown = () => {
    const line = composeFrame(s, 90, 24).lines.map(plain).find((l) => l.includes('Accelerating')) || '';
    const m = /\|\s*[^\w\s]*\s*([\d.]+)(k?) tokens\]/.exec(line);
    return m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN;
  };

  const count = (n) => {
    s.turnOutputEstimate += n;
    s.turnOutputTokens = (s.turnOutputSettled || 0) + s.turnOutputEstimate;
  };
  const settle = (n) => {
    s.turnOutputSettled += n;
    s.turnOutputEstimate = 0;
    s.turnOutputTokens = (s.turnOutputSettled || 0) + s.turnOutputEstimate;
  };

  let last = -1;
  const at = (label) => {
    const n = shown();
    assert.ok(Number.isFinite(n), `${label}: the row shows a number`);
    assert.ok(n >= last, `${label}: the count fell from ${last} to ${n}`);
    last = n;
  };

  // Step 1: reasoning, then the answer, then a tool call with a fat argument stream.
  count(40); at('think');
  count(60); at('think');
  count(30); at('answer');
  count(200); at('tool_args');
  count(350); at('tool_args');
  settle(700); at('usage 700');

  // Step 2: the same shape again — this is where a per-step counter restarts.
  count(20); at('think');
  count(100); at('tool_args');
  settle(850); at('usage 850');

  assert.equal(s.turnOutputTokens, 1550, 'the turn total is the sum of its steps');
});

test('the exact usage figure replaces the estimate rather than adding to it', () => {
  // `usage` reports the WHOLE request, reasoning included, so adding it to a running estimate
  // would double what the answer cost.
  assert.match(src, /state\.turnOutputEstimate = 0;/,
    'the estimate is cleared when the exact figure lands');
  assert.match(src, /state\.turnOutputSettled = \(state\.turnOutputSettled \|\| 0\) \+ e\.usage\.output/,
    'and the finished requests accumulate across the turn');
});
