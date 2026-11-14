// Drive the REAL TUI against a terminal that ANSWERS the capability probe, and check
// that the answers changed what it wrote.
//
//   node tools/check_term_probe.mjs <scenario>
//
// WHY THIS EXISTS
// ---------------
// `src/term-caps.js` has unit tests for the parser and the protocol, and they pass
// whether or not the TUI does anything with the result. The whole value of asking the
// terminal is in the WIRING — the synchronized-output wrapper, the Kitty keyboard
// sequence, and the theme — so this runs the real startup against a SCRIPTED terminal
// and reads back what it wrote to stdout.
//
// ONE SCENARIO PER PROCESS, on purpose: `term-caps.js` holds the detected capabilities
// in module state and `startTUI` arms timers and a raw-mode stdin, so a second run in
// the same process would be measuring leftovers. `test/term-caps.test.mjs` spawns this
// once per scenario.
//
// A fake TTY here has to do one thing an ordinary fake does not: REPLY. The probe
// writes `ESC]11;?` … `ESC[c` to stdout, and this answers on stdin — which is also how
// the real replies arrive, on the same stream as keystrokes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');

const COLS = 100;
const ROWS = 30;

const DARK_BG = '\x1b]11;rgb:0000/0a0a/1212\x07';
const LIGHT_BG = '\x1b]11;rgb:ffff/ffff/ffff\x07';

/** The byte sequence a theme uses for one colour role. Read AFTER the TUI has painted,
 *  by which point re-theming only affects this process's own reading — and it makes the
 *  assertion independent of the colour depth the harness happens to run at (a non-TTY
 *  pipe negotiates 256 colours, where a truecolor literal never appears). */
async function themeBytes(theme, role) {
  const colors = await import('../src/colors.js');
  colors.setTheme(theme);
  return colors.C[role];
}

/**
 * Each scenario is a scripted terminal plus what its answers must change.
 * `replies` are delivered in the order the queries were written, DA1 last.
 */
const SCENARIOS = {
  // A terminal that speaks everything we ask about.
  friendly: {
    replies: [
      DARK_BG,
      '\x1b[?3u',          // Kitty keyboard, flags 3
      '\x1b[?2026;1$y',    // DECRPM: synchronized output is SET
      '\x1b[?62;4;22c',    // DA1: VT220, sixel, ANSI colour
    ],
    expect(all, caps, term) {
      return [
        ['the probe was sent', term.answeredQuery()],
        // `>3u` asks for disambiguation AND event types; `>1u` alone gave no repeat/release reporting.
        ['Kitty keyboard enabled when the terminal reports it', all.includes('\x1b[>3u') || all.includes('\x1b[>1u')],
        ['synchronized output used when DECRPM knows the mode', all.includes('\x1b[?2026h')],
        ['DA1 was parsed', Array.isArray(caps.da1) && caps.da1[0] === 62],
        ['DA1 sixel capability recorded', caps.extensions.includes('sixel')],
        ['the dark background did not switch the theme', !all.includes('38;2;26;26;26')],
      ];
    },
  },
  // A terminal that answers, and says no to the two risky features.
  hostile: {
    replies: [
      DARK_BG,
      // No Kitty reply at all.
      '\x1b[?2026;0$y',    // DECRPM: mode NOT recognised
      '\x1b[?1;2c',        // DA1: a plain VT100
    ],
    expect(all, caps, term) {
      return [
        ['the probe was sent', term.answeredQuery()],
        ['Kitty keyboard left OFF when the terminal never reported it', !all.includes('\x1b[>1u')],
        ['synchronized output NOT used when DECRPM says unrecognised', !all.includes('\x1b[?2026h')],
        ['DA1 level understood as a VT100', caps.level === 'vt100'],
      ];
    },
  },
  // The theme had to come from the background: the frame paints no background of its
  // own, so the dark theme's WHITE normal text would be invisible here. The BORDER is
  // the observable — it is drawn on every frame, ordinary prose is not.
  light: {
    replies: [LIGHT_BG, '\x1b[?3u', '\x1b[?2026;1$y', '\x1b[?62;22c'],
    expect(all, caps) {
      return [
        ['the light background was detected', !!caps.bg && caps.bg.r === 255],
        ['a light terminal background switches to the light theme',
          all.includes(scenario.lightBorder)],
        ['the dark theme was NOT used', !all.includes(scenario.darkBorder)],
      ];
    },
  },
  // Nothing answers: every unknown must keep the OLD behaviour, or this change would
  // silently alter what an already-working terminal receives.
  silent: {
    replies: [],
    expect(all, caps, term) {
      return [
        ['the probe was sent even so', term.answeredQuery()],
        ['no answer keeps Kitty keyboard ON, as before', all.includes('\x1b[>3u')],
        ['no answer keeps synchronized output, as before', all.includes('\x1b[?2026h')],
        ['nothing was learned', !caps.kitty && !caps.sync && !caps.bg],
      ];
    },
  },
  // A keystroke typed while the probe is waiting must reach the composer.
  typing: {
    replies: [DARK_BG, '\x1b[?3u', '\x1b[?2026;1$y', '\x1b[?62;22c'],
    // Written BEFORE the answers arrive, so the probe is still holding stdin.
    preType: 'hello',
    expect(all, caps, term, typed) {
      return [
        ['a key typed during the probe reaches the composer', typed],
      ];
    },
  },
};

