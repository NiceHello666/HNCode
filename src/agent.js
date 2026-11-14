// The agent loop: sends the message history to the LLM, consumes the normalized
// event stream, executes any tool calls, appends results, and repeats until the
// model answers without tool calls (or a step/interrupt condition is hit).

import { LLM, setToolsList } from './llm.js';
import { tools, combinedTools, getTool, llmTools } from './tools/index.js';
import { validateToolArgs } from './tools/validate-args.js';
import { DELEGATION_TOOLS } from './subagent-types.js';
import { estimateMessagesTokens, estimateRequestOverhead, estimateTokens, measureToolDefTokens, messageTokens, TokenLedger, forgetMessageTokens } from './term.js';
import { runHooks, runPatch, runPatchSync } from './plugin.js';
import { loadHooks, runShellHooks } from './hooks.js';
import {
  shapeToolResult, trimToolResults, DEFAULT_TRIM_THRESHOLD, DEFAULT_TRIM_KEEP_RATIO,
} from './tool-result.js';
// ---- compaction text (kimi's shapes) ----------------------------------------
// These mirror kimi-code's contextMemory/compactionHandoff.ts so a compacted
// history reads the same way there.

// Wraps harness-generated text so it reads as a system note rather than something
// the user actually typed.
function wrapSystemReminder(content) {
  return `<system-reminder>\n${String(content).trim()}\n</system-reminder>`;
}

// ---- token accounting -------------------------------------------------------
// The provider reports the numbers; this folds one report into a running total.
// A field the provider did not send is left as it was, because "not reported" and
// "zero" are different facts: summing undefined into 0 would claim a model never
// used a cache it simply does not measure.
export function addUsage(total, u) {
  const out = { ...(total || {}) };
  if (!u) return out;
  for (const key of ['input', 'output', 'cached', 'cacheWrite', 'reasoning']) {
    if (typeof u[key] === 'number' && Number.isFinite(u[key])) out[key] = (out[key] || 0) + u[key];
  }
  // How many REQUESTS contributed, so a reader can tell one big call from many
  // small ones with the same token count. Counted on the completion side, which
  // every protocol reports exactly once per request — Anthropic splits one
  // request into two usage events (input at message_start, output at
  // message_delta), so counting events would report double.
  if (u.output !== undefined) out.calls = (out.calls || 0) + 1;
  return out;
}


const COMPACTION_SUMMARY_PREFIX = [
  'The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over.',
  'Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it.',
  'User messages earlier in this context are preserved verbatim from the compacted conversation. The summary records which earlier requests were already addressed.',
].join(' ');

// The instruction given to the model that WRITES the summary. Adapted from
// kimi-code's fullCompaction/compaction-instruction.md: it is a handoff for the
// model that resumes, not a recap for a human. The language rule matters — without
// it a Chinese conversation produced an English summary and the resumed context
// lost the vocabulary the task was being discussed in.
const COMPACTION_INSTRUCTION = [
  'You are about to run out of context. Create a handoff summary for the model that will resume this task after the earlier conversation is cleared.',
  '',
  'This message is a direct task, not part of the above conversation.',
  '',
  'Write it in the same language the conversation has been using — do not switch to English just because these instructions are in English.',
  '',
  'Make the summary self-sufficient: the next turn will see only the preserved messages and this summary. In your own words, preserve what is genuinely needed to continue:',
  '',
  '- What the latest request actually asks for, and any ambiguity you have already resolved. If the latest request is large (a big paste or file) and may be truncated in the kept messages, preserve the actual ask.',
  '- The instructions and constraints currently in force (user preferences, project rules, environment limits), with settled decisions kept separate from open questions, so neither is reopened nor mistaken for decided.',
  '- What has actually been done, at high fidelity: exact commands run, exact file paths touched, and their results — the concrete values, key lines and error text — not just the commands. Keep only the final working version of any code; drop intermediate attempts and already-resolved errors.',
  '- What you still do not know: files referenced but not read, APIs assumed but unseen, questions the user has not answered. Name these gaps so the next turn checks them instead of assuming.',
  '- The forward plan: the exact next step, the sequence to finish, decisions already made for those steps, foreseeable obstacles and how you mean to handle them.',
  '',
  'Be honest about uncertainty. If an earlier step claimed something was done but was never verified, say so plainly and treat it as unverified rather than fact.',
  '',
  'Be concise and proportional: a long multi-step task warrants detail, a nearly finished exchange needs only a sentence or two.',
  '',
  'Respond with text only. Do not call any tools. Any tool-call syntax in your answer is discarded and scores the handoff as failed.',
  '',
  'That includes XML-style tool syntax such as `<||DSML||invoke name="...">` or `<function_call>`: no such tag is',
  'recognised here, so it becomes part of the summary and the next turn reads it as a step that happened.',
].join('\n');
// Trailing note: the model should RESUME, not answer the summary.

// A summariser can answer with tool-call syntax even when no tools were offered — the format is in its
// training data, and a model interrupted mid-workflow reaches for it. Nothing was called, so the text is
// noise, and left in a handoff summary the next turn reads it as a step that happened.
//
// The shapes covered are the ones these models actually emit: a special-token block (`<|tool_call|>`), a
// fenced ```tool_call block, and a bare JSON object that claims a `name` and `arguments`. Only a block that
// occupies whole lines is removed, so prose that merely mentions calling a tool survives.
function stripToolCallText(text) {
  if (typeof text !== 'string' || !text) return text || '';

  // NOTHING WAS CALLED, SO THE BLOCK IS NOISE — but removing it outright can leave nothing at all.
  //
  // A summariser that answers ONLY with a tool call produced no summary: stripping to '' makes the caller
  // treat the compaction as failed, and the fallback there is to drop the history. So the stripped text is
  // measured: if it lost its substance, the original is kept VERBATIM with a note saying what it is. A
  // confusing summary is recoverable; a discarded one is not.
  let out = text;
  // A special-token block: closed form, or an unterminated one running to the end of its line.
  out = out.replace(/<\|tool_call\|>[^\n]*(?:<\|\/tool_call\|>)?/g, '');
  // A fenced block form.
  out = out.replace(/```tool_call[\s\S]*?```/g, '');
  // A bare JSON object on its own lines that declares a tool invocation.
  out = out.replace(/^\s*\{[^\n]*"name"\s*:\s*"[^"]+"[^\n]*"arguments"[^\n]*\}\s*$/gm, '');
  // THE DSML DIALECT. Some models write a tool call as an XML-ish block with a doubled delimiter around the
  // tag name (`<||DSML||invoke name="…">`), which none of the patterns above match. It arrives as a whole
  // block, so it is removed as one — an unterminated block included, since a summariser cut off by the token
  // limit leaves exactly that.
  out = out.replace(/<\|+\|?DSML\|?\|+[\s\S]*?(?=<\/\|\|+DSML\|\|+>|$)/gi, '');
  out = out.replace(/<\/?\|+\|?DSML\|?\|+[^>]*>/gi, '');
  // THE `<function_call>` DIALECT and its `<tool_call>` sibling: a JSON payload wrapped in a tag. Removed with
  // its body when both tags are present, and on its own when the body follows on the next line.
  out = out.replace(/<(function_call|tool_call)>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<(function_call|tool_call)>[^\n]*/gi, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  if (out.length > 0) return out;

  // Every remaining character was a tool call: keep the original, marked for what it is.
  return [
    '(The summariser answered with a tool call instead of a summary. No tool was actually run — the text is',
    'reproduced below unchanged so nothing is lost. Treat it as a summary that was never written.)',
    '',
    text.trim(),
  ].join('\n');
}

const COMPACTION_CONTINUATION_TEXT = 'Context compaction is complete — continue the work that was in progress when it began.';

// Clip to a TOKEN budget, counting non-ASCII as one token per character (the same
// rule estimateTokens uses). Slicing by characters is wrong for CJK text: 4000
// Chinese characters are ~4000 tokens, not ~1000.
function clipToTokens(text, maxTokens) {
  if (maxTokens <= 0) return '';
  const s = String(text ?? '');
  let ascii = 0, nonAscii = 0, end = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 127) ascii++; else nonAscii++;
    if (Math.ceil(ascii / 4) + nonAscii > maxTokens) break;
    end += ch.length;
  }
  return end >= s.length ? s : s.slice(0, end) + '\n…[clipped]';
}

// May the history be split between `index` and `index + 1`? Mirrors kimi's
// canSplitAfter — a split is illegal when it would orphan a tool exchange:
//   * the message before the cut is a user message (would start the kept part
//     mid-turn), or
//   * it is an assistant message that still has tool calls, or
//   * the message after the cut is a tool result, or
//   * the prefix ends inside an open tool exchange (more results to come).
// Exported for the headless -p path (index.js), which must trim a resumed
// history on the same legal boundaries the compaction logic uses.
export function canSplitAfter(messages, index) {
  if (index < 0 || index >= messages.length) return false;
  const m = messages[index];
  if (!m) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return false;
  const next = messages[index + 1];
  if (next && next.role === 'tool') return false;
  return !prefixEndsWithOpenToolExchange(messages, index);
}

