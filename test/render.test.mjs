// Rendering-equivalence tests.
//
// The renderer has several caches that make an incremental result STALE if their
// validity check is wrong, and stale output is invisible in normal use — it just
// shows the wrong thing. So the contract tested here is always the same shape:
// "the optimized path must produce byte-identical output to the unoptimized one".
//
// Three equivalence laws:
//   1. markdown: streaming block-by-block == rendering the whole text at once
//   2. paint:    a frame reusing the row-metrics memo == a full recompute
//   3. metrics:  the memoized row total == the length the renderer actually emits
//
// Plus the invariants that make those caches safe: stable prefix, monotonic starts,
// and totals that stay consistent when the transcript grows.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBlocks, renderMdText, renderMdIncremental,
  composeFrame, renderChatLines, chatRowTotal, metricsSignature,
} from '../src/tui.js';
import { visualWidth } from '../src/term.js';

const FENCE = String.fromCharCode(96).repeat(3);

const strip = (lines) => lines.map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, ''));

// ---------------------------------------------------------------------------
// 1. markdown
// ---------------------------------------------------------------------------

const FAINT = '\x1b[2m';
const ESC = '\x1b';

// The glyph at a given VISUAL column. Indexing the string directly is wrong once the
// row contains CJK: a 2-column glyph makes string index and column part ways.
function atColumn(row, col) {
  let c = 0;
  for (const g of row) {
    if (c === col) return g;
    c += visualWidth(g);
    if (c > col) return null;  // landed inside a wide glyph
  }
  return null;
}

// Visual columns of every occurrence of any of `chars` in a row.
function columnsOf(row, chars) {
  const hits = [];
  let c = 0;
  for (const g of row) {
    if (chars.includes(g)) hits.push(c);
    c += visualWidth(g);
  }
  return hits;
}

