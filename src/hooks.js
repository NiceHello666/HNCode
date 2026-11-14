// Shell-command hooks — user-configured commands run at lifecycle events,
// mirroring Claude Code's `hooks` feature.
//
// Config lives in ~/.hncode/hooks.json (and an optional per-project
// <workspace>/.hncode/hooks.json that is merged on top):
//
//   {
//     "hooks": {
//       "PreToolUse":  [{ "matcher": "Edit|Write", "command": "npm run lint" }],
//       "PostToolUse": [{ "matcher": "Edit",        "command": "npx prettier --write $FILE" }],
//       "PostToolUseFailure": [{ "matcher": "Bash", "command": "notify-fail.sh" }],
//       "UserPromptSubmit": [{ "command": "echo submitting" }],
//       "SessionStart": [{ "command": "git fetch --quiet" }],
//       "SessionEnd":   [{ "command": "echo bye >> ~/sessions.log" }],
//       "SubagentStop": [{ "command": "echo sub done" }],
//       "PostCompact":  [{ "command": "archive-summary.sh" }],
//       "Notification": [{ "command": "notify-send hncode" }],
//       "Stop":         [{ "command": "echo turn done >> ~/turns.log" }]
//     }
//   }
//
// Each entry runs the command with the shell (bash on POSIX, pwsh on Windows).
// The event payload is passed as JSON on stdin and, for convenience, projected
// into environment variables the command can read directly:
//
//   HNCODE_EVENT            event name (PreToolUse, …)
//   HNCODE_TOOL_NAME        tool name (tool events only)
//   HNCODE_TOOL_ARGS        JSON of the tool args (tool events only)
//   HNCODE_FILE             best-effort path argument (tool events only)
//   HNCODE_PROMPT           the user's prompt (UserPromptSubmit)
//   HNCODE_CWD              working directory the command runs in
//
// Exit codes: 0 = continue. For PreToolUse, a NON-zero exit BLOCKS the tool and
// its stderr (or stdout) becomes the message the model sees. For every other
// event a failure is only logged, never fatal — a broken hook must not stop a
// turn. Hooks are best-effort and time-bounded (see HOOK_TIMEOUT_MS).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

// Events the core emits. Kept explicit so a typo in config is reported instead
// of silently never firing.
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'FileChanged',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'ConfigChange',
  'CwdChanged',
];

/** What each event means, shown by /hooks so the panel is a reference rather than a bare list of names. */
export const HOOK_EVENT_HINTS = {
  SessionStart: 'a session opens or resumes',
  SessionEnd: 'a session is closing',
  UserPromptSubmit: 'before your prompt is sent',
  PreToolUse: 'before a tool runs; can block it',
  PermissionRequest: 'a tool needs your approval',
  PostToolUse: 'after a tool succeeds',
  PostToolUseFailure: 'after a tool fails',
  FileChanged: 'after a file is written or edited',
  Stop: 'the model finishes a turn',
  SubagentStart: 'a subagent is spawned',
  SubagentStop: 'a subagent finishes',
  PreCompact: 'before history is summarized',
  PostCompact: 'after history is summarized',
  Notification: 'the app needs your attention',
  ConfigChange: 'a setting or config file changes',
  CwdChanged: 'the working directory changes',
};


// A hook that hangs must not hang the agent. 60s is generous for a formatter or
// a lint pass and still bounded.
export const HOOK_TIMEOUT_MS = 60 * 1000;

export function globalHooksFile() {
  return process.env.HNCODE_HOOKS_FILE || path.join(os.homedir(), '.hncode', 'hooks.json');
}
export function projectHooksFile(workspace) {
  return path.join(workspace || process.cwd(), '.hncode', 'hooks.json');
}

