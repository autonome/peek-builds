// window-kernel-executor.ts — the impure edge of the window kernel. Owns one
// kernel `State`, runs the `decide`/`evolve`/`react` triple from
// `window-kernel.ts`, and performs the resulting `Effect`s through the
// `WindowBackend` port. Design: `docs/design/window-manager.md` §0.1.

import { DEBUG, isHeadless } from './config.js';
import { wmLog } from './window-diag.js';
import { shouldArmEscapeGrab, switcherWindow } from './window-escape.js';
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
  keyWindow,
  react,
  traceTransientAutoclose,
  type Command,
  type Effect,
  type Event,
  type Rectangle,
  type Rejection,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';

// Distinguishes a real settle from a bounded give-up or a record that stopped existing mid-await.
export type FsSettleOutcome = 'settled' | 'timed-out' | 'vanished';

// Gates `recordTimeline` — set only for E2E runs.
const TIMELINE_ENABLED = process.env.E2E_TEST === 'true';

// Ring-buffer bound on the E2E transition timeline.
const TIMELINE_LIMIT = 400;

export function stackingLevelForLayer(layer: number): StackingLevel {
  return layer > BASE_LAYER ? 'pinned' : 'stacked';
}

export type RaisePlan = 'suppressed' | 'inactive-show' | 'show-and-focus-content' | 'activating-raise';

export function planRaise(
  record: WindowRecord | undefined,
  headless: boolean,
  appActive: boolean,
  intent?: 'user',
): RaisePlan {
  if (headless) return 'inactive-show';
  // A backgrounded app suppresses a machine-triggered raise outright — no show, no activate, no
  // content focus — unless the raise carries `intent: 'user'` (a hotkey/CLI verb asked for it).
  if (!appActive && intent !== 'user') return 'suppressed';
  // Keys on the record's declared `nonActivating` fact, never on `role` or `class`.
  if (record !== undefined && record.kind === 'page-host' && record.nonActivating === true) {
    return 'show-and-focus-content';
  }
  return 'activating-raise';
}

export type RaiseRealization = 'reorder' | 'take-key' | 'show-and-take-key';
export function planRaiseRealization(alreadyVisible: boolean, alreadyKey: boolean): RaiseRealization {
  if (!alreadyVisible) return 'show-and-take-key';
  if (alreadyKey) return 'reorder';
  return 'take-key';
}

// Whether hiding a window makes the platform hand focus to another of the
// app's windows, a focus the machine never asked for and must not read as the
// user's. Only a focused window's hide does, and only while the app is active:
// an inactive app's hide reassigns nothing, so expecting an echo there would
// leave the expectation standing until it swallowed the user's next real click.
export function hideProvokesFocusReassignment(windowFocused: boolean, appActive: boolean): boolean {
  return windowFocused && appActive;
}

export function planRestoreFocus(coldStart: boolean, headless: boolean, appActive: boolean): boolean {
  return appActive || (coldStart && !headless);
}

export interface WindowKernelExecutorOptions {
  // Starting state; defaults to `initialState()`. Replay/tests supply their own.
  initial?: State;
  // Whether this process runs focus-free; defaults to `isHeadless()`, injected so tests can set it directly.
  headless?: boolean;
}

export type CommandOutcome = { applied: true; events: readonly Event[] } | { rejected: Rejection };

export class WindowKernelExecutor {
  private state: State;
  private readonly backend: WindowBackend;
  private readonly headless: boolean;

  constructor(backend: WindowBackend, opts: WindowKernelExecutorOptions = {}) {
    this.backend = backend;
    this.state = opts.initial ?? initialState();
    this.headless = opts.headless ?? isHeadless();
  }

  getState(): State {
    return this.state;
  }

  // Captured in `performEffect`'s `CloseWindow` case before the native close call, because that
  // call's OS close report can land synchronously.
  getRetiredPresentation(id: WindowId): { maximized: boolean; preMaxBounds: Rectangle | null } | undefined {
    return this.retiredPresentation.get(id);
  }

  private readonly retiredPresentation = new Map<WindowId, { maximized: boolean; preMaxBounds: Rectangle | null }>();

  shouldRestoreFocus(coldStart: boolean): boolean {
    return planRestoreFocus(coldStart, this.headless, this.state.appActive);
  }

