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
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: true },
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false },
    { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false, close: true },
    { type: 'SWITCHER_OPEN_REQUESTED' },
    { type: 'SWITCHER_SELECTED', id: 1 },
    { type: 'SWITCHER_SELECTED', id: null },
    { type: 'SWITCHER_OPENED', windowId: 2 },
    { type: 'SWITCHER_CLOSED' },
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
      const state: AppWindowState = { appActive: true, session: 'active', front: 1, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1 };
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

// ── Staged-cutover switcher mirror (SWITCHER_OPENED / SWITCHER_CLOSED) ────────

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

  it('SWITCHER_CLOSED clears switcher state with NO effect', () => {
    let s = openWindow(createInitialState(), 4, { kind: 'page-host', role: 'content' });
    s = drive(s, [{ type: 'SWITCHER_OPENED', windowId: 9 }]).state;
    const { state, effects } = reduce(s, { type: 'SWITCHER_CLOSED' });
    assert.strictEqual(state.switcher.open, false);
    assert.strictEqual(effects.length, 0);
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
    const { effects } = reduce(s, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: true });
    assert.ok(effects.some((e) => e.type === 'NOTHING'));
  });

  it('handled:false on an active-session content window opens the switcher (step 6)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'content' });
    // Session is owned by izui-state.ts and mirrored in via SESSION_CHANGED — the
    // reducer no longer derives it from WINDOW_SHOWN (design §3). Feed 'active'
    // explicitly; content + active -> nothing -> open-switcher.
    s = reduce(s, { type: 'SESSION_CHANGED', session: 'active' }).state;
    assert.strictEqual(snapshot(s).session, 'active');
    const { effects } = reduce(s, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false });
    assert.ok(effects.some((e) => e.type === 'OPEN_SWITCHER_WINDOW'));
  });

  it('handled:false on a quick-view closes it (step 6, always-close role)', () => {
    let s = openWindow(createInitialState(), 1, { kind: 'page-host', role: 'quick-view' });
    const { effects } = reduce(s, { type: 'ESC_RENDERER_ANSWER', id: 1, handled: false });
    assert.ok(effects.some((e) => e.type === 'CLOSE_WINDOW' && e.id === 1));
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

// ── Front-invariant guard has teeth (design §2.5) ────────────────────────────

describe('front-invariant guard (dev/test throws, prod self-corrects)', () => {
  // A deliberately-illegal state: `front` points at a satellite. No legitimate
  // event sequence can produce this (the reducer only ever assigns an eligible
  // front) — we craft it directly to exercise the guard's throw path.
  function illegalFrontState(): AppWindowState {
    const rec: WindowRecord = { id: 1, kind: 'browser', role: 'palette', satellite: true, visible: true, fsMode: { name: 'normal' }, focusSeq: 1 };
    return { appActive: true, session: 'active', front: 1, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1 };
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
    const s: AppWindowState = { appActive: true, session: 'active', front: null, switcher: { open: false }, windows: new Map([[1, rec]]), focusSeqCounter: 1 };
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
