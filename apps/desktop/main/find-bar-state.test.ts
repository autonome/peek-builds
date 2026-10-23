import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createFindBarState } from './find-bar-state.js';

describe('find bar state', () => {
  it('is closed until a window opens it', () => {
    const s = createFindBarState();
    assert.strictEqual(s.isOpen(1), false);
    s.markOpen(1);
    assert.strictEqual(s.isOpen(1), true);
    assert.strictEqual(s.isOpen(2), false);
  });

  it('closing one window leaves the others open', () => {
    const s = createFindBarState();
    s.markOpen(1);
    s.markOpen(2);
    s.markClosed(1);
    assert.strictEqual(s.isOpen(1), false);
    assert.strictEqual(s.isOpen(2), true);
  });

  it('opening twice and closing once leaves it closed', () => {
    const s = createFindBarState();
    s.markOpen(1);
    s.markOpen(1);
    s.markClosed(1);
    assert.strictEqual(s.isOpen(1), false);
  });
});
