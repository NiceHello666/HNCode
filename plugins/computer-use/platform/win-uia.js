// Windows UI Automation: the control tree, and acting on a control directly.
//
// WHY THE TREE MATTERS, AND WHY IT BEATS FINDING PIXELS
// ----------------------------------------------------
// A screenshot says what the screen LOOKS like; the automation tree says WHAT IS ON IT. From the
// tree an element arrives with its own BoundingRectangle, its control type, whether it is enabled,
// and whether it responds to Invoke or to a value being set. Three consequences:
//
//   * clicking is done against an element, not a guessed pixel. It survives a moved window, a
//     different DPI, and a theme change, none of which a coordinate survives.
//   * the model can SEARCH ("the button called 保存") instead of describing a location.
//   * a disabled control reports itself as disabled, where a screenshot shows a grey rectangle
//     indistinguishable from a merely quiet one.
//
// The pixels are still needed — a canvas, a game, a custom-drawn pane has no tree — which is why
// both live in this plugin rather than one replacing the other.
import { run, have, unsupported, intArg as toInt } from './util.js';

const isWin = process.platform === 'win32';

// How deep every element walk goes, by default.
//
// ONE value for all of them, because the index an element tool accepts is a POSITION IN A WALK:
// a search at depth 12 and a click resolving at depth 4 are numbering different sets of elements,
// so index 7 from the search addressed a different control when used — silently, since both
// lookups succeed. Sharing the constant is what makes an index mean one thing.
const WALK_DEPTH = 12;

// The node cap every walk shares, for the same reason as the depth: truncating at a different
// point renumbers everything past the cut, so an index from one call would address a different
// element in the next.
const WALK_MAX_NODES = 20000;

