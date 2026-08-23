/**
 * window-escape-runtime.ts — the caller side of the Escape round trip.
 *
 * `window-escape.ts interpretEscape` is a pure `(keyEvent, snapshot) ->
 * EscapeOutcome`; it reads a snapshot once and decides, and its own docblock
 * ("THE ASK IS NOT DELETED") says the renderer ask moves OUT of the reducer
 * and into the caller, which asks and then re-enters `interpretEscape` with
 * the answer. This module is that caller: it takes one Escape keypress,
 * drives the two-pass decision, and performs whichever `EscapeOutcome` the
 * second pass settles on.
 *
 * Every dependency is INJECTED — `getState`, `execute`, `publish`, `ask`,
 * `track` — none of them a module-scope singleton, matching
 * `window-escape-renderer-handled.ts`'s `ipcMain` injection and for the same
 * reason: `electron` provides nothing under `ELECTRON_RUN_AS_NODE=1`, so a
 * static import of any real backend would fail this module's own unit tests
 * at load time.
 *
 * WIRED. `window-machine.ts dispatchEscapePress` is the one bound
 * caller — every dispatch site that used to feed `window-state.ts`'s
 * `ESC_PRESSED` arm calls it instead, so `handleEscapePress` below is now the
 * live Escape decider.
 *
 * Every decision point here also writes an always-on `window-diag.ts` line —
 * see that module's header for why it is not `DEBUG`-gated. The bias is
 * toward logging what did NOT happen: a stale keystroke, an outcome of
 * `nothing`, an ask that was skipped, are each their own line rather than
 * silence.
 */

import {
  interpretEscape,
  resolveEscapeTarget,
  type EscapeKeyPress,
  type EscapeOutcome,
  type EscapeSession,
} from './window-escape.js';
import { wmLog } from './window-diag.js';
import type { Command, State, WindowId } from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** One Escape keystroke, as a dispatch site reports it — `EscapeKeyPress` minus the mirrored renderer fact, which this module supplies itself across the two passes. */
export interface EscapePress {
  readonly landedId: WindowId | 'global';
  readonly session: EscapeSession;
}

/**
 * Everything `handleEscapePress` needs from the rest of the app, injected
 * rather than imported.
 */
