// Diagnostic logs stay under their ceiling, whichever path writes them.
//
// WHAT THIS GUARDS
// ----------------
// Every log in this program appended forever and nothing rotated it: `paint.log` reached
// 174 MB on the development machine, `keys.log` 7 MB. A machine with a small disk does not
// get to ignore that, and the log nobody can open is worse than no log.
//
// The properties that matter, each tested through the real writer:
//   * the live file never exceeds the ceiling;
//   * exactly one rotated generation is kept;
//   * a record larger than the whole ceiling survives whole in the rotated file;
//   * the live file always exists, so a reader never mistakes "rotated" for "broken";
//   * an unwritable target returns false instead of throwing into the caller.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendLog, rotateIfLarge, forgetLogSize, DEFAULT_MAX_BYTES } from '../src/log-file.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-log-'));
const file = (name) => path.join(dir, name);

test('the ceiling is 5 MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
});

test('the live file never passes the ceiling, and one generation is kept', () => {
  const f = file('paint.log');
  for (let i = 0; i < 60; i++) appendLog(f, 'x'.repeat(100) + '\n', { maxBytes: 1000 });
  assert.ok(fs.statSync(f).size <= 1000, 'live file is under the ceiling');
  assert.ok(fs.existsSync(`${f}.1`), 'one rotated generation exists');
  assert.ok(fs.statSync(`${f}.1`).size <= 1000, 'the rotated file is under the ceiling too');
});

test('a record bigger than the ceiling survives whole in the rotated file', () => {
  // A stack trace is the reason to keep a log. Truncating it to fit the ceiling would
  // destroy exactly the evidence that made the file worth writing.
  const f = file('big.log');
  const trace = 'y'.repeat(5000);
  appendLog(f, trace, { maxBytes: 1000 });
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8'), trace, 'the whole record is in the rotation');
  assert.equal(fs.readFileSync(f, 'utf8'), '', 'the live file is present and empty, not missing');
});

test('the live file always exists after a write', () => {
  const f = file('present.log');
  for (let i = 0; i < 25; i++) {
    appendLog(f, 'a'.repeat(120), { maxBytes: 500 });
    assert.ok(fs.existsSync(f), `still present after write ${i}`);
  }
});

test('an unwritable target returns false rather than throwing', () => {
  // A FILE sitting where the log's parent directory should be: `mkdir` fails, and the
  // caller must get false instead of an exception on whatever path was logging.
  const blocker = file('blocker');
  fs.writeFileSync(blocker, '', 'utf8');
  assert.equal(appendLog(path.join(blocker, 'x.log'), 'payload\n'), false);
  assert.equal(fs.readFileSync(blocker, 'utf8'), '', 'the blocker was not overwritten');
});

test('rotateIfLarge rotates an oversized file that this process did not write', () => {
  // A log grown by an older version is already past the ceiling on first use.
  const f = file('legacy.log');
  fs.writeFileSync(f, 'z'.repeat(2048), 'utf8');
  forgetLogSize(f);
  assert.equal(rotateIfLarge(f, 1024), true);
  assert.equal(fs.statSync(`${f}.1`).size, 2048);
  assert.equal(fs.existsSync(f), false, 'nothing has appended yet, so the live file is gone');
});
