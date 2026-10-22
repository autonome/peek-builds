/**
 * Unit tests for `window-kernel-dispatch.ts` — the kernel's registration
 * feed. Harness conventions follow `window-kernel-executor.test.ts`
 * (`node:test` + `node:assert`, `.js`-suffixed import of the compiled output).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  _resetKernelForTests,
  getKernelExecutor,
  setKernelExecutorProvider,
  kernelAppActivated,
  kernelAppResigned,
  kernelAppResignSettled,
  kernelArmColdStartFocus,
  kernelAssertFocus,
  kernelAttachOverlay,
  kernelCloseContent,
  kernelCloseWindowDirect,
  kernelContentFirstResponderChanged,
  kernelDestroyAllGuests,
  kernelDestroyWindow,
  kernelFullscreenSettleTimeout,
  kernelImportStackOrder,
  kernelOsFocusGained,
  kernelOsFocusSettled,
  kernelOsFullscreenEntered,
  kernelOsFullscreenLeft,
  kernelRegisterWindow,
  kernelSetFullscreen,
  kernelShowRequested,
  kernelWindowClosed,
  kernelWindowContentOrderable,
  kernelWindowHidden,
  kernelWindowShown,
  kernelBoundsChanged,
  kernelDisplayChanged,
  kernelMaximizeExitedByResize,
  kernelSetBounds,
  kernelMaximize,
  kernelUnmaximize,
  kernelSetDesktopMembership,
  kernelWindowAcceptsInputChanged,
} from './window-kernel-dispatch.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { BASE_LAYER, isContentWindow, topmost, topmostBaseLayerPageHost, type WindowId } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import { reuseShowActivation, type StackingLevel } from './izui-roles.js';

const wid = (n: number): WindowId => `shadow-${n}` as WindowId;

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
  reopenAsOrdinaryWindow(): void {}
  destroyAllContentGuests(): Promise<void> {
    return Promise.resolve();
  }
  hideApp(): void {}
  activateApp(): void {}
  setStacking(_id: WindowId, _level: StackingLevel): void {}
  setWindowBounds(_id: WindowId, _rect: Rect): void {}
  setDesktopMembership(): void {}
  setAcceptsInput(): void {}
  attachOverlayTo(): void {}
}

/** Registers a plain window in the kernel — enough for `AttachOverlay`'s existence checks, nothing more. */
function registerWindow(id: WindowId): void {
  kernelRegisterWindow(
    { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' });
}

/** Registers a visible content-role window in the kernel — the shape `isContentWindow`/`topmost` admit. */
function registerVisibleContentWindow(id: WindowId): void {
  kernelRegisterWindow(
    {
      id,
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      role: 'content',
    });
  getKernelExecutor().dispatch({ type: 'WindowShown', id });
}

describe('window-kernel-dispatch: registration feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('a registration reaches the kernel state (peek 7fffa286)', () => {
    const id = wid(1);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'main',
      });

    const record = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.ok(record !== undefined, 'the registered window must appear in the kernel state');
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
    kernelRegisterWindow(
      {
        id: wid(2),
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
    kernelRegisterWindow(
      {
        id: wid(3),
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });

    const order = getKernelExecutor().getState().order;
    assert.ok(order.some((w) => w.id === wid(2)));
    assert.ok(order.some((w) => w.id === wid(3)));
  });
});

describe('window-kernel-dispatch: OS focus feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('a focus gain reaches the kernel as OsFocusGained, naming the window', () => {
    const id = wid(10);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });

    kernelOsFocusGained(id);

    assert.strictEqual(getKernelExecutor().getState().key, id);
  });

  it('the settle emits OsFocusLost naming the currently-held key', () => {
    const id = wid(11);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
    kernelOsFocusGained(id);
    assert.strictEqual(getKernelExecutor().getState().key, id, 'precondition: id holds key');

    kernelOsFocusSettled();

    assert.strictEqual(getKernelExecutor().getState().key, null, 'OsFocusLost nulls the held key');
  });

  it('the settle emits nothing when no key is held', () => {
    // Fresh kernel: nothing has ever taken key.
    assert.strictEqual(getKernelExecutor().getState().key, null, 'precondition: no key held');
    const versionBefore = getKernelExecutor().getState().version;

    kernelOsFocusSettled();

    // No event reached the kernel at all — version is untouched, not merely
    // key staying null (which an inert OsFocusLost would also leave true).
    assert.strictEqual(getKernelExecutor().getState().version, versionBefore);
    assert.strictEqual(getKernelExecutor().getState().key, null);
  });
});

