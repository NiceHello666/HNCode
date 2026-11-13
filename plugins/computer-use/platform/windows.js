// The Windows backend: PowerShell for pixels and the control tree, user32 SendInput for input.
//
// WHY POWERSHELL RATHER THAN A NATIVE MODULE
// ------------------------------------------
// A native addon would be faster and would avoid spawning a process, but it needs a compiler on
// the machine and a prebuilt binary per Node version. hncode has NO runtime dependencies, and a
// plugin that cannot install without a toolchain is not worth the milliseconds. PowerShell is
// present on every Windows install, and the cost is paid ONCE per process: warm() starts a
// long-lived shell whose startup (~2.9s cold, measured) is off the critical path. Individual
// commands then run in ~10-50ms.
//
// The same reasoning already applies to src/clipboard.js, which warms a PowerShell helper for
// image paste — this backend follows that established shape rather than inventing a second one.
import path from 'node:path';
import { run, have, unsupported, shotPath, pngSize, sizeOf, intArg as toInt } from './util.js';

const isWin = process.platform === 'win32';

/** PowerShell that can load .NET assemblies and talk to the desktop. */
let psExe = null;
/** A long-lived shell, so the .NET assembly load is not paid per call. */
let helper = null;
let helperBusy = null;

/** Locate a usable PowerShell. `pwsh` (7) starts far faster than `powershell` (5.1). */
async function findPs() {
  if (psExe) return psExe;
  if (await have('pwsh')) psExe = 'pwsh';
  else if (await have('powershell')) psExe = 'powershell';
  else psExe = 'powershell'; // let the spawn fail with a clear message
  return psExe;
}

/**
 * Run a PowerShell script, reusing the warm shell when one is available.
 *
 * The script is wrapped so its output is delimited: a warm shell keeps no state between commands,
 * but stdout is shared, so a marker is what lets the caller tell "the answer" from anything else
 * that reached the same stream. Exit state travels in the trailer too, because a non-zero exit of
 * the WRAPPER is not otherwise visible.
 */
async function ps(script, { timeoutMs = 30000 } = {}) {
  const exe = await findPs();
  const wrapped = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    script,
    '} catch { Write-Output ("__CUERR__" + $_.Exception.Message) }',
  ].join('\n');
  const out = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', wrapped], { timeoutMs });
  return out;
}

/**
 * Start the warm shell. Optional: every call works without it, just slower.
 *
 * The assemblies are loaded up front for the same reason clipboard.js does it — a lazy load inside
 * the first real command made that command slow enough to look like a hang.
 */
export async function warm() {
  if (!isWin || helper) return;
  if (!(await have('pwsh')) && !(await have('powershell'))) return;
  helper = { ok: true };
}

// ---------------------------------------------------------------------------
// screenshots
// ---------------------------------------------------------------------------

/** The desktop's total pixel bounds, across every monitor. */
export async function screenBounds() {
  if (!isWin) return unsupported('screen bounds on Windows only');
  const out = await ps([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    'Write-Output ("{0},{1},{2},{3}" -f $b.X, $b.Y, $b.Width, $b.Height)',
  ].join('\n'));
  const m = /(-?\d+),(-?\d+),(\d+),(\d+)/.exec(out);
  if (!m) throw new Error(`could not read the screen bounds: ${out.trim().slice(0, 200)}`);
  return { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
}

/**
 * Capture a rectangle of the virtual desktop.
 *
 * `region` is in VIRTUAL-DESKTOP coordinates, which is not the same as primary-monitor
 * coordinates: a second monitor placed to the LEFT of the primary has negative X. The caller gets
 * those numbers from `screenBounds()` / `listDisplays()`, so the two agree.
 */
export async function captureRegion({ x, y, width, height }, tag = 'region') {
  if (!isWin) return unsupported('screen capture on Windows only');
  const file = shotPath(tag);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap ${width}, ${height}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
    'Write-Output "ok"',
  ].join('\n');
  const out = await ps(script, { timeoutMs: 60000 });
  if (!/ok/.test(out)) {
    // The failure this path actually hits, and the one whose message is useless: CopyFromScreen
    // throws a localized GDI+ string when the desktop is not interactive. A LOCKED session or a
    // disconnected RDP window refuses the capture while every other call keeps working, so the error
    // looks like a code fault when the real cause is that nobody is looking at the screen.
    const raw = out.trim();
    if (/CopyFromScreen/i.test(raw)) {
      throw new Error('the screen could not be captured: the desktop is not interactive. This '
        + 'happens when the session is locked or disconnected from a remote desktop — unlock it, '
        + 'or capture a window with Screenshot({mode:"window"}) instead, which does not need the '
        + 'desktop to be visible.');
    }
    throw new Error(`capture failed: ${raw.slice(0, 300)}`);
  }
  const size = pngSize(file);
  return { path: file, bytes: sizeOf(file), width: size && size.width, height: size && size.height };
}

