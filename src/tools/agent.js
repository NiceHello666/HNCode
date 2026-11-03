// Agent tool — launch a subagent to handle a task, mirroring kimi-code's Agent.
//
// A subagent is a full Agent instance (same toolbelt, same protocol) with its OWN
// message list. The point is context isolation: the parent gets a conclusion back
// instead of a pile of file dumps.
//
// Supports, like kimi:
//   prompt / description        the task
//   subagent_type               profile name (we keep a small catalog)
//   resume                      continue an earlier subagent by agent id
//   run_in_background           start a background task and return its id
//   fork                        start from a snapshot of THIS conversation
//   model                       run on another configured model
//
// The result is returned as a plain string. A subagent's output is only visible
// to the CALLER, never rendered to the user directly — the parent is expected to
// summarise it.

import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';
import { registerRun, endRun } from '../subagent-control.js';
import { SUBAGENT_TYPES, DEFAULT_SUBAGENT_TYPE, availableTypes, toolsForSubagent } from '../subagent-types.js';
import { runShellHooks } from '../hooks.js';

// Live subagent registry, keyed by agent id. A resumed agent keeps its own
// message list here, which is what makes `resume` work.
//
// Bounded: a 128-item swarm made 128 entries holding FULL transcripts, kept for
// the process lifetime. The oldest entry is evicted past the cap — resuming a
// very old subagent then reports it as unknown instead of silently holding every
// transcript forever.
const SUBAGENTS_MAX = 64;
const subagents = new Map();
function rememberSubagent(id, entry) {
  subagents.delete(id);          // re-insertion moves the entry to the newest slot
  subagents.set(id, entry);
  while (subagents.size > SUBAGENTS_MAX) {
    subagents.delete(subagents.keys().next().value);
  }
}
let agentSeq = 0;


export function newAgentId() {
  agentSeq = (agentSeq + 1) % 1e6;
  return `agent-${Date.now().toString(36)}${String(agentSeq).padStart(3, '0')}`;
}

export function getSubagent(id) {
  return subagents.get(id) || null;
}

export function listSubagents() {
  return [...subagents.values()];
}

// Build the system prompt for a subagent: its profile prompt plus the shared
// rules, so a subagent behaves like the main agent within its remit.
function systemPromptFor(type, cfg, systemPrompt) {
  const profile = SUBAGENT_TYPES[type] || SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  const base = (cfg.systemPrompt && String(cfg.systemPrompt).trim()) || systemPrompt;
  return `${profile.prompt}\n\n${base}`;
}

