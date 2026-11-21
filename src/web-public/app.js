import { t, catalog, LANGUAGES, DEFAULT_LANG } from './i18n.js';
import { Completer } from './complete.js';
import { SettingsPanel, attachSettings } from './settings.js';


const $ = (id) => document.getElementById(id);
const stream = $('stream');
const input = $('input');

let LANG = DEFAULT_LANG;
try {
  const saved = localStorage.getItem('hncode.lang');
  if (saved && LANGUAGES.some((l) => l.id === saved)) LANG = saved;
} catch {}

let T = catalog(LANG);

const tr = (key, vars) => {
  let s = T[key] || key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
};

// Strip ANSI escape codes from a string. Rows the TUI sends for WIN-PLATFORM
// (role 'rich', some system lines) carry terminal styling (\x1b[97m etc.); the
// browser has no terminal, so those must become plain text or the literal
// "[97m" leak shows up in the transcript. Applied once at paintRow so every
// role — simple text, markdown, tool rows — is clean.
const ANSI_RE = /\u001b\[[0-9;:<=>?]*[ -/]*[@-~]/g;
function stripAnsi(s) { return String(s == null ? '' : s).replace(ANSI_RE, ''); }

let status = {};
let completer = null;
let settingsPanel = null;

function applyStatic() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = tr(node.getAttribute('data-i18n'));
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = tr(node.getAttribute('data-i18n-title'));
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = tr(node.getAttribute('data-i18n-placeholder'));
  }
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
    node.setAttribute('aria-label', tr(node.getAttribute('data-i18n-aria-label')));
  }
  rerenderRows();
  renderStatus();
  setPmode();
}

function buildLangSwitch() {
  const box = $('lang-switch');
  box.replaceChildren();
  box.title = tr('nav.language');
  for (const l of LANGUAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.label;
    b.className = l.id === LANG ? 'is-on' : '';
    b.addEventListener('click', () => {
      if (l.id === LANG) return;
      LANG = l.id;
      T = catalog(LANG);
      try { localStorage.setItem('hncode.lang', LANG); } catch {}
      buildLangSwitch();
      applyStatic();
    });
    box.appendChild(b);
  }
}

function rerenderRows() {
  for (const [i, node] of win.els) {
    const row = rowItems[i];
    if (row && node._rec) paintRow(node._rec);
  }
}

let es = null;
let retry = 0;
let retryTimer = null;
let readOnly = false;
let readOnlyChecked = false;

function setConn(kind, text) {
  $('conn').className = 'dot dot-' + kind;
  $('conn-text').textContent = text;
}

// Live updates arrive over WebSocket, not EventSource. The server (web.js) runs a
// zero-dependency RFC 6455 endpoint at /api/ws: on connect it sends a `snapshot`
// of the current view, then every hub event as a JSON text frame. A dropped
// connection is retried with backoff, like EventSource auto-reconnect did for
// SSE.
function connect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (es) { try { es.close(); } catch { /* already gone */ } }

  setConn('wait', tr('nav.connecting'));
  // Relative URL, exactly like the old `new EventSource('api/events')`: the
  // browser resolves it against the current document path, so behind the daemon
  // (page at /s/<id>/) the handshake reaches /s/<id>/api/ws, and a standalone
  // /web reaches /api/ws. Building `location.host + '/api/ws'` instead dropped
  // the /s/<id> prefix and made the daemon drop every handshake.
  const src = new WebSocket('api/ws');
  es = src;

  src.onopen = () => {
    if (src !== es) return;
    retry = 0;
    setConn('on', tr('nav.connected'));
  };

  src.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };

  src.onclose = (ev) => {
    // TEMP diag: record every close so a "reloads every few seconds" bug can be
    // tied to who dropped the socket. Remove after diagnosing.
    if (!window.__wsCloseLog) window.__wsCloseLog = [];
    window.__wsCloseLog.push({ t: Date.now(), code: ev && ev.code, wasClean: ev && ev.wasClean, reason: ev && ev.reason });
    console.log('WS-close', ev && ev.code, ev && ev.wasClean);
    if (src !== es) return;
    if (es === src) es = null;
    // A WebSocket that never opened usually means the session has EXITED: the
    // daemon destroys the handshake for read-only sessions (there is no live
    // server to proxy). Fall back to a one-shot `api/state` fetch so the
    // finished transcript still renders, instead of spinning on reconnect.
    if (!readOnly && !readOnlyChecked && retry === 0) {
      readOnlyChecked = true;
      loadReadOnlySnapshot();
      return;
    }
    setConn('off', tr('nav.disconnected'));
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 400 * retry);
  };

  src.onerror = () => { /* onclose follows and does the retry */ };
}

// The session has EXITED (read-only): load its snapshot over HTTP and freeze
// the UI. api/state on the daemon answer for a saved session; standalone web.js
// does too. Disable the composer so a read-only page cannot pretend it can act.
async function loadReadOnlySnapshot() {
  if (readOnly) return;
  let res;
  try { res = await fetch('api/state', { headers: { accept: 'application/json' } }); }
  catch { /* network error — fall through to normal retry */ }
  if (!res || !res.ok) {
    // Not a read-only case; resume normal reconnect.
    if (res) setConn('off', tr('nav.disconnected'));
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 400 * retry);
    return;
  }
  let data;
  try { data = await res.json(); } catch { /* ignore */ return; }
  readOnly = true;
  applySnapshot({ rows: (data && data.rows) || [], status: (data && data.status) || {} });
  setConn('off', tr('nav.disconnected'));
  // Freeze the composer: no WS to send on, and the session is read-only anyway.
  const inputEl = $('input');
  if (inputEl) inputEl.disabled = true;
  setPanelVisible('send', false);
  setPanelVisible('btn-interrupt', false);
  setPanelVisible('working', false);
  const readonlyBadge = $('readonly-badge');
  if (readonlyBadge) readonlyBadge.hidden = false;
}

async function act(name, args) {
  // The ONLY transport is the WebSocket. Sending is fire-and-forget (the UI
  // updates optimistically; the real result rides the status/row stream back),
  // and there is deliberately NO HTTP fallback: if the socket is down the server
  // is unreachable, so a POST would not reach it either — it would just hang the
  // caller. Tell the user the link is down and let the reconnect loop restore it.
  var ws = es;
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({ action: name, args: args || [] }));
      return { ok: true };
    } catch (e) { /* fall through to down-report */ }
  }
  // Connection lost. If the socket is simply reconnecting (readyState 0), wait
  // for it; if it is closed, tell the user and ensure connect() is running.
  if (ws && ws.readyState === 0) {
    return { ok: false, error: tr('err.unreachable') };
  }
  toast(tr('nav.disconnected'));
  connect();
  return { ok: false, error: tr('err.unreachable') };
}

async function actReturning(name, args) {
  const body = await act(name, args);
  if (!body || body.ok !== true) throw new Error((body && body.error) || tr('err.actionFailed'));
  return body;
}

let toastTimer = null;

function toast(text) {
  const node = $('notice');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

function handle(msg) {
  switch (msg.type) {
    case 'snapshot': applySnapshot(msg); break;
    case 'row': addRow(msg.row); break;
    case 'row_patch': patchRow(msg.id, msg.patch); break;
    case 'rows_reset': applySnapshot({ rows: msg.rows, status }); break;
    case 'status': applyStatus(msg.status); break;
    // Granular events (claude-code style): update just one panel, not the whole
    // status DOM. The server pushes these when a single field changes.
    case 'queued': {
      const q = Array.isArray(msg.queued) ? msg.queued : [];
      if (!status) status = {};
      status.queued = q;
      setPanelVisible('queue-panel', q.length > 0);
      renderQueuePanel(q, !!(status && status.busy));
      break;
    }
    case 'todos': {
      const t = Array.isArray(msg.todos) ? msg.todos : [];
      if (!status) status = {};
      status.todos = t;
      setPanelVisible('todo-panel', t.length > 0);
      renderTodoPanel(t);
      break;
    }
    case 'tasks': {
      const t = Array.isArray(msg.tasks) ? msg.tasks : [];
      if (status) status.tasks = t;
      if (!isViewHidden('tasks')) renderTasks(t);
      renderTabCounts(status || {});
      break;
    }
    default: break;
  }
}

/**
 * Animation-only fields, matching the server's exclusion list (session-hub.js).
 * They drive the Working pulse, which the browser draws for itself; a change in
 * just these must NOT trigger a full status re-render, or a long turn would
 * rebuild every card pane every frame — exactly the churn that froze the tab.
 */
const ANIMATION_FIELDS = new Set(['spin', 'workMsg', 'pulseStart']);

function samePlain(a, b) {
  if (a === b) return true;                       // identical ref or primitive
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;      // cheap length gate first
  }
  return JSON.stringify(a) === JSON.stringify(b); // deep: last resort only
}

function stableStatusChanged(next) {
  for (const k of Object.keys(next)) {
    if (ANIMATION_FIELDS.has(k)) continue;
    if (!samePlain(next[k], status[k])) return true;
  }
  for (const k of Object.keys(status)) {
    if (ANIMATION_FIELDS.has(k)) continue;
    if (!(k in next)) return true;
  }
  return false;
}

function applyStatus(s) {
  const next = s || {};
  // The WORKING row's word / pulse phase is drawn by drawPulse() off its own
  // clock, so a broadcast that only moved `spin` should not touch the panels.
  const stableChanged = !status || stableStatusChanged(next);
  const wasBusy = !!(status && status.busy);
  status = next;
  // Always animate the Working row off the latest state; only re-render the
  // whole status DOM when a stable field actually changed.
  if (status.busy) drawPulse(); else clearPulse();
  if (stableChanged) renderStatus();
  else if (status.busy !== wasBusy) renderBusyButton();
}

let rowItems = [];

const rowIndex = new Map();
let expandedRows = new Set();

/**
 * Set scrollTop as a PROGRAMMATIC move and remember the target, so the async
 * `scroll` event it fires is recognized as ours and not mistaken for a user
 * scroll. The old `pinning` flag alone was unreliable: the scroll event is
 * dispatched a frame later, by which time the microtask that cleared `pinning`
 * had already run — so a programmatic "snap to bottom" was read back as the user
 * scrolling to the bottom, which re-pinned the view and fought a user who had
 * just scrolled up.
 */
function setScrollTop(v) {
  stream.scrollTop = v;
  // Remember the CLAMPED position the browser actually landed on (scrollTop is
  // capped to the scrollable range), so the async scroll event compares equal and
  // is correctly ignored rather than misread as a user scroll.
  win._progTop = stream.scrollTop;
}

// Flow virtualisation: rows live in NORMAL document flow; the browser computes
// every real height, so two rows can never overlap. Only rows inside the
// window have DOM; the ranges above/below it are reserved by two padding divs,
// sized from measured heights (PLACEHOLDER_H until a row is first mounted).
//
// The overscan is measured in PIXELS, not rows. A row-count overscan is unusable
// here because row heights differ by an order of magnitude — a folded tool result is
// ~180px, a plain system line ~20px — so "8 rows" could be 160px of slack in one
// stretch of the transcript and 1400px in another. In the thin stretch a row was
// unmounted while it was still on screen (the reported "gone before it left the
// viewport"), because the padding divs then took its place and the content jumped.
// Keeping one extra viewport above and below makes the window independent of how
// tall the rows happen to be.
const WIN_OVERSCAN_PX = 800;
// The row-count floor that goes with it (see renderWindow): whichever reaches further
// wins. Estimates cannot be trusted, so this is what actually guarantees a row is not
// unmounted while it is still visible.
const WIN_OVERSCAN_ROWS = 12;
const NEAR_END_PX = 24;
// TanStack Virtual's rule for estimateSize: "estimate the LARGEST possible
// size (within comfort)". An underestimate makes the scroll range too short,
// so unmeasured history is skipped past and rows pop/jump as they mount. A
// generous overestimate only makes the scrollbar slightly long, which the
// measurement cache shrinks as rows mount. Tool rows dominate this transcript,
// and a folded result is ~8 lines + chrome, so ~180px is a safe floor.
const PLACEHOLDER_H = 180;

const win = {
  spacer: null,
  topPad: null,
  bottomPad: null,
  heights: [],       // REAL heights, measured per mounted row (0 = never seen)
  start: 0,
  end: 0,
  els: new Map(),
  raf: null,
  pinned: true,
  _lastStart: -1,
  _lastEnd: -1,
  _progTop: null,    // last programmatic scrollTop, to ignore our own scroll event
};

function knownHeight(i) {
  const h = win.heights[i];
  return h > 0 ? h : PLACEHOLDER_H;
}

function heightAbove(i) {
  let sum = 0;
  for (let k = 0; k < i && k < rowItems.length; k++) sum += knownHeight(k);
  return sum;
}

function heightBelow(i) {
  let sum = 0;
  for (let k = i; k < rowItems.length; k++) sum += knownHeight(k);
  return sum;
}

function scheduleWindow() {
  if (win.raf !== null) return;
  win.raf = requestAnimationFrame(renderWindow);
}

