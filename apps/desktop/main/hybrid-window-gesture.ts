/**
 * Content-area double-click window gesture (peek d8ce0ddf).
 *
 * The universal content preload (chrome-api-polyfills/runtime-external-preload.cjs)
 * detects a double-click over "dead" page content — one that does NOT land on an
 * editable/interactive control and does NOT select text — and reports it as
 * `ipcRenderer.send('page:content-window-gesture', { detent })`, where `detent` is
 * Chromium's native multi-click count (2 = double-click). The suppression
 * (editable/interactive target, live text selection) is evaluated CONTENT-SIDE
 * because only the page realm has the DOM target/composedPath and the live
 * selection; main's `input-event` stream carries `clickCount` but no target.
 *
 * This module maps that gesture to a window action against the host BaseWindow:
 *   detent 2 → toggle maximize   — routed back THROUGH the shared chrome overlay
 *              (`page:request-toggle-maximize` → overlay's `toggleMaximize`) so the
 *              overlay stays the single owner of the maximize TOGGLE decision +
 *              chrome reflow (its renderer keeps a local `maximized` mirror for
 *              that; the authoritative state lives on the window-state machine
 *              record — §5 step 7B). It drives the SAME toggle the navbar
 *              double-click uses; toggling bounds here directly would desync it.
 *
 * Fullscreen is NOT a content gesture. It is command-driven and single-owned by
 * main: the `fullscreen` command → `tile:window:fullscreen` IPC → the registry's
 * `setHybridHostFullScreen` owner (which gates on the SETTLED native fullscreen
 * state, not `isFullScreen()`). Triple-click no longer enters fullscreen.
 *
 * Detent detection rides Chromium's native multi-click counter (`MouseEvent.detail`)
 * rather than debouncing itself (fsm-pilled) — that IS the OS's own
 * double-click-interval timer, inherited rather than hand-rolled here. What it does
 * NOT discriminate is click-vs-drag: a click-drag's terminating click can inherit
 * detail===2 from a prior click within the OS interval even though the pointer
 * moved. That second axis is covered separately and deterministically — see
 * GESTURE_DRAG_SLOP_PX below, which suppresses the gesture on measured pointer
 * travel instead of adding a second timer.
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

export type WindowGestureAction = 'toggle-maximize' | null;

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
 * the gesture when the click's press-to-release pointer travel exceeds
 * GESTURE_DRAG_SLOP_PX (a click-drag, not a stationary double-click).
 */
export function windowGestureAction(
  detent: unknown,
  dragDx: unknown = 0,
  dragDy: unknown = 0,
): WindowGestureAction {
  if (Math.hypot(coerceTravel(dragDx), coerceTravel(dragDy)) > GESTURE_DRAG_SLOP_PX) return null;
  if (detent === 2) return 'toggle-maximize';
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
  // detent-2 → toggle maximize. Gate the maximize-toggle on the host NOT being
  // fullscreen: fullscreen is now command-driven (tile:window:fullscreen →
  // setHybridHostFullScreen), so a host CAN be fullscreen while a dead-space
  // double-click lands. Maximizing a fullscreen host would desync the overlay's
  // maximized/preMaxBounds state against the window's actual (fullscreen) bounds,
  // and macOS silently drops a resize on a fullscreen window anyway — so ignore
  // the gesture while fullscreen. Deterministic, no timer.
  if (entry.baseWin.isFullScreen()) return;
  // Route through the overlay (it owns maximize state + chrome reflow); see header.
  publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: entry.windowId });
}
