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

import { BrowserWindow } from 'electron';
import { getWindowInfo } from './main.js';
import { findUrlItem } from './datastore.js';
import { resolveWindowAddress } from './window-address.js';

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
  /** True when the page-host is in MAXIMIZED state (canvas-internal). */
  maximized: boolean;
  /** Pre-maximize bounds for unmaximize, or null if not maximized. */
  preMaxBounds: Electron.Rectangle | null;
  visible: boolean;
  focused: boolean;
}

/**
 * Return the canonical presentation for a window, or null if the window
 * doesn't exist or has been destroyed.
 */
export function getWindowPresentation(windowId: number): WindowPresentation | null {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return null;

  const info = getWindowInfo(windowId);
  const hostUrl = win.webContents.getURL();
  const isCanvasPage = hostUrl.startsWith('peek://app/page');

  const address = resolveWindowAddress(hostUrl, info?.params);

  // Bounds: canvas pages publish their visible-webview rect into
  // info.params via tile:window:update-canvas-state; everyone else uses
  // the BrowserWindow rect.
  let bounds = win.getBounds();
  if (isCanvasPage && info) {
    const px = info.params.x;
    const py = info.params.y;
    const pw = info.params.width;
    const ph = info.params.height;
    if (typeof px === 'number' && typeof py === 'number'
      && typeof pw === 'number' && typeof ph === 'number') {
      bounds = { x: px, y: py, width: pw, height: ph };
    }
  }

  // Maximize state — only meaningful for canvas pages.
  const maximized = isCanvasPage && info?.params?.maximized === true;
  let preMaxBounds: Electron.Rectangle | null = null;
  if (maximized && info) {
    const ppx = info.params.preMaxX;
    const ppy = info.params.preMaxY;
    const ppw = info.params.preMaxWidth;
    const pph = info.params.preMaxHeight;
    if (typeof ppx === 'number' && typeof ppy === 'number'
      && typeof ppw === 'number' && typeof pph === 'number') {
      preMaxBounds = { x: ppx, y: ppy, width: ppw, height: pph };
    }
  }

  // Favicon + thumbnail. The presenter is the one place that knows the
  // resolution policy — renderers receive a URL string they can drop into
  // an <img src>, with no fallback chain of their own.
  //
  // Favicon priority: stored item.favicon → Google s2 service.
  // (When peek://favicon/<hash> local-cache lands per task 7927ab71, it
  // becomes a third layer here without touching any consumer.)
  //
  // Thumbnail: stored hash only — no third-party screenshot service.
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
  }

  return {
    id: windowId,
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
