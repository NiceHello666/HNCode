// Subagent type catalog, shared by the Agent tool and AgentSwarm.
//
// Mirrors kimi-code's builtin agent profiles (session/agentLifecycle/profile/profiles.ts):
//   coder    - general software engineering; the only type with editing tools
//   explore  - fast read-only codebase exploration (kimi calls it "explore")
//   plan     - read-only implementation planning; no shell, no editing
//
// Kept in its own module so agent.js and agent-swarm.js can both import it
// without a cycle (agent-swarm used to import it from agent.js, which then
// imported agent-swarm back — the constant was read before it was initialised).

export const DEFAULT_SUBAGENT_TYPE = 'coder';

// Shared prefix kimi puts on every task-agent role prompt. It is what stops a
// subagent from addressing the end user directly or assuming the parent can see
// its context.
const TASK_AGENT_ROLE_PREFIX =
  'You are now running as a subagent. All the `user` messages are sent by the main agent. '
  + 'The main agent cannot see your context, it can only see your last message when you finish the task. '
  + 'You must treat the parent agent as your caller. Do not directly ask the end user questions. '
  + 'If something is unclear, explain the ambiguity in your final summary to the parent agent. '
  // A subagent has no Agent/AgentSwarm in its toolbelt (see DELEGATION_TOOLS), so it
  // must not try: a delegated delegation would have nobody to report to and would
  // nest without bound.
  + 'You cannot delegate: you have no Agent or AgentSwarm tool. Do all of the work yourself.';

// Tools that let an agent hand work to ANOTHER agent. Subagents never get these:
// delegation belongs to the top-level turn the user is watching. kimi expresses
// this through each profile's explicit `tools` allowlist; we enforce it the same
// way plus a hard block, so a future profile that forgets to list its tools
// cannot silently re-enable nesting.
export const DELEGATION_TOOLS = ['Agent', 'AgentSwarm'];

