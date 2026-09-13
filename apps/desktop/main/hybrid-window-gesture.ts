// Maps the content preload's `page:content-window-gesture` report (a double-click over "dead"
// page content, detent = Chromium's native multi-click count) to a window action on the host
// BaseWindow. Fullscreen is a separate, command-driven path (tile:window:fullscreen) and is not
// a content gesture.
import { createRequire } from 'node:module';
import type { WebContents } from 'electron';
import { publish, getSystemAddress } from './pubsub.js';
import { getHybridWindowByContentWC } from './hybrid-page-host-registry.js';

// `ipcMain` is fetched lazily rather than via a top-level runtime `import { ipcMain } from
// 'electron'`, which would make this module un-importable under the unit runners (`electron`
// resolves to a path string there) and trap the pure `windowGestureAction` behind it.
const requireElectron = createRequire(import.meta.url);

export type WindowGestureAction = 'toggle-maximize' | null;

// Pointer-jitter tolerance in CSS px, matching JITTER_TOLERANCE in renderer/page/overlay.js.
// Travel beyond this means the click's press-to-release was a drag, not a stationary multi-click.
export const GESTURE_DRAG_SLOP_PX = 5;

function coerceTravel(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

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

export function initHybridWindowGestureHandling(): void {
  if (registered) return;
  registered = true;
  const { ipcMain } = requireElectron('electron') as typeof import('electron');
  ipcMain.on('page:content-window-gesture', (event, payload: unknown) => {
    const p = payload as { detent?: unknown; dragDx?: unknown; dragDy?: unknown } | null;
    handleContentWindowGesture(event.sender, p?.detent, p?.dragDx, p?.dragDy);
  });
}

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
  // A dead-space double-click can land while the host is fullscreen (fullscreen is a separate,
  // command-driven path); maximizing there would desync the overlay's bounds bookkeeping.
  if (entry.baseWin.isFullScreen()) return;
  // Routed through the overlay: it is the single owner of the maximize toggle + chrome reflow,
  // and drives the same toggle the navbar double-click uses.
  publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: entry.windowId });
}
