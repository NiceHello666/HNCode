// Recovering a session file that a broken save left unparseable.
//
// WHAT BROKE
// ----------
// `stringifySession` spliced the message array into a placeholder with
// `String.replace(pattern, messagesJson)`. A replacement STRING is not literal text:
// `$&`, `` $` ``, `$'` and `$$` are expansions. A conversation that merely mentioned
// `sed s/x/$&/g` therefore corrupted its own file on save, and because the write is
// tmp-then-rename with no verification, the damaged bytes replaced the good ones. The
// next load failed, `latestSession` fell back to the metadata head, and the next save
// wrote `messages: []` over the history.
//
// Only two of those expansions break the STRUCTURE, and both insert whole copies of text
// that is already present:
//
//   `$&`  -> the matched placeholder, quotes and all
//   `` $` `` -> a copy of everything before the match, which is the metadata head
//
// `$'` inserts the `}` that follows the match and `$$` inserts a `$`: both damage the
// conversation TEXT, not the JSON around it, so the file still loads.
//
// A file saved once can be undone exactly. A file saved repeatedly has the copies
// interleaved with conversation text that was streaming at the time, so the boundaries
// are gone and the offset is unrecoverable — the salvager then reads each surviving
// message OBJECT out of the array and keeps every one that still parses.
//
// Nothing here guesses at text. A message whose bytes no longer form a valid object is
// dropped and counted, never repaired by inference.

import fs from 'node:fs';

// The literal placeholder as it appears inside a JSON string, quotes included. It can
// only ever have come from a `$&` expansion: no message the user writes contains a NUL,
// and JSON.stringify escapes it, so this exact sequence is the marker itself.
const PLACE_QUOTED = '"\\u0000HNCODE_PLACEHOLDER\\u0000"';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Index of the `[` that opens the array value of `"messages"`, or -1. */
function messagesArrayStart(text) {
  const key = text.indexOf('"messages"');
  if (key < 0) return -1;
  return text.indexOf('[', key);
}

/**
 * The metadata block, parsed on its own.
 *
 * Everything before the messages array is written by `JSON.stringify` alone — it is the
 * SEARCH side of the broken replace, never the replacement — so it is intact even in a
 * file whose array is shredded. Closing it with an empty array yields the whole session
 * minus its messages: title, workspace, todos, usage, shell history, all of it.
 */
function parseHead(text) {
  const open = messagesArrayStart(text);
  if (open < 0) return null;
  const head = text.slice(0, open);
  for (const tail of ['[]}', '[]'] ) {
    try {
      const obj = JSON.parse(head + tail);
      if (isObj(obj)) return obj;
    } catch { /* try the next closing form */ }
  }
  return null;
}

// End index (exclusive) of the JSON value starting at `at`, or -1 when it is incomplete.
// Strings are skipped whole, so braces inside a message body cannot be miscounted.
function valueEnd(text, at) {
  const c = text[at];
  if (c !== '{' && c !== '[') return -1;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      if (j >= text.length) return -1;
      i = j;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Read every message object that still parses, out of a damaged `messages` array.
 *
 * A damaged array is a series of JSON objects with rubbish BETWEEN them, so the scan looks
 * for the next `{"role":` and tries to parse an object there. When that object runs into an
 * inserted copy of the head its own strings still close correctly, so a failed parse means
 * the walk steps INSIDE it instead of skipping past the whole thing — which is what keeps
 * the messages that follow a damaged one.
 */
export function salvageMessages(text) {
  const open = messagesArrayStart(text);
  if (open < 0) return { messages: [], dropped: 0 };
  const end = text.indexOf('"transcript"', open);
  const limit = end > 0 ? end : text.length;
  const messages = [];
  let dropped = 0;
  let i = open + 1;
  while (i < limit) {
    const at = text.indexOf('{"role":', i);
    if (at < 0 || at >= limit) break;
    const stop = valueEnd(text, at);
    let ok = null;
    if (stop > 0) {
      try { ok = JSON.parse(text.slice(at, stop)); } catch { ok = null; }
    }
    if (isObj(ok) && typeof ok.role === 'string') {
      messages.push(ok);
      i = stop;
      continue;
    }
    dropped++;
    // The object at `at` is damaged. Its damage may span several messages, so resume the
    // search just after its opening key rather than after its (misleading) end.
    i = at + '{"role":'.length;
  }
  return { messages, dropped };
}

/**
 * Make a recovered list safe to SEND, not merely parsed.
 *
 * A salvage can drop the assistant message that ISSUED a tool call while keeping its
 * result, or the other way round. Every provider rejects both: a `tool` row with no call,
 * and a call with no result. The pair rule is the protocol's own — results follow their
 * call immediately — so an assistant keeps only the calls that a following `tool` run
 * answers, and a `tool` row is kept only when the call it answers was kept.
 *
 * Nothing else is touched. Returns `{ messages, orphaned }`.
 */
export function sanitizeToolPairs(messages) {
  const out = [];
  let orphaned = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!isObj(m)) { i++; continue; }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls.filter((tc) => tc && tc.id) : [];
      let j = i + 1;
      const results = [];
      while (j < messages.length && isObj(messages[j]) && messages[j].role === 'tool') {
        results.push(messages[j]);
        j++;
      }
      const answered = new Set(results.map((r) => r.toolCallId));
      const keptCalls = calls.filter((tc) => answered.has(tc.id));
      const hasText = typeof m.content === 'string' && m.content.trim();
      if (hasText || keptCalls.length) {
        const copy = { ...m };
        if (calls.length) {
          if (keptCalls.length) copy.toolCalls = keptCalls;
          else delete copy.toolCalls;
          orphaned += calls.length - keptCalls.length;
        }
        out.push(copy);
        const keepIds = new Set(keptCalls.map((tc) => tc.id));
        for (const r of results) {
          if (keepIds.has(r.toolCallId)) out.push(r);
          else orphaned++;
        }
      } else {
        orphaned += 1 + calls.length + results.length;
      }
      i = j;
      continue;
    }
    if (m.role === 'tool') { orphaned++; i++; continue; }
    out.push(m);
    i++;
  }
  return { messages: out, orphaned };
}

