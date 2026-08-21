/**
 * window-os-adapter.ts — the pump for the old deterministic window state
 * machine (design §2.6), now stripped down to the handful of responsibilities
 * the kernel cutover left behind.
 *
 * Blueprint: `docs/design/window-manager.md`. `window-kernel-executor.ts` is
 * the executor now (over `window-kernel.ts`'s pure triple) and the sole
 * caller of the `WindowBackend` port — see its header and
 * `window-kernel-shadow.ts`'s for how production wires onto it. THIS module
 * still runs the dispatch pump for `window-state.ts` (one path for every
 * event, native or app-level) and reconciles the derived Escape grab on every
 * transition, but `runEffect` below performs an OS window operation for only
 * four of its arms — the Escape renderer round trip (`ASK_RENDERER`), opening
 * and closing the switcher, and the two Escape-decided arms
 * (`CLOSE_WINDOW_UNHANDLED_ESCAPE` / `SET_FULLSCREEN_ESCAPE_EXIT`), which are
 * FEEDS that tell the kernel what Escape decided rather than performing
 * anything themselves. Every other arm is a labelled no-op (see the block
 * comment inside `runEffect`). This module holds NO native handles and
 * imports NO platform module — `electron-window-backend.ts` is the only
 * window-manager file that touches Electron, and it feeds native reality back
 * into this module's pump through the single event sink injected at
 * construction. (The one non-port import of that file here is the DEFAULT
 * backend construction in the constructor — composition, not a window op.)
 * This module dies alongside `window-state.ts` once those four
 * responsibilities move to their permanent home.
 *
 * The two OS/Chromium boundary workarounds (the deferred-blur settle §4.4 and
 * the bounded fullscreen settle §2.3) live in the BACKEND with the handles
 * they read — the lowest layer, shared with the kernel executor since both
 * machines drive the same backend instance. This module has no timers and
 * performs no native reads; the reducer has neither timers nor effects of its
 * own.
 */

import { isHeadless, DEBUG } from './config.js';
import { publish, getSystemAddress } from './pubsub.js';
// The overlay SESSION (not a window): `izui-state.ts` is a pure in-process
// state object importing nothing but `config.js`, so this is not a platform
// edge — the "no platform module" rule in this file's header still holds.
// Read for the app-blur cooldown guard and told to drop overlay state on the
// app-blur dismiss; see `CLOSE_SWITCHER_WINDOW`.
import { getIzuiCoordinator } from './izui-state.js';
import type { BackendEventSink, WindowBackend } from './window-backend.js';
import {
  ElectronWindowBackend,
  type BackendMigrationShims,
  type LegacySpacesShim,
  type NativeWindow,
  type RegisterWindowSpec,
} from './electron-window-backend.js';
import {
  WindowStateOwner,
  // The derived Esc-grab predicate lives in `window-state.ts`, NOT here, for
  // the same reason `decideWindowRegistration` does: this module transitively
  // value-imports `electron` (via the default backend construction), so a test
  // file importing it dies at parse under the unit gate's
  // `ELECTRON_RUN_AS_NODE=1`. The predicate is pure reducer-state logic, so it
  // belongs with the reducer where it is testable. This module only EXECUTES it.
  deriveEscGrabRegistered,
  isEligibleFront,
  type Effect,
  type StateSnapshot,
  type WindowEvent,
} from './window-state.js';
import type { WindowId } from './window-kernel.js';
import { shadowKernelCloseOrHideRequested, shadowKernelSetFullscreen } from './window-kernel-shadow.js';

// The registration spec (native handles included) is defined next to the shim
// that consumes it; re-exported here so the singleton's import site survives.
export type { RegisterWindowSpec } from './electron-window-backend.js';

/**
 * The executor. Holds the (single) `WindowStateOwner` and the (single)
 * `WindowBackend`, pumps every event through the identical
 * reduce → log → effects → Esc-grab-reconcile sequence, and issues port
 * commands for the effects. One instance per app
 * (`window-state-singleton.ts`).
 */
export class WindowOsAdapter {
  private readonly owner: WindowStateOwner;

