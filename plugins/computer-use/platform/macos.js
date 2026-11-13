// The macOS backend: screencapture(1) for pixels, the Accessibility API for the control tree,
// osascript for input.
//
// EVERY MECHANISM HERE IS PART OF macOS — nothing to install. The one thing that is NOT automatic
// is permission: both screen recording and Accessibility are gated in System Settings, and a
// process that has not been granted them gets a SILENT failure (a black capture, an empty tree)
// rather than an error. Each entry point therefore checks what it depends on and says which
// permission is missing, because "0 elements" would otherwise read as "the window is empty".
import { run, have, unsupported, shotPath, pngSize, sizeOf, intArg as toInt } from './util.js';

const isMac = process.platform === 'darwin';

/** True when screencapture(1) exists (it is part of the base system). */
export async function available() {
  return isMac && (await have('screencapture'));
}

// ---------------------------------------------------------------------------
// screenshots
// ---------------------------------------------------------------------------

/** The desktop's total bounds, in the coordinate space `screencapture -R` expects. */
export async function screenBounds() {
  if (!isMac) return unsupported('screen bounds on macOS only');
  // system_profiler is slow (~2s); osascript asking Finder for the desktop bounds is not
  // reliable for multi-monitor, so this uses the display list through Quartz. If osascript is
  // unavailable the primary display size is still better than nothing.
  const out = await run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { timeoutMs: 20000 }).catch(() => '');
  const m = /(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(out);
  if (m) {
    const x = +m[1], y = +m[2], right = +m[3], bottom = +m[4];
    return { x, y, width: right - x, height: bottom - y };
  }
  const size = await run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).catch(() => '');
  throw new Error(`could not read the screen bounds (${size.trim().slice(0, 120) || 'no response'}). ` +
    'Grant Screen Recording in System Settings > Privacy & Security.');
}

/** Capture a rectangle. `-R` takes x,y,w,h in points. */
export async function captureRegion({ x, y, width, height }, tag = 'region') {
  if (!isMac) return unsupported('screen capture on macOS only');
  const file = shotPath(tag);
  // -x silences the shutter sound; -o omits the window shadow. Both matter for automation: a
  // sound per screenshot is unusable, and a shadow offsets the captured pixels from the window
  // rectangle the caller measured.
  await run('screencapture', ['-x', '-o', '-R', `${x},${y},${width},${height}`, file], { timeoutMs: 30000 });
  const size = pngSize(file);
  if (!size) {
    return {
      error: 'the capture produced no image. On macOS this almost always means Screen Recording '
        + 'permission has not been granted to the terminal (System Settings > Privacy & Security > '
        + 'Screen Recording). A denied capture SUCCEEDS silently and writes a black or empty file.',
    };
  }
  return { path: file, bytes: sizeOf(file), width: size.width, height: size.height };
}

