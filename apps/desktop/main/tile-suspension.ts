// Tile suspension policy: when an idle lazy tile is unloaded, and what happens to a wake that
// arrives while the unload is under way. Design: docs/design/tile-suspension.md.
//
// This file is the pure core. `decideSuspension(state, event, now)` returns the next state and a
// list of effects; it imports nothing from electron and holds no timers. The shell (separate
// change) feeds it events, arms the timer the `arm-timer` effect names, and runs `unload` and
// `load`. The policy states mirror the physical lifecycle in tile-fsm.ts and never replace it:
//   suspended == registered, waking == loading, active/idle == ready/visible,
//   suspending == unloading (the existing unload finishes it; there is no ack or deadline).

export type SuspensionPolicy = 'suspended' | 'waking' | 'active' | 'idle' | 'suspending';

export interface SuspensionConfig {
  /** Master switch. Off: the tile is tracked but never suspended. */
  enabled: boolean;
  /** Idle time before suspending. */
  idleMs: number;
  /** A hold older than this is released by the core so a leaked hold cannot pin a tile. */
  holdCapMs: number;
  /** Shortest schedule interval of the tile, or null. Idle time is never below twice this. */
  scheduleIntervalMs: number | null;
}

export const DEFAULT_SUSPENSION_CONFIG: SuspensionConfig = {
  enabled: true,
  idleMs: 10 * 60 * 1000,
  holdCapMs: 30 * 60 * 1000,
  scheduleIntervalMs: null,
};

/**
 * Read the Settings prefs `tileSuspensionEnabled` (boolean, default on) and
 * `tileSuspensionIdleMinutes` (number of at least 1, default 10). Anything else falls back to the
 * default, so a hand-edited or missing value never disables the policy by accident.
 */
export function suspensionConfigFromPrefs(prefs: Record<string, unknown> | null | undefined): Pick<SuspensionConfig, 'enabled' | 'idleMs'> {
  const enabled = prefs?.tileSuspensionEnabled;
  const minutes = prefs?.tileSuspensionIdleMinutes;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SUSPENSION_CONFIG.enabled,
    idleMs: typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 1
      ? Math.round(minutes) * 60 * 1000
      : DEFAULT_SUSPENSION_CONFIG.idleMs,
  };
}

export interface SuspensionState {
  policy: SuspensionPolicy;
  config: SuspensionConfig;
  /** Windows of the tile in any entry (visible or hidden keepLive). */
  windows: ReadonlySet<string>;
  /** Live keepLive windows the tile opened (content windows). */
  ownedWindows: ReadonlySet<string>;
  /** Active holds: hold id -> time acquired. */
  holds: Readonly<Record<string, number>>;
  /** Dispatches waiting on a wake (pendingDispatchesByTile). */
  pendingDispatches: number;
  /** Last time something happened that counts against idleness. */
  lastActivityAt: number;
  /** A wake that arrived while suspending; replayed once when the unload finishes. */
  queuedWake: boolean;
}

export type SuspensionEvent =
  | { type: 'activity' }
  | { type: 'hold-acquired'; id: string }
  | { type: 'hold-released'; id: string }
  | { type: 'window-opened'; id: string; owned?: boolean }
  | { type: 'window-closed'; id: string; owned?: boolean }
  | { type: 'dispatch-pending' }
  | { type: 'dispatch-settled' }
  /** The clock reached the time named by the last `arm-timer` effect. */
  | { type: 'tick' }
  | { type: 'wake-requested' }
  | { type: 'wake-ready' }
  | { type: 'wake-failed' }
  /** The existing unload finished (windows dropped, lifecycle back to registered). */
  | { type: 'unload-finished' }
  | { type: 'crashed' }
  | { type: 'disabled' }
  | { type: 'setting-changed'; config: Partial<SuspensionConfig> };

export type SuspensionEffect =
  /** Run the existing unloadTile for this tile. */
  | { type: 'unload' }
  /** Run the existing lazy load (loadLazyTile). */
  | { type: 'load' }
  /** Replace the pending timer; `at` null cancels it. */
  | { type: 'arm-timer'; at: number | null }
  | { type: 'release-stale-hold'; id: string; heldMs: number };

export interface SuspensionDecision {
  state: SuspensionState;
  effects: SuspensionEffect[];
}

export function initialSuspensionState(
  config: Partial<SuspensionConfig> = {},
  now = 0,
): SuspensionState {
  return {
    policy: 'suspended',
    config: { ...DEFAULT_SUSPENSION_CONFIG, ...config },
    windows: new Set(),
    ownedWindows: new Set(),
    holds: {},
    pendingDispatches: 0,
    lastActivityAt: now,
    queuedWake: false,
  };
}

/** Any condition that forbids suspending. */
export function isInUse(s: SuspensionState): boolean {
  return (
    s.windows.size > 0 ||
    s.ownedWindows.size > 0 ||
    Object.keys(s.holds).length > 0 ||
    s.pendingDispatches > 0
  );
}

/** Idle time actually applied: never below twice the shortest schedule interval. */
export function effectiveIdleMs(config: SuspensionConfig): number {
  const floor = config.scheduleIntervalMs != null ? config.scheduleIntervalMs * 2 : 0;
  return Math.max(config.idleMs, floor);
}

/** When the shell should next send `tick`, or null when no timer is needed. */
export function nextCheckAt(s: SuspensionState): number | null {
  if (s.policy === 'idle') {
    return s.config.enabled ? s.lastActivityAt + effectiveIdleMs(s.config) : null;
  }
  if (s.policy === 'active' || s.policy === 'waking') {
    const times = Object.values(s.holds);
    return times.length ? Math.min(...times) + s.config.holdCapMs : null;
  }
  return null;
}

