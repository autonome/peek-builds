/**
 * Web Permission Request Handler
 *
 * Centralizes Chromium permission request handling for the profile session.
 * Replaces the previous blanket-allow installed by chrome-extensions.ts.
 *
 * Policy by origin class is defined in `permission-policy.ts` (no Electron
 * imports — pure module, unit-testable under plain node):
 *   chrome-extension://  → allow (extensions declare permissions in
 *                          manifest.json; Electron honors them)
 *   peek://              → allow (we control these pages)
 *   everything else      → consult DEFAULT_POLICY map per permission name.
 *
 * Risky permissions (geolocation, media/camera/mic, midi, display-capture)
 * resolve to `'prompt'` — the handler stores the callback in
 * `pendingRequests`, finds the host page-host BrowserWindow via the
 * webview-guest-registry, publishes `page:permission-request` to that
 * window's renderer, and resolves the callback when the user responds via
 * `page:permission-response`.
 *
 * Phase 3 will persist per-origin decisions in `feature_settings` so the
 * user isn't re-prompted on every page load. Today every prompt fires
 * fresh — the requestId tracks the in-flight grant only.
 *
 * See docs/tasks.md "Web permission requests" for the full plan.
 */

import type { Session } from 'electron';
import { getNativeWindowFor, getWindowIdFor } from './window-state-singleton.js';

import { publish, subscribe } from './pubsub.js';
import { findHostWindowId } from './webview-guest-registry.js';
import {
  resolveDecision,
  resolveWithStored,
  originFromUrl,
  labelFor,
  type PermissionName,
} from './permission-policy.js';
import { getDb } from './datastore.js';
import { getDecision, setDecision } from './permission-store.js';
import { DEBUG } from './config.js';
import {
  takePendingRequest,
  denyPendingForWindow,
  type PendingPermissionRequest,
} from './permission-pending.js';

const pendingRequests = new Map<string, PendingPermissionRequest>();

/**
 * Every path that resolves a pending request announces it here so the
 * singleton overlay prompt UI (renderer/page/overlay.js) can prune the
 * request from its queue — the overlay serves N windows from one queue, so
 * a request resolved by ANY path (user response, window close, hybrid
 * teardown) must not linger as a stale prompt. Publishing rides the same
 * topic-only broadcast as `page:permission-request`.
 */
function publishResolved(requestId: string): void {
  publish('permission-handler', 'page:permission-resolved', { requestId });
}

let permissionHandlerInstalled = false;
let nextRequestSeq = 0;

function makeRequestId(): string {
  // Time + counter avoids collision without crypto overhead. Resets if the
  // process restarts (pendingRequests is cleared anyway).
  nextRequestSeq++;
  return `pr-${Date.now().toString(36)}-${nextRequestSeq.toString(36)}`;
}

export function installPermissionHandler(ses: Session): void {
  if (permissionHandlerInstalled) {
    DEBUG && console.log('[permission] Handler already installed, skipping');
    return;
  }
  permissionHandlerInstalled = true;

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    // Synchronous check: invoked when a page calls e.g. navigator.permissions.query().
    // Mirror the request handler's policy so the answer is consistent. For
    // 'prompt' decisions, return false here — `permissions.query()` will
    // report 'denied' (Chromium has no concept of "ask later" from this API).
    // The actual prompt fires when the page calls the API itself
    // (e.g. navigator.geolocation.getCurrentPosition()).
    const url = webContents?.getURL?.() ?? requestingOrigin ?? '';
    const decision = resolveDecision(url, permission as PermissionName);
    return decision === 'allow';
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl =
      (details && (details as { requestingUrl?: string }).requestingUrl) ||
      webContents?.getURL?.() ||
      '';
    // Combined policy + stored-decision resolution. See
    // permission-policy.ts:resolveWithStored for the invariant — stored
    // decisions only override 'prompt'.
    const decision = resolveWithStored(
      requestingUrl,
      permission as PermissionName,
      lookupStoredDecision,
    );

    console.log(
      `[permission] ${permission} requested by ${requestingUrl || '(unknown)'} → ${decision}`,
    );

    if (decision === 'allow') {
      callback(true);
      return;
    }
    if (decision === 'deny') {
      callback(false);
      return;
    }

    // 'prompt' — defer the callback and surface the UI. `windowId` is the
    // host's WM WindowId (the guest registry no longer carries raw Electron
    // window ids).
    const windowId = webContents ? findHostWindowId(webContents) : null;
    const native = windowId != null ? getNativeWindowFor(windowId) : null;
    if (windowId == null || native == null) {
      console.warn(
        `[permission] ${permission} from ${requestingUrl}: no host window found, denying`,
      );
      callback(false);
      return;
    }

    const requestId = makeRequestId();
    const origin = originFromUrl(requestingUrl);
    pendingRequests.set(requestId, {
      callback,
      windowId,
      permission: permission as PermissionName,
      origin,
    });

    // Clean up if the host window closes before the user responds. `native`
    // is the live handle for either host kind, but a hybrid BaseWindow may
    // never emit 'closed' (Electron 40 tears it down without the event — see
    // the finalize-tail note in ipc.ts), so hybrid teardown ALSO calls
    // `denyPendingRequestsForWindow` (wired via the hybrid registry's
    // closed-listener seam in hybrid-overlay.ts). Both paths are idempotent.
    const onClosed = () => {
      const pending = takePendingRequest(pendingRequests, requestId, publishResolved);
      if (pending) {
        DEBUG && console.log(`[permission] window ${windowId} closed, denying ${requestId}`);
        pending.callback(false);
      }
    };
    native.once('closed', onClosed);

    publish('permission-handler', 'page:permission-request', {
      requestId,
      // Renderer-facing payloads still speak Electron window ids (the overlay
      // matches this against its active-window id) — deliberate boundary
      // until the renderer id-space migrates (window-manager.md §5).
      windowId: native.id,
      permission,
      origin,
      label: labelFor(permission as PermissionName),
    });
  });

  // Subscribe to renderer responses. The page-host renderer publishes this
  // topic when the user clicks Allow / Deny in the prompt overlay.
  subscribe('permission-handler', 'page:permission-response', (msg) => {
    console.log('[permission] received page:permission-response msg=' + JSON.stringify(msg));
    const m = msg as { requestId?: unknown; allowed?: unknown; remember?: unknown };
    const requestId = typeof m?.requestId === 'string' ? m.requestId : null;
    const allowed = m?.allowed === true;
    const remember = m?.remember === true;
    if (!requestId) {
      console.warn('[permission] page:permission-response missing requestId:', msg);
      return;
    }
    const pending = takePendingRequest(pendingRequests, requestId, publishResolved);
    if (!pending) {
      // Late response after window close cleanup, or duplicate — safe to ignore.
      console.log(`[permission] no pending request for ${requestId} (already resolved?)`);
      return;
    }
    console.log(
      `[permission] ${pending.permission} for ${pending.origin} → ${allowed ? 'allowed' : 'denied'} by user${remember ? ' (remembered)' : ''}`,
    );
    if (remember && pending.origin && pending.origin !== '(unknown)') {
      // Don't persist decisions for synthetic origins — there's no useful
      // identity to key off, and a stored entry would never match a real
      // future request anyway.
      persistStoredDecision(pending.origin, pending.permission, allowed);
    }
    pending.callback(allowed);
  });

  DEBUG && console.log('[permission] Handler installed on profile session');
}

