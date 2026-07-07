/**
 * Unit tests for the pure detent→window-action map in hybrid-window-gesture.ts
 * (content-area double/triple-click window gesture, peek d8ce0ddf).
 *
 * Only `windowGestureAction` is exercised here — it is a pure function of the
 * native multi-click count (`MouseEvent.detail`). The stateful side of the
 * module (`initHybridWindowGestureHandling` registers an ipcMain receiver;
 * `handleContentWindowGesture` resolves the sender WebContents → host BaseWindow
 * via the registry and publishes / toggles fullscreen) needs a real content WC
 * and the live hybrid registry, which a node-side unit can't fabricate — that
 * path is covered end-to-end by tests/desktop/hybrid-content-window-gesture.spec.ts.
 *
 * Runs under runner 1 (main-process unit, `electron --test`) so importing the
 * module — which pulls in `electron` (ipcMain) + pubsub + the hybrid registry —
 * resolves the same way it does in production.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { windowGestureAction } from './hybrid-window-gesture.js';

describe('windowGestureAction (native click detent → window action)', () => {
  it('detent 2 (double-click) → toggle-maximize', () => {
    assert.strictEqual(windowGestureAction(2), 'toggle-maximize');
  });

  it('detent 3 (triple-click) → toggle-fullscreen', () => {
    assert.strictEqual(windowGestureAction(3), 'toggle-fullscreen');
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
