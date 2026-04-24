/**
 * Lazy Loading for Tiles — load-on-dispatch
 *
 * A lazy v2 tile is registered at boot with its manifest + launch
 * config, but no BrowserWindow is created. The tile's declared
 * commands are announced to the cmd panel via `cmd:register-batch` so
 * it can list them; its background process boots the first time it
 * needs to handle a command or a declared lazyEvent topic.
 *
 * Load-on-dispatch mechanism (Phase E):
 *
 *   - A single pre-publish hook on the pubsub bus intercepts
 *     `cmd:execute:{name}` publishes and any topic declared in some
 *     tile's `lazyEvents`. When the hook matches, it awaits the
 *     owning tile's boot + ready signal, then lets the publish
 *     continue on to subscribers — by which point the tile's real
 *     handler is registered.
 *
 *   - No per-command stub subscribers. The old Phase A-C code
 *     subscribed `lazy-stub/{name}` to every `cmd:execute:{name}` at
 *     boot; that's gone. The hook is the one and only dispatch-site
 *     intercept, scoped by topic predicate.
 *
 *   - Declarative `type: 'window'` commands bypass tile load — the
 *     hook publishes `window:reopen-request` directly and returns
 *     'skip' so the cmd:execute publish never reaches a handler
 *     (there wouldn't have been one anyway; the tile never loads).
 */

import {
  publish, subscribe, registerPrePublishHook, getSystemAddress,
  type PrePublishHookResult,
} from './pubsub.js';
import {
  launchTile as _launchTile,
  waitForTileReady as _waitForTileReady,
  isTileLoaded as _isTileLoaded,
  type TileLaunchOptions,
  type TileLaunchResult,
} from './tile-launcher.js';
import { type TileManifestV2, type TileCommand } from './tile-manifest.js';
import { DEBUG, isDevProfile } from './config.js';
import * as tileLifecycle from './tile-lifecycle.js';

// ─── Launcher Injection (for testability) ───────────────────────────

/**
 * Hooks used by the lazy loader to interact with the tile launcher.
 * Tests can swap these out to avoid creating real BrowserWindow instances.
 */
export interface TileLazyLauncher {
  launchTile: (options: TileLaunchOptions) => TileLaunchResult | void;
  waitForTileReady: (tileId: string, entryId: string) => Promise<void>;
  isTileLoaded: (tileId: string, entryId: string) => boolean;
}

let launcher: TileLazyLauncher = {
  launchTile: _launchTile,
  waitForTileReady: _waitForTileReady,
  isTileLoaded: _isTileLoaded,
};

export function __setTileLazyLauncherForTest(override: Partial<TileLazyLauncher> | null): void {
  if (override === null) {
    launcher = {
      launchTile: _launchTile,
      waitForTileReady: _waitForTileReady,
      isTileLoaded: _isTileLoaded,
    };
    return;
  }
  launcher = {
    launchTile: override.launchTile ?? _launchTile,
    waitForTileReady: override.waitForTileReady ?? _waitForTileReady,
    isTileLoaded: override.isTileLoaded ?? _isTileLoaded,
  };
}

export function __resetTileLazyStateForTest(): void {
  lazyTileRegistry.clear();
  loadingTiles.clear();
  declaredLazyEventTopics.clear();
  pendingDispatchesByTile.clear();
  _hookInstalled = false;
  _crashObserverInstalled = false;
}

// ─── State ───────────────────────────────────────────────────────────

/** Tiles registered for lazy loading: tileId -> launch options (without window) */
const lazyTileRegistry = new Map<string, {
  manifest: TileManifestV2;
  tilePath: string;
  preloadPath: string;
}>();

/** Tiles currently being loaded — prevents duplicate launch on concurrent dispatch. */
const loadingTiles = new Set<string>();

/**
 * Topics declared across every registered tile's `lazyEvents`. Used
 * by the dispatch-hook predicate as a fast O(1) check so publishes of
 * unrelated topics pay only a Set lookup, not a manifest scan.
 */
const declaredLazyEventTopics = new Set<string>();

/** Timeout for lazy load (ms) */
const LAZY_LOAD_TIMEOUT_MS = 10000;

