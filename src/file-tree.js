// File tree browser — a navigable view of the workspace, opened with /files.
//
// WHY A TREE AND NOT A PICKER
// ---------------------------
// The picker is a flat, filtered list: good for "find me this one file" and bad for
// "what is in here". Reading a project's shape is a question the flat list cannot answer,
// because it has no directories — every path is a string, and the structure is only
// visible by reading the prefixes. This module renders the structure itself.
//
// WHY IT DOES NOT RE-IMPLEMENT THE WALK
// -------------------------------------
// `tools/ignore.js` already walks a tree honouring .gitignore/.hncodeignore, including
// negation patterns and subtree pruning, and it is what Grep and Glob use. A second walker
// here would drift: the browser would show files the tools refuse to search, which is
// worse than no browser. So this module takes a LIST OF PATHS and only arranges it.
//
// WHY THE DIRECTORIES ARE DERIVED, NOT WALKED
// -------------------------------------------
// `walkFiles` returns files. The directories in between are reconstructed from the paths,
// which means the tree can never disagree with the list it came from — and it costs one
// pass over a flat array rather than a second filesystem traversal.

import path from 'node:path';
import { C } from './colors.js';
import { visualWidth } from './term.js';
import { uiText } from './i18n.js';

const ELLIPSIS = '\u2026';
const ESC = '\x1b';

