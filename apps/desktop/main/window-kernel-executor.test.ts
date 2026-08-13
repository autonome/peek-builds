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
  raiseWindow(id: BackendWindowId, opSeq: number): void {
    this.record('raiseWindow', id, opSeq);
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
  askRendererToHandleEscape(id: BackendWindowId, seq: number): Promise<void> {
    this.record('askRendererToHandleEscape', id, seq);
    return Promise.resolve();
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
}

/**
 * An executor over a fresh recorder, non-headless unless told otherwise.
 *
 * `appActive` is NOT threaded into `initial` — `initialState()` starts
 * `appActive: false` (a cold, backgrounded kernel), so a test that wants the
 * ordinary "app is in front" baseline opts in with `{ appActive: true }`,
 * which dispatches an `AppActivated` event right after construction (a no-op
 * transition here: no window is marked `hiddenByAppBlur` and no cold-start
 * latch is armed, so it costs no version bump beyond the flag itself). Tests
 * that care about `exec.getState()` matching a bare `initialState()` (or that
 * are specifically exercising the backgrounded gate) leave it unset.
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
  if (opts.appActive) exec.dispatch({ type: 'AppActivated' });
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
  it('replays the whole visible orderable stack bottom-to-top on every order change, not a minimal diff', () => {
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

    // A third registration changes `order` — the emission is the FULL stack,
    // both already-placed windows included.
    exec.dispatch(register(wid(3)));
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(1), wid(2)],
    );

    // A show does not reorder `order` (§0.1.10), but it DOES re-trigger the
    // full re-assert: a window becoming visible is itself a reason to replay
    // every visible window's level, because the native always-on-top ctor
    // flag is unreliable on its own and a window is registered `visible:
    // false` — before that flag can be trusted to have stuck — so the show is
    // the first point this kernel can reinforce it (`window-kernel.ts
    // react`'s `justBecameVisible`).
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowShown', id: wid(3) });
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(1), wid(2), wid(3)],
      'the show reinforces the pin, not just an order change',
    );

    // The next order change replays all three, bottom -> top.
    backend.calls.length = 0;
    exec.dispatch(register(wid(4)));
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(1), wid(2), wid(3)],
    );
  });

  it('replays within each layer band, lowest band first', () => {
    const { exec, backend } = makeExecutor();
    // A pinned window registered between two base-layer ones — `order` is not
    // layer-sorted, so the emission interleaves bands.
    exec.dispatch(register(wid(1)));
    exec.dispatch(register(wid(2), { layer: BASE_LAYER + 1, class: 'hud' }));
    exec.dispatch(register(wid(3)));
    for (const id of [wid(1), wid(2), wid(3)]) exec.dispatch({ type: 'WindowShown', id });
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowClosed', id: wid(3) });

    const stacking = backend.of('setStacking');
    assert.deepStrictEqual(
      stacking.map((c) => [c.args[0], c.args[1]]),
      [
        [wid(1), 'stacked'],
        [wid(2), 'pinned'],
      ],
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
    exec.dispatch(register(wid(5)));

    const stacking = backend.of('setStacking').map((c) => [c.args[0], c.args[1]]);
    // Base band first (in array order), then the floating band (in array order).
    assert.deepStrictEqual(stacking, [
      [wid(2), 'stacked'],
      [wid(4), 'stacked'],
      [wid(1), 'pinned'],
      [wid(3), 'pinned'],
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
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(1)],
    );
    // The first composited frame re-drives the emission with the host included.
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowContentOrderable', id: wid(2) });
    assert.deepStrictEqual(
      backend.of('setStacking').map((c) => c.args[0]),
      [wid(1), wid(2)],
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
    backend.calls.length = 0;

    exec.dispatch({ type: 'OsFocusGained', id: wid(1), cause: { kind: 'machine', opSeq: stamped } });

    assert.strictEqual(exec.getState().key, wid(1));
    assert.deepStrictEqual(backend.of('raiseWindow').map((c) => c.args[0]), [wid(1)]);
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
    assert.strictEqual(planRaise(record({ kind: 'page-host', role: 'quick-view' }), true, true), 'inactive-show');
    assert.strictEqual(planRaise(undefined, true, true), 'inactive-show');
    assert.strictEqual(planRaise(record(), true, false), 'inactive-show', 'both masks apply — still inactive-show');
  });

  it('never activates the app for a quick-view page-host (regression 524f7aba)', () => {
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view' }), false, true),
      'show-and-focus-content',
    );
  });

  it('activates for an ordinary window', () => {
    assert.strictEqual(planRaise(record(), false, true), 'activating-raise');
    assert.strictEqual(planRaise(record({ kind: 'page-host', role: 'content' }), false, true), 'activating-raise');
  });

  it('keys on the declared role, not on class — class is lookup-only (§0.1.4)', () => {
    // A window whose CLASS shorthand says quick-view but whose declared role
    // does not still activates: nothing may branch on `class`.
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', class: 'quick-view', role: 'content' }), false, true),
      'activating-raise',
    );
  });

  // ── the app-active gate (the port of the old reducer's applyRaiseRequest) ──

  it('suppresses the raise entirely while the app is backgrounded, not headless', () => {
    assert.strictEqual(planRaise(record(), false, false), 'suppressed');
    assert.strictEqual(planRaise(undefined, false, false), 'suppressed');
  });

  it('the app-active gate overrides the quick-view mask too — no content focus while backgrounded', () => {
    // Deliberately stronger than "just don't activate the app": a quick-view
    // panel's own mask (`'show-and-focus-content'`) never activates the app
    // either, but the gate still narrows it to `'suppressed'` while
    // backgrounded, withholding the show and the content-focus half as well.
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view' }), false, false),
      'suppressed',
    );
  });

  it('resolves the ordinary window the way it did before once the app is active again', () => {
    assert.strictEqual(planRaise(record(), false, true), 'activating-raise');
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
    const backend = raiseSetup({ kind: 'page-host', role: 'quick-view', class: 'quick-view' }, false);
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

  it('a headless run neither activates nor focuses', () => {
    const backend = raiseSetup({}, true);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), []);
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual((shows[0].args[1] as { activate: boolean }).activate, false);
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

  it('headless and backgrounded together still resolve to inactive-show — headless is not double-masked', () => {
    const backend = raiseSetup({}, true, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), []);
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 1);
    assert.deepStrictEqual((shows[0].args[1] as { activate: boolean }).activate, false);
  });

  it('a backgrounded quick-view gets no content focus either — the gate suppresses that mask too', () => {
    const backend = raiseSetup({ kind: 'page-host', role: 'quick-view', class: 'quick-view' }, false, false);
    assert.deepStrictEqual(backend.of('raiseWindow'), []);
    assert.deepStrictEqual(backend.of('focusContent'), [], 'no first-responder handoff while the app is backgrounded');
    const shows = backend.of('showWindow');
    assert.strictEqual(shows.length, 0, 'not shown either — the raise is suppressed outright');
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
    // non-activating show, and the content-focus half must degrade with it —
    // taking first responder IS taking focus.
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
      [false],
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
    const out = exec.execute({ type: 'ShowWindow', id: wid(1), expectedVersion: before.version - 1 });
    assert.deepStrictEqual(out, { rejected: 'stale-version' });
    assert.strictEqual(exec.getState(), before);
    assert.deepStrictEqual(backend.names(), []);
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

    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], `[window-kernel] OsFocusGained id(${wid(1)}) key none→${wid(1)} order=[${wid(2)} ${wid(1)}]`);
  });

  it('logs nothing when DEBUG is off', () => {
    setDebug(false);
    const { exec } = makeExecutor();
    exec.dispatch(register(wid(1)));
    exec.dispatch({ type: 'OsFocusGained', id: wid(1) });
    assert.deepStrictEqual(lines, []);
  });
});