// Parse one hooks file. Returns { hooks: {event: [entry]}, errors: [string] }.
// A malformed file yields empty hooks and a recorded error, never a throw.
function readHooksFile(file) {
  const out = { hooks: {}, errors: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    out.errors.push(`${file}: invalid JSON (${e.message})`);
    return out;
  }
  const raw = (doc && doc.hooks) || {};
  for (const [event, list] of Object.entries(raw)) {
    if (!HOOK_EVENTS.includes(event)) { out.errors.push(`${file}: unknown event "${event}"`); continue; }
    const entries = Array.isArray(list) ? list : [list];
    const clean = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object' || typeof e.command !== 'string' || !e.command.trim()) {
        out.errors.push(`${file}: ${event} entry needs a non-empty "command"`);
        continue;
      }
      clean.push({
        command: e.command,
        matcher: typeof e.matcher === 'string' ? e.matcher : '',
        timeoutMs: Number.isFinite(e.timeout) ? Math.max(1, e.timeout) * 1000 : HOOK_TIMEOUT_MS,
        source: file,
      });
    }
    if (clean.length) out.hooks[event] = clean;
  }
  return out;
}

// Merge global + project hooks. Project entries run AFTER global ones so a
// project can add to (not replace) the user's setup.
export function loadHooks(workspace) {
  const merged = {};
  const errors = [];
  const files = workspace
    ? [globalHooksFile(), projectHooksFile(workspace)]
    : [globalHooksFile()];
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;         // global === project (workspace is ~)
    seen.add(abs);
    const { hooks, errors: errs } = readHooksFile(abs);
    errors.push(...errs);
    for (const [ev, list] of Object.entries(hooks)) {
      merged[ev] = (merged[ev] || []).concat(list);
    }
  }
  return { hooks: merged, errors };
}

// Does this entry apply to `toolName`? An empty matcher matches everything; a
// non-empty one is a case-insensitive alternation of exact names (Claude Code's
// `Edit|Write` form).
export function matcherApplies(matcher, toolName) {
  if (!matcher) return true;
  if (!toolName) return true;
  const name = String(toolName);
  return matcher.split('|').map((s) => s.trim()).filter(Boolean)
    .some((m) => m.toLowerCase() === name.toLowerCase());
}

// The path-ish argument of a tool call, for HNCODE_FILE. Best-effort: it only
// needs to help a formatter/linter, not to be authoritative.
function fileArgFor(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of ['path', 'file_path', 'filePath', 'file']) {
    if (typeof args[k] === 'string' && args[k]) return args[k];
  }
  return '';
}

// Build the environment for a hook invocation from the event payload.
export function hookEnv(event, payload, cwd) {
  const p = payload || {};
  const env = { ...process.env, HNCODE_EVENT: event, HNCODE_CWD: cwd || process.cwd() };
  if (p.toolName) env.HNCODE_TOOL_NAME = String(p.toolName);
  if (p.toolArgs !== undefined) env.HNCODE_TOOL_ARGS = JSON.stringify(p.toolArgs);
  const f = fileArgFor(p.toolArgs);
  if (f) env.HNCODE_FILE = f;
  if (p.prompt !== undefined) env.HNCODE_PROMPT = String(p.prompt);
  return env;
}

function shellCommand() {
  if (process.platform === 'win32') return { bin: 'pwsh', flag: '-Command' };
  return { bin: '/bin/sh', flag: '-c' };
}

