// A picker row under the pointer must be the row that gets picked.
//
// WHAT BROKE
// ----------
// The category strip is stored in the body as ONE sentinel object and expanded into rows by
// the overlay; a wrapped strip becomes several. Every body index recorded before that
// expansion — the item rows, the footer, a form's fields — pointed at the pre-expansion
// numbering, so each control below the strip was off by the number of extra rows.
//
// On /model that is one row per wrapped strip, and the symptom is exactly a click offset:
// clicking a model selects the one UNDER it. A strip that fits on one line hides the bug,
// which is why it only showed up with enough providers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeFrame, makeState, setUiLang } from '../src/tui.js';

setUiLang('en');

const strip = (line) => String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function frameWithPicker(cols, cats, items) {
  const cfg = { model: 'p/a', raw: { models: { 'p/a': {} }, providers: {} } };
  const state = makeState({ cfg, session: { id: 's', workspace: '/w', messages: [] }, opts: {} });
  state.cols = cols;
  state.rows = 40;
  state.chat = [];
  state.picker = {
    title: 'Select a model',
    items,
    categories: cats,
    sel: 0,
    searchable: false,
    hint: 'nav',
    onPick: () => true,
  };
  state.menuOpen = false;
  return composeFrame(state, cols, 40);
}

test('a wrapped category strip does not offset the item click targets', () => {
  const cats = ['All', 'provider-alpha', 'provider-beta', 'provider-gamma', 'provider-delta', 'provider-epsilon'];
  const items = Array.from({ length: 20 }, (_, i) => ({
    label: `row${String(i).padStart(2, '0')}`,
    sub: `p/m${i}`,
    category: i === 0 ? undefined : cats[1 + (i % 5)],
  }));
  // 60 columns is narrow enough that the strip cannot fit on one line.
  const frame = frameWithPicker(60, cats, items);

  const drawnAt = new Map();
  frame.lines.forEach((line, i) => {
    const m = /row(\d\d)/.exec(strip(line));
    if (m) drawnAt.set(Number(m[1]), i);
  });

  const targets = frame.hitboxes.filter((h) => h.kind === 'pickerItem');
  assert.ok(targets.length > 0, 'the picker registered item targets');
  for (const hb of targets) {
    assert.equal(hb.row, drawnAt.get(hb.index),
      `item ${hb.index}: hitbox says row ${hb.row}, drawn at ${drawnAt.get(hb.index)}`);
  }
});

test('a strip that fits on one line still aligns, so the shift is not applied blindly', () => {
  const cats = ['All', 'p'];
  const items = Array.from({ length: 6 }, (_, i) => ({ label: `row${String(i).padStart(2, '0')}`, sub: `p/m${i}` }));
  const frame = frameWithPicker(100, cats, items);

  const drawnAt = new Map();
  frame.lines.forEach((line, i) => {
    const m = /row(\d\d)/.exec(strip(line));
    if (m) drawnAt.set(Number(m[1]), i);
  });

  for (const hb of frame.hitboxes.filter((h) => h.kind === 'pickerItem')) {
    assert.equal(hb.row, drawnAt.get(hb.index), `item ${hb.index}`);
  }
});
