/**
 * Unit tests for the pure window-state reducer (`window-state.ts`).
 *
 * Blueprint: `docs/design/window-manager.md` (the Window Manager mandate).
 * Three layers:
 *   1. Totality matrix — every state-class (fsMode x switcher x satellite x
 *      escapeMode x role) x every event returns a DEFINED transition, and the
 *      front invariant holds after every one.
 *   2. Historical-bug replays — each past bug encoded as a literal event script
 *      asserted on the pure reducer (§5.2 (a)-(f)).
 *   3. Ported regression assertions — the predicates the reducer now OWNS,
 *      translated from `izui-roles.test.ts`, `focused-window-tracking.test.ts`,
 *      and `hybrid-page-host-registry.test.ts` into reducer event-scripts.
 *
 * DELIBERATE DIVERGENCES from the ported originals (design decisions, flagged):
 *   - `decideEscape(state)` takes only `state` per the doc, but step 6 needs the
 *     session tri-state for the ported `escPolicy`/`escUnhandledPolicy`. The doc's
 *     §2.2 `AppWindowState` shape does not list a session field; §2.1/§3 say the
 *     coordinator's idle/transient/active is mirrored ("setAppFocused mirroring
 *     appActive"). To keep the reducer pure + self-contained we mirror the
 *     session tri-state INTO `AppWindowState.session`. See `window-state.ts`.
 *   - The old registry `decideAfterBlur` deactivated the active hybrid to `null`
 *     when focus left the whole group. The new design's `OS_FOCUS_SETTLED_NULL`
 *     INTENTIONALLY keeps `front` (design §2.4, fixing divergence #2 — S2 briefly
 *     null while a host is visibly front). So that one ported assertion is
 *     inverted here, on purpose (see the test named for it).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  reduce,
  decideEscape,
  decideEscapeUnhandled,
  escPolicy,
  escUnhandledPolicy,
  createInitialState,
  getFrontWindowId,
  getWindowMode,
  getWindowPreBounds,
  getDevtoolsTargetId,
  getOverlayHost,
  overlayIdForHost,
  selectTransientAutoclose,
  selectAppResignTransients,
  snapshot,
  frontInvariantHolds,
  stackOrderInvariantHolds,
  getStackOrder,
  deriveStackingLevel,
  isEligibleFront,
  isSatelliteRegistration,
  classifyWindowRegistration,
  decideWindowRegistration,
  deriveEscGrabRegistered,
  WindowStateOwner,
  type AppWindowState,
  type WindowRecord,
  type WindowEvent,
  type Effect,
  type StateSnapshot,
  type FsMode,
  type IzuiSession,
  type Rectangle,
  type WindowId,
} from './window-state.js';

// ── Test builders ────────────────────────────────────────────────────────────

/**
 * Craft a WM WindowId for tests. Mirrors the adapter's mint format ("wm-N");
 * the pure reducer never checks the shape, only identity — this exists so the
 * tests can keep speaking small numbers while the type stays branded.
 */
const wid = (n: number): WindowId => `wm-${n}` as WindowId;

const ROLES = ['palette', 'quick-view', 'overlay', 'workspace', 'content', 'child-content', 'utility'] as const;
const FS_NAMES: FsMode['name'][] = ['normal', 'entering-fullscreen', 'fullscreen', 'leaving-fullscreen'];
const ESC_MODES: (WindowRecord['escapeMode'])[] = [undefined, 'auto', 'close', 'navigate', 'ignore'];
const SESSIONS: IzuiSession[] = ['idle', 'transient', 'active'];

const BOUNDS: Rectangle = { x: 10, y: 20, width: 800, height: 600 };

function fsOf(name: FsMode['name'], preBounds: Rectangle | null = null): FsMode {
  switch (name) {
    case 'normal':
      return { name: 'normal' };
    case 'entering-fullscreen':
      return { name: 'entering-fullscreen', preBounds };
    case 'fullscreen':
      return { name: 'fullscreen', preBounds };
    case 'leaving-fullscreen':
      return { name: 'leaving-fullscreen', preBounds };
  }
}

/** Fold a script of events; assert the front invariant after EACH step. */
function drive(start: AppWindowState, events: WindowEvent[]): { state: AppWindowState; effects: Effect[] } {
  let state = start;
  let effects: Effect[] = [];
  for (const ev of events) {
    const r = reduce(state, ev);
    state = r.state;
    effects = r.effects;
    assert.ok(
      frontInvariantHolds(state),
      `front invariant violated after ${ev.type}: front=${state.front}`,
    );
    assert.ok(
      stackOrderInvariantHolds(state),
      `stackOrder invariant violated after ${ev.type}: [${state.stackOrder.join(', ')}]`,
    );
  }
  return { state, effects };
}

function hasEffect(effects: Effect[], type: Effect['type']): boolean {
  return effects.some((e) => e.type === type);
}

// A minimal registered+shown+focused window, via events.
function openWindow(
  state: AppWindowState,
  id: number,
  opts: { kind?: WindowRecord['kind']; role?: string; satellite?: boolean; escapeMode?: WindowRecord['escapeMode']; focused?: boolean } = {},
): AppWindowState {
  const { state: s1 } = drive(state, [
    { type: 'WINDOW_REGISTERED', id: wid(id), kind: opts.kind ?? 'page-host', role: opts.role ?? 'content', satellite: opts.satellite ?? false, escapeMode: opts.escapeMode },
    { type: 'WINDOW_SHOWN', id: wid(id), focused: opts.focused ?? true },
  ]);
  return s1;
}

// ── 1. Totality matrix ───────────────────────────────────────────────────────

describe('totality matrix — every (state-class x event) returns a defined transition', () => {
  // Build one representative state per (fsMode x switcher x satellite x escapeMode x role).
  function buildStateClass(
    fsName: FsMode['name'],
    switcherOpen: boolean,
    satellite: boolean,
    escapeMode: WindowRecord['escapeMode'],
    role: string,
    session: IzuiSession,
  ): AppWindowState {
    const rec: WindowRecord = {
      id: wid(1),
      kind: 'page-host',
      role,
      class: 'primary',
      stackingLevel: satellite ? 'excluded' : 'stacked',
      orderable: true,
      escapeMode,
      satellite,
      visible: true,
      fsMode: fsOf(fsName, fsName === 'normal' ? null : BOUNDS),
      maximized: false,
      preMaxBounds: null,
      visibleOnAllSpaces: false,
      pendingProjectedBounds: null,
      focusSeq: 1,
    };
    const windows = new Map<WindowId, WindowRecord>([[wid(1), rec]]);
    // A satellite can never be front (invariant); otherwise the window is front.
    const front = satellite ? null : wid(1);
    const state: AppWindowState = {
      appActive: true,
      session,
      front,
      // Unasserted, so the closing assertion step is exercised across the whole
      // matrix (it must stay total and invariant-preserving when it fires).
      frontAsserted: false,
      stackOrder: satellite ? [] : [wid(1)],
      switcher: switcherOpen ? { open: true, windowId: wid(2), previousFront: front } : { open: false },
      windows,
      focusSeqCounter: 1,
      escAsk: null,
      escSeq: 0,
      pendingAppResignSweep: false,
    };
    assert.ok(frontInvariantHolds(state), 'built state class must satisfy the invariant');
    return state;
  }

  const events: WindowEvent[] = [
    { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'browser', role: 'content', satellite: false },
    { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    { type: 'WINDOW_SHOWN', id: wid(1), focused: false },
    { type: 'WINDOW_HIDDEN', id: wid(1) },
    { type: 'WINDOW_CLOSED', id: wid(1) },
    { type: 'OS_FOCUS_GAINED', id: wid(1) },
    { type: 'OS_FOCUS_SETTLED_NULL' },
    { type: 'APP_ACTIVATED' },
    { type: 'APP_RESIGNED' },
    { type: 'SESSION_CHANGED', session: 'active' },
    { type: 'FULLSCREEN_REQUESTED', id: wid(1) },
    { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: BOUNDS },
    { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
    { type: 'FULLSCREEN_REQUESTED' }, // id defaults to front
    { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    { type: 'OS_FULLSCREEN_LEFT', id: wid(1) },
    { type: 'FULLSCREEN_SETTLE_TIMEOUT', id: wid(1) },
    { type: 'ESC_PRESSED', landedId: wid(1) },
    { type: 'ESC_PRESSED', landedId: 'global' },
    { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: true, seq: 1 },
    { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: false, seq: 1 },
    { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: false, close: true, seq: 1 },
    { type: 'SWITCHER_OPEN_REQUESTED' },
    { type: 'SWITCHER_SELECTED', id: wid(1) },
    { type: 'SWITCHER_SELECTED', id: null },
    { type: 'SWITCHER_OPENED', windowId: wid(2) },
    { type: 'OS_FOCUS_GAINED', id: wid(1), lastHttpUrl: 'https://example.com/' },
    // §5 step 4 events (classes + registry unification).
    { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'utility', class: 'hud', satellite: true, alwaysOnTop: true },
    { type: 'WINDOW_PARAMS_SET', id: wid(1), source: 'peek://app/x', params: { key: 'k' } },
    { type: 'WINDOW_PARAMS_SET', id: wid(99), source: 'peek://app/x', params: {} },
    { type: 'WINDOW_CLOSE_REQUESTED', id: wid(1) },
    { type: 'WINDOW_CLOSE_REQUESTED', id: wid(99) },
    { type: 'WINDOW_DESTROY_REQUESTED', id: wid(1) },
    { type: 'WINDOW_SHOW_REQUESTED', id: wid(1), activate: false },
    { type: 'WINDOW_SHOW_REQUESTED', id: wid(1), activate: true },
    // §5 step 6A-4: the plain hide intent (tile:window:hide / hide-self / modWindow).
    { type: 'WINDOW_HIDE_REQUESTED', id: wid(1) },
    { type: 'WINDOW_HIDE_REQUESTED', id: wid(99) },
    { type: 'WINDOW_CONTENT_CLOSE_REQUESTED', id: wid(1) },
    { type: 'GUEST_TEARDOWN_REQUESTED' },
    { type: 'DEVTOOLS_OPENED', id: wid(1) },
    { type: 'DEVTOOLS_CLOSED', id: wid(1) },
    // §5 step 5 event (z-order / stacking): the page-host orderability caveat.
    { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(1) },
    { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(99) },
    // §5 step 5 part B: the session-restore order import.
    { type: 'STACK_ORDER_IMPORTED', order: [wid(1)] },
    { type: 'STACK_ORDER_IMPORTED', order: [] },
    { type: 'STACK_ORDER_IMPORTED', order: [wid(99), wid(1), wid(1)] },
    // §5 step 7A events (geometry / bounds / maximize).
    { type: 'BOUNDS_CHANGED', id: wid(1), bounds: BOUNDS },
    { type: 'BOUNDS_CHANGED', id: wid(99), bounds: BOUNDS },
    { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: BOUNDS },
    { type: 'MAXIMIZE_REQUESTED', id: wid(99), workArea: BOUNDS },
    { type: 'UNMAXIMIZE_REQUESTED', id: wid(1) },
    { type: 'UNMAXIMIZE_REQUESTED', id: wid(99) },
    // §5 step 7B events (maximize cutover: registration bounds seed,
    // construction-time restore, resize-gesture exit).
    { type: 'WINDOW_REGISTERED', id: wid(5), kind: 'page-host', role: 'content', satellite: false, bounds: BOUNDS },
    { type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: BOUNDS },
    { type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: null },
    { type: 'MAXIMIZE_RESTORED', id: wid(99), preMaxBounds: BOUNDS },
    { type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) },
    { type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(99) },
    // §5 step 7E event (the plain geometry-write intent).
    { type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: BOUNDS },
    { type: 'SET_BOUNDS_REQUESTED', id: wid(99), bounds: BOUNDS },
    // §5 step 10 events (displays + Spaces).
    { type: 'DISPLAY_CHANGED', projected: [] },
    { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: BOUNDS }] },
    { type: 'DISPLAY_CHANGED', projected: [{ id: wid(99), bounds: BOUNDS }, { id: wid(1), bounds: BOUNDS }] },
    { type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true },
    { type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: false },
    { type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(99), on: true },
    // §5 step 9 events (overlay attachment + the app-resign transient sweep).
    { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(1), hostId: wid(1) },
    { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(1), hostId: wid(1), frame: BOUNDS },
    { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(1), hostId: null },
    { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(1), hostId: wid(99) },
    { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(99), hostId: wid(1) },
    { type: 'BOUNDS_CHANGED', id: wid(1), bounds: BOUNDS, overlayFrame: BOUNDS },
    { type: 'APP_RESIGN_SETTLED' },
  ];

  it('reduce is total: defined result + front invariant holds for all combinations', () => {
    let combinations = 0;
    const failures: string[] = [];
    for (const fsName of FS_NAMES) {
      for (const switcherOpen of [false, true]) {
        for (const satellite of [false, true]) {
          for (const escapeMode of ESC_MODES) {
            for (const role of ROLES) {
              // Session varies only lightly to keep the matrix bounded; ESC step 6
              // gets its own dedicated session sweep below.
              const state = buildStateClass(fsName, switcherOpen, satellite, escapeMode, role, 'active');
              for (const ev of events) {
                combinations++;
                let result;
                try {
                  result = reduce(state, ev);
                } catch (err) {
                  failures.push(`${fsName}/${switcherOpen}/${satellite}/${escapeMode}/${role} x ${ev.type}: threw ${String(err)}`);
                  continue;
                }
                if (!result || !result.state) {
                  failures.push(`${fsName}/.../${role} x ${ev.type}: undefined result`);
                  continue;
                }
                if (!Array.isArray(result.effects)) {
                  failures.push(`${fsName}/.../${role} x ${ev.type}: effects not an array`);
                }
                if (!frontInvariantHolds(result.state)) {
                  failures.push(`${fsName}/${switcherOpen}/${satellite}/${escapeMode}/${role} x ${ev.type}: front invariant violated (front=${result.state.front})`);
                }
                if (!stackOrderInvariantHolds(result.state)) {
                  failures.push(`${fsName}/${switcherOpen}/${satellite}/${escapeMode}/${role} x ${ev.type}: stackOrder invariant violated ([${result.state.stackOrder.join(', ')}])`);
                }
              }
            }
          }
        }
      }
    }
    assert.deepStrictEqual(failures, [], `totality failures:\n${failures.join('\n')}`);
    assert.ok(combinations >= 4 * 2 * 2 * 5 * 7 * events.length, `expected the full sweep, ran ${combinations}`);
  });

  it('ESC step-6 session sweep: decideEscapeUnhandled is total over (session x role x escapeMode)', () => {
    const failures: string[] = [];
    for (const session of SESSIONS) {
      for (const role of ROLES) {
        for (const escapeMode of ESC_MODES) {
          const state = buildStateClass('normal', false, false, escapeMode, role, session);
          const decision = decideEscapeUnhandled(state, wid(1));
          if (!['close-window', 'open-switcher', 'nothing'].includes(decision.kind)) {
            failures.push(`${session}/${role}/${escapeMode}: undefined unhandled decision ${JSON.stringify(decision)}`);
          }
        }
      }
    }
    assert.deepStrictEqual(failures, []);
  });
});

// ── decideEscape as a total function (steps 1-5) ─────────────────────────────

describe('decideEscape (steps 1-5, total)', () => {
  it('step 1: switcher open -> close-switcher (regardless of front/fullscreen)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { role: 'content' });
    const { state } = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]);
    assert.deepStrictEqual(decideEscape(state), { kind: 'close-switcher' });
  });

  it('step 2: front == null -> open-switcher', () => {
    assert.deepStrictEqual(decideEscape(createInitialState()), { kind: 'open-switcher' });
  });

  it('step 3: escapeMode ignore -> pass-through (BEFORE fullscreen exit)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { role: 'content', escapeMode: 'ignore' });
    const { state } = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]);
    // Even fullscreen, ignore wins (mirrors escExitsHybridFullscreen ignore rule).
    assert.deepStrictEqual(decideEscape(state), { kind: 'pass-through', id: wid(1) });
  });

  it('step 4: any non-normal fsMode -> exit-fullscreen (entering/full/leaving)', () => {
    for (const name of ['entering-fullscreen', 'fullscreen', 'leaving-fullscreen'] as FsMode['name'][]) {
      const rec: WindowRecord = { id: wid(1), kind: 'page-host', role: 'content', class: 'primary', stackingLevel: 'stacked', orderable: true, satellite: false, visible: true, fsMode: fsOf(name, BOUNDS), maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 1 };
      const state: AppWindowState = { appActive: true, session: 'active', front: wid(1), frontAsserted: true, stackOrder: [wid(1)], switcher: { open: false }, windows: new Map([[wid(1), rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0, pendingAppResignSweep: false };
      assert.deepStrictEqual(decideEscape(state), { kind: 'exit-fullscreen', id: wid(1) }, `mode ${name}`);
    }
  });

  it('step 5: normal, non-ignore -> ask-renderer(front)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { role: 'content' });
    assert.deepStrictEqual(decideEscape(s), { kind: 'ask-renderer', id: wid(1) });
  });
});

// ── escPolicy / escUnhandledPolicy — verbatim decision tables ────────────────

describe('escPolicy (ported verbatim from izui-state.ts)', () => {
  it('always-close roles regardless of session', () => {
    for (const session of ['idle', 'transient', 'active', 'overlay']) {
      assert.strictEqual(escPolicy(session, 'quick-view'), 'close');
      assert.strictEqual(escPolicy(session, 'palette'), 'close');
      assert.strictEqual(escPolicy(session, 'utility'), 'close');
    }
  });
  it('overlay -> close-and-restore; workspace -> nothing', () => {
    assert.strictEqual(escPolicy('active', 'overlay'), 'close-and-restore');
    assert.strictEqual(escPolicy('transient', 'workspace'), 'nothing');
    assert.strictEqual(escPolicy('active', 'workspace'), 'nothing');
  });
  it('content/child-content close only in a transient session', () => {
    assert.strictEqual(escPolicy('transient', 'content'), 'close');
    assert.strictEqual(escPolicy('transient', 'child-content'), 'close');
    assert.strictEqual(escPolicy('active', 'content'), 'nothing');
    assert.strictEqual(escPolicy('idle', 'content'), 'nothing');
    assert.strictEqual(escPolicy('overlay', 'content'), 'nothing');
  });
});

describe('escUnhandledPolicy (ported verbatim from izui-state.ts)', () => {
  it('transient/overlay sessions never open the switcher', () => {
    assert.strictEqual(escUnhandledPolicy('transient', 'content'), 'nothing');
    assert.strictEqual(escUnhandledPolicy('overlay', 'workspace'), 'nothing');
  });
  it('active/idle open the switcher for workspace/content/child-content', () => {
    for (const session of ['active', 'idle']) {
      assert.strictEqual(escUnhandledPolicy(session, 'workspace'), 'open-switcher');
      assert.strictEqual(escUnhandledPolicy(session, 'content'), 'open-switcher');
      assert.strictEqual(escUnhandledPolicy(session, 'child-content'), 'open-switcher');
    }
  });
  it('other roles never open the switcher', () => {
    assert.strictEqual(escUnhandledPolicy('active', 'quick-view'), 'nothing');
    assert.strictEqual(escUnhandledPolicy('active', 'palette'), 'nothing');
  });
});

// ── 2. Historical-bug replays (§5.2 a-f) ─────────────────────────────────────

