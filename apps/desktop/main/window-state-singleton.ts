/**
 * window-state-singleton.ts — the ONE live `WindowOsAdapter` for the desktop
 * app, plus the thin read/dispatch surface the seam consumers use.
 *
 * Blueprint: `docs/design/window-manager.md`. `window-state.ts` is
 * the pure reducer, `window-os-adapter.ts` is the OS-boundary adapter; THIS
 * module holds the single adapter instance and exposes the machine to the rest
 * of main (ipc.ts / tile-ipc.ts / windows.ts / main.ts / hybrid-overlay.ts /
 * tile-launcher.ts). It replaces the deleted scattered authorities:
 *   - `getFrontWindowId()`      ← ipc.ts `getLastFocusedVisibleWindowId`
 *   - `getFrontPageHostId()`    ← registry `getActiveHybridWindowId`
 *   - `subscribeFrontChange()`  ← registry `onActiveHybridWindowChange`
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
import { getIzuiCoordinator } from './izui-state.js';
import type { WindowEvent, FsMode, Rectangle, IzuiSession, WindowId, WindowKind, WindowClass, WindowRecord, EscapeMode, StateSnapshot } from './window-state.js';
import { shadowKernelRegisterWindow } from './window-kernel-shadow.js';

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
export function getWindowOsAdapter(): WindowOsAdapter {
  if (!adapter) adapter = new WindowOsAdapter();
  return adapter;
}

/**
 * Boot wiring (call ONCE from main.ts after the coordinator exists): attach the
 * adapter's app-level `did-become/resign-active` listeners and seed the session
 * mirror. Idempotent.
 */
export function initWindowStateMachine(): void {
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
    const front = getFrontWindowId();
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
  // Shadow-feed the kernel (window-kernel-shadow.ts) — additive, authoritative
  // over nothing; see that module's doc for why this can never change what
  // actually happens on screen.
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
  }, getWindowOsAdapter().getOwner().snapshot());
  // The divergence comparator now runs INSIDE `shadowKernelRegisterWindow`
  // itself (`window-kernel-shadow.ts`), against the old machine's
  // just-settled snapshot passed in above — see that module's
  // `compareAfterFeed` for why every feed helper takes its own snapshot
  // rather than reading `window-state-singleton.ts` back.
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

/** THE target window id (command / close / Esc / session-save focused descriptor). */
export function getFrontWindowId(): WindowId | null {
  return getWindowOsAdapter().getOwner().getFrontWindowId();
}

/**
 * The front window iff its record is a page-host, else null (replaces
 * `getActiveHybridWindowId`): "the frontmost hybrid page host the shared chrome
 * overlay frames itself over".
 */
export function getFrontPageHostId(): WindowId | null {
  const owner = getWindowOsAdapter().getOwner();
  const front = owner.getFrontWindowId();
  if (front == null) return null;
  const rec = owner.snapshot().windows.find((w) => w.id === front);
  return rec && rec.kind === 'page-host' ? front : null;
}

/**
 * Subscribe to changes in the front page-host (replaces
 * `onActiveHybridWindowChange`). Fires with the new front page-host id (or null)
 * only when it actually changes. Returns an unsubscribe function.
 */
export function subscribeFrontChange(cb: (frontPageHostId: WindowId | null) => void): () => void {
  let last = getFrontPageHostId();
  return getWindowOsAdapter().getOwner().subscribe(() => {
    const now = getFrontPageHostId();
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

/** Resolve when window `id` reaches fullscreen `mode` (the settle-await seam). */
export function waitForMode(id: WindowId, mode: FsMode['name']): Promise<void> {
  return getWindowOsAdapter().getOwner().waitForMode(id, mode);
}

/** The current fullscreen mode name for `id`, or null if unregistered. */
export function getWindowModeName(id: WindowId): FsMode['name'] | null {
  return getWindowOsAdapter().getOwner().getWindowMode(id);
}

/** The pre-fullscreen bounds stash for `id` (replaces `preFullScreenBounds`). */
export function getWindowPreBounds(id: WindowId): Rectangle | null {
  return getWindowOsAdapter().getOwner().getWindowPreBounds(id);
}

/** The devtools fallback target: MRU http(s) window (replaces `getLastContentWindowId`). */
export function getDevtoolsTargetId(): WindowId | null {
  return getWindowOsAdapter().getOwner().getDevtoolsTargetId();
}

/** A window's MRU focus rank (replaces `focus-order.ts` `getFocusOrder`). 0 if unknown. */
export function getFocusOrder(id: WindowId): number {
  return getWindowOsAdapter().getOwner().getWindowFocusSeq(id);
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
  const owner = getWindowOsAdapter().getOwner();
  for (const rec of owner.listWindowRecords()) {
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
export function waitForPendingWindowEffects(): Promise<void> {
  return getWindowOsAdapter().waitForPendingAsyncEffects();
}

/**
 * Resolve once the guest teardown requested by the last
 * `GUEST_TEARDOWN_REQUESTED` has settled. Unlike
 * `waitForPendingWindowEffects` above this IS production sequencing: the
 * before-quit handler awaits it so Electron's quit cannot close host windows
 * over guests that are still alive. Bounded inside the backend.
 */
export function waitForGuestTeardown(): Promise<void> {
  return getWindowOsAdapter().waitForGuestTeardown();
}

/** Test-only: reset the singleton (drops the adapter + its owner state). */
export function _resetWindowStateSingletonForTests(): void {
  adapter = null;
  sessionSeeded = false;
}