// True when the prefix [0..index] ends with an assistant that issued MORE tool
// calls than have results so far — cutting there would leave a call unanswered.
function prefixEndsWithOpenToolExchange(messages, index) {
  if (!messages[index] || messages[index].role !== 'tool') return false;
  let results = 0;
  for (let i = index; i >= 0; i--) {
    const m = messages[i];
    if (!m) return false;
    if (m.role === 'tool') { results++; continue; }
    return m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > results;
  }
  return false;
}


// A short, stable key for the prompt cache, derived from the conversation's
// first user message. Stability is the whole point: the same conversation must
// produce the same key on every turn, so a cheap deterministic hash beats a
// random id. (Different conversations may collide — that is harmless, it only
// means the provider's routing key is shared.)
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36) + '-' + str.length.toString(36);
}

// Render what an Edit actually changed, for the MODEL's tool result.

// Render what an Edit actually changed, for the MODEL's tool result.
//
// The UI has always received the edit through `editDiff` (see the tool_result
// event), but the message pushed into `this.messages` carried only the one-line
// receipt ("Edited a.js: replaced 1 occurrence(s)."). The model was therefore
// asked to verify its own edit from a sentence that describes nothing: it could
// not see WHAT changed, so a wrong-but-successful edit looked identical to a
// correct one. The diff is appended here — after the receipt — so the model
// reads what it did.
//
// The format is the usual unified one (`- old`, `+ new`) with the line number
// from the file, and it is deliberately indented two spaces: a tool result is
// rendered as plain text, and the indent keeps the +/- marks from reading as
// part of the JSON envelope some providers wrap tool output in.
export function formatEditDiffForModel(diff, maxLines = 400) {
  if (!diff || typeof diff.old !== 'string' || typeof diff.new !== 'string') return '';
  const split = (s) => String(s).replace(/\r\n/g, '\n').split('\n');
  const oldLines = split(diff.old);
  const newLines = split(diff.new);
  const startLine = Number(diff.startLine) > 0 ? Number(diff.startLine) : 1;
  const out = [];
  out.push('');
  out.push('--- diff ---');
  // Unchanged lines above and below, unmarked, so the change can be LOCATED. Without them this
  // was a quoted block with no indication of where in the file it landed — and identical-looking
  // code appears in many places, so neither the model nor the user could confirm the edit hit
  // the intended one rather than a same-text block further down.
  const before = (diff.context && Array.isArray(diff.context.before)) ? diff.context.before : [];
  const after = (diff.context && Array.isArray(diff.context.after)) ? diff.context.after : [];
  for (const c of before) out.push('  ' + String(c.n).padStart(4) + '   ' + c.text);
  let n = startLine;
  for (const l of oldLines) out.push('  ' + String(n++).padStart(4) + ' - ' + l);
  n = startLine;
  for (const l of newLines) out.push('  ' + String(n++).padStart(4) + ' + ' + l);
  for (const c of after) out.push('  ' + String(c.n).padStart(4) + '   ' + c.text);
  // A whole-file edit (a Write-sized `new`) must not be echoed back in full.
  if (out.length > maxLines + 3) {
    const hidden = out.length - (maxLines + 3);
    out.length = maxLines + 3;
    out.push('  … ' + hidden + ' more diff line(s) omitted');
  }
  return out.join('\n');
}

// Final instruction appended to the system prompt (see SYSTEM_PROMPT).
// (The wording lives in SYSTEM_PROMPT itself, under "Finishing a turn".)


// Tools whose execution cannot affect what any OTHER tool call in the same step
// observes, and cannot be affected by one. Two read-only tools therefore have no
// reason to run one after the other, and the agent runs a consecutive run of them
// in parallel (see the tool loop in run()). Anything that writes, spawns, shells
// out or mutates the working tree is excluded — that rules out `Git` (it can
// stage/commit/switch), `ReadMediaFile` (read-only, but it decodes megabytes of
// media and is never the bottleneck) and every delegation tool. Claude Code
// expresses the same idea as `isConcurrencySafe()` on each tool; this is the flat
// version of it, matching hncode's tool registry.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'FileLines', 'FetchURL', 'WebSearch',
  'TaskList', 'TaskOutput',
]);

// Debug switch for the size/age control in tool-result.js, mirroring Claude
// Code's env-gated knobs. Set HNCODE_TOOL_RESULT_LIMITS=off to send every tool
// result verbatim (useful when a spill is suspected of hiding something the
// model needed).
function toolResultLimitsEnabled() {
  return !/^(0|off|false|no)$/i.test(String(process.env.HNCODE_TOOL_RESULT_LIMITS || ''));
}

/**
 * A tool's return value, as the STRING the model can be sent.
 *
 * Every tool in `src/tools/` returns a plain string except the team tools, which return
 * `{ content }` / `{ error }`. That object went into the `tool` message verbatim, and a provider
 * that expects a string rejects the NEXT request with `missing type field in content item at
 * index 0` — so a teammate's first `SendMessage` worked and then the conversation died, one
 * message in. The symptom was a team that says hello and then never answers again.
 *
 * Returns `null` for the one shape that must stay an OBJECT: `ReadMediaFile` returns
 * `{ text, media: [...] }`, and the media parts travel as structured blocks the caller builds
 * from the object. Stringifying that would attach no image at all, so the caller keeps it.
 *
 * Normalised here, at the single point every tool result passes through, rather than in the
 * team tools: a second tool family making the same choice cannot reintroduce the bug.
 */
/**
 * Settle `promise`, or reject as soon as `signal` aborts — whichever happens first.
 *
 * A tool is GIVEN the abort signal but cannot be forced to observe it. Built-ins do (Bash kills its
 * process tree); a plugin tool that ignores it kept running, and the caller's `await` kept waiting, so
 * pressing Esc during a slow plugin tool changed nothing on screen until the plugin finished on its own.
 *
 * Racing ends the WAIT regardless. The abandoned promise is left to settle detached — an unobserved
 * rejection would otherwise surface as an unhandled rejection — and the turn moves on, which is what
 * the key was asking for. It cannot stop the plugin's work, and this comment says so rather than
 * implying otherwise.
 */
function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
    // A tool that resolves AFTER the abort must not become an unhandled rejection.
    Promise.resolve(promise).catch(() => {});
  });
}

function toolResultText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    // Leave a media result alone — the caller needs the parts, not a sentence about them.
    if (Array.isArray(value.media)) return null;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.error === 'string') return value.error;
    if (typeof value.text === 'string') return value.text;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}



export const SYSTEM_PROMPT = `You are hncode, a coding agent in the user's terminal on ${process.platform}.
You work inside a workspace directory using the tools provided.

Tools:
- Read a file before editing it; never guess contents or edit code you haven't read.
- Prefer Edit over Write for existing files.
- If a tool fails, read the error and fix your approach. After 2 failed attempts on the same goal, stop and report the blocker.
- Independent tool calls may run in parallel; never parallelize dependent ones.

- Put ALL of your internal reasoning inside <|thinking|>...<|/thinking|> tags, and always emit BOTH the
  opening and the closing tag. Do not omit the tags, do not abbreviate them, and do not leave the block
  unclosed.
- Everything outside <|thinking|>...<|/thinking|> is what the user reads: keep it to the answer itself —
  what you did and what you found. Never repeat or summarise your reasoning there.
- Keep the tags exactly as written: <|thinking|> and <|/thinking|>. Do not emit any other variant. The
  bars matter: a plain <think> is ordinary text that may appear in code or prose, and a bare
  "thinking" is a word this very instruction uses.
Acting:
- Unless the user is explicitly asking for a plan, asking a question about the code, or brainstorming,
  assume they want the work DONE. Say less and do more: implement the change rather than describing it.
- Carry the task through implementation and verification in this turn. Do not stop at analysis, at a
  partial fix, or at a list of things you would do next.
- New project, no prior context: be ambitious, use your judgement on structure.
  Existing codebase: be surgical. Touch only what the task needs — no renames, no reorganising,
  no drive-by fixes.
- Read the neighbours before you write: match the naming, error handling and comment density you see.
- Do not re-read a file after editing it, and do not re-run a search you already have results for.
  A successful edit tool call already proves it worked.

Scope:
- Do only what was asked. Do not refactor or "improve" unrelated code.
- Do not fix unrelated bugs or broken tests — mention them instead; they are not yours to change.
- If the request is ambiguous, ask one short clarifying question.
- State any assumption you make.
- Might be a dirty git worktree. Never revert changes you did not make. Never run a destructive command
  (git reset --hard, git checkout --) unless the user asked for it. If you notice an unexpected change
  you did not make, stop and ask.

Verifying:
- Run the narrowest check that exercises your change first, then widen.
- In auto/yolo mode, run tests and lint yourself without asking.
- In ask mode, do not burn the user's time on slow test suites mid-task: say what you would run and
  let them confirm.
- Do not add tests to a codebase that has none. Do not add a formatter that the project did not configure.
- If you could not verify something, say so plainly. Do not imply a test passed when you did not run it.

Finishing:
- Never stop silently after a tool call; end every turn with a written answer in the user's language.
- Report briefly: what changed, and how you verified it. If something failed, say what you tried and what you need.
- Never claim success without evidence. Cite file:line for referenced code.
- Be concise. No filler, no restating the request or explaining tool output that already spoke for itself.
- If context is running low, call /compact to shrink history.
`;