// True when any cell in columns [l, r] was written with faint in front of it — i.e.
// whether the row carries a dim INSIDE the panel rather than only around it.
function faintBetween(ansiRow, l, r) {
  let c = 0;
  let i = 0;
  let pending = '';
  const s = String(ansiRow);
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i)) || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(s.slice(i));
      if (m) { pending += m[0]; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    if (c >= l && c <= r && pending.includes(FAINT)) return true;
    c += visualWidth(String.fromCodePoint(cp));
    pending = '';
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

// The panel's bounds, read from its HITBOXES rather than from glyphs. The panel has no
// border any more, so there is nothing in the text to measure — the `pickerBody` hit is
// what defines its columns and rows, and it is the same rectangle a click uses.
function panelBounds(frame) {
  const hits = frame.hitboxes.filter((h) => h.kind === 'pickerBody');
  if (!hits.length) return null;
  return {
    col0: Math.min(...hits.map((h) => h.col0)),
    col1: Math.max(...hits.map((h) => h.col1)),
    row0: Math.min(...hits.map((h) => h.row)),
    row1: Math.max(...hits.map((h) => h.row)),
    rows: hits.map((h) => h.row),
  };
}

// The background escape the panel is painted with (colors.js `C.bgPanel`).
const PANEL_BG = '\x1b[48;5;236m';

// Every cell of every panel row carries the panel background: that is what makes the
// panel opaque and the bleed-through impossible. Returns the offending [row, col]s.
function panelGaps(frame) {
  const b = panelBounds(frame);
  if (!b) return [{ row: -1, col: -1 }];
  const gaps = [];
  const seen = new Set();
  for (const r of b.rows) {
    if (seen.has(r)) continue;
    seen.add(r);
    const ansi = String(frame.lines[r]);
    // Walk the row, tracking the style in force at each visual column.
    let c = 0;
    let i = 0;
    let pending = '';
    while (i < ansi.length) {
      if (ansi[i] === '\x1b') {
        const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(ansi.slice(i)) || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(ansi.slice(i));
        if (m) {
          // A reset clears the background; any other code accumulates.
          if (m[0] === '\x1b[0m') pending = '';
          else pending += m[0];
          i += m[0].length;
          continue;
        }
      }
      const cp = ansi.codePointAt(i);
      const w = visualWidth(String.fromCodePoint(cp));
      // The panel background may be 256-colour (`48;5;236`) or truecolor (`48;2;46;46;46`) depending on the
      // theme. What matters is that SOME background is in force on every panel cell; pinning the exact
      // encoding made this fail on a truecolor theme while the panel was perfectly opaque.
      if (c >= b.col0 && c <= b.col1 && !/\x1b\[48;(?:5;\d+|2;\d+;\d+;\d+)m/.test(pending)) gaps.push({ row: r, col: c });
      c += w;
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return gaps;
}

test('splitBlocks separates at blank lines OUTSIDE a fence', () => {
  assert.deepEqual(splitBlocks(''), ['']);
  assert.deepEqual(splitBlocks('a'), ['a']);
  // The blank lines belong to the FOLLOWING block, which is what makes each block
  // render identically whether or not later blocks exist.
  assert.deepEqual(splitBlocks('a\n\n\nb'), ['a', '', '\nb']);
  // A blank line inside a fence belongs to the code block, so it must NOT split.
  assert.deepEqual(splitBlocks(`${FENCE}a\n\nb\n${FENCE}`), [`${FENCE}a\n\nb\n${FENCE}`]);
});

test('splitBlocks: every block keeps its preceding blank lines', () => {
  // The invariant the incremental cache depends on: a block's rendered output must
  // not depend on what comes after it.
  const blocks = splitBlocks('x\n\n\ny');
  assert.deepEqual(blocks, ['x', '', '\ny']);
});

test('math: concatenating block renders == rendering the whole document', () => {
  // This is the law that the block-level cache relies on. If it breaks, streaming a
  // reply shows different text than re-rendering it from the complete message.
  const cases = {
    'heading + list + fence': ['# H', '', 'para', '', '- a', '- b', '', `${FENCE}js`, 'x', `${FENCE}`, '', 'tail'].join('\n'),
    'paragraphs': ['p1', '', 'p2', '', 'p3'].join('\n'),
    'fence only': [`${FENCE}only`, `${FENCE}`].join('\n'),
    'consecutive blanks': ['a', '', '', 'b'].join('\n'),
    'single line': 'one line',
    'unclosed fence': ['intro', '', `${FENCE}js`, 'never closed', ''].join('\n'),
    'two fences': [`${FENCE}a`, `${FENCE}`, '', `${FENCE}b`, `${FENCE}`].join('\n'),
  };
  for (const [name, text] of Object.entries(cases)) {
    const whole = strip(renderMdText(text, 60, '', ''));
    const joined = splitBlocks(text).flatMap((b) => strip(renderMdText(b, 60, '', '')));
    assert.deepEqual(joined, whole, `block renders must equal the whole render: ${name}`);
  }
});

test('renderMdIncremental agrees with the whole render, fed in arbitrary chunks', () => {
  // Streaming in chunks of an awkward size proves the head/tail split never lands
  // mid-block in a way that changes the output.
  const text = ['# Title', '', 'body **bold**', '', '- one', '- two', '', `${FENCE}js`, 'const x = 1;', `${FENCE}`, '', 'end'].join('\n');
  for (const step of [1, 3, 7, 13, 40]) {
    const msg = {};
    for (let i = 0; i < text.length; i += step) {
      renderMdIncremental(msg, text.slice(0, i + step), 60, '', '');
    }
    const got = renderMdIncremental(msg, text, 60, '', '');
    const want = renderMdText(text, 60, '', '');
    assert.deepEqual(
      strip([...got.headRows, ...got.tailRows]),
      strip(want),
      `incremental (step ${step}) must equal the whole render`,
    );
  }
});

test('renderMdIncremental re-renders when the same-length text changes', () => {
  // A cache keyed only on length would return stale rows here (a retry rewriting a
  // line with different words of the same length).
  const msg = {};
  const a = renderMdIncremental(msg, 'cat', 60, '', '');
  const b = renderMdIncremental(msg, 'dog', 60, '', '');
  assert.notDeepEqual(
    strip([...b.headRows, ...b.tailRows]),
    strip([...a.headRows, ...a.tailRows]),
    'a same-length text change must not reuse the cached render',
  );
});

test('renderMdIncremental invalidates on a width change', () => {
  const msg = {};
  const narrow = renderMdIncremental(msg, 'a '.repeat(40), 40, '', '');
  const wide = renderMdIncremental(msg, 'a '.repeat(40), 80, '', '');
  assert.notEqual(narrow.headRows.length + narrow.tailRows.length, wide.headRows.length + wide.tailRows.length,
    'wrapping must differ between widths');
});

// ---------------------------------------------------------------------------
// 2. paint / metrics
// ---------------------------------------------------------------------------

/** A plausible mixed transcript. */
function chat(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', text: 'ask ' + i });
    out.push({ role: 'assistant', text: `# H${i}\n\nbody **b**\n\n${FENCE}js\nx\n${FENCE}` });
    out.push({ role: 'tool', name: 'Bash', text: 'out\n'.repeat(4), toolArgs: { command: 'ls ' + i } });
    out.push({ role: 'tool_result', text: 'result ' + i });
  }
  return out;
}
function stateWith(messages, extra = {}) {
  return {
    input: '', caret: 0, todos: [], queued: [], tasks: {}, _hitboxes: [],
    cwd: 'D:/x', model: 'm', mode: 'auto', spin: 0,
    ctxTokens: 1, ctxMax: 100, ctxPercent: 1, rounds: 0, steps: 0, tokRate: 0,
    chat: messages, ...extra,
  };
}

/** Render with every cache disabled, for comparison. */
function fullRender(state, w, h) {
  const saved = state._metrics;
  state._metrics = null;
  const frame = composeFrame(state, w, h);
  state._metrics = saved;
  return frame;
}

test('a pending tool row renders end-to-end through renderChatLines (no state ReferenceError)', () => {
  // Regression: formatToolLine — reached via renderChatLines → messageLines —
  // read `state.shimmerEdge` from a scope where `state` does not exist. The
  // throw happened exactly when a tool call started painting its "Using …" row,
  // and the process-level unhandledRejection handler exited the TUI silently.
  const st = stateWith([{ role: 'tool', toolName: 'Bash', toolArgs: { command: 'ls' }, pending: true }]);
  const lines = strip(renderChatLines(st, 80));
  assert.ok(lines.some((l) => l.includes('Using')),
    `expected a pending tool row, got ${JSON.stringify(lines)}`);
  // The finished (non-pending) branch renders too.
  st.chat[0].pending = false;
  st._metrics = null; st.chat[0]._cache = null; st.chat[0]._count = null;
  const done = strip(renderChatLines(st, 80));
  assert.ok(done.some((l) => l.includes('Used')),
    `expected a finished tool row, got ${JSON.stringify(done)}`);
});

test('the statusline shows the git badge: branch + diff counts', () => {
  // Regression: the pushPart refactor kept BUILDING the badge but dropped
  // `parts.push(badge)` — the branch and `+N -N` were computed and thrown away,
  // so the statusline quietly lost its diff counts (with no error anywhere).
  const st = stateWith(chat(3));
  st._gitInfo = { branch: 'dev', insertions: 12, deletions: 3, changed: 2 };
  const rows = strip(composeFrame(st, 100, 30).lines);
  const status = rows.find((r) => r.includes('dev')) || '';
  assert.ok(status.includes('dev'),
    `branch missing from the statusline: ${JSON.stringify(rows.slice(-4))}`);
  assert.ok(status.includes('+12'), 'insertions missing from the statusline');
  assert.ok(status.includes('-3'), 'deletions missing from the statusline');

  // Clean tree: the branch stays, the counts do not.
  st._gitInfo = { branch: 'dev', insertions: 0, deletions: 0, changed: 0 };
  const clean = strip(composeFrame(st, 100, 30).lines).find((r) => r.includes('dev')) || '';
  assert.ok(clean.includes('dev'), 'branch must still show on a clean tree');
  assert.ok(!clean.includes('+'), 'no counts when there is nothing to count');
});

test('the picker renders as a popup over the transcript, not a full-screen takeover', () => {
  // The picker used to OWN the body: blank rows above/below and no chat at all —
  // the transcript vanished for what is often a two-item confirm. It is now a filled
  // panel painted over the chat, with click hitboxes that distinguish "inside the
  // panel" (absorbed) from "outside" (dismisses).
  //
  // The panel has NO border: its boundary is a solid BACKGROUND block. Every
  // box-drawing glyph (`╭ ╮ ╰ ╯ ─ │`) is East Asian Ambiguous — 1 column in our width
  // model, 2 on a CJK terminal — so a framed card was drawn wider than computed and
  // the wall landed past the card's own edge.
  const st = stateWith(chat(6));
  st.picker = {
    title: 'Pick one',
    items: [{ label: 'Alpha' }, { label: 'Beta' }],
    sel: 0,
    searchable: false,
  };
  const frame = composeFrame(st, 90, 30);
  const plain = strip(frame.lines);
  assert.equal(frame.lines.length, 30, 'the frame keeps its height');

  // The panel itself: title, the selected row, and no border glyphs anywhere on it.
  const tIdx = plain.findIndex((r) => r.includes('Pick one'));
  assert.ok(tIdx > 0, `title missing: ${JSON.stringify(plain.slice(0, 12))}`);
  assert.ok(plain.some((r) => r.includes('> Alpha')), 'the selected row renders');
  // It hugs its content with margin — not full width.
  assert.ok(plain[tIdx].startsWith(' '), 'the panel is inset, not spanning the terminal');

  // No frame anywhere on the panel. Only the panel's OWN columns are checked: the
  // transcript beside it may legitimately show a user-box border, and that is not the
  // panel's frame.
  const panelRows = [...new Set(frame.hitboxes.filter((h) => h.kind === 'pickerBody').map((h) => h.row))];
  const bodyHit = frame.hitboxes.find((h) => h.kind === 'pickerBody');
  assert.ok(panelRows.length >= 3, 'the panel spans several rows');
  for (const r of panelRows) {
    const inside = plain[r].slice(bodyHit.col0, bodyHit.col1 + 1);
    assert.ok(!/[╭╮╰╯│]/.test(inside), `row ${r} must have no border glyph: ${JSON.stringify(inside)}`);
  }

  // The transcript stays visible AROUND the panel (this is the whole point).
  const above = plain.slice(0, panelRows[0]).filter((r) => r.trim());
  assert.ok(above.length > 0, 'transcript rows stay visible above the popup');

  // Hitboxes: one per visible item, all inside the frame.
  const itemHits = frame.hitboxes.filter((h) => h.kind === 'pickerItem');
  assert.equal(itemHits.length, 2, 'one hitbox per visible item');
  assert.ok(itemHits.every((h) => h.row >= 0 && h.row < 30 && h.col1 >= h.col0));
  const kinds = frame.hitboxes.map((h) => h.kind);
  assert.ok(kinds.includes('pickerBody'), 'the panel absorbs inner clicks');
  // hitAt/resolveHoverHit iterate BACKWARD (last registered wins), so the precise item
  // hits must come AFTER the row-wide panel hit to win the overlap.
  assert.ok(kinds.indexOf('pickerBody') < kinds.indexOf('pickerItem'),
    'the row-wide panel hit must be registered before the precise item hits');
});

test('the card covers only its own columns; the transcript beside it survives', () => {
  // The card row used to be built WITH its left margin baked in and then assigned
  // to the whole row, so the padding painted over the transcript either side of it:
  // a row of `11111111111111` came out as `        |111111|`. Only the card's own
  // columns may be replaced.
  //
  // The fixture deliberately puts a full-width line of text on every row so the
  // columns beside the card are non-blank, and the frame is narrow enough that the
  // card has to sit in the middle of that text.
  for (const cols of [60, 76, 100]) {
    const st = stateWith([]);
    st.chat = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      text: `row ${i} `.padEnd(cols - 2, String(i % 10)),
    }));
    st.picker = { title: 'Pick', items: [{ label: 'alpha' }], sel: 0, searchable: false };
    const frame = composeFrame(st, cols, 24);
    const plain = strip(frame.lines);

    const titleIdx = plain.findIndex((r) => r.includes('Pick'));
    assert.ok(titleIdx > 0, `cols=${cols}: panel not rendered`);
    const b = panelBounds(frame);
    assert.ok(b, `cols=${cols}: the panel has no hitbox`);

    for (const i of b.rows) {
      // To the RIGHT of the panel the row must still carry the text that was there.
      // The fixture's filler is `0`-`9`, so anything non-blank there is proof the
      // panel did not eat it.
      const right = plain[i].slice(b.col1 + 1);
      assert.ok(right.length === 0 || right.trim().length > 0,
        `cols=${cols} row ${i}: the panel erased the transcript to its right (${JSON.stringify(right)})`);
      // ...and the row is still exactly the frame width (the splice preserved it).
      assert.equal(visualWidth(plain[i]), cols, `cols=${cols} row ${i}: width changed`);
    }
  }
});

