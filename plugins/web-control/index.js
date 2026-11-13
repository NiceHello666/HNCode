// hncode web-control — drive a real browser over CDP.
//
// This file is TOOL DEFINITIONS ONLY: names, schemas and descriptions, each delegating to one of the layers
// below it. Keeping them apart means a change to how a page is read touches page.js and nothing else.
//
//   cdp.js      the protocol: handshake and framing
//   launch.js   the binary: finding it, its flags, waiting for a page target
//   session.js  the connection: start, stop, status, evaluate
import {
  start, stop, status, connection, evaluate, findBrowser, browserHelp, profileDir,
  setConfiguredBrowser, getConfiguredBrowser,
} from './session.js';
import { goto, text, interactive, act, press } from './page.js';

const nudge = 'Error: no browser is running — call BrowserOpen first.';
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

const TOOLS = [];

function tool(api, s) {
  api.registerTool(s);
  TOOLS.push(s);
}

/** The browser path the user chose, restored from config at startup. */
const CONFIG_PATH_KEY = 'web_control_browser';

/** `/webcontrol` — where the browser is, and whether a session is running. */
async function runCommand(api, raw) {
  const arg = String(raw || '').trim();
  if (!arg) {
    const st = status();
    const found = findBrowser();
    return [
      `Browser: ${getConfiguredBrowser() || '(auto — searching PATH and standard install locations)'}`,
      `Found  : ${found || '(none)'}`,
      found ? '' : browserHelp(),
      '',
      `Session: ${st.running ? `running (${st.headless ? 'headless' : 'headed'}, port ${st.port})` : 'not running'}`,
      `Profile: ${profileDir()}`,
      '',
      'Set the browser with /webcontrol <path>; clear it with /webcontrol auto.',
    ].filter((l) => l !== undefined).join('\n');
  }

  if (/^(auto|default|clear)$/i.test(arg)) {
    setConfiguredBrowser('');
    if (typeof api.persistConfig === 'function') api.persistConfig(CONFIG_PATH_KEY, '');
    return `Browser: auto — will search PATH and the standard install locations.\nFound: ${findBrowser() || '(none)'}`;
  }

  // A path is taken literally: it is what the user chose, and second-guessing it is how a wrong browser runs.
  const ok = setConfiguredBrowser(arg);
  if (typeof api.persistConfig === 'function') api.persistConfig(CONFIG_PATH_KEY, ok);
  const exists = !!findBrowser();
  return exists
    ? `Browser set to ${ok}`
    : `Browser set to ${ok}, but nothing exists at that path. ${browserHelp()}`;
}

