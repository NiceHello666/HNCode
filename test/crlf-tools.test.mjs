// CRLF handling in the file tools.
//
// WHY THESE ASSERTIONS
// --------------------
// Almost every file in this repo is CRLF, and a `\r` is a REAL CHARACTER to a regex — so a
// tool that splits on '\n' alone treats the line as ending "\r" and every end-anchored
// pattern silently stops matching. That is not cosmetic: it is a search reporting "No
// matches found" for a line the user can see on screen.
//
// Measured before the fix, on grep's JS path (taken on any machine without ripgrep, which
// is most of them):
//
//     pattern "beta"         -> matched        (a plain substring is unaffected)
//     pattern "beta = 2;$"   -> NO MATCH       (the line really ends "\r")
//     pattern "^const beta"  -> matched        (the start is fine)
//     every returned row     -> carried a stray "\r"
//
// A second, larger bug was found while writing this file: `truncateBuf` — which caps a tool
// RESULT at 128 KB — was applied to the HAYSTACK. On this repo it cut src/tui.js (878 KB)
// to its first 15%, so anything later in the file reported "No matches found". Both are
// covered below.
//
// The Edit tool's line-range mode is tested here too, because the same `\r` could make it
// count or splice lines wrongly — a tool that damages a CRLF file would be far worse than
// one that merely finds nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const grep = (await import('../src/tools/grep.js')).spec;
const edit = (await import('../src/tools/edit.js')).spec;
const read = (await import('../src/tools/read.js')).spec;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-crlf-'));
const ctx = (dir, sessionId) => ({ cwd: dir, workspace: dir, sessionId });

/** A directory holding the SAME content in both line endings. */
function twinDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const body = ['const alpha = 1;', 'const beta = 2;', 'const gamma = 3;', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'lf.js'), body, 'utf8');
  fs.writeFileSync(path.join(dir, 'crlf.js'), body.replace(/\n/g, '\r\n'), 'utf8');
  return dir;
}

/** Rows mentioning one file, from a grep result. */
const rowsFor = (out, file) => String(out).split('\n').filter((l) => l.includes(file));

// ---------------------------------------------------------------------------
// grep: end-anchored patterns
// ---------------------------------------------------------------------------

test('a $ anchor matches in a CRLF file, not only an LF one', async () => {
  const dir = twinDir('anchor');
  const out = await grep.execute({ pattern: 'beta = 2;$', path: '.', '-n': true }, ctx(dir));
  assert.ok(rowsFor(out, 'crlf.js').length, `no match in the CRLF file: ${JSON.stringify(out)}`);
  assert.ok(rowsFor(out, 'lf.js').length, 'and the LF file still matches');
});

test('a fully anchored pattern matches in both files', async () => {
  const dir = twinDir('both-anchor');
  const out = await grep.execute({ pattern: '^const gamma = 3;$', path: '.', '-n': true }, ctx(dir));
  assert.ok(rowsFor(out, 'crlf.js').length, 'crlf matches ^…$');
  assert.ok(rowsFor(out, 'lf.js').length, 'lf matches ^…$');
});

test('the two files give the same number of matching lines', async () => {
  // The property that makes the fix meaningful: line endings must not change RESULTS.
  const dir = twinDir('parity');
  for (const pat of ['alpha', 'beta', 'gamma', '= 2', ';$', 'const']) {
    const out = await grep.execute({ pattern: pat, path: '.', output_mode: 'count_matches' }, ctx(dir));
    const counts = Object.fromEntries(String(out).split('\n').filter(Boolean)
      .map((l) => [path.basename(l.slice(0, l.lastIndexOf(':'))), l.slice(l.lastIndexOf(':') + 1)]));
    assert.equal(counts['crlf.js'], counts['lf.js'], `pattern ${pat}: ${JSON.stringify(counts)}`);
  }
});

test('a returned match line carries no stray carriage return', async () => {
  const dir = twinDir('clean-rows');
  const out = await grep.execute({ pattern: 'beta', path: '.', '-n': true }, ctx(dir));
  assert.ok(!out.includes('\r'), `a carriage return survived into the output: ${JSON.stringify(out)}`);
  for (const line of out.split('\n')) assert.ok(!line.endsWith('\r'), 'no row ends with a carriage return');
});