describe('historical-bug replays (§5.2)', () => {
  it('(a) Space-switch settings clobber: transition-pin keeps front on the fullscreening host', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' }); // front = 1
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'workspace', satellite: false }, { type: 'WINDOW_SHOWN', id: wid(2), focused: false }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1), 'host is front after a non-focused settings window shows');

    // Begin fullscreen on the host; a Space-switch focus lands on settings mid-animation.
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FOCUS_GAINED', id: wid(2) }, // Space-switch churn while host is entering-fullscreen
    ]).state;
    assert.strictEqual(getWindowMode(s, wid(1)), 'entering-fullscreen');
    assert.strictEqual(getFrontWindowId(s), wid(1), 'transition pin: settings focus during enter must NOT clobber front');

    s = drive(s, [{ type: 'OS_FULLSCREEN_ENTERED', id: wid(1) }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1), 'front stays the fullscreen host, never the settings window');
    assert.strictEqual(getWindowMode(s, wid(1)), 'fullscreen');
  });

  it('(b) S2-null focus lag: OS_FOCUS_SETTLED_NULL keeps front (the target survives an app switch)', () => {
    let s = createInitialState();
    s = openWindow(s, 7, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), wid(7));
    s = drive(s, [{ type: 'OS_FOCUS_SETTLED_NULL' }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(7), 'front must NOT go null just because OS focus left all windows');
  });

  it('(c) grab-alive-during-fullscreen: ESC_PRESSED(global) yields EXIT_FULLSCREEN, never OPEN_SWITCHER', () => {
    let s = createInitialState();
    s = openWindow(s, 7, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(7), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(7) },
    ]).state;
    assert.strictEqual(getWindowMode(s, wid(7)), 'fullscreen');

    // The stale OS grab dispatches the SAME ESC event as before-input-event.
    assert.deepStrictEqual(decideEscape(s), { kind: 'exit-fullscreen', id: wid(7) });
    const { effects } = drive(s, [{ type: 'ESC_PRESSED', landedId: 'global' }]);
    assert.ok(hasEffect(effects, 'EXIT_FULLSCREEN'), 'global ESC over a fullscreen host must exit fullscreen');
    assert.ok(!hasEffect(effects, 'OPEN_SWITCHER_WINDOW'), 'must NOT open the switcher over a fullscreen window');
  });

  it('(d) switcher-over-fullscreen: step 4 precedes the switcher in the landed-ESC path too', () => {
    let s = createInitialState();
    s = openWindow(s, 3, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(3), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(3) },
    ]).state;
    const first = drive(s, [{ type: 'ESC_PRESSED', landedId: wid(3) }]);
    assert.ok(hasEffect(first.effects, 'EXIT_FULLSCREEN'));
    assert.ok(!hasEffect(first.effects, 'ASK_RENDERER'), 'no renderer ask while fullscreen');
    assert.ok(!hasEffect(first.effects, 'OPEN_SWITCHER_WINDOW'));

    // Only once fullscreen is actually left does ESC reach the renderer/policy.
    const left = drive(first.state, [{ type: 'OS_FULLSCREEN_LEFT', id: wid(3) }]);
    assert.strictEqual(getWindowMode(left.state, wid(3)), 'normal');
    assert.deepStrictEqual(decideEscape(left.state), { kind: 'ask-renderer', id: wid(3) });
  });

  it('(e) palette-issuer exclusion: a satellite palette focus never clobbers the front page', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' }); // front = 1
    // The command palette opens and takes OS focus — declared satellite.
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
      { type: 'OS_FOCUS_GAINED', id: wid(2) },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1), 'the palette (command issuer) must never become the command target');
  });

  it('(f) OS/green-button fullscreen on a settings window: preBounds legitimately null, NOT "missing"', () => {
    let s = createInitialState();
    s = openWindow(s, 5, { kind: 'browser', role: 'workspace' });
    // Green-button / OS-initiated fullscreen: settle event with no prior request.
    s = drive(s, [{ type: 'OS_FULLSCREEN_ENTERED', id: wid(5) }]).state;
    const snap = snapshot(s);
    const rec = snap.windows.find((w) => w.id === wid(5))!;
    assert.strictEqual(rec.fsMode.name, 'fullscreen');
    assert.strictEqual((rec.fsMode as { preBounds: Rectangle | null }).preBounds, null, 'OS-initiated entry has a legitimately-null stash');
    // It IS fullscreen for every purpose: ESC exits it (not treated as missing/normal).
    assert.deepStrictEqual(decideEscape(s), { kind: 'exit-fullscreen', id: wid(5) });
    // And the settled leave returns it to normal.
    s = drive(s, [{ type: 'OS_FULLSCREEN_LEFT', id: wid(5) }]).state;
    assert.strictEqual(getWindowMode(s, wid(5)), 'normal');
  });
});

// ── 3a. Ported from izui-roles.test.ts (assertions the reducer now owns) ─────

describe('ported: resolveHybridEscapeTarget -> ESC target is always `front`', () => {
  // The redirect the old resolver did (landed on host 11, active quick-view 22)
  // is now structural: focusing the quick-view makes IT front, and ESC targets
  // front regardless of the landed id.
  it('ESC targets the front quick-view, not the landed content host', () => {
    let s = createInitialState();
    s = openWindow(s, 11, { kind: 'page-host', role: 'content' });          // front 11
    s = openWindow(s, 22, { kind: 'page-host', role: 'quick-view' });       // front -> 22
    assert.strictEqual(getFrontWindowId(s), wid(22));
    // ESC lands (as first-responder noise) on 11; decision uses front 22.
    assert.deepStrictEqual(decideEscape(s), { kind: 'ask-renderer', id: wid(22) });
    // Renderer declines -> quick-view always closes.
    assert.deepStrictEqual(decideEscapeUnhandled(s, wid(22)), { kind: 'close-window', id: wid(22) });
  });
});

describe('ported: escExitsHybridFullscreen -> decideEscape step 4 vs escapeMode ignore', () => {
  function fullscreenFront(escapeMode: WindowRecord['escapeMode']): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content', escapeMode });
    return drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]).state;
  }
  it('fullscreen + non-ignore -> exit-fullscreen', () => {
    assert.deepStrictEqual(decideEscape(fullscreenFront(undefined)), { kind: 'exit-fullscreen', id: wid(1) });
    assert.deepStrictEqual(decideEscape(fullscreenFront('auto')), { kind: 'exit-fullscreen', id: wid(1) });
    assert.deepStrictEqual(decideEscape(fullscreenFront('close')), { kind: 'exit-fullscreen', id: wid(1) });
  });
  it("escapeMode 'ignore' keeps winning even in fullscreen -> pass-through", () => {
    assert.deepStrictEqual(decideEscape(fullscreenFront('ignore')), { kind: 'pass-through', id: wid(1) });
  });
});

describe('ported: shouldRegisterGlobalEscFallback -> ESC with no front opens the switcher', () => {
  it('front == null -> open-switcher (the genuine global-fallback case)', () => {
    assert.deepStrictEqual(decideEscape(createInitialState()), { kind: 'open-switcher' });
  });
  it('a focused hybrid host is front -> ESC does NOT open the switcher (it asks the renderer)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const { effects } = drive(s, [{ type: 'ESC_PRESSED', landedId: 'global' }]);
    assert.ok(hasEffect(effects, 'ASK_RENDERER'));
    assert.ok(!hasEffect(effects, 'OPEN_SWITCHER_WINDOW'), 'a focused host must not fall through to the grab/switcher');
  });
});

describe('ported: resolveCloseTargetId / resolveFocusedVisibleWindowId -> `front`', () => {
  it('overlay (satellite) focus leaves the close/command target on the host (cmd+W redirect)', () => {
    let s = createInitialState();
    s = openWindow(s, 3, { kind: 'page-host', role: 'content' });  // host front
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(7), kind: 'browser', role: 'overlay', satellite: true }, // shared chrome overlay
      { type: 'WINDOW_SHOWN', id: wid(7), focused: true },
      { type: 'OS_FOCUS_GAINED', id: wid(7) },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), wid(3), 'the chrome overlay is not the window the user means to act on');
  });

  it('a focused page-host wins as the command target (the tag-the-wrong-page bug)', () => {
    let s = createInitialState();
    s = openWindow(s, 9, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), wid(9));
  });

  it('a modal palette (satellite) is excluded as a target', () => {
    let s = createInitialState();
    s = openWindow(s, 9, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), wid(9), 'the palette is the command issuer, never the target');
  });
});

// ── 3b. Ported from focused-window-tracking.test.ts ──────────────────────────

describe('ported: focused-window tracking -> front arbitration', () => {
  it('a normal visible focused window becomes front', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), wid(1));
  });

  it('a background / non-focusable / overlay surface (satellite) does NOT become front', () => {
    for (const role of ['workspace', 'overlay']) {
      let s = createInitialState();
      s = drive(s, [
        { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role, satellite: true },
        { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
        { type: 'OS_FOCUS_GAINED', id: wid(1) },
      ]).state;
      assert.strictEqual(getFrontWindowId(s), null, `satellite role ${role} must not be front`);
    }
  });

  it('updates to the most recently focused window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), wid(2));
  });

  it('closing the front window clears the stale id and picks the MRU successor', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // front 2, 1 still visible
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(2) }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1), 'successor is the remaining visible window');
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(1) }]).state;
    assert.strictEqual(getFrontWindowId(s), null, 'no stale id remains');
  });

  it('closing a non-front window does not disturb front', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // front 2
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(1) }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(2));
  });
});

// ── 3c. Ported from hybrid-page-host-registry.test.ts ────────────────────────

describe('ported: active-hybrid-window tracking -> front', () => {
  it('a real switch to another hybrid retargets front to it', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), wid(2));
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1));
  });

  it('focus landing on the overlay (satellite) keeps the content window as front', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(9), kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(9), focused: true },
      { type: 'OS_FOCUS_GAINED', id: wid(9) },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1));
  });

  it('closing the front hybrid nulls front (no successor)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(1) }]).state;
    assert.strictEqual(getFrontWindowId(s), null);
  });

  it('DELIBERATE DIVERGENCE: focus leaving the whole group keeps front (old decideAfterBlur nulled it)', () => {
    // Old registry behavior: focus leaving all hybrids + overlay deactivated the
    // active id to null. New design (§2.4): OS_FOCUS_SETTLED_NULL keeps front so
    // the target survives an app switch. This inverts the old assertion on purpose.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'OS_FOCUS_SETTLED_NULL' }]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1), 'front is corrected only by hide/close/next-focus, not by a null focus settle');
  });
});

describe('ported: pre-fullscreen bounds stash (aa34cb50 lookalike trap)', () => {
  function preBoundsOf(s: AppWindowState, id: number): Rectangle | null | 'no-field' {
    const rec = snapshot(s).windows.find((w) => w.id === wid(id))!;
    if (rec.fsMode.name === 'normal') return 'no-field';
    return (rec.fsMode as { preBounds: Rectangle | null }).preBounds;
  }

  it('registers with no stash (normal has no preBounds field at all)', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getWindowMode(s, wid(1)), 'normal');
    assert.strictEqual(preBoundsOf(s, 1), 'no-field');
  });

  it('enter-initiation stashes the PRE-fullscreen bounds (captured by the adapter, carried on the event)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state;
    assert.strictEqual(getWindowMode(s, wid(1)), 'entering-fullscreen');
    assert.deepStrictEqual(preBoundsOf(s, 1), BOUNDS);
  });

  it('the stash survives the settled ENTER', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]).state;
    assert.strictEqual(getWindowMode(s, wid(1)), 'fullscreen');
    assert.deepStrictEqual(preBoundsOf(s, 1), BOUNDS);
  });

  it('the settled LEAVE clears the stash (back to normal, live bounds authoritative)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: wid(1) },
    ]).state;
    assert.strictEqual(getWindowMode(s, wid(1)), 'normal');
    assert.strictEqual(preBoundsOf(s, 1), 'no-field');
  });
});

// ── Fullscreen transition table (§2.4) — mode x event edges ──────────────────

describe('fullscreen transition table (§2.4)', () => {
  const base = () => openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });

  it('normal + REQUEST(true) -> entering + SET_FULLSCREEN(true)', () => {
    const { state, effects } = reduce(base(), { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: BOUNDS });
    assert.strictEqual(getWindowMode(state, wid(1)), 'entering-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === true));
  });

  it('normal + toggle (no desired) -> entering', () => {
    const { state } = reduce(base(), { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS });
    assert.strictEqual(getWindowMode(state, wid(1)), 'entering-fullscreen');
  });

  it('entering + REQUEST coalesces pendingDesire (no second SET_FULLSCREEN)', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state;
    const { state, effects } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false });
    assert.strictEqual(getWindowMode(state, wid(1)), 'entering-fullscreen');
    assert.ok(!effects.some((e) => e.type === 'SET_FULLSCREEN'), 'no mid-animation second setFullScreen');
  });

  it('entering + OS_ENTERED with pendingDesire:false immediately begins leaving', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false }, // coalesced cancel
    ]).state;
    const { state, effects } = reduce(s, { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) });
    assert.strictEqual(getWindowMode(state, wid(1)), 'leaving-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === false));
  });

  it('entering + OS_LEFT -> normal (aborted by OS)', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state;
    const { state } = reduce(s, { type: 'OS_FULLSCREEN_LEFT', id: wid(1) });
    assert.strictEqual(getWindowMode(state, wid(1)), 'normal');
  });

  it('fullscreen + REQUEST(false) -> leaving + SET_FULLSCREEN(false)', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]).state;
    const { state, effects } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false });
    assert.strictEqual(getWindowMode(state, wid(1)), 'leaving-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === false));
  });

  it('leaving + OS_LEFT with pendingDesire:true re-enters', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false }, // leaving
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true },  // coalesced re-enter
    ]).state;
    const { state, effects } = reduce(s, { type: 'OS_FULLSCREEN_LEFT', id: wid(1) });
    assert.strictEqual(getWindowMode(state, wid(1)), 'entering-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === true));
  });

  it('settle timeout while transitioning -> RECONCILE_FULLSCREEN', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state;
    const { effects } = reduce(s, { type: 'FULLSCREEN_SETTLE_TIMEOUT', id: wid(1) });
    assert.ok(effects.some((e) => e.type === 'RECONCILE_FULLSCREEN' && e.id === wid(1)));
  });

  it('FULLSCREEN_REQUESTED makes the target the front window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2
    const { state } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS });
    assert.strictEqual(getFrontWindowId(state), wid(1));
  });
});

// ── Switcher lifecycle (§2.4) ────────────────────────────────────────────────

describe('switcher lifecycle', () => {
  it('open request records previousFront and emits OPEN_SWITCHER_WINDOW', () => {
    let s = openWindow(createInitialState(), 5, { kind: 'page-host', role: 'content' });
    const { state, effects } = reduce(s, { type: 'SWITCHER_OPEN_REQUESTED' });
    assert.strictEqual(state.switcher.open, true);
    assert.ok(effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('SWITCHER_SELECTED(id) closes the switcher and raises the selection', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]).state;
    const { state, effects } = reduce(s, { type: 'SWITCHER_SELECTED', id: wid(1) });
    assert.strictEqual(state.switcher.open, false);
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)));
  });

  it('SWITCHER_SELECTED(null) restores previousFront', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]).state;
    const { state } = reduce(s, { type: 'SWITCHER_SELECTED', id: null });
    assert.strictEqual(getFrontWindowId(state), wid(4));
  });

  it('ESC while switcher open closes it (step 1) and does not exit any fullscreen', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]).state;
    const { state, effects } = reduce(s, { type: 'ESC_PRESSED', landedId: 'global' });
    assert.strictEqual(state.switcher.open, false);
    assert.ok(effects.some((e) => e.type === 'CLOSE_SWITCHER_WINDOW'));
  });

  it('APP_RESIGNED while switcher open closes it without focus theft', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]).state;
    const { state, effects } = reduce(s, { type: 'APP_RESIGNED' });
    assert.strictEqual(state.switcher.open, false);
    assert.ok(effects.some((e) => e.type === 'CLOSE_SWITCHER_WINDOW' && e.restoreFocus === false));
  });

  it('CLOSE_SWITCHER_WINDOW carries the overlay window id (ESC path delegates its teardown to izui)', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPENED', windowId: wid(88) }]).state;
    const { effects } = reduce(s, { type: 'ESC_PRESSED', landedId: 'global' });
    const close = effects.find((e) => e.type === 'CLOSE_SWITCHER_WINDOW');
    assert.ok(close && close.type === 'CLOSE_SWITCHER_WINDOW');
    assert.strictEqual(close.switcherWindowId, wid(88));
    assert.strictEqual(close.restoreFocus, true);
  });
});

// ── Staged-cutover switcher mirror (SWITCHER_OPENED) ─────────────────────────

describe('staged-cutover switcher mirror', () => {
  it('SWITCHER_OPENED records switcher state with NO effect (izui/main own the window)', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    const { state, effects } = reduce(s, { type: 'SWITCHER_OPENED', windowId: wid(9) });
    assert.strictEqual(state.switcher.open, true);
    assert.ok(state.switcher.open && state.switcher.windowId === wid(9));
    assert.ok(!effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'), 'mirror must NOT re-open the overlay');
    // decideEscape step 1 now fires for the externally-opened overlay.
    assert.deepStrictEqual(decideEscape(state), { kind: 'close-switcher' });
  });

  it('WINDOW_CLOSED of the overlay window also clears switcher state (safety net)', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(9), kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(9), focused: true },
      { type: 'SWITCHER_OPENED', windowId: wid(9) },
    ]).state;
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(9) }]).state;
    assert.strictEqual(s.switcher.open, false);
  });
});

// ── Devtools-target + pre-fullscreen-bounds selectors ────────────────────────

describe('selectors: getDevtoolsTargetId / getWindowPreBounds', () => {
  it('getDevtoolsTargetId picks the MRU http(s) window (absorbs lastContentWindowId)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    // Focus with an http url, then a peek:// window (no http url recorded).
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1), lastHttpUrl: 'https://a.com/' }]).state;
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(2) }]).state; // peek:// — no http url
    assert.strictEqual(getDevtoolsTargetId(s), wid(1), 'the http-bearing window is the devtools target');
    // A newer http focus wins by focusSeq.
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(2), lastHttpUrl: 'https://b.com/' }]).state;
    assert.strictEqual(getDevtoolsTargetId(s), wid(2));
  });

  it('getDevtoolsTargetId is null when no window has an http url', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getDevtoolsTargetId(s), null);
  });

  it('getWindowPreBounds returns the stash while non-normal, null when normal', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getWindowPreBounds(s, wid(1)), null, 'normal -> null');
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state;
    assert.deepStrictEqual(getWindowPreBounds(s, wid(1)), BOUNDS);
    s = drive(s, [
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: wid(1) },
    ]).state;
    assert.strictEqual(getWindowPreBounds(s, wid(1)), null, 'back to normal -> null');
  });
});

// ── ESC renderer round-trip (steps 5 -> 6) ───────────────────────────────────

describe('ESC renderer round-trip', () => {
  it('handled:true consumes ESC (NOTHING)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: wid(1) });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: true, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'NOTHING'));
  });

  it('handled:false on an active-session content window opens the switcher (step 6)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    // Session is owned by izui-state.ts and mirrored in via SESSION_CHANGED — the
    // reducer no longer derives it from WINDOW_SHOWN (design §3). Feed 'active'
    // explicitly; content + active -> nothing -> open-switcher.
    s = reduce(s, { type: 'SESSION_CHANGED', session: 'active' }).state;
    assert.strictEqual(snapshot(s).session, 'active');
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: wid(1) });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: false, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('handled:false on a quick-view closes it (step 6, always-close role)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'quick-view' });
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: wid(1) });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: wid(1), handled: false, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'CLOSE_WINDOW' && e.id === wid(1)));
  });
});

// ── The switcher-reopen loop (7fffa286): duplicate registration + a deferred ──
// renderer answer judged against stale state. Both causes are structural, so
// both are pinned here on the pure reducer.

/** The epoch of the ASK_RENDERER in a reduce's effects (fails loudly if absent). */
function askSeq(effects: Effect[]): number {
  const ask = effects.find((e) => e.type === 'ASK_RENDERER');
  assert.ok(ask && ask.type === 'ASK_RENDERER', 'expected an ASK_RENDERER effect');
  return ask.seq;
}

/** Window 4: a visible, focused, front workspace browser window in an active session. */
function s0(): AppWindowState {
  const { state } = drive(createInitialState(), [
    { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'workspace', satellite: false },
    { type: 'WINDOW_SHOWN', id: wid(4), focused: true },
    { type: 'SESSION_CHANGED', session: 'active' },
  ]);
  assert.strictEqual(state.front, wid(4));
  return state;
}

