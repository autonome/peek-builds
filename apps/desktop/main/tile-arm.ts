/**
 * Per-feature lazy arming / disarming — the single code path that wires a
 * lazy feature tile up for load-on-dispatch + OS-global wake hotkeys, and
 * its symmetric teardown.
 *
 * Shared by BOTH:
 *   - boot (`tile-compat.ts::loadTile`), and
 *   - live re-enable / disable (`tile-ipc.ts` `tile:features:enable` /
 *     `tile:features:disable`).
 *
 * so a mid-session enable reaches the same end state as a fresh boot with the
 * feature enabled (no restart), and a disable tears the same hooks/accelerators
 * down so a disable→enable cycle is clean and idempotent.
 *
 * Why its own module (not tile-compat): tile-compat statically imports
 * tile-ipc (→ mcp-config → `import { app } from 'electron'`), which is NOT
 * importable under `ELECTRON_RUN_AS_NODE=1`. Keeping these helpers here — with
 * only electron-safe deps (tile-lazy, feature-shortcut-registrar, protocol,
 * which all lazy-load electron) — lets both tile-compat AND tile-ipc import
 * them without a cycle, and lets the unit test exercise them without Electron.
 */

import { registerLazyTile, unregisterLazyTile, backfillWakeDeclaration } from './tile-lazy.js';
import { registerWakeShortcuts, unregisterManifestShortcuts, wakeDeclarationBackfillNeeded } from './feature-shortcut-registrar.js';
import { launchTile, isTileLoaded, type TileLaunchResult } from './tile-launcher.js';
import { registerTilePath } from './protocol.js';
import { type TileManifest } from './tile-manifest.js';
import { DEBUG } from './config.js';

/** A tile annotated with its parsed manifest, ready for loading. */
export interface AnnotatedTile {
  id: string;
  path: string;
  manifest: TileManifest;
}

/** Configuration for loading tiles through the compatibility layer. */
export interface TileCompatConfig {
  /** Path to the tile preload script. */
  tilePreloadPath: string;
}

/**
 * Whether a manifest is a lazy tile — no resident entry, but it has commands
 * and/or lazyEvents to wake on. The single predicate that routes a feature
 * down the lazy branch, used by `loadOrArmFeatureTile` for both boot and the
 * live re-enable.
 */
export function isLazyTileManifest(manifest: TileManifest): boolean {
  const residentEntry = manifest.tiles.find(t => t.resident === true);
  if (residentEntry) return false;
  const hasLazyEvents = manifest.tiles.some(t => Array.isArray(t.lazyEvents) && t.lazyEvents.length > 0);
  const hasCommands = !!(manifest.commands && manifest.commands.length > 0);
  return hasCommands || hasLazyEvents;
}

/**
 * Arm a lazy tile: register it for load-on-dispatch and (re)register its
 * OS-global wake hotkeys. (Protocol-path registration is the caller's job —
 * `loadOrArmFeatureTile` does it for every branch.)
 *
 * A lazy tile's renderer isn't running, so it can't register its own global
 * wake hotkeys. The generic main-side registrar owns them: each accelerator's
 * keypress publishes its wake topic (command-style → `cmd:execute:<command>`,
 * or a feature topic), which the load-on-dispatch hook routes into waking this
 * very tile. `registerWakeShortcuts` prefers the tile's persisted, user-
 * configured rows and falls back to the manifest's static defaults — so windows
 * (manifest `{keys, command}`, no persisted rows) registers exactly as before.
 *
 * Idempotent: `registerLazyTile` replaces the registry entry and
 * `registerGlobalShortcut` unregisters any prior grab of the same accelerator
 * before re-registering — so an enable→enable or boot-then-enable never leaks a
 * double accelerator or a duplicate hook subscription.
 */