test('line numbers are the same in both files', async () => {
  const dir = twinDir('lineno');
  const out = await grep.execute({ pattern: 'gamma', path: '.', '-n': true }, ctx(dir));
  assert.match(rowsFor(out, 'crlf.js')[0], /:3:/, 'line 3 in the CRLF file');
  assert.match(rowsFor(out, 'lf.js')[0], /:3:/, 'line 3 in the LF file');
});

test('multiline mode also sees CRLF as line breaks', async () => {
  // `s` lets `.` cross newlines, so a '\r' left in place appears as a literal character
  // mid-match and changes what the pattern can span.
  const dir = twinDir('multiline');
  const out = await grep.execute({ pattern: 'alpha[\\s\\S]*gamma', path: '.', multiline: true }, ctx(dir));
  assert.ok(rowsFor(out, 'crlf.js').length, `multiline missed the CRLF file: ${JSON.stringify(out)}`);
  assert.ok(rowsFor(out, 'lf.js').length, 'and matched the LF file');
});

test('context lines around a match are clean in a CRLF file', async () => {
  const dir = twinDir('context');
  const out = await grep.execute({ pattern: 'beta', path: '.', '-C': 1 }, ctx(dir));
  assert.ok(!out.includes('\r'), 'context rows have no carriage return either');
  assert.ok(rowsFor(out, 'crlf.js').length >= 3, 'the match plus both neighbours came back');
});

test('a lone CR is also treated as a line break', async () => {
  // Old-Mac endings. Rare, but file-lines.js claims to count "any of \r\n, \r, \n", so the
  // search path should agree with the counting path.
  const dir = path.join(tmp, 'lone-cr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cr.txt'), 'one\rtwo\rthree\r', 'utf8');
  const out = await grep.execute({ pattern: 'two$', path: '.', '-n': true }, ctx(dir));
  assert.ok(rowsFor(out, 'cr.txt').length, `a lone-CR file did not match: ${JSON.stringify(out)}`);
});

// ---------------------------------------------------------------------------
// grep: the whole file must be searched, not the first 128 KB
// ---------------------------------------------------------------------------

test('a match past the 128 KB output cap is still found', async () => {
  // `truncateBuf` caps a tool RESULT at 128 KB, which is right for what goes back to the
  // model and wrong as the haystack. Real ripgrep searches everything and caps only its
  // OUTPUT, which is what the JS path does now.
  const dir = path.join(tmp, 'bigfile');
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'const pad = 1;\n'.repeat(20000);          // ~280 KB, past the cap
  fs.writeFileSync(path.join(dir, 'big.js'), `${filler}const NEEDLE_DEEP = 1;\n`, 'utf8');
  assert.ok(fs.statSync(path.join(dir, 'big.js')).size > 128 * 1024, 'the fixture really is past the cap');

  const out = await grep.execute({ pattern: 'NEEDLE_DEEP', path: '.', '-n': true }, ctx(dir));
  assert.ok(rowsFor(out, 'big.js').length,
    `a match near the END of a >128 KB file was missed: ${JSON.stringify(out)}`);
});

test('a match in the middle of a large file is found too', async () => {
  const dir = path.join(tmp, 'midfile');
  fs.mkdirSync(dir, { recursive: true });
  const pad = 'const pad = 1;\n'.repeat(12000);             // ~170 KB
  fs.writeFileSync(path.join(dir, 'mid.js'), `${pad}const MIDDLE_NEEDLE = 1;\n${pad}`, 'utf8');
  const out = await grep.execute({ pattern: 'MIDDLE_NEEDLE', path: '.', '-n': true }, ctx(dir));
  assert.ok(rowsFor(out, 'mid.js').length, `a mid-file match was missed: ${JSON.stringify(out)}`);
});