describe('switcher reopen loop (7fffa286)', () => {
  it('double ESC against an open switcher never reopens it', () => {
    // The pre-fix loop: a duplicate esc-handler attach turned ONE keypress into
    // two ESC_PRESSED dispatches. #1 closed the switcher (correct); #2 saw a
    // closed switcher, asked the renderer, and 500ms later the unhandled answer
    // re-opened it — forever. The epoch makes #2's answer inert once anything
    // invalidates it.
    //
    // Session values here model REALITY (corrected): `window-state-singleton.ts
    // clampSession` maps the coordinator's 'overlay' to 'active' before it
    // reaches `reduce`, so the reducer's session is 'active' BEFORE, DURING and
    // AFTER the switcher is open — it does NOT flip, and `escUnhandledPolicy`
    // says 'open-switcher' the whole time. What actually makes the late answer
    // wrong is that the switcher was opened and then closed underneath it (and
    // the overlay window destroyed). The `SESSION_CHANGED` dispatch below still
    // fires for real — izui's enterOverlay/exitOverlay emit unconditionally, and
    // the reducer clears `escAsk` on the EVENT, not on a value change.
    let s = s0();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(10), kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(10), focused: true },
      { type: 'SESSION_CHANGED', session: 'active' },
      { type: 'SWITCHER_OPENED', windowId: wid(10) },
    ]).state;

    const all: Effect[] = [];
    const esc1 = reduce(s, { type: 'ESC_PRESSED', landedId: wid(10) });
    all.push(...esc1.effects);
    const close = esc1.effects.find((e) => e.type === 'CLOSE_SWITCHER_WINDOW');
    assert.ok(close && close.type === 'CLOSE_SWITCHER_WINDOW', 'ESC #1 closes the switcher');
    assert.strictEqual(close.restoreFocus, true);
    assert.strictEqual(close.switcherWindowId, wid(10));

    const esc2 = reduce(esc1.state, { type: 'ESC_PRESSED', landedId: wid(10) });
    all.push(...esc2.effects);
    const seq = askSeq(esc2.effects);

    // While the renderer is being asked, the world moves on exactly as it did in
    // the live trace: izui exits overlay mode (emitting SESSION_CHANGED, same
    // clamped value) and the overlay window closes.
    let after = reduce(esc2.state, { type: 'SESSION_CHANGED', session: 'active' });
    all.push(...after.effects);
    after = reduce(after.state, { type: 'WINDOW_CLOSED', id: wid(10) });
    all.push(...after.effects);
    const answer = reduce(after.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq });
    all.push(...answer.effects);

    assert.ok(!all.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'), 'the switcher must never re-open');
    assert.strictEqual(answer.state.switcher.open, false);
  });

  it('a session change during the wait cancels the pending renderer answer', () => {
    let s = drive(s0(), [{ type: 'SESSION_CHANGED', session: 'transient' }]).state;
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: wid(4) });
    const seq = askSeq(asked.effects);
    const moved = reduce(asked.state, { type: 'SESSION_CHANGED', session: 'active' });
    const answer = reduce(moved.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq });
    // Under 'transient' the policy was 'nothing'; under 'active' it would be
    // 'open-switcher'. The answer belongs to the question that was asked.
    // NOTE: this transient->active flip is izui's `evaluateOnShow` promotion
    // ratchet, NOT the switcher/overlay path — the singleton clamps 'overlay' to
    // 'active', so opening the switcher never changes the reducer's session
    // VALUE (see the reopen-loop test above). This exercises the
    // SESSION_CHANGED invalidation clause on its own terms.
    assert.deepStrictEqual(answer.effects, [{ type: 'NOTHING' }]);
  });

  it('an answer with a matching epoch and nothing intervening is honored', () => {
    const asked = reduce(s0(), { type: 'ESC_PRESSED', landedId: wid(4) });
    const seq = askSeq(asked.effects);
    const answer = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq });
    assert.ok(answer.effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
    assert.strictEqual(answer.state.switcher.open, true);
    assert.ok(answer.state.switcher.open && answer.state.switcher.previousFront === wid(4));
  });

  it('a newer ESC supersedes the older pending answer', () => {
    const first = reduce(s0(), { type: 'ESC_PRESSED', landedId: wid(4) });
    const seq1 = askSeq(first.effects);
    const second = reduce(first.state, { type: 'ESC_PRESSED', landedId: wid(4) });
    const seq2 = askSeq(second.effects);
    assert.notStrictEqual(seq1, seq2);

    const stale = reduce(second.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq: seq1 });
    assert.deepStrictEqual(stale.effects, [{ type: 'NOTHING' }]);
    const live = reduce(stale.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq: seq2 });
    assert.ok(live.effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('an answer for a window closed during the wait is inert', () => {
    const asked = reduce(s0(), { type: 'ESC_PRESSED', landedId: wid(4) });
    const seq = askSeq(asked.effects);
    const closed = reduce(asked.state, { type: 'WINDOW_CLOSED', id: wid(4) });
    const answer = reduce(closed.state, { type: 'ESC_RENDERER_ANSWER', id: wid(4), handled: false, seq });
    assert.deepStrictEqual(answer.effects, [{ type: 'NOTHING' }]);
  });

  it('re-registering a live window merges the spec instead of resetting it', () => {
    // Two call sites register the same BrowserWindow; the second carries the
    // richer spec. Rebuilding a fresh record would drop the window back to
    // visible:false / focusSeq:0 and strip it of `front`.
    let s = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(4), focused: true },
    ]).state;
    const focusSeq = s.windows.get(wid(4))!.focusSeq;
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'workspace', satellite: false }]).state;
    assert.strictEqual(s.windows.get(wid(4))!.visible, true);
    assert.strictEqual(s.windows.get(wid(4))!.focusSeq, focusSeq);
    assert.strictEqual(s.front, wid(4));
  });

  it('a re-registration whose richer spec says satellite hands front to the successor', () => {
    let s = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(4), focused: true },
      { type: 'WINDOW_REGISTERED', id: wid(5), kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(5), focused: false },
    ]).state;
    assert.strictEqual(s.front, wid(4));
    // ipc.ts knows this one is a modal → isSatelliteRegistration says true.
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'workspace', satellite: true }]).state;
    assert.strictEqual(s.windows.get(wid(4))!.satellite, true);
    assert.strictEqual(s.front, wid(5), 'front moves to the MRU successor, never stays illegal');
  });
});

// ── Owner surface ────────────────────────────────────────────────────────────

describe('WindowStateOwner (dispatch / subscribe / waitForMode)', () => {
  it('dispatch mutates the single instance and returns effects', () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    assert.strictEqual(owner.getFrontWindowId(), wid(1));
  });

  it('subscribe fires on dispatch with a snapshot + effects', () => {
    const owner = new WindowStateOwner();
    const seen: (WindowId | null)[] = [];
    owner.subscribe((snap) => seen.push(snap.front));
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    assert.deepStrictEqual(seen, [null, wid(1)]);
  });

  it('waitForMode resolves when the window reaches the mode', async () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    const p = owner.waitForMode(wid(1), 'fullscreen');
    owner.dispatch({ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS });
    owner.dispatch({ type: 'OS_FULLSCREEN_ENTERED', id: wid(1) });
    await p; // resolves, else the test times out
    assert.strictEqual(owner.getWindowMode(wid(1)), 'fullscreen');
  });

  it('waitForMode resolves immediately when already in the mode', async () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    await owner.waitForMode(wid(1), 'normal');
    assert.ok(true);
  });
});

// ── Purity guard: reduce does not mutate its input ───────────────────────────

describe('reduce purity', () => {
  it('does not mutate the input state or its windows map', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const before = snapshot(s);
    const beforeSize = s.windows.size;
    reduce(s, { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS });
    reduce(s, { type: 'WINDOW_CLOSED', id: wid(1) });
    assert.deepStrictEqual(snapshot(s), before, 'input snapshot unchanged');
    assert.strictEqual(s.windows.size, beforeSize, 'input windows map unchanged');
    assert.strictEqual(getWindowMode(s, wid(1)), 'normal', 'input record fsMode unchanged');
  });

  it('isEligibleFront rejects satellites, hidden, and absent records', () => {
    assert.strictEqual(isEligibleFront(undefined), false);
    assert.strictEqual(isEligibleFront({ id: wid(1), kind: 'browser', role: 'content', class: 'primary', stackingLevel: 'excluded', orderable: true, satellite: true, visible: true, fsMode: { name: 'normal' }, maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 0 }), false);
    assert.strictEqual(isEligibleFront({ id: wid(1), kind: 'browser', role: 'content', class: 'primary', stackingLevel: 'stacked', orderable: true, satellite: false, visible: false, fsMode: { name: 'normal' }, maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 0 }), false);
    assert.strictEqual(isEligibleFront({ id: wid(1), kind: 'browser', role: 'content', class: 'primary', stackingLevel: 'stacked', orderable: true, satellite: false, visible: true, fsMode: { name: 'normal' }, maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 0 }), true);
  });
});

// ── isSatelliteRegistration — single owner of front-ineligibility ───────────

describe('isSatelliteRegistration — single owner of front-ineligibility', () => {
  it('role overlay is a satellite', () => {
    assert.strictEqual(isSatelliteRegistration('overlay'), true);
  });

  it('role palette is a satellite', () => {
    assert.strictEqual(isSatelliteRegistration('palette'), true);
  });

  it('role workspace is not a satellite by default', () => {
    assert.strictEqual(isSatelliteRegistration('workspace'), false);
  });

  it('role content is not a satellite by default', () => {
    assert.strictEqual(isSatelliteRegistration('content'), false);
  });

  it('role quick-view is not a satellite (peeks/slides stay front-eligible)', () => {
    assert.strictEqual(isSatelliteRegistration('quick-view'), false);
  });

  it('a close-on-blur modal is a satellite', () => {
    assert.strictEqual(isSatelliteRegistration('content', { modal: true }), true);
  });

  it('a non-modal is not a satellite', () => {
    assert.strictEqual(isSatelliteRegistration('content', { modal: false }), false);
  });

  it('focusable:false is a satellite (the HUD case — the regression this fix closes)', () => {
    assert.strictEqual(isSatelliteRegistration('workspace', { focusable: false }), true);
  });

  it('focusable:true is not a satellite', () => {
    assert.strictEqual(isSatelliteRegistration('workspace', { focusable: true }), false);
  });

  it('focusable:undefined is not a satellite (Electron default focusable:true)', () => {
    assert.strictEqual(isSatelliteRegistration('workspace', { focusable: undefined }), false);
  });
});

// ── Registration idempotence decision (7fffa286) ─────────────────────────────

describe('decideWindowRegistration — single owner of the re-registration branch', () => {
  const fresh = (over: Partial<Parameters<typeof decideWindowRegistration>[0]> = {}) =>
    decideWindowRegistration({ alreadyRegistered: false, kind: 'browser', hasContentWC: true, ...over });
  const again = (over: Partial<Parameters<typeof decideWindowRegistration>[0]> = {}) =>
    decideWindowRegistration({ alreadyRegistered: true, kind: 'browser', hasContentWC: true, ...over });

  it('a first browser registration attaches listeners AND the Esc interceptor', () => {
    assert.deepStrictEqual(fresh(), {
      reRegistration: false,
      attachNativeListeners: true,
      attachEscHandler: true,
      adoptRendererWC: true,
      pumpRegisteredEvent: true,
      pumpShownEvent: false,
    });
  });

  it('registering an ALREADY-VISIBLE window imports its visibility (pumpShownEvent)', () => {
    // A ctor-shown BrowserWindow never fires a 'show' transition, and headless
    // never focuses it — registration is the only moment the machine can learn
    // it is on screen. Without this, `front` stays null forever on such
    // windows (the getFocusedVisibleWindowId-returns-null gate regression).
    assert.strictEqual(fresh({ nativeVisible: true }).pumpShownEvent, true);
    assert.strictEqual(fresh({ nativeVisible: false }).pumpShownEvent, false);
    assert.strictEqual(fresh().pumpShownEvent, false, 'undefined = not visible');
  });

  it('a re-registration of a visible window ALSO re-imports visibility', () => {
    // The richer (ipc.ts) registration runs while the window is already on
    // screen; the shown-import must land AFTER the richer WINDOW_REGISTERED
    // merge so satellite arbitration judges it against the final spec — the
    // adapter owns that ordering; here we pin that the decision asks for it.
    assert.strictEqual(again({ nativeVisible: true }).pumpShownEvent, true);
    assert.strictEqual(again({ nativeVisible: false }).pumpShownEvent, false);
  });

  it('a duplicate id attaches NEITHER listeners NOR a second Esc interceptor', () => {
    const d = again();
    assert.strictEqual(d.reRegistration, true);
    assert.strictEqual(d.attachNativeListeners, false);
    assert.strictEqual(d.attachEscHandler, false, 'a second interceptor is the double-ESC_PRESSED bug');
  });

  it('a duplicate id STILL re-pumps WINDOW_REGISTERED (the richer spec must reach the reducer)', () => {
    // `satellite` lives in the reducer record, so swallowing the re-pump would
    // strand it on the thin tile-launcher spec and regress the
    // `isSatelliteRegistration` modal clause.
    assert.strictEqual(again().pumpRegisteredEvent, true);
    assert.strictEqual(fresh().pumpRegisteredEvent, true);
  });

  it('a page-host never gets the adapter-owned Esc interceptor (no root webContents)', () => {
    assert.strictEqual(fresh({ kind: 'page-host' }).attachEscHandler, false);
    assert.strictEqual(again({ kind: 'page-host' }).attachEscHandler, false);
  });

  it('an explicit opt-out (the shared chrome overlay) suppresses the Esc attach', () => {
    assert.strictEqual(fresh({ attachEscHandlerRequested: false }).attachEscHandler, false);
  });

  it('attachEscHandler undefined/true both mean "attach" for a fresh browser window', () => {
    assert.strictEqual(fresh({ attachEscHandlerRequested: undefined }).attachEscHandler, true);
    assert.strictEqual(fresh({ attachEscHandlerRequested: true }).attachEscHandler, true);
  });

  it('a first registration always installs a renderer WC, even when the spec omits one', () => {
    // Fresh installs `contentWC ?? null` — the absent case is a real null, not a
    // carry-over from nothing.
    assert.strictEqual(fresh({ hasContentWC: false }).adoptRendererWC, true);
  });

  it('a re-registration adopts the WC only when the spec actually carries one', () => {
    assert.strictEqual(again({ hasContentWC: true }).adoptRendererWC, true);
    assert.strictEqual(
      again({ hasContentWC: false }).adoptRendererWC,
      false,
      'a later, thinner spec must not blank out an established WC',
    );
  });

  it('is total: every (alreadyRegistered x kind x hasContentWC x optOut x visible) yields booleans', () => {
    for (const alreadyRegistered of [false, true]) {
      for (const kind of ['browser', 'page-host'] as const) {
        for (const hasContentWC of [false, true]) {
          for (const attachEscHandlerRequested of [undefined, false, true]) {
            for (const nativeVisible of [undefined, false, true]) {
              const d = decideWindowRegistration({ alreadyRegistered, kind, hasContentWC, attachEscHandlerRequested, nativeVisible });
              for (const [k, v] of Object.entries(d)) {
                assert.strictEqual(typeof v, 'boolean', `${k} must be boolean`);
              }
              // The two invariants the 7fffa286 fix rests on, over the whole space.
              assert.strictEqual(d.attachNativeListeners, !alreadyRegistered);
              if (alreadyRegistered) assert.strictEqual(d.attachEscHandler, false);
              assert.strictEqual(d.pumpRegisteredEvent, true);
              // Visibility import tracks the native read exactly — never the
              // registration freshness.
              assert.strictEqual(d.pumpShownEvent, nativeVisible === true);
            }
          }
        }
      }
    }
  });
});

// ── Front-invariant guard has teeth (design §2.5) ────────────────────────────

describe('front-invariant guard (dev/test throws, prod self-corrects)', () => {
  // A deliberately-illegal state: `front` points at a satellite. No legitimate
  // event sequence can produce this (the reducer only ever assigns an eligible
  // front) — we craft it directly to exercise the guard's throw path.
  function illegalFrontState(): AppWindowState {
    const rec: WindowRecord = { id: wid(1), kind: 'browser', role: 'palette', class: 'palette', stackingLevel: 'pinned', orderable: true, satellite: true, visible: true, fsMode: { name: 'normal' }, maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 1 };
    return { appActive: true, session: 'active', front: wid(1), frontAsserted: true, stackOrder: [], switcher: { open: false }, windows: new Map([[wid(1), rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0, pendingAppResignSweep: false };
  }

  it('THROWS in dev/test when reduce yields an illegal front (naming the event + front id)', () => {
    // NODE_ENV is unset under `node --test` -> non-production -> guard active.
    assert.notStrictEqual(process.env.NODE_ENV, 'production');
    assert.throws(
      () => reduce(illegalFrontState(), { type: 'OS_FOCUS_SETTLED_NULL' }),
      /illegal front=wm-1 after OS_FOCUS_SETTLED_NULL/,
    );
  });

  it('self-corrects (no throw) in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { state } = reduce(illegalFrontState(), { type: 'OS_FOCUS_SETTLED_NULL' });
      // Only a satellite exists, so the MRU successor is null.
      assert.strictEqual(state.front, null);
      assert.ok(frontInvariantHolds(state));
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('FULLSCREEN_REQUESTED on a satellite does NOT install an illegal front (and does not throw)', () => {
    // The reducer bug the reviewer flagged: front was assigned unconditionally.
    const rec: WindowRecord = { id: wid(1), kind: 'browser', role: 'palette', class: 'palette', stackingLevel: 'pinned', orderable: true, satellite: true, visible: true, fsMode: { name: 'normal' }, maximized: false, preMaxBounds: null, visibleOnAllSpaces: false, pendingProjectedBounds: null, focusSeq: 1 };
    const s: AppWindowState = { appActive: true, session: 'active', front: null, frontAsserted: false, stackOrder: [], switcher: { open: false }, windows: new Map([[wid(1), rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0, pendingAppResignSweep: false };
    const { state } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS });
    assert.strictEqual(state.front, null, 'a satellite must never become front, even via a fullscreen request');
    assert.strictEqual(getWindowMode(state, wid(1)), 'entering-fullscreen', 'the fsMode edge still runs (total table)');
  });
});

// ── The front assertion: intent vs. "the OS actually matches it" ─────────────
//
// The defect this whole section pins: the deleted `frontChangeEffects` early-returned
// whenever `front === prevFront`, i.e. it inferred "the OS still matches the target"
// from "the target didn't change". Everything below either asserts the OS is re-driven
// on a transition where `front` did NOT move, or pins which events invalidate the claim.

/** Did this reduce describe raising window `id` onto the OS? */
function raises(effects: Effect[], id: number | WindowId): boolean {
  const target = typeof id === 'number' ? wid(id) : id;
  return effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === target);
}

/** Did this reduce describe making window `id`'s content view first responder? */
function focusesContent(effects: Effect[], id: number | WindowId): boolean {
  const target = typeof id === 'number' ? wid(id) : id;
  return effects.some((e) => e.type === 'FOCUS_CONTENT' && e.id === target);
}

describe('front assertion — the machine drives `front` onto the OS, not just remembers it', () => {
  it('a front change raises the new front, and a page-host ALSO gets FOCUS_CONTENT', () => {
    const { state, effects } = reduce(
      drive(createInitialState(), [
        { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
      ]).state,
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    );
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(raises(effects, 1), 'the new front must be raised');
    assert.ok(focusesContent(effects, 1), 'a page-host needs its content view made first responder');
    assert.strictEqual(snapshot(state).frontAsserted, true, 'the claim is recorded');
  });

  it('a browser window gets RAISE_WINDOW but NOT FOCUS_CONTENT (its root WC is first responder)', () => {
    const { state, effects } = reduce(
      drive(createInitialState(), [
        { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
      ]).state,
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    );
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(raises(effects, 1));
    assert.ok(!hasEffect(effects, 'FOCUS_CONTENT'), 'a BrowserWindow has no separate content view to focus');
  });

  it('an OS-driven front switch records the assertion WITHOUT echoing a raise (the OS already did it)', () => {
    // OS_FOCUS_GAINED means the OS made the window key + front on its own —
    // driving RAISE back at it is the focus-echo feedback loop (see the
    // record-not-echo clause in applyFrontAssertion; observed live 2026-07-22:
    // several in-flight show-active focus events + an echoed activating raise
    // per event = a perpetual multi-window focus ping-pong at restore).
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2
    const { state, effects } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(1) });
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(!hasEffect(effects, 'RAISE_WINDOW'), 'no activating raise echoed back at the OS');
    assert.ok(!hasEffect(effects, 'FOCUS_CONTENT'), 'window 1 is a browser window');
    assert.strictEqual(snapshot(state).frontAsserted, true, 'the OS event itself is the assertion');
    const order = getStackOrder(state);
    assert.strictEqual(order[order.length - 1], wid(1), 'the list mirrors the OS-driven order-front');
  });

  it('an OS-driven front switch to a PAGE-HOST still drives the content first responder (7c61e917)', () => {
    // The one half the OS focus event does not vouch for: the host being key
    // does not make its content WebContentsView first responder.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // front 2
    const { state, effects } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(1) });
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(!hasEffect(effects, 'RAISE_WINDOW'));
    assert.ok(focusesContent(effects, 1), 'content first responder is still the machine’s to drive');
    assert.strictEqual(snapshot(state).frontAsserted, true);
  });

  it('an already-asserted, unchanged front emits nothing (the assertion is idempotent)', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(snapshot(s).frontAsserted, true);
    const { effects } = reduce(s, { type: 'SESSION_CHANGED', session: 'active' });
    assert.ok(!hasEffect(effects, 'RAISE_WINDOW'), 'no gratuitous re-raise on an unrelated transition');
    assert.ok(!hasEffect(effects, 'FOCUS_CONTENT'));
  });

  it('REGRESSION (frontChangeEffects): APP_RESIGNED then APP_ACTIVATED re-asserts an UNCHANGED front', () => {
    // This is the case the deleted `frontChangeEffects` could not express. The user
    // Cmd+Tabs away and back: `front` never moves, so its `front === prevFront`
    // early-out returned NO effects — a page host came back key but with its content
    // view no longer first responder, so `before-input-event` was deaf and Escape
    // reached nothing at all, permanently (7c61e917 / 7fffa286).
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(snapshot(s).frontAsserted, true);

    const resigned = reduce(s, { type: 'APP_RESIGNED' });
    assert.strictEqual(getFrontWindowId(resigned.state), wid(1), 'front survives the app switch (by design)');
    assert.strictEqual(snapshot(resigned.state).frontAsserted, false, 'but the claim about the OS does not');
    assert.ok(!hasEffect(resigned.effects, 'RAISE_WINDOW'), 'no focus theft while Peek is not the active app');

    const activated = reduce(resigned.state, { type: 'APP_ACTIVATED' });
    assert.strictEqual(getFrontWindowId(activated.state), wid(1), 'front is UNCHANGED across the whole round trip');
    assert.ok(raises(activated.effects, 1), 'and yet it must be re-raised — this is the whole fix');
    assert.ok(focusesContent(activated.effects, 1), 'first responder is restored on the page host');
    assert.strictEqual(snapshot(activated.state).frontAsserted, true);
  });

  it('SWITCHER_OPENED invalidates without stealing key back; the Esc-close then re-asserts the restore target', () => {
    const s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });

    const opened = reduce(s, { type: 'SWITCHER_OPENED', windowId: wid(88) });
    assert.strictEqual(getFrontWindowId(opened.state), wid(4), 'front does not move for the overlay');
    assert.strictEqual(snapshot(opened.state).frontAsserted, false, 'the overlay took key — the claim is void');
    assert.ok(
      !hasEffect(opened.effects, 'RAISE_WINDOW'),
      'must NOT re-raise front while the switcher is open — that would yank key out of the overlay',
    );

    // Esc dismisses the switcher. `applyEscape` case 'close-switcher' emits no
    // RAISE_WINDOW of its own; the restore ride entirely on the assertion step.
    const closed = reduce(opened.state, { type: 'ESC_PRESSED', landedId: 'global' });
    assert.strictEqual(closed.state.switcher.open, false);
    assert.strictEqual(getFrontWindowId(closed.state), wid(4));
    assert.ok(hasEffect(closed.effects, 'CLOSE_SWITCHER_WINDOW'));
    assert.ok(raises(closed.effects, 4), 'the restore target is re-asserted on dismiss');
    assert.ok(focusesContent(closed.effects, 4));
  });

  it('SWITCHER_SELECTED raises the selection through the assertion step (one emitter, not two)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2
    s = drive(s, [{ type: 'SWITCHER_OPENED', windowId: wid(99) }]).state;
    const { state, effects } = reduce(s, { type: 'SWITCHER_SELECTED', id: wid(1) });
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.strictEqual(effects.filter((e) => e.type === 'RAISE_WINDOW').length, 1, 'exactly one raise, from one place');
    assert.ok(raises(effects, 1));
    assert.ok(focusesContent(effects, 1));
  });

  it('a satellite gaining OS focus invalidates, and the NEXT transition re-asserts the real front', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
    ]).state;
    assert.strictEqual(snapshot(s).frontAsserted, true);

    const stolen = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(2) });
    assert.strictEqual(getFrontWindowId(stolen.state), wid(1), 'a satellite never becomes front');
    assert.strictEqual(snapshot(stolen.state).frontAsserted, false, 'but it DID take key, so the claim is void');
    assert.ok(
      !hasEffect(stolen.effects, 'RAISE_WINDOW'),
      'must not rip key back out of the palette the instant it takes it',
    );

    // The palette goes away — self-healing, per design §2.
    const healed = reduce(stolen.state, { type: 'WINDOW_CLOSED', id: wid(2) });
    assert.strictEqual(getFrontWindowId(healed.state), wid(1), 'front never moved');
    assert.ok(raises(healed.effects, 1), 'the real front is re-asserted on the next transition');
    assert.ok(focusesContent(healed.effects, 1));
  });

  it('WINDOW_HIDDEN of the front invalidates and asserts the successor', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2, 1 still visible
    const { state, effects } = reduce(s, { type: 'WINDOW_HIDDEN', id: wid(2) });
    assert.strictEqual(getFrontWindowId(state), wid(1), 'front hands off to the MRU successor');
    assert.ok(raises(effects, 1), 'the successor is driven onto the OS, not merely recorded');
  });

  it('duplicate WINDOW_HIDDEN (backend echo + late native hide event) is a no-op re-merge', () => {
    // Since §6A the backend ECHOES WINDOW_HIDDEN synchronously for every hide
    // it performs (the native BaseWindow 'hide' event lags a tick on macOS —
    // peek 71cfde09), so the reducer sees the SAME hide twice: echo first,
    // native mirror later. The second arrival must change nothing — no front
    // re-succession, no stack change, no effects.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2, 1 still visible
    const first = reduce(s, { type: 'WINDOW_HIDDEN', id: wid(2) });
    assert.strictEqual(getFrontWindowId(first.state), wid(1), 'front hands off on the echo');
    const dup = reduce(first.state, { type: 'WINDOW_HIDDEN', id: wid(2) });
    assert.strictEqual(getFrontWindowId(dup.state), wid(1), 'late native mirror moves nothing');
    assert.strictEqual(dup.state.windows.get(wid(2))!.visible, false);
    assert.deepStrictEqual(dup.state.stackOrder, first.state.stackOrder, 'stack untouched by the duplicate');
    assert.deepStrictEqual(dup.effects, [], 'no effects from the duplicate');
  });

  it('WINDOW_HIDDEN of the ONLY window clears the assertion and asserts nothing', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const hidden = reduce(s, { type: 'WINDOW_HIDDEN', id: wid(1) });
    assert.strictEqual(getFrontWindowId(hidden.state), null, 'no successor');
    assert.strictEqual(snapshot(hidden.state).frontAsserted, false);
    assert.ok(!hasEffect(hidden.effects, 'RAISE_WINDOW'), 'nothing to assert with no front');

    // Showing it again re-establishes both the intent and the assertion.
    const shown = reduce(hidden.state, { type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    assert.strictEqual(getFrontWindowId(shown.state), wid(1));
    assert.ok(raises(shown.effects, 1));
  });

  it('no re-assert while appActive === false, however many transitions pass', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'APP_RESIGNED' }]).state;
    assert.strictEqual(s.appActive, false);

    const inactive: WindowEvent[] = [
      { type: 'OS_FOCUS_SETTLED_NULL' },
      { type: 'SESSION_CHANGED', session: 'transient' },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true }, // moves front, still must not raise
      { type: 'OS_FOCUS_GAINED', id: wid(1) },
    ];
    for (const ev of inactive) {
      const r = reduce(s, ev);
      assert.ok(!hasEffect(r.effects, 'RAISE_WINDOW'), `RAISE_WINDOW while inactive after ${ev.type}`);
      assert.ok(!hasEffect(r.effects, 'FOCUS_CONTENT'), `FOCUS_CONTENT while inactive after ${ev.type}`);
      assert.strictEqual(snapshot(r.state).frontAsserted, false, `asserted while inactive after ${ev.type}`);
      s = r.state;
    }

    // Coming back is what re-asserts.
    const back = reduce(s, { type: 'APP_ACTIVATED' });
    assert.ok(raises(back.effects, getFrontWindowId(back.state)!));
  });
});

