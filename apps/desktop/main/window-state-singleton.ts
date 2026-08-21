/**
 * window-state-singleton.ts — the ONE live `WindowOsAdapter` for the desktop
 * app, plus the thin read/dispatch surface the seam consumers use.
 *
 * Blueprint: `docs/design/window-manager.md`. `window-state.ts` is
 * the pure reducer, `window-os-adapter.ts` is the OS-boundary adapter; THIS
 * module holds the single adapter instance and exposes the machine to the rest
 * of main (ipc.ts / tile-ipc.ts / windows.ts / main.ts / hybrid-overlay.ts /
 * tile-launcher.ts). It replaces the deleted scattered authorities:
 *   - `getTopmostContentWindowId()` ← ipc.ts `getLastFocusedVisibleWindowId`
 *   - `subscribeOverlayAttachment()` ← registry `onActiveHybridWindowChange`
 *   - `getDevtoolsTargetId()`   ← ipc.ts `getLastContentWindowId`
 *   - `getWindowPreBounds()`    ← registry `preFullScreenBounds`
 *   - `dispatchWindowEvent()`   ← the FULLSCREEN/ESC/SWITCHER/hide reroutes
 *
 * The adapter is constructed lazily on first access and made live (native app
 * listeners attached + session mirror seeded) once from `main.ts` at boot via
 * `initWindowStateMachine()`.
 */

import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { WindowOsAdapter, type RegisterWindowSpec } from './window-os-adapter.js';
import { getKernelExecutor } from './window-kernel-singleton.js';
import type { WindowKernelExecutor } from './window-kernel-executor.js';
import { getIzuiCoordinator } from './izui-state.js';
import type { WindowEvent, IzuiSession, WindowRecord, EscapeMode, StateSnapshot } from './window-state.js';
import type { Rectangle, WindowId, WindowKind } from './window-kernel.js';
import type { WindowClass } from './izui-roles.js';
import {
  setKernelExecutorProvider,
  shadowKernelRegisterWindow,
  shadowKernelWindowShown,
  getShadowKernelExecutor,
} from './window-kernel-shadow.js';
import { topmost, isContentWindow } from './window-kernel.js';
import { handleEscapePress, type EscapeRuntimeDeps } from './window-escape-runtime.js';
import { publish, getSystemAddress } from './pubsub.js';
import { wmLog } from './window-diag.js';

/** Register-spec that accepts real Electron window handles (both kinds satisfy the adapter's structural `NativeWindow`). */
export interface MachineWindowSpec {
  kind: WindowKind;
  role: string;
  /** Window class (§4.3 dim 8b) — required; ordinary opens use `classifyWindowRegistration`, the infrastructure classes declare theirs. */
  class: WindowClass;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  /** Parent linkage (open params `parentWindowId` → WindowId). Drives the parent-refocus transition on WINDOW_CLOSED. */
  parentId?: WindowId | null;
  /** The old `main.ts windowRegistry` payload — opening source + open params (opaque, held by reference on the reducer record). */
  source?: string;
  params?: Record<string, unknown>;
  /** Declared always-on-top intent — registration emits SET_ALWAYS_ON_TOP. */
  alwaysOnTop?: boolean;
  /** keepLive policy declared at open time — drives the reducer's `WINDOW_CLOSE_OR_HIDE_REQUESTED` hide-vs-close decision (see `WindowRecord.keepLive`). */
  keepLive?: boolean;
  /** See `window-kernel.ts WindowRecord.tracksBaseLayerTop`'s doc — declared here, nothing reads it yet. Old machine does not carry this fact; it rides straight through to the kernel. */
  tracksBaseLayerTop?: boolean;
  /** See `window-kernel.ts WindowRecord.selfClosesOnBlur`'s doc — declared here. Old machine does not carry this fact; it rides straight through to the kernel. */
  selfClosesOnBlur?: boolean;
  /** BaseWindow (page-host) or BrowserWindow (browser). */
  win: BaseWindow | BrowserWindow;
  /** Content view WC for a page-host, root WC for a browser. */
  contentWC?: WebContents | null;
  /**
   * Opt OUT of the adapter-owned `before-input-event` Esc interceptor (browser
   * windows only, default on). See `RegisterWindowSpec.attachEscHandler` — the
   * shared chrome overlay is the one caller that passes false.
   */
  attachEscHandler?: boolean;
  /**
   * The kernel's three orthogonal per-window fields (`izui-roles.ts
   * WindowSurfaceProperties`, `deriveWindowSurface`). Required so every
   * registration site declares them explicitly; nothing in this (old)
   * machine reads them yet — they ride the spec so the later cutover to
   * `window-kernel.ts` (whose `Event.WindowRegistered` requires all three)
   * needs no call-site changes.
   */
  layer: number;
  /** See `layer` above. */
  canBecomeKey: boolean;
  /** See `layer` above. */
  acceptsInput: boolean;
}

