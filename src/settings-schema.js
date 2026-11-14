// The settings schema — one declaration per setting, projected onto every surface.
//
// WHY A TABLE
// -----------
// Settings were spread across two dozen `/xxx` commands, each with its own argument
// parsing, validation and persistence. Adding one meant writing a command; finding one
// meant knowing what it was called; and the surfaces disagreed — the TUI had a
// `/calm` toggle, the web's `setConfig` action accepted eight keys, and `config.toml`
// accepted everything. CodeWhale's `settings_schema.rs` solves this with a single
// declarative table that the UI renders from, the setter validates against, and the
// defaults come from, so this mirrors that shape:
//
//     SETTINGS_SCHEMA = [ { key, kind, default, ui: { tab, group, label, hint } | null } ]
//
// `ui: null` means DECLARED BUT NOT SHOWN — settable through `/set <key> <value>` and
// persisted, but with no row. That is how a value stays reachable without cluttering the
// screen (CodeWhale hides 28 of its 87 this way).
//
// WHAT `kind` BUYS
// ----------------
// `bool` renders a toggle, `enum` a picker over `values`, `int` a number prompt, `string`
// and `text` an editor. The surface never guesses, and a new setting needs no new UI code.
//
// THE DEFAULTS LIVE HERE TOO. A default written in the schema and nowhere else means
// `/settings` can always show what a value WOULD be, even before it is set — which is the
// difference between a settings screen and a list of the points you have already changed.

import { THEME_NAMES } from './colors.js';

/** Where a group appears in the rail, in display order. */
export const SETTINGS_TABS = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, density, motion, transcript' },
  { id: 'prompt', label: 'Prompt', hint: 'System prompt and per-mode instructions' },
  { id: 'model', label: 'Model', hint: 'Provider, model, thinking effort' },
  { id: 'context', label: 'Context', hint: 'Compaction and tool-result trimming' },
  { id: 'tools', label: 'Tools', hint: 'Permissions, delegation, shell' },
  { id: 'advanced', label: 'Advanced', hint: 'Update, telemetry, experiments' },
];

/** Kind -> a one-word name for the value, used by the value prompt. */
export const KIND_LABEL = {
  bool: 'on/off',
  int: 'number',
  enum: 'choice',
  string: 'text',
  text: 'multi-line text',
};

// Defaults are STRINGS, matching what config.toml holds and what `setConfigString`
// writes. `bool(false)` used to expand to `default: false` — a JS boolean — and every
// comparison against `'true'` then failed, so every toggle rendered as "off" regardless of
// its default. The kind says how a value is EDITED; the default says how it is STORED, and
// storing is a string.
const bool = (d) => ({ kind: 'bool', default: d ? 'true' : 'false' });
const int = (d, min, max) => ({ kind: 'int', default: String(d), min, max });
const en = (d, values) => ({ kind: 'enum', default: d, values });
const str = (d) => ({ kind: 'string', default: d });
const text = (d) => ({ kind: 'text', default: d });

/**
 * Every setting the program reads or can persist.
 *
 * `key` is the config.toml key verbatim — there is no rename layer, so what is written to
 * the file is what the code reads and what `/set` accepts.
 */