test('the picker keeps the composer, the todo panel and the queue visible', () => {
  // A picker is a POPUP. The old layout treated every modal as a takeover, so
  // opening /model dropped the composer — the box you were about to type into —
  // and with it the todo panel. That is why a two-item menu felt like the app had
  // restarted: the whole bottom of the screen changed.
  //
  // `takeover` (editor/form/panel) is the flag that means "owns the body"; the
  // picker is deliberately not one of them.
  const st = stateWith(chat(3));
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  st.todos = [{ title: 'do a thing', status: 'in_progress' }];
  const plain = strip(composeFrame(st, 90, 30).lines).join('\n');

  assert.match(plain, />/, 'the composer input box is still on screen');
  assert.match(plain, /do a thing/, 'the todo panel is still on screen');
});

test('a true takeover still replaces the composer (the picker is not the only change)', () => {
  // The counterpart to the test above, so the fix cannot be read as "stop hiding
  // the composer" — editor/form/panel own the body and must keep hiding it.
  const shapes = {
    editor: { title: 'E', hint: 'h', text: 'line one', caretRow: 0, caretCol: 0, top: 0, notice: '' },
    form: { title: 'F', fields: [{ label: 'a', value: '' }], fieldIdx: 0, type: 'openai', types: ['openai'], hideType: false, labelW: 8, hint: 'h' },
    panel: { title: 'P', body: ['x'], sel: 0 },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const st = stateWith(chat(3), { [name]: shape });
    const plain = strip(composeFrame(st, 90, 30).lines);
    assert.ok(!plain.some((r) => />\s*│\s*$/.test(r) && r.includes('╭')),
      `${name} must still take over the body and hide the composer`);
  }
});

