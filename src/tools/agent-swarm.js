// AgentSwarm tool — launch many subagents from ONE prompt template, mirroring
// kimi-code's AgentSwarm.
//
//   prompt_template: 'Review {{item}} for regressions.'
//   items: ['src/a.ts', 'src/b.ts']        -> two subagents
//
// Enforced rules (same as kimi):
//   * at least 2 items unless resume_agent_ids is given
//   * whenever items are present, prompt_template is required and must contain
//     the {{item}} placeholder
//   * the filled-in prompts must be distinct
//   * at most 128 items
//   * swarm runs are queued, so a large swarm does not spawn 128 processes at once

import { spec as agentSpec } from './agent.js';
import { SUBAGENT_TYPES, DEFAULT_SUBAGENT_TYPE } from '../subagent-types.js';
import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;
// How many subagents run at once. Each worker awaits ONE subagent at a time, so this is the
// number of models generating concurrently — the reason a swarm exists at all, given that
// `Agent` calls in one message are run in sequence.
const SWARM_CONCURRENCY = 7;

/**
 * Median of a list of numbers, or 0 when there is nothing to go on.
 *
 * Median rather than mean: one agent that loops for a hundred steps would drag a mean far
 * above what a typical agent costs, and every other bar would then sit near empty while its
 * agent was in fact nearly done.
 */
function medianSteps(counts) {
  if (!Array.isArray(counts) || !counts.length) return 0;
  const sorted = counts.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}


// Validate and expand the swarm request. Returns { prompts } or { error }.
export function planSwarm(args) {
  const items = Array.isArray(args.items) ? args.items.map((s) => String(s).trim()).filter(Boolean) : [];
  const template = args.prompt_template == null ? '' : String(args.prompt_template);
  // `typeof [] === 'object'`, so an array was previously accepted and turned
  // into [['0', ...], ['1', ...]] — the swarm then tried to resume agents
  // named "0"/"1". Require a plain object.
  const resumeMap = (args.resume_agent_ids
    && typeof args.resume_agent_ids === 'object'
    && !Array.isArray(args.resume_agent_ids))
    ? Object.entries(args.resume_agent_ids).map(([id, p]) => [String(id).trim(), String(p).trim()])
    : [];

  // The SHAPE is checked before the counts, so the message names the field that is wrong. An
  // array of ids used to be silently dropped, and the caller was then told to provide "a
  // resume_agent_ids map" — which it had given, in the only shape it knew.
  if (args.resume_agent_ids !== undefined
      && (typeof args.resume_agent_ids !== 'object' || Array.isArray(args.resume_agent_ids))) {
    return { error: 'Error: `resume_agent_ids` must be an object mapping agent_id to prompt, such as {"<agent_id>": "continue"}. An array of ids is not accepted.' };
  }
  if (args.items !== undefined && !Array.isArray(args.items)) {
    return { error: 'Error: `items` must be an array of strings.' };
  }
  // Blank entries were dropped above. Two blank items is a request the caller THINKS it made, and
  // "provide at least 2 items" reads as a refusal of something that was provided.
  const rawCount = Array.isArray(args.items) ? args.items.length : 0;
  if (rawCount > 0 && items.length < rawCount && items.length + resumeMap.length < 2) {
    return { error: `Error: ${rawCount} item(s) given but ${rawCount - items.length} were blank, leaving ${items.length}. Each item must be a non-empty string.` };
  }
  if (items.length === 0 && resumeMap.length === 0) {
    return { error: 'Error: provide at least 2 items, or a resume_agent_ids map.' };
  }
  if (items.length === 1 && resumeMap.length === 0) {
    return { error: 'Error: at least 2 items are required (a single task should use the Agent tool instead).' };
  }
  if (items.length > MAX_AGENT_SWARM_SUBAGENTS) {
    return { error: `Error: at most ${MAX_AGENT_SWARM_SUBAGENTS} subagents per swarm (got ${items.length}).` };
  }
  if (items.length > 0 && !template.trim()) {
    return { error: 'Error: `prompt_template` is required whenever `items` are present.' };
  }
  if (items.length > 0 && !template.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    return { error: `Error: \`prompt_template\` must contain the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.` };
  }
  const prompts = items.map((it) => template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(it));
  const uniq = new Set(prompts);
  if (uniq.size !== prompts.length) {
    return { error: 'Error: two items expand to the same prompt — make each item distinct.' };
  }
  return { prompts, resumeMap };
}

