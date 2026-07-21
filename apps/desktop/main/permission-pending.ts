/**
 * Pure bookkeeping for deferred (pending) web-permission requests.
 *
 * permission-handler.ts owns the module-scoped `pendingRequests` map (one entry
 * per deferred Chromium permission callback) and drives it EXCLUSIVELY through
 * these helpers so that every path that resolves a pending request — user
 * response, host-window close, hybrid-window teardown — shares ONE removal
 * chokepoint that also emits the `page:permission-resolved {requestId}` signal
 * the overlay prompt UI prunes its queue on.
 *
 * Like permission-policy.ts, this module has NO electron imports so unit tests
 * can exercise it under plain node (see tests/unit/permission-handler.test.js).
 * The pubsub publish is injected (`publishResolved`) for the same reason.
 */

import type { PermissionName } from './permission-policy.js';
// Type-only import from the pure reducer module — erased at runtime, so this
// module still loads under plain node with no electron.
import type { WindowId } from './window-state.js';

/** One deferred permission request awaiting a user (or teardown) decision. */
export interface PendingPermissionRequest {
  /** The deferred Chromium callback: call with true (grant) or false (deny). */
  callback: (granted: boolean) => void;
  /** The host page-host window (WM WindowId) the prompt UI surfaces in. */
  windowId: WindowId | null;
  permission: PermissionName;
  origin: string;
}

/**
 * Remove and return the pending request for `requestId`, publishing
 * `page:permission-resolved` via the injected `publishResolved`. Returns null
 * (and publishes nothing) if the id has no pending entry — late/duplicate
 * responses are a no-op.
 *
 * The CALLER invokes the returned request's callback (allow/deny) — this
 * helper only owns removal + the resolved signal, so the caller can persist a
 * remembered decision between removal and callback.
 */
export function takePendingRequest(
  pending: Map<string, PendingPermissionRequest>,
  requestId: string,
  publishResolved: (requestId: string) => void,
): PendingPermissionRequest | null {
  const req = pending.get(requestId);
  if (!req) return null;
  pending.delete(requestId);
  publishResolved(requestId);
  return req;
}

/**
 * Deny every pending request attributed to `windowId`: invoke each deferred
 * callback with false, remove it, and publish `page:permission-resolved` for
 * it. Returns the resolved requestIds (empty when none matched — the function
 * is idempotent, so double-firing teardown hooks is harmless).
 *
 * This is the window-close cleanup: without it, a page-host closing with a
 * prompt open leaks the deferred Chromium callback forever (and strands the
 * overlay's queued prompt).
 */
export function denyPendingForWindow(
  pending: Map<string, PendingPermissionRequest>,
  windowId: WindowId,
  publishResolved: (requestId: string) => void,
): string[] {
  const denied: string[] = [];
  for (const [requestId, req] of [...pending]) {
    if (req.windowId !== windowId) continue;
    pending.delete(requestId);
    try {
      req.callback(false);
    } catch {
      /* Chromium callback must never break teardown */
    }
    publishResolved(requestId);
    denied.push(requestId);
  }
  return denied;
}
