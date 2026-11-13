// A Chrome DevTools Protocol client — no dependency.
//
// WHY NOT `puppeteer` / `chrome-remote-interface`: this project has no runtime dependencies, and the two pieces
// that a library would bring are the upgrade handshake (a few headers and a SHA-1) and the WebSocket framing,
// which `src/web-ws.js` already implements. What is genuinely CDP-specific is the request/reply bookkeeping,
// and that is the smaller half.
//
// WHAT THIS IS NOT: a page-object model. It sends commands and returns their results. Choosing selectors, waiting
// for load and shaping the answer for a model belongs to the caller (src/browser.js).
import net from 'node:net';
import crypto from 'node:crypto';

const MAX_FRAME = 64 * 1024 * 1024;

/**
 * Open a WebSocket to a CDP target and hand back `{ send, close }`.
 *
 * @param {string} wsUrl A `ws://host:port/devtools/page/…` URL from `/json/list`.
 * @param {{timeoutMs?: number}} [opts]
 */
export function connectCdp(wsUrl, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(wsUrl); } catch { reject(new Error(`not a ws url: ${wsUrl}`)); return; }

    const sock = net.connect(Number(u.port || 80), u.hostname);
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const pending = new Map();
    let seq = 0;
    const listeners = new Set();

    const fail = (err) => {
      if (closed) return;
      closed = true;
      try { sock.destroy(); } catch { /* gone */ }
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('CDP handshake timed out')), timeoutMs);
    if (timer.unref) timer.unref();

    /** One masked client frame. */
    const encode = (text) => {
      const payload = Buffer.from(text, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      return Buffer.concat([header, mask, masked]);
    };

    /** Pull one complete frame out of `buf`, or null when more bytes are needed. */
    const decode = () => {
      if (buf.length < 2) return null;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) throw new Error(`frame too large: ${len}`);
      let mask = null;
      if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return null;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      return { fin, opcode, payload };
    };

    let text = '';
    const dispatch = (msg) => {
      // A CDP message is `{id, result|error}` for a reply, or `{method, params}` for an event.
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of listeners) { try { fn(msg); } catch { /* a listener must not break the socket */ } }
    };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString('latin1');
        buf = buf.subarray(i + 4);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101/.test(head)) { fail(new Error(`upgrade refused: ${head.split('\r\n')[0]}`)); return; }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (!accept || accept[1] !== expected) { fail(new Error('bad Sec-WebSocket-Accept')); return; }
        upgraded = true;
        resolve({
          send,
          close,
          onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        });
        return;
      }
      for (;;) {
        let f;
        try { f = decode(); } catch (e) { fail(e); return; }
        if (!f) return;
        if (f.opcode === 0x8) { close(); return; }
        if (f.opcode === 0x9) { sock.write(Buffer.from([0x8a, 0x80])); continue; }   // ping -> empty pong
        if (f.opcode === 0x0 || f.opcode === 0x1) text += f.payload.toString('utf8');
        if (!f.fin) continue;
        const whole = text;
        text = '';
        try { dispatch(JSON.parse(whole)); } catch { /* not JSON: ignore */ }
      }
    });

    sock.on('error', (e) => fail(e));
    sock.on('close', () => {
      if (closed) return;
      closed = true;
      for (const [, p] of pending) p.reject(new Error('CDP connection closed'));
      pending.clear();
      if (!upgraded) reject(new Error('CDP connection closed during handshake'));
    });

    /** Send a command and wait for its reply. */
    function send(method, params, { timeoutMs: cmdTimeout = 30000 } = {}) {
      return new Promise((res, rej) => {
        if (closed) { rej(new Error('CDP connection is closed')); return; }
        const id = ++seq;
        const t = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} timed out after ${cmdTimeout}ms`));
        }, cmdTimeout);
        if (t.unref) t.unref();
        pending.set(id, {
          resolve: (v) => { clearTimeout(t); res(v); },
          reject: (e) => { clearTimeout(t); rej(e); },
        });
        try { sock.write(encode(JSON.stringify({ id, method, params }))); } catch (e) {
          pending.delete(id);
          clearTimeout(t);
          rej(e);
        }
      });
    }

    function close() {
      if (closed) return;
      closed = true;
      try { sock.write(Buffer.from([0x88, 0x80])); } catch { /* already gone */ }
      try { sock.destroy(); } catch { /* gone */ }
      for (const [, p] of pending) p.reject(new Error('CDP connection closed'));
      pending.clear();
    }

    sock.write([
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n'));
  });
}