describe('window-kernel-dispatch: teardown feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  const teardownCases: Array<{
    name: string;
    kind: 'destroy-window' | 'close-content' | 'close-window-direct' | 'destroy-all-guests';
    call: (id: WindowId) => void;
    carriesId: boolean;
  }> = [
    { name: 'DestroyWindow', kind: 'destroy-window', call: kernelDestroyWindow, carriesId: true },
    { name: 'CloseContent', kind: 'close-content', call: kernelCloseContent, carriesId: true },
    { name: 'CloseWindowDirect', kind: 'close-window-direct', call: kernelCloseWindowDirect, carriesId: true },
    {
      name: 'DestroyAllGuests',
      kind: 'destroy-all-guests',
      call: () => kernelDestroyAllGuests(),
      carriesId: false,
    },
  ];

  for (const { name, kind, call, carriesId } of teardownCases) {
    it(`${name} reaches the kernel (recorded on lastTeardown) — membership stays untouched (peek 7fffa286)`, () => {
      const id = wid(30);
      kernelRegisterWindow(
        {
          id,
          kind: 'page-host',
          layer: BASE_LAYER,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
        });
      const versionBefore = getKernelExecutor().getState().version;

      call(id);

      const state = getKernelExecutor().getState();
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
    const danglingId = wid(31); // never registered with the kernel
    const versionBefore = getKernelExecutor().getState().version;

    assert.doesNotThrow(() => kernelDestroyWindow(danglingId));
    assert.doesNotThrow(() => kernelCloseContent(danglingId));
    assert.doesNotThrow(() => kernelCloseWindowDirect(danglingId));
    assert.doesNotThrow(() => kernelDestroyAllGuests());

    // All four commands are exempt from `decide`'s unknown-window rejection
    // (window-kernel.ts, §0.1.5) — a dangling id is accepted traffic, not a
    // rejection, so the version must have advanced once per call rather than
    // staying pinned the way a genuine rejection would leave it.
    const state = getKernelExecutor().getState();
    assert.strictEqual(state.version, versionBefore + 4);
    assert.strictEqual(state.lastTeardown?.kind, 'destroy-all-guests');
    assert.strictEqual(state.order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: close report feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('a close report removes the window from the kernel order (peek 7fffa286)', () => {
    const id = wid(40);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
    assert.ok(
      getKernelExecutor().getState().order.some((w) => w.id === id),
      'precondition: the window is a member before the close report',
    );

    kernelWindowClosed(id);

    // RULE 1 (window-kernel.ts): `WindowClosed` is the ONLY event that
    // shrinks `order`. Without this feed the kernel's `order` only
    // ever grows, diverging further from reality with every real close.
    assert.ok(
      !getKernelExecutor().getState().order.some((w) => w.id === id),
      'a close report must remove the window from order',
    );
  });

  it('a close report naming a window with no record is absorbed, not thrown or rejected into the caller', () => {
    const danglingId = wid(41); // never registered with the kernel
    const versionBefore = getKernelExecutor().getState().version;

    assert.doesNotThrow(() => kernelWindowClosed(danglingId));

    // `WindowClosed` is an event (`evolve`, not `decide`) — there is no
    // `decide`-side rejection to exempt here; `evolve`'s unconditional
    // filter simply no-ops on an id that was never a member, while the
    // dispatch itself still advances version, same as any other event.
    const state = getKernelExecutor().getState();
    assert.strictEqual(state.version, versionBefore + 1);
    assert.strictEqual(state.order.length, 0, 'a dangling close report never adds a member');
  });

});

describe('window-kernel-dispatch: stack-order import feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('an import permutes only the slots the payload names, naming a partial subset with an unknown id and a duplicate (peek 7fffa286)', () => {
    const [a, b, c, d] = [wid(50), wid(51), wid(52), wid(53)];
    for (const id of [a, b, c, d]) {
      kernelRegisterWindow(
        {
          id,
          kind: 'browser',
          layer: BASE_LAYER,
          canBecomeKey: true,
          acceptsInput: true,
          class: 'primary',
        });
    }
    assert.deepStrictEqual(
      getKernelExecutor()
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
    kernelImportStackOrder([d, wid(999), a, a]);

    // Correct result: `d` and `a` are the only named ids, so they are written
    // back into the two slots they already occupied (index 0, originally
    // `a`'s, and index 3, originally `d`'s) in the payload's relative order
    // (d then a) — while `b` and `c` keep their own slots untouched.
    assert.deepStrictEqual(
      getKernelExecutor()
        .getState()
        .order.map((w) => w.id),
      [d, b, c, a],
      'named ids permute within their own slots; unnamed ids keep their index',
    );
  });

  it('an import naming no known window is absorbed, not thrown into the caller', () => {
    const danglingId = wid(60); // never registered with the kernel
    const versionBefore = getKernelExecutor().getState().version;

    assert.doesNotThrow(() =>
      kernelImportStackOrder([danglingId]),
    );

    // `ImportStackOrder` is a command (`decide`), answered before the
    // unknown-window guard — a dangling id is accepted traffic, so the
    // version still advances rather than the call being rejected.
    assert.strictEqual(getKernelExecutor().getState().version, versionBefore + 1);
    assert.strictEqual(getKernelExecutor().getState().order.length, 0);
  });
});

