// Where the browser binary is, and how to start one.
//
// The only file that knows about executables, command-line flags and ports. Everything above it works with a
// connection, so swapping Chrome for a remote endpoint — or for a different browser — touches this file alone.
//
// LOOKUP ORDER: the path the user set with /webcontrol, then HNCODE_BROWSER, then a guess at where a normal
// install puts it. The guess is last on purpose: it is the one that can be wrong, and it must never override a
// choice the user made.
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

/** Set by /webcontrol. The launcher asks for it rather than reaching into plugin state. */
let configuredPath = '';

/** Remember the path the user chose. An empty value clears it. */
export function setConfiguredBrowser(p) {
  configuredPath = String(p == null ? '' : p).trim();
  return configuredPath;
}

/** The path the user chose, if any. */
export function getConfiguredBrowser() {
  return configuredPath;
}

const onPath = (name) => {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.existsSync(full)) return full; } catch { /* unreadable */ }
    }
  }
  return '';
};

/**
 * Where a normal install puts the browser.
 *
 * Absolute install locations only, and nothing machine-specific: this list is a convenience, not a requirement.
 * A user whose browser lives elsewhere sets it once with /webcontrol and the list is never consulted.
 */
function guessBrowser() {
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const rel of ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe',
        'Microsoft/Edge/Application/msedge.exe']) {
        const full = path.join(base, rel);
        try { if (fs.existsSync(full)) return full; } catch { /* unreadable */ }
      }
    }
    return '';
  }
  if (process.platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { return fs.existsSync(mac) ? mac : ''; } catch { return ''; }
  }
  return onPath('google-chrome') || onPath('chromium') || onPath('chromium-browser')
    || onPath('microsoft-edge') || onPath('chrome');
}

/**
 * The browser to run, or ''.
 *
 * Order: what the user configured, then the environment override, then a PATH lookup, then a guess. A configured
 * path that no longer exists is reported rather than silently skipped — falling back would run a different
 * browser than the one chosen, which is worse than saying it is missing.
 */
export function findBrowser() {
  if (configuredPath) {
    try { return fs.existsSync(configuredPath) ? configuredPath : ''; } catch { return ''; }
  }
  const env = String(process.env.HNCODE_BROWSER || '').trim();
  if (env) { try { return fs.existsSync(env) ? env : ''; } catch { return ''; } }

  const fromPath = onPath('chrome') || onPath('google-chrome') || onPath('chromium')
    || onPath('chromium-browser') || onPath('msedge') || onPath('microsoft-edge');
  return fromPath || guessBrowser();
}

/** Why `findBrowser` returned nothing, in a form a user can act on. */
export function browserHelp() {
  if (configuredPath) return `The browser set by /webcontrol does not exist: ${configuredPath}`;
  if (process.env.HNCODE_BROWSER) return `HNCODE_BROWSER points at something that does not exist: ${process.env.HNCODE_BROWSER}`;
  return 'No Chrome, Chromium or Edge was found. Set the path once with /webcontrol <path>, or set HNCODE_BROWSER.';
}

/** A dedicated profile. Never the user's own: that would close their tabs and share their cookies. */
export function profileDir() {
  return path.join(os.homedir(), '.hncode', 'browser-profile');
}

/**
 * The browser's command line.
 *
 * NO URL IS PASSED for the default. Passing `about:blank` produced a browser with no page target at all on this
 * build; starting with none gives the usual new-tab page, which is what `/json/list` reports.
 */
export function launchArgs({ port, headless, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    // A stable window size, so a headed run and a headless run lay the page out the same way.
    '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new');
  if (url && url !== 'about:blank') args.push(url);
  return args;
}

/** Start the process. Returns `{ proc }` or `{ error }`. */
export function spawnBrowser(opts) {
  const exe = findBrowser();
  if (!exe) return { error: browserHelp() };
  try {
    fs.mkdirSync(profileDir(), { recursive: true });
  } catch { /* exists, or unwritable — the spawn below reports it */ }
  try {
    const proc = cp.spawn(exe, launchArgs(opts), { stdio: 'ignore', windowsHide: true, detached: false });
    return { proc, exe };
  } catch (e) {
    return { error: `could not start ${exe}: ${e.message}` };
  }
}

/** GET a JSON endpoint from the debugging port. */
export function httpJson(port, endpoint, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: endpoint }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Wait until a page target exists, and return it.
 *
 * The port answering is not the same as a page being ready: the socket accepts before `/json/list` has anything
 * in it.
 */
export async function waitForPageTarget(port, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no page target appeared';
  while (Date.now() < deadline) {
    try {
      const list = await httpJson(port, '/json/list');
      const page = Array.isArray(list) ? list.find((t) => t.type === 'page') : null;
      if (page && page.webSocketDebuggerUrl) return { page };
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { error: lastError };
}

/**
 * A port nothing is listening on.
 *
 * A RANDOM NUMBER IS NOT A FREE PORT. Picking one and hoping meant that when something else already answered
 * there — another tool, or a browser left from a previous run — the launcher connected to IT, and the failure
 * surfaced as a JSON parse error far from the cause.
 *
 * The port is asked for from the OS and then released, which is the closest a plain socket gets to a
 * reservation: it is free when the browser claims it a moment later.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