// ── deriveEscGrabRegistered — the honest safety net (design §2) ──────────────

describe('deriveEscGrabRegistered — truth table over (appActive, front, frontAsserted)', () => {
  function snapOf(over: Partial<StateSnapshot> = {}): StateSnapshot {
    return {
      appActive: true,
      session: 'active',
      front: null,
      frontAsserted: false,
      stackOrder: [],
      switcher: { open: false },
      windows: [],
      ...over,
    };
  }

  it('is total and matches the table for all 8 (appActive x front x frontAsserted) combinations', () => {
    const rows: { appActive: boolean; front: WindowId | null; frontAsserted: boolean; want: boolean }[] = [
      // Peek is not the active app -> never grab, whatever we believe about front.
      { appActive: false, front: null, frontAsserted: false, want: false },
      { appActive: false, front: null, frontAsserted: true, want: false },
      { appActive: false, front: wid(1), frontAsserted: false, want: false },
      { appActive: false, front: wid(1), frontAsserted: true, want: false },
      // No front at all -> nobody can receive before-input-event -> grab.
      { appActive: true, front: null, frontAsserted: false, want: true },
      { appActive: true, front: null, frontAsserted: true, want: true },
      // A front we have NOT driven onto the OS is exactly the 7fffa286 hole: the
      // window is not first responder AND the old predicate switched the net off.
      { appActive: true, front: wid(1), frontAsserted: false, want: true },
      // A front we HAVE asserted is positioned to hear Escape -> no grab needed.
      { appActive: true, front: wid(1), frontAsserted: true, want: false },
    ];
    for (const row of rows) {
      const got = deriveEscGrabRegistered(snapOf(row));
      assert.strictEqual(
        got,
        row.want,
        `appActive=${row.appActive} front=${row.front} frontAsserted=${row.frontAsserted}`,
      );
    }
  });

  it('an open switcher suppresses the grab (it owns Escape in its own renderer)', () => {
    const open = { open: true as const, windowId: wid(88), previousFront: wid(1) };
    // SWITCHER_OPENED clears frontAsserted, so without this clause the grab would
    // switch ON precisely while the overlay is up — and an OS grab pre-empts
    // before-input-event, eating the switcher's own Escape (the reopen loop).
    assert.strictEqual(deriveEscGrabRegistered(snapOf({ front: wid(1), frontAsserted: false, switcher: open })), false);
    assert.strictEqual(deriveEscGrabRegistered(snapOf({ front: null, frontAsserted: false, switcher: open })), false);
  });

  it('tracks the live reducer state across the app-switch round trip (the 7fffa286 hole)', () => {
    // The end-to-end statement: a front that has drifted is never left both deaf
    // AND unguarded. Under the OLD predicate (`front === null`) the grab was off
    // for every step here, which is what made the third Escape do nothing forever.
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(deriveEscGrabRegistered(snapshot(s)), false, 'asserted front hears Escape itself');

    const resigned = reduce(s, { type: 'APP_RESIGNED' });
    assert.strictEqual(deriveEscGrabRegistered(snapshot(resigned.state)), false, 'not the active app');

    // Back in front, but nothing has re-driven the OS yet at the moment the
    // assertion is cleared — the net covers precisely that window of time.
    assert.strictEqual(snapshot(resigned.state).frontAsserted, false);
    assert.strictEqual(
      deriveEscGrabRegistered(snapOf({ appActive: true, front: wid(1), frontAsserted: false })),
      true,
      'active + unasserted front -> the safety net is ON',
    );

    const activated = reduce(resigned.state, { type: 'APP_ACTIVATED' });
    assert.strictEqual(
      deriveEscGrabRegistered(snapshot(activated.state)),
      false,
      'the same transition re-asserts, so the net drops again immediately',
    );
  });
});

describe('APP_ACTIVATED reconciles ALL in-flight fullscreen transitions (§2.5)', () => {
  it('emits RECONCILE_FULLSCREEN for both an entering AND a leaving window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: wid(1), bounds: BOUNDS }]).state; // 1 -> entering
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(2), bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(2) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(2), desired: false }, // 2 -> leaving
    ]).state;
    assert.strictEqual(getWindowMode(s, wid(1)), 'entering-fullscreen');
    assert.strictEqual(getWindowMode(s, wid(2)), 'leaving-fullscreen');

    const { effects } = reduce(s, { type: 'APP_ACTIVATED' });
    const reconciled = effects.filter((e) => e.type === 'RECONCILE_FULLSCREEN').map((e) => (e as { id: WindowId }).id).sort();
    assert.deepStrictEqual(reconciled, [wid(1), wid(2)], 'both in-flight windows are reconciled, not just front');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 step 4 — special window classes + registry unification
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyWindowRegistration — single owner of the ordinary-window class rule', () => {
  it('maps the role vocabulary onto classes', () => {
    assert.strictEqual(classifyWindowRegistration('overlay'), 'overlay');
    assert.strictEqual(classifyWindowRegistration('palette'), 'palette');
    assert.strictEqual(classifyWindowRegistration('quick-view'), 'quick-view');
    assert.strictEqual(classifyWindowRegistration('content'), 'primary');
    assert.strictEqual(classifyWindowRegistration('workspace'), 'primary');
    assert.strictEqual(classifyWindowRegistration('child-content'), 'primary');
  });

  it('alwaysOnTop + focusable:false is hud (the declared form of the deleted sniffing predicate)', () => {
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true, focusable: false }), 'hud');
    // Either property alone is NOT a HUD — matches the old predicate's conjunction.
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true, focusable: true }), 'primary');
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true }), 'primary', 'focusable undefined = Electron default true');
    assert.strictEqual(classifyWindowRegistration('utility', { focusable: false }), 'primary');
  });

  it('role classes win over the hud pair (a non-focusable alwaysOnTop palette is still a palette)', () => {
    assert.strictEqual(classifyWindowRegistration('palette', { alwaysOnTop: true, focusable: false }), 'palette');
  });
});

describe('isSatelliteRegistration — class extension (§5 step 4)', () => {
  it('infrastructure classes are satellites regardless of role/focusable', () => {
    for (const cls of ['hud', 'background', 'bridge', 'offscreen', 'test-fixture', 'devtools'] as const) {
      assert.strictEqual(isSatelliteRegistration('content', { windowClass: cls }), true, cls);
    }
  });

  it('offscreen (chrome.offscreen polyfill documents) is an infrastructure satellite exactly like bridge', () => {
    assert.strictEqual(isSatelliteRegistration('utility', { windowClass: 'offscreen' }), true);
    assert.strictEqual(deriveStackingLevel('offscreen', true), 'excluded');
  });

  it('extension-ui and the ordinary classes stay front-eligible under the class clause', () => {
    for (const cls of ['extension-ui', 'primary', 'quick-view'] as const) {
      assert.strictEqual(isSatelliteRegistration('content', { windowClass: cls }), false, cls);
    }
  });

  it('the pre-existing rules still apply alongside a front-eligible class', () => {
    assert.strictEqual(isSatelliteRegistration('overlay', { windowClass: 'primary' }), true);
    assert.strictEqual(isSatelliteRegistration('content', { windowClass: 'primary', modal: true }), true);
    assert.strictEqual(isSatelliteRegistration('content', { windowClass: 'primary', focusable: false }), true);
  });
});

describe('WINDOW_REGISTERED — class / registry payload / parent linkage / alwaysOnTop', () => {
  it('defaults class to primary when the raw event omits it', () => {
    const { state } = reduce(createInitialState(), { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false });
    assert.strictEqual(state.windows.get(wid(1))!.class, 'primary');
  });

  it('stores class, source, params (by reference) and parentId from the registration', () => {
    const params = { key: 'k', keepLive: true };
    const { state } = reduce(createInitialState(), {
      type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'utility', class: 'hud',
      satellite: true, source: 'peek://hud/background.html', params, parentId: wid(9),
    });
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.class, 'hud');
    assert.strictEqual(rec.source, 'peek://hud/background.html');
    assert.strictEqual(rec.params, params, 'params held BY REFERENCE (legacy consumers mutate in place)');
    assert.strictEqual(rec.parentId, wid(9));
  });

  it('re-registration merges: later class wins, absent fields keep the earlier payload', () => {
    let s = reduce(createInitialState(), {
      type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false,
      source: 'peek://a', params: { key: 'k' }, parentId: wid(3),
    }).state;
    s = reduce(s, { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'quick-view', class: 'quick-view', satellite: false }).state;
    const rec = s.windows.get(wid(1))!;
    assert.strictEqual(rec.class, 'quick-view', 'later (richer) class wins');
    assert.strictEqual(rec.source, 'peek://a', 'earlier source survives an absent field');
    assert.deepStrictEqual(rec.params, { key: 'k' }, 'earlier params survive an absent field');
    assert.strictEqual(rec.parentId, wid(3), 'earlier parent linkage survives');
  });

  it('alwaysOnTop:true emits SET_ALWAYS_ON_TOP on fresh registration AND on a re-registration', () => {
    const first = reduce(createInitialState(), { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'utility', class: 'hud', satellite: true, alwaysOnTop: true });
    assert.deepStrictEqual(first.effects.filter((e) => e.type === 'SET_ALWAYS_ON_TOP'), [{ type: 'SET_ALWAYS_ON_TOP', id: wid(1), on: true }]);
    const again = reduce(first.state, { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'utility', class: 'hud', satellite: true, alwaysOnTop: true });
    assert.ok(hasEffect(again.effects, 'SET_ALWAYS_ON_TOP'), 'idempotent re-pin on the richer re-registration');
    const without = reduce(first.state, { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'utility', class: 'hud', satellite: true });
    assert.strictEqual(hasEffect(without.effects, 'SET_ALWAYS_ON_TOP'), false, 'no declared pin -> no effect');
  });
});

describe('WINDOW_PARAMS_SET — the registerWindow merge seam', () => {
  it('attaches source+params to an existing record', () => {
    let s = reduce(createInitialState(), { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false }).state;
    const params = { address: 'https://x.test/' };
    s = reduce(s, { type: 'WINDOW_PARAMS_SET', id: wid(1), source: 'test-esc', params }).state;
    const rec = s.windows.get(wid(1))!;
    assert.strictEqual(rec.source, 'test-esc');
    assert.strictEqual(rec.params, params);
  });

  it('is a no-op for an unknown window', () => {
    const { state, effects } = reduce(createInitialState(), { type: 'WINDOW_PARAMS_SET', id: wid(7), source: 's', params: {} });
    assert.strictEqual(state.windows.size, 0);
    assert.strictEqual(effects.length, 0);
  });
});

describe('WINDOW_CLOSE_OR_HIDE_REQUESTED — reducer-owned keepLive close-request decision (§5 step 6A-1)', () => {
  it('keepLive window -> HIDE_WINDOW, record untouched (visible flips on the native hide event)', () => {
    let s = createInitialState();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false, keepLive: true },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    ]).state;
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(1) });
    assert.deepStrictEqual(effects.filter((e) => e.type === 'HIDE_WINDOW' || e.type === 'CLOSE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(1) }]);
    assert.ok(state.windows.has(wid(1)), 'still registered — keepLive never closes');
    assert.strictEqual(state.windows.get(wid(1))!.visible, true, 'visible is untouched here; it flips on WINDOW_HIDDEN');
  });

  it('non-keepLive window -> CLOSE_WINDOW', () => {
    const s = openWindow(createInitialState(), 1, {});
    const { effects } = reduce(s, { type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(1) });
    assert.deepStrictEqual(effects.filter((e) => e.type === 'HIDE_WINDOW' || e.type === 'CLOSE_WINDOW'), [{ type: 'CLOSE_WINDOW', id: wid(1) }]);
  });

  it('is a no-op for an unknown id', () => {
    const { state, effects } = reduce(createInitialState(), { type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(9) });
    assert.strictEqual(state.windows.size, 0);
    assert.strictEqual(effects.length, 0);
  });

  it('a keepLive window hidden then re-shown keeps its identity and rejoins the stack', () => {
    let s = createInitialState();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false, keepLive: true },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    ]).state;
    s = reduce(s, { type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(1) }).state;
    s = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]).state; // native hide confirmation
    assert.strictEqual(s.windows.get(wid(1))!.visible, false);
    assert.ok(!s.stackOrder.includes(wid(1)), 'not stacked while hidden');
    s = drive(s, [{ type: 'WINDOW_SHOWN', id: wid(1), focused: true }]).state;
    const rec = s.windows.get(wid(1))!;
    assert.strictEqual(rec.id, wid(1), 'same id — re-show, not re-registration');
    assert.strictEqual(rec.keepLive, true, 'keepLive policy survives the hide/show round trip');
    assert.strictEqual(rec.visible, true);
    assert.ok(s.stackOrder.includes(wid(1)), 'rejoins the ordered stack on re-show');
  });
});