function ensureSpacer() {
  if (win.spacer && win.spacer.isConnected) return win.spacer;
  stream.replaceChildren();
  win.spacer = document.createElement("div");
  win.spacer.className = "win-spacer";
  win.topPad = document.createElement("div");
  win.bottomPad = document.createElement("div");
  win.topPad.className = "win-pad";
  win.bottomPad.className = "win-pad";
  win.spacer.append(win.topPad, win.bottomPad);
  stream.appendChild(win.spacer);
  win.els.clear();
  return win.spacer;
}

function mountRow(i, el) {
  // Insert at the row's DOCUMENT position, not blindly at the end. Scrolling
  // UP mounts top rows while later rows are already in the spacer; appending
  // them at the end put a row that belongs ABOVE below rows that belong BELOW
  // — document order broke and the transcript rendered scrambled/overlapping.
  let before = win.bottomPad;
  for (let k = i + 1; k < win.end; k++) {
    const next = win.els.get(k);
    if (next) { before = next; break; }
  }
  win.spacer.insertBefore(el, before);
  win.els.set(i, el);
  const rec = el._rec;
  if (rec) rec.index = i;
}

function unmountRow(i) {
  const el = win.els.get(i);
  if (!el) return;
  const rec = el._rec;
  if (rec) {
    const h = el.getBoundingClientRect().height;
    if (h > 0 && win.heights[rec.index] !== h) { win.heights[rec.index] = h; win._lastStart = -1; }
    if (rec.ro) rec.ro.unobserve(el);
  }
  el.remove();
  win.els.delete(i);
}

function clearAllRows() {
  for (const i of [...win.els.keys()]) unmountRow(i);
  win._lastStart = -1;
  win._lastEnd = -1;
}

function renderWindow() {
  win.raf = null;
  if (!win.spacer || !win.spacer.isConnected) return;
  if (!rowItems.length) {
    win.topPad.style.height = "0px";
    win.bottomPad.style.height = "0px";
    clearAllRows();
    win.start = win.end = 0;
    return;
  }
  const viewH = stream.clientHeight || 608;
  // Overscan is expressed in BOTH pixels and rows, and whichever reaches FURTHER
  // wins. Row heights differ by an order of magnitude (a folded tool result ~180px,
  // a plain line ~20px), so a row count alone left almost no margin in a thin
  // stretch and unmounted rows that were still on screen. A pixel budget alone is not
  // enough either: an UNMEASURED row is priced at PLACEHOLDER_H, so walking 800px of
  // estimates can cover far less than 800px of real content and the last rows fall
  // outside the window. The row floor is the guarantee; the pixel budget trims the
  // overshoot on tall rows.
  const over = Math.max(WIN_OVERSCAN_PX, viewH);
  const MIN_MARGIN_ROWS = WIN_OVERSCAN_ROWS;
  if (win.pinned) {
    // Pinned to the tail: grow upward until BOTH budgets are satisfied.
    win.end = rowItems.length;
    let used = 0;
    let start = win.end;
    while (start > 0 && (used < viewH + over || win.end - start < MIN_MARGIN_ROWS)) {
      start--;
      used += knownHeight(start);
    }
    win.start = start;
  } else {
    // Walk from the top accumulating heights until the scroll position is reached.
    let acc = 0;
    let first = rowItems.length - 1;
    for (let i = 0; i < rowItems.length; i++) {
      if (acc + knownHeight(i) > stream.scrollTop) { first = i; break; }
      acc += knownHeight(i);
    }
    // Above the viewport: the pixel budget OR the row floor, whichever is further.
    let start = first;
    let above = 0;
    while (start > 0 && (above < over || first - start < MIN_MARGIN_ROWS)) {
      start--;
      above += knownHeight(start);
    }
    // Below the viewport: same rule.
    let end = first + 1;
    let used = knownHeight(first);
    while (end < rowItems.length && (used < viewH + over || end - first < MIN_MARGIN_ROWS)) {
      used += knownHeight(end);
      end++;
    }
    win.start = start;
    win.end = Math.min(rowItems.length, end);
  }
  const sameRange = win.start === win._lastStart && win.end === win._lastEnd;
  win._lastStart = win.start;
  win._lastEnd = win.end;
  // A height change does NOT need a different window — only different paddings. The
  // pad sizes are recomputed below on every pass, so returning early here is safe.
  // It used to be gated on `same` (start+end), which is why `_lastStart = -1` on
  // every height change tore the whole window down and rebuilt it: each tool call
  // changes a row's height, so the unmount/remount cycle re-created every visible
  // row's DOM and the tool NAMES visibly flashed — not just the call that finished.
  if (sameRange) {
    win.topPad.style.height = heightAbove(win.start) + "px";
    win.bottomPad.style.height = heightBelow(win.end) + "px";
    if (win.pinned) setScrollTop(stream.scrollHeight);
    return;
  }
  for (const k of [...win.els.keys()]) {
    if (k < win.start || k >= win.end) unmountRow(k);
  }
  for (let k = win.start; k < win.end; k++) {
    if (!win.els.has(k)) mountRow(k, buildRow(rowItems[k]));
  }
  win.topPad.style.height = heightAbove(win.start) + "px";
  win.bottomPad.style.height = heightBelow(win.end) + "px";
  if (win.pinned) setScrollTop(stream.scrollHeight);
}

var sharedRO = typeof ResizeObserver === "function" ? new ResizeObserver(function (entries) {
  let delta = 0;
  for (const en of entries) {
    const rec = en.target._rec;
    if (!rec || rec.index < 0) continue;
    const h = en.target.getBoundingClientRect().height;
    const prev = win.heights[rec.index] > 0 ? win.heights[rec.index] : PLACEHOLDER_H;
    if (h <= 0 || prev === h) continue;
    win.heights[rec.index] = h;
    delta += h - prev;
  }
  if (delta !== 0) {
    win._lastStart = -1;   // heights changed: paddings must be recomputed
    scheduleWindow();
    // TanStack semantics (shouldAdjustScrollPositionOnItemSizeChange): correct
    // the scroll offset only when the change is ABOVE the viewport AND the user
    // is not scrolling backward — that combination is the classic "rows jump
    // while scrolling up" jank. End-pinned views still re-anchor to the bottom.
    if (win.pinned) {
      setScrollTop(stream.scrollHeight);
    } else if (delta > 0) {
      // A row above the viewport got TALLER: keep the text under the reader
      // stationary by shifting the offset by the same amount.
      setScrollTop(stream.scrollTop + delta);
    }
    // delta < 0 while unpinned: content above shrank; no correction needed,
    // the browser keeps the viewport anchored to the same content.
  }
}) : null;

function observeRow(el) {
  if (sharedRO) sharedRO.observe(el);
  return sharedRO;
}

function onScroll() {
  // Ignore the scroll event our OWN setScrollTop just fired (same position),
  // so a programmatic snap-to-bottom is never mistaken for a user scroll.
  if (win._progTop != null && Math.abs(stream.scrollTop - win._progTop) <= 1) {
    return;
  }
  win._progTop = null;
  const dist = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
  // Any scroll AWAY from the bottom is a deliberate move by the user, so the
  // tail-follow ends IMMEDIATELY — no matter how small. The old rule kept
  // `pinned` true until the user had scrolled more than a full viewport, so a
  // small upward scroll left the view pinned and the next render yanked it back
  // to the bottom: the "fighting the scroll" jank. Re-pin only when the user
  // returns to (or near) the bottom.
  win.pinned = dist <= NEAR_END_PX * 3;
  scheduleWindow();
}

// Patch any height-affecting repaint into the measurement cycle.
const patchQueue = new Set();
let patchFlushQueued = false;

/**
 * A streaming patch repaints the row's content, which almost always changes its
 * height — and a changed height invalidates every offset below it. So the reflow
 * is forced here instead of waiting for the row's resize observer: the observer
 * fires a frame LATER, and until it does the rows underneath sit at their old
 * positions with the new, taller row drawn over them. That gap is the overlap
 * that showed up while text streamed in.
 */
function queueRowPatch(rec, patch) {
  for (const k of Object.keys(patch)) rec.row[k] = patch[k];
  if (patch.append !== undefined) {
    const cut = typeof patch.textTo === 'number' ? patch.textTo : 0;
    rec.row.text = String(rec.row.text || '').slice(0, cut) + patch.append;
  }
  patchQueue.add(rec);
  if (patchFlushQueued) return;
  patchFlushQueued = true;
  requestAnimationFrame(() => {
    patchFlushQueued = false;
    let heightsChanged = false;
    for (const r of patchQueue) {
      paintRow(r);
      const h = r.el.getBoundingClientRect().height;
      if (h > 0 && r.index >= 0 && win.heights[r.index] !== h) { win.heights[r.index] = h; heightsChanged = true; }
    }
    if (heightsChanged) win._lastStart = -1;
    patchQueue.clear();
    scheduleWindow();
  });
}

function resetView(rows, nextStatus) {
  rowIndex.clear();
  rowItems = (rows || []).map((r) => ({ ...r }));
  for (let i = 0; i < rowItems.length; i++) {
    const r = rowItems[i];
    if (r && r.id != null) rowIndex.set(r.id, i);
  }
  status = nextStatus || {};
  renderStatus();

  expandedRows = new Set();
  win.heights = new Array(rowItems.length).fill(0);   // 0 = unmeasured placeholder
  win.start = win.end = 0;
  win.pinned = true;
  clearAllRows();
  win.spacer = null;
  ensureSpacer();
  renderWindow();
}

function applySnapshot(s) {
  resetView(s.rows, s.status);
}

/**
 * The browser's transcript is capped at the same number the server keeps
 * (`MAX_ROWS` in session-hub.js). Without a cap the two grow apart in the way
 * that only shows up on the long sessions this UI exists for: the server trims
 * its ring while the tab keeps every row it was ever sent, so the page holds a
 * transcript the server no longer has — and every structure derived from it
 * (the id index, the heights array, the expanded set) grows with it.
 */
const MAX_ROWS = 4000;

/** Drop the oldest rows until the list is back under the cap, moving every
    derived structure with them. */
function trimRows() {
  const over = rowItems.length - MAX_ROWS;
  if (over <= 0) return;

  rowItems.splice(0, over);
  win.heights.splice(0, over);

  // Every remaining row moved up by `over`, so the id index is rebuilt rather
  // than patched — an incremental fix-up here is exactly where an off-by-`over`
  // bug would hide.
  rowIndex.clear();
  for (let i = 0; i < rowItems.length; i++) {
    const r = rowItems[i];
    if (r && r.id != null) rowIndex.set(r.id, i);
  }

  // Mounted elements are keyed by index, so they are now wrong too; dropping
  // them costs one re-render and removes any chance of a stale element painting
  // a row that has moved.
  clearAllRows();
  win.start = win.end = 0;
}

function addRow(row) {
  if (!row) return;
  if (row.id != null && rowIndex.has(row.id)) { patchRow(row.id, row); return; }
  const item = { ...row };
  rowItems.push(item);
  // Pre-estimate the row's height so a long message is sized correctly even
  // before it scrolls into view; the resize observer replaces this once mounted.
  win.heights.push(0);   // unmeasured until first mount
  if (item.id != null) rowIndex.set(item.id, rowItems.length - 1);
  // Results start FOLDED — the "more" button adds the id to expandedRows.
  // (Every row used to start expanded, which defeated the fold caps entirely
  // and made a giant tool result overlap everything around it.)
  trimRows();
  scheduleWindow();
}

function patchRow(id, patch) {
  const i = rowIndex.get(id);
  if (i === undefined) return;
  const prev = rowItems[i];
  const next = { ...prev, ...patch };
  if (patch.append !== undefined) {
    const cut = typeof patch.textTo === 'number' ? patch.textTo : 0;
    next.text = String(prev.text || '').slice(0, cut) + patch.append;
    delete next.append;
    delete next.textTo;
  }
  rowItems[i] = next;
  const el = win.els.get(i);
  if (el && el._rec) {
    queueRowPatch(el._rec, patch);
  } else if (win.heights[i] !== undefined) {
    // Not on screen: keep the pre-estimate in step with the growing text, or the
    // scrollbar lags a long streaming message by a whole viewport.
    win.heights[i] = 0;   // re-measure on next mount
    scheduleWindow();
  }
}


function repaintRow(id) {
  const i = rowIndex.get(id);
  if (i === undefined) return;
  const el = win.els.get(i);
  if (!el || !el._rec) return;
  paintRow(el._rec);
  const h = el.getBoundingClientRect().height;
  if (h > 0) win.heights[i] = h;
  scheduleWindow();
}



/**
 * MARKERS — the `❯` / `●` / `↳` the terminal prints at the start of a line.
 *
 * The terminal has NO gutter column: `messageLines()` builds each row as a text
 * prefix (`'❯ '`, `'● '`, `'↳ '`, or a two-space continuation) concatenated to
 * the body, and `rowToLine()` emits `ind + body` verbatim. The marker's two
 * columns ARE the layout, so a wrapped paragraph hangs under the marker for
 * free. The browser reproduces that with a CSS `::before` on the body box — a
 * real grid column would have to centre the glyph and would not hang right.
 */
const MARK_KEY = {
  user: 'mark.user',
  queued: 'mark.queued',
  steer: 'mark.steer',
  bash: 'mark.bash',
  warn: 'mark.warn',
};

const BOX_ROLES = new Set(['user', 'queued', 'bash']);
const SIMPLE_ROLES = new Set(['user', 'queued', 'steer', 'bash', 'system', 'warn', 'error', 'aborted']);

