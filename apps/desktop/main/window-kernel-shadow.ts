/**
 * window-kernel-shadow.ts — the one `WindowKernelExecutor` for the app, fed
 * from the old machine's production call sites and read by the production
 * code that needs a real answer.
 *
 * Blueprint: `docs/design/window-manager.md`. This module owns the single
 * `WindowKernelExecutor` for the app and translates every real input the old
 * machine sees — registration, OS focus, visibility, app activation, close
 * reports, teardown, stack-order import, raise, overlay attach — into the
 * kernel's own command/event vocabulary, at the call site that produces each
 * one today. The name and the "shadow" vocabulary throughout this file
 * (`compareShadowKernelState`, `NoopKernelBackend`, …) are load-bearing
 * history, not the current shape: this module was built to run the kernel in
 * SHADOW, feed-only, alongside the old machine, so its divergence comparator
 * could be trusted before anything depended on the kernel's decisions. That
 * period is over. `window-state-singleton.ts initWindowStateMachine` installs
 * a provider (`setKernelExecutorProvider`) that points `getShadowKernelExecutor()`
 * at the production kernel built over the real `ElectronWindowBackend`
 * (`window-kernel-singleton.ts`, `window-state-singleton.ts
 * getKernelExecutorForApp`) — from boot onward, every feed helper below drives
 * that executor, whose effects reach the OS for real. Production code also
 * now READS through this module's `getShadowKernelExecutor()` for decisions
 * that matter: the Cmd+W close target (`windows.ts
 * resolveFocusedWindowIdForClose`) and the saved session's window order
 * (`session.ts readKernelOrderFacts`) both resolve against the kernel's live
 * state, not the old machine's.
 *
 * WHAT STILL MAKES THIS SAFE TO CALL BLINDLY — one invariant survives cutover:
 * no exception from the kernel path escapes into the caller.
 * `shadowKernelRegisterWindow` and its siblings wrap their `execute`/`dispatch`
 * calls in try/catch and swallow (DEBUG-gated log only); a rejected command
 * (`decide` rejects on a stale `expectedVersion`) is likewise recorded, never
 * thrown. A feed caller can still invoke these without a try/catch of its own.
 *
 * THE NOOP BACKEND IS A PRE-CUTOVER FALLBACK, NOT WHAT PRODUCTION LANDS ON.
 * `NoopKernelBackend` below implements the whole `WindowBackend` surface
 * doing nothing but recording the call (a bounded ring,
 * `_shadowEffectLogForTests`) — that is what every feed helper drove before a
 * provider was installed, and it is still what a test gets when it never
 * installs one. `getShadowKernelExecutor()` only falls back to it when
 * `setKernelExecutorProvider` has not been called; production always calls it
 * at boot, so a production run never reaches this fallback.
 *
 * DIVERGENCE COMPARATOR. `compareShadowKernelState` (bottom of this file) is
 * a diagnostic read left over from the shadow period: it checks the kernel's
 * view against the old machine's current state and returns every mismatch.
 * Its logging is gated behind `PEEK_SHADOW_KERNEL_COMPARE=1` — unset (the
 * default), the comparator still runs but emits nothing, so a normal run pays
 * only for the comparison itself (a few array scans over a handful of
 * windows), never for a log line.
 */

import { DEBUG } from './config.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { isContentWindow, topmost, type Command, type DesktopMembership, type Event, type Rectangle, type WindowId, type WindowKind } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StateSnapshot } from './window-state.js';
import type { StackingLevel } from './izui-roles.js';

// ─────────────────────────────────────────────────────────────────────────────
// The no-op effect port
// ─────────────────────────────────────────────────────────────────────────────

/** One entry in the bounded shadow-effect ring — diagnostic only, never read by production. */
interface ShadowEffectLogEntry {
  name: string;
  args: unknown[];
}

const EFFECT_LOG_CAP = 50;
const effectLog: ShadowEffectLogEntry[] = [];

function recordEffect(name: string, ...args: unknown[]): void {
  effectLog.push({ name, args });
  if (effectLog.length > EFFECT_LOG_CAP) effectLog.shift();
  DEBUG && console.log('[window-kernel-shadow] effect (not performed):', name, ...args);
}

/** Test-only read of the bounded effect ring. */
export function _shadowEffectLogForTests(): readonly ShadowEffectLogEntry[] {
  return effectLog;
}

/**
 * The pre-cutover fallback `WindowBackend` — implements the whole port so a
 * new port method cannot be silently unimplemented here, and every method
 * performs NOTHING beyond recording that it was asked for. This is what made
 * shadow mode safe before cutover: the kernel could decide anything it liked
 * and nothing it decided reached a real window. `getShadowKernelExecutor()`
 * only builds an executor over this backend when no provider has been
 * installed (`installedProvider`) — production installs one at boot
 * (`window-state-singleton.ts initWindowStateMachine`), so this class backs
 * only tests and any executor use before that boot step runs.
 */