describe('request events — pass-through effects (state changes ride the native events)', () => {
  it('WINDOW_CLOSE_REQUESTED -> CLOSE_WINDOW_DIRECT, record untouched (retires on WINDOW_CLOSED)', () => {
    const s = openWindow(createInitialState(), 1, {});
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSE_REQUESTED', id: wid(1) });
    assert.deepStrictEqual(effects.filter((e) => e.type === 'CLOSE_WINDOW_DIRECT'), [{ type: 'CLOSE_WINDOW_DIRECT', id: wid(1) }]);
    assert.ok(state.windows.has(wid(1)), 'the record retires on WINDOW_CLOSED, not on the request');
  });

  it('WINDOW_CLOSE_REQUESTED for an unknown id still emits (the backend resolves + no-ops)', () => {
    const { effects } = reduce(createInitialState(), { type: 'WINDOW_CLOSE_REQUESTED', id: wid(9) });
    assert.ok(hasEffect(effects, 'CLOSE_WINDOW_DIRECT'));
  });

  it('WINDOW_DESTROY_REQUESTED -> DESTROY_WINDOW', () => {
    const { effects } = reduce(openWindow(createInitialState(), 1, {}), { type: 'WINDOW_DESTROY_REQUESTED', id: wid(1) });
    assert.deepStrictEqual(effects.filter((e) => e.type === 'DESTROY_WINDOW'), [{ type: 'DESTROY_WINDOW', id: wid(1) }]);
  });

  it('WINDOW_HIDE_REQUESTED -> HIDE_WINDOW, record untouched (visible flips on the native hide event)', () => {
    const s = openWindow(createInitialState(), 1, {});
    const { state, effects } = reduce(s, { type: 'WINDOW_HIDE_REQUESTED', id: wid(1) });
    assert.deepEqual(effects.filter((e) => e.type === 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(1) }]);
    assert.equal(state.windows.get(wid(1))?.visible, true); // flips on WINDOW_HIDDEN, not here
    // Unknown id still emits — the backend resolves the handle and no-ops when gone.
    const unknown = reduce(createInitialState(), { type: 'WINDOW_HIDE_REQUESTED', id: wid(9) });
    assert.deepEqual(unknown.effects, [{ type: 'HIDE_WINDOW', id: wid(9) }]);
  });

  it('WINDOW_SHOW_REQUESTED echoes the activate flag onto SHOW_WINDOW', () => {
    for (const activate of [true, false]) {
      const { effects } = reduce(openWindow(createInitialState(), 1, {}), { type: 'WINDOW_SHOW_REQUESTED', id: wid(1), activate });
      assert.deepStrictEqual(effects.filter((e) => e.type === 'SHOW_WINDOW'), [{ type: 'SHOW_WINDOW', id: wid(1), activate }]);
    }
  });

  it('WINDOW_CONTENT_CLOSE_REQUESTED -> CLOSE_CONTENT even after the record retired (backend holds the WC)', () => {
    let s = openWindow(createInitialState(), 1, {});
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(1) }]).state;
    const { effects } = reduce(s, { type: 'WINDOW_CONTENT_CLOSE_REQUESTED', id: wid(1) });
    assert.ok(hasEffect(effects, 'CLOSE_CONTENT'));
  });

  it('GUEST_TEARDOWN_REQUESTED -> DESTROY_ALL_GUESTS', () => {
    const { effects } = reduce(createInitialState(), { type: 'GUEST_TEARDOWN_REQUESTED' });
    assert.ok(hasEffect(effects, 'DESTROY_ALL_GUESTS'));
  });
});

describe('parent refocus on WINDOW_CLOSED (replaces the main.ts parentWin.focus() block)', () => {
  function parentAndChild(): AppWindowState {
    let s = openWindow(createInitialState(), 1, { role: 'content' }); // parent
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'child-content', satellite: false, parentId: wid(1) },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
    ]).state;
    return s;
  }

  it('closing the focused child hands front back to the parent and re-drives it', () => {
    let s = parentAndChild();
    // A third, more-recently-focused window would be the MRU successor — the
    // parent must still win.
    s = openWindow(s, 3, { role: 'content' });
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(2) }]).state;
    assert.strictEqual(s.front, wid(2));
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(2) });
    assert.strictEqual(state.front, wid(1), 'parent takes precedence over the MRU successor');
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)), 'the closing assertion step raises the parent');
  });

  it('re-drives the parent even when it already was front (assertion invalidation, old focus() parity)', () => {
    let s = parentAndChild();
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]).state; // parent focused; child open in background
    assert.strictEqual(s.front, wid(1));
    assert.strictEqual(s.frontAsserted, true);
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(2) });
    assert.strictEqual(state.front, wid(1));
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)), 'front unchanged but the raise is re-driven');
  });

  it('an ineligible parent (hidden) falls back to the MRU successor', () => {
    let s = parentAndChild();
    s = openWindow(s, 3, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_HIDDEN', id: wid(1) },
      { type: 'OS_FOCUS_GAINED', id: wid(2) },
    ]).state;
    const { state } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(2) });
    assert.strictEqual(state.front, wid(3), 'hidden parent cannot take front; MRU successor wins');
  });

  it('closing a parentless window does not invalidate the assertion for an unrelated front', () => {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = openWindow(s, 2, { role: 'content', focused: false });
    assert.strictEqual(s.front, wid(1));
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(2) });
    assert.strictEqual(state.front, wid(1));
    assert.strictEqual(effects.some((e) => e.type === 'RAISE_WINDOW'), false, 'no parent linkage -> no re-drive');
  });
});

describe('HUD hide/show sweep (replaces the __hudHidden expando + sniffing loops)', () => {
  function withHud(): AppWindowState {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'utility', class: 'hud', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
    ]).state;
    return s;
  }

  it('APP_RESIGNED hides the visible HUD (HIDE_WINDOW + hiddenByAppBlur)', () => {
    const { state, effects } = reduce(withHud(), { type: 'APP_RESIGNED' });
    assert.ok(effects.some((e) => e.type === 'HIDE_WINDOW' && e.id === wid(2)));
    assert.strictEqual(state.windows.get(wid(2))!.hiddenByAppBlur, true);
    assert.strictEqual(effects.some((e) => e.type === 'HIDE_WINDOW' && (e as { id: WindowId }).id === wid(1)), false, 'non-hud windows untouched');
  });

  it('APP_ACTIVATED re-shows exactly the sweep-hidden HUD, without activation, and clears the flag', () => {
    let s = reduce(withHud(), { type: 'APP_RESIGNED' }).state;
    s = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(2) }]).state; // native hide confirmation
    const { state, effects } = reduce(s, { type: 'APP_ACTIVATED' });
    assert.deepStrictEqual(effects.filter((e) => e.type === 'SHOW_WINDOW'), [{ type: 'SHOW_WINDOW', id: wid(2), activate: false }]);
    assert.strictEqual(state.windows.get(wid(2))!.hiddenByAppBlur, false);
  });

  it('a HUD hidden by other means is NOT re-shown on activation', () => {
    let s = withHud();
    s = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(2) }]).state; // hidden, but not by the app-blur sweep
    const resigned = reduce(s, { type: 'APP_RESIGNED' });
    assert.strictEqual(hasEffect(resigned.effects, 'HIDE_WINDOW'), false, 'already-hidden HUD is not swept');
    const activated = reduce(resigned.state, { type: 'APP_ACTIVATED' });
    assert.strictEqual(hasEffect(activated.effects, 'SHOW_WINDOW'), false);
  });

  it('a focusable alwaysOnTop palette (class palette) is untouched by the sweep', () => {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'palette', class: 'palette', satellite: true, alwaysOnTop: true },
      { type: 'WINDOW_SHOWN', id: wid(4), focused: false },
    ]).state;
    const { effects } = reduce(s, { type: 'APP_RESIGNED' });
    assert.strictEqual(hasEffect(effects, 'HIDE_WINDOW'), false);
  });
});

describe('devtools transitions (§4.6 dim 8a)', () => {
  it('DEVTOOLS_OPENED invalidates + re-drives the front in the same transition', () => {
    const s = openWindow(createInitialState(), 1, { role: 'content' });
    assert.strictEqual(s.frontAsserted, true);
    const { state, effects } = reduce(s, { type: 'DEVTOOLS_OPENED', id: wid(1) });
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)), 'the front is re-driven immediately (old re-focus-after-devtools parity)');
    assert.ok(effects.some((e) => e.type === 'FOCUS_CONTENT' && e.id === wid(1)), 'page-host front also re-takes first responder');
    assert.strictEqual(state.frontAsserted, true, 're-asserted in the same reduce');
    assert.strictEqual(deriveEscGrabRegistered(snapshot(state)), false, 'the Esc grab stays off while devtools is up');
  });

  it('DEVTOOLS_CLOSED re-drives the front (the old close-devtools-refocus behavior)', () => {
    const s = openWindow(createInitialState(), 1, { role: 'content' });
    const { state, effects } = reduce(s, { type: 'DEVTOOLS_CLOSED', id: wid(1) });
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)));
    assert.strictEqual(state.frontAsserted, true);
  });

  it('OS focus landing on a registered devtools window does NOT clear the assertion (Esc grab stays off)', () => {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(5), kind: 'browser', role: 'utility', class: 'devtools', satellite: true, parentId: wid(1) },
      { type: 'WINDOW_SHOWN', id: wid(5), focused: false },
    ]).state;
    const { state, effects } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(5) });
    assert.strictEqual(state.front, wid(1), 'satellite devtools never becomes front');
    assert.strictEqual(state.frontAsserted, true, 'devtools focus does not invalidate (clicking into devtools must not arm the grab)');
    assert.strictEqual(hasEffect(effects, 'RAISE_WINDOW'), false, 'and nothing yanks focus back out of devtools');
    assert.strictEqual(deriveEscGrabRegistered(snapshot(state)), false, 'Esc typed inside devtools is not grabbed');
  });

  it('a PALETTE satellite gaining focus still clears the assertion (pre-existing rule intact)', () => {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(6), kind: 'browser', role: 'palette', class: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(6), focused: false },
    ]).state;
    const { state } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(6) });
    assert.strictEqual(state.frontAsserted, false, 'non-devtools satellites keep the invalidation clause');
  });

  it('closing a registered detached devtools window refocuses its parent via the parent-refocus transition', () => {
    let s = openWindow(createInitialState(), 1, { role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(5), kind: 'browser', role: 'utility', class: 'devtools', satellite: true, parentId: wid(1) },
      { type: 'WINDOW_SHOWN', id: wid(5), focused: false },
    ]).state;
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(5) });
    assert.strictEqual(state.front, wid(1));
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === wid(1)));
  });
});

// ── §5 step 5 part A: z-order / stacking (reducer list + SET_STACKING) ───────

/** The SET_STACKING targets of a reduce, in emission order. */
function stackings(effects: Effect[]): WindowId[] {
  return effects
    .filter((e): e is Extract<Effect, { type: 'SET_STACKING' }> => e.type === 'SET_STACKING')
    .map((e) => e.id);
}

/** Register + show a window under its realistic class/satellite pairing. */
function classImportEvents(id: number, cls: WindowRecord['class'], satellite: boolean): WindowEvent[] {
  return [
    { type: 'WINDOW_REGISTERED', id: wid(id), kind: 'browser', role: 'content', class: cls, satellite },
    { type: 'WINDOW_SHOWN', id: wid(id), focused: false },
  ];
}

describe('deriveStackingLevel — single owner of stack participation (§4.3 dim 3)', () => {
  it('primary / quick-view / extension-ui participate in the ordered stack', () => {
    assert.strictEqual(deriveStackingLevel('primary', false), 'stacked');
    assert.strictEqual(deriveStackingLevel('quick-view', false), 'stacked');
    assert.strictEqual(deriveStackingLevel('extension-ui', false), 'stacked');
  });

  it('hud / overlay / palette pin ABOVE the stack (the SET_ALWAYS_ON_TOP family)', () => {
    assert.strictEqual(deriveStackingLevel('hud', true), 'pinned');
    assert.strictEqual(deriveStackingLevel('overlay', true), 'pinned');
    assert.strictEqual(deriveStackingLevel('palette', true), 'pinned');
  });

  it('the infrastructure satellite classes are excluded from the ordered stack', () => {
    assert.strictEqual(deriveStackingLevel('background', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('bridge', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('offscreen', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('test-fixture', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('devtools', true), 'excluded');
  });

  it('a satellite of a normally-stacked class (modal / focusable:false) is excluded, not stacked', () => {
    assert.strictEqual(deriveStackingLevel('primary', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('quick-view', true), 'excluded');
    assert.strictEqual(deriveStackingLevel('extension-ui', true), 'excluded');
  });
});

describe('ordered stacking list — membership across the class enum (§5 step 5)', () => {
  it('registering + showing every class admits ONLY the stacked ones, in shown order', () => {
    // Realistic (class, satellite) pairings per isSatelliteRegistration/§4.3 8b.
    const imports: [number, WindowRecord['class'], boolean][] = [
      [1, 'primary', false],
      [2, 'quick-view', false],
      [3, 'overlay', true],
      [4, 'palette', true],
      [5, 'hud', true],
      [6, 'background', true],
      [7, 'bridge', true],
      [8, 'extension-ui', false],
      [9, 'test-fixture', true],
      [10, 'devtools', true],
      [11, 'offscreen', true],
    ];
    const { state } = drive(createInitialState(), imports.flatMap(([id, cls, sat]) => classImportEvents(id, cls, sat)));
    assert.deepStrictEqual(getStackOrder(state), [wid(1), wid(2), wid(8)], 'stacked classes only, bottom→top in shown order');
  });

  it('a fresh registration is NOT in the stack until it is shown', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', class: 'primary', satellite: false },
    ]);
    assert.deepStrictEqual(getStackOrder(state), []);
  });

  it('WINDOW_HIDDEN removes; re-show returns the window at the TOP (native order-front mirror)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    s = openWindow(s, 3, { kind: 'browser', role: 'content' });
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2), wid(3)]);

    const hidden = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(2) }]).state;
    assert.deepStrictEqual(getStackOrder(hidden), [wid(1), wid(3)]);

    const reshown = drive(hidden, [{ type: 'WINDOW_SHOWN', id: wid(2), focused: false }]).state;
    assert.deepStrictEqual(getStackOrder(reshown), [wid(1), wid(3), wid(2)]);
  });

  it('closing the front removes it AND the succession assertion tops the successor (list stays consistent)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    s = openWindow(s, 3, { kind: 'browser', role: 'content' }); // front 3, MRU 3 > 2 > 1
    const { state, effects } = reduce(s, { type: 'WINDOW_CLOSED', id: wid(3) });
    assert.strictEqual(getFrontWindowId(state), wid(2), 'MRU successor');
    assert.deepStrictEqual(getStackOrder(state), [wid(1), wid(2)], 'closed window gone; successor driven to the top');
    assert.deepStrictEqual(stackings(effects), [wid(2)], 'the succession is DRIVEN as order, not just recorded');
    assert.strictEqual(state.frontAsserted, true);
  });

  it('the richer re-registration merge can demote a stacked window out of the list (modal revealed)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'utility' }); // front 2, in the stack
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2)]);
    // The ipc.ts re-registration carries the real `modal` → satellite:true.
    const { state } = reduce(s, { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'utility', satellite: true });
    assert.deepStrictEqual(getStackOrder(state), [wid(1)], 'demoted out of the ordered stack');
    assert.strictEqual(getFrontWindowId(state), wid(1), 'front handed off by the existing satellite fixup');
  });

  it('fullscreen transitions do NOT change stack membership (display mode, not a stacking removal)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    const before = getStackOrder(s);
    const script: WindowEvent[] = [
      { type: 'FULLSCREEN_REQUESTED', id: wid(2), desired: true, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(2) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(2), desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: wid(2) },
    ];
    let cur = s;
    for (const ev of script) {
      cur = drive(cur, [ev]).state;
      assert.deepStrictEqual(getStackOrder(cur), before, `membership changed across ${ev.type}`);
    }
  });
});

describe('SET_STACKING — the closing assertion drives order (frontAsserted means "on top")', () => {
  it('a MACHINE-driven front change emits SET_STACKING alongside RAISE_WINDOW and tops the list', () => {
    // Machine-driven: hiding the front hands off to the successor, which the
    // closing step must DRIVE (raise + order). An OS-driven focus change is
    // the record-not-echo case (own test below) — the OS already ordered it.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2, top
    const { state, effects } = reduce(s, { type: 'WINDOW_HIDDEN', id: wid(2) });
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.ok(raises(effects, 1), 'activation raise still emitted');
    assert.deepStrictEqual(stackings(effects), [wid(1)], 'order driven by the same closing step');
    assert.deepStrictEqual(getStackOrder(state), [wid(1)], 'front is the top of the ordered list');
    assert.strictEqual(state.frontAsserted, true);
  });

  it('an OS-driven front change tops the list WITHOUT SET_STACKING (mirror of an order the OS performed)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2, top
    const { state, effects } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(1) });
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.deepStrictEqual(stackings(effects), [], 'nothing to drive — the OS already ordered it front');
    assert.deepStrictEqual(getStackOrder(state), [wid(2), wid(1)], 'front is the top of the ordered list');
    assert.strictEqual(state.frontAsserted, true);
  });

  it('INVARIANT: frontAsserted flips true ONLY with a SET_STACKING(front) and front at the top of the list', () => {
    // A broad mixed script; at every step where the assertion flips on, the
    // machine must have DRIVEN order in the same transition.
    const script: WindowEvent[] = [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
      { type: 'APP_RESIGNED' },
      { type: 'APP_ACTIVATED' },
      { type: 'OS_FOCUS_GAINED', id: wid(1) },
      { type: 'SWITCHER_OPENED', windowId: wid(9) },
      { type: 'SWITCHER_SELECTED', id: wid(2) },
      { type: 'WINDOW_HIDDEN', id: wid(2) },
      { type: 'WINDOW_CLOSED', id: wid(1) },
    ];
    let s = createInitialState();
    for (const ev of script) {
      const r = reduce(s, ev);
      const flippedOn = !s.frontAsserted && r.state.frontAsserted;
      if (flippedOn) {
        const front = r.state.front;
        assert.ok(front != null, `asserted with no front after ${ev.type}`);
        // The OS-driven case (focus landed on front) records without driving —
        // the OS performed the order itself; every machine-driven flip DRIVES.
        const osDriven = ev.type === 'OS_FOCUS_GAINED' && ev.id === front;
        if (!osDriven) {
          assert.ok(stackings(r.effects).includes(front), `assertion flipped on without SET_STACKING(front) after ${ev.type}`);
        }
        const order = getStackOrder(r.state);
        assert.strictEqual(order[order.length - 1], front, `front not top of stackOrder after ${ev.type}`);
      }
      s = r.state;
    }
  });

  it('a deferred assertion (switcher open / satellite holds key / app inactive) emits NO SET_STACKING', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });

    // Switcher open: invalidated, deferred.
    const opened = reduce(s, { type: 'SWITCHER_OPENED', windowId: wid(9) });
    assert.strictEqual(opened.state.frontAsserted, false);
    assert.deepStrictEqual(stackings(opened.effects), [], 'no order drive while the switcher holds key');

    // Satellite steals key: invalidated, deferred.
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
    ]).state;
    const stolen = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(2) });
    assert.strictEqual(stolen.state.frontAsserted, false);
    assert.deepStrictEqual(stackings(stolen.effects), [], 'no order drive the instant a palette takes key');

    // App inactive: nothing drives.
    const resigned = drive(stolen.state, [{ type: 'APP_RESIGNED' }]).state;
    const inactive = reduce(resigned, { type: 'SESSION_CHANGED', session: 'active' });
    assert.deepStrictEqual(stackings(inactive.effects), [], 'no order drive while Peek is not the active app');
  });

  it('SWITCHER_SELECTED drives the selection to the top through the one assertion step', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2
    s = drive(s, [{ type: 'SWITCHER_OPENED', windowId: wid(9) }]).state;
    const { state, effects } = reduce(s, { type: 'SWITCHER_SELECTED', id: wid(1) });
    assert.deepStrictEqual(stackings(effects), [wid(1)], 'exactly one order drive, from the closing step');
    assert.deepStrictEqual(getStackOrder(state), [wid(2), wid(1)]);
    assert.strictEqual(state.frontAsserted, true);
  });

  it('Cmd-Tab away and back re-drives ORDER for an unchanged front (the §6 fix, order half)', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const resigned = reduce(s, { type: 'APP_RESIGNED' });
    assert.deepStrictEqual(stackings(resigned.effects), [], 'nothing driven while leaving');
    const back = reduce(resigned.state, { type: 'APP_ACTIVATED' });
    assert.deepStrictEqual(stackings(back.effects), [wid(1)], 'return re-drives order along with the raise');
  });

  it('SET_STACKING is the SOLE machine-driven ordering: any reorder not mirrored from a native show/hide/close carries it', () => {
    const script: WindowEvent[] = [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
      { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(3), focused: false },
      { type: 'OS_FOCUS_GAINED', id: wid(1) },
      { type: 'SWITCHER_OPENED', windowId: wid(9) },
      { type: 'SWITCHER_SELECTED', id: wid(2) },
      { type: 'WINDOW_HIDDEN', id: wid(2) },
      { type: 'WINDOW_CLOSED', id: wid(3) },
      { type: 'APP_RESIGNED' },
      { type: 'APP_ACTIVATED' },
    ];
    // OS_FOCUS_GAINED is a mirror too: the OS keyed + order-fronted the window
    // itself, so the list reorder has no SET_STACKING (record-not-echo).
    const NATIVE_MIRROR = new Set(['WINDOW_SHOWN', 'WINDOW_HIDDEN', 'WINDOW_CLOSED', 'OS_FOCUS_GAINED']);
    let s = createInitialState();
    for (const ev of script) {
      const r = reduce(s, ev);
      const survivors = getStackOrder(s).filter((id) => getStackOrder(r.state).includes(id));
      const nextOfSurvivors = getStackOrder(r.state).filter((id) => survivors.includes(id));
      const reordered = JSON.stringify(survivors) !== JSON.stringify(nextOfSurvivors);
      if (reordered && !NATIVE_MIRROR.has(ev.type)) {
        assert.ok(stackings(r.effects).length > 0, `machine reordered the stack after ${ev.type} without a SET_STACKING`);
      }
      s = r.state;
    }
  });
});

