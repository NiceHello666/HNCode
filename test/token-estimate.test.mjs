// The token estimate must be close enough to plan with.
//
// WHY THIS FILE EXISTS
// --------------------
// The estimator was `ascii / 4 + nonAscii`, the "four characters per token" folklore. That holds for
// English prose and for nothing else this application sends. Measured against the real tokenizer it was
// off by up to 35% in the direction that matters — an UNDERCOUNT, so the context gauge read low and
// compaction fired late.
//
// The cause is that BPE merges COMMON SUBSTRINGS, and how much depends on the shape of the text:
// prose repeats whole words, JSON pairs its punctuation, and a CJK paragraph has no spaces to merge on
// at all. The estimator now prices SEGMENTS rather than character classes.
//
// THE REFERENCE IS THE REAL TOKENIZER
// ----------------------------------
// These counts were measured against OpenAI's `o200k_base` (the `gpt-4o` encoding) with tiktoken. The
// project has no dependencies and `o200k_base` is a data file, so the numbers are recorded here rather
// than pulled from a tokenizer at test time.
//
// The previous version of this test compared the estimator against the OLD class-average formula —
// that is, against the thing being replaced. A test that says "the new formula matches the old formula"
// cannot notice that the old formula was 20% out on code and JSON. These counts are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateTokensFloat } from '../src/term.js';

/** The samples, and what `o200k_base` actually charges for each. */
const REAL = {
  'English prose': {
    text: 'The quick brown fox jumps over the lazy dog. '.repeat(20),
    tokens: 201,
  },
  'TypeScript code': {
    text: 'function renderTeamPanel(panel, cols, rows) {\n  const out = [];\n  return out.slice(0, rows);\n}\n'.repeat(5),
    tokens: 130,
  },
  'JSON payload': {
    text: JSON.stringify({ type: 'permission_request', request_id: 'perm-abc123', tool_name: 'Bash', input: { command: 'npm test' } }).repeat(5),
    tokens: 135,
  },
  'Chinese prose': {
    text: '这是一段中文说明，用来测试估算器对中日韩文字的处理是否正确。'.repeat(10),
    tokens: 191,
  },
  'Mixed CJK+code': {
    text: '读取 src/tui.js 并检查 renderFrame 函数。'.repeat(15),
    tokens: 210,
  },
  'minified JSON': {
    text: '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}'.repeat(10),
    tokens: 330,
  },
  'paths and flags': {
    text: 'D:\\hncode\\src\\team-panel.js --include=*.ts --exclude-dir=node_modules '.repeat(10),
    tokens: 201,
  },
  'tool schema': {
    text: JSON.stringify({ type: 'object', properties: { path: { type: 'string', description: 'file to read' } }, required: ['path'] }).repeat(6),
    tokens: 150,
  },
};

test('every content type this app sends is close to the real tokenizer', () => {
  // THE ACCURACY IS `estimateTokens`'s — the entry point that measures a WHOLE string.
  //
  // There are two estimators on purpose. `estimateTokens` prices a whole string by SEGMENT, which is what
  // `o200k` does and which lands within a few percent of the real tokenizer. `estimateTokensFloat` prices a
  // FRAGMENT by character class, because a stream delta starts and ends mid-word and a segment rule cannot be
  // applied to one — the fragment estimator is what makes a chunked sum agree with a one-shot measurement, and
  // its accuracy is not what the gauge depends on.
  //
  // The bar is 30% for the samples where `o200k` merges a RUN of tokens: `function renderTeamPanel` is one run cut
  // into four while a segment estimator cuts it into three segments and charges five. Closing that gap needs the
  // real vocabulary, not a rule, so a TypeScript sample sits at 1.27x.
  //
  // WHY THAT DIRECTION IS SAFE: the error is an OVERCOUNT, and an overcount is what a context gauge wants. The
  // gauge reads high, compaction fires a little early, and the request still fits. The dangerous direction is an
  // UNDERCOUNT, and that is checked separately below.
  for (const [name, { text, tokens }] of Object.entries(REAL)) {
    const est = estimateTokens(text);
    const ratio = est / tokens;
    assert.ok(Math.abs(ratio - 1) <= 0.3,
      `${name}: estimate ${est.toFixed(0)} vs real ${tokens} (${ratio.toFixed(2)}x)`);
    // Never undercount by more than a tenth, in any sample.
    assert.ok(ratio >= 0.9,
      `${name}: estimate ${est.toFixed(0)} vs real ${tokens} (${ratio.toFixed(2)}x) — an undercount lets a request overrun the window`);
  }
});

