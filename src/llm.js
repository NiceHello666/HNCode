// Dual-protocol (OpenAI + Anthropic) chat client with streaming + non-streaming.
// Normalizes both providers into a common event stream consumed by the agent:
//   {type:'data', text}            assistant text delta
//   {type:'tool_start', id, name}  a tool call began
//   {type:'tool_args', id, chunk}  partial JSON argument chunk
//   {type:'tool_end', id}          tool call arguments complete
//   {type:'end'}                   assistant turn finished
//   {type:'error', error}          fatal error

import { llmTools } from './tools/index.js';
import { effortWire } from './config.js';
import { applyPromptCache } from './cache.js';
import { runPatch, runPatchSync } from './plugin.js';

export function openAiToolDefs(tools) {
  // Guard: a caller that passes null/undefined (e.g. setToolsList(null)) used to
  // throw on `.map`, failing the whole request. An empty tool list is valid.
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function anthropicToolDefs(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
// ---------------------------------------------------------------------------
// Multimodal content
//
// A tool may return `{ media: [...] }` instead of a string — ReadMediaFile does,
// so a screenshot reaches the model as an IMAGE rather than as a description of
// one. The entries are normalized here, once, into the shapes each protocol
// wants; everything upstream (agent, tools) stays protocol-agnostic.
//
//   { type: 'image', mimeType: 'image/png', data: '<base64>' }
//   { type: 'text',  text: '...' }
//
// `data` is base64 WITHOUT the `data:` prefix; the prefix is added per protocol.

function isMediaContent(c) {
  return !!c && typeof c === 'object' && Array.isArray(c.media);
}

function mediaText(c) {
  return String(c.text == null ? '' : c.text);
}

/** OpenAI: content parts, `image_url` carries the data URL. */
function toOpenAiContent(c) {
  const parts = [];
  const text = mediaText(c);
  if (text) parts.push({ type: 'text', text });
  for (const m of c.media) {
    if (m && m.type === 'image' && m.data) {
      parts.push({ type: 'image_url', image_url: { url: `data:${m.mimeType || 'image/png'};base64,${m.data}` } });
    }
  }
  // A media block with no image and no text would serialise as an empty array,
  // which some providers reject. Fall back to a plain string.
  if (!parts.length) return text || '';
  return parts;
}

/** Anthropic: content blocks, `image` carries source bytes. */
function toAnthropicContent(c) {
  const blocks = [];
  const text = mediaText(c);
  if (text) blocks.push({ type: 'text', text });
  for (const m of c.media) {
    if (m && m.type === 'image' && m.data) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: m.mimeType || 'image/png', data: m.data } });
    }
  }
  if (!blocks.length) return text || '';
  return blocks;
}

// Internal canonical messages -> OpenAI request shape.
export function toOpenAi(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') {
      out.push({ role: 'user', content: isMediaContent(m.content) ? toOpenAiContent(m.content) : m.content });
    } else if (m.role === 'assistant') {
      const hasText = typeof m.content === 'string' && m.content.trim();
      const hasCalls = Array.isArray(m.toolCalls) && m.toolCalls.length;
        if (!hasText && !hasCalls) continue; // the provider rejects an empty assistant turn; drop it
      const msg = { role: 'assistant', content: m.content || null };
      if (hasCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: isMediaContent(m.content) ? toOpenAiContent(m.content) : m.content,
      });
    }
  }
  return out;
}

// Internal canonical messages -> Anthropic request shape. Returns {system, messages}.
export function toAnthropic(messages) {
  const sys = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { sys.push(m.content); continue; }
    if (m.role === 'user') {
      const c = isMediaContent(m.content) ? toAnthropicContent(m.content) : [{ type: 'text', text: m.content }];
      out.push({ role: 'user', content: c });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: isMediaContent(m.content) ? toAnthropicContent(m.content) : m.content,
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of (m.toolCalls || [])) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: blocks });
    }
  }
return { system: sys.join('\n\n').trim(), messages: out };
}

/** Responses: content parts use `input_text` / `input_image`. */
function toResponsesContent(c) {
  const parts = [];
  const text = mediaText(c);
  if (text) parts.push({ type: 'input_text', text });
  for (const m of c.media) {
    if (m && m.type === 'image' && m.data) {
      parts.push({ type: 'input_image', image_url: `data:${m.mimeType || 'image/png'};base64,${m.data}` });
    }
  }
  if (!parts.length) return text || '';
  return parts;
}

// Internal canonical messages -> OpenAI RESPONSES API request shape.
//
// The Responses API is NOT chat/completions with a different name: the message
// array becomes a flat `input` ITEM list, the system prompt moves to a top-level
// `instructions`, tools are FLAT (no nested `function` object), a tool call is its
// own item (`function_call`) and its result is another (`function_call_output`,
// keyed by `call_id` rather than `tool_call_id`). Returns { instructions, input }.
export function toResponsesInput(messages) {
  const sys = [];
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') { sys.push(m.content); continue; }
    if (m.role === 'user') {
      input.push({ role: 'user', content: isMediaContent(m.content) ? toResponsesContent(m.content) : [{ type: 'input_text', text: String(m.content == null ? '' : m.content) }] });
      continue;
    }
    if (m.role === 'tool') {
      // Tool output is a top-level item, not a role:'tool' message.
      const out = isMediaContent(m.content)
        ? toResponsesContent(m.content)
        : String(m.content == null ? '' : m.content);
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: out });
      continue;
    }
    if (m.role === 'assistant') {
      const hasText = typeof m.content === 'string' && m.content.trim();
      const hasCalls = Array.isArray(m.toolCalls) && m.toolCalls.length;
      if (!hasText && !hasCalls) continue;
      if (hasText) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const tc of (m.toolCalls || [])) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.args || {}),
        });
      }
    }
  }
  return { instructions: sys.join('\n\n').trim(), input };
}

