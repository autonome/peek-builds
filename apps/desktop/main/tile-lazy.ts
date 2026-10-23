/**
 * Lazy Loading for Tiles — load-on-dispatch
 *
 * A lazy tile is registered at boot with its manifest + launch
 * config, but no BrowserWindow is created. The tile's declared
 * commands are announced to the cmd panel via `cmd:register-batch`, and
 * its declared nouns via `noun:register-batch`, so the panel can list
 * them; its background process boots the first time it needs to handle
 * a command, a noun capability, or a declared lazyEvent topic.
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
 *   - Declarative `type: 'window'` and `type: 'publish'` commands
 *     bypass tile load — the hook publishes `window:reopen-request`
 *     (window) or the declared action topic (publish) directly and
 *     returns 'skip' so the cmd:execute publish never reaches a
 *     handler (there wouldn't have been one anyway; the tile never
 *     loads). Only `type: 'execute'` commands force a tile load.
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
import { type TileManifest, type TileCommand, type TileNoun } from './tile-manifest.js';
import { DEBUG, isDevProfile } from './config.js';
import * as tileLifecycle from './tile-lifecycle.js';
import { suspension } from './tile-suspension-shell.js';
import { clearFeatureLoadError, setFeatureLoadError, resetFeatureLoadErrors } from './feature-load-errors.js';

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
  declaredNounTopics.clear();
  pendingDispatchesByTile.clear();
  _hookInstalled = false;
  _crashObserverInstalled = false;
  resetFeatureLoadErrors();
}

// ─── State ───────────────────────────────────────────────────────────

/** Tiles registered for lazy loading: tileId -> launch options (without window) */
const lazyTileRegistry = new Map<string, {
  manifest: TileManifest;
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

/**
 * `noun:<capability>:<name>` topics of every registered tile's declared
 * `nouns`. Running a noun command from the cmd panel publishes one of
 * these (`renderer/cmd/commands.js` noun proxy), so they wake the tile
 * the same way `cmd:execute:<name>` does.
 */
const declaredNounTopics = new Set<string>();

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
  suspension.dispatchPending(tileId);
}

function clearPendingDispatch(tileId: string, entry: PendingDispatch): void {
  const set = pendingDispatchesByTile.get(tileId);
  if (!set) return;
  if (set.delete(entry)) suspension.dispatchSettled(tileId);
  if (set.size === 0) pendingDispatchesByTile.delete(tileId);
}

