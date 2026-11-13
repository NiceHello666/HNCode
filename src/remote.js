// Remote skills and plugins — pull them from the hncode GitHub repo.
//
// Both live in the repo under a folder per item:
//
//   skills/<name>/SKILL.md      ->  ~/.hncode/skills/<name>.md
//   plugins/<name>/…            ->  ~/.hncode/plugins/…
//
// The layout differs on purpose. A SKILL is a single Markdown prompt fragment, so it
// is FLATTENED to `<name>.md`: that is what `skills.js` already reads (and what makes
// `/skill:<name>` work without teaching the loader about directories). A PLUGIN is an
// ESM module that may sit beside helper files, so it is copied as a directory or, when
// it is a single file, as that file — see installPlugin.
//
// Discovery uses the GitHub Contents API and downloads use raw.githubusercontent.com.
// No git, no dependencies: a user who has never installed git can still pull a skill,
// and fetching one item does not drag down the whole repository.
//
// Everything network-facing is best-effort and reports failure as a value rather than
// throwing, so a command can print what went wrong instead of killing the TUI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillsDir, normalizeSkillName } from './skills.js';

// TLS verification is ON by default — and that must include every OTHER connection
// the process makes (the LLM API carrying the key, MCP HTTP transports). If a local
// proxy / AV breaks the cert chain, HNCODE_DISABLE_TLS_VERIFY skips verification for
// THESE GitHub fetches ONLY: the flag is scoped per request in tlsFetch below, never
// set process-wide.
const INSECURE_TLS = !!process.env.HNCODE_DISABLE_TLS_VERIFY;
if (INSECURE_TLS) {
  // Node prints an "insecure TLS" warning when the override applies. Replace the
  // default `warning` handler with one that swallows only that message, so the rest
  // of Node's warnings still come through.
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning && /NODE_TLS_REJECT_UNAUTHORIZED/i.test(warning.message || '')) return;
    const pid = process.pid;
    const name = warning && warning.name ? `${warning.name}: ` : '';
    let line = `(node:${pid}) ${name}${warning && warning.message ? warning.message : String(warning)}`;
    if (warning && warning.detail) line += `\n${warning.detail}`;
    process.stderr.write(line + '\n');
  });
}

// undici reads NODE_TLS_REJECT_UNAUTHORIZED when EACH TLS connection is made
// (verified: setting it at runtime changes the very next fetch), so the flag can be
// held only for the duration of one request and restored after — the LLM and MCP
// connections elsewhere in the process keep full verification.
async function tlsFetch(url, opts = {}) {
  if (!INSECURE_TLS) return fetch(url, opts);
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try { return await fetch(url, opts); }
  finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}

// The canonical source. Overridable so a fork (or a test) can point elsewhere.
export const DEFAULT_REPO = process.env.HNCODE_REPO || 'NiceHello666/HNCode';
export const DEFAULT_REF = process.env.HNCODE_REPO_REF || 'main';

// Where remote plugins land. `plugin.js` loads *.js/*.mjs from this directory.
export function pluginsDir() {
  return process.env.HNCODE_PLUGINS || path.join(os.homedir(), '.hncode', 'plugins');
}

// Plugin files that are never worth downloading or dangerous to copy blindly.
const PLUGIN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md']);

const USER_AGENT = 'hncode-remote';

