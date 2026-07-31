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
  overlayForHost,
  hostForOverlay,
  isContentWindow,
  topmostBaseLayerPageHost,
  isStaleSelfEcho,
  selectTransientAutoclose,
  selectAppResignTransients,
  isAppResignSweepEligible,
  BASE_LAYER,
  type State,
  type Event,
  type Effect,
  type WindowId,
  type Command,
  type Rectangle,
  type FocusCause,
} from './window-kernel.js';
// The overturn set at the end of this file asserts one behavior the kernel
// stores the facts for but does not itself decide: whether the OS-level Escape
// grab arms. `window-escape.ts` is a pure read of this kernel's snapshot (it
// imports `window-kernel.js` and nothing else), so the overturned devtools /
// dangling-key cases are pinned against the real predicate rather than
// restated as prose.
import { shouldArmEscapeGrab, switcherWindow } from './window-escape.js';

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
    { type: 'AppActivated' },
    { type: 'OsFocusLost', id: wid(2) },
    { type: 'WindowHidden', id: wid(3) },
    { type: 'WindowClosed', id: wid(2) },
    { type: 'AppResigned' },
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
    assert.strictEqual(merged.acceptsInput, false);
    assert.strictEqual(merged.class, 'hud');
    assert.strictEqual(merged.parentId, wid(2));
    // Lived facts are preserved, not reset by the re-registration.
    assert.strictEqual(merged.visible, true);
    assert.strictEqual(merged.openSeq, openSeqBefore);
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

// ── one order: where a background open lands (§0.1.10) ──────────────────────

/**
 * ONE ORDER, and nothing else orders windows: a background open is placed
 * BELOW the last-focused window. The two rules that move anything are
 * complete and disjoint — a registration inserts under the key window, and a
 * focus gain raises its target to the top — so there is no second list and no
 * focus-recency counter to disagree with `order`.
 *
 * Every window here is registered with the facts its REAL construction site
 * produces (same discipline as `which windows a real app resign hides`): an
 * ordinary page host is `kind:'page-host'` at `BASE_LAYER`, focusable,
 * input-accepting, `class:'primary'`, `role:'content'` — and, being a
 * page-host, it is NOT positionable by the OS until its first composited
 * frame reports in (`WindowContentOrderable`). A rule that only held for
 * windows the OS can already stack would pass vacuously without that step.
 */
