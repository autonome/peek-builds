/**
 * Features Manager — Update checker module (renderer-side)
 *
 * Provides:
 * - compareSemver()    — semver string comparison (used by browse.js)
 * - checkForUpdates()  — check installed atproto features for newer versions
 *
 * NOTE: capability-expansion comparison and the auto-update decision used
 * to live here too (`compareCapabilities` / `shouldAutoUpdate`), but they
 * were DEAD renderer code — the live security gate is in the main process
 * (`apps/desktop/main/capability-compare.ts`, consumed by the
 * `tile:features:update-apply` handler). Keeping a second copy here meant a
 * divergent, separately-tested impl that the gate never called. They were
 * removed so there is ONE tested capability-comparison implementation. The
 * renderer cannot import the main-process module across the peek:// ↔
 * dist/main boundary, so `compareSemver` (a trivial pure helper still needed
 * by browse.js at renderer runtime) stays here.
 */

// ─── Semver Comparison ──────────────────────────────────────────────

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 */
export function compareSemver(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Capability-expansion comparison + the auto-update decision moved to the
// main process (apps/desktop/main/capability-compare.ts) — see header note.

// ─── Update Checking ────────────────────────────────────────────────

/**
 * Check installed atproto-sourced features for available updates.
 *
 * For each feature with source.type='atproto':
 * - Parse the source URI to get the DID
 * - Query the publisher's PDS for space.peek.feature.release records
 * - Find the latest version by semver
 * - Compare against installed version
 * - If newer, set availableVersion in the result
 *
 * @param {object[]} features - Array of FeatureRegistryEntry objects
 * @param {object} featuresApi - strict api.features surface (with
 *   resolvePublisher + browseListByPublisher). Passing the whole `api`
 *   object also works — this helper only reads `resolvePublisher` and
 *   `browseListByPublisher`.
 * @returns {Promise<object[]>} - Features with available updates, each with
 *   { id, name, currentVersion, availableVersion, atUri, capabilityComparison }
 */
export async function checkForUpdates(features, featuresApi) {
  const updates = [];

  // Filter to atproto-sourced features only
  const atprotoFeatures = features.filter(f =>
    f.source?.type === 'atproto' && f.source?.publisher
  );

  // Group features by publisher DID to minimize PDS queries
  const byPublisher = new Map();
  for (const feature of atprotoFeatures) {
    const did = feature.source.publisher;
    if (!byPublisher.has(did)) {
      byPublisher.set(did, []);
    }
    byPublisher.get(did).push(feature);
  }

  // For each publisher, query their PDS for release records
  for (const [did, pubFeatures] of byPublisher) {
    try {
      // Resolve publisher to get PDS URL (strict — `features.install` gate)
      const publisherResult = await featuresApi.resolvePublisher(did);

      if (publisherResult.error || !publisherResult.pdsUrl) {
        console.warn(`[updater] Could not resolve publisher ${did}:`, publisherResult.error);
        continue;
      }

      // List all release records from this publisher (strict —
      // `features.browse` gate, defaults to read).
      const listResult = await featuresApi.browseListByPublisher({
        did: publisherResult.did,
        pdsUrl: publisherResult.pdsUrl,
      });

      if (listResult.error || !listResult.records) {
        console.warn(`[updater] Could not list records for ${did}:`, listResult.error);
        continue;
      }

      // Check each of our installed features against published records
      for (const feature of pubFeatures) {
        // Skip pinned features
        const policy = feature.updatePolicy || 'auto';
        if (policy === 'pinned') continue;

        const currentVersion = feature.source?.version || '0.0.0';

        // Find the matching record for this featureId
        const record = listResult.records.find(r => r.featureId === feature.id);
        if (!record) continue;

        // Compare versions
        if (compareSemver(record.version, currentVersion) > 0) {
          updates.push({
            id: feature.id,
            name: feature.name,
            currentVersion,
            availableVersion: record.version,
            atUri: record.uri,
          });
        }
      }
    } catch (err) {
      console.error(`[updater] Error checking publisher ${did}:`, err);
    }
  }

  return updates;
}
