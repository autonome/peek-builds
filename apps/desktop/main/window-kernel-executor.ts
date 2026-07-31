/**
 * window-kernel-executor.ts — the impure edge of the rewritten window kernel.
 *
 * Blueprint: `docs/design/window-manager.md` §0.1. `window-kernel.ts` is the
 * pure triple (`decide` / `evolve` / `react`) with ZERO value imports; THIS
 * module owns one kernel `State`, accepts dispatches, runs that triple, and
 * performs the resulting `Effect`s against the `WindowBackend` port
 * (`window-backend.ts`). Same division of labour as the pair that runs the app
 * today — `window-state.ts` (pure) + `window-os-adapter.ts` (executor) — and
 * modelled on it deliberately rather than inventing a second shape.
 *
 * SCOPE: greenfield, additive, and NOT wired to anything. Nothing constructs
 * this class in production: the backend is a required constructor argument and
 * no default `ElectronWindowBackend` is built here, so importing this module
 * causes no window operation and no listener attach. The old reducer and its
 * adapter stay in charge of the running app; routing production call sites over
 * is a later step.
 *
 * WHY IT MAY IMPORT PLATFORM-FACING CODE. The kernel's zero-value-import rule
 * exists so the pure triple stays loadable with no display and no window
 * plumbing. The executor is the layer where that stops being possible — it
 * issues OS commands. It still holds NO native handles and imports no
 * `electron` module: every window operation goes through the port, which is
 * also what keeps `scripts/check-r2-window-ops.mjs` green (the port's method
 * names are deliberately not the platform method names).
 */