describe('window-kernel: a background open lands BELOW the key window', () => {
  /** The page host the user is working in. */
  const inUse = wid(1);
  /** The one that opens behind it — a hotkeyed page, a restored session window. */
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

  /** One page host on screen, orderable, holding key. */
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

    // The first composited frame re-asserts the whole stack — that emission is
    // the machine's answer for what the screen looks like, bottom -> top.
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

/**
 * `react` emits `RaiseWindow` off a focus report, which contradicts the old
 * reducer's standing invariant ("no RAISE_WINDOW from OS_FOCUS_GAINED — the
 * pump's convergence obligation"). The invariant is superseded, not violated,
 * and these are the two facts that decide it:
 *
 *   - it is the ONLY route to key — `decide` turns a `RaiseWindow` COMMAND
 *     into an `OsFocusGained` event (§0.1.10, one order), so suppressing the
 *     emission would leave a raise command with nothing but `SetStacking`,
 *     which carries no activation;
 *   - it converges in one step — the raise moves its target to the top, so
 *     the focus report it provokes finds the target already topmost and the
 *     diff is empty. The emission is its own fixed point.
 *
 * The rule is also STRUCTURAL: "the top of `order` changed under unchanged
 * membership". It never asks which event moved it, which is why a close or a
 * registration — a membership change, not a window taking focus — raises
 * nothing.
 */
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

  /** `top` holds key on top; `below` sits under it (a background open). */
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
      [{ type: 'CloseWindow', id: wid(1) }],
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
    assert.deepStrictEqual(effects, [{ type: 'HideWindow', id: wid(1) }]);
    assert.ok(!effects.some((e) => e.type === 'CloseWindow'));
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

  it('an attached overlay follows its host BoundsChanged; a detached one does not', () => {
    const registered = fold(registerHostsAndOverlay(), initialState());
    const attached = fold(
      [{ type: 'OverlayAttached', overlayId, hostId: hostA }],
      registered,
    );

    const bounds: Rectangle = { x: 10, y: 20, width: 300, height: 400 };
    const boundsEv: Event = { type: 'BoundsChanged', id: hostA, bounds };
    const nextAttached = evolve(attached, boundsEv);
    const attachedEffects = react(attached, boundsEv, nextAttached);
    assert.ok(
      attachedEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId && JSON.stringify(e.bounds) === JSON.stringify(bounds)),
      'an attached overlay must follow its host bounds change',
    );

    // Detach, then move hostA's bounds again — no follow this time.
    const detached = evolve(attached, { type: 'OverlayAttached', overlayId, hostId: null });
    const bounds2: Rectangle = { x: 1, y: 2, width: 3, height: 4 };
    const boundsEv2: Event = { type: 'BoundsChanged', id: hostA, bounds: bounds2 };
    const nextDetached = evolve(detached, boundsEv2);
    const detachedEffects = react(detached, boundsEv2, nextDetached);
    assert.ok(
      !detachedEffects.some((e) => e.type === 'SetBounds' && e.id === overlayId),
      'a detached overlay must not follow bounds changes',
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

// ── Focus provenance: cause, and isStaleSelfEcho ────────────────────────────

describe('window-kernel: focus provenance (cause) and isStaleSelfEcho', () => {
  const registerTwo = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
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

    // Showing an already-hidden-then-shown window: WindowShown on a window
    // that is not yet visible genuinely flips it and stamps lastOpSeq; a
    // second WindowShown on the now-visible window is a no-op for the effect
    // and must not re-stamp (though the value is unchanged either way here,
    // this proves the guard runs on both edges of the same field).
    const shownOnceEv: Event = { type: 'WindowShown', id: wid(1) };
    const shownOnce = evolve(afterRaise, shownOnceEv);
    const shownOnceEffects = react(afterRaise, shownOnceEv, shownOnce);
    assert.ok(shownOnceEffects.some((e) => e.type === 'ShowWindow' && e.id === wid(1)));
    assert.strictEqual(shownOnce.order.find((w) => w.id === wid(1))?.lastOpSeq, shownOnce.opSeqCounter);

    const shownTwiceEv: Event = { type: 'WindowShown', id: wid(1) };
    const shownTwice = evolve(shownOnce, shownTwiceEv);
    const shownTwiceEffects = react(shownOnce, shownTwiceEv, shownTwice);
    assert.ok(!shownTwiceEffects.some((e) => e.type === 'ShowWindow'), 'an already-visible window re-shown emits no ShowWindow effect');
  });
});

// ── The op counter: what makes one op distinguishable from another ─────────

/**
 * `State.opSeqCounter` is the ordering `isStaleSelfEcho` reads, and it is
 * INERT unless `evolve` advances it: with the counter frozen every op ever
 * issued carries the same token, no echo can be older than any other, and a
 * guard that is correct in form matches nothing live traffic produces. These
 * tests state the counter's own behaviour — advance on exactly the
 * transitions that issue a focus-family op, stay put on every other one, and
 * hand `evolve`'s record stamp and `react`'s effect token the SAME number —
 * so a counter that stops advancing fails here instead of passing vacuously.
 */
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

  /** One transition, with everything the two coherence rules need to be checked. */
  function step(state: State, ev: Event): { next: State; effects: Effect[] } {
    const next = evolve(state, ev);
    return { next, effects: react(state, ev, next) };
  }

  /**
   * THE ROUND-TRIP RULE, asserted rather than assumed: for every focus-family
   * effect `react` emits, the token on the effect, the counter in `next`, and
   * the `lastOpSeq` stamped on the named record are one and the same number —
   * and that number is exactly one more than the pre-transition counter.
   * Anything else and the echo the backend sends back cannot line up with the
   * stamp the guard compares it to.
   */
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
      acceptsInput: false,
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
  /** A key-holding "primary" window plus a non-key-holding "hud" window, both visible. */
  const registerPrimaryAndHud = (): Event[] => [
    { type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    { type: 'WindowRegistered', id: wid(2), kind: 'page-host', layer: 1, canBecomeKey: false, acceptsInput: false, class: 'hud' },
    { type: 'WindowShown', id: wid(1) },
    { type: 'WindowShown', id: wid(2) },
    { type: 'OsFocusGained', id: wid(1) },
  ];

  it('resign then activate with no settle in between hides nothing and leaves nothing armed (the dance case)', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    const resigned = evolve(before, { type: 'AppResigned' });
    assert.strictEqual(resigned.pendingAppResignSweep, true);
    const activated = evolve(resigned, { type: 'AppActivated' });

    assert.strictEqual(activated.pendingAppResignSweep, false);
    assert.strictEqual(activated.appActive, true);
    // Nothing was hidden, so nothing carries the mark, and both windows are
    // exactly as visible as they started.
    for (const w of activated.order) {
      assert.strictEqual(w.hiddenByAppBlur, undefined);
    }
    assert.strictEqual(activated.order.find((w) => w.id === wid(1))?.visible, true);
    assert.strictEqual(activated.order.find((w) => w.id === wid(2))?.visible, true);
  });

  it('resign then settle hides the sweep-eligible (non-key-holding) window and marks it hiddenByAppBlur', () => {
    const before = fold(registerPrimaryAndHud(), initialState());
    const resigned = evolve(before, { type: 'AppResigned' });
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

/**
 * Every window below is registered with the facts its REAL construction site
 * produces, so a predicate that matches nothing in production fails here
 * rather than passing vacuously — the defect this suite exists to catch. The
 * old reducer swept `class === 'hud' && visible`, i.e. exactly one of these.
 */
describe('window-kernel: which windows a real app resign hides', () => {
  const FLOATING = BASE_LAYER + 1;

  /** The ordinary page-host the user works in. */
  const workspace = wid(1);
  /** The HUD: `renderer/hud/background.js` opens `alwaysOnTop:true, focusable:false`, no role. */
  const hud = wid(2);
  /** The space-border indicator: `features/spaces/background.js` — same two flags, but `role:'overlay'`. */
  const spaceBorder = wid(3);
  /** The privileged test fixture: `test-fixture-glue.ts` — `focusable:false`, and NOT floating. */
  const testFixture = wid(4);
  /** The cmd panel: floats, but takes key to type in — its own blur handling, would blink. */
  const cmdPanel = wid(5);
  /** A quick-view that happens to be non-focusable — the would-be overlap with the transient sweep. */
  const quickView = wid(6);
  /** A HUD hidden before the resign, for a reason of its own. */
  const alreadyHiddenHud = wid(7);

  const scene = (): State =>
    fold([
      { type: 'WindowRegistered', id: workspace, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowRegistered', id: hud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' },
      { type: 'WindowRegistered', id: spaceBorder, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'WindowRegistered', id: testFixture, kind: 'browser', layer: BASE_LAYER, canBecomeKey: false, acceptsInput: true, class: 'test-fixture', role: 'utility' },
      { type: 'WindowRegistered', id: cmdPanel, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette' },
      { type: 'WindowRegistered', id: quickView, kind: 'page-host', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'quick-view', role: 'quick-view' },
      { type: 'WindowRegistered', id: alreadyHiddenHud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' },
      { type: 'WindowShown', id: workspace },
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: spaceBorder },
      { type: 'WindowShown', id: testFixture },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: quickView },
      { type: 'OsFocusGained', id: workspace },
    ]);

  const sweptBy = (state: State): WindowId[] =>
    state.order.filter((w) => w.hiddenByAppBlur === true).map((w) => w.id);

  it('the sweep takes the HUD — and it is the ONLY window it takes', () => {
    const settled = evolve(evolve(scene(), { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const swept = sweptBy(settled);

    // A predicate matching nothing (the inert failure mode) dies on this line.
    assert.ok(swept.length > 0, 'a real app resign must hide something — a sweep that matches nothing is the bug');
    assert.deepStrictEqual(swept, [hud]);
    assert.strictEqual(settled.order.find((w) => w.id === hud)?.visible, false);

    // Everything else stayed exactly as visible as it was. Each of these is a
    // window `!canBecomeKey && visible` alone would have taken.
    for (const id of [workspace, spaceBorder, testFixture, cmdPanel, quickView]) {
      assert.strictEqual(settled.order.find((w) => w.id === id)?.visible, true, `${id} must not be hidden by the resign sweep`);
    }
    // The already-hidden HUD is not visible, so it is never marked — otherwise
    // the re-show on activation would resurrect a window nobody asked for.
    assert.strictEqual(settled.order.find((w) => w.id === alreadyHiddenHud)?.hiddenByAppBlur, undefined);
  });

  it('both halves of the HUD pair are load-bearing — neither alone selects the HUD', () => {
    const state = scene();
    const rec = (id: WindowId) => state.order.find((w) => w.id === id)!;

    assert.strictEqual(isAppResignSweepEligible(rec(hud)), true, 'floats above the stack AND cannot hold key');
    assert.strictEqual(isAppResignSweepEligible(rec(testFixture)), false, 'cannot hold key, but does not float');
    assert.strictEqual(isAppResignSweepEligible(rec(cmdPanel)), false, 'floats, but takes key — its own blur handling');
    assert.strictEqual(isAppResignSweepEligible(rec(workspace)), false, 'neither');
    assert.strictEqual(isAppResignSweepEligible(rec(spaceBorder)), false, 'a declared role owns its own app-resign policy');
    assert.strictEqual(isAppResignSweepEligible(rec(alreadyHiddenHud)), false, 'already hidden, for a reason of its own');
  });

  it('the hide sweep and the transient dismissal name disjoint windows', () => {
    const state = scene();
    const dismissed = selectAppResignTransients(state);
    const hidden = state.order.filter(isAppResignSweepEligible).map((w) => w.id);

    // The quick-view is non-focusable AND floating, so only the role clause
    // keeps it out of the hide set — it is dismissed outright instead, and a
    // window may never be both (dismissal is final; the hide is undone by
    // `AppActivated`).
    assert.deepStrictEqual(dismissed, [quickView]);
    assert.deepStrictEqual(hidden, [hud]);
    assert.deepStrictEqual(hidden.filter((id) => dismissed.includes(id)), []);
  });

  it('the following activation re-shows exactly the HUD the sweep hid', () => {
    const settled = evolve(evolve(scene(), { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const activated = evolve(settled, { type: 'AppActivated' });

    assert.strictEqual(activated.order.find((w) => w.id === hud)?.visible, true);
    assert.strictEqual(activated.order.find((w) => w.id === hud)?.hiddenByAppBlur, false);
    assert.strictEqual(activated.order.find((w) => w.id === alreadyHiddenHud)?.visible, false);
    assert.deepStrictEqual(sweptBy(activated), []);
  });

  it('the sweep emits a HideWindow effect for exactly the windows it hid', () => {
    const resigned = evolve(scene(), { type: 'AppResigned' });
    const settleEv: Event = { type: 'AppResignSettled' };
    const settled = evolve(resigned, settleEv);
    const effects = react(resigned, settleEv, settled);

    assert.deepStrictEqual(
      effects.filter((e) => e.type === 'HideWindow').map((e) => e.id),
      [hud],
    );
  });
});

// ── Transient autoclose (the two selectors) ─────────────────────────────────

describe('window-kernel: transient autoclose', () => {
  /** Registration event for a window with a role; `openSeq` follows registration order. */
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

  /**
   * wid(1) workspace, wid(2) palette, wid(3) quick-view, wid(4) overlay,
   * wid(5) utility, wid(6) roleless, wid(7) a HIDDEN palette. Registration
   * order is also `openSeq` order.
   */
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
        show(1),
        show(2),
        show(3),
        show(4),
        show(5),
        show(6),
      ],
      initialState(),
    );

  it('a world-caused focus sweeps every visible transient but the focuser, the overlay, and the hidden', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1), { kind: 'world' }), [wid(2), wid(3)]);
  });

  it('the default cause is world', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1)), selectTransientAutoclose(state, wid(1), { kind: 'world' }));
  });

  it('the focuser is never its own victim', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'world' }), [wid(3)]);
  });

  it('a utility or overlay focuser sweeps nothing; a roleless one sweeps everything', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(5)), [], 'utility must not dismiss its transient parent');
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(4)), [], 'the chrome overlay is not a window switch');
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(6)), [wid(2), wid(3)], 'no role is in no exempt set');
  });

  it('an unregistered focuser sweeps every visible transient, whatever the cause', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(99), { kind: 'world' }), [wid(2), wid(3)]);
    assert.deepStrictEqual(
      selectTransientAutoclose(state, wid(99), { kind: 'machine', opSeq: 0 }),
      [wid(2), wid(3)],
      'no record means no openSeq to order against — the ordering test cannot arm',
    );
  });

  it('INVARIANT: a machine-caused focus ARMS an openSeq ordering test — it does not skip the sweep', () => {
    // A slide opens first, a palette after it. Both visible, both transient.
    const state = fold([reg(1, 'quick-view'), reg(2, 'palette'), show(1), show(2)], initialState());
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

  it('the ordering test spares only what is strictly newer than the focuser', () => {
    // Three transients in a known open order; the machine focuses the middle one.
    const state = fold(
      [reg(1, 'quick-view'), reg(2, 'palette'), reg(3, 'palette'), show(1), show(2), show(3)],
      initialState(),
    );
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'machine', opSeq: 0 }), [wid(1)]);
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(2), { kind: 'world' }), [wid(1), wid(3)]);
  });

  it('an exempt focuser stays exempt under a machine cause', () => {
    const state = scene();
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(5), { kind: 'machine', opSeq: 0 }), []);
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(4), { kind: 'machine', opSeq: 0 }), []);
  });

  it('the selector is kind-agnostic — a transient browser window is a victim too', () => {
    const state = fold([reg(1, 'workspace'), reg(2, 'palette', 'browser'), show(1), show(2)], initialState());
    assert.deepStrictEqual(selectTransientAutoclose(state, wid(1)), [wid(2)]);
  });

  it('selectAppResignTransients takes visible transient page-hosts only', () => {
    const state = fold(
      [
        reg(1, 'workspace'),
        reg(2, 'palette'),
        reg(3, 'quick-view'),
        reg(4, 'overlay'),
        reg(5, 'palette', 'browser'),
        reg(6, 'quick-view'),
        show(1),
        show(2),
        show(3),
        show(4),
        show(5),
      ],
      initialState(),
    );
    // wid(1) non-transient, wid(4) overlay-exempt, wid(5) a browser (it
    // self-closes on app blur), wid(6) never shown.
    assert.deepStrictEqual(selectAppResignTransients(state), [wid(2), wid(3)]);
  });

  it('selectAppResignTransients has no focuser to exclude and reads no cause', () => {
    const state = fold([reg(1, 'palette'), reg(2, 'quick-view'), show(1), show(2), { type: 'OsFocusGained', id: wid(1) }], initialState());
    assert.deepStrictEqual(selectAppResignTransients(state), [wid(2), wid(1)], 'both go, in current order position');
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

/**
 * Every window below is registered with the facts its REAL construction site
 * produces, so a predicate that matches nothing — or matches everything —
 * fails here rather than passing vacuously.
 */
describe('window-kernel: which window the user is working in', () => {
  const FLOATING = BASE_LAYER + 1;

  /** An ordinary http page host: `ipc.ts` window-open, `inferIzuiRole` -> 'content'. */
  const pageHost = wid(1);
  /** A page opened from another page: `inferIzuiRole` -> 'child-content'. */
  const childPage = wid(2);
  /** The settings window: a non-web-page surface, so `inferIzuiRole` -> 'workspace'. */
  const settings = wid(3);
  /** A chrome-extension popup: `chrome-extensions.ts` registers `role:'content', class:'extension-ui'`. */
  const extensionPopup = wid(4);
  /** The HUD: `renderer/hud/background.js` — `alwaysOnTop:true, focusable:false`, inferred role 'workspace'. */
  const hud = wid(5);
  /** The shared chrome overlay: `hybrid-overlay.ts` — focusable BY INVARIANT (typing a URL takes key). */
  const chromeOverlay = wid(6);
  /** The cmd panel: floats, focusable, `role:'palette'`. */
  const cmdPanel = wid(7);
  /** A slide: opened `modal:true`, so `inferIzuiRole` -> 'quick-view'. Focusable. */
  const slide = wid(8);
  /** Detached devtools: `main.ts` registers `role:'utility', class:'devtools'` — a real, focusable window. */
  const devtools = wid(9);
  /** The core background window: `core-glue.ts` — `role:'utility', class:'background'`, never shown. */
  const backgroundWindow = wid(10);

  const scene = (): State =>
    fold([
      { type: 'WindowRegistered', id: pageHost, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowRegistered', id: childPage, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'child-content', parentId: pageHost },
      { type: 'WindowRegistered', id: settings, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
      { type: 'WindowRegistered', id: extensionPopup, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'extension-ui', role: 'content', escapeMode: 'ignore' },
      { type: 'WindowRegistered', id: hud, kind: 'browser', layer: FLOATING, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace', escapeMode: 'ignore' },
      { type: 'WindowRegistered', id: chromeOverlay, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: false, class: 'overlay', role: 'overlay' },
      { type: 'WindowRegistered', id: cmdPanel, kind: 'browser', layer: FLOATING, canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette' },
      { type: 'WindowRegistered', id: slide, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'quick-view', role: 'quick-view', keepLive: true },
      { type: 'WindowRegistered', id: devtools, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'devtools', role: 'utility' },
      { type: 'WindowRegistered', id: backgroundWindow, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'background', role: 'utility' },
      { type: 'WindowShown', id: pageHost },
      { type: 'WindowShown', id: childPage },
      { type: 'WindowShown', id: settings },
      { type: 'WindowShown', id: extensionPopup },
      { type: 'WindowShown', id: hud },
      { type: 'WindowShown', id: chromeOverlay },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: slide },
      { type: 'WindowShown', id: devtools },
      { type: 'OsFocusGained', id: pageHost },
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
    // If the predicate were role-only, the HUD would be main: it opens with no
    // explicit role, and `inferIzuiRole`'s non-web-page tail returns 'workspace'.
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
    // The old model kept quick-views front-eligible ONLY so `front` could
    // double as the Escape target. Escape now reads `key`, so the coupling
    // is gone and a peek/slide can be the panel it is.
    const state = evolve(scene(), { type: 'OsFocusGained', id: slide });
    assert.strictEqual(keyWindow(state)?.id, slide);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  it('the chrome overlay taking key at Cmd+N time does not lose the page host', () => {
    // The live bug this maps to: `openNewPageWindow` inherits space mode from
    // the front window, and the overlay routinely holds key (Cmd+L).
    const state = evolve(scene(), { type: 'OsFocusGained', id: chromeOverlay });
    assert.strictEqual(keyWindow(state)?.id, chromeOverlay);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  it('main survives the loss of key entirely — which `keyWindow` cannot', () => {
    // Sessions save on quit / app-resign / window-close, exactly when
    // `OsFocusLost` has already nulled `key`. Mapping a saved descriptor's
    // `focused` flag to `keyWindow` would mark every one of them false.
    const state = evolve(scene(), { type: 'OsFocusLost', id: pageHost });
    assert.strictEqual(keyWindow(state), null);
    assert.strictEqual(topmost(state, isContentWindow)?.id, pageHost);
  });

  it('main follows a raise, because a raise moves the window to the top of order', () => {
    const state = evolve(scene(), { type: 'OsFocusGained', id: settings });
    assert.strictEqual(topmost(state, isContentWindow)?.id, settings);
  });

  // ── The hiddenByAppBlur / AppActivated interaction ────────────────────────

  it('no content window is touched by the app-resign sweep — the two sets are disjoint', () => {
    // `isAppResignSweepEligible` requires `!canBecomeKey`; this predicate
    // requires `canBecomeKey`. So `visible` here cannot flicker across an app
    // switch, and main is stable through resign -> settle -> activate.
    const before = scene();
    const settled = evolve(evolve(before, { type: 'AppResigned' }), { type: 'AppResignSettled' });
    const activated = evolve(settled, { type: 'AppActivated' });

    assert.deepStrictEqual(new Set(contentIds(settled)), new Set(contentIds(before)));
    assert.deepStrictEqual(new Set(contentIds(activated)), new Set(contentIds(before)));
    assert.strictEqual(topmost(settled, isContentWindow)?.id, pageHost);
    assert.strictEqual(topmost(activated, isContentWindow)?.id, pageHost);

    // And the sweep genuinely did something, so the assertion above is not vacuous.
    assert.deepStrictEqual(settled.order.filter((w) => w.hiddenByAppBlur === true).map((w) => w.id), [hud]);
  });

  it('the transient dismissal is disjoint from the content set too', () => {
    const state = scene();
    const dismissed = new Set(selectAppResignTransients(state));
    assert.ok(dismissed.size > 0, 'the slide is dismissed — otherwise this proves nothing');
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
    // The distinction this query exists for: an ordering query would answer
    // with a host the overlay is NOT framing.
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

  /** Visible AND orderable — the two facts the query, like `isContentWindow`, requires. */
  const shown = (id: WindowId): Event[] => [
    { type: 'WindowShown', id },
    { type: 'WindowContentOrderable', id },
  ];

  it('a floating quick-view above a base-layer page host does not shadow it — the chrome frames the page, not the peek', () => {
    const base = wid(1);
    const quickView = wid(2);
    const state = fold([
      registerPageHost(base),
      ...shown(base),
      // Registered later, in the floating band — a peek opened over the page.
      registerPageHost(quickView, { layer: FLOATING, role: 'quick-view' }),
      ...shown(quickView),
    ]);
    assert.deepStrictEqual(state.order.map((w) => w.id), [base, quickView], 'the quick-view sits above `base` in `order`');
    assert.strictEqual(
      topmostBaseLayerPageHost(state)?.id,
      base,
      'kind alone admits the peek too — the role clause is what excludes it',
    );
  });

  it('a page-host registered outside the base layer is excluded, even with an admitted role', () => {
    const floatingHost = wid(1);
    const state = fold([registerPageHost(floatingHost, { layer: FLOATING }), ...shown(floatingHost)]);
    assert.strictEqual(topmostBaseLayerPageHost(state), null, 'array position alone would have found it — the layer clause is what excludes it');
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
});

// ── The overturn set: what the key/main split reverses ──────────────────────
//
// `docs/design/window-manager.md` §0.1.9 ("The overturn set (bucket D)")
// classifies 24 `window-state.test.ts` tests as behaviors that must be
// OVERTURNED rather than translated. All share one shape: a satellite takes OS
// focus, and the old reducer pins `front` on the content window so that ONE
// stored fact can answer two questions. The kernel stores both — `key` on the
// window that took focus, `topmost(state, isContentWindow)` for the window the
// user means to act on — so each of those single assertions becomes two.
//
// They are written against the kernel BEFORE anything repoints to it, because
// the mechanical `front` -> `keyWindow(state)` rename passes several of them
// while asserting the OPPOSITE of the truth: `a background / non-focusable /
// overlay surface (satellite) does NOT become front` asserts a literal `null`,
// which survives the rename and is wrong — a window that genuinely took OS
// focus genuinely holds key (see "with no content window on screen" below).
//
// Every window here carries the facts its REAL construction site produces; a
// scene of synthetic fixtures would let these pass vacuously.
describe('window-kernel: what the key/main split overturns', () => {
  const FLOATING = BASE_LAYER + 1;

  /** An http page opened through `ipc.ts` — `inferIzuiRole` -> 'content'; hybrid, so `kind: 'page-host'`. */
  const pageHost = wid(1);
  /** A second page window from the same construction site. */
  const otherHost = wid(2);
  /**
   * The shared chrome overlay: `hybrid-overlay.ts ensureOverlay` opens a
   * `BrowserWindow` with `focusable: true` (P1.4b-3 — a `focusable:false`
   * window can never become key, so the navbar URL field could not be typed
   * in), `alwaysOnTop: true`, `transparent`, and click-through until the
   * reveal band captures — so `acceptsInput: false`.
   */
  const chromeOverlay = wid(3);
  /**
   * The command panel: `renderer/cmd/background.js openPanelWindow` —
   * `role: 'palette'`, `keepLive: true`, `alwaysOnTop: true`, focusable (it is
   * typed into), and NO parent: its opener is the cmd background tile, not a
   * window.
   */
  const cmdPanel = wid(4);
  /**
   * Detached devtools: `main.ts` on `'devtools-opened'` registers
   * `kind: 'browser'`, `role: 'utility'`, `class: 'devtools'`, parented to its
   * host, focusable, and NOT floating.
   */
  const devtools = wid(5);
  /** The HUD: `renderer/hud/background.js openHud` — `focusable:false`, `alwaysOnTop:true`, `escapeMode:'ignore'`, no role given so `inferIzuiRole` -> 'workspace'. */
  const hud = wid(6);
  /** The core background renderer: `core-glue.ts` — `role:'utility'`, `class:'background'`, never shown. */
  const backgroundWindow = wid(7);

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

  /**
   * The app mid-session: two page windows, the chrome overlay framing the one
   * in use, the resident command panel, detached devtools on the page, the
   * HUD, and the never-shown core background renderer. The app is active and
   * the page host holds key.
   */
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
      { type: 'WindowShown', id: chromeOverlay },
      { type: 'WindowShown', id: cmdPanel },
      { type: 'WindowShown', id: devtools },
      { type: 'WindowShown', id: hud },
      { type: 'AppActivated' },
      { type: 'OverlayAttached', overlayId: chromeOverlay, hostId: pageHost },
      { type: 'OsFocusGained', id: pageHost },
    ]);

  const focusFamilyIds = (effects: Effect[]): WindowId[] =>
    effects.filter((e) => e.type === 'ShowWindow' || e.type === 'RaiseWindow').map((e) => e.id);

  it('the scene starts where the old model did: the page host holds key AND is the command target', () => {
    // The premise every case below overturns — while these two agree, one
    // stored fact is enough, and that is exactly why the old reducer could
    // hold `front` alone. Each test after this one moves them apart.
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
    // OVERTURNS: `(e) palette-issuer exclusion: a satellite palette focus never
    // clobbers the front page`, and `a LIVE satellite palette is not evicted by
    // the next transition`. The palette does clobber `key` — that is what
    // taking keyboard focus MEANS — and the page survives as main.
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
    // OVERTURNS: `OS_FOCUS_GAINED on a satellite drives no FOCUS_CONTENT and
    // does not touch the ordered stack`. There is one order now and the palette
    // is in it, so the palette tops it; main is unmoved because a palette is
    // not a content window, NOT because it was filtered from the list.
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
    // OVERTURNS: `the overlay is never front (it is a satellite)`, `focus
    // landing on the overlay (satellite) keeps the content window as front`,
    // and `overlay (satellite) focus leaves the close/command target on the
    // host (cmd+W redirect)`. The exclusion was faking a RELATION: it could
    // say "not the overlay" but never "the host this overlay frames". Both
    // stored facts say it directly.
    //
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

    // The Cmd+W redirect, as the composition `isContentWindow` documents: the
    // key window when it is itself content, else main. With the chrome key,
    // that resolves to the host — the redirect the old test spelled as "front
    // is not the overlay".
    const key = keyWindow(state);
    const closeTarget = key !== null && isContentWindow(key) ? key : topmost(state, isContentWindow);
    assert.strictEqual(closeTarget?.id, otherHost);
  });

  // ── Devtools ──────────────────────────────────────────────────────────────

  it('devtools genuinely IS key — which is precisely why the Escape grab must not arm', () => {
    // OVERTURNS: `OS focus landing on a registered devtools window yanks
    // nothing back (Esc grab stays off)`. The old answer was right for the
    // wrong reason — it kept `front` off devtools and concluded the grab was
    // irrelevant. The kernel says devtools holds key, and the grab stays off
    // BECAUSE it does: an OS-level grab would swallow Escape before the
    // devtools UI ever saw it.
    //
    // `shouldArmEscapeGrab` lives in `window-escape.ts` (a pure read of this
    // kernel's snapshot); the assertion is made against it rather than
    // restated as prose, so the overturned behavior is actually pinned.
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

  it('closing a parentless palette that holds key leaves NOBODY holding key, and raises nothing', () => {
    // OVERTURNS: `a satellite gaining OS focus leaves front alone, and closing
    // that parentless palette raises NOTHING`. The raise half survives; the
    // premise does not. `key` names the palette while it lives, the id dangles
    // once it is gone, and the kernel reports "nobody holds key" instead of
    // repairing to a successor (RULE 2).
    const withPalette = evolve(scene(), { type: 'OsFocusGained', id: cmdPanel });
    assert.strictEqual(withPalette.order.find((w) => w.id === cmdPanel)?.parentId, undefined, 'no parent to hand back to');

    const ev: Event = { type: 'WindowClosed', id: cmdPanel };
    const closed = evolve(withPalette, ev);
    const effects = react(withPalette, ev, closed);

    assert.strictEqual(closed.key, cmdPanel, 'the raw field still dangles — unrepaired');
    assert.strictEqual(keyWindow(closed), null, 'and reads as: nobody holds key');
    assert.strictEqual(topmost(closed, isContentWindow)?.id, pageHost, 'main is untouched by the close');
    assert.deepStrictEqual(effects.filter((e) => e.type === 'RaiseWindow'), [], 'nothing is raised in its place');
    assert.deepStrictEqual(focusFamilyIds(effects), [], 'and nothing is shown either — a raise SHOWS what it raises');
  });

  // ── The most dangerous rename in the migration ────────────────────────────

  it('with no content window on screen, the focused window still holds key — the command target is what is null', () => {
    // OVERTURNS, and it is the file's most dangerous test: `a background /
    // non-focusable / overlay surface (satellite) does NOT become front`
    // asserts a literal `front === null`, which survives a mechanical rename to
    // `keyWindow(state) === null` and would be WRONG. The state it builds has
    // no content window at all, so `null` was answering the command-target
    // question, not the key question.
    //
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
    // OVERTURNS: `a modal palette (satellite) is excluded as a target`, which
    // dispatches only `WindowShown` and reads as an exclusion test. `key` is
    // unwritten there for a completely different reason from the focus cases
    // above: `WindowShown` does not write key at all.
    //
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
    // OVERTURNS: `a dangling front (no matching WindowRecord) is NOT a
    // representable StateSnapshot`, and the `front-invariant guard` pair that
    // threw in dev/test and self-corrected in production — the forbidden
    // repair (§0.1.5). Here the state is ordinary: `keyWindow` returns null,
    // so the grab arms and Escape has a listener, which is the honest outcome
    // when nothing can hear `before-input-event`.
    //
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

// ── Teardown: commands in, effects out (§0.1.5) ──────────────────────────────

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

  /** Runs one command end to end and returns the events it produced plus the effects those events drove. */
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
    assert.deepStrictEqual(after.effects, [{ type: 'HideWindow', id: wid(1) }], 'no second DestroyWindow');
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

// ── Focus assert: a request that carries no state change of its own ──────────
//
// The port of the old machine's shared `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` arm
// (`window-state.ts`, `applyRaiseRequest(state, state.front, effects)`).
// Devtools opens with `activate: false` and takes macOS first responder off the
// content `WebContentsView` of the front window; nothing about the window model
// changes, so re-driving the raise is the only thing that gives first responder
// back — and without it the `7c61e917` shape returns (no `before-input-event`,
// so Escape has no handler at all).
//
// The whole point of the family: in this kernel the transition is a NO-DIFF one
// — the target is already topmost, already visible, already key — so the
// request has to become a fact `react` can diff, exactly like teardown above.
// A plain `RaiseWindow` command would fold to an `OsFocusGained` that reorders
// nothing and therefore drives nothing at all.

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

  /** A palette: focusable and visible, but NOT `isContentWindow` (its role is not a content role). */
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

  /** One visible, focused content window — the shape the devtools re-assert names. */
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
    // The silent no-op that reproduces `7c61e917`: `decide` turns `RaiseWindow`
    // into an `OsFocusGained`, the window is already topmost, so `react`'s
    // reorder rule sees the same top in `prev` and `next` and emits nothing —
    // and there is no `FocusContent` in that path at all.
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

    assert.deepStrictEqual(after.effects, [{ type: 'HideWindow', id: wid(1) }], 'no second RaiseWindow, no second FocusContent');
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

  /** A HUD: a higher band, never key — one of the windows `order` holds that the import never names. */
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

  /**
   * Three restored pages plus the two windows a session restore never names:
   * the command palette (holding key, as it does when the user triggers a
   * restore) and the HUD. Every window visible and orderable, so the stacking
   * sweep really fires.
   *
   * `order` bottom -> top: [1, 2, 3, 11, 10] — the palette took key last, so
   * it sits on top.
   */
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

  // ── Where unnamed windows go — the divergence from the old machine ────────

  it('a window the import does not name keeps its index — NOT demoted below the imported set', () => {
    // The conscious divergence from `window-state.ts`'s `STACK_ORDER_IMPORTED`,
    // which rebuilds the list as `[...unnamed, ...imported]`. The old behavior
    // is pinned by `window-state.test.ts` "members the import does not name
    // keep their relative order BELOW the imported set", and that test is
    // deliberately not ported: this kernel's `order` holds EVERY registered
    // window, so demoting the palette and the HUD beneath every restored page
    // would corrupt the `topmost(...)`-based queries built on it.
    const before = restored();
    assert.deepStrictEqual(ids(before), [wid(1), wid(2), wid(3), wid(11), wid(10)]);

    const after = importOrder(before, [wid(3), wid(1), wid(2)]).state;

    // The named records were rewritten into the three slots they already
    // occupied (0, 1, 2), in the payload's relative order ...
    assert.deepStrictEqual(ids(after), [wid(3), wid(1), wid(2), wid(11), wid(10)]);
    // ... and the two the payload never mentions did not move at all.
    assert.strictEqual(after.order.indexOf(before.order[3]), 3, 'the HUD kept its index');
    assert.strictEqual(after.order.indexOf(before.order[4]), 4, 'the palette kept its index');
    // What the old machine would have produced instead, stated so the
    // divergence is legible rather than implied.
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

  it('an import emits the full bottom -> top stacking sweep and NO RaiseWindow', () => {
    // An order import must never activate anything (the old machine forbids it
    // outright). It holds here without the import having to be constrained:
    // `react`'s raise rule diffs `State.key`, which a permutation never writes.
    const before = restored();
    const { state: after, effects } = importOrder(before, [wid(3), wid(1), wid(2)]);

    assert.deepStrictEqual(effects, [
      { type: 'SetStacking', id: wid(3), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(1), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(2), layer: BASE_LAYER },
      { type: 'SetStacking', id: wid(11), layer: BASE_LAYER + 1 },
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

// ── Arming the cold-start focus latch ───────────────────────────────────────
//
// The ARMING half only — what writes `State.pendingColdStartFocus`. SPENDING it
// (the activation that re-raises the latched window and clears the field) is a
// separate slice, so nothing below asserts a consumption.
// ─────────────────────────────────────────────────────────────────────────────

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

  /**
   * Two restored pages, the second holding key — the shape a restore pass is in
   * when it arms the latch on the saved-focused descriptor.
   */
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
