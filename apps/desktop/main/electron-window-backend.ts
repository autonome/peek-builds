// electron-window-backend.ts — the Electron implementation of the `WindowBackend`
// port; the only window-manager module that imports Electron.
// Sole authority on window identity: mints every `WindowId` and holds the only
// `WindowId` <-> Electron-id translation in the tree.
// Owns the two OS/Chromium boundary workarounds (deferred-blur settle, bounded
// fullscreen settle timer) and the focus-provenance arming that backs `FocusCause`.
// Design: `docs/design/window-manager.md`.

// A machine-initiated operation must not feed its own side effect back in as
// fresh OS evidence.

import { app, BrowserWindow, globalShortcut, screen, systemPreferences, webContents } from 'electron';
import type { WebContents } from 'electron';

import {
  FailSafeDesktopProvider,
  type PlatformWindowId,
} from './desktop-provider.js';
import { syncDesktops as syncDesktopsRead } from './desktop-sync.js';
import { FallbackDesktopProvider } from './desktop-provider-fallback.js';
import { MacDesktopProvider, macHelperPath, windowNumberFromSourceId } from './desktop-provider-mac.js';
import {
  flagNonActivating,
  focusContentWithoutActivating,
  isFlaggedNonActivating,
  makeKeyWithoutActivating,
  moveToActiveDesktopOnShow,
  unflagNonActivating,
} from './nonactivating-window.js';

