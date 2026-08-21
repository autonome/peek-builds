/**
 * Unit tests for `window-kernel-shadow.ts` — the shadow kernel's registration
 * feed. Harness conventions follow `window-kernel-executor.test.ts`
 * (`node:test` + `node:assert`, `.js`-suffixed import of the compiled output).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  _lastDivergencesForTests,
  _resetShadowKernelForTests,
  compareShadowKernelState,
  getShadowKernelExecutor,
  setKernelExecutorProvider,
  shadowKernelAppActivated,
  shadowKernelAppResigned,
  shadowKernelAppResignSettled,
  shadowKernelArmColdStartFocus,
  shadowKernelAssertFocus,
  shadowKernelAttachOverlay,
  shadowKernelCloseContent,
  shadowKernelCloseWindowDirect,
  shadowKernelContentFirstResponderChanged,
  shadowKernelDestroyAllGuests,
  shadowKernelDestroyWindow,
  shadowKernelFullscreenSettleTimeout,
  shadowKernelImportStackOrder,
  shadowKernelOsFocusGained,
  shadowKernelOsFocusSettled,
  shadowKernelOsFullscreenEntered,
  shadowKernelOsFullscreenLeft,
  shadowKernelRaiseWindow,
  shadowKernelRegisterWindow,
  shadowKernelSetFullscreen,
  shadowKernelWindowClosed,
  shadowKernelWindowContentOrderable,
  shadowKernelWindowHidden,
  shadowKernelWindowShown,
  shadowKernelBoundsChanged,
  shadowKernelDisplayChanged,
  shadowKernelMaximizeExitedByResize,
  shadowKernelSetBounds,
  shadowKernelMaximize,
  shadowKernelUnmaximize,
  shadowKernelSetDesktopMembership,
  shadowKernelWindowAcceptsInputChanged,
} from './window-kernel-shadow.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { BASE_LAYER, isContentWindow, topmost, topmostBaseLayerPageHost, type WindowId } from './window-kernel.js';
import type { StateSnapshot, WindowRecord } from './window-state.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel } from './izui-roles.js';

const wid = (n: number): WindowId => `shadow-${n}` as WindowId;

/** Minimal `StateSnapshot` fixture — the comparator reads only `front`, `stackOrder`, and each `windows[].id`. */
function fakeOldMachine(opts: { front: WindowId | null; stackOrder: WindowId[]; ids: WindowId[] }): StateSnapshot {
  return {
    appActive: true,
    session: 'idle',
    front: opts.front,
    stackOrder: opts.stackOrder,
    switcher: { open: false },
    windows: opts.ids.map((id) => ({ id }) as unknown as WindowRecord),
  };
}

/**
 * A `WindowBackend` that performs nothing and records nothing — implements the
 * whole port (so a new port method cannot be silently unimplemented here) for
 * the executor-provider tests below, which only ever assert on kernel STATE,
 * never on a backend call.
 */
class InertBackend implements WindowBackend {
  attachAppListeners(): void {}
  raiseWindow(): void {}
  focusContent(): void {}
  setFullscreen(): void {}
  reconcileFullscreen(): void {}
  closeOrHide(): Promise<void> {
    return Promise.resolve();
  }
  askRendererHandledEscape(): Promise<boolean> {
    return Promise.resolve(false);
  }
  attachEscHandler(): void {}
  setEscGrab(): void {}
  closeWindow(): Promise<void> {
    return Promise.resolve();
  }
  destroyWindow(): void {}
  closeContent(): void {}
  showWindow(): void {}
  hideWindow(): void {}
  pinAlwaysOnTop(): void {}
  destroyAllContentGuests(): Promise<void> {
    return Promise.resolve();
  }
  setStacking(_id: WindowId, _level: StackingLevel): void {}
  setWindowBounds(_id: WindowId, _rect: Rect): void {}
  setDesktopMembership(): void {}
  attachOverlayTo(): void {}
}

/** Registers a plain window in the shadow kernel — enough for `AttachOverlay`'s existence checks, nothing more. */
function registerWindow(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowKernelRegisterWindow(
    { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
    oldSnapshot,
  );
}

/** Registers a visible content-role window in the shadow kernel — the shape `isContentWindow`/`topmost` admit. */
function registerVisibleContentWindow(id: WindowId, oldSnapshot: StateSnapshot): void {
  shadowKernelRegisterWindow(
    {
      id,
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      role: 'content',
    },
    oldSnapshot,
  );
  getShadowKernelExecutor().dispatch({ type: 'WindowShown', id });
}

describe('window-kernel-shadow: registration feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a registration reaches the shadow kernel state (peek 7fffa286)', () => {
    const id = wid(1);
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'main',
      },
      fakeOldMachine({ front: null, stackOrder: [], ids: [] }),
    );

    const record = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.ok(record !== undefined, 'the registered window must appear in the shadow kernel state');
    assert.strictEqual(record?.kind, 'browser');
    assert.strictEqual(record?.layer, BASE_LAYER);
    assert.strictEqual(record?.canBecomeKey, true);
    assert.strictEqual(record?.acceptsInput, true);
    assert.strictEqual(record?.class, 'primary');
    assert.strictEqual(record?.role, 'main');
  });

  it('never throws and never rejects across a normal registration sequence', () => {
    // Two registrations in a row exercise the version-carrying path — a bug
    // that pins `expectedVersion` to a stale value would surface here as a
    // silently-dropped second registration.
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id: wid(2),
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelRegisterWindow(
      {
        id: wid(3),
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );

    const order = getShadowKernelExecutor().getState().order;
    assert.ok(order.some((w) => w.id === wid(2)));
    assert.ok(order.some((w) => w.id === wid(3)));
  });
});

