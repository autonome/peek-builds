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
 *     `FULLSCREEN_SETTLE_TIMEOUT`, `BOUNDS_CHANGED` (the §3 table's
 *     `boundsChanged`, from the native resize/move listeners — §5 step 7),
 *     `APP_ACTIVATED`, `APP_RESIGNED`, `SPACE_CHANGED` (the §3 table's
 *     `spaceChanged`, from the macOS active-Space workspace notification —
 *     §5 step 10),
 *     `ESC_PRESSED { landedId: 'global' }` (the OS Escape grab) and
 *     `ESC_RENDERER_ANSWER` (the renderer ask's round trip).
 *
 * SCOPE (§5 step 2 + the no-speculative-code rule): the surface below is
 * exactly what the executor issues today — nothing from the §3 full table is
 * pre-built. Step 4 (special window classes + registry unification) widened
 * it with the close/destroy/show/hide/alwaysOnTop command family; step 5
 * added `setStacking`, step 7 the geometry pair (`setWindowBounds` +
 * `BOUNDS_CHANGED`), step 10 the macOS Spaces command
 * (`setVisibleOnAllSpaces`); later steps add theirs (`loadContent` with its
 * step). Windows are
 * still joined post-hoc via the backend's migration shims (see
 * `electron-window-backend.ts BackendMigrationShims`), which sit
 * deliberately OUTSIDE this interface.
 */

import type {
  WindowEvent,
  WindowId,
  WindowKind,
  WindowClass,
  EscapeMode,
  Rectangle as Rect,
  StackingLevel,
} from './window-state.js';

