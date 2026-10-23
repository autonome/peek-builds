import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { applyPinnedRestoreOptions } from './session-restore-pin.js';
import { classifyWindowRegistration, deriveCanBecomeKey } from './izui-roles.js';

describe('applyPinnedRestoreOptions', () => {
  it('pins and drops a saved focusable:false so the window can be closed', () => {
    const options: Record<string, unknown> = { focusable: false, title: 'x' };
    applyPinnedRestoreOptions(options, 'global');
    assert.strictEqual(options.alwaysOnTop, true);
    assert.strictEqual(options.pinScope, 'global');
    assert.ok(!('focusable' in options));
    assert.strictEqual(options.title, 'x');
    // What the open then derives: not a HUD, and able to become key.
    assert.strictEqual(
      classifyWindowRegistration('workspace', { alwaysOnTop: true, focusable: options.focusable as boolean | undefined }),
      'primary',
    );
    assert.strictEqual(deriveCanBecomeKey({ focusable: options.focusable as boolean | undefined }), true);
  });

  it('keeps focusable:false on an unpinned window', () => {
    const options: Record<string, unknown> = { focusable: false };
    applyPinnedRestoreOptions(options, undefined);
    assert.strictEqual(options.focusable, false);
    assert.ok(!('alwaysOnTop' in options));
    assert.ok(!('pinScope' in options));
  });

  it('treats an empty pin scope as unpinned', () => {
    const options: Record<string, unknown> = { focusable: false };
    applyPinnedRestoreOptions(options, null);
    assert.strictEqual(options.focusable, false);
  });
});
