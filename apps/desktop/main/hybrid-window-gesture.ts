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
 * Detent detection rides Chromium's native multi-click counter (`MouseEvent.detail`)
 * rather than debouncing double-vs-triple itself (fsm-pilled) — that IS the OS's
 * own double-click-interval timer, inherited rather than hand-rolled here, and it
 * discriminates double-vs-triple cleanly. What it does NOT discriminate is
 * click-vs-drag: a click-drag's terminating click can inherit detail===2 from a
 * prior click within the OS interval even though the pointer moved. That second
 * axis is covered separately and deterministically — see GESTURE_DRAG_SLOP_PX
 * below, which suppresses the gesture on measured pointer travel instead of
 * adding a second timer. A triple-click therefore
 * fires detent 2 THEN detent 3 within the same native sequence: on the way IN it
 * maximizes (detent 2) then goes fullscreen (detent 3). A triple-click is a clean
 * TOGGLE, though — on the way OUT it restores the pre-gesture bounds rather than
 * leaving the window stuck maximized. The incidental detent-2 maximize is undone
 * when leaving fullscreen: entering fullscreen from maximized sets the entry's
 * `unmaximizeOnFullScreenExit` flag, and the host's `leave-full-screen` handler
 * (ipc.ts `assembleHybridPageHost`) un-maximizes back to `preMaxBounds` once macOS
 * has settled the exit — deterministic, no timer, and after the transition so the
 * restore setBounds isn't dropped.
 */
import { createRequire } from 'node:module';
import type { WebContents } from 'electron';
import { publish, getSystemAddress } from './pubsub.js';
import {
  getHybridWindowByContentWC,
  setHybridUnmaximizeOnFullScreenExit,
} from './hybrid-page-host-registry.js';

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

// Pointer-jitter tolerance in CSS px between the mousedown that produced a click
// and the click itself, matching the JITTER_TOLERANCE convention in
// renderer/page/overlay.js. Travel beyond this means the click's press-to-release
// was a drag, not a stationary multi-click — see module header.
export const GESTURE_DRAG_SLOP_PX = 5;

/** Coerce a possibly-malformed travel value to a finite number, defaulting to 0. */
function coerceTravel(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Pure: map a native click detent to the window action it triggers, suppressing
 * BOTH detents when the click's press-to-release pointer travel exceeds
 * GESTURE_DRAG_SLOP_PX (a click-drag, not a stationary multi-click).
 */
export function windowGestureAction(
  detent: unknown,
  dragDx: unknown = 0,
  dragDy: unknown = 0,
): WindowGestureAction {
  if (Math.hypot(coerceTravel(dragDx), coerceTravel(dragDy)) > GESTURE_DRAG_SLOP_PX) return null;
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
    const p = payload as { detent?: unknown; dragDx?: unknown; dragDy?: unknown } | null;
    handleContentWindowGesture(event.sender, p?.detent, p?.dragDx, p?.dragDy);
  });
}

/**
 * Route a content window gesture from `sender` (the content WebContents) to its
 * host BaseWindow. Exported for the unit test (a real content WC is unavailable to
 * node-side tests, so the test seeds the registry and drives this directly).
 */
export function handleContentWindowGesture(
  sender: WebContents,
  detent: unknown,
  dragDx: unknown = 0,
  dragDy: unknown = 0,
): void {
  const action = windowGestureAction(detent, dragDx, dragDy);
  if (!action) return;
  const entry = getHybridWindowByContentWC(sender);
  if (!entry || entry.baseWin.isDestroyed()) return;
  if (action === 'toggle-maximize') {
    // A triple-click fires detent-2 (maximize) THEN detent-3 (fullscreen). On the
    // way OUT of fullscreen the SAME triple-click fires detent-2 again while the
    // host is STILL fullscreen; routing that to the overlay's toggleMaximize flips
    // maximized→false and (via page:unmaximize) nulls preMaxBounds, while its
    // setBounds() is silently dropped because macOS can't resize a fullscreen
    // window. The window then leaves fullscreen at its macOS-remembered
    // pre-fullscreen bounds — the maximized workArea, since a triple-click always
    // enters fullscreen FROM maximized — so it looks maximized but the state
    // machine says not-maximized: the "stuck maximized / drag snaps back" desync
    // (confirmed by live trace, peek d8ce0ddf). Gate the maximize-toggle on the
    // host NOT being fullscreen: on entry detent-2 arrives before detent-3's
    // setFullScreen (not-yet-fullscreen) so maximize still runs; on exit it is
    // suppressed, keeping maximized=true + preMaxBounds intact through the exit. The
    // restore back to the pre-gesture bounds then happens in the host's
    // `leave-full-screen` handler (see the fullscreen branch below). Deterministic,
    // no timer.
    if (entry.baseWin.isFullScreen()) return;
    // Route through the overlay (it owns maximize state + chrome reflow); see header.
    publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: entry.windowId });
  } else {
    // detent-3 → toggle fullscreen (main owns the host). When ENTERING fullscreen,
    // remember whether we're doing so from a maximized state (the triple-click's
    // detent-2 just ran ~one inter-click gap ago, so entry.maximized is current):
    // if so, the host's `leave-full-screen` handler will un-maximize back to
    // preMaxBounds on the way out, making the triple-click a clean toggle instead of
    // leaving the window stuck maximized. Reconciling on the exit EVENT (not here)
    // avoids the dropped-setBounds trap — macOS won't resize a fullscreen window.
    const entering = !entry.baseWin.isFullScreen();
    if (entering) setHybridUnmaximizeOnFullScreenExit(entry.windowId, entry.maximized);
    try {
      entry.baseWin.setFullScreen(entering);
    } catch { /* window gone mid-toggle */ }
  }
}
