// Toolbelt registry. Each entry exposes the JSON schema (matching hncode's tools)
// plus an async execute(args, ctx) returning a result string.

import * as readMod from './read.js';
import * as writeMod from './write.js';
import * as editMod from './edit.js';
import * as globMod from './glob.js';
import * as grepMod from './grep.js';
import * as bashMod from './bash.js';
import * as todoMod from './todo.js';
import * as fetchUrlMod from './fetch-url.js';
import * as webSearchMod from './web-search.js';
import * as readMediaFileMod from './read-media-file.js';
import * as fileLinesMod from './file-lines.js';
import * as gitMod from './git.js';
import * as askUserQuestionMod from './ask-user-question.js';
import { spec as agentSpec } from './agent.js';
import { spec as agentSwarmSpec } from './agent-swarm.js';
import { TaskListSpec, TaskOutputSpec, TaskStopSpec, TaskWaitSpec, TaskInputSpec } from './tasks.js';
import { AgentListSpec, AgentMessageSpec, AgentInterruptSpec, AgentCloseSpec } from './agent-control.js';
import { TEAM_TOOL_SPECS } from './team.js';
import { spec as notebookSpec } from './notebook.js';
import { spec as diagnosticsSpec } from './diagnostics.js';
import * as memoryMod from './memory.js';
import * as goalMod from './goal.js';
import * as activateSkillMod from './activate-skill.js';
import * as ptcMod from './ptc.js';
import { pluginTools, pluginToolGeneration } from '../plugin.js';



// Built-in tools.
const builtinTools = [
  readMod.spec,
  writeMod.spec,
  editMod.spec,
  globMod.spec,
  grepMod.spec,
  bashMod.spec,
  todoMod.spec,
  fetchUrlMod.spec,
  webSearchMod.spec,
  readMediaFileMod.spec,
  fileLinesMod.spec,
  gitMod.spec,
  askUserQuestionMod.spec,
  agentSpec,
  agentSwarmSpec,
  TaskListSpec,
  TaskOutputSpec,
  TaskStopSpec,
  TaskWaitSpec,
  TaskInputSpec,
  AgentListSpec,
  AgentMessageSpec,
  AgentInterruptSpec,
  AgentCloseSpec,
  notebookSpec,
  diagnosticsSpec,
  memoryMod.spec,
  goalMod.spec,
  activateSkillMod.spec,
  ptcMod.spec,
  ...TEAM_TOOL_SPECS,
];


// Combined list: built-ins + plugin-registered tools. Plugin tools appear after
// built-ins so their names are visible, but built-in names take precedence in
// the byName lookup (first one wins).
export function combinedTools() {
  return [...builtinTools, ...pluginTools];
}

export const tools = builtinTools;
export { builtinTools };

// NOTE: the map is built lazily over combinedTools() so plugin-registered
// tools are resolvable. The previous Map was built from builtinTools only,
// so `llmTools()` advertised a plugin tool to the model but `getTool(name)`
// returned undefined and the call failed with `unknown tool`.
//
// The map is keyed to a REGISTRATION GENERATION: plugin.js bumps the counter
// whenever a tool registers or the plugin set is reloaded. Without that, a
// server connected in the background (MCP connects after first paint) stayed
// "unknown tool" forever, and /reload served the OLD plugin instances while
// fresh modules were imported under new spec objects.
let _byName = null;
let _byNameGeneration = -1;
function toolGeneration() {
  // Read live from plugin.js so any registration source bumps the same counter.
  return pluginToolGeneration();
}
function byNameMap() {
  const gen = toolGeneration();
  if (!_byName || _byNameGeneration !== gen) {
    _byName = new Map();
    for (const t of combinedTools()) if (!_byName.has(t.name)) _byName.set(t.name, t);
    _byNameGeneration = gen;
  }
  return _byName;
}
export function getTool(name) { return byNameMap().get(name); }
export function toolNames() { return combinedTools().map((t) => t.name); }

// Schemas for sending to an LLM (OpenAI `tools` array).
export function llmTools() {
  return combinedTools().map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