test('the line number of a deep match is the real one', async () => {
  // Finding the match but reporting a wrong line would be nearly as bad as missing it.
  const dir = path.join(tmp, 'deep-lineno');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 20000 }, (_, i) => `const pad${i} = ${i};`);
  lines[15000] = 'const DEEP = 1;';
  fs.writeFileSync(path.join(dir, 'd.js'), lines.join('\n') + '\n', 'utf8');
  const out = await grep.execute({ pattern: 'const DEEP = 1;', path: '.', '-n': true }, ctx(dir));
  assert.match(out, /:15001:/, `expected line 15001, got: ${JSON.stringify(out.slice(0, 120))}`);
});

test('the RESULT is still bounded, even though the search is not', async () => {
  // Removing the input cap must not remove the output cap: the limit exists for the
  // model's context, and returning every matching line would blow it.
  const dir = path.join(tmp, 'bound');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'many.js'), 'const x = 1;\n'.repeat(5000), 'utf8');
  const limited = await grep.execute({ pattern: 'const x', path: '.', head_limit: 10 }, ctx(dir));
  assert.equal(limited.split('\n').length, 10, 'head_limit bounds the rows');
  // And count_matches reports the true total rather than a truncated one.
  const counts = await grep.execute({ pattern: 'const x', path: '.', output_mode: 'count_matches' }, ctx(dir));
  assert.match(counts, /many\.js:5000/, `the count is the real one: ${JSON.stringify(counts)}`);
});

// ---------------------------------------------------------------------------
// edit: the line-range mode must not damage a CRLF file
// ---------------------------------------------------------------------------

test('line-range edit replaces exactly the range and keeps CRLF', async () => {
  const dir = path.join(tmp, 'edit-range');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.js');
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\r\n') + '\r\n', 'utf8');

  const res = await edit.execute({ path: 'x.js', start_line: 3, end_line: 4, new_string: 'REPLACED' }, ctx(dir, 'crlf-range'));
  assert.match(String(res), /replaced lines 3-4/, `unexpected result: ${res}`);

  const after = fs.readFileSync(file, 'utf8');
  assert.equal((after.match(/line5/g) || []).length, 1, 'line 5 was not duplicated');
  assert.ok(!/line3|line4/.test(after), 'the replaced lines are gone');
  assert.ok(after.includes('\r\n'), 'CRLF was preserved');
  assert.ok(!/[^\r]\n/.test(after), 'no lone LF was introduced');
  assert.equal(after.split('\r\n').filter(Boolean).length, 9, '10 - 2 + 1 = 9 lines');
});

test('an edit replacing a range with several lines keeps CRLF on every new line', async () => {
  const dir = path.join(tmp, 'edit-multi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.js');
  fs.writeFileSync(file, 'a\r\nb\r\nc\r\n', 'utf8');
  await edit.execute({ path: 'x.js', start_line: 2, end_line: 2, new_string: 'B1\nB2\nB3' }, ctx(dir, 'crlf-multi'));
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, 'a\r\nB1\r\nB2\r\nB3\r\nc\r\n', `got ${JSON.stringify(after)}`);
});

test('a string-replace edit works on a CRLF file', async () => {
  // Read normalises CRLF to LF, so a model builds its old_string with LF while the bytes on
  // disk are CRLF — the tool has to match across that difference.
  const dir = path.join(tmp, 'edit-string');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.js');
  fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n', 'utf8');
  const res = await edit.execute({ path: 'x.js', old_string: 'two\n', new_string: 'TWO\n' }, ctx(dir, 'crlf-string'));
  assert.ok(!/Error|reject/i.test(String(res)), `edit failed: ${res}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\nTWO\r\nthree\r\n');
});

// ---------------------------------------------------------------------------
// read: already normalises, which is what the tools above rely on
// ---------------------------------------------------------------------------

test('read normalises CRLF, and line numbers match the raw file', async () => {
  const dir = twinDir('read');
  const out = String(await read.execute({ path: 'crlf.js', start_line: 1, end_line: 3 }, ctx(dir)));
  assert.ok(!out.includes('\r'), 'the read output has no carriage returns');
  // The format is `N\tcontent` with a REAL tab — that is what the model is shown.
  assert.match(out, /1\tconst alpha = 1;/);
  assert.match(out, /2\tconst beta = 2;/);
  assert.match(out, /3\tconst gamma = 3;/);
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
});
