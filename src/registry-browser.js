// RegistryBrowser — the full-screen /skills and /plugins manager.
//
// Modelled on kimi-code's PluginsPanelComponent (a tabbed list where every row has a
// DESCRIPTION under its label) and on this project's own /tasks browser: pure
// rendering plus key handling, returning ACTION STRINGS to the caller so all state
// stays in one place.
//
//   ────────────────────────────────────────────────────────────────
//    Skills
//    Tab switch · ↑↓ select · Enter install/remove · Esc close
//
//    [Installed (1)]  Available (3)
//
//    ❯ demo                          installed
//        A demo skill
//      review-pr                     install
//        Review a pull request for bugs
//    ────────────────────────────────────────────────────────────────
//
// The description line is the reason this exists instead of the plain list panel: a
// skill or plugin is meaningless without knowing what it does, and the picker's inline
// `sub` truncates on a narrow terminal.
//
// Tabs differ per kind, because the two halves mean different things:
//   TABS_LOCAL  = what is on disk here (installed skills / plugins on disk)
//   TABS_REMOTE = what the repo offers, with an `installed` badge when present

import { C } from './colors.js';
import { visualWidth } from './term.js';

const ELLIPSIS = '\u2026';
const ESC = '\x1b';
const MIN_WIDTH = 44;
const MIN_HEIGHT = 8;

function visWidth(s) { return visualWidth(String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')); }

function truncateToWidth(s, width) {
  const str = String(s);
  let out = '';
  let n = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visWidth(ch);
    if (n + cw > width - 1) return out + ELLIPSIS + ' '.repeat(Math.max(0, width - n - 1));
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

function fitExactly(line, width) {
  const w = visWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width);
  return line + ' '.repeat(width - w);
}

/** Plain-text wrap so a long description keeps its own indented lines. */
function wrapText(text, width) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (visWidth(next) <= width) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = visWidth(w) <= width ? w : w.slice(0, Math.max(1, width));
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// Tabs. `id` is what the key handler switches on; `label` is shown with the count.
export const SKILL_TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'available', label: 'Available' },
];
export const PLUGIN_TABS = [
  { id: 'loaded', label: 'Loaded' },
  { id: 'ondisk', label: 'On disk' },
  { id: 'available', label: 'Available' },
];

/** The rows for one tab. Each row: { label, description, status, statusTone, name, action }. */
export function rowsForTab(state, tabId) {
  const d = state.data || {};
  if (state.kind === 'skills') {
    if (tabId === 'installed') {
      return (d.installed || []).map((s) => ({
        name: s.name,
        label: s.name,
        description: s.description || '(no description)',
        status: 'installed',
        statusTone: 'dim',
        action: 'remove-skill',
      }));
    }
    const local = new Set((d.installed || []).map((s) => s.name));
    return (d.remote || []).map((r) => ({
      name: r.name,
      label: r.name,
      description: r.description || (r.readable === false ? '(no SKILL.md — cannot install)' : '(no description)'),
      status: local.has(r.name) ? 'Installed' : 'Not Install',
      statusTone: local.has(r.name) ? 'ok' : 'warn',
      action: local.has(r.name) ? 'reinstall-skill' : 'install-skill',
      disabled: r.readable === false,
    }));
  }
  // plugins
  if (tabId === 'loaded') {
    return (d.loaded || []).map((p) => ({
      name: p.name,
      label: p.name,
      description: `v${p.version || '0.0.0'} · ${p.id}`,
      status: 'loaded',
      statusTone: 'ok',
      action: 'none',
    }));
  }
  if (tabId === 'ondisk') {
    // Match on the DIRECTORY a plugin was loaded from, not on the name it reports.
    //
    // A plugin declares its own `name`, and it need not match the directory it sits in. Comparing
    // names meant any plugin where the two differed showed "Need Restart" forever: the name it
    // reported could never equal the directory it was found under, so restarting never helped.
    // `computer-use/` declaring `hncode-cu` is the ordinary case, not an oddity.
    //
    // `loaded` records each plugin with an `id` of `<dirname>/<entry>` while `onDisk` reports only a
    // bare `name` (the directory, or the filename for a single-file plugin). The first segment of
    // the id is therefore the thing to compare, and it covers both layouts: a directory's id starts
    // with its directory name, and a single file's id IS its filename.
    const loadedDirs = new Set();
    const loadedNames = new Set();
    for (const p of d.loaded || []) {
      if (p.id) loadedDirs.add(String(p.id).split('/')[0]);
      if (p.name) loadedNames.add(String(p.name));
    }
    const isLoaded = (p) => loadedDirs.has(String(p.name)) || loadedNames.has(String(p.name));
    return (d.onDisk || []).map((p) => ({
      name: p.name,
      label: p.name + (p.kind === 'dir' ? '/' : ''),
      description: isLoaded(p) ? 'loaded in this session' : 'not loaded — Need Restart',
      status: isLoaded(p) ? 'loaded' : 'Need Restart',
      statusTone: isLoaded(p) ? 'ok' : 'warn',
      action: 'remove-plugin',
    }));
  }
  const local = new Set((d.onDisk || []).map((p) => p.name));
  return (d.remote || []).map((r) => ({
    name: r.name,
    label: r.name,
    description: local.has(r.name) ? 'already installed locally' : 'available in the repository',
    status: local.has(r.name) ? 'Installed' : 'Not Install',
    statusTone: local.has(r.name) ? 'ok' : 'warn',
    action: local.has(r.name) ? 'reinstall-plugin' : 'install-plugin',
  }));
}