/** Plain text of a structured tool result, for the model and the transcript. */
function mediaResultText(r) {
  if (!r || typeof r !== 'object') return String(r == null ? '' : r);
  return String(r.text == null ? '' : r.text);
}

export class Agent {
  constructor({ cfg, messages, onEvent, maxSteps = 0, onToolStart, canInterrupt = () => false, onApproval }) {
    this.cfg = cfg;
    this.messages = messages;
    this.onEvent = onEvent;
    this.maxSteps = maxSteps;
    this.onToolStart = onToolStart; // (name, args) => void (for headless/TTY overlays)
    // Ensure the LLM client knows the bare tool specs (the client wraps them per-protocol).
    // A toolFilter (array of tool names) limits which tools are exposed — used
    // by Plan mode (read-only subset) and Focus mode (minimal subset first).
    // `cfg.noDelegation` marks this as a SUBAGENT: delegation tools are removed
    // even if the filter would have allowed them. The catalog already excludes
    // them from every profile; this is the hard backstop that also covers the
    // `null` (= everything) case, so a subagent can never spawn another agent.
const filtered = (Array.isArray(cfg.toolFilter) && cfg.toolFilter.length
      ? combinedTools().filter((t) => cfg.toolFilter.includes(t.name))
      : combinedTools()
    )
      .filter((t) => !(cfg.noDelegation && DELEGATION_TOOLS.includes(t.name)))
      // AgentSwarm is gated behind swarm mode, like Agent is gated behind the user
      // having asked for delegation. It is not enough to describe the mode in the
      // system prompt: the tool was offered on EVERY turn, so the model could fan a
      // task out to 128 subagents in a session where the user never opted in — and
      // the prompt's own rule ("never call this on your own initiative") was not
      // backed by anything. Off unless /swarm turned the mode on; the Agent tool
      // stays available for a single, deliberate delegation.
      .filter((t) => !(t.name === 'AgentSwarm' && !cfg.swarm));
    // Kept as the process-wide FALLBACK for LLM instances that never register
    // their own list (doctor's connectivity probe). Every real agent registers
    // its list on its own LLM below — requests no longer read whichever Agent
    // happened to be constructed last.
    setToolsList(filtered);
    // THE REAL COST OF THE TOOLS, measured once per agent.
    //
    // The context gauge charged a flat 8 tokens per tool, which is short by an order of magnitude — the
    // schemas of these 68 tools come to about 15 900 tokens. That figure was missing from every
    // usage estimate, so the app's own count ran tens of thousands below the provider's.
    //
    // Measured here because this is the only place that knows the FINAL set: `toolFilter`, the
    // subagent block and the swarm gate above all change what is sent, and a number derived from
    // `cfg.toolFilter` alone would price tools the model never sees.
    this.toolDefTokens = measureToolDefTokens(filtered);
    // ALSO on `cfg`, because the TUI's gauge writers live outside this object and price a request as
    // `estimateMessagesTokens(...) + cfg.toolDefTokens`. Without this line those readers saw `undefined`
    // and silently fell back to zero, so every restore and every /trim reported a number short by the
    // whole tool block — the same fixed gap, from a different cause.
    if (this.cfg && typeof this.cfg === 'object') this.cfg.toolDefTokens = this.toolDefTokens;
    // A block for the direct-call path too: the model can still emit a tool call
    // for a tool that is not exposed, so refuse it here rather than at execution.
    this.noDelegation = !!cfg.noDelegation;
    // Mirrors the filter above for the direct-call path — a tool the model was told
    // about on an earlier turn can still be emitted after /swarm goes off.
    this.swarmMode = !!cfg.swarm;
    // AbortSignal handed to every tool so a long-running one (Bash) is killed
    // when the user presses Esc / Ctrl-C — otherwise the command keeps running
    // after the turn was interrupted.
    this.toolAbort = new AbortController();
    // Reuse an incoming task store when the caller provides one. Background
    // tasks OUTLIVE the turn that started them (their process is detached), so a
    // fresh `{}` per Agent made them vanish from the UI on the next turn while
    // still running. The TUI passes its persistent `state.tasks` through cfg.
    this.ctx = { ...cfg, tasks: cfg.tasks || {}, todoState: Array.isArray(cfg.todoState) ? cfg.todoState.slice() : [], allowExternal: !!cfg.allowExternal, signal: this.toolAbort.signal };
    // Live output stream for a RUNNING tool (Bash): the tool calls this with raw
    // chunks and the agent tags them with the id of the tool call in flight, so
    // the TUI can append them to the matching "Using …" row while it runs.
    this._currentToolId = null;
    this.ctx.onOutput = (chunk) => {
      if (chunk && this._currentToolId) this.onEvent({ type: 'tool_output', id: this._currentToolId, chunk });
    };
    // The Read snapshot pool lives ON THE AGENT, not on a per-turn ctx. It records
    // what the model has read (and the hashes at that moment) so a later Edit can
    // refuse to act on a stale snippet. /undo rewinds files on disk, i.e. it makes
    // those hashes describe content that is no longer there — the TUI clears this
    // pool right after a rewind so the next Edit is not rejected as stale.
    this.readPool = new Map();
    this.ctx.readPool = this.readPool;
    // `fork` (the Agent tool) snapshots THIS conversation into the subagent. The
    // tool reads `ctx._parentMessages`. This must be a GETTER, not the array
    // itself: auto-compaction REPLACES `this.messages` with a trimmed history, so
    // a retained reference kept pointing at the pre-compaction array — a fork
    // after a compaction would hand the subagent exactly the oversized history
    // that was just cut, and could push it straight past its own window.
    Object.defineProperty(this.ctx, '_parentMessages', {
      get: () => this.messages,
      enumerable: true,
      configurable: true,
    });
    // Prompt-cache key: identify the SESSION, not the request, so the cached
    // prefix is reused across turns instead of thrashing. The caller may pass one
    // (the TUI knows the session id); otherwise derive a stable value from the
    // first user message so repeated runs of the same conversation still share a
    // prefix. A subagent inherits the parent's key (same conversation family).
    if (cfg.sessionId == null) {
      const firstUser = (Array.isArray(messages) ? messages : []).find((m) => m.role === 'user' && typeof m.content === 'string');
      cfg = { ...cfg, sessionId: firstUser ? hashKey(firstUser.content) : 'default' };
      this.cfg = cfg;
    }
    this.llm = new LLM(cfg);
    // THIS agent's tool defs ride on THIS instance. The module-global was overwritten
    // by every `new Agent()` in the process — a subagent, swarm member or teammate
    // constructed while a parent request was being built swapped the parent's tool
    // list mid-turn, silently stripping Edit/Bash from its next request.
    this.llm.setTools(filtered);
    this.stopRequested = false;
    // Auto-compaction is allowed at most once per TURN (not per step). Reset here so
    // a caller that reuses one Agent across turns still gets a fresh allowance.
    this._compactedThisTurn = false;
    // THE PROMPT-CACHE BOUNDARY: how many messages an earlier request of this turn
    // has already sent. Everything below that index is stable and can carry a cache
    // breakpoint. Reset per turn because a new turn opens with a new user message, so
    // the previous turn's boundary would describe a prefix this one never sent.
    this._stableEnd = 0;
    // Rolling context-token total for `this.messages` (see usedTokens). It holds no
    // messages of its own, only the count of what it has already priced, so a
    // compaction that replaces the array simply falls out of the fast path.
    this._ledger = new TokenLedger();
    this.onApproval = onApproval; // async (toolName, args) => boolean
    // Shell hooks (Claude Code-style): user-configured commands run at lifecycle
    // events. ALWAYS stored as a `{ hooks: {Event: [...]} }` config, which is the
    // shape runShellHooks() reads. A caller may inject one (tests / the TUI,
    // which reloads per turn); otherwise it is read from disk for this workspace.
    this.hookConfig = cfg.hookConfig
      ? (cfg.hookConfig.hooks ? cfg.hookConfig : { hooks: cfg.hookConfig })
      : { hooks: loadHooks(cfg.workspace).hooks };
    // The turn's user prompt, for the UserPromptSubmit hook. Set by run().
    this._turnPrompt = '';
    // Messages the user types while the agent is streaming. They are injected
    // as user messages right AFTER the current round of tool calls, so the
    // model sees "tool callback / user steer" together on the next request —
    // exactly like kimi-code's steer (no separate turn feel).
    this.steerQueue = [];
  }

