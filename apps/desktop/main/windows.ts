/**
 * Window Management Helpers
 *
 * Helper functions for managing BrowserWindow instances.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, webContents } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
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
import { registerGuest, getGuestsForWindow } from './webview-guest-registry.js';
import { getTileWindowInfo } from './tile-launcher.js';
import { getHybridWindow, getActiveHybridWindowId, getHybridContentWC, isHybridOverlayWindowId } from './hybrid-page-host-registry.js';
import { resolveHybridEscapeTarget, resolveCloseTargetId } from './izui-roles.js';

import {
  getIzuiCoordinator,
  escPolicy,
  escUnhandledPolicy,
} from './izui-state.js';

import { publish } from './pubsub.js';

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
 * Show a BrowserWindow in a headless-safe way.
 *
 * On macOS without Xvfb, both win.show() and win.showInactive() surface the
 * window at the OS level regardless of whether the window was constructed with
 * show:false.  Setting opacity to 0 before showing suppresses the on-screen
 * rendering while keeping Electron's internal visibility state intact:
 * isVisible() returns true, and focus/blur events still fire.  This is the
 * behaviour Playwright tests rely on.
 *
 * Under Linux/Xvfb the opacity step is redundant but harmless.
 * In non-headless production builds it is skipped entirely.
 *
 * @param win    The BrowserWindow to show.
 * @param opts   { active: true } to call win.show() (steals focus);
 *               default is win.showInactive() (focus-preserving).
 */
