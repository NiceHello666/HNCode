// Clipboard access, fast enough for a keypress.
//
// Spawning a fresh PowerShell costs ~1.5-3s on Windows (cold start), which made
// Ctrl+Shift+C and every paste feel broken. So:
//   copy  -> clip.exe with UTF-16LE input (~100ms, no PowerShell at all).
//   read  -> ONE long-lived PowerShell child, pre-warmed at TUI start; a command
//            on an already-running shell costs ~100-230ms instead of seconds.
//            If the helper is unusable, fall back to a one-shot PowerShell.
// Non-Windows paths (pbcopy/pbpaste/xclip) are cheap enough to run per call.
//
// THREE THINGS MADE THE FIRST PASTE FAIL, all measured on the shipping code:
//   * The helper was "ready" the instant `spawn` returned, but the shell needs
//     ~2-3s before it can answer anything. A read in that window was sent to a
//     shell that had not started reading stdin yet, so it burned `helperRun`'s
//     full 3s deadline and then fell through to the cold one-shot.
//   * Worse, the warm sequence's sentinel was written WITHOUT a queued resolver
//     ("so it drains from the buffer"). When a read pushed its resolver before
//     that sentinel came back, the SENTINEL consumed the read's slot and resolved
//     it with its own empty output — so the paste reported "Clipboard empty or
//     unavailable" while the real answer (with the actual clipboard content) was
//     dropped on the floor. Reproduced deliberately: the read got "", and the
//     payload arrived afterwards with nobody left to receive it.
//   * The fallback ran `powershell` (5.1) with an 8s timeout. Loading
//     WinForms + Drawing there measured 3.8s idle and 11.5s on a busy machine —
//     past the timeout, so `execSync` threw and the paste reported "unavailable"
//     for a clipboard that was fine. `pwsh` does the same work in 1.9s.
// The warm-up also used to spawn a THROWAWAY shell (`pwsh -Command exit`) through
// `execSync` to decide which exe to use, blocking the TUI's startup path for ~1.9s
// before its first paint. The exe is discovered from the spawn's own `error` event
// now, so nothing blocks.

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENT = '@@HNCODE_CLIP@@';
let helper = null;      // long-lived PowerShell child
let helperBuf = '';     // stdout accumulated since the last sentinel
let helperQueue = [];   // pending read() resolvers, ONE per sentinel written
let helperBusy = false; // one command in flight at a time
let helperReady = false; // the warm sequence has answered: the shell can take commands
let keepAliveTimer = null; // a scheduled respawn, after the helper died
let _shuttingDown = false; // set by the exit handler so a dead shell is not respawned during cleanup

/** How long a read will wait for the helper to finish warming. It is already coming
 *  up, and waiting for a ~10ms answer beats the multi-second cold fallback. */
const HELPER_READY_MS = 6000;

/** Deadline for ONE command on a warm shell. Only reached when the shell has already
 *  answered, so it is a hang detector, not a warm-up budget. */
const HELPER_CMD_MS = 3000;

/** Deadline for the cold one-shot fallback. Raised from 8s: loading WinForms and
 *  Drawing in powershell 5.1 measured 11.5s under load, and the old timeout turned
 *  that into a spurious "clipboard unavailable". This is the last resort, so it is
 *  allowed to be slow — failing here helps nobody. */
const ONESHOT_MS = 20000;

function win() { return process.platform === 'win32'; }

/**
 * Put text on the clipboard.
 *
 * WINDOWS: `clip.exe` on STDIN, with the PowerShell path as the fallback.
 *
 * An earlier version chose `Set-Clipboard` because `clip.exe` prefixed every copy with a zero-width U+FEFF.
 * That was a BOM problem, not a `clip.exe` problem: it reads stdin as a byte stream, so a leading `FF FE` is
 * two literal characters. Sent as plain UTF-16LE with no mark, it round-trips exactly — verified on ASCII,
 * Chinese, emoji, embedded newlines and 400000 characters.
 *
 * Two measured reasons to prefer it:
 *
 *   characters   clip.exe   pwsh one-shot
 *          100      77ms          788ms
 *         5000      56ms          748ms
 *        20000      61ms   ENAMETOOLONG   <- the command line is capped near 32KB
 *       400000      58ms   ENAMETOOLONG
 *
 * `clip.exe` takes the text on STDIN, so its cost does not depend on the length and it has no ceiling; the
 * PowerShell route puts the text on its COMMAND LINE and fails outright past ~20k characters. The one
 * difference that remains: `clip.exe` normalises `\n` to `\r\n`, which is what the Windows clipboard expects
 * anyway.
 *
 * `setClipboardText` stays for a machine with no `clip.exe`.
 */