// The assembly preamble is shared by every script below. PowerShell caches the loaded assemblies
// per process, and each call is its own process, so this is paid per call (~0.4s). Keeping it in
// one constant means a fix lands everywhere at once.
//
// The OutputEncoding line is the other half: PowerShell writes to a redirected stdout in the
// system ANSI codepage (GBK on a Chinese Windows), while Node decodes as UTF-8, so every element
// name with non-ASCII characters came back as mojibake — the tree showed "С???" where the button
// said 最小化. Forcing UTF-8 on the console makes the bytes match what Node reads.
const PRELUDE = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# A rectangle as "x,y,w,h", with off-screen values normalised to 0.
#
# An element that is not on screen reports NaN or Infinity for its rectangle, and converting either
# to an integer THROWS — "Cannot convert value to type System.Int32", which is reported as a failure
# of the whole call rather than of one quirky element. Collapsed menus, scrolled-away rows and
# virtualised lists all produce these, so every path that reads a rectangle uses this one function.
function FmtRect($r) {
  $x = 0; $y = 0; $w = 0; $h = 0
  if (-not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.X)) { $x = [int]$r.X }
  if (-not [double]::IsNaN($r.Y) -and -not [double]::IsInfinity($r.Y)) { $y = [int]$r.Y }
  if (-not [double]::IsNaN($r.Width) -and -not [double]::IsInfinity($r.Width)) { $w = [int]$r.Width }
  if (-not [double]::IsNaN($r.Height) -and -not [double]::IsInfinity($r.Height)) { $h = [int]$r.Height }
  return ($x.ToString() + ',' + $y.ToString() + ',' + $w.ToString() + ',' + $h.ToString())
}
`;

/** Run a UIA script. */
async function uia(script, { timeoutMs = 60000 } = {}) {
  const exe = (await have('pwsh')) ? 'pwsh' : 'powershell';
  const wrapped = `${PRELUDE}\ntry {\n${script}\n} catch { Write-Output ("__CUERR__" + $_.Exception.Message) }`;
  const out = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', wrapped], { timeoutMs });
  const err = /__CUERR__(.*)/.exec(out);
  if (err) throw new Error(err[1].trim());
  return out;
}

/**
 * The PowerShell that walks the tree and prints one line per element.
 *
 * A tab-separated line rather than JSON: PowerShell's JSON conversion of a UIA element would mean
 * materialising every property of every node, which is the slow part. The six fields the model
 * needs are read explicitly, and `depth` is enforced during the walk so a deep app cannot make the
 * enumeration run away before the limit applies.
 */
const WALK = `
# Replace the characters that would break the tab-separated line: the separator itself, and the two
# that END a line. A field containing any of them corrupts the parse — the separator splits one line
# into extra columns, and CR or LF splits it into extra LINES, which shifts every element after it.
function Scrub($v) {
  if ($null -eq $v) { return '' }
  return ([string]$v) -replace "[\\t\\r\\n]", ' '
}
function Walk($root, $maxDepth, $maxNodes, $wantTypes, $returnElements = $false) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($root, 0))
  while ($stack.Count -gt 0 -and $out.Count -lt $maxNodes) {
    $item = $stack.Pop()
    # Only the element and its depth travel on the stack. The index is this element's POSITION among
    # the ones emitted so far, computed here, so it is unique and in walk order.
    $el = $item[0]; $depth = $item[1]
    $c = $el.Current
    $ct = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $include = $true
    if ($wantTypes -and $wantTypes.Count -gt 0) { $include = $wantTypes -contains $ct }
    if ($include) {
      # The index is this element's POSITION among the ones emitted, so it is assigned HERE —
      # inside the branch that emits. Reading it before the include test gave a filtered-out
      # element an index it never used, leaving a GAP: a walk returning 200 elements numbered
      # 0..200 with 126 missing, so [126] resolved to nothing.
      $idx = $out.Count
      $r = $c.BoundingRectangle
      $nm = $c.Name
      if ($null -eq $nm) { $nm = '' }
      $aid = $c.AutomationId
      if ($null -eq $aid) { $aid = '' }
      $cls = $c.ClassName
      if ($null -eq $cls) { $cls = '' }
      # A rectangle that is not on screen comes back as NaN or Infinity, and converting either to
      # an integer throws. Normalise to 0 so the walk survives an off-screen or virtualised element
      # — common (collapsed menus, scrolled-away rows) and it must not abort the whole tree.
      $x = 0; $y = 0; $w = 0; $h = 0
      if (-not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.X)) { $x = [int]$r.X }
      if (-not [double]::IsNaN($r.Y) -and -not [double]::IsInfinity($r.Y)) { $y = [int]$r.Y }
      if (-not [double]::IsNaN($r.Width) -and -not [double]::IsInfinity($r.Width)) { $w = [int]$r.Width }
      if (-not [double]::IsNaN($r.Height) -and -not [double]::IsInfinity($r.Height)) { $h = [int]$r.Height }
      # index, depth, controlType, name, automationId, class, x, y, w, h, enabled — the line the tree
      # tool prints. Built only when it is wanted: rendering every node and then discarding the text
      # is work the resolution path does not need.
      #
      # CONTENT is carried alongside the name, because a control's name is often empty while its
      # TEXT is not. An application with no real controls — a game, a canvas, a chat client that
      # draws its own panes — still exposes its readable content through ValuePattern for an input
      # or TextPattern for a document, and nothing else will find it. This is the only route to the
      # actual words on such a window.
      $val = ''
      try {
        $vp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
          $val = [string]([System.Windows.Automation.ValuePattern]$vp).Current.Value
        }
      } catch { }
      $txt = ''
      try {
        $tp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
          $txt = [string]([System.Windows.Automation.TextPattern]$tp).DocumentRange.GetText(-1)
        }
      } catch { }
      # EVERY field goes through the same scrub, and the scrub covers tab, CR and LF together.
      #
      # The separator is a tab, so a tab INSIDE a field splits the line into too many columns. A CR
      # or LF inside a field is worse: it ends the line early, so one element becomes two lines and
      # every element after it is off by one — 200 elements parsed as 191, with a hole in the
      # numbering where the split happened. A control's Name genuinely can contain a newline (a
      # multi-line tooltip or label), so this is data, not a pathological case.
      #
      # Only the content fields were scrubbed before, which is why the defect looked intermittent.
      $line = ($idx.ToString() + "\`t" + $depth.ToString() + "\`t" + $ct + "\`t" +
               (Scrub $nm) + "\`t" + (Scrub $aid) + "\`t" +
               (Scrub $cls) + "\`t" +
               $x.ToString() + "\`t" + $y.ToString() + "\`t" +
               $w.ToString() + "\`t" + $h.ToString() + "\`t" +
               $c.IsEnabled.ToString() + "\`t" +
               (Scrub $val) + "\`t" +
               (Scrub $txt))
      # The element itself when the caller wants to ACT on it, the printable line otherwise. One walk
      # serves both: the tree tool renders, the selector needs the AutomationElement itself, and a
      # second traversal would number the tree a second way.
      if ($returnElements) { $out.Add($el) | Out-Null } else { $out.Add($line) | Out-Null }
    }
    if ($depth -lt $maxDepth) {
      $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                          [System.Windows.Automation.Condition]::TrueCondition)
      # Children are pushed WITHOUT an index and numbered when they are emitted, in the same order.
      # Pushing a number here was the bug: every sibling read the same running count, so six tab
      # items all became index 7 and an index matched several different elements.
      for ($k = $kids.Count - 1; $k -ge 0; $k--) {
        $stack.Push(@($kids[$k], ($depth + 1)))
      }
    }
  }
  return $out
}

