// The PTC executor's MAIN side.
//
// Owns a worker, forwards the tool calls it makes to the real tool layer, and enforces the limits the sandbox
// cannot enforce about itself: output size, tool count, and a wall-clock deadline that survives a wedged await.
//
// WHY THE TOOL CALLS COME BACK HERE AT ALL: the tools need `ctx` — the workspace, the approval hook, the session
// — none of which may exist inside the sandbox. The worker sends `{type:'tool', name, args}`, this side runs the
// real tool through `getTool`, and the result crosses back as data. The model's code never holds a function that
// can reach the filesystem; it holds a promise that the host fulfils.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginTools } from './plugin.js';

const here = path.dirname(fileURLToPath(import.meta.url));


/**
 * The tools this program ships that are safe to call from generated code.
 *
 * A hardcoded list is right for the built-ins — whether `Write` belongs in a sandbox is a decision about THIS
 * program, and it should be made once, here, and not by whoever writes the next tool.
 *
 * It is the wrong shape for a PLUGIN, though: a plugin already knows whether its own tool touches anything, and
 * the core cannot keep a list of names it has never heard of. A plugin spec declaring `programmatic: true` joins
 * this set at call time — see `callableTools()`.
 */
const BUILTIN_CALLABLE = [
  'Read', 'FileLines', 'Glob', 'Grep', 'Git', 'FetchURL', 'WebSearch',
  'TodoList', 'TaskList', 'TaskOutput', 'Memory', 'ListTeammates', 'TeamTaskList',
  'ActivateSkill', 'Goal', 'Diagnostics',
];

/**
 * Which tools `callTool` may reach right now.
 *
 * Read fresh on every run rather than captured at import: a plugin loaded after this module still gets in, and a
 * plugin that unloaded takes its tools with it.
 */
export function callableTools() {
  const names = new Set(BUILTIN_CALLABLE);
  for (const t of pluginTools) {
    if (t && t.programmatic === true && t.name) names.add(t.name);
  }
  return [...names];
}

/** Kept for callers that want the built-in set only. */
export const CALLABLE_TOOLS = [...BUILTIN_CALLABLE];

export const DEFAULT_LIMITS = {
  // A code body that orchestrates twenty calls is already unusual; five hundred is a loop that has gone wrong.
  maxToolCalls: 500,
  // What comes back is the whole point of PTC — a cap keeps a runaway `print` from eating the context it saved.
  maxOutputBytes: 32000,
  timeoutMs: 120000,
};

/**
 * Run `code` in a sandbox, letting it call the tools in `CALLABLE`.
 *
 * @param {string} code An async function BODY. `await callTool(name, args)` is available.
 * @param {object} ctx The tool context, passed straight through to each tool.
 * @param {object} [limits] Overrides for `DEFAULT_LIMITS`.
 * @returns {Promise<{ok: boolean, output: string, returned?: string, error?: string, calls: string[], truncated?: boolean}>}
 */
export function runProgrammatic(code, ctx, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  return new Promise((resolve) => {
    let settled = false;
    const calls = [];
    const lines = [];
    let bytes = 0;
    let truncated = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      try { worker.terminate(); } catch { /* already gone */ }
      resolve(result);
    };

    // Resolved ONCE per run, so the list the model is told about and the list the guard enforces are the same one
    // even if a plugin loads while the code is running.
    const callable = new Set(callableTools());
    const worker = new Worker(path.join(here, 'ptc-worker.js'), {
      workerData: { toolNames: [...callable], timeoutMs: lim.timeoutMs },
      // The sandbox needs no stdio and no shared memory.
      stdout: true,
      stderr: true,
    });

    // The wall clock is the OUTER guarantee: if the worker is stuck in a `while(true)` the inner vm timeout can
    // still fire, but if the main thread is waiting on a tool that never answers, only this one saves us.
    const wall = setTimeout(() => {
      finish({ ok: false, error: `timed out after ${lim.timeoutMs}ms`, output: lines.join('\n'), calls });
    }, lim.timeoutMs + 5000);

    worker.on('message', async (m) => {
      if (!m) return;

      if (m.type === 'tool') {
        if (calls.length >= lim.maxToolCalls) {
          worker.postMessage({ type: 'tool_result', id: m.id, ok: false, error: `tool-call limit reached (${lim.maxToolCalls})` });
          return;
        }
        const name = String(m.name || '');
        if (!callable.has(name)) {
          worker.postMessage({ type: 'tool_result', id: m.id, ok: false, error: `${name} is not callable from code` });
          return;
        }
        // Imported here, not at the top: tools/index.js imports the PTC TOOL, which imports this module — a static
        // import would close that cycle and read `spec` before it exists.
        const { getTool } = await import('./tools/index.js');
        const tool = getTool(name);
        if (!tool || typeof tool.execute !== 'function') {
          worker.postMessage({ type: 'tool_result', id: m.id, ok: false, error: `no such tool: ${name}` });
          return;
        }
        calls.push(name);
        try {
          const raw = await tool.execute(m.args || {}, ctx);
          // A media result is structured blocks, not text; code cannot do anything useful with it.
          const value = (raw && typeof raw === 'object' && Array.isArray(raw.media))
            ? '[media result omitted]'
            : (typeof raw === 'string' ? raw : JSON.stringify(raw));
          worker.postMessage({ type: 'tool_result', id: m.id, ok: true, result: value });
        } catch (e) {
          worker.postMessage({ type: 'tool_result', id: m.id, ok: false, error: String((e && e.message) || e) });
        }
        return;
      }

      if (m.type === 'timeout') {
        finish({ ok: false, error: `timed out after ${lim.timeoutMs}ms`, output: lines.join('\n'), calls });
        return;
      }

      if (m.type === 'done') {
        const r = m.result || {};
        let output = String(r.output == null ? '' : r.output);
        // Cap by BYTES, not characters: the model pays for tokens, and a megabyte of ASCII is the worst case.
        if (Buffer.byteLength(output, 'utf8') > lim.maxOutputBytes) {
          output = output.slice(0, lim.maxOutputBytes);
          truncated = true;
        }
        finish({
          ok: !!r.ok,
          output,
          returned: r.returned,
          error: r.error,
          calls,
          truncated: truncated || undefined,
        });
      }
    });

    worker.on('error', (e) => {
      finish({ ok: false, error: String((e && e.message) || e), output: lines.join('\n'), calls });
    });
    worker.on('exit', (code) => {
      // An exit without a `done` is the worker dying: report it rather than hanging the caller for ever.
      if (!settled) finish({ ok: false, error: `sandbox exited with code ${code}`, output: lines.join('\n'), calls });
    });

    worker.postMessage({ type: 'run', code: String(code || '') });
    void bytes;
  });
}
