// The ONE live ElectronWindowBackend for the desktop app, plus the thin read/dispatch surface
// ipc.ts / tile-ipc.ts / windows.ts / main.ts / hybrid-overlay.ts / tile-launcher.ts use. The
// backend is constructed lazily on first access and made live (native app listeners attached,
// session mirror seeded) once from main.ts at boot, via initWindowStateMachine(). Design: docs/design/window-manager.md.
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { ElectronWindowBackend, type RegisterWindowSpec } from './electron-window-backend.js';
import { getKernelExecutor as buildKernelExecutor } from './window-kernel-singleton.js';
import type { WindowKernelExecutor } from './window-kernel-executor.js';
import { getIzuiCoordinator } from './izui-state.js';
import type { EscapeMode } from './window-backend.js';
import type { Rectangle, WindowId, WindowKind, WindowRecord as KernelWindowRecord } from './window-kernel.js';
import { isWebPageRole, type WindowClass } from './izui-roles.js';
import {
  setKernelExecutorProvider,
  kernelRegisterWindow,
  kernelWindowShown,
  getKernelExecutor,
} from './window-kernel-dispatch.js';
import { topmost, isContentWindow, windowById } from './window-kernel.js';
import { handleEscapePress, type EscapeRuntimeDeps } from './window-escape-runtime.js';
import { publish, getSystemAddress } from './pubsub.js';
import { wmLog } from './window-diag.js';
import { setWindowOpenPayload } from './window-open-registry.js';

// Register-spec that accepts real Electron window handles (both kinds satisfy the backend's
// structural NativeWindow).
export interface MachineWindowSpec {
  kind: WindowKind;
  role: string;
  // Required; ordinary opens use classifyWindowRegistration, infrastructure classes declare theirs.
  class: WindowClass;
  satellite: boolean;
  escapeMode?: EscapeMode;
  // Drives the parent-refocus transition on WINDOW_CLOSED.
  parentId?: WindowId | null;
  // Opening source + open params, opaque and held by reference on the reducer record.
  source?: string;
  params?: Record<string, unknown>;
  alwaysOnTop?: boolean;
  keepLive?: boolean;
  tracksBaseLayerTop?: boolean;
  selfClosesOnBlur?: boolean;
  nonActivating?: boolean;
  appLifetime?: boolean;
  // BaseWindow (page-host) or BrowserWindow (browser).
  win: BaseWindow | BrowserWindow;
  // Content view WC for a page-host, root WC for a browser.
  contentWC?: WebContents | null;
  // Opt out of the backend-owned before-input-event Esc interceptor (browser windows only,
  // default on) — the shared chrome overlay is the one caller that passes false.
  attachEscHandler?: boolean;
  // The kernel's three orthogonal per-window fields (izui-roles.ts WindowSurfaceProperties) —
  // required so every registration site declares them explicitly.
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
}

let backend: ElectronWindowBackend | null = null;
let sessionSeeded = false;

function getWindowBackend(): ElectronWindowBackend {
  if (!backend) backend = new ElectronWindowBackend();
  return backend;
}

// Every window operation goes through this one backend instance, so kernel ids and the ids
// getWindowIdFor/getNativeWindowFor resolve are the same ids.
export function getKernelExecutorForApp(): WindowKernelExecutor {
  return buildKernelExecutor(getWindowBackend());
}

// Call ONCE from main.ts after the coordinator exists. Idempotent.
export function initWindowStateMachine(): void {
  // The provider is a lazy thunk because window-kernel-dispatch.ts must not value-import this
  // module — see docs/design/window-manager.md for the import-cycle and ELECTRON_RUN_AS_NODE=1 reasons.
  setKernelExecutorProvider(() => getKernelExecutorForApp());
  getWindowBackend().attachAppListeners();
  seedSessionMirror();
}

// Keeps the izui coordinator's own display-facing state (mode indicator, tile:izui:* handlers)
// accurate: front-id provider for switcher focus-restore, the app-active fact, and its
// gained-focus edge. Nothing decides on the coordinator's session anymore.
function seedSessionMirror(): void {
  if (sessionSeeded) return;
  sessionSeeded = true;
  const coord = getIzuiCoordinator();
  coord.setFrontWindowIdProvider(() => {
    const front = getTopmostContentWindowId();
    if (front == null) return null;
    const native = getNativeWindowFor(front);
    return native ? native.id : null;
  });
  coord.setAppActiveProvider(() => getAppActive());
  // Gained-focus edge only — losing focus has no session-side effect of its own.
  subscribeAppActive((active) => {
    if (active) coord.notifyAppActiveGained();
  });
}

