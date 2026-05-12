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

import { BrowserWindow } from 'electron';
import type { Session } from 'electron';

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

interface PendingRequest {
  callback: (granted: boolean) => void;
  windowId: number | null;
  permission: PermissionName;
  origin: string;
}

const pendingRequests = new Map<string, PendingRequest>();

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

    // 'prompt' — defer the callback and surface the UI.
    const windowId = webContents ? findHostWindowId(webContents) : null;
    if (windowId == null) {
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

    // Clean up if the host window closes before the user responds.
    const bw = BrowserWindow.fromId(windowId);
    if (bw) {
      const onClosed = () => {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          DEBUG && console.log(`[permission] window ${windowId} closed, denying ${requestId}`);
          pending.callback(false);
          pendingRequests.delete(requestId);
        }
      };
      bw.once('closed', onClosed);
    }

    publish('permission-handler', 'page:permission-request', {
      requestId,
      windowId,
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
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      // Late response after window close cleanup, or duplicate — safe to ignore.
      console.log(`[permission] no pending request for ${requestId} (already resolved?)`);
      return;
    }
    pendingRequests.delete(requestId);
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