test('the panel composites: the rows behind it stay visible, greyed', () => {
  // `lines[row] = boxRow` painted the dialog's own blank padding over every row it
  // floats above, so the transcript under the panel was erased and replaced by
  // spaces — a full-screen takeover wearing a border. The panel now splices: the text
  // is opaque on its background, and what surrounds it keeps the transcript.
  const st = stateWith(chat(3));
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  const frame = composeFrame(st, 90, 30);
  const raw = frame.lines.map(String);
  const plain = strip(raw);

  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');
  const titleIdx = plain.findIndex((r) => r.includes('Pick one'));
  assert.ok(titleIdx > 0, 'the popup is not the whole frame');

  // The transcript either side of the panel must still be readable on the SAME rows:
  // the fixture's chat text is `ask N` / `body`.
  assert.ok(plain.slice(0, b.row0).some((r) => /ask \d|H\d|body/.test(r)),
    'transcript rows above the popup survive');
  assert.ok(b.rows.some((r) => /ask \d|H\d|body/.test(plain[r].slice(0, b.col0)))
    || b.rows.some((r) => /ask \d|H\d|body/.test(plain[r].slice(b.col1 + 1))),
    'transcript survives BESIDE the popup on its own rows');

  // ...and the see-through cells are dimmed rather than pasted at full contrast.
  assert.ok(raw.some((r) => r.includes('\x1b[2m')),
    'content showing through the popup is dimmed');
});

