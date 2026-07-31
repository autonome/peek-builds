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
 */

import { DEBUG } from './config.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import type { Command, Event, WindowId, WindowKind } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel } from './window-state.js';

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

/** Translate a completed registration into the kernel's `RegisterWindow` command. */
export function shadowKernelRegisterWindow(spec: ShadowRegisterWindowSpec): void {
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
 */
export function shadowKernelOsFocusGained(id: WindowId): void {
  shadowDispatch({ type: 'OsFocusGained', id });
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
export function shadowKernelOsFocusSettled(): void {
  const { key } = getShadowKernelExecutor().getState();
  if (key === null) return;
  shadowDispatch({ type: 'OsFocusLost', id: key });
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
export function shadowKernelDestroyWindow(id: WindowId): void {
  shadowExecute({ type: 'DestroyWindow', id, expectedVersion: getShadowKernelExecutor().getState().version });
}

/** Translate the hybrid finalize's content-surface teardown into the kernel's `CloseContent` command. */
export function shadowKernelCloseContent(id: WindowId): void {
  shadowExecute({ type: 'CloseContent', id, expectedVersion: getShadowKernelExecutor().getState().version });
}

/** Translate a guest-safe direct close (`windows.ts closeHostWindow`) into the kernel's `CloseWindowDirect` command. */
export function shadowKernelCloseWindowDirect(id: WindowId): void {
  shadowExecute({ type: 'CloseWindowDirect', id, expectedVersion: getShadowKernelExecutor().getState().version });
}

/** Translate the quit-time guest teardown into the kernel's `DestroyAllGuests` command. Names no window. */
export function shadowKernelDestroyAllGuests(): void {
  shadowExecute({ type: 'DestroyAllGuests', expectedVersion: getShadowKernelExecutor().getState().version });
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
export function shadowKernelWindowClosed(id: WindowId): void {
  shadowDispatch({ type: 'WindowClosed', id });
}
