// The first clipboard paste after startup must return what is ON THE CLIPBOARD.
//
// THE BUG THIS PINS
// -----------------
// The warm sequence writes a sentinel to the helper shell so the assembly load is
// distinguishable from a command answer. It used to be written WITHOUT a queued
// resolver ("so it drains from the buffer"), on the assumption that nothing else
// could be in flight yet. A read that arrived before that sentinel came back put its
// resolver in the queue first, so the SENTINEL consumed the READ's slot and resolved
// it with its own empty output: the paste said "Clipboard empty or unavailable", the
// real answer arrived afterwards with nobody left to receive it, and `helperBusy` was
// cleared while the probe was still running. Reproduced before the fix — the read got
// "", and the payload was dropped.
//
// The failure needs a REAL PowerShell (it is about sentinel ordering on a live pipe),
// so this test builds the same protocol against the same shell. It SKIPS when the
// shell cannot be started, rather than reporting a pass it did not earn.

import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';

const SENT = '@@HNCODE_CLIP@@';

/** Can we run PowerShell at all? */
function powershellExe() {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      cp.execSync(`${exe} -NoProfile -Command exit`, { windowsHide: true, timeout: 20000, stdio: 'ignore' });
      return exe;
    } catch { /* try the next one */ }
  }
  return null;
}

const EXE = process.platform === 'win32' ? powershellExe() : null;

test('a read that races the warm sentinel is answered by its OWN command', { skip: !EXE && 'no PowerShell available' }, async () => {
  // A stand-in for clipboard.js's helper protocol, reduced to what the bug is about:
  // one resolver per sentinel, in order.
  const shell = cp.spawn(EXE, ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let ready = false;
  const queue = [];
  shell.stdout.on('data', (d) => {
    buf += d.toString('binary');
    let i;
    while ((i = buf.indexOf(SENT)) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + SENT.length);
      const w = queue.shift();
      if (w) w(chunk);
    }
  });
  const run = (script, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    queue.push((out) => { clearTimeout(timer); resolve(out); });
    shell.stdin.write(script + `\n'${SENT}'\n`);
  });

  try {
    // The warm sequence, with its sentinel QUEUED — the fix. The warm command is slow
    // on purpose here (a short sleep), so the race window is wide enough to be real.
    const warmSentinel = run("$x=0;1..20|ForEach-Object{$x+=1};Start-Sleep -Milliseconds 600;''", 30000)
      .then(() => { ready = true; });

    // A read arriving while the warm sentinel is still in flight: the reported case.
    const read = run("'T::cmVhZC1vd24tYW5zd2Vy'", 30000);

    const [readOut] = await Promise.all([read, warmSentinel]);
    assert.equal(String(readOut).trim(), 'T::cmVhZC1vd24tYW5zd2Vy',
      'the read was answered by the warm sentinel instead of its own command');
    assert.ok(ready, 'the warm sentinel must be the one that marks the shell ready');
  } finally {
    shell.kill();
  }
});

test('clipboard.js gives the warm sentinel its own queue slot', async () => {
  // The behavioural test above builds the protocol by hand; this one pins that the
  // shipped module is the version that does it — a revert to the unqueued sentinel
  // would leave the hand-built test passing and the real code broken. The warming
  // code is inside a closure, so the assertion is at the source level (the same
  // technique stream-wiring.test.mjs uses).
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'clipboard.js'), 'utf8');
  const start = src.indexOf('helperQueue.push(() => { helperReady = true; });');
  assert.ok(start > 0, 'the warm sentinel must have a queued resolver, or it eats a read\'s answer');
  // The write may be a multi-line call (the warm script grew a second statement), so the assertion is on the
  // FIRST `helper.stdin.write` after the queued resolver rather than on one exact line of source.
  const write = src.indexOf('helper.stdin.write(', start);
  assert.ok(write > start, 'the queued resolver must be pushed BEFORE the sentinel is written');
  assert.ok(/Add-Type -AssemblyName System\.Windows\.Forms/.test(src.slice(write, write + 600)),
    'the warm write is the one that preloads the assemblies');
  // And no read may run before the shell says it is ready.
  assert.ok(/waitHelperReady\(HELPER_READY_MS\)/.test(src),
    'reads must wait for readiness instead of being sent to a shell that cannot answer yet');
});
