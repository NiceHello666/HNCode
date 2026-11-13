// hncode cu — computer use: see the screen, read the control tree, and act on either.
//
// WHAT IT IS FOR
// --------------
// Driving a real desktop: reading a window's controls, clicking a named button, typing into a
// field, taking a screenshot to check what happened. Two ways to see, because they fail
// differently:
//
//   SCREENSHOT    what the screen LOOKS like. Works on anything, including a canvas or a game that
//                 has no accessibility tree at all. Says nothing about what is clickable, and a
//                 coordinate read from it breaks the moment the window moves.
//   CONTROL TREE  what is ON the screen: each element with its own rectangle, type, name and
//                 enabled state, straight from the OS accessibility layer. Clicking a named
//                 element survives a moved window, a different DPI and a theme change; a coordinate
//                 does not.
//
// Reach for the tree first and the screenshot when the tree is empty — a game, a custom-drawn pane,
// a remote desktop view. Both are here rather than one replacing the other for exactly that reason.
//
// PLATFORM SUPPORT
// ----------------
//   Windows  .NET through PowerShell: System.Drawing for pixels, UI Automation for the tree,
//            SendInput for mouse and keyboard. No install needed.
//   macOS    screencapture(1) and the Accessibility API. Needs Screen Recording and Accessibility
//            permission; each entry point says so when it is missing, because a denied capture
//            succeeds silently and writes a black image.
//   Linux    grim (Wayland) or import/scrot (X11), AT-SPI for the tree, xdotool or ydotool for
//            input. xdotool cannot drive a Wayland session at all, and that is reported as such.
//
// Every tool works on every platform the same way; a capability a platform lacks is reported with
// the mechanism it needs, never as an empty result that reads like "there is nothing there".
import * as platform from './platform/index.js';
import { present, presentShot, presentTree, presentMatches } from './format.js';
import { intArg } from './platform/util.js';

/** The tools this plugin registers, kept in one array so `Steps` can address them by name. */
const TOOLS = [];

/** Register a tool and remember it for `Steps`. */
function tool(api, spec) {
  api.registerTool(spec);
  TOOLS.push(spec);
}

/**
 * Tools that exist ONLY as a step inside `Steps` — never registered, so the model cannot call them
 * on their own.
 *
 * `Wait` is the reason this list exists. A pause between two actions is meaningful only as part of a
 * sequence: on its own, "sleep 500ms" is a turn spent doing nothing that the model could have got by
 * simply taking the next step. Inside `Steps` it is load-bearing — click a menu, wait for it to
 * animate open, then click the item.
 */
const STEP_ONLY = [
  {
    name: 'Wait',
    description: 'Pause inside a Steps sequence. `ms` milliseconds, 1 to 60000.',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'number', description: 'How long to pause, in milliseconds.' } },
      required: ['ms'],
    },
    async execute(args) {
      const raw = Math.trunc(Number(args.ms));
      if (!Number.isFinite(raw) || raw <= 0) {
        return 'Error: Wait needs ms — a number of milliseconds, 1 to 60000.';
      }
      // A wait longer than the cap is REFUSED rather than quietly shortened. Clamping it would mean
      // the caller asked for five minutes and got one, with nothing said — the same silent
      // substitution as truncating output without a marker, and here it would hide a mistake in the
      // caller's own timing rather than the tool's limit.
      if (raw > 60000) {
        return `Error: Wait takes at most 60000 ms; ${raw} was asked for. Split it into several Wait `
          + 'steps, or reconsider whether the pause is the right approach.';
      }
      await new Promise((r) => setTimeout(r, raw));
      return `Waited ${raw} ms.`;
    },
  },
];

/** Every name `Steps` accepts, registered or step-only. */
function stepTools() {
  return [...TOOLS, ...STEP_ONLY];
}

/** Run a tool by name — used by `Steps`. */
async function runTool(name, args, ctx) {
  const found = stepTools().find((t) => t.name === name);
  if (!found) {
    return { ok: false, text: `unknown tool "${name}". Known: ${stepTools().map((t) => t.name).join(', ')}` };
  }
  try {
    const out = await found.execute(args || {}, ctx);
    return { ok: true, text: String(out) };
  } catch (e) {
    return { ok: false, text: `Error: ${(e && e.message) || String(e)}` };
  }
}

/**
 * A window handle, or an error naming the argument.
 *
 * A handle reaches a backend as text interpolated into a PowerShell script or an argv, so a missing
 * one becomes `undefined` or `NaN` and the backend reports a SYNTAX ERROR in its own language —
 * `Missing ')' in method call` names neither the tool nor the argument, leaving the model nothing
 * to correct. Checked here, where both are obvious.
 */
function windowHandle(value) {
  const h = String(value == null ? '' : value).trim();
  if (!h || h === 'undefined' || h === 'null' || h === 'NaN') {
    return { error: 'hwnd must be a window handle from ListWindows (e.g. "9966420").' };
  }
  return { hwnd: h };
}