describe('window-kernel-dispatch: visibility feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('THE MEASURED DEFECT, pinned: a registration alone never makes a record visible — topmost(state, isContentWindow) stays null', () => {
    // `RegisterWindow` always creates a record `visible: false`
    // (window-kernel.ts) — this is the state every production window sits in
    // until something feeds a show. Without a `WindowShown` feed, `topmost`
    // can never return it: this is the live 126/126 divergence the
    // kernel measured before any visibility input was wired.
    const id = wid(110);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      });

    assert.strictEqual(topmost(getKernelExecutor().getState(), isContentWindow), null);
  });

  it('a registration followed by a show feed makes topmost(state, isContentWindow) return that window (the fix)', () => {
    const id = wid(111);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      });
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow),
      null,
      'precondition: registration alone is not enough',
    );

    kernelWindowShown(id);

    assert.strictEqual(topmost(getKernelExecutor().getState(), isContentWindow)?.id, id);
  });

  it('a hide feed reported after a show flips the record back off topmost', () => {
    const id = wid(112);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      });
    kernelWindowShown(id);
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      id,
      'precondition: the window is topmost after the show feed',
    );

    kernelWindowHidden(id);

    assert.strictEqual(topmost(getKernelExecutor().getState(), isContentWindow), null);
  });

  it('never throws across a show/hide feed naming a window with no record', () => {
    const danglingId = wid(113); // never registered with the kernel

    assert.doesNotThrow(() => kernelWindowShown(danglingId));
    assert.doesNotThrow(() => kernelWindowHidden(danglingId));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });

  it('AppActivated re-shows a record hiddenByAppBlur and clears the mark, mirroring the old machine (window-kernel.ts AppActivated evolve arm)', () => {
    // `isAppResignSweepEligible` (the HUD-shaped heads-up surfaces the sweep
    // hides) carries an explicit `!isContentWindow(record)` clause —
    // deliberately disjoint from `isContentWindow` by construction, so this
    // case is checked on the record directly rather than through
    // `topmost(state, isContentWindow)`, which by design never sees it either
    // way.
    const id = wid(114);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER + 1,
        canBecomeKey: false,
        acceptsInput: true,
        class: 'primary',
      });
    kernelWindowShown(id);
    const record = () => getKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.visible, true, 'precondition: the window is visible after the show feed');

    // Land the record in the exact state the old machine's app-resign sweep
    // leaves behind: hidden, marked `hiddenByAppBlur`. `AppResigned`/
    // `AppResignSettled` have no feed exercised here yet, so this fixture drives the
    // kernel there directly, the same way `registerVisibleContentWindow`
    // above dispatches straight to the executor for a state no feed helper
    // produces on its own.
    getKernelExecutor().dispatch({ type: 'AppResigned' });
    getKernelExecutor().dispatch({ type: 'AppResignSettled' });
    assert.strictEqual(record()?.visible, false, 'precondition: the sweep hid the eligible window');
    assert.strictEqual(record()?.hiddenByAppBlur, true);

    kernelAppActivated();

    assert.strictEqual(record()?.visible, true, 'AppActivated must re-show it');
    assert.strictEqual(record()?.hiddenByAppBlur, false);
  });
});

describe('window-kernel-dispatch: raise feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('THE MEASURED GAP, pinned: an activating show of an ALREADY-VISIBLE, non-topmost window moves topmost(state, isContentWindow) to it once the OS confirms the raise', () => {
    // Two visible content windows, both registered and shown — `b` lands last
    // and is topmost by construction (`topmost` scans from the end of
    // `order`), exactly the shape the live trace found: raising `a` (the
    // LOWER window) while `b` sits on top. A single-window fixture, or one
    // that raised the already-topmost `b`, would pass with no raise feed at
    // all — `topmost` would already read the raised window either way. This
    // fixture cannot pass vacuously: without a raise feed nothing ever moves
    // `a` back to the top of `order`, so `topmost` stays pinned on `b`. Driven
    // through `kernelShowRequested(id, true)` — the live production entry
    // point for an explicit raise (`windows.ts showWindowHeadlessSafe`'s
    // `active`/non-`inactive` branch, the path a switcher selection reaches)
    // — rather than a direct `RaiseWindow` translation, which has no
    // production caller.
    //
    // `kernelShowRequested` alone only ASKS for the raise (RULE 2: `key` moves
    // only off `OsFocusGained`) — `InertBackend.raiseWindow` performs nothing,
    // so nothing confirms it on its own. This feed stands in for the real
    // backend's echo, carrying the opSeq the request stamped.
    const [a, b] = [wid(120), wid(121)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being raised',
    );

    kernelShowRequested(a, true);
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'the request alone does not move it — that is RULE 2, not a gap',
    );
    kernelOsFocusGained(a, { kind: 'machine', opSeq: getKernelExecutor().getState().opSeqCounter });

    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      a,
      'raising the lower window must move it to topmost once the OS confirms it',
    );
  });

  it('never throws across an activating show naming a window with no record', () => {
    const danglingId = wid(122); // never registered with the kernel

    assert.doesNotThrow(() => kernelShowRequested(danglingId, true));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });

  it("`activation: 'user'` puts user intent on the raise request — the hotkey channel (window-rules.md F6)", () => {
    // The palette hotkey and `peek-cli cmd-open` reach the kernel through
    // this option. `intent` no longer rides a `FocusCause` (there is no
    // `OsFocusGained` at request time to carry one) — it rides
    // `State.lastRaiseRequest`, which `react` reads back onto the
    // `RaiseWindow` effect the executor's app-inactive mask then exempts.
    const [a, b] = [wid(123), wid(124)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);

    kernelShowRequested(a, true, { activation: 'user' });

    assert.strictEqual(getKernelExecutor().getState().lastRaiseRequest?.id, a, 'the request names a');
    assert.strictEqual(getKernelExecutor().getState().lastRaiseRequest?.intent, 'user');
  });

  it('a reuse of an open page by a regular (command line) open, while the app is inactive, raises it with user intent', () => {
    // `ipc.ts windowOpenHandler`'s hybrid reuse branches pass
    // `reuseShowActivation(options)` to `kernelShowRequested`; the command
    // line opens with `regular: true, activation: 'user'`.
    const [a, b] = [wid(127), wid(128)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    kernelAppResigned();
    assert.strictEqual(getKernelExecutor().getState().appActive, false);

    kernelShowRequested(a, true, reuseShowActivation({ regular: true, activation: 'user' }));

    const request = getKernelExecutor().getState().lastRaiseRequest;
    assert.strictEqual(request?.id, a, 'the request names the reused page');
    assert.strictEqual(request?.intent, 'user');
  });

  it('a reuse of a kept peek (modal panel), while the app is inactive, raises it with user intent', () => {
    // A peek's global hotkey with another app frontmost reaches the hybrid
    // key-reuse branch with `{ modal: true, type: 'panel' }` and no
    // `activation`. Without user intent the raise is not admitted while the
    // app is inactive: the peek is shown but never takes key, so keystrokes
    // reach the app behind it.
    const [a, b] = [wid(129), wid(130)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    kernelAppResigned();
    assert.strictEqual(getKernelExecutor().getState().appActive, false);

    kernelShowRequested(a, true, reuseShowActivation({ modal: true, type: 'panel' }));

    const request = getKernelExecutor().getState().lastRaiseRequest;
    assert.strictEqual(request?.id, a, 'the request names the reused peek');
    assert.strictEqual(request?.intent, 'user');
  });

  it('an activating show without the option stays a machine raise — no intent on the request', () => {
    const [a, b] = [wid(125), wid(126)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);

    kernelShowRequested(a, true);

    const request = getKernelExecutor().getState().lastRaiseRequest;
    assert.ok(request !== null && request.id === a);
    assert.ok(!('intent' in request), 'absent means derived');
  });
});

