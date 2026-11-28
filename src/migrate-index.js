// A hand-editable map of what a migration archive holds, and where each session came from.
//
// WHY A SEPARATE FILE INSIDE THE ARCHIVE
// --------------------------------------
// The archive's manifest answers "which bytes, at which offset". It cannot answer the question a person actually has
// when they move machines: "this session was `/home/me/proj` over there — where is it here?" `hncode restore
// --workspace <dir>` can only give every session the SAME answer, which is wrong the moment a person worked in more
// than one directory.
//
// so `index.yml` travels as an ordinary entry in the archive. That matters: it can be extracted with the archive, read
// with a text editor, corrected, and put back — without a tool that understands the format.
//
// NO YAML DEPENDENCY. The project has none, and adding one for fifteen lines of output is not a trade worth making. The
// writer emits a deliberately narrow subset; the reader accepts anything that subset could produce plus the hand edits a
// person is likely to make (comments, blank lines, quoting either way, a missing section). What it does not understand it
// skips, and the caller falls back to the manifest instead of failing an import.

export const INDEX_ENTRY = 'index.yml';

/**
 * Quote a scalar only when YAML would otherwise misread it.
 *
 * A bare `D:\work\proj` is fine; `/home/me/proj` is fine; `""` is an empty string; and something holding `#` or `,` or
 * starting with a dash has to be quoted or the parser takes part of it for a comment or a list marker.
 */
function yamlScalar(v) {
  const s = String(v == null ? '' : v);
  if (s === '') return '""';
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return JSON.stringify(s);
  if (/[:#]\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

/**
 * Render `index.yml`.
 *
 * @param {{home?: string, createdAt?: number, mapping?: Array<{from: string, to: string}>,
 *          sessions?: Array<{id: string, title?: string, workspace?: string, file: string}>}} data
 * @returns {string}
 */
export function renderIndex(data) {
  const out = [];
  out.push('# HNCode migration index');
  out.push('#');
  out.push('# WHERE THE SESSIONS CAME FROM, AND WHERE THEY SHOULD LAND.');
  out.push('#');
  out.push('#   sessions:  one entry per session in the archive. `workspace` is the directory that session was');
  out.push('#              opened on, on the machine the archive was made.');
  out.push('#   mapping:   rewrites applied to a workspace on import. The LONGEST matching prefix wins, so a');
  out.push('#              nested rule beats its parent.');
  out.push('#');
  out.push('# Restoring without --index keeps the workspaces as written below. `hncode restore <archive> --index`');
  out.push('# applies `mapping`. Edit either to move a project: /home/me/proj -> D:\\work\\proj');
  out.push('');
  out.push('version: 1');
  out.push('created: ' + yamlScalar(new Date(data.createdAt || Date.now()).toISOString()));
  out.push('source: ' + yamlScalar(data.home || ''));
  out.push('');
  out.push('# Rewrites applied on import, longest `from` first.');
  out.push('mapping:');
  if (data.mapping && data.mapping.length) {
    for (const m of data.mapping) {
      out.push('  - from: ' + yamlScalar(m.from));
      out.push('    to: ' + yamlScalar(m.to));
    }
  } else {
    out.push('  []');
  }
  out.push('');
  const sessions = data.sessions || [];
  out.push('# ' + sessions.length + ' session(s).');
  out.push('sessions:');
  if (sessions.length) {
    for (const s of sessions) {
      out.push('  - id: ' + yamlScalar(s.id));
      out.push('    title: ' + yamlScalar(s.title || ''));
      out.push('    workspace: ' + yamlScalar(s.workspace || ''));
      out.push('    file: ' + yamlScalar(s.file));
    }
  } else {
    out.push('  []');
  }
  out.push('');
  return out.join('\n');
}

/**
 * Parse `index.yml`.
 *
 * Tolerant by design: this file is meant to be edited by hand, so a comment, a trailing space, single quotes instead of
 * double, or a section left out entirely must not break an import.
 *
 * @returns {{mapping: Array<{from: string, to: string}>, sessions: Array<{id, title, workspace, file}>}|null}
 *          null when the text holds neither a mapping nor a session.
 */
export function parseIndex(text) {
  const mapping = [];
  const sessions = [];
  let section = '';
  let cur = null;

  const unquote = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      if (s.startsWith('"')) { try { return JSON.parse(s); } catch { /* fall through */ } }
      return s.slice(1, -1);
    }
    return s;
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    // A `#` outside quotes starts a comment. The subset this reads never puts one inside a value.
    const line = raw.replace(/\s+#.*$/, '');
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;

    // A TOP-LEVEL KEY IS NOT INDENTED. Testing the trimmed line alone made `    to: /b` look like a section header, which
    // ended the `mapping` block after its first entry and left the parser with nothing.
    const indented = /^\s/.test(line);
    const top = indented ? null : /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(t);
    if (top) {
      const key = top[1];
      section = (key === 'mapping' || key === 'sessions') ? key : '';
      cur = null;
      continue;
    }
    if (!section) continue;
    if (t === '[]') continue;

    if (t.startsWith('-')) {
      cur = {};
      (section === 'mapping' ? mapping : sessions).push(cur);
      const rest = t.slice(1).trim();
      if (rest) {
        const i = rest.indexOf(':');
        if (i > 0) cur[rest.slice(0, i).trim()] = unquote(rest.slice(i + 1));
      }
      continue;
    }
    if (!cur) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    cur[t.slice(0, i).trim()] = unquote(t.slice(i + 1));
  }

  if (!mapping.length && !sessions.length) return null;
  return {
    mapping: mapping.filter((m) => m && m.from && m.to).map((m) => ({ from: String(m.from), to: String(m.to) })),
    sessions: sessions.filter((s) => s && s.file).map((s) => ({
      id: s.id || '', title: s.title || '', workspace: s.workspace || '', file: s.file,
    })),
  };
}

/**
 * Apply a mapping to a path, longest `from` first so a nested rule wins over its parent.
 *
 * Separators are normalised for the COMPARISON only — an archive made on Windows and restored on Linux has to match
 * `D:\work` against `D:/work` — and the caller gets its own path back when nothing matches.
 */
export function mapPath(p, mapping) {
  if (!p || !Array.isArray(mapping) || !mapping.length) return p;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const target = norm(p);
  const sorted = [...mapping].sort((a, b) => norm(b.from).length - norm(a.from).length);
  for (const m of sorted) {
    const from = norm(m.from);
    if (!from) continue;
    if (target === from) return m.to;
    if (target.startsWith(from + '/')) return String(m.to).replace(/\/+$/, '') + target.slice(from.length);
  }
  return p;
}