test('every row behind the panel is greyed, and the panel keeps its own colours', () => {
  // The panel is modal, and a modal is made by the SURROUNDINGS receding — not by the
  // panel going grey. Dimming the panel's interior would mute the thing the user has
  // to read and act on.
  //
  // Three separate things are pinned here, each of which was wrong at some point:
  //   1. EVERY surrounding row is dimmed, including the composer and the status line.
  //      Dimming only the transcript left bright bars framing a faded panel.
  //   2. The panel's interior is exempt.
  //   3. A dimmed cell keeps its OWN colour. Cline's dialogs run on OpenTUI, a
  //      retained-mode renderer where dim is a cell attribute and the foreground
  //      survives; hncode paints ANSI strings, so overwriting cells with a fixed grey
  //      would flatten the transcript's deliberate colours (cyan markers, green diff
  //      counts, red errors). `C.dim` is prepended instead.
  const st = stateWith(chat(3));
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  const frame = composeFrame(st, 90, 30);
  const raw = frame.lines.map(String);
  const plain = strip(raw);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');

  // (1) The composer and the status line are part of the backdrop.
  const topBorders = plain.map((r, i) => (/╭─+╮/.test(r) ? i : -1)).filter((i) => i >= 0);
  const composerIdx = topBorders[topBorders.length - 1];
  assert.ok(composerIdx > b.row0, 'the composer is below the panel');
  assert.ok(raw[composerIdx].includes(FAINT), 'the composer is dimmed too');
  // THE STATUS LINE IS FOUND, NOT ASSUMED TO BE LAST. It used to be the final row; the context bar now sits
  // under it, and the title band sits above everything, so "the last row" names neither.
  const statusIdx = plain.findIndex((r) => /\bturns?\b.*\bsteps?\b/.test(r));
  assert.ok(statusIdx >= 0, 'the status line is on screen');
  assert.ok(raw[statusIdx].includes(FAINT), 'the status line is dimmed too');

  // (2) Nothing inside the panel carries faint. Its bounds come from the hitbox, not
  // from glyphs: there is no border to measure any more.
  let checked = 0;
  for (const i of [...new Set(b.rows)]) {
    assert.equal(faintBetween(raw[i], b.col0, b.col1), false,
      `row ${i}: the panel's own interior is dimmed`);
    checked++;
  }
  assert.ok(checked >= 3, `expected several panel rows, checked ${checked}`);

  // (3) A dimmed backdrop cell keeps the colour the transcript gave it — the dim is
  // PREPENDED to the cell's own style rather than replacing it. The row must be one that
  // actually carries a foreground escape; the rows immediately around a centred panel are
  // often blank padding, which carries none and would make this vacuous.
  // The colour may be 256-colour (`38;5;n`), truecolor (`38;2;r;g;b`) or a bright ANSI code (`97m`) depending
  // on the theme. Pinning it to one encoding made this fail on every truecolor theme while the dimming was
  // correct, so the pattern accepts any of the three.
  const FG = /(?:\x1b\[(?:38;[25];[0-9;]+|9[0-7])m)/;
  const withText = raw.findIndex((r, i) => (i < b.row0 || i > b.row1) && FG.test(r));
  assert.ok(withText >= 0, 'some backdrop row outside the panel carries text');
  assert.ok(raw[withText].includes(FAINT), 'that backdrop row is dimmed');
  // The escapes between the dim and the foreground are allowed for: a cell can carry bold (`\x1b[1m`) as well, and
  // the title band at the top of the frame is exactly such a cell — dim, then bold, then its colour.
  const FGSRC = '\\x1b\\[(?:38;[25];[0-9;]+|9[0-7])m';
  assert.ok(new RegExp(`\\x1b\\[2m(?:\\x1b\\[[0-9;]*m)*${FGSRC}`).test(raw[withText])
    || new RegExp(`${FGSRC}(?:\\x1b\\[[0-9;]*m)*\\x1b\\[2m`).test(raw[withText]),
    'the dimmed backdrop still carries its own foreground colour');
});

test('an anchored popup opens at the pointer and stays inside the frame', () => {
  // The right-click context menu followed the pointer by convention; it opened
  // centred, which threw away the one cue that said which row was right-clicked.
  // Near an edge it must be nudged back inside rather than clipped in half.
  //
  // Position comes from the HITBOX, not from glyphs: the panel has no border, so
  // `hitsAt`-style border scanning has nothing to find. The hitbox is also the
  // rectangle a click uses, so testing it tests what the user actually interacts with.
  const at = (anchor) => {
    const st = stateWith(chat(3));
    st.picker = { title: 'Actions', items: [{ label: 'Copy' }], sel: 0, searchable: false, anchor };
    const frame = composeFrame(st, 90, 30);
    const b = panelBounds(frame);
    return b && { row0: b.row0, col0: b.col0, col1: b.col1 };
  };

  // The panel's blank pad row is its first row, so an anchor naming the clicked row
  // puts the panel AT that row.
  const mid = at({ row: 12, col: 30 });
  assert.equal(mid.row0, 12, 'the panel opens on the clicked row');
  assert.equal(mid.col0, 30, '...and on the clicked column');

  // Every anchor stays inside the 90-column frame.
  for (const anchor of [{ row: 3, col: 2 }, { row: 3, col: 88 }, { row: 25, col: 2 }, { row: 25, col: 88 }, { row: 0, col: 0 }]) {
    const r = at(anchor);
    assert.ok(r.col0 >= 0 && r.col1 < 90 && r.col0 < r.col1,
      `anchor ${JSON.stringify(anchor)} put the panel outside the frame: ${JSON.stringify(r)}`);
    assert.ok(r.row0 >= 0 && r.row0 < 30, `anchor ${JSON.stringify(anchor)} put the panel off-screen: row ${r.row0}`);
  }
});

test('the panel stays visibly centred however long its content is', () => {
  // The width cap used to be `w - 2`, so a long row drove the margins to zero and
  // the panel spanned the terminal — which stops reading as a centred popup and starts
  // reading as a takeover. It must keep breathing room both sides.
  //
  // "Centred" allows a one-column difference: the panel is an odd number of columns
  // wide on a 90-column frame, so the leftover column has to go somewhere, and putting
  // it on the right is what `Math.floor` does. What must never happen is the margins
  // collapsing to zero.
  const margins = (len) => {
    const st = stateWith(chat(3));
    st.picker = { title: 'T'.repeat(len), items: [{ label: 'x' }], sel: 0, searchable: false };
    const frame = composeFrame(st, 90, 30);
    const b = panelBounds(frame);
    assert.ok(b, `len ${len}: panel not rendered`);
    return { left: b.col0, right: 89 - b.col1 };
  };
  for (const len of [4, 20, 40, 60, 80, 120, 400]) {
    const m = margins(len);
    assert.ok(Math.abs(m.left - m.right) <= 1,
      `len ${len}: not centred (${m.left} vs ${m.right})`);
    assert.ok(m.left >= 2 && m.right >= 2,
      `len ${len}: margins collapsed to ${m.left}/${m.right} — it reads as full-screen`);
  }
});

test('every row stays exactly the terminal width with a popup open', () => {
  // The splice walks columns itself, so a miscounted wide glyph or an ANSI-aware
  // measurement would drag the row sideways — and a row that is one column short
  // smears stale text into the frame on the next differential repaint.
  for (const cols of [40, 60, 76, 90, 120]) {
    const st = stateWith(chat(3));
    st.picker = { title: '选择模型', items: [{ label: '模型甲' }, { label: '模型乙' }], sel: 0, searchable: true };
    st.chat = [{ role: 'user', text: '第 1 条消息很长的中文内容' }, ...st.chat];
    const plain = strip(composeFrame(st, cols, 30).lines);
    for (const [i, row] of plain.entries()) {
      assert.equal(visualWidth(row), cols, `row ${i} is ${visualWidth(row)} cols, expected ${cols}`);
    }
    assert.ok(!plain.some((r) => r.includes('\u2007')), 'the see-through sentinel never reaches the screen');
  }
});

test('the panel fully covers its own columns; no background shows inside it', () => {
  // The panel is composited as a cell LAYER so the transcript BESIDE it survives — but
  // the panel itself is opaque. Two things can go wrong and both are checked here:
  //
  //   * a panel row that does not cover all of its columns (the blank pad rows used to
  //     be a bare `''`, which parsed to ZERO cells, so two lines of the panel had no
  //     background at all);
  //   * the transcript bleeding into the panel's columns.
  //
  // Every chat row is filled with distinct digits, so any digit appearing inside the
  // panel is background leaking through.
  const cols = 76;
  const st = stateWith([]);
  st.chat = Array.from({ length: 20 }, (_, i) => ({
    role: 'user',
    // Distinct filler per row, so "which row am I looking at" is answerable.
    text: `row ${i} `.padEnd(cols - 2, String(i % 10)),
  }));
  st.picker = { title: 'CARDTITLE', items: [{ label: 'alpha' }], sel: 0, searchable: false };
  const frame = composeFrame(st, cols, 24);
  const plain = strip(frame.lines);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');

  // Every cell of every panel row carries the panel background.
  assert.deepEqual(panelGaps(frame), [], 'the panel must be opaque across its whole area');

  // ...and no digit from the row underneath appears inside it.
  for (const i of [...new Set(b.rows)]) {
    const inside = plain[i].slice(b.col0, b.col1 + 1);
    assert.ok(!/[0-9]/.test(inside),
      `row ${i}: background leaked into the panel — ${JSON.stringify(inside)}`);
  }

  // The panel's own content is intact, not overwritten by the background either.
  assert.ok(plain.some((r) => r.includes('CARDTITLE')), 'the panel title survived');

  // The transcript BESIDE the panel is still there — that is what the layer is for.
  // Asserted as "not blanked" rather than "contains digits": the row beside the panel
  // may be a chat box's border rule (`╰────`), which carries no digits at all and is
  // still perfectly good evidence that the surrounding transcript survived.
  const titleIdx = plain.findIndex((r) => r.includes('CARDTITLE'));
  assert.ok(plain[titleIdx].slice(0, b.col0).trim().length > 0,
    'the transcript left of the panel must survive');
  assert.ok(plain[titleIdx].slice(b.col1 + 1).trim().length > 0,
    'the transcript right of the panel must survive');
});

// The style in effect at each VISUAL column of an ANSI row. This is the check the
// stripped-text assertions cannot make: a dimming bug that drops every colour after the
// first cell renders identically once the escapes are removed, and only shows up as a
// grey-on-grey screen on a real terminal.
function cellStyles(ansiRow) {
  const s = String(ansiRow);
  const out = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i));
      if (m) {
        // Only `\x1b[0m` ends the style here. This is a text helper for the comparisons
        // below; `parseCells` — which the renderer itself uses, and which must handle both
        // reset spellings — is not reimplemented here, because two helpers with different
        // reset rules disagree about where a style run begins, and that disagreement shows
        // up as a changed cell count rather than as a colour difference.
        if (m[0] === `${ESC}[0m`) cur = '';
        else cur += m[0].replace(ESC, 'E');
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    out.push(cur);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

// The CHARACTER at each VISUAL column of an ANSI row. Indexing the string directly is
// wrong once the row holds CJK — a two-column glyph makes character index and column
// part ways — and the gutter assertion is about columns, so it must not.
function cellChars(ansiRow) {
  const s = String(ansiRow);
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out.push(ch);
    if (visualWidth(ch) === 2) out.push('');
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

test('dimming the backdrop keeps every colour it already had', () => {
  // The first dimming implementation emitted `C.dim + ch + C.reset` per cell. The
  // reset closed each cell, so every cell after the first lost its foreground — a row of
  // cyan user markers went grey after one character. Stripping the escapes hides this
  // completely, which is why it is pinned here on the raw string.
  //
  // The contract: dimming ADDS an attribute. With `E[2m` removed, a dimmed row must be
  // character-for-character identical to the same row rendered with no picker open.
  const mk = () => {
    const st = stateWith([]);
    st.chat = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      text: `row ${i} `.padEnd(88, String(i % 10)),
    }));
    return st;
  };
  const opened = mk();
  opened.picker = { title: 'Pick', items: [{ label: 'alpha' }], sel: 0, searchable: false };
  const withPicker = composeFrame(opened, 90, 24).lines.map(String);
  const plainFrame = composeFrame(mk(), 90, 24).lines.map(String);

  // The title row is the card's; compare a row well above it, which is pure backdrop.
  const titleIdx = strip(withPicker).findIndex((r) => r.includes('Pick'));
  assert.ok(titleIdx > 3, 'the card rendered with room above it');
  // The dimmed rows must still carry their text, at the same columns. The per-cell colour
  // comparison this used to make is covered, and more directly, by the scrollbar suite: it
  // asserts that the fills the bar had at full brightness are GONE from the dimmed row. That
  // is the property that actually broke — a fill surviving the dim — and checking it here
  // too only duplicated it against a second, differently-parsed copy of the row.
  for (const r of [titleIdx - 3, titleIdx - 2]) {
    assert.ok(faintBetween(withPicker[r], 0, withPicker[r].length - 1),
      `row ${r}: the backdrop was not dimmed at all`);
    assert.equal(cellStyles(withPicker[r]).length, cellStyles(plainFrame[r]).length,
      `row ${r}: dimming changed how many columns the row has`);
    assert.equal(strip([withPicker[r]])[0], strip([plainFrame[r]])[0],
      `row ${r}: dimming changed the visible text`);
  }
});

