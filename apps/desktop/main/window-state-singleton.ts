/**
 * window-state-singleton.ts — the ONE live `ElectronWindowBackend` for the
 * desktop app, plus the thin read/dispatch surface the seam consumers use.
 *
 * Blueprint: `docs/design/window-manager.md`. The kernel triple
 * (`window-kernel.ts` + `window-kernel-executor.ts`, fed via
 * `window-kernel-shadow.ts`) is the only window machine now; THIS module holds
 * the single backend instance and exposes it to the rest of main (ipc.ts /
 * tile-ipc.ts / windows.ts / main.ts / hybrid-overlay.ts / tile-launcher.ts).
 *
 * The backend is constructed lazily on first access and made live (native app
 * listeners attached + session mirror seeded) once from `main.ts` at boot via
 * `initWindowStateMachine()`.
 */

import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { ElectronWindowBackend, type RegisterWindowSpec } from './electron-window-backend.js';
import { getKernelExecutor } from './window-kernel-singleton.js';
import type { WindowKernelExecutor } from './window-kernel-executor.js';
import { getIzuiCoordinator } from './izui-state.js';
import type { EscapeSession } from './window-escape.js';
import type { EscapeMode } from './window-backend.js';
import type { Rectangle, WindowId, WindowKind, WindowRecord as KernelWindowRecord } from './window-kernel.js';
import type { WindowClass } from './izui-roles.js';
import {
  setKernelExecutorProvider,
  shadowKernelRegisterWindow,
  shadowKernelWindowShown,
  getShadowKernelExecutor,
} from './window-kernel-shadow.js';
import { topmost, isContentWindow, windowById } from './window-kernel.js';
import { handleEscapePress, type EscapeRuntimeDeps } from './window-escape-runtime.js';
import { publish, getSystemAddress } from './pubsub.js';
import { wmLog } from './window-diag.js';
import { setWindowOpenPayload } from './window-open-registry.js';

/** Register-spec that accepts real Electron window handles (both kinds satisfy the backend's structural `NativeWindow`). */
export interface MachineWindowSpec {
  kind: WindowKind;
  role: string;
  /** Window class (§4.3 dim 8b) — required; ordinary opens use `classifyWindowRegistration`, the infrastructure classes declare theirs. */
  class: WindowClass;
  satellite: boolean;
  escapeMode?: EscapeMode;
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
   * Opt OUT of the backend-owned `before-input-event` Esc interceptor (browser
   * windows only, default on). See `RegisterWindowSpec.attachEscHandler` — the
   * shared chrome overlay is the one caller that passes false.
   */
  attachEscHandler?: boolean;
  /**
   * The kernel's three orthogonal per-window fields (`izui-roles.ts
   * WindowSurfaceProperties`, `deriveWindowSurface`). Required so every
   * registration site declares them explicitly.
   */
  layer: number;
  /** See `layer` above. */
  canBecomeKey: boolean;
  /** See `layer` above. */
  acceptsInput: boolean;
}

let backend: ElectronWindowBackend | null = null;
let sessionSeeded = false;

/** The single OS-boundary backend. Constructed on first use. */
function getWindowBackend(): ElectronWindowBackend {
  if (!backend) backend = new ElectronWindowBackend();
  return backend;
}

/**
 * The single production `WindowKernelExecutor`, built over the single backend
 * above — every window operation goes through this one backend instance, so
 * kernel ids and the ids `getWindowIdFor`/`getNativeWindowFor` resolve are the
 * same ids.
 */
export function getKernelExecutorForApp(): WindowKernelExecutor {
  return getKernelExecutor(getWindowBackend());
}

/**
 * Boot wiring (call ONCE from main.ts after the coordinator exists): install
 * the kernel executor provider, attach the backend's app-level
 * `did-become/resign-active` listeners, and seed the session mirror.
 * Idempotent.
 */
export function initWindowStateMachine(): void {
  // INJECTION, NOT IMPORT: the provider is a lazy thunk because
  // `window-kernel-shadow.ts` must not value-import this module — see that
  // file's executor-provider banner for the cycle and the
  // `ELECTRON_RUN_AS_NODE=1` reasons.
  setKernelExecutorProvider(() => getKernelExecutorForApp());
  getWindowBackend().attachAppListeners();
  seedSessionMirror();
}