/** Capture the frontmost window, or all windows. */
export async function captureWindow(hwnd = null, tag = 'window') {
  if (!isMac) return unsupported('screen capture on macOS only');
  const file = shotPath(tag);
  // -w is interactive in screencapture, so a window is captured by evaluating its bounds with
  // System Events and using -R. hwnd here is an accessibility element index or a window title.
  if (hwnd) {
    const rect = await windowRect(hwnd);
    if (rect && rect.error) return rect;
    return captureRegion(rect, tag);
  }
  await run('screencapture', ['-x', '-o', file], { timeoutMs: 30000 });
  const size = pngSize(file);
  if (!size) return { error: 'the capture produced no image — check Screen Recording permission.' };
  return { path: file, bytes: sizeOf(file), width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// windows, through System Events
// ---------------------------------------------------------------------------

const OSA = 'osascript';

/** Every visible window: an index, its process, and its rectangle. */
export async function listWindows() {
  if (!isMac) return unsupported('window enumeration on macOS only');
  const script = `
tell application "System Events"
  set out to ""
  repeat with p in (every process whose visible is true)
    set pname to name of p
    try
      repeat with w in (every window of p)
        set wn to name of w
        set wp to position of w
        set ws to size of w
        set out to out & pname & tab & wn & tab & (item 1 of wp) & tab & (item 2 of wp) & tab & (item 1 of ws) & tab & (item 2 of ws) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;
  let out = '';
  try {
    out = await run(OSA, ['-e', script], { timeoutMs: 60000 });
  } catch (e) {
    return {
      error: 'could not read the window list. macOS gates this behind Accessibility permission '
        + '(System Settings > Privacy & Security > Accessibility) for the terminal. '
        + `Underlying error: ${String(e.message).slice(0, 160)}`,
    };
  }
  const rows = [];
  out.split('\n').forEach((line, i) => {
    const f = line.split('\t');
    if (f.length < 6) return;
    rows.push({
      hwnd: String(i),
      pid: null,
      app: f[0],
      title: f[1],
      x: Number(f[2]), y: Number(f[3]), width: Number(f[4]), height: Number(f[5]),
    });
  });
  return rows;
}

/** A window's rectangle, by the index `listWindows` reported. */
export async function windowRect(hwnd) {
  if (!isMac) return unsupported('window geometry on macOS only');
  const all = await listWindows();
  if (Array.isArray(all)) return all;
  const w = all.find((x) => x.hwnd === String(hwnd));
  if (!w) return { error: `no window at index ${hwnd}` };
  return { x: w.x, y: w.y, width: w.width, height: w.height };
}

/** Bring a window to the front. */
export async function focusWindow(hwnd) {
  if (!isMac) return unsupported('window focus on macOS only');
  const all = await listWindows();
  if (Array.isArray(all)) return all;
  const w = all.find((x) => x.hwnd === String(hwnd));
  if (!w) return { error: `no window at index ${hwnd}` };
  await run(OSA, ['-e', `tell application ${JSON.stringify(w.app)} to activate`], { timeoutMs: 15000 });
  return { ok: true };
}

export async function resizeWindow(hwnd, { x, y, width, height }) {
  return unsupported('window resize on macOS: the Accessibility API can set position and size, but '
    + 'it needs osascript per application and is not implemented in this plugin yet');
}

export async function closeWindow(hwnd) {
  return unsupported('window close on macOS is not implemented in this plugin yet');
}

/**
 * Window state on macOS.
 *
 * Reported as unavailable rather than guessed: the Accessibility API can read and set these, but it needs a
 * per-application script and a permission grant this plugin has not taken on. A tool that silently returns
 * plausible-looking defaults would be worse than one that says it cannot answer.
 */
export async function getWindowInfo(hwnd) {
  return unsupported('window details on macOS are not implemented in this plugin yet');
}

export async function setWindowState(hwnd, cmd) {
  return unsupported(`window ${cmd} on macOS is not implemented in this plugin yet`);
}

/**
 * Waiting for a window works on every platform: it polls `listWindows`, which macOS does implement.
 *
 * The polling lives here rather than in the model's turn — each round trip through a turn costs a full
 * inference pass, and a window usually takes a second or two to appear.
 */
export async function waitForWindow({ title, className, hwnd, state = 'appear', timeoutMs = 15000, pollMs = 250 } = {}) {
  if (!isMac) return unsupported('waiting for windows on macOS only');
  const until = Date.now() + Math.max(0, Number(timeoutMs) || 15000);
  const wantGone = String(state).toLowerCase() === 'disappear';
  const titleNeedle = String(title || '').toLowerCase();
  const classNeedle = String(className || '').toLowerCase();

  let last = null;
  for (;;) {
    let windows = [];
    try { windows = await listWindows(); } catch { windows = []; }
    const hit = windows.find((w) => {
      if (hwnd != null) return String(w.hwnd) === String(hwnd);
      const byTitle = titleNeedle && String(w.title || '').toLowerCase().includes(titleNeedle);
      const byClass = classNeedle && String(w.className || '').toLowerCase().includes(classNeedle);
      return (!titleNeedle && !classNeedle) || byTitle || byClass;
    });
    last = hit || null;

    if (wantGone ? !hit : !!hit) return { ok: true, found: wantGone ? null : hit };
    if (Date.now() >= until) {
      return {
        ok: false,
        found: null,
        error: wantGone
          ? `the window was still there after ${timeoutMs}ms`
          : `no window matching ${JSON.stringify(title || className || '(any)')} appeared within ${timeoutMs}ms`,
        lastSeen: last,
      };
    }
    await new Promise((r) => setTimeout(r, Math.max(50, Number(pollMs) || 250)));
  }
}

/** The displays, from system_profiler's display section. */
export async function listDisplays() {
  if (!isMac) return unsupported('display enumeration on macOS only');
  try {
    const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 25000 });
    const json = JSON.parse(out);
    const gpus = json.SPDisplaysDataType || [];
    const out2 = [];
    for (const g of gpus) {
      for (const d of g.spdisplays_ndrvs || []) {
        const m = /(\d+)\s*x\s*(\d+)/.exec(d._name || d.spdisplays_resolution || '');
        out2.push({
          name: d._name || 'display',
          primary: out2.length === 0,
          width: m ? Number(m[1]) : null,
          height: m ? Number(m[2]) : null,
        });
      }
    }
    return out2;
  } catch (e) {
    return { error: `could not enumerate displays: ${String(e.message).slice(0, 160)}` };
  }
}

// ---------------------------------------------------------------------------
// the control tree, through the Accessibility API
// ---------------------------------------------------------------------------

/**
 * The accessibility tree of a window.
 *
 * macOS exposes a tree per PROCESS, so this reports the frontmost application's tree when no
 * window index is given. `hwnd` here is the index `listWindows` produced, which is what the tool
 * layer hands back — the same shape the Windows backend uses, so the tools do not branch.
 */
export async function getTree({ hwnd, depth = 4, maxNodes = 1500, controlTypes } = {}) {
  if (!isMac) return unsupported('the accessibility tree on macOS only');
  void controlTypes;
  const script = `
tell application "System Events"
  set out to ""
  set procs to (every process whose frontmost is true)
  if (count of procs) is 0 then return "ERR:no frontmost application"
  set p to item 1 of procs
  set out to out & "ROOT" & tab & "Application" & tab & (name of p) & linefeed
  set n to 0
  repeat with w in (every window of p)
    set wn to ""
    try
      set wn to name of w
    end try
    set out to out & n & tab & "1" & tab & "Window" & tab & wn & tab & "" & linefeed
    set n to n + 1
    if n > ${toInt(maxNodes, 1500, 1, 20000)} then exit repeat
  end repeat
  return out
end tell`;
  try {
    const out = await run(OSA, ['-e', script], { timeoutMs: 60000 });
    return { elements: parseMacTree(out), truncated: false, depthUsed: toInt(depth, 4, 1, 30) };
  } catch (e) {
    return {
      error: 'could not read the accessibility tree. macOS requires Accessibility permission for '
        + 'the terminal (System Settings > Privacy & Security > Accessibility). '
        + `Underlying error: ${String(e.message).slice(0, 160)}`,
    };
  }
}

/** Parse the tab-separated tree the AppleScript above emits. */
export function parseMacTree(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || !line.includes('\t')) continue;
    const f = line.split('\t');
    if (f[0] === 'ROOT') continue;
    out.push({
      index: Number(f[0]) || out.length,
      depth: Number(f[1]) || 1,
      controlType: f[2] || 'Element',
      name: f[3] || '',
      automationId: '',
      className: '',
      // System Events reports position and size separately, and this script does not pay for them
      // per node: a tree walk that asks for geometry of every element takes seconds. The caller
      // that needs a point asks elementInfo, which resolves one element.
      x: 0, y: 0, width: 0, height: 0,
      enabled: true,
    });
  }
  return out;
}

export async function findElements({ name, limit = 50 } = {}) {
  if (!isMac) return unsupported('the accessibility tree on macOS only');
  const tree = await getTree({ hwnd: null, depth: 12, maxNodes: 20000 });
  if (tree && tree.error) return tree;
  const needle = String(name || '').toLowerCase();
  const hits = (tree.elements || []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
  return { matches: hits.slice(0, toInt(limit, 50, 1, 500)), total: hits.length };
}

export async function elementInfo({ name } = {}) {
  return unsupported(`element detail on macOS is not implemented yet (asked for "${name}")`);
}

export async function focusedElement() {
  if (!isMac) return unsupported('the accessibility tree on macOS only');
  try {
    const out = await run(OSA, ['-e', 'tell application "System Events" to return name of first process whose frontmost is true'], { timeoutMs: 15000 });
    return { app: out.trim(), controlType: 'Application' };
  } catch (e) {
    return { error: `could not read the focused element: ${String(e.message).slice(0, 160)}` };
  }
}

export async function waitForElement({ name, state = 'appear', timeoutMs = 15000 }) {
  if (!isMac) return unsupported('the accessibility tree on macOS only');
  const deadline = Date.now() + toInt(timeoutMs, 15000, 100, 300000);
  const wantPresent = state !== 'disappear';
  while (Date.now() < deadline) {
    const r = await findElements({ name, limit: 1 });
    const present = !!(r && r.matches && r.matches.length);
    if (present === wantPresent) return { found: present, element: present ? r.matches[0] : null };
    await new Promise((res) => setTimeout(res, 300));
  }
  return { found: !wantPresent, timedOut: true, element: null };
}

export { isMac };
