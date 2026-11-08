// Skills — user-supplied reusable prompt packages.
//
// A skill is a Markdown file under ~/.hncode/skills/<name>.md. Its body is
// text that gets injected into the conversation when the user activates it, so
// a skill is essentially a saved prompt fragment ("review this PR for security
// issues", "write tests in this project's style", …).
//
// Two ways a skill comes into being:
//   * /import-skill <file.md>  — copies (or overwrites) an external .md into the
//     skills directory. A duplicate name is REPLACED, not rejected.
//   * hand-authoring a file in the skills directory.
//
// Activation is /skill:<name>. The file body is what gets sent; an optional YAML
// front-matter block (--- … ---) is stripped from the body and only used for the
// display name / description, so a skill file can stay self-describing without
// leaking its metadata into the prompt.
//
// Everything here is filesystem-only and side-effect free apart from the
// explicit import/write helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpsRequest } from './tools/fetch-url.js';
export const SKILL_PREFIX = 'skill:';

// The skills directory. Kept next to the other hncode state (~/.hncode/…), and
// overridable through the environment for tests.
export function skillsDir() {
  return process.env.HNCODE_SKILLS_DIR || path.join(os.homedir(), '.hncode', 'skills');
}

// A skill name is the file's basename without extension. Normalise what the
// user typed ("Skill:Review", "/skill:review", "review.md") to a bare name.
export function normalizeSkillName(name) {
  let n = String(name == null ? '' : name).trim();
  n = n.replace(/^\/+/, '');                  // leading slash
  if (n.toLowerCase().startsWith(SKILL_PREFIX)) n = n.slice(SKILL_PREFIX.length);
  n = n.replace(/\.md$/i, '');                // trailing .md
  return n.trim();
}

