/**
 * Window presenter — canonical user-facing self-description for any window.
 *
 * Consumers (tile:window:list, session.save, undo-close handler, future
 * features) ask for a `WindowPresentation` and never reach into per-type
 * internals — no parsing the page-host's shell URL, no peeking at
 * info.params.currentUrl or .x/.y, no extractRealUrl. That window-type
 * knowledge lives here, in one place.
 *
 * Adding a new window type means extending this module — no edits to
 * any consumer.
 *
 * See peek MCP task `e4ae700e` for design rationale and the catalogue of
 * bugs that motivated this consolidation.
 */

import fs from 'node:fs';
import { getWindowRef } from './window-registry.js';
import type { WindowRef } from './window-registry.js';
import { getWindowInfo } from './main.js';
import { findUrlItem } from './datastore.js';
import { resolveWindowAddress } from './window-address.js';
import { urlToHash, getThumbnailPath } from './thumbnails.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import type { HybridWindowEntry } from './hybrid-page-host-registry.js';

export { resolveWindowAddress };

export interface WindowPresentation {
  id: number;
  /**
   * The user-facing URL. For page-host windows this resolves to the inner
   * navigated URL (info.params.currentUrl, falling back to the bootstrap
   * `url` search param), NOT the `peek://app/page/index.html?…` shell.
   * For all other windows this is webContents.getURL().
   */
  address: string;
  title: string;
  /** Favicon URL stored on the matching items-table row, or empty string. */
  favicon: string;
  /** Thumbnail hash for `peek://thumbnail/<hash>.jpg`, or empty string. */
  thumbnail: string;
  /**
   * For page-hosts, the visible webview rect (canvas bounds from
   * info.params). For other windows, BrowserWindow.getBounds(). Always
   * the rect a consumer would want to display or persist.
   */
  bounds: Electron.Rectangle;
  /** True when the page-host is in MAXIMIZED state. */
  maximized: boolean;
  /** Pre-maximize bounds for unmaximize, or null if not maximized. */
  preMaxBounds: Electron.Rectangle | null;
  visible: boolean;
  focused: boolean;
}

/**
 * Return the canonical presentation for a window, or null if the window
 * doesn't exist or has been destroyed. Handles both Live windows
 * (state read from the BrowserWindow + windowRegistry) and Pending
 * windows (state read from their descriptor + thumbnail cache).
 */
export function getWindowPresentation(windowId: number): WindowPresentation | null {
  // Hybrid page-hosts are BaseWindows, invisible to `getWindowRef`
  // (BrowserWindow.fromId-backed). Check the hybrid registry FIRST so a
  // hybrid id resolves to its content-webContents presentation rather than
  // falling through to a null ref. No-op when the flag is off: the registry
  // is empty, so `getHybridWindow` returns null and we fall through to the
  // canvas/pending path exactly as before.
  const hybrid = getHybridWindow(windowId);
  if (hybrid) return getHybridPresentation(hybrid);

  const ref = getWindowRef(windowId);
  if (!ref) return null;
  if (ref.kind === 'pending') return getPendingPresentation(ref);
  return getLivePresentation(ref);
}

/**
 * Build a presentation for a hybrid page-host window. A hybrid window is a
 * `BaseWindow` hosting a single `WebContentsView`; its user-facing address,
 * title, visibility and focus are read live off that content webContents /
 * host BaseWindow (via the registry entry). Favicon/thumbnail resolution
 * mirrors the Live and Pending paths byte-for-byte so a hybrid window is
 * indistinguishable from a canvas page in the windows feature.
 *
 * Maximize/preMaxBounds are read live off the hybrid registry entry (see
 * hybrid-page-host-registry.ts's setHybridMaximizeState), kept in sync by
 * the page:maximize/page:unmaximize handlers in ipc.ts and by reopen/
 * session-restore seeding a window that was maximized when it was closed
 * or saved. Unlike the old canvas path — where bounds had to be
 * reconstructed from FSM-published webview-rect params because the
 * visible content area was smaller than the outer window — a hybrid
 * window's outer BaseWindow bounds ARE the visible content rect (no
 * surrounding chrome lives in this window), so `bounds` below is always
 * just the live baseWin.getBounds(), maximized or not.
 */
function getHybridPresentation(entry: HybridWindowEntry): WindowPresentation {
  const address = entry.url();
  let bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let visible = true;
  let focused = false;
  try {
    if (!entry.baseWin.isDestroyed()) {
      bounds = entry.baseWin.getBounds();
      visible = entry.baseWin.isVisible();
      focused = entry.baseWin.isFocused();
    }
  } catch {
    // best-effort — a destroyed/odd BaseWindow still presents with defaults
  }

  let favicon = '';
  let thumbnail = '';
  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const item = findUrlItem(address) as { favicon?: string; thumbnail?: string } | null;
      if (item) {
        favicon = item.favicon || '';
        thumbnail = item.thumbnail || '';
      }
    } catch {
      // best-effort — store lookup failures shouldn't break window listings
    }
    if (!favicon) {
      try {
        const host = new URL(address).hostname;
        if (host) favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      } catch {
        // unparseable address — leave favicon empty
      }
    }
  } else if (address.startsWith('peek://')) {
    try {
      const hash = urlToHash(address);
      if (fs.existsSync(getThumbnailPath(hash))) {
        thumbnail = hash;
      }
    } catch {
      // best-effort
    }
  }

  return {
    id: entry.windowId,
    address,
    title: entry.title(),
    favicon,
    thumbnail,
    bounds,
    maximized: entry.maximized,
    preMaxBounds: entry.maximized ? entry.preMaxBounds : null,
    visible,
    focused,
  };
}

