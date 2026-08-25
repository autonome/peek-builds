/**
 * window-backend.ts — the `WindowBackend` port (design §3, rule R3).
 *
 * Blueprint: `docs/design/window-manager.md`. The executor
 * (`window-kernel-executor.ts`) performs every OS window operation THROUGH
 * this interface; `electron-window-backend.ts` is the Electron implementation
 * and the only window-manager module that imports Electron. This file has ZERO
 * platform imports — types or values — and must stay that way: it is the seam
 * that makes Tauri / ElectroBun / a native Swift shell a reimplementation
 * rather than a rewrite (§3).
 *
 * Shape (§3): COMMAND + EVENT, never QUERY — with one deliberate exception.
 *   - Outbound: the executor issues the commands below. No method returns OS
 *     state, except `askRendererHandledEscape`: its `boolean` IS the answer
 *     to the question it asks — the renderer's own `handled` verdict, which
 *     no event stream could hand back any sooner — so a caller can decide in
 *     the same pass rather than waiting for a later event to arrive. Every
 *     other Promise-returning command resolves with `void`; the promise
 *     there is settlement plumbing for the E2E test bridge
 *     (`WindowOsAdapter.trackAsyncEffect`), not an answer.
 *   - Inbound: the backend pushes native reality straight to the kernel
 *     (`window-kernel-dispatch.ts kernel*`, called directly at each
 *     native-event site in `electron-window-backend.ts`), never back through
 *     this port. Escape is decided by `window-escape.ts interpretEscape`,
 *     reached via `window-machine.ts dispatchEscapePress`.
 *     `askRendererHandledEscape` below still returns the renderer's ask
 *     answer directly.
 *
 * SCOPE (§5 step 2 + the no-speculative-code rule): the surface below is
 * exactly what the executor issues today — nothing from the §3 full table is
 * pre-built. Step 4 (special window classes + registry unification) widened
 * it with the close/destroy/show/hide/alwaysOnTop command family; step 5
 * added `setStacking`, step 7 the geometry pair (`setWindowBounds` +
 * `BOUNDS_CHANGED`), step 10 the macOS desktop-membership command
 * (`setDesktopMembership` — the rewritten kernel's platform-neutral
 * replacement for the raw `setVisibleOnAllSpaces` step 10 originally added,
 * which lived outside this port as `electron-window-backend.ts
 * LegacySpacesShim` until it was deleted alongside `window-state.ts`);
 * later steps add theirs (`loadContent` with its
 * step). Windows are
 * still joined post-hoc via the backend's migration shims (see
 * `electron-window-backend.ts BackendMigrationShims`), which sit
 * deliberately OUTSIDE this interface.
 */

import type { WindowId, WindowKind, DesktopMembership, Rectangle as Rect } from './window-kernel.js';
import type { WindowClass, StackingLevel } from './izui-roles.js';

/**
 * The declared Escape-handling override a registration spec may carry.
 * One live value: `'ignore'`, which marks the window pass-through so Escape
 * never reaches the switcher (`window-escape.ts interpretEscape` step 3).
 * Every other window's Escape behaviour is decided by that same function's
 * role × session table — there is nothing left for a caller to override.
 * This is the caller-facing vocabulary (`api.window.open({ escapeMode })`),
 * moved here (rather than re-pointed at the kernel's narrower field type)
 * because the two are not the same type.
 */
export type EscapeMode = 'ignore';

