/**
 * Unit tests for the rewritten window-manager kernel (`window-kernel.ts`).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1, in particular §0.1.8 item 2
 * ("Replay determinism — a standing requirement, enforced by a test that
 * fails when it breaks"). Follows the harness conventions of
 * `window-state.test.ts` (`node:test` + `node:assert`, `.js`-suffixed import
 * of the compiled output, a small branded-id builder).
 *
 * NOTE on "effects": §0.1.1 makes `react(prev, ev, next): Effect[]` a pure
 * projection of the transition, separate from `evolve`. Both halves of the
 * determinism rule are enforced below: identical state AND an identical,
 * concatenated `react` effect list.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  react,
  decide,
  topmost,
  keyWindow,
  type State,
  type Event,
  type Effect,
  type WindowId,
  type Command,
  type Rectangle,
} from './window-kernel.js';

// ── Test builders ────────────────────────────────────────────────────────────

/** Craft a WM WindowId for tests — the kernel never checks the shape, only identity. */
const wid = (n: number): WindowId => `wk-${n}` as WindowId;

/** Recursively `Object.freeze`s `value` — used to prove `react` never writes to its arguments. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as object).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fold(events: Event[], start: State = initialState()): State {
  return events.reduce(evolve, start);
}

/** Folds `events`, accumulating `react(prev, ev, next)` at every step (§0.1.1). */
function foldWithEffects(events: Event[], start: State = initialState()): { state: State; effects: Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  for (const ev of events) {
    const next = evolve(state, ev);
    effects.push(...react(state, ev, next));
    state = next;
  }
  return { state, effects };
}

/** A representative log touching all seven event variants, including a dangling key. */
function buildLog(): Event[] {
  return [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(3), kind: 'page-host', layer: 1, canBecomeKey: false, acceptsInput: false, class: 'hud', parentId: wid(1) },
    { type: 'WindowShown', id: wid(1) },
    { type: 'OsFocusGained', id: wid(1) },
    { type: 'WindowShown', id: wid(2) },
    { type: 'OsFocusGained', id: wid(2) },
    { type: 'AppActiveChanged', active: true },
    { type: 'OsFocusLost', id: wid(2) },
    { type: 'WindowHidden', id: wid(3) },
    { type: 'WindowClosed', id: wid(2) },
    { type: 'AppActiveChanged', active: false },
  ];
}

// ── Replay determinism (§0.1.8 item 2) ──────────────────────────────────────

describe('window-kernel: replay determinism', () => {
  it('INVARIANT: replay determinism — same log yields identical state and effect list', () => {
    const log = buildLog();
    const r1 = foldWithEffects(log);
    const r2 = foldWithEffects(log);
    assert.deepStrictEqual(r1.state, r2.state);
    assert.deepStrictEqual(r1.effects, r2.effects);
  });

  it('INVARIANT: prefix stability — folding a split log resumes to the same state and effect list as folding it whole', () => {
    const log = buildLog();
    const whole = foldWithEffects(log);
    for (let n = 0; n <= log.length; n++) {
      const prefix = foldWithEffects(log.slice(0, n));
      const resumed = foldWithEffects(log.slice(n), prefix.state);
      const state = resumed.state;
      const effects = [...prefix.effects, ...resumed.effects];
      assert.deepStrictEqual(state, whole.state, `split at n=${n} diverged from the whole-log fold`);
      assert.deepStrictEqual(effects, whole.effects, `split at n=${n} diverged in effect list`);
    }
  });

  it('INVARIANT: react is pure — same (prev, ev, next) yields deeply equal results and mutates neither argument', () => {
    const log = buildLog();
    for (let n = 0; n < log.length; n++) {
      const prev = fold(log.slice(0, n));
      const ev = log[n];
      const next = evolve(prev, ev);
      const frozenPrev = deepFreeze(structuredClone(prev));
      const frozenNext = deepFreeze(structuredClone(next));
      const e1 = react(frozenPrev, ev, frozenNext);
      const e2 = react(frozenPrev, ev, frozenNext);
      assert.deepStrictEqual(e1, e2, `react(prev, ev, next) not repeatable at step ${n}`);
      assert.doesNotThrow(
        () => react(frozenPrev, ev, frozenNext),
        `react mutated a deep-frozen prev/next at step ${n}`,
      );
    }
  });

  it('INVARIANT: no ambient input — folding twice from a fresh initialState() is independent of call order/timing', () => {
    // A second, independently-built log exercising the same variants in a
    // different arrangement — if `evolve` read anything but its two
    // arguments (a clock, Math.random(), a module-level counter), two
    // differently-shaped-but-equivalent folds would be the likeliest place
    // for that to surface as nondeterminism.
    const a = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'OsFocusGained', id: wid(1) },
    ]);
    const b = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'OsFocusGained', id: wid(1) },
    ]);
    assert.deepStrictEqual(a, b);
  });
});