function getLivePresentation(ref: WindowRef & { kind: 'live' }): WindowPresentation | null {
  const win = ref.window;
  // ref.id is the canonical (possibly synthetic) id; win.id is Electron's
  // own. windowRegistry is keyed by Electron's id, so use win.id for the
  // info lookup but expose ref.id in the response.
  const info = getWindowInfo(win.id);
  const hostUrl = win.webContents.getURL();

  const address = resolveWindowAddress(hostUrl, info?.params);

  const bounds = win.getBounds();

  // Maximize state was a canvas-page-host concept (page-host FSM tracked
  // MAXIMIZED in info.params). The canvas path is gone, so this is always
  // false/null here. The hybrid path DOES have real maximize tracking now
  // (see getHybridPresentation below) — but hybrid windows are BaseWindows
  // that never reach this function (getWindowPresentation resolves them via
  // the hybrid registry first). A plain BrowserWindow (settings, palette,
  // etc.) has no maximize concept in this app.
  const maximized = false;
  const preMaxBounds: Electron.Rectangle | null = null;

  // Favicon + thumbnail. The presenter is the one place that knows the
  // resolution policy — renderers receive a URL string they can drop into
  // an <img src>, with no fallback chain of their own.
  //
  // Favicon priority: stored item.favicon → Google s2 service.
  // (When peek://favicon/<hash> local-cache lands per task 7927ab71, it
  // becomes a third layer here without touching any consumer.)
  //
  // Thumbnail priority:
  //   http(s): stored item.thumbnail (no third-party screenshot service).
  //   peek://: computed hash, if the captured JPEG exists on disk. The
  //            capture is wired in ipc.ts on did-stop-loading; the file
  //            name is deterministic so we don't need an item record.
  let favicon = '';
  let thumbnail = '';
  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const item = findUrlItem(address) as { favicon?: string; thumbnail?: string } | null;
      if (item) {
        favicon = item.favicon || '';
        thumbnail = item.thumbnail || '';
      }
    } catch {
      // best-effort — store lookup failures shouldn't break window listings
    }
    if (!favicon) {
      try {
        const host = new URL(address).hostname;
        if (host) favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      } catch {
        // unparseable address — leave favicon empty
      }
    }
  } else if (address.startsWith('peek://')) {
    try {
      const hash = urlToHash(address);
      if (fs.existsSync(getThumbnailPath(hash))) {
        thumbnail = hash;
      }
    } catch {
      // best-effort — thumbnail lookup failures shouldn't break listings
    }
  }

  return {
    id: ref.id,
    address,
    title: win.getTitle(),
    favicon,
    thumbnail,
    bounds,
    maximized,
    preMaxBounds,
    visible: win.isVisible(),
    focused: win.isFocused(),
  };
}

/**
 * Build a presentation for a Pending window from its descriptor. The
 * favicon/thumbnail resolution mirrors the Live path so the user-facing
 * result is indistinguishable from a live window — same icons, same
 * cached screenshots. `visible` is true (pending = "ready to show") and
 * `focused` is false (only Live windows can hold OS focus).
 */
function getPendingPresentation(ref: WindowRef & { kind: 'pending' }): WindowPresentation {
  const d = ref.descriptor;
  const address = d.url;
  const maximized = d.params.maximized === true;

  let preMaxBounds: Electron.Rectangle | null = null;
  if (maximized) {
    const ppx = d.params.preMaxX;
    const ppy = d.params.preMaxY;
    const ppw = d.params.preMaxWidth;
    const pph = d.params.preMaxHeight;
    if (typeof ppx === 'number' && typeof ppy === 'number'
      && typeof ppw === 'number' && typeof pph === 'number') {
      preMaxBounds = { x: ppx, y: ppy, width: ppw, height: pph };
    }
  }

  let favicon = '';
  let thumbnail = '';
  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const item = findUrlItem(address) as { favicon?: string; thumbnail?: string } | null;
      if (item) {
        favicon = item.favicon || '';
        thumbnail = item.thumbnail || '';
      }
    } catch {
      // best-effort
    }
    if (!favicon) {
      try {
        const host = new URL(address).hostname;
        if (host) favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      } catch {
        // unparseable address — leave favicon empty
      }
    }
  } else if (address.startsWith('peek://')) {
    try {
      const hash = urlToHash(address);
      if (fs.existsSync(getThumbnailPath(hash))) {
        thumbnail = hash;
      }
    } catch {
      // best-effort
    }
  }

  return {
    id: ref.id,
    address,
    title: d.title,
    favicon,
    thumbnail,
    bounds: d.bounds,
    maximized,
    preMaxBounds,
    visible: true,
    focused: false,
  };
}
