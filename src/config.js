// hncode configuration — fully independent of kimi-code-cli.
// Loads ONLY ~/.hncode/config.toml (plus HNCODE_* env overrides). It does NOT
// read ~/.kimi-code/config.toml; hncode and kimi-code are separate products.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parse } from './toml.js';
import { pluginConfigDefaults } from './plugin.js';

// Where the per-user .hncode directory lives. HNCODE_HOME overrides it, mirroring
// Claude Code's CLAUDE_CONFIG_DIR: it lets a test (or a user keeping config on
// another drive) relocate the whole directory instead of writing into the real
// home. Resolved per call, NOT captured once at module load — a test that sets the
// variable has already imported this module by then, and a captured value silently
// wrote into the developer's actual home directory.
function homeDir() {
  return process.env.HNCODE_HOME || os.homedir();
}

export const DEFAULTS = {
  model: '',
  provider: '',
  baseUrl: '',
  apiKey: '',
  protocol: 'openai',
  // Fallback context window when neither config nor /v1/models provides one.
  maxContextTokens: 512000,
  // Fallback output-token limit when neither config nor the model itself provides
  // one. This is the per-response cap, not the context window — most models allow
  // well above the old 4096, but it must stay within what the API accepts.
  maxOutputTokens: 10000,
  reasoning: false,
  workspace: process.cwd(),
  allowExternal: false,
};

// Provider/model catalog upstream — the same source kimi-code uses. Fetched by
// `/provider` → Add so the user can pick a known provider (with its base_url)
// or type a custom one. Shape: { [providerId]: { id, name, api, doc, env,
// models: { [modelId]: { id, name, limit: { context, output }, reasoning, … } } } }.
export const MODELS_DEV_URL = 'https://models.dev/api.json';
let catalogCache = null;
let catalogInFlight = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogFetchedAt = 0;

// Fetch (and memoize) the models.dev catalog. Returns null on failure.
export async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogFetchedAt < CATALOG_TTL_MS) return catalogCache;
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(MODELS_DEV_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = await res.json();
      if (json && typeof json === 'object') {
        catalogCache = json;
        catalogFetchedAt = Date.now();
        return json;
      }
      return null;
    } catch { return null; }
    finally { catalogInFlight = null; }
  })();
  return catalogInFlight;
}

export function hncodeConfigFile() {
  return process.env.HNCODE_CONFIG || path.join(homeDir(), '.hncode', 'config.toml');
}

// ---- personal preferences (/personal) ----
// Free-form markdown the user wants applied on EVERY turn ("reply in Chinese",
// "I use pnpm", "never add a trailing newline", …). Two scopes are merged, the
// project one LAST so it can refine the global one:
//   * global  — ~/.hncode/PERSONAL.md      (every workspace)
//   * project — <workspace>/.hncode/PERSONAL.md  (this workspace only)
// Both are OPTIONAL; a missing/empty file injects nothing. The files are read
// fresh on each turn, so an edit through /personal takes effect immediately.
export function personalPromptFile(scope, workspace) {
  if (scope === 'global') return path.join(homeDir(), '.hncode', 'PERSONAL.md');
  return path.join(workspace || process.cwd(), '.hncode', 'PERSONAL.md');
}

// ---- agent memory (/memory) --------------------------------------------------
// Notes the AGENT writes for itself, as opposed to /personal's user-authored
// preferences. Same shape and same injection points, but a separate file so the
// two never overwrite each other: the user owns PERSONAL.md, the model owns
// MEMORY.md. Two scopes, project LAST so it can refine the global one.
//   * global  — ~/.hncode/MEMORY.md
//   * project — <workspace>/.hncode/MEMORY.md
export function memoryFile(scope, workspace) {
  if (scope === 'global') return path.join(homeDir(), '.hncode', 'MEMORY.md');
  return path.join(workspace || process.cwd(), '.hncode', 'MEMORY.md');
}

// Header for injected memory. Deliberately hedged ("notes, verify before relying")
// so a stale entry written several sessions ago cannot masquerade as fact.
export const MEMORY_PROMPT_HEADER =
  'AGENT MEMORY (notes you wrote in earlier sessions; treat as context, not as\n'
  + 'verified fact — re-check anything a current task depends on):';

export function readMemoryRaw(scope, workspace) {
  try { return fs.readFileSync(memoryFile(scope, workspace), 'utf8'); } catch { return ''; }
}

export function writeMemoryRaw(scope, workspace, text) {
  const file = memoryFile(scope, workspace);
  const value = String(text == null ? '' : text);
  if (!value.trim()) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.replace(/\s+$/, '') + '\n', 'utf8');
  return file;
}

