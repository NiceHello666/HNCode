// hncode entry: CLI arg parsing, subcommands, headless -p mode, and TUI dispatch.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveConfig, effectiveSnapshot, saveConfig, resolveModelArg, readPersonalPrompt } from './config.js';
import * as sess from './session.js';
import { Agent, SYSTEM_PROMPT, THINKING_TAGS_INSTRUCTION, needsThinkingTags, canSplitAfter } from './agent.js';
import { llmTools } from './tools/index.js';
import { localVersion } from './version.js';
import { EXIT, FORMATS, isValidFormat, buildResult, exitCodeFor, resultLine, createRunTracker, trackEvent, finalReply } from './ci.js';

// The version shown by `hncode -V` and the help banner. Read from package.json
// (via version.js) so it can never drift from the published version again.
export const VERSION = localVersion();

const HELP = `hncode ${VERSION} — a Kimi Code-style coding agent.

Usage: hncode [options] [command]

Cyan-blue TUI for long agent sessions. OpenAI + Anthropic streaming,
MCP-style toolbelt (Edit, Read, Write, Bash, Glob, Grep, TodoList, ...).

Options:
  -V, --version                 output the version number
  -S, --session [id]            Resume a session (with id) or pick interactively.
  -c, --continue                Continue the previous session for this directory.
  -y, --yolo                    Yolo mode: routine edits/commands run; risky actions still ask.
  --auto                        Auto mode: never ask; everything runs automatically.
  -m, --model <model>           Model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the reply.
  --output-format <format>      Prompt mode output: text (default), json, or stream-json.
                                json prints one result object; stream-json streams events then a result.
                                Exit code reflects the outcome: 0 ok, 1 failure, 2 config, 3 no answer, 4 interrupted.
  --control                     Expose a local control socket (prompt/status/interrupt) while the TUI runs.
  --timeout <seconds>           Prompt mode: abort the run after this many seconds (default: no limit).
  --retries <n>                 Prompt mode: HTTP retries per request before failing (default: 3).
  --control <path>              Same, at an explicit socket path.
  --web                         Serve this session to a browser on 127.0.0.1 (random port).
  --web [ip][:port]             Same, on a chosen address/port (e.g. --web 0.0.0.0:8080).
  --plan                        Start in plan mode (research only, no writes).
  --plan                        Start in plan mode (research only, no writes).
  --add-dir <dir>               Add an additional workspace directory. Repeatable.
  -h, --help                    Show help.

Commands:
  session list                  List sessions, most recent first.
  provider list                 Show configured providers.
  doctor [config] [path]        Environment self-check (default), or validate a config.toml.
  init                          Create ~/.hncode/config.toml with defaults.
  export [id]                   Export a session to ~/.hncode/export/<id>.json.
  backup [path]                 Archive ALL state (sessions, settings, skills, plugins, memory) for another machine.
  restore <path>                Read a backup. Sessions are placed by the index.yml inside it.
                                --index <file> use an edited copy; --no-index keep recorded paths;
                                --workspace <dir> repoint every session; --overwrite; --dry-run.
  control status                Ask a running session (started with --control) for its status.
  control prompt <text>         Queue a prompt on a running session.
  control interrupt             Interrupt the running turn.
  hooks list                    Show configured shell hooks.
  skills list                   List installed skills.
  mcp list                      Show configured MCP servers.
`;

function printHelp() { process.stdout.write(HELP); }

// ---- minimal argv parsing ----
export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); val = null; }
      if (key === 'resume') key = 'session'; // `--resume <id>` is an alias for `--session <id>`
      if (['session', 'control', 'web'].includes(key) && val === null) { const nx = argv[i + 1]; out[key] = nx !== undefined && !nx.startsWith('-') ? (i++, nx) : true; }
      // FLAGS THAT TAKE A VALUE. `--workspace` and `--index` are here for `hncode restore`: without them the path was
      // left in `positional` and the flag itself became `true`, so the restore would have repointed every session at the
      // string "true".