export function armLazyTile(tile: AnnotatedTile, config: TileCompatConfig): void {
  registerLazyTile(tile.manifest, tile.path, config.tilePreloadPath);
  registerWakeShortcuts(tile.id, tile.manifest);
  // Migrated-profile self-heal: a feature whose REAL hotkeys are settings-
  // derived (peeks/slides) only persists them when its renderer boots. On a
  // profile that has saved settings but never declared (settings predate the
  // lazy-wake system), the replay above registered only the manifest static
  // default — so a user whose configured prefix differs has NO working hotkeys,
  // and the tile never boots to fix it. Wake it ONCE so it declares the real
  // set; the declare sets the `lazy_wake_declared` marker, so this won't fire
  // again — and a static-hotkey tile (windows, no `wakeShortcutsFromSettings`)
  // never triggers it, so an enable cycle won't re-arm it every time.
  if (wakeDeclarationBackfillNeeded(tile.id, tile.manifest)) {
    DEBUG && console.log(`[tile-arm] wake-declaration backfill: waking ${tile.id} to declare settings-derived hotkeys`);
    backfillWakeDeclaration(tile.id);
  }
}

/**
 * THE single "make this feature live" path. Registers the tile's protocol path,
 * then routes by manifest shape:
 *   - lazy (no resident entry, has commands/lazyEvents) → `armLazyTile`
 *   - resident → eager `launchTile` (guarded by `isTileLoaded` so a redundant
 *     call — e.g. re-enable of an already-running feature — won't double-launch)
 *   - neither → nothing beyond the protocol path (launched on demand by URL).
 *
 * Called by BOTH boot (`tile-compat.loadTile`) and the live `tile:features:enable`
 * handler, so a mid-session enable reaches the exact same end state as a fresh
 * boot with the feature enabled — no restart, no duplicated branch logic. The
 * protocol-path registration also closes the re-enable gap: boot's loader SKIPS
 * disabled features before this runs, so a feature disabled at boot never got a
 * path; registering it here keeps `peek://<tileId>/…` resolvable when it wakes.
 */
export function loadOrArmFeatureTile(tile: AnnotatedTile, config: TileCompatConfig): TileLaunchResult | null {
  registerTilePath(tile.id, tile.path);

  if (isLazyTileManifest(tile.manifest)) {
    armLazyTile(tile, config);
    DEBUG && console.log(`[tile-arm] Armed ${tile.id} for lazy loading`);
    return null;
  }

  const residentEntry = tile.manifest.tiles.find(t => t.resident === true);
  if (residentEntry) {
    if (isTileLoaded(tile.id, residentEntry.id)) return null;
    const result = launchTile({
      tilePath: tile.path,
      manifest: tile.manifest,
      preloadPath: config.tilePreloadPath,
      entryId: residentEntry.id,
    });
    DEBUG && console.log(`[tile-arm] Eagerly launched ${tile.id} (resident entry: ${residentEntry.id})`);
    return result;
  }

  // No resident entry, no commands/lazyEvents — just the protocol path; the
  // tile is launched on demand via its peek:// URL.
  DEBUG && console.log(`[tile-arm] Registered ${tile.id} (no resident entry, commands only)`);
  return null;
}

/**
 * Disarm a lazy tile: tear down everything `armLazyTile` set up. Used when a
 * lazy feature is DISABLED or REMOVED mid-session so the cycle is clean and
 * leaves no stale OS accelerators or load-on-dispatch matches.
 *
 *   - `unregisterManifestShortcuts` drops the OS accelerators the registrar
 *     owns for this tile (keyed by `lazyShortcutSource(tileId)`).
 *   - `unregisterLazyTile` removes the tile from the lazy registry (so the
 *     dispatch hook stops matching its commands/lazyEvents) and drops its
 *     command-palette entries via `cmd:unregister`.
 *
 * Idempotent / safe to call when the tile was never armed (both callees no-op
 * on an unknown tile). Tile-window teardown (`unloadTile`) is the disable
 * handler's separate concern and stays there.
 */
export function disarmLazyTile(tileId: string): void {
  unregisterManifestShortcuts(tileId);
  unregisterLazyTile(tileId);
  DEBUG && console.log(`[tile-arm] Disarmed lazy tile ${tileId}`);
}
