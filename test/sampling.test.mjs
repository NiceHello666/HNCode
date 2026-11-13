// The sampling parameters: they exist, they are reachable, and they behave the way the docs claim.
//
// WHY THIS FILE EXISTS: the values were read by `llm.js` and produced by nothing for a long time — a field that
// looked wired up on both ends and had no source. These tests pin the source, the shape, and the three decisions
// that are easy to "simplify" back into a bug: empty means absent (not zero), off means send nothing, and a
// non-number must not stop the program from starting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-sampling-'));
const cfgFile = path.join(dir, 'config.toml');
process.env.HNCODE_CONFIG = cfgFile;
process.env.HNCODE_HOME = dir;
process.env.HNCODE_WORKSPACE = dir;

const { resolveConfig } = await import('../src/config.js');
const { SETTING_BY_KEY } = await import('../src/settings-schema.js');

const load = (toml) => {
  fs.writeFileSync(cfgFile, toml, 'utf8');
  for (const k of ['HNCODE_TEMPERATURE', 'HNCODE_TOP_P', 'HNCODE_PRESENCE_PENALTY', 'HNCODE_SAMPLING']) delete process.env[k];
  return resolveConfig(dir);
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the four settings are declared', () => {
  for (const key of ['sampling', 'temperature', 'top_p', 'presence_penalty']) {
    const d = SETTING_BY_KEY.get(key);
    assert.ok(d, `${key} must be in the schema or /settings cannot show it`);
  }
  assert.equal(SETTING_BY_KEY.get('sampling').kind, 'bool');
  assert.equal(SETTING_BY_KEY.get('temperature').kind, 'string', 'a cleared field has to be expressible');
});

test('nothing is sent by default', () => {
  const cfg = load('');
  assert.equal(cfg.temperature, undefined);
  assert.equal(cfg.topP, undefined);
  assert.equal(cfg.presencePenalty, undefined);
});

test('values from config reach the resolved object', () => {
  const cfg = load('temperature = 0.3\ntop_p = 0.9\npresence_penalty = 0.5\n');
  assert.equal(cfg.temperature, 0.3);
  assert.equal(cfg.topP, 0.9);
  assert.equal(cfg.presencePenalty, 0.5);
});

test('out of range is clamped, and a non-number is treated as absent', () => {
  assert.equal(load('temperature = 5\n').temperature, 2, 'clamped to the maximum');
  assert.equal(load('temperature = -1\n').temperature, 0, 'clamped to the minimum');
  assert.equal(load('temperature = "warm"\n').temperature, undefined,
    'a typo must not stop the program from starting');
});

test('sampling = false sends none of them, not their defaults', () => {
  const cfg = load('temperature = 0.7\ntop_p = 0.8\nsampling = false\n');
  assert.equal(cfg.temperature, undefined);
  assert.equal(cfg.topP, undefined);
});

test('zero is a value, not an absence', () => {
  // 0 means deterministic. Treating it as "unset" would silently hand the provider's default back.
  assert.equal(load('temperature = 0\n').temperature, 0);
});

test('the request body carries the parameters under their wire names', async () => {
  const src = fs.readFileSync(path.resolve('src/llm.js'), 'utf8');
  assert.match(src, /if \(cfg\.temperature != null\) common\.temperature = cfg\.temperature;/);
  assert.match(src, /if \(cfg\.topP != null\) common\.top_p = cfg\.topP;/);
  // Anthropic has no presence penalty, and it errors on unknown fields rather than ignoring them.
  assert.match(src, /delete body\.presence_penalty;/);
});

test('/sampling is a registered command', async () => {
  const { COMMANDS } = await import('../src/tui.js');
  const cmd = COMMANDS.find((c) => c.name === 'sampling');
  assert.ok(cmd, '/sampling must exist — asking "what is my temperature" is the reason for it');
  assert.match(cmd.argumentHint || '', /temperature/);
});