export function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (win()) {
    // `clip.exe` FIRST, fed UTF-8 through a 65001 console.
    //
    // Measured 150-193ms at every size from 100 to 400000 characters, against 748-788ms for a PowerShell
    // one-shot — and the PowerShell route puts the text on its COMMAND LINE, which Windows caps near 32KB, so
    // a 20k-character copy failed outright with ENAMETOOLONG.
    //
    // THE ENCODING IS NOT UTF-16. `clip.exe` decodes stdin with the console code page, which is 936 (GBK) on a
    // Chinese Windows: UTF-16LE bytes came back byte-swapped (`你好` U+4F60 U+597D arrived as U+604F U+597D)
    // and UTF-8 bytes without the matching code page came back as mojibake. `chcp 65001` on the child and UTF-8
    // in the pipe is what round-trips — verified on ASCII, Chinese, emoji and 400k characters.
    //
    // Synchronous, because the caller announces "Copied" the moment this returns.
    const r = cp.spawnSync('cmd', ['/c', 'chcp 65001 >nul && clip'], {
      input: Buffer.from(s, 'utf8'),
      windowsHide: true,
      timeout: 5000,
    });
    if (r && r.status === 0) return true;
    return setClipboardText(s);
  }
  const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
  cp.execSync(cmd, { input: Buffer.from(s, 'utf8'), timeout: 5000 });
  return true;
}

/** `Set-Clipboard` via PowerShell. False when no PowerShell can be run. */
function setClipboardText(s) {
  // The text travels as base64 so nothing in it can end the script or be re-parsed. A quoted
  // PowerShell literal would need every `'` doubled, and a newline or a backtick in the text would
  // otherwise change what the script means.
  const b64 = Buffer.from(s, 'utf16le').toString('base64');
  const full = 'Add-Type -AssemblyName System.Windows.Forms; '
    + '[System.Windows.Forms.Clipboard]::SetText('
    + `[System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${b64}')))`;
  for (const exe of [_psExe, 'powershell']) {
    try {
      cp.execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', full], { timeout: 10000, windowsHide: true });
      return true;
    } catch { /* try the next exe */ }
  }
  return false;
}

/**
 * Put text on the clipboard WITHOUT blocking the event loop.
 *
 * `copyText` is synchronous because most callers want to know the outcome before they say "Copied". A copy is
 * 150-190ms of child process on Windows, which is long enough to be felt as a stutter when it runs between two
 * paints. The TUI uses this where a reply is not needed.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export function copyTextAsync(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve(false);
  if (!win()) {
    try { copyText(s); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    try {
      // Same command and encoding as `copyText`: the code page has to be set on the child, and the payload is
      // UTF-8. See the note there for why UTF-16 does not work.
      const child = cp.spawn('cmd', ['/c', 'chcp 65001 >nul && clip'], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.on('error', () => { /* a broken pipe is reported by `close` */ });
      child.stdin.end(Buffer.from(s, 'utf8'));
    } catch {
      // No clip.exe: fall back to the blocking route rather than losing the copy.
      try { resolve(setClipboardText(s)); } catch { resolve(false); }
    }
  });
}

// Which PowerShell the helper runs. `pwsh` (7) starts far faster than the built-in
// `powershell` (5.1) — measured 1.9s vs 11.5s for the same image probe — and the image
// path needs the WinForms/Drawing assemblies. This is only the PREFERRED name: it is
// resolved from the spawn's own `error` event (see startHelper), so discovering that a
// box has no pwsh costs nothing instead of blocking the TUI's startup path with a
// throwaway shell.
let _psExe = 'pwsh';

/** One-shot PowerShell, preferring the exe the helper resolved. Returns stdout, or
 *  null when neither exe could answer. A machine without `pwsh` has to be able to
 *  fall back WITHOUT the startup-time probe that used to decide this. */
