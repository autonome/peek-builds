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
  resolveHybridEscapeTarget,
  shouldRegisterGlobalEscFallback,
  shouldFocusHybridContentOnHostFocus,
  resolveCloseTargetId,
  ALWAYS_CLOSEABLE_ESC_ROLES,
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

describe('resolveHybridEscapeTarget (wrong-window / first-responder redirect — peek ebb10894)', () => {
  // The live regression: ESC on a freshly opened peek/slide opens the Windows
  // switcher MOST of the time, but closes correctly if the user first clicks the
  // content. Root cause = first-responder lag: ESC lands on the PREVIOUS hybrid
  // content host's before-input-event (role 'content' → escPolicy 'nothing' →
  // escUnhandledPolicy → switcher) while the just-opened quick-view IS the active
  // hybrid window (the registry's focus source of truth, set on open). The
  // resolver redirects ESC to the active host when that one is always-closeable.

  it('redirects ESC to the active quick-view when it landed on a DIFFERENT content host', () => {
    // ESC landed on host 11 (the previous page, role 'content'); the active
    // hybrid window is 22, a quick-view peek/slide. Must resolve against 22.
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'quick-view'), 22);
  });

  it('redirects for any always-closeable active role (palette / utility / overlay)', () => {
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'palette'), 22);
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'utility'), 22);
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'overlay'), 22);
  });

  it('does NOT redirect when ESC already landed on the active hybrid window', () => {
    // Common case once the content WC is first responder: landed === active.
    assert.strictEqual(resolveHybridEscapeTarget(22, 22, 'quick-view'), 22);
  });

  it('does NOT redirect when there is no active hybrid window', () => {
    assert.strictEqual(resolveHybridEscapeTarget(11, null, undefined), 11);
  });

  it("does NOT redirect toward a content/workspace active window (never force-close a page)", () => {
    // A 'content' or 'workspace' active window has its own ESC semantics — ESC
    // must resolve against the host it actually landed on, not be hijacked.
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'content'), 11);
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'workspace'), 11);
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, 'child-content'), 11);
  });

  it('does NOT redirect when the active role is unknown/unregistered', () => {
    assert.strictEqual(resolveHybridEscapeTarget(11, 22, undefined), 11);
  });

  it('ALWAYS_CLOSEABLE_ESC_ROLES matches escPolicy close roles, excludes session-dependent', () => {
    assert.ok(ALWAYS_CLOSEABLE_ESC_ROLES.has('quick-view'));
    assert.ok(ALWAYS_CLOSEABLE_ESC_ROLES.has('palette'));
    assert.ok(ALWAYS_CLOSEABLE_ESC_ROLES.has('utility'));
    assert.ok(ALWAYS_CLOSEABLE_ESC_ROLES.has('overlay'));
    assert.ok(!ALWAYS_CLOSEABLE_ESC_ROLES.has('content'));
    assert.ok(!ALWAYS_CLOSEABLE_ESC_ROLES.has('child-content'));
    assert.ok(!ALWAYS_CLOSEABLE_ESC_ROLES.has('workspace'));
  });
});

