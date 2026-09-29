/**
 * Unit tests for the Escape interpreter (`window-escape.ts`).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1.3. Harness conventions follow
 * `window-kernel.test.ts` (`node:test` + `node:assert`, `.js`-suffixed import of
 * the compiled output, a branded-id builder, scenes folded from real
 * `WindowRegistered` events).
 *
 * EVERY window below is registered with the flags its REAL construction site
 * passes, so nothing here passes vacuously — same discipline as
 * `window-kernel.test.ts`'s `which windows a real app resign hides`. The sites:
 *
 *   - workspace host   `hybrid-overlay.ts` (`kind:'page-host'`, `role:'content'`,
 *                      `class:'primary'` via `classifyWindowRegistration`)
 *   - command palette  a focusable `browser` window, `role:'palette'`,
 *                      `class:'palette'`, pinned above the stack
 *   - switcher         `features/windows/background.js openWindowsView`:
 *                      `role:'switcher'`, `alwaysOnTop`, focusable, and NEVER
 *                      attached to a host
 *   - chrome overlay   `hybrid-overlay.ts ensureOverlay`: `role:'overlay'`,
 *                      `class:'overlay'`, focusable, ATTACHED to its host
 *   - HUD              `renderer/hud/background.js`: `focusable:false`,
 *                      `alwaysOnTop:true`, `escapeMode:'ignore'`
 *   - quick-view       a slide/peek: `kind:'page-host'`, `role:'quick-view'`
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  keyWindow,
  topmost,
  isContentWindow,
  BASE_LAYER,
  type Event,
  type State,
  type WindowId,
} from './window-kernel.js';
import {
  interpretEscape,
  resolveEscapeTarget,
  switcherWindow,
  shouldArmEscapeGrab,
  escapeClosePolicy,
  escapeFallbackPolicy,
  type EscapeKeyPress,
} from './window-escape.js';

// ── Builders ────────────────────────────────────────────────────────────────

const wid = (n: number): WindowId => `we-${n}` as WindowId;

const FLOATING = BASE_LAYER + 1;

function fold(events: Event[], start: State = initialState()): State {
  return events.reduce(evolve, start);
}

const workspaceHost = wid(1);
const palette = wid(2);
const switcher = wid(3);
const chromeOverlay = wid(4);
const hud = wid(5);
const quickView = wid(6);
const secondHost = wid(7);

/** `hybrid-overlay.ts` opens page hosts as `role:'content'`, class `'primary'`. */
const regHost = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'page-host', layer: BASE_LAYER,
  canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content',
});
/** The cmd panel: floats, focusable (you type in it), `role:'palette'`. */
const regPalette = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'browser', layer: FLOATING,
  canBecomeKey: true, acceptsInput: true, class: 'palette', role: 'palette', transient: true,
});
/** `features/windows/background.js`: `role:'switcher'`, alwaysOnTop, focusable, never attached. */
const regSwitcher = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'browser', layer: FLOATING,
  canBecomeKey: true, acceptsInput: true, class: 'overlay', role: 'switcher', transient: true,
});
/** `hybrid-overlay.ts ensureOverlay`: same class as the switcher, own role — told apart by attachment. */
const regChromeOverlay = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'browser', layer: FLOATING,
  canBecomeKey: true, acceptsInput: true, class: 'overlay', role: 'overlay',
});
/** `renderer/hud/background.js`: unfocusable, floating, and owns Escape itself. */
const regHud = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'browser', layer: FLOATING,
  canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace',
  escapeMode: 'ignore',
});
/** A slide/peek. */
const regQuickView = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'page-host', layer: FLOATING,
  canBecomeKey: true, acceptsInput: true, class: 'quick-view', role: 'quick-view', transient: true,
});

const show = (id: WindowId): Event => ({ type: 'WindowShown', id });
const focus = (id: WindowId): Event => ({ type: 'OsFocusGained', id });

const press = (over: Partial<EscapeKeyPress> = {}): EscapeKeyPress => ({
  landedId: 'global',
  ...over,
});

/** A workspace host, shown and holding key, with the app active. */
function loneHost(): State {
  return fold([
    { type: 'AppActivated' },
    regHost(workspaceHost),
    show(workspaceHost),
    focus(workspaceHost),
  ]);
}

