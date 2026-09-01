/**
 * window-kernel-dispatch.ts — the one `WindowKernelExecutor` for the app, fed
 * from the old machine's production call sites and read by the production
 * code that needs a real answer.
 *
 * Blueprint: `docs/design/window-manager.md`. This module owns the single
 * `WindowKernelExecutor` for the app and translates every real input the old
 * machine sees — registration, OS focus, visibility, app activation, close
 * reports, teardown, stack-order import, raise, overlay attach — into the
 * kernel's own command/event vocabulary, at the call site that produces each
 * one today. `window-machine.ts initWindowStateMachine` installs a
 * provider (`setKernelExecutorProvider`) that points `getKernelExecutor()`
 * at the production kernel built over the real `ElectronWindowBackend`
 * (`window-kernel-singleton.ts`, `window-machine.ts
 * getKernelExecutorForApp`) — from boot onward, every feed helper below drives
 * that executor, whose effects reach the OS for real. Production code also
 * now READS through this module's `getKernelExecutor()` for decisions
 * that matter: the Cmd+W close target (`windows.ts
 * resolveFocusedWindowIdForClose`) and the saved session's window order
 * (`session.ts readKernelOrderFacts`) both resolve against the kernel's live
 * state, not the old machine's.
 *
 * WHAT STILL MAKES THIS SAFE TO CALL BLINDLY — one invariant survives cutover:
 * no exception from the kernel path escapes into the caller.
 * `kernelRegisterWindow` and its siblings wrap their `execute`/`dispatch`
 * calls in try/catch and swallow (DEBUG-gated log only); a rejected command
 * (`decide` rejects on a stale `expectedVersion`) is likewise recorded, never
 * thrown. A feed caller can still invoke these without a try/catch of its own.
 *
 * THE NOOP BACKEND IS A PRE-CUTOVER FALLBACK, NOT WHAT PRODUCTION LANDS ON.
 * `NoopKernelBackend` below implements the whole `WindowBackend` surface
 * doing nothing but recording the call (a bounded ring,
 * `_kernelEffectLogForTests`) — that is what every feed helper drove before a
 * provider was installed, and it is still what a test gets when it never
 * installs one. `getKernelExecutor()` only falls back to it when
 * `setKernelExecutorProvider` has not been called; production always calls it
 * at boot, so a production run never reaches this fallback.
 *
 * NO DIVERGENCE COMPARATOR ANY LONGER. This module used to also check the
 * kernel's view against the old machine's current state on every feed
 * (`compareKernelState`, gated behind `PEEK_SHADOW_KERNEL_COMPARE`) —
 * both are gone. The kernel is the only machine now; there is nothing left to
 * diff it against.
 */

import { DEBUG } from './config.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { type Command, type DesktopMembership, type Event, type FocusCause, type Rectangle, type WindowId, type WindowKind } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel } from './izui-roles.js';

// ─────────────────────────────────────────────────────────────────────────────
// The no-op effect port
// ─────────────────────────────────────────────────────────────────────────────

/** One entry in the bounded effect-log ring — diagnostic only, never read by production. */
interface KernelEffectLogEntry {
  name: string;
  args: unknown[];
}

const EFFECT_LOG_CAP = 50;
const effectLog: KernelEffectLogEntry[] = [];

function recordEffect(name: string, ...args: unknown[]): void {
  effectLog.push({ name, args });
  if (effectLog.length > EFFECT_LOG_CAP) effectLog.shift();
  DEBUG && console.log('[window-kernel-dispatch] effect (not performed):', name, ...args);
}

/** Test-only read of the bounded effect ring. */
export function _kernelEffectLogForTests(): readonly KernelEffectLogEntry[] {
  return effectLog;
}