else if (key === 'model' || key === 'prompt' || key === 'output-format' || key === 'add-dir' || key === 'timeout' || key === 'retries' || key === 'workspace' || key === 'index') {
        if (val === null) {
          const nx = argv[i + 1];
          // Only consume the next token if it is a real value, not another flag
          // or the end of argv. Previously `--model -y` and a trailing `--model`
          // swallowed or mangled the value, breaking the real flag.
          val = (nx !== undefined && !nx.startsWith('-')) ? argv[++i] : undefined;
        }
out[key] = (key === 'add-dir' && val !== undefined)
        ? (out[key] || []).concat([val])
        : val;
      } else if (val !== null) { out[key] = val === 'true' ? true : val === 'false' ? false : val; }
      else out[key] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const short = { V: 'version', S: 'session', c: 'continue', y: 'yolo', auto: 'auto', m: 'model', p: 'prompt', h: 'help' };
if (key === 'S' || key === 'm' || key === 'p') {
        const nx = argv[i + 1];
        // Take the next token as the value only if it exists and is not another
        // flag. Previously `-S -y` swallowed `-y` as the session id and a bare
        // trailing `-m` became undefined; both silently broke the real flag.
        const hasVal = nx !== undefined && !nx.startsWith('-');
        if (hasVal) { out[short[key]] = argv[i + 1]; i++; }
        else if (key === 'S') { out.session = true; }  // "-S" with no id => pick interactively
        // '-m' / '-p' with no usable value: leave unset (same as a missing arg).
      } else out[short[key]] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

// ---- subcommands ----
function cmdSessionList(args) {
  const items = sess.listSessions();
  if (items.length === 0) { console.log('No sessions yet.'); return 0; }
  for (const s of items.slice(0, 30)) {
    const when = new Date(s.updatedAt || 0).toISOString().slice(0, 19).replace('T', ' ');
    const title = (s.title || '(untitled)').replace(/\n/g, ' ');
    console.log(`${s.id.padEnd(20)} ${when}  ${title}`);
  }
  return 0;
}
function cmdProviderList() {
  const cfg = resolveConfig();
  const provs = (cfg.raw.providers) || {};
  const models = (cfg.raw.models) || {};
  const counts = {};
  for (const m of Object.values(models)) if (m.provider) counts[m.provider] = (counts[m.provider] || 0) + 1;
  const names = Object.keys(provs).length ? Object.keys(provs) : [cfg.provider];
  for (const name of names) {
    const p = provs[name];
    const url = p ? (p.base_url || p.baseUrl || '') : cfg.baseUrl;
    console.log(`${name}  (${counts[name] || 0} models)  ${url}`);
  }
  console.log(`active: ${cfg.provider} / ${cfg.model}`);
  return 0;
}
async function cmdDoctorConfig(p) {
  let file = p;
  if (!file) {
    const home = os.homedir();
    for (const f of [process.env.HNCODE_CONFIG, path.join(home, '.hncode', 'config.toml')]) {
      if (f && fs.existsSync(f)) { file = f; break; }
    }
    file = file || path.join(home, '.hncode', 'config.toml');
    console.log(`No path given; validated: ${file}`);
  }
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const { parse } = await import('./toml.js');
    parse(txt);
    console.log(`OK: ${file} is valid TOML.`);
    return 0;
  } catch (e) {
    console.error(`INVALID: ${file}: ${e.message}`);
    return 1;
  }
}

