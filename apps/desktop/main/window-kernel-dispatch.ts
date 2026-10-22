// window-kernel-dispatch.ts — the one `WindowKernelExecutor` for the app; every real input the
// app's window-management surfaces produce is translated here into the kernel's command/event
// vocabulary, and production code reads decisions back through it. Blueprint:
// `docs/design/window-manager.md`.

import { DEBUG } from './config.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import { type Command, type DesktopId, type DesktopMembership, type DesktopState, type Event, type MaximizeAllMarkEntry, type MaximizeAllMode, type ScreenId, type ScreenState, type FocusCause, type Rectangle, type WindowId, type WindowKind } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel } from './izui-roles.js';

interface KernelEffectLogEntry {
  name: string;
  args: unknown[];
}

const EFFECT_LOG_CAP = 50;
const effectLog: KernelEffectLogEntry[] = [];

function recordEffect(name: string, ...args: unknown[]): void {
  effectLog.push({ name, args });
  if (effectLog.length > EFFECT_LOG_CAP) effectLog.shift();
  DEBUG && console.log('[window-kernel-dispatch] effect (not performed):', name, ...args);
}

export function _kernelEffectLogForTests(): readonly KernelEffectLogEntry[] {
  return effectLog;
}

// NoopKernelBackend is reached only when no provider was installed.
class NoopKernelBackend implements WindowBackend {
  attachAppListeners(): void {
    recordEffect('attachAppListeners');
  }
  raiseWindow(id: WindowId, opSeq: number): void {
    recordEffect('raiseWindow', id, opSeq);
  }
  focusContent(id: WindowId, opSeq: number): void {
    recordEffect('focusContent', id, opSeq);
  }
  setFullscreen(id: WindowId, on: boolean): void {
    recordEffect('setFullscreen', id, on);
  }
  reconcileFullscreen(id: WindowId): void {
    recordEffect('reconcileFullscreen', id);
  }
  closeOrHide(id: WindowId): Promise<void> {
    recordEffect('closeOrHide', id);
    return Promise.resolve();
  }
  askRendererHandledEscape(id: WindowId): Promise<boolean> {
    recordEffect('askRendererHandledEscape', id);
    return Promise.resolve(false);
  }
  attachEscHandler(id: WindowId): void {
    recordEffect('attachEscHandler', id);
  }
  setEscGrab(on: boolean): void {
    recordEffect('setEscGrab', on);
  }
  closeWindow(id: WindowId): Promise<void> {
    recordEffect('closeWindow', id);
    return Promise.resolve();
  }
  destroyWindow(id: WindowId): void {
    recordEffect('destroyWindow', id);
  }
  closeContent(id: WindowId): void {
    recordEffect('closeContent', id);
  }
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void {
    recordEffect('showWindow', id, opts);
  }
  hideWindow(id: WindowId, opSeq?: number): void {
    recordEffect('hideWindow', id, opSeq);
  }
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    recordEffect('pinAlwaysOnTop', id, on);
  }
  reopenAsOrdinaryWindow(id: WindowId): void {
    recordEffect('reopenAsOrdinaryWindow', id);
  }
  destroyAllContentGuests(): Promise<void> {
    recordEffect('destroyAllContentGuests');
    return Promise.resolve();
  }
  hideApp(): void {
    recordEffect('hideApp');
  }
  activateApp(id: WindowId): void {
    recordEffect('activateApp', id);
  }
  setStacking(id: WindowId, level: StackingLevel): void {
    recordEffect('setStacking', id, level);
  }
  setWindowBounds(id: WindowId, rect: Rect): void {
    recordEffect('setWindowBounds', id, rect);
  }
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void {
    recordEffect('setDesktopMembership', id, membership);
  }
  setAcceptsInput(id: WindowId, acceptsInput: boolean): void {
    recordEffect('setAcceptsInput', id, acceptsInput);
  }
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void {
    recordEffect('attachOverlayTo', overlayId, hostId);
  }
}

let kernelExecutorInstance: WindowKernelExecutor | null = null;
let installedProvider: (() => WindowKernelExecutor) | null = null;

