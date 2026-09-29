// electron-window-backend.ts — the Electron implementation of the `WindowBackend`
// port; the only window-manager module that imports Electron.
// Sole authority on window identity: mints every `WindowId` and holds the only
// `WindowId` <-> Electron-id translation in the tree.
// Owns the two OS/Chromium boundary workarounds (deferred-blur settle, bounded
// fullscreen settle timer) and the focus-provenance arming that backs `FocusCause`.
// Design: `docs/design/window-manager.md`.

// A machine-initiated operation must not feed its own side effect back in as
// fresh OS evidence.

import { app, BaseWindow, BrowserWindow, globalShortcut, screen, systemPreferences, webContents } from 'electron';
import type { WebContents } from 'electron';

import {
  FailSafeDesktopProvider,
  type Placement,
  type PlatformWindowId,
  type ProviderDisplayId,
  type ProviderLayout,
} from './desktop-provider.js';
import { FallbackDesktopProvider } from './desktop-provider-fallback.js';
import { MacDesktopProvider, macHelperPath, windowNumberFromSourceId } from './desktop-provider-mac.js';
import {
  focusContentWithoutActivating,
  isFlaggedNonActivating,
  makeKeyWithoutActivating,
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
import { dispatchEscapePress } from './window-machine.js';
import { getGuestsForWindow, getAllGuestWebContentsIds } from './webview-guest-registry.js';
import {
  shouldCloseContentWCOnFinalize,
  decideWindowRegistration,
  type WindowClass,
  type StackingLevel,
  type WindowRegistrationDecision,
} from './izui-roles.js';
import type { DesktopMembership, FocusCause, ScreenId, WindowId, WindowKind, Rectangle } from './window-kernel.js';
import type { WindowBackend, WindowSpec } from './window-backend.js';
import {
  destroyGuestsAndWait,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';
import { expandToOverlayFrame } from './overlay-frame.js';
import { wmLog, type WmLogFields } from './window-diag.js';
import { FULLSCREEN_SETTLE_TIMEOUT_MS, isOnEveryDesktop, windowById } from './window-kernel.js';
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

// Temporary diagnostic mode for the macOS provider's live acceptance check
// (specs/kernel-desktops.md, 7.2): logs `desktop-read` on every trigger and
// binds the write test to Control+Option+Command+1. No behaviour change.
const DESKTOP_PROBE = process.env.PEEK_DESKTOP_PROBE === '1';

// A screen is an Electron display, named by its id; the providers name displays
// by the same number, so the mapping is the identity. A provider screen that
// stands for every display at once (`null`) is the one screen `shared`.
function screenIdOf(display: ProviderDisplayId | null): ScreenId {
  return display ?? 'shared';
}
const DESKTOP_PROBE_WRITE_ACCELERATOR = 'Control+Alt+Command+1';
// Time for the window server to take in a freshly shown test window before reading it.
const DESKTOP_PROBE_SETTLE_MS = 300;
// `probePlace` bypasses the fail-safe wrapper's request timeout, so it gets its own.
const DESKTOP_PROBE_PLACE_TIMEOUT_MS = 2000;

interface DesktopProbeWindows {
  red: BaseWindow;
  placeholder: BaseWindow;
}

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

  // The desktop provider this backend owns (specs/kernel-desktops.md, section 5);
  // `onDesktopTrigger` reports its reads to the kernel.
  private desktopProvider: FailSafeDesktopProvider | null = null;
  // The tail of the serialized provider reads.
  private desktopSync: Promise<void> = Promise.resolve();
  // The same macOS provider the fail-safe wrapper holds, kept for the probe's
  // write test, which the provider interface does not offer.
  private macDesktopProvider: MacDesktopProvider | null = null;
  private desktopProbeWindows: DesktopProbeWindows | null = null;

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
      kernelAppActivated();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      kernelAppResigned();
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
    this.macDesktopProvider = mac;
    const provider = new FailSafeDesktopProvider({ primary: mac, fallback });
    this.desktopProvider = provider;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      screen.on(event as 'display-added', () => this.onDesktopTrigger(event));
    }
    void provider
      .start((change) => this.onDesktopTrigger(`provider-${change.kind}`))
      .then(() => {
        if (!DESKTOP_PROBE) {
          this.onDesktopTrigger('start');
          return;
        }
        const hello = mac?.hello;
        if (hello && !provider.onFallback) {
          const symbols = Object.entries(hello.symbols)
            .map(([name, ok]) => `${name}:${ok ? 'y' : 'n'}`)
            .join(',');
          wmLog('desktop-probe-hello', { version: hello.version, symbols });
        }
        this.installDesktopProbeShortcut();
        this.onDesktopTrigger('start');
      });
  }

  private stopDesktopProvider(): void {
    this.desktopProvider?.stop();
    this.desktopProvider = null;
    this.macDesktopProvider = null;
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
    if (id !== null) return this.getNativeWindowFor(id);
    const probe = this.desktopProbeWindows;
    if (probe) {
      for (const w of [probe.red, probe.placeholder]) {
        if (this.platformWindowIdOf(w as unknown as NativeWindow) === pid) return w as unknown as NativeWindow;
      }
    }
    return null;
  }

  // Every trigger reads the provider and reports what changed to the kernel
  // (specs/kernel-desktops.md, "Backend algorithm"). Reads run one at a time,
  // in trigger order, so a slow read never reports over a newer one.
  private onDesktopTrigger(trigger: string): void {
    this.desktopSync = this.desktopSync.then(() => this.syncDesktops(trigger));
    if (DESKTOP_PROBE) void this.desktopSync.then(() => this.probeRead(trigger));
  }

  // Every path ends with `kernelDesktopsRead`, a failed read included: a switch
  // notice left uncovered would keep every window off the current desktop.
  private async syncDesktops(trigger: string): Promise<void> {
    const switchesSeen = getKernelExecutor().getState().desktopSwitchCount;
    const provider = this.desktopProvider;
    if (!provider) {
      kernelDesktopsRead(switchesSeen);
      return;
    }
    try {
      const layout = await provider.layout();
      const screens = layout.screens.map((s) => ({ id: screenIdOf(s.display), current: s.current }));
      const desktops = layout.desktops.map((d) => ({ id: d.id, screen: d.display === null ? null : screenIdOf(d.display) }));
      // A change of screens or desktops is a layout report; a change of only
      // which desktop a screen shows is a `CurrentDesktopChanged`.
      const before = getKernelExecutor().getState();
      const sameLayout =
        JSON.stringify(before.desktops) === JSON.stringify(desktops) &&
        JSON.stringify(before.screens.map((s) => s.id)) === JSON.stringify(screens.map((s) => s.id));
      if (!sameLayout) kernelDesktopLayoutReported(screens, desktops);
      for (const s of screens) {
        const known = getKernelExecutor().getState().screens.find((k) => k.id === s.id);
        if (known?.current !== s.current) kernelCurrentDesktopChanged(s.id, s.current);
      }

      // Placements go before `kernelDesktopsRead`: the kernel ends a transient
      // window left on another desktop on that event, from these placements.
      const ids = new Map<PlatformWindowId, WindowId>();
      for (const [id, { win }] of this.windows) {
        const pid = this.platformWindowIdOf(win);
        if (pid !== null) ids.set(pid, id);
      }
      const placements = await provider.placements([...ids.keys()]);
      for (const p of placements) {
        const id = ids.get(p.window);
        const record = id === undefined ? null : windowById(getKernelExecutor().getState(), id);
        if (id === undefined || record === null) continue;
        const screenId = p.display === null ? null : screenIdOf(p.display);
        const changed =
          (screenId !== null && screenId !== record.screen) ||
          (p.desktop !== null && p.desktop !== record.desktop) ||
          p.onEveryDesktop !== (record.onEveryDesktop === true);
        if (changed) kernelWindowPlacementReported(id, screenId, p.desktop, p.onEveryDesktop);
      }
      kernelDesktopsRead(switchesSeen);
    } catch (err) {
      wmLog('desktop-sync-failed', { trigger, error: err instanceof Error ? err.message : String(err) });
      kernelDesktopsRead(switchesSeen);
    }
  }

  // ─── Temporary probe (PEEK_DESKTOP_PROBE=1) ───────────────────────────────

  // `id#platformId` for every registered window and the probe's test windows.
  private probeWindowLabels(): Map<PlatformWindowId, string> {
    const labels = new Map<PlatformWindowId, string>();
    for (const [id, { win }] of this.windows) {
      const pid = this.platformWindowIdOf(win);
      if (pid !== null) labels.set(pid, `${String(id)}#${pid}`);
    }
    const probe = this.desktopProbeWindows;
    if (probe) {
      const red = this.platformWindowIdOf(probe.red as unknown as NativeWindow);
      const placeholder = this.platformWindowIdOf(probe.placeholder as unknown as NativeWindow);
      if (red !== null) labels.set(red, `red#${red}`);
      if (placeholder !== null) labels.set(placeholder, `placeholder#${placeholder}`);
    }
    return labels;
  }

  private static describeLayout(layout: ProviderLayout, electronDisplays: readonly string[]): WmLogFields {
    const known = new Set(electronDisplays);
    return {
      screens: layout.screens
        .map((s) => `${s.display ?? 'shared'}:${s.current}:${s.display === null || known.has(s.display) ? 'mapped' : 'unmapped'}`)
        .join(','),
      desktops: layout.desktops.map((d) => `${d.id}@${d.display ?? 'shared'}`).join(','),
      electronDisplays: electronDisplays.join(','),
    };
  }

  private static describePlacements(placements: readonly Placement[], labels: Map<PlatformWindowId, string>): string {
    return placements
      .map((p) => `${labels.get(p.window) ?? `?#${p.window}`}:${p.display ?? '?'}/${p.onEveryDesktop ? '*' : (p.desktop ?? '?')}`)
      .join(',');
  }

  private async probeRead(trigger: string, extra: WmLogFields = {}): Promise<void> {
    const provider = this.desktopProvider;
    if (!provider) return;
    try {
      const layout = await provider.layout();
      const labels = this.probeWindowLabels();
      const placements = await provider.placements([...labels.keys()]);
      wmLog('desktop-read', {
        trigger,
        provider: provider.name,
        ...ElectronWindowBackend.describeLayout(layout, this.electronDisplayIds()),
        windows: ElectronWindowBackend.describePlacements(placements, labels),
        ...extra,
      });
    } catch (err) {
      wmLog('desktop-read-failed', { trigger, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private installDesktopProbeShortcut(): void {
    try {
      const ok = globalShortcut.register(DESKTOP_PROBE_WRITE_ACCELERATOR, () => void this.probeWriteTest());
      wmLog('desktop-probe-shortcut', { accelerator: DESKTOP_PROBE_WRITE_ACCELERATOR, registered: ok });
    } catch (err) {
      wmLog('desktop-probe-shortcut', { accelerator: DESKTOP_PROBE_WRITE_ACCELERATOR, registered: false, error: String(err) });
    }
  }

  // The write test of spec 7.2 step 4: a small opaque red window and a
  // placeholder window (not a panel, zero opacity, click-through) shown on the
  // current desktop, both read; then the helper is asked to move the red
  // window to another desktop of its screen and it is read again. BaseWindows,
  // so they never pass through the app's window registration. A repeat press
  // only reads again.
  private async probeWriteTest(): Promise<void> {
    if (this.desktopProbeWindows) {
      await this.probeRead('probe-hotkey');
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const red = new BaseWindow({
      x: area.x + 40,
      y: area.y + 40,
      width: 120,
      height: 120,
      frame: false,
      resizable: false,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#ff0000',
      show: false,
    });
    const placeholder = new BaseWindow({
      x: area.x + Math.floor(area.width / 2) - 240,
      y: area.y + Math.floor(area.height / 2) - 180,
      width: 480,
      height: 360,
      frame: false,
      focusable: false,
      hasShadow: false,
      show: false,
    });
    placeholder.setOpacity(0);
    placeholder.setIgnoreMouseEvents(true);
    this.desktopProbeWindows = { red, placeholder };
    red.showInactive();
    placeholder.showInactive();
    await new Promise((resolve) => setTimeout(resolve, DESKTOP_PROBE_SETTLE_MS));
    await this.probeRead('probe-write-before');

    const provider = this.desktopProvider;
    const mac = this.macDesktopProvider;
    const redPid = this.platformWindowIdOf(red as unknown as NativeWindow);
    if (!provider || !mac || provider.onFallback || redPid === null) {
      wmLog('desktop-probe-write', { attempted: false, reason: provider?.onFallback ? 'fallback' : 'no-mac-provider-or-window-number' });
      return;
    }
    const [placement] = await provider.placements([redPid]);
    const layout = await provider.layout();
    const onScreen = layout.screens.find((s) => s.display === (placement?.display ?? null)) ?? layout.screens[0];
    const target = layout.desktops.find((d) => d.display === (onScreen?.display ?? null) && d.id !== onScreen?.current);
    if (!target) {
      wmLog('desktop-probe-write', { attempted: false, reason: 'no-other-desktop', from: placement?.desktop ?? null });
      return;
    }
    try {
      const result = await Promise.race([
        mac.probePlace(redPid, target.id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('place-timeout')), DESKTOP_PROBE_PLACE_TIMEOUT_MS),
        ),
      ]);
      wmLog('desktop-probe-write', {
        window: redPid,
        from: placement?.desktop ?? null,
        to: target.id,
        attempted: result.attempted,
        desktopsAfter: result.desktops.join(','),
      });
    } catch (err) {
      wmLog('desktop-probe-write', { window: redPid, to: target.id, error: err instanceof Error ? err.message : String(err) });
    }
    await this.probeRead('probe-write-after');
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
    win.on('focus', () => {
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
      this.quitPromptPending.delete(id);
      this.pendingSelfCausedFocus.delete(id);
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
    if (isFlaggedNonActivating(win)) makeKeyWithoutActivating(win);
    else win.focus();
  }

  // Electron's `webContents.focus()` makes the window key first, then focuses
  // the contents; for a panel that takes key without activating. A flagged
  // window gets the same pair through the addon, or a non-activating show
  // followed by content focus (a peek over another app) leaves it without key.
  private focusRendererContent(win: NativeWindow, wc: NativeWebContents): void {
    if (isFlaggedNonActivating(win)) {
      makeKeyWithoutActivating(win);
      focusContentWithoutActivating(win);
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
    this.onDesktopTrigger('window-shown');
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

  hideWindow(id: WindowId, opSeq?: number): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    if (opSeq !== undefined) this.pendingHideOpSeq.set(id, opSeq);
    else this.pendingHideOpSeq.delete(id);
    try {
      if (win.isDestroyed()) return;
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
      win.setIgnoreMouseEvents(!acceptsInput, { forward: true });
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