describe('window-kernel-shadow: OS focus feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a focus gain reaches the shadow kernel as OsFocusGained, naming the window', () => {
    const id = wid(10);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );

    shadowKernelOsFocusGained(id, oldSnapshot);

    assert.strictEqual(getShadowKernelExecutor().getState().key, id);
  });

  it('the settle emits OsFocusLost naming the currently-held key', () => {
    const id = wid(11);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelOsFocusGained(id, oldSnapshot);
    assert.strictEqual(getShadowKernelExecutor().getState().key, id, 'precondition: id holds key');

    shadowKernelOsFocusSettled(oldSnapshot);

    assert.strictEqual(getShadowKernelExecutor().getState().key, null, 'OsFocusLost nulls the held key');
  });

  it('the settle emits nothing when no key is held', () => {
    // Fresh shadow kernel: nothing has ever taken key.
    assert.strictEqual(getShadowKernelExecutor().getState().key, null, 'precondition: no key held');
    const versionBefore = getShadowKernelExecutor().getState().version;

    shadowKernelOsFocusSettled(fakeOldMachine({ front: null, stackOrder: [], ids: [] }));

    // No event reached the kernel at all — version is untouched, not merely
    // key staying null (which an inert OsFocusLost would also leave true).
    assert.strictEqual(getShadowKernelExecutor().getState().version, versionBefore);
    assert.strictEqual(getShadowKernelExecutor().getState().key, null);
  });
});

describe('window-kernel-shadow: teardown feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  const teardownCases: Array<{
    name: string;
    kind: 'destroy-window' | 'close-content' | 'close-window-direct' | 'destroy-all-guests';
    call: (id: WindowId, oldSnapshot: StateSnapshot) => void;
    carriesId: boolean;
  }> = [
    { name: 'DestroyWindow', kind: 'destroy-window', call: shadowKernelDestroyWindow, carriesId: true },
    { name: 'CloseContent', kind: 'close-content', call: shadowKernelCloseContent, carriesId: true },
    { name: 'CloseWindowDirect', kind: 'close-window-direct', call: shadowKernelCloseWindowDirect, carriesId: true },
    {
      name: 'DestroyAllGuests',
      kind: 'destroy-all-guests',
      call: (_id, oldSnapshot) => shadowKernelDestroyAllGuests(oldSnapshot),
      carriesId: false,
    },
  ];

  for (const { name, kind, call, carriesId } of teardownCases) {
    it(`${name} reaches the shadow kernel (recorded on lastTeardown) — membership stays untouched (peek 7fffa286)`, () => {
      const id = wid(30);
      const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [id], ids: [id] });
      shadowKernelRegisterWindow(
        {
          id,
          kind: 'page-host',
          layer: BASE_LAYER,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
        },
        oldSnapshot,
      );
      const versionBefore = getShadowKernelExecutor().getState().version;

      call(id, oldSnapshot);

      const state = getShadowKernelExecutor().getState();
      const lastTeardown = state.lastTeardown;
      assert.strictEqual(lastTeardown?.kind, kind, `${name} must be recorded as lastTeardown`);
      if (carriesId && lastTeardown && 'id' in lastTeardown) assert.strictEqual(lastTeardown.id, id);
      assert.ok(state.version > versionBefore, `${name} must advance the kernel version`);
      // RULE 1 (window-kernel.ts): only the `WindowClosed` event shrinks
      // `order`, and that event arrives later as the native teardown's own
      // report — a report this step does not yet feed. So the registered
      // window is still a member here; this is the documented, deliberate
      // split between deciding a teardown and it actually landing (see
      // `docs/design/window-manager.md` "Decided: window teardown enters the
      // kernel as commands and leaves as effects").
      assert.ok(state.order.some((w) => w.id === id), `${name} must not remove the window from order by itself`);
    });
  }

  it('a teardown naming a window whose record is already gone is absorbed, not thrown or rejected into the caller', () => {
    const danglingId = wid(31); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    const versionBefore = getShadowKernelExecutor().getState().version;

    assert.doesNotThrow(() => shadowKernelDestroyWindow(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelCloseContent(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelCloseWindowDirect(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelDestroyAllGuests(oldSnapshot));

    // All four commands are exempt from `decide`'s unknown-window rejection
    // (window-kernel.ts, §0.1.5) — a dangling id is accepted traffic, not a
    // rejection, so the version must have advanced once per call rather than
    // staying pinned the way a genuine rejection would leave it.
    const state = getShadowKernelExecutor().getState();
    assert.strictEqual(state.version, versionBefore + 4);
    assert.strictEqual(state.lastTeardown?.kind, 'destroy-all-guests');
    assert.strictEqual(state.order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: close report feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a close report removes the window from the shadow kernel order (peek 7fffa286)', () => {
    const id = wid(40);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [id], ids: [id] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    assert.ok(
      getShadowKernelExecutor().getState().order.some((w) => w.id === id),
      'precondition: the window is a member before the close report',
    );

    shadowKernelWindowClosed(id, fakeOldMachine({ front: null, stackOrder: [], ids: [] }));

    // RULE 1 (window-kernel.ts): `WindowClosed` is the ONLY event that
    // shrinks `order`. Without this feed the shadow kernel's `order` only
    // ever grows, diverging further from reality with every real close.
    assert.ok(
      !getShadowKernelExecutor().getState().order.some((w) => w.id === id),
      'a close report must remove the window from order',
    );
  });

  it('a close report naming a window with no record is absorbed, not thrown or rejected into the caller', () => {
    const danglingId = wid(41); // never registered with the shadow kernel
    const versionBefore = getShadowKernelExecutor().getState().version;

    assert.doesNotThrow(() => shadowKernelWindowClosed(danglingId, fakeOldMachine({ front: null, stackOrder: [], ids: [] })));

    // `WindowClosed` is an event (`evolve`, not `decide`) — there is no
    // `decide`-side rejection to exempt here; `evolve`'s unconditional
    // filter simply no-ops on an id that was never a member, while the
    // dispatch itself still advances version, same as any other event.
    const state = getShadowKernelExecutor().getState();
    assert.strictEqual(state.version, versionBefore + 1);
    assert.strictEqual(state.order.length, 0, 'a dangling close report never adds a member');
  });

  it('FAILING-FIRST (peek 7fffa286): a divergence introduced by a close report — not a registration — is caught, because the comparator now runs at THIS feed helper\'s own tail', () => {
    // `a` lands in the shadow kernel via registration, matched by an
    // old-machine snapshot that agrees at THAT settled point — nothing
    // visible has been shown yet, so `topmost` (front) reads null on both
    // sides, and membership agrees (`ids: [a]` both sides). Zero divergence,
    // and this is NOT the registration path's comparison this test is about.
    const a = wid(42);
    shadowKernelRegisterWindow(
      {
        id: a,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      fakeOldMachine({ front: null, stackOrder: [a], ids: [a] }),
    );
    assert.deepStrictEqual(
      _lastDivergencesForTests(),
      [],
      'precondition: registration alone reports no divergence',
    );

    // Now feed a close report for `a` — the shadow kernel drops it from
    // `order` (RULE 1), but the caller's old-machine snapshot is built as if
    // the old machine had NOT yet retired the record (a legitimate lag: the
    // old machine's own retirement is a separate dispatch this helper does
    // not perform). That is exactly a real production shape:
    // `shadowKernelWindowClosed` is called with whatever `getWindowStateSnapshot()`
    // returns at the call site, and nothing here guarantees the two
    // retirements move in lockstep for a manufactured old-machine reading.
    const staleOldSnapshot = fakeOldMachine({ front: null, stackOrder: [a], ids: [a] });
    shadowKernelWindowClosed(a, staleOldSnapshot);

    // Under the PRE-FIX wiring (the comparator called only from
    // `window-state-singleton.ts registerWindowWithMachine`, never from
    // `shadowKernelWindowClosed` itself), this call could not possibly have
    // changed `_lastDivergencesForTests()` — nothing here dispatches a
    // registration, so the assertion below would still see the stale `[]`
    // from the precondition and fail. It passes now only because
    // `shadowKernelWindowClosed`'s own tail runs the comparator against the
    // snapshot THIS call was given.
    const divergences = _lastDivergencesForTests();
    const membership = divergences.find((d) => d.kind === 'membership');
    assert.ok(membership, 'the close report must have driven a membership divergence through its own comparator tail');
    assert.deepStrictEqual(membership?.old, [a]);
    assert.deepStrictEqual(membership?.kernel, []);
  });
});

describe('window-kernel-shadow: stack-order import feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('an import permutes only the slots the payload names, naming a partial subset with an unknown id and a duplicate (peek 7fffa286)', () => {
    const [a, b, c, d] = [wid(50), wid(51), wid(52), wid(53)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [a, b, c, d], ids: [a, b, c, d] });
    for (const id of [a, b, c, d]) {
      shadowKernelRegisterWindow(
        {
          id,
          kind: 'browser',
          layer: BASE_LAYER,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
        },
        oldSnapshot,
      );
    }
    assert.deepStrictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.map((w) => w.id),
      [a, b, c, d],
      'precondition: registration order is a, b, c, d',
    );

    // Names only 2 of the 4 registered windows (b and c are unnamed), plus an
    // id that was never registered and a duplicate of `a` — a vacuous
    // implementation that assembles the result from the payload rather than
    // from `order` cannot pass this: it has nothing to say about b/c (absent
    // from the payload entirely), and would place a/d adjacent in payload
    // order rather than back into their own original slots.
    shadowKernelImportStackOrder([d, wid(999), a, a], oldSnapshot);

    // Correct result: `d` and `a` are the only named ids, so they are written
    // back into the two slots they already occupied (index 0, originally
    // `a`'s, and index 3, originally `d`'s) in the payload's relative order
    // (d then a) — while `b` and `c` keep their own slots untouched.
    assert.deepStrictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.map((w) => w.id),
      [d, b, c, a],
      'named ids permute within their own slots; unnamed ids keep their index',
    );
  });

  it('an import naming no known window is absorbed, not thrown into the caller', () => {
    const danglingId = wid(60); // never registered with the shadow kernel
    const versionBefore = getShadowKernelExecutor().getState().version;

    assert.doesNotThrow(() =>
      shadowKernelImportStackOrder([danglingId], fakeOldMachine({ front: null, stackOrder: [], ids: [] })),
    );

    // `ImportStackOrder` is a command (`decide`), answered before the
    // unknown-window guard — a dangling id is accepted traffic, so the
    // version still advances rather than the call being rejected.
    assert.strictEqual(getShadowKernelExecutor().getState().version, versionBefore + 1);
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0);
  });
});