/**
 * The same host, but it came up while the user was in another app — the shape
 * a peek or a slide arrives in. `AppResigned` before the registration is what
 * makes `openedInBackground` true (see `window-kernel.ts`), and it replaces
 * the `session: 'transient'` the keypress used to carry.
 */
function loneHostFromBackground(): State {
  return fold([
    { type: 'AppResigned' },
    regHost(workspaceHost),
    show(workspaceHost),
    focus(workspaceHost),
  ]);
}

/** The bug's live scene: a palette opened over the workspace host, holding key. */
function paletteOverHost(): State {
  return fold([regPalette(palette), show(palette), focus(palette)], loneHost());
}

// ── The reconciliation rule (the heart of the bug) ──────────────────────────

describe('window-escape: the landed keystroke and the key window are reconciled', () => {
  it('agreement — the landed window IS the key window, so it is the target', () => {
    const state = paletteOverHost();
    const target = resolveEscapeTarget(press({ landedId: palette }), state);
    assert.strictEqual(target.kind, 'window');
    assert.strictEqual(target.kind === 'window' ? target.record.id : null, palette);
  });

  it('the OS grab delivers no landing, so the key window is the target', () => {
    const state = paletteOverHost();
    const target = resolveEscapeTarget(press({ landedId: 'global' }), state);
    assert.strictEqual(target.kind === 'window' ? target.record.id : null, palette);
  });

  it('ESC targets the key window, never main — a quick-view holding key leaves the host as main', () => {
    // Mechanical rewrite of the old reducer's `ported: resolveHybridEscapeTarget
    // -> ESC target is always front` › `ESC targets the front quick-view, not
    // the landed content host`. The old single `front` field answered both
    // "who gets the keystroke" and "which window is the user's" at once; the
    // key/main split answers them separately, and both have to be asserted
    // together or the rewrite would be checking only half of what the old test
    // did (window-manager.md §0's front-reader wiring map: `keyWindow`
    // replaces none of the readers that want the content window).
    const state = fold([regQuickView(quickView), show(quickView), focus(quickView)], loneHost());
    assert.strictEqual(keyWindow(state)?.id, quickView, 'the quick-view took the keystroke');
    assert.strictEqual(topmost(state, isContentWindow)?.id, workspaceHost, 'the host is still the window in use');
    const target = resolveEscapeTarget(press({ landedId: 'global' }), state);
    assert.strictEqual(target.kind === 'window' ? target.record.id : null, quickView, 'ESC targets key, not main');
  });

  it('D2: key was the host when pressed and is the palette by the time the press is resolved — dropped, never redirected to the palette', () => {
    // The keystroke went to the workspace host — the window that was key when
    // the press landed. By resolution time the palette holds key instead
    // (`paletteOverHost`'s holder role, `palette`, is in `ESC_CLOSE_ROLES`, so
    // this is exactly the case the old code redirected). D2
    // (`docs/design/window-rules.md`) says the press is dropped rather than
    // redirected to the newer holder: it is never applied to the palette,
    // whatever the palette's role says about its own Escape.
    const state = paletteOverHost();
    const target = resolveEscapeTarget(press({ landedId: workspaceHost }), state);
    assert.strictEqual(target.kind, 'stale');
    const outcome = interpretEscape(press({ landedId: workspaceHost }), state);
    assert.deepStrictEqual(outcome, { kind: 'nothing', reason: 'stale-landing', command: null });
  });

  it('disagreement — a landing on a window whose holder is NOT always-closeable is dropped as stale', () => {
    // Same disagreement shape, but the holder is an ordinary content host
    // rather than a quick-view/palette/utility — nothing about its role says
    // Escape should force it closed, so the keystroke is dropped rather than
    // redirected. This is what keeps the rule from becoming "always redirect".
    const state = fold([regHost(secondHost), show(secondHost), focus(secondHost)], loneHost());
    assert.strictEqual(state.order.find((w) => w.id === secondHost)?.role, 'content');
    const target = resolveEscapeTarget(press({ landedId: workspaceHost }), state);
    assert.strictEqual(target.kind, 'stale');
    assert.deepStrictEqual(interpretEscape(press({ landedId: workspaceHost }), state), {
      kind: 'nothing',
      reason: 'stale-landing',
      command: null,
    });
  });

  it('the other direction — the same disagreement with the roles swapped is dropped too', () => {
    // Palette shown but the host took key back. A landing on the palette is stale.
    const state = fold([focus(workspaceHost)], paletteOverHost());
    assert.strictEqual(resolveEscapeTarget(press({ landedId: palette }), state).kind, 'stale');
    assert.strictEqual(
      resolveEscapeTarget(press({ landedId: workspaceHost }), state).kind === 'window'
        ? (resolveEscapeTarget(press({ landedId: workspaceHost }), state) as { record: { id: WindowId } }).record.id
        : null,
      workspaceHost,
    );
  });

  it('with nobody holding key the delivery record wins — the landed window is the target', () => {
    // `OsFocusLost` nulls `key`; the window can still be handed the keystroke.
    const state = fold([{ type: 'OsFocusLost', id: workspaceHost }], loneHost());
    assert.strictEqual(state.key, null);
    const target = resolveEscapeTarget(press({ landedId: workspaceHost }), state);
    assert.strictEqual(target.kind === 'window' ? target.record.id : null, workspaceHost);
  });

  it('no key window and no landing names nobody — the old front-is-null fallback', () => {
    const state = fold([{ type: 'OsFocusLost', id: workspaceHost }], loneHost());
    assert.strictEqual(resolveEscapeTarget(press({ landedId: 'global' }), state).kind, 'none');
    assert.deepStrictEqual(interpretEscape(press({ landedId: 'global' }), state), {
      kind: 'open-switcher',
      command: null,
    });
  });

  it('Escape on a page holding key while the app is inactive closes the transient page-host window instead of opening the switcher', () => {
    const sidePage = wid(90);
    const state = fold([{ type: 'AppResigned' }, regHost(sidePage), show(sidePage), focus(sidePage)], loneHost());
    assert.strictEqual(state.appActive, false);
    assert.deepStrictEqual(interpretEscape(press({ landedId: sidePage }), state), {
      kind: 'close-window',
      command: { type: 'CloseOrHideWindow', id: sidePage, expectedVersion: state.version },
    });
    // A hide made while the app is inactive stays hidden across the next activation.
    const visibleOf = (s: State) => s.order.find((w) => w.id === sidePage)?.visible;
    const hidden = fold([{ type: 'WindowHidden', id: sidePage }], state);
    assert.strictEqual(visibleOf(hidden), false);
    assert.strictEqual(visibleOf(fold([{ type: 'AppActivated' }], hidden)), false);
    // A role Escape always closes is closed the same way.
    const peek = fold([{ type: 'AppResigned' }, regQuickView(quickView), show(quickView), focus(quickView)], loneHost());
    assert.strictEqual(interpretEscape(press({ landedId: quickView }), peek).kind, 'close-window');
    // The same window with the app active keeps the ordinary page answer.
    const active = fold([{ type: 'AppActivated' }, focus(sidePage)], state);
    assert.strictEqual(interpretEscape(press({ landedId: sidePage }), active).kind, 'open-switcher');
  });

  it('a landing naming a window that has since closed reads as no landing', () => {
    const state = fold([{ type: 'WindowClosed', id: palette }], paletteOverHost());
    // `key` still names the closed palette, so `keyWindow` resolves to null and
    // the delivery record is all there is — and it resolves to nothing either.
    assert.strictEqual(resolveEscapeTarget(press({ landedId: palette }), state).kind, 'none');
  });

  it('a visible palette with nobody holding key is the target of a global landing — Escape closes it, never opens the switcher', () => {
    // The user switched to another app: the palette is still on screen, but
    // `OsFocusLost` for it nulls `key`, and the OS grab delivers no landing
    // (`'global'`). Neither reconciliation fact names a window, but a visible
    // palette is exactly the kind of transient Escape closes outright — so it
    // is the target, not `none`.
    const state = fold([{ type: 'OsFocusLost', id: palette }], paletteOverHost());
    assert.strictEqual(state.key, null);
    const target = resolveEscapeTarget(press({ landedId: 'global' }), state);
    assert.strictEqual(target.kind, 'window');
    assert.strictEqual(target.kind === 'window' ? target.record.id : null, palette);
    const outcome = interpretEscape(press({ landedId: 'global' }), state);
    assert.strictEqual(outcome.kind, 'close-window');
    assert.strictEqual(outcome.command?.id, palette);
  });

  it('a HIDDEN palette with nobody holding key is not a target — the press still opens the switcher', () => {
    // Same fixture, but the palette is also hidden — no visible transient is
    // left to act on, so this reverts to the ordinary nobody-to-name case.
    const state = fold(
      [{ type: 'OsFocusLost', id: palette }, { type: 'WindowHidden', id: palette }],
      paletteOverHost(),
    );
    assert.strictEqual(state.key, null);
    assert.strictEqual(resolveEscapeTarget(press({ landedId: 'global' }), state).kind, 'none');
    assert.deepStrictEqual(interpretEscape(press({ landedId: 'global' }), state), {
      kind: 'open-switcher',
      command: null,
    });
  });
});