function runPowershell(args, opts) {
  const tried = [];
  for (const exe of [_psExe, 'powershell']) {
    if (tried.includes(exe)) continue;
    tried.push(exe);
    try { return cp.execSync(`${exe} ${args}`, opts); } catch { /* try the next exe */ }
  }
  return null;
}

// ------------------------------------------------------- PowerShell helper
export function warmClipboard() {
  if (!win() || helper) return;
  _shuttingDown = false;   // an explicit warm cancels a shutdown in progress
  startHelper(_psExe);
}

/**
 * Stop the keep-alive respawn and let the helper die with the process.
 *
 * Called from the exit handler. Without it a helper that exits during shutdown would be respawned by
 * `dropHelper`, leaving a PowerShell child running after the TUI is gone.
 */
export function stopClipboardHelper() {
  _shuttingDown = true;
  if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
  const h = helper;
  dropHelper();
  if (h) { try { h.stdin.end(); } catch { /* already closed */ } }
}

/** Spawn the long-lived shell. `exe` is tried first; if that exe does not exist,
 *  the spawn reports ENOENT on its `error` event and this retries with 5.1. */
function startHelper(exe) {
  try {
    helper = cp.spawn(exe, ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { helper = null; return; }
  helperReady = false;
  helper.on('error', () => {
    const missing = helper;
    dropHelper();
    // `pwsh` absent (or unusable): fall back to the built-in shell once.
    if (exe !== 'powershell' && missing) { _psExe = 'powershell'; warmClipboard(); }
  });
  helper.on('exit', () => dropHelper());
  helper.stdout.on('data', (d) => {
    helperBuf += d.toString('binary');
    let i;
    while ((i = helperBuf.indexOf(SENT)) >= 0) {
      const chunk = helperBuf.slice(0, i);
      helperBuf = helperBuf.slice(i + SENT.length);
      const w = helperQueue.shift();
      helperBusy = false;
      if (w) w(chunk);
    }
  });
  helper.stdin.write('$ProgressPreference = "SilentlyContinue"\n');
  // Pre-load the image assemblies ONCE, at warm time. Loading them lazily inside
  // the probe cost ~3.6s on 5.1 — longer than the probe timeout — so the FIRST
  // image paste always failed. Doing it up front moves that cost off the paste
  // path entirely (the shell is warmed at TUI start, not on a keypress).
  //
  // This sentinel is QUEUED like every other command answer, and that is the whole
  // point: written without a resolver it used to be claimed by whatever read pushed
  // its resolver first, which handed that read THIS empty output and dropped the
  // read's own answer — the first paste after startup reported "Clipboard empty or
  // unavailable" for a clipboard that had content. The queued resolver here is what
  // marks the shell as ready, so one sentinel still has exactly one owner.
  helperQueue.push(() => { helperReady = true; });
  // The sequence probe's P/Invoke declaration is compiled here too: the first `Add-Type` on a cold shell
  // measured ~900ms, which is exactly the cost this warm-up exists to move off the paste path.
  helper.stdin.write(
    "try { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing } catch {}\n"
    + "try { if(-not ('HnClip' -as [type])){Add-Type -Namespace '' -Name 'HnClip' -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();'} } catch {}\n"
    + "'" + SENT + "'\n",
  );
}

/** Tear down the helper and release every waiter. A read must never be left hanging on
 *  a shell that has died — it has a cold fallback to get to. */
function dropHelper() {
  helper = null;
  helperBusy = false;
  helperReady = false;
  helperBuf = '';
  const waiting = helperQueue;
  helperQueue = [];
  for (const w of waiting) w(null);
  // RESPAWN, unless this is a deliberate shutdown.
  //
  // The helper can die without anyone noticing — a shell that exits on its own, a resource hiccup — and
  // nothing restarted it. The next paste then paid the cold path: a fresh spawn plus the warm-up
  // sentinel, measured at 1.2 seconds, on a keypress that is supposed to be instant.
  //
  // A respawn is scheduled rather than immediate so a crash loop cannot spin: the shell gets a moment to
  // be gone before a new one is asked for. `_shuttingDown` stops it after cleanup.
  if (!_shuttingDown) {
    if (keepAliveTimer) clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => { if (!_shuttingDown) warmClipboard(); }, 200);
  }
}

/** Resolve once the shell can take commands, or false when it never got there. */
async function waitHelperReady(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (helperReady) return true;
    if (!helper) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return helperReady;
}

function helperRun(script, timeoutMs) {
  warmClipboard();
  if (!helper) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { helperBusy = false; resolve(null); }, timeoutMs);
    helperQueue.push((out) => { clearTimeout(timer); resolve(out); });
    try { helper.stdin.write(script + `\n'${SENT}'\n`); }
    catch { clearTimeout(timer); helperBusy = false; resolve(null); }
  });
}