  /**
   * The backend port — plus, until later migration steps absorb them, the
   * handle-speaking migration shims (`electron-window-backend.ts
   * BackendMigrationShims`) and the legacy raw Spaces write
   * (`electron-window-backend.ts LegacySpacesShim`, deleted alongside
   * `window-state.ts` rather than absorbed). This is the SAME backend
   * instance `window-kernel-executor.ts` performs every window operation
   * over (`getBackend()` below is how it gets there) — this module itself
   * issues no window operation through this reference anymore beyond the four
   * arms named in the file header.
   */
  private readonly backend: WindowBackend & BackendMigrationShims & LegacySpacesShim;

  constructor(
    owner: WindowStateOwner = new WindowStateOwner(),
    // Default composition: the Electron backend, wired to this pump. Tests /
    // future platforms inject their own factory; the sink argument is the ONE
    // channel backend events enter the machine through. `getSnapshot` is a
    // second, read-only channel — the backend has no state of its own (§3),
    // but its native listeners feed the shadow kernel (`window-kernel-shadow.ts`
    // shadowKernelOsFocusGained/shadowKernelOsFocusSettled/shadowKernelWindowClosed)
    // right after `emit` settles this machine, and the comparator those calls
    // run needs this machine's just-settled snapshot. Reading it through this
    // injected closure (rather than the backend importing
    // `window-state-singleton.ts` directly) keeps the backend from having to
    // know the singleton exists at all.
    createBackend: (
      emit: BackendEventSink,
      getSnapshot: () => StateSnapshot,
    ) => WindowBackend & BackendMigrationShims & LegacySpacesShim = (emit, getSnapshot) => new ElectronWindowBackend(emit, getSnapshot),
  ) {
    this.owner = owner;
    this.backend = createBackend(
      (event) => this.pump(event),
      () => this.owner.snapshot(),
    );
  }

  /** The shared state owner (read-only consumers attach to this). */
  getOwner(): WindowStateOwner {
    return this.owner;
  }

  /**
   * The ONE `WindowBackend` for the process — the same instance this module
   * issues every port command through.
   *
   * Exposed for the kernel cutover, which builds its `WindowKernelExecutor`
   * over THIS backend rather than constructing its own
   * (`window-state-singleton.ts getKernelExecutorForApp`). A second
   * `ElectronWindowBackend` would mint a second `idByOsWindowId` map and
   * attach a second set of native listeners to the same windows, so every
   * window would carry two unrelated `WindowId`s and report every native
   * transition twice. There is exactly one backend because there is exactly
   * one set of native windows.
   */
  getBackend(): WindowBackend & BackendMigrationShims & LegacySpacesShim {
    return this.backend;
  }

  /**
   * Public dispatch entry for the live consumers that feed the machine from
   * outside the backend's native-event paths: the ESC before-input seam
   * (ipc.ts / windows.ts → `ESC_PRESSED`), the fullscreen command
   * (tile-ipc.ts → `FULLSCREEN_REQUESTED`), the synchronous hide seam
   * (`WINDOW_HIDDEN`), the switcher mirror (`SWITCHER_OPENED`), and the session
   * mirror (`SESSION_CHANGED`). Runs the SAME pump every backend event does —
   * effects execute, transition log fires, Esc grab reconciles.
   */
  dispatch(event: WindowEvent): void {
    this.pump(event);
  }

  /**
   * Boot wiring: have the backend emit app-level activation events
   * (`APP_ACTIVATED`/`APP_RESIGNED`) into the pump. Called once from
   * `window-state-singleton.ts initWindowStateMachine`.
   */
  attachAppListeners(): void {
    this.backend.attachAppListeners();
  }