describe('window-kernel-dispatch: activating show feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetKernelForTests();
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
    // reorderer, by design) — this is exactly why `kernelWindowShown`
    // must translate an activating show into a companion `OsFocusGained`.
    // This fixture cannot pass vacuously: a single-window fixture, or one that
    // activating-shows the already-topmost `b`, would pass with no companion
    // focus feed at all — `topmost` would already read the target window
    // either way. Only the lower-window case exposes the gap.
    const [a, b] = [wid(130), wid(131)];
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being re-shown',
    );

    kernelWindowShown(a, true);

    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
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
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'precondition: b is topmost, a is the lower window being re-shown',
    );

    kernelWindowShown(a, false);

    assert.strictEqual(
      topmost(getKernelExecutor().getState(), isContentWindow)?.id,
      b,
      'a non-activating show feed must not move topmost off b',
    );
  });
});

describe('window-kernel-dispatch: a shown-and-focused report for a window that cannot take key', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  // The command panel opened while another app is frontmost, then the space
  // border (non-focusable, visible at creation) is registered and reported
  // shown-and-focused by the window open path.
  const openPanelFromAnotherApp = (panel: WindowId): void => {
    kernelRegisterWindow({
      id: panel,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'palette',
      role: 'palette',
      transient: true,
      nonActivating: true,
    });
    kernelAppResigned();
    kernelShowRequested(panel, true, { activation: 'user' });
    kernelOsFocusGained(panel);
  };
  const registerBorder = (border: WindowId): void => {
    kernelRegisterWindow({
      id: border,
      kind: 'browser',
      layer: BASE_LAYER + 1,
      canBecomeKey: false,
      acceptsInput: true,
      class: 'hud',
      role: 'workspace',
    });
  };

  it('does not take key from the command panel or end it', () => {
    const [panel, border] = [wid(140), wid(141)];
    openPanelFromAnotherApp(panel);
    assert.strictEqual(getKernelExecutor().getState().key, panel, 'precondition: the panel holds key');

    registerBorder(border);
    kernelWindowShown(border, true);

    const state = getKernelExecutor().getState();
    assert.strictEqual(state.key, panel, 'a window that cannot become key does not take it');
    const record = state.order.find((w) => w.id === panel);
    assert.strictEqual(record?.visible, true);
    assert.notStrictEqual(record?.pendingHidden, true, 'the panel is not dismissed');
    assert.strictEqual(state.order.find((w) => w.id === border)?.visible, true, 'the border itself is shown');
  });

  it('still takes key when the report names the op the backend issued', () => {
    const border = wid(142);
    registerBorder(border);
    kernelWindowShown(border, true, 7);
    assert.strictEqual(getKernelExecutor().getState().key, border);
  });
});

describe('window-kernel-dispatch: overlay attach/detach feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('THE MEASURED GAP, pinned: an overlay attach reaches the kernel and sets overlayFor', () => {
    // `AttachOverlay` has no production dispatcher anywhere until this feed —
    // without it, `overlayFor` stays undefined forever, even after a genuine
    // attach. Two real registered records (an overlay-shaped one and a host)
    // so the assertion cannot pass on a record that was never created.
    const [overlay, host] = [wid(200), wid(201)];
    registerWindow(overlay);
    registerWindow(host);
    const before = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === overlay);
    assert.strictEqual(before?.overlayFor, undefined, 'precondition: a freshly registered overlay carries no overlayFor');

    kernelAttachOverlay(overlay, host);

    const after = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === overlay);
    assert.strictEqual(after?.overlayFor, host, 'attach must set overlayFor to the host');
  });

  it('a retarget onto a different host moves overlayFor, never accumulates it', () => {
    const [overlay, hostA, hostB] = [wid(202), wid(203), wid(204)];
    registerWindow(overlay);
    registerWindow(hostA);
    registerWindow(hostB);

    kernelAttachOverlay(overlay, hostA);
    assert.strictEqual(
      getKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      hostA,
      'precondition: overlay is attached to hostA',
    );

    kernelAttachOverlay(overlay, hostB);
    assert.strictEqual(
      getKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      hostB,
      'a retarget must replace overlayFor with the new host, not add to it',
    );
  });

  it('a detach (hostId: null) clears overlayFor', () => {
    const [overlay, host] = [wid(205), wid(206)];
    registerWindow(overlay);
    registerWindow(host);
    kernelAttachOverlay(overlay, host);
    assert.strictEqual(
      getKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      host,
      'precondition: overlay is attached',
    );

    kernelAttachOverlay(overlay, null);

    assert.strictEqual(
      getKernelExecutor()
        .getState()
        .order.find((w) => w.id === overlay)?.overlayFor,
      undefined,
      'detach must clear overlayFor',
    );
  });

  it('never throws across an attach naming an overlay or host with no record', () => {
    const danglingOverlay = wid(207); // never registered
    const danglingHost = wid(208); // never registered

    assert.doesNotThrow(() => kernelAttachOverlay(danglingOverlay, danglingHost));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling attach joins nothing');
  });
});