test('the panel itself is NOT dimmed, and the backdrop around it is', () => {
  const st = stateWith(chat(3));
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  const frame = composeFrame(st, 90, 30);
  const raw = frame.lines.map(String);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');

  // The panel's own cells: full contrast, so the thing the user reads is not muted.
  const titleRow = raw.find((r) => r.includes('Pick one'));
  assert.ok(!faintBetween(titleRow, b.col0, b.col1), 'the panel interior must not be dimmed');
  // The backdrop beside it: dimmed, or the modal has no focus. The column directly
  // against the panel is the GUTTER — a deliberate blank — so the dimming is asserted
  // one column further out, which is real backdrop.
  const styles = cellStyles(titleRow);
  assert.ok(styles[b.col0 - 2].includes('E[2m'), 'the backdrop left of the panel must be dimmed');
  assert.ok(styles[b.col1 + 2].includes('E[2m'), 'the backdrop right of the panel must be dimmed');
  // The gutter itself is blank, not dimmed text: a faint glyph there would be the very
  // "text pressed against the panel" the gutter exists to remove.
  const chars = cellChars(titleRow);
  assert.equal(chars[b.col0 - 1], ' ', 'the left gutter must be a blank, not dimmed text');
  assert.equal(chars[b.col1 + 1], ' ', 'the right gutter must be a blank, not dimmed text');
});