// Responses tools are FLAT: { type:'function', name, description, parameters }.
// (chat/completions nests all of that under a `function` key.)
export function responsesToolDefs(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function authHeaders(cfg) {
  const h = { 'content-type': 'application/json' };
  if (cfg.apiKey) {
    if (cfg.protocol === 'anthropic') {
      h['x-api-key'] = cfg.apiKey;
      h['anthropic-version'] = '2023-06-01';
    } else {
      h['authorization'] = `Bearer ${cfg.apiKey}`;
    }
  }
  return h;
}

function buildBody(cfg, messages, streaming = true, opts = {}) {
  const common = { stream: streaming, max_tokens: cfg.maxOutputTokens };
  if (cfg.temperature != null) common.temperature = cfg.temperature;
  // Ask for the token accounting on the FINAL stream frame. Without this the
  // OpenAI-compatible stream carries no `usage` at all, so the only token numbers
  // available were our own estimates (see /usage, which divided the transcript's
  // JSON length by 3.5). `includeUsage` is cleared after a 400 (see request):
  // servers that predate the field reject the whole request.
  if (streaming && opts.includeUsage !== false) common.stream_options = { include_usage: true };
  // effort (see config.effortWire): OpenAI-compatible sends `reasoning_effort`,
  // Anthropic sends a `thinking` budget. Models that think by default need no
  // flag, so nothing is sent when the effort is off/unset.
  //
  // `noReasoning` opts a request OUT of it. Internal one-shot requests that cap
  // their output (the session title, the compaction summary) must not ask for
  // thinking: a reasoning model spends the whole small budget on
  // `reasoning_content`, returns `finish_reason: "length"` with empty `content`,
  // and the request comes back as a failure that never even shows an error.
  const wire = opts.noReasoning ? {} : (effortWire(cfg, cfg.effort) || {});
  // Internal requests that have no use for tools must not carry the ~25 KB tool
  // block: it is pure input cost on top of a request that only wants one line.
  const defs = Object.prototype.hasOwnProperty.call(opts, 'tools') ? openAiToolDefs(opts.tools) : openAiToolDefs(llmToolsList);
  if (cfg.protocol === 'anthropic') {
    const { system, messages: am } = toAnthropic(messages);
    const body = {
      model: cfg.innerModel, system, messages: am,
      // `tool_choice: none` is the protocol-level refusal. Omitting the tool definitions entirely, which
      // is what `noTools` used to do, leaves the model free to EMIT the syntax from memory — a summariser
      // that answers with `<|tool_call|>{…}` instead of a summary. Declaring the tools and forbidding their
      // use is the only form both providers accept.
      tools: opts.toolChoice === 'none' ? anthropicToolDefs(opts.tools || llmToolsList) : (opts.noTools ? undefined : anthropicToolDefs(opts.tools || llmToolsList)),
      tool_choice: opts.toolChoice === 'none' ? { type: 'none' } : undefined,
      ...common, ...wire,
    };
    if (!body.tools || !body.tools.length) delete body.tools;
    // Prompt caching: mark the stable prefix (tools + system + conversation head)
    // so the provider bills it as a cache READ instead of fresh input. The key is
    // the SESSION id, so it stays identical across turns and never thrashes.
    return JSON.stringify(applyPromptCache('anthropic', body, {
      enabled: cfg.promptCache !== false,
      sessionKey: cfg.sessionId,
    }));
  }
  if (cfg.protocol === 'responses') {
    const { instructions, input } = toResponsesInput(messages);
    const rbody = {
      model: cfg.innerModel,
      // `instructions` carries the system prompt; `input` is the flat item list.
      input,
      // NOTE: the cap is `max_output_tokens` here, NOT chat/completions'
      // `max_tokens` — sending the wrong name is silently ignored by the API.
      max_output_tokens: cfg.maxOutputTokens,
      stream: streaming,
      ...wire,
    };
    if (instructions) rbody.instructions = instructions;
    if (cfg.temperature != null) rbody.temperature = cfg.temperature;
    if (!opts.noTools) {
      const defsR = Object.prototype.hasOwnProperty.call(opts, 'tools')
        ? responsesToolDefs(opts.tools) : responsesToolDefs(llmToolsList);
      if (defsR.length) rbody.tools = defsR;
    }
    return JSON.stringify(applyPromptCache('responses', rbody, {
      enabled: cfg.promptCache !== false,
      sessionKey: cfg.sessionId,
    }));
  }
  const body = {
    model: cfg.innerModel, messages: toOpenAi(messages),
    ...common, ...wire,
  };
  // `tool_choice: 'none'` NEEDS THE TOOLS DECLARED alongside it. OpenAI rejects the field without them, so
  // the list is sent and the choice forbids use — the same shape as the Anthropic branch, and the only form
  // that actually stops a model answering with a tool call instead of a summary.
  if (opts.toolChoice === 'none') {
    if (defs.length) {
      body.tools = defs;
      body.tool_choice = 'none';
    }
  } else if (!opts.noTools && defs.length) {
    // Only attach a NON-EMPTY tools array: `tools: []` is rejected by some strict
    // gateways, and an instance that registered no list means "no tools here".
    body.tools = defs;
  }
  return JSON.stringify(applyPromptCache('openai', body, {
    enabled: cfg.promptCache !== false,
    sessionKey: cfg.sessionId,
  }));
}

// tool list used for defs (injected via setTools)
let llmToolsList = [];
// Only ever store an array: `null`/undefined here would make every later request
// throw when the defs are built.
export function setToolsList(list) { llmToolsList = Array.isArray(list) ? list : []; }

export class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.controller = null;
    // The tool defs THIS instance sends. Per-instance, NOT module-global: the
    // global (`llmToolsList` below) was overwritten by every `new Agent()` in
    // the process, so a subagent, swarm member or teammate constructed while a
    // parent request was building its body silently swapped the parent's tool
    // list mid-turn. The agent sets this via setTools() right after construction.
    this._tools = null;
    // Inline-reasoning state carried ACROSS requests. Our system prompt tells the
    // model to put all its reasoning inside one <think> span, and tool calls happen
    // inside that span — so the span outlives a single request. Reset when the turn
    // ends (see resetThink).
    this._inThink = false;
    this._tagPending = '';
  }

  // Register the tool list this instance advertises (see `_tools`). Only ever
  // store an array or null: a non-array would make every later request throw
  // when the defs are built.
  setTools(list) { this._tools = Array.isArray(list) ? list : null; }

  // Called by the agent at the end of a turn: the next turn starts a fresh
  // reasoning block, even if the previous one never saw its closing tag.
  resetThink() {
    this._inThink = false;
    this._tagPending = '';
  }

  // Abort an in-flight request (Esc / Ctrl-C while the agent is running).
  abort() {
    if (this.controller) { try { this.controller.abort(); } catch {} }
  }

  // Simple non-streaming text request — used for internal tasks (e.g. context
  // summarization during compaction) that should not surface a tool plan to the
  // user. Returns the assistant's text content or null on failure.
  //
  // `opts.noReasoning` / `opts.noTools` exist for the small one-shot requests:
  // a capped budget plus a reasoning model is what silently produced an empty
  // title (see buildBody), and an internal request has no tools to call.
  async requestText(messages, opts = {}) {
    // One silent retry on FAILURE (null). These one-shot requests (title,
    // compaction summary) have no outer retry loop, and a single transient
    // 429/network blip used to come back as null — which the compaction path
    // treated as "no summary" and trimmed the history over. `''` (capped-empty)
    // is a meaningful verdict for the caller and is NOT retried here.
    let out = await this._requestTextOnce(messages, opts);
    if (out === null && !(this.controller && this.controller.signal.aborted)) {
      await new Promise((r) => setTimeout(r, 400));
      out = await this._requestTextOnce(messages, opts);
    }
    return out;
  }

  async _requestTextOnce(messages, opts = {}) {
    const cfg = this.cfg;
    this.controller = new AbortController();
    // This instance's tools, unless the caller opted out (internal one-shots).
    const bodyOpts = { ...opts, ...((this._tools && !opts.noTools) ? { tools: this._tools } : {}) };
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: (() => { const h = authHeaders(cfg); try { const out = runPatchSync('llmHeaders', { headers: h }, (c) => c); if (out && out.headers) return out.headers; } catch (e) {} return h; })(),
        body: (() => { let b = buildBody(cfg, messages, false, bodyOpts); try { const out = runPatchSync('llmBody', { body: b, cfg }, (c) => c); if (out && out.body !== undefined) b = out.body; } catch (e) {} return b; })(),
        signal: this.controller.signal,
      });
      if (!res || !res.ok) {
        let t = '';
        try { if (res) t = await res.text(); } catch {}
        const status = res ? res.status : 'network';
        return null;
      }
      const json = await res.json();
      let text = '';
      if (cfg.protocol === 'anthropic') {
        for (const cb of (json.content || [])) {
          if (cb.type === 'text' && cb.text) text += cb.text;
        }
      } else if (cfg.protocol === 'responses') {
        // Responses: text sits in `message` items' `output_text` parts. Some
        // gateways also expose a top-level `output_text` convenience field.
        if (typeof json.output_text === 'string') text = json.output_text;
        else {
          for (const item of (json.output || [])) {
            if (item && item.type === 'message' && Array.isArray(item.content)) {
              for (const c of item.content) if (c && c.type === 'output_text' && c.text) text += c.text;
            }
          }
        }
      } else {
        const msg = json.choices && json.choices[0] && json.choices[0].message;
        if (msg && msg.content) text = msg.content;
      }
      // An EMPTY reply that hit the output cap is a failure, not an answer. The
      // title request used to receive `content: ""` + `finish_reason: "length"`
      // and treat it as "the model had nothing to say", which is why the title
      // was silently never generated (and never retried). Returning it marked
      // lets the caller decide — the title path retries with a bigger budget.
      if (!text) {
        const truncated = cfg.protocol === 'anthropic'
          ? (json.stop_reason === 'max_tokens')
          : cfg.protocol === 'responses'
            ? !!(json.incomplete_details && json.incomplete_details.reason === 'max_output_tokens')
            : !!(json.choices && json.choices[0] && json.choices[0].finish_reason === 'length');
        return truncated ? '' : null;
      }
      return text;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      return null;
    }
  }

  async request(messages, onEvent, cacheEnd) {
    // Mixin seam: let plugins mutate the messages sent to the model.
    try { const out = await runPatch('llmRequest', { messages, cfg: this.cfg }, (c) => c); if (out && out.messages) messages = out.messages; } catch (e) { /* patch failed; proceed with original */ }
    const cfg = this.cfg;
    let res = null;
    let lastError = null;
    let lastStatus = 0;
    let attempts = 0;

    // Retry the HTTP round-trip. Any non-200 response is treated as a problem and
    // retried (5xx, 429, and unexpected 4xx alike), as is a network/connection
    // error. The only exceptions are aborts (Esc/Ctrl-C) — those end the turn —
    // and a response that is not ok on the final attempt. The count is
    // `cfg.maxRetries` when set (the `--retries` flag), else 3.
    const RETRIES = Number.isInteger(this.cfg && this.cfg.maxRetries) && this.cfg.maxRetries > 0
      ? this.cfg.maxRetries : 3;
    // Whether this attempt asks for streaming usage. A server that does not know
    // `stream_options` rejects the whole request with a 400, so the first 400
    // turns it off and the retry goes out without it — degrading to an estimate
    // rather than failing the request over an accounting nicety.
    const reqOpts = {};
    // This instance's tools ride along on every attempt (per-instance; see the
    // constructor note on `_tools`). `tools` is only included when set, so
    // buildBody's hasOwnProperty probe falls through to the global for callers
    // that never registered a list.
    const instanceTools = this._tools ? { tools: this._tools } : {};

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      attempts = attempt;
      // Reset per attempt. Left holding the PREVIOUS attempt's response, a network error on
      // this attempt left `res` truthy and `!res.ok` true, so the loop reported the old
      // status and the old body — `LLM request failed (503)` for a connection that was
      // actually refused, with `lastError` (the real cause) never reaching the user.
      res = null;
      lastError = null;
      // Fresh controller per attempt so an abort aborts this specific request
      // and the retry loop stops.
      this.controller = new AbortController();
      const signal = this.controller.signal;
      try {
        res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: (() => { const h = authHeaders(cfg); try { const out = runPatchSync('llmHeaders', { headers: h }, (c) => c); if (out && out.headers) return out.headers; } catch (e) {} return h; })(),
          body: (() => { let b = buildBody(cfg, messages, true, { ...reqOpts, cacheEnd, ...instanceTools }); try { const out = runPatchSync('llmBody', { body: b, cfg }, (c) => c); if (out && out.body !== undefined) b = out.body; } catch (e) {} return b; })(),
          signal,
        });
      } catch (e) {
        // An abort is a normal way to end a turn, not an error to report.
        if (e && e.name === 'AbortError') { onEvent({ type: 'aborted' }); return; }
        lastError = e;
        lastStatus = 0; // network error
      }
      if (res && res.ok) break;
      if (res) {
        lastStatus = res.status;
        // Drop `stream_options` and try again: a 400 here is the one error this
        // request can fix by itself, and the accounting is optional.
        if (res.status === 400 && reqOpts.includeUsage !== false) reqOpts.includeUsage = false;
      }
      if (attempt < RETRIES) {
        // Release the FAILED attempt's body so its socket returns to the pool.
        // An unread body pins the connection until GC — under a sustained
        // 429/5xx storm the retries accumulated one open connection per attempt.
        if (res && res.body) { try { await res.body.cancel(); } catch { /* already gone */ } }
        // Small exponential backoff (200ms, 400ms). If the user hit Esc during
        // the wait, stop retrying.
        const tryingSignal = this.controller.signal;
        await new Promise((r) => {
          const timer = setTimeout(r, 200 * attempt);
          tryingSignal.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true });
        });
        if (tryingSignal.aborted) { onEvent({ type: 'aborted' }); return; }
      }
    }

    if (lastError && !res) {
      onEvent({ type: 'error', error: lastError });
      return;
    }
    if (!res || !res.ok) {
      let t = '';
      try { if (res) t = await res.text(); } catch {}
      const tries = lastStatus ? `${res.status}` : 'network';
      onEvent({ type: 'error', error: new Error(`LLM request failed after ${attempts} attempt(s) (${tries}): ${truncate(t)}`) });
      return;
    }
    if (cfg.stream === false) {
      // A 200 with a malformed/empty body used to reject here, and the caller
      // (an unawaited `runAgent`) turned that rejection into a process exit via
      // the global unhandledRejection handler. Surface it as an error EVENT —
      // the same channel every other failure on this path uses.
      let json;
      try {
        json = await res.json();
      } catch (e) {
        onEvent({ type: 'error', error: new Error(`LLM returned a malformed non-streaming body: ${e && e.message}`) });
        return;
      }
      return consumeNonStreaming(cfg.protocol, json, onEvent);
    }
    if (!res.body) { onEvent({ type: 'end' }); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // The inline-reasoning state (`inThink` / `tagPending`) is carried on the LLM
    // instance, NOT recreated per request. A model that opens <think>, runs a tool,
    // and only writes </think> in the NEXT step would otherwise have everything
    // after the tool call reclassified as the ANSWER — the reasoning text and the
    // literal `</think>` tag both showed up in the transcript.
    const state = {
      tools: new Map(), indexToId: {}, doneEmitted: false,
      inThink: !!this._inThink, tagPending: this._tagPending || '',
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          const s = line.startsWith('data: ') ? line.slice(6) : (line.startsWith('data:') ? line.slice(5) : line);
          if (s === '[DONE]') { finish(state, onEvent); return; }
          if (processEvent(cfg.protocol, s, onEvent, state) === 'end') { finish(state, onEvent); return; }
        }
      }
    } catch (e) {
      // Aborting mid-stream (Esc) also lands here.
      if (e && e.name === 'AbortError') { onEvent({ type: 'aborted' }); return; }
      onEvent({ type: 'error', error: e });
      return;
    } finally {
      reader.releaseLock?.();
      // Carry the inline-reasoning state forward on EVERY exit path — a normal end,
      // [DONE], an abort and an error all pass through here. The model may resume an
      // open <think> span after a tool call in the next step, so this belongs to the
      // turn, not to one request.
      this._inThink = !!state.inThink;
      this._tagPending = state.tagPending || '';
    }
    finish(state, onEvent);
  }
}

