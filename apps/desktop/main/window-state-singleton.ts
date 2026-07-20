/**
 * window-state-singleton.ts — the ONE live `WindowOsAdapter` for the desktop
 * app, plus the thin read/dispatch surface the seam consumers use.
 *
 * Blueprint: `docs/design/fullscreen-escape-window-fsm.md`. `window-state.ts` is
 * the pure reducer, `window-os-adapter.ts` is the OS-boundary adapter; THIS
 * module holds the single adapter instance and exposes the machine to the rest
 * of main (ipc.ts / tile-ipc.ts / windows.ts / main.ts / hybrid-overlay.ts /
 * tile-launcher.ts). It replaces the deleted scattered authorities:
 *   - `getFrontWindowId()`      ← ipc.ts `getLastFocusedVisibleWindowId`
 *   - `getFrontPageHostId()`    ← registry `getActiveHybridWindowId`
 *   - `subscribeFrontChange()`  ← registry `onActiveHybridWindowChange`
 *   - `getDevtoolsTargetId()`   ← ipc.ts `getLastContentWindowId`
 *   - `getWindowPreBounds()`    ← registry `preFullScreenBounds`
 *   - `dispatchWindowEvent()`   ← the FULLSCREEN/ESC/SWITCHER/hide reroutes
 *
 * The adapter is constructed lazily on first access and made live (native app
 * listeners attached + session mirror seeded) once from `main.ts` at boot via
 * `initWindowStateMachine()`.
 */

import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { WindowOsAdapter, type RegisterWindowSpec } from './window-os-adapter.js';
import { getIzuiCoordinator } from './izui-state.js';
import type { WindowEvent, FsMode, Rectangle, IzuiSession, WindowKind, EscapeMode } from './window-state.js';

/** Register-spec that accepts real Electron window handles (both kinds satisfy the adapter's structural `NativeWindow`). */
export interface MachineWindowSpec {
  id: number;
  kind: WindowKind;
  role: string;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  /** BaseWindow (page-host) or BrowserWindow (browser). */
  win: BaseWindow | BrowserWindow;
  /** Content view WC for a page-host, root WC for a browser. */
  contentWC?: WebContents | null;
  /**
   * Opt OUT of the adapter-owned `before-input-event` Esc interceptor (browser
   * windows only, default on). See `RegisterWindowSpec.attachEscHandler` — the
   * shared chrome overlay is the one caller that passes false.
   */
  attachEscHandler?: boolean;
}

let adapter: WindowOsAdapter | null = null;
let sessionSeeded = false;

/** The single OS-boundary adapter. Constructed on first use. */
export function getWindowOsAdapter(): WindowOsAdapter {
  if (!adapter) adapter = new WindowOsAdapter();
  return adapter;
}

/**
 * Boot wiring (call ONCE from main.ts after the coordinator exists): attach the
 * adapter's app-level `did-become/resign-active` listeners and seed the session
 * mirror. Idempotent.
 */
export function initWindowStateMachine(): void {
  getWindowOsAdapter().attachAppListeners();
  seedSessionMirror();
}

function seedSessionMirror(): void {
  if (sessionSeeded) return;
  sessionSeeded = true;
  const coord = getIzuiCoordinator();
  coord.onSessionChange((state) => dispatchWindowEvent({ type: 'SESSION_CHANGED', session: clampSession(state) }));
  // Seed the machine with the coordinator's current session immediately.
  dispatchWindowEvent({ type: 'SESSION_CHANGED', session: clampSession(coord.getState()) });
}

/**
 * Clamp the coordinator's four-state (idle/transient/active/overlay) to the
 * reducer's tri-state. `overlay` is a transient-over-active state, and
 * `decideEscape` step 1 intercepts the overlay-open ESC before step 6 ever
 * reads the session — so mirroring it as `active` is behavior-neutral.
 */
function clampSession(state: string): IzuiSession {
  return state === 'overlay' ? 'active' : (state as IzuiSession);
}

/** Register a window (both kinds) with the machine + attach its native listeners. */
export function registerWindowWithMachine(spec: MachineWindowSpec): void {
  // Both BaseWindow and BrowserWindow satisfy the adapter's structural
  // `NativeWindow`; the electron typed-overload `on` isn't assignable to the
  // loose `on` shape, so bridge with a single cast here (not at every call site).
  getWindowOsAdapter().registerWindow(spec as unknown as RegisterWindowSpec);
}

/** Feed an event into the machine (runs effects + Esc-grab reconcile + log). */
export function dispatchWindowEvent(event: WindowEvent): void {
  getWindowOsAdapter().dispatch(event);
}

/** THE target window id (command / close / Esc / session-save focused descriptor). */
export function getFrontWindowId(): number | null {
  return getWindowOsAdapter().getOwner().getFrontWindowId();
}

/**
 * The front window iff its record is a page-host, else null (replaces
 * `getActiveHybridWindowId`): "the frontmost hybrid page host the shared chrome
 * overlay frames itself over".
 */
export function getFrontPageHostId(): number | null {
  const owner = getWindowOsAdapter().getOwner();
  const front = owner.getFrontWindowId();
  if (front == null) return null;
  const rec = owner.snapshot().windows.find((w) => w.id === front);
  return rec && rec.kind === 'page-host' ? front : null;
}

/**
 * Subscribe to changes in the front page-host (replaces
 * `onActiveHybridWindowChange`). Fires with the new front page-host id (or null)
 * only when it actually changes. Returns an unsubscribe function.
 */
export function subscribeFrontChange(cb: (frontPageHostId: number | null) => void): () => void {
  let last = getFrontPageHostId();
  return getWindowOsAdapter().getOwner().subscribe(() => {
    const now = getFrontPageHostId();
    if (now !== last) {
      last = now;
      cb(now);
    }
  });
}

/** Resolve when window `id` reaches fullscreen `mode` (the settle-await seam). */
export function waitForMode(id: number, mode: FsMode['name']): Promise<void> {
  return getWindowOsAdapter().getOwner().waitForMode(id, mode);
}

/** The current fullscreen mode name for `id`, or null if unregistered. */
export function getWindowModeName(id: number): FsMode['name'] | null {
  return getWindowOsAdapter().getOwner().getWindowMode(id);
}

/** The pre-fullscreen bounds stash for `id` (replaces `preFullScreenBounds`). */
export function getWindowPreBounds(id: number): Rectangle | null {
  return getWindowOsAdapter().getOwner().getWindowPreBounds(id);
}

/** The devtools fallback target: MRU http(s) window (replaces `getLastContentWindowId`). */
export function getDevtoolsTargetId(): number | null {
  return getWindowOsAdapter().getOwner().getDevtoolsTargetId();
}

/** A window's MRU focus rank (replaces `focus-order.ts` `getFocusOrder`). 0 if unknown. */
export function getFocusOrder(id: number): number {
  return getWindowOsAdapter().getOwner().getWindowFocusSeq(id);
}

/** Test-only: reset the singleton (drops the adapter + its owner state). */
export function _resetWindowStateSingletonForTests(): void {
  adapter = null;
  sessionSeeded = false;
}