`;

/** Parse the tab-separated walk output into element objects. */
export function parseElements(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || !line.includes('\t')) continue;
    const f = line.split('\t');
    // THE COLUMN COUNT IS THE CONTRACT, BOTH WAYS. A tab inside a name splits one field into two, so the row
    // grows a column and every field after it shifts — the element then reports x=0 and enabled=false, and a
    // click lands somewhere else entirely, with no error anywhere. A SHORT row is an older emitter that carried
    // fewer fields; a LONG one is corruption. The walk escapes tabs, so this only fires when that guarantee
    // breaks, and dropping the line is better than acting on numbers that describe a different element.
    if (f.length < 11 || f.length > 13) continue;
    const coords = [f[6], f[7], f[8], f[9]].map((v) => Number(v));
    // A shifted row parses as NaN here, which is the second tell of the same corruption.
    if (coords.some((n) => !Number.isFinite(n))) continue;
    out.push({
      index: Number(f[0]),
      depth: Number(f[1]),
      controlType: f[2],
      name: f[3],
      automationId: f[4],
      className: f[5],
      x: coords[0], y: coords[1], width: coords[2], height: coords[3],
      enabled: /true/i.test(f[10]),
      // Absent from output written before the walk carried them, so a missing field is simply empty
      // rather than a reason to reject the line.
      value: f[11] || '',
      text: f[12] || '',
    });
  }
  return out;
}

/**
 * The control tree of a window, or of the whole desktop.
 *
 * `depth` defaults to 4: enough for a dialog or a form, which is where automation is useful, and
 * shallow enough that a browser window does not return its entire render tree. A caller that
 * genuinely needs more raises it, and `maxNodes` caps the result whatever it asks for.
 */
export async function getTree({ hwnd, depth = WALK_DEPTH, maxNodes = WALK_MAX_NODES, controlTypes } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const wants = Array.isArray(controlTypes) && controlTypes.length
    ? `@(${controlTypes.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(',')})`
    : '$null';
  // RootElement is the desktop; a window is found by handle. HWND is the process-wide native
  // handle, and FromHandle is how UIA turns it back into an element.
  const root = hwnd
    ? `[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})`
    : '[System.Windows.Automation.AutomationElement]::RootElement';
  const depthUsed = toInt(depth, WALK_DEPTH, 1, 30);
  const maxUsed = toInt(maxNodes, WALK_MAX_NODES, 1, 20000);
  const script = `${WALK}