export const SETTINGS_SCHEMA = [
  // ---- appearance ---------------------------------------------------------
  // The default is `dark`, NOT `auto`. Setting it to `auto` silently switched every existing
  // setup to whatever the terminal background implies — on a light terminal, a completely
  // different palette. A default that rearranges the user's screen is not a default.
  // `auto` stays in the list for anyone who wants to follow the terminal.
  //
  // The accepted values come from `THEME_NAMES` rather than being written out here: a
  // hardcoded list meant adding a theme needed a second edit in a different file, and
  // forgetting it left /settings offering fewer themes than /theme did.
  { key: 'theme', ...en('dark', THEME_NAMES),
    ui: { tab: 'appearance', group: 'Display', label: 'Theme', hint: 'Colour scheme. `auto` follows the terminal background' } },
  { key: 'calm_mode', ...bool(false),
    ui: { tab: 'appearance', group: 'Display', label: 'Calm mode', hint: 'Fewer decorative flourishes; keeps the information, drops the animation' } },
  { key: 'reduced_motion', ...bool(false),
    ui: { tab: 'appearance', group: 'Motion', label: 'Reduced motion', hint: 'No sweeps or pulses — for a terminal over a slow link, or a preference' } },
  { key: 'render_fps', kind: 'int', default: '30',
    ui: { tab: 'appearance', group: 'Performance', label: 'Render FPS', hint: 'How often the screen is repainted. 0 means 1 — a terminal cannot render at zero. Higher is smoother and costs more CPU' } },
  { key: 'shimmer_edge', ...bool(true),
    ui: { tab: 'appearance', group: 'Motion', label: 'Shimmer edge', hint: 'The travelling highlight on a running tool name' } },
  { key: 'show_tool_details', ...bool(true),
    ui: { tab: 'appearance', group: 'Transcript', label: 'Tool details', hint: 'Show arguments and output previews on tool rows' } },
  { key: 'save_history', ...bool(true),
    ui: { tab: 'appearance', group: 'Transcript', label: 'Save display transcript', hint: 'Keep notices, warnings, plan cards and reasoning in the saved session' } },
  { key: 'save_thinking', ...bool(true),
    ui: { tab: 'appearance', group: 'Transcript', label: 'Save reasoning', hint: 'Persist thinking blocks, not only the visible answer' } },
  { key: 'title_display', ...bool(true),
    ui: { tab: 'appearance', group: 'Display', label: 'Title display', hint: 'Show the session title band at the top of the screen' } },
  { key: 'auto_title', ...bool(true),
    ui: { tab: 'appearance', group: 'Display', label: 'Auto title', hint: 'Let the model name the session from its first message' } },
  { key: 'cost_currency', ...en('usd', ['usd', 'cny']),
    ui: { tab: 'appearance', group: 'Display', label: 'Cost currency', hint: 'Which unit /cost reports in' } },
  { key: 'cny_per_usd', ...int(0, 0, 100000),
    ui: { tab: 'appearance', group: 'Display', label: 'CNY per USD', hint: 'Exchange rate used when reporting cost in CNY; 0 means fetch it' } },

  // ---- prompt -------------------------------------------------------------
  // A text setting rather than a command: the system prompt is the largest thing a user
  // can meaningfully tune, and it needed an editor, not a one-line argument.
  { key: 'system_prompt', ...text(''),
    ui: { tab: 'prompt', group: 'System', label: 'System prompt', hint: 'Replaces the built-in prompt entirely when set' } },
  { key: 'append_system_prompt', ...text(''),
    ui: { tab: 'prompt', group: 'System', label: 'Append to system prompt', hint: 'Added after the built-in prompt — the safer of the two' } },
  { key: 'plan_instructions', ...text(''),
    ui: { tab: 'prompt', group: 'Modes', label: 'Plan mode instructions', hint: 'Extra guidance while Plan mode is on' } },
  { key: 'focus_instructions', ...text(''),
    ui: { tab: 'prompt', group: 'Modes', label: 'Focus mode instructions', hint: 'Extra guidance while Focus mode is on' } },
  { key: 'swarm_instructions', ...text(''),
    ui: { tab: 'prompt', group: 'Modes', label: 'Swarm mode instructions', hint: 'Extra guidance while swarm mode is on' } },

  // ---- model --------------------------------------------------------------
  { key: 'provider', ...str(''),
    ui: { tab: 'model', group: 'Provider', label: 'Provider', hint: 'Which provider serves requests' } },
  { key: 'model', ...str(''),
    ui: { tab: 'model', group: 'Provider', label: 'Model', hint: 'provider/model, as written in config.toml' } },
  { key: 'default_model', ...str(''),
    ui: { tab: 'model', group: 'Provider', label: 'Default model', hint: 'Used when a session does not name one' } },
  { key: 'secondary_model', ...str(''),
    ui: { tab: 'model', group: 'Delegation', label: 'Secondary model', hint: 'For side tasks: titles, compaction summaries' } },
  { key: 'subagent_model', ...str(''),
    ui: { tab: 'model', group: 'Delegation', label: 'Subagent model', hint: 'What the Agent tool uses; empty means the main model' } },
  { key: 'effort', ...en('off', ['off', 'on', 'low', 'medium', 'high', 'max']),
    ui: { tab: 'model', group: 'Thinking', label: 'Thinking effort', hint: 'Only the levels the current model declares are offered' } },
  { key: 'max_context_tokens', ...int(0, 0, 10000000),
    ui: { tab: 'model', group: 'Thinking', label: 'Context window', hint: 'Override the model window when the catalog is wrong; 0 means use it' } },
  { key: 'prompt_cache', ...bool(true),
    ui: { tab: 'model', group: 'Provider', label: 'Prompt caching', hint: 'Ask the provider to cache the request prefix' } },
  { key: 'sampling', ...bool(true),
    label: 'Send sampling parameters',
    help: 'Off sends no temperature/top_p at all, for a provider that rejects them (several do, for reasoning models).' },
  { key: 'temperature', ...str(''),
    label: 'Temperature',
    help: '0 is deterministic, 2 is wild. Empty leaves the provider default. Accepts 0-2 with one decimal.' },
  { key: 'top_p', ...str(''),
    label: 'Top P',
    help: 'Nucleus sampling 0-1. Empty leaves the provider default. Usually set INSTEAD of temperature, not both.' },
  { key: 'presence_penalty', ...str(''),
    label: 'Presence penalty',
    help: 'OpenAI-compatible only: -2 to 2, positive discourages repeating topics. Anthropic has no equivalent and never receives it.' },

  // ---- context ------------------------------------------------------------
  { key: 'auto_compact', ...bool(true),
    ui: { tab: 'context', group: 'Compaction', label: 'Auto-compact', hint: 'Summarize older history when the window fills' } },
  { key: 'compact_threshold', ...int(85, 1, 99),
    ui: { tab: 'context', group: 'Compaction', label: 'Compact at %', hint: 'Share of the window at which compaction fires' } },
  { key: 'compact_keep_ratio', ...int(20, 1, 99),
    ui: { tab: 'context', group: 'Compaction', label: 'Keep %', hint: 'Share of the CURRENT usage kept after compaction' } },
  { key: 'auto_trim', ...bool(true),
    ui: { tab: 'context', group: 'Tool results', label: 'Auto-trim', hint: 'Elide old tool output from the request' } },
  { key: 'trim_threshold', ...int(50, 1, 99),
    ui: { tab: 'context', group: 'Tool results', label: 'Trim at %', hint: 'Share of the WINDOW that triggers a trim' } },
  { key: 'trim_keep_ratio', ...int(30, 1, 99),
    ui: { tab: 'context', group: 'Tool results', label: 'Keep %', hint: 'Share of the TOOL-RESULT TEXT kept after a trim — a different scale from the trigger' } },
  { key: 'tool_result_max_bytes', ...int(51200, 1024, 10485760),
    ui: { tab: 'context', group: 'Tool results', label: 'Max result bytes', hint: 'Larger output is written to disk and replaced with a pointer' } },
  { key: 'tool_result_preview_bytes', ...int(2048, 128, 1048576),
    ui: { tab: 'context', group: 'Tool results', label: 'Preview bytes', hint: 'How much of a spilled result stays inline' } },

  // ---- tools --------------------------------------------------------------
  { key: 'tool_allow_external_paths', ...bool(false),
    ui: { tab: 'tools', group: 'Files', label: 'Allow external paths', hint: 'Let file tools read and write outside the workspace' } },
  { key: 'swarm_mode', ...bool(false),
    ui: { tab: 'tools', group: 'Delegation', label: 'Swarm mode', hint: 'Expose AgentSwarm for fanning work across subagents' } },
  { key: 'output_style', ...str(''),
    ui: { tab: 'tools', group: 'Output', label: 'Output style', hint: 'Named style overriding how replies are written' } },
  // THE WEB SEARCH KEYS. Keyless search is rate-limited per IP, so on a shared or busy address WebSearch
  // answers with refusals that read as "search is broken". Tavily keys are per account, and the tool tries
  // them in order — several keys make the monthly quota additive.
  //
  // `kind: 'text'` is what makes /settings open the multi-line editor instead of asking for one line: the
  // value IS a list, one key per line.
  { key: 'web_search_api_key', ...text(''),
    ui: {
      tab: 'tools',
      group: 'Web',
      label: 'WebSearch API keys',
      hint: 'One key per line, tried in order — a second key is used when the first is out of quota. '
        + 'Get them free at https://app.tavily.com (sign in, copy from the dashboard). '
        + 'Empty uses keyless mode, which is rate-limited per IP.',
    } },
  { key: 'auto_trim_aggressive', ...bool(false), ui: null },
  { key: 'no_delegation', ...bool(false), ui: null },

  // ---- advanced -----------------------------------------------------------
  { key: 'auto_update', ...bool(true),
    ui: { tab: 'advanced', group: 'Updates', label: 'Auto-update', hint: 'Check npm at startup and every 30 minutes' } },
  { key: 'experiments', ...str(''),
    ui: { tab: 'advanced', group: 'Features', label: 'Experiments', hint: 'Comma-separated feature flags to enable' } },
  { key: 'telemetry', ...bool(false),
    ui: { tab: 'advanced', group: 'Features', label: 'Telemetry', hint: 'Send anonymous usage counts' } },
  { key: 'vim_mode', ...bool(false),
    ui: { tab: 'advanced', group: 'Editor', label: 'Vim mode', hint: 'Modal keys in the composer' } },
  { key: 'shell', ...str(''),
    ui: { tab: 'advanced', group: 'Editor', label: 'Shell', hint: 'Program used by the Bash tool; empty means auto-detect' } },
  { key: 'mcp_config_path', ...str(''),
    ui: { tab: 'advanced', group: 'MCP', label: 'MCP config path', hint: 'Defaults to ~/.hncode/mcp.json' } },
  { key: 'checkpoints_max', ...int(500, 1, 100000),
    ui: { tab: 'advanced', group: 'Editor', label: 'Max checkpoints', hint: 'Per-session cap on file-history entries' } },
  { key: 'log_level', ...en('warn', ['error', 'warn', 'info', 'debug']),
    ui: { tab: 'advanced', group: 'Diagnostics', label: 'Log level', hint: 'How much reaches session-errors.log' } },
  { key: 'probe_timeout_ms', ...int(20000, 1000, 600000),
    ui: { tab: 'advanced', group: 'Diagnostics', label: 'Probe timeout (ms)', hint: 'How long /doctor --probe waits for a reply' } },

  // ---- the startup defaults, which had no row anywhere --------------------
  // These already worked from config.toml but were reachable only by hand-editing it: a
  // user could change the model from /model but not the base URL those models are reached
  // at, and the protocol had no surface at all.
  { key: 'base_url', ...str(''),
    ui: { tab: 'model', group: 'Provider', label: 'Base URL', hint: 'Endpoint used when a provider does not name one' } },
  { key: 'protocol', ...en('', ['', 'openai', 'anthropic', 'responses']),
    ui: { tab: 'model', group: 'Provider', label: 'Protocol', hint: 'Wire format; empty detects from the provider' } },
  { key: 'max_context_size', ...int(0, 0, 10000000),
    ui: { tab: 'model', group: 'Thinking', label: 'Max context size', hint: 'Startup default when the catalog has no window; 0 means fall back again' } },
  { key: 'max_output_size', ...int(0, 0, 10000000),
    ui: { tab: 'model', group: 'Thinking', label: 'Max output size', hint: 'Startup default for the reply length; 0 means fall back' } },
  { key: 'reasoning', ...bool(false),
    ui: { tab: 'model', group: 'Thinking', label: 'Reasoning by default', hint: 'Whether new sessions start with thinking on' } },
  { key: 'plugins_dir', ...str(''),
    ui: { tab: 'advanced', group: 'MCP', label: 'Plugins directory', hint: 'Where plugins load from; defaults to ~/.hncode/plugins' } },
  { key: 'web_host', ...str('127.0.0.1'),
    ui: { tab: 'advanced', group: 'Web', label: 'Web host', hint: 'Address the /web daemon binds to' } },
  { key: 'web_port', ...int(8765, 1, 65535),
    ui: { tab: 'advanced', group: 'Web', label: 'Web port', hint: 'Fixed port for the single global daemon' } },
];

