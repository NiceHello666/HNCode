// Thinking-effort → wire mapping.
//
// WHY THESE ASSERTIONS
// --------------------
// `effortWire` had NO test coverage at all, and shipped with two silent substitutions:
//
//   * `on` was mapped to the grade `medium`, on every protocol. `on` means "thinking on",
//     not "medium strength" — the two are different requests, and a model that offers only a
//     plain toggle has no grade to send. The user picked "on" and the tool decided "medium".
//   * An unrecognised grade fell through to `budget || 8000`, so a user-defined grade such
//     as `xhigh` became byte-identical to `on` and `medium`. config.toml's own comments
//     advertise naming your own grades, so this hit the documented feature.
//
// Neither produced an error — both produced a DIFFERENT request than the one asked for,
// which is why they survived: nothing raises, and the UI shows the choice the user made.
import assert from 'node:assert/strict';
import test from 'node:test';

const { effortWire, effortOptions } = await import('../src/config.js');

/** A cfg shaped the way resolveConfig produces it. */
const cfgFor = (protocol, modelEntry = {}) => ({
  model: 'p/m',
  protocol,
  raw: { models: { 'p/m': modelEntry }, providers: {} },
});

const PROTOCOLS = ['openai', 'responses', 'anthropic'];

// ---------------------------------------------------------------------------
// `on` is a toggle, not a grade
// ---------------------------------------------------------------------------

test('on never sends a grade on the two protocols that only accept grade words', () => {
  // `reasoning_effort` and `reasoning.effort` take low/medium/high. There is no value for
  // "on", so the honest request is to omit the field.
  for (const protocol of ['openai', 'responses']) {
    const wire = effortWire(cfgFor(protocol), 'on');
    const text = JSON.stringify(wire);
    assert.ok(!/medium/.test(text), `${protocol}: on produced a grade — ${text}`);
    assert.ok(!/effort/.test(text), `${protocol}: on still sent an effort field — ${text}`);
    assert.deepEqual(wire, {}, `${protocol}: on sends nothing`);
  }
});

test('on sends a legal budget on anthropic, because the field is required', () => {
  // `thinking: { type: 'enabled' }` WITHOUT `budget_tokens` is a 400, not a default — the
  // field is REQUIRED whenever thinking is enabled. An earlier version of this test asserted
  // the bare enable and called it "no invented budget"; it was pinning a request the API
  // rejects, so a user who turned thinking on simply got an error instead of a turn.
  const wire = effortWire(cfgFor('anthropic'), 'on');
  assert.deepEqual(wire, { thinking: { type: 'enabled', budget_tokens: 8000 } });
  assert.ok(wire.thinking.budget_tokens >= 1024, 'at or above the protocol minimum');
});

test('on and medium differ where the protocol has a word for "on", and cannot on anthropic', () => {
  // A grade word protocol can say "on" by OMITTING the field and "medium" by naming it.
  // Anthropic has no way to express "thinking on, strength unspecified": the budget is
  // mandatory, so the neutral figure is the only honest resolution and the two coincide.
  // The number itself is fitted to the output cap in llm.js — see anthropicThinking.
  for (const protocol of ['openai', 'responses']) {
    const c = cfgFor(protocol, { efforts: ['low', 'medium', 'high'] });
    assert.notDeepEqual(effortWire(c, 'on'), effortWire(c, 'medium'),
      `${protocol}: on and medium must differ`);
  }
  const anth = cfgFor('anthropic', { efforts: ['low', 'medium', 'high'] });
  assert.deepEqual(effortWire(anth, 'on'), effortWire(anth, 'medium'),
    'anthropic: the neutral budget is the only legal form of "on"');
});

test('an unknown grade sends no grade word on the grade-word protocols', () => {
  for (const protocol of ['openai', 'responses']) {
    const wire = effortWire(cfgFor(protocol), 'xhigh');
    assert.ok(!/xhigh/.test(JSON.stringify(wire)), `${protocol}: sent the unknown grade verbatim`);
    assert.deepEqual(wire, {}, `${protocol}: sends nothing rather than a wrong value`);
  }
});

// ---------------------------------------------------------------------------
// off, and the offer list
// ---------------------------------------------------------------------------

