/**
 * Unit tests for `window-kernel-executor.ts` — the kernel's impure edge.
 *
 * Harness conventions follow `window-kernel.test.ts` (`node:test` +
 * `node:assert`, `.js`-suffixed import of the compiled output, a small
 * branded-id builder). The backend is a recorder implementing the whole
 * `WindowBackend` port: every assertion here is about WHICH port command the
 * executor issued, in what order, with what arguments — never about a real
 * window (there is none, and OS focus is unobservable in a headless unit run
 * anyway).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { setDebug, __resetDebugFlagsForTest } from './debug-flag.js';
import {
  WindowKernelExecutor,
  planRaise,
  planRaiseRealization,
  planRestoreFocus,
  stackingLevelForLayer,
  type FsSettleOutcome,
} from './window-kernel-executor.js';
import {
  initialState,
  evolve,
  BASE_LAYER,
  type DesktopMembership,
  type Event,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { WindowId as BackendWindowId } from './window-kernel.js';
import type { StackingLevel } from './izui-roles.js';

/** Craft a WM WindowId for tests — nothing checks the shape, only identity. */
const wid = (n: number): WindowId => `wk-${n}` as WindowId;

// ── The recording backend ────────────────────────────────────────────────────

interface Call {
  name: string;
  args: unknown[];
}

/**
 * Records every port command. Implements the full `WindowBackend` surface so a
 * new port method cannot be silently unimplemented here; the methods the kernel
 * executor never issues are present and inert.
 */
class RecordingBackend implements WindowBackend {
  readonly calls: Call[] = [];

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  /** The recorded command names, in order. */
  names(): string[] {
    return this.calls.map((c) => c.name);
  }

  /** Every recorded call of one command, in order. */
  of(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  attachAppListeners(): void {
    this.record('attachAppListeners');
  }
  raiseWindow(id: BackendWindowId, opSeq: number, intent?: 'user'): void {
    // The intent is recorded only when present so the pre-existing
    // `args[0]`/`args[1]` assertions keep their shape.
    if (intent === undefined) this.record('raiseWindow', id, opSeq);
    else this.record('raiseWindow', id, opSeq, intent);
  }
  focusContent(id: BackendWindowId, opSeq: number): void {
    this.record('focusContent', id, opSeq);
  }
  setFullscreen(id: BackendWindowId, on: boolean): void {
    this.record('setFullscreen', id, on);
  }
  reconcileFullscreen(id: BackendWindowId): void {
    this.record('reconcileFullscreen', id);
  }
  closeOrHide(id: BackendWindowId): Promise<void> {
    this.record('closeOrHide', id);
    return Promise.resolve();
  }
  askRendererHandledEscape(id: BackendWindowId): Promise<boolean> {
    this.record('askRendererHandledEscape', id);
    return Promise.resolve(false);
  }
  attachEscHandler(id: BackendWindowId): void {
    this.record('attachEscHandler', id);
  }
  setEscGrab(on: boolean): void {
    this.record('setEscGrab', on);
  }
  closeWindow(id: BackendWindowId): Promise<void> {
    this.record('closeWindow', id);
    return Promise.resolve();
  }
  destroyWindow(id: BackendWindowId): void {
    this.record('destroyWindow', id);
  }
  closeContent(id: BackendWindowId): void {
    this.record('closeContent', id);
  }
  showWindow(id: BackendWindowId, opts: { activate: boolean; opSeq: number }): void {
    this.record('showWindow', id, opts);
  }
  hideWindow(id: BackendWindowId): void {
    this.record('hideWindow', id);
  }
  pinAlwaysOnTop(id: BackendWindowId, on: boolean): void {
    this.record('pinAlwaysOnTop', id, on);
  }
  hideApp(): void {
    this.record('hideApp');
  }
  destroyAllContentGuests(): Promise<void> {
    this.record('destroyAllContentGuests');
    return Promise.resolve();
  }
  setStacking(id: BackendWindowId, level: StackingLevel): void {
    this.record('setStacking', id, level);
  }
  setWindowBounds(id: BackendWindowId, rect: Rect): void {
    this.record('setWindowBounds', id, rect);
  }
  setDesktopMembership(id: BackendWindowId, membership: DesktopMembership): void {
    this.record('setDesktopMembership', id, membership);
  }
  setAcceptsInput(id: BackendWindowId, acceptsInput: boolean): void {
    this.record('setAcceptsInput', id, acceptsInput);
  }
  attachOverlayTo(overlayId: BackendWindowId, hostId: BackendWindowId | null): void {
    this.record('attachOverlayTo', overlayId, hostId);
  }
}

/**
 * An executor over a fresh recorder, non-headless unless told otherwise.
 *
 * `appActive` is NOT threaded into `initial` — it is reached the only way the
 * kernel ever reaches it, by an event. `initialState()` starts ACTIVE (a
 * launch is an activation), which is the ordinary "app is in front" baseline,
 * so a test exercising the backgrounded gate opts OUT with
 * `{ appActive: false }` and gets an `AppResigned` dispatched right after
 * construction. Either edge is a no-op transition at this point beyond the
 * flag itself: no window exists yet to mark `hiddenByAppBlur` and no
 * cold-start latch is armed. Tests that care about `exec.getState()` matching
 * a bare `initialState()` leave it unset.
 */
function makeExecutor(opts: { headless?: boolean; initial?: State; appActive?: boolean } = {}): {
  exec: WindowKernelExecutor;
  backend: RecordingBackend;
} {
  const backend = new RecordingBackend();
  const exec = new WindowKernelExecutor(backend, {
    headless: opts.headless ?? false,
    ...(opts.initial !== undefined ? { initial: opts.initial } : {}),
  });
  if (opts.appActive === false) exec.dispatch({ type: 'AppResigned' });
  return { exec, backend };
}

const register = (
  id: WindowId,
  over: Partial<Extract<Event, { type: 'WindowRegistered' }>> = {},
): Event => ({
  type: 'WindowRegistered',
  id,
  kind: 'browser',
  layer: BASE_LAYER,
  canBecomeKey: true,
  acceptsInput: true,
  class: 'primary',
  ...over,
});

// ── layer -> StackingLevel (§0.1.6) ──────────────────────────────────────────

describe('stackingLevelForLayer', () => {
  it('maps the base layer to the regular stacked band', () => {
    assert.strictEqual(stackingLevelForLayer(BASE_LAYER), 'stacked');
  });

  it('maps every layer above the base to the pinned (floating) band', () => {
    assert.strictEqual(stackingLevelForLayer(BASE_LAYER + 1), 'pinned');
    assert.strictEqual(stackingLevelForLayer(BASE_LAYER + 7), 'pinned');
  });

  it('collapses a band below the base into the regular band — there is no native "place below"', () => {
    assert.strictEqual(stackingLevelForLayer(BASE_LAYER - 1), 'stacked');
  });

  it("never answers 'excluded' — RULE 1 makes non-membership unrepresentable", () => {
    for (let layer = -3; layer <= 9; layer++) {
      assert.notStrictEqual(stackingLevelForLayer(layer), 'excluded');
    }
  });
});

// ── Stacking re-assert (§0.1.6) ──────────────────────────────────────────────

describe('the stacking re-assert loop', () => {
  it('replays only the windows a change actually requires — a minimal diff, not the whole band', () => {
    const { exec, backend } = makeExecutor();
    for (const ev of [
      register(wid(1)),
      register(wid(2)),
      { type: 'WindowShown' as const, id: wid(1) },
      { type: 'WindowShown' as const, id: wid(2) },
    ]) {
      exec.dispatch(ev);
    }
    backend.calls.length = 0;

    // A third registration changes `order`'s membership, but the new window
    // is not visible yet — it cannot appear in the replay at all — and the
    // two already-placed windows kept their relative order, so nothing needs
    // re-raising.
    exec.dispatch(register(wid(3)));
    assert.deepStrictEqual(backend.of('setStacking').map((c) => c.args[0]), []);

    // Showing it is what makes it eligible for the first time; only IT gets
    // replayed — windows 1 and 2 never moved, so they are not re-announced
    // alongside it.
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowShown', id: wid(3) });
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(3)],
      'only the window that newly became eligible is replayed',
    );

    // A further registration of a not-yet-visible window again needs
    // nothing: the three already-placed windows are still untouched.
    backend.calls.length = 0;
    exec.dispatch(register(wid(4)));
    assert.deepStrictEqual(backend.of('setStacking').map((c) => c.args[0]), []);
  });