/** The port's plain rect currency — the reducer's own `Rectangle` (§3: no platform `Rectangle` ever crosses). Carried by `setWindowBounds` and the `BOUNDS_CHANGED` emission since the geometry step (§5 step 7A). */
export type { Rectangle as Rect } from './window-kernel.js';

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
 * The backend port. One instance per app, driven only by the executor
 * (`window-kernel-executor.ts` — rule R2's one effect funnel).
 *
 * Commands are fire-and-forget against a window that is gone: a backend
 * resolves the id internally and silently no-ops on an unknown/destroyed
 * window — the machine already recorded intent, and the `closed` event is
 * what retires the record.
 */
export interface WindowBackend {
  /**
   * Subscribe to app-level activation (macOS `did-become-active` /
   * `did-resign-active`) and feed the kernel `APP_ACTIVATED` / `APP_RESIGNED`,
   * plus the platform's active-Space change (§5 step 10; no-op where Spaces
   * don't exist — no machine consumes this fact today, so it is logged rather
   * than fed anywhere, see `electron-window-backend.ts
   * attachSpaceChangeListener`). Called once at boot wiring
   * (`window-machine.ts initWindowStateMachine`).
   */
  attachAppListeners(): void;

  /**
   * Show + raise + activate a window, kind-appropriately (the `RAISE_WINDOW`
   * effect): page-host → activating show + content first responder; browser
   * → show + focus. Headless runs stay focus-free (opacity-0 + inactive
   * show, no focus) while the `WINDOW_SHOWN` echo still records the raise's
   * focus intent for the machine.
   *
   * `opSeq` is the effect's op token (`window-kernel.ts Effect.opSeq`): the
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
   */
  closeOrHide(id: WindowId): Promise<void>;

  /**
   * Ask the window's renderer whether it handled an Escape press (the
   * `ASK_RENDERER` effect — the `escape-pressed` IPC, unchanged protocol).
   * Resolves to the renderer's own `handled` verdict; a missing/destroyed
   * renderer resolves `false` immediately so ESC still resolves. This port
   * only answers the question — the caller (`window-escape-runtime.ts
   * handleEscapePress`) re-reads state and re-runs `interpretEscape` with
   * the answer instead of feeding it back through a reducer event.
   */
  askRendererHandledEscape(id: WindowId): Promise<boolean>;

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

  /**
   * Hide, keep alive (the `HIDE_WINDOW` effect — the HUD app-blur sweep).
   *
   * `opSeq` is the effect's op token, same provenance contract as
   * `showWindow`'s — carried through to the confirming `WINDOW_HIDDEN` echo
   * so the kernel can tell this hide's own echo apart from a later show that
   * has already superseded it (`window-kernel.ts isStaleWindowEcho`).
   * Optional: a caller with no op token (none exists today) gets an echo
   * that is never treated as stale.
   */
  hideWindow(id: WindowId, opSeq?: number): void;

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
  //
  // The raw path behind `window-state.ts SET_VISIBLE_ON_ALL_SPACES_REQUESTED`
  // / `SPACES_POLICY_REQUESTED` — was called only by `window-os-adapter.ts`
  // driving that frozen reducer — used to live here as `setVisibleOnAllSpaces`.
  // It predates the governing platform-neutral rule
  // (`docs/design/window-manager.md` §0) and its signature carries Electron's
  // own option names (`visibleOnFullScreen`/`skipTransformProcessType`), which
  // this file — scanned by `scripts/check-platform-leak.mjs` — may not. It
  // lived as `electron-window-backend.ts LegacySpacesShim`, a companion
  // interface deliberately OUTSIDE this port, the same pattern
  // `BackendMigrationShims` uses for the handle-speaking surface — deleted
  // alongside `window-state.ts` and `window-os-adapter.ts`, the sole caller
  // that typed its backend as the wider intersection.

  /**
   * Realize the window's declared desktop membership (the `SetDesktopMembership`
   * effect, `window-kernel.ts DesktopMembership`) — the platform-neutral
   * replacement for `setVisibleOnAllSpaces` above. Named off the intention,
   * deliberately NOT the platform method name `setVisibleOnAllWorkspaces`:
   * same convention as `setFullscreen` / `pinAlwaysOnTop` / `setWindowBounds`
   * — the R2 mechanical check (`scripts/check-r2-window-ops.mjs`) greps the
   * platform call names verbatim, and the port is a different namespace.
   *
   * The signature carries ONLY the intention — no platform option names, no
   * OS call count. WHICH of `'follow'`/`'anchor'` a role wants is decided
   * above the port (the caller composing this command); HOW a given backend
   * satisfies either one — one native call, an ordered pair of them with
   * different options, or none at all on a platform with no such concept —
   * is entirely the backend's decision (`electron-window-backend.ts
   * setDesktopMembership`). A second backend that has no notion of "desktop"
   * implements this as a no-op and every argument here still means something
   * to it: there is no platform-specific shape left to misinterpret.
   */
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void;

  /**
   * Realize the machine's request that `overlayId` frame `hostId` (the
   * `AttachOverlayTo` effect, `window-kernel.ts Effect`) — a REQUEST, not an
   * assertion: the kernel does not enforce that attachment agrees with
   * stacking order (see that effect's doc), so a backend may decline it.
   * Named off the intention, deliberately NOT a platform method name — same
   * convention as `setFullscreen` / `pinAlwaysOnTop` / `setWindowBounds` /
   * `setDesktopMembership`: the R2 mechanical check
   * (`scripts/check-r2-window-ops.mjs`) greps the platform call names
   * verbatim, and the port is a different namespace.
   *
   * `hostId: null` means detach. A backend resolves `hostId` internally and
   * silently no-ops on an unknown/destroyed window — same fire-and-forget
   * contract every other command on this port carries. The realized relation
   * and its frame land back at the kernel one hop later, as an event (the
   * frame needs a work-area read this port's caller may not perform itself —
   * see the effect's doc), never as a return value: this port is COMMAND +
   * EVENT, never QUERY.
   *
   * A backend whose platform has no notion of an attachable overlay chrome
   * implements this as a no-op — every argument here still means something
   * to it, there is no platform-specific shape left to misinterpret.
   */
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void;
}