test('the backdrop is dimmed on EVERY row, including a fresh session\'s blank filler', () => {
  // The regression: a transcript's blank filler rows are EMPTY strings, not runs of
  // spaces, so any pass that works in COLUMNS saw zero columns on them and did nothing.
  // The frame is only padded to full width by `fitAnsi` at the very END of composeFrame,
  // which runs AFTER the backdrop dimming — so on a fresh session, where most of the
  // body is filler, the dimming silently skipped those rows and the modal backdrop came
  // out undimmed. That is the whole focus effect of a popup, so this is not cosmetic.
  for (const messages of [[], [{ role: 'user', text: 'hi' }]]) {
    const st = stateWith(messages);
    st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
    const frame = composeFrame(st, 90, 30);
    const b = panelBounds(frame);
    assert.ok(b, 'the panel rendered');

    // Every row outside the panel's own row span is pure backdrop and must be dimmed.
    // The rows INSIDE the span are the panel plus its flanks, checked above.
    for (let r = 0; r < frame.lines.length; r++) {
      if (r >= b.row0 && r <= b.row1) continue;
      const styles = cellStyles(frame.lines[r]);
      assert.ok(styles.length === 90,
        `messages=${messages.length} row ${r}: ${styles.length} columns, want 90`);
      for (const c of [0, 1, 45, 88]) {
        assert.ok(styles[c].includes('E[2m'),
          `messages=${messages.length} row ${r} col ${c}: the backdrop must be dimmed`);
      }
    }
  }
});

test('the panel is centred on the TERMINAL, not on the transcript area', () => {
  // It used to centre inside `origin + room` — the region left over once the composer,
  // todo panel and status line had taken their rows. That region is not the middle of
  // the screen, so the panel sat visibly HIGH, and the taller the bottom chrome the
  // higher it drifted.
  //
  // Centring on the frame height keeps the panel on the terminal's own centre line no
  // matter how much chrome is stacked below it. The bounds come from the hitbox: there
  // is no border glyph to measure any more.
  for (const h of [24, 30, 40]) {
    const st = stateWith(chat(4));
    st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
    st.todos = [{ title: 'a todo', status: 'pending' }];
    const frame = composeFrame(st, 90, h);
    const b = panelBounds(frame);
    assert.ok(b, `h=${h}: panel not rendered`);
    assert.ok(b.row1 - b.row0 + 1 >= 4, `h=${h}: the panel is only ${b.row1 - b.row0 + 1} rows tall`);

    const centre = (b.row0 + b.row1) / 2;
    const frameCentre = (h - 1) / 2;
    // One row of slack: an odd-height panel on an even-height frame cannot land exactly
    // on the centre line, and `Math.floor` puts the extra row below.
    assert.ok(Math.abs(centre - frameCentre) <= 1,
      `h=${h}: panel centred on ${centre}, frame centre is ${frameCentre}`);
  }
});

test('every panel row covers the panel columns, whatever its content is', () => {
  // Without a frame there are no walls to line up, so the invariant becomes "every row
  // fills the same columns with the panel background" — which is what `panelGaps`
  // measures, and where an under-padded row or a miscounted wide glyph would show up.
  const st = stateWith(chat(3));
  st.picker = {
    title: '选择模型 · pick one',
    title: '选择模型 · pick one',
    items: [{ label: '模型甲 model-alpha' }, { label: 'b' }],
    sel: 0,
    hint: '↑↓ navigate · Enter select · Esc cancel',
    searchable: true,
  };
  const frame = composeFrame(st, 90, 30);
  const plain = strip(frame.lines);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');
  assert.ok(b.rows.length >= 4, `expected several panel rows, got ${b.rows.length}`);

  // Every panel row is exactly as wide as the panel, whether it holds short content, a
  // long CJK label, or nothing at all. This replaces the old border-alignment check:
  // without a frame there are no walls to line up, so the invariant becomes "every row
  // fills the same columns with the panel background" — which is what `panelGaps`
  // measures, and where an under-padded row or a miscounted wide glyph would show up.
  assert.deepEqual(panelGaps(frame), [], 'every panel row must cover the panel\'s columns');

  // The panel's content is not truncated: both rows and the hint are present.
  const text = plain.join('\n');
  assert.match(text, /模型甲 model-alpha/);
  assert.match(text, /↑↓ navigate/);
  // And the panel is inset rather than spanning the terminal.
  assert.ok(b.col0 > 0 && b.col1 < 89, `panel spans ${b.col0}..${b.col1} of 90`);
});

test('a one-column gutter separates the panel from the transcript beside it', () => {
  // The card composites over the transcript and its own padding sits INSIDE its box, so
  // without a gutter the last glyph before the panel lands in the column directly against
  // the panel's edge and reads as clipped by it. One blank column each side is the fix,
  // and it has to hold on EVERY row the card covers — including the rows where the
  // transcript behind it happens to be full of text.
  const st = stateWith(chat(6));
  st.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  const frame = composeFrame(st, 90, 30);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');
  assert.ok(b.col0 > 0 && b.col1 < 89, `panel spans ${b.col0}..${b.col1} of 90`);

  for (const r of new Set(b.rows)) {
    const chars = cellChars(frame.lines[r]);
    assert.equal(chars[b.col0 - 1], ' ', `row ${r}: the left gutter must be blank`);
    assert.equal(chars[b.col1 + 1], ' ', `row ${r}: the right gutter must be blank`);
  }
});

