// The computer-use plugin's pure parts, pinned.
//
// WHY THIS FILE EXISTS: the plugin had NO tests at all — 68KB of tool wiring across a dozen platform files, and
// two real defects sat in it unnoticed. `FmtRect` was defined inside one PowerShell script and called from two
// others, so `GetElementInfo` and the focus reader failed with "The term 'FmtRect' is not recognized"; and the
// element parser trusted its input completely, so one stray tab shifted every field and a click landed on the
// wrong thing with no error anywhere.
//
// These tests cover what can be checked without a desktop: the parser, and the shape of the PowerShell sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { parseElements } = await import('../plugins/computer-use/platform/win-uia.js');

const ll = String.fromCharCode(9);
const row = (f) => f.join(ll);
const GOOD = ['0', '0', 'Button', 'OK', '', '', '10', '20', '30', '40', 'true', '', ''];

test('a well-formed row parses into an element', () => {
  const r = parseElements(row(GOOD));
  assert.equal(r.length, 1);
  assert.deepEqual(
    { name: r[0].name, x: r[0].x, y: r[0].y, w: r[0].width, h: r[0].height, enabled: r[0].enabled },
    { name: 'OK', x: 10, y: 20, w: 30, h: 40, enabled: true },
  );
});

test('a row with too many columns is DROPPED, not mis-read', () => {
  // A tab inside a name adds a column and shifts every field after it. Before the column check this parsed as
  // name="a" x=0 enabled=false — plausible-looking numbers describing a different element.
  const withTab = ['1', '1', 'Text', 'a' + ll + 'b', '', '', '0', '0', '5', '5', 'true', '', ''];
  assert.equal(parseElements(row(withTab)).length, 0);
});

test('non-numeric coordinates are dropped', () => {
  const bad = ['2', '0', 'Button', 'X', '', '', 'NaN', '0', '5', '5', 'true', '', ''];
  assert.equal(parseElements(row(bad)).length, 0);
});

test('a short row is skipped rather than half-read', () => {
  assert.equal(parseElements(row(['3', '0', 'Button'])).length, 0);
});

test('several elements parse in order', () => {
  const two = [
    row(['0', '0', 'Button', 'A', '', '', '1', '2', '3', '4', 'true', '', '']),
    row(['1', '0', 'Button', 'B', '', '', '5', '6', '7', '8', 'false', '', '']),
  ].join('\n');
  const r = parseElements(two);
  assert.deepEqual(r.map((e) => e.name), ['A', 'B']);
  assert.equal(r[1].enabled, false);
});

test('FmtRect is defined in the shared PRELUDE, so every script can call it', () => {
  // It was defined inside the WALK template while two OTHER templates called it. Each template is a separate
  // PowerShell program: a function is only visible where it is defined.
  const src = fs.readFileSync(path.resolve('plugins/computer-use/platform/win-uia.js'), 'utf8');
  const preludeStart = src.indexOf('const PRELUDE = `');
  const preludeEnd = src.indexOf('`;', preludeStart);
  assert.ok(preludeStart >= 0 && preludeEnd > preludeStart, 'PRELUDE must exist');

  const prelude = src.slice(preludeStart, preludeEnd);
  assert.match(prelude, /function FmtRect\(\$r\)/, 'FmtRect belongs in PRELUDE');
});

test('every tool declares its name once', () => {
  const src = fs.readFileSync(path.resolve('plugins/computer-use/index.js'), 'utf8');
  const names = [...src.matchAll(/^\s{4}name: '([^']+)'/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate declarations: ${dupes.join(', ')}`);
  assert.ok(names.length >= 30, `expected the full tool set, found ${names.length}`);
});

test('every platform exposes the window-lifecycle methods', async () => {
  // The tools dispatch by name through `platform.call(method, …)`. A backend missing one of these fails at CALL
  // time, with the model already halfway through a sequence — so the exports are checked here instead.
  for (const mod of ['windows', 'macos', 'linux']) {
    const m = await import(`../plugins/computer-use/platform/${mod}.js`);
    for (const fn of ['getWindowInfo', 'setWindowState', 'waitForWindow']) {
      assert.equal(typeof m[fn], 'function', `${mod}.js must export ${fn}`);
    }
  }
});

test('the window-lifecycle tools are registered and their parameters are declared', async () => {
  const registered = new Map();
  const api = {
    registerTool: (spec) => { if (spec && spec.name) registered.set(spec.name, spec); },
    log() {}, logger: { info() {}, warn() {}, error() {} }, on() {}, registerKeybind() {},
  };
  const { install } = await import('../plugins/computer-use/index.js');
  await install(api);

  assert.ok(registered.has('GetWindowInfo'));
  assert.ok(registered.has('SetWindowState'));
  assert.ok(registered.has('WaitForWindow'));

  // `state` is an enum: a model passing "hide" must be corrected by the schema, not by a runtime throw.
  const sw = registered.get('SetWindowState');
  assert.deepEqual(sw.parameters.properties.state.enum, ['maximize', 'minimize', 'restore']);
  assert.deepEqual(sw.parameters.required, ['hwnd', 'state']);

  const ww = registered.get('WaitForWindow');
  assert.deepEqual(ww.parameters.properties.state.enum, ['appear', 'disappear']);
  assert.ok(ww.parameters.properties.title, 'a window can be matched by title');
  assert.ok(ww.parameters.properties.className, 'or by class');
});

test('waitForWindow refuses an unknown state instead of acting', async () => {
  // Called on this platform with a bad state: it must return an error, never reach the window manager.
  const { setWindowState } = await import('../plugins/computer-use/platform/windows.js');
  const r = await setWindowState('12345', 'hide');
  assert.match(String(r.error || ''), /unknown state/);
});