// ── The bug itself, and the regression guard ────────────────────────────────

describe('window-escape: Escape reaches the window it landed on', () => {
  it('Escape on a palette holding key closes THAT palette', () => {
    const state = paletteOverHost();
    const outcome = interpretEscape(press({ landedId: palette }), state);
    assert.strictEqual(outcome.kind, 'close-window');
    assert.deepStrictEqual(outcome.command, {
      type: 'CloseOrHideWindow',
      id: palette,
      expectedVersion: state.version,
    });
  });

  it('REGRESSION: targeting must not revert to the topmost content window', () => {
    // The old reducer's `front`. Two content hosts are open; the SECOND is the
    // topmost content window, and the palette holds key. Anything that targets
    // "the topmost content window" names `secondHost` here — and that is
    // exactly the twelve-presses-and-nothing-closes bug.
    const state = fold(
      [regHost(secondHost), show(secondHost), focus(secondHost), regPalette(palette), show(palette), focus(palette)],
      loneHost(),
    );
    const outcome = interpretEscape(press({ landedId: palette }), state);

    assert.strictEqual(outcome.kind, 'close-window');
    assert.strictEqual(outcome.command?.id, palette);
    assert.notStrictEqual(outcome.command?.id, secondHost);
    assert.notStrictEqual(outcome.command?.id, workspaceHost);

    // And the topmost content window really IS a different window — otherwise
    // this test would pass for the wrong reason.
    const contentIds = state.order.filter((w) => w.role === 'content').map((w) => w.id);
    assert.deepStrictEqual(contentIds, [workspaceHost, secondHost]);
  });

  it('a palette is never even a candidate for the topmost-content answer', () => {
    // The old `front` was satellite-excluding, which is WHY a palette could
    // never be the Escape target. That exclusion survives in `isContentWindow`
    // — so a target derived from it can never be the palette, whatever else
    // changes.
    const state = paletteOverHost();
    const rec = state.order.find((w) => w.id === palette);
    assert.strictEqual(rec?.role, 'palette');
  });
});