/**
 * Phase 7 — Timeout UX for load-on-dispatch.
 *
 * Each entry in this map tracks a `cmd:execute:{name}` publish that was
 * routed through the hook while its target tile was in `registered`. If
 * the tile never reaches `ready` — either because the load timer fires
 * or because the render process crashes during boot — we reject every
 * pending dispatch for that tile with a user-visible notification
 * instead of letting the cmd panel's 30s proxy timeout absorb the
 * failure silently.
 *
 * Keyed by tileId. A tile can have multiple concurrent dispatches
 * (user fires command, navigates, fires another while the first is
 * still loading); each one is a separate `PendingDispatch` entry.
 */
interface PendingDispatch {
  cmdName: string;
  resultTopic: string | null;
}
const pendingDispatchesByTile = new Map<string, Set<PendingDispatch>>();

function registerPendingDispatch(tileId: string, entry: PendingDispatch): void {
  let set = pendingDispatchesByTile.get(tileId);
  if (!set) {
    set = new Set();
    pendingDispatchesByTile.set(tileId, set);
  }
  set.add(entry);
}

function clearPendingDispatch(tileId: string, entry: PendingDispatch): void {
  const set = pendingDispatchesByTile.get(tileId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) pendingDispatchesByTile.delete(tileId);
}

function drainPendingDispatches(tileId: string): PendingDispatch[] {
  const set = pendingDispatchesByTile.get(tileId);
  if (!set) return [];
  const entries = Array.from(set);
  pendingDispatchesByTile.delete(tileId);
  return entries;
}

/**
 * Publish a user-visible error notification and resolve the caller's
 * result topic (if any) with a structured error — so the cmd panel's
 * proxy promise settles immediately and the state machine returns to
 * IDLE instead of hanging on the 30s proxy fallback timeout.
 *
 * The notification topic is `notification:show` per docs/pubsub-state-machine.md
 * §Load-on-dispatch — timeout UX. No dedicated notification subscriber
 * exists yet in Peek; any future notification surface (HUD overlay,
 * toast, OS notification) listens to this topic.
 */
function reportDispatchFailure(
  tileId: string,
  entry: PendingDispatch,
  reason: 'timeout' | 'crashed',
  timeoutMs: number,
): void {
  const body =
    reason === 'timeout'
      ? `Command "${entry.cmdName}" couldn't run because its tile failed to load within ${timeoutMs}ms.`
      : `Command "${entry.cmdName}" couldn't run because its tile crashed while loading.`;

  try {
    publish(getSystemAddress(), 'notification:show', {
      type: 'error',
      title: "Tile didn't load",
      body,
      context: { tileId, cmdName: entry.cmdName, reason },
    });
  } catch (err) {
    console.error('[tile-lazy] notification:show publish threw:', err);
  }

  // Resolve the proxy's result topic with an error shape so the cmd
  // panel returns to IDLE immediately. This mirrors the "error result"
  // contract other handlers use (see app/cmd/commands.js proxy
  // subscribe of `cmd:execute:{name}:result`).
  if (entry.resultTopic) {
    try {
      publish(getSystemAddress(), entry.resultTopic, { error: body });
    } catch (err) {
      console.error(
        `[tile-lazy] resultTopic publish threw for ${entry.resultTopic}:`,
        err,
      );
    }
  }
}

// ─── Registration ────────────────────────────────────────────────────

/**
 * Register a tile for lazy loading.
 *
 * Publishes `cmd:register-batch` so the cmd panel can list the tile's
 * declared commands, stores the launch config for the dispatch hook to
 * use when it needs to boot the tile, and adds the tile's lazyEvent
 * topics to the hook predicate set.
 *
 * Unlike pre-Phase-E, this does NOT subscribe any per-command stubs.
 * The pre-publish dispatch hook (`dispatchLoadHook`) is the single
 * intercept point for load-on-dispatch.
 */