describe('window-kernel-shadow: divergence comparator (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('reports nothing when membership, front, and stackOrder all agree', () => {
    const [a, b] = [wid(70), wid(71)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    // `topmost` scans from the END of `order` — b was registered last, so it
    // is the kernel's front.
    assert.strictEqual(getShadowKernelExecutor().getState().order.at(-1)?.id, b, 'precondition: b is topmost');

    const oldMachine = fakeOldMachine({ front: b, stackOrder: [a, b], ids: [a, b] });

    assert.deepStrictEqual(compareShadowKernelState(oldMachine), []);
  });

  it('detects a membership divergence: an id the old machine holds that the kernel does not', () => {
    const a = wid(80);
    registerVisibleContentWindow(a, fakeOldMachine({ front: null, stackOrder: [], ids: [] }));
    const ghost = wid(81); // never reaches the shadow kernel at all

    const oldMachine = fakeOldMachine({ front: a, stackOrder: [a], ids: [a, ghost] });

    const divergences = compareShadowKernelState(oldMachine);
    const membership = divergences.find((d) => d.kind === 'membership');
    assert.ok(membership, 'a membership mismatch must be reported');
    assert.deepStrictEqual(membership?.old, [a, ghost]);
    assert.deepStrictEqual(membership?.kernel, [a]);
  });

  it('detects a front divergence: the old machine names a different main window than topmost(state, isContentWindow)', () => {
    const [a, b] = [wid(90), wid(91)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    assert.strictEqual(getShadowKernelExecutor().getState().order.at(-1)?.id, b, 'precondition: kernel front is b');

    // Old machine claims `a` is front — the drift this conversion exists to
    // surface, not to silently reconcile.
    const oldMachine = fakeOldMachine({ front: a, stackOrder: [a, b], ids: [a, b] });

    const divergences = compareShadowKernelState(oldMachine);
    const front = divergences.find((d) => d.kind === 'front');
    assert.ok(front, 'a front mismatch must be reported');
    assert.strictEqual(front?.old, a);
    assert.strictEqual(front?.kernel, b);
  });

  it('detects a stackOrder divergence: same membership, different sequence', () => {
    const [a, b, c] = [wid(100), wid(101), wid(102)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    registerVisibleContentWindow(c, oldSnapshot);
    assert.deepStrictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.map((w) => w.id),
      [a, b, c],
      'precondition: kernel order is a, b, c',
    );

    // Old machine's stackOrder disagrees on the relative order of a and b.
    const oldMachine = fakeOldMachine({ front: c, stackOrder: [b, a, c], ids: [a, b, c] });

    const divergences = compareShadowKernelState(oldMachine);
    const stackOrder = divergences.find((d) => d.kind === 'stackOrder');
    assert.ok(stackOrder, 'a stackOrder mismatch must be reported');
    assert.deepStrictEqual(stackOrder?.old, [b, a, c]);
    assert.deepStrictEqual(stackOrder?.kernel, [a, b, c]);
  });
});

