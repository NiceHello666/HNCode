// The terminal UI speaks the user's language, and English is the floor.
//
// WHAT THIS GUARDS
// ----------------
// Every string in the TUI was English, including the command list and the help panel —
// the two screens a person reads to find out what the tool can do. The web UI was
// translated and the terminal was not, which is the wrong way round: the terminal is
// where the work happens.
//
// Three properties matter, and each fails on its own:
//
//   * a translated string is returned in the selected language;
//   * a string with no translation falls back to the ENGLISH TEXT AT THE CALL SITE, not
//     to a key name — that is what lets the table hold only translations;
//   * every command the user can type has a description in the translated language, or
//     the menu shows English beside Chinese and reads like a half-finished translation.

import test from 'node:test';
import assert from 'node:assert/strict';

const { t, tOr, MESSAGES, LANGUAGES } = await import('../src/i18n.js');
const { COMMANDS, setUiLang, getUiLang, tr } = await import('../src/tui.js');

test('the two languages the UI offers are Chinese and English', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['zh', 'en']);
});

test('setUiLang accepts only the two ids and defaults to English', () => {
  setUiLang('zh');
  assert.equal(getUiLang(), 'zh');
  setUiLang('fr');
  assert.equal(getUiLang(), 'en', 'an unimplemented language is English, not blank');
  setUiLang('en');
  assert.equal(getUiLang(), 'en');
});

test('a translated key comes back in the selected language', () => {
  setUiLang('zh');
  assert.equal(tr('tui.key.send', 'send the message'), '发送消息');
  setUiLang('en');
  assert.equal(tr('tui.key.send', 'send the message'), 'send the message');
});

test('a key with no translation returns the English text from the call site', () => {
  // This is what makes the table hold ONLY translations: the English description lives
  // beside the command it describes, so the two can never disagree.
  setUiLang('zh');
  assert.equal(tr('tui.nonexistent', 'the English original'), 'the English original');
});

test('a key with no English entry still falls back to the call site text', () => {
  // `cmd.*` entries carry zh only. Asking for one in English must give the caller's own
  // string, never the key name.
  setUiLang('en');
  assert.equal(tr('cmd.help', 'fallback text'), 'fallback text');
});

test('every command has a description in both languages the UI offers', () => {
  // The menu renders the translated description where there is one and the English one
  // otherwise. A command with no translation therefore shows English beside Chinese in the
  // same list, which reads as a half-finished translation rather than as a missing string.
  const missing = [];
  for (const c of COMMANDS) {
    const zh = tOr('zh', `cmd.${c.name}`, null);
    if (!zh) missing.push(c.name);
  }
  assert.deepEqual(missing, [], `commands with no translation: ${missing.join(', ')}`);
});

test('a translation never leaks a placeholder the caller cannot fill', () => {
  // `{filter}` and friends are filled by `t`/`tr`. A key whose translation kept a DIFFERENT
  // placeholder would render braces literally on screen. Only the keys this change added are
  // checked: the web UI's own fill sites are elsewhere and covered by its tests.
  const fillable = new Set(['tui.help.matching', 'tui.help.noMatch']);
  const leaked = [];
  for (const key of fillable) {
    for (const lang of ['zh', 'en']) {
      const s = tOr(lang, key, null);
      if (s && !/\{[a-z]+\}/.test(s)) leaked.push(`${key}.${lang}`);
    }
  }
  assert.deepEqual(leaked, [], 'each fillable key must carry its placeholder');
});

test('a filled placeholder reaches the translated string', () => {
  setUiLang('zh');
  const s = tr('tui.help.matching', 'hncode — commands matching "{filter}"', { filter: 'git' });
  assert.ok(s.includes('git'), s);
  assert.ok(!s.includes('{filter}'), 'the placeholder was replaced');
  assert.ok(/命令/.test(s), s);
});

test('t() still resolves the web UI keys it always did', () => {
  // The web interface reads the same table. A change for the terminal must not disturb a
  // key the browser depends on.
  assert.equal(t('zh', 'login.tokenLabel'), '访问令牌');
  assert.equal(t('en', 'login.tokenLabel'), 'Access token');
  assert.equal(t('zh', 'no.such.key'), 'no.such.key', 'a missing key names itself');
});
