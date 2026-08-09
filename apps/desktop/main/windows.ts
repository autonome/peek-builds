/**
 * Window Management Helpers
 *
 * Helper functions for managing BrowserWindow instances.
 */

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { getLiveWindow } from './window-registry.js';
import {
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
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
  getFrontWindowId,
  getWindowModeName,
  waitForMode,
  dispatchWindowEvent,
  getWindowIdFor,
  getNativeWindowFor,
  getMachineWindowRecord,
  listMachineWindowRecords,
  getWindowStateSnapshot,
} from './window-state-singleton.js';
import type { WindowClass } from './izui-roles.js';
import { shadowKernelCloseWindowDirect } from './window-kernel-shadow.js';
import {
  initRendererHandledEscapeTracking,
  rendererHandledEscapeForWc,
  clearRendererHandledEscapeForWc,
} from './window-escape-renderer-handled.js';

/**
 * Get the appropriate background color based on system theme
 * This helps prevent the "white flash" when opening windows in dark mode
 */
export function getSystemThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

// Preferences getter - set by index.js during initialization
let _getPrefs: () => Record<string, unknown> = () => ({});

/**
 * Set the preferences getter function
 */
export function setPrefsGetter(getter: () => Record<string, unknown>): void {
  _getPrefs = getter;
}

/**
 * Get current preferences
 */
export function getPrefs(): Record<string, unknown> {
  return _getPrefs();
}

/**
 * Show a BrowserWindow, headless-safe — THIN SEAM (§5 step 6A-2): this
 * function performs NO OS work. It resolves the machine id and dispatches
 * `WINDOW_SHOW_REQUESTED`; the `SHOW_WINDOW` effect routes to the backend
 * (`electron-window-backend.ts showWindow`), which owns the whole show
 * policy — the headless opacity-0-before-show trick (isVisible() stays true
 * for tests, nothing paints on the real display), show() vs showInactive(),
 * and the `WINDOW_SHOWN` echo that keeps the machine's visibility/front in
 * step even when no native `'show'` event fires (`showInactive` emits none,
 * and headless runs are focus-free by design).
 *
 * @param win    The BrowserWindow to show.
 * @param opts   { active: true } to activate (the backend calls win.show(),
 *               which steals focus); default is focus-preserving
 *               (showInactive()).
 */
export function showWindowHeadlessSafe(
  win: BrowserWindow,
  opts?: { active?: boolean },
): void {
  const id = getWindowIdFor(win);
  if (id == null) {
    // Every live window registers with the machine (§5 step 4); an
    // unregistered handle here is a bug in the open path, not a case to
    // paper over — there is deliberately no direct-OS fallback (R2: only
    // the backend performs window ops).
    DEBUG && console.log('[windows] showWindowHeadlessSafe: window not machine-registered — show dropped');
    return;
  }
  dispatchWindowEvent({ type: 'WINDOW_SHOW_REQUESTED', id, activate: opts?.active === true });
}

/**
 * The hybrid page-host SHOW decision, as a pure function of headless-ness.
 *
 * A freshly-opened hybrid page-host is an opaque content-sized `BaseWindow` +
 * `WebContentsView`. The canvas path it replaced showed its `BrowserWindow`
 * with `show()` (constructor `show:true` → activates the app + makes the window
 * key) and `focus()`, so the page's webContents became the macOS FIRST
 * RESPONDER. The hybrid path must reproduce that or it enters a dead-focus
 * state (peek items 1b6eaf0b / 363e7cff / 8f7010a8):
 *   - no first responder  → cmd+L key equivalents hit AppKit with no target → NSBeep
 *   - app never activated  → windows show but Peek isn't frontmost / no menubar
 *   - host never focused   → the active-hybrid id stays null → overlay never reveals
 *
 * Under HEADLESS (agent/CI) we must NOT activate or focus — that would steal the
 * user's OS focus (peek task 2b55f3af; activation policy is 'accessory' there).
 * So:
 *   - non-headless → activate (show) + focus the content WC (first responder)
 *   - headless     → showInactive only, never focus (focus-free)
 *
 * Pure + deterministic so the regression is testable focus-free for BOTH modes
 * (real OS focus is unobservable in a macOS-headless test).
 */
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
  // `nonActivating` is the quick-view (peek/slide) intent: the host is a
  // `type:'panel'` NSPanel (see createHybridHostBaseWindow), so it can hold the
  // macOS FIRST RESPONDER — take key input (ESC, address-bar typing) — WITHOUT
  // activating the app. This restores the pre-`4a543d7f` behavior: peeks/slides
  // were `type:'panel'` BrowserWindows (non-activating NSPanels) until the
  // page-host cutover routed them through the activating web-tab show seam and
  // they began stealing the frontmost app's OS focus (regression 524f7aba). So:
  // showInactive (never activate the app) BUT still focus the content WC (a
  // non-activating panel can be key while its app is inactive; a regular window
  // cannot — hence this branch is ONLY valid for the panel host).
  if (nonActivating) {
    return { activated: false, contentFocused: true, showInactive: true };
  }
  return { activated: true, contentFocused: true, showInactive: false };
}

