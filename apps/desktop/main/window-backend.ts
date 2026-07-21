/**
 * window-backend.ts — the `WindowBackend` port (design §3, rule R3).
 *
 * Blueprint: `docs/design/window-manager.md`. The executor
 * (`window-os-adapter.ts`) performs every OS window operation THROUGH this
 * interface; `electron-window-backend.ts` is the Electron implementation and
 * the only window-manager module that imports Electron. This file has ZERO
 * platform imports — types or values — and must stay that way: it is the seam
 * that makes Tauri / ElectroBun / a native Swift shell a reimplementation
 * rather than a rewrite (§3).
 *
 * Shape (§3): COMMAND + EVENT, never QUERY.
 *   - Outbound: the executor issues the commands below. No method returns OS
 *     state — the two Promise-returning commands resolve with `void`; the
 *     promise is settlement plumbing for the E2E test bridge
 *     (`WindowOsAdapter.trackAsyncEffect`), not an answer.
 *   - Inbound: the backend pushes native reality into the machine's OWN event
 *     vocabulary (`window-state.ts WindowEvent`) through the single
 *     `BackendEventSink` injected at construction. The executor stays the one
 *     dispatch owner; the backend never touches the reducer directly. Events a
 *     backend emits today: `OS_FOCUS_GAINED`, `OS_FOCUS_SETTLED_NULL`,
 *     `WINDOW_SHOWN`, `WINDOW_HIDDEN`, `WINDOW_CLOSED`,
 *     `OS_FULLSCREEN_ENTERED`, `OS_FULLSCREEN_LEFT`,
 *     `FULLSCREEN_SETTLE_TIMEOUT`, `APP_ACTIVATED`, `APP_RESIGNED`,
 *     `ESC_PRESSED { landedId: 'global' }` (the OS Escape grab) and
 *     `ESC_RENDERER_ANSWER` (the renderer ask's round trip).
 *
 * SCOPE (§5 step 2 + the no-speculative-code rule): the surface below is
 * exactly what the executor issues today — nothing from the §3 full table is
 * pre-built. Later migration steps widen the port (`create`/`destroy` at step
 * 4, `setStacking` at step 5, visibility at step 6, `setBounds` at step 7,
 * `setAlwaysOnTop`/`setVisibleOnAllWorkspaces`/`loadContent` with their
 * steps). Until then, windows are joined post-hoc via the backend's migration
 * shims (see `electron-window-backend.ts BackendMigrationShims`), which sit
 * deliberately OUTSIDE this interface.
 */

import type { WindowEvent, WindowId, WindowKind, EscapeMode } from './window-state.js';

/** The port's plain rect currency — the reducer's own `Rectangle` (§3: no platform `Rectangle` ever crosses). Unused by the commands below until the geometry step (§5 step 7). */
export type { Rectangle as Rect } from './window-state.js';

/**
 * The single injected event channel: the backend translates native events into
 * the machine's event vocabulary and feeds them here. The executor wires this
 * to its dispatch pump at construction — one emitter, one dispatch owner.
 */
export type BackendEventSink = (event: WindowEvent) => void;

/**
 * The platform-neutral half of a window registration: what the WM needs to
 * know about a window, with no handle and no platform type. The Electron
 * backend's `RegisterWindowSpec` (a migration shim's input) extends this with
 * the native handles; the eventual `create(spec)` (§5 step 4) takes a spec
 * built on this shape.
 */
export interface WindowSpec {
  kind: WindowKind;
  role: string;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  /**
   * Whether the WM owns this window's per-window Escape interceptor
   * (`attachEscHandler` below). Defaults to true for `browser` windows —
   * registration is the single owner of the attach, so it can never be
   * attached twice for one window.
   *
   * Ignored for `page-host` windows: their Escape already rides on the content
   * surface's input path (`wireHybridContentEvents` in ipc.ts).
   *
   * The ONE browser window that opts OUT is the shared chrome overlay
   * (`hybrid-overlay.ts`): it has never had a main-process Esc interceptor and
   * handles Escape in its own renderer (closing the address bar), which a
   * `preventDefault`ing main-side handler would swallow.
   */
  attachEscHandler?: boolean;
}

