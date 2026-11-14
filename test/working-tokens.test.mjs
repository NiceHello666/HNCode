// The working row's elapsed tail carries the turn's OUTPUT tokens:
//
//   Working... [10m 50s | 50k tokens]      while it runs
//   [turn took 10m 50s | 50k tokens]       once it ends
//
// WHY THESE ASSERTIONS
// --------------------
// The count is per TURN, not per request and not per session. A turn that calls tools makes
// several requests, each reporting its own output tokens; using `state.lastUsage` would show only
// the final one, and using `state.usage` would show everything since the session began. So the
// accumulation and the reset are both worth pinning.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const { readFileSync } = fs;

const { makeState, composeFrame } = await import('../src/tui.js');

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function working(tokens, ms = 650000) {
  const cfg = { provider: 'p', model: 'm', endpoint: 'x', apiKey: 'k', workspace: process.cwd(), raw: {} };
  const s = makeState({ cfg, session: { id: 'p', messages: [], transcript: [] }, opts: {} });
  s.cfg = cfg;
  s.chat = [];
  s.running = true;
  s.workMsg = 'Accelerating...';
  s.turnStart = Date.now() - ms;
  s.turnOutputTokens = tokens;
  s.startAnim = null;
  s.pulseStart = 0;
  return composeFrame(s, 90, 24).lines.map(plain).find((l) => /Accelerating|turn took/.test(l)) || '';
}

test('the tail renders ` <time> | <tokens>`', () => {
  assert.match(working(50000), /\[10m 50s \|\s*[^\w\s]*\s*50k tokens\]/);
  assert.match(working(1234), /\[10m 50s \|\s*[^\w\s]*\s*1\.2k tokens\]/);
  assert.match(working(1000), /\[10m 50s \|\s*[^\w\s]*\s*1k tokens\]/);
  assert.match(working(999), /\[10m 50s \|\s*[^\w\s]*\s*999 tokens\]/);
});

test('the singular is used for exactly one token', () => {
  // The one count small enough to read as a word.
  assert.match(working(1), /\[10m 50s \|\s*[^\w\s]*\s*1 token\]/);
  assert.doesNotMatch(working(1), /1 tokens/);
  assert.match(working(2), /\[10m 50s \|\s*[^\w\s]*\s*2 tokens\]/);
});

test('zero tokens is shown rather than hidden', () => {
  // An absent counter and a zero one are indistinguishable to the user, and appearing
  // partway through a turn makes the row jump width under the eye.
  const line = working(0);
  assert.match(line, /\[10m 50s \|\s*[^\w\s]*\s*0 tokens\]/);
});

test('the large-count format agrees with Claude Code', () => {
  // The same rule `Intl` compact notation applies, which is what Claude Code shows. A figure must
  // not read differently in the two tools.
  //
  // The old rule switched to whole thousands at 10k and had no unit above `k`, so 1.2M displayed as
  // `1235k` — the reader had to count digits to see the size.
  assert.match(working(12400), /\[10m 50s \|\s*[^\w\s]*\s*12\.4k tokens\]/, 'a decimal is kept past 10k');
  assert.match(working(1234567), /\[10m 50s \|\s*[^\w\s]*\s*1\.2M tokens\]/, 'a million gets its own unit');
  assert.doesNotMatch(working(1234567), /1235k/, 'and not a k-count that has to be converted');
  assert.match(working(999999999), /\[10m 50s \|\s*[^\w\s]*\s*1B tokens\]/, 'so does a billion');
});

test('a value that rounds up to the next unit is shown in that unit', () => {
  // 999999 is 999.999k, which rounds to `1000k` — and `1000k` is `1m`. Leaving it as `1000k` makes
  // the reader do the conversion the formatter exists to do for them.
  assert.match(working(999999), /\[10m 50s \|\s*[^\w\s]*\s*1M tokens\]/);
  assert.doesNotMatch(working(999999), /1000k/);
  assert.match(working(999999999), /\[10m 50s \|\s*[^\w\s]*\s*1B tokens\]/);
  assert.doesNotMatch(working(999999999), /1000m/);
});