export function registerWindowWithMachine(spec: MachineWindowSpec): WindowId {
  // Both BaseWindow and BrowserWindow satisfy the backend's structural NativeWindow; the electron
  // typed-overload `on` isn't assignable to the loose `on` shape, so bridge with a single cast here.
  const { id, decision, initialBounds } = getWindowBackend().registerWindow(spec as unknown as RegisterWindowSpec);
  // The registry payload rides the registration spec when the caller has it (ipc.ts's window-open
  // handler) — see window-open-registry.ts for why this lives outside the machine record.
  if (spec.source !== undefined && spec.params !== undefined) {
    setWindowOpenPayload(id, spec.source, spec.params);
  }
  if (decision.attachEscHandler) {
    getWindowBackend().attachEscHandler(id);
  }
  kernelRegisterWindow({
    id,
    kind: spec.kind,
    layer: spec.layer,
    canBecomeKey: spec.canBecomeKey,
    acceptsInput: spec.acceptsInput,
    class: spec.class,
    role: spec.role,
    ...(spec.parentId != null ? { parentId: spec.parentId } : {}),
    ...(spec.keepLive !== undefined ? { keepLive: spec.keepLive } : {}),
    ...(spec.escapeMode !== undefined ? { escapeMode: spec.escapeMode } : {}),
    ...(initialBounds !== null ? { bounds: initialBounds } : {}),
    ...(spec.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: spec.tracksBaseLayerTop } : {}),
    ...(spec.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: spec.selfClosesOnBlur } : {}),
    ...(spec.nonActivating !== undefined ? { nonActivating: spec.nonActivating } : {}),
    ...(spec.appLifetime !== undefined ? { appLifetime: spec.appLifetime } : {}),
  });
  // pumpShownEvent: the native window was already visible at registration time, which never
  // fires a native 'show' transition — this is the only report the kernel ever gets of it.
  if (decision.pumpShownEvent) {
    kernelWindowShown(id, true);
  }
  return id;
}

// The WM WindowId for a native window handle, or for a numeric Electron window id a legacy
// Electron-keyed registry still holds. This is the ONE sanctioned WM<->platform id conversion
// surface (with getNativeWindowFor below); no other module may keep its own id mapping.
export function getWindowIdFor(win: BaseWindow | BrowserWindow | number): WindowId | null {
  return getWindowBackend().getWindowIdFor(win as unknown as RegisterWindowSpec['win'] | number);
}

export function getNativeWindowFor(id: WindowId): BaseWindow | BrowserWindow | null {
  return getWindowBackend().getNativeWindowFor(id) as unknown as BaseWindow | BrowserWindow | null;
}

// THE live Escape decider entry point: every dispatch site (windows.ts addEscHandler, ipc.ts
// wireHybridContentEvents, electron-window-backend.ts's OS-level grab, hybrid-overlay.ts's
// runHybridEscape test bridge) binds deps onto the production kernel/backend/pubsub through
// window-escape-runtime.ts handleEscapePress and calls this one function.
export function dispatchEscapePress(landedId: WindowId | 'global', site: string): void {
  wmLog('esc-dispatch', { site, landedId });
  const deps: EscapeRuntimeDeps = {
    getState: () => getKernelExecutor().getState(),
    execute: (command) => {
      getKernelExecutor().execute(command);
    },
    publish: (topic, payload) => publish(getSystemAddress(), topic, payload),
    ask: (id) => getWindowBackend().askRendererHandledEscape(id),
    track: (pending) => getKernelExecutorForApp().trackExternalAsyncEffect(pending),
  };
  handleEscapePress({ landedId }, deps);
}

// THE target window id for command / close / Esc / session-save focused descriptor reads.
// `keyWindow` is NOT a substitute: key is nulled the moment the app loses OS focus, and a
// satellite such as the shared chrome overlay can hold it, silently naming the wrong window.
export function getTopmostContentWindowId(): WindowId | null {
  return topmost(getKernelExecutor().getState(), isContentWindow)?.id ?? null;
}

