/**
 * IZUI roles — pure module (no Electron deps).
 *
 * Owns:
 *   - The IZUI role taxonomy (palette / quick-view / overlay / workspace /
 *     content / child-content / utility).
 *   - The role-inference rule that maps api.window.open params to a role.
 *     This was previously inlined in `ipc.ts`; it now lives here so the
 *     same logic can be applied at multiple call sites (window creation,
 *     pre-creation Spaces policy lookup) and unit-tested without Electron.
 *   - The macOS Spaces policy that follows from a role: transient/overlay-
 *     class roles follow the user across Spaces; everything else anchors
 *     to the Space where it was first opened.
 *   - The window-surface derivation (`deriveWindowSurface`): the same open
 *     params, mapped to the kernel record's three orthogonal per-window
 *     fields (`layer` / `canBecomeKey` / `acceptsInput`).
 *
 * Importers must NOT add Electron deps here. This module is loaded by
 * unit tests that run under ELECTRON_RUN_AS_NODE=1 — Electron itself is
 * available, but we keep this file Electron-free so it stays trivially
 * testable and so the role taxonomy is decoupled from window plumbing.
 *
 * `BASE_LAYER` is imported from `window-kernel.ts`, which has no imports of
 * its own — so the dependency is one-way and adds no Electron surface.
 */

import { BASE_LAYER, type WindowKind } from './window-kernel.js';

/**
 * Transient window roles. These open and close frequently and ride above
 * the workspace — they should not affect dock visibility, and on macOS
 * they follow the user across Spaces instead of anchoring to their
 * creation Space.
 */
export const TRANSIENT_ROLES = new Set(['palette', 'quick-view', 'overlay', 'switcher']);

/**
 * Inputs used to infer a role when the caller did not pass one explicitly.
 * Extracted from the `options` and request context in the window-open IPC
 * handler.
 */
export interface IzuiRoleContext {
  isWebPage: boolean;
  parentWindowId: number | null;
}

/**
 * Subset of `api.window.open` options that participate in role inference.
 * Kept loose (`role?: string`) because explicit roles can be anything the
 * caller chose; downstream code is responsible for treating unknown
 * roles as a default.
 */
export interface IzuiRoleOptions {
  role?: string;
  overlay?: boolean;
  modal?: boolean;
  keepLive?: boolean;
  escapeMode?: string;
}

/**
 * Map `api.window.open` params to an IZUI role. Mirrors the historical
 * inline cascade in `ipc.ts`; see that file's call site for the rationale
 * behind the workspace-default tail.
 */
export function inferIzuiRole(
  options: IzuiRoleOptions,
  ctx: IzuiRoleContext,
): string {
  let role = options.role;
  if (!role) {
    if (options.overlay === true) {
      role = 'overlay';
    } else if (options.modal === true && options.keepLive === true) {
      role = 'palette';
    } else if (options.modal === true) {
      role = 'quick-view';
    } else if (options.escapeMode === 'navigate') {
      role = 'workspace';
    } else if (ctx.parentWindowId != null && ctx.isWebPage) {
      role = 'child-content';
    } else if (ctx.isWebPage) {
      role = 'content';
    } else {
      role = 'workspace';
    }
  }
  if (role === 'content' && ctx.parentWindowId != null) {
    role = 'child-content';
  }
  return role;
}

/**
 * Whether a window opened with these options SELF-CLOSES when it loses focus
 * (blur). This is what the `modal` option actually does in this codebase —
 * despite the name. `modal:true` does NOT create an OS-style parent-blocking
 * persistent dialog; it wires a `win.on('blur', …close)` handler (ipc.ts), i.e.
 * *transient* close-on-blur, the same family as peeks/slides.
 *
 * The misread bit a real flow: the Lex atproto OAuth window was opened
 * `modal:true` and was destroyed the instant the user switched to a password
 * manager / 2FA app mid-login (peek 5b4fefdc). A window that must survive an
 * app-switch — any OAuth dialog — must therefore NOT be `modal`; open it with a
 * persistent role like `utility` and close it explicitly when done.
 *
 * Pure so the ipc.ts gate is unit-testable without Electron. The call site adds
 * one more condition — it suppresses the handler under E2E_TEST — but that is a
 * test-environment concern, not a window-semantic, so it stays at the call site.
 */
export function windowSelfClosesOnBlur(options: { modal?: boolean }): boolean {
  return options.modal === true;
}

// ESC-target resolution, native-fullscreen-exit precedence, the global-Esc-grab
// predicate, and the first-responder-on-host-focus predicate
// (`ALWAYS_CLOSEABLE_ESC_ROLES`, `resolveHybridEscapeTarget`,
// `escExitsHybridFullscreen`, `shouldRegisterGlobalEscFallback`,
// `shouldFocusHybridContentOnHostFocus`) are DELETED — each is now a clause of
// the window-state reducer's `decideEscape` / front-arbitration / derived-grab
// (`window-state.ts`), with their regression tests ported to
// `window-state.test.ts`.