// Run a subagent to completion. `history` seeds its messages (fork). Returns
// { text, usage } or { error }.
// `onProgress(text)` receives the subagent's live output (its reasoning and answer
// stream, and each tool it runs) so the TUI can show it under the `Using Agent`
// row the way Bash's output is shown. `agentId` labels the lines when several
// subagents run at once (AgentSwarm), so the reader can tell them apart.
async function runSubagent({ cfg, type, prompt, history, signal, onEvent, onProgress, onStep, agentId, onAgent }) {
  // The parent-signal listener (registered below, removed when the run settles).
  let onSubagentAbort = null;
  const { Agent, SYSTEM_PROMPT } = await import('../agent.js');
  const subCfg = {
    ...cfg,
    systemPrompt: systemPromptFor(type, cfg, SYSTEM_PROMPT),
    // The profile narrows the toolbelt (explore / plan / researcher are read-only)
    // and the delegation tools are removed unconditionally — a subagent must not
    // start another agent. `noDelegation` is the hard backstop in agent.js for the
    // case where the model emits a call for a tool it no longer has.
    toolFilter: toolsForSubagent(type, cfg.toolFilter),
    noDelegation: true,
  };
  // fork: the snapshot comes first, then the new instruction.
  const messages = Array.isArray(history) && history.length
    ? [...history, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  let text = '';
  // A failure used to leave `text` empty, so a caller could not tell "produced nothing" from
  // "died". The Agent's only signal on error is an event, so capture it here.
  let failure = null;
  const agent = new Agent({
    cfg: subCfg,
    messages,
    onEvent: (e) => {
      if (e.type === 'data') text += e.text;
      // Mirror what the subagent is actually doing into the parent's transcript:
      // its reasoning and answer stream as `data`/`think`, and every tool it runs
      // arrives as tool_start/tool_result. Without this the `Using Agent …` row sat
      // silent for the whole run — the subagent looked hung.
      if (onProgress) {
        const tag = agentId ? `[${agentId}] ` : '';
        if (e.type === 'data' || e.type === 'think') {
          if (e.text) onProgress(tag + e.text);
        } else if (e.type === 'tool_start') {
          onProgress(`\n${tag}\u25b8 ${e.name}\n`);
          // One more round of work done. A SUBAGENT has no fixed step budget (agent.js sets
          // `stepLimit = Infinity` unless the caller bounds it), so "steps remaining" is not
          // a real quantity and a percentage of it would be invented. Tool calls completed is
          // the honest measure: it only ever grows, it is what the run is actually doing, and
          // the swarm turns it into a bar against the pace its other agents have set.
          if (typeof onStep === 'function') onStep();
        } else if (e.type === 'tool_result') {
          const body = String(e.content == null ? '' : e.content);
          const first = body.split('\n').slice(0, 3).join('\n');
          onProgress(`${tag}${first}${body.split('\n').length > 3 ? '\n\u2026' : ''}\n`);
        } else if (e.type === 'error') {
          onProgress(`\n${tag}[error] ${(e.error && e.error.message) || String(e.error)}\n`);
          failure = (e.error && e.error.message) || String(e.error);
        }
      }
      if (onEvent) onEvent(e);
    },
    // A subagent never prompts: it inherits the parent's permission mode by
    // running under the same ctx (kimi does the same — approvals belong to the
    // parent turn, not the child).
    onApproval: async () => true,
  });
  if (signal) {
    if (signal.aborted) throw new Error('Interrupted by user');
    onSubagentAbort = () => agent.interrupt();
    signal.addEventListener('abort', onSubagentAbort, { once: true });
  }
  // Hand the LIVE agent back to the caller so a control tool can steer or interrupt it
  // while it runs. `subagents` only learns about this run when it finishes, so without
  // this the only way to reach a running subagent would be to interrupt the whole turn.
  if (typeof onAgent === 'function') onAgent(agent);
  // The abort listener is removed when the run settles. `{once:true}` only makes it
  // fire once — it stays REGISTERED until then, so every completed subagent left
  // one closure (holding the whole subagent) pinned on the parent's signal.
  try {
    await agent.run();
  } finally {
    if (onSubagentAbort) signal.removeEventListener('abort', onSubagentAbort);
  }
  // SHELL HOOK: SubagentStop. The subagent finished (or was interrupted); the
  // parent-side hook can log/archive it. Never blocks.
  // `hookConfig` may be the raw `{event:[…]}` map or a `{hooks:{…}}` wrapper
  // (agent.js normalises it to the wrapper) — accept either.
  const hc = subCfg.hookConfig;
  const hookCfg = hc ? (hc.hooks ? hc : { hooks: hc }) : null;
  if (hookCfg) {
    await runShellHooks(hookCfg, 'SubagentStop',
      { agentId: agentId || '', subagentType: type, prompt }, cfg.workspace);
  }
  // The parent must receive ONLY what the subagent concluded — never its tool
  // chatter, and never its reasoning. Two things could leak in:
  //   * the aggregate `data` stream, which also contains intermediate narration;
  //   * an inline `<think>…</think>` block, when a model puts reasoning in the
  //     content stream instead of the separate reasoning channel.
  // So: take the LAST assistant message (the handoff), and strip any think block
  // from it. Fall back to the filtered stream text when there is no message.
  // Strip whichever spelling the model used. `\b` alone is wrong here: `k` and `i`
  // are both word characters, so `<think\b` does NOT match `<thinking>` — a model
  // using the long form had its whole reasoning block leak into the handoff. Enumerate
  // the variants instead, matching llm.js's tag table.
  const stripThink = (s) => String(s)
    .replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '')   // an unclosed block: drop to the end
    .trim();
  const lastAssistant = [...agent.messages].reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && stripThink(m.content));
  const result = (lastAssistant && stripThink(lastAssistant.content)) || stripThink(text) || '(no output)';
  // The failure travels WITH the text. A run that died and a run that simply produced nothing
  // both used to arrive as an empty/`(no output)` string, so the caller could not tell them apart
  // and reported a dead agent as a successful empty answer.
  return { text: result, messages: agent.messages, failed: failure };
}

