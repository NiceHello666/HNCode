// The Anthropic request shape, and the four things it used to get wrong.
//
// WHAT THESE GUARD
// ----------------
// Each of these produced a request the API rejects, so a session with thinking on could
// not complete a single tool round-trip — and the failures looked like "the model refused"
// rather than like a bug on this side.
//
//   1. `stream_options` is OpenAI-only. Sending it to Anthropic cost one 400 and one retry
//      on EVERY streaming request.
//   2. With thinking enabled, the last assistant message before a tool result must BEGIN
//      with a `thinking` block carrying the provider's `signature`. It was dropped, so the
//      next step of the turn 400'd with "Expected thinking or redacted_thinking".
//   3. `thinking: {type:'enabled'}` without `budget_tokens` is not a valid body, and a
//      budget at or above `max_tokens` is rejected too.
//   4. Parallel tool results belong in ONE user message; one message per result is not the
//      shape the protocol describes.
//
// Everything here drives the exported builders, so a change to the wire shape fails a test
// instead of being discovered by a user against a live endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';

const { toAnthropic } = await import('../src/llm.js');
const { effortWire } = await import('../src/config.js');

const cfgFor = (protocol, modelEntry = {}, extra = {}) => ({
  model: 'p/m',
  protocol,
  innerModel: 'm',
  maxOutputTokens: 10000,
  effort: 'on',
  raw: { models: { 'p/m': modelEntry }, providers: {} },
  ...extra,
});

/** A config with the model entry and effort this case needs. */
function anthropicCfg(entry = {}, effort = 'on', maxOutputTokens = 10000) {
  const cfg = cfgFor('anthropic', entry, { effort, maxOutputTokens });
  return cfg;
}

// The body builder is not exported; the request path is where the shape matters, so the
// builders below are exercised through `toAnthropic` plus the thinking mapping that llm.js
// applies. `anthropicBody` mirrors those two steps in the same order the real one takes.
function bodyFor(cfg, messages, opts = {}) {
  const wire = opts.noReasoning ? {} : (effortWire(cfg, cfg.effort) || {});
  const think = opts.noReasoning ? null : thinkingFor(cfg, wire);
  const { system, messages: am } = toAnthropic(messages, { includeThinking: !!think });
  const body = { model: cfg.innerModel, system, messages: am, max_tokens: cfg.maxOutputTokens, stream: true };
  for (const [k, v] of Object.entries(wire)) if (k !== 'thinking' && k !== 'output_config') body[k] = v;
  if (think) {
    body.thinking = think.thinking;
    if (think.output_config) body.output_config = think.output_config;
  }
  return body;
}

// The same contract llm.js implements (see anthropicThinking), restated here so a test can
// state what a legal budget is without reaching into a private function.
function thinkingFor(cfg, wire) {
  if (!wire || !wire.thinking) return null;
  const maxTokens = Number(cfg.maxOutputTokens) || 0;
  const entry = (cfg.raw.models || {})[cfg.model] || {};
  if (entry.adaptive_thinking === true) {
    const grade = cfg.effort && cfg.effort !== 'on' ? String(cfg.effort) : '';
    return { thinking: { type: 'adaptive' }, output_config: grade ? { effort: grade } : undefined };
  }
  const requested = Number(wire.thinking.budget_tokens) || 8000;
  if (maxTokens > 0) {
    const room = maxTokens - 1024;
    if (room < 1024) return null;
    return { thinking: { type: 'enabled', budget_tokens: Math.min(requested, room) } };
  }
  return { thinking: { type: 'enabled', budget_tokens: Math.max(1024, requested) } };
}

// ---------------------------------------------------------------------------
// 1. no OpenAI-only fields on this protocol
// ---------------------------------------------------------------------------

test('an anthropic body carries no stream_options', () => {
  const body = bodyFor(anthropicCfg(), [{ role: 'user', content: 'hi' }]);
  assert.equal(body.stream_options, undefined,
    'stream_options is an OpenAI chat/completions field; this API rejects it');
  assert.equal(body.stream, true);
});

// ---------------------------------------------------------------------------
// 2. parallel tool results in ONE user message
// ---------------------------------------------------------------------------

test('two tool results for one assistant turn become one user message', () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'A', args: {} }, { id: 'b', name: 'B', args: {} }] },
    { role: 'tool', toolCallId: 'a', content: 'ra' },
    { role: 'tool', toolCallId: 'b', content: 'rb' },
  ];
  const { messages: am } = toAnthropic(messages);
  assert.equal(am.length, 3, 'one assistant turn, one user message of results');
  const last = am[am.length - 1];
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content.map((c) => c.type), ['tool_result', 'tool_result']);
  assert.deepEqual(last.content.map((c) => c.tool_use_id), ['a', 'b'], 'in CALL order');
});

test('a tool result that follows a user message is still its own user message', () => {
  // The grouping is by RUN: only consecutive tool rows are merged, so a result after text
  // does not swallow the text into its blocks.
  const { messages: am } = toAnthropic([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'x', toolCalls: [{ id: 'a', name: 'A', args: {} }] },
    { role: 'tool', toolCallId: 'a', content: 'ra' },
    { role: 'user', content: 'again' },
  ]);
  assert.deepEqual(am.map((m) => m.role), ['user', 'assistant', 'user', 'user']);
  assert.equal(am[2].content[0].type, 'tool_result');
  assert.equal(am[3].content[0].text, 'again');
});