/**
 * Whether the post-loop focused-descriptor block of `restoreSessionSnapshot`
 * should RAISE + ACTIVATE the window that was focused at save time.
 *
 * Two converged user-reported bugs share this gate (peek 7bb74c90 z-order +
 * 8f7010a8 not-frontmost-at-startup). Both reduce to: the focused-descriptor
 * block was gated on `isAppFocused()` alone, and at COLD START the macOS
 * startup "activation dance" fires `did-resign-active` mid-restore
 * (main.ts → coordinator.setAppFocused(false)). So `isAppFocused()` reads
 * FALSE during the post-loop block, both branches are skipped, and the focused
 * window is never moveTop'd (z-order bug) nor activated (menubar/key-window
 * bug). The moveTop()/activate calls were already present — only the gate was
 * wrong.
 *
 * The decision:
 *   - IN-SESSION restore (`coldStart=false`, e.g. the user-triggered "Restore
 *     Previous Session" or `forceRestoreSession`): honor `appFocused`. If the
 *     user switched away mid-restore, do NOT yank them back — preserve the
 *     original isAppFocused gate intent.
 *   - COLD START (`coldStart=true`): Peek is being LAUNCHED and SHOULD own the
 *     foreground, so activate the focused descriptor EVEN IF the startup dance
 *     transiently flipped appFocused false — EXCEPT under headless, where Peek
 *     must NEVER steal the user's focus (agent/CI runs stay accessory; refs the
 *     headless-no-focus-theft regressions peek 2b55f3af / d9bb2924).
 *
 * Pure + deterministic so the cold-start vs in-session distinction is unit-
 * testable without real OS focus (mirrors `shouldRegisterGlobalEscFallback`).
 *
 * @param coldStart   this restore is the app's boot restore (not in-session)
 * @param appFocused  app-active at restore time — the window-state machine's
 *                    `AppWindowState.appActive` (`window-state-singleton.ts
 *                    getAppActive()`). Was `getIzuiCoordinator().isAppFocused()`
 *                    until that third copy was retired.
 * @param headless    the run is headless/CI (focus-free)
 */
export function shouldActivateFocusedOnRestore(
  coldStart: boolean,
  appFocused: boolean,
  headless: boolean,
): boolean {
  return appFocused || (coldStart && !headless);
}

// `selectTransientSiblingsToClose` + its `TransientSiblingCandidate` shape were
// retired by the §5 step 9 cutover. The decision lives in the window-kernel
// machine now — `window-kernel.ts selectTransientAutoclose` — reading the
// kernel's own state instead of a candidate list gathered from two
// registries. Semantics were ported verbatim (utility focuser closes
// nothing; skip self / hidden / non-transient; 'overlay' exempt) and the unit
// table moved with them into `window-kernel.test.ts`.

/**
 * macOS Spaces policy for a role.
 *
 *   - 'follow': window appears on every Space (setVisibleOnAllWorkspaces
 *     true, left there). Used for palette/quick-view/overlay classes that
 *     should ride along with the user.
 *   - 'anchor': window opens on the active Space and stays there. The
 *     window-open handler achieves this with a synchronous
 *     setVisibleOnAllWorkspaces(true) -> setVisibleOnAllWorkspaces(false)
 *     flip immediately after BrowserWindow creation.
 *   - 'none': no Spaces handling needed (non-darwin platforms).
 *
 * Platform is passed in so this is unit-testable cross-platform.
 */
export function spacesPolicyForRole(
  role: string,
  platform: NodeJS.Platform,
): 'follow' | 'anchor' | 'none' {
  if (platform !== 'darwin') return 'none';
  return TRANSIENT_ROLES.has(role) ? 'follow' : 'anchor';
}

/**
 * Which desktops a role WANTS a window to belong to (`window-kernel.ts
 * DesktopMembership`) — the platform-neutral half of `spacesPolicyForRole`
 * above, with the platform question dropped entirely rather than answered.
 *
 * `spacesPolicyForRole`'s `'none'` arm is "this platform has no such
 * concept" — that is an answer about the BACKEND, not about what the window
 * wants, and under the governing platform-neutral rule
 * (`docs/design/window-manager.md` §0) it is not a value the machine may
 * carry: a palette wants to follow the user across desktops whether or not
 * the current platform can express that. So this function never asks
 * `platform` and never returns a third value — every role resolves to
 * exactly one of `'follow'`/`'anchor'`, and it is up to the backend
 * (`electron-window-backend.ts setDesktopMembership`) whether realizing that
 * intention takes any native calls at all.
 *
 * `spacesPolicyForRole` itself is UNCHANGED and stays the derivation
 * `window-state.ts`'s frozen `SPACES_POLICY_REQUESTED` dispatch sites use —
 * this is an additional, separate function for the rewritten kernel's feed
 * sites, not a replacement.
 */
export function desktopMembershipForRole(role: string): 'follow' | 'anchor' {
  return TRANSIENT_ROLES.has(role) ? 'follow' : 'anchor';
}

