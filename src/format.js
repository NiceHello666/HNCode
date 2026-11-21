// Number, money and time formatting for the readouts.
//
// One rule per quantity, stated once: a token count must read the same in the context gauge and in the working row, and
// a cost must never round a real amount down to `0.00`.

import { fitAnsi, visualCol } from './text.js';

export function trimDecimal(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * One unit's worth of a count: `1.2`, `97`, `262`.
 *
 * One decimal below 100, whole numbers at and above it. Used by every token formatter so the same quantity cannot read
 * two ways on one screen.
 */
export function scaleUnit(v) {
  if (v < 100) return v.toFixed(1).replace(/\.0$/, '');
  const r = Math.round(v);
  // A value that ROUNDS to the whole number keeps its decimal: 1048576/1e6 is 1.048576, and printing `1` put it in the
  // same bucket as a plain million.
  if (r >= 100 && Math.abs(v - r) <= 0.5) return String(r);
  return v.toFixed(1).replace(/\.0$/, '');
}

/**
 * Token counts use DECIMAL units, the same ones `fmtTokensShort` uses for the working row.
 *
 * This was 1024-based, on the reasoning that a context size is a power of two. Two things outweighed that:
 *
 *   * TOKENS ARE NOT BYTES. Dividing by 1024 turns 97000 tokens into "94.7k", which is simply wrong — and the context
 *     window is not the only figure here, since /ctx and /usage also report live counts that are not powers of two.
 *   * IT DISAGREED WITH ITSELF ON SCREEN. The working row divided by 1000 and this divided by 1024, so one frame showed
 *     "97k" for the turn and "94.7k" for the context it was using.
 *
 * A model's window is advertised in decimal terms anyway (200k, 128k), so nothing is lost at the size that matters.
 */
export function fmtTokens(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (!Number.isFinite(v)) return '0';
  const units = [
    { at: 1e12, suffix: 'T' },
    { at: 1e9, suffix: 'B' },
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'k' },
  ];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (v < u.at) continue;
    // The SAME scaling rule as `fmtTokensShort`: a tenth is information at `1.2k` and noise at `262.1k`. Sharing the
    // rule is what keeps one frame from showing `262.1k` for the context and `262k` for the turn that filled it.
    const shown = scaleUnit(v / u.at);
    // Rounding can reach the next unit (`999999` is `1000k`, which is `1m`).
    if (Number(shown) >= 1000 && i > 0) return scaleUnit(v / units[i - 1].at) + units[i - 1].suffix;
    return shown + u.suffix;
  }
  return String(v);
}

/**
 * Thousands separators for a plain count.
 *
 * `fmtTokens` rounds to k/M, which is right for a context gauge but wrong for a token BILL: "1.5M input tokens" hides
 * whether that is 1.45M or 1.54M, and the cost readout next to it is precise.
 */
export function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

/**
 * A money amount, at a precision that stays readable across five orders of magnitude: a single cheap request is
 * fractions of a cent, a long session is dollars. A bare `0.00` for a real cost is the failure to avoid, so anything
 * non-zero under a cent keeps its decimals rather than rounding away. The symbol is the caller's business — the status
 * row puts it AFTER the number.
 */
export function moneyAmount(v, currency = 'USD') {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  // CNY is about 7x USD, so the same amount crosses these thresholds one step sooner; scaling the comparison keeps both
  // currencies at the same precision.
  const scale = currency === 'CNY' ? 7 : 1;
  if (n === 0) return '0.00';
  if (n * scale < 0.01) return n.toFixed(5);
  if (n * scale < 1) return n.toFixed(4);
  return n.toFixed(2);
}

/** `$12.34` / `¥86.51` — the amount with its symbol in front. */
export function formatCost(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 'unknown';
  return `${currency === 'CNY' ? '¥' : '$'}${moneyAmount(n, currency)}`;
}

/**
 * A tiny ASCII line chart for a numeric series (context growth over steps).
 *
 * Renders `height` rows; each column is one sample, scaled to the series max. No dependency.
 */
export function sparkChart(values, width, height) {
  const series = (values || []).filter((v) => Number.isFinite(v));
  if (series.length < 2) return [];
  // Downsample to `width` columns by taking evenly spaced samples.
  const cols = Math.min(width, series.length);
  const sampled = [];
  for (let i = 0; i < cols; i++) {
    sampled.push(series[Math.round(i / (cols - 1) * (series.length - 1))]);
  }
  const max = Math.max(...sampled, 1);
  const min = Math.min(...sampled, 0);
  const span = Math.max(1, max - min);
  const rows = [];
  const BLOCK = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  // Single-row sparkline.
  if (height <= 1) {
    rows.push(sampled.map((v) => BLOCK[Math.min(8, Math.round((v - min) / span * 8))]).join(''));
    return rows;
  }
  for (let r = height - 1; r >= 0; r--) {
    let line = '';
    for (const v of sampled) {
      const level = (v - min) / span * (height - 1);
      line += level >= r ? '█' : ' ';
    }
    rows.push(line);
  }
  return rows;
}

/**
 * Usage as a whole-number percentage of `max`, ceiled so any non-zero usage shows at least 1%, clamped to [0, 100].
 *
 * `used` can be undefined on a session resumed before any usage was recorded; without the guard the division produced
 * NaN and the row printed `NaN%` where it should have printed `0%`.
 */
export function usagePercent(used, max) {
  if (!Number.isFinite(used)) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((used / max) * 100)));
}

