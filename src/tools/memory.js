// Memory tool — the agent records a durable note for FUTURE sessions.
//
// Distinct from /personal: that file is the USER's standing preferences and the
// agent must never write it. This tool writes MEMORY.md, which is the agent's own
// scratchpad, injected into the system prompt on later turns (see config.js's
// readMemory). The point is to stop rediscovering the same facts every session —
// build quirks, a command that works here, a decision the user already made.

import { appendMemory, removeMemory, readMemoryRaw, memoryFile } from '../config.js';

export const spec = {
  name: 'Memory',
  description: `Save a durable note for FUTURE sessions, list what is saved, or remove one that is no longer true.

Use it for something still true next week that you would otherwise rediscover: a build or test command that
works here, a layout quirk, a convention the user asked for, a decision already made, a gotcha that cost a
debugging cycle.

Not for: what is already in AGENTS.md or the code (read it — that is the source); the current task or its
progress (that is TodoList; this file outlives the task); secrets, tokens, credentials, or anything the user
asked you to keep quiet; one-off details.

Remove a note whose rule has stopped being true — a stale rule keeps steering later sessions and is worse than no
rule at all. Pass enough of its text to identify it; every note containing that text is dropped.

One short note per call, in the user's language. Prefer several small notes over one long entry.
project (default) follows the repository; global applies to every workspace.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'remove'],
        description: 'add a note, list what is stored, or remove one. Defaults to add.',
      },
      note: {
        type: 'string',
        description: 'The note to save when adding; when removing, any text that identifies it.',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Which memory to write to. Defaults to project.',
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    // A malformed argument must not throw: an uncaught error here aborts the turn.
    const action = String(args.action || 'add').toLowerCase();
    const scope = String(args.scope || 'project').toLowerCase() === 'global' ? 'global' : 'project';
    const workspace = (ctx && (ctx.workspace || ctx.cwd)) || process.cwd();

    if (action === 'list') {
      const project = readMemoryRaw('project', workspace).trim();
      const global = readMemoryRaw('global', workspace).trim();
      const out = [];
      out.push(`project (${memoryFile('project', workspace)}):`);
      out.push(project || '  (empty)');
      out.push('');
      out.push(`global (${memoryFile('global', workspace)}):`);
      out.push(global || '  (empty)');
      return out.join('\n');
    }

    if (action === 'remove') {
      // REMOVAL IS BY MATCHING TEXT, not by index: the caller knows what a note SAYS, and re-reading the file to
      // find its line number is a step that can go stale between the read and the write.
      const needle = String(args.note == null ? '' : args.note).trim();
      if (!needle) return 'Error: `note` is required when action is "remove" — pass text from the note.';
      const { removed, kept } = removeMemory(scope, workspace, needle);
      if (!removed) return `No ${scope} note matched ${JSON.stringify(needle)}; nothing removed.`;
      return `Removed ${removed} ${scope} note(s); ${kept} left standing.`;
    }
    if (action !== 'add') {
      return `Error: unknown action ${JSON.stringify(action)}; use "add", "list" or "remove".`;
    }
    const note = String(args.note == null ? '' : args.note).trim();
    if (!note) return 'Error: `note` is required when action is "add".';
    // Guard against the file quietly becoming a transcript. The tool is for durable
    // facts, and a pasted log is neither durable nor a fact.
    if (note.length > 600) {
      return `Error: the note is ${note.length} characters; keep it under 600 (save a summary, not a dump).`;
    }
    try {
      const file = appendMemory(scope, workspace, note);
      return `Saved to ${scope} memory (${file}).`;
    } catch (e) {
      return `Error writing memory: ${e.message}`;
    }
  },
};
