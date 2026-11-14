// Does a /settings change reach the field the code reads?
//
// THE BUG THIS PINS: `applySetting` writes every key generically (`cfg[key] = value`) and then maps the ones whose
// field name differs. `title_display` and `auto_title` were declared in the schema but never mapped, so the file
// changed, `cfg.title_display` changed, and `cfg.titleDisplay` — the field the frame composer reads — did not. The
// setting looked like it had no effect.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS_SCHEMA } = await import('../src/settings-schema.js');
const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');

/** The camelCase field each setting is read by, where it differs from the key. */
const FIELD = {
  title_display: 'titleDisplay',
  auto_title: 'autoTitle',
  calm_mode: 'calmMode',
  auto_compact: 'autoCompact',
  auto_trim: 'autoTrim',
  swarm_mode: 'swarm',
};

test('every setting with a renamed field is mapped in applySetting', () => {
  // The body of `applySetting`, so a mapping elsewhere in the file does not count.
  const at = src.indexOf('function applySetting(');
  assert.ok(at > 0, 'applySetting is where this test expects it');
  const body = src.slice(at, src.indexOf('\n  function ', at + 10));

  for (const [key, field] of Object.entries(FIELD)) {
    assert.ok(
      new RegExp(`key === '${key}'\\) cfg\\.${field} = `).test(body),
      `${key} must be mapped to cfg.${field}, or the value reaches the file and not the code`,
    );
  }
});

test('the two title settings are declared and default to on', () => {
  for (const key of ['title_display', 'auto_title']) {
    const row = SETTINGS_SCHEMA.find((s) => s.key === key);
    assert.ok(row, `${key} is declared`);
    assert.equal(row.default, 'true', `${key} defaults to on`);
    assert.equal(row.kind, 'bool', `${key} is a toggle`);
  }
});

test('the frame composer reads state, which renderFrame fills from cfg', () => {
  // `composeFrame` is module-level and sees only `state`, so the value has to be copied across on every frame.
  assert.match(src, /state\.titleDisplay = cfg\.titleDisplay !== false/,
    'renderFrame copies the setting onto state');
  assert.match(src, /state\.titleDisplay === false/,
    'and the composer consults it');
});