// ── The switcher as an ordinary window record ──────────────────────────────

describe('window-escape: the switcher is an ordinary window record', () => {
  it('a visible unattached role-switcher window is the switcher', () => {
    const state = fold([regSwitcher(switcher), show(switcher), focus(switcher)], loneHost());
    assert.strictEqual(switcherWindow(state)?.id, switcher);
  });

  it('the shared chrome overlay is NOT the switcher — the attachment tells them apart', () => {
    const state = fold(
      [
        regChromeOverlay(chromeOverlay),
        show(chromeOverlay),
        { type: 'OverlayAttached', overlayId: chromeOverlay, hostId: workspaceHost },
      ],
      loneHost(),
    );
    assert.strictEqual(switcherWindow(state), null);
  });

  it('Escape with the switcher open closes it and names the restore target', () => {
    const state = fold([regSwitcher(switcher), show(switcher), focus(switcher)], loneHost());
    const outcome = interpretEscape(press({ landedId: switcher }), state);

    assert.strictEqual(outcome.kind, 'close-switcher');
    assert.deepStrictEqual(outcome.command, {
      type: 'CloseOrHideWindow',
      id: switcher,
      expectedVersion: state.version,
    });
    assert.strictEqual(outcome.kind === 'close-switcher' ? outcome.restoreTargetId : null, workspaceHost);
  });

  it('the restore target is DERIVED from the window list, not captured when the switcher opened', () => {
    // A second host opens AFTER the switcher. A captured `previousFront` would
    // still name the first host; the derived answer follows `order`.
    const state = fold(
      [regSwitcher(switcher), show(switcher), focus(switcher), regHost(secondHost), show(secondHost)],
      loneHost(),
    );
    const outcome = interpretEscape(press({ landedId: switcher }), state);
    assert.strictEqual(outcome.kind === 'close-switcher' ? outcome.restoreTargetId : null, secondHost);
  });

  it('closing the switcher wins over the target policy — the switcher is checked first', () => {
    // The switcher is up while a palette is also open and holds key. Escape
    // dismisses the switcher, not the palette.
    const state = fold(
      [regPalette(palette), show(palette), regSwitcher(switcher), show(switcher), focus(switcher)],
      loneHost(),
    );
    const outcome = interpretEscape(press({ landedId: switcher }), state);
    assert.strictEqual(outcome.command?.id, switcher);
  });

  it('a hidden switcher window is not open', () => {
    const state = fold(
      [regSwitcher(switcher), show(switcher), { type: 'WindowHidden', id: switcher }],
      loneHost(),
    );
    assert.strictEqual(switcherWindow(state), null);
  });
});