function statusColor(tone) {
  if (tone === 'ok') return C.green;
  if (tone === 'warn') return C.orange;
  if (tone === 'dim') return C.gray;
  return C.blue;
}

/**
 * The rows a tab SHOWS, after the search filter.
 *
 * The renderer and the action handler must agree on this or the list lies: with a query typed,
 * `selectedIndex` counts entries in the FILTERED list, so looking it up in the unfiltered one acts on whatever
 * happened to sit at that position instead of the row under the cursor.
 *
 * The tab COUNTS stay on the unfiltered list — a filter must never make a tab look empty.
 */
export function visibleRowsForTab(state, tabId) {
  const rows = rowsForTab(state, tabId);
  const query = String(state && state.filter || '').trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((r) => [r.label, r.description, r.name]
    .map((v) => String(v == null ? '' : v)).join(' ').toLowerCase().includes(query));
}

export function renderRegistryBrowser(state, cols, rows) {
  if (cols < MIN_WIDTH || rows < MIN_HEIGHT) {
    const lines = [fitExactly(C.red + 'Terminal too small (need >= ' + MIN_WIDTH + ' x ' + MIN_HEIGHT + ')' + C.reset, cols)];
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(cols));
    return lines;
  }
  const title = state.kind === 'skills' ? ' Skills' : ' Plugins';
  const tabs = state.kind === 'skills' ? SKILL_TABS : PLUGIN_TABS;
  const tabIdx = Math.max(0, tabs.findIndex((t) => t.id === state.tab));
  const tab = tabs[tabIdx] || tabs[0];
  // The header row and the empty-state message both need to know whether a filter is on.
  const query = String(state.filter || '').trim().toLowerCase();
  const all = visibleRowsForTab(state, tab.id);
  const sel = Math.max(0, Math.min(all.length - 1, state.selectedIndex || 0));

  const out = [];
  const rule = C.border + '\u2500'.repeat(cols) + C.reset;
  // Mouse targets for this frame. The browser is pure render + key, so it records
  // its own hitboxes here and the caller (tui.js) maps mouse events onto them —
  // exactly like the tasks browser does with `_taskHits`. Row is a FRAME row
  // (0 = the top rule); the caller converts the 1-based screen row.
  const hits = [];
  state._regHits = hits;
  out.push(rule);
  out.push(fitExactly(C.cyan + C.bold + title + C.reset, cols));
  // The key hints stay visible while the fetch runs: the panel is usable during it
  // (the local tabs are already loaded), so replacing the hints with a status message
  // would hide the keys exactly when the user is most likely to press them.
  const hint = ' / search \u00b7 Tab switch \u00b7 \u2191\u2193 select \u00b7 Enter install/remove \u00b7 Esc close';
  out.push(fitExactly(C.gray + hint + (state.busy ? C.gray + `  ${state.busy}` : '') + C.reset, cols));
  out.push('');
  // The search field, drawn whenever it is open or has text, so a filtered list always explains itself.
  if (state.filtering || query) {
    const shown = String(state.filter || '');
    const caret = state.filtering ? '\u2588' : '';
    out.push(C.gray + ' / ' + C.reset + C.white + shown + C.reset + C.cyan + caret + C.reset
      + C.gray + (query ? `   ${all.length} match${all.length === 1 ? '' : 'es'}` : '   type to filter') + C.reset);
  }

  // Tab strip, with the count of each tab's rows.
  {
    const stripRow = out.length;
    let col = 0;
    const segs = tabs.map((t) => {
      const n = rowsForTab(state, t.id).length;
      const text = t.id === tab.id ? `[${t.label} (${n})]` : ` ${t.label} (${n}) `;
      const col0 = col;
      col += visWidth(text) + 1;   // +1 for the joining space
      return { id: t.id, text, col0, col1: col0 + visWidth(text) - 1 };
    });
    out.push(segs.map((s) => (s.id === tab.id
      ? C.cyan + C.bold + s.text + C.reset
      : C.gray + s.text + C.reset)).join(' '));
    for (const s of segs) hits.push({ row: stripRow, col0: s.col0, col1: s.col1, kind: 'regTab', tab: s.id });
  }
  out.push('');

  // Body: each row is a label line plus its wrapped description, so the footer must be
  // sized against the ROWS, not the lines. A row is 2+ lines tall.
  const listTop = out.length;
  const bodyRows = Math.max(1, rows - listTop - 3);      // leave room for the footer
  if (!all.length) {
    // The message must describe THIS tab. A failed remote fetch used to win over
    // everything, so "Loaded" and "On disk" — which are read straight off the local
    // filesystem and cannot fail from the network — reported "fetch failed" whenever
    // the repo lookup did. That reads as "your local plugins are broken", which is
    // both wrong and alarming. Only the Available tab can talk about the fetch.
    const isRemoteTab = tab.id === 'available';
    // "Loading" only applies to the tab that is actually waiting on the fetch; a local
    // tab is empty because there is genuinely nothing there, and saying "Loading" for
    // data that is already on screen reads as a stall.
    const msg = (isRemoteTab && state.busy) ? '  Loading\u2026'
      : (isRemoteTab && state.data && state.data.remoteError)
        ? '  Could not fetch from the repo: ' + state.data.remoteError
        : isRemoteTab ? '  Nothing published in the repo yet.'
          : '  Nothing here.';
    out.push(C.gray + msg + C.reset);
  }
  // How many LINES each row occupies: its label plus its wrapped description.
  const descW = Math.max(8, cols - 6);
  const rowH = all.map((r) => 1 + wrapText(r.description, descW).length);
  const visibleLines = Math.max(1, bodyRows);

  // The first row to draw. `state.listTop` persists across frames — recomputing it from scratch each time would
  // snap the window back to the top on every key, and the cursor would appear to leave the list.
  let first = Math.max(0, Math.min(state.listTop || 0, Math.max(0, all.length - 1)));
  // Scroll down while the selection does not fit; scroll up if it sits above the window.
  if (sel < first) first = sel;
  for (;;) {
    let used = 0;
    for (let i = first; i <= sel && i < all.length; i++) used += rowH[i];
    if (used <= visibleLines || first >= sel) break;
    first++;
  }
  state.listTop = first;

  // Draw from `first`, stopping when the window is full. A row is never split: a label whose description fell
  // off the bottom reads as a row that has none.
  let drawn = 0;
  for (let i = first; i < all.length; i++) {
    if (drawn > 0 && drawn + rowH[i] > visibleLines) break;
    drawn += rowH[i];
    const r = all[i];
    const isSel = i === sel;
    const ptr = isSel ? C.cyan + '\u276f ' + C.reset : '  ';
    const nameStyle = isSel ? (C.cyan + C.bold) : C.white;
    const badge = r.status ? '  ' + statusColor(r.statusTone) + r.status + C.reset : '';
    const dis = r.disabled ? C.gray : '';
    const labelRow = out.length;
    out.push(fitExactly(ptr + nameStyle + dis + r.label + C.reset + badge, cols));
    // The whole label row is a click target: clicking selects the item (and a second click / the footer
    // activates it), mirroring the tasks browser.
    hits.push({ row: labelRow, col0: 0, col1: cols - 1, kind: 'regRow', index: i });
    for (const line of wrapText(r.description, descW)) {
      out.push(C.gray + '    ' + line + C.reset);
    }
  }
  // Say when the list continues: a clipped list that looks complete is how a skill goes missing.
  let after = first;
  let acc = 0;
  while (after < all.length && acc < drawn) { acc += rowH[after]; after++; }
  const hiddenBelow = all.length - after;
  if (first > 0) out.push(C.gray + `  \u2191 \u2191 \u2191 ${first} above` + C.reset);
  if (hiddenBelow > 0) out.push(C.gray + `  \u2193 \u2193 \u2193 ${hiddenBelow} below` + C.reset);
  // A fetch failure has to show even when the LOCAL half has rows, or the Available
  // tab silently looks empty and the user cannot tell why.
  if (all.length && state.data && state.data.remoteError && tab.id === 'available') {
    out.push('');
    out.push(C.orange + '  Could not fetch the list: ' + state.data.remoteError + C.reset);
  }
  // The last action's outcome (installed / removed / failed) sits above the hint line.
  if (state.flash) {
    out.push('');
    out.push(C.cyan + '  ' + state.flash + C.reset);
  }

  // Footer: what the highlighted row would DO, so the effect of Enter is never a
  // surprise. A row already installed says "reinstall", because that is what Enter
  // does there (and it is the only way to pick up a newer version).
  const cur = all[sel];
  const action = !cur ? ''
    : cur.disabled ? 'Enter does nothing \u2014 this entry has no SKILL.md'
      : cur.action === 'reinstall-skill' || cur.action === 'reinstall-plugin'
        ? 'Enter reinstalls ' + cur.name + ' (replaces the local copy)'
        : cur.action === 'install-skill' || cur.action === 'install-plugin'
          ? 'Enter installs ' + cur.name + ' from the repository'
          : cur.action.startsWith('remove') ? 'Enter removes the local copy of ' + cur.name
            : 'loaded plugin \u2014 switch to the On disk tab to remove it';
  while (out.length < rows - 2) out.push('');
  out.push(fitExactly(C.gray + ' ' + action + C.reset, cols));
  out.push(rule);
  return out.slice(0, rows);
}