$root = ${root}
if ($null -eq $root) { Write-Output '__CUERR__no window with that handle'; exit }
$rootEl = $root.Current
Write-Output ('#root' + "\`t" + (Scrub $rootEl.ControlType.ProgrammaticName) + "\`t" + (Scrub $rootEl.Name))
# The walk parameters are emitted WITH the elements, because an index is only meaningful relative
# to the walk that produced it. Anything resolving an index later replays exactly these numbers, so
# a tree read at depth 4 and an index resolved at depth 30 cannot disagree about element 7.
Write-Output ('#spec' + "\`t" + '${depthUsed}' + "\`t" + '${maxUsed}')
Walk $root ${depthUsed} ${maxUsed} ${wants} | ForEach-Object { Write-Output $_ }
`;
  const out = await uia(script);
  const rootLine = /#root\t([^\t]*)\t?(.*)/.exec(out);
  const elements = parseElements(out);
  return {
    root: rootLine ? { controlType: String(rootLine[1]).replace('ControlType.', ''), name: rootLine[2] || '' } : null,
    elements,
    // What produced these indices, so they can be replayed.
    spec: { depth: depthUsed, maxNodes: maxUsed },
    truncated: elements.length >= maxUsed,
  };
}

/**
 * Find elements matching a query.
 *
 * Filters are applied in PowerShell where possible, but the NAME match is done here rather than
 * with UIA's `PropertyCondition`: UIA needs an exact string, while a caller wants "the button with
 * 保存 on it". A substring match needs the names anyway, so the walk produces them once.
 *
 * The walk depth MATTERS, because the indices it produces are what every element-addressed tool
 * accepts. `getTree`'s default is 4; searching needs deeper, so this uses 12 — and it records that
 * choice in the returned `spec` so a later `selectorScript` replays the SAME walk. Without that,
 * index 7 from a depth-12 search and index 7 from a depth-30 resolve addressed different elements,
 * and `GetElementInfo` reported a control from elsewhere in the window.
 */
export async function findElements({ hwnd, name, controlType, automationId, className, exact = false, limit = 50, depth = 12, enabledOnly = false } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const walkDepth = toInt(depth, 12, 1, 30);
  const all = await getTree({ hwnd, depth: walkDepth, maxNodes: WALK_MAX_NODES });
  if (Array.isArray(all)) return all;
  const want = typeof name === 'string' ? name : '';
  const needle = want.toLowerCase();
  const match = (v, pattern) => {
    if (!pattern) return true;
    const s = String(v || '');
    return exact ? s === pattern : s.toLowerCase().includes(String(pattern).toLowerCase());
  };
  const hits = all.elements.filter((e) => {
    if (enabledOnly && !e.enabled) return false;
    if (controlType && e.controlType !== controlType) return false;
    if (automationId && !match(e.automationId, automationId)) return false;
    if (className && !match(e.className, className)) return false;
    if (needle && !e.name.toLowerCase().includes(needle)) return false;
    return true;
  });
  return { matches: hits.slice(0, toInt(limit, 50, 1, 500)), total: hits.length };
}

/** One element's details, including the patterns it supports. */
export async function elementInfo({ hwnd, index, name, automationId, walkDepth = WALK_DEPTH } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const found = await locate({ hwnd, index, name, automationId });
  if (Array.isArray(found)) return found;
  const { element } = found;
  // locate already validated the selector; this second call reports what
  // the element actually supports, which needs the element itself, not just its index.
  const patterns = await uia(`${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }
$c = $el.Current
$r = $c.BoundingRectangle
Write-Output ("name=" + $c.Name)
Write-Output ("type=" + ($c.ControlType.ProgrammaticName -replace 'ControlType\\.',''))
Write-Output ("rect=" + (FmtRect $r))
Write-Output ("enabled=" + $c.IsEnabled)
Write-Output ("offscreen=" + $c.IsOffscreen)
Write-Output ("focusable=" + $c.IsKeyboardFocusable)
Write-Output ("focused=" + $c.HasKeyboardFocus)
$pats = @()
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$null)) { $pats += 'Invoke' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$null)) { $pats += 'Value' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$null)) { $pats += 'SelectionItem' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$null)) { $pats += 'ExpandCollapse' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$null)) { $pats += 'ScrollItem' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$null)) { $pats += 'Toggle' }
Write-Output ("patterns=" + ($pats -join ','))
$v = $el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)
if ($null -ne $v) { Write-Output ("value=" + $v) }
`);
  const info = { ...element };
  for (const line of patterns.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'rect') {
      const [x, y, w, h] = m[2].split(',').map(Number);
      Object.assign(info, { x, y, width: w, height: h });
    } else if (m[1] === 'patterns') {
      info.patterns = m[2] ? m[2].split(',') : [];
    } else if (m[1] === 'enabled' || m[1] === 'offscreen' || m[1] === 'focusable' || m[1] === 'focused') {
      info[m[1]] = /true/i.test(m[2]);
    } else {
      info[m[1]] = m[2];
    }
  }
  return info;
}

/**
 * The PowerShell that resolves an element from an index, a name, or an automation id.
 *
 * `walkDepth` must be the depth the INDEX came from — see the note in `findElements`. It defaults
 * to the tree's own default, so a caller that read a tree at the default depth need not pass it.
 */
function selectorScript({ hwnd, index, name, automationId, walkDepth = WALK_DEPTH }) {
  const root = hwnd
    ? `[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})`
    : '[System.Windows.Automation.AutomationElement]::RootElement';
  const lines = [`$root = ${root}`];
  if (index != null) {
    // Resolve with Walk ITSELF, asked to return the element objects rather than the printed lines.
    //
    // There used to be a second traversal here, and a second traversal is a second way to number the
    // same tree: Silent counted every node while Walk counts only what it includes, so an index
    // from a search addressed a different control when resolved. Reusing the one function means an
    // index cannot mean two things, whatever either side does later.
    const d = toInt(walkDepth, WALK_DEPTH, 1, 30);
    const n = toInt(index, 0);
    lines.push(`${WALK}`);
    lines.push(`$all = @(Walk $root ${d} ${WALK_MAX_NODES} $null $true)`);
    lines.push(`if (${n} -ge $all.Count) { Write-Output ('__CUERR__index ${n} is out of range: a ${d}-level walk found ' + $all.Count + ' element(s)') ; exit }`);
    lines.push(`$el = $all[${n}]`);
  } else if (automationId) {
    // New-Object must be ASSIGNED to a variable first: writing it inline as an argument produces
    // ... , New-Object ... which PowerShell rejects with "Missing expression after ','". The same
    // applies to the name branch below.
    const lit = String(automationId).replace(/'/g, "''");
    lines.push(`$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${lit}')`);
    lines.push(`$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)`);
  } else if (name) {
    const lit = String(name).replace(/'/g, "''");
    lines.push(`$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${lit}')`);
    lines.push(`$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)`);
  } else {
    lines.push(`$el = $null`);
    lines.push(`Write-Output '__CUERR__pass one of: index, name, automationId'`);
    lines.push('exit');
  }
  return lines.join('\n');
}

/** Resolve one element; returns `{ element }` or an error array for the caller to pass on. */
async function locate(opts) {
  // A light local resolution, only to validate and to hand back a description. The PowerShell
  // script performs the real lookup; this exists so a bad selector fails with a message rather
  // than an index error deep in a script.
  if (opts.index == null && !opts.name && !opts.automationId) {
    return [{ error: 'pass one of: index, name, automationId' }];
  }
  return { element: { selector: opts } };
}

/** Click an element, preferring Invoke over the mouse. */
/**
 * Click an element, preferring a semantic pattern over a synthetic mouse event.
 *
 * WHY THE ORDER MATTERS
 * ---------------------
 * A coordinate click is delivered to whatever is AT that pixel. If anything covers the element — a
 * dialog, another window, a toast — the click lands on the covering thing instead, and the model is
 * told the click succeeded. `InvokePattern` calls the control's own activation handler directly, so
 * it cannot miss, cannot be intercepted, and works for an element the user cannot see.
 *
 * The chain, each step only if the previous cannot work:
 *
 *   1. `InvokePattern`             the control's own click handler
 *   2. `SelectionItemPattern`      for a list item or tab that "activates" by being selected
 *   3. a real mouse click          needs the element on screen
 *
 * `via` names the step that worked, because "clicked" and "clicked by pattern" fail differently: a
 * pattern click works on a hidden element, a mouse click does not, and knowing which happened is
 * what lets the next call adapt.
 *
 * A right or middle click, or a multi-click, skips straight to the mouse: the patterns have no
 * notion of a button or a count.
 */