export function registerLazyTile(
  manifest: TileManifestV2,
  tilePath: string,
  preloadPath: string,
): void {
  const tileId = manifest.id;
  lazyTileRegistry.set(tileId, { manifest, tilePath, preloadPath });

  // Add any declared lazyEvents topics to the predicate set.
  for (const topic of collectLazyEventTopics(manifest)) {
    declaredLazyEventTopics.add(topic);
  }

  // Announce declared commands to the cmd panel. The panel's
  // subscriber builds proxy entries from this batch; it doesn't care
  // whether a stub or a real handler sits behind the source address.
  if (Array.isArray(manifest.commands) && manifest.commands.length > 0) {
    publish(
      `peek://${tileId}/lazy-stub`,
      'cmd:register-batch',
      {
        commands: manifest.commands.map(cmd => ({
          name: cmd.name,
          description: cmd.description || '',
          source: `peek://${tileId}/background`,
          action: cmd.action,
          scope: cmd.scope,
          modes: cmd.modes,
          accepts: cmd.accepts,
          produces: cmd.produces,
          params: cmd.params,
        })),
      },
    );
  }

  DEBUG && console.log(
    `[tile-lazy] Registered lazy tile: ${tileId} (${manifest.commands?.length || 0} commands, ${collectLazyEventTopics(manifest).length} lazyEvents)`
  );
}

function collectLazyEventTopics(manifest: TileManifestV2): string[] {
  const topics = new Set<string>();
  if (!Array.isArray(manifest.tiles)) return [];
  for (const tile of manifest.tiles) {
    if (!tile.lazyEvents) continue;
    for (const topic of tile.lazyEvents) {
      if (typeof topic === 'string' && topic.length > 0) {
        topics.add(topic);
      }
    }
  }
  return Array.from(topics);
}

// ─── Dispatch hook ───────────────────────────────────────────────────

/**
 * Install the single pre-publish hook that enforces load-on-dispatch.
 * Call once at app init, before any command can fire. Idempotent.
 */
let _hookInstalled = false;
let _crashObserverInstalled = false;
export function installLoadOnDispatchHook(): void {
  if (!_hookInstalled) {
    registerPrePublishHook(dispatchHookPredicate, dispatchHookBody);
    _hookInstalled = true;
  }
  installCrashObserver();
}

/**
 * Subscribe to the lifecycle observer topic `tile:state-changed` and
 * reject any pending dispatches when a tile transitions `loading →
 * crashed`. Rejecting eagerly (not waiting for the 10s timeout) is
 * the whole point of Phase 7's crashed-during-load path.
 */
function installCrashObserver(): void {
  if (_crashObserverInstalled) return;
  _crashObserverInstalled = true;
  subscribe('peek://tile-lazy/crash-observer', 'tile:state-changed', (msg: unknown) => {
    const t = msg as { tileId?: string; from?: string; to?: string } | null;
    if (!t || typeof t.tileId !== 'string') return;
    // Only the `loading → crashed` edge matters here. A crash from
    // ready/visible is not a load failure — those are regular runtime
    // crashes and aren't the concern of this path.
    if (t.from !== 'loading' || t.to !== 'crashed') return;
    const pending = drainPendingDispatches(t.tileId);
    for (const entry of pending) {
      reportDispatchFailure(t.tileId, entry, 'crashed', LAZY_LOAD_TIMEOUT_MS);
    }
  });
}

/**
 * Predicate: does this topic need the hook?
 *
 * Yes if it's a primary `cmd:execute:{name}` topic (NOT a sub-topic
 * like `cmd:execute:{name}:result`), or if it's a declared lazyEvent
 * topic. Kept to an O(1) Set/startsWith/slice check — runs on every
 * publish.
 */
function dispatchHookPredicate(topic: string): boolean {
  if (topic.startsWith('cmd:execute:')) {
    const rest = topic.slice('cmd:execute:'.length);
    // `cmd:execute:name` — no further colons. `cmd:execute:name:result`
    // has a colon in the rest and must not be intercepted.
    return !rest.includes(':') && rest.length > 0;
  }
  return declaredLazyEventTopics.has(topic);
}

async function dispatchHookBody(topic: string, msg: unknown): Promise<PrePublishHookResult> {
  if (topic.startsWith('cmd:execute:')) {
    const name = topic.slice('cmd:execute:'.length);
    return handleCommandDispatch(name, msg);
  }
  // lazyEvent topic — find owner and ensure loaded.
  return handleLazyEventDispatch(topic);
}