// THE target window for a developer surface that only means something over an http/https page
// (devtools). Composed over isContentWindow rather than re-derived, so its gates stay in one
// place. Null when nothing on screen is a page; callers fall back to getTopmostContentWindowId.
export function getTopmostWebPageWindowId(): WindowId | null {
  return (
    topmost(
      getKernelExecutor().getState(),
      (r) => isContentWindow(r) && isWebPageRole(r.role),
    )?.id ?? null
  );
}

// Reads the overlay's attachment relation off the record carrying `tracksBaseLayerTop`, rather
// than a stored overlay id, because the overlay singleton can be re-minted and a captured id
// would go stale. Issues no command and decides nothing about windows; it only paints. Fires
// with the new host id (or null) only when the relation actually changes.
export function subscribeOverlayAttachment(cb: (hostId: WindowId | null) => void): () => void {
  const read = (): WindowId | null => {
    const state = getKernelExecutor().getState();
    return state.order.find((r) => r.tracksBaseLayerTop)?.overlayFor ?? null;
  };
  let last = read();
  return getKernelExecutor().subscribe(() => {
    const now = read();
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

// THE copy of app-active; no module may keep its own did-resign-active mirror.
export function getAppActive(): boolean {
  return getKernelExecutor().getState().appActive;
}

// True while one of the app's windows holds key although the app is inactive:
// the user is typing into a panel over another app. A window opened from
// there can take key without taking anything from the other app, which a
// window opened with nobody typing here (a command-line open) cannot.
export function isKeyHeldWhileAppInactive(): boolean {
  const state = getKernelExecutor().getState();
  return !state.appActive && state.key !== null;
}

// Edge-deduped: fires only when the boolean actually flips, not on every dispatch. Binds to
// whichever executor getKernelExecutor() answers with at call time, so a caller registered
// before initWindowStateMachine() runs would bind to the fallback — setKernelExecutorProvider
// throws in that case, so the wrong order fails loudly at startup rather than going stale.
export function subscribeAppActive(cb: (appActive: boolean) => void): () => void {
  let last = getAppActive();
  return getKernelExecutor().subscribe((state) => {
    const now = state.appActive;
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

// Null when `id` names no live kernel record. Mid-transition names are 'entering'/'leaving'.
// Callers that need to await a settle call WindowKernelExecutor.waitForSettledFsMode directly.
export function getWindowModeName(id: WindowId): 'normal' | 'entering' | 'fullscreen' | 'leaving' | null {
  return getKernelExecutor().getState().order.find((w) => w.id === id)?.fsMode.name ?? null;
}

// READ-ONLY by contract (no copy).
export function getMachineWindowRecord(id: WindowId): KernelWindowRecord | undefined {
  return windowById(getKernelExecutor().getState(), id) ?? undefined;
}

// undefined for a window still live in `order`, or one this executor never closed — a closed
// window's own CloseWindow effect carries these two facts forward for a close-time consumer that
// would otherwise ask getMachineWindowRecord for a record already removed in the same transition.
export function getRetiredWindowPresentation(id: WindowId): { maximized: boolean; preMaxBounds: Rectangle | null } | undefined {
  return getKernelExecutor().getRetiredPresentation(id);
}

// State.order itself (bottom -> top), not copied — read-only by contract.
export function listMachineWindowRecords(): readonly KernelWindowRecord[] {
  return getKernelExecutor().getState().order;
}

export function getNativeWindowByClass(cls: WindowClass): BaseWindow | BrowserWindow | null {
  for (const rec of getKernelExecutor().getState().order) {
    if (rec.class !== cls) continue;
    const native = getNativeWindowFor(rec.id);
    if (native) return native;
  }
  return null;
}

// Test-bridge support (E2E only): resolves once in-flight async effects (the escape-pressed
// renderer ask and any delegated closeOrHideWindow) have settled. Nothing in the app may gate
// behavior on it.
export async function waitForPendingWindowEffects(): Promise<void> {
  await getKernelExecutorForApp().waitForPendingAsyncEffects();
}

// Unlike waitForPendingWindowEffects above, this IS production sequencing: the before-quit
// handler awaits it so Electron's quit cannot close host windows over guests still alive.
export function waitForGuestTeardown(): Promise<void> {
  return getKernelExecutorForApp().waitForGuestTeardown();
}

export function _resetWindowStateSingletonForTests(): void {
  backend = null;
  sessionSeeded = false;
}