// ── Ordering: ignore, then fullscreen, then the renderer fact ──────────────

describe('window-escape: escapeMode and fullscreen come before the policy table', () => {
  it('a window declaring escapeMode ignore passes the keystroke through', () => {
    const state = fold([regHud(hud), show(hud), focus(hud)], loneHost());
    assert.deepStrictEqual(interpretEscape(press({ landedId: hud }), state), {
      kind: 'pass-through',
      id: hud,
      command: null,
    });
  });

  it('escapeMode ignore is the ONLY escape hatch — without it the same record falls to the policy table', () => {
    // Pinned against the simplicity-review proposal to delete
    // `WindowRecord.escapeMode`: no role in `ESC_CLOSE_ROLES` /
    // `ESC_FALLBACK_ROLES` means "pass Escape through" on its own, so removing
    // the field would silently hand the HUD's Escape to the switcher.
    const withIgnore = fold([regHud(hud), show(hud), focus(hud)], loneHost());
    assert.strictEqual(interpretEscape(press({ landedId: hud }), withIgnore).kind, 'pass-through');

    const withoutIgnore = fold(
      [
        {
          type: 'WindowRegistered', id: hud, kind: 'browser', layer: FLOATING,
          canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace',
        },
        show(hud),
        focus(hud),
      ],
      loneHost(),
    );
    assert.deepStrictEqual(interpretEscape(press({ landedId: hud }), withoutIgnore), {
      kind: 'open-switcher',
      command: null,
    });
  });

  it('a non-normal fullscreen mode exits fullscreen, whatever the role would say', () => {
    // A quick-view: its role would CLOSE it. Fullscreen wins.
    const base = fold([regQuickView(quickView), show(quickView), focus(quickView)], loneHost());
    for (const ev of [
      { type: 'FullscreenTransitionStarted', id: quickView, entering: true, preBounds: null } as Event,
      { type: 'OsFullscreenEntered', id: quickView } as Event,
      { type: 'FullscreenTransitionStarted', id: quickView, entering: false, preBounds: null } as Event,
    ]) {
      const state = fold([ev], base);
      assert.notStrictEqual(state.order.find((w) => w.id === quickView)?.fsMode.name, 'normal');
      const outcome = interpretEscape(press({ landedId: quickView }), state);
      assert.strictEqual(outcome.kind, 'exit-fullscreen');
      assert.deepStrictEqual(outcome.command, {
        type: 'SetFullscreen',
        id: quickView,
        desired: false,
        expectedVersion: state.version,
      });
    }
  });

  it('escapeMode ignore beats fullscreen — the window owns Escape outright', () => {
    const state = fold(
      [regHud(hud), show(hud), focus(hud), { type: 'FullscreenTransitionStarted', id: hud, entering: true, preBounds: null }],
      loneHost(),
    );
    assert.strictEqual(interpretEscape(press({ landedId: hud }), state).kind, 'pass-through');
  });

  it('the mirrored renderer fact stops the policy table', () => {
    const state = paletteOverHost();
    assert.deepStrictEqual(interpretEscape(press({ landedId: palette, rendererHandled: true }), state), {
      kind: 'nothing',
      reason: 'renderer-handled',
      command: null,
    });
  });

  it('fullscreen still wins over the renderer fact — the exit is not skippable', () => {
    const state = fold(
      [{ type: 'FullscreenTransitionStarted', id: workspaceHost, entering: true, preBounds: null }],
      loneHost(),
    );
    assert.strictEqual(
      interpretEscape(press({ landedId: workspaceHost, rendererHandled: true }), state).kind,
      'exit-fullscreen',
    );
  });

  it('with no renderer fact present the policy table fires — the documented gap until the producer lands', () => {
    const state = paletteOverHost();
    assert.strictEqual(interpretEscape(press({ landedId: palette }), state).kind, 'close-window');
  });
});

