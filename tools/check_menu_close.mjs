// Does the editor's context menu CLOSE after picking an item?
import os from 'node:os';

const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');
const ROWS = 24, COLS = 80;
const cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ' '));
let r = 0, c = 0;
process.stdout.write = (s) => {
  const str = String(s);
  let i = 0;
  while (i < str.length) {
    let m = /^\x1b\[(\d+);(\d+)H/.exec(str.slice(i));
    if (m) { r = +m[1] - 1; c = +m[2] - 1; i += m[0].length; continue; }
    m = /^\x1b[\]P_][\s\S]*?(?:\x07|\x1b\\)/.exec(str.slice(i));
    if (m) { i += m[0].length; continue; }
    m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
    if (m) { i += m[0].length; continue; }
    const ch = str[i];
    if (ch === '\r') { c = 0; i++; continue; }
    if (ch === '\n') { r++; c = 0; i++; continue; }
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) cells[r][c] = ch;
    c = Math.min(COLS - 1, c + 1); i++;
  }
  return true;
};
process.stdout.getWindowSize = () => [COLS, ROWS];
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', headers: new Map(), text: async () => '{}', json: async () => ({}), body: null });

const cfg = { model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: os.tmpdir(),
  raw: { providers: {}, models: { 'p/m': {} } } };
const session = { id: 's', workspace: os.tmpdir(), model: 'p/m', messages: [] };

const tui = await import('../src/tui.js');
tui.startTUI({ cfg, session, opts: {} }).catch(() => {});
await sleep(1200);

const text = () => Array.from({ length: ROWS }, (_, y) => cells[y].join('')).join('\n');
const sgr = (b, col, row, press) => `\x1b[<${b};${col};${row}${press ? 'M' : 'm'}`;

process.stdin.emit('data', '/websearch-api\r');
await sleep(500);
process.stdin.emit('data', 'abc');
await sleep(400);

// Right-click -> menu.
process.stdin.emit('data', sgr(2, 20, 6, true));
await sleep(500);
say('menu open    : ' + (text().includes('Select all') ? 'yes' : 'no'));

// Pick "Select all": the second item down. Click its row.
const rows = Array.from({ length: ROWS }, (_, y) => cells[y].join(''));
let selAllRow = rows.findIndex((l) => l.includes('Select all'));
say('Select all on row ' + selAllRow);
// Hover first so the picker settles, then press on the freshly-read row.
process.stdin.emit('data', sgr(35, 20, selAllRow + 1, true));
await sleep(250);
const again = Array.from({ length: ROWS }, (_, y) => cells[y].join(''));
selAllRow = again.findIndex((l) => l.includes('Select all'));
say('after hover : row ' + selAllRow);
const line = cells[selAllRow].join('');
const hitCol = line.indexOf('Select all') + 2;   // a couple of cells INTO the label
say('clicking col ' + (hitCol + 1) + ' on row ' + (selAllRow + 1));
process.stdin.emit('data', sgr(0, hitCol + 1, selAllRow + 1, true));
await sleep(250);
process.stdin.emit('data', sgr(0, hitCol + 1, selAllRow + 1, false));
await sleep(700);

say('menu closed  : ' + (text().includes('Select all') ? 'STILL OPEN' : 'yes'));

process.exit(0);
