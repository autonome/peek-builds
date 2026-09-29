// Example-based unit tests for the window-manager kernel (window-kernel.ts).
// Design reasoning: docs/design/window-manager.md, section 0.1.
// react(prev, ev, next): Effect[] is a pure projection of the transition, separate from evolve.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  react,
  decide,
  topmost,
  keyWindow,
  overlayForHost,
  hostForOverlay,
  isContentWindow,
  isFrontEligibleWindow,
  topmostBaseLayerPageHost,
  isStaleSelfEcho,
  selectTransientAutoclose,
  isAppResignSweepEligible,
  holdsAppOnScreen,
  isNonParentRole,
  isTransientPageHost,
  onCurrentDesktop,
  reusableHere,
  isCurrentDesktop,
  desktopUnread,
  isOnEveryDesktop,
  windowById,
  TRANSIENT_ROLES,
  BASE_LAYER,
  type State,
  type Event,
  type Effect,
  type WindowId,
  type WindowRecord,
  type Command,
  type Rectangle,
  type FocusCause,
} from './window-kernel.js';
// window-escape.ts is a pure read of this kernel's snapshot, so the Escape-grab cases below are
// pinned against the real predicate rather than restated as prose.
import { shouldArmEscapeGrab, switcherWindow } from './window-escape.js';
// isWebPageRole supplies the http/https fact this kernel does not store, same reason as above.
import { isWebPageRole } from './izui-roles.js';

const wid = (n: number): WindowId => `wk-${n}` as WindowId;

// Used to prove react never writes to its arguments.
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

function buildLog(): Event[] {
  return [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(3), kind: 'page-host', layer: 1, canBecomeKey: false, acceptsInput: false, class: 'hud', parentId: wid(1) },
    { type: 'WindowShown', id: wid(1) },
    { type: 'OsFocusGained', id: wid(1) },
    { type: 'WindowShown', id: wid(2) },
    { type: 'OsFocusGained', id: wid(2) },
    { type: 'AppActivated' },
    { type: 'OsFocusLost', id: wid(2) },
    { type: 'WindowHidden', id: wid(3) },
    { type: 'WindowClosed', id: wid(2) },
    { type: 'AppResigned' },
  ];
}

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
    { type: 'AppResigned' },
    { type: 'AppActivated' },
    { type: 'AppResignSettled' },
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
    assert.strictEqual(merged.class, 'hud');
    assert.strictEqual(merged.parentId, wid(2));
    // Lived facts are preserved, not reset by the re-registration.
    assert.strictEqual(merged.visible, true);
    assert.strictEqual(merged.openSeq, openSeqBefore);
    // `acceptsInput` is a lived fact, not an intrinsic — a re-registration must not let the event's
    // `acceptsInput: false` overwrite a click-through change `WindowAcceptsInputChanged` already reported.
    assert.strictEqual(merged.acceptsInput, true);
  });

  it('re-registration overwrites a named role and keeps the existing one when the event names none', () => {
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
          role: 'quick-view',
        },
      ],
      initialState(),
    );
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.role, 'quick-view');

    const reRoled = evolve(state, {
      type: 'WindowRegistered',
      id: wid(1),
      kind: 'page-host',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      role: 'palette',
    });
    assert.strictEqual(reRoled.order.find((w) => w.id === wid(1))?.role, 'palette', 'a named role overwrites');

    const roleless = evolve(reRoled, {
      type: 'WindowRegistered',
      id: wid(1),
      kind: 'page-host',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });
    assert.strictEqual(
      roleless.order.find((w) => w.id === wid(1))?.role,
      'palette',
      'a re-registration naming no role must not strip the one already declared',
    );
  });

  // keepLive is decided once, at registration, and never revisited by any runtime writer, so the
  // re-registration merge must not silently drop it.
  it('a re-registration that omits keepLive KEEPS a previously-set keepLive: true', () => {
    // ipc.ts registers every real window twice, and a second pass that never learned about
    // keepLive must not silently strip it — a keepLive slide would be destroyed on close instead
    // of hidden.
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', keepLive: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.keepLive,
      true,
      'a re-registration naming no keepLive must not strip the one already declared',
    );
  });

  it('a re-registration that names keepLive: false overwrites it — an explicit value always wins', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', keepLive: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', keepLive: false },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.keepLive, false, 'a named keepLive overwrites');
  });

  it('a re-registration that omits parentId KEEPS a previously-set parentId', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', parentId: wid(2) },
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.parentId,
      wid(2),
      'a re-registration naming no parentId must not strip the one already declared',
    );
  });

  it('a re-registration that names a different parentId overwrites it', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', parentId: wid(2) },
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', parentId: wid(3) },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.parentId, wid(3), 'a named parentId overwrites');
  });

  // The two cases below cover the re-registration MERGE's handling of
  // `tracksBaseLayerTop` — same shape as the `keepLive` pair above, because
  // it is a DECLARED fact for the same reason (see
  // `WindowRecord.tracksBaseLayerTop`'s doc): written at registration, never
  // revisited, and overwritten rather than preserved by a re-registration
  // that names a value.
  it('a re-registration that omits tracksBaseLayerTop KEEPS a previously-set tracksBaseLayerTop: true', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'overlay', tracksBaseLayerTop: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'overlay' },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.tracksBaseLayerTop,
      true,
      'a re-registration naming no tracksBaseLayerTop must not strip the one already declared',
    );
  });

  it('a re-registration that names tracksBaseLayerTop: false overwrites it — an explicit value always wins', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'overlay', tracksBaseLayerTop: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'overlay', tracksBaseLayerTop: false },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.tracksBaseLayerTop,
      false,
      'a named tracksBaseLayerTop overwrites',
    );
  });

  // The two cases below cover the re-registration MERGE's handling of
  // `selfClosesOnBlur` — same shape as the `tracksBaseLayerTop` pair above,
  // because it is a DECLARED fact for the same reason (see
  // `WindowRecord.selfClosesOnBlur`'s doc): written at registration, never
  // revisited, and overwritten rather than preserved by a re-registration
  // that names a value.
  it('a re-registration that omits selfClosesOnBlur KEEPS a previously-set selfClosesOnBlur: true', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', selfClosesOnBlur: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette' },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.selfClosesOnBlur,
      true,
      'a re-registration naming no selfClosesOnBlur must not strip the one already declared',
    );
  });

  it('a re-registration that names selfClosesOnBlur: false overwrites it — an explicit value always wins', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', selfClosesOnBlur: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', selfClosesOnBlur: false },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.selfClosesOnBlur,
      false,
      'a named selfClosesOnBlur overwrites',
    );
  });

  // The two cases below cover the re-registration MERGE's handling of
  // `nonActivating` — same shape as the `selfClosesOnBlur` pair above,
  // because it is a DECLARED fact for the same reason (see
  // `WindowRecord.nonActivating`'s doc): written at registration, never
  // revisited, and overwritten rather than preserved by a re-registration
  // that names a value.
  it('a re-registration that omits nonActivating KEEPS a previously-set nonActivating: true', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', nonActivating: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette' },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.nonActivating,
      true,
      'a re-registration naming no nonActivating must not strip the one already declared',
    );
  });

  it('a re-registration that names nonActivating: false overwrites it — an explicit value always wins', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', nonActivating: true },
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: 1, canBecomeKey: true, acceptsInput: true, class: 'palette', nonActivating: false },
    ]);
    assert.strictEqual(
      state.order.find((w) => w.id === wid(1))?.nonActivating,
      false,
      'a named nonActivating overwrites',
    );
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

  it('a RaiseWindow command leaves key and order untouched — it is a request, not yet a report (F1)', () => {
    // RULE 2: `key` is written ONLY by `OsFocusGained`. A `RaiseWindow`
    // command asks for a raise; it does not manufacture the OS's own report
    // of one. `decide` translates it onto `FocusRaiseRequested` instead (see
    // `State.lastRaiseRequest`), which `evolve` folds without moving `key` or
    // `order` — the backend has not focused anything yet.
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
      ],
      initialState(),
    );
    assert.strictEqual(keyWindow(state), null, 'precondition: nobody holds key yet');
    const decision = decide(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const { state: requested, effects } = foldWithEffects(decision.events, state);

    assert.strictEqual(keyWindow(requested), null, 'the request alone does not write key');
    assert.strictEqual(topmost(requested, () => true)?.id, wid(2), 'and does not reorder either');
    assert.deepStrictEqual(effects, [{ type: 'RaiseWindow', id: wid(1), opSeq: requested.opSeqCounter }], 'exactly one RaiseWindow effect drives the OS');
  });

  it('the backend confirmation carrying the raise\'s opSeq is what actually writes key (F3: no second sweep, no second raise)', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const { state: requested } = foldWithEffects(decision.events, state);

    // The backend's own echo of the `RaiseWindow` effect, carrying the SAME
    // opSeq that effect was stamped with.
    const confirm: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: requested.opSeqCounter } };
    const next = evolve(requested, confirm);
    const effects = react(requested, confirm, next);

    assert.strictEqual(keyWindow(next)?.id, wid(1), 'NOW key moves — on the OS confirmation, not the request');
    assert.strictEqual(topmost(next, () => true)?.id, wid(1));
    assert.deepStrictEqual(effects, [], 'a confirmation drives nothing further — no second sweep, no second raise');
  });

  it('a RaiseWindow command on a record that fails admitsFocus emits nothing and leaves the window model untouched (F5)', () => {
    // `evolve`'s `FocusRaiseRequested` arm gates its stamp on `admitsFocus`
    // exactly as `FocusAssertRequested` and `AppActivated` do; `react`'s
    // raise-request rule mirrors the same gate. A hidden (never-shown) target
    // fails it, so the command is admitted by `decide` (it names a real
    // window) but drives nothing.
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' }],
      initialState(),
    );
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.visible, false, 'precondition: registered, never shown');

    const decision = decide(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const { state: next, effects } = foldWithEffects(decision.events, state);

    assert.deepStrictEqual(effects, [], 'no RaiseWindow effect for a target that cannot legitimately take it');
    assert.strictEqual(next.key, state.key, 'key untouched');
    assert.deepStrictEqual(next.order.map((w) => w.id), state.order.map((w) => w.id), 'order untouched');
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no fresh token minted — nothing to confirm later');
    assert.strictEqual(next.order[0].lastOpSeq, state.order[0].lastOpSeq, 'no op issued, so the record is not stamped at all');
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

// A registration inserts under the key window; a focus gain raises its target to the top — the
// two complete, disjoint rules that move anything in order.
describe('window-kernel: a background open lands BELOW the key window', () => {
  const inUse = wid(1);
  const opened = wid(2);

  const registerPageHost = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const windowInUse = (): Event[] => [
    registerPageHost(inUse),
    { type: 'WindowShown', id: inUse },
    { type: 'WindowContentOrderable', id: inUse },
    { type: 'OsFocusGained', id: inUse },
  ];

  const stackingIds = (effects: Effect[]): WindowId[] =>
    effects.filter((e) => e.type === 'SetStacking').map((e) => e.id);

  it('a background open sits under the window in use — and the stacking the OS is told to assert says so', () => {
    const base = fold(windowInUse());
    assert.strictEqual(keyWindow(base)?.id, inUse);

    const shown = fold([registerPageHost(opened), { type: 'WindowShown', id: opened }], base);
    assert.deepStrictEqual(shown.order.map((w) => w.id), [opened, inUse], 'bottom -> top');
    assert.strictEqual(topmost(shown, () => true)?.id, inUse, 'the window in use is still on top');
    assert.strictEqual(topmost(shown, isContentWindow)?.id, inUse, 'and is still the command target');

    // The first composited frame re-asserts the whole stack, bottom -> top.
    const firstFrame: Event = { type: 'WindowContentOrderable', id: opened };
    const after = evolve(shown, firstFrame);
    assert.deepStrictEqual(stackingIds(react(shown, firstFrame, after)), [opened, inUse]);
  });

  it('an ACTIVATING open still ends on top — the focus gain is what puts it there', () => {
    const state = fold(
      [
        registerPageHost(opened),
        { type: 'WindowShown', id: opened },
        { type: 'WindowContentOrderable', id: opened },
        { type: 'OsFocusGained', id: opened },
      ],
      fold(windowInUse()),
    );
    assert.deepStrictEqual(state.order.map((w) => w.id), [inUse, opened]);
    assert.strictEqual(keyWindow(state)?.id, opened);
    assert.strictEqual(topmost(state, isContentWindow)?.id, opened);
  });

  it('successive background opens stack under it, newest nearest the top', () => {
    const state = fold([registerPageHost(wid(3)), registerPageHost(wid(4))], fold(windowInUse()));
    assert.deepStrictEqual(state.order.map((w) => w.id), [wid(3), wid(4), inUse]);
  });

  it('with no key window there is nothing to go below — the registration appends on top', () => {
    const state = fold([registerPageHost(inUse), registerPageHost(opened)]);
    assert.strictEqual(state.key, null);
    assert.deepStrictEqual(state.order.map((w) => w.id), [inUse, opened]);
  });

  it('a key id naming no record is nothing to go below either', () => {
    // RULE 2: `key` is never repaired, so closing the key window leaves the
    // field dangling. A registration then has no window in use to sit under.
    const closed = fold([...windowInUse(), registerPageHost(opened), { type: 'WindowClosed', id: inUse }]);
    assert.strictEqual(closed.key, inUse, 'still dangling');
    assert.strictEqual(keyWindow(closed), null);

    const state = evolve(closed, registerPageHost(wid(3)));
    assert.deepStrictEqual(state.order.map((w) => w.id), [opened, wid(3)]);
  });

  it('registering the window a dangling key already names puts it on top, so key stays topmost', () => {
    const state = fold([
      registerPageHost(inUse),
      { type: 'OsFocusGained', id: opened }, // an id no record exists for yet
      registerPageHost(opened),
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [inUse, opened]);
    assert.strictEqual(keyWindow(state)?.id, opened);
  });

  it('a re-registration is not a re-placement — the merge keeps it under the key window', () => {
    const base = fold([...windowInUse(), registerPageHost(opened)]);
    const merged = evolve(base, registerPageHost(opened));
    assert.deepStrictEqual(merged.order.map((w) => w.id), [opened, inUse]);
  });

  it('a show never re-places: a background window shown after the key window changed stays where it was', () => {
    // `opened` is registered under `inUse`, then `inUse` is re-focused, and
    // only then does `opened` become visible. Position is a registration /
    // focus fact, so the late show moves nothing.
    const base = fold([...windowInUse(), registerPageHost(opened), { type: 'OsFocusGained', id: inUse }]);
    const shown = evolve(base, { type: 'WindowShown', id: opened });
    assert.deepStrictEqual(shown.order.map((w) => w.id), [opened, inUse]);
  });

  it('the window in use never leaves the top, so re-focusing it raises nothing; focusing the background open does', () => {
    const base = fold([
      ...windowInUse(),
      registerPageHost(opened),
      { type: 'WindowShown', id: opened },
      { type: 'WindowContentOrderable', id: opened },
    ]);

    const reFocus: Event = { type: 'OsFocusGained', id: inUse };
    const afterReFocus = evolve(base, reFocus);
    assert.deepStrictEqual(
      react(base, reFocus, afterReFocus).filter((e) => e.type === 'RaiseWindow'),
      [],
      'the key window was already topmost — nothing moved, so nothing is driven back at the OS',
    );

    const focusOpened: Event = { type: 'OsFocusGained', id: opened };
    const afterFocus = evolve(base, focusOpened);
    assert.deepStrictEqual(
      react(base, focusOpened, afterFocus).filter((e) => e.type === 'RaiseWindow'),
      [{ type: 'RaiseWindow', id: opened, opSeq: afterFocus.opSeqCounter }],
      'a background open genuinely moves when it takes focus — the one raise this placement creates',
    );
  });
});

// ── the raise a focus report drives (and why it is not a feedback loop) ─────

// react emits RaiseWindow whenever the top of order changed under unchanged membership — never
// for a close or a registration, since those change membership rather than move a focus target.
describe('window-kernel: the raise a focus report drives', () => {
  const registerPageHost = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const raises = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'RaiseWindow');

  const twoWindows = (top: WindowId, below: WindowId): State =>
    fold([
      registerPageHost(top),
      { type: 'WindowShown', id: top },
      { type: 'WindowContentOrderable', id: top },
      { type: 'OsFocusGained', id: top },
      registerPageHost(below),
      { type: 'WindowShown', id: below },
      { type: 'WindowContentOrderable', id: below },
    ]);

  it('a RaiseWindow COMMAND reaches the OS as a raise — the machine has no other route to key', () => {
    // The load-bearing case. `decide` realizes the command as `OsFocusGained`,
    // so if a focus report emitted no raise this command would produce only
    // relative stacking — the window would move in the model and never become
    // the one in use.
    const state = twoWindows(wid(1), wid(2));
    const decision = decide(state, { type: 'RaiseWindow', id: wid(2), expectedVersion: state.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(state, ev);
    assert.deepStrictEqual(
      raises(react(state, ev, next)),
      [{ type: 'RaiseWindow', id: wid(2), opSeq: next.opSeqCounter }],
      'the only effect in the union that takes key',
    );
  });

  it('a RaiseWindow COMMAND the user asked for carries its intent through lastRaiseRequest onto the effect', () => {
    // The hotkey path (window-rules.md F6): `kernelShowRequested` sends the
    // command with `intent: 'user'`; the executor's app-inactive mask reads
    // it off the effect, so it has to survive decide -> evolve -> react. It no
    // longer rides a `FocusCause` (there is no `OsFocusGained` here at all) —
    // it rides `State.lastRaiseRequest` instead.
    const state = twoWindows(wid(1), wid(2));
    const decision = decide(state, { type: 'RaiseWindow', id: wid(2), expectedVersion: state.version, intent: 'user' });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    assert.deepStrictEqual(
      ev,
      { type: 'FocusRaiseRequested', id: wid(2), intent: 'user' },
      'the event carries the intent directly — there is no cause to ride',
    );
    const next = evolve(state, ev);
    assert.strictEqual(next.lastRaiseRequest?.intent, 'user', 'and the fact react diffs records it');
    assert.deepStrictEqual(
      raises(react(state, ev, next)),
      [{ type: 'RaiseWindow', id: wid(2), opSeq: next.opSeqCounter, intent: 'user' }],
      'the effect says the raise was asked for',
    );
  });

  it('a RaiseWindow COMMAND without intent yields an effect without one — absent means derived', () => {
    const state = twoWindows(wid(1), wid(2));
    const decision = decide(state, { type: 'RaiseWindow', id: wid(2), expectedVersion: state.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(state, ev);
    const [raise] = raises(react(state, ev, next));
    assert.ok(raise !== undefined && !('intent' in raise), 'no intent key at all, not intent: undefined');
  });

  it('INVARIANT: the raise is its own fixed point — the focus report it provokes emits NOTHING', () => {
    // The convergence obligation, met structurally instead of by refusing to
    // emit: a raise is realized as an activating show, whose native focus
    // comes back as another OsFocusGained for the same window. By then that
    // window is topmost, so the diff is empty — no second raise, and no
    // stacking re-assert either.
    const state = twoWindows(wid(1), wid(2));
    const first: Event = { type: 'OsFocusGained', id: wid(2) };
    const raised = evolve(state, first);
    assert.strictEqual(raises(react(state, first, raised)).length, 1, 'one correcting write');

    const echo: Event = { type: 'OsFocusGained', id: wid(2), cause: { kind: 'machine', opSeq: raised.opSeqCounter } };
    const afterEcho = evolve(raised, echo);
    assert.deepStrictEqual(react(raised, echo, afterEcho), [], 'then silence');
    assert.deepStrictEqual(afterEcho.order.map((w) => w.id), raised.order.map((w) => w.id));
  });

  it('closing the top window does not raise the one beneath — a membership change is not a raise', () => {
    // The successor is promoted to the top of `order` by removal alone.
    // Asserting key for it would be the successor-guessing RULE 2 forbids —
    // and a raise SHOWS what it raises, so a hidden window beneath would be
    // put on screen by a close.
    const state = twoWindows(wid(1), wid(2));
    const ev: Event = { type: 'WindowClosed', id: wid(1) };
    const next = evolve(state, ev);
    assert.deepStrictEqual(next.order.map((w) => w.id), [wid(2)], 'promoted by removal');
    assert.deepStrictEqual(raises(react(state, ev, next)), []);
  });

  it('a registration that lands on top does not raise either', () => {
    // No key window to go under, so the fresh record appends at the top of
    // `order` — the top id changed, but nothing took focus.
    const state = fold([registerPageHost(wid(1))]);
    assert.strictEqual(state.key, null);
    const ev = registerPageHost(wid(2));
    const next = evolve(state, ev);
    assert.deepStrictEqual(next.order.map((w) => w.id), [wid(1), wid(2)]);
    assert.deepStrictEqual(raises(react(state, ev, next)), []);
  });

  it('a pure REORDER raises nothing — moving a window in the stack is not making it the one in use', () => {
    // The half of the rule that a top-of-`order` diff cannot express. `key` is
    // what a raise asserts, so a transition that permutes `order` and leaves
    // `key` alone has asserted nothing about focus and must reach the OS as
    // relative stacking only. An activating raise here would take key away
    // from the window that holds it, and (because a raise SHOWS what it
    // raises) could put a hidden window on screen.
    //
    // `next` is hand-built because no event permutes `order` yet: the one that
    // will (a stack-order import during session restore) is the reason this is
    // pinned ahead of it. That is not a hole in the test — this rule is a
    // structural diff of `prev`/`next` and reads no event at all, so the
    // transition is exactly the one `react` would be handed.
    const state = twoWindows(wid(1), wid(2));
    assert.deepStrictEqual(state.order.map((w) => w.id), [wid(2), wid(1)], 'the background open sits under the key window');
    assert.strictEqual(state.key, wid(1));

    const permuted: State = { ...state, order: [state.order[1], state.order[0]], version: state.version + 1 };
    const effects = react(state, { type: 'AppActivated' }, permuted);

    // Non-vacuous: `react` really did see the reorder — it re-asserted the full
    // stacking — and still declined to raise.
    assert.ok(effects.some((e) => e.type === 'SetStacking'), 'the reorder reaches the OS as stacking');
    assert.deepStrictEqual(raises(effects), [], 'and as nothing else');
    assert.strictEqual(permuted.key, state.key, 'because `key` never moved');
  });

  it('a focus report on the window already on top DOES raise when it takes key from somebody else', () => {
    // The other half, and the reason the rule is `key` rather than the top of
    // `order`: the OS can hand focus to a window that is already topmost —
    // after an `OsFocusLost`, or with a palette holding key over it — and the
    // model has to re-assert its own answer. Nothing about `order` moves here,
    // so a top-of-stack diff would emit nothing at all.
    const state = evolve(twoWindows(wid(1), wid(2)), { type: 'OsFocusLost', id: wid(1) });
    assert.strictEqual(state.key, null, 'nobody holds key');
    assert.strictEqual(state.order[state.order.length - 1].id, wid(1), 'while wid(1) is still on top');

    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(state, ev);
    assert.deepStrictEqual(next.order.map((w) => w.id), state.order.map((w) => w.id), 'the stack does not move');
    assert.deepStrictEqual(raises(react(state, ev, next)), [{ type: 'RaiseWindow', id: wid(1), opSeq: next.opSeqCounter }]);
  });

  it('a focus report on a HIDDEN window raises nothing — stale evidence, not a raise to drive', () => {
    // A hide is asynchronous at the OS, so the focus echo of the raise that
    // preceded a keepLive hide can land after the record already reads
    // `visible:false` and somebody else holds key. Recording the report as
    // `key` is RULE 2 and still happens; driving the OS with it is not. A
    // `RaiseWindow` is an ACTIVATING show — realized against a hidden window
    // it puts the window back on screen (`planRaiseRealization` ->
    // 'show-and-take-key'), the world focus that follows sweeps it, the sweep's
    // hide echoes, and around: the 2026-09-04 command-palette loop, ~7ms per
    // cycle. Same gate as `FocusAssertRequested` and the focus-assert rule:
    // `admitsFocus`, the one place the condition lives.
    const hidden = fold([{ type: 'WindowHidden', id: wid(1) }, { type: 'OsFocusGained', id: wid(2) }], twoWindows(wid(1), wid(2)));
    assert.strictEqual(hidden.order.find((w) => w.id === wid(1))?.visible, false, 'precondition: hidden');
    assert.strictEqual(hidden.key, wid(2), 'precondition: somebody else holds key');

    const echo: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(hidden, echo);
    assert.strictEqual(next.key, wid(1), 'RULE 2: the report is still recorded as fact');
    assert.deepStrictEqual(raises(react(hidden, echo, next)), [], 'but nothing drives the OS to re-show it');
    assert.strictEqual(next.opSeqCounter, hidden.opSeqCounter, 'no effect, no token');
  });

  it('a keepLive reuse — ShowWindow then RaiseWindow on a hidden window — still raises', () => {
    // The path the gate above must not break: re-showing a hidden palette is
    // TWO commands, and `ShowWindow`'s `WindowShown` flips the record visible
    // before the raise's focus report is evolved, so the raise is admitted.
    const hidden = fold([{ type: 'WindowHidden', id: wid(1) }, { type: 'OsFocusGained', id: wid(2) }], twoWindows(wid(1), wid(2)));
    const shown = fold([{ type: 'WindowShown', id: wid(1) }], hidden);
    const decision = decide(shown, { type: 'RaiseWindow', id: wid(1), expectedVersion: shown.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(shown, ev);
    assert.deepStrictEqual(raises(react(shown, ev, next)), [{ type: 'RaiseWindow', id: wid(1), opSeq: next.opSeqCounter }]);
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

  it('a duplicate WindowHidden (backend echo + late native hide event) is a no-op re-merge', () => {
    // The backend echoes WindowHidden synchronously for every hide it performs, and the OS's own
    // native hide event for the same window lags a tick behind, so the kernel sees the same hide
    // twice: echo first, native mirror later. The second arrival must leave everything as it was.
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowShown', id: wid(1) },
      { type: 'OsFocusGained', id: wid(1) },
      { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowShown', id: wid(2) },
      { type: 'OsFocusGained', id: wid(2) },
    ]);
    const hideEvent: Event = { type: 'WindowHidden', id: wid(2) };
    const first = evolve(state, hideEvent);
    const firstKey = keyWindow(first);
    const dup = evolve(first, hideEvent);
    assert.deepStrictEqual(react(first, hideEvent, dup), [], 'no effects from the duplicate');
    assert.strictEqual(dup.order.find((w) => w.id === wid(2))?.visible, false);
    assert.deepStrictEqual(dup.order, first.order, 'order is byte-identical to after the first hide');
    assert.deepStrictEqual(keyWindow(dup), firstKey, 'the duplicate does not repair key');
  });

  it('a duplicate WindowHidden clears a pendingHidden mark idempotently — order stays byte-identical on the repeat', () => {
    // Same shape as the case above, but the window carries a `pendingHidden`
    // mark (a teardown was decided before the confirming hide arrived) — the
    // fact this test exists to protect: the SECOND `WindowHidden` must not
    // re-diff the mark's clear into a different-looking record than the first
    // one already produced.
    const state = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowShown', id: wid(1) },
      { type: 'WindowDestroyRequested', id: wid(1) },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.pendingHidden, true, 'precondition: the teardown marked it doomed');

    const hideEvent: Event = { type: 'WindowHidden', id: wid(1) };
    const first = evolve(state, hideEvent);
    assert.strictEqual(first.order.find((w) => w.id === wid(1))?.pendingHidden, false, 'the confirming echo clears the mark');

    const dup = evolve(first, hideEvent);
    assert.deepStrictEqual(react(first, hideEvent, dup), [], 'no effects from the duplicate');
    assert.deepStrictEqual(dup.order, first.order, 'order is byte-identical to after the first hide');
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

  it('a non-keepLive window reaches the OS: react emits CloseWindow naming it', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'CloseOrHideWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'CloseWindow'),
      [{ type: 'CloseWindow', id: wid(1), maximized: false, preMaxBounds: null }],
    );
  });

  it('closing a maximized window carries its presentation facts on the CloseWindow effect', () => {
    // The record retires from `state.order` in the SAME transition that
    // reacts this effect (RULE 1, `evolve`'s `WindowClosed` arm) — a
    // consumer asking `state.order` for the closed id after this point finds
    // nothing, so the closing record's maximized/preMaxBounds facts have to
    // ride on the effect itself rather than be looked up later.
    const preMaxBounds: Rectangle = { x: 10, y: 10, width: 800, height: 600 };
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
        { type: 'Maximized', id: wid(1), preMaxBounds },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'CloseOrHideWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'CloseWindow'),
      [{ type: 'CloseWindow', id: wid(1), maximized: true, preMaxBounds }],
    );
  });

  it('a keepLive window produces HideWindow and NOT CloseWindow', () => {
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
    const ev = decision.events[0];
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    // Filtered to the close/hide family, the same shape the sibling test above
    // uses: this is about which of the two a keepLive window gets, and hiding
    // the app's last window also hands the user back to where they came from
    // (`react`'s app-hide rule), which is a different rule's business.
    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'HideWindow' || e.type === 'CloseWindow'),
      [{ type: 'HideWindow', id: wid(1), opSeq: next.opSeqCounter }],
    );
    assert.ok(!effects.some((e) => e.type === 'CloseWindow'));
  });

  it('a keepLive descendant is hidden by the cascade, not force-closed, same as a direct CloseOrHideWindow on it', () => {
    // The cascade (`descendantsToCascadeClose`) must not restate `keepLive`
    // as "always close" — a child carrying it survives its parent's close the
    // same way it would survive its own.
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: wid(1) },
        {
          type: 'WindowRegistered',
          id: wid(2),
          kind: 'page-host',
          layer: 0,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
          parentId: wid(1),
          keepLive: true,
        },
        { type: 'WindowShown', id: wid(2) },
      ],
      initialState(),
    );
    const decision = decide(state, { type: 'CloseOrHideWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    assert.deepStrictEqual(
      decision.events,
      [
        { type: 'WindowHidden', id: wid(2) },
        { type: 'WindowClosed', id: wid(1) },
      ],
      'the keepLive child is hidden, deepest first, before the non-keepLive parent closes',
    );
    const next = fold(decision.events, state);
    assert.strictEqual(next.order.some((w) => w.id === wid(2)), true, 'keepLive child must stay in order');
    assert.strictEqual(next.order.find((w) => w.id === wid(2))?.visible, false, 'keepLive child is hidden, not left visible');
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

// A window shown without reordering order (a non-activating show: session restore, the inactive
// show path, an extension window) must still re-trigger the full stacking re-assert, or a pinned
// window shown that way never gets its level reinforced.
describe('window-kernel: a window becoming visible re-asserts stacking, not just an order change', () => {
  it('a non-activating WindowShown alone re-asserts stacking for an always-on-top window', () => {
    // kind:'browser' starts orderable, so a plain show is the only event needed here.
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: false, acceptsInput: false, class: 'hud' }],
      initialState(),
    );
    assert.strictEqual(state.order[0].visible, false, 'precondition: registered, not yet shown');
    assert.strictEqual(state.order[0].orderable, true, 'precondition: a browser-kind window starts orderable');

    const ev: Event = { type: 'WindowShown', id: wid(1) };
    const shown = evolve(state, ev);
    const effects = react(state, ev, shown);

    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'SetStacking'),
      [{ type: 'SetStacking', id: wid(1), layer: BASE_LAYER + 1 }],
      'the show alone must reinforce the pin — no raise, no reorder, nothing else in this transition would',
    );
  });

  it('an AppActivated re-show (a visibility flip with no reorder) also re-asserts stacking for what it reveals', () => {
    // The other production path this closes: `evolve`'s `AppActivated` arm
    // patches `visible` in place on already-hidden records — same array
    // positions, so `orderChanged` alone (the pre-existing gate) reads false.
    const hud: Event = {
      type: 'WindowRegistered',
      id: wid(1),
      kind: 'browser',
      layer: BASE_LAYER + 1,
      canBecomeKey: false,
      acceptsInput: true,
      class: 'hud',
    };
    const swept = fold([hud, { type: 'WindowShown', id: wid(1) }, { type: 'AppResigned' }, { type: 'AppResignSettled' }], initialState());
    assert.strictEqual(swept.order[0].visible, false, 'precondition: the sweep hid it');

    const activateEv: Event = { type: 'AppActivated' };
    const activated = evolve(swept, activateEv);
    const effects = react(swept, activateEv, activated);

    assert.ok(
      effects.some((e) => e.type === 'SetStacking' && e.id === wid(1)),
      'the reveal must reinforce the pin, exactly as a fresh show does',
    );
  });

  it('a plain WindowShown on a BASE_LAYER (non-pinned) window still re-asserts stacking — the trigger is visibility, not layer', () => {
    // The gate is deliberately blind to WHY a window became visible or what
    // its layer is — `react` never reads `role`/`class`, and restricting the
    // trigger to pinned windows would be exactly that kind of decision. The
    // full-stack replay this loop already performs on any order change is
    // unaffected either way.
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' }],
      initialState(),
    );
    const ev: Event = { type: 'WindowShown', id: wid(1) };
    const shown = evolve(state, ev);
    const effects = react(state, ev, shown);

    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'SetStacking'),
      [{ type: 'SetStacking', id: wid(1), layer: BASE_LAYER }],
    );
  });

  it('a window becoming visible before it is orderable does not trigger the re-assert — nothing could be positioned yet', () => {
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: BASE_LAYER + 1, canBecomeKey: false, acceptsInput: false, class: 'hud' }],
      initialState(),
    );
    assert.strictEqual(state.order[0].orderable, false, 'precondition: a fresh page-host starts non-orderable');

    const ev: Event = { type: 'WindowShown', id: wid(1) };
    const shown = evolve(state, ev);
    const effects = react(state, ev, shown);

    assert.deepStrictEqual(effects.filter((e) => e.type === 'SetStacking'), []);
  });

  it('does not disturb the op-token biconditional — SetStacking carries no opSeq and is not part of it', () => {
    // `window-kernel-properties.test.ts checkOpSeqInvariants`: opSeqCounter
    // advances by exactly 1 iff the transition emits a ShowWindow/RaiseWindow.
    // This show emits exactly one ShowWindow (the pre-existing visibility
    // diff) plus the new SetStacking this describe pins — one token, not two.
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: false, acceptsInput: false, class: 'hud' }],
      initialState(),
    );
    const ev: Event = { type: 'WindowShown', id: wid(1) };
    const shown = evolve(state, ev);
    const effects = react(state, ev, shown);

    const showWindowEffects = effects.filter((e) => e.type === 'ShowWindow');
    const setStackingEffects = effects.filter((e) => e.type === 'SetStacking');
    assert.strictEqual(showWindowEffects.length, 1, 'sanity: the show still emits exactly one ShowWindow');
    assert.strictEqual(setStackingEffects.length, 1, 'sanity: and exactly one SetStacking alongside it');
    assert.ok(!('opSeq' in setStackingEffects[0]), 'SetStacking carries no opSeq — it is not focus-family');
    assert.strictEqual(shown.opSeqCounter, state.opSeqCounter + 1, 'one advance, for the ShowWindow alone');
  });
});

// react emits only a suffix of each band's bottom -> top order — the smallest trailing run that,
// replayed with moveTop() over whatever the OS already has, still reproduces the whole band.
// "Windows whose index changed" is a different, incorrect rule (see the third case below).
describe('window-kernel: SetStacking replays only the windows that actually need re-raising', () => {
  const makeRecord = (id: WindowId, layer: number): WindowRecord =>
    fold([
      { type: 'WindowRegistered', id, kind: 'browser', layer, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowShown', id },
    ]).order[0];

  const stacking = (effects: Effect[]) => effects.filter((e) => e.type === 'SetStacking');

  it('no order change emits no SetStacking at all', () => {
    const a = makeRecord(wid(1), BASE_LAYER);
    const b = makeRecord(wid(2), BASE_LAYER);
    const prev: State = { ...initialState(), order: [a, b] };
    const next: State = { ...prev, version: prev.version + 1 };
    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), []);
  });

  it('a new window on top emits only that window', () => {
    const a = makeRecord(wid(1), BASE_LAYER);
    const b = makeRecord(wid(2), BASE_LAYER);
    const prev: State = { ...initialState(), order: [a] };
    const next: State = { ...prev, order: [a, b], version: prev.version + 1 };
    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(2), layer: BASE_LAYER },
    ]);
  });

  it('bottom -> top [A,B,C] -> [B,A,C] emits exactly A then C, in that order', () => {
    // The counter-example to "emit the windows whose index changed": that
    // rule would emit A and B (C's index did not move) and replaying
    // move-to-top on A then B yields [C,B,A], not [B,A,C].
    const a = makeRecord(wid(1), BASE_LAYER);
    const b = makeRecord(wid(2), BASE_LAYER);
    const c = makeRecord(wid(3), BASE_LAYER);
    const prev: State = { ...initialState(), order: [a, b, c] };
    const next: State = { ...prev, order: [b, a, c], version: prev.version + 1 };
    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(3), layer: BASE_LAYER },
    ]);
  });

  it('a window inserted at the bottom emits the whole band', () => {
    // Nothing in the previous order can anchor a shorter suffix: everything
    // above the new bottom-most window has to be replayed over it.
    const a = makeRecord(wid(1), BASE_LAYER);
    const b = makeRecord(wid(2), BASE_LAYER);
    const c = makeRecord(wid(3), BASE_LAYER);
    const prev: State = { ...initialState(), order: [b, c] };
    const next: State = { ...prev, order: [a, b, c], version: prev.version + 1 };
    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(2), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(3), layer: BASE_LAYER },
    ]);
  });

  it('a window becoming visible is emitted even though its position did not change', () => {
    const bottom = makeRecord(wid(2), BASE_LAYER);
    const hidden = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    ]).order[0];
    assert.strictEqual(hidden.visible, false, 'precondition: registered, not yet shown');

    const prev: State = { ...initialState(), order: [bottom, hidden] };
    const shown: WindowRecord = { ...hidden, visible: true };
    const next: State = { ...prev, order: [bottom, shown], version: prev.version + 1 };

    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
    ]);
  });

  it('a window becoming orderable is emitted even though its position did not change', () => {
    const bottom = makeRecord(wid(2), BASE_LAYER);
    const notOrderable = fold([
      { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowShown', id: wid(1) },
    ]).order[0];
    assert.strictEqual(notOrderable.visible, true, 'precondition: visible');
    assert.strictEqual(notOrderable.orderable, false, 'precondition: a fresh page-host starts non-orderable');

    const prev: State = { ...initialState(), order: [bottom, notOrderable] };
    const orderable: WindowRecord = { ...notOrderable, orderable: true };
    const next: State = { ...prev, order: [bottom, orderable], version: prev.version + 1 };

    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
    ]);
  });

  it('pinned and base-layer windows are diffed independently of one another', () => {
    // A and B (base layer) swap; P1 and P2 (pinned) do not move at all — and
    // are interleaved with A/B in `order` to prove the diff really groups by
    // band rather than reading raw adjacency.
    const a = makeRecord(wid(1), BASE_LAYER);
    const b = makeRecord(wid(2), BASE_LAYER);
    const p1 = makeRecord(wid(11), BASE_LAYER + 1);
    const p2 = makeRecord(wid(12), BASE_LAYER + 1);

    const prev: State = { ...initialState(), order: [a, p1, b, p2] };
    const next: State = { ...prev, order: [b, p1, a, p2], version: prev.version + 1 };

    assert.deepStrictEqual(stacking(react(prev, { type: 'AppActivated' }, next)), [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
    ]);
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

// ── Parent refocus on WindowClosed ───────────────────────────────────────────

describe('window-kernel: parent refocus on WindowClosed', () => {
  const registerContent = (id: WindowId, extra: Partial<Event & { type: 'WindowRegistered' }> = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'browser',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...extra,
  });

  it('closing the focused child hands the raise to its parent, not whatever else sits on top', () => {
    const parent = wid(1);
    const child = wid(2);
    const other = wid(3);
    const state = fold([
      registerContent(parent),
      registerContent(child, { role: 'child-content', parentId: parent }),
      { type: 'WindowShown', id: parent },
      { type: 'WindowShown', id: child },
      registerContent(other),
      { type: 'WindowShown', id: other },
      { type: 'OsFocusGained', id: child },
    ]);
    assert.strictEqual(keyWindow(state)?.id, child);
    // `other` was registered and shown AFTER the child, so it sits above the
    // parent in `order` once the child is removed — a naive "whatever's now
    // on top" successor would land on it, not the parent.
    assert.deepStrictEqual(state.order.map((w) => w.id), [parent, other, child]);

    const next = evolve(state, { type: 'WindowClosed', id: child });
    const effects = react(state, { type: 'WindowClosed', id: child }, next);

    assert.ok(
      effects.some((e) => e.type === 'RaiseWindow' && e.id === parent),
      'the parent-handoff raise targets the parent',
    );
    assert.strictEqual(next.key, child, 'key is left dangling — RULE 2, unrepaired here');
    assert.strictEqual(keyWindow(next), null, 'the dangling id resolves to nothing; no successor is guessed');
    assert.deepStrictEqual(next.order.map((w) => w.id), [other, parent], 'the parent is moved to the top by its own raise');
  });

  it('a child closing without key raises nothing, even its parent', () => {
    const parent = wid(1);
    const child = wid(2);
    const state = fold([
      registerContent(parent),
      registerContent(child, { role: 'child-content', parentId: parent }),
      { type: 'WindowShown', id: parent },
      { type: 'WindowShown', id: child },
      { type: 'OsFocusGained', id: parent },
    ]);
    assert.strictEqual(keyWindow(state)?.id, parent);

    const next = evolve(state, { type: 'WindowClosed', id: child });
    const effects = react(state, { type: 'WindowClosed', id: child }, next);

    assert.strictEqual(effects.some((e) => e.type === 'RaiseWindow'), false);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted when nothing is raised');
  });

  it('a key child closing while the app is inactive raises nothing — the user is in another app', () => {
    const parent = wid(1);
    const child = wid(2);
    const state = fold([
      registerContent(parent),
      registerContent(child, { role: 'child-content', parentId: parent }),
      { type: 'WindowShown', id: parent },
      { type: 'WindowShown', id: child },
      { type: 'OsFocusGained', id: child },
      { type: 'AppResigned' },
    ]);
    assert.strictEqual(state.key, child);

    const next = evolve(state, { type: 'WindowClosed', id: child });
    const effects = react(state, { type: 'WindowClosed', id: child }, next);

    assert.strictEqual(effects.some((e) => e.type === 'RaiseWindow'), false);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter);
  });

  it('a hidden parent is ineligible: no raise, and order is untouched beyond the removal', () => {
    const parent = wid(1);
    const child = wid(2);
    const state = fold([
      registerContent(parent),
      registerContent(child, { role: 'child-content', parentId: parent }),
      { type: 'WindowShown', id: parent },
      { type: 'WindowShown', id: child },
      { type: 'WindowHidden', id: parent },
      { type: 'OsFocusGained', id: child },
    ]);

    const next = evolve(state, { type: 'WindowClosed', id: child });
    const effects = react(state, { type: 'WindowClosed', id: child }, next);

    assert.strictEqual(effects.some((e) => e.type === 'RaiseWindow'), false, 'a hidden parent cannot take the raise');
    assert.deepStrictEqual(next.order.map((w) => w.id), [parent], 'parent is simply what remains, unmoved');
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted when nothing is raised');
  });

  it('closing a parentless window drives no parent-refocus raise', () => {
    const a = wid(1);
    const b = wid(2);
    const state = fold([registerContent(a), registerContent(b), { type: 'WindowShown', id: a }, { type: 'WindowShown', id: b }]);

    const next = evolve(state, { type: 'WindowClosed', id: b });
    const effects = react(state, { type: 'WindowClosed', id: b }, next);

    assert.strictEqual(effects.some((e) => e.type === 'RaiseWindow'), false, 'no parent linkage -> no re-drive');
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter);
  });

  it('closing a background (non-key) child never puts its parent above the record that actually holds key', () => {
    // The one-order rule: whenever `key` resolves to a record, that record is the topmost one in
    // `order`. A closing child's parent-refocus raise must not violate that even when the closing
    // child was never key itself — `other` here holds key throughout; `child` (parented to
    // `sibling`) closes in the background.
    const other = wid(1);
    const sibling = wid(2);
    const child = wid(3);
    const state = fold([
      registerContent(other),
      registerContent(sibling),
      registerContent(child, { role: 'child-content', parentId: sibling }),
      { type: 'WindowShown', id: other },
      { type: 'WindowShown', id: sibling },
      { type: 'WindowShown', id: child },
      { type: 'OsFocusGained', id: other },
    ]);
    assert.strictEqual(keyWindow(state)?.id, other);
    assert.deepStrictEqual(state.order.map((w) => w.id), [sibling, child, other]);

    const next = evolve(state, { type: 'WindowClosed', id: child });
    const kw = keyWindow(next);
    const top = next.order[next.order.length - 1];
    assert.strictEqual(kw?.id, other, 'key is untouched by the close — RULE 2');
    assert.ok(top !== undefined);
    assert.strictEqual(top.id, kw?.id, 'the key window must still be topmost — the parent-refocus reorder must not displace it');
  });

  it('closing a registered detached devtools window refocuses its parent via the parent-refocus rule', () => {
    const host = wid(1);
    const devtools = wid(2);
    const state = fold([
      registerContent(host, { kind: 'page-host' }),
      { type: 'WindowShown', id: host },
      registerContent(devtools, { class: 'devtools', role: 'utility', parentId: host }),
      { type: 'WindowShown', id: devtools },
      { type: 'OsFocusGained', id: devtools },
    ]);

    const next = evolve(state, { type: 'WindowClosed', id: devtools });
    const effects = react(state, { type: 'WindowClosed', id: devtools }, next);

    assert.ok(effects.some((e) => e.type === 'RaiseWindow' && e.id === host));
    assert.strictEqual(effects.filter((e) => e.type === 'RaiseWindow').length, 1, 'exactly one raise, from one place');
  });
});

// ── Successor raise on WindowHidden ──────────────────────────────────────────

describe('window-kernel: successor raise on WindowHidden', () => {
  const registerContent = (id: WindowId, extra: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'browser',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...extra,
  });

  const raises = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'RaiseWindow');

  // A's priorKey genuinely names B here, because B took key first and A took it from B — the
  // hide-returns-key rule reads that field, not "whatever else is on screen".
  const keyAndSuccessor = (): State => {
    const A = wid(1);
    const B = wid(2);
    return fold([
      registerContent(A),
      registerContent(B),
      { type: 'WindowShown', id: A },
      { type: 'WindowShown', id: B },
      { type: 'OsFocusGained', id: B },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
  };

  it('the key window hides and the window that was key before it (still visible) is raised, carrying the transition token, which is stamped on the successor', () => {
    const A = wid(1);
    const B = wid(2);
    const state = keyAndSuccessor();
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A holds key');
    assert.strictEqual(state.appActive, true, 'precondition: app is active');
    assert.strictEqual(state.order.find((w) => w.id === B)?.visible, true, 'precondition: B is genuinely shown');
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, B, 'precondition: B held key before A took it');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), [{ type: 'RaiseWindow', id: B, opSeq: next.opSeqCounter }]);
    const raise = effects.find((e) => e.type === 'RaiseWindow');
    assert.strictEqual(raise?.opSeq, next.opSeqCounter, 'the token is what makes the OS echo of this raise recognisable as machine-caused');
    assert.strictEqual(next.order.find((w) => w.id === B)?.lastOpSeq, next.opSeqCounter, "evolve's stamp equals react's effect token");
    assert.ok(raise !== undefined && !('intent' in raise), 'a derived raise carries no user intent — the app-inactive mask applies to it');
  });

  it('the window taking key had no prior key holder (key was null before it) — hiding raises nothing, even with another content window visible', () => {
    // A palette opened by hotkey while another app was frontmost takes key directly from null,
    // and Escape dismissing it must not raise a Peek window (here, B) the user never touched.
    const A = wid(1);
    const B = wid(2);
    const state = fold([
      registerContent(A),
      registerContent(B),
      { type: 'WindowShown', id: A },
      { type: 'WindowShown', id: B },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A holds key');
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, null, 'precondition: nothing held key before A');
    assert.strictEqual(state.order.find((w) => w.id === B)?.visible, true, 'precondition: B is genuinely shown and would have been the old unconditional successor');
    const bLastOpSeqBeforeHide = state.order.find((w) => w.id === B)?.lastOpSeq;

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), [], 'nothing in Peek was in use before A took key, so nothing is raised');
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted — no raise means no token');
    assert.strictEqual(next.order.find((w) => w.id === B)?.lastOpSeq, bLastOpSeqBeforeHide, 'B is not restamped by this hide — whatever it carried from its own WindowShown is untouched');
  });

  it('the prior key window closed before the hide — raises the topmost remaining content window', () => {
    const B = wid(1);
    const D = wid(2);
    const A = wid(3);
    const state = fold([
      registerContent(B),
      registerContent(D),
      registerContent(A),
      { type: 'WindowShown', id: B },
      { type: 'WindowShown', id: A },
      { type: 'OsFocusGained', id: D },
      { type: 'WindowClosed', id: D },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, D, 'precondition: A took key from D');
    assert.strictEqual(state.order.some((w) => w.id === D), false, 'precondition: D has since closed');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(
      raises(effects),
      [{ type: 'RaiseWindow', id: B, opSeq: next.opSeqCounter }],
      'D is gone, so the topmost remaining content window is raised instead',
    );
  });

  it('the prior key window has since gone pendingHidden (a teardown already decided) — falls back to the topmost content window', () => {
    const B = wid(1);
    const D = wid(2);
    const A = wid(3);
    const state = fold([
      registerContent(B),
      registerContent(D),
      registerContent(A),
      { type: 'WindowShown', id: B },
      { type: 'WindowShown', id: D },
      { type: 'WindowShown', id: A },
      { type: 'OsFocusGained', id: D },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
      { type: 'WindowDestroyRequested', id: D },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, D, 'precondition: A took key from D');
    assert.strictEqual(state.order.find((w) => w.id === D)?.pendingHidden, true, 'precondition: D is doomed');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(
      raises(effects),
      [{ type: 'RaiseWindow', id: B, opSeq: next.opSeqCounter }],
      'D no longer admits a focus assert, so the topmost remaining content window is raised instead',
    );
  });

  it('the confirmation of the successor raise raises nothing more — one hide, one raise', () => {
    // The backend answers the raise with a machine-caused focus report that
    // carries the raise's own token. `key` still names the hidden window at
    // that point (RULE 2 reserved the write for this report), so a plain key
    // diff would fire a second time and issue a second raise for the same
    // window — measured live as two `raise-realized` records 1ms apart on
    // every keepLive hide of the palette. A report carrying the token of the
    // last op issued to its window is that op's confirmation, not news.
    const A = wid(1);
    const B = wid(2);
    const state = keyAndSuccessor();
    const hidden = evolve(state, { type: 'WindowHidden', id: A });
    const raiseToken = hidden.opSeqCounter;
    assert.strictEqual(hidden.order.find((w) => w.id === B)?.lastOpSeq, raiseToken, 'precondition: B carries the raise token');
    assert.strictEqual(hidden.key, A, 'precondition: key still names the hidden window');

    const confirmation: Event = { type: 'OsFocusGained', id: B, cause: { kind: 'machine', opSeq: raiseToken } };
    const next = evolve(hidden, confirmation);
    assert.strictEqual(next.key, B, 'the report is recorded as fact');
    assert.deepStrictEqual(raises(react(hidden, confirmation, next)), [], 'and drives nothing');
    assert.strictEqual(next.opSeqCounter, raiseToken, 'no effect, no token');
  });

  it('a RaiseWindow COMMAND on the successor after the hide still raises — a command is not a confirmation', () => {
    // The command's manufactured report must stay distinguishable from the
    // confirmation above: B carries the hide's raise token, and a command
    // issued next must not read as the echo of that raise.
    const A = wid(1);
    const B = wid(2);
    const hidden = evolve(keyAndSuccessor(), { type: 'WindowHidden', id: A });
    const decision = decide(hidden, { type: 'RaiseWindow', id: B, expectedVersion: hidden.version });
    assert.ok('events' in decision);
    const ev = decision.events[0];
    const next = evolve(hidden, ev);
    assert.deepStrictEqual(raises(react(hidden, ev, next)), [{ type: 'RaiseWindow', id: B, opSeq: next.opSeqCounter }]);
  });

  it('key is not written by the transition, and order is not reordered', () => {
    const A = wid(1);
    const state = keyAndSuccessor();

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);

    assert.strictEqual(next.key, A, 'RULE 2 reserves the key write for OsFocusGained — the hidden id still dangles here');
    assert.deepStrictEqual(next.order.map((w) => w.id), state.order.map((w) => w.id), 'the hidden record is left where it sits');
  });

  it('a NON-key window hiding raises nothing and mints no token', () => {
    const A = wid(1);
    const C = wid(2);
    const state = fold([
      registerContent(A),
      registerContent(C),
      { type: 'WindowShown', id: A },
      { type: 'WindowShown', id: C },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A, not C, holds key');
    assert.strictEqual(state.order.find((w) => w.id === C)?.visible, true, 'precondition: C is genuinely shown');

    const ev: Event = { type: 'WindowHidden', id: C };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted when nothing is raised');
  });

  it('the key window hides with no eligible successor (the only other window is registered but never shown): no raise, no token', () => {
    const A = wid(1);
    const B = wid(2);
    const state = fold([
      registerContent(A),
      registerContent(B),
      { type: 'WindowShown', id: A },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A holds key');
    assert.strictEqual(state.order.find((w) => w.id === B)?.visible, false, 'precondition: B was registered but never shown');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted — no content window is left to raise');
  });

  it('a successor that is not a content window is skipped in favour of one that is', () => {
    // B (content) sits below U (a utility popup — visible, focusable, but not
    // in CONTENT_ROLES) which sits below A (key). A's prior key holder, D,
    // closes before the hide, so this exercises `successorOnHide`'s fallback
    // branch: it lands on `topmost`, which leaves U topmost by position, but
    // `isContentWindow` excludes it, so the successor is B.
    const B = wid(1);
    const U = wid(2);
    const A = wid(3);
    const D = wid(4);
    const state = fold([
      registerContent(B),
      registerContent(U, { class: 'popup', role: 'utility' }),
      registerContent(D),
      registerContent(A),
      { type: 'WindowShown', id: B },
      { type: 'WindowShown', id: U },
      { type: 'WindowShown', id: A },
      { type: 'OsFocusGained', id: D },
      { type: 'WindowClosed', id: D },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [B, U, A], 'precondition: U sits above B, A on top');
    assert.strictEqual(isContentWindow(state.order.find((w) => w.id === U)!), false, 'precondition: U is not a content window');
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A holds key');
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, D, 'precondition: A took key from D');
    assert.strictEqual(state.order.some((w) => w.id === D), false, 'precondition: D has since closed, forcing the fallback branch');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), [{ type: 'RaiseWindow', id: B, opSeq: next.opSeqCounter }], 'U is skipped, B is raised');
  });

  it('a successor already marked pendingHidden (a teardown already decided) is skipped in favour of one that is not', () => {
    // C (content, eligible) sits below B (content, but doomed — a teardown
    // was decided for it, and the OS has not confirmed anything yet) which
    // sits below D (also doomed) which sits below A (key). A's prior key
    // holder is D, and D has since gone pendingHidden too, so this exercises
    // `successorOnHide`'s fallback branch: it lands on `topmost`, which
    // walks down from A past D and B (both doomed, both excluded) to C — a
    // doomed window is never a legitimate raise target, whatever its
    // position, because raising one would be an activating show onto a
    // window already committed to teardown.
    const C = wid(1);
    const B = wid(2);
    const A = wid(3);
    const D = wid(4);
    const state = fold([
      registerContent(C),
      registerContent(B),
      registerContent(D),
      registerContent(A),
      { type: 'WindowShown', id: C },
      { type: 'WindowShown', id: B },
      { type: 'WindowShown', id: D },
      { type: 'WindowShown', id: A },
      { type: 'OsFocusGained', id: D },
      { type: 'OsFocusGained', id: A },
      { type: 'AppActivated' },
      { type: 'WindowDestroyRequested', id: B },
      { type: 'WindowDestroyRequested', id: D },
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [C, B, D, A], 'precondition: B sits above C, D above B, A on top');
    assert.strictEqual(state.order.find((w) => w.id === B)?.pendingHidden, true, 'precondition: B is doomed');
    assert.strictEqual(isContentWindow(state.order.find((w) => w.id === B)!), false, 'precondition: pendingHidden excludes B from isContentWindow');
    assert.strictEqual(state.order.find((w) => w.id === A)?.priorKey, D, 'precondition: A took key from D');
    assert.strictEqual(state.order.find((w) => w.id === D)?.pendingHidden, true, 'precondition: D is doomed too, forcing the fallback branch');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), [{ type: 'RaiseWindow', id: C, opSeq: next.opSeqCounter }], 'B is skipped, C is raised');
  });

  it('while appActive is false, the same hide raises nothing and mints no token', () => {
    const A = wid(1);
    const B = wid(2);
    const state = fold([
      registerContent(A),
      registerContent(B),
      { type: 'WindowShown', id: A },
      { type: 'WindowShown', id: B },
      { type: 'OsFocusGained', id: A },
      // The app starts ACTIVE (a launch is an activation — see
      // `initialState`), so reaching the inactive state this case is about
      // takes a resign; its absence no longer stands for it. Neither window is
      // sweep-eligible (both are content at the base layer), so the resign
      // changes nothing here but `appActive`.
      { type: 'AppResigned' },
    ]);
    assert.strictEqual(state.appActive, false, 'precondition: app is not active');
    assert.strictEqual(keyWindow(state)?.id, A, 'precondition: A holds key');

    const ev: Event = { type: 'WindowHidden', id: A };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    assert.deepStrictEqual(raises(effects), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no op minted while the app is backgrounded');
  });

  it('the duplicate hide (backend echo + late native hide event) emits nothing the second time', () => {
    const A = wid(1);
    const state = keyAndSuccessor();

    const ev: Event = { type: 'WindowHidden', id: A };
    const first = evolve(state, ev);
    assert.ok(react(state, ev, first).some((e) => e.type === 'RaiseWindow'), 'sanity: the first hide really does raise a successor');

    const dup = evolve(first, ev);
    assert.deepStrictEqual(react(first, ev, dup), [], 'no effects — including no second raise — from the duplicate');
    assert.deepStrictEqual(dup.order, first.order, 'order is byte-identical to after the first hide');
    assert.strictEqual(dup.opSeqCounter, first.opSeqCounter, 'no second token minted');
  });
});

// ── Successor raise on WindowClosed ──────────────────────────────────────────

describe('window-kernel: successor raise on WindowClosed', () => {
  const raises = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'RaiseWindow');

  // A page host takes key from the world; the switcher — parentless, no keepLive, so
  // CloseOrHideWindow closes rather than hides it — takes key from the host through the
  // request/confirm two-step a RaiseWindow command uses, which records the host as its priorKey.
  const hostThenSwitcher = (): { state: State; P: WindowId; S: WindowId } => {
    const P = wid(1);
    const S = wid(2);
    const base = fold([
      { type: 'WindowRegistered', id: P, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id: P },
      { type: 'OsFocusGained', id: P, cause: { kind: 'world' } },
      { type: 'WindowRegistered', id: S, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'switcher' },
      { type: 'WindowShown', id: S },
    ]);
    const decision = decide(base, { type: 'RaiseWindow', id: S, expectedVersion: base.version });
    assert.ok('events' in decision);
    const { state: requested, effects } = foldWithEffects(decision.events, base);
    assert.deepStrictEqual(raises(effects), [{ type: 'RaiseWindow', id: S, opSeq: requested.opSeqCounter }], 'precondition: the switcher raise is requested');
    const state = evolve(requested, { type: 'OsFocusGained', id: S, cause: { kind: 'machine', opSeq: requested.opSeqCounter } });
    return { state, P, S };
  };

  it('closing the key switcher raises the page host that held key before it, and the confirming report hands key back', () => {
    const { state, P, S } = hostThenSwitcher();
    assert.strictEqual(keyWindow(state)?.id, S, 'precondition: the switcher holds key');
    assert.strictEqual(state.order.find((w) => w.id === S)?.priorKey, P, 'precondition: the confirming report recorded the host as the prior key holder');
    assert.strictEqual(state.order.find((w) => w.id === S)?.parentId, undefined, 'precondition: the switcher is parentless — no parent handoff applies');
    assert.strictEqual(state.appActive, true, 'precondition: the app is active');

    const decision = decide(state, { type: 'CloseOrHideWindow', id: S, expectedVersion: state.version });
    assert.ok('events' in decision);
    assert.deepStrictEqual(decision.events, [{ type: 'WindowClosed', id: S }], 'precondition: no keepLive, so the switcher closes rather than hides');
    const { state: closed, effects } = foldWithEffects(decision.events, state);

    assert.deepStrictEqual(raises(effects), [{ type: 'RaiseWindow', id: P, opSeq: closed.opSeqCounter }], 'exactly one raise, naming the prior key holder');
    assert.strictEqual(closed.order.find((w) => w.id === P)?.lastOpSeq, closed.opSeqCounter, 'the successor carries the transition token');
    assert.strictEqual(closed.key, S, 'key still names the closed switcher — only the OS report writes it');

    const confirmation: Event = { type: 'OsFocusGained', id: P, cause: { kind: 'machine', opSeq: closed.opSeqCounter } };
    const confirmed = evolve(closed, confirmation);
    assert.strictEqual(keyWindow(confirmed)?.id, P, 'the confirming report hands key to the page host');
    assert.deepStrictEqual(raises(react(closed, confirmation, confirmed)), [], 'and the confirmation drives no second raise');
    assert.strictEqual(confirmed.opSeqCounter, closed.opSeqCounter, 'no token minted by the confirmation');
  });

  it('the closed key holder took key from nothing (priorKey null) — closing it raises nothing', () => {
    const P = wid(1);
    const S = wid(2);
    const state = fold([
      { type: 'WindowRegistered', id: P, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: S, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'switcher' },
      { type: 'WindowShown', id: P },
      { type: 'WindowShown', id: S },
      { type: 'OsFocusGained', id: S, cause: { kind: 'world' } },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === S)?.priorKey, null, 'precondition: nothing held key before the switcher');

    const ev: Event = { type: 'WindowClosed', id: S };
    const closed = evolve(state, ev);
    assert.deepStrictEqual(raises(react(state, ev, closed)), [], 'nothing in Peek was in use before the switcher, so nothing is raised');
    assert.strictEqual(closed.opSeqCounter, state.opSeqCounter, 'no raise means no token');
  });
});

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

  it('normal -> entering stashes preBounds from the REAL bounds mirror, not a hardcoded null (95deff8c)', () => {
    // Every other fixture in this describe block never sets bounds, so rec.bounds ?? null reads
    // as null either way; this one seeds a real bounds mirror first so a hardcoded null would fail.
    const state = fold(registerTwo(), initialState());
    const rect: Rectangle = { x: 10, y: 20, width: 640, height: 480 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: rect });

    const enterDecision = decide(withBounds, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: withBounds.version });
    assert.ok('events' in enterDecision);
    assert.deepStrictEqual(enterDecision.events, [
      { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: rect },
    ]);
    const entering = fold(enterDecision.events, withBounds);
    const mode = entering.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(mode?.name, 'entering');
    assert.deepStrictEqual((mode as { preBounds: Rectangle | null }).preBounds, rect, 'preBounds carries the real bounds mirror, not null');
  });

  it('a transition already entering, leaving or fullscreen never re-stashes preBounds from a further SetFullscreen', () => {
    const state = fold(registerTwo(), initialState());
    const rect: Rectangle = { x: 10, y: 20, width: 640, height: 480 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: rect });

    // normal -> entering, real preBounds stashed.
    const enterDecision = decide(withBounds, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: withBounds.version });
    assert.ok('events' in enterDecision);
    let s = fold(enterDecision.events, withBounds);
    assert.deepStrictEqual((s.order.find((w) => w.id === wid(1))?.fsMode as { preBounds: Rectangle | null }).preBounds, rect);

    // A further re-confirming request while still entering coalesces into
    // pendingDesire — preBounds must survive untouched. (`desired: true`,
    // not a change of mind, so the settle below still lands on fullscreen —
    // the mind-changing coalesce is covered by "a request arriving
    // mid-transition..." above.)
    const midFlight = decide(s, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: s.version });
    assert.ok('events' in midFlight);
    s = fold(midFlight.events, s);
    const enteringMode = s.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(enteringMode?.name, 'entering');
    assert.deepStrictEqual((enteringMode as { preBounds: Rectangle | null }).preBounds, rect, 'preBounds untouched by a mid-flight coalesce');

    // Settle into fullscreen.
    s = evolve(s, { type: 'OsFullscreenEntered', id: wid(1) });
    assert.strictEqual(s.order.find((w) => w.id === wid(1))?.fsMode.name, 'fullscreen');

    // The OS's own fullscreen-rect report lands on the bounds mirror — a re-stash from this
    // value, rather than the held fsMode.preBounds, would be wrong.
    const transientRect: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    s = evolve(s, { type: 'BoundsChanged', id: wid(1), bounds: transientRect });

    // fullscreen -> leaving: preBounds must come from the held fsMode, not
    // from the current (fullscreen-rect) bounds mirror.
    const leaveDecision = decide(s, { type: 'SetFullscreen', id: wid(1), desired: false, expectedVersion: s.version });
    assert.ok('events' in leaveDecision);
    assert.deepStrictEqual(leaveDecision.events, [
      { type: 'FullscreenTransitionStarted', id: wid(1), entering: false, preBounds: rect },
    ]);
    s = fold(leaveDecision.events, s);
    const leavingMode = s.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(leavingMode?.name, 'leaving');
    assert.deepStrictEqual((leavingMode as { preBounds: Rectangle | null }).preBounds, rect, 'preBounds never overwritten by the fullscreen-era bounds report');

    // A further request while still leaving coalesces too — preBounds
    // still untouched.
    const midFlightLeaving = decide(s, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: s.version });
    assert.ok('events' in midFlightLeaving);
    s = fold(midFlightLeaving.events, s);
    const stillLeavingMode = s.order.find((w) => w.id === wid(1))?.fsMode;
    assert.strictEqual(stillLeavingMode?.name, 'leaving');
    assert.deepStrictEqual((stillLeavingMode as { preBounds: Rectangle | null }).preBounds, rect, 'preBounds untouched by a mid-flight coalesce while leaving');
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

  it('FullscreenSettleTimeout no longer guesses a settled fsMode — it leaves the record in flight and asks the OS instead', () => {
    // See "window-kernel: fullscreen settle timeout asks instead of guessing"
    // below for the full coverage of the reconcile request this now produces.
    const state = fold(registerTwo(), initialState());

    const entering = fold([{ type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null }], state);
    const afterEntering = evolve(entering, { type: 'FullscreenSettleTimeout', id: wid(1) });
    assert.strictEqual(afterEntering.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');

    const leaving = fold(
      [
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null },
        { type: 'OsFullscreenEntered', id: wid(1) },
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: false, preBounds: null },
      ],
      state,
    );
    assert.strictEqual(leaving.order.find((w) => w.id === wid(1))?.fsMode.name, 'leaving');
    const afterLeaving = evolve(leaving, { type: 'FullscreenSettleTimeout', id: wid(1) });
    assert.strictEqual(afterLeaving.order.find((w) => w.id === wid(1))?.fsMode.name, 'leaving');
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

  it('(a) Space-switch settings clobber: a fullscreen transition keeps its fsMode when a Space-switch focus lands on another window mid-animation', () => {
    // A fullscreen transition keeps its `fsMode` even if a Space-switch focus lands on another
    // window mid-animation: `key` and `order` are a report of who has OS focus (RULE 2), and a
    // settings window with `role: 'workspace'` is genuinely `isContentWindow` (an admitted content
    // role, `CONTENT_ROLES`), so a real focus landing on it really does move `key` and the topmost
    // content window to it. What survives is narrower and still real: `fsMode` is untouched by that
    // focus, and the transition that was already in flight settles to `fullscreen` on its own OS
    // report regardless of who holds `key` by then.
    const state = fold(
      [
        { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
        { type: 'WindowRegistered', id: wid(2), kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'settings', role: 'workspace' },
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'OsFocusGained', id: wid(1) },
      ],
      initialState(),
    );
    assert.strictEqual(state.key, wid(1), 'host holds key before the Space-switch churn');
    assert.strictEqual(topmost(state, isContentWindow)?.id, wid(1), 'host is the main/command target before the churn');

    // Begin fullscreen on the host.
    const enterDecision = decide(state, { type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: state.version });
    assert.ok('events' in enterDecision);
    const entering = fold(enterDecision.events, state);
    assert.strictEqual(entering.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');

    // A Space-switch focus lands on the settings window mid-animation.
    const churned = evolve(entering, { type: 'OsFocusGained', id: wid(2) });
    assert.strictEqual(churned.key, wid(2), 'focus genuinely moved to settings — no pin holds it on the host');
    assert.strictEqual(
      topmost(churned, isContentWindow)?.id,
      wid(2),
      'the command/main target genuinely follows key to settings — the old "front unchanged" premise is not the kernel\'s answer',
    );
    assert.strictEqual(
      churned.order.find((w) => w.id === wid(1))?.fsMode.name,
      'entering',
      'fsMode is orthogonal to key: the mid-transition focus elsewhere leaves the host\'s transition untouched',
    );

    // The transition settles on its own OS report, independent of who holds key by then.
    const settled = evolve(churned, { type: 'OsFullscreenEntered', id: wid(1) });
    assert.strictEqual(settled.order.find((w) => w.id === wid(1))?.fsMode.name, 'fullscreen');
    assert.strictEqual(settled.key, wid(2), 'key is untouched by the OS settle — it stays wherever the churn left it');
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

describe('window-kernel: fullscreen settle timeout asks instead of guessing', () => {
  const registerTwo = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
  ];

  it('a settle timeout on a window in `entering` emits exactly one ReconcileFullscreen naming it, and does not change its fsMode', () => {
    const state = fold(registerTwo(), initialState());
    const entering = evolve(state, { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null });
    assert.strictEqual(entering.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');

    const timeout: Event = { type: 'FullscreenSettleTimeout', id: wid(1) };
    const next = evolve(entering, timeout);
    assert.strictEqual(next.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering', 'fsMode is untouched — the machine asks, it does not guess');

    const effects = react(entering, timeout, next);
    assert.deepStrictEqual(effects, [{ type: 'ReconcileFullscreen', id: wid(1) }]);
  });

  it('a settle timeout on a window already normal or fullscreen emits nothing and leaves fsMode untouched', () => {
    const state = fold(registerTwo(), initialState());

    // wid(1) is 'normal' straight from registration.
    const normalTimeout: Event = { type: 'FullscreenSettleTimeout', id: wid(1) };
    const afterNormal = evolve(state, normalTimeout);
    assert.strictEqual(afterNormal.order, state.order, 'nothing to ask — order is untouched, not re-marked');
    assert.deepStrictEqual(react(state, normalTimeout, afterNormal), []);

    // Drive wid(2) to settled fullscreen, then time out on it too.
    const fullscreen = evolve(state, { type: 'OsFullscreenEntered', id: wid(2) });
    assert.strictEqual(fullscreen.order.find((w) => w.id === wid(2))?.fsMode.name, 'fullscreen');
    const fsTimeout: Event = { type: 'FullscreenSettleTimeout', id: wid(2) };
    const afterFullscreen = evolve(fullscreen, fsTimeout);
    assert.strictEqual(afterFullscreen.order, fullscreen.order);
    assert.deepStrictEqual(react(fullscreen, fsTimeout, afterFullscreen), []);
  });

  it('a settle timeout naming an unknown window emits nothing and does not throw', () => {
    const state = fold(registerTwo(), initialState());
    const timeout: Event = { type: 'FullscreenSettleTimeout', id: wid(99) };
    assert.doesNotThrow(() => evolve(state, timeout));
    const next = evolve(state, timeout);
    assert.strictEqual(next.order, state.order);
    assert.deepStrictEqual(react(state, timeout, next), []);
  });

  it('a second timeout for the same still-in-flight window re-asks nothing — the record is already unverified', () => {
    const state = fold(registerTwo(), initialState());
    const entering = evolve(state, { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null });

    const firstTimeout: Event = { type: 'FullscreenSettleTimeout', id: wid(1) };
    const afterFirst = evolve(entering, firstTimeout);
    assert.deepStrictEqual(react(entering, firstTimeout, afterFirst), [{ type: 'ReconcileFullscreen', id: wid(1) }]);
    const modeAfterFirst = afterFirst.order.find((w) => w.id === wid(1))?.fsMode;
    if (modeAfterFirst?.name !== 'entering') throw new Error('unreachable — still entering, asserted by the settle-timeout contract');
    assert.strictEqual(modeAfterFirst.unverified, true);

    const secondTimeout: Event = { type: 'FullscreenSettleTimeout', id: wid(1) };
    const afterSecond = evolve(afterFirst, secondTimeout);
    assert.deepStrictEqual(
      react(afterFirst, secondTimeout, afterSecond),
      [],
      'the record was already unverified — a second still-in-flight timeout is a no-op, not a second question',
    );
  });

  it('AppActivated with two windows in flight (one entering, one leaving) emits two ReconcileFullscreen effects, one per window', () => {
    const before = fold(
      [
        ...registerTwo(),
        { type: 'FullscreenTransitionStarted', id: wid(1), entering: true, preBounds: null },
        { type: 'FullscreenTransitionStarted', id: wid(2), entering: false, preBounds: null },
      ],
      initialState(),
    );
    assert.strictEqual(before.order.find((w) => w.id === wid(1))?.fsMode.name, 'entering');
    assert.strictEqual(before.order.find((w) => w.id === wid(2))?.fsMode.name, 'leaving');

    const activation: Event = { type: 'AppActivated' };
    const activated = evolve(before, activation);
    const reconciles = react(before, activation, activated).filter(
      (e): e is Extract<Effect, { type: 'ReconcileFullscreen' }> => e.type === 'ReconcileFullscreen',
    );
    assert.deepStrictEqual(
      reconciles.map((e) => e.id).sort(),
      [wid(1), wid(2)].sort(),
    );
  });

  it('AppActivated with nothing in flight emits no ReconcileFullscreen', () => {
    const before = fold(registerTwo(), initialState());
    const activation: Event = { type: 'AppActivated' };
    const activated = evolve(before, activation);
    const effects = react(before, activation, activated);
    assert.strictEqual(effects.some((e) => e.type === 'ReconcileFullscreen'), false);
    assert.strictEqual(
      activated.order.every((w) => w.fsMode.name !== 'entering' && w.fsMode.name !== 'leaving'),
      true,
    );
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

  it('Maximize with a workArea snaps bounds to it and stashes the TRUE pre-maximize bounds (not the just-written work area); Unmaximize restores them', () => {
    // preMaxBounds is resolved from rec.bounds inside decide, before any of the three returned
    // events reach evolve/fold, so the stash is provably the pre-maximize value.
    const state = fold(registerTwo(), initialState());
    const original: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: original });

    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const maxDecision = decide(withBounds, { type: 'Maximize', id: wid(1), workArea, expectedVersion: withBounds.version });
    assert.ok('events' in maxDecision);
    assert.deepStrictEqual(maxDecision.events, [
      { type: 'PendingProjectionDiscarded', id: wid(1) },
      { type: 'Maximized', id: wid(1), preMaxBounds: original },
      { type: 'BoundsChanged', id: wid(1), bounds: workArea },
    ]);
    const maximized = fold(maxDecision.events, withBounds);
    const maxRec = maximized.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(maxRec.maximized, true);
    assert.deepStrictEqual(maxRec.preMaxBounds, original, 'stashed the PRE-maximize bounds, never the work area just written');
    assert.deepStrictEqual(maxRec.bounds, workArea, 'the window actually snaps to the given work area — the regression this pins');

    const unmaxDecision = decide(maximized, { type: 'Unmaximize', id: wid(1), expectedVersion: maximized.version });
    assert.ok('events' in unmaxDecision);
    const restored = fold(unmaxDecision.events, maximized);
    const restoredRec = restored.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(restoredRec.maximized, false);
    assert.strictEqual(restoredRec.preMaxBounds, null);
    assert.deepStrictEqual(restoredRec.bounds, original, 'restored to the pre-maximize rect, not left at the work area');
  });

  it('re-maximizing an already-maximized window is a no-op — the original stash survives a mirror moved by the user', () => {
    // The stale-snapshot unmaximize-no-op trap: `decide`'s Maximize arm
    // no-ops once `rec.maximized` is already true (see its own comment), so
    // a second Maximize command must never re-stash `preMaxBounds` from
    // whatever the bounds mirror has since become — only Unmaximize is
    // allowed to touch the stash after the first Maximize.
    const state = fold(registerTwo(), initialState());
    const original: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
    const workArea: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };
    const withBounds = evolve(state, { type: 'BoundsChanged', id: wid(1), bounds: original });

    const maxDecision = decide(withBounds, { type: 'Maximize', id: wid(1), workArea, expectedVersion: withBounds.version });
    assert.ok('events' in maxDecision);
    const maximized = fold(maxDecision.events, withBounds);

    // The user resized the maximized window smaller; the mirror tracked it.
    const shrunk: Rectangle = { x: 50, y: 50, width: 300, height: 200 };
    const resized = evolve(maximized, { type: 'BoundsChanged', id: wid(1), bounds: shrunk });

    const reMaxDecision = decide(resized, { type: 'Maximize', id: wid(1), workArea, expectedVersion: resized.version });
    assert.ok('events' in reMaxDecision);
    assert.deepStrictEqual(reMaxDecision.events, [], 'already maximized — a no-op, never a re-snap');
    const rec = fold(reMaxDecision.events, resized).order.find((w) => w.id === wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, original, 'the original pre-max rect survives a re-maximize — never re-stashed from the shrunk mirror');
  });

  it('Maximize with no workArea supplied stashes null and writes no bounds; Unmaximize then restores nothing', () => {
    // The caller-optional half of the command (see its own doc for why): a
    // dispatch site with no rect to hand still gets a valid flag flip.
    const state = fold(registerTwo(), initialState());
    const maxDecision = decide(state, { type: 'Maximize', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in maxDecision);
    assert.deepStrictEqual(maxDecision.events, [
      { type: 'PendingProjectionDiscarded', id: wid(1) },
      { type: 'Maximized', id: wid(1), preMaxBounds: null },
    ]);
    const maximized = fold(maxDecision.events, state);
    const maxRec = maximized.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(maxRec.preMaxBounds, null, 'no stash was possible — no bounds had ever been reported either');
    assert.strictEqual(maxRec.bounds, undefined, 'no workArea on the command means no paired BoundsChanged');

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

  it('SeedMaximized stashes the rect the CALLER supplies, so a restored window unmaximizes back to its pre-maximize bounds and not to the maximized one', () => {
    // The defect this pins: reopen-last-closed and session restore build the
    // window ALREADY at its saved maximized rect, so `rec.bounds` at that
    // moment IS the maximized rect. Replaying `Maximize` would stash that as
    // the thing to unmaximize back to, and the window would never move. The
    // saved pre-maximize rect is data only the caller holds, so it rides the
    // command.
    const maximizedRect: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const savedPreMax: Rectangle = { x: 100, y: 120, width: 800, height: 600 };
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
          bounds: maximizedRect,
        },
      ],
      initialState(),
    );

    const seedDecision = decide(state, { type: 'SeedMaximized', id: wid(1), preMaxBounds: savedPreMax, expectedVersion: state.version });
    assert.ok('events' in seedDecision);
    assert.deepStrictEqual(
      seedDecision.events,
      [{ type: 'Maximized', id: wid(1), preMaxBounds: savedPreMax }],
      'a seed only — no paired BoundsChanged (the window is already at the maximized rect) and no PendingProjectionDiscarded',
    );
    const seeded = fold(seedDecision.events, state);
    const seededRec = seeded.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(seededRec.maximized, true);
    assert.deepStrictEqual(seededRec.preMaxBounds, savedPreMax, 'the stash is the CALLER-supplied rect, never the creation bounds');
    assert.deepStrictEqual(seededRec.bounds, maximizedRect, 'the seed moved nothing');

    const unmaxDecision = decide(seeded, { type: 'Unmaximize', id: wid(1), expectedVersion: seeded.version });
    assert.ok('events' in unmaxDecision);
    const restored = fold(unmaxDecision.events, seeded);
    const restoredRec = restored.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(restoredRec.maximized, false);
    assert.deepStrictEqual(
      restoredRec.bounds,
      savedPreMax,
      'THE BUG: without the explicit stash the window stays at the maximized rect with only the flag cleared',
    );
  });

  it('replaying Maximize in place of SeedMaximized would stash the maximized rect — the reason the command exists', () => {
    // The negative control for the test above, on the same state: it is what
    // the restore path did before `SeedMaximized`, and it demonstrates that
    // `Maximize` is not a substitute rather than merely a different spelling.
    const maximizedRect: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
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
          bounds: maximizedRect,
        },
      ],
      initialState(),
    );
    const maxDecision = decide(state, { type: 'Maximize', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in maxDecision);
    const maximized = fold(maxDecision.events, state);
    assert.deepStrictEqual(
      maximized.order.find((w) => w.id === wid(1))!.preMaxBounds,
      maximizedRect,
      'derived from the bounds mirror, which at restore time already holds the maximized rect',
    );
    const unmaxDecision = decide(maximized, { type: 'Unmaximize', id: wid(1), expectedVersion: maximized.version });
    assert.ok('events' in unmaxDecision);
    const restored = fold(unmaxDecision.events, maximized);
    assert.deepStrictEqual(
      restored.order.find((w) => w.id === wid(1))!.bounds,
      maximizedRect,
      'unmaximize returns the window to where it already was — visibly, nothing happens',
    );
  });

  it('SeedMaximized accepts a null stash, and is a no-op while fullscreen owns the display', () => {
    // Null is legitimate here for the same reason it is on `Maximized`: a
    // window saved maximized with no restorable rect behind it.
    const state = fold(registerTwo(), initialState());
    const nullSeed = decide(state, { type: 'SeedMaximized', id: wid(1), preMaxBounds: null, expectedVersion: state.version });
    assert.ok('events' in nullSeed);
    const seeded = fold(nullSeed.events, state);
    const seededRec = seeded.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(seededRec.maximized, true);
    assert.strictEqual(seededRec.preMaxBounds, null, 'maximized with nowhere to restore to');

    // Same fullscreen-owns-the-display guard as Maximize/SetBounds.
    const inFullscreen = evolve(state, { type: 'FullscreenTransitionStarted', id: wid(2), entering: true, preBounds: null });
    const fsSeed = decide(inFullscreen, { type: 'SeedMaximized', id: wid(2), preMaxBounds: null, expectedVersion: inFullscreen.version });
    assert.ok('events' in fsSeed);
    assert.deepStrictEqual(fsSeed.events, [], 'fullscreen owns the display — the seed is dropped, not applied');
  });

  it('a window registered with construction-time bounds restores to them on maximize/unmaximize, even with no move or resize in between (RegisterWindow.bounds seed)', () => {
    // A window placed at construction fires no native resize or move, so without a seed bounds
    // stays undefined until the first gesture — registration is the only event that ever reports
    // this window's rect before Maximize runs.
    const seeded: Rectangle = { x: 10, y: 20, width: 300, height: 400 };
    const state = fold(
      [{ type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', bounds: seeded }],
      initialState(),
    );
    assert.deepStrictEqual(state.order.find((w) => w.id === wid(1))?.bounds, seeded, 'the construction-time rect seeds the mirror at registration');

    const maxDecision = decide(state, { type: 'Maximize', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in maxDecision);
    const maximized = fold(maxDecision.events, state);
    assert.deepStrictEqual(maximized.order.find((w) => w.id === wid(1))?.preMaxBounds, seeded, 'stashed from the seeded mirror');

    const unmaxDecision = decide(maximized, { type: 'Unmaximize', id: wid(1), expectedVersion: maximized.version });
    assert.ok('events' in unmaxDecision);
    assert.ok(
      unmaxDecision.events.some((e) => e.type === 'BoundsChanged'),
      'a seeded window has a stash to restore, so Unmaximize must write bounds back — the bug this pins had nothing to restore to',
    );
    const restored = fold(unmaxDecision.events, maximized);
    assert.deepStrictEqual(restored.order.find((w) => w.id === wid(1))?.bounds, seeded, 'restored to the bounds the window was constructed with');
  });

  it('a re-registration carrying stale construction-time bounds does not clobber bounds the OS has since reported', () => {
    // `ipc.ts`'s real-tile-launch path registers each window twice; the
    // second pass still carries the same construction-time rect the first
    // one did. `bounds` is a LIVED fact once the OS has reported one, so the
    // seed may only fill an empty mirror — never overwrite a lived one.
    const constructionBounds: Rectangle = { x: 0, y: 0, width: 100, height: 100 };
    const registered: Event = {
      type: 'WindowRegistered',
      id: wid(1),
      kind: 'page-host',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      bounds: constructionBounds,
    };
    const moved: Rectangle = { x: 500, y: 500, width: 200, height: 200 };
    const state = fold([registered, { type: 'BoundsChanged', id: wid(1), bounds: moved }], initialState());
    assert.deepStrictEqual(state.order.find((w) => w.id === wid(1))?.bounds, moved, 'the OS has since reported a real position');

    const reRegistered = evolve(state, registered);
    assert.deepStrictEqual(
      reRegistered.order.find((w) => w.id === wid(1))?.bounds,
      moved,
      'the lived bounds survive — the stale construction-time seed must not overwrite them',
    );
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

  it('DisplayChanged batch: mixed block states are independent per window in the same event', () => {
    const state = fold(registerTwo(), initialState());
    // Window 1 is shown and normal — unblocked, reprojects immediately.
    const shown = evolve(state, { type: 'WindowShown', id: wid(1) });
    // Window 2 keeps registerTwo()'s default: hidden — blocked, held.
    const rec2Before = shown.order.find((w) => w.id === wid(2))!;
    assert.strictEqual(rec2Before.visible, false, 'precondition: window 2 still hidden');

    const proj1: Rectangle = { x: 10, y: 10, width: 100, height: 100 };
    const proj2: Rectangle = { x: 20, y: 20, width: 200, height: 200 };
    const after = evolve(shown, {
      type: 'DisplayChanged',
      projections: [
        { id: wid(1), bounds: proj1 },
        { id: wid(2), bounds: proj2 },
      ],
    });
    const rec1 = after.order.find((w) => w.id === wid(1))!;
    const rec2 = after.order.find((w) => w.id === wid(2))!;
    assert.deepStrictEqual(rec1.bounds, proj1, 'the unblocked sibling reprojects immediately, in the same batch');
    assert.strictEqual(rec1.pendingProjectedBounds, null, 'nothing held for the unblocked window');
    assert.strictEqual(rec2.bounds, undefined, 'the blocked window is not moved');
    assert.deepStrictEqual(rec2.pendingProjectedBounds, proj2, 'held for the still-hidden window — independent of its unblocked sibling');
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

    const pinned = evolve(exited, { type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' });
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
      { type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' },
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

// ── Desktop membership: the platform-neutral follow/anchor intention ────────

describe('window-kernel: desktop membership', () => {
  const registerOne = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
  ];

  it('starts undefined — a window nobody has asked about is not "anchored" by default', () => {
    const state = fold(registerOne(), initialState());
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.desktopMembership, undefined);
  });

  it('SetDesktopMembership round-trips through decide -> evolve -> state for both intentions', () => {
    const state = fold(registerOne(), initialState());

    const followDecision = decide(state, { type: 'SetDesktopMembership', id: wid(1), membership: 'follow', expectedVersion: state.version });
    assert.ok('events' in followDecision);
    assert.deepStrictEqual(followDecision.events, [{ type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' }]);
    const followed = fold(followDecision.events, state);
    assert.strictEqual(followed.order.find((w) => w.id === wid(1))?.desktopMembership, 'follow');

    const anchorDecision = decide(followed, { type: 'SetDesktopMembership', id: wid(1), membership: 'anchor', expectedVersion: followed.version });
    assert.ok('events' in anchorDecision);
    assert.deepStrictEqual(anchorDecision.events, [{ type: 'DesktopMembershipSet', id: wid(1), membership: 'anchor' }]);
    const anchored = fold(anchorDecision.events, followed);
    assert.strictEqual(anchored.order.find((w) => w.id === wid(1))?.desktopMembership, 'anchor');
  });

  it('react emits SetDesktopMembership as a structural diff, carrying no platform flags', () => {
    const state = fold(registerOne(), initialState());
    const followDecision = decide(state, { type: 'SetDesktopMembership', id: wid(1), membership: 'follow', expectedVersion: state.version });
    assert.ok('events' in followDecision);
    const first = foldWithEffects(followDecision.events, state);
    assert.deepStrictEqual(
      first.effects.filter((e) => e.type === 'SetDesktopMembership'),
      [{ type: 'SetDesktopMembership', id: wid(1), membership: 'follow' }],
    );

    // Re-requesting the SAME intention diffs to nothing.
    const reDecision = decide(first.state, { type: 'SetDesktopMembership', id: wid(1), membership: 'follow', expectedVersion: first.state.version });
    assert.ok('events' in reDecision);
    const second = foldWithEffects(reDecision.events, first.state);
    assert.deepStrictEqual(second.effects, [], 'a genuine re-request of the current value diffs to nothing');
  });

  it('SetDesktopMembership against an unregistered window is rejected', () => {
    const state = initialState();
    const decision = decide(state, { type: 'SetDesktopMembership', id: wid(1), membership: 'anchor', expectedVersion: state.version });
    assert.deepStrictEqual(decision, { rejected: 'no-such-window' });
  });
});

// ── Layer: moving an already-open window between the pinned band and base ───

describe('window-kernel: layer', () => {
  const registerOne = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
  ];

  it('SetLayer round-trips through decide -> evolve -> state, both directions', () => {
    const state = fold(registerOne(), initialState());

    const pinDecision = decide(state, { type: 'SetLayer', id: wid(1), layer: 1, expectedVersion: state.version });
    assert.ok('events' in pinDecision);
    assert.deepStrictEqual(pinDecision.events, [{ type: 'WindowLayerChanged', id: wid(1), layer: 1 }]);
    const pinned = fold(pinDecision.events, state);
    assert.strictEqual(pinned.order.find((w) => w.id === wid(1))?.layer, 1);

    const unpinDecision = decide(pinned, { type: 'SetLayer', id: wid(1), layer: 0, expectedVersion: pinned.version });
    assert.ok('events' in unpinDecision);
    assert.deepStrictEqual(unpinDecision.events, [{ type: 'WindowLayerChanged', id: wid(1), layer: 0 }]);
    const unpinned = fold(unpinDecision.events, pinned);
    assert.strictEqual(unpinned.order.find((w) => w.id === wid(1))?.layer, 0);
  });

  it('react emits SetPinned only when the pinned BAND actually changes, never as a raw-value diff', () => {
    const state = fold(registerOne(), initialState());

    const pinDecision = decide(state, { type: 'SetLayer', id: wid(1), layer: 1, expectedVersion: state.version });
    assert.ok('events' in pinDecision);
    const first = foldWithEffects(pinDecision.events, state);
    assert.deepStrictEqual(
      first.effects.filter((e) => e.type === 'SetPinned'),
      [{ type: 'SetPinned', id: wid(1), pinned: true }],
    );

    // A second pinned layer value — still inside the pinned band — diffs to no SetPinned effect.
    const reDecision = decide(first.state, { type: 'SetLayer', id: wid(1), layer: 2, expectedVersion: first.state.version });
    assert.ok('events' in reDecision);
    const second = foldWithEffects(reDecision.events, first.state);
    assert.deepStrictEqual(
      second.effects.filter((e) => e.type === 'SetPinned'),
      [],
      'a layer change that stays inside the pinned band diffs to no SetPinned effect',
    );

    const unpinDecision = decide(second.state, { type: 'SetLayer', id: wid(1), layer: 0, expectedVersion: second.state.version });
    assert.ok('events' in unpinDecision);
    const third = foldWithEffects(unpinDecision.events, second.state);
    assert.deepStrictEqual(
      third.effects.filter((e) => e.type === 'SetPinned'),
      [{ type: 'SetPinned', id: wid(1), pinned: false }],
    );
  });

  it('SetLayer against an unregistered window is rejected', () => {
    const state = initialState();
    const decision = decide(state, { type: 'SetLayer', id: wid(1), layer: 1, expectedVersion: state.version });
    assert.deepStrictEqual(decision, { rejected: 'no-such-window' });
  });
});

// ── Overlay attachment: the shared chrome overlay relation ──────────────────

describe('window-kernel: overlay attachment', () => {
  const registerHostsAndOverlay = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(3), kind: 'browser', layer: 1, canBecomeKey: false, acceptsInput: false, class: 'overlay' },
  ];
  const overlayId = wid(3);
  const hostA = wid(1);
  const hostB = wid(2);

  it('attach, retarget to a different host, and detach all go through the one AttachOverlay/OverlayAttached transition', () => {
    const state = fold(registerHostsAndOverlay(), initialState());

    // Attach to hostA.
    const attachDecision = decide(state, { type: 'AttachOverlay', overlayId, hostId: hostA, expectedVersion: state.version });
    assert.ok('events' in attachDecision);
    assert.deepStrictEqual(attachDecision.events, [{ type: 'OverlayAttached', overlayId, hostId: hostA }]);
    let s = fold(attachDecision.events, state);
    assert.strictEqual(s.order.find((w) => w.id === overlayId)?.overlayFor, hostA);
    assert.strictEqual(overlayForHost(s, hostA)?.id, overlayId);

    // Retarget to hostB — same command shape, no separate "retarget" command.
    const retargetDecision = decide(s, { type: 'AttachOverlay', overlayId, hostId: hostB, expectedVersion: s.version });
    assert.ok('events' in retargetDecision);
    assert.deepStrictEqual(retargetDecision.events, [{ type: 'OverlayAttached', overlayId, hostId: hostB }]);
    s = fold(retargetDecision.events, s);
    assert.strictEqual(s.order.find((w) => w.id === overlayId)?.overlayFor, hostB);
    assert.strictEqual(overlayForHost(s, hostA), null, 'no longer attached to hostA');
    assert.strictEqual(overlayForHost(s, hostB)?.id, overlayId);

    // Detach — hostId: null, same command shape.
    const detachDecision = decide(s, { type: 'AttachOverlay', overlayId, hostId: null, expectedVersion: s.version });
    assert.ok('events' in detachDecision);
    assert.deepStrictEqual(detachDecision.events, [{ type: 'OverlayAttached', overlayId, hostId: null }]);
    s = fold(detachDecision.events, s);
    assert.strictEqual(s.order.find((w) => w.id === overlayId)?.overlayFor, undefined);
    assert.strictEqual(overlayForHost(s, hostB), null);
  });

  it('an attached overlay follows its host to the freshly EXPANDED overlay frame, never the raw host rect; a detached one does not follow at all', () => {
    const registered = fold(registerHostsAndOverlay(), initialState());
    const attached = fold(
      [{ type: 'OverlayAttached', overlayId, hostId: hostA }],
      registered,
    );

    // `overlayFrame` stands in for `expandToOverlayFrame(bounds, workArea)` —
    // deliberately NOT equal to `bounds`, so the assertion below can tell the
    // two apart. The dispatch site (`electron-window-backend.ts emitBounds`)
    // computes it; the kernel only stores what it is given.
    const bounds: Rectangle = { x: 10, y: 20, width: 300, height: 400 };
    const overlayFrame: Rectangle = { x: -8, y: -44, width: 316, height: 452 };
    const boundsEv: Event = { type: 'BoundsChanged', id: hostA, bounds, overlayFrame };
    const nextAttached = evolve(attached, boundsEv);
    const attachedEffects = react(attached, boundsEv, nextAttached);
    assert.ok(
      attachedEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(overlayFrame)),
      'an attached overlay must follow its host to the EXPANDED overlay frame',
    );
    assert.ok(
      !attachedEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(bounds)),
      'the raw host rect must never be handed to the overlay directly — that was the gutter/trigger-zone-losing bug',
    );

    // A BoundsChanged naming no `overlayFrame` — the dispatch site could not
    // read a work area, or this window has no overlay attached — reframes
    // nothing: there is no new frame to follow to.
    const noFrameEv: Event = { type: 'BoundsChanged', id: hostA, bounds };
    const noFrameNext = evolve(attached, noFrameEv);
    const noFrameEffects = react(attached, noFrameEv, noFrameNext);
    assert.ok(
      !noFrameEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId),
      'no overlayFrame on the event means nothing new to reframe to',
    );

    // Detach, then move hostA's bounds again, WITH a frame — still no follow.
    const detached = evolve(attached, { type: 'OverlayAttached', overlayId, hostId: null });
    const bounds2: Rectangle = { x: 1, y: 2, width: 3, height: 4 };
    const overlayFrame2: Rectangle = { x: -7, y: -42, width: 19, height: 46 };
    const boundsEv2: Event = { type: 'BoundsChanged', id: hostA, bounds: bounds2, overlayFrame: overlayFrame2 };
    const nextDetached = evolve(detached, boundsEv2);
    const detachedEffects = react(detached, boundsEv2, nextDetached);
    assert.ok(
      !detachedEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId),
      'a detached overlay must not follow bounds changes even when a frame is given',
    );
  });

  it('closing the host detaches the overlay and drives it off screen', () => {
    const registered = fold(registerHostsAndOverlay(), initialState());
    const attached = fold(
      [{ type: 'OverlayAttached', overlayId, hostId: hostA }, { type: 'WindowShown', id: overlayId }],
      registered,
    );
    assert.strictEqual(attached.order.find((w) => w.id === overlayId)?.visible, true);

    const closeEv: Event = { type: 'WindowClosed', id: hostA };
    const closed = evolve(attached, closeEv);
    const effects = react(attached, closeEv, closed);

    assert.strictEqual(closed.order.find((w) => w.id === overlayId)?.overlayFor, undefined, 'overlay is detached');
    assert.ok(
      effects.some((e) => e.type === 'HideWindow' && e.id === overlayId),
      'the now-detached overlay must be driven off screen',
    );
  });

  it('closing the host also clears a pendingHidden mark the detached overlay itself carried', () => {
    // The overlay singleton can itself be mid-teardown (its own destroy
    // decided, no confirming echo yet) while still attached to a host that
    // closes first. The mechanical detach must not leave the overlay
    // permanently marked doomed, or it would vanish from
    // `isBaseLayerPageHost`/`topmostBaseLayerPageHost` forever — the original
    // overlay-attach defect, inverted onto this field.
    const registered = fold(registerHostsAndOverlay(), initialState());
    const attached = fold(
      [{ type: 'OverlayAttached', overlayId, hostId: hostA }, { type: 'WindowShown', id: overlayId }],
      registered,
    );
    const doomed = evolve(attached, { type: 'WindowDestroyRequested', id: overlayId });
    assert.strictEqual(doomed.order.find((w) => w.id === overlayId)?.pendingHidden, true, 'precondition: the overlay itself is doomed');

    const closeEv: Event = { type: 'WindowClosed', id: hostA };
    const closed = evolve(doomed, closeEv);

    const overlay = closed.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.overlayFor, undefined, 'overlay is detached');
    assert.strictEqual(overlay.pendingHidden, false, 'the doomed mark is cleared along with the detach');
  });

  it('attaching neither writes key nor reorders order', () => {
    const state = fold([...registerHostsAndOverlay(), { type: 'OsFocusGained', id: hostB }], initialState());
    const orderBefore = state.order.map((w) => w.id);
    const keyBefore = state.key;

    const decision = decide(state, { type: 'AttachOverlay', overlayId, hostId: hostA, expectedVersion: state.version });
    assert.ok('events' in decision);
    const attached = fold(decision.events, state);
    assert.deepStrictEqual(attached.order.map((w) => w.id), orderBefore, 'order must be untouched by an attach');
    assert.strictEqual(attached.key, keyBefore, 'key must be untouched by an attach');
  });

  it('decide rejects an attach naming an overlay or a host absent from order', () => {
    const state = fold(registerHostsAndOverlay(), initialState());
    const unknown = wid(99);

    const badOverlay = decide(state, { type: 'AttachOverlay', overlayId: unknown, hostId: hostA, expectedVersion: state.version });
    assert.deepStrictEqual(badOverlay, { rejected: 'no-such-window' });

    const badHost = decide(state, { type: 'AttachOverlay', overlayId, hostId: unknown, expectedVersion: state.version });
    assert.deepStrictEqual(badHost, { rejected: 'no-such-window' });
  });

  it('evolve normalizes an OverlayAttached naming an unregistered or self host into a detach', () => {
    const registered = fold(registerHostsAndOverlay(), initialState());

    const unknown = wid(99);
    const danglingHost = evolve(registered, { type: 'OverlayAttached', overlayId, hostId: unknown });
    assert.strictEqual(
      danglingHost.order.find((w) => w.id === overlayId)?.overlayFor,
      undefined,
      'a hostId absent from order must not be stored',
    );

    const selfHost = evolve(registered, { type: 'OverlayAttached', overlayId, hostId: overlayId });
    assert.strictEqual(
      selfHost.order.find((w) => w.id === overlayId)?.overlayFor,
      undefined,
      'an overlay naming itself as host must not be stored',
    );
  });
});

// A non-normal host always hides its attached overlay; a normal host takes the given frame and
// reveals the overlay while the app is active. The rule reads a host's fsMode/registration facts,
// not its own visibility, so the hosts here are deliberately left unshown.
describe('window-kernel: overlay follow — visibility and frame', () => {
  const registerHostsAndOverlay = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(3), kind: 'browser', layer: 1, canBecomeKey: false, acceptsInput: false, class: 'overlay' },
  ];
  const overlayId = wid(3);
  const hostA = wid(1);
  const hostB = wid(2);
  // Deliberately not equal to any raw host bounds used alongside them, so an assertion can tell
  // the expanded frame apart from the raw host rect.
  const frameA: Rectangle = { x: -8, y: -44, width: 316, height: 452 };
  const frameB: Rectangle = { x: 92, y: 56, width: 336, height: 468 };

  const active = (): State => fold([...registerHostsAndOverlay(), { type: 'AppActivated' }], initialState());

  it('attach shows the overlay when the host is normal and the app is active — the frame lands before the reveal', () => {
    const state = active();
    assert.strictEqual(state.order.find((w) => w.id === overlayId)?.visible, false, 'precondition: not yet shown');

    const ev: Event = { type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.visible, true);
    assert.strictEqual(overlay.overlayFor, hostA);
    assert.deepStrictEqual(overlay.overlayFrame, frameA);
    assert.ok(next.opSeqCounter > state.opSeqCounter, 'a genuine show mints a token');
    assert.strictEqual(overlay.lastOpSeq, next.opSeqCounter);

    const boundsIdx = effects.findIndex(
      (e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(frameA),
    );
    const showIdx = effects.findIndex((e) => e.type === 'ShowWindow' && e.id === overlayId && e.opSeq === next.opSeqCounter);
    assert.notStrictEqual(boundsIdx, -1, 'the overlay is framed');
    assert.notStrictEqual(showIdx, -1, 'the overlay is shown, carrying the op token evolve stamped');
    assert.ok(boundsIdx < showIdx, 'the frame lands before the reveal, so it never paints at a stale rect');
  });

  it('retarget re-frames the ALREADY-visible overlay onto the new host — no second ShowWindow, no new op token', () => {
    const attached = fold([{ type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA }], active());
    assert.strictEqual(attached.order.find((w) => w.id === overlayId)?.visible, true, 'precondition: shown on hostA');

    const ev: Event = { type: 'OverlayAttached', overlayId, hostId: hostB, frame: frameB };
    const next = evolve(attached, ev);
    const effects = react(attached, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.overlayFor, hostB);
    assert.deepStrictEqual(overlay.overlayFrame, frameB);
    assert.strictEqual(overlay.visible, true, 'still shown — a retarget is not a fresh reveal');
    assert.strictEqual(next.opSeqCounter, attached.opSeqCounter, 'no focus-family effect — nothing to stamp a token for');

    assert.ok(
      effects.some((e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(frameB)),
      'the overlay follows onto the new host at its frame',
    );
    assert.ok(!effects.some((e) => e.type === 'ShowWindow' && e.id === overlayId), 'already visible — no re-show');
  });

  it('detach hides the overlay', () => {
    const attached = fold([{ type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA }], active());
    assert.strictEqual(attached.order.find((w) => w.id === overlayId)?.visible, true, 'precondition: shown');

    const ev: Event = { type: 'OverlayAttached', overlayId, hostId: null };
    const next = evolve(attached, ev);
    const effects = react(attached, ev, next);

    assert.strictEqual(next.order.find((w) => w.id === overlayId)?.overlayFor, undefined);
    assert.ok(effects.some((e) => e.type === 'HideWindow' && e.id === overlayId));
  });

  it('a host entering fullscreen hides its attached overlay, without severing the attachment', () => {
    const attached = fold([{ type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA }], active());
    assert.strictEqual(attached.order.find((w) => w.id === overlayId)?.visible, true, 'precondition: shown');

    const ev: Event = { type: 'OsFullscreenEntered', id: hostA };
    const next = evolve(attached, ev);
    const effects = react(attached, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.visible, false);
    assert.strictEqual(overlay.overlayFor, hostA, 'still attached — only visibility moved, the same shape a fullscreen-hidden overlay had before this rule existed');
    assert.ok(effects.some((e) => e.type === 'HideWindow' && e.id === overlayId));
    assert.ok(!effects.some((e) => e.type === 'SetBounds' && e.id === overlayId), 'a fullscreen hide never touches the frame');
    assert.strictEqual(next.opSeqCounter, attached.opSeqCounter, 'a hide is never a focus-family effect');
  });

  it('a host bounds change re-frames its attached, ALREADY-visible overlay — no extra ShowWindow', () => {
    const attached = fold([{ type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA }], active());
    assert.strictEqual(attached.order.find((w) => w.id === overlayId)?.visible, true, 'precondition: shown');

    const movedBounds: Rectangle = { x: 50, y: 60, width: 300, height: 400 };
    const movedFrame: Rectangle = { x: 42, y: 16, width: 316, height: 452 };
    const ev: Event = { type: 'BoundsChanged', id: hostA, bounds: movedBounds, overlayFrame: movedFrame };
    const next = evolve(attached, ev);
    const effects = react(attached, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.deepStrictEqual(overlay.overlayFrame, movedFrame);
    assert.strictEqual(overlay.visible, true, 'still visible — a reframe is not a re-show');
    assert.ok(
      effects.some((e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(movedFrame)),
      'the overlay follows to the freshly expanded frame',
    );
    assert.ok(!effects.some((e) => e.type === 'ShowWindow' && e.id === overlayId), 'already visible — no re-show');
    assert.strictEqual(next.opSeqCounter, attached.opSeqCounter, 'a reframe alone mints no op token');
  });

  it('leaving fullscreen re-reveals the overlay at its LAST frame — no SetBounds, only a ShowWindow carrying a fresh op token', () => {
    const hidden = fold(
      [
        { type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA },
        { type: 'OsFullscreenEntered', id: hostA },
      ],
      active(),
    );
    assert.strictEqual(hidden.order.find((w) => w.id === overlayId)?.visible, false, 'precondition: hidden by fullscreen');

    const ev: Event = { type: 'OsFullscreenLeft', id: hostA };
    const next = evolve(hidden, ev);
    const effects = react(hidden, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.visible, true);
    assert.deepStrictEqual(overlay.overlayFrame, frameA, 'never moved while hidden — the same frame as before the hide');
    assert.ok(next.opSeqCounter > hidden.opSeqCounter, 'a genuine show mints a token');
    assert.strictEqual(overlay.lastOpSeq, next.opSeqCounter);

    assert.ok(
      effects.some((e) => e.type === 'ShowWindow' && e.id === overlayId && e.opSeq === next.opSeqCounter),
      'the overlay is re-shown, carrying the op token evolve stamped',
    );
    assert.ok(!effects.some((e) => e.type === 'SetBounds' && e.id === overlayId), 'no rect write — the overlay was never moved while hidden');
  });

  it('a non-normal host at attach time hides rather than reveals, even though a frame and an active app are both given', () => {
    // The mid-transition case: a retarget landing while the new host is
    // already `entering`/`leaving`/`fullscreen` must not paint chrome over
    // it, regardless of `frame`/`appActive` — ported from
    // `applyOverlayFollow`'s early return before its `SET_BOUNDS` line.
    const midTransition = fold(
      [...registerHostsAndOverlay(), { type: 'AppActivated' }, { type: 'OsFullscreenEntered', id: hostA }],
      initialState(),
    );
    assert.notStrictEqual(midTransition.order.find((w) => w.id === hostA)?.fsMode.name, 'normal', 'precondition: hostA is fullscreen');

    const ev: Event = { type: 'OverlayAttached', overlayId, hostId: hostA, frame: frameA };
    const next = evolve(midTransition, ev);
    const effects = react(midTransition, ev, next);

    const overlay = next.order.find((w) => w.id === overlayId)!;
    assert.strictEqual(overlay.overlayFor, hostA, 'the attachment is still recorded');
    assert.strictEqual(overlay.visible, false);
    assert.strictEqual(overlay.overlayFrame, undefined, 'no frame is stored — the early return never reaches the frame write');
    assert.ok(!effects.some((e) => e.type === 'ShowWindow' && e.id === overlayId));
    assert.ok(!effects.some((e) => e.type === 'SetBounds' && e.id === overlayId));
  });
});

// ── react emits AttachOverlayTo off a diff of the attach target ─────────────

describe('window-kernel: react emits AttachOverlayTo off a diff of the attach target', () => {
  const registerPageHost = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });
  const registerTracker = (id: WindowId, opts: { tracksBaseLayerTop?: boolean } = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'browser',
    layer: BASE_LAYER + 1,
    canBecomeKey: true,
    acceptsInput: false,
    class: 'overlay',
    role: 'overlay',
    tracksBaseLayerTop: opts.tracksBaseLayerTop,
  });
  // Visible and orderable — the two facts topmostBaseLayerPageHost requires.
  const shown = (id: WindowId): Event[] => [
    { type: 'WindowShown', id },
    { type: 'WindowContentOrderable', id },
  ];

  it('the attach target changing emits exactly one AttachOverlayTo naming the tracking record and the NEW host id', () => {
    const hostA = wid(1);
    const hostB = wid(2);
    const overlay = wid(3);
    const state = fold(
      [registerPageHost(hostA), ...shown(hostA), registerPageHost(hostB), ...shown(hostB), registerTracker(overlay, { tracksBaseLayerTop: true })],
      initialState(),
    );
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, hostB, 'precondition: hostB (registered later) is topmost');

    // Hiding hostB is the transition under test — it flips the attach target
    // from hostB to hostA, with the overlay record already present in both
    // `prev` and `next` (so this is the target-diff arm, never the isNew
    // arm — see the dedicated isNew test below).
    const ev: Event = { type: 'WindowHidden', id: hostB };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.strictEqual(topmostBaseLayerPageHost(next)?.id, hostA, 'precondition: the target moved to hostA');

    const attaches = effects.filter((e) => e.type === 'AttachOverlayTo');
    assert.deepStrictEqual(attaches, [{ type: 'AttachOverlayTo', overlayId: overlay, hostId: hostA }]);
  });

  it('a transition that does not change the answer emits none', () => {
    const hostA = wid(1);
    const hostB = wid(2);
    const overlay = wid(3);
    const state = fold(
      [registerPageHost(hostA), ...shown(hostA), registerPageHost(hostB), ...shown(hostB), registerTracker(overlay, { tracksBaseLayerTop: true })],
      initialState(),
    );
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, hostB, 'precondition');

    // hostA's bounds move — hostB stays topmost, so the answer is unchanged.
    const ev: Event = { type: 'BoundsChanged', id: hostA, bounds: { x: 1, y: 2, width: 3, height: 4 } };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.strictEqual(topmostBaseLayerPageHost(next)?.id, hostB, 'precondition: the answer did not move');

    assert.ok(!effects.some((e) => e.type === 'AttachOverlayTo'), 'no AttachOverlayTo when the diff is empty');
  });

  it('the answer going to null emits hostId: null', () => {
    const hostA = wid(1);
    const overlay = wid(2);
    const state = fold([registerPageHost(hostA), ...shown(hostA), registerTracker(overlay, { tracksBaseLayerTop: true })], initialState());
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, hostA, 'precondition');

    const ev: Event = { type: 'WindowHidden', id: hostA };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.strictEqual(topmostBaseLayerPageHost(next), null, 'precondition: the target is now null');

    const attaches = effects.filter((e) => e.type === 'AttachOverlayTo');
    assert.deepStrictEqual(attaches, [{ type: 'AttachOverlayTo', overlayId: overlay, hostId: null }]);
  });

  it('registering a tracksBaseLayerTop record when a host already exists emits the seed attach (the isNew arm)', () => {
    const hostA = wid(1);
    const overlay = wid(2);
    const prev = fold([registerPageHost(hostA), ...shown(hostA)], initialState());
    assert.strictEqual(topmostBaseLayerPageHost(prev)?.id, hostA, 'precondition: a host already exists before the overlay is ever registered');

    const ev = registerTracker(overlay, { tracksBaseLayerTop: true });
    const next = evolve(prev, ev);
    const effects = react(prev, ev, next);

    // Registration also grows `order`, which independently re-triggers the
    // unrelated stacking-replay loop (`orderChanged`) for hostA — filter to
    // this rule's own effect rather than asserting the whole array.
    const attaches = effects.filter((e) => e.type === 'AttachOverlayTo');
    assert.deepStrictEqual(
      attaches,
      [{ type: 'AttachOverlayTo', overlayId: overlay, hostId: hostA }],
      'the seed fires even though the target itself did not move — before this transition there was no such overlay record, after it there is',
    );
  });

  it('a record WITHOUT tracksBaseLayerTop never receives one, and two tracking records both receive one', () => {
    const hostA = wid(1);
    const hostB = wid(2);
    const plain = wid(3);
    const trackerOne = wid(4);
    const trackerTwo = wid(5);
    const state = fold(
      [
        registerPageHost(hostA),
        ...shown(hostA),
        registerPageHost(hostB),
        ...shown(hostB),
        registerTracker(plain), // tracksBaseLayerTop absent
        registerTracker(trackerOne, { tracksBaseLayerTop: true }),
        registerTracker(trackerTwo, { tracksBaseLayerTop: true }),
      ],
      initialState(),
    );
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, hostB, 'precondition');

    const ev: Event = { type: 'WindowHidden', id: hostB };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.strictEqual(topmostBaseLayerPageHost(next)?.id, hostA, 'precondition: the target moved to hostA');

    const attaches = effects.filter((e) => e.type === 'AttachOverlayTo');
    assert.ok(!attaches.some((e) => e.overlayId === plain), 'a record without tracksBaseLayerTop never receives an AttachOverlayTo');
    assert.deepStrictEqual(
      attaches.map((e) => (e as { overlayId: WindowId; hostId: WindowId | null }).overlayId).sort(),
      [trackerOne, trackerTwo].sort(),
      'every tracksBaseLayerTop record gets its own AttachOverlayTo',
    );
    for (const e of attaches) {
      assert.deepStrictEqual(e, { type: 'AttachOverlayTo', overlayId: (e as { overlayId: WindowId }).overlayId, hostId: hostA });
    }
  });

  it('ordering: AttachOverlayTo appears before any SetBounds/ShowWindow in the returned array', () => {
    const hostA = wid(1);
    const overlay = wid(2);
    // hostA is registered+orderable but NOT yet shown, and the tracker exists
    // already — so showing hostA in one transition both flips the attach
    // target (null -> hostA) AND emits hostA's own ShowWindow, in the SAME
    // react call.
    const state = fold(
      [registerPageHost(hostA), { type: 'WindowContentOrderable', id: hostA }, registerTracker(overlay, { tracksBaseLayerTop: true })],
      initialState(),
    );
    assert.strictEqual(topmostBaseLayerPageHost(state), null, 'precondition: hostA is not visible yet');

    const ev: Event = { type: 'WindowShown', id: hostA };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.strictEqual(topmostBaseLayerPageHost(next)?.id, hostA, 'precondition: the target is now hostA');

    const attachIdx = effects.findIndex((e) => e.type === 'AttachOverlayTo');
    const showIdx = effects.findIndex((e) => e.type === 'ShowWindow');
    assert.notStrictEqual(attachIdx, -1, 'precondition: an AttachOverlayTo was emitted');
    assert.notStrictEqual(showIdx, -1, 'precondition: a ShowWindow was emitted');
    assert.ok(attachIdx < showIdx, 'the attach request precedes the reveal it decides the frame for');
  });

  it('the op token is untouched: a transition whose ONLY effect is AttachOverlayTo does not advance opSeqCounter', () => {
    const overlay = wid(1);
    // No host, and no other window at all — the isNew arm still fires
    // (hostId: null, nothing to attach to), and with no pre-existing visible
    // window the unrelated stacking-replay loop has nothing to reinforce, so
    // this really is the one and only effect the transition produces.
    const prev = initialState();

    const ev = registerTracker(overlay, { tracksBaseLayerTop: true });
    const next = evolve(prev, ev);
    const effects = react(prev, ev, next);

    assert.deepStrictEqual(effects, [{ type: 'AttachOverlayTo', overlayId: overlay, hostId: null }], 'precondition: AttachOverlayTo is the only effect');
    assert.strictEqual(next.opSeqCounter, prev.opSeqCounter, 'AttachOverlayTo issues no show/raise and must not stamp opSeq');
  });
});

// ── Focus provenance: cause, and isStaleSelfEcho ────────────────────────────

describe('window-kernel: focus provenance (cause) and isStaleSelfEcho', () => {
  // Both windows are SHOWN: a focus report on a hidden record writes `key`
  // but issues no raise and mints no token (see "a focus report on a HIDDEN
  // window raises nothing"), and every test here is about the token.
  const registerTwo = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowShown', id: wid(1) },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowShown', id: wid(2) },
  ];

  it('an OsFocusGained with no cause behaves exactly as one with { kind: "world" }', () => {
    const state = fold(registerTwo(), initialState());
    const noCause = evolve(state, { type: 'OsFocusGained', id: wid(1) });
    const worldCause = evolve(state, { type: 'OsFocusGained', id: wid(1), cause: { kind: 'world' } });
    assert.deepStrictEqual(noCause, worldCause);
  });

  it('a machine-caused report and a world-caused report move key identically', () => {
    const state = fold(registerTwo(), initialState());
    const machineCause: FocusCause = { kind: 'machine', opSeq: 1 };
    const worldCause: FocusCause = { kind: 'world' };
    const viaMachine = evolve(state, { type: 'OsFocusGained', id: wid(1), cause: machineCause });
    const viaWorld = evolve(state, { type: 'OsFocusGained', id: wid(1), cause: worldCause });
    assert.strictEqual(viaMachine.key, wid(1));
    assert.strictEqual(viaWorld.key, wid(1));
    assert.deepStrictEqual(viaMachine.order.map((w) => w.id), viaWorld.order.map((w) => w.id));
  });

  it('isStaleSelfEcho: true for an opSeq older than lastOpSeq, false for the current one, false for world', () => {
    // Raise wid(1) while wid(2) sits on top, so the raise genuinely moves it,
    // mints a token, and stamps lastOpSeq = that token (= state.opSeqCounter,
    // which the raise itself advanced).
    const state = fold([...registerTwo(), { type: 'OsFocusGained', id: wid(1) }], initialState());
    const rec = state.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(rec.lastOpSeq, state.opSeqCounter);

    assert.strictEqual(isStaleSelfEcho(state, wid(1), { kind: 'machine', opSeq: rec.lastOpSeq! - 1 }), true);
    assert.strictEqual(isStaleSelfEcho(state, wid(1), { kind: 'machine', opSeq: rec.lastOpSeq! }), false);
    assert.strictEqual(isStaleSelfEcho(state, wid(1), { kind: 'world' }), false);
  });

  it('lastOpSeq advances only when a focus-family effect is issued for that window', () => {
    const registered = fold(registerTwo(), initialState());
    // wid(2) takes key first, so the no-op below is the case the raise rule
    // actually excludes: a report re-confirming the window that ALREADY holds
    // key (the echo of the machine's own raise). Position is not what decides
    // it — wid(2) is topmost in both halves of this test.
    const state = evolve(registered, { type: 'OsFocusGained', id: wid(2) });
    const stampedByTheFirstReport = state.order.find((w) => w.id === wid(2))?.lastOpSeq;

    // A second report naming the key holder asserts nothing, so no RaiseWindow
    // effect is emitted and lastOpSeq must not move.
    const noRaiseEv: Event = { type: 'OsFocusGained', id: wid(2) };
    const afterNoRaise = evolve(state, noRaiseEv);
    const noRaiseEffects = react(state, noRaiseEv, afterNoRaise);
    assert.ok(!noRaiseEffects.some((e) => e.type === 'RaiseWindow'), 'no RaiseWindow effect for the window that already holds key');
    assert.strictEqual(afterNoRaise.order.find((w) => w.id === wid(2))?.lastOpSeq, stampedByTheFirstReport);

    // wid(1) taking key genuinely raises it — a RaiseWindow effect is emitted
    // and lastOpSeq must advance.
    const raiseEv: Event = { type: 'OsFocusGained', id: wid(1) };
    const afterRaise = evolve(state, raiseEv);
    const raiseEffects = react(state, raiseEv, afterRaise);
    assert.ok(raiseEffects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)));
    assert.strictEqual(afterRaise.order.find((w) => w.id === wid(1))?.lastOpSeq, afterRaise.opSeqCounter);

    // Showing a hidden-then-shown window: WindowShown on a window that is
    // not visible genuinely flips it and stamps lastOpSeq; a second
    // WindowShown on the now-visible window is a no-op for the effect and
    // must not re-stamp (though the value is unchanged either way here, this
    // proves the guard runs on both edges of the same field).
    const hiddenAgain = evolve(afterRaise, { type: 'WindowHidden', id: wid(1) });
    const shownOnceEv: Event = { type: 'WindowShown', id: wid(1) };
    const shownOnce = evolve(hiddenAgain, shownOnceEv);
    const shownOnceEffects = react(hiddenAgain, shownOnceEv, shownOnce);
    assert.ok(shownOnceEffects.some((e) => e.type === 'ShowWindow' && e.id === wid(1)));
    assert.strictEqual(shownOnce.order.find((w) => w.id === wid(1))?.lastOpSeq, shownOnce.opSeqCounter);

    const shownTwiceEv: Event = { type: 'WindowShown', id: wid(1) };
    const shownTwice = evolve(shownOnce, shownTwiceEv);
    const shownTwiceEffects = react(shownOnce, shownTwiceEv, shownTwice);
    assert.ok(!shownTwiceEffects.some((e) => e.type === 'ShowWindow'), 'an already-visible window re-shown emits no ShowWindow effect');
  });
});

// ── The op counter: what makes one op distinguishable from another ─────────

// opSeqCounter advances exactly on transitions that issue a focus-family op, and evolve's record
// stamp and react's effect token must be the same number as the new counter value.
describe('window-kernel: the op counter advances once per issued op', () => {
  const registerPageHost = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const focusFamily = (effects: Effect[]): Extract<Effect, { opSeq: number }>[] =>
    effects.filter((e): e is Extract<Effect, { opSeq: number }> => e.type === 'ShowWindow' || e.type === 'RaiseWindow');

  function step(state: State, ev: Event): { next: State; effects: Effect[] } {
    const next = evolve(state, ev);
    return { next, effects: react(state, ev, next) };
  }

  // For every focus-family effect react emits, the token on the effect, the counter in next, and
  // the lastOpSeq stamped on the named record must be the same number.
  function assertCoherent(prev: State, next: State, effects: Effect[], label: string): void {
    const stamped = focusFamily(effects);
    assert.strictEqual(
      next.opSeqCounter,
      prev.opSeqCounter + (stamped.length > 0 ? 1 : 0),
      `${label}: the counter advances exactly when an op is issued`,
    );
    for (const effect of stamped) {
      assert.strictEqual(effect.opSeq, next.opSeqCounter, `${label}: react stamps next.opSeqCounter on ${effect.type}`);
      assert.strictEqual(
        next.order.find((w) => w.id === effect.id)?.lastOpSeq,
        next.opSeqCounter,
        `${label}: evolve's record stamp equals react's effect token for ${effect.id}`,
      );
    }
  }

  it('a genuine show and a genuine raise each mint a fresh token; nothing else moves the counter', () => {
    let state = fold([registerPageHost(wid(1)), registerPageHost(wid(2))]);
    assert.strictEqual(state.opSeqCounter, 0, 'registration issues no op');

    const shown = step(state, { type: 'WindowShown', id: wid(1) });
    assertCoherent(state, shown.next, shown.effects, 'first show');
    assert.strictEqual(shown.next.opSeqCounter, 1);
    state = shown.next;

    const reshown = step(state, { type: 'WindowShown', id: wid(1) });
    assertCoherent(state, reshown.next, reshown.effects, 're-show of a visible window');
    assert.strictEqual(reshown.next.opSeqCounter, 1, 'an already-visible window re-shown issues nothing');
    state = reshown.next;

    const raised = step(state, { type: 'OsFocusGained', id: wid(1) });
    assertCoherent(state, raised.next, raised.effects, 'raise');
    assert.strictEqual(raised.next.opSeqCounter, 2);
    state = raised.next;

    const refocused = step(state, { type: 'OsFocusGained', id: wid(1) });
    assertCoherent(state, refocused.next, refocused.effects, 'focus report on the topmost window');
    assert.strictEqual(refocused.next.opSeqCounter, 2, 'a window already on top moves nothing, so no op is issued');
    state = refocused.next;

    // A sample of the transitions that are not focus-family ops at all.
    for (const ev of [
      { type: 'WindowHidden', id: wid(1) } as Event,
      { type: 'BoundsChanged', id: wid(2), bounds: { x: 1, y: 2, width: 3, height: 4 } } as Event,
      { type: 'WindowContentOrderable', id: wid(2) } as Event,
      { type: 'OsFocusLost', id: wid(1) } as Event,
      { type: 'AppResigned' } as Event,
      { type: 'WindowClosed', id: wid(2) } as Event,
    ]) {
      const after = step(state, ev);
      assertCoherent(state, after.next, after.effects, `${ev.type}`);
      assert.strictEqual(after.next.opSeqCounter, 2, `${ev.type} issues no focus-family op`);
      state = after.next;
    }
  });

  it('two ops for the same window carry DIFFERENT tokens — which is what makes the earlier one stale', () => {
    // The whole point of the counter. Every event here is ordinary traffic;
    // no token is written by hand.
    let state = fold([
      registerPageHost(wid(1)),
      registerPageHost(wid(2)),
      { type: 'WindowShown', id: wid(1) },
      { type: 'WindowShown', id: wid(2) },
    ]);

    state = evolve(state, { type: 'OsFocusGained', id: wid(1) });
    const firstRaiseToken = state.order.find((w) => w.id === wid(1))!.lastOpSeq!;
    state = evolve(state, { type: 'OsFocusGained', id: wid(2) });
    state = evolve(state, { type: 'OsFocusGained', id: wid(1) });
    const secondRaiseToken = state.order.find((w) => w.id === wid(1))!.lastOpSeq!;

    assert.ok(secondRaiseToken > firstRaiseToken, 'a second op for the same window must not reuse the first op\'s token');
    assert.strictEqual(isStaleSelfEcho(state, wid(1), { kind: 'machine', opSeq: firstRaiseToken }), true);
    assert.strictEqual(isStaleSelfEcho(state, wid(1), { kind: 'machine', opSeq: secondRaiseToken }), false);
  });

  it('an AppActivated re-show issues ONE op, and stamps every window it puts back on screen', () => {
    // The third arm that issues focus-family effects: the resign sweep's undo.
    // `react` emits one ShowWindow per re-shown window, all carrying the same
    // token, so all of them must be stamped with it.
    const hud = (id: WindowId): Event => ({
      type: 'WindowRegistered',
      id,
      kind: 'page-host',
      layer: BASE_LAYER + 1,
      canBecomeKey: false,
      acceptsInput: true,
      class: 'hud',
    });
    const before = fold([
      hud(wid(1)),
      hud(wid(2)),
      { type: 'WindowShown', id: wid(1) },
      { type: 'WindowShown', id: wid(2) },
      { type: 'AppResigned' },
      { type: 'AppResignSettled' },
    ]);
    assert.deepStrictEqual(before.order.map((w) => w.visible), [false, false], 'the sweep hid both');

    const activated = step(before, { type: 'AppActivated' });
    assert.strictEqual(focusFamily(activated.effects).length, 2, 'one ShowWindow per re-shown window');
    assertCoherent(before, activated.next, activated.effects, 'AppActivated re-show');
    assert.strictEqual(activated.next.opSeqCounter, before.opSeqCounter + 1, 'one op, not one per window');

    // A second activation re-shows nothing, so it issues nothing.
    const again = step(activated.next, { type: 'AppActivated' });
    assert.deepStrictEqual(again.effects, []);
    assert.strictEqual(again.next.opSeqCounter, activated.next.opSeqCounter);
  });
});

// ── App activation, resignation, and the macOS activation dance ────────────

describe('window-kernel: app activation, resignation, and the dance guard', () => {
  const registerPrimaryAndHud = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 1, canBecomeKey: false, acceptsInput: true, class: 'hud' },
    { type: 'WindowShown', id: wid(1) },
    { type: 'WindowShown', id: wid(2) },
    { type: 'OsFocusGained', id: wid(1) },
  ];

  it('resign then activate with no settle in between (the dance case) flickers the HUD but leaves it visible again', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    const resigned = evolve(before, { type: 'AppResigned' });
    assert.strictEqual(resigned.pendingAppResignSweep, true);
    // The HUD hides on the raw edge — it is reversible visibility, not a
    // destructive dismissal, so unlike a transient it does not wait for the
    // settle to find out whether this resign is real or the dance cancels it.
    assert.strictEqual(resigned.order.find((w) => w.id === wid(2))?.visible, false);
    assert.strictEqual(resigned.order.find((w) => w.id === wid(2))?.hiddenByAppBlur, true);
    // The key-holding window is never sweep-eligible — untouched going in.
    assert.strictEqual(resigned.order.find((w) => w.id === wid(1))?.visible, true);

    const activated = evolve(resigned, { type: 'AppActivated' });

    assert.strictEqual(activated.pendingAppResignSweep, false);
    assert.strictEqual(activated.appActive, true);
    // The dance reverses the hide: both windows end up exactly as visible as
    // they started. Only the HUD ever carried the mark, so only its mark is
    // cleared — the primary window's stays absent, never having been set.
    assert.strictEqual(activated.order.find((w) => w.id === wid(1))?.hiddenByAppBlur, undefined);
    assert.strictEqual(activated.order.find((w) => w.id === wid(2))?.hiddenByAppBlur, false);
    assert.strictEqual(activated.order.find((w) => w.id === wid(1))?.visible, true);
    assert.strictEqual(activated.order.find((w) => w.id === wid(2))?.visible, true);
  });

  it('the sweep-eligible (non-key-holding) window is still hidden and marked once resign and settle have both run', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    const resigned = evolve(before, { type: 'AppResigned' });
    // The raw edge already did the hiding — settle is a backstop here, not
    // the primary mechanism (see `evolve`'s `AppResigned`/`AppResignSettled`
    // arms).
    assert.strictEqual(resigned.order.find((w) => w.id === wid(2))?.visible, false);
    const settled = evolve(resigned, { type: 'AppResignSettled' });

    assert.strictEqual(settled.pendingAppResignSweep, false);
    const hud = settled.order.find((w) => w.id === wid(2))!;
    assert.strictEqual(hud.visible, false);
    assert.strictEqual(hud.hiddenByAppBlur, true);
    // The key-holding, canBecomeKey window is not sweep-eligible — untouched.
    const primary = settled.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(primary.visible, true);
    assert.strictEqual(primary.hiddenByAppBlur, undefined);
  });

  it('a later activation re-shows exactly the windows the sweep hid and clears the mark, leaving other-cause hides alone', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    // A third window, hidden for an unrelated reason (a plain WindowHidden) —
    // must never be re-shown by the activation below.
    const withThird = evolve(before, {
      type: 'WindowRegistered',
      id: wid(3),
      kind: 'page-host',
      layer: 1,
      canBecomeKey: false,
      acceptsInput: false,
      class: 'hud',
    });
    const thirdShown = evolve(withThird, { type: 'WindowShown', id: wid(3) });
    const thirdHiddenPlain = evolve(thirdShown, { type: 'WindowHidden', id: wid(3) });

    const resigned = evolve(thirdHiddenPlain, { type: 'AppResigned' });
    const settled = evolve(resigned, { type: 'AppResignSettled' });
    // wid(3) was already hidden (for another reason) before the sweep — the
    // sweep predicate only touches visible windows, so it stays untouched.
    assert.strictEqual(settled.order.find((w) => w.id === wid(3))?.hiddenByAppBlur, undefined);

    const activated = evolve(settled, { type: 'AppActivated' });
    const hud = activated.order.find((w) => w.id === wid(2))!;
    assert.strictEqual(hud.visible, true);
    assert.strictEqual(hud.hiddenByAppBlur, false);
    // The other-cause hide is left alone — still hidden, still unmarked.
    const third = activated.order.find((w) => w.id === wid(3))!;
    assert.strictEqual(third.visible, false);
    assert.strictEqual(third.hiddenByAppBlur, undefined);
  });

  it('a plain WindowShown (not AppActivated) on a swept window clears the stale hiddenByAppBlur mark', () => {
    // A non-key-holding, non-transient, above-base-layer window is swept on app resign, then
    // re-shown by an ordinary WindowShown (not the AppActivated re-show path) — the sweep mark
    // must not survive on a now-visible record ("it can never be true on a window that is
    // currently visible").
    const before = fold(
      [
        {
          type: 'WindowRegistered',
          id: wid(4),
          kind: 'page-host',
          layer: 2,
          canBecomeKey: false,
          acceptsInput: true,
          class: 'child',
          role: 'child-content',
        },
        { type: 'WindowShown', id: wid(4) },
      ],
      initialState(),
    );
    const resigned = evolve(before, { type: 'AppResigned' });
    const settled = evolve(resigned, { type: 'AppResignSettled' });
    // The sweep actually fired — confirm eligibility caught it, or the rest
    // of this test would pass vacuously.
    const swept = settled.order.find((w) => w.id === wid(4))!;
    assert.strictEqual(swept.visible, false);
    assert.strictEqual(swept.hiddenByAppBlur, true);

    const reshown = evolve(settled, { type: 'WindowShown', id: wid(4) });
    const record = reshown.order.find((w) => w.id === wid(4))!;
    assert.strictEqual(record.visible, true);
    assert.strictEqual(record.hiddenByAppBlur, false);
  });

  it('AppActivated does not re-show a window a teardown has since marked pendingHidden', () => {
    // The hud-shaped window is swept hidden by an app resign, and while it
    // sits off screen a teardown is decided for it before the OS has
    // confirmed anything. The next activation must not resurrect a window
    // the machine has already committed to tearing down onto the screen.
    const before = fold(registerPrimaryAndHud(), initialState());
    const resigned = evolve(before, { type: 'AppResigned' });
    const settled = evolve(resigned, { type: 'AppResignSettled' });
    const swept = settled.order.find((w) => w.id === wid(2))!;
    assert.strictEqual(swept.visible, false, 'precondition: the sweep hid it');
    assert.strictEqual(swept.hiddenByAppBlur, true, 'precondition: hidden by the app-blur sweep');

    const doomed = evolve(settled, { type: 'WindowContentCloseRequested', id: wid(2) });
    assert.strictEqual(doomed.order.find((w) => w.id === wid(2))?.pendingHidden, true, 'precondition: a teardown has now been decided');

    const activated = evolve(doomed, { type: 'AppActivated' });
    const record = activated.order.find((w) => w.id === wid(2))!;
    assert.strictEqual(record.visible, false, 'a doomed window must not be resurrected onto the screen by an app activation');
    assert.strictEqual(record.hiddenByAppBlur, true, 'the mark is left set — nothing has happened to make the hide untrue');
  });

  it('AppResignSettled arriving when not armed is inert', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    // Never resigned — pendingAppResignSweep is false from initialState().
    assert.strictEqual(before.pendingAppResignSweep, false);
    const settled = evolve(before, { type: 'AppResignSettled' });

    assert.strictEqual(settled.pendingAppResignSweep, false);
    assert.deepStrictEqual(settled.order.map((w) => ({ id: w.id, visible: w.visible })), before.order.map((w) => ({ id: w.id, visible: w.visible })));
    assert.strictEqual(settled.version, before.version + 1, 'still bumps version — an event, not a rejection');
  });

  it('none of AppResigned/AppActivated/AppResignSettled writes key or reorders order', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    const idOrder = (s: State) => s.order.map((w) => w.id);

    for (const ev of [{ type: 'AppResigned' as const }, { type: 'AppActivated' as const }, { type: 'AppResignSettled' as const }]) {
      const next = evolve(before, ev);
      assert.strictEqual(next.key, before.key, `${ev.type} must not write key`);
      assert.deepStrictEqual(idOrder(next), idOrder(before), `${ev.type} must not reorder order`);
    }

    // Also across the full dance sequence.
    const resigned = evolve(before, { type: 'AppResigned' });
    const settled = evolve(resigned, { type: 'AppResignSettled' });
    const activated = evolve(settled, { type: 'AppActivated' });
    assert.strictEqual(activated.key, before.key);
    assert.deepStrictEqual(idOrder(activated), idOrder(before));
  });
});

// ── The app-resign sweep predicate ──────────────────────────────────────────

// Every window below is registered with the facts its real construction site produces, so a
// predicate that matches nothing in production fails here rather than passing vacuously.
describe('window-kernel: which windows a real app resign hides', () => {
  const FLOATING = BASE_LAYER + 1;

  const workspace = wid(1);
  // renderer/hud/background.js: alwaysOnTop:true, focusable:false, no role.
  const hud = wid(2);
  // features/spaces/background.js: always-on-top like the HUD, but acceptsInput:false
  // (click-through) — the one clause that keeps it out of the sweep.
  const spaceBorder = wid(3);
  // test-fixture-glue.ts: focusable:false, and not floating.
  const testFixture = wid(4);
  // renderer/cmd/background.js: floats, focusable, modal:true — self-closes on blur, its own policy.
  const cmdPanel = wid(5);
  // inferIzuiRole only ever derives this role from modal:true, so it self-closes on blur too —
  // same policy as the cmd panel, never the app-resign sweep's business.
  const quickView = wid(6);
  const alreadyHiddenHud = wid(7);
  // renderer/windows/background.js openWindowsView: maximized, always-on-top, role:'switcher',
  // canBecomeKey:true (typing filters the list), no modal.
  const switcher = wid(8);

  const scene = (): State =>
    fold([
      { type: 'WindowRegistered', id: workspace, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowRegistered', id: hud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' },
      { type: 'WindowRegistered', id: spaceBorder, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'WindowRegistered', id: testFixture, kind: 'browser', layer: BASE_LAYER, canBecomeKey: false, acceptsInput: true, class: 'test-fixture', role: 'utility' },
      { type: 'WindowRegistered', id: cmdPanel, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette', selfClosesOnBlur: true },
      { type: 'WindowRegistered', id: quickView, kind: 'page-host', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'quick-view', role: 'quick-view', selfClosesOnBlur: true },
      { type: 'WindowRegistered', id: alreadyHiddenHud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' },
      { type: 'WindowRegistered', id: switcher, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'overlay', role: 'switcher' },
      // workspace takes key before any floater/transient below is shown, or a switcher shown
      // first would already be a visible transient losing focus to workspace — dismissed by
      // this setup event before the resign scenario below gets to exercise it.
      { type: 'WindowShown', id: workspace },
      { type: 'OsFocusGained', id: workspace },
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: spaceBorder },
      { type: 'WindowShown', id: testFixture },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: quickView },
      { type: 'WindowShown', id: switcher },
    ]);

  const sweptBy = (state: State): WindowId[] =>
    state.order.filter((w) => w.hiddenByAppBlur === true).map((w) => w.id);

  it('the sweep takes only the HUD; the switcher is a dismissal victim of the same resign rather than a sweep target, and the click-through space border is spared', () => {
    const settled = evolve(evolve(scene(), { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const swept = sweptBy(settled);

    assert.ok(swept.length > 0, 'a real app resign must hide something — a sweep that matches nothing is the bug');
    assert.deepStrictEqual(swept, [hud]);
    assert.strictEqual(settled.order.find((w) => w.id === hud)?.visible, false);

    // The switcher is excluded from this reversible hide, since a transient loses focus on any
    // app resign under the uniform dismissal law, and dismissal is not reversible.
    assert.strictEqual(settled.order.find((w) => w.id === switcher)?.hiddenByAppBlur, undefined);
    assert.strictEqual(settled.order.find((w) => w.id === switcher)?.visible, true);

    for (const id of [workspace, testFixture, cmdPanel, quickView, spaceBorder]) {
      assert.strictEqual(settled.order.find((w) => w.id === id)?.visible, true, `${id} must not be hidden by the resign sweep`);
    }
    assert.strictEqual(settled.order.find((w) => w.id === alreadyHiddenHud)?.hiddenByAppBlur, undefined);
  });

  it('the HUD hides on the RAW resign edge, before any settle; the switcher stays visible there — it is a dismissal victim, not a hide, and dismissal has no raw-edge half', () => {
    // Every eligible floater hides on the raw edge, not just at settle — otherwise it would sit
    // over whatever app the user just switched to for the whole of the settle delay.
    const resigned = evolve(scene(), { type: 'AppResigned' });
    const swept = sweptBy(resigned);

    assert.deepStrictEqual(swept, [hud]);
    assert.strictEqual(resigned.order.find((w) => w.id === hud)?.visible, false);
    assert.strictEqual(resigned.order.find((w) => w.id === hud)?.hiddenByAppBlur, true);

    // The switcher is left untouched until the settle names it on a DismissWindow effect — a raw
    // edge that hid it here would read back !visible and be mistaken for already dismissed.
    assert.strictEqual(resigned.order.find((w) => w.id === switcher)?.visible, true);
    assert.strictEqual(resigned.order.find((w) => w.id === switcher)?.hiddenByAppBlur, undefined);

    for (const id of [workspace, testFixture, cmdPanel, quickView, spaceBorder]) {
      assert.strictEqual(resigned.order.find((w) => w.id === id)?.visible, true, `${id} must not be hidden by the raw-edge hide`);
    }
  });

  it('the switcher is admitted, a self-closing palette is not, the space border is NOT admitted, and a base-layer window is not', () => {
    const state = scene();
    const rec = (id: WindowId) => state.order.find((w) => w.id === id)!;

    assert.strictEqual(isAppResignSweepEligible(rec(switcher)), true, 'floats, accepts input, does not self-close — admitted');
    assert.strictEqual(isAppResignSweepEligible(rec(cmdPanel)), false, 'floats, but already self-closes on blur — its own policy');
    assert.strictEqual(isAppResignSweepEligible(rec(quickView)), false, 'floats, but already self-closes on blur — its own policy');
    assert.strictEqual(isAppResignSweepEligible(rec(spaceBorder)), false, 'click-through — never admitted, matches its documented purpose');
    assert.strictEqual(isAppResignSweepEligible(rec(testFixture)), false, 'does not float — a base-layer window is never eligible');
    assert.strictEqual(isAppResignSweepEligible(rec(workspace)), false, 'does not float');
    assert.strictEqual(isAppResignSweepEligible(rec(hud)), true, 'floats, accepts input, does not self-close — admitted');
    assert.strictEqual(isAppResignSweepEligible(rec(alreadyHiddenHud)), false, 'already hidden, for a reason of its own');
  });

  it('the following activation re-shows exactly the window the sweep hid — the HUD; the switcher was never hidden by it and carries no mark to clear', () => {
    const settled = evolve(evolve(scene(), { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const activated = evolve(settled, { type: 'AppActivated' });

    assert.strictEqual(activated.order.find((w) => w.id === hud)?.visible, true, 'hud must re-show');
    assert.strictEqual(activated.order.find((w) => w.id === hud)?.hiddenByAppBlur, false, 'hud must have its mark cleared');

    // The switcher was a dismissal victim, not a reversible hide, so it carries no mark to clear.
    assert.strictEqual(activated.order.find((w) => w.id === switcher)?.visible, true);
    assert.strictEqual(activated.order.find((w) => w.id === switcher)?.hiddenByAppBlur, undefined);

    assert.strictEqual(activated.order.find((w) => w.id === alreadyHiddenHud)?.visible, false);
    assert.strictEqual(activated.order.find((w) => w.id === spaceBorder)?.hiddenByAppBlur, undefined);
    assert.deepStrictEqual(sweptBy(activated), []);
  });

  it('the raw resign edge emits a HideWindow effect for the HUD only; the settle names the switcher on a DismissWindow effect instead', () => {
    const before = scene();
    const resignEv: Event = { type: 'AppResigned' };
    const resigned = evolve(before, resignEv);
    const resignEffects = react(before, resignEv, resigned);

    assert.deepStrictEqual(
      resignEffects.filter((e) => e.type === 'HideWindow').map((e) => e.id),
      [hud],
    );
    assert.deepStrictEqual(
      resignEffects.filter((e) => e.type === 'DismissWindow'),
      [],
    );

    // The switcher is still visible at settle time, so react's resign-sweep rule fires and
    // names it on a DismissWindow effect there instead.
    const settleEv: Event = { type: 'AppResignSettled' };
    const settled = evolve(resigned, settleEv);
    const settleEffects = react(resigned, settleEv, settled);
    assert.deepStrictEqual(
      settleEffects.filter((e) => e.type === 'HideWindow'),
      [],
    );
    assert.ok(
      settleEffects.some((e) => e.type === 'DismissWindow' && e.id === switcher),
      'the switcher is named on a DismissWindow effect at the settle',
    );
  });
});

// ── AppResigned hiding an attached overlay, and AppActivated's conditional re-show ──────────

describe('window-kernel: AppResigned hides an attached overlay on the raw edge; AppActivated reveals it only when its host admits', () => {
  const FLOATING = BASE_LAYER + 1;

  const host = wid(1);
  const overlay = wid(2);
  const other = wid(3);
  const detachedOverlay = wid(4);

  const attachedVisibleScene = (): State =>
    fold(
      [
        { type: 'WindowRegistered', id: host, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowRegistered', id: overlay, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: false, class: 'overlay' },
        { type: 'WindowRegistered', id: other, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: host },
        { type: 'WindowShown', id: other },
        { type: 'OverlayAttached', overlayId: overlay, hostId: host },
        { type: 'WindowShown', id: overlay },
        { type: 'OsFocusGained', id: host },
      ],
      initialState(),
    );

  it('an attached, visible overlay is hidden and marked by AppResigned, and react projects a HideWindow effect for it', () => {
    const state = attachedVisibleScene();
    assert.strictEqual(state.order.find((w) => w.id === overlay)?.visible, true, 'precondition: overlay is genuinely shown');

    const ev: Event = { type: 'AppResigned' };
    const resigned = evolve(state, ev);
    const effects = react(state, ev, resigned);

    const overlayAfter = resigned.order.find((w) => w.id === overlay)!;
    assert.strictEqual(overlayAfter.visible, false);
    assert.strictEqual(overlayAfter.hiddenByAppBlur, true);
    assert.ok(effects.some((e) => e.type === 'HideWindow' && e.id === overlay));
  });

  it("the overlay's host is not hidden by the same transition, and neither is an ordinary visible window with no overlayFor", () => {
    const state = attachedVisibleScene();
    assert.strictEqual(state.order.find((w) => w.id === host)?.visible, true, 'precondition');
    assert.strictEqual(state.order.find((w) => w.id === other)?.visible, true, 'precondition');

    const resigned = evolve(state, { type: 'AppResigned' });

    const hostAfter = resigned.order.find((w) => w.id === host)!;
    assert.strictEqual(hostAfter.visible, true);
    assert.strictEqual(hostAfter.hiddenByAppBlur, undefined);

    const otherAfter = resigned.order.find((w) => w.id === other)!;
    assert.strictEqual(otherAfter.visible, true);
    assert.strictEqual(otherAfter.hiddenByAppBlur, undefined);
  });

  it('an overlay already visible: false at resign time is left completely untouched — it does not acquire hiddenByAppBlur', () => {
    const state = attachedVisibleScene();
    const hiddenFirst = evolve(state, { type: 'WindowHidden', id: overlay });
    const overlayBefore = hiddenFirst.order.find((w) => w.id === overlay)!;
    assert.strictEqual(overlayBefore.visible, false, 'precondition: overlay is off screen ahead of the resign');
    assert.strictEqual(overlayBefore.hiddenByAppBlur, undefined);

    const resigned = evolve(hiddenFirst, { type: 'AppResigned' });
    const overlayAfter = resigned.order.find((w) => w.id === overlay)!;
    // Same reference, not just the same fields: the record was never touched
    // by the map, which is what keeps a fullscreen host's already-hidden
    // chrome from being revealed by the next activation.
    assert.strictEqual(overlayAfter, overlayBefore);
  });

  it('an unattached floating window that cannot take keys still hides — attachment is not the only admission', () => {
    // Above the base layer, cannot take keystrokes, accepts input — structurally a HUD, and
    // isAppResignSweepEligible admits it on exactly those facts, unattached or not.
    const state = fold(
      [
        { type: 'WindowRegistered', id: detachedOverlay, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'overlay' },
        { type: 'WindowShown', id: detachedOverlay },
      ],
      initialState(),
    );
    const before = state.order.find((w) => w.id === detachedOverlay)!;
    assert.strictEqual(before.visible, true, 'precondition');
    assert.strictEqual(before.overlayFor, undefined, 'precondition: genuinely unattached');

    const resigned = evolve(state, { type: 'AppResigned' });
    const after = resigned.order.find((w) => w.id === detachedOverlay)!;
    assert.strictEqual(after.visible, false, 'hidden on the raw edge, via the sweep predicate rather than attachment');
    assert.strictEqual(after.hiddenByAppBlur, true, 'marked so the next activation can reveal it again');
  });

  it('AppResigned writes no key change and mints no op token, even when it hides an overlay', () => {
    const state = attachedVisibleScene();
    assert.strictEqual(state.order.find((w) => w.id === overlay)?.visible, true, 'precondition');
    const keyBefore = state.key;
    const opBefore = state.opSeqCounter;

    const resigned = evolve(state, { type: 'AppResigned' });
    assert.ok(resigned.order.some((w) => w.hiddenByAppBlur === true), 'sanity: the overlay really was hidden by this transition');
    assert.strictEqual(resigned.key, keyBefore);
    assert.strictEqual(resigned.opSeqCounter, opBefore);
  });

  it('round trip: AppResigned then AppActivated restores the overlay to visible with the mark cleared, and react projects a ShowWindow carrying the op token', () => {
    const state = attachedVisibleScene();
    assert.strictEqual(state.order.find((w) => w.id === overlay)?.visible, true, 'precondition');

    const resigned = evolve(state, { type: 'AppResigned' });
    assert.strictEqual(resigned.order.find((w) => w.id === overlay)?.visible, false, 'sanity: the resign actually hid it');

    const activateEv: Event = { type: 'AppActivated' };
    const activated = evolve(resigned, activateEv);
    const effects = react(resigned, activateEv, activated);

    const overlayAfter = activated.order.find((w) => w.id === overlay)!;
    assert.strictEqual(overlayAfter.visible, true);
    assert.strictEqual(overlayAfter.hiddenByAppBlur, false);
    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'ShowWindow'),
      [{ type: 'ShowWindow', id: overlay, opSeq: activated.opSeqCounter }],
    );
  });

  it('the fullscreen refusal: a host that is fullscreen at AppActivated time keeps its overlay hidden and marked, and emits no ShowWindow for it', () => {
    const state = attachedVisibleScene();
    const resigned = evolve(state, { type: 'AppResigned' });
    assert.strictEqual(resigned.order.find((w) => w.id === overlay)?.visible, false, 'sanity: the overlay is hidden going in');

    const hostFullscreen = evolve(resigned, { type: 'OsFullscreenEntered', id: host });
    const hostRec = hostFullscreen.order.find((w) => w.id === host)!;
    assert.deepStrictEqual(hostRec.fsMode, { name: 'fullscreen', preBounds: null }, 'precondition: host is genuinely fullscreen');
    assert.strictEqual(hostRec.visible, true, 'precondition: the host itself is still on screen, only its mode changed');

    const activateEv: Event = { type: 'AppActivated' };
    const activated = evolve(hostFullscreen, activateEv);
    const effects = react(hostFullscreen, activateEv, activated);

    const overlayAfter = activated.order.find((w) => w.id === overlay)!;
    assert.strictEqual(overlayAfter.visible, false, 'refused — not re-shown');
    assert.strictEqual(overlayAfter.hiddenByAppBlur, true, 'the mark survives a refusal, it is not cleared');
    assert.ok(!effects.some((e) => e.type === 'ShowWindow' && e.id === overlay));
  });

  it('the off-screen-host refusal: a host that is hidden at AppActivated time keeps its overlay hidden and marked, and emits no ShowWindow for it', () => {
    const state = attachedVisibleScene();
    const resigned = evolve(state, { type: 'AppResigned' });
    const hostHidden = evolve(resigned, { type: 'WindowHidden', id: host });
    assert.strictEqual(hostHidden.order.find((w) => w.id === host)?.visible, false, 'precondition: the host itself is off screen');

    const activateEv: Event = { type: 'AppActivated' };
    const activated = evolve(hostHidden, activateEv);
    const effects = react(hostHidden, activateEv, activated);

    const overlayAfter = activated.order.find((w) => w.id === overlay)!;
    assert.strictEqual(overlayAfter.visible, false);
    assert.strictEqual(overlayAfter.hiddenByAppBlur, true);
    assert.ok(!effects.some((e) => e.type === 'ShowWindow' && e.id === overlay));
  });

  it('the self-heal: after a refused re-show, a genuine WindowShown for the overlay clears hiddenByAppBlur (the WindowShown arm already does this — pinned here in the overlay-refusal context)', () => {
    const state = attachedVisibleScene();
    const resigned = evolve(state, { type: 'AppResigned' });
    const hostHidden = evolve(resigned, { type: 'WindowHidden', id: host });
    const activated = evolve(hostHidden, { type: 'AppActivated' });
    const refused = activated.order.find((w) => w.id === overlay)!;
    assert.strictEqual(refused.visible, false, 'sanity: still refused going in');
    assert.strictEqual(refused.hiddenByAppBlur, true, 'sanity: mark still set going in');

    const shown = evolve(activated, { type: 'WindowShown', id: overlay });
    const healed = shown.order.find((w) => w.id === overlay)!;
    assert.strictEqual(healed.visible, true);
    assert.strictEqual(healed.hiddenByAppBlur, false);
  });

  it('the dance: AppResigned immediately followed by AppActivated with no settle in between leaves the overlay visible again and pendingAppResignSweep false', () => {
    const state = attachedVisibleScene();
    assert.strictEqual(state.order.find((w) => w.id === overlay)?.visible, true, 'precondition');

    const resigned = evolve(state, { type: 'AppResigned' });
    assert.strictEqual(resigned.pendingAppResignSweep, true, 'sanity: armed');
    const activated = evolve(resigned, { type: 'AppActivated' });

    assert.strictEqual(activated.order.find((w) => w.id === overlay)?.visible, true);
    assert.strictEqual(activated.order.find((w) => w.id === overlay)?.hiddenByAppBlur, false);
    assert.strictEqual(activated.pendingAppResignSweep, false);
  });
});

// ── Transient autoclose (the two selectors) ─────────────────────────────────

describe('window-kernel: transient autoclose', () => {
  const reg = (n: number, role: string | undefined, kind: 'page-host' | 'browser' = 'page-host'): Event => ({
    type: 'WindowRegistered',
    id: wid(n),
    kind,
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    ...(role !== undefined ? { role } : {}),
  });
  const show = (n: number): Event => ({ type: 'WindowShown', id: wid(n) });
  // A page-host is registered orderable: false and is not a transient-autoclose candidate until
  // this first-composited-frame report lands.
  const orderable = (n: number): Event => ({ type: 'WindowContentOrderable', id: wid(n) });

  // wid(1) workspace, wid(2) palette, wid(3) quick-view, wid(4) overlay, wid(5) utility,
  // wid(6) roleless, wid(7) a hidden palette.
  const scene = (): State =>
    fold(
      [
        reg(1, 'workspace'),
        reg(2, 'palette'),
        reg(3, 'quick-view'),
        reg(4, 'overlay'),
        reg(5, 'utility'),
        reg(6, undefined),
        reg(7, 'palette'),
        orderable(1),
        orderable(2),
        orderable(3),
        orderable(4),
        orderable(5),
        orderable(6),
        orderable(7),
        show(1),
        show(2),
        show(3),
        show(4),
        show(5),
        show(6),
      ],
      initialState(),
    );

  it('a world-caused focus sweeps every visible transient but the focuser and the hidden — an unattached overlay is no longer role-exempt', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1), { kind: 'world' }), [wid(2), wid(3), wid(4)]);
  });

  it('the default cause is world', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1)), selectTransientAutoclose(state, wid(1), { kind: 'world' }));
  });

  it('the focuser is never its own victim', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'world' }), [wid(3), wid(4)]);
  });

  it('an unattached utility or overlay focuser sweeps like any other one now — only a relation exempts, not a role', () => {
    const state = scene();
    assert.deepStrictEqual(
      selectTransientAutoclose(state, wid(5)),
      [wid(2), wid(3), wid(4)],
      'utility with no parentId/overlayFor is an ordinary focuser now',
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, wid(4)),
      [wid(2), wid(3)],
      'overlay with no parentId/overlayFor is an ordinary focuser too — it just cannot sweep itself',
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(6)), [wid(2), wid(3), wid(4)], 'no role was always in no exempt set');
  });

  it('an unregistered focuser sweeps every visible transient, whatever the cause', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(99), { kind: 'world' }), [wid(2), wid(3), wid(4)]);
    assert.deepStrictEqual(
      selectTransientAutoclose(state, wid(99), { kind: 'machine', opSeq: 0 }),
      [wid(2), wid(3), wid(4)],
      'no record means no openSeq to order against — the ordering test cannot arm',
    );
  });

  it('INVARIANT: a machine-caused focus ARMS an openSeq ordering test — it does not skip the sweep', () => {
    // A slide opens first, a palette after it. Both visible, both transient.
    const state = fold([reg(1, 'quick-view'), reg(2, 'palette'), orderable(1), orderable(2), show(1), show(2)], initialState());
    const slide = wid(1);
    const palette = wid(2);
    const machine: FocusCause = { kind: 'machine', opSeq: 0 };

    // (i) The slow-open race / handoff-raise echo: the machine puts focus on
    // the OLDER slide, so the palette the user opened afterwards is spared.
    assert.deepStrictEqual(selectTransientAutoclose(state, slide, machine), [], 'a newer transient outlives a machine focus on an older window');
    // The same focus caused by the WORLD is an ordinary switch and still sweeps.
    assert.deepStrictEqual(selectTransientAutoclose(state, slide, { kind: 'world' }), [palette]);

    // (ii) The other direction, which a "machine means no sweep" shortcut would
    // get wrong: the machine legitimately raises the NEWER palette, and the
    // older slide must still be swept. Ordering decides, not the cause.
    assert.deepStrictEqual(
      selectTransientAutoclose(state, palette, machine),
      [slide],
      'a machine-caused focus still sweeps anything older than the focuser',
    );
  });

  it('a RaiseWindow COMMAND for an older window does not sweep a peek opened after it — the eventual confirmation carries the machine cause', () => {
    // W is a base content window opened first; P is a quick-view peek opened later and currently
    // key. Drives the command through decide, which stamps W's lastOpSeq, then the backend's
    // confirming OsFocusGained, whose cause carries that same opSeq.
    const W = wid(1);
    const P = wid(2);
    const state = fold([reg(1, 'workspace'), reg(2, 'quick-view'), show(1), show(2), { type: 'OsFocusGained', id: P }], initialState());

    const decision = decide(state, { type: 'RaiseWindow', id: W, expectedVersion: state.version });
    assert.ok('events' in decision, `RaiseWindow was rejected: ${JSON.stringify(decision)}`);
    const { state: requested } = foldWithEffects(decision.events, state);

    const confirm: Event = { type: 'OsFocusGained', id: W, cause: { kind: 'machine', opSeq: requested.opSeqCounter } };
    const next = evolve(requested, confirm);
    const effects = react(requested, confirm, next);

    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'DismissWindow'),
      [],
      'P outlives the raise on the older W — a causeless confirmation would have swept it as a world focus',
    );
  });

  it('the ordering test spares only what is strictly newer than the focuser', () => {
    // Three transients in a known open order; the machine focuses the middle one.
    const state = fold(
      [reg(1, 'quick-view'), reg(2, 'palette'), reg(3, 'palette'), orderable(1), orderable(2), orderable(3), show(1), show(2), show(3)],
      initialState(),
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'machine', opSeq: 0 }), [wid(1)]);
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'world' }), [wid(1), wid(3)]);
  });

  it('a focuser exempts only the victim it POINTS AT — a chain popup does not sweep its parent palette, even under a machine cause', () => {
    // renderer/cmd/panel.js openChainPopup() declares `parentId` at the
    // palette it was opened from — the machine-level relation this exemption
    // now reads, not a role.
    const palette = wid(1);
    const chainPopup = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: palette, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        {
          type: 'WindowRegistered',
          id: chainPopup,
          kind: 'page-host',
          layer: 0,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
          role: 'utility',
          parentId: palette,
        },
        { type: 'WindowShown', id: palette },
        { type: 'WindowShown', id: chainPopup },
      ],
      initialState(),
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, chainPopup, { kind: 'world' }), [], 'the popup belongs to the palette named by its parentId');
    assert.deepStrictEqual(selectTransientAutoclose(state, chainPopup, { kind: 'machine', opSeq: 0 }), [], 'the exemption is unconditional on cause');
  });

  it('a focuser exempts only the victim it points at — the shared chrome overlay does not sweep the host it frames', () => {
    // hybrid-overlay.ts ensureOverlay attaches via OverlayAttached.
    const host = wid(1);
    const overlay = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: host, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'quick-view' },
        { type: 'WindowRegistered', id: overlay, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: false, class: 'overlay', role: 'overlay' },
        { type: 'WindowShown', id: host },
        { type: 'WindowShown', id: overlay },
        { type: 'OverlayAttached', overlayId: overlay, hostId: host },
      ],
      initialState(),
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, overlay, { kind: 'world' }), [], 'the overlay belongs to the host named by its overlayFor');
  });

  it('a focuser exempts only the victim it points at — detached devtools does not sweep its own host', () => {
    // main.ts's devtools-opened handler registers parentId: hostId.
    const host = wid(1);
    const devtools = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: host, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        {
          type: 'WindowRegistered',
          id: devtools,
          kind: 'browser',
          layer: 0,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'devtools',
          role: 'utility',
          parentId: host,
        },
        { type: 'WindowShown', id: host },
        { type: 'WindowShown', id: devtools },
      ],
      initialState(),
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, devtools, { kind: 'world' }), [], 'devtools belongs to the palette/peek named by its parentId');
  });

  it('the relation is directional and one-hop — a window a transient merely creates is not exempt', () => {
    // A command palette opens a page host with no parentId declared (opening
    // FROM the palette does not inherit ownership — isNonParentRole below).
    // The page host taking key must still sweep the palette that opened it.
    const palette = wid(1);
    const pageHost = wid(2);
    const state = fold(
      [
        // `browser`, as `renderer/cmd/background.js openPanelWindow` registers
        // it — a palette is never a page host, so it is `orderable` from birth
        // and a dismissal candidate the moment it is shown.
        { type: 'WindowRegistered', id: palette, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        { type: 'WindowRegistered', id: pageHost, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
        { type: 'WindowShown', id: palette },
        { type: 'WindowShown', id: pageHost },
      ],
      initialState(),
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, pageHost, { kind: 'world' }),
      [palette],
      'the page host does not belong to the palette that opened it — focusing it dismisses the palette',
    );
  });

  it('the selector is kind-agnostic — a transient browser window is a victim too', () => {
    const state = fold([reg(1, 'workspace'), reg(2, 'palette', 'browser'), show(1), show(2)], initialState());
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1)), [wid(2)]);
  });

  it("the windows switcher (features/windows/background.js openWindowsView) is role:'switcher' but parented to nothing and attached to nothing — it sweeps as a focuser AND is sweepable as a victim", () => {
    const workspace = wid(1);
    const palette = wid(2);
    const switcher = wid(3);
    const state = fold(
      [
        { type: 'WindowRegistered', id: workspace, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
        // Both `browser`, as their real open sites register them
        // (`renderer/cmd/background.js openPanelWindow`,
        // `features/windows/background.js openWindowsView`) — neither is a page
        // host, so both are `orderable` from birth.
        { type: 'WindowRegistered', id: palette, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        { type: 'WindowRegistered', id: switcher, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'switcher' },
        { type: 'WindowShown', id: workspace },
        { type: 'WindowShown', id: palette },
        { type: 'WindowShown', id: switcher },
      ],
      initialState(),
    );
    // Direction one: the switcher, once focused, has no relation to the
    // palette — it sweeps it like any other focuser now.
    assert.deepStrictEqual(selectTransientAutoclose(state, switcher, { kind: 'world' }), [palette]);
    // Direction two: the switcher has no overlayFor, so it is not exempt as
    // a victim either — some other window taking key sweeps it too.
    assert.deepStrictEqual(selectTransientAutoclose(state, workspace, { kind: 'world' }), [palette, switcher]);
  });

  it("the datastore viewer and diagnostic tool (renderer/index.js command handlers) are role:'utility' with no relation — they now sweep as focusers", () => {
    const palette = wid(1);
    const utilityWindow = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: palette, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        { type: 'WindowRegistered', id: utilityWindow, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'utility' },
        { type: 'WindowShown', id: palette },
        { type: 'WindowShown', id: utilityWindow },
      ],
      initialState(),
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, utilityWindow, { kind: 'world' }),
      [palette],
      'the datastore viewer / diagnostic tool genuinely takes key, not belonging to the palette',
    );
  });

  it("the OAuth windows (features/wonderwall/services/base.js, features/lex/atproto.js) are role:'utility' with no relation — they now sweep as focusers too", () => {
    const palette = wid(1);
    const oauthWindow = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: palette, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'palette' },
        { type: 'WindowRegistered', id: oauthWindow, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'utility' },
        { type: 'WindowShown', id: palette },
        { type: 'WindowShown', id: oauthWindow },
      ],
      initialState(),
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, oauthWindow, { kind: 'world' }),
      [palette],
      'the OAuth window declares no parentId — it must survive an app switch to a password manager on its own — so it sweeps like any other window taking key',
    );
  });

  it("a roleless modal:true window (windowSelfClosesOnBlur) is a candidate on selfClosesOnBlur alone — no role required", () => {
    const workspace = wid(1);
    const modalWindow = wid(2);
    const state = fold(
      [
        { type: 'WindowRegistered', id: workspace, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
        {
          type: 'WindowRegistered',
          id: modalWindow,
          kind: 'browser',
          layer: 0,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
          selfClosesOnBlur: true,
        },
        { type: 'WindowShown', id: workspace },
        { type: 'WindowShown', id: modalWindow },
      ],
      initialState(),
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, workspace, { kind: 'world' }),
      [modalWindow],
      'a modal:true window declares no role and no relation — selfClosesOnBlur alone must make it a candidate',
    );
  });

  // The Space border (features/spaces/background.js showBorder): role
  // 'overlay', never attached to a host, click-through. Every OTHER clause
  // admits it as a victim — only the acceptsInput policy spares it.
  it('a click-through transient survives the null-holder app-resign sweep', () => {
    const state = fold(
      [
        reg(1, 'workspace'),
        {
          type: 'WindowRegistered',
          id: wid(2),
          kind: 'browser',
          layer: 1,
          canBecomeKey: false,
          acceptsInput: false,
          class: 'overlay',
          role: 'overlay',
        },
        show(1),
        show(2),
      ],
      initialState(),
    );
    // `focusedId: null` is what `react`'s resign-sweep rule passes for a real
    // AppResignSettled — see that rule's own comment.
    assert.deepStrictEqual(
      selectTransientAutoclose(state, null, { kind: 'world' }),
      [],
      'the border does not accept input, so nothing displaces it — including a real app-deactivation settle',
    );
  });

  it('a click-through transient survives an ordinary world-caused focus sweep', () => {
    const state = fold(
      [
        reg(1, 'workspace'),
        {
          type: 'WindowRegistered',
          id: wid(2),
          kind: 'browser',
          layer: 1,
          canBecomeKey: false,
          acceptsInput: false,
          class: 'overlay',
          role: 'overlay',
        },
        show(1),
        show(2),
      ],
      initialState(),
    );
    assert.deepStrictEqual(
      selectTransientAutoclose(state, wid(1), { kind: 'world' }),
      [],
      'a real focuser taking key still does not displace a click-through window',
    );
  });

  it('a repeated non-stale MACHINE echo spares a newer transient via newer-than-focuser; a WORLD-caused focus on the same holder dismisses it', () => {
    // electron-window-backend.ts attachNativeListeners: a page-host's host
    // BaseWindow 'focus' and its content WebContentsView 'focus' both call
    // takeFocusCause(id) for the same window id, so a single machine-issued
    // focus operation can provoke two OsFocusGained reports carrying the SAME
    // opSeq. selectTransientAutoclose's newer-than-focuser exemption spares a
    // newer transient from both reports — it re-derives the ordering test
    // fresh from cause.kind and focuser.openSeq on every call. The live
    // defect (docs/design/window-manager.md "Open kernel defects", Defect A)
    // is that the SAME holder can instead take its second focus with a WORLD
    // cause: no ordering floor, the exemption does not fire, and the
    // transient is dismissed. This test documents that mechanism at the
    // kernel boundary — the reducer's behavior is correct for both causes it
    // is given; nothing here decides which cause a real second focus gets
    // labelled.
    const hostA = wid(1);
    const peek2 = wid(2);
    // Both painted: a peek that has NOT yet reported its first frame is not a
    // candidate at all (`isTransientAutocloseCandidate`), which is a different
    // failure from the one this test is about. The live defect this documents
    // is a peek that HAS painted being swept a millisecond later.
    const registered = fold([reg(1, undefined, 'page-host'), reg(2, 'quick-view'), orderable(1), orderable(2), show(1), show(2)], initialState());
    // hostA already holds key from a prior op (opSeq 28) — the state a
    // page-host sits in the instant its SECOND native focus producer echoes
    // in, having already reported via its first.
    const armed: State = {
      ...registered,
      key: hostA,
      opSeqCounter: 28,
      order: registered.order.map((w) => (w.id === hostA ? { ...w, lastOpSeq: 28 } : w)),
    };
    const cause: FocusCause = { kind: 'machine', opSeq: 28 };

    const firstEcho = evolve(armed, { type: 'OsFocusGained', id: hostA, cause });
    assert.strictEqual(isStaleSelfEcho(firstEcho, hostA, cause), false, 'opSeq 28 matches lastOpSeq 28 — not stale');
    assert.deepStrictEqual(selectTransientAutoclose(firstEcho, hostA, cause), [], 'peek2, newer than hostA, survives the first echo');

    const secondEcho = evolve(firstEcho, { type: 'OsFocusGained', id: hostA, cause });
    assert.strictEqual(isStaleSelfEcho(secondEcho, hostA, cause), false, 'still not stale — the second producer echoes the same op, not an older one');
    assert.deepStrictEqual(
      selectTransientAutoclose(secondEcho, hostA, cause),
      [],
      'peek2 survives the REPEATED machine echo too — newer-than-focuser is re-derived fresh, not consumed by the first report',
    );

    // The same second report, relabelled `world` instead of `machine`, is the
    // shape the live defect took while the backend consumed the arming on its
    // first read: a world cause yields no ordering floor for newer-than-focuser
    // to compare against, so it does not fire and the transient is swept. The
    // backend now keeps the arming until the window's own blur, so a second
    // producer's echo of the same op reads `machine`; this assertion pins what
    // the kernel does with a genuine world focus on the holder, which is still
    // a sweep.
    assert.deepStrictEqual(
      selectTransientAutoclose(secondEcho, hostA, { kind: 'world' }),
      [peek2],
      'a world-labelled second echo on the same holder sweeps peek2',
    );
  });

});

describe('window-kernel: isNonParentRole', () => {
  it('every TRANSIENT_ROLES member cannot be a parent — quick-view included', () => {
    for (const role of TRANSIENT_ROLES) {
      assert.strictEqual(isNonParentRole(role), true, `${role} must not be a real parent`);
    }
  });

  it('a non-transient role, and no role at all, can be a parent', () => {
    assert.strictEqual(isNonParentRole('workspace'), false);
    assert.strictEqual(isNonParentRole('utility'), false);
    assert.strictEqual(isNonParentRole(undefined), false);
  });
});

// selectTransientAutoclose is a pure query, proven sound in isolation elsewhere; this block
// proves its choice actually reaches a DismissWindow effect for the transition that ran it.
describe('window-kernel: react applies transient autoclose', () => {
  const reg = (n: number, role: string | undefined, kind: 'page-host' | 'browser' = 'page-host'): Event => ({
    type: 'WindowRegistered',
    id: wid(n),
    kind,
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    ...(role !== undefined ? { role } : {}),
  });
  const show = (n: number): Event => ({ type: 'WindowShown', id: wid(n) });
  const orderable = (n: number): Event => ({ type: 'WindowContentOrderable', id: wid(n) });

  // wid(1) workspace, wid(2) palette, wid(3) quick-view — all visible and orderable.
  const scene = (): State =>
    fold(
      [reg(1, 'workspace'), reg(2, 'palette'), reg(3, 'quick-view'), show(1), show(2), show(3), orderable(1), orderable(2), orderable(3)],
      initialState(),
    );

  const dismissed = (effects: Effect[]): WindowId[] => effects.filter((e) => e.type === 'DismissWindow').map((e) => e.id);

  it('a world-caused focus report emits DismissWindow for exactly what the selector named BEFORE evolve marked it (S3)', () => {
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(state, ev);
    assert.deepStrictEqual(
      dismissed(react(state, ev, next)),
      selectTransientAutoclose(state, wid(1), { kind: 'world' }),
      "react must not compute its own answer — it diffs evolve's own pendingHidden marks",
    );
    assert.deepStrictEqual(dismissed(react(state, ev, next)), [wid(2), wid(3)]);
  });

  it('DismissWindow is DISTINCT from CloseWindow — the effect union carries both', () => {
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    assert.ok(effects.some((e) => e.type === 'DismissWindow'), 'the sweep is a DismissWindow, not a CloseWindow');
    assert.ok(!effects.some((e) => e.type === 'CloseWindow'), 'CloseWindow is a membership diff — nothing closed membership here');
  });

  it('placement: the sweep rides right after RaiseWindow and before the SetStacking re-assert', () => {
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(state, ev);
    const effects = react(state, ev, next);
    const types = effects.map((e) => e.type);
    const raiseIdx = types.indexOf('RaiseWindow');
    const dismissIdx = types.indexOf('DismissWindow');
    const stackingIdx = types.indexOf('SetStacking');
    assert.ok(raiseIdx !== -1 && dismissIdx !== -1 && stackingIdx !== -1, 'all three fire for this transition');
    assert.ok(raiseIdx < dismissIdx, 'RaiseWindow precedes the sweep');
    assert.ok(dismissIdx < stackingIdx, 'the sweep precedes the stacking re-assert');
  });

  it('a phantom focuser (unregistered id) sweeps nothing — matches the RaiseWindow rule\'s own guard', () => {
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(404) };
    const next = evolve(state, ev);
    assert.strictEqual(next.key, wid(404), 'the report is recorded as given (RULE 2)');
    assert.deepStrictEqual(react(state, ev, next), [], 'no dismissal for a focuser that is not really there');
  });

  it('a self-echo (already key) mints a fresh attention seq but selects no dismissal a second time (S3)', () => {
    // wid(1) registers LAST (highest openSeq) so the machine-cause ordering
    // floor does not spare the two transients — they are OLDER than the
    // focuser, which is the case the floor still sweeps (see
    // `selectTransientAutoclose`'s own doc).
    const base = fold([reg(2, 'palette'), reg(3, 'quick-view'), reg(1, 'workspace'), orderable(1), orderable(2), orderable(3), show(1), show(2), show(3)], initialState());
    const focused = evolve(base, { type: 'OsFocusGained', id: wid(1) });
    assert.deepStrictEqual(dismissed(react(base, { type: 'OsFocusGained', id: wid(1) }, focused)), [wid(2), wid(3)], 'the FIRST report marks and dismisses both');
    const echo: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: focused.opSeqCounter } };
    const next = evolve(focused, echo);
    assert.strictEqual(next.key, focused.key, 'key does not move — this is a re-confirmation');
    assert.notStrictEqual(next.lastAttention?.seq, focused.lastAttention?.seq, 'the attention seq still advances even though nothing new is dismissed');
    // The two transients are already pendingHidden from the first report, and
    // isTransientAutocloseCandidate excludes a marked record from the law's own consideration
    // set, so this second report selects neither of them again.
    assert.deepStrictEqual(dismissed(react(focused, echo, next)), [], 'no re-selection on the echo — the mark from the first report still stands');
  });

  it('S3: two back-to-back world-caused OsFocusGained events on another window yield exactly one DismissWindow for a still-visible transient across both react calls', () => {
    // The live shape this fixes: a page host has two native focus producers
    // (`electron-window-backend.ts` `win.on('focus')` and `rendererWC.on('focus')`),
    // both echoing one physical focus synchronously, so two `OsFocusGained`
    // events for the SAME target land back-to-back — the first's own
    // `DismissWindow`/`WindowHidden` pair is still queued behind the pump
    // when the second report arrives, so the palette (wid(2)) reads
    // `visible: true` for both.
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };

    const afterFirst = evolve(state, ev);
    const firstEffects = react(state, ev, afterFirst);
    assert.deepStrictEqual(dismissed(firstEffects), [wid(2), wid(3)], 'the first native focus producer sweeps both transients');
    assert.strictEqual(afterFirst.order.find((w) => w.id === wid(2))?.visible, true, 'still visible — the executor has not confirmed the hide yet');
    assert.strictEqual(afterFirst.order.find((w) => w.id === wid(2))?.pendingHidden, true);

    const afterSecond = evolve(afterFirst, ev);
    const secondEffects = react(afterFirst, ev, afterSecond);
    assert.deepStrictEqual(dismissed(secondEffects), [], 'the second producer selects nothing new — both marks already stand');

    assert.deepStrictEqual(
      [...dismissed(firstEffects), ...dismissed(secondEffects)],
      [wid(2), wid(3)],
      'exactly one DismissWindow per window across both react() calls, not two for the same window',
    );
  });

  it('S3: a window swept by dismissal is selectable again once WindowHidden then WindowShown clear the mark', () => {
    const state = scene();
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const afterFocus = evolve(state, ev);
    assert.strictEqual(afterFocus.order.find((w) => w.id === wid(2))?.pendingHidden, true, 'the sweep marks the palette');

    // The confirming hide the DismissWindow effect eventually produces.
    const hidden = evolve(afterFocus, { type: 'WindowHidden', id: wid(2) });
    assert.strictEqual(hidden.order.find((w) => w.id === wid(2))?.visible, false);
    assert.strictEqual(hidden.order.find((w) => w.id === wid(2))?.pendingHidden, false, 'the confirming hide clears the mark');

    // Reopened, and the workspace's key is re-asserted (a fresh attention
    // seq, even though `key` itself does not move) — a fresh sweep gets to
    // ask about it again.
    const shown = evolve(hidden, { type: 'WindowShown', id: wid(2) });
    const refocusEv: Event = { type: 'OsFocusGained', id: wid(1) };
    const refocused = evolve(shown, refocusEv);
    assert.strictEqual(refocused.order.find((w) => w.id === wid(2))?.pendingHidden, true, 'selectable again — the mark cleared, so candidacy is restored');
    assert.deepStrictEqual(dismissed(react(shown, refocusEv, refocused)), [wid(2)], 'and react projects a fresh DismissWindow for it');
  });

  it('a RaiseWindow COMMAND\'s eventual OS confirmation reaches the sweep rule, carrying the machine cause that arms the floor', () => {
    // `decide` turns `RaiseWindow` into `FocusRaiseRequested`, which stamps
    // the target's `lastOpSeq` — the sweep itself does not run yet (no
    // `OsFocusGained` for the machine to have gotten wrong the way the old
    // reducer's `RAISE_WINDOW_REQUESTED` did). It runs when the backend's real
    // confirmation arrives, and that echo's `cause` is `machine` with the
    // SAME opSeq the request stamped — that is what arms
    // `selectTransientAutoclose`'s ordering floor and spares everything
    // opened after the raise. Reporting it as the world's is what let a
    // successor raise sweep a peek that was still loading — the every-other-
    // press defect (`docs/design/window-manager.md`, "Resolved: three
    // producers of a machine focus reported it as the world's").
    const state = scene();
    const decision = decide(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.ok('events' in decision);
    const { state: requested } = foldWithEffects(decision.events, state);
    assert.strictEqual(requested.key, state.key, 'the request alone did not move key yet');

    const confirm: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: requested.opSeqCounter } };
    const next = evolve(requested, confirm);
    assert.deepStrictEqual(
      dismissed(react(requested, confirm, next)),
      [],
      'the palette and quick-view were both opened after the workspace, so the floor spares them',
    );
  });

  it('the machine-cause ordering floor still spares a transient opened AFTER the raise it rides with', () => {
    // The floor `selectTransientAutoclose` already holds is what keeps a
    // machine-driven raise (via `react`'s new emission) from sweeping
    // something the user opened after the op that caused the focus.
    const older = fold([reg(1, 'quick-view'), show(1)], initialState());
    const withNewer = evolve(older, reg(2, 'palette'));
    const shownNewer = evolve(withNewer, show(2));
    const ev: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: 0 } };
    const next = evolve(shownNewer, ev);
    assert.deepStrictEqual(dismissed(react(shownNewer, ev, next)), [], 'the newer palette outlives a machine focus on the older slide');
  });

  it('a focuser exempt via parentId drives no dismissal effect through react', () => {
    const palette = wid(1);
    const chainPopup = wid(2);
    const state = fold(
      [
        reg(1, 'palette'),
        { type: 'WindowRegistered', id: chainPopup, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'utility', parentId: palette },
        show(1),
        show(2),
      ],
      initialState(),
    );
    const ev: Event = { type: 'OsFocusGained', id: chainPopup };
    const next = evolve(state, ev);
    assert.deepStrictEqual(
      react(state, ev, next).filter((e) => e.type === 'DismissWindow'),
      [],
      'the focuser belongs to its parent — react applies the relation, not a role',
    );
  });

  it('an unattached utility focuser now DRIVES a dismissal through react — the role exemption is gone', () => {
    const state = fold([reg(1, 'utility'), reg(2, 'palette'), orderable(1), orderable(2), show(1), show(2)], initialState());
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const next = evolve(state, ev);
    assert.deepStrictEqual(react(state, ev, next).filter((e) => e.type === 'DismissWindow'), [{ type: 'DismissWindow', id: wid(2) }]);
  });

  it('the resign sweep dismisses a visible unattached transient with no focuser at all', () => {
    // No OsFocusGained ever runs here, so `key` stays null throughout — the
    // old `next.key !== null` guard would have blocked this outright. The
    // dismissal comes from react's own `pendingAppResignSweep`/`appActive`
    // diff — `AppResignSettled` no longer writes `lastAttention` at all.
    const state = fold([reg(1, 'workspace'), reg(2, 'palette'), orderable(1), orderable(2), show(1), show(2)], initialState());
    const resigned = evolve(state, { type: 'AppResigned' });
    const settleEv: Event = { type: 'AppResignSettled' };
    const settled = evolve(resigned, settleEv);
    assert.strictEqual(settled.key, null, 'key was never written by this sequence');
    assert.strictEqual(settled.pendingAppResignSweep, false, 'the settle disarms the sweep');
    assert.deepStrictEqual(dismissed(react(resigned, settleEv, settled)), [wid(2)]);
  });

  it('an ATTACHED transient survives the resign sweep — the ownership relation exempts it, no focuser needed to do so', () => {
    const state = fold(
      [reg(1, 'workspace'), reg(2, 'overlay'), show(1), show(2), { type: 'OverlayAttached', overlayId: wid(2), hostId: wid(1) }],
      initialState(),
    );
    const resigned = evolve(state, { type: 'AppResigned' });
    const settleEv: Event = { type: 'AppResignSettled' };
    const settled = evolve(resigned, settleEv);
    assert.strictEqual(settled.pendingAppResignSweep, false, 'the settle disarms the sweep');
    assert.deepStrictEqual(dismissed(react(resigned, settleEv, settled)), [], 'attached, so spared even though nothing excludes it by focuser');
  });

  it('a quick-view that becomes orderable AFTER focus has already moved on is still swept (Next Step 1)', () => {
    // A quick-view's first-composited-frame report can land in a later transition than the
    // host's OsFocusGained; a candidate not yet orderable when that report ran must still be
    // reachable once its own WindowContentOrderable arrives.
    const state = fold([reg(1, undefined), reg(2, 'quick-view'), show(1), show(2)], initialState());

    const focusEv: Event = { type: 'OsFocusGained', id: wid(1) };
    const focused = evolve(state, focusEv);
    assert.strictEqual(focused.lastAttention?.cause.kind, 'world', 'the host takes focus with a world cause');
    assert.deepStrictEqual(
      dismissed(react(state, focusEv, focused)),
      [],
      'the quick-view is not yet orderable, so the focus-report sweep (a) has no candidate to name',
    );

    const orderableEv: Event = { type: 'WindowContentOrderable', id: wid(2) };
    const next = evolve(focused, orderableEv);
    assert.deepStrictEqual(
      react(focused, orderableEv, next).filter((e) => e.type === 'DismissWindow'),
      [{ type: 'DismissWindow', id: wid(2) }],
      'becoming orderable re-checks the law against the holder focus already settled on, with exactly one victim',
    );
  });

  it('the echo of the raise a world report provoked keeps the world cause, so a quick-view painting after it is still swept', () => {
    // A world report handing key to the host makes `react` raise the host; the backend echoes
    // that raise as a machine-caused report carrying the raise's own opSeq. The quick-view's
    // first frame can land on either side of that echo, and the verdict must not depend on it.
    const state = fold([reg(1, undefined), reg(2, 'quick-view'), show(1), show(2)], initialState());
    const focusEv: Event = { type: 'OsFocusGained', id: wid(1) };
    const focused = evolve(state, focusEv);
    const raise = react(state, focusEv, focused).find((e) => e.type === 'RaiseWindow');
    assert.ok(raise !== undefined && raise.type === 'RaiseWindow' && raise.id === wid(1), 'the world report provokes a raise of the new holder');

    const echo: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: raise.opSeq } };
    const echoed = evolve(focused, echo);
    assert.strictEqual(echoed.key, wid(1), 'key stays where the world put it');
    assert.strictEqual(echoed.lastAttention?.cause.kind, 'world', 'the echo re-confirms the standing attention rather than replacing its cause');
    assert.ok((echoed.lastAttention?.seq ?? 0) > (focused.lastAttention?.seq ?? 0), 'the attention seq still advances on the echo');

    const orderableEv: Event = { type: 'WindowContentOrderable', id: wid(2) };
    const next = evolve(echoed, orderableEv);
    assert.deepStrictEqual(
      react(echoed, orderableEv, next).filter((e) => e.type === 'DismissWindow'),
      [{ type: 'DismissWindow', id: wid(2) }],
      'the first-paint sweep runs against the world cause: no ordering floor, the newer quick-view is dismissed',
    );
  });

  it('a machine raise of a window that was not key still records its own machine cause', () => {
    // Only a re-confirmation keeps the standing cause; a raise that actually moves key arms
    // the ordering floor as before (the successor / parent-refocus / focus-assert cases).
    const state = fold([reg(1, undefined), reg(2, 'quick-view'), show(1), show(2), orderable(2)], initialState());
    const worldOnPeek = evolve(state, { type: 'OsFocusGained', id: wid(2) });
    const raiseEcho: Event = { type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: 99 } };
    const next = evolve(worldOnPeek, raiseEcho);
    assert.strictEqual(next.key, wid(1), 'key moves to the raised window');
    assert.strictEqual(next.lastAttention?.cause.kind, 'machine', 'a key-moving machine report records its own cause');
  });
});

// ── escapeMode: one live value, absent is meaningful ────────────────────────

describe('window-kernel: escapeMode', () => {
  const regWith = (n: number, escapeMode?: 'ignore'): Event => ({
    type: 'WindowRegistered',
    id: wid(n),
    kind: 'browser',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...(escapeMode !== undefined ? { escapeMode } : {}),
  });

  it('a window registered without one carries no escapeMode — absent, not a default value', () => {
    const state = fold([regWith(1)]);
    const rec = state.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(rec.escapeMode, undefined);
    assert.strictEqual('escapeMode' in rec, false, 'absent means the key is not there at all');
  });

  it("the HUD's declared override is stored verbatim", () => {
    // `renderer/hud/background.js` opens with `escapeMode: 'ignore'`.
    const state = fold([regWith(1, 'ignore')]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.escapeMode, 'ignore');
  });

  it('a re-registration that omits escapeMode KEEPS the declared override', () => {
    // The failure this guards: a second registration path that never learned
    // about the override silently strips it, and Escape starts closing the
    // HUD instead of reaching its page.
    const state = fold([regWith(1, 'ignore'), regWith(1)]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.escapeMode, 'ignore');
  });

  it('a re-registration that names one overwrites — it is an intrinsic, like role', () => {
    const state = fold([regWith(1), regWith(1, 'ignore')]);
    assert.strictEqual(state.order.find((w) => w.id === wid(1))?.escapeMode, 'ignore');
  });

  it('the RegisterWindow command carries it through decide unchanged', () => {
    const cmd: Command = {
      type: 'RegisterWindow',
      id: wid(1),
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'extension-ui',
      role: 'content',
      escapeMode: 'ignore',
      expectedVersion: 0,
    };
    const decision = decide(initialState(), cmd);
    assert.ok(!('rejected' in decision));
    assert.strictEqual((decision.events[0] as { escapeMode?: string }).escapeMode, 'ignore');
  });
});

// ── contentFocused: three-valued, and it must stay that way ─────────────────

describe('window-kernel: contentFocused is three-valued', () => {
  const reg = (n: number, kind: 'page-host' | 'browser'): Event => ({
    type: 'WindowRegistered',
    id: wid(n),
    kind,
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const pageHost = wid(1);
  const browser = wid(2);

  it('registration reports nothing — absent, which is NOT false', () => {
    const state = fold([reg(1, 'page-host')]);
    const rec = state.order.find((w) => w.id === pageHost)!;
    assert.strictEqual(rec.contentFocused, undefined);
    assert.strictEqual('contentFocused' in rec, false);
    // The distinction that matters to every consumer: `=== false` is the test,
    // and it must not fire on a window that has simply never reported.
    assert.strictEqual(rec.contentFocused === false, false, 'absent must not read as an observed loss');
  });

  it('a browser window never reports, so it stays absent forever', () => {
    // Its root web contents IS first responder whenever the window is key —
    // there is nothing independent to track, so no producer ever fires.
    const state = fold([reg(2, 'browser'), { type: 'WindowShown', id: browser }, { type: 'OsFocusGained', id: browser }]);
    assert.strictEqual(state.order.find((w) => w.id === browser)?.contentFocused, undefined);
  });

  it('ContentFirstResponderChanged writes exactly what was reported, both ways', () => {
    const held = fold([reg(1, 'page-host'), { type: 'ContentFirstResponderChanged', id: pageHost, held: true }]);
    assert.strictEqual(held.order.find((w) => w.id === pageHost)?.contentFocused, true);

    const lost = evolve(held, { type: 'ContentFirstResponderChanged', id: pageHost, held: false });
    assert.strictEqual(lost.order.find((w) => w.id === pageHost)?.contentFocused, false);
    assert.strictEqual(lost.order.find((w) => w.id === pageHost)?.contentFocused === false, true);
  });

  it('an observed false survives a re-registration — it must not decay back to absent', () => {
    // The two are DIFFERENT answers: `false` arms an Escape safety net,
    // absent deliberately does not. Dropping the field on the merge is the
    // exact bug class both prior property-test failures were.
    const state = fold([
      reg(1, 'page-host'),
      { type: 'ContentFirstResponderChanged', id: pageHost, held: false },
      reg(1, 'page-host'),
    ]);
    assert.strictEqual(state.order.find((w) => w.id === pageHost)?.contentFocused, false);
  });

  it('a true survives a re-registration too', () => {
    const state = fold([
      reg(1, 'page-host'),
      { type: 'ContentFirstResponderChanged', id: pageHost, held: true },
      reg(1, 'page-host'),
    ]);
    assert.strictEqual(state.order.find((w) => w.id === pageHost)?.contentFocused, true);
  });

  it('a report for an unregistered window is a no-op, and drives no effect', () => {
    const before = fold([reg(1, 'page-host')]);
    const ev: Event = { type: 'ContentFirstResponderChanged', id: wid(99), held: true };
    const after = evolve(before, ev);
    assert.deepStrictEqual(after.order, before.order);
    assert.strictEqual(after.version, before.version + 1);
    assert.deepStrictEqual(react(before, ev, after), [], 'a report ABOUT the OS drives nothing AT it');
  });

  it('the report never touches key, order, or visibility', () => {
    const base = fold([
      reg(1, 'page-host'),
      reg(2, 'browser'),
      { type: 'WindowShown', id: pageHost },
      { type: 'OsFocusGained', id: pageHost },
    ]);
    const after = evolve(base, { type: 'ContentFirstResponderChanged', id: pageHost, held: false });
    assert.strictEqual(after.key, base.key);
    assert.deepStrictEqual(after.order.map((w) => w.id), base.order.map((w) => w.id));
    assert.strictEqual(after.order.find((w) => w.id === pageHost)?.visible, true);
  });
});

// ── The content predicate (AppKit's "main" window) ──────────────────────────

// Every window below is registered with the facts its real construction site produces, so a
// predicate that matches nothing — or matches everything — fails here rather than passing vacuously.
describe('window-kernel: which window the user is working in', () => {
  const FLOATING = BASE_LAYER + 1;

  const pageHost = wid(1); // ipc.ts window-open -> inferIzuiRole 'content'
  const childPage = wid(2); // opened from another page -> 'child-content'
  const settings = wid(3); // a non-web-page surface -> 'workspace'
  const extensionPopup = wid(4); // chrome-extensions.ts: role:'content', class:'extension-ui'
  const hud = wid(5); // renderer/hud/background.js: alwaysOnTop:true, focusable:false, 'workspace'
  const chromeOverlay = wid(6); // hybrid-overlay.ts — focusable by invariant (address bar takes key)
  const cmdPanel = wid(7); // floats, focusable, modal:true — self-closes on blur, its own policy
  const slide = wid(8); // opened modal:true -> 'quick-view', focusable
  const devtools = wid(9); // main.ts: role:'utility', class:'devtools' — a real, focusable window
  const backgroundWindow = wid(10); // core-glue.ts: role:'utility', class:'background', never shown

  const scene = (): State =>
    fold([
      { type: 'WindowRegistered', id: pageHost, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: childPage, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'child-content', parentId: pageHost },
      { type: 'WindowRegistered', id: settings, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowRegistered', id: extensionPopup, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'extension-ui', role: 'content', escapeMode: 'ignore' },
      { type: 'WindowRegistered', id: hud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace', escapeMode: 'ignore' },
      { type: 'WindowRegistered', id: chromeOverlay, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'WindowRegistered', id: cmdPanel, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette', selfClosesOnBlur: true },
      { type: 'WindowRegistered', id: slide, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'quick-view', role: 'quick-view', keepLive: true },
      { type: 'WindowRegistered', id: devtools, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'devtools', role: 'utility' },
      { type: 'WindowRegistered', id: backgroundWindow, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'background', role: 'utility' },
      // pageHost takes key before cmdPanel/slide (both transient-law candidates) are shown, or
      // either would already be a visible candidate losing focus to pageHost and get dismissed
      // before a test below gets to exercise the law fresh against them.
      { type: 'WindowShown', id: pageHost },
      { type: 'OsFocusGained', id: pageHost },
      { type: 'WindowShown', id: childPage },
      { type: 'WindowShown', id: settings },
      { type: 'WindowShown', id: extensionPopup },
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: chromeOverlay },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: slide },
      { type: 'WindowShown', id: devtools },
    ]);

  const contentIds = (state: State): WindowId[] => state.order.filter(isContentWindow).map((w) => w.id);

  it('admits the document-like windows, and no others', () => {
    const admitted = contentIds(scene());
    assert.ok(admitted.length > 0, 'a predicate that matches nothing in production is the bug this test exists for');
    assert.deepStrictEqual(new Set(admitted), new Set([childPage, settings, extensionPopup, pageHost]));
  });

  it('names a reason for every exclusion', () => {
    const state = scene();
    const rec = (id: WindowId) => state.order.find((w) => w.id === id)!;

    assert.strictEqual(isContentWindow(rec(hud)), false, 'focusable:false — the OS will never give it key');
    assert.strictEqual(isContentWindow(rec(chromeOverlay)), false, 'chrome attached to a window, not the window');
    assert.strictEqual(isContentWindow(rec(cmdPanel)), false, 'a panel: key shifts to it, main does not');
    assert.strictEqual(isContentWindow(rec(slide)), false, 'a panel too — quick-views are no longer main-eligible');
    assert.strictEqual(isContentWindow(rec(devtools)), false, 'role utility — infrastructure');
    assert.strictEqual(isContentWindow(rec(backgroundWindow)), false, 'never shown, and role utility');
  });

  it('the HUD is excluded by canBecomeKey alone — its inferred role is an admitted one', () => {
    const rec = scene().order.find((w) => w.id === hud)!;
    assert.strictEqual(rec.role, 'workspace', 'the admitted role — so the role clause cannot be what excludes it');
    assert.strictEqual(rec.canBecomeKey, false);
    assert.strictEqual(isContentWindow(rec), false);
  });

  it('the chrome overlay is excluded by role alone — it is deliberately focusable', () => {
    const rec = scene().order.find((w) => w.id === chromeOverlay)!;
    assert.strictEqual(rec.canBecomeKey, true, 'typing a URL in the navbar takes key');
    assert.strictEqual(isContentWindow(rec), false);
  });

  it('an unknown or absent role is not content — the allow-list has no default-admit', () => {
    const state = fold([
      { type: 'WindowRegistered', id: wid(20), kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      { type: 'WindowRegistered', id: wid(21), kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'something-new' },
      { type: 'WindowShown', id: wid(20) },
      { type: 'WindowShown', id: wid(21) },
    ]);
    assert.deepStrictEqual(contentIds(state), []);
  });

  // ── the devtools target: content, narrowed to a real web page ─────────────

  it('a focused peek:// tile takes main, but the devtools target stays the web page behind it', () => {
    const host = wid(30);
    const peekTile = wid(31);
    const state = fold([
      { type: 'WindowRegistered', id: host, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id: host },
      { type: 'OsFocusGained', id: host },
      { type: 'WindowRegistered', id: peekTile, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowShown', id: peekTile },
      { type: 'OsFocusGained', id: peekTile },
    ]);

    const webPage = (r: WindowRecord) => isContentWindow(r) && isWebPageRole(r.role);

    assert.strictEqual(
      topmost(state, isContentWindow)?.id,
      peekTile,
      'the tile is genuinely main — role workspace is a content role, which is why the old selector answered with it',
    );
    assert.strictEqual(
      topmost(state, webPage)?.id,
      host,
      'the narrowed predicate walks past the tile to the last-focused real page',
    );
  });

  it('the narrowed predicate ranks by focus recency, which is what `order` already carries', () => {
    // OsFocusGained re-pushes the focused record at the end of order, so topmost-among-matching
    // is most-recently-focused-among-matching with no stored sequence needed.
    const first = wid(32);
    const second = wid(33);
    const webPage = (r: WindowRecord) => isContentWindow(r) && isWebPageRole(r.role);
    const base = fold([
      { type: 'WindowRegistered', id: first, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: second, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id: first },
      { type: 'WindowShown', id: second },
      { type: 'OsFocusGained', id: second },
    ]);
    assert.strictEqual(topmost(base, webPage)?.id, second);
    assert.strictEqual(topmost(evolve(base, { type: 'OsFocusGained', id: first }), webPage)?.id, first);
  });

  it('a session of peek:// surfaces only has no web page — the caller must keep a fallback', () => {
    const tile = wid(34);
    const state = fold([
      { type: 'WindowRegistered', id: tile, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowShown', id: tile },
      { type: 'OsFocusGained', id: tile },
    ]);
    assert.strictEqual(topmost(state, (r) => isContentWindow(r) && isWebPageRole(r.role)), null);
    assert.strictEqual(topmost(state, isContentWindow)?.id, tile, 'which is why `tile:window:devtools` keeps the any-kind fallback');
  });

  it('a hidden content window is not main — the visible half of the old rule', () => {
    const state = evolve(scene(), { type: 'WindowHidden', id: settings });
    assert.strictEqual(contentIds(state).includes(settings), false);
  });

  // ── key vs. main: the split this predicate exists for ──────────────────────

  it('a palette taking key does not move main', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: cmdPanel });
    assert.strictEqual(keyWindow(state)?.id, cmdPanel, 'the palette takes keystrokes');
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost, 'the page host is still the command target');
  });

  it('a focused slide holds key, so Escape reaches it — which is why main may exclude it', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: slide });
    assert.strictEqual(keyWindow(state)?.id, slide);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  it('the chrome overlay taking key at Cmd+N time does not lose the page host', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: chromeOverlay });
    assert.strictEqual(keyWindow(state)?.id, chromeOverlay);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  it('main survives the loss of key entirely — which `keyWindow` cannot', () => {
    const state = evolve(scene(), { type: 'OsFocusLost', id: pageHost });
    assert.strictEqual(keyWindow(state), null);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  // Mirrors windows.ts resolveFocusedWindowIdForClose — the key window when it is itself
  // front-eligible, else the topmost front-eligible window — over isFrontEligibleWindow, not
  // isContentWindow. What discriminates this from isContentWindow is the choice of predicate: a
  // quick-view is excluded from isContentWindow but admitted to isFrontEligibleWindow.

  it('the Cmd+W redirect (`windows.ts resolveFocusedWindowIdForClose`) never reaches PAST a focused extension popup to the page behind it', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: extensionPopup });
    assert.strictEqual(keyWindow(state)?.id, extensionPopup, 'the popup takes keystrokes');
    assert.strictEqual(topmost(state, isFrontEligibleWindow)?.id, extensionPopup, 'and, freshly raised, is topmost too');

    const key = keyWindow(state);
    const closeTarget = key !== null && isFrontEligibleWindow(key) ? key : topmost(state, isFrontEligibleWindow);
    assert.strictEqual(closeTarget?.id, extensionPopup, 'never widens to a DIFFERENT window while a content popup holds key');
  });

  it('a focused peek is its own Cmd+W target under isFrontEligibleWindow, but is wrongly skipped under isContentWindow', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: slide });
    const rec = state.order.find((w) => w.id === slide)!;
    assert.strictEqual(keyWindow(state)?.id, slide, 'the peek holds key while focused');
    assert.strictEqual(isContentWindow(rec), false, "a peek stays excluded from the kernel's own content set");
    assert.strictEqual(isFrontEligibleWindow(rec), true, 'but is admitted to the set Cmd+W composes over');

    const key = keyWindow(state);
    const closeTarget = key !== null && isFrontEligibleWindow(key) ? key : topmost(state, isFrontEligibleWindow);
    assert.strictEqual(closeTarget?.id, slide, 'closes the peek itself, never falls through to the page host behind it');

    // The pre-fix predicate excludes key from isContentWindow, so the fallback walks past the
    // peek to the next content window sitting below it in order.
    const wrongTarget = key !== null && isContentWindow(key) ? key : topmost(state, isContentWindow);
    assert.strictEqual(wrongTarget?.id, pageHost, 'the pre-fix predicate silently redirects Cmd+W to the page underneath');
  });

  it('main follows a raise, because a raise moves the window to the top of order', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: settings });
    assert.strictEqual(topmost(state, isContentWindow)?.id, settings);
  });

  // ── The hiddenByAppBlur / AppActivated interaction ────────────────────────

  it('no content window is touched by the app-resign sweep, for every window this scene registers', () => {
    const before = scene();
    const settled = evolve(evolve(before, { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const activated = evolve(settled, { type: 'AppActivated' });

    assert.deepStrictEqual(new Set(contentIds(settled)), new Set(contentIds(before)));
    assert.deepStrictEqual(new Set(contentIds(activated)), new Set(contentIds(before)));
    assert.strictEqual(topmost(settled, isContentWindow)?.id, pageHost);
    assert.strictEqual(topmost(activated, isContentWindow)?.id, pageHost);

    assert.deepStrictEqual(settled.order.filter((w) => w.hiddenByAppBlur === true).map((w) => w.id), [hud]);
  });

  it('the transient autoclose sweep is disjoint from the content set too', () => {
    const state = scene();
    const dismissed = new Set(selectTransientAutoclose(state, pageHost, { kind: 'world' }));
    assert.ok(dismissed.size > 0, 'the slide and the panel are swept — otherwise this proves nothing');
    assert.deepStrictEqual(contentIds(state).filter((id) => dismissed.has(id)), []);
  });
});

// ── hostForOverlay: the read-back direction ─────────────────────────────────

describe('window-kernel: hostForOverlay', () => {
  const host = wid(1);
  const otherHost = wid(2);
  const overlay = wid(3);

  const attached = (): State =>
    fold([
      { type: 'WindowRegistered', id: host, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: otherHost, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: overlay, kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: true, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'OverlayAttached', overlayId: overlay, hostId: host },
    ]);

  it("reads the overlay record's own attachment", () => {
    assert.strictEqual(hostForOverlay(attached(), overlay)?.id, host);
  });

  it('is the opposite direction from overlayForHost — neither answers the other question', () => {
    const state = attached();
    assert.strictEqual(overlayForHost(state, host)?.id, overlay);
    assert.strictEqual(hostForOverlay(state, host), null, 'a host is not attached to anything itself');
    assert.strictEqual(overlayForHost(state, overlay), null);
  });

  it('a detached overlay reads null, even while a page host is topmost', () => {
    const state = evolve(attached(), { type: 'OverlayAttached', overlayId: overlay, hostId: null });
    assert.strictEqual(hostForOverlay(state, overlay), null);
    assert.strictEqual(topmost(state, (r) => r.kind === 'page-host')?.id, otherHost);
  });

  it('follows a retarget', () => {
    const state = evolve(attached(), { type: 'OverlayAttached', overlayId: overlay, hostId: otherHost });
    assert.strictEqual(hostForOverlay(state, overlay)?.id, otherHost);
  });

  it('the host closing reads back as detached, not as a dangling record', () => {
    const state = evolve(attached(), { type: 'WindowClosed', id: host });
    assert.strictEqual(hostForOverlay(state, overlay), null);
  });

  it('an unregistered id reads null rather than throwing', () => {
    assert.strictEqual(hostForOverlay(attached(), wid(99)), null);
  });
});

// ── topmostBaseLayerPageHost: the overlay's attachment driver ───────────────

describe('window-kernel: topmostBaseLayerPageHost', () => {
  const FLOATING = BASE_LAYER + 1;

  const registerPageHost = (id: WindowId, opts: { layer?: number; role?: string } = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: opts.layer ?? BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: opts.role ?? 'content',
  });

  // Visible and orderable — the two facts the query, like isContentWindow, requires.
  const shown = (id: WindowId): Event[] => [
    { type: 'WindowShown', id },
    { type: 'WindowContentOrderable', id },
  ];

  it('a topmost quick-view IS the attach target — the chrome frames the peek, not the base-layer page beneath it', () => {
    const base = wid(1);
    const quickView = wid(2);
    const state = fold([
      registerPageHost(base),
      ...shown(base),
      // Real peeks/slides declare no alwaysOnTop, so they land at BASE_LAYER like any ordinary
      // page, never in a floating band.
      registerPageHost(quickView, { role: 'quick-view' }),
      ...shown(quickView),
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [base, quickView], 'the quick-view sits above `base` in `order`');
    assert.strictEqual(
      topmostBaseLayerPageHost(state)?.id,
      quickView,
      'a frontmost peek is the window the user is working in — peeks/slides use the shared overlay for their address bar (task ff3b18ba) and ship no navbar of their own',
    );
  });

  it('a page-host registered outside the base layer is excluded, even with an admitted role', () => {
    const floatingHost = wid(1);
    const state = fold([registerPageHost(floatingHost, { layer: FLOATING }), ...shown(floatingHost)]);
    assert.strictEqual(topmostBaseLayerPageHost(state), null, 'array position alone would have found it — the layer clause is what excludes it');
  });

  it('the layer clause still excludes a quick-view outside the base layer, even though the role is now admitted', () => {
    const floatingQuickView = wid(1);
    const state = fold([registerPageHost(floatingQuickView, { layer: FLOATING, role: 'quick-view' }), ...shown(floatingQuickView)]);
    assert.strictEqual(topmostBaseLayerPageHost(state), null, 'admitting the role did not also drop the layer requirement');
  });

  it('no eligible page-host reads null, even with other windows on screen', () => {
    const browserWin = wid(1);
    const utilityHost = wid(2);
    const state = fold([
      { type: 'WindowRegistered', id: browserWin, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id: browserWin },
      registerPageHost(utilityHost, { role: 'utility' }),
      ...shown(utilityHost),
    ]);
    assert.strictEqual(topmostBaseLayerPageHost(state), null);
  });

  it('among two base-layer page hosts, the topmost in order wins', () => {
    const first = wid(1);
    const second = wid(2);
    const state = fold([registerPageHost(first), ...shown(first), registerPageHost(second), ...shown(second)]);
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, second);
  });

  it('a doomed page host (a teardown already decided) is not the attach target, even though it is topmost by position', () => {
    const first = wid(1);
    const second = wid(2);
    const state = fold([
      registerPageHost(first),
      ...shown(first),
      registerPageHost(second),
      ...shown(second),
      { type: 'WindowDestroyRequested', id: second },
    ]);
    assert.strictEqual(state.order.find((w) => w.id === second)?.pendingHidden, true, 'precondition: second is doomed');
    assert.strictEqual(
      topmostBaseLayerPageHost(state)?.id,
      first,
      'attaching the shared chrome overlay singleton to a doomed host is the original overlay-attach defect family',
    );
  });

  it('a visible base-layer page host is named when it is the topmost base-layer front-eligible window', () => {
    const pageHost = wid(1);
    const state = fold([registerPageHost(pageHost), ...shown(pageHost)]);
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, pageHost);
  });

  it('REGRESSION: focusing an ordinary base-layer browser window answers null, even while a page host stays visible — the chrome must detach rather than keep framing the page underneath', () => {
    const browserWin = wid(1);
    const pageHost = wid(2);
    const state = fold([
      { type: 'WindowRegistered', id: browserWin, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id: browserWin },
      registerPageHost(pageHost),
      ...shown(pageHost),
    ]);
    // Precondition: with nothing else focused, the page host is still the attach target.
    assert.strictEqual(topmostBaseLayerPageHost(state)?.id, pageHost);

    const focused = evolve(state, { type: 'OsFocusGained', id: browserWin });
    assert.deepStrictEqual(
      focused.order.map((w) => w.id),
      [pageHost, browserWin],
      'the focus raise moved the ordinary browser window to the top of order, past the still-visible page host',
    );
    assert.strictEqual(
      topmostBaseLayerPageHost(focused),
      null,
      'the topmost window the user could be working in is an ordinary browser window, not a page host — the shared chrome overlay must detach, not keep framing the page underneath',
    );
  });

  it('a front-eligible window above the base layer at the top of order does not change the answer — the page host underneath is still named', () => {
    const pageHost = wid(1);
    const floatingPanel = wid(2);
    const state = fold([
      registerPageHost(pageHost),
      ...shown(pageHost),
      // A floating-layer window that IS genuinely front-eligible — unlike the
      // production cmd panel, which is `role: 'palette'` and so is ALSO
      // excluded as a satellite (see the satellite case below), which would
      // conflate the two clauses. This isolates the layer clamp:
      // `isBaseLayerFrontEligible` must exclude it on `layer` alone.
      { type: 'WindowRegistered', id: floatingPanel, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'floating-panel', role: 'workspace' },
      { type: 'WindowShown', id: floatingPanel },
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [pageHost, floatingPanel], 'the floating panel sits above the page host in order');
    assert.strictEqual(isFrontEligibleWindow(state.order[1]), true, 'precondition: genuinely front-eligible, not excluded as a satellite');
    assert.strictEqual(
      topmostBaseLayerPageHost(state)?.id,
      pageHost,
      'the floating window sits above BASE_LAYER, so the band clamp excludes it before eligibility is even tested',
    );
  });

  it('a satellite at the top of order does not change the answer', () => {
    const pageHost = wid(1);
    const overlay = wid(2);
    const state = fold([
      registerPageHost(pageHost),
      ...shown(pageHost),
      // The shared chrome overlay's own registration shape: floating layer,
      // focusable (typing a URL takes key), `role: 'overlay'`.
      { type: 'WindowRegistered', id: overlay, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'WindowShown', id: overlay },
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [pageHost, overlay], 'the overlay sits above the page host in order');
    assert.strictEqual(
      topmostBaseLayerPageHost(state)?.id,
      pageHost,
      'role: overlay is a satellite — isFrontEligibleWindow excludes it, so it cannot shadow the page host underneath, and the chrome legitimately taking key on Cmd+L never flickers the attachment',
    );
  });

  it('a topmost page host that is not yet orderable answers null, and answers the host once it becomes orderable', () => {
    const pageHost = wid(1);
    const state = fold([registerPageHost(pageHost), { type: 'WindowShown', id: pageHost }]); // visible, but no first-composited-frame report yet
    assert.strictEqual(state.order[0].orderable, false, 'precondition: no WindowContentOrderable report yet');
    assert.strictEqual(topmostBaseLayerPageHost(state), null, 'a page host the OS cannot yet z-order is not the attach target');

    const orderable = evolve(state, { type: 'WindowContentOrderable', id: pageHost });
    assert.strictEqual(
      topmostBaseLayerPageHost(orderable)?.id,
      pageHost,
      'the same transition that flips orderable changes the answer, with no other input moving — the state self-heals',
    );
  });
});

// The kernel stores both key (the window that took OS focus) and topmost(state, isContentWindow)
// (the window the user means to act on) as two separate facts. Every window here carries the
// facts its real construction site produces; a scene of synthetic fixtures would pass vacuously.
describe('window-kernel: what the key/main split overturns', () => {
  const FLOATING = BASE_LAYER + 1;

  const pageHost = wid(1); // ipc.ts http page -> inferIzuiRole 'content'; hybrid, kind:'page-host'
  const otherHost = wid(2); // a second page window from the same construction site
  // hybrid-overlay.ts ensureOverlay: focusable:true (so the navbar URL field can be typed in),
  // alwaysOnTop:true, transparent, click-through until the reveal band captures.
  const chromeOverlay = wid(3);
  // renderer/cmd/background.js openPanelWindow: role:'palette', keepLive:true, alwaysOnTop:true,
  // focusable, no parent — its opener is the cmd background tile, not a window.
  const cmdPanel = wid(4);
  // main.ts on 'devtools-opened': kind:'browser', role:'utility', class:'devtools', parented to
  // its host, focusable, and not floating.
  const devtools = wid(5);
  const hud = wid(6); // renderer/hud/background.js openHud: focusable:false, alwaysOnTop:true
  const backgroundWindow = wid(7); // core-glue.ts: role:'utility', class:'background', never shown

  const registerPage = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const registerCmdPanel: Event = {
    type: 'WindowRegistered',
    id: cmdPanel,
    kind: 'browser',
    layer: FLOATING,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'palette',
    role: 'palette',
    keepLive: true,
  };

  const registerHud: Event = {
    type: 'WindowRegistered',
    id: hud,
    kind: 'browser',
    layer: FLOATING,
    canBecomeKey: false,
    acceptsInput: true,
    class: 'hud',
    role: 'workspace',
    escapeMode: 'ignore',
  };

  const registerChromeOverlay: Event = {
    type: 'WindowRegistered',
    id: chromeOverlay,
    kind: 'browser',
    layer: FLOATING,
    canBecomeKey: true,
    acceptsInput: false,
    class: 'overlay',
    role: 'overlay',
  };

  const scene = (): State =>
    fold([
      registerPage(pageHost),
      registerPage(otherHost),
      registerChromeOverlay,
      registerCmdPanel,
      { type: 'WindowRegistered', id: devtools, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'devtools', role: 'utility', parentId: pageHost },
      registerHud,
      { type: 'WindowRegistered', id: backgroundWindow, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'background', role: 'utility' },
      { type: 'WindowShown', id: pageHost },
      { type: 'WindowContentOrderable', id: pageHost },
      { type: 'WindowShown', id: otherHost },
      { type: 'WindowContentOrderable', id: otherHost },
      // pageHost takes key before cmdPanel (a bare transient candidate) is shown, or cmdPanel
      // would already be a visible candidate losing focus to pageHost and get dismissed before
      // the tests below get to focus it fresh.
      { type: 'OsFocusGained', id: pageHost },
      { type: 'WindowShown', id: chromeOverlay },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: devtools },
      { type: 'WindowShown', id: hud },
      { type: 'AppActivated' },
      { type: 'OverlayAttached', overlayId: chromeOverlay, hostId: pageHost },
    ]);

  const focusFamilyIds = (effects: Effect[]): WindowId[] =>
    effects.filter((e) => e.type === 'ShowWindow' || e.type === 'RaiseWindow').map((e) => e.id);

  it('the scene starts where the old model did: the page host holds key AND is the command target', () => {
    // While key and main agree, one stored fact would be enough; each test after this one moves
    // them apart.
    const state = scene();
    assert.strictEqual(state.appActive, true);
    assert.strictEqual(keyWindow(state)?.id, pageHost);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
    assert.deepStrictEqual(
      state.order.filter(isContentWindow).map((w) => w.id),
      [otherHost, pageHost],
      'two content windows, so "the command target" is a real choice rather than the only candidate',
    );
  });

  // ── A palette takes key ────────────────────────────────────────────────────

  it('a palette taking OS focus holds key, and the command target stays the page', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: cmdPanel });

    assert.strictEqual(keyWindow(state)?.id, cmdPanel, 'keystrokes go to the palette');
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost, 'the command target is unmoved');
    assert.notStrictEqual(
      keyWindow(state)?.id,
      topmost(state, isContentWindow)?.id,
      'the two questions now have different answers — which the old single `front` could not express',
    );
  });

  it('a focus report on a satellite REORDERS — the old order was only untouched because satellites were filtered out of it', () => {
    const before = scene();
    const ev: Event = { type: 'OsFocusGained', id: cmdPanel };
    const after = evolve(before, ev);
    const effects = react(before, ev, after);

    assert.strictEqual(before.order[before.order.length - 1].id, pageHost);
    assert.strictEqual(after.order[after.order.length - 1].id, cmdPanel, 'the palette tops the ONE order');
    assert.notDeepStrictEqual(after.order.map((w) => w.id), before.order.map((w) => w.id));

    // No content-focus effect exists in the kernel's Effect union at all, and
    // no focus-family effect names the page: the only op is the raise the
    // palette's own focus report drives.
    assert.deepStrictEqual(focusFamilyIds(effects), [cmdPanel]);
    assert.strictEqual(topmost(after, isContentWindow)?.id, pageHost);
  });

  // ── The showcase: the chrome overlay ──────────────────────────────────────

  it('the chrome overlay holds key while its host is main — and the attachment names WHICH host', () => {
    // The gesture: the user works in the second page (it takes key, so it is
    // raised and the overlay retargets onto it), then presses Cmd+L and clicks
    // the URL field — `hybrid-overlay.ts` keeps the overlay focusable exactly
    // so this can happen.
    const state = fold(
      [
        { type: 'OsFocusGained', id: otherHost },
        { type: 'OverlayAttached', overlayId: chromeOverlay, hostId: otherHost },
        { type: 'OsFocusGained', id: chromeOverlay },
      ],
      scene(),
    );

    assert.strictEqual(keyWindow(state)?.id, chromeOverlay, 'the URL field is typed into — the overlay IS key');
    assert.strictEqual(topmost(state, isContentWindow)?.id, otherHost, 'main is the page, never the chrome');
    assert.strictEqual(hostForOverlay(state, chromeOverlay)?.id, otherHost, 'the relation, read from the overlay');
    assert.strictEqual(overlayForHost(state, otherHost)?.id, chromeOverlay, 'and read from the host');
    assert.strictEqual(overlayForHost(state, pageHost), null, 'the OTHER page has no overlay — the exclusion could never say this');

    // The Cmd+W redirect: the key window when it is itself content, else main. With the chrome
    // key, that resolves to the host.
    const key = keyWindow(state);
    const closeTarget = key !== null && isContentWindow(key) ? key : topmost(state, isContentWindow);
    assert.strictEqual(closeTarget?.id, otherHost);
  });

  // ── Devtools ──────────────────────────────────────────────────────────────

  it('devtools genuinely IS key — which is precisely why the Escape grab must not arm', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: devtools });

    assert.strictEqual(keyWindow(state)?.id, devtools);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost, 'the command target the old `front` stood in for');

    // False for the RIGHT reason: the app is active and no switcher is open,
    // so the only clause left is the key holder.
    assert.strictEqual(state.appActive, true);
    assert.strictEqual(switcherWindow(state), null);
    assert.strictEqual(shouldArmEscapeGrab(state), false);

    // Non-vacuous: the same scene with nobody holding key DOES arm.
    const nobodyKey = evolve(state, { type: 'OsFocusLost', id: devtools });
    assert.strictEqual(keyWindow(nobodyKey), null);
    assert.strictEqual(shouldArmEscapeGrab(nobodyKey), true);
  });

  // ── Closing a parentless palette that holds key ───────────────────────────

  it('closing a parentless palette that holds key leaves key dangling until the OS reports, and raises the page host it took key from', () => {
    const withPalette = evolve(scene(), { type: 'OsFocusGained', id: cmdPanel });
    assert.strictEqual(withPalette.order.find((w) => w.id === cmdPanel)?.parentId, undefined, 'no parent to hand back to');
    assert.strictEqual(withPalette.order.find((w) => w.id === cmdPanel)?.priorKey, pageHost, 'the palette took key from the page host');

    const ev: Event = { type: 'WindowClosed', id: cmdPanel };
    const closed = evolve(withPalette, ev);
    const effects = react(withPalette, ev, closed);

    assert.strictEqual(closed.key, cmdPanel, 'the raw field still dangles — unrepaired; only the OS report writes key');
    assert.strictEqual(keyWindow(closed), null, 'and reads as: nobody holds key yet');
    assert.strictEqual(topmost(closed, isContentWindow)?.id, pageHost, 'main is untouched by the close');
    // Hide-returns-key applies to a close the same as to a hide: the prior key holder is raised,
    // not whatever sits on top, and no parent is needed for that.
    assert.deepStrictEqual(effects.filter((e) => e.type === 'RaiseWindow'), [{ type: 'RaiseWindow', id: pageHost, opSeq: closed.opSeqCounter }], 'the prior key holder is raised in its place');
    assert.deepStrictEqual(focusFamilyIds(effects), [pageHost], 'and nothing else is shown or raised');
  });

  // ── The most dangerous rename in the migration ────────────────────────────

  it('with no content window on screen, the focused window still holds key — the command target is what is null', () => {
    // The real shape: boot. The core background renderer and the HUD are up,
    // the resident command panel exists, no page has been opened yet, and the
    // user presses the panel hotkey.
    const boot = fold([
      { type: 'WindowRegistered', id: backgroundWindow, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'background', role: 'utility' },
      registerHud,
      registerCmdPanel,
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'AppActivated' },
      { type: 'OsFocusGained', id: cmdPanel },
    ]);

    assert.notStrictEqual(keyWindow(boot), null, 'the naive rename asserts null HERE, and is wrong');
    assert.strictEqual(keyWindow(boot)?.id, cmdPanel);
    assert.strictEqual(topmost(boot, isContentWindow), null, 'THIS is the null the old assertion meant');
    assert.deepStrictEqual(boot.order.filter(isContentWindow), [], 'no content window exists to be the target');
  });

  it('the same old test conflates two axes: a non-focusable window never reports focus at all', () => {
    // The other half of the split the doc asks for. `canBecomeKey: false` (the
    // HUD, `focusable:false`) means the OS never gives it focus, so the adapter
    // never emits `OsFocusGained` for it — `key` is unwritten because no report
    // exists, not because the kernel excluded anything. An overlay with
    // `canBecomeKey: true` reports, and takes key.
    const shownOnly = fold([
      registerHud,
      registerChromeOverlay,
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: chromeOverlay },
      { type: 'AppActivated' },
    ]);
    assert.strictEqual(shownOnly.order.find((w) => w.id === hud)?.canBecomeKey, false, 'the OS will never make it key');
    assert.strictEqual(keyWindow(shownOnly), null, 'no report, so nothing wrote key');

    const overlayTookKey = evolve(shownOnly, { type: 'OsFocusGained', id: chromeOverlay });
    assert.strictEqual(overlayTookKey.order.find((w) => w.id === chromeOverlay)?.canBecomeKey, true);
    assert.strictEqual(keyWindow(overlayTookKey)?.id, chromeOverlay, 'a focusable overlay DOES take key');
  });

  // ── Show is not focus ─────────────────────────────────────────────────────

  it('a show never writes key; only a focus report does — the two old tests that look identical differ here', () => {
    // The real pair: the command panel is `keepLive: true`, so closing it HIDES
    // it and the next hotkey re-shows the same window. A non-activating
    // re-show emits only `WindowShown`; an activating one is followed by the
    // OS's own focus report.
    const hidden = evolve(scene(), { type: 'WindowHidden', id: cmdPanel });
    assert.strictEqual(keyWindow(hidden)?.id, pageHost);

    const reshownOnly = evolve(hidden, { type: 'WindowShown', id: cmdPanel });
    assert.strictEqual(reshownOnly.order.find((w) => w.id === cmdPanel)?.visible, true, 'it is on screen');
    assert.strictEqual(keyWindow(reshownOnly)?.id, pageHost, 'and key did not move');
    assert.strictEqual(reshownOnly.order[reshownOnly.order.length - 1].id, pageHost, 'nor did the order');

    const thenFocused = evolve(reshownOnly, { type: 'OsFocusGained', id: cmdPanel });
    assert.strictEqual(keyWindow(thenFocused)?.id, cmdPanel, 'the focus report is the only thing that writes key');
    assert.strictEqual(topmost(thenFocused, isContentWindow)?.id, pageHost, 'and main still does not move');
  });

  // ── A dangling key is representable ───────────────────────────────────────

  it('a key id naming no record is a LEGAL state — the old model called it unrepresentable', () => {
    // The real shape: a detached devtools window registers LAZILY, on
    // `'devtools-opened'` (`main.ts`), so the OS can report focus for a window
    // the machine has not registered yet.
    const unregistered = wid(90);
    const before = scene();
    const ev: Event = { type: 'OsFocusGained', id: unregistered };
    const state = evolve(before, ev);

    assert.strictEqual(state.key, unregistered, 'the report is recorded as given');
    assert.strictEqual(keyWindow(state), null, 'and resolves to: nobody holds key');
    assert.deepStrictEqual(state.order.map((w) => w.id), before.order.map((w) => w.id), 'an unregistered id moves nothing');
    assert.deepStrictEqual(react(before, ev, state), [], 'and drives nothing');
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost, 'main is unaffected — it never depended on key');
    assert.strictEqual(shouldArmEscapeGrab(state), true, 'nobody can hear before-input-event, so the grab arms');
  });
});

describe('window-kernel: teardown commands and effects', () => {
  const register = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
  });

  const oneWindow = (): State => fold([register(wid(1)), { type: 'WindowShown', id: wid(1) }], initialState());

  function run(state: State, cmd: Command): { events: Event[]; effects: Effect[]; state: State } {
    const decision = decide(state, cmd);
    assert.ok('events' in decision, `command ${cmd.type} was rejected: ${JSON.stringify(decision)}`);
    const folded = foldWithEffects(decision.events, state);
    return { events: decision.events, effects: folded.effects, state: folded.state };
  }

  // ── One command, one event, one effect ───────────────────────────────────

  const table: Array<{ cmd: Command; event: Event; effect: Effect }> = [
    {
      cmd: { type: 'DestroyWindow', id: wid(1), expectedVersion: 0 },
      event: { type: 'WindowDestroyRequested', id: wid(1) },
      effect: { type: 'DestroyWindow', id: wid(1) },
    },
    {
      cmd: { type: 'CloseContent', id: wid(1), expectedVersion: 0 },
      event: { type: 'WindowContentCloseRequested', id: wid(1) },
      effect: { type: 'CloseContent', id: wid(1) },
    },
    {
      cmd: { type: 'CloseWindowDirect', id: wid(1), expectedVersion: 0 },
      event: { type: 'WindowDirectCloseRequested', id: wid(1) },
      effect: { type: 'CloseWindowDirect', id: wid(1) },
    },
    {
      cmd: { type: 'DestroyAllGuests', expectedVersion: 0 },
      event: { type: 'GuestTeardownRequested' },
      effect: { type: 'DestroyAllGuests' },
    },
  ];

  for (const { cmd, event, effect } of table) {
    it(`${cmd.type} produces exactly one event and one effect`, () => {
      const state = oneWindow();
      const result = run(state, { ...cmd, expectedVersion: state.version });
      assert.deepStrictEqual(result.events, [event]);
      assert.deepStrictEqual(result.effects, [effect]);
    });

    it(`${cmd.type} retires no record — membership shrinks on WindowClosed alone`, () => {
      const state = oneWindow();
      const result = run(state, { ...cmd, expectedVersion: state.version });
      assert.deepStrictEqual(
        result.state.order.map((w) => w.id),
        state.order.map((w) => w.id),
        'order is unchanged: the record retires on the native close report, not on the request',
      );
      assert.strictEqual(result.state.order[0].visible, true, 'and nothing about the record moved either');
    });
  }

  // ── Constraint: teardown is exempt from the unknown-window rejection ──────

  it('a teardown command naming a window that never registered is ACCEPTED', () => {
    // `decide` rejects `ShowWindow` for the same id — the exemption is per
    // command family, not a hole in the guard.
    const state = oneWindow();
    assert.deepStrictEqual(
      decide(state, { type: 'ShowWindow', id: wid(404), expectedVersion: state.version }),
      { rejected: 'no-such-window' },
    );
    for (const { cmd, event } of table) {
      const named = 'id' in cmd ? { ...cmd, id: wid(404), expectedVersion: state.version } : { ...cmd, expectedVersion: state.version };
      const decision = decide(state, named);
      assert.ok('events' in decision, `${cmd.type} must not be rejected for an unknown window`);
      assert.deepStrictEqual(decision.events, ['id' in event ? { ...event, id: wid(404) } : event]);
    }
  });

  it('a content close naming a window retired microseconds earlier still reaches the OS', () => {
    // The measured production shape: `ipc.ts runHybridFinalize` dispatches the
    // content close AFTER `finalizeWindowClose` retired the record, in the same
    // synchronous body, on every hybrid close. A rejecting port would silently
    // drop every hybrid content-WC teardown.
    const retired = fold([{ type: 'WindowClosed', id: wid(1) }], oneWindow());
    assert.strictEqual(retired.order.length, 0, 'the record is gone before the command is issued');

    const result = run(retired, { type: 'CloseContent', id: wid(1), expectedVersion: retired.version });
    assert.deepStrictEqual(result.effects, [{ type: 'CloseContent', id: wid(1) }]);
  });

  // ── Constraint: DestroyAllGuests names no window ──────────────────────────

  it('DestroyAllGuests carries no window id — at the command, the event, and the effect', () => {
    const state = oneWindow();
    const cmd: Command = { type: 'DestroyAllGuests', expectedVersion: state.version };
    assert.strictEqual('id' in cmd, false);
    const result = run(state, cmd);
    assert.strictEqual('id' in result.events[0], false);
    assert.strictEqual('id' in result.effects[0], false);
  });

  it('DestroyAllGuests is one effect regardless of how many windows are registered', () => {
    // The port iterates the process-wide guest map. A fan-out over `order`
    // would scale with membership here AND would miss guests whose host has
    // already retired — the common case at quit.
    const many = fold([register(wid(1)), register(wid(2)), register(wid(3))], initialState());
    const result = run(many, { type: 'DestroyAllGuests', expectedVersion: many.version });
    assert.deepStrictEqual(result.effects, [{ type: 'DestroyAllGuests' }]);

    const none = initialState();
    const emptyResult = run(none, { type: 'DestroyAllGuests', expectedVersion: none.version });
    assert.deepStrictEqual(emptyResult.effects, [{ type: 'DestroyAllGuests' }], 'and it fires with nothing registered at all');
  });

  // ── The seq that makes repetition visible ─────────────────────────────────

  it('two identical teardown requests are two effects, not one', () => {
    const state = oneWindow();
    const first = run(state, { type: 'DestroyWindow', id: wid(1), expectedVersion: state.version });
    const second = run(first.state, { type: 'DestroyWindow', id: wid(1), expectedVersion: first.state.version });
    assert.deepStrictEqual(first.effects, [{ type: 'DestroyWindow', id: wid(1) }]);
    assert.deepStrictEqual(second.effects, [{ type: 'DestroyWindow', id: wid(1) }]);
    assert.ok(second.state.lastTeardown !== null);
    assert.strictEqual(second.state.lastTeardown.seq, 2, 'the seq is what kept the second request from diffing to nothing');
  });

  it('a later non-teardown transition re-emits nothing — the field is a record, not a queue', () => {
    const state = oneWindow();
    const teardown = run(state, { type: 'DestroyWindow', id: wid(1), expectedVersion: state.version });
    const after = foldWithEffects([{ type: 'WindowHidden', id: wid(1) }], teardown.state);
    // Filtered to the effects that name this window: hiding the app's last
    // visible window also hands the user back to where they came from
    // (`react`'s app-hide rule), which names no window and is not what this
    // test is about.
    assert.deepStrictEqual(
      after.effects.filter((e) => 'id' in e),
      [{ type: 'HideWindow', id: wid(1), opSeq: after.state.opSeqCounter }],
      'no second DestroyWindow',
    );
    assert.deepStrictEqual(after.state.lastTeardown, teardown.state.lastTeardown, 'and the recorded teardown is untouched');
  });

  // ── decide still holds the version guard ──────────────────────────────────

  it('a stale expectedVersion is rejected for teardown too — only the window guard is exempted', () => {
    const state = oneWindow();
    for (const { cmd } of table) {
      const stale = { ...cmd, expectedVersion: state.version + 1 };
      assert.deepStrictEqual(decide(state, stale), { rejected: 'stale-version' }, `${cmd.type} must honour expectedVersion`);
    }
  });

  // ── react stays a projection ──────────────────────────────────────────────

  it('a teardown event fed straight to evolve drives the same effect as the command path', () => {
    // `react` switches on `lastTeardown.kind` (state), never on `ev.type`, so
    // the two entry points cannot diverge.
    const state = oneWindow();
    const viaCommand = run(state, { type: 'CloseWindowDirect', id: wid(1), expectedVersion: state.version });
    const viaEvent = foldWithEffects([{ type: 'WindowDirectCloseRequested', id: wid(1) }], state);
    assert.deepStrictEqual(viaEvent.effects, viaCommand.effects);
    assert.deepStrictEqual(viaEvent.state, viaCommand.state);
  });

  it('evolve does not throw on any teardown event, from any state', () => {
    const states: Array<[string, State]> = [
      ['empty', initialState()],
      ['one window', oneWindow()],
      ['retired window', fold([{ type: 'WindowClosed', id: wid(1) }], oneWindow())],
    ];
    const events: Event[] = [
      { type: 'WindowDestroyRequested', id: wid(1) },
      { type: 'WindowContentCloseRequested', id: wid(404) },
      { type: 'WindowDirectCloseRequested', id: wid(1) },
      { type: 'GuestTeardownRequested' },
    ];
    for (const [label, state] of states) {
      for (const ev of events) {
        let next: State | undefined;
        assert.doesNotThrow(() => {
          next = evolve(state, ev);
        }, `${label} x ${ev.type}`);
        assert.strictEqual(next!.version, state.version + 1, 'every event bumps version');
      }
    }
  });
});

// Focus assert: a request that carries no state change of its own. In this kernel the transition
// is a no-diff one — the target is already topmost, visible, and key — so the request has to
// become a fact react can diff, exactly like teardown; a plain RaiseWindow command would fold to
// an OsFocusGained that reorders nothing and drives nothing at all.
describe('window-kernel: the focus assert', () => {
  const contentWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  // Focusable and visible, but not isContentWindow (its role is not a content role).
  const paletteWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'palette',
  });

  const frontContent = (id: WindowId = wid(1)): State =>
    fold([contentWindow(id), { type: 'WindowShown', id }, { type: 'OsFocusGained', id }], initialState());

  function run(state: State, cmd: Command): { events: Event[]; effects: Effect[]; state: State } {
    const decision = decide(state, cmd);
    assert.ok('events' in decision, `command ${cmd.type} was rejected: ${JSON.stringify(decision)}`);
    const folded = foldWithEffects(decision.events, state);
    return { events: decision.events, effects: folded.effects, state: folded.state };
  }

  // ── The emission ──────────────────────────────────────────────────────────

  it('AssertFocus re-drives the raise on a window that is already front', () => {
    const state = frontContent();
    const result = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });

    assert.deepStrictEqual(result.events, [{ type: 'FocusAssertRequested', id: wid(1) }]);
    assert.deepStrictEqual(result.effects, [
      { type: 'RaiseWindow', id: wid(1), opSeq: result.state.opSeqCounter },
      { type: 'FocusContent', id: wid(1) },
    ]);
  });

  it('the transition it projects changes nothing else — which is why the fact has to exist', () => {
    // If any of these moved, `react` would have something else to diff and the
    // whole `lastFocusAssert` mechanism would be unnecessary. They do not.
    const state = frontContent();
    const result = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });

    assert.strictEqual(result.state.key, state.key, 'key is untouched (RULE 2)');
    assert.deepStrictEqual(
      result.state.order.map((w) => w.id),
      state.order.map((w) => w.id),
      'membership and position are untouched (RULE 1)',
    );
    const before = state.order[0];
    const after = result.state.order[0];
    assert.strictEqual(after.visible, before.visible);
    assert.strictEqual(after.orderable, before.orderable);
    assert.deepStrictEqual(after.fsMode, before.fsMode);
    assert.strictEqual(after.contentFocused, before.contentFocused);
  });

  it('a plain RaiseWindow command on the same window drives NOTHING — the regression this replaces', () => {
    // decide turns RaiseWindow into an OsFocusGained; the window is already topmost, so react's
    // reorder rule sees the same top in prev and next and emits nothing.
    const state = frontContent();
    const result = run(state, { type: 'RaiseWindow', id: wid(1), expectedVersion: state.version });
    assert.deepStrictEqual(result.effects, [], 'no raise, and above all no content focus');
  });

  // ── The seq that makes repetition visible ─────────────────────────────────

  it('two identical asserts for the same window are two asserts', () => {
    // Every devtools open/close names the same window with the same payload,
    // so `seq` is the ONLY thing that distinguishes them.
    const state = frontContent();
    const first = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });
    const second = run(first.state, { type: 'AssertFocus', id: wid(1), expectedVersion: first.state.version });

    assert.strictEqual(first.effects.length, 2);
    assert.strictEqual(second.effects.length, 2, 'the second request is not swallowed as a duplicate');
    assert.strictEqual(first.state.lastFocusAssert?.seq, 1);
    assert.strictEqual(second.state.lastFocusAssert?.seq, 2, 'the seq is what kept the second request from diffing to nothing');
  });

  it('a later unrelated transition re-emits nothing — the field is a record, not a queue', () => {
    const state = frontContent();
    const asserted = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });
    const after = foldWithEffects([{ type: 'WindowHidden', id: wid(1) }], asserted.state);

    // Filtered to the effects that name this window, same reason as the
    // teardown block's sibling test: hiding the app's last visible window also
    // hands the user back to where they came from, and that effect names none.
    assert.deepStrictEqual(
      after.effects.filter((e) => 'id' in e),
      [{ type: 'HideWindow', id: wid(1), opSeq: after.state.opSeqCounter }],
      'no second RaiseWindow, no second FocusContent',
    );
    assert.deepStrictEqual(after.state.lastFocusAssert, asserted.state.lastFocusAssert, 'and the recorded assert is untouched');
  });

  // ── The op token ──────────────────────────────────────────────────────────

  it('the assert mints one op token and stamps it on the record it raises', () => {
    // `RaiseWindow` is a focus-family effect, so the same biconditional every
    // other op-issuing arm holds applies here: exactly one token per transition
    // that issues an op, carried by the effect and stamped on the record.
    const state = frontContent();
    const result = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });

    assert.strictEqual(result.state.opSeqCounter, state.opSeqCounter + 1, 'exactly one token');
    const raise = result.effects.find((e) => e.type === 'RaiseWindow') as Extract<Effect, { type: 'RaiseWindow' }>;
    assert.strictEqual(raise.opSeq, result.state.opSeqCounter);
    assert.strictEqual(result.state.order[0].lastOpSeq, raise.opSeq, 'evolve stamp and react token are one value');
  });

  // ── The content / non-content split on FocusContent ───────────────────────

  it('a non-content target gets no FocusContent — the split is real, not decorative', () => {
    // Reached by dispatching the EVENT, which bypasses `decide`: through the
    // command path `decide`'s own `isContentWindow` gate answers first (below),
    // so this is the path where `react`'s clause is what decides.
    const palette = fold(
      [paletteWindow(wid(2)), { type: 'WindowShown', id: wid(2) }, { type: 'OsFocusGained', id: wid(2) }],
      initialState(),
    );
    const result = foldWithEffects([{ type: 'FocusAssertRequested', id: wid(2) }], palette);
    assert.deepStrictEqual(result.effects, [{ type: 'RaiseWindow', id: wid(2), opSeq: result.state.opSeqCounter }]);

    // Same event, same shape of state, a content role: both halves.
    const content = frontContent();
    const contentResult = foldWithEffects([{ type: 'FocusAssertRequested', id: wid(1) }], content);
    assert.deepStrictEqual(contentResult.effects, [
      { type: 'RaiseWindow', id: wid(1), opSeq: contentResult.state.opSeqCounter },
      { type: 'FocusContent', id: wid(1) },
    ]);
  });

  it('an assert naming a window that is not registered drives nothing at all', () => {
    // Only reachable as a raw event (`decide` rejects the command). There is
    // nothing to raise, so nothing is emitted — and no token is minted either,
    // which is what keeps the op-counter biconditional true.
    const state = frontContent();
    const result = foldWithEffects([{ type: 'FocusAssertRequested', id: wid(404) }], state);
    assert.deepStrictEqual(result.effects, []);
    assert.strictEqual(result.state.opSeqCounter, state.opSeqCounter, 'no effect, no token');
    assert.strictEqual(result.state.lastFocusAssert?.id, wid(404), 'the request is still recorded as asked');
  });

  // ── The visibility gate (an off-screen target must never be activated) ────

  it('a registered but never-shown window: no RaiseWindow, no token — the gap this closes', () => {
    // `backend.raiseWindow` is an activating show, so a target merely PRESENT
    // in `order` (the old, insufficient test) would pull an off-screen window
    // onto the screen and take key. It must be `visible`.
    const state = fold([paletteWindow(wid(2))], initialState());
    assert.strictEqual(state.order.find((w) => w.id === wid(2))?.visible, false, 'precondition: registered, never shown');

    const result = foldWithEffects([{ type: 'FocusAssertRequested', id: wid(2) }], state);
    assert.deepStrictEqual(result.effects, []);
    assert.strictEqual(result.state.opSeqCounter, state.opSeqCounter, 'no effect, no token');
  });

  it('a window that was shown and then hidden: no RaiseWindow, no token', () => {
    const shown = fold([paletteWindow(wid(2)), { type: 'WindowShown', id: wid(2) }], initialState());
    assert.strictEqual(shown.order.find((w) => w.id === wid(2))?.visible, true, 'precondition: shown');
    const hidden = fold([{ type: 'WindowHidden', id: wid(2) }], shown);
    assert.strictEqual(hidden.order.find((w) => w.id === wid(2))?.visible, false, 'precondition: hidden again');

    const result = foldWithEffects([{ type: 'FocusAssertRequested', id: wid(2) }], hidden);
    assert.deepStrictEqual(result.effects, []);
    assert.strictEqual(result.state.opSeqCounter, hidden.opSeqCounter, 'no effect, no token');
  });

  // The visible-palette case (a visible, non-content target raised alone,
  // with no FocusContent) is already covered by "a non-content target gets
  // no FocusContent — the split is real, not decorative" above.

  // ── Rule order: the assert is LAST ────────────────────────────────────────

  it('the assert rule emits after the stacking re-assert', () => {
    // No single event both reorders `order` and records an assert, so the
    // ordering is stated against a transition that carries both: the real
    // `OsFocusGained` reorder, with the assert fact laid on top of its `next`.
    // `react` is a pure function of `(prev, ev, next)`, so this is the same
    // call the executor would make.
    const base = fold(
      [
        contentWindow(wid(1)),
        { type: 'WindowShown', id: wid(1) },
        // A page-host is not orderable until its first composited frame, and
        // the stacking rule skips what the OS cannot yet position.
        { type: 'WindowContentOrderable', id: wid(1) },
        contentWindow(wid(2)),
        { type: 'WindowShown', id: wid(2) },
        { type: 'WindowContentOrderable', id: wid(2) },
      ],
      initialState(),
    );
    // wid(1) sits at the BOTTOM (registration appends with no key window), so
    // focusing it is a genuine reorder and the stacking rule really fires.
    const ev: Event = { type: 'OsFocusGained', id: wid(1) };
    const reordered = evolve(base, ev);
    const withAssert: State = { ...reordered, lastFocusAssert: { id: wid(1), seq: 1 } };

    const effects = react(base, ev, withAssert);
    const types = effects.map((e) => e.type);
    assert.ok(types.includes('SetStacking'), 'the transition really does re-assert stacking');
    assert.deepStrictEqual(
      types.slice(-2),
      ['RaiseWindow', 'FocusContent'],
      'the assert lands after the re-show / overlay / stacking work, mirroring the old arm',
    );
    assert.ok(types.lastIndexOf('SetStacking') < types.length - 2, 'and every SetStacking precedes it');
  });

  // ── decide holds the guards ───────────────────────────────────────────────

  it('a stale expectedVersion is rejected', () => {
    const state = frontContent();
    assert.deepStrictEqual(
      decide(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version + 1 }),
      { rejected: 'stale-version' },
    );
  });

  it('an unknown window is rejected — this command is NOT exempt like teardown', () => {
    const state = frontContent();
    assert.deepStrictEqual(
      decide(state, { type: 'AssertFocus', id: wid(404), expectedVersion: state.version }),
      { rejected: 'no-such-window' },
    );
    // The contrast that makes the point: the same unknown id IS accepted by a
    // teardown command, whose exemption exists for the hybrid finalize race.
    const teardown = decide(state, { type: 'CloseContent', id: wid(404), expectedVersion: state.version });
    assert.ok('events' in teardown);
  });

  it('a target that is not the window the user works in is accepted and drives nothing', () => {
    // The port of `applyRaiseRequest`'s `isEligibleFront(rec)` early return: an
    // activating show onto a background surface would steal key.
    const state = fold(
      [contentWindow(wid(1)), { type: 'WindowShown', id: wid(1) }, paletteWindow(wid(2)), { type: 'WindowShown', id: wid(2) }],
      initialState(),
    );
    assert.strictEqual(isContentWindow(state.order.find((w) => w.id === wid(2))!), false);
    const result = run(state, { type: 'AssertFocus', id: wid(2), expectedVersion: state.version });
    assert.deepStrictEqual(result.events, [], 'no event');
    assert.deepStrictEqual(result.effects, [], 'and so no effect');

    // A hidden content window is not "what the user is working in" either.
    const hidden = fold([contentWindow(wid(3))], state);
    const hiddenResult = run(hidden, { type: 'AssertFocus', id: wid(3), expectedVersion: hidden.version });
    assert.deepStrictEqual(hiddenResult.effects, []);
  });

  // decide/react hold no appActive/switcher-open guard on the RaiseWindow effect — it fires whether
  // or not the app is active, and the background suppression that keeps that raise from taking key
  // or activating the app lives in window-kernel-executor.ts planRaise instead. The paired
  // FocusContent effect is a different decision: an assert never carries user intent
  // (`FocusAssertRequested` has no `intent` field), so `react` withholds it while the app is
  // inactive (F6) rather than let it reach the backend and activate the app out from under the
  // raise that `planRaise` is about to answer `suppressed` for.

  it('a raise fires even while appActive is false, but its content focus is withheld — the two are not the same decision', () => {
    let state = frontContent();
    state = fold([{ type: 'AppResigned' }], state);
    assert.strictEqual(state.appActive, false, 'the app is backgrounded');

    const result = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });
    assert.deepStrictEqual(
      result.effects,
      [{ type: 'RaiseWindow', id: wid(1), opSeq: result.state.opSeqCounter }],
      'no FocusContent while the app is inactive (F6) — the raise alone reaches the executor, which suppresses it',
    );
  });

  it('the same assert restores the paired FocusContent once the app is active — appActive is the only thing that changed', () => {
    const state = frontContent();
    assert.strictEqual(state.appActive, true, 'precondition: active');

    const result = run(state, { type: 'AssertFocus', id: wid(1), expectedVersion: state.version });
    assert.deepStrictEqual(result.effects, [
      { type: 'RaiseWindow', id: wid(1), opSeq: result.state.opSeqCounter },
      { type: 'FocusContent', id: wid(1) },
    ]);
  });

  it('AppActivated by itself still raises nothing, active or not — the re-drive comes from the cold-start latch or a later focus report (see `window-kernel: spending the cold-start focus latch` "an activation with NO latch...")', () => {
    let state = frontContent();
    state = fold([{ type: 'AppResigned' }], state);
    assert.strictEqual(state.pendingColdStartFocus, null, 'nothing armed');

    const activated = foldWithEffects([{ type: 'AppActivated' }], state);
    assert.deepStrictEqual(activated.effects, [], 'the activation itself names no target');
  });

  // ── evolve stays total ────────────────────────────────────────────────────

  it('evolve does not throw on a focus-assert event, from any state', () => {
    const states: Array<[string, State]> = [
      ['empty', initialState()],
      ['one front content window', frontContent()],
      ['retired window', fold([{ type: 'WindowClosed', id: wid(1) }], frontContent())],
    ];
    for (const [label, state] of states) {
      let next: State | undefined;
      assert.doesNotThrow(() => {
        next = evolve(state, { type: 'FocusAssertRequested', id: wid(1) });
      }, label);
      assert.strictEqual(next!.version, state.version + 1, 'every event bumps version');
    }
  });
});

// ── The session-restore stack-order import ──────────────────────────────────

describe('window-kernel: the stack-order import', () => {
  const pageHost = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const palette = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'cmd',
    role: 'palette',
  });

  // A higher band, never key — one of the windows order holds that the import never names.
  const hud = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER + 1,
    canBecomeKey: false,
    acceptsInput: false,
    class: 'hud',
    role: 'overlay',
  });

  // order bottom -> top: [1, 2, 3, 11, 10] — the palette took key last, so it sits on top.
  const restored = (): State =>
    fold(
      [
        pageHost(wid(1)),
        pageHost(wid(2)),
        pageHost(wid(3)),
        palette(wid(10)),
        hud(wid(11)),
        ...[wid(1), wid(2), wid(3), wid(10), wid(11)].flatMap(
          (id): Event[] => [
            { type: 'WindowShown', id },
            { type: 'WindowContentOrderable', id },
          ],
        ),
        { type: 'OsFocusGained', id: wid(10) },
      ],
      initialState(),
    );

  const ids = (state: State): WindowId[] => state.order.map((w) => w.id);
  const sortedIds = (state: State): WindowId[] => [...ids(state)].sort();

  function importOrder(state: State, order: WindowId[]): { state: State; effects: Effect[] } {
    return foldWithEffects([{ type: 'StackOrderImported', order }], state);
  }

  // ── Membership is preserved by construction ───────────────────────────────

  const membershipCases: Array<[string, WindowId[]]> = [
    ['a subset — only some of the registered windows are named', [wid(3), wid(1)]],
    ['a superset — ids that name no registered window', [wid(404), wid(3), wid(999), wid(1), wid(2)]],
    ['duplicates — the same id named repeatedly', [wid(3), wid(3), wid(1), wid(1), wid(2)]],
    ['an empty payload', []],
    ['every id, reversed', [wid(11), wid(10), wid(3), wid(2), wid(1)]],
  ];

  for (const [label, payload] of membershipCases) {
    it(`membership is identical before and after: ${label}`, () => {
      const before = restored();
      const after = importOrder(before, payload).state;

      assert.strictEqual(after.order.length, before.order.length, 'no window gained, none lost');
      assert.deepStrictEqual(sortedIds(after), sortedIds(before), 'the same set of ids, whatever the payload said');
      // Not merely equal ids: the very same records. Nothing here constructs a
      // WindowRecord, so a window can neither be replaced by a stub nor lose a
      // lived field to the import.
      for (const record of before.order) {
        assert.ok(after.order.includes(record), `record ${record.id} is the same object, not a rebuilt one`);
      }
    });
  }

  it('an id the payload names but `order` does not hold is silently inert', () => {
    const before = restored();
    const after = importOrder(before, [wid(404), wid(3), wid(1), wid(2)]).state;
    assert.ok(!ids(after).includes(wid(404)), 'the unknown id did not become a member');
    assert.deepStrictEqual(ids(after), [wid(3), wid(1), wid(2), wid(11), wid(10)]);
  });

  it('a repeated id is placed once, at its first occurrence', () => {
    const before = restored();
    const after = importOrder(before, [wid(3), wid(1), wid(3), wid(2), wid(1)]).state;
    assert.deepStrictEqual(ids(after), [wid(3), wid(1), wid(2), wid(11), wid(10)]);
  });

  // ── Where unnamed windows go ─────────────────────────────────────────────

  it('a window the import does not name keeps its index — NOT demoted below the imported set', () => {
    // This kernel's order holds every registered window, so demoting the palette and the HUD
    // beneath every restored page would corrupt the topmost(...)-based queries built on it.
    const before = restored();
    assert.deepStrictEqual(ids(before), [wid(1), wid(2), wid(3), wid(11), wid(10)]);

    const after = importOrder(before, [wid(3), wid(1), wid(2)]).state;

    // The named records were rewritten into the three slots they already
    // occupied (0, 1, 2), in the payload's relative order ...
    assert.deepStrictEqual(ids(after), [wid(3), wid(1), wid(2), wid(11), wid(10)]);
    // ... and the two the payload never mentions did not move at all.
    assert.strictEqual(after.order.indexOf(before.order[3]), 3, 'the HUD kept its index');
    assert.strictEqual(after.order.indexOf(before.order[4]), 4, 'the palette kept its index');
    assert.notDeepStrictEqual(ids(after), [wid(11), wid(10), wid(3), wid(1), wid(2)]);
  });

  it('a partial import permutes only the named slots, leaving the gaps between them alone', () => {
    // ids 1 and 3 sit at slots 0 and 2, with 2 between them. Naming only those
    // two swaps them across the gap; the window in the gap does not shift.
    const before = restored();
    const after = importOrder(before, [wid(3), wid(1)]).state;
    assert.deepStrictEqual(ids(after), [wid(3), wid(2), wid(1), wid(11), wid(10)]);
  });

  // ── What the import drives ────────────────────────────────────────────────

  it('an import emits only the windows the minimal diff needs re-raised, and NO RaiseWindow', () => {
    // An import must never activate anything: react's raise rule diffs State.key, which a
    // permutation never writes. Before this import, order is [1,2,3,11,10]; naming [3,1,2]
    // rewrites those three into the same three slots, so order becomes [3,1,2,11,10] — the
    // stacked-band OS replay 1,2,3,10 only needs 1,2,10 replayed on top of an unmoved 3.
    const before = restored();
    const { state: after, effects } = importOrder(before, [wid(3), wid(1), wid(2)]);

    assert.deepStrictEqual(effects, [
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(2), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(10), layer: BASE_LAYER },
    ]);
    assert.ok(
      !effects.some((e) => e.type === 'RaiseWindow'),
      'a pure reorder raises nothing — a raise here would take key from the palette and show whatever it raised',
    );
    assert.ok(!effects.some((e) => e.type === 'ShowWindow'), 'and shows nothing either');
    assert.strictEqual(after.opSeqCounter, before.opSeqCounter, 'no focus-family op, so no token minted');
  });

  it('an identity import emits nothing — with no guard in evolve making it so', () => {
    const before = restored();
    const identity = importOrder(before, [wid(1), wid(2), wid(3)]);
    assert.deepStrictEqual(identity.effects, [], 'the permutation is the identity, so the order diff is empty');
    assert.deepStrictEqual(ids(identity.state), ids(before));
    // The arm is guard-free like every other, so it still bumps `version`;
    // emitting nothing is a property of `react`'s diff, not an early return.
    assert.strictEqual(identity.state.version, before.version + 1);

    const empty = importOrder(before, []);
    assert.deepStrictEqual(empty.effects, []);
    assert.deepStrictEqual(ids(empty.state), ids(before));
    assert.strictEqual(empty.state.version, before.version + 1);
  });

  it('key is untouched by an import', () => {
    // RULE 2: `OsFocusGained`/`OsFocusLost` are the only writers of `key`.
    const before = restored();
    assert.strictEqual(before.key, wid(10));
    for (const payload of [[wid(3), wid(1), wid(2)], [wid(10), wid(1)], [], [wid(404)]]) {
      const after = importOrder(before, payload).state;
      assert.strictEqual(after.key, wid(10), `key moved on payload ${JSON.stringify(payload)}`);
    }
  });

  it('no record field moves — the import writes positions and nothing else', () => {
    const before = restored();
    const after = importOrder(before, [wid(3), wid(1), wid(2)]).state;
    for (const record of before.order) {
      assert.deepStrictEqual(
        after.order.find((w) => w.id === record.id),
        record,
        `record ${record.id} is unchanged`,
      );
    }
  });

  // The key window is never demoted by an import.

  const twoWindowsKeyOnTop = (): State =>
    fold(
      [
        pageHost(wid(1)),
        pageHost(wid(2)),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'WindowContentOrderable', id: wid(1) },
        { type: 'WindowContentOrderable', id: wid(2) },
        { type: 'OsFocusGained', id: wid(2) },
      ],
      initialState(),
    );

  it('an import naming the key window and one below it never demotes the key window', () => {
    // A slot-preserving permutation naming both ids swaps them, which would otherwise write the
    // key window's record into the lower slot.
    const before = twoWindowsKeyOnTop();
    assert.deepStrictEqual(ids(before), [wid(1), wid(2)]);
    assert.strictEqual(before.key, wid(2));

    const after = importOrder(before, [wid(2), wid(1)]).state;
    assert.deepStrictEqual(ids(after), [wid(1), wid(2)], 'the key window is still topmost');
    assert.strictEqual(after.key, wid(2), 'key is untouched, same as every other import');
  });

  it('an import that does not name the key window still permutes the others, key stays topmost', () => {
    const before = fold(
      [
        pageHost(wid(1)),
        pageHost(wid(2)),
        pageHost(wid(3)),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'WindowShown', id: wid(3) },
        { type: 'WindowContentOrderable', id: wid(1) },
        { type: 'WindowContentOrderable', id: wid(2) },
        { type: 'WindowContentOrderable', id: wid(3) },
        { type: 'OsFocusGained', id: wid(3) },
      ],
      initialState(),
    );
    assert.deepStrictEqual(ids(before), [wid(1), wid(2), wid(3)]);
    assert.strictEqual(before.key, wid(3));

    const after = importOrder(before, [wid(2), wid(1)]).state;
    assert.deepStrictEqual(ids(after), [wid(2), wid(1), wid(3)], 'the two unnamed windows swapped; key stayed on top');
  });

  it('an import with the key window already topmost is unchanged — identity, no effects', () => {
    const before = twoWindowsKeyOnTop();
    const { state: after, effects } = importOrder(before, [wid(2)]);
    assert.deepStrictEqual(ids(after), ids(before));
    assert.deepStrictEqual(effects, [], 'the payload was already the identity permutation');
  });

  it('key null, or naming no live record, permutes exactly as if the lift were not there', () => {
    const before = fold(
      [pageHost(wid(1)), pageHost(wid(2)), { type: 'WindowShown', id: wid(1) }, { type: 'WindowShown', id: wid(2) }],
      initialState(),
    );
    assert.strictEqual(before.key, null, 'nothing has taken key yet');
    const after = importOrder(before, [wid(2), wid(1)]).state;
    assert.deepStrictEqual(ids(after), [wid(2), wid(1)], 'a plain swap, same as before the lift existed');

    // A dangling key (names a since-closed record) is equally inert for the lift.
    const dangling = fold([{ type: 'WindowClosed', id: wid(10) }], restored());
    assert.strictEqual(dangling.key, wid(10));
    assert.ok(!ids(dangling).includes(wid(10)), 'the key id is no longer a member');
    const afterDangling = importOrder(dangling, [wid(3), wid(1)]).state;
    assert.deepStrictEqual(ids(afterDangling), [wid(3), wid(2), wid(1), wid(11)]);
  });

  // ── decide holds the one guard it has ─────────────────────────────────────

  it('decide rejects a stale expectedVersion', () => {
    const state = restored();
    assert.deepStrictEqual(decide(state, { type: 'ImportStackOrder', order: [wid(1)], expectedVersion: state.version + 1 }), {
      rejected: 'stale-version',
    });
  });

  it('decide does NOT reject unknown ids — they are expected traffic, not caller error', () => {
    // `session.ts restoreSessionSnapshot` assembles the payload through
    // `getWindowIdFor` over windows that may have died mid-restore.
    const state = restored();
    const decision = decide(state, {
      type: 'ImportStackOrder',
      order: [wid(404), wid(3), wid(1)],
      expectedVersion: state.version,
    });
    assert.ok('events' in decision, 'accepted');
    assert.deepStrictEqual(decision.events, [{ type: 'StackOrderImported', order: [wid(404), wid(3), wid(1)] }]);

    // A payload naming NOTHING that exists is accepted too, and is inert.
    const allUnknown = decide(state, { type: 'ImportStackOrder', order: [wid(404), wid(999)], expectedVersion: state.version });
    assert.ok('events' in allUnknown);
    const applied = foldWithEffects(allUnknown.events, state);
    assert.deepStrictEqual(ids(applied.state), ids(state));
    assert.deepStrictEqual(applied.effects, []);
  });

  // ── evolve stays total ────────────────────────────────────────────────────

  it('evolve does not throw on an import event, from any state', () => {
    const states: Array<[string, State]> = [
      ['empty', initialState()],
      ['a full restore', restored()],
      ['a dangling key', fold([{ type: 'WindowClosed', id: wid(10) }], restored())],
    ];
    for (const [label, state] of states) {
      let next: State | undefined;
      assert.doesNotThrow(() => {
        next = evolve(state, { type: 'StackOrderImported', order: [wid(3), wid(404), wid(1), wid(3)] });
      }, label);
      assert.strictEqual(next!.version, state.version + 1, 'every event bumps version');
      assert.strictEqual(next!.order.length, state.order.length, `${label}: membership survived`);
    }
  });
});

// ── Arming the cold-start focus latch — the arming half only; spending it has its own block ──

describe('window-kernel: arming the cold-start focus latch', () => {
  const contentWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const restored = (): State =>
    fold(
      [
        contentWindow(wid(1)),
        contentWindow(wid(2)),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'OsFocusGained', id: wid(2) },
      ],
      initialState(),
    );

  const arm = (state: State, id: WindowId | null): { state: State; effects: Effect[] } =>
    foldWithEffects([{ type: 'ColdStartFocusArmed', id }], state);

  it('nothing is armed to begin with, so the arms below are of a real change', () => {
    assert.strictEqual(initialState().pendingColdStartFocus, null);
    assert.strictEqual(restored().pendingColdStartFocus, null);
  });

  it('arming stores the id', () => {
    const before = restored();
    const after = arm(before, wid(2)).state;
    assert.strictEqual(after.pendingColdStartFocus, wid(2));
    assert.strictEqual(after.version, before.version + 1, 'the arm is a transition like any other');
  });

  it('arming null clears a latch a previous arm left behind', () => {
    // `session.ts restoreSessionSnapshot` arms `null` as its first statement,
    // to drop a latch an earlier restore pass armed and never spent, then arms
    // a real id in its post-loop focus block. Both forms have to work, so
    // `null` is a value applied like any other — never a no-op payload.
    const armed = arm(restored(), wid(2)).state;
    assert.strictEqual(armed.pendingColdStartFocus, wid(2), 'a latch really is held first');

    const cleared = arm(armed, null).state;
    assert.strictEqual(cleared.pendingColdStartFocus, null, 'arming null cleared the held latch');
    assert.strictEqual(cleared.version, armed.version + 1);
  });

  it('arming an id absent from `order` stores it anyway', () => {
    // `evolve` is guard-free, and this is the case that needs it: arming runs
    // before the named window is guaranteed live. Whether the window is still
    // there is a question for the moment the latch is spent, not this one.
    const before = restored();
    const after = arm(before, wid(404)).state;
    assert.ok(!before.order.some((w) => w.id === wid(404)), 'the id names no member of `order`');
    assert.strictEqual(after.pendingColdStartFocus, wid(404), 'stored as given, not filtered out');
  });

  it('arming emits no effects — and no rule in `react` makes that true', () => {
    // Nothing in `react` diffs `pendingColdStartFocus`, so arming is silently
    // effect-free by construction: there is no guard, no early return and no
    // `ev.type` branch involved.
    for (const id of [wid(2), wid(404), null]) {
      assert.deepStrictEqual(arm(restored(), id).effects, [], `payload ${String(id)} emitted an effect`);
    }
    // Including the arm that lands on top of an existing latch.
    assert.deepStrictEqual(arm(arm(restored(), wid(1)).state, wid(2)).effects, []);
  });

  it('arming twice keeps the last value — the latch is a slot, not a queue', () => {
    const before = restored();
    const once = arm(before, wid(1)).state;
    const twice = arm(once, wid(2)).state;
    assert.strictEqual(twice.pendingColdStartFocus, wid(2));
    assert.strictEqual(twice.version, before.version + 2, 'both arms are transitions');
  });

  it('key, order and membership are untouched by arming', () => {
    const before = restored();
    assert.strictEqual(before.key, wid(2));

    for (const id of [wid(1), wid(404), null]) {
      const after = arm(before, id).state;
      // RULE 2: `OsFocusGained`/`OsFocusLost` are the only writers of `key`.
      assert.strictEqual(after.key, wid(2), `key moved on payload ${String(id)}`);
      // RULE 1: membership and order are the same structure, and neither moved.
      assert.deepStrictEqual(after.order.map((w) => w.id), before.order.map((w) => w.id));
      for (const record of before.order) {
        assert.ok(after.order.includes(record), `record ${record.id} is the same object, untouched`);
      }
      assert.strictEqual(after.opSeqCounter, before.opSeqCounter, 'no focus-family op, so no token minted');
    }
  });

  // ── decide holds the one guard it has ─────────────────────────────────────

  it('decide rejects a stale expectedVersion', () => {
    const state = restored();
    assert.deepStrictEqual(
      decide(state, { type: 'ArmColdStartFocus', id: wid(2), expectedVersion: state.version + 1 }),
      { rejected: 'stale-version' },
    );
    assert.deepStrictEqual(
      decide(state, { type: 'ArmColdStartFocus', id: null, expectedVersion: state.version + 1 }),
      { rejected: 'stale-version' },
    );
  });

  it('decide does NOT reject an id absent from `order`, and accepts null', () => {
    // The command is answered before the generic unknown-window guard, the same
    // as `ImportStackOrder`: `null` names nothing at all, and a real id names a
    // window that need not be live yet.
    const state = restored();

    const absent = decide(state, { type: 'ArmColdStartFocus', id: wid(404), expectedVersion: state.version });
    assert.ok('events' in absent, 'an id absent from `order` was rejected');
    assert.deepStrictEqual(absent.events, [{ type: 'ColdStartFocusArmed', id: wid(404) }]);

    const clear = decide(state, { type: 'ArmColdStartFocus', id: null, expectedVersion: state.version });
    assert.ok('events' in clear, 'the clear was rejected');
    assert.deepStrictEqual(clear.events, [{ type: 'ColdStartFocusArmed', id: null }]);

    // And the clear really clears once applied through the command path.
    const armed = arm(state, wid(2)).state;
    const decision = decide(armed, { type: 'ArmColdStartFocus', id: null, expectedVersion: armed.version });
    assert.ok('events' in decision);
    assert.strictEqual(fold(decision.events, armed).pendingColdStartFocus, null);
  });

  // ── evolve stays total ────────────────────────────────────────────────────

  it('evolve does not throw on an arm event, from any state', () => {
    const states: Array<[string, State]> = [
      ['empty', initialState()],
      ['a full restore', restored()],
      ['a dangling key', fold([{ type: 'WindowClosed', id: wid(2) }], restored())],
      ['already armed', arm(restored(), wid(1)).state],
    ];
    for (const [label, state] of states) {
      for (const id of [wid(1), wid(404), null]) {
        let next: State | undefined;
        assert.doesNotThrow(() => {
          next = evolve(state, { type: 'ColdStartFocusArmed', id });
        }, `${label} x ${String(id)}`);
        assert.strictEqual(next!.version, state.version + 1, 'every event bumps version');
        assert.strictEqual(next!.pendingColdStartFocus, id);
      }
    }
  });
});

// AppActivated consumes pendingColdStartFocus by clearing it and recording a lastFocusAssert,
// which react's assert rule turns into a raise even when the armed window is already topmost
// and key — the scenario the latch exists for is the model already being right, only the OS wrong.
describe('window-kernel: spending the cold-start focus latch', () => {
  const contentWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const restored = (): State =>
    fold(
      [
        contentWindow(wid(1)),
        contentWindow(wid(2)),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'OsFocusGained', id: wid(2) },
      ],
      initialState(),
    );

  const armed = (id: WindowId | null, start: State = restored()): State =>
    fold([{ type: 'ColdStartFocusArmed', id }], start);

  const activate = (state: State): { state: State; effects: Effect[] } =>
    foldWithEffects([{ type: 'AppActivated' }], state);

  it('an activation with a latch held raises the latched window and clears the latch', () => {
    const before = armed(wid(1));
    const after = activate(before);

    assert.deepStrictEqual(after.effects, [
      { type: 'RaiseWindow', id: wid(1), opSeq: after.state.opSeqCounter },
      { type: 'FocusContent', id: wid(1) },
    ]);
    assert.strictEqual(after.state.pendingColdStartFocus, null, 'the latch was spent');
    assert.strictEqual(after.state.lastFocusAssert?.id, wid(1));
    assert.strictEqual(
      after.state.lastFocusAssert?.seq,
      (before.lastFocusAssert?.seq ?? 0) + 1,
      'the assert seq advanced, which is what `react` diffs',
    );
  });

  it('a latch naming the window that is ALREADY topmost and key still raises it', () => {
    // THE case the latch exists for: a trailing cold-start resign strands the
    // app behind another one while the window model is entirely correct. A
    // consumption that spent the latch by moving the record to the top of
    // `order` would diff to nothing here and emit nothing.
    const before = armed(wid(2));
    assert.strictEqual(topmost(before, () => true)?.id, wid(2), 'the armed window is already on top');
    assert.strictEqual(before.key, wid(2), 'and already key');

    const after = activate(before);
    assert.deepStrictEqual(after.effects, [
      { type: 'RaiseWindow', id: wid(2), opSeq: after.state.opSeqCounter },
      { type: 'FocusContent', id: wid(2) },
    ]);
    assert.deepStrictEqual(
      after.state.order.map((w) => w.id),
      before.order.map((w) => w.id),
      'and `order` did not move — the raise is the fact, not a reorder',
    );
  });

  it('an activation with NO latch emits nothing and does not bump the assert seq', () => {
    // A bumped seq on every activation would project to a spurious raise every time the user
    // comes back to the app.
    const before = restored();
    assert.strictEqual(before.pendingColdStartFocus, null, 'nothing armed');
    const after = activate(before);

    assert.deepStrictEqual(after.effects, []);
    assert.strictEqual(after.state.lastFocusAssert, before.lastFocusAssert, 'the field was not rewritten');
    assert.strictEqual(after.state.opSeqCounter, before.opSeqCounter, 'no op, no token');

    // Also true when an assert already happened, so "unchanged" is a real
    // comparison rather than `null === null`.
    const asserted = fold([{ type: 'FocusAssertRequested', id: wid(1) }], before);
    const seq = asserted.lastFocusAssert!.seq;
    const activated = activate(asserted);
    assert.deepStrictEqual(activated.effects, []);
    assert.strictEqual(activated.state.lastFocusAssert!.seq, seq, 'the seq stood still');
  });

  it('a latch naming a window absent from `order` emits nothing, and is still cleared', () => {
    // No guard in `evolve` makes this so — it is total, and records the request
    // as asked. `react`'s assert rule is gated on the target being in
    // `next.order`, so the no-op falls out of the projection.
    const before = armed(wid(404));
    assert.ok(!before.order.some((w) => w.id === wid(404)), 'the latch names no live window');

    const after = activate(before);
    assert.deepStrictEqual(after.effects, []);
    assert.strictEqual(after.state.opSeqCounter, before.opSeqCounter, 'no effect, no token');
    assert.strictEqual(after.state.pendingColdStartFocus, null, 'spent anyway');
    assert.strictEqual(after.state.lastFocusAssert?.id, wid(404), 'the request is recorded as asked');
  });

  it('the latch is one-shot: a second activation with no re-arm emits nothing', () => {
    const first = activate(armed(wid(1)));
    assert.strictEqual(first.effects.length, 2, 'the first activation spent it');

    const second = activate(first.state);
    assert.deepStrictEqual(second.effects, [], 'nothing left to spend');
    assert.strictEqual(second.state.lastFocusAssert!.seq, first.state.lastFocusAssert!.seq);
    assert.strictEqual(second.state.opSeqCounter, first.state.opSeqCounter);

    // A fresh arm refills it, and the next activation spends that one.
    const third = activate(armed(wid(2), second.state));
    assert.deepStrictEqual(third.effects, [
      { type: 'RaiseWindow', id: wid(2), opSeq: third.state.opSeqCounter },
      { type: 'FocusContent', id: wid(2) },
    ]);
  });

  it('`key` is untouched by the consumption', () => {
    // RULE 2: `OsFocusGained`/`OsFocusLost` are the only writers. `front` is a
    // projection of OS focus, and the focus echo the raise provokes is what
    // moves it — the raise itself does not.
    for (const id of [wid(1), wid(2), wid(404)]) {
      const before = armed(id);
      assert.strictEqual(before.key, wid(2));
      assert.strictEqual(activate(before).state.key, wid(2), `key moved on a latch naming ${id}`);
    }
  });

  it('a latch naming the window THIS activation re-shows: both re-show and raise fire, sharing one token', () => {
    // THE trap case: `react`'s assert rule runs against `next`, i.e. AFTER
    // this same transition's re-show, so a latch naming a window the sweep
    // hid (`hiddenByAppBlur`) must raise it even though `state` (pre-transition)
    // still has it `visible: false`. A predicate that tested only `state`'s
    // `visible` would say "no raise" here while `react` says "raise" — the
    // silent biconditional break this describe's comment warns against.
    const hud: Event = {
      type: 'WindowRegistered',
      id: wid(3),
      kind: 'page-host',
      layer: BASE_LAYER + 1,
      canBecomeKey: false,
      acceptsInput: true,
      class: 'hud',
    };
    const swept = fold([hud, { type: 'WindowShown', id: wid(3) }, { type: 'AppResigned' }, { type: 'AppResignSettled' }], restored());
    const before = swept.order.find((w) => w.id === wid(3))!;
    assert.strictEqual(before.visible, false, 'precondition: the sweep hid it');
    assert.strictEqual(before.hiddenByAppBlur, true, 'precondition: hidden for the reason the latch relies on');

    const armedOnHud = armed(wid(3), swept);
    const after = activate(armedOnHud);

    assert.ok(
      after.effects.some((e) => e.type === 'ShowWindow' && e.id === wid(3)),
      'the sweep hide is undone',
    );
    assert.ok(
      after.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(3)),
      'and the latch still raises it',
    );
    const token = after.state.opSeqCounter;
    assert.strictEqual(token, armedOnHud.opSeqCounter + 1, 'one advance, not one per effect');
    for (const effect of after.effects) {
      if (effect.type === 'ShowWindow' || effect.type === 'RaiseWindow') {
        assert.strictEqual(effect.opSeq, token, `${effect.type} carries the transition's one token`);
      }
    }
    assert.strictEqual(
      after.state.order.find((w) => w.id === wid(3))?.lastOpSeq,
      token,
      'the target is stamped with that same token',
    );
  });

  it('a latch naming a window hidden for a reason OTHER than the app-blur sweep: no raise, no token, latch still cleared', () => {
    // The sweep only re-shows what it hid — a window hidden by some other
    // path (a plain `WindowHidden`) carries no `hiddenByAppBlur` mark, so
    // `appBlurRevealAdmits` refuses it and it stays off screen. The latch
    // must not raise an off-screen window (that is the whole point of the
    // gate), and it is still spent.
    const withDevtools = fold([{ type: 'WindowHidden', id: wid(1) }], restored());
    const before = withDevtools.order.find((w) => w.id === wid(1))!;
    assert.strictEqual(before.visible, false, 'precondition: hidden');
    assert.notStrictEqual(before.hiddenByAppBlur, true, 'precondition: NOT the app-blur reason');

    const armedOnHidden = armed(wid(1), withDevtools);
    const after = activate(armedOnHidden);

    assert.deepStrictEqual(after.effects, [], 'no re-show (nothing to undo) and no raise (still off screen)');
    assert.strictEqual(after.state.opSeqCounter, armedOnHidden.opSeqCounter, 'no op, no token');
    assert.strictEqual(after.state.pendingColdStartFocus, null, 'the latch is spent regardless');
  });

  it('a re-show and the latched raise on one activation share ONE op token', () => {
    // The op-counter biconditional (`window-kernel-properties.test.ts`
    // `checkOpSeqInvariants`): one advance per transition that issues at least
    // one focus-family effect, and every effect carrying that number, stamped
    // on the record it names.
    const swept = fold(
      [
        {
          type: 'WindowRegistered',
          id: wid(3),
          kind: 'page-host',
          layer: BASE_LAYER + 1,
          canBecomeKey: false,
          acceptsInput: true,
          class: 'hud',
        },
        { type: 'WindowShown', id: wid(3) },
        { type: 'AppResigned' },
        { type: 'AppResignSettled' },
      ],
      restored(),
    );
    const before = armed(wid(1), swept);
    const hidden = before.order.filter((w) => w.hiddenByAppBlur === true);
    assert.ok(hidden.length > 0, 'the sweep hid something to re-show');

    const after = activate(before);
    const token = after.state.opSeqCounter;
    assert.strictEqual(token, before.opSeqCounter + 1, 'one advance, not one per effect');
    for (const effect of after.effects) {
      if (effect.type === 'ShowWindow' || effect.type === 'RaiseWindow') {
        assert.strictEqual(effect.opSeq, token, `${effect.type} carries the transition's token`);
        assert.strictEqual(
          after.state.order.find((w) => w.id === effect.id)?.lastOpSeq,
          token,
          `${effect.type} target ${effect.id} is stamped with it`,
        );
      }
    }
    assert.ok(
      after.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)),
      'the raise is in there alongside the re-show',
    );
  });
});

// The switcher selection (State.pendingSelectionFocus): an explicit selection restores focus on
// the switcher's close, a plain dismiss does not.
describe('window-kernel: the switcher selection restores focus on the switcher close', () => {
  const contentWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const switcherOpen = (): State =>
    fold(
      [
        contentWindow(wid(1)),
        contentWindow(wid(2)),
        contentWindow(wid(9)),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
        { type: 'WindowShown', id: wid(9) },
        { type: 'OsFocusGained', id: wid(9) },
      ],
      initialState(),
    );

  const armSelection = (state: State, target: WindowId | null): State =>
    fold([{ type: 'SelectionFocusArmed', armer: wid(9), target }], state);

  const closeSwitcher = (state: State): { state: State; effects: Effect[] } =>
    foldWithEffects([{ type: 'WindowClosed', id: wid(9) }], state);

  it('nothing is armed to begin with', () => {
    assert.strictEqual(initialState().pendingSelectionFocus, null);
    assert.strictEqual(switcherOpen().pendingSelectionFocus, null);
  });

  it('arming stores the armer and the target as a pair', () => {
    const before = switcherOpen();
    const after = armSelection(before, wid(1));
    assert.deepStrictEqual(after.pendingSelectionFocus, { armer: wid(9), target: wid(1) });
    assert.strictEqual(after.version, before.version + 1, 'the arm is a transition like any other');
  });

  it('arming emits no effects — the raise waits for the close', () => {
    // Nothing in `react` diffs `pendingSelectionFocus`, so the arm is
    // effect-free by construction rather than by a guard. Picking a window in
    // the switcher must not raise it while the switcher is still up.
    const { effects } = foldWithEffects(
      [{ type: 'SelectionFocusArmed', armer: wid(9), target: wid(1) }],
      switcherOpen(),
    );
    assert.deepStrictEqual(effects, []);
  });

  it('arming null clears a selection the user moved off', () => {
    // The switcher re-arms as the highlight moves and clears on dismissal, so
    // `null` is a value applied like any other — never a no-op payload.
    const armed = armSelection(switcherOpen(), wid(1));
    assert.notStrictEqual(armed.pendingSelectionFocus, null, 'a selection really is held first');
    const cleared = armSelection(armed, null);
    assert.strictEqual(cleared.pendingSelectionFocus, null);
  });

  it('closing the switcher with a selection armed raises the selected window', () => {
    const after = closeSwitcher(armSelection(switcherOpen(), wid(1)));
    assert.ok(
      after.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)),
      'the selected window is raised',
    );
    assert.ok(
      after.effects.some((e) => e.type === 'FocusContent' && e.id === wid(1)),
      'and its content takes first responder, which the old bare focus() call did not do',
    );
    assert.strictEqual(after.state.pendingSelectionFocus, null, 'the latch is one-shot');
  });

  it('closing the switcher with NO selection raises nothing — a plain dismiss', () => {
    // This is the whole point of recording the selection rather than reaching
    // for the previously-focused window: raising it would drag the user to
    // whatever desktop it happens to be anchored to.
    const after = closeSwitcher(switcherOpen());
    assert.ok(
      !after.effects.some((e) => e.type === 'RaiseWindow'),
      'no raise on a dismiss',
    );
  });

  it('a selection survives an unrelated window closing', () => {
    // The spend is keyed on the ARMER's removal, not on any close.
    const armed = armSelection(switcherOpen(), wid(1));
    const other = fold([{ type: 'WindowClosed', id: wid(2) }], armed);
    assert.deepStrictEqual(other.pendingSelectionFocus, { armer: wid(9), target: wid(1) });
    assert.ok(
      closeSwitcher(other).effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)),
      'and is still spent when the switcher itself goes',
    );
  });

  it('a target that died while the switcher was open raises nothing', () => {
    // The arm is deliberately unguarded on the target, so the spend is where
    // liveness is asked — and the answer is the same as a plain dismiss.
    const armed = armSelection(switcherOpen(), wid(1));
    const gone = fold([{ type: 'WindowClosed', id: wid(1) }], armed);
    const after = closeSwitcher(gone);
    assert.ok(!after.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)));
    assert.strictEqual(after.state.pendingSelectionFocus, null, 'and the latch is still spent');
  });

  it('the switcher closing twice cannot restore focus twice', () => {
    const armed = armSelection(switcherOpen(), wid(1));
    const once = closeSwitcher(armed);
    const twice = closeSwitcher(once.state);
    assert.ok(once.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)));
    assert.ok(!twice.effects.some((e) => e.type === 'RaiseWindow' && e.id === wid(1)));
  });

  it('`decide` refuses to arm against a switcher the kernel does not have', () => {
    // The latch is spent by the armer's own `WindowClosed` and by nothing
    // else, so an unregistered armer would leave one nothing can ever spend.
    const state = switcherOpen();
    const result = decide(state, {
      type: 'ArmSelectionFocus',
      armer: wid(404),
      target: wid(1),
      expectedVersion: state.version,
    });
    assert.deepStrictEqual(result, { rejected: 'no-such-window' });
  });

  it('`decide` accepts a target the kernel does not have', () => {
    // The mirror of the case above: the target is a note to be read later, and
    // its liveness is the spend's question.
    const state = switcherOpen();
    const result = decide(state, {
      type: 'ArmSelectionFocus',
      armer: wid(9),
      target: wid(404),
      expectedVersion: state.version,
    });
    assert.deepStrictEqual(result, {
      events: [{ type: 'SelectionFocusArmed', armer: wid(9), target: wid(404) }],
    });
  });
});

// State.openedInBackground — the one session fact the Escape decider needs.
describe('window-kernel: whether Peek came up while the user was in another app', () => {
  const contentWindow = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  it('starts false — no windows yet means no session to describe', () => {
    assert.strictEqual(initialState().openedInBackground, false);
  });

  it('a first window opening while the user is elsewhere sets it', () => {
    const state = fold([{ type: 'AppResigned' }, contentWindow(wid(1))]);
    assert.strictEqual(state.openedInBackground, true);
  });

  it('a first window opening while the user is in Peek does not', () => {
    const state = fold([{ type: 'AppActivated' }, contentWindow(wid(1))]);
    assert.strictEqual(state.openedInBackground, false);
  });

  it('the user arriving in Peek clears it — the one-way ratchet', () => {
    const background = fold([{ type: 'AppResigned' }, contentWindow(wid(1))]);
    assert.strictEqual(background.openedInBackground, true);
    const arrived = fold([{ type: 'AppActivated' }], background);
    assert.strictEqual(arrived.openedInBackground, false);
  });

  it('leaving Peek again does NOT set it back — the ratchet only turns one way', () => {
    // The session became the user's when they arrived; going away to another
    // app does not make it incidental again. `izui-state.ts evaluateOnShow`
    // states the same rule: "active -> transient is not allowed".
    const arrived = fold(
      [{ type: 'AppResigned' }, contentWindow(wid(1)), { type: 'AppActivated' }],
    );
    const left = fold([{ type: 'AppResigned' }], arrived);
    assert.strictEqual(left.openedInBackground, false);
  });

  it('a later window opening while the user is in Peek clears it too', () => {
    // The coordinator ratchets on a window open as well as on app focus, so
    // both edges are here.
    const background = fold([{ type: 'AppResigned' }, contentWindow(wid(1))]);
    const foreground = fold([{ type: 'AppActivated' }, contentWindow(wid(2))], background);
    assert.strictEqual(foreground.openedInBackground, false);
  });

  it('a later window opening while the user is still elsewhere leaves it alone', () => {
    const state = fold(
      [{ type: 'AppResigned' }, contentWindow(wid(1)), contentWindow(wid(2))],
    );
    assert.strictEqual(state.openedInBackground, true);
  });

  it('a later window cannot re-set it once the user has arrived', () => {
    const arrived = fold(
      [{ type: 'AppResigned' }, contentWindow(wid(1)), { type: 'AppActivated' }],
    );
    const afterLeaving = fold([{ type: 'AppResigned' }, contentWindow(wid(2))], arrived);
    assert.strictEqual(afterLeaving.openedInBackground, false, 'still the session the user arrived in');
  });

  it('the last window closing resets it — that session is over', () => {
    const background = fold([{ type: 'AppResigned' }, contentWindow(wid(1))]);
    assert.strictEqual(background.openedInBackground, true);
    const empty = fold([{ type: 'WindowClosed', id: wid(1) }], background);
    assert.strictEqual(empty.order.length, 0);
    assert.strictEqual(empty.openedInBackground, false);
  });

  it('closing a window that is not the last leaves it alone', () => {
    const state = fold(
      [{ type: 'AppResigned' }, contentWindow(wid(1)), contentWindow(wid(2))],
    );
    const after = fold([{ type: 'WindowClosed', id: wid(2) }], state);
    assert.strictEqual(after.order.length, 1);
    assert.strictEqual(after.openedInBackground, true);
  });

  it('a fresh session after an empty gap gets its own answer', () => {
    // The reset is what makes this work: the second session is described by
    // its own first window, not by whatever the first session ended on.
    const first = fold(
      [{ type: 'AppResigned' }, contentWindow(wid(1)), { type: 'WindowClosed', id: wid(1) }],
    );
    assert.strictEqual(first.openedInBackground, false, 'reset by the empty order');
    const second = fold([contentWindow(wid(2))], first);
    assert.strictEqual(second.openedInBackground, true, 'the app is still not active, so this one is background again');
  });

  it('re-registering an existing window never touches it', () => {
    // A re-registration is a merge, not an open — `ipc.ts` does it routinely.
    const state = fold([{ type: 'AppActivated' }, contentWindow(wid(1)), { type: 'AppResigned' }]);
    assert.strictEqual(state.openedInBackground, false);
    const again = fold([contentWindow(wid(1))], state);
    assert.strictEqual(again.openedInBackground, false, 'a merge is not a window opening');
  });
});

// The app steps aside (a react rule, so every close route reaches it) when nothing of Peek's is
// left on screen.
describe('window-kernel: handing the user back when nothing is left on screen', () => {
  const reg = (id: WindowId, cls: string): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: cls,
    role: 'content',
  });

  const hidesApp = (effects: Effect[]): boolean => effects.some((e) => e.type === 'HideApp');

  it('closing the only window on screen hides the app', () => {
    const state = fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }]);
    const after = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], state);
    assert.ok(hidesApp(after.effects));
  });

  it('hiding the only window on screen hides the app too — a keepLive window still empties it', () => {
    const state = fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }]);
    const after = foldWithEffects([{ type: 'WindowHidden', id: wid(1) }], state);
    assert.ok(hidesApp(after.effects));
  });

  it('closing one of two leaves the app where it is', () => {
    const state = fold([
      reg(wid(1), 'primary'),
      reg(wid(2), 'primary'),
      { type: 'WindowShown', id: wid(1) },
      { type: 'WindowShown', id: wid(2) },
    ]);
    const after = foldWithEffects([{ type: 'WindowClosed', id: wid(2) }], state);
    assert.ok(!hidesApp(after.effects), 'the user can still see window 1');
  });

  it('a background, quick-view, palette, overlay or hud window never held the app open', () => {
    // So closing the real window while one of these is up still empties the
    // screen as far as this rule is concerned.
    for (const cls of ['background', 'quick-view', 'palette', 'overlay', 'hud']) {
      const state = fold([
        reg(wid(1), 'primary'),
        reg(wid(2), cls),
        { type: 'WindowShown', id: wid(1) },
        { type: 'WindowShown', id: wid(2) },
      ]);
      const after = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], state);
      assert.ok(hidesApp(after.effects), `${cls} should not hold the app open`);
    }
  });

  it('the switcher closing never hides the app — the old special case, now falling out of the rule', () => {
    // `windows.ts` wrote this as a named exemption. Here the switcher's class
    // is one that never held the app open, so its close cannot take the count
    // from some to none and there is nothing to exempt.
    const state = fold([reg(wid(9), 'overlay'), { type: 'WindowShown', id: wid(9) }]);
    const after = foldWithEffects([{ type: 'WindowClosed', id: wid(9) }], state);
    assert.ok(!hidesApp(after.effects));
  });

  it('the hide is issued once, not on every later transition', () => {
    // Both halves of the diff are load-bearing. Without the "was some" half,
    // every transition in an already-empty app would re-issue it.
    const emptied = foldWithEffects(
      [{ type: 'WindowClosed', id: wid(1) }],
      fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }]),
    );
    assert.ok(hidesApp(emptied.effects));
    const later = foldWithEffects([{ type: 'AppResigned' }], emptied.state);
    assert.ok(!hidesApp(later.effects), 'nothing left to empty, so nothing to do');
  });

  it('a teardown REQUEST does not hide the app — only the window actually going does', () => {
    // The window is still on screen when a teardown is requested, and the app
    // must not step aside while the user can still see it. A request that never
    // completes would otherwise have hidden the app for nothing.
    const state = fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }]);
    const requested = foldWithEffects([{ type: 'WindowDestroyRequested', id: wid(1) }], state);
    assert.ok(!hidesApp(requested.effects), 'still visible');
    const gone = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], requested.state);
    assert.ok(hidesApp(gone.effects), 'and now it is not');
  });

  it('a window that was never shown closing hides nothing — it was not holding the app open', () => {
    const state = fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }, reg(wid(2), 'primary')]);
    const after = foldWithEffects([{ type: 'WindowClosed', id: wid(2) }], state);
    assert.ok(!hidesApp(after.effects));
  });

  it('the effect names no window at all', () => {
    const state = fold([reg(wid(1), 'primary'), { type: 'WindowShown', id: wid(1) }]);
    const after = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], state);
    assert.deepStrictEqual(after.effects.filter((e) => e.type === 'HideApp'), [{ type: 'HideApp' }]);
  });
});

describe('window-kernel: a page asked forward while the app is inactive is held above other apps', () => {
  const page = (id: WindowId, extra: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...extra,
  });
  const record = (state: State, id: WindowId): WindowRecord => state.order.find((w) => w.id === id)!;
  const holds = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'HoldAboveOtherApps');
  const releases = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'ReleaseFromAboveOtherApps');

  // An open that asks to come forward is a show followed by a raise request;
  // session restore and any `show: false` open is the show alone.
  const openForward = (id: WindowId, extra?: Partial<Extract<Event, { type: 'WindowRegistered' }>>): Event[] => [
    page(id, extra),
    { type: 'WindowShown', id },
    { type: 'FocusRaiseRequested', id },
  ];

  it('holds the page when the raise request arrives with the app inactive', () => {
    const after = foldWithEffects([{ type: 'AppResigned' }, ...openForward(wid(1))]);
    assert.strictEqual(record(after.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(holds(after.effects), [{ type: 'HoldAboveOtherApps', id: wid(1) }]);
    assert.deepStrictEqual(releases(after.effects), []);
    // The hold takes nothing: the app stays inactive and no window becomes key.
    assert.strictEqual(after.state.appActive, false);
    assert.strictEqual(after.state.key, null);
    assert.strictEqual(record(after.state, wid(1)).layer, BASE_LAYER, 'the declared layer is untouched');
  });

  it('a show with no raise request holds nothing — session restore and show:false opens', () => {
    const after = foldWithEffects([{ type: 'AppResigned' }, page(wid(1)), { type: 'WindowShown', id: wid(1) }]);
    assert.notStrictEqual(record(after.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(holds(after.effects), []);
  });

  it('holds nothing while the app is active', () => {
    const after = foldWithEffects(openForward(wid(1)));
    assert.notStrictEqual(record(after.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(holds(after.effects), []);
  });

  it('a raise carrying user intent activates the app instead, so nothing is held', () => {
    const after = foldWithEffects([
      { type: 'AppResigned' },
      page(wid(1)),
      { type: 'WindowShown', id: wid(1) },
      { type: 'FocusRaiseRequested', id: wid(1), intent: 'user' },
    ]);
    assert.notStrictEqual(record(after.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(holds(after.effects), []);
  });

  it('only a visible base-layer content page is held', () => {
    const cases: Array<[string, Event[]]> = [
      ['a palette', openForward(wid(1), { role: 'palette', class: 'palette' })],
      ['a quick-view', openForward(wid(1), { role: 'quick-view', class: 'quick-view' })],
      ['a browser-kind window', openForward(wid(1), { kind: 'browser' })],
      ['a window already above the base layer', openForward(wid(1), { layer: BASE_LAYER + 1 })],
      ['a window that cannot become key', openForward(wid(1), { canBecomeKey: false })],
      ['a page that is not on screen', [page(wid(1)), { type: 'FocusRaiseRequested', id: wid(1) }]],
    ];
    for (const [label, events] of cases) {
      const after = foldWithEffects([{ type: 'AppResigned' }, ...events]);
      assert.notStrictEqual(record(after.state, wid(1)).heldAboveOtherApps, true, label);
      assert.deepStrictEqual(holds(after.effects), [], label);
    }
  });

  it('a second raise request on a held page issues no second hold', () => {
    const held = fold([{ type: 'AppResigned' }, ...openForward(wid(1))]);
    const again = foldWithEffects([{ type: 'FocusRaiseRequested', id: wid(1) }], held);
    assert.strictEqual(record(again.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(holds(again.effects), []);
  });

  it('app activation releases every held page, and only those', () => {
    const held = fold([
      page(wid(9)),
      { type: 'WindowShown', id: wid(9) },
      { type: 'AppResigned' },
      ...openForward(wid(1)),
      ...openForward(wid(2)),
    ]);
    const after = foldWithEffects([{ type: 'AppActivated' }], held);
    for (const w of after.state.order) {
      assert.notStrictEqual(w.heldAboveOtherApps, true, String(w.id));
      assert.strictEqual(w.visible, true, 'the same window stays on screen');
    }
    assert.deepStrictEqual(
      releases(after.effects).map((e) => ('id' in e ? e.id : null)).sort(),
      [wid(1), wid(2)],
    );
    // Released once: a later activation has nothing left to release.
    const later = foldWithEffects([{ type: 'AppResigned' }, { type: 'AppActivated' }], after.state);
    assert.deepStrictEqual(releases(later.effects), []);
  });

  it('the app-resign sweep neither hides nor dismisses a held page, and it still holds the app on screen', () => {
    // The resign half of the dance, the open, then the settle.
    const after = foldWithEffects([{ type: 'AppResigned' }, ...openForward(wid(1)), { type: 'AppResignSettled' }]);
    const held = record(after.state, wid(1));
    assert.strictEqual(held.visible, true);
    assert.notStrictEqual(held.pendingHidden, true);
    assert.notStrictEqual(held.hiddenByAppBlur, true);
    assert.strictEqual(held.heldAboveOtherApps, true);
    assert.strictEqual(isAppResignSweepEligible(held), false);
    assert.strictEqual(holdsAppOnScreen(held), true);
    assert.deepStrictEqual(selectTransientAutoclose(after.state, null), []);
    assert.ok(!after.effects.some((e) => e.type === 'HideWindow' || e.type === 'DismissWindow' || e.type === 'HideApp'));
  });

  it('a held page going off screen is released, so a later show does not float', () => {
    const held = fold([{ type: 'AppResigned' }, ...openForward(wid(1))]);
    const hidden = foldWithEffects([{ type: 'WindowHidden', id: wid(1) }], held);
    assert.notStrictEqual(record(hidden.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual(releases(hidden.effects), [{ type: 'ReleaseFromAboveOtherApps', id: wid(1) }]);
    const reshown = foldWithEffects([{ type: 'WindowShown', id: wid(1) }], hidden.state);
    assert.deepStrictEqual(holds(reshown.effects), []);
  });

  it('a held page closing issues no release — there is no window left to restack', () => {
    const held = fold([{ type: 'AppResigned' }, ...openForward(wid(1))]);
    const closed = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], held);
    assert.deepStrictEqual(releases(closed.effects), []);
  });

  it('a re-registration keeps the hold — it is a lived fact, not a declared one', () => {
    const held = fold([{ type: 'AppResigned' }, ...openForward(wid(1))]);
    const again = foldWithEffects([page(wid(1))], held);
    assert.strictEqual(record(again.state, wid(1)).heldAboveOtherApps, true);
    assert.deepStrictEqual([...holds(again.effects), ...releases(again.effects)], []);
  });
});

// A fresh window built already-visible (non-headless: `winOptions.show: true`
// at construction) is reported shown+focused at registration before its
// caller's own intent-carrying raise request ever runs (`window-machine.ts
// registerWindowWithMachine`'s `pumpShownEvent`, driven by the native window
// already being visible) — so by the time the raise request lands, `key`
// already names the window and the raise-request diff's own-op-request guard
// (`next.key !== raiseRequest.id`) read it as a no-op and dropped the raise
// outright. Headless never hits this: a headless window is always built
// `show: false`, so `pumpShownEvent` never fires and `key` is still null when
// the raise request lands — the branch below is unreached under headless,
// which is why the palette's fresh-open spec passed while a real display
// still suppressed the raise.
describe('window-kernel: a user-intent raise is never redundant while the app is inactive', () => {
  // The pumped report's own `OsFocusGained` is a genuine key change (null ->
  // the window), so it mints its own no-intent `RaiseWindow` via the
  // key-change rule above — the one the executor's `planRaise` answers
  // `raise-suppressed` for on a real display. That effect is expected and
  // belongs to a different rule than the one under test here; isolating just
  // the final `FocusRaiseRequested` transition's own effects keeps this test
  // about the raise-request diff alone.
  const registerShownFocused = (extra: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette', ...extra },
    // The automatic pumped report: WindowShown + OsFocusGained, with no
    // intent, exactly what `kernelWindowShown(id, true)` dispatches.
    { type: 'WindowShown', id: wid(1) },
    { type: 'OsFocusGained', id: wid(1) },
  ];

  it('is honoured even though the window already holds key from an earlier, intent-less shown+focused report', () => {
    const before = fold([{ type: 'AppResigned' }, ...registerShownFocused()]);
    assert.strictEqual(before.key, wid(1), 'precondition: the pumped report already made it key');
    // The caller's own intent-carrying ask, arriving after — the window is
    // already key by the time this lands.
    const raiseEv: Event = { type: 'FocusRaiseRequested', id: wid(1), intent: 'user' };
    const after = evolve(before, raiseEv);
    assert.deepStrictEqual(
      react(before, raiseEv, after).filter((e) => e.type === 'RaiseWindow'),
      [{ type: 'RaiseWindow', id: wid(1), opSeq: after.opSeqCounter, intent: 'user' }],
      'the user-intent raise is not swallowed by the already-key no-op guard',
    );
  });

  it('an intent-less raise on an already-key window is still the no-op it always was', () => {
    const before = fold([{ type: 'AppResigned' }, ...registerShownFocused()]);
    const raiseEv: Event = { type: 'FocusRaiseRequested', id: wid(1) };
    const after = evolve(before, raiseEv);
    assert.deepStrictEqual(
      react(before, raiseEv, after).filter((e) => e.type === 'RaiseWindow'),
      [],
      'no intent means the exception does not apply',
    );
  });

  it('an already-key user-intent raise issues no second raise once the app is active — appActive alone does not gate it', () => {
    // Not the reported scenario (the app is active, so nothing was ever
    // suppressed), but the guard reads `next.appActive` explicitly and must
    // not accidentally admit every already-key raise once active.
    const before = fold(registerShownFocused());
    assert.strictEqual(before.appActive, true, 'precondition: active by default, no AppResigned here');
    const raiseEv: Event = { type: 'FocusRaiseRequested', id: wid(1), intent: 'user' };
    const after = evolve(before, raiseEv);
    assert.deepStrictEqual(
      react(before, raiseEv, after).filter((e) => e.type === 'RaiseWindow'),
      [],
      'the app is active, so the already-key guard applies as before',
    );
  });
});

describe('window-kernel: a transient page-host window closes outright whenever it stops holding key, including the app coming forward while it holds key (window-rules.md G13)', () => {
  const sidePage = (id: WindowId, extra: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    nonActivating: true,
    ...extra,
  });
  const palette = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'browser',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'palette',
    role: 'palette',
    nonActivating: true,
  });
  const record = (state: State, id: WindowId): WindowRecord => state.order.find((w) => w.id === id)!;
  const dismisses = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'DismissWindow');

  // A transient page-host window in flight: the app inactive, the page shown, raised with user
  // intent from the palette, and confirmed key by the OS.
  const transientPageHostHoldingKey = (id: WindowId, extra?: Partial<Extract<Event, { type: 'WindowRegistered' }>>): State =>
    fold([
      { type: 'AppResigned' },
      sidePage(id, extra),
      { type: 'WindowShown', id },
      { type: 'FocusRaiseRequested', id, intent: 'user' },
      { type: 'OsFocusGained', id },
    ]);

  it('the fixture is a transient page-host window', () => {
    const state = transientPageHostHoldingKey(wid(1));
    assert.strictEqual(state.appActive, false);
    assert.strictEqual(state.key, wid(1));
    assert.strictEqual(isTransientPageHost(state, record(state, wid(1))), true);
  });

  it('losing key with the app still inactive closes the page', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const after = foldWithEffects([{ type: 'OsFocusLost', id: wid(1) }], before);
    assert.deepStrictEqual(dismisses(after.effects), [{ type: 'DismissWindow', id: wid(1) }]);
    assert.strictEqual(after.state.appActive, false, 'the other app keeps focus');
    assert.strictEqual(isTransientPageHost(after.state, record(after.state, wid(1))), false);
  });

  it('the app activating while the page is key closes it too', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const after = foldWithEffects([{ type: 'AppActivated' }], before);
    assert.deepStrictEqual(dismisses(after.effects), [{ type: 'DismissWindow', id: wid(1) }]);
  });

  it('key moving to the palette (the hotkey pressed again) ends the transient page-host window', () => {
    const before = fold([palette(wid(9))], transientPageHostHoldingKey(wid(1)));
    const after = foldWithEffects([{ type: 'WindowShown', id: wid(9) }, { type: 'OsFocusGained', id: wid(9) }], before);
    assert.deepStrictEqual(dismisses(after.effects), [{ type: 'DismissWindow', id: wid(1) }]);
  });

  it('emits once: a second focus-lost report for the same window closes nothing further', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const first = foldWithEffects([{ type: 'OsFocusLost', id: wid(1) }], before);
    const second = foldWithEffects([{ type: 'OsFocusLost', id: wid(1) }, { type: 'AppActivated' }], first.state);
    assert.strictEqual(dismisses(first.effects).length, 1);
    assert.deepStrictEqual(dismisses(second.effects), []);
  });

  it('a palette losing key is not a transient page-host window and closes nothing', () => {
    const before = fold([
      { type: 'AppResigned' },
      palette(wid(9)),
      { type: 'WindowShown', id: wid(9) },
      { type: 'FocusRaiseRequested', id: wid(9), intent: 'user' },
      { type: 'OsFocusGained', id: wid(9) },
    ]);
    assert.strictEqual(before.key, wid(9));
    const after = foldWithEffects([{ type: 'OsFocusLost', id: wid(9) }], before);
    assert.deepStrictEqual(dismisses(after.effects), []);
  });

  it('an ordinary page losing key with the app inactive closes nothing — only a non-activating one is a transient page-host window', () => {
    const before = transientPageHostHoldingKey(wid(1), { nonActivating: undefined });
    assert.strictEqual(isTransientPageHost(before, record(before, wid(1))), false);
    const after = foldWithEffects([{ type: 'OsFocusLost', id: wid(1) }], before);
    assert.deepStrictEqual(dismisses(after.effects), []);
  });

  it('a transient page-host window that closes or hides in the same transition is not dismissed twice — Escape and a close request end it outright', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const closed = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], before);
    assert.deepStrictEqual(dismisses(closed.effects), []);
    const hidden = foldWithEffects([{ type: 'WindowHidden', id: wid(1) }], before);
    assert.deepStrictEqual(dismisses(hidden.effects), []);
  });

  // A desktop switch (row 5d) ends the page as a loss of focus, whichever
  // order the platform reports the switch, the loss of key and an app
  // activation in.
  it('a desktop switch closes the page, and an activation that follows it does nothing further', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const switched = foldWithEffects([{ type: 'DesktopSwitchObserved' }], before);
    assert.deepStrictEqual(dismisses(switched.effects), [{ type: 'DismissWindow', id: wid(1) }]);
    const activated = foldWithEffects([{ type: 'AppActivated' }], switched.state);
    assert.deepStrictEqual(dismisses(activated.effects), []);
  });

  it('a desktop switch then a loss of key closes the page once', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const after = foldWithEffects([
      { type: 'DesktopSwitchObserved' },
      { type: 'OsFocusLost', id: wid(1) },
    ], before);
    assert.deepStrictEqual(dismisses(after.effects), [{ type: 'DismissWindow', id: wid(1) }]);
  });

  it('a loss of key then a desktop switch closes the page once', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const after = foldWithEffects([
      { type: 'OsFocusLost', id: wid(1) },
      { type: 'DesktopSwitchObserved' },
    ], before);
    assert.deepStrictEqual(dismisses(after.effects), [{ type: 'DismissWindow', id: wid(1) }]);
  });

  it('a desktop switch after the page already closed at activation dismisses nothing further', () => {
    const before = transientPageHostHoldingKey(wid(1));
    const activated = foldWithEffects([{ type: 'AppActivated' }], before);
    const switched = foldWithEffects([{ type: 'DesktopSwitchObserved' }], activated.state);
    assert.deepStrictEqual(dismisses(switched.effects), []);
  });

  // F7 and row 5e: a page opened from the palette over another app took key
  // from that app through the palette, so its close raises no Peek window —
  // not the palette it took key from, and not the topmost page as a fallback.
  const raises = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'RaiseWindow');
  const openedFromPaletteOverAnotherApp = (): State =>
    fold([
      sidePage(wid(5), { nonActivating: undefined }),
      { type: 'WindowShown', id: wid(5) },
      { type: 'OsFocusGained', id: wid(5) },
      { type: 'OsFocusLost', id: wid(5) },
      { type: 'AppResigned' },
      palette(wid(9)),
      { type: 'WindowShown', id: wid(9) },
      { type: 'FocusRaiseRequested', id: wid(9), intent: 'user' },
      { type: 'OsFocusGained', id: wid(9) },
      sidePage(wid(1)),
      { type: 'WindowShown', id: wid(1) },
      { type: 'FocusRaiseRequested', id: wid(1), intent: 'user' },
      { type: 'OsFocusGained', id: wid(1) },
      { type: 'WindowHidden', id: wid(9) },
    ]);

  it('the page closing after the app comes forward raises no other Peek window', () => {
    const before = openedFromPaletteOverAnotherApp();
    assert.strictEqual(record(before, wid(1)).priorKey, wid(9));
    const activated = foldWithEffects([{ type: 'AppActivated' }], before);
    assert.deepStrictEqual(dismisses(activated.effects), [{ type: 'DismissWindow', id: wid(1) }]);
    const closed = foldWithEffects([{ type: 'WindowClosed', id: wid(1) }], activated.state);
    assert.deepStrictEqual(raises(closed.effects), []);
    assert.deepStrictEqual(closed.state.lastRaiseRequest, activated.state.lastRaiseRequest);
  });

  it('the page closing after a desktop switch and then an activation raises no other Peek window', () => {
    const before = openedFromPaletteOverAnotherApp();
    const after = foldWithEffects([
      { type: 'DesktopSwitchObserved' },
      { type: 'AppActivated' },
      { type: 'WindowClosed', id: wid(1) },
    ], before);
    assert.deepStrictEqual(raises(after.effects), []);
    assert.deepStrictEqual(after.state.lastRaiseRequest, before.lastRaiseRequest);
  });
});

// specs/kernel-desktops.md → "Model" and "7.1 Automated tests", desktop state.
describe('window-kernel: desktop state', () => {
  const page = (n: number, extra: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {}): Event => ({
    type: 'WindowRegistered',
    id: wid(n),
    kind: 'page-host',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...extra,
  });
  const desktopOf = (state: State, n: number): string | undefined => windowById(state, wid(n))?.desktop;
  // Two screens, `A` showing desktop `a1` and `B` showing `b1`; `a2` and `b2` not shown.
  const layout: Event = {
    type: 'DesktopLayoutReported',
    screens: [{ id: 'A', current: 'a1' }, { id: 'B', current: 'b1' }],
    desktops: [{ id: 'a1', screen: 'A' }, { id: 'a2', screen: 'A' }, { id: 'b1', screen: 'B' }, { id: 'b2', screen: 'B' }],
  };
  const switchTo = (screen: string, desktop: string): Event => ({ type: 'CurrentDesktopChanged', screen, desktop });
  const place = (n: number, screen: string | null, desktop: string | null, onEveryDesktop = false): Event => ({
    type: 'WindowPlacementReported', id: wid(n), screen, desktop, onEveryDesktop,
  });

  it('starts with no screens and no desktops', () => {
    assert.deepStrictEqual(initialState().screens, []);
    assert.deepStrictEqual(initialState().desktops, []);
  });

  it('a layout report replaces screens and desktops', () => {
    const first = evolve(initialState(), layout);
    const second = evolve(first, { type: 'DesktopLayoutReported', screens: [{ id: 'A', current: 'a2' }], desktops: [{ id: 'a2', screen: 'A' }] });
    assert.deepStrictEqual(second.screens, [{ id: 'A', current: 'a2' }]);
    assert.deepStrictEqual(second.desktops, [{ id: 'a2', screen: 'A' }]);
  });

  it('a current-desktop change writes one screen, never key, and emits no effect', () => {
    const before = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }, { type: 'OsFocusGained', id: wid(1) }]);
    const ev = switchTo('A', 'a2');
    const next = evolve(before, ev);
    assert.deepStrictEqual(next.screens, [{ id: 'A', current: 'a2' }, { id: 'B', current: 'b1' }]);
    assert.strictEqual(next.key, before.key);
    assert.deepStrictEqual(react(before, ev, next), []);
  });

  it('a current-desktop change for an unknown screen adds it', () => {
    const next = fold([layout, switchTo('C', 'c1')]);
    assert.deepStrictEqual(next.screens.map((s) => s.id), ['A', 'B', 'C']);
  });

  it('a desktop switch with no transient page-host window changes nothing but the version', () => {
    const before = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }]);
    const next = evolve(before, { type: 'DesktopSwitchObserved' });
    assert.deepStrictEqual(next.order, before.order);
    assert.deepStrictEqual(next.screens, before.screens);
    assert.strictEqual(next.version, before.version + 1);
  });

  it('from a switch notice until a read covering it, only an every-desktop window is on a current desktop', () => {
    const before = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }, page(2, { onEveryDesktop: true }), { type: 'WindowShown', id: wid(2) }]);
    assert.strictEqual(onCurrentDesktop(before, windowById(before, wid(1))!), true, 'precondition');
    const switched = evolve(before, { type: 'DesktopSwitchObserved' });
    assert.strictEqual(desktopUnread(switched), true);
    assert.strictEqual(onCurrentDesktop(switched, windowById(switched, wid(1))!), false);
    assert.strictEqual(onCurrentDesktop(switched, windowById(switched, wid(2))!), true);
    const read = evolve(switched, { type: 'DesktopsRead', switchesSeen: switched.desktopSwitchCount });
    assert.strictEqual(desktopUnread(read), false);
    assert.strictEqual(onCurrentDesktop(read, windowById(read, wid(1))!), true);
  });

  it('a read that began before the latest switch notice leaves the desktop unread', () => {
    const once = fold([layout, { type: 'DesktopSwitchObserved' }]);
    const twice = evolve(once, { type: 'DesktopSwitchObserved' });
    const staleRead = evolve(twice, { type: 'DesktopsRead', switchesSeen: once.desktopSwitchCount });
    assert.strictEqual(desktopUnread(staleRead), true);
  });

  it('a read covering no new switch changes nothing, not even the version', () => {
    const before = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }]);
    assert.strictEqual(evolve(before, { type: 'DesktopsRead', switchesSeen: before.desktopSwitchCount }), before);
  });

  it('a show while the desktop is unread stamps no desktop; the placement report places it', () => {
    const shown = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }, { type: 'WindowHidden', id: wid(1) }]);
    assert.strictEqual(desktopOf(shown, 1), 'a1', 'precondition: stamped on first show');
    const reshown = fold([{ type: 'DesktopSwitchObserved' }, { type: 'WindowShown', id: wid(1) }], shown);
    assert.strictEqual(desktopOf(reshown, 1), undefined);
    const placed = evolve(reshown, place(1, 'A', 'a2'));
    assert.strictEqual(desktopOf(placed, 1), 'a2');
  });

  it('a placement report writes screen and desktop, and leaves a field alone on null', () => {
    const placed = fold([layout, page(1), place(1, 'B', 'b2')]);
    assert.strictEqual(windowById(placed, wid(1))?.screen, 'B');
    assert.strictEqual(desktopOf(placed, 1), 'b2');
    const partial = evolve(placed, place(1, null, null));
    assert.strictEqual(windowById(partial, wid(1))?.screen, 'B');
    assert.strictEqual(desktopOf(partial, 1), 'b2');
  });

  it('a placement report keeps an every-desktop window on its first-shown desktop', () => {
    const shown = fold([layout, page(1, { onEveryDesktop: true }), { type: 'WindowShown', id: wid(1) }]);
    assert.strictEqual(desktopOf(shown, 1), 'a1');
    const placed = evolve(shown, place(1, 'A', 'a2', true));
    assert.strictEqual(desktopOf(placed, 1), 'a1');
  });

  it('a placement report can declare a window on every desktop', () => {
    const placed = fold([layout, page(1), place(1, 'A', null, true)]);
    assert.strictEqual(isOnEveryDesktop(windowById(placed, wid(1))!), true);
  });

  it('a first show stamps the current desktop of the window screen, or of the first screen when unknown', () => {
    const onB = fold([layout, page(1), place(1, 'B', null), { type: 'WindowShown', id: wid(1) }]);
    assert.strictEqual(desktopOf(onB, 1), 'b1');
    const unknown = fold([layout, page(2), { type: 'WindowShown', id: wid(2) }]);
    assert.strictEqual(desktopOf(unknown, 2), 'a1');
  });

  it('a window is on no desktop until it is first shown', () => {
    const registered = fold([layout, page(1)]);
    assert.strictEqual(desktopOf(registered, 1), undefined);
  });

  it('a show of an already-visible window does not re-stamp it', () => {
    const shown = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }, switchTo('A', 'a2')]);
    const again = evolve(shown, { type: 'WindowShown', id: wid(1) });
    assert.strictEqual(desktopOf(again, 1), 'a1');
  });

  it('a hidden window shown again lands on the current desktop of its screen', () => {
    const reshown = fold([
      layout, page(1), { type: 'WindowShown', id: wid(1) }, { type: 'WindowHidden', id: wid(1) },
      switchTo('A', 'a2'), { type: 'WindowShown', id: wid(1) },
    ]);
    assert.strictEqual(desktopOf(reshown, 1), 'a2');
  });

  it('focus does not stamp a desktop', () => {
    const shown = fold([layout, page(1), { type: 'WindowShown', id: wid(1) }, switchTo('A', 'a2')]);
    const keyed = evolve(shown, { type: 'OsFocusGained', id: wid(1) });
    assert.strictEqual(desktopOf(keyed, 1), 'a1');
  });

  it('a window the backend declares on every desktop keeps its first-shown desktop through focus, show and switch', () => {
    const moved = fold([
      layout, page(1, { onEveryDesktop: true }), { type: 'WindowShown', id: wid(1) },
      switchTo('A', 'a2'), { type: 'OsFocusGained', id: wid(1) },
      { type: 'WindowHidden', id: wid(1) }, { type: 'WindowShown', id: wid(1) },
    ]);
    assert.strictEqual(desktopOf(moved, 1), 'a1');
  });

  it('a role that follows the user counts as on every desktop', () => {
    const shown = fold([
      layout,
      page(1),
      { type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' },
      { type: 'WindowShown', id: wid(1) },
      switchTo('A', 'a2'),
    ]);
    assert.strictEqual(isOnEveryDesktop(windowById(shown, wid(1))!), true);
    assert.strictEqual(onCurrentDesktop(shown, windowById(shown, wid(1))!), true);
  });

  it('re-registration keeps the lived desktop, screen and the declared every-desktop fact', () => {
    const shown = fold([layout, page(1, { onEveryDesktop: true }), place(1, 'A', null, true), { type: 'WindowShown', id: wid(1) }]);
    const again = evolve(shown, page(1));
    assert.strictEqual(desktopOf(again, 1), 'a1');
    assert.strictEqual(windowById(again, wid(1))?.screen, 'A');
    assert.strictEqual(windowById(again, wid(1))?.onEveryDesktop, true);
  });

  it('RegisterWindow carries the every-desktop declaration through decide', () => {
    const outcome = decide(initialState(), {
      type: 'RegisterWindow',
      id: wid(1),
      kind: 'page-host',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      onEveryDesktop: true,
      expectedVersion: 0,
    });
    assert.ok('events' in outcome);
    const next = outcome.events.reduce(evolve, initialState());
    assert.strictEqual(windowById(next, wid(1))?.onEveryDesktop, true);
  });

  it('before any layout report every window is on a current desktop', () => {
    const state = fold([page(1), { type: 'WindowShown', id: wid(1) }, page(2)]);
    assert.strictEqual(onCurrentDesktop(state, windowById(state, wid(1))!), true);
    assert.strictEqual(onCurrentDesktop(state, windowById(state, wid(2))!), true);
    assert.strictEqual(isCurrentDesktop(state, 'anything'), true);
  });

  it('onCurrentDesktop: every desktop, current on its screen, current on another screen, not current, never shown', () => {
    const base = fold([
      layout,
      page(1, { onEveryDesktop: true }),
      page(2),
      page(3),
      page(4),
      page(5),
      { type: 'WindowShown', id: wid(1) },
      place(2, 'A', 'a1'),
      place(3, 'B', 'b1'),
      place(4, 'A', 'a2'),
    ]);
    const rec = (n: number): WindowRecord => windowById(base, wid(n))!;
    assert.strictEqual(onCurrentDesktop(base, rec(1)), true, 'every desktop');
    assert.strictEqual(onCurrentDesktop(base, rec(2)), true, 'current on its screen');
    assert.strictEqual(onCurrentDesktop(base, rec(3)), true, 'current on another screen');
    assert.strictEqual(onCurrentDesktop(base, rec(4)), false, 'not current');
    assert.strictEqual(onCurrentDesktop(base, rec(5)), false, 'never shown');
  });

  it('a shared desktop is current on every screen that shows it', () => {
    const state = fold([
      {
        type: 'DesktopLayoutReported',
        screens: [{ id: 'A', current: 's1' }, { id: 'B', current: 's1' }],
        desktops: [{ id: 's1', screen: null }, { id: 's2', screen: null }],
      },
      page(1),
      place(1, 'B', 's1'),
    ]);
    assert.strictEqual(isCurrentDesktop(state, 's1'), true);
    assert.strictEqual(isCurrentDesktop(state, 's2'), false);
    assert.strictEqual(onCurrentDesktop(state, windowById(state, wid(1))!), true);
  });

  it('a window whose desktop disappears from the layout is off every current desktop', () => {
    const shown = fold([layout, page(1), place(1, 'A', 'a2')]);
    const next = evolve(shown, { type: 'DesktopLayoutReported', screens: [{ id: 'A', current: 'a1' }], desktops: [{ id: 'a1', screen: 'A' }] });
    assert.strictEqual(desktopOf(next, 1), 'a2');
    assert.strictEqual(onCurrentDesktop(next, windowById(next, wid(1))!), false);
  });
});

// specs/kernel-desktops.md rules 4, 8, 9 and "Kernel behaviour": successor on
// hide or close, and the raise gate (window-rules.md F7, F9).
describe('window-kernel: a focus the manager makes stays on the current desktop', () => {
  const S = 'S';
  const PAGE = wid(15);
  const OTHER = wid(16);
  const PALETTE = wid(20);
  const page = (id: WindowId): Event => ({
    type: 'WindowRegistered', id, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content',
  });
  const palette: Event = {
    type: 'WindowRegistered', id: PALETTE, kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: true, acceptsInput: true,
    class: 'palette', role: 'palette', keepLive: true, onEveryDesktop: true,
  };
  const layout: Event = {
    type: 'DesktopLayoutReported',
    screens: [{ id: S, current: '1' }],
    desktops: [{ id: '1', screen: S }, { id: '3', screen: S }],
  };
  const raises = (effects: Effect[]): Effect[] => effects.filter((e) => e.type === 'RaiseWindow');
  const focusesToward = (effects: Effect[], id: WindowId): Effect[] =>
    effects.filter((e) => (e.type === 'RaiseWindow' || e.type === 'FocusContent') && e.id === id);
  const openPalette: Event[] = [palette, { type: 'WindowShown', id: PALETTE }, { type: 'OsFocusGained', id: PALETTE }];

  // The live case: a page-host window on desktop 1 was key, the user switched
  // to desktop 3 and opened the palette, which is on every desktop.
  const paletteOverOffDesktopPage = (): State =>
    fold([
      layout,
      page(PAGE),
      { type: 'WindowShown', id: PAGE },
      { type: 'OsFocusGained', id: PAGE },
      { type: 'AppActivated' },
      { type: 'CurrentDesktopChanged', screen: S, desktop: '3' },
      ...openPalette,
    ]);

  for (const ending of ['WindowClosed', 'WindowHidden'] as const) {
    it(`the palette on desktop 3 ends (${ending}) with its prior key window on desktop 1: nothing is raised, no token`, () => {
      const state = paletteOverOffDesktopPage();
      assert.strictEqual(state.key, PALETTE, 'precondition: the palette holds key');
      assert.strictEqual(windowById(state, PALETTE)?.priorKey, PAGE, 'precondition: the page held key before it');
      assert.strictEqual(onCurrentDesktop(state, windowById(state, PAGE)!), false, 'precondition: the page is on desktop 1');
      const ev: Event = { type: ending, id: PALETTE };
      const next = evolve(state, ev);
      const effects = react(state, ev, next);
      assert.deepStrictEqual(raises(effects), []);
      assert.deepStrictEqual(focusesToward(effects, PAGE), []);
      assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no raise, no token');
    });
  }

  it('the palette ends after a switch notice but before the desktop read: its prior key window on the desktop left is not raised', () => {
    // The user opened the palette over PAGE on desktop 1 and switched to
    // desktop 3; `current` still says 1 until the read lands.
    const onDesktop1 = fold([layout, page(PAGE), { type: 'WindowShown', id: PAGE }, { type: 'OsFocusGained', id: PAGE }, { type: 'AppActivated' }, ...openPalette]);
    const ev: Event = { type: 'WindowHidden', id: PALETTE };
    const control = evolve(onDesktop1, ev);
    assert.notDeepStrictEqual(focusesToward(react(onDesktop1, ev, control), PAGE), [], 'control: without a switch the page is refocused');
    const switched = evolve(onDesktop1, { type: 'DesktopSwitchObserved' });
    const next = evolve(switched, ev);
    assert.deepStrictEqual(focusesToward(react(switched, ev, next), PAGE), []);
  });

  it('the prior key window is off the current desktop: the topmost application window on it is raised instead', () => {
    // PAGE is shown on desktop 1 and OTHER on desktop 3; PAGE held key before the palette.
    const swapped = fold([
      layout,
      page(PAGE),
      { type: 'WindowShown', id: PAGE },
      { type: 'CurrentDesktopChanged', screen: S, desktop: '3' },
      page(OTHER),
      { type: 'WindowShown', id: OTHER },
      { type: 'CurrentDesktopChanged', screen: S, desktop: '1' },
      { type: 'OsFocusGained', id: PAGE },
      { type: 'AppActivated' },
      { type: 'CurrentDesktopChanged', screen: S, desktop: '3' },
      ...openPalette,
    ]);
    assert.strictEqual(windowById(swapped, PAGE)?.desktop, '1', 'precondition: the prior key window is on desktop 1');
    assert.strictEqual(windowById(swapped, OTHER)?.desktop, '3', 'precondition: the other page is on desktop 3');
    const ev: Event = { type: 'WindowClosed', id: PALETTE };
    const next = evolve(swapped, ev);
    assert.deepStrictEqual(raises(react(swapped, ev, next)), [{ type: 'RaiseWindow', id: OTHER, opSeq: next.opSeqCounter }]);
  });

  it('the prior key window on the current desktop wins over a topmost one', () => {
    const state = fold([
      layout,
      page(PAGE),
      { type: 'WindowShown', id: PAGE },
      page(OTHER),
      { type: 'WindowShown', id: OTHER },
      { type: 'OsFocusGained', id: OTHER },
      { type: 'OsFocusGained', id: PAGE },
      { type: 'AppActivated' },
      ...openPalette,
    ]);
    assert.strictEqual(windowById(state, PALETTE)?.priorKey, PAGE, 'precondition: the page held key before the palette');
    assert.strictEqual(topmost(state, isContentWindow)?.id, PAGE, 'the page took key last, so it is also topmost');
    // Put OTHER on top without it taking key, so topmost and prior differ.
    const reordered: State = { ...state, order: [...state.order.filter((w) => w.id !== OTHER), windowById(state, OTHER)!] };
    const ev: Event = { type: 'WindowHidden', id: PALETTE };
    const next = evolve(reordered, ev);
    assert.deepStrictEqual(raises(react(reordered, ev, next)), [{ type: 'RaiseWindow', id: PAGE, opSeq: next.opSeqCounter }]);
  });

  it('before any layout report the prior key window is raised, as before', () => {
    const state = fold([
      page(PAGE),
      { type: 'WindowShown', id: PAGE },
      { type: 'OsFocusGained', id: PAGE },
      { type: 'AppActivated' },
      ...openPalette,
    ]);
    const ev: Event = { type: 'WindowClosed', id: PALETTE };
    const next = evolve(state, ev);
    assert.deepStrictEqual(raises(react(state, ev, next)), [{ type: 'RaiseWindow', id: PAGE, opSeq: next.opSeqCounter }]);
  });

  it('a raise request without user intent for a window on another desktop is not emitted and mints no token', () => {
    const state = paletteOverOffDesktopPage();
    const ev: Event = { type: 'FocusRaiseRequested', id: PAGE };
    const next = evolve(state, ev);
    assert.deepStrictEqual(raises(react(state, ev, next)), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter);
  });

  it('a raise request with user intent for a window on another desktop is not emitted: user intent does not name the window (rule 5)', () => {
    const state = paletteOverOffDesktopPage();
    const ev: Event = { type: 'FocusRaiseRequested', id: PAGE, intent: 'user' };
    const next = evolve(state, ev);
    assert.deepStrictEqual(raises(react(state, ev, next)), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter, 'no raise, no token');
    assert.strictEqual(windowById(next, PAGE)?.lastOpSeq, windowById(state, PAGE)?.lastOpSeq, 'no raise, no stamp');
  });

  describe('reusableHere (rule 5)', () => {
    it('a visible window on another desktop is not reusable; a new window opens here', () => {
      const state = paletteOverOffDesktopPage();
      assert.strictEqual(reusableHere(state, [PAGE]), null);
    });

    it('a visible window on the current desktop is reusable', () => {
      const state = fold([{ type: 'CurrentDesktopChanged', screen: S, desktop: '1' }], paletteOverOffDesktopPage());
      assert.strictEqual(reusableHere(state, [PAGE]), PAGE);
    });

    it('a hidden window is reusable wherever it was: its re-show lands here', () => {
      const state = fold([{ type: 'WindowHidden', id: PAGE }], paletteOverOffDesktopPage());
      assert.strictEqual(reusableHere(state, [PAGE]), PAGE);
    });

    it('a window on every desktop is reusable', () => {
      assert.strictEqual(reusableHere(paletteOverOffDesktopPage(), [PALETTE]), PALETTE);
    });

    it('the first reusable candidate wins; one on another desktop is skipped', () => {
      const state = fold(
        [page(OTHER), { type: 'WindowShown', id: OTHER }],
        paletteOverOffDesktopPage(),
      );
      assert.strictEqual(windowById(state, OTHER)?.desktop, '3', 'precondition: the second page was shown on desktop 3');
      assert.strictEqual(reusableHere(state, [PAGE, OTHER]), OTHER);
    });

    it('before the first layout report every window is reusable', () => {
      const state = fold([page(PAGE), { type: 'WindowShown', id: PAGE }]);
      assert.strictEqual(reusableHere(state, [PAGE]), PAGE);
    });

    it('an unknown id is skipped', () => {
      assert.strictEqual(reusableHere(paletteOverOffDesktopPage(), [wid(99)]), null);
    });
  });

  it('a switcher pick of a window on the current desktop asks for no desktop', () => {
    const state = fold(
      [{ type: 'CurrentDesktopChanged', screen: S, desktop: '1' }, { type: 'SelectionFocusArmed', armer: PALETTE, target: PAGE }],
      paletteOverOffDesktopPage(),
    );
    const ev: Event = { type: 'WindowClosed', id: PALETTE };
    const effects = react(state, ev, evolve(state, ev));
    assert.deepStrictEqual(effects.filter((e) => e.type === 'ShowDesktop'), []);
    assert.strictEqual(raises(effects).length, 1);
  });

  it('a raise request for a window on another desktop does not hold it above other apps', () => {
    const state = fold([{ type: 'AppResigned' }], paletteOverOffDesktopPage());
    assert.strictEqual(state.appActive, false, 'precondition: app inactive');
    const next = evolve(state, { type: 'FocusRaiseRequested', id: PAGE });
    assert.notStrictEqual(windowById(next, PAGE)?.heldAboveOtherApps, true);
    assert.strictEqual(next.pendingColdStartFocus, state.pendingColdStartFocus, 'no latch armed for it either');
  });

  it('a focus assert for a window on another desktop is not emitted, nor its content focus', () => {
    const state = paletteOverOffDesktopPage();
    const ev: Event = { type: 'FocusAssertRequested', id: PAGE };
    const next = evolve(state, ev);
    assert.deepStrictEqual(focusesToward(react(state, ev, next), PAGE), []);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter);
  });

  it('a switcher pick of a window on another desktop asks for its desktop, then raises it with user intent and a token', () => {
    // The palette stands in for the switcher: any window can arm a selection.
    const state = fold([{ type: 'SelectionFocusArmed', armer: PALETTE, target: PAGE }], paletteOverOffDesktopPage());
    assert.strictEqual(onCurrentDesktop(state, windowById(state, PAGE)!), false, 'precondition: the page is on desktop 1');
    const ev: Event = { type: 'WindowClosed', id: PALETTE };
    const next = evolve(state, ev);
    const effects = react(state, ev, next).filter((e) => e.type === 'ShowDesktop' || e.type === 'RaiseWindow');
    assert.deepStrictEqual(effects, [
      { type: 'ShowDesktop', desktop: '1' },
      { type: 'RaiseWindow', id: PAGE, opSeq: next.opSeqCounter, intent: 'user' },
    ]);
    assert.strictEqual(next.opSeqCounter, state.opSeqCounter + 1);
    assert.strictEqual(windowById(next, PAGE)?.lastOpSeq, next.opSeqCounter, 'the raise and its stamp agree');
  });

  it('an OS focus report for a window the kernel places on another desktop moves key but raises nothing', () => {
    const state = paletteOverOffDesktopPage();
    const ev: Event = { type: 'OsFocusGained', id: PAGE };
    const next = evolve(state, ev);
    assert.strictEqual(next.key, PAGE, 'key is a reported fact');
    assert.deepStrictEqual(raises(react(state, ev, next)), []);
  });

  it('closing a child whose parent is on another desktop raises no parent', () => {
    const CHILD = wid(30);
    const state = fold([
      layout,
      page(PAGE),
      { type: 'WindowShown', id: PAGE },
      { type: 'AppActivated' },
      { type: 'CurrentDesktopChanged', screen: S, desktop: '3' },
      { type: 'WindowRegistered', id: CHILD, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'child-content', parentId: PAGE },
      { type: 'WindowShown', id: CHILD },
      { type: 'OsFocusGained', id: CHILD },
    ]);
    const ev: Event = { type: 'WindowClosed', id: CHILD };
    const next = evolve(state, ev);
    assert.deepStrictEqual(focusesToward(react(state, ev, next), PAGE), []);
  });
});
