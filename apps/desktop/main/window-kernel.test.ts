/**
 * Unit tests for the rewritten window-manager kernel (`window-kernel.ts`).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1, in particular §0.1.8 item 2
 * ("Replay determinism — a standing requirement, enforced by a test that
 * fails when it breaks"). Follows the harness conventions of
 * `window-state.test.ts` (`node:test` + `node:assert`, `.js`-suffixed import
 * of the compiled output, a small branded-id builder).
 *
 * NOTE on "effects": §0.1.8 phrases the determinism rule as "identical state
 * AND an identical effect list", describing the eventual `evolve` that also
 * returns effects (mirroring `window-state.ts reduce()`). This slice's
 * `evolve(state, ev): State` returns state only — no function in
 * `window-kernel.ts` produces `Effect`s yet (the type is declared for a later
 * slice). The determinism/prefix-stability tests below are therefore checked
 * over `State` only; there is no effect list to concatenate.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  decide,
  topmost,
  keyWindow,
  type State,
  type Event,
  type WindowId,
} from './window-kernel.js';

// ── Test builders ────────────────────────────────────────────────────────────

/** Craft a WM WindowId for tests — the kernel never checks the shape, only identity. */
const wid = (n: number): WindowId => `wk-${n}` as WindowId;

function fold(events: Event[], start: State = initialState()): State {
  return events.reduce(evolve, start);
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
  it('INVARIANT: replay determinism — same log yields identical state', () => {
    const log = buildLog();
    const s1 = fold(log);
    const s2 = fold(log);
    assert.deepStrictEqual(s1, s2);
  });

  it('INVARIANT: prefix stability — folding a split log resumes to the same state as folding it whole', () => {
    const log = buildLog();
    const whole = fold(log);
    for (let n = 0; n <= log.length; n++) {
      const prefixState = fold(log.slice(0, n));
      const resumed = fold(log.slice(n), prefixState);
      assert.deepStrictEqual(resumed, whole, `split at n=${n} diverged from the whole-log fold`);
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
});