/**
 * Show a freshly-opened hybrid page-host: apply the `hybridShowIntent` decision
 * for the current run mode. Non-headless activates the app + makes the content
 * `WebContentsView` the first responder (cmd+L works, no NSBeep, overlay reveals);
 * headless stays inactive + opacity-0 (focus-free). Returns the applied intent so
 * callers/tests can assert what was done without relying on real OS focus.
 *
 * `opts.inactive` (session restore / any `show:false` open) forces the
 * non-activating, focus-free branch in BOTH run modes — the host becomes visible
 * but never activates the app or steals first responder. Restore opens many
 * hybrid windows in sequence; if each one activated, the last to show (or the
 * race winner) would end up frontmost instead of the page the user left focused.
 * The restore loop re-activates ONLY the focused descriptor afterwards via an
 * ordinary (non-inactive) `showHybridHost` call — the single activation seam.
 *
 * `opts.nonActivating` (quick-view peeks/slides) shows the host WITHOUT
 * activating the app but STILL makes its content the first responder — valid
 * only because a quick-view host is a `type:'panel'` NSPanel (see
 * createHybridHostBaseWindow). This is what stops a hotkey-opened peek/slide
 * from stealing the frontmost app's OS focus (regression 524f7aba).
 */
export function showHybridHost(
  baseWin: import('electron').BaseWindow,
  opts?: { inactive?: boolean; nonActivating?: boolean },
): { activated: boolean; contentFocused: boolean; showInactive: boolean } {
  const intent = hybridShowIntent(isHeadless(), {
    inactive: opts?.inactive === true,
    nonActivating: opts?.nonActivating === true,
  });
  // THIN SEAM (§5 step 6A-2): the OS half (opacity-0 / show vs showInactive)
  // lives behind the port — dispatch the show and let the `SHOW_WINDOW`
  // effect drive the backend. `activate` carries the CALLER's focus intent,
  // judged BEFORE the headless/panel masks (every show except an explicitly
  // `inactive` one — session restore's `show:false` — targets the window).
  // The backend masks it into the OS variant (headless, and a
  // `quick-view`-class panel host, show inactive — same decisions
  // `hybridShowIntent` encodes) and echoes `WINDOW_SHOWN` with the UNMASKED
  // intent — which is how the machine's `front` tracks quick-views and
  // headless shows, where no OS focus event will ever fire.
  //
  // The CONTENT-focus half rides the same dispatch as of §5 step 8: the
  // reducer's `WINDOW_SHOW_REQUESTED` arm pushes `FOCUS_CONTENT` after
  // `SHOW_WINDOW` for an activating show of a page-host, so first responder
  // lands on an already-shown host exactly as the old imperative
  // `contentWC.focus()` did — but through the executor, per R2. `intent` is
  // now purely the RETURNED description of what was asked for; nothing here
  // touches Electron.
  const id = getWindowIdFor(baseWin);
  if (id == null) {
    DEBUG && console.log('[windows] showHybridHost: host not machine-registered — show dropped');
  } else {
    dispatchWindowEvent({ type: 'WINDOW_SHOW_REQUESTED', id, activate: opts?.inactive !== true });
  }
  return intent;
}

