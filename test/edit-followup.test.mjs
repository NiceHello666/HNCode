import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spec as read } from '../src/tools/read.js';
import { spec as edit } from '../src/tools/edit.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-edit-followup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.txt');
  fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  return { file, ctx: { workspace: dir, readPool: new Map() } };
}

test('the excerpt returned by a range Edit authorizes a follow-up Edit without Read', async (t) => {
  const { file, ctx } = setup(t);
  await read.execute({ path: file, start_line: 10, end_line: 10 }, ctx);
  const first = await edit.execute({ path: file, start_line: 10, end_line: 10, new_string: 'changed 10' }, ctx);
  assert.match(first, /10\tchanged 10/);
  const second = await edit.execute({ path: file, start_line: 11, end_line: 11, new_string: 'changed 11' }, ctx);
  assert.match(second, /replaced lines 11-11/);
  const unseen = await edit.execute({ path: file, start_line: 20, end_line: 20, new_string: 'wrong' }, ctx);
  assert.match(unseen, /Edit rejected/);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[19], 'line 20');
});

test('a post-edit external change invalidates the excerpt', async (t) => {
  const { file, ctx } = setup(t);
  await read.execute({ path: file, start_line: 10, end_line: 10 }, ctx);
  await edit.execute({ path: file, start_line: 10, end_line: 10, new_string: 'changed 10' }, ctx);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[10] = 'external change';
  fs.writeFileSync(file, lines.join('\n'));
  const result = await edit.execute({ path: file, start_line: 11, end_line: 11, new_string: 'wrong' }, ctx);
  assert.match(result, /Edit rejected/);
});

test('a substring Edit also authorizes the lines it quotes', async (t) => {
  const { file, ctx } = setup(t);
  await read.execute({ path: file, start_line: 10, end_line: 10 }, ctx);
  await edit.execute({ path: file, old_string: 'line 10', new_string: 'changed 10' }, ctx);
  const second = await edit.execute({ path: file, old_string: 'line 11', new_string: 'changed 11' }, ctx);
  assert.match(second, /replaced 1 occurrence/);
});


test('a shorter range replacement quotes the new block and five current lines on each side', async (t) => {
  const { file, ctx } = setup(t);
  await read.execute({ path: file, start_line: 10, end_line: 14 }, ctx);
  const result = await edit.execute({
    path: file, start_line: 10, end_line: 14, new_string: 'new 10\nnew 11',
  }, ctx);
  const rows = result.split('\n').filter((line) => /^\d+\t/.test(line));
  assert.deepEqual(rows, [
    '5\tline 5', '6\tline 6', '7\tline 7', '8\tline 8', '9\tline 9',
    '10\tnew 10', '11\tnew 11',
    '12\tline 15', '13\tline 16', '14\tline 17', '15\tline 18', '16\tline 19',
  ]);
});

test('a substring replacement quotes all new lines, not the old substring span', async (t) => {
  const { file, ctx } = setup(t);
  await read.execute({ path: file, start_line: 10, end_line: 10 }, ctx);
  const result = await edit.execute({
    path: file, old_string: 'line 10', new_string: 'new 10\nnew 11\nnew 12',
  }, ctx);
  const rows = result.split('\n').filter((line) => /^\d+\t/.test(line));
  assert.deepEqual(rows, [
    '5\tline 5', '6\tline 6', '7\tline 7', '8\tline 8', '9\tline 9',
    '10\tnew 10', '11\tnew 11', '12\tnew 12',
    '13\tline 11', '14\tline 12', '15\tline 13', '16\tline 14', '17\tline 15',
  ]);
});