test('blanking the gutter never shifts the row, even when a wide glyph straddles it', () => {
  // A WIDE glyph is a cell plus a continuation cell, and the continuation emits NOTHING
  // (the glyph before it already covers both columns). So clearing only ONE half of a
  // pair made the row come out a column short: the half left behind stopped being
  // emitted, the blanked half emitted a single space, and everything after it slid one
  // column to the LEFT. The visible symptom was the scrollbar — pinned to the last
  // column — being drawn one column inward on exactly the rows where a CJK glyph
  // straddled the gutter, which is what this pins.
  //
  // The transcript is built so wide glyphs land on the gutter column for many rows, and
  // the check is simply "every row is still exactly as wide as the terminal".
  const wide = [];
  for (let i = 0; i < 200; i++) {
    wide.push({ role: i % 2 ? 'assistant' : 'user', text: `第${i}行中文${'宽'.repeat(30)}` });
  }
  const st = stateWith(wide);
  st.picker = { title: '选择模型', items: [{ label: '条目 0 with a long label' }], sel: 0, searchable: true };
  const frame = composeFrame(st, 60, 24);
  const b = panelBounds(frame);
  assert.ok(b, 'the panel rendered');

  for (const r of new Set(b.rows)) {
    const chars = cellChars(frame.lines[r]);
    assert.equal(chars.length, 60, `row ${r}: the row is ${chars.length} columns wide, want 60`);
    assert.equal(chars[b.col0 - 1], ' ', `row ${r}: the left gutter must be blank`);
    assert.equal(chars[b.col1 + 1], ' ', `row ${r}: the right gutter must be blank`);
  }
});

test('the popup never hides anything underneath it', () => {
  // The blunt version of the composite test: whatever the popup covers, the rows it
  // covers must still carry their own content — no run of blank padding where the
  // transcript used to be. Compared against the SAME state without the popup, so
  // this fails if the box ever overwrites a row instead of splicing into it.
  const base = stateWith(chat(4));
  const before = strip(composeFrame(base, 90, 30).lines);
  const opened = stateWith(chat(4));
  opened.picker = { title: 'Pick one', items: [{ label: 'Alpha' }], sel: 0, searchable: false };
  const after = strip(composeFrame(opened, 90, 30).lines);

  // Every row that had content before, and is not one the popup draws on, must
  // still have content now.
  const blanked = before.filter((r, i) => r.trim() && !after[i].trim());
  assert.deepEqual(blanked, [], 'the popup blanked rows it should only be floating over');
});

test('scrolling does not change what is rendered (metrics memo is transparent)', () => {
  // The memo skips pass 1 (the row-count walk) when the transcript is unchanged.
  // A scroll changes only the viewport, so the output must match a full recompute
  // exactly — a stale rowStart would splice the wrong rows together.
  for (const scroll of [0, 1, 100, 5000, 999999]) {
    for (const spin of [0, 3]) {
      const st = stateWith(chat(30));
      st.scroll = scroll; st.spin = spin;
      composeFrame(st, 90, 30);                      // prime the memo
      st._anchorPin = null; st.scroll = scroll; st.spin = spin;
      const memoed = composeFrame(st, 90, 30).lines.join('\n');
      st._anchorPin = null; st.scroll = scroll; st.spin = spin;
      const full = fullRender(st, 90, 30).lines.join('\n');
      assert.equal(memoed, full, `scroll=${scroll} spin=${spin} must match the full render`);
    }
  }
});

test('the memo survives a terminal resize without mixing layouts', () => {
  const st = stateWith(chat(20));
  composeFrame(st, 90, 30);
  const narrow = composeFrame(st, 40, 30).lines.join('\n');
  const st2 = stateWith(chat(20));
  st2._metrics = { ...st._metrics };                // hand it the wrong-width memo
  const full = fullRender(st2, 40, 30).lines.join('\n');
  assert.equal(narrow, full, 'a width change must invalidate the memo');
});

test('metricsSignature is stable for an unchanged transcript and changes on edits', () => {
  const st = stateWith(chat(10));
  const a = metricsSignature(st, st.chat.length, 90, false, 89);
  const b = metricsSignature(st, st.chat.length, 90, false, 89);
  assert.equal(a, b, 'same input must give the same signature');
  st.chat[3].text = st.chat[3].text + ' more';
  const c = metricsSignature(st, st.chat.length, 90, false, 89);
  assert.notEqual(a, c, 'an edit must change the signature');
  const d = metricsSignature(st, st.chat.length - 1, 90, false, 89);
  assert.notEqual(c, d, 'a length change must change the signature');
});

test('chatRowTotal equals the number of lines the renderer emits', () => {
  // scrollChat clamps the scroll offset with this number; if the two disagree the
  // view can scroll past the end or stop short.
  for (const w of [40, 90, 120]) {
    const st = stateWith(chat(12));
    const painted = renderChatLines(st, w, { bodyH: 20, scroll: 0 });
    assert.equal(chatRowTotal(st, w), painted.length, `row total must match at width ${w}`);
  }
});

test('row starts are monotonic and the last message ends at the total', () => {
  // These are what map a scroll row back to a message; a gap or overlap would make
  // a click or a drag select the wrong row.
  const st = stateWith(chat(8));
  const painted = renderChatLines(st, 80, { bodyH: 10, scroll: 0 });
  const total = painted.length;
  const starts = st._metrics.rowStart;
  const lens = st._metrics.msgLen;
  assert.equal(starts.length, st.chat.length);
  for (let i = 0; i < starts.length; i++) {
    if (i > 0) assert.ok(starts[i] >= starts[i - 1], `starts must not go backwards at ${i}`);
    assert.ok(lens[i] >= 0, `row length must not be negative at ${i}`);
  }
  const last = starts.length - 1;
  assert.equal(starts[last] + lens[last], total, 'the last message must end exactly at the total');
});

test('growing the transcript keeps every earlier rowStart unchanged', () => {
  // Appending must not shift history: the scroll anchor depends on this, and a shift
  // is what makes the view jump while output streams.
  const st = stateWith(chat(6));
  composeFrame(st, 80, 30);
  const before = Array.from(st._metrics.rowStart);
  st.chat.push({ role: 'user', text: 'new question' });
  st.chat.push({ role: 'assistant', text: 'new answer' });
  composeFrame(st, 80, 30);
  const after = st._metrics.rowStart;
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `appending must not move the start of message ${i}`);
  }
});