// `hncode doctor` — environment self-check. Answers "will hncode actually work in
// THIS terminal?" for the things that silently break it: too-old Node, a non-TTY
// or odd terminal, Windows consoles that do not forward mouse sequences, a missing
// git, an unreadable config. Every line is OK / WARN / FAIL so one paste answers a
// support question.
async function cmdDoctorEnv() {
  const rows = [];
  const add = (level, label, detail) => rows.push({ level, label, detail });

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) add('OK', 'node', process.version);
  else if (major >= 20) add('WARN', 'node', process.version + ' — 20/21 work, but 22+ has TTY fixes');
  else add('FAIL', 'node', process.version + ' — hncode needs Node >= 20');

  add('OK', 'platform', process.platform + ' ' + os.release());
  const isWin = process.platform === 'win32';
  const term = process.env.TERM || '';
  const wt = process.env.WT_SESSION ? 'windows-terminal' : (process.env.TERM_PROGRAM || (isWin ? 'conhost/other' : 'unknown'));
  add(process.stdout.isTTY ? 'OK' : 'WARN', 'stdout isatty', process.stdout.isTTY ? 'yes' : 'no — colors/mouse assume a real terminal');
  add('OK', 'terminal', wt + (term ? ' (TERM=' + term + ')' : ''));
  if (isWin && !process.env.WT_SESSION) {
    add('WARN', 'mouse', 'not inside Windows Terminal (WT_SESSION unset); some consoles do not forward mouse input');
  }
  add('OK', 'truecolor', (process.env.COLORTERM === 'truecolor' || /256color|truecolor/.test(term)) ? 'yes' : 'no — 256-color fallback in use');

  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    add(r.status === 0 ? 'OK' : 'WARN', 'git', r.status === 0 ? String(r.stdout).trim() : 'not found — git tools limited');
  } catch { add('WARN', 'git', 'not found on PATH'); }

  const cfgFile = process.env.HNCODE_CONFIG || path.join(os.homedir(), '.hncode', 'config.toml');
  if (!fs.existsSync(cfgFile)) {
    add('WARN', 'config', 'no file at ' + cfgFile + ' (run hncode init)');
  } else {
    try {
      const { parse } = await import('./toml.js');
      parse(fs.readFileSync(cfgFile, 'utf8'));
      add('OK', 'config', cfgFile);
    } catch (e) {
      add('FAIL', 'config', cfgFile + ': ' + e.message);
    }
  }

  try {
    const cfg = resolveConfig();
    const model = cfg.innerModel || cfg.model;
    add(model ? 'OK' : 'WARN', 'model', model || 'none configured (run /model or set default_model)');
    add(cfg.apiKey ? 'OK' : 'WARN', 'api key', cfg.apiKey ? 'set' : 'missing — requests will 401');
  } catch (e) {
    add('WARN', 'config resolve', e.message);
  }

  try {
    const dir = path.join(os.homedir(), '.hncode', 'plugins');
    const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => fs.statSync(path.join(dir, x)).isDirectory()).length : 0;
    add('OK', 'plugins', n + ' installed (' + dir + ')');
  } catch { /* ignore */ }

  const order = { FAIL: 0, WARN: 1, OK: 2 };
  rows.sort((a, b) => order[a.level] - order[b.level]);
  console.log('hncode doctor — environment check\n');
  for (const r of rows) console.log('  [' + r.level.padEnd(4) + '] ' + r.label.padEnd(16) + ' ' + r.detail);
  const fails = rows.filter((r) => r.level === 'FAIL').length;
  console.log('\n' + (fails ? fails + ' problem(s) found' : 'No blocking problems found.'));
  return fails ? 1 : 0;
}


function cmdInit() {
  const cfg = resolveConfig();
  const target = path.join(os.homedir(), '.hncode', 'config.toml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = [
    `# hncode configuration`,
    `default_model = "${cfg.raw.default_model || 'gpt-4o-mini'}"`,
    ``,
    `# Or set these directly:`,
    `# base_url = "${cfg.baseUrl}"`,
    `# protocol = "openai"   # or "anthropic"`,
    `# max_context_size = 128000`,
    `# max_output_size = 4096`,
  ];
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
    console.log(`Created ${target}`);
  } else {
    console.log(`Already exists: ${target}`);
  }
  return 0;
}

