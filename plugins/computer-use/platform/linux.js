// The Linux backend: grim or import for pixels, xdotool or ydotool for input, AT-SPI for the tree.
//
// WHY SO MANY ALTERNATIVES
// ------------------------
// Linux has no single desktop API. The split that matters is X11 versus Wayland:
//
//   X11      import(1) (ImageMagick) or scrot for pixels, xdotool for input, and a tree through
//            AT-SPI. xdotool is universal on X11.
//   Wayland  grim for pixels, ydotool for input. X11 tools CANNOT drive a Wayland session — the
//            security model forbids one client controlling another — so a missing ydotool is
//            reported as the reason, not as a generic failure.
//
// AT-SPI is the accessibility tree on both, reached through python3-pyatspi or over D-Bus. It is
// the least likely piece to be installed, so an absent AT-SPI downgrades the TREE to unavailable
// while leaving screenshots and input working. That is a real capability split and the tools say so
// rather than pretending the tree is empty.
import { run, have, unsupported, shotPath, pngSize, sizeOf, intArg as toInt } from './util.js';

const isLinux = process.platform === 'linux';

/** How this session is drawn. Decides which tools can work at all. */
function sessionType() {
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'none';
}

/** The capture program to use, or null. */
async function captureTool() {
  if (sessionType() === 'wayland') {
    if (await have('grim')) return { cmd: 'grim', kind: 'grim' };
    return null;
  }
  if (await have('import')) return { cmd: 'import', kind: 'import' };
  if (await have('scrot')) return { cmd: 'scrot', kind: 'scrot' };
  if (await have('grim')) return { cmd: 'grim', kind: 'grim' };
  return null;
}

/** The input tool, or null. */
async function inputTool() {
  if (sessionType() === 'wayland') {
    return (await have('ydotool')) ? 'ydotool' : null;
  }
  return (await have('xdotool')) ? 'xdotool' : null;
}

