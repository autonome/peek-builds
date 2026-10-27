/**
 * Unit tests for the pure detent→window-action map in hybrid-window-gesture.ts
 * (content-area double-click window gesture, peek d8ce0ddf).
 *
 * Only `windowGestureAction` is exercised here — it is a pure function of the
 * native multi-click count (`MouseEvent.detail`). Only detent 2 (double-click)
 * maps to an action (toggle-maximize); fullscreen is no longer a content gesture
 * (it is command-driven and owned by main's setHybridHostFullScreen). The stateful
 * side of the module (`initHybridWindowGestureHandling` registers an ipcMain
 * receiver; `handleContentWindowGesture` resolves the sender WebContents → host
 * BaseWindow via the registry and publishes the maximize toggle) needs a real
 * content WC and the live hybrid registry, which a node-side unit can't fabricate
 * — that path is covered end-to-end by
 * tests/desktop/hybrid-content-window-gesture.spec.ts.
 *
 * Runs under runner 1 (main-process unit, `electron --test`) so importing the
 * module — which pulls in `electron` (ipcMain) + pubsub + the hybrid registry —
 * resolves the same way it does in production.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  windowGestureAction,
  plainWindowToggle,
  handleContentWindowGesture,
  setPlainWindowGestureHost,
} from './hybrid-window-gesture.js';

describe('windowGestureAction (native click detent → window action)', () => {
  it('detent 2 (double-click) → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2), 'toggle-maximize');
  });

  // Triple-click (detent 3) is no longer a window gesture — fullscreen is
  // command-driven now, not a content gesture.
  it('detent 3 (triple-click) → null (no gesture)', () => {
    assert.strictEqual(windowGestureAction(3), null);
  });

  // Single click, quad-click, and every other count are NOT a window gesture.
  for (const detent of [0, 1, 4, 5, 100]) {
    it(`detent ${detent} → null (no gesture)`, () => {
      assert.strictEqual(windowGestureAction(detent), null);
    });
  }

  it('undefined → null', () => {
    assert.strictEqual(windowGestureAction(undefined), null);
  });

  it('null → null', () => {
    assert.strictEqual(windowGestureAction(null), null);
  });

  // Strict equality, no coercion: a string "2" is not the native detent 2.
  it("non-number '2' → null (no type coercion)", () => {
    assert.strictEqual(windowGestureAction('2'), null);
  });

  it('non-number "3" → null (no type coercion)', () => {
    assert.strictEqual(windowGestureAction('3'), null);
  });
});

describe('windowGestureAction drag suppression (press-to-release travel vs GESTURE_DRAG_SLOP_PX)', () => {
  it('stationary detent 2 (no travel) → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2, 0, 0), 'toggle-maximize');
  });

  it('stationary detent 3 (no travel) → null (fullscreen is not a content gesture)', () => {
    assert.strictEqual(windowGestureAction(3, 0, 0), null);
  });

  it('detent 2 dragged well past slop on X → null (click-drag, not a gesture)', () => {
    assert.strictEqual(windowGestureAction(2, 40, 0), null);
  });

  it('detent 2 dragged well past slop on Y → null (click-drag, not a gesture)', () => {
    assert.strictEqual(windowGestureAction(2, 0, 40), null);
  });

  it('detent 3 dragged well past slop → null (click-drag, not a gesture)', () => {
    assert.strictEqual(windowGestureAction(3, 0, 30), null);
  });

  it('travel within slop (hypot ~4.24 < 5) → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2, 3, 3), 'toggle-maximize');
  });

  it('travel just past slop (hypot ~5.66 > 5) → null', () => {
    assert.strictEqual(windowGestureAction(2, 4, 4), null);
  });

  it('negative travel counts as travel → null', () => {
    assert.strictEqual(windowGestureAction(2, -40, 0), null);
  });

  it('missing travel args treated as stationary → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2), 'toggle-maximize');
  });

  it('undefined travel treated as stationary → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2, undefined, undefined), 'toggle-maximize');
  });

  it('NaN travel treated as stationary → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2, NaN, NaN), 'toggle-maximize');
  });

  it('non-number travel (string/null) treated as stationary → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2, 'x', null), 'toggle-maximize');
  });
});

describe('plainWindowToggle (plain peek:// window, dead-space double-click)', () => {
  it('maximizes a restored window', () => {
    assert.strictEqual(plainWindowToggle({ maximized: false, fullscreen: false, optOut: false }), 'maximize');
  });
  it('restores a maximized window', () => {
    assert.strictEqual(plainWindowToggle({ maximized: true, fullscreen: false, optOut: false }), 'unmaximize');
  });
  it('does nothing while fullscreen', () => {
    assert.strictEqual(plainWindowToggle({ maximized: false, fullscreen: true, optOut: false }), null);
  });
  it('does nothing for a window that opted out', () => {
    assert.strictEqual(plainWindowToggle({ maximized: false, fullscreen: false, optOut: true }), null);
  });
});

describe('handleContentWindowGesture routing for a sender that is not a hybrid page host', () => {
  const sender = { id: -1 } as unknown as import('electron').WebContents;
  const calls: string[] = [];
  const host = (facts: { maximized: boolean; fullscreen: boolean; optOut: boolean } | null) => ({
    describe: () => facts,
    apply: (_s: unknown, t: string) => { calls.push(t); },
  });

  it('toggles a plain window through the host on a stationary double-click', () => {
    calls.length = 0;
    setPlainWindowGestureHost(host({ maximized: false, fullscreen: false, optOut: false }));
    handleContentWindowGesture(sender, 2, 0, 0);
    assert.deepStrictEqual(calls, ['maximize']);
    setPlainWindowGestureHost(null);
  });
  it('ignores a drag, a non-double click, an unknown window, and an opt-out', () => {
    calls.length = 0;
    setPlainWindowGestureHost(host({ maximized: false, fullscreen: false, optOut: false }));
    handleContentWindowGesture(sender, 2, 30, 0);
    handleContentWindowGesture(sender, 1, 0, 0);
    setPlainWindowGestureHost(host(null));
    handleContentWindowGesture(sender, 2, 0, 0);
    setPlainWindowGestureHost(host({ maximized: false, fullscreen: false, optOut: true }));
    handleContentWindowGesture(sender, 2, 0, 0);
    assert.deepStrictEqual(calls, []);
    setPlainWindowGestureHost(null);
  });
});