import { isHeadless, DEBUG } from './config.js';
import {
  askWebContentsToHandleEscape,
  closeOrHideWindow,
  addEscHandler,
} from './windows.js';
// Bound at call time only, like `windows.js` above: ipc.js reaches this module
// through window-machine.js, and the reopen is never invoked during module evaluation.
// `dispatchEscapePress` is called only inside `escGrabHandler`'s closure, never
// at this module's top level — window-machine.js imports this file directly.
import { dispatchEscapePress, getAppActive } from './window-machine.js';
import { getGuestsForWindow, getAllGuestWebContentsIds } from './webview-guest-registry.js';
import {
  shouldCloseContentWCOnFinalize,
  decideWindowRegistration,
  type WindowClass,
  type StackingLevel,
  type WindowRegistrationDecision,
} from './izui-roles.js';
import type { DesktopId, DesktopMembership, FocusCause, ScreenId, WindowId, WindowKind, Rectangle } from './window-kernel.js';
import type { WindowBackend, WindowSpec } from './window-backend.js';
import {
  destroyGuestsAndWait,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';
import { expandToOverlayFrame } from './overlay-frame.js';
import { wmLog, type WmLogFields } from './window-diag.js';
import { UserRaiseReassert } from './user-raise-reassert.js';
import { windowDragPointer, windowDragVeto, windowDragWindowClosed } from './window-drag-runtime.js';
import type { DragCursor } from './window-drag.js';
import { setWebContentsCursor, type CursorWebContents } from './webcontents-cursor.js';

// The message a window's preload sends when it judges the current press not
// draggable (docs/design/window-drag.md "What blocks a press").
export const WINDOW_DRAG_PRESS_BLOCKED = 'window-drag:press-blocked';

// One Electron `input-event` mouse event as the hold-to-drag runtime sees it,
// or null for anything it does not consume (other buttons, keys, wheel).
export function translatePointerInput(
  input: unknown,
): { type: 'press'; x: number; y: number } | { type: 'move'; x: number; y: number; buttonHeld: boolean | null } | { type: 'release' } | null {
  const i = input as { type?: string; button?: string; globalX?: number; globalY?: number; modifiers?: unknown } | null;
  if (!i || typeof i.globalX !== 'number' || typeof i.globalY !== 'number') return null;
  if (i.type === 'mouseDown' && i.button === 'left') return { type: 'press', x: i.globalX, y: i.globalY };
  if (i.type === 'mouseUp' && i.button === 'left') return { type: 'release' };
  if (i.type === 'mouseMove') {
    // No modifiers array is no evidence either way about the button.
    const buttonHeld = Array.isArray(i.modifiers) ? i.modifiers.includes('leftbuttondown') : null;
    return { type: 'move', x: i.globalX, y: i.globalY, buttonHeld };
  }
  return null;
}
import { FULLSCREEN_SETTLE_TIMEOUT_MS, isOnEveryDesktop, onCurrentDesktop, windowById } from './window-kernel.js';
// The executor does not import this backend, so this is not a cycle.
import { planRaiseRealization } from './window-kernel-executor.js';
import {
  getKernelExecutor,
  kernelOsFocusGained,
  kernelOsFocusSettled,
  kernelDesktopLayoutReported,
  kernelCurrentDesktopChanged,
  kernelDesktopSwitchObserved,
  kernelDesktopsRead,
  kernelWindowPlacementReported,
  kernelWindowClosed,
  kernelWindowShown,
  kernelWindowHidden,
  kernelAppActivated,
  kernelAppResigned,
  kernelAppResignSettled,
  kernelContentFirstResponderChanged,
  kernelOsFullscreenEntered,
  kernelOsFullscreenLeft,
  kernelFullscreenSettleTimeout,
  kernelBoundsChanged,
  kernelOverlayAttached,
  kernelCloseOrHideRequested,
} from './window-kernel-dispatch.js';

function requestGuestDestroy(guest: TeardownGuest): void {
  (guest as unknown as { destroy(): void }).destroy();
}

const APP_RESIGN_SETTLE_MS = 500;

// STACKING_TAKES_FOCUS is a claim never checked off macOS — see the design
// doc's "Open design decisions" section.
const STACKING_TAKES_FOCUS = process.platform !== 'darwin';

export interface NativeWindow {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  close(): void;
  destroy(): void;
  hide(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
  setOpacity(opacity: number): void;
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating'): void;
  moveTop(): void;
  setBounds(bounds: Rectangle): void;
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  // Optional so test doubles need not supply it.
  setHasShadow?(hasShadow: boolean): void;
  getBounds(): Rectangle;
  // Optional so test doubles need not supply them; the platform window id is read from these.
  getMediaSourceId?(): string;
  getNativeWindowHandle?(): Buffer;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface NativeWebContents {
  isDestroyed(): boolean;
  focus(): void;
  close(): void;
  getURL(): string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface RegisterWindowSpec extends WindowSpec {
  win: NativeWindow;
  contentWC?: NativeWebContents | null;
  // A non-activating window is built as a panel (`izui-roles.ts windowNonActivating`),
  // or as an ordinary window flagged through `nonactivating-window.ts`.
  nonActivating?: boolean;
}

export interface BackendRegistration {
  id: WindowId;
  decision: WindowRegistrationDecision;
  initialBounds: Rectangle | null;
  // This platform keeps the window on every desktop whatever is asked:
  // Electron's panel re-adds join-all-Spaces on every collection-behaviour
  // change (`electron_ns_panel.mm setCollectionBehavior:`), so on macOS a
  // non-activating window built as a panel is on every desktop, anchored or
  // not. A flagged ordinary window is not. Declared to the kernel as
  // `onEveryDesktop`.
  onEveryDesktop: boolean;
}

export interface BackendMigrationShims {
  registerWindow(spec: RegisterWindowSpec): BackendRegistration;
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null;
  getNativeWindowFor(id: WindowId): NativeWindow | null;
}

interface BackendWindow {
  win: NativeWindow;
  kind: WindowKind;
  windowClass: WindowClass;
  rendererWC: NativeWebContents | null;
}

export class ElectronWindowBackend implements WindowBackend, BackendMigrationShims {

  private readonly windows = new Map<WindowId, BackendWindow>();

  private readonly idByOsWindowId = new Map<number, WindowId>();

  private windowIdCounter = 0;

  private pendingBlurSettle: ReturnType<typeof setImmediate> | null = null;

  // Read but not consumed by `takeFocusCause`: a page-host has two native
  // focus producers (host window, content WC) for one machine-issued op, and
  // consuming on the first read mislabels the second echo `world`.
  private readonly pendingSelfCausedFocus = new Map<WindowId, number>();

  readonly restackingTakesFocus = STACKING_TAKES_FOCUS;

  // Armed before the native show/hide call that can provoke it — a
  // `BaseWindow`'s native 'show'/'hide' can fire ahead of this method's own
  // synthetic echo, so the listener needs the token armed first.
  private readonly pendingShowOpSeq = new Map<WindowId, number>();
  // Page chrome overlays this backend flagged non-activating because the kernel
  // marked them so (over a held page); it unflags exactly these.
  private readonly chromeFlagged = new Set<WindowId>();
  private readonly pendingHideOpSeq = new Map<WindowId, number>();

  // A count, not a flag: `closeWindow` has two suspension points ahead of its
  // `win.close()` call, so two overlapping close calls on the same window
  // each arm independently and each must consume their own native 'close'.
  private readonly pendingMachineClose = new Map<WindowId, number>();

  private armMachineClose(id: WindowId): void {
    this.pendingMachineClose.set(id, (this.pendingMachineClose.get(id) ?? 0) + 1);
  }

  private consumeMachineCloseArm(id: WindowId): boolean {
    const count = this.pendingMachineClose.get(id);
    if (!count) return false;
    if (count > 1) this.pendingMachineClose.set(id, count - 1);
    else this.pendingMachineClose.delete(id);
    return true;
  }

  private quitting = false;

  private readonly quitPromptPending = new Set<WindowId>();

  private readonly fullscreenSettleTimers = new Map<WindowId, ReturnType<typeof setTimeout>>();

  private appResignSettleTimer: ReturnType<typeof setTimeout> | null = null;

  // The delayed re-asserts of the latest user raise; a newer user raise or the
  // target's close supersedes them.
  private readonly userRaiseReassert = new UserRaiseReassert<WindowId>();

  private escGrabRegistered = false;

  // The desktop provider this backend owns (specs/kernel-desktops.md, section 5);
  // `onDesktopTrigger` reports its reads to the kernel.
  private desktopProvider: FailSafeDesktopProvider | null = null;
  // The tail of the serialized provider reads.
  private desktopSync: Promise<void> = Promise.resolve();

  private readonly escGrabHandler = (): void => {
    // Reaches the same decision the before-input-event path does, so a stale
    // grab is harmless.
    dispatchEscapePress('global', 'electron-window-backend.escGrabHandler');
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Port: app-level listeners.
  // ───────────────────────────────────────────────────────────────────────────

  attachAppListeners(): void {
    // A fresh quit attempt: `before-quit` always fires strictly before Electron
    // begins closing any window for it, so no prompt record can be stale.
    (app as unknown as { on(e: string, l: () => void): void }).on('before-quit', () => {
      this.quitting = true;
      this.quitPromptPending.clear();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('will-quit', () => {
      this.quitting = false;
      this.quitPromptPending.clear();
      this.stopDesktopProvider();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('quit', () => {
      this.quitting = false;
      this.quitPromptPending.clear();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-become-active', () => {
      wmLog('app-did-become-active', { kernelActive: getAppActive() });
      kernelAppActivated();
      this.onDesktopTriggerCoalesced('app-active');
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      wmLog('app-did-resign-active', { kernelActive: getAppActive() });
      kernelAppResigned();
      this.onDesktopTriggerCoalesced('app-resign');
      if (this.appResignSettleTimer) clearTimeout(this.appResignSettleTimer);
      // Whether this settle sweeps anything is the kernel's decision
      // (`AppResignSettled` is inert after an overlay transition).
      this.appResignSettleTimer = setTimeout(() => {
        this.appResignSettleTimer = null;
        kernelAppResignSettled();
      }, APP_RESIGN_SETTLE_MS);
    });
    this.attachSpaceChangeListener();
    void app.whenReady().then(() => this.startDesktopProvider());
  }

  // Reports every desktop switch to the kernel at once as
  // `DesktopSwitchObserved`, then reads the provider, which reports the new
  // current desktop. The notification's `userInfo` is empty, so it names no
  // desktop. Other platforms' switches reach the kernel only through their
  // provider's own changes.
  private attachSpaceChangeListener(): void {
    if (process.platform !== 'darwin') return;
    systemPreferences.subscribeWorkspaceNotification(
      'NSWorkspaceActiveSpaceDidChangeNotification',
      () => {
        kernelDesktopSwitchObserved();
        const state = getKernelExecutor().getState();
        wmLog('space-changed', {
          // The kernel's desktops before the read that follows: the one left.
          screensBefore: this.describeScreens(),
          key: state.key,
          appActive: state.appActive,
          windows: this.describeDesktops(),
        });
        this.onDesktopTrigger('space-changed');
      },
    );
  }

  // `screen:current` per screen the kernel knows.
  private describeScreens(): string {
    return getKernelExecutor().getState().screens.map((s) => `${s.id}:${s.current}`).join(',');
  }

  // `id:screen/desktop:visible` per registered window, `*` for a window on
  // every desktop, `?` for a field not yet known.
  private describeDesktops(): string {
    const state = getKernelExecutor().getState();
    return state.order
      .map((r) => `${String(r.id)}:${r.screen ?? '?'}/${isOnEveryDesktop(r) ? '*' : (r.desktop ?? '?')}:${r.visible ? 'v' : 'h'}`)
      .join(',');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Desktop provider (specs/kernel-desktops.md, sections 5 and 6 "Electron
  // backend"). Screens are Electron displays, a `ScreenId` is the display id
  // as a string; on macOS the helper's display id is the same number, so the
  // mapping is the identity. Triggers: the provider's own changes, the desktop
  // switch notification, display added / removed / metrics changed.
  // ───────────────────────────────────────────────────────────────────────────

  private startDesktopProvider(): void {
    if (this.desktopProvider) return;
    const fallback = new FallbackDesktopProvider({
      screens: () => this.electronDisplayIds(),
      windowScreen: (pid) => {
        const win = this.nativeWindowForPlatformId(pid);
        if (!win) return null;
        try {
          return String(screen.getDisplayMatching(win.getBounds()).id);
        } catch {
          return null;
        }
      },
      onEveryDesktop: (pid) => {
        const id = this.windowIdForPlatformId(pid);
        const record = id === null ? null : windowById(getKernelExecutor().getState(), id);
        return record != null && isOnEveryDesktop(record);
      },
    });
    const mac =
      process.platform === 'darwin'
        ? new MacDesktopProvider({ command: macHelperPath(app.isPackaged, process.resourcesPath) })
        : null;
    const provider = new FailSafeDesktopProvider({ primary: mac, fallback });
    this.desktopProvider = provider;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      screen.on(event as 'display-added', () => this.onDesktopTrigger(event));
    }
    void provider
      .start((change) => this.onDesktopTrigger(`provider-${change.kind}`))
      .then(() => this.onDesktopTrigger('start'));
  }

  // The capabilities are the provider's own, read each time: the fail-safe wrapper may have
  // switched to the fallback provider, which can do neither.
  get canPlaceWindows(): boolean {
    return this.desktopProvider?.canPlaceWindows === true;
  }

  get canShowDesktops(): boolean {
    return this.desktopProvider?.canShowDesktops === true;
  }

  async placeWindowOnDesktop(id: WindowId, desktop: DesktopId): Promise<boolean> {
    const provider = this.desktopProvider;
    const win = this.windows.get(id)?.win;
    if (!provider || !win || !provider.canPlaceWindows) return false;
    const pid = this.platformWindowIdOf(win);
    if (pid === null) return false;
    const placed = await provider.placeWindow(pid, desktop);
    if (placed) this.onDesktopTrigger('place-window');
    return placed;
  }

  async showDesktop(desktop: DesktopId): Promise<boolean> {
    const provider = this.desktopProvider;
    if (!provider || !provider.canShowDesktops) return false;
    return provider.showDesktop(desktop);
  }

  private stopDesktopProvider(): void {
    this.desktopProvider?.stop();
    this.desktopProvider = null;
  }

  private electronDisplayIds(): string[] {
    try {
      return screen.getAllDisplays().map((d) => String(d.id));
    } catch {
      return [];
    }
  }

  // macOS: the window server number from the capture source id; X11: the X
  // window id; elsewhere Electron's own id, which only the fallback provider sees.
  private platformWindowIdOf(win: NativeWindow): PlatformWindowId | null {
    try {
      if (win.isDestroyed()) return null;
      if (process.platform === 'darwin') {
        return win.getMediaSourceId ? windowNumberFromSourceId(win.getMediaSourceId()) : null;
      }
      if (process.platform === 'linux') {
        const handle = win.getNativeWindowHandle?.();
        return handle && handle.length >= 4 ? handle.readUInt32LE(0) : null;
      }
      return win.id;
    } catch {
      return null;
    }
  }

  private windowIdForPlatformId(pid: PlatformWindowId): WindowId | null {
    for (const [id, { win }] of this.windows) {
      if (this.platformWindowIdOf(win) === pid) return id;
    }
    return null;
  }

  private nativeWindowForPlatformId(pid: PlatformWindowId): NativeWindow | null {
    const id = this.windowIdForPlatformId(pid);
    return id === null ? null : this.getNativeWindowFor(id);
  }

  // Every trigger reads the provider and reports what changed to the kernel
  // (specs/kernel-desktops.md, "Backend algorithm"). Reads run one at a time,
  // in trigger order, so a slow read never reports over a newer one.
  private onDesktopTrigger(trigger: string): void {
    this.desktopSync = this.desktopSync.then(() => this.syncDesktops(trigger));
  }

  // Triggers that fire in bursts (window moves) share one queued read: while one waits behind
  // the running read, another adds nothing.
  private desktopSyncQueued = false;
  private onDesktopTriggerCoalesced(trigger: string): void {
    if (this.desktopSyncQueued) return;
    this.desktopSyncQueued = true;
    this.desktopSync = this.desktopSync.then(() => {
      this.desktopSyncQueued = false;
      return this.syncDesktops(trigger);
    });
  }

  private syncDesktops(trigger: string): Promise<void> {
    return syncDesktopsRead(trigger, {
      provider: this.desktopProvider,
      getState: () => getKernelExecutor().getState(),
      platformIds: () => {
        const ids = new Map<PlatformWindowId, WindowId>();
        for (const [id, { win }] of this.windows) {
          const pid = this.platformWindowIdOf(win);
          if (pid !== null) ids.set(pid, id);
        }
        return ids;
      },
      layoutReported: kernelDesktopLayoutReported,
      currentDesktopChanged: kernelCurrentDesktopChanged,
      placementReported: kernelWindowPlacementReported,
      desktopsRead: kernelDesktopsRead,
      log: wmLog,
    });
  }

  // Resolves once a read queued by this call has been reported. A user's drag of a window to
  // another desktop fires nothing, so a caller that needs the real desktops (a snapshot save)
  // reads first.
  refreshDesktops(trigger: string): Promise<void> {
    this.onDesktopTrigger(trigger);
    return this.desktopSync;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Migration shims (see `BackendMigrationShims` for the absorption plan).
  // ───────────────────────────────────────────────────────────────────────────

  // Idempotent per underlying native window: more than one call site can
  // register the same window, and a repeat registration merges the (richer)
  // spec rather than re-attaching listeners — re-attaching would give one
  // physical Escape two `ESC_PRESSED` dispatches.
  registerWindow(spec: RegisterWindowSpec): BackendRegistration {
    const { kind, win } = spec;
    const rendererWC = spec.contentWC ?? null;

    const osWindowId = win.id;
    const existingId = this.idByOsWindowId.get(osWindowId);
    const existing = existingId === undefined ? undefined : this.windows.get(existingId);
    const decision = decideWindowRegistration({
      alreadyRegistered: existing !== undefined,
      kind,
      hasContentWC: spec.contentWC !== undefined,
      attachEscHandlerRequested: spec.attachEscHandler,
      nativeVisible: this.isVisibleSafe(win),
    });

    let id: WindowId;
    if (existing !== undefined && existingId !== undefined) {
      id = existingId;
      existing.win = win;
      existing.kind = kind;
      existing.windowClass = spec.class;
      if (decision.adoptRendererWC) existing.rendererWC = rendererWC;
    } else {
      this.windowIdCounter += 1;
      id = `wm-${this.windowIdCounter}` as WindowId;
      this.idByOsWindowId.set(osWindowId, id);
      this.windows.set(id, { win, kind, windowClass: spec.class, rendererWC });
    }

    if (decision.attachNativeListeners) {
      this.attachNativeListeners(id, osWindowId, win, kind, rendererWC);
    }
    // Every webContents a window adopts, including one adopted on a
    // re-registration, feeds the hold-to-drag gesture.
    if (decision.adoptRendererWC && rendererWC) this.wirePointerInput(id, rendererWC);

    let initialBounds: Rectangle | null = null;
    try {
      if (!win.isDestroyed()) initialBounds = win.getBounds();
    } catch {
      /* window gone mid-registration — no rect to seed */
    }

    DEBUG &&
      console.log(
        '[window-backend] registerWindow',
        id,
        'osWindowId',
        osWindowId,
        'kind',
        kind,
        'class',
        spec.class,
        'url',
        this.urlSafe(rendererWC),
      );

    const onEveryDesktop =
      process.platform === 'darwin' && spec.nonActivating === true && !isFlaggedNonActivating(win);
    return { id, decision, initialBounds, onEveryDesktop };
  }

  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null {
    let osId: number;
    if (typeof winOrOsId === 'number') {
      osId = winOrOsId;
    } else {
      try {
        osId = winOrOsId.id;
      } catch {
        return null; // destroyed native window — reading .id throws
      }
    }
    return this.idByOsWindowId.get(osId) ?? null;
  }

  getNativeWindowFor(id: WindowId): NativeWindow | null {
    const entry = this.windows.get(id);
    if (!entry) return null;
    try {
      if (entry.win.isDestroyed()) return null;
    } catch {
      return null;
    }
    return entry.win;
  }

  private osWindowIdOf(id: WindowId): number | null {
    const win = this.getNativeWindowFor(id);
    if (!win) return null;
    try {
      return win.id;
    } catch {
      return null;
    }
  }

  private workAreaNearest(content: Rectangle): Rectangle | null {
    try {
      return screen.getDisplayNearestPoint({
        x: content.x + Math.floor(content.width / 2),
        y: content.y + Math.floor(content.height / 2),
      }).workArea;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Native listeners: each is a one-line event translation, except `blur`
  // (arms the deferred-blur settle instead of emitting) and `close` (vetoes
  // and redirects into the kernel instead of reporting).
  // ───────────────────────────────────────────────────────────────────────────

  private attachNativeListeners(
    id: WindowId,
    osWindowId: number,
    win: NativeWindow,
    kind: WindowKind,
    rendererWC: NativeWebContents | null,
  ): void {
    // A click or key press inside a Peek window, so a trace shows what the user did between the
    // window manager's own events. Only the input type and, for keys, a non-printable key's name
    // are logged, never typed text.
    rendererWC?.on('input-event', (_event: unknown, input: unknown) => {
      const { type, key } = input as { type?: string; key?: string };
      if (type !== 'mouseDown' && type !== 'rawKeyDown') return;
      wmLog('user-input', { id, type, ...(type === 'rawKeyDown' && key !== undefined && key.length > 1 ? { key } : {}) });
    });
    win.on('focus', () => {
      this.onDesktopTriggerCoalesced('window-focus');
      wmLog('native-focus-arrived', { id, producer: 'host-window', ...this.describeInFlightOps() });
      this.cancelBlurSettle();
      // Taking focus instead of closing means a beforeunload prompt this
      // window was asked to unload for was answered "stay".
      if (this.quitPromptPending.delete(id)) this.quitting = false;
      // Every focus is reported with its raw cause; the kernel tells a focus
      // the platform handed out by itself from the user's
      // (`window-kernel.ts platformChoseFocus`).
      kernelOsFocusGained(id, this.takeFocusCause(id));
    });
    // Electron fires a losing window's blur before a gaining window's focus,
    // so a one-tick settle is what tells "focus left Peek" from "focus moved
    // to another Peek window".
    win.on('blur', () => {
      wmLog('native-blur', { id });
      this.pendingSelfCausedFocus.delete(id);
      this.armBlurSettle();
    });
    win.on('show', () => {
      // AppKit can deliver a stale 'show' after the machine already hid this
      // window again — validate against ground truth before echoing.
      const opSeq = this.pendingShowOpSeq.get(id);
      this.pendingShowOpSeq.delete(id);
      if (win.isDestroyed() || !win.isVisible()) return;
      // Only a show this backend performed confirms focus, under its own op
      // token. A show the platform made by itself (AppKit re-showing the page
      // chrome after a desktop switch and handing it key) reports visibility
      // only: its focus arrives through the `'focus'` listener above, which
      // is where platform-provoked focus is told from the user's.
      const focused = opSeq !== undefined && this.isFocused(win);
      // A show with no op token is one the platform made by itself; naming the window lets a trace
      // tell which one, since its desktop read below logs only the trigger.
      const shownState = getKernelExecutor().getState();
      wmLog('native-show', {
        id,
        opSeq: opSeq ?? null,
        focused: this.isFocused(win),
        desktop: windowById(shownState, id)?.desktop ?? null,
        currentDesktop: shownState.screens[0]?.current ?? null,
        appActive: getAppActive(),
      });
      kernelWindowShown(id, focused, opSeq);
      this.onDesktopTrigger('window-shown');
    });
    win.on('hide', () => {
      // AppKit can deliver a stale/lagged 'hide' for a BaseWindow that is
      // still on screen — validate against ground truth before echoing.
      const opSeq = this.pendingHideOpSeq.get(id);
      this.pendingHideOpSeq.delete(id);
      if (!win.isDestroyed() && win.isVisible()) return;
      kernelWindowHidden(id, opSeq);
    });
    // Veto a native close and let the kernel decide (close vs. hide for
    // keepLive) — except while quitting or while this backend's own
    // closeWindow is mid-call, both of which must reach win.close() for real.
    win.on('close', (...args: unknown[]) => {
      if (this.quitting) return;
      if (this.consumeMachineCloseArm(id)) return;
      const event = args[0] as { preventDefault(): void } | undefined;
      event?.preventDefault();
      kernelCloseOrHideRequested(id);
    });
    win.on('closed', () => {
      this.clearFullscreenSettle(id);
      this.userRaiseReassert.cancelFor(id);
      this.quitPromptPending.delete(id);
      this.pendingSelfCausedFocus.delete(id);
      this.pendingShowOpSeq.delete(id);
      this.pendingHideOpSeq.delete(id);
      this.pendingMachineClose.delete(id);
      this.windows.delete(id);
      this.idByOsWindowId.delete(osWindowId);
      windowDragWindowClosed(id);
      kernelWindowClosed(id);
    });
    win.on('enter-full-screen', () => {
      this.clearFullscreenSettle(id);
      kernelOsFullscreenEntered(id);
    });
    win.on('leave-full-screen', () => {
      this.clearFullscreenSettle(id);
      kernelOsFullscreenLeft(id);
    });
    // Every native resize/move lands in the machine as BOUNDS_CHANGED — the
    // sole writer of the record's `bounds`. Three native names, one
    // translation: `resize` + the continuous `move` fire on both kinds; macOS
    // additionally fires `moved` once at gesture-end.
    const emitBounds = (): void => {
      try {
        if (win.isDestroyed()) return;
        const bounds = win.getBounds();
        const overlayFrame =
          kind === 'page-host' ? expandToOverlayFrame(bounds, this.workAreaNearest(bounds)) : undefined;
        kernelBoundsChanged(id, bounds, overlayFrame);
      } catch {
        /* window gone mid-event */
      }
    };
    win.on('resize', emitBounds);
    win.on('move', emitBounds);
    win.on('moved', emitBounds);
    // A drag between desktops is not a switch; only a read finds where the window now is.
    win.on('moved', () => this.onDesktopTriggerCoalesced('window-moved'));
    // Every kind of window, not only page-hosts: any renderer can register a
    // beforeunload handler, and never preventDefault()s — this only watches.
    if (rendererWC) {
      rendererWC.on('will-prevent-unload', () => {
        if (this.quitting) this.quitPromptPending.add(id);
      });
    }
    // Page-host: clicking directly into the page focuses the content WC even
    // when the host BaseWindow's own `focus` is missed.
    if (kind === 'page-host' && rendererWC) {
      rendererWC.on('focus', () => {
        wmLog('native-focus-arrived', { id, producer: 'content-webcontents', ...this.describeInFlightOps() });
        this.cancelBlurSettle();
        const cause = this.takeFocusCause(id);
        kernelOsFocusGained(id, cause);
        kernelContentFirstResponderChanged(id, true);
      });
      rendererWC.on('blur', () => {
        kernelContentFirstResponderChanged(id, false);
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Hold-to-drag input and indicator (docs/design/window-drag.md). The gesture
  // itself is window-drag.ts; this backend only reports pointer events and
  // paints the hand cursor.
  // ───────────────────────────────────────────────────────────────────────────

  private readonly pointerWired = new WeakSet<NativeWebContents>();

  private wirePointerInput(id: WindowId, wc: NativeWebContents): void {
    if (this.pointerWired.has(wc)) return;
    this.pointerWired.add(wc);
    wc.on('input-event', (_event: unknown, input: unknown) => {
      const pointer = translatePointerInput(input);
      if (pointer) windowDragPointer(id, pointer);
    });
    wc.on('ipc-message', (_event: unknown, channel: unknown) => {
      if (channel === WINDOW_DRAG_PRESS_BLOCKED) windowDragVeto(id);
    });
  }

  // The hand cursor over a window's own webContents, with text selection off
  // while it shows.
  paintDragIndicator(id: WindowId, cursor: DragCursor): void {
    const wc = this.windows.get(id)?.rendererWC as (NativeWebContents & Partial<CursorWebContents>) | null | undefined;
    if (!wc || typeof wc.insertCSS !== 'function' || typeof wc.removeInsertedCSS !== 'function') return;
    try {
      if (wc.isDestroyed()) return;
    } catch {
      return;
    }
    setWebContentsCursor(wc as CursorWebContents, cursor ? { cursor, noSelect: true } : null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Focus provenance — see `pendingSelfCausedFocus`.
  // ───────────────────────────────────────────────────────────────────────────

  private armSelfCausedFocus(id: WindowId, opSeq: number): void {
    this.pendingSelfCausedFocus.set(id, opSeq);
  }

  // Reads the arming without deleting it: a page-host's two native focus
  // producers (host window, content WC) each call this for one machine-issued
  // op, and consuming on the first read mislabels the second echo `world`.
  private takeFocusCause(id: WindowId): FocusCause {
    const opSeq = this.pendingSelfCausedFocus.get(id);
    if (opSeq === undefined) {
      wmLog('focus-cause-taken', { id, kind: 'world' });
      return { kind: 'world' };
    }
    wmLog('focus-cause-taken', { id, kind: 'machine', opSeq });
    return { kind: 'machine', opSeq };
  }

  private describeInFlightOps(): WmLogFields {
    const listIds = (ids: Iterable<WindowId>): string => {
      const joined = Array.from(ids, String).join(',');
      return joined.length > 0 ? joined : 'none';
    };
    return {
      selfCausedFocusFor: listIds(this.pendingSelfCausedFocus.keys()),
      showOpFor: listIds(this.pendingShowOpSeq.keys()),
      hideOpFor: listIds(this.pendingHideOpSeq.keys()),
      machineCloseFor: listIds(this.pendingMachineClose.keys()),
    };
  }

  // Every caller arms the raise's own focus first, so a focus this restack
  // provokes reports as machine-caused.
  private reorderToTop(win: NativeWindow): void {
    try {
      win.moveTop();
    } catch {
      /* moveTop unsupported on some platforms, or torn down mid-raise — a no-op */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Port: commands.
  // ───────────────────────────────────────────────────────────────────────────

  // A raise on a window that is already visible and already key is a reorder
  // (`moveTop()`), never a `show()` — a show it doesn't need would re-grant
  // focus the OS already holds there, feeding the machine's own belief back
  // in as fresh evidence. `planRaiseRealization` decides the three-way split.
  raiseWindow(id: WindowId, opSeq: number, intent?: 'user'): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, rendererWC } = entry;
    if (win.isDestroyed()) return;
    // A newer user raise supersedes the re-asserts of an earlier one. A raise
    // without user intent does not: it can be the machine following the very
    // misdirected activation focus the re-assert exists to correct.
    if (intent === 'user') this.userRaiseReassert.cancel();
    const visible = this.isVisibleSafe(win);
    const focused = this.isFocused(win);
    const plan = planRaiseRealization(visible, focused);
    const record = windowById(getKernelExecutor().getState(), id);
    wmLog('raise-realized', { id, kind, visible, focused, plan, ...(intent === 'user' ? { intent } : {}) });
    // `showWindow` and `raiseWindow` read `nonActivating` off the kernel
    // record; `app.focus({ steal: true })` runs only for a user-intended
    // raise of a non-panel.
    const willAppFocus =
      intent === 'user' && plan !== 'reorder' && !record?.nonActivating && !isHeadless() && process.platform === 'darwin';
    wmLog('activation-decision', {
      id,
      intent: intent ?? 'none',
      plan,
      recordNonActivating: record?.nonActivating === true,
      flagged: isFlaggedNonActivating(win),
      headless: isHeadless(),
      appFocusCalled: willAppFocus,
      kernelActive: getAppActive(),
    });
    if (willAppFocus) {
      try {
        app.focus({ steal: true });
        wmLog('activation-after-app-focus', { id, kernelActive: getAppActive() });
        // macOS finishes the activation after this call returns and hands key
        // to the window that was key when the app last resigned, ahead of the
        // window this raise targeted. Re-assert the target once activation
        // has settled, if it did not end up key.
        // A newer user raise cancels these (see `userRaiseReassert`).
        this.userRaiseReassert.arm(id, opSeq, [250, 600], (_id, _opSeq, delayMs) => {
          wmLog('activation-reassert-timer', { id, delayMs, kernelActive: getAppActive(), focused: this.isFocused(win) });
          this.reassertUserRaise(id, opSeq);
        });
      } catch {
        /* activation refused by the OS — the window calls below still run */
      }
    }
    if (kind === 'page-host') {
      switch (plan) {
        case 'reorder':
        case 'take-key':
          this.armSelfCausedFocus(id, opSeq);
          this.reorderToTop(win);
          if (plan === 'take-key' && !isHeadless()) {
            try {
              this.takeKey(win);
            } catch {
              /* window gone mid-raise */
            }
          }
          break;
        case 'show-and-take-key':
          this.performOsShow(id, win, !isHeadless(), opSeq);
          break;
      }
      if (!isHeadless() && rendererWC && !rendererWC.isDestroyed()) {
        try {
          this.armSelfCausedFocus(id, opSeq);
          this.focusRendererContent(win, rendererWC);
        } catch {
          /* wc gone mid-raise */
        }
      }
      kernelWindowShown(id, true, opSeq);
      return;
    }
    switch (plan) {
      case 'reorder':
      case 'take-key':
        this.armSelfCausedFocus(id, opSeq);
        this.reorderToTop(win);
        if (plan === 'take-key' && !isHeadless()) {
          try {
            this.takeKey(win);
          } catch {
            /* window gone mid-raise */
          }
        }
        break;
      case 'show-and-take-key':
        this.performOsShow(id, win, !isHeadless(), opSeq);
        if (!isHeadless()) {
          try {
            this.armSelfCausedFocus(id, opSeq);
            this.takeKey(win);
          } catch {
            /* window gone mid-raise */
          }
        }
        break;
    }
    kernelWindowShown(id, true, opSeq);
  }

  // macOS only: activating the app is what makes the platform deliver
  // trackpad gestures to a window that opened without activating it. The
  // platform then hands key to the window that was key when the app last
  // resigned, so the asked-for window is re-asserted once activation settles.
  activateApp(id: WindowId): void {
    if (process.platform !== 'darwin' || isHeadless()) return;
    const entry = this.windows.get(id);
    if (!entry || entry.win.isDestroyed()) return;
    wmLog('activate-app', { id, kernelActive: getAppActive() });
    try {
      app.focus({ steal: true });
    } catch {
      /* activation refused by the OS */
      return;
    }
    this.userRaiseReassert.arm(id, 0, [250, 600], () => {
      this.reassertUserRaise(id, null);
    });
  }

  private reassertUserRaise(id: WindowId, opSeq: number | null): void {
    const entry = this.windows.get(id);
    if (!entry || entry.win.isDestroyed() || isHeadless()) return;
    if (this.isFocused(entry.win)) return;
    wmLog('reassert-user-raise', { id });
    try {
      if (opSeq !== null) this.armSelfCausedFocus(id, opSeq);
      this.reorderToTop(entry.win);
      this.takeKey(entry.win);
      const wc = entry.rendererWC;
      if (wc && !wc.isDestroyed()) this.focusRendererContent(entry.win, wc);
    } catch {
      /* window gone */
    }
  }

  focusContent(id: WindowId, opSeq: number): void {
    const entry = this.windows.get(id);
    const wc = entry?.rendererWC;
    if (!entry || !wc || wc.isDestroyed()) return;
    this.armSelfCausedFocus(id, opSeq);
    this.focusRendererContent(entry.win, wc);
  }

  // Electron's window and web contents `focus()` activate the app for any
  // non-panel, so a window flagged non-activating (`nonactivating-window.ts`)
  // takes key and content focus through the addon instead.
  private takeKey(win: NativeWindow): void {
    if (isFlaggedNonActivating(win)) {
      wmLog('native-make-key-no-activate', { where: 'take-key', id: this.getWindowIdFor(win) ?? undefined });
      makeKeyWithoutActivating(win);
    } else win.focus();
  }

  // Electron's `webContents.focus()` makes the window key first, then focuses
  // the contents; for a panel that takes key without activating. A flagged
  // window gets the same pair through the addon, or a non-activating show
  // followed by content focus (a peek over another app) leaves it without key.
  private focusRendererContent(win: NativeWindow, wc: NativeWebContents): void {
    if (isFlaggedNonActivating(win)) {
      const wid = this.getWindowIdFor(win) ?? undefined;
      wmLog('native-make-key-no-activate', { where: 'focus-content', id: wid });
      makeKeyWithoutActivating(win);
      const took = focusContentWithoutActivating(win);
      wmLog('native-focus-content-no-activate', { id: wid, took });
    } else {
      wc.focus();
    }
  }

  setFullscreen(id: WindowId, on: boolean): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    w.setFullScreen(on);
    // Arms the bounded settle timer so a transition that never emits its
    // native settled event self-corrects via RECONCILE_FULLSCREEN.
    this.armFullscreenSettle(id);
  }

  reconcileFullscreen(id: WindowId): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    const entered = w.isFullScreen();
    if (entered) {
      kernelOsFullscreenEntered(id);
    } else {
      kernelOsFullscreenLeft(id);
    }
  }

  closeOrHide(id: WindowId): Promise<void> {
    const osId = this.osWindowIdOf(id);
    if (osId == null) return Promise.resolve();
    return closeOrHideWindow(osId, 'backend:closeOrHide');
  }

  // A page-host's content view loads an arbitrary web page with no preload
  // that listens for the ask, so it can never answer and always resolves
  // `false` synchronously rather than waiting out the ask's timeout.
  askRendererHandledEscape(id: WindowId): Promise<boolean> {
    const entry = this.windows.get(id);
    const wc = entry?.rendererWC;
    if (!wc || wc.isDestroyed()) {
      // No renderer to ask → unhandled, so ESC still resolves.
      return Promise.resolve(false);
    }
    if (entry.kind === 'page-host') {
      wmLog('esc-ask-skipped', { id, reason: 'no-responder', kind: entry.kind });
      return Promise.resolve(false);
    }
    // `askWebContentsToHandleEscape` (windows.ts) still speaks Electron ids;
    // resolve the native id INSIDE the backend (the one place allowed to).
    return askWebContentsToHandleEscape(this.osWindowIdOf(id) ?? -1, wc as unknown as WebContents).then(
      (ans) => ans.handled,
    );
  }

  attachEscHandler(id: WindowId): void {
    const win = this.getNativeWindowFor(id);
    if (!win) return;
    try {
      addEscHandler(win as unknown as BrowserWindow);
    } catch (err) {
      DEBUG && console.log('[window-state] esc handler attach failed for', id, err);
    }
  }

  setEscGrab(on: boolean): void {
    if (on === this.escGrabRegistered) return;
    if (on) {
      try {
        this.escGrabRegistered = globalShortcut.register('Escape', this.escGrabHandler);
      } catch (err) {
        console.error('[window-state] Esc grab register failed:', err);
      }
    } else {
      try {
        globalShortcut.unregister('Escape');
      } catch {
        /* unregistering a hotkey not held is a no-op on some platforms */
      }
      this.escGrabRegistered = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §5 step 4 commands — close/destroy/show/hide/pin + guest teardown.
  // ───────────────────────────────────────────────────────────────────────────

  // The sole terminal-close path the kernel drives: exits native fullscreen
  // first if the window is in it, destroys its registered page-host guests
  // and waits (bounded) for them to actually go away, then closes the host.
  // `PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1` skips the guest pass (test/diagnostic
  // seam only) but still runs the fullscreen preamble.
  async closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    await this.exitFullscreenBeforeClose(win);
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    const guestIds = getGuestsForWindow(id);
    if (guestIds.length === 0 || process.env.PEEK_DISABLE_PAGEHOST_CLOSE_GUARD === '1') {
      this.armMachineClose(id);
      try {
        win.close();
      } catch {
        /* closing a torn-down window is a no-op */
      }
      return;
    }
    await this.destroyGuestsThenClose(id, win, guestIds);
  }

  // Closing (or hiding) a window mid the AppKit exit-fullscreen animation
  // strands an empty Space, so this awaits the exit first — bounded by the
  // same timeout the fullscreen-settle timer uses, so a destroyed/no-op
  // window that never fires `leave-full-screen` cannot hang the close.
  private exitFullscreenBeforeClose(win: NativeWindow): Promise<void> {
    let fullscreen: boolean;
    try {
      fullscreen = !win.isDestroyed() && win.isFullScreen();
    } catch {
      return Promise.resolve();
    }
    if (!fullscreen) return Promise.resolve();
    try {
      win.setFullScreen(false);
    } catch {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      win.on('leave-full-screen', finish);
      const timer = setTimeout(finish, FULLSCREEN_SETTLE_TIMEOUT_MS);
    });
  }

  private async destroyGuestsThenClose(id: WindowId, win: NativeWindow, guestIds: number[]): Promise<void> {
    DEBUG && console.log('[window-backend] destroying', guestIds.length, 'guest(s) before closing host');
    await destroyGuestsAndWait(this.resolveLiveGuests(guestIds), requestGuestDestroy);
    try {
      if (!win.isDestroyed()) {
        this.armMachineClose(id);
        win.close();
      }
    } catch {
      /* torn down while guests settled */
    }
  }

  private resolveLiveGuests(guestIds: readonly number[]): WebContents[] {
    const live: WebContents[] = [];
    for (const gid of guestIds) {
      try {
        const wc = webContents.fromId(gid);
        if (wc && !wc.isDestroyed()) live.push(wc);
      } catch {
        /* an id whose wc can't be resolved is already gone */
      }
    }
    return live;
  }

  destroyWindow(id: WindowId): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* destroying a torn-down window is a no-op */
    }
  }

  closeContent(id: WindowId): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!shouldCloseContentWCOnFinalize(wc)) return;
    try {
      wc!.close();
    } catch (e) {
      DEBUG && console.log('[window-backend] content wc close failed for', id, e);
    }
  }

  // `showWindow` and `raiseWindow` read `nonActivating` off the kernel record:
  // a Panel never activates the app on show, whatever the caller asked for.
  // The echo below still reports the caller's unmasked intent, which is what
  // keeps `front` moving under headless.
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind } = entry;
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    const record = windowById(getKernelExecutor().getState(), id);
    this.syncChromeFlag(id, win);
    // The shared chrome overlay is hidden between shows and anchored. Electron's
    // own membership calls do not move a hidden window to the desktop the user is
    // on (a show over a page on another desktop switched the user back), so the
    // addon marks it to appear on the active desktop. A flagged overlay already is.
    if (
      process.platform === 'darwin' &&
      !isHeadless() &&
      record?.tracksBaseLayerTop === true &&
      record.desktopMembership === 'anchor' &&
      !isFlaggedNonActivating(win)
    ) {
      const moved = moveToActiveDesktopOnShow(win);
      wmLog('overlay-move-to-active', { id, moved });
    }
    // A chrome overlay flagged over a held page takes key through the addon
    // without activating; any other non-activating window never activates.
    const osActivate = opts.activate && (record?.nonActivating !== true || this.chromeFlagged.has(id)) && !isHeadless();
    wmLog('os-show', {
      id,
      kind,
      activateRequested: opts.activate,
      osActivate,
      recordNonActivating: record?.nonActivating === true,
      chromeFlagged: this.chromeFlagged.has(id),
      flagged: isFlaggedNonActivating(win),
      path: !osActivate ? 'showInactive' : isFlaggedNonActivating(win) ? 'showInactive+makeKey' : 'show',
      kernelActive: getAppActive(),
    });
    const desktopBefore = record?.desktop ?? null;
    this.performOsShow(id, win, osActivate, opts.opSeq);
    kernelWindowShown(id, opts.activate, opts.opSeq);
    this.logShowOutcome(id, win, desktopBefore);
    this.onDesktopTrigger('window-shown');
  }

  // One diagnostic line after a show: whether the OS reports the window visible, whether the
  // kernel places it on a current desktop, its bounds, and the desktop the kernel had recorded
  // for it before and after. Diagnostic only.
  private logShowOutcome(id: WindowId, win: NativeWindow, desktopBefore: DesktopId | null): void {
    try {
      const after = windowById(getKernelExecutor().getState(), id);
      const b = win.isDestroyed() ? null : win.getBounds();
      wmLog('show-outcome', {
        id,
        visible: win.isDestroyed() ? false : win.isVisible(),
        onCurrentDesktop: after ? onCurrentDesktop(getKernelExecutor().getState(), after) : null,
        bounds: b ? `${b.x},${b.y},${b.width}x${b.height}` : null,
        desktopBefore,
        desktopAfter: after?.desktop ?? null,
      });
    } catch {
      /* diagnostics must never break a show */
    }
  }

  // Every show this backend performs funnels here. Opacity is zeroed before
  // the show, under headless, so nothing paints on the real display.
  private performOsShow(id: WindowId, win: NativeWindow, activate: boolean, opSeq: number): void {
    // Arm BEFORE either native call below — see `pendingShowOpSeq`'s doc:
    // the native `'show'` this provokes can land ahead of this method's own
    // synthetic echo, so the listener needs the token armed first.
    this.pendingShowOpSeq.set(id, opSeq);
    if (isHeadless()) {
      try {
        win.setOpacity(0);
      } catch {
        /* setOpacity unsupported on some platforms */
      }
    }
    if (activate && isFlaggedNonActivating(win)) {
      // A flagged window takes key without activating: shown inactive, then
      // made key through the addon. The `'focus'` that provokes is self-caused.
      try {
        this.armSelfCausedFocus(id, opSeq);
        win.showInactive();
        wmLog('native-make-key-no-activate', { where: 'os-show', id });
        makeKeyWithoutActivating(win);
      } catch {
        /* window gone mid-show */
      }
      this.pendingShowOpSeq.delete(id);
    } else if (activate) {
      try {
        // An activating show is `makeKeyAndOrderFront:` — it takes the macOS key
        // window, so the `'focus'` it provokes is self-caused. Armed only on this
        // branch: `showInactive()` below takes no focus at all (see
        // `pendingSelfCausedFocus`).
        this.armSelfCausedFocus(id, opSeq);
        win.show();
      } catch {
        /* show unsupported in some envs */
      }
    } else {
      try {
        win.showInactive();
      } catch {
        /* showInactive unsupported in some envs */
      }
      // `showInactive()` emits no native 'show' event, so a token armed above
      // would never be retired by the listener — retire it here instead,
      // since the synthetic echo `showWindow` emits carries the same opSeq.
      this.pendingShowOpSeq.delete(id);
    }
  }

  // Makes a page chrome overlay's native flag match the kernel record: flagged
  // exactly while the record says non-activating (over a held page). Unflagging
  // clears the window's desktop membership, so it is re-applied from the record.
  private syncChromeFlag(id: WindowId, win: NativeWindow): void {
    if (process.platform !== 'darwin' || isHeadless()) return;
    const record = windowById(getKernelExecutor().getState(), id);
    const want = record?.overlayFor !== undefined && record.nonActivating === true;
    try {
      if (win.isDestroyed()) return;
      if (want && !isFlaggedNonActivating(win)) {
        const flagged = flagNonActivating(win);
        wmLog('native-flag-non-activating', { id, ok: flagged });
        if (flagged) this.chromeFlagged.add(id);
        wmLog('chrome-flag', { id, on: true, flagged });
      } else if (!want && this.chromeFlagged.has(id)) {
        this.chromeFlagged.delete(id);
        const unflagged = unflagNonActivating(win);
        wmLog('native-unflag-non-activating', { id, ok: unflagged });
        wmLog('chrome-flag', { id, on: false, unflagged });
        if (unflagged && record?.desktopMembership !== undefined) {
          this.setDesktopMembership(id, record.desktopMembership);
        }
      }
    } catch {
      /* torn-down window mid-sync */
    }
  }

  hideWindow(id: WindowId, opSeq?: number): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    if (opSeq !== undefined) this.pendingHideOpSeq.set(id, opSeq);
    else this.pendingHideOpSeq.delete(id);
    try {
      if (win.isDestroyed()) return;
      win.hide();
      this.syncChromeFlag(id, win);
    } catch {
      /* hiding a torn-down window is a no-op */
      return;
    }
    // The native 'hide' event fires a tick late on macOS BaseWindows, so this
    // feed keeps kernel state (the overlay's host-visibility gate, `front`
    // successor promotion) truthful in the meantime; the late native event
    // still arrives and re-merges idempotently.
    kernelWindowHidden(id, opSeq);
  }

  // Realizes the kernel's hold above other apps / release pair on the existing
  // window: only its level changes, it is never re-created, shown or focused.
  // macOS restacks an ordinary-level window of a non-active app behind the
  // active app's frontmost window shortly after it is shown; the floating
  // level is exempt from that restack and takes neither activation nor key.
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setAlwaysOnTop(on, on ? 'floating' : undefined);
    } catch {
      /* pinning a torn-down window is a no-op */
    }
  }

  // A `pinned` window (the chrome overlay) needs `setAlwaysOnTop` rather than
  // `moveTop()`: `moveTop()` only reorders within the current level and
  // cannot lift the overlay back above the regular stack once anything
  // raises over it.
  setStacking(id: WindowId, level: StackingLevel): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      if (level === 'pinned') win.setAlwaysOnTop(true, 'floating');
      else win.moveTop();
    } catch {
      /* moveTop/setAlwaysOnTop unsupported on some platforms / torn-down window — a no-op */
    }
  }

  setWindowBounds(id: WindowId, rect: Rectangle): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setBounds(rect);
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
    }
  }

  // `skipTransformProcessType: true` rides every call here: without it macOS
  // toggles the app's activation policy mid-call and every other Peek window
  // flashes out for a frame. `'anchor'` is an ordered pair — `true` then
  // `false`, with different options — because a bare `false` call leaves the
  // window on whichever Space it was created from, not the user's active one.
  //
  // A window flagged non-activating is left alone: the addon already moves it
  // to the current desktop on every show, and AppKit rejects joining every
  // desktop together with that.
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void {
    if (process.platform !== 'darwin') return;
    const win = this.windows.get(id)?.win;
    if (!win || isFlaggedNonActivating(win)) return;
    try {
      if (win.isDestroyed()) return;
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      if (membership === 'anchor' && !win.isDestroyed()) {
        win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
      }
    } catch {
      /* Spaces write against a torn-down window — the machine already recorded intent */
    }
  }

  // `forward: true` rides every click-through call: it is what lets a
  // click-through window's own renderer keep seeing pointer-move, which the
  // chrome overlay's reveal/hover UI depends on.
  setAcceptsInput(id: WindowId, acceptsInput: boolean): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      this.syncChromeFlag(id, win);
      win.setIgnoreMouseEvents(!acceptsInput, { forward: true });
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
    }
  }

  // The frame a window draws for itself. Electron can change a live window's
  // shadow; its corner rounding is fixed when the window is created, so a
  // window keeps its corners and loses only the shadow.
  setChrome(id: WindowId, chrome: 'normal' | 'none'): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      win.setHasShadow?.(chrome === 'normal' && !isHeadless());
    } catch {
      /* torn-down window mid-command - the machine already recorded intent */
    }
  }

  // Reports through `kernelOverlayAttached` (an event, never a command):
  // this runs from inside the executor's `performEffect`, mid-pump, against
  // state that may not yet contain events the same transition already
  // queued, so deciding a command here would be exactly the re-entrancy this
  // effect exists to remove.
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void {
    if (hostId === null) {
      kernelOverlayAttached(overlayId, null);
      return;
    }
    const win = this.getNativeWindowFor(hostId);
    if (!win) {
      kernelOverlayAttached(overlayId, null);
      return;
    }
    try {
      const bounds = win.getBounds();
      const frame = expandToOverlayFrame(bounds, this.workAreaNearest(bounds));
      kernelOverlayAttached(overlayId, hostId, frame);
    } catch {
      /* host torn down mid-call — nothing left to attach to */
      kernelOverlayAttached(overlayId, null);
    }
  }

  // Async because issuing the `destroy()` calls is not the teardown:
  // `webContents.destroy()` returns without throwing while `isDestroyed()`
  // still reads `false`, so the caller must await this before quit proceeds.
  destroyAllContentGuests(): Promise<void> {
    const guests = this.resolveLiveGuests(getAllGuestWebContentsIds());
    DEBUG && console.log('[window-backend] quit teardown: destroying', guests.length, 'guest(s)');
    return destroyGuestsAndWait(guests, requestGuestDestroy, {
      overallMs: QUIT_GUEST_TEARDOWN_BUDGET_MS,
    });
  }

  // macOS only: `app.hide()` is an AppKit notion with no equivalent on other
  // platforms this backend runs on, so elsewhere this is correctly a no-op.
  hideApp(): void {
    if (process.platform !== 'darwin') return;
    DEBUG && console.log('[window-backend] hiding the app — nothing left holding it on screen');
    app.hide();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The one deferred-blur settle: the OS/Chromium boundary where "focus left
  // all Peek windows" is only knowable one tick after a blur.
  // ───────────────────────────────────────────────────────────────────────────

  private armBlurSettle(): void {
    if (this.pendingBlurSettle) return; // coalesce — at most one pending settle
    this.pendingBlurSettle = setImmediate(() => {
      this.pendingBlurSettle = null;
      // One tick later Electron has delivered any incoming focus. If some
      // Peek window now holds it, focus stayed in-app; otherwise it left the
      // whole group.
      if (this.anyWindowFocused()) return;
      wmLog('os-focus-left-app', { key: getKernelExecutor().getState().key });
      kernelOsFocusSettled();
    });
  }

  private cancelBlurSettle(): void {
    if (!this.pendingBlurSettle) return;
    clearImmediate(this.pendingBlurSettle);
    this.pendingBlurSettle = null;
  }

  private anyWindowFocused(): boolean {
    return this.focusedWindowId() !== null;
  }

  private focusedWindowId(): WindowId | null {
    for (const [id, { win }] of this.windows) {
      if (this.isFocused(win)) return id;
    }
    return null;
  }

  private isFocused(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isFocused();
    } catch {
      return false;
    }
  }

  private isVisibleSafe(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isVisible();
    } catch {
      return false;
    }
  }

  private urlSafe(wc: NativeWebContents | null): string {
    if (!wc || wc.isDestroyed()) return '';
    try {
      return wc.getURL();
    } catch {
      return '';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bounded fullscreen settle timer.
  // ───────────────────────────────────────────────────────────────────────────

  private armFullscreenSettle(id: WindowId): void {
    this.clearFullscreenSettle(id);
    this.fullscreenSettleTimers.set(
      id,
      setTimeout(() => {
        this.fullscreenSettleTimers.delete(id);
        kernelFullscreenSettleTimeout(id);
      }, FULLSCREEN_SETTLE_TIMEOUT_MS),
    );
  }

  private clearFullscreenSettle(id: WindowId): void {
    const t = this.fullscreenSettleTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.fullscreenSettleTimers.delete(id);
    }
  }
}
