/**
 * electron-window-backend.ts — the Electron implementation of the
 * `WindowBackend` port (design §3, rule R3).
 *
 * Blueprint: `docs/design/window-manager.md`. THIS IS THE ONLY WINDOW-MANAGER
 * MODULE THAT IMPORTS ELECTRON. The executor (`window-os-adapter.ts`) issues
 * port commands; this backend performs them against the native handles it
 * retains, and pushes native reality back as machine events
 * (`window-state.ts WindowEvent`) through the single `BackendEventSink`
 * injected at construction. It never dispatches into the reducer itself —
 * the executor stays the one dispatch owner.
 *
 * It is also the sole authority on window identity (§3): `registerWindow`
 * mints every `WindowId` ("wm-N", idempotent per native window), and the
 * private `idByOsWindowId` map is the only `WindowId` ↔ Electron translation
 * in the tree. The platform's numeric id space never crosses this file's
 * surface except through the comment-annotated migration shims below.
 *
 * Two OS/Chromium boundary workarounds live here (and NOWHERE else — the
 * reducer has no timers, and the executor no longer touches the boundary),
 * each commented at its site:
 *   - the ONE deferred-blur settle that emits `OS_FOCUS_SETTLED_NULL` (§4.4);
 *   - the bounded fullscreen settle timer that emits `FULLSCREEN_SETTLE_TIMEOUT`
 *     (§2.3) so a stuck `entering`/`leaving` mode self-corrects via `reconcile`.
 *
 * Headless gating: focus/activation side effects are gated on `isHeadless()` —
 * the SAME predicate `hybridShowIntent` (windows.ts) encodes — so an agent/CI
 * run never steals the user's OS focus (peek 2b55f3af). Since §5 step 6A-2
 * the SHOW policy itself (opacity-0-before-show, show() vs showInactive(),
 * the page-host headless/panel masks) lives HERE (`performOsShow` +
 * `showWindow`): the windows.ts show seams are thin dispatchers into the
 * machine, and this backend echoes `WINDOW_SHOWN` for the shows it performs
 * (`showInactive` emits no native `'show'` event, and headless runs take no
 * real OS focus by design). That echo carries the caller's UNMASKED activation
 * intent (`WINDOW_SHOWN {focused: activate}`), and the reducer routes a focused
 * `WINDOW_SHOWN` through the same `applyFocusGained` an `OS_FOCUS_GAINED` uses
 * — so `front` and `focusSeq` still move under headless without anyone
 * synthesizing a focus event.
 *
 * NEITHER `showWindow` NOR `raiseWindow` ever emits `OS_FOCUS_GAINED` for a
 * show it performed. That event means "the OS moved focus", and it is the ONLY
 * event that runs the transient-autoclose sweep (`window-state.ts
 * selectTransientAutoclose`) and `applyOsFocusRealized`. Emitting it for a show
 * this backend drove would feed the machine's own decision back in as fresh OS
 * evidence, and would sweep a live palette/quick-view out from under a show
 * that never meant to touch it — a headless show that arrives late enough
 * dismisses a palette opened AFTER the show was requested. `OS_FOCUS_GAINED`
 * has exactly two producers here, both genuine native reports: the host
 * window's `'focus'` and the page-host content WC's `'focus'`.
 *
 * Those two producers are also the sole source of focus PROVENANCE (peek
 * 7fffa286): a native focus report cannot say whether the user switched windows
 * or the OS is echoing a call this backend just made, but the backend itself
 * knows — so it arms `pendingSelfCausedFocus` before every focus-moving native
 * call and stamps the resulting event `cause: { kind: 'machine', opSeq }`.
 * Anything arriving unarmed is `world`. That per-window arming is executor
 * state, deliberately: the reducer may keep no such thing (it used to infer the
 * fact from record history and got the machine's own handoff-raise echo wrong).
 */

import { app, globalShortcut, screen, systemPreferences, webContents } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';