export interface EscapeRuntimeDeps {
  /** A fresh kernel snapshot, read again for pass B — never cached across the ask. */
  getState(): State;
  /** Apply a kernel `Command`. Rejection (a stale `expectedVersion`) is the executor's business, not this module's. */
  execute(command: Command): void;
  /** `pubsub.ts publish`, pre-bound to its source address — this module names only the topic and payload. */
  publish(topic: string, payload: unknown): void;
  /** `windows.ts askWebContentsToHandleEscape`, by way of the active `WindowBackend`: "did this window's renderer consume the Escape it was just handed?" */
  ask(id: WindowId): Promise<boolean>;
  /**
   * Register a promise that outlives this call so a test bridge can await its
   * settlement — the same channel `window-kernel-executor.ts
   * trackExternalAsyncEffect` feeds, reachable through
   * `window-machine.ts waitForPendingWindowEffects`. `handleEscapePress`
   * itself returns `void`; this is how its async half becomes observable.
   */
  track(pending: Promise<unknown>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which outcomes the renderer could have pre-empted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An outcome the renderer's own Escape handler could have already consumed —
 * the three cases where a mirrored "renderer handled it" answer of `true`
 * would change pass A's decision. `close-switcher` is NOT here: the switcher
 * is main-process chrome with no page content to hand the keystroke to.
 * `stale-landing` is not here either — a keystroke already dropped as stale
 * has no window left to ask.
 */
function rendererCouldHavePreempted(outcome: EscapeOutcome): boolean {
  if (outcome.kind === 'close-window') return true;
  if (outcome.kind === 'open-switcher') return true;
  if (outcome.kind === 'nothing' && outcome.reason === 'policy-nothing') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Performing an outcome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a decided `EscapeOutcome` into the one side effect it names — the
 * counterpart to `window-os-adapter.ts runEffect`'s `ASK_RENDERER` /
 * `OPEN_SWITCHER_WINDOW` / Escape-decided arms, minus the reducer plumbing
 * those arms exist only to feed back.
 */
function performEscapeOutcome(outcome: EscapeOutcome, deps: EscapeRuntimeDeps): void {
  switch (outcome.kind) {
    case 'nothing': {
      // The case the old DEBUG-gated log missed whenever DEBUG was off — a
      // decision to do nothing is exactly the fact that must stay visible,
      // so this line is unconditional. `reason` says WHY nothing happened
      // (`resolveEscapeTarget`'s `stale`, the mirrored renderer fact, or the
      // policy table landing on `nothing`).
      wmLog('esc-action', { action: 'nothing', reason: outcome.reason });
      return;
    }
    case 'pass-through': {
      // The keystroke was already left untouched at the before-input-event
      // site (escapeMode:'ignore'); nothing left to do here.
      wmLog('esc-action', { action: 'pass-through', id: outcome.id });
      return;
    }
    case 'open-switcher': {
      // The kernel has no vocabulary for creating a window (see
      // `window-escape.ts`'s "WHY FOUR OF THESE CARRY command: null"), so
      // opening the switcher is an app-level publish — the same
      // `cmd:execute:windows` trigger `window-os-adapter.ts`'s
      // `OPEN_SWITCHER_WINDOW` arm uses today.
      wmLog('esc-action', { action: 'open-switcher', topic: 'cmd:execute:windows' });
      deps.publish('cmd:execute:windows', {});
      return;
    }
    case 'close-switcher': {
      // `outcome.restoreTargetId` is deliberately left unread. The old
      // machine's restore path (`applyRaiseRequest` -> `RAISE_WINDOW` /
      // `FOCUS_CONTENT` / `SET_STACKING`) is a labelled no-op in
      // `window-os-adapter.ts runEffect` today, so closing the switcher via
      // Escape restores nothing in production as it stands. Reading the
      // target here and raising it would be NEW behavior, not the preserved
      // behavior this module exists to carry forward.
      wmLog('esc-action', {
        action: 'close-switcher',
        type: outcome.command.type,
        id: outcome.command.id,
        expectedVersion: outcome.command.expectedVersion,
      });
      deps.execute(outcome.command);
      return;
    }
    case 'exit-fullscreen': {
      wmLog('esc-action', {
        action: 'exit-fullscreen',
        type: outcome.command.type,
        id: outcome.command.id,
        expectedVersion: outcome.command.expectedVersion,
      });
      deps.execute(outcome.command);
      return;
    }
    case 'close-window': {
      wmLog('esc-action', {
        action: 'close-window',
        type: outcome.command.type,
        id: outcome.command.id,
        expectedVersion: outcome.command.expectedVersion,
      });
      deps.execute(outcome.command);
      return;
    }
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The two-pass decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide and perform one Escape keypress.
 *
 * PASS A decides against the CURRENT snapshot with no renderer answer. Three
 * of its outcomes are ones the renderer's own handler could have already
 * consumed (`rendererCouldHavePreempted`); when pass A lands on one of those
 * AND the keystroke resolves to an actual window (`resolveEscapeTarget`),
 * this asks that window's renderer and defers the decision — every other
 * outcome (`stale-landing`, `close-switcher`, `pass-through`,
 * `exit-fullscreen`) performs immediately, no ask.
 *
 * PASS B re-reads state AFTER the ask resolves and re-runs `interpretEscape`
 * with the answer folded in, against that fresh snapshot — never against
 * `stateA`. No epoch or sequence number rides along: `resolveEscapeTarget`
 * re-resolves `landedId` against the fresh `state.key` on its own, and
 * returns `stale` if focus moved during the wait (`window-escape.ts`'s own
 * docblock names this as the structural replacement for the old
 * `escAsk`/`escSeq` pair). Pass A's `Command`, if any, is never performed —
 * only pass B's outcome is, and each command already carries the
 * `expectedVersion` of the snapshot it was decided against, so a pass-A
 * command executed after the pass-B re-read would be rejected as stale even
 * if this module tried.
 */
export function handleEscapePress(press: EscapePress, deps: EscapeRuntimeDeps): void {
  const key: EscapeKeyPress = { landedId: press.landedId, session: press.session };
  wmLog('esc-press', { landedId: press.landedId, session: press.session });

  const stateA = deps.getState();
  const outcomeA = interpretEscape(key, stateA);
  // Resolved unconditionally (not just inside the ask branch below) so the
  // diagnostic line below always names what pass A targeted, including the
  // `stale`/`none` cases that never reach an ask.
  const targetA = resolveEscapeTarget(key, stateA);
  wmLog('esc-pass-a', {
    outcome: outcomeA.kind,
    reason: outcomeA.kind === 'nothing' ? outcomeA.reason : undefined,
    target: targetA.kind,
    targetId: targetA.kind === 'window' ? targetA.record.id : undefined,
  });

  if (rendererCouldHavePreempted(outcomeA) && targetA.kind === 'window') {
    const targetId = targetA.record.id;
    wmLog('esc-ask', { targetId });
    deps.track(
      deps.ask(targetId).then((rendererHandled) => {
        wmLog('esc-ask-answer', { targetId, rendererHandled });
        const stateB = deps.getState();
        const outcomeB = interpretEscape({ ...key, rendererHandled }, stateB);
        wmLog('esc-pass-b', {
          outcome: outcomeB.kind,
          reason: outcomeB.kind === 'nothing' ? outcomeB.reason : undefined,
        });
        performEscapeOutcome(outcomeB, deps);
      }),
    );
    return;
  }

  // No ask issued — either pass A's outcome could not have been preempted by
  // the renderer (`close-switcher`, `pass-through`, `exit-fullscreen`,
  // `stale-landing`), or it could have been but resolved no window to ask
  // (`open-switcher` with no target). Named explicitly rather than left to be
  // inferred from the absence of an `esc-ask` line above.
  wmLog('esc-no-ask', {
    reason: rendererCouldHavePreempted(outcomeA) ? 'no-window-target' : 'not-preemptable',
  });
  performEscapeOutcome(outcomeA, deps);
}