// ---------------------------------------------------------------- read
// Base64 both ways: decoding PowerShell's stdout as UTF-8 garbled non-ASCII
// text (its pipe encoding follows the console code page), so instead of reading
// text we read base64 ASCII and decode it ourselves.
function readOnce() {
  if (win()) {
    const b64 = runPowershell(
      // `Clipboard::GetText()` instead of `Get-Clipboard -Raw`: measured on a 20k-character text, the cmdlet
      // took 169ms and the .NET call 13ms. `Get-Clipboard` goes through PowerShell's COM wrapper, which
      // copies the string several times before it reaches the pipeline.
      '-NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([System.Windows.Forms.Clipboard]::GetText() + \'\'))"',
      { encoding: 'ascii', windowsHide: true, timeout: ONESHOT_MS },
    );
    if (b64 == null) throw new Error('no powershell');
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64').toString('utf8');
  }
  const cmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o';
  return cp.execSync(cmd, { encoding: 'utf8', timeout: 5000 });
}

// Async read: uses the warm helper when available. Returns { text, via } so the
// caller can tell the user which path answered.
export async function readText(timeoutMs = HELPER_CMD_MS) {
  if (win()) {
    warmClipboard();
    // Same readiness gate as the probe: a read sent to a shell that has not finished
    // warming is answered by nothing, and the cold path is the expensive one.
    if (helper && await waitHelperReady(HELPER_READY_MS)) {
      helperBusy = true;
      const out = await helperRun('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([System.Windows.Forms.Clipboard]::GetText() + ""))', timeoutMs);
      if (out != null) {
        const b64 = out.replace(/\r/g, '').split('\n').filter((l) => l.trim()).pop() || '';
        try { return { text: Buffer.from(b64.trim(), 'base64').toString('utf8'), via: 'helper' }; } catch {}
      }
      helperBusy = false;
    }
  }
  try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
}

// Unified clipboard read: returns text to insert into the composer, handling
// three clipboard shapes:
//   1. copied FILES          -> absolute path(s)
//   2. plain TEXT            -> the text itself
//   3. an IMAGE (screenshot) -> saved to a temp .png, returns its path
//
// SPEED: a cold PowerShell costs ~2.9s on Windows (measured), while a command on
// the already-warm, long-lived helper (see warmClipboard) costs ~10ms. The TUI
// pre-warms the helper at start, so we run this probe on THAT shell. Only if the
// helper is unavailable do we fall back to a one-shot PowerShell.
//
// The probe prints a tagged result that can be parsed cheaply:
//   F::<path>   a copied file path (one line per file)
//   T::<base64> base64-encoded clipboard text
//   I::<path>   a clipboard image saved to a temp png
//   (empty)     nothing usable on the clipboard
//
// NOTE: no `-join` here. A backtick-n inside the JS string produced a broken
// PowerShell expression (silently returned nothing), which made FILE pastes fall
// back to the slow cold spawn. Emitting one F:: line per file is simpler and
// also supports multi-file copies.
/**
 * Just the clipboard's TEXT, or '' — no file list, no image.
 *
 * Asked before paying for a PNG: a browser's image copy carries the pixels AND the address, and only the text
 * formats can hold that address. Cheap on the warm helper, which is already running by the time anyone pastes.
 *
 * @returns {Promise<string>}
 */