async function handleCommandDispatch(
  name: string,
  msg: unknown,
): Promise<PrePublishHookResult> {
  const match = findTileByCommand(name);
  if (!match) {
    // Unknown command (wasn't declared in any registered lazy tile).
    // It may be a dynamically registered handler — let delivery proceed
    // and any real subscriber handles it.
    return 'continue';
  }

  const { tileId, cmd } = match;

  // Drift check: the owning tile's background entry should be in a
  // predictable state at dispatch time — either REGISTERED (we're
  // about to load it), LOADING (someone else already is), READY /
  // VISIBLE (handler is live), or UNREGISTERED (for trustedBuiltin
  // tiles whose FSM we don't drive). Anything else (UNLOADING,
  // CRASHED) means something upstream got out of sync with policy.
  // Dev profile surfaces loudly; prod stays quiet (the hook still
  // proceeds — it's a diagnostic, not a blocker).
  const bgEntry = getBackgroundEntry(tileId);
  if (bgEntry) {
    assertDispatchFsmState(tileId, bgEntry, `cmd:execute:${name}`);
  }

  // Declarative `type: 'window'` commands: the main process opens the
  // window directly. No handler on the tile side; the cmd:execute
  // publish would go nowhere. Short-circuit: publish window-open,
  // resolve the caller's result topic if they provided one, and skip
  // the original publish.
  if (cmd.action?.type === 'window' && cmd.action.url) {
    DEBUG && console.log(`[tile-lazy] Declarative window action for ${name}, opening directly`);
    publish(getSystemAddress(), 'window:reopen-request', {
      url: cmd.action.url,
      options: {
        ...(cmd.action.options || {}),
        trackingSource: 'declarative',
        trackingSourceId: name,
      },
    });
    const typed = msg as { resultTopic?: string } | null;
    if (typed?.resultTopic) {
      publish(getSystemAddress(), typed.resultTopic, { success: true });
    }
    return 'skip';
  }

  // Programmatic command: load the tile (if needed), then let the
  // publish continue — by which point the tile's background has
  // subscribed its real handler.
  const typedMsg = msg as { resultTopic?: string } | null;
  const pending: PendingDispatch = {
    cmdName: name,
    resultTopic: typedMsg?.resultTopic ?? null,
  };
  registerPendingDispatch(tileId, pending);
  try {
    await ensureTileLoaded(tileId);
    // Load succeeded — drop the pending entry so a later crash or
    // timeout on a sibling dispatch doesn't fire a stale notification
    // for this one.
    clearPendingDispatch(tileId, pending);
  } catch (err) {
    // If the crash observer already drained this entry (loading →
    // crashed fired before the load timer), don't double-report. The
    // observer removes drained entries from the map.
    const set = pendingDispatchesByTile.get(tileId);
    const stillPending = set?.has(pending) === true;
    if (stillPending) {
      clearPendingDispatch(tileId, pending);
      reportDispatchFailure(tileId, pending, 'timeout', LAZY_LOAD_TIMEOUT_MS);
    }
    console.error(`[tile-lazy] Failed to load tile ${tileId} for command ${name}:`, err);
    // Skip delivery of the original cmd:execute publish. No handler
    // is alive to receive it, and the notification + resultTopic
    // error publish above have already settled the caller's promise.
    return 'skip';
  }
  return 'continue';
}

async function handleLazyEventDispatch(topic: string): Promise<PrePublishHookResult> {
  const owner = findTileByLazyEventTopic(topic);
  if (!owner) {
    // Topic is in the predicate set but no registered tile claims it
    // anymore (e.g. tile was uninstalled between predicate match and
    // hook run). Just proceed.
    return 'continue';
  }
  const bgEntry = getBackgroundEntry(owner.tileId);
  if (bgEntry) {
    assertDispatchFsmState(owner.tileId, bgEntry, `lazyEvent:${topic}`);
  }
  try {
    await ensureTileLoaded(owner.tileId);
  } catch (err) {
    console.error(`[tile-lazy] Failed to load tile ${owner.tileId} for lazyEvent ${topic}:`, err);
  }
  return 'continue';
}

/**
 * Dev-mode drift check at dispatch entry. Logs loudly under
 * `isDevProfile()` when a tile is in a state the FSM says shouldn't
 * accept dispatch (UNLOADING / CRASHED). Never blocks delivery — this
 * is a diagnostic to catch wiring bugs, not a policy enforcer.
 *
 * Accepted states: UNREGISTERED (trustedBuiltin callers skip the FSM),
 * REGISTERED (normal lazy case), LOADING (concurrent dispatch),
 * READY / VISIBLE (hot path).
 */
