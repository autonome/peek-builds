/**
 * Feature Trust — where a feature's privilege level comes from.
 *
 * A manifest is written by the feature's author, so it can never be the
 * source of "this feature is builtin": that comes from the registry entry
 * (`source.type === 'builtin'`, set by syncBuiltinFeatures for the features
 * shipped in the app). A feature with no registry entry is not builtin.
 *
 * Electron-free. feature-startup.ts installs the registry lookup at boot;
 * the tile launcher and manifest cache read through here.
 */

import type { FeatureRegistryEntry } from './feature-registry.js';
import type { TileManifest } from './tile-manifest.js';
import { evaluateFeatureApproval, type ApprovalDecision } from './feature-approval.js';

type EntryLookup = (featureId: string) => FeatureRegistryEntry | undefined;

let lookup: EntryLookup = () => undefined;

/** Install the registry lookup (feature-startup.ts initializeFeatures). */
export function setFeatureEntryLookup(fn: EntryLookup): void {
  lookup = fn;
}

/** True only when the registry holds the feature with source 'builtin'. */
export function isBuiltinFeature(featureId: string): boolean {
  return lookup(featureId)?.source.type === 'builtin';
}

/**
 * Launch-time approval: a registered non-builtin feature must be approved,
 * and a local one must not have expanded its capabilities since approval.
 * A feature with no registry entry is not checked here (it is also not
 * builtin, so it only ever gets non-builtin capabilities).
 */
export function checkLaunchApproval(manifest: TileManifest): ApprovalDecision {
  const entry = lookup(manifest.id);
  if (!entry) return { allow: true };
  return evaluateFeatureApproval(entry, manifest);
}