/** key -> definition, for the setter and for validation. */
export const SETTING_BY_KEY = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

/** The settings that get a row, grouped by tab, in schema order. */
export function settingsForTab(tab) {
  return SETTINGS_SCHEMA.filter((d) => d.ui && d.ui.tab === tab);
}

/** Tabs that actually have at least one row, so the rail never shows an empty section. */
export function populatedTabs() {
  return SETTINGS_TABS.filter((t) => settingsForTab(t.id).length > 0);
}

/** Every key `/set` accepts — including the ones with no row. */
export function settableKeys() {
  return SETTINGS_SCHEMA.map((d) => d.key);
}

/**
 * Coerce a typed value to what the setting stores, or report why it cannot.
 *
 * The single validation point: `/settings`, `/set` and the web's `setConfig` all come
 * through here, so they cannot disagree about what a value means.
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function coerceSetting(key, input) {
  const def = SETTING_BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown setting: ${key}` };
  const raw = String(input == null ? '' : input).trim();

  if (def.kind === 'bool') {
    const v = raw.toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(v)) return { ok: true, value: 'true' };
    if (['0', 'false', 'off', 'no', ''].includes(v)) return { ok: true, value: 'false' };
    return { ok: false, error: `${key} is on/off; got ${JSON.stringify(input)}` };
  }
  if (def.kind === 'int') {
    // Accept `85` and `85%` — the percentage settings read naturally with a sign, and
    // the schema stores a plain number.
    const n = Number(String(raw).replace(/%$/, ''));
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `${key} needs a whole number; got ${JSON.stringify(input)}` };
    if (def.min != null && n < def.min) return { ok: false, error: `${key} must be at least ${def.min}` };
    if (def.max != null && n > def.max) return { ok: false, error: `${key} must be at most ${def.max}` };
    return { ok: true, value: String(n) };
  }
  if (def.kind === 'enum') {
    if (def.values.includes(raw)) return { ok: true, value: raw };
    // A case-insensitive hit is accepted; anything else is refused rather than coerced,
    // because silently picking a near-miss is how a setting ends up not meaning what it
    // says.
    const lower = def.values.find((v) => v.toLowerCase() === raw.toLowerCase());
    if (lower) return { ok: true, value: lower };
    return { ok: false, error: `${key} must be one of ${def.values.join(', ')}; got ${JSON.stringify(input)}` };
  }
  // string / text: anything goes, including empty (which means "unset").
  return { ok: true, value: raw };
}

/**
 * The value in force: what is configured, else the schema default.
 *
 * `cfg.raw` holds what config.toml said. A value there wins even when it equals the
 * default, so `/settings` can tell "set to X" from "unset, so X applies".
 */