import { DEBUG, isHeadless } from './config.js';
import type { WindowBackend } from './window-backend.js';
import type { StackingLevel } from './window-state.js';
import {
  BASE_LAYER,
  decide,
  evolve,
  initialState,
  isStaleSelfEcho,
  react,
  type Command,
  type Effect,
  type Event,
  type Rejection,
  type State,
  type WindowRecord,
} from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// layer -> StackingLevel (§0.1.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `layer` -> `StackingLevel` mapping §0.1.6 records as "a design claim, not
 * yet a built or tested one". `react` emits `SetStacking` carrying the numeric
 * `layer` (an index into the fixed ordered layer array, §0.1.6); the port takes
 * `'pinned' | 'stacked' | 'excluded'` and realizes `'pinned'` as
 * `setAlwaysOnTop(true, 'floating')` instead of `moveTop()`, because `moveTop()`
 * only reorders within a window's own native level and so cannot lift a floating
 * window back above the regular stack.
 *
 * Two arms, and only two are reachable:
 *
 *   - `BASE_LAYER` (and anything below it) -> `'stacked'`. The regular band,
 *     realized by the `moveTop()` replay. There is no native "place this window
 *     below that one", so a band beneath the base one is not expressible and
 *     collapses into the regular band rather than silently pretending to exist.
 *   - anything above `BASE_LAYER` -> `'pinned'`. A band that floats above the
 *     whole regular stack — what Electron's always-on-top buys, expressed as a
 *     band rather than a per-window boolean (`WindowRecord.layer`).
 *
 * `'excluded'` is deliberately UNREACHABLE. §0.1.7 deletes it: it meant "not a
 * member of the ordered stack", and the kernel's RULE 1 makes non-membership
 * unrepresentable — `order` holds every registered window. A window the OS
 * manages the z-relationship of is simply never emitted a `SetStacking` (see
 * `react`'s `visible && orderable` filter), rather than being emitted one that
 * says "ignore me".
 */
export function stackingLevelForLayer(layer: number): StackingLevel {
  return layer > BASE_LAYER ? 'pinned' : 'stacked';
}

// ─────────────────────────────────────────────────────────────────────────────
// Raise activation masks — the executor obligation `react`'s docblock records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a `RaiseWindow` effect is performed. `react` emits that effect as a pure
 * structural diff and records the obligation it cannot discharge itself: a
 * raise is an ACTIVATING show, so whoever performs it owes the same masks a
 * show owes.
 *
 *   - `'inactive-show'`         headless. Never activate, never focus: an
 *                               agent/CI run must not take the macOS key window
 *                               (peek `2b55f3af`).
 *   - `'show-and-focus-content'` a `quick-view` page-host — a `type:'panel'`
 *                               NSWindow. It must NEVER activate the app
 *                               (regression `524f7aba`: focusing a background
 *                               quick-view brought the whole app forward), but
 *                               it still has to take key input, which rides the
 *                               content-focus half. So: non-activating show +
 *                               first responder, exactly the split
 *                               `electron-window-backend.ts showWindow` already
 *                               describes for the same window.
 *   - `'activating-raise'`      everything else: the port's `raiseWindow`,
 *                               which is an activating show plus content focus.
 *
 * The quick-view arm keys on `role`, not on `class`: §0.1.4 makes `class` a
 * lookup-only shorthand nothing may branch on, while `role` is the declared
 * policy fact ("this window is a peek/slide panel") the same decision is made
 * from elsewhere in the kernel.
 *
 * An unregistered id (no record) cannot be a quick-view panel — there is no
 * declared role to read — so it takes the ordinary arm, still headless-masked.
 */
export type RaisePlan = 'inactive-show' | 'show-and-focus-content' | 'activating-raise';

export function planRaise(record: WindowRecord | undefined, headless: boolean): RaisePlan {
  if (headless) return 'inactive-show';
  if (record !== undefined && record.kind === 'page-host' && record.role === 'quick-view') {
    return 'show-and-focus-content';
  }
  return 'activating-raise';
}

// ─────────────────────────────────────────────────────────────────────────────
// The executor
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowKernelExecutorOptions {
  /** Starting state — defaults to `initialState()`. Replay/tests supply their own. */
  initial?: State;
  /**
   * Whether this process runs focus-free (`PEEK_HEADLESS`). Injected so the
   * decision is a value the tests can drive rather than an environment read
   * buried in a branch; defaults to the app's own `isHeadless()`.
   */
  headless?: boolean;
}

/** What `execute` answers: the command was applied, or `decide` rejected it. */
export type CommandOutcome = { applied: true; events: readonly Event[] } | { rejected: Rejection };

/**
 * Owns ONE kernel `State`, pumps every event through the identical
 * evolve -> effects -> notify sequence, and performs effects through the port.
 *
 * One instance per app when this is eventually wired; construct it with the
 * single `WindowBackend` (see the module header for why nothing constructs one
 * here yet).
 */
export class WindowKernelExecutor {
  private state: State;
  private readonly backend: WindowBackend;
  private readonly headless: boolean;

  constructor(backend: WindowBackend, opts: WindowKernelExecutorOptions = {}) {
    this.backend = backend;
    this.state = opts.initial ?? initialState();
    this.headless = opts.headless ?? isHeadless();
  }

  /** The current state. Read-only by contract — `State` and its records are frozen by convention, not by `Object.freeze`. */
  getState(): State {
    return this.state;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Subscribe surface
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Fire `listener` with the new state after every applied event (after its
   * effects have been performed). The base surface only: the edge-deduped
   * consumer shapes the old machine exposes — `window-state-singleton.ts
   * subscribeFrontChange` / `subscribeAppActive` — are each built as a dedup
   * layer over exactly this, and the kernel's equivalents are built the same
   * way BY THE CALLER, at the call site that knows which fact it cares about.
   *
   * Deliberately no `subscribeTopmostPageHostChange` here. §0.1.5 records that
   * the one live subscriber (the shared chrome overlay's retarget) is better
   * served by an EFFECT than by a subscription — push-based, and it closes the
   * re-entrancy hazard where a retarget runs from a subscribe callback
   * mid-dispatch — and §0.1.6 records that the query it would dedup on spans
   * layer bands and needs a band-aware replacement first. Building it here
   * would bake in the shape both sections say to replace.
   *
   * Returns an unsubscribe function. A listener that throws is contained: it
   * must not take down the dispatch that notified it.
   */
  subscribe(listener: (state: State) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly listeners = new Set<(state: State) => void>();

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        DEBUG && console.log('[window-kernel] subscriber threw:', err);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Entry points
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Feed a past-tense fact into the machine. This is the one place events enter
   * — the backend's native reports and the app's own dispatches use the same
   * door, so the stale-echo guard below cannot be bypassed by picking a
   * different entry.
   */
  dispatch(event: Event): void {
    this.pump(event);
  }

  /**
   * Ask for a state change. `decide` may reject (a stale `expectedVersion`, a
   * command naming no window); a rejection changes nothing and is RETURNED
   * rather than thrown — the caller decides whether to re-read `version` and
   * retry. Accepted commands become events and go through the same pump
   * `dispatch` uses.
   */
  execute(command: Command): CommandOutcome {
    const outcome = decide(this.state, command);
    if ('rejected' in outcome) {
      DEBUG && console.log('[window-kernel] rejected', command.type, outcome.rejected);
      return { rejected: outcome.rejected };
    }
    for (const event of outcome.events) this.pump(event);
    return { applied: true, events: outcome.events };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The pump
  // ───────────────────────────────────────────────────────────────────────────

  /** FIFO of events dispatched while a pump was already draining. */
  private readonly pendingEvents: Event[] = [];

  /** Whether a pump is currently draining (re-entrancy latch). */
  private pumping = false;

  /**
   * RE-ENTRANCY: performing an effect can push an event straight back in — the
   * backend performs an OS show and echoes it synchronously. Rather than
   * recursing mid-batch, a nested dispatch is QUEUED and drained strictly after
   * the current event's effects complete, so one pump runs at a time and every
   * event still flows through the identical sequence in dispatch order. Same
   * shape (and same reason) as `window-os-adapter.ts pump`.
   */
  private pump(event: Event): void {
    this.pendingEvents.push(event);
    if (this.pumping) return;
    this.pumping = true;
    try {
      let next: Event | undefined;
      while ((next = this.pendingEvents.shift()) !== undefined) {
        this.apply(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * THE STALE-ECHO GUARD, and the reason it lives here rather than in the pure
   * triple.
   *
   * An `OsFocusGained` whose provenance is `machine` (the echo of a focus-family
   * effect this executor issued) can arrive LATE — after some other window has
   * already taken key. By `react`'s rule that is a genuine reorder, and a
   * genuine reorder emits `RaiseWindow`, which is an ACTIVATING show: a late
   * echo would drive a real OS focus-steal, sweeping the user off the window
   * they just moved to. That is strictly worse than the old model, where a late
   * echo only made a stored `front` wrong.
   *
   * `react` structurally cannot fix it: it reads no event payload, so it cannot
   * see provenance at all — `prev`/`next` for a late echo and for a real focus
   * gain are identical states. `evolve` cannot either: it is total and
   * guard-free by construction. So the drop has to happen BEFORE the event
   * reaches `evolve`, and the dispatch site is the only place with both the
   * event's `cause` and the state to judge it against.
   *
   * Judged at APPLY time, not at enqueue time: the queue can hold an event
   * while other events (including further ops for the same window) are applied,
   * and `WindowRecord.lastOpSeq` only ever grows — so checking against the state
   * the event will actually be applied to is both the correct reading and the
   * conservative one.
   */
  private apply(event: Event): void {
    if (event.type === 'OsFocusGained' && event.cause !== undefined) {
      if (isStaleSelfEcho(this.state, event.id, event.cause)) {
        DEBUG && console.log('[window-kernel] dropped stale self-echo for', event.id);
        return;
      }
    }

    const prev = this.state;
    const next = evolve(prev, event);
    const effects = react(prev, event, next);
    this.state = next;
    this.runEffects(effects);
    this.notify();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Effects
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `SetStacking` is separated from the rest of the batch and replayed LAST, in
   * layer bands (§0.1.6): the realization of an order is a re-assert loop —
   * `moveTop()` bottom-to-top within each layer — not a minimal diff, so it is
   * idempotent by construction and self-corrects any perturbation the OS made
   * on its own. Ordering the replay by band (lowest first) and keeping array
   * order within a band is what "within each layer" means in practice: each
   * native call only reorders within the window's own level, so a band's
   * result depends on the relative order of ITS OWN calls and on nothing else.
   * Cross-band position in `order` is unobservable to the OS, which is exactly
   * why regrouping the emission is behaviour-preserving.
   *
   * Never a read-back: the OS stack is a write-only projection (§0.1.6), so
   * nothing here asks Electron what the current z-order is.
   */
  private runEffects(effects: readonly Effect[]): void {
    const stackingEffects: Array<Extract<Effect, { type: 'SetStacking' }>> = [];
    for (const effect of effects) {
      if (effect.type === 'SetStacking') {
        stackingEffects.push(effect);
        continue;
      }
      this.runEffect(effect);
    }
    this.reassertStacking(stackingEffects);
  }

  private reassertStacking(effects: readonly Extract<Effect, { type: 'SetStacking' }>[]): void {
    if (effects.length === 0) return;
    const byBand = effects
      .map((effect, index) => ({ effect, index }))
      .sort((a, b) => a.effect.layer - b.effect.layer || a.index - b.index);
    for (const { effect } of byBand) {
      try {
        this.backend.setStacking(effect.id, stackingLevelForLayer(effect.layer));
      } catch (err) {
        DEBUG && console.log('[window-kernel] effect failed: SetStacking', err);
      }
    }
  }

  private runEffect(effect: Effect): void {
    try {
      this.performEffect(effect);
    } catch (err) {
      DEBUG && console.log('[window-kernel] effect failed:', effect.type, err);
    }
  }

  private performEffect(effect: Effect): void {
    switch (effect.type) {
      case 'ShowWindow': {
        // NON-ACTIVATING, always. In this kernel a show states that a window
        // became visible, never that it became the one in use (§0.1.10:
        // `WindowShown` does not reorder). Activation is `RaiseWindow`'s job
        // and arrives as its own effect when a focus report reorders `order`.
        // A non-activating show takes no OS focus, so this branch owes no
        // activation mask — the whole masking question lives on the raise.
        // `opSeq` still rides along: it is the token the backend would arm a
        // self-caused-focus expectation with if the show ever did activate.
        this.backend.showWindow(effect.id, { activate: false, opSeq: effect.opSeq });
        return;
      }
      case 'HideWindow': {
        this.backend.hideWindow(effect.id);
        return;
      }
      case 'CloseWindow': {
        // `decide`'s keepLive branch already ran (§0.1: CloseOrHideWindow ->
        // WindowClosed only on the non-keepLive arm), so this must not
        // re-apply that policy — `closeOrHide` would. `closeWindow` is the
        // guest-safe direct close with no keepLive policy of its own;
        // `destroyWindow` skips beforeunload/close events entirely and is
        // reserved for forceful teardown, never ordinary dismissal (design
        // note: HIDE_WINDOW/CLOSE_WINDOW, never DESTROY_WINDOW). Fire-and-
        // forget, same as every other effect here — the promise is test-bridge
        // settlement only.
        void this.backend.closeWindow(effect.id);
        return;
      }
      case 'RaiseWindow': {
        const record = this.state.order.find((w) => w.id === effect.id);
        switch (planRaise(record, this.headless)) {
          case 'inactive-show':
            this.backend.showWindow(effect.id, { activate: false, opSeq: effect.opSeq });
            return;
          case 'show-and-focus-content':
            this.backend.showWindow(effect.id, { activate: false, opSeq: effect.opSeq });
            this.backend.focusContent(effect.id, effect.opSeq);
            return;
          case 'activating-raise':
            this.backend.raiseWindow(effect.id, effect.opSeq);
            return;
        }
        return;
      }
      case 'SetFullscreen': {
        this.backend.setFullscreen(effect.id, true);
        return;
      }
      case 'ExitFullscreen': {
        this.backend.setFullscreen(effect.id, false);
        return;
      }
      case 'SetBounds': {
        // No headless gate — a bounds write neither activates, takes key, nor
        // brings a hidden window on screen (the same reasoning the old
        // executor records for this family).
        this.backend.setWindowBounds(effect.id, effect.bounds);
        return;
      }
      case 'SetVisibleOnAllSpaces': {
        // Headless-gated: the call touches the real desktop's Space assignment
        // and, without `skipTransformProcessType`, the app's activation policy
        // — an agent/CI run must not move windows between the user's Spaces.
        // `skipTransformProcessType` is required on EVERY call (without it
        // macOS flips the activation policy mid-call and every other window
        // flashes out for a frame); `visibleOnFullScreen` belongs on the
        // pin-on call only, and an absent flag must stay absent rather than
        // become `false`.
        if (this.headless) return;
        this.backend.setVisibleOnAllSpaces(effect.id, effect.on, {
          ...(effect.on ? { visibleOnFullScreen: true } : {}),
          skipTransformProcessType: true,
        });
        return;
      }
      case 'SetStacking': {
        // Handled by the band replay in `runEffects`; never reached.
        this.backend.setStacking(effect.id, stackingLevelForLayer(effect.layer));
        return;
      }
      case 'DestroyWindow': {
        // Forceful native destroy (extension bridge / UI teardown). Genuinely
        // synchronous, unlike `webContents.destroy()`: `BaseWindow.destroy()`
        // tears the window down within the call, so there is nothing to await.
        // Do not read across from this to `DestroyAllGuests` — a guest WC's
        // destruction lands on a LATER turn.
        //
        // No guest pass, by construction: this is not the teardown for a
        // window that owns page-host guests, and `CloseWindowDirect` below is
        // (peek `d1cf0b9a`).
        this.backend.destroyWindow(effect.id);
        return;
      }
      case 'CloseContent': {
        // The wedged-guest fallback, not the ordinary quit path (see the
        // `CloseContent` command). The port's guard finds an already-destroyed
        // WebContents and returns, so on every ordinary path this call does
        // nothing at all.
        this.backend.closeContent(effect.id);
        return;
      }
      case 'CloseWindowDirect': {
        // Guest-safe: `closeWindow` destroys and AWAITS the window's registered
        // guests before closing the host. Fire-and-forget here, same as
        // `CloseWindow` — the promise is test-bridge settlement only. No
        // keepLive policy is re-applied: the caller's intent was close.
        void this.backend.closeWindow(effect.id);
        return;
      }
      case 'DestroyAllGuests': {
        // Process-wide, names no window. The call is ASYNC and its settlement
        // is load-bearing — `webContents.destroy()` returns while the guest is
        // still alive — but the await belongs to the quit sequencing that owns
        // the port (`entry.ts runBeforeQuitCleanup` awaits it before the
        // re-quit), not to the pump: an executor that blocked here would stall
        // every other effect in the batch.
        void this.backend.destroyAllContentGuests();
        return;
      }
      default: {
        const exhaustive: never = effect;
        void exhaustive;
        return;
      }
    }
  }
}