async function ghJson(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await tlsFetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) {
      // 404 is the normal "the folder does not exist yet" case, so it gets its own
      // wording: the repo simply has not had anything contributed to that folder.
      if (res.status === 404) return { ok: false, error: 'not-found' };
      if (res.status === 403) return { ok: false, error: 'rate-limited' };
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await tlsFetch(url, { signal: ctl.signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function apiContents(repo, ref, dir) {
  return `https://api.github.com/repos/${repo}/contents/${dir}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
}

function rawUrl(repo, ref, file) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
}

// Each item is a DIRECTORY in the repo (skills/<name>/, plugins/<name>/). A loose file
// at the top level is ignored: the convention is the contract, and accepting both
// would make the listing ambiguous about what a name refers to.
function dirsOnly(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.type === 'dir' && e.name && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** List the skills available in the repo: [{ name, path }]. */
export async function listRemoteSkills({ repo = DEFAULT_REPO, ref = DEFAULT_REF } = {}) {
  const r = await ghJson(apiContents(repo, ref, 'skills'));
  if (!r.ok) return r;
  return { ok: true, items: dirsOnly(r.data) };
}

/** List the plugins available in the repo: [{ name, path }]. */
export async function listRemotePlugins({ repo = DEFAULT_REPO, ref = DEFAULT_REF } = {}) {
  const r = await ghJson(apiContents(repo, ref, 'plugins'));
  if (!r.ok) return r;
  return { ok: true, items: dirsOnly(r.data) };
}

// A skill's description comes from its front-matter (the same field `skills.js` reads
// for a local skill), so the local and remote listings describe a skill identically.
function describeSkill(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*(?:description|title)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) {
      let v = kv[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return '';
}

/**
 * Fetch the SKILL.md inside each remote skill directory, so the list can show what a
 * skill is before the user installs it. One request per skill; failures leave the
 * description empty rather than dropping the entry.
 */
export async function listRemoteSkillsDetailed({ repo = DEFAULT_REPO, ref = DEFAULT_REF } = {}) {
  const listed = await listRemoteSkills({ repo, ref });
  if (!listed.ok) return listed;
  const items = await Promise.all(listed.items.map(async (it) => {
    const file = `${it.path}/SKILL.md`;
    const r = await fetchText(rawUrl(repo, ref, file));
    return { ...it, file, description: r.ok ? describeSkill(r.text) : '', readable: r.ok };
  }));
  return { ok: true, items };
}

/**
 * Install one remote skill as `~/.hncode/skills/<name>.md`.
 *
 * The repo requires the file to be named SKILL.md; a directory without one is skipped
 * (returns ok:false) instead of creating a nameless entry. Returns
 * { ok, name, path, replaced } or { ok: false, error }.
 */
export async function installRemoteSkill(name, { repo = DEFAULT_REPO, ref = DEFAULT_REF, overwrite = true } = {}) {
  const clean = normalizeSkillName(name);
  // A name is a path SEGMENT in the repo URL. Reject anything that could escape it or
  // name a hidden directory, before the request is even made — `.hidden` used to slip
  // through and only fail later as a confusing "no SKILL.md" 404.
  if (!clean || /[\\/]/.test(clean) || clean.startsWith('.') || /[\u0000-\u001f]/.test(clean)) {
    return { ok: false, error: `Invalid skill name: ${name}` };
  }

  const file = `skills/${clean}/SKILL.md`;
  const r = await fetchText(rawUrl(repo, ref, file));
  if (!r.ok) {
    return { ok: false, error: r.error === 'HTTP 404'
      ? `No SKILL.md at ${file} (each skill directory must contain SKILL.md).`
      : `Could not download ${file}: ${r.error}` };
  }
  if (!r.text.trim()) return { ok: false, error: `${file} is empty.` };

  const dir = skillsDir();
  const dest = path.join(dir, `${clean}.md`);
  const replaced = fs.existsSync(dest);
  if (replaced && !overwrite) return { ok: false, error: 'exists', replaced: true, path: dest };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, r.text, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot write ${dest}: ${e.message}` };
  }
  return { ok: true, name: clean, path: dest, replaced, description: describeSkill(r.text) };
}

/** Remove an installed skill by name (thin alias so the command reads uniformly). */
export function removeLocalSkill(name) {
  const clean = normalizeSkillName(name);
  if (!clean) return false;
  try { fs.unlinkSync(path.join(skillsDir(), `${clean}.md`)); return true; } catch { return false; }
}

// ---- plugins ---------------------------------------------------------------

// Flatten a Contents API tree into { path, type, size } for one plugin directory.
async function listDir(repo, ref, dir) {
  const r = await ghJson(apiContents(repo, ref, dir));
  if (!r.ok) return r;
  return { ok: true, entries: Array.isArray(r.data) ? r.data : [] };
}

/**
 * Install one remote plugin into `~/.hncode/plugins/`.
 *
 * Two shapes are accepted, because a plugin is either one file or a small package:
 *   plugins/<name>/index.js (+ helpers)
 *   plugins/<name>/<name>.js
 * Sub-directories are copied recursively; only the extensions plugins can actually be
 * loaded from are fetched, so a stray asset cannot land in the plugin directory.
 */
export async function installRemotePlugin(name, { repo = DEFAULT_REPO, ref = DEFAULT_REF, overwrite = true } = {}) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean || /[\\/]/.test(clean) || clean.startsWith('.')) {
    return { ok: false, error: `Invalid plugin name: ${name}` };
  }
  const srcDir = `plugins/${clean}`;
  const listed = await listDir(repo, ref, srcDir);
  if (!listed.ok) {
    return { ok: false, error: listed.error === 'not-found'
      ? `No plugins/${clean} directory in the repo.`
      : `Could not list ${srcDir}: ${listed.error}` };
  }

  const files = listed.entries.filter((e) => e.type === 'file'
    && PLUGIN_EXT.has(path.extname(e.name).toLowerCase()));
  if (!files.length) return { ok: false, error: `plugins/${clean} has no .js/.mjs/.json files.` };

  const destDir = path.join(pluginsDir(), clean);
  const dest = path.join(destDir, files[0].name);
  const existed = fs.existsSync(destDir);
  if (existed && !overwrite) return { ok: false, error: 'exists', replaced: true, path: destDir };

  const written = [];
  for (const f of files) {
    const r = await fetchText(rawUrl(repo, ref, f.path));
    if (!r.ok) return { ok: false, error: `Could not download ${f.path}: ${r.error}` };
    const out = path.join(destDir, path.basename(f.path));
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.text, 'utf8');
    } catch (e) {
      return { ok: false, error: `Cannot write ${out}: ${e.message}` };
    }
    written.push(path.basename(f.path));
  }
  return { ok: true, name: clean, path: destDir, files: written, replaced: existed };
}

/** Remove an installed plugin directory (or a single-file plugin) by name. */
export function removeLocalPlugin(name) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean || /[\\/]/.test(clean)) return false;
  const dir = path.join(pluginsDir(), clean);
  if (fs.existsSync(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; } }
  // A single-file plugin installs as <name>.js.
  for (const ext of ['.js', '.mjs', '.cjs']) {
    const f = path.join(pluginsDir(), clean + ext);
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); return true; } catch { return false; } }
  }
  return false;
}

/** Installed plugin names, read from the plugin directory. */
export function listLocalPlugins() {
  let entries;
  try { entries = fs.readdirSync(pluginsDir()); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = path.join(pluginsDir(), e);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push({ name: e, kind: 'dir', path: full });
    else if (/\.(mjs?|cjs)$/i.test(e)) out.push({ name: e.replace(/\.[^.]+$/, ''), kind: 'file', path: full });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