/**
 * The pre-cutover fallback `WindowBackend` — implements the whole port so a
 * new port method cannot be silently unimplemented here, and every method
 * performs NOTHING beyond recording that it was asked for. This is what makes
 * the pre-cutover fallback safe: the kernel could decide anything it liked
 * and nothing it decided reached a real window. `getKernelExecutor()`
 * only builds an executor over this backend when no provider has been
 * installed (`installedProvider`) — production installs one at boot
 * (`window-machine.ts initWindowStateMachine`), so this class backs
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
  askRendererHandledEscape(id: WindowId): Promise<boolean> {
    recordEffect('askRendererHandledEscape', id);
    return Promise.resolve(false);
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
  hideWindow(id: WindowId, opSeq?: number): void {
    recordEffect('hideWindow', id, opSeq);
  }
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    recordEffect('pinAlwaysOnTop', id, on);
  }
  destroyAllContentGuests(): Promise<void> {
    recordEffect('destroyAllContentGuests');
    return Promise.resolve();
  }
  hideApp(): void {
    recordEffect('hideApp');
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
  setAcceptsInput(id: WindowId, acceptsInput: boolean): void {
    recordEffect('setAcceptsInput', id, acceptsInput);
  }
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void {
    recordEffect('attachOverlayTo', overlayId, hostId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The single kernel executor — lazily constructed, same pattern as
// `window-machine.ts getWindowBackend()`.
//
// EXECUTOR PROVIDER — the injection seam the cutover installs into, INJECTION
// NOT IMPORT, same shape as `izui-state.ts setFrontWindowIdProvider` /
// `hybrid-page-host-registry.ts registerHybridWindowClosedListener`: this
// module exposes a setter the production wiring calls IN, and never imports
// the production accessor itself. It cannot: the production executor
// (`window-kernel-singleton.ts getKernelExecutor`) is reached through
// `window-machine.ts getKernelExecutorForApp()`, and value-importing
// that module here would (a) pull in `electron-window-backend.ts`'s value
// `import { app } from 'electron'`, which throws under the
// `ELECTRON_RUN_AS_NODE=1` unit runner this module's own
// `.test.ts` suite runs under, and (b) close an import cycle —
// `window-machine.ts` already value-imports THIS module for the feed
// helpers below, so importing it back would make the two modules mutually
// dependent.
//
// `getKernelExecutor()` returns `installedProvider()` when one is
// installed, otherwise falls back to the lazily-constructed
// `NoopKernelBackend`-over instance below — the fallback is the PRE-CUTOVER
// DEFAULT, not a permanent second mode: nothing installs a provider yet, so
// every one of this file's ~25 call sites keeps landing on the noop-backed
// executor exactly as before this seam existed. The cutover is the single act
// of calling `setKernelExecutorProvider(() => getKernelExecutorForApp())` from
// production wiring; nothing else about this file changes at that point.
// ─────────────────────────────────────────────────────────────────────────────

let kernelExecutorInstance: WindowKernelExecutor | null = null;
let installedProvider: (() => WindowKernelExecutor) | null = null;

/**
 * Install the provider the cutover routes through — see the banner above.
 * Once installed, every call to `getKernelExecutor()` (and so every feed
 * helper below) returns `provider()` instead of the noop-backed default.
 *
 * THROWS if the noop-backed fallback has already been constructed AND already
 * has one or more listeners attached (`WindowKernelExecutor.subscriberCount()`).
 * Installing a provider only changes what every feed helper WRITES to from
 * this point on — it does nothing for something that already READS from the
 * fallback via `subscribe`. That listener stays bound to the orphaned noop
 * instance forever: nothing production drives that object, this module
 * swallows every exception by design, so the subscription goes silently dead
 * for the rest of the process. The subscribers today are
 * `window-machine.ts subscribeOverlayAttachment` (the shared chrome
 * overlay's re-frame) and `window-machine.ts subscribeAppActive` (the
 * overlay's app-active pointer-policy gate, `hybrid-overlay.ts
 * wireAppActiveGate`) — both made from `initHybridOverlay()`. They stay alive
 * because boot installs the provider first: `entry.ts` awaits
 * `main.ts initialize()` (which runs `initWindowStateMachine()`) before it
 * calls `initHybridOverlay()`. THIS THROW is what enforces that order — a
 * reorder of boot wiring fails loudly here instead of leaving the overlay's
 * re-frame and app-active edges silently dead.
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
  if (kernelExecutorInstance !== null && kernelExecutorInstance.subscriberCount() > 0) {
    throw new Error(
      '[window-kernel-dispatch] setKernelExecutorProvider: a listener is already subscribed to the ' +
        'pre-cutover fallback executor and would never fire again once a provider is installed — ' +
        'install the provider before anything calls getKernelExecutor().subscribe().',
    );
  }
  installedProvider = provider;
}

/**
 * The single `WindowKernelExecutor` — `installedProvider()` if one is
 * installed, else the lazily-constructed noop-backed default. Constructed on
 * first use.
 */
