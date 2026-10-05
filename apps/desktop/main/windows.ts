// Window management helpers: show/hide/close dispatch, Esc handling, dock preference.
// Design: docs/design/window-manager.md.
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { getLiveWindow } from './window-registry.js';
import {
  WEB_CORE_ADDRESS,
  isTestProfile,
  isHeadless,
  DEBUG,
} from './config.js';

// Default background colors for light and dark system themes
// These are used to prevent the white flash when opening new windows
const DARK_BACKGROUND = '#1e1e1e';
const LIGHT_BACKGROUND = '#ffffff';

import {
  getWindowInfo,
  getChildWindows,
} from './main.js';
import { registerGuest } from './webview-guest-registry.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import {
  getWindowModeName,
  dispatchEscapePress,
  getWindowIdFor,
  getNativeWindowFor,
  listMachineWindowRecords,
  getKernelExecutorForApp,
} from './window-machine.js';
import { wmLog } from './window-diag.js';
import type { WindowClass } from './izui-roles.js';
import {
  kernelCloseWindowDirect,
  kernelSetFullscreen,
  kernelShowRequested,
  kernelHideRequested,
  kernelCloseOrHideRequested,
  getKernelExecutor,
} from './window-kernel-dispatch.js';
import { frontWindowHere, isFrontEligibleWindow } from './window-kernel.js';
import {
  initRendererHandledEscapeTracking,
  rendererHandledEscapeForWc,
  clearRendererHandledEscapeForWc,
} from './window-escape-renderer-handled.js';

export function getSystemThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

// Preferences getter - set by index.js during initialization
let _getPrefs: () => Record<string, unknown> = () => ({});

export function setPrefsGetter(getter: () => Record<string, unknown>): void {
  _getPrefs = getter;
}

export function getPrefs(): Record<string, unknown> {
  return _getPrefs();
}

// THIN SEAM (§5 step 6A-2): performs NO OS work. Resolves the machine id and dispatches
// WINDOW_SHOW_REQUESTED; the backend owns the whole show policy (headless opacity-0 trick,
// show() vs showInactive()). `opts.activation: 'user'` marks an activating show a user gesture
// asked for (hotkey, CLI verb), which the kernel raises even while another app is frontmost.
export function showWindowHeadlessSafe(
  win: BrowserWindow,
  opts?: { active?: boolean; activation?: 'user' },
): void {
  const id = getWindowIdFor(win);
  if (id == null) {
    // Every live window registers with the machine; an unregistered handle here is a bug in the
    // open path, not a case to paper over — no direct-OS fallback (R2: only the backend acts).
    DEBUG && console.log('[windows] showWindowHeadlessSafe: window not machine-registered — show dropped');
    return;
  }
  kernelShowRequested(id, opts?.active === true, opts?.activation === 'user' ? { activation: 'user' } : undefined);
}

// Pure function of headless-ness (see apps/desktop/CLAUDE.md's hybrid-focus invariants for why
// a fresh hybrid host needs show()+contentWC.focus() or it enters a dead-focus state, and why
// headless must never activate or focus). `inactive` wins over `nonActivating`: a restored
// peek/slide must stay focus-free until the restore loop picks the one to re-raise.
export function hybridShowIntent(
  headless: boolean,
  opts: { inactive?: boolean; nonActivating?: boolean } = {},
): {
  activated: boolean;
  contentFocused: boolean;
  showInactive: boolean;
} {
  const { inactive = false, nonActivating = false } = opts;
  // `inactive` is the session-restore (and any `show:false` caller) intent: make
  // the host VISIBLE but never activate the app or steal first-responder. Each
  // restored hybrid window must NOT activate itself — otherwise the last one
  // dispatched (or whichever wins the macOS show-storm race) ends up frontmost,
  // and the page the user actually left focused at quit is not the one raised.
  // The canvas path already honors `show:false` this way (ipc.ts BrowserWindow
  // ctor `show: options.show !== false`); the hybrid path must match. The
  // restore loop's focus block is then the SINGLE authority that activates +
  // focuses the one focused descriptor (via an activating showHybridHost call).
  // `inactive` wins over `nonActivating` (a restored peek/slide must stay
  // focus-free until the restore loop picks the one to re-raise).
  if (inactive) {
    return { activated: false, contentFocused: false, showInactive: true };
  }
  if (headless) {
    return { activated: false, contentFocused: false, showInactive: true };
  }
  // Valid only because a quick-view host is a type:'panel' NSPanel, which can hold macOS first
  // responder (take key input) without activating the app — a regular window cannot.
  if (nonActivating) {
    return { activated: false, contentFocused: true, showInactive: true };
  }
  return { activated: true, contentFocused: true, showInactive: false };
}