let adapter: WindowOsAdapter | null = null;
let sessionSeeded = false;

/** The single OS-boundary adapter. Constructed on first use. */
function getWindowOsAdapter(): WindowOsAdapter {
  if (!adapter) adapter = new WindowOsAdapter();
  return adapter;
}

/**
 * The single production `WindowKernelExecutor`, built over the adapter's
 * backend — the same `ElectronWindowBackend` every old-machine effect already
 * goes through (`window-os-adapter.ts getBackend`).
 *
 * This is the accessor `window-kernel-singleton.ts` was written to have and
 * deliberately left unwired; wiring it is the cutover. The backend is passed
 * by injection rather than imported there so that module stays loadable under
 * `ELECTRON_RUN_AS_NODE=1` — see its header.
 *
 * ONE BACKEND, ONE ID SPACE. Every `WindowId` the kernel speaks is minted by
 * this backend's registration, so kernel ids and the ids
 * `getWindowIdFor`/`getNativeWindowFor` resolve are the same ids. Building the
 * executor over a second backend instead would silently give the kernel its
 * own disjoint id space.
 */
export function getKernelExecutorForApp(): WindowKernelExecutor {
  return getKernelExecutor(getWindowOsAdapter().getBackend());
}

/**
 * Boot wiring (call ONCE from main.ts after the coordinator exists): attach the
 * adapter's app-level `did-become/resign-active` listeners and seed the session
 * mirror. Idempotent.
 */
export function initWindowStateMachine(): void {
  // THE CUTOVER. Installing this provider is what makes the ~27 feed helpers in
  // `window-kernel-shadow.ts` land on the production `WindowKernelExecutor`
  // over the real backend instead of the `NoopKernelBackend` that recorded and
  // discarded. From here the kernel PERFORMS window operations, which is why
  // `window-os-adapter.ts runEffect` no longer does — two machines cannot both
  // hold the backend, or every show, raise, close and stacking write happens
  // twice.
  //
  // INJECTION, NOT IMPORT: the provider is a lazy thunk because
  // `window-kernel-shadow.ts` must not value-import this module — see that
  // file's executor-provider banner for the cycle and the
  // `ELECTRON_RUN_AS_NODE=1` reasons.
  setKernelExecutorProvider(() => getKernelExecutorForApp());
  getWindowOsAdapter().attachAppListeners();
  seedSessionMirror();
}

function seedSessionMirror(): void {
  if (sessionSeeded) return;
  sessionSeeded = true;
  const coord = getIzuiCoordinator();
  coord.onSessionChange((state) => dispatchWindowEvent({ type: 'SESSION_CHANGED', session: clampSession(state) }));
  // Seed the machine with the coordinator's current session immediately.
  dispatchWindowEvent({ type: 'SESSION_CHANGED', session: clampSession(coord.getState()) });
  // Front-id provider for the coordinator's switcher focus-restore seed
  // (`enterOverlay` → `preOverlayFocusTarget`, step 8a): the machine's `front`
  // converted to the numeric Electron id the coordinator's session (and its
  // renderer read surface in tile-ipc.ts) speaks. Injected — the coordinator
  // must not value-import this module (cycle + electron in the unit run).
  coord.setFrontWindowIdProvider(() => {
    const front = getTopmostContentWindowId();
    if (front == null) return null;
    const native = getNativeWindowFor(front);
    return native ? native.id : null;
  });
}