/**
 * Modify window state (close, hide, show)
 */
export function modWindow(bw: BrowserWindow, params: { action: string }): void {
  if (params.action === 'close') {
    closeHostWindow(bw.id, bw);
  }
  if (params.action === 'hide') {
    // THIN SEAM (§5 step 6A-4): dispatch the hide intent — the HIDE_WINDOW
    // effect routes to the backend, whose native 'hide' event is the only
    // WINDOW_HIDDEN source. Mirrors the 'show' action's seam below.
    const id = getWindowIdFor(bw);
    if (id == null) {
      DEBUG && console.log('[windows] modWindow: window not machine-registered — hide dropped');
    } else {
      dispatchWindowEvent({ type: 'WINDOW_HIDE_REQUESTED', id });
    }
  }
  if (params.action === 'show') {
    showWindowHeadlessSafe(bw, { active: true });
  }
}

/**
 * Ask renderer to handle escape key.
 *
 * Protocol:
 *   { handled: true }                - Renderer navigated internally, no action needed
 *   { handled: false, close: true }  - Renderer at root, explicitly requesting close
 *   { handled: false }               - Renderer didn't handle (or timeout/error)
 *
 * For 'navigate' mode, backend only closes on explicit { close: true }.
 * For 'auto' mode, { handled: false } is sufficient (active mode won't close anyway).
 */
export function askRendererToHandleEscape(bw: BrowserWindow): Promise<{ handled: boolean; close?: boolean; timeout?: boolean }> {
  return askWebContentsToHandleEscape(bw.id, bw.webContents);
}

/**
 * Lower-level form of `askRendererToHandleEscape` that targets an explicit
 * WebContents + id rather than a BrowserWindow. A hybrid page-host is a
 * `BaseWindow` with no root webContents — the renderer that owns the `onEscape`
 * callback is its content `WebContentsView`. This lets the hybrid ESC path ask
 * the SAME `escape-pressed` IPC question the BrowserWindow path asks, so the
 * renderer-handled-first contract (dialog close, internal nav) is identical for
 * both kinds. A page-host content WC that never registered an `onEscape` handler
 * simply times out → `{ handled: false }`, falling through to policy below.
 */
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

/**
 * ESC decision has moved to the window-state machine. The `before-input-event`
 * attach + editable guard + 200ms debounce + webview-guest routing stay here
 * (input hygiene, `addEscHandler` below); only the DECISION moved — the handler
 * dispatches `ESC_PRESSED` and `decideEscape` (window-state.ts) owns the
 * outcome. `handleHybridEscape`/`handleEscapeForWindow`/`handleEscapeForWindowId`
 * (and their `resolveHybridEscapeTarget`/`escExitsHybridFullscreen`/
 * `escPolicy`/`escUnhandledPolicy` reads) are DELETED — each is now a
 * `decideEscape` clause.
 */

/**
 * Add escape key handler to a window
 * Supports escapeMode: 'auto' (default), 'close', 'navigate', 'ignore'
 *
 * - 'auto' (default): Transient windows (opened without app focus) close on ESC;
 *   active windows (opened while app focused) behave like 'navigate'
 * - 'close': ESC always closes the window
 * - 'navigate': ESC only triggers internal navigation, never closes
 *   (renderer handles ESC via IZUI - parent focus, internal nav, etc.)
 * - 'ignore': ESC is completely ignored (for overlays that shouldn't respond)
 *
 * Also handles ESC pressed inside <webview> guests. The BrowserWindow's
 * before-input-event does NOT fire for keystrokes in a webview — those go to the
 * guest's own WebContents. We listen for did-attach-webview to add ESC
 * interception on guest WebContents, delegating back to the host window's
 * escape handling (which sends escape-pressed IPC to the host renderer
 * where the preload's onEscape callback lives).
 */