test('the samples the estimator handles exactly stay within a tenth', () => {
  // The bar for the shapes the rules cover precisely: prose, JSON, paths and the CJK scripts. TypeScript is
  // excluded on purpose and explained in the test above.
  for (const name of ['English prose', 'JSON payload', 'minified JSON', 'paths and flags', 'Chinese prose', 'Mixed CJK+code']) {
    const { text, tokens } = REAL[name];
    const ratio = estimateTokens(text) / tokens;
    assert.ok(Math.abs(ratio - 1) <= 0.1,
      `${name}: estimate ${estimateTokens(text).toFixed(0)} vs real ${tokens} (${ratio.toFixed(2)}x)`);
  }
});


test('the old formula would FAIL that bar — the test has teeth', () => {
  // The control. If someone reverts to `ascii/4 + nonAscii`, this reproduces it and shows the same test
  // would fail, so the assertion above is not vacuous.
  const oldFormula = (s) => {
    let ascii = 0;
    let nonAscii = 0;
    for (const ch of s) { if (ch.codePointAt(0) <= 127) ascii++; else nonAscii++; }
    return ascii / 4 + nonAscii;
  };
  const worst = Object.entries(REAL)
    .map(([name, { text, tokens }]) => ({ name, ratio: oldFormula(text) / tokens }))
    .sort((a, b) => a.ratio - b.ratio)[0];
  assert.ok(worst.ratio < 0.8,
    `the old formula is off by ${((1 - worst.ratio) * 100).toFixed(0)}% on ${worst.name}`);
});

test('the class-average formula the rewrite replaced was also out — on CJK and JSON', () => {
  // The formula this file used to compare against. It is recorded so the move to segment pricing is not mistaken
  // for a change of bar: the OLD bar was itself 20% away from the real tokenizer on the samples below.
  const classAverage = (s) => {
    let wide = 0;
    let letters = 0;
    let digits = 0;
    let space = 0;
    let punct = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp > 127) wide++;
      else if (cp === 32 || cp === 9) space++;
      else if (cp >= 48 && cp <= 57) digits++;
      else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) letters++;
      else punct++;
    }
    return letters / 4.2 + digits / 3.0 + punct / 2.6 + space / 3.0 + wide;
  };
  // The samples the class-average rule got badly wrong, measured: Chinese prose 1.57x, minified JSON 0.52x,
  // tool schema 1.23x, English prose 1.17x. `paths and flags` is NOT among them — the rule happens to be right
  // there (0.96x), and listing it here would have asserted something false.
  for (const name of ['Chinese prose', 'minified JSON', 'tool schema', 'English prose']) {
    const { text, tokens } = REAL[name];
    const ratio = classAverage(text) / tokens;
    assert.ok(Math.abs(ratio - 1) > 0.1, `${name} must be one the class-average rule got wrong`);
  }
});

test('an empty string is zero, not NaN', () => {
  // This runs on every streamed chunk, and an empty one arrives whenever a step ends.
  assert.equal(estimateTokensFloat(''), 0);
  assert.equal(estimateTokens(''), 0);
});

test('the two entry points measure DIFFERENT things, and each is right for its own', () => {
  // `estimateTokens` prices a whole string by segment; `estimateTokensFloat` prices a fragment by character
  // class. They are deliberately different, because a stream delta starts and ends mid-word and the segment
  // rule cannot be applied to one.
  //
  // What must hold is that the FRAGMENT estimator is additive — a chunked sum equals a one-shot measurement of
  // the same text under the same rule — because that is what the running output counter relies on.
  return import('../src/term.js').then(({ estimateTokensFloat, estimateTokensByClass }) => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running. '.repeat(20);
    let sum = 0;
    for (let i = 0; i < text.length; i += 3) sum += estimateTokensFloat(text.slice(i, i + 3));
    assert.equal(Math.round(sum), Math.round(estimateTokensByClass(text)),
      'a chunked sum must equal the whole measured with the same rule');
  });
});

test('CJK costs about one token per character', () => {
  // The one place the old formula was close, and it must stay close: it is the largest per-character rate.
  //
  // `o200k` charges FOUR characters of Chinese as THREE tokens (1.45 characters per token), so the honest
  // expectation is 3 — the old formula's one-per-character was itself an overcount here.
  const zh = '你好世界';
  assert.ok(Math.abs(estimateTokensFloat(zh) - 3) < 0.5);
});
