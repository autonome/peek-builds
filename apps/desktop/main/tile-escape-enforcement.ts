/**
 * Strict Escape Forwarding — Pure module (no Electron deps)
 *
 * Escape is a UX primitive: every window gets it, regardless of declared
 * capabilities. tile-preload exposes `api.escape.onEscape(handler)` which
 * registers via `tile:escape:on-escape` and receives `tile:escape:pressed`
 * dispatches from the main-process window escape handler (see
 * `windows.ts::askRendererToHandleEscape`).
 *
 * No capability check: a tile that declares nothing still needs ESC to
 * close dialogs or navigate back.
 *
 * This module is intentionally tiny — the check always returns `ok`.
 * It exists to mirror the pure-module pattern used by the other
 * strict enforcement modules, so the unit tests import from one place
 * and new callers in tile-ipc.ts have a consistent shape.
 */

import type { CapabilityGrant } from './tile-manifest.js';

export type EscapeCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate whether a grant may subscribe to ESC notifications.
 *
 * Escape is not capability-gated — any tile with a valid token may opt
 * in. The only failure is a missing/invalid token (grant === null),
 * which short-circuits before any registration work happens.
 */
export function checkEscapeAllowed(
  grant: CapabilityGrant | null,
): EscapeCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers — same result, but explicit for the
  // audit pattern shared across enforcement helpers.
  if (grant.trustedBuiltin) return { ok: true };
  return { ok: true };
}
