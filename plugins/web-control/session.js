// The browser session: one connection, its lifecycle, and the two primitives everything else is built on.
//
// This layer owns STATE and nothing else — start, stop, status, and `evaluate`. Navigation, reading and acting are
// in page.js, because they are things you do TO a page rather than things the session knows.
import { connectCdp } from './cdp.js';
import {
  spawnBrowser, waitForPageTarget, freePort, findBrowser, browserHelp, profileDir,
  setConfiguredBrowser, getConfiguredBrowser,
} from './launch.js';

const session = {
  proc: null,
  port: 0,
  cdp: null,
  headless: true,
  profile: '',
};

export {
  findBrowser, browserHelp, profileDir, setConfiguredBrowser, getConfiguredBrowser,
};

export function status() {
  return {
    running: !!(session.proc && session.cdp),
    headless: session.headless,
    port: session.port || null,
    profile: session.profile || null,
  };
}

/** The live CDP connection, or null. */
export function connection() {
  return session.cdp;
}

/**
 * Start the browser if it is not running, and attach to its page.
 *
 * @param {{headless?: boolean, url?: string}} [opts]
 */
export async function start({ headless = true, url = 'about:blank' } = {}) {
  if (session.proc && session.cdp) return { ok: true, ...status() };

  // AWAITED: `freePort` asks the OS for a port that is actually free, which is asynchronous. Without the await
  // the browser was started with `--remote-debugging-port=[object Promise]`.
  const port = await freePort();
  const { proc, error } = spawnBrowser({ port, headless, url });
  if (error) return { ok: false, error };

  proc.on('exit', () => {
    // The browser died. Drop the connection with it, or every later call waits for a reply that cannot come.
    session.proc = null;
    try { session.cdp && session.cdp.close(); } catch { /* gone */ }
    session.cdp = null;
  });

  const { page, error: pageError } = await waitForPageTarget(port);
  if (!page) {
    try { proc.kill(); } catch { /* gone */ }
    return { ok: false, error: `the browser started but ${pageError}` };
  }

  let cdp;
  try {
    cdp = await connectCdp(page.webSocketDebuggerUrl);
  } catch (e) {
    try { proc.kill(); } catch { /* gone */ }
    return { ok: false, error: `could not attach to the page: ${e.message}` };
  }

  session.proc = proc;
  session.port = port;
  session.cdp = cdp;
  session.headless = headless;
  session.profile = profileDir();

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
  } catch { /* older builds answer differently; the calls below still work */ }

  return { ok: true, ...status() };
}

/** Stop the browser and forget the connection. The profile is left on disk, so a login survives. */
export function stop() {
  const had = !!session.proc;
  try { session.cdp && session.cdp.close(); } catch { /* gone */ }
  session.cdp = null;
  if (session.proc) {
    try { session.proc.kill(); } catch { /* gone */ }
    session.proc = null;
  }
  return { ok: true, stopped: had };
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * Throws the PAGE's own error message, because that is the only description of what went wrong that a caller can
 * act on.
 */
export async function evaluate(expression, { awaitPromise = true, timeoutMs = 15000 } = {}) {
  if (!session.cdp) throw new Error('no browser is running — call BrowserOpen first');
  const r = await session.cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    // Some page handlers ignore a click that has no user gesture behind it.
    userGesture: true,
  }, { timeoutMs });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'the page threw');
  }
  return r && r.result ? r.result.value : undefined;
}
