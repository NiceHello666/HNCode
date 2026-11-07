// The shared row cache: bounded by USE, keyed by CONTENT.
//
// WHY THIS EXISTS
// ---------------
// The TUI cached rendered rows on the message objects, and evicted by POSITION:
// `CACHE_KEEP` counted messages from the tail. So a long session discarded the caches of
// its oldest thousands while keeping the most recent 300 however small they were — the
// bound tracked messages, not memory — and scrolling back re-rendered everything from
// scratch. It also could not survive a session switch, because the message objects it
// lived on are thrown away and rebuilt from the log, so every `--continue` and every
// `/sessions` resume started cold.
//
// Two things have to hold for the replacement to be better, and both are pinned here:
//
//   1. Eviction is by USE. The entries worth keeping are the ones being read, not the ones
//      written most recently — a FIFO would evict the message you are looking at.
//   2. The key covers every layout input. A key that missed one would serve rows drawn
//      for a different width or a different toggle, which is a MIS-DRAWN frame rather than
//      a stale one — a much worse failure, and one no test of "does it hit" would catch.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRowKey, rowCacheGet, rowCacheSet, cacheStats, resetRowCache, evictIfStale,
  ROW_CACHE_LIMIT,
} from '../src/row-cache.js';

const key = (over = {}) => makeRowKey({
  id: 'assistant', text: 'hello', w: 80, fg: 'x', codeFg: 'y',
  expanded: false, raw: false, pending: false, failed: false, spin: 0, ...over,
});

test('a value comes back under the same key, and not under a different one', () => {
  resetRowCache();
  const v = { rows: ['a', 'b'] };
  rowCacheSet(key(), v);
  assert.deepEqual(rowCacheGet(key()), v);
  assert.equal(rowCacheGet(key({ text: 'hello!' })), undefined, 'different text, different key');
  assert.equal(rowCacheGet(key({ w: 81 })), undefined, 'different width, different key');
});

test('every layout input changes the key', () => {
  // The point of the test: each of these produces a row set that differs, so each must
  // produce a different key. A missing one is a wrong frame, not a slow frame.
  resetRowCache();
  const base = key();
  const differs = [
    { id: 'tool' },
    { text: 'different' },
    { w: 40 },
    { fg: 'other' },
    { codeFg: 'other' },
    { expanded: true },
    { raw: true },
    { pending: true },
    { failed: true },
    { spin: 3 },
  ];
  for (const over of differs) {
    assert.notEqual(key(over), base, `${JSON.stringify(over)} must change the key`);
  }
});

test('a streamed message gets a new key every frame, because its text changed', () => {
  // This is why the key compares text BY VALUE. A reference check would miss every reuse
  // after the first frame, and the whole store would be dead weight during streaming.
  resetRowCache();
  const first = key({ text: 'I read' });
  const second = key({ text: 'I read the' });
  assert.notEqual(first, second);
});

test('text containing the separator cannot collide with another message', () => {
  // THE TEXT NO LONGER REACHES THE KEY, so the separator cannot be forged from it.
  //
  // It used to be embedded verbatim, and a message containing the separator could collide with a different
  // message's key. The text is hashed now, so what goes in the key is a number: no content a user or a model
  // can write is able to add a separator.
  const a = key({ id: 'assistant', text: 'x' });
  const b = key({ id: 'assistant', text: 'x\x1fy\x1f80' });
  assert.notEqual(a, b, 'different texts must not share a key');

  // The key has a fixed, small shape: nothing in it can grow with the message.
  const short = key({ text: 'hi' });
  const long = key({ text: 'x'.repeat(100000) });
  assert.ok(Math.abs(long.length - short.length) < 12,
    `key length must not track the message (short ${short.length}, long ${long.length})`);
  assert.ok(long.length < 80, `a key is small (${long.length} chars)`);

  // The text LENGTH is part of it, so two texts of different sizes never collide even before hashing.
  assert.notEqual(key({ text: 'abc' }), key({ text: 'abd' }));
  assert.equal(key({ text: 'abc' }), key({ text: 'abc' }), 'the same text is the same key');
});