describe('window-kernel-shadow: visibility feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('THE MEASURED DEFECT, pinned: a registration alone never makes a record visible — topmost(state, isContentWindow) stays null', () => {
    // `RegisterWindow` always creates a record `visible: false`
    // (window-kernel.ts) — this is the state every production window sits in
    // until something feeds a show. Without a `WindowShown` feed, `topmost`
    // can never return it: this is the live 126/126 divergence the shadow
    // kernel measured before any visibility input was wired.
    const id = wid(110);
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      fakeOldMachine({ front: null, stackOrder: [], ids: [] }),
    );

    assert.strictEqual(topmost(getShadowKernelExecutor().getState(), isContentWindow), null);
  });

  it('a registration followed by a show feed makes topmost(state, isContentWindow) return that window (the fix)', () => {
    const id = wid(111);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      oldSnapshot,
    );
    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow),
      null,
      'precondition: registration alone is not enough',
    );

    shadowKernelWindowShown(id, oldSnapshot);

    assert.strictEqual(topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id, id);
  });

  it('a hide feed reported after a show flips the record back off topmost', () => {
    const id = wid(112);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      oldSnapshot,
    );
    shadowKernelWindowShown(id, oldSnapshot);
    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      id,
      'precondition: the window is topmost after the show feed',
    );

    shadowKernelWindowHidden(id, oldSnapshot);

    assert.strictEqual(topmost(getShadowKernelExecutor().getState(), isContentWindow), null);
  });

  it('never throws across a show/hide feed naming a window with no record', () => {
    const danglingId = wid(113); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelWindowShown(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelWindowHidden(danglingId, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });

  it('AppActivated re-shows a record hiddenByAppBlur and clears the mark, mirroring the old machine (window-kernel.ts AppActivated evolve arm)', () => {
    // `isAppResignSweepEligible` (the HUD-shaped heads-up surfaces the sweep
    // hides) carries an explicit `!isContentWindow(record)` clause —
    // deliberately disjoint from `isContentWindow` by construction, so this
    // case is checked on the record directly rather than through
    // `topmost(state, isContentWindow)`, which by design never sees it either
    // way.
    const id = wid(114);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER + 1,
        canBecomeKey: false,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelWindowShown(id, oldSnapshot);
    const record = () => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.visible, true, 'precondition: the window is visible after the show feed');

    // Land the record in the exact state the old machine's app-resign sweep
    // leaves behind: hidden, marked `hiddenByAppBlur`. `AppResigned`/
    // `AppResignSettled` have no shadow feed yet, so this fixture drives the
    // kernel there directly, the same way `registerVisibleContentWindow`
    // above dispatches straight to the executor for a state no feed helper
    // produces on its own.
    getShadowKernelExecutor().dispatch({ type: 'AppResigned' });
    getShadowKernelExecutor().dispatch({ type: 'AppResignSettled' });
    assert.strictEqual(record()?.visible, false, 'precondition: the sweep hid the eligible window');
    assert.strictEqual(record()?.hiddenByAppBlur, true);

    shadowKernelAppActivated(oldSnapshot);

    assert.strictEqual(record()?.visible, true, 'AppActivated must re-show it');
    assert.strictEqual(record()?.hiddenByAppBlur, false);
  });
});