export async function clickElement({ hwnd, index, name, automationId, walkDepth = WALK_DEPTH, button = 'left', clicks = 1 } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const n = toInt(clicks, 1, 1, 3);
  const wantPattern = button === 'left' && n === 1;

  const script = `${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }

$r = $el.Current.BoundingRectangle
$x = 0; $y = 0; $w = 0; $h = 0
if (-not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.X)) { $x = [int]$r.X }
if (-not [double]::IsNaN($r.Y) -and -not [double]::IsInfinity($r.Y)) { $y = [int]$r.Y }
if (-not [double]::IsNaN($r.Width) -and -not [double]::IsInfinity($r.Width)) { $w = [int]$r.Width }
if (-not [double]::IsNaN($r.Height) -and -not [double]::IsInfinity($r.Height)) { $h = [int]$r.Height }
Write-Output ("rect=" + $x + "," + $y + "," + $w + "," + $h)

${wantPattern ? `
# 1. Invoke — the control's own handler. Preferred for every reason above.
$inv = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
  ([System.Windows.Automation.InvokePattern]$inv).Invoke()
  Write-Output "via=invoke"
  exit
}
# 2. Select — a list item or tab activates by being selected, and has no Invoke.
$sel = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
  ([System.Windows.Automation.SelectionItemPattern]$sel).Select()
  Write-Output "via=select"
  exit
}
` : ''}
# 3. Mouse. Needs a real area: a virtualised or collapsed element has none, and clicking its
# "centre" would be clicking (0,0).
if ($w -le 0 -or $h -le 0) {
  Write-Output '__CUERR__the element has no area, so it cannot be clicked at: it is off screen or virtualised (scroll it into view first)'
  exit
}
Write-Output ("center=" + [int]($x + $w / 2) + "," + [int]($y + $h / 2))
`;

  const out = await uia(script);

  if (/via=invoke/.test(out)) return { via: 'invoke' };
  if (/via=select/.test(out)) return { via: 'select' };

  const m = /center=(-?\d+),(-?\d+)/.exec(out);
  if (!m) throw new Error(`could not locate the element to click: ${out.trim().slice(0, 200)}`);
  const { clickAt } = await import('./win-input.js');
  await clickAt(Number(m[1]), Number(m[2]), { button, clicks: n });
  return { x: Number(m[1]), y: Number(m[2]), button, clicks: n, via: 'mouse' };
}

/**
 * Put text into a field, trying three patterns in order.
 *
 * ONE PATTERN IS NOT ENOUGH. `ValuePattern` covers an ordinary edit box, but a SLIDER or a spinner
 * exposes `RangeValuePattern` and nothing else, and an older or self-drawn control — which covers
 * much of what a desktop actually runs — only answers `LegacyIAccessiblePattern`. Reporting "no
 * Value pattern" for those was true and useless: the field could be filled, and the tool refused.
 *
 *   ValuePattern            an ordinary text field or combo box
 *   RangeValuePattern       a slider or a numeric spinner, where the text is a number
 *   LegacyIAccessiblePattern  the MSAA bridge, which is all a pre-UIA control has
 *
 * `via` names the one that worked, so a caller can tell a value that was set from one that was only
 * approximated — the legacy route takes a string and a control may round it.
 */