function cmdExport(id) {
  const s = id ? sess.loadSession(id) : sess.latestSession(process.cwd());
  if (!s) { console.error('No session found.'); return 1; }
  const exportDir = path.join(os.homedir(), '.hncode', 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const out = path.join(exportDir, `${s.id}.json`);
  fs.writeFileSync(out, JSON.stringify(s, null, 2), 'utf8');
  console.log(`Exported ${s.id} -> ${out}`);
  return 0;
}

// ---- migration: every piece of state, to another machine -------------------
//
// `hncode backup [path]`  writes one archive of everything a person made: sessions, settings, skills, plugins, memory.
// `hncode restore <path>` reads it back, with `--workspace <dir>` to repoint the imported sessions, `--overwrite` to
// replace what is already here, and `--dry-run` to see what would happen first.
//
// Debug logs and the plugin browser's Chromium profile are deliberately excluded — see EXCLUDED in src/migrate.js.
async function cmdBackup(dest) {
  const mig = await import('./migrate.js');
  const home = mig.hncodeHome();
  const items = mig.planExport(home);
  if (!items.length) {
    console.error(`nothing to migrate: ${home} holds none of the portable entries`);
    return 1;
  }
  const total = items.reduce((n, i) => n + i.size, 0);
  const out = dest ? path.resolve(String(dest))
    : path.join(process.cwd(), `hncode-backup-${new Date().toISOString().slice(0, 10)}.hnb`);
  console.log(`exporting ${items.length} item(s), ${mig.fmtBytes(total)}, from ${home}`);
  for (const i of items) console.log(`  ${mig.fmtBytes(i.size).padStart(9)}  ${i.name}${i.kind === 'dir' ? '/' : ''}  — ${i.what}`);
  console.log(`  (left behind: ${mig.EXCLUDED.map((e) => e.name).join(', ')})`);
  let last = 0;
  const res = mig.writeArchive(out, {
    home,
    items,
    onProgress: (done, all) => {
      // A line every 10% keeps a 190 MB export from looking frozen without flooding the terminal.
      const pct = Math.floor((done / all) * 10) * 10;
      if (pct > last) { last = pct; process.stderr.write(`  ${pct}%\r`); }
    },
  });
  console.log(``);
  console.log(`wrote ${res.path}`);
  console.log(`  ${res.files} files, ${mig.fmtBytes(res.bytes)}`);
  console.log(`On the other machine: hncode restore ${path.basename(res.path)}`);
  return 0;
}

async function cmdRestore(from, args = {}) {
  const mig = await import('./migrate.js');
  if (!from) { console.error('restore needs an archive: hncode restore <file.hnb> [--workspace <dir>] [--overwrite] [--dry-run]'); return 1; }
  const src = path.resolve(String(from));
  let head;
  try { head = mig.readArchiveManifest(src); } catch (e) { console.error(`cannot read ${src}: ${e.message}`); return 1; }
  const { manifest } = head;
  const home = mig.hncodeHome();
  const bytes = manifest.files.reduce((n, f) => n + f.size, 0);
  console.log(`archive: ${src}`);
  console.log(`  created ${new Date(manifest.createdAt).toISOString()}, ${manifest.files.length} files, ${mig.fmtBytes(bytes)}`);
  console.log(`  from   ${manifest.home || '(unknown)'}`);
  console.log(`  into   ${home}`);
  // THE INDEX IS THE POINT OF THIS FLAG. Without it the archive's own `index.yml` is used when present, which is what
  // makes an exported-then-edited file worth having. `--index <file>` points at a copy edited OUTSIDE the archive, and
  // `--no-index` ignores it so the recorded paths are kept verbatim.
  const opts = {
    home,
    overwrite: !!args.overwrite,
    workspace: args.workspace,
    dryRun: !!args['dry-run'],
    // DEFAULT IS ON: an archive's own index.yml is used unless `--no-index` says otherwise. `--index <file>` replaces it
    // with an edited copy.
    index: args['no-index'] ? false : true,
    indexFile: typeof args.index === 'string' ? args.index : undefined,
  };
  if (opts.workspace) console.log(`  sessions repointed at ${path.resolve(String(opts.workspace))}  (--workspace overrides the index)`);
  else if (!opts.index) console.log('  --no-index: paths stay exactly as recorded');
  else if (opts.indexFile) console.log(`  mapping read from ${path.resolve(String(opts.indexFile))}`);
  else console.log('  sessions are placed by the index.yml inside the archive, if it has one');
  if (opts.dryRun) console.log('  (dry run — nothing is written)');
  let res;
  try { res = mig.readArchive(src, opts); } catch (e) { console.error(`restore failed: ${e.message}`); return 1; }
  console.log(`  ${opts.dryRun ? 'would write' : 'wrote'} ${res.written} file(s), ${mig.fmtBytes(res.bytes)}`);
  if (res.skipped) console.log(`  kept ${res.skipped} existing file(s) — pass --overwrite to replace them`);
  if (res.mapped) console.log(`  ${res.mapped} session(s) moved by the mapping`);
  else if (res.sessionsRewritten) console.log(`  ${res.sessionsRewritten} session(s) repointed`);
  if (opts.index !== false && !res.indexFound) console.log('  no index.yml in the archive (an older backup) — paths left as recorded');
  for (const e of res.errors.slice(0, 5)) console.error(`  ! ${e}`);
  if (res.errors.length > 5) console.error(`  ! … and ${res.errors.length - 5} more`);
  return res.errors.length ? 1 : 0;
}

const SUBCOMMANDS = {
  'session': { 'list': cmdSessionList },
  'provider': { 'list': cmdProviderList },
  'doctor': { 'config': cmdDoctorConfig },
  'init': cmdInit,
  'export': cmdExport,
  // MIGRATION. `export` above writes ONE session as Markdown; these move the whole hncode state — every session,
  // the settings, skills, plugins, memory — to another machine. Different jobs, so different names.
  //
  // BOTH ARE `{ run }` ENTRIES, NOT BARE FUNCTIONS. The dispatcher treats a second positional word as the SUBCOMMAND of
  // the first (`session list`), and for these it is just the path — `backup /tmp/x.hnb` was being read as the subcommand
  // `/tmp/x.hnb` of `backup`, which does not exist, so it printed the help and did nothing.
  'backup': { run: cmdBackup },
  'restore': { run: cmdRestore },
  control: {
    // Subcommands pass only positional[2] to their handler, so bind the op.
    'status': (rest) => cmdControl('status', rest),
    'prompt': (rest) => cmdControl('prompt', rest),
    'interrupt': (rest) => cmdControl('interrupt', rest),
  },
};

// ---- control (talk to a running --control session) --------------------------
// `hncode control status|prompt|interrupt` — the client half of the control
// socket the TUI opens with --control. Prints the JSON reply so a script can
// parse it; exits non-zero when the running session could not be reached.
async function cmdControl(sub, arg) {
  const { sendControl } = await import('./ci.js');
  const op = sub || 'status';
  if (!['status', 'prompt', 'interrupt'].includes(op)) {
    console.error(`unknown control op: ${op}. Use status | prompt <text> | interrupt.`);
    return 1;
  }
  const req = { op };
  if (op === 'prompt') {
    const text = String(arg || '').trim();
    if (!text) { console.error('control prompt requires text.'); return 1; }
    req.text = text;
  }
  const res = await sendControl(req, { path: process.env.HNCODE_CONTROL_SOCKET || undefined });
  console.log(JSON.stringify(res));
  return res && res.ok ? 0 : 1;
}

// ---- headless prompt mode ----
async function runPrompt({ cfg, prompt, format, session, modelArg, timeoutSeconds, maxRetries }) {
  cfg = resolveModelArg(cfg, modelArg);
  if (maxRetries !== undefined) cfg.maxRetries = maxRetries;
  if (!cfg.apiKey) {
    console.error('hncode: no api_key configured. Set HNCODE_API_KEY or configure a provider first. Run `hncode doctor config` to check.');
    return EXIT.CONFIG;
  }
  const messages = [];
  // Same layering as the TUI: built-in prompt first, then the user's own
  // system_prompt override if any, then the /personal notes, then calm mode.
  let sysText = (cfg.systemPrompt && String(cfg.systemPrompt).trim()) || SYSTEM_PROMPT;
  // The inline-reasoning instruction, only for a model with no reasoning channel of its
  // own — the same rule the TUI applies (see needsThinkingTags).
  if (needsThinkingTags(cfg)) sysText += '\n\n' + THINKING_TAGS_INSTRUCTION;
  const personal = readPersonalPrompt(cfg.workspace);
  if (personal) sysText += '\n\n' + personal;
  messages.push({ role: 'system', content: sysText });
  if (session && session.messages) {
    // Resume on a TOOL-EXCHANGE BOUNDARY: a cut that separates an assistant
    // message from its tool results (or leaves orphaned tool results) is a 400
    // from the provider, not just a shorter history. `canSplitAfter` is the same
    // rule the compaction logic uses. System messages are dropped — the fresh
    // one above is authoritative.
    const hist = session.messages.filter((m) => m && m.role !== 'system');
    // A session persisted mid-step can end with an assistant message whose tool
    // results were never appended; sending it before the user message is a 400.
    while (hist.length && hist[hist.length - 1].role === 'assistant'
      && Array.isArray(hist[hist.length - 1].toolCalls) && hist[hist.length - 1].toolCalls.length) hist.pop();
    let start = Math.max(0, hist.length - 30);
    while (start > 0 && !canSplitAfter(hist, start - 1)) start++;
    for (let i = start; i < hist.length; i++) messages.push(hist[i]);
  }
  // THE PROMPT ITSELF. This used to never be pushed: -p sent only the resumed
  // history and the system message, so a fresh session answered nothing the
  // user asked and a resumed one answered nothing new.
  messages.push({ role: 'user', content: prompt });
  if (session && session._unrecoverable) {
    process.stderr.write(
      `hncode: session ${session.id} has no readable history (its file is damaged). `
      + 'Starting a new session; the old file is untouched.\n',
    );
    session = null;
  }
  const saved = session || { id: sess.newId(), title: prompt.slice(0, 60), workspace: path.resolve(process.cwd()), model: cfg.model, createdAt: Date.now(), messages: [] };
  const tracker = createRunTracker();
  const startedAt = Date.now();
  let fatal = null;
  const agent = new Agent({
    cfg,
    messages,
    // Uncapped: run until the model finishes (see agent.js).
    onEvent: (e) => {
      trackEvent(tracker, e);
      if (e.type === 'error') fatal = (e.error && e.error.message) || String(e.error);
      if (format === 'stream-json' || format === 'json') {
        // `json` mode keeps stdout clean for the final envelope, so events go to
        // stderr there. `stream-json` is the streaming contract: one event/line.
        if (format === 'stream-json') {
          if (e.type === 'context') return; // TUI-only gauge; not part of the stream
          const line = { type: e.type };
          if (e.text) line.text = e.text;
          if (e.name) line.name = e.name;
          if (e.id) line.id = e.id;
          if (e.content != null) line.content = e.content;
          process.stdout.write(JSON.stringify(line) + '\n');
        }
      } else if (e.type === 'data') {
        process.stdout.write(e.text);
      }
    },
  });
  saved.messages = messages;
  // `--timeout <seconds>`: hard wall-clock cap on the whole run, so an unattended
  // scripted prompt cannot hang forever on a stuck model or a wedged tool. The
  // timer calls the SAME interrupt() the TUI's Esc uses — it aborts the in-flight
  // request and kills the tool's AbortSignal — rather than process.exit, so the
  // session is still saved and any final output is emitted.
  let timedOut = false;
  let timer = null;
  if (timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try { agent.interrupt(); } catch { /* best-effort */ }
    }, timeoutSeconds * 1000);
    if (timer.unref) timer.unref();
  }
  try {
    await agent.run();
  } finally {
    if (timer) clearTimeout(timer);
    // MCP stdio children were spawned for this run; most die on stdin EOF at
    // process exit, but one that ignores EOF would linger. Kill them outright —
    // best-effort, the result has already been produced.
    try {
      const mcp = await import('./mcp.js');
      mcp.disconnectAll(mcp.getLiveConnections());
    } catch { /* best-effort */ }
  }
  sess.saveSession(saved);

  const reply = finalReply(messages, tracker.text);
  const result = buildResult({
    reply,
    toolCalls: tracker.toolCalls,
    files: tracker.files,
    error: fatal || (tracker.errors.length ? tracker.errors[tracker.errors.length - 1] : null),
    stopped: !!agent.stopRequested,
    durationMs: Date.now() - startedAt,
    model: cfg.model,
    sessionId: saved.id,
    timedOut,
  });

  if (format === 'json') {
    // Exactly one JSON object on stdout, so `| jq` / `tail -1` works.
    process.stdout.write(resultLine(result) + '\n');
  } else if (format === 'stream-json') {
    // A terminating event tells a streaming reader the run is over and carries
    // the same envelope, so both formats end with a `result` record.
    process.stdout.write(resultLine(result) + '\n');
  } else {
    process.stdout.write('\n');
  }
  return exitCodeFor(result, false);
}