function visWidth(s) { return visualWidth(String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')); }
function col(text, c) { return c + String(text) + C.reset; }

/**
 * Build a directory tree from a flat list of absolute paths.
 *
 * @param {string[]} files absolute paths, as `walkFiles` returns them
 * @param {string} root the workspace root they are relative to
 * @returns {{name:string, rel:string, dir:boolean, children:Array}} the root node
 *
 * Children are sorted DIRECTORIES FIRST, then names, which is what makes a tree readable:
 * a mixed sort buries directories among files and the structure stops being visible.
 */
export function buildTree(files, root) {
  const base = path.resolve(root);
  const rootNode = { name: path.basename(base) || base, rel: '', dir: true, children: [] };
  // One map per directory level, keyed by relative path, so a directory is created once
  // no matter how many files sit under it.
  const dirs = new Map([['', rootNode]]);

  function ensureDir(rel) {
    if (dirs.has(rel)) return dirs.get(rel);
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const parent = ensureDir(parentRel);
    const node = { name: rel.slice(rel.lastIndexOf('/') + 1), rel, dir: true, children: [] };
    parent.children.push(node);
    dirs.set(rel, node);
    return node;
  }

  for (const abs of files) {
    let rel = path.relative(base, abs);
    if (!rel || rel.startsWith('..')) continue;         // outside the root: not ours to show
    rel = rel.split(path.sep).join('/');
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const parent = ensureDir(parentRel);
    parent.children.push({
      name: rel.slice(rel.lastIndexOf('/') + 1), rel, dir: false, children: [],
    });
  }
  sortTree(rootNode);
  return rootNode;
}

function sortTree(node) {
  if (!node.children.length) return;
  node.children.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.dir) sortTree(c);
}

/**
 * Flatten the tree to the rows the panel draws, honouring which directories are open.
 *
 * `expanded` is a Set of relative directory paths. It is the caller's state, not this
 * module's: a browser that owned its own open/closed set could not be reopened where the
 * user left it, and could not be driven by a test.
 *
 * @returns {Array<{node:object, depth:number, last:boolean, prefix:string}>}
 *   `prefix` carries the box-drawing gutter (`│  ` / `   `) built from the ancestors.
 */
export function visibleRows(root, expanded, depth = 0, prefix = '', last = true, out = []) {
  for (let i = 0; i < root.children.length; i++) {
    const node = root.children[i];
    const isLast = i === root.children.length - 1;
    out.push({ node, depth, last: isLast, prefix });
    if (node.dir && expanded.has(node.rel)) {
      // The gutter for a child: a vertical bar while this node still has siblings below
      // it, spaces once it does not — that is what makes the lines reach the right parent.
      const next = prefix + (isLast ? '   ' : '\u2502  ');
      visibleRows(node, expanded, depth + 1, next, isLast, out);
    }
  }
  return out;
}

/** Every directory path in the tree, so the caller can "expand all" without a walk of its own. */
export function allDirs(root, out = []) {
  for (const c of root.children) {
    if (c.dir) { out.push(c.rel); allDirs(c, out); }
  }
  return out;
}

/** Count the files under a node, for the `(N)` after a directory name. */
export function countFiles(node) {
  if (!node.dir) return 1;
  let n = 0;
  for (const c of node.children) n += countFiles(c);
  return n;
}

/**
 * Render the browser.
 *
 * @param {object} input
 * @param {object} input.root       from buildTree
 * @param {Array}  input.rows       from visibleRows
 * @param {number} input.sel        selected index into `rows`
 * @param {number} input.scroll     first visible row
 * @param {number} input.width
 * @param {number} input.height     rows available to the panel
 * @param {string} [input.filter]   substring the file list was narrowed by
 * @param {string} [input.cwd]
 * @returns {{ lines: string[], sel: number, scroll: number, hitRows: Array }}
 */
export function renderTree(input) {
  const {
    root, rows, width, height, cwd = '',
  } = input;
  const filter = String(input.filter || '');
  // The caller's width is RESPECTED, not raised to a minimum: a row wider than the frame
  // wraps and corrupts every row under it, so a floor here would be a bug, not a courtesy.
  const w = Math.max(1, width | 0);
  // Header (2) + footer (1) come out of the budget; a body of at least one row.
  const bodyH = Math.max(1, (height | 0) - 3);

  let sel = Math.max(0, Math.min((input.sel | 0), Math.max(0, rows.length - 1)));
  let scroll = Math.max(0, input.scroll | 0);
  if (sel < scroll) scroll = sel;
  if (sel >= scroll + bodyH) scroll = sel - bodyH + 1;

  const total = root.children.length ? countFiles(root) : 0;
  const title = filter
    ? uiText(`Files matching "${filter}" — ${total} file(s)`)
    : uiText(`Files — ${total} file(s)`);
  // Deliberately terse: the full phrasing ("↑↓ move · →/← open/close · Enter insert path ·
  // Ctrl+O expand all · Esc close") is 71 columns and got clipped mid-word at 70.
  const hint = uiText('↑↓ move · →/← open · Enter insert · Ctrl+O all · Esc close');

  const lines = [];
  // The header and the hint are clamped to the panel like every other row. Unclamped, a
  // narrow terminal pushed them past the width and the whole frame wrapped.
  lines.push(col(truncate(' ' + title, w), C.white + C.bold));
  lines.push(col(truncate(' ' + hint, w), C.gray));

  const hitRows = [];
  const shown = rows.slice(scroll, scroll + bodyH);
  for (let i = 0; i < shown.length; i++) {
    const { node, prefix } = shown[i];
    const index = scroll + i;
    const selected = index === sel;
    const marker = node.dir ? (input.expandedSet && input.expandedSet.has(node.rel) ? '\u25be' : '\u25b8') : ' ';
    const label = node.dir ? `${node.name}/` : node.name;
    const lead = ` ${prefix}${marker} `;
    const leadW = visWidth(lead);
    // Budget for the name, AFTER the gutter and the marker. Measured in VISUAL columns,
    // not characters: `slice` counts code units, so a name with a wide character or an
    // escape in it would come out wider than asked and wrap the whole frame.
    const suffixText = node.dir ? `  (${countFiles(node)})` : '';
    const suffixW = visWidth(suffixText);
    let room = Math.max(1, w - leadW - 1);
    // The count is a NICER label than a longer name, so it is dropped only when keeping it
    // would truncate the name to nothing.
    const showSuffix = suffixW > 0 && room - suffixW >= 8;
    if (showSuffix) room -= suffixW;
    const cut = clipToWidth(label, room);
    const text = lead + col(cut, selected ? C.hover : (node.dir ? C.cyan : C.fg))
      + (showSuffix ? col(suffixText, C.gray) : '');
    // A selected row is painted full-width so the highlight is a band, not a word.
    lines.push(selected ? padRight(text, w) : text);
    if (selected) {
      // The caller needs the row index to map a click back to this node.
      hitRows.push(index);
    }
  }
  // Pad the body out so the panel is a solid block rather than a ragged one.
  // Pad the body out so the panel is a solid block rather than a ragged one.
  while (lines.length < bodyH + 2) lines.push(' '.repeat(w));

  const pos = rows.length ? `${sel + 1}/${rows.length}` : '0/0';
  // A row is `{ node, depth, prefix }`, NOT the node itself — reading `.rel` off the row
  // silently produced an empty path, so the footer showed only the position.
  const cur = rows[sel];
  const rel = cur && cur.node ? cur.node.rel : '';
  const footer = ` ${pos}  ${rel}`;
  lines.push(col(truncate(footer, w), C.gray));

  return { lines, sel, scroll, hitRows };
}

function truncate(s, w) {
  const str = String(s);
  if (visWidth(str) <= w) return str;
  return clipToWidth(str, w);
}

/**
 * Clip a string to at most `w` VISUAL columns, ending with an ellipsis when it was cut.
 *
 * `slice` cannot do this: it counts UTF-16 code units, so a name with a wide character in
 * it comes out wider than the budget and wraps the row it was supposed to fit.
 */
function clipToWidth(s, w) {
  const str = String(s);
  if (w <= 0) return '';
  if (visWidth(str) <= w) return str;
  let out = '';
  let n = 0;
  for (const ch of str) {
    const cw = visWidth(ch);
    if (n + cw > w - 1) break;
    n += cw;
    out += ch;
  }
  return out + ELLIPSIS;
}

function padRight(s, w) {
  const have = visWidth(s);
  return have >= w ? s : s + ' '.repeat(w - have);
}

/**
 * The next selection when moving by `delta`, skipping nothing.
 *
 * Kept as a function rather than inline arithmetic so the wrap-around rule is stated once:
 * the list WRAPS, because a browser that dead-ends at the bottom makes the arrow keys feel
 * broken on a short list.
 */
export function moveSel(sel, delta, count) {
  if (!count) return 0;
  return ((sel + delta) % count + count) % count;
}