export function addEscHandler(bw: BrowserWindow): void {
  DEBUG && console.log('adding esc handler to window:', bw.id);
  let lastEscTime = 0;

  // Producer for `window-escape.ts EscapeKeyPress.rendererHandled` (peek
  // 7fffa286 companion): register the `tile:escape:handled` receiver once
  // (idempotent) so this window's tile-preload reports land in the cache.
  initRendererHandledEscapeTracking(ipcMain);

  // Helper: attach ESC interception to a WebContents (host or guest)
  const attachEscListener = (wc: Electron.WebContents, source: 'host' | 'webview') => {
    wc.once('destroyed', () => clearRendererHandledEscapeForWc(wc.id));
    wc.on('before-input-event', async (e, i) => {
      if (i.key === 'Escape' && i.type === 'keyDown') {
        // Intercept ESC on keyDown (not keyUp) so the IPC fires BEFORE DOM keydown handlers.
        // This prevents a race condition where peek-dialog closes on DOM keydown,
        // then the IPC callback (on keyUp) sees no open dialog and returns { handled: false },
        // causing the backend to close the entire window.
        // With keyDown interception + e.preventDefault(), the DOM keydown never reaches
        // peek-dialog, and the preload's escape handler sees the dialog still open.

        // Debounce: ignore ESC events within 200ms of each other
        // Prevents double-fires from key propagation or OS focus changes
        const now = Date.now();
        if (now - lastEscTime < 200) {
          DEBUG && console.log(`[esc] Debounced ESC keyDown on window ${bw.id} source:${source} (${now - lastEscTime}ms since last)`);
          return;
        }
        lastEscTime = now;

        // Prevent ESC from propagating to the page (blocks DOM keydown dispatch)
        e.preventDefault();

        // The mirrored "renderer already consumed this Escape" fact (this
        // window's tile-preload's last reported `onEscape` answer), read
        // synchronously — see window-escape-renderer-handled.ts. Not yet
        // threaded into `ESC_PRESSED` (window-state.ts's reducer event has no
        // field for it); real once the interpreter cutover lands.
        const rendererHandled = rendererHandledEscapeForWc(wc.id);
        DEBUG && console.log(`[esc] window ${bw.id} source:${source} rendererHandled=${rendererHandled}`);

        // Decision moved to the window-state machine: dispatch ESC_PRESSED and
        // let `decideEscape` own the outcome (the landed id is first-responder
        // noise; the target is `front`). The attach/debounce/webview routing
        // above stays here as input hygiene. The landed id is resolved to the
        // WM's WindowId at keypress time (registration has long happened);
        // an unregistered window degrades to 'global' — same decision either way.
        dispatchWindowEvent({ type: 'ESC_PRESSED', landedId: getWindowIdFor(bw) ?? 'global' });
      }
    });
  };

  // Listen for ESC on the window's own WebContents (host page)
  attachEscListener(bw.webContents, 'host');

  // Listen for webview guests attaching to this window.
  // When a <webview> tag creates its guest WebContents, keystrokes inside the
  // webview go to the guest — not the host BrowserWindow's webContents.
  // We add an ESC listener on each guest so that ESC in web content (e.g. slides
  // showing youtube.com) is intercepted and routed through the host window's
  // escape handling (which talks to the host renderer's preload onEscape callback).
  bw.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    DEBUG && console.log(`[esc] Webview guest attached to window ${bw.id}, adding ESC listener`);
    attachEscListener(guestWebContents, 'webview');
    // Track the guest→host relationship so the permission handler (and any
    // other main-process code that gets a guest WebContents from Electron)
    // can find which page-host window to surface UI in. The registry carries
    // WM WindowIds; by attach time the host has long been registered with the
    // machine, so the mapping is available.
    const hostWmId = getWindowIdFor(bw);
    if (hostWmId != null) {
      registerGuest(guestWebContents, hostWmId);
    } else {
      DEBUG && console.log(`[esc] did-attach-webview: window ${bw.id} has no WM id; guest not registered`);
    }
  });
}

/**
 * Configure devtools for a window based on its parameters
 */