export function effectiveValue(cfg, key) {
  const def = SETTING_BY_KEY.get(key);
  const raw = cfg && cfg.raw ? cfg.raw[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return def ? def.default : '';
  return String(raw);
}

/** True when the value came from config rather than from the schema default. */
export function isSet(cfg, key) {
  const raw = cfg && cfg.raw ? cfg.raw[key] : undefined;
  return raw !== undefined && raw !== null && raw !== '';
}

/** How a value reads on a row: `on`, `dark`, `85%`, or `(unset)`. */
export function displayValue(cfg, key) {
  const def = SETTING_BY_KEY.get(key);
  if (!def) return '';
  const v = effectiveValue(cfg, key);
  if (def.kind === 'bool') return v === 'true' ? 'on' : 'off';
  // `text` is returned WHOLE. It used to be cut to forty characters here, which made the
  // value useless to a caller that needed to measure or edit it. Abbreviating is the
  // renderer's job — see `proseSummary`.
  //
  // An empty value reads as `(unset)` for EVERY kind, not only `string`: `protocol` is an
  // enum whose default is the empty string, so its row rendered with a blank value column.
  //
  // Whitespace alone is unset too. `!v` only catches the empty string, so '   ' rendered as a
  // blank cell — the same as a value that failed to render. Tested on the trimmed copy and the
  // value returned RAW: a trailing newline is part of a prompt, and trimming the value itself
  // would corrupt it.
  if (!v || !String(v).trim()) return '(unset)';
  return v;
}


/**
 * Which settings differ from their default, newest-first by schema order.
 * `/settings` marks these; it is how a user sees what they have actually changed.
 */
export function changedSettings(cfg) {
  return SETTINGS_SCHEMA.filter((d) => isSet(cfg, d.key)
    && effectiveValue(cfg, d.key) !== d.default);
}