/**
 * The backend port. One instance per app, constructed with a
 * `BackendEventSink` and driven only by the executor
 * (`window-os-adapter.ts` — rule R2's one effect funnel).
 *
 * Commands are fire-and-forget against a window that is gone: a backend
 * resolves the id internally and silently no-ops on an unknown/destroyed
 * window — the machine already recorded intent, and the `closed` event is
 * what retires the record.
 */
export interface WindowBackend {
  /**
   * Subscribe to app-level activation (macOS `did-become-active` /
   * `did-resign-active`) and emit `APP_ACTIVATED` / `APP_RESIGNED`. Called
   * once at boot wiring (`window-state-singleton.ts initWindowStateMachine`).
   */
  attachAppListeners(): void;

  /**
   * Show + raise + activate a window, kind-appropriately (the `RAISE_WINDOW`
   * effect): page-host via the shared hybrid show seam (activate + content
   * first responder), browser via headless-safe show + focus. Headless runs
   * stay focus-free — the backend applies the same `isHeadless()` policy the
   * show seams do.
   */
  raiseWindow(id: WindowId): void;

  /**
   * Make a page-host's content surface the OS first responder (the
   * `FOCUS_CONTENT` effect — the `shouldFocusHybridContentOnHostFocus`
   * invariant, standard on any front-change to a page-host).
   */
  focusContent(id: WindowId): void;

  /**
   * Drive native fullscreen to `on` (the `SET_FULLSCREEN` effect). The backend
   * also arms its bounded settle timer (§2.3): a transition that never emits
   * its native settled event self-corrects via a `FULLSCREEN_SETTLE_TIMEOUT`
   * emission, whose reducer clause emits `RECONCILE_FULLSCREEN`.
   *
   * NOTE the name is the effect's camelCase (`SET_FULLSCREEN`), deliberately
   * NOT the platform method name: the port is a different namespace, and the
   * R2 mechanical check (`scripts/check-r2-window-ops.mjs`) greps for the
   * platform call names verbatim.
   */
  setFullscreen(id: WindowId, on: boolean): void;

  /**
   * Command-in / event-out reconcile (the `RECONCILE_FULLSCREEN` effect —
   * §2.5): the backend reads the window's real fullscreen state ONCE,
   * internally, and emits `OS_FULLSCREEN_ENTERED` or `OS_FULLSCREEN_LEFT`.
   * The executor never queries; this is the one sanctioned read, and it lives
   * behind the port.
   */
  reconcileFullscreen(id: WindowId): void;

  /**
   * Close-or-hide through the app's existing close/hide policy seam (honors
   * keepLive, hybrid vs browser). Fire-and-forget for the machine; the
   * returned promise is settlement tracking for the E2E test bridge only.
   */
  closeOrHide(id: WindowId): Promise<void>;

  /**
   * Ask the window's renderer to handle an Escape press (the `ASK_RENDERER`
   * effect — the `escape-pressed` IPC, unchanged protocol). The answer comes
   * back as an `ESC_RENDERER_ANSWER` emission carrying `seq` (the ask's epoch,
   * so the reducer can drop an answer whose question no longer stands); a
   * missing/destroyed renderer answers `handled: false` immediately so ESC
   * still resolves. The returned promise settles after the answer is emitted
   * — test-bridge tracking only.
   */
  askRendererToHandleEscape(id: WindowId, seq: number): Promise<void>;

  /**
   * Attach the WM-owned per-window Escape interceptor (browser windows only —
   * see `WindowSpec.attachEscHandler`). Issued by the executor exactly when
   * `decideWindowRegistration` says so, keeping one attach per window.
   */
  attachEscHandler(id: WindowId): void;

  /**
   * Assert the OS-level Escape grab on or off (the derived
   * `deriveEscGrabRegistered` predicate — §2.4). Idempotent: the backend
   * tracks its own real registration state (including a failed register, so a
   * later call retries) and no-ops when already matching. A grabbed press is
   * emitted as `ESC_PRESSED { landedId: 'global' }`.
   */
  setEscGrab(on: boolean): void;
}