export function winDevtoolsConfig(bw: BrowserWindow): void {
  const windowData = getWindowInfo(bw.id);
  const params = windowData ? windowData.params : {};

  DEBUG && console.log('winDevtoolsConfig:', bw.id, 'openDevTools:', params.openDevTools, 'address:', params.address);

  // Check if devTools should be opened (never in test profiles or headless mode)
  if (params.openDevTools === true && !isTestProfile() && !isHeadless()) {
    const isDetached = params.detachedDevTools === true;
    // Determine if detached mode should be used
    // activate: false prevents devtools from stealing focus (only works with detach/undocked)
    const devToolsOptions: Electron.OpenDevToolsOptions = {
      mode: isDetached ? 'detach' : 'right',
      activate: false
    };

    DEBUG && console.log(`Opening DevTools for window ${bw.id} with options:`, devToolsOptions);

    // Open DevTools after a slight delay to let the main window settle.
    // Re-focus after open is owned by the machine now: `main.ts`'s
    // `web-contents-created` → `devtools-opened` listener dispatches
    // `DEVTOOLS_OPENED`, whose reducer arm re-raises `state.front` (§5 step
    // 9/10) — no separate re-focus call or timer here.
    setTimeout(() => {
      bw.webContents.openDevTools(devToolsOptions);
    }, 50);
  }
}

/** Minimal close surface shared by BrowserWindow and (hybrid) BaseWindow. */
interface ClosableWindow {
  isDestroyed(): boolean;
}

/**
 * Close a host window through the window-state machine
 * (WINDOW_CLOSE_REQUESTED → CLOSE_WINDOW_DIRECT → the backend's guest-safe
 * `closeWindow`, which destroys registered page-host guests FIRST and then
 * closes the host — the d1cf0b9a use-after-free guard, whose physical ops
 * moved behind the port in §5 step 4; guestless windows still close
 * synchronously inside the dispatch).
 *
 * Callers still speak Electron window ids here; the conversion happens at
 * this boundary. Every window registers with the machine (design §7), so a
 * null resolution means the window is already retired — nothing to close.
 */
export function closeHostWindow(hostId: number, _win: ClosableWindow): void {
  const hostWmId = getWindowIdFor(hostId);
  if (hostWmId == null) {
    DEBUG && console.log('closeHostWindow: window', hostId, 'is not machine-registered — nothing to close');
    return;
  }
  dispatchWindowEvent({ type: 'WINDOW_CLOSE_REQUESTED', id: hostWmId });
  // Shadow-feed the kernel (window-kernel-shadow.ts) — additive, authoritative
  // over nothing; see that module's doc for why this can never change what
  // actually happens on screen.
  shadowKernelCloseWindowDirect(hostWmId, getWindowStateSnapshot());
}

/**
 * Close a window and its children
 * This will actually close the window regardless of "keep alive" opener params
 */
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

// TRANSIENT_ROLES is defined in ./izui-roles.ts (pure module, Electron-free).
// Re-exported here so existing imports `from './windows.js'` keep working
// (ipc.ts). The set covers palette/quick-view/overlay — windows that ride
// above the workspace and on macOS follow the user across Spaces. Used for
// the focus-driven auto-hide path (a non-transient window gaining focus
// dismisses any transient sibling via closeOrHideWindow, restoring the
// blur-on-focus-change behavior that NSPanels swallow). The app-hide count
// below filters by machine window CLASS now, not by this role set.
export { TRANSIENT_ROLES } from './izui-roles.js';

/**
 * Window classes that never hold the app open (§5 step 6B): a window of one
 * of these classes is not "a window the user is working in", so it does not
 * count toward the visible-window total maybeHideApp reads. The set
 * reproduces the pre-machine exclusion semantics exactly:
 *   - 'background'                    was: entry.params.address === WEB_CORE_ADDRESS
 *   - 'quick-view'/'palette'/'overlay' was: TRANSIENT_ROLES on the registry role
 *     (classifyWindowRegistration maps those roles 1:1 to these classes)
 *   - 'hud'                           was: role 'utility' + focusable === false
 * Deliberately a CLASS set, not the record's `satellite` flag: quick-view is
 * satellite:false yet transient-excluded, while a detached devtools window
 * (satellite:true) and extension-ui popups are real visible surfaces that
 * kept the app open before and must keep doing so.
 */
const APP_HIDE_EXCLUDED_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>([
  'background',
  'quick-view',
  'palette',
  'overlay',
  'hud',
]);