  /**
   * Register a window with the machine: the backend joins the native window
   * (mints/resolves its `WindowId`, retains handles, attaches native
   * listeners — its half of `decideWindowRegistration`), and THIS module
   * performs the dispatch half — it stays the one dispatch owner:
   *   - `WINDOW_REGISTERED` (always, including on a duplicate — the idempotent
   *     richer-spec re-merge, see the decision's field docs);
   *   - `WINDOW_SHOWN { focused: true }` when the native window was already
   *     visible (a ctor-shown window never fires a `'show'` transition — see
   *     `WindowRegistrationDecision.pumpShownEvent`), pumped AFTER the
   *     (richer, on re-registration) `WINDOW_REGISTERED` so satellite
   *     arbitration judges the focused-shown event against the final spec;
   *   - the per-window Esc interceptor attach (port command, browser windows
   *     only, never twice for one window).
   */
  registerWindow(spec: RegisterWindowSpec): WindowId {
    const { id, decision, initialBounds } = this.backend.registerWindow(spec);

    if (decision.pumpRegisteredEvent) {
      this.pump({
        type: 'WINDOW_REGISTERED',
        id,
        // The backend's one registration-time bounds read — seeds the
        // reducer's bounds mirror (§5 step 7B); a re-registration merge
        // keeps the lived mirror and only fills absence.
        bounds: initialBounds ?? undefined,
        kind: spec.kind,
        role: spec.role,
        class: spec.class,
        satellite: spec.satellite,
        escapeMode: spec.escapeMode,
        lastHttpUrl: spec.lastHttpUrl,
        parentId: spec.parentId,
        source: spec.source,
        params: spec.params,
        alwaysOnTop: spec.alwaysOnTop,
        keepLive: spec.keepLive,
        // Carried through, unread by this reducer today — see the field docs
        // on `WindowSpec` / `WindowRecord`.
        layer: spec.layer,
        canBecomeKey: spec.canBecomeKey,
        acceptsInput: spec.acceptsInput,
      });
    }

    if (decision.pumpShownEvent) {
      this.pump({ type: 'WINDOW_SHOWN', id, focused: true });
    }

    if (decision.attachEscHandler) {
      this.backend.attachEscHandler(id);
    }

    return id;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WindowId ↔ native-window seam. The BACKEND owns the mapping (design §3);
  // these delegate to its migration shims so the singleton surface the
  // still-numeric renderer-facing id economy converts through keeps working.
  // ───────────────────────────────────────────────────────────────────────────

  /** See `electron-window-backend.ts BackendMigrationShims.getWindowIdFor`. */
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null {
    return this.backend.getWindowIdFor(winOrOsId);
  }

  /** See `electron-window-backend.ts BackendMigrationShims.getNativeWindowFor`. */
  getNativeWindowFor(id: WindowId): NativeWindow | null {
    return this.backend.getNativeWindowFor(id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dispatch pump: one path for every event. Reads before/after snapshots so it
  // can emit the transition log (§5.3) and reconcile the derived Esc grab.
  // ───────────────────────────────────────────────────────────────────────────

  /** FIFO of events dispatched while a pump was already running (see `pump`). */
  private readonly pendingEvents: WindowEvent[] = [];

  /** Whether a pump is currently draining (re-entrancy latch for `pump`). */
  private pumping = false;

  /**
   * RE-ENTRANCY: effect execution can dispatch back into this pump. The known
   * cycle is `RAISE_WINDOW`/`SHOW_WINDOW` → the backend performing the OS
   * show and synchronously emitting its `WINDOW_SHOWN` echo (§5 step 6A-2);
   * the backend's synchronous emission for `RECONCILE_FULLSCREEN` also lands
   * here from inside `runEffect`. (`ASK_RENDERER`'s answer is different: the
   * port now returns it as a promise, so its `ESC_RENDERER_ANSWER` dispatch
   * always arrives through a later microtask, never synchronously from inside
   * `runEffect` — it enters this pump as a fresh top-level call, not a nested
   * one.) Instead of recursing mid-`runEffects`, nested dispatches are
   * QUEUED and drained strictly AFTER the current event's effect batch
   * completes. One pump runs at a time; every event still flows through the
   * identical reduce → log → effects → Esc-grab-reconcile sequence, in
   * dispatch order. A top-level `dispatch()` does not return until the queue
   * is fully drained, so callers keep their synchronous read-after-dispatch
   * contract.
   *
   * The drain TERMINATES on a structural argument, not on an ordering
   * coincidence: `window-state.ts applyRaiseRequest` is the sole
   * `RAISE_WINDOW` emitter, and no arm reachable from a `RAISE_WINDOW` echo
   * (`WINDOW_SHOWN`, `OS_FOCUS_GAINED`) calls it — so an echo can never
   * re-enqueue the raise that produced it.
   */
  private pump(event: WindowEvent): void {
    this.pendingEvents.push(event);
    if (this.pumping) return; // nested dispatch — the running drain picks it up
    this.pumping = true;
    try {
      let next: WindowEvent | undefined;
      while ((next = this.pendingEvents.shift()) !== undefined) {
        const before = this.owner.snapshot();
        const effects = this.owner.dispatch(next);
        const after = this.owner.snapshot();
        this.logTransition(next, before, after);
        this.runEffects(effects);
        this.reconcileEscGrab(this.owner.snapshot());
      }
    } finally {
      this.pumping = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Effect executor (§2.6). The reducer describes; the executor issues port
  // commands; the backend performs.
  // ───────────────────────────────────────────────────────────────────────────

  private runEffects(effects: Effect[]): void {
    for (const effect of effects) {
      try {
        this.runEffect(effect);
      } catch (err) {
        DEBUG && console.log('[window-state] effect failed:', effect.type, err);
      }
    }
  }

  private runEffect(effect: Effect): void {
    switch (effect.type) {
      // ───────────────────────────────────────────────────────────────────────
      // TRANSFERRED TO THE KERNEL EXECUTOR — every arm below performs nothing.
      //
      // The rule (`docs/design/window-manager.md` → "Where the swap draws its
      // line: by responsibility, not by machine"): anything that shows, hides,
      // orders, closes or focuses a window is a window operation and belongs to
      // the window manager. `window-kernel-executor.ts` performs all of these
      // now, over the SAME `ElectronWindowBackend` this adapter holds — so an
      // arm left live here would issue every one of them a second time.
      //
      // They stay as labelled no-ops rather than being deleted because the
      // reducer in `window-state.ts` still EMITS them, and the switch is
      // exhaustive over `Effect`. They go when that file goes.
      //
      // `SET_ALWAYS_ON_TOP` has no kernel effect of its own by design: the
      // kernel folds always-on-top into a window's `layer`, `SetStacking`'s band
      // replay picks the level through `stackingLevelForLayer`, and the pin
      // itself is `electron-window-backend.ts setStacking`'s business — one
      // layer below any rule, which is where a platform's method name belongs.
      // ───────────────────────────────────────────────────────────────────────
      case 'SET_FULLSCREEN':
      case 'RECONCILE_FULLSCREEN':
      case 'RAISE_WINDOW':
      case 'SET_STACKING':
      case 'SET_BOUNDS':
      case 'FOCUS_CONTENT':
      case 'CLOSE_WINDOW':
      case 'CLOSE_WINDOW_DIRECT':
      case 'DESTROY_WINDOW':
      case 'CLOSE_CONTENT':
      case 'SHOW_WINDOW':
      case 'HIDE_WINDOW':
      case 'SET_ALWAYS_ON_TOP':
      case 'SET_VISIBLE_ON_ALL_SPACES':
      case 'DESTROY_ALL_GUESTS': {
        return;
      }
      case 'ASK_RENDERER': {
        // The `escape-pressed` IPC, unchanged protocol. The port RETURNS the
        // renderer's answer rather than emitting it; this arm is the one that
        // still turns it into the old machine's `ESC_RENDERER_ANSWER` dispatch,
        // echoing `effect.seq` (the ask's epoch) so the reducer can drop an
        // answer whose question no longer stands. Tracked (not bare `void`)
        // so the E2E test bridge can await the ask's round trip
        // deterministically — see `waitForPendingAsyncEffects`.
        this.trackAsyncEffect(
          this.backend.askRendererHandledEscape(effect.id).then((handled) => {
            this.pump({ type: 'ESC_RENDERER_ANSWER', id: effect.id, handled, seq: effect.seq });
          }),
        );
        return;
      }
      case 'CLOSE_WINDOW_UNHANDLED_ESCAPE': {
        // The Escape-decided close, and the one window-operation arm that is
        // NOT a bare no-op above: it still carries the kernel feed.
        //
        // Why it exists at all, separate from `CLOSE_WINDOW`: the rule is one
        // feed per INTENT, and three sites emit plain `CLOSE_WINDOW` —
        // transient sibling dismissal, an explicit close-or-hide request, and
        // (before this split) the Escape decision. Feeding the shared arm
        // would double-fire for a keepLive window dismissed as a transient or
        // by Escape, because `windows.ts closeOrHideWindow()`'s own keepLive
        // branches already re-dispatch `WINDOW_CLOSE_OR_HIDE_REQUESTED` and
        // feed there. Naming the Escape decision at its own effect type lets
        // the executor feed exactly the intent that produced it.
        //
        // Why it is a feed and not a performance: the target is resolved at no
        // dispatch site — `applyEscape` never emits a close, and the epoch
        // check against reducer-private `escAsk` cannot be recomputed outside
        // the reducer — so this is the first point where both checks have
        // passed and the id is known. Deliberate temporary bridge; it dies
        // with `window-state.ts`, and `window-escape.ts resolveEscapeTarget`
        // is the permanent replacement once its producer widens beyond tiles.
        //
        // Residual redundancy, recorded rather than guarded against: a
        // keepLive window closed by Escape takes a second `CloseOrHideWindow`
        // from that same re-dispatch. It is inert — the record is already
        // hidden by then, so `react`'s structural diff emits nothing.
        shadowKernelCloseOrHideRequested(effect.id);
        return;
      }
      case 'SET_FULLSCREEN_ESCAPE_EXIT': {
        // The Escape-decided fullscreen exit, and (like
        // `CLOSE_WINDOW_UNHANDLED_ESCAPE` above) the other window-operation
        // arm that is NOT a bare no-op: it still carries the kernel feed.
        //
        // Why it exists at all, separate from `SET_FULLSCREEN`: the rule is
        // one feed per INTENT, and the shared `SET_FULLSCREEN` arm stays a
        // no-op because every OTHER emitter sits beside its own
        // `FULLSCREEN_REQUESTED` dispatch, which already feeds
        // `shadowKernelSetFullscreen` at the call site (`windows.ts`,
        // `ipc.ts`, `hybrid-overlay.ts`, `tile-ipc.ts` x2). This decision has
        // no such dispatch site — `applyEscape`'s `'exit-fullscreen'` case
        // resolves it entirely inside the reducer — so feeding the shared arm
        // would never fire for it, and naming the decision at its own effect
        // type is what lets THIS arm feed exactly that intent.
        //
        // Does NOT call the backend: the kernel now performs window
        // operations (see the TRANSFERRED TO THE KERNEL EXECUTOR block
        // above), so this arm's only job is telling the kernel what happened,
        // never toggling fullscreen itself.
        shadowKernelSetFullscreen(effect.id, false);
        return;
      }
      case 'OPEN_SWITCHER_WINDOW': {
        // The existing windows-feature tile renders the switcher; opening it is a
        // `cmd:execute:windows` publish (same trigger the deleted global-Esc
        // fallback used). `previousFront` is retained in machine state for the
        // restore-on-close, so nothing rides on the payload here.
        publish(getSystemAddress(), 'cmd:execute:windows', {});
        return;
      }
      case 'CLOSE_SWITCHER_WINDOW': {
        // BOTH switcher-dismiss paths close through this effect (§5 step 9's
        // last direct window call). The overlay SESSION (izui-state.ts) is
        // still the staged-cutover owner of restoration, so the two paths
        // differ only in who restores:
        //   - ESC path (restoreFocus:true): `closeOrHide` tears the overlay
        //     down; its 'closed' handler (main.ts) then runs `exitOverlay` +
        //     the focus restore + `popWindow`.
        //   - app-blur path (restoreFocus:false): restore WITHOUT focus first
        //     (`exitOverlayForAppBlur` — the user is switching to another app
        //     and we must not steal the target app's focus), stamp the
        //     'closed' handler's skip marker, then close.
        if (effect.switcherWindowId == null) return;
        if (effect.restoreFocus) {
          // Tracked for the same test-bridge await as CLOSE_WINDOW above.
          this.trackAsyncEffect(this.backend.closeOrHide(effect.switcherWindowId));
          return;
        }
        // The macOS focus-dance guard, carried over VERBATIM from the deleted
        // `main.ts did-resign-active` loop. An overlay entry/exit transition
        // itself produces a resign→become-active cycle (entry hides regular
        // windows and leaves only a panel; exit restores them), so a resign
        // inside either cooldown is activation churn, not the user leaving —
        // dismissing on it would close a switcher that just opened. The
        // reducer deliberately does not model the cooldowns (§5 step 9), so
        // this stays a READ at the executor, exactly like the backend's
        // APP_RESIGN_SETTLED suppression. R2 governs window WRITES; a read of
        // app-level session state is not one, and `izui-state.ts` imports no
        // platform module so this costs the executor no `electron` edge.
        // Re-home it when the overlay cooldown becomes machine state.
        const coordinator = getIzuiCoordinator();
        if (coordinator.isWithinOverlayExitCooldown() || coordinator.isWithinOverlayEntryCooldown()) {
          DEBUG && console.log('[wm] switcher app-blur close suppressed (izui overlay cooldown)');
          return;
        }
        coordinator.exitOverlayForAppBlur();
        this.trackAsyncEffect(
          this.backend.closeOrHide(effect.switcherWindowId, { closedDueToAppBlur: true }),
        );
        return;
      }
      case 'EXIT_FULLSCREEN': {
        // Semantic marker: "ESC was consumed by leaving fullscreen." The actual
        // toggle rides on the companion `SET_FULLSCREEN(id,false)` the reducer
        // emits in the SAME reduce when the window is settled `fullscreen`; when
        // it is mid-transition the reducer coalesces (pendingDesire) and emits NO
        // second setFullscreen — so this must stay a no-op to avoid double-toggle.
        return;
      }
      case 'PASS_THROUGH': {
        // ESC handed to the page (escapeMode 'ignore'). The synchronous "don't
        // preventDefault this keystroke" decision belongs to the before-input-event
        // seam (a later slice attaches it + consults `decideEscape`); nothing to
        // do post-dispatch here.
        return;
      }
      case 'NOTHING': {
        return;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Async-effect settlement tracking — TEST-BRIDGE SUPPORT, not machine state.
  // Two effects spawn work that outlives the pump: `ASK_RENDERER` (the
  // `escape-pressed` IPC round trip, bounded by windows.ts's ask timeout) and
  // the delegated `closeOrHide` calls. The machine itself never waits on
  // them (effects stay fire-and-forget); this set exists ONLY so the E2E bridge
  // (`hybrid-overlay.ts runHybridEscape`) can await "the ESC round trip has
  // fully settled" on the same channel the executor uses, instead of re-deriving
  // a poll deadline from the ask-timeout constant. Lives here, at the layer
  // that ISSUES the effects — outside the reducer (promise plumbing, not
  // state) and above the backend (which just returns each command's
  // settlement).
  //
  // A third source joined these two once Escape's own decision moved to
  // `window-escape-runtime.ts`: its renderer ask is issued outside this
  // module's `runEffect` entirely, so `trackExternalAsyncEffect` below is the
  // seam that lets it register on the SAME set rather than standing up a
  // second tracker `waitForPendingWindowEffects` would also have to await.
  // ───────────────────────────────────────────────────────────────────────────

  /** In-flight async effect promises (renderer ESC asks, delegated closes). */
  private readonly pendingAsyncEffects = new Set<Promise<unknown>>();

  /** Retain an async effect's promise until it settles (never rethrows). */
  private trackAsyncEffect(p: Promise<unknown>): void {
    this.pendingAsyncEffects.add(p);
    const drop = () => this.pendingAsyncEffects.delete(p);
    p.then(drop, drop);
  }

  /**
   * Public entry to `trackAsyncEffect` for a caller outside this module's own
   * `runEffect` arms — `window-escape-runtime.ts handleEscapePress`'s renderer
   * ask, injected as its `track` dep so `waitForPendingWindowEffects` still
   * sees it settle.
   */
  trackExternalAsyncEffect(p: Promise<unknown>): void {
    this.trackAsyncEffect(p);
  }

  /**
   * Test-bridge support: resolve once every currently-pending async effect —
   * and any async effect those spawn while settling (an ESC ask's answer pump
   * can emit a `CLOSE_WINDOW`) — has settled. Deterministic: the resolution is
   * the effects' own promises, no timer loop and no re-derived deadline.
   */
  async waitForPendingAsyncEffects(): Promise<void> {
    while (this.pendingAsyncEffects.size > 0) {
      await Promise.allSettled([...this.pendingAsyncEffects]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Derived Escape grab (§2.4). Reconciled on EVERY transition — replaces
  // main.ts's 5 re-evaluation sites. Skipped under headless (no OS grab). The
  // desired state is DERIVED here (pure predicate); the backend owns the real
  // registration state and no-ops when already matching.
  // ───────────────────────────────────────────────────────────────────────────

  private reconcileEscGrab(snap: StateSnapshot): void {
    if (isHeadless()) return;
    this.backend.setEscGrab(deriveEscGrabRegistered(snap));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transition log (§5.3) — one DEBUG-gated line per transition. The PERMANENT
  // replacement for the ad-hoc fsDiag / [esc] / [focus-tracker] traces (those old
  // traces are deleted in their own seam slices, not here).
  // Format: `[window-state] EVENT id(N)|landed(N|global)|switcher(N) front a→b
  // mode(id) x→y [satellite=.. eligible=..]`. The tag name matches the field the
  // id came from (`id`, `landedId`, `windowId`) so a grep for e.g. `landed(` is
  // unambiguous about which field produced the number (§5.3 follow-up).
  // ───────────────────────────────────────────────────────────────────────────

  private logTransition(event: WindowEvent, before: StateSnapshot, after: StateSnapshot): void {
    if (!DEBUG) return;
    const id = eventWindowId(event);
    const tag = eventWindowIdTag(event);
    let line = `[window-state] ${event.type}${tag == null ? '' : ` ${tag}`} front ${fmt(before.front)}→${fmt(after.front)}`;
    // The front's content-first-responder delta: the live-run observable for
    // "is the front positioned to hear Escape through before-input-event"
    // (the same signal `deriveEscGrabRegistered` keys off). Logged only when
    // it moved for the window that is front AFTER the transition.
    const beforeFocused = before.windows.find((w) => w.id === after.front)?.contentFocused;
    const afterFocused = after.windows.find((w) => w.id === after.front)?.contentFocused;
    if (after.front != null && beforeFocused !== afterFocused) {
      line += ` contentFocused ${beforeFocused}→${afterFocused}`;
    }
    // Ordered-stack delta (§5 step 5): whenever the intended z-order changed,
    // log the resulting bottom→top list so a live run can compare it against
    // the real (CGWindowList) stack.
    if (before.stackOrder.join(' ') !== after.stackOrder.join(' ')) {
      line += ` stack=[${after.stackOrder.join(' ')}]`;
    }
    for (const part of modeDeltas(before, after)) line += ` ${part}`;
    if (event.type === 'OS_FOCUS_GAINED' && id != null) {
      const rec = after.windows.find((w) => w.id === id);
      line += ` satellite=${rec?.satellite ?? 'unknown'} eligible=${isEligibleFront(rec)}`;
    }
    console.log(line);
  }
}

/** The window id carried by an event's canonical `id` field, if it has one. */
function eventWindowId(event: WindowEvent): WindowId | null {
  return 'id' in event && typeof event.id === 'string' ? event.id : null;
}

/**
 * The transition-log tag for whichever field carries an event's window id —
 * `id`, ESC_PRESSED's `landedId` (`number | 'global'`), or the switcher pair's
 * `windowId`. Distinct tag names so the log stays unambiguous about which
 * field produced the number (do not collapse these into one `id(N)`).
 */
function eventWindowIdTag(event: WindowEvent): string | null {
  const id = eventWindowId(event);
  if (id != null) return `id(${id})`;
  if (event.type === 'ESC_PRESSED') return `landed(${event.landedId})`;
  if (event.type === 'SWITCHER_OPEN_REQUESTED' || event.type === 'SWITCHER_OPENED') {
    return event.windowId == null ? null : `switcher(${event.windowId})`;
  }
  return null;
}

/** Render a nullable id for the transition log. */
function fmt(id: WindowId | null): string {
  return id == null ? 'none' : String(id);
}

/** `mode(id) x→y` fragments for every window whose fsMode name changed. */
function modeDeltas(before: StateSnapshot, after: StateSnapshot): string[] {
  const beforeById = new Map(before.windows.map((w) => [w.id, w.fsMode.name]));
  const parts: string[] = [];
  for (const w of after.windows) {
    const prev = beforeById.get(w.id);
    if (prev !== undefined && prev !== w.fsMode.name) {
      parts.push(`mode(${w.id}) ${prev}→${w.fsMode.name}`);
    }
  }
  return parts;
}
