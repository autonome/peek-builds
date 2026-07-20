/**
 * Unit tests for the pure window-state reducer (`window-state.ts`).
 *
 * Blueprint: `docs/design/fullscreen-escape-window-fsm.md` §5. Three layers:
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
  snapshot,
  frontInvariantHolds,
  isEligibleFront,
  isSatelliteRegistration,
  decideWindowRegistration,
  WindowStateOwner,
  type AppWindowState,
  type WindowRecord,
  type WindowEvent,
  type Effect,
  type FsMode,
  type IzuiSession,
  type Rectangle,
} from './window-state.js';

// ── Test builders ────────────────────────────────────────────────────────────

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
    { type: 'WINDOW_REGISTERED', id, kind: opts.kind ?? 'page-host', role: opts.role ?? 'content', satellite: opts.satellite ?? false, escapeMode: opts.escapeMode },
    { type: 'WINDOW_SHOWN', id, focused: opts.focused ?? true },
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
      id: 1,
      kind: 'page-host',
      role,
      escapeMode,
      satellite,
      visible: true,
      fsMode: fsOf(fsName, fsName === 'normal' ? null : BOUNDS),
      focusSeq: 1,
    };
    const windows = new Map<number, WindowRecord>([[1, rec]]);
    // A satellite can never be front (invariant); otherwise the window is front.
    const front = satellite ? null : 1;
    const state: AppWindowState = {
      appActive: true,
      session,
      front,
      switcher: switcherOpen ? { open: true, windowId: 2, previousFront: front } : { open: false },
      windows,
      focusSeqCounter: 1,
      escAsk: null,
      escSeq: 0,
    };
    assert.ok(frontInvariantHolds(state), 'built state class must satisfy the invariant');
    return state;
  }

  const events: WindowEvent[] = [
    { type: 'WINDOW_REGISTERED', id: 3, kind: 'browser', role: 'content', satellite: false },
    { type: 'WINDOW_SHOWN', id: 1, focused: true },
    { type: 'WINDOW_SHOWN', id: 1, focused: false },
    { type: 'WINDOW_HIDDEN', id: 1 },
    { type: 'WINDOW_CLOSED', id: 1 },
    { type: 'OS_FOCUS_GAINED', id: 1 },
    { type: 'OS_FOCUS_SETTLED_NULL' },
    { type: 'APP_ACTIVATED' },
    { type: 'APP_RESIGNED' },
    { type: 'SESSION_CHANGED', session: 'active' },
    { type: 'FULLSCREEN_REQUESTED', id: 1 },
    { type: 'FULLSCREEN_REQUESTED', id: 1, desired: true, bounds: BOUNDS },
    { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false },
    { type: 'FULLSCREEN_REQUESTED' }, // id defaults to front
    { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
    { type: 'OS_FULLSCREEN_LEFT', id: 1 },
    { type: 'FULLSCREEN_SETTLE_TIMEOUT', id: 1 },
    { type: 'ESC_PRESSED', landedId: 1 },
    { type: 'ESC_PRESSED', landedId: 'global' },
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: true, seq: 1 },
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false, seq: 1 },
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false, close: true, seq: 1 },
    { type: 'SWITCHER_OPEN_REQUESTED' },
    { type: 'SWITCHER_SELECTED', id: 1 },
    { type: 'SWITCHER_SELECTED', id: null },
    { type: 'SWITCHER_OPENED', windowId: 2 },
    { type: 'OS_FOCUS_GAINED', id: 1, lastHttpUrl: 'https://example.com/' },
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
          const decision = decideEscapeUnhandled(state, 1);
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
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
    ]);
    // Even fullscreen, ignore wins (mirrors escExitsHybridFullscreen ignore rule).
    assert.deepStrictEqual(decideEscape(state), { kind: 'pass-through', id: 1 });
  });

  it('step 4: any non-normal fsMode -> exit-fullscreen (entering/full/leaving)', () => {
    for (const name of ['entering-fullscreen', 'fullscreen', 'leaving-fullscreen'] as FsMode['name'][]) {
      const rec: WindowRecord = { id: 1, kind: 'page-host', role: 'content', satellite: false, visible: true, fsMode: fsOf(name, BOUNDS), focusSeq: 1 };
      const state: AppWindowState = { appActive: true, session: 'active', front: 1, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0 };
      assert.deepStrictEqual(decideEscape(state), { kind: 'exit-fullscreen', id: 1 }, `mode ${name}`);
    }
  });

  it('step 5: normal, non-ignore -> ask-renderer(front)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { role: 'content' });
    assert.deepStrictEqual(decideEscape(s), { kind: 'ask-renderer', id: 1 });
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
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: 2, kind: 'browser', role: 'workspace', satellite: false }, { type: 'WINDOW_SHOWN', id: 2, focused: false }]).state;
    assert.strictEqual(getFrontWindowId(s), 1, 'host is front after a non-focused settings window shows');

    // Begin fullscreen on the host; a Space-switch focus lands on settings mid-animation.
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FOCUS_GAINED', id: 2 }, // Space-switch churn while host is entering-fullscreen
    ]).state;
    assert.strictEqual(getWindowMode(s, 1), 'entering-fullscreen');
    assert.strictEqual(getFrontWindowId(s), 1, 'transition pin: settings focus during enter must NOT clobber front');

    s = drive(s, [{ type: 'OS_FULLSCREEN_ENTERED', id: 1 }]).state;
    assert.strictEqual(getFrontWindowId(s), 1, 'front stays the fullscreen host, never the settings window');
    assert.strictEqual(getWindowMode(s, 1), 'fullscreen');
  });

  it('(b) S2-null focus lag: OS_FOCUS_SETTLED_NULL keeps front (the target survives an app switch)', () => {
    let s = createInitialState();
    s = openWindow(s, 7, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), 7);
    s = drive(s, [{ type: 'OS_FOCUS_SETTLED_NULL' }]).state;
    assert.strictEqual(getFrontWindowId(s), 7, 'front must NOT go null just because OS focus left all windows');
  });

  it('(c) grab-alive-during-fullscreen: ESC_PRESSED(global) yields EXIT_FULLSCREEN, never OPEN_SWITCHER', () => {
    let s = createInitialState();
    s = openWindow(s, 7, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 7, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 7 },
    ]).state;
    assert.strictEqual(getWindowMode(s, 7), 'fullscreen');

    // The stale OS grab dispatches the SAME ESC event as before-input-event.
    assert.deepStrictEqual(decideEscape(s), { kind: 'exit-fullscreen', id: 7 });
    const { effects } = drive(s, [{ type: 'ESC_PRESSED', landedId: 'global' }]);
    assert.ok(hasEffect(effects, 'EXIT_FULLSCREEN'), 'global ESC over a fullscreen host must exit fullscreen');
    assert.ok(!hasEffect(effects, 'OPEN_SWITCHER_WINDOW'), 'must NOT open the switcher over a fullscreen window');
  });

  it('(d) switcher-over-fullscreen: step 4 precedes the switcher in the landed-ESC path too', () => {
    let s = createInitialState();
    s = openWindow(s, 3, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 3, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 3 },
    ]).state;
    const first = drive(s, [{ type: 'ESC_PRESSED', landedId: 3 }]);
    assert.ok(hasEffect(first.effects, 'EXIT_FULLSCREEN'));
    assert.ok(!hasEffect(first.effects, 'ASK_RENDERER'), 'no renderer ask while fullscreen');
    assert.ok(!hasEffect(first.effects, 'OPEN_SWITCHER_WINDOW'));

    // Only once fullscreen is actually left does ESC reach the renderer/policy.
    const left = drive(first.state, [{ type: 'OS_FULLSCREEN_LEFT', id: 3 }]);
    assert.strictEqual(getWindowMode(left.state, 3), 'normal');
    assert.deepStrictEqual(decideEscape(left.state), { kind: 'ask-renderer', id: 3 });
  });

  it('(e) palette-issuer exclusion: a satellite palette focus never clobbers the front page', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' }); // front = 1
    // The command palette opens and takes OS focus — declared satellite.
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: 2, kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: 2, focused: true },
      { type: 'OS_FOCUS_GAINED', id: 2 },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), 1, 'the palette (command issuer) must never become the command target');
  });

  it('(f) OS/green-button fullscreen on a settings window: preBounds legitimately null, NOT "missing"', () => {
    let s = createInitialState();
    s = openWindow(s, 5, { kind: 'browser', role: 'workspace' });
    // Green-button / OS-initiated fullscreen: settle event with no prior request.
    s = drive(s, [{ type: 'OS_FULLSCREEN_ENTERED', id: 5 }]).state;
    const snap = snapshot(s);
    const rec = snap.windows.find((w) => w.id === 5)!;
    assert.strictEqual(rec.fsMode.name, 'fullscreen');
    assert.strictEqual((rec.fsMode as { preBounds: Rectangle | null }).preBounds, null, 'OS-initiated entry has a legitimately-null stash');
    // It IS fullscreen for every purpose: ESC exits it (not treated as missing/normal).
    assert.deepStrictEqual(decideEscape(s), { kind: 'exit-fullscreen', id: 5 });
    // And the settled leave returns it to normal.
    s = drive(s, [{ type: 'OS_FULLSCREEN_LEFT', id: 5 }]).state;
    assert.strictEqual(getWindowMode(s, 5), 'normal');
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
    assert.strictEqual(getFrontWindowId(s), 22);
    // ESC lands (as first-responder noise) on 11; decision uses front 22.
    assert.deepStrictEqual(decideEscape(s), { kind: 'ask-renderer', id: 22 });
    // Renderer declines -> quick-view always closes.
    assert.deepStrictEqual(decideEscapeUnhandled(s, 22), { kind: 'close-window', id: 22 });
  });
});

describe('ported: escExitsHybridFullscreen -> decideEscape step 4 vs escapeMode ignore', () => {
  function fullscreenFront(escapeMode: WindowRecord['escapeMode']): AppWindowState {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content', escapeMode });
    return drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
    ]).state;
  }
  it('fullscreen + non-ignore -> exit-fullscreen', () => {
    assert.deepStrictEqual(decideEscape(fullscreenFront(undefined)), { kind: 'exit-fullscreen', id: 1 });
    assert.deepStrictEqual(decideEscape(fullscreenFront('auto')), { kind: 'exit-fullscreen', id: 1 });
    assert.deepStrictEqual(decideEscape(fullscreenFront('close')), { kind: 'exit-fullscreen', id: 1 });
  });
  it("escapeMode 'ignore' keeps winning even in fullscreen -> pass-through", () => {
    assert.deepStrictEqual(decideEscape(fullscreenFront('ignore')), { kind: 'pass-through', id: 1 });
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
      { type: 'WINDOW_REGISTERED', id: 7, kind: 'browser', role: 'overlay', satellite: true }, // shared chrome overlay
      { type: 'WINDOW_SHOWN', id: 7, focused: true },
      { type: 'OS_FOCUS_GAINED', id: 7 },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), 3, 'the chrome overlay is not the window the user means to act on');
  });

  it('a focused page-host wins as the command target (the tag-the-wrong-page bug)', () => {
    let s = createInitialState();
    s = openWindow(s, 9, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), 9);
  });

  it('a modal palette (satellite) is excluded as a target', () => {
    let s = createInitialState();
    s = openWindow(s, 9, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: 2, kind: 'browser', role: 'palette', satellite: true },
      { type: 'WINDOW_SHOWN', id: 2, focused: true },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), 9, 'the palette is the command issuer, never the target');
  });
});

// ── 3b. Ported from focused-window-tracking.test.ts ──────────────────────────

describe('ported: focused-window tracking -> front arbitration', () => {
  it('a normal visible focused window becomes front', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'browser', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), 1);
  });

  it('a background / non-focusable / overlay surface (satellite) does NOT become front', () => {
    for (const role of ['workspace', 'overlay']) {
      let s = createInitialState();
      s = drive(s, [
        { type: 'WINDOW_REGISTERED', id: 1, kind: 'browser', role, satellite: true },
        { type: 'WINDOW_SHOWN', id: 1, focused: true },
        { type: 'OS_FOCUS_GAINED', id: 1 },
      ]).state;
      assert.strictEqual(getFrontWindowId(s), null, `satellite role ${role} must not be front`);
    }
  });

  it('updates to the most recently focused window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), 2);
  });

  it('closing the front window clears the stale id and picks the MRU successor', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // front 2, 1 still visible
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: 2 }]).state;
    assert.strictEqual(getFrontWindowId(s), 1, 'successor is the remaining visible window');
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: 1 }]).state;
    assert.strictEqual(getFrontWindowId(s), null, 'no stale id remains');
  });

  it('closing a non-front window does not disturb front', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    s = openWindow(s, 2, { kind: 'browser', role: 'content' }); // front 2
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: 1 }]).state;
    assert.strictEqual(getFrontWindowId(s), 2);
  });
});

// ── 3c. Ported from hybrid-page-host-registry.test.ts ────────────────────────

describe('ported: active-hybrid-window tracking -> front', () => {
  it('a real switch to another hybrid retargets front to it', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getFrontWindowId(s), 2);
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: 1 }]).state;
    assert.strictEqual(getFrontWindowId(s), 1);
  });

  it('focus landing on the overlay (satellite) keeps the content window as front', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: 9, kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: 9, focused: true },
      { type: 'OS_FOCUS_GAINED', id: 9 },
    ]).state;
    assert.strictEqual(getFrontWindowId(s), 1);
  });

  it('closing the front hybrid nulls front (no successor)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: 1 }]).state;
    assert.strictEqual(getFrontWindowId(s), null);
  });

  it('DELIBERATE DIVERGENCE: focus leaving the whole group keeps front (old decideAfterBlur nulled it)', () => {
    // Old registry behavior: focus leaving all hybrids + overlay deactivated the
    // active id to null. New design (§2.4): OS_FOCUS_SETTLED_NULL keeps front so
    // the target survives an app switch. This inverts the old assertion on purpose.
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'OS_FOCUS_SETTLED_NULL' }]).state;
    assert.strictEqual(getFrontWindowId(s), 1, 'front is corrected only by hide/close/next-focus, not by a null focus settle');
  });
});

describe('ported: pre-fullscreen bounds stash (aa34cb50 lookalike trap)', () => {
  function preBoundsOf(s: AppWindowState, id: number): Rectangle | null | 'no-field' {
    const rec = snapshot(s).windows.find((w) => w.id === id)!;
    if (rec.fsMode.name === 'normal') return 'no-field';
    return (rec.fsMode as { preBounds: Rectangle | null }).preBounds;
  }

  it('registers with no stash (normal has no preBounds field at all)', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getWindowMode(s, 1), 'normal');
    assert.strictEqual(preBoundsOf(s, 1), 'no-field');
  });

  it('enter-initiation stashes the PRE-fullscreen bounds (captured by the adapter, carried on the event)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state;
    assert.strictEqual(getWindowMode(s, 1), 'entering-fullscreen');
    assert.deepStrictEqual(preBoundsOf(s, 1), BOUNDS);
  });

  it('the stash survives the settled ENTER', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
    ]).state;
    assert.strictEqual(getWindowMode(s, 1), 'fullscreen');
    assert.deepStrictEqual(preBoundsOf(s, 1), BOUNDS);
  });

  it('the settled LEAVE clears the stash (back to normal, live bounds authoritative)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
      { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: 1 },
    ]).state;
    assert.strictEqual(getWindowMode(s, 1), 'normal');
    assert.strictEqual(preBoundsOf(s, 1), 'no-field');
  });
});

// ── Fullscreen transition table (§2.4) — mode x event edges ──────────────────

describe('fullscreen transition table (§2.4)', () => {
  const base = () => openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });

  it('normal + REQUEST(true) -> entering + SET_FULLSCREEN(true)', () => {
    const { state, effects } = reduce(base(), { type: 'FULLSCREEN_REQUESTED', id: 1, desired: true, bounds: BOUNDS });
    assert.strictEqual(getWindowMode(state, 1), 'entering-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === true));
  });

  it('normal + toggle (no desired) -> entering', () => {
    const { state } = reduce(base(), { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS });
    assert.strictEqual(getWindowMode(state, 1), 'entering-fullscreen');
  });

  it('entering + REQUEST coalesces pendingDesire (no second SET_FULLSCREEN)', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state;
    const { state, effects } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false });
    assert.strictEqual(getWindowMode(state, 1), 'entering-fullscreen');
    assert.ok(!effects.some((e) => e.type === 'SET_FULLSCREEN'), 'no mid-animation second setFullScreen');
  });

  it('entering + OS_ENTERED with pendingDesire:false immediately begins leaving', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false }, // coalesced cancel
    ]).state;
    const { state, effects } = reduce(s, { type: 'OS_FULLSCREEN_ENTERED', id: 1 });
    assert.strictEqual(getWindowMode(state, 1), 'leaving-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === false));
  });

  it('entering + OS_LEFT -> normal (aborted by OS)', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state;
    const { state } = reduce(s, { type: 'OS_FULLSCREEN_LEFT', id: 1 });
    assert.strictEqual(getWindowMode(state, 1), 'normal');
  });

  it('fullscreen + REQUEST(false) -> leaving + SET_FULLSCREEN(false)', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
    ]).state;
    const { state, effects } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false });
    assert.strictEqual(getWindowMode(state, 1), 'leaving-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === false));
  });

  it('leaving + OS_LEFT with pendingDesire:true re-enters', () => {
    let s = drive(base(), [
      { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
      { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false }, // leaving
      { type: 'FULLSCREEN_REQUESTED', id: 1, desired: true },  // coalesced re-enter
    ]).state;
    const { state, effects } = reduce(s, { type: 'OS_FULLSCREEN_LEFT', id: 1 });
    assert.strictEqual(getWindowMode(state, 1), 'entering-fullscreen');
    assert.ok(effects.some((e) => e.type === 'SET_FULLSCREEN' && e.on === true));
  });

  it('settle timeout while transitioning -> RECONCILE_FULLSCREEN', () => {
    let s = drive(base(), [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state;
    const { effects } = reduce(s, { type: 'FULLSCREEN_SETTLE_TIMEOUT', id: 1 });
    assert.ok(effects.some((e) => e.type === 'RECONCILE_FULLSCREEN' && e.id === 1));
  });

  it('FULLSCREEN_REQUESTED makes the target the front window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' }); // front 2
    const { state } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS });
    assert.strictEqual(getFrontWindowId(state), 1);
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
    const { state, effects } = reduce(s, { type: 'SWITCHER_SELECTED', id: 1 });
    assert.strictEqual(state.switcher.open, false);
    assert.strictEqual(getFrontWindowId(state), 1);
    assert.ok(effects.some((e) => e.type === 'RAISE_WINDOW' && e.id === 1));
  });

  it('SWITCHER_SELECTED(null) restores previousFront', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPEN_REQUESTED' }]).state;
    const { state } = reduce(s, { type: 'SWITCHER_SELECTED', id: null });
    assert.strictEqual(getFrontWindowId(state), 4);
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
    s = drive(s, [{ type: 'SWITCHER_OPENED', windowId: 88 }]).state;
    const { effects } = reduce(s, { type: 'ESC_PRESSED', landedId: 'global' });
    const close = effects.find((e) => e.type === 'CLOSE_SWITCHER_WINDOW');
    assert.ok(close && close.type === 'CLOSE_SWITCHER_WINDOW');
    assert.strictEqual(close.switcherWindowId, 88);
    assert.strictEqual(close.restoreFocus, true);
  });
});

// ── Staged-cutover switcher mirror (SWITCHER_OPENED) ─────────────────────────

describe('staged-cutover switcher mirror', () => {
  it('SWITCHER_OPENED records switcher state with NO effect (izui/main own the window)', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    const { state, effects } = reduce(s, { type: 'SWITCHER_OPENED', windowId: 9 });
    assert.strictEqual(state.switcher.open, true);
    assert.ok(state.switcher.open && state.switcher.windowId === 9);
    assert.ok(!effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'), 'mirror must NOT re-open the overlay');
    // decideEscape step 1 now fires for the externally-opened overlay.
    assert.deepStrictEqual(decideEscape(state), { kind: 'close-switcher' });
  });

  it('WINDOW_CLOSED of the overlay window also clears switcher state (safety net)', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'WINDOW_REGISTERED', id: 9, kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: 9, focused: true },
      { type: 'SWITCHER_OPENED', windowId: 9 },
    ]).state;
    s = drive(s, [{ type: 'WINDOW_CLOSED', id: 9 }]).state;
    assert.strictEqual(s.switcher.open, false);
  });
});

// ── Devtools-target + pre-fullscreen-bounds selectors ────────────────────────

describe('selectors: getDevtoolsTargetId / getWindowPreBounds', () => {
  it('getDevtoolsTargetId picks the MRU http(s) window (absorbs lastContentWindowId)', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'browser', role: 'content' });
    // Focus with an http url, then a peek:// window (no http url recorded).
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: 1, lastHttpUrl: 'https://a.com/' }]).state;
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: 2 }]).state; // peek:// — no http url
    assert.strictEqual(getDevtoolsTargetId(s), 1, 'the http-bearing window is the devtools target');
    // A newer http focus wins by focusSeq.
    s = drive(s, [{ type: 'OS_FOCUS_GAINED', id: 2, lastHttpUrl: 'https://b.com/' }]).state;
    assert.strictEqual(getDevtoolsTargetId(s), 2);
  });

  it('getDevtoolsTargetId is null when no window has an http url', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getDevtoolsTargetId(s), null);
  });

  it('getWindowPreBounds returns the stash while non-normal, null when normal', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    assert.strictEqual(getWindowPreBounds(s, 1), null, 'normal -> null');
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state;
    assert.deepStrictEqual(getWindowPreBounds(s, 1), BOUNDS);
    s = drive(s, [
      { type: 'OS_FULLSCREEN_ENTERED', id: 1 },
      { type: 'FULLSCREEN_REQUESTED', id: 1, desired: false },
      { type: 'OS_FULLSCREEN_LEFT', id: 1 },
    ]).state;
    assert.strictEqual(getWindowPreBounds(s, 1), null, 'back to normal -> null');
  });
});

// ── ESC renderer round-trip (steps 5 -> 6) ───────────────────────────────────

describe('ESC renderer round-trip', () => {
  it('handled:true consumes ESC (NOTHING)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: 1 });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: true, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'NOTHING'));
  });

  it('handled:false on an active-session content window opens the switcher (step 6)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    // Session is owned by izui-state.ts and mirrored in via SESSION_CHANGED — the
    // reducer no longer derives it from WINDOW_SHOWN (design §3). Feed 'active'
    // explicitly; content + active -> nothing -> open-switcher.
    s = reduce(s, { type: 'SESSION_CHANGED', session: 'active' }).state;
    assert.strictEqual(snapshot(s).session, 'active');
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: 1 });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('handled:false on a quick-view closes it (step 6, always-close role)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'quick-view' });
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: 1 });
    const { effects } = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false, seq: askSeq(asked.effects) });
    assert.ok(effects.some((e) => e.type === 'CLOSE_WINDOW' && e.id === 1));
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
    { type: 'WINDOW_REGISTERED', id: 4, kind: 'browser', role: 'workspace', satellite: false },
    { type: 'WINDOW_SHOWN', id: 4, focused: true },
    { type: 'SESSION_CHANGED', session: 'active' },
  ]);
  assert.strictEqual(state.front, 4);
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
      { type: 'WINDOW_REGISTERED', id: 10, kind: 'browser', role: 'overlay', satellite: true },
      { type: 'WINDOW_SHOWN', id: 10, focused: true },
      { type: 'SESSION_CHANGED', session: 'active' },
      { type: 'SWITCHER_OPENED', windowId: 10 },
    ]).state;

    const all: Effect[] = [];
    const esc1 = reduce(s, { type: 'ESC_PRESSED', landedId: 10 });
    all.push(...esc1.effects);
    const close = esc1.effects.find((e) => e.type === 'CLOSE_SWITCHER_WINDOW');
    assert.ok(close && close.type === 'CLOSE_SWITCHER_WINDOW', 'ESC #1 closes the switcher');
    assert.strictEqual(close.restoreFocus, true);
    assert.strictEqual(close.switcherWindowId, 10);

    const esc2 = reduce(esc1.state, { type: 'ESC_PRESSED', landedId: 10 });
    all.push(...esc2.effects);
    const seq = askSeq(esc2.effects);

    // While the renderer is being asked, the world moves on exactly as it did in
    // the live trace: izui exits overlay mode (emitting SESSION_CHANGED, same
    // clamped value) and the overlay window closes.
    let after = reduce(esc2.state, { type: 'SESSION_CHANGED', session: 'active' });
    all.push(...after.effects);
    after = reduce(after.state, { type: 'WINDOW_CLOSED', id: 10 });
    all.push(...after.effects);
    const answer = reduce(after.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq });
    all.push(...answer.effects);

    assert.ok(!all.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'), 'the switcher must never re-open');
    assert.strictEqual(answer.state.switcher.open, false);
  });

  it('a session change during the wait cancels the pending renderer answer', () => {
    let s = drive(s0(), [{ type: 'SESSION_CHANGED', session: 'transient' }]).state;
    const asked = reduce(s, { type: 'ESC_PRESSED', landedId: 4 });
    const seq = askSeq(asked.effects);
    const moved = reduce(asked.state, { type: 'SESSION_CHANGED', session: 'active' });
    const answer = reduce(moved.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq });
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
    const asked = reduce(s0(), { type: 'ESC_PRESSED', landedId: 4 });
    const seq = askSeq(asked.effects);
    const answer = reduce(asked.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq });
    assert.ok(answer.effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
    assert.strictEqual(answer.state.switcher.open, true);
    assert.ok(answer.state.switcher.open && answer.state.switcher.previousFront === 4);
  });

  it('a newer ESC supersedes the older pending answer', () => {
    const first = reduce(s0(), { type: 'ESC_PRESSED', landedId: 4 });
    const seq1 = askSeq(first.effects);
    const second = reduce(first.state, { type: 'ESC_PRESSED', landedId: 4 });
    const seq2 = askSeq(second.effects);
    assert.notStrictEqual(seq1, seq2);

    const stale = reduce(second.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq: seq1 });
    assert.deepStrictEqual(stale.effects, [{ type: 'NOTHING' }]);
    const live = reduce(stale.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq: seq2 });
    assert.ok(live.effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('an answer for a window closed during the wait is inert', () => {
    const asked = reduce(s0(), { type: 'ESC_PRESSED', landedId: 4 });
    const seq = askSeq(asked.effects);
    const closed = reduce(asked.state, { type: 'WINDOW_CLOSED', id: 4 });
    const answer = reduce(closed.state, { type: 'ESC_RENDERER_ANSWER', id: 4, handled: false, seq });
    assert.deepStrictEqual(answer.effects, [{ type: 'NOTHING' }]);
  });

  it('re-registering a live window merges the spec instead of resetting it', () => {
    // Two call sites register the same BrowserWindow; the second carries the
    // richer spec. Rebuilding a fresh record would drop the window back to
    // visible:false / focusSeq:0 and strip it of `front`.
    let s = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: 4, kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: 4, focused: true },
    ]).state;
    const focusSeq = s.windows.get(4)!.focusSeq;
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: 4, kind: 'browser', role: 'workspace', satellite: false }]).state;
    assert.strictEqual(s.windows.get(4)!.visible, true);
    assert.strictEqual(s.windows.get(4)!.focusSeq, focusSeq);
    assert.strictEqual(s.front, 4);
  });

  it('a re-registration whose richer spec says satellite hands front to the successor', () => {
    let s = drive(createInitialState(), [
      { type: 'WINDOW_REGISTERED', id: 4, kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: 4, focused: true },
      { type: 'WINDOW_REGISTERED', id: 5, kind: 'browser', role: 'workspace', satellite: false },
      { type: 'WINDOW_SHOWN', id: 5, focused: false },
    ]).state;
    assert.strictEqual(s.front, 4);
    // ipc.ts knows this one is a modal → isSatelliteRegistration says true.
    s = drive(s, [{ type: 'WINDOW_REGISTERED', id: 4, kind: 'browser', role: 'workspace', satellite: true }]).state;
    assert.strictEqual(s.windows.get(4)!.satellite, true);
    assert.strictEqual(s.front, 5, 'front moves to the MRU successor, never stays illegal');
  });
});

// ── Owner surface ────────────────────────────────────────────────────────────

describe('WindowStateOwner (dispatch / subscribe / waitForMode)', () => {
  it('dispatch mutates the single instance and returns effects', () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: 1, kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: 1, focused: true });
    assert.strictEqual(owner.getFrontWindowId(), 1);
  });

  it('subscribe fires on dispatch with a snapshot + effects', () => {
    const owner = new WindowStateOwner();
    const seen: number[] = [];
    owner.subscribe((snap) => seen.push(snap.front ?? -1));
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: 1, kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: 1, focused: true });
    assert.deepStrictEqual(seen, [-1, 1]);
  });

  it('waitForMode resolves when the window reaches the mode', async () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: 1, kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: 1, focused: true });
    const p = owner.waitForMode(1, 'fullscreen');
    owner.dispatch({ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS });
    owner.dispatch({ type: 'OS_FULLSCREEN_ENTERED', id: 1 });
    await p; // resolves, else the test times out
    assert.strictEqual(owner.getWindowMode(1), 'fullscreen');
  });

  it('waitForMode resolves immediately when already in the mode', async () => {
    const owner = new WindowStateOwner();
    owner.dispatch({ type: 'WINDOW_REGISTERED', id: 1, kind: 'page-host', role: 'content', satellite: false });
    owner.dispatch({ type: 'WINDOW_SHOWN', id: 1, focused: true });
    await owner.waitForMode(1, 'normal');
    assert.ok(true);
  });
});

// ── Purity guard: reduce does not mutate its input ───────────────────────────

describe('reduce purity', () => {
  it('does not mutate the input state or its windows map', () => {
    const s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    const before = snapshot(s);
    const beforeSize = s.windows.size;
    reduce(s, { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS });
    reduce(s, { type: 'WINDOW_CLOSED', id: 1 });
    assert.deepStrictEqual(snapshot(s), before, 'input snapshot unchanged');
    assert.strictEqual(s.windows.size, beforeSize, 'input windows map unchanged');
    assert.strictEqual(getWindowMode(s, 1), 'normal', 'input record fsMode unchanged');
  });

  it('isEligibleFront rejects satellites, hidden, and absent records', () => {
    assert.strictEqual(isEligibleFront(undefined), false);
    assert.strictEqual(isEligibleFront({ id: 1, kind: 'browser', role: 'content', satellite: true, visible: true, fsMode: { name: 'normal' }, focusSeq: 0 }), false);
    assert.strictEqual(isEligibleFront({ id: 1, kind: 'browser', role: 'content', satellite: false, visible: false, fsMode: { name: 'normal' }, focusSeq: 0 }), false);
    assert.strictEqual(isEligibleFront({ id: 1, kind: 'browser', role: 'content', satellite: false, visible: true, fsMode: { name: 'normal' }, focusSeq: 0 }), true);
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
    });
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

  it('is total: every (alreadyRegistered x kind x hasContentWC x optOut) yields booleans', () => {
    for (const alreadyRegistered of [false, true]) {
      for (const kind of ['browser', 'page-host'] as const) {
        for (const hasContentWC of [false, true]) {
          for (const attachEscHandlerRequested of [undefined, false, true]) {
            const d = decideWindowRegistration({ alreadyRegistered, kind, hasContentWC, attachEscHandlerRequested });
            for (const [k, v] of Object.entries(d)) {
              assert.strictEqual(typeof v, 'boolean', `${k} must be boolean`);
            }
            // The two invariants the 7fffa286 fix rests on, over the whole space.
            assert.strictEqual(d.attachNativeListeners, !alreadyRegistered);
            if (alreadyRegistered) assert.strictEqual(d.attachEscHandler, false);
            assert.strictEqual(d.pumpRegisteredEvent, true);
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
    const rec: WindowRecord = { id: 1, kind: 'browser', role: 'palette', satellite: true, visible: true, fsMode: { name: 'normal' }, focusSeq: 1 };
    return { appActive: true, session: 'active', front: 1, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0 };
  }

  it('THROWS in dev/test when reduce yields an illegal front (naming the event + front id)', () => {
    // NODE_ENV is unset under `node --test` -> non-production -> guard active.
    assert.notStrictEqual(process.env.NODE_ENV, 'production');
    assert.throws(
      () => reduce(illegalFrontState(), { type: 'OS_FOCUS_SETTLED_NULL' }),
      /illegal front=1 after OS_FOCUS_SETTLED_NULL/,
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
    const rec: WindowRecord = { id: 1, kind: 'browser', role: 'palette', satellite: true, visible: true, fsMode: { name: 'normal' }, focusSeq: 1 };
    const s: AppWindowState = { appActive: true, session: 'active', front: null, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1, escAsk: null, escSeq: 0 };
    const { state } = reduce(s, { type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS });
    assert.strictEqual(state.front, null, 'a satellite must never become front, even via a fullscreen request');
    assert.strictEqual(getWindowMode(state, 1), 'entering-fullscreen', 'the fsMode edge still runs (total table)');
  });
});

describe('APP_ACTIVATED reconciles ALL in-flight fullscreen transitions (§2.5)', () => {
  it('emits RECONCILE_FULLSCREEN for both an entering AND a leaving window', () => {
    let s = createInitialState();
    s = openWindow(s, 1, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'FULLSCREEN_REQUESTED', id: 1, bounds: BOUNDS }]).state; // 1 -> entering
    s = openWindow(s, 2, { kind: 'page-host', role: 'content' });
    s = drive(s, [
      { type: 'FULLSCREEN_REQUESTED', id: 2, bounds: BOUNDS },
      { type: 'OS_FULLSCREEN_ENTERED', id: 2 },
      { type: 'FULLSCREEN_REQUESTED', id: 2, desired: false }, // 2 -> leaving
    ]).state;
    assert.strictEqual(getWindowMode(s, 1), 'entering-fullscreen');
    assert.strictEqual(getWindowMode(s, 2), 'leaving-fullscreen');

    const { effects } = reduce(s, { type: 'APP_ACTIVATED' });
    const reconciled = effects.filter((e) => e.type === 'RECONCILE_FULLSCREEN').map((e) => (e as { id: number }).id).sort();
    assert.deepStrictEqual(reconciled, [1, 2], 'both in-flight windows are reconciled, not just front');
  });
});