describe('window-kernel-dispatch: app-resign feed (peek 7fffa286)', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('AppResigned arms pendingAppResignSweep and clears appActive, mirroring the old machine (window-kernel.ts AppResigned evolve arm)', () => {

    kernelAppResigned();

    const state = getKernelExecutor().getState();
    assert.strictEqual(state.appActive, false, 'AppResigned must clear appActive');
    assert.strictEqual(state.pendingAppResignSweep, true, 'AppResigned must arm the sweep');
  });

  it('AppResignSettled hides a sweep-eligible record and disarms pendingAppResignSweep while appActive stays false, the diff react\'s dismissal rule reads (window-kernel.ts AppResignSettled evolve arm)', () => {
    // Same eligibility shape as the AppActivated re-show test above
    // (`isAppResignSweepEligible`: visible, layer > BASE_LAYER, acceptsInput,
    // not self-closing, not content) — a HUD-shaped surface, not a content
    // window.
    const id = wid(115);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER + 1,
        canBecomeKey: false,
        acceptsInput: true,
        class: 'primary',
      });
    kernelWindowShown(id);
    const record = () => getKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.visible, true, 'precondition: the window is visible after the show feed');

    kernelAppResigned();
    kernelAppResignSettled();

    assert.strictEqual(record()?.visible, false, 'AppResignSettled must hide the sweep-eligible window');
    assert.strictEqual(record()?.hiddenByAppBlur, true);
    const state = getKernelExecutor().getState();
    assert.strictEqual(state.pendingAppResignSweep, false, 'a resign that settled without an intervening AppActivated must disarm the sweep');
    assert.strictEqual(state.appActive, false, 'and leave appActive false — the pair react\'s resign-sweep rule diffs');
  });

  it('never throws across an app-resign feed with nothing registered', () => {

    assert.doesNotThrow(() => kernelAppResigned());
    assert.doesNotThrow(() => kernelAppResignSettled());
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'no record to touch');
  });
});

describe('window-kernel-dispatch: content orderable feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('THE MEASURED DEFECT, pinned: without the feed a shown page-host stays permanently non-orderable and topmostBaseLayerPageHost reads null', () => {
    const id = wid(140);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      });
    kernelWindowShown(id);

    assert.strictEqual(
      topmostBaseLayerPageHost(getKernelExecutor().getState()),
      null,
      'visible alone is not enough — orderable is still false',
    );
  });

  it('a first-composited-frame feed flips orderable to true, and topmostBaseLayerPageHost returns the record (the fix)', () => {
    const id = wid(141);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
        role: 'content',
      });
    kernelWindowShown(id);
    assert.strictEqual(
      topmostBaseLayerPageHost(getKernelExecutor().getState()),
      null,
      'precondition: not orderable yet',
    );

    kernelWindowContentOrderable(id);

    const record = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.orderable, true, 'the feed must flip orderable to true');
    assert.strictEqual(
      topmostBaseLayerPageHost(getKernelExecutor().getState())?.id,
      id,
      'topmostBaseLayerPageHost must now return the record',
    );
  });

  it('never throws across a content-orderable feed naming a window with no record', () => {
    const danglingId = wid(142); // never registered with the kernel

    assert.doesNotThrow(() => kernelWindowContentOrderable(danglingId));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: content first responder feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('a held report reaches the kernel as contentFocused: true, naming the window', () => {
    const id = wid(150);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });

    kernelContentFirstResponderChanged(id, true);

    const record = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.contentFocused, true);
  });

  it('a released report flips it back to false', () => {
    const id = wid(151);
    kernelRegisterWindow(
      {
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
    kernelContentFirstResponderChanged(id, true);
    const record = () => getKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.contentFocused, true, 'precondition: held');

    kernelContentFirstResponderChanged(id, false);

    assert.strictEqual(record()?.contentFocused, false);
  });

  it('never throws across a content-first-responder feed naming a window with no record', () => {
    const danglingId = wid(152); // never registered with the kernel

    assert.doesNotThrow(() => kernelContentFirstResponderChanged(danglingId, true));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: window accepts-input feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('a click-through report reaches the kernel as acceptsInput: false, naming the window', () => {
    const id = wid(160);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });

    kernelWindowAcceptsInputChanged(id, false);

    const record = getKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.strictEqual(record?.acceptsInput, false);
  });

  it('a capturing report flips it back to true', () => {
    const id = wid(161);
    kernelRegisterWindow(
      {
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
    kernelWindowAcceptsInputChanged(id, false);
    const record = () => getKernelExecutor().getState().order.find((w) => w.id === id);
    assert.strictEqual(record()?.acceptsInput, false, 'precondition: click-through');

    kernelWindowAcceptsInputChanged(id, true);

    assert.strictEqual(record()?.acceptsInput, true);
  });

  it('never throws across an accepts-input feed naming a window with no record', () => {
    const danglingId = wid(162); // never registered with the kernel

    assert.doesNotThrow(() => kernelWindowAcceptsInputChanged(danglingId, false));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: cold-start focus latch feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('arming with a real id writes pendingColdStartFocus', () => {
    const id = wid(160);

    kernelArmColdStartFocus(id);

    assert.strictEqual(getKernelExecutor().getState().pendingColdStartFocus, id);
  });

  it('arming with null clears a previously-armed latch', () => {
    const id = wid(161);
    kernelArmColdStartFocus(id);
    assert.strictEqual(
      getKernelExecutor().getState().pendingColdStartFocus,
      id,
      'precondition: latch armed',
    );

    kernelArmColdStartFocus(null);

    assert.strictEqual(getKernelExecutor().getState().pendingColdStartFocus, null);
  });

  it('never throws arming a latch with an id naming no registered window', () => {
    const danglingId = wid(162); // never registered with the kernel

    assert.doesNotThrow(() => kernelArmColdStartFocus(danglingId));
    // Not exempt from being recorded — ArmColdStartFocus answers before the
    // unknown-window guard, so an id naming nothing is legitimate traffic,
    // not a rejection (window-kernel.ts decide's ArmColdStartFocus arm).
    assert.strictEqual(getKernelExecutor().getState().pendingColdStartFocus, danglingId);
  });
});

describe('window-kernel-dispatch: focus assert feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('asserting focus on a registered content window records lastFocusAssert', () => {
    const id = wid(170);
    registerVisibleContentWindow(id);

    kernelAssertFocus(id);

    assert.strictEqual(getKernelExecutor().getState().lastFocusAssert?.id, id);
  });

  it('a target with no record is rejected (logged, never thrown into the caller) and advances nothing', () => {
    const danglingId = wid(171); // never registered with the kernel
    const versionBefore = getKernelExecutor().getState().version;

    assert.doesNotThrow(() => kernelAssertFocus(danglingId));

    // AssertFocus is NOT exempt from decide's unknown-window rejection
    // (window-kernel.ts, AssertFocus's own doc) — unlike the four teardown
    // commands, a dangling target is a genuine rejection, so version must
    // stay pinned.
    assert.strictEqual(getKernelExecutor().getState().version, versionBefore);
  });
});