describe('window-kernel-shadow: raise feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('THE MEASURED GAP, pinned: a raise of an ALREADY-VISIBLE, non-topmost window moves topmost(state, isContentWindow) to it', () => {
    // Two visible content windows, both registered and shown — `b` lands last
    // and is topmost by construction (`topmost` scans from the end of
    // `order`), exactly the shape the live trace found: raising `a` (the
    // LOWER window) while `b` sits on top. A single-window fixture, or one
    // that raised the already-topmost `b`, would pass with no raise feed at
    // all — `topmost` would already read the raised window either way. This
    // fixture cannot pass vacuously: without a raise feed nothing ever moves
    // `a` back to the top of `order`, so `topmost` stays pinned on `b`.
    const [a, b] = [wid(120), wid(121)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being raised',
    );

    shadowKernelRaiseWindow(a, oldSnapshot);

    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      a,
      'raising the lower window must move it to topmost',
    );
  });

  it('never throws across a raise naming a window with no record', () => {
    const danglingId = wid(122); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelRaiseWindow(danglingId, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: activating show feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('THE MEASURED DEFECT, pinned: an ACTIVATING show feed on an already-visible, non-topmost window moves topmost(state, isContentWindow) to it', () => {
    // Same shape as the raise fixture above, but reached the way a reuse-open
    // actually reaches the kernel: `ipc.ts windowOpenHandler`'s reuse branches
    // and `windows.ts showWindowHeadlessSafe` dispatch `WINDOW_SHOW_REQUESTED`,
    // never `RAISE_WINDOW_REQUESTED` — so this is a SHOW feed, not a raise
    // feed. Two visible content windows, `b` topmost by construction (`b`
    // registered+shown last). An activating show feed on the LOWER window `a`
    // must move it to topmost even though `window-kernel.ts`'s `WindowShown`
    // arm itself never reorders `order` (`OsFocusGained` is its only
    // reorderer, by design) — this is exactly why `shadowKernelWindowShown`
    // must translate an activating show into a companion `OsFocusGained`.
    // This fixture cannot pass vacuously: a single-window fixture, or one that
    // activating-shows the already-topmost `b`, would pass with no companion
    // focus feed at all — `topmost` would already read the target window
    // either way. Only the lower-window case exposes the gap.
    const [a, b] = [wid(130), wid(131)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being re-shown',
    );

    shadowKernelWindowShown(a, oldSnapshot, true);

    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      a,
      'an activating show feed on the lower window must move it to topmost',
    );
  });

  it('a NON-activating show feed leaves topmost(state, isContentWindow) alone', () => {
    // Sibling of the fixture above with `focused: false` (or omitted, its
    // default) — the other half of the contract: a show report that did NOT
    // activate must not synthesize a focus gain, so `b` stays topmost. This
    // cannot pass vacuously either: `a` is already a real record in `order`
    // (registered+shown), so if the show feed WERE wrongly feeding
    // `OsFocusGained` regardless of the flag, this assertion would catch it
    // exactly the way the activating case above proves the fix is live.
    const [a, b] = [wid(132), wid(133)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(a, oldSnapshot);
    registerVisibleContentWindow(b, oldSnapshot);
    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being re-shown',
    );

    shadowKernelWindowShown(a, oldSnapshot, false);

    assert.strictEqual(
      topmost(getShadowKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'a non-activating show feed must not move topmost off b',
    );
  });
});

describe('window-kernel-shadow: overlay attach/detach feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('THE MEASURED GAP, pinned: an overlay attach reaches the shadow kernel and sets overlayFor', () => {
    // `AttachOverlay` has no production dispatcher anywhere until this feed —
    // without it, `overlayFor` stays undefined forever, even after a genuine
    // attach. Two real registered records (an overlay-shaped one and a host)
    // so the assertion cannot pass on a record that was never created.
    const [overlay, host] = [wid(200), wid(201)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(overlay, oldSnapshot);
    registerWindow(host, oldSnapshot);
    const before = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === overlay);
    assert.strictEqual(before?.overlayFor, undefined, 'precondition: a freshly registered overlay carries no overlayFor');

    shadowKernelAttachOverlay(overlay, host, oldSnapshot);

    const after = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === overlay);
    assert.strictEqual(after?.overlayFor, host, 'attach must set overlayFor to the host');
  });

  it('a retarget onto a different host moves overlayFor, never accumulates it', () => {
    const [overlay, hostA, hostB] = [wid(202), wid(203), wid(204)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(overlay, oldSnapshot);
    registerWindow(hostA, oldSnapshot);
    registerWindow(hostB, oldSnapshot);

    shadowKernelAttachOverlay(overlay, hostA, oldSnapshot);
    assert.strictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      hostA,
      'precondition: overlay is attached to hostA',
    );

    shadowKernelAttachOverlay(overlay, hostB, oldSnapshot);
    assert.strictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      hostB,
      'a retarget must replace overlayFor with the new host, not add to it',
    );
  });

  it('a detach (hostId: null) clears overlayFor', () => {
    const [overlay, host] = [wid(205), wid(206)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(overlay, oldSnapshot);
    registerWindow(host, oldSnapshot);
    shadowKernelAttachOverlay(overlay, host, oldSnapshot);
    assert.strictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      host,
      'precondition: overlay is attached',
    );

    shadowKernelAttachOverlay(overlay, null, oldSnapshot);

    assert.strictEqual(
      getShadowKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      undefined,
      'detach must clear overlayFor',
    );
  });

  it('never throws across an attach naming an overlay or host with no record', () => {
    const danglingOverlay = wid(207); // never registered
    const danglingHost = wid(208); // never registered
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelAttachOverlay(danglingOverlay, danglingHost, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling attach joins nothing');
  });
});

describe('window-kernel-shadow: app-resign feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('AppResigned arms pendingAppResignSweep and clears appActive, mirroring the old machine (window-kernel.ts AppResigned evolve arm)', () => {
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    shadowKernelAppResigned(oldSnapshot);

    const state = getShadowKernelExecutor().getState();
    assert.strictEqual(state.appActive, false, 'AppResigned must clear appActive');
    assert.strictEqual(state.pendingAppResignSweep, true, 'AppResigned must arm the sweep');
  });

  it('AppResignSettled hides a sweep-eligible record and marks lastAttention.holder null, the write react\'s dismissal rule reads (window-kernel.ts AppResignSettled evolve arm)', () => {
    // Same eligibility shape as the AppActivated re-show test above
    // (`isAppResignSweepEligible`: visible, layer > BASE_LAYER, acceptsInput,
    // not self-closing, not content) — a HUD-shaped surface, not a content
    // window.
    const id = wid(115);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER + 1,
        canBecomeKey: false,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelWindowShown(id, oldSnapshot);
    const record = () => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.visible, true, 'precondition: the window is visible after the show feed');

    shadowKernelAppResigned(oldSnapshot);
    shadowKernelAppResignSettled(oldSnapshot);

    assert.strictEqual(record()?.visible, false, 'AppResignSettled must hide the sweep-eligible window');
    assert.strictEqual(record()?.hiddenByAppBlur, true);
    assert.strictEqual(
      getShadowKernelExecutor().getState().lastAttention?.holder,
      null,
      'a resign that settled without an intervening AppActivated must clear lastAttention.holder',
    );
  });

  it('never throws across an app-resign feed with nothing registered', () => {
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelAppResigned(oldSnapshot));
    assert.doesNotThrow(() => shadowKernelAppResignSettled(oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'no record to touch');
  });
});

