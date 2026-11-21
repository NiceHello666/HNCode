// Local web UI server (/web) — serves the browser client and bridges it to a
// running session through the SessionHub.
//
// Zero dependencies, like the rest of the project: node:http, a hand-written
// router, Server-Sent Events for the server->browser direction and small JSON
// POSTs for the other. SSE rather than WebSockets because the traffic is
// one-directional and heavy (streamed tokens, tool output), it survives proxies,
// and it needs no upgrade handshake or framing code.
//
// AUTH is enforced in ONE place — `handle()` — so a new route cannot accidentally
// ship unauthenticated. The only unauthenticated routes are the login page itself
// and the health check (which reveals nothing but "a server is here").

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newToken, isAuthed, isLoopback, sameOriginOk, safeEqual } from './web-auth.js';
import { t, LANGUAGES, DEFAULT_LANG } from './i18n.js';
// The session directory lives in web-daemon.js (it is the daemon that serves the
// landing page listing every session). The session page needs the SAME list for
// its left rail, so it imports the reader rather than growing a second one.
import { listSavedSessions } from './web-daemon.js';
import { attachWebSocket } from './web-ws.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'web-public');
const COOKIE = 'hncode_web';
const MAX_BODY = 1 << 20;          // 1 MiB — a prompt, not a file upload
const LOGIN_DELAY_MS = 400;        // slows online guessing; costs a human nothing

// Actions a browser may invoke. Shared by the HTTP /api/action handler AND the
// WebSocket command channel, so registering a hub handler is never enough on its
// own to expose it, and neither transport can drift from the other.
const ALLOWED_ACTIONS = [
  // conversation
  'submit', 'dispatch', 'interrupt', 'approve', 'answerPlan', 'answerQuestion', 'stopTask',
  'setMode', 'shell', 'steer', 'editQueued', 'dropQueued',
  // Answering a prompt and moving a command to the background: the browser's Ctrl+G and Ctrl+B.
  'stdinLine', 'detach',
  // files
  'readFile', 'writeFile',
  // session settings
  'setTitle', 'getConfig', 'setConfig',
  // providers and models
  'listProviders', 'addProvider', 'removeProvider', 'discoverModels',
  'listKnownProviders', 'importKnownProvider',
];

/**
 * Pick a language for a server-rendered string. The browser's own choice lives in
 * localStorage (client side), so the server cannot read it; `Accept-Language` is
 * the next best signal and is what a curl client or a direct visit sends. An
 * explicit `?lang=` wins, so a link can pin the language.
 */
function pickLang(req, url) {
  const q = url && url.searchParams.get('lang');
  if (q && LANGUAGES.some((l) => l.id === q)) return q;
  const header = String(req.headers['accept-language'] || '');
  for (const part of header.split(',')) {
    const id = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (LANGUAGES.some((l) => l.id === id)) return id;
  }
  return DEFAULT_LANG;
}

/** Read a static asset from web-public/. Returns null when missing/unsafe. */
function readAsset(urlPath) {
  // Strip the query, decode, and REFUSE anything that escapes the directory.
  // Serving `../src/tui.js` here would hand out the source to an authed client —
  // not catastrophic, but a path traversal is a bug wherever it appears.
  let rel = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
    return { body: fs.readFileSync(full), type: contentType(full), mtime: st.mtimeMs };
  } catch { return null; }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    // The self-hosted faces under web-public/fonts. Without these the browser
    // receives `application/octet-stream` and refuses to apply the font.
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
  })[ext] || 'application/octet-stream';
}

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the web server.
 *
 *   hub        SessionHub — the shared session state
 *   bindIp     string — address to listen on (default 127.0.0.1)
 *   port       number — 0 asks the OS for a free port
 *   token      string — pre-set token (tests); otherwise generated
 *   storeDir   string — session store for /api/sessions (default: the user's)
 *   onNotice   (msg, kind) => void — surface startup info in the TUI transcript
 * @returns {Promise<{server, port, host, url, token, close}>}
 */
export async function startWebServer(opts = {}) {
  const hub = opts.hub;
  if (!hub) throw new Error('startWebServer: hub is required');
  const bindIp = opts.bindIp || '127.0.0.1';
  const token = opts.token || newToken();
  const loopback = isLoopback(bindIp);
  // Hosts we accept in Origin. A non-loopback bind may be reached under any name
  // the client used, so the listen port is matched rather than a fixed hostname.
  let expectedHosts = [];
  const onNotice = typeof opts.onNotice === 'function' ? opts.onNotice : () => {};

const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { json(res, 500, { ok: false, error: (e && e.message) || String(e) }); } catch { /* headers sent */ }
    });
  });

  // Live events over WebSocket (RFC 6455, zero deps). A client that upgrades to
  // /api/ws gets the current snapshot, then every hub event pushed as a JSON
  // line. Auth is checked in onUpgrade (cookie), so an unauthorised handshake is
  // rejected before a connection is made.
  const wsTargets = new Set();
  const wsBroadcast = (obj) => {
    const line = JSON.stringify(obj);
    for (const conn of wsTargets) { try { conn.send(line); } catch { /* closing */ } }
  };
  const wsOff = hub.subscribe(wsBroadcast);