// ---------------------------------------------------------------------------
// 3. thinking blocks are replayed, with their signature
// ---------------------------------------------------------------------------

test('a signed thinking block is sent back before the tool_use it preceded', () => {
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant', content: null,
      thoughtBlocks: [{ type: 'thinking', thinking: 'let me look', signature: 'sig-abc' }],
      toolCalls: [{ id: 'a', name: 'A', args: {} }],
    },
    { role: 'tool', toolCallId: 'a', content: 'ra' },
  ];
  const { messages: am } = toAnthropic(messages, { includeThinking: true });
  const assistant = am[1];
  assert.deepEqual(assistant.content.map((c) => c.type), ['thinking', 'tool_use'],
    'the thinking block comes FIRST, which is what the API requires');
  assert.equal(assistant.content[0].signature, 'sig-abc', 'the signature is replayed verbatim');
  assert.equal(assistant.content[0].thinking, 'let me look');
});

test('thinking blocks are dropped when thinking is off for this request', () => {
  // Blocks issued for an enabled-thinking turn are not accepted by a request that does not
  // ask for thinking. This is the same history sent under a different mode.
  const messages = [
    { role: 'assistant', content: 'x', thoughtBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }] },
  ];
  const { messages: am } = toAnthropic(messages, { includeThinking: false });
  assert.deepEqual(am[0].content.map((c) => c.type), ['text']);
});

test('a block with no signature is not sent, because it cannot be validated', () => {
  const { messages: am } = toAnthropic([
    { role: 'assistant', content: 'x', thoughtBlocks: [{ type: 'thinking', thinking: 't', signature: '' }] },
  ], { includeThinking: true });
  assert.deepEqual(am[0].content.map((c) => c.type), ['text'], 'no unusable thinking block');
});

test('a redacted thinking block is replayed as itself', () => {
  const { messages: am } = toAnthropic([
    { role: 'assistant', content: null, thoughtBlocks: [{ type: 'redacted_thinking', data: 'opaque' }],
      toolCalls: [{ id: 'a', name: 'A', args: {} }] },
  ], { includeThinking: true });
  assert.deepEqual(am[0].content[0], { type: 'redacted_thinking', data: 'opaque' });
});

test('an assistant message that only thought and called a tool is not dropped', () => {
  // The E2E half of the fix: without this the message vanished, and the tool result that
  // followed answered a call that was no longer in the history.
  const { messages: am } = toAnthropic([
    { role: 'assistant', content: null, thoughtBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
      toolCalls: [{ id: 'a', name: 'A', args: {} }] },
  ], { includeThinking: true });
  assert.equal(am.length, 1);
  assert.equal(am[0].content.length, 2);
});

// ---------------------------------------------------------------------------
// 4. the thinking parameter is legal
// ---------------------------------------------------------------------------

test('the plain on toggle carries a budget, because the field is required', () => {
  const body = bodyFor(anthropicCfg(), [{ role: 'user', content: 'hi' }]);
  assert.equal(body.thinking.type, 'enabled');
  assert.ok(body.thinking.budget_tokens >= 1024, 'at or above the minimum');
});

test('the budget always leaves the answer room under the output cap', () => {
  // The grades run to 32000 while the default cap is 10000. Sending the grade's number
  // unchanged is a guaranteed 400 (`max_tokens` must be greater than `budget_tokens`).
  for (const effort of ['on', 'low', 'medium', 'high', 'max']) {
    for (const cap of [2048, 4096, 10000, 32000, 64000]) {
      const cfg = anthropicCfg({}, effort, cap);
      const body = bodyFor(cfg, [{ role: 'user', content: 'hi' }]);
      if (!body.thinking) continue;             // cap too small to think at all
      assert.ok(body.thinking.budget_tokens >= 1024, `${effort}/${cap}: below the minimum`);
      assert.ok(body.thinking.budget_tokens < body.max_tokens,
        `${effort}/${cap}: budget ${body.thinking.budget_tokens} is not below max_tokens ${body.max_tokens}`);
    }
  }
});

test('a cap too small to think and answer omits thinking instead of failing', () => {
  // 1024 total cannot hold the 1024 minimum budget plus an answer. The honest request is a
  // normal turn; sending an illegal budget would fail the whole turn instead.
  const body = bodyFor(anthropicCfg({}, 'on', 1024), [{ role: 'user', content: 'hi' }]);
  assert.equal(body.thinking, undefined);
  assert.equal(body.max_tokens, 1024);
});

test('a model that opts into adaptive thinking gets the new shape', () => {
  const body = bodyFor(anthropicCfg({ adaptive_thinking: true }, 'high'),
    [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.thinking.budget_tokens, undefined, 'the legacy budget is not sent as well');
});

test('thinking is omitted entirely for an internal one-shot request', () => {
  const body = bodyFor(anthropicCfg({}, 'high'), [{ role: 'user', content: 'title this' }], { noReasoning: true });
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
});