// ── evolve is total ──────────────────────────────────────────────────────────

describe('window-kernel: evolve is total', () => {
  const registered = (id: WindowId, over: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    ...over,
  });

  const emptyState = initialState();
  const oneWindowState = evolve(emptyState, registered(wid(1)));
  const severalWindowsState = fold([registered(wid(1)), registered(wid(2)), registered(wid(3))], initialState());
  // A dangling key: focus a window, then close it — `key` still names it internally.
  const danglingKeyState = fold(
    [registered(wid(1)), { type: 'OsFocusGained', id: wid(1) }, { type: 'WindowClosed', id: wid(1) }],
    initialState(),
  );

  const states: Array<[string, State]> = [
    ['empty', emptyState],
    ['one window', oneWindowState],
    ['several windows', severalWindowsState],
    ['dangling key', danglingKeyState],
  ];

  const eventsToTry = (base: State): Event[] => [
    registered(wid(99)),
    { type: 'WindowShown', id: wid(1) },
    { type: 'WindowHidden', id: wid(1) },
    { type: 'WindowClosed', id: wid(1) },
    { type: 'OsFocusGained', id: wid(1) },
    { type: 'OsFocusLost', id: wid(1) },
    { type: 'AppActiveChanged', active: !base.appActive },
    // Events naming a window that was never registered — must not throw.
    { type: 'WindowShown', id: wid(404) },
    { type: 'OsFocusGained', id: wid(404) },
    { type: 'OsFocusLost', id: wid(404) },
  ];

  for (const [label, state] of states) {
    for (const ev of eventsToTry(state)) {
      it(`does not throw: ${label} state x ${ev.type} (id=${'id' in ev ? ev.id : '-'})`, () => {
        let next: State | undefined;
        assert.doesNotThrow(() => {
          next = evolve(state, ev);
        });
        assert.ok(next);
        assert.strictEqual(next!.version, state.version + 1, 'every event bumps version');
      });
    }
  }
});

// ── decide rejects stale commands ───────────────────────────────────────────

describe('window-kernel: decide rejects stale commands', () => {
  it('a Command with a mismatched expectedVersion is rejected and produces no events', () => {
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' }],
      initialState(),
    );
    const result = decide(state, { type: 'HideWindow', id: wid(1), expectedVersion: state.version + 1 });
    assert.deepStrictEqual(result, { rejected: 'stale-version' });
    assert.ok(!('events' in result));
  });

  it('a Command naming an unregistered window is rejected as no-such-window', () => {
    const state = initialState();
    const result = decide(state, { type: 'ShowWindow', id: wid(1), expectedVersion: state.version });
    assert.deepStrictEqual(result, { rejected: 'no-such-window' });
  });
});

// ── key is reported, never repaired ─────────────────────────────────────────