/**
 * Get count of visible persistent windows (excluding background, transients, HUD).
 * Used by maybeHideApp to decide whether to hide the app when a window closes.
 *
 * Derived from the window-state machine (§5 step 6B): `visible` is reducer
 * state (written by the backend's WINDOW_SHOWN / WINDOW_HIDDEN echoes), so
 * BrowserWindows and hybrid page-host BaseWindows come out of ONE table —
 * no isVisible() polling, no per-registry split.
 */
export function getVisibleWindowCount(excludeId: number | null = null): number {
  // excludeId is the numeric Electron id of the window whose close/hide is in
  // flight — its native hide event may not have echoed into the machine yet,
  // so it must not hold the app open. Convert it to the machine WindowId and
  // exclude that record.
  const excludeMachineId = excludeId != null ? getWindowIdFor(excludeId) : null;
  return listMachineWindowRecords().filter(rec => {
    if (excludeMachineId != null && rec.id === excludeMachineId) return false;
    if (!rec.visible) return false;
    return !APP_HIDE_EXCLUDED_CLASSES.has(rec.class);
  }).length;
}

/**
 * Apply dock visibility based on user preference.
 * Call at startup and when the showInDockAndSwitcher preference changes.
 * Test profiles and headless runs always hide the dock. Manual sandboxes should use
 * `PROFILE=tmp-*` (which bypasses the single-instance lock without
 * inheriting test-only behaviors — see `isEphemeralProfile`).
 */
export function applyDockPreference(): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  // One decision, one show/hide pair: test profiles and headless runs always
  // hide the dock; otherwise the preference decides. app.dock.show/hide is an
  // APP-level operation (Dock tile), not a window operation — out of the
  // window-backend port's scope, so the calls live here at the app surface
  // (§5 step 6B).
  const prefs = _getPrefs();
  const showDock = !isTestProfile() && !isHeadless() && prefs?.showInDockAndSwitcher === true;

  DEBUG && console.log('applyDockPreference:', { showDock });

  if (showDock) {
    app.dock.show();
  } else {
    app.dock.hide();
  }
}

/**
 * Hide the app if there are no other visible windows.
 *
 * app.hide() is an APP-level operation, not a window operation — it is out of
 * the window-backend port's scope by design (§5 step 6B): the machine's job
 * ends at supplying the visibility state this decision reads, and the
 * app-surface call sits here.
 */
export function maybeHideApp(excludeId: number): void {
  if (process.platform !== 'darwin') return;

  const visibleCount = getVisibleWindowCount(excludeId);
  DEBUG && console.log('maybeHideApp: visible windows (excluding', excludeId + '):', visibleCount);

  if (visibleCount === 0) {
    DEBUG && console.log('No other visible windows, hiding app');
    app.hide();
  } else {
    DEBUG && console.log('Other windows visible, not hiding app');
  }
}

/**
 * Close or hide a window based on its parameters
 */