describe('window-kernel-dispatch: fullscreen feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  const record = (id: WindowId) => getKernelExecutor().getState().order.find((w) => w.id === id);

  it('SetFullscreen(true) on an idle window starts entering, and the following OsFullscreenEntered settles it to fullscreen', () => {
    const id = wid(180);
    registerWindow(id);
    assert.strictEqual(record(id)?.fsMode.name, 'normal', 'precondition: a freshly registered window starts normal');

    kernelSetFullscreen(id, true);

    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'SetFullscreen(true) on an idle window must start entering');

    kernelOsFullscreenEntered(id);

    assert.strictEqual(record(id)?.fsMode.name, 'fullscreen', 'OsFullscreenEntered must settle entering -> fullscreen');
  });

  it('SetFullscreen(false) on a fullscreen window starts leaving, and the following OsFullscreenLeft settles it back to normal', () => {
    const id = wid(181);
    registerWindow(id);
    kernelSetFullscreen(id, true);
    kernelOsFullscreenEntered(id);
    assert.strictEqual(record(id)?.fsMode.name, 'fullscreen', 'precondition: the window is fullscreen');

    kernelSetFullscreen(id, false);

    assert.strictEqual(record(id)?.fsMode.name, 'leaving', 'SetFullscreen(false) on a fullscreen window must start leaving');

    kernelOsFullscreenLeft(id);

    assert.strictEqual(record(id)?.fsMode.name, 'normal', 'OsFullscreenLeft must settle leaving -> normal');
  });

  it('a SetFullscreen arriving mid-transition records the desire rather than restarting the transition', () => {
    const id = wid(182);
    registerWindow(id);
    kernelSetFullscreen(id, true);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: the window is entering');

    kernelSetFullscreen(id, false);

    const mode = record(id)?.fsMode;
    assert.strictEqual(
      mode?.name,
      'entering',
      'a request arriving mid-transition must not restart or advance the transition',
    );
    if (mode?.name !== 'entering') throw new Error('unreachable — asserted above');
    assert.strictEqual(mode.pendingDesire, false, 'the coalesced desire is recorded on the still-in-flight mode');
  });

  it('a settle timeout on an in-flight window marks it unverified and leaves fsMode transitional (8152196c: the machine asks the OS rather than guessing)', () => {
    const id = wid(183);
    registerWindow(id);
    kernelSetFullscreen(id, true);
    const beforeMode = record(id)?.fsMode;
    assert.strictEqual(beforeMode?.name, 'entering', 'precondition: the window is entering');
    if (beforeMode?.name !== 'entering') throw new Error('unreachable — asserted above');
    assert.strictEqual(beforeMode.unverified, undefined, 'precondition: nothing has asked for a reconcile yet');

    kernelFullscreenSettleTimeout(id);

    const afterMode = record(id)?.fsMode;
    assert.strictEqual(
      afterMode?.name,
      'entering',
      'fsMode must be left exactly where it was — a wrong guess would strand preBounds or leave a black Space',
    );
    if (afterMode?.name !== 'entering') throw new Error('unreachable — asserted above');
    assert.strictEqual(afterMode.unverified, true, 'the settle timeout must mark the in-flight window unverified');
  });

  it('never throws across a fullscreen feed naming a window with no record', () => {
    const danglingId = wid(184); // never registered with the kernel

    assert.doesNotThrow(() => kernelOsFullscreenEntered(danglingId));
    assert.doesNotThrow(() => kernelOsFullscreenLeft(danglingId));
    assert.doesNotThrow(() => kernelFullscreenSettleTimeout(danglingId));
    assert.doesNotThrow(() => kernelSetFullscreen(danglingId, true));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: geometry feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  const record = (id: WindowId) => getKernelExecutor().getState().order.find((w) => w.id === id);
  const RECT_A = { x: 10, y: 20, width: 300, height: 400 };
  const RECT_B = { x: 50, y: 60, width: 500, height: 600 };

  it('a bounds change lands on the record\'s bounds', () => {
    const id = wid(190);
    registerWindow(id);
    assert.strictEqual(record(id)?.bounds, undefined, 'precondition: no rect has ever been reported');

    kernelBoundsChanged(id, RECT_A);

    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'BoundsChanged must be the sole writer of the mirror');
  });

  it('SetBounds on a record whose fsMode is not normal is refused by decide and leaves bounds untouched', () => {
    const id = wid(191);
    registerWindow(id);
    kernelBoundsChanged(id, RECT_A);
    kernelSetFullscreen(id, true);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: fsMode is non-normal');

    kernelSetBounds(id, RECT_B);

    assert.deepStrictEqual(
      record(id)?.bounds,
      RECT_A,
      'fullscreen owns the display — decide must answer [] and leave the mirror exactly where it was',
    );
  });

  it('a display change repositions every named window and leaves unnamed ones alone', () => {
    const [a, b] = [wid(192), wid(193)];
    registerWindow(a);
    registerWindow(b);
    kernelBoundsChanged(a, RECT_A);
    kernelBoundsChanged(b, RECT_A);
    // A hidden record's projection is BLOCKED (evolve's DisplayChanged arm
    // holds it on pendingProjectedBounds instead) — `visible: true` is what
    // this test needs unblocked, so show both windows first.
    getKernelExecutor().dispatch({ type: 'WindowShown', id: a });
    getKernelExecutor().dispatch({ type: 'WindowShown', id: b });

    kernelDisplayChanged([{ id: a, bounds: RECT_B }]);

    assert.deepStrictEqual(record(a)?.bounds, RECT_B, 'the named window must be repositioned');
    assert.deepStrictEqual(record(b)?.bounds, RECT_A, 'a window absent from the projection must be left untouched');
  });

  it('MaximizeExitedByResize clears maximized and preMaxBounds without touching bounds', () => {
    const id = wid(194);
    registerWindow(id);
    kernelBoundsChanged(id, RECT_A);
    kernelMaximize(id);
    assert.strictEqual(record(id)?.maximized, true, 'precondition: the window is maximized');

    kernelMaximizeExitedByResize(id);

    assert.strictEqual(record(id)?.maximized, false, 'a resize gesture must invalidate maximize');
    assert.strictEqual(record(id)?.preMaxBounds, null, 'the stash must be cleared alongside the flag');
  });

  it('never throws across a geometry feed naming a window with no record', () => {
    const danglingId = wid(195); // never registered with the kernel

    assert.doesNotThrow(() => kernelBoundsChanged(danglingId, RECT_A));
    assert.doesNotThrow(() => kernelDisplayChanged([{ id: danglingId, bounds: RECT_A }]));
    assert.doesNotThrow(() => kernelMaximizeExitedByResize(danglingId));
    assert.doesNotThrow(() => kernelSetBounds(danglingId, RECT_A));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: maximize / unmaximize feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  const record = (id: WindowId) => getKernelExecutor().getState().order.find((w) => w.id === id);
  const RECT_A = { x: 10, y: 20, width: 300, height: 400 };
  const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

  it('maximize then unmaximize round-trips the bounds through the stash', () => {
    const id = wid(210);
    registerWindow(id);
    kernelBoundsChanged(id, RECT_A);

    kernelMaximize(id);

    assert.strictEqual(record(id)?.maximized, true, 'Maximize must set the flag');
    assert.deepStrictEqual(record(id)?.preMaxBounds, RECT_A, 'decide stashes preMaxBounds from the bounds mirror');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'Maximized itself never writes bounds — the dispatch site snaps it separately');

    // Mirrors the real dispatch site: a separate SetBounds drives the visual snap.
    kernelSetBounds(id, WORK_AREA);
    assert.deepStrictEqual(record(id)?.bounds, WORK_AREA, 'precondition: the window is snapped to the work area');

    kernelUnmaximize(id);

    assert.strictEqual(record(id)?.maximized, false, 'Unmaximize must clear the flag');
    assert.strictEqual(record(id)?.preMaxBounds, null, 'Unmaximize must clear the stash');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'the stash must restore bounds back to the pre-maximize rect');
  });

  it('Maximize on a record whose fsMode is not normal is refused by decide', () => {
    const id = wid(211);
    registerWindow(id);
    kernelBoundsChanged(id, RECT_A);
    kernelSetFullscreen(id, true);
    assert.strictEqual(record(id)?.fsMode.name, 'entering', 'precondition: fsMode is non-normal');

    kernelMaximize(id);

    assert.strictEqual(record(id)?.maximized, false, 'fullscreen owns the display — decide must answer [] ');
  });

  it('Unmaximize on a not-maximized record is a no-op', () => {
    const id = wid(212);
    registerWindow(id);
    kernelBoundsChanged(id, RECT_A);

    kernelUnmaximize(id);

    assert.strictEqual(record(id)?.maximized, false, 'still not maximized');
    assert.deepStrictEqual(record(id)?.bounds, RECT_A, 'nothing to restore — bounds must stay put');
  });

  it('never throws across a maximize/unmaximize feed naming a window with no record', () => {
    const danglingId = wid(213); // never registered with the kernel

    assert.doesNotThrow(() => kernelMaximize(danglingId));
    assert.doesNotThrow(() => kernelUnmaximize(danglingId));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

// `kernelSetDesktopMembership` is the one helper behind all THREE
// production feed sites (see `docs/design/window-manager.md`):
// `tile-ipc.ts`'s raw `tile:window:set-visible-on-all-workspaces` handler
// (boolean translated to an intention before the call), and `ipc.ts`'s
// `windowOpenHandler()` + its keepLive-reuse path (role-derived, already an
// intention at the call site). All three move kernel state through this one
// function, so exercising it here covers what each site actually changes.
describe('window-kernel-dispatch: desktop membership feed', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  const record = (id: WindowId) => getKernelExecutor().getState().order.find((w) => w.id === id);

  it('starts undefined, then moves to the requested intention', () => {
    const id = wid(230);
    registerWindow(id);
    assert.strictEqual(record(id)?.desktopMembership, undefined, 'precondition: nobody has asked yet');

    kernelSetDesktopMembership(id, 'follow');
    assert.strictEqual(record(id)?.desktopMembership, 'follow', 'the tile-ipc raw-boolean feed (true -> follow)');

    kernelSetDesktopMembership(id, 'anchor');
    assert.strictEqual(record(id)?.desktopMembership, 'anchor', 'the tile-ipc raw-boolean feed (false -> anchor)');
  });

  it('moves kernel state for a fresh open (windowOpenHandler feed) and a keepLive reuse (reuse-path feed)', () => {
    const opened = wid(232);
    const reused = wid(233);
    registerWindow(opened);
    registerWindow(reused);

    // windowOpenHandler(): role-derived, either intention.
    kernelSetDesktopMembership(opened, 'anchor');
    assert.strictEqual(record(opened)?.desktopMembership, 'anchor');

    // keepLive-reuse path: only ever reached for 'follow' (an anchored
    // window's creation-time pair must not be replayed on reuse).
    kernelSetDesktopMembership(reused, 'follow');
    assert.strictEqual(record(reused)?.desktopMembership, 'follow');
  });

  it('never throws naming a window with no record', () => {
    const danglingId = wid(231); // never registered with the kernel

    assert.doesNotThrow(() => kernelSetDesktopMembership(danglingId, 'follow'));
    assert.strictEqual(getKernelExecutor().getState().order.length, 0, 'a dangling id never joins order');
  });
});

describe('window-kernel-dispatch: executor provider seam', () => {
  beforeEach(() => {
    _resetKernelForTests();
  });

  it('with no provider installed, returns the same (default, noop-backed) instance across calls', () => {
    const first = getKernelExecutor();
    const second = getKernelExecutor();
    assert.strictEqual(first, second, "today's memoized behavior — unchanged by the seam's presence");
  });

  it('a feed helper lands on the installed provider\'s executor, not the default one', () => {
    // Obtain (and memoize) the default instance BEFORE installing a provider,
    // so the test can prove the feed below does NOT reach it.
    const defaultExecutor = getKernelExecutor();

    const injectedExecutor = new WindowKernelExecutor(new InertBackend());
    setKernelExecutorProvider(() => injectedExecutor);
    assert.strictEqual(
      getKernelExecutor(),
      injectedExecutor,
      'the accessor must return the installed provider\'s executor',
    );

    const id = wid(900);
    kernelRegisterWindow(
      { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' });

    const onInjected = injectedExecutor.getState().order.find((w) => w.id === id);
    assert.ok(onInjected !== undefined, "kernelRegisterWindow's dispatch must land on the injected executor");

    const onDefault = defaultExecutor.getState().order.find((w) => w.id === id);
    assert.strictEqual(onDefault, undefined, 'the default noop-backed executor must never see this registration');
  });

  it('_resetKernelForTests clears the installed provider', () => {
    const injectedExecutor = new WindowKernelExecutor(new InertBackend());
    setKernelExecutorProvider(() => injectedExecutor);
    assert.strictEqual(getKernelExecutor(), injectedExecutor);

    _resetKernelForTests();

    const backToDefault = getKernelExecutor();
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
    const unsub = getKernelExecutor().subscribe(() => {});
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

  it('an app-active edge subscriber made AFTER the provider install hears the production feed', () => {
    // PIN, not a bug repro: records the boot ordering `window-machine.ts
    // subscribeAppActive` depends on. That helper cannot be imported here
    // (`window-machine.ts` value-imports `electron`, which throws under
    // ELECTRON_RUN_AS_NODE=1), so this rebuilds its exact shape — an
    // edge-deduped read of `state.appActive` layered over
    // `getKernelExecutor().subscribe` — and drives it with the same feed
    // helpers `electron-window-backend.ts attachAppListeners` calls.
    const injectedExecutor = new WindowKernelExecutor(new InertBackend());
    setKernelExecutorProvider(() => injectedExecutor);

    const edges: boolean[] = [];
    let last = getKernelExecutor().getState().appActive;
    const unsub = getKernelExecutor().subscribe((state) => {
      if (state.appActive !== last) {
        last = state.appActive;
        edges.push(state.appActive);
      }
    });

    try {
      assert.strictEqual(injectedExecutor.getState().appActive, true, 'precondition: the kernel boots app-active');
      kernelAppResigned();
      kernelAppActivated();
    } finally {
      unsub();
    }

    assert.deepStrictEqual(
      edges,
      [false, true],
      'both app-active edges must reach a subscriber bound after the provider install',
    );
  });

  it('does not throw when the fallback was merely constructed (feeds ran) with no subscriber ever attached', () => {
    const id = wid(901);
    // Constructs the fallback via the ordinary feed path — nobody subscribes.
    kernelRegisterWindow(
      { id, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary' });

    assert.doesNotThrow(() => setKernelExecutorProvider(() => new WindowKernelExecutor(new InertBackend())));
  });
});