// A model that follows OUR prompt emits `<|thinking|>…<|/thinking|>` (agent.js and
// prompt-presets.js both instruct it). Three more spellings have to be accepted,
// because they are not ours to change:
//   `<|think|>` / `<|/think|>`  — the short form of the same convention, for models
//                               that abbreviate it, and for sessions recorded before
//                               the longer spelling became the prompt's
//   `</|thinking|>` / `</|think|>`
//                               — the same two with the slash written before the bar.
//                               Accepted so the delimiter ORDER cannot be the thing
//                               that decides whether reasoning stays out of the answer
//   `<｜begin▁of▁thinking｜>` / `<｜end▁of▁thinking｜>`
//                               — DeepSeek-R1's own token markers, as emitted by
//                               vLLM / llama.cpp builds. The bars are U+FF5C and the
//                               separators U+2581, so no prose can be mistaken for one.
//                               The OPENING marker was missing while the closing one
//                               was present, which left the format inside-out: the
//                               begin marker went out as the ANSWER, and the end marker
//                               then flipped everything after it into reasoning.
//
// The BARE forms are deliberately GONE: `' thinking'`, `<thinking>`, `<think>`.
// feedContent locates a tag with `indexOf` over the whole buffer and then TOGGLES, so a
// tag that also occurs in ordinary writing reclassifies everything after it. On `'
// thinking'` that is a sentence like "I am thinking about this", "stop thinking and
// answer", "after thinking it over" — and because such a reply never reaches a closing
// tag, the remainder was emitted as REASONING and the answer disappeared into the
// thinking block. `<think>` / `<thinking>` are legal prose too (HTML, a tutorial, a
// quotation of this very file), which is what agent.js means when it warns that "a plain
// <think> is ordinary text that may appear in code or prose".
//
// Mixing is intended and already works: the parser toggles on ANY opening tag and ANY
// closing one, so `<|thinking|>…<|/think|>` closes correctly.
const THINK_OPEN_TAGS = ['<|thinking|>', '<|think|>', '<｜begin▁of▁thinking｜>'];
// Closing tags. If none of these appear, the block stays in think mode to EOI.
const THINK_CLOSE_TAGS = ['<|/thinking|>', '</|thinking|>', '<|/think|>', '</|think|>', '<｜end▁of▁thinking｜>'];