/** The ready-state policy implied by the counters. */
function settle(s: SuspensionState, now: number): SuspensionState {
  if (s.policy !== 'active' && s.policy !== 'idle') return s;
  if (isInUse(s)) return s.policy === 'active' ? s : { ...s, policy: 'active' };
  if (s.policy === 'idle') return s;
  // Last use condition cleared: that moment is activity.
  return { ...s, policy: 'idle', lastActivityAt: now };
}

function resetToSuspended(s: SuspensionState, now: number): SuspensionState {
  return {
    ...s,
    policy: 'suspended',
    windows: new Set(),
    ownedWindows: new Set(),
    holds: {},
    pendingDispatches: 0,
    lastActivityAt: now,
    queuedWake: false,
  };
}

function withSet(set: ReadonlySet<string>, id: string, add: boolean): ReadonlySet<string> {
  if (set.has(id) === add) return set;
  const next = new Set(set);
  if (add) next.add(id);
  else next.delete(id);
  return next;
}

function reduce(s: SuspensionState, e: SuspensionEvent, now: number, effects: SuspensionEffect[]): SuspensionState {
  // Events that apply in every state.
  if (e.type === 'setting-changed') {
    return { ...s, config: { ...s.config, ...e.config } };
  }
  if (e.type === 'disabled' || e.type === 'crashed') {
    return resetToSuspended(s, now);
  }

  switch (s.policy) {
    case 'suspended':
      if (e.type === 'wake-requested') {
        effects.push({ type: 'load' });
        return { ...s, policy: 'waking', lastActivityAt: now };
      }
      return s;

    case 'suspending':
      if (e.type === 'wake-requested') return s.queuedWake ? s : { ...s, queuedWake: true };
      if (e.type === 'unload-finished') {
        const queued = s.queuedWake;
        const reset = resetToSuspended(s, now);
        if (!queued) return reset;
        effects.push({ type: 'load' });
        return { ...reset, policy: 'waking' };
      }
      return s;

    case 'waking':
      switch (e.type) {
        case 'wake-ready':
          return settle({ ...s, policy: 'active', lastActivityAt: now }, now);
        case 'wake-failed':
          return resetToSuspended(s, now);
        case 'wake-requested':
          return s;
        default:
          return trackUse(s, e, now);
      }

    case 'active':
    case 'idle': {
      if (e.type === 'tick') {
        const due = s.policy === 'idle' && s.config.enabled &&
          now - s.lastActivityAt >= effectiveIdleMs(s.config);
        if (!due) return s;
        effects.push({ type: 'unload' });
        return { ...s, policy: 'suspending' };
      }
      if (e.type === 'wake-requested') {
        // Already loaded: delivery is the caller's, but a wake is activity.
        return { ...s, lastActivityAt: now };
      }
      return settle(trackUse(s, e, now), now);
    }
  }
}

/** Counter-changing events, shared by waking and ready states. */
function trackUse(s: SuspensionState, e: SuspensionEvent, now: number): SuspensionState {
  switch (e.type) {
    case 'activity':
      return { ...s, lastActivityAt: now };
    case 'hold-acquired':
      return s.holds[e.id] !== undefined
        ? s
        : { ...s, holds: { ...s.holds, [e.id]: now }, lastActivityAt: now };
    case 'hold-released': {
      if (s.holds[e.id] === undefined) return s;
      const { [e.id]: _gone, ...rest } = s.holds;
      return { ...s, holds: rest, lastActivityAt: now };
    }
    case 'window-opened': {
      const key = e.owned ? 'ownedWindows' : 'windows';
      return { ...s, [key]: withSet(s[key], e.id, true), lastActivityAt: now };
    }
    case 'window-closed': {
      const key = e.owned ? 'ownedWindows' : 'windows';
      if (!s[key].has(e.id)) return s;
      return { ...s, [key]: withSet(s[key], e.id, false), lastActivityAt: now };
    }
    case 'dispatch-pending':
      return { ...s, pendingDispatches: s.pendingDispatches + 1, lastActivityAt: now };
    case 'dispatch-settled':
      return s.pendingDispatches === 0
        ? s
        : { ...s, pendingDispatches: s.pendingDispatches - 1, lastActivityAt: now };
    default:
      return s;
  }
}

/** Drop holds older than the cap (not while suspended or suspending, which carry none). */
function expireHolds(s: SuspensionState, now: number, effects: SuspensionEffect[]): SuspensionState {
  if (s.policy === 'suspended' || s.policy === 'suspending') return s;
  const holds: Record<string, number> = { ...s.holds };
  let changed = false;
  for (const [id, at] of Object.entries(s.holds)) {
    if (now - at >= s.config.holdCapMs) {
      delete holds[id];
      changed = true;
      effects.push({ type: 'release-stale-hold', id, heldMs: now - at });
    }
  }
  return changed ? { ...s, holds, lastActivityAt: now } : s;
}

export function decideSuspension(
  state: SuspensionState,
  event: SuspensionEvent,
  now: number,
): SuspensionDecision {
  const effects: SuspensionEffect[] = [];
  const expired = expireHolds(state, now, effects);
  const next = reduce(expired === state ? state : settle(expired, now), event, now, effects);
  const before = nextCheckAt(state);
  const after = nextCheckAt(next);
  if (before !== after) effects.push({ type: 'arm-timer', at: after });
  return { state: next, effects };
}