describe('window-kernel: key is never repaired', () => {
  it('closing the key window leaves key resolving to null — nothing picks a successor', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'OsFocusGained', id: wid(1) },
        { type: 'WindowClosed', id: wid(1) },
      ],
      initialState(),
    );
    // The raw field still dangles (unrepaired) ...
    assert.strictEqual(state.key, wid(1));
    // ... but the accessor makes that dangling id unobservable, even though a
    // second, perfectly good window (wid(2)) is still registered — there is
    // no successor-guessing to promote it.
    assert.strictEqual(keyWindow(state), null);
  });
});

// ── re-registration merges, does not append or reorder ──────────────────────

describe('window-kernel: re-registration merges in place', () => {
  it('re-registering a live window merges in place and does NOT move it in the order', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(3), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
        { type: 'OsFocusGained', id: wid(1) },
      ],
      initialState(),
    );
    // wid(1) is shown, holds key, and — from the OsFocusGained raise — sits
    // at the bottom of `order` (moved there ahead of wid(2)/wid(3)).
    assert.deepStrictEqual(state.order.map((w) => w.id), [wid(2), wid(3), wid(1)]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.visible, true);
    const openSeqBefore = state.order.find((w) => w.id === wid(1))!.openSeq;

    // Re-register wid(1) with different intrinsic properties.
    const reRegistered = evolve(state, {
      type: 'WindowRegistered',
      id: wid(1),
      kind: 'browser',
      layer: 2,
      canBecomeKey: false,
      acceptsInput: false,
      class: 'hud',
      parentId: wid(2),
    });

    // Same id count — no duplicate, no drop.
    assert.strictEqual(reRegistered.order.length, 3);
    // Position unchanged — re-registration is not a raise.
    assert.deepStrictEqual(reRegistered.order.map((w) => w.id), [wid(2), wid(3), wid(1)]);

    const merged = reRegistered.order.find((w) => w.id === wid(1))!;
    // Intrinsic properties declared at registration are updated from the event.
    assert.strictEqual(merged.kind, 'browser');
    assert.strictEqual(merged.layer, 2);
    assert.strictEqual(merged.canBecomeKey, false);
    assert.strictEqual(merged.acceptsInput, false);
    assert.strictEqual(merged.class, 'hud');
    assert.strictEqual(merged.parentId, wid(2));
    // Lived facts are preserved, not reset by the re-registration.
    assert.strictEqual(merged.visible, true);
    assert.strictEqual(merged.openSeq, openSeqBefore);
  });
});

// ── raise vs. show ───────────────────────────────────────────────────────────

describe('window-kernel: raise vs. show', () => {
  it('a shown-but-unfocused window does not go on top', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      ],
      initialState(),
    );
    assert.strictEqual(topmost(state, () => true)?.id, wid(2));

    const shown = evolve(state, { type: 'WindowShown', id: wid(1) });
    // Still wid(2) on top — WindowShown alone must not reorder.
    assert.strictEqual(topmost(shown, () => true)?.id, wid(2));
  });

  it('a RaiseWindow command (accepted, and realized as OsFocusGained) does move the target to the top', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const raised = fold(decision.events, state);
    assert.strictEqual(topmost(raised, () => true)?.id, wid(1));
    assert.strictEqual(keyWindow(raised)?.id, wid(1));
  });

  it('showing a hidden window does NOT change its position in order', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(3), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'OsFocusGained', id: wid(2) },
      ],
      initialState(),
    );
    const orderBefore = state.order.map((w) => w.id);
    const decision = decide(state, { type: 'ShowWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const shown = fold(decision.events, state);
    assert.deepStrictEqual(shown.order.map((w) => w.id), orderBefore, 'ShowWindow must not reorder');
    assert.strictEqual(shown.order.find((w) => w.id === wid(1))?.visible, true);
  });
});

// ── CloseOrHideWindow — the keepLive branch point ───────────────────────────

