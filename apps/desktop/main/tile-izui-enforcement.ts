/**
 * Strict IZUI Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:izui:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may read the IZUI coordinator state or
 * ask its own window to close via the coordinator.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-dialogs-enforcement.ts` so
 * these checks can be unit-tested without pulling in `tile-ipc`'s
 * Electron dependencies.
 *
 * Background: the legacy `izui-*` IPC channels (registered in
 * `ipc.ts`) only check that the renderer can reach ipcMain — they do
 * NOT require any declared capability. The strict handlers layered on
 * top add a `izui` capability gate so that only tiles which declared
 * participation in the overlay system can drive it.
 */

import type { CapabilityGrant } from './tile-manifest.js';

export type IzuiCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate whether a grant may perform an IZUI operation.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `izui` capability must be declared (truthy).
 *
 * IZUI operations are uniform in privilege — all of them are tightly
 * scoped, mostly read-only coordinator queries, and `closeSelf` only
 * affects the caller's own window. So a single boolean gate is
 * sufficient and avoids the sub-capability explosion seen elsewhere.
 */
export function checkIzuiAllowed(grant: CapabilityGrant | null): IzuiCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass the izui gate.
  if (grant.trustedBuiltin) return { ok: true };
  const ic = grant.capabilities.izui;
  if (!ic) return { ok: false, error: 'izui capability not granted' };
  return { ok: true };
}
