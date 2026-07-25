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
 *
 * Importers must NOT add Electron deps here. This module is loaded by
 * unit tests that run under ELECTRON_RUN_AS_NODE=1 — Electron itself is
 * available, but we keep this file Electron-free so it stays trivially
 * testable and so the role taxonomy is decoupled from window plumbing.
 */

/**
 * Transient window roles. These open and close frequently and ride above
 * the workspace — they should not affect dock visibility, and on macOS
 * they follow the user across Spaces instead of anchoring to their
 * creation Space.
 */
export const TRANSIENT_ROLES = new Set(['palette', 'quick-view', 'overlay']);

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
// retired by the §5 step 9 cutover. The decision lives in the window-state
// machine now — `window-state.ts selectTransientAutoclose` (focus-driven) and
// `selectAppResignTransients` (app switch) — reading the reducer's records
// instead of a candidate list gathered from two registries. Semantics were
// ported verbatim (utility focuser closes nothing; skip self / hidden /
// non-transient; 'overlay' exempt) and the unit table moved with them into
// `window-state.test.ts`.

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

// The close-target resolver (`resolveCloseTargetId`) and the focused-visible
// resolver (`resolveFocusedVisibleWindowId`, with its 7-input cascade) are
// DELETED — both collapse into the window-state machine's single `front`
// authority (`getFrontWindowId()`), whose satellite rule already excludes the
// chrome overlay + modal issuers. Their regression assertions are ported to
// `window-state.test.ts`.

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