describe('window-kernel-shadow: content orderable feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('THE MEASURED DEFECT, pinned: without the feed a shown page-host stays permanently non-orderable and topmostBaseLayerPageHost reads null', () => {
    const id = wid(140);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      oldSnapshot,
    );
    shadowKernelWindowShown(id, oldSnapshot);

    assert.strictEqual(
      topmostBaseLayerPageHost(getShadowKernelExecutor().getState()),
      null,
      'visible alone is not enough — orderable is still false',
    );
  });

  it('a first-composited-frame feed flips orderable to true, and topmostBaseLayerPageHost returns the record (the fix)', () => {
    const id = wid(141);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      },
      oldSnapshot,
    );
    shadowKernelWindowShown(id, oldSnapshot);
    assert.strictEqual(
      topmostBaseLayerPageHost(getShadowKernelExecutor().getState()),
      null,
      'precondition: not orderable yet',
    );

    shadowKernelWindowContentOrderable(id, oldSnapshot);

    const record = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.orderable, true, 'the feed must flip orderable to true');
    assert.strictEqual(
      topmostBaseLayerPageHost(getShadowKernelExecutor().getState())?.id,
      id,
      'topmostBaseLayerPageHost must now return the record',
    );
  });

  it('never throws across a content-orderable feed naming a window with no record', () => {
    const danglingId = wid(142); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelWindowContentOrderable(danglingId, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: content first responder feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a held report reaches the shadow kernel as contentFocused: true, naming the window', () => {
    const id = wid(150);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );

    shadowKernelContentFirstResponderChanged(id, true, oldSnapshot);

    const record = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.contentFocused, true);
  });

  it('a released report flips it back to false', () => {
    const id = wid(151);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelContentFirstResponderChanged(id, true, oldSnapshot);
    const record = () => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.contentFocused, true, 'precondition: held');

    shadowKernelContentFirstResponderChanged(id, false, oldSnapshot);

    assert.strictEqual(record()?.contentFocused, false);
  });

  it('never throws across a content-first-responder feed naming a window with no record', () => {
    const danglingId = wid(152); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelContentFirstResponderChanged(danglingId, true, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: window accepts-input feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a click-through report reaches the shadow kernel as acceptsInput: false, naming the window', () => {
    const id = wid(160);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );

    shadowKernelWindowAcceptsInputChanged(id, false, oldSnapshot);

    const record = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.acceptsInput, false);
  });

  it('a capturing report flips it back to true', () => {
    const id = wid(161);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      },
      oldSnapshot,
    );
    shadowKernelWindowAcceptsInputChanged(id, false, oldSnapshot);
    const record = () => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.acceptsInput, false, 'precondition: click-through');

    shadowKernelWindowAcceptsInputChanged(id, true, oldSnapshot);

    assert.strictEqual(record()?.acceptsInput, true);
  });

  it('never throws across an accepts-input feed naming a window with no record', () => {
    const danglingId = wid(162); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelWindowAcceptsInputChanged(danglingId, false, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: cold-start focus latch feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('arming with a real id writes pendingColdStartFocus', () => {
    const id = wid(160);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    shadowKernelArmColdStartFocus(id, oldSnapshot);

    assert.strictEqual(getShadowKernelExecutor().getState().pendingColdStartFocus, id);
  });

  it('arming with null clears a previously-armed latch', () => {
    const id = wid(161);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelArmColdStartFocus(id, oldSnapshot);
    assert.strictEqual(
      getShadowKernelExecutor().getState().pendingColdStartFocus,
      id,
      'precondition: latch armed',
    );

    shadowKernelArmColdStartFocus(null, oldSnapshot);

    assert.strictEqual(getShadowKernelExecutor().getState().pendingColdStartFocus, null);
  });

  it('never throws arming a latch with an id naming no registered window', () => {
    const danglingId = wid(162); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelArmColdStartFocus(danglingId, oldSnapshot));
    // Not exempt from being recorded — ArmColdStartFocus answers before the
    // unknown-window guard, so an id naming nothing is legitimate traffic,
    // not a rejection (window-kernel.ts decide's ArmColdStartFocus arm).
    assert.strictEqual(getShadowKernelExecutor().getState().pendingColdStartFocus, danglingId);
  });
});

describe('window-kernel-shadow: focus assert feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('asserting focus on a registered content window records lastFocusAssert', () => {
    const id = wid(170);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerVisibleContentWindow(id, oldSnapshot);

    shadowKernelAssertFocus(id, oldSnapshot);

    assert.strictEqual(getShadowKernelExecutor().getState().lastFocusAssert?.id, id);
  });

  it('a target with no record is rejected (logged, never thrown into the caller) and advances nothing', () => {
    const danglingId = wid(171); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    const versionBefore = getShadowKernelExecutor().getState().version;

    assert.doesNotThrow(() => shadowKernelAssertFocus(danglingId, oldSnapshot));

    // AssertFocus is NOT exempt from decide's unknown-window rejection
    // (window-kernel.ts, AssertFocus's own doc) — unlike the four teardown
    // commands, a dangling target is a genuine rejection, so version must
    // stay pinned.
    assert.strictEqual(getShadowKernelExecutor().getState().version, versionBefore);
  });
});