  it('replays within each layer band, lowest band first', () => {
    const { exec, backend } = makeExecutor();
    // Two base-layer windows and two pinned ones, registered alternating —
    // `order` is not layer-sorted, so the raw array interleaves the bands.
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2), { layer: BASE_LAYER + 1, class: 'hud' }));
    exec.dispatch(register(wid(3)));
    exec.dispatch(register(wid(4), { layer: BASE_LAYER + 1, class: 'hud' }));
    for (const id of [wid(1), wid(2), wid(3), wid(4)]) exec.dispatch({ type: 'WindowShown', id });
    backend.calls.length = 0;

    // Reverse each band's internal order in one import — a genuine reorder in
    // BOTH bands at once, the only way to see more than one band's replay in
    // a single dispatch now that a plain close or registration of an
    // ineligible window needs no replay at all.
    exec.dispatch({ type: 'StackOrderImported', order: [wid(3), wid(1), wid(4), wid(2)] });

    const stacking = backend.of('setStacking');
    assert.deepStrictEqual(
      stacking.map((c) => [c.args[0], c.args[1]]),
      [
        [wid(1), 'stacked'],
        [wid(2), 'pinned'],
      ],
      'the base band replays before the pinned band, and only the one window each band actually needs moved',
    );
  });

  it('groups the bands even when the array interleaves them', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1), { layer: BASE_LAYER + 1, class: 'hud' }));
    exec.dispatch(register(wid(2)));
    exec.dispatch(register(wid(3), { layer: BASE_LAYER + 1, class: 'hud' }));
    exec.dispatch(register(wid(4)));
    for (const id of [wid(1), wid(2), wid(3), wid(4)]) exec.dispatch({ type: 'WindowShown', id });
    backend.calls.length = 0;

    // A full reversal reorders both bands in one transition.
    exec.dispatch({ type: 'StackOrderImported', order: [wid(4), wid(3), wid(2), wid(1)] });

    const stacking = backend.of('setStacking').map((c) => [c.args[0], c.args[1]]);
    // Base band first (in array order), then the floating band.
    assert.deepStrictEqual(stacking, [
      [wid(2), 'stacked'],
      [wid(1), 'pinned'],
    ]);
  });

  it('omits a window that is not yet orderable — the OS cannot position it', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2), { kind: 'page-host' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    backend.calls.length = 0;
    exec.dispatch(register(wid(3)));
    // wid(3) is not visible, and neither placed window's relative order
    // moved, so nothing needs replaying.
    assert.deepStrictEqual(backend.of('setStacking').map((c) => c.args[0]), []);
    // The first composited frame makes wid(2) eligible for the first time —
    // only it is replayed, not wid(1) alongside it.
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowContentOrderable', id: wid(2) });
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(2)],
    );
  });
});

// ── The stale-echo guard ─────────────────────────────────────────────────────

describe('the stale self-echo guard at the dispatch site', () => {
  /**
   * The filed hazard: a `machine`-caused `OsFocusGained` that arrives after
   * another window has taken key is, by `react`'s rule, a genuine reorder — and
   * a genuine reorder emits `RaiseWindow`, an ACTIVATING show. Left alone it
   * would drive a real OS focus-steal.
   *
   * ON THE TOKEN VALUES BELOW: these tests pin the ordering RULE the guard
   * applies, and some of them reach an older token by arithmetic on the stamp
   * (`stamped - 1`) rather than by issuing a second op. That is deliberate
   * economy, not the proof that the guard fires on real traffic — the proof is
   * the last test in this describe, which issues two ops for the same window
   * through ordinary dispatches and replays the FIRST one's token exactly as
   * the backend received it.
   */
  function twoWindowsWithAnIssuedOp(): { exec: WindowKernelExecutor; backend: RecordingBackend } {
    // `appActive: true` — these tests are about the stale-echo guard, not
    // about the app-active raise gate, so the raises they issue need to
    // actually reach `raiseWindow` for their token assertions to hold.
    const made = makeExecutor({ appActive: true });
    made.exec.dispatch(register(wid(1)));
    made.exec.dispatch(register(wid(2)));
    made.exec.dispatch({ type: 'WindowShown', id: wid(1) });
    made.exec.dispatch({ type: 'WindowShown', id: wid(2) });
    // Raise wid(1): stamps `lastOpSeq` on it (the machine issued a focus-family op).
    made.exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    return made;
  }

  it('drops a machine echo older than the newest op issued for that window', () => {
    const { exec, backend } = twoWindowsWithAnIssuedOp();
    const stamped = exec.getState().order.find((w) => w.id === wid(1))!.lastOpSeq;
    assert.notStrictEqual(stamped, undefined);
    // Meanwhile the user moves to the other window.
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    const versionBefore = exec.getState().version;
    backend.calls.length = 0;

    // The LATE echo of the earlier raise finally lands.
    exec.dispatch({
      type: 'OsFocusGained',
      id: wid(1),
      cause: { kind: 'machine', opSeq: (stamped as number) - 1 },
    });

    assert.strictEqual(exec.getState().key, wid(2), 'key must stay where the user put it');
    assert.strictEqual(exec.getState().version, versionBefore, 'a dropped event never reaches evolve');
    assert.deepStrictEqual(backend.names(), [], 'no raise, so no OS focus-steal');
  });

  it('lets a CURRENT machine echo through — the guard is an ordering test, not a cause test', () => {
    const { exec, backend } = twoWindowsWithAnIssuedOp();
    const stamped = exec.getState().order.find((w) => w.id === wid(1))!.lastOpSeq as number;
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    const versionBefore = exec.getState().version;
    backend.calls.length = 0;

    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: stamped } });

    assert.strictEqual(exec.getState().key, wid(1), 'the report reaches evolve and is written as fact');
    assert.notStrictEqual(exec.getState().version, versionBefore, 'not dropped');
    // It carries the token of the newest op issued to wid(1), so it is that
    // op's confirmation: the OS already did what the raise asked, and the
    // kernel drives nothing further (`isOpConfirmation`).
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [], 'a confirmation is not re-issued as a raise');
  });

  it('never drops a world-caused focus report', () => {
    const { exec, backend } = twoWindowsWithAnIssuedOp();
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    backend.calls.length = 0;

    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'world' } });

    assert.strictEqual(exec.getState().key, wid(1));
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [wid(1)]);
  });

  it('never drops a report carrying no provenance at all (absent means world)', () => {
    const { exec } = twoWindowsWithAnIssuedOp();
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    assert.strictEqual(exec.getState().key, wid(1));
  });

  it('judges staleness against the state the event is APPLIED to, not the state at enqueue', () => {
    // A window that has never been shown or raised carries NO `lastOpSeq`, so
    // no echo for it can be stale. Both events below are queued during one
    // effect: the show lands first and stamps the window, so by the time the
    // echo is applied there IS an op to be older than — and it is dropped.
    // Judging at enqueue time would have let it through and driven a raise.
    const backend = new RecordingBackend();
    let reentered = false;
    const exec: WindowKernelExecutor = new WindowKernelExecutor(
      new Proxy(backend, {
        get(target, prop, receiver) {
          if (prop === 'hideWindow') {
            return (id: BackendWindowId) => {
              backend.hideWindow(id);
              if (reentered) return;
              reentered = true;
              exec.dispatch({ type: 'WindowShown', id: wid(3) });
              exec.dispatch({
                type: 'OsFocusGained',
                id: wid(3),
                cause: { kind: 'machine', opSeq: -1 },
              });
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as unknown as WindowBackend,
      { headless: false },
    );
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    exec.dispatch(register(wid(3)));
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    assert.strictEqual(exec.getState().order.find((w) => w.id === wid(3))!.lastOpSeq, undefined);

    exec.dispatch({ type: 'WindowHidden', id: wid(2) });

    assert.strictEqual(reentered, true);
    // The show stamped wid(3) with the token its own op minted — whatever the
    // counter had reached by then — and the echo's -1 is older than any token
    // the counter can mint.
    assert.strictEqual(exec.getState().order.find((w) => w.id === wid(3))!.lastOpSeq, exec.getState().opSeqCounter);
    assert.strictEqual(exec.getState().key, wid(2), 'the late echo never took key');
  });

  /**
   * THE GUARD ON REAL TRAFFIC — no synthetic token anywhere.
   *
   * Every event below is one a producer really sends, and the token replayed
   * as the late echo is read off the backend call the executor actually made,
   * exactly as `electron-window-backend.ts armSelfCausedFocus` would hold it
   * until the OS reports the focus back. It fails if `State.opSeqCounter`
   * stops advancing: with a frozen counter both raises of wid(1) carry the
   * same token, the late echo is indistinguishable from the current one, the
   * guard lets it through, and it drives a real raise — the OS focus-steal
   * this guard exists to prevent.
   */
  it('drops the late echo of a superseded op, with every token minted by ordinary traffic', () => {
    // `appActive: true` — this test is about the stale-echo guard, not the
    // app-active raise gate; the raises it issues need to reach `raiseWindow`
    // for its token assertions to hold.
    const { exec, backend } = makeExecutor({ appActive: true });
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });

    // Op 1 — the user picks wid(1). The raise the executor issues is the one
    // whose echo arrives late, so its token is captured from the port call.
    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'world' } });
    const firstRaise = backend.of('raiseWindow').at(-1)!;
    assert.deepStrictEqual(firstRaise.args[0], wid(1));
    const supersededToken = firstRaise.args[1] as number;

    // Op 2 and op 3 — the user goes to wid(2), then back to wid(1). The
    // second raise of wid(1) SUPERSEDES the first.
    exec.dispatch({ type: 'OsFocusGained', id: wid(2), cause: { kind: 'world' } });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'world' } });
    const currentToken = backend.of('raiseWindow').at(-1)!.args[1] as number;
    assert.ok(
      currentToken > supersededToken,
      `two ops for the same window must carry different tokens (got ${supersededToken} then ${currentToken})`,
    );

    // The user moves on to wid(2) for good.
    exec.dispatch({ type: 'OsFocusGained', id: wid(2), cause: { kind: 'world' } });
    const versionBefore = exec.getState().version;
    backend.calls.length = 0;

    // Only NOW does the OS echo the FIRST raise of wid(1) back.
    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: supersededToken } });

    assert.strictEqual(exec.getState().key, wid(2), 'key must stay where the user left it');
    assert.strictEqual(exec.getState().version, versionBefore, 'a dropped event never reaches evolve');
    assert.deepStrictEqual(backend.names(), [], 'no raise, so no OS focus-steal');

    // And the guard is an ordering test, not a blanket "drop machine echoes":
    // the echo of the op that is still current is honoured.
    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: currentToken } });
    assert.strictEqual(exec.getState().key, wid(1));
  });
});