export function showWindowHeadlessSafe(
  win: BrowserWindow,
  opts?: { active?: boolean },
): void {
  if (isHeadless()) {
    try { win.setOpacity(0); } catch { /* setOpacity unsupported on some platforms */ }
  }
  if (opts?.active) {
    win.show();
  } else {
    win.showInactive();
  }
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
export function hybridShowIntent(headless: boolean, inactive: boolean = false): {
  activated: boolean;
  contentFocused: boolean;
  showInactive: boolean;
} {
  // `inactive` is the session-restore (and any `show:false` caller) intent: make
  // the host VISIBLE but never activate the app or steal first-responder. Each
  // restored hybrid window must NOT activate itself — otherwise the last one
  // dispatched (or whichever wins the macOS show-storm race) ends up frontmost,
  // and the page the user actually left focused at quit is not the one raised.
  // The canvas path already honors `show:false` this way (ipc.ts BrowserWindow
  // ctor `show: options.show !== false`); the hybrid path must match. The
  // restore loop's focus block is then the SINGLE authority that activates +
  // focuses the one focused descriptor (via an activating showHybridHost call).
  if (inactive) {
    return { activated: false, contentFocused: false, showInactive: true };
  }
  if (headless) {
    return { activated: false, contentFocused: false, showInactive: true };
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
 */
export function showHybridHost(
  baseWin: import('electron').BaseWindow,
  contentWC: import('electron').WebContents,
  opts?: { inactive?: boolean },
): { activated: boolean; contentFocused: boolean; showInactive: boolean } {
  const intent = hybridShowIntent(isHeadless(), opts?.inactive === true);
  if (isHeadless()) {
    // Keep it invisible (opacity 0) — never paints on the physical desktop.
    try { baseWin.setOpacity(0); } catch { /* setOpacity unsupported on some platforms */ }
  }
  if (intent.activated) {
    // show() activates the app (frontmost + key window) AND raises this window.
    try { baseWin.show(); } catch { /* show unsupported in some envs */ }
  } else {
    // Focus-free: visible (state) but never activated.
    try { baseWin.showInactive(); } catch { /* showInactive unsupported in some envs */ }
  }
  if (intent.contentFocused) {
    // Make the content WebContentsView the macOS first responder so key
    // equivalents (cmd+L etc.) route to it instead of beeping at AppKit.
    try { if (!contentWC.isDestroyed()) contentWC.focus(); } catch { /* wc gone */ }
  }
  return intent;
}

/**
 * Modify window state (close, hide, show)
 */
export function modWindow(bw: BrowserWindow, params: { action: string }): void {
  if (params.action === 'close') {
    bw.close();
  }
  if (params.action === 'hide') {
    bw.hide();
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
 * Core ESC handling logic for a BrowserWindow.
 * Called when ESC keyDown is detected on the window's own webContents
 * or on a webview guest webContents within the window.
 *
 * Uses IZUI window roles to determine behavior via escPolicy().
 *
 * @param bw - The BrowserWindow to handle ESC for
 * @param source - 'host' if from the window's own webContents, 'webview' if from a guest
 */
async function handleEscapeForWindow(bw: BrowserWindow, source: 'host' | 'webview'): Promise<void> {
  if (bw.isDestroyed()) return;
  // The BrowserWindow's own webContents is the renderer that owns the onEscape
  // callback for a canvas/legacy window.
  await handleEscapeForWindowId(bw.id, bw.webContents, source, () => bw.isDestroyed());
}

/**
 * ESC handler for a hybrid page-host (`BaseWindow`).
 *
 * Regression (Cluster B, peek e8081cce/companion): when the hybrid page-host
 * became the default web-page renderer, peeks/slides — which open with
 * `role:'quick-view' + modal + canvas` and are therefore BaseWindows under the
 * hybrid default — stopped closing on ESC. The ESC→close path lived ENTIRELY on
 * the per-`BrowserWindow` `before-input-event` (`addEscHandler`), which is never
 * wired for a BaseWindow host. A focused hybrid host makes its content
 * `WebContentsView` the macOS first responder, so ESC arrives at the content
 * WC's `before-input-event` (`wireHybridContentEvents` in ipc.ts) instead — the
 * SAME class of break as the cmd+W/L/N cluster.
 *
 * This routes the hybrid ESC through the IDENTICAL policy decision the canvas
 * path uses (`handleEscapeForWindowId` → escPolicy / escUnhandledPolicy), with
 * the content WC as the renderer to ask. ONE source of truth — no forked policy.
 * The hostWindowId is the BaseWindow id, which is registered in the shared
 * window registry by the ipc.ts hybrid branch (`registerWindow(baseWin.id, …)`),
 * so role/escapeMode resolve exactly as for a BrowserWindow.
 *
 * WRONG-WINDOW / first-responder redirect (peek ebb10894): `before-input-event`
 * only fires for the macOS first responder. On a fresh peek/slide open the
 * previously-focused hybrid CONTENT host can still hold first-responder for a
 * beat, so ESC lands on ITS content WC and resolves role 'content' → escPolicy
 * 'nothing' → escUnhandledPolicy → the Windows SWITCHER, instead of closing the
 * quick-view the user just opened (the reported "ESC opens the switcher most of
 * the time, unless I click the content first" intermittency). The hybrid
 * registry's `getActiveHybridWindowId()` is the focus source of truth — driven
 * by our OWN `focus` events from `showHybridHost` on open, not the laggy macOS
 * first-responder — so it already points at the just-opened peek/slide. When the
 * ESC landed on a DIFFERENT host than the active hybrid window AND the active
 * window is an always-closeable transient (quick-view/palette/utility/overlay),
 * redirect the ESC to the active host's content WC so it resolves 'close'. The
 * decision is the pure `resolveHybridEscapeTarget` (izui-roles.ts) so it is
 * unit-testable without real OS focus. Same policy core (`handleEscapeForWindowId`
 * → escPolicy) runs afterward — no forked policy, no new ESC path.
 *
 * @param hostWindowId - the hybrid BaseWindow id whose content WC received ESC
 * @param contentWC - that host's content WebContentsView (the renderer to ask)
 */
export async function handleHybridEscape(
  hostWindowId: number,
  contentWC: Electron.WebContents,
): Promise<void> {
  // Resolve the ACTUAL target: if ESC landed on the wrong (non-active) hybrid
  // host because its content WC was still first responder, redirect to the
  // active hybrid window when that one is an always-closeable transient (the
  // freshly-opened quick-view peek/slide). Focus source of truth = the registry.
  const activeId = getActiveHybridWindowId();
  const activeRole = activeId != null
    ? (getWindowInfo(activeId)?.params?.role as string | undefined)
    : undefined;
  const targetId = resolveHybridEscapeTarget(hostWindowId, activeId, activeRole);

  if (targetId !== hostWindowId) {
    // Redirecting to the active host — ask ITS content WC (the renderer that
    // owns the quick-view) and use ITS liveness probe. Fall back to the landed
    // host if the active content WC vanished between the decision and here.
    const activeWC = getHybridContentWC(targetId);
    if (activeWC && !activeWC.isDestroyed()) {
      DEBUG && console.log(`[esc] hybrid ESC redirected from host ${hostWindowId} to active host ${targetId} (role ${activeRole})`);
      await handleEscapeForWindowId(targetId, activeWC, 'host', () => activeWC.isDestroyed());
      return;
    }
  }

  await handleEscapeForWindowId(hostWindowId, contentWC, 'host', () => contentWC.isDestroyed());
}

/**
 * Shared core for ESC handling, keyed by window id + the WebContents to ask.
 * Drives the SINGLE escPolicy/escUnhandledPolicy decision for both the canvas
 * BrowserWindow path (`handleEscapeForWindow`) and the hybrid BaseWindow path
 * (`handleHybridEscape`). The only kind-specific inputs are the `askWC` (the
 * renderer that owns `onEscape`) and `isDestroyed` (the liveness probe for the
 * window/wc that owns it).
 */
async function handleEscapeForWindowId(
  winId: number,
  askWC: Electron.WebContents,
  source: 'host' | 'webview',
  isDestroyed: () => boolean,
): Promise<void> {
  // Resolve escape role/address from the shared window-registry first
  // (IPC-opened windows, including hybrid page-hosts), then fall back to
  // tile-launcher's own info map (feature-tile windows, which are deliberately
  // kept OUT of the shared registry so they don't pollute the "reopen last
  // closed window" stack). The registry entry is `{ source, params }`; the
  // tile-info entry is the flat `params` itself — normalize to `params` either way.
  const registryEntry = getWindowInfo(winId);
  const tileEntry = registryEntry ? undefined : getTileWindowInfo(winId);
  const entry = registryEntry ?? tileEntry;
  if (!entry || isDestroyed()) return;

  const params = (registryEntry ? registryEntry.params : tileEntry) as Record<string, unknown>;
  // Should always be set by ipc.ts window-open inference (line ~1167); fallback
  // mirrors that inference's default-default — workspace, not utility — so the
  // ESC behaviour never silently regresses to "always close" if a window
  // somehow lands here without role on its registry params.
  const role = (params.role as string) || 'workspace';
  DEBUG && console.log(`[esc] ESC keyDown - window ${winId}, source: ${source}, role: ${role}, url: ${params.address}`);

  // escapeMode: 'ignore' is a hard override — let ESC pass through entirely
  if (params.escapeMode === 'ignore') {
    DEBUG && console.log('[esc] Ignore mode - not handling ESC');
    return;
  }

  // Ask renderer first (dialog close, internal navigation, etc.)
  const response = await askWebContentsToHandleEscape(winId, askWC);
  if (response.handled) return;

  // Look up session state and apply role-based policy
  const coordinator = getIzuiCoordinator();
  const sessionState = coordinator.getState();
  const action = escPolicy(sessionState, role);
  DEBUG && console.log(`[esc] escPolicy(${sessionState}, ${role}) -> ${action}`);

  if (action === 'close' || action === 'close-and-restore') {
    closeOrHideWindow(winId);
  } else {
    // escPolicy returned 'nothing' — renderer is at root and window won't close.
    // Consult second-phase policy for unhandled ESC.
    //
    // Guard: if an overlay just closed (within 300ms), skip the switcher open.
    // Without this guard, the ESC that dismissed the overlay lands on the
    // workspace window immediately after exitOverlay() runs, and
    // escUnhandledPolicy('active', 'workspace') returns 'open-switcher',
    // causing the switcher to re-open in a tight loop.
    if (coordinator.isWithinOverlayExitCooldown()) {
      DEBUG && console.log(`[esc] Skipping escUnhandledPolicy — within overlay exit cooldown`);
      return;
    }
    const unhandledAction = escUnhandledPolicy(sessionState, role);
    DEBUG && console.log(`[esc] escUnhandledPolicy(${sessionState}, ${role}) -> ${unhandledAction}`);
    if (unhandledAction === 'open-switcher') {
      publish('peek://system/', 'cmd:execute:windows', {});
    }
  }
}

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

  // Helper: attach ESC interception to a WebContents (host or guest)
  const attachEscListener = (wc: Electron.WebContents, source: 'host' | 'webview') => {
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

        await handleEscapeForWindow(bw, source);
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
    // can find which page-host BrowserWindow to surface UI in.
    registerGuest(guestWebContents, bw.id);
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

    // Open DevTools after a slight delay to let the main window settle
    setTimeout(() => {
      bw.webContents.openDevTools(devToolsOptions);

      // when devtools completely open, ensure content window has focus
      bw.webContents.once('devtools-opened', () => {
        // Re-focus the content window after devtools opens
        setTimeout(() => {
          if (bw.isVisible() && !bw.isDestroyed()) {
            bw.focus();
            bw.webContents.focus();
          }
        }, 100);
      });
    }, 50);
  }
}

/** Minimal close surface shared by BrowserWindow and (hybrid) BaseWindow. */
interface ClosableWindow {
  isDestroyed(): boolean;
  close(): void;
}

/**
 * Close a host window, but if it owns page-host guest WebContents (a `<webview>`
 * guest on the canvas path, or a `WebContentsView` content on the hybrid path —
 * both registered via `registerGuest`), DESTROY those guests and wait for them
 * to actually go away FIRST, then close the host.
 *
 * Why this ordering matters — page-host close use-after-free (peek d1cf0b9a /
 * 4b2cc09d): closing the host directly runs `performClose:` →
 * `-[NSWindow __close]`, which tears the guest renderer down *inside* the native
 * window-close callback. Every http page-host guest carries the chrome-extension
 * runtime-external relay preload (TWP's `<all_urls>` content script matches any
 * http URL since b8eff4d2), so a guest can have an in-flight
 * `ipcRenderer.invoke('peek:runtime-external:send')` at that instant. Tearing it
 * down from the window-close path then derefs a freed cppgc/Blink object →
 * `EXC_BAD_ACCESS` in the main process. Destroying the guest first drains/cancels
 * its IPC through the normal renderer-teardown path, so by the time the host
 * closes there is no live guest to dereference.
 *
 * No-guest windows (settings, modals, overlays, the cmd panel, …) take the
 * synchronous fast path — byte-identical to the previous `win.close()`.
 */
export function closeHostWindow(hostId: number, win: ClosableWindow): void {
  const guestIds = getGuestsForWindow(hostId);
  // PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1 reverts to the raw close (no ordered
  // guest teardown) — the pre-fix behavior. Test/diagnostic seam for A/B'ing
  // the page-host close UAF guard; never set in production.
  if (guestIds.length === 0 || process.env.PEEK_DISABLE_PAGEHOST_CLOSE_GUARD === '1') {
    if (!win.isDestroyed()) win.close();
    return;
  }
  void destroyGuestsThenClose(hostId, win, guestIds);
}

async function destroyGuestsThenClose(
  hostId: number,
  win: ClosableWindow,
  guestIds: number[],
): Promise<void> {
  DEBUG && console.log('closeHostWindow: destroying', guestIds.length, 'guest(s) before closing host', hostId);
  await Promise.all(
    guestIds.map(
      (gid) =>
        new Promise<void>((resolve) => {
          const wc = webContents.fromId(gid);
          if (!wc || wc.isDestroyed()) {
            resolve();
            return;
          }
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          // Don't wait forever — close the host anyway after a bounded wait if
          // the guest never emits 'destroyed' (it usually does within a frame).
          const timer = setTimeout(finish, 2000);
          wc.once('destroyed', finish);
          try {
            // webContents.destroy() exists at runtime but isn't in the Electron
            // type defs. Forceful (immediate, skips beforeunload) is what we
            // want — guarantee the guest is gone before the host closes.
            (wc as unknown as { destroy(): void }).destroy();
          } catch {
            finish();
          }
        }),
    ),
  );
  if (!win.isDestroyed()) win.close();
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
// Re-exported here so existing imports `from './windows.js'` keep working.
// The set covers palette/quick-view/overlay — windows that ride above the
// workspace, must not affect dock visibility, and on macOS follow the user
// across Spaces. Used both for dock-count exclusion below and for the
// focus-driven auto-hide path (a non-transient window gaining focus
// dismisses any transient sibling via closeOrHideWindow, restoring the
// blur-on-focus-change behavior that NSPanels swallow).
export { TRANSIENT_ROLES } from './izui-roles.js';
import { TRANSIENT_ROLES } from './izui-roles.js';

/**
 * Get count of visible persistent windows (excluding background, modals, overlays, HUD).
 * Used by maybeHideApp to decide whether to hide the app when a window closes.
 */
export function getVisibleWindowCount(excludeId: number | null = null): number {
  return getAllLiveWindows().filter(win => {
    if (excludeId && win.id === excludeId) return false;
    if (!win.isVisible()) return false;

    const entry = getWindowInfo(win.id);

    // Exclude the background window
    if (entry && entry.params.address === WEB_CORE_ADDRESS) return false;

    // Exclude transient modals and overlays (cmd palette, quick-view, windows switcher)
    if (entry && TRANSIENT_ROLES.has(entry.params.role as string)) return false;

    // Exclude non-focusable utility windows (HUD)
    if (entry && entry.params.role === 'utility' && entry.params.focusable === false) return false;

    return true;
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

  if (isTestProfile() || isHeadless()) {
    app.dock.hide();
    return;
  }

  const prefs = _getPrefs();
  const prefShowDock = prefs?.showInDockAndSwitcher === true;

  DEBUG && console.log('applyDockPreference:', { prefShowDock });

  if (prefShowDock) {
    app.dock.show();
  } else {
    app.dock.hide();
  }
}

/**
 * Hide the app if there are no other visible windows
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
export function closeOrHideWindow(id: number): void {
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
        // keepLive parity with the BrowserWindow branch below: a hybrid
        // peek/slide opened with keepLive:true (e.g. the left slide playing
        // music) must be HIDDEN, not destroyed, so its WebContentsView keeps
        // running in the background and the window-open key/url-reuse path can
        // re-show it (ipc.ts → baseWin.show()). The window params (incl.
        // keepLive) are registered for the hybrid baseWin id at creation
        // (ipc.ts ~2211), so getWindowInfo resolves the same flag the canvas
        // path reads. `baseWin.hide()` does NOT emit 'close', so the
        // close-finalize tail (which destroys the content wc + unregisters)
        // never runs on hide — exactly the keep-alive semantics required (see
        // the runHybridFinalize comment in ipc.ts). Only a genuine
        // closeHostWindow frees the resources.
        const hybridEntry = getWindowInfo(id);
        if (hybridEntry?.params.keepLive === true) {
          DEBUG && console.log(`HIDING keepLive hybrid page-host BaseWindow ${id}`);
          hybrid.baseWin.hide();
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
    else if (params.keepLive === true) {
      win.hide();
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
  const focused = BrowserWindow.getFocusedWindow();
  return resolveCloseTargetId(
    focused ? focused.id : null,
    focused != null && isHybridOverlayWindowId(focused.id),
    getActiveHybridWindowId(),
  );
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
  closeOrHideWindow(id);
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
