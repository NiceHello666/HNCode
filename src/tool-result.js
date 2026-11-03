// Tool-result size control.
//
// Two separate problems, both of which used to be silent:
//
//   1. A SINGLE huge result. Per-tool caps exist (`MAX_OUTPUT_BYTES` in
//      tools/utils.js) but `Read` deliberately has none, and nothing bounded the
//      AGGREGATE of a step's results — a turn with four Reads could add half a
//      megabyte to a history that is then resent on every later request. Real
//      sessions in ~/.hncode/sessions reached 5 MB this way.
//   2. OLD results that no longer matter. A file read forty turns ago is dead
//      weight, but the whole history is resent every request, so it is paid for
//      again and again until something compacts.
//
// The cap is applied where the result is BUILT (see `shapeToolResult`), and the
// overflow is kept, not lost: it goes to a file under the session's own
// directory and the model gets a bounded preview plus the path, so it can Read
// the rest if it turns out to need it. This mirrors Claude Code's
// `<persisted-output>` handling (src/utils/toolResultStorage.ts).
//
// The ages pass (stale-pass) is the cheap half of compaction: it clears the
// BODY of old tool results while leaving the message — and therefore the
// assistant/tool pairing and the exact prefix length — untouched, so it does not
// disturb the message list shape the provider has already cached. Claude Code
// does the same thing in microCompact.ts ("[Old tool result content cleared]").

import fs from 'node:fs';
import path from 'node:path';

// Bytes of a single tool result that are kept inline. Above this the overflow is
// written to disk. 50 KB is Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS and is
// comfortably more than a whole source file's worth of lines.
export const MAX_RESULT_BYTES = 50 * 1024;

// Bytes of a spilled result that stay in the transcript as a preview.
export const PREVIEW_BYTES = 2 * 1024;

// Trigger ratio: trim once the request reaches this fraction of the model window.
// 50% by default (`trim_threshold` / HNCODE_TRIM_THRESHOLD). Well below the
// compaction trigger on purpose — this is the cheap pass that keeps the history
// from ever getting near compaction in the first place.
export const DEFAULT_TRIM_THRESHOLD = 0.5;

// Fraction of the tool-result TEXT that survives a trim. 30% by default
// (`trim_keep_ratio` / HNCODE_TRIM_KEEP_RATIO); the rest of the eligible tool text is
// elided.
//
// A DIFFERENT denominator from `trim_threshold` above, on purpose. The threshold asks
// whether the request is too big for the window (a share of the WINDOW); this asks how much
// of the removable output stays (a share of the TOOL TEXT). Measuring this against the
// request was tried and reverted — at a 1M window the budget then exceeded all the elidable
// text, so `/trim 0.6` could not trim anything at all.
//
// The conversation is protected by the candidate filter in `planTrim`, not by a ratio:
// only messages with `role === 'tool'` are ever elided.
export const DEFAULT_TRIM_KEEP_RATIO = 0.3;

// A tool result shorter than this is never worth eliding: the marker plus the
// pointer would cost more than the text it replaces.
export const MIN_TRIM_BYTES = 512;

export const CLEARED_MARKER = '[Old tool result content cleared]';
export const PERSISTED_TAG = 'persisted-output';

// Directory for spilled results, beside the session file so it is cleaned up
// with the session rather than accumulating in a temp dir.
export function spillDir(sessionId) {
  const root = process.env.HNCODE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.hncode');
  return path.join(root, 'tool-results', String(sessionId || 'unscoped'));
}

// Write `text` to disk and return the preview + path, or null when the write
// fails (a read-only disk must not fail the tool call).
export function spillResult(sessionId, toolCallId, text) {
  try {
    const dir = spillDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // The tool-call id is already a unique, filesystem-safe token from the
    // provider, so it needs no sanitizing beyond dropping path separators.
    const safe = String(toolCallId || 'result').replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(dir, `${safe}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return { file, preview: previewOf(text, PREVIEW_BYTES), originalBytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    return null;
  }
}

// A preview cut on a line boundary when one is close enough, so the model does
// not receive half a line of code as its last visible detail.
export function previewOf(text, maxBytes) {
  const s = String(text == null ? '' : text);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let cut = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxBytes * 0.5) cut = cut.slice(0, nl);
  return cut;
}

// The message the model sees in place of an oversized result. It says what
// happened, how big it was, where the rest is, and how to get it — an agent that
// cannot tell why its output is missing retries the same call forever.
export function spillNotice(spilled) {
  return [
    `Output too large (${fmtBytes(spilled.originalBytes)}). Full output saved to: ${spilled.file}`,
    '',
    `Preview (first ${fmtBytes(PREVIEW_BYTES)}):`,
    spilled.preview,
    '',
    `Read the file above to see the rest — use start_line / end_line to page through it.`,
  ].join('\n');
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Shape ONE tool result for the model: pass small results through, spill big
// ones. Returns { content, spilled } where `content` is what goes into the
// message. `sessionId`/`toolCallId` identify the spill file.
export function shapeToolResult(content, { sessionId, toolCallId, maxBytes = MAX_RESULT_BYTES } = {}) {
  if (typeof content !== 'string') return { content, spilled: false };
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { content, spilled: false };
  const spilled = spillResult(sessionId, toolCallId, content);
  // The write failed: a normal-sized preview is still better than megabytes, and
  // the notice must not claim a path that does not exist.
  if (!spilled) {
    return {
      content: `${previewOf(content, PREVIEW_BYTES)}\n\n[Output truncated: ${fmtBytes(Buffer.byteLength(content, 'utf8'))} total; the full output could not be saved.]`,
      spilled: false,
    };
  }
  return { content: spillNotice(spilled), spilled: true };
}

// Which tool results to elide, and by how much.
//
// RULE (the user's): keep a FRACTION of the TOOL-RESULT TEXT, the newest part.
// Walk the results from newest to oldest accumulating their size; once the total kept
// exceeds `keepRatio` of ALL tool-result text, everything older is elided.
//
// THE DENOMINATOR IS THE TOOL TEXT, NOT THE REQUEST, and the two knobs deliberately use
// different scales because they answer different questions:
//
//   * `trimThreshold` asks "is the request too big for the window yet?" — a share of the
//     WINDOW.
//   * `keep` asks "of the output we are allowed to remove, how much stays?" — a share of
//     the TOOL TEXT.
//
// Measuring `keep` against the request was tried and reverted: at a 1M window with 270k of
// tool text, `threshold` fires at 500k while `keep=0.6` asks to retain 300k — MORE than the
// 270k that could ever be elided. So `/trim 0.6` reported "nothing to trim", and it did so
// for every request above 450k. A knob whose behaviour depends on a total the user cannot
// see is a knob nobody can predict; a share of the tool text behaves the same in a short
// session and a long one.
//
// ONLY TOOL RESULTS ARE TOUCHED, whatever the ratio. The `role !== 'tool'` filter below is
// the real protection for the conversation: user messages, assistant prose and the system
// prompt are never candidates, so no ratio can reach them. (An earlier comment here claimed
// the denominator was what protected the conversation. It never was — the filter is.)
//
// Walking newest-first is what makes this behave the way a person expects: the
// results you were just working from are the ones that survive, and the material
// from twenty turns ago goes first.
//
// Returns { keep: [indices], elide: [indices], totalBytes, keepBytes, elideBytes }.
// `mustKeep` (an index) is never elided — the tool result belonging to the step
// currently in flight, if the caller knows it.
export function planTrim(messages, keepRatio, mustKeep) {
  const empty = { keep: [], elide: [], totalBytes: 0, keepBytes: 0, elideBytes: 0 };
  if (!Array.isArray(messages)) return empty;
  const ratio = Number.isFinite(keepRatio) ? Math.min(Math.max(keepRatio, 0), 1) : DEFAULT_TRIM_KEEP_RATIO;

  // Only string-bodied results can be elided; a media result carries content
  // blocks and clearing it would delete the image itself.
  const candidates = [];
  let totalBytes = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'tool') continue;
    if (typeof m.content !== 'string') continue;
    totalBytes += m.content.length;
    if (m.content === CLEARED_MARKER) continue;
    if (m.content.length < MIN_TRIM_BYTES) continue;
    candidates.push(i);
  }
  if (!candidates.length) return { ...empty, totalBytes };

  // A budget of 0 means "elide everything eligible"; a budget of 1 means "keep it
  // all", in which case we still elide the already-marked ones so a repeated call
  // is a no-op rather than a growing patch.
  // The share of the ELIGIBLE text to keep, not of `totalBytes`. `totalBytes` counts the
  // pointers left by earlier passes, so after a few passes it mostly describes text that can no
  // longer be elided — and a budget drawn from it stops constraining the loop.
  const eligibleBytes = candidates.reduce((n, i) => n + messages[i].content.length, 0);
  const budget = eligibleBytes * ratio;
  const keep = new Set();
  let keepBytes = 0;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const i = candidates[k];
    if (i === mustKeep) { keep.add(i); keepBytes += messages[i].content.length; continue; }
    const size = messages[i].content.length;
    // Under budget: keep. Otherwise elide — except for the result the model is reading right
    // now, which the `mustKeep` branch above has already kept.
    //
    // There used to be a `|| keep.size === 0` here, meaning "always keep at least the newest".
    // `mustKeep` is what actually protects the live result, and the override made a single large
    // result impossible to trim: it was the only candidate, so it was always "the newest", so
    // the budget never applied and the trim elided nothing.
    if (keepBytes + size <= budget) {
      keep.add(i);
      keepBytes += size;
    }
  }

  // THE FLOOR: never elide everything.
  //
  // The budget can be smaller than every candidate — one 200k result against a 60k budget is the
  // ordinary case, because a long turn leaves the history with only the newest result still
  // un-elided. Without this the trim would replace that result with a pointer, which is worse
  // than not trimming: the model loses the output it just asked for.
  if (!keep.size && candidates.length) keep.add(candidates[candidates.length - 1]);
  const elide = [];
  let elideBytes = 0;
  for (const i of candidates) {
    if (keep.has(i)) continue;
    elide.push(i);
    elideBytes += messages[i].content.length;
  }
  return { keep: [...keep].sort((a, b) => a - b), elide, totalBytes, keepBytes, elideBytes };
}

// Apply a trim to `messages` IN PLACE, replacing each elided result with a short
// pointer to the text on disk.
//
// Two properties matter here and both are deliberate:
//
//   * The message COUNT and every message's role stay identical. The provider's
//     prompt cache is keyed on the prefix, and a message list that changes SHAPE
//     invalidates it — replacing bodies keeps the shape.
//
//   * The full text is written to disk first (spillDir), so an elided result is
//     RECOVERABLE: the model reads the pointer and pages through the file. That is
//     what makes "elided" different from "deleted" — the point the user raised
//     about trimming eating their work.
//
// `sessionId`/`messages` identify where the copies go. Returns
// { elided, elidedBytes, kept, keptBytes }.
export function applyTrim(messages, plan, sessionId) {
  const out = { elided: 0, elidedBytes: 0, kept: plan.keep.length, keptBytes: plan.keepBytes };
  if (!Array.isArray(messages) || !plan.elide.length) return out;
  for (const i of plan.elide) {
    const m = messages[i];
    const original = m.content;
    // Copy it out BEFORE overwriting: this is the whole difference between a trim
    // and a loss. If the write fails we still elide, but the pointer says so.
    const spilled = spillResult(sessionId, `trim-${m.toolCallId || i}`, original);
    const tool = m.name || 'tool';
    m.content = spilled
      ? `[Output elided to save context — ${fmtBytes(original.length)} from ${tool}.\n`
        + `Full text saved to: ${spilled.file}\n`
        + `Read that file (with start_line/end_line) if you need this output again.]`
      : `[Output elided to save context — ${fmtBytes(original.length)} from ${tool}; the full text could not be saved.]`;
    out.elided++;
    out.elidedBytes += original.length;
  }
  return out;
}

// Convenience: plan + apply in one go. Returns null when nothing needed trimming,
// so a caller can skip its UI event entirely.
export function trimToolResults(messages, opts = {}) {
  const plan = planTrim(messages, opts.keepRatio, opts.mustKeep);
  const mediaPlan = planMediaTrim(messages, opts.mediaKeep ?? 2);
  if (!plan.elide.length && !mediaPlan.elide.length) return null;
  const applied = plan.elide.length
    ? applyTrim(messages, plan, opts.sessionId)
    : { elided: 0, elidedBytes: 0, kept: plan.keep.length, keptBytes: plan.keepBytes };
  const mediaApplied = applyMediaTrim(messages, mediaPlan, opts.sessionId);
  return {
    ...applied,
    elided: applied.elided + mediaApplied.elided,
    elidedBytes: applied.elidedBytes + mediaApplied.elidedBytes,
    plan,
  };
}

// ---- media results ----------------------------------------------------------
// A media tool result keeps its base64 payload IN the history object — and unlike
// a string body, planTrim cannot elide it, so every screenshot was re-serialized
// into every request body, every session save and every cache-prefix walk until a
// full compaction dropped it. Keep only the newest `mediaKeep` media results;
// older ones spill their text (if any) and lose the bytes, same contract as the
// string path: saved to disk first, pointer left behind.

function planMediaTrim(messages, keep) {
  const idx = [];
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'tool' && m.content && typeof m.content === 'object'
        && Array.isArray(m.content.media) && m.content.media.length) idx.push(i);
    }
  }
  const elide = idx.slice(0, Math.max(0, idx.length - Math.max(0, keep)));
  return { elide };
}

function applyMediaTrim(messages, mediaPlan, sessionId) {
  const out = { elided: 0, elidedBytes: 0 };
  for (const i of mediaPlan.elide) {
    const m = messages[i];
    let bytes = 0;
    for (const part of m.content.media) bytes += (part && part.data ? part.data.length : 0);
    const text = String(m.content.text || '');
    const spilled = spillResult(sessionId, `trim-${m.toolCallId || i}`, text || '[media only]');
    m.content = `[Media result elided to save context — ${fmtBytes(bytes)} of image data from ${m.name || 'tool'}`
      + (spilled ? `; the description was saved to: ${spilled.file}` : '; the description could not be saved')
      + '. Re-run the tool if you need the image again.]';
    out.elided++;
    out.elidedBytes += bytes;
  }
  return out;
}
