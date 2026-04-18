/**
 * Strict Sync Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:sync:sync-all` IPC handler in `tile-ipc.ts` to
 * decide whether a capability grant may trigger a full sync cycle.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-dialogs-enforcement.ts` so
 * these checks can be unit-tested without pulling in `tile-ipc`'s
 * Electron dependencies.
 *
 * Background: the existing `sync-full` / `sync-push` / `sync-pull` IPC
 * channels are only reachable from the v1 preload (the main desktop
 * `preload.js`), not from the tile preload. The sync feature currently
 * calls `api.sync.syncAll()` — provided for v1 but missing from the
 * tile-preload surface. The strict handler provides the same syncAll
 * entry point gated on a declared `sync` capability. Sync is already
 * tagged as a `BUILTIN_ONLY_CAPABILITIES` member in
 * `tile-manifest.ts`, so `resolveCapabilities` will deny it for
 * external tiles automatically.
 */

import type { CapabilityGrant } from './tile-manifest.js';

export type SyncCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate whether a grant may invoke the sync handler.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `sync` capability must be present.
 *
 * The `sync` capability is a plain boolean (see `TileCapabilities.sync`)
 * — there are no sub-actions or allowlists to inspect. The manifest
 * resolution pass at `resolveCapabilities` already enforces
 * "builtin-only" for this capability, so this check only needs to
 * verify the grant was actually awarded.
 */
export function checkSyncAllowed(
  grant: CapabilityGrant | null,
): SyncCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass the sync gate.
  if (grant.trustedBuiltin) return { ok: true };

  if (!grant.capabilities.sync) {
    return { ok: false, error: 'sync capability not granted' };
  }

  return { ok: true };
}