// Applies the hybridShowIntent decision for the current run mode. Returns the applied intent so
// callers/tests can assert what was done without relying on real OS focus. `opts.inactive`
// (session restore) forces the non-activating branch in both run modes: restore opens many
// hybrid windows in sequence, and only the restore loop's own follow-up (an ordinary, non-inactive
// call) may activate the one focused descriptor — otherwise the last to show, or the race winner,
// would end up frontmost instead of the page the user left focused.
export function showHybridHost(
  baseWin: import('electron').BaseWindow,
  opts?: { inactive?: boolean; nonActivating?: boolean; activation?: 'user' },
): { activated: boolean; contentFocused: boolean; showInactive: boolean } {
  const intent = hybridShowIntent(isHeadless(), {
    inactive: opts?.inactive === true,
    nonActivating: opts?.nonActivating === true,
  });
  // THIN SEAM (§5 step 6A-2): the OS half lives behind the port. `activate` carries the caller's
  // focus intent judged BEFORE the headless/panel masks; the backend masks it into the OS
  // variant and echoes WINDOW_SHOWN with the unmasked intent, which is how `front` tracks
  // quick-views and headless shows where no OS focus event will ever fire. `intent` here is
  // purely the returned description of what was asked for — nothing here touches Electron.
  const id = getWindowIdFor(baseWin);
  if (id == null) {
    DEBUG && console.log('[windows] showHybridHost: host not machine-registered — show dropped');
  } else {
    kernelShowRequested(
      id,
      opts?.inactive !== true,
      opts?.activation === 'user' ? { activation: 'user' } : undefined,
    );
  }
  return intent;
}

export function modWindow(bw: BrowserWindow, params: { action: string }): void {
  if (params.action === 'close') {
    closeHostWindow(bw.id, bw);
  }
  if (params.action === 'hide') {
    const id = getWindowIdFor(bw);
    if (id == null) {
      DEBUG && console.log('[windows] modWindow: window not machine-registered — hide dropped');
    } else {
      kernelHideRequested(id);
    }
  }
  if (params.action === 'show') {
    showWindowHeadlessSafe(bw, { active: true });
  }
}

// { handled: true } — renderer navigated internally, no action needed. { handled: false,
// close: true } — renderer at root, explicitly requesting close. { handled: false } — renderer
// didn't handle, or timed out. 'navigate' mode only closes on explicit close:true; 'auto' mode
// treats plain handled:false as sufficient.
export function askRendererToHandleEscape(bw: BrowserWindow): Promise<{ handled: boolean; close?: boolean; timeout?: boolean }> {
  return askWebContentsToHandleEscape(bw.id, bw.webContents);
}

// Targets an explicit WebContents + id rather than a BrowserWindow: a hybrid page-host is a
// BaseWindow with no root webContents, and the renderer owning `onEscape` is its content
// WebContentsView. A content WC that never registered an onEscape handler times out to
// { handled: false }, falling through to policy below.
export function askWebContentsToHandleEscape(
  winId: number,
  askWC: Electron.WebContents,
): Promise<{ handled: boolean; close?: boolean; timeout?: boolean }> {
  return new Promise((resolve) => {
    const responseChannel = `escape-response-${winId}-${Date.now()}`;
    DEBUG && console.log(`[esc] Asking renderer to handle escape, channel: ${responseChannel}`);

    const timeout = setTimeout(() => {
      DEBUG && console.log(`[esc] Renderer timeout (500ms) - no response on ${responseChannel}`);
      ipcMain.removeAllListeners(responseChannel);
      resolve({ handled: false, timeout: true });
    }, 500);

    ipcMain.once(responseChannel, (_event, response) => {
      DEBUG && console.log(`[esc] Renderer responded on ${responseChannel}:`, response);
      clearTimeout(timeout);
      resolve(response || { handled: false });
    });

    try {
      askWC.send('escape-pressed', { responseChannel });
    } catch {
      // WC torn down between resolve of the keystroke and this send — no
      // renderer to answer, so let the timeout fire { handled: false }.
    }
  });
}