/** The port's plain rect currency — the reducer's own `Rectangle` (§3: no platform `Rectangle` ever crosses). Carried by `setWindowBounds` and the `BOUNDS_CHANGED` emission since the geometry step (§5 step 7A). */
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
  /**
   * The window's class (§4.3 dim 8b) — REQUIRED on the spec so every
   * registration site declares its classification (ordinary windows via
   * `classifyWindowRegistration`, the infrastructure classes explicitly).
   */
  class: WindowClass;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  /** Parent linkage (open params `parentWindowId` → WindowId at the seam). Drives the parent-refocus transition on WINDOW_CLOSED. */
  parentId?: WindowId | null;
  /** The old `main.ts windowRegistry` payload (§4.1 dim 1a) — opening source + open params, stored on the reducer record by reference. */
  source?: string;
  params?: Record<string, unknown>;
  /** Declared always-on-top intent — registration emits SET_ALWAYS_ON_TOP (replaces the post-ctor reinforcement call). */
  alwaysOnTop?: boolean;
  /**
   * keepLive policy declared at open time (`WindowRecord.keepLive`): the
   * reducer's `WINDOW_CLOSE_OR_HIDE_REQUESTED` clause branches on it (hide vs
   * the resolved close), so every registration site that knows the flag must
   * pass it here — tile entries (`TileEntry.keepLive`), the window-open IPC
   * options, hybrid host params.
   */
  keepLive?: boolean;
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
  /**
   * The kernel's three orthogonal per-window fields (`izui-roles.ts
   * WindowSurfaceProperties`, `deriveWindowSurface`). Required so every
   * registration site declares them explicitly — no call site may fall back
   * on a guessed default — but NOTHING in this reducer reads them yet: they
   * ride the spec purely so a later cutover to `window-kernel.ts` (whose
   * `Event.WindowRegistered` requires all three) needs no call-site changes.
   */
  layer: number;
  /** See `layer` above. */
  canBecomeKey: boolean;
  /** See `layer` above. */
  acceptsInput: boolean;
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
   * `did-resign-active`) and emit `APP_ACTIVATED` / `APP_RESIGNED`, plus the
   * platform's active-Space change → `SPACE_CHANGED` (§5 step 10; no-op where
   * Spaces don't exist). Called once at boot wiring
   * (`window-state-singleton.ts initWindowStateMachine`).
   */
  attachAppListeners(): void;

  /**
   * Show + raise + activate a window, kind-appropriately (the `RAISE_WINDOW`
   * effect): page-host → activating show + content first responder; browser
   * → show + focus. Headless runs stay focus-free (opacity-0 + inactive
   * show, no focus) while the `WINDOW_SHOWN` echo still records the raise's
   * focus intent for the machine.
   *
   * `opSeq` is the effect's op token (`window-state.ts Effect.opSeq`): the
   * backend arms "expecting a self-caused focus, op N" on the target before the
   * native call, so the focus it provokes comes back as `OS_FOCUS_GAINED
   * { cause: { kind: 'machine', opSeq: N } }` instead of masquerading as a user
   * gesture. See `FocusCause`.
   */
  raiseWindow(id: WindowId, opSeq: number): void;

  /**
   * Make a page-host's content surface the OS first responder (the
   * `FOCUS_CONTENT` effect — the `shouldFocusHybridContentOnHostFocus`
   * invariant, standard on any front-change to a page-host). `opSeq` is the
   * effect's op token — same provenance contract as `raiseWindow`.
   */
  focusContent(id: WindowId, opSeq: number): void;

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
   *
   * `closedDueToAppBlur` stamps the legacy `__closedDueToAppBlur` marker the
   * `main.ts` `'closed'` handler reads to skip its overlay-restoration branch
   * (the app-blur teardown already restored via
   * `izui-state.ts exitOverlayForAppBlur()`). It is an OPTION on the close
   * rather than its own command so the stamp can never be observed apart from
   * the close it describes — and so it disappears with the side channel when
   * the overlay session moves into the machine.
   */
  closeOrHide(id: WindowId, opts?: { closedDueToAppBlur?: boolean }): Promise<void>;

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

  // ── §5 step 4 commands (special window classes + registry unification) ────

  /**
   * Guest-safe direct close (the `CLOSE_WINDOW_DIRECT` effect — the absorbed
   * `windows.ts closeHostWindow` path): destroy any registered page-host
   * guest WebContents FIRST (waiting for them to actually go away, the
   * d1cf0b9a use-after-free guard), then close the host. Guestless windows
   * close synchronously before the returned promise resolves. No keepLive
   * policy — that is `closeOrHide`. The promise is test-bridge settlement.
   */
  closeWindow(id: WindowId): Promise<void>;

  /** Forceful native destroy (the `DESTROY_WINDOW` effect) — synchronous, skips beforeunload/close events (extension bridge/UI + quit teardown). */
  destroyWindow(id: WindowId): void;

  /** Tear down the window's retained content surface (the `CLOSE_CONTENT` effect — the hybrid finalize's documented `webContents.close()` teardown). */
  closeContent(id: WindowId): void;

  /**
   * Show, kind-appropriately, with or without activation (the `SHOW_WINDOW`
   * effect). The BACKEND owns the whole show policy (§5 step 6A-2): the
   * headless opacity-0-before-show trick, show() vs showInactive(), the
   * page-host masks (headless / quick-view panel never activate the app),
   * and the `WINDOW_SHOWN` echo carrying the caller's unmasked `activate`
   * intent (no native `'show'` event fires for an inactive show, and
   * headless runs are focus-free).
   *
   * `opts.opSeq` is the effect's op token: an ACTIVATING show can move OS focus,
   * so the backend arms the same self-caused-focus expectation `raiseWindow`
   * does before it makes the native call (see `FocusCause`). A non-activating
   * show takes no focus and arms nothing.
   */
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void;

  /** Hide, keep alive (the `HIDE_WINDOW` effect — the HUD app-blur sweep). */
  hideWindow(id: WindowId): void;

  /**
   * Pin above regular windows (the `SET_ALWAYS_ON_TOP` effect). The EXECUTOR
   * gates this on headless. Named `pinAlwaysOnTop` — deliberately NOT the
   * platform method name, same convention as `setFullscreen`: the R2
   * mechanical check greps the platform call names verbatim, and the port is
   * a different namespace.
   */
  pinAlwaysOnTop(id: WindowId, on: boolean): void;

  /**
   * Destroy every registered page-host guest WC (the `DESTROY_ALL_GUESTS`
   * effect — quit teardown, peek d1cf0b9a). Resolves once the guests have
   * actually reported destruction, or once the teardown budget expires:
   * `webContents.destroy()` returning is NOT the teardown, so a caller that
   * needs the guests gone before host windows close must await this. Bounded
   * per guest and over the batch, so it can never turn a quit into a hang.
   */
  destroyAllContentGuests(): Promise<void>;

  // ── §5 step 5 command (z-order / stacking) ────────────────────────────────

  /**
   * Place the window at the top of its (regular) window level — RELATIVE ORDER
   * ONLY (the `SET_STACKING` effect): no activation, no key-window change, no
   * first-responder change (those are `raiseWindow` / `focusContent`). The
   * Electron backend implements it as the native relative raise (`moveTop`).
   * Two native caveats the MACHINE models, not the backend: macOS silently
   * no-ops the raise for a non-frontmost app, and a page-host's NSWindow
   * no-ops it until first composited frame — the reducer's appActive gate and
   * the `WINDOW_CONTENT_ORDERABLE` re-drive cover them; the backend just
   * issues the raise.
   *
   * `level` rides the call (rather than the backend consulting record state)
   * so a `pinned` window (the chrome overlay) realizes as the floating-level
   * re-assert (`setAlwaysOnTop(true, 'floating')`) instead of a plain
   * `moveTop()` — see the electron backend implementation.
   */
  setStacking(id: WindowId, level: StackingLevel): void;

  // ── §5 step 7 command (geometry / bounds / maximize) ─────────────────────

  /**
   * Position and size the window (the `SET_BOUNDS` effect — the §3 table's
   * `setBounds(id, rect)`). The backend's native `resize`/`move` listeners
   * echo the settled reality back as `BOUNDS_CHANGED`, which is the SOLE
   * writer of the record's `bounds` mirror — command in, event out, never a
   * `getBounds()` question.
   *
   * NOTE the name is deliberately NOT the platform method name `setBounds`:
   * the R2 mechanical check (`scripts/check-r2-window-ops.mjs`) greps the
   * platform call names verbatim, and the port is a different namespace —
   * same convention as `setFullscreen` / `pinAlwaysOnTop`, spelled with the
   * `showWindow`/`hideWindow` family's `Window` infix.
   */
  setWindowBounds(id: WindowId, rect: Rect): void;

  // ── §5 step 10 command (macOS Spaces) ────────────────────────────────────

  /**
   * Pin the window to (or unpin it from) every macOS Space — the
   * `SET_VISIBLE_ON_ALL_SPACES` effect (§4.2 dim 7b). Named
   * `setVisibleOnAllSpaces`, deliberately NOT the platform method name
   * `setVisibleOnAllWorkspaces`: same convention as `setFullscreen` /
   * `pinAlwaysOnTop` / `setWindowBounds` — the R2 mechanical check
   * (`scripts/check-r2-window-ops.mjs`) greps the platform call names
   * verbatim, and the port is a different namespace.
   *
   * `opts` is WIDER than the design table's `(id, on)` because two properties
   * of the real call sites cannot be expressed without it:
   *
   *   - `skipTransformProcessType: true` is required on EVERY call. Without
   *     it macOS toggles the app's activation policy (Accessory ↔ Foreground)
   *     mid-call and every OTHER Peek window flashes out for a frame.
   *   - `visibleOnFullScreen: true` belongs on the `on: true` calls only.
   *
   * And the ORDERED PAIR that the `anchor` policy issues — `true` then
   * `false`, synchronously, right after creation, with DIFFERENT options — is
   * what makes macOS land a window on the user's ACTIVE Space and pin it
   * there. The pair is expressed as two effects by the reducer's
   * `SPACES_POLICY_REQUESTED` clause, so the port only ever performs one call
   * per invocation, but the two calls must be able to differ in their options.
   *
   * Non-darwin platforms have no Spaces: the Electron backend no-ops there.
   */
  setVisibleOnAllSpaces(
    id: WindowId,
    on: boolean,
    opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
}