// Longest suffix of `buf` that is a proper prefix of one of `tags`.
// A single trailing space is deliberately NOT a candidate: `' '` is a prefix of
// `' thinking'`, but holding it back would stall every sentence-ending space
// (and its neighbour letter could be anything). Only hold at least 2 chars,
// which makes the tag unambiguous even split across chunks.
function partialTagSuffixLen(buf, tags) {
  let best = 0;
  for (const tag of tags) {
    const max = Math.min(tag.length - 1, buf.length);
    for (let len = Math.max(2, 1); len <= max; len++) { // len>=2 only
      if (buf.endsWith(tag.slice(0, len))) { if (len > best) best = len; break; }
    }
  }
  return best;
}

function feedContent(text, onEvent, state) {
  let buf = (state.tagPending || '') + String(text || '');
  state.tagPending = '';
  let inThink = !!state.inThink;
  while (buf.length > 0) {
    const tags = inThink ? THINK_CLOSE_TAGS : THINK_OPEN_TAGS;
    let best = -1, bestTag = null;
    for (const tag of tags) {
      const i = buf.indexOf(tag);
      if (i >= 0 && (best === -1 || i < best)) { best = i; bestTag = tag; }
    }
    if (best === -1) {
      const keep = partialTagSuffixLen(buf, tags);
      const emit = buf.slice(0, buf.length - keep);
      if (emit) onEvent({ type: inThink ? 'think' : 'data', text: emit });
      state.tagPending = keep ? buf.slice(buf.length - keep) : '';
      state.inThink = inThink;
      return;
    }
    const before = buf.slice(0, best);
    if (before) onEvent({ type: inThink ? 'think' : 'data', text: before });
    inThink = !inThink;
    buf = buf.slice(best + bestTag.length);
  }
  state.inThink = inThink;
}