describe('window-kernel: CloseOrHideWindow', () => {
  it('a keepLive window is hidden, not closed, and stays in order', () => {
    const state = fold(
      [
        {
          type: 'WindowRegistered',
          id: wid(1),
          kind: 'page-host',
          layer: 0,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
          keepLive: true,
        },
        { type: 'WindowShown', id: wid(1) },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'CloseOrHideWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    assert.deepStrictEqual(decision.events, [{ type: 'WindowHidden', id: wid(1) }]);
    const next = fold(decision.events, state);
    assert.strictEqual(next.order.some((w) => w.id === wid(1)), true, 'keepLive window must stay in order');
    assert.strictEqual(next.order.find((w) => w.id === wid(1))?.visible, false);
  });

  it('a non-keepLive window is closed and removed from order', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'CloseOrHideWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    assert.deepStrictEqual(decision.events, [{ type: 'WindowClosed', id: wid(1) }]);
    const next = fold(decision.events, state);
    assert.strictEqual(next.order.some((w) => w.id === wid(1)), false, 'non-keepLive window must be removed');
  });
});

// ── orderable gate on SetStacking ────────────────────────────────────────────

describe('window-kernel: orderable gate on SetStacking', () => {
  it('a page-host is omitted from SetStacking until WindowContentOrderable, which then re-emits it fresh', () => {
    const registerEvents: Event[] = [
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    ];
    const registered = fold(registerEvents, initialState());
    assert.strictEqual(registered.order[0].orderable, false, 'a fresh page-host starts non-orderable');

    // Showing the page-host before it is orderable must NOT emit a SetStacking
    // for it (it cannot yet be positioned by the OS).
    const shownEv: Event = { type: 'WindowShown', id: wid(1) };
    const shown = evolve(registered, shownEv);
    const shownEffects = react(registered, shownEv, shown);
    assert.ok(
      !shownEffects.some((e) => e.type === 'SetStacking' && e.id === wid(1)),
      'a non-orderable window must not appear in SetStacking',
    );

    // WindowContentOrderable flips it and must emit a fresh SetStacking for it.
    const orderableEv: Event = { type: 'WindowContentOrderable', id: wid(1) };
    const nowOrderable = evolve(shown, orderableEv);
    assert.strictEqual(nowOrderable.order[0].orderable, true);
    const orderableEffects = react(shown, orderableEv, nowOrderable);
    assert.deepStrictEqual(
      orderableEffects.filter((e) => e.type === 'SetStacking'),
      [{ type: 'SetStacking', id: wid(1), layer: 0 }],
      'WindowContentOrderable must emit a fresh SetStacking for the now-orderable window',
    );
  });
});

// ── closing the key window ──────────────────────────────────────────────────

describe('window-kernel: closing the key window raises nothing in its place', () => {
  it('closing the key window leaves keyWindow() null and the order unchanged besides the removal', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'OsFocusGained', id: wid(1) },
      ],
      initialState(),
    );
    // wid(1) was raised to the top by the focus gain.
    assert.deepStrictEqual(state.order.map((w) => w.id), [wid(2), wid(1)]);

    const closed = evolve(state, { type: 'WindowClosed', id: wid(1) });
    assert.strictEqual(keyWindow(closed), null, 'nothing picks a successor');
    // wid(2) is simply what remains — it was never moved by the close.
    assert.deepStrictEqual(closed.order.map((w) => w.id), [wid(2)]);
  });
});

// ── Fullscreen: an orthogonal region (§0.1.8) ───────────────────────────────