/**
 * Clamp the coordinator's four-state (idle/transient/active/overlay) to the
 * reducer's tri-state. `overlay` is a transient-over-active state, and
 * `decideEscape` step 1 intercepts the overlay-open ESC before step 6 ever
 * reads the session — so mirroring it as `active` is behavior-neutral.
 */
function clampSession(state: string): IzuiSession {
  return state === 'overlay' ? 'active' : (state as IzuiSession);
}

/**
 * Register a window (both kinds) with the machine + attach its native
 * listeners. Returns the WM-minted `WindowId` for this window (stable across
 * duplicate registrations of the same native window).
 */
export function registerWindowWithMachine(spec: MachineWindowSpec): WindowId {
  // Both BaseWindow and BrowserWindow satisfy the adapter's structural
  // `NativeWindow`; the electron typed-overload `on` isn't assignable to the
  // loose `on` shape, so bridge with a single cast here (not at every call site).
  const id = getWindowOsAdapter().registerWindow(spec as unknown as RegisterWindowSpec);
  // Feed the kernel (window-kernel-shadow.ts) — this is what drives the
  // window manager; the dispatch above only reaches the old machine, whose
  // matching effect arm is a no-op.
  const settledSnapshot = getWindowOsAdapter().getOwner().snapshot();
  // The old machine's `registerWindow` (`window-os-adapter.ts`) already
  // seeded its own bounds mirror from this same registration's
  // `initialBounds` read — `settledSnapshot` reflects that, so reading it
  // back here carries the same value through to the kernel's seed rather
  // than re-deriving it. On a re-registration this is the old machine's
  // OWN settled value (lived bounds preserved, or `initialBounds` filled
  // into an empty mirror) — exactly the fill-only-if-empty rule the
  // kernel's merge arm applies again on its own side.
  const registeredRecord = settledSnapshot.windows.find((w) => w.id === id);
  shadowKernelRegisterWindow({
    id,
    kind: spec.kind,
    layer: spec.layer,
    canBecomeKey: spec.canBecomeKey,
    acceptsInput: spec.acceptsInput,
    class: spec.class,
    role: spec.role,
    ...(spec.parentId != null ? { parentId: spec.parentId } : {}),
    ...(spec.keepLive !== undefined ? { keepLive: spec.keepLive } : {}),
    ...(spec.escapeMode !== undefined ? { escapeMode: spec.escapeMode } : {}),
    ...(registeredRecord?.bounds !== undefined ? { bounds: registeredRecord.bounds } : {}),
    ...(spec.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: spec.tracksBaseLayerTop } : {}),
    ...(spec.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: spec.selfClosesOnBlur } : {}),
  });
  // The divergence comparator now runs INSIDE `shadowKernelRegisterWindow`
  // itself (`window-kernel-shadow.ts`), against the old machine's
  // just-settled snapshot passed in above — see that module's
  // `compareAfterFeed` for why every feed helper takes its own snapshot
  // rather than reading `window-state-singleton.ts` back.
  //
  // `getWindowOsAdapter().registerWindow` above already pumped the old
  // machine's `WINDOW_SHOWN` for a window that was already visible at ctor
  // time (`window-os-adapter.ts registerWindow`'s `pumpShownEvent` branch —
  // a ctor-shown window never fires a native `'show'` transition, so this is
  // the only report that import ever gets) — `settledSnapshot` above already
  // reflects it. Import the same fact into the shadow: its `RegisterWindow`
  // command just above always creates the record `visible: false`, so
  // without this a ctor-shown window's shadow record can never become
  // visible either. Reuses `registeredRecord` from the bounds seed above —
  // same snapshot, same lookup.
  if (registeredRecord?.visible) {
    // `pumpShownEvent` (`window-os-adapter.ts registerWindow`) always dispatches
    // the old machine's `WINDOW_SHOWN` with `focused: true` — this import
    // mirrors the same fact.
    shadowKernelWindowShown(id, true);
  }
  return id;
}