// Append one note to a scope's memory, creating the file if needed. Appending
// (rather than replacing) is what a memory tool needs: the agent records a single
// learning and must not have to re-emit everything it knew before.
export function appendMemory(scope, workspace, note) {
  const text = String(note == null ? '' : note).trim();
  if (!text) return memoryFile(scope, workspace);
  const existing = readMemoryRaw(scope, workspace).trim();
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- ${text.replace(/\s+/g, ' ')}  _(${stamp})_`;
  const body = existing ? `${existing}\n${line}` : line;
  return writeMemoryRaw(scope, workspace, body);
}

export function readMemory(workspace) {
  const parts = [];
  for (const scope of ['global', 'project']) {
    const t = readMemoryRaw(scope, workspace).trim();
    if (t) parts.push(t);
  }
  if (!parts.length) return '';
  return MEMORY_PROMPT_HEADER + '\n' + parts.join('\n\n');
}


// Header placed before the injected preferences, so the model knows where the
// text came from and how much authority it has.
export const PERSONAL_PROMPT_HEADER =
  'USER PERSONAL PREFERENCES (persistent notes from the user; follow them unless\n'
  + 'the current request says otherwise):';

// Raw file content for one scope (no header) — used by /personal's editor.
export function readPersonalPromptRaw(scope, workspace) {
  try { return fs.readFileSync(personalPromptFile(scope, workspace), 'utf8'); } catch { return ''; }
}

// Save one scope. Empty text REMOVES the file (so nothing is injected).
export function writePersonalPrompt(scope, workspace, text) {
  const file = personalPromptFile(scope, workspace);
  const value = String(text == null ? '' : text);
  if (!value.trim()) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.replace(/\s+$/, '') + '\n', 'utf8');
  return file;
}

export function readPersonalPrompt(workspace) {
  const parts = [];
  for (const scope of ['global', 'project']) {
    try {
      const t = fs.readFileSync(personalPromptFile(scope, workspace), 'utf8').trim();
      if (t) parts.push(t);
    } catch { /* no file for this scope: nothing to inject */ }
  }
  if (!parts.length) return '';
  return PERSONAL_PROMPT_HEADER + '\n' + parts.join('\n\n');
}

// ---- AGENTS.md --------------------------------------------------------------
// Project instruction files, mirroring codex's AGENTS.md spec
// (codex-rs/core/gpt_5_2_prompt.md, "AGENTS.md spec"):
//   * a file's scope is the whole directory tree rooted where it sits;
//   * for every file you touch you must obey the AGENTS.md whose scope covers it;
//   * more-deeply-nested files take precedence on conflict;
//   * direct system/user instructions outrank all of them.
// Files are therefore collected from the workspace root DOWN to the working
// directory and injected outermost-first, so the deepest one is read last and
// naturally wins — the same precedence, without a merge step.
//
// This closes a real gap: /init WRITES an AGENTS.md and the prompt advertises it
// as "smarter agent context", but nothing ever read it back.
const AGENTS_MAX_BYTES = 32 * 1024;
const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md', 'AGENTS.override.md'];

export const AGENTS_PROMPT_HEADER =
  'PROJECT INSTRUCTIONS (AGENTS.md). The scope of each file is the directory it sits in,\n'
  + 'so a deeper file is more specific and takes precedence over a shallower one. They apply\n'
  + 'to every file you touch under that directory. The current request and the user\'s direct\n'
  + 'instructions still outrank anything here.'

// Every applicable AGENTS.md, outermost first. `dir` keeps the scope visible.
export function agentsFilesFor(cwd, workspaceRoot) {
  const start = path.resolve(cwd || process.cwd());
  const root = path.resolve(workspaceRoot || start);
  const dirs = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    // Stop at the filesystem root, or once we have walked past the workspace.
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  dirs.reverse();                     // outermost first
  const found = [];
  for (const d of dirs) {
    for (const name of AGENTS_FILENAMES) {
      const p = path.join(d, name);
      try {
        if (!fs.statSync(p).isFile()) continue;
        found.push({ path: p, dir: d });
        break;                        // one instruction file per directory
      } catch { /* not present here */ }
    }
  }
  return found;
}

// The block injected into the system prompt, or '' when the project has none.
export function readAgentsMd(cwd, workspaceRoot) {
  const files = agentsFilesFor(cwd, workspaceRoot);
  if (!files.length) return '';
  const parts = [];
  for (const f of files) {
    try {
      let text = fs.readFileSync(f.path, 'utf8').trim();
      if (!text) continue;
      if (Buffer.byteLength(text, 'utf8') > AGENTS_MAX_BYTES) {
        text = Buffer.from(text, 'utf8').subarray(0, AGENTS_MAX_BYTES).toString('utf8') + '\n[truncated]';
      }
      parts.push(`--- ${f.path} ---\n${text}`);
    } catch { /* unreadable: skip rather than fail the turn */ }
  }
  if (!parts.length) return '';
  return AGENTS_PROMPT_HEADER + '\n\n' + parts.join('\n\n');
}

function loadBaseToml() {
  // Only hncode's own config file participates.
  const f = hncodeConfigFile();
  let base = {};
  try {
    if (fs.statSync(f).isFile()) base = parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`hncode: failed to parse ${f}: ${e.message}`);
  }
  return base;
}


// A TCP port from config.toml, or `fallback` when it is absent or nonsense. TOML
// parses `web_port = 8765` as a number but `web_port = "8765"` as a string, and a
// hand-edited file can hold anything, so both are accepted and everything else
// falls back rather than making the daemon fail to bind on a garbage port.
export function tomlPort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback;
  return Math.floor(n);
}

// A 0-1 ratio from config.toml / env. Accepts a number (0.85), a whole number
// (85 = 85%), or a percent string ("85%"). Anything outside (0,1) falls back.
export function clampRatio(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim();
  const pct = s.endsWith('%');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  const v = pct ? n / 100 : (n > 1 ? n / 100 : n);
  return (v > 0 && v < 1) ? v : fallback;
}

export function resolveConfig() {
  const root = loadBaseToml() || {};
  // Merge plugin-provided defaults UNDER the user's config: an explicitly set
  // Merge plugin-provided defaults UNDER the user's config: an explicitly set
  // user value always wins.
  for (const [k, v] of Object.entries(pluginConfigDefaults || {})) {
    if (!(k in root)) root[k] = v;
  }

  const providers = root.providers || {};
  const models = root.models || {};
  let model = process.env.HNCODE_MODEL || root.model || root.default_model || DEFAULTS.model;
  // No hard-coded provider: fall back to the first one the user configured.
  let providerName = process.env.HNCODE_PROVIDER || root.provider || Object.keys(providers)[0] || DEFAULTS.provider;
  // If no model was named but models exist, adopt the first one under the
  // active provider (so the status line always has a model to show).
  if (!model) {
    const first = Object.keys(models).find((k) => (models[k].provider || '') === providerName)
      || Object.keys(models)[0];
    if (first) model = first;
  }

  let baseUrl = process.env.HNCODE_BASE_URL || root.base_url || root.baseUrl || '';
  let apiKey = process.env.HNCODE_API_KEY || root.api_key || root.apiKey || '';
  let protocol = process.env.HNCODE_PROTOCOL || root.protocol || '';
  // The model actually sent to the API: the [models.*] entry's `model` field
  // when the key names a pool entry, otherwise the literal name.
  const modelEntry = models[model] || {};
  let innerModel = bareModelId(modelEntry.provider || providerName, model, modelEntry);
  
  // A [models.*] entry names its own provider; honour it.
  if (modelEntry.provider) providerName = modelEntry.provider;

  // Optional provider sub-tables: [providers.NAME] base_url / api_key / protocol.
  const prov = providers[providerName];
  if (prov) {
    // Provider sub-table supplements env/root; an explicit HNCODE_* env var
    // always wins, otherwise the provider table fills in the gaps it declares.
    baseUrl = process.env.HNCODE_BASE_URL || (prov.base_url || prov.baseUrl) || baseUrl;
    apiKey = process.env.HNCODE_API_KEY || (prov.api_key || prov.apiKey) || apiKey;
    protocol = process.env.HNCODE_PROTOCOL || (prov.protocol) || protocol;
    innerModel = prov.model || innerModel;
  }
  protocol = protocol || DEFAULTS.protocol;

  // The base URL is used EXACTLY as configured — we only append the API path.
  // (No `/v1` is injected: if the user's base ends in /v1, the result is
  // `<base>/chat/completions`; if it doesn't, it's `<base>/chat/completions` too.)
const b = baseUrl.replace(/\/+$/, '');
  // An empty base URL produces a relative endpoint like "/chat/completions",
  // which fetch() rejects with a URL-scheme error the model can't decode. Leave
  // the endpoint empty instead so the caller can show "not set".
  // ANTHROPIC ALWAYS SPEAKS /v1/messages. A base of `https://api.anthropic.com` (which is what the
  // provider table stores, and what people type) produced `…/messages` and 404'd; adding /v1 only when
  // the base does not already carry a version segment makes both spellings work.
  //
  // The trailing slashes are stripped above, which is what kept `https://api.anthropic.com/v1/` from
  // becoming `…/v1//messages`.
  const versioned = protocol === 'anthropic' && !/\/v\d+$/.test(b) ? `${b}/v1` : b;
  const endpoint = !b ? '' : (protocol === 'anthropic' ? `${versioned}/messages`
    : protocol === 'responses' ? `${b}/responses`
    : `${b}/chat/completions`);

  // Context window: an explicit env/root override wins, then the model's own
  // `contextLength` (discovered from the provider's /v1/models), then the
  // default. This is what stops every model from being pinned to 128k.
  const overrideContext = process.env.HNCODE_MAX_CONTEXT || root.max_context_size || root.max_context_tokens;
  const modelContext = Number(modelEntry.contextLength || modelEntry.context_length || modelEntry.context_window || modelEntry.max_context_size || 0);
  const maxContext = Number(overrideContext || modelContext || DEFAULTS.maxContextTokens);
  // Output limit, resolved like the context window: an explicit override wins, then
  // the model's OWN declared limit (from /v1/models), then the default. Ignoring the
  // model's value pinned every model to the default even when it supported far more.
  const modelMaxOutput = Number(
    modelEntry.maxOutputTokens
    || modelEntry.max_output_tokens   // models.dev `limit.output`, persisted on the entry
    || modelEntry.max_tokens
    || 0,
  );
  const maxOutput = Number(
    process.env.HNCODE_MAX_OUTPUT
    || root.max_output_size
    || (modelMaxOutput > 0 ? modelMaxOutput : DEFAULTS.maxOutputTokens),
  );
  // A NUMBER OR NOTHING: an unparseable value falls back to "not set", which means the provider decides.
  const numOrNull = (v, min, max) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
  };
  // `sampling` gates the whole group. A provider that rejects `temperature` outright — several refuse it for
  // reasoning models — needs a switch, not a magic value nobody can find.
  const samplingOn = process.env.HNCODE_SAMPLING
    ? !/^(0|false|no|off)$/i.test(process.env.HNCODE_SAMPLING)
    : root.sampling !== false;
  const temperature = samplingOn
    ? numOrNull(process.env.HNCODE_TEMPERATURE ?? root.temperature, 0, 2)
    : null;
  const topP = samplingOn
    ? numOrNull(process.env.HNCODE_TOP_P ?? root.top_p, 0, 1)
    : null;
  const presencePenalty = samplingOn
    ? numOrNull(process.env.HNCODE_PRESENCE_PENALTY ?? root.presence_penalty, -2, 2)
    : null;
  const reasoning = process.env.HNCODE_REASONING ? /^(1|true|yes)$/i.test(process.env.HNCODE_REASONING) : !!root.reasoning;
  const allowExternal = process.env.HNCODE_ALLOW_EXTERNAL === '1' || !!root.tool_allow_external_paths;

  return {
    model, provider: providerName, innerModel,
    baseUrl: b, endpoint, apiKey, protocol,
    maxContextTokens: maxContext, maxOutputTokens: maxOutput, reasoning,
    // Sampling. `undefined`/null means "do not send it", which is what lets a provider apply its own
    // default — and what keeps a rejection from becoming a hard failure.
    temperature: temperature == null ? undefined : temperature,
    topP: topP == null ? undefined : topP,
    presencePenalty: presencePenalty == null ? undefined : presencePenalty,
    workspace: process.env.HNCODE_WORKSPACE || root.workspace || DEFAULTS.workspace,
    allowExternal,
    // Standing permission rules (see permissions.js). `[permissions]` in config.toml:
    //   [permissions]
    //   allow = ["Bash(npm run test *)", "Read(./src/**)"]
    //   ask   = ["Bash(git push *)"]
    //   deny  = ["Read(./.env)"]
    // Checked before the mode rules, so a deny cannot be escaped by switching to
    // Auto and an explicit ask still prompts inside it.
    permissions: {
      allow: Array.isArray(root.permissions && root.permissions.allow) ? root.permissions.allow.map(String) : [],
      ask: Array.isArray(root.permissions && root.permissions.ask) ? root.permissions.ask.map(String) : [],
      deny: Array.isArray(root.permissions && root.permissions.deny) ? root.permissions.deny.map(String) : [],
    },
    // A user-supplied system prompt (set via /set-system-prompt). Empty means
    // "use the built-in SYSTEM_PROMPT". Read from config.toml so it persists
    // across restarts.
    systemPrompt: process.env.HNCODE_SYSTEM_PROMPT || root.system_prompt || '',
    // The prompt knobs added alongside it, all editable from /settings › Prompt. Separate
    // keys rather than one blob, because they mean different things: `append` keeps the
    // built-in prompt and adds to it, `personal` is the user's own standing note, and the
    // per-mode ones only apply while that mode is on.
    appendSystemPrompt: process.env.HNCODE_APPEND_SYSTEM_PROMPT || root.append_system_prompt || '',
    planInstructions: root.plan_instructions || '',
    focusInstructions: root.focus_instructions || '',
    swarmInstructions: root.swarm_instructions || '',
    // ---- Web UI daemon -------------------------------------------------------
    // One daemon serves EVERY hncode session on this machine: it holds the fixed
    // port, proxies each session's requests to that session's own loopback
    // server, and reads the sessions on disk for the ones whose TUI has exited.
    // These live in config.toml so the address and the token stay the SAME across
    // restarts — a browser bookmark and a saved token keep working, which is the
    // whole point of a single global UI.
    webHost: process.env.HNCODE_WEB_HOST || root.web_host || '127.0.0.1',
    webPort: tomlPort(process.env.HNCODE_WEB_PORT || root.web_port, 8765),
    webToken: process.env.HNCODE_WEB_TOKEN || root.web_token || '',
    // CALM MODE (/calm-mode): persisted boolean. When true an instruction is
    // appended to the system prompt to suppress narration.
    calmMode: process.env.HNCODE_CALM_MODE
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_CALM_MODE)
      // Backwards-compat: read legacy cool_mode key if calm_mode is not set.
      : (root.calm_mode === true || root.calm_mode === 'true'
         || root.cool_mode === true || root.cool_mode === 'true'),
    subagentModel: process.env.HNCODE_SUBAGENT_MODEL || root.subagent_model || '',
    // SECONDARY MODEL (/secondary-model): the cheap model for side work — /btw,
    // /recap and the compaction summary run on it, so a long main-context model is
    // not billed for a question that needed none of that context. Empty means
    // "use the session's model", which is the safe default: a model choice the user
    // never made should not be invented from a model list.
    secondaryModel: process.env.HNCODE_SECONDARY_MODEL || root.secondary_model || '',
    // OUTPUT STYLE (/output-style): the NAME of a style file under
    // ~/.hncode/output-styles/. Stored as a name, not as the text, so editing the
    // file changes the style without touching config.toml.
    outputStyle: process.env.HNCODE_OUTPUT_STYLE || root.output_style || '',
    // FEATURE FLAGS (/experiments): a table of name -> boolean. Read by
    // experiments.js, which owns the registry and the defaults.
    experiments: (root.experiments && typeof root.experiments === 'object') ? root.experiments : {},
    // SCHEDULED PROMPTS (/schedule): cron-like entries that queue a prompt on a
    // running session. Stored as TOML inline tables under [schedule.<id>].
    schedule: (root.schedule && typeof root.schedule === 'object') ? root.schedule : {},
    // Plugin directory (default: ~/.hncode/plugins). Loaded on every launch so
    // plugins installed via /plugins actually take effect. Set to "" or "false"
    // (config or env) to disable plugin loading entirely; unset means the default.
    pluginDir: (() => {
      const v = process.env.HNCODE_PLUGINS || root.plugins_dir;
      if (v === 'false' || v === false || v === '' || v === null || v === undefined) return v === 'false' || v === false || v === '' ? '' : path.join(homeDir(), '.hncode', 'plugins');
      return v;
    })(),
    // AUTO-UPDATE (/auto-update): when true, hncode checks npm for a newer
    // version at startup and then every 30 minutes, installing in the background
    // without interrupting the session.
    autoUpdate: process.env.HNCODE_AUTO_UPDATE
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_AUTO_UPDATE)
      : (root.auto_update === true || root.auto_update === 'true'),
    // AUTO-COMPACTION (/auto-compact): when true, the agent summarizes older
    // history once a request reaches the trigger ratio of the model context.
    // Default ON. Set `auto_compact = false` (or HNCODE_AUTO_COMPACT=0) to turn it off.
    autoCompact: process.env.HNCODE_AUTO_COMPACT
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_AUTO_COMPACT)
      : !(root.auto_compact === false || root.auto_compact === 'false'),
    // COMPACTION TUNING (config.toml):
    //   compact_threshold  — fraction of the model window at which auto-compaction
    //                        fires (default 0.85 = 85%).
    //   compact_keep_ratio — fraction of the CURRENT usage to KEEP after a
    //                        compaction (default 0.2 = keep ~20% of what was used).
    // Both accept a number (0-1) or a percent string ("85%"). Env overrides:
    // HNCODE_COMPACT_THRESHOLD / HNCODE_COMPACT_KEEP_RATIO.
    compactThreshold: clampRatio(
      process.env.HNCODE_COMPACT_THRESHOLD || root.compact_threshold, 0.85,
    ),
    compactKeepRatio: clampRatio(
      process.env.HNCODE_COMPACT_KEEP_RATIO || root.compact_keep_ratio, 0.2,
    ),
    // TOOL-RESULT TRIMMING (config.toml), the cheaper cousin of compaction: old
    // tool outputs are elided from the REQUEST (never from the saved history) once
    // it grows past the trigger, down to the keep fraction of the tool-result text.
    //   auto_trim          — ON by default; `false` never trims automatically.
    //   trim_threshold     — fire when the request reaches this fraction of the
    //                        model window (default 0.5 = 50%).
    //   trim_keep_ratio    — fraction of the tool-result text to KEEP (default
    //                        0.3 = keep 30%, so ~70% of it is elided).
    // Both accept a number (0-1) or a percent string ("50%"). Env overrides:
    // HNCODE_AUTO_TRIM / HNCODE_TRIM_THRESHOLD / HNCODE_TRIM_KEEP_RATIO.
    autoTrim: process.env.HNCODE_AUTO_TRIM
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_AUTO_TRIM)
      : !(root.auto_trim === false || root.auto_trim === 'false'),
    trimThreshold: clampRatio(
      process.env.HNCODE_TRIM_THRESHOLD || root.trim_threshold, 0.5,
    ),
    trimKeepRatio: clampRatio(
      process.env.HNCODE_TRIM_KEEP_RATIO || root.trim_keep_ratio, 0.3,
    ),
    // Default ON — it only ever adds provider-recognised markers, and an
    // unsupported field on a non-caching gateway is filtered out in cache.js.
    // Set HNCODE_PROMPT_CACHE=0 or `prompt_cache = false` to disable.
    promptCache: process.env.HNCODE_PROMPT_CACHE
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_PROMPT_CACHE)
      : (root.prompt_cache === false || root.prompt_cache === 'false' ? false : true),
    // REDUCED MOTION (/reduced-motion, config.toml or the environment). When on,
    // every animation is replaced by a static or slow-breathing form: the spinner
    // does not rotate, the sweeps do not run, and the pulse does not cycle. For a
    // user who finds the motion distracting or nauseating, and for a terminal that
    // repaints badly, this is the difference between usable and not. Default OFF —
    // motion is the intended experience, so this is an opt-out.
    reducedMotion: process.env.HNCODE_REDUCED_MOTION
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_REDUCED_MOTION)
      : (root.reduced_motion === true || root.reduced_motion === 'true'),
    // SHIMMER EDGE (`shimmer_edge`): `cosine` gives the sweep a soft LEADING edge
    // like codex's, `linear` keeps the original hard-on/soft-off ramp. Exposed
    // because the two are a matter of taste and the cost is one branch.
    shimmerEdge: String(root.shimmer_edge || process.env.HNCODE_SHIMMER_EDGE || 'cosine').toLowerCase() === 'linear'
      ? 'linear' : 'cosine',
    // WEB SEARCH KEYS (`web_search_api_key`).
    //
    // Keyless mode is rate-limited BY IP, so a shared or busy address gets refusals that look like "search is
    // broken". Tavily keys are per account and the tool tries them IN ORDER, so the monthly quota is additive.
    //
    // The value is a LIST, one key per line. It is kept as a STRING here — newline-separated — because that is
    // what the multi-line editor edits and what `setConfigString` writes; splitting happens at the call site so
    // a stray blank line can never count as a key. A single key is a list of one, so an old config still works.
    webSearchApiKey: String(root.web_search_api_key || process.env.HNCODE_WEB_SEARCH_API_KEY || '').trim(),
    raw: root,
  };
}