// ---- TUI dispatch ----
async function startTui(opts) {
  const { startTUI } = await import('./tui.js');
  await startTUI(opts);
}

function loadOrCreateSession(opts, cfg) {
  let session = null;
  // NOTE: these keys must match what parseArgs actually produces — `--continue`
  // yields `args.continue` (not `args.cont`), and `--resume <id>` is normalised
  // to `args.session`. Reading the wrong key silently fell through to "create a
  // new session", which is why --continue looked like it started a fresh one.
  const sessionArg = opts.session;
  const wantsSession = typeof sessionArg === 'string' || sessionArg === true || !!opts.sessionId;
  const wantsContinue = !!(opts.continue || opts.cont);
  if (wantsSession) {
    const id = typeof sessionArg === 'string' ? sessionArg : opts.sessionId;
    if (id) session = sess.loadSession(id) || null;
  } else if (wantsContinue) {
    // --continue: get the most recent session for THIS directory that has messages.
    // Empty shells are created on every launch, so we skip them to find real conversations.
    session = sess.latestSession(process.cwd(), undefined, { skipEmpty: true });
  }
  // A session whose file could not be parsed OR recovered comes back marked, with no
  // messages. Resuming it would present an empty conversation that still looks like the
  // old one, and the first save would write that emptiness over the file. Start fresh and
  // say why, rather than letting the user type into a session that has already lost its
  // history. The damaged file stays on disk, so nothing is destroyed by refusing.
  if (session && session._unrecoverable) {
    process.stderr.write(
      `hncode: session ${session.id} has no readable history (its file is damaged). `
      + 'Starting a new session; the old file is untouched.\n',
    );
    session = null;
  }
  if (!session) {
    session = { id: sess.newId(), title: '', workspace: path.resolve(process.cwd()), model: cfg.model, createdAt: Date.now(), messages: [] };
  } else {
    // CRITICAL: Update session model to match current config!
    // This prevents using stale model ID from old sessions.
    session.model = cfg.model;
  }
  return session;
}