describe('shouldRegisterGlobalEscFallback (global ESC grab vs hybrid focus — peek ebb10894)', () => {
  // The live regression: open a slide/peek → ESC opens the Windows switcher and
  // the slide stays open. Root cause = the OS-level global ESC fallback grabs
  // ESC (pre-empting the slide's own before-input close handler) because its
  // predicate was `appActive && getFocusedWindow() === null`, and
  // getFocusedWindow() returns null for a hybrid BaseWindow (slide/peek). So a
  // focused slide looked like "no focused Peek window" → grab → switcher.
  //
  // THE FAILING-FIRST ASSERTION: a focused hybrid slide/peek (no focused
  // BrowserWindow, but an active hybrid window) must NOT register the grab.
  // The pre-fix predicate (ignoring hasActiveHybridWindow) returned true here.
  it('does NOT register when a hybrid window is active (slide/peek focused, no BrowserWindow)', () => {
    // appActive, no focused BrowserWindow (getFocusedWindow null for BaseWindow),
    // but a slide/peek IS the active hybrid window → the grab must be declined so
    // ESC reaches the slide's own close handler.
    assert.strictEqual(shouldRegisterGlobalEscFallback(true, false, true), false);
  });

  it('DOES register when Peek is active with no focused window of any kind', () => {
    // The genuine fallback case: Peek active, no focused BrowserWindow AND no
    // active hybrid window (e.g. Cmd+Tab to Peek on a Space holding none of its
    // windows) → ESC has nowhere to land, so the global grab opens the switcher.
    assert.strictEqual(shouldRegisterGlobalEscFallback(true, false, false), true);
  });

  it('does NOT register when a real BrowserWindow is focused', () => {
    assert.strictEqual(shouldRegisterGlobalEscFallback(true, true, false), false);
    assert.strictEqual(shouldRegisterGlobalEscFallback(true, true, true), false);
  });

  it('does NOT register when Peek is not the active app', () => {
    assert.strictEqual(shouldRegisterGlobalEscFallback(false, false, false), false);
    assert.strictEqual(shouldRegisterGlobalEscFallback(false, false, true), false);
  });
});

describe('shouldFocusHybridContentOnHostFocus (restore first responder on host raise — traced 2026-06-10)', () => {
  // The live regression: a hybrid page-host restored via showInactive (session
  // restore) and later RAISED by chrome / Cmd+Tab / Mission Control fires
  // baseWin 'focus' but its content WebContentsView is never made first
  // responder. So ESC reaches neither the content WC before-input-event NOR the
  // (correctly suppressed) global fallback — dead until the user clicks the
  // page. THE FAILING-FIRST ASSERTION: on host focus, a live + not-already-
  // focused content WC must be re-focused.
  it('DOES focus when not headless, content alive, and not already first responder', () => {
    assert.strictEqual(shouldFocusHybridContentOnHostFocus(false, false, false), true);
  });

  it('does NOT focus when the content WC is already first responder (host focus came from a page click)', () => {
    // Avoids a redundant re-focus and a potential contentWC 'focus' event loop.
    assert.strictEqual(shouldFocusHybridContentOnHostFocus(false, false, true), false);
  });

  it('does NOT focus when headless (focus-free — never steal the real first responder)', () => {
    assert.strictEqual(shouldFocusHybridContentOnHostFocus(true, false, false), false);
    assert.strictEqual(shouldFocusHybridContentOnHostFocus(true, false, true), false);
  });

  it('does NOT focus when the content WC has been destroyed', () => {
    assert.strictEqual(shouldFocusHybridContentOnHostFocus(false, true, false), false);
  });
});

describe('resolveCloseTargetId (cmd+W overlay redirect — address bar/widgets open)', () => {
  // THE FAILING-FIRST ASSERTION: with the shared chrome overlay focused (Cmd+L
  // opened the address bar/widgets), getFocusedWindow() returns the OVERLAY, not
  // the page-host. Closing the overlay alone dismissed the chrome and left the
  // page visible. cmd+W must instead target the active hybrid host so the whole
  // host goes away.
  it('targets the active hybrid host when the focused window IS the overlay', () => {
    assert.strictEqual(resolveCloseTargetId(/* overlay id */ 7, /* isOverlay */ true, /* host */ 3), 3);
  });

  it('targets the focused BrowserWindow when it is NOT the overlay (settings/modal/canvas host)', () => {
    assert.strictEqual(resolveCloseTargetId(5, false, 3), 5);
  });

  it('targets the active hybrid host when no BrowserWindow is focused (frontmost is a BaseWindow — peek ca4ee5e6)', () => {
    assert.strictEqual(resolveCloseTargetId(null, false, 3), 3);
  });

  it('returns null when the overlay is focused but there is no active hybrid host', () => {
    assert.strictEqual(resolveCloseTargetId(7, true, null), null);
  });

  it('returns null when nothing resolves (no focused window, no active hybrid host)', () => {
    assert.strictEqual(resolveCloseTargetId(null, false, null), null);
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