export function setKernelExecutorProvider(provider: () => WindowKernelExecutor): void {
  if (kernelExecutorInstance !== null && kernelExecutorInstance.subscriberCount() > 0) {
    throw new Error(
      '[window-kernel-dispatch] setKernelExecutorProvider: a listener is already subscribed to the ' +
        'pre-cutover fallback executor and would never fire again once a provider is installed — ' +
        'install the provider before anything calls getKernelExecutor().subscribe().',
    );
  }
  installedProvider = provider;
}

export function getKernelExecutor(): WindowKernelExecutor {
  if (installedProvider) return installedProvider();
  if (!kernelExecutorInstance) kernelExecutorInstance = new WindowKernelExecutor(new NoopKernelBackend());
  return kernelExecutorInstance;
}

export function _resetKernelForTests(): void {
  kernelExecutorInstance = null;
  installedProvider = null;
  effectLog.length = 0;
}

// No exception from the kernel path escapes a feed helper: execute/dispatch failures are logged, never thrown.
function kernelExecute(command: Command): void {
  try {
    const outcome = getKernelExecutor().execute(command);
    if ('rejected' in outcome) {
      DEBUG && console.log('[window-kernel-dispatch] command rejected:', command.type, outcome.rejected);
    }
  } catch (err) {
    DEBUG && console.log('[window-kernel-dispatch] command threw:', command.type, err);
  }
}

function kernelDispatch(event: Event): void {
  try {
    getKernelExecutor().dispatch(event);
  } catch (err) {
    DEBUG && console.log('[window-kernel-dispatch] event threw:', event.type, err);
  }
}

export interface RegisterWindowSpec {
  id: WindowId;
  kind: WindowKind;
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
  class: string;
  role?: string;
  parentId?: WindowId;
  keepLive?: boolean;
  escapeMode?: string;
  bounds?: Rectangle;
  tracksBaseLayerTop?: boolean;
  selfClosesOnBlur?: boolean;
  transient?: boolean;
  nonActivating?: boolean;
  appLifetime?: boolean;
  onEveryDesktop?: boolean;
}