/** Whether python3 can import AT-SPI, the accessibility binding the tree needs. */
async function hasAtspi() {
  if (!(await have('python3'))) return false;
  try {
    await run('python3', ['-c', 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi'], { timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** What this session can and cannot do, so the caller can explain a refusal. */
export async function capabilities() {
  const st = sessionType();
  return {
    session: st,
    capture: !!(await captureTool()),
    input: !!(await inputTool()),
    tree: st === 'x11' ? await hasAtspi() : false,
  };
}

export async function screenBounds() {
  if (!isLinux) return unsupported('screen bounds on Linux only');
  try {
    const out = await run('xdotool', ['getdisplaygeometry'], { timeoutMs: 10000 });
    const m = /(\d+)\s+(\d+)/.exec(out);
    if (m) return { x: 0, y: 0, width: +m[1], height: +m[2] };
  } catch { /* Wayland, or no xdotool */ }
  try {
    const out = await run('xdpyinfo', ['-display', process.env.DISPLAY || ':0'], { timeoutMs: 10000 });
    const m = /dimensions:\s+(\d+)x(\d+)/.exec(out);
    if (m) return { x: 0, y: 0, width: +m[1], height: +m[2] };
  } catch { /* no xdpyinfo */ }
  return unsupported(`could not determine the screen size on a ${sessionType()} session with the tools installed`);
}

export async function captureRegion({ x, y, width, height }, tag = 'region') {
  if (!isLinux) return unsupported('screen capture on Linux only');
  const tool = await captureTool();
  if (!tool) {
    return unsupported(sessionType() === 'wayland'
      ? 'screen capture on Wayland needs grim (install: grim)'
      : 'screen capture on X11 needs ImageMagick\'s import or scrot (install: imagemagick or scrot)');
  }
  const file = shotPath(tag);
  if (tool.kind === 'grim') await run('grim', ['-g', `${x},${y} ${width}x${height}`, file], { timeoutMs: 30000 });
  else if (tool.kind === 'import') await run('import', ['-window', 'root', '-crop', `${width}x${height}+${x}+${y}`, file], { timeoutMs: 30000 });
  else await run('scrot', ['-a', `${x},${y},${width},${height}`, file], { timeoutMs: 30000 });
  const size = pngSize(file);
  if (!size) return { error: `the capture produced no image (used ${tool.cmd})` };
  return { path: file, bytes: sizeOf(file), width: size.width, height: size.height };
}

/**
 * Capture one window, or the whole desktop when no handle is given.
 *
 * `null` means the desktop, not "a window whose id is null" — the Screenshot tool's `full` mode
 * routes here, and passing it on to `windowRect` would look up a window that cannot exist.
 */
export async function captureWindow(hwnd, tag = 'window') {
  if (!isLinux) return unsupported('screen capture on Linux only');
  if (hwnd == null || hwnd === '' || hwnd === 'null') {
    const bounds = await screenBounds();
    if (bounds && (bounds.unsupported || bounds.error)) return bounds;
    return captureRegion(bounds, 'desktop');
  }
  const rect = await windowRect(hwnd);
  if (rect && rect.error) return rect;
  return captureRegion(rect, tag);
}

/** Windows, via xdotool. On Wayland there is no equivalent without a compositor-specific tool. */
export async function listWindows() {
  if (!isLinux) return unsupported('window enumeration on Linux only');
  if (sessionType() === 'wayland') {
    return unsupported('window enumeration on Wayland needs a compositor-specific tool (e.g. '
      + 'wlrctl for wlroots); install one, or use the tree/coordinates instead');
  }
  if (!(await have('xdotool'))) return unsupported('window enumeration needs xdotool (install: xdotool)');
  const ids = String(await run('xdotool', ['search', '--onlyvisible', '--name', '.'], { timeoutMs: 15000 })).trim().split('\n').filter(Boolean);
  const rows = [];
  for (const id of ids) {
    try {
      const name = String(await run('xdotool', ['getwindowname', id], { timeoutMs: 5000 })).trim();
      const geo = String(await run('xdotool', ['getwindowgeometry', '--shell', id], { timeoutMs: 5000 }));
      const gx = /X=(-?\d+)/.exec(geo);
      const gy = /Y=(-?\d+)/.exec(geo);
      const gw = /WIDTH=(\d+)/.exec(geo);
      const gh = /HEIGHT=(\d+)/.exec(geo);
      rows.push({
        hwnd: id, pid: null, title: name,
        x: gx ? +gx[1] : 0, y: gy ? +gy[1] : 0,
        width: gw ? +gw[1] : 0, height: gh ? +gh[1] : 0,
      });
    } catch { /* the window vanished between listing and asking */ }
  }
  return rows;
}

export async function windowRect(hwnd) {
  if (!isLinux) return unsupported('window geometry on Linux only');
  const all = await listWindows();
  if (Array.isArray(all)) return all;
  const w = all.find((x) => x.hwnd === String(hwnd));
  if (!w) return { error: `no window with id ${hwnd}` };
  return { x: w.x, y: w.y, width: w.width, height: w.height };
}

export async function focusWindow(hwnd) {
  if (!isLinux) return unsupported('window focus on Linux only');
  if (!(await have('xdotool'))) return unsupported('focusing a window needs xdotool (install: xdotool)');
  await run('xdotool', ['windowactivate', String(hwnd)], { timeoutMs: 10000 });
  return { ok: true };
}

export async function resizeWindow(hwnd, { x, y, width, height }) {
  if (!isLinux) return unsupported('window resize on Linux only');
  if (!(await have('xdotool'))) return unsupported('resizing a window needs xdotool (install: xdotool)');
  await run('xdotool', ['windowmove', String(hwnd), String(x), String(y)], { timeoutMs: 10000 });
  await run('xdotool', ['windowsize', String(hwnd), String(width), String(height)], { timeoutMs: 10000 });
  return { ok: true };
}

export async function closeWindow(hwnd) {
  if (!isLinux) return unsupported('window close on Linux only');
  if (!(await have('xdotool'))) return unsupported('closing a window needs xdotool (install: xdotool)');
  await run('xdotool', ['windowclose', String(hwnd)], { timeoutMs: 10000 });
  return { ok: true };
}

/**
 * One window, in detail — from `xdotool getwindowgeometry`, plus the list entry for title and class.
 *
 * The list already carries the title, so only the geometry and the state are asked for here. `getwindowgeometry`
 * reports position and size; `getwindowfocus` is how "is this the active window" is answered, because X11 has no
 * per-window query for it.
 */
export async function getWindowInfo(hwnd) {
  if (!isLinux) return unsupported('window details on Linux only');
  if (!(await have('xdotool'))) return unsupported('window details need xdotool (install: xdotool)');

  let entry = null;
  try {
    entry = (await listWindows()).find((w) => String(w.hwnd) === String(hwnd)) || null;
  } catch { /* the geometry below still works */ }

  let geometry = null;
  try {
    const out = await run('xdotool', ['getwindowgeometry', '--shell', String(hwnd)], { timeoutMs: 10000 });
    geometry = {};
    for (const line of String(out).split('\n')) {
      const m = /^(\w+)=(-?\d+)$/.exec(line.trim());
      if (m) geometry[m[1]] = Number(m[2]);
    }
  } catch { /* a window that vanished between calls */ }

  let foreground = false;
  try {
    const out = await run('xdotool', ['getwindowfocus'], { timeoutMs: 5000 });
    foreground = String(out).trim() === String(hwnd);
  } catch { /* no focus owner */ }

  return {
    hwnd: String(hwnd),
    title: entry ? entry.title : '',
    className: entry ? entry.className : '',
    pid: entry ? entry.pid : null,
    x: geometry && geometry.X != null ? geometry.X : 0,
    y: geometry && geometry.Y != null ? geometry.Y : 0,
    width: geometry && geometry.WIDTH != null ? geometry.WIDTH : 0,
    height: geometry && geometry.HEIGHT != null ? geometry.HEIGHT : 0,
    visible: !!entry,
    maximized: !!(entry && entry.maximized),
    minimized: false,   // X11 has no per-window iconified flag xdotool can read
    foreground,
  };
}

/** Maximize, minimize or restore, through the window manager's own EWMH actions. */
export async function setWindowState(hwnd, cmd) {
  if (!isLinux) return unsupported('window state on Linux only');
  if (!(await have('xdotool'))) return unsupported('window state needs xdotool (install: xdotool)');
  const action = {
    maximize: 'add',
    minimize: 'add',
    restore: 'remove',
  }[String(cmd || '').toLowerCase()];
  const prop = {
    maximize: '_NET_WM_STATE_MAXIMIZED_VERT',
    minimize: '_NET_WM_STATE_HIDDEN',
    restore: '_NET_WM_STATE_MAXIMIZED_VERT',
  }[String(cmd || '').toLowerCase()];
  if (!action) return { error: `unknown state "${cmd}": use maximize, minimize or restore` };
  try {
    await run('xdotool', ['windowstate', '--' + action, String(hwnd), prop], { timeoutMs: 10000 });
    return { ok: true, state: String(cmd).toLowerCase() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Wait for a window matching a title or class to appear (or disappear).
 *
 * Polling belongs on this side: each attempt through a model turn is a full inference pass, and a window usually
 * takes a second or two — so the wait costs the conversation nothing when it happens here.
 */
export async function waitForWindow({ title, className, hwnd, state = 'appear', timeoutMs = 15000, pollMs = 250 } = {}) {
  if (!isLinux) return unsupported('waiting for windows on Linux only');
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

export async function listDisplays() {
  if (!isLinux) return unsupported('display enumeration on Linux only');
  if (await have('xrandr')) {
    try {
      const out = await run('xrandr', ['--query'], { timeoutMs: 15000 });
      const rows = [];
      for (const line of out.split('\n')) {
        const m = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line.trim());
        if (m) {
          rows.push({
            name: m[1], primary: !!m[2],
            width: Number(m[3]), height: Number(m[4]),
            x: Number(m[5]), y: Number(m[6]),
          });
        }
      }
      if (rows.length) return rows;
    } catch { /* fall through */ }
  }
  return unsupported('display enumeration needs xrandr (install: xrandr)');
}

// ---------------------------------------------------------------------------
// the accessibility tree, through AT-SPI
// ---------------------------------------------------------------------------

/**
 * The tree via python3 + pyatspi.
 *
 * A tree walk of a whole desktop is expensive over D-Bus, and AT-SPI has no server-side depth
 * limit, so the depth and node caps are enforced in the Python loop rather than after the fact —
 * the point of a cap is to stop the walk, not to truncate its result.
 */
const PY_WALK = `
import json, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as e:
    print(json.dumps({'error': 'AT-SPI is not available: %s' % e}))
    sys.exit(0)

max_depth = int(sys.argv[1])
max_nodes = int(sys.argv[2])

out = []
def node_role(n):
    try:
        return n.get_role_name() or 'unknown'
    except Exception:
        return 'unknown'
def node_name(n):
    try:
        return n.get_name() or ''
    except Exception:
        return ''

def walk(n, depth):
    if len(out) >= max_nodes:
        return
    name = node_name(n)
    role = node_role(n)
    if name or role not in ('unknown', 'panel', 'filler'):
        out.append({'index': len(out), 'depth': depth, 'controlType': role,
                    'name': name, 'automationId': '', 'className': '',
                    'x': 0, 'y': 0, 'width': 0, 'height': 0, 'enabled': True})
    if depth >= max_depth:
        return
    try:
        count = n.get_child_count()
    except Exception:
        return
    for i in range(count):
        if len(out) >= max_nodes:
            return
        try:
            walk(n.get_child_at_index(i), depth + 1)
        except Exception:
            continue

try:
    desktop = Atspi.get_desktop(0)
    walk(desktop, 0)
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(0)

print(json.dumps({'elements': out}))
`;

export async function getTree({ hwnd, depth = 4, maxNodes = 1500, controlTypes } = {}) {
  if (!isLinux) return unsupported('the AT-SPI tree on Linux only');
  void hwnd;
  void controlTypes;
  if (!(await hasAtspi())) {
    return unsupported('the accessibility tree needs AT-SPI: python3 with gi and the Atspi typelib '
      + '(install: python3-gi gir1.2-atspi-2.0 on Debian/Ubuntu, or python3-atspi on Fedora)');
  }
  const out = await run('python3', ['-c', PY_WALK, String(toInt(depth, 4, 1, 30)), String(toInt(maxNodes, 1500, 1, 20000))], { timeoutMs: 90000 });
  let parsed;
  try {
    parsed = JSON.parse(String(out).trim().split('\n').pop());
  } catch (e) {
    return { error: `could not parse the AT-SPI output: ${String(e.message).slice(0, 160)}` };
  }
  if (parsed.error) return { error: parsed.error };
  const elements = parsed.elements || [];
  return { elements, truncated: elements.length >= toInt(maxNodes, 1500, 1, 20000) };
}

export async function findElements({ name, limit = 50 } = {}) {
  if (!isLinux) return unsupported('the AT-SPI tree on Linux only');
  const tree = await getTree({ depth: 12, maxNodes: 20000 });
  if (tree && tree.error) return tree;
  if (Array.isArray(tree)) return tree;
  const needle = String(name || '').toLowerCase();
  const hits = (tree.elements || []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
  return { matches: hits.slice(0, toInt(limit, 50, 1, 500)), total: hits.length };
}

export async function elementInfo() {
  return unsupported('element detail on Linux is not implemented yet');
}

export async function focusedElement() {
  if (!isLinux) return unsupported('the AT-SPI tree on Linux only');
  if (!(await hasAtspi())) return unsupported('reading the focused element needs AT-SPI');
  const script = `
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
import json
try:
    d = Atspi.get_desktop(0)
    found = None
    for i in range(d.get_child_count()):
        app = d.get_child_at_index(i)
        try:
            if app.get_state_set().contains(Atspi.StateType.ACTIVE):
                found = app
                break
        except Exception:
            continue
    if found is None:
        print(json.dumps({'error': 'nothing is focused'}))
    else:
        print(json.dumps({'app': found.get_name() or '', 'controlType': found.get_role_name() or ''}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;
  const out = await run('python3', ['-c', script], { timeoutMs: 30000 });
  try {
    return JSON.parse(String(out).trim().split('\n').pop());
  } catch {
    return { error: 'could not read the focused element' };
  }
}

export async function waitForElement({ name, state = 'appear', timeoutMs = 15000 }) {
  if (!isLinux) return unsupported('the AT-SPI tree on Linux only');
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

export { isLinux, sessionType, inputTool };