/**
 * Look up a previously-remembered decision for `(origin, permission)`.
 * Returns boolean (allowed) or null if no decision is stored.
 *
 * Wrapped in a try/catch because permission requests can fire before the
 * datastore is fully initialized (e.g. an extension's background page
 * requesting geolocation during early app boot). A datastore miss falls
 * through to the prompt UI rather than crashing the request handler.
 */
function lookupStoredDecision(origin: string, permission: PermissionName): boolean | null {
  if (!origin || origin === '(unknown)') return null;
  try {
    const db = getDb();
    if (!db) return null;
    const decision = getDecision(db as unknown as Parameters<typeof getDecision>[0], origin, permission);
    return decision ? decision.allowed : null;
  } catch (err) {
    DEBUG && console.log('[permission] stored-decision lookup failed:', err);
    return null;
  }
}

/**
 * Persist a per-origin permission decision. Called when the user clicks
 * Allow/Deny with the "Remember this decision" checkbox set.
 */
function persistStoredDecision(origin: string, permission: PermissionName, allowed: boolean): void {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[permission] cannot persist decision — datastore not ready');
      return;
    }
    setDecision(db as unknown as Parameters<typeof setDecision>[0], origin, permission, allowed);
  } catch (err) {
    console.error('[permission] persist failed:', err);
  }
}

/**
 * Deny (and resolve) every pending permission request attributed to
 * `windowId`. Called from the hybrid page-host teardown path: hybrid hosts
 * are BaseWindows, so the BrowserWindow-based close-cleanup above never fires
 * for them and their deferred Chromium callbacks would leak on window close.
 * The hybrid registry exposes a closed-listener seam and hybrid-overlay.ts
 * registers this function into it — permission-handler stays decoupled from
 * the hybrid registry. Idempotent; each denied request also publishes
 * `page:permission-resolved` so the overlay prunes its queued prompt.
 */
export function denyPendingRequestsForWindow(windowId: number): void {
  // The hybrid registry's closed-listener seam still speaks Electron window
  // ids — a deliberate boundary until that registry re-keys onto WM ids in a
  // later migration step (window-manager.md §4.6). Convert here; the
  // machine's mapping for a hybrid host survives its teardown (BaseWindows
  // never emit the 'closed' the adapter cleans up on), so this resolves.
  const wmId = getWindowIdFor(windowId);
  if (wmId == null) return;
  const denied = denyPendingForWindow(pendingRequests, wmId, publishResolved);
  if (denied.length > 0) {
    console.log(
      `[permission] window ${windowId} closed, denied ${denied.length} pending request(s)`,
    );
  }
}

/**
 * Test-only: reset module state so tests can re-install with a fresh session.
 */
export function _resetForTests(): void {
  permissionHandlerInstalled = false;
  pendingRequests.clear();
  nextRequestSeq = 0;
}

/**
 * Test-only: expose the pending-request map size for assertions.
 */
export function _pendingRequestCountForTests(): number {
  return pendingRequests.size;
}