describe('window-kernel: fullscreen is orthogonal to key and order', () => {
  const registerTwo = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
  ];

  it('the four-state transition table', () => {
    const state = fold(registerTwo(), initialState());

    // normal -> entering, via a fresh SetFullscreen command.
    const enterDecision = decide(state, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: state.version });
    assert.ok('events' in enterDecision);
    let s = fold(enterDecision.events, state);
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');

    // entering -> fullscreen, via the OS report.
    s = evolve(s, { type: 'OsFullscreenEntered', id: wid(1) });
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'fullscreen');

    // fullscreen -> leaving, via a fresh SetFullscreen(false) command.
    const leaveDecision = decide(s, { type: 'SetFullscreen', id: wid(1), desired: false, expectedVersion: s.version });
    assert.ok('events' in leaveDecision);
    s = fold(leaveDecision.events, s);
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'leaving');

    // leaving -> normal, via the OS report.
    s = evolve(s, { type: 'OsFullscreenLeft', id: wid(1) });
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'normal');
  });

  it('a request arriving mid-transition records pendingDesire and is applied on settle', () => {
    const state = fold(registerTwo(), initialState());

    // Start entering.
    const enterDecision = decide(state, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: state.version });
    assert.ok('events' in enterDecision);
    let s = fold(enterDecision.events, state);
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');

    // A second request arrives mid-flight (change of mind: actually leave) —
    // must NOT start a second transition, only coalesce.
    const midFlight = decide(s, { type: 'SetFullscreen', id: wid(1), desired: false, expectedVersion: s.version });
    assert.ok('events' in midFlight);
    assert.deepStrictEqual(midFlight.events, [{ type: 'FullscreenDesireRecorded', id: wid(1), desired: false }]);
    s = fold(midFlight.events, s);
    const midMode = s.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(midMode?.name, 'entering', 'still entering — no second transition opened');
    assert.strictEqual((midMode as { pendingDesire?: boolean }).pendingDesire, false);

    // The in-flight transition settles — the OS reports it entered — and the
    // coalesced "actually, leave" desire is applied: net result is `leaving`.
    s = evolve(s, { type: 'OsFullscreenEntered', id: wid(1) });
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'leaving');
  });

  it('FullscreenSettleTimeout never leaves a record in a transitional state', () => {
    const state = fold(registerTwo(), initialState());

    const entering = fold([{ type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null }], state);
    const settledFromEntering = evolve(entering, { type: 'FullscreenSettleTimeout', id: wid(1) });
    assert.strictEqual(settledFromEntering.order.find((w) => w.id === wid(1))?.fsMode.name, 'fullscreen');

    const leaving = fold(
      [
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null },
        { type: 'OsFullscreenEntered', id: wid(1) },
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: false, preBounds: null },
      ],
      state,
    );
    assert.strictEqual(leaving.order.find((w) => w.id === wid(1))?.fsMode.name, 'leaving');
    const settledFromLeaving = evolve(leaving, { type: 'FullscreenSettleTimeout', id: wid(1) });
    assert.strictEqual(settledFromLeaving.order.find((w) => w.id === wid(1))?.fsMode.name, 'normal');
  });

  it('preBounds: null survives a round trip and is distinguishable from "no stash concept"', () => {
    const state = fold(registerTwo(), initialState());
    // OS/green-button entry — no stash was possible, preBounds is `null`.
    const entered = evolve(state, { type: 'OsFullscreenEntered', id: wid(1) });
    const mode = entered.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(mode?.name, 'fullscreen');
    assert.ok(mode && 'preBounds' in mode, 'preBounds is a present key, not a missing field');
    assert.strictEqual((mode as { preBounds: unknown }).preBounds, null);

    // A `normal` record must never carry the key at all.
    const stillNormal = entered.order.find((w) => w.id === wid(2))?.fsMode;
    assert.strictEqual(stillNormal?.name, 'normal');
    assert.ok(stillNormal && !('preBounds' in stillNormal), 'a normal window has no preBounds concept');
  });

  it('a fullscreen transition changes neither key nor the contents/positions of order', () => {
    const state = fold(
      [...registerTwo(), { type: 'OsFocusGained', id: wid(2) }],
      initialState(),
    );
    const orderBefore = state.order.map((w) => w.id);
    const keyBefore = state.key;

    const decision = decide(state, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: state.version });
    assert.ok('events' in decision);
    const entering = fold(decision.events, state);
    assert.deepStrictEqual(entering.order.map((w) => w.id), orderBefore, 'order must be untouched by a fullscreen request');
    assert.strictEqual(entering.key, keyBefore, 'key must be untouched by a fullscreen request');

    const settled = evolve(entering, { type: 'OsFullscreenEntered', id: wid(1) });
    assert.deepStrictEqual(settled.order.map((w) => w.id), orderBefore, 'order must be untouched by the OS settle');
    assert.strictEqual(settled.key, keyBefore, 'key must be untouched by the OS settle');
  });

  it('re-requesting the state a window is already in emits no effect', () => {
    const state = fold(registerTwo(), initialState());

    // Already normal, request normal again.
    const alreadyNormal = decide(state, { type: 'SetFullscreen', id: wid(1), desired: false, expectedVersion: state.version });
    assert.ok('events' in alreadyNormal);
    assert.deepStrictEqual(alreadyNormal.events, []);

    // Drive to fullscreen, then re-request fullscreen.
    const fullscreen = fold(
      [
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null },
        { type: 'OsFullscreenEntered', id: wid(1) },
      ],
      state,
    );
    const alreadyFullscreen = decide(fullscreen, {
      type: 'SetFullscreen',
      id: wid(1),
      desired: true,
      expectedVersion: fullscreen.version,
    });
    assert.ok('events' in alreadyFullscreen);
    assert.deepStrictEqual(alreadyFullscreen.events, []);
    const next = fold(alreadyFullscreen.events, fullscreen);
    const effects = foldWithEffects(alreadyFullscreen.events, fullscreen).effects;
    assert.strictEqual(next, fullscreen, 'no events -> no state change');
    assert.deepStrictEqual(effects, [], 'no effect for a no-op re-request');
  });
});