// ── D5: no target must not open the switcher over a fullscreen window ──────

describe('window-escape: D5 — no target defers to a fullscreen window instead of opening the switcher', () => {
  it('D5 — no key holder, no closable transient, one visible fullscreen window: nothing, not open-switcher', () => {
    const state = fold(
      [
        { type: 'FullscreenTransitionStarted', id: workspaceHost, entering: true, preBounds: null },
        { type: 'OsFocusLost', id: workspaceHost },
      ],
      loneHost(),
    );
    assert.strictEqual(state.key, null);
    assert.notStrictEqual(state.order.find((w) => w.id === workspaceHost)?.fsMode.name, 'normal');
    assert.strictEqual(resolveEscapeTarget(press({ landedId: 'global' }), state).kind, 'none');
    assert.deepStrictEqual(interpretEscape(press({ landedId: 'global' }), state), {
      kind: 'nothing',
      reason: 'fullscreen-no-target',
      command: null,
    });
  });

  it('D5 — same scene with no fullscreen window still opens the switcher', () => {
    const state = fold([{ type: 'OsFocusLost', id: workspaceHost }], loneHost());
    assert.strictEqual(state.key, null);
    assert.strictEqual(resolveEscapeTarget(press({ landedId: 'global' }), state).kind, 'none');
    assert.deepStrictEqual(interpretEscape(press({ landedId: 'global' }), state), {
      kind: 'open-switcher',
      command: null,
    });
  });
});

// ── The policy table, every live arm ───────────────────────────────────────

describe('window-escape: every live policy arm', () => {
  // The old three-value session collapsed to this one bit — `idle` and
  // `active` took the same branch in both tables, so the pair below covers
  // exactly what the three values did.
  const bothWays = [false, true];

  it('the close phase: quick-view, palette and utility close either way', () => {
    for (const openedInBackground of bothWays) {
      for (const role of ['quick-view', 'palette', 'utility']) {
        assert.strictEqual(escapeClosePolicy(openedInBackground, role), 'close', `${openedInBackground}/${role}`);
      }
    }
  });

  it('the close phase: workspace never closes, even when Peek came up in the background', () => {
    for (const openedInBackground of bothWays) {
      assert.strictEqual(escapeClosePolicy(openedInBackground, 'workspace'), 'nothing', String(openedInBackground));
    }
  });

  it('the close phase: coming up in the background closes anything else, including a roleless window', () => {
    assert.strictEqual(escapeClosePolicy(true, 'content'), 'close');
    assert.strictEqual(escapeClosePolicy(true, 'child-content'), 'close');
    assert.strictEqual(escapeClosePolicy(true, undefined), 'close');
    assert.strictEqual(escapeClosePolicy(false, 'content'), 'nothing');
    assert.strictEqual(escapeClosePolicy(false, undefined), 'nothing');
  });

  it('the fallback phase: content roles open the switcher unless Peek came up in the background', () => {
    for (const role of ['workspace', 'content', 'child-content']) {
      assert.strictEqual(escapeFallbackPolicy(false, role), 'open-switcher', role);
      assert.strictEqual(escapeFallbackPolicy(true, role), 'nothing', role);
    }
  });

  it('the fallback phase: everything else does nothing', () => {
    for (const openedInBackground of bothWays) {
      for (const role of ['palette', 'quick-view', 'utility', 'overlay', undefined]) {
        assert.strictEqual(escapeFallbackPolicy(openedInBackground, role), 'nothing', `${openedInBackground}/${role}`);
      }
    }
  });

  it('a content host the user opened in Peek falls through to the switcher', () => {
    const state = loneHost();
    assert.strictEqual(state.openedInBackground, false, 'the app was active when it opened');
    assert.deepStrictEqual(interpretEscape(press({ landedId: workspaceHost }), state), {
      kind: 'open-switcher',
      command: null,
    });
  });

  it('a content host that came up over another app closes instead', () => {
    const state = loneHostFromBackground();
    assert.strictEqual(state.openedInBackground, true, 'the app was not active when it opened');
    const outcome = interpretEscape(press({ landedId: workspaceHost }), state);
    assert.strictEqual(outcome.kind, 'close-window');
    assert.strictEqual(outcome.command?.id, workspaceHost);
  });

  it('the user arriving in Peek turns that close back into the switcher', () => {
    // The ratchet, end to end: same window, same keystroke, and the only
    // difference is that Peek became the app the user is in.
    const arrived = fold([{ type: 'AppActivated' }], loneHostFromBackground());
    assert.strictEqual(arrived.openedInBackground, false);
    assert.strictEqual(interpretEscape(press({ landedId: workspaceHost }), arrived).kind, 'open-switcher');
  });

  it('a quick-view closes either way', () => {
    for (const base of [loneHost(), loneHostFromBackground()]) {
      const state = fold([regQuickView(quickView), show(quickView), focus(quickView)], base);
      const outcome = interpretEscape(press({ landedId: quickView }), state);
      assert.strictEqual(outcome.kind, 'close-window', String(base.openedInBackground));
      assert.strictEqual(outcome.command?.id, quickView);
    }
  });

  it('a workspace-roled window that came up in the background produces nothing at all', () => {
    const state = fold(
      [
        { type: 'WindowRegistered', id: secondHost, kind: 'page-host', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'workspace' },
        show(secondHost),
        focus(secondHost),
      ],
      loneHostFromBackground(),
    );
    assert.deepStrictEqual(interpretEscape(press({ landedId: secondHost }), state), {
      kind: 'nothing',
      reason: 'policy-nothing',
      command: null,
    });
  });
});