// Emit whatever is still held back (a dangling partial tag is plain text).
function flushContent(onEvent, state) {
  if (state.tagPending) {
    onEvent({ type: state.inThink ? 'think' : 'data', text: state.tagPending });
    state.tagPending = '';
  }
}

function finish(state, onEvent) {
  // close any tool calls that started but never got an explicit end
  if (state.doneEmitted) return;
  // A still-OPEN reasoning block is deliberately NOT flushed here. The model can
  // continue it after a tool call in the next step — our own system prompt tells it
  // to put ALL reasoning in one <think> span, and tool calls happen inside that
  // span. Flushing would dump the held-back partial tag and end the block early, so
  // the rest of the reasoning would be reclassified as the ANSWER. The caller keeps
  // `inThink`/`tagPending` on the LLM instance and the block resumes there.
  if (!state.inThink) flushContent(onEvent, state);
  for (const [, t] of state.tools) {
    if (!t.done) onEvent({ type: 'tool_end', id: t.id });
  }
  state.doneEmitted = true;
  onEvent({ type: 'end' });
}

function processEvent(protocol, raw, onEvent, state) {
  let d;
  try { d = JSON.parse(raw); } catch { return 'continue'; }
  if (protocol === 'anthropic') return processAnthropic(d, onEvent, state);
  if (protocol === 'responses') return processResponses(d, onEvent, state);
  return processOpenAI(d, onEvent, state);
}

