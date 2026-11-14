// The agent can FORGET a note, not only add one.
//
// WHY THIS EXISTS: the tool could only append. A rule that stopped being true — a build command that moved, a
// convention the user reversed — stayed in MEMORY.md and kept steering later sessions, which is worse than no rule
// at all. The user asked for the ability to remove, so the behaviour is pinned here.
//
// A NOTE IS ONE LINE starting with `- `, and removal is by MATCHING TEXT: the caller knows what a note SAYS, and
// looking up a line number is a step that can go stale between the read and the write.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { spec } = await import('../src/tools/memory.js');
const { removeMemory, readMemoryRaw } = await import('../src/config.js');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-mem-'));
  return { dir, ctx: { workspace: dir }, file: path.join(dir, '.hncode', 'MEMORY.md') };
}

const run = (args, ctx) => spec.execute(args, ctx);

test('a note can be removed, and the rest survive', async () => {
  const { dir, ctx, file } = workspace();
  try {
    await run({ action: 'add', note: 'Rule A: use npm test' }, ctx);
    await run({ action: 'add', note: 'Rule B: never publish without asking' }, ctx);
    await run({ action: 'add', note: 'Rule C: tui.js is CRLF' }, ctx);

    const out = await run({ action: 'remove', note: 'never publish' }, ctx);
    assert.match(out, /Removed 1/);

    const rest = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(rest, /never publish/, 'the matched note is gone');
    assert.match(rest, /Rule A/, 'the others are untouched');
    assert.match(rest, /Rule C/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removal says so when nothing matched, instead of reporting a deletion', async () => {
  // A note that was never there must not read as one that was deleted: the caller would believe a rule had been
  // dropped while it is still in the file, steering later sessions.
  const { dir, ctx } = workspace();
  try {
    await run({ action: 'add', note: 'Rule A: use npm test' }, ctx);
    const out = await run({ action: 'remove', note: 'no such text anywhere' }, ctx);
    assert.match(out, /No project note matched/);
    assert.match(out, /nothing removed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removal needs text to match on', async () => {
  const { dir, ctx } = workspace();
  try {
    await run({ action: 'add', note: 'Rule A: use npm test' }, ctx);
    const empty = await run({ action: 'remove', note: '' }, ctx);
    assert.match(empty, /Error/);
    assert.match(empty, /required/);
    // And nothing was lost to an empty match.
    assert.match(readMemoryRaw('project', dir), /Rule A/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the match runs per note, so one hit does not take a neighbour with it', async () => {
  // Two notes can share wording. The line goes WHOLE and only the matching line, so a short needle cannot carve a
  // fragment out of a longer note and leave half a sentence behind.
  const { dir, ctx, file } = workspace();
  try {
    await run({ action: 'add', note: 'alpha: keep this one' }, ctx);
    await run({ action: 'add', note: 'beta: drop this one' }, ctx);
    const { removed, kept } = removeMemory('project', dir, 'drop');
    assert.equal(removed, 1);
    assert.equal(kept, 1);
    const rest = fs.readFileSync(file, 'utf8');
    assert.match(rest, /^- alpha: keep this one/m);
    assert.doesNotMatch(rest, /beta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing the only note leaves an empty file, not a dangling header', async () => {
  const { dir, ctx } = workspace();
  try {
    await run({ action: 'add', note: 'the only note' }, ctx);
    await run({ action: 'remove', note: 'the only note' }, ctx);
    assert.equal(readMemoryRaw('project', dir).trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add still works after remove was added — the guard did not swallow it', async () => {
  // The regression this pins: an insert left a `return` above the `action !== 'add'` guard, so every `add` reported
  // "unknown action" while the file had already changed. The tool must round-trip.
  const { dir, ctx } = workspace();
  try {
    const added = await run({ action: 'add', note: 'a fresh note' }, ctx);
    assert.match(added, /Saved to project memory/);
    const listed = await run({ action: 'list' }, ctx);
    assert.match(listed, /a fresh note/);
    const unknown = await run({ action: 'nonsense' }, ctx);
    assert.match(unknown, /unknown action/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