export const spec = {
  name: 'AgentSwarm',
  description: `Run the same task over many inputs, one subagent each, in parallel. Only exists while swarm mode is on (/swarm).

Give \`prompt_template\` containing \`${PROMPT_TEMPLATE_PLACEHOLDER}\` and \`items\`; each item replaces the placeholder in one prompt. At least 2 items are required unless you pass \`resume_agent_ids\`, and the filled-in prompts must differ. Use \`resume_agent_ids\` (id → prompt, usually "continue") to revive subagents from earlier work; it can be combined with \`items\`. Up to ${MAX_AGENT_SWARM_SUBAGENTS}; launches queue themselves.

For two or three differently-shaped tasks use separate \`Agent\` calls instead — though several Agent calls in one message run one at a time, so a swarm is the only way to overlap three subagents at once. Never start one on your own initiative: it needs the same explicit permission as \`Agent\`. If this is called, it must be the ONLY tool call in the response.`,
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description for the whole swarm.' },
      subagent_type: { type: 'string', description: `Subagent type used for every new subagent spawned from items; defaults to ${DEFAULT_SUBAGENT_TYPE}.` },
      prompt_template: { type: 'string', description: `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.` },
      items: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_AGENT_SWARM_SUBAGENTS,
        description: `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      },
      fork: { type: 'boolean', default: false, description: "Fork the current context for every item-spawned subagent: each starts with a snapshot of this agent's completed conversation history." },
      resume_agent_ids: { type: 'object', description: 'Map of existing subagent agent_id to the prompt used to resume that subagent. Resumed subagents are launched before new item-based subagents.' },
      model: { type: 'string', description: 'Which model to run the item-spawned subagents on, or "primary" for the current model.' },
    },
    required: ['description'],
  },

  async execute(args, ctx) {
    const description = String(args.description || '').trim();
    if (!description) return 'Error: `description` is required.';

    const plan = planSwarm(args);
    if (plan.error) return plan.error;

    const type = SUBAGENT_TYPES[args.subagent_type] ? args.subagent_type : DEFAULT_SUBAGENT_TYPE;

    // Build the work list: resumes first (kimi launches them before new items).
    const jobs = [
      ...plan.resumeMap.map(([agentId, prompt]) => ({ kind: 'resume', agentId, prompt })),
      ...plan.prompts.map((prompt) => ({ kind: 'new', prompt })),
    ];

    // The swarm runs in the FOREGROUND by default, like Bash and Agent: this call
    // does not return until every subagent has finished, so the turn waits for the
    // result. The task record exists from the start so Ctrl+B can hand the run to
    // the background mid-flight (the TUI's ctrl+b calls `ctx._foreground.detach`).
    const task = createTask(ctx, 'agent', {
      description: `${description} (${jobs.length} subagents)`,
      subagentType: type,
      model: args.model || '',
      detached: false,
    });

    // ONE TASK PER SUBAGENT, parented to this one. A foreground subagent creates no task of
    // its own, so a 7-item swarm put a single row in /tasks and there was no way to see what
    // each subagent was doing — the panel is organised by task, so no task meant no window.
    const subTasks = jobs.map((job, i) => {
      const t = createTask(ctx, 'agent', {
        description: `${description} #${i + 1}`,
        subagentType: type,
        model: args.model || '',
        detached: true,
        parentTaskId: task.taskId,
      });
      return t;
    });

    // Run with a bounded window. Each job appends its verdict to the task output
    // as it finishes, so TaskOutput shows partial progress.
    const results = new Array(jobs.length).fill(null);
    // Tool-call counts of the agents that have FINISHED, so a running agent's bar can be
    // scaled against what the swarm is actually costing. A running agent does not contribute
    // here — its own count is still growing and would understate the reference.
    const finishedSteps = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const job = jobs[i];
        const subTask = subTasks[i];
        // Announce the START, not only the finish. Without this the only signal on the wire
        // was "[n/m] finished", which says how many are DONE and nothing about which are
        // running — so the progress block marked everything unfinished as "queued" and a
        // 7-wide swarm looked like one working cell and six stuck ones.
        if (typeof ctx.onOutput === 'function') ctx.onOutput(`[#${i + 1}] started\n`);
        appendTaskOutput(task, `[#${i + 1}] started\n`);
        // Declared OUTSIDE the try: the catch below still has to report this agent's cost,
        // and the block that does so runs whether the agent succeeded or threw.
        const t0 = Date.now();
        let steps = 0;
        try {
          const subArgs = {
            prompt: job.prompt,
            description: `${description} #${i + 1}`,
            ...(job.kind === 'resume' ? { resume: job.agentId } : { subagent_type: type }),
            ...(job.kind === 'resume' ? { resume: job.agentId } : { subagent_type: type }),
            ...(args.model ? { model: args.model } : {}),
            ...(args.fork === true && job.kind === 'new' ? { fork: true } : {}),
          };
          // `steps` counts this agent's tool calls so far. There is no "x of y" to show — a
          // subagent runs with an unbounded step budget — so the bar is paced against the
          // swarm's OWN observed speed: the median number of steps the agents that have
          // already FINISHED needed. That is the only estimate available, and it sharpens as
          // more of them land.
          //
          // The reference is never allowed to be 0. An agent that answers straight from the
          // prompt runs no tools at all, so it finishes with 0 steps — and a median of 0 would
          // send EVERY other agent down the elapsed-time branch below, where the bar needs a
          // full minute to reach 40% and a fast agent reports 0% the whole way. One tool-less
          // agent must not disable the scale for the rest of the swarm.
          const progressLine = () => {
            if (typeof ctx.onOutput !== 'function') return;
            const reference = Math.max(1, medianSteps(finishedSteps));
            const ratio = finishedSteps.length
              ? Math.min(0.95, steps / (reference + 1))
              // Nothing has finished yet, so there is no pace to compare against. Creep
              // rather than assert a figure: `steps` alone would read as a tiny percentage
              // next to an unknown total.
              : Math.min(0.4, steps / 40, 0.1 + ((Date.now() - t0) / 60000) * 0.3);
            ctx.onOutput(`[#${i + 1}] progress ${Math.round(ratio * 100)}\n`);
          };
          const out = await agentSpec.execute(subArgs, {
            ...ctx,
            _progressTag: `#${i + 1}`,
            _subTaskId: subTask.taskId,
            _onSubProgress: () => { steps++; progressLine(); },
          });
          // `agentSpec.execute` returns `agent_id: <id>\n\n<handoff>`. The swarm's
          // caller wants the handoff, and the id is only useful for a later
          // `resume`; keep it on one labelled line rather than letting it lead the
          // block, so the reported text is what each subagent actually produced.
          const raw = String(out);
          const m = /^agent_id:\s*(\S+)\s*\n+([\s\S]*)$/.exec(raw);
          // A subagent that died returns `Error: subagent … failed: …` rather than throwing, so
          // the catch below never sees it. Without this test the cell was marked a success and
          // the failure text was buried in a body nobody reads as an error.
          const died = /^Error: subagent /.test(raw);
          const body = (m ? m[2] : raw).trim();
          const head = `--- #${i + 1}${job.kind === 'resume' ? ` (resumed ${job.agentId})` : ''}${m ? ` [${m[1]}]` : ''} ---`;
          results[i] = `${head}\n${body}`;
          settleTask(subTask, died ? 'failed' : 'completed', died ? { stopReason: body } : undefined);
        } catch (e) {
          results[i] = `--- #${i + 1} ---\n[error: ${e.message}]`;
          settleTask(subTask, 'failed', { stopReason: e.message });
        }
        // Contribute this agent's cost to the reference the running ones scale against. A
        // Contribute this agent's cost to the reference the running ones scale against. A
        // failed agent is recorded too: it did that much work, so it says as much about the
        // pace as a successful one, and excluding it would bias the bar optimistically.
        finishedSteps.push(steps);
        // Report progress down BOTH channels, and they are not interchangeable:
        //   * the task buffer feeds TaskOutput and survives a detach;
        //   * `ctx.onOutput` is the LIVE sink the transcript's progress block reads.
        //
        // WHICH agent finished, not just how many. A bare `[n/m]` count left the reader no
        // choice but to assume the first `n` agents were the finished ones — and with
        // SWARM_CONCURRENCY workers pulling from a shared queue, they finish in whatever order
        // they happen to run. The grid then lit up the wrong cells and only agreed with
        // reality once every one of them was done. `[#i] finished` names the agent; the count
        // is kept for readers that only track totals.
        const done = results.filter((r) => r !== null).length;
        const line = `[#${i + 1}] finished [${done}/${jobs.length}]\n`;
        appendTaskOutput(task, line);
        if (typeof ctx.onOutput === 'function') ctx.onOutput(line);
      }
    };
    const runAll = Promise.all(Array.from({ length: Math.min(SWARM_CONCURRENCY, jobs.length) }, worker));

    // Ctrl+B hands the still-running swarm to the background. The task already
    // exists, so detaching only flips who waits on `runAll`: the turn stops
    // blocking and keeps the normal progress lines flowing into the task output.
    let detached = false;
    if (ctx) {
      ctx._foreground = {
        kind: 'AgentSwarm',
        description: `${description} (${jobs.length} subagents)`,
        detach: () => {
          if (detached) return task.taskId;
          detached = true;
          task.detached = true;
          if (ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
          void (async () => {
            try {
              await runAll;
              settleTask(task, 'completed');
              appendTaskOutput(task, results.join('\n\n'));
            } catch (e) {
              settleTask(task, 'failed', { stopReason: e.message });
            }
            if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
          })();
          return task.taskId;
        },
      };
    }

    try {
      await runAll;
    } catch (e) {
      if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
      // Detached: the background continuation owns the outcome now.
      if (detached) return `Moved to background as task #${task.taskId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${task.taskId}"}.`;
      settleTask(task, 'failed', { stopReason: e.message });
      return `Error: swarm failed: ${e.message}`;
    }
    if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
    if (detached) {
      return `Moved to background as task #${task.taskId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${task.taskId}"}.`;
    }
    settleTask(task, 'completed');
    appendTaskOutput(task, results.join('\n\n'));
    if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);

    return `Swarm finished: ${jobs.length} subagent(s).\n\n${results.join('\n\n')}`;
  },
};