// The ESC decision itself lives in window-escape.ts interpretEscape, reached through
// dispatchEscapePress; the before-input-event attach + editable guard + debounce + webview-guest
// routing here is only input hygiene. Also handles ESC pressed inside <webview> guests: a
// BrowserWindow's before-input-event does not fire for guest keystrokes, so did-attach-webview
// adds the same interception to each guest's own WebContents.
export function addEscHandler(bw: BrowserWindow): void {
  DEBUG && console.log('adding esc handler to window:', bw.id);
  let lastEscTime = 0;

  // Idempotent: registers the tile:escape:handled receiver once so this window's tile-preload
  // reports land in the cache.
  initRendererHandledEscapeTracking(ipcMain);

  const attachEscListener = (wc: Electron.WebContents, source: 'host' | 'webview') => {
    wc.once('destroyed', () => clearRendererHandledEscapeForWc(wc.id));
    wc.on('before-input-event', async (e, i) => {
      if (i.key === 'Escape' && i.type === 'keyDown') {
        wmLog('esc-input', {
          id: bw.id,
          key: i.key,
          autoRepeat: i.isAutoRepeat,
          focused: bw.isDestroyed() ? false : bw.isFocused(),
          appActive: app.isActive(),
        });
        // keyDown, not keyUp, so the IPC fires before DOM keydown handlers — otherwise a dialog
        // that closes on DOM keydown leaves the keyUp-timed IPC seeing no open dialog.
        const now = Date.now();
        // Debounced within 200ms to absorb double-fires from key propagation or OS focus changes.
        if (now - lastEscTime < 200) {
          DEBUG && console.log(`[esc] Debounced ESC keyDown on window ${bw.id} source:${source} (${now - lastEscTime}ms since last)`);
          return;
        }
        lastEscTime = now;
        e.preventDefault();

        const rendererHandled = rendererHandledEscapeForWc(wc.id);
        DEBUG && console.log(`[esc] window ${bw.id} source:${source} rendererHandled=${rendererHandled}`);

        dispatchEscapePress(getWindowIdFor(bw) ?? 'global', 'windows.addEscHandler');
      }
    });
  };

  attachEscListener(bw.webContents, 'host');

  // A <webview> guest's keystrokes go to its own WebContents, not the host's — attach the same
  // ESC interception to each guest as it attaches.
  bw.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    DEBUG && console.log(`[esc] Webview guest attached to window ${bw.id}, adding ESC listener`);
    attachEscListener(guestWebContents, 'webview');
    // Lets the permission handler (and other Electron-guest-facing code) find which page-host
    // window to surface UI in.
    const hostWmId = getWindowIdFor(bw);
    if (hostWmId != null) {
      registerGuest(guestWebContents, hostWmId);
    } else {
      DEBUG && console.log(`[esc] did-attach-webview: window ${bw.id} has no WM id; guest not registered`);
    }
  });
}

export function winDevtoolsConfig(bw: BrowserWindow): void {
  const windowData = getWindowInfo(bw.id);
  const params = windowData ? windowData.params : {};

  DEBUG && console.log('winDevtoolsConfig:', bw.id, 'openDevTools:', params.openDevTools, 'address:', params.address);

  // Never in test profiles or headless mode.
  if (params.openDevTools === true && !isTestProfile() && !isHeadless()) {
    const isDetached = params.detachedDevTools === true;
    // activate: false prevents devtools from stealing focus (only works with detach/undocked).
    const devToolsOptions: Electron.OpenDevToolsOptions = {
      mode: isDetached ? 'detach' : 'right',
      activate: false
    };

    DEBUG && console.log(`Opening DevTools for window ${bw.id} with options:`, devToolsOptions);

    // Re-focus after open is owned by the machine: main.ts's devtools-opened listener dispatches
    // DEVTOOLS_OPENED, whose reducer arm re-raises state.front — no separate re-focus call here.
    setTimeout(() => {
      bw.webContents.openDevTools(devToolsOptions);
    }, 50);
  }
}

