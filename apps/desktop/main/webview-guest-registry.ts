/**
 * Webview Guest → Host Window Registry
 *
 * Maps guest <webview> WebContents IDs to the WM `WindowId` of their host
 * window. Populated on `did-attach-webview` (registered alongside the ESC
 * handler in windows.ts) and on hybrid page-host construction (ipc.ts), and
 * cleared on guest destroy.
 *
 * Why this exists: when an Electron API gives us a guest WebContents (e.g.
 * `setPermissionRequestHandler`'s `webContents` arg) we need to know which
 * page-host window to surface UI in. `BrowserWindow.fromWebContents`
 * returns null for guest contents; `webContents.hostWebContents` is
 * deprecated; URL-substring matching (the old download-handler approach) is
 * fragile. This registry makes the lookup O(1) and reliable.
 *
 * Id spaces: keys are webContents ids (Electron's), values are WM
 * `WindowId`s (window-manager.md §4.6 dim 11) — the map never carries raw
 * Electron *window* ids, so its two numeric spaces can't be confused.
 */

import * as ccdiagFs from 'node:fs';
import type { WebContents } from 'electron';
import { windowFromWebContents } from './window-registry.js';

// TEMPORARY closeContent reachability trace — REVERT after the sitting.
function ccdiag(line: string): void {
  try {
    ccdiagFs.appendFileSync('/tmp/peek-closecontent-diag.log', `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}
import type { WindowId } from './window-state.js';
import { getNativeWindowFor, getWindowIdFor, dispatchWindowEvent } from './window-state-singleton.js';

const guestToHost = new Map<number, WindowId>();

/**
 * Set of WebContents IDs that have been explicitly marked as page-host content
 * via `markPageHostContent`. This is the opt-in path for future content hosts
 * (e.g. WebContentsView) that are not `<webview>` elements.
 */
const pageHostContentIds = new Set<number>();

/**
 * Register a guest WebContents as belonging to a host window (by WM
 * `WindowId`). Idempotent — a second call for the same guestId overwrites.
 *
 * Wires a `destroyed` listener so the entry self-cleans when the guest goes
 * away. Caller should still call `unregisterGuest` if the host window
 * closes before the guest emits destroyed.
 */
export function registerGuest(guest: WebContents, hostWindowId: WindowId): void {
  const guestId = guest.id;
  guestToHost.set(guestId, hostWindowId);
  guest.once('destroyed', () => {
    guestToHost.delete(guestId);
  });
}

/**
 * Look up the host window's WM `WindowId` for a given guest WebContents.
 *
 * Tries the registry first. If the lookup misses (e.g. for a top-level
 * BrowserWindow's own WebContents, where there's no guest relationship),
 * falls back to `BrowserWindow.fromWebContents` so the same call works for
 * both top-level and guest contexts.
 *
 * Returns null if no owning window can be found.
 */
export function findHostWindowId(wc: WebContents): WindowId | null {
  const hostId = guestToHost.get(wc.id);
  if (hostId != null) {
    // Liveness check: the machine's mapping covers BOTH BrowserWindow hosts
    // and hybrid BaseWindow hosts (both register with the machine), so the
    // old two-branch getLiveWindow / hybrid-registry probe collapses into
    // one lookup.
    if (getNativeWindowFor(hostId) != null) return hostId;
    // Stale entry — fall through to live scan
    guestToHost.delete(wc.id);
  }

  // Top-level case: the WebContents IS a BrowserWindow's own contents.
  // (For hybrid content, fromWebContents resolves to the owning BaseWindow —
  // see the windowFromWebContents TRAP note — which getWindowIdFor also maps.)
  const direct = windowFromWebContents(wc);
  if (direct) return getWindowIdFor(direct);

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
 * Return all guest WebContents IDs registered to a given host window (by WM
 * `WindowId`). Used by callers that want to clean up per-window state when
 * the window closes (e.g. denying pending permission requests).
 */
export function getGuestsForWindow(hostWindowId: WindowId): number[] {
  const out: number[] = [];
  for (const [guestId, hostId] of guestToHost) {
    if (hostId === hostWindowId) out.push(guestId);
  }
  return out;
}

/**
 * All registered guest WebContents ids. Read by the Electron window backend's
 * `destroyAllContentGuests` command — the executor-side owner of the actual
 * `destroy()` calls (rule R2; this module holds the mapping, not the ops).
 */
export function getAllGuestWebContentsIds(): number[] {
  return [...guestToHost.keys()];
}

/**
 * Destroy every registered page-host guest WebContents synchronously —
 * through the window-state machine (GUEST_TEARDOWN_REQUESTED →
 * DESTROY_ALL_GUESTS → backend.destroyAllContentGuests; the dispatch pump and
 * the backend command are synchronous, which the before-quit caller depends
 * on).
 *
 * Called from the `before-quit` handler so guests (which may carry an in-flight
 * chrome-extension relay `ipcRenderer.invoke`) are torn down BEFORE Electron
 * closes their host windows during quit. Without this, app-quit closes leftover
 * page-host windows via the native quit path (NOT the machine's guest-safe
 * close), so a guest is derefed inside `-[NSWindow __close]` → EXC_BAD_ACCESS
 * (peek d1cf0b9a). The interactive close path is already covered by the
 * backend's guest-safe `closeWindow`; this closes the quit/teardown gap.
 */
export function destroyAllPageHostGuests(): void {
  // TEMPORARY closeContent reachability trace — REVERT after the sitting.
  ccdiag(
    `destroyAllPageHostGuests ENTER guestToHost.size=${guestToHost.size} ` +
      `entries=[${[...guestToHost.entries()].map(([g, h]) => `${g}->${h}`).join(' ')}] ` +
      `pageHostContentIds=[${[...pageHostContentIds].join(',')}]`,
  );
  try {
    dispatchWindowEvent({ type: 'GUEST_TEARDOWN_REQUESTED' });
  } catch (e) {
    ccdiag(`destroyAllPageHostGuests dispatch THREW: ${String(e)}`);
  }
  ccdiag(`destroyAllPageHostGuests EXIT guestToHost.size=${guestToHost.size}`);
}

/** Test-only: clear all registry state. */
export function _resetForTests(): void {
  guestToHost.clear();
  pageHostContentIds.clear();
}