function markFor(role, row) {
  if (role === 'tool') return tr(row.failed ? 'mark.toolFailed' : 'mark.tool');
  if (role === 'tool_result') return tr('mark.result');
  if (role === 'thinking') return tr('mark.thinking');
  if (role === 'compaction') return tr('mark.tool');
  if (role === 'bg_task') {
    return tr(row.card && row.card.phase === 'failed' ? 'mark.bgTaskFailed' : 'mark.bgTask');
  }
  const key = MARK_KEY[role];
  return key ? tr(key) : '';
}

function rowClassFor(role) {
  if (role === 'tool') return 'msg-tool';
  if (role === 'tool_result') return 'msg-result';
  if (role === 'bg_task') return 'msg-bgtask';
  return 'msg-' + role;
}

// A single assistant row past this many characters renders as PLAIN TEXT even
// if it contains markdown: block-parsing a 200KB reply into thousands of nodes
// in one row stalled the tab. Plain text is one node and reads fine; the row
// content itself is what the model sent.
const MD_CHAR_BUDGET = 60000;

function buildRow(row) {
  const el = document.createElement('div');
  el.className = 'win-row';
  const rec = { el, row: row || {}, role: '', body: null, ro: null, simple: false, index: -1, mark: null };
  el._rec = rec;
  rec.ro = observeRow(el);
  paintRow(rec);
  return el;
}

function paintRow(rec) {
  const r = rec.row || {};
  const role = String(r.role || 'system');
  const text = stripAnsi(String(r.text == null ? '' : r.text));

  // STREAMING: a pending assistant row ALWAYS renders as one text node. The
  // markdown parser is O(text) per repaint, so running it on every streamed
  // patch of a growing reply is quadratic and froze the tab. When the turn
  // finishes (pending -> false) the row is re-classified once and the full
  // markdown render happens exactly once, like the terminal finishing a block.
  const streamPending = role === 'assistant' && r.pending === true;
  const tooBigForMd = role === 'assistant' && text.length > MD_CHAR_BUDGET;
  const simple = SIMPLE_ROLES.has(role) || (role === 'assistant' && (streamPending || tooBigForMd || !hasMarkup(text)));
  if (rec.role !== role || rec.simple !== simple) {
    rec.el.className = 'win-row ' + rowClassFor(role);
    rec.body = document.createElement('div');
    rec.body.className = BOX_ROLES.has(role) ? 'msg-box' : 'msg-body';
    rec.el.replaceChildren(rec.body);
    rec.role = role;
    rec.simple = simple;
  }

  rec.el.classList.toggle('is-failed', r.failed === true);
  rec.el.classList.toggle('is-running', role === 'tool' && !!r.pending && !r.failed);
  rec.el.classList.toggle('is-done', role === 'tool' && !r.pending && !r.failed);
  if (role === 'compaction') {
    rec.el.classList.toggle('is-done', r.phase === 'done');
    rec.el.classList.toggle('is-cancelled', r.phase === 'cancelled');
    rec.el.classList.toggle('is-running', r.phase !== 'done' && r.phase !== 'cancelled');
  }
  if (role === 'bg_task' && r.card) {
    rec.el.classList.toggle('is-started', r.card.phase === 'started');
    rec.el.classList.toggle('is-completed', r.card.phase === 'completed');
    rec.el.classList.toggle('is-failed', r.card.phase === 'failed');
  }

  const mark = markFor(role, r);
  if (rec.mark !== mark) {
    rec.mark = mark;
    if (mark) rec.el.setAttribute('data-mark', mark);
    else rec.el.removeAttribute('data-mark');
  }

  if (rec.simple) {
    if (rec.body.textContent !== text) rec.body.textContent = text;
    return;
  }
  paintBody(rec, r, role, text);
}


/** True when the text needs block rendering. A plain reply keeps ONE text node
    for its whole life, so a streamed patch is a single assignment instead of a
    rebuilt subtree on every frame. */
function hasMarkup(text) {
  return text.indexOf('```') >= 0 || text.indexOf('#') >= 0
    || text.indexOf('`') >= 0 || text.indexOf('**') >= 0 || text.indexOf('](') >= 0;
}

const RESULT_MAX_LINES = 12;
const DIFF_MAX_ROWS = 16;
const THINK_PREVIEW = 1;   // collapsed thinking shows a single live/one-line preview

function paintBody(rec, r, role, text) {
  const body = rec.body;
  body.replaceChildren();

  if (role === 'tool') { paintToolRow(body, r, rec); return; }
  if (role === 'tool_result') { paintResultRow(body, r); return; }
  if (role === 'compaction') { paintCompactionRow(body, r); return; }
  if (role === 'bg_task') { paintBgTaskRow(body, r); return; }
  if (role === 'thinking') { paintThinkingRow(body, r, text); return; }
  appendMarkdown(body, text);
}

function el(cls, text) {
  const n = document.createElement('span');
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Which argument identifies a call, mirroring the terminal's `KEY_ARG`: a tool
 * line must read `Using Read (src/tui.js)`, so the field is chosen per tool
 * rather than being "the first string that happens to be non-empty".
 */
const KEY_ARG = {
  Bash: ['command'],
  Read: ['path', 'file_path'],
  Write: ['path', 'file_path'],
  Edit: ['path', 'file_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  FileLines: ['path', 'file_path'],
  FetchURL: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'prompt'],
  TaskOutput: ['task_id'],
  TaskStop: ['task_id'],
};

const MAX_ARG = 60;

/** Terminal `keyArgument`: first line only, workspace-relative for paths,
    truncated to MAX_ARG with the ellipsis on the side that keeps a path's
    basename readable. */
function keyArgument(name, args, workspace) {
  if (!args || typeof args !== 'object') return '';
  const keys = KEY_ARG[name] || Object.keys(args);
  for (const k of keys) {
    const v = args[k];
    if (typeof v !== 'string' || !v.length) continue;
    let text = v.split('\n')[0];
    const isPath = k === 'path' || k === 'file_path';
    if (isPath && workspace && text.startsWith(workspace)) {
      const rel = text.slice(workspace.length).replace(/^[/\\]+/, '');
      if (rel) text = rel;
    }
    if (text.length > MAX_ARG) {
      text = isPath ? '\u2026' + text.slice(text.length - (MAX_ARG - 1))
        : text.slice(0, MAX_ARG - 1) + '\u2026';
    }
    if (isPath) text = text.replace(/\\/g, '/');
    return text;
  }
  return '';
}

/**
 * The tool NAME's sweep while a call is running — the terminal's own animation,
 * ported rather than approximated.
 *
 * A 2s loop in two 1s colour pairs: base cyan → pale cyan, back, then base cyan
 * → cyan-blue, back. Each character fades across a band ~2-4 characters wide, so
 * the crest moves as a gradient instead of a hard edge. The phase is measured
 * from the tick the pulse STARTED (`pulseStart`), not the raw spinner tick: the
 * spinner has been running since the turn began, so using it directly drops the
 * pulse into a mid-cycle colour the instant the animation hands over.
 */
const SWEEP = 6;
const SWEEP_HALF = SWEEP + SWEEP;
const SWEEP_CYCLE = SWEEP_HALF * 2;
const CYAN_RGB = [0, 215, 255];
const PALE_CYAN_RGB = [150, 255, 255];
const CYAN_BLUE_RGB = [0, 150, 255];

function mixRgb(from, to, k) {
  const t = Math.max(0, Math.min(1, k));
  return 'rgb('
    + Math.round(from[0] + (to[0] - from[0]) * t) + ','
    + Math.round(from[1] + (to[1] - from[1]) * t) + ','
    + Math.round(from[2] + (to[2] - from[2]) * t) + ')';
}

function paintToolName(rec, name, pending, tick) {
  const box = rec.nameEl;
  if (!box || !box.isConnected) return;

  if (!pending) {
    unregisterSweep(rec);
    // Leave the DOM alone when it already shows the plain name. `paintBody` rebuilds
    // a row's children on every patch, so this node is normally FRESH (empty) and the
    // branch below is what fills it; but when the name is unchanged the existing
    // content is already correct, and rewriting it makes the name flicker on rows
    // that finished long ago — the flash reported for "every tool name", not just the
    // call that just ran.
    if (rec.namePending === false && box.textContent === name) return;
    box.replaceChildren(document.createTextNode(name));
    rec.namePending = false;
    rec.nameText = name;
    return;
  }

  // The tick comes from a LOCAL clock (see sweepFrame), not from `status.spin`.
  // The server stopped broadcasting every spin frame (ANIMATION_FIELDS in
  // session-hub.js), so a sweep driven by it only moved when some OTHER field
  // happened to change — it froze for long stretches and then jumped. Worse,
  // pushing per-character gradient values over the wire for every frame is exactly
  // the cost the browser should be paying instead.
  const start = rec.sweepStart == null ? (rec.sweepStart = tick) : rec.sweepStart;
  if (rec.namePending === true && rec.nameTick === tick && rec.nameText === name) return;
  rec.namePending = true;
  rec.nameTick = tick;
  rec.nameText = name;

  const inCycle = (((tick - start) % SWEEP_CYCLE) + SWEEP_CYCLE) % SWEEP_CYCLE;
  const inHalf = inCycle % SWEEP_HALF;
  const target = inCycle < SWEEP_HALF ? PALE_CYAN_RGB : CYAN_BLUE_RGB;
  const n = name.length || 1;
  const band = Math.max(2, Math.min(4, n / 3)) / n;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < name.length; i++) {
    const at = i / n;
    const t = inHalf < SWEEP
      ? ((inHalf + 1) / SWEEP - at) / band
      : 1 - ((inHalf - SWEEP + 1) / SWEEP - at) / band;
    const s = document.createElement('span');
    s.style.color = mixRgb(CYAN_RGB, target, t);
    s.textContent = name[i];
    frag.appendChild(s);
  }
  box.replaceChildren(frag);
}

/* ---- pending tool-name sweeps, on their own clock -------------------------
   Every pending tool row registers here; ONE rAF loop repaints them all at the
   terminal's 80ms tick (not 60fps: rebuilding per-character spans faster buys
   nothing visible and burns CPU). A row unregisters the moment it stops pending,
   so an idle page runs no loop at all. */
const sweeps = new Set();
let sweepRaf = null;
let sweepLastTick = -1;

function registerSweep(rec) {
  sweeps.add(rec);
  if (sweepRaf === null) sweepRaf = requestAnimationFrame(sweepFrame);
}

function unregisterSweep(rec) {
  rec.sweepStart = null;
  if (!sweeps.delete(rec)) return;
  if (!sweeps.size) stopSweeps();
}

function stopSweeps() {
  if (sweepRaf !== null) { cancelAnimationFrame(sweepRaf); sweepRaf = null; }
  sweepLastTick = -1;
  sweeps.clear();
}

const SWEEP_TICK_MS = 80;

function sweepFrame() {
  sweepRaf = null;
  // Drop anything detached (its row was removed or re-rendered).
  for (const rec of [...sweeps]) if (!rec.nameEl || !rec.nameEl.isConnected) sweeps.delete(rec);
  if (!sweeps.size) { sweepLastTick = -1; return; }
  const now = performance.now();
  const tick = Math.floor(now / SWEEP_TICK_MS);
  if (tick !== sweepLastTick) {
    sweepLastTick = tick;
    for (const rec of sweeps) paintToolName(rec, rec.nameText, true, tick);
  }
  sweepRaf = requestAnimationFrame(sweepFrame);
}

function paintToolRow(body, r, rec) {
  const name = r.toolName || r.name || 'tool';
  // The verb IS the state: `Using` while running, `Used` once finished. It is
  // the one thing that tells a reader at a glance whether a call is in flight.
  body.appendChild(el('tool-verb', tr(r.pending ? 'tool.using' : 'tool.used')));
  body.append(' ');

  // The name gets its own node so the sweep can repaint just its glyphs. The
  // record lives on the NODE, never on the row: the row object is serialized to
  // the server and copied on every patch, so putting DOM references on it would
  // keep the old tree alive after every repaint.
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  body.appendChild(nameEl);
  // The sweep record lives on the ROW record (`rec`), which survives a repaint; only
  // its `nameEl` is refreshed here. `paintBody` calls `replaceChildren()` before
  // rebuilding, so this node is a NEW element on every patch — keying the state on
  // the node reset the cycle on each frame and left detached records in the set.
  if (!rec._sweep) rec._sweep = { nameEl, namePending: null, nameTick: -1, nameText: '', sweepStart: null };
  rec._sweep.nameEl = nameEl;
  // A pending row joins the local sweep loop; a finished one paints once and leaves
  // it. `sweepStart` is stamped on the first frame, so the cycle begins when the
  // call started rather than at an arbitrary phase.
  if (r.pending) {
    registerSweep(rec._sweep);
    paintToolName(rec._sweep, name, true, Math.floor(performance.now() / SWEEP_TICK_MS));
  } else {
    paintToolName(rec._sweep, name, false, 0);
  }


  const arg = keyArgument(name, r.toolArgs, status.cwd);
  if (arg) body.appendChild(el('tool-arg', ' (' + arg + ')'));

  if (name === 'Write' && typeof r.streamContent === 'string' && r.streamContent.length) {
    const bytes = r.streamContent.length;
    const size = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB'
      : bytes >= 1024 ? (bytes / 1024).toFixed(1) + 'KB'
        : bytes + 'B';
    body.appendChild(el('tool-size', ' ' + size));
  }

  // The counts ride the tool line; the diff BODY belongs to the result row. The
  // terminal shows them in exactly that split, never the diff twice.
  if (name === 'Edit' && !r.pending) {
    const d = Array.isArray(r.diff) && r.diff.length ? r.diff : r._diffCounts;
    if (Array.isArray(d) && d.length) {
      const adds = d.filter((x) => x.type === 'add').length;
      const dels = d.filter((x) => x.type === 'del').length;
      if (adds) body.appendChild(el('tool-add', ' +' + adds));
      if (dels) body.appendChild(el('tool-del', ' \u2212' + dels));
    }
  }

  // Live output of a still-running command, where the terminal puts it: under the
  // `Using …` row, tail-capped, so a chatty command cannot flood the row.
  if (r.pending && typeof r.liveOutput === 'string' && r.liveOutput.length) {
    const raw = r.liveOutput.replace(/\r\n/g, '\n').split('\n');
    const cap = expandedRows.has(r.id) ? Infinity : 8;
    body.appendChild(el('tool-live', '\n' + raw.slice(-cap).map((l) => '  ' + l).join('\n')));
  }
}



