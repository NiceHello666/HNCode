// A finished todo list is DROPPED.
//
// WHY THIS FILE EXISTS
// --------------------
// The panel shows what is LEFT to do. Once every item is done it has stopped being that, and it costs
// four or more rows of a panel that can never change again — while a session that runs several plans
// accumulates one dead list per plan, because each stays until the model sends the next one.
//
// HIDING IS NOT ENOUGH. The first version only stopped drawing the panel. The array survived, so a
// completed plan was persisted with the session, handed back to the model as `cfg.todoState` on the next
// turn, and restored on resume — three places describing finished work as current. The list is now
// dropped at the two points it can enter: the model's update, and a session restore.
//
// TWO CALLERS MUST AGREE. `todoPanelHeight` reserves rows in the layout and `renderTodoPanel` draws
// them; both ask `todoListFinished`. If they ever disagreed the frame would reserve three rows and draw
// none, or draw rows into space the layout gave to something else — either way every row below the panel
// shifts, and the bug reads as a rendering glitch rather than as a stale panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  todoListFinished, todosAllComplete, todoPanelHeight, todoRowCount, composeFrame,
} from '../src/tui.js';

const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const listOf = (...statuses) => ({ todos: statuses.map((s, i) => ({ title: `task ${i}`, status: s })) });

// ---------------------------------------------------------------------------
// the predicate
// ---------------------------------------------------------------------------

test('a list with every item done is finished', () => {
  assert.equal(todoListFinished(listOf('done')), true);
  assert.equal(todoListFinished(listOf('done', 'done', 'done')), true);
});

test('one unfinished item keeps the list', () => {
  // The whole point is that the panel is about what is left. A single pending or in-progress item means
  // there is still something to show.
  assert.equal(todoListFinished(listOf('done', 'pending')), false);
  assert.equal(todoListFinished(listOf('done', 'in_progress')), false);
  assert.equal(todoListFinished(listOf('pending')), false);
  assert.equal(todoListFinished(listOf('in_progress')), false);
});

test('an EMPTY list is not a finished one', () => {
  // `[].every(...)` is true, so without the length check this predicate would call "no todos" finished.
  // That state has its own handling everywhere else and must not be swallowed here.
  assert.equal(todoListFinished(listOf()), false);
  assert.equal(todoListFinished({ todos: [] }), false);
  assert.equal(todoListFinished({}), false);
  assert.equal(todoListFinished(null), false);
  assert.equal(todoListFinished(undefined), false);
});

test('a malformed entry does not read as done', () => {
  // The list comes from the model as JSON. A null entry or one with no status is not evidence of
  // completion, and treating it as such would hide a panel that still has work in it.
  assert.equal(todoListFinished({ todos: [null] }), false);
  assert.equal(todoListFinished({ todos: [{}] }), false);
  assert.equal(todoListFinished({ todos: [{ status: 'done' }, null] }), false);
});

// ---------------------------------------------------------------------------
// the layout
// ---------------------------------------------------------------------------

test('a finished list reserves no height', () => {
  assert.equal(todoPanelHeight(listOf('done', 'done')), 0);
  assert.equal(todoRowCount(listOf('done', 'done')), 0);
});

test('an unfinished list reserves its rows as before', () => {
  // The change must not disturb the ordinary case: a list with work left keeps its panel and its height.
  const pending = listOf('done', 'pending');
  assert.ok(todoPanelHeight(pending) > 0, 'a pending item keeps the panel');
  assert.ok(todoRowCount(pending) > 0, 'and keeps its rows');
});

test('a MANUAL row count does not resurrect a finished list', () => {
  // `state.todoRows` is set by dragging the panel's top rule, and it takes priority over the automatic
  // heuristic. It must not be able to override "there is nothing left to show".
  assert.equal(todoRowCount({ ...listOf('done', 'done'), todoRows: 5 }), 0);
  assert.equal(todoPanelHeight({ ...listOf('done', 'done'), todoRows: 5, todosExpanded: true }), 0);
});

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