// ── Raise activation masks ───────────────────────────────────────────────────

describe('planRaise — the masks a raise owes because it is an activating show', () => {
  const record = (over: Partial<WindowRecord> = {}): WindowRecord =>
    ({
      id: wid(1),
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      visible: true,
      openSeq: 0,
      orderable: true,
      fsMode: { name: 'normal' },
      maximized: false,
      preMaxBounds: null,
      pendingProjectedBounds: null,
      ...over,
    }) as WindowRecord;

  it('never activates under headless, appActive notwithstanding', () => {
    assert.strictEqual(planRaise(record(), true, true), 'inactive-show');
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view', nonActivating: true }), true, true),
      'inactive-show',
    );
    assert.strictEqual(planRaise(undefined, true, true), 'inactive-show');
    assert.strictEqual(planRaise(record(), true, false), 'inactive-show', 'both masks apply — still inactive-show');
  });

  it('never activates the app for a panel page-host (regression 524f7aba)', () => {
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view', nonActivating: true }), false, true),
      'show-and-focus-content',
    );
  });

  it('activates for an ordinary window', () => {
    assert.strictEqual(planRaise(record(), false, true), 'activating-raise');
    assert.strictEqual(planRaise(record({ kind: 'page-host', role: 'content' }), false, true), 'activating-raise');
  });

  it('keys on the declared nonActivating attribute, not on role or class (§0.1.4, window-rules-audit.md F6)', () => {
    // A window whose CLASS shorthand says quick-view, or whose ROLE says
    // quick-view, but which does not declare `nonActivating` still activates:
    // neither `class` (lookup-only) nor `role` (the old stand-in the F6 audit
    // named) may drive this decision any more — only the attribute itself.
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', class: 'quick-view', role: 'content' }), false, true),
      'activating-raise',
    );
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view' }), false, true),
      'activating-raise',
      'role alone, with nonActivating absent, no longer takes the panel arm',
    );
  });

  it('a page-host declaring nonActivating takes the panel arm even off an unrelated role', () => {
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'content', nonActivating: true }), false, true),
      'show-and-focus-content',
    );
  });

  it('a browser panel (the command palette) does not take the page-host-only panel arm', () => {
    // `kind === 'page-host'` stays a structural guard: `'show-and-focus-
    // content'` focuses a content WebContents a browser window doesn't have.
    // A browser-kind panel still activates here — its own never-activate rule
    // is enforced by `electron-window-backend.ts raiseWindow`, not this arm.
    assert.strictEqual(
      planRaise(record({ kind: 'browser', nonActivating: true }), false, true),
      'activating-raise',
    );
  });

  // ── the app-active gate (the port of the old reducer's applyRaiseRequest) ──

  it('suppresses the raise entirely while the app is backgrounded, not headless', () => {
    assert.strictEqual(planRaise(record(), false, false), 'suppressed');
    assert.strictEqual(planRaise(undefined, false, false), 'suppressed');
  });

  it('the app-active gate overrides the panel mask too — no content focus while backgrounded', () => {
    // Deliberately stronger than "just don't activate the app": a panel's own
    // mask (`'show-and-focus-content'`) never activates the app either, but
    // the gate still narrows it to `'suppressed'` while backgrounded,
    // withholding the show and the content-focus half as well.
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view', nonActivating: true }), false, false),
      'suppressed',
    );
  });

  it('resolves the ordinary window the way it did before once the app is active again', () => {
    assert.strictEqual(planRaise(record(), false, true), 'activating-raise');
  });

  // ── the mask is for machine raises only (window-rules.md F6) ──────────────

  it('a raise the user asked for is not masked while the app is backgrounded', () => {
    // The hotkey from another app: the palette's sibling `ShowWindow` puts it
    // on screen, and without this exemption its raise is dropped — visible
    // and dead, typing going to the other app.
    assert.strictEqual(planRaise(record(), false, false, 'user'), 'activating-raise');
    assert.strictEqual(planRaise(undefined, false, false, 'user'), 'activating-raise');
  });

  it('the same raise without intent is still suppressed — intent is the only thing that changed', () => {
    assert.strictEqual(planRaise(record(), false, false), 'suppressed');
    assert.strictEqual(planRaise(record(), false, false, undefined), 'suppressed');
  });

  it('headless still wins over user intent — no focus ever, whatever was asked', () => {
    assert.strictEqual(planRaise(record(), true, false, 'user'), 'inactive-show');
    assert.strictEqual(planRaise(record(), true, true, 'user'), 'inactive-show');
  });

  it('user intent lifts the app-inactive mask, not the panel never-activate rule (524f7aba)', () => {
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view', nonActivating: true }), false, false, 'user'),
      'show-and-focus-content',
    );
  });

  // ── a panel takes key without activating; a non-panel activates (G1) ──────

  it('a user-intended raise while the app is inactive: a panel takes key without activating, a non-panel activates', () => {
    // Same inputs (backgrounded, user intent) — the ONLY thing that differs
    // is `nonActivating`, and that alone must decide activation (G1: "a panel
    // focused with user intent while another app is frontmost ... takes
    // typing while the app stays in the background").
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view', nonActivating: true }), false, false, 'user'),
      'show-and-focus-content',
      'a panel takes key (content focus) without an activating raise',
    );
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'content' }), false, false, 'user'),
      'activating-raise',
      'a non-panel with the same inputs still brings the app forward',
    );
  });
});

