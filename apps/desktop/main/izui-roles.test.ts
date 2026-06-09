/**
 * Unit tests for the pure IZUI role module.
 *
 * Covers:
 *   - inferIzuiRole: how api.window.open params map to an IZUI role
 *   - TRANSIENT_ROLES: which roles are transient/overlay-class
 *   - spacesPolicyForRole: how IZUI role maps to macOS Spaces policy
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  inferIzuiRole,
  spacesPolicyForRole,
  selectTransientSiblingsToClose,
  TRANSIENT_ROLES,
} from './izui-roles.js';

describe('inferIzuiRole', () => {
  it('returns the explicit role when caller provided one', () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'utility' }, { isWebPage: false, parentWindowId: null }),
      'utility',
    );
  });

  it("returns 'overlay' when options.overlay is true", () => {
    assert.strictEqual(
      inferIzuiRole({ overlay: true }, { isWebPage: false, parentWindowId: null }),
      'overlay',
    );
  });

  it("returns 'palette' when modal + keepLive", () => {
    assert.strictEqual(
      inferIzuiRole({ modal: true, keepLive: true }, { isWebPage: false, parentWindowId: null }),
      'palette',
    );
  });

  it("returns 'quick-view' when modal alone", () => {
    assert.strictEqual(
      inferIzuiRole({ modal: true }, { isWebPage: false, parentWindowId: null }),
      'quick-view',
    );
  });

  it("returns 'workspace' when escapeMode is 'navigate'", () => {
    assert.strictEqual(
      inferIzuiRole({ escapeMode: 'navigate' }, { isWebPage: false, parentWindowId: null }),
      'workspace',
    );
  });

  it("returns 'child-content' when webpage opened from a real parent", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: true, parentWindowId: 7 }),
      'child-content',
    );
  });

  it("returns 'content' when webpage opened without parent", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: true, parentWindowId: null }),
      'content',
    );
  });

  it("defaults to 'workspace' for non-modal, non-webpage windows", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: false, parentWindowId: null }),
      'workspace',
    );
  });

  it("promotes explicit role:'content' to 'child-content' when parent present", () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'content' }, { isWebPage: true, parentWindowId: 9 }),
      'child-content',
    );
  });

  it("does NOT promote 'content' when no parent", () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'content' }, { isWebPage: true, parentWindowId: null }),
      'content',
    );
  });
});

describe('TRANSIENT_ROLES', () => {
  it('includes palette, quick-view, overlay', () => {
    assert.ok(TRANSIENT_ROLES.has('palette'));
    assert.ok(TRANSIENT_ROLES.has('quick-view'));
    assert.ok(TRANSIENT_ROLES.has('overlay'));
  });

  it('excludes workspace, content, child-content, utility', () => {
    assert.ok(!TRANSIENT_ROLES.has('workspace'));
    assert.ok(!TRANSIENT_ROLES.has('content'));
    assert.ok(!TRANSIENT_ROLES.has('child-content'));
    assert.ok(!TRANSIENT_ROLES.has('utility'));
  });
});

describe('selectTransientSiblingsToClose', () => {
  // The candidate set deliberately mixes BrowserWindow and hybrid (BaseWindow)
  // windows — the selector is role/visibility-based and kind-agnostic. The
  // close-on-blur regression (peek 8e5c3174) was that hybrid peek/slide windows
  // (role 'quick-view') were never in the candidate set at all.
  const visibleQuickView = (id: number) => ({ id, role: 'quick-view', visible: true });

  it('closes a visible quick-view sibling when a workspace window focuses', () => {
    const out = selectTransientSiblingsToClose(1, 'workspace', [
      { id: 1, role: 'workspace', visible: true },
      visibleQuickView(2),
    ]);
    assert.deepStrictEqual(out, [2]);
  });

  it('closes a quick-view sibling when ANOTHER quick-view focuses (new transient stands)', () => {
    const out = selectTransientSiblingsToClose(2, 'quick-view', [
      visibleQuickView(1),
      visibleQuickView(2),
    ]);
    assert.deepStrictEqual(out, [1]);
  });

  it('never closes the focuser itself', () => {
    const out = selectTransientSiblingsToClose(1, 'quick-view', [visibleQuickView(1)]);
    assert.deepStrictEqual(out, []);
  });

  it('closes NOTHING when the focuser is a utility window (chain-popup invariant)', () => {
    const out = selectTransientSiblingsToClose(9, 'utility', [
      visibleQuickView(1),
      { id: 2, role: 'palette', visible: true },
    ]);
    assert.deepStrictEqual(out, []);
  });

  it('skips non-visible transient siblings', () => {
    const out = selectTransientSiblingsToClose(1, 'workspace', [
      { id: 2, role: 'quick-view', visible: false },
    ]);
    assert.deepStrictEqual(out, []);
  });

  it('skips non-transient windows (workspace / content) and roleless windows', () => {
    const out = selectTransientSiblingsToClose(1, 'workspace', [
      { id: 2, role: 'content', visible: true },
      { id: 3, role: 'workspace', visible: true },
      { id: 4, role: undefined, visible: true },
    ]);
    assert.deepStrictEqual(out, []);
  });

  it("exempts 'overlay' — it manages its own restoration via the IZUI coordinator", () => {
    const out = selectTransientSiblingsToClose(1, 'workspace', [
      { id: 2, role: 'overlay', visible: true },
      visibleQuickView(3),
    ]);
    assert.deepStrictEqual(out, [3]);
  });

  it('closes both palette and quick-view siblings together', () => {
    const out = selectTransientSiblingsToClose(1, 'workspace', [
      { id: 2, role: 'palette', visible: true },
      visibleQuickView(3),
      { id: 4, role: 'workspace', visible: true },
    ]);
    assert.deepStrictEqual(out, [2, 3]);
  });
});

describe('spacesPolicyForRole', () => {
  it("returns 'follow' for palette on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'darwin'), 'follow');
  });

  it("returns 'follow' for quick-view on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('quick-view', 'darwin'), 'follow');
  });

  it("returns 'follow' for overlay on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('overlay', 'darwin'), 'follow');
  });

  it("returns 'anchor' for workspace on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('workspace', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for content on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('content', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for child-content on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('child-content', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for utility on darwin (no follow needed; ESC closes it)", () => {
    assert.strictEqual(spacesPolicyForRole('utility', 'darwin'), 'anchor');
  });

  it("returns 'none' on linux for any role", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'linux'), 'none');
    assert.strictEqual(spacesPolicyForRole('workspace', 'linux'), 'none');
  });

  it("returns 'none' on win32 for any role", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'win32'), 'none');
    assert.strictEqual(spacesPolicyForRole('workspace', 'win32'), 'none');
  });
});
