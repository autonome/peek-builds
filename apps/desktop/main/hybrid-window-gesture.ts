// Maps the content preload's `page:content-window-gesture` report (a double-click over "dead"
// page content, detent = Chromium's native multi-click count) to a window action. Two senders
// share the report and the dead-space detection (chrome-api-polyfills/dead-space-gesture.cjs):
// hybrid page-host content (toggled through the overlay, on the host BaseWindow) and plain
// peek:// feature windows loaded with the tile preload (toggled through the kernel, like
// tile:window:maximize). Fullscreen is a separate, command-driven path (tile:window:fullscreen) and is not
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

// What a plain (non-hybrid) window does with a dead-space double-click. Pure: the caller
// supplies the facts. `optOut` is the window's `maximizeOnDoubleClick: false` open option.
export type PlainToggle = 'maximize' | 'unmaximize' | null;
export function plainWindowToggle(facts: {
  maximized: boolean;
  fullscreen: boolean;
  optOut: boolean;
}): PlainToggle {
  if (facts.optOut || facts.fullscreen) return null;
  return facts.maximized ? 'unmaximize' : 'maximize';
}

// Facts and the kernel feed for a plain window, injected by ipc.ts (this module cannot import
// the kernel/registry value modules and stay loadable under the unit runner).
export interface PlainWindowGestureHost {
  // null when the sender is not a registered plain window
  describe(sender: WebContents): { maximized: boolean; fullscreen: boolean; optOut: boolean } | null;
  apply(sender: WebContents, toggle: 'maximize' | 'unmaximize'): void;
}
let plainHost: PlainWindowGestureHost | null = null;
export function setPlainWindowGestureHost(host: PlainWindowGestureHost | null): void {
  plainHost = host;
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
  if (!entry) {
    // Not a hybrid page host: a plain peek:// feature window.
    const facts = plainHost?.describe(sender);
    if (!facts) return;
    const toggle = plainWindowToggle(facts);
    if (toggle) plainHost?.apply(sender, toggle);
    return;
  }
  if (entry.baseWin.isDestroyed()) return;
  // A dead-space double-click can land while the host is fullscreen (fullscreen is a separate,
  // command-driven path); maximizing there would desync the overlay's bounds bookkeeping.
  if (entry.baseWin.isFullScreen()) return;
  // Routed through the overlay: it is the single owner of the maximize toggle + chrome reflow,
  // and drives the same toggle the navbar double-click uses.
  publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: entry.windowId });
}
