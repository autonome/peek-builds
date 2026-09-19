// electron-window-backend.ts — the Electron implementation of the `WindowBackend`
// port; the only window-manager module that imports Electron.
// Sole authority on window identity: mints every `WindowId` and holds the only
// `WindowId` <-> Electron-id translation in the tree.
// Owns the two OS/Chromium boundary workarounds (deferred-blur settle, bounded
// fullscreen settle timer) and the focus-provenance arming that backs `FocusCause`.
// Design: `docs/design/window-manager.md`.

// A machine-initiated operation must not feed its own side effect back in as
// fresh OS evidence.

import { app, globalShortcut, screen, systemPreferences, webContents } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';

import { isHeadless, DEBUG } from './config.js';
import {
  askWebContentsToHandleEscape,
  closeOrHideWindow,
  addEscHandler,
} from './windows.js';
// `dispatchEscapePress` is called only inside `escGrabHandler`'s closure, never
// at this module's top level — window-machine.js imports this file directly.
import { dispatchEscapePress, getAppActive } from './window-machine.js';
import { getGuestsForWindow, getAllGuestWebContentsIds } from './webview-guest-registry.js';
import { getIzuiCoordinator } from './izui-state.js';
import {
  shouldCloseContentWCOnFinalize,
  decideWindowRegistration,
  type WindowClass,
  type StackingLevel,
  type WindowRegistrationDecision,
} from './izui-roles.js';
import type { DesktopMembership, FocusCause, WindowId, WindowKind, Rectangle } from './window-kernel.js';
import type { WindowBackend, WindowSpec } from './window-backend.js';
import {
  destroyGuestsAndWait,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';
import { expandToOverlayFrame } from './overlay-frame.js';
import { wmLog, type WmLogFields } from './window-diag.js';
import { FULLSCREEN_SETTLE_TIMEOUT_MS, windowById } from './window-kernel.js';
// The executor does not import this backend, so this is not a cycle.
import { planRaiseRealization, hideProvokesFocusReassignment } from './window-kernel-executor.js';
import {
  getKernelExecutor,
  kernelOsFocusGained,
  kernelOsFocusSettled,
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
  getBounds(): Rectangle;
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
}

export interface BackendRegistration {
  id: WindowId;
  decision: WindowRegistrationDecision;
  initialBounds: Rectangle | null;
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

  private readonly pendingStackingFocus = new Set<WindowId>();
  private pendingHideProvokedFocus = false;

  // Armed before the native show/hide call that can provoke it — a
  // `BaseWindow`'s native 'show'/'hide' can fire ahead of this method's own
  // synthetic echo, so the listener needs the token armed first.
  private readonly pendingShowOpSeq = new Map<WindowId, number>();
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

  private escGrabRegistered = false;

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
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('quit', () => {
      this.quitting = false;
      this.quitPromptPending.clear();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-become-active', () => {
      wmLog('diag-app-active', { active: true }); // TEMP-DIAG
      kernelAppActivated();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      wmLog('diag-app-active', { active: false }); // TEMP-DIAG
      kernelAppResigned();
      if (this.appResignSettleTimer) clearTimeout(this.appResignSettleTimer);
      this.appResignSettleTimer = setTimeout(() => {
        this.appResignSettleTimer = null;
        // A resign fired by an izui overlay entry/exit transition is
        // activation churn, not an app switch, so the settle point never
        // arrives for it — read at the producer since the coordinator's
        // cooldowns are the only signal for that churn.
        const coordinator = getIzuiCoordinator();
        if (coordinator.isWithinOverlayExitCooldown() || coordinator.isWithinOverlayEntryCooldown()) {
          DEBUG && console.log('[wm-backend] app-resign settle suppressed (izui overlay cooldown)');
          return;
        }
        kernelAppResignSettled();
      }, APP_RESIGN_SETTLE_MS);
    });
    this.attachSpaceChangeListener();
  }

  // The notification's `userInfo` is empty, so there is nothing to name the
  // Space we moved to — just logged, since nothing consumes it yet.
  private attachSpaceChangeListener(): void {
    if (process.platform !== 'darwin') return;
    systemPreferences.subscribeWorkspaceNotification(
      'NSWorkspaceActiveSpaceDidChangeNotification',
      () => {
        wmLog('space-changed');
      },
    );
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

    return { id, decision, initialBounds };
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
    win.on('focus', () => {
      wmLog('native-focus-arrived', { id, producer: 'host-window', ...this.describeInFlightOps() });
      this.cancelBlurSettle();
      // Taking focus instead of closing means a beforeunload prompt this
      // window was asked to unload for was answered "stay".
      if (this.quitPromptPending.delete(id)) this.quitting = false;
      const stackingProvoked = this.pendingStackingFocus.delete(id);
      // The platform provokes at most one focus for a whole stacking batch,
      // so this focus voids every other arming in it.
      this.pendingStackingFocus.clear();
      const cause = this.takeFocusCause(id);
      const suppressed = stackingProvoked && cause.kind !== 'machine';
      if (suppressed) {
        getKernelExecutor().markTimeline(`focus suppressed stacking-provoked ${String(id)} cause=${cause.kind}`);
        wmLog('os-focus-suppressed', { id, reason: 'stacking-provoked', causeKind: cause.kind });
        return;
      }
      const hideProvoked = this.pendingHideProvokedFocus;
      this.pendingHideProvokedFocus = false;
      if (hideProvoked && cause.kind !== 'machine') {
        getKernelExecutor().markTimeline(`focus suppressed hide-provoked ${String(id)} cause=${cause.kind}`);
        wmLog('os-focus-suppressed', { id, reason: 'hide-provoked', causeKind: cause.kind });
        return;
      }
      kernelOsFocusGained(id, cause);
    });
    // Electron fires a losing window's blur before a gaining window's focus,
    // so a one-tick settle is what tells "focus left Peek" from "focus moved
    // to another Peek window".
    win.on('blur', () => {
      this.pendingSelfCausedFocus.delete(id);
      this.pendingStackingFocus.delete(id);
      this.armBlurSettle();
    });
    win.on('show', () => {
      // AppKit can deliver a stale 'show' after the machine already hid this
      // window again — validate against ground truth before echoing.
      const opSeq = this.pendingShowOpSeq.get(id);
      this.pendingShowOpSeq.delete(id);
      if (win.isDestroyed() || !win.isVisible()) return;
      const focused = this.isFocused(win);
      kernelWindowShown(id, focused, opSeq);
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
      this.quitPromptPending.delete(id);
      this.pendingSelfCausedFocus.delete(id);
      this.pendingStackingFocus.delete(id);
      this.pendingShowOpSeq.delete(id);
      this.pendingHideOpSeq.delete(id);
      this.pendingMachineClose.delete(id);
      this.windows.delete(id);
      this.idByOsWindowId.delete(osWindowId);
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
  // Focus provenance — see `pendingSelfCausedFocus`.
  // ───────────────────────────────────────────────────────────────────────────

  private armSelfCausedFocus(id: WindowId, opSeq: number): void {
    this.pendingSelfCausedFocus.set(id, opSeq);
    this.pendingStackingFocus.delete(id);
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
      stackingFor: listIds(this.pendingStackingFocus.keys()),
      machineCloseFor: listIds(this.pendingMachineClose.keys()),
    };
  }

  // Reuses `pendingStackingFocus` — the same arming `setStacking` carries for
  // the same `moveTop()` primitive — rather than a second suppression mechanism.
  private reorderToTop(id: WindowId, win: NativeWindow): void {
    try {
      if (STACKING_TAKES_FOCUS) this.pendingStackingFocus.add(id);
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
    const visible = this.isVisibleSafe(win);
    const focused = this.isFocused(win);
    const plan = planRaiseRealization(visible, focused);
    const record = windowById(getKernelExecutor().getState(), id);
    wmLog('raise-realized', { id, kind, visible, focused, plan, ...(intent === 'user' ? { intent } : {}) });
    // `showWindow` and `raiseWindow` read `nonActivating` off the kernel
    // record; `app.focus({ steal: true })` runs only for a user-intended
    // raise of a non-panel.
    if (intent === 'user' && plan !== 'reorder' && !record?.nonActivating && !isHeadless() && process.platform === 'darwin') {
      try {
        app.focus({ steal: true });
      } catch {
        /* activation refused by the OS — the window calls below still run */
      }
    }
    if (kind === 'page-host') {
      switch (plan) {
        case 'reorder':
        case 'take-key':
          this.armSelfCausedFocus(id, opSeq);
          this.reorderToTop(id, win);
          if (plan === 'take-key' && !isHeadless()) {
            try {
              win.focus();
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
          rendererWC.focus();
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
        this.reorderToTop(id, win);
        if (plan === 'take-key' && !isHeadless()) {
          try {
            win.focus();
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
            win.focus();
          } catch {
            /* window gone mid-raise */
          }
        }
        break;
    }
    kernelWindowShown(id, true, opSeq);
  }

  focusContent(id: WindowId, opSeq: number): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) return;
    this.armSelfCausedFocus(id, opSeq);
    wc.focus();
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
    return closeOrHideWindow(osId);
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
    const osActivate = opts.activate && record?.nonActivating !== true && !isHeadless();
    this.performOsShow(id, win, osActivate, opts.opSeq);
    kernelWindowShown(id, opts.activate, opts.opSeq);
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
    if (activate) {
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

  hideWindow(id: WindowId, opSeq?: number): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    if (opSeq !== undefined) this.pendingHideOpSeq.set(id, opSeq);
    else this.pendingHideOpSeq.delete(id);
    try {
      if (win.isDestroyed()) return;
      // Hiding the focused window makes the platform reassign focus to a
      // window the machine never named — gated on the window actually
      // holding focus, since hiding an unfocused window reassigns nothing.
      // and on the app being active, since an inactive app's hide reassigns
      // nothing either and the unanswered expectation would swallow the next
      // real focus. The kernel's record of app activity is the authority: the
      // platform's own query answers true while an inactive app's palette
      // holds key, which is exactly the case this guards.
      this.pendingHideProvokedFocus = hideProvokesFocusReassignment(this.isFocused(win), getAppActive());
      win.hide();
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
    // TEMP-DIAG: while any window is held, sample every native window once a
    // second. A read-only observation sampler, not a wait on anything: native
    // window level and visibility change with no event to hang a log on.
    wmLog('diag-pin', { id, on });
    if (on && !this.diagDumpTimer) {
      this.diagDumpTimer = setInterval(() => this.diagDumpWindows('tick'), 1000);
    }
    this.diagDumpWindows(on ? 'hold' : 'release');
  }

  // TEMP-DIAG
  private diagDumpTimer: ReturnType<typeof setInterval> | null = null;
  private diagAcceptsInput = new Map<WindowId, boolean>();
  private diagDumpWindows(why: string): void {
    for (const [wid, entry] of this.windows) {
      const w = entry.win as unknown as {
        isDestroyed(): boolean;
        isVisible(): boolean;
        isAlwaysOnTop(): boolean;
        isFocused?(): boolean;
        getOpacity?(): number;
        getBounds(): Rectangle;
      };
      try {
        if (!w || w.isDestroyed()) continue;
        if (!w.isVisible()) continue;
        const b = w.getBounds();
        wmLog('diag-win', {
          why,
          id: wid,
          onTop: w.isAlwaysOnTop(),
          focused: w.isFocused ? w.isFocused() : undefined,
          opacity: w.getOpacity ? w.getOpacity() : undefined,
          acceptsInput: this.diagAcceptsInput.get(wid),
          bounds: `${b.x},${b.y},${b.width}x${b.height}`,
        });
      } catch {
        /* diag only */
      }
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
      if (STACKING_TAKES_FOCUS) this.pendingStackingFocus.add(id);
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
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void {
    if (process.platform !== 'darwin') return;
    const win = this.windows.get(id)?.win;
    if (!win) return;
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
      win.setIgnoreMouseEvents(!acceptsInput, { forward: true });
      // TEMP-DIAG
      this.diagAcceptsInput.set(id, acceptsInput);
      wmLog('diag-accepts-input', { id, acceptsInput, visible: win.isVisible() });
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
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
      kernelOsFocusSettled();
    });
  }

  private cancelBlurSettle(): void {
    if (!this.pendingBlurSettle) return;
    clearImmediate(this.pendingBlurSettle);
    this.pendingBlurSettle = null;
  }

  private anyWindowFocused(): boolean {
    for (const { win } of this.windows.values()) {
      if (this.isFocused(win)) return true;
    }
    return false;
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