// The close-target resolver (`resolveCloseTargetId`) and the focused-visible
// resolver (`resolveFocusedVisibleWindowId`, with its 7-input cascade) are
// DELETED — both collapse into `windows.ts resolveFocusedWindowIdForClose`, a
// composition over the kernel's `isFrontEligibleWindow` query
// (`window-kernel.ts`), which excludes the chrome overlay + modal issuers the
// same way the old `satellite` flag did. Their regression assertions are
// ported to `window-state.test.ts` and `window-kernel.test.ts`.

/**
 * Decide whether a hybrid page-host's content `WebContents` should be
 * `close()`-d during finalize (`runHybridFinalize` in `ipc.ts`).
 *
 * At app-quit teardown the content `WebContentsView`'s `.webContents`
 * getter can already return `undefined` — the wc is gone NATIVELY, not a
 * live-but-destroyed wc. The old inline gate read `.isDestroyed()` straight
 * off it, which threw a `TypeError` on that `undefined` mid-finalize; the
 * finalize catch only logged it, so the teardown tail bailed with native
 * state half-torn → SIGSEGV on quit (peek 9a591551). Gate on BOTH the wc's
 * existence AND its destroyed lifecycle signal, so an absent or already-
 * torn-down content wc is a clean no-op rather than a throw. Pure so the
 * quit-teardown decision is unit-testable without Electron.
 */
export function shouldCloseContentWCOnFinalize(
  contentWC: { isDestroyed(): boolean } | null | undefined,
): boolean {
  return !!contentWC && !contentWC.isDestroyed();
}

/**
 * Phase of the deferred `before-quit` cleanup state machine (`entry.ts`).
 *
 *   idle     — no quit seen yet
 *   deferred — quit vetoed, cleanup scheduled on the next macrotask
 *   done     — cleanup ran (or threw); the re-quit must be allowed through
 */
export type QuitCleanupPhase = 'idle' | 'deferred' | 'done';

export interface BeforeQuitDecision {
  /** Veto this quit — the native stack must unwind before we free anything. */
  preventDefault: boolean;
  /** Queue the cleanup body + re-quit on the next macrotask. */
  scheduleCleanup: boolean;
  nextPhase: QuitCleanupPhase;
}

/**
 * Decide what a `before-quit` event should do, given the cleanup phase so far.
 *
 * WHY THIS DEFERS (do not "simplify" it away — peek `9a591551` sibling):
 * On macOS, Cmd+Q is dispatched by AppKit's `performKeyEquivalent:` walk over
 * the key window's NSView hierarchy. That walk calls `app.quit()` SYNCHRONOUSLY,
 * so `before-quit` — and every `wc.destroy()` in it (`destroyAllPageHostGuests`)
 * — runs while AppKit is still *inside* that walk, holding raw pointers to the
 * very NSViews backing the hybrid page-host's content `WebContentsView`. Freeing
 * them mid-dispatch makes AppKit deref Chromium's freed-memory poison
 * (`0xefefefefefefefef`) on return → EXC_BAD_ACCESS on `CrBrowserMain`.
 * Deterministic with a hybrid host focused; never with a plain tile BrowserWindow.
 *
 * So: veto the first quit, let the native stack unwind (`setImmediate`), run the
 * cleanup on a clean stack, then quit for real. `destroyAllPageHostGuests` itself
 * must STAY — it prevents the inverse UAF (a guest derefed inside
 * `-[NSWindow __close]`, peek `d1cf0b9a`); only its *timing* is the bug.
 *
 * HANG SAFETY: vetoing quit means a missed re-quit = an app that never quits,
 * which is worse than the crash. Hence: `deferred` keeps vetoing (the macrotask
 * is already queued and will re-quit), and `done` NEVER vetoes, so the re-quit
 * always falls through to the real thing. The caller must move to `done` in a
 * `finally` so a throwing cleanup body cannot swallow the re-quit.
 */
export function planBeforeQuit(phase: QuitCleanupPhase): BeforeQuitDecision {
  switch (phase) {
    case 'idle':
      // First quit: veto it and get the teardown off the AppKit key-event stack.
      return { preventDefault: true, scheduleCleanup: true, nextPhase: 'deferred' };
    case 'deferred':
      // Another quit arrived before the scheduled cleanup ran. Keep vetoing —
      // the queued macrotask still owns the re-quit, so this cannot strand us.
      return { preventDefault: true, scheduleCleanup: false, nextPhase: 'deferred' };
    case 'done':
      // Our own re-quit (or any later one). Let it through, or we never exit.
      return { preventDefault: false, scheduleCleanup: false, nextPhase: 'done' };
  }
}

/**
 * The body `planBeforeQuit`'s `scheduleCleanup` decision queues: run the
 * cleanup, then re-issue the quit we vetoed.
 *
 * THE `await` IS THE POINT. Part of the cleanup is asynchronous and its
 * completion is load-bearing: the page-host guest teardown only issues
 * `webContents.destroy()` calls, which return while the guests are still alive
 * and only report `'destroyed'` a turn or two later. Re-quitting without
 * waiting hands Electron a set of host windows to close over live content
 * WebContents — the exact deref d1cf0b9a is about — and it was measured doing
 * precisely that: six guests, all still live when their hosts closed ~1ms after
 * the "teardown". The cleanup's own waits are bounded, so awaiting them here
 * cannot hang the quit.
 *
 * HANG SAFETY (same argument as `planBeforeQuit`, now covering rejection AND
 * a pending await): the re-quit is issued from `finally`, so neither a throwing
 * cleanup nor a rejected wait can swallow it. We vetoed the user's quit —
 * failing to re-issue it is strictly worse than whatever the cleanup hit.
 */
