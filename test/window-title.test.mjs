// The terminal window title must follow the session.
//
// WHY THIS FILE EXISTS
// --------------------
// The OS title (OSC 0) was written at four unrelated sites and NONE of them ran at startup.
// A session that already had a title — i.e. any resumed session — opened with whatever the
// shell had left on the window, and the name only appeared once something CHANGED it
// (`/title`, or a fresh auto-naming on a new session). So the title you generated looked
// lost on the next launch.
//
// The sites had also drifted: `/new` wrote the literal "Untitled", `/title` computed a
// `displayTitle` fallback, auto-naming and the hub action each wrote `session.title` with no
// fallback at all. One helper now owns the write, and these tests pin the parts that matter:
// it runs at startup, it covers every path that changes the title, and it cannot throw.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src/tui.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split(/\r?\n/);
const { writeWindowTitle } = await import('../src/tui.js');

const OSC = (t) => `\x1b]0;${t}\x07`;
const sink = () => { const w = []; return { w, write: (s) => w.push(s) }; };

// ---------------------------------------------------------------------------
// the helper
// ---------------------------------------------------------------------------

test('the session title is written as an OSC 0 sequence', () => {
  const out = sink();
  writeWindowTitle({ title: 'Fix the login button' }, out);
  assert.deepEqual(out.w, [OSC('Fix the login button')]);
});

test('a session with no name shows Untitled rather than the previous title', () => {
  // The window keeps whatever was last set, so writing nothing would leave a stale name up.
  for (const session of [{ title: '' }, { title: '   ' }, {}, null]) {
    const out = sink();
    writeWindowTitle(session, out);
    assert.deepEqual(out.w, [OSC('Untitled')], `for ${JSON.stringify(session)}`);
  }
});

test('the title is trimmed and cannot inject the terminator', () => {
  const out = sink();
  writeWindowTitle({ title: '  spaced  ' }, out);
  assert.deepEqual(out.w, [OSC('spaced')]);
});

test('a missing stream cannot throw', () => {
  // A window title is cosmetic; it must not be able to fail a turn. `stdout` is absent in
  // some headless callers, which is why the helper checks rather than assumes.
  assert.doesNotThrow(() => writeWindowTitle({ title: 'x' }, undefined));
  assert.doesNotThrow(() => writeWindowTitle({ title: 'x' }, {}));
});

// ---------------------------------------------------------------------------
// every path that changes the title goes through it
// ---------------------------------------------------------------------------

test('one place owns the escape sequence', () => {
  const raws = lines.map((l, i) => ({ i: i + 1, l })).filter(({ l }) => l.includes(']0;'));
  assert.equal(raws.length, 1,
    `the OSC 0 write lives in writeWindowTitle only; found ${raws.length}: ${raws.map((r) => r.i).join(', ')}`);
  assert.match(raws[0].l, /`\\x1b\]0;/, 'and it is the helper itself');
});

test('the title is set at STARTUP, so a resumed session adopts its name', () => {
  // The reported bug. The write must happen during SETUP — right after the alternate screen
  // is entered — and not merely somewhere later in the file. A title set before the alt
  // screen belongs to the previous screen's frame.
  //
  // The window is bounded on purpose: call sites exist far below this point (in `/title`, in
  // the hub action, in the resume path), so an unbounded search finds one of THEM and the
  // assertion passes with the startup write deleted.
  const start = lines.findIndex((l) => /^export async function startTUI\(/.test(l));
  assert.ok(start > 0, 'startTUI is module level');
  // `/vim` re-enters the alternate screen too. Find the startup write by its own call site, not by whichever
  // `alternateScreen(true)` happens to be first: the external editor's restore path is a different place entirely.
  const alt = lines.findIndex((l, i) => i > start && /stdout\.write\(alternateScreen\(true\)\)/.test(l));
  assert.ok(alt > 0, 'the alternate screen is entered');
  const window = lines.slice(alt, alt + 20);
  const set = window.findIndex((l) => /writeWindowTitle\(session, stdout\)/.test(l));
  assert.ok(set > 0, 'the title is written during startup, within 20 lines of entering the alt screen');
  // It must not be guarded behind a condition: an UNTITLED session still needs "Untitled".
  const line = window[set].trim();
  assert.ok(!/^\s*(if|else|\})/.test(line) && !line.startsWith('//'),
    `the startup write is unconditional, got: ${line}`);
});

test('every assignment to session.title is followed by a window-title write', () => {
  // Each of the three ways a title changes must reach the window. The assignment list is
  // derived from the source, so a NEW assignment site is caught rather than silently missing.
  const sites = [];
  lines.forEach((l, i) => { if (/\bsession\.title\s*=/.test(l)) sites.push(i); });
  assert.ok(sites.length >= 3, `title assignment sites found (${sites.length})`);
  for (const i of sites) {
    // Within the next few lines, the window must be updated.
    const window = lines.slice(i, i + 8).join('\n');
    assert.match(window, /writeWindowTitle\(/,
      `session.title assigned at line ${i + 1} must update the window title`);
  }
});

test('switching or resuming a session updates the window title', () => {
  // `replaceSession` rebinds the closure's session (/move, /sessions), and the in-place
  // resume swaps the conversation under the same object. Both leave a stale name up unless
  // they re-write the title.
  const replaceSites = lines
    .map((l, i) => ({ i: i + 1, l }))
    .filter(({ l }) => /replaceSession\s*:/.test(l));
  assert.ok(replaceSites.length >= 1, 'replaceSession exists');
  for (const s of replaceSites) {
    assert.match(s.l, /writeWindowTitle\(/, `replaceSession at line ${s.i} updates the window title`);
  }
  // The in-place resume: `Object.assign(session, full)` in the /sessions path.
  const resume = lines.findIndex((l) => /Object\.assign\(session, full\)/.test(l));
  assert.ok(resume > 0, 'the resume path is present');
  const around = lines.slice(resume, resume + 12).join('\n');
  assert.match(around, /writeWindowTitle\(/, 'the resume path updates the window title');
});
