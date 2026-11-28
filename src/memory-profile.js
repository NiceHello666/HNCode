// Session memory profiler — where the bytes actually go.
//
// WHY THIS EXISTS
// ---------------
// Two questions came up that nothing here could answer: "why is the process using so much
// memory", and "did the transcript-amplification fix actually save anything". Both are
// unanswerable without knowing WHICH content is large, because "the session" is not one
// thing — the same conversation exists in several forms at once:
//
//   * `session.messages`   what gets sent to the model (text + tool args + tool results)
//   * `state.chat`         what the renderer draws (a DIFFERENT array of rows)
//   * `session.transcript` the display-only record that is written to disk
//
// and within `messages` the bytes are not where a count of rows suggests. Measured on a
// real 2.6 MB session: text was 0.28 MB, tool RESULTS 0.34 MB, and tool-call ARGUMENTS
// 0.66 MB — the arguments, which no row count hints at, were more than everything else
// combined. On that same session the serialised JSON was 2.29 MB while the sum of its
// parts was 1.27 MB, so roughly as much again is STRUCTURE: keys, role tags, escaped
// strings.
//
// Modelled on jcode's `jcode-base/src/session/memory_profile.rs`, which records the same
// split plus the extremes (largest single block), because a profile without a maximum
// hides the one item that actually caused the problem.
//
// Pure and read-only: it measures, it never trims, loads or rewrites anything.

import { uiText } from './i18n.js';

/** Content larger than this is counted separately — a single 16 KB block is the shape of
 *  a runaway, while 16 KB spread evenly is nothing. */
const LARGE_BLOB_BYTES = 16 * 1024;

/** Byte size of a value as it would sit in memory: strings as-is, everything else as JSON. */
function bytes(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8');
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return 0; }
}

/** One accumulating bucket. Every measurement lands in exactly one category. */
function bucket() {
  return { bytes: 0, count: 0, max: 0 };
}

function add(b, n) {
  b.bytes += n;
  b.count += 1;
  if (n > b.max) b.max = n;
}

const mb = (n) => (n / 1048576).toFixed(2);

/**
 * Profile the memory a session occupies, broken down by content type.
 *
 * @param {object} input
 * @param {object} [input.session]   a loaded session ({ messages, transcript })
 * @param {Array}  [input.chat]      `state.chat` — the renderer's rows, if present
 * @param {object} [input.state]     the live TUI state, to measure chat and caches
 * @returns {object} a plain report; see `renderMemoryProfile` for the human form
 */
export function profileMemory(input = {}) {
  const session = input.session || {};
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];

  // ---- session.messages, split by what the bytes are --------------------
  const text = bucket();
  const toolResults = bucket();
  const toolArgs = bucket();
  const images = bucket();
  const argsByTool = new Map();

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const isResult = m.role === 'tool';
    add(isResult ? toolResults : text, bytes(m.content));
    // An image rides as a data: URL or a base64 field rather than in `content`, so it is
    // measured separately — base64 inflates 4/3, and that is worth knowing.
    const img = m.image || m.images || m.media;
    if (img) add(images, bytes(img));
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      if (!tc || typeof tc !== 'object') continue;
      const n = bytes(tc.args);
      add(toolArgs, n);
      const name = String(tc.name || '?');
      if (!argsByTool.has(name)) argsByTool.set(name, bucket());
      add(argsByTool.get(name), n);
    }
  }

  // ---- session.transcript, which is display-only and can dwarf everything
  const transcriptByRole = new Map();
  let transcriptBytes = 0;
  let transcriptLarge = 0;
  let transcriptMax = 0;
  for (const e of transcript) {
    const row = e && e.row;
    if (!row) continue;
    const n = bytes(row.text);
    transcriptBytes += n;
    if (n > transcriptMax) transcriptMax = n;
    if (n >= LARGE_BLOB_BYTES) transcriptLarge += n;
    const role = String(row.role || '?');
    if (!transcriptByRole.has(role)) transcriptByRole.set(role, bucket());
    add(transcriptByRole.get(role), n);
  }

  // ---- the renderer's copy ----------------------------------------------
  // Derived from `messages` when the caller does not supply the live `state.chat`, so a
  // profile of a session loaded off disk still accounts for what the renderer would build.
  // `convRowFor` maps ONE message to rows, so it has to be applied per message — handing it
  // the array returns a single empty row and the copy silently measured as zero, which is
  // exactly what the first run of this printed.
  let chat = Array.isArray(input.chat) ? input.chat : null;
  if (!chat && input.state && Array.isArray(input.state.chat)) chat = input.state.chat;
  if (!chat && messages.length && typeof input.convRowFor === 'function') {
    chat = [];
    for (const m of messages) {
      const rows = input.convRowFor(m);
      if (Array.isArray(rows)) chat.push(...rows);
    }
  }
  chat = chat || [];
  const chatBytes = chat.reduce((a, r) => a + bytes(r && r.text), 0);

  // ---- what it costs as one JSON document -------------------------------
  // Reported because it is usually the biggest single number and nobody expects it: the
  // serialised form carries every key and escape, which no content sum shows.
  let jsonBytes = 0;
  try { jsonBytes = Buffer.byteLength(JSON.stringify({ messages, transcript }), 'utf8'); } catch { /* */ }

  const contentBytes = text.bytes + toolResults.bytes + toolArgs.bytes + images.bytes;
  const measured = contentBytes + transcriptBytes;

  return {
    messages: {
      count: messages.length,
      text,
      toolResults,
      toolArgs,
      images,
      argsByTool,
      contentBytes,
      // The gap between the parts and the document: keys, role tags, escapes, and the
    // array/record overhead of 3000 messages each carrying a role and a shape.
    structuralBytes: Math.max(0, jsonBytes - measured),
    jsonBytes,
  },
    transcript: {
      count: transcript.length,
      bytes: transcriptBytes,
      largeBytes: transcriptLarge,
      maxRowBytes: transcriptMax,
      byRole: transcriptByRole,
    },
    chat: { count: chat.length, bytes: chatBytes },
    // The three forms coexist, so the process holds roughly all of them at once.
    totalBytes: measured + chatBytes,
    totals: { messages: contentBytes, transcript: transcriptBytes, chat: chatBytes },
  };
}