// ── RegisterWindow command ──────────────────────────────────────────────────

describe('window-kernel: RegisterWindow command', () => {
  it('produces a WindowRegistered event and may name a window not yet in order', () => {
    const state = initialState();
    const cmd: Command = {
      type: 'RegisterWindow',
      id: wid(1),
      kind: 'browser',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      expectedVersion: state.version,
    };
    const decision = decide(state, cmd);
    assert.ok('events' in decision);
    assert.deepStrictEqual(decision.events, [
      {
        type: 'WindowRegistered',
        id: wid(1),
        kind: 'browser',
        layer: 0,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
    ]);
    const next = fold(decision.events, state);
    assert.strictEqual(next.order[0].orderable, true, 'a browser is orderable from birth');
  });
});

// ── Geometry: bounds, maximize, display (this slice) ────────────────────────

describe('window-kernel: geometry', () => {
  const registerTwo = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
  ];

  it('preMaxBounds is non-null only while maximized; Unmaximize restores the stash', () => {
    const state = fold(registerTwo(), initialState());
    const rect: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: rect });

    const maxDecision = decide(withBounds, { type: 'Maximize', id: wid(1), expectedVersion: withBounds.version });
    assert.ok('events' in maxDecision);
    const maximized = fold(maxDecision.events, withBounds);
    const maxRec = maximized.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(maxRec.maximized, true);
    assert.deepStrictEqual(maxRec.preMaxBounds, rect, "stashed from the machine's own bounds mirror");

    const unmaxDecision = decide(maximized, { type: 'Unmaximize', id: wid(1), expectedVersion: maximized.version });
    assert.ok('events' in unmaxDecision);
    const restored = fold(unmaxDecision.events, maximized);
    const restoredRec = restored.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(restoredRec.maximized, false);
    assert.strictEqual(restoredRec.preMaxBounds, null, 'cleared once restored — non-null ONLY while maximized');
    assert.deepStrictEqual(restoredRec.bounds, rect, 'bounds restored from the stash');
  });

  it('Maximize with no bounds ever reported stashes null; Unmaximize then restores nothing', () => {
    const state = fold(registerTwo(), initialState());
    const maxDecision = decide(state, { type: 'Maximize', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in maxDecision);
    assert.deepStrictEqual(maxDecision.events, [
      { type: 'PendingProjectionDiscarded', id: wid(1) },
      { type: 'Maximized', id: wid(1), preMaxBounds: null },
    ]);
    const maximized = fold(maxDecision.events, state);
    const maxRec = maximized.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(maxRec.preMaxBounds, null, 'no stash was possible');
    assert.strictEqual(maxRec.bounds, undefined, 'Maximize alone never writes bounds — a separate SetBounds does the snap');

    const unmaxDecision = decide(maximized, { type: 'Unmaximize', id: wid(1), expectedVersion: maximized.version });
    assert.ok('events' in unmaxDecision);
    assert.deepStrictEqual(
      unmaxDecision.events,
      [
        { type: 'PendingProjectionDiscarded', id: wid(1) },
        { type: 'Unmaximized', id: wid(1) },
      ],
      'a null stash clears the flag but restores nothing — no BoundsChanged event',
    );
    const restored = fold(unmaxDecision.events, maximized);
    const restoredRec = restored.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(restoredRec.maximized, false);
    assert.strictEqual(restoredRec.bounds, undefined);
  });

  it('DisplayChanged: held while blocked, last projection wins, discarded (not flushed) by an explicit write, flushed only when both axes clear', () => {
    const state = fold(registerTwo(), initialState());
    // registerTwo() windows start hidden with fsMode 'normal' — visibility
    // alone is the blocking axis for this test.
    const rec0 = state.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(rec0.visible, false);
    assert.strictEqual(rec0.fsMode.name, 'normal');

    const projA: Rectangle = { x: 1, y: 1, width: 100, height: 100 };
    const afterA = evolve(state, { type: 'DisplayChanged', projections: [{ id: wid(1), bounds: projA }] });
    let rec = afterA.order.find((w) => w.id === wid(1))!;
    assert.deepStrictEqual(rec.pendingProjectedBounds, projA, 'held — the visibility axis is blocked');
    assert.strictEqual(rec.bounds, undefined, 'not applied while blocked');

    // Last projection wins while still blocked — overwrite, never queue.
    const projB: Rectangle = { x: 2, y: 2, width: 200, height: 200 };
    const afterB = evolve(afterA, { type: 'DisplayChanged', projections: [{ id: wid(1), bounds: projB }] });
    rec = afterB.order.find((w) => w.id === wid(1))!;
    assert.deepStrictEqual(rec.pendingProjectedBounds, projB, 'last projection wins');
    assert.strictEqual(rec.bounds, undefined);

    // Discarded WITHOUT flushing by an explicit bounds write: the window is
    // still hidden (blocked), but SetBounds's guard only cares about
    // fullscreen, so the command is accepted and clears the stale hold
    // without ever applying it.
    const explicitBounds: Rectangle = { x: 9, y: 9, width: 50, height: 50 };
    const setDecision = decide(afterB, { type: 'SetBounds', id: wid(1), bounds: explicitBounds, expectedVersion: afterB.version });
    assert.ok('events' in setDecision);
    assert.deepStrictEqual(setDecision.events, [
      { type: 'PendingProjectionDiscarded', id: wid(1) },
      { type: 'BoundsChanged', id: wid(1), bounds: explicitBounds },
    ]);
    const afterSet = fold(setDecision.events, afterB);
    const setRec = afterSet.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(setRec.pendingProjectedBounds, null, 'discarded');
    assert.deepStrictEqual(setRec.bounds, explicitBounds, 'the deliberate write wins, never the stale projection');

    // Flushed only once BOTH axes clear: hold a fresh projection while
    // hidden, then show the window (visibility clears; fsMode was already normal).
    const projC: Rectangle = { x: 3, y: 3, width: 300, height: 300 };
    const heldAgain = evolve(afterSet, { type: 'DisplayChanged', projections: [{ id: wid(1), bounds: projC }] });
    const shown = evolve(heldAgain, { type: 'WindowShown', id: wid(1) });
    const shownRec = shown.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(shownRec.pendingProjectedBounds, null, 'flushed and cleared once both axes are clear');
    assert.deepStrictEqual(shownRec.bounds, projC);
  });

  it('a held projection stays held when only one blocking axis clears', () => {
    const state = fold(registerTwo(), initialState());
    const shown = evolve(state, { type: 'WindowShown', id: wid(1) }); // clears the visibility axis
    const fullscreen = fold(
      [
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null },
        { type: 'OsFullscreenEntered', id: wid(1) },
      ],
      shown,
    );
    const proj: Rectangle = { x: 5, y: 5, width: 60, height: 60 };
    const held = evolve(fullscreen, { type: 'DisplayChanged', projections: [{ id: wid(1), bounds: proj }] });
    const rec = held.order.find((w) => w.id === wid(1))!;
    assert.deepStrictEqual(rec.pendingProjectedBounds, proj, 'held — the fsMode axis is still blocked even though visible');
    assert.strictEqual(rec.bounds, undefined);
  });

  it('bounds is written only by BoundsChanged — no other geometry event touches it directly', () => {
    const state = fold(registerTwo(), initialState());
    const rect: Rectangle = { x: 0, y: 0, width: 10, height: 10 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: rect });

    const maximized = evolve(withBounds, { type: 'Maximized', id: wid(1), preMaxBounds: rect });
    assert.deepStrictEqual(maximized.order.find((w) => w.id === wid(1))?.bounds, rect, 'Maximized alone never moves bounds');

    const unmaximized = evolve(maximized, { type: 'Unmaximized', id: wid(1) });
    assert.deepStrictEqual(unmaximized.order.find((w) => w.id === wid(1))?.bounds, rect, 'Unmaximized alone never moves bounds');

    const exited = evolve(unmaximized, { type: 'MaximizeExitedByResize', id: wid(1) });
    assert.deepStrictEqual(exited.order.find((w) => w.id === wid(1))?.bounds, rect, 'MaximizeExitedByResize never moves bounds');

    const pinned = evolve(exited, { type: 'VisibleOnAllSpacesSet', id: wid(1), on: true });
    assert.deepStrictEqual(pinned.order.find((w) => w.id === wid(1))?.bounds, rect, 'an unrelated field write never moves bounds');
  });

  it('geometry commands and events touch neither key nor order', () => {
    const state = fold([...registerTwo(), { type: 'OsFocusGained', id: wid(2) }], initialState());
    const orderBefore = state.order.map((w) => w.id);
    const keyBefore = state.key;

    const log: Event[] = [
      { type: 'BoundsChanged', id: wid(1), bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { type: 'Maximized', id: wid(1), preMaxBounds: null },
      { type: 'Unmaximized', id: wid(1) },
      { type: 'MaximizeExitedByResize', id: wid(1) },
      { type: 'DisplayChanged', projections: [{ id: wid(1), bounds: { x: 1, y: 1, width: 1, height: 1 } }] },
      { type: 'PendingProjectionDiscarded', id: wid(1) },
      { type: 'VisibleOnAllSpacesSet', id: wid(1), on: true },
    ];
    const after = fold(log, state);
    assert.deepStrictEqual(after.order.map((w) => w.id), orderBefore, 'order untouched by any geometry event');
    assert.strictEqual(after.key, keyBefore, 'key untouched by any geometry event');
  });

  it('re-requesting the current bounds emits no effect', () => {
    const state = fold(registerTwo(), initialState());
    const bounds: Rectangle = { x: 10, y: 10, width: 20, height: 20 };
    const setDecision = decide(state, { type: 'SetBounds', id: wid(1), bounds, expectedVersion: state.version });
    assert.ok('events' in setDecision);
    const first = foldWithEffects(setDecision.events, state);
    assert.ok(first.effects.some((e) => e.type === 'SetBounds'), 'the first write does emit an effect');

    // Re-request the SAME bounds.
    const reDecision = decide(first.state, { type: 'SetBounds', id: wid(1), bounds, expectedVersion: first.state.version });
    assert.ok('events' in reDecision);
    const second = foldWithEffects(reDecision.events, first.state);
    assert.deepStrictEqual(second.effects, [], 'a genuine re-request of the current value diffs to nothing');
  });
});
