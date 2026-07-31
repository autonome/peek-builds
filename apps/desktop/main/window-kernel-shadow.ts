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
import type { Command, WindowId, WindowKind } from './window-kernel.js';
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
