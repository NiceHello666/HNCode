  // Terminal capability probing — ASK the terminal instead of guessing.
//
  // WHY THIS EXISTS
  // ---------------
  // Everything this app does that is terminal-specific used to be either unconditional
  // or env-var-gated. Three of those were guesses with real consequences:
//
  //   * `ESC[?2026h/l` (synchronized output) was wrapped around EVERY diff write. A
  //     terminal that does not implement it is supposed to ignore the private mode,
  //     but "supposed to" is doing a lot of work for two sequences per frame.
  //   * the Kitty keyboard protocol was turned ON by default with only
  //     `HNCODE_NO_KITTY_KEYS=1` to undo it, and the code's own comment admitted why
  //     that is a gamble: a terminal that does not implement `>1u` "reacts badly
  //     (dropped/mangled input)". That is a wrong-guess-causes-a-broken-keyboard bug.
  //   * the theme was forced to `dark`, whose normal text is WHITE, while the frame
  //     pads its rows with PLAIN SPACES — no background is ever painted. On a terminal
  //     with a light background that is white text on white: the transcript is
  //     invisible. Nothing in the process could tell, because nothing asked.
//
  // So this module asks. The protocol is the standard one, and it is worth spelling out
  // because it is why this needs no timeout-based guessing:
//
  //   Terminals process input sequentially and answer queries IN ORDER. So the batch
  //   ends with a Device Attributes request (`ESC[c`) — the one query every terminal
  //   answers — and its reply doubles as the end-of-batch sentinel: everything asked
  //   before it has been answered by the time it arrives. No per-query timeout, no
  //   waiting for absent replies.
//
  // A response arrives on the SAME stream as keystrokes, so whoever reads stdin while
  // the probe runs must route it here instead of into the key parser. `probeTerminal`
  // owns stdin for that window and hands back anything it could not consume, so a key
  // pressed during the probe is still delivered.
//
  // The whole thing is best-effort: an unanswered query leaves its field `null`, which
  // every consumer reads as "no information", never as "not supported".

/** How long to wait for the answers. Real terminals reply in ~1ms; this only bites
 *  on a terminal that answers nothing at all, where it is the price of not guessing. */
export const PROBE_TIMEOUT_MS = 250;

/** The batch, in the order it is written. DA1 is LAST — it is the sentinel.
 *    OSC 11 `?`          — report the background colour
 *    CSI ? u             — report the Kitty KEYBOARD protocol flags
 *    CSI ? 2026$p        — report whether synchronized output is known
 *    ESC _G ... ESC\    — query the Kitty GRAPHICS protocol: does it exist, and does it
 *                            accept the transmission format we would send
 *    CSI 16 t            — the pixel size of ONE CELL (XTWINOPS 16)
 *    CSI 14 t            — the pixel size of the TEXT AREA (XTWINOPS 14), a cross-check
 *                            for the cell size on a terminal that answers only that
 *    CSI c               — Device Attributes: the sentinel, and the VT level
 *
 *  Both query forms were wrong before, and both mattered only for images.
 *
 *  The graphics query is its own APC, not a `CSI ? u` variant — an earlier guess collided
 *  with the keyboard probe, and since an unanswered query is inferred as "not supported"
 *  once the sentinel arrives, that switched images OFF on the terminals that have them.
 *  It carries a REAL payload: one transparent RGBA pixel, RFC 1950 zlib, direct data
 *  (f=32, o=z) — the same path the renderer uploads on. A probe that asks about formats we
 *  would not send reports on a format we would not send. (dsh-TUI's terminal-querier.ts
 *  sends exactly this, with the same base64.)
 *
 *  The CELL size is XTWINOPS **16**, not 14: 14 is the text area. The reply to both is
 *  `CSI 6 ; w ; h t` — opcode 6 for the cell — so the parser matches on the REPORT
 *  opcode, and 14/18 were what an earlier version matched on and therefore never read.
 */
export const PROBE_QUERY = '\x1b]11;?\x07' + '\x1b[?u' + '\x1b[?2026$p'
  // The three mouse-reporting modes, asked with DECRQM so a terminal that does not implement one can
  // SAY SO rather than being sent it blind. This is the fix for a UI whose keyboard works and whose
  // mouse does nothing: the mode was accepted and no event ever arrived.
  //
  //   1000  click and release
  //   1002  button-motion (drag)
  //   1003  any-motion (hover) — the least widely supported, and the one worth dropping alone
  + '\x1b[?1000$p' + '\x1b[?1002$p' + '\x1b[?1003$p'
  + '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=32,o=z;eAFjYGBgAAAABAAB\x1b\\'
  + '\x1b[16t' + '\x1b[14t' + '\x1b[c';