export async function runDeferredQuitCleanup(
  cleanup: () => void | Promise<void>,
  requestQuit: () => void,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await cleanup();
  } catch (err) {
    onError?.(err);
  } finally {
    requestQuit();
  }
}

/**
 * Hybrid page-host edge/corner resize band.
 *
 * Round-2 resize is driven entirely from MAIN against the content WebContents'
 * `input-event` stream (the overlay can capture a press but, never being the
 * macOS first responder, cannot PAINT a cursor — so the cursor + the drag both
 * live on the content/main side). This pure predicate is the shared geometry +
 * unit-test seam: given a SCREEN point and the host window's outer bounds, return
 * which resize direction the pointer is over, or null if it's in the interior.
 *
 * Geometry (mirrors the prior overlay handles): a `cornerPx` square at each
 * corner yields the diagonal directions; a `edgePx`-thick strip along each edge
 * (between the corner squares) yields the straight directions. `slack` widens the
 * whole band for spatial hysteresis — pass a small enter slack when not yet in the
 * band and a wider exit slack once engaged so boundary jitter can't oscillate the
 * cursor. Deterministic on position, no timers.
 */
export const RESIZE_EDGE_PX = 8;
export const RESIZE_CORNER_PX = 16;

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function hybridResizeDirAt(
  gx: number,
  gy: number,
  bounds: { x: number; y: number; width: number; height: number },
  edgePx: number,
  cornerPx: number,
  slack: number,
): ResizeDir | null {
  const dl = gx - bounds.x;
  const dr = bounds.x + bounds.width - gx;
  const dt = gy - bounds.y;
  const db = bounds.y + bounds.height - gy;
  // Beyond a little slack outside the frame → not a resize hover.
  if (dl < -slack || dr < -slack || dt < -slack || db < -slack) return null;
  const edge = edgePx + slack;
  const corner = cornerPx + slack;
  const cL = dl <= corner, cR = dr <= corner, cT = dt <= corner, cB = db <= corner;
  // Corners first (a corner is within cornerPx of TWO adjacent edges → diagonal).
  if (cT && cL) return 'nw';
  if (cT && cR) return 'ne';
  if (cB && cL) return 'sw';
  if (cB && cR) return 'se';
  // Then the straight edge strips.
  if (dt <= edge) return 'n';
  if (db <= edge) return 's';
  if (dl <= edge) return 'w';
  if (dr <= edge) return 'e';
  return null;
}

/**
 * Which window (if any) a NON-webview download should close.
 *
 *   - 'hybrid-host'    close the hybrid page-host (a BaseWindow) that owns the
 *                      content WC the download fired from.
 *   - 'browser-window' close the BrowserWindow that owns the WC — the historical
 *                      "top-level window opened just for this download" case.
 *   - 'none'           close nothing; the user is looking at a real page.
 *
 * PRECEDENCE IS THE WHOLE POINT: hybrid wins over BrowserWindow, even when
 * `hasBrowserWindow` is true. That combination is not hypothetical — it is the
 * normal shape of a hybrid download, and mis-ordering it was the alt+click bug
 * (peek 02e0a4fa). `BrowserWindow.fromWebContents(contentWC)` on a hybrid page
 * host does NOT return null: at runtime it resolves to the owning *BaseWindow*
 * (see the warning on `windowFromWebContents` in window-registry.ts). So a
 * BrowserWindow-first cascade matches EVERY hybrid download and closes the page
 * the user is browsing, and the hybrid branch behind it never runs at all.
 *
 * The hybrid rule itself is the paint guard (peek a060a75f): only a host opened
 * FRESH for the download is a throwaway. A `target=_blank` download link opens a
 * NEW page-host whose first-and-only navigation is the download URL, which
 * Chromium aborts — so the host never settles a load and is NOT painted. A host
 * already showing a real page (a download link clicked while browsing — e.g. a
 * Fastmail attachment, or an alt+click, which Chromium turns into a download in
 * the SOURCE page's WC without ever opening a window) HAS painted, and closing it
 * is exactly the bug this guards against.
 *
 * fsm-pilled: `hybridPainted` is read synchronously at will-download time, which
 * is BEFORE the aborted download navigation fires did-stop-loading (the event
 * that would otherwise mark even a fresh popup painted). No timer, no URL-diff
 * race — the load-lifecycle FSM already separates the two cases.
 *
 * Pure so the precedence is unit-testable without Electron: the live bug is
 * invisible to code reading (the runtime type of `fromWebContents` contradicts
 * its TypeScript signature) and unreachable from the webview-based download
 * specs, so a truth table is the only cheap regression net.
 */