// Run ONE hook entry. Resolves to
//   { ok: true, stdout, stderr, exitCode }            — command exited 0
//   { ok: false, blocked: bool, message, ... }        — non-zero / timeout
// Never rejects: a hook failure is data, not an exception.
export function runHookCommand(entry, event, payload, cwd) {
  return new Promise((resolve) => {
    const { bin, flag } = shellCommand();
    let child;
    try {
      child = cp.spawn(bin, [flag, entry.command], {
        cwd: cwd || process.cwd(),
        env: hookEnv(event, payload, cwd),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, blocked: false, message: `could not start: ${e.message}`, exitCode: null });
      return;
    }
    let out = '', err = '';
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, blocked: event === 'PreToolUse', message: `timed out after ${entry.timeoutMs / 1000}s`, exitCode: null });
    }, entry.timeoutMs);

    if (child.stdout) child.stdout.on('data', (d) => { out += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, blocked: false, message: e.message, exitCode: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true, stdout: out, stderr: err, exitCode: 0 });
      else finish({
        ok: false,
        blocked: event === 'PreToolUse',
        message: (code === null ? 'terminated' : `exit ${code}`),
        stdout: out, stderr: err, exitCode: code,
      });
    });
    // Feed the payload as JSON on stdin (some hooks prefer parsing it).
    try {
      if (child.stdin) {
        child.stdin.end(JSON.stringify({ event, ...(payload || {}) }));
      }
    } catch { /* stdin already gone: the env vars are still available */ }
  });
}

// Run every hook for `event`. Returns
//   { blocked, reason, results: [...] }
// `blocked` is true only when a PreToolUse hook failed — that is the one event
// whose exit code changes control flow (the tool must not run).
export async function runShellHooks(config, event, payload, cwd) {
  const list = (config && config.hooks && config.hooks[event]) || [];
  if (!list.length) return { blocked: false, reason: '', results: [] };
  // Tool events respect their matcher: a `matcher: "Edit"` hook must fire only
  // for Edit, for BOTH PreToolUse and PostToolUse. Applying it to PreToolUse
  // alone made a PostToolUse hook run on every tool — a "format after edit" hook
  // ran after reads and searches too.
  const isToolEvent = event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure';
  const results = [];
  for (const raw of list) {
    // A hook entry can arrive from a CONFIG FILE (which fills in the defaults) or from a caller that built it by
    // hand — a test, a plugin, or one of the TUI-side notifications. The timeout must exist in both cases: an
    // undefined one made setTimeout fire at once and reported "timed out after NaNs" without ever running the
    // command.
    const entry = { ...raw, timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : HOOK_TIMEOUT_MS };
    if (isToolEvent && !matcherApplies(entry.matcher, payload && payload.toolName)) continue;
    const r = await runHookCommand(entry, event, payload, cwd);
    results.push({ entry, ...r });
    if (!r.ok) {
      // The message the model sees: prefer stderr, fall back to stdout.
      const msg = (r.stderr || r.stdout || r.message || 'hook failed').trim();
      if (event === 'PreToolUse') {
        return { blocked: true, reason: msg || 'blocked by a PreToolUse hook', results };
      }
      // Other events: log only, keep going.
      try { console.error(`[hncode-hook] ${event} (${entry.source}): ${msg}`); } catch {}
    }
  }
  return { blocked: false, reason: '', results };
}

// Human-readable summary for /hooks.
//
// EVERY EVENT IS LISTED, including the ones with nothing configured. The old version printed a single
// "No hooks configured." line when the config was empty, which told the user nothing about what COULD be hooked
// and left the panel almost blank. Listing the full set is what makes the screen a reference: a reader sees the
// eleven events, which of them are active, and where the files live, without having to read the docs first.
export function describeHooks(config, workspace) {
  const hooks = (config && config.hooks) || {};
  const lines = [];
  const total = HOOK_EVENTS.reduce((a, ev) => a + ((hooks[ev] || []).length), 0);
  lines.push(`${total} hook${total === 1 ? '' : 's'} configured across ${HOOK_EVENTS.length} events.`, '');
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] || [];
    const hint = HOOK_EVENT_HINTS[ev] || '';
    lines.push(`${ev}${hint ? ` — ${hint}` : ''}: ${list.length ? `${list.length} configured` : '(none)'}`);
    for (const e of list) {
      lines.push(`  ${e.matcher ? `[${e.matcher}] ` : ''}${e.command}`);
      lines.push(`      (${e.source})`);
    }
  }
  lines.push('', `Global file:  ${globalHooksFile()}`, `Project file: ${projectHooksFile(workspace || process.cwd())}`);
  return lines;
}