/**
 * Parse the --web flag into { bindIp, port } or null.
 *   --web                  -> loopback, OS-assigned port
 *   --web 8080             -> loopback, that port
 *   --web 0.0.0.0:8080     -> explicit address and port
 *   --web 192.168.1.5      -> that address, OS-assigned port
 * Anything unparseable returns null, so the flag is ignored rather than failing
 * the launch — /web from inside the session still works either way.
 */
export function parseWebArg(v) {
  if (v == null || v === false) return null;
  if (v === true) return { bindIp: '127.0.0.1', port: 0 };
  const s = String(v).trim();
  if (!s) return { bindIp: '127.0.0.1', port: 0 };
  let bindIp = '127.0.0.1';
  let port = 0;
  if (/^\d+$/.test(s)) {
    port = Number(s);
  } else if (s.includes(':')) {
    // IPv6 in brackets is deliberately not handled: /web covers it, and a
    // half-parsed address is worse than ignoring the flag.
    const at = s.lastIndexOf(':');
    bindIp = s.slice(0, at) || '127.0.0.1';
    const p = s.slice(at + 1);
    if (!/^\d+$/.test(p)) return null;
    port = Number(p);
  } else {
    bindIp = s;
  }
  if (port < 0 || port > 65535) return null;
  return { bindIp, port };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.help) { printHelp(); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  // subcommands
  const [cmd, sub] = args.positional;
  if (cmd) {
    if (cmd === 'doctor' && !sub) { return await cmdDoctorEnv(); }
    const handler = SUBCOMMANDS[cmd];
    if (handler) {
      // A `{ needsArgs, run }` entry wants the parsed flags as well as the positional path — the one thing a
      // module-level table cannot close over, because `args` lives in this function.
      if (typeof handler === 'object' && typeof handler.run === 'function') {
        return await handler.run(args.positional[1], args);
      }
      if (sub !== undefined) {
        const h2 = handler[sub];
        if (h2) return await h2(args.positional[2]);
        printHelp(); return 1;
      }
      if (typeof handler === 'function') return await handler(args.positional[1]);
      printHelp(); return 0;
    }
    console.error(`unknown command: ${cmd}`);
    return 1;
  }

  const baseCfg = resolveConfig();
  const cfg = resolveModelArg(baseCfg, args.model);

  // Plugins are normally loaded by bootstrap (bin/hncode) BEFORE this module is
  // imported, because symbol patching has to register targets before the patched
  // modules load. Only load them here when bootstrap did NOT already do it (e.g.
  // index.js imported directly, or a test), so tools/commands still appear in
  // both modes without a second load tripping "tool already registered".
  try {
    const { pluginsAlreadyLoaded } = await import('./bootstrap.js');
    if (cfg.pluginDir && !pluginsAlreadyLoaded() && !globalThis.__hncodePluginsLoaded) {
      const { loadPlugins } = await import('./plugin.js');
      await loadPlugins(cfg.pluginDir);
      globalThis.__hncodePluginsLoaded = true;
    }
  } catch (e) {
    console.error('[hncode] plugin load step failed, continuing without plugins:', e && e.message);
  }

  // Connect configured MCP servers and register their tools.
  //
  // This is a FUNCTION rather than an inline block because the two modes want
  // different timing:
  //   * headless (`-p`) MUST wait — the prompt runs immediately and its model
  //     request has to see the MCP tools in the tool list.
  //   * the TUI must NOT wait — connecting can take seconds (8s per wedged
  //     server), and blocking the first paint for that is unacceptable. The TUI
  //     starts this in the background and reports the result as a notice.
  // Failures are reported but never fatal: an unreachable server must not stop
  // the session from starting.
  const connectMcp = async (mcpOpts = {}) => {
    if (cfg.mcp === false) return { servers: [], toolCount: 0 };
    try {
      const mcp = await import('./mcp.js');
      const { API } = await import('./plugin.js');
      const mcpCfg = mcp.loadMcpConfig(cfg.workspace);
      if (!Object.keys(mcpCfg.servers).length) return { servers: [], toolCount: 0 };
      const res = await mcp.connectAll(mcpCfg, (spec) => API.registerTool(spec), mcpOpts);
      mcp.setLiveConnections(res.servers);
      if (process.env.HNCODE_MCP_VERBOSE === '1') {
        for (const s of res.servers) {
          console.error(s.ok ? `[hncode-mcp] ${s.name}: ${s.toolCount} tool(s)` : `[hncode-mcp] ${s.name}: ${s.error}`);
        }
      }
      return res;
    } catch (e) {
      console.error(`hncode: MCP setup failed: ${e.message}`);
      return { servers: [], toolCount: 0 };
    }
  };

  // headless prompt: MCP must be live BEFORE the request goes out.
  if (args.prompt) {
    const format = args['output-format'];
    if (!isValidFormat(format)) {
      console.error(`hncode: unknown --output-format "${format}". Use one of: ${FORMATS.join(', ')}.`);
      return EXIT.CONFIG;
    }
    await connectMcp();
    let session = null;
    if (args.session) session = typeof args.session === 'string' ? sess.loadSession(args.session) : sess.latestSession(undefined, undefined, { skipEmpty: true });
    else if (args.continue) session = sess.latestSession(undefined, undefined, { skipEmpty: true });
    // --timeout / --retries are validated here so a typo fails loudly instead of
    // being parsed as NaN and silently ignored.
    const timeoutSeconds = args.timeout !== undefined ? Number.parseInt(String(args.timeout), 10) : 0;
    if (args.timeout !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)) {
      console.error(`hncode: --timeout needs a positive integer (seconds), got "${args.timeout}".`);
      return EXIT.CONFIG;
    }
    const maxRetries = args.retries !== undefined ? Number.parseInt(String(args.retries), 10) : undefined;
    if (args.retries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
      console.error(`hncode: --retries needs a non-negative integer, got "${args.retries}".`);
      return EXIT.CONFIG;
    }
    return runPrompt({ cfg, prompt: args.prompt, format, session, modelArg: args.model, timeoutSeconds, maxRetries });
  }

  if (!process.stdout.isTTY) {
    console.error('hncode: interactive mode requires a TTY. Use `hncode -p "prompt"` for non-interactive use.');
    return EXIT.FAILURE;
  }

  const opts = {
    cfg,
    sessionFlag: args.session,
    sessionId: typeof args.session === 'string' ? args.session : null,
    cont: !!args.continue,
    yolo: !!args.yolo,
    auto: !!args.auto,
    plan: !!args.plan,
    addDirs: args['add-dir'] || [],
    // Remote control: expose a local socket so a script can queue a prompt or
    // query status on the running session (see ci.js).
    control: args.control === true ? '' : (typeof args.control === 'string' ? args.control : null),
    // Web UI: start the server as soon as the TUI is up. `--web` alone binds
    // loopback on an OS-assigned port; `--web 0.0.0.0:8080` chooses both. Parsed
    // here so it behaves like every other flag, and the TUI still has /web to
    // start or stop it mid-session.
    web: parseWebArg(args.web),
    // MCP runs in the BACKGROUND once the TUI is up (see startTUI): connecting
    // can take seconds and must not delay the first paint.
    mcpConnect: connectMcp,
    session: loadOrCreateSession(args, cfg),
  };
  await startTui(opts);
  return EXIT.OK;
}

// main() is invoked by bin/hncode (the CLI entry point), which imports this module
// and calls main(process.argv.slice(2)) explicitly.