// The wiring in `electron-window-backend.ts raiseWindow` that calls this
// predicate is not unit-reachable here (the backend value-imports Electron),
// so only the pure decision is covered — the wiring is verified live through
// the always-on `raise-realized` log record `raiseWindow` emits.
describe('planRaiseRealization — refining an activating raise once isVisible() alone is not enough', () => {
  it('not visible takes the real show, regardless of focused', () => {
    assert.strictEqual(planRaiseRealization(false, false), 'show-and-take-key');
    assert.strictEqual(planRaiseRealization(false, true), 'show-and-take-key');
  });

  it('visible and already key realizes as a pure reorder — the aa4357a6 ping-pong guard', () => {
    assert.strictEqual(planRaiseRealization(true, true), 'reorder');
  });

  it('visible but not key takes key without re-showing — the keepLive command palette reuse', () => {
    assert.strictEqual(planRaiseRealization(true, false), 'take-key');
  });
});

describe('performing a RaiseWindow effect', () => {
  /**
   * `appActive` defaults to `true` — the ordinary "app is in front" baseline
   * every pre-existing test here assumed before the app-active gate existed —
   * so the gate's own tests below are the only callers that pass `false`.
   */
  function raiseSetup(
    over: Partial<Extract<Event, { type: 'WindowRegistered' }>>,
    headless: boolean,
    appActive = true,
  ) {
    const { exec, backend } = makeExecutor({ headless, appActive });
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2), over));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    return backend;
  }

  it('a background quick-view takes key input without bringing the app forward', () => {
    const backend = raiseSetup({ kind: 'page-host', role: 'quick-view', class: 'quick-view', nonActivating: true }, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), [], 'an activating raise would steal the app');
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual((shows[0].args[1] as { activate: boolean }).activate, false);
    assert.deepStrictEqual(backend.of('focusContent').map((c) => c.args[0]), [wid(2)]);
  });

  it('an ordinary window raises through the port raise', () => {
    const backend = raiseSetup({}, false);
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [wid(2)]);
    assert.deepStrictEqual(backend.of('focusContent'), []);
  });

  it('a headless raise reaches the port show with activate: true, carrying the raise request\'s opSeq', () => {
    // `key` has exactly one writer — `evolve OsFocusGained` — and under headless
    // the only way that event ever arrives for a raised window is the backend's
    // own synthetic echo (`electron-window-backend.ts showWindow` →
    // `kernelWindowShown(id, opts.activate, opts.opSeq)`), which carries an
    // `OsFocusGained` only when `activate` is true. This recording backend
    // performs no such echo, so the wire-level call to `showWindow` is what's
    // observable here; the echo is fed back by hand below.
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;
    const outcome = exec.execute({ type: 'RaiseWindow', id: wid(2), expectedVersion: exec.getState().version });
    assert.ok('applied' in outcome, 'the command is accepted');
    assert.deepStrictEqual(backend.of('raiseWindow'), [], 'headless never reaches the activating raise');
    assert.deepStrictEqual(backend.of('focusContent'), []);

    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    const opts = shows[0].args[1] as { activate: boolean; opSeq: number };
    assert.strictEqual(opts.activate, true, 'activate:true is what lets the echo carry a confirming OsFocusGained');
    const requestOpSeq = exec.getState().order.find((w) => w.id === wid(2))!.lastOpSeq;
    assert.strictEqual(opts.opSeq, requestOpSeq, 'the show carries the raise request\'s own opSeq');

    // Stand in for the backend's synthetic echo, which this recording backend
    // never performs on its own.
    exec.dispatch({ type: 'OsFocusGained', id: wid(2), cause: { kind: 'machine', opSeq: opts.opSeq } });
    assert.strictEqual(exec.getState().key, wid(2), 'the echo confirms the raise and key moves, even headless');
  });

  it('a headless run neither activates nor focuses content, but the show still shows', () => {
    const backend = raiseSetup({}, true);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), []);
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual((shows[0].args[1] as { activate: boolean }).activate, true);
  });

  // ── the app-active gate (§: window-kernel-executor.ts planRaise) ───────────

  it('a raise while the app is backgrounded does not activate the app', () => {
    const backend = raiseSetup({}, false, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), [], 'no activating raise while backgrounded');
    assert.deepStrictEqual(backend.of('focusContent'), []);
  });

  it('a raise while the app is backgrounded issues no backend call at all — the gate drops the raise, matching the old reducer', () => {
    // Ported from the old reducer's `applyRaiseRequest` (`if (!state.appActive)
    // return`), which dropped `RAISE_WINDOW` outright. Nothing is performed:
    // not the show, not the activate, not the content focus.
    const backend = raiseSetup({}, false, false);
    assert.deepStrictEqual(backend.of('showWindow'), [], 'a suppressed raise shows nothing');
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), []);
  });

  it('the same raise activates once the app is active — appActive is the only thing that changed', () => {
    const backend = raiseSetup({}, false, true);
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [wid(2)]);
  });

  it('headless and backgrounded together still resolve to inactive-show, and the show still carries activate: true', () => {
    const backend = raiseSetup({}, true, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), [], 'headless never reaches the activating raise, backgrounded or not');
    assert.deepStrictEqual(backend.of('focusContent'), []);
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual((shows[0].args[1] as { activate: boolean }).activate, true);
  });

  it('a backgrounded quick-view gets no content focus either — the gate suppresses that mask too', () => {
    const backend = raiseSetup({ kind: 'page-host', role: 'quick-view', class: 'quick-view', nonActivating: true }, false, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), [], 'no first-responder handoff while the app is backgrounded');
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 0, 'not shown either — the raise is suppressed outright');
  });

  // ── a raise the user asked for, while backgrounded (window-rules.md F6) ────

  /**
   * Two windows shown, wid(1) key, app backgrounded; then a `RaiseWindow`
   * COMMAND for wid(2) — the shape `kernelShowRequested(id, true, …)` sends
   * for the palette hotkey. Returns the executor and backend after the
   * command.
   */
  function commandRaiseWhileBackgrounded(intent?: 'user') {
    const { exec, backend } = makeExecutor({ appActive: false });
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;
    const outcome = exec.execute({
      type: 'RaiseWindow',
      id: wid(2),
      expectedVersion: exec.getState().version,
      ...(intent === 'user' ? { intent } : {}),
    });
    assert.ok('applied' in outcome, 'the command is accepted');
    return { exec, backend };
  }

  it('a RaiseWindow command with user intent reaches the port raise while backgrounded, carrying the intent', () => {
    const { backend } = commandRaiseWhileBackgrounded('user');
    const raises = backend.of('raiseWindow');
    assert.strictEqual(raises.length, 1, 'the user-intended raise is performed, not suppressed');
    assert.strictEqual(raises[0].args[0], wid(2));
    assert.strictEqual(raises[0].args[2], 'user', 'the backend learns the raise was asked for');
  });

  it('the same command without intent is suppressed while backgrounded — the mask still holds for machine raises', () => {
    const { backend } = commandRaiseWhileBackgrounded();
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), []);
  });

  it('a suppressed raise never moves key — no backend call means no OsFocusGained ever arrives (F1)', () => {
    // The gap this closes: `decide`/`evolve` used to write `key` synchronously
    // off a manufactured `OsFocusGained` regardless of whether the executor
    // would ever actually ask the OS for one. Now `key` moves only off the
    // backend's own report, so a raise the app-inactive mask drops outright
    // (no `intent: 'user'`, no backend call at all — see the test above)
    // leaves the model's `key` exactly where it was.
    const { exec, backend } = commandRaiseWhileBackgrounded();
    assert.deepStrictEqual(backend.of('raiseWindow'), [], 'precondition: the backend was never asked to raise it');
    assert.strictEqual(exec.getState().key, wid(1), 'key stays with the window that already held it');
  });

  it('a raise with user intent while the app is active passes the intent through unchanged', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;
    exec.execute({ type: 'RaiseWindow', id: wid(2), expectedVersion: exec.getState().version, intent: 'user' });
    assert.deepStrictEqual(
      backend.of('raiseWindow').map((c) => [c.args[0], c.args[2]]),
      [[wid(2), 'user']],
    );
  });

  it('a cold-start restore focus produces an activating raise for the saved-focused window even while appActive is still false (peek bc513e8c)', () => {
    // Reproduces `session.ts restoreSessionSnapshot`'s cold-start focus block
    // exactly: the loop already showed the saved-focused window INACTIVE
    // (`WindowShown`), the macOS startup dance has not yet handed the app
    // `appActive: true`, and the block re-drives it through the SAME two
    // commands `kernelShowRequested(id, true, { activation: 'user' })` sends —
    // `ShowWindow` then a `RaiseWindow` carrying `intent: 'user'` — rather than
    // a bare `win.show()` that cannot activate an app another app displaced.
    const { exec, backend } = makeExecutor({ appActive: false });
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    backend.calls.length = 0;
    exec.execute({ type: 'ShowWindow', id: wid(1), expectedVersion: exec.getState().version });
    exec.execute({ type: 'RaiseWindow', id: wid(1), expectedVersion: exec.getState().version, intent: 'user' });
    const raises = backend.of('raiseWindow');
    assert.strictEqual(raises.length, 1, 'the cold-start raise reaches the port instead of being masked by !appActive');
    assert.strictEqual(raises[0].args[0], wid(1));
    assert.strictEqual(raises[0].args[2], 'user', 'the backend brings the app forward on this raise (darwin)');
  });
});