/**
 * The WM `WindowId` for a native window handle — or for a numeric ELECTRON
 * window id a legacy Electron-keyed registry (hybrid registry,
 * renderer-facing tile IPC) still holds. `null` when never registered / gone.
 *
 * This is the ONE sanctioned WM↔platform id conversion surface (with
 * `getNativeWindowFor` below); it delegates to the adapter's private maps. No
 * other module may keep its own WindowId↔Electron-id mapping.
 */
export function getWindowIdFor(win: BaseWindow | BrowserWindow | number): WindowId | null {
  // Same structural-`NativeWindow` bridge cast as `registerWindowWithMachine`.
  return getWindowOsAdapter().getWindowIdFor(win as unknown as RegisterWindowSpec['win'] | number);
}

/**
 * The live native window handle for a WM `WindowId`, or `null` when
 * unregistered/destroyed. Legacy consumers use this to join a machine id back
 * onto the Electron-keyed registries they still run on (a later migration step
 * re-keys those registries and deletes the need).
 */
export function getNativeWindowFor(id: WindowId): BaseWindow | BrowserWindow | null {
  return getWindowOsAdapter().getNativeWindowFor(id) as unknown as BaseWindow | BrowserWindow | null;
}

/** Feed an event into the machine (runs effects + Esc-grab reconcile + log). */
export function dispatchWindowEvent(event: WindowEvent): void {
  getWindowOsAdapter().dispatch(event);
}

/**
 * THE live Escape decider entry point. `window-escape-runtime.ts
 * handleEscapePress` takes every dependency injected (so it unit-tests
 * without `electron`); this binds those deps onto the production kernel,
 * backend and pubsub and calls it. Every site that used to dispatch
 * `window-state.ts`'s `ESC_PRESSED` — `windows.ts addEscHandler`, `ipc.ts
 * wireHybridContentEvents`, `electron-window-backend.ts`'s OS-level grab, and
 * `hybrid-overlay.ts`'s `runHybridEscape` test bridge — calls this ONE
 * function instead. One wrapper, not one arm per window kind: the two prior
 * attempts at this machine both failed by growing a rule per window kind, and
 * this is the seam that stays a single decision regardless of which of the
 * four sites the keystroke arrived through.
 *
 * `site` names the calling dispatch site for `window-diag.ts` — the four
 * entry points are otherwise indistinguishable in the log once the keystroke
 * reaches `handleEscapePress`.
 *
 * `session` is read here, not carried by the caller: the old `ESC_PRESSED`
 * event carried no session field either — `decideEscape` read `state.session`
 * directly — so this wrapper is the direct replacement for that read,
 * against the same clamped session `seedSessionMirror` keeps live.
 */
export function dispatchEscapePress(landedId: WindowId | 'global', site: string): void {
  const session = clampSession(getIzuiCoordinator().getState());
  wmLog('esc-dispatch', { site, landedId, session });
  const deps: EscapeRuntimeDeps = {
    getState: () => getShadowKernelExecutor().getState(),
    execute: (command) => {
      getShadowKernelExecutor().execute(command);
    },
    publish: (topic, payload) => publish(getSystemAddress(), topic, payload),
    ask: (id) => getWindowOsAdapter().getBackend().askRendererHandledEscape(id),
    track: (pending) => getWindowOsAdapter().trackExternalAsyncEffect(pending),
  };
  handleEscapePress({ landedId, session }, deps);
}

/**
 * The topmost content window: visible, able to take keystrokes, and carrying
 * a content role (`window-kernel.ts topmost(state, isContentWindow)`). THE
 * target window id for command / close / Esc / session-save focused
 * descriptor reads.
 *
 * `keyWindow` (`window-kernel.ts`) is NOT the replacement for the retired
 * `front` field this function used to return — key is nulled the moment the
 * app loses OS focus, and a satellite such as the shared chrome overlay can
 * hold it, so a naive `key` read silently answers with the wrong window.
 */