function drainPendingDispatches(tileId: string): PendingDispatch[] {
  const set = pendingDispatchesByTile.get(tileId);
  if (!set) return [];
  const entries = Array.from(set);
  pendingDispatchesByTile.delete(tileId);
  for (let i = 0; i < entries.length; i++) suspension.dispatchSettled(tileId);
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
  manifest: TileManifest,
  tilePath: string,
  preloadPath: string,
): void {
  const tileId = manifest.id;
  lazyTileRegistry.set(tileId, { manifest, tilePath, preloadPath });

  // Add any declared lazyEvents and schedule topics to the predicate set.
  for (const topic of collectWakeTopics(manifest)) {
    declaredLazyEventTopics.add(topic);
  }

  for (const topic of collectNounTopics(manifest)) {
    declaredNounTopics.add(topic);
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

  // Announce declared nouns the same way the tile's own `registerNoun`
  // would (`renderer/cmd/nouns.js`): the cmd panel generates the noun's
  // commands (`new group`, `list groups`, ...) from this metadata, so they
  // are listed while the tile is still asleep. When the tile wakes, its
  // `registerNoun` re-announces the same noun and replaces this entry.
  const nouns = declaredNouns(manifest);
  if (nouns.length > 0) {
    publish(
      `peek://${tileId}/lazy-stub`,
      'noun:register-batch',
      {
        nouns: nouns.map(noun => ({
          name: noun.name,
          singular: noun.singular,
          description: noun.description || '',
          source: `peek://${tileId}/background`,
          hasQuery: noun.capabilities.includes('query'),
          hasBrowse: noun.capabilities.includes('browse'),
          hasOpen: noun.capabilities.includes('open'),
          hasCreate: noun.capabilities.includes('create'),
          produces: noun.produces || null,
          params: [],
          modes: [],
          skipBare: noun.skipBare || false,
        })),
      },
    );
  }

  DEBUG && console.log(
    `[tile-lazy] Registered lazy tile: ${tileId} (${manifest.commands?.length || 0} commands, ${nouns.length} nouns, ${collectLazyEventTopics(manifest).length} lazyEvents)`
  );
}

const NOUN_CAPABILITIES = ['query', 'browse', 'open', 'create'] as const;

/** The manifest's well-formed noun declarations. */
function declaredNouns(manifest: TileManifest): TileNoun[] {
  if (!Array.isArray(manifest.nouns)) return [];
  return manifest.nouns.filter(noun =>
    noun && typeof noun.name === 'string' && noun.name.length > 0 &&
    typeof noun.singular === 'string' && noun.singular.length > 0 &&
    Array.isArray(noun.capabilities) &&
    noun.capabilities.some(cap => (NOUN_CAPABILITIES as readonly string[]).includes(cap)),
  );
}

/** `noun:<capability>:<name>` topics a manifest's declared nouns handle. */
function collectNounTopics(manifest: TileManifest): string[] {
  const topics: string[] = [];
  for (const noun of declaredNouns(manifest)) {
    for (const cap of noun.capabilities) {
      if ((NOUN_CAPABILITIES as readonly string[]).includes(cap)) {
        topics.push(`noun:${cap}:${noun.name}`);
      }
    }
  }
  return topics;
}

function collectLazyEventTopics(manifest: TileManifest): string[] {
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

/**
 * Recompute the lazyEvent predicate set from whatever tiles are still
 * registered. Called after a tile is unregistered so a topic only that
 * tile claimed stops matching the dispatch hook, while topics shared
 * with a still-registered tile survive. Cheap (run only on the rare
 * register/unregister path, never per publish).
 */
function collectScheduleTopics(manifest: TileManifest): string[] {
  const topics = new Set<string>();
  if (!Array.isArray(manifest.tiles)) return [];
  for (const tile of manifest.tiles) {
    if (!Array.isArray(tile.schedule)) continue;
    for (const entry of tile.schedule) {
      if (entry && typeof entry.topic === 'string' && entry.topic.length > 0) {
        topics.add(entry.topic);
      }
    }
  }
  return Array.from(topics);
}

/**
 * Every topic that wakes this tile through the dispatch hook: the entries'
 * declared `lazyEvents` plus the topics their schedules publish. A schedule
 * topic takes exactly the same wake path as a lazyEvent — main publishes it
 * when it comes due and the hook loads the owner if it is asleep.
 */
function collectWakeTopics(manifest: TileManifest): string[] {
  return Array.from(new Set([
    ...collectLazyEventTopics(manifest),
    ...collectScheduleTopics(manifest),
  ]));
}

function rebuildDeclaredLazyEventTopics(): void {
  declaredLazyEventTopics.clear();
  declaredNounTopics.clear();
  for (const { manifest } of lazyTileRegistry.values()) {
    for (const topic of collectWakeTopics(manifest)) {
      declaredLazyEventTopics.add(topic);
    }
    for (const topic of collectNounTopics(manifest)) {
      declaredNounTopics.add(topic);
    }
  }
}

/**
 * Live counterpart to `registerLazyTile` — used when a lazy feature is
 * DISABLED mid-session (Features Manager). Removes the tile from the
 * lazy registry so the load-on-dispatch hook stops matching its
 * commands / lazyEvents, drops its lazyEvent topics from the predicate
 * set, and publishes `cmd:unregister` for each announced command so the
 * cmd panel drops the now-dead palette entries. After this the only
 * thing left to tear down is the OS accelerators (the registrar owns
 * those — see `disarmLazyTile` in tile-compat).
 *
 * Idempotent: a no-op if the tile was never registered. Symmetrical
 * with a fresh boot-with-feature-disabled, where the tile never enters
 * the registry at all.
 */
export function unregisterLazyTile(tileId: string): void {
  const config = lazyTileRegistry.get(tileId);
  if (!config) return;

  // Drop the command-palette entries this tile announced via
  // `cmd:register-batch` at registration. Mirror the source address the
  // registration used so any source-scoped bookkeeping lines up.
  if (Array.isArray(config.manifest.commands)) {
    for (const cmd of config.manifest.commands) {
      publish(`peek://${tileId}/lazy-stub`, 'cmd:unregister', { name: cmd.name });
    }
  }
  for (const noun of declaredNouns(config.manifest)) {
    publish(`peek://${tileId}/lazy-stub`, 'noun:unregister', { name: noun.name });
  }

  lazyTileRegistry.delete(tileId);
  suspension.disabled(tileId);
  // Drop any in-flight load bookkeeping so a later re-enable starts clean.
  loadingTiles.delete(tileId);
  pendingDispatchesByTile.delete(tileId);
  rebuildDeclaredLazyEventTopics();
  // A feature disabled mid-session must not keep a red card it can never
  // clear — re-enable re-arms the tile and the next wake decides again.
  clearFeatureLoadError(tileId);

  DEBUG && console.log(`[tile-lazy] Unregistered lazy tile: ${tileId}`);
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
    if (t.to === 'crashed' && lazyTileRegistry.has(t.tileId) && (t as { entryId?: string }).entryId === getBackgroundEntry(t.tileId)) {
      suspension.crashed(t.tileId);
    }
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
  return declaredLazyEventTopics.has(topic) || declaredNounTopics.has(topic);
}

async function dispatchHookBody(topic: string, msg: unknown): Promise<PrePublishHookResult> {
  if (topic.startsWith('cmd:execute:')) {
    const name = topic.slice('cmd:execute:'.length);
    return handleCommandDispatch(name, msg);
  }
  if (declaredNounTopics.has(topic)) {
    return handleNounDispatch(topic, msg);
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

  // Declarative `type: 'publish'` commands: the main process emits the
  // declared topic directly with merged action.data + invocation msg,
  // then resolves the result topic. No tile load required — the topic's
  // real subscribers (tiles, core, etc.) handle it. Short-circuit and
  // skip the original cmd:execute publish.
  if (cmd.action?.type === 'publish' && cmd.action.topic) {
    DEBUG && console.log(`[tile-lazy] Declarative publish action for ${name}, emitting ${cmd.action.topic}`);
    const ctx = (msg && typeof msg === 'object') ? msg as Record<string, unknown> : {};
    const data = { ...(cmd.action.data || {}), ...ctx };
    publish(getSystemAddress(), cmd.action.topic, data);
    const typed = msg as { resultTopic?: string } | null;
    if (typed?.resultTopic) {
      publish(getSystemAddress(), typed.resultTopic, { success: true });
    }
    return 'skip';
  }

  // Programmatic command: load the tile (if needed), then let the
  // publish continue — by which point the tile's background has
  // subscribed its real handler.
  return wakeForDispatch(tileId, name, msg);
}

/**
 * A noun command run from the cmd panel (`noun:<capability>:<name>`) for a
 * noun a lazy tile declares: wake the tile, then deliver — the tile's
 * `registerNoun` subscribes the capability handler during init.
 */
async function handleNounDispatch(
  topic: string,
  msg: unknown,
): Promise<PrePublishHookResult> {
  const owner = findTileByNounTopic(topic);
  if (!owner) return 'continue';
  const bgEntry = getBackgroundEntry(owner.tileId);
  if (bgEntry) {
    assertDispatchFsmState(owner.tileId, bgEntry, topic);
  }
  return wakeForDispatch(owner.tileId, topic, msg);
}

/**
 * Load the tile a dispatch targets and let the publish continue once it is
 * ready. On a failed load the caller's result topic gets an error and the
 * publish is skipped, so the cmd panel settles instead of waiting out its
 * proxy timeout.
 */
async function wakeForDispatch(
  tileId: string,
  name: string,
  msg: unknown,
): Promise<PrePublishHookResult> {
  const typedMsg = msg as { resultTopic?: string } | null;
  const pending: PendingDispatch = {
    cmdName: name,
    resultTopic: typedMsg?.resultTopic ?? null,
  };
  registerPendingDispatch(tileId, pending);
  try {
    await ensureTileLoaded(tileId);
    // A request/response command keeps the tile loaded until its answer is published. Taken
    // before the pending entry is dropped so there is no unprotected gap.
    if (pending.resultTopic) suspension.holdForResult(tileId, pending.resultTopic);
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
  // Wake gate: a wake that arrives while the tile is being suspended waits for the unload to
  // finish, so it is delivered to a fresh load instead of a renderer that is shutting down.
  await suspension.beginWake(tileId);
  try {
    await loadLazyTile(tileId);
    await launcher.waitForTileReady(tileId, bgEntry);
  } catch (err) {
    suspension.wakeFailed(tileId);
    const message = err instanceof Error ? err.message : String(err);
    setFeatureLoadError(tileId, message);
    throw err;
  }
  suspension.wakeReady(tileId);
  clearFeatureLoadError(tileId);
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

export function getBackgroundEntry(tileId: string): string | null {
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

function findTileByNounTopic(topic: string): { tileId: string } | null {
  for (const [tileId, config] of lazyTileRegistry) {
    if (collectNounTopics(config.manifest).includes(topic)) {
      return { tileId };
    }
  }
  return null;
}

function findTileByLazyEventTopic(topic: string): { tileId: string } | null {
  for (const [tileId, config] of lazyTileRegistry) {
    if (collectWakeTopics(config.manifest).includes(topic)) {
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
 * Used by the window-open IPC handler to recognise tile URLs
 * before the tile has actually booted.
 */
export function getLazyTileManifest(tileId: string): TileManifest | null {
  return lazyTileRegistry.get(tileId)?.manifest || null;
}

export function getLazyTileIds(): string[] {
  return Array.from(lazyTileRegistry.keys());
}

/**
 * One-time boot-time backfill: WAKE a lazy tile (load + wait for ready)
 * WITHOUT delivering any dispatch, so its renderer can (re)declare its
 * settings-derived global wake hotkeys via `declareWakeShortcuts`. This
 * breaks the migrated-profile deadlock where a user whose saved hotkey
 * prefix differs from the manifest static default would otherwise have NO
 * working hotkeys (the tile never boots to declare them). Gated by
 * `wakeDeclarationBackfillNeeded` at the call site.
 *
 * Fire-and-forget: errors are logged, never thrown — boot must not fail on
 * a backfill. Idempotent via `loadLazyTile`'s in-flight dedup. The wake is
 * inert (no peek/slide opens) because we boot the tile rather than publish
 * its wake topic; the declare it performs sets the `lazy_wake_declared`
 * marker, so this never fires again for the tile.
 */
export function backfillWakeDeclaration(tileId: string): void {
  ensureTileLoaded(tileId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tile-lazy] wake-declaration backfill failed for ${tileId}: ${message}`);
  });
}