describe('WINDOW_CONTENT_ORDERABLE — the page-host orderability caveat (§5 step 5)', () => {
  function threeHosts(): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 3, { kind: 'page-host', role: 'content' }); // front 3
    return s;
  }

  it('a page-host registers NON-orderable; a browser window is orderable from birth', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'content', satellite: false },
    ]);
    const recs = snapshot(state).windows;
    assert.strictEqual(recs.find((r) => r.id === wid(1))?.orderable, false);
    assert.strictEqual(recs.find((r) => r.id === wid(2))?.orderable, true);
  });

  it('first composited frame re-drives SET_STACKING for the window and everything above it, bottom→top', () => {
    const s = threeHosts();
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2), wid(3)]);
    const bottom = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(1) });
    assert.deepStrictEqual(stackings(bottom.effects), [wid(1), wid(2), wid(3)], 'its earlier raises no-op’d — everything above re-stacks over it');
    const mid = reduce(bottom.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(mid.effects), [wid(2), wid(3)], 'only the suffix above the newly-orderable window');
  });

  it('a stray late re-fire is structurally inert (the legacy listener disarm, without the listener)', () => {
    const s = threeHosts();
    const first = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    const again = reduce(first.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(again.effects), [], 'no restack on a re-navigation first-frame');
  });

  it('an unknown id is a no-op', () => {
    const s = threeHosts();
    const { state, effects } = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(99) });
    assert.deepStrictEqual(stackings(effects), []);
    assert.deepStrictEqual(getStackOrder(state), getStackOrder(s));
  });

  it('a HIDDEN page-host compositing is marked orderable but re-drives nothing', () => {
    let s = threeHosts();
    s = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(2) }]).state;
    const { state, effects } = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(effects), [], 'not in the stack — nothing to re-drive');
    assert.strictEqual(snapshot(state).windows.find((r) => r.id === wid(2))?.orderable, true, 'compositing is still recorded');
  });

  it('is order-only: no RAISE_WINDOW, no FOCUS_CONTENT, front and frontAsserted untouched', () => {
    const s = threeHosts();
    const { state, effects } = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(1) });
    assert.strictEqual(hasEffect(effects, 'RAISE_WINDOW'), false, 'compositing must never activate anything');
    assert.strictEqual(hasEffect(effects, 'FOCUS_CONTENT'), false);
    assert.strictEqual(getFrontWindowId(state), getFrontWindowId(s));
    assert.strictEqual(state.frontAsserted, s.frontAsserted);
  });
});

describe('restore-shaped import — back→front yields that order, focused on top (§5 step 5)', () => {
  it('a back→front browser import lands in exactly the imported order with the focused window on top', () => {
    // The session-restore shape: every window shown WITHOUT focus in back→front
    // order, then the focused descriptor activated LAST.
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: false }, // seeds front (no front yet)
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(3), focused: false },
      { type: 'OS_FOCUS_GAINED', id: wid(3) }, // the focused descriptor, activated last
    ]);
    assert.deepStrictEqual(getStackOrder(state), [wid(1), wid(2), wid(3)], 'saved order, bottom→top');
    assert.strictEqual(getFrontWindowId(state), wid(3), 'focused on top');
    assert.strictEqual(state.frontAsserted, true);
  });

  it('page-host imports converge onto the saved order as first-frame events arrive in ANY order', () => {
    let s = createInitialState();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(3), focused: false },
      { type: 'OS_FOCUS_GAINED', id: wid(3) },
    ]).state;
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2), wid(3)]);

    // First frames land out of order: 2, then 3, then 1. Each re-drives its
    // suffix; the intended order NEVER changes, and the last arrival's
    // re-drive realizes the full saved order natively.
    const r2 = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(r2.effects), [wid(2), wid(3)]);
    const r3 = reduce(r2.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(3) });
    assert.deepStrictEqual(stackings(r3.effects), [wid(3)]);
    const r1 = reduce(r3.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(1) });
    assert.deepStrictEqual(stackings(r1.effects), [wid(1), wid(2), wid(3)], 'the final arrival replays the whole order above it');

    assert.deepStrictEqual(getStackOrder(r1.state), [wid(1), wid(2), wid(3)], 'intent stable throughout');
    assert.strictEqual(getFrontWindowId(r1.state), wid(3));
    for (const rec of snapshot(r1.state).windows) assert.strictEqual(rec.orderable, true);
  });
});

describe('STACK_ORDER_IMPORTED — the session-restore order import (§5 step 5 part B)', () => {
  /** The live restore shape: loop shows FRONT→BACK (focused head start first). */
  function restoreShapedState(): AppWindowState {
    return drive(createInitialState(), [
      // Focused descriptor dispatched first (head start), then zOrder desc.
      { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(3), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: false },
    ]).state;
  }

  it('a front→back restore loop leaves the list INVERTED; the import lands the saved order and drives all of it', () => {
    const s = restoreShapedState();
    assert.deepStrictEqual(getStackOrder(s), [wid(3), wid(2), wid(1)], 'show order alone is the inverse of the saved order');
    const { state, effects } = reduce(s, { type: 'STACK_ORDER_IMPORTED', order: [wid(1), wid(2), wid(3)] });
    assert.deepStrictEqual(getStackOrder(state), [wid(1), wid(2), wid(3)], 'saved order, bottom→top, focused on top');
    assert.deepStrictEqual(stackings(effects), [wid(1), wid(2), wid(3)], 'whole order driven bottom→top');
  });

  it('unknown / hidden / non-member ids are dropped; duplicates deduped', () => {
    let s = restoreShapedState();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(6), kind: 'browser', role: 'background', class: 'background', satellite: true },
      { type: 'WINDOW_SHOWN', id: wid(6), focused: false }, // excluded class — never a member
      { type: 'WINDOW_HIDDEN', id: wid(2) },
    ]).state;
    const { state } = reduce(s, {
      type: 'STACK_ORDER_IMPORTED',
      order: [wid(99), wid(1), wid(6), wid(2), wid(1), wid(3)],
    });
    assert.deepStrictEqual(getStackOrder(state), [wid(1), wid(3)], 'only live stacked members survive the import, once each');
    assert.ok(stackOrderInvariantHolds(state));
  });

  it('members the import does not name keep their relative order BELOW the imported set (and are driven too)', () => {
    let s = restoreShapedState(); // [3, 2, 1]
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(4), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(4), focused: false },
      { type: 'WINDOW_REGISTERED', id: wid(5), kind: 'browser', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(5), focused: false },
    ]).state; // [3, 2, 1, 4, 5]
    const { state, effects } = reduce(s, { type: 'STACK_ORDER_IMPORTED', order: [wid(1), wid(2)] });
    assert.deepStrictEqual(getStackOrder(state), [wid(3), wid(4), wid(5), wid(1), wid(2)], 'unnamed keep order, below the import');
    assert.deepStrictEqual(stackings(effects), [wid(3), wid(4), wid(5), wid(1), wid(2)], 'the entire resulting order is realized');
  });

  it('an import naming no current member is a structural no-op', () => {
    const s = restoreShapedState();
    for (const order of [[], [wid(99)]] as WindowId[][]) {
      const { state, effects } = reduce(s, { type: 'STACK_ORDER_IMPORTED', order });
      assert.deepStrictEqual(getStackOrder(state), getStackOrder(s));
      assert.deepStrictEqual(stackings(effects), []);
    }
  });

  it('is order-only: no RAISE_WINDOW, no FOCUS_CONTENT; front and a held assertion untouched', () => {
    let s = restoreShapedState();
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]).state; // asserts front 1
    assert.strictEqual(s.frontAsserted, true);
    const { state, effects } = reduce(s, { type: 'STACK_ORDER_IMPORTED', order: [wid(2), wid(3), wid(1)] });
    assert.strictEqual(hasEffect(effects, 'RAISE_WINDOW'), false, 'an order import must never activate anything');
    assert.strictEqual(hasEffect(effects, 'FOCUS_CONTENT'), false);
    assert.strictEqual(getFrontWindowId(state), wid(1));
    assert.strictEqual(state.frontAsserted, true);
  });

  it('page-host first frames AFTER the import re-drive their suffix of the IMPORTED order', () => {
    const s = restoreShapedState(); // 3 and 2 are page-hosts (non-orderable), 1 is a browser
    const imported = reduce(s, { type: 'STACK_ORDER_IMPORTED', order: [wid(1), wid(2), wid(3)] }).state;
    const r2 = reduce(imported, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(r2.effects), [wid(2), wid(3)], 'suffix of the imported order, not the show order');
    const r3 = reduce(r2.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(3) });
    assert.deepStrictEqual(stackings(r3.effects), [wid(3)]);
    assert.deepStrictEqual(getStackOrder(r3.state), [wid(1), wid(2), wid(3)], 'intent stable throughout');
  });

  it('LIVE-RUN REPLAY: late already-visible show mirrors must not scramble the imported order (every native show is emitted twice)', () => {
    // Observed live (clone cold restore, 2026-07-22): the restore loop's
    // synchronous show-seam dispatches land DURING the loop, but the backend's
    // async native-'show' mirrors for the hybrid page-hosts landed AFTER the
    // post-loop STACK_ORDER_IMPORTED — re-raising each page in show order and
    // scrambling the machine list; the first-frame re-drives then realized the
    // scrambled order on the real screen (pages restored REVERSED). The rule:
    // a WINDOW_SHOWN for an already-visible record reorders NOTHING.
    let s = restoreShapedState(); // shows P-hosts 3, 2 then browser 1 (front→back loop order)
    s = drive(s, [{ type: 'STACK_ORDER_IMPORTED', order: [wid(1), wid(2), wid(3)] }]).state;
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2), wid(3)]);

    // The late duplicate mirrors, in original show order.
    s = drive(s, [
      { type: 'WINDOW_SHOWN', id: wid(3), focused: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: false },
    ]).state;
    assert.deepStrictEqual(getStackOrder(s), [wid(1), wid(2), wid(3)], 'imported order survives the duplicate mirrors');

    // First frames then re-drive suffixes of the IMPORTED order, not show order.
    const r2 = reduce(s, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(2) });
    assert.deepStrictEqual(stackings(r2.effects), [wid(2), wid(3)]);
    const r3 = reduce(r2.state, { type: 'WINDOW_CONTENT_ORDERABLE', id: wid(3) });
    assert.deepStrictEqual(stackings(r3.effects), [wid(3)]);
    assert.deepStrictEqual(getStackOrder(r3.state), [wid(1), wid(2), wid(3)]);
  });

  it('a hidden→visible re-show still returns the window at the top (only ALREADY-visible shows are inert)', () => {
    let s = restoreShapedState(); // [3, 2, 1], front 3 (seeded by first show)
    s = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(2) }]).state; // non-front: [3, 1], no succession
    const reshown = drive(s, [{ type: 'WINDOW_SHOWN', id: wid(2), focused: false }]).state;
    assert.deepStrictEqual(getStackOrder(reshown), [wid(3), wid(1), wid(2)], 'a real hidden→visible show is a native order-front and mirrors on top');
  });

  it('purity: the input state and its stackOrder are untouched by an import', () => {
    const s = restoreShapedState();
    const before = [...s.stackOrder];
    const { state } = reduce(s, { type: 'STACK_ORDER_IMPORTED', order: [wid(1), wid(2), wid(3)] });
    assert.deepStrictEqual(s.stackOrder, before, 'input array unchanged');
    assert.notStrictEqual(state.stackOrder, s.stackOrder, 'result holds a fresh array');
  });
});

describe('stacking purity — reduce never mutates the input stackOrder', () => {
  it('a reordering event leaves the input list untouched', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // [1, 2]
    const before = [...s.stackOrder];
    const { state } = reduce(s, { type: 'OS_FOCUS_GAINED', id: wid(1) }); // reorders to [2, 1]
    assert.deepStrictEqual(getStackOrder(state), [wid(2), wid(1)]);
    assert.deepStrictEqual(s.stackOrder, before, 'input array unchanged');
    assert.notStrictEqual(state.stackOrder, s.stackOrder, 'result holds a fresh array, not the input reference');
  });
});

// ── Geometry: bounds mirror + maximize transitions (§4.2 dim 2, §5 step 7A) ──

describe('BOUNDS_CHANGED — the sole writer of the bounds mirror (§5 step 7A)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const RECT_B: Rectangle = { x: 5, y: 6, width: 700, height: 500 };

  it('writes the record bounds; repeated reports last-write-win', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(s.windows.get(wid(1))!.bounds, undefined, 'no bounds until the first native report');
    const r1 = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A }]);
    assert.deepStrictEqual(r1.state.windows.get(wid(1))!.bounds, RECT_A);
    const r2 = drive(r1.state, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_B }]);
    assert.deepStrictEqual(r2.state.windows.get(wid(1))!.bounds, RECT_B);
  });

  it('is a pure mirror: no effects, and a held front assertion survives', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(s.frontAsserted, true, 'precondition: assertion held');
    const { state, effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A }]);
    assert.deepStrictEqual(effects, [], 'a resize/move echo drives nothing back at the OS');
    assert.strictEqual(state.frontAsserted, true, 'a bounds report never invalidates the assertion');
    assert.strictEqual(state.front, wid(1));
  });

  it('is a no-op for an unregistered window', () => {
    const s = createInitialState();
    const { state, effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(99), bounds: RECT_A }]);
    assert.deepStrictEqual(effects, []);
    assert.strictEqual(state.windows.size, 0);
  });

  it('mirrors honestly during fullscreen too (the restorable rect lives in fsMode.preBounds, not here)', () => {
    const FS_RECT: Rectangle = { x: 0, y: 0, width: 3024, height: 1964 };
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { state } = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: FS_RECT },
    ]);
    assert.deepStrictEqual(state.windows.get(wid(1))!.bounds, FS_RECT, 'bounds mirrors native reality');
    assert.deepStrictEqual(getWindowPreBounds(state, wid(1)), RECT_A, 'the restorable rect is the fsMode stash');
  });

  it('does NOT clear maximized (our own SET_BOUNDS echo must not self-unmaximize)', () => {
    const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { state } = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      // The backend echoes the snap we just drove:
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: WORK },
    ]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A);
    assert.deepStrictEqual(rec.bounds, WORK);
  });
});

describe('SET_BOUNDS_REQUESTED — the plain geometry-write intent (§5 step 7E)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const RECT_B: Rectangle = { x: 5, y: 6, width: 700, height: 500 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  function setBoundsEffects(effects: Effect[]): Extract<Effect, { type: 'SET_BOUNDS' }>[] {
    return effects.filter((e): e is Extract<Effect, { type: 'SET_BOUNDS' }> => e.type === 'SET_BOUNDS');
  }

  it('drives SET_BOUNDS with the requested rect', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { effects } = drive(s, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_A }]);
    assert.deepStrictEqual(setBoundsEffects(effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_A }]);
  });

  it('does NOT write the bounds mirror — only the BOUNDS_CHANGED echo does (§5 step 7A)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_B },
    ]);
    assert.deepStrictEqual(r1.state.windows.get(wid(1))!.bounds, RECT_A, 'mirror untouched until the echo');
    const r2 = drive(r1.state, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_B }]);
    assert.deepStrictEqual(r2.state.windows.get(wid(1))!.bounds, RECT_B, 'echo is the sole mirror writer');
  });

  it('is a no-op for an unregistered window', () => {
    const s = createInitialState();
    const { effects } = drive(s, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(99), bounds: RECT_A }]);
    assert.deepStrictEqual(setBoundsEffects(effects), []);
  });

  it('is dropped while ANY non-normal fsMode (fullscreen owns the display — the aa34cb50 family)', () => {
    for (const [enterEvents, label] of [
      [[{ type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A }], 'entering-fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      ], 'fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      ], 'leaving-fullscreen'],
    ] as [WindowEvent[], string][]) {
      let s = createInitialState();
      s = openWindow(s, 1, { kind: 'browser', role: 'content' });
      const r1 = drive(s, enterEvents);
      const r2 = drive(r1.state, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_B }]);
      assert.deepStrictEqual(setBoundsEffects(r2.effects), [], `dropped during ${label}`);
    }
  });

  it('leaves maximize state alone: flag + stash survive a plain write (invalidation stays MAXIMIZE_EXITED_BY_RESIZE)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
    ]);
    const r2 = drive(r1.state, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_B }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true, 'plain write never exits maximize');
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A, 'stash untouched');
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_B }], 'the write itself still drives');
  });

  it('is pure geometry: no front/assertion/stacking change', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(s.frontAsserted, true, 'precondition: assertion held');
    const { state, effects } = drive(s, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_A }]);
    assert.strictEqual(state.front, wid(1));
    assert.strictEqual(state.frontAsserted, true);
    assert.deepStrictEqual(effects.map((e) => e.type), ['SET_BOUNDS'], 'no raise/stacking/focus rides along');
  });
});

describe('maximize / unmaximize — machine transitions, never an isMaximized() question (§5 step 7A)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  function setBoundsEffects(effects: Effect[]): Extract<Effect, { type: 'SET_BOUNDS' }>[] {
    return effects.filter((e): e is Extract<Effect, { type: 'SET_BOUNDS' }> => e.type === 'SET_BOUNDS');
  }

  it('registration starts unmaximized with no stash', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const rec = s.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, false);
    assert.strictEqual(rec.preMaxBounds, null);
  });

  it('maximize stashes the reported bounds, flips the flag, and drives SET_BOUNDS(workArea)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { state, effects } = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
    ]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A);
    assert.deepStrictEqual(setBoundsEffects(effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: WORK }]);
  });

  it('maximize with no reported bounds stashes null ("no stash was possible", the FsMode.preBounds twin)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { state, effects } = drive(s, [{ type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK }]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.strictEqual(rec.preMaxBounds, null);
    assert.deepStrictEqual(setBoundsEffects(effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: WORK }]);
  });

  it('re-maximize re-snaps but NEVER overwrites the stash (the stale-snapshot unmaximize-no-op trap)', () => {
    const SHRUNK: Rectangle = { x: 50, y: 50, width: 300, height: 200 };
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      // The user resized the maximized window smaller; the mirror tracked it:
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: SHRUNK },
    ]);
    const r2 = drive(r1.state, [{ type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A, 'the original pre-max rect survives a re-maximize');
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: WORK }], 're-snap is re-driven');
  });

  it('unmaximize restores the stash: flag off, stash cleared, SET_BOUNDS(preMaxBounds)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: WORK }, // the snap echo
    ]);
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, false);
    assert.strictEqual(rec.preMaxBounds, null);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_A }], 'round-trips the pre-max rect');
  });

  it('unmaximize when not maximized is a no-op (trusted flag — no distrust dance)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { state, effects } = drive(s, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    assert.strictEqual(state.windows.get(wid(1))!.maximized, false);
    assert.deepStrictEqual(setBoundsEffects(effects), []);
  });

  it('unmaximize with a null stash clears the flag and restores nothing', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [{ type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK }]); // no bounds ever reported
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, false);
    assert.strictEqual(rec.preMaxBounds, null);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [], 'nowhere to restore to');
  });

  it('maximize/unmaximize target unknown windows as no-ops', () => {
    const s = createInitialState();
    const r1 = drive(s, [{ type: 'MAXIMIZE_REQUESTED', id: wid(99), workArea: WORK }]);
    assert.deepStrictEqual(setBoundsEffects(r1.effects), []);
    const r2 = drive(s, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(99) }]);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), []);
  });

  it('maximize while ANY non-normal fsMode is a no-op (fullscreen owns the display)', () => {
    for (const [enterEvents, label] of [
      [[{ type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A }], 'entering-fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      ], 'fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      ], 'leaving-fullscreen'],
    ] as [WindowEvent[], string][]) {
      let s = createInitialState();
      s = openWindow(s, 1, { kind: 'browser', role: 'content' });
      const r1 = drive(s, enterEvents);
      const r2 = drive(r1.state, [{ type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK }]);
      const rec = r2.state.windows.get(wid(1))!;
      assert.strictEqual(rec.maximized, false, `${label}: flag untouched`);
      assert.strictEqual(rec.preMaxBounds, null, `${label}: no stash recorded`);
      assert.deepStrictEqual(setBoundsEffects(r2.effects), [], `${label}: no SET_BOUNDS`);
    }
  });

  it('a maximized flag survives a fullscreen round trip; unmaximize afterwards still restores', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: WORK },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: WORK },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: wid(1) },
    ]);
    assert.strictEqual(r1.state.windows.get(wid(1))!.maximized, true, 'fullscreen is a display mode, not an unmaximize');
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    assert.strictEqual(r2.state.windows.get(wid(1))!.maximized, false);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_A }]);
  });

  it('the richer re-registration merge preserves bounds + maximize state (lived state, never reset)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
    ]);
    const rec = r1.state.windows.get(wid(1))!;
    assert.deepStrictEqual(rec.bounds, RECT_A);
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A);
  });

  it('reduce purity: the input record is untouched by a maximize', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A }]);
    const before = r1.state.windows.get(wid(1))!;
    reduce(r1.state, { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK });
    assert.strictEqual(before.maximized, false, 'input record not mutated');
    assert.strictEqual(before.preMaxBounds, null);
  });
});

