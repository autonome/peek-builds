// window-escape-runtime.ts — the caller side of the Escape round trip.
// `window-escape.ts interpretEscape` is a pure `(keyEvent, snapshot) ->
// EscapeOutcome`; this module drives the two-pass decision around it (asking
// the renderer, then re-deciding) and performs whichever outcome the second
// pass settles on. Every dependency is injected rather than imported, since
// `electron` provides nothing under `ELECTRON_RUN_AS_NODE=1`.

import {
  interpretEscape,
  resolveEscapeTarget,
  type EscapeKeyPress,
  type EscapeOutcome,
} from './window-escape.js';
import { wmLog } from './window-diag.js';
import type { Command, State, WindowId } from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

// One Escape keystroke, as a dispatch site reports it.
export interface EscapePress {
  readonly landedId: WindowId | 'global';
}

// Everything `handleEscapePress` needs from the rest of the app, injected rather than imported.
export interface EscapeRuntimeDeps {
  // A fresh kernel snapshot, read again for pass B — never cached across the ask.
  getState(): State;
  // Apply a kernel `Command`. Rejection (a stale `expectedVersion`) is the executor's business.
  execute(command: Command): void;
  // `pubsub.ts publish`, pre-bound to its source address.
  publish(topic: string, payload: unknown): void;
  // `windows.ts askWebContentsToHandleEscape`: did this window's renderer consume the Escape it was just handed?
  ask(id: WindowId): Promise<boolean>;
  // Register a promise that outlives this call so a test bridge can await its
  // settlement (`window-machine.ts waitForPendingWindowEffects`).
  track(pending: Promise<unknown>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which outcomes the renderer could have pre-empted
// ─────────────────────────────────────────────────────────────────────────────

// `close-switcher` is not here: the switcher is main-process chrome with no
// page content to hand the keystroke to. `stale-landing` is not here either:
// a keystroke already dropped as stale has no window left to ask.
function rendererCouldHavePreempted(outcome: EscapeOutcome): boolean {
  if (outcome.kind === 'close-window') return true;
  if (outcome.kind === 'open-switcher') return true;
  if (outcome.kind === 'nothing' && outcome.reason === 'policy-nothing') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Performing an outcome
// ─────────────────────────────────────────────────────────────────────────────

function performEscapeOutcome(outcome: EscapeOutcome, deps: EscapeRuntimeDeps): void {
  switch (outcome.kind) {
    case 'nothing': {
      // A decision to do nothing is exactly the fact that must stay visible,
      // so this line is unconditional rather than DEBUG-gated.
      wmLog('esc-action', { action: 'nothing', reason: outcome.reason });
      return;
    }
    case 'pass-through': {
      wmLog('esc-action', { action: 'pass-through', id: outcome.id });
      return;
    }
    case 'open-switcher': {
      // The kernel has no vocabulary for creating a window (see
      // `window-escape.ts`'s `EscapeOutcome` note), so opening the switcher
      // is an app-level publish rather than a `Command`.
      wmLog('esc-action', { action: 'open-switcher', topic: 'cmd:execute:windows' });
      deps.publish('cmd:execute:windows', {});
      return;
    }
    case 'close-switcher': {
      // `outcome.restoreTargetId` is deliberately left unread here: closing
      // the switcher via Escape restores nothing, and reading the target and
      // raising it would be new behavior, not preserved behavior.
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

// If pass A's outcome is one the renderer's own handler could have pre-empted
// (`rendererCouldHavePreempted`) and resolves to an actual window, that
// window is asked and the decision deferred to pass B; every other outcome
// performs immediately. Pass B re-reads state fresh and tracks the id of the
// window pass A asked (not a version), performing its own outcome only when
// it re-resolves that SAME window — `resolveEscapeTarget` can otherwise
// re-resolve a `'global'` landing to whoever holds key now, not who held it
// when the user pressed Escape. Pass A's `Command`, if any, is discarded
// once an ask is issued — only pass B's outcome is ever performed.
export function handleEscapePress(press: EscapePress, deps: EscapeRuntimeDeps): void {
  const key: EscapeKeyPress = { landedId: press.landedId };
  wmLog('esc-press', { landedId: press.landedId });

  const stateA = deps.getState();
  const outcomeA = interpretEscape(key, stateA);
  // Resolved unconditionally so the diagnostic line below always names what
  // pass A targeted, including the `stale`/`none` cases that never reach an ask.
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
        // The press is about the window pass A asked, and no other: the ask
        // is a round trip of up to 500ms, and the world moves while it is
        // outstanding. Pass B performs only when it resolves the same window;
        // anything else is a press against a world that no longer exists, and
        // the user's next press decides against the settled one.
        const targetB = resolveEscapeTarget(key, stateB);
        if (targetB.kind !== 'window' || targetB.record.id !== targetId) {
          wmLog('esc-pass-b', {
            outcome: 'nothing',
            reason: 'target-changed',
            askedId: targetId,
            nowTarget: targetB.kind,
            nowTargetId: targetB.kind === 'window' ? targetB.record.id : undefined,
          });
          performEscapeOutcome({ kind: 'nothing', reason: 'target-changed', command: null }, deps);
          return;
        }
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
  // the renderer, or it could have been but resolved no window to ask.
  wmLog('esc-no-ask', {
    reason: rendererCouldHavePreempted(outcomeA) ? 'no-window-target' : 'not-preemptable',
  });
  performEscapeOutcome(outcomeA, deps);
}