export async function closeOrHideWindow(id: number): Promise<void> {
  DEBUG && console.log('closeOrHideWindow called for ID:', id);

  try {
    const win = getLiveWindow(id);
    if (!win) {
      // Hybrid page-host (BaseWindow) — invisible to getLiveWindow /
      // BrowserWindow.fromId. cmd+W (R1, peek ca4ee5e6) and any other
      // close-by-id path must still close it. No-op (null) only if the
      // registry has no entry for this id — hybrid is the only page-host path
      // now, not a flag-gated one.
      const hybrid = getHybridWindow(id);
      if (hybrid && !hybrid.baseWin.isDestroyed()) {
        // Black-window fix: exit native fullscreen FIRST, awaited through the
        // window-state machine (the single `setFullScreen` owner), before the
        // terminal hide/close. A fullscreen host closed or hidden mid-state
        // strands a black macOS Space; dropping fullscreen first (and awaiting
        // the settled exit via `waitForMode`) avoids it. No-op when the host
        // isn't fullscreen. The host may be torn down while we await — re-check.
        const machineId = getWindowIdFor(id);
        const fsMode = machineId != null ? getWindowModeName(machineId) : null;
        if (machineId != null && fsMode != null && fsMode !== 'normal') {
          dispatchWindowEvent({ type: 'FULLSCREEN_REQUESTED', id: machineId, desired: false });
          await waitForMode(machineId, 'normal');
        }
        if (hybrid.baseWin.isDestroyed()) return;
        // keepLive parity with the BrowserWindow branch below: a hybrid
        // peek/slide opened with keepLive:true (e.g. the left slide playing
        // music) must be HIDDEN, not destroyed, so its WebContentsView keeps
        // running in the background and the window-open key/url-reuse path can
        // re-show it (ipc.ts → baseWin.show()). A hide does NOT emit 'close',
        // so the close-finalize tail (which destroys the content wc +
        // unregisters) never runs on hide — exactly the keep-alive semantics
        // required (see the runHybridFinalize comment in ipc.ts). Only a
        // genuine closeHostWindow frees the resources.
        //
        // The hide is a MACHINE decision (§5 step 6A-3): dispatch
        // WINDOW_CLOSE_OR_HIDE_REQUESTED and let the reducer branch on the
        // record's first-class keepLive (registered at the ipc.ts open /
        // merged via WINDOW_PARAMS_SET) → HIDE_WINDOW → backend.hideWindow.
        // The backend's native 'hide' event is the only WINDOW_HIDDEN source
        // now — the old synchronous hand-dispatch (peek 71cfde09's "the
        // BaseWindow 'hide' event fires a tick late" admission) is gone.
        // This function reads the SAME record field only to keep the resolved
        // close (the reducer's CLOSE_WINDOW answer routes back through this
        // seam) from re-dispatching the intent forever.
        const hybridRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;
        if (machineId != null && hybridRec?.keepLive === true) {
          DEBUG && console.log(`keepLive hide via machine for hybrid page-host BaseWindow ${id}`);
          dispatchWindowEvent({ type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: machineId });
          maybeHideApp(id);
          return;
        }
        // Route through closeHostWindow so the content WebContents (registered
        // as a guest of baseWin.id) is destroyed BEFORE the BaseWindow closes —
        // same page-host close UAF guard as the canvas/tile-ipc paths.
        DEBUG && console.log(`CLOSING hybrid page-host BaseWindow ${id}`);
        closeHostWindow(id, hybrid.baseWin);
        maybeHideApp(id);
        return;
      }
      DEBUG && console.log('Window already destroyed or invalid');
      return;
    }

    const entry = getWindowInfo(id);
    DEBUG && console.log('Window entry from manager:', entry);

    if (!entry) {
      DEBUG && console.log('Window not found in window manager, closing directly');
      closeHostWindow(id, win);
      return;
    }

    const params = entry.params;
    DEBUG && console.log('Window parameters - modal:', params.modal, 'keepLive:', params.keepLive);

    // The machine record for this window (a non-null `entry` implies it is
    // machine-registered — the registry payload lives ON the record).
    const wmId = getWindowIdFor(id);
    const rec = wmId != null ? getMachineWindowRecord(wmId) : undefined;

    // Never close the background window
    if (params.address === WEB_CORE_ADDRESS) {
      DEBUG && console.log('Refusing to close background window');
      return;
    }

    // Special case for settings window - always close it on ESC
    if (params.address === SETTINGS_ADDRESS) {
      DEBUG && console.log(`CLOSING settings window ${id}`);
      closeChildWindows(params.address as string);
      closeHostWindow(id, win);
    }
    // Check if window should be hidden rather than closed.
    // Only keepLive windows are preserved in the background — modal windows
    // without keepLive (peeks, quick-views) should be closed so they can be
    // cleanly recreated on next invocation.
    //
    // The hide is a MACHINE decision (§5 step 6A-3): dispatch
    // WINDOW_CLOSE_OR_HIDE_REQUESTED and the reducer branches on the record's
    // first-class keepLive (registered at the ipc.ts open) → HIDE_WINDOW →
    // backend.hideWindow; the native 'hide' event then feeds WINDOW_HIDDEN.
    // The record field is read here only so the resolved close (the reducer's
    // CLOSE_WINDOW answer routes back through this seam) can't re-dispatch
    // the intent forever.
    else if (wmId != null && rec?.keepLive === true) {
      dispatchWindowEvent({ type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wmId });
    } else {
      // close any open windows this window opened
      closeChildWindows(params.address as string);
      DEBUG && console.log(`CLOSING window ${id} (${params.address})`);
      closeHostWindow(id, win);
    }

    // Hide app to return focus to previous app (only if no other visible windows).
    // Skip for overlay windows — they manage their own restoration flow via the
    // IZUI coordinator and should not trigger app hiding.
    const isOverlay = params.role === 'overlay';
    if (!isOverlay) {
      maybeHideApp(id);
    }

    DEBUG && console.log('closeOrHideWindow completed');
  } catch (error) {
    console.error('Error in closeOrHideWindow:', error);
  }
}