/**
 * Front-id provider for the coordinator's switcher focus-restore seed
 * (`enterOverlay` → `preOverlayFocusTarget`). The kernel models no session, so
 * this is the ONLY half of the old session mirror that survives — the
 * coordinator's own session state is read straight off `getIzuiCoordinator()`
 * wherever a caller needs it (`dispatchEscapePress` below, `clampSession`).
 */
function seedSessionMirror(): void {
  if (sessionSeeded) return;
  sessionSeeded = true;
  const coord = getIzuiCoordinator();
  coord.setFrontWindowIdProvider(() => {
    const front = getTopmostContentWindowId();
    if (front == null) return null;
    const native = getNativeWindowFor(front);
    return native ? native.id : null;
  });
}

/**
 * Clamp the coordinator's four-state (idle/transient/active/overlay) to the
 * Escape decider's tri-state. `overlay` is a transient-over-active state, and
 * `decideEscape` step 1 intercepts the overlay-open ESC before step 6 ever
 * reads the session — so mirroring it as `active` is behavior-neutral.
 */
function clampSession(state: string): EscapeSession {
  return state === 'overlay' ? 'active' : (state as EscapeSession);
}

/**
 * Register a window (both kinds) with the kernel + attach its native
 * listeners. Returns the WM-minted `WindowId` for this window (stable across
 * duplicate registrations of the same native window).
 */
export function registerWindowWithMachine(spec: MachineWindowSpec): WindowId {
  // Both BaseWindow and BrowserWindow satisfy the backend's structural
  // `NativeWindow`; the electron typed-overload `on` isn't assignable to the
  // loose `on` shape, so bridge with a single cast here (not at every call site).
  const { id, decision, initialBounds } = getWindowBackend().registerWindow(spec as unknown as RegisterWindowSpec);
  // The registry payload rides the registration spec when the caller has it
  // (ipc.ts's window-open handler, for both hybrid and browser opens) — see
  // `window-open-registry.ts` for why this lives outside the machine record.
  if (spec.source !== undefined && spec.params !== undefined) {
    setWindowOpenPayload(id, spec.source, spec.params);
  }
  // The backend's own registration decision (`izui-roles.ts
  // decideWindowRegistration`) says whether THIS registration attaches the
  // per-window Esc interceptor — the backend performs the merge/listener
  // half, this is the dispatch/port-command half, same split the old adapter
  // kept.
  if (decision.attachEscHandler) {
    getWindowBackend().attachEscHandler(id);
  }
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
    ...(initialBounds !== null ? { bounds: initialBounds } : {}),
    ...(spec.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: spec.tracksBaseLayerTop } : {}),
    ...(spec.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: spec.selfClosesOnBlur } : {}),
  });
  // `decision.pumpShownEvent` IS the ctor-shown fact (`izui-roles.ts
  // WindowRegistrationDecision.pumpShownEvent`'s doc): the native window was
  // already visible at registration time, which never fires a native 'show'
  // transition — this import is the only report the kernel ever gets of it.
  if (decision.pumpShownEvent) {
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
 * `getNativeWindowFor` below); it delegates to the backend's private maps. No
 * other module may keep its own WindowId↔Electron-id mapping.
 */
export function getWindowIdFor(win: BaseWindow | BrowserWindow | number): WindowId | null {
  // Same structural-`NativeWindow` bridge cast as `registerWindowWithMachine`.
  return getWindowBackend().getWindowIdFor(win as unknown as RegisterWindowSpec['win'] | number);
}

/**
 * The live native window handle for a WM `WindowId`, or `null` when
 * unregistered/destroyed. Legacy consumers use this to join a machine id back
 * onto the Electron-keyed registries they still run on (a later migration step
 * re-keys those registries and deletes the need).
 */