attachWebSocket(server, {
    onUpgrade: (req) => {
      // The browser carries the session cookie (standalone /web), while the
      // daemon reverse-proxy injects `Authorization: Bearer <session token>` —
      // isAuthed reads both, so a handshake through either path is accepted.
      if (!isAuthed(req, token, COOKIE)) return 'unauthorized';
      return null;
    },
    onConnection: (conn) => {
      wsTargets.add(conn);
      conn.send(JSON.stringify({ type: 'snapshot', ...hub.snapshot() }));
      // Bidirectional: a client text frame carries {action, args} and is run
      // through the SAME hub dispatch the HTTP /api/action path uses. This is
      // how the UI sends a message WITHOUT waiting on a blocking HTTP round
      // trip. The handler is run side-by-side (not awaited here) so the socket
      // never stalls on a long action; the result, if the caller wants one,
      // is pushed back as a matching frame below.
      conn.onMessage = (text) => {
        let req;
        try { req = JSON.parse(text); } catch { return; }
        const name = String((req && req.action) || '');
        if (!name) return;
        // Same allowlist as the HTTP path: a hub handler is not exposed just by
        // existing.
        if (!ALLOWED_ACTIONS.includes(name)) {
          try { conn.send(JSON.stringify({ type: 'ack', action: name, ok: false, error: `unknown action: ${name}` })); } catch {}
          return;
        }
        const args = Array.isArray(req && req.args) ? req.args : [];
        Promise.resolve(hub.call(name, ...args))
          .then((r) => {
            try { conn.send(JSON.stringify({ type: 'ack', action: name, ...(r || {}) })); } catch {}
          })
          .catch((err) => {
            try { conn.send(JSON.stringify({ type: 'ack', action: name, ok: false, error: (err && err.message) || String(err) })); } catch {}
          });
      };
    },
    onClose: (conn) => {
      wsTargets.delete(conn);
    },
  });
  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // --- unauthenticated ------------------------------------------------------
    // The login page and its assets must load before a token exists, and the login
    // script imports the message table — so i18n.js is served here too. NONE of
    // these files contain session data: they are the page, its styles, its script
    // and the UI strings.
    if (p === '/login' || p === '/login.html' || p === '/login.css'
        || p === '/login.js' || p === '/i18n.js'
        // The self-hosted faces. Neither file carries session data, and the login
        // page cannot render without them.
        || p === '/fonts.css' || p.startsWith('/fonts/')) {
      const asset = readAsset(p === '/login' ? '/login.html' : p);
      if (!asset) return send(res, 404, t(pickLang(req, url), 'http.notFound'));
      return send(res, 200, asset.body, { 'content-type': asset.type, 'cache-control': 'no-store' });
    }
    // Health check: reveals only that a server exists. Used by the TUI to confirm
    // the bind worked, and by the user to test reachability from another machine.
    if (p === '/healthz') return json(res, 200, { ok: true, service: 'hncode-web' });


    // --- token exchange ------------------------------------------------------
    // POST /api/login { token } -> sets an HttpOnly session cookie. The token is
    // accepted in the BODY, never the query string, so it does not land in the
    // server log or the browser history.
    if (p === '/api/login' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* handled below */ }
      if (!safeEqual(String(body.token || ''), token)) {
        await new Promise((r) => setTimeout(r, LOGIN_DELAY_MS));
        return json(res, 401, { ok: false, error: 'invalid token' });
      }
      const secure = !loopback && String(req.headers['x-forwarded-proto'] || '') === 'https';
      const cookie = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        // Not `Secure` on loopback: the browser would refuse to send it over http
        // and login would appear to succeed then fail on every later request.
        secure ? 'Secure' : '',
        `Max-Age=${60 * 60 * 12}`,
      ].filter(Boolean).join('; ');
      return send(res, 200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': cookie,
      });
    }

    // --- everything below requires the token ---------------------------------
    if (!isAuthed(req, token, COOKIE)) {
      if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: 'unauthorized' });
      // An unauthenticated page request goes to the login form, not a 401 body.
      if (method === 'GET') {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      return send(res, 401, t(pickLang(req, url), 'http.unauthorized'));
    }

    // CSRF: a state-changing request must come from a page we served. Same-origin
    // requests carry a matching Origin; a missing Origin means a non-browser
    // client (curl, a test) that already proved it holds the token.
    if (method !== 'GET' && method !== 'HEAD') {
      const ok = sameOriginOk(req, expectedHosts);
      if (ok === false) return json(res, 403, { ok: false, error: 'cross-origin request refused' });
    }

    // --- API ------------------------------------------------------------------
    if (p === '/api/state') {
      // WHAT TO SEND, decided by the caller.
      //
      // `/api/state` used to answer with one fixed shape: every row, every tool result, the whole
      // transcript. That is what a browser wants and the wrong answer for a script asking "what did the
      // last turn do", which pays for the entire session to read the last few rows.
      //
      //   ?detail=full      every row, tool results included (the default: unchanged behaviour)
      //   ?detail=summary   drop tool RESULTS, keep the "Used Bash (cmd)" rows and the assistant text
      //   ?detail=minimal   assistant and user text only — no tool rows at all
      //   ?turn=last        only the most recent turn (a turn starts at a user message)
      //   ?turn=<n>         only turn n, counting from 1
      //   ?limit=<n>        at most n rows, taken from the end
      //
      // All of them compose, so `/api/state?detail=summary&turn=last` is one request for "what just
      // happened, and with which tools" without the payload of the results themselves.
      const detail = String(url.searchParams.get('detail') || 'full');
      const turn = url.searchParams.get('turn');
      const limit = Number(url.searchParams.get('limit'));
      const snap = hub.snapshot();
      let rows = snap.rows;
      // A turn begins at a user message; splitting on those is what makes "the last turn" mean the same
      // thing here as it does in the transcript.
      if (turn === 'last' || (turn && /^\d+$/.test(turn))) {
        const starts = [];
        rows.forEach((r, idx) => { if (r.role === 'user') starts.push(idx); });
        const which = turn === 'last' ? starts.length - 1 : Number(turn) - 1;
        if (which >= 0 && which < starts.length) {
          const from = starts[which];
          const to = which + 1 < starts.length ? starts[which + 1] : rows.length;
          rows = rows.slice(from, to);
        } else {
          rows = [];   // no such turn: an empty list is the honest answer
        }
      }
      if (detail === 'summary' || detail === 'minimal') {
        // `summary` keeps the tool ROWS but clears their output: the caller wants to know which tools
        // ran, not what they printed. `minimal` drops the rows entirely.
        rows = rows.filter((r) => r.role !== 'tool' || detail === 'summary');
        if (detail === 'summary') {
          rows = rows.map((r) => (r.role === 'tool' ? { ...r, text: '', liveOutput: '', diff: undefined } : r));
        }
      }
      // Any row carrying a `card` is an interactive prompt; those are never trimmed by `minimal`.
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-Math.floor(limit));
      return json(res, 200, { ok: true, ...snap, rows, hidden: snap.totalRows - rows.length, detail, turn: turn || null });
    }

    // The session list for the left rail. `listSavedSessions` already powers the
    // daemon's landing page, so a session page shows the same names in the same
    // order whether it was opened standalone or through the daemon. Entries are
    // metadata only — no transcript — so this stays cheap to poll.
    if (p === '/api/sessions') {
      const saved = listSavedSessions(opts.storeDir);
      // Which row is THIS page. It may not be on disk yet (a brand-new session
      // that has not been saved), so the current id is reported separately
      // instead of being inferred from the list.
      const current = String((hub.snapshot().status || {}).session || '');
      return json(res, 200, { ok: true, current, sessions: saved });
    }


    if (p === '/api/events') return sse(req, res, hub);

    if (p === '/api/action' && method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
        return json(res, 400, { ok: false, error: 'invalid JSON body' });
      }
      const name = String(body.action || '');
      const args = Array.isArray(body.args) ? body.args : [];
      // The security boundary: only these may be invoked from a browser. Kept as
      // an explicit list rather than derived from `hub.actions`, so registering a
      // handler on the hub is never enough on its own to expose it over HTTP.
      const ALLOWED = ALLOWED_ACTIONS;
      if (!ALLOWED.includes(name)) return json(res, 400, { ok: false, error: `unknown action: ${name}` });
      const result = await hub.call(name, ...args);
      return json(res, result.ok ? 200 : 409, result);
    }

    // A standalone /web serves exactly ONE session (this process's). The left
    // rail still links to `/s/<id>/` so the SAME page markup works behind the
    // daemon; standalone those links have no route and 404'd. Redirect them back
    // to the root, which is this session's page.
    if (p.startsWith('/s/')) {
      res.writeHead(302, { location: '/' });
      return res.end();
    }

    // --- static client ---------------------------------------------------------
    if (method === 'GET' || method === 'HEAD') {
      const asset = readAsset(p);
      if (!asset) return send(res, 404, t(pickLang(req, url), 'http.notFound'));
      return send(res, 200, method === 'HEAD' ? '' : asset.body, {
        'content-type': asset.type,
        // The client is a handful of files served from disk; a no-store keeps the
        // browser from running a stale UI against a newer server (the mismatch
        // that makes a UI look broken after an update).
        'cache-control': 'no-store',
      });
    }
    return send(res, 405, t(pickLang(req, url), 'http.badMethod'));
  }

  // --- Server-Sent Events -----------------------------------------------------
  function sse(req, res, hubRef) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Without this a proxy may buffer the whole stream and the UI looks frozen.
      'x-accel-buffering': 'no',
    });
    const write = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closing */ }
    };
    // A late subscriber needs the current view FIRST, then the live stream.
    write({ type: 'snapshot', ...hubRef.snapshot() });
    const off = hubRef.subscribe(write);
    // Comment frames keep the connection alive through idle proxies and let the
    // server notice a dead peer on its own.
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 20000);
    const done = () => { clearInterval(ping); off(); try { res.end(); } catch { /* already gone */ } };
    req.on('close', done);
    req.on('error', done);
  }

  // --- listen -----------------------------------------------------------------
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port == null ? 0 : opts.port, bindIp, () => resolve(server.address().port));
  }).catch((e) => {
    throw new Error(`could not bind ${bindIp}:${opts.port || 0} — ${e.message}`);
  });

  const hostForUrl = bindIp.includes(':') ? `[${bindIp}]` : bindIp;
  const url = `http://${hostForUrl}:${port}/`;
  expectedHosts = [`${bindIp}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
  if (bindIp === '0.0.0.0' || bindIp === '::') expectedHosts.push(`0.0.0.0:${port}`);

return {
    server,
    port,
    host: bindIp,
    url,
    token,
    loopback,
    close() {
      if (typeof wsOff === 'function') { try { wsOff(); } catch { /* best-effort */ } }
      for (const conn of wsTargets) { try { conn.close(); } catch { /* already gone */ } }
      try { server.close(); } catch { /* already closed */ }
    },
  };
}

export { PUBLIC_DIR };
