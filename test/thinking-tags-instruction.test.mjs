// The inline-reasoning instruction goes only where it is the only way to get it.
//
// WHY THIS MATTERS
// ----------------
// A model with its OWN reasoning channel — Anthropic's `thinking`, OpenAI's and DeepSeek's
// `reasoning_content` — reports its reasoning through the API, and hncode renders that as
// the thinking block. Telling such a model to ALSO wrap its reasoning in
// `<|thinking|>…<|/thinking|>` asks for the same reasoning twice: once in the channel, and
// once as literal text in the answer, which then shows up duplicated on screen or left in
// the reply as noise.
//
// A model with NO channel has nothing but the tag, so there the instruction is attached.
//
// The instruction also stays OUT of SYSTEM_PROMPT so that the prompt remains a static
// prefix, which is what providers cache.

import test from 'node:test';
import assert from 'node:assert/strict';

const { SYSTEM_PROMPT, THINKING_TAGS_INSTRUCTION, needsThinkingTags } = await import('../src/agent.js');

test('the built-in prompt does not carry the tag instruction', () => {
  // It is attached per request, not baked in: a model that can think natively must not
  // receive it, and the prompt is what gets cached.
  assert.ok(!SYSTEM_PROMPT.includes('<|thinking|>'),
    'SYSTEM_PROMPT still tells every model to wrap its reasoning in tags');
  assert.ok(THINKING_TAGS_INSTRUCTION.includes('<|thinking|>'),
    'the instruction itself must still say what to do');
});

test('a model with a native reasoning channel is not asked for the tag', () => {
  assert.equal(needsThinkingTags({ reasoning: true }), false);
});

test('a model without one is asked for the tag', () => {
  assert.equal(needsThinkingTags({ reasoning: false }), true);
  assert.equal(needsThinkingTags({}), true, 'an unknown model is treated as having no channel');
  assert.equal(needsThinkingTags(null), true);
});

test('the user can decide by hand, either way', () => {
  assert.equal(needsThinkingTags({ reasoning: true, thinkingTags: true }), true);
  assert.equal(needsThinkingTags({ reasoning: false, thinkingTags: false }), false);
});