export async function setElementText({ hwnd, index, name, automationId, text, walkDepth = WALK_DEPTH } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const literal = String(text == null ? '' : text).replace(/'/g, "''");
  const script = `${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }
$el.SetFocus()

# 1. Value pattern — the ordinary case.
$vp = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
  ([System.Windows.Automation.ValuePattern]$vp).SetValue('${literal}')
  Write-Output 'via=value'
  exit
}

# 2. RangeValue — a slider or spinner. The value arrives as text and has to become a number.
$rp = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$rp)) {
  $num = 0.0
  if ([double]::TryParse('${literal}', [ref]$num)) {
    ([System.Windows.Automation.RangeValuePattern]$rp).SetValue($num)
    Write-Output 'via=rangevalue'
    exit
  }
  Write-Output '__CUERR__the element takes a number (RangeValue) and the text did not parse as one'
  exit
}

# 3. LegacyIAccessible — an older control, reached through the MSAA bridge. SetValue takes a string.
$lp = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$lp)) {
  ([System.Windows.Automation.LegacyIAccessiblePattern]$lp).SetValue('${literal}')
  Write-Output 'via=legacy'
  exit
}

# Nothing could set it. Say what is on offer rather than only what is missing, so the caller can
# choose: type into it instead, or leave it alone.
$have = @()
$probe = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$probe)) { $have += 'Invoke' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$probe)) { $have += 'SelectionItem' }
if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$probe)) { $have += 'Toggle' }
Write-Output ('__CUERR__nothing here can hold text; the element supports: ' + $(if ($have.Count) { $have -join ', ' } else { 'no settable pattern' }) + '. Use KeyboardType after clicking it, or ClipboardWrite then Ctrl+V.')
`;
  const out = await uia(script);
  const via = /via=(\w+)/.exec(out);
  if (!via) throw new Error(out.trim().slice(0, 300) || 'SetValue failed');
  return { ok: true, via: via[1] };
}

/**
 * Select a list item, menu item or tab.
 *
 * THE PARENT WALK IS THE POINT. `SelectionItemPattern` lives on the ITEM, but a lookup usually lands
 * on something INSIDE it — the text node of a list row, the label of a menu entry. In a browser tree
 * that is the common case rather than an edge one: the accessible name the model matches belongs to
 * the Text node, while the pattern belongs to the ListItem above it. Without the walk the tool
 * reported "not selectable" for an item that was perfectly selectable.
 *
 * `via` records how far up the pattern was found, so a direct hit is distinguishable from an
 * inferred one.
 */
export async function selectElement({ hwnd, index, name, automationId, walkDepth = WALK_DEPTH } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const script = `${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }

# Walk up from the element towards the root, capped so a malformed tree cannot loop forever.
$node = $el
$hops = 0
while ($null -ne $node -and $hops -le 6) {
  $sp = $null
  if ($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
    ([System.Windows.Automation.SelectionItemPattern]$sp).Select()
    if ($hops -eq 0) { Write-Output 'via=direct' } else { Write-Output ("via=parent+" + $hops) }
    exit
  }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $walker.GetParent($node)
  $hops++
}
Write-Output '__CUERR__neither this element nor anything up to 6 levels above it is selectable; use ClickElement instead'
`;
  const out = await uia(script);
  const via = /via=(\S+)/.exec(out);
  if (!via) throw new Error(out.trim().slice(0, 220) || 'select failed');
  return { ok: true, via: via[1] };
}

/** Expand or collapse a tree node, menu, or combo box. */
export async function expandCollapse({ hwnd, index, name, automationId, expand = true, walkDepth = WALK_DEPTH } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const call = expand ? 'Expand()' : 'Collapse()';
  const script = `${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }
$ep = $null
if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) {
  Write-Output '__CUERR__that element cannot be expanded (no ExpandCollapse pattern)'
  exit
}
$ep.${call}
Write-Output 'ok'
`;
  const out = await uia(script);
  if (!/ok/.test(out)) throw new Error(out.trim().slice(0, 200) || 'expand/collapse failed');
  return { ok: true };
}

/** Scroll a container so an element is in view. */
export async function scrollIntoView({ hwnd, index, name, automationId, walkDepth = WALK_DEPTH } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const script = `${WALK}
${selectorScript({ hwnd, index, name, automationId, walkDepth })}
if ($null -eq $el) { Write-Output '__CUERR__no matching element'; exit }
$sp = $null
if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$sp)) {
  Write-Output '__CUERR__that element is not a scroll item'
  exit
}
$sp.ScrollIntoView()
Write-Output 'ok'
`;
  const out = await uia(script);
  if (!/ok/.test(out)) throw new Error(out.trim().slice(0, 200) || 'scroll failed');
  return { ok: true };
}

/**
 * Right-click a point, then find the menu that appeared.
 *
 * A context menu is a SEPARATE top-level window, not part of the window that was clicked — so after
 * a bare right click the model knows nothing about what it just opened and cannot read the items to
 * choose one. Every such menu is a window of class `#32768`, which is how it is found.
 *
 * The search is bounded by distance because several menus can exist at once (a stale one from a
 * previous click), and the one that just opened is the one nearest the click.
 */
export async function findMenuWindowNear(x, y, { maxDistance = 600 } = {}) {
  if (!isWin) return unsupported('window enumeration on Windows only');
  const script = [
    'Add-Type @"',
    'using System; using System.Text; using System.Runtime.InteropServices;',
    'public class CuMenu {',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
    '  delegate bool EnumProc(IntPtr h, IntPtr p);',
    '  public static System.Collections.Generic.List<string> Find() {',
    '    var outp = new System.Collections.Generic.List<string>();',
    '    EnumWindows((h, p) => {',
    '      if (!IsWindowVisible(h)) return true;',
    '      var sb = new StringBuilder(256);',
    '      GetClassName(h, sb, 256);',
    '      if (sb.ToString() != "#32768") return true;',
    '      RECT r; GetWindowRect(h, out r);',
    '      outp.Add(h.ToString() + "\\t" + r.L + "\\t" + r.T + "\\t" + (r.R - r.L) + "\\t" + (r.B - r.T));',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return outp;',
    '  }',
    '}',
    '"@',
    '[CuMenu]::Find() | ForEach-Object { Write-Output $_ }',
  ].join('\n');
  const out = await uia(script);
  const candidates = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split('\t');
    if (f.length < 5) continue;
    const [, mx, my, mw, mh] = f.map(Number);
    const cx = mx + mw / 2;
    const cy = my + mh / 2;
    const dist = Math.hypot(cx - x, cy - y);
    candidates.push({ hwnd: f[0], x: mx, y: my, width: mw, height: mh, distance: Math.round(dist) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best || best.distance > maxDistance) return { found: false, candidates: candidates.length };
  return { found: true, ...best, candidates: candidates.length };
}

/** The element that currently has keyboard focus. */

/** The element that currently has keyboard focus. */
export async function focusedElement() {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const out = await uia(`
$el = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $el) { Write-Output '__CUERR__nothing has focus'; exit }
$c = $el.Current
$r = $c.BoundingRectangle
Write-Output ("type=" + ($c.ControlType.ProgrammaticName -replace 'ControlType\\.',''))
Write-Output ("name=" + $c.Name)
Write-Output ("automationId=" + $c.AutomationId)
Write-Output ("class=" + $c.ClassName)
Write-Output ("rect=" + (FmtRect $r))
Write-Output ("enabled=" + $c.IsEnabled)
$v = $el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)
if ($null -ne $v) { Write-Output ("value=" + $v) }
`);
  const info = {};
  for (const line of out.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'rect') {
      const [x, y, w, h] = m[2].split(',').map(Number);
      Object.assign(info, { x, y, width: w, height: h });
    } else info[m[1]] = m[2];
  }
  return info;
}

/**
 * Wait for an element to appear or disappear.
 *
 * Polling in Node rather than in PowerShell, because each PowerShell call pays the assembly load
 * (~0.4s) and a wait is many checks. The caller's timeout bounds the loop.
 */
export async function waitForElement({ hwnd, name, automationId, controlType, state = 'appear', timeoutMs = 15000 } = {}) {
  if (!isWin) return unsupported('the UI Automation tree on Windows only');
  const deadline = Date.now() + toInt(timeoutMs, 15000, 100, 300000);
  const wantPresent = state !== 'disappear';
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await findElements({ hwnd, name, automationId, controlType, limit: 1 });
    } catch (e) {
      last = { matches: [], total: 0 };
    }
    const present = !!(last && last.matches && last.matches.length);
    if (present === wantPresent) return { found: present, element: present ? last.matches[0] : null };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: !wantPresent, timedOut: true, element: null };
}

export { isWin };