export const SUBAGENT_TYPES = {
  coder: {
    label: 'Coder',
    description: 'The only type that may edit files. For delegated work that changes code.',
    whenToUse: 'Use for non-trivial engineering work: read, edit, run commands, report a compact but complete summary.',
    // An explicit allowlist (not `null` = everything) so Agent/AgentSwarm are
    // excluded. Mirrors kimi's CODER_TOOLS.
    tools: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'FileLines', 'Bash', 'Git',
      'TodoList', 'FetchURL', 'WebSearch', 'ReadMediaFile',
      'TaskList', 'TaskOutput', 'TaskStop', 'TaskWait',
    ],
    prompt:
      `${TASK_AGENT_ROLE_PREFIX}\n\n`
      + 'Your final message is the entire handoff — the parent sees nothing else from your run. '
      + 'Make it technically complete: what you changed and why, the path of every file you touched, '
      + 'how you verified the change (tests or commands run, with results), and anything left undone '
      + 'or worth follow-up. If you are stopped before finishing, the parent receives only what '
      + 'you have written so far, so keep the handoff current.',
  },
  explore: {
    label: 'Explore',
    description: 'Read-only codebase exploration.',
    whenToUse: 'Use for read-only search that needs more than about three queries: find files, grep for a symbol, '
      + 'answer how a module works. Say "quick", "medium" or "thorough". Launch several in parallel when the '
      + 'questions are independent.',
    // Bash is allowed for READ-ONLY commands (git log, ls, find) — the prompt
    // forbids using it to create or modify anything, exactly as kimi does.
    tools: ['Read', 'ReadMediaFile', 'Glob', 'Grep', 'Bash', 'WebSearch', 'FetchURL'],
    prompt:
      `${TASK_AGENT_ROLE_PREFIX}\n\n`
      + 'You are a codebase exploration specialist. Your role is EXCLUSIVELY to search, read, and analyze existing '
      + 'code and resources. You do NOT have access to file editing tools.\n\n'
      + 'Your strengths:\n'
      + '- Rapidly finding files using glob patterns\n'
      + '- Searching code and text with powerful regex patterns\n'
      + '- Reading and analyzing file contents\n'
      + '- Running read-only shell commands (git log, git diff, ls, find, etc.)\n\n'
      + 'Guidelines:\n'
      + '- Use Glob for broad file pattern matching. Prefer patterns with a literal anchor (extension or subdirectory); '
      + 'pure wildcards like `*` or `**/*` are allowed but usually truncate at the match cap.\n'
      + '- Use Grep for searching file contents with regex\n'
      + '- Use Read when you know the specific file path\n'
      + '- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find)\n'
      + '- NEVER use Bash for any file creation or modification commands\n'
      + '- Use WebSearch or FetchURL when a question needs external context; the local codebase remains your primary domain\n'
      + '- Adapt your search depth based on the thoroughness level specified by the caller\n'
      + '- Wherever possible, spawn multiple parallel tool calls for grepping and reading files to maximize speed\n\n'
      + 'You are meant to be a fast agent. Complete the search request efficiently and report your findings clearly '
      + 'in a structured format.',
  },
  plan: {
    label: 'Plan',
    description: 'Read-only implementation planning.',
    whenToUse: 'Use when you need a step-by-step plan, the files involved, and the trade-offs, before editing.',
    // No Bash at all — a planning agent has no shell.
    tools: ['Read', 'ReadMediaFile', 'Glob', 'Grep', 'WebSearch', 'FetchURL'],
    prompt:
      `${TASK_AGENT_ROLE_PREFIX}\n\n`
      + 'Before designing your implementation plan, consider whether you fully understand the codebase areas '
      + 'relevant to the task. If not, recommend the parent agent to use the explore agent '
      + '(subagent_type="explore") to investigate key questions first. In your response, clearly state:\n'
      + '1. What you already know from the information provided\n'
      + '2. What questions remain unanswered that would benefit from explore agent investigation\n'
      + '3. Your implementation plan (either preliminary if questions remain, or final if sufficient context exists)\n\n'
      + 'You are a read-only planning agent: you can read and search files and consult the web, but you have no '
      + 'shell and no file-editing tools. Where the general instructions tell you to make changes with tools, that '
      + 'does not apply to you — do not attempt to run commands or modify files. Your deliverable is the plan '
      + 'itself, returned as your final message.',
  },
  researcher: {
    label: 'Researcher',
    description: 'Read-only investigation; reports findings, changes nothing.',
    whenToUse: 'Use for read-only investigation on the web or in the repo when nothing local may be modified.',
    tools: ['Read', 'ReadMediaFile', 'Grep', 'Glob', 'WebSearch', 'FetchURL'],
    prompt:
      `${TASK_AGENT_ROLE_PREFIX}\n\n`
      + 'You are a research subagent. Investigate with the read-only tools and report findings. '
      + 'Do NOT modify anything.',
  },
};

// The catalog as the Agent tool describes it: one line per type, description and
// the "when to use" guidance the model needs to pick correctly.
export function availableTypes() {
  return Object.entries(SUBAGENT_TYPES)
    .map(([id, t]) => `- ${id}: ${t.description}${t.whenToUse ? `\n  ${t.whenToUse}` : ''}`)
    .join('\n');
}

// The tool allowlist a subagent of `type` may run. Always excludes the delegation
// tools, whatever the profile declares, so nesting is impossible.
export function toolsForSubagent(type, parentFilter) {
  const profile = SUBAGENT_TYPES[type] || SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  const base = Array.isArray(profile.tools) ? profile.tools : null;
  if (base) return base.filter((t) => !DELEGATION_TOOLS.includes(t));
  // No explicit list: derive it from the parent's filter so a narrowed parent
  // (Plan / Focus mode) stays narrowed in the child, minus delegation.
  if (Array.isArray(parentFilter) && parentFilter.length) {
    return parentFilter.filter((t) => !DELEGATION_TOOLS.includes(t));
  }
  return null;   // null = agent.js exposes everything except DELEGATION_TOOLS
}