test('the count is rounded down, never overflowing into the next unit by accident', () => {
  // `Math.floor` on the raw count keeps a display from claiming more than arrived.
  assert.match(working(1999), /\[10m 50s \|\s*[^\w\s]*\s*2k tokens\]/, '1.999k reads as 2k, not 2.0k');
  assert.match(working(1000), /\[10m 50s \|\s*[^\w\s]*\s*1k tokens\]/, 'and exactly 1000 is 1k, not 1.0k');
});

test('the count moves as output arrives, not only at the end', () => {
  // The `usage` event carries the whole request and lands after it, so counting only there left
  // the row at 0 for the entire reply. Each chunk is estimated on arrival; the provider figure
  // then REPLACES the estimate, because it covers the whole request.
  const src = readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  // The token counter lives on the host, which both front ends share.
  const hostSrc = readFileSync(new URL('../src/session-host.js', import.meta.url), 'utf8');

  // UNROUNDED on the streaming paths. A delta is a few characters, and rounding each one up
  // billed three characters as a whole token: summed over a step the figure read about a third
  // HIGH, and it visibly dropped when the exact count replaced it. See `estimateTokensFloat`.
  assert.match(src, /countOutputTokens\(estimateTokensFloat\(e\.text\)\)/, 'the answer counts on arrival');
  assert.match(src, /countOutputTokens\(estimateTokensFloat\(e\.chunk\)\)/, 'and so does a tool call\'s arguments');
  assert.match(hostSrc, /st\.turnOutputEstimate = \(st\.turnOutputEstimate \|\| 0\) \+ add;/, 'the accumulation lives in the helper');
  assert.match(src, /turnOutputEstimate = 0;/, 'the usage event clears the estimate rather than adding to it');
  assert.match(src, /state\.turnOutputSettled = \(state\.turnOutputSettled \|\| 0\) \+ e\.usage\.output/, 'finished requests accumulate across a turn');
  // Only the DISPLAYED total is rounded, so the running figure is not quantised to whole tokens.
  assert.match(hostSrc, /turnOutputTokens = Math\.round\(/, 'the displayed total is what gets rounded');
});

test('summing stream deltas does not inflate the count', () => {
  // The regression, stated as arithmetic. A per-chunk estimate that ROUNDS UP is right for one finished body
  // and wrong for a stream: `ceil(3 / 4)` is 1, so three characters billed a whole token, and a turn's worth of
  // small deltas read about a third high.
  //
  // THE TWO ESTIMATORS ARE DIFFERENT ON PURPOSE, and this is the property that matters:
  //
  //   `estimateTokensFloat` prices a FRAGMENT, with the character-class rule. It is state-free, so a fragment and
  //     the whole text cost the same per character, and a chunked sum equals a one-shot measurement.
  //   `estimateTokens` prices a WHOLE STRING, with the segment rule, which is what `o200k` does and which lands
  //     within a few percent of the real tokenizer. It cannot be applied to a fragment: a delta starts and ends
  //     mid-word, and a chunked sum of segment prices came out at 1.86x.
  //
  // So the sum is compared with the SAME rule applied once to the whole text.
  return import('../src/term.js').then(({ estimateTokens, estimateTokensFloat, estimateTokensByClass }) => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running. '.repeat(20);

    let rounded = 0;
    let exact = 0;
    for (let i = 0; i < text.length; i += 3) {
      rounded += estimateTokens(text.slice(i, i + 3));
      exact += estimateTokensFloat(text.slice(i, i + 3));
    }

    // The unrounded sum matches the one-shot measurement of the same text...
    assert.equal(Math.round(exact), Math.round(estimateTokensByClass(text)),
      'chunked accumulation must agree with measuring the whole string');
    // ...while the rounded one does not, by a wide margin.
    assert.ok(rounded > estimateTokensByClass(text) * 1.2,
      `rounded chunks inflate the total: ${rounded} vs ${estimateTokensByClass(text)}`);
  });
});