  // Queue a steering message typed while streaming. It takes effect once the
  // in-flight tool calls finish and the loop asks the model again.
  steer(text) {
    if (text && text.trim()) this.steerQueue.push(String(text).trim());
  }
  // True when a steer is pending injection.
  get hasSteer() { return this.steerQueue.length > 0; }

  interrupt() {
    this.stopRequested = true;
    try { this.toolAbort.abort(); } catch {}
    if (this.llm) this.llm.abort();
    // The compaction summarizer is a SEPARATE LLM instance; abort it too, or an
    // auto-compaction in flight cannot be interrupted (Esc did nothing until the
    // summary request finished on its own).
    if (this._summaryLlm) { try { this._summaryLlm.abort(); } catch {} }
  }

  // What the NEXT request will carry: the messages (which already begin with the
  // assembled system prompt — see the TUI's runAgent) plus the tool-definition
  // overhead. It must NOT add `cfg.systemPrompt` on top: that value is the RAW
  // config string, not the assembled prompt (calm/plan/swarm/AGENTS.md are appended
  // later), so counting it both double-counted the system text and measured the
  // wrong figure — while being the only input that decides whether to compact.
  usedTokens() {
    // A rolling total rather than a fresh walk of the whole history. This is called at
    // least three times per model round (before the request, after compaction, after a
    // trim) and once more per step for the gauge, so on a long session the old full
    // rescan priced the entire transcript — Read results included — several times per
    // step for a number that changes by one message.
    let total = this._ledger.sync(this.messages, null);
    // THE TOOL DEFINITIONS ARE PART OF WHAT IS SENT, and they are not messages.
    //
    // This charged `toolFilter.length * 8` — and only when a filter was set, so an ordinary turn
    // added NOTHING at all. Measured, the schemas of the 68 registered tools come to about 15 900
    // tokens, which is why the app's own gauge ran tens of thousands below the provider's report.
    //
    // `toolDefTokens` is measured once in the constructor, from the FINAL filtered set.
    total += Number.isFinite(this.toolDefTokens) ? this.toolDefTokens : 0;
    return total;
  }



  // Where to cut the history for compaction. Walks back from the end accumulating a
  // token budget, but only accepts indices the boundary rule allows (so the kept
  // slice can never begin on an orphan tool result). Returns how many messages to
  // DROP. Mirrors kimi's computeCompactCount + canSplitAfter.
  computeCompactSplit(maxCtx) {
    // Keep a fraction of the CURRENT usage, not of the whole window: a big window
    // (1M) should not force a huge tail to be kept when only a little was used.
    // Ratio is configurable (/auto-compact keep, config.toml compact_keep_ratio),
    // default 0.2.
    const keepRatio = (typeof this.cfg.compactKeepRatio === 'number'
      && this.cfg.compactKeepRatio > 0 && this.cfg.compactKeepRatio < 1)
      ? this.cfg.compactKeepRatio : 0.2;
    const used = this.usedTokens();
    const maxSize = Math.max(1, Math.floor((used || (maxCtx || 512000) * 0.85) * keepRatio));
    const msgs = this.messages || [];
    // How far the LEADING system block runs. A cut before `floor` would land inside it,
    // splitting the assembled system prompt across the drop boundary. The block itself is
    // carried over by the trim (renamed `leadingSystem` there), because a cut can only
    // ever land at or after its end.
    let floor = 0;
    while (floor < msgs.length && msgs[floor] && msgs[floor].role === 'system') floor++;
    let recent = 1;
    let size = 0;
    let bestSplit;
    for (; recent < msgs.length; recent++) {
      const split = msgs.length - recent;
      // `messageTokens(m)`, not `estimateMessagesTokens([m])`: the latter allocated a
      // throwaway single-element array for every message in the transcript, on every
      // call. It is also the memoised form, so repeating this walk after a large tool
      // result is a WeakMap hit rather than a re-measure.
      size += messageTokens(msgs[split], null);
      // The guard the leading system block needs, and the reverse of the `split > floor`
      // this used to test. A cut at `split` drops `[0..split-1]`, so `split >= floor`
      // keeps the cut at or after the block's end and never inside it — which is what
      // the block's comment above asks for, and what `split > floor` inverted.
      if (split >= floor && canSplitAfter(msgs, split - 1)) bestSplit = split;
      if (size >= maxSize && bestSplit !== undefined) break;
    }
    return bestSplit ?? 0;
  }

  /**
   * Trim the history at a legal cut and append the summary + continuation note.
   *
   * Extracted from `run()` so it can be tested against the REAL implementation. A test that
   * re-implemented these four lines was green against a duplicated system prompt — the copy
   * carried its own guard, which is the failure mode of testing a restatement.
   *
   * Returns `{ split, dropped }`.
   *
   * Shape: `[ ...lead, ...kept, summary, continuation ]`.
   *
   * The summary is a USER message wrapped in a `<system-reminder>` (kimi's shape), not a
   * `system` one. Two reasons:
   *   * the TUI rebuilds the system prompt from scratch each turn and SKIPS every `system`
   *     entry in the stored history, so a system summary was dropped before the model saw it;
   *   * the turn-end save filters `system` out of the session, so it was not persisted either
   *     — history trimmed AND summary lost at both ends, which made "compaction" pure data loss.
   * The continuation note goes LAST so the model's next move is "keep going" rather than
   * "answer the summary".
   */
  applyCompactionSplit(maxCtx, summary) {
    const split = this.computeCompactSplit(maxCtx);
    const keep = this.messages.slice(split);
    const dropped = this.messages.length - keep.length;
    // The LEADING system block is carried over explicitly. It sits at the head of the array
    // and the cut drops everything before `split`, so it would otherwise be taken by every
    // compaction — leaving the request with no instructions, which is the loss the `floor`
    // guard in computeCompactSplit exists to prevent.
    let leadingSystem = 0;
    while (leadingSystem < this.messages.length
      && this.messages[leadingSystem] && this.messages[leadingSystem].role === 'system') leadingSystem++;
    // Only what the cut actually REMOVED. `keep` is `slice(split)`, so at `split === 0` it
    // still contains the whole array including the block — prepending the block then sends the
    // system prompt twice, and `llm.js` concatenates every system message into the request, so
    // it would stay doubled in every compacted request from then on.
    const lead = split > 0 ? this.messages.slice(0, leadingSystem) : [];
    const summaryText = summary
      ? `${COMPACTION_SUMMARY_PREFIX}\n${summary}`
      : `${COMPACTION_SUMMARY_PREFIX}\n(no summary available)`;
    this.messages = [
      ...lead,
      ...keep,
      { role: 'user', _harness: true, content: wrapSystemReminder(summaryText) },
      { role: 'user', _harness: true, content: wrapSystemReminder(COMPACTION_CONTINUATION_TEXT) },
    ];
    // `kept` is returned, not just its length: the caller reports how many messages survived, and it
    // has no other way to know. It was `keep.length` at the call site referring to a local that lives
    // only in here — a ReferenceError raised inside `run()`, which reached unhandledRejection and exited
    // the whole TUI at the moment compaction fired.
    return { split, dropped, kept: keep.length };
  }