/**
 * The mouse-reporting modes hncode asks for, by name.
 *
 * Kept as a map rather than three magic numbers at the call site so the query, the parser and the
 * enable step all name the same mode.
 */
export const MOUSE_MODES = Object.freeze({ click: 1000, drag: 1002, hover: 1003 });

/** Synchronized output (BEGIN/END SYNCHRONIZED UPDATE). */
export const SYNC_OUTPUT_MODE = 2026;

/** DECRPM `status` values for a mode. 0 means "not recognised", which is the one that
 *  says the terminal has never heard of the mode. */
const DECRPM_NOT_RECOGNISED = 0;
const DECRPM_SET = 1;
const DECRPM_RESET = 2;

/** VT level per the FIRST Device Attributes parameter. A small table on purpose:
 *  the parameter identifies the level, not the program — `xterm`, `kitty`, `vte` and
 *  Windows Terminal all report a VT level in this range, and telling THOSE apart is
 *  what the environment is for (see terminalFamily). */
const VT_LEVELS = {
  1: 'vt100', 2: 'vt100-avo', 6: 'vt102', 12: 'vt125', 15: 'vt131',
  16: 'vt132', 17: 'vt1xx', 18: 'vt330', 19: 'vt340',
  41: 'vt420', 61: 'vt510', 62: 'vt220', 63: 'vt320', 64: 'vt420', 65: 'vt525',
  };

/** Meaning of the extension parameters that follow the VT level, for the ones that
 *  change what this app may attempt. */
const DA1_EXTENSIONS = {
  4: 'sixel',
  6: 'selective-erase',
  21: 'horizontal-scroll',
  22: 'ansi-color',
  28: 'rectangular-edit',
  52: 'clipboard',
  };

function emptyCaps() {
  return {
    probed: false,
    bg: null,          // { r, g, b } of the terminal background, or null
    kitty: null,       // true/false: does it speak the Kitty keyboard protocol
    kittyGraphics: null, // true/false: does it speak the Kitty GRAPHICS protocol
    sync: null,        // true/false: synchronized output usable
    // Mouse reporting, per mode: true = the terminal recognises it, false = it said it does not
    // (DECRPM status 0), null = it did not answer. The last is treated as YES by the caller, because
    // silence is not a refusal — a terminal that ignores DECRQM entirely must keep working.
    mouseClick: null,  // ?1000, click and release
    mouseDrag: null,   // ?1002, button-motion
    mouseHover: null,  // ?1003, any-motion
    level: null,       // 'vt220', …
    extensions: [],    // ['sixel', 'ansi-color', …]
    textArea: null,    // { w, h } in PIXELS: the terminal's text area, or null
    cell: null,        // { w, h } in pixels: one cell, or null
    da1: null,         // the raw DA1 parameter list, for diagnostics
    family: null,      // a human-readable name, from the environment
    cols: null,        // columns, when the terminal reported them
    rows: null,        // rows, when the terminal reported them
  };
  }

let caps = emptyCaps();

/** Everything learned so far. Read by the renderer and the theme picker. */
export function terminalCaps() { return caps; }


/** Merge in probe results. Exported so tests (and a future re-probe on resize) can
 *  install a set without running the protocol. */
export function setTerminalCaps(next) {
  caps = Object.assign(emptyCaps(), caps, next, { probed: true });
  return caps;
  }

/** Whether a `ESC[?2026h … ESC[?2026l` wrapper should be emitted. Unknown (no probe,
 *  no reply) keeps the OLD unconditional behaviour — this must not silently change
 *  what an already-good terminal receives. */
export function syncOutputUsable() {
  return caps.sync !== false;
  }

/** Whether `ESC[>1u` may be sent. Unknown keeps the old default (on), so a terminal
 *  that answers nothing is treated exactly as before; only a terminal that ANSWERED
 *  and did not report Kitty support turns it off. */
export function kittyKeysUsable() {
  return caps.kitty !== false;
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  // `ESC ] 11 ; rgb :RRRR/GGGG/BBBB` then BEL or ST. Components are 1-4 hex digits.
  // The `#rrggbb` spelling is also accepted: it is not xterm's, but several terminals
  // answer OSC 11 that way and there is no reason to throw the reading away.
const OSC11_RE = /\x1b\]11;(?:rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})|#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2}))(?:\x07|\x1b\\)/g;
  // Kitty keyboard flags reply.
