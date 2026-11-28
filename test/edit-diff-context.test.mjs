// The Edit diff shows the change IN PLACE: five unchanged lines on each side, the same in the
// model's tool result and on screen.
//
// WHY THIS FILE EXISTS
// --------------------
// Two faults, found together.
//
//   1. The diff was the replaced block ALONE — a quote with no surroundings. A four-line block
//      looks identical at many sites in a real file (several small functions, two nearby `}`), so
//      neither the model nor the user could tell which one was edited, or that the edit landed
//      where it was meant to.
//   2. Both renderers had their own THREE-line window. Building the UI rows by splicing the
//      context into the old/new text and handing that to the LCS differ mis-paired the lines —
//      the two sides had different shapes, so five unchanged context rows came out as `-`/`+`
//      pairs, i.e. the diff claimed the surrounding code had been deleted and re-added.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-editdiff-'));
const { spec } = await import('../src/tools/edit.js');
const { formatEditDiffForModel } = await import('../src/agent.js');
const { editDiffRows } = await import('../src/tui.js');

/** Write a numbered file, run one Edit through the real tool, and return the published diff. */
async function editOnce({ count = 14, target = 7, oldString, newString }) {
  const file = path.join(dir, `s${Math.random().toString(36).slice(2)}.js`);
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(i === target ? `const TARGET = ${i};` : `const V${i} = ${i};`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const ctx = { workspace: dir, readPool: new Map() };
  await spec.execute({ path: file }, ctx);   // satisfy read-before-write
  await spec.execute({ path: file, old_string: oldString, new_string: newString }, ctx);
  return ctx.lastEditDiff;
}

test('the tool publishes the lines around the change', async () => {
  const diff = await editOnce({ oldString: 'const TARGET = 7;', newString: 'const TARGET = 70;' });
  assert.ok(diff && diff.context, 'the diff carries context');
  assert.equal(diff.context.before.length, 5, 'five lines above');
  assert.equal(diff.context.after.length, 5, 'five lines below');

  // The right lines, numbered as they are in the file (the change is on line 7).
  assert.deepEqual(diff.context.before.map((c) => c.n), [2, 3, 4, 5, 6]);
  assert.deepEqual(diff.context.after.map((c) => c.n), [8, 9, 10, 11, 12]);
  assert.match(diff.context.before[4].text, /V6/);
  assert.match(diff.context.after[0].text, /V8/);
});

test('the model receives the context, unmarked', async () => {
  const diff = await editOnce({ oldString: 'const TARGET = 7;', newString: 'const TARGET = 70;' });
  const text = formatEditDiffForModel(diff);

  // The changed line is marked; the neighbours are not.
  assert.match(text, /^\s+7 - const TARGET = 7;$/m, 'the old line is marked -');
  assert.match(text, /^\s+7 \+ const TARGET = 70;$/m, 'the new line is marked +');
  assert.match(text, /^\s+6   const V6 = 6;$/m, 'a line above is unmarked');
  assert.match(text, /^\s+8   const V8 = 8;$/m, 'a line below is unmarked');

  // And they come in file order, so the block reads as a patch rather than two lists.
  const at = (needle) => text.indexOf(needle);
  assert.ok(at('const V6 = 6;') < at('const TARGET = 7;'), 'context above the change');
  assert.ok(at('const V8 = 8;') > at('const TARGET = 70;'), 'context below it');
});

test('the UI shows the same lines, not a delete-and-re-add of them', async () => {
  // The LCS bug: context spliced into both sides came out as `-`/`+` pairs, so the diff appeared
  // to remove and re-add unchanged code.
  const diff = await editOnce({ oldString: 'const TARGET = 7;', newString: 'const TARGET = 70;' });
  const rows = editDiffRows(diff);

  const dels = rows.filter((r) => r.type === 'del');
  const adds = rows.filter((r) => r.type === 'add');
  assert.equal(dels.length, 1, `exactly one removed line, got ${JSON.stringify(dels.map((d) => d.text))}`);
  assert.equal(adds.length, 1, 'and exactly one added line');
  assert.equal(dels[0].text, 'const TARGET = 7;');
  assert.equal(adds[0].text, 'const TARGET = 70;');

  // Five context rows each side, numbered from the file.
  const ctxRows = rows.filter((r) => r.type === 'ctx');
  assert.equal(ctxRows.length, 10, `ten context rows, got ${ctxRows.length}`);
  assert.equal(ctxRows[0].no, 2);
  assert.equal(ctxRows[ctxRows.length - 1].no, 12);
});

test('a change near the top of the file does not invent lines above it', async () => {
  const diff = await editOnce({ count: 6, target: 1, oldString: 'const TARGET = 1;', newString: 'const TARGET = 10;' });
  assert.deepEqual(diff.context.before, [], 'there is nothing above line 1');
  assert.equal(diff.context.after.length, 5);
  const rows = editDiffRows(diff);
  assert.ok(rows.every((r) => r.no >= 1), 'no row is numbered below 1');
});

test('a change near the end does not invent lines below it', async () => {
  // The file ends with a newline, so there IS one more line (the empty one after it) — the point
  // is that nothing is invented beyond what the file actually holds.
  const diff = await editOnce({ count: 6, target: 6, oldString: 'const TARGET = 6;', newString: 'const TARGET = 60;' });
  assert.equal(diff.context.before.length, 5);
  const afterNos = diff.context.after.map((c) => c.n);
  assert.ok(afterNos.every((n) => n <= 7), `no row past the file's last line: ${JSON.stringify(afterNos)}`);
  assert.ok(afterNos.length <= 1, `only the trailing empty line follows: ${JSON.stringify(diff.context.after)}`);
});

test('both renderers use the SAME window size', async () => {
  // Drift here is invisible until someone compares the two, so it is asserted directly: the model's tool result and
  // the screen must agree about how much context a change deserves.
  //
  // The UI's window constant lives in src/diff.js — the renderer reads it from there — while the tool's is its own.
  const { lineDiff } = await import('../src/diff.js');
  const src = fs.readFileSync(path.resolve('src/diff.js'), 'utf8');
  const edit = fs.readFileSync(path.resolve('src/tools/edit.js'), 'utf8');
  const tuiWindow = Number(/const DIFF_CONTEXT_LINES = (\d+);/.exec(src)?.[1]);
  const toolWindow = Number(/const DIFF_CONTEXT = (\d+);/.exec(edit)?.[1]);
  assert.equal(tuiWindow, 5, 'the UI keeps five lines each side');
  assert.equal(toolWindow, 5, 'and so does the tool');

  // Unchanged rows in the middle of a long run are elided rather than all shown.
  const rows = lineDiff(
    Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'),
    Array.from({ length: 40 }, (_, i) => (i === 20 ? 'changed' : `l${i}`)).join('\n'),
    1,
  );
  assert.ok(rows.some((r) => r.type === 'gap'), 'a long unchanged run is elided');
  assert.ok(rows.length < 30, `elision keeps it short (${rows.length} rows)`);
});
