// How the marker sync is wired to the window kernel
// (`desktop-markers.ts subscribeMarkerSync`, the subscription
// `desktop-marker-manager.ts installDesktopMarkerManager()` installs), against
// a real kernel executor. The manager itself value-imports electron and cannot
// load under the main-process unit runner, so the sync pass here is a stand-in
// whose open path does not wait: it registers and shows its marker in the same
// synchronous stretch it starts in — the shape a marker open would have if
// `ipc.ts` stopped yielding before registering the new window.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { subscribeMarkerSync, shouldMintMarkerForState } from './desktop-markers.js';
import { WindowKernelExecutor, type CommandOutcome } from './window-kernel-executor.js';
import { BASE_LAYER, type State, type WindowId } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel } from './izui-roles.js';

/** A backend that accepts every port command and does nothing. */
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
  setChrome(): void {}
  attachOverlayTo(): void {}
}

const MARKER = 'wk-marker' as WindowId;

/** Register the marker and show it at once, the way a non-waiting open would. */
function openAndShowMarker(exec: WindowKernelExecutor): CommandOutcome {
  exec.execute({
    type: 'RegisterWindow',
    id: MARKER,
    kind: 'browser',
    layer: BASE_LAYER,
    canBecomeKey: false,
    acceptsInput: false,
    class: 'primary',
    expectedVersion: exec.getState().version,
  });
  return exec.execute({ type: 'ShowWindow', id: MARKER, expectedVersion: exec.getState().version });
}

/** Arrive on desktop `d2` — the notification that should mint its marker. */
function arriveOnD2(exec: WindowKernelExecutor): void {
  exec.dispatch({
    type: 'DesktopLayoutReported',
    screens: [{ id: 's1', current: 'd2' }],
    desktops: [
      { id: 'd1', screen: null },
      { id: 'd2', screen: null },
    ],
  });
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('subscribeMarkerSync (the marker sync never runs inside a kernel notification)', () => {
  it('a marker minted on arrival at a desktop registers and shows, even when its open path does not wait', async () => {
    const exec = new WindowKernelExecutor(new InertBackend());
    const minted: { show?: CommandOutcome } = {};
    subscribeMarkerSync(exec, (state: State) => {
      if (minted.show !== undefined || state.screens[0]?.current !== 'd2') return;
      minted.show = openAndShowMarker(exec);
    });
    arriveOnD2(exec);
    await flushMicrotasks();
    assert.ok(minted.show !== undefined, 'the arrival ran a sync pass that minted');
    assert.ok(
      'applied' in minted.show,
      `the show must be decided against a state that already holds the marker, got ${JSON.stringify(minted.show)}`,
    );
    const record = exec.getState().order.find((w) => w.id === MARKER);
    assert.ok(record, 'the marker is registered');
    assert.strictEqual(record.visible, true, 'the marker is on screen');
  });

  it('a window going fullscreen does not start a chain of markers, one per new desktop', async () => {
    const exec = new WindowKernelExecutor(new InertBackend());
    const marked = new Set<string>(['d1']);
    let minted = 0;
    let nextDesktop = 3;
    const desktops = [
      { id: 'd1', screen: null },
      { id: 'd2', screen: null },
    ];
    // Showing a marker on a fullscreen desktop gives it a new desktop and
    // switches to it, which the next pass sees as another unmarked desktop.
    subscribeMarkerSync(exec, (state: State) => {
      if (!shouldMintMarkerForState(state, marked) || minted > 10) return;
      minted++;
      marked.add(state.screens[0]!.current);
      const id = `d${nextDesktop++}`;
      desktops.push({ id, screen: null });
      exec.dispatch({
        type: 'DesktopLayoutReported',
        screens: [{ id: 's1', current: id }],
        desktops: [...desktops],
      });
    });
    exec.dispatch({ type: 'DesktopLayoutReported', screens: [{ id: 's1', current: 'd1' }], desktops: [...desktops] });
    const WIN = 'wk-app' as WindowId;
    exec.execute({
      type: 'RegisterWindow',
      id: WIN,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      expectedVersion: exec.getState().version,
    });
    exec.dispatch({ type: 'FullscreenTransitionStarted', id: WIN, entering: true, preBounds: null });
    exec.dispatch({ type: 'OsFullscreenEntered', id: WIN });
    exec.dispatch({
      type: 'DesktopLayoutReported',
      screens: [{ id: 's1', current: 'd2' }],
      desktops: [...desktops],
    });
    await flushMicrotasks();
    await flushMicrotasks();
    assert.strictEqual(minted, 0, 'no marker is minted on the fullscreen desktop');
  });

  it('the install-time pass runs at once, against the state the kernel already holds', () => {
    const exec = new WindowKernelExecutor(new InertBackend());
    arriveOnD2(exec);
    const seen: Array<string | null> = [];
    subscribeMarkerSync(exec, (state: State) => {
      seen.push(state.screens[0]?.current ?? null);
    });
    assert.deepStrictEqual(seen, ['d2']);
  });
});