export type DownloadCloseTarget = 'hybrid-host' | 'browser-window' | 'none';

export function downloadCloseTarget(o: {
  isHybridContent: boolean;
  hybridPainted: boolean;
  hasBrowserWindow: boolean;
}): DownloadCloseTarget {
  if (o.isHybridContent) {
    // Painted → a real page the user is browsing. Never close it.
    return o.hybridPainted ? 'none' : 'hybrid-host';
  }
  return o.hasBrowserWindow ? 'browser-window' : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Window surface properties — registration facts → the kernel's three
// orthogonal per-window fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one band above `BASE_LAYER`, and the only one that is realizable.
 *
 * `window-kernel-executor.ts stackingLevelForLayer` has exactly two arms —
 * `layer > BASE_LAYER` is `'pinned'` (Electron always-on-top, realized as
 * `setAlwaysOnTop(true, 'floating')`), everything else is `'stacked'` — so a
 * third band would be indistinguishable from this one at the OS boundary.
 * Electron's level strings cannot separate bands either: `'floating'` and
 * `'torn-off-menu'` are the SAME `NSWindowLevel` (3). Extra bands become
 * meaningful only when something below the executor can express them.
 */
export const FLOATING_LAYER = BASE_LAYER + 1;

/**
 * The registration facts the derivation reads. Each is a value some real
 * construction site passes (or declines to pass), never a live OS query.
 */
export interface WindowSurfaceFacts {
  /**
   * Resolved Electron `focusable`. `undefined` means the site said nothing,
   * which is Electron's default of `true` — `main.ts` / `ipc.ts` /
   * `tile-launcher.ts` all normalize the same way.
   */
  focusable?: boolean;
  /**
   * Declared always-on-top intent — the value registration already carries
   * (`ipc.ts` window-open, `tile-launcher.ts`, `hybrid-overlay.ts`).
   */
  alwaysOnTop?: boolean;
  /**
   * The construction site made the window click-through
   * (`setIgnoreMouseEvents(true, …)`) before registering it. Nothing infers
   * this; see `deriveAcceptsInput`.
   */
  clickThrough?: boolean;
}

/** The three orthogonal fields of a kernel `WindowRecord` this module derives. */
export interface WindowSurfaceProperties {
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
}

/**
 * Which band a window sits in.
 *
 * Keys on the DECLARED `alwaysOnTop` and on nothing else. Every window that
 * floats above the regular stack in this app states it at its own construction
 * site: the HUD (`renderer/hud/background.js openHud`), the command panel
 * (`renderer/cmd/background.js`), the windows switcher
 * (`features/windows/background.js openWindowsView`), the space-border
 * indicator (`features/spaces/background.js`), and the shared chrome overlay
 * (`hybrid-overlay.ts ensureOverlay`).
 *
 * NOT keyed on role or class, even though the two sets coincide today.
 * `window-state.ts classifyWindowRegistration` hands out class `'overlay'` /
 * `'palette'` on role alone, so `deriveStackingLevel` calls such a window
 * pinned whether or not anything ever pins it — a role-`'overlay'` window
 * opened without `alwaysOnTop` would claim a band the OS never gave it.
 * `alwaysOnTop` is the fact that actually produces the native band, so it is
 * the fact this reads.
 *
 * Peeks and slides (`features/peeks/background.js`,
 * `features/slides/background.js`, `role: 'quick-view'`) declare no
 * `alwaysOnTop`, so they land at `BASE_LAYER`. What lifts them visually is
 * `type: 'panel'` — AppKit panel behaviour, not a band — and treating them as
 * floating would put them in `isAppResignSweepEligible`'s `layer > BASE_LAYER`
 * half, which the role clause there is written to keep them out of.
 */
export function deriveWindowLayer(facts: Pick<WindowSurfaceFacts, 'alwaysOnTop'>): number {
  return facts.alwaysOnTop === true ? FLOATING_LAYER : BASE_LAYER;
}

/**
 * Whether the OS can give this window the key window.
 *
 * Exactly `focusable !== false` — the same normalization
 * `isSatelliteRegistration` already applies, with `undefined` meaning
 * Electron's default `true`.
 *
 * THE HUD IS WHY THIS EXISTS AS A FIELD: `renderer/hud/background.js openHud`
 * opens with `focusable: false`, and its role is not declared, so
 * `inferIzuiRole` returns `'workspace'` — an ordinary, admitted role. Nothing
 * about its role or class distinguishes it; only the open param does.
 *
 * NO ROLE CLAUSE, and no `alwaysOnTop` clause, because the real windows
 * contradict both:
 *
 *   - "an overlay never takes key" is wrong about the shared chrome overlay
 *     (`hybrid-overlay.ts ensureOverlay`), which is an always-on-top,
 *     role-`'overlay'` window constructed `focusable: true` ON PURPOSE — Cmd+L
 *     puts keyboard focus in the navbar's URL input, and a `focusable: false`
 *     window can never become key on macOS, so typing a URL was broken until
 *     it was made focusable.
 *   - "an always-on-top window never takes key" is wrong about the command
 *     panel (`renderer/cmd/background.js`), which floats and is typed into.
 *   - "always-on-top is a proxy for non-focusable" is wrong in the other
 *     direction too: the privileged test fixture (`test-fixture-glue.ts`) is
 *     `focusable: false` and NOT always-on-top.
 *
 * The other two production `focusable: false` windows are the space-border
 * indicator (`features/spaces/background.js`) and that test fixture.
 */
export function deriveCanBecomeKey(facts: Pick<WindowSurfaceFacts, 'focusable'>): boolean {
  return facts.focusable !== false;
}

/**
 * Whether the window takes mouse input, or lets it pass to whatever is below.
 *
 * Declared, never inferred: a window is click-through only when its
 * construction site says so, because the only thing that makes a window
 * click-through is a `setIgnoreMouseEvents(true, …)` call, and nothing else in
 * the open params implies one.
 *
 * ROLE IS NOT A PROXY — the windows switcher and the space border sit on
 * opposite sides of this despite both floating (`alwaysOnTop: true`).
 * `features/windows/background.js openWindowsView` opens a full-screen
 * switcher (`role: 'switcher'`) the user clicks windows in; it must keep
 * mouse input. `features/spaces/background.js` opens a screen-edge border
 * (`role: 'overlay'`) the pointer must pass straight through. Same
 * `alwaysOnTop`, different role, opposite answers — neither fact predicts
 * the other.
 *
 * THIS IS THE INITIAL VALUE ONLY. The shared chrome overlay
 * (`hybrid-overlay.ts ensureOverlay`) is click-through from birth — its
 * `setIgnoreMouseEvents(true, { forward: true })` runs before its
 * `registerWindowWithMachine` call — but `wireClickCapture` toggles it back on
 * whenever the pointer is over real chrome. A window whose click-through
 * changes after registration needs an event, not a re-derivation.
 *
 * The space border is the case a derivation CANNOT reach: its
 * `api.window.setIgnoreMouseEvents(...)` is a separate IPC round trip issued
 * after `api.window.open` resolves, so its registration genuinely carries no
 * click-through fact and this returns `true` for it. That is the honest answer
 * for the registration instant, and the later flip is the same missing-event
 * gap the overlay's runtime toggle has.
 */
export function deriveAcceptsInput(facts: Pick<WindowSurfaceFacts, 'clickThrough'>): boolean {
  return facts.clickThrough !== true;
}

/**
 * All three at once, for a registration site that has one facts object.
 * Orthogonal by construction (§0.1.4): each field reads its own fact and no
 * field is computed from another, so this is a grouping, not a combination.
 */
export function deriveWindowSurface(facts: WindowSurfaceFacts): WindowSurfaceProperties {
  return {
    layer: deriveWindowLayer(facts),
    canBecomeKey: deriveCanBecomeKey(facts),
    acceptsInput: deriveAcceptsInput(facts),
  };
}

/**
 * Special window classes (design §4.3 dim 8b) — a CLOSED enum. Every window
 * carries exactly one class, declared at registration; the class replaces the
 * 8+ per-module window singletons (`main.ts mainWindow`, `core-glue.ts
 * coreBackgroundWindow`, `test-fixture-glue.ts testFixtureWindow`,
 * `chrome-extensions.ts` bridge/UI maps as class-tagged records, …) and the
 * HUD-sniffing predicate (`isAlwaysOnTop() && !isFocusable()` + the
 * `__hudHidden` expando — both deleted in §5 step 4).
 *
 *   - `primary`      ordinary user-facing content window (page hosts, tiles)
 *   - `quick-view`   peeks/slides — front-eligible transients
 *   - `overlay`      chrome overlay / switcher overlay surfaces
 *   - `palette`      command palette / modal picker surfaces
 *   - `hud`          always-on-top non-focusable heads-up display
 *   - `background`   the hidden core background renderer
 *   - `bridge`       hidden chrome-extension bridge windows
 *   - `offscreen`    hidden chrome.offscreen polyfill document windows
 *   - `extension-ui` chrome-extension popup/options UI windows
 *   - `test-fixture` the Playwright test-fixture renderer
 *   - `devtools`     a detached devtools window
 */
export type WindowClass =
  | 'primary'
  | 'quick-view'
  | 'overlay'
  | 'palette'
  | 'hud'
  | 'background'
  | 'bridge'
  | 'offscreen'
  | 'extension-ui'
  | 'test-fixture'
  | 'devtools';

/**
 * A window's stacking level (§4.3 dim 3, §5 step 5) — how it participates in
 * z-order. Derived ONCE per registration by `deriveStackingLevel` (the single
 * owner of the rule), stored on the record:
 *
 *   - `stacked`  participates in the ordered stack (`AppWindowState.stackOrder`):
 *                primary, quick-view, extension-ui — the windows the user
 *                actually layers.
 *   - `pinned`   floats ABOVE the whole regular stack (hud / overlay / palette).
 *                Their above-ness is realized by the existing `SET_ALWAYS_ON_TOP`
 *                pin (macOS window level 'floating'), NOT by list position —
 *                the ordered stack never contains them, and `SET_STACKING`
 *                (a same-level relative raise) could not express them anyway.
 *   - `excluded` never on the user-visible stack in an orderable sense:
 *                background / bridge / offscreen / test-fixture / devtools plus any other
 *                satellite (modal dialogs, focusable:false surfaces) — their
 *                z-relationship is OS/parent-managed, not machine-ordered.
 */
export type StackingLevel = 'stacked' | 'pinned' | 'excluded';

/**
 * isSatelliteRegistration — the SINGLE owner of the front-ineligibility rule
 * applied when a window is registered. A "satellite" can never become `front`
 * (see WindowRecord.satellite / isEligibleFront). Every registration site
 * (ipc.ts window-open, main.ts tile-launcher hook) computes `satellite` through
 * THIS predicate so the two can't drift.
 *
 * A window is a satellite when it is structurally front-ineligible:
 *   - role 'overlay' / 'palette' — chrome/focus-group surfaces, never a target;
 *   - a close-on-blur modal dialog (judgment call 1);
 *   - `focusable === false` — one that can never be the OS key window, so it
 *     must never be `front`. Otherwise the derived Esc grab is suppressed
 *     (front != null) while the window can't receive `before-input-event`
 *     either → dead ESC (cf ebb10894 / 7c61e917).
 *
 * `focusable` is the RESOLVED focusability (or undefined = Electron's default
 * true); callers normalize before passing.
 *
 * Extended with the window CLASS (§5 step 4, rather than duplicating the rule
 * elsewhere): the infrastructure classes — hud, background, bridge, offscreen,
 * test-fixture, devtools — are structurally front-ineligible regardless of
 * role/focusable. `extension-ui` is deliberately NOT here: an extension popup
 * is a real user-facing window the user works in, so it stays front-eligible.
 */
const SATELLITE_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>([
  'hud',
  'background',
  'bridge',
  'offscreen',
  'test-fixture',
  'devtools',
]);

export function isSatelliteRegistration(
  role: string,
  opts: { modal?: boolean; focusable?: boolean; windowClass?: WindowClass } = {},
): boolean {
  if (opts.windowClass !== undefined && SATELLITE_CLASSES.has(opts.windowClass)) return true;
  if (role === 'overlay' || role === 'palette' || role === 'switcher') return true;
  if (opts.modal === true) return true;
  if (opts.focusable === false) return true;
  return false;
}

/**
 * classifyWindowRegistration — the SINGLE owner of the "which class is an
 * ordinary window-open?" rule (§4.3 dim 8b). The special infrastructure
 * classes (background / bridge / offscreen / extension-ui / test-fixture / devtools) are
 * never inferred — their glue modules declare them explicitly at registration.
 *
 * The `hud` arm is the DECLARED replacement for the deleted sniffing
 * predicate `isAlwaysOnTop() && !isFocusable()` (main.ts app-blur sweep):
 * the same pair of properties, but judged ONCE from the open params at
 * registration and stored as a class, instead of live-queried per sweep.
 */
export function classifyWindowRegistration(
  role: string,
  opts: { alwaysOnTop?: boolean; focusable?: boolean } = {},
): WindowClass {
  if (role === 'overlay' || role === 'switcher') return 'overlay';
  if (role === 'palette') return 'palette';
  if (role === 'quick-view') return 'quick-view';
  if (opts.alwaysOnTop === true && opts.focusable === false) return 'hud';
  return 'primary';
}

/**
 * What one registration call must do. Every field is a decision, not a value,
 * executed verbatim in two halves: the backend
 * (`electron-window-backend.ts registerWindow`) performs the merge +
 * native-listener attach, the executor (`window-os-adapter.ts registerWindow`)
 * performs the event pumps + the Esc-interceptor port command.
 */
export interface WindowRegistrationDecision {
  /** The id was already registered: this call is a MERGE, not a first registration. */
  reRegistration: boolean;
  /**
   * Attach the native window listeners (focus/blur/show/hide/closed/fullscreen).
   * False on a re-registration — attaching a second set would double every
   * event the window emits.
   */
  attachNativeListeners: boolean;
  /**
   * Attach the `before-input-event` Escape interceptor (`windows.ts
   * addEscHandler`). False on a re-registration: a second interceptor turned ONE
   * physical Escape into TWO `ESC_PRESSED` dispatches, which is what made the
   * switcher reopen itself in a loop (7fffa286). Also false for a `page-host`
   * (a BaseWindow has no root webContents; its Escape rides the content
   * WebContentsView) and for a caller that opts out (the shared chrome overlay,
   * which handles Escape in its own renderer).
   */
  attachEscHandler: boolean;
  /**
   * Overwrite the retained renderer WebContents with the incoming spec's.
   * A first registration always installs one (`null` when the caller supplied
   * none); a re-registration only when the caller actually passed the field, so
   * a later, thinner spec cannot blank out a WC the first one established.
   */
  adoptRendererWC: boolean;
  /**
   * Pump `WINDOW_REGISTERED` into the reducer. ALWAYS true, including on a
   * duplicate — deliberately. The later spec is the RICHER one (ipc.ts knows the
   * real `modal`/`focusable`, the tile-launcher hook only `win.isFocusable()`),
   * and `satellite` lives in the reducer's `WindowRecord`, so swallowing the
   * re-pump would strand the reducer on the thin spec and regress the
   * `isSatelliteRegistration` modal clause. `WINDOW_REGISTERED` is an idempotent
   * MERGE in `reduce` (it preserves `visible`/`focusSeq`/`fsMode`), so the
   * re-pump costs nothing beyond refreshing the declared fields.
   */
  pumpRegisteredEvent: boolean;
  /**
   * Pump `WINDOW_SHOWN { focused: true }` after the (re-)registration pump,
   * importing the native window's CURRENT visibility into the machine. True
   * whenever the native window is already visible at registration time.
   *
   * WHY (gate fallout of the WindowId cutover): a BrowserWindow constructed
   * with `show: true` (the window-open browser branch, pseudo-tiles) never
   * fires a `'show'` TRANSITION — it is born visible — and under a headless
   * run nothing ever focuses it either, so without this import the machine
   * literally never learns the window exists on screen: `front` stays null and
   * every front consumer (`getFocusedVisibleWindowId`, session-save's focused
   * descriptor, the overlay retarget) reads null forever. `focused: true`
   * ports the deleted "track immediately at open" behavior (old ipc.ts
   * `trackVisibleWindowFocus` at the open site): opening a visible window
   * makes it the target. Satellite/modal arbitration is structural in the
   * reducer (`applyFocusGained` ignores ineligible fronts), so this is safe to
   * pump for every kind — and on a RE-registration it lands after the richer
   * `WINDOW_REGISTERED` merge, so a modal is already a satellite by the time
   * the focused-shown event is judged.
   *
   * CONSTRAINT — registration happens at OPEN time only. `focused: true` is
   * correct solely because every current caller registers a window at the
   * moment it is opened, when an already-visible window is by construction the
   * one the user just targeted; this decision has NO input saying whether the
   * window actually holds OS focus. If a future path re-registers an
   * already-visible BACKGROUND window while another window holds OS focus,
   * this pump would steal `front` from the genuinely-focused window. Such a
   * path must not reuse this decision as-is: it needs real focus state as an
   * input (pump `focused: <actual OS focus>` instead), or must suppress the
   * shown pump entirely.
   */
  pumpShownEvent: boolean;
}

/**
 * decideWindowRegistration — the SINGLE owner of the "is this a re-registration,
 * and if so what carries over vs. what the new spec overwrites?" branch that
 * `WindowOsAdapter.registerWindow` executes.
 *
 * WHY it lives here and not next to its callers: `electron-window-backend.ts`
 * (which executes the merge/listener half) has a value-side
 * `import { app, globalShortcut } from 'electron'`, and `window-os-adapter.ts`
 * (which executes the pump/Esc-attach half) pulls it in transitively as its
 * default backend. The main-process unit gate runs its tests under
 * `ELECTRON_RUN_AS_NODE=1`, where that import throws at parse ("The requested
 * module 'electron' does not provide an export named …" — see the explanatory
 * comment in `window-registry.ts`). A test file importing either module would
 * take down the whole ~1950-test runner. This module has zero Electron
 * imports, so the decision is testable here and nowhere else. Same pattern as
 * the pure predicates above (`isSatelliteRegistration`, `classifyWindowRegistration`).
 */
export function decideWindowRegistration(input: {
  /** Whether the adapter already retains an entry for this window id. */
  alreadyRegistered: boolean;
  kind: WindowKind;
  /** Whether the spec carries a `contentWC` field at all (`undefined` = absent). */
  hasContentWC: boolean;
  /** The spec's `attachEscHandler` opt-out (`undefined` = default on). */
  attachEscHandlerRequested?: boolean;
  /**
   * Whether the native window is ALREADY VISIBLE at registration time
   * (`win.isVisible()`, read once by the adapter). `undefined` = not visible.
   * Drives `pumpShownEvent` — see its doc for why registration must import
   * current visibility (a ctor-shown window has no `'show'` transition).
   */
  nativeVisible?: boolean;
}): WindowRegistrationDecision {
  const { alreadyRegistered, kind, hasContentWC, attachEscHandlerRequested, nativeVisible } = input;
  const fresh = !alreadyRegistered;
  return {
    reRegistration: alreadyRegistered,
    attachNativeListeners: fresh,
    attachEscHandler: fresh && kind === 'browser' && attachEscHandlerRequested !== false,
    adoptRendererWC: fresh || hasContentWC,
    pumpRegisteredEvent: true,
    // Registration-time-only assumption — see the `pumpShownEvent` field doc:
    // visible-at-registration implies "just opened, user-targeted" ONLY while
    // every caller registers at open time. A path re-registering a visible
    // background window must not take this branch as-is (latent front-steal).
    pumpShownEvent: nativeVisible === true,
  };
}
