/**
 * Features Manager — Update checker module
 *
 * Provides:
 * - compareCapabilities() — compare two TileCapabilities objects for expansion
 * - shouldAutoUpdate() — determine if a feature should auto-update
 * - checkForUpdates() — check installed atproto features for newer versions
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

// ─── Capability Comparison ──────────────────────────────────────────

/**
 * Compare two TileCapabilities objects to detect changes and expansions.
 *
 * @param {object} currentCaps - Currently granted capabilities
 * @param {object} newCaps - Capabilities from the new version's manifest
 * @returns {{ changed: boolean, expanded: boolean, added: string[], removed: string[] }}
 *
 * `expanded` is true if newCaps requests anything not in currentCaps:
 * - New boolean capabilities (commands, shortcuts, sync, theme, settings)
 * - New network domains
 * - New datastore tables
 * - New pubsub scopes or topics
 * - New window permissions
 * - New filesystem paths
 */
export function compareCapabilities(currentCaps, newCaps) {
  const result = {
    changed: false,
    expanded: false,
    added: [],
    removed: [],
  };

  if (!currentCaps && !newCaps) return result;
  if (!currentCaps) currentCaps = {};
  if (!newCaps) newCaps = {};

  // ── Boolean capabilities ──
  const booleanCaps = ['commands', 'shortcuts', 'sync', 'theme', 'settings'];
  for (const cap of booleanCaps) {
    const hadIt = !!currentCaps[cap];
    const hasIt = !!newCaps[cap];
    if (hadIt && !hasIt) {
      result.changed = true;
      result.removed.push(cap);
    } else if (!hadIt && hasIt) {
      result.changed = true;
      result.expanded = true;
      result.added.push(cap);
    }
  }

  // ── PubSub ──
  comparePubSub(currentCaps.pubsub, newCaps.pubsub, result);

  // ── Datastore ──
  compareArrayField(
    currentCaps.datastore?.tables,
    newCaps.datastore?.tables,
    'datastore',
    result
  );

  // ── Network ──
  compareArrayField(
    currentCaps.network?.domains,
    newCaps.network?.domains,
    'network',
    result
  );

  // ── Window ──
  compareWindow(currentCaps.window, newCaps.window, result);

  // ── Filesystem ──
  compareFilesystem(currentCaps.filesystem, newCaps.filesystem, result);

  return result;
}

function comparePubSub(current, next, result) {
  const hadPubsub = !!current;
  const hasPubsub = !!next;

  if (!hadPubsub && !hasPubsub) return;

  if (!hadPubsub && hasPubsub) {
    result.changed = true;
    result.expanded = true;
    result.added.push('pubsub');
    return;
  }

  if (hadPubsub && !hasPubsub) {
    result.changed = true;
    result.removed.push('pubsub');
    return;
  }

  // Compare scopes
  const currentScopes = new Set(current.scopes || []);
  const newScopes = new Set(next.scopes || []);

  for (const scope of newScopes) {
    if (!currentScopes.has(scope)) {
      result.changed = true;
      result.expanded = true;
      result.added.push(`pubsub.scope:${scope}`);
    }
  }
  for (const scope of currentScopes) {
    if (!newScopes.has(scope)) {
      result.changed = true;
      result.removed.push(`pubsub.scope:${scope}`);
    }
  }

  // Compare topics
  const currentTopics = new Set(current.topics || []);
  const newTopics = new Set(next.topics || []);

  for (const topic of newTopics) {
    if (!currentTopics.has(topic)) {
      result.changed = true;
      result.expanded = true;
      result.added.push(`pubsub.topic:${topic}`);
    }
  }
  for (const topic of currentTopics) {
    if (!newTopics.has(topic)) {
      result.changed = true;
      result.removed.push(`pubsub.topic:${topic}`);
    }
  }
}

function compareArrayField(currentArr, newArr, fieldName, result) {
  const hadField = Array.isArray(currentArr) && currentArr.length > 0;
  const hasField = Array.isArray(newArr) && newArr.length > 0;

  if (!hadField && !hasField) return;

  if (!hadField && hasField) {
    result.changed = true;
    result.expanded = true;
    result.added.push(fieldName);
    return;
  }

  if (hadField && !hasField) {
    result.changed = true;
    result.removed.push(fieldName);
    return;
  }

  const currentSet = new Set(currentArr);
  const newSet = new Set(newArr);

  for (const item of newSet) {
    if (!currentSet.has(item)) {
      result.changed = true;
      result.expanded = true;
      result.added.push(`${fieldName}:${item}`);
    }
  }
  for (const item of currentSet) {
    if (!newSet.has(item)) {
      result.changed = true;
      result.removed.push(`${fieldName}:${item}`);
    }
  }
}

function compareWindow(current, next, result) {
  const hadWindow = !!current;
  const hasWindow = !!next;

  if (!hadWindow && !hasWindow) return;

  if (!hadWindow && hasWindow) {
    result.changed = true;
    result.expanded = true;
    result.added.push('window');
    return;
  }

  if (hadWindow && !hasWindow) {
    result.changed = true;
    result.removed.push('window');
    return;
  }

  const windowPerms = ['create', 'query', 'manage'];
  for (const perm of windowPerms) {
    const had = !!current[perm];
    const has = !!next[perm];
    if (!had && has) {
      result.changed = true;
      result.expanded = true;
      result.added.push(`window.${perm}`);
    } else if (had && !has) {
      result.changed = true;
      result.removed.push(`window.${perm}`);
    }
  }
}

function compareFilesystem(current, next, result) {
  const hadFs = !!current;
  const hasFs = !!next;

  if (!hadFs && !hasFs) return;

  if (!hadFs && hasFs) {
    result.changed = true;
    result.expanded = true;
    result.added.push('filesystem');
    return;
  }

  if (hadFs && !hasFs) {
    result.changed = true;
    result.removed.push('filesystem');
    return;
  }

  // Compare read paths
  compareArrayField(current.read, next.read, 'filesystem.read', result);
  // Compare write paths
  compareArrayField(current.write, next.write, 'filesystem.write', result);
}

// ─── Auto-Update Decision ──────────────────────────────────────────

/**
 * Determine if a feature should auto-update.
 *
 * Returns true ONLY if:
 * - feature.updatePolicy === 'auto' AND
 * - capabilities are unchanged or reduced (not expanded)
 *
 * @param {object} feature - FeatureRegistryEntry
 * @param {object} newManifest - The new version's manifest (needs .capabilities)
 * @returns {boolean}
 */
export function shouldAutoUpdate(feature, newManifest) {
  if (!feature || !newManifest) return false;

  // Only auto policy can auto-update
  const policy = feature.updatePolicy || 'auto';
  if (policy !== 'auto') return false;

  // Compare capabilities
  const comparison = compareCapabilities(
    feature.grantedCapabilities,
    newManifest.capabilities
  );

  // Block auto-update if capabilities expanded
  return !comparison.expanded;
}

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
 * @param {object} ipc - IPC interface (api.ipc) for calling main process
 * @returns {Promise<object[]>} - Features with available updates, each with
 *   { id, name, currentVersion, availableVersion, atUri, capabilityComparison }
 */
export async function checkForUpdates(features, ipc) {
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
      // Resolve publisher to get PDS URL
      const publisherResult = await ipc.invoke('feature-browse:resolve-publisher', {
        query: did,
      });

      if (publisherResult.error || !publisherResult.pdsUrl) {
        console.warn(`[updater] Could not resolve publisher ${did}:`, publisherResult.error);
        continue;
      }

      // List all release records from this publisher
      const listResult = await ipc.invoke('feature-browse:list-by-publisher', {
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
