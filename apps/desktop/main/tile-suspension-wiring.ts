// Connects the tile suspension shell to the running app: real clock and timers, the system
// pubsub address for `tile:suspension-changed`, the lazy-tile registry, and the tile launcher.
// Observe-only: decisions are logged and published, no tile is unloaded.
import { publish, getSystemAddress, setActivityObserver } from './pubsub.js';
import { getBackgroundEntry, getLazyTileManifest, isLazyTileRegistered } from './tile-lazy.js';
import { isTileLoaded, unloadTile } from './tile-launcher.js';
import { tileIdFromSource } from './window-open-registry.js';
import { configureSuspensionShell, suspension, SUSPENSION_CHANGED_TOPIC } from './tile-suspension-shell.js';
import type { SuspensionConfig } from './tile-suspension.js';

const MS_PER_MINUTE = 60 * 1000;

// Shortest schedule interval across the tile's entries, or null when it has no schedule.
function shortestScheduleMs(tileId: string): number | null {
  const manifest = getLazyTileManifest(tileId);
  let shortest: number | null = null;
  for (const entry of manifest?.tiles ?? []) {
    for (const s of entry.schedule ?? []) {
      const ms = s.everyMinutes * MS_PER_MINUTE;
      if (Number.isFinite(ms) && ms > 0 && (shortest === null || ms < shortest)) shortest = ms;
    }
  }
  return shortest;
}

export function installTileSuspension(): void {
  configureSuspensionShell({
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    publishChange: (change) => publish(getSystemAddress(), SUSPENSION_CHANGED_TOPIC, change),
    log: (message) => console.log(message),
    isTracked: isLazyTileRegistered,
    isLoaded: (tileId) => {
      const entry = getBackgroundEntry(tileId);
      return entry !== null && isTileLoaded(tileId, entry);
    },
    isBackgroundEntry: (tileId, entryId) => getBackgroundEntry(tileId) === entryId,
    configFor: (tileId): Partial<SuspensionConfig> => ({ scheduleIntervalMs: shortestScheduleMs(tileId) }),
    unload: async (tileId) => {
      const entry = getBackgroundEntry(tileId);
      if (entry !== null) await unloadTile(tileId, entry);
    },
    observeOnly: true,
  });
  setActivityObserver((address) => {
    const tileId = tileIdFromSource(address);
    if (tileId !== null) suspension.activity(tileId);
  });
}
