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
 * SCOPE: the backend is a required constructor argument, so importing this
 * module alone causes no window operation and no listener attach — but
 * production DOES construct one: `window-kernel-singleton.ts getKernelExecutor`
 * is called with the real `ElectronWindowBackend` from `window-state-singleton.ts
 * getKernelExecutorForApp`, wired in at boot
 * (`window-state-singleton.ts initWindowStateMachine`). From that point this
 * executor performs every window operation the app makes; the old reducer
 * (`window-state.ts`) and its adapter (`window-os-adapter.ts`) keep running
 * alongside it but no longer perform one (see that adapter's header for the
 * handful of responsibilities it retains).
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
import type { StackingLevel } from './izui-roles.js';
import {
  BASE_LAYER,
  decide,
  evolve,
  FULLSCREEN_SETTLE_TIMEOUT_MS as DEFAULT_FULLSCREEN_SETTLE_TIMEOUT_MS,
  initialState,
  isStaleSelfEcho,
  isStaleWindowEcho,
  react,
  type Command,
  type Effect,
  type Event,
  type Rejection,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fullscreen settle waiter (peek 7fffa286)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What `waitForSettledFsMode` resolves to — lets a caller tell a real settle
 * apart from a bounded give-up or a record that stopped existing mid-await.
 */
export type FsSettleOutcome = 'settled' | 'timed-out' | 'vanished';

/** Whether `WindowKernelExecutor.recordTimeline` records at all — E2E runs only. */
const TIMELINE_ENABLED = process.env.E2E_TEST === 'true';

/** Ring bound on the E2E transition timeline. */
const TIMELINE_LIMIT = 400;

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
 *   - `'suppressed'`            the app is backgrounded (`!appActive`). Performs
 *                               NOTHING — no show, no activate, no content focus.
 *                               Ported from the old reducer's
 *                               `applyRaiseRequest` chokepoint (`if
 *                               (!state.appActive) return`), which dropped the
 *                               raise outright.
 *   - `'inactive-show'`         headless. Never activate, never focus, but the
 *                               window still shows.
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
 * declared role to read — so it takes the ordinary arm, still masked by
 * headless and `appActive` below.
 */
export type RaisePlan = 'suppressed' | 'inactive-show' | 'show-and-focus-content' | 'activating-raise';

/**
 * THE APP-ACTIVE GATE — the port of the old reducer's `applyRaiseRequest`
 * chokepoint (`if (!state.appActive) return`), which dropped `RAISE_WINDOW`
 * outright, together with its `FOCUS_CONTENT`/`SET_STACKING` companions,
 * whatever the trigger. Nothing in `window-kernel.ts` holds that guard —
 * `decide`/`react` stay guard-free by design (see `window-kernel.test.ts`
 * "the focus assert" describe block) — so without this it is live only as a
 * documented gap: `WindowKernelExecutor` has no production caller today, but
 * at cutover a backgrounded window taking a focus report would paint a Peek
 * window over whatever app is frontmost, reproducing the shape of regression
 * `524f7aba` one layer up from where that one was fixed.
 *
 * It lives here rather than in the pure layer for the same reason the
 * headless mask does: this is the environment refusing an activation, not a
 * structural fact about the window model, and the executor is where every
 * other activation obligation `react`'s docblock records already gets
 * discharged.
 *
 * SAME SEMANTICS AS THE OLD REDUCER. A backgrounded raise resolves to
 * `'suppressed'`: no show, no activate, no content focus — the backend is
 * never called at all. This matches the old machine's outright drop rather
 * than degrading to a non-activating show.
 *
 * ORDERING AGAINST THE HEADLESS MASK: checked immediately after headless, and
 * — unlike the quick-view arm below — it wins outright rather than narrowing
 * one arm. Headless is checked first only because it is unconditional
 * (no-focus-ever, `appActive` notwithstanding); once past it, an inactive app
 * forces `'suppressed'` even for a quick-view panel, overriding what would
 * otherwise be `'show-and-focus-content'` — a backgrounded app gets no
 * first-responder handoff either, because it gets nothing at all.
 */
export function planRaise(record: WindowRecord | undefined, headless: boolean, appActive: boolean): RaisePlan {
  if (headless) return 'inactive-show';
  if (!appActive) return 'suppressed';
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

  /**
   * How many listeners are currently attached via `subscribe` — a narrow,
   * count-only accessor for callers that need to know WHETHER something is
   * listening without ever seeing WHAT (`window-kernel-shadow.ts
   * setKernelExecutorProvider`'s orphaned-subscriber guard is the one caller
   * today). Never exposes the listener set itself.
   */
  subscriberCount(): number {
    return this.listeners.size;
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
  // Fullscreen settle waiter — ported from `window-state.ts
  // WindowStateOwner.waitForMode` (peek 7fffa286), a derived waiter built on
  // `subscribe` rather than a bespoke listener set.
  // ───────────────────────────────────────────────────────────────────────────

  private findRecord(id: WindowId): WindowRecord | undefined {
    return this.state.order.find((w) => w.id === id);
  }

  /**
   * Resolve when window `id` reaches settled fullscreen mode `mode`
   * (`'normal'` or `'fullscreen'`, never the in-flight `'entering'` /
   * `'leaving'`). Reads `WindowRecord.fsMode` off `State.order` — the
   * kernel's one source of truth for a window's fullscreen mode (§0.1.8) —
   * never a second representation of "is this window fullscreen". Exists to
   * sequence around the macOS fullscreen animation: hiding or destroying a
   * fullscreen host mid-AppKit-exit-animation strands a black macOS Space, so
   * a caller awaits the settle first.
   *
   * Two departures from the ported implementation:
   *   - resolves `'vanished'` (and unsubscribes) the moment `id` names no
   *     record — at call time, or mid-await if the window closes. The old
   *     owner's `getWindowMode` returns `null` for an unknown id forever, so
   *     a window closing mid-await hung the caller (`closeOrHideWindow`'s
   *     hybrid branch) and leaked the subscriber; a vanished record has
   *     nothing left to wait for.
   *   - bounded by `timeoutMs` (default `DEFAULT_FULLSCREEN_SETTLE_TIMEOUT_MS`,
   *     aliased from `window-kernel.ts FULLSCREEN_SETTLE_TIMEOUT_MS` — the
   *     same bound `electron-window-backend.ts` uses for its settle timer):
   *     a wrong-way reconcile that never reports a settle can no longer
   *     strand a caller forever. The `FsSettleOutcome` return makes the
   *     give-up observable and distinguishable from a real settle.
   *
   * Every exit path — the immediate return, the subscribe callback, and the
   * timeout — unsubscribes before resolving.
   */
  waitForSettledFsMode(
    id: WindowId,
    mode: 'normal' | 'fullscreen',
    timeoutMs: number = DEFAULT_FULLSCREEN_SETTLE_TIMEOUT_MS,
  ): Promise<FsSettleOutcome> {
    const initial = this.findRecord(id);
    if (initial === undefined) return Promise.resolve('vanished');
    if (initial.fsMode.name === mode) return Promise.resolve('settled');

    return new Promise((resolve) => {
      let settled = false;
      let unsub: () => void;
      let timer: ReturnType<typeof setTimeout>;

      const finish = (outcome: FsSettleOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(outcome);
      };

      unsub = this.subscribe(() => {
        const record = this.findRecord(id);
        if (record === undefined) {
          finish('vanished');
          return;
        }
        if (record.fsMode.name === mode) finish('settled');
      });
      timer = setTimeout(() => finish('timed-out'), timeoutMs);
    });
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
    // The visibility-echo counterpart of the guard above (`isStaleWindowEcho`):
    // an `AttachOverlayTo` and a `HideWindow` can both be emitted for the same
    // transition (the overlay detaches from a closing host while it re-attaches
    // to a surviving one), each performing a real native call and queuing its
    // own confirming echo. Applied out of the order the OS calls actually
    // landed in, the hide's echo can read as a fresh hide against a model the
    // attach's own echo has already moved past — and `react` re-emitting a
    // `HideWindow` for it starts an alternation the queue has no depth limit
    // to stop. Dropping the stale echo before `evolve` sees it is what ends
    // it. See `window-kernel.ts isStaleWindowEcho`.
    if ((event.type === 'WindowShown' || event.type === 'WindowHidden') && event.opSeq !== undefined) {
      if (isStaleWindowEcho(this.state, event.id, event.opSeq)) {
        DEBUG && console.log('[window-kernel] dropped stale visibility echo for', event.id, event.type);
        return;
      }
    }

    const prev = this.state;
    const next = evolve(prev, event);
    const effects = react(prev, event, next);
    this.state = next;
    this.logTransition(event, prev, next);
    this.recordTimeline(event, prev, next, effects);
    this.runEffects(effects);
    this.notify();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // E2E transition timeline (diagnostic)
  //
  // The state SNAPSHOT the overlay bridge already reports (`hybrid-overlay.ts
  // installTestBridge attachDiagnostic`) answers "what does the kernel believe
  // now"; it cannot answer "which transition put it there", which is the open
  // question about the overlay deactivation failure
  // (`docs/design/window-manager.md` -> "The stated mechanism is REFUTED, and
  // the macOS failure is a missing detach"). A nested dispatch is QUEUED by
  // `pump` rather than recursing, so an effect issued for one event is applied
  // strictly after that event's own effects finish — an ordering that only an
  // applied-order log makes visible.
  //
  // One entry per APPLY, in applied order, so a re-show provoked by an earlier
  // hide shows up as its own later entry rather than being folded into the
  // hide that caused it. Effects are recorded as EMITTED (the `react` output),
  // before `runEffects` performs any of them.
  //
  // Pure observation, same contract as `logTransition`: reads already-computed
  // snapshots only, never feeds back into effect emission. Off entirely
  // outside `E2E_TEST`, and bounded, so it can never grow a long-lived run.
  // ───────────────────────────────────────────────────────────────────────────

  private readonly timeline: string[] = [];
  private timelineSeq = 0;

  private recordTimeline(event: Event, prev: State, next: State, effects: readonly Effect[]): void {
    if (!TIMELINE_ENABLED) return;
    const evId = 'id' in event && event.id !== undefined ? `(${String(event.id)})` : '';
    const keyDelta = prev.key === next.key ? `key=${String(next.key)}` : `key=${String(prev.key)}->${String(next.key)}`;
    const eff = effects.map((e) => ('id' in e ? `${e.type}(${String(e.id)})` : e.type)).join(',') || '-';
    const hosts = next.order
      .filter((r) => r.kind === 'page-host' && r.layer === BASE_LAYER)
      .map((r) => `${String(r.id)}${r.visible ? '+' : '-'}${r.orderable ? 'o' : ''}`)
      .join(' ');
    this.pushTimeline(`#${this.timelineSeq++} ${event.type}${evId} ${keyDelta} eff=[${eff}] hosts=[${hosts}]`);
  }

  private pushTimeline(line: string): void {
    this.timeline.push(line);
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.shift();
  }

  /** E2E-only: annotate the timeline from outside the pump (the bridge marks each drain). */
  markTimeline(label: string): void {
    if (!TIMELINE_ENABLED) return;
    this.pushTimeline(`#${this.timelineSeq++} --- ${label}`);
  }

  /** E2E-only: the applied-order transition timeline, oldest first. */
  timelineForTests(): readonly string[] {
    return this.timeline;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transition log — one DEBUG-gated line per transition, ported from
  // `window-os-adapter.ts logTransition` (that module's permanent trace, the
  // live-diagnosis tool for window behaviour; see its header for the incident
  // history this pattern already earned). Same gating, same call point in the
  // pump (right after the new state is produced, before effects run), same
  // helper shapes — `eventWindowId` / `eventWindowIdTag` / `fmt` /
  // `modeDeltas` below — adapted to this kernel's actual fields:
  //
  //   - `before.front` -> `after.front`   becomes `before.key` -> `after.key`.
  //     This kernel has no `front`; `key` (State §"RULE 2") is the field an OS
  //     focus report writes, so it is the transition log's front-equivalent.
  //   - the `contentFocused` delta        still keys off `WindowRecord
  //                                       .contentFocused`, just looked up
  //                                       against `after.key` instead of
  //                                       `after.front` — same field, same
  //                                       window-of-interest substitution.
  //   - `before.stackOrder` -> `after.stackOrder` (a bare `WindowId[]`)
  //                                       becomes an `order=[...]` delta over
  //                                       `State.order` (`WindowRecord[]`,
  //                                       §0.1.4 RULE 1) mapped to ids — the
  //                                       kernel keeps membership AND order in
  //                                       one structure, so there is no
  //                                       separate stack array to format.
  //   - `modeDeltas`                      unchanged in shape: both kernels key
  //                                       a record's fullscreen state off
  //                                       `fsMode.name`.
  //   - the old log's trailing `satellite=.. eligible=..` fragment (emitted
  //     only for `OS_FOCUS_GAINED`) is DROPPED, not adapted: it reads
  //     `window-state.ts`'s `WindowRecord.satellite` and `isEligibleFront`,
  //     neither of which this kernel's `WindowRecord` has (no satellite
  //     concept in this slice, §0.1.4's field list). Nothing to map it onto.
  //   - the tag vocabulary is simpler than the old log's: this kernel's
  //     `Event` union carries a window id on the `id` field alone (no
  //     `ESC_PRESSED`-style `landedId` / switcher-pair `windowId` — those
  //     surfaces are not part of this kernel's event set), so
  //     `eventWindowIdTag` needs no per-type special case.
  //
  // Prefix: `[window-kernel]`, distinct from the old adapter's `[window-state]`
  // and matching every other DEBUG line already in this file (the rejection
  // log in `execute`, the stale-echo drop, the subscriber-threw guard, the
  // effect-failure log) — one greppable name for the whole module.
  //
  // PURE OBSERVATION, never allowed to affect the pump: reads only `before`/
  // `after`, both already-computed snapshots, and every field access here is
  // a `.find()` + optional chaining or a `.map()` — nothing that can throw on
  // an event naming a window absent from `order`, and nothing that mutates
  // state or feeds back into effect emission.
  // ───────────────────────────────────────────────────────────────────────────

  private logTransition(event: Event, before: State, after: State): void {
    if (!DEBUG) return;
    const tag = eventWindowIdTag(event);
    let line = `[window-kernel] ${event.type}${tag == null ? '' : ` ${tag}`} key ${fmt(before.key)}→${fmt(after.key)}`;
    // The key window's content-first-responder delta — the kernel-side
    // analogue of the old log's front `contentFocused` line, keyed off
    // `after.key` instead of `after.front`. Logged only when it moved for the
    // window that holds key AFTER the transition.
    const beforeFocused = before.order.find((w) => w.id === after.key)?.contentFocused;
    const afterFocused = after.order.find((w) => w.id === after.key)?.contentFocused;
    if (after.key != null && beforeFocused !== afterFocused) {
      line += ` contentFocused ${beforeFocused}→${afterFocused}`;
    }
    // `order` delta: whenever the bottom->top id sequence changed, log the
    // resulting list so a live run can compare it against the real
    // (CGWindowList) stack — the kernel-side equivalent of the old log's
    // `stack=[...]` line, sourced from `State.order` (RULE 1) instead of a
    // separate `stackOrder` array.
    const beforeOrder = before.order.map((w) => w.id).join(' ');
    const afterOrder = after.order.map((w) => w.id).join(' ');
    if (beforeOrder !== afterOrder) {
      line += ` order=[${afterOrder}]`;
    }
    for (const part of modeDeltas(before, after)) line += ` ${part}`;
    console.log(line);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Effects
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `SetStacking` is separated from the rest of the batch and replayed LAST, in
   * layer bands (§0.1.6): `moveTop()` bottom-to-top within each layer.
   * `react` emits a MINIMAL set of these — the smallest trailing run of each
   * band's order that still reproduces the whole band, not every eligible
   * window — so this replay is a targeted diff, not a re-assert loop: it no
   * longer self-corrects a perturbation the OS made on its own, and it
   * depends on `prev` (the model `react` diffed against) actually matching
   * what the OS currently has. Ordering the replay by band (lowest first) and
   * keeping array order within a band is what "within each layer" means in
   * practice: each native call only reorders within the window's own level,
   * so a band's result depends on the relative order of ITS OWN calls and on
   * nothing else. Cross-band position in `order` is unobservable to the OS,
   * which is exactly why regrouping the emission is behaviour-preserving.
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
        this.backend.hideWindow(effect.id, effect.opSeq);
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
        // forget for the machine — tracked so the test bridge can await it,
        // same as `window-os-adapter.ts`'s CLOSE_WINDOW/CLOSE_WINDOW_DIRECT.
        // The transient-autoclose sweep's own dismissal effect is the
        // DIFFERENT `DismissWindow` below, which deliberately DOES go through
        // `closeOrHide` — see that case.
        this.trackAsyncEffect(this.backend.closeWindow(effect.id));
        return;
      }
      case 'DismissWindow': {
        // The transient-autoclose sweep's dismissal (`react`'s diff of
        // `State.lastAttention`) — unconditionally routed through
        // `closeOrHide`, never `closeWindow` above. `closeOrHide` is the
        // existing close/hide seam (`windows.ts closeOrHideWindow`): it
        // honors keepLive (hides rather than destroys a slide/peek meant to
        // keep running) and runs the exit-native-fullscreen preamble before
        // hiding/closing a fullscreen victim, so a dismissed window never
        // strands a black macOS Space. Fire-and-forget for the machine —
        // tracked so the test bridge can await it, same as
        // `window-os-adapter.ts`'s CLOSE_WINDOW/CLOSE_SWITCHER_WINDOW.
        this.trackAsyncEffect(this.backend.closeOrHide(effect.id));
        return;
      }
      case 'RaiseWindow': {
        const record = this.state.order.find((w) => w.id === effect.id);
        switch (planRaise(record, this.headless, this.state.appActive)) {
          case 'suppressed':
            return;
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
      case 'ReconcileFullscreen': {
        // No headless gate — this is a read (`isFullScreen()`), not a window
        // write: it neither shows, activates, nor moves anything.
        this.backend.reconcileFullscreen(effect.id);
        return;
      }
      case 'SetBounds': {
        // No headless gate — a bounds write neither activates, takes key, nor
        // brings a hidden window on screen (the same reasoning the old
        // executor records for this family).
        this.backend.setWindowBounds(effect.id, effect.bounds);
        return;
      }
      case 'SetDesktopMembership': {
        // Headless-gated: realizing membership can move the real window
        // between the user's desktops (or, on the backend that has one,
        // touch the app's activation policy) — an agent/CI run must not do
        // either. HOW the intention is realized, on any given platform,
        // including how many native calls it takes, is entirely the
        // backend's decision; the executor passes the intention through
        // unchanged and carries no platform option of its own.
        if (this.headless) return;
        this.backend.setDesktopMembership(effect.id, effect.membership);
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
        // guests before closing the host. Fire-and-forget for the machine
        // here, same as `CloseWindow` — tracked so the test bridge can await
        // it. No keepLive policy is re-applied: the caller's intent was close.
        this.trackAsyncEffect(this.backend.closeWindow(effect.id));
        return;
      }
      case 'FocusContent': {
        // Headless-gated, for the same reason the `inactive-show` raise plan
        // is: taking macOS first responder IS taking focus, and an agent/CI
        // run must not take it (peek `2b55f3af`). The raise this effect is
        // paired with already masks itself; this half has to mask itself too,
        // or the pair would be focus-free in one call and focus-stealing in
        // the next.
        if (this.headless) return;
        // The port takes the op token; the effect does not carry one (see the
        // `FocusContent` effect's doc). `this.state` is `next` by the time
        // effects run (`apply` assigns it before `runEffects`), so this is the
        // very token the `RaiseWindow` emitted alongside it carries — the two
        // halves of one raise arm the backend's self-caused-focus expectation
        // with one number, exactly as the `show-and-focus-content` plan above
        // does when it reuses `effect.opSeq` for both calls.
        this.backend.focusContent(effect.id, this.state.opSeqCounter);
        return;
      }
      case 'DestroyAllGuests': {
        // Process-wide, names no window. The call is ASYNC and its settlement
        // is load-bearing — `webContents.destroy()` returns while the guest is
        // still alive — but the await belongs to the quit sequencing that owns
        // the port (`entry.ts runBeforeQuitCleanup` awaits it before the
        // re-quit), not to the pump: an executor that blocked here would stall
        // every other effect in the batch. Retained in the dedicated
        // guest-teardown slot (not just `pendingAsyncEffects`) so
        // `waitForGuestTeardown` can await THIS settlement specifically —
        // same split as `window-os-adapter.ts`'s DESTROY_ALL_GUESTS.
        const teardown = this.backend.destroyAllContentGuests();
        this.guestTeardown = teardown;
        this.trackAsyncEffect(teardown);
        return;
      }
      case 'AttachOverlayTo': {
        // No headless gate — an attach neither activates, takes key, nor
        // brings a hidden window on screen (the same reasoning the `SetBounds`
        // case above records for this family): it only asks the backend to
        // frame `hostId`, and the visibility that follows is already gated
        // elsewhere (the `ShowWindow`/`RaiseWindow` effects those transitions
        // emit in their own right).
        this.backend.attachOverlayTo(effect.overlayId, effect.hostId);
        return;
      }
      default: {
        const exhaustive: never = effect;
        void exhaustive;
        return;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Async-effect settlement tracking — ported from `window-os-adapter.ts`
  // (same names, same two-tier shape). `performEffect` above fires the
  // async backend calls fire-and-forget for the machine (the pump never
  // recurses on their settlement); this set exists so callers OUTSIDE the
  // pump can await "the effects issued so far have settled" — the before-quit
  // sequence awaiting the last `DestroyAllGuests` teardown, and the E2E test
  // bridge awaiting in-flight effects before asserting.
  // ───────────────────────────────────────────────────────────────────────────

  /** In-flight async effect promises (delegated closes, guest teardown). */
  private readonly pendingAsyncEffects = new Set<Promise<unknown>>();

  /**
   * Settlement of the most recent `DestroyAllGuests`. NOT test-bridge
   * support: the before-quit sequencing gates the re-quit on it, which is the
   * whole reason quit-time guest teardown happens before host windows close.
   * Kept separate from `pendingAsyncEffects` deliberately — that set is an
   * unbounded "wait for everything" the quit path must not depend on.
   */
  private guestTeardown: Promise<void> = Promise.resolve();

  /**
   * Resolve once the last requested guest teardown has settled (bounded
   * inside the backend). Resolved already when no teardown has been
   * requested.
   */
  async waitForGuestTeardown(): Promise<void> {
    try {
      await this.guestTeardown;
    } catch {
      /* the teardown is best-effort; quit proceeds either way */
    }
  }

  /** Retain an async effect's promise until it settles (never rethrows). */
  private trackAsyncEffect(p: Promise<unknown>): void {
    this.pendingAsyncEffects.add(p);
    const drop = () => this.pendingAsyncEffects.delete(p);
    p.then(drop, drop);
  }

  /**
   * Test-bridge support: resolve once every currently-pending async effect —
   * and any async effect those spawn while settling — has settled.
   * Deterministic: the resolution is the effects' own promises, no timer
   * loop and no re-derived deadline.
   */
  async waitForPendingAsyncEffects(): Promise<void> {
    while (this.pendingAsyncEffects.size > 0) {
      await Promise.allSettled([...this.pendingAsyncEffects]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition-log helpers — ported from `window-os-adapter.ts` (see
// `logTransition`'s doc for the field-by-field mapping onto this kernel).
// ─────────────────────────────────────────────────────────────────────────────

/** The window id carried by an event's `id` field, if it has one. */
function eventWindowId(event: Event): WindowId | null {
  return 'id' in event && typeof event.id === 'string' ? event.id : null;
}

/**
 * The transition-log tag for an event's window id. Simpler than the old
 * adapter's version: this kernel's `Event` union carries a window id on the
 * `id` field alone — no `ESC_PRESSED`-style secondary id field and no
 * switcher pair — so there is no per-type tag name to disambiguate.
 */
function eventWindowIdTag(event: Event): string | null {
  const id = eventWindowId(event);
  return id == null ? null : `id(${id})`;
}

/** Render a nullable id for the transition log. */
function fmt(id: WindowId | null): string {
  return id == null ? 'none' : String(id);
}

/** `mode(id) x→y` fragments for every window whose fsMode name changed. */
function modeDeltas(before: State, after: State): string[] {
  const beforeById = new Map(before.order.map((w) => [w.id, w.fsMode.name]));
  const parts: string[] = [];
  for (const w of after.order) {
    const prev = beforeById.get(w.id);
    if (prev !== undefined && prev !== w.fsMode.name) {
      parts.push(`mode(${w.id}) ${prev}→${w.fsMode.name}`);
    }
  }
  return parts;
}