// ── §5 step 7B: registration bounds seed + construction restore + gesture exit ──

describe('WINDOW_REGISTERED bounds seed (§5 step 7B)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const RECT_B: Rectangle = { x: 5, y: 6, width: 700, height: 500 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  it('a registration carrying bounds seeds the mirror', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false, bounds: RECT_A },
    ]);
    assert.deepStrictEqual(state.windows.get(wid(1))!.bounds, RECT_A);
  });

  it('a registration without bounds leaves the mirror absent (pre-seed behavior unchanged)', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
    ]);
    assert.strictEqual(state.windows.get(wid(1))!.bounds, undefined);
  });

  it('a re-registration NEVER overwrites a lived mirror (BOUNDS_CHANGED reports are fresher)', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false, bounds: RECT_A },
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_B },
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false, bounds: RECT_A },
    ]);
    assert.deepStrictEqual(state.windows.get(wid(1))!.bounds, RECT_B);
  });

  it('a re-registration fills an ABSENT mirror', () => {
    const { state } = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false, bounds: RECT_A },
    ]);
    assert.deepStrictEqual(state.windows.get(wid(1))!.bounds, RECT_A);
  });

  it('the seed is what a fresh, never-resized window stashes on its first maximize', () => {
    // The reason the seed exists: a ctor-placed window fires no native
    // resize/move, so without the seed the first MAXIMIZE_REQUESTED would
    // stash null and the following unmaximize would restore nothing.
    let s = createInitialState();
    const r1 = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false, bounds: RECT_A },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
    ]);
    assert.deepStrictEqual(r1.state.windows.get(wid(1))!.preMaxBounds, RECT_A);
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    assert.deepStrictEqual(
      r2.effects.filter((e) => e.type === 'SET_BOUNDS'),
      [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_A }],
      'unmaximize round-trips the registration rect',
    );
  });
});

describe('MAXIMIZE_RESTORED — construction-time maximize restore (§5 step 7B)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  function setBoundsEffects(effects: Effect[]): Extract<Effect, { type: 'SET_BOUNDS' }>[] {
    return effects.filter((e): e is Extract<Effect, { type: 'SET_BOUNDS' }> => e.type === 'SET_BOUNDS');
  }

  it('seeds maximized + the SAVED pre-max rect, and drives NO bounds effect', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const { state, effects } = drive(s, [{ type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: RECT_A }]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A);
    assert.deepStrictEqual(setBoundsEffects(effects), [], 'the window was BUILT at the maximized rect — nothing to resize');
  });

  it('a null saved rect restores maximized with no stash ("no stash was possible")', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const { state } = drive(s, [{ type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: null }]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.strictEqual(rec.preMaxBounds, null);
  });

  it('a later unmaximize restores the SAVED rect, not the machine bounds mirror', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const r1 = drive(s, [
      // The mirror holds the CREATION bounds — the maximized rect.
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: WORK },
      { type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: RECT_A },
    ]);
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_A }]);
    assert.strictEqual(r2.state.windows.get(wid(1))!.maximized, false);
  });

  it('is a no-op for an unknown window', () => {
    const { state, effects } = drive(createInitialState(), [
      { type: 'MAXIMIZE_RESTORED', id: wid(99), preMaxBounds: RECT_A },
    ]);
    assert.strictEqual(state.windows.size, 0);
    assert.deepStrictEqual(effects, []);
  });

  it('is a no-op while fsMode is non-normal (fullscreen owns the display — aa34cb50 guard)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const r1 = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]);
    const r2 = drive(r1.state, [{ type: 'MAXIMIZE_RESTORED', id: wid(1), preMaxBounds: RECT_A }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, false);
    assert.strictEqual(rec.preMaxBounds, null);
  });
});

describe('MAXIMIZE_EXITED_BY_RESIZE — a resize gesture exits maximize at press (§5 step 7B)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const SHRUNK: Rectangle = { x: 0, y: 25, width: 1272, height: 740 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  function setBoundsEffects(effects: Effect[]): Extract<Effect, { type: 'SET_BOUNDS' }>[] {
    return effects.filter((e): e is Extract<Effect, { type: 'SET_BOUNDS' }> => e.type === 'SET_BOUNDS');
  }

  function maximized(): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    return drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: WORK }, // the snap echo
    ]).state;
  }

  it('clears the flag AND the stash, and drives NOTHING back at the OS', () => {
    const s = maximized();
    const { state, effects } = drive(s, [{ type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) }]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, false);
    assert.strictEqual(rec.preMaxBounds, null, 'a surviving stash IS the stale-restore de-sync');
    assert.deepStrictEqual(effects, [], 'the gesture owns the bounds — no SET_BOUNDS, no anything');
  });

  it('is a no-op when not maximized (a plain resize press must not disturb anything)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    const { state, effects } = drive(s, [{ type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) }]);
    assert.strictEqual(state.windows.get(wid(1))!.maximized, false);
    assert.deepStrictEqual(effects, []);
  });

  it('is a no-op for an unknown window', () => {
    const { effects } = drive(createInitialState(), [{ type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(99) }]);
    assert.deepStrictEqual(effects, []);
  });

  it('the NEXT maximize stashes the post-gesture rect, not the pre-gesture one (stale-stash regression)', () => {
    const s = maximized();
    const { state } = drive(s, [
      { type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) },
      // The gesture's own bounds stream lands as native reports:
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: SHRUNK },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
    ]);
    const rec = state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true);
    assert.deepStrictEqual(rec.preMaxBounds, SHRUNK, 'unmaximize returns to where the user left the window');
  });

  it('after the exit, an UNMAXIMIZE_REQUESTED is a no-op (flag already false, nothing snaps back)', () => {
    const s = maximized();
    const r1 = drive(s, [{ type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) }]);
    const r2 = drive(r1.state, [{ type: 'UNMAXIMIZE_REQUESTED', id: wid(1) }]);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [], 'no stale rect to jump to');
  });

  it('reduce purity: the input record is untouched by the exit', () => {
    const s = maximized();
    const before = s.windows.get(wid(1))!;
    reduce(s, { type: 'MAXIMIZE_EXITED_BY_RESIZE', id: wid(1) });
    assert.strictEqual(before.maximized, true, 'input record not mutated');
    assert.deepStrictEqual(before.preMaxBounds, RECT_A);
  });
});

describe('DISPLAY_CHANGED — the display-layout reprojection (§4.2 dim 7, §5 step 10)', () => {
  const RECT_A: Rectangle = { x: 100, y: 120, width: 640, height: 480 };
  const RECT_B: Rectangle = { x: 5, y: 6, width: 700, height: 500 };
  const PROJ_1: Rectangle = { x: 1920, y: 0, width: 640, height: 480 };
  const PROJ_2: Rectangle = { x: 1920, y: 500, width: 700, height: 500 };
  const WORK: Rectangle = { x: 0, y: 25, width: 1512, height: 920 };

  function setBoundsEffects(effects: Effect[]): Extract<Effect, { type: 'SET_BOUNDS' }>[] {
    return effects.filter((e): e is Extract<Effect, { type: 'SET_BOUNDS' }> => e.type === 'SET_BOUNDS');
  }

  it('drives one SET_BOUNDS per projected window, in the order given', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    const { effects } = drive(s, [
      { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }, { id: wid(2), bounds: PROJ_2 }] },
    ]);
    assert.deepStrictEqual(setBoundsEffects(effects), [
      { type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_1 },
      { type: 'SET_BOUNDS', id: wid(2), bounds: PROJ_2 },
    ]);
  });

  it('an empty projection list drives nothing (the "no window moved" layout change)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { effects } = drive(s, [{ type: 'DISPLAY_CHANGED', projected: [] }]);
    assert.deepStrictEqual(setBoundsEffects(effects), []);
  });

  it('drops an unregistered window without dropping the rest of the list', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { effects } = drive(s, [
      { type: 'DISPLAY_CHANGED', projected: [{ id: wid(99), bounds: PROJ_1 }, { id: wid(1), bounds: PROJ_2 }] },
    ]);
    assert.deepStrictEqual(setBoundsEffects(effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_2 }]);
  });

  it('drops a window the machine believes is hidden (the watcher isVisible() filter, from state)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const hidden = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    assert.strictEqual(hidden.state.windows.get(wid(1))!.visible, false, 'precondition: hidden');
    const { effects } = drive(hidden.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.deepStrictEqual(setBoundsEffects(effects), []);
  });

  it('drops a registered-but-never-shown window (visible:false from birth)', () => {
    const s = createInitialState();
    const { state, effects } = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
      { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] },
    ]);
    assert.strictEqual(state.windows.get(wid(1))!.visible, false);
    assert.deepStrictEqual(setBoundsEffects(effects), []);
  });

  it('is dropped while ANY non-normal fsMode (fullscreen owns the display — the aa34cb50 family)', () => {
    for (const [enterEvents, label] of [
      [[{ type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A }], 'entering-fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      ], 'fullscreen'],
      [[
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
        { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
        { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      ], 'leaving-fullscreen'],
    ] as [WindowEvent[], string][]) {
      let s = createInitialState();
      s = openWindow(s, 1, { kind: 'browser', role: 'content' });
      const r1 = drive(s, enterEvents);
      const r2 = drive(r1.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
      assert.deepStrictEqual(setBoundsEffects(r2.effects), [], `dropped during ${label}`);
    }
  });

  it('a fullscreen window is skipped while its normal sibling still reprojects', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]);
    const r2 = drive(r1.state, [
      { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }, { id: wid(2), bounds: PROJ_2 }] },
    ]);
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(2), bounds: PROJ_2 }]);
  });

  it('does NOT write the bounds mirror — only the BOUNDS_CHANGED echo does', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] },
    ]);
    assert.deepStrictEqual(r1.state.windows.get(wid(1))!.bounds, RECT_A, 'mirror untouched until the echo');
    const r2 = drive(r1.state, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: PROJ_1 }]);
    assert.deepStrictEqual(r2.state.windows.get(wid(1))!.bounds, PROJ_1);
  });

  it('leaves maximize state alone: a reprojection is not a resize gesture', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [
      { type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_A },
      { type: 'MAXIMIZE_REQUESTED', id: wid(1), workArea: WORK },
    ]);
    const r2 = drive(r1.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    const rec = r2.state.windows.get(wid(1))!;
    assert.strictEqual(rec.maximized, true, 'still maximized — on the new display');
    assert.deepStrictEqual(rec.preMaxBounds, RECT_A, 'stash untouched');
    assert.deepStrictEqual(setBoundsEffects(r2.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_1 }]);
  });

  it('is pure geometry: no front/assertion/stacking change', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(s.frontAsserted, true, 'precondition: assertion held');
    const { state, effects } = drive(s, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.strictEqual(state.front, wid(1));
    assert.strictEqual(state.frontAsserted, true);
    assert.deepStrictEqual(state.stackOrder, [wid(1)]);
    assert.deepStrictEqual(effects.map((e) => e.type), ['SET_BOUNDS'], 'no raise/stacking/focus rides along');
  });

  it('reduce purity: the input record is untouched', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const withBounds = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: RECT_B }]);
    const before = withBounds.state.windows.get(wid(1))!;
    reduce(withBounds.state, { type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] });
    assert.deepStrictEqual(before.bounds, RECT_B, 'input record not mutated');
  });

  // ── deferred projection (fullscreen/hidden hold, flushed on unblock) ───────

  it('a display change during fullscreen is DEFERRED, then flushed once fullscreen actually exits', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const fs = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]);
    const deferred = drive(fs.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.deepStrictEqual(setBoundsEffects(deferred.effects), [], 'held, not dropped, while fullscreen');
    assert.deepStrictEqual(deferred.state.windows.get(wid(1))!.pendingProjectedBounds, PROJ_1);
    const left = drive(deferred.state, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: wid(1) },
    ]);
    assert.deepStrictEqual(setBoundsEffects(left.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_1 }]);
    assert.strictEqual(left.state.windows.get(wid(1))!.pendingProjectedBounds, null, 'flushed and cleared');
  });

  it('a display change while hidden is DEFERRED, then flushed once the window is shown', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const hidden = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    const deferred = drive(hidden.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.deepStrictEqual(setBoundsEffects(deferred.effects), [], 'held, not dropped, while hidden');
    const shown = drive(deferred.state, [{ type: 'WINDOW_SHOWN', id: wid(1), focused: true }]);
    assert.deepStrictEqual(setBoundsEffects(shown.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_1 }]);
    assert.strictEqual(shown.state.windows.get(wid(1))!.pendingProjectedBounds, null, 'flushed and cleared');
  });

  it('becoming visible while STILL fullscreen does not flush — it stays held on the other axis', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const fs = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: wid(1), desired: true, bounds: RECT_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
    ]);
    const hidden = drive(fs.state, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    const deferred = drive(hidden.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    const shown = drive(deferred.state, [{ type: 'WINDOW_SHOWN', id: wid(1), focused: true }]);
    assert.deepStrictEqual(setBoundsEffects(shown.effects), [], 'still fullscreen — held, not flushed');
    assert.deepStrictEqual(shown.state.windows.get(wid(1))!.pendingProjectedBounds, PROJ_1, 'projection still held');
  });

  it('two DISPLAY_CHANGED while blocked hold only the LATEST projection', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const hidden = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    const first = drive(hidden.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.deepStrictEqual(first.state.windows.get(wid(1))!.pendingProjectedBounds, PROJ_1);
    const second = drive(first.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_2 }] }]);
    assert.deepStrictEqual(second.state.windows.get(wid(1))!.pendingProjectedBounds, PROJ_2, 'overwritten by the later projection');
    const shown = drive(second.state, [{ type: 'WINDOW_SHOWN', id: wid(1), focused: true }]);
    assert.deepStrictEqual(setBoundsEffects(shown.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: PROJ_2 }], 'only the latest rect is emitted');
  });

  it('an explicit SET_BOUNDS_REQUESTED while holding clears the pending projection (no later snap-back)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const hidden = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    const deferred = drive(hidden.state, [{ type: 'DISPLAY_CHANGED', projected: [{ id: wid(1), bounds: PROJ_1 }] }]);
    assert.deepStrictEqual(deferred.state.windows.get(wid(1))!.pendingProjectedBounds, PROJ_1);
    const moved = drive(deferred.state, [{ type: 'SET_BOUNDS_REQUESTED', id: wid(1), bounds: RECT_B }]);
    assert.deepStrictEqual(setBoundsEffects(moved.effects), [{ type: 'SET_BOUNDS', id: wid(1), bounds: RECT_B }]);
    assert.strictEqual(moved.state.windows.get(wid(1))!.pendingProjectedBounds, null, 'discarded, not merely overridden');
    const shown = drive(moved.state, [{ type: 'WINDOW_SHOWN', id: wid(1), focused: true }]);
    assert.deepStrictEqual(setBoundsEffects(shown.effects), [], 'no stale projection snaps the window back on show');
  });
});

describe('visibleOnAllSpaces — the macOS Spaces field (§4.2 dim 7b, §5 step 10)', () => {
  it('a fresh window is on ONE space (the platform default)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(s.windows.get(wid(1))!.visibleOnAllSpaces, false);
  });

  it('records the declared intent, both directions', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    assert.strictEqual(r1.state.windows.get(wid(1))!.visibleOnAllSpaces, true);
    const r2 = drive(r1.state, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: false }]);
    assert.strictEqual(r2.state.windows.get(wid(1))!.visibleOnAllSpaces, false);
  });

  it('drives NO effect — the port has no Spaces command yet (machinery only)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const { effects } = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    assert.deepStrictEqual(effects, []);
  });

  it('re-asserting the value it already holds is inert', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    const r2 = drive(r1.state, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    assert.strictEqual(r2.state.windows.get(wid(1))!.visibleOnAllSpaces, true);
    assert.deepStrictEqual(r2.effects, []);
  });

  it('is per window: pinning one leaves its sibling alone', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    const { state } = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    assert.strictEqual(state.windows.get(wid(1))!.visibleOnAllSpaces, true);
    assert.strictEqual(state.windows.get(wid(2))!.visibleOnAllSpaces, false);
  });

  it('is a no-op for an unregistered window', () => {
    const s = createInitialState();
    const { state, effects } = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(99), on: true }]);
    assert.deepStrictEqual(effects, []);
    assert.strictEqual(state.windows.size, 0);
  });

  it('survives a re-registration merge (a LIVED field, like the bounds mirror)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const r1 = drive(s, [{ type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true }]);
    const r2 = drive(r1.state, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'content', satellite: false },
    ]);
    assert.strictEqual(r2.state.windows.get(wid(1))!.visibleOnAllSpaces, true);
  });

  it('reduce purity: the input record is untouched', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    const before = s.windows.get(wid(1))!;
    reduce(s, { type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED', id: wid(1), on: true });
    assert.strictEqual(before.visibleOnAllSpaces, false, 'input record not mutated');
  });
});

// ── §5 step 9: overlay attachment (§4.3 dim 3b) ──────────────────────────────

/** Effects of one type, in emission order. */
function effectsOfType<T extends Effect['type']>(effects: Effect[], type: T): Extract<Effect, { type: T }>[] {
  return effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
}