test('off is null on every protocol, and always was', () => {
  for (const protocol of PROTOCOLS) {
    assert.equal(effortWire(cfgFor(protocol), 'off'), null);
    assert.equal(effortWire(cfgFor(protocol), ''), null);
    assert.equal(effortWire(cfgFor(protocol), null), null);
    assert.equal(effortWire(cfgFor(protocol), undefined), null);
  }
});

test('the offered list is unchanged by this fix', () => {
  // The fix is in the WIRE mapping only: what the UI offers must not change, or a user
  // would lose a choice they had.
  assert.deepEqual(effortOptions(cfgFor('openai', { efforts: ['low', 'high'] }), 'p/m'), ['off', 'low', 'high']);
  assert.deepEqual(effortOptions(cfgFor('openai', { reasoning: true }), 'p/m'), ['off', 'on']);
  assert.deepEqual(effortOptions(cfgFor('openai', { reasoning: false }), 'p/m'), []);
  assert.deepEqual(effortOptions(cfgFor('openai', { always_thinking: true }), 'p/m'), ['on']);
});

test('every offered value maps to something, so the UI cannot offer a dead option', () => {
  // A choice that produced `{}` on a model WITH declared grades would be a lie in the menu.
  for (const protocol of PROTOCOLS) {
    const entry = { efforts: ['low', 'medium', 'high'] };
    const c = cfgFor(protocol, entry);
    for (const opt of effortOptions(c, 'p/m')) {
      const wire = effortWire(c, opt);
      assert.notEqual(wire, undefined, `${protocol}/${opt} produced undefined`);
      if (opt === 'off') assert.equal(wire, null);
      else assert.ok(wire && Object.keys(wire).length > 0, `${protocol}/${opt} sent nothing: ${JSON.stringify(wire)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// values the list does not offer
// ---------------------------------------------------------------------------

test('a grade outside the declared list is still sendable', () => {
  // `/effort <value>` used to REFUSE anything not in `effortOptions` for the current model. That list is
  // what a model is KNOWN to accept — from the catalog, or from a user's own `efforts = [...]` — and the
  // catalog can lag a model while a proxy or gateway may take grades the entry never recorded. Refusing
  // those made `xhigh` fail on a model that understands it, with no way to try.
  //
  // What must NOT change when the check goes: the mapping stays honest about what it does not know.
  const c = cfgFor('openai', { efforts: ['off', 'low', 'high'] });
  assert.deepEqual(effortOptions(c, 'p/m'), ['off', 'low', 'high'], 'the list is what the picker offers');

  // A known grade is sent by name...
  assert.deepEqual(effortWire(c, 'high'), { reasoning_effort: 'high' });
  // ...and an unknown one sends NOTHING rather than a number guessed from a neighbour. An earlier version
  // fell back to 8000, which made every unknown grade byte-identical to `on` and `medium`.
  assert.deepEqual(effortWire(c, 'xhigh'), {},
    'an unknown grade is not turned into a number this side');
});

test('a user-defined anthropic grade asks for the neutral budget, not a neighbouring one', () => {
  // config.toml documents `efforts = ["xhigh"]`. There is no honest budget for a grade this
  // side has never heard of, and the protocol does not accept a bare enable — so the neutral
  // figure is requested, and llm.js fits it to the output cap. What matters is that it is a
  // number this side CHOSE to mean "unspecified", not one borrowed from `low` or `high`.
  const c = cfgFor('anthropic', { efforts: ['xhigh'] });
  const wire = effortWire(c, 'xhigh');
  assert.deepEqual(wire, { thinking: { type: 'enabled', budget_tokens: 8000 } });
  assert.notDeepEqual(wire, effortWire(c, 'low'));
  assert.notDeepEqual(wire, effortWire(c, 'high'));
});

test('an unknown grade invents no budget on the two grade-word protocols', () => {
  // Each protocol carries the grade differently and each could invent its own default:
  //   openai      the field is omitted
  //   responses   the field is omitted
  // Anthropic has no way to omit it, so it is covered by the test above.
  for (const protocol of ['openai', 'responses']) {
    const c = cfgFor(protocol, { efforts: ['off', 'low'] });
    const wire = effortWire(c, 'xhigh');
    assert.deepEqual(wire, {}, `${protocol} invented a grade: ${JSON.stringify(wire)}`);
  }
});
