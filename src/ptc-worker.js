// The PTC executor's WORKER SIDE — what actually runs the model's code.
//
// This file is loaded as a `worker_threads` entry, never imported by the main process. Everything it can reach is
// what `parentPort` hands it and the globals below: no `require`, no `process` access beyond what is passed in,
// and no filesystem. The model's code is compiled inside a `vm` context whose only interesting binding is
// `callTool`, which messages the main thread and waits.
//
// WHY A WORKER AND NOT vm ALONE: `vm` is not a security boundary — code in a context can still reach the host
// through a prototype it was handed. The thread is what makes a runaway loop killable: `worker.terminate()` stops
// it without the main process ever yielding, which a `while(true)` in `vm.runInContext` would not.
//
// The code runs as an ASYNC body, so `await callTool(...)` works exactly as it reads.
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const TOOL_NAMES = Array.isArray(workerData && workerData.toolNames) ? workerData.toolNames : [];
const TIMEOUT_MS = Number(workerData && workerData.timeoutMs) > 0 ? workerData.timeoutMs : 120000;

let seq = 0;
const pending = new Map();

/** Ask the main thread to run a tool, and wait for its answer. */
function callTool(name, args) {
  const id = ++seq;
  parentPort.postMessage({ type: 'tool', id, name, args: args == null ? {} : args });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

parentPort.on('message', (m) => {
  if (!m || m.type !== 'tool_result') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.result);
  else p.reject(new Error(String(m.error || 'tool failed')));
});

// ---- the sandbox ---------------------------------------------------------------------------------------------

/** Collect printed lines. `print` is what the model reaches for. */
const out = [];
const write = (...parts) => {
  const line = parts.map((p) => {
    if (typeof p === 'string') return p;
    try { return JSON.stringify(p); } catch { return String(p); }
  }).join(' ');
  // A single line cap keeps a runaway from filling memory before the byte cap is checked.
  out.push(line.length > 8000 ? line.slice(0, 8000) + '…' : line);
};

const sandbox = {
  callTool,
  print: write,
  console: { log: write, error: write, warn: write, info: write },
  JSON,
  Math,
  Date,
  Promise,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Map,
  Set,
  RegExp,
  Error,
  TypeError,
  RangeError,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  // `sleep` is the one timer worth exposing: pacing between calls is a real need, and `setTimeout` would let the
  // code keep the thread alive past the point where the caller wants an answer.
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(ms) || 0, 10000)))),
};

const context = vm.createContext(sandbox, {
  // No `codeGeneration` from strings inside the sandbox: a `new Function` there would be a second, unreviewed way
  // in — and the body the model writes is already compiled below.
  codeGeneration: { strings: false, wasm: false },
});

async function run(code) {
  let script;
  try {
    script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'ptc-sandbox.js' });
  } catch (e) {
    return { ok: false, error: `Syntax error: ${e.message}`, output: '' };
  }

  const timer = setTimeout(() => {
    parentPort.postMessage({ type: 'timeout', ms: TIMEOUT_MS });
    process.exit(0);
  }, TIMEOUT_MS);
  if (timer.unref) timer.unref();

  try {
    const value = await script.runInContext(context, { timeout: TIMEOUT_MS });
    clearTimeout(timer);
    // The returned value is what `return` produced, if anything; `print` already captured stdout.
    let returned;
    if (value !== undefined) {
      try { returned = typeof value === 'string' ? value : JSON.stringify(value); } catch { returned = String(value); }
    }
    return { ok: true, output: out.join('\n'), returned };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: `${e && e.name ? e.name + ': ' : ''}${e && e.message || e}`, output: out.join('\n') };
  }
}

parentPort.on('message', async (m) => {
  if (!m || m.type !== 'run') return;
  const result = await run(String(m.code || ''));
  parentPort.postMessage({ type: 'done', result });
});
