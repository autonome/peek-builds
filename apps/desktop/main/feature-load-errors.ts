/**
 * Per-session feature load-error map (id -> message).
 *
 * IPC-only bookkeeping, populated by boot-time loads (`feature-startup.ts`
 * `initializeFeatures()`) and by lazy-tile wake failures (`tile-lazy.ts`
 * `ensureTileLoaded()`). Deliberately NEVER written to `FeatureRegistryEntry`
 * / registry.json — same reasoning as `feature-list-entries.ts`'s module
 * header: it's a transient runtime fact, not install metadata, and persisting
 * it would drift from the next load's real outcome.
 *
 * Electron-free (no imports beyond types) so `tile-lazy.ts` can depend on it
 * without pulling `feature-startup.ts` and its `datastore`/`manifest-cache`/
 * `atproto-source` chain into every tile-lazy test.
 */

const _loadErrors = new Map<string, string>();

/** Get the per-session feature load errors map. */
export function getFeatureLoadErrors(): Map<string, string> {
  return _loadErrors;
}

/** Record a load failure for a feature/tile id. */
export function setFeatureLoadError(id: string, message: string): void {
  _loadErrors.set(id, message);
}

/** Clear a load failure for a feature/tile id (e.g. on successful load). */
export function clearFeatureLoadError(id: string): void {
  _loadErrors.delete(id);
}

/** Drop all recorded load errors — called before a fresh load pass. */
export function resetFeatureLoadErrors(): void {
  _loadErrors.clear();
}
