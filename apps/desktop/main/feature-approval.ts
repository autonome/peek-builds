/**
 * Feature Approval — decides whether a registry entry may load.
 *
 * Pure (no Electron dependency) so it can be unit-tested; tile-loader.ts
 * calls it before launching a tile.
 *
 * - builtin entries always load.
 * - other entries need `userApproved`.
 * - 'local' entries are registered in place, so their manifest can change
 *   after approval. If the manifest on disk now resolves to capabilities that
 *   expand on the grant stored at approval, the entry is skipped until it is
 *   approved again. Edits that do not expand capabilities load as normal.
 */

import type { FeatureRegistryEntry } from './feature-registry.js';
import { resolveCapabilities, type TileManifest } from './tile-manifest.js';
import { compareCapabilities } from './capability-compare.js';

export type ApprovalDecision =
  | { allow: true }
  | { allow: false; error: string };

export function evaluateFeatureApproval(
  entry: FeatureRegistryEntry,
  manifest: TileManifest,
): ApprovalDecision {
  if (entry.source.type === 'builtin') return { allow: true };

  if (!entry.userApproved) {
    return { allow: false, error: 'Feature not yet approved by user' };
  }

  if (entry.source.type === 'local') {
    const current = resolveCapabilities(entry.id, manifest.capabilities, false).capabilities;
    const comparison = compareCapabilities(entry.grantedCapabilities, current);
    if (comparison.expanded) {
      return {
        allow: false,
        error: `Feature ${entry.id} needs re-approval: capabilities changed (${comparison.added.join(', ')})`,
      };
    }
  }

  return { allow: true };
}