/**
 * Delete the copies `` $` `` injected, keeping the first occurrence because the first one
 * IS the file's real head.
 *
 * A saved-once file becomes valid JSON again. A file saved repeatedly usually will not —
 * the copies were spliced around text that was streaming at the time — so the caller
 * falls back to `salvageMessages`.
 */
function stripInjectedHeadCopies(text) {
  const open = messagesArrayStart(text);
  if (open < 0) return text;
  const head = text.slice(0, open);
  if (head.length < 64) return text;
  let out = text;
  let at = out.indexOf(head, head.length);
  if (at < 0) return out;
  while (at >= 0) {
    out = out.slice(0, at) + out.slice(at + head.length);
    at = out.indexOf(head, head.length);
  }
  return out;
}

/**
 * Salvage the display-only `transcript` array, which follows `messages` in the file.
 *
 * The real key is the LAST unescaped `"transcript":` in the file — an inserted head copy
 * can carry its own, earlier one. The array is written after the messages, so on a file
 * damaged mid-history it is normally intact, but it can be cut too, so every candidate is
 * walked with the same object salvage and the first one that yields rows wins.
 */
function salvageTranscript(text) {
  const key = '"transcript":';
  let at = text.lastIndexOf(key);
  while (at >= 0) {
    const open = text.indexOf('[', at);
    if (open < 0) return [];
    const got = salvageArrayAt(text, open);
    if (got.length) return got;
    at = text.lastIndexOf(key, at - 1);
  }
  return [];
}

/** Every object in the array starting at `open` that still parses. */
function salvageArrayAt(text, open) {
  const out = [];
  let i = open + 1;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    const stop = valueEnd(text, start);
    if (stop < 0) break;
    try { out.push(JSON.parse(text.slice(start, stop))); } catch { /* skip the damaged one */ }
    i = stop;
  }
  return out;
}

/**
 * Recover a session from a file that does not parse.
 *
 * Returns `{ session, report }`, or null when nothing of value could be read back. The
 * report says which route worked and how many messages were lost, so the caller can tell
 * the user the truth instead of presenting a silently shortened history.
 */
export function recoverSessionText(text) {
  if (typeof text !== 'string' || !text) return null;
  const head = parseHead(text);
  if (!head) return null;

  // Route 1, exact: remove what the expansions inserted and reparse.
  let exact = null;
  try {
    const cleaned = stripInjectedHeadCopies(text.split(PLACE_QUOTED).join(''));
    exact = JSON.parse(cleaned);
  } catch { exact = null; }
  if (isObj(exact) && Array.isArray(exact.messages)) {
    const clean = sanitizeToolPairs(exact.messages);
    return {
      session: { ...exact, messages: clean.messages },
      report: { route: 'exact', kept: clean.messages.length, dropped: 0, orphaned: clean.orphaned },
    };
  }

  // Route 2, salvage: keep every message object that still parses, then make the result
  // safe to send — a salvaged list can hold half of a tool exchange, which every provider
  // rejects with a 400 the moment the session is resumed.
  const salvaged = salvageMessages(text.split(PLACE_QUOTED).join(''));
  const clean = sanitizeToolPairs(salvaged.messages);
  if (!clean.messages.length) return null;
  const session = { ...head, messages: clean.messages };
  // The on-screen rows live after `messages`, so the parsed head does not carry them.
  // Losing them would make a resumed session show less than it had.
  const transcript = salvageTranscript(text);
  if (transcript.length) session.transcript = transcript;
  return {
    session,
    report: {
      route: 'salvage',
      kept: clean.messages.length,
      dropped: salvaged.dropped,
      orphaned: clean.orphaned,
    },
  };
}

/**
 * Recover a session file in place, keeping the damaged original as `<file>.bak`.
 *
 * The backup is written BEFORE the repair, so a wrong recovery is never the only copy
 * left on disk.
 */
export function recoverSessionFile(file, knownText) {
  let text = typeof knownText === 'string' ? knownText : null;
  if (text === null) {
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  }
  const got = recoverSessionText(text);
  if (!got) return null;
  try {
    fs.writeFileSync(`${file}.bak`, text, 'utf8');
    const tmp = `${file}.${process.pid}.recover.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(got.session), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ...got, wrote: false, error: e && e.message ? e.message : String(e) };
  }
  return { ...got, wrote: true, backup: `${file}.bak` };
}