export function getNativeWindowFor(id: WindowId): BaseWindow | BrowserWindow | null {
  return getWindowBackend().getNativeWindowFor(id) as unknown as BaseWindow | BrowserWindow | null;
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
 * `session` is read here, not carried by the caller: `decideEscape` reads
 * `state.session` directly — so this wrapper is the direct replacement for
 * that read, against the same clamped session `seedSessionMirror` keeps live.
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
    ask: (id) => getWindowBackend().askRendererHandledEscape(id),
    track: (pending) => getKernelExecutorForApp().trackExternalAsyncEffect(pending),
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
 * Whether Peek is the active (frontmost) application, per the kernel —
 * `State.appActive`, fed by `electron-window-backend.ts attachAppListeners`
 * (`APP_ACTIVATED` / `APP_RESIGNED`). This is THE copy; no module may keep
 * its own `did-resign-active` mirror.
 */
export function getAppActive(): boolean {
  return getShadowKernelExecutor().getState().appActive;
}

/**
 * Subscribe to app-active TRANSITIONS (the edge `hybrid-overlay.ts` used to get
 * from its own `app.on('did-resign-active'/'did-become-active')` pair). Same
 * shape as `subscribeOverlayAttachment` above: layered over the kernel's own
 * `subscribe`, edge-deduped so the callback fires only when the boolean
 * actually flips, not on every dispatch. Returns an unsubscribe function.
 *
 * ORDERING: like `subscribeOverlayAttachment`, this binds to whichever
 * executor `getShadowKernelExecutor()` answers with AT CALL TIME, and
 * `initWindowStateMachine()` above is what points that accessor at
 * `getKernelExecutorForApp()`. Calling this first would bind the callback to
 * the pre-cutover noop-backed fallback, which nothing production ever drives
 * again. That is not a silent hazard: `window-kernel-shadow.ts
 * setKernelExecutorProvider` throws when it finds a listener already on the
 * fallback, so the wrong order fails at startup. Boot satisfies it because
 * `entry.ts` awaits `main.ts initialize()` (→ `initWindowStateMachine()`)
 * before calling `initHybridOverlay()`, the only caller.
 */
export function subscribeAppActive(cb: (appActive: boolean) => void): () => void {
  let last = getAppActive();
  return getShadowKernelExecutor().subscribe((state) => {
    const now = state.appActive;
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

/**
 * The kernel record's current fullscreen mode name for `id`
 * (`window-kernel.ts WindowRecord.fsMode.name`), or null when `id` names no
 * live kernel record. NOTE the kernel's mid-transition names are
 * `'entering'`/`'leaving'`, not the old machine's
 * `'entering-fullscreen'`/`'leaving-fullscreen'`; a caller matching on the old
 * strings needs updating, not just re-pointing.
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

/**
 * The live kernel record for one window — READ-ONLY by contract (no copy).
 * `main.ts`'s numeric-id registry seam (`getWindowInfo` / `findWindowByKey` /
 * `getAllWindows` …) no longer reads `source`/`params` off this record — that
 * pair moved to `window-open-registry.ts` — but existence checks (e.g.
 * `removeWindow`) still read this.
 */
export function getMachineWindowRecord(id: WindowId): KernelWindowRecord | undefined {
  return windowById(getShadowKernelExecutor().getState(), id) ?? undefined;
}

/** All live kernel records — `State.order` itself (bottom -> top, not copied — read-only by contract). */
export function listMachineWindowRecords(): readonly KernelWindowRecord[] {
  return getShadowKernelExecutor().getState().order;
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
 * Test-bridge support (E2E only): resolve once the kernel executor's in-flight
 * async effects — the `escape-pressed` renderer ask and any delegated
 * `closeOrHideWindow` — have settled. Lets `hybrid-overlay.ts runHybridEscape`
 * await the ESC round trip deterministically instead of polling on a deadline
 * re-derived from the ask timeout. Nothing in the app may gate behavior on it.
 */
export async function waitForPendingWindowEffects(): Promise<void> {
  await getKernelExecutorForApp().waitForPendingAsyncEffects();
}

/**
 * Resolve once the guest teardown requested by the last
 * `GUEST_TEARDOWN_REQUESTED` has settled. Unlike
 * `waitForPendingWindowEffects` above this IS production sequencing: the
 * before-quit handler awaits it so Electron's quit cannot close host windows
 * over guests that are still alive. Bounded inside the backend.
 */
export function waitForGuestTeardown(): Promise<void> {
  return getKernelExecutorForApp().waitForGuestTeardown();
}

/** Test-only: reset the singleton (drops the backend + its state). */
export function _resetWindowStateSingletonForTests(): void {
  backend = null;
  sessionSeeded = false;
}
