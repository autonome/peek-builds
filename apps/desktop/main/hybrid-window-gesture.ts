/**
 * Content-area double/triple-click window gesture (peek d8ce0ddf).
 *
 * The universal content preload (chrome-api-polyfills/runtime-external-preload.cjs)
 * detects a double- or triple-click over "dead" page content — one that does NOT
 * land on an editable/interactive control and does NOT select text — and reports
 * it as `ipcRenderer.send('page:content-window-gesture', { detent })`, where
 * `detent` is Chromium's native multi-click count (2 = double, 3 = triple). The
 * suppression (editable/interactive target, live text selection) is evaluated
 * CONTENT-SIDE because only the page realm has the DOM target/composedPath and the
 * live selection; main's `input-event` stream carries `clickCount` but no target.
 *
 * This module maps that gesture to a window action against the host BaseWindow:
 *   detent 2 → toggle maximize   — routed back THROUGH the shared chrome overlay
 *              (`page:request-toggle-maximize` → overlay's `toggleMaximize`) so the
 *              overlay stays the single source of truth for maximize state +
 *              chrome reflow. The overlay owns `maximized`/`preMaxBounds` and drives
 *              the SAME toggle the navbar double-click uses; toggling bounds here
 *              directly would desync it.
 *   detent 3 → toggle fullscreen — `BaseWindow.setFullScreen` (main owns the host).
 *
 * Deterministic, no timers: it rides Chromium's native multi-click counter rather
 * than debouncing double-vs-triple itself (fsm-pilled). A triple-click therefore
 * fires detent 2 THEN detent 3 within the same native sequence — by design the
 * window grows monotonically (normal → maximized → fullscreen); exiting fullscreen
 * leaves it maximized.
 */
import { createRequire } from 'node:module';
import type { WebContents } from 'electron';
import { publish, getSystemAddress } from './pubsub.js';
import { getHybridWindowByContentWC } from './hybrid-page-host-registry.js';

// `ipcMain` is fetched lazily (only when the receiver is actually registered at
// runtime) rather than via a top-level `import { ipcMain } from 'electron'`.
// A top-level RUNTIME electron import makes this module un-importable under the
// unit runners (`ELECTRON_RUN_AS_NODE=1 electron --test` / `node --test`), where
// `electron` resolves to a path string with no named exports — which would trap
// the pure `windowGestureAction` behind an un-loadable module. Type-only imports
// (above) are erased at compile time and stay safe. This matches the repo
// convention that unit-tested main modules keep electron imports type-only.
const requireElectron = createRequire(import.meta.url);

export type WindowGestureAction = 'toggle-maximize' | 'toggle-fullscreen' | null;

/** Pure: map a native click detent to the window action it triggers. */
export function windowGestureAction(detent: unknown): WindowGestureAction {
  if (detent === 2) return 'toggle-maximize';
  if (detent === 3) return 'toggle-fullscreen';
  return null;
}

let registered = false;

/**
 * Register the `page:content-window-gesture` IPC receiver exactly once. Idempotent —
 * safe to call from every `wireHybridContentEvents` invocation.
 */
export function initHybridWindowGestureHandling(): void {
  if (registered) return;
  registered = true;
  const { ipcMain } = requireElectron('electron') as typeof import('electron');
  ipcMain.on('page:content-window-gesture', (event, payload: unknown) => {
    const detent = (payload as { detent?: unknown } | null)?.detent;
    handleContentWindowGesture(event.sender, detent);
  });
}

/**
 * Route a content window gesture from `sender` (the content WebContents) to its
 * host BaseWindow. Exported for the unit test (a real content WC is unavailable to
 * node-side tests, so the test seeds the registry and drives this directly).
 */
export function handleContentWindowGesture(sender: WebContents, detent: unknown): void {
  const action = windowGestureAction(detent);
  if (!action) return;
  const entry = getHybridWindowByContentWC(sender);
  if (!entry || entry.baseWin.isDestroyed()) return;
  if (action === 'toggle-maximize') {
    // Route through the overlay (it owns maximize state + chrome reflow); see header.
    publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: entry.windowId });
  } else {
    try {
      entry.baseWin.setFullScreen(!entry.baseWin.isFullScreen());
    } catch { /* window gone mid-toggle */ }
  }
}