export function install(api) {
  // ---------------------------------------------------------------- screenshots

  tool(api, {
    name: 'Screenshot',
    description: [
      'Capture the screen as a PNG and attach it, so you can see what is actually displayed.',
      '',
      'Modes:',
      "  full    the entire desktop, across every monitor",
      "  region  a rectangle you specify (x, y, width, height), in VIRTUAL-DESKTOP coordinates",
      "  window  one window, by the hwnd from ListWindows",
      '',
      'Prefer the control tree over a screenshot when the target has one: a named element click',
      'survives the window moving, a coordinate read off a picture does not. Use a screenshot to',
      'CHECK the result, or when the tree is empty (a game, a canvas, a remote desktop view).',
      '',
      'Coordinates are virtual-desktop, not primary-monitor: a second monitor to the LEFT of the',
      'primary has negative x. Get the values from ListDisplays or GetScreenSize rather than',
      'assuming the origin.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'region', 'window'], description: 'What to capture. Defaults to full.' },
        x: { type: 'number', description: 'region: left edge, virtual-desktop coordinates.' },
        y: { type: 'number', description: 'region: top edge.' },
        width: { type: 'number', description: 'region: width in pixels.' },
        height: { type: 'number', description: 'region: height in pixels.' },
        hwnd: { type: 'string', description: 'window: the handle from ListWindows.' },
      },
    },
    async execute(args) {
      const mode = String(args.mode || 'full');
      if (mode === 'region') {
        const w = intArg(args.width, 0, 1);
        const h = intArg(args.height, 0, 1);
        if (!w || !h) return 'Error: region mode needs width and height (and x, y; both default to 0).';
        const shot = await platform.call('captureRegion', {
          x: intArg(args.x, 0), y: intArg(args.y, 0), width: w, height: h,
        });
        return presentShot(shot, `Screenshot of ${w}x${h} at (${intArg(args.x, 0)},${intArg(args.y, 0)})`);
      }
      if (mode === 'window') {
        const h = windowHandle(args.hwnd);
        if (h.error) return `Error: window mode needs ${h.error}`;
        const shot = await platform.call('captureWindow', h.hwnd);
        return presentShot(shot, `Screenshot of window ${h.hwnd}`);
      }
      const full = await platform.call('captureWindow', null);
      return presentShot(full, 'Screenshot of the full desktop');
    },
  });

  tool(api, {
    name: 'ListWindows',
    description: 'List the visible top-level windows: handle, title, process and rectangle.\n\n'
      + 'Use the handle with Screenshot (mode window), WindowFocus, WindowResize, WindowClose, or '
      + 'GetUITree to walk that window instead of the whole desktop.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('listWindows');
      return present(r, (rows) => {
        if (!rows.length) return 'No visible windows.';
        const lines = rows.map((w) => {
          const box = w.width && w.height ? ` ${w.width}x${w.height} at ${w.x},${w.y}` : '';
          const app = w.app ? ` [${w.app}]` : '';
          return `  ${w.hwnd}${app} "${w.title}"${box}`;
        });
        return `${rows.length} window(s):\n${lines.join('\n')}`;
      });
    },
  });
  tool(api, {
    name: 'ListApps',
    description: [
      'The running applications, grouped by process, with the main window of each identified.',
      '',
      'PREFER THIS OVER ListWindows when you want to act on an APPLICATION. A flat window list makes',
      'you work out which of several windows belongs to one program, and nothing in it says which of',
      'them is the real window rather than a helper. This answers both: `mainHwnd` is the one to use,',
      'and each entry lists the windows that belong to it.',
      '',
      'Invisible plumbing is filtered out — input-method helpers, tooltips, shadow windows and the',
      'like. They report a valid rectangle, so they used to look exactly like real windows and waste',
      'a turn each time.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('listApps');
      return present(r, (apps) => {
        if (!apps.length) return 'No applications with windows were found.';
        return `${apps.length} application(s):\n` + apps.map((a) => {
          const win = `  ${a.mainHwnd} "${a.mainTitle}" (${a.count} window${a.count === 1 ? '' : 's'})`;
          return `${a.process} [pid ${a.pid}]\n${win}`;
        }).join('\n');
      });
    },
  });

  tool(api, {
    name: 'LaunchApp',
    description: [
      'Start a program and report the windows that appeared.',
      '',
      '`target` is a program name (`notepad`), a path, or a URL. A name is resolved through PATH and',
      'the App Paths registry, so the `.exe` suffix is optional.',
      '',
      'It waits briefly and returns the matching windows, because after launching something you almost',
      'always need its handle — and you have no way to know the process name or how long it took to',
      'appear. The result gives you both, so the next call can address a real window.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Program name, path, or URL to start.' },
        waitMs: { type: 'number', description: 'How long to wait for a window before reporting. Default 1500.' },
      },
      required: ['target'],
    },
    async execute(args) {
      const r = await platform.call('launchApp', String(args.target || ''), {
        waitMs: intArg(args.waitMs, 1500, 0, 10000),
      });
      return present(r, (x) => {
        let out = `Started ${x.launched}` + (x.pid ? ` (pid ${x.pid})` : '') + '.';
        if (x.windows && x.windows.length) {
          out += '\nWindows that appeared:\n' + x.windows
            .map((w) => `  ${w.hwnd} "${w.title}" ${w.width}x${w.height}`).join('\n');
        } else {
          out += '\nNo window appeared yet — it may still be starting. Call ListWindows to check.';
        }
        return out;
      });
    },
  });

  tool(api, {
    name: 'TerminateApp',
    description: [
      'End a process by its pid (from ListApps or ListWindows).',
      '',
      'This asks the application to close, the same way its close button does, so one with unsaved',
      'work gets to prompt. If it is still running afterwards the result says so rather than forcing',
      'it — set `force` to kill it, which DISCARDS unsaved work with no chance to save.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id, from ListApps or ListWindows.' },
        force: { type: 'boolean', description: 'Kill it if closing did not work. Discards unsaved work.' },
      },
      required: ['pid'],
    },
    async execute(args) {
      const pid = Number(args.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        return `Error: pid must be a number from ListApps or ListWindows (got ${JSON.stringify(args.pid)}).`;
      }
      const r = await platform.call('terminateProcess', pid, { force: !!args.force });
      return present(r, (x) => {
        if (x.outcome === 'not-running') return `Process ${pid} was not running.`;
        if (x.outcome === 'closed') return `Process ${pid} closed cleanly.`;
        if (x.outcome === 'killed') return `Process ${pid} was killed. Unsaved work was discarded.`;
        return `Process ${pid} is still running. ${x.note}`;
      });
    },
  });

  tool(api, {
    name: 'ReadPixel',
    description: [
      'The colour at a point on screen, as RGB, hex, and a light/mid/dark judgement.',
      '',
      'A cheap question with a cheap answer. Use it to check whether a button lit up, whether a region',
      'changed, or what colour something is — where a screenshot would cost a capture and a few',
      'hundred kilobytes for three integers.',
      '',
      '`radius` samples a small cross around the point rather than one pixel, because a single pixel',
      'on a scaled or antialiased display is often an artefact of the scaling rather than the colour a',
      'person sees.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in virtual-desktop coordinates.' },
        y: { type: 'number', description: 'Y in virtual-desktop coordinates.' },
        radius: { type: 'number', description: 'Also sample this far left/right/up/down and average. Default 0.' },
      },
      required: ['x', 'y'],
    },
    async execute(args) {
      const r = await platform.call('readPixel', intArg(args.x, 0), intArg(args.y, 0), {
        radius: intArg(args.radius, 0, 0, 20),
      });
      return present(r, (p) => `${p.hex} (rgb ${p.average.r},${p.average.g},${p.average.b}) at ${p.x},${p.y}`
        + ` — luma ${p.luma}, ${p.tone}`
        + (p.radius ? `, averaged from ${p.samples.length} samples` : ''));
    },
  });

  tool(api, {
    name: 'ListDisplays',
    description: 'List the monitors: position, size, and which is primary.\n\n'
      + 'Needed before a region capture on a multi-monitor setup, because regions use virtual-desktop '
      + 'coordinates and a monitor left of the primary has negative x.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('listDisplays');
      return present(r, (rows) => {
        if (!rows.length) return 'No displays reported.';
        const lines = rows.map((d) => {
          const box = d.width && d.height ? ` ${d.width}x${d.height} at ${d.x == null ? 0 : d.x},${d.y == null ? 0 : d.y}` : '';
          return `  ${d.name}${d.primary ? ' (primary)' : ''}${box}`;
        });
        return `${rows.length} display(s):\n${lines.join('\n')}`;
      });
    },
  });

  tool(api, {
    name: 'GetScreenSize',
    description: 'The full desktop size in pixels, across every monitor.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('screenBounds');
      return present(r, (b) => `Desktop: ${b.width}x${b.height}, origin at ${b.x},${b.y}`);
    },
  });

  // ---------------------------------------------------------------- the control tree

  tool(api, {
    name: 'GetUITree',
    description: [
      'The window\'s control tree, straight from the OS accessibility layer: every element with its',
      'index, type, name, id, rectangle and enabled state.',
      '',
      'THIS IS USUALLY WHAT YOU WANT before clicking anything. An element\'s rectangle comes from the',
      'system, so acting on it survives the window moving, a different DPI and a theme change — none',
      'of which a coordinate read off a screenshot survives. A disabled control also reports itself',
      'as disabled here, where a screenshot shows only a grey rectangle.',
      '',
      'Pass hwnd to read one window (get it from ListWindows). Without it you get the whole desktop,',
      'which is much larger and usually not what you need.',
      '',
      'An empty result is meaningful: the window is empty, minimised, or draws itself without',
      'accessibility support (a game, a canvas, a remote-desktop view). Falls back to Screenshot in',
      'that case — do not keep re-reading an empty tree.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window handle from ListWindows. Omit for the whole desktop.' },
        // The default has to match the backend's, and it has to be deep. Chrome-based applications
        // — which includes QQ, WeChat and every Electron app — put their real controls a dozen
        // levels down: at depth 4 QQ reports 5 empty Panes, at 12 it reports 134 elements and at
        // 20 it reports 400. A shallow default did not return a smaller tree, it returned an EMPTY
        // one for exactly the applications a user is most likely to point at.
        depth: { type: 'number', description: 'How deep to walk. Default 12; a window with no accessible controls needs more.' },
        maxNodes: { type: 'number', description: 'Stop after this many elements. Default 1500.' },
        controlTypes: {
          type: 'array', items: { type: 'string' },
          description: 'Only these control types, e.g. ["Button","Edit"]. Much smaller result.',
        },
      },
    },
    async execute(args) {
      const tree = await platform.call('getTree', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        depth: intArg(args.depth, 12, 1, 30),
        maxNodes: intArg(args.maxNodes, 1500, 1, 20000),
        controlTypes: Array.isArray(args.controlTypes) ? args.controlTypes : undefined,
      });
      return presentTree(tree, { hwnd: args.hwnd });
    },
  });

  tool(api, {
    name: 'FindElement',
    description: 'Search the control tree for elements matching a name, type, automation id or class.\n\n'
      + 'Use this when you know what the control is CALLED but not where it is. Returns indices that '
      + 'ClickElement, SetElementText, SelectElement and the rest accept directly.\n\n'
      + 'The name match is a case-insensitive substring unless exact is set, so "save" finds "Save as".',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window to search. Omit for the whole desktop.' },
        name: { type: 'string', description: 'Part of the element name.' },
        controlType: { type: 'string', description: 'Exact control type, e.g. Button, Edit, MenuItem.' },
        automationId: { type: 'string', description: 'The element\'s automation id, when it has one.' },
        className: { type: 'string', description: 'The element\'s window class.' },
        exact: { type: 'boolean', description: 'Require the name to match exactly.' },
        walkDepth: { type: 'number', description: 'How deep to walk while searching. Default 12. Pass the same value to the element tools you use the resulting index with.' },
        enabledOnly: { type: 'boolean', description: 'Skip disabled elements.' },
        limit: { type: 'number', description: 'Maximum matches to return. Default 50.' },
      },
    },
    async execute(args) {
      const r = await platform.call('findElements', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        name: args.name,
        controlType: args.controlType,
        automationId: args.automationId,
        className: args.className,
        exact: !!args.exact,
        enabledOnly: !!args.enabledOnly,
        limit: intArg(args.limit, 50, 1, 500),
        depth: intArg(args.walkDepth, 12, 1, 30),
      });
      // The indices are stated to be relative to this depth, because every element tool takes
      // `walkDepth` and an index from a depth-12 search addresses a DIFFERENT element when resolved
      // at the default of 4. Without the note the two silently disagree.
      const note = `\n(indices from a ${intArg(args.walkDepth, 12, 1, 30)}-level walk — pass `
        + `walkDepth: ${intArg(args.walkDepth, 12, 1, 30)} to the element tools you use them with)`;
      return presentMatches(r, args.name ? `"${args.name}"` : 'the given criteria') + note;
    },
  });

  tool(api, {
    name: 'GetElementInfo',
    description: 'Everything known about ONE element: rectangle, enabled/offscreen/focusable state, '
      + 'its current value, and which interaction patterns it supports (Invoke, Value, SelectionItem, '
      + 'ExpandCollapse, ScrollItem, Toggle).\n\n'
      + 'Call it before an action you are unsure about: `patterns` tells you whether an element can be '
      + 'clicked at all, and whether SetElementText will work or you need to type into it instead.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window to look in. Omit for the whole desktop.' },
        index: { type: 'number', description: 'Element index from GetUITree or FindElement.' },
        name: { type: 'string', description: 'Element name, if you do not have an index.' },
        automationId: { type: 'string', description: 'Element automation id.' },
      },
    },
    async execute(args) {
      const r = await platform.call('elementInfo', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
      });
      return present(r, (i) => {
        const lines = [
          `${i.controlType || 'Element'} "${i.name || ''}"`,
          `  rect      ${i.x},${i.y} ${i.width}x${i.height}`,
          `  enabled   ${i.enabled}`,
          `  offscreen ${i.offscreen}`,
          `  focusable ${i.focusable}`,
          `  focused   ${i.focused}`,
        ];
        if (i.patterns) lines.push(`  patterns  ${i.patterns.join(', ') || '(none)'}`);
        if (i.value != null && i.value !== '') lines.push(`  value     ${String(i.value).slice(0, 200)}`);
        return lines.join('\n');
      });
    },
  });

  tool(api, {
    name: 'GetFocusedElement',
    description: 'Which element currently has keyboard focus, and which application it belongs to.\n\n'
      + 'Useful before KeyboardType: it confirms the text will go where you intend, rather than into '
      + 'whatever was focused last.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('focusedElement');
      return present(r, (i) => {
        if (i.app) return `Focused application: ${i.app}`;
        return `${i.controlType} "${i.name || ''}"${i.automationId ? ` #${i.automationId}` : ''}`
          + (i.value != null ? `\nvalue: ${String(i.value).slice(0, 200)}` : '')
          + (i.width ? `\nrect: ${i.x},${i.y} ${i.width}x${i.height}` : '');
      });
    },
  });

  tool(api, {
    name: 'WaitForElement',
    description: 'Wait until an element appears or disappears.\n\n'
      + 'Much more reliable than sleeping: it returns as soon as the condition holds, and a timeout '
      + 'tells you the condition never held. Use it after an action that opens a dialog or saves a '
      + 'file, before assuming the next step is safe.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window to watch. Omit for the whole desktop.' },
        name: { type: 'string', description: 'Element name to watch for.' },
        automationId: { type: 'string', description: 'Element automation id to watch for.' },
        controlType: { type: 'string', description: 'Control type to watch for.' },
        state: { type: 'string', enum: ['appear', 'disappear'], description: 'What to wait for. Default appear.' },
        timeoutMs: { type: 'number', description: 'Give up after this long. Default 15000.' },
      },
    },
    async execute(args) {
      const r = await platform.call('waitForElement', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        name: args.name,
        automationId: args.automationId,
        controlType: args.controlType,
        state: args.state === 'disappear' ? 'disappear' : 'appear',
        timeoutMs: intArg(args.timeoutMs, 15000, 100, 300000),
      });
      return present(r, (x) => {
        if (x.timedOut) {
          const what = args.state === 'disappear' ? 'disappear' : 'appear';
          return `Timed out: the element did not ${what} within ${intArg(args.timeoutMs, 15000)}ms. `
            + 'Check the name, or use GetUITree to see what is actually there now.';
        }
        if (x.found && x.element) {
          return `Found: [${x.element.index}] ${x.element.controlType} "${x.element.name}"`
            + (x.element.width ? ` @${x.element.x},${x.element.y} ${x.element.width}x${x.element.height}` : '');
        }
        return 'The element is gone.';
      });
    },
  });

  // ---------------------------------------------------------------- acting on elements

  tool(api, {
    name: 'ClickElement',
    description: [
      'Click a control, addressed by its index, name or automation id.',
      '',
      'PREFER THIS OVER MouseClick. The position comes from the accessibility layer, so it is correct',
      'regardless of where the window has been moved to, the DPI, or how the theme draws it.',
      '',
      'It does NOT always press the mouse. For a plain left single click it first asks the control to',
      'activate itself — InvokePattern, then SelectionItemPattern — and only falls back to a real mouse',
      'event when neither is supported. That matters more than it sounds: a mouse click is delivered to',
      'whatever is AT that pixel, so a dialog or another window overlapping the control takes the click',
      'instead, and you are told it succeeded. A pattern click cannot be intercepted. The result says',
      'which route was used, so you can tell the two apart.',
      '',
      'Get the index from GetUITree or FindElement. If the element reports no area (width and height',
      '0), it is off screen or virtualised — scroll it into view first, or bring its window forward.',
      'A right click, a middle click or a double click always uses the mouse: the patterns have no',
      'notion of a button or a count.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window containing the element. Omit if you have an index.' },
        index: { type: 'number', description: 'Element index from GetUITree or FindElement.' },
        name: { type: 'string', description: 'Element name, if you have no index.' },
        automationId: { type: 'string', description: 'Element automation id.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which button. Default left.' },
        clicks: { type: 'number', description: '1 for a click, 2 for a double click.' },
      },
    },
    async execute(args) {
      const r = await platform.call('clickElement', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
        button: args.button || 'left',
        clicks: intArg(args.clicks, 1, 1, 3),
      });
      // The route is reported because the two behave differently: a pattern click works on an
      // element that is covered or off screen, a mouse click does not. A caller reading "via mouse"
      // knows the click went to a PIXEL, so anything covering the element took it instead.
      return present(r, (x) => {
        if (x.via === 'invoke') return 'Clicked. The control was activated through its own Invoke handler, so a covering window could not have intercepted it.';
        if (x.via === 'select') return 'Selected the item (the control activates by being selected rather than by being invoked).';
        return `Clicked at ${x.x},${x.y} with a real mouse event. Take a screenshot if you need to confirm the effect — `
          + 'a mouse click goes to whatever is at that pixel, so an overlapping window would have received it.';
      });
    },
  });

  tool(api, {
    name: 'SetElementText',
    description: 'Put text into a field through the accessibility Value pattern — not by typing.\n\n'
      + 'More reliable than KeyboardType for a text box: it sets the whole value at once, needs no '
      + 'focus, and cannot be interleaved with autocomplete or an input mask. If the element has no '
      + 'Value pattern the result says so; focus it and use KeyboardType instead.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window containing the field.' },
        index: { type: 'number', description: 'Element index from GetUITree or FindElement.' },
        name: { type: 'string', description: 'Element name.' },
        automationId: { type: 'string', description: 'Element automation id.' },
        text: { type: 'string', description: 'The text to set. An empty string clears the field.' },
      },
      required: ['text'],
    },
    async execute(args) {
      if (typeof args.text !== 'string') {
        return `Error: text must be a string (got ${args.text === undefined ? 'nothing' : typeof args.text}).`;
      }
      const r = await platform.call('setElementText', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
        text: args.text,
      });
      return present(r, (x) => {
        const how = x && x.via === 'rangevalue' ? ' through its range value (a slider or spinner)'
          : x && x.via === 'legacy' ? ' through the legacy accessibility bridge'
            : ' through its value pattern';
        return `Set the field${how} to ${JSON.stringify(String(args.text || '')).slice(0, 120)}`;
      });
    },
  });

  tool(api, {
    name: 'SelectElement',
    description: 'Select a list item, menu item, tab or radio button through the SelectionItem pattern.\n\n'
      + 'Selects the item itself rather than clicking where it appears, so it works for an item '
      + 'scrolled out of view, and it cannot miss.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window containing the element.' },
        index: { type: 'number', description: 'Element index.' },
        name: { type: 'string', description: 'Element name.' },
        automationId: { type: 'string', description: 'Element automation id.' },
      },
    },
    async execute(args) {
      const r = await platform.call('selectElement', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
      });
      // A parent hit is worth naming: it means the node that matched was the label INSIDE the item,
      // and the selection applied to the container. That is the normal case in a browser tree.
      return present(r, (x) => (x && String(x.via).startsWith('parent')
        ? `Selected — the matching element was a child; the item ${String(x.via).replace('parent+', '')} level(s) above it was selected.`
        : 'Selected.'));
    },
  });

  tool(api, {
    name: 'ExpandCollapse',
    description: 'Expand or collapse a tree node, menu, or combo box.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window containing the element.' },
        index: { type: 'number', description: 'Element index.' },
        name: { type: 'string', description: 'Element name.' },
        automationId: { type: 'string', description: 'Element automation id.' },
        expand: { type: 'boolean', description: 'True to expand (default), false to collapse.' },
      },
    },
    async execute(args) {
      const expand = args.expand !== false;
      const r = await platform.call('expandCollapse', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
        expand,
      });
      return present(r, () => (expand ? 'Expanded.' : 'Collapsed.'));
    },
  });

  tool(api, {
    name: 'ScrollIntoView',
    description: 'Scroll a container so that a particular element is visible.\n\n'
      + 'Use it when an element reports a 0x0 rectangle — that means it is off screen or not yet '
      + 'realised, and clicking it would fail.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window containing the element.' },
        index: { type: 'number', description: 'Element index.' },
        name: { type: 'string', description: 'Element name.' },
        automationId: { type: 'string', description: 'Element automation id.' },
      },
    },
    async execute(args) {
      const r = await platform.call('scrollIntoView', {
        hwnd: args.hwnd == null ? null : String(args.hwnd),
        index: args.index == null ? null : intArg(args.index, 0),
        name: args.name,
        automationId: args.automationId,
        walkDepth: intArg(args.walkDepth, 12, 1, 30),
      });
      return present(r, () => 'Scrolled into view.');
    },
  });

  // ---------------------------------------------------------------- reading the screen

  tool(api, {
    name: 'ReadScreenText',
    description: [
      'Read the text visible on screen, with a screen coordinate for each word so you can click it.',
      '',
      'Written for windows that have NO usable control tree: a game, a canvas, or a pane the',
      'application draws itself. Far more specific than Screenshot, because it hands back the actual',
      'words as text rather than a picture you have to read.',
      '',
      'It uses two routes at once, and neither needs the desktop to be visible: the window is captured',
      'with PrintWindow (so a covered, minimised or locked-away window still works), and the pixels go',
      'to the OCR engine built into Windows — nothing to install.',
      '',
      'Coordinates are SCREEN pixels, ready for MouseClick. Prefer ClickElement and GetUITree when the',
      'window has a real control tree: a name is more reliable than recognising a word from a picture.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window to read, from ListWindows.' },
        region: {
          type: 'object',
          description: 'Optional crop within the window: {x, y, width, height}.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
        pattern: { type: 'string', description: 'Only return lines containing this text (case-insensitive).' },
      },
      required: ['hwnd'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const rect = await platform.call('windowRect', h.hwnd);
      if (!rect || rect.error || rect.unsupported) {
        return present(rect || { error: 'could not read the window rectangle' });
      }
      // x/y in the crop are relative to the window, so the origin for OCR is the sum.
      const crop = args.region || {};
      const cx = intArg(crop.x, 0, 0, rect.width - 1);
      const cy = intArg(crop.y, 0, 0, rect.height - 1);
      const cw = intArg(crop.width, rect.width - cx, 1, rect.width - cx);
      const ch = intArg(crop.height, rect.height - cy, 1, rect.height - cy);

      const shot = await platform.call('captureRegion', {
        x: rect.x + cx, y: rect.y + cy, width: cw, height: ch,
      });
      if (shot && shot.error) {
        return `Error: ${shot.error}`
          + '\n(A region read needs a visible desktop. Read the whole window instead — omit `region` —'
          + ' which uses the PrintWindow route and works either way.)';
      }
      if (shot && shot.unsupported) return `Not available on this machine: ${shot.unsupported}`;

      // No scale argument: the backend decides it from the image and reports it back. A caller
      // passing one would be guessing at a number it cannot know.
      //
      // TILING. The engine upscales an image only while it fits under a size limit, and a full screen
      // does not — measured, a 1920x1080 capture came back with ZERO words, while the same text in a
      // 986x1047 window was read correctly. The reason is scale: small text needs the upscale, and a
      // large image never gets one. So a large area is read as several smaller ones, each of which IS
      // upscaled, and the results are stitched back together.
      //
      // 1_500_000 is the threshold the backend uses (`ow * oh <= 1500000`).
      const MAX_PIXELS = 1500000;
      const allWords = [];
      const allLines = [];
      const langs = new Set();
      let totalScale = 0;
      let tiles = 0;
      let lastError = null;

      if (cw * ch <= MAX_PIXELS) {
        const res = await platform.call('ocrImage', shot.path, {
          originX: rect.x + cx, originY: rect.y + cy,
        });
        if (res && res.error) lastError = res.error;
        else if (!res || !res.unsupported) {
          allWords.push(...(res.words || []));
          allLines.push(...(res.lines || []));
          if (res.lang) langs.add(res.lang);
          totalScale += res.scale || 1;
          tiles = 1;
        }
      } else {
        // Split into a grid whose cells each fit the limit, with a small overlap so a word on a
        // boundary is not cut in half and lost from both sides.
        const cols = Math.ceil(Math.sqrt((cw * ch) / MAX_PIXELS));
        const rows = Math.ceil((cw * ch) / MAX_PIXELS / cols);
        const tileW = Math.ceil(cw / cols);
        const tileH = Math.ceil(ch / rows);
        const OVERLAP = 20;
        for (let ty = 0; ty < rows; ty++) {
          for (let tx = 0; tx < cols; tx++) {
            const ox = tx * tileW;
            const oy = ty * tileH;
            const w = Math.min(tileW + OVERLAP, cw - ox);
            const h = Math.min(tileH + OVERLAP, ch - oy);
            if (w <= 0 || h <= 0) continue;
            const piece = await platform.call('captureRegion', {
              x: rect.x + cx + ox, y: rect.y + cy + oy, width: w, height: h,
            });
            if (!piece || piece.error || piece.unsupported) continue;
            const res = await platform.call('ocrImage', piece.path, {
              originX: rect.x + cx + ox, originY: rect.y + cy + oy,
            });
            if (res && res.error) { lastError = res.error; continue; }
            if (!res || res.unsupported) continue;
            allWords.push(...(res.words || []));
            allLines.push(...(res.lines || []));
            if (res.lang) langs.add(res.lang);
            totalScale += res.scale || 1;
            tiles++;
          }
        }
      }

      if (!tiles) {
        return `Error: ${lastError || 'no region could be read'}`;
      }
      if (!allWords.length) {
        return 'No text recognised in that area. The window may show only an image, or the text may be '
          + 'too small — try a tighter `region`, which the engine handles at a better scale.';
      }
      // Deduplicate: the overlap means a word near a seam can be reported twice.
      const seen = new Set();
      const words = allWords.filter((w) => {
        const key = `${w.text}@${w.cx},${w.cy}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const res = {
        words,
        lines: allLines,
        scale: totalScale / tiles,
        // The language the engine reported, taken from the results rather than assumed: hardcoding it
        // would be a lie on a machine whose only OCR pack is a different language.
        lang: langs.size ? [...langs].join('+') : 'unknown',
      };

      const needle = String(args.pattern || '').toLowerCase();
      const lines = needle ? res.lines.filter((l) => l.text.toLowerCase().includes(needle)) : res.lines;
      if (!lines.length) {
        return `No line contained ${JSON.stringify(args.pattern)}. `
          + `${res.lines.length} line(s) were read; drop \`pattern\` to see them all.`;
      }
      // The coordinate of each LINE is the centre of its first word, which is where a click should
      // land — a line has no box of its own in this API.
      const body = lines.map((l) => {
        const first = l.words[0];
        const at = first ? ` @${first.cx},${first.cy}` : '';
        return `${l.text}${at}`;
      }).join('\n');
      return `${lines.length} line(s) read (${res.words.length} word(s), language ${res.lang || 'unknown'}):`
        + `\n${body}\n\nThe @x,y after each line is a clickable SCREEN coordinate.`;
    },
  });

  // ---------------------------------------------------------------- raw input

  tool(api, {
    name: 'MouseMove',
    description: 'Move the pointer to a coordinate.\n\n'
      + 'Only needed when an interface reacts to HOVER (a menu that opens on approach, a tooltip). '
      + 'A click moves the pointer itself, so MouseClick does not need this first.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in virtual-desktop coordinates.' },
        y: { type: 'number', description: 'Y in virtual-desktop coordinates.' },
      },
      required: ['x', 'y'],
    },
    async execute(args) {
      const r = await platform.call('moveTo', intArg(args.x, 0), intArg(args.y, 0));
      return present(r, (p) => `Pointer at ${p.x},${p.y}.`);
    },
  });

  tool(api, {
    name: 'GetCursorPos',
    description: 'Where the pointer is now. Useful for confirming a drag landed where you meant.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('cursorPos');
      return present(r, (p) => `Pointer at ${p.x},${p.y}.`);
    },
  });

  tool(api, {
    name: 'MouseClick',
    description: 'Click at a coordinate, moving the pointer there first.\n\n'
      + 'The fallback for anything without a control tree: a game, a canvas, a remote-desktop view. '
      + 'Read coordinates off a Screenshot with mode region, remembering that a screenshot of a '
      + 'region starts at that region\'s corner, not at the screen\'s.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in virtual-desktop coordinates.' },
        y: { type: 'number', description: 'Y in virtual-desktop coordinates.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which button. Default left.' },
        clicks: { type: 'number', description: '1 for a click, 2 for a double click.' },
      },
      required: ['x', 'y'],
    },
    async execute(args) {
      const r = await platform.call('clickAt', intArg(args.x, 0), intArg(args.y, 0), {
        button: args.button || 'left',
        clicks: intArg(args.clicks, 1, 1, 3),
      });
      return present(r, (p) => `${p.clicks} ${p.button} click(s) at ${p.x},${p.y}.`);
    },
  });
  tool(api, {
    name: 'RightClickMenu',
    description: [
      'Right-click at a point and report the menu that appeared.',
      '',
      'Use this INSTEAD OF MouseClick with button=right when you want to pick an item from the menu.',
      'A context menu is a separate window, not part of the thing clicked, so a bare right click tells',
      'you nothing about what opened — you would have to guess the item names. This finds the menu,',
      'gives you its handle, and reads its items with their indices, so you can then call ClickElement',
      'to choose one.',
      '',
      'If no menu appears the result says so rather than returning nothing: the click may have landed',
      'on something with no context menu, or a hover-preview may have opened instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in virtual-desktop coordinates.' },
        y: { type: 'number', description: 'Y in virtual-desktop coordinates.' },
      },
      required: ['x', 'y'],
    },
    async execute(args) {
      const x = intArg(args.x, 0);
      const y = intArg(args.y, 0);
      const clicked = await platform.call('clickAt', x, y, { button: 'right', clicks: 1 });
      if (clicked && (clicked.error || clicked.unsupported)) return present(clicked);

      // Menus animate open, and the window does not exist until it does.
      await new Promise((r) => setTimeout(r, 650));

      const menu = await platform.call('findMenuWindowNear', x, y);
      if (menu && (menu.error || menu.unsupported)) return present(menu);
      if (!menu || !menu.found) {
        return `Right-clicked at ${x},${y} but no context menu appeared`
          + (menu && menu.candidates ? ` (${menu.candidates} menu window(s) were open, none near the click)` : '')
          + '. The click may have landed somewhere without a menu. Take a screenshot to see the result.';
      }

      // The items, so one can be chosen without another round trip.
      const tree = await platform.call('getTree', { hwnd: menu.hwnd, depth: 8, maxNodes: 200 });
      const items = (!tree || Array.isArray(tree) || tree.error) ? [] : (tree.elements || [])
        .filter((e) => e.name && /MenuItem|Menu/.test(e.controlType));

      let out = `Right-clicked at ${x},${y}. Menu opened: window ${menu.hwnd}, `
        + `${menu.width}x${menu.height} at ${menu.x},${menu.y}.`;
      if (items.length) {
        out += `\n${items.length} item(s):\n` + items
          .map((e) => `  [${e.index}] ${e.controlType} "${e.name}"`)
          .join('\n');
        out += `\n\nChoose one with ClickElement({hwnd: "${menu.hwnd}", index: N}).`;
      } else {
        out += '\nNo readable items were found in it — the menu may draw itself without accessibility '
          + 'support. Take a screenshot to see the items and use MouseClick.';
      }
      return out;
    },
  });

  tool(api, {
    name: 'MouseDrag',
    description: 'Press at one point, move to another, release.\n\n'
      + 'The path is interpolated rather than jumped: a single jump is a teleport, and anything that '
      + 'tracks the pointer while it moves — a sortable list, a slider, a file manager — never sees it.',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: 'Start x.' },
        fromY: { type: 'number', description: 'Start y.' },
        toX: { type: 'number', description: 'End x.' },
        toY: { type: 'number', description: 'End y.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which button. Default left.' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
    async execute(args) {
      const r = await platform.call('drag',
        intArg(args.fromX, 0), intArg(args.fromY, 0), intArg(args.toX, 0), intArg(args.toY, 0),
        { button: args.button || 'left' });
      return present(r, (d) => `Dragged from ${d.from.x},${d.from.y} to ${d.to.x},${d.to.y}.`);
    },
  });

  tool(api, {
    name: 'MouseScroll',
    description: 'Scroll the wheel. Positive dy scrolls up, positive dx scrolls right.\n\n'
      + 'Give x and y to scroll a particular panel rather than whatever is under the pointer.',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: 'Vertical notches; positive is up.' },
        dx: { type: 'number', description: 'Horizontal notches; positive is right.' },
        x: { type: 'number', description: 'Move the pointer here first.' },
        y: { type: 'number', description: 'Move the pointer here first.' },
      },
    },
    async execute(args) {
      const r = await platform.call('scroll', {
        dx: intArg(args.dx, 0, -100, 100),
        dy: intArg(args.dy, 0, -100, 100),
        x: args.x == null ? null : intArg(args.x, 0),
        y: args.y == null ? null : intArg(args.y, 0),
      });
      return present(r, (s) => `Scrolled dx=${s.dx} dy=${s.dy}.`);
    },
  });
  tool(api, {
    name: 'ClipboardWrite',
    description: [
      'Put text on the clipboard.',
      '',
      'The fast, reliable way to enter a long string: copy it, then press the paste chord. Typing a long',
      'text character by character is slow and some applications drop characters when the events arrive',
      'faster than they poll — the same reason typing is chunked here.',
      '',
      'It also preserves what is on the clipboard, so it is the way to move text between two windows.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to put on the clipboard.' } },
      required: ['text'],
    },
    async execute(args) {
      if (typeof args.text !== 'string') {
        return `Error: text must be a string (got ${args.text === undefined ? 'nothing' : typeof args.text}).`;
      }
      const r = await platform.call('copyText', args.text);
      return present(r, (x) => `Copied ${x.length} character(s) to the clipboard.`
        + ' Press the paste chord (ctrl+v on Windows and Linux, cmd+v on macOS) in the target window.');
    },
  });

  tool(api, {
    name: 'ClipboardRead',
    description: 'Read the clipboard as text.\n\n'
      + 'Useful for taking something out of an application that offers no other way to get at it — '
      + 'select all, copy, then read it here.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await platform.call('readClipboard');
      return present(r, (x) => (x.text ? `Clipboard (${x.text.length} character(s)):\n${x.text}`
        : 'The clipboard holds no text.'));
    },
  });

  tool(api, {
    name: 'KeyboardType',
    description: 'Type text as if from the keyboard.\n\n'
      + 'Goes to whatever has focus, so bring the target window forward and click the field first — '
      + 'or use SetElementText, which targets a field directly and needs no focus. For a long string, '
      + 'ClipboardWrite then a paste chord is faster and cannot drop characters.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' },
      },
      required: ['text'],
    },
    async execute(args) {
      // `text` is required, and an empty one is a caller mistake rather than a request to type
      // nothing: `String(undefined)` is the word "undefined", which would be typed into whatever
      // happens to have focus — the worst possible way to report a missing argument.
      if (typeof args.text !== 'string') {
        return `Error: text must be a string (got ${args.text === undefined ? 'nothing' : typeof args.text}).`;
      }
      if (!args.text) return 'Error: text is empty — nothing to type.';
      const r = await platform.call('typeText', args.text);
      return present(r, (t) => `Typed ${t.typed} character(s).`);
    },
  });

  tool(api, {
    name: 'KeyboardKey',
    description: 'Press a key or a chord, e.g. "enter", "tab", "ctrl+s", "alt+tab".\n\n'
      + 'Modifiers are held for the whole chord, which is what makes ctrl+s reach the application as '
      + 'one command rather than as ctrl, then s.',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The key or chord, joined with +.' },
      },
      required: ['keys'],
    },
    async execute(args) {
      // A missing chord is a caller mistake, and the backend THROWS on it — a thrown error escapes
      // the tool and reaches the agent loop as a failed call rather than as a message the model can
      // read and correct. Validated here, and the backend's own throw is caught as a backstop.
      if (typeof args.keys !== 'string' || !args.keys.trim()) {
        return 'Error: keys must be a non-empty string, e.g. "enter", "tab", "ctrl+s".';
      }
      try {
        const r = await platform.call('keyPress', args.keys);
        return present(r, (k) => `Pressed ${k.keys.join('+')}.`);
      } catch (e) {
        return `Error: ${(e && e.message) || String(e)}`;
      }
    },
  });

  // ---------------------------------------------------------------- windows

  tool(api, {
    name: 'WindowFocus',
    description: 'Bring a window to the front. Do this before KeyboardType, which goes to whatever '
      + 'is focused.',
    parameters: {
      type: 'object',
      properties: { hwnd: { type: 'string', description: 'Handle from ListWindows.' } },
      required: ['hwnd'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const r = await platform.call('focusWindow', h.hwnd);
      return present(r, () => `Focused window ${h.hwnd}.`);
    },
  });

  tool(api, {
    name: 'WindowResize',
    description: 'Move and resize a window. Give all four values; none are optional, because a '
      + 'partial move leaves the window in a size you did not choose.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Handle from ListWindows.' },
        x: { type: 'number', description: 'New left edge.' },
        y: { type: 'number', description: 'New top edge.' },
        width: { type: 'number', description: 'New width.' },
        height: { type: 'number', description: 'New height.' },
      },
      required: ['hwnd', 'x', 'y', 'width', 'height'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const r = await platform.call('resizeWindow', h.hwnd, {
        x: intArg(args.x, 0), y: intArg(args.y, 0),
        width: intArg(args.width, 100, 1), height: intArg(args.height, 100, 1),
      });
      return present(r, () => `Window ${h.hwnd} is now ${args.width}x${args.height} at ${args.x},${args.y}.`);
    },
  });

  tool(api, {
    name: 'WindowClose',
    description: 'Ask a window to close, the same way its close button does.\n\n'
      + 'This is a REQUEST: an application with unsaved work will prompt, and the window stays open '
      + 'until that prompt is answered. To force a close, use the application\'s own interface.',
    parameters: {
      type: 'object',
      properties: { hwnd: { type: 'string', description: 'Handle from ListWindows.' } },
      required: ['hwnd'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const r = await platform.call('closeWindow', h.hwnd);
      return present(r, () => `Close requested for window ${h.hwnd}. It may still prompt to save.`);
    },
  });
  tool(api, {
    name: 'GetWindowInfo',
    description: [
      'One window, in detail: title, class, process, rectangle, and whether it is visible, maximized,',
      'minimized or the foreground window.',
      '',
      'Use it when you need the STATE of a window rather than the list of them. `ListWindows` answers "which',
      'windows exist"; it does not say whether the one you found is maximized, and finding it again in that',
      'list to read a title is work this tool has already done.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { hwnd: { type: 'string', description: 'Handle from ListWindows or ListApps.' } },
      required: ['hwnd'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const r = await platform.call('getWindowInfo', h.hwnd);
      return present(r, (w) => {
        const flags = [w.visible ? 'visible' : 'hidden', w.maximized ? 'maximized' : '', w.minimized ? 'minimized' : '',
          w.foreground ? 'foreground' : ''].filter(Boolean).join(', ');
        return [
          `Window ${w.hwnd}`,
          `  title   ${JSON.stringify(w.title || '')}`,
          `  class   ${w.className || '(none)'}`,
          `  pid     ${w.pid == null ? '(unknown)' : w.pid}`,
          `  rect    ${w.width}x${w.height} at ${w.x},${w.y}`,
          `  state   ${flags || '(none)'}`,
        ].join('\n');
      });
    },
  });

  tool(api, {
    name: 'SetWindowState',
    description: [
      'Maximize, minimize, or restore a window.',
      '',
      'PREFER THIS over WindowResize for "make it fill the screen": the application has its own idea of what',
      'maximized means, and a hand-computed rectangle loses the maximize state — so the next restore puts the',
      'window back somewhere arbitrary.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Handle from ListWindows.' },
        state: { type: 'string', enum: ['maximize', 'minimize', 'restore'], description: 'What to do to the window.' },
      },
      required: ['hwnd', 'state'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const state = String(args.state || '').toLowerCase();
      if (!['maximize', 'minimize', 'restore'].includes(state)) {
        return 'Error: state must be maximize, minimize or restore.';
      }
      const r = await platform.call('setWindowState', h.hwnd, state);
      return present(r, (p) => `${p.state || state}: window ${h.hwnd}.`);
    },
  });

  tool(api, {
    name: 'WaitForWindow',
    description: [
      'Wait for a window matching a title or class to appear, or to disappear.',
      '',
      'USE IT AFTER LAUNCHING a program, or after an action that should open a dialog. `WaitForElement`',
      'watches the UI tree of a window that already exists; this waits for the window ITSELF, which is a',
      'different question and one that has no handle to walk yet.',
      '',
      'The wait happens here, not in your turn — polling with ListWindows yourself costs a full reasoning',
      'round per attempt. It returns the matching window, so the next call can use a real handle.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title, case-insensitive.' },
        className: { type: 'string', description: 'Part of the window class, case-insensitive.' },
        hwnd: { type: 'string', description: 'Wait for one specific window instead of matching by name.' },
        state: { type: 'string', enum: ['appear', 'disappear'], description: 'Wait for it to appear (default) or to go away.' },
        timeoutMs: { type: 'number', description: 'Give up after this long. Default 15000.' },
      },
    },
    async execute(args) {
      const r = await platform.call('waitForWindow', {
        title: args.title,
        className: args.className,
        hwnd: args.hwnd == null ? undefined : String(args.hwnd),
        state: args.state || 'appear',
        timeoutMs: intArg(args.timeoutMs, 15000, 100, 300000),
      });
      return present(r, (p) => {
        const w = p.found;
        if (!w) return 'The window is gone.';
        return `${w.hwnd} "${w.title || ''}"${w.width ? ` ${w.width}x${w.height} at ${w.x},${w.y}` : ''}`;
      });
    },
  });

  // ---------------------------------------------------------------- state

  tool(api, {
    name: 'GetAppState',
    description: [
      'Read a window in one call, choosing what to read with `mode`.',
      '',
      'This exists because choosing the right reading tool is where a model goes wrong. Given',
      'screenshots, a control tree and OCR as three separate tools, the natural move is to reach for the',
      'one whose name is most familiar — and a screenshot of a complex window is expensive and often',
      'the wrong read. One tool with an explicit mode turns that choice into a parameter.',
      '',
      '  ax     the control tree: named elements with rectangles and indices. Default, and what you want',
      '         before clicking something — start here almost every time',
      '  text   the readable text on screen, with a coordinate per line. For a window with no usable',
      '         control tree: a game, a canvas, a pane the application draws itself',
      '  image  a screenshot, attached for you to look at. The expensive mode: use it to CHECK a result,',
      '         or when the other two come back empty',
      '  full   all three at once, for when you do not yet know what the window is',
      '',
      'Each section says why it is empty when it is, so an empty control tree is not mistaken for an',
      'empty window.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'string', description: 'Window to read, from ListWindows or ListApps.' },
        mode: { type: 'string', enum: ['ax', 'text', 'image', 'full'], description: 'What to read. Default ax.' },
        depth: { type: 'number', description: 'ax and full: how deep the tree walk goes. Default 12.' },
        maxNodes: { type: 'number', description: 'ax and full: stop after this many elements. Default 400.' },
        pattern: { type: 'string', description: 'text and full: only return lines containing this text.' },
      },
      required: ['hwnd'],
    },
    async execute(args) {
      const h = windowHandle(args.hwnd);
      if (h.error) return `Error: ${h.error}`;
      const mode = ['ax', 'text', 'image', 'full'].includes(args.mode) ? args.mode : 'ax';
      const parts = [];

      if (mode === 'ax' || mode === 'full') {
        const tree = await platform.call('getTree', {
          hwnd: h.hwnd,
          depth: intArg(args.depth, 12, 1, 30),
          maxNodes: intArg(args.maxNodes, mode === 'full' ? 200 : 400, 1, 20000),
        });
        parts.push(`## Control tree\n${presentTree(tree, { hwnd: h.hwnd })}`);
      }

      if (mode === 'text' || mode === 'full') {
        const rect = await platform.call('windowRect', h.hwnd);
        if (!rect || rect.error || rect.unsupported) {
          parts.push(`## Screen text\n${present(rect || { error: 'no window rectangle' })}`);
        } else {
          const shot = await platform.call('captureRegion', {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          });
          if (shot && (shot.error || shot.unsupported)) {
            // A region read needs a visible desktop; say so rather than reporting no text, which
            // would read as "the window is blank".
            parts.push(`## Screen text\n${present(shot)}\n`
              + '(A screen read needs a visible desktop. Read the control tree, or use mode "image", '
              + 'which uses the PrintWindow route and works either way.)');
          } else {
            const res = await platform.call('ocrImage', shot.path, { originX: rect.x, originY: rect.y });
            if (res && (res.error || res.unsupported)) {
              parts.push(`## Screen text\n${present(res)}`);
            } else if (!res || !res.words || !res.words.length) {
              parts.push('## Screen text\nNo text recognised. The window may show only an image, or its '
                + 'text may be too small to read at this size.');
            } else {
              const needle = String(args.pattern || '').toLowerCase();
              const lines = (needle
                ? res.lines.filter((l) => l.text.toLowerCase().includes(needle))
                : res.lines).slice(0, 80);
              parts.push(`## Screen text (${res.words.length} word(s))\n`
                + lines.map((l) => `${l.text}${l.words[0] ? ` @${l.words[0].cx},${l.words[0].cy}` : ''}`).join('\n'));
            }
          }
        }
      }

      if (mode === 'image' || mode === 'full') {
        // PrintWindow, not a screen read: it works with the window covered or the session locked.
        const shot = await platform.call('captureWindow', h.hwnd);
        parts.push(`## Screenshot\n${presentShot(shot, 'Captured')}`);
      }

      return parts.join('\n\n') || 'Nothing was read.';
    },
  });

  // ---------------------------------------------------------------- steps

  tool(api, {
    name: 'Steps',
    description: [
      'Run several computer-use tools in one call, in order.',
      '',
      'Use it for a sequence that only makes sense as a whole: click a field, type into it, press',
      'Enter, wait for the result. One call keeps the intermediate states out of the conversation,',
      'and an early failure stops the rest instead of letting a later step act on a screen that',
      'never reached the expected state.',
      '',
      'Each step is `{ tool, args }`. `tool` is any computer-use tool name, plus `Wait`. A step may',
      'also carry:',
      '  delayMs   wait this long AFTER the step, before the next one',
      '  continueOnError  run the following steps even if this one failed',
      '',
      '`Wait` is available ONLY here, never on its own: `{ tool: "Wait", args: { ms: 500 } }`. Use it',
      'when an action needs a moment to take effect — a menu animating open, a page loading, a dialog',
      'appearing — and prefer it to `delayMs` when you want the pause to be visible as its own step.',
      '',
      'Set `stopOnError: false` on the call to run every step regardless. The result of each step is',
      'reported, so a failure names the step that failed and what it said.',
      '',
      'A screenshot is NOT taken automatically: it would cost tokens on every step. Add an explicit',
      'Screenshot step where you need to see the result — a Screenshot step inside a sequence costs',
      'nothing until you look at it.',
      '',
      'Any image a step captures is listed at the END of the result, separately from the step output,',
      'with the step number that made it. Attach it with ReadMediaFile to actually see it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The steps to run, in order.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'A computer-use tool name, e.g. ClickElement.' },
              args: { type: 'object', description: 'That tool\'s arguments.' },
              delayMs: { type: 'number', description: 'Wait this long after the step.' },
              continueOnError: { type: 'boolean', description: 'Run on even if this step failed.' },
            },
            required: ['tool'],
          },
        },
        stopOnError: { type: 'boolean', description: 'Stop at the first failure. Default true.' },
      },
      required: ['steps'],
    },
    async execute(args, ctx) {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (!steps.length) return 'Error: steps must be a non-empty array of { tool, args }.';
      const stopOnError = args.stopOnError !== false;
      const lines = [];
      /** PNG paths a step produced, kept out of the summary text and listed at the end. */
      const images = [];
      let failed = 0;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] || {};
        const name = String(step.tool || '');
        if (!name) { lines.push(`[${i + 1}] Error: the step has no tool name.`); failed++; if (stopOnError) break; continue; }
        // `Steps` calling `Steps` would nest without limit. One level is enough to express any
        // sequence, and refusing it keeps a malformed call from looping.
        if (name === 'Steps') {
          lines.push(`[${i + 1}] Error: Steps cannot call itself. List the steps inline instead.`);
          failed++;
          if (stopOnError) break;
          continue;
        }

        const out = await runTool(name, step.args, ctx);
        const body = out.text.length > 600 ? `${out.text.slice(0, 600)}\n... (${out.text.length - 600} more characters)` : out.text;
        lines.push(`[${i + 1}] ${name}: ${out.ok && /^Error:/.test(out.text) === false ? 'ok' : 'FAILED'}\n${indent(body)}`);

        // A step that produced a PNG is collected separately, and listed at the end.
        //
        // The path is what the model needs to attach the image, so it is kept — but in a list of its
        // own, because the whole point of running several steps in one call is to keep the
        // intermediate states out of the conversation. A path buried mid-sequence reads as one more
        // line of output, and the model has to notice it and work out that it is a picture to look
        // at. Named at the end, it cannot be missed.
        // The path is found by anchoring on ".png" and walking back to where the path starts.
        //
        // Splitting on whitespace was the obvious approach and is wrong: a Windows user directory
        // routinely contains a space ("C:\Users\John Smith\..."), so the split truncated the path to
        // its last word — a path that looks plausible and does not exist.
        //
        // Walking back stops at a boundary that cannot be inside a path: a quote, a bracket, a
        // newline, or a `: ` pair. That last one is why the colon itself cannot be a boundary — `C:`
        // is part of a Windows path, while the colon in `Screenshot of 60x40 at (0,0): ` is a label.
        // A colon FOLLOWED BY A SPACE is the label; one followed by a character is a drive letter.
        const shot = (() => {
          const at = out.text.indexOf('.png');
          if (at < 0) return null;
          let start = at;
          while (start > 0) {
            const prev = out.text[start - 1];
            if (/["'<>|\n]/.test(prev)) break;
            if (prev === ':' && out.text[start] === ' ') break;
            start--;
          }
          const candidate = out.text.slice(start, at + 4).trim();
          // A bare ".png" with nothing before it is a mention, not a path.
          return candidate.length > 4 ? candidate : null;
        })();
        if (shot) images.push({ step: i + 1, tool: name, path: shot });
        if (shot) images.push({ step: i + 1, tool: name, path: shot });

        if (!out.ok || /^Error:/.test(out.text)) {
          failed++;
          // A step may opt out of stopping, so a sequence can carry on past a failure it expected
          // (a dialog that may or may not appear). The call-wide `stopOnError` is the default.
          if (stopOnError && !step.continueOnError) {
            lines.push(`Stopped: step ${i + 1} failed. ${steps.length - i - 1} step(s) not run.`);
            break;
          }
        }
        const delay = intArg(step.delayMs, 0, 0, 60000);
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }

      const head = failed
        ? `${steps.length} step(s), ${failed} failed:`
        : `${steps.length} step(s), all ok:`;
      // The images last, and explicitly framed: a bare path in a wall of text is easy to miss, and
      // the model has to KNOW these are worth attaching to be able to see the result at all.
      const shots = images.length
        ? `\n\n${images.length} image(s) captured. Attach each with ReadMediaFile to see it:\n`
          + images.map((im) => `  step ${im.step} (${im.tool}): ${im.path}`).join('\n')
        : '';
      return `${head}\n${lines.join('\n')}${shots}`;
    },
  });

  api.log(`hncode cu installed (${TOOLS.length} tools)`);
}

/** Indent a block so a multi-line step result stays readable inside the summary. */
function indent(text) {
  return String(text).split('\n').map((l) => `    ${l}`).join('\n');
}

export default { name: 'hncode-cu', version: '1.0.0' };
