// nonactivating-window.ts — ordinary windows that take key without activating
// the app, through the macOS addon `native/nonactivating-window/nonactivating_window.mm`.
//
// A page opened from the palette over another app must take key while the other
// app stays frontmost. A panel can, but macOS puts an Electron panel on every
// desktop, so it is drawn on the desktop being switched to before Peek can close
// it. An ordinary window flagged through this module takes key the same way and
// stays on the desktop it opened on. Electron's own window and web contents
// `focus()` activate the app for any non-panel, so a flagged window takes key and
// content focus only through `makeKey` and `focusContent` here.
//
// Absent addon (other platforms, or a build without clang or the Node-API
// headers): `ordinaryNonActivatingSupported()` is false and callers build a panel.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

interface NonActivatingAddon {
  setNonActivating(handle: Buffer, on: boolean): boolean;
  makeKey(handle: Buffer): boolean;
  focusContent(handle: Buffer): boolean;
  isKey(handle: Buffer): boolean;
}

interface HandleWindow {
  getNativeWindowHandle?(): Buffer;
}

export const NONACTIVATING_ADDON_FILE = 'nonactivating-window.node';

/**
 * Where the addon lives: `Contents/Resources` when packaged (electron-builder
 * `extraResources`), `dist/native` when run from source.
 */
export function nonActivatingAddonPath(packaged: boolean, resourcesPath: string): string {
  if (packaged) return join(resourcesPath, NONACTIVATING_ADDON_FILE);
  // This file compiles to dist/main/; the build puts the addon in dist/native/.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'native', NONACTIVATING_ADDON_FILE);
}

let addon: NonActivatingAddon | null | undefined;

function loadAddon(): NonActivatingAddon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== 'darwin') return addon;
  try {
    addon = createRequire(import.meta.url)(nonActivatingAddonPath(app.isPackaged, process.resourcesPath)) as NonActivatingAddon;
  } catch (e) {
    console.warn('[nonactivating-window] addon unavailable; pages over another app open as panels:', (e as Error).message);
  }
  return addon;
}

const flagged = new WeakSet<object>();

export function ordinaryNonActivatingSupported(): boolean {
  return loadAddon() !== null;
}

/** Flags `win` so it takes key without activating the app. True when it took. */
export function flagNonActivating(win: HandleWindow): boolean {
  const a = loadAddon();
  const handle = win.getNativeWindowHandle?.();
  if (!a || !handle || !a.setNonActivating(handle, true)) return false;
  flagged.add(win);
  return true;
}

export function isFlaggedNonActivating(win: object): boolean {
  return flagged.has(win);
}

/** Orders a flagged window front and makes it key. True when it is key afterwards. */
export function makeKeyWithoutActivating(win: HandleWindow): boolean {
  const handle = win.getNativeWindowHandle?.();
  return handle !== undefined && addon != null && addon.makeKey(handle);
}

/** Makes a flagged window's web content its first responder. */
export function focusContentWithoutActivating(win: HandleWindow): boolean {
  const handle = win.getNativeWindowHandle?.();
  return handle !== undefined && addon != null && addon.focusContent(handle);
}