  async run() {
    // Clear any interrupt flag left from a previous (interrupted) turn. This runs at
    // the start of EVERY turn, so a stalled Esc/Ctrl-C from an earlier compaction can
    // never suppress auto-compaction on the next message. (The constructor also
    // initializes it, but a caller that reuses one Agent across turns must get a
    // fresh allowance here — without this, the live block would blink again with no
    // compaction behind it.)
    this.stopRequested = false;
    this._compactedThisTurn = false;
    // Plugin lifecycle: `onTurnStart` fires here and `onTurnEnd` in the finally
    // block at the end of this method. Both are awaited and both swallow plugin
    // errors (see runHooks), so a broken plugin cannot abort a turn.
    await runHooks('onTurnStart', { messages: this.messages });
    // SHELL HOOK: SessionStart fires once per agent run (the first turn of a
    // session). A hook failure never blocks — it is a convenience signal.
    await runShellHooks(this.hookConfig, 'SessionStart', { messages: this.messages }, this.cfg.workspace);
    // SHELL HOOK: UserPromptSubmit fires with the latest user message. It cannot
    // block (Claude Code's can add context; blocking the user's own prompt is a
    // worse failure than a missing hook), so the result is only logged.
    {
      const lastUser = [...this.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
      if (lastUser) {
        this._turnPrompt = lastUser.content;
        await runShellHooks(this.hookConfig, 'UserPromptSubmit', { prompt: lastUser.content }, this.cfg.workspace);
      }
    }
    let text = '';
    let toolCalls = [];
    let emittedEnd = false;
    let thought = '';
    // decide whether running out of steps actually left the turn unfinished.
    let hadToolCallsOnFinalStep = false;
    // How many times this turn has continued an answer the output cap cut in half.
    // Bounded so a model that cannot fit its answer in the budget cannot loop.
    let truncationRecoveries = 0;
    const MAX_TRUNCATION_RECOVERIES = 3;

    const handle = async (e) => {
      switch (e.type) {
        case 'data':
          text += e.text;
          this.onEvent({ type: 'data', text: e.text });
          break;
        case 'think':
          // Reasoning tokens: forward verbatim so the TUI can render a live
          // "thinking…" block. They are NOT part of the assistant message.
          thought += e.text;
          this.onEvent({ type: 'think', text: e.text });
          break;
        case 'truncated':
          // The reply hit max_tokens and was cut off mid-answer. Remember it: the
          // loop below continues the turn instead of ending it (see the `truncated`
          // branch), so a half-written answer is never presented as a finished one.
          this._truncated = true;
          break;
        case 'usage':
          // Provider accounting, accumulated on the AGENT so it survives across the steps of one turn.
          //
          // IT DOES NOT FEED THE CONTEXT GAUGE. `usage.input` was wired into both the gauge and a
          // calibration here, and removed from both: it counts the request that already went out while the
          // estimate counts the one about to, so the number jumped between two definitions depending on
          // which ran last.
          //
          // What it IS used for: cost and `/usage`, where it is the only honest source, and the turn's
          // output counter.
          this.usage = addUsage(this.usage, e.usage);
          // THE REAL SIZE OF THE REQUEST THAT JUST WENT OUT.
          //
          // `usage.input` is what the endpoint actually billed for this request, which is the honest answer
          // to "how full is the context". The compaction threshold reads it (see `usedNow` below) instead of
          // the local estimate, which runs low because it cannot model the provider's framing. `input`
          // INCLUDES the reply's own prompt but not the reply, which is exactly the figure to compare against
          // the limit.
          if (e.usage && Number.isFinite(e.usage.input) && e.usage.input > 0) {
            this.ctxReportedTokens = e.usage.input;
          }
          this.onEvent({ type: 'usage', usage: e.usage, total: this.usage });
          break;
        case 'tool_start':
          toolCalls.push({ id: e.id, name: e.name, args: {}, argsJson: '' });
          this.onEvent({ type: 'tool_start', id: e.id, name: e.name });
          break;
        case 'tool_args': {
          const tc = toolCalls.find((t) => t.id === e.id);
          if (tc) { tc.argsJson += e.chunk; }
          // Forward the raw argument chunk so the TUI can stream a Write's
          // content (or an Edit's old/new text) while the model is emitting it.
          this.onEvent({ type: 'tool_args', id: e.id, chunk: e.chunk });
          break;
        }
        case 'tool_end': {
          const tc = toolCalls.find((t) => t.id === e.id);
          if (tc) {
            try { tc.args = tc.argsJson ? JSON.parse(tc.argsJson) : {}; }
            catch {
              // The streamed arguments did not form complete JSON. The usual cause
              // is truncation (a huge `content`, a long command) or an interrupted
              // stream. The `raw` shape is kept so a tool can SEE that its
              // arguments failed to parse and say so, instead of reporting a
              // missing field; `_rawLen` lets that message state how big the
              // partial payload was, which is what tells the model to split it.
              tc.args = { raw: tc.argsJson, _rawLen: tc.argsJson ? tc.argsJson.length : 0 };
            }
          }
          break;
        }
        case 'end':
          emittedEnd = true;
          break;
        case 'aborted':
          // The request was aborted (Esc / Ctrl-C): surface it and stop the loop.
          this.stopRequested = true;
          this.onEvent({ type: 'aborted' });
          break;
        case 'error':
          this.onEvent({ type: 'error', error: e.error });
          break;
      }
    };

    // No step cap: the loop runs until the model produces a final answer, the
    // user interrupts (Esc / Ctrl-C), or an error ends the turn. maxSteps is
    // kept only for callers that explicitly request a bound (0/undefined = none).
    const stepLimit = (this.maxSteps > 0) ? this.maxSteps : Infinity;
    for (let step = 0; step < stepLimit; step++) {
      // Process any steer messages collected during the previous step
      if (this.steerQueue.length > 0) {
        const steers = this.steerQueue.splice(0);
        for (const text of steers) {
          this.messages.push({ role: 'user', content: text });
          this.onEvent({ type: 'steer', text });
        }
      }
      if (this.stopRequested) { this.onEvent({ type: 'stopped' }); break; }
      text = ''; toolCalls = []; emittedEnd = false; thought = '';
      this._truncated = false;
      // Report the start of each model round so the TUI can count steps/rounds.
      this.onEvent({ type: 'step_start', step, round: step + 1 });
      // ---- auto-compaction (kimi's runtime strategy) ----
      // Before each model call, if the estimated context usage is at or above
      // 85% of the model's max context, summarize the older portion and keep a
      // small recent tail. Mirrors kimi's triggerRatio=0.85 /
      // maxRecentSizeRatio=0.2 policy, plus its `reservedContextSize` rule: a
      // request that leaves less than the reserved headroom is compacted even
      // below 85%, so the reply has room to be generated.
      const maxCtx = this.cfg.maxContextTokens || 512000;
      // THE PROVIDER'S OWN COUNT WINS WHEN THERE IS ONE.
      //
      // `usedTokens()` is a local estimate from the token ledger. The endpoint reports the real size with
      // every reply, and that figure is what the status bar shows — but this decision used the estimate
      // regardless, so a session the gauge put at 88% could stay under an 85% trigger indefinitely: the
      // estimate runs low because it cannot model the provider's own message framing and tool preamble.
      // Two numbers for the same thing is the bug; the reported one is the one that is true.
      let usedNow = this.usedTokens();
      const reported = Number(this.ctxReportedTokens);
      if (Number.isFinite(reported) && reported > 0) usedNow = reported;
      // THE MESSAGE THAT TRIGGERED THIS TURN IS NOT YET IN A REQUEST.
      //
      // The user's message is appended before `run()` is entered, so a fresh turn that pushes the
      // history over the threshold would compact FIRST and then send — summarising a conversation that
      // now includes the message it is about to answer, and paying a summary round-trip before the model
      // has seen the request at all.
      //
      // Excluding the trailing user message from the TRIGGER means the decision is made on what the
      // previous turn left behind, which is the history the message is joining. If adding it would still
      // overflow, `needsRoom` catches that on the NEXT pass — after the model has answered something —
      // and `clipToTokens` bounds the request itself in the meantime.
      //
      // Counted as a subtraction rather than by pruning the array: the message must stay in `messages`,
      // it just must not decide whether to compact.
      let triggerTokens = usedNow;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (!m) continue;
        // Only skip a TRAILING run of user messages — a steering note queued mid-turn, or the prompt that
        // opened this turn. A user message further back is part of the history being measured.
        if (m.role !== 'user' || m._harness) break;
        triggerTokens -= messageTokens(m, this.cfg);
      }
      triggerTokens = Math.max(0, triggerTokens);
      // `reservedContextSize` (kimi): a request leaving less than this much headroom
      // is compacted even below the trigger ratio, so the REPLY has room to be
      // generated. A request just under the trigger could otherwise still fail.
      //
      // Measured on `usedNow`, NOT on `triggerTokens`: the headroom question is about the request that
      // will actually be sent, and that one does include the new message. The two thresholds ask
      // different things — "is the history full" versus "will this request fit" — so they read different
      // numbers on purpose.
      const reserved = this.cfg.reservedContextTokens || 50_000;
      const needsRoom = reserved > 0 && reserved < maxCtx && usedNow + reserved >= maxCtx;
      // Trigger ratio is configurable (/auto-compact threshold, config.toml
      // compact_threshold); default 0.85.
      const trigger = (typeof this.cfg.compactThreshold === 'number' && this.cfg.compactThreshold > 0
        && this.cfg.compactThreshold < 1) ? this.cfg.compactThreshold : 0.85;
      // At most ONCE per turn. This used to run inside the step loop with no counter,
      // so a trim that failed to get under the threshold triggered again on the very
      // next step — paying for another summary round-trip each step while the history
      // kept shrinking.
      const shouldCompact = this.cfg.autoCompact !== false && maxCtx > 0
        && !this._compactedThisTurn
        // `triggerTokens`, not `usedNow`: the history WITHOUT the message that opened this turn.
        && (triggerTokens >= maxCtx * trigger || needsRoom);
      if (shouldCompact) {
        const before = usedNow;
        this._compactedThisTurn = true;
        // SHELL HOOK: PreCompact — a chance to back up the transcript before the
        // older half is summarized away. Never blocks (the trim must go ahead).
        await runShellHooks(this.hookConfig, 'PreCompact',
          { tokens: usedNow, messages: this.messages }, this.cfg.workspace);
        // Tell the TUI the trim is under way. Summarizing is a full model
        // round-trip, so without this the UI sat silent for seconds mid-turn
        // with no sign anything was happening.
        this.onEvent({ type: 'compacting', before: usedNow, keep: 0, dropped: 0 });
        //
        // SUMMARIZE BEFORE TRIMMING. The summary is generated from the FULL history,
        // so the summarizing model can see what just happened — the most recent
        // exchange is what tells it what the session is doing now. Trimming first
        // summarized only the OLD part and lost what the summary needed most.
        //
        // The transcript fed to the summarizer is bounded by TOKENS, not characters.
        // A character cap is not a size cap: 120k Chinese characters is roughly 120k
        // tokens, which alone can exceed the window and make the call FAIL — after
        // which the history was discarded with no summary at all. That is the normal
        // case for a Chinese conversation, not an edge case.
        const summaryBudget = Math.max(1, Math.floor(maxCtx * 0.3));
        const perMsgTokens = 4_000;
        const summaryParts = [];
        let summaryTokens = 0;
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const m = this.messages[i];
          let raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          if (estimateTokens(raw) > perMsgTokens) raw = clipToTokens(raw, perMsgTokens);
          const line = `${m.role}: ${raw}`;
          const t = estimateTokens(line);
          if (summaryTokens + t > summaryBudget) break;
          summaryTokens += t;
          summaryParts.unshift(line);
        }
        let summary = '';
        if (this.messages.length > 0) {
          const summaryPrompt = [
            { role: 'system', content: COMPACTION_INSTRUCTION },
            { role: 'user', content: summaryParts.join('\n\n') },
          ];
          const cfgCopy = { ...this.cfg, maxOutputTokens: Math.min(this.cfg.maxOutputTokens || 4096, 4096) };
          const llm = new LLM(cfgCopy);
          // Remember this throwaway summarizer so Esc / Ctrl-C can abort IT too.
          // It is NOT `this.llm`, so `interrupt()` could not reach it — a running
          // auto-compaction was uninterruptible, which felt like a hang.
          this._summaryLlm = llm;
          // Thinking OFF and no tools, matching Claude Code's summarizer
          // (`thinkingConfig: { type: 'disabled' }`). Summarizing is a straight
          // transcription task: reasoning tokens buy nothing here, and on a
          // reasoning model they can consume the whole output budget — which
          // returns an EMPTY summary, and an empty summary is what turns a
          // compaction into a silent loss of history.
          try {
            // A DECLARATION IS NEEDED FOR THE REFUSAL.
            //
            // `tool_choice: 'none'` is rejected by both providers unless a tool list accompanies it, and the
            // summariser is a fresh instance with none. One inert definition is declared so the refusal can be
            // expressed: the model then cannot produce a tool call, rather than being asked not to.
            llm._tools = [{
              name: 'noop',
              description: 'Takes no action. Present only so the request can refuse tool use.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            }];
            const raw = await llm.requestText(summaryPrompt, { noReasoning: true, toolChoice: 'none' });
            summary = stripToolCallText(raw);
          } catch { summary = ''; }
          this._summaryLlm = null;
        }
        // Interrupted mid-summary: do NOT trim. Aborting yields an empty summary, and
        // proceeding would drop history with nothing to replace it — data loss. Mark
        // the compaction block cancelled and bail out of the turn.
        if (this.stopRequested) {
          this.onEvent({ type: 'compaction_cancelled' });
          this.onEvent({ type: 'stopped' });
          break;
        }
        // The summarizer FAILED (requestText swallowed a network/429 error — even
        // after its retry — and returned null) or came back capped-empty. Trimming
        // now would replace real history with "(no summary available)": the exact
        // silent data loss the comment above warns about. Leave the history intact
        // and let the turn continue un-compacted; if the fat request genuinely
        // cannot fit, the provider's context-length error is an honest, recoverable
        // failure instead of a vanished transcript.
        if (!summary && this.messages.length > 0) {
          this.onEvent({ type: 'compaction_cancelled', reason: 'the summary request failed, so nothing was trimmed' });
        } else {
        // NOW trim, at a split point the boundary rule allows.
        const { split, dropped: droppedCount, kept } = this.applyCompactionSplit(maxCtx, summary);
        // The array was REPLACED, so every count the ledger held describes messages
        // that no longer exist. `sync` would notice on its own (the first/last
        // identities no longer match), but resetting here states the intent at the
        // point of mutation instead of relying on that check to fire.
        this._ledger.reset();
        usedNow = this.usedTokens();
        // THE REPORT DESCRIBES THE REQUEST THAT WENT OUT, so after a trim it still describes the OLD one.
        // Drop it: the next turn falls back to the local estimate until the provider reports again, instead of
        // reading a stale figure and compacting a history that was just compacted.
        this.ctxReportedTokens = 0;
        this.onEvent({
          type: 'compacted', before, after: usedNow, kept,
          dropped: droppedCount, summary,
        });
        // SHELL HOOK: PostCompact. Fires after the trim, so a hook can archive the
        // summary or record the shrink. Never blocks.
        await runShellHooks(this.hookConfig, 'PostCompact',
          { before, after: usedNow, kept, dropped: droppedCount, summary }, this.cfg.workspace);
        }
      }
      // ---- tool-result trimming ----
      // The cheap pass, and the one that actually runs in practice: a history is
      // usually LARGE because of old tool output nobody is reading, not because the
      // conversation is long. Bodies are replaced by a short pointer — the message
      // list keeps its exact length and roles, so the assistant/tool pairing and the
      // cached prefix shape are untouched — and the removed text is copied to disk
      // first, so it stays recoverable.
      //
      // Trigger: the request reached `trimThreshold` (50% by default) of the window.
      // Target: keep `trimKeepRatio` (30% by default) of the tool-result TEXT, newest
      // first. A different denominator from the trigger on purpose: the trigger asks
      // about the window, this asks about the removable output. Skipped while a
      // compaction just ran (that already shrank
      // things) and above the compaction trigger (compaction is the right tool by
      // then, and the two must not fight over the same history).
      const trimThreshold = Number.isFinite(this.cfg.trimThreshold) ? this.cfg.trimThreshold : DEFAULT_TRIM_THRESHOLD;
      if (this.cfg.autoTrim !== false && toolResultLimitsEnabled()
          && !this._compactedThisTurn && maxCtx > 0
          && usedNow >= maxCtx * trimThreshold && usedNow < maxCtx * (this.cfg.compactThreshold || 0.85)) {
        const res = trimToolResults(this.messages, {
          sessionId: this.cfg.sessionId,
          keepRatio: Number.isFinite(this.cfg.trimKeepRatio) ? this.cfg.trimKeepRatio : DEFAULT_TRIM_KEEP_RATIO,
          // The model may still be reading the result it was handed last step.
          mustKeep: this._lastToolResultIndex,
        });
        if (res && res.elided > 0) {
          // `trimToolResults` rewrites message CONTENT IN PLACE, so the array is the
          // same one the ledger already counted and its identity check cannot see the
          // change. Without this reset the gauge would keep reporting the PRE-trim
          // total: the trim would look like it freed nothing, and the very next step
          // would compact a history that had already been trimmed.
          this._ledger.reset();
          const after = this.usedTokens();
          this.onEvent({
            type: 'results_trimmed', elided: res.elided, elidedBytes: res.elidedBytes,
            kept: res.kept, keptBytes: res.keptBytes, before: usedNow, after,
          });
          usedNow = after;
        }
      }
      // Live context gauge: report the estimated size of the request about to be
      // sent, so the TUI's context readout is refreshed at every step rather than
      // only once the whole turn ends.
      this.onEvent({ type: 'context', tokens: usedNow, max: maxCtx });

      // Inject any user steering messages typed during the previous step.
      // They are appended right after the last assistant/tool round so the
      // model sees "tool callback / user steer" on this next request.
      if (this.steerQueue.length > 0) {
        for (const steerText of this.steerQueue.splice(0)) {
          this.messages.push({ role: 'user', content: steerText });
          this.onEvent({ type: 'steer', text: steerText });
        }
      }

      // THE CACHE BOUNDARY: everything BEFORE this index was already sent in an
      // earlier request of this turn and has not changed since. It is captured
      // here — AFTER the previous step's tool results are committed, BEFORE the
      // steering drain appends anything new — so it marks exactly the prefix the
      // provider can reuse.
      //
      // This used to be derived from the message COUNT ("keep the last two"), which
      // is the wrong question. One agent step appends an assistant message plus one
      // tool result PER call, so a step that read four files left five fresh
      // messages; a breakpoint two back sat in the middle of that and the provider
      // had to re-prefill all of it. Counting the boundary from the previous
      // request instead means a step of any size leaves exactly one stable prefix.
      // A COMPACTION REPLACED THE ARRAY, so the boundary measured against the old
      // one no longer describes anything in this one. Clamping would place the
      // breakpoint at a message that never existed when the value was taken.
      if (this._stableEnd > this.messages.length) this._stableEnd = 0;
      if (this._stableEnd !== this.messages.length) this._stableEnd = this.messages.length;
      const cacheEnd = this._stableEnd - 1;


      // Plugin hooks around the model round-trip. `onBeforeRequest` sees the exact
      // message array being sent (and may mutate it); `onAfterResponse` fires once
      // the stream has been consumed.
      await runHooks('onBeforeRequest', this.messages, this.cfg);
      await this.llm.request(this.messages, handle, cacheEnd);
      await runHooks('onAfterRequest', this.messages, this.cfg);

      // An abort ends the turn: keep whatever text arrived, then stop.
      if (this.stopRequested) {
        if (text) this.messages.push({ role: 'assistant', content: text });
        break;
      }

      // Append the assistant message. NEVER push one that carries neither text
      // nor tool_calls: upstream rejects it with "content or tool_calls must be
      // set".
      const hasText = !!(text && text.trim());
      const hasCalls = toolCalls.length > 0;
      if (hasText || hasCalls) {
        const assistantMsg = {
          role: 'assistant',
          content: hasText ? text : null,
          toolCalls: hasCalls ? toolCalls : undefined,
        };
        // Mixin seam: llmResponse - plugins may rewrite the assistant text before it is saved.
        try { const out = await runPatch('llmResponse', { content: assistantMsg.content, toolCalls: assistantMsg.toolCalls }, (c) => c); if (out) { if (out.content !== undefined) assistantMsg.content = out.content; if (out.toolCalls !== undefined) assistantMsg.toolCalls = out.toolCalls; } } catch (e) { console.error('[hncode-plugin] llmResponse error:', e.message); }
        this.messages.push(assistantMsg);
        // Plugin hook: one per assistant message committed to the history. Fired
        // here (the single point where the model's reply lands) rather than at each
        // of the eleven `messages.push` sites, so a plugin sees a coherent message
        // instead of the intermediate bookkeeping pushes.
        await runHooks('onNewMessage', assistantMsg, this.messages);
      }

      // ---- if tool calls exist, execute them ----
      if (toolCalls.length > 0) {
        // Execute tools below
      } else if (this.steerQueue.length > 0) {
        const steers = this.steerQueue.splice(0);
        for (const msg of steers) this.messages.push({ role: 'user', content: msg });
        continue;
      } else if (this._truncated && truncationRecoveries < MAX_TRUNCATION_RECOVERIES) {
        if (!hasText) {
          // Truncated with NO text at all: every output token went into reasoning
          // (a reasoning model on a small budget). There is nothing to continue
          // from, and ending the turn here would look like the model simply had
          // nothing to say. Say what actually happened instead.
          this.onEvent({
            type: 'error',
            error: new Error(
              `The model reached its ${this.cfg.maxOutputTokens || 'configured'} output-token limit `
              + 'before producing any text — raise the output limit (HNCODE_MAX_OUTPUT) or lower the thinking effort.',
            ),
          });
          break;
        }
        // The answer was cut off by max_tokens: it is HALF an answer, and it is
        // already committed above with no tool calls. Ask the model to pick up
        // where it stopped instead of ending the turn — otherwise the user reads
        // a sentence that stops mid-word and assumes that was all of it.
        truncationRecoveries++;
        this.messages.push({
          role: 'user',
          // `_harness`: this is the harness talking, not the user. /undo and its
          // picker skip these, and beginTurn does not run for them, so the two
          // stay aligned on what a "prompt" is.
          _harness: true,
          content: 'Your previous message was cut off because it reached the output token limit. Continue from exactly where it stopped — do not repeat what you already wrote, and do not start over.',
        });
        this.onEvent({ type: 'truncation_recovery', attempt: truncationRecoveries });
        continue;
      } else if (!hasText) {
        // No tool calls and no answer text: the model stopped without saying
        // anything. End the turn.
        break;
      } else {
        // The model produced its answer. A steer typed WHILE that answer was
        // streaming still has to be delivered: drain it and take another step.
        // (Checking only at tool boundaries dropped it, because a final answer
        // has no tool boundary.)
        if (this.steerQueue.length > 0) {
          const steers = this.steerQueue.splice(0);
          for (const msg of steers) this.messages.push({ role: 'user', content: msg });
          continue;
        }
        break;
      }

      // execute tools
      let allOk = true;
      // Tool-subset enforcement: in Plan/Focus mode the model may still emit a
      // tool that is not exposed. Block it with a fixed message so the model
      // learns it must stick to the allowed subset.
      const modeName = Array.isArray(this.cfg.toolFilter)
        ? (this.cfg.toolFilter.includes('Bash') ? 'Focus' : 'Plan')
        : undefined;

      // Gate + execute + hooks for ONE call, with no message bookkeeping: the
      // caller posts the result separately, in call order. Splitting it this way
      // is what makes a parallel batch possible at all — concurrent calls finish
      // out of order, and tool results MUST be appended in the order the model
      // asked for them or the protocol pairing breaks.
      const prepareToolCall = async (tc) => {
        // Tag output produced by THIS tool call so onOutput can route it to the
        // right "Using …" row (a turn can run several tools in sequence).
        this._currentToolId = tc.id;

        // MODE GATING COMES FIRST, BEFORE THE APPROVAL PROMPT.
        //
        // A tool the current mode does not allow must be refused WITHOUT asking the user.
        // Asking first was the bug: in Plan mode the tool list is filtered to
        // ['Read','Grep','Glob'], so Bash is not offered — but the model can still emit a
        // call for a tool it saw on an earlier turn, and the approval prompt ran before
        // this check. The user was asked "run this shell command?" in a mode where the
        // answer is always no, and the prompt's own wording offered a choice that did not
        // exist. It also meant a stray call could be APPROVED, and only then refused, which
        // is the worst of both: a decision recorded for something that never ran.
        //
        // These three checks used to sit after the prompt. They all reject outright, so all
        // three belong here — before anything with a side effect, including the session
        // approval that a Ctrl+A on the prompt would have written.
        if (this.noDelegation && DELEGATION_TOOLS.includes(tc.name)) {
          const result = `You CAN'T use ${tc.name}: subagents cannot delegate. Do the work yourself and report the result to the agent that started you.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }
        // The list above does not expose AgentSwarm outside swarm mode, but the system
        // prompt describes only ONE shape for it — so refuse a stray call with the fix in
        // the message rather than letting 128 subagents run in a session where the user
        // never opted in.
        if (this.swarmMode !== true && tc.name === 'AgentSwarm') {
          const result = "You CAN'T use AgentSwarm: swarm mode is OFF. For one or two jobs use the Agent tool; for a real fan-out, ask the user to enable it with /swarm.";
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }
        if (modeName && !this.cfg.toolFilter.includes(tc.name)) {
          const result = `You CAN'T use this tool on ${modeName} Mode. Allowed: ${this.cfg.toolFilter.join(', ')}.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }

        // Permission check before executing each tool.
        //
        // The hook may answer with a BOOLEAN (the original contract) or with `{ approved, error }`. The
        // object form exists for the team mailbox, where a refusal travels with a reason the model can act
        // on: "Blocked by user" tells it nothing about what to try instead, and a member that has been
        // refused for a specific reason can re-plan.
        let result = null;
        let ok = true;
        if (this.onApproval) {
          const verdict = await this.onApproval(tc.name, tc.args);
          const approved = verdict && typeof verdict === 'object' ? verdict.approved : verdict;
          if (!approved) {
            const why = verdict && typeof verdict === 'object' && verdict.error ? `: ${verdict.error}` : '.';
            result = `Blocked by user: tool "${tc.name}" was rejected${why}`;
            this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
            return { ok: false, result, editDiff: null, media: false };
          }
        }


        const tool = getTool(tc.name);
        if (!tool) {
          result = `Error: unknown tool "${tc.name}".`;
          return { ok: false, result, editDiff: null, media: false };
        }

        // THE ARGUMENTS MUST MATCH THE TOOL'S OWN SCHEMA.
        //
        // An unknown parameter used to be accepted in silence, and the model had no way to learn that the
        // argument it took trouble to compute was thrown away: it sends `line_offset` to a tool that takes
        // `start_line`, gets a plausible answer computed from defaults, and concludes the tool is broken.
        // Refusing the call names the key and lists the accepted ones, which is the only thing that stops the
        // same mistake being retried with a different spelling.
        const argError = validateToolArgs(tc.args, tool.parameters);
        if (argError) {
          result = `Error: ${tc.name}: ${argError}`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }


        // SHELL HOOK: PreToolUse. A non-zero exit blocks the tool, and its
        // message goes back to the model in place of the tool result — that is
        // the whole point of a pre-hook (e.g. refuse a write that fails a lint
        // gate). Checked BEFORE approving/executing so a blocked call never
        // touches the filesystem.
        const pre = await runShellHooks(this.hookConfig, 'PreToolUse',
          { toolName: tc.name, toolArgs: tc.args }, this.ctx.cwd || this.cfg.workspace);
        if (pre.blocked) {
          result = `Blocked by a PreToolUse hook: ${pre.reason}`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }
        if (this.onToolStart) this.onToolStart(tc.name, tc.args);
        this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
        // Plugin hook: onToolExecute fires BEFORE the tool runs and receives the
        // mutable args object, so a plugin can inspect or adjust a call. Errors
        // are swallowed by runHooks — a broken plugin must not break a turn.
        await runHooks('onToolExecute', tc.name, tc.args, this.ctx);
        try {
          // Mixin seam: toolDispatch - plugins may intercept/modify tool calls before execution.
        let _args = tc.args; let _skip = false;
        try { const out = await runPatch('toolDispatch', { name: tc.name, args: tc.args, ctx: this.ctx }, (c) => c); if (out) { _args = out.args !== undefined ? out.args : tc.args; if (out.skip) _skip = true; } } catch (e) { console.error('[hncode-plugin] toolDispatch error:', e.message); }
        if (_skip) { result = '[skipped by plugin: ' + tc.name + ']'; ok = true; }
        else {
          // RACE THE ABORT SIGNAL, do not merely pass it.
          //
          // `ctx.signal` is handed to every tool, but nothing enforces that a tool LISTENS. A built-in
          // does — Bash kills its process tree — while a plugin tool that ignores it kept running, and
          // this `await` kept waiting for it: Esc reached `interrupt()`, aborted the controller, and the
          // row still said "Using …" until the plugin happened to finish.
          //
          // Aborting the signal now ends the wait immediately whatever the tool is doing. The abandoned
          // promise keeps running detached — a plugin that ignores the signal cannot be forced to stop —
          // but the TURN is no longer held by it, which is what pressing Esc actually asked for.
          const raw = await raceWithAbort(tool.execute(_args, this.ctx), this.toolAbort.signal);
          // `null` means the tool returned a structured MEDIA result: keep the object so the
          // image blocks can be built from it. Only a plain value is stringified.
          const text = toolResultText(raw);
          result = text === null ? raw : text;
        }
        } catch (err) {
          result = `Error running ${tc.name}: ${err.message}`;
          ok = false;
        }
        this.ctx.lastResult = result;
        // Plugin hook: onToolResult fires with the tool's output. A hook may return a
        // (redacted) replacement string — e.g. secret-guard masking keys in a Read
        // result — which is then what the model and transcript receive.
        const hookOut = await runHooks('onToolResult', tc.name, result, this.ctx);
        if (typeof hookOut === 'string') result = hookOut;
        // SHELL HOOK: PostToolUse. Never blocks (the tool already ran); a
        // failure is logged. This is where "format after every edit" lives.
        await runShellHooks(this.hookConfig, 'PostToolUse',
          { toolName: tc.name, toolArgs: tc.args, toolResult: result }, this.ctx.cwd || this.cfg.workspace);
        // SHELL HOOK: PostToolUseFailure. Fires only when the tool failed (an
        // `Error`/`[error:` result, or a thrown run), so a hook can alert or
        // retry without matching on every successful call.
        if (typeof result === 'string' && /^(Error\b|\[error:)/.test(result.trim())) {
          ok = false;
          await runShellHooks(this.hookConfig, 'PostToolUseFailure',
            { toolName: tc.name, toolArgs: tc.args, toolResult: result }, this.ctx.cwd || this.cfg.workspace);
        }
        // Surface the live TODO list so the TUI can render its panel.
        if (tc.name === 'TodoList') {
          this.onEvent({ type: 'todos', todos: this.ctx.todoState || [] });
        }
        // A tool may return a STRUCTURED result instead of a string: ReadMediaFile
        // returns `{ text, media }` so an image can travel as an image.
        const editDiff = this.ctx.lastEditDiff || null;
        const media = !!result && typeof result === 'object' && Array.isArray(result.media);
        this.ctx.lastEditDiff = null;
        return { ok, result, editDiff, media };
      };

      // Post one call's outcome: the model's `tool` message, then the TUI event.
      const postToolResult = (tc, out) => {
        if (!out.ok) allOk = false;
        if (out.media) {
          const forModel = out.editDiff
            ? { ...out.result, text: mediaResultText(out.result) + formatEditDiffForModel(out.editDiff) }
            : out.result;
          this.messages.push({ role: 'tool', toolCallId: tc.id, content: forModel });
          this.onEvent({
            type: 'tool_result', id: tc.id, name: tc.name,
            content: out.result._receipt || out.result.text || '[media]',
            editDiff: out.editDiff,
          });
          return;
        }
        // THE MODEL GETS THE TOOL'S OWN RESULT. It used to have the rendered DIFF appended as well, because an Edit
        // reported only "replaced lines 5-7" and the model could not see what it had written. The Edit now quotes
        // the file around the change itself, so appending the diff would show the same lines twice.
        const rawForModel = out.result;
        const shaped = toolResultLimitsEnabled()
          ? shapeToolResult(rawForModel, { sessionId: this.cfg.sessionId, toolCallId: tc.id })
          : { content: rawForModel, spilled: false };
        let _toolContent = shaped.content;
        // Mixin seam: toolResult (sync) - plugins may rewrite what the model receives for this call.
        try { const out = runPatchSync('toolResult', { name: tc.name, content: shaped.content }, (c) => c); if (out && out.content !== undefined) _toolContent = out.content; } catch (e) { console.error('[hncode-plugin] toolResult error:', e.message); }
        this.messages.push({ role: 'tool', toolCallId: tc.id, content: _toolContent });
        // Remember where the newest tool result landed: a trim must never elide the
        // output the model was handed in the step it is about to reason about.
        this._lastToolResultIndex = this.messages.length - 1;
        this.onEvent({
          type: 'tool_result', id: tc.id, name: tc.name,
          // THE UI GETS THE SUMMARY, NOT THE QUOTED FILE. The context lines after an Edit exist for the MODEL, so
          // it does not have to read the same region twice — the user reads the DIFF (`editDiff`) instead, which
          // already shows what changed in place. Passing the whole result drew the same lines twice, once as a
          // diff and once as a block of text.
          content: out.editDiff ? String(out.result).split('\n\n')[0] : out.result,
          editDiff: out.editDiff, spilled: shaped.spilled,
        });
      };


      for (let i = 0; i < toolCalls.length; i++) {
        if (this.stopRequested) break;
        const tc = toolCalls[i];
        // A RUN of consecutive read-only calls goes out in parallel. Non-
        // destructive by construction (see READ_ONLY_TOOLS), so none of them can
        // observe another's effects. The system prompt has always promised this
        // ("Run independent tool calls in parallel; never parallelize dependent
        // ones") but the loop executed every call one at a time, so a model that
        // issued four Reads paid for four round-trips in sequence.
        if (!READ_ONLY_TOOLS.has(tc.name)) {
          postToolResult(tc, await prepareToolCall(tc));
          continue;
        }
        const batch = [tc];
        while (i + 1 < toolCalls.length && READ_ONLY_TOOLS.has(toolCalls[i + 1].name)) batch.push(toolCalls[++i]);
        if (batch.length === 1) {
          postToolResult(tc, await prepareToolCall(tc));
          continue;
        }
        // Results are posted in CALL order, never completion order.
        const outs = await Promise.all(batch.map((b) => prepareToolCall(b)));
        for (let k = 0; k < batch.length; k++) postToolResult(batch[k], outs[k]);
      }


      // Did THIS iteration still have tool calls? If the loop runs out of budget
      // right after running them, the turn really is unfinished.
      hadToolCallsOnFinalStep = toolCalls.length > 0;

      // Report the context after this step's tool results were appended: that is
      // exactly what the next request will carry, so the gauge grows with history.
      this.onEvent({ type: 'context', tokens: this.usedTokens(), max: maxCtx });

    }

    // With the cap removed this can only trigger for a caller that set an
    // explicit finite maxSteps: the final iteration still produced tool calls,
    // so the turn genuinely ran out of rounds. Checking the step index alone (as
    // this used to) reported "budget exhausted" for turns that had finished.
    if (Number.isFinite(stepLimit) && !this.stopRequested && hadToolCallsOnFinalStep) {
      this.onEvent({
        type: 'incomplete',
        reason: 'the step budget was exhausted while tools were still being called',
      });
    }
    if (!emittedEnd && this.onEvent) this.onEvent({ type: 'done' });
    // The turn is over, so the inline-reasoning block it may have left open is
    // abandoned: the NEXT user turn starts a fresh one. Without this, a model that
    // never wrote its closing tag would leave the following turn's answer classified
    // as reasoning.
    if (typeof this.llm.resetThink === 'function') this.llm.resetThink();
    // Plugin lifecycle: the turn is over (normally, interrupted, or out of steps).
    // In a finally-equivalent position — every exit path above reaches here.
    await runHooks('onTurnEnd', { messages: this.messages, stopped: this.stopRequested });
    // SHELL HOOK: Stop fires when the turn ends, whether it finished or was
    // interrupted. Never blocks.
    await runShellHooks(this.hookConfig, 'Stop',
      { messages: this.messages, stopped: this.stopRequested, prompt: this._turnPrompt }, this.cfg.workspace);
  }
}