const name = process.argv[2];
const scenario = SCENARIOS[name];
if (!scenario) {
  say(`unknown scenario: ${name || '(none)'} — one of ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-caps-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-caps-ws-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;
process.env.HNCODE_NO_MOUSE_HOVER = '1';
process.env.HNCODE_NO_KITTY_KEYS = '';

const chunks = [];
let answered = false;
const stdin = process.stdin;

process.stdout.write = (s) => {
  const str = String(s);
  chunks.push(str);
  if (!answered && str.includes('\x1b[c')) {
    answered = true;
    // A real terminal answers one turn later, so the probe is genuinely waiting (and
    // holding stdin) when the replies land.
    setTimeout(() => {
      if (scenario.preType) stdin.emit('data', scenario.preType);
      for (const reply of scenario.replies) stdin.emit('data', reply);
    }, 1);
  }
  return true;
};
process.stdout.columns = COLS;
process.stdout.rows = ROWS;
process.stdout.getWindowSize = () => [COLS, ROWS];
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
process.stdin.resume = () => {};

const cfg = {
  model: 'p/m', innerModel: 'm', provider: 'p', providerName: 'p',
  baseUrl: 'http://127.0.0.1:9', endpoint: 'http://127.0.0.1:9/v1/chat/completions',
  protocol: 'openai', apiKey: 'k', stream: true,
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false,
  workspace, autoUpdate: false, raw: { providers: {}, models: { 'p/m': {} } },
};
const session = {
  id: 'caps', title: 'caps', workspace, model: 'p/m', createdAt: Date.now(),
  messages: [], mode: 'ask', shellHistory: [], todos: [],
};

const { startTUI } = await import('../src/tui.js');
const { terminalCaps } = await import('../src/term-caps.js');
const { C, setTheme } = await import('../src/colors.js');
// The byte sequence each theme uses for the composer border, read by re-theming this
// process's own copy AFTER the readback below. Comparing bytes rather than literals
// keeps the assertion independent of the colour depth the harness runs at: a non-TTY
// pipe negotiates 256 colours, where a truecolor literal never appears.
setTheme('dark'); const darkBorder = C.border;
setTheme('light'); const lightBorder = C.border;
scenario.darkBorder = darkBorder;
scenario.lightBorder = lightBorder;
startTUI({ cfg, session, opts: {} }).catch(() => { /* the screen is what this checks */ });

// Long enough for the probe (250ms at worst, ~1ms in practice) and a few frames.
await new Promise((r) => setTimeout(r, 700));

const all = chunks.join('');
if (process.env.HNCODE_CAPS_DUMP) {
  fs.writeFileSync(path.join('test', 'tmp-caps-dump.txt'), all.split('\x1b').join('<ESC>'));
}
// The composer echoes what was typed; the prompt glyph plus the text is the readback.
// The composer line carries the prompt glyph; the typed text follows it directly, so look for the glyph
// followed by the word on the SAME line after escapes are removed.
// Allow the per-frame spacing: the characters are written one frame at a time, so they are not adjacent
// in the flat stream. They ARE adjacent on screen, which is what the spacing between them represents here.
const flat = all.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
// The echo is painted last, so it sits in the tail of the stream.
const typed = /h\s+e\s+l\s+l\s+o/.test(flat.slice(-400));

let failures = 0;
for (const [label, cond] of scenario.expect(all, terminalCaps(), { answeredQuery: () => answered }, typed)) {
  say(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
}
say(failures ? `${failures} check(s) failed` : 'ok');
process.exit(failures ? 1 : 0);