/**
 * One key. Returns an action string for the caller:
 * 'close' | 'switchTab' | 'select' | 'install' | 'remove' | 'reload' | null
 */
export function handleRegistryBrowserKey(state, t) {

  const tabs = state.kind === 'skills' ? SKILL_TABS : PLUGIN_TABS;
  const all = rowsForTab(state, state.tab);
  const ch = t.ch;
  // ---- filter input -------------------------------------------------------------------------
  //
  // While `state.filtering` is on, every printable key goes into the query instead of acting on the list. Esc
  // leaves the field without clearing the filter, so a half-typed word is not lost by a stray key; a second Esc
  // clears it. Enter accepts the filter and returns the keyboard to the list.
  if (state.filtering) {
    if (t.key === 'escape') { state.filtering = false; return 'select'; }
    if (t.key === 'enter') { state.filtering = false; return 'select'; }
    if (t.key === 'backspace') {
      state.filter = String(state.filter || '').slice(0, -1);
      state.selectedIndex = 0;
      state.listTop = 0;
      return 'select';
    }
    if (t.key === 'up' || t.key === 'down') { state.filtering = false; }   // hand the arrows back to the list
    else if (ch && ch.length === 1 && ch >= ' ') {
      state.filter = String(state.filter || '') + ch;
      state.selectedIndex = 0;
      state.listTop = 0;
      return 'select';
    } else { return null; }
  }

  // `/` opens the field; a set filter stays visible in the header and Esc clears it from the list too.
  if (ch === '/') { state.filtering = true; return 'select'; }
  if (t.key === 'escape' && state.filter) { state.filter = ''; state.selectedIndex = 0; state.listTop = 0; return 'select'; }

  if (t.key === 'escape' || ch === 'q' || ch === 'Q') return 'close';
  if (t.key === 'tab') {
    const i = Math.max(0, tabs.findIndex((x) => x.id === state.tab));
    state.tab = tabs[(i + 1) % tabs.length].id;
    state.selectedIndex = 0;
    return 'switchTab';
  }
  if (t.key === 'up' || ch === 'k') {
    state.selectedIndex = Math.max(0, (state.selectedIndex || 0) - 1);
    return 'select';
  }
  if (t.key === 'down' || ch === 'j') {
    state.selectedIndex = Math.min(Math.max(0, all.length - 1), (state.selectedIndex || 0) + 1);
    return 'select';
  }
  if (t.key === 'home') { state.selectedIndex = 0; return 'select'; }
  if (t.key === 'end') { state.selectedIndex = Math.max(0, all.length - 1); return 'select'; }
  if (ch === 'r' || ch === 'R') return 'reload';
  if (t.key === 'enter' || t.key === 'space' || ch === ' ') {
    const row = all[state.selectedIndex || 0];
    if (!row || row.disabled) return null;
    // `installed` on the Available tab still reinstalls: that is how you pick up a
    // newer version of something you already have, and refusing it would leave no way
    // to update.
    if (row.action.startsWith('install')) return 'install';
    if (row.action.startsWith('remove')) return 'remove';
    return null;
  }
  if (ch === 'd' || ch === 'D') {
    const row = all[state.selectedIndex || 0];
    if (row && row.action.startsWith('remove')) return 'remove';
    return null;
  }
  return null;
}
