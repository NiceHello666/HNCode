// What you do TO a page: navigate, read it, find what is clickable, click, fill, press.
//
// Each function takes a connection and returns plain data. No state lives here, so anything that has a
// connection can drive a page — including a connection to a browser this plugin did not start.
import { evaluate } from './session.js';

/** Navigate and wait for the document to be usable. */
export async function goto(conn, url, { timeoutMs = 30000 } = {}) {
  await conn.send('Page.navigate', { url }, { timeoutMs });
  // Poll for readyState rather than waiting on an event: the event can fire before this call is listening, and a
  // page that never finishes loading must still settle at the timeout.
  const deadline = Date.now() + Math.min(timeoutMs, 20000);
  while (Date.now() < deadline) {
    try {
      const s = await evaluate('document.readyState', { timeoutMs: 3000 });
      if (s === 'complete' || s === 'interactive') return { ok: true, readyState: s };
    } catch { /* navigation in flight: the context is not there yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: true, readyState: 'timeout' };
}

/**
 * The page's visible text.
 *
 * `innerText` rather than `innerHTML`: the markup of a modern page is mostly class names, and a model reading it
 * learns nothing it can act on. Scripts and styles are already excluded by `innerText` itself.
 */
export async function text({ maxChars = 20000, selector = '' } = {}) {
  const sel = String(selector || '');
  const out = await evaluate(`(() => {
    const root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.body'};
    if (!root) return null;
    return { title: document.title || '', url: location.href, text: root.innerText || '' };
  })()`);
  if (!out) return null;
  const raw = String(out.text || '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: out.title || '',
    url: out.url || '',
    text: raw.length > maxChars ? raw.slice(0, maxChars) + '\n… (truncated)' : raw,
    chars: raw.length,
  };
}

/**
 * Interactable elements, each with a selector that can be recomputed.
 *
 * Returned as a CSS path built from the element's own id or its position among its siblings — NOT as an index into
 * a live NodeList, which goes stale the moment the page re-renders. That is what lets the click that follows
 * address the same element.
 */
export async function interactive({ max = 120 } = {}) {
  return evaluate(`(() => {
    const sel = 'a[href], button, input, select, textarea, [role="button"], [onclick], summary';
    const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    }).slice(0, ${Number(max) || 120});
    const pathOf = (el) => {
      if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && parts.length < 6) {
        let p = n.tagName.toLowerCase();
        const parent = n.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
          if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
        }
        parts.unshift(p);
        n = parent;
      }
      return parts.join(' > ');
    };
    return nodes.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 80),
      name: el.getAttribute('name') || '',
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 120) : '',
      selector: pathOf(el),
    }));
  })()`);
}

/**
 * Act on an element addressed by CSS selector.
 *
 * `fill` sets the value through the NATIVE setter and then fires `input` and `change`. Assigning `.value` alone
 * leaves a React or Vue form thinking the field is still empty, which is why the submit that follows does nothing.
 */
export async function act(selector, action, value) {
  const sel = JSON.stringify(String(selector || ''));
  const val = JSON.stringify(String(value == null ? '' : value));
  return evaluate(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return { ok: false, error: 'no element matches ' + ${sel} };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    ${action === 'click' ? 'el.click();' : ''}
    ${action === 'focus' ? 'el.focus();' : ''}
    ${action === 'fill' ? `
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${val}); else el.value = ${val};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    ` : ''}
    return { ok: true, tag: el.tagName.toLowerCase() };
  })()`);
}

/** Dispatch a key press on an element (or on whatever has focus). */
export async function press(selector, key) {
  const sel = String(selector || '');
  const k = JSON.stringify(String(key || 'Enter'));
  return evaluate(`(() => {
    const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.activeElement'};
    if (!el) return { ok: false, error: 'no element to send the key to' };
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: ${k}, bubbles: true, cancelable: true }));
    }
    return { ok: true };
  })()`);
}
