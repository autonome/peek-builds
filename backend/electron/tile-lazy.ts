/**
 * Lazy Loading for Tiles
 *
 * Runtime-level lazy loading: tiles don't need to know about it.
 * - Register command stubs from manifest (tile not loaded yet)
 * - On first command invocation, load the tile
 * - Buffer the message, wait for tile:ready, replay it
 *
 * This mirrors the existing lazy loading in main.ts but adapted
 * for the v2 tile manifest format.
 */

import { publish, subscribe, unsubscribe, scopes, hasSubscriber } from './pubsub.js';
import { launchTile, waitForTileReady, isTileLoaded, type TileLaunchOptions } from './tile-launcher.js';
import { type TileManifestV2, type TileCommand } from './tile-manifest.js';
import { DEBUG } from './config.js';

// ─── State ───────────────────────────────────────────────────────────

/** Pending lazy load: command name -> buffered message */
const lazyCommandPending = new Map<string, unknown>();

/** Tiles registered for lazy loading: tileId -> launch options (without window) */
const lazyTileRegistry = new Map<string, {
  manifest: TileManifestV2;
  tilePath: string;
  preloadPath: string;
}>();

/** Track which lazy tiles are currently being loaded */
const loadingTiles = new Set<string>();

/** Timeout for lazy load (ms) */
const LAZY_LOAD_TIMEOUT_MS = 10000;

// ─── Stub Registration ──────────────────────────────────────────────

/**
 * Register a tile for lazy loading
 *
 * Creates command stubs that trigger tile load on first invocation.
 * The tile's background entry point is loaded only when needed.
 */
export function registerLazyTile(
  manifest: TileManifestV2,
  tilePath: string,
  preloadPath: string
): void {
  const tileId = manifest.id;

  // Store launch config
  lazyTileRegistry.set(tileId, { manifest, tilePath, preloadPath });

  // Register command stubs
  if (manifest.commands) {
    for (const cmd of manifest.commands) {
      registerCommandStub(tileId, cmd);
    }
  }

  DEBUG && console.log(`[tile-lazy] Registered lazy tile: ${tileId} with ${manifest.commands?.length || 0} commands`);
}

/**
 * Register a single command stub for lazy loading
 *
 * The stub subscribes to cmd:execute:{name}. When invoked:
 * 1. Buffer the message
 * 2. Load the tile
 * 3. Wait for tile:ready
 * 4. Verify the tile registered a real handler
 * 5. Replay the buffered message
 */
function registerCommandStub(tileId: string, cmd: TileCommand): void {
  const stubSource = `lazy-stub/${cmd.name}`;
  const executeTopic = `cmd:execute:${cmd.name}`;

  // Subscribe to the execute topic as a stub
  subscribe(stubSource, scopes.GLOBAL, executeTopic, async (msg: unknown) => {
    DEBUG && console.log(`[tile-lazy] Stub invoked for ${cmd.name}, loading tile ${tileId}`);

    // Buffer the latest message (latest wins for concurrent invocations)
    lazyCommandPending.set(cmd.name, msg);

    // Unsubscribe the stub immediately to prevent re-entry
    unsubscribe(stubSource, executeTopic);

    // Load the tile
    try {
      await loadLazyTile(tileId);

      // Wait for the tile to be ready
      const bgEntry = getBackgroundEntry(tileId);
      if (bgEntry) {
        await waitForTileReady(tileId, bgEntry);
      }

      // Verify the real handler registered (exclude our stub prefix)
      const hasRealHandler = hasSubscriber(executeTopic, undefined, 'lazy-stub/');
      if (!hasRealHandler) {
        console.warn(`[tile-lazy] Tile ${tileId} loaded but no handler registered for ${cmd.name}`);
      }

      // Replay the buffered message
      const buffered = lazyCommandPending.get(cmd.name);
      if (buffered !== undefined) {
        lazyCommandPending.delete(cmd.name);
        publish(
          `peek://${tileId}/lazy-replay`,
          scopes.GLOBAL,
          executeTopic,
          buffered
        );
      }
    } catch (err) {
      console.error(`[tile-lazy] Failed to load tile ${tileId} for command ${cmd.name}:`, err);
      lazyCommandPending.delete(cmd.name);

      // Re-register the stub so the command can be retried
      registerCommandStub(tileId, cmd);
    }
  });

  // Register the command in the command registry (so it shows up in cmd panel)
  // Use the same batch mechanism as v1 extensions
  publish(
    `peek://${tileId}/lazy-stub`,
    scopes.GLOBAL,
    'cmd:register-batch',
    {
      commands: [{
        name: cmd.name,
        description: cmd.description || '',
        source: `peek://${tileId}/background`,
        action: cmd.action,
        scope: cmd.scope,
        modes: cmd.modes,
        accepts: cmd.accepts,
        produces: cmd.produces,
        params: cmd.params,
      }],
    }
  );
}

// ─── Tile Loading ────────────────────────────────────────────────────

/**
 * Load a lazy tile on demand
 */
async function loadLazyTile(tileId: string): Promise<void> {
  // Already loaded or loading
  if (isTileLoaded(tileId, getBackgroundEntry(tileId) || 'background')) {
    return;
  }
  if (loadingTiles.has(tileId)) {
    // Wait for the existing load to complete
    const bgEntry = getBackgroundEntry(tileId) || 'background';
    await waitForTileReady(tileId, bgEntry);
    return;
  }

  const config = lazyTileRegistry.get(tileId);
  if (!config) {
    throw new Error(`[tile-lazy] No lazy tile registered: ${tileId}`);
  }

  loadingTiles.add(tileId);

  try {
    // Find the background tile entry
    const bgTile = config.manifest.tiles.find(t => t.type === 'background');
    if (!bgTile) {
      throw new Error(`[tile-lazy] No background tile entry in ${tileId}`);
    }

    // Launch the tile
    const result = launchTile({
      tilePath: config.tilePath,
      manifest: config.manifest,
      preloadPath: config.preloadPath,
      entryId: bgTile.id,
    });

    // Set up a safety timeout
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`[tile-lazy] Load timeout for ${tileId} (${LAZY_LOAD_TIMEOUT_MS}ms)`));
      }, LAZY_LOAD_TIMEOUT_MS);
    });

    // Wait for ready or timeout
    await Promise.race([
      waitForTileReady(tileId, bgTile.id),
      timeoutPromise,
    ]);

    DEBUG && console.log(`[tile-lazy] Tile loaded and ready: ${tileId}`);
  } finally {
    loadingTiles.delete(tileId);
  }
}

/**
 * Get the background entry ID for a tile
 */
function getBackgroundEntry(tileId: string): string | null {
  const config = lazyTileRegistry.get(tileId);
  if (!config) return null;

  const bgTile = config.manifest.tiles.find(t => t.type === 'background');
  return bgTile ? bgTile.id : null;
}

// ─── Queries ─────────────────────────────────────────────────────────

/**
 * Check if a tile is registered for lazy loading
 */
export function isLazyTileRegistered(tileId: string): boolean {
  return lazyTileRegistry.has(tileId);
}

/**
 * Get all registered lazy tile IDs
 */
export function getLazyTileIds(): string[] {
  return Array.from(lazyTileRegistry.keys());
}