// Parse an optional leading `---\n…\n---` front-matter block. Returns the body
// with the block removed, plus whatever fields were found. Tolerates a missing
// or malformed block (then body === text and meta is empty).
export function parseFrontMatter(text) {
  const src = String(text == null ? '' : text);
  // A DELIMITER THAT WAS ESCAPED IS STILL A DELIMITER.
  //
  // `---\nname: x` is what a skill looks like when something wrote the block with the newlines escaped: the
  // first and last delimiters carry a literal backslash-n while the fields between them use real newlines. The
  // block then matched nothing and the skill listed as "(no description)" — the file reads correctly in an
  // editor, so there was nothing to see. Only the two delimiters are unescaped; a body that contains `\n` on
  // purpose is untouched, because the replacement stops at the first field.
  const norm = src.replace(/^\uFEFF?---\\n(?=[A-Za-z0-9_-])/, '---\n')
    .replace(/\\n---(\\n|$)/, '\n---$1');
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(norm);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    // Strip a single layer of matching quotes.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

// All skills, sorted by name. Each entry: { name, description, path, size }.
// Unreadable files are skipped rather than failing the whole listing.
export function listSkills() {
  const dir = skillsDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const name = f.replace(/\.md$/i, '');
    let description = '';
    try {
      const { meta } = parseFrontMatter(fs.readFileSync(full, 'utf8'));
      description = meta.description || meta.title || '';
    } catch { /* unreadable: keep it listed with no description */ }
    out.push({ name, description, path: full, size: st.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Read a skill's body (front-matter stripped). Returns null when not found.
export function readSkill(name) {
  const n = normalizeSkillName(name);
  if (!n) return null;
  const full = path.join(skillsDir(), `${n}.md`);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontMatter(text);
  return { name: n, description: meta.description || meta.title || '', body: body.trim(), path: full };
}

// Import (copy or overwrite) an external Markdown file as a skill.
// `name` overrides the derived name when given. Returns
// { ok: true, name, path, replaced } or { ok: false, error }.
export function importSkill(file, name) {
  const srcPath = path.resolve(String(file == null ? '' : file));
  let text;
  try {
    const st = fs.statSync(srcPath);
    if (!st.isFile()) return { ok: false, error: `Not a file: ${srcPath}` };
    text = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot read ${srcPath}: ${e.message}` };
  }
  // Name precedence: explicit argument, else front-matter `name`, else filename.
  const { meta } = parseFrontMatter(text);
  const derived = name || meta.name || path.basename(srcPath).replace(/\.md$/i, '');
  const skillName = normalizeSkillName(derived);
  if (!skillName) return { ok: false, error: 'Could not derive a skill name (pass one explicitly).' };
  if (/[\\/]/.test(skillName)) return { ok: false, error: `Invalid skill name: ${skillName}` };

  const dir = skillsDir();
  const dest = path.join(dir, `${skillName}.md`);
  const replaced = fs.existsSync(dest);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot write ${dest}: ${e.message}` };
  }
  return { ok: true, name: skillName, path: dest, replaced };
}

// Register (write or overwrite) a skill from an in-memory Markdown string rather
// than a file on disk. Used by plugins that want to ship a skill as code instead of
// requiring the user to /import-skill a file. The string must contain a leading
// `--- … ---` front-matter block with at least a `name` (or pass `name` explicitly);
// otherwise the name falls back to `name`/`fileName`. Returns the same shape as
// importSkill: { ok: true, name, path, replaced } or { ok: false, error }.
export function addSkillFromText(text, name, fileName = 'skill.md') {
  const content = String(text == null ? '' : text);
  if (!content.trim()) return { ok: false, error: 'Skill content is empty.' };
  const destDir = skillsDir();
  // Derive the name the way importSkill does, so the two paths agree.
  const { meta } = parseFrontMatter(content);
  const derived = name || meta.name || String(fileName || 'skill').replace(/\.md$/i, '');
  const skillName = normalizeSkillName(derived);
  if (!skillName) return { ok: false, error: 'Could not derive a skill name (pass one explicitly).' };
  if (/[\\/]/.test(skillName)) return { ok: false, error: `Invalid skill name: ${skillName}` };
  const dest = path.join(destDir, `${skillName}.md`);
  const replaced = fs.existsSync(dest);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot write ${dest}: ${e.message}` };
  }
  return { ok: true, name: skillName, path: dest, replaced };
}

export function deleteSkill(name) {
  const n = normalizeSkillName(name);
  if (!n) return false;
  try { fs.unlinkSync(path.join(skillsDir(), `${n}.md`)); return true; } catch { return false; }
}

// Completion candidates for the composer: names prefixed with the marker the
// user must type, so accepting a candidate yields `/skill:<name>`.
export function skillCompletions(prefix = '') {
  const p = normalizeSkillName(prefix).toLowerCase();
  return listSkills()
    .filter((s) => !p || s.name.toLowerCase().startsWith(p))
    .map((s) => ({ name: s.name, description: s.description, insert: SKILL_PREFIX + s.name }));
}

// Build the text a skill contributes to the conversation. A short header keeps
// the model from treating the body as the user's own words.
// ---- installing from a GitHub repository ------------------------------------------------

// A registry entry is `owner/repo`, optionally with a subdirectory: `owner/repo/skills`, or
// `owner/repo@ref`. Skills are FOUND, not assumed: every `SKILL.md` below the given path is one,
// because that is the layout the ecosystem uses — a folder per skill, each with its own file.
//
// The listing comes from the GitHub API, which needs no authentication for a public repository and
// is rate limited per IP without a token. Fetching goes through the same transport as FetchURL so a
// broken certificate chain on this network does not make the feature useless.
const GH_API = 'https://api.github.com';

/** Split `owner/repo[/sub][@ref]` into its parts, or null when the shape is wrong. */
export function parseRepoSpec(spec) {
  const text = String(spec == null ? '' : spec).trim().replace(/^https?:\/\/github\.com\//i, '');
  if (!text) return null;
  const at = text.lastIndexOf('@');
  const ref = at > 0 ? text.slice(at + 1) : '';
  const rest = at > 0 ? text.slice(0, at) : text;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...sub] = parts;
  return { owner, repo: repo.replace(/\.git$/i, ''), sub: sub.join('/'), ref: ref || '' };
}

async function ghJson(apiPath, insecure) {
  const res = await httpsRequest(`${GH_API}${apiPath}`, undefined, insecure);
  if (!res.ok) {
    if (res.status === 404) return { error: `not found: ${apiPath}` };
    if (res.status === 403) return { error: 'GitHub refused the request (rate limit without a token, or a private repository)' };
    return { error: `GitHub returned ${res.status}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  try { return { data: JSON.parse(buf.toString('utf8')) }; } catch { return { error: 'GitHub returned something that is not JSON' }; }
}

/** Every `SKILL.md` at or below `path`, as { name, path }. */
async function findSkillFiles(owner, repo, dirPath, ref, insecure, depth = 0) {
  if (depth > 4) return [];
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const r = await ghJson(`/repos/${owner}/${repo}/contents/${dirPath}${q}`, insecure);
  if (r.error) return { error: r.error };
  const entries = Array.isArray(r.data) ? r.data : [];
  const found = [];
  for (const e of entries) {
    if (e.type === 'file' && /^skill\.md$/i.test(e.name)) found.push({ name: e.name, path: e.path, url: e.download_url });
  }
  // A directory that holds a SKILL.md is a skill; do not descend into it looking for more, or a bundle of
  // reference files beside one would be walked for nothing.
  if (found.length) return found;
  for (const e of entries) {
    if (e.type !== 'dir') continue;
    const sub = await findSkillFiles(owner, repo, e.path, ref, insecure, depth + 1);
    if (sub && sub.error) continue;
    found.push(...sub);
  }
  return found;
}

/**
 * Install every skill in a GitHub repository (or a subdirectory of one).
 *
 * Returns { ok: true, installed: [{ name, path, replaced }], skipped: [name] } or { ok: false, error }.
 * A name that is already present is REPLACED — the same rule `/import-skill` uses.
 */
export async function installSkillFromGitHub(specText, { insecure = true } = {}) {
  const spec = parseRepoSpec(specText);
  if (!spec) return { ok: false, error: `Expected owner/repo[/subdir], got "${specText}"` };
  const { owner, repo, sub, ref } = spec;

  const files = await findSkillFiles(owner, repo, sub, ref, insecure);
  if (files && files.error) return { ok: false, error: files.error };
  if (!files.length) {
    return { ok: false, error: `no SKILL.md found in ${owner}/${repo}${sub ? '/' + sub : ''}` };
  }

  const dir = skillsDir();
  const installed = [];
  const skipped = [];
  for (const f of files) {
    // The DIRECTORY name is the skill name — `skills/ds-explain/SKILL.md` is `ds-explain`. The front matter
    // may say something else, but the folder is what the repository is organised by and what the user expects
    // to type after `/skill:`.
    const folder = f.path.split('/').slice(-2)[0] || repo;
    const res = await httpsRequest(f.url, undefined, insecure);
    if (!res.ok) { skipped.push(folder); continue; }
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const name = normalizeSkillName(folder);
    if (!name || /[\\/]/.test(name)) { skipped.push(folder); continue; }
    const dest = path.join(dir, `${name}.md`);
    const replaced = fs.existsSync(dest);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, text, 'utf8');
      installed.push({ name, path: dest, replaced });
    } catch { skipped.push(folder); }
  }
  return { ok: installed.length > 0, installed, skipped, error: installed.length ? '' : 'nothing could be downloaded' };
}

export function skillPrompt(skill) {
  if (!skill || !skill.body) return '';
  return `[skill: ${skill.name}]\n\n${skill.body}`;
}