const KITTY_RE = /\x1b\[\?(\d+)u/g;
  // DECRPM: mode number, then `;`, then the status, then `$y`.
const DECRPM_RE = /\x1b\[\?(\d+);(\d+)\$y/g;
  // Device Attributes reply: `ESC [ ? <params> c`.
const DA1_RE = /\x1b\[\?([0-9;]*)c/g;
  // Kitty GRAPHICS query reply. The value is a bitmap of what the terminal accepts;
  // per the spec, querying action=1 asks which features are supported.
  const KITTY_GRAPHICS_RE = /\x1b\[_G([\s\S]*?)\x1b\\/g;
  // XTWINOPS replies are `CSI <opcode> ; <value> ... t`, and the opcode in the
  // REPLY is not the one in the QUERY. Reporting the cell size is opcode 6 and the
  // text area is 4; 14 and 18 are those same operations’ query forms, so a parser
  // written for the query numbers matched nothing at all: the cell size stayed unknown, so
  // every image refused to draw ("image could not be displayed") on a terminal that had
  // just reported one — and the unmatched bytes fell through to the key parser.
  const XT_CELL_RE = /\x1b\[6;(\d+);(\d+)t/g;
  const XT_AREA_RE = /\x1b\[4;(\d+);(\d+)t/g;

/** One hex component of an OSC 11 reply, scaled to 0-255. xterm sends four digits
 *  (`ffff`), others send two (`ff`), so the scale comes from the digit count. */
function scaleHex(h) {
  const n = parseInt(h, 16);
  const max = Math.pow(16, h.length) - 1;
  return max > 0 ? Math.round((n / max) * 255) : 0;
}

/** Is this background colour light? Used to pick a readable theme: the frame paints no
 *  background of its own, so the terminal's shows through every padded row. */
export function isLightBg(bg) {
  if (!bg) return false;
  // Rec. 601 luma, which matches how a colour reads far better than a plain average.
  return (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) > 127;
  }

/** Human-readable terminal name. The ENVIRONMENT is what actually identifies the
 *  program (`TERM_PROGRAM`, `WT_SESSION`, `TERM`); the DA1 level only says which VT
 *  it emulates, which several of them report identically. */
export function terminalFamily(env = process.env) {
  if (env.WT_SESSION) return 'Windows Terminal';
  if (env.TERM_PROGRAM) {
    return /vscode/i.test(String(env.TERM_PROGRAM)) ? 'VS Code' : String(env.TERM_PROGRAM);
  }
  const term = String(env.TERM || '');
  if (!term) return null;
  if (/kitty/i.test(term)) return 'kitty';
  if (/wezterm/i.test(term)) return 'WezTerm';
  if (/ghostty/i.test(term)) return 'Ghostty';
  if (/^screen/i.test(term)) return 'screen';
  if (/^tmux/i.test(term)) return 'tmux';
  if (/^xterm/i.test(term)) return 'xterm';
  return term;
  }

/** Prefixes of the replies we are waiting for. Used to trim a dangling partial reply
 *  from the bytes handed back to the key parser, so half an escape sequence does not
 *  become garbage input. */
const REPLY_PREFIXES = ['\x1b]11;', '\x1b[?', '\x1b[_G'];

/** Longest suffix of `buf` that could still grow into one of the replies. */
function danglingReplyLen(buf) {
  let best = 0;
  for (const p of REPLY_PREFIXES) {
    const max = Math.min(p.length, buf.length);
    for (let len = max; len >= 2; len--) {
      if (buf.endsWith(p.slice(0, len))) { if (len > best) best = len; break; }
    }
  }
  return best;
  }

/**
 * Remove any complete probe reply from `s`.
 *
 * For ONE narrow case, after the probe has given up: a slow terminal answers anyway,
 * and those bytes arrive on the keystroke stream. Without this they reach the key
 * parser and are typed into the composer as garbage. A terminal that answered the DA1
 * sentinel has nothing left outstanding, so its caller does not need this at all — see
 * the `complete` flag `probeTerminal` returns.
 */
export function stripProbeReplies(s) {
  const buf = String(s == null ? '' : s);
  // Almost every chunk is ordinary typing; only touch the buffer when it could hold a
  // reply at all.
  if (buf.indexOf('\x1b') < 0) return buf;
  const spans = [];
  const noop = () => {};
  takeMatches(OSC11_RE, buf, spans, noop);
  takeMatches(KITTY_RE, buf, spans, noop);
  takeMatches(KITTY_GRAPHICS_RE, buf, spans, noop);
  takeMatches(XT_CELL_RE, buf, spans, noop);
  takeMatches(XT_AREA_RE, buf, spans, noop);
  takeMatches(DECRPM_RE, buf, spans, noop);
  takeMatches(DA1_RE, buf, spans, noop);
  return removeSpans(buf, spans);
  }

/** Collect the matches of `re` in `buf`, recording their spans so the caller can
 *  compute what is LEFT after removing them. */
function takeMatches(re, buf, spans, onMatch) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(buf)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    onMatch(m);
    // A zero-length match cannot happen with these patterns, but guard the loop.
    if (m[0].length === 0) re.lastIndex++;
  }
  }

/** Everything not covered by a span. */
function removeSpans(buf, spans) {
  if (!spans.length) return buf;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of spans) {
    if (s > at) out += buf.slice(at, s);
    at = Math.max(at, e);
  }
  return out + buf.slice(at);
  }

/**
 * Parse whatever has arrived. Pure, so it is directly testable.
 *
 * @returns {{ found: object, rest: string, complete: boolean }}
 *   `found` carries only the fields a reply actually provided; `rest` is the buffer
 *   with every reply removed (the caller keeps the tail it could still use); and
 *   `complete` is true once the DA1 sentinel has been seen.
 */
export function parseProbeReplies(buf) {
  const spans = [];
  const found = {};

  takeMatches(OSC11_RE, buf, spans, (m) => {
    found.bg = m[4] != null
      ? { r: parseInt(m[4], 16), g: parseInt(m[5], 16), b: parseInt(m[6], 16) }
      : { r: scaleHex(m[1]), g: scaleHex(m[2]), b: scaleHex(m[3]) };
  });
  takeMatches(KITTY_RE, buf, spans, () => {
    // Any flags value, including 0, means the terminal implements the protocol: 0 is
    // "supported, nothing enabled yet", which is exactly the state we ask from.
    found.kitty = true;
  });
  takeMatches(DECRPM_RE, buf, spans, (m) => {
    const mode = Number(m[1]);
    const status = Number(m[2]);
    if (mode === SYNC_OUTPUT_MODE) {
      // 0 is "not recognised"; SET and RESET both mean the terminal knows the mode,
      // and either state is something the wrapper can work with.
      found.sync = status === DECRPM_SET || status === DECRPM_RESET;
    }
    // A mouse mode: `true` only when the terminal RECOGNISES it. Status 0 means it has never heard of
    // the mode, and asking anyway is what leaves the application waiting for reports that never come —
    // a UI where the keyboard works and the mouse does nothing.
    //
    // A mode the terminal did not answer for stays `undefined`, which the caller reads as UNKNOWN
    // rather than as "no": silence is not a refusal, and a terminal that ignores DECRQM altogether has
    // to keep the previous behaviour.
    const known = status !== DECRPM_NOT_RECOGNISED;
    if (mode === MOUSE_MODES.click) found.mouseClick = known;
    if (mode === MOUSE_MODES.drag) found.mouseDrag = known;
    if (mode === MOUSE_MODES.hover) found.mouseHover = known;
  });
  // Kitty GRAPHICS: a supported query answers `OK`; a terminal without the protocol says
  // nothing at all. Silence is resolved in probeTerminal (a sentinel arriving means every
  // query was answered, so silence means "no"), not here.
  takeMatches(KITTY_GRAPHICS_RE, buf, spans, (m) => {
    if (!/\bOK\b/.test(m[1])) return;
    found.kittyGraphics = true;
  });
  // XTWINOPS: the CELL size (reported as opcode 6) and the TEXT AREA (opcode 4). Both
  // are needed to place an image in cells rather than guessing — and a guess here is wrong
  // on every display whose font is not square, which is most of them.
  takeMatches(XT_CELL_RE, buf, spans, (m) => {
    // THE REPLY PUTS HEIGHT FIRST: `CSI 6 ; height ; width t`.
    //
    // Reading it as width-then-height swapped the two on every terminal, which put the cell size at 20x10
    // instead of 9x20 for a normal font. An image's row count is derived from the CELL height, so the bitmap
    // claimed twice the rows it needed and pushed the interface down by exactly that much.
    const h = Number(m[1]);
    const w = Number(m[2]);
    // A terminal that answers 0x0 has nothing to say — treat it as unknown rather than
    // as a cell of zero width, which would divide by zero downstream.
    if (w > 0 && h > 0) found.cell = { w, h };
  });
  takeMatches(XT_AREA_RE, buf, spans, (m) => {
    // The text area reply is `CSI 4 ; height ; width t` — same order.
    const h = Number(m[1]);
    const w = Number(m[2]);
    if (w > 0 && h > 0) found.textArea = { w, h };
  });
  let complete = false;
  takeMatches(DA1_RE, buf, spans, (m) => {
    const params = m[1].split(';').map((s) => Number(s)).filter((n) => Number.isFinite(n));
    found.da1 = params;
    found.level = VT_LEVELS[params[0]] || (params.length ? `vt?${params[0]}` : null);
    found.extensions = params.slice(1).map((p) => DA1_EXTENSIONS[p]).filter(Boolean);
    // The sentinel is the LAST DA1 in the batch, and we only write one.
    complete = true;
  });

  const rest = removeSpans(buf, spans);
  return { found, rest, complete };
  }

  // ---------------------------------------------------------------------------
  // The probe
  // ---------------------------------------------------------------------------

/**
 * Ask the terminal. Owns `stdin` for the duration.
 *
 * @param {object} opts
 * @param {import('node:stream').Readable} opts.stdin  Raw-mode stdin.
 * @param {{write: Function}} opts.stdout             Where the queries go.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ caps: object, rest: string }>} `rest` is everything that was
 *   NOT a reply — a keystroke typed while the probe was waiting must not be eaten.
 */
export function probeTerminal({ stdin, stdout, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // A probe REPLACES what is known: a second run must not inherit the first one's
    // answers, or a terminal that changed would keep stale flags.
    caps = emptyCaps();
    // Declared before the closures that use them: `finish` can run from the catch
    // below, i.e. before the listener is attached.
    const found = {};
    let buf = '';
    let settled = false;
    let timer = null;
    // Whether the DA1 sentinel ever arrived: everything asked before it is answered by
    // then, so if it did, nothing is outstanding.
    let sawSentinel = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { stdin.removeListener('data', onData); } catch { /* stream may be gone */ }
      // Anything still buffered that could be the head of a reply is a reply we never
      // finished receiving: drop just that tail, and hand the rest back as real input.
      const tail = danglingReplyLen(buf);
      const rest = tail ? buf.slice(0, buf.length - tail) : buf;
      // The environment is the only thing that actually identifies the PROGRAM; DA1
      // only reports which VT it emulates, which several of them do identically.
      if (!found.family) found.family = terminalFamily();
      // A terminal that answered the DA1 SENTINEL answered everything asked before it,
      // in order — so a query it left unanswered is one it does not implement. For
      // Kitty that inference is load-bearing: the reply is mandatory when the protocol
      // is supported, so silence means NO, and sending `>1u` anyway is exactly what
      // mangles input. Only inferred when the sentinel arrived; without it, unknown.
      if (sawSentinel && found.kitty === undefined) found.kitty = false;
      // THE SAME INFERENCE FOR THE MOUSE MODES, and making it is the point of this change. A terminal
      // that answers the sentinel and then says nothing about `?1003` does NOT implement it: DECRQM is
      // mandatory for a mode the terminal knows, so silence in that position is a refusal.
      //
      // Without this, an unsupported mode was read as "unknown" and enabled anyway — the sequences went
      // out, the terminal ignored them, and the mouse was dead with nothing to explain it. Leaving it
      // unknown is right only when the sentinel never arrived, where the silence means the terminal does
      // not speak DECRQM at all rather than that it declined.
      if (sawSentinel) {
        if (found.mouseClick === undefined) found.mouseClick = false;
        if (found.mouseDrag === undefined) found.mouseDrag = false;
        if (found.mouseHover === undefined) found.mouseHover = false;
      }
      resolve({ caps: setTerminalCaps(found), rest, complete: sawSentinel });
    };

    const onData = (chunk) => {
      buf += String(chunk);
      const parsed = parseProbeReplies(buf);
      Object.assign(found, parsed.found);
      buf = parsed.rest;
      if (parsed.complete) { sawSentinel = true; finish(); }
    };

    try {
      stdin.setEncoding?.('utf8');
      stdin.on('data', onData);
    } catch {
      // No usable stdin: report "nothing learned" rather than hanging.
      finish();
      return;
    }
    timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    try { stdout.write(PROBE_QUERY); } catch { finish(); }
  });
  }