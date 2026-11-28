// Every fixed-string notice has a translation, and an unknown one is left alone.
//
// WHY THIS SHAPE
// --------------
// Notices are composed at the call site (`app(...)`, `appErr(...)`, `notice(...)`) from a
// mix of fixed sentences and templates. Rewriting two hundred call sites would put a key
// between every message and the code that builds it, so `notice()` — the single point where
// any notice reaches the user — translates the FINAL string by exact match.
//
// Two consequences are asserted here:
//   * a fixed sentence IS translated, so the command feedback a person reads most is in
//     their language;
//   * a message with an interpolated value is NOT half-translated. A partly substituted
//     sentence reads worse than a correct one in the wrong language.
//
// The scan at the bottom is the guard that keeps the table complete: a fixed English notice
// in tui.js with no entry here would silently stay English.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { noticeText, NOTICE_ZH } = await import('../src/i18n.js');

test('a fixed notice is translated to Chinese, with no trailing full stop', () => {
  assert.equal(noticeText('zh', 'Interrupted'), '已中断');
  assert.equal(noticeText('zh', 'Output style cleared.'), '已清除输出风格');
});

test('English returns the string unchanged', () => {
  assert.equal(noticeText('en', 'Interrupted'), 'Interrupted');
  assert.equal(noticeText('en', 'Output style cleared.'), 'Output style cleared.');
});

test('a message with an interpolated value is left as it was', () => {
  // Nothing in the table can match it, and matching a PREFIX would produce a sentence with
  // an English half and a Chinese half.
  assert.equal(noticeText('zh', 'Model → gpt-4'), 'Model → gpt-4');
  assert.equal(noticeText('zh', 'Saved 3 WebSearch keys.'), 'Saved 3 WebSearch keys.');
});

test('unknown text passes through rather than rendering a key', () => {
  assert.equal(noticeText('zh', 'something nobody translated'), 'something nobody translated');
});

test('every fixed-string notice in tui.js has a translation', () => {
  // The real guard. `app('...')`, `appErr('...')` and `notice('...', kind)` with a plain
  // string literal and no template are the messages a user reads most; a missing entry
  // means that command answers in the wrong language while its neighbours answer in the
  // right one.
  const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
  const missing = [];
  for (const m of src.matchAll(/(?:^|\s)(?:app|appErr|notice)\(\s*'((?:[^'\\]|\\.)*)'\s*(?:,\s*'(?:info|error)'\s*)?\)/g)) {
    // Decode JS escapes (\u2014, \n, …) so the source literal matches the runtime text the
    // table is keyed by.
    const text = JSON.parse('"' + m[1].replace(/"/g, '\\"') + '"');
    if (!text.trim()) continue;
    // A slash command or a path is not a sentence: those stay as they are.
    if (/^[/.]/.test(text)) continue;
    if (!NOTICE_ZH[text]) missing.push(text);
  }
  assert.deepEqual(missing, [], `untranslated notices: ${JSON.stringify(missing)}`);
});
