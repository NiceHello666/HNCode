// One surface over three platforms.
//
// WHY THIS EXISTS
// ---------------
// Windows needs THREE modules where macOS and Linux need one each. That is not an accident of
// organisation: Add-Type compiles a C# snippet into the PowerShell process, and the UIAutomation
// assemblies and the SendInput INPUT structure cannot coexist in one compiled unit without
// conflicting type names. So the Windows side is split — capture and windows, the automation tree,
// and input — while mac and Linux each have a single file.
//
// The tools must not care. This module presents the union, picking the implementation per platform,
// so a tool calls dispatch.getTree(...) and gets the same shape whether the machine is Windows,
// macOS or a Wayland desktop. A capability a platform lacks is reported by the backend as
// { unsupported } and travels through unchanged.
//
// The prefix that matters is the CAPABILITY, not the module: capture, tree, input, window.
import * as util from './util.js';

const PLATFORM = process.platform;

let impl = null;

/** Load the backends for this platform. Cached: the modules are stateless. */
async function backends() {
  if (impl) return impl;
  if (PLATFORM === 'win32') {
    const [win, uia, input, ocr] = await Promise.all([
      import('./windows.js'),
      import('./win-uia.js'),
      import('./win-input.js'),
      import('./win-ocr.js'),
    ]);
    impl = {
      platform: 'windows',
      screenBounds: win.screenBounds,
      captureRegion: win.captureRegion,
      captureWindow: win.captureWindow,
      listWindows: win.listWindows,
      windowRect: win.windowRect,
      focusWindow: win.focusWindow,
      resizeWindow: win.resizeWindow,
      closeWindow: win.closeWindow,
      getWindowInfo: win.getWindowInfo,
      setWindowState: win.setWindowState,
      waitForWindow: win.waitForWindow,
      listDisplays: win.listDisplays,
      listApps: win.listApps,
      launchApp: win.launchApp,
      terminateProcess: win.terminateProcess,
      readPixel: win.readPixel,
      copyText: util.copyText,
      readClipboard: util.readClipboard,
      getTree: uia.getTree,
      findElements: uia.findElements,
      elementInfo: uia.elementInfo,
      focusedElement: uia.focusedElement,
      waitForElement: uia.waitForElement,
      clickElement: uia.clickElement,
      setElementText: uia.setElementText,
      selectElement: uia.selectElement,
      expandCollapse: uia.expandCollapse,
      scrollIntoView: uia.scrollIntoView,
      findMenuWindowNear: uia.findMenuWindowNear,
      ocrImage: ocr.ocrImage,
      moveTo: input.moveTo,
      cursorPos: input.cursorPos,
      clickAt: input.clickAt,
      clickHere: input.clickHere,
      drag: input.drag,
      scroll: input.scroll,
      typeText: input.typeText,
      keyPress: input.keyPress,
    };
    return impl;
  }
  if (PLATFORM === 'darwin') {
    const mac = await import('./macos.js');
    const access = await import('./mac-input.js');
    impl = {
      platform: 'macos',
      screenBounds: mac.screenBounds,
      captureRegion: mac.captureRegion,
      captureWindow: mac.captureWindow,
      listWindows: mac.listWindows,
      windowRect: mac.windowRect,
      focusWindow: mac.focusWindow,
      resizeWindow: mac.resizeWindow,
      closeWindow: mac.closeWindow,
      getWindowInfo: mac.getWindowInfo,
      setWindowState: mac.setWindowState,
      waitForWindow: mac.waitForWindow,
      listDisplays: mac.listDisplays,
      listApps: access.listApps,
      launchApp: access.launchApp,
      terminateProcess: access.terminateProcess,
      readPixel: access.readPixel,
      getTree: mac.getTree,
      findElements: mac.findElements,
      elementInfo: mac.elementInfo,
      focusedElement: mac.focusedElement,
      waitForElement: mac.waitForElement,
      // Element actions on macOS go through the Accessibility API's AXPress, which needs a real
      // element handle; until that is implemented the tools fall back to coordinates, and these
      // report why rather than failing obscurely.
      clickElement: access.clickElement,
      setElementText: access.setElementText,
      selectElement: access.selectElement,
      expandCollapse: access.expandCollapse,
      scrollIntoView: access.scrollIntoView,
      moveTo: access.moveTo,
      cursorPos: access.cursorPos,
      clickAt: access.clickAt,
      clickHere: access.clickHere,
      drag: access.drag,
      scroll: access.scroll,
      typeText: access.typeText,
      keyPress: access.keyPress,
    };
    return impl;
  }
  if (PLATFORM === 'linux') {
    const lx = await import('./linux.js');
    const access = await import('./linux-input.js');
    impl = {
      platform: 'linux',
      screenBounds: lx.screenBounds,
      captureRegion: lx.captureRegion,
      captureWindow: lx.captureWindow,
      listWindows: lx.listWindows,
      windowRect: lx.windowRect,
      focusWindow: lx.focusWindow,
      resizeWindow: lx.resizeWindow,
      closeWindow: lx.closeWindow,
      getWindowInfo: lx.getWindowInfo,
      setWindowState: lx.setWindowState,
      waitForWindow: lx.waitForWindow,
      listDisplays: lx.listDisplays,
      listApps: access.listApps,
      launchApp: access.launchApp,
      terminateProcess: access.terminateProcess,
      readPixel: access.readPixel,
      getTree: lx.getTree,
      findElements: lx.findElements,
      elementInfo: lx.elementInfo,
      focusedElement: lx.focusedElement,
      waitForElement: lx.waitForElement,
      clickElement: access.clickElement,
      setElementText: access.setElementText,
      selectElement: access.selectElement,
      expandCollapse: access.expandCollapse,
      scrollIntoView: access.scrollIntoView,
      moveTo: access.moveTo,
      cursorPos: access.cursorPos,
      clickAt: access.clickAt,
      clickHere: access.clickHere,
      drag: access.drag,
      scroll: access.scroll,
      typeText: access.typeText,
      keyPress: access.keyPress,
    };
    return impl;
  }
  // An unsupported platform answers every call with the reason, so the tools need no special case.
  const why = `computer use is not implemented on ${PLATFORM}`;
  const always = async () => util.unsupported(why);
  impl = new Proxy({ platform: PLATFORM }, { get: (t, k) => (k in t ? t[k] : always) });
  return impl;
}

/** The backend surface for this machine. */
export async function backend() {
  return backends();
}

/**
 * Call one backend method.
 *
 * A missing method is an unsupported capability, and a THROW is caught and returned as `{ error }`.
 *
 * The catch is the important half. A backend throws for conditions a caller must see rather than
 * retry blindly — an element with no Value pattern, a window that has closed, a program that is not
 * installed — and each one is a sentence the model can act on. Letting it propagate means the error
 * escapes the tool, reaches the agent loop as a bare exception, and arrives with a stack trace
 * instead of advice. Every backend result therefore leaves through here, and the tools only ever
 * see `{ error }`, `{ unsupported }` or a value.
 */
export async function call(method, ...args) {
  const b = await backends();
  const fn = b[method];
  if (typeof fn !== 'function') {
    return util.unsupported(`${method} is not implemented on ${PLATFORM}`);
  }
  try {
    return await fn(...args);
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

/** Which platform this session is on, and what it can do. */
export async function describe() {
  const b = await backends();
  return { platform: b.platform };
}

export { util };