/**
 * Tool output. The terminal's shape is the whole point of the row:
 *
 *   ● Used Edit (a.js) +1 -1                 <- tool line, counts only
 *   ↳  179 - old line                        <- ONE `↳` on the FIRST body row
 *      179 + new line
 *   Edited a.js: replaced 1 occurrence(s).   <- receipt LAST
 *
 * An Edit's DIFF is the body and carries the marker, with the receipt moved to
 * the bottom; every other tool's output IS the body and carries the marker on
 * its first line.
 */
function paintResultRow(body, r) {
  const failed = r.failed === true;
  const text = String(r.text == null ? '' : r.text);
  const diff = Array.isArray(r.diff) ? r.diff.filter((d) => d.type !== 'ctx') : [];

  if (diff.length) {
    // Same shape as the folded result below: show the first diff rows with the `↳`
    // on the first, and let the fold hint trail the block. The old form drew `↳` on
    // a line by itself with the hint on the NEXT line and no diff content at all.
    const rows = expandedRows.has(r.id) ? diff : diff.slice(0, DIFF_MAX_ROWS);
    const width = Math.max(1, ...rows.map((d) => String(d.no || 0).length));
    rows.forEach((d, i) => {
      const no = String(d.no || 0).padStart(width);
      const mark = d.type === 'add' ? '+' : '-';
      const prefix = i === 0 ? tr('mark.result') + ' ' : '  ';
      body.appendChild(el(d.type === 'add' ? 'diff-add' : 'diff-del',
        prefix + no + ' ' + mark + ' ' + String(d.text) + '\n'));
    });
    const hiddenDiff = diff.length - rows.length;
    if (hiddenDiff > 0) body.appendChild(moreButton(r.id, hiddenDiff));
    const receipt = text.trim()
      .split('\n').filter((ln) => !/^\[exit code:/.test(ln.trim())).join('\n')
      .trim();
    if (receipt) body.appendChild(el(failed ? 'diff-del' : 'res-more', receipt));
    if (expandedRows.has(r.id) && diff.length > DIFF_MAX_ROWS) body.appendChild(collapseButton(r.id));
    return;
  }
  // A finished result is FOLDED (like the terminal's ctrl+o): a whole-file Read is
  // thousands of DOM nodes in ONE row, which stutters scrolling. The preview keeps
  // the FIRST lines visible with the `↳` marker on the first one, and the fold hint
  // rides the END of the block — the terminal's shape:
  //     ↳  1 first line of the output
  //        2 second line
  //        … (N more lines, expand)
  // It used to render `↳` alone on one line and the hint on the NEXT, so a folded
  // row showed a dangling marker and no output at all, and the hint read as a
  // separate paragraph rather than as "there is more of THIS".
  // `[exit code: N]` is bookkeeping for the model, never shown to the user.
  const lines = text.replace(/\r\n/g, '\n').split('\n')
    .filter((ln) => !/^\[exit code:/.test(ln.trim()));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return;

  const folded = !expandedRows.has(r.id);
  const shown = folded ? lines.slice(0, RESULT_MAX_LINES) : lines;
  shown.forEach((ln, i) => {
    const isErr = /^\[error:/.test(ln.trim());
    const prefix = i === 0 ? tr('mark.result') + ' ' : '  ';
    body.appendChild(el(isErr || failed ? 'diff-del' : '', prefix + ln + '\n'));
  });
  const hidden = lines.length - shown.length;
  if (hidden > 0) body.appendChild(moreButton(r.id, hidden));
  if (expandedRows.has(r.id) && lines.length > RESULT_MAX_LINES) body.appendChild(collapseButton(r.id));
}


function moreButton(id, n) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-more';
  b.textContent = tr('tool.moreLines', { n });
  b.addEventListener('click', () => { expandedRows.add(id); repaintRow(id); });
  return b;
}

/** A "collapse" control shown once a foldable row is expanded, so a long
    thinking / result block can be folded back without a reload. */
function collapseButton(id) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-more';
  b.textContent = tr('tool.collapse');
  b.addEventListener('click', () => { expandedRows.delete(id); repaintRow(id); });
  return b;
}

/** Compaction, matching the terminal: `● Compacting context…` / `● Compaction
    complete (X → Y tokens)` / `● Compaction cancelled`. The marker carries the
    phase colour, so it is part of the line rather than a separate column. */
function paintCompactionRow(body, r) {
  const done = r.phase === 'done';
  const cancelled = r.phase === 'cancelled';
  const label = done ? tr('tool.compacted')
    : cancelled ? tr('tool.compactCancelled')
      : tr('tool.compacting');
  let line = tr('mark.tool') + ' ' + label;
  if (done && r.tokensBefore != null && r.tokensAfter != null) {
    line += ' (' + fmtNum(r.tokensBefore) + ' \u2192 ' + fmtNum(r.tokensAfter) + ' tokens)';
  }
  body.appendChild(document.createTextNode(line));
  if (r.instruction) body.appendChild(document.createTextNode('\n  ' + String(r.instruction)));
}

/** Background-task lifecycle card: `● agent task completed in background`, the
    conclusion indented underneath and capped like a tool result so one chatty
    subagent cannot flood the transcript. */
function paintBgTaskRow(body, r) {
  const card = r.card || { phase: 'completed', headline: '' };
  body.appendChild(document.createTextNode(
    tr(card.phase === 'failed' ? 'mark.bgTaskFailed' : 'mark.bgTask') + ' ' + (card.headline || '')));
  if (card.detail) body.appendChild(el('res-more', ' (' + card.detail + ')'));
  const t = String(r.text || '').trim();
  if (!t) return;
  const lines = t.split('\n');
  const cap = expandedRows.has(r.id) ? 200 : 6;
  body.appendChild(document.createTextNode('\n  ' + lines.slice(0, cap).join('\n  ')));
  if (lines.length > cap) body.appendChild(el('res-more', '\n  \u2026 ' + (lines.length - cap)));
}


/**
 * Reasoning block, matching the terminal:
 *   live      -> "<spinner> thinking…" then the LAST 2 content lines, indented
 *   finalized -> `●` inline on the first line, up to 2 preview lines, then a
 *                "… (N more lines)" hint
 * All of it dim, body italic. The marker is part of the text (prefix `● `,
 * continuations indented two), exactly as `messageLines` builds it.
 */
function paintThinkingRow(body, r, text) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  // An EMPTY reasoning block renders NOTHING, matching `messageLines` in the
  // terminal. A model may emit a `think` event with no text, and a block finalised by
  // a tool call can be left empty; drawing a bare `●` (or a lone spinner) for those
  // reads as a rendering bug. The row stays in the model, so a block that later
  // receives text appears in full — only the paint is skipped.
  if (!lines.some((l) => l.trim() !== '')) return;
  const cap = expandedRows.has(r.id) ? Infinity : THINK_PREVIEW;

  if (r.pending) {
    // The live form shows a spinner label instead of the `●`, and previews the
    // TAIL of the reasoning rather than its head.
    const label = document.createElement('div');
    label.className = 'think-live';
    label.textContent = tr('chat.thinking');
    body.appendChild(label);
    // Live: show the newest lines (up to THINK_PREVIEW), replaced in place as the
    // model's reasoning grows — matching the terminal's `contentLines.slice(-PREVIEW)`.
    const tail = lines.slice(-THINK_PREVIEW);
    for (const ln of tail) body.appendChild(document.createTextNode('  ' + ln + '\n'));
    return;
  }

  const shown = lines.slice(0, cap);
  shown.forEach((ln, i) => {
    body.appendChild(document.createTextNode(
      (i === 0 ? tr('mark.thinking') + ' ' : '  ') + ln + '\n'));
  });
  const hidden = lines.length - shown.length;
  if (hidden > 0) body.appendChild(moreButton(r.id, hidden));
  else if (expandedRows.has(r.id) && lines.length > 1) body.appendChild(collapseButton(r.id));
}



const FENCE_RE = /^[ \t]*```+\s*(\S*)/;
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*?\*|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\)|(^|\s)https?:\/\/[^\s]+)/g;

/** Markdown as the terminal renders it: a fenced block becomes its own box with
    the language on a rule, `#` lines are emphasised, and inline `code` / **bold**
    / [links](url) keep their form. Everything else stays verbatim — a tool
    result or a shell line must never be reinterpreted as prose. */
function appendMarkdown(wrap, text) {
  const lines = String(text == null ? '' : text).split('\n');
  let plain = [];
  let code = null;
  let lang = '';

  const flushPlain = () => {
    if (!plain.length) return;
    const chunk = plain;
    plain = [];
    // Split the buffered lines into block groups: lists, tables, quotes, hr,
    // headings, and paragraphs. Each is appended as its own container.
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}.*\|/.test(l) || /^\s*\|[-: ]+\|/.test(l);
    while (i < chunk.length) {
      const raw = chunk[i];
      const t = raw.replace(/\s+$/, '');
      // table: header line, then a separator line
      if (t.includes('|') && i + 1 < chunk.length && isTableSep(chunk[i + 1])) {
        const header = t.split('|').map((c) => c.trim()).filter((c, j, a) => !(c === '' && (j === 0 || j === a.length - 1)));
        const body = [];
        i += 2;
        while (i < chunk.length && chunk[i].trim().includes('|') && !isTableSep(chunk[i])) {
          const cells = chunk[i].split('|').map((c) => c.trim()).filter((c, j, a) => !(c === '' && (j === 0 || j === a.length - 1)));
          body.push(cells);
          i++;
        }
        wrap.appendChild(buildTable(header, body));
        continue;
      }
      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { wrap.appendChild(el('md-hr', '')); i++; continue; }
      // quote: one or more consecutive `>` lines
      if (/^\s*>\s?/.test(t)) {
        const q = [];
        while (i < chunk.length && /^\s*>\s?/.test(chunk[i])) {
          q.push(chunk[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const box = document.createElement('div');
        box.className = 'md-quote';
        q.forEach((ql, j) => { if (j) box.appendChild(document.createTextNode('\n')); box.appendChild(inlineParts(ql)); });
        wrap.appendChild(box);
        continue;
      }
      // task checkbox
      const task = /^(\s*)([-*+]\s+)?\[( |x|X)\]\s+(.*)$/.exec(t);
      if (task) {
        const row = document.createElement('div');
        row.className = 'md-task';
        const box = el('md-check', task[3] !== ' ' ? '\u2713' : '\u25cb');
        row.appendChild(box);
        row.appendChild(inlineParts(task[4]));
        wrap.appendChild(row);
        i++;
        continue;
      }
      // list item, ordered or unordered
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(t);
      if (li) {
        const list = document.createElement('div');
        list.className = /^\d/.test(li[2]) ? 'md-list-ol' : 'md-list-ul';
        while (i < chunk.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(chunk[i].replace(/\s+$/, ''));
          if (!m || (/^\d/.test(m[2]))) {
            if (!m) break;
          }
          const isO = /^\d/.test(m[2]);
          if (isO !== /^\d/.test(li[2])) break;
          const item = document.createElement('div');
          item.className = 'md-li';
          const bullet = isO ? m[2] : '\u2022';
          item.appendChild(el('md-bullet', bullet));
          item.appendChild(inlineParts(m[3]));
          list.appendChild(item);
          i++;
        }
        wrap.appendChild(list);
        continue;
      }
      // heading
      const head = /^\s*#{1,6}\s+(.*)$/.exec(t);
      if (head) { wrap.appendChild(el('md-h', head[1])); i++; continue; }
      // paragraph / plain
      const paraNode = document.createElement('div');
      paraNode.className = 'md-p';
      paraNode.appendChild(inlineParts(t));
      wrap.appendChild(paraNode);
      i++;
    }
  };

  const flushCode = () => {
    const box = document.createElement('div');
    box.className = 'code-block';
    if (lang) {
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      bar.textContent = lang;
      box.appendChild(bar);
    }
    const pre = document.createElement('pre');
    pre.className = 'code-body';
    pre.textContent = code.join('\n');
    box.appendChild(pre);
    wrap.appendChild(box);
    code = null;
    lang = '';
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (code === null) { flushPlain(); code = []; lang = fence[1] || ''; }
      else flushCode();
      continue;
    }
    if (code === null) plain.push(line);
    else code.push(line);
  }
  flushPlain();
  if (code !== null && code.length) flushCode();
}

/** Render a Markdown table as a grid. Header is the first row (bold). */
function buildTable(header, body) {
  const table = document.createElement('div');
  table.className = 'md-table';
  const h = document.createElement('div');
  h.className = 'md-tr';
  for (const c of header) { const cell = el('md-th', c); h.appendChild(cell); }
  table.appendChild(h);
  for (const row of body) {
    const r = document.createElement('div');
    r.className = 'md-tr';
    for (const c of row) r.appendChild(el('md-td', c));
    table.appendChild(r);
  }
  return table;
}

function inlineParts(line) {
  if (!line) return document.createTextNode('');
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    if (m.index > at) frag.appendChild(document.createTextNode(line.slice(at, m.index)));
    const tok = m[0];
    if (tok[0] === '`') frag.appendChild(el('md-code', tok.slice(1, -1)));
    else if (tok.startsWith('**')) frag.appendChild(el('md-b', tok.slice(2, -2)));
    else if (tok.startsWith('~~')) frag.appendChild(el('md-s', tok.slice(2, -2)));
    else if (tok.startsWith('*')) frag.appendChild(el('md-i', tok.slice(1, -1)));
    else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      const href = tok.slice(tok.indexOf('(') + 1, -1);
      const a = document.createElement('a');
      a.className = 'md-link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = label;
      frag.appendChild(a);
    } else {
      // Bare URL, possibly left-trimmed to the leading whitespace captured.
      const url = tok.trim();
      const a = document.createElement('a');
      a.className = 'md-link';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = url;
      if (tok[0].match(/\s/)) frag.appendChild(document.createTextNode(' '));
      frag.appendChild(a);
    }
    at = m.index + tok.length;
  }
  if (at < line.length) frag.appendChild(document.createTextNode(line.slice(at)));
  return frag;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'task_id'];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v) return v.split('\n')[0].slice(0, 160);
  }
  return '';
}