// Minimal close surface shared by BrowserWindow and (hybrid) BaseWindow.
interface ClosableWindow {
  isDestroyed(): boolean;
}

// Callers still speak Electron window ids here; the conversion happens at this boundary. Every
// window registers with the machine, so a null resolution means the window is already retired.
export function closeHostWindow(hostId: number, _win: ClosableWindow): void {
  const hostWmId = getWindowIdFor(hostId);
  if (hostWmId == null) {
    DEBUG && console.log('closeHostWindow: window', hostId, 'is not machine-registered — nothing to close');
    return;
  }
  kernelCloseWindowDirect(hostWmId);
}

// Closes the window regardless of "keep alive" opener params.
export function closeWindow(params: { id?: number }, callback?: (success: boolean) => void): void {
  DEBUG && console.log('closeWindow', params, callback != null);

  let retval = false;

  if (params.id !== undefined && getWindowInfo(params.id)) {
    DEBUG && console.log('closeWindow(): closing', params.id);

    const entry = getWindowInfo(params.id);
    if (!entry) {
      // wtf
      if (callback) callback(false);
      return;
    }

    closeChildWindows(entry.params.address as string);

    const win = getLiveWindow(params.id);
    if (win) {
      closeHostWindow(params.id, win);
    }

    retval = true;
  }

  if (callback) {
    callback(retval);
  }
}

// Call at startup and when the showInDockAndSwitcher preference changes. Test profiles and
// headless runs always hide the dock; use PROFILE=tmp-* for a manual sandbox instead (bypasses
// the single-instance lock without inheriting test-only behaviors).
export function applyDockPreference(): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  // app.dock.show/hide is an APP-level operation (Dock tile), not a window operation — out of
  // the window-backend port's scope, so the calls live here at the app surface.
  const prefs = _getPrefs();
  const showDock = !isTestProfile() && !isHeadless() && prefs?.showInDockAndSwitcher === true;

  DEBUG && console.log('applyDockPreference:', { showDock });

  if (showDock) {
    app.dock.show();
  } else {
    app.dock.hide();
  }
}