  subscribe(listener: (state: State) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

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

  private findRecord(id: WindowId): WindowRecord | undefined {
    return this.state.order.find((w) => w.id === id);
  }

  // Every exit path (the immediate return, the subscribe callback, the timeout) unsubscribes
  // before resolving.
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

  dispatch(event: Event): void {
    this.pump(event);
  }

  execute(command: Command): CommandOutcome {
    const outcome = decide(this.state, command);
    if ('rejected' in outcome) {
      DEBUG && console.log('[window-kernel] rejected', command.type, outcome.rejected);
      return { rejected: outcome.rejected };
    }
    for (const event of outcome.events) this.pump(event);
    return { applied: true, events: outcome.events };
  }

  private readonly pendingEvents: Event[] = [];

  private pumping = false;

  // FIFO: a dispatch that arrives while a pump is already draining is queued rather than run
  // inline, so it lands behind everything already queued instead of recursing mid-batch.
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

  private apply(event: Event): void {
    if (event.type === 'OsFocusGained' && event.cause !== undefined) {
      // Drops a late machine echo before `evolve` sees it, because its `opSeq` is below the
      // record's `lastOpSeq` — deliberately `<`, pairing with `isOpConfirmation`'s `===` in the kernel.
      if (isStaleSelfEcho(this.state, event.id, event.cause)) {
        DEBUG && console.log('[window-kernel] dropped stale self-echo for', event.id);
        wmLog('stale-focus-echo-dropped', {
          id: event.id,
          causeKind: event.cause.kind,
          opSeq: event.cause.kind === 'machine' ? event.cause.opSeq : undefined,
        });
        return;
      }
    }
    if ((event.type === 'WindowShown' || event.type === 'WindowHidden') && event.opSeq !== undefined) {
      if (isStaleWindowEcho(this.state, event.id, event.opSeq)) {
        DEBUG && console.log('[window-kernel] dropped stale visibility echo for', event.id, event.type);
        wmLog('stale-visibility-echo-dropped', { id: event.id, echoType: event.type, opSeq: event.opSeq });
        return;
      }
    }

    const prev = this.state;
    const next = evolve(prev, event);
    const effects = react(prev, event, next);
    this.state = next;
    this.logTransition(event, prev, next);
    this.recordTimeline(event, prev, next, effects);
    this.logDismissalDecisions(event, prev, next);
    // DIAG (kernel-desktops live peek check): name the event that marks a window for dismissal.
    {
      const marked = next.order.filter((w) => w.pendingHidden === true && prev.order.find((p) => p.id === w.id)?.pendingHidden !== true);
      if (marked.length > 0) {
        wmLog('diag-dismiss-mark', {
          event: event.type,
          eventId: 'id' in event ? String(event.id) : undefined,
          marked: marked.map((w) => w.id).join(','),
          prevKey: String(prev.key),
          key: String(next.key),
          appActive: next.appActive,
          attention: next.lastAttention ? `${String(next.lastAttention.holder)}:${next.lastAttention.cause.kind}` : 'null',
        });
      }
    }
    this.runEffects(effects);
    this.reconcileEscGrab();
    this.notify();
  }

  private escGrabArmed: boolean | null = null;

  // No-op unless `desired` actually changes from the last value armed — re-registering the OS
  // grab on every dispatch would be new observable behavior.
  private reconcileEscGrab(): void {
    if (this.headless) return;
    const desired = shouldArmEscapeGrab(this.state);
    if (desired === this.escGrabArmed) return;
    const holder = keyWindow(this.state);
    wmLog('esc-grab-reconcile', {
      armed: desired,
      appActive: this.state.appActive,
      switcherOpen: switcherWindow(this.state) !== null,
      keyHolder: holder?.id ?? null,
      keyHolderContentFocused: holder?.contentFocused ?? null,
    });
    this.escGrabArmed = desired;
    this.backend.setEscGrab(desired);
  }

  private readonly timeline: string[] = [];
  private timelineSeq = 0;

  private recordTimeline(event: Event, prev: State, next: State, effects: readonly Effect[]): void {
    if (!TIMELINE_ENABLED) return;
    const evId = 'id' in event && event.id !== undefined ? `(${String(event.id)})` : '';
    const keyDelta = prev.key === next.key ? `key=${String(next.key)}` : `key=${String(prev.key)}->${String(next.key)}`;
    // A `RaiseWindow` effect's `intent` rides as a `:user` suffix rather than
    // a separate field, so an existing `includes('RaiseWindow(<id>)')` /
    // regex check (matching the bare parenthesized id) keeps matching either
    // way — only a check for the intent itself needs the suffix.
    const eff = effects
      .map((e) => {
        if (!('id' in e)) return e.type;
        const intentSuffix = 'intent' in e && e.intent ? `:${e.intent}` : '';
        return `${e.type}(${String(e.id)})${intentSuffix}`;
      })
      .join(',') || '-';
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

  markTimeline(label: string): void {
    if (!TIMELINE_ENABLED) return;
    this.pushTimeline(`#${this.timelineSeq++} --- ${label}`);
  }

  timelineForTests(): readonly string[] {
    return this.timeline;
  }

  private logTransition(event: Event, before: State, after: State): void {
    if (!DEBUG) return;
    const tag = eventWindowIdTag(event);
    let line = `[window-kernel] ${event.type}${tag == null ? '' : ` ${tag}`} key ${fmt(before.key)}→${fmt(after.key)}`;
    // Logged only when the content-focus of the AFTER key window changed.
    const beforeFocused = before.order.find((w) => w.id === after.key)?.contentFocused;
    const afterFocused = after.order.find((w) => w.id === after.key)?.contentFocused;
    if (after.key != null && beforeFocused !== afterFocused) {
      line += ` contentFocused ${beforeFocused}→${afterFocused}`;
    }
    // Logged whenever the bottom-to-top id sequence changed, for comparison against the real stack.
    const beforeOrder = before.order.map((w) => w.id).join(' ');
    const afterOrder = after.order.map((w) => w.id).join(' ');
    if (beforeOrder !== afterOrder) {
      line += ` order=[${afterOrder}]`;
    }
    for (const part of modeDeltas(before, after)) line += ` ${part}`;
    console.log(line);
  }

  // Shared tail of both dismissal-sweep branches below, so they cannot drift into different log shapes.
  private logTransientSweepTrace(
    holder: WindowId | null,
    causeKind: string,
    causeOpSeq: number | undefined,
    trace: ReturnType<typeof traceTransientAutoclose>,
  ): void {
    const dismissedCount = trace.filter((t) => t.dismissed).length;
    wmLog('transient-sweep', {
      holder,
      cause: causeKind,
      opSeq: causeOpSeq,
      dismissed: dismissedCount,
      spared: trace.length - dismissedCount,
    });
    for (const t of trace) {
      if (t.dismissed) {
        wmLog('transient-dismiss', { id: t.id, holder, cause: causeKind, opSeq: causeOpSeq });
      } else {
        wmLog('transient-spare', { id: t.id, holder, exemption: t.exemption });
      }
    }
  }

  private logDismissalDecisions(event: Event, prev: State, next: State): void {
    const attention = next.lastAttention;
    if (attention !== null && attention.seq !== prev.lastAttention?.seq) {
      const holder = attention.holder;
      if (next.order.some((w) => w.id === holder)) {
        const trace = traceTransientAutoclose(next, holder, attention.cause);
        const causeOpSeq = attention.cause.kind === 'machine' ? attention.cause.opSeq : undefined;
        this.logTransientSweepTrace(holder, attention.cause.kind, causeOpSeq, trace);
      } else {
        wmLog('transient-sweep-indeterminate', { holder });
      }
    }

    if (prev.pendingAppResignSweep && !next.pendingAppResignSweep && !next.appActive) {
      const trace = traceTransientAutoclose(next, null);
      this.logTransientSweepTrace(null, 'world', undefined, trace);
    }

    if (event.type === 'AppResigned') {
      const victims = appResignHideVictims(prev, next);
      wmLog('app-resign-armed', { victims: victims.length, ids: victims.join(',') || undefined });
    } else if (event.type === 'AppResignSettled') {
      if (!prev.pendingAppResignSweep) {
        wmLog('app-resign-settle-noop', { reason: 'not-armed' });
      } else {
        const victims = appResignHideVictims(prev, next);
        wmLog('app-resign-settle', { victims: victims.length, ids: victims.join(',') || undefined });
      }
    }
  }

  // `SetStacking` effects are pulled out of the batch and replayed last, lowest layer first:
  // each native call only reorders within a window's own level, so a band's result depends on
  // the relative order of its own calls and nothing else.
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
        this.backend.showWindow(effect.id, { activate: false, opSeq: effect.opSeq });
        return;
      }
      case 'HideWindow': {
        this.backend.hideWindow(effect.id, effect.opSeq);
        return;
      }
      case 'CloseWindow': {
        // Guest-safe direct close, not `destroyWindow` — that skips beforeunload/close events
        // entirely and is reserved for forceful teardown, never ordinary dismissal.
        wmLog('effect-close', { effect: effect.type, id: effect.id });
        this.retiredPresentation.set(effect.id, { maximized: effect.maximized, preMaxBounds: effect.preMaxBounds });
        this.trackAsyncEffect(
          this.backend.closeWindow(effect.id).finally(() => {
            this.retiredPresentation.delete(effect.id);
          }),
        );
        return;
      }
      case 'DismissWindow': {
        // The transient-autoclose sweep's dismissal, unconditionally routed through `closeOrHide`
        // (never `closeWindow` above) so it honors keepLive and the exit-native-fullscreen preamble.
        wmLog('effect-close', { effect: effect.type, id: effect.id });
        this.trackAsyncEffect(this.backend.closeOrHide(effect.id));
        return;
      }
      case 'RaiseWindow': {
        const record = this.state.order.find((w) => w.id === effect.id);
        switch (planRaise(record, this.headless, this.state.appActive, effect.intent)) {
          case 'suppressed':
            wmLog('raise-suppressed', { id: effect.id, appActive: this.state.appActive, headless: this.headless });
            return;
          case 'inactive-show':
            // `showWindow` masks the OS activation under headless; `activate: true` only makes
            // its echo carry the `OsFocusGained` that lands key on the raised window.
            this.backend.showWindow(effect.id, { activate: true, opSeq: effect.opSeq });
            return;
          case 'show-and-focus-content':
            this.backend.showWindow(effect.id, { activate: false, opSeq: effect.opSeq });
            this.backend.focusContent(effect.id, effect.opSeq);
            return;
          case 'activating-raise':
            this.backend.raiseWindow(effect.id, effect.opSeq, effect.intent);
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
        // No headless gate — this is a read, never a window write.
        this.backend.reconcileFullscreen(effect.id);
        return;
      }
      case 'SetBounds': {
        // No headless gate — a bounds write neither activates, takes key, nor shows a hidden window.
        this.backend.setWindowBounds(effect.id, effect.bounds);
        return;
      }
      case 'SetDesktopMembership': {
        // Headless-gated: realizing membership can move the real window between the user's
        // desktops, which an agent/CI run must not do.
        if (this.headless) return;
        this.backend.setDesktopMembership(effect.id, effect.membership);
        return;
      }
      case 'SetAcceptsInput': {
        // No headless gate — click-through neither activates, takes key, nor shows a hidden window.
        this.backend.setAcceptsInput(effect.id, effect.acceptsInput);
        return;
      }
      case 'SetPinned': {
        // Headless-gated, same as HoldAboveOtherApps/ReleaseFromAboveOtherApps below — a headless
        // window's always-on-top flag was never applied at open time either (ipc.ts's
        // `alwaysOnTopResolved` gate), so there is nothing real to toggle here.
        if (this.headless) return;
        this.backend.pinAlwaysOnTop(effect.id, effect.pinned);
        return;
      }
      case 'SetStacking': {
        // Handled by the band replay in `runEffects`; never reached.
        this.backend.setStacking(effect.id, stackingLevelForLayer(effect.layer));
        return;
      }
      case 'DestroyWindow': {
        // Forceful, synchronous native destroy with no guest pass — `CloseWindowDirect` below
        // is the teardown for a window that owns page-host guests.
        wmLog('effect-close', { effect: effect.type, id: effect.id });
        this.backend.destroyWindow(effect.id);
        return;
      }
      case 'CloseContent': {
        // Wedged-guest fallback — the port's guard makes this a no-op on every ordinary path.
        wmLog('effect-close', { effect: effect.type, id: effect.id });
        this.backend.closeContent(effect.id);
        return;
      }
      case 'CloseWindowDirect': {
        // Guest-safe: awaits the window's registered guests before closing the host.
        wmLog('effect-close', { effect: effect.type, id: effect.id });
        this.trackAsyncEffect(this.backend.closeWindow(effect.id));
        return;
      }
      case 'FocusContent': {
        // Headless-gated, same as the raise this effect pairs with: taking first responder is
        // taking focus, and an agent/CI run must not take it.
        if (this.headless) return;
        // Reuses `this.state.opSeqCounter` (this effect carries no token of its own) so the
        // raise and this focus arm the same self-caused-focus expectation.
        this.backend.focusContent(effect.id, this.state.opSeqCounter);
        return;
      }
      case 'ShowDesktop': {
        // No backend can switch desktops yet (macOS gets no writes; the X11 provider is
        // unscheduled), so there is no port call: on macOS the raise that follows takes the user
        // to the window's desktop. Logged so a live check can see the request.
        wmLog('effect-show-desktop', { desktop: effect.desktop });
        return;
      }
      case 'DestroyAllGuests': {
        // Async, and the pump doesn't await it. Kept in `guestTeardown` — separate from
        // `pendingAsyncEffects` — so `waitForGuestTeardown` can await this settlement specifically.
        const teardown = this.backend.destroyAllContentGuests();
        this.guestTeardown = teardown;
        this.trackAsyncEffect(teardown);
        return;
      }
      case 'HideApp': {
        this.backend.hideApp();
        return;
      }
      case 'HoldAboveOtherApps': {
        // Headless-gated: a headless window is fully transparent but still takes clicks, so
        // holding one above other applications would put an invisible click target over them.
        if (this.headless) return;
        this.backend.pinAlwaysOnTop(effect.id, true);
        return;
      }
      case 'ReleaseFromAboveOtherApps': {
        // Gated with the hold it undoes — under headless there is nothing to release.
        if (this.headless) return;
        this.backend.pinAlwaysOnTop(effect.id, false);
        return;
      }
      case 'AttachOverlayTo': {
        // No headless gate — this only asks the backend to frame `hostId`; the visibility that
        // follows is gated by its own `ShowWindow`/`RaiseWindow` effects.
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

  private readonly pendingAsyncEffects = new Set<Promise<unknown>>();

  // Kept separate from `pendingAsyncEffects` — that set is unbounded, and the quit path must
  // not depend on it.
  private guestTeardown: Promise<void> = Promise.resolve();

  async waitForGuestTeardown(): Promise<void> {
    try {
      await this.guestTeardown;
    } catch {
      /* the teardown is best-effort; quit proceeds either way */
    }
  }

  // For async effects issued outside the pump (e.g. the Escape decider's renderer round trip)
  // that `performEffect` never sees.
  trackExternalAsyncEffect(p: Promise<unknown>): void {
    this.trackAsyncEffect(p);
  }

  private trackAsyncEffect(p: Promise<unknown>): void {
    this.pendingAsyncEffects.add(p);
    const drop = () => this.pendingAsyncEffects.delete(p);
    p.then(drop, drop);
  }

  // Loops because awaiting can itself spawn new async effects before it returns.
  async waitForPendingAsyncEffects(): Promise<void> {
    while (this.pendingAsyncEffects.size > 0) {
      await Promise.allSettled([...this.pendingAsyncEffects]);
    }
  }
}

function eventWindowId(event: Event): WindowId | null {
  return 'id' in event && typeof event.id === 'string' ? event.id : null;
}

function eventWindowIdTag(event: Event): string | null {
  const id = eventWindowId(event);
  return id == null ? null : `id(${id})`;
}

function fmt(id: WindowId | null): string {
  return id == null ? 'none' : String(id);
}

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

// Only a `true → false` flip on `visible`, landing alongside the `hiddenByAppBlur` mark, counts
// as a victim of this transition — a record already hidden before it does not.
function appResignHideVictims(prev: State, next: State): WindowId[] {
  const wasVisible = new Map(prev.order.map((w) => [w.id, w.visible]));
  return next.order.filter((w) => w.hiddenByAppBlur === true && wasVisible.get(w.id) === true).map((w) => w.id);
}