function fmtNum(n) {
  n = Number(n) || 0;
  const trim = (v) => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1048576) return trim(n / 1048576) + 'M';
  if (n >= 1024) return (n >= 102400 ? Math.round(n / 1024) : trim(n / 1024)) + 'k';
  return String(n);
}

// ------------------------------------------------------- status and panels

// A hidden tab pane is skipped by renderStatus; VIEW_IDS tracks which one is
// visible so switching a tab back on rebuilds it once from the latest status.
const dirtyViews = new Set();
function isViewHidden(name) {
  const sec = document.getElementById("view-" + name);
  if (!sec) return false;
  if (!sec.hidden) return false;
  dirtyViews.add(name);
  return true;
}

function renderStatus() {
  const s = status || {};

  $('sess-title').textContent = s.title || tr('chat.untitled');
  const sessId = String(s.session || '');
  const idEl = $('sess-id');
  idEl.textContent = sessId;
  const oldCopy = $('sess-id-copy');
  if (oldCopy) oldCopy.remove();
  if (sessId) {
    const cb = copyButton(sessId, tr('copy.copy'));
    cb.id = 'sess-id-copy';
    idEl.after(cb);
  }

  // Send and Interrupt share one edge of the composer: while a turn runs, the
  // only useful action there is to stop it, so Send yields to Stop instead of
  // sitting beside a button that would just queue another message.
  setPanelVisible('btn-interrupt', !!s.busy);
  setPanelVisible('send', !s.busy);


  setPanelVisible('todo-panel', (s.todos || []).length > 0);
  setPanelVisible('queue-panel', (s.queued || []).length > 0);
  setPanelVisible('working', !!s.busy);

  renderTodoPanel(s.todos || []);
  renderQueuePanel(s.queued || [], !!s.busy);
  // Hidden tabs keep stale DOM — their pane is display:none, nobody sees it,
  // and rebuilding hundreds of cards per status broadcast was pure waste.
  // setupViews() marks a pane "dirty" when its view becomes visible.
  if (!isViewHidden("tasks")) renderTasks(s.tasks || []);
  if (!isViewHidden("files")) renderFiles(s.files || []);
  if (!isViewHidden("tools")) renderTools(s.tools || []);
  if (!isViewHidden("commands")) renderCommands(s.commands || []);
  renderTabCounts(s);
  applyModal(s);
  renderStatusLine(s);
}

/** Flip only the composer's Send/Stop state when `busy` changed — called from
    applyStatus on an animation-only broadcast, so a run that never changes a
    stable field still swaps the button without touching the panes. */
function renderBusyButton() {
  const busy = !!(status && status.busy);
  setPanelVisible('btn-interrupt', busy);
  setPanelVisible('send', !busy);
  setPanelVisible('working', busy);
}

function setPanelVisible(id, on) {
  const node = $(id);
  if (node) node.hidden = !on;
}

/**
 * One row, grouped the way the terminal's footer groups it: which mode I am in,
 * which model, where I am, what git says, and the usage readout pinned right.
 * Every part is a fact about the running session — nothing here is decoration.
 */
function renderStatusLine(s) {
  const line = $('statusline');
  line.replaceChildren();
  const o = s.options || {};

  line.appendChild(popoverButton('sl-mode', modeLabel(s.mode), 'side.mode', () => modeItems(o)));
  // One badge, one accent — Plan/Focus/Swarm are mutually exclusive, so exactly one
  // of these is shown. The class carries the colour (see .sl-badge-* in app.css); the
  // three must NOT share it, or the statusline cannot say which mode is on.
  // PTC FIRST: it narrows the toolset harder than any of the others — only the sandbox tool is offered — so a
  // session in that mode must say so from the status line alone.
  const badge = s.ptcMode ? { text: 'PTC', cls: 'sl-badge-ptc' }
    : s.plan ? { text: 'Plan', cls: 'sl-badge-plan' }
      : s.focus ? { text: 'Focus', cls: 'sl-badge-focus' }
        : s.swarm ? { text: 'Swarm', cls: 'sl-badge-swarm' }
          : null;
  if (badge) line.appendChild(el('sl-badge ' + badge.cls, badge.text));

  if (s.model) {
    const label = s.model + (s.reasoning
      ? (s.effort && s.effort !== 'on' ? ' thinking: ' + s.effort : ' thinking')
      : '');
    line.appendChild(popoverButton('sl-model', label, 'side.model', () => modelItems(o)));
  }

  const running = (s.tasks || []).filter((t) => t.status === 'running');
  const bash = running.filter((t) => t.kind !== 'agent').length;
  const agents = running.filter((t) => t.kind === 'agent').length;
  if (bash) line.appendChild(el('sl-tasks-bash', tr('status.tasksBash', { n: bash })));
  if (agents) line.appendChild(el('sl-tasks-agent', tr('status.tasksAgent', { n: agents })));

  if (s.cwd) line.appendChild(el('sl-cwd', s.cwd));

  const gi = s.git;
  if (gi && gi.branch) {
    line.appendChild(el('sl-branch', gi.branch));
    if (gi.insertions) line.appendChild(el('sl-add', '+' + gi.insertions));
    if (gi.deletions) line.appendChild(el('sl-del', '\u2212' + gi.deletions));
  }

  line.appendChild(el('sl-spacer', ''));

  // The usage readout is the terminal's own string (`3 turns | 7 steps | 42
  // tok/s`), and the terminal does not translate it. Neither does this: one
  // person reading both screens must not see two different sentences.
  line.appendChild(el('sl-usage', tr('status.usage', {
    turns: Number(s.rounds || 0),
    steps: Number(s.steps || 0),
    rate: Math.round(Number(s.tokRate || 0)),
  })));
  line.appendChild(el('sl-ctx', tr('status.context', {
    pct: Number(s.ctxPercent || 0),
    used: fmtNum(s.ctxTokens || 0),
    max: fmtNum(s.ctxMax || 1),
  })));
}


function popoverButton(cls, label, titleKey, buildItems) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.title = tr('popover.click');
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    openPopover(b, tr(titleKey), buildItems(), cls);
  });
  return b;
}

function modelItems(o) {
  const items = [];
  for (const m of (o.model && o.model.items) || []) {
    items.push({
      label: m.label || m.value,
      sub: m.sub || '',
      on: m.value === (o.model && o.model.value),
      cmd: '/model',
      arg: m.value,
      // Each model's own thinking levels, sent by the server. Null when the
      // model has no Thinking control. The effort popover renders these on the
      // right of the "Thinking Effort" row when the pointer sits on it.
      efforts: (m.efforts && m.efforts.map((e) => ({
        label: e.label || e.value,
        on: e.value === (o.effort && o.effort.value),
        cmd: '/effort',
        arg: e.value,
      }))) || null,
    });
  }
  return items;
}

function modeItems(o) {
  return ((o.mode && o.mode.items) || []).map((m) => ({
    label: m.label || m.value,
    sub: m.sub || '',
    on: m.value === (o.mode && o.mode.value),
    cmd: '/permission',
    arg: m.value,
  }));
}

function modeLabel(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'auto') return 'Auto';
  if (m === 'yolo') return 'Yolo';
  if (m === 'ask') return 'Ask';
  return mode ? String(mode) : '\u2014';
}

let popoverOpen = null;

function openPopover(anchor, title, items, kind) {
  const box = $('popover');
  const list = $('popover-list');
  if (!box || !list) return;
  $('popover-title').textContent = title;
  list.replaceChildren();

  if (!items.length) {
    list.appendChild(el('popover-item', tr('side.none')));
    box.hidden = false; positionPopover(anchor, box);
    return;
  }

  // A model popover is two stacked sections, exactly as the user asked:
  //   Model A
  //   Model B          <- pick a model (its own levels follow)
  //   Model C
  //   ──────────────
  //   Thinking Effort > on     <- hover the row to reveal its level list
  const isModelPopover = kind === 'sl-model';
  box.dataset.modelPopover = isModelPopover ? 'yes' : 'no';
  if (isModelPopover) {
    renderModelPopover(list, items);
  } else {
    for (const it of items) list.appendChild(buildPopoverItem(it));
  }

  box.hidden = false;
  positionPopover(anchor, box);
  popoverOpen = kind;

  // The listener is registered on the NEXT frame's task, not in a microtask: the
  // click that opened the popover is still propagating up to `document`, so a
  // listener added synchronously here would receive that same click, see a target
  // outside the popover, and close it again — the menu appeared and vanished in
  // one gesture, which is why the buttons looked dead.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onDocKey);
  }, 0);
}

/**
 * Position the popover ABOVE the anchor — the status line sits at the bottom of
 * the screen, so a menu that appears below the button runs into the floor.
 * `gap` is kept small (a few px) so the menu reads as attached to what it opens.
 */
function positionPopover(anchor, box) {
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8)) + 'px';
  box.style.top = Math.max(8, r.top - box.offsetHeight - 8) + 'px';
}

/** Position the floating level list just to the RIGHT of the effort row, flush
    with its top. */
function positionFlyout(flyout, anchor) {
  const r = anchor.getBoundingClientRect();
  flyout.style.left = Math.max(4, r.right + 4) + 'px';
  flyout.style.top = Math.max(4, r.top - 2) + 'px';
}

function buildPopoverItem(it) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'popover-item' + (it.on ? ' is-on' : '');
  b.appendChild(el('', it.label));
  if (it.sub) b.appendChild(el('sub', it.sub));
  b.addEventListener('click', () => {
    closePopover();
    void act('dispatch', [it.cmd, it.arg]);
  });
  return b;
}

/** Model + effort popover, three stacked blocks:
    1. the model list (its own scroll)
    2. a hairline divider
    3. a "Thinking Effort" row showing the current level
   Hovering the effort row floats the level list out to its RIGHT, as a separate
   panel — it does not push the main layout. Hovering a model on top shows that
   model's levels instead. */