// Resolves the native window for `id` (BrowserWindow or hybrid page-host BaseWindow) and
// dispatches it into the kernel's CloseOrHideWindow command. Whether that closes, hides,
// refuses, or cascades onto other windows is decided entirely by window-kernel.ts decide; a
// fullscreen-exit preamble for the hybrid branch is the only policy left here.
export async function closeOrHideWindow(id: number, source: string = 'unknown'): Promise<void> {
  DEBUG && console.log('closeOrHideWindow called for ID:', id);

  try {
    const win = getLiveWindow(id);
    if (!win) {
      // Hybrid page-host (BaseWindow) — invisible to getLiveWindow/BrowserWindow.fromId, but
      // cmd+W and any other close-by-id path must still close it.
      const hybrid = getHybridWindow(id);
      if (hybrid && !hybrid.baseWin.isDestroyed()) {
        // Exit native fullscreen first, awaited through the machine, before the terminal
        // hide/close — closing or hiding a fullscreen host mid-state strands a black macOS
        // Space. No-op when the host isn't fullscreen; the host may be torn down while we await,
        // re-checked below.
        const machineId = getWindowIdFor(id);
        const fsMode = machineId != null ? getWindowModeName(machineId) : null;
        if (machineId != null && fsMode != null && fsMode !== 'normal') {
          kernelSetFullscreen(machineId, false);
          const outcome = await getKernelExecutorForApp().waitForSettledFsMode(machineId, 'normal');
          if (outcome !== 'settled') {
            // Timed out or vanished: proceed into the destroyed re-check and hide/close below,
            // logged so a stranded black Space is diagnosable from a live run.
            wmLog('fs-settle-wait-non-settled', { site: 'closeOrHideWindow', id: machineId, outcome });
          }
        }
        if (hybrid.baseWin.isDestroyed()) return;
        if (machineId != null) {
          wmLog('close-or-hide-dispatch', { id, machineId, source });
          kernelCloseOrHideRequested(machineId);
        } else {
          // Not machine-registered: route through closeHostWindow so the content WebContents
          // (registered as a guest of baseWin.id) is destroyed before the BaseWindow closes —
          // the page-host close use-after-free guard.
          DEBUG && console.log(`hybrid page-host BaseWindow ${id} is not machine-registered — closing directly`);
          wmLog('close-or-hide-hybrid-unregistered', { id });
          closeHostWindow(id, hybrid.baseWin);
        }
        return;
      }
      DEBUG && console.log('Window already destroyed or invalid');
      wmLog('close-or-hide-already-destroyed', { id });
      return;
    }

    const entry = getWindowInfo(id);
    DEBUG && console.log('Window entry from manager:', entry);

    if (!entry) {
      DEBUG && console.log('Window not found in window manager, closing directly');
      wmLog('close-or-hide-no-entry', { id });
      closeHostWindow(id, win);
      return;
    }

    const params = entry.params;
    DEBUG && console.log('Window parameters - modal:', params.modal, 'keepLive:', params.keepLive);

    // Close, hide, or refuse (keepLive hides rather than closes; appLifetime refuses outright;
    // a parentId cascade closes everything this window opened) is decided entirely by
    // window-kernel.ts decide — this seam only resolves the machine id and dispatches into it.
    const wmId = getWindowIdFor(id);
    if (wmId != null) {
      wmLog('close-or-hide-dispatch', { id, wmId, source });
      kernelCloseOrHideRequested(wmId);
    } else {
      DEBUG && console.log('Window entry has no machine id, closing directly');
      wmLog('close-or-hide-no-machine-id', { id });
      closeHostWindow(id, win);
    }

    DEBUG && console.log('closeOrHideWindow completed');
  } catch (error) {
    console.error('Error in closeOrHideWindow:', error);
  }
}

// Destructive if wrong (four callers): the key window when it is ITSELF front-eligible, else
// the topmost front-eligible window — never widened past a focused front-eligible window to
// some OTHER window it happens to be attached to (its opener, the page a popup floats over).
// isFrontEligibleWindow, not isContentWindow, deliberately: a focused peek (role: 'quick-view')
// must close itself, not the page host behind it, and isContentWindow's role allow-list excludes it.
export function resolveFocusedWindowIdForClose(): number | null {
  // `frontWindowHere`: the key window if front-eligible and on a current desktop, else the
  // topmost such window, so Cmd+W never closes a window on a desktop the user is not on.
  const target = frontWindowHere(getKernelExecutor().getState(), isFrontEligibleWindow);
  if (target == null) return null;
  // The kernel speaks WM WindowId; the close path is still Electron-id-keyed, so resolve the
  // target's native handle and hand back its id.
  const win = getNativeWindowFor(target);
  return win ? win.id : null;
}

// Resolves a focused hybrid page-host (BaseWindow) the same as a focused BrowserWindow.
export function closeFocusedWindow(): number | null {
  const id = resolveFocusedWindowIdForClose();
  if (id == null) return null;
  // Fire-and-forget: closeOrHideWindow is async (its hybrid branch awaits a fullscreen exit),
  // but this stays sync so menu/shortcut callers and tests keep reading the id it acted on.
  void closeOrHideWindow(id, 'closeFocusedWindow');
  return id;
}

// An address-string walk over the legacy registry's source/params.address linkage, a different
// graph from the kernel's own parentId edges. closeOrHideWindow's cascade no longer calls this;
// the sole remaining caller is closeWindow above, the separate forceful close that ignores keepLive.
export function closeChildWindows(aAddress: string): void {
  DEBUG && console.log('closeChildWindows()', aAddress);

  if (aAddress === WEB_CORE_ADDRESS) {
    return;
  }

  const childWindows = getChildWindows(aAddress);

  for (const child of childWindows) {
    const address = child.data.params.address as string;
    DEBUG && console.log('closing child window', address, 'for', aAddress);

    closeChildWindows(address);

    const win = getLiveWindow(child.id);
    if (win) {
      closeHostWindow(child.id, win);
    }
  }
}
