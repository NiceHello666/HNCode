// Drive the REAL editor: open it, type, drag across the text with the mouse, and check the selection appears —
// then right-click and check the menu offers Copy / Cut / Paste / Select all.
//
// The handlers live inside `startTUI`, so nothing here can call them directly: the only honest test pushes
// terminal input into the same stream a keyboard and mouse would, and reads the result off the screen model.
import os from 'node:os';

const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');

const COLS = 80;
const ROWS = 24;
const SEL_BG = '0,70,84';   // C.selBg   // C.selBg in the dark theme

class Screen {
  constructor() {
    this.cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ ch: ' ', bg: null })));
    this.r = 0; this.c = 0; this.bg = null;
  }
  write(s) {
    let i = 0;
    while (i < s.length) {
      let m = /^\x1b\[(\d+);(\d+)H/.exec(s.slice(i));
      if (m) { this.r = Number(m[1]) - 1; this.c = Number(m[2]) - 1; i += m[0].length; continue; }
      m = /^\x1b\[([0-9;]*)m/.exec(s.slice(i));
      if (m) {
        const p = (m[1] || '').split(';').map(Number);
        if (p[0] === 0) this.bg = null;
        else if (p[0] === 48 && p[1] === 2) this.bg = `${p[2]},${p[3]},${p[4]}`;
        else if (p[0] === 48 && p[1] === 5) this.bg = `256:${p[2]}`;
        i += m[0].length; continue;
      }
      m = /^\x1b[\]P_][\s\S]*?(?:\x07|\x1b\\)/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
      m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
      const ch = s[i];
      if (ch === '\r') { this.c = 0; i++; continue; }
      if (ch === '\n') { this.r++; this.c = 0; i++; continue; }
      if (this.r >= 0 && this.r < ROWS && this.c >= 0 && this.c < COLS) this.cells[this.r][this.c] = { ch, bg: this.bg };
      this.c = Math.min(COLS - 1, this.c + 1);
      i++;
    }
  }
  line(r) { return this.cells[r].map((c) => c.ch).join(''); }
  text() { return Array.from({ length: ROWS }, (_, r) => this.line(r)).join('\n'); }
}

const screen = new Screen();
process.stdout.write = (s) => { screen.write(String(s)); return true; };
process.stdout.getWindowSize = () => [COLS, ROWS];
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async () => ({
  ok: true, status: 200, statusText: 'OK',
  headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
  json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  body: null,
});

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: os.tmpdir(),
  raw: { providers: {}, models: { 'p/m': {} } },
};
const session = { id: 's', workspace: os.tmpdir(), model: 'p/m', messages: [] };

const { startTUI } = await import('../src/tui.js');
startTUI({ cfg, session, opts: {} }).catch(() => {});

const readyBy = Date.now() + 10000;
while (Date.now() < readyBy) {
  await sleep(60);
  if (screen.text().includes('/compact') || screen.text().includes('Ask')) break;
}

const sgr = (btn, col, row, press) => `\x1b[<${btn};${col};${row}${press ? 'M' : 'm'}`;

process.stdin.emit('data', '/websearch-api\r');
await sleep(500);
process.stdin.emit('data', 'hello world this is editable');
await sleep(500);

const titleRow = screen.cells.findIndex((_, r) => screen.line(r).includes('WebSearch API keys'));
say('editor opened : ' + (titleRow >= 0 ? 'yes (title at row ' + titleRow + ')' : 'NO'));
const bodyTop = titleRow + 4;
say('body row      : ' + JSON.stringify(screen.line(bodyTop).trim().slice(0, 40)));

// DRAG across the first body row, columns 1..12.
process.stdin.emit('data', sgr(0, 1, bodyTop + 1, true));
await sleep(150);
process.stdin.emit('data', sgr(32, 12, bodyTop + 1, true));
await sleep(150);
process.stdin.emit('data', sgr(0, 12, bodyTop + 1, false));
await sleep(400);

const marked = screen.cells[bodyTop].map((c, i) => (c.bg === SEL_BG ? i : -1)).filter((i) => i >= 0);
say('selection     : ' + (marked.length
  ? `cols ${marked[0]}..${marked[marked.length - 1]} = ${JSON.stringify(screen.cells[bodyTop].slice(marked[0], marked[marked.length - 1] + 1).map((c) => c.ch).join(''))}`
  : 'NONE'));

// RIGHT-CLICK inside the editor.
process.stdin.emit('data', sgr(2, 10, bodyTop + 1, true));
await sleep(600);
const menu = screen.text();
say('');
say('right-click menu:');
for (const label of ['Copy', 'Cut', 'Paste', 'Select all']) {
  say('  ' + label.padEnd(12) + (menu.includes(label) ? 'present' : 'MISSING'));
}

process.exit(0);