// ---- token accounting -------------------------------------------------------
// Every protocol reports the same facts under different names, and the only
// numbers that are not estimates come from here. Normalised shape:
//   { input, output, cached, cacheWrite, reasoning }
// `cached` is the part of `input` that was a cache READ (billed far cheaper), and
// `cacheWrite` the part written to the cache (billed dearer on Anthropic). Keeping
// them separate is what makes the cost estimate match a real invoice.
//
// A field left undefined means "not reported", which is different from zero: the
// caller adds what it gets and does not invent the rest.

/** OpenAI chat/completions `usage`. */
function normalizeOpenAIUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens;
  const reasoning = u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens;
  return {
    input: numOrUndef(u.prompt_tokens ?? u.input_tokens),
    output: numOrUndef(u.completion_tokens ?? u.output_tokens),
    cached: numOrUndef(cached),
    reasoning: numOrUndef(reasoning),
  };
}

/** Anthropic `usage`, which splits cache reads and writes out. */
function normalizeAnthropicUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: numOrUndef(u.input_tokens),
    output: numOrUndef(u.output_tokens),
    cached: numOrUndef(u.cache_read_input_tokens),
    cacheWrite: numOrUndef(u.cache_creation_input_tokens),
  };
}

/** OpenAI Responses `usage`. */
function normalizeResponsesUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = u.input_tokens_details && u.input_tokens_details.cached_tokens;
  const reasoning = u.output_tokens_details && u.output_tokens_details.reasoning_tokens;
  return {
    input: numOrUndef(u.input_tokens),
    output: numOrUndef(u.output_tokens),
    cached: numOrUndef(cached),
    reasoning: numOrUndef(reasoning),
  };
}

function numOrUndef(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Emit one `usage` event if the frame carried any numbers. */
function emitUsage(onEvent, u) {
  if (!u) return;
  if (u.input === undefined && u.output === undefined && u.cached === undefined && u.cacheWrite === undefined) return;
  onEvent({ type: 'usage', usage: u });
}

function processOpenAI(d, onEvent, state) {
  // The accounting arrives on its own frame, with an EMPTY `choices` array, right
  // before `[DONE]` — so it has to be read before the delta checks below, which
  // would otherwise return early on it.
  emitUsage(onEvent, normalizeOpenAIUsage(d.usage));
  const choice = d.choices && d.choices[0];
  const delta = choice && choice.delta;
  const finishReason = choice && choice.finish_reason;
  // Some servers put the final chunk's content AND its finish_reason in the SAME
  // frame, so the stop reason has to be handled AFTER the delta — checking it
  // only on a delta-less frame missed the truncation marker entirely (a stream
  // that reported `length` alongside the last token looked like a normal end).
  if (!delta) {
    if (finishReason) {
      if (finishReason === 'length') onEvent({ type: 'truncated' });
      onEvent({ type: 'end' });
      return 'end';
    }
    return 'continue';
  }
  // Reasoning tokens, matching kimi's `extractReasoning` / `extractReasoningDetails`.
  // Different servers name the field differently — `reasoning_content`
  // (vLLM/DeepSeek/hy3), `reasoning` (newer vLLM), or `reasoning_details`. The
  // first observed key is remembered so the output stays consistent.
  if (state.reasoningKey === undefined) {
    state.reasoningKey = ['reasoning_content', 'reasoning_details', 'reasoning']
      .find((k) => typeof delta[k] === 'string' || Array.isArray(delta[k]));
  }
  const key = state.reasoningKey;
  if (key === 'reasoning_details' && Array.isArray(delta.reasoning_details)) {
    // e.g. [{type:'summary'|'encrypted', summary?, encrypted?}]. Only the
    // plain-URL summary is meaningful to hncode — encrypted tokens are opaque.
    for (const el of delta.reasoning_details) {
      if (el && typeof el.summary === 'string') onEvent({ type: 'think', text: el.summary });
    }
  } else if (key && typeof delta[key] === 'string' && delta[key]) {
    onEvent({ type: 'think', text: delta[key] });
  }
  // Content may carry INLINE  thinking…<｜end▁of▁thinking｜> reasoning (hy3/DeepSeek
  // style); feedContent splits it out as think events. Otherwise it would be
  // rendered as part of the answer.
  if (delta.content) feedContent(delta.content, onEvent, state);
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      // First chunk of a tool call carries `id`; later chunks only repeat `index`.
      if (tc.id) state.indexToId[tc.index] = tc.id;
      const id = tc.id || state.indexToId[tc.index];
      if (!id) continue;
      if (!state.tools.has(id)) {
        state.tools.set(id, { id, name: tc.function && tc.function.name, argsJson: '', done: false });
        onEvent({ type: 'tool_start', id, name: tc.function && tc.function.name });
      }
      if (tc.function && tc.function.arguments) {
        const t = state.tools.get(id); t.argsJson += tc.function.arguments;
        onEvent({ type: 'tool_args', id, chunk: tc.function.arguments });
      }
    }
  }
  // A frame can carry BOTH the last delta and the stop reason (see above). Now
  // that the delta is consumed, report the cut and end the round — mirroring the
  // `message_stop` path for Anthropic.
  if (finishReason) {
    if (finishReason === 'length') onEvent({ type: 'truncated' });
    onEvent({ type: 'end' });
    return 'end';
  }
  return 'continue';
}