/**
 * Resolve the window id that a "close the current window" command (cmd+W menu
 * item / Close Window) should target.
 *
 * Two hybrid-era cases (the decision itself is the pure `resolveCloseTargetId`
 * in izui-roles.ts; this wrapper just feeds it live window state):
 *
 *   1. R1 (peek ca4ee5e6): the frontmost window may be a hybrid page-host, a
 *      `BaseWindow` that `getFocusedWindow()` never returns (null). Fall back to
 *      the registry's active-hybrid id.
 *   2. The shared chrome OVERLAY is a focusable BrowserWindow floating over the
 *      active host; Cmd+L focuses it, so `getFocusedWindow()` returns the OVERLAY
 *      and closing it alone just dismisses the address bar/widgets and leaves the
 *      page visible. When the focused window is the overlay, target the active
 *      hybrid host instead.
 *
 * A focused BrowserWindow that is NOT the overlay wins (settings, modals, canvas
 * page-hosts); otherwise the active hybrid host. Null when neither resolves, so
 * canvas-path / no-window behavior is unchanged.
 */
export function resolveFocusedWindowIdForClose(): number | null {
  // The machine's `front` IS the close target: the satellite rule already
  // excludes the chrome overlay + palette (they can never be front), and a
  // focused hybrid page-host (a BaseWindow that `getFocusedWindow()` returns
  // null for) is front too. This replaces the pure `resolveCloseTargetId`
  // overlay/hybrid resolution — the whole point of the single front authority.
  //
  // The machine speaks WM WindowId; the close path (`closeOrHideWindow` and the
  // registries it consults) is still Electron-id-keyed, so resolve the front's
  // native handle and hand back ITS id. A later migration step re-keys the
  // close path itself.
  const front = getFrontWindowId();
  if (front == null) return null;
  const win = getNativeWindowFor(front);
  return win ? win.id : null;
}

/**
 * Close the frontmost window for a cmd+W / "Close Window" command, resolving a
 * focused hybrid page-host (BaseWindow) the same as a focused BrowserWindow.
 * Routes through `closeOrHideWindow`, which now handles both window kinds
 * (BrowserWindow via the registry, hybrid BaseWindow via the registry fallback
 * added above). No-op when nothing resolves. Returns the id it acted on (or
 * null) so the menu/shortcut callers and tests can assert what was targeted.
 */
export function closeFocusedWindow(): number | null {
  const id = resolveFocusedWindowIdForClose();
  if (id == null) return null;
  // Fire-and-forget: closeOrHideWindow is async (its hybrid branch awaits a
  // fullscreen exit), but this stays sync so menu/shortcut callers and tests keep
  // reading the id it acted on. The exit-then-close still runs in order inside.
  void closeOrHideWindow(id);
  return id;
}

/**
 * Close all child windows of a given address
 */
export function closeChildWindows(aAddress: string): void {
  DEBUG && console.log('closeChildWindows()', aAddress);

  if (aAddress === WEB_CORE_ADDRESS) {
    return;
  }

  // Get all child windows from the window manager
  const childWindows = getChildWindows(aAddress);

  for (const child of childWindows) {
    const address = child.data.params.address as string;
    DEBUG && console.log('closing child window', address, 'for', aAddress);

    // recurseme
    closeChildWindows(address);

    // close window
    const win = getLiveWindow(child.id);
    if (win) {
      closeHostWindow(child.id, win);
    }
  }
}
