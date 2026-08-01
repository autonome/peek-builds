/**
 * Unit tests for `window-kernel-shadow.ts` — the shadow kernel's registration
 * feed. Harness conventions follow `window-kernel-executor.test.ts`
 * (`node:test` + `node:assert`, `.js`-suffixed import of the compiled output).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  _resetShadowKernelForTests,
  compareShadowKernelState,
  getShadowKernelExecutor,
  shadowKernelCloseContent,
  shadowKernelCloseWindowDirect,
  shadowKernelDestroyAllGuests,
  shadowKernelDestroyWindow,
  shadowKernelImportStackOrder,
  shadowKernelOsFocusGained,
  shadowKernelOsFocusSettled,
  shadowKernelRegisterWindow,
  shadowKernelWindowClosed,
} from './window-kernel-shadow.js';
import { BASE_LAYER, type WindowId } from './window-kernel.js';
import type { StateSnapshot, WindowRecord } from './window-state.js';

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

/** Registers a visible content-role window in the shadow kernel — the shape `isContentWindow`/`topmost` admit. */
function registerVisibleContentWindow(id: WindowId): void {
  shadowKernelRegisterWindow({
    id,
    kind: 'page-host',
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });
  getShadowKernelExecutor().dispatch({ type: 'WindowShown', id });
}

describe('window-kernel-shadow: registration feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a registration reaches the shadow kernel state (peek 7fffa286)', () => {
    const id = wid(1);
    shadowKernelRegisterWindow({
      id,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      role: 'main',
    });

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
    shadowKernelRegisterWindow({
      id: wid(2),
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });
    shadowKernelRegisterWindow({
      id: wid(3),
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });

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
    shadowKernelRegisterWindow({
      id,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });

    shadowKernelOsFocusGained(id);

    assert.strictEqual(getShadowKernelExecutor().getState().key, id);
  });

  it('the settle emits OsFocusLost naming the currently-held key', () => {
    const id = wid(11);
    shadowKernelRegisterWindow({
      id,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });
    shadowKernelOsFocusGained(id);
    assert.strictEqual(getShadowKernelExecutor().getState().key, id, 'precondition: id holds key');

    shadowKernelOsFocusSettled();

    assert.strictEqual(getShadowKernelExecutor().getState().key, null, 'OsFocusLost nulls the held key');
  });

  it('the settle emits nothing when no key is held', () => {
    // Fresh shadow kernel: nothing has ever taken key.
    assert.strictEqual(getShadowKernelExecutor().getState().key, null, 'precondition: no key held');
    const versionBefore = getShadowKernelExecutor().getState().version;

    shadowKernelOsFocusSettled();

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
    call: (id: WindowId) => void;
    carriesId: boolean;
  }> = [
    { name: 'DestroyWindow', kind: 'destroy-window', call: shadowKernelDestroyWindow, carriesId: true },
    { name: 'CloseContent', kind: 'close-content', call: shadowKernelCloseContent, carriesId: true },
    { name: 'CloseWindowDirect', kind: 'close-window-direct', call: shadowKernelCloseWindowDirect, carriesId: true },
    {
      name: 'DestroyAllGuests',
      kind: 'destroy-all-guests',
      call: () => shadowKernelDestroyAllGuests(),
      carriesId: false,
    },
  ];

  for (const { name, kind, call, carriesId } of teardownCases) {
    it(`${name} reaches the shadow kernel (recorded on lastTeardown) — membership stays untouched (peek 7fffa286)`, () => {
      const id = wid(30);
      shadowKernelRegisterWindow({
        id,
        kind: 'page-host',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
      const versionBefore = getShadowKernelExecutor().getState().version;

      call(id);

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
    const versionBefore = getShadowKernelExecutor().getState().version;

    assert.doesNotThrow(() => shadowKernelDestroyWindow(danglingId));
    assert.doesNotThrow(() => shadowKernelCloseContent(danglingId));
    assert.doesNotThrow(() => shadowKernelCloseWindowDirect(danglingId));
    assert.doesNotThrow(() => shadowKernelDestroyAllGuests());

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
    shadowKernelRegisterWindow({
      id,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });
    assert.ok(
      getShadowKernelExecutor().getState().order.some((w) => w.id === id),
      'precondition: the window is a member before the close report',
    );

    shadowKernelWindowClosed(id);

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

    assert.doesNotThrow(() => shadowKernelWindowClosed(danglingId));

    // `WindowClosed` is an event (`evolve`, not `decide`) — there is no
    // `decide`-side rejection to exempt here; `evolve`'s unconditional
    // filter simply no-ops on an id that was never a member, while the
    // dispatch itself still advances version, same as any other event.
    const state = getShadowKernelExecutor().getState();
    assert.strictEqual(state.version, versionBefore + 1);
    assert.strictEqual(state.order.length, 0, 'a dangling close report never adds a member');
  });
});

describe('window-kernel-shadow: stack-order import feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('an import permutes only the slots the payload names, naming a partial subset with an unknown id and a duplicate (peek 7fffa286)', () => {
    const [a, b, c, d] = [wid(50), wid(51), wid(52), wid(53)];
    for (const id of [a, b, c, d]) {
      shadowKernelRegisterWindow({
        id,
        kind: 'browser',
        layer: BASE_LAYER,
        canBecomeKey: true,
        acceptsInput: true,
        class: 'primary',
      });
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
    shadowKernelImportStackOrder([d, wid(999), a, a]);

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

    assert.doesNotThrow(() => shadowKernelImportStackOrder([danglingId]));

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
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    // `topmost` scans from the END of `order` — b was registered last, so it
    // is the kernel's front.
    assert.strictEqual(getShadowKernelExecutor().getState().order.at(-1)?.id, b, 'precondition: b is topmost');

    const oldMachine = fakeOldMachine({ front: b, stackOrder: [a, b], ids: [a, b] });

    assert.deepStrictEqual(compareShadowKernelState(oldMachine), []);
  });

  it('detects a membership divergence: an id the old machine holds that the kernel does not', () => {
    const a = wid(80);
    registerVisibleContentWindow(a);
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
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
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
    registerVisibleContentWindow(a);
    registerVisibleContentWindow(b);
    registerVisibleContentWindow(c);
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
