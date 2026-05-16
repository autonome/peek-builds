/**
 * Central indirection layer for window lookups.
 *
 * Today every backend file reaches for Electron's `BrowserWindow.fromId` /
 * `BrowserWindow.getAllWindows` / `BrowserWindow.fromWebContents` directly,
 * and almost every site immediately follows with a `!win.isDestroyed()`
 * check. This module collapses both responsibilities into one place so
 * future changes to "what counts as a window" only have to edit one file.
 *
 * Phase 1 (this file): pure no-op wrappers. The destroyed-window filter
 * runs here instead of at every call site, but the observable behavior
 * is identical.
 *
 * Phase 2 will extend `getLiveWindow` to return null for pending
 * (not-yet-realized) windows and add a sibling API that returns refs to
 * both pending and live windows for callers that want to act on all of
 * them (e.g. `tile:window:list`).
 */

import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';

/**
 * Side-channel session state that needs to survive a window's lifecycle.
 * Today only used by session restore (to bring back the active mode +
 * its metadata). Held alongside the window's descriptor so a Pending
 * (not-yet-realized) window can carry it forward too.
 */
export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
}

/**
 * Everything needed to recreate a window. A WindowDescriptor is what
 * `saveSessionSnapshot` persists for each open window and what
 * `restoreSessionSnapshot` reads back to call the window-open handler.
 *
 * In phase 2+ this will also be the payload carried by a Pending
 * WindowRef so the registry can serve "fake" windows from descriptors
 * until they're realized on demand.
 */
export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
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
export function getLiveWindow(id: number): BrowserWindow | null {
  const win = BrowserWindow.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Returns every non-destroyed BrowserWindow.
 *
 * Use this in place of `BrowserWindow.getAllWindows()` when you intend
 * to operate on live windows. Callers no longer need to filter out
 * destroyed entries.
 */
export function getAllLiveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
}

/**
 * Returns the live BrowserWindow that owns `wc`, or null. Use this in
 * place of `BrowserWindow.fromWebContents(wc)` for callers that need
 * the destroyed-window filter.
 */
export function windowFromWebContents(wc: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(wc);
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
