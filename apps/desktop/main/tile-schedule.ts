/**
 * Manifest-declared schedules — the timer that makes a sleeping feature run
 * unattended.
 *
 * A tile entry may declare `schedule: [{ topic, everyMinutes }]`. One timer per
 * entry lives HERE, in main, never in the tile: a feature that polls every 15
 * minutes must not have to stay loaded to keep its own clock. When an entry
 * comes due, main publishes its topic from the system address; the load-on-
 * dispatch hook in `tile-lazy.ts` recognises the topic (schedule topics join
 * the same predicate set as `lazyEvents`), loads the owning tile if it is
 * asleep, and then delivers the publish to the tile's handler. A tile that is
 * already awake just receives the publish.
 *
 * Timers arm when a tile is registered and clear when it is unregistered, so
 * disabling a feature stops its schedule and re-enabling it starts it again.
 * Nothing fires until `startTileSchedules()` runs, which happens once boot has
 * finished registering tiles — otherwise a due-at-startup entry would publish
 * into a half-built registry. Boot also holds every fire for a settle period
 * after that, so a due schedule never wakes its tile during boot itself.
 *
 * The last fire time is persisted per profile. On arming, an entry that has
 * never fired, or whose last run is more than one interval old, is due and
 * fires once — however many intervals passed while the app was closed. An
 * entry whose last run is recent first fires when the remainder of its
 * interval has passed.
 *
 * Job logic stays free of window and DOM calls so a peeklet can later run
 * somewhere other than the desktop.
 */

import { publish, getSystemAddress } from './pubsub.js';
import {
  getScheduleLastRun as _getScheduleLastRun,
  setScheduleLastRun as _setScheduleLastRun,
} from './datastore.js';
import { type TileManifest, type TileScheduleEntry } from './tile-manifest.js';
import { DEBUG } from './config.js';

const MS_PER_MINUTE = 60 * 1000;

/** How long after boot a due schedule waits before it may fire. */
export const SCHEDULE_BOOT_HOLD_MS = 30 * 1000;

// ─── Injection (for testability) ────────────────────────────────────

export type ScheduleTimerHandle = unknown;

export interface TileScheduleClock {
  now: () => number;
}

export interface TileScheduleTimers {
  setTimeout: (fn: () => void, ms: number) => ScheduleTimerHandle;
  clearTimeout: (handle: ScheduleTimerHandle) => void;
}

/**
 * Persistence of each entry's last fire time. Injectable because the main-
 * process unit tests run without a datastore, and because a re-arm reading
 * back what a fire recorded is the behaviour under test.
 */
export interface TileScheduleStore {
  getScheduleLastRun: (ownerTileId: string, topic: string) => number | null;
  setScheduleLastRun: (ownerTileId: string, topic: string, lastRunAt: number) => void;
}

const realClock: TileScheduleClock = { now: () => Date.now() };

const realTimers: TileScheduleTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const realStore: TileScheduleStore = {
  getScheduleLastRun: _getScheduleLastRun,
  setScheduleLastRun: _setScheduleLastRun,
};

let clock: TileScheduleClock = realClock;
let timers: TileScheduleTimers = realTimers;
let store: TileScheduleStore = realStore;

export function __setTileScheduleDepsForTest(
  override: {
    clock?: TileScheduleClock;
    timers?: TileScheduleTimers;
    store?: TileScheduleStore;
  } | null,
): void {
  clock = override?.clock ?? realClock;
  timers = override?.timers ?? realTimers;
  store = override?.store ?? realStore;
}

export function __resetTileScheduleStateForTest(): void {
  for (const entries of scheduledTiles.values()) {
    for (const armed of entries) {
      if (armed.handle !== null) timers.clearTimeout(armed.handle);
      armed.handle = null;
    }
  }
  scheduledTiles.clear();
  started = false;
  firstFireNotBefore = 0;
}

// ─── State ──────────────────────────────────────────────────────────

interface ArmedEntry {
  topic: string;
  intervalMs: number;
  /** Live timer, or null while the entry is registered but not yet armed. */
  handle: ScheduleTimerHandle | null;
}

/** Registered tiles that declare a schedule: tileId -> its armed entries. */
const scheduledTiles = new Map<string, ArmedEntry[]>();

/** Whether boot has finished registering tiles. Entries stay unarmed until it has. */
let started = false;

// ─── Manifest reading ───────────────────────────────────────────────

/** The valid schedule entries a manifest declares, across all its tile entries. */
export function collectScheduleEntries(manifest: TileManifest): TileScheduleEntry[] {
  const entries: TileScheduleEntry[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(manifest.tiles)) return entries;
  for (const tile of manifest.tiles) {
    if (!Array.isArray(tile.schedule)) continue;
    for (const entry of tile.schedule) {
      if (!entry || typeof entry.topic !== 'string' || entry.topic.length === 0) continue;
      if (!Number.isInteger(entry.everyMinutes) || entry.everyMinutes < 1) continue;
      if (seen.has(entry.topic)) continue;
      seen.add(entry.topic);
      entries.push({ topic: entry.topic, everyMinutes: entry.everyMinutes });
    }
  }
  return entries;
}