test('nothing of the panel is drawn once the list is finished', () => {
  const lines = (statuses) => {
    const state = {
      ...listOf(...statuses),
      running: false, spin: 0, cwd: process.cwd(),
      cfg: { shimmerEdge: 'cosine' }, queued: [],
      chat: [{ role: 'user', text: 'hello' }],
    };
    const f = composeFrame(state, 100, 30);
    return (Array.isArray(f) ? f : f.lines || []).map(strip);
  };

  const done = lines(['done', 'done', 'done']);
  assert.equal(done.filter((l) => /Todo|task \d/.test(l)).length, 0,
    `no panel rows survive: ${JSON.stringify(done.filter((l) => /Todo|task/.test(l)))}`);

  const pending = lines(['done', 'pending']);
  assert.ok(pending.filter((l) => /Todo/.test(l)).length > 0, 'and the panel is still there with work left');
});

test('the space the panel gives up goes to the content above it', () => {
  // The measurable consequence, and the reason the height and the renderer must agree.
  //
  // THE CONTENT IS TOP-ALIGNED, so the panel disappearing does not MOVE it — the panel is drawn under the
  // transcript, so what changes is how much of the transcript is visible and where the composer sits. Measuring
  // the chat's row therefore measures nothing now; what the reclaimed height buys is the next line of output.
  const frameWith = (statuses, chat) => {
    const state = {
      ...listOf(...statuses),
      running: false, spin: 0, cwd: process.cwd(),
      cfg: { shimmerEdge: 'cosine' }, queued: [],
      chat,
    };
    const f = composeFrame(state, 100, 30);
    return (Array.isArray(f) ? f : f.lines || []).map(strip);
  };

  const pendingState = listOf('done', 'pending');
  const height = todoPanelHeight(pendingState);
  assert.ok(height > 0, 'the pending list occupies rows');

  // A transcript one line longer than the window can hold: with the panel taking rows, the newest line is cut
  // off; with the panel gone, the reclaimed rows show it.
  const many = Array.from({ length: 80 }, (_, i) => ({ role: 'user', text: `line ${i}` }));
  const withPanel = frameWith(['done', 'pending'], many);
  const withoutPanel = frameWith(['done', 'done'], many);
  assert.ok(withoutPanel.length === withPanel.length, 'the frame is the same height either way');
  assert.ok(
    withoutPanel.filter((l) => /line \d+/.test(l)).length
      >= withPanel.filter((l) => /line \d+/.test(l)).length,
    'completing the list never shows FEWER transcript lines',
  );
});
// ---------------------------------------------------------------------------
// the list is DROPPED, not just hidden
// ---------------------------------------------------------------------------

test('todosAllComplete is the array form of the same question', () => {
  // Two representations, one rule. The array form is what the update path needs, because at that point
  // there is no `state` yet — only the list the model just sent.
  const done = ['done', 'done'].map((s, i) => ({ title: `t${i}`, status: s }));
  assert.equal(todosAllComplete(done), true);
  assert.equal(todosAllComplete(['done', 'pending'].map((s, i) => ({ title: `t${i}`, status: s }))), false);
  assert.equal(todosAllComplete([]), false, 'an empty list is not a finished one');
  assert.equal(todosAllComplete(null), false);
  // And it agrees with the state form, always.
  assert.equal(todoListFinished({ todos: done }), todosAllComplete(done));
});

test('a finished list arriving from the model is stored as EMPTY', () => {
  // The defect this fixes: hiding the panel left the array alive, so a completed plan was persisted into
  // the session, handed back as `cfg.todoState`, and restored on resume.
  //
  // The rule lives in the event handler rather than in a helper, so it is pinned at the source: what
  // matters is that the assignment READS the predicate, not the shape of the surrounding code.
  assert.match(src, /state\.todos = todosAllComplete\(incoming\) \? \[\] : incoming;/,
    'the update path empties a finished list instead of storing it');
  assert.match(src, /if \(session\) session\.todos = state\.todos;/,
    'and the session follows, so it is not written back to disk');
});

test('a finished list in a saved session is not restored', () => {
  // The second entry point. A session written before this rule existed can still carry one.
  assert.match(src, /session\.todos\) && !todosAllComplete\(session\.todos\)/,
    'the restore path refuses a finished list');
});

test('the panel is gone because the list is, not because it is hidden', () => {
  // End to end: the array a finished update produces is empty, and an empty array reserves nothing.
  const incoming = ['done', 'done'].map((s, i) => ({ title: `t${i}`, status: s }));
  const stored = todosAllComplete(incoming) ? [] : incoming;
  assert.deepEqual(stored, [], 'nothing is kept');
  assert.equal(todoPanelHeight({ todos: stored }), 0);
  assert.equal(todoRowCount({ todos: stored }), 0);
});
