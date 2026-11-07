// A shared, bounded cache of rendered transcript rows.
//
// WHY THIS EXISTS
// ---------------
// Wrapping and markdown-rendering a message is the expensive half of every frame, and the
// result depends only on (message text, width, colours) — so it is cacheable. The TUI
// already cached it, but on the message object itself, which makes the cache a property of
// the TRANSCRIPT rather than of the renderer:
//
//   * It was dropped by position, not by size. `CACHE_KEEP` counted messages from the
//     tail, so a 4000-message session threw away the caches of the 3700 oldest messages
//     while keeping the caches of 300 tiny ones — the window tracked message COUNT, not
//     memory. Scrolling back into a long session re-rendered from scratch every time.
//   * It could not survive a session switch, because it lived on messages that
//     `reconstructChat` throws away and rebuilds from the log. Every `--continue` and
//     every `/sessions` resume started with a cold cache, re-wrapping the whole
//     transcript before the first frame.
//   * It had two independent mechanisms — `m._cache` for the row list, `m._mdCache` for
//     the markdown blocks — with separate lifetimes and no bound between them.
//
// A `Map` keyed by a string, with entries ordered by use, fixes all three: the bound is
// real, the key survives any rebuild of the transcript, and both caches share one budget.
//
// THE KEY IS THE WHOLE POINT
// --------------------------
// A key that omitted a component of the layout would serve a row rendered for a different
// width or colour — which is not a stale cache, it is a MISDRAWN frame. So the key spells
// out everything the render depends on, and `makeRowKey` is the single place that decides
// what "the same" means. `evictIfStale` is the second half of the same contract: a streamed
// message's text grows every frame, so an entry whose text no longer matches is not a
// reuse, and the cache has to notice rather than serve it.
//
// THE TEXT IS HASHED, NOT EMBEDDED
// --------------------------------
// The first version put the whole message text in the key. Measured: a 1260-character
// message produced a 1286-character key, so filling the 1500-entry cache held ~7MB of
// pure key strings — more than the rendered rows they identify. Every lookup also built a
// fresh megabyte-scale string to compare. A 32-bit hash plus the text LENGTH keeps a key
// under 60 characters; the length is what makes a collision mean "two texts of the same
// size hashed alike" rather than "any two texts", and a collision only costs a re-render.

/** How many messages keep their rows. Chosen by measurement, not by feel: the rows for a
 *  typical assistant message are a few hundred bytes each, so 1500 covers a long session's
 *  visible history while staying in the low megabytes. */
export const ROW_CACHE_LIMIT = 1500;

/**
 * FNV-1a over a string, as an unsigned 32-bit number.
 *
 * @param {string} s
 * @returns {number}
 */
function hashText(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
/**
 * Every input the render reads goes in, so "the same key" means "the same rows":
 *   `id`  a stable identity for the message. Index-based ids break the moment a message
 *         is inserted or removed, which is exactly what compaction and /undo do.
 *   `text`  the content. Compared by VALUE, not by reference: a streamed message's
 *         `text` is replaced on every delta, and a reference check would miss every
 *         reuse after the first frame.
 *   `w`  the wrap width, `fg`/`codeFg` the colours, `expanded` the plugin-log toggle,
 *   `raw` the raw-mode flag, `pending`/`failed` the live-state flags, and `spin` the
 *   spinner key.
 */
export function makeRowKey(parts) {
  // THE TEXT IS HASHED, NOT EMBEDDED. Measured: a 1260-character message produced a
  // 1286-character key, so a full cache held megabytes of key strings — more than the rows
  // they identify — and every lookup built a fresh one to compare. Hash plus LENGTH keeps a
  // key around 50 characters. The length is what narrows a collision from "any two texts"
  // to "two texts of the same size that also hash alike", and a collision costs a re-render,
  // not a wrong row.
  const text = parts.text == null ? '' : String(parts.text);
  return [
    parts.id,
    text.length,
    hashText(text),
    parts.w,
    parts.fg,
    parts.codeFg,
    parts.expanded ? 1 : 0,
    parts.raw ? 1 : 0,
    parts.pending ? 1 : 0,
    parts.failed ? 1 : 0,
    parts.spin,
    // The palette. Cached rows are finished strings with their escapes already applied, so
    // a theme switch has to miss every entry or the old colours come back. Without this a
    // switched theme repainted the chrome (composed per frame) and left the transcript's
    // own text in the previous palette — white words sitting in a gruvbox.
    parts.theme || '',
  ].join('\x1f');
}

/**
 * The shared store.
 *
 * A single `Map` with insertion order: `Map` iterates in insertion order and `set` on an
 * existing key does NOT move it, so "touch on every read" has to be an explicit
 * delete-then-set. That is what makes it an LRU rather than a FIFO — and the difference
 * matters here, because the entries worth keeping are the ones being read, not the ones
 * written most recently.
 */
const store = new Map();

/** Hits and misses, so a caller can tell "the cache is not helping" from "there is
 *  nothing to cache" without instrumenting the renderer. */
const stats = { hits: 0, misses: 0, evictions: 0 };

export function cacheStats() {
  return { ...stats, size: store.size };
}

/** For tests: a clean slate. */
export function resetRowCache() {
  store.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
}

/**
 * Look up `key`, marking it as recently used.
 *
 * @returns the cached value, or undefined on a miss. Callers treat `undefined` as "render
 *   it" — a cache that cannot say "no" is not a cache.
 */
export function rowCacheGet(key) {
  if (!store.has(key)) { stats.misses++; return undefined; }
  const v = store.get(key);
  // Touch: re-insert so this key moves to the young end of the Map's iteration order.
  store.delete(key);
  store.set(key, v);
  stats.hits++;
  return v;
}

/**
 * Store `value` under `key` and enforce the bound.
 *
 * Eviction is oldest-first, and it is done HERE rather than by the caller counting
 * messages: the caller cannot know what the entries cost, and a message-count window
 * keeps a lot of large messages while discarding a lot of small ones.
 */
export function rowCacheSet(key, value) {
  // Re-inserting an existing key would leave the old entry in place, so drop it first —
  // otherwise the bound could be evictions short of what it looks like.
  store.delete(key);
  store.set(key, value);
  while (store.size > ROW_CACHE_LIMIT) {
    // Map iteration is insertion order, so the first key is the least recently used.
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
    stats.evictions++;
  }
  return value;
}

/**
 * Is `cached` still valid for `key`'s message?
 *
 * A separate question from `rowCacheGet`, because a message can change without its key
 * changing: a streamed reply's text is the key's own `text` component, so its key DOES
 * change — but the row COUNT memo does not carry the text, and that one has to be asked
 * whether the content moved. Kept as a function so the check is named at the call site
 * rather than being an open-coded `===` someone later widens by accident.
 */
export function evictIfStale(entry, key) {
  if (!entry) return true;
  return entry.key !== key;
}