export const spec = {
  name: 'Agent',
  description: `Launch a subagent. It runs with its own context, so you get a conclusion back instead of the file contents it read on the way.

Spawn one only when the user (or AGENTS.md) explicitly asked for delegation, sub-agents, or parallel agent work. A request for depth, thoroughness, research or a detailed analysis is NOT permission — do the work yourself by default.

Write the prompt for a colleague who has not seen this conversation: state the goal, hand over the exact path or command for a lookup, and give the QUESTION rather than prescribed steps for an investigation. Find the path or line number yourself first; do not delegate understanding.

Continuing earlier subagent work: pass its \`resume\` id instead of starting fresh. Its result is visible only to you — summarize the relevant parts in your own reply.

Types:
${availableTypes()}`,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full task prompt for the subagent.' },
      description: { type: 'string', description: 'Short task description (3-5 words) for UI display.' },
      subagent_type: { type: 'string', description: `One of the available agent types. Defaults to "${DEFAULT_SUBAGENT_TYPE}" when omitted.` },
      resume: { type: 'string', description: 'Optional agent id to resume instead of creating a new instance. Do not also pass subagent_type.' },
      run_in_background: { type: 'boolean', default: false, description: 'If true, return immediately with a task id instead of waiting. The result arrives in the conversation later.' },
      fork: { type: 'boolean', default: false, description: "Start the subagent from a snapshot of this agent's completed conversation history instead of zero context." },
      model: { type: 'string', description: 'A configured model key to run the subagent on, or "primary" for the current model. Ignored when resuming.' },
    },
    required: ['prompt', 'description'],
  },

  async execute(args, ctx) {
    const prompt = String(args.prompt || '').trim();
    const description = String(args.description || '').trim();
    if (!prompt) return 'Error: `prompt` is required.';
    if (!description) return 'Error: `description` is required (short label for the task list).';

    const resumeId = args.resume ? String(args.resume).trim() : '';
    const wantFork = args.fork === true;
    if (resumeId && args.subagent_type) {
      return 'Error: cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
    }
    if (resumeId && wantFork) {
      return 'Error: `fork` cannot be combined with `resume`.';
    }

    // ---- resume an existing subagent -------------------------------------
    let existing = null;
    if (resumeId) {
      existing = subagents.get(resumeId);
      if (!existing) return `Error: no such subagent: ${resumeId}`;
    }

    const type = existing
      ? existing.type
      : (SUBAGENT_TYPES[args.subagent_type] ? args.subagent_type : DEFAULT_SUBAGENT_TYPE);

    // ---- model override ---------------------------------------------------
    // Precedence: the call's own `model` > the user's configured subagent model
    // (/subagent-model) > the session's model. 'primary' always means "this
    // session's model", so an explicit primary beats a configured default.
    let subCfg = ctx;
    const wantPrimary = args.model === 'primary';
    const explicit = args.model && !wantPrimary && ctx.raw && ctx.raw.models && ctx.raw.models[args.model]
      ? args.model : '';
    const configured = ctx.subagentModel && ctx.raw && ctx.raw.models && ctx.raw.models[ctx.subagentModel]
      ? ctx.subagentModel : '';
    // A NAME THAT DOES NOT EXIST IS AN ERROR, not a fallback. Resolving it to "" ran the
    // subagent on the session's model while the caller believed it had chosen — a typo, or a
    // model configured in another session, produced a silently different agent.
    if (args.model && !wantPrimary && !explicit) {
      const known = Object.keys((ctx.raw && ctx.raw.models) || {});
      const list = known.length ? known.join(', ') : 'none';
      return `Error: unknown model "${args.model}". Configured: ${list}. Use "primary" for the session model.`;
    }

    // The user's `/subagent-model` setting can go stale when a model is renamed or removed, and
    // it used to fail the same silent way. Say so, through onOutput so it reaches the transcript.
    if (ctx.subagentModel && !configured) {
      const list = Object.keys((ctx.raw && ctx.raw.models) || {}).join(', ') || 'none';
      try {
        if (typeof ctx.onOutput === 'function') {
          ctx.onOutput(`[subagent model] "${ctx.subagentModel}" is no longer configured, so this subagent runs on the session model. Re-pick it with /swarm-sub-agent. Available: ${list}\n`);
        }
      } catch { /* a view that cannot be written to is not a reason to fail the call */ }
    }

    const chosen = wantPrimary ? '' : (explicit || configured);
    if (chosen) {
      const { resolveModelArg } = await import('../config.js');
      subCfg = resolveModelArg(ctx, chosen);
    }

    // ---- fork: snapshot this conversation --------------------------------
    let history = null;
    if (wantFork) {
      history = (ctx._parentMessages || []).filter(
        (m) => m.role !== 'system' && m.role !== 'tool' && typeof m.content === 'string' && m.content.trim(),
      );
    }

    // ---- background -------------------------------------------------------
    if (args.run_in_background === true) {
      const controller = new AbortController();
      const task = createTask(ctx, 'agent', {
        description,
        agentId: null,
        subagentType: type,
        model: args.model || '',
        detached: true,
      });
      task._abort = () => controller.abort();
      const agentId = existing ? existing.id : newAgentId();
      task.agentId = agentId;

      // Register the run so a control tool can reach it while it is in flight. The handle
      // is created BEFORE the run so both `run_in_background` and the detached-foreground
      // path behave the same, and cleared in `finally` so a settled run can never be
      // listed as controllable.
      let runId = '';
      const early = { agent: null };

      // Fire and forget: the task record carries the result when it lands.
      void (async () => {
        try {
          const run = await runSubagent({
            cfg: subCfg, type, prompt, history,
            signal: controller.signal,
            onAgent: (agent) => { early.agent = agent; },
            // No live streaming into the task output: that should read as the
            // subagent's CONCLUSION. `run.text` below is the cleaned final message.
          });
          const entry = existing || { id: agentId, type, messages: [] };
          entry.messages = run.messages;
          entry.type = type;
          rememberSubagent(agentId, entry);
          appendTaskOutput(task, `\n\n${run.text}`);
          settleTask(task, 'completed');
          if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
        } catch (e) {
          const stopped = controller.signal.aborted;
          settleTask(task, stopped ? 'killed' : 'failed', { stopReason: stopped ? 'Stopped by user' : e.message });
          appendTaskOutput(task, `\n[error: ${e.message}]`);
          if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
        } finally {
          if (runId) endRun(runId);
        }
      })();
      runId = registerRun({
        agentId, taskId: task.taskId, type, description,
        steer: (text) => { if (early.agent) early.agent.steer(text); },
        interrupt: () => controller.abort(),
      });

      return `agent_id: ${agentId}\ntask_id: ${task.taskId}\nstatus: running\nnext_step: Continue your work; the result arrives in a later message. Use TaskOutput {task_id: "${task.taskId}"} for a non-blocking check or TaskStop to cancel.`;
    }

    // ---- foreground (the default; Ctrl+B detaches it) ---------------------
    // Registered like Bash's foreground hook so the TUI's ctrl+b can move a long
    // subagent into the background WITHOUT losing its work: the run keeps going,
    // the task record gets the result when it lands, and this call resolves at
    // once with the task id so the parent turn can continue.
    const bgController = new AbortController();
    const onParentAbort = () => bgController.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) return 'Error: the turn was interrupted before the subagent started.';
      ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const agentId = existing ? existing.id : newAgentId();
    const entry = existing || { id: agentId, type, messages: [] };
    rememberSubagent(agentId, entry);

    let detachedId = null;
    const resetForeground = () => { if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null; };
    // Start the run BEFORE the detach hook is installed, so the hook's closure can
    // reference the in-flight promise (it waits on it to record the result).
    // `onProgress` feeds the parent's live-output sink (ctx.onOutput), which the
    // agent tags with THIS tool call's id — the same path Bash uses, so the TUI
    // renders the subagent's stream under the `Using Agent` row and Ctrl+O folds it.
    // The live Agent is captured as soon as `runSubagent` builds it, which is what makes
    // this run controllable from another tool call (or the TUI) without waiting for it to
    // finish. `live` is a box because the handle arrives asynchronously.
    const live = { agent: null };
    const runPromise = runSubagent({
      cfg: subCfg, type, prompt, history, signal: bgController.signal,
      onAgent: (agent) => { live.agent = agent; },
      // `_progressTag` is set by AgentSwarm to the item index, so a swarm's
      // concurrently-running subagents are distinguishable in the live stream.
      // A plain Agent call has no tag and prints its stream unlabelled.
      //
      // `_subTaskId` is also set by AgentSwarm: it names the task THIS subagent owns, so its
      // stream lands on its own row in /tasks instead of being folded into the swarm's single
      // buffer. Without it a 7-item swarm had one task and no way to see what any of them was
      // doing.
      onProgress: (text) => {
        if (ctx._subTaskId) {
          const own = ctx.tasks && ctx.tasks[ctx._subTaskId];
          if (own) appendTaskOutput(own, text);
        }
        if (typeof ctx.onOutput !== 'function') return;
        const tag = ctx._progressTag ? `[${ctx._progressTag}] ` : '';
        ctx.onOutput(tag ? text.split('\n').map((l) => (l ? tag + l : l)).join('\n') : text);
      },
      // Each completed tool call is one unit of progress. Only AgentSwarm supplies the sink;
      // a lone Agent call has no grid to fill and nothing to report to.
      onStep: () => { if (typeof ctx._onSubProgress === 'function') ctx._onSubProgress(); },
    });
    // Registered here so a foreground subagent is reachable by AgentMessage / AgentInterrupt
    // too — that is precisely the case where a user wants to redirect one: it is the run
    // they are watching. Cleared when the run settles, however it settles.
    let runId = registerRun({
      agentId, type, description,
      steer: (text) => { if (live.agent) live.agent.steer(text); },
      interrupt: () => bgController.abort(),
    });
    void runPromise.catch(() => {}).finally(() => { if (runId) { endRun(runId); runId = ''; } });
    if (ctx) {
      ctx._foreground = {
        kind: 'Agent',
        description,
        detach: () => {
          if (detachedId) return detachedId;
          // Hand the in-flight work to a background task. The controller is NOT
          // aborted, so the subagent keeps running.
          const task = createTask(ctx, 'agent', {
            description, agentId, subagentType: type, model: args.model || '', detached: true,
          });
          task._abort = () => bgController.abort();
          detachedId = task.taskId;
          resetForeground();
          void (async () => {
            try {
              const r = await runPromise;
              entry.messages = r.messages; entry.type = type;
              rememberSubagent(agentId, entry);
              appendTaskOutput(task, r.text);
              settleTask(task, 'completed');
              if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
            } catch (e) {
              const stopped = bgController.signal.aborted;
              settleTask(task, stopped ? 'killed' : 'failed', { stopReason: stopped ? 'Stopped by user' : e.message });
              appendTaskOutput(task, `\n[error: ${e.message}]`);
              if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
            } finally {
              // The detached run kept the parent-abort link alive on purpose (an
              // aborted turn kills it); once it settles the link goes too.
              if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort);
            }
          })();
          return task.taskId;
        },
      };
    }
    let run;
    try {
      run = await runPromise;
    } catch (e) {
      resetForeground();
      if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort);
      // Detached: the background task owns the error now, not this call.
      if (detachedId) return `Moved to background as task #${detachedId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${detachedId}"}.`;
      return `Error: subagent failed: ${e.message}`;
    }
    if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort);
    resetForeground();
    if (detachedId) {
      return `Moved to background as task #${detachedId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${detachedId}"}.`;
    }
    entry.messages = run.messages;
    entry.type = type;
    rememberSubagent(agentId, entry);

    // A FAILED subagent returns an error, not an empty string. `run.text` is '' when the Agent
    // died, which the swarm printed as "(no output)" — so four agents that had all failed on one
    // error looked like four agents that had found nothing to say.
    if (run.failed) return `Error: subagent "${agentId}" failed: ${run.failed}`;

    return `agent_id: ${agentId}\n\n${run.text}`;
  },
};