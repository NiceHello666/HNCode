// The three behaviours changed together, checked against the real entry points.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveConfig } = await import('../src/config.js');
const { SETTINGS_SCHEMA } = await import('../src/settings-schema.js');
const { composeFrame, makeState, findCommand } = await import('../src/tui.js');

const plain = (lines) => lines.map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

function state(overrides = {}) {
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', workspace: '/w',
    maxContextTokens: 100000, raw: { providers: {}, models: { 'p/m': {} } },
  };
  const st = makeState({ cfg, session: { id: 's', title: 'A session', messages: [] }, opts: {} });
  st.chat = [{ role: 'user', text: 'hi' }];
  // `composeFrame` is module-level and reads the name from `state`, which `renderFrame` keeps in step with the
  // session. A test that sets only `session.title` exercises a path no frame ever takes.
  st.sessionTitle = 'A session';
  return Object.assign(st, overrides);
}

test('both new settings are declared, default on, and shown in /settings', () => {
  for (const key of ['title_display', 'auto_title']) {
    const row = SETTINGS_SCHEMA.find((s) => s.key === key);
    assert.ok(row, `${key} is declared`);
    assert.equal(row.default, 'true', `${key} defaults to on`);
    assert.equal(row.kind, 'bool');
    assert.ok(row.ui && row.ui.tab === 'appearance', `${key} has a settings row`);
  }
});

test('title_display off removes the band and gives its rows back to the transcript', () => {
  const on = plain(composeFrame(state({ titleDisplay: true }), 60, 24).lines).split('\n');
  const off = plain(composeFrame(state({ titleDisplay: false }), 60, 24).lines).split('\n');
  assert.equal(on[0].trim(), 'A session', 'the title is on the first row');
  assert.match(on[1], /^─+$/, 'and its rule is under it');
  assert.doesNotMatch(off.join('\n'), /A session/, 'the band is gone');
  assert.equal(off.length, 24, 'the frame is still the full height');
  // The two rows are the transcript's now: the conversation starts two rows higher.
  const firstBody = (rows) => rows.findIndex((l) => /\bhi\b/.test(l));
  assert.equal(firstBody(off), firstBody(on) - 2, 'the transcript moved up by exactly the band');
});

test('resolveConfig reads both keys, and both default to on when unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-titles-'));
  const prevHome = process.env.HNCODE_HOME;
  const prevWs = process.env.HNCODE_WORKSPACE;
  process.env.HNCODE_HOME = dir;
  process.env.HNCODE_WORKSPACE = dir;
  try {
    const file = path.join(dir, '.hncode', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "m1"\n', 'utf8');
    let cfg = resolveConfig(dir);
    assert.equal(cfg.titleDisplay, true, 'default on');
    assert.equal(cfg.autoTitle, true, 'default on');

    fs.writeFileSync(file, 'model = "m1"\ntitle_display = false\nauto_title = false\n', 'utf8');
    cfg = resolveConfig(dir);
    assert.equal(cfg.titleDisplay, false, 'off is read back');
    assert.equal(cfg.autoTitle, false, 'off is read back');
  } finally {
    if (prevHome === undefined) delete process.env.HNCODE_HOME; else process.env.HNCODE_HOME = prevHome;
    if (prevWs === undefined) delete process.env.HNCODE_WORKSPACE; else process.env.HNCODE_WORKSPACE = prevWs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/auto-title is a command', () => {
  const c = findCommand('auto-title');
  assert.ok(c, 'the command exists');
  assert.equal(c.name, 'auto-title');
});
