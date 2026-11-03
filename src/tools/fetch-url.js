// FetchURL tool — fetch a web page's main text content (Node built-in fetch, no deps).

import os from 'node:os';
import http from 'node:http';
import https from 'node:https';

const MAX_BYTES = 200 * 1024; // generous cap for large pages

// Strip HTML tags and collapse whitespace into readable plain text.
export function htmlToText(html) {
  let s = String(html || '');
  // Drop script/style contents entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // Replace block-level tags with newlines so paragraphs survive.
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|section|article|blockquote)[^>]*>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|ul|ol)>/gi, '\n');
  // Decode a few common entities to ASCII.
  s = s.replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–');
  // Remove any remaining tags and collapse whitespace.
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return s;
}

// Reject non-http(s) URLs. No SSRF guard: hncode is a local tool the user
// controls, the model may legitimately fetch a localhost service or intranet
// page, and Bash can already run anything. Only enforce http/https.
function rejectUrl(raw) {
  if (!raw || typeof raw !== 'string') return 'Error: url must be a non-empty string.';
  let u;
  try { u = new URL(raw.trim()); } catch { return `Error: invalid URL: ${raw}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `Error: only http/https URLs are supported (got ${u.protocol}//).`;
  }
  return null; // ok
}

/**
 * A browser-ish header set.
 *
 * `Accept` is part of it: a request with a UA but an empty Accept still looks like a script to some
 * servers, and they answer 406 or 429.
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
};

/** How long to wait before retrying a rate-limited request. */
const RETRY_AFTER_MS = 1500;

/**
 * Fetch with the browser headers, retrying a 429 once.
 *
 * One retry after a short pause turns a transient rate limit into a success; a second immediate attempt
 * would only count as another request against the limit.
 */
/**
 * Fetch with the browser headers, retrying a 429 once.
 *
 * `insecure` SKIPS CERTIFICATE VERIFICATION, for a host whose chain is broken — an internal server with a
 * self-signed certificate, an expired intermediate — where the alternative is not fetching it at all.
 *
 * `fetch` has no per-request switch for this: the option lives on the dispatcher, and Node does not expose
 * one without the `undici` package this project does not depend on. So that path goes through
 * `node:https` instead. It is the SAME request — same headers, same redirects, same body cap — just built
 * by hand so `rejectUnauthorized: false` can be passed.
 */
async function fetchWithRetry(url, signal, insecure = false) {
  if (insecure) return httpsRequest(url, signal, true);
  const first = await fetch(url, { signal, redirect: 'follow', headers: HEADERS });
  if (first.status !== 429) return first;
  await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
  // The first response body was never read; release it so the connection can be reused.
  try { await first.body?.cancel(); } catch { /* already gone */ }
  return fetch(url, { signal, redirect: 'follow', headers: HEADERS });
}

/**
 * One GET over `node:https`, returning the shape the caller already handles.
 *
 * Only used for the `insecure` path, where `fetch` cannot express what is needed. The response is
 * buffered up to MAX_BYTES and handed back as an object with `.ok`, `.status`, `.headers.get()` and
 * `.arrayBuffer()`, so the rest of `execute` does not know which transport ran.
 */
function httpsRequest(url, signal, insecure) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      headers: HEADERS,
      // The whole point of this path. Every other request in the tool keeps verification on.
      rejectUnauthorized: !insecure,
    }, (res) => {
      // A redirect is followed rather than reported: `fetch` defaults to `follow`, and a fetch that
      // stopped at a 301 would silently return an empty body for most of the web.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        resolve(httpsRequest(next, signal, insecure));
        return;
      }
      const chunks = [];
      let got = 0;
      res.on('data', (c) => { if (got < MAX_BYTES) { chunks.push(c); got += c.length; } });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: { get: (n) => res.headers[String(n).toLowerCase()] || null },
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          body: null,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('interrupted')), { once: true });
    req.end();
  });
}

