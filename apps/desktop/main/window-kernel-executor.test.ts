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

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  WindowKernelExecutor,
  planRaise,
  stackingLevelForLayer,
} from './window-kernel-executor.js';
import {
  initialState,
  evolve,
  BASE_LAYER,
  type Event,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel, WindowId as BackendWindowId } from './window-state.js';

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
  destroyAllContentGuests(): void {
    this.record('destroyAllContentGuests');
  }
  setStacking(id: BackendWindowId, level: StackingLevel): void {
    this.record('setStacking', id, level);
  }
  setWindowBounds(id: BackendWindowId, rect: Rect): void {
    this.record('setWindowBounds', id, rect);
  }
  setVisibleOnAllSpaces(
    id: BackendWindowId,
    on: boolean,
    opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void {
    this.record('setVisibleOnAllSpaces', id, on, opts);
  }
}

/** An executor over a fresh recorder, non-headless unless told otherwise. */
function makeExecutor(opts: { headless?: boolean; initial?: State } = {}): {
  exec: WindowKernelExecutor;
  backend: RecordingBackend;
} {
  const backend = new RecordingBackend();
  const exec = new WindowKernelExecutor(backend, {
    headless: opts.headless ?? false,
    ...(opts.initial !== undefined ? { initial: opts.initial } : {}),
  });
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

    // A show does not reorder (§0.1.10), so it re-asserts nothing.
    backend.calls.length = 0;
    exec.dispatch({ type: 'WindowShown', id: wid(3) });
    assert.deepStrictEqual(backend.of('setStacking'), []);

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
    const made = makeExecutor();
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
    const { exec, backend } = makeExecutor();
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
      visibleOnAllSpaces: false,
      pendingProjectedBounds: null,
      ...over,
    }) as WindowRecord;

  it('never activates under headless', () => {
    assert.strictEqual(planRaise(record(), true), 'inactive-show');
    assert.strictEqual(planRaise(record({ kind: 'page-host', role: 'quick-view' }), true), 'inactive-show');
    assert.strictEqual(planRaise(undefined, true), 'inactive-show');
  });

  it('never activates the app for a quick-view page-host (regression 524f7aba)', () => {
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', role: 'quick-view' }), false),
      'show-and-focus-content',
    );
  });

  it('activates for an ordinary window', () => {
    assert.strictEqual(planRaise(record(), false), 'activating-raise');
    assert.strictEqual(planRaise(record({ kind: 'page-host', role: 'content' }), false), 'activating-raise');
  });

  it('keys on the declared role, not on class — class is lookup-only (§0.1.4)', () => {
    // A window whose CLASS shorthand says quick-view but whose declared role
    // does not still activates: nothing may branch on `class`.
    assert.strictEqual(
      planRaise(record({ kind: 'page-host', class: 'quick-view', role: 'content' }), false),
      'activating-raise',
    );
  });
});

describe('performing a RaiseWindow effect', () => {
  function raiseSetup(over: Partial<Extract<Event, { type: 'WindowRegistered' }>>, headless: boolean) {
    const { exec, backend } = makeExecutor({ headless });
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

  it('pins to all Spaces with skipTransformProcessType always and visibleOnFullScreen only when pinning on', () => {
    const { exec, backend } = makeExecutor();
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    exec.dispatch({ type: 'VisibleOnAllSpacesSet', id: wid(1), on: true });
    assert.deepStrictEqual(backend.of('setVisibleOnAllSpaces')[0].args, [
      wid(1),
      true,
      { visibleOnFullScreen: true, skipTransformProcessType: true },
    ]);

    backend.calls.length = 0;
    exec.dispatch({ type: 'VisibleOnAllSpacesSet', id: wid(1), on: false });
    assert.deepStrictEqual(backend.of('setVisibleOnAllSpaces')[0].args, [
      wid(1),
      false,
      { skipTransformProcessType: true },
    ]);
  });

  it('skips the Spaces pin under headless — an agent run must not move the user between Spaces', () => {
    const { exec, backend } = makeExecutor({ headless: true });
    exec.dispatch(register(wid(1)));
    backend.calls.length = 0;
    exec.dispatch({ type: 'VisibleOnAllSpacesSet', id: wid(1), on: true });
    assert.deepStrictEqual(backend.of('setVisibleOnAllSpaces'), []);
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