test('the elapsed tail is built in one place', () => {
  // Three rows draw it — the steady row, the reduced-motion row and the start animation — plus
  // the final `[turn took …]`. Four call sites of one helper is what keeps them from drifting.
  const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  assert.match(src, /^function elapsedTail\(ms, tokens\) \{/m, 'elapsedTail must exist');
  const uses = (src.match(/elapsedTail\(/g) || []).length;
  assert.ok(uses >= 5, `elapsedTail has ${uses} mentions; expected the definition plus four uses`);
  // And nothing else may assemble the brackets by hand.
  const handBuilt = src.match(/` \[\$\{fmtDuration\(/g) || [];
  assert.deepEqual(handBuilt, [], 'the bracket tail must not be assembled inline anywhere');
});

test('a token count of exactly 1 is the only singular', () => {
  // Guarded here rather than in the row test so a pluralisation change is caught once.
  const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  assert.match(src, /v === 1 \? '' : 's'/, 'the plural rule');
});

test('every token formatter in the product agrees on the same value', () => {
  // THREE functions render token counts into ONE frame — the working row (fmtTokensShort), the
  // /ctx and /usage readouts (fmtTokens), and the context bar's segments and caption
  // (compactTokens). They had drifted apart twice: 1024-based units next to 1000-based ones made
  // `97k` and `94.7k` for the same count, and a trailing `.0` survived in two of them.
  //
  // The implementations are pulled from the real source rather than restated, so this test cannot
  // pass against a copy that has drifted from the code.
  const grab = (src, decl) => {
    const i = src.indexOf(decl);
    assert.ok(i > 0, `${decl} exists`);
    return src.slice(i, src.indexOf('\n}', i) + 2);
  };
  const tui = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  const barSrc = fs.readFileSync(new URL('../src/context-bar.js', import.meta.url), 'utf8');

  const tuiScale = new Function(`${grab(tui, 'function scaleUnit(')}; return scaleUnit;`)();
  const fmtTokens = new Function('scaleUnit', `${grab(tui, 'function fmtTokens(')}; return fmtTokens;`)(tuiScale);
  const fmtShort = new Function('scaleUnit', `${grab(tui, 'function fmtTokensShort(')}; return fmtTokensShort;`)(tuiScale);
  const barScale = new Function(`${grab(barSrc, 'function scaleUnit(')}; return scaleUnit;`)();
  const compact = new Function('scaleUnit', `${grab(barSrc, 'function compactTokens(')}; return compactTokens;`)(barScale);

  const strip = (s) => s.replace(/ tokens?$/, '');
  // The interesting values: unit boundaries, the rounding edge, and realistic context sizes.
  const values = [0, 1, 999, 1000, 1200, 1500, 97000, 100000, 128000, 200000, 262144,
    999999, 1000000, 1234567, 999999999];

  for (const v of values) {
    const a = fmtTokens(v);
    const b = compact(v);
    const c = strip(fmtShort(v));
    assert.equal(a, b, `fmtTokens and compactTokens disagree at ${v}`);
    assert.equal(b, c, `compactTokens and fmtTokensShort disagree at ${v}`);
  }

  // And the shape itself, so a future "improvement" to one of them is caught here rather than on
  // screen: no trailing `.0`, K/M/B/T suffixes, one unit above the last threshold.
  assert.equal(fmtTokens(97000), '97k', 'no trailing .0');
  assert.equal(fmtTokens(262144), '262k', 'a tenth is noise this large');
  assert.equal(fmtTokens(1234567), '1.2M', 'its own unit, upper case like M/B/T');
  assert.equal(fmtTokens(999999), '1M', 'rounding up reaches the next unit');
});