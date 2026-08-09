/**
 * window-kernel-shadow.ts — the one `WindowKernelExecutor` running in SHADOW
 * alongside the production `WindowOsAdapter` (`window-state-singleton.ts`).
 *
 * Blueprint: `docs/design/window-manager.md`. This module owns the single
 * `WindowKernelExecutor` for the app and translates registration — the one
 * real input this step feeds it — into the kernel's own command vocabulary,
 * at the call site that produces it today (`window-state-singleton.ts
 * registerWindowWithMachine`). Nothing reads FROM the kernel here: this is
 * feed-only, one direction, and authoritative over nothing. Later steps feed
 * it OS focus, teardown, and stack-order import; none of that exists yet.
 *
 * WHY THIS CANNOT CHANGE PRODUCTION BEHAVIOR — two invariants, both load-bearing:
 *
 *   1. **The effect port is a no-op.** `NoopKernelBackend` below implements
 *      the whole `WindowBackend` surface, and every method just records the
 *      call (a bounded ring, `_shadowEffectLogForTests`) and returns — no
 *      native call, no promise resolving against real work. So even a kernel
 *      decision that diverges from the old machine's never reaches the OS:
 *      the executor's effects have nowhere to land.
 *   2. **No exception from the kernel path escapes into the caller.**
 *      `shadowKernelRegisterWindow` wraps its `execute` call in try/catch and
 *      swallows (DEBUG-gated log only); a rejected command (`decide` rejects
 *      on a stale `expectedVersion`) is likewise recorded, never thrown. A
 *      caller invokes it for its diagnostic value alone — it must behave
 *      exactly as if the call were never made, whatever the kernel does
 *      internally.
 *
 * Together these mean: the OS is still driven solely by `window-state.ts` +
 * `WindowOsAdapter`, exactly as before this file existed. The kernel runs the
 * same registrations through `decide`/`evolve` for comparison value only.
 *
 * DIVERGENCE COMPARATOR. `compareShadowKernelState` (bottom of this file) is
 * the one place this module reads FROM the kernel for diagnostic value: it
 * checks the shadow's view against the old machine's current state and
 * returns every mismatch. Its logging is gated behind
 * `PEEK_SHADOW_KERNEL_COMPARE=1` — unset (the default), the comparator still
 * runs but emits nothing, so a normal run pays only for the comparison itself
 * (a few array scans over a handful of windows), never for a log line.
 */

import { DEBUG } from './config.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { isContentWindow, topmost, type Command, type Event, type WindowId, type WindowKind } from './window-kernel.js';
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
 * The shadow's `WindowBackend` — implements the whole port so a new port
 * method cannot be silently unimplemented here, and every method performs
 * NOTHING beyond recording that it was asked for. This is what makes shadow
 * mode safe: the kernel can decide anything it likes and nothing it decides
 * ever reaches a real window.
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
  setVisibleOnAllSpaces(
    id: WindowId,
    on: boolean,
    opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void {
    recordEffect('setVisibleOnAllSpaces', id, on, opts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The single shadow executor — lazily constructed, same pattern as
// `window-state-singleton.ts getWindowOsAdapter()`.
// ─────────────────────────────────────────────────────────────────────────────

let shadowExecutorInstance: WindowKernelExecutor | null = null;

/** The single shadow `WindowKernelExecutor`. Constructed on first use. */
export function getShadowKernelExecutor(): WindowKernelExecutor {
  if (!shadowExecutorInstance) shadowExecutorInstance = new WindowKernelExecutor(new NoopKernelBackend());
  return shadowExecutorInstance;
}

/** Test-only: reset the shadow singleton (drops the executor + its state). */
export function _resetShadowKernelForTests(): void {
  shadowExecutorInstance = null;
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
 * `appActive: false` and arms `pendingAppResignSweep`, hiding nothing yet.
 * Same shape and containment as `shadowKernelAppActivated`: `shadowDispatch`
 * (an event, not a command — this is a past-tense fact `decide` never sees),
 * ending with the same `compareAfterFeed` tail.
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
 * NOT A COMPLETE SHADOW OF THE HIDE/RE-SHOW HALF. The old machine hides these
 * windows FIRST (its own `did-resign-active` handling runs synchronously,
 * well before this 500ms settle), so by the time this event reaches the
 * kernel the records it would mark `hiddenByAppBlur` already read
 * `visible: false` from the native `'hide'` listener's earlier
 * `shadowKernelWindowHidden` feed — and `isAppResignSweepEligible` requires
 * `visible`, so this arm finds nothing to sweep and the kernel's `visible`
 * mirror never contradicts the old machine's. The comparator does not check
 * `visible` at all, so a clean shadow run here is evidence the compared
 * facts (membership/front/stackOrder) hold — NOT evidence the hide/re-show
 * behavior itself has been proven equivalent. That resolves only at cutover,
 * when the kernel becomes the one deciding what to hide.
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
 */
export function shadowKernelAttachOverlay(overlayId: WindowId, hostId: WindowId | null, oldSnapshot: StateSnapshot): void {
  shadowExecute({
    type: 'AttachOverlay',
    overlayId,
    hostId,
    expectedVersion: getShadowKernelExecutor().getState().version,
  });
  compareAfterFeed(oldSnapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Divergence comparator — evidence the shadow kernel's view matches reality
// before the next commit re-points readers onto it. Compares the three things
// the cutover's readers actually depend on; see `compareShadowKernelState`'s
// own doc below for what each check does and does not claim.
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