export function install(api) {
  // Restore the saved path before any tool can be called.
  if (typeof api.getConfig === 'function') {
    const saved = api.getConfig(CONFIG_PATH_KEY);
    if (saved) setConfiguredBrowser(saved);
  }

  if (typeof api.registerCommand === 'function') {
    api.registerCommand({
      name: 'webcontrol',
      description: 'Show or set the browser used by the Browser* tools',
      argumentHint: '[<path> | auto]',
      run: (raw) => runCommand(api, raw),
    });
  }

  tool(api, {
    name: 'BrowserOpen',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: [
      'Start a controlled browser (Chrome, Chromium or Edge) and attach to its page.',
      '',
      'Everything else here needs it. Calling it again while a browser is already running is a no-op.',
      '',
      'HEADLESS IS THE DEFAULT. Set headless: false when the user has to sign in or watch: the window is real, on',
      'their desktop, and shares the profile — so a login done there carries over to later headless runs.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Run without a visible window. Default true.' },
        url: { type: 'string', description: 'Page to open at once. Omit to start blank.' },
      },
    },
    async execute(args) {
      if (!findBrowser()) return 'Error: no Chrome, Chromium or Edge was found. Set HNCODE_BROWSER to its path.';
      const r = await start({ headless: !(args && args.headless === false), url: (args && args.url) || 'about:blank' });
      if (!r.ok) return `Error: ${r.error}`;
      const st = status();
      const lines = [`Browser ready (${st.headless ? 'headless' : 'headed'}, port ${st.port}).`];
      if (args && args.url) {
        const n = await goto(connection(), String(args.url));
        lines.push(`Opened ${args.url} (${n.readyState}).`);
      } else {
        lines.push('Use BrowserGoto to open a page.');
      }
      return lines.join('\n');
    },
  });

  tool(api, {
    name: 'BrowserClose',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: 'Stop the controlled browser. The profile and its cookies are kept for the next run.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return stop().stopped ? 'Browser stopped.' : 'No browser was running.';
    },
  });

  tool(api, {
    name: 'BrowserGoto',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: [
      'Open a URL and wait for the page to load.',
      '',
      'Answers with the title and the first part of the text, so the next step usually needs no separate read.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open. A bare host gets https:// added.' },
        waitMs: { type: 'number', description: 'Extra settle time after load, for pages that render late.' },
      },
      required: ['url'],
    },
    async execute(args) {
      if (!status().running) return nudge;
      let url = String((args && args.url) || '').trim();
      if (!url) return 'Error: url is required.';
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;

      const extra = Number(args && args.waitMs) > 0 ? Math.min(Number(args.waitMs), 30000) : 0;
      const n = await goto(connection(), url);
      if (extra) await new Promise((r) => setTimeout(r, extra));

      const p = await text({ maxChars: 1200 });
      return [
        `${p.title || '(no title)'} — ${p.url}`,
        `loaded (${n.readyState})`,
        '',
        p.text.slice(0, 900),
        p.chars > 900 ? '\n… use BrowserRead for the rest, or BrowserFind to see what can be clicked.' : '',
      ].filter(Boolean).join('\n');
    },
  });

  tool(api, {
    name: 'BrowserRead',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: [
      'The visible text of the current page.',
      '',
      'Plain text, not HTML: the markup of a modern page is mostly class names. Narrow with a selector when you',
      'know where the content is.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Read only inside this element.' },
        maxChars: { type: 'number', description: 'Truncate after this many characters. Default 20000.' },
      },
    },
    async execute(args) {
      if (!status().running) return nudge;
      const p = await text({
        maxChars: Number(args && args.maxChars) > 0 ? Number(args.maxChars) : 20000,
        selector: (args && args.selector) || '',
      });
      if (!p) return `Error: no element matches ${args.selector}`;
      return `${p.title || '(no title)'} — ${p.url}\n\n${p.text}`;
    },
  });

  tool(api, {
    name: 'BrowserFind',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: [
      'The clickable elements on the page, each with a SELECTOR that BrowserClick and BrowserFill accept.',
      '',
      'Only displayed elements are listed, so a hidden menu does not send you after a selector that cannot be',
      'clicked. Skip this when you already know the selector — it costs a round trip.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Only list elements whose text contains this, case-insensitive.' },
        max: { type: 'number', description: 'How many to list. Default 120.' },
      },
    },
    async execute(args) {
      if (!status().running) return nudge;
      let list = await interactive({ max: Number(args && args.max) > 0 ? Number(args.max) : 120 });
      const needle = String((args && args.text) || '').toLowerCase();
      if (needle) {
        list = list.filter((e) => String(e.text || '').toLowerCase().includes(needle)
          || String(e.name || '').toLowerCase().includes(needle));
      }
      if (!list.length) return needle ? `Nothing on the page matches "${needle}".` : 'Nothing interactive on the page.';
      return list.map((e) => {
        const kind = e.tag + (e.type ? `[${e.type}]` : '');
        const label = e.text ? ` "${e.text}"` : '';
        const ref = e.href ? ` -> ${e.href}` : '';
        return `  ${kind}${label}${ref}\n    ${e.selector}`;
      }).join('\n');
    },
  });

  tool(api, {
    name: 'BrowserClick',
    description: 'Click an element by CSS selector. It is scrolled into view first, so something below the fold is reachable.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, as BrowserFind reports it.' },
        waitMs: { type: 'number', description: 'Settle time after the click, for a page that reacts.' },
      },
      required: ['selector'],
    },
    async execute(args) {
      if (!status().running) return nudge;
      const r = await act(String(args.selector), 'click');
      if (!r || !r.ok) return `Error: ${(r && r.error) || 'the click did not reach an element'}`;
      const wait = Number(args && args.waitMs) > 0 ? Math.min(Number(args.waitMs), 30000) : 0;
      if (wait) await new Promise((res) => setTimeout(res, wait));
      return `Clicked ${r.tag} at ${args.selector}.`;
    },
  });

  tool(api, {
    name: 'BrowserFill',
    description: [
      'Type a value into an input, textarea or select.',
      '',
      'The value is set the way the page expects — native setter, then `input` and `change` events. Assigning',
      '`.value` alone leaves a React or Vue form thinking the field is still empty.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the field.' },
        value: { type: 'string', description: 'The text to put in it.' },
      },
      required: ['selector', 'value'],
    },
    async execute(args) {
      if (!status().running) return nudge;
      const r = await act(String(args.selector), 'fill', args.value);
      if (!r || !r.ok) return `Error: ${(r && r.error) || 'the field was not found'}`;
      return `Filled ${r.tag} at ${args.selector}.`;
    },
  });

  tool(api, {
    name: 'BrowserPress',
    programmatic: true,
    // Reading a local browser reaches nothing the model could not already fetch; clicking and typing do.
    autoApprove: true,
    description: [
      'Send a key press to an element: Enter to submit a search box, Escape to close a dialog, ArrowDown through a',
      'menu. The events are dispatched on the element, so a page listening for `keydown` reacts as it would to a',
      'real key.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Element to send it to. Defaults to whatever has focus.' },
        key: { type: 'string', description: 'Enter, Escape, Tab, ArrowDown, … Default Enter.' },
      },
    },
    async execute(args) {
      if (!status().running) return nudge;
      const r = await press((args && args.selector) || '', (args && args.key) || 'Enter');
      if (!r || !r.ok) return `Error: ${(r && r.error) || 'the key was not delivered'}`;
      return `Sent ${(args && args.key) || 'Enter'}.`;
    },
  });

  tool(api, {
    name: 'BrowserEval',
    description: [
      'Run JavaScript in the page and return the last value.',
      '',
      'The escape hatch for what the other tools do not cover: an attribute, a row count, a table as JSON. Prefer',
      'BrowserRead for text and BrowserFind for elements.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression. The last value is returned.' },
      },
      required: ['expression'],
    },
    async execute(args) {
      if (!status().running) return nudge;
      try {
        const v = await evaluate(String(args.expression));
        return asText(v == null ? '(no value)' : v).slice(0, 20000);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });

  // A browser must not outlive the session it was started for: a headed one is a window left on the desktop, a
  // headless one is an invisible process holding a port.
  if (typeof api.onDispose === 'function') {
    api.onDispose(() => { try { stop(); } catch { /* already gone */ } });
  }
  if (typeof api.log === 'function') api.log(`hncode web-control installed (${TOOLS.length} tools)`);
}

export default { name: 'hncode-web-control', version: '1.0.0' };