/** Whether a manifest declares at least one usable schedule entry. */
export function hasScheduleEntries(manifest: TileManifest): boolean {
  return collectScheduleEntries(manifest).length > 0;
}

// ─── Registration ───────────────────────────────────────────────────

/**
 * Take ownership of a manifest's schedules. Idempotent per tile: a second
 * registration replaces the first, clearing any timers the old one armed.
 * Arms immediately when boot has already finished (a feature enabled
 * mid-session), otherwise waits for `startTileSchedules()`.
 */
export function registerTileSchedule(manifest: TileManifest): void {
  const entries = collectScheduleEntries(manifest);
  if (entries.length === 0) return;

  unregisterTileSchedule(manifest.id);

  const armed: ArmedEntry[] = entries.map(entry => ({
    topic: entry.topic,
    intervalMs: entry.everyMinutes * MS_PER_MINUTE,
    handle: null,
  }));
  scheduledTiles.set(manifest.id, armed);

  DEBUG && console.log(
    `[tile-schedule] Registered ${armed.length} schedule(s) for ${manifest.id}: ` +
    armed.map(a => `${a.topic} every ${a.intervalMs / MS_PER_MINUTE}m`).join(', '),
  );

  if (started) {
    for (const entry of armed) armEntry(manifest.id, entry);
  }
}

/**
 * Drop a tile's schedules and clear its timers, so a disabled feature stops
 * running. Idempotent: a no-op for a tile that declared none.
 */
export function unregisterTileSchedule(tileId: string): void {
  const armed = scheduledTiles.get(tileId);
  if (!armed) return;
  for (const entry of armed) {
    if (entry.handle !== null) timers.clearTimeout(entry.handle);
    entry.handle = null;
  }
  scheduledTiles.delete(tileId);
  DEBUG && console.log(`[tile-schedule] Unregistered schedules for ${tileId}`);
}

/** No entry fires before this time. Set by `startTileSchedules()`. */
let firstFireNotBefore = 0;

/**
 * Arm every registered schedule. Called once boot has finished registering
 * tiles; registrations after it arm on arrival. Idempotent.
 *
 * `holdMs` keeps any fire, a due-at-startup one included, from landing until
 * that long after this call. Boot passes a hold so a due schedule wakes its
 * tile after the app has settled rather than adding a window to the boot set.
 */
export function startTileSchedules(holdMs = 0): void {
  if (started) return;
  started = true;
  firstFireNotBefore = clock.now() + Math.max(0, holdMs);
  for (const [tileId, armed] of scheduledTiles) {
    for (const entry of armed) armEntry(tileId, entry);
  }
}

/**
 * Recompute delays after system sleep from persisted lastRunAt. Missed intervals
 * collapse to one due fire, never a replay; the boot hold still applies. Only
 * registered schedules participate, and each existing timer is replaced.
 */
export function rearmTileSchedules(): void {
  if (!started) return;
  for (const [tileId, armed] of scheduledTiles) {
    for (const entry of armed) armEntry(tileId, entry);
  }
}

// ─── Timers ─────────────────────────────────────────────────────────

function armEntry(tileId: string, entry: ArmedEntry): void {
  const lastRunAt = store.getScheduleLastRun(tileId, entry.topic);
  // Never fired — due now. Otherwise, however many intervals were missed, the
  // entry is due once, not once each.
  const remaining = lastRunAt === null ? 0 : lastRunAt + entry.intervalMs - clock.now();
  const held = firstFireNotBefore - clock.now();
  scheduleFire(tileId, entry, Math.max(0, remaining, held));
}

function scheduleFire(tileId: string, entry: ArmedEntry, delayMs: number): void {
  if (entry.handle !== null) timers.clearTimeout(entry.handle);
  entry.handle = timers.setTimeout(() => {
    entry.handle = null;
    fire(tileId, entry);
  }, delayMs);
}

function fire(tileId: string, entry: ArmedEntry): void {
  const scheduledAt = clock.now();
  let lastRunAt: number | null = null;
  try {
    lastRunAt = store.getScheduleLastRun(tileId, entry.topic);
    store.setScheduleLastRun(tileId, entry.topic, scheduledAt);
  } catch (err) {
    console.error(`[tile-schedule] Failed to record run of ${tileId} ${entry.topic}:`, err);
  }

  // Re-arm before publishing: a handler that throws must not stop the schedule.
  scheduleFire(tileId, entry, entry.intervalMs);

  DEBUG && console.log(`[tile-schedule] Firing ${entry.topic} for ${tileId} (last run ${lastRunAt})`);
  try {
    publish(getSystemAddress(), entry.topic, { scheduledAt, lastRunAt });
  } catch (err) {
    console.error(`[tile-schedule] Publish of ${entry.topic} threw:`, err);
  }
}

// ─── Public queries ─────────────────────────────────────────────────

/** Topics a tile's schedules publish. Empty for a tile with no schedule. */
export function getScheduledTopics(tileId: string): string[] {
  return (scheduledTiles.get(tileId) ?? []).map(entry => entry.topic);
}

/** Tile ids holding at least one registered schedule. */
export function getScheduledTileIds(): string[] {
  return Array.from(scheduledTiles.keys());
}