function processAnthropic(d, onEvent, state) {
  const t = d.type;
  if (t === 'message_start' || t === 'message_delta' || t === 'message_stop') {
    if (t === 'message_stop') { onEvent({ type: 'end' }); return 'end'; }
    // Anthropic splits the accounting in two: `message_start` carries the INPUT
    // (including cache reads and writes) and `message_delta` the OUTPUT. Both are
    // reported, and the accumulator adds them.
    if (t === 'message_start' && d.message && d.message.usage) {
      emitUsage(onEvent, normalizeAnthropicUsage(d.message.usage));
    }
    if (t === 'message_delta' && d.usage) emitUsage(onEvent, normalizeAnthropicUsage(d.usage));
    // `message_delta` carries the stop reason; `max_tokens` there means the reply
    // was cut off, not finished (see processOpenAI for the OpenAI spelling).
    if (t === 'message_delta' && d.delta && d.delta.stop_reason === 'max_tokens') {
      onEvent({ type: 'truncated' });
    }
    return 'continue';
  }
  if (t === 'content_block_start') {
    const cb = d.content_block;
    if (cb && cb.type === 'tool_use') {
      const id = cb.id; const name = cb.name;
      state.tools.set(d.index, { id, name, argsJson: '', done: false });
      onEvent({ type: 'tool_start', id, name });
    }
    return 'continue';
  }
  if (t === 'content_block_delta') {
    const delta = d.delta || {};
    // A thinking delta can arrive EMPTY (the protocol sends a delta frame with no
    // text for a block that produced none). Emitting it created an empty reasoning
    // block, which renders as a bare `●` row. The renderer drops those as well — this
    // is the cheaper place to stop it, and it keeps `state.chat` free of them.
    if (delta.type === 'text_delta') feedContent(delta.text || '', onEvent, state);
    else if (delta.type === 'thinking_delta' && delta.thinking) onEvent({ type: 'think', text: delta.thinking });
    else if (delta.type === 'input_json') {
      const blk = state.tools.get(d.index);
      if (blk) { blk.argsJson += delta.partial_json || ''; onEvent({ type: 'tool_args', id: blk.id, chunk: delta.partial_json || '' }); }
    }
    return 'continue';
  }
  if (t === 'content_block_stop') {
    const blk = state.tools.get(d.index);
    if (blk && !blk.done) { blk.done = true; onEvent({ type: 'tool_end', id: blk.id }); }
    return 'continue';
  }
  return 'continue';
}