export function saveConfig(overlay) {
  const dir = hncodeConfigFile();
  const entries = Object.entries(overlay || {});
  if (entries.length === 0) return dir;
  // Render the overlay to TOML lines, preserving key order.
  let out = '';
  for (const [k, v] of entries) out += toTomlLine(k, v) + '\n';
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // Check if file exists and has content
  try {
    if (fs.statSync(dir).isFile()) {
      const existing = fs.readFileSync(dir, 'utf8');
      if (existing.trim().length > 0) {
        // Append to existing config instead of overwriting — but only for keys
        // that are NOT already present as top-level lines, so two saveConfig
        // calls for the same key never produce duplicate keys. Reuse the same
        // "top-level before any [table] header" rule as setConfigString.
        const keys = new Set(entries.map(([k]) => k));
        const lines = existing.split(/\r?\n/);
        const seen = new Set();       // top-level keys already in the file
        let inTable = false;
        for (const ln of lines) {
          if (/^\s*\[/.test(ln)) inTable = true;
          if (!inTable) {
            const km = /^\s*([A-Za-z0-9_]+)\s*=\s*/.exec(ln);
            if (km) seen.add(km[1]);
          }
        }
        // Nothing to add: every overlay key is already present top-level.
        let add = '';
        for (const [k, v] of entries) {
          if (!seen.has(k)) add += toTomlLine(k, v) + '\n';
        }
        if (add) {
          const sep = existing.endsWith('\n') ? '' : '\n';
          fs.writeFileSync(dir, existing + sep + '\n' + add.trimEnd() + '\n', 'utf8');
        }
        return dir;
      }
    }
  } catch {}

  // New file or empty file
  fs.writeFileSync(dir, out, 'utf8');
  return dir;
}

// Persist a top-level string key in config.toml, replacing any previous value.
// Used by /set-system-prompt. Multi-line values are written as a TOML MULTI-LINE
// BASIC STRING ("""…"""), which keeps newlines readable and means the editor can
// round-trip a prompt that contains them. An empty value REMOVES the key, so the
// built-in prompt takes over again.
export function setConfigString(key, value) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;          // inside a multi-line value we are dropping
  let replaced = false;
  const keyRe = new RegExp('^\\s*' + escapeRe(key) + '\\s*=');
  // Track the index of the first table header — new root-level keys must be
  // inserted BEFORE any [table] section, or TOML assigns them to the last table.
  let firstTableIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (skipping) {
      // A multi-line basic string ends at an unescaped """.
      if (/"""\s*$/.test(ln) || /'''\s*$/.test(ln)) skipping = false;
      continue;
    }
    // Detect a TOML table header line like [foo] or [foo.bar] at column 0.
    if (/^\[/.test(ln) && firstTableIdx < 0) firstTableIdx = out.length;
    if (keyRe.test(ln)) {
      // Drop this key's line, and its body if it opens a multi-line string.
      const rest = ln.slice(ln.indexOf('=') + 1).trim();
      const opensMultiline = /^"""|^'''/.test(rest) && !/^"""[\s\S]*"""\s*$/.test(rest);
      if (opensMultiline) skipping = true;
      if (!replaced && value !== '' && value != null) {
        out.push(...renderTomlString(key, String(value)).split('\n'));
        replaced = true;
      }
      continue;
    }
    out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (!replaced && value !== '' && value != null) {
    // Insert new root-level keys BEFORE the first [table] section so they are
    // parsed as root keys, not assigned to a table.
    const rendered = renderTomlString(key, String(value)).split('\n');
    if (firstTableIdx >= 0) {
      out.splice(firstTableIdx, 0, '', ...rendered);
    } else {
      out.push('');
      out.push(...rendered);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  return file;
  return file;
}

// The Web UI's access token, generated ONCE and persisted to config.toml.
//
// It is deliberately not regenerated per launch: the daemon outlives individual
// sessions, and a token that changed on every restart would invalidate every
// browser's saved cookie and force a re-login each time — which defeats having a
// single stable UI. `HNCODE_WEB_TOKEN` overrides for scripted setups.
export function ensureWebToken() {
  const fromEnv = (process.env.HNCODE_WEB_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const cfg = resolveConfig();
  if (cfg.webToken) return cfg.webToken;
  // 32 random bytes, base64url: 43 chars, URL- and cookie-safe, ~256 bits.
  const token = crypto.randomBytes(32).toString('base64url');
  try { setConfigString('web_token', token); }
  catch { /* read-only config: the token lives for this run only */ }
  return token;
}

// Write a boolean root-level key as a TOML LITERAL (`key = true`), not a string.

// Write a boolean root-level key as a TOML LITERAL (`key = true`), not a string.
// setConfigString() renders every value as a quoted string, so `true` would land
// as `"true"` — which reads back as a truthy string rather than a boolean, and
// would make `key = false` truthy. Reuses setConfigString for the surgery (it
// already knows how to replace a key in place and where a new root key goes), then
// rewrites the one line it produced.
export function setConfigBool(key, value) {
  const file = setConfigString(key, String(!!value));
  let text = fs.readFileSync(file, 'utf8');
  const wanted = `${key} = ${value ? 'true' : 'false'}`;
  const re = new RegExp('^\\s*' + escapeRe(key) + '\\s*=\\s*.*$', 'm');
  if (re.test(text)) text = text.replace(re, wanted);
  else text = wanted + '\n' + text;
  fs.writeFileSync(file, text, 'utf8');
  return file;
}


// Render `key = <value>` as TOML. Uses a multi-line basic string when the value
// contains newlines (readable, and TOML-valid), a plain one otherwise.
//
// Layout matters: TOML DISCARDS the newline immediately after `"""`, so the
// value begins on the following line and the closing `"""` must butt up against
// the last character. The previous form (""" + \n + body + \n + """) parsed back
// as `value + '\n'`, and because setConfigString writes back whatever it read,
// every read→write cycle appended another newline (a system prompt gained a
// blank line per edit).
//
//   key = """
//   <value, verbatim>
//   """
function renderTomlString(key, value) {
  if (value.includes('\n')) {
    // Inside """…""" a backslash must be escaped; quotes are fine unless tripled.
    const body = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    // `"""` then a newline (discarded by the parser), then the value, then the
    // closing delimiter on the same line as the value's last line.
    return [`${key} = """`, ...body.split('\n')].join('\n') + '"""';
  }
  return `${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Append (or replace) a [providers.<name>] table in config.toml without
// clobbering unrelated content. Used by /provider's "Add provider…" flow.
export function addProvider(name, { base_url, api_key, protocol, known, catalog } = {}) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const lines = text.split(/\r?\n/);
  // Drop any existing [providers.<name>] block (and its key lines) so it is
  // replaced rather than duplicated. Accepts the BARE and QUOTED header forms
  // (this function writes the quoted one) and unescapes before comparing.
  const unq = (s) => String(s).replace(/\\(.)/g, '$1');
  const provRe = /^\s*\[providers\.\s*(?:"((?:[^"\\]|\\.)*)"|([^\]]+))\s*\]\s*$/;
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    const m = provRe.exec(ln);
    if (m) { skipping = unq(m[1] !== undefined ? m[1] : m[2]) === name; if (skipping) continue; }
    else if (/^\s*\[/.test(ln)) skipping = false;
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push('');
  // Escape backslashes BEFORE quotes (the other order double-escapes), and quote
  // the table key too. Raw interpolation meant a provider name or URL holding a
  // backslash or a quote wrote invalid TOML and broke the ENTIRE config file —
  // every later launch failed until it was repaired by hand.
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  out.push(`[providers.${q(name)}]`);
  if (base_url) out.push(`base_url = ${q(base_url)}`);
  if (api_key) out.push(`api_key = ${q(api_key)}`);
  if (protocol) out.push(`protocol = ${q(protocol)}`);
  // `known` records the SOURCE: true = added from the models.dev catalog, false =
  // a plain endpoint the user typed in. It is written even when false, so the two
  // cases are distinguishable instead of relying on a missing key.
  if (known !== undefined) out.push(`known = ${known ? 'true' : 'false'}`);
  // `catalog` records WHICH models.dev entry this provider maps to, so a renamed
  // provider (e.g. "anthropic-work") still resolves the real catalog id. Only
  // meaningful when `known` is true.
  if (catalog) out.push(`catalog = ${q(catalog)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return file;
}

// Remove a [providers.<name>] table (and its key lines) from config.toml, plus
// every [models."<name>/..."] entry that belongs to it — otherwise /model keeps
// listing the deleted provider's models.
export function removeProvider(name) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return file; }
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  // Table headers may be BARE (`[providers.p]`) or QUOTED (`[providers."p"]`) —
  // addProvider now quotes them so a name containing a quote or backslash stays
  // valid TOML. Match both and unescape before comparing: with the quoted form
  // the old bare-only regex captured `"p"` (quotes included), `=== name` never
  // held, and removeProvider silently deleted nothing.
  const unq = (s) => String(s).replace(/\\(.)/g, '$1');
  const provRe = /^\s*\[providers\.\s*(?:"((?:[^"\\]|\\.)*)"|([^\]]+))\s*\]\s*$/;
  // A models key is `[models."provider/modelId"]`; match the provider prefix.
  const modelRe = /^\s*\[models\.\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
  for (const ln of lines) {
    const pm = provRe.exec(ln);
    if (pm) {
      skipping = unq(pm[1] !== undefined ? pm[1] : pm[2]) === name;
      if (skipping) continue;
    }
    const mm = modelRe.exec(ln);
    if (mm) {
      // The model key starts with `<provider>/`; skip it if it is this provider's.
      const keyProvider = unq(mm[1]).split('/')[0];
      skipping = keyProvider === name;
      if (skipping) continue;
    } else if (/^\s*\[/.test(ln)) {
      skipping = false;
    }
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  return file;
}

// ---- models: fetch + per-provider pools ----
// Models are stored per provider as `[models."provider/model"]`, and also
// mirrored into the provider's own pool at `[providers.NAME].models`. The
// display name defaults to the model id (edit config.toml to override).
export function modelKey(provider, modelId) { return `${provider}/${modelId}`; }

// Append a model under a provider (used by the "add model" flow and by the
// auto-fetch after adding a provider). Idempotent per key.
export function addModel(provider, modelId, opts = {}) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const key = modelKey(provider, modelId);
  if (new RegExp(`^\\s*\\[models\\."${escapeRe(key)}"\\]`, 'm').test(text)) return file; // already there
  // EVERY interpolated string is escaped. These were written raw, so a model id
  // (or provider) containing a quote or backslash produced malformed TOML and
  // the ENTIRE config file stopped parsing — every later launch then failed
  // until the file was repaired by hand. Provider ids and model ids come from
  // remote APIs, so they are not trusted input.
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [`[models.${q(key)}]`, `provider = ${q(provider)}`, `model = ${q(modelId)}`];
  if (opts.display_name) lines.push(`display_name = ${q(opts.display_name)}`);
  // Persist the context window discovered from /v1/models so resolveConfig can
  // size the context bar per model (not a global 128k).
  if (opts.contextLength) lines.push(`context_length = ${Number(opts.contextLength)}`);
  if (opts.maxTokens) lines.push(`max_tokens = ${Number(opts.maxTokens)}`);
  // Per-model output limit (from models.dev `limit.output`, or a provider's
  // `max_output_tokens`). Its own key so it is not confused with `max_tokens`,
  // which some endpoints use for the same thing and others do not.
  if (opts.maxOutputTokens) lines.push(`max_output_tokens = ${Number(opts.maxOutputTokens)}`);
  if (opts.reasoning !== undefined && opts.reasoning !== null) lines.push(`reasoning = ${opts.reasoning ? 'true' : 'false'}`);
  // Thinking levels, from models.dev `reasoning_options` (or a user's own list).
  if (Array.isArray(opts.efforts) && opts.efforts.length) {
    lines.push(`efforts = [ ${opts.efforts.map((e) => `"${String(e).replace(/"/g, '\\"')}"`).join(', ')} ]`);
  }
  lines.push(...costLines(opts.cost));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '\n' + lines.join('\n') + '\n', 'utf8');
  return file;
}

// ---- pricing ----------------------------------------------------------------
// Four flat keys rather than a nested table, because the TOML writer here is
// hand-rolled and a nested `[models."k".cost]` table would have to be tracked
// through three separate writers. Prices are USD per 1M tokens, which is the unit
// models.dev publishes and the unit the cost readout divides by.
const COST_KEYS = {
  input: 'cost_input',
  output: 'cost_output',
  cacheRead: 'cost_cache_read',
  cacheWrite: 'cost_cache_write',
};

/** `{ input, output, cacheRead, cacheWrite }` USD-per-1M -> TOML lines. */
function costLines(cost) {
  if (!cost || typeof cost !== 'object') return [];
  const out = [];
  for (const [field, key] of Object.entries(COST_KEYS)) {
    const n = Number(cost[field]);
    if (Number.isFinite(n) && n > 0) out.push(`${key} = ${n}`);
  }
  return out;
}

/**
 * Convert a models.dev catalog `cost` object into our shape, USD per 1M tokens.
 *
 * ZERO IS A PRICE. The catalog marks a free model as `{input: 0, output: 0}` — 637
 * entries do — and there is no `free` flag to look for. Treating 0 as "missing" (the
 * `n > 0` test) turned every free model into "no pricing", and the readout then fell
 * through to a guess. So the test is `>= 0` and a zero is carried through as a real
 * price: `usageCost` multiplies out to exactly 0 and the readout shows `$0.00`, which
 * is true for a free service.
 */
export function costFromCatalog(cost) {
  if (!cost || typeof cost !== 'object') return undefined;
  const pick = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
  const out = {
    input: pick(cost.input),
    output: pick(cost.output ?? cost.reasoning),
    cacheRead: pick(cost.cache_read ?? cost.cacheRead),
    cacheWrite: pick(cost.cache_write ?? cost.cacheWrite),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/**
 * A stored model entry's pricing, or null when the model has none.
 *
 * Falls back to the ALREADY-FETCHED models.dev catalog. Every model entry written
 * before pricing existed has no cost keys, and re-adding each provider to backfill
 * them is a migration the user should not have to perform — the catalog that
 * produced the entry in the first place already knows the price. The fallback is
 * free (a Map lookup into a memoized object) and silent: when the catalog has not
 * been fetched this session there is simply no fallback, and the readout says the
 * price is unknown rather than guessing.
 */
export function modelCost(cfg, modelKeyName) {
  const models = (cfg && cfg.raw && cfg.raw.models) || {};
  const key = modelKeyName || (cfg && cfg.model);
  const entry = models[key] || {};
  // `>= 0`, like costFromCatalog: a model the user priced at ZERO is priced, and must
  // `>= 0`, like costFromCatalog: a model the user priced at ZERO is priced, and must
  // not fall through to the catalog (which would charge it someone else's rate).
  const pick = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
  const stored = {
    input: pick(entry.cost_input ?? entry.costInput),
    output: pick(entry.cost_output ?? entry.costOutput),
    cacheRead: pick(entry.cost_cache_read ?? entry.costCacheRead),
    cacheWrite: pick(entry.cost_cache_write ?? entry.costCacheWrite),
  };
  if (Object.values(stored).some((v) => v !== undefined)) return stored;
  return catalogCostFor(cfg, entry, key);
}

// ---- catalog price lookup ----------------------------------------------------
// A model entry with no price keys of its own: look it up in models.dev by its EXACT
// provider bucket and model id. That is the whole rule.
//
// WHY THERE IS NO GUESSING BEYOND THAT. An unmatched model belongs to a provider
// models.dev does not list — a local proxy, a company endpoint, someone's free
// gateway — and there is NO WAY to know what it costs. Earlier versions tried to infer
// a price from the model id (a `deepseek-` prefix looked like DeepSeek's vendor entry;
// or the same bare name appearing under other providers, taking the most common rate).
// That produced a CONFIDENT, WRONG number rather than an honest gap: a FREE local
// proxy serving `workbuddy/deepseek-v4.1-flash` was billed DeepSeek's official rate,
// and the status line showed $2.57 for a service that charges nothing.
//
// An invented price is worse than a missing one. The readout omits the cost segment
// entirely when there is no price, which is visibly "unknown"; a wrong number is not
// detectable at all. A provider that resells under a different name can still be
// priced, but only by SAYING SO: `catalog = "<models.dev id>"` on the provider.
//
// The second lookup is the provider's own id inside the bucket: some endpoints report
// a model as `deepseek-ai/deepseek-flash` where the catalog keys it as `deepseek-flash`,
// and taking the last path segment matches that without matching a different model.
function catalogCostFor(cfg, entry, key) {
  if (!catalogCache) return null;
  const providerName = entry.provider || String(key || '').split('/')[0];
  const prov = ((cfg && cfg.raw && cfg.raw.providers) || {})[providerName] || {};
  // `catalog` records which models.dev entry a renamed provider maps to, so a gateway
  // serving a vendor's models under its own name can be priced — because the user
  // declared the mapping, not because we guessed it from the model's name.
  const catalogId = prov.catalog || providerName;
  const modelId = entry.model || String(key || '').split('/').slice(1).join('/');
  const bucket = catalogCache[catalogId];
  if (!bucket || !bucket.models) return null;
  const hit = bucket.models[modelId] || bucket.models[String(modelId).split('/').pop()];
  if (!hit) return null;
  return costFromCatalog(hit.cost) || null;
}


/**
 * USD spent for a token total, given pricing. `usage` is the normalised
 * accumulator shape ({ input, output, cached, cacheWrite }), with `cached` being
 * the part of `input` that was a cache READ — so it is billed at the cache price
 * and the remainder at the input price.
 *
 * Returns null when the model has no pricing: an unknown model must report
 * "unknown", never a made-up $0.00 that reads like "this was free".
 */
export function usageCost(usage, cost) {
  if (!usage || !cost) return null;
  const per = (tokens, price) => (Number(tokens) || 0) / 1e6 * (Number(price) || 0);
  const cached = Number(usage.cached) || 0;
  const input = Number(usage.input) || 0;
  // Cache READS are a subset of the reported input; bill the difference at the
  // plain input rate. Without this the input side was billed twice.
  const freshInput = Math.max(0, input - cached);
  let total = per(freshInput, cost.input) + per(Number(usage.output) || 0, cost.output);
  if (cached) total += per(cached, cost.cacheRead !== undefined ? cost.cacheRead : cost.input);
  if (usage.cacheWrite) total += per(usage.cacheWrite, cost.cacheWrite !== undefined ? cost.cacheWrite : cost.input);
  return total;
}


// Replace (or create) a single `[models."<key>"]` block. Unlike addModel, which is
// append-only and a no-op when the key exists, this REWRITES the block so the
// /model editor can change display name / context / output limits. A key passed as
// undefined or '' is OMITTED, so clearing a field removes it from the file rather
// than writing an empty value. Other tables are left untouched.
export function upsertModel(provider, modelId, opts = {}) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const key = modelKey(provider, modelId);
  const unq = (s) => String(s).replace(/\\(.)/g, '$1');
  const modelRe = /^\s*\[models\.\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    const mm = modelRe.exec(ln);
    if (mm) { skipping = unq(mm[1]) === key; if (skipping) continue; }
    else if (/^\s*\[/.test(ln)) skipping = false;
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push('');
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  out.push(`[models.${q(key)}]`);
  out.push(`provider = ${q(provider)}`);
  out.push(`model = ${q(modelId)}`);
  if (opts.display_name) out.push(`display_name = ${q(opts.display_name)}`);
  if (opts.contextLength) out.push(`context_length = ${Number(opts.contextLength)}`);
  if (opts.maxTokens) out.push(`max_tokens = ${Number(opts.maxTokens)}`);
  if (opts.maxOutputTokens) out.push(`max_output_tokens = ${Number(opts.maxOutputTokens)}`);
  // Pricing, when the caller knows it. A blank means "leave the entry without
  // prices", which is what an entry edited by hand in config.toml keeps.
  out.push(...costLines(opts.cost));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return file;
}

// Replace EVERY `[models."<provider>/*"]` block with the given list, persisting a
// provider's model set after a refresh. `entries` is an array of
// { id, display_name, contextLength, maxTokens, maxOutputTokens, reasoning, efforts }.
// Unlike upsertModel (one key) this is the bulk form: entries the provider no longer
// offers DISAPPEAR from the file, which is what makes Ctrl+R in /provider a real
// refresh rather than an in-memory-only illusion that the next launch undoes.
export function replaceProviderModels(provider, entries) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const unq = (s) => String(s).replace(/\\(.)/g, '$1');
  const modelRe = /^\s*\[models\.\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    const mm = modelRe.exec(ln);
    if (mm) { skipping = unq(mm[1]).split('/')[0] === provider; if (skipping) continue; }
    else if (/^\s*\[/.test(ln)) skipping = false;
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  for (const e of (entries || [])) {
    const id = String(e.id || '').trim();
    if (!id) continue;
    out.push('');
    out.push(`[models.${q(modelKey(provider, id))}]`);
    out.push(`provider = ${q(provider)}`);
    out.push(`model = ${q(id)}`);
    if (e.display_name) out.push(`display_name = ${q(e.display_name)}`);
    if (e.contextLength) out.push(`context_length = ${Number(e.contextLength)}`);
    if (e.maxTokens) out.push(`max_tokens = ${Number(e.maxTokens)}`);
    if (e.maxOutputTokens) out.push(`max_output_tokens = ${Number(e.maxOutputTokens)}`);
    if (e.reasoning !== undefined && e.reasoning !== null) out.push(`reasoning = ${e.reasoning ? 'true' : 'false'}`);
    if (Array.isArray(e.efforts) && e.efforts.length) {
      out.push(`efforts = [ ${e.efforts.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(', ')} ]`);
    }
    out.push(...costLines(e.cost));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  return file;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }



// Fetch the model list from a provider's API. The base URL is used as given and
// we append only `/models` (so `https://host/v1` → `https://host/v1/models`).
// Anthropic sends x-api-key + anthropic-version. Returns [{id, display}] or [].
export async function fetchModels({ baseUrl, apiKey, protocol, throwOnError = false }) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) {
    // `throwOnError` makes a failure LOUD instead of an empty list. The model
    // pickers use the quiet form — "no models" is a normal state there — but a
    // user who pressed "discover models" and got nothing needs to know whether
    // the endpoint refused the key or simply has no catalogue.
    if (throwOnError) throw new Error('no base URL');
    return [];
  }
  const url = `${b}/models`;
  const headers = { 'content-type': 'application/json' };
  if (protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      if (throwOnError) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
      return [];
    }
    const json = await res.json();
    // OpenAI: { data: [{ id }] }  |  Anthropic: { data: [{ id, display_name }] }
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    return arr.map((m) => ({
      id: String(m.id || m.name || ''),
      display: m.display_name || m.displayName || '',
      // Capability hints (servers vary in what they expose).
      contextLength: m.context_length || m.contextLength || m.context_window || undefined,
      maxTokens: m.max_tokens || undefined,          // NEW: per-model token limit from /v1/models
      maxOutputTokens: m.max_output_tokens || m.maxOutputTokens || undefined,
      ownedBy: m.owned_by || undefined,
      // Reasoning support flags, when the server declares them.
      reasoning: m.reasoning === true || m.supports_reasoning === true
        || Array.isArray(m.reasoning_efforts) || Array.isArray(m.supported_efforts)
        || undefined,
      efforts: m.reasoning_efforts || m.supported_efforts || undefined,
    })).filter((m) => m.id);
  } catch (e) {
    if (throwOnError) throw e;
    return [];
  } finally { clearTimeout(timer); }
}

/**
 * Turn models.dev `reasoning_options` into a level list, or null when there is
 * nothing usable. This is the ONLY source of graded thinking levels — we never
 * derive a grade from the model id.
 *
 * The catalog shape is an array of typed entries:
 *   { type: 'effort',        values: ['low','medium','high'] }  -> use `values`
 *   { type: 'budget_tokens', min: 1024 }                        -> on/off
 *   { type: 'toggle' }                                          -> on/off
 * `none` in an effort list means "off"; it is normalised to 'off' and kept first.
 * A model may declare SEVERAL entries and they are not ordered, so the whole array
 * is scanned and an `effort` list wins over the plain toggle. Returns null (not [])
 * when the model declares no options, so the caller can tell "no catalog data" from
 * "explicitly no reasoning".
 */
export function effortsFromReasoning(reasoningOptions) {
  const opts = Array.isArray(reasoningOptions) ? reasoningOptions : [];
  let graded = null;
  let toggle = false;
  // Read every entry before deciding. DeepSeek is what made this necessary: its
  // catalog data is `[{ type: 'toggle' }, { type: 'effort', values: [low, high,
  // max] }]`, and returning at the FIRST entry read only the toggle — so a model
  // with three grades showed a plain off/on and `max` was unreachable.
  for (const o of opts) {
    if (!o || typeof o !== 'object') continue;
    if (!graded && o.type === 'effort' && Array.isArray(o.values) && o.values.length) {
      const vals = o.values.map((v) => (String(v).toLowerCase() === 'none' ? 'off' : String(v).toLowerCase()));
      // De-dup and make sure 'off' is first when present.
      const uniq = [...new Set(vals)];
      uniq.sort((a, b) => (a === 'off' ? -1 : b === 'off' ? 1 : 0));
      graded = uniq;
    }
    if (o.type === 'budget_tokens' || o.type === 'toggle') toggle = true;
  }
  if (graded) {
    // A `toggle` beside the grades means thinking can also be switched off, which
    // the effort list does not always spell out itself.
    return toggle && !graded.includes('off') ? ['off', ...graded] : graded;
  }
  return toggle ? ['off', 'on'] : null;
}

// ---- thinking effort capability ----
// The set of selectable efforts for a model. Honours, in order:
//   1. an explicit `efforts` list on the model entry — this is what a catalog
//      install writes (from models.dev `reasoning_options`), and what a user can
//      also set by hand in config.toml (e.g. to name their own "max"/"xhigh")
//   2. an explicit `reasoning = false` (model cannot think) -> no control
//   3. `reasoning = true` with no declared levels -> the plain off/on toggle
// Returns [] when the model has no thinking control (then /model shows no effort
// row and /effort reports it is unsupported). Grades are NEVER guessed from the
// model id: models.dev is the source of truth, and a model it does not know simply
// gets the on/off toggle rather than an invented level list.
export function effortOptions(cfg, modelKeyName) {
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[modelKeyName || cfg.model] || {};
  // 1. A user-declared list wins outright (config.toml `efforts = [...]`), so a
  //    user can name their own levels (max, xhigh, …) even for a model the catalog
  //    does not know.
  const declared = Array.isArray(entry.efforts) ? entry.efforts.filter(Boolean).slice() : [];
  const alwaysOn = entry.always_thinking === true || entry.alwaysThinking === true;
  if (declared.length) {
    // Prepend 'off' unless the list already has it or thinking cannot be turned off.
    return alwaysOn || declared[0] === 'off' ? declared : ['off', ...declared];
  }
  // 2. An explicit `reasoning = false` / `thinking = false` means no control.
  if (entry.reasoning === false || entry.thinking === false) return [];
  if (alwaysOn) return ['on'];
  // 3. No declared levels. `reasoning = true` (supported) AND a missing field
  //    (unknown — e.g. an entry created before the catalog stored efforts) both get
  //    the plain off/on toggle. Grades are NEVER guessed from the model id: the
  //    graded list is models.dev's to declare, stored as `efforts` when the provider
  //    was added from the catalog. An entry with no reasoning field is UNKNOWN, not
  //    "unsupported", so it must not lose its toggle.
  return ['off', 'on'];
}

// Token budget for a NAMED grade, on a protocol that wants a number rather than a word.
//
// The grades the catalog declares are low/medium/high, and a user may also write their own
// in config.toml (`efforts = ["xhigh"]`). A grade with no entry here has no honest budget to
// send, so the field is omitted — the previous code fell back to 8000, which silently gave
// every unknown grade the same strength as `on` and `medium`.
const EFFORT_BUDGETS = { low: 2000, medium: 8000, high: 16000, max: 32000 };

// Map a chosen effort to the wire value for the active protocol.
//
// `on` means "thinking on", NOT "medium". The two are different requests: a model may
// support a plain toggle without any graded control, in which case there is no grade to
// send and inventing one (`medium`) can be rejected outright by the provider. `on` therefore
// sends the protocol's plain enable, or nothing at all.
export function effortWire(cfg, effort) {
  if (!effort || effort === 'off') return null;
  const named = Object.prototype.hasOwnProperty.call(EFFORT_BUDGETS, effort);

  if (cfg.protocol === 'anthropic') {
    // `thinking: { type: 'enabled' }` IS the plain toggle; `budget_tokens` is optional and
    // only meaningful for a named grade. Omitting it lets the provider pick its own budget,
    // which is what "on" asked for.
    return named
      ? { thinking: { type: 'enabled', budget_tokens: EFFORT_BUDGETS[effort] } }
      : { thinking: { type: 'enabled' } };
  }

  // Responses API and the OpenAI-compatible shape both take a GRADE word, and neither has
  // a value meaning "on". So a named grade passes through, and `on` sends nothing — the
  // request carries whatever the provider does by default for that model, rather than a
  // grade the model may not accept.
  if (!named) return {};
  if (cfg.protocol === 'responses') return { reasoning: { effort } };
  return { reasoning_effort: effort };
}


function toTomlLine(k, v) {
  if (typeof v === 'string') return `${k} = "${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return `${k} = ${v}`;
  if (typeof v === 'number') return `${k} = ${v}`;
  if (Array.isArray(v)) return `${k} = [ ${v.map((x) => `"${x}"`).join(', ')} ]`;
  return `${k} = "${v}"`;
}

// The bare model id sent to the API. The config KEY is authoritative: it is
// always "<provider>/<model-id>", so the id is the key minus the provider
// prefix. The entry's `model` field is only consulted when the key has no
// provider prefix — older hncode versions wrote corrupt values there (e.g. a
// different model's id), so it must not override a well-formed key.
export function bareModelId(provider, key, entry) {
  const e = entry || {};
  const providerName = e.provider || provider || '';
  const k = String(key || '');
  // The API wants the model id on its own (it may carry a sub-prefix like
  // "qoder/deepseek-flash"), NOT hncode's provider prefix ("traebuddy/"), so
  // "<provider>/" is stripped off.
  if (providerName && k.startsWith(providerName + '/')) return k.slice(providerName.length + 1);
  // When the key has no provider prefix, an explicit `model` field wins;
  // otherwise the key itself is the id.
  const fromField = typeof e.model === 'string' ? e.model : '';
  return fromField || k;
}

// Human-friendly model label for the status line.
//   1. an explicit `display_name` on the [models.*] entry wins (user's choice)
//   2. otherwise the bare model id, exactly as configured
export function modelLabel(cfg) {
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[cfg.model] || {};
  if (entry.display_name) return entry.display_name;
  return bareModelId(cfg.provider, cfg.model, entry) || cfg.innerModel || cfg.model || '';
}

// Remember the model the user last switched to, so a new hncode session starts
// on it. Stored as a top-level `model = "..."` in config.toml.
export function rememberModel(model) {
  if (!model) return;
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = text.split(/\r?\n/);
  const out = [];
  let replaced = false;
  let seenTableHeader = false;
  for (const ln of lines) {
    const isModelLine = /^\s*model\s*=/.test(ln);
    // A top-level `model = "..."` line lives before any `[table]` header.
    // Once a table header appears, subsequent `model =` lines are table keys,
    // not the active model.
    if (isModelLine && !seenTableHeader && !replaced) {
      out.push(`model = "${String(model).replace(/"/g, '\\"')}"`);
      replaced = true;
      continue;
    }
    out.push(ln);
    if (/^\s*\[/.test(ln)) seenTableHeader = true;
  }
  if (!replaced) {
    // No top-level model line: insert it before the first table header.
    let at = out.findIndex((l) => /^\s*\[/.test(l));
    if (at < 0) at = out.length;
    out.splice(at, 0, `model = "${String(model).replace(/"/g, '\\"')}"`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const joined = out.join('\n').replace(/^\n+/, '');
  fs.writeFileSync(file, joined + (joined.endsWith('\n') ? '' : '\n'), 'utf8');
  return file;
}

// Non-secret snapshot for /settings display.
export function effectiveSnapshot(cfg) {
  return {
    model: cfg.model,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    protocol: cfg.protocol,
    endpoint: cfg.endpoint,
    apiKeySet: !!cfg.apiKey,
    reasoning: cfg.reasoning,
    maxContextTokens: cfg.maxContextTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    workspace: cfg.workspace,
    allowExternal: cfg.allowExternal,
  };
}

// Re-resolve a provider's base URL / protocol / API key when the user switches
// providers at runtime (/provider, /model). The chosen provider's [providers.NAME]
// sub-table takes precedence (it's the point of switching); env vars set at boot
// are already baked into `cfg` and only remain in effect when the provider table
// does not override a given field.
// Recompute the context window for a given model key. `resolveConfig` picks the
// window from the model's [models.*] entry (context_length), an env/root
// override, or the default. resolveProvider / resolveModelArg must reuse the
// SAME rule when the user switches provider/model mid-session, otherwise the
// status-bar context gauge (state.ctxMax) keeps the stale previous model's value.
function contextForModel(cfg, modelName) {
  const root = (cfg && cfg.raw) || {};
  const models = (root.models) || {};
  const overrideContext = process.env.HNCODE_MAX_CONTEXT || root.max_context_size || root.max_context_tokens;
  const entry = models[modelName] || {};
  const modelContext = Number(entry.contextLength || entry.context_length || entry.context_window || entry.max_context_size || 0);
  return Number(overrideContext || modelContext || DEFAULTS.maxContextTokens);
}

export function resolveProvider(cfg, providerName, innerModel) {
  const pr = (cfg.raw && cfg.raw.providers) || {};
  const prov = pr[providerName] || {};
  const baseUrl = (prov.base_url || prov.baseUrl || '') || cfg.baseUrl;
  const apiKey = (prov.api_key || prov.apiKey || '') || cfg.apiKey;
  const protocol = (prov.protocol) || cfg.protocol;
  const inner = prov.model || (innerModel != null ? innerModel : cfg.innerModel);
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const endpoint = !b ? '' : (protocol === 'anthropic' ? `${b}/messages`
    : protocol === 'responses' ? `${b}/responses`
    : `${b}/chat/completions`);
  // Provider switch may move the active model too; refresh the context window
  // so the gauge reflects the newly active model, not the old one.
  const maxContextTokens = contextForModel(cfg, cfg.model);
  return { ...cfg, provider: providerName, innerModel: inner, baseUrl: b, endpoint, apiKey, protocol, maxContextTokens };
}

// Switch model, optionally moving to a provider declared via [models.NAME].
// The returned cfg carries BOTH: `model` is the pool key (what the status line
// and rememberModel use) and `innerModel` is the bare id sent to the API.
export function resolveModelArg(cfg, modelName) {
  if (!modelName) return cfg;
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[modelName] || {};
  const provider = entry.provider || cfg.provider;
  const inner = bareModelId(provider, modelName, entry);
  // Refresh the context window for the newly selected model.
  const maxContextTokens = contextForModel(cfg, modelName);
  return { ...resolveProvider(cfg, provider, inner), model: modelName, maxContextTokens };
}

export default { resolveConfig, saveConfig, effectiveSnapshot, resolveProvider, resolveModelArg, addProvider, removeProvider, addModel, upsertModel, replaceProviderModels, fetchModels, fetchCatalog, modelKey, modelLabel, bareModelId, rememberModel, hncodeConfigFile, effortsFromReasoning, effortOptions, costFromCatalog, modelCost, usageCost };