export async function readClipboardTextOnly() {
  if (!win()) { try { return readOnce() || ''; } catch { return ''; } }
  warmClipboard();
  if (!helper) {
    try { return readOnce() || ''; } catch { return ''; }
  }
  if (!helperReady && !await waitHelperReady(HELPER_READY_MS)) {
    try { return readOnce() || ''; } catch { return ''; }
  }
  for (let i = 0; i < 20 && helperBusy; i++) await new Promise((r) => setTimeout(r, 25));
  if (helperBusy || !helper) {
    try { return readOnce() || ''; } catch { return ''; }
  }
  helperBusy = true;
  let out;
  try {
    out = await helperRun(CLIP_PROBE_TEXT, HELPER_CMD_MS);
  } finally {
    helperBusy = false;
  }
  const line = String(out || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('T::'));
  if (!line) return '';
  try { return Buffer.from(line.slice(3), 'base64').toString('utf8'); } catch { return ''; }
}
// The image branch uses the .NET WinForms clipboard, NOT `Get-Clipboard -Image`:
// that parameter only exists on some builds (and is absent even from the pwsh 7
// in use here), so it silently failed everywhere and image paste never worked.
// `[Windows.Forms.Clipboard]::GetImage()` exists on Windows PowerShell 5.1 AND
// pwsh 7 — verified on 5.1 — so it is the portable way to read a copied image.
/**
 * The TEXT-ONLY probe, run first.
 *
 * The full probe below checks three clipboard formats in order — files, text, image — so a plain text
 * paste pays for two failed checks before the one that answers. Text is overwhelmingly the common case,
 * and the two other checks are the slow ones: `Get-Clipboard -Format FileDropList` round-trips through
 * the shell's COM clipboard, and `Clipboard::GetImage()` decodes an image.
 *
 * So the text check is split out and run alone. Only when it comes back EMPTY — no text on the clipboard,
 * so it must be a file or an image — does the caller run the full probe. A text paste now costs one
 * clipboard call instead of three.
 */
const CLIP_PROBE_TEXT = [
  "$ErrorActionPreference='SilentlyContinue'",
  // .NET, not the cmdlet: 13ms against 169ms on the same 20k-character text.
  "$t=[System.Windows.Forms.Clipboard]::GetText()",
  "if($t){'T::'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))}",
].join('; ');

const CLIP_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  // FILES COME FROM THE .NET CLIPBOARD, not `Get-Clipboard -Format FileDropList`.
  //
  // That parameter does not exist in PowerShell 7 — `Get-Clipboard: A parameter cannot be found that matches
  // parameter name 'Format'` — and the `SilentlyContinue` above turns the error into an empty result, so a
  // copied file read as "clipboard unavailable" while copied text worked. `Clipboard::GetFileDropList()` is the
  // same call on both versions; verified on the 5.1 build in System32 and on pwsh 7 here.
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f=[System.Windows.Forms.Clipboard]::GetFileDropList()",
  "if($f -and $f.Count -gt 0){$f|ForEach-Object{'F::'+$_};return}",
  // .NET, not the cmdlet: 13ms against 169ms on the same 20k-character text.
  "$t=[System.Windows.Forms.Clipboard]::GetText()",
  "if($t){'T::'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t));return}",
  // The assemblies are loaded once by warmClipboard(); no Add-Type here, so the
  // probe stays fast even the first time an image is on the clipboard.
  "$i=[System.Windows.Forms.Clipboard]::GetImage()",
  "if($null -ne $i){$p=Join-Path $env:TEMP ('hncode-paste-'+[guid]::NewGuid().ToString('N')+'.png');$i.Save($p,[System.Drawing.Imaging.ImageFormat]::Png);'I::'+$p}",
].join('; ');

/**
 * The clipboard's sequence number, one integer.
 *
 * Windows bumps it on every clipboard write, so comparing two readings answers "did the content change"
 * without reading the content. `Get-Clipboard` has no equivalent, so this P/Invokes `user32` — once, because
 * the type stays compiled for the life of the warm shell.
 *
 * A real read costs time proportional to the payload (measured: 14ms at 1k characters, 48ms at 400k); this
 * does not, which is what makes a repeat paste of a long text instant.
 */
const CLIP_SEQ_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "if(-not ('HnClip' -as [type])){Add-Type -Namespace '' -Name 'HnClip' -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();'}",
  "'S::'+[HnClip]::GetClipboardSequenceNumber()",
].join('; ');

// Parse the probe output into { text, via }. Handles one-or-more F:: lines.
function parseClipResult(out) {
  const lines = String(out == null ? '' : out).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const fileLines = lines.filter((l) => l.startsWith('F::'));
  if (fileLines.length) return { text: fileLines.map((l) => l.slice(3).trim()).join('\n'), via: 'files' };
  const imgLine = lines.find((l) => l.startsWith('I::'));
  if (imgLine) { const p = imgLine.slice(3).trim(); trackPastedImage(p); return { text: p, via: 'image' }; }
  const txtLine = lines.find((l) => l.startsWith('T::'));
  if (txtLine) {
    try { return { text: Buffer.from(txtLine.slice(3).trim(), 'base64').toString('utf8'), via: 'text' }; }
    catch { return null; }
  }
  return null;
}

/**
 * A URL hidden in the TEXT of a copied image, or null.
 *
 * Copying an image out of a browser puts several formats on the clipboard at once: the pixels, an HTML
 * fragment (`<img src="…">`, sometimes a `data:` URL) and, for a plain image, the image's own address. The
 * pixel route costs a PNG written to disk for something the model can fetch directly — so the text formats
 * are checked FIRST and only a clipboard with no address at all becomes a file.
 *
 * Only http(s) and `data:` are accepted. A `file:` URL is the same thing as a copied file, which the file
 * drop list already covers.
 *
 * @param {string} text The clipboard's text, possibly an HTML fragment.
 * @returns {string|null}
 */
export function imageUrlFromClipboardText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // A bare URL: the image's own address was copied.
  const bare = /^(https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (bare) return bare[1].replace(/\s+/g, '').trim();
  // An HTML fragment: take the src of the first <img>, which is what a browser's image copy produces.
  const img = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(s);
  if (img) {
    const url = (img[2] || img[3] || img[4] || '').trim();
    if (/^(https?:\/\/|data:image\/)/i.test(url)) return url.replace(/\s+/g, '');
  }
  // A plain address on its own line inside a longer text selection.
  const line = s.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|svg)(\?\S*)?$/i.test(l));
  return line || null;
}

// ---- pasted-image lifecycle ------------------------------------------------
// A pasted image is written to a temp .png (the model needs a PATH to hand to
// ReadMediaFile), so something has to remove it again or the temp dir fills up
// one screenshot at a time. Every path the probe reports is remembered here and
// the TUI deletes the whole set on exit — see cleanupPastedImages().
const pastedImages = new Set();

function trackPastedImage(p) {
  if (p) pastedImages.add(p);
}

/**
 * Delete every image this process wrote to a temp file. Safe to call from a
 * `process.on('exit')` handler: it is fully synchronous and swallows errors (a
 * locked file must not turn a clean exit into a failed one).
 * Returns the number of files removed.
 */
export function cleanupPastedImages() {
  let removed = 0;
  for (const p of pastedImages) {
    try { fs.rmSync(p, { force: true }); removed++; } catch { /* locked/missing: ignore */ }
  }
  pastedImages.clear();
  return removed;
}

/** How many pasted images are still on disk (diagnostics/tests). */
export function pastedImageCount() { return pastedImages.size; }

// Run the probe on the warm helper (fast path). Resolves null if it is not ready.
async function readViaHelper() {
  warmClipboard();
  if (!helper) return null;
  // Wait for the shell to finish warming FIRST. The warm sequence is already in
  // flight, so this waits for something that is going to happen anyway; sending the
  // probe early meant it was answered by nobody, which cost the full command
  // deadline and then fell through to the cold one-shot — several seconds for a
  // clipboard the helper could have read in ~10ms.
  if (!helperReady && !await waitHelperReady(HELPER_READY_MS)) return null;
  // Then wait briefly for any in-flight command (e.g. a concurrent readText) to
  // drain, so we still hit the warm shell instead of falling back to a cold spawn.
  for (let i = 0; i < 20 && helperBusy; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (helperBusy || !helper) return null;

  // TEXT FIRST. One clipboard call instead of the full probe's three, so the common paste answers in a
  // third of the round-trips.
  helperBusy = true;
  let out;
  try {
    out = await helperRun(CLIP_PROBE_TEXT, HELPER_CMD_MS);
  } finally {
    helperBusy = false;
  }
  const parsed = out == null ? null : parseClipResult(out);
  // Text found — done. An EMPTY answer means there is no text, so the clipboard holds a file or an
  // image and the full probe is worth its cost.
  if (parsed) return parsed;

  helperBusy = true;
  let out2;
  try {
    out2 = await helperRun(CLIP_PROBE, HELPER_CMD_MS);
  } finally {
    helperBusy = false;
  }
  return out2 == null ? null : parseClipResult(out2);
}

export function readClipboardContent() {
  if (!win()) {
    try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
  }
  // Synchronous API is required by the caller, so use a one-shot PowerShell here
  // and let the async path (readClipboardContentAsync) use the warm helper. The exe
  // is the one the helper resolved — `powershell` 5.1 measured 11.5s on the same
  // probe that `pwsh` did in 1.9s, and the old 8s deadline turned that into a
  // spurious "clipboard unavailable".
  const scriptFile = clipScriptPath();
  if (!scriptFile) return { text: '', via: 'none' };
  const out = runPowershell(
    `-NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
    { encoding: 'utf8', windowsHide: true, timeout: ONESHOT_MS },
  );
  if (out == null) return { text: '', via: 'none' };
  return parseClipResult(out) || { text: '', via: 'none' };
}

// ---- the fast path's memory --------------------------------------------------
//
// `GetClipboardSequenceNumber` is one integer, and Windows bumps it on every clipboard write. Asking the
// helper for it is a single cheap call; when it matches the last read, the previous result is returned without
// touching the clipboard at all. That is what makes a repeat paste instant regardless of how long the text is —
// the read cost scaled with the payload, but the sequence check does not.
let lastSeq = null;
let lastResult = null;
/** The sequence number alone, read on the warm helper. Null when it is not available. */
async function readClipboardSequence() {
  warmClipboard();
  if (!helper) return null;
  if (!helperReady && !await waitHelperReady(HELPER_READY_MS)) return null;
  if (helperBusy) return null;               // somebody is mid-command; the caller can just read normally
  helperBusy = true;
  let out;
  try {
    out = await helperRun(CLIP_SEQ_PROBE, HELPER_CMD_MS);
  } finally {
    helperBusy = false;
  }
  const line = String(out || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('S::'));
  if (!line) return null;
  const n = Number(line.slice(3));
  return Number.isFinite(n) ? n : null;
}

// Async version that prefers the warm helper (~10ms) over a cold spawn (~2.9s).
export async function readClipboardContentAsync() {
  if (!win()) {
    try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
  }
  // A CLIPBOARD THAT HAS NOT CHANGED IS NOT READ AGAIN.
  //
  // The measured cost of a read is dominated by the payload (14ms for 1k characters, 48ms for 400k) and the
  // user pays it on every paste even when the clipboard holds the same thing. The sequence number answers "did
  // it change" in one cheap call, so a repeat paste of the same large text is instant.
  const seq = await readClipboardSequence();
  if (seq !== null && seq === lastSeq && lastResult) return { ...lastResult };
  const viaHelper = await readViaHelper();
  const result = viaHelper || readClipboardContent();
  if (seq !== null) { lastSeq = seq; lastResult = result; }
  return result;
}

// The PowerShell logic for the one-shot fallback lives in a temp .ps1 file:
// passing a multi-line script via -Command "..." mangles its own quotes on
// Windows, so we write the script once and re-use it by path.
let _clipScript = null;
function clipScriptPath() {
  if (_clipScript) return _clipScript;
  const p = path.join(os.tmpdir(), 'hncode-clipread.ps1');
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // .NET clipboard for BOTH files and images. `Get-Clipboard -Format FileDropList` is missing from
    // PowerShell 7, and with SilentContinue that turned a copied file into "nothing on the clipboard".
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($files -and $files.Count -gt 0) { $files | ForEach-Object { "F::" + $_ }; exit }',
    // .NET, not the cmdlet: the cmdlet copies the string several times before the pipeline sees it.
    '$txt = [System.Windows.Forms.Clipboard]::GetText()',
    'if ($txt) { "T::" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($txt)); exit }',
    // .NET clipboard, not `Get-Clipboard -Image` (see the CLIP_PROBE note).
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -ne $img) {',
    '  $path = Join-Path $env:TEMP ("hncode-paste-" + [guid]::NewGuid().ToString("N") + ".png")',
    '  $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  "I::" + $path',
    '}',
    '',
  ].join('\n');
  try { fs.writeFileSync(p, script, 'utf8'); } catch { return null; }
  _clipScript = p;
  return p;
}