// OpenAI Responses API streaming. The wire is a TYPED event stream (much closer to
// Anthropic than to chat/completions' `choices[].delta`):
//   response.output_text.delta                -> answer text
//   response.reasoning_summary_text.delta     -> thinking summary
//   response.output_item.added (function_call)-> tool_start
//   response.function_call_arguments.delta    -> tool_args (keyed by item_id)
//   response.output_item.done (function_call) -> tool_end
//   response.completed / response.incomplete  -> end (incomplete = truncated)
// Tool calls are addressed by `item_id` (the item's own id), and the `call_id`
// that goes back on `function_call_output` is carried on the item — the agent keys
// its tools by the id we emit here, so we emit the call_id and remember it.
function processResponses(d, onEvent, state) {
  const t = d.type;
  if (t === 'response.output_text.delta') {
    if (d.delta) feedContent(d.delta, onEvent, state);
    return 'continue';
  }
  if (t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') {
    if (d.delta) onEvent({ type: 'think', text: d.delta });
    return 'continue';
  }
  if (t === 'response.output_item.added' || t === 'response.output_item.done') {
    const item = d.item || {};
    if (item.type === 'function_call') {
      const id = item.call_id || item.id;
      if (t === 'response.output_item.added') {
        if (id && !state.tools.has(id)) {
          state.tools.set(id, { id, name: item.name, argsJson: '', done: false });
          onEvent({ type: 'tool_start', id, name: item.name });
        }
      } else {
        // done: the item carries the FULL arguments, so emit any that never
        // streamed (some servers skip the argument deltas for short calls).
        const entry = state.tools.get(id);
        if (entry && !entry.done) {
          if (typeof item.arguments === 'string' && item.arguments && !entry.argsJson) {
            entry.argsJson = item.arguments;
            onEvent({ type: 'tool_args', id, chunk: item.arguments });
          }
          entry.done = true;
          onEvent({ type: 'tool_end', id });
        }
      }
    }
    return 'continue';
  }
  if (t === 'response.function_call_arguments.delta') {
    const id = d.item_id || d.call_id;
    const entry = id ? state.tools.get(id) : null;
    if (entry) {
      entry.argsJson += d.delta || '';
      onEvent({ type: 'tool_args', id, chunk: d.delta || '' });
    }
    return 'continue';
  }
  if (t === 'response.completed') {
    // The accounting rides on the terminal event's `response` object.
    emitUsage(onEvent, normalizeResponsesUsage(d.response && d.response.usage));
    onEvent({ type: 'end' });
    return 'end';
  }
  if (t === 'response.incomplete') {
    // `incomplete_details.reason === 'max_output_tokens'` means the same thing as
    // chat/completions' finish_reason:'length' — the reply was cut, not finished.
    emitUsage(onEvent, normalizeResponsesUsage(d.response && d.response.usage));
    const reason = d.response && d.response.incomplete_details && d.response.incomplete_details.reason;
    if (reason === 'max_output_tokens') onEvent({ type: 'truncated' });
    onEvent({ type: 'end' });
    return 'end';
  }
  if (t === 'response.failed' || t === 'error') {
    const msg = (d.response && d.response.error && d.response.error.message) || d.message || 'response failed';
    onEvent({ type: 'error', error: new Error(msg) });
    return 'end';
  }
  return 'continue';
}

// --- Non-streaming path ---
export function consumeNonStreaming(protocol, json, onEvent) {
  const state = { tagPending: '', inThink: false };
  // Same accounting, one frame. Everything below this line is unchanged.
  emitUsage(onEvent, protocol === 'anthropic' ? normalizeAnthropicUsage(json.usage)
    : protocol === 'responses' ? normalizeResponsesUsage(json.usage)
      : normalizeOpenAIUsage(json.usage));
  if (protocol === 'anthropic') {
    const content = json.content || [];
    if (json.stop_reason === 'max_tokens') onEvent({ type: 'truncated' });
    for (const cb of content) {
      if (cb.type === 'text' && cb.text) feedContent(cb.text, onEvent, state);
      else if (cb.type === 'tool_use') {
        onEvent({ type: 'tool_start', id: cb.id, name: cb.name });
        onEvent({ type: 'tool_args', id: cb.id, chunk: JSON.stringify(cb.input || {}) });
        onEvent({ type: 'tool_end', id: cb.id });
      }
    }
  } else if (protocol === 'responses') {
    // Responses non-streaming: one object with an `output` ITEM list. Text lives in
    // a `message` item's `content[]` (`output_text`), reasoning in a `reasoning`
    // item's summary, and tool calls are their own `function_call` items.
    const output = json.output || [];
    if (json.incomplete_details && json.incomplete_details.reason === 'max_output_tokens') {
      onEvent({ type: 'truncated' });
    }
    if (json.status === 'failed' && json.error) {
      onEvent({ type: 'error', error: new Error(json.error.message || 'response failed') });
      return;
    }
    for (const item of output) {
      if (!item) continue;
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const s of item.summary) if (s && typeof s.text === 'string') onEvent({ type: 'think', text: s.text });
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === 'output_text' && c.text) feedContent(c.text, onEvent, state);
        }
      } else if (item.type === 'function_call') {
        const id = item.call_id || item.id;
        onEvent({ type: 'tool_start', id, name: item.name });
        if (item.arguments) onEvent({ type: 'tool_args', id, chunk: item.arguments });
        onEvent({ type: 'tool_end', id });
      }
    }
  } else {
    const choice = json.choices && json.choices[0];
    const msg = choice && choice.message;
    if (!msg) { onEvent({ type: 'error', error: new Error('empty LLM response') }); return; }
    // Non-streaming: the truncation marker comes on the same object as the message.
    if (choice.finish_reason === 'length') onEvent({ type: 'truncated' });
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) onEvent({ type: 'think', text: msg.reasoning_content });
    else if (typeof msg.reasoning === 'string' && msg.reasoning) onEvent({ type: 'think', text: msg.reasoning });
    else if (Array.isArray(msg.reasoning_details)) {
      for (const el of msg.reasoning_details) if (el && typeof el.summary === 'string') onEvent({ type: 'think', text: el.summary });
    }
    if (msg.content) feedContent(msg.content, onEvent, state);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const id = tc.id; const name = tc.function && tc.function.name; const args = tc.function && tc.function.arguments;
        onEvent({ type: 'tool_start', id, name });
        if (args) onEvent({ type: 'tool_args', id, chunk: args });
        onEvent({ type: 'tool_end', id });
      }
    }
  }
  flushContent(onEvent, state);
  onEvent({ type: 'end' });
}

function truncate(s, n = 300) { return s.length > n ? s.slice(0, n) + '...' : s; }