import { isHeadless, DEBUG } from './config.js';
import {
  askWebContentsToHandleEscape,
  closeOrHideWindow,
  addEscHandler,
} from './windows.js';
import { getGuestsForWindow, getAllGuestWebContentsIds } from './webview-guest-registry.js';
import { getIzuiCoordinator } from './izui-state.js';
import { shouldCloseContentWCOnFinalize, type WindowClass, type StackingLevel } from './izui-roles.js';
import {
  decideWindowRegistration,
  type WindowRegistrationDecision,
  type FocusCause,
  type WindowId,
  type WindowKind,
  type Rectangle,
  type StateSnapshot,
} from './window-state.js';
import type { BackendEventSink, WindowBackend, WindowSpec } from './window-backend.js';
import {
  destroyGuestsAndWait,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';
import { expandToOverlayFrame } from './overlay-frame.js';
import { FULLSCREEN_SETTLE_TIMEOUT_MS } from './window-kernel.js';
import {
  shadowKernelOsFocusGained,
  shadowKernelOsFocusSettled,
  shadowKernelWindowClosed,
  shadowKernelWindowShown,
  shadowKernelWindowHidden,
  shadowKernelAppActivated,
  shadowKernelAppResigned,
  shadowKernelAppResignSettled,
} from './window-kernel-shadow.js';

/**
 * The one place `webContents.destroy()` is actually called. `guest-teardown.ts`
 * owns the bounded WAIT and stays platform-free by taking this as a callback,
 * which also keeps the destroy inside the backend (rule R2).
 *
 * Forceful (immediate, skips beforeunload) is what both callers want — the
 * guarantee is "the guest is gone", not "the guest was asked nicely".
 * `destroy()` exists at runtime but isn't in the Electron type defs.
 */
function requestGuestDestroy(guest: TeardownGuest): void {
  (guest as unknown as { destroy(): void }).destroy();
}

// Bounded wait for the native fullscreen transition to settle, matching the
// pre-machine owner (`hybrid-page-host-registry.ts HYBRID_FULLSCREEN_SETTLE_TIMEOUT_MS`).
// The AppKit enter/leave-fullscreen animation runs ~600ms; this leaves margin so
// a destroyed / no-op window (which never emits the settled event) can't strand
// the machine in `entering`/`leaving` forever — the timer emits
// FULLSCREEN_SETTLE_TIMEOUT, whose reducer clause emits RECONCILE_FULLSCREEN.
// The bound itself lives in `window-kernel.ts FULLSCREEN_SETTLE_TIMEOUT_MS`
// (electron-free, shared with the kernel executor) since this file cannot be
// imported for its values without pulling `electron` into the executor.

/**
 * How long after a `did-resign-active` we declare the app switch REAL
 * (`APP_RESIGN_SETTLED`). Same 500ms the deleted `ipc.ts
 * HYBRID_APP_RESIGN_SETTLE_MS` used.
 *
 * macOS fires a brief `did-resign-active` → `did-become-active` DANCE (no real
 * app switch) during window restoration at startup and around overlay /
 * activation transitions, and there is NO deterministic OS signal for "the
 * dance is over" — the only in-process alternative, the deferred-blur settle
 * that emits `OS_FOCUS_SETTLED_NULL`, fires within a tick and so lands INSIDE
 * the dance. A settle interval is therefore irreducible, and per §3 it belongs
 * at the OS boundary (this file), alongside the other two boundary
 * workarounds. What is NOT here is the DECISION: the reducer's
 * `pendingAppResignSweep` (armed by `APP_RESIGNED`, disarmed by
 * `APP_ACTIVATED`) is the sole cancel authority, so this timer only says
 * "500ms elapsed", never "sweep".
 */
const APP_RESIGN_SETTLE_MS = 500;

/**
 * The structural minimum of a native window this backend drives. Both
 * `BaseWindow` (page-host) and `BrowserWindow` (browser) satisfy it — a
 * BaseWindow is NOT a BrowserWindow (no root `.webContents`), so we keep the
 * per-kind divergence (content WC, raise seam) explicit rather than casting one
 * to the other. Every method here exists on BOTH kinds in Electron 40.
 */
export interface NativeWindow {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  close(): void;
  destroy(): void;
  hide(): void;
  /** Show, activating (app frontmost + key window). */
  show(): void;
  /** Show without activating (focus-preserving). */
  showInactive(): void;
  /** Window opacity — the headless opacity-0-before-show trick (`performOsShow`). */
  setOpacity(opacity: number): void;
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating'): void;
  /** Relative z-raise without activation (the `setStacking` command). On both kinds in Electron 40. */
  moveTop(): void;
  /** Outer-bounds write (the `setWindowBounds` command — §5 step 7). On both kinds in Electron 40. */
  setBounds(bounds: Rectangle): void;
  /**
   * macOS Spaces pin (the `setVisibleOnAllSpaces` command — §5 step 10).
   * On both kinds in Electron 40; a no-op off darwin, which is why the
   * backend guards the platform before calling it at all.
   */
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
  /**
   * Outer-bounds read — used ONLY inside the resize/move listeners to build
   * the `BOUNDS_CHANGED` emission (§2.5's sanctioned pattern: the backend
   * reads reality once, internally, and pushes it as an event; nothing else
   * may read it).
   */
  getBounds(): Rectangle;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The structural minimum of the renderer WebContents this backend drives
 * (same proto-abstraction move as `NativeWindow`, so `RegisterWindowSpec`
 * carries no Electron type). Cast back to the real `WebContents` only at the
 * windows.ts seam calls inside this file.
 */
export interface NativeWebContents {
  isDestroyed(): boolean;
  focus(): void;
  close(): void;
  getURL(): string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * A post-hoc registration spec: the platform-neutral `WindowSpec` plus the
 * native handles of a window that already exists. Input to the
 * `registerWindow` migration shim below — the eventual `create(spec)` port
 * command (§5 step 4) replaces the handle-carrying half.
 */
export interface RegisterWindowSpec extends WindowSpec {
  /** The native window handle (BaseWindow for page-host, BrowserWindow for browser). */
  win: NativeWindow;
  /**
   * The renderer WebContents: the content view's WC for a page-host, the root
   * WC for a browser. Used for `ASK_RENDERER` and (page-host only) `FOCUS_CONTENT`.
   */
  contentWC?: NativeWebContents | null;
}

/** What `registerWindow` hands back to the executor: the (minted or existing) id plus the registration decision whose pump/esc-attach halves the EXECUTOR performs. */
export interface BackendRegistration {
  id: WindowId;
  decision: WindowRegistrationDecision;
  /**
   * The window's outer bounds, read ONCE at registration (§5 step 7B) — the
   * executor carries it on the pumped `WINDOW_REGISTERED` to seed the
   * reducer's bounds mirror (a ctor-placed window fires no native
   * resize/move, so `BOUNDS_CHANGED` alone leaves the mirror empty until the
   * first gesture). `null` when the read failed (window destroyed mid-call).
   */
  initialBounds: Rectangle | null;
}

/**
 * MIGRATION SHIMS — the handle-speaking surface that exists only until later
 * migration steps absorb its callers. Deliberately OUTSIDE `WindowBackend`:
 * no port method may accept or return a platform handle (§3), so the executor
 * types its backend as `WindowBackend & BackendMigrationShims` and the
 * intersection is exactly what future steps delete.
 *
 *   - `registerWindow` (post-hoc join of an already-created native window):
 *     absorbed when window CREATION moves behind the port — §5 step 4
 *     (special window classes + registry unification) introduces
 *     `create(spec)` and retires handle-carrying registration. Callers today:
 *     `window-state-singleton.ts registerWindowWithMachine` (ipc.ts /
 *     tile-launcher / hybrid-overlay open sites).
 *   - `getWindowIdFor` / `getNativeWindowFor` (the numeric-id ↔ handle seam):
 *     absorbed when the renderer-facing id economy flips to `WindowId` — the
 *     session/context-store step (§5 step 11, per the §3 scope decision) —
 *     and the legacy Electron-keyed registries they join against are re-keyed
 *     (§5 steps 4–8). Callers today: `window-state-singleton.ts` only.
 */
export interface BackendMigrationShims {
  registerWindow(spec: RegisterWindowSpec): BackendRegistration;
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null;
  getNativeWindowFor(id: WindowId): NativeWindow | null;
}

/** What the backend retains per registered window to execute commands against it. */
interface BackendWindow {
  win: NativeWindow;
  kind: WindowKind;
  /**
   * The window's declared class (§4.3 dim 8b), retained for the show policy:
   * a `quick-view`-class page-host is a `type:'panel'` NSPanel that must
   * NEVER activate the app on show (regression 524f7aba) — see `showWindow`.
   */
  windowClass: WindowClass;
  /**
   * The renderer WebContents that answers the `escape-pressed` IPC and is the
   * macOS first responder: the content `WebContentsView`'s WC for a page-host,
   * the root WC for a browser window. `null` if the caller supplied none.
   */
  rendererWC: NativeWebContents | null;
}

/**
 * The Electron backend. Holds native handles + the WindowId mint, performs
 * port commands, translates native events into machine events via `emit`.
 */
export class ElectronWindowBackend implements WindowBackend, BackendMigrationShims {
  /** The single event channel into the executor's dispatch pump. */
  private readonly emit: BackendEventSink;

  /**
   * Read-only channel back to the executor's owner: the old machine's
   * snapshot, taken fresh on each call — used ONLY to feed the shadow
   * kernel's divergence comparator (`window-kernel-shadow.ts
   * compareShadowKernelState`) right after a native listener's `emit` call
   * settles this machine. See `window-os-adapter.ts`'s constructor doc for
   * why this is injected rather than read via `window-state-singleton.ts`.
   */
  private readonly getSnapshot: () => StateSnapshot;

  /** Native handles + renderer WC per registered WM WindowId (for command execution). */
  private readonly windows = new Map<WindowId, BackendWindow>();

  /**
   * Reverse lookup: platform (Electron) window id → WM WindowId. PRIVATE — the
   * platform's numeric ids exist only inside this file's maps and never cross
   * its surface (design §3: the backend maps `WindowId -> platform handle`
   * internally and never leaks the handle's id space).
   */
  private readonly idByOsWindowId = new Map<number, WindowId>();

  /** WM-internal mint counter for `WindowId` ("wm-1", "wm-2", …). */
  private windowIdCounter = 0;

  /** The ONE deferred-blur settle handle (§4.4) — coalesced, at most one pending. */
  private pendingBlurSettle: ReturnType<typeof setImmediate> | null = null;

  /**
   * "I am expecting a self-caused focus on this window, from op N" — the op
   * token (`window-state.ts Effect.opSeq`) of the last focus-family command this
   * backend performed on each window, still awaiting its native `'focus'`.
   *
   * This is the ONLY honest source of focus provenance (`FocusCause`), and it
   * belongs HERE: the executor knows which native call it just made; the reducer
   * cannot know and must not guess (it used to guess, from a pair of per-record
   * booleans, and got the machine's own handoff-raise echo wrong — peek
   * 7fffa286). State in the backend, never in the reducer.
   *
   * Lifecycle, all three edges deliberate:
   *   - ARMED by `armSelfCausedFocus`, immediately before a native call that can
   *     move OS focus (an ACTIVATING show, a raise, a content focus). A second
   *     op on the same window overwrites the token — the latest op is the one
   *     whose echo is in flight, and an older token surviving would label that
   *     echo stale.
   *   - CONSUMED (one shot) by `takeFocusCause` in the `'focus'` listeners.
   *   - DROPPED on the window's own `blur` and `closed`: focus went somewhere
   *     else, so whatever arrives next is a NEW event and not our echo. Without
   *     this a never-echoed arming (a `focus()` on a window that already held
   *     first responder emits no event) would sit there and mislabel the user's
   *     next genuine focus as machine-caused — the exact failure mode that makes
   *     a token safer than a bare boolean.
   */
  private readonly pendingSelfCausedFocus = new Map<WindowId, number>();

  /** Per-window bounded fullscreen settle timers (§2.3). */
  private readonly fullscreenSettleTimers = new Map<WindowId, ReturnType<typeof setTimeout>>();

  /** The app-resign settle handle (§5 step 9) — at most one, restarted per resign edge. */
  private appResignSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether we currently hold the OS Escape grab (real state incl. failed register — see `setEscGrab`). */
  private escGrabRegistered = false;

  /** Stable handler reference so register/unregister target the same closure. */
  private readonly escGrabHandler = (): void => {
    // The grab fires the SAME `ESC_PRESSED` the before-input-event path does —
    // `decideEscape` is the single decision, so a stale grab is harmless
    // (defense by shared decision, not by registration timing, §4.2).
    //
    // No `rendererHandled` fact to read here (window-escape-renderer-handled.ts
    // / peek 7fffa286 companion): `globalShortcut` firing at all means
    // `before-input-event` did NOT — no window's WebContents ever saw this
    // keystroke, so no renderer could have consumed it. Absent is the
    // structurally correct answer at this ONE of the four dispatch sites, not
    // a gap in the producer.
    this.emit({ type: 'ESC_PRESSED', landedId: 'global' });
  };

  constructor(emit: BackendEventSink, getSnapshot: () => StateSnapshot) {
    this.emit = emit;
    this.getSnapshot = getSnapshot;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Port: app-level listeners.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * App-level focus listeners → `APP_ACTIVATED`/`APP_RESIGNED`, plus the
   * `APP_RESIGN_SETTLED` edge the transient app-switch sweep runs on (§5 step
   * 9). `APP_ACTIVATED` makes the reducer emit `RECONCILE_FULLSCREEN` for any
   * in-flight transition (§2.5).
   *
   * The settle timer is restarted on every resign edge (so only the LATEST
   * resign can settle) and is deliberately NOT cancelled on `did-become-active`:
   * cancelling would put a second copy of the dance-cancel decision here, and
   * the reducer's `pendingAppResignSweep` disarm already makes a late
   * `APP_RESIGN_SETTLED` inert.
   *
   * Also the macOS Space-change subscription → `SPACE_CHANGED` (§4.2 dim 7c,
   * §5 step 10): the workspace notification is the only signal that the user
   * moved to another Space. Like the two `app` listeners it is attached once
   * at boot and never removed — the app-level listener set lives as long as
   * the process.
   */
  attachAppListeners(): void {
    (app as unknown as { on(e: string, l: () => void): void }).on('did-become-active', () => {
      this.emit({ type: 'APP_ACTIVATED' });
      // Shadow-feed the kernel (window-kernel-shadow.ts) — additive,
      // authoritative over nothing; see that module's doc for why this can
      // never change what actually happens on screen.
      shadowKernelAppActivated(this.getSnapshot());
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      this.emit({ type: 'APP_RESIGNED' });
      // Shadow-feed the kernel (window-kernel-shadow.ts) — additive,
      // authoritative over nothing; see that module's doc for why this can
      // never change what actually happens on screen.
      shadowKernelAppResigned(this.getSnapshot());
      if (this.appResignSettleTimer) clearTimeout(this.appResignSettleTimer);
      this.appResignSettleTimer = setTimeout(() => {
        this.appResignSettleTimer = null;
        // Carried over VERBATIM from the deleted `ipc.ts
        // doCloseTransientHybridWindows` head: a resign fired by an izui
        // overlay entry/exit transition is activation churn, not an app
        // switch, so the settle point never arrives for it. The coordinator's
        // cooldowns are the only signal for that churn and the reducer does
        // not model them (§5 step 9 explicitly left them unmodelled), so the
        // read stays at the producer — suppressing the EDGE, never deciding
        // the sweep. Re-home it when the overlay cooldown becomes machine
        // state.
        const coordinator = getIzuiCoordinator();
        if (coordinator.isWithinOverlayExitCooldown() || coordinator.isWithinOverlayEntryCooldown()) {
          DEBUG && console.log('[wm-backend] app-resign settle suppressed (izui overlay cooldown)');
          return;
        }
        this.emit({ type: 'APP_RESIGN_SETTLED' });
        // Shadow-feed the kernel — same containment as above. Fed AFTER the
        // cooldown early return so the kernel observes exactly the edge the
        // old machine observes; the cooldown read itself stays at the
        // producer (see `window-kernel-shadow.ts shadowKernelAppResignSettled`
        // for why a clean comparison here does not prove the hide/re-show
        // half equivalent).
        shadowKernelAppResignSettled(this.getSnapshot());
      }, APP_RESIGN_SETTLE_MS);
    });
    this.attachSpaceChangeListener();
  }

  /**
   * The macOS Space switch → `SPACE_CHANGED`. Darwin-only: Spaces exist
   * nowhere else and `subscribeWorkspaceNotification` is a macOS-only method,
   * so this is a no-op on every other platform.
   *
   * The notification's `userInfo` is EMPTY — verified live on this app — so
   * there is nothing to put on the event and no way to name the Space we
   * moved to. The machine does not need one: its `SPACE_CHANGED` clause is
   * inert today (see the clause for why), and this subscription exists so the
   * signal is there when something needs it.
   */
  private attachSpaceChangeListener(): void {
    if (process.platform !== 'darwin') return;
    systemPreferences.subscribeWorkspaceNotification(
      'NSWorkspaceActiveSpaceDidChangeNotification',
      () => {
        this.emit({ type: 'SPACE_CHANGED' });
      },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Migration shims (see `BackendMigrationShims` for the absorption plan).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * MIGRATION SHIM — post-hoc join (see `BackendMigrationShims`): mint (or
   * resolve) the `WindowId` for an already-created native window, retain its
   * handles, and attach the per-window native listeners exactly once.
   *
   * IDEMPOTENT per underlying native window (the WindowId is MINTED here, so
   * idempotency is keyed by the platform window handle), and that is
   * load-bearing: more than one call site registers the same BrowserWindow
   * (the tile-launcher hook inside `createTileBrowserWindow`, then the
   * `ipc.ts` window-open site for the same window). Re-attaching would give
   * one physical Escape TWO `ESC_PRESSED` dispatches — and the second one,
   * arriving after the switcher already closed, re-opened it 500ms later in
   * an unbreakable loop. So a repeat registration MERGES the (richer) spec
   * and leaves listeners alone.
   *
   * The branch itself is NOT decided here: `decideWindowRegistration`
   * (`window-state.ts`) owns it, so it stays unit-testable away from this
   * file's value-side `electron` import (unloadable under the unit gate's
   * `ELECTRON_RUN_AS_NODE=1`). This method executes the decision's
   * BACKEND half (merge + native-listener attach) and returns the decision;
   * the executor (`window-os-adapter.ts registerWindow`) performs the pump +
   * Esc-attach half — it stays the one dispatch owner.
   */
  registerWindow(spec: RegisterWindowSpec): BackendRegistration {
    const { kind, win } = spec;
    const rendererWC = spec.contentWC ?? null;

    // The WM MINTS the id — it never arrives from outside. Idempotency is
    // therefore keyed by the UNDERLYING platform window: the same
    // BrowserWindow/BaseWindow registered twice resolves to the SAME WindowId,
    // with the later (richer) spec merged in.
    const osWindowId = win.id;
    const existingId = this.idByOsWindowId.get(osWindowId);
    const existing = existingId === undefined ? undefined : this.windows.get(existingId);
    const decision = decideWindowRegistration({
      alreadyRegistered: existing !== undefined,
      kind,
      hasContentWC: spec.contentWC !== undefined,
      attachEscHandlerRequested: spec.attachEscHandler,
      nativeVisible: this.isVisibleSafe(win),
    });

    let id: WindowId;
    if (existing !== undefined && existingId !== undefined) {
      id = existingId;
      existing.win = win;
      existing.kind = kind;
      existing.windowClass = spec.class;
      if (decision.adoptRendererWC) existing.rendererWC = rendererWC;
    } else {
      this.windowIdCounter += 1;
      id = `wm-${this.windowIdCounter}` as WindowId;
      this.idByOsWindowId.set(osWindowId, id);
      this.windows.set(id, { win, kind, windowClass: spec.class, rendererWC });
    }

    if (decision.attachNativeListeners) {
      this.attachNativeListeners(id, osWindowId, win, kind, rendererWC);
    }

    // One boundary read (same pattern as `nativeVisible` above) — seeds the
    // reducer's bounds mirror via the executor's WINDOW_REGISTERED pump.
    let initialBounds: Rectangle | null = null;
    try {
      if (!win.isDestroyed()) initialBounds = win.getBounds();
    } catch {
      /* window gone mid-registration — no rect to seed */
    }

    // Identity log: ties this wm-N to the platform window + a best-effort URL
    // so a later log line naming only `id` can be read as evidence about
    // WHICH window did something. Fires on both the mint and merge branches —
    // registration is idempotent and the second call (richer spec) is often
    // where a real URL first becomes available (the first may still be
    // about:blank pre-`loadURL`).
    DEBUG &&
      console.log(
        '[window-backend] registerWindow',
        id,
        'osWindowId',
        osWindowId,
        'kind',
        kind,
        'class',
        spec.class,
        'url',
        this.urlSafe(rendererWC),
      );

    return { id, decision, initialBounds };
  }

  /**
   * MIGRATION SHIM (see `BackendMigrationShims`): the WM WindowId for a
   * registered native window (or a platform window id a legacy Electron-keyed
   * registry still holds). `null` when the window was never registered or is
   * already gone.
   */
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null {
    let osId: number;
    if (typeof winOrOsId === 'number') {
      osId = winOrOsId;
    } else {
      try {
        osId = winOrOsId.id;
      } catch {
        return null; // destroyed native window — reading .id throws
      }
    }
    return this.idByOsWindowId.get(osId) ?? null;
  }

  /**
   * MIGRATION SHIM (see `BackendMigrationShims`): the live native window
   * handle for a WM WindowId, or `null` when unregistered/destroyed. The
   * HANDLE crosses (legacy consumers still need to join against
   * Electron-id-keyed registries until later migration steps); the backend's
   * numeric maps do not.
   */
  getNativeWindowFor(id: WindowId): NativeWindow | null {
    const entry = this.windows.get(id);
    if (!entry) return null;
    try {
      if (entry.win.isDestroyed()) return null;
    } catch {
      return null;
    }
    return entry.win;
  }

  /**
   * PRIVATE: the platform window id for a WindowId — used only where this
   * backend must call into a legacy Electron-id-keyed seam (windows.ts
   * `closeOrHideWindow` / `askWebContentsToHandleEscape`) until those seams
   * are re-keyed. Never exposed.
   */
  private osWindowIdOf(id: WindowId): number | null {
    const win = this.getNativeWindowFor(id);
    if (!win) return null;
    try {
      return win.id;
    } catch {
      return null;
    }
  }

  /**
   * The work area of the display nearest a window's current bounds, or `null`
   * when unavailable (some test envs) — mirrors `hybrid-overlay.ts
   * workAreaNearest`. Used only to compute `BOUNDS_CHANGED.overlayFrame` for
   * page-hosts (§5 step 9).
   */
  private workAreaNearest(content: Rectangle): Rectangle | null {
    try {
      return screen.getDisplayNearestPoint({
        x: content.x + Math.floor(content.width / 2),
        y: content.y + Math.floor(content.height / 2),
      }).workArea;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Native listeners (§2.6): each is a one-line event translation — the sole
  // exception is `blur`, which arms the ONE deferred-blur settle instead of
  // emitting (§4.4).
  // ───────────────────────────────────────────────────────────────────────────

  private attachNativeListeners(
    id: WindowId,
    osWindowId: number,
    win: NativeWindow,
    kind: WindowKind,
    rendererWC: NativeWebContents | null,
  ): void {
    win.on('focus', () => {
      this.cancelBlurSettle();
      this.emit({
        type: 'OS_FOCUS_GAINED',
        id,
        lastHttpUrl: this.readHttpUrl(id),
        cause: this.takeFocusCause(id),
      });
      // Shadow-feed the kernel (window-kernel-shadow.ts) — additive, authoritative
      // over nothing; see that module's doc for why this can never change what
      // actually happens on screen.
      shadowKernelOsFocusGained(id, this.getSnapshot());
    });
    // The ONE deferred-blur settle: blur alone can't tell "focus left Peek" from
    // "focus is moving to the next Peek window" — Electron fires the old window's
    // `blur` BEFORE the new window's `focus` (§4.4). So arm a one-tick settle; a
    // focus that lands in-app cancels it before it runs.
    win.on('blur', () => {
      // Focus left this window, so any self-caused-focus arming for it is void —
      // whatever focuses it next is a fresh event, not our echo (see
      // `pendingSelfCausedFocus`).
      this.pendingSelfCausedFocus.delete(id);
      this.armBlurSettle();
    });
    win.on('show', () => {
      const focused = this.isFocused(win);
      this.emit({ type: 'WINDOW_SHOWN', id, focused });
      // Shadow-feed the kernel (window-kernel-shadow.ts) — additive,
      // authoritative over nothing; see that module's doc for why this can
      // never change what actually happens on screen.
      shadowKernelWindowShown(id, this.getSnapshot(), focused);
    });
    win.on('hide', () => {
      // OS boundary workaround (macOS, lowest layer — this backend): AppKit
      // delivers stale/lagged 'hide' notifications for BaseWindows (the peek
      // 71cfde09 lag class). During session restore one arrives for the
      // just-activated host with the window still on screen, and echoing it
      // would yank the machine's `front` off the restored window. Validate
      // the signal against native ground truth: only a window that is
      // actually not visible echoes WINDOW_HIDDEN.
      if (!win.isDestroyed() && win.isVisible()) return;
      this.emit({ type: 'WINDOW_HIDDEN', id });
      shadowKernelWindowHidden(id, this.getSnapshot());
    });
    win.on('closed', () => {
      this.clearFullscreenSettle(id);
      this.pendingSelfCausedFocus.delete(id);
      this.windows.delete(id);
      // `osWindowId` was captured at registration — reading `win.id` here would
      // throw on the already-destroyed native window.
      this.idByOsWindowId.delete(osWindowId);
      this.emit({ type: 'WINDOW_CLOSED', id });
      // Shadow-feed the kernel (window-kernel-shadow.ts) — additive, authoritative
      // over nothing; RULE 1 makes this the only event that shrinks its `order`.
      shadowKernelWindowClosed(id, this.getSnapshot());
    });
    win.on('enter-full-screen', () => {
      this.clearFullscreenSettle(id);
      this.emit({ type: 'OS_FULLSCREEN_ENTERED', id });
    });
    win.on('leave-full-screen', () => {
      this.clearFullscreenSettle(id);
      this.emit({ type: 'OS_FULLSCREEN_LEFT', id });
    });
    // Geometry mirror (§5 step 7): every native resize/move lands in the
    // machine as BOUNDS_CHANGED — the SOLE writer of the record's `bounds`.
    // Three native names, one translation: `resize` + the continuous `move`
    // fire on both kinds; macOS additionally fires `moved` once at
    // gesture-end. A duplicate emission re-merges the same rect in the
    // reducer, structurally inert.
    const emitBounds = (): void => {
      // Read ONCE, inside the backend, and push — never a query across the
      // port (§3). A window can be destroyed between the native event firing
      // and this microtask; reading bounds then throws, and there is nothing
      // left to report.
      try {
        if (win.isDestroyed()) return;
        const bounds = win.getBounds();
        // Only a page-host can host the chrome overlay (§5 step 9) — skip the
        // frame math for every other window kind.
        const overlayFrame =
          kind === 'page-host' ? expandToOverlayFrame(bounds, this.workAreaNearest(bounds)) : undefined;
        this.emit({ type: 'BOUNDS_CHANGED', id, bounds, overlayFrame });
      } catch {
        /* window gone mid-event */
      }
    };
    win.on('resize', emitBounds);
    win.on('move', emitBounds);
    win.on('moved', emitBounds);
    // Page-host: clicking directly into the page focuses the content WC even when
    // the host BaseWindow's own `focus` is missed (belt-and-suspenders, mirrors
    // the registry's content-WC focus fallback).
    if (kind === 'page-host' && rendererWC) {
      rendererWC.on('focus', () => {
        this.cancelBlurSettle();
        this.emit({
          type: 'OS_FOCUS_GAINED',
          id,
          lastHttpUrl: this.readHttpUrl(id),
          cause: this.takeFocusCause(id),
        });
        this.emit({ type: 'CONTENT_FIRST_RESPONDER_CHANGED', id, held: true });
        // Shadow-feed the kernel — see the `win.on('focus')` listener above.
        shadowKernelOsFocusGained(id, this.getSnapshot());
      });
      // Mirrors the content WC's first-responder status (§5 step 11) — no
      // consumer yet, purely additive.
      rendererWC.on('blur', () => {
        this.emit({ type: 'CONTENT_FIRST_RESPONDER_CHANGED', id, held: false });
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Focus provenance (peek 7fffa286) — see `pendingSelfCausedFocus`.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Declare, immediately before a native call that can move OS focus onto `id`,
   * that the focus it provokes is the machine's own — carrying `opSeq`, the
   * token of the effect that asked for it.
   *
   * Call sites are exactly the focus-family commands, and ONLY where the native
   * call really can take focus: an activating `performOsShow`, `raiseWindow`'s
   * content focus, `focusContent`. A `showInactive()` takes no focus and arms
   * nothing — arming it would leave a token nothing consumes.
   */
  private armSelfCausedFocus(id: WindowId, opSeq: number): void {
    this.pendingSelfCausedFocus.set(id, opSeq);
  }

  /**
   * Consume the arming for `id` and report the provenance of the focus that just
   * arrived: `machine` (with the op token) when this backend was expecting it,
   * `world` otherwise. One shot — a second focus with nothing armed is `world`,
   * which is what makes a self-caused echo unable to spend a window's "first real
   * focus".
   */
  private takeFocusCause(id: WindowId): FocusCause {
    const opSeq = this.pendingSelfCausedFocus.get(id);
    if (opSeq === undefined) return { kind: 'world' };
    this.pendingSelfCausedFocus.delete(id);
    return { kind: 'machine', opSeq };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Port: commands.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Show + raise + activate a window, kind-appropriately (headless stays
   * focus-free). `raiseWindow` is reachable from the `RAISE_WINDOW` effect,
   * whose sole emitter is `window-state.ts applyRaiseRequest` — a raise at a
   * target something named (switcher selection, Escape closing the switcher,
   * devtools, parent handoff on close, the successor after the front hid),
   * never a re-drive of the machine's own belief. A raise is an activating show, so its
   * truthful echo is `WINDOW_SHOWN {focused:true}` — `front` moves and
   * `applyFocusGained` runs, but the transient-autoclose sweep does NOT
   * (`selectTransientAutoclose` runs only off `OS_FOCUS_GAINED`). Echoing
   * `OS_FOCUS_GAINED` instead would both feed the machine's own belief back in
   * as fresh OS evidence and sweep a live palette/quick-view out from under a
   * raise that never meant to touch it — see `applyOsFocusRealized`'s docblock
   * for the shape of that feedback loop. The same holds for `showWindow`; see
   * the module header.
   */
  raiseWindow(id: WindowId, opSeq: number): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, rendererWC } = entry;
    if (win.isDestroyed()) return;
    if (kind === 'page-host') {
      // Non-headless: activating show + content first responder (the
      // `hybridShowIntent` invariant — the R4/R5/R7 dead-focus cluster).
      // Headless: opacity-0 + showInactive, never activate/focus.
      this.performOsShow(id, win, !isHeadless(), opSeq);
      if (!isHeadless() && rendererWC && !rendererWC.isDestroyed()) {
        try {
          // The raise's content-focus half provokes `rendererWC 'focus'` — the
          // producer that carried the peek 7fffa286 sweep. Label it.
          this.armSelfCausedFocus(id, opSeq);
          rendererWC.focus();
        } catch {
          /* wc gone mid-raise */
        }
      }
      this.emit({ type: 'WINDOW_SHOWN', id, focused: true });
      shadowKernelWindowShown(id, this.getSnapshot(), true);
      return;
    }
    // Browser window: headless-safe show (opacity-0 + inactive under headless),
    // activate + focus only when not headless.
    this.performOsShow(id, win, !isHeadless(), opSeq);
    this.emit({ type: 'WINDOW_SHOWN', id, focused: true });
    shadowKernelWindowShown(id, this.getSnapshot(), true);
    if (!isHeadless()) {
      try {
        this.armSelfCausedFocus(id, opSeq);
        (win as unknown as BrowserWindow).focus();
      } catch {
        /* window gone mid-raise */
      }
    }
  }

  /** Make a page-host's content WC the macOS first responder. */
  focusContent(id: WindowId, opSeq: number): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) return;
    // The focus this call provokes is the machine's own, not a user gesture.
    this.armSelfCausedFocus(id, opSeq);
    wc.focus();
  }

  /**
   * Drive native fullscreen (the SINGLE place the platform fullscreen toggle
   * is called for BOTH kinds — §2.4). NOT gated on headless: the pre-machine
   * owner (`setHybridHostFullScreen`) wasn't either, and the bridge-driven
   * "disruptive fullscreen" spec (§5.4) relies on a real transition.
   * Focus/activation are what headless gates.
   */
  setFullscreen(id: WindowId, on: boolean): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    w.setFullScreen(on);
    // Arm the bounded settle timer so a transition that never emits its
    // native settled event self-corrects via RECONCILE_FULLSCREEN (§2.3).
    this.armFullscreenSettle(id);
  }

  /**
   * The ONE sanctioned `isFullScreen()` read (§2.5): read reality ONCE and
   * emit the settled event so the reducer snaps `fsMode` to it. Command in,
   * event out — no other code may read `isFullScreen()` for state.
   */
  reconcileFullscreen(id: WindowId): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    this.emit(
      w.isFullScreen()
        ? { type: 'OS_FULLSCREEN_ENTERED', id }
        : { type: 'OS_FULLSCREEN_LEFT', id },
    );
  }

  /**
   * Route through the existing close/hide seam (honors keepLive, hybrid vs
   * browser). The seam is still Electron-id-keyed; the backend resolves the
   * native id (the one place allowed to). The returned promise is test-bridge
   * settlement only — nothing in the machine waits on it.
   */
  closeOrHide(id: WindowId, opts?: { closedDueToAppBlur?: boolean }): Promise<void> {
    const osId = this.osWindowIdOf(id);
    if (osId == null) return Promise.resolve();
    if (opts?.closedDueToAppBlur === true) {
      // The legacy side channel the `main.ts` 'closed' handler reads
      // (`__closedDueToAppBlur`). The expando lives on the native window, so
      // the write belongs here — the executor holds no handles. Stamped
      // IMMEDIATELY before the close, the ordering the old `main.ts
      // did-resign-active` loop had, so the 'closed' handler always sees it.
      const win = this.windows.get(id)?.win;
      if (win) (win as unknown as { __closedDueToAppBlur?: boolean }).__closedDueToAppBlur = true;
    }
    return closeOrHideWindow(osId);
  }

  /**
   * The `escape-pressed` IPC, unchanged protocol. The renderer's answer drives
   * `decideEscape` step 6; it comes back as an `ESC_RENDERER_ANSWER` emission
   * echoing `seq` (the ask's epoch) on BOTH answer paths so the reducer can
   * drop an answer whose question no longer stands.
   */
  askRendererToHandleEscape(id: WindowId, seq: number): Promise<void> {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) {
      // No renderer to ask → treat as unhandled so ESC still resolves.
      this.emit({ type: 'ESC_RENDERER_ANSWER', id, handled: false, seq });
      return Promise.resolve();
    }
    // `askWebContentsToHandleEscape` (windows.ts) still speaks Electron ids;
    // resolve the native id INSIDE the backend (the one place allowed to).
    return askWebContentsToHandleEscape(
      this.osWindowIdOf(id) ?? -1,
      wc as unknown as WebContents,
    ).then((ans) => {
      this.emit({
        type: 'ESC_RENDERER_ANSWER',
        id,
        handled: ans.handled,
        close: ans.close,
        seq,
      });
    });
  }

  /**
   * The SINGLE owner of the `before-input-event` Esc attach for browser
   * windows (see `WindowSpec.attachEscHandler`). Issued by the executor
   * exactly when `decideWindowRegistration` says so — one attach per window,
   * so one keypress can only ever produce one `ESC_PRESSED`.
   */
  attachEscHandler(id: WindowId): void {
    const win = this.getNativeWindowFor(id);
    if (!win) return;
    try {
      addEscHandler(win as unknown as BrowserWindow);
    } catch (err) {
      DEBUG && console.log('[window-state] esc handler attach failed for', id, err);
    }
  }

  /**
   * Derived Escape grab (§2.4), OS half. The executor re-asserts the desired
   * state on EVERY transition; this method owns the real registration state —
   * including a FAILED register (stays false so the next assert retries) —
   * and no-ops when already matching.
   */
  setEscGrab(on: boolean): void {
    if (on === this.escGrabRegistered) return;
    if (on) {
      try {
        this.escGrabRegistered = globalShortcut.register('Escape', this.escGrabHandler);
      } catch (err) {
        console.error('[window-state] Esc grab register failed:', err);
      }
    } else {
      try {
        globalShortcut.unregister('Escape');
      } catch {
        /* unregistering a hotkey not held is a no-op on some platforms */
      }
      this.escGrabRegistered = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §5 step 4 commands — close/destroy/show/hide/pin + guest teardown.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Guest-safe direct close (the absorbed `windows.ts closeHostWindow` /
   * `destroyGuestsThenClose` pair — see `WindowBackend.closeWindow` and the
   * d1cf0b9a use-after-free history on the old function): destroy the
   * window's registered page-host guests FIRST, wait for them to actually go
   * away (bounded), then close the host. Guestless windows take the
   * synchronous fast path. `PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1` reverts to
   * the raw close — the pre-fix behavior, a test/diagnostic seam only.
   */
  closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id)?.win;
    if (!win) return Promise.resolve();
    try {
      if (win.isDestroyed()) return Promise.resolve();
    } catch {
      return Promise.resolve();
    }
    const guestIds = getGuestsForWindow(id);
    if (guestIds.length === 0 || process.env.PEEK_DISABLE_PAGEHOST_CLOSE_GUARD === '1') {
      try {
        win.close();
      } catch {
        /* closing a torn-down window is a no-op */
      }
      return Promise.resolve();
    }
    return this.destroyGuestsThenClose(win, guestIds);
  }

  private async destroyGuestsThenClose(win: NativeWindow, guestIds: number[]): Promise<void> {
    DEBUG && console.log('[window-backend] destroying', guestIds.length, 'guest(s) before closing host');
    await destroyGuestsAndWait(this.resolveLiveGuests(guestIds), requestGuestDestroy);
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      /* torn down while guests settled */
    }
  }

  /** Guest ids → live WebContents. Ids with no live wc need no wait at all. */
  private resolveLiveGuests(guestIds: readonly number[]): WebContents[] {
    const live: WebContents[] = [];
    for (const gid of guestIds) {
      try {
        const wc = webContents.fromId(gid);
        if (wc && !wc.isDestroyed()) live.push(wc);
      } catch {
        /* an id whose wc can't be resolved is already gone */
      }
    }
    return live;
  }

  /** Forceful native destroy — synchronous (before-quit teardown depends on it). */
  destroyWindow(id: WindowId): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* destroying a torn-down window is a no-op */
    }
  }

  /**
   * Tear down the retained content surface (the hybrid finalize's documented
   * `webContents.close()` teardown — no beforeunload wait; the host is
   * already gone). Gated on the same pure guard the old call site used
   * (`shouldCloseContentWCOnFinalize`, peek 9a591551: an already-natively-
   * gone wc resolves to undefined and must be a clean no-op).
   */
  closeContent(id: WindowId): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!shouldCloseContentWCOnFinalize(wc)) return;
    try {
      wc!.close();
    } catch (e) {
      DEBUG && console.log('[window-backend] content wc close failed for', id, e);
    }
  }

  /**
   * The ONE show implementation (§5 step 6A-2 — the `SHOW_WINDOW` effect).
   * Owns the whole policy the windows.ts seams used to perform:
   *   - headless → `setOpacity(0)` BEFORE the show (nothing paints on the
   *     real display; `isVisible()` stays true for tests);
   *   - `activate` → `show()` (activates the app + key window), else
   *     `showInactive()`;
   *   - page-host OS masks: never activate under headless (focus-free runs),
   *     and a `quick-view`-class host (a `type:'panel'` NSPanel) NEVER
   *     activates the app (regression 524f7aba) — its key input rides the
   *     content-focus half, which stays with the windows.ts caller until the
   *     focus-rivals step (§5 step 8). A browser window ALSO masks activate
   *     under headless — matching the `raiseWindow` browser branch. `opacity(0)`
   *     hides pixels but does NOT stop an activating `win.show()` from doing
   *     `makeKeyAndOrderFront:` and stealing the macOS key window; only
   *     `showInactive()` avoids the grab. (Prior comment wrongly claimed
   *     opacity-0 covered headless — it was the test focus-theft root cause.)
   *   - echoes `WINDOW_SHOWN` with the caller's UNMASKED `activate` intent
   *     (absorbing the seam-side WINDOW_SHOWN dispatch windows.ts used to make):
   *     `showInactive()` emits no native `'show'` event and headless runs are
   *     focus-free, so this echo is what keeps the machine's visibility +
   *     `front` truthful. The native `'show'` listener still mirrors
   *     activating shows — the reducer's WINDOW_SHOWN merge is idempotent.
   *     Because the reducer runs that focused echo through `applyFocusGained`,
   *     `front`/`focusSeq` move under headless off this event alone — nothing
   *     here synthesizes an `OS_FOCUS_GAINED` to stand in for the activation
   *     the headless mask declined. See the module header for why not.
   */
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, windowClass } = entry;
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    // Two masks on the caller's activation intent, both narrowing what the OS
    // is asked for: headless never activates (focus-free runs, peek 2b55f3af),
    // and a quick-view page-host (a `type:'panel'` NSPanel) never activates the
    // app on ANY display (regression 524f7aba). The echo below still reports the
    // caller's UNMASKED intent — that is what keeps `front` moving under
    // headless.
    const osActivate =
      (kind === 'page-host' ? opts.activate && windowClass !== 'quick-view' : opts.activate) &&
      !isHeadless();
    this.performOsShow(id, win, osActivate, opts.opSeq);
    this.emit({ type: 'WINDOW_SHOWN', id, focused: opts.activate });
    shadowKernelWindowShown(id, this.getSnapshot(), opts.activate);
  }

  /**
   * The single native show call pair (+ the headless opacity-0 trick): every
   * show this backend performs — `showWindow`, `raiseWindow` — funnels here.
   * Opacity is zeroed BEFORE the show; the entry.ts headless prototype guard
   * enforces exactly that order.
   */
  private performOsShow(id: WindowId, win: NativeWindow, activate: boolean, opSeq: number): void {
    if (isHeadless()) {
      try {
        win.setOpacity(0);
      } catch {
        /* setOpacity unsupported on some platforms */
      }
    }
    if (activate) {
      try {
        // An activating show is `makeKeyAndOrderFront:` — it takes the macOS key
        // window, so the `'focus'` it provokes is self-caused. Armed only on this
        // branch: `showInactive()` below takes no focus at all (see
        // `pendingSelfCausedFocus`).
        this.armSelfCausedFocus(id, opSeq);
        win.show();
      } catch {
        /* show unsupported in some envs */
      }
    } else {
      try {
        win.showInactive();
      } catch {
        /* showInactive unsupported in some envs */
      }
    }
  }

  /** Hide, keep alive (the HUD app-blur sweep). */
  hideWindow(id: WindowId): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      win.hide();
    } catch {
      /* hiding a torn-down window is a no-op */
      return;
    }
    // Echo WINDOW_HIDDEN for the hide this backend just performed — the exact
    // mirror of `showWindow`'s WINDOW_SHOWN echo. The native `'hide'` event
    // fires a tick LATE on macOS BaseWindows (the documented peek 71cfde09
    // lag), so without this echo every consumer that reads machine state right
    // after a hide intent — the overlay's host-visibility gate, `front`
    // successor promotion — sees stale `visible:true` for a tick. The late
    // native event still arrives and re-merges idempotently in the reducer.
    this.emit({ type: 'WINDOW_HIDDEN', id });
    shadowKernelWindowHidden(id, this.getSnapshot());
  }

  /** Pin above regular windows. 'floating' matches the old post-ctor reinforcement (`setAlwaysOnTop(true,'floating')`). */
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setAlwaysOnTop(on, on ? 'floating' : undefined);
    } catch {
      /* pinning a torn-down window is a no-op */
    }
  }

  /**
   * Relative raise — order only (the `SET_STACKING` effect, §5 step 5).
   * Regular (`stacked`/`excluded`) kinds route through the native `moveTop`:
   * it reorders z within the window's level WITHOUT activating or taking key
   * (the property the legacy restore pass relied on). The two caveats — macOS
   * no-ops it for a non-frontmost app, and a page-host's NSWindow no-ops it
   * until first composited frame — are modeled in the MACHINE
   * (`window-state.ts` appActive gate + `WINDOW_CONTENT_ORDERABLE`), not
   * worked around here.
   *
   * A `pinned` window (the chrome overlay) is a DIFFERENT native operation:
   * `moveTop()` only reorders within the current level, so it cannot lift the
   * overlay back above the regular stack once anything raises over it — the
   * original `frameBounds()` re-assert used `setAlwaysOnTop(true, 'floating')`
   * instead, and that's what this branch realizes. Not headless-gated: the
   * original ran it under headless too (opacity-0 overlay).
   */
  setStacking(id: WindowId, level: StackingLevel): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      if (level === 'pinned') win.setAlwaysOnTop(true, 'floating');
      else win.moveTop();
    } catch {
      /* moveTop/setAlwaysOnTop unsupported on some platforms / torn-down window — a no-op */
    }
  }

  /**
   * Position and size the window (the `SET_BOUNDS` effect — §5 step 7). The
   * SINGLE place the platform bounds write happens for BOTH kinds; the
   * native `resize`/`move` listeners echo the settled rect back as
   * `BOUNDS_CHANGED` (command in, event out — no `getBounds()` answer here).
   */
  setWindowBounds(id: WindowId, rect: Rectangle): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setBounds(rect);
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
    }
  }

  /**
   * Pin the window to (or unpin it from) every macOS Space (the
   * `SET_VISIBLE_ON_ALL_SPACES` effect — §5 step 10).
   *
   * darwin-only: Spaces don't exist elsewhere and the platform call is a
   * no-op there, so the guard is the honest statement of scope rather than a
   * behavior change (`spacesPolicyForRole` already answers `'none'` off
   * darwin, so no effect should reach here anyway).
   *
   * No `isHeadless()` gate HERE — same convention as `pinAlwaysOnTop` /
   * `setStacking` / `setWindowBounds`: the executor owns the headless
   * decision for this family (`window-os-adapter.ts` skips the effect under
   * headless, matching the `if (!isHeadless())` both `ipc.ts` call sites
   * already sit inside). `entry.ts`'s headless prototype no-op guard remains
   * the belt-and-braces backstop that COUNTS any call that slips through.
   *
   * Only the options the caller actually supplied are forwarded: an absent
   * flag must stay absent, not become `false` (`visibleOnFullScreen` belongs
   * on the `true` call of the anchor pair only).
   */
  setVisibleOnAllSpaces(
    id: WindowId,
    on: boolean,
    opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void {
    if (process.platform !== 'darwin') return;
    const win = this.windows.get(id)?.win;
    if (!win) return;
    const options: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean } = {};
    if (opts?.visibleOnFullScreen !== undefined) options.visibleOnFullScreen = opts.visibleOnFullScreen;
    if (opts?.skipTransformProcessType !== undefined) options.skipTransformProcessType = opts.skipTransformProcessType;
    try {
      if (!win.isDestroyed()) win.setVisibleOnAllWorkspaces(on, options);
    } catch {
      /* Spaces write against a torn-down window — the machine already recorded intent */
    }
  }

  /**
   * Destroy every registered page-host guest WC and resolve once they are
   * actually gone — the quit teardown that used to live in
   * `webview-guest-registry.ts destroyAllPageHostGuests` (peek d1cf0b9a: a
   * guest with an in-flight relay invoke torn down inside `-[NSWindow __close]`
   * → EXC_BAD_ACCESS).
   *
   * The RESOLUTION is the whole point, and it is why this is async. Issuing the
   * `destroy()` calls is not the teardown: `webContents.destroy()` returns
   * without throwing while `isDestroyed()` still reads `false`, so a caller that
   * only called it went on to let Electron close the host windows over six live
   * content WebContents — measured, the exact ordering d1cf0b9a is about. The
   * caller must await this before the quit proceeds; `guest-teardown.ts` bounds
   * the wait per guest AND over the batch so a wedged renderer cannot turn a
   * quit into a hang.
   */
  destroyAllContentGuests(): Promise<void> {
    const guests = this.resolveLiveGuests(getAllGuestWebContentsIds());
    DEBUG && console.log('[window-backend] quit teardown: destroying', guests.length, 'guest(s)');
    return destroyGuestsAndWait(guests, requestGuestDestroy, {
      overallMs: QUIT_GUEST_TEARDOWN_BUDGET_MS,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The ONE deferred-blur settle (§4.4). The lowest layer: the OS/Chromium
  // boundary where "focus left all Peek windows" is only knowable one tick after
  // a blur. The reducer itself has NO timers — this is the single sanctioned one
  // on the focus path.
  // ───────────────────────────────────────────────────────────────────────────

  private armBlurSettle(): void {
    if (this.pendingBlurSettle) return; // coalesce — at most one pending settle
    this.pendingBlurSettle = setImmediate(() => {
      this.pendingBlurSettle = null;
      // One tick later Electron has delivered any incoming `focus`. If some Peek
      // window now holds focus, focus stayed in-app — do nothing. Otherwise it
      // left the whole group → emit OS_FOCUS_SETTLED_NULL.
      if (this.anyWindowFocused()) return;
      this.emit({ type: 'OS_FOCUS_SETTLED_NULL' });
      // Shadow-feed the kernel — see `window-kernel-shadow.ts
      // shadowKernelOsFocusSettled` for the shape mismatch this translates
      // (this event carries no id; the kernel's `OsFocusLost` names one).
      shadowKernelOsFocusSettled(this.getSnapshot());
    });
  }

  private cancelBlurSettle(): void {
    if (!this.pendingBlurSettle) return;
    clearImmediate(this.pendingBlurSettle);
    this.pendingBlurSettle = null;
  }

  private anyWindowFocused(): boolean {
    for (const { win } of this.windows.values()) {
      if (this.isFocused(win)) return true;
    }
    return false;
  }

  private isFocused(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isFocused();
    } catch {
      return false;
    }
  }

  private isVisibleSafe(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isVisible();
    } catch {
      return false;
    }
  }

  /**
   * Best-effort URL read for diagnostic logging (`registerWindow`'s identity
   * log) — never throws. Returns '' when the WC is absent, destroyed, or the
   * read otherwise fails (e.g. not yet navigated).
   */
  private urlSafe(wc: NativeWebContents | null): string {
    if (!wc || wc.isDestroyed()) return '';
    try {
      return wc.getURL();
    } catch {
      return '';
    }
  }

  /**
   * The window's current http(s) URL (from its renderer WC), or undefined when
   * it is not on an http(s) page. Fed to `OS_FOCUS_GAINED` so the reducer can
   * track the devtools target (absorbs the old `lastContentWindowId`).
   */
  private readHttpUrl(id: WindowId): string | undefined {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) return undefined;
    try {
      const url = wc.getURL();
      return url.startsWith('http://') || url.startsWith('https://') ? url : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bounded fullscreen settle timer (§2.3).
  // ───────────────────────────────────────────────────────────────────────────

  private armFullscreenSettle(id: WindowId): void {
    this.clearFullscreenSettle(id);
    this.fullscreenSettleTimers.set(
      id,
      setTimeout(() => {
        this.fullscreenSettleTimers.delete(id);
        this.emit({ type: 'FULLSCREEN_SETTLE_TIMEOUT', id });
      }, FULLSCREEN_SETTLE_TIMEOUT_MS),
    );
  }

  private clearFullscreenSettle(id: WindowId): void {
    const t = this.fullscreenSettleTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.fullscreenSettleTimers.delete(id);
    }
  }
}