export function getTopmostContentWindowId(): WindowId | null {
  return topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id ?? null;
}

/**
 * Subscribe to changes in the overlay's read-back attachment relation
 * (`window-kernel.ts WindowRecord.overlayFor`, read here via the record
 * carrying `tracksBaseLayerTop`) — NOT the ordering query
 * (`topmostBaseLayerPageHost`) that used to drive `subscribeFrontChange`.
 * Which host the chrome frames is now a window decision made inside the
 * kernel (`react`'s `AttachOverlayTo` diff loop, realized through the port);
 * this subscription issues no command and decides nothing about windows — it
 * only paints (`hybrid-overlay.ts sendActiveHandoff`), so it is not a second
 * decider the way the deleted `retarget()` driver was.
 *
 * Finds the overlay by the declared `tracksBaseLayerTop` fact rather than by
 * a stored id because the overlay singleton can be re-minted
 * (`hybrid-overlay.ts ensureOverlay()`'s `'closed'` handler nulls the ids) —
 * a freshly-minted record carries the same declared fact, so this
 * subscription stays correct across a re-mint, where a captured id would go
 * stale.
 *
 * Fires with the new host id (or null) only when the relation actually
 * changes. Returns an unsubscribe function.
 */
export function subscribeOverlayAttachment(cb: (hostId: WindowId | null) => void): () => void {
  const read = (): WindowId | null => {
    const state = getShadowKernelExecutor().getState();
    return state.order.find((r) => r.tracksBaseLayerTop)?.overlayFor ?? null;
  };
  let last = read();
  return getShadowKernelExecutor().subscribe(() => {
    const now = read();
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

/**
 * Whether Peek is the active (frontmost) application, per the machine —
 * `AppWindowState.appActive`, fed by `electron-window-backend.ts
 * attachAppListeners` (`APP_ACTIVATED` / `APP_RESIGNED`). This is THE copy;
 * no module may keep its own `did-resign-active` mirror.
 */
export function getAppActive(): boolean {
  return getWindowOsAdapter().getOwner().snapshot().appActive;
}

/**
 * The machine's whole structural read-model in one read (`snapshot()`), for the
 * consumers that project MANY windows at once rather than asking about one —
 * session save's `serializeSession` is the first. Taking one snapshot also
 * makes such a pass internally consistent: every window it decides about is
 * read from the same instant, which a per-window accessor loop cannot promise.
 */
export function getWindowStateSnapshot(): StateSnapshot {
  return getWindowOsAdapter().getOwner().snapshot();
}

/**
 * Subscribe to app-active TRANSITIONS (the edge `hybrid-overlay.ts` used to get
 * from its own `app.on('did-resign-active'/'did-become-active')` pair). Same
 * shape as `subscribeFrontChange` above: layered over `getOwner().subscribe`,
 * edge-deduped so the callback fires only when the boolean actually flips, not
 * on every dispatch. Returns an unsubscribe function.
 */
export function subscribeAppActive(cb: (appActive: boolean) => void): () => void {
  let last = getAppActive();
  return getWindowOsAdapter().getOwner().subscribe((snap) => {
    const now = snap.appActive;
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

/**
 * The kernel record's current fullscreen mode name for `id`
 * (`window-kernel.ts WindowRecord.fsMode.name`), or null when `id` names no
 * live kernel record. Replaces the old adapter-backed `getWindowModeName`
 * (`window-os-adapter.ts` → `window-state.ts WindowStateOwner.getWindowMode`)
 * — this reads the kernel's own belief instead of a second copy. NOTE the
 * kernel's mid-transition names are `'entering'`/`'leaving'`, not the old
 * machine's `'entering-fullscreen'`/`'leaving-fullscreen'`; a caller matching
 * on the old strings needs updating, not just re-pointing.
 *
 * The old machine's settle-await sibling (`waitForMode`) has no wrapper here
 * — callers that need to await a settle call `window-kernel-executor.ts
 * WindowKernelExecutor.waitForSettledFsMode` directly (via
 * `getKernelExecutorForApp()`), since its bounded, three-outcome return needs
 * handling at the call site rather than behind a same-shape passthrough.
 */
export function getWindowModeName(id: WindowId): 'normal' | 'entering' | 'fullscreen' | 'leaving' | null {
  return getShadowKernelExecutor().getState().order.find((w) => w.id === id)?.fsMode.name ?? null;
}

/** The devtools fallback target: MRU http(s) window (replaces `getLastContentWindowId`). */
export function getDevtoolsTargetId(): WindowId | null {
  return getWindowOsAdapter().getOwner().getDevtoolsTargetId();
}

/**
 * The live reducer record for one window — READ-ONLY by contract (no copy;
 * `params` is deliberately the shared mutable bag legacy consumers write
 * into, see `WindowRecord.params`). This plus `listMachineWindowRecords` is
 * what the numeric-id registry seam in `main.ts` (`getWindowInfo` /
 * `findWindowByKey` / `getAllWindows` …) reads instead of the deleted
 * module-level `windowRegistry` Map (§4.1 dim 1a).
 */
export function getMachineWindowRecord(id: WindowId): WindowRecord | undefined {
  return getWindowOsAdapter().getOwner().getWindowRecord(id);
}

/** All live reducer records (fresh array; records not copied — read-only by contract). */
export function listMachineWindowRecords(): WindowRecord[] {
  return getWindowOsAdapter().getOwner().listWindowRecords();
}

/**
 * The first LIVE native window of a class (§4.3 dim 8b) — the lookup that
 * replaced the per-module window singletons (`core-glue.ts
 * coreBackgroundWindow` → class 'background', `test-fixture-glue.ts
 * testFixtureWindow` → class 'test-fixture', …). Null when none is
 * registered or the native window is gone.
 */
export function getNativeWindowByClass(cls: WindowClass): BaseWindow | BrowserWindow | null {
  for (const rec of getShadowKernelExecutor().getState().order) {
    if (rec.class !== cls) continue;
    const native = getNativeWindowFor(rec.id);
    if (native) return native;
  }
  return null;
}

/**
 * Test-bridge support (E2E only): resolve once the adapter's in-flight async
 * effects — the `escape-pressed` renderer ask and any delegated
 * `closeOrHideWindow` — have settled. Lets `hybrid-overlay.ts runHybridEscape`
 * await the ESC round trip deterministically instead of polling on a deadline
 * re-derived from the ask timeout. Nothing in the app may gate behavior on it.
 */
export async function waitForPendingWindowEffects(): Promise<void> {
  // BOTH executors, because the responsibilities are split by rule and neither
  // side sees the other's in-flight work: the adapter still runs the Escape
  // renderer ask and the two switcher arms, while every window operation now
  // settles inside the kernel executor. Awaiting one alone would report the ESC
  // round trip settled while the close it provoked was still in flight.
  await Promise.all([
    getWindowOsAdapter().waitForPendingAsyncEffects(),
    getKernelExecutorForApp().waitForPendingAsyncEffects(),
  ]);
}

/**
 * Resolve once the guest teardown requested by the last
 * `GUEST_TEARDOWN_REQUESTED` has settled. Unlike
 * `waitForPendingWindowEffects` above this IS production sequencing: the
 * before-quit handler awaits it so Electron's quit cannot close host windows
 * over guests that are still alive. Bounded inside the backend.
 */
export function waitForGuestTeardown(): Promise<void> {
  // The kernel executor owns this from the cutover on: its `DestroyAllGuests`
  // arm is what now issues `destroyAllContentGuests()` and stores the promise.
  // The adapter's copy would resolve immediately — its arm no longer runs — and
  // the quit would stop waiting for guests, visibly only on a real quit.
  return getKernelExecutorForApp().waitForGuestTeardown();
}

/** Test-only: reset the singleton (drops the adapter + its owner state). */
export function _resetWindowStateSingletonForTests(): void {
  adapter = null;
  sessionSeeded = false;
}