export const spec = {
  name: 'FetchURL',
  description: 'Fetch a URL and return its text (main page text, or the full body; a leading note says which). Any http/https URL, including localhost.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch.' },
      insecure: { type: 'boolean', default: false, description: 'Skip TLS certificate verification. For a host with a self-signed or expired certificate whose content is still wanted — the connection is no longer authenticated, so only use it for a source you already trust.' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    const rejected = rejectUrl(args.url);
    if (rejected) return rejected;
    const signal = (ctx && ctx.signal) || undefined;
    try {
      // A BROWSER USER-AGENT, and it is not cosmetic.
      //
      // Without one Node sends `user-agent: node`, and a great many sites answer that with 403 or 429
      // before serving anything. Measured on a wukongsch.com article: 429 with the default headers,
      // served normally with a browser UA.
      const res = await fetchWithRetry(args.url.trim(), signal, args.insecure === true);
      if (!res.ok) {
        // SAY WHAT THE STATUS MEANS. A bare 429 left the caller re-fetching the same page to see the
        // same number.
        const hint = res.status === 429 ? ' — the site is rate-limiting requests; wait and retry, or find another source.'
          : res.status === 403 ? ' — the site refused the request; it may require a login or block automated fetches.'
            : res.status === 404 ? ' — no such page.'
              : '';
        return `Error: ${res.status} ${res.statusText} from ${args.url}${hint}`;
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      let isTruncated = false;
      let body;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        while (got < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (got >= MAX_BYTES) { isTruncated = true; break; }
        }
        if (isTruncated) { try { await reader.cancel(); } catch {} }
        body = Buffer.concat(chunks);
      } else {
        body = Buffer.from(await res.arrayBuffer());
      }

      let text;
      if (isHtml) {
        text = htmlToText(body.toString('utf8'));
      } else if (contentType.includes('json')) {
        text = 'The returned content is the full response body, returned verbatim:\n\n' + body.toString('utf8');
      } else if (contentType.includes('text/')) {
        text = body.toString('utf8');
      } else {
        const type = contentType.split(';')[0] || 'unknown';
        return `The response is binary (content-type: ${type}); no text content to return.`;
      }
      if (!text || !text.trim()) text = 'The response body is empty.';
      let out = isHtml
        ? 'The returned content is the main text extracted from the page.\n\n'
        : 'The returned content is the full response body, returned verbatim.\n\n';
      out += text;
      if (isTruncated) out += `\n\n[... truncated; page larger than ${Math.round(MAX_BYTES / 1024)} KB]`;
      return out;
    } catch (e) {
      // 'fetch failed' IS NOT A REASON. Node puts the real cause — ENOTFOUND, ECONNREFUSED,
      // CERT_HAS_EXPIRED, a TLS handshake failure — on `e.cause`, and only `e.message` was read, so
      // every distinct failure looked identical and told the caller nothing they could act on.
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : '';
      const base = e && e.name === 'AbortError' ? 'interrupted' : (e.message || String(e));
      const msg = cause && !String(base).includes(cause) ? `${base} (${cause})` : base;
      // SAY WHAT TO DO ABOUT A BROKEN CHAIN. `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` means the machine cannot
      // reach the issuer — a corporate proxy, a missing intermediate, a self-signed host — and the page
      // is otherwise fine. The caller cannot act on the code alone, so the switch that does work is named.
      // Any code mentioning a certificate is a chain problem the caller can work around.
      const chain = /CERT|SELF_SIGNED|ISSUER|VERIFY_LEAF|UNABLE_TO_GET/i.test(String(cause) + ' ' + String(base));
      const hint = chain
        ? ' — the certificate chain could not be verified (a missing intermediate, a proxy, or a self-signed'
          + ' host). Retry with insecure: true if the content is still wanted; the connection will not be'
          + ' authenticated.'
        : '';
      return `Error fetching ${args.url}: ${msg}${hint}`;
    }
  },
};