/** `1h 2m 3s` — every non-zero unit, seconds always shown. */
export function fmtDuration(ms) {
  ms = Math.max(0, Math.floor(ms));
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60000) % 60;
  const hour = Math.floor(ms / 3600000) % 24;
  const day = Math.floor(ms / 86400000) % 30;
  const mon = Math.floor(ms / 2592000000) % 12;
  const year = Math.floor(ms / 31536000000);
  const parts = [];
  if (year) parts.push(year + 'y');
  if (mon) parts.push(mon + 'mon');
  if (day) parts.push(day + 'd');
  if (hour) parts.push(hour + 'h');
  if (min) parts.push(min + 'm');
  // Seconds are always shown (at least "0s").
  parts.push(sec + 's');
  return parts.join(' ');
}

/**
 * The turn's output tokens as `50k`, `1.2k`, `999`, or `0 tokens`.
 *
 * The rule is the one `Intl` compact notation applies, so a figure read in one tool is not read differently in the
 * other:
 *
 *   1200    -> 1.2k     one decimal while it carries information
 *   9999    -> 10k      compact rounds here, so the decimal falls away on its own
 *   12400   -> 12.4k    STILL one decimal — whole thousands would lose the 400
 *   1234567 -> 1.2M     and each thousand-group gets its own unit
 */
export function fmtTokensShort(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return `${v} token${v === 1 ? '' : 's'}`;
  const units = [
    { at: 1e12, suffix: 'T' },
    { at: 1e9, suffix: 'B' },
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'k' },
  ];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (v < u.at) continue;
    const scaled = v / u.at;
    // One decimal, dropped when it is a zero — the shape compact notation gives (`1k`, not `1.0k`).
    const shown = scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(scaled));
    // ROUNDING CAN REACH THE NEXT UNIT. 999999 is 999.999k, which rounds to `1000k`, and `1000k` is `1m` — showing the
    // first makes the reader convert a unit themselves. `units` is ordered largest-first, so `i - 1` is it.
    if (Number(shown) >= 1000 && i > 0) {
      const up = units[i - 1];
      const upScaled = v / up.at;
      const upShown = upScaled < 100 ? upScaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(upScaled));
      return `${upShown}${up.suffix} tokens`;
    }
    return `${shown}${u.suffix} tokens`;
  }
  return `${v} tokens`;
}

/**
 * A prose setting as one short cell, for a list that has room for about forty characters.
 *
 * A truncated paragraph fills that space with text nobody can read and pushes the label out of line with every other
 * row; the size is the fact worth showing at a glance.
 */
export function proseSummary(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) return '(unset)';
  if (text === '(unset)') return text;              // already a placeholder, not prose
  const lines = text.split(/\r?\n/);
  const first = lines[0].trim();
  // One short line with no newline fits as-is — that IS the whole value.
  if (lines.length === 1 && first.length <= 32) return first;
  return `${lines.length} line${lines.length === 1 ? '' : 's'}, ${text.length} chars`;
}

/**
 * The `[2s | ↓40]` tail shown at the end of the Working row, WITHOUT brackets.
 *
 * The brackets belong to the caller, because the two rows want them in different places: the live row wraps the TAIL,
 * the settled row wraps word AND tail. Putting them here produced `[turn took [6m 44s | …]`.
 *
 * The token count is shown FROM THE FIRST FRAME: it used to be hidden for thirty seconds on the theory that a small
 * number is noise, but the row is the only place that number exists, and a count that appears partway through reads as
 * something that just started rather than as a running total.
 */
export function elapsedTail(ms, tokens) {
  return `${fmtDuration(ms)} | ↓ ${fmtTokensShort(tokens)}`;
}

/**
 * Has the turn gone quiet, and how much should that show?
 *
 * A turn that produces no tokens for a few seconds is either thinking, waiting on a tool, or stuck — and from outside
 * those look identical. The one case that matters is the last: a request that hangs leaves the row spinning forever
 * with no way to tell it apart from a long answer.
 *
 * Returns 0 while healthy and 1 at full stall, so the caller can interpolate rather than switch abruptly. NEVER
 * reports a stall while a tool is running — a long install is working, not stalled, and flashing at it would train the
 * user to ignore the signal.
 */
export const STALL_AFTER_MS = 3000;
export const STALL_FADE_MS = 2000;

export function stallIntensity({ sinceLastTokenMs, hasActiveTools }) {
  if (hasActiveTools) return 0;
  const quiet = Number(sinceLastTokenMs) || 0;
  if (quiet <= STALL_AFTER_MS) return 0;
  return Math.min((quiet - STALL_AFTER_MS) / STALL_FADE_MS, 1);
}

/**
 * Left/right justify: left text, then padding, then right text flush to `w`.
 *
 * ANSI codes are ignored for width so coloured segments still align exactly. When both do not fit, the LEFT is preserved
 * and the RIGHT is truncated — the left is what the user is reading.
 */
export function justify(left, right, w) {
  const lw = visualCol(left);
  const rw = visualCol(right);
  if (left && right) {
    if (lw + rw + 1 <= w) return left + ' '.repeat(w - lw - rw) + right;
    const room = w - lw - 1;
    if (room > 0) return left + ' ' + fitAnsi(right, room);
    return fitAnsi(left, w);
  }
  if (!left) return ' '.repeat(Math.max(0, w - rw)) + right;
  if (!right) return left + ' '.repeat(Math.max(0, w - lw));
  return fitAnsi(left, w);
}