/**
 * The profile as lines for a panel or a tool result.
 *
 * @param {object} p      from profileMemory
 * @param {object} [opts]
 * @param {number} [opts.top]  how many rows of the per-tool table to show
 * @param {boolean} [opts.verbose]  include the per-tool breakdown
 */
export function renderMemoryProfile(p, opts = {}) {
  const lines = [];
  const total = p.totalBytes || 0;
  // The document size is reported in the same table, so it must NOT join the percentage
  // base — it is a different measure of the same data (serialised vs in-memory), and
  // including it produced totals over 100%.
  const contentBase = (p.messages.contentBytes || 0) + (p.transcript.bytes || 0) + (p.chat.bytes || 0);
  // Rounding to 2 places on a few HUNDRED bytes made "5 bytes / 5 bytes" print as
  // 100.0% but a document row print 1280.0% — a percentage over 100 is never a real
  // share, so it is clamped rather than trusted.
  const pct = (n) => {
    if (!contentBase || !n) return '';
    const v = Math.min(100, (100 * n) / contentBase);
    return ` ${v.toFixed(1)}%`.padStart(7);
  };
  const row = (label, b, n, share = true) => {
    const text = uiText(label);
    lines.push(`  ${text.padEnd(18)} ${mb(b).padStart(9)} MB${n != null ? `  x${n}` : ''}${share ? pct(b) : ''}`);
  };

  lines.push(uiText(`Memory profile — ${mb(total)} MB across the forms a session holds`));
  lines.push('');
  lines.push(uiText('  content (session.messages)'));
  row('text', p.messages.text.bytes, p.messages.text.count);
  row('tool results', p.messages.toolResults.bytes, p.messages.toolResults.count);
  row('tool arguments', p.messages.toolArgs.bytes, p.messages.toolArgs.count);
  if (p.messages.images.bytes) row('images', p.messages.images.bytes, p.messages.images.count);

  if (p.transcript.count) {
    lines.push('');
    lines.push(uiText('  transcript (display-only, on disk)'));
    row('all rows', p.transcript.bytes, p.transcript.count);
    if (p.transcript.largeBytes) {
      lines.push(`    ${uiText('of which >=16 KB:')}  ${mb(p.transcript.largeBytes).padStart(9)} MB`);
    }
    lines.push(`    ${uiText('largest row:').padEnd(17)}${mb(p.transcript.maxRowBytes).padStart(9)} MB`);
    if (opts.verbose) {
      for (const [role, b] of [...p.transcript.byRole].sort((a, c) => c[1].bytes - a[1].bytes)) {
        row(`    ${role}`, b.bytes, b.count);
      }
    }
  }

  lines.push('');
  lines.push(uiText('  other copies held at the same time'));
  row('state.chat (render)', p.chat.bytes, p.chat.count);

  lines.push('');
  lines.push(uiText('  as one JSON document (a different measure of the same data)'));
  // Measured against the CONTENT, not the content-plus-content the base holds, so these
  // two rows carry no share: they re-measure what the rows above already report.
  row('serialised size', p.messages.jsonBytes, null, false);
  row('structure + escapes', p.messages.structuralBytes, null, false);
  if (p.messages.structuralBytes > p.messages.contentBytes) {
    lines.push(uiText('    (structure is larger than the content — that is normal for many short messages)'));
  }

  if (opts.verbose && p.messages.argsByTool.size) {
    lines.push('');
    lines.push(uiText('  tool arguments by tool'));
    const rows = [...p.messages.argsByTool].sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [name, b] of (opts.top ? rows.slice(0, opts.top) : rows)) {
      row(name, b.bytes, b.count);
    }
  }
  return lines;
}

/**
 * A short verdict, for a place that wants one line rather than a table.
 * @returns {string}
 */
export function memoryHeadline(p) {
  const total = mb(p.totalBytes);
  const args = mb(p.messages.toolArgs.bytes);
  const tr = p.transcript.count ? mb(p.transcript.bytes) : '0';
  return `${total} MB total · text ${mb(p.messages.text.bytes)} · tool results ${mb(p.messages.toolResults.bytes)} · tool args ${args} · transcript ${tr}`;
}