function renderModelPopover(list, items) {
  const currentEff = items.find((m) => m.on) || items[0];
  const currentEfforts = (currentEff && currentEff.efforts) || null;

  // 1) model list.
  const modelBox = document.createElement('div');
  modelBox.className = 'popover-section';
  for (const m of items) {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'popover-item' + (m.on ? ' is-on' : '');
    it.appendChild(el('', m.label));
    if (m.sub) it.appendChild(el('sub', m.sub));
    it.addEventListener('click', () => {
      closePopover();
      void act('dispatch', [m.cmd, m.arg]);
    });
    it._efforts = m.efforts;
    it._isCurrent = !!m.on;
    modelBox.appendChild(it);
  }
  list.appendChild(modelBox);

  // 2) divider.
  list.appendChild(el('popover-rule', ''));

// 3) effort row.
  const effRow = document.createElement('div');
  effRow.className = 'popover-effort';
  effRow.appendChild(el('', tr('popover.effortLabel')));
  const effValue = document.createElement('span');
  effValue.className = 'popover-effort-val' + (currentEfforts ? ' has-levels' : '');
  const curLevel = currentEfforts && currentEfforts.filter((e) => e.on).map((e) => e.label)[0];
  effValue.textContent = curLevel || (currentEfforts ? tr('popover.off') : tr('popover.unknown'));
  effRow.appendChild(effValue);
  list.appendChild(effRow);

  if (!currentEfforts) return;

  // The floating level list, positioned to the RIGHT of the effort row. It is a
  // sibling of the main popover so it can break out beside it rather than
  // reflowing the stack.
  const effHost = $('popover');
  const flyout = document.createElement('div');
  flyout.className = 'popover-flyout';
  flyout.hidden = true;
  document.body.appendChild(flyout);

  const setLevels = (efforts, isCurrent) => {
    flyout.replaceChildren();
    if (!efforts || !efforts.length) {
      flyout.appendChild(el('popover-item', tr('popover.unknown')));
      return;
    }
    for (const e of efforts) flyout.appendChild(buildPopoverItem({ ...e, on: e.on && isCurrent }));
    positionFlyout(flyout, effRow);
    flyout.hidden = false;
  };

  const hideFlyout = () => { flyout.hidden = true; };

  const clearHover = () => {
    for (const o of list.querySelectorAll('.popover-item.is-hover')) o.classList.remove('is-hover');
  };

// hovering a model row hides any open effort flyout — the flyout belongs to the
  // Thinking Effort row, so moving to the model list dismisses it.
  for (const it of modelBox.children) {
    it.addEventListener('mouseenter', () => {
      clearHover();
      it.classList.add('is-hover');
      hideFlyout();
    });
    it.addEventListener('mouseleave', () => { it.classList.remove('is-hover'); });
  }

  // hovering the effort row floats the CURRENT model's levels.
  effRow.addEventListener('mouseenter', () => {
    clearHover();
    setLevels(currentEfforts, true);
  });
  effRow.addEventListener('mouseleave', () => { /* keep flyout until mouse leaves it */ });

  // Keep the flyout visible only while the pointer is over it or the popover.
  // (flyoutWatcher, registered once below, does that.)
}

/** Last pointer position, used by flyoutWatcher. */
let flyoutX = -1, flyoutY = -1;

/** Hide the effort flyout whenever the pointer leaves both the popover and the
    flyout itself. Runs for every mousemove; the check is cheap. */
function flyoutWatcher(ev) {
  flyoutX = ev.clientX;
  flyoutY = ev.clientY;
  const f = document.querySelector('.popover-flyout');
  if (!f || f.hidden) return;
  const box = document.getElementById('popover');
  const inBox = box && !box.hidden && insideRect(box, flyoutX, flyoutY);
  const inFly = insideRect(f, flyoutX, flyoutY);
  if (!inBox && !inFly) f.hidden = true;
}

/** True when (x, y) lies within the element's box. */
function insideRect(el, x, y) {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Registered ONCE (module scope), not per popover open — the flyout is looked up
// each move, so one listener serves every open/close cycle.
if (typeof document !== 'undefined') document.addEventListener('mousemove', flyoutWatcher);

function onDocDown(ev) {
  const box = $('popover');
  if (box && box.contains(ev.target)) return;
  closePopover();
}

function onDocKey(ev) {
  if (ev.key === 'Escape') closePopover();
}

function closePopover() {
  const box = $('popover');
  if (box) box.hidden = true;
  popoverOpen = null;
  // The floating level list is appended to <body>, so it must be removed here or
  // it would linger after the popover closes.
  for (const f of document.querySelectorAll('.popover-flyout')) f.remove();
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onDocKey);
}

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const ORANGE_RGB = [255, 140, 0];
const WORK_YELLOW_RGB = [255, 240, 120];
const WORK_RED_RGB = [255, 0, 0];
/** Animation clock and phrase for the Working pulse. Kept at module scope so the
    rAF loop can stop itself and so `applyStatus` can restart it without a fresh
    capture each time. */
let pulseRaf = null;
let pulseMsg = '';

/**
 * The Working row's pulse, driven by its OWN rAF loop, not by the server's `spin`
 * counter. The server no longer broadcasts every spin frame (see
 * ANIMATION_FIELDS in session-hub.js); even when it does, redrawing the row from
 * a remote tick lets the two drift. The sweep keeps the terminal's orange→yellow→
 * red cycle, advanced by elapsed TIME so it stays smooth.
 */
function drawPulse() {
  pulseMsg = String((status && status.workMsg) || '');
  if (pulseRaf === null) pulseRaf = requestAnimationFrame(pulseFrame);
}

/* The pulse advances at the TERMINAL's tick — 80ms per spinner frame — not at
   display refresh rate: rebuilding the row's per-character spans at 60fps buys
   nothing the eye can see and burns real CPU. */
const PULSE_TICK_MS = 80;
let pulseLastTick = -1;

function pulseFrame() {
  pulseRaf = null;
  if (!status || !status.busy) { stopPulse(); return; }
  const box = $('working-text');
  const now = performance.now();
  if (box && box.isConnected) {
    const tick = Math.floor(now / PULSE_TICK_MS);
    if (tick !== pulseLastTick) { paintPulseFrame(box, now); pulseLastTick = tick; }
  }
  pulseRaf = requestAnimationFrame(pulseFrame);
}

function clearPulse() {
  stopPulse();
  const box = $('working-text');
  if (box) box.replaceChildren();
}

function stopPulse() {
  if (pulseRaf !== null) { cancelAnimationFrame(pulseRaf); pulseRaf = null; }
  pulseMsg = '';
  pulseLastTick = -1;
}

function paintPulseFrame(box, now) {
  const msg = pulseMsg;
  if (!msg) { box.replaceChildren(); return; }
  // The sweep advances on time: 6 ticks ≈ 0.5s, so a 24-tick cycle is ~2s.
  const tick = Math.floor(now / 80);
  const inCycle = tick % SWEEP_CYCLE;
  const inHalf = inCycle % SWEEP_HALF;
  const target = inCycle < SWEEP_HALF ? WORK_YELLOW_RGB : WORK_RED_RGB;
  const n = msg.length;
  const band = Math.max(2, Math.min(4, n / 3)) / n;

  const frag = document.createDocumentFragment();
  const spin = document.createElement('span');
  spin.className = 'spin';
  spin.textContent = SPINNER[tick % SPINNER.length];
  frag.appendChild(spin);

  for (let i = 0; i < n; i++) {
    const at = i / n;
    const t = inHalf < SWEEP
      ? ((inHalf + 1) / SWEEP - at) / band
      : 1 - ((inHalf - SWEEP + 1) / SWEEP - at) / band;
    const s = document.createElement('span');
    s.style.color = mixRgb(ORANGE_RGB, target, t);
    s.textContent = msg[i];
    frag.appendChild(s);
  }
  box.replaceChildren(frag);
}


/**
 * Drag-to-resize for the todo and queue panels, ported from the terminal.
 *
 * The terminal marks each panel's top rule as a resize hitbox, and dragging
 * works in ROWS with `up = more rows`: the delta is taken against the row the
 * drag started on, so the panel grows as the pointer rises and shrinks as it
 * falls. The result is clamped to `[1, total]` — at least one row, never more
 * than exist. `null` means "no manual size", i.e. the automatic heuristic.
 */
const QUEUE_MAX_VISIBLE = 5;
const panelRows = { todo: null, queue: null };
const resizeDrag = { kind: null, startY: 0, startRows: 0 };


/** Row count a panel shows: the manual drag value when set, else the automatic
    one. Always clamped to [1, total], and 0 when there is nothing to show. */
function panelRowCount(kind, total) {
  if (!total) return 0;
  const rows = panelRows[kind];
  if (typeof rows === 'number' && Number.isFinite(rows)) {
    return Math.max(1, Math.min(total, Math.round(rows)));
  }
  return kind === 'todo'
    ? (todosExpanded ? total : selectVisibleTodos(status.todos || []).rows.length)
    : Math.min(total, QUEUE_MAX_VISIBLE);
}

function setResizeHover(el, on) {
  el.classList.toggle('is-hover', on);
}

function setupPanelResize() {
  for (const rule of document.querySelectorAll('.stack-rule')) {
    const kind = rule.getAttribute('data-resize');

    rule.addEventListener('mouseenter', () => setResizeHover(rule, true));
    rule.addEventListener('mouseleave', () => {
      if (resizeDrag.kind !== kind) setResizeHover(rule, false);
    });

    rule.addEventListener('pointerdown', (ev) => {
      // Capturing keeps the drag alive once the pointer leaves the 6px rule,
      // which it immediately does — a resize handle you have to stay on top of
      // is unusable.
      ev.preventDefault();
      rule.setPointerCapture(ev.pointerId);
      rule.classList.add('is-dragging');
      const total = kind === 'todo'
        ? (status.todos || []).length
        : (status.queued || []).length;
      resizeDrag.kind = kind;
      resizeDrag.startY = ev.clientY;
      resizeDrag.startRows = panelRowCount(kind, total);
      setResizeHover(rule, true);
    });

    rule.addEventListener('pointermove', (ev) => {
      if (resizeDrag.kind !== kind) return;
      const total = kind === 'todo'
        ? (status.todos || []).length
        : (status.queued || []).length;
      if (!total) return;
      // Rows are a line-height tall; converting the pixel delta into rows is what
      // makes the drag track the pointer instead of jumping a row per pixel.
      const rowPx = kind === 'todo' ? TODO_ROW_PX : QUEUE_ROW_PX;
      const delta = Math.round((resizeDrag.startY - ev.clientY) / rowPx);
      const want = Math.max(1, Math.min(total, resizeDrag.startRows + delta));
      if (panelRows[kind] === want) return;
      panelRows[kind] = want;
      if (kind === 'todo') renderTodoPanel(status.todos || []);
      else renderQueuePanel(status.queued || [], !!status.busy);
    });

    const end = (ev) => {
      if (resizeDrag.kind !== kind) return;
      rule.classList.remove('is-dragging');
      try { rule.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
      resizeDrag.kind = null;
      setResizeHover(rule, false);
    };
    rule.addEventListener('pointerup', end);
    rule.addEventListener('pointercancel', end);
  }
}

// -------------------------------------------------------------- todo panel

const TODO_MAX_VISIBLE = 5;
const TODO_MARK = { in_progress: '\u25cf', done: '\u2713', pending: '\u25cb' };
/** One rendered todo row, in CSS pixels — the pointer-delta to row conversion. */
const TODO_ROW_PX = 21;
const QUEUE_ROW_PX = 21;

let todosExpanded = false;


function selectVisibleTodos(todos) {
  if (todos.length <= TODO_MAX_VISIBLE) return { rows: todos, hidden: 0, counts: null };
  const inProgress = [], pending = [], done = [];
  todos.forEach((t, i) => {
    if (t.status === 'in_progress') inProgress.push(i);
    else if (t.status === 'pending') pending.push(i);
    else done.push(i);
  });
  const picked = new Set(inProgress.slice(0, TODO_MAX_VISIBLE));
  if (picked.size < TODO_MAX_VISIBLE) {
    const doneC = done.slice().reverse();
    const remaining = TODO_MAX_VISIBLE - picked.size;
    let doneCount, pendCount;
    if (!doneC.length) { doneCount = 0; pendCount = Math.min(remaining, pending.length); }
    else if (!pending.length) { pendCount = 0; doneCount = Math.min(remaining, doneC.length); }
    else {
      doneCount = 1;
      pendCount = Math.min(remaining - 1, pending.length);
      if (pendCount < remaining - 1) doneCount = Math.min(doneC.length, remaining - pendCount);
    }
    for (let i = 0; i < doneCount; i++) picked.add(doneC[i]);
    for (let i = 0; i < pendCount; i++) picked.add(pending[i]);
  }
  const idx = [...picked].sort((a, b) => a - b);
  const counts = { done: 0, in_progress: 0, pending: 0 };
  todos.forEach((t, i) => { if (!picked.has(i)) counts[t.status] = (counts[t.status] || 0) + 1; });
  return { rows: idx.map((i) => todos[i]), hidden: todos.length - idx.length, counts };
}

function todoMoreButton(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-more';
  b.style.margin = '0';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderTodoPanel(todos) {
  const ul = $('st-todos');
  if (!ul) return;
  ul.replaceChildren();
  if (!todos.length) return;

  // The visible set is the automatic pick topped up to the panel's row count, so
  // dragging the rule taller ADDS rows rather than reordering them — the
  // in-progress item keeps its priority while more of the list appears under it.
  const want = panelRowCount('todo', todos.length);
  const auto = selectVisibleTodos(todos);
  const rows = auto.rows.slice();
  if (rows.length < want) {
    const seen = new Set(rows);
    for (const t of todos) {
      if (rows.length >= want) break;
      if (!seen.has(t)) { rows.push(t); seen.add(t); }
    }
  }
  const shown = rows.slice(0, want);

  for (const t of shown) {
    const li = document.createElement('li');
    li.className = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'now' : '';
    li.appendChild(el('mark', TODO_MARK[t.status] || TODO_MARK.pending));
    li.appendChild(el('t', String(t.title == null ? '' : t.title)));
    ul.appendChild(li);
  }

  const hidden = todos.length - shown.length;
  if (hidden > 0) {
    const counts = { done: 0, in_progress: 0, pending: 0 };
    for (const t of todos) if (!shown.includes(t)) counts[t.status] = (counts[t.status] || 0) + 1;
    const dist = [['done', 'done'], ['in_progress', 'in progress'], ['pending', 'pending']]
      .filter(([k]) => counts[k] > 0)
      .map(([k, label]) => counts[k] + ' ' + label)
      .join(', ');
    const li = document.createElement('li');
    li.className = 'more';
    li.appendChild(todoMoreButton(
      '\u2026 +' + hidden + (dist ? ' (' + dist + ')' : ''),
      tr('status.expandTodos'),
      () => { todosExpanded = true; panelRows.todo = todos.length; renderTodoPanel(todos); },
    ));
    ul.appendChild(li);
  } else if (todosExpanded && todos.length > TODO_MAX_VISIBLE) {
    const li = document.createElement('li');
    li.className = 'more';
    li.appendChild(todoMoreButton(tr('tool.collapse'), '', () => {

      todosExpanded = false;
      panelRows.todo = null;
      renderTodoPanel(todos);
    }));
    ul.appendChild(li);
  }
}


// ------------------------------------------------------------- queue panel

function renderQueuePanel(queued, busy) {
  const ul = $('st-queue');
  if (!ul) return;
  ul.replaceChildren();
  if (!queued.length) return;

  // Same rule as the todo panel: the drag count wins, clamped to what exists.
  const rows = queued.slice(0, panelRowCount('queue', queued.length));

  rows.forEach((raw) => {
    const text = String(raw == null ? '' : raw);
    const single = text.replace(/\s+/g, ' ').trim();
    const li = document.createElement('li');
    li.appendChild(el('mark', tr('mark.queued')));
    const tx = el('t', single);
    tx.title = single;
    li.appendChild(tx);

    if (busy) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'steer-btn';
      b.textContent = tr('queue.steer');
      b.title = tr('queue.steerHint');
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        // The payload is the item's OWN text, captured here. Indexing into the
        // `queued` array read a list that status rebuilds from scratch on every
        // frame, so a click after any change steered the wrong message — or
        // nothing. A successful steer removes the item, so the row disappears on
        // the next status frame.
        void steerQueued(b, text);
      });
      li.appendChild(b);
    }

    // Edit: pull the message back out of the queue and load it into the composer,
    // mirroring the terminal's ↑-to-recall. Available whether or not a turn is
    // running — a queued message is editable at any time.
    const eb = document.createElement('button');
    eb.type = 'button';
    eb.className = 'steer-btn edit-btn';
    eb.textContent = tr('queue.edit');
    eb.title = tr('queue.editHint');
    eb.addEventListener('click', (ev) => {
      ev.preventDefault();
      void editQueued(eb, text);
    });
    li.appendChild(eb);

    // Drop: remove it from the queue without editing.
    const db = document.createElement('button');
    db.type = 'button';
    db.className = 'steer-btn drop-btn';
    db.textContent = tr('queue.drop');
    db.title = tr('queue.dropHint');
    db.addEventListener('click', (ev) => {
      ev.preventDefault();
      void dropQueued(db, text);
    });
    li.appendChild(db);
    ul.appendChild(li);
  });

  const li = document.createElement('li');
  li.className = 'more';
  const hidden = queued.length - rows.length;
  li.textContent = hidden > 0
    ? tr('queue.moreHint', { n: hidden })
    : tr(busy ? 'queue.hintRunning' : 'queue.hintIdle');
  ul.appendChild(li);
}

