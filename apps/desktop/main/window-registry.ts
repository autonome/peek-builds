/**
 * Central indirection layer for window lookups.
 *
 * Backend code looks up windows through this module instead of reaching
 * for `BrowserWindow.fromId` / `BrowserWindow.getAllWindows` directly,
 * so callers never have to gate on `isDestroyed()` themselves.
 *
 * Pending / unrealized windows: the synthetic-id machinery that used to
 * live here (a second id range counting down from MAX_SAFE_INTEGER) has
 * been deleted — it had no production producers. When pending windows
 * return, they get an ordinary WM id and a `pending` lifecycle phase on
 * the reducer window record per docs/design/window-manager.md §4.1
 * (dim 12) — never a separate id range.
 */

// Type-only imports from 'electron' so this module can be imported by
// unit tests running under ELECTRON_RUN_AS_NODE=1 (where the 'electron'
// module is a string path, not a fully-populated ESM namespace, so a
// value-side `import { BrowserWindow } from 'electron'` throws at parse:
// "The requested module 'electron' does not provide an export named
// 'BrowserWindow'"). Runtime access goes through `getElectron()` via
// createRequire, mirroring the canonical pattern in tile-ipc-gate.ts /
// tile-launcher.ts. See `project_esm_require_gotcha.md`.
import type { BrowserWindow as BrowserWindowType, WebContents } from 'electron';
import { createRequire } from 'node:module';

const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') {
  if (_electron) return _electron;
  _electron = requireElectron('electron') as typeof import('electron');
  return _electron;
}

/**
 * Resolve the BrowserWindow class from the electron runtime, or null
 * when there isn't one. Under `ELECTRON_RUN_AS_NODE=1` (unit tests),
 * `require('electron')` returns the binary path string — no
 * BrowserWindow — and downstream `.fromId` / `.getAllWindows` would
 * throw `TypeError: Cannot read properties of undefined`. Live-window
 * lookups have no work to do in that environment, so callers treat a
 * null return as "no live windows exist."
 */
function getBrowserWindowClass(): typeof BrowserWindowType | null {
  const electron = getElectron() as { BrowserWindow?: typeof BrowserWindowType } | string;
  if (typeof electron !== 'object' || electron === null) return null;
  return electron.BrowserWindow ?? null;
}

/**
 * Side-channel session state that needs to survive a window's lifecycle.
 * Today only used by session restore (to bring back the active mode +
 * its metadata). Held alongside the window's descriptor.
 */
export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
}

/**
 * Everything needed to recreate a window. A WindowDescriptor is what
 * `saveSessionSnapshot` persists for each open window and what
 * `restoreSessionSnapshot` reads back to call the window-open handler.
 */
export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
  /** Focus-recency rank (higher = more recently focused), not a window stacking order. See focus-order.ts. */
  zOrder: number;
  focused: boolean;
  context?: WindowContext;
}

/**
 * Returns the live BrowserWindow for `id`, or null if there is no such
 * window or it has been destroyed.
 *
 * Use this in place of `BrowserWindow.fromId(id)`; callers no longer
 * need to gate on `isDestroyed()`.
 */
export function getLiveWindow(id: number): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Returns every non-destroyed BrowserWindow.
 *
 * Use this in place of `BrowserWindow.getAllWindows()` when you intend
 * to operate on live windows. Callers no longer need to filter out
 * destroyed entries.
 */
export function getAllLiveWindows(): BrowserWindowType[] {
  const BW = getBrowserWindowClass();
  if (!BW) return [];
  return BW.getAllWindows().filter(w => !w.isDestroyed());
}

/**
 * Returns the live BrowserWindow that owns `wc`, or null. Use this in
 * place of `BrowserWindow.fromWebContents(wc)` for callers that need
 * the destroyed-window filter.
 *
 * TRAP — the return type lies. `BrowserWindow.fromWebContents` resolves a
 * BaseWindow-hosted WebContentsView's WC (i.e. hybrid page-host content) to its
 * owning **BaseWindow**, which is NOT a BrowserWindow and is absent from
 * `BrowserWindow.getAllWindows()`. The `BrowserWindowType` annotation is
 * Electron's, and it is wrong at runtime; this returns a truthy non-BrowserWindow
 * for hybrid content. Most callers want exactly that (the window hosting the
 * page), which is why the contract is left alone. But a caller asking "is this
 * REALLY a BrowserWindow?" cannot use a truthiness check here — it must test
 * explicitly (e.g. against the hybrid registry, or `getAllLiveWindows()`
 * membership). Assuming null-for-hybrid caused the alt+click bug (peek 02e0a4fa):
 * a BrowserWindow-first branch swallowed every hybrid download and closed the
 * user's page, leaving the hybrid fallback behind it permanently dead.
 */
export function windowFromWebContents(wc: WebContents): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromWebContents(wc);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Send `channel` (with optional args) to every live window. Equivalent
 * to iterating `getAllLiveWindows()` and calling `webContents.send` on
 * each — use this when the message is meant for all renderers
 * regardless of role (theme changes, dark-mode toggles, etc.).
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of getAllLiveWindows()) {
    win.webContents.send(channel, ...args);
  }
}
