/**
 * ProgrammaticToolCall — let the model orchestrate tools with code instead of one round trip each.
 *
 * THE PROBLEM IT SOLVES: a task like "which of these forty files reference the removed symbol" is forty calls,
 * each with its own inference pass, and every one of those results then sits in the context whether or not it
 * mattered. The reading is mechanical; only the conclusion is worth the tokens.
 *
 * With this tool the model writes the LOOP, and only what it prints comes back. The sandbox holds the forty
 * results, the filtering and the joining; the conversation holds the six files that matched.
 *
 * WHY A SEPARATE TOOL AND NOT `Bash`: a shell would give the model the whole machine and no structure. Here every
 * call goes back through the tool layer — the same approval rules, the same workspace guard, the same tools —
 * and the code can only reach the ones on the allowlist. See src/ptc.js for that list, and ptc-worker.js for the
 * sandbox itself.
 */
import { runProgrammatic, callableTools } from '../ptc.js';

const DESCRIPTION = [
  'Orchestrate tools with JavaScript instead of calling them one at a time.',
  '',
  'WHEN TO USE IT: work that is a LOOP over tool results, or that needs intermediate data the model should not',
  'have to read. Reading twenty files to find the three that mention a symbol; checking every changed file for a',
  'pattern; collecting values from many calls and printing only the ones that matter. The intermediate results',
  'stay inside the sandbox and never enter the conversation — that is the point.',
  '',
  'WHEN NOT TO USE IT: one or two calls, or when you need to READ a result and decide what to do next. Then an',
  'ordinary tool call is shorter and clearer.',
  '',
  'HOW TO WRITE IT: the body of an async function. `await callTool(name, args)` runs a tool and resolves to its',
  'text result. `print(...)` writes a line to the output; `console.log` is the same. Whatever you `return` is',
  'appended. Nothing reaches the conversation except what you print or return.',
  '',
  'Example:',
  '```',
  "const hits = [];",
  "for (const f of (await callTool('Glob', { pattern: 'src/**/*.js' })).split('\\n').filter(Boolean)) {",
  "  const text = await callTool('Grep', { pattern: 'oldSymbol', path: f });",
  "  if (text && !/No matches/.test(text)) hits.push(f);",
  '}',
  'print(`${hits.length} files still reference it`);',
  'print(hits.join(\'\\n\'));',
  '```',
  '',
  // NOT a fixed list: a plugin can contribute tools at any time, and a description built once at import would
  // name a set the model cannot call. `description` is a getter for that reason.
];
const BASE_DESCRIPTION = DESCRIPTION.join('\n');

export const spec = {
  name: 'ProgrammaticToolCall',
  // Built per read so a plugin that loaded after this module is named in the list the model is given.
  get description() {
    return BASE_DESCRIPTION + '\n\nCALLABLE TOOLS: ' + callableTools().join(', ') + '.'
      + '\nAnything else is refused — a shell or a write would escape the sandbox\'s purpose.';
  },
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: [
          'The body of an async function. `await callTool(name, args)` calls a tool; `print(x)` emits a line.',
          'Only what is printed or returned reaches the conversation.',
        ].join(' '),
      },
      purpose: {
        type: 'string',
        description: 'One line naming what the code is for, shown in the transcript.',
      },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    const code = String((args && args.code) || '');
    if (!code.trim()) return 'Error: `code` is empty.';

    const r = await runProgrammatic(code, ctx);
    const parts = [];

    if (r.output) parts.push(r.output);
    if (r.returned != null && String(r.returned).trim()) parts.push(String(r.returned));
    if (r.truncated) parts.push('[output truncated]');

    if (!r.ok) {
      // The error goes LAST, after whatever the code managed to print: a partial result plus the reason it
      // stopped is more useful than the reason alone.
      parts.push(`Error: ${r.error}`);
    }

    // How many tools ran is worth stating — it is the saving this feature exists for, and a model that sees 0 is
    // being told its code never reached a tool.
    if (r.calls.length) parts.push(`(${r.calls.length} tool call${r.calls.length === 1 ? '' : 's'})`);

    return parts.join('\n') || '(no output)';
  },
};