/** Steer one queued message into the running turn. The button reports its own
    progress, because a send that silently does nothing is indistinguishable
    from a broken button. */
async function steerQueued(btn, text) {
  btn.disabled = true;
  btn.textContent = tr('queue.steering');
  const body = await act('steer', [text]);
  if (!body || body.ok !== true) {
    btn.disabled = false;
    btn.textContent = tr('queue.steer');
  }
}

/** Recall a queued message into the composer for editing, like the terminal's ↑.
    The server removes it from the queue and returns its text; we put that text in
    the input so the user can change and re-send it. */
async function editQueued(btn, text) {
  btn.disabled = true;
  const body = await act('editQueued', [text]);
  btn.disabled = false;
  if (!body || body.ok !== true) return;
  input.value = String(body.text == null ? text : body.text);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoGrow();
  setPmode();
}

/** Remove a queued message without editing it. */
async function dropQueued(btn, text) {
  btn.disabled = true;
  const body = await act('dropQueued', [text]);
  btn.disabled = false;
  if (!body || body.ok !== true) btn.disabled = false;
}


// ------------------------------------------------------------- side tabs

function card() {
  const n = document.createElement('div');
  n.className = 'card';
  return n;
}

function cardHead(...nodes) {
  const h = document.createElement('div');
  h.className = 'card-head';
  h.append(...nodes);
  return h;
}

function cardFields() {
  const g = document.createElement('div');
  g.className = 'card-fields';
  return g;
}

function rightMeta(text) {
  const s = document.createElement('span');
  s.className = 'right';
  s.textContent = text;
  return s;
}

function field(label, value) {
  const row = document.createElement('div');
  row.className = 'field';
  row.appendChild(el('field-label', label));
  const v = el('field-value', '');
  if (value == null || value === '') {
    v.className = 'field-value dim';
    v.textContent = tr('unit.none');
  } else if (value instanceof Node) {
    v.appendChild(value);
  } else {
    v.textContent = String(value);
  }
  row.appendChild(v);
  return row;
}

function pill(text, tone) {
  return el('pill' + (tone ? ' pill-' + tone : ''), text);
}

function emptyNote(text) {
  return el('cards-empty', text);
}

function renderTasks(list) {
  const wrap = $('tasks');
  wrap.replaceChildren();
  if (!list.length) { wrap.appendChild(emptyNote(tr('tasks.empty'))); return; }
  for (const task of list) {
    const c = card();
    const tone = task.status === 'running' ? 'info'
      : task.status === 'failed' ? 'danger'
        : task.status === 'done' || task.status === 'completed' ? 'ok'
          : 'soft';
    const head = cardHead(
      pill(task.kind || 'bash', 'soft'),
      pill(task.status || '', tone),
      pill(task.id || '', 'sub'),
    );
    if (task.status === 'running') {
      const b = document.createElement('button');
      b.className = 'steer-btn';
      b.textContent = tr('tasks.stop');
      b.addEventListener('click', () => act('stopTask', [task.id]));
      head.appendChild(b);
    }
    c.appendChild(head);
    c.appendChild(rightMeta(task.startedAt ? ago(task.startedAt) : ''));

    const fields = cardFields();
    fields.appendChild(field(tr('tasks.colSummary'), String(task.summary || task.prompt || '')));
    if (task.agentId) fields.appendChild(field('agent', task.agentId));
    c.appendChild(fields);
    wrap.appendChild(c);
  }
}

function renderFiles(files) {
  const wrap = $('files');
  wrap.replaceChildren();
  if (!files.length) { wrap.appendChild(emptyNote(tr('files.empty'))); return; }
  for (const f of files) {
    const c = card();
    c.appendChild(cardHead(pill(f.ops || '', 'soft')));
    c.appendChild(rightMeta(String(f.count || 0)));
    const fields = cardFields();
    fields.appendChild(field(tr('files.colPath'), f.path));
    c.appendChild(fields);
    wrap.appendChild(c);
  }
}

function renderTools(list) {
  const wrap = $('tools');
  wrap.replaceChildren();
  if (!list.length) { wrap.appendChild(emptyNote(tr('side.none'))); return; }
  for (const x of list) {
    const c = card();
    c.appendChild(cardHead(pill(x.name || '', 'soft')));
    const fields = cardFields();
    fields.appendChild(field('description', String(x.description || '').split('\n')[0]));
    c.appendChild(fields);
    wrap.appendChild(c);
  }
}

function renderCommands(list) {
  const wrap = $('commands');
  wrap.replaceChildren();
if (!list.length) { wrap.appendChild(emptyNote(tr('side.none'))); return; }
  for (const cmd of list) {
    const c = card();
    c.classList.add('cmd-card');                       // enables the hover affordance
    c.appendChild(cardHead(pill('/' + (cmd.name || ''), 'solid'), pill(cmd.argumentHint || '', 'soft')));
    const fields = cardFields();
    fields.appendChild(field('description', cmd.desc || ''));
    c.appendChild(fields);
    // Clicking a command card acts on it, the way accepting a completion does in
    // the terminal:
    //   * a command that takes NO argument runs immediately,
    //   * a command that needs one (its argumentHint is shown on the card head) is
    //     PREPARED in the composer, with the leading slash and trailing space in
    //     place, so the user fills in the value and presses Enter — sending it
    //     empty would just bounce the usage/error back.
    const nm = String(cmd.name || '');
    const needsArg = !!(cmd && cmd.argumentHint);
    c.addEventListener('click', () => {
      if (needsArg) {
        const box = $('composer');
        if (box) box.focus();
        input.value = '/' + nm + ' ';
        input.setSelectionRange(input.value.length, input.value.length);
        if (typeof autoGrow === 'function') autoGrow();
        if (typeof setPmode === 'function') setPmode();
      } else {
        void send('/' + nm);
      }
    });
    wrap.appendChild(c);
  }
}


function renderTabCounts(s) {
  const counts = {
    tasks: (s.tasks || []).length,
    files: (s.files || []).length,
    logs: ($('logs') || { childElementCount: 0 }).childElementCount,
    tools: (s.tools || []).length,
    commands: (s.commands || []).length,
  };
  for (const b of document.querySelectorAll('.tab')) {
    const n = counts[b.getAttribute('data-view')];
    const old = b.querySelector('.tab-count');
    if (!n) { if (old) old.remove(); continue; }
    if (old) { old.textContent = String(n); continue; }
    b.appendChild(el('tab-count', String(n)));
  }
}

const MAX_LOG = 600;

function addLog(e) {
  const box = $('logs');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.append(
    el('log-t', new Date(e.at || Date.now()).toTimeString().slice(0, 8)),
    el('log-k', String(e.kind || e.type || '')),
    el('log-d', String(e.text || '')),
  );
  box.appendChild(line);
  while (box.children.length > MAX_LOG) box.removeChild(box.firstChild);
  if (!$('view-logs').hidden) box.scrollTop = box.scrollHeight;
}

// ----------------------------------------------------------------- modal

let modalKey = '';

function applyModal(s) {
  const box = $('modal');
  const pending = s.pending;
  if (!pending) { box.hidden = true; modalKey = ''; return; }
  const key = JSON.stringify(pending);
  if (key === modalKey && !box.hidden) return;
  modalKey = key;

  $('modal-box').className = 'modal-box '
    + (pending.kind === 'approval' ? 'is-approval' : 'is-question');
  $('modal-title').textContent = pending.kind === 'approval' ? tr('modal.approve') : tr('modal.question');
  $('modal-body').textContent = pending.detail || pending.question || '';
  const actions = $('modal-actions');
  actions.replaceChildren();

  const mkBtn = (label, fn, primary) => {
    const b = document.createElement('button');
    b.className = primary ? 'btn' : 'btn-quiet';
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };

  if (pending.kind === 'approval') {
    mkBtn(tr('modal.allow'), () => act('approve', [pending.id, true]), true);
    mkBtn(tr('modal.deny'), () => act('approve', [pending.id, false]), false);
  } else {
    const body = $('modal-body');
    const multi = !!pending.multiSelect;
    const picked = new Set();
    // Declared before the option handlers below reference it (single-select
    // submits immediately and must be able to read the note if it is present).
    let noteEl = null;
    // Progress line: "Question n/total" + optional header.
    const total = Number(pending.total || 1);
    const idx = Number(pending.index || 0);
    if (total > 1) {
      const prog = document.createElement('div');
      prog.className = 'modal-progress';
      prog.textContent = tr('modal.progress', { n: idx + 1, total })
        + (pending.header ? '  ' + pending.header : '');
      body.appendChild(prog);
    }
    // Option rows (the model's real options).
    const list = document.createElement('div');
    list.className = 'modal-options';
    for (const o of pending.options || []) {
      const label = (o && typeof o === 'object') ? o.label : String(o);
      const desc = (o && typeof o === 'object') ? (o.description || '') : '';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'modal-opt';
      b.dataset.label = label;
      const t = document.createElement('span');
      t.className = 'modal-opt-label';
      t.textContent = label;
      b.appendChild(t);
      if (desc) {
        const d = document.createElement('span');
        d.className = 'modal-opt-desc';
        d.textContent = desc;
        b.appendChild(d);
      }
      if (multi) {
        const box = document.createElement('span');
        box.className = 'modal-check';
        box.textContent = '\u25cb';
        b.prepend(box);
        b.addEventListener('click', () => {
          if (picked.has(label)) picked.delete(label); else picked.add(label);
          b.classList.toggle('is-on', picked.has(label));
          box.textContent = picked.has(label) ? '\u2713' : '\u25cb';
        });
      } else {
        // Single-select: choosing an option answers immediately, like the terminal.
        b.addEventListener('click', () => {
          void act('answerQuestion', [pending.id, [label], '', noteEl ? noteEl.value : '', true]);
        });
      }
      list.appendChild(b);
    }
    body.appendChild(list);
    // Per-question "Other": a free-text answer of the user's own.
    const otherWrap = document.createElement('div');
    otherWrap.className = 'modal-other';
    const otherBtn = document.createElement('button');
    otherBtn.type = 'button';
    otherBtn.className = 'modal-opt modal-other-toggle';
    otherBtn.textContent = tr('modal.other');
    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.className = 'modal-input inline';
    otherInput.placeholder = tr('modal.otherHint');
    let otherOpen = false;
    otherBtn.addEventListener('click', () => {
      otherOpen = !otherOpen;
      otherInput.hidden = !otherOpen;
      otherBtn.classList.toggle('is-on', otherOpen);
      if (otherOpen) otherInput.focus();
    });
    otherInput.hidden = true;
    otherWrap.append(otherBtn, otherInput);
    body.appendChild(otherWrap);
    // Whole-request note, only after the last question (may be left blank).
    if (pending.hasSupplement) {
      const noteWrap = document.createElement('div');
      noteWrap.className = 'modal-note';
      const nl = document.createElement('div');
      nl.className = 'modal-note-label';
      nl.textContent = tr('modal.note');
      noteEl = document.createElement('textarea');
      noteEl.rows = 2;
      noteEl.className = 'modal-input';
      noteEl.placeholder = tr('modal.noteHint');
      noteWrap.append(nl, noteEl);
      body.appendChild(noteWrap);
    }
    // Actions: submit the current answers. In single-select the option click
    // already submitted, but Submit also works (honours the Other text box).
    const submitCurrent = () => {
      const other = otherOpen ? otherInput.value.trim() : '';
      const list0 = [...picked];
      void act('answerQuestion', [pending.id, other ? [] : list0, other, noteEl ? noteEl.value : '', true]);
    };
    mkBtn(total > 1 && idx < total - 1 ? tr('modal.next') : tr('modal.submit'), submitCurrent, true);
  }
  box.hidden = false;
}

