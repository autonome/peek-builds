/**
 * Reloading a feature installed from a local folder when its files change.
 *
 * `reloadLocalFeature()` takes the feature down and brings it back from what
 * is on disk now: running tiles are unloaded, lazy arming is torn down, the
 * manifest cache is refreshed, approval is evaluated against the new manifest,
 * and the feature is armed again through the path boot and enable use
 * (`loadOrArmFeatureTile`). Tiles that were running before are relaunched, so
 * an open window comes back with the new code. A manifest asking for more than
 * was approved leaves the feature unloaded, with the reason as its load error,
 * until it is approved again ("Add from folder").
 *
 * `syncLocalFeatureWatches()` keeps one folder watch per enabled local feature
 * (local-feature-watch.ts); call it after anything that adds, removes, enables
 * or disables a feature.
 *
 * Not reloaded: the feature's `rules`; a rules change still needs a restart.
 */

import path from 'node:path';

import { launchTile, isTileLoaded, unloadTile, getTileManifest, getTileWindow } from './tile-launcher.js';
import { loadOrArmFeatureTile, disarmLazyTile } from './tile-arm.js';
import { parseManifestFile } from './tile-manifest.js';
import { evaluateFeatureApproval } from './feature-approval.js';
import { getFeatureRegistry, upsertManifestCacheForEntry } from './feature-startup.js';
import { setFeatureLoadError, clearFeatureLoadError } from './feature-load-errors.js';
import { publish } from './pubsub.js';
import { getTilePreloadPath } from './config.js';
import { LocalFeatureWatcher, nodeFolderWatchPort } from './local-feature-watch.js';

export interface LocalReloadResult {
  reloaded: boolean;
  error?: string;
}

export async function reloadLocalFeature(featureId: string): Promise<LocalReloadResult> {
  const entry = getFeatureRegistry()?.getFeature(featureId);
  if (!entry || entry.source.type !== 'local' || entry.disabled) {
    return { reloaded: false, error: `Not an enabled local feature: ${featureId}` };
  }

  const previous = getTileManifest(featureId);
  const wasRunning = previous ? previous.tiles.filter(t => isTileLoaded(featureId, t.id)).map(t => t.id) : [];
  // Tile windows are created hidden, so a relaunched window comes back only
  // if it was showing, at the bounds it had.
  const shown = new Map<string, Electron.Rectangle>();
  for (const entryId of wasRunning) {
    const win = getTileWindow(featureId, entryId);
    if (win && !win.isDestroyed() && win.isVisible()) shown.set(entryId, win.getBounds());
  }
  for (const entryId of wasRunning) {
    try {
      await unloadTile(featureId, entryId);
    } catch (err) {
      console.error(`[local-feature-reload] Failed to unload ${featureId}:${entryId}:`, err);
    }
  }
  disarmLazyTile(featureId);
  upsertManifestCacheForEntry(entry);

  const fail = (error: string): LocalReloadResult => {
    setFeatureLoadError(featureId, error);
    publish('feature-registry', 'feature:reload-failed', { id: featureId, error });
    console.warn(`[local-feature-reload] ${featureId} not reloaded: ${error}`);
    return { reloaded: false, error };
  };

  const parsed = parseManifestFile(path.join(entry.path, 'manifest.json'));
  if (parsed?.version !== 'tile' || !parsed.manifest) return fail('manifest.json is missing or invalid');
  const manifest = parsed.manifest;

  const approval = evaluateFeatureApproval(entry, manifest);
  if (!approval.allow) return fail(approval.error);

  const tilePreloadPath = getTilePreloadPath();
  try {
    loadOrArmFeatureTile({ id: featureId, path: entry.path, manifest }, { tilePreloadPath });
    for (const entryId of wasRunning) {
      if (!manifest.tiles.some(t => t.id === entryId) || isTileLoaded(featureId, entryId)) continue;
      launchTile({ tilePath: entry.path, manifest, preloadPath: tilePreloadPath, entryId });
      const bounds = shown.get(entryId);
      const win = bounds && getTileWindow(featureId, entryId);
      if (win && !win.isDestroyed()) {
        win.setBounds(bounds);
        // A reload comes from a file edit elsewhere: re-show without
        // activating the app or taking focus from what the user is doing.
        win.showInactive();
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  clearFeatureLoadError(featureId);
  publish('feature-registry', 'feature:reloaded', { id: featureId });
  console.log(`[local-feature-reload] Reloaded ${featureId} (${wasRunning.length} tile(s) relaunched)`);
  return { reloaded: true };
}

let watcher: LocalFeatureWatcher | null = null;

/** Watch exactly the enabled local features in the registry. */
export function syncLocalFeatureWatches(): void {
  const registry = getFeatureRegistry();
  if (!registry) return;
  watcher ??= new LocalFeatureWatcher({ port: nodeFolderWatchPort, reload: reloadLocalFeature });
  watcher.sync(
    registry.listFeatures({ sourceType: 'local' })
      .filter(e => !e.disabled)
      .map(e => ({ id: e.id, path: e.path })),
  );
}

export function stopLocalFeatureWatches(): void {
  watcher?.closeAll();
  watcher = null;
}