export function kernelRegisterWindow(spec: RegisterWindowSpec): void {
  kernelExecute({
    type: 'RegisterWindow',
    id: spec.id,
    kind: spec.kind,
    layer: spec.layer,
    canBecomeKey: spec.canBecomeKey,
    acceptsInput: spec.acceptsInput,
    class: spec.class,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
    ...(spec.keepLive !== undefined ? { keepLive: spec.keepLive } : {}),
    ...(spec.escapeMode === 'ignore' ? { escapeMode: 'ignore' as const } : {}),
    ...(spec.bounds !== undefined ? { bounds: spec.bounds } : {}),
    ...(spec.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: spec.tracksBaseLayerTop } : {}),
    ...(spec.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: spec.selfClosesOnBlur } : {}),
    ...(spec.transient !== undefined ? { transient: spec.transient } : {}),
    ...(spec.nonActivating !== undefined ? { nonActivating: spec.nonActivating } : {}),
    ...(spec.appLifetime !== undefined ? { appLifetime: spec.appLifetime } : {}),
    ...(spec.onEveryDesktop !== undefined ? { onEveryDesktop: spec.onEveryDesktop } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelOsFocusGained(id: WindowId, cause?: FocusCause): void {
  kernelDispatch({ type: 'OsFocusGained', id, cause });
}

export function kernelOsFocusSettled(): void {
  const { key } = getKernelExecutor().getState();
  if (key !== null) kernelDispatch({ type: 'OsFocusLost', id: key });
}

// kernelWindowShown's focused parameter is idempotent with the real OS focus echo.
export function kernelWindowShown(id: WindowId, focused = false, opSeq?: number): void {
  kernelDispatch({ type: 'WindowShown', id, opSeq });
  // A show no backend op asked for (a window visible at creation, reported at
  // registration and at the open handler) cannot make a window key when it was
  // declared unable to become key. Taken as a focus it would move key off the
  // window that really holds it and end a transient one (the command panel).
  const record = opSeq === undefined ? getKernelExecutor().getState().order.find((w) => w.id === id) : undefined;
  if (focused && record?.canBecomeKey !== false) {
    kernelDispatch({ type: 'OsFocusGained', id, cause: opSeq === undefined ? undefined : { kind: 'machine', opSeq } });
  }
}

export function kernelWindowHidden(id: WindowId, opSeq?: number): void {
  kernelDispatch({ type: 'WindowHidden', id, opSeq });
}

export function kernelDesktopLayoutReported(screens: readonly ScreenState[], desktops: readonly DesktopState[]): void {
  kernelDispatch({ type: 'DesktopLayoutReported', screens, desktops });
}

export function kernelCurrentDesktopChanged(screen: ScreenId, desktop: DesktopId): void {
  kernelDispatch({ type: 'CurrentDesktopChanged', screen, desktop });
}

export function kernelDesktopSwitchObserved(): void {
  kernelDispatch({ type: 'DesktopSwitchObserved' });
}

export function kernelDesktopsRead(switchesSeen: number): void {
  kernelDispatch({ type: 'DesktopsRead', switchesSeen });
}

export function kernelWindowPlacementReported(
  id: WindowId,
  screen: ScreenId | null,
  desktop: DesktopId | null,
  onEveryDesktop: boolean,
): void {
  kernelDispatch({ type: 'WindowPlacementReported', id, screen, desktop, onEveryDesktop });
}

export function kernelAppActivated(): void {
  kernelDispatch({ type: 'AppActivated' });
}

export function kernelPressedInNonActivatingWindow(id: WindowId): void {
  kernelDispatch({ type: 'PressedInNonActivatingWindow', id });
}

export function kernelAppResigned(): void {
  kernelDispatch({ type: 'AppResigned' });
}

export function kernelAppResignSettled(): void {
  kernelDispatch({ type: 'AppResignSettled' });
}

export function kernelOverlayTransitionObserved(): void {
  kernelDispatch({ type: 'OverlayTransitionObserved' });
}

export function kernelDestroyWindow(id: WindowId): void {
  kernelExecute({ type: 'DestroyWindow', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelCloseContent(id: WindowId): void {
  kernelExecute({ type: 'CloseContent', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelCloseWindowDirect(id: WindowId): void {
  kernelExecute({ type: 'CloseWindowDirect', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelDestroyAllGuests(): void {
  kernelExecute({ type: 'DestroyAllGuests', expectedVersion: getKernelExecutor().getState().version });
}

export function kernelWindowClosed(id: WindowId): void {
  kernelDispatch({ type: 'WindowClosed', id });
}

export function kernelImportStackOrder(order: readonly WindowId[]): void {
  kernelExecute({ type: 'ImportStackOrder', order, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelAttachOverlay(overlayId: WindowId, hostId: WindowId | null, frame?: Rectangle): void {
  kernelExecute({
    type: 'AttachOverlay',
    overlayId,
    hostId,
    ...(frame !== undefined ? { frame } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelOverlayAttached(overlayId: WindowId, hostId: WindowId | null, frame?: Rectangle): void {
  kernelDispatch({
    type: 'OverlayAttached',
    overlayId,
    hostId,
    ...(frame !== undefined ? { frame } : {}),
  });
}

export function kernelWindowContentOrderable(id: WindowId): void {
  kernelDispatch({ type: 'WindowContentOrderable', id });
}

export function kernelContentFirstResponderChanged(id: WindowId, held: boolean): void {
  kernelDispatch({ type: 'ContentFirstResponderChanged', id, held });
}

export function kernelWindowAcceptsInputChanged(id: WindowId, acceptsInput: boolean): void {
  kernelDispatch({ type: 'WindowAcceptsInputChanged', id, acceptsInput });
}

export function kernelArmColdStartFocus(id: WindowId | null): void {
  kernelExecute({ type: 'ArmColdStartFocus', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelArmSelectionFocus(armer: WindowId, target: WindowId | null): void {
  kernelExecute({ type: 'ArmSelectionFocus', armer, target, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelAssertFocus(id: WindowId): void {
  kernelExecute({ type: 'AssertFocus', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelOsFullscreenEntered(id: WindowId): void {
  kernelDispatch({ type: 'OsFullscreenEntered', id });
}

export function kernelOsFullscreenLeft(id: WindowId): void {
  kernelDispatch({ type: 'OsFullscreenLeft', id });
}

export function kernelFullscreenSettleTimeout(id: WindowId): void {
  kernelDispatch({ type: 'FullscreenSettleTimeout', id });
}

export function kernelSetFullscreen(id: WindowId, desired: boolean): void {
  kernelExecute({
    type: 'SetFullscreen',
    id,
    desired,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelBoundsChanged(id: WindowId, bounds: Rectangle, overlayFrame?: Rectangle): void {
  kernelDispatch({ type: 'BoundsChanged', id, bounds, ...(overlayFrame !== undefined ? { overlayFrame } : {}) });
}

export function kernelDisplayChanged(
  projections: ReadonlyArray<{ id: WindowId; bounds: Rectangle }>): void {
  kernelDispatch({ type: 'DisplayChanged', projections });
}

export function kernelMaximizeExitedByResize(id: WindowId): void {
  kernelDispatch({ type: 'MaximizeExitedByResize', id });
}

export function kernelSetBounds(id: WindowId, bounds: Rectangle): void {
  kernelExecute({ type: 'SetBounds', id, bounds, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelMaximize(id: WindowId, workArea?: Rectangle): void {
  kernelExecute({
    type: 'Maximize',
    id,
    ...(workArea !== undefined ? { workArea } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelUnmaximize(id: WindowId): void {
  kernelExecute({ type: 'Unmaximize', id, expectedVersion: getKernelExecutor().getState().version });
}

// Maximize-all mode. `workArea` is the rect eligible windows are maximized to —
// the kernel has no display geometry of its own, so the caller reads it off the
// screen the user is on and hands it over.
export function kernelEnterMaximizeAll(workArea?: Rectangle): void {
  kernelExecute({
    type: 'EnterMaximizeAll',
    ...(workArea !== undefined ? { workArea } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelLeaveMaximizeAll(): void {
  kernelExecute({ type: 'LeaveMaximizeAll', expectedVersion: getKernelExecutor().getState().version });
}

export function kernelRestoreMaximizeAll(mode: MaximizeAllMode | null, marks: readonly MaximizeAllMarkEntry[]): void {
  kernelExecute({
    type: 'RestoreMaximizeAll',
    mode,
    marks,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

/** The mode and its scope, or `null` while the mode is off. */
export function kernelMaximizeAllMode(): MaximizeAllMode | null {
  return getKernelExecutor().getState().maximizeAll;
}

export function kernelSetDesktopMembership(id: WindowId, membership: DesktopMembership): void {
  kernelExecute({
    type: 'SetDesktopMembership',
    id,
    membership,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

export function kernelSetAcceptsInput(id: WindowId, acceptsInput: boolean): void {
  kernelExecute({
    type: 'SetAcceptsInput',
    id,
    acceptsInput,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

// Moves an already-open window between the pinned band and the base band —
// see window-kernel.ts's `SetLayer` command doc.
export function kernelSetLayer(id: WindowId, layer: number): void {
  kernelExecute({
    type: 'SetLayer',
    id,
    layer,
    expectedVersion: getKernelExecutor().getState().version,
  });
}

// kernelShowRequested with activate is ShowWindow then RaiseWindow, and opts.activation puts intent on
// the raise: 'user' for a user act, 'named' when the user named this very window (the raise may then
// take the user to its desktop — window-kernel.ts FocusRequester).
export function kernelShowRequested(id: WindowId, activate: boolean, opts?: { activation?: 'user' | 'named' }): void {
  kernelExecute({ type: 'ShowWindow', id, expectedVersion: getKernelExecutor().getState().version });
  if (activate) {
    kernelExecute({
      type: 'RaiseWindow',
      id,
      expectedVersion: getKernelExecutor().getState().version,
      ...(opts?.activation !== undefined ? { intent: opts.activation } : {}),
    });
  }
}

export function kernelHideRequested(id: WindowId): void {
  kernelExecute({ type: 'HideWindow', id, expectedVersion: getKernelExecutor().getState().version });
}

export function kernelCloseOrHideRequested(id: WindowId, force = false): void {
  kernelExecute({
    type: 'CloseOrHideWindow',
    id,
    ...(force ? { force: true } : {}),
    expectedVersion: getKernelExecutor().getState().version,
  });
}