class NoopKernelBackend implements WindowBackend {
  attachAppListeners(): void {
    recordEffect('attachAppListeners');
  }
  raiseWindow(id: WindowId, opSeq: number): void {
    recordEffect('raiseWindow', id, opSeq);
  }
  focusContent(id: WindowId, opSeq: number): void {
    recordEffect('focusContent', id, opSeq);
  }
  setFullscreen(id: WindowId, on: boolean): void {
    recordEffect('setFullscreen', id, on);
  }
  reconcileFullscreen(id: WindowId): void {
    recordEffect('reconcileFullscreen', id);
  }
  closeOrHide(id: WindowId): Promise<void> {
    recordEffect('closeOrHide', id);
    return Promise.resolve();
  }
  askRendererToHandleEscape(id: WindowId, seq: number): Promise<void> {
    recordEffect('askRendererToHandleEscape', id, seq);
    return Promise.resolve();
  }
  attachEscHandler(id: WindowId): void {
    recordEffect('attachEscHandler', id);
  }
  setEscGrab(on: boolean): void {
    recordEffect('setEscGrab', on);
  }
  closeWindow(id: WindowId): Promise<void> {
    recordEffect('closeWindow', id);
    return Promise.resolve();
  }
  destroyWindow(id: WindowId): void {
    recordEffect('destroyWindow', id);
  }
  closeContent(id: WindowId): void {
    recordEffect('closeContent', id);
  }
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void {
    recordEffect('showWindow', id, opts);
  }
  hideWindow(id: WindowId): void {
    recordEffect('hideWindow', id);
  }
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    recordEffect('pinAlwaysOnTop', id, on);
  }
  destroyAllContentGuests(): Promise<void> {
    recordEffect('destroyAllContentGuests');
    return Promise.resolve();
  }
  setStacking(id: WindowId, level: StackingLevel): void {
    recordEffect('setStacking', id, level);
  }
  setWindowBounds(id: WindowId, rect: Rect): void {
    recordEffect('setWindowBounds', id, rect);
  }
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void {
    recordEffect('setDesktopMembership', id, membership);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The single shadow executor — lazily constructed, same pattern as
// `window-state-singleton.ts getWindowOsAdapter()`.
//
// EXECUTOR PROVIDER — the injection seam the cutover installs into, INJECTION
// NOT IMPORT, same shape as `izui-state.ts setFrontWindowIdProvider` /
// `hybrid-page-host-registry.ts registerHybridWindowClosedListener`: this
// module exposes a setter the production wiring calls IN, and never imports
// the production accessor itself. It cannot: the production executor
// (`window-kernel-singleton.ts getKernelExecutor`) is reached through
// `window-state-singleton.ts getKernelExecutorForApp()`, and value-importing
// that module here would (a) pull in `window-os-adapter.ts` →
// `electron-window-backend.ts`'s value `import { app } from 'electron'`, which
// throws under the `ELECTRON_RUN_AS_NODE=1` unit runner this module's own
// `.test.ts` suite runs under, and (b) close an import cycle —
// `window-state-singleton.ts` already value-imports THIS module for the feed
// helpers below, so importing it back would make the two modules mutually
// dependent.
//
// `getShadowKernelExecutor()` returns `installedProvider()` when one is
// installed, otherwise falls back to the lazily-constructed
// `NoopKernelBackend`-over instance below — the fallback is the PRE-CUTOVER
// DEFAULT, not a permanent second mode: nothing installs a provider yet, so
// every one of this file's ~25 call sites keeps landing on the noop-backed
// executor exactly as before this seam existed. The cutover is the single act
// of calling `setKernelExecutorProvider(() => getKernelExecutorForApp())` from
// production wiring; nothing else about this file changes at that point.
// ─────────────────────────────────────────────────────────────────────────────

let shadowExecutorInstance: WindowKernelExecutor | null = null;
let installedProvider: (() => WindowKernelExecutor) | null = null;

/**
 * Install the provider the cutover routes through — see the banner above.
 * Once installed, every call to `getShadowKernelExecutor()` (and so every feed
 * helper below) returns `provider()` instead of the noop-backed default.
 *
 * THROWS if the noop-backed fallback has already been constructed AND already
 * has one or more listeners attached (`WindowKernelExecutor.subscriberCount()`).
 * Installing a provider only changes what every feed helper WRITES to from
 * this point on — it does nothing for something that already READS from the
 * fallback via `subscribe`. That listener stays bound to the orphaned noop
 * instance forever: nothing production drives that object, this module
 * swallows every exception by design, so the subscription goes silently dead
 * for the rest of the process. Today the one such subscriber is
 * `window-state-singleton.ts subscribeFrontChange` (the shared chrome
 * overlay's retarget), and it only stays alive because the provider happens
 * to be installed before that subscription is ever made — nothing enforces
 * that order, so a reorder of boot wiring would kill the retarget with no
 * exception anywhere to point at it.
 *
 * NOT a violation of this module's swallow-everything rule (module header,
 * invariant 2) — that rule exists so a rejected or thrown KERNEL DECISION can
 * never change production behavior, because a caller invokes this module for
 * its diagnostic value alone. This throw is a different kind of failure: boot
 * wiring caught in a provably wrong order, discovered at the moment the
 * ordering violation becomes real. That must fail loudly at startup, not
 * degrade into a fallback executor nobody can ever hear from again.
 *
 * Constructing the fallback with NO subscribers — every ordinary feed call
 * before cutover installs one — is unaffected and keeps working exactly as
 * before: this only fires once something has actually subscribed to the
 * instance about to be orphaned.
 */
export function setKernelExecutorProvider(provider: () => WindowKernelExecutor): void {
  if (shadowExecutorInstance !== null && shadowExecutorInstance.subscriberCount() > 0) {
    throw new Error(
      '[window-kernel-shadow] setKernelExecutorProvider: a listener is already subscribed to the ' +
        'pre-cutover fallback executor and would never fire again once a provider is installed — ' +
        'install the provider before anything calls getShadowKernelExecutor().subscribe().',
    );
  }
  installedProvider = provider;
}

/**
 * The single shadow `WindowKernelExecutor` — `installedProvider()` if one is
 * installed, else the lazily-constructed noop-backed default. Constructed on
 * first use.
 */
export function getShadowKernelExecutor(): WindowKernelExecutor {
  if (installedProvider) return installedProvider();
  if (!shadowExecutorInstance) shadowExecutorInstance = new WindowKernelExecutor(new NoopKernelBackend());
  return shadowExecutorInstance;
}

/** Test-only: reset the shadow singleton (drops the executor + its state) and clears any installed provider. */
export function _resetShadowKernelForTests(): void {
  shadowExecutorInstance = null;
  installedProvider = null;
  effectLog.length = 0;
  lastDivergences = [];
}

/** Execute a command against the shadow kernel. Never throws; a rejection is logged, not surfaced. */
function shadowExecute(command: Command): void {
  try {
    const outcome = getShadowKernelExecutor().execute(command);
    if ('rejected' in outcome) {
      DEBUG && console.log('[window-kernel-shadow] command rejected:', command.type, outcome.rejected);
    }
  } catch (err) {
    DEBUG && console.log('[window-kernel-shadow] command threw:', command.type, err);
  }
}

/**
 * Feed a past-tense fact straight into the shadow kernel (`WindowKernelExecutor.dispatch`,
 * NOT `execute` — there is no `decide` step to reject, so this is the OS-focus
 * counterpart of `shadowExecute` above). Never throws.
 */
function shadowDispatch(event: Event): void {
  try {
    getShadowKernelExecutor().dispatch(event);
  } catch (err) {
    DEBUG && console.log('[window-kernel-shadow] event threw:', event.type, err);
  }
}

/**
 * Run `compareShadowKernelState` against the old machine's snapshot, for its
 * diagnostic value alone. Called at the tail of every feed helper below — not
 * just registration — so any input that can move either machine is covered,
 * never only the one call site that happened to exist first.
 *
 * `oldSnapshot` is supplied by the CALLER rather than read from
 * `window-state-singleton.ts` here: that module imports this one (for the
 * feed helpers themselves), and importing it back — even only for its
 * `getWindowOsAdapter()` accessor — pulls this otherwise-standalone module
 * into the full main-process graph (`window-state-singleton.ts` →
 * `izui-state.ts` → … → a value import of `electron`'s `app`), which breaks
 * `window-kernel-shadow.test.ts` running in isolation under the unit-test
 * harness. Every call site already holds (or can cheaply obtain) the old
 * machine's current snapshot, so it is threaded through instead.
 *
 * A pure read (see `compareShadowKernelState`'s own doc); wrapped the same
 * way `shadowExecute`/`shadowDispatch` are so a comparator failure can never
 * escape into the caller.
 */
function compareAfterFeed(oldSnapshot: StateSnapshot): void {
  try {
    lastDivergences = compareShadowKernelState(oldSnapshot);
  } catch (err) {
    DEBUG && console.log('[window-kernel-shadow] compare threw:', err);
  }
}

/** The divergences the most recent `compareAfterFeed` call found — test-only, so a spec can assert the comparator ran from a specific feed helper without depending on `PEEK_SHADOW_KERNEL_COMPARE`'s console output. */
let lastDivergences: ShadowKernelDivergence[] = [];

/** Test-only read of `lastDivergences`. */
export function _lastDivergencesForTests(): readonly ShadowKernelDivergence[] {
  return lastDivergences;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration — every `registerWindowWithMachine(...)` path
// (`window-state-singleton.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** The registration fields the kernel's `Event.WindowRegistered` needs — a subset of `MachineWindowSpec`. */
export interface ShadowRegisterWindowSpec {
  id: WindowId;
  kind: WindowKind;
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
  class: string;
  role?: string;
  parentId?: WindowId;
  keepLive?: boolean;
  /**
   * The old machine's four-value `EscapeMode`; only `'ignore'` is a kernel
   * decision input (see `WindowRecord.escapeMode`'s doc) — the caller passes
   * the raw value and this function narrows it.
   */
  escapeMode?: string;
  /** See `RegisterWindow.bounds`'s doc — the construction-time rect, when the caller has one. */
  bounds?: Rectangle;
}

/**
 * Translate a completed registration into the kernel's `RegisterWindow`
 * command. `oldSnapshot` is the old machine's snapshot taken AFTER it
 * processed this same registration (`window-state-singleton.ts
 * registerWindowWithMachine` — the settled point both machines have reached
 * by the time this is called) — see `compareAfterFeed`'s doc for why the
 * caller supplies it rather than this module reading it itself.
 */
export function shadowKernelRegisterWindow(spec: ShadowRegisterWindowSpec, oldSnapshot: StateSnapshot): void {
  shadowExecute({
    type: 'RegisterWindow',
    id: spec.id,
    kind: spec.kind,
    layer: spec.layer,
    canBecomeKey: spec.canBecomeKey,
    acceptsInput: spec.acceptsInput,
    class: spec.class,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
    ...(spec.keepLive !== undefined ? { keepLive: spec.keepLive } : {}),
    ...(spec.escapeMode === 'ignore' ? { escapeMode: 'ignore' as const } : {}),
    ...(spec.bounds !== undefined ? { bounds: spec.bounds } : {}),
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// OS focus — the second real input this step feeds the kernel (see
// `docs/design/window-manager.md` "Decided: the three calls the map revision
// was blocked on"). Both translations below are dispatched as EVENTS, not
// commands: an OS focus report is a past-tense fact, not a request `decide`
// can accept or reject, which is why they go through `WindowKernelExecutor
// .dispatch` rather than `.execute`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a genuine OS focus gain (`electron-window-backend.ts
 * attachNativeListeners` — the host window's `'focus'`, and the page-host
 * content WC's `'focus'` synthesized by an activating raise/show) into the
 * kernel's `OsFocusGained` event, naming the window that gained focus.
 *
 * NOT ALWAYS A SETTLED COMPARISON POINT: `electron-window-backend.ts`'s
 * `emit(...)` call immediately before this one can be RE-ENTRANT — a
 * `RAISE_WINDOW`/`SHOW_WINDOW` effect can synchronously provoke the native
 * `'focus'` this listener reacts to, from inside `WindowOsAdapter.pump`'s own
 * effect loop (see that method's re-entrancy doc). On that path `pump` only
 * ENQUEUES the old machine's own echo of this same focus change rather than
 * draining it, so `oldSnapshot` (read via the backend's `getSnapshot`
 * immediately after) reflects the state BEFORE this focus change, while the
 * shadow kernel (whose `dispatch` has no such queue) has already applied it.
 * A `front`/membership divergence logged from that specific call is expected
 * and transient — it resolves once the outer pump drains the queued event a
 * moment later — not evidence the two machines have actually diverged.
 */
export function shadowKernelOsFocusGained(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'OsFocusGained', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate the deferred-blur SETTLE (`electron-window-backend.ts
 * armBlurSettle`'s `OS_FOCUS_SETTLED_NULL`) into the kernel's `OsFocusLost`,
 * naming the currently-held `key` — never driven from the raw OS resign edge,
 * for the same macOS activation-dance reason the old machine's settle isn't.
 * The shapes deliberately differ from the old event: `OS_FOCUS_SETTLED_NULL`
 * carries no id (focus left the whole group), while `OsFocusLost` names a
 * window — so this emits nothing when no key is held, rather than a null-id
 * event the kernel has no vocabulary for.
 */
export function shadowKernelOsFocusSettled(oldSnapshot: StateSnapshot): void {
  const { key } = getShadowKernelExecutor().getState();
  if (key !== null) shadowDispatch({ type: 'OsFocusLost', id: key });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility — window-kernel.ts's `topmost(state, isContentWindow)` can only
// ever return a record whose `visible` is true (`isContentWindow`
// short-circuits on `!record.visible`, `window-kernel.ts`), and `RegisterWindow`
// always creates a record `visible: false`. Without this, no shadow record can
// ever become visible and the comparator's `front` check is comparing the old
// machine's real front against a permanent `null`. Translated at every
// production site that reports the old machine's mirrored `WINDOW_SHOWN` /
// `WINDOW_HIDDEN` (`electron-window-backend.ts`'s native `'show'`/`'hide'`
// listeners, `raiseWindow`, `showWindow`, `hideWindow`; `window-os-adapter.ts
// registerWindow`'s already-visible-at-registration import; `ipc.ts`'s
// headless open-time visibility import; `hybrid-overlay.ts`'s test-bridge
// `setActive`/`focusHost`/`focusContentWC`/`focusElsewhere`), dispatched as
// EVENTS (past-tense facts, same as OS focus above), alongside the existing
// old-machine dispatch, never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a completed show report into the kernel's `WindowShown` event —
 * and, when the show activated (`focused` true, the caller's `opts.activate`
 * in `electron-window-backend.ts showWindow` / the `focused:` field every
 * other `WINDOW_SHOWN` dispatch already carries), ALSO feed the companion
 * `Event.OsFocusGained` for the same window.
 *
 * WHY: `window-kernel.ts`'s `WindowShown` arm never reorders `order` — by
 * design, `OsFocusGained` is its only reorderer (see that file's RULE 1/2
 * commentary). But an activating show (`win.show()`, not `showInactive()`) IS
 * a focus gain in kernel terms, same as the old machine's `WINDOW_SHOWN` arm
 * calling `applyFocusGained` when `focused` is true. Without this, re-opening
 * an already-visible window through a reuse path
 * (`ipc.ts windowOpenHandler`'s four reuse branches, `windows.ts
 * showWindowHeadlessSafe`) moves the old machine's `front` but leaves the
 * shadow kernel's `topmost(state, isContentWindow)` on the previous window —
 * exactly the divergence a headless run measured. This function is the
 * translation at the shadow's edge; `window-kernel.ts` itself is untouched.
 *
 * NOT DOUBLE-COUNTING ON A REAL DISPLAY: there, an activating `win.show()`
 * also provokes a native `'focus'`, which already feeds `OsFocusGained`
 * through `shadowKernelOsFocusGained` via the normal focus listener. So the
 * synthetic feed below can arrive alongside a real echo for the same window —
 * harmless, because the second `OsFocusGained` names the window `key`
 * already holds, making its diff against the first empty. Headless masks OS
 * activation (`performOsShow` never calls `win.show()` there), which is
 * exactly why this divergence surfaced in a headless run in the first place:
 * headless has no OS echo to paper over the missing synthetic one.
 *
 * `focused` defaults to `false` (today's behavior — no companion focus feed)
 * for a caller that omits it, rather than guessing.
 */
export function shadowKernelWindowShown(id: WindowId, oldSnapshot: StateSnapshot, focused = false): void {
  shadowDispatch({ type: 'WindowShown', id });
  if (focused) shadowDispatch({ type: 'OsFocusGained', id });
  compareAfterFeed(oldSnapshot);
}

/** Translate a completed hide report into the kernel's `WindowHidden` event. */
export function shadowKernelWindowHidden(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'WindowHidden', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate the app becoming active (`electron-window-backend.ts
 * attachAppListeners`'s `did-become-active` → old machine `APP_ACTIVATED`)
 * into the kernel's `AppActivated` event — one of the three production inputs
 * that affect visibility: it re-shows every record still carrying
 * `hiddenByAppBlur` (`window-kernel.ts`'s `AppActivated` evolve arm), mirroring
 * the old machine's own re-show. The other two are `shadowKernelAppResigned`
 * and `shadowKernelAppResignSettled` directly below.
 */
export function shadowKernelAppActivated(oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'AppActivated' });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate the app resigning active (`electron-window-backend.ts
 * attachAppListeners`'s `did-resign-active` → old machine `APP_RESIGNED`)
 * into the kernel's `AppResigned` event — the ARM half of the app-switch
 * dance (`window-kernel.ts`'s `AppResigned` evolve arm): it sets
 * `appActive: false`, arms `pendingAppResignSweep`, AND — on this same raw
 * edge, not deferred to the settle — hides every attached overlay and every
 * `isAppResignSweepEligible` floater still visible (see that evolve arm's own
 * doc for why those two victim sets hide immediately rather than waiting out
 * the settle delay `shadowKernelAppResignSettled` handles below). Same shape
 * and containment as `shadowKernelAppActivated`: `shadowDispatch` (an event,
 * not a command — this is a past-tense fact `decide` never sees), ending with
 * the same `compareAfterFeed` tail.
 */
export function shadowKernelAppResigned(oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'AppResigned' });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate the deferred app-resign SETTLE (`electron-window-backend.ts
 * attachAppListeners`'s `APP_RESIGN_SETTLE_MS` timer → old machine
 * `APP_RESIGN_SETTLED`) into the kernel's `AppResignSettled` event — the
 * settle half of the same dance (`window-kernel.ts`'s `AppResignSettled`
 * evolve arm): inert unless `pendingAppResignSweep` is still armed, and when
 * armed, hides every sweep-eligible record (`isAppResignSweepEligible`) and,
 * when the app never came back active in between, writes `lastAttention`
 * `{ holder: null }` — the one write `react`'s transient-dismissal rule reads
 * (see this module's header / `window-kernel.ts` §0's autoclose exemption
 * doc). Same shape and containment as `shadowKernelAppResigned`.
 *
 * A BACKSTOP, NOT THE PRIMARY HIDE. `shadowKernelAppResigned` above already
 * hid every attached overlay and sweep-eligible floater on the raw
 * `AppResigned` edge — the kernel is what performs that hide now, over the
 * real backend, not the old machine (`window-os-adapter.ts runEffect`'s
 * `HIDE_WINDOW` arm is a no-op post-cutover). So by the time this settle
 * reaches the kernel, everything visible at the raw edge already reads
 * `visible: false`, and this arm's `isAppResignSweepEligible` sweep only
 * catches a record that became eligible in the window between the raw edge
 * and this 500ms settle (e.g. one registered and shown while Peek was already
 * backgrounded) — the same backstop `window-kernel.ts`'s `AppResignSettled`
 * arm documents on its own.
 */
export function shadowKernelAppResignSettled(oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'AppResignSettled' });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Teardown — the third real input this step feeds the kernel (see
// `docs/design/window-manager.md` "Decided: window teardown enters the kernel
// as commands and leaves as effects"). The four commands below are the ONLY
// way a teardown enters the kernel, translated at the production sites that
// dispatch the old machine's mirrored events today (`chrome-extensions.ts
// destroyWindowViaMachine`, `ipc.ts destroyUnassembledHybridHost` and
// `runHybridFinalize`'s content-close, `webview-guest-registry.ts
// destroyAllPageHostGuests`, `windows.ts closeHostWindow`, `hybrid-overlay.ts`'s
// test-bridge destroy).
//
// All four are exempt from `decide`'s unknown-window rejection (see each
// command's own doc in `window-kernel.ts`) — a call site can legitimately name
// a window whose record already retired microseconds earlier in the same
// synchronous body (the hybrid finalize race: `runHybridFinalize` retires the
// record via `finalizeWindowClose` before dispatching the content-close a few
// lines later). That exemption lives in `decide`, not here; `shadowExecute`'s
// existing try/catch is what keeps a rejection or a thrown error from ever
// reaching these callers, same as every command above.
// ─────────────────────────────────────────────────────────────────────────────

/** Translate a forceful native-destroy teardown into the kernel's `DestroyWindow` command. */
export function shadowKernelDestroyWindow(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'DestroyWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

/** Translate the hybrid finalize's content-surface teardown into the kernel's `CloseContent` command. */
export function shadowKernelCloseContent(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'CloseContent', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

/** Translate a guest-safe direct close (`windows.ts closeHostWindow`) into the kernel's `CloseWindowDirect` command. */
export function shadowKernelCloseWindowDirect(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'CloseWindowDirect', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

/** Translate the quit-time guest teardown into the kernel's `DestroyAllGuests` command. Names no window. */
export function shadowKernelDestroyAllGuests(oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'DestroyAllGuests', expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Close report — the fourth real input this step feeds the kernel.
// `window-kernel.ts` RULE 1 makes `WindowClosed` the ONLY event that shrinks
// `order`; the four teardown commands above deliberately retire no record.
// Without this, the shadow kernel's `order` only ever grows and diverges
// further from reality with every window that actually closes. Translated at
// every production site that reports a completed close to the old machine's
// mirrored `WINDOW_CLOSED` (`main.ts finalizeWindowClose`, that same handler's
// error-path fallback, `main.ts removeWindow`, and `electron-window-backend.ts`'s
// own native `'closed'` listener) — dispatched as an EVENT (past-tense fact,
// same as OS focus above), alongside the existing old-machine dispatch, never
// in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a completed close report into the kernel's `WindowClosed` event.
 * The backend's handle map (`idByOsWindowId`) and the kernel's own record map
 * diverge by design — a hybrid page-host never fires the native `'closed'`
 * that clears `idByOsWindowId` on the normal close path, so a caller can
 * legitimately name a window whose record already retired. `evolve` normalizes
 * an event naming an unknown window rather than rejecting it, so no guard is
 * needed here.
 */
export function shadowKernelWindowClosed(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'WindowClosed', id });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack-order import — the fifth real input this step feeds the kernel.
// Translated at the one production site that dispatches the old machine's
// mirrored `STACK_ORDER_IMPORTED` (`session.ts restoreSessionSnapshot`),
// alongside that dispatch, never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a session-restore stack-order import into the kernel's
 * `ImportStackOrder` command. `decide` answers this command before its
 * unknown-window guard — `order` may legitimately name ids that died mid-restore
 * — and `evolve`'s `StackOrderImported` arm is guard-free, assembling the
 * result out of the kernel's own `order` rather than the payload, so membership
 * is preserved by construction. None of that reconciliation belongs here;
 * this function only translates and feeds.
 */
export function shadowKernelImportStackOrder(order: readonly WindowId[], oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'ImportStackOrder', order, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Raise — the sixth real input this step feeds the kernel. Translated at the
// one production site that dispatches the old machine's mirrored
// `RAISE_WINDOW_REQUESTED` (`ipc.ts`'s modal-blur re-raise inside the
// show-settle window), alongside that dispatch, never in place of it.
//
// This closes the measured gap: a raise of an ALREADY-VISIBLE window moved the
// old machine's `front` but nothing fed the kernel a raise at all, so
// `topmost(state, isContentWindow)` stayed on whichever window was already
// topmost — observed live as a `front` divergence after re-opening a window
// that collapsed onto an existing one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate an explicit, user-requested raise into the kernel's `RaiseWindow`
 * command. Two consequences of `decide`/`react`'s existing shape are
 * DELIBERATELY not compensated for here:
 *
 *   - `decide` on `RaiseWindow` synchronously manufactures `OsFocusGained`, so
 *     the kernel's `key` moves optimistically, with no OS confirmation —
 *     unlike the old machine, which only ever moved `front` from the real OS
 *     echo. A known, recorded lossy port, not a bug this function works around.
 *   - `react` emits its own `RaiseWindow` effect off a `key` diff, and the OS
 *     echo that follows (`shadowKernelOsFocusGained`) names the window `key`
 *     already holds, so that echo's diff is empty and emits nothing. No
 *     de-duplication is added for it.
 *
 * Same shape and containment as `shadowKernelDestroyWindow` et al.: routed
 * through `shadowExecute` (a rejected stale `expectedVersion` is logged, never
 * thrown into the caller), ending with the same `compareAfterFeed` tail.
 */
export function shadowKernelRaiseWindow(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'RaiseWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay attach/detach (peek 7fffa286) — the seventh real input this step
// feeds the kernel. Translated at the two production sites that dispatch the
// old machine's mirrored `OVERLAY_ATTACH_REQUESTED` (`hybrid-overlay.ts`'s
// `retarget()` — a real `hostId`, attach or retarget — and
// `detachOverlayFromMachine()` — `hostId: null`, detach), alongside that
// dispatch, never in place of it.
//
// Closes the measured gap this feed was missing: `AttachOverlay` had no
// production dispatcher anywhere, so `WindowRecord.overlayFor` stayed
// permanently `undefined` in every real run even while the overlay was
// genuinely attached in the old machine's state (see `window-kernel.ts`'s doc
// on `WindowRecord.overlayFor` / the `AttachOverlay` command).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a completed overlay attach/retarget/detach report into the
 * kernel's `AttachOverlay` command — `hostId: null` is detach, the same one
 * transition the old machine's `OVERLAY_ATTACH_REQUESTED` is. Same shape and
 * containment as `shadowKernelRaiseWindow` et al.: routed through
 * `shadowExecute` (a rejected stale `expectedVersion`, or a `hostId`/
 * `overlayId` `decide` doesn't recognize, is logged, never thrown into the
 * caller), ending with the same `compareAfterFeed` tail.
 *
 * `frame` is the freshly expanded overlay frame for `hostId`, computed at the
 * caller's dispatch site the same way `OVERLAY_ATTACH_REQUESTED.frame` is
 * (`hybrid-overlay.ts retarget()`) — see `window-kernel.ts
 * WindowRecord.overlayFrame`'s doc for why the kernel takes this as data
 * rather than computing it. Omitted on a detach.
 */
export function shadowKernelAttachOverlay(overlayId: WindowId, hostId: WindowId | null, oldSnapshot: StateSnapshot, frame?: Rectangle): void {
  shadowExecute({
    type: 'AttachOverlay',
    overlayId,
    hostId,
    ...(frame !== undefined ? { frame } : {}),
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Content orderable — the eighth real input this step feeds the kernel.
// Translated at the one production site that dispatches the old machine's
// mirrored `WINDOW_CONTENT_ORDERABLE` (`session.ts
// installFirstFrameOrderableProducer`'s `ipcMain.on('hybrid:first-frame', ...)`
// handler), alongside that dispatch, never in place of it.
//
// THE HIGHEST-STAKES GAP OF THE FOUR THIS STEP CLOSES. `RegisterWindow` always
// creates a record `orderable: false` (window-kernel.ts), and
// `WindowContentOrderable` is the ONLY writer that ever flips it. Without this
// feed no shadow record can ever become orderable, and `topmostBaseLayerPageHost`
// (window-kernel.ts), whose predicate requires `orderable` alongside `visible`,
// returns null forever — not a transient divergence but a structural one, wrong
// from the very first composited frame of the very first window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a page-host's first-composited-frame report into the kernel's
 * `WindowContentOrderable` event — the sole writer of `orderable` (see the
 * banner above for why this is the highest-stakes of the four feeds this step
 * adds). `evolve`'s arm never resets `orderable` back to false and no-ops on
 * an unregistered id, so no guard is needed here.
 */
export function shadowKernelWindowContentOrderable(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'WindowContentOrderable', id });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Content first responder — the ninth real input this step feeds the kernel.
// Translated at the two production sites that dispatch the old machine's
// mirrored `CONTENT_FIRST_RESPONDER_CHANGED` (`electron-window-backend.ts
// attachNativeListeners`'s page-host content WC `'focus'`/`'blur'` listeners),
// alongside each existing dispatch, never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a page-host content WC's first-responder change into the kernel's
 * `ContentFirstResponderChanged` event — a mechanical mirror write
 * (window-kernel.ts's evolve arm), the sole writer of `contentFocused`. `held`
 * is stored as reported, same as the old machine: the kernel never infers
 * first-responder status, only records what the OS said.
 */
export function shadowKernelContentFirstResponderChanged(id: WindowId, held: boolean, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'ContentFirstResponderChanged', id, held });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a window's post-registration click-through change into the
 * kernel's `WindowAcceptsInputChanged` event — a mechanical mirror write
 * (window-kernel.ts's evolve arm), the sole post-registration writer of
 * `acceptsInput`. `acceptsInput` is stored as reported: the kernel never
 * infers click-through state, only records what the causing site already did
 * (see the event's own doc for why this is fed rather than observed).
 */
export function shadowKernelWindowAcceptsInputChanged(id: WindowId, acceptsInput: boolean, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'WindowAcceptsInputChanged', id, acceptsInput });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cold-start focus latch — the tenth real input this step feeds the kernel.
// Translated at the two production sites that dispatch the old machine's
// mirrored `COLD_START_FOCUS_ARMED` (`session.ts restoreSessionSnapshot` — the
// clearing dispatch at the top of every restore pass, and the arming dispatch
// inside the cold-start activation block), alongside each existing dispatch,
// never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate an arm-or-clear of the cold-start focus latch into the kernel's
 * `ArmColdStartFocus` command — `id: null` is the clear, the same one payload
 * shape `ColdStartFocusArmed`/`State.pendingColdStartFocus` carries (see that
 * event's own doc in `window-kernel.ts`). Answered before the generic
 * unknown-window guard, exactly as `decide` itself does — there is no window
 * here to guard existence against on either payload shape, so a `null` clear
 * and a real id naming a window not yet registered are both legitimate
 * traffic. Same shape and containment as `shadowKernelAttachOverlay` et al.:
 * routed through `shadowExecute`, ending with the same `compareAfterFeed` tail.
 */
export function shadowKernelArmColdStartFocus(id: WindowId | null, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'ArmColdStartFocus', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Focus assert — the eleventh real input this step feeds the kernel.
// Translated at the two production sites that dispatch the old machine's
// shared `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` arm (`main.ts configure`'s
// `wc.on('devtools-opened')`/`wc.on('devtools-closed')` handlers), alongside
// each existing dispatch, never in place of it.
//
// THE OLD ARM'S TARGET IS NOT THE DEVTOOLS WINDOW. `window-state.ts`'s shared
// `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` case deliberately leaves `event.id` (the
// devtools host id) unused and instead re-raises `state.front` — the window
// that actually lost key when devtools took it. The kernel's `AssertFocus` is
// answered against `topmost(state, isContentWindow)` in the general case (see
// that command's own doc), but at THIS call site the caller supplies whatever
// the old machine's settled snapshot names as `front`, mirroring the old arm's
// own target rather than assuming it is the devtools window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a re-raise-the-content-window request into the kernel's
 * `AssertFocus` command, naming the window the caller resolved as the target
 * (see the banner above for why that is never the devtools window itself).
 * NOT exempt from `decide`'s unknown-window rejection (`AssertFocus`'s own doc
 * in `window-kernel.ts`) — a target absent from the shadow kernel's `order` is
 * logged by `shadowExecute` as a rejection, never thrown into the caller. Same
 * shape and containment as `shadowKernelRaiseWindow` et al.
 */
export function shadowKernelAssertFocus(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'AssertFocus', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fullscreen — the twelfth real input this step feeds the kernel. Translated
// at every production site that dispatches the old machine's mirrored
// `OS_FULLSCREEN_ENTERED` / `OS_FULLSCREEN_LEFT` / `FULLSCREEN_SETTLE_TIMEOUT`
// (`electron-window-backend.ts`'s native `'enter-full-screen'`/
// `'leave-full-screen'` listeners, `reconcileFullscreen`'s sanctioned
// `isFullScreen()` read, and `armFullscreenSettle`'s bounded timer) and
// `FULLSCREEN_REQUESTED` (`hybrid-overlay.ts`'s test-bridge
// `driveHostFullscreen`, `ipc.ts runHybridFinalize`, `windows.ts
// closeOrHideWindow`, and `tile-ipc.ts`'s `tile:window:hide` /
// `tile:window:fullscreen` handlers), alongside each existing dispatch,
// never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a completed native fullscreen-entered report into the kernel's
 * `OsFullscreenEntered` event — settles `entering` -> `fullscreen`, or
 * straight through to `leaving` on a coalesced cancel (`nextFsModeForOsEntered`,
 * `window-kernel.ts`).
 */
export function shadowKernelOsFullscreenEntered(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'OsFullscreenEntered', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a completed native fullscreen-left report into the kernel's
 * `OsFullscreenLeft` event — settles `leaving` -> `normal`, or straight
 * through to `entering` on a coalesced re-enter (`nextFsModeForOsLeft`,
 * `window-kernel.ts`).
 */
export function shadowKernelOsFullscreenLeft(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'OsFullscreenLeft', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate the bounded fullscreen settle timeout into the kernel's
 * `FullscreenSettleTimeout` event. Does NOT force-settle `fsMode` itself —
 * `evolve`'s arm never guesses; it only records the ask (`lastFsReconcile`,
 * answered by `react`'s own `ReconcileFullscreen` effect) for a record still
 * genuinely in flight, leaving every `fsMode` exactly where it was
 * (`window-kernel.ts`'s `FullscreenSettleTimeout` arm doc: a wrong guess
 * strands `preBounds` or leaves a black macOS Space behind — the machine
 * asks the OS rather than guessing).
 */
export function shadowKernelFullscreenSettleTimeout(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'FullscreenSettleTimeout', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a fullscreen request into the kernel's `SetFullscreen` command.
 * `decide`'s own arm resolves what happens next from the window's CURRENT
 * `fsMode` (`window-kernel.ts`'s `SetFullscreen` case): idle ->
 * `FullscreenTransitionStarted`, already in flight (`entering`/`leaving`) ->
 * `FullscreenDesireRecorded` (coalesced, no second transition started),
 * already at the requested state -> `[]` (no-op, no OS call). None of that
 * branching is reproduced here — the command is executed and `decide`
 * decides. Same shape and containment as `shadowKernelRaiseWindow` et al.:
 * routed through `shadowExecute` (a rejected stale `expectedVersion`, or a
 * target absent from `order`, is logged, never thrown into the caller),
 * ending with the same `compareAfterFeed` tail.
 */
export function shadowKernelSetFullscreen(id: WindowId, desired: boolean, oldSnapshot: StateSnapshot): void {
  shadowExecute({
    type: 'SetFullscreen',
    id,
    desired,
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — the thirteenth real input this step feeds the kernel. Translated
// at every production site that dispatches the old machine's mirrored
// `BOUNDS_CHANGED` (`electron-window-backend.ts attachNativeListeners`'s
// `emitBounds` closure — the sole production writer of native bounds truth),
// `DISPLAY_CHANGED` (`display-watcher.ts projectAllWindows`),
// `MAXIMIZE_EXITED_BY_RESIZE` (`ipc.ts exitMaximizeForResize`), and
// `SET_BOUNDS_REQUESTED` (every dispatch site that computes a target rect and
// hands it to the reducer — `ipc.ts`'s reuse placement, band-drag resize,
// `page:set-bounds`, and open-time maximize-as-bounds; `tile-ipc.ts`'s
// `tile:window:center`, `tile:window:center-all`, and `tile:window:set-bounds`),
// alongside each existing dispatch, never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a completed native resize/move report into the kernel's
 * `BoundsChanged` event — the sole writer of `WindowRecord.bounds` for a
 * genuine OS report (`decide`'s translations of `SetBounds`/`Maximize`/
 * `Unmaximize` below reuse this same event shape rather than a second one).
 * The old machine's `BOUNDS_CHANGED.bounds` and the kernel's own `Rectangle`
 * are the SAME type (`window-state.ts` imports `Rectangle` from
 * `window-kernel.ts`), so no conversion is needed at this boundary.
 *
 * `overlayFrame` mirrors `BOUNDS_CHANGED.overlayFrame` — the freshly
 * expanded overlay frame for `id`, when `id` is hosting the shared chrome
 * overlay (`electron-window-backend.ts attachNativeListeners`'s `emitBounds`
 * closure already computes this for every page-host's bounds report for the
 * old machine's own dispatch; it needs threading through to THIS call too).
 * See `window-kernel.ts WindowRecord.overlayFrame`'s doc for why the frame
 * rides here as data rather than being computed inside the kernel.
 */
export function shadowKernelBoundsChanged(id: WindowId, bounds: Rectangle, oldSnapshot: StateSnapshot, overlayFrame?: Rectangle): void {
  shadowDispatch({ type: 'BoundsChanged', id, bounds, ...(overlayFrame !== undefined ? { overlayFrame } : {}) });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a completed display-layout reprojection into the kernel's
 * `DisplayChanged` event — one already-computed target rect per affected
 * window, same `{id, bounds}` shape as the old machine's `projected` array.
 * `evolve`'s arm (`window-kernel.ts`'s `DisplayChanged` case) holds a
 * blocked window's projection on `pendingProjectedBounds` instead of
 * applying it (non-`normal` `fsMode` or `visible: false`) and leaves a
 * window this event does not name untouched. None of that branching is
 * reproduced here — the event is dispatched and `evolve` decides.
 */
export function shadowKernelDisplayChanged(
  projections: ReadonlyArray<{ id: WindowId; bounds: Rectangle }>,
  oldSnapshot: StateSnapshot,
): void {
  shadowDispatch({ type: 'DisplayChanged', projections });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a resize gesture's maximize-invalidation into the kernel's
 * `MaximizeExitedByResize` event — clears `maximized` + `preMaxBounds`,
 * drives nothing back at the OS: the gesture itself owns the window's
 * bounds. Guard-free at the shadow's edge, same as `evolve`'s own arm (a
 * not-maximized record already holds these values, so this is an idempotent
 * no-op for it — the old reducer's "not maximized -> nothing to restore"
 * guard is unnecessary here).
 */
export function shadowKernelMaximizeExitedByResize(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowDispatch({ type: 'MaximizeExitedByResize', id });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate an explicit bounds request into the kernel's `SetBounds`
 * command. `decide`'s own arm (`window-kernel.ts`'s `SetBounds` case)
 * answers this before any translation happens here: `fsMode` non-`normal`
 * -> `[]` (no-op — fullscreen owns the display, the aa34cb50 family), else
 * `PendingProjectionDiscarded` + `BoundsChanged{bounds: cmd.bounds}` (an
 * explicit geometry decision supersedes any held `DisplayChanged`
 * projection, discarding it without flushing). None of that branching is
 * reproduced here — the command is executed and `decide` decides. Same
 * shape and containment as `shadowKernelRaiseWindow` et al.: routed through
 * `shadowExecute` (a rejected stale `expectedVersion` is logged, never
 * thrown into the caller), ending with the same `compareAfterFeed` tail.
 */
export function shadowKernelSetBounds(id: WindowId, bounds: Rectangle, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'SetBounds', id, bounds, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Maximize / unmaximize — the fourteenth real input this step feeds the
// kernel. Translated at every production site that dispatches the old
// machine's mirrored `MAXIMIZE_REQUESTED` (`ipc.ts`'s `page:maximize`
// subscribe, `tile-ipc.ts`'s `tile:window:maximize` handler) and
// `UNMAXIMIZE_REQUESTED` (`ipc.ts`'s `page:unmaximize` subscribe,
// `tile-ipc.ts`'s `tile:window:unmaximize` handler), alongside each existing
// dispatch, never in place of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a maximize request into the kernel's `Maximize` command.
 * `workArea` is the display work-area rect the caller already resolved
 * (`screen.getDisplayNearestPoint`/`getDisplayMatching`) — platform data
 * `window-kernel.ts` cannot read under its zero-value-import rule, so it
 * rides the command as data, the same shape `459ed219` used for
 * `AttachOverlay.frame`: optional here too, for the same reason (see the
 * command's own doc) — omitted, `decide` still flips the flag, it just
 * skips the paired `BoundsChanged`. `decide`'s own branching: `fsMode`
 * non-`normal` -> `[]` (the aa34cb50 family, same guard as `SetBounds`);
 * already `maximized` -> `[]` (no new rect to snap to — a no-op rather than
 * a re-snap, the port of the old reducer's idempotent-remaximize trap);
 * else `PendingProjectionDiscarded` + `Maximized{preMaxBounds: rec.bounds ??
 * null}` + (when `workArea` was given) `BoundsChanged{bounds: workArea}` —
 * the actual snap. None of that branching is reproduced here. Same shape
 * and containment as `shadowKernelSetBounds`.
 */
export function shadowKernelMaximize(id: WindowId, oldSnapshot: StateSnapshot, workArea?: Rectangle): void {
  shadowExecute({
    type: 'Maximize',
    id,
    ...(workArea !== undefined ? { workArea } : {}),
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate an unmaximize request into the kernel's `Unmaximize` command.
 * `decide`'s own branching: not `maximized` -> `[]` (nothing to restore);
 * else `PendingProjectionDiscarded` + `Unmaximized`, PLUS a `BoundsChanged`
 * restoring the stash when `preMaxBounds` is non-null (a null stash just
 * clears the flag — nowhere to restore to). None of that branching is
 * reproduced here. Same shape and containment as `shadowKernelMaximize`.
 */
export function shadowKernelUnmaximize(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'Unmaximize', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop membership — the fifteenth real input this step feeds the kernel,
// now from BOTH production sites that dispatch one of the old machine's two
// mirrored Spaces events, alongside each dispatch, never in place of it:
//
//   - `tile-ipc.ts`'s `tile:window:set-visible-on-all-workspaces` handler
//     (the raw path, `SET_VISIBLE_ON_ALL_SPACES_REQUESTED`) — the renderer's
//     boolean is the SAME on/off fact `DesktopMembership` names, so it is
//     translated directly (`true` -> `'follow'`, `false` -> `'anchor'`)
//     rather than carried as a second, boolean-shaped command.
//   - `ipc.ts windowOpenHandler()` and its keepLive-reuse path
//     (`SPACES_POLICY_REQUESTED`) — role-derived. What used to block this feed
//     was that the boolean command could not express `'follow'`/`'anchor'`
//     without re-implementing the reducer's ordered-pair expansion at the
//     shadow's edge; the kernel's `SetDesktopMembership` command carries the
//     resolved intention directly; that expansion now lives in
//     `electron-window-backend.ts setDesktopMembership`, never here or in the
//     kernel. Both call sites already compute the role's policy for their old
//     dispatch (`izui-roles.ts spacesPolicyForRole`); feeding this helper is a
//     direct reuse of that same value, skipping only the platform-derived
//     `'none'` answer (see `izui-roles.ts desktopMembershipForRole` for why
//     the kernel never carries that third value at all).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a desktop-membership request into the kernel's
 * `SetDesktopMembership` command — `decide`'s arm (`window-kernel.ts`'s
 * `SetDesktopMembership` case) is unconditional, always emitting
 * `DesktopMembershipSet{membership: cmd.membership}`; no branching to
 * reproduce. Same shape and containment as `shadowKernelMaximize` et al.
 */
export function shadowKernelSetDesktopMembership(id: WindowId, membership: DesktopMembership, oldSnapshot: StateSnapshot): void {
  shadowExecute({
    type: 'SetDesktopMembership',
    id,
    membership,
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Show / hide / close-or-hide requests — feeds the kernel's `ShowWindow`,
// `HideWindow`, and `CloseOrHideWindow` commands.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a window-show request into the kernel's `ShowWindow` command,
 * and, when the show also activates, a SECOND `RaiseWindow` command
 * immediately after. Two commands, not one, because kernel `ShowWindow` is
 * always non-activating, and the event it produces on the focus-gain side —
 * `OsFocusGained` — never writes `visible` (`window-kernel.ts`'s evolve arm):
 * visibility and key are separate stored facts, each written only by its own
 * event, so neither command alone reproduces an activating show.
 */
export function shadowKernelShowRequested(id: WindowId, activate: boolean, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'ShowWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  if (activate) {
    shadowExecute({ type: 'RaiseWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  }
  compareAfterFeed(oldSnapshot);
}

/** Translate a window-hide request into the kernel's `HideWindow` command. */
export function shadowKernelHideRequested(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'HideWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

/**
 * Translate a close-or-hide request into the kernel's `CloseOrHideWindow`
 * command. The keepLive branch (hide if keepLive, else close) is decided
 * inside the kernel's own `decide()` arm for this command, not here — the
 * caller passes no keepLive flag.
 */
export function shadowKernelCloseOrHideRequested(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowExecute({ type: 'CloseOrHideWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Divergence comparator — a diagnostic left running post-cutover: it still
// checks the kernel's view against the old machine's on every settled input,
// for the three things the cutover's readers (`windows.ts
// resolveFocusedWindowIdForClose`, `session.ts readKernelOrderFacts`, …)
// actually depend on. See `compareShadowKernelState`'s own doc below for what
// each check does and does not claim.
// ─────────────────────────────────────────────────────────────────────────────

/** One divergence between the old machine and the shadow kernel — see `compareShadowKernelState`. */
export interface ShadowKernelDivergence {
  kind: 'membership' | 'front' | 'stackOrder';
  old: unknown;
  kernel: unknown;
}

/**
 * Compare the shadow kernel's view against the old machine's CURRENT state
 * (a `window-state.ts snapshot()`), for the three things the cutover's
 * readers actually depend on:
 *
 *   - **membership** — `oldMachine.windows` (the old machine's record set)
 *     versus the kernel's `order` — same ids present, order aside.
 *   - **the main/front window** — `oldMachine.front` versus
 *     `topmost(kernelState, isContentWindow)` (`window-kernel.ts`). These are
 *     NOT expected to be identical by definition: `front` was trying to be
 *     AppKit's *main* window while being written from focus events, which is
 *     exactly the drift this conversion exists to fix. A mismatch here may be
 *     the OLD machine being wrong — this reports both values rather than
 *     judging it.
 *   - **stacking order** — `oldMachine.stackOrder` versus the kernel's
 *     `order`, each restricted to the ids BOTH machines hold a record for.
 *     Comparing the raw sequences would also flag every id one machine simply
 *     doesn't know about yet (already reported by the membership check above)
 *     as if it were a stacking disagreement, which it isn't.
 *
 * `keyWindow(kernelState)` (`window-kernel.ts`) is deliberately NOT compared
 * against `front` here — `key` is the key window and replaces none of the old
 * readers `front` and `topmost(state, isContentWindow)` do.
 *
 * A PURE READ: never dispatches, never mutates either machine, performs no
 * effect. The comparison always runs (cheap — a few array scans over a
 * handful of windows); only the console line per divergence is gated behind
 * `PEEK_SHADOW_KERNEL_COMPARE=1`, so a caller can call this on every settled
 * input for its return value alone with no cost when the flag is unset.
 */
export function compareShadowKernelState(oldMachine: StateSnapshot): ShadowKernelDivergence[] {
  const kernelState = getShadowKernelExecutor().getState();
  const divergences: ShadowKernelDivergence[] = [];

  const oldIds = oldMachine.windows.map((w) => w.id);
  const oldIdSet = new Set(oldIds);
  const kernelIds = kernelState.order.map((r) => r.id);
  const kernelIdSet = new Set(kernelIds);
  const sameMembership = oldIdSet.size === kernelIdSet.size && oldIds.every((id) => kernelIdSet.has(id));
  if (!sameMembership) {
    divergences.push({ kind: 'membership', old: oldIds, kernel: kernelIds });
  }

  const kernelFront = topmost(kernelState, isContentWindow)?.id ?? null;
  if (oldMachine.front !== kernelFront) {
    divergences.push({ kind: 'front', old: oldMachine.front, kernel: kernelFront });
  }

  // Restrict both sequences to ids present in BOTH record sets, preserving
  // each machine's own relative order, before comparing.
  const oldStackRestricted = oldMachine.stackOrder.filter((id) => kernelIdSet.has(id));
  const kernelOrderRestricted = kernelIds.filter((id) => oldIdSet.has(id));
  const sameStackOrder =
    oldStackRestricted.length === kernelOrderRestricted.length &&
    oldStackRestricted.every((id, i) => id === kernelOrderRestricted[i]);
  if (!sameStackOrder) {
    divergences.push({ kind: 'stackOrder', old: oldStackRestricted, kernel: kernelOrderRestricted });
  }

  if (process.env.PEEK_SHADOW_KERNEL_COMPARE === '1') {
    for (const d of divergences) {
      console.log(
        `[window-kernel-shadow] divergence kind=${d.kind} old=${JSON.stringify(d.old)} kernel=${JSON.stringify(d.kernel)}`,
      );
    }
  }

  return divergences;
}