// ── expectedVersion ────────────────────────────────────────────────────────

describe('window-escape: every command carries the snapshot version it was decided against', () => {
  it('the close command stamps the version read from the snapshot', () => {
    const before = paletteOverHost();
    const after = fold([regQuickView(quickView)], before);
    assert.notStrictEqual(before.version, after.version);
    assert.strictEqual(interpretEscape(press({ landedId: palette }), before).command?.expectedVersion, before.version);
    assert.strictEqual(interpretEscape(press({ landedId: palette }), after).command?.expectedVersion, after.version);
  });

  it('an outcome with no kernel command carries a null command', () => {
    const state = loneHost();
    assert.strictEqual(interpretEscape(press({ landedId: workspaceHost }), state).command, null);
  });
});

// ── The OS Escape grab ─────────────────────────────────────────────────────

describe('window-escape: the OS Escape grab derivation', () => {
  it('an inactive app never arms the grab', () => {
    const state = fold([{ type: 'AppResigned' }], loneHost());
    assert.strictEqual(shouldArmEscapeGrab(state), false);
    // Even with nobody holding key, which is otherwise the arming case.
    const blurred = fold([{ type: 'OsFocusLost', id: workspaceHost }], state);
    assert.strictEqual(shouldArmEscapeGrab(blurred), false);
  });

  it('an open switcher never arms the grab — it handles Escape in its own renderer', () => {
    const state = fold([regSwitcher(switcher), show(switcher), focus(switcher)], loneHost());
    assert.strictEqual(shouldArmEscapeGrab(state), false);
  });

  it('nobody holding key arms the grab — no window can receive before-input-event', () => {
    const state = fold([{ type: 'OsFocusLost', id: workspaceHost }], loneHost());
    assert.strictEqual(shouldArmEscapeGrab(state), true);
  });

  it('a dangling key id arms the grab too — it reads as nobody holding key', () => {
    const state = fold([{ type: 'WindowClosed', id: workspaceHost }], loneHost());
    assert.strictEqual(state.key, workspaceHost);
    assert.strictEqual(shouldArmEscapeGrab(state), true);
  });

  it('contentFocused === false arms the grab — the key holder is deaf to before-input-event', () => {
    const state = fold(
      [{ type: 'ContentFirstResponderChanged', id: workspaceHost, held: false }],
      loneHost(),
    );
    assert.strictEqual(state.order.find((w) => w.id === workspaceHost)?.contentFocused, false);
    assert.strictEqual(shouldArmEscapeGrab(state), true);
  });

  it('contentFocused === true does NOT arm the grab', () => {
    const state = fold(
      [{ type: 'ContentFirstResponderChanged', id: workspaceHost, held: true }],
      loneHost(),
    );
    assert.strictEqual(shouldArmEscapeGrab(state), false);
  });

  it('THREE-VALUED: an absent contentFocused is not an observed loss — no grab', () => {
    // A `browser` window never reports at all, and a page-host in the gap
    // between a driven focus and the async native event has not reported yet.
    // Reading absent as `false` would arm the grab permanently for the first
    // and flap it after every show for the second.
    const state = loneHost();
    assert.strictEqual(state.order.find((w) => w.id === workspaceHost)?.contentFocused, undefined);
    assert.strictEqual(shouldArmEscapeGrab(state), false);

    const withPalette = paletteOverHost();
    assert.strictEqual(withPalette.order.find((w) => w.id === palette)?.contentFocused, undefined);
    assert.strictEqual(shouldArmEscapeGrab(withPalette), false);
  });

  it('POLICY: a palette holding key does not arm the grab (see ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER)', () => {
    // Pinned so flipping the policy constant is a visible, deliberate change.
    // `windows.ts addEscHandler` attaches before-input-event to every
    // BrowserWindow, so the palette delivers its own Escape; an OS grab would
    // PRE-EMPT that and eat it.
    const state = paletteOverHost();
    assert.strictEqual(state.key, palette);
    assert.strictEqual(shouldArmEscapeGrab(state), false);
  });

  it('the grab reads the KEY holder, not the topmost content window', () => {
    // The host reported a lost first responder; the palette then took key and
    // has reported nothing. Reading the content window would arm the grab and
    // eat the palette's Escape.
    const state = fold(
      [{ type: 'ContentFirstResponderChanged', id: workspaceHost, held: false }, regPalette(palette), show(palette), focus(palette)],
      loneHost(),
    );
    assert.strictEqual(state.order.find((w) => w.id === workspaceHost)?.contentFocused, false);
    assert.strictEqual(shouldArmEscapeGrab(state), false);
  });

  it('REGRESSION (7fffa286/7c61e917): the grab stays correct across resign -> focus-lost -> activate -> refocus', () => {
    // Live-measured (2026-07): the OS reports the key holder's focus LOST
    // around the app resign, well before `AppActivated` — so this round trip
    // crosses two distinct off arms, not one. `AppResigned` alone covers the
    // grab with "not the active app"; the settling `OsFocusLost` nulls `key`
    // underneath that cover; `AppActivated` never restores `key` (RULE 2 —
    // only `OsFocusGained`/`OsFocusLost` write it), so activation uncovers
    // the "nobody holds key" arm instead of "app inactive" — this state, not
    // the resigned one, is the 7fffa286/7c61e917 hole. Only a fresh live
    // focus report closes it.
    const state = loneHost();
    assert.strictEqual(state.key, workspaceHost);

    const resigned = fold([{ type: 'AppResigned' }], state);
    assert.strictEqual(shouldArmEscapeGrab(resigned), false, 'not the active app');

    const settled = fold([{ type: 'OsFocusLost', id: workspaceHost }], resigned);
    assert.strictEqual(settled.key, null, 'the focus settle nulls key');
    assert.strictEqual(
      shouldArmEscapeGrab(settled),
      false,
      'still not the active app -- that arm dominates the now-null key',
    );

    const activated = fold([{ type: 'AppActivated' }], settled);
    assert.strictEqual(activated.key, null, 'AppActivated never restores key (RULE 2)');
    assert.strictEqual(
      shouldArmEscapeGrab(activated),
      true,
      'back active with nobody holding key -- the safety net is ON (the 7fffa286/7c61e917 hole)',
    );

    const refocused = fold([{ type: 'OsFocusGained', id: workspaceHost }], activated);
    assert.strictEqual(refocused.key, workspaceHost);
    assert.strictEqual(shouldArmEscapeGrab(refocused), false, 'live refocus report lands -- the net drops');
  });
});