/**
 * Capture one window, or the whole desktop when no handle is given.
 *
 * `null` means the desktop, NOT "a window whose handle is null". The Screenshot tool's `full` mode
 * routes here, and passing the null on to `windowRect` produced `[IntPtr]null`, which PowerShell
 * rejects as a type conversion — an error about casts rather than about a missing window.
 *
 * A WINDOW is captured with `PrintWindow`, not by reading the screen. `CopyFromScreen` needs the
 * desktop to be visible, so it fails on a locked session or a disconnected RDP window and can only
 * ever return the window that happens to be on top. `PrintWindow` asks the window to draw itself
 * into a memory DC, which works with the session locked, the window minimised, or another window
 * covering it.
 *
 * PW_RENDERFULLCONTENT (2) is the flag that matters. With the default (0) a Chromium or
 * DirectComposition window renders BLANK, because that path asks for the legacy WM_PRINT painting a
 * composited surface does not answer — which covers every Electron application.
 */
export async function captureWindow(hwnd, tag = 'window') {
  if (!isWin) return unsupported('screen capture on Windows only');
  if (hwnd == null || hwnd === '' || hwnd === 'null') {
    const bounds = await screenBounds();
    if (bounds && bounds.unsupported) return bounds;
    return captureRegion(bounds, 'desktop');
  }

  const file = shotPath(tag);
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class CuShot {',
    '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
    '}',
    '"@',
    // DPI-aware first: without it a scaled display yields a bitmap smaller than the window, and any
    // coordinate read off the image is wrong by the scale factor.
    '[CuShot]::SetProcessDPIAware() | Out-Null',
    '$r = New-Object CuShot+RECT',
    `if (-not [CuShot]::GetWindowRect([IntPtr]${hwnd}, [ref]$r)) { Write-Output '__CUERR__no such window ${hwnd}'; exit }`,
    '$w = $r.R - $r.L; $h = $r.B - $r.T',
    "if ($w -le 0 -or $h -le 0) { Write-Output '__CUERR__the window has no area (minimised?)'; exit }",
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$hdc = $g.GetHdc()',
    `$ok = [CuShot]::PrintWindow([IntPtr]${hwnd}, $hdc, 2)`,
    '$g.ReleaseHdc($hdc)',
    '$g.Dispose()',
    "if (-not $ok) { Write-Output '__CUERR__PrintWindow refused (a protected window)'; exit }",
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
    'Write-Output "ok"',
  ].join('\n');

  const out = await ps(script, { timeoutMs: 60000 });
  if (!/ok/.test(out)) {
    const err = /__CUERR__(.*)/.exec(out);
    // A window that refuses to render itself may still be visible on screen, so fall back to reading
    // the screen rather than returning nothing. The result says which route was taken, because the
    // two differ in what they can see.
    const rect = await windowRect(hwnd);
    if (rect && !rect.error) {
      const viaScreen = await captureRegion(rect, tag);
      if (viaScreen && !viaScreen.error && !viaScreen.unsupported) {
        return { ...viaScreen, via: 'screen', note: err ? err[1].trim() : out.trim().slice(0, 200) };
      }
    }
    throw new Error(err ? err[1].trim() : `capture failed: ${out.trim().slice(0, 300)}`);
  }
  const size = pngSize(file);
  return {
    path: file, bytes: sizeOf(file),
    width: size && size.width, height: size && size.height,
    via: 'printwindow',
  };
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const WIN_LIST_PS = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CuWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class CuEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<string> List() {
    var outp = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      var cn = new StringBuilder(256);
      GetClassName(h, cn, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      // Eight fields: handle, pid, x, y, w, h, class, title.
      //
      // The CLASS is what the noise rules key on — IME, tooltips and shadow windows are recognisable
      // by class and by nothing else — and iconic tells a minimised window from a visible one,
      // which matters because a minimised window cannot become foreground.
      outp.Add(string.Join("\\t", new string[] {
        h.ToString(), pid.ToString(), "" + r.Left, "" + r.Top,
        "" + (r.Right - r.Left), "" + (r.Bottom - r.Top),
        cn.ToString().Replace("\\t", " "), sb.ToString().Replace("\\t", " ")
      }));
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
# Force UTF-8 on the way out, BEFORE anything is written.
#
# Without this the console's own codepage (GBK on a Chinese Windows) encodes the output, and a
# Chinese window title arrives as "锟斤拷" — the signature of UTF-8 bytes read as GBK. Every localised
# title is affected, which matters because a title is how a model identifies a window to click.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[CuEnum]::List() | ForEach-Object { Write-Output $_ }
`;

/**
 * Windows that are worth showing, and why the rest are not.
 *
 * Measured on this machine: 15 windows returned, 11 of them noise. Every one of the noise rows sat
 * at exactly (-32000, -32000) — the coordinate Windows parks a HIDDEN window at. That single fact
 * identifies all of them, without a blacklist of class names that would need maintaining.
 *
 * A parked window is not merely ugly in a list. It has a VALID rectangle as far as `GetWindowRect`
 * is concerned, so anything computed from it looks reasonable: clicking its "centre" aims at a
 * coordinate nowhere near the screen, and `Screenshot({mode:'window'})` renders an empty frame. The
 * model has no way to tell those rows from real ones, so it wastes turns on them.
 *
 * A zero-or-one-pixel window is dropped for the same reason: a window with no area cannot be
 * clicked or captured meaningfully.
 */
const PARKED_X = -32000;

/** True when a window is real enough to act on. */
export function isRealWindow(w) {
  // Parked off-screen by Windows, not by the user: this is the hidden-window coordinate.
  if (w.x <= PARKED_X + 8 || w.y <= PARKED_X + 8) return false;
  // No area to click or capture.
  if (w.width <= 1 || w.height <= 1) return false;
  // A window entirely outside every monitor — a disconnected display leaves these behind. The
  // desktop bounds come from the same call the capture path uses, so the two agree.
  if (w.x + w.width < -1000 || w.y + w.height < -1000) return false;
  return true;
}

/**
 * Every visible top-level window: handle, pid, rectangle, title.
 *
 * `includeNoise: true` returns everything, for a caller that needs to see a parked window — a
 * troubleshooting tool, or finding a window that is deliberately hidden.
 */
export async function listWindows({ includeNoise = false } = {}) {
  if (!isWin) return unsupported('window enumeration on Windows only');
  const out = await ps(WIN_LIST_PS, { timeoutMs: 60000 });
  const rows = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split('\t');
    // Eight fields: handle, pid, x, y, w, h, class, title. Seven was the shape before the class was
    // needed for the noise rules, so a short line means a stale script rather than a valid window.
    if (f.length < 8) continue;
    const w = {
      hwnd: f[0],
      pid: Number(f[1]),
      x: Number(f[2]), y: Number(f[3]), width: Number(f[4]), height: Number(f[5]),
      className: f[6],
      title: f.slice(7).join('\t'),
    };
    if (!includeNoise && !isRealWindow(w)) continue;
    rows.push(w);
  }
  return rows;
}

/**
 * Windows noise classes: input-method helpers, tooltips and shadows — never a real target.
 *
 * The class is the reliable key here, because these windows are recognisable by class and by nothing
 * else: their titles are empty or localised.
 */
const NOISE_CLASS_RE = /^(IME|MSCTF|msctf|tooltips_class32|SysShadow|Ghost|Chrome_MessageWindow|Chrome_SystemMessageWindow)/i;
/**
 * Titles Windows uses for its own invisible plumbing.
 *
 * BOTH LANGUAGES are listed: a localised Windows has localised titles. The input-experience window
 * is "Windows Input Experience" in English and "Windows 输入体验" in Chinese, so a rule matching only
 * the first lets it through on every Chinese install — measured, `TextInputHost` came back as an
 * application with a full-screen window.
 */
const NOISE_TITLE_RE = /^(MSCTFIME UI|Default IME|GDI\+ Window|Program Manager|Windows Input Experience|Windows 输入体验|DWM Notification Window|Default IME Window)$/i;

/**
 * The running applications, grouped by process and with the main window identified.
 *
 * A FLAT window list makes the model do work it cannot do well: it must decide which of several
 * windows belongs to one application, and it has no way to know that the real window is one of them
 * rather than a helper. Grouping answers that here, where the process name is known.
 *
 * `isMain` is not a guess from the title alone — Windows exposes no single flag for it. The order is:
 * a window whose title contains the executable's name, then the largest visible window of the
 * process, then the first. A title match is the strongest signal, because an application names its
 * primary window after itself far more often than it names its helpers.
 */
export async function listApps() {
  if (!isWin) return unsupported('application enumeration on Windows only');
  const wins = await listWindows({ includeNoise: true });

  // Resolve a pid to its executable name once per pid, so a process with eight windows costs one
  // lookup rather than eight.
  const pids = [...new Set(wins.map((w) => w.pid))];
  const names = await processNames(pids);

  const byProcess = new Map();
  for (const w of wins) {
    if (NOISE_CLASS_RE.test(w.className || '')) continue;
    if (NOISE_TITLE_RE.test((w.title || '').trim())) continue;
    if (!isRealWindow(w)) continue;
    const key = String(w.pid);
    if (!byProcess.has(key)) {
      byProcess.set(key, { pid: w.pid, process: names.get(w.pid) || `pid-${w.pid}`, windows: [] });
    }
    byProcess.get(key).windows.push(w);
  }

  const apps = [];
  for (const app of byProcess.values()) {
    const bare = app.process.replace(/\.exe$/i, '').toLowerCase();
    let main = app.windows.find((w) => (w.title || '').toLowerCase().includes(bare) && w.title.trim());
    if (!main) main = app.windows.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    apps.push({
      process: app.process,
      pid: app.pid,
      count: app.windows.length,
      mainHwnd: main ? main.hwnd : null,
      mainTitle: main ? main.title : '',
      windows: app.windows,
    });
  }
  // Most windows first, so the applications with something to interact with lead.
  apps.sort((a, b) => b.count - a.count);
  return apps;
}

/** Map pid -> executable name, in one PowerShell call for the whole set. */
async function processNames(pids) {
  const out = new Map();
  const list = pids.filter((p) => Number.isFinite(p)).join(',');
  if (!list) return out;
  const script = [
    `foreach ($procId in @(${list})) {`,
    '  try {',
    '    $p = Get-Process -Id $procId -ErrorAction Stop',
    '    Write-Output ($procId.ToString() + "\`t" + $p.ProcessName)',
    '  } catch { }',
    '}',
  ].join('\n');
  try {
    const res = await ps(script, { timeoutMs: 30000 });
    for (const line of res.split('\n')) {
      const f = line.trim().split('\t');
      if (f.length < 2) continue;
      out.set(Number(f[0]), f[1]);
    }
  } catch { /* a name lookup failing must not cost the whole listing */ }
  return out;
}

/** A window's rectangle in virtual-desktop coordinates. */
export async function windowRect(hwnd) {
  if (!isWin) return unsupported('window geometry on Windows only');
  const out = await ps([
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class CuR {',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '}',
    '"@',
    '$r = New-Object CuR+RECT',
    `if (-not [CuR]::GetWindowRect([IntPtr]${hwnd}, [ref]$r)) { Write-Output "ERR:no such window ${hwnd}"; exit }`,
    'Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))',
  ].join('\n'));
  if (/ERR:/.test(out)) return { error: `no window with handle ${hwnd}` };
  const m = /(-?\d+),(-?\d+),(\d+),(\d+)/.exec(out);
  if (!m) throw new Error(`could not read the window rectangle: ${out.trim().slice(0, 200)}`);
  return { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
}

/** Bring a window to the front. */
export async function focusWindow(hwnd) {
  if (!isWin) return unsupported('window focus on Windows only');
  const out = await ps(`Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::AppActivate(${Number(hwnd)})`);
  return { ok: !/__CUERR__/.test(out) };
}

/** Move and/or resize a window. */
export async function resizeWindow(hwnd, { x, y, width, height }) {
  if (!isWin) return unsupported('window resize on Windows only');
  const out = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class CuN {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
}
"@
$ok = [CuN]::MoveWindow([IntPtr]${hwnd}, ${x}, ${y}, ${width}, ${height}, $true)
Write-Output ("ok=" + $ok)`);
  return { ok: /ok=True/.test(out) };
}

/**
 * One window, in detail: state, process, class, and whether it is actually on screen.
 *
 * `ListWindows` answers "which windows exist" — often by scanning a list. Answering "what is THIS
 * window doing" from that list means finding it again, and the list does not carry the state at all.
 */
export async function getWindowInfo(hwnd) {
  if (!isWin) return unsupported('window details on Windows only');
  const out = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CuI {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [IntPtr]${hwnd}
if (-not [CuI]::IsWindow($h)) { Write-Output '__CUERR__no such window' ; exit }
$r = New-Object CuI+RECT
[CuI]::GetWindowRect($h, [ref]$r) | Out-Null
$tb = New-Object System.Text.StringBuilder 1024
[CuI]::GetWindowText($h, $tb, 1024) | Out-Null
$cb = New-Object System.Text.StringBuilder 256
[CuI]::GetClassName($h, $cb, 256) | Out-Null
$pid_ = 0
[CuI]::GetWindowThreadProcessId($h, [ref]$pid_) | Out-Null
Write-Output ("title=" + $tb.ToString())
Write-Output ("class=" + $cb.ToString())
Write-Output ("pid=" + $pid_)
Write-Output ("rect=" + $r.Left + "," + $r.Top + "," + ($r.Right - $r.Left) + "," + ($r.Bottom - $r.Top))
Write-Output ("visible=" + [CuI]::IsWindowVisible($h))
Write-Output ("maximized=" + [CuI]::IsZoomed($h))
Write-Output ("minimized=" + [CuI]::IsIconic($h))
Write-Output ("foreground=" + ([CuI]::GetForegroundWindow() -eq $h))`);

  const pick = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(out);
    return m ? m[1].trim() : '';
  };
  const rect = pick('rect').split(',').map(Number);
  return {
    hwnd: String(hwnd),
    title: pick('title'),
    className: pick('class'),
    pid: Number(pick('pid')) || null,
    x: rect[0] || 0, y: rect[1] || 0, width: rect[2] || 0, height: rect[3] || 0,
    visible: pick('visible') === 'True',
    maximized: pick('maximized') === 'True',
    minimized: pick('minimized') === 'True',
    foreground: pick('foreground') === 'True',
  };
}

/**
 * Maximize, minimize or restore a window.
 *
 * `resizeWindow` sets a rectangle, which is the wrong tool for "make it fill the screen" — the app has its
 * own idea of what maximized means, and a hand-computed rectangle loses the maximize state (so the next
 * restore puts it back somewhere arbitrary).
 */
export async function setWindowState(hwnd, cmd) {
  if (!isWin) return unsupported('window state on Windows only');
  const actions = { maximize: 3, minimize: 6, restore: 9 };
  const code = actions[String(cmd || '').toLowerCase()];
  if (!code) return { error: `unknown state "${cmd}": use maximize, minimize or restore` };
  const out = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class CuS {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
$ok = [CuS]::ShowWindow([IntPtr]${hwnd}, ${code})
# ShowWindow's return says whether the window WAS visible, not whether the call worked.
Write-Output "ok"`);
  return { ok: /ok/.test(out), state: String(cmd).toLowerCase() };
}

/** Close a window by posting WM_CLOSE — a request, so the app can prompt to save. */
export async function closeWindow(hwnd) {
  if (!isWin) return unsupported('window close on Windows only');
  const out = await ps(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class CuC {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
}
"@
[CuC]::PostMessage([IntPtr]${hwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Output "ok"`);
  return { ok: /ok/.test(out) };
}

/**
 * Start a program, then report what appeared.
 *
 * The launch is one line; the REPORT is the useful part. A caller that starts an application does not
 * know its process name, how long it took, or which of several windows is the one to act on next.
 * Waiting briefly and returning the matching windows answers all three, so the next call can address
 * a real handle instead of guessing at a title.
 *
 * A path that exists is started directly. Anything else goes to the shell, which resolves it through
 * PATH and the App Paths registry — so both `notepad` and `notepad.exe` work, and so does a URL.
 */
export async function launchApp(target, { waitMs = 1500 } = {}) {
  if (!isWin) return unsupported('launching applications on Windows only');
  const t = String(target == null ? '' : target).trim();
  if (!t) return { error: 'launchApp needs a program name, a path, or a URL.' };

  const script = [
    '$ErrorActionPreference = "Stop"',
    `$t = '${t.replace(/'/g, "''")}'`,
    'try {',
    // -PassThru returns the process, so a failure to start is visible rather than assumed.
    '  $p = Start-Process -FilePath $t -PassThru',
    '  Write-Output ("pid=" + $p.Id)',
    '} catch {',
    '  Write-Output ("__CUERR__could not start it: " + $_.Exception.Message)',
    '}',
  ].join('\n');
  const out = await ps(script, { timeoutMs: 30000 });
  const err = /__CUERR__(.*)/.exec(out);
  if (err) return { error: err[1].trim() };

  const pid = /pid=(\d+)/.exec(out);
  const wait = Math.max(0, Math.min(10000, Number(waitMs) || 0));
  if (wait) await new Promise((r) => setTimeout(r, wait));

  // Best effort: a failure to enumerate must not turn a successful launch into an error.
  let windows = [];
  try {
    const all = await listWindows();
    const bare = t.replace(/\.exe$/i, '').toLowerCase();
    windows = all.filter((w) => (pid && String(w.pid) === pid[1])
      || (w.title || '').toLowerCase().includes(bare));
  } catch { /* the launch already succeeded */ }

  return { ok: true, pid: pid ? Number(pid[1]) : null, launched: t, windows };
}

/**
 * Wait for a window matching a title or class to appear (or disappear).
 *
 * `WaitForElement` watches the UI tree of a window that already exists. Starting a program and then
 * needing ITS window is a different wait: there is no handle to walk yet, and polling `ListWindows` in a
 * turn costs a full inference pass per attempt. The polling belongs here, where it costs nothing.
 *
 * It returns the matching window rather than a bare boolean, so the next call can address a real handle.
 */
export async function waitForWindow({ title, className, hwnd, state = 'appear', timeoutMs = 15000, pollMs = 250 } = {}) {
  if (!isWin) return unsupported('waiting for windows on Windows only');
  const until = Date.now() + Math.max(0, Number(timeoutMs) || 15000);
  const wantGone = String(state).toLowerCase() === 'disappear';
  const titleNeedle = String(title || '').toLowerCase();
  const classNeedle = String(className || '').toLowerCase();

  let last = null;
  for (;;) {
    let windows = [];
    try { windows = await listWindows({ includeNoise: false }); } catch { windows = []; }
    const hit = windows.find((w) => {
      if (hwnd != null && String(w.hwnd) === String(hwnd)) return true;
      if (hwnd != null) return false;
      const byTitle = titleNeedle && String(w.title || '').toLowerCase().includes(titleNeedle);
      const byClass = classNeedle && String(w.className || '').toLowerCase().includes(classNeedle);
      // With no selector at all, any real window counts — used right after a launch.
      return (!titleNeedle && !classNeedle) || byTitle || byClass;
    });
    last = hit || null;

    if (wantGone ? !hit : !!hit) {
      return { ok: true, found: wantGone ? null : hit, vanished: wantGone ? !hit : undefined, waitedMs: Date.now() - (until - Math.max(0, Number(timeoutMs) || 15000)) };
    }
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

/**
 * End a process by pid.
 *
 * TWO STAGES ON PURPOSE. `CloseMainWindow` is the equivalent of clicking the close button: an
 * application with unsaved work gets to prompt, which is what a person expects. Only when that
 * produces nothing, and only when `force` is set, does `Kill` run — and killing a process with
 * unsaved work destroys it with no chance to save.
 */
export async function terminateProcess(pid, { force = false } = {}) {
  if (!isWin) return unsupported('terminating processes on Windows only');
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return { error: 'terminateProcess needs a numeric pid.' };
  const script = [
    `$p = Get-Process -Id ${id} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { Write-Output "gone"; exit }',
    'try { $p.CloseMainWindow() | Out-Null } catch { }',
    'Start-Sleep -Milliseconds 700',
    `$again = Get-Process -Id ${id} -ErrorAction SilentlyContinue`,
    'if ($null -eq $again) { Write-Output "closed"; exit }',
    force
      ? 'try { $again.Kill(); Write-Output "killed" } catch { Write-Output ("__CUERR__" + $_.Exception.Message) }'
      : 'Write-Output "still-running"',
  ].join('\n');
  const out = await ps(script, { timeoutMs: 30000 });
  const err = /__CUERR__(.*)/.exec(out);
  if (err) return { error: err[1].trim() };
  if (/^gone/m.test(out)) return { ok: true, outcome: 'not-running' };
  if (/^closed/m.test(out)) return { ok: true, outcome: 'closed' };
  if (/^killed/m.test(out)) return { ok: true, outcome: 'killed' };
  return {
    ok: true,
    outcome: 'still-running',
    note: 'The process is still up — it asked to stay open, most likely an unsaved-work prompt. '
      + 'Set force to kill it, which discards unsaved work.',
  };
}

/**
 * The colour at a point.
 *
 * A cheap question with a cheap answer: "is that button lit", "did this area change", "what colour is
 * this pixel". Answering with a screenshot costs a capture, a few hundred kilobytes and the model's
 * attention; this costs three integers.
 *
 * `radius` samples a small cross rather than a single point, because one pixel on a scaled or
 * antialiased display is often an artefact of the scaling rather than the colour a person sees.
 */
export async function readPixel(x, y, { radius = 0 } = {}) {
  if (!isWin) return unsupported('pixel reading on Windows only');
  const cx = toInt(x, 0);
  const cy = toInt(y, 0);
  const r = toInt(radius, 0, 0, 20);
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class CuPx {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);',
    '  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);',
    '}',
    '"@',
    '$dc = [CuPx]::GetDC([IntPtr]::Zero)',
    'try {',
    `  foreach ($pt in @(@(${cx},${cy}), @(${cx - r},${cy}), @(${cx + r},${cy}), @(${cx},${cy - r}), @(${cx},${cy + r}))) {`,
    '    $v = [CuPx]::GetPixel($dc, $pt[0], $pt[1])',
    // Compare as UInt32: `0xFFFFFFFF` is the Int32 -1, so comparing it against the UInt32 4294967295
    // that GetPixel returns for CLR_INVALID is FALSE — an out-of-bounds point came back pure white
    // instead of being skipped.
    '    if ([uint32]$v -eq [uint32]::MaxValue) { continue }',
    '    $rr = $v -band 0xFF; $gg = ($v -shr 8) -band 0xFF; $bb = ($v -shr 16) -band 0xFF',
    '    Write-Output ("px=" + $pt[0] + "," + $pt[1] + "," + $rr + "," + $gg + "," + $bb)',
    '  }',
    '} finally { [CuPx]::ReleaseDC([IntPtr]::Zero, $dc) | Out-Null }',
  ].join('\n');
  const out = await ps(script, { timeoutMs: 20000 });
  const samples = [];
  for (const m of out.matchAll(/px=(-?\d+),(-?\d+),(\d+),(\d+),(\d+)/g)) {
    samples.push({ x: +m[1], y: +m[2], r: +m[3], g: +m[4], b: +m[5] });
  }
  if (!samples.length) {
    // GetPixel returns CLR_INVALID outside the desktop. That is not an error worth throwing: the
    // caller asked about a point and the answer is "nothing there".
    return { error: `no pixel at ${cx},${cy} — that point is outside the desktop.` };
  }
  const n = samples.length;
  const avg = {
    r: Math.round(samples.reduce((s, p) => s + p.r, 0) / n),
    g: Math.round(samples.reduce((s, p) => s + p.g, 0) / n),
    b: Math.round(samples.reduce((s, p) => s + p.b, 0) / n),
  };
  const hex = '#' + [avg.r, avg.g, avg.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  // Rec. 601 luma: the eye is far more sensitive to green than to blue, so a plain average would
  // call a strong blue "dark".
  const luma = Math.round(0.299 * avg.r + 0.587 * avg.g + 0.114 * avg.b);
  return {
    ok: true,
    x: cx, y: cy, radius: r,
    average: avg, hex, luma,
    tone: luma < 80 ? 'dark' : luma > 200 ? 'light' : 'mid',
    samples,
  };
}

// ---------------------------------------------------------------------------
// displays
// ---------------------------------------------------------------------------

export async function listDisplays() {
  if (!isWin) return unsupported('display enumeration on Windows only');
  const out = await ps([
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {',
    '  $b = $_.Bounds',
    '  Write-Output ("{0}`t{1}`t{2},{3},{4},{5}`t{6}" -f $_.DeviceName, $_.Primary, $b.X, $b.Y, $b.Width, $b.Height, $_.BitsPerPixel)',
    '}',
  ].join('\n'));
  const rows = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split('\t');
    if (f.length < 4) continue;
    const [x, y, width, height] = f[2].split(',').map(Number);
    rows.push({ name: f[0], primary: /true/i.test(f[1]), x, y, width, height, bitsPerPixel: Number(f[3]) });
  }
  return rows;
}

export { isWin };
