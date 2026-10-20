// Central indirection layer for window lookups: callers use this instead of BrowserWindow.fromId /
// getAllWindows directly, so they never have to gate on isDestroyed() themselves.

// A value-side `import { BrowserWindow } from 'electron'` throws under ELECTRON_RUN_AS_NODE=1
// (the unit-test runner's mode), since 'electron' resolves to a path string there, not the module.
// Runtime access goes through getElectron() via createRequire instead.
import type { BrowserWindow as BrowserWindowType, WebContents } from 'electron';
import type { NavHistoryEntry } from './nav-history.js';
import { createRequire } from 'node:module';

const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') {
  if (_electron) return _electron;
  _electron = requireElectron('electron') as typeof import('electron');
  return _electron;
}

// Null under ELECTRON_RUN_AS_NODE=1 — require('electron') returns a path string there, not the
// module, so callers treat a null return as "no live windows exist."
function getBrowserWindowClass(): typeof BrowserWindowType | null {
  const electron = getElectron() as { BrowserWindow?: typeof BrowserWindowType } | string;
  if (typeof electron !== 'object' || electron === null) return null;
  return electron.BrowserWindow ?? null;
}

export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
  // The window's pin scope ('workspace' | 'global'), read off the 'pin'
  // context key — see docs/design/window-rules.md "Persistent windows:
  // workspace-pinned and global HUD". Absent/null for an unpinned window.
  pinScope?: string | null;
}

export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
  // Focus-recency rank (higher = more recently focused), not a window stacking order. See focus-order.ts.
  zOrder: number;
  // Position in the on-screen stack at save time, bottom-to-top (0 = bottommost); restore replays
  // it literally so windows land in the on-screen front-to-back order rather than zOrder's.
  // Indices may have gaps (a skipped overlay/stale tile), and it's absent for pre-field snapshots.
  stackIndex?: number;
  // The virtual desktop the window was last on, an opaque id from the desktop provider. Absent for
  // snapshots written before the field existed and for windows with no known desktop. Restore reads
  // it to hold the window until the user arrives on that desktop (session.ts lazy-restore hold).
  desktop?: string;
  focused: boolean;
  context?: WindowContext;
  // The window's back/forward trail at save time, so a relaunch restores the
  // whole trail rather than just the leaf URL (nav-history.ts owns the shape
  // and the size rule). LOCAL MACHINE STATE: the `session`/`snapshot`
  // `feature_settings` rows this descriptor persists into are not read by
  // sync.ts, and a trail must never leave the device — it describes one
  // machine's browsing and can carry query strings and one-time URLs. Both
  // keys are optional and stay ABSENT rather than null when there is no trail:
  // every descriptor written before they existed lacks them, and such a
  // descriptor must keep restoring at its leaf URL.
  navHistory?: NavHistoryEntry[];
  navHistoryIndex?: number;
}

export function getLiveWindow(id: number): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

export function getAllLiveWindows(): BrowserWindowType[] {
  const BW = getBrowserWindowClass();
  if (!BW) return [];
  return BW.getAllWindows().filter(w => !w.isDestroyed());
}

// TRAP: the declared return type lies at runtime — hybrid content resolves to a BaseWindow
// absent from `getAllWindows()`, so a truthiness check here cannot answer "is this a BrowserWindow".
export function windowFromWebContents(wc: WebContents): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromWebContents(wc);
  return win && !win.isDestroyed() ? win : null;
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of getAllLiveWindows()) {
    win.webContents.send(channel, ...args);
  }
}
