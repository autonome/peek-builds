/**
 * Webview Guest → Host Window Registry
 *
 * Maps guest <webview> WebContents IDs to their host BrowserWindow IDs.
 * Populated on `did-attach-webview` (registered alongside the ESC handler in
 * windows.ts) and cleared on guest destroy.
 *
 * Why this exists: when an Electron API gives us a guest WebContents (e.g.
 * `setPermissionRequestHandler`'s `webContents` arg) we need to know which
 * page-host BrowserWindow to surface UI in. `BrowserWindow.fromWebContents`
 * returns null for guest contents; `webContents.hostWebContents` is
 * deprecated; URL-substring matching (the old download-handler approach) is
 * fragile. This registry makes the lookup O(1) and reliable.
 */

import { type WebContents, webContents } from 'electron';
import { getLiveWindow, windowFromWebContents } from './window-registry.js';

const guestToHost = new Map<number, number>();

/**
 * Set of WebContents IDs that have been explicitly marked as page-host content
 * via `markPageHostContent`. This is the opt-in path for future content hosts
 * (e.g. WebContentsView) that are not `<webview>` elements.
 */
const pageHostContentIds = new Set<number>();

/**
 * Register a guest WebContents as belonging to a host BrowserWindow.
 * Idempotent — a second call for the same guestId overwrites.
 *
 * Wires a `destroyed` listener so the entry self-cleans when the guest goes
 * away. Caller should still call `unregisterGuest` if the host window
 * closes before the guest emits destroyed.
 */
export function registerGuest(guest: WebContents, hostWindowId: number): void {
  const guestId = guest.id;
  guestToHost.set(guestId, hostWindowId);
  guest.once('destroyed', () => {
    guestToHost.delete(guestId);
  });
}

/**
 * Look up the host BrowserWindow ID for a given guest WebContents.
 *
 * Tries the registry first. If the lookup misses (e.g. for a top-level
 * BrowserWindow's own WebContents, where there's no guest relationship),
 * falls back to `BrowserWindow.fromWebContents` so the same call works for
 * both top-level and guest contexts.
 *
 * Returns null if no owning window can be found.
 */
export function findHostWindowId(wc: WebContents): number | null {
  const hostId = guestToHost.get(wc.id);
  if (hostId != null) {
    const bw = getLiveWindow(hostId);
    if (bw) return hostId;
    // Stale entry — fall through to live scan
    guestToHost.delete(wc.id);
  }

  // Top-level case: the WebContents IS a BrowserWindow's own contents
  const direct = windowFromWebContents(wc);
  if (direct) return direct.id;

  return null;
}

/**
 * Mark a WebContents as page-host content so that compat hooks gate on it
 * in addition to native `<webview>` guests.
 *
 * Call this during construction of any non-webview content host (e.g. a
 * WebContentsView carrying page content in the future hybrid architecture).
 * Today nothing calls this, so `isPageHostContent` is exactly equivalent to
 * `getType() === 'webview'` and there is NO behavior change.
 *
 * Wires a `destroyed` listener so the entry self-cleans, mirroring the
 * pattern used in `registerGuest`.
 */
export function markPageHostContent(wc: WebContents): void {
  const id = wc.id;
  pageHostContentIds.add(id);
  wc.once('destroyed', () => {
    pageHostContentIds.delete(id);
  });
}

/**
 * Returns true if `wc` is content that the chrome-extension compat hooks
 * should apply to.
 *
 * This is the seam that compat hooks gate on instead of the literal webview
 * type. The future WebContentsView content path opts in via
 * `markPageHostContent`. Today this is exactly equivalent to
 * `getType() === 'webview'` because nothing calls `markPageHostContent` yet,
 * so there is NO behavior change.
 */
export function isPageHostContent(wc: WebContents): boolean {
  return wc.getType() === 'webview' || pageHostContentIds.has(wc.id);
}

/**
 * Manually drop a guest entry. Normally not needed (the `destroyed` listener
 * handles it) but useful when batch-cleaning a closed window.
 */
export function unregisterGuest(guestWebContentsId: number): void {
  guestToHost.delete(guestWebContentsId);
}

/**
 * Return all guest WebContents IDs registered to a given host window.
 * Used by callers that want to clean up per-window state when the window
 * closes (e.g. denying pending permission requests).
 */
export function getGuestsForWindow(hostWindowId: number): number[] {
  const out: number[] = [];
  for (const [guestId, hostId] of guestToHost) {
    if (hostId === hostWindowId) out.push(guestId);
  }
  return out;
}

/**
 * Destroy every registered page-host guest WebContents synchronously.
 *
 * Called from the `before-quit` handler so guests (which may carry an in-flight
 * chrome-extension relay `ipcRenderer.invoke`) are torn down BEFORE Electron
 * closes their host windows during quit. Without this, app-quit closes leftover
 * page-host windows via the native quit path (NOT closeHostWindow), so a guest
 * is derefed inside `-[NSWindow __close]` → EXC_BAD_ACCESS (peek d1cf0b9a). The
 * interactive close path is already covered by `closeHostWindow`; this closes
 * the quit/teardown gap. Best-effort and synchronous — `destroy()` marks each
 * guest destroyed immediately so the subsequent window closes have no live
 * guest to dereference.
 */
export function destroyAllPageHostGuests(): void {
  for (const guestId of [...guestToHost.keys()]) {
    try {
      const wc = webContents.fromId(guestId);
      if (wc && !wc.isDestroyed()) {
        (wc as unknown as { destroy(): void }).destroy();
      }
    } catch { /* best-effort during shutdown */ }
  }
}

/** Test-only: clear all registry state. */
export function _resetForTests(): void {
  guestToHost.clear();
  pageHostContentIds.clear();
}