/** Effect types in emission order — the follow's ORDER is part of the port. */
function effectShape(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

describe('overlay attachment / follow / retarget (§4.3 dim 3b, §5 step 9)', () => {
  const HOST_A: Rectangle = { x: 300, y: 200, width: 900, height: 700 };
  const HOST_B: Rectangle = { x: 40, y: 60, width: 500, height: 400 };
  // The frames the DISPATCH SITE computes (host rect + gutters, work-area
  // clamped) — the reducer never derives these, it only routes them.
  const FRAME_A: Rectangle = { x: 82, y: 156, width: 1336, height: 752 };
  const FRAME_B: Rectangle = { x: 0, y: 25, width: 936, height: 452 };

  const OVERLAY = 9;

  /** A registered chrome overlay that is NOT on screen yet. */
  function registerOverlay(state: AppWindowState): AppWindowState {
    return drive(state, [
      { type: 'WINDOW_REGISTERED', id: wid(OVERLAY), kind: 'browser', role: 'overlay', class: 'overlay', satellite: true },
    ]).state;
  }

  /** The overlay, on screen (its native `shown` echo has landed). */
  function showOverlay(state: AppWindowState): AppWindowState {
    return drive(state, [{ type: 'WINDOW_SHOWN', id: wid(OVERLAY), focused: false }]).state;
  }

  /** A page-host + a registered overlay; nothing attached yet. */
  function hostAndOverlay(): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_A }]).state;
    return registerOverlay(s);
  }

  it('attach: sets the relation and drives bounds -> stacking -> show, in that order', () => {
    const s = hostAndOverlay();
    const { state, effects } = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
    ]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), wid(1));
    assert.strictEqual(overlayIdForHost(state, wid(1)), wid(OVERLAY));
    assert.deepStrictEqual(effectShape(effects), ['SET_BOUNDS', 'SET_STACKING', 'SHOW_WINDOW']);
    assert.deepStrictEqual(effectsOfType(effects, 'SET_BOUNDS')[0], { type: 'SET_BOUNDS', id: wid(OVERLAY), bounds: FRAME_A });
    assert.deepStrictEqual(effectsOfType(effects, 'SHOW_WINDOW')[0], { type: 'SHOW_WINDOW', id: wid(OVERLAY), activate: false });
    // The chrome overlay is `pinned` — the payload must carry that level so the
    // executor realizes it as `setAlwaysOnTop(true, 'floating')`, never a plain
    // `moveTop()` (the latent moveTop bug this level field exists to prevent).
    assert.strictEqual(effectsOfType(effects, 'SET_STACKING')[0].level, 'pinned');
  });

  it('attach does NOT write `visible` — that rides the backend `shown` echo', () => {
    const s = hostAndOverlay();
    const { state } = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
    ]);
    assert.strictEqual(state.windows.get(wid(OVERLAY))!.visible, false);
    const shown = drive(state, [{ type: 'WINDOW_SHOWN', id: wid(OVERLAY), focused: false }]).state;
    assert.strictEqual(shown.windows.get(wid(OVERLAY))!.visible, true);
  });

  it('an already-visible overlay is re-framed but never re-shown', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    const { effects } = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
    ]);
    assert.deepStrictEqual(effectShape(effects), ['SET_BOUNDS', 'SET_STACKING']);
  });

  it('retarget: the relation MOVES to the new host and follows it (no detach flicker)', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
      { type: 'BOUNDS_CHANGED', id: wid(2), bounds: HOST_B },
    ]).state;
    const { state, effects } = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(2), frame: FRAME_B },
    ]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), wid(2));
    assert.strictEqual(overlayIdForHost(state, wid(1)), null, 'the old host no longer owns the overlay');
    assert.deepStrictEqual(effectsOfType(effects, 'SET_BOUNDS')[0].bounds, FRAME_B);
    assert.strictEqual(effectsOfType(effects, 'HIDE_WINDOW').length, 0, 'a retarget must not blink the chrome off');
  });

  it('after a retarget the OLD host\'s bounds no longer move the overlay', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'content', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: true },
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(2), frame: FRAME_B },
    ]).state;
    const { effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_B, overlayFrame: FRAME_B }]);
    assert.deepStrictEqual(effects, [], 'only the attached host drives the follow');
  });

  it('detach (hostId null): clears the relation and takes the overlay off screen', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { state, effects } = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: null }]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), null);
    assert.deepStrictEqual(effectShape(effects), ['HIDE_WINDOW']);
  });

  it('detaching an already-hidden overlay drives nothing', () => {
    let s = hostAndOverlay();
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { effects } = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: null }]);
    assert.deepStrictEqual(effects, []);
  });

  it('detaching a never-attached overlay is a no-op (idempotent)', () => {
    const s = hostAndOverlay();
    const { state, effects } = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: null }]);
    assert.deepStrictEqual(effects, []);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), null);
  });

  it('an UNKNOWN host is a detach ("the active window vanished between signal and handling")', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { state, effects } = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(77) }]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), null, 'no dangling attachment to an unknown id');
    assert.deepStrictEqual(effectShape(effects), ['HIDE_WINDOW']);
  });

  it('an UNKNOWN overlay id changes nothing', () => {
    const s = hostAndOverlay();
    const { state, effects } = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(77), hostId: wid(1), frame: FRAME_A }]);
    assert.deepStrictEqual(effects, []);
    assert.strictEqual(overlayIdForHost(state, wid(1)), null);
  });

  it('follow: a host BOUNDS_CHANGED re-frames + re-pins the attached overlay', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { state, effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_B, overlayFrame: FRAME_B }]);
    assert.deepStrictEqual(effectShape(effects), ['SET_BOUNDS', 'SET_STACKING']);
    assert.deepStrictEqual(effectsOfType(effects, 'SET_BOUNDS')[0], { type: 'SET_BOUNDS', id: wid(OVERLAY), bounds: FRAME_B });
    assert.strictEqual(effectsOfType(effects, 'SET_STACKING')[0].level, 'pinned');
    assert.deepStrictEqual(state.windows.get(wid(1))!.bounds, HOST_B, 'the host mirror still updates');
  });

  it('follow without an overlayFrame drives ORDER only — never a stale rect', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_B }]);
    assert.deepStrictEqual(effectShape(effects), ['SET_STACKING']);
    assert.strictEqual(effectsOfType(effects, 'SET_STACKING')[0].level, 'pinned');
  });

  it('a bounds report for an UNATTACHED window stays effect-free (the plain mirror path)', () => {
    const s = hostAndOverlay();
    const { effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_B, overlayFrame: FRAME_B }]);
    assert.deepStrictEqual(effects, []);
  });

  it('host in native fullscreen: the overlay is hidden and NOTHING else is driven', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'WINDOW_HIDDEN', id: wid(OVERLAY) }, // the hide echo
    ]).state;
    const { effects } = drive(s, [{ type: 'BOUNDS_CHANGED', id: wid(1), bounds: HOST_B, overlayFrame: FRAME_B }]);
    assert.deepStrictEqual(effects, [], 'no bounds/pin/show over a fullscreen Space');
  });

  it('the fullscreen EDGES are the signal: ENTERED hides, LEFT re-reveals (no bounds change needed)', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;

    const entered = drive(s, [{ type: 'OS_FULLSCREEN_ENTERED', id: wid(1) }]);
    assert.deepStrictEqual(effectsOfType(entered.effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(OVERLAY) }]);

    const hidden = drive(entered.state, [{ type: 'WINDOW_HIDDEN', id: wid(OVERLAY) }]).state;
    const left = drive(hidden, [{ type: 'OS_FULLSCREEN_LEFT', id: wid(1) }]);
    assert.deepStrictEqual(
      effectShape(left.effects).filter((t) => t === 'SET_STACKING' || t === 'SHOW_WINDOW'),
      ['SET_STACKING', 'SHOW_WINDOW'],
      'the overlay returns at the frame it was hidden at',
    );
    assert.strictEqual(effectsOfType(left.effects, 'SET_STACKING')[0].level, 'pinned');
    assert.strictEqual(effectsOfType(left.effects, 'SET_BOUNDS').length, 0, 'it was never moved while hidden');
    assert.strictEqual(getOverlayHost(left.state, wid(OVERLAY)), wid(1), 'the attachment survived the episode');
  });

  it('app inactive: position/size only — never reveal the chrome over another app (R6)', () => {
    let s = hostAndOverlay();
    s = drive(s, [{ type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
    ]);
    assert.deepStrictEqual(effectShape(effects), ['SET_BOUNDS'], 'no pin re-assert, no show while backgrounded');
  });

  it('APP_RESIGNED hides the chrome but KEEPS the attachment; APP_ACTIVATED re-reveals it', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;

    const resigned = drive(s, [{ type: 'APP_RESIGNED' }]);
    assert.deepStrictEqual(effectsOfType(resigned.effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(OVERLAY) }]);
    assert.strictEqual(getOverlayHost(resigned.state, wid(OVERLAY)), wid(1), 'the relation IS the re-show memory');

    const hidden = drive(resigned.state, [{ type: 'WINDOW_HIDDEN', id: wid(OVERLAY) }]).state;
    const active = drive(hidden, [{ type: 'APP_ACTIVATED' }]);
    assert.deepStrictEqual(effectsOfType(active.effects, 'SHOW_WINDOW'), [{ type: 'SHOW_WINDOW', id: wid(OVERLAY), activate: false }]);
    const overlayStacking = effectsOfType(active.effects, 'SET_STACKING').find((e) => e.id === wid(OVERLAY));
    assert.ok(overlayStacking);
    assert.strictEqual(overlayStacking.level, 'pinned');
  });

  it('APP_ACTIVATED does NOT re-reveal an overlay whose host is fullscreen', () => {
    let s = hostAndOverlay();
    s = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
      { type: 'OS_FULLSCREEN_ENTERED', id: wid(1) },
      { type: 'APP_RESIGNED' },
    ]).state;
    const { effects } = drive(s, [{ type: 'APP_ACTIVATED' }]);
    assert.strictEqual(effectsOfType(effects, 'SHOW_WINDOW').length, 0);
  });

  it('the host being HIDDEN detaches + takes the overlay down with it', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { state, effects } = drive(s, [{ type: 'WINDOW_HIDDEN', id: wid(1) }]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), null);
    assert.deepStrictEqual(effectsOfType(effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(OVERLAY) }]);
  });

  it('the host being CLOSED detaches — no `overlayFor` left pointing at a retired id', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [{ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A }]).state;
    const { state, effects } = drive(s, [{ type: 'WINDOW_CLOSED', id: wid(1) }]);
    assert.strictEqual(getOverlayHost(state, wid(OVERLAY)), null);
    assert.deepStrictEqual(effectsOfType(effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(OVERLAY) }]);
  });

  it('the overlay is never `front`, attached or not (it is a satellite)', () => {
    let s = hostAndOverlay();
    s = showOverlay(s);
    s = drive(s, [
      { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A },
      { type: 'OS_FOCUS_GAINED', id: wid(OVERLAY) },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), wid(1));
  });

  it('reduce purity: attaching does not mutate the input record', () => {
    const s = hostAndOverlay();
    const before = s.windows.get(wid(OVERLAY))!;
    reduce(s, { type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A });
    assert.strictEqual(before.overlayFor, undefined, 'input record not mutated');
  });

  it('the owner surface exposes both directions of the relation', () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(1), kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: wid(1), focused: true });
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: wid(OVERLAY), kind: 'browser', role: 'overlay', class: 'overlay', satellite: true });
    owner.dispatch({ type: 'OVERLAY_ATTACH_REQUESTED', id: wid(OVERLAY), hostId: wid(1), frame: FRAME_A });
    assert.strictEqual(owner.getOverlayHost(wid(OVERLAY)), wid(1));
    assert.strictEqual(owner.getOverlayForHost(wid(1)), wid(OVERLAY));
    owner._resetForTest();
  });
});

// ── §5 step 9: transient-sibling autoclose (§4.4 dim 4b) ─────────────────────

describe('transient-sibling autoclose on focus change (§4.4 dim 4b, §5 step 9)', () => {
  /** A registered + visible window that is NOT the focuser. */
  function sibling(
    state: AppWindowState,
    id: number,
    opts: { role: string; visible?: boolean; kind?: WindowRecord['kind']; satellite?: boolean; keepLive?: boolean },
  ): AppWindowState {
    const events: WindowEvent[] = [
      {
        type: 'WINDOW_REGISTERED',
        id: wid(id),
        kind: opts.kind ?? 'page-host',
        role: opts.role,
        satellite: opts.satellite ?? false,
        keepLive: opts.keepLive,
      },
    ];
    if (opts.visible !== false) events.push({ type: 'WINDOW_SHOWN', id: wid(id), focused: false });
    return drive(state, events).state;
  }

  /** Focuser (id 1) + the given siblings; returns the effects of the focus event. */
  function focusWith(focuserRole: string, build: (s: AppWindowState) => AppWindowState): Effect[] {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: focuserRole, focused: false });
    s = build(s);
    return drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]).effects;
  }

  function closedIds(effects: Effect[]): WindowId[] {
    return effectsOfType(effects, 'CLOSE_WINDOW').map((e) => e.id);
  }

  // ── The table, mirroring izui-roles.test.ts `selectTransientSiblingsToClose` ──

  it('a workspace focuser closes a visible quick-view sibling', () => {
    const effects = focusWith('workspace', (s) => sibling(s, 2, { role: 'quick-view' }));
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
  });

  it('a quick-view focuser closes the OTHER quick-view (transients dismiss each other)', () => {
    const effects = focusWith('quick-view', (s) => sibling(s, 2, { role: 'quick-view' }));
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
  });

  it('never closes the focuser itself', () => {
    const effects = focusWith('quick-view', (s) => s);
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('a utility focuser closes NOTHING (the chain-popup invariant)', () => {
    const effects = focusWith('utility', (s) => {
      let next = sibling(s, 2, { role: 'quick-view' });
      next = sibling(next, 3, { role: 'palette', satellite: true });
      return next;
    });
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('an overlay focuser closes NOTHING (the shared chrome overlay is focusable and must not sweep the host it frames — the address-bar-dismisses-the-slide regression)', () => {
    const effects = focusWith('overlay', (s) => {
      let next = sibling(s, 2, { role: 'quick-view' });
      next = sibling(next, 3, { role: 'palette', satellite: true });
      return next;
    });
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('skips a non-visible transient', () => {
    const effects = focusWith('workspace', (s) => sibling(s, 2, { role: 'quick-view', visible: false }));
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('skips non-transient roles (content / workspace / child-content)', () => {
    const effects = focusWith('workspace', (s) => {
      let next = sibling(s, 2, { role: 'content' });
      next = sibling(next, 3, { role: 'workspace' });
      next = sibling(next, 4, { role: 'child-content' });
      return next;
    });
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('EXEMPTS role overlay — it manages its own visibility through the attachment', () => {
    const effects = focusWith('workspace', (s) => {
      let next = sibling(s, 2, { role: 'overlay', satellite: true });
      next = sibling(next, 3, { role: 'quick-view' });
      return next;
    });
    assert.deepStrictEqual(closedIds(effects), [wid(3)]);
  });

  it('closes BOTH transient classes (palette + quick-view) and leaves the rest', () => {
    const effects = focusWith('workspace', (s) => {
      let next = sibling(s, 2, { role: 'palette', satellite: true });
      next = sibling(next, 3, { role: 'quick-view' });
      next = sibling(next, 4, { role: 'workspace' });
      return next;
    });
    assert.deepStrictEqual(closedIds(effects).sort(), [wid(2), wid(3)]);
  });

  // ── Reducer-specific semantics ──────────────────────────────────────────────

  it('is kind-agnostic: a BrowserWindow transient is a candidate too (peek 8e5c3174)', () => {
    const effects = focusWith('workspace', (s) => sibling(s, 2, { role: 'quick-view', kind: 'browser' }));
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
  });

  it('a keepLive transient gets a bare CLOSE_WINDOW from autoclose — NOT pre-resolved to HIDE_WINDOW', () => {
    // Autoclose must never pre-resolve keepLive itself: CLOSE_WINDOW routes
    // through `windows.ts closeOrHideWindow`, which runs the black-macOS-Space
    // fullscreen-exit preamble BEFORE re-dispatching
    // WINDOW_CLOSE_OR_HIDE_REQUESTED to resolve keepLive (see the next test).
    // Pre-resolving here (as HIDE_WINDOW) would skip that preamble for a
    // fullscreen keepLive victim.
    const effects = focusWith('workspace', (s) => sibling(s, 2, { role: 'quick-view', keepLive: true }));
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
    assert.deepStrictEqual(effectsOfType(effects, 'HIDE_WINDOW'), []);
  });

  it('a keepLive transient swept by autoclose still ends up HIDDEN, not destroyed (peek 2c94c125), once WINDOW_CLOSE_OR_HIDE_REQUESTED comes back through', () => {
    // Simulates the real round trip: the backend's `closeOrHideWindow`
    // receives the CLOSE_WINDOW effect above, runs its fullscreen-exit
    // preamble, then re-dispatches WINDOW_CLOSE_OR_HIDE_REQUESTED — which is
    // where keepLive actually gets resolved.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'workspace', focused: false });
    s = sibling(s, 2, { role: 'quick-view', keepLive: true });
    const focusResult = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]);
    assert.deepStrictEqual(closedIds(focusResult.effects), [wid(2)]);
    const requestResult = drive(focusResult.state, [{ type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(2) }]);
    assert.deepStrictEqual(effectsOfType(requestResult.effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(2) }]);
    assert.deepStrictEqual(effectsOfType(requestResult.effects, 'DESTROY_WINDOW'), []);
    assert.ok(requestResult.state.windows.has(wid(2)), 'still registered — keepLive never closes');
  });

  it('an UNREGISTERED focuser (undefined role, not utility) still dismisses the transients', () => {
    let s = createInitialState();
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(2), kind: 'page-host', role: 'quick-view', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
    ]).state;
    const { effects } = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(77) }]);
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
  });

  it('WINDOW_SHOWN { focused: true } does NOT autoclose — it is a visibility import, not OS focus', () => {
    let s = createInitialState();
    s = sibling(s, 2, { role: 'quick-view' });
    const { effects } = drive(s, [
      { type: 'WINDOW_REGISTERED', id: wid(1), kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: wid(1), focused: true },
    ]);
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('is effect-only: the dismissed records survive until their own close/hide event', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'workspace', focused: false });
    s = sibling(s, 2, { role: 'quick-view' });
    const { state } = drive(s, [{ type: 'OS_FOCUS_GAINED', id: wid(1) }]);
    assert.ok(state.windows.has(wid(2)), 'the reducer describes the close; the backend performs it');
    assert.strictEqual(state.windows.get(wid(2))!.visible, true);
  });

  it('selectTransientAutoclose is the pure decision behind the clause', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'workspace', focused: false });
    s = sibling(s, 2, { role: 'quick-view' });
    assert.deepStrictEqual(selectTransientAutoclose(s, wid(1)), [wid(2)]);
    assert.deepStrictEqual(selectTransientAutoclose(s, wid(2)), [], 'the focuser is never its own victim');
  });
});

// ── §5 step 9: the app-resign sweep — a timer handle becomes reducer state ───

describe('app-resign transient sweep (§4.4 dim 4b — no timer, armed state)', () => {
  /** A visible transient page-host (a peek/slide) plus one ordinary window. */
  function withTransient(opts: { kind?: WindowRecord['kind']; keepLive?: boolean; role?: string } = {}): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content', focused: false });
    return drive(s, [
      {
        type: 'WINDOW_REGISTERED',
        id: wid(2),
        kind: opts.kind ?? 'page-host',
        role: opts.role ?? 'quick-view',
        satellite: false,
        keepLive: opts.keepLive,
      },
      { type: 'WINDOW_SHOWN', id: wid(2), focused: false },
    ]).state;
  }

  function closedIds(effects: Effect[]): WindowId[] {
    return effectsOfType(effects, 'CLOSE_WINDOW').map((e) => e.id);
  }

  it('APP_RESIGNED only ARMS the sweep — it dismisses nothing on the resign edge', () => {
    const { state, effects } = drive(withTransient(), [{ type: 'APP_RESIGNED' }]);
    assert.strictEqual(state.pendingAppResignSweep, true);
    assert.deepStrictEqual(closedIds(effects), [], 'the resign edge may be the macOS dance');
  });

  it('APP_RESIGN_SETTLED while armed dismisses the visible transient page-hosts', () => {
    const s = drive(withTransient(), [{ type: 'APP_RESIGNED' }]).state;
    const { state, effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
    assert.strictEqual(state.pendingAppResignSweep, false, 'the sweep is consumed');
  });

  it('the DANCE cancel: APP_ACTIVATED in between disarms it, so the settle closes nothing (8e5c3174)', () => {
    const s = drive(withTransient(), [{ type: 'APP_RESIGNED' }, { type: 'APP_ACTIVATED' }]).state;
    assert.strictEqual(s.pendingAppResignSweep, false);
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), [], 'a freshly opened slide survives the startup dance');
  });

  it('a settle with no preceding resign is inert', () => {
    const { effects } = drive(withTransient(), [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(effects, []);
  });

  it('a REPEATED settle is inert (the sweep is consumed, not re-runnable)', () => {
    const s = drive(withTransient(), [{ type: 'APP_RESIGNED' }, { type: 'APP_RESIGN_SETTLED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('a second resign re-arms it', () => {
    let s = drive(withTransient(), [{ type: 'APP_RESIGNED' }, { type: 'APP_RESIGN_SETTLED' }]).state;
    s = drive(s, [{ type: 'APP_ACTIVATED' }, { type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
  });

  it('never dismisses while the app is active (defensive: a settle without its resign edge)', () => {
    let s = withTransient();
    // Craft the armed-but-active state directly: no legitimate sequence makes it.
    s = { ...drive(s, [{ type: 'APP_RESIGNED' }]).state, appActive: true };
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('scoped to page-hosts: a BrowserWindow transient self-closes via its own blur handler', () => {
    const s = drive(withTransient({ kind: 'browser' }), [{ type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), []);
  });

  it('EXEMPTS role overlay, and skips non-transient / hidden windows', () => {
    let s = drive(withTransient({ role: 'overlay' }), [
      { type: 'WINDOW_REGISTERED', id: wid(3), kind: 'page-host', role: 'quick-view', satellite: false },
      // registered but never shown -> not visible
    ]).state;
    s = drive(s, [{ type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), [], 'the overlay and the hidden peek both stay');
  });

  it('a keepLive slide gets a bare CLOSE_WINDOW from the sweep — NOT pre-resolved to HIDE_WINDOW', () => {
    // Same reasoning as the focus-autoclose sibling test above: the sweep
    // must not pre-resolve keepLive itself, or the black-macOS-Space
    // fullscreen-exit preamble in `windows.ts closeOrHideWindow` gets skipped.
    const s = drive(withTransient({ keepLive: true }), [{ type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(effects), [wid(2)]);
    assert.deepStrictEqual(effectsOfType(effects, 'HIDE_WINDOW'), []);
  });

  it('a keepLive slide swept by app-resign still ends up HIDDEN, not destroyed (peek 2c94c125), once WINDOW_CLOSE_OR_HIDE_REQUESTED comes back through', () => {
    const armed = drive(withTransient({ keepLive: true }), [{ type: 'APP_RESIGNED' }]).state;
    const sweepResult = drive(armed, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.deepStrictEqual(closedIds(sweepResult.effects), [wid(2)]);
    const requestResult = drive(sweepResult.state, [{ type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id: wid(2) }]);
    assert.deepStrictEqual(effectsOfType(requestResult.effects, 'HIDE_WINDOW'), [{ type: 'HIDE_WINDOW', id: wid(2) }]);
    assert.deepStrictEqual(effectsOfType(requestResult.effects, 'DESTROY_WINDOW'), []);
    assert.ok(requestResult.state.windows.has(wid(2)), 'still registered — keepLive never closes');
  });

  it('selectAppResignTransients is the pure decision behind the clause', () => {
    const s = withTransient();
    assert.deepStrictEqual(selectAppResignTransients(s), [wid(2)]);
  });

  it('the sweep emits NO destroy effects (keepLive would lose a live slide)', () => {
    const s = drive(withTransient(), [{ type: 'APP_RESIGNED' }]).state;
    const { effects } = drive(s, [{ type: 'APP_RESIGN_SETTLED' }]);
    assert.strictEqual(effectsOfType(effects, 'DESTROY_WINDOW').length, 0);
  });
});