describe('window-kernel-shadow: fullscreen feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  const record = (id: WindowId) => getShadowKernelExecutor().getState().order.find((w) => w.id === id);

  it('SetFullscreen(true) on an idle window starts entering, and the following OsFullscreenEntered settles it to fullscreen', () => {
    const id = wid(180);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'normal', 'precondition: a freshly registered window starts normal');

    shadowKernelSetFullscreen(id, true, oldSnapshot);

    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'SetFullscreen(true) on an idle window must start entering');

    shadowKernelOsFullscreenEntered(id, oldSnapshot);

    assert.strictEqual(record(id)?.fsMode.name, 'fullscreen', 'OsFullscreenEntered must settle entering -> fullscreen');
  });

  it('SetFullscreen(false) on a fullscreen window starts leaving, and the following OsFullscreenLeft settles it back to normal', () => {
    const id = wid(181);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelSetFullscreen(id, true, oldSnapshot);
    shadowKernelOsFullscreenEntered(id, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'fullscreen', 'precondition: the window is fullscreen');

    shadowKernelSetFullscreen(id, false, oldSnapshot);

    assert.strictEqual(record(id)?.fsMode.name, 'leaving', 'SetFullscreen(false) on a fullscreen window must start leaving');

    shadowKernelOsFullscreenLeft(id, oldSnapshot);

    assert.strictEqual(record(id)?.fsMode.name, 'normal', 'OsFullscreenLeft must settle leaving -> normal');
  });

  it('a SetFullscreen arriving mid-transition records the desire rather than restarting the transition', () => {
    const id = wid(182);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelSetFullscreen(id, true, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: the window is entering');

    shadowKernelSetFullscreen(id, false, oldSnapshot);

    const mode = record(id)?.fsMode;
    assert.strictEqual(
      mode?.name,
      'entering',
      'a request arriving mid-transition must not restart or advance the transition',
    );
    if (mode?.name !== 'entering') throw new Error('unreachable — asserted above');
    assert.strictEqual(mode.pendingDesire, false, 'the coalesced desire is recorded on the still-in-flight mode');
  });

  it('a settle timeout on an in-flight window writes a fresh lastFsReconcile naming it and leaves fsMode transitional (8152196c: the machine asks the OS rather than guessing)', () => {
    const id = wid(183);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelSetFullscreen(id, true, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: the window is entering');
    assert.strictEqual(
      getShadowKernelExecutor().getState().lastFsReconcile,
      null,
      'precondition: nothing has asked for a reconcile yet',
    );

    shadowKernelFullscreenSettleTimeout(id, oldSnapshot);

    const state = getShadowKernelExecutor().getState();
    assert.deepStrictEqual(
      state.lastFsReconcile,
      { ids: [id], seq: 1 },
      'the settle timeout must record a fresh reconcile ask naming the in-flight window',
    );
    assert.strictEqual(
      record(id)?.fsMode.name,
      'entering',
      'fsMode must be left exactly where it was — a wrong guess would strand preBounds or leave a black Space',
    );
  });

  it('never throws across a fullscreen feed naming a window with no record', () => {
    const danglingId = wid(184); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelOsFullscreenEntered(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelOsFullscreenLeft(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelFullscreenSettleTimeout(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelSetFullscreen(danglingId, true, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: geometry feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  const record = (id: WindowId) => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
  const RECT_A = { x: 10, y: 20, width: 300, height: 400 };
  const RECT_B = { x: 50, y: 60, width: 500, height: 600 };

  it('a bounds change lands on the record\'s bounds', () => {
    const id = wid(190);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    assert.strictEqual(record(id)?.bounds, undefined, 'precondition: no rect has ever been reported');

    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);

    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'BoundsChanged must be the sole writer of the mirror');
  });

  it('SetBounds on a record whose fsMode is not normal is refused by decide and leaves bounds untouched', () => {
    const id = wid(191);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);
    shadowKernelSetFullscreen(id, true, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: fsMode is non-normal');

    shadowKernelSetBounds(id, RECT_B, oldSnapshot);

    assert.deepStrictEqual(
      record(id)?.bounds,
      RECT_A,
      'fullscreen owns the display — decide must answer [] and leave the mirror exactly where it was',
    );
  });

  it('a display change repositions every named window and leaves unnamed ones alone', () => {
    const [a, b] = [wid(192), wid(193)];
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(a, oldSnapshot);
    registerWindow(b, oldSnapshot);
    shadowKernelBoundsChanged(a, RECT_A, oldSnapshot);
    shadowKernelBoundsChanged(b, RECT_A, oldSnapshot);
    // A hidden record's projection is BLOCKED (evolve's DisplayChanged arm
    // holds it on pendingProjectedBounds instead) — `visible: true` is what
    // this test needs unblocked, so show both windows first.
    getShadowKernelExecutor().dispatch({ type: 'WindowShown', id: a });
    getShadowKernelExecutor().dispatch({ type: 'WindowShown', id: b });

    shadowKernelDisplayChanged([{ id: a, bounds: RECT_B }], oldSnapshot);

    assert.deepStrictEqual(record(a)?.bounds, RECT_B, 'the named window must be repositioned');
    assert.deepStrictEqual(record(b)?.bounds, RECT_A, 'a window absent from the projection must be left untouched');
  });

  it('MaximizeExitedByResize clears maximized and preMaxBounds without touching bounds', () => {
    const id = wid(194);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);
    shadowKernelMaximize(id, oldSnapshot);
    assert.strictEqual(record(id)?.maximized, true, 'precondition: the window is maximized');

    shadowKernelMaximizeExitedByResize(id, oldSnapshot);

    assert.strictEqual(record(id)?.maximized, false, 'a resize gesture must invalidate maximize');
    assert.strictEqual(record(id)?.preMaxBounds, null, 'the stash must be cleared alongside the flag');
  });

  it('never throws across a geometry feed naming a window with no record', () => {
    const danglingId = wid(195); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelBoundsChanged(danglingId, RECT_A, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelDisplayChanged([{ id: danglingId, bounds: RECT_A }], oldSnapshot));
    assert.doesNotThrow(() => shadowKernelMaximizeExitedByResize(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelSetBounds(danglingId, RECT_A, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: maximize / unmaximize feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  const record = (id: WindowId) => getShadowKernelExecutor().getState().order.find((w) => w.id === id);
  const RECT_A = { x: 10, y: 20, width: 300, height: 400 };
  const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

  it('maximize then unmaximize round-trips the bounds through the stash', () => {
    const id = wid(210);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);

    shadowKernelMaximize(id, oldSnapshot);

    assert.strictEqual(record(id)?.maximized, true, 'Maximize must set the flag');
    assert.deepStrictEqual(record(id)?.preMaxBounds, RECT_A, 'decide stashes preMaxBounds from the bounds mirror');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'Maximized itself never writes bounds — the dispatch site snaps it separately');

    // Mirrors the real dispatch site: a separate SetBounds drives the visual snap.
    shadowKernelSetBounds(id, WORK_AREA, oldSnapshot);
    assert.deepStrictEqual(record(id)?.bounds, WORK_AREA, 'precondition: the window is snapped to the work area');

    shadowKernelUnmaximize(id, oldSnapshot);

    assert.strictEqual(record(id)?.maximized, false, 'Unmaximize must clear the flag');
    assert.strictEqual(record(id)?.preMaxBounds, null, 'Unmaximize must clear the stash');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'the stash must restore bounds back to the pre-maximize rect');
  });

  it('Maximize on a record whose fsMode is not normal is refused by decide', () => {
    const id = wid(211);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);
    shadowKernelSetFullscreen(id, true, oldSnapshot);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: fsMode is non-normal');

    shadowKernelMaximize(id, oldSnapshot);

    assert.strictEqual(record(id)?.maximized, false, 'fullscreen owns the display — decide must answer [] ');
  });

  it('Unmaximize on a not-maximized record is a no-op', () => {
    const id = wid(212);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    shadowKernelBoundsChanged(id, RECT_A, oldSnapshot);

    shadowKernelUnmaximize(id, oldSnapshot);

    assert.strictEqual(record(id)?.maximized, false, 'still not maximized');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'nothing to restore — bounds must stay put');
  });

  it('never throws across a maximize/unmaximize feed naming a window with no record', () => {
    const danglingId = wid(213); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelMaximize(danglingId, oldSnapshot));
    assert.doesNotThrow(() => shadowKernelUnmaximize(danglingId, oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

// `shadowKernelSetDesktopMembership` is the one helper behind all THREE
// production feed sites (`window-kernel-shadow.ts`'s own doc names them):
// `tile-ipc.ts`'s raw `tile:window:set-visible-on-all-workspaces` handler
// (boolean translated to an intention before the call), and `ipc.ts`'s
// `windowOpenHandler()` + its keepLive-reuse path (role-derived, already an
// intention at the call site). All three move kernel state through this one
// function, so exercising it here covers what each site actually changes.
describe('window-kernel-shadow: desktop membership feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  const record = (id: WindowId) => getShadowKernelExecutor().getState().order.find((w) => w.id === id);

  it('starts undefined, then moves to the requested intention', () => {
    const id = wid(230);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(id, oldSnapshot);
    assert.strictEqual(record(id)?.desktopMembership, undefined, 'precondition: nobody has asked yet');

    shadowKernelSetDesktopMembership(id, 'follow', oldSnapshot);
    assert.strictEqual(record(id)?.desktopMembership, 'follow', 'the tile-ipc raw-boolean feed (true -> follow)');

    shadowKernelSetDesktopMembership(id, 'anchor', oldSnapshot);
    assert.strictEqual(record(id)?.desktopMembership, 'anchor', 'the tile-ipc raw-boolean feed (false -> anchor)');
  });

  it('moves kernel state for a fresh open (windowOpenHandler feed) and a keepLive reuse (reuse-path feed)', () => {
    const opened = wid(232);
    const reused = wid(233);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    registerWindow(opened, oldSnapshot);
    registerWindow(reused, oldSnapshot);

    // windowOpenHandler(): role-derived, either intention.
    shadowKernelSetDesktopMembership(opened, 'anchor', oldSnapshot);
    assert.strictEqual(record(opened)?.desktopMembership, 'anchor');

    // keepLive-reuse path: only ever reached for 'follow' (an anchored
    // window's creation-time pair must not be replayed on reuse).
    shadowKernelSetDesktopMembership(reused, 'follow', oldSnapshot);
    assert.strictEqual(record(reused)?.desktopMembership, 'follow');
  });

  it('never throws naming a window with no record', () => {
    const danglingId = wid(231); // never registered with the shadow kernel
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });

    assert.doesNotThrow(() => shadowKernelSetDesktopMembership(danglingId, 'follow', oldSnapshot));
    assert.strictEqual(getShadowKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-shadow: executor provider seam', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('with no provider installed, returns the same (default, noop-backed) instance across calls', () => {
    const first = getShadowKernelExecutor();
    const second = getShadowKernelExecutor();
    assert.strictEqual(first, second, "today's memoized behavior — unchanged by the seam's presence");
  });

  it('a feed helper lands on the installed provider\'s executor, not the default one', () => {
    // Obtain (and memoize) the default instance BEFORE installing a provider,
    // so the test can prove the feed below does NOT reach it.
    const defaultExecutor = getShadowKernelExecutor();

    const injectedExecutor = new WindowKernelExecutor(new InertBackend());
    setKernelExecutorProvider(() => injectedExecutor);
    assert.strictEqual(
      getShadowKernelExecutor(),
      injectedExecutor,
      'the accessor must return the installed provider\'s executor',
    );

    const id = wid(900);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    shadowKernelRegisterWindow(
      { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      oldSnapshot,
    );

    const onInjected = injectedExecutor.getState().order.find((w) => w.id === id);
    assert.ok(onInjected !== undefined, "shadowKernelRegisterWindow's dispatch must land on the injected executor");

    const onDefault = defaultExecutor.getState().order.find((w) => w.id === id);
    assert.strictEqual(onDefault, undefined, 'the default noop-backed executor must never see this registration');
  });

  it('_resetShadowKernelForTests clears the installed provider', () => {
    const injectedExecutor = new WindowKernelExecutor(new InertBackend());
    setKernelExecutorProvider(() => injectedExecutor);
    assert.strictEqual(getShadowKernelExecutor(), injectedExecutor);

    _resetShadowKernelForTests();

    const backToDefault = getShadowKernelExecutor();
    assert.notStrictEqual(
      backToDefault,
      injectedExecutor,
      'after reset the accessor must be back on a fresh default instance, not the cleared provider',
    );
  });

  it('throws when a listener is already subscribed to the noop-backed fallback before a provider is installed', () => {
    // Subscribing (with no provider installed yet) constructs and binds to
    // the fallback — the exact shape `initHybridOverlay()` would produce if
    // it ever ran before `initWindowStateMachine()` installs the provider.
    const unsub = getShadowKernelExecutor().subscribe(() => {});
    try {
      assert.throws(
        () => setKernelExecutorProvider(() => new WindowKernelExecutor(new InertBackend())),
        /pre-cutover fallback executor/,
        'a subscriber orphaned by the swap must fail loudly, not silently go dead',
      );
    } finally {
      unsub();
    }
  });

  it('does not throw when the fallback was merely constructed (feeds ran) with no subscriber ever attached', () => {
    const id = wid(901);
    const oldSnapshot = fakeOldMachine({ front: null, stackOrder: [], ids: [] });
    // Constructs the fallback via the ordinary feed path — nobody subscribes.
    shadowKernelRegisterWindow(
      { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' },
      oldSnapshot,
    );

    assert.doesNotThrow(() => setKernelExecutorProvider(() => new WindowKernelExecutor(new InertBackend())));
  });
});