function copyButton(value, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-btn';
  b.textContent = label || tr('copy.copy');
  b.title = tr('copy.copyTitle');
  let timer = null;
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const done = (okState) => {
      b.textContent = okState ? tr('copy.done') : tr('copy.failed');
      b.classList.toggle('is-ok', okState);
      b.classList.toggle('is-err', !okState);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        b.textContent = label || tr('copy.copy');
        b.classList.remove('is-ok', 'is-err');
      }, 1200);
    };
    const text = String(value == null ? '' : value);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
    } else {
      done(false);
    }
  });
  return b;
}

// ------------------------------------------------------------------ rail

function ago(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleDateString();
  const min = Math.floor(diff / 60000);
  if (min < 1) return tr('home.justNow');
  if (min < 60) return tr('home.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('home.hoursAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return tr('home.daysAgo', { n: day });
  return new Date(ms).toLocaleDateString();
}

function workspaceLabel(p) {
  const parts = String(p || '').split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return tr('rail.noWorkspace');
  return parts.slice(-2).join('/');
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? '\u2026' + s.slice(-10) : s;
}

let railShape = '';
let railFilter = '';
let railData = { sessions: [], current: '' };

function renderRail(data) {
  const list = $('rail-list');
  if (!list) return;
  railData = data || railData;
  const all = railData.sessions || [];
  const current = String(railData.current || '');

  const q = railFilter.trim().toLowerCase();
  const sessions = q
    ? all.filter((s) => (s.id + ' ' + (s.title || '') + ' ' + (s.workspace || '')).toLowerCase().includes(q))
    : all;

  const shape = current + '\u0000' + q + '\u0000'
    + sessions.map((s) => s.id + ':' + s.title + ':' + s.updatedAt).join('\u0000');
  if (shape === railShape) return;
  railShape = shape;

  $('rail-count').textContent = !all.length ? ''
    : q ? sessions.length + ' / ' + all.length
      : String(all.length);

  list.replaceChildren();
  if (!sessions.length) {
    list.appendChild(el('rail-empty', all.length ? tr('rail.noMatch') : tr('rail.empty')));
    return;
  }

  const byWs = new Map();
  for (const s of sessions) {
    const key = workspaceLabel(s.workspace);
    if (!byWs.has(key)) byWs.set(key, []);
    byWs.get(key).push(s);
  }
  const groups = [...byWs.entries()].sort((a, b) => {
    const na = Math.max(0, ...a[1].map((s) => s.updatedAt || 0));
    const nb = Math.max(0, ...b[1].map((s) => s.updatedAt || 0));
    return nb - na;
  });

  for (const [ws, items] of groups) {
    const head = document.createElement('div');
    head.className = 'rail-group';
    const name = document.createElement('span');
    name.className = 'ws';
    name.textContent = ws;
    name.title = items[0].workspace || '';
    head.append(name, el('mono', String(items.length)));
    list.appendChild(head);
    for (const s of items) list.appendChild(railRow(s, s.id === current));
  }
}

function railRow(s, isCurrent) {
  const a = document.createElement('a');
  a.className = 'rail-row' + (isCurrent ? ' is-current' : '');
  a.href = '/s/' + encodeURIComponent(s.id) + '/';
  a.title = (s.title || tr('home.untitled')) + '\n' + (s.id || '') + '\n' + (s.workspace || '');

  const top = document.createElement('span');
  top.className = 'rail-row-top';
  top.append(
    el('rail-dot' + (isCurrent ? ' is-current' : ''), ''),
    el('rail-id', shortId(s.id)),
    el('rail-when', ago(s.updatedAt)),
  );
  a.appendChild(top);
  a.appendChild(el('rail-title', s.title || tr('home.untitled')));
  return a;
}

async function loadRail() {
  try {
    const res = await fetch('api/sessions', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    renderRail(await res.json());
  } catch { /* the rail is an accessory; a failed poll must not spam errors */ }
}

function startRail() {
  void loadRail();
  setInterval(() => { void loadRail(); }, 10000);
  const box = $('rail-filter');
  if (box) {
    box.addEventListener('input', () => {
      railFilter = box.value;
      railShape = '';
      renderRail(railData);
    });
  }
}

// ------------------------------------------------------------------ input

let inputHistory = [];
let historyIdx = -1;

function rememberInput(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (inputHistory[inputHistory.length - 1] !== t) inputHistory.push(t);
  if (inputHistory.length > 200) inputHistory.shift();
}

function historyNavigate(dir) {
  if (!inputHistory.length) return false;
  const caret = input.selectionStart == null ? 0 : input.selectionStart;
  const end = input.selectionEnd == null ? caret : input.selectionEnd;
  if (caret !== end) return false;
  if (dir < 0 && input.value.slice(0, caret).includes('\n')) return false;
  if (dir > 0 && input.value.slice(end).includes('\n')) return false;

  if (historyIdx === -1) historyIdx = inputHistory.length;
  historyIdx = dir < 0
    ? Math.max(0, historyIdx - 1)
    : Math.min(inputHistory.length, historyIdx + 1);
  input.value = historyIdx >= inputHistory.length ? '' : (inputHistory[historyIdx] || '');
  const at = input.value.length;
  input.setSelectionRange(at, at);
  autoGrow();
  setPmode();
  return true;
}

function resetHistoryCursor() {
  historyIdx = -1;
}

let growTimer = null;
let growRows = 0;

function autoGrow() {
  const est = 1 + (input.value.match(/\n/g) || []).length
    + Math.floor(input.value.length / 90);
  if (est === growRows) return;
  if (growTimer !== null) return;
  growTimer = requestAnimationFrame(() => {
    growTimer = null;
    growRows = 1 + (input.value.match(/\n/g) || []).length
      + Math.floor(input.value.length / 90);
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  });
}

function setPmode() {
  const shell = input.value.startsWith('!');
  const node = $('pmode');
  node.textContent = shell ? '!' : '\u203a';
  node.title = tr(shell ? 'chat.shellMode' : 'chat.shellHint');
  $('composer').classList.toggle('is-shell', shell);
}

async function send(forced) {
  const text = forced === undefined ? input.value : String(forced);
  if (!text.trim()) return;
  if (forced === undefined) {
    input.value = '';
    autoGrow();
    setPmode();
  }
  rememberInput(text);
  resetHistoryCursor();

  if (text.startsWith('!')) await act('shell', [text.replace(/^!+/, '').trim()]);
  else if (text.startsWith('/')) {
    // Slash commands (including /skill:<name>) go through the dispatcher, not
    // the plain submit path — otherwise a command line was sent as a literal
    // user message and the skill body / action never ran.
    const sp = text.indexOf(' ');
    const cmd = sp === -1 ? text : text.slice(0, sp);
    const arg = sp === -1 ? '' : text.slice(sp + 1).trim();
    await act('dispatch', [cmd, arg]);
  }
  else await act('submit', [text]);
}

// ------------------------------------------------------------------ views

const VIEW_IDS = ['chat', 'tasks', 'files', 'tools', 'commands', 'logs'];

const VIEW_SUB = {
  chat: '',
  tasks: 'tasks.sub',
  files: 'files.sub',
  tools: 'tools.sub',
  commands: 'commands.sub',
  logs: 'logs.sub',
};

function setupViews() {
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('.tab')) o.classList.toggle('is-on', o === b);
      const v = b.getAttribute('data-view');
      for (const id of VIEW_IDS) $('view-' + id).hidden = id !== v;
      $('view-sub').textContent = VIEW_SUB[v] ? tr(VIEW_SUB[v]) : '';
      // A pane rebuilt-while-hidden never rendered: paint it once now from the
      // latest status, then clear its dirty flag.
      if (dirtyViews.has(v)) {
        dirtyViews.delete(v);
        if (v === 'tasks') renderTasks(status.tasks || []);
        else if (v === 'files') renderFiles(status.files || []);
        else if (v === 'tools') renderTools(status.tools || []);
        else if (v === 'commands') renderCommands(status.commands || []);
      }
      if (v === 'chat') { win.pinned = true; scheduleWindow(); }
    });
  }
  $('btn-interrupt').addEventListener('click', () => act('interrupt'));
  $('logs-clear').addEventListener('click', () => {
    $('logs').replaceChildren();
    renderTabCounts(status);
  });
}

/**
 * The rail on a narrow screen.
 *
 * Below the breakpoint the rail is no longer a column, so the ONLY way to reach
 * sessions, settings or the language switch is through the header button.
 * Drawing it as an overlay (rather than hiding it outright) is what keeps those
 * reachable on a phone at all — `display: none` left them permanently
 * inaccessible, which is a missing feature rather than a layout choice.
 */
const railDrawerOpen = { on: false };

function setRailDrawer(open) {
  railDrawerOpen.on = open;
  document.body.classList.toggle('rail-open', open);
  const btn = $('btn-rail');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setupRailDrawer() {
  const btn = $('btn-rail');
  if (!btn) return;
  btn.addEventListener('click', () => setRailDrawer(!railDrawerOpen.on));

  // A scrim click and Escape both close it, matching the settings overlay.
  const scrim = $('rail-scrim');
  if (scrim) scrim.addEventListener('click', () => setRailDrawer(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && railDrawerOpen.on) setRailDrawer(false);
  });

  // Choosing a session is the reason the drawer was opened; leaving it up would
  // cover the page that was just loaded.
  $('rail-list').addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('a.rail-row')) setRailDrawer(false);
  });

  // Growing past the breakpoint turns the rail back into a column, where the
  // drawer state means nothing.
  const mq = window.matchMedia('(max-width: 720px)');
  const sync = () => { if (!mq.matches) setRailDrawer(false); };
  if (mq.addEventListener) mq.addEventListener('change', sync);
  else if (mq.addListener) mq.addListener(sync);
}

// ------------------------------------------------------------------- boot


function main() {
  applyStatic();
  buildLangSwitch();
  setupViews();
  setupRailDrawer();
  setupPanelResize();
  setPmode();
  startRail();

  stream.addEventListener('scroll', onScroll, { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleWindow()).observe(stream);
  } else {
    window.addEventListener('resize', () => scheduleWindow());
  }

  completer = new Completer(input, $('complete'), {
    getCommands: () => (status && status.commands) || [],
    getFiles: () => (status && status.workspaceFiles) || [],
    onAccept: (text, caret) => {
      input.value = text;
      input.setSelectionRange(caret, caret);
      autoGrow();
      setPmode();
    },
    onSubmit: (cmd) => {
      input.value = '';
      autoGrow();
      setPmode();
      void send(cmd);
    },
  });

  input.addEventListener('input', () => {
    if (historyIdx !== -1 && input.value !== inputHistory[historyIdx]) resetHistoryCursor();
    autoGrow();
    setPmode();
    completer.refresh();
  });
  input.addEventListener('click', () => { completer.refresh(); });
  input.addEventListener('blur', () => { completer.close(); });
  input.addEventListener('keydown', (ev) => {
    if (completer.open) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); completer.move(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); completer.move(-1); return; }
      if (ev.key === 'Tab') { ev.preventDefault(); completer.accept(); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); completer.close(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        if (completer.run()) return;
        void send();
        return;
      }
    }

    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      if (!historyNavigate(ev.key === 'ArrowUp' ? -1 : 1)) return;
      ev.preventDefault();
      return;
    }

    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); }
  });
  $('composer').addEventListener('submit', (ev) => { ev.preventDefault(); void send(); });

  settingsPanel = new SettingsPanel({
    act: actReturning,
    getStatus: () => status,
    tr,
    toast: (m) => toast(m),
  });
  attachSettings(settingsPanel);

  connect();
}

main();