test('the palette is part of the row key', () => {
  // Cached rows are finished strings with their escapes already applied, so two palettes
  // must never share an entry. Without this a theme switch left the transcript text in
  // the previous colours while the chrome repainted.
  resetRowCache();
  const dark = key({ id: 'assistant', text: 'x', theme: 'dark' });
  const gruvbox = key({ id: 'assistant', text: 'x', theme: 'gruvbox' });
  assert.notEqual(dark, gruvbox);

  // A miss is what the next render has to see, not a stale hit.
  rowCacheSet(dark, { rows: ['dark rows'], theme: 'dark' });
assert.ok(rowCacheGet(gruvbox) == null, 'the old palette must not be served to the new one');
  assert.deepEqual(rowCacheGet(dark).rows, ['dark rows'], 'and the same palette still hits');
});

test('the store is bounded', () => {
  resetRowCache();
  for (let i = 0; i < ROW_CACHE_LIMIT + 50; i++) rowCacheSet(key({ id: `m${i}` }), { n: i });
  const s = cacheStats();
  assert.equal(s.size, ROW_CACHE_LIMIT, 'the bound is real');
  assert.ok(s.evictions >= 50, 'and entries really were evicted');
});

test('eviction is by USE, not by age', () => {
  // The load-bearing property. A FIFO (or an insertion-ordered Map with no touch) would
  // evict the entry that was most recently WRITTEN — which, on a transcript, is the
  // message the user is looking at right now.
  resetRowCache();
  const old = key({ id: 'old' });
  rowCacheSet(old, 'old-value');
  // Write enough newer entries to push `old` past the limit.
  for (let i = 0; i < ROW_CACHE_LIMIT; i++) rowCacheSet(key({ id: `n${i}` }), i);
  assert.equal(rowCacheGet(old), undefined, 'precondition: `old` was evicted for being stale');

  // Now: `hot` written first, then a burst, then `hot` read — a read must save it.
  resetRowCache();
  const hot = key({ id: 'hot' });
  rowCacheSet(hot, 'hot-value');
  const filler = [];
  for (let i = 0; i < ROW_CACHE_LIMIT - 1; i++) filler.push(key({ id: `f${i}` }));
  for (const k of filler) rowCacheSet(k, 1);
  // One slot left; `hot` is the oldest. Reading it makes it the newest.
  assert.equal(rowCacheGet(hot), 'hot-value');
  rowCacheSet(key({ id: 'one-more' }), 2);   // evicts the oldest = one of the fillers
  assert.equal(rowCacheGet(hot), 'hot-value', 'a read protected the entry from eviction');
});

test('re-setting a key replaces the value and does not grow the store', () => {
  // `Map.set` on an existing key does not move it, so without the delete-then-set the
  // bound would be short by however many keys were rewritten.
  resetRowCache();
  const k = key();
  rowCacheSet(k, 1);
  for (let i = 0; i < 20; i++) rowCacheSet(k, i + 2);
  assert.equal(cacheStats().size, 1, 'one key is one entry');
  assert.equal(rowCacheGet(k), 21);
});

test('the stats distinguish "the cache is not helping" from "there is nothing to cache"', () => {
  resetRowCache();
  rowCacheGet(key({ id: 'nothing' }));
  assert.equal(cacheStats().misses, 1);
  rowCacheSet(key({ id: 'something' }), 1);
  rowCacheGet(key({ id: 'something' }));
  const s = cacheStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

test('a stale entry is recognised by its own key', () => {
  // The row COUNT memo is keyed differently from the row set, and both have to notice
  // that their content moved. Named as a function so the check is visible at the call
  // site rather than being an open-coded comparison someone later widens.
  const entry = { key: key({ text: 'first' }), len: 3 };
  assert.equal(evictIfStale(entry, key({ text: 'first' })), false, 'unchanged: keep it');
  assert.equal(evictIfStale(entry, key({ text: 'first and more' })), true, 'changed: stale');
  assert.equal(evictIfStale(null, key()), true, 'nothing cached is always stale');
});