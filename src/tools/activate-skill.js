/**
 * The ActivateSkill tool: the model loads a skill by name.
 *
 * A skill is a stored procedure — a body of instructions for one kind of job (review a diff, debug a failure,
 * design a UI). Until now the only way to run one was for the USER to type `/skill:<name>`, which means the model
 * could not use a skill at all: it had no idea the directory existed.
 *
 * The system prompt now lists the names and descriptions, and this tool is the other half — the way to act on
 * that list. It returns the BODY, which the model then follows in its own turn.
 *
 * WHY A TOOL AND NOT A SLASH COMMAND: a slash command is handled by the TUI before the model sees anything. This
 * has to be callable mid-turn, in the middle of a multi-step job, when the model realises the remaining work is
 * "review this" and a skill was written for exactly that.
 */
import { listSkills, readSkill, normalizeSkillName } from '../skills.js';

export const spec = {
  name: 'ActivateSkill',
  description: [
    'Load a skill — a stored procedure for a particular kind of work — and return its instructions.',
    '',
    'The available skills are listed in the system prompt under "# Skills", with a one-line description each.',
    'Call this when one of them fits the job in front of you, then follow the returned instructions.',
    '',
    'The body is the skill\'s full text. It is NOT a summary: read it and do what it says.',
    'Use `list` to see everything installed, including anything added since the prompt was built.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more skill names to load, as listed under "# Skills".',
      },
      list: {
        type: 'boolean',
        description: 'Return the installed skills with their descriptions instead of loading one.',
      },
    },
  },
  async execute(args) {
    if (args && args.list) {
      const all = listSkills();
      if (!all.length) return 'No skills are installed. The user can add one with /import-skill.';
      return all.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n');
    }

    const raw = args && args.names;
    const wanted = (Array.isArray(raw) ? raw : (raw ? [raw] : []))
      .map((n) => normalizeSkillName(n))
      .filter(Boolean);
    if (!wanted.length) {
      const all = listSkills();
      const names = all.map((s) => s.name).join(', ');
      return `Error: name a skill to activate. Installed: ${names || '(none)'}`;
    }

    const out = [];
    const missing = [];
    for (const name of wanted) {
      const skill = readSkill(name);
      if (!skill) { missing.push(name); continue; }
      // The header names the skill so a transcript with two of them stays readable; the body is verbatim.
      out.push(`[skill: ${skill.name}]\n\n${skill.body}`);
    }

    if (!out.length) {
      const all = listSkills();
      return `Error: no skill named ${missing.join(', ')}. Installed: ${all.map((s) => s.name).join(', ') || '(none)'}`;
    }
    // A partial miss is worth saying: silently loading one of two would leave the job half-instructed.
    if (missing.length) out.push(`(not installed: ${missing.join(', ')})`);
    return out.join('\n\n---\n\n');
  },
};