export function getKernelExecutor(): WindowKernelExecutor {
  if (installedProvider) return installedProvider();
  if (!kernelExecutorInstance) kernelExecutorInstance = new WindowKernelExecutor(new NoopKernelBackend());
  return kernelExecutorInstance;
}

/** Test-only: reset the kernel-executor singleton (drops the executor + its state) and clears any installed provider. */
export function _resetKernelForTests(): void {
  kernelExecutorInstance = null;
  installedProvider = null;
  effectLog.length = 0;
}

/** Execute a command against the kernel. Never throws; a rejection is logged, not surfaced. */
function kernelExecute(command: Command): void {
  try {
    const outcome = getKernelExecutor().execute(command);
    if ('rejected' in outcome) {
      DEBUG && console.log('[window-kernel-dispatch] command rejected:', command.type, outcome.rejected);
    }
  } catch (err) {
    DEBUG && console.log('[window-kernel-dispatch] command threw:', command.type, err);
  }
}

/**
 * Feed a past-tense fact straight into the kernel (`WindowKernelExecutor.dispatch`,
 * NOT `execute` — there is no `decide` step to reject, so this is the OS-focus
 * counterpart of `kernelExecute` above). Never throws.
 */
function kernelDispatch(event: Event): void {
  try {
    getKernelExecutor().dispatch(event);
  } catch (err) {
    DEBUG && console.log('[window-kernel-dispatch] event threw:', event.type, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration — every `registerWindowWithMachine(...)` path
// (`window-machine.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** The registration fields the kernel's `Event.WindowRegistered` needs — a subset of `MachineWindowSpec`. */
export interface RegisterWindowSpec {
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
  /** See `WindowRecord.tracksBaseLayerTop`'s doc — declared here, nothing reads it yet. */
  tracksBaseLayerTop?: boolean;
  /** See `WindowRecord.selfClosesOnBlur`'s doc — declared here. */
  selfClosesOnBlur?: boolean;
  /** See `WindowRecord.appLifetime`'s doc — declared here. */
  appLifetime?: boolean;
}

/**
 * Translate a completed registration into the kernel's `RegisterWindow`
 * command, called from `window-machine.ts registerWindowWithMachine`
 * once its own registration has settled.
 */
export function kernelRegisterWindow(spec: RegisterWindowSpec): void {
  kernelExecute({
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
    ...(spec.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: spec.tracksBaseLayerTop } : {}),
    ...(spec.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: spec.selfClosesOnBlur } : {}),
    ...(spec.appLifetime !== undefined ? { appLifetime: spec.appLifetime } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
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
 * `cause` IS PART OF THE REPORT, not decoration. The backend already computes
 * it (`electron-window-backend.ts takeFocusCause`) for the old machine's
 * `OS_FOCUS_GAINED`, and dropping it here fed the kernel a `world` focus for
 * every machine-issued raise — which disarms `selectTransientAutoclose`'s
 * ordering floor, so a raise sweeps transients opened AFTER the op that
 * caused it. It also left the executor's stale-self-echo guard
 * (`window-kernel-executor.ts apply`, `isStaleSelfEcho`) matching nothing in
 * production, because a `world` cause is never stale. Omitted means `world`,
 * the same reading `Event.OsFocusGained` gives an absent cause.
 */
export function kernelOsFocusGained(id: WindowId, cause?: FocusCause): void {
  kernelDispatch({ type: 'OsFocusGained', id, cause });
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
export function kernelOsFocusSettled(): void {
  const { key } = getKernelExecutor().getState();
  if (key !== null) kernelDispatch({ type: 'OsFocusLost', id: key });
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility — window-kernel.ts's `topmost(state, isContentWindow)` can only
// ever return a record whose `visible` is true (`isContentWindow`
// short-circuits on `!record.visible`, `window-kernel.ts`), and `RegisterWindow`
// always creates a record `visible: false`. Without this, no record could
// ever become visible, leaving `topmost(state, isContentWindow)` permanently
// null for every window. Translated at every
// production site that reports the old machine's mirrored `WINDOW_SHOWN` /
// `WINDOW_HIDDEN` (`electron-window-backend.ts`'s native `'show'`/`'hide'`
// listeners, `raiseWindow`, `showWindow`, `hideWindow`; `window-machine.ts
// registerWindowWithMachine`'s already-visible-at-registration import; `ipc.ts`'s
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
 * kernel's `topmost(state, isContentWindow)` on the previous window —
 * exactly the divergence a headless run measured. This function is the
 * translation at the dispatch edge; `window-kernel.ts` itself is untouched.
 *
 * NOT DOUBLE-COUNTING ON A REAL DISPLAY: there, an activating `win.show()`
 * also provokes a native `'focus'`, which already feeds `OsFocusGained`
 * through `kernelOsFocusGained` via the normal focus listener. So the
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
export function kernelWindowShown(id: WindowId, focused = false, opSeq?: number): void {
  kernelDispatch({ type: 'WindowShown', id, opSeq });
  // The companion focus carries the SHOW's own token as its provenance: an
  // activating show is a machine-issued focus, so the report has to say so or
  // `selectTransientAutoclose` reads it as the world taking key and sweeps
  // transients newer than the show. A show with no token (a caller not yet
  // reporting one) has no provenance to claim and stays `world`.
  if (focused) {
    kernelDispatch({ type: 'OsFocusGained', id, cause: opSeq === undefined ? undefined : { kind: 'machine', opSeq } });
  }
}

/**
 * Translate a completed hide report into the kernel's `WindowHidden` event.
 * `opSeq`, when the caller has one (the `HideWindow` effect's own token),
 * rides along so a stale echo of a superseded hide can be told apart from a
 * genuine one — see `window-kernel.ts isStaleWindowEcho`.
 */
export function kernelWindowHidden(id: WindowId, opSeq?: number): void {
  kernelDispatch({ type: 'WindowHidden', id, opSeq });
}

/**
 * Translate the app becoming active (`electron-window-backend.ts
 * attachAppListeners`'s `did-become-active` → old machine `APP_ACTIVATED`)
 * into the kernel's `AppActivated` event — one of the three production inputs
 * that affect visibility: it re-shows every record still carrying
 * `hiddenByAppBlur` (`window-kernel.ts`'s `AppActivated` evolve arm), mirroring
 * the old machine's own re-show. The other two are `kernelAppResigned`
 * and `kernelAppResignSettled` directly below.
 */
export function kernelAppActivated(): void {
  kernelDispatch({ type: 'AppActivated' });
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
 * the settle delay `kernelAppResignSettled` handles below). Same shape
 * and containment as `kernelAppActivated`: `kernelDispatch` (an event,
 * not a command — this is a past-tense fact `decide` never sees).
 */
export function kernelAppResigned(): void {
  kernelDispatch({ type: 'AppResigned' });
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
 * doc). Same shape and containment as `kernelAppResigned`.
 *
 * A BACKSTOP, NOT THE PRIMARY HIDE. `kernelAppResigned` above already
 * hid every attached overlay and sweep-eligible floater on the raw
 * `AppResigned` edge — the kernel is what performs that hide now, over the
 * real backend, not the old machine (`window-os-adapter.ts runEffect`'s
 * `HIDE_WINDOW` arm was a no-op post-cutover, before that module was
 * deleted). So by the time this settle
 * reaches the kernel, everything visible at the raw edge already reads
 * `visible: false`, and this arm's `isAppResignSweepEligible` sweep only
 * catches a record that became eligible in the window between the raw edge
 * and this 500ms settle (e.g. one registered and shown while Peek was already
 * backgrounded) — the same backstop `window-kernel.ts`'s `AppResignSettled`
 * arm documents on its own.
 */
export function kernelAppResignSettled(): void {
  kernelDispatch({ type: 'AppResignSettled' });
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
// lines later). That exemption lives in `decide`, not here; `kernelExecute`'s
// existing try/catch is what keeps a rejection or a thrown error from ever
// reaching these callers, same as every command above.
// ─────────────────────────────────────────────────────────────────────────────

/** Translate a forceful native-destroy teardown into the kernel's `DestroyWindow` command. */
export function kernelDestroyWindow(id: WindowId): void {
  kernelExecute({ type: 'DestroyWindow', id, expectedVersion: getKernelExecutor().getState().version });
}

/** Translate the hybrid finalize's content-surface teardown into the kernel's `CloseContent` command. */
export function kernelCloseContent(id: WindowId): void {
  kernelExecute({ type: 'CloseContent', id, expectedVersion: getKernelExecutor().getState().version });
}

/** Translate a guest-safe direct close (`windows.ts closeHostWindow`) into the kernel's `CloseWindowDirect` command. */
export function kernelCloseWindowDirect(id: WindowId): void {
  kernelExecute({ type: 'CloseWindowDirect', id, expectedVersion: getKernelExecutor().getState().version });
}

/** Translate the quit-time guest teardown into the kernel's `DestroyAllGuests` command. Names no window. */
export function kernelDestroyAllGuests(): void {
  kernelExecute({ type: 'DestroyAllGuests', expectedVersion: getKernelExecutor().getState().version });
}

// ─────────────────────────────────────────────────────────────────────────────
// Close report — the fourth real input this step feeds the kernel.
// `window-kernel.ts` RULE 1 makes `WindowClosed` the ONLY event that shrinks
// `order`; the four teardown commands above deliberately retire no record.
// Without this, the kernel's `order` only ever grows and diverges
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
export function kernelWindowClosed(id: WindowId): void {
  kernelDispatch({ type: 'WindowClosed', id });
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
export function kernelImportStackOrder(order: readonly WindowId[]): void {
  kernelExecute({ type: 'ImportStackOrder', order, expectedVersion: getKernelExecutor().getState().version });
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay attach/detach (peek 7fffa286) — originally the seventh real input
// this step fed the kernel, translated at the two production sites that
// dispatched the old machine's mirrored `OVERLAY_ATTACH_REQUESTED`
// (`hybrid-overlay.ts`'s `retarget()` — a real `hostId`, attach or retarget —
// and `detachOverlayFromMachine()` — `hostId: null`, detach), alongside that
// dispatch, never in place of it. Both call sites, and the old machine's
// mirrored dispatch itself, are gone now: attach/detach is decided entirely
// inside the kernel (`window-kernel.ts react`'s `AttachOverlayTo` diff loop),
// realized through the port, and reported back as the `OverlayAttached`
// EVENT (`kernelOverlayAttached` below), not this COMMAND. This
// function has no production caller any more — kept for the tests that
// exercise `AttachOverlay` directly, and as the historical record of the gap
// this feed closed.
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
 * transition the old machine's `OVERLAY_ATTACH_REQUESTED` was. Same shape and
 * containment as `kernelDestroyWindow` et al.: routed through
 * `kernelExecute` (a rejected stale `expectedVersion`, or a `hostId`/
 * `overlayId` `decide` doesn't recognize, is logged, never thrown into the
 * caller). No production
 * caller remains (see the section comment above); `kernelOverlayAttached`
 * is what the live attach/detach path uses.
 *
 * `frame` is the freshly expanded overlay frame for `hostId` — see
 * `window-kernel.ts WindowRecord.overlayFrame`'s doc for why the kernel takes
 * this as data rather than computing it. Omitted on a detach.
 */
export function kernelAttachOverlay(overlayId: WindowId, hostId: WindowId | null, frame?: Rectangle): void {
  kernelExecute({
    type: 'AttachOverlay',
    overlayId,
    hostId,
    ...(frame !== undefined ? { frame } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

/**
 * Feed a completed `AttachOverlayTo` effect's realization straight into the
 * kernel as the `OverlayAttached` EVENT — `hostId: null` is detach, same
 * shape as `kernelAttachOverlay` above, but dispatched rather than
 * executed. Deliberately NOT routed through `kernelAttachOverlay`'s
 * `AttachOverlay` COMMAND: this report is the backend's answer to an effect
 * the kernel itself asked for (`window-kernel.ts Effect.AttachOverlayTo`),
 * issued from inside `WindowKernelExecutor.performEffect` while `pump()` may
 * already be draining events queued by the same transition. A command
 * decided from there would be judged against a state that does not yet
 * contain those queued events — the exact re-entrancy the effect exists to
 * remove — and a wrongly rejected command is invisible (`kernelExecute`
 * logs a rejection only behind `DEBUG`). Dispatched as an event instead: a
 * past-tense fact `evolve` cannot reject.
 *
 * `frame` is the freshly expanded overlay frame for `hostId`, computed by
 * the backend at the same site that already computes it for
 * `BOUNDS_CHANGED.overlayFrame` (see `WindowRecord.overlayFrame`'s doc).
 * Omitted on a detach, or when the backend could not read the host's
 * bounds.
 */
export function kernelOverlayAttached(overlayId: WindowId, hostId: WindowId | null, frame?: Rectangle): void {
  kernelDispatch({
    type: 'OverlayAttached',
    overlayId,
    hostId,
    ...(frame !== undefined ? { frame } : {}),
  });
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
// feed no record can ever become orderable, and `topmostBaseLayerPageHost`
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
export function kernelWindowContentOrderable(id: WindowId): void {
  kernelDispatch({ type: 'WindowContentOrderable', id });
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
export function kernelContentFirstResponderChanged(id: WindowId, held: boolean): void {
  kernelDispatch({ type: 'ContentFirstResponderChanged', id, held });
}

/**
 * Translate a window's post-registration click-through change into the
 * kernel's `WindowAcceptsInputChanged` event — a mechanical mirror write
 * (window-kernel.ts's evolve arm), the sole post-registration writer of
 * `acceptsInput`. `acceptsInput` is stored as reported: the kernel never
 * infers click-through state, only records what the causing site already did
 * (see the event's own doc for why this is fed rather than observed).
 */
export function kernelWindowAcceptsInputChanged(id: WindowId, acceptsInput: boolean): void {
  kernelDispatch({ type: 'WindowAcceptsInputChanged', id, acceptsInput });
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
 * traffic. Same shape and containment as `kernelAttachOverlay` et al.:
 * routed through `kernelExecute`.
 */
export function kernelArmColdStartFocus(id: WindowId | null): void {
  kernelExecute({ type: 'ArmColdStartFocus', id, expectedVersion: getKernelExecutor().getState().version });
}

/**
 * Arm — or clear (`target: null`) — the switcher selection the kernel restores
 * focus to when `armer` closes. Dispatched from the switcher's own selection
 * IPC, while both windows are still alive and resolvable to `WindowId`s; the
 * old decision matched numeric Electron ids in `main.ts`'s native `'closed'`
 * handler, which was only possible there because the backend has dropped its id
 * map by the time the kernel hears about the close. Same shape and containment
 * as `kernelArmColdStartFocus`: routed through `kernelExecute`.
 */
export function kernelArmSelectionFocus(armer: WindowId, target: WindowId | null): void {
  kernelExecute({ type: 'ArmSelectionFocus', armer, target, expectedVersion: getKernelExecutor().getState().version });
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
 * in `window-kernel.ts`) — a target absent from the kernel's `order` is
 * logged by `kernelExecute` as a rejection, never thrown into the caller. Same
 * shape and containment as `kernelDestroyWindow` et al.
 */
export function kernelAssertFocus(id: WindowId): void {
  kernelExecute({ type: 'AssertFocus', id, expectedVersion: getKernelExecutor().getState().version });
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
export function kernelOsFullscreenEntered(id: WindowId): void {
  kernelDispatch({ type: 'OsFullscreenEntered', id });
}

/**
 * Translate a completed native fullscreen-left report into the kernel's
 * `OsFullscreenLeft` event — settles `leaving` -> `normal`, or straight
 * through to `entering` on a coalesced re-enter (`nextFsModeForOsLeft`,
 * `window-kernel.ts`).
 */
export function kernelOsFullscreenLeft(id: WindowId): void {
  kernelDispatch({ type: 'OsFullscreenLeft', id });
}

/**
 * Translate the bounded fullscreen settle timeout into the kernel's
 * `FullscreenSettleTimeout` event. Does NOT force-settle `fsMode` itself —
 * `evolve`'s arm never guesses; it only marks the record `unverified`
 * (answered by `react`'s own `ReconcileFullscreen` effect) for a record still
 * genuinely in flight, leaving every `fsMode` exactly where it was
 * (`window-kernel.ts`'s `FullscreenSettleTimeout` arm doc: a wrong guess
 * strands `preBounds` or leaves a black macOS Space behind — the machine
 * asks the OS rather than guessing).
 */
export function kernelFullscreenSettleTimeout(id: WindowId): void {
  kernelDispatch({ type: 'FullscreenSettleTimeout', id });
}

/**
 * Translate a fullscreen request into the kernel's `SetFullscreen` command.
 * `decide`'s own arm resolves what happens next from the window's CURRENT
 * `fsMode` (`window-kernel.ts`'s `SetFullscreen` case): idle ->
 * `FullscreenTransitionStarted`, already in flight (`entering`/`leaving`) ->
 * `FullscreenDesireRecorded` (coalesced, no second transition started),
 * already at the requested state -> `[]` (no-op, no OS call). None of that
 * branching is reproduced here — the command is executed and `decide`
 * decides. Same shape and containment as `kernelDestroyWindow` et al.:
 * routed through `kernelExecute` (a rejected stale `expectedVersion`, or a
 * target absent from `order`, is logged, never thrown into the caller).
 */
export function kernelSetFullscreen(id: WindowId, desired: boolean): void {
  kernelExecute({
    type: 'SetFullscreen',
    id,
    desired,
    expectedVersion: getKernelExecutor().getState().version,
  });
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
export function kernelBoundsChanged(id: WindowId, bounds: Rectangle, overlayFrame?: Rectangle): void {
  kernelDispatch({ type: 'BoundsChanged', id, bounds, ...(overlayFrame !== undefined ? { overlayFrame } : {}) });
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
export function kernelDisplayChanged(
  projections: ReadonlyArray<{ id: WindowId; bounds: Rectangle }>): void {
  kernelDispatch({ type: 'DisplayChanged', projections });
}

/**
 * Translate a resize gesture's maximize-invalidation into the kernel's
 * `MaximizeExitedByResize` event — clears `maximized` + `preMaxBounds`,
 * drives nothing back at the OS: the gesture itself owns the window's
 * bounds. Guard-free at the dispatch edge, same as `evolve`'s own arm (a
 * not-maximized record already holds these values, so this is an idempotent
 * no-op for it — the old reducer's "not maximized -> nothing to restore"
 * guard is unnecessary here).
 */
export function kernelMaximizeExitedByResize(id: WindowId): void {
  kernelDispatch({ type: 'MaximizeExitedByResize', id });
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
 * shape and containment as `kernelDestroyWindow` et al.: routed through
 * `kernelExecute` (a rejected stale `expectedVersion` is logged, never
 * thrown into the caller).
 */
export function kernelSetBounds(id: WindowId, bounds: Rectangle): void {
  kernelExecute({ type: 'SetBounds', id, bounds, expectedVersion: getKernelExecutor().getState().version });
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
 * and containment as `kernelSetBounds`.
 */
export function kernelMaximize(id: WindowId, workArea?: Rectangle): void {
  kernelExecute({
    type: 'Maximize',
    id,
    ...(workArea !== undefined ? { workArea } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

/**
 * Translate a construction-time maximize seed into the kernel's
 * `SeedMaximized` command — the pair for `ipc.ts`'s `MAXIMIZE_RESTORED`
 * dispatch on the hybrid window-open path, which reopen-last-closed and
 * session restore reach with `maximized: true` plus the saved
 * `preMaxBounds`. `preMaxBounds` rides the command explicitly because the
 * window's creation bounds already ARE the maximized rect, so the stash
 * cannot be derived from the bounds mirror the way `kernelMaximize`
 * lets `decide` derive it (see the command's own doc). `decide`'s own
 * branching: `fsMode` non-`normal` -> `[]` (the aa34cb50 family), else a
 * lone `Maximized{preMaxBounds}` — no snap, no projection discard. None of
 * that is reproduced here. Same shape and containment as
 * `kernelMaximize`.
 */
export function kernelSeedMaximized(id: WindowId, preMaxBounds: Rectangle | null): void {
  kernelExecute({ type: 'SeedMaximized', id, preMaxBounds, expectedVersion: getKernelExecutor().getState().version });
}

/**
 * Translate an unmaximize request into the kernel's `Unmaximize` command.
 * `decide`'s own branching: not `maximized` -> `[]` (nothing to restore);
 * else `PendingProjectionDiscarded` + `Unmaximized`, PLUS a `BoundsChanged`
 * restoring the stash when `preMaxBounds` is non-null (a null stash just
 * clears the flag — nowhere to restore to). None of that branching is
 * reproduced here. Same shape and containment as `kernelMaximize`.
 */
export function kernelUnmaximize(id: WindowId): void {
  kernelExecute({ type: 'Unmaximize', id, expectedVersion: getKernelExecutor().getState().version });
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
//     dispatch edge; the kernel's `SetDesktopMembership` command carries the
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
 * reproduce. Same shape and containment as `kernelMaximize` et al.
 */
export function kernelSetDesktopMembership(id: WindowId, membership: DesktopMembership): void {
  kernelExecute({
    type: 'SetDesktopMembership',
    id,
    membership,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Click-through — feeds the kernel's `SetAcceptsInput` command, closing the
// gap that used to force `hybrid-overlay.ts`'s `wireClickCapture`/
// `wireAppActiveGate` and `tile-ipc.ts`'s `tile:window:set-ignore-mouse`
// handler to call `setIgnoreMouseEvents` directly and mirror the machine by
// hand with `kernelWindowAcceptsInputChanged` afterward. Those three sites now
// dispatch this command instead, so `kernelWindowAcceptsInputChanged` (the
// direct event-feed helper above) currently has no production caller — it
// stays for a backend that could one day OBSERVE an externally-caused
// click-through change, the case its own doc still describes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a click-through request into the kernel's `SetAcceptsInput`
 * command — `decide`'s arm (`window-kernel.ts`'s `SetAcceptsInput` case) is
 * unconditional, always emitting `WindowAcceptsInputChanged{acceptsInput:
 * cmd.acceptsInput}`; no branching to reproduce. Same shape and containment
 * as `kernelSetDesktopMembership` above.
 */
export function kernelSetAcceptsInput(id: WindowId, acceptsInput: boolean): void {
  kernelExecute({
    type: 'SetAcceptsInput',
    id,
    acceptsInput,
    expectedVersion: getKernelExecutor().getState().version,
  });
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
export function kernelShowRequested(id: WindowId, activate: boolean): void {
  kernelExecute({ type: 'ShowWindow', id, expectedVersion: getKernelExecutor().getState().version });
  if (activate) {
    kernelExecute({ type: 'RaiseWindow', id, expectedVersion: getKernelExecutor().getState().version });
  }
}

/** Translate a window-hide request into the kernel's `HideWindow` command. */
export function kernelHideRequested(id: WindowId): void {
  kernelExecute({ type: 'HideWindow', id, expectedVersion: getKernelExecutor().getState().version });
}

/**
 * Translate a close-or-hide request into the kernel's `CloseOrHideWindow`
 * command. The keepLive branch (hide if keepLive, else close) is decided
 * inside the kernel's own `decide()` arm for this command, not here — the
 * caller passes no keepLive flag.
 */
export function kernelCloseOrHideRequested(id: WindowId): void {
  kernelExecute({ type: 'CloseOrHideWindow', id, expectedVersion: getKernelExecutor().getState().version });
}