function assertDispatchFsmState(tileId: string, entryId: string, label: string): void {
  if (!isDevProfile()) return;
  const state = tileLifecycle.getState(tileId, entryId);
  const ok =
    state === tileLifecycle.STATES.UNREGISTERED ||
    state === tileLifecycle.STATES.REGISTERED ||
    state === tileLifecycle.STATES.LOADING ||
    state === tileLifecycle.STATES.READY ||
    state === tileLifecycle.STATES.VISIBLE;
  if (!ok) {
    console.warn(
      `[tile-lazy] DRIFT: dispatch to ${tileId}:${entryId} (${label}) while FSM is "${state}" — ` +
      'expected unregistered/registered/loading/ready/visible. ' +
      'Something bypassed the lifecycle wiring.',
    );
  }
}

// ─── Load orchestration ─────────────────────────────────────────────

/**
 * Ensure a tile is loaded AND ready. Handles the three cases:
 *   - not loaded yet: start load + wait for ready
 *   - loading in progress: wait for the existing load to complete
 *   - already loaded + ready: resolves immediately
 */
async function ensureTileLoaded(tileId: string): Promise<void> {
  const bgEntry = getBackgroundEntry(tileId) || 'background';
  await loadLazyTile(tileId);
  await launcher.waitForTileReady(tileId, bgEntry);
}

/**
 * Load a lazy tile on demand. Used by the dispatch hook when it needs
 * to boot a tile. Idempotent: concurrent calls for the same tile
 * share the same in-flight launch.
 */
async function loadLazyTile(tileId: string): Promise<void> {
  const bgEntry = getBackgroundEntry(tileId) || 'background';
  if (launcher.isTileLoaded(tileId, bgEntry)) return;
  if (loadingTiles.has(tileId)) {
    await launcher.waitForTileReady(tileId, bgEntry);
    return;
  }

  const config = lazyTileRegistry.get(tileId);
  if (!config) {
    throw new Error(`[tile-lazy] No lazy tile registered: ${tileId}`);
  }

  loadingTiles.add(tileId);
  try {
    const bgTile = config.manifest.tiles.find(t => t.lazy === true) ?? config.manifest.tiles[0];
    if (!bgTile) {
      throw new Error(`[tile-lazy] No tile entry to launch in ${tileId}`);
    }

    launcher.launchTile({
      tilePath: config.tilePath,
      manifest: config.manifest,
      preloadPath: config.preloadPath,
      entryId: bgTile.id,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`[tile-lazy] Load timeout for ${tileId} (${LAZY_LOAD_TIMEOUT_MS}ms)`));
      }, LAZY_LOAD_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        launcher.waitForTileReady(tileId, bgTile.id),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    DEBUG && console.log(`[tile-lazy] Tile loaded and ready: ${tileId}`);
  } finally {
    loadingTiles.delete(tileId);
  }
}

function getBackgroundEntry(tileId: string): string | null {
  const config = lazyTileRegistry.get(tileId);
  if (!config) return null;
  const bgTile = config.manifest.tiles.find(t => t.lazy === true) ?? config.manifest.tiles[0];
  return bgTile ? bgTile.id : null;
}

// ─── Lookups ────────────────────────────────────────────────────────

function findTileByCommand(
  name: string,
): { tileId: string; cmd: TileCommand } | null {
  for (const [tileId, config] of lazyTileRegistry) {
    if (!Array.isArray(config.manifest.commands)) continue;
    const cmd = config.manifest.commands.find(c => c.name === name);
    if (cmd) return { tileId, cmd };
  }
  return null;
}

function findTileByLazyEventTopic(topic: string): { tileId: string } | null {
  for (const [tileId, config] of lazyTileRegistry) {
    if (collectLazyEventTopics(config.manifest).includes(topic)) {
      return { tileId };
    }
  }
  return null;
}

// ─── Public queries ─────────────────────────────────────────────────

export function isLazyTileRegistered(tileId: string): boolean {
  return lazyTileRegistry.has(tileId);
}

/**
 * Get the manifest for a lazy-registered tile (without forcing load).
 * Used by the window-open IPC handler to recognise v2 tile URLs
 * before the tile has actually booted.
 */
export function getLazyTileManifest(tileId: string): TileManifestV2 | null {
  return lazyTileRegistry.get(tileId)?.manifest || null;
}

export function getLazyTileIds(): string[] {
  return Array.from(lazyTileRegistry.keys());
}