// ── The rest of the effect surface ───────────────────────────────────────────

describe('effect performance', () => {
  it('a show is never an activating show — activation is the raise', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual(shows[0].args[0], wid(1));
    assert.strictEqual((shows[0].args[1] as { activate: boolean }).activate, false);
  });

  it('hides through the port', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowHidden', id: wid(1) });
    assert.deepStrictEqual(backend.of('hideWindow').map((c) => c.args[0]), [wid(1)]);
  });

  it('a non-keepLive CloseOrHideWindow closes through the guest-safe direct close, never closeOrHide/destroyWindow', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    backend.calls.length = 0;
    const out = exec.execute({ type: 'CloseOrHideWindow', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('closeWindow').map((c) => c.args[0]), [wid(1)]);
    assert.deepStrictEqual(backend.of('closeOrHide'), []);
    assert.deepStrictEqual(backend.of('destroyWindow'), []);
  });

  it('a DismissWindow effect (the transient-autoclose sweep) closes through closeOrHide, never closeWindow — a keepLive slide must be hidden, not destroyed', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2), { kind: 'page-host', role: 'quick-view' }));
    // A page host is not a dismissal candidate until it reports its first
    // composited frame (`window-kernel.ts isTransientAutocloseCandidate`), and
    // a real one does so within a frame or two of being shown.
    exec.dispatch({ type: 'WindowContentOrderable', id: wid(2) });
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    backend.calls.length = 0;
    // wid(1) taking key sweeps the still-visible transient wid(2) — a world
    // focus report, so the sweep is unconditional (no ordering floor).
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    assert.deepStrictEqual(backend.of('closeOrHide').map((c) => c.args[0]), [wid(2)]);
    assert.deepStrictEqual(backend.of('closeWindow'), [], 'the sweep must never route through the destructive close');
  });

  it('drives fullscreen in and out through the one port command', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    const v = exec.getState().version;
    const out = exec.execute({ type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: v });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('setFullscreen').map((c) => c.args), [[wid(1), true]]);

    exec.dispatch({ type: 'OsFullscreenEntered', id: wid(1) });
    backend.calls.length = 0;
    exec.execute({
      type: 'SetFullscreen',
      id: wid(1),
      desired: false,
      expectedVersion: exec.getState().version,
    });
    assert.deepStrictEqual(backend.of('setFullscreen').map((c) => c.args), [[wid(1), false]]);
  });

  it('writes bounds through the port, with no headless gate', () => {
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    const rect = { x: 1, y: 2, width: 30, height: 40 };
    exec.dispatch({ type: 'BoundsChanged', id: wid(1), bounds: rect });
    assert.deepStrictEqual(backend.of('setWindowBounds').map((c) => c.args), [[wid(1), rect]]);
  });

  it('realizes desktop membership by passing the intention straight through, no platform flags', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    exec.dispatch({ type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' });
    assert.deepStrictEqual(backend.of('setDesktopMembership')[0].args, [wid(1), 'follow']);

    backend.calls.length = 0;
    exec.dispatch({ type: 'DesktopMembershipSet', id: wid(1), membership: 'anchor' });
    assert.deepStrictEqual(backend.of('setDesktopMembership')[0].args, [wid(1), 'anchor']);
  });

  it('skips desktop membership under headless — an agent run must not move the user between desktops', () => {
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    exec.dispatch({ type: 'DesktopMembershipSet', id: wid(1), membership: 'follow' });
    assert.deepStrictEqual(backend.of('setDesktopMembership'), []);
  });

  it('holds a page above other apps on an inactive raise request, and releases it on activation', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch({ type: 'AppResigned' });
    exec.dispatch(register(wid(1), { kind: 'page-host', role: 'content' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    backend.calls.length = 0;
    exec.dispatch({ type: 'FocusRaiseRequested', id: wid(1) });
    assert.deepStrictEqual(backend.of('pinAlwaysOnTop').map((c) => c.args), [[wid(1), true]]);

    backend.calls.length = 0;
    exec.dispatch({ type: 'AppActivated' });
    assert.deepStrictEqual(backend.of('pinAlwaysOnTop').map((c) => c.args), [[wid(1), false]]);
  });

  it('skips the hold and its release under headless — a transparent window must not sit over other apps', () => {
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch({ type: 'AppResigned' });
    exec.dispatch(register(wid(1), { kind: 'page-host', role: 'content' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'FocusRaiseRequested', id: wid(1) });
    exec.dispatch({ type: 'AppActivated' });
    assert.deepStrictEqual(backend.of('pinAlwaysOnTop'), []);
  });

  it('drives an overlay attach through the port with both arguments, and a detach when the target goes null — no headless gate', () => {
    const { exec, backend } = makeExecutor({ headless: true });
    const hostA = wid(1);
    const overlay = wid(2);
    exec.dispatch(register(hostA, { kind: 'page-host', role: 'content' }));
    exec.dispatch({ type: 'WindowShown', id: hostA });
    exec.dispatch({ type: 'WindowContentOrderable', id: hostA });
    backend.calls.length = 0;

    // Registering the tracking record while hostA is already the attach
    // target is the isNew/boot-seed arm (`window-kernel.ts react`) — the
    // simplest transition that reaches this port method with a real host id.
    exec.dispatch(register(overlay, { tracksBaseLayerTop: true }));
    assert.deepStrictEqual(backend.of('attachOverlayTo').map((c) => c.args), [[overlay, hostA]]);

    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowHidden', id: hostA });
    assert.deepStrictEqual(backend.of('attachOverlayTo').map((c) => c.args), [[overlay, null]]);
  });

  // ── Teardown (§0.1.5) ─────────────────────────────────────────────────────

  it('DestroyWindow performs the forceful native destroy', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    const out = exec.execute({ type: 'DestroyWindow', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('destroyWindow').map((c) => c.args[0]), [wid(1)]);
    assert.deepStrictEqual(backend.of('closeWindow'), [], 'destroy is not a close');
  });

  it('CloseWindowDirect goes through the guest-safe close, never destroyWindow', () => {
    // `closeWindow` destroys and AWAITS the window's registered guests before
    // closing the host; `destroyWindow` has no guest pass, and routing a
    // guest-owning window there reintroduces the d1cf0b9a crash (a guest
    // dereferenced inside -[NSWindow __close]).
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    backend.calls.length = 0;
    const out = exec.execute({ type: 'CloseWindowDirect', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('closeWindow').map((c) => c.args[0]), [wid(1)]);
    assert.deepStrictEqual(backend.of('destroyWindow'), []);
    assert.deepStrictEqual(backend.of('closeOrHide'), [], 'no keepLive policy is re-applied');
  });

  it('CloseContent tears down only the content surface', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    backend.calls.length = 0;
    const out = exec.execute({ type: 'CloseContent', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('closeContent').map((c) => c.args[0]), [wid(1)]);
    assert.deepStrictEqual(backend.of('closeWindow'), [], 'the host window is not touched');
    assert.deepStrictEqual(backend.of('destroyWindow'), []);
  });

  it('DestroyAllGuests calls the process-wide port method with no window id', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    exec.dispatch(register(wid(2), { kind: 'page-host' }));
    backend.calls.length = 0;
    const out = exec.execute({ type: 'DestroyAllGuests', expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    const calls = backend.of('destroyAllContentGuests');
    assert.strictEqual(calls.length, 1, 'one process-wide call, not one per window');
    assert.deepStrictEqual(calls[0].args, [], 'and it names no window');
  });

  it('a teardown naming a window absent from order still reaches the port', () => {
    // The hybrid-finalize shape: the record retired microseconds earlier, in
    // the same synchronous body. The port resolves the handle itself and
    // no-ops when it is gone, so the executor must not withhold the call.
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowClosed', id: wid(1) });
    backend.calls.length = 0;
    assert.strictEqual(exec.getState().order.length, 0);

    const out = exec.execute({ type: 'CloseContent', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('closeContent').map((c) => c.args[0]), [wid(1)]);
  });

  it('AssertFocus drives the raise and the content-focus half through the port', () => {
    // The devtools re-assert: nothing about the window model changes, so the
    // only proof the executor did anything is the pair of port calls.
    // `appActive: true` — this test is about the assert mechanism, not the
    // app-active gate, and the raise it drives needs to actually reach
    // `raiseWindow` for the port-call assertions below to hold.
    const { exec, backend } = makeExecutor({ appActive: true });
    exec.dispatch(register(wid(1), { kind: 'page-host', role: 'content' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;

    const out = exec.execute({ type: 'AssertFocus', id: wid(1), expectedVersion: exec.getState().version });
    assert.ok('applied' in out);
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [wid(1)]);
    const focus = backend.of('focusContent');
    assert.deepStrictEqual(focus.map((c) => c.args[0]), [wid(1)]);
    assert.strictEqual(
      focus[0].args[1],
      exec.getState().opSeqCounter,
      'the content-focus half carries the same op token as the raise it rides with',
    );
    assert.deepStrictEqual(backend.of('raiseWindow')[0].args[1], focus[0].args[1]);
  });

  it('a headless run asserts focus without taking first responder', () => {
    // Focus-free by construction (2b55f3af): the raise degrades to a
    // non-activating show (`showWindow`'s own headless gate masks the OS
    // call), and the content-focus half must degrade with it — taking first
    // responder IS taking focus. The show still carries `activate: true`,
    // since that's what lets the backend's echo confirm `key` on this window.
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch(register(wid(1), { kind: 'page-host', role: 'content' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    backend.calls.length = 0;

    exec.execute({ type: 'AssertFocus', id: wid(1), expectedVersion: exec.getState().version });
    assert.deepStrictEqual(backend.of('focusContent'), []);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(
      backend.of('showWindow').map((c) => (c.args[1] as { activate?: boolean } | undefined)?.activate),
      [true],
    );
  });

  it('a teardown leaves the record in place — the close report is what retires it', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    backend.calls.length = 0;
    exec.execute({ type: 'DestroyWindow', id: wid(1), expectedVersion: exec.getState().version });
    assert.deepStrictEqual(exec.getState().order.map((w) => w.id), [wid(1)]);
    assert.deepStrictEqual(backend.of('closeWindow'), [], 'no CloseWindow was derived from a membership diff');
  });

  it('a backend that throws does not break the dispatch', () => {
    const throwing = new Proxy(new RecordingBackend(), {
      get(target, prop, receiver) {
        if (prop === 'showWindow') {
          return () => {
            throw new Error('window gone mid-show');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as WindowBackend;
    const exec = new WindowKernelExecutor(throwing, { headless: false });
    exec.dispatch(register(wid(1)));
    assert.doesNotThrow(() => exec.dispatch({ type: 'WindowShown', id: wid(1) }));
    assert.strictEqual(exec.getState().order[0].visible, true);
  });
});

// ── State ownership, commands, subscription ──────────────────────────────────

describe('state ownership and entry points', () => {
  it('starts at initialState and folds exactly like a bare evolve', () => {
    const { exec } = makeExecutor();
    assert.deepStrictEqual(exec.getState(), initialState());
    const log: Event[] = [
      register(wid(1)),
      register(wid(2)),
      { type: 'WindowShown', id: wid(1) },
      { type: 'OsFocusGained', id: wid(1) },
      { type: 'WindowClosed', id: wid(2) },
    ];
    for (const ev of log) exec.dispatch(ev);
    assert.deepStrictEqual(exec.getState(), log.reduce(evolve, initialState()));
  });

  it('accepts an injected starting state', () => {
    const seeded = evolve(initialState(), register(wid(9)));
    const { exec } = makeExecutor({ initial: seeded });
    assert.strictEqual(exec.getState(), seeded);
  });

  it('rejects a stale command and changes nothing', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    const before = exec.getState();
    // The setup dispatch is an APPLIED event, so it has already primed the OS
    // Escape grab: `reconcileEscGrab` runs once per apply and the first one
    // always writes, because `escGrabArmed` starts unset rather than at a
    // value the derived one could already match. "Changes nothing" is
    // therefore a statement about what the REJECTED command adds, not about an
    // empty recorder — pin the calls standing before it and require no growth.
    const callsBeforeCommand = backend.names();
    assert.ok(
      callsBeforeCommand.length > 0,
      'the setup dispatch must have recorded something, or the no-growth check below proves nothing',
    );
    const out = exec.execute({ type: 'ShowWindow', id: wid(1), expectedVersion: before.version - 1 });
    assert.deepStrictEqual(out, { rejected: 'stale-version' });
    assert.strictEqual(exec.getState(), before);
    assert.deepStrictEqual(backend.names(), callsBeforeCommand);
  });

  it('rejects a command naming no window', () => {
    const { exec } = makeExecutor();
    const out = exec.execute({
      type: 'ShowWindow',
      id: wid(1),
      expectedVersion: exec.getState().version,
    });
    assert.deepStrictEqual(out, { rejected: 'no-such-window' });
  });

  it('turns an accepted command into events and performs their effects', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    const out = exec.execute({
      type: 'ShowWindow',
      id: wid(1),
      expectedVersion: exec.getState().version,
    });
    assert.ok('applied' in out);
    assert.deepStrictEqual(out.events, [{ type: 'WindowShown', id: wid(1) }]);
    assert.deepStrictEqual(backend.of('showWindow').map((c) => c.args[0]), [wid(1)]);
  });

  it('notifies subscribers after each applied event and stops on unsubscribe', () => {
    const { exec } = makeExecutor();
    const seen: number[] = [];
    const off = exec.subscribe((s) => seen.push(s.version));
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    assert.deepStrictEqual(seen, [1, 2]);
    off();
    exec.dispatch({ type: 'WindowHidden', id: wid(1) });
    assert.deepStrictEqual(seen, [1, 2]);
  });

  it('does not notify for a dropped stale echo', () => {
    const { exec } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    // Shown, because a focus report on a hidden record mints no token to be
    // stale against.
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    exec.dispatch({ type: 'WindowShown', id: wid(2) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    exec.dispatch({ type: 'OsFocusGained', id: wid(2) });
    const stamped = exec.getState().order.find((w) => w.id === wid(1))!.lastOpSeq as number;
    let notified = 0;
    exec.subscribe(() => notified++);
    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: stamped - 1 } });
    assert.strictEqual(notified, 0);
  });

  it('a subscriber that throws does not break the dispatch', () => {
    const { exec } = makeExecutor();
    exec.subscribe(() => {
      throw new Error('bad subscriber');
    });
    assert.doesNotThrow(() => exec.dispatch(register(wid(1))));
    assert.strictEqual(exec.getState().order.length, 1);
  });

  it('drains a re-entrant dispatch after the current event, not inside it', () => {
    const backend = new RecordingBackend();
    const seen: string[] = [];
    let echoed = false;
    const exec: WindowKernelExecutor = new WindowKernelExecutor(
      new Proxy(backend, {
        get(target, prop, receiver) {
          if (prop === 'showWindow') {
            return (id: BackendWindowId, opts: { activate: boolean; opSeq: number }) => {
              backend.showWindow(id, opts);
              if (!echoed) {
                echoed = true;
                // The backend's synchronous echo of the show it just performed.
                exec.dispatch({ type: 'WindowContentOrderable', id: wid(1) });
                seen.push('echo-queued');
              }
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as unknown as WindowBackend,
      { headless: false },
    );
    exec.subscribe((s) => seen.push(`applied v${s.version}`));
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    // The echo was queued DURING the show effect but applied after the show's
    // own notify — one pump at a time, in dispatch order.
    assert.deepStrictEqual(seen, ['applied v1', 'echo-queued', 'applied v2', 'applied v3']);
    assert.strictEqual(exec.getState().order[0].orderable, true);
  });
});

// ── waitForSettledFsMode (peek 7fffa286) ─────────────────────────────────────

describe('waitForSettledFsMode', () => {
  /**
   * Wraps `exec.subscribe` on the instance to count subscribe / unsubscribe
   * calls made through the PUBLIC surface — the only way to prove "the
   * subscriber is removed" without reaching into the executor's private
   * `listeners` set.
   */
  function trackSubscriptions(exec: WindowKernelExecutor): { subscribed: () => number; unsubscribed: () => number } {
    const original = exec.subscribe.bind(exec);
    let subscribed = 0;
    let unsubscribed = 0;
    exec.subscribe = ((listener: (s: State) => void) => {
      subscribed++;
      const off = original(listener);
      let called = false;
      return () => {
        if (!called) {
          called = true;
          unsubscribed++;
        }
        off();
      };
    }) as WindowKernelExecutor['subscribe'];
    return { subscribed: () => subscribed, unsubscribed: () => unsubscribed };
  }

  /** A registered, shown window — a real registration scene, fsMode 'normal'. */
  function shownWindow(): { exec: WindowKernelExecutor } {
    const { exec } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'WindowShown', id: wid(1) });
    return { exec };
  }

  it('resolves "settled" immediately when the window is already in the target mode', async () => {
    const { exec } = shownWindow();
    assert.strictEqual(exec.getState().order[0].fsMode.name, 'normal');
    const outcome: FsSettleOutcome = await exec.waitForSettledFsMode(wid(1), 'normal');
    assert.strictEqual(outcome, 'settled');
  });

  it('resolves "settled" once an in-flight transition reaches the awaited mode, not before', async () => {
    const { exec } = shownWindow();
    const track = trackSubscriptions(exec);
    exec.execute({ type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: exec.getState().version });
    assert.strictEqual(exec.getState().order[0].fsMode.name, 'entering', 'the transition is in flight, not settled');

    let resolved: FsSettleOutcome | undefined;
    void exec.waitForSettledFsMode(wid(1), 'fullscreen').then((o) => (resolved = o));

    // Give any (wrongly) already-resolved promise a turn to settle before
    // asserting it did not — proves the in-flight mode does not match.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(resolved, undefined, 'must not resolve while entering/leaving');

    exec.dispatch({ type: 'OsFullscreenEntered', id: wid(1) });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(resolved, 'settled');
    assert.strictEqual(track.subscribed(), 1);
    assert.strictEqual(track.unsubscribed(), 1, 'the subscriber is removed once the wait settles');
  });

  it('resolves "vanished" when the record disappears mid-await, rather than hanging (defect 1)', async () => {
    const { exec } = shownWindow();
    const track = trackSubscriptions(exec);
    const promise = exec.waitForSettledFsMode(wid(1), 'fullscreen');
    exec.dispatch({ type: 'WindowClosed', id: wid(1) });

    // Raced against a sentinel so an un-fixed hang fails the assertion below
    // instead of hanging the test run.
    const outcome = await Promise.race([
      promise,
      new Promise<'TEST-HUNG'>((resolve) => setTimeout(() => resolve('TEST-HUNG'), 200)),
    ]);
    assert.strictEqual(outcome, 'vanished');
    assert.strictEqual(track.subscribed(), 1);
    assert.strictEqual(track.unsubscribed(), 1, 'the subscriber is removed once the record vanishes');
  });

  it('resolves "vanished" immediately when `id` never named a record at all', async () => {
    const { exec } = shownWindow();
    const track = trackSubscriptions(exec);
    // Raced against a sentinel so an un-fixed hang fails the assertion below
    // instead of hanging the test run.
    const outcome = await Promise.race([
      exec.waitForSettledFsMode(wid(99), 'fullscreen'),
      new Promise<'TEST-HUNG'>((resolve) => setTimeout(() => resolve('TEST-HUNG'), 200)),
    ]);
    assert.strictEqual(outcome, 'vanished');
    assert.strictEqual(track.subscribed(), 0, 'an immediate resolve never subscribes at all');
  });

  it('gives up after timeoutMs, an outcome distinguishable from a real settle (defect 2)', async () => {
    const { exec } = shownWindow();
    const track = trackSubscriptions(exec);
    const promise = exec.waitForSettledFsMode(wid(1), 'fullscreen', 20);

    const outcome = await Promise.race([
      promise,
      new Promise<'TEST-HUNG'>((resolve) => setTimeout(() => resolve('TEST-HUNG'), 500)),
    ]);
    assert.strictEqual(outcome, 'timed-out');
    assert.notStrictEqual(outcome, 'settled', 'a give-up must read differently from a real settle');
    assert.strictEqual(track.subscribed(), 1);
    assert.strictEqual(track.unsubscribed(), 1, 'the subscriber is removed once the wait times out');
  });

  it('a settle within the bound resolves "settled", never "timed-out"', async () => {
    const { exec } = shownWindow();
    exec.execute({ type: 'SetFullscreen', id: wid(1), desired: true, expectedVersion: exec.getState().version });
    const promise = exec.waitForSettledFsMode(wid(1), 'fullscreen', 20);
    exec.dispatch({ type: 'OsFullscreenEntered', id: wid(1) });
    assert.strictEqual(await promise, 'settled');
  });
});

// ── Async-effect settlement tracking (ported from window-os-adapter.ts) ─────

/**
 * A backend whose ONE named method returns a promise this test controls
 * (`resolve`/`reject`), instead of the recorder's always-resolves stub —
 * same Proxy-override shape as the "a backend that throws" test above, but
 * deferred rather than synchronous-throw.
 */
function backendWithDeferred(method: 'closeWindow' | 'closeOrHide' | 'destroyAllContentGuests'): {
  backend: WindowBackend;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const backend = new Proxy(new RecordingBackend(), {
    get(target, prop, receiver) {
      if (prop === method) return () => promise;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as unknown as WindowBackend;
  return { backend, resolve, reject };
}

/** Races a promise against a sentinel so an un-fixed hang fails, not hangs. */
function withHangSentinel<T>(promise: Promise<T>, ms = 200): Promise<T | 'TEST-HUNG'> {
  return Promise.race([promise, new Promise<'TEST-HUNG'>((resolve) => setTimeout(() => resolve('TEST-HUNG'), ms))]);
}

describe('waitForPendingAsyncEffects', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const { exec } = makeExecutor();
    const outcome = await withHangSentinel(exec.waitForPendingAsyncEffects());
    assert.notStrictEqual(outcome, 'TEST-HUNG');
  });

  it('resolves once a tracked effect promise settles, not before', async () => {
    const { backend, resolve } = backendWithDeferred('closeWindow');
    const exec = new WindowKernelExecutor(backend, { headless: false });
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    const out = exec.execute({
      type: 'CloseWindowDirect',
      id: wid(1),
      expectedVersion: exec.getState().version,
    });
    assert.ok('applied' in out);

    let settled = false;
    void exec.waitForPendingAsyncEffects().then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(settled, false, 'the backend promise has not settled yet');

    resolve();
    const outcome = await withHangSentinel(exec.waitForPendingAsyncEffects());
    assert.notStrictEqual(outcome, 'TEST-HUNG');
    assert.strictEqual(settled, true);
  });

  it('a rejected effect promise still lets the waiter resolve, rather than hanging', async () => {
    const { backend, reject } = backendWithDeferred('closeWindow');
    const exec = new WindowKernelExecutor(backend, { headless: false });
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    const out = exec.execute({
      type: 'CloseWindowDirect',
      id: wid(1),
      expectedVersion: exec.getState().version,
    });
    assert.ok('applied' in out);
    reject(new Error('closeWindow failed'));

    const outcome = await withHangSentinel(exec.waitForPendingAsyncEffects());
    assert.notStrictEqual(outcome, 'TEST-HUNG', 'a rejected effect promise must not wedge the waiter');
  });
});

describe('waitForGuestTeardown', () => {
  it('resolves immediately when no teardown has been requested', async () => {
    const { exec } = makeExecutor();
    const outcome = await withHangSentinel(exec.waitForGuestTeardown());
    assert.notStrictEqual(outcome, 'TEST-HUNG');
  });

  it('resolves once the last DestroyAllGuests settles, not before', async () => {
    const { backend, resolve } = backendWithDeferred('destroyAllContentGuests');
    const exec = new WindowKernelExecutor(backend, { headless: false });
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    const out = exec.execute({ type: 'DestroyAllGuests', expectedVersion: exec.getState().version });
    assert.ok('applied' in out);

    let settled = false;
    void exec.waitForGuestTeardown().then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(settled, false, 'the backend promise has not settled yet');

    resolve();
    const outcome = await withHangSentinel(exec.waitForGuestTeardown());
    assert.notStrictEqual(outcome, 'TEST-HUNG');
    assert.strictEqual(settled, true);
  });

  it('a rejected teardown promise still lets the waiter resolve, rather than hanging', async () => {
    const { backend, reject } = backendWithDeferred('destroyAllContentGuests');
    const exec = new WindowKernelExecutor(backend, { headless: false });
    exec.dispatch(register(wid(1), { kind: 'page-host' }));
    exec.execute({ type: 'DestroyAllGuests', expectedVersion: exec.getState().version });
    reject(new Error('destroyAllContentGuests failed'));

    const outcome = await withHangSentinel(exec.waitForGuestTeardown());
    assert.notStrictEqual(outcome, 'TEST-HUNG', 'a rejected teardown promise must not wedge the waiter');
  });
});

// ── The per-transition trace (ported from window-os-adapter.ts logTransition) ──

describe('the per-transition trace', () => {
  let originalLog: typeof console.log;
  let lines: string[];

  /**
   * The trace lines alone. `console.log` also carries the always-on `[wm]`
   * diagnostics (`window-diag.ts`), which are deliberately NOT DEBUG-gated —
   * the executor emits an `esc-grab-reconcile` line on every apply that flips
   * the grab and a `transient-sweep` line on every attention diff. Asserting
   * over the raw capture would make every test here a test of that stream too;
   * these tests are about the DEBUG-gated `[window-kernel]` trace, so they
   * read it through this filter.
   */
  const traceLines = (): string[] => lines.filter((l) => l.startsWith('[window-kernel] '));

  beforeEach(() => {
    __resetDebugFlagsForTest();
    setDebug(true);
    lines = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    __resetDebugFlagsForTest();
  });

  it('does not throw on an event naming a window absent from order', () => {
    const { exec } = makeExecutor();
    assert.doesNotThrow(() => exec.dispatch({ type: 'WindowShown', id: wid(99) }));
    assert.doesNotThrow(() => exec.dispatch({ type: 'OsFocusGained', id: wid(99) }));
  });

  it('does not throw when key is null both before and after the transition', () => {
    const { exec } = makeExecutor();
    // Registration alone never writes `key` (RULE 2) — before and after both
    // read null.
    assert.doesNotThrow(() => exec.dispatch(register(wid(1))));
    assert.strictEqual(exec.getState().key, null);
  });

  it('formats an ordinary transition: the key delta and the reordered stack', () => {
    const { exec } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2)));
    lines.length = 0;

    // wid(1) takes key while wid(2) already sits on top of `order` — a
    // genuine reorder (§0.1.10), so both `key` and `order` move.
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });

    const traced = traceLines();
    assert.strictEqual(traced.length, 1);
    assert.strictEqual(traced[0], `[window-kernel] OsFocusGained id(${wid(1)}) key none→${wid(1)} order=[${wid(2)} ${wid(1)}]`);
  });

  it('logs no trace when DEBUG is off', () => {
    setDebug(false);
    const { exec } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    // Only the trace is gated. The `[wm]` diagnostics on the same
    // `console.log` stay on by design (`window-diag.ts`), so this asserts
    // their absence would be asserting the opposite of that design.
    assert.deepStrictEqual(traceLines(), []);
  });
});

describe('planRestoreFocus (cold-start z-order + frontmost — peek 7bb74c90 / 8f7010a8)', () => {
  // Moved whole from `izui-roles.test.ts`, where the rule used to live as
  // `shouldActivateFocusedOnRestore`. Same cases, same reasoning.
  //
  // THE FIX: at cold start the macOS startup activation dance fires
  // did-resign-active mid-restore, so appActive reads false in the post-loop
  // focused-descriptor block. Pre-fix the block was gated on appActive alone, so
  // BOTH branches were skipped — the focused window was never raised (z-order
  // bug) nor activated (not-frontmost/menubar bug). Cold start must activate
  // anyway.
  it('cold start activates even when appActive is false (THE FIX)', () => {
    assert.strictEqual(planRestoreFocus(true, false, false), true);
  });

  // In-session restore (cold=false) must NOT yank a user who switched away
  // mid-restore back to Peek.
  it('in-session restore does NOT activate when appActive is false (don\'t yank a switched-away user)', () => {
    assert.strictEqual(planRestoreFocus(false, false, false), false);
  });

  // When the app IS active, activate regardless of cold-start (the happy path,
  // both cold and in-session).
  it('activates when appActive is true, regardless of cold-start', () => {
    assert.strictEqual(planRestoreFocus(false, false, true), true);
    assert.strictEqual(planRestoreFocus(true, false, true), true);
  });

  // Headless never steals focus, even at cold start (agent/CI runs stay
  // accessory — refs headless-no-focus-theft regressions peek 2b55f3af /
  // d9bb2924). appActive defaults true in headless, but if a test forced it
  // false, cold start must still NOT activate under headless.
  it('headless never activates at cold start when appActive is false', () => {
    assert.strictEqual(planRestoreFocus(true, true, false), false);
  });

  // Headless with appActive true still activates (appActive dominates) — but in
  // headless the real OS focus calls are gated downstream by `planRaise`, which
  // turns every raise into an inactive show. This predicate only encodes the
  // decision; it stays true here because appActive is the unconditional first
  // term.
  it('headless + appActive true returns true (appActive dominates; OS calls gated by planRaise)', () => {
    assert.strictEqual(planRestoreFocus(false, true, true), true);
  });
});
