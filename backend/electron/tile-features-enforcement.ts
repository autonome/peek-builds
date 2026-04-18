/**
 * Strict Features Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:features:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may perform a feature-registry operation
 * (list/get/history/install/enable/disable/remove).
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-context-enforcement.ts` /
 * `tile-dialogs-enforcement.ts` so these checks can be unit-tested
 * without pulling in `tile-ipc`'s Electron dependencies.
 *
 * Background: the existing `feature-registry:*` / `feature-install:*` /
 * `feature-browse:*` IPC channels only check that the caller has a
 * valid token — they do NOT gate on a declared capability. The strict
 * handlers add a `features` capability requirement + per-action gates
 * + optional source-type allowlist, so a tile manifest can carve out
 * the narrow slice of feature-manager functionality it actually needs
 * (e.g. an atproto browser tile: `features: { install: true,
 * sources: ['atproto'] }`).
 */

import type { CapabilityGrant, FeaturesCapability, FeatureSourceType } from './tile-manifest.js';

/**
 * Which features operation is being checked. Groups map onto the
 * existing `feature-registry:*` / `feature-install:*` / `feature-browse:*`
 * / `feature-update:*` / `feature-dev:*` / `feature-publish:*` /
 * `feature-devtools:*` IPC channels and the action dimensions on
 * `FeaturesCapability`.
 *
 * - `read` — `list`, `get`, `history`. Gated by `read`.
 * - `install` — `resolve`, `preview`, `install`. Gated by `install`.
 * - `manage` — `enable`, `disable`, `remove`. Gated by `manage`.
 * - `update` — `check-all`, `apply`, `set-policy`. Gated by `update`.
 * - `dev` — `reload`, `validate`, `pick-directory`, `create`. Gated by `dev`.
 * - `publish` — `list-local`, `read-feature-files`. Gated by `publish`.
 * - `devtools` — `open`. Gated by `devtools`.
 * - `browse` — `list-by-publisher`. Gated by `browse`, defaulting to
 *   the `read` action when `browse` is not explicitly set.
 */
export type FeaturesAction =
  | 'read'
  | 'install'
  | 'manage'
  | 'update'
  | 'dev'
  | 'publish'
  | 'devtools'
  | 'browse';

export type FeaturesCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Normalise a features-capability grant into a `FeaturesCapability`
 * object shape. `features: true` becomes `{ read: true }` — granting
 * read-only access by default when the manifest author picked the
 * shorthand. Any falsy/invalid value returns `null` so the caller can
 * short-circuit with "capability not granted".
 */
function normaliseGrant(grant: CapabilityGrant | null): FeaturesCapability | null {
  if (!grant) return null;
  const fc = grant.capabilities.features;
  if (!fc) return null;
  if (fc === true) return { read: true };
  if (typeof fc === 'object') return fc;
  return null;
}

/**
 * Whether a given action is permitted by the capability object.
 *
 * The `read` action defaults to `true` when the capability is declared
 * and `read` is omitted — this matches the principle-of-least-surprise
 * for manifests that only say `features: { install: true }` (they
 * presumably also want to list what they installed). `install` and
 * `manage` have no default — they must be explicitly granted.
 */
function actionAllowed(cap: FeaturesCapability, action: FeaturesAction): boolean {
  switch (action) {
    case 'read':
      return cap.read !== false;
    case 'install':
      return cap.install === true;
    case 'manage':
      return cap.manage === true;
    case 'update':
      return cap.update === true;
    case 'dev':
      return cap.dev === true;
    case 'publish':
      return cap.publish === true;
    case 'devtools':
      return cap.devtools === true;
    case 'browse':
      // `browse` falls back to `read` when not explicitly set — listing
      // records is a read-shaped op. When the manifest author declared
      // `browse: false` explicitly, block it even if read is allowed.
      if (cap.browse === true) return true;
      if (cap.browse === false) return false;
      return cap.read !== false;
  }
}

/**
 * Validate whether a grant may perform a features operation on a
 * feature with the given source type (if known).
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `features` capability must be present.
 *   3. Per-action gate (`read` / `install` / `manage`).
 *   4. If `sources` allowlist is set and `sourceType` is supplied,
 *      reject when the type is not in the list.
 *
 * The `sourceType` argument is optional — list-style queries (read a
 * collection) have no single source type. For those, callers typically
 * pass no sourceType here, then filter the results themselves against
 * the allowlist via {@link sourceTypeAllowed}.
 */
export function checkFeaturesAllowed(
  grant: CapabilityGrant | null,
  action: FeaturesAction,
  sourceType?: FeatureSourceType,
): FeaturesCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass every features gate.
  if (grant.trustedBuiltin) return { ok: true };

  const cap = normaliseGrant(grant);
  if (!cap) return { ok: false, error: 'features capability not granted' };

  if (!actionAllowed(cap, action)) {
    return { ok: false, error: `features.${action} capability not granted` };
  }

  if (sourceType !== undefined && cap.sources && !cap.sources.includes(sourceType)) {
    return {
      ok: false,
      error: `features source "${sourceType}" not in capability sources allowlist`,
    };
  }

  return { ok: true };
}

/**
 * True when the capability-grant's `sources` allowlist (if any) permits
 * the given source type. Convenience for list-style handlers that need
 * to filter results — call `checkFeaturesAllowed(grant, 'read')` first,
 * then filter each returned entry with this helper.
 */
export function sourceTypeAllowed(
  grant: CapabilityGrant | null,
  sourceType: FeatureSourceType,
): boolean {
  // Trusted-builtin core renderers bypass the source-type filter.
  if (grant?.trustedBuiltin) return true;
  const cap = normaliseGrant(grant);
  if (!cap) return false;
  if (!cap.sources) return true;
  return cap.sources.includes(sourceType);
}
