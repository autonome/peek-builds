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

/**
 * Roles whose ESC action is `close` (or `close-and-restore`) IRRESPECTIVE of
 * session state — the always-closeable transient/quick surfaces. This is the
 * role set `escPolicy()` resolves to a close (not 'nothing') no matter what the
 * IZUI session state is. Kept here, next to the role taxonomy, so the
 * ESC-target resolver below can reason about "is the active hybrid window one
 * that ESC should close?" without importing `escPolicy`.
 *
 * MUST stay in sync with `escPolicy()` in izui-state.ts (the single policy
 * source of truth): quick-view / palette / utility → 'close'; overlay →
 * 'close-and-restore'. content / child-content / workspace are session-
 * dependent or never-close, so they are deliberately EXCLUDED.
 */
export const ALWAYS_CLOSEABLE_ESC_ROLES = new Set([
  'quick-view',
  'palette',
  'utility',
  'overlay',
]);

/**
 * Decide which hybrid host id an ESC keystroke must resolve against.
 *
 * The wrong-window / first-responder regression (peek ebb10894): the hybrid
 * ESC→close handler lives on the content `WebContents`'s `before-input-event`,
 * which only fires for the macOS FIRST RESPONDER. On a fresh peek/slide open the
 * previously-focused hybrid CONTENT host (also a BaseWindow) can still hold
 * first-responder for a beat, so ESC lands on ITS handler → resolves role
 * 'content' → escPolicy 'nothing' → escUnhandledPolicy → the Windows switcher,
 * instead of closing the quick-view that the user actually just opened. (Once
 * the user clicks the peek/slide content, its WC becomes first responder and ESC
 * closes — the reported intermittency.)
 *
 * The registry's `getActiveHybridWindowId()` is the focus source of truth for
 * hybrids — it is driven by our OWN JS `focus` events (`showHybridHost`'s
 * `baseWin.show()` + `contentWC.focus()` on open), NOT the laggy macOS
 * first-responder — so it reliably points at the just-opened peek/slide. So when
 * ESC lands on a host that is NOT the active hybrid window, and the active hybrid
 * window is an always-closeable transient (quick-view peek/slide etc.), the ESC
 * is redirected to the active host. Otherwise the landed host is used unchanged.
 *
 * Pure + deterministic so the wrong-window resolution is unit-testable WITHOUT
 * real OS focus (which a macOS-headless run can never grant).
 *
 * @param landedHostId  the hybrid host id whose content WC actually received ESC
 * @param activeHybridId  `getActiveHybridWindowId()` (the focus source of truth)
 * @param activeRole  the registry role of `activeHybridId` (undefined if none)
 * @returns the host id ESC should resolve against
 */
export function resolveHybridEscapeTarget(
  landedHostId: number,
  activeHybridId: number | null,
  activeRole: string | undefined,
): number {
  // ESC already landed on the active hybrid window (the common case once the
  // content WC is first responder) — resolve against it, no redirect.
  if (activeHybridId == null || activeHybridId === landedHostId) return landedHostId;
  // ESC landed on a DIFFERENT host than the active hybrid window. Only redirect
  // when the active window is one ESC should always close (a quick-view peek/
  // slide, palette, etc.) — never hijack ESC toward a content/workspace active
  // window (those have their own ESC semantics and must not be force-closed).
  if (activeRole && ALWAYS_CLOSEABLE_ESC_ROLES.has(activeRole)) return activeHybridId;
  return landedHostId;
}

/**
 * Whether to register the OS-level global ESC fallback (`globalShortcut`
 * 'Escape' → open the windows switcher).
 *
 * The fallback exists for ONE case: Peek is the active app but has NO focused
 * window the keystroke can reach (e.g. the user Cmd+Tabbed to Peek on a macOS
 * Space that holds none of Peek's windows). Then ESC has nowhere to land, so a
 * global grab opens the switcher.
 *
 * The regression (peek ebb10894): the old predicate was
 * `appActive && BrowserWindow.getFocusedWindow() === null`. But
 * `getFocusedWindow()` returns `null` for a **hybrid page-host (`BaseWindow`)** —
 * see the desktop CLAUDE.md hybrid invariant. So whenever a slide/peek/content
 * hybrid host is the focused window, the predicate falsely concluded "no Peek
 * window focused", registered the global ESC grab, and that grab — which
 * pre-empts the content WC's `before-input-event` — opened the windows switcher
 * INSTEAD of letting the focused slide/peek close on ESC. The intermittency the
 * user saw ("sometimes focusing the content closes it") is the overlay (a real
 * `BrowserWindow`) transiently taking focus → `getFocusedWindow()` non-null →
 * grab unregisters → ESC reaches the close handler.
 *
 * Fix: a hybrid host counts as a focused Peek window. Register ONLY when the app
 * is active AND there is neither a focused `BrowserWindow` NOR an active hybrid
 * window. Pure + deterministic so the regression is unit-testable without real
 * OS focus.
 *
 * @param appActive  Peek is the OS-active app
 * @param hasFocusedBrowserWindow  `BrowserWindow.getFocusedWindow() !== null`
 * @param hasActiveHybridWindow  `getActiveHybridWindowId() !== null`
 */
export function shouldRegisterGlobalEscFallback(
  appActive: boolean,
  hasFocusedBrowserWindow: boolean,
  hasActiveHybridWindow: boolean,
): boolean {
  return appActive && !hasFocusedBrowserWindow && !hasActiveHybridWindow;
}

/**
 * Whether a hybrid page-host that just gained host-window focus must explicitly
 * make its content `WebContentsView` the macOS first responder.
 *
 * The gap (focused-but-ESC-dead, traced 2026-06-10): `showHybridHost` applies
 * the `show() + contentWC.focus()` invariant only on a FRESH show. A host that
 * was restored via `showInactive` (session restore — `contentFocused:false`) and
 * is LATER raised by its chrome / Cmd+Tab / Mission Control fires the BaseWindow
 * `'focus'` event (so `getActiveHybridWindowId()` correctly points at it, which
 * in turn suppresses the global ESC fallback) — but NOTHING makes its content WC
 * the first responder. So the content WC's `before-input-event` never sees ESC
 * (no `handleHybridEscape`), and the global fallback is off too: ESC has no
 * handler at all until the user clicks the page (which fires `contentWC 'focus'`
 * and restores first responder). Re-applying `contentWC.focus()` on host focus
 * closes the gap.
 *
 * True iff ALL hold:
 *   - NOT headless — headless/CI stays focus-free (never steal the user's real
 *     first responder; `showHybridHost` already gates the same way).
 *   - the content WC is alive (not destroyed).
 *   - the content WC is NOT already the first responder — when host focus was
 *     itself triggered by a click INTO the page (`contentWC 'focus'`), the WC is
 *     already focused, so re-focusing is a redundant no-op AND would risk a
 *     focus-event loop; skip it.
 *
 * Pure so the regression is unit-testable without real OS focus (mirrors
 * `shouldRegisterGlobalEscFallback`).
 *
 * @param headless  the run is headless/CI (focus-free)
 * @param contentDestroyed  the content WebContents has been torn down
 * @param contentAlreadyFocused  `contentWC.isFocused()` — already first responder
 */
export function shouldFocusHybridContentOnHostFocus(
  headless: boolean,
  contentDestroyed: boolean,
  contentAlreadyFocused: boolean,
): boolean {
  if (headless) return false;
  if (contentDestroyed) return false;
  return !contentAlreadyFocused;
}

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
 * @param appFocused  `getIzuiCoordinator().isAppFocused()` at restore time
 * @param headless    the run is headless/CI (focus-free)
 */
export function shouldActivateFocusedOnRestore(
  coldStart: boolean,
  appFocused: boolean,
  headless: boolean,
): boolean {
  return appFocused || (coldStart && !headless);
}

/**
 * One window's role + visibility, as seen by the focus-driven transient
 * autoclose. `role` is `undefined` for a window with no registry entry (those
 * are never transient candidates). `visible` gates out already-hidden windows.
 */
export interface TransientSiblingCandidate {
  id: number;
  role: string | undefined;
  visible: boolean;
}

/**
 * Decide which transient sibling windows a newly-focused window must auto-close.
 *
 * IZUI policy: palette / quick-view windows are transient — they dismiss as soon
 * as focus moves to any OTHER window. This is the focuser-driven mechanism
 * (macOS panel-type windows don't fire reliable per-window blur on intra-app
 * focus shifts, so the window that GAINS focus closes its transient siblings).
 *
 * Pure so it can be unit-tested without Electron AND so the SAME decision runs
 * for both window kinds: the caller passes candidates gathered from BOTH the
 * BrowserWindow registry and the hybrid page-host (BaseWindow) registry. Before
 * this existed the loop was inlined in `ipc.ts` over BrowserWindows only, so a
 * hybrid peek/slide (a BaseWindow) was never a closable candidate — the
 * close-on-blur regression (peek 8e5c3174).
 *
 * Rules (mirrors the historical inline loop):
 *   - A 'utility' focuser (e.g. a chain popup, child of a transient) closes
 *     NOTHING — it must not dismiss its transient parent.
 *   - Skip the focuser itself, any non-visible window, and any window whose role
 *     is not transient.
 *   - 'overlay' is transient-class but EXEMPT here: overlays manage their own
 *     restoration via the IZUI coordinator, not closeOrHideWindow.
 */
export function selectTransientSiblingsToClose(
  focusedId: number,
  focusedRole: string | undefined,
  candidates: readonly TransientSiblingCandidate[],
): number[] {
  if (focusedRole === 'utility') return [];
  const out: number[] = [];
  for (const c of candidates) {
    if (c.id === focusedId) continue;
    if (!c.visible) continue;
    if (!c.role || !TRANSIENT_ROLES.has(c.role)) continue;
    if (c.role === 'overlay') continue;
    out.push(c.id);
  }
  return out;
}

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
 * Resolve which window id a "close the current window" command (cmd+W / Close
 * Window) should target, given the focused BrowserWindow and the active hybrid
 * page-host.
 *
 * Two hybrid-era gotchas, both rooted in what `BrowserWindow.getFocusedWindow()`
 * reports relative to the content the user is looking at:
 *
 *   1. A frontmost hybrid page-host is a `BaseWindow` — `getFocusedWindow()`
 *      returns null for it, so a close path that trusted the focused
 *      BrowserWindow no-op'd cmd+W (peek ca4ee5e6). Fall back to the active
 *      hybrid id.
 *   2. The shared chrome OVERLAY is a `focusable:true` BrowserWindow that floats
 *      over the active hybrid host. Opening the address bar/widgets (Cmd+L)
 *      focuses it, so `getFocusedWindow()` now returns the OVERLAY — and closing
 *      *that* only dismisses the chrome and leaves the page visible (the reported
 *      cmd+W regression). When the focused window IS the overlay, ignore it and
 *      target the active hybrid host instead — closing the host tears down its
 *      content AND retires the chrome, which is what the user means.
 *
 * So: a focused BrowserWindow that is NOT the overlay wins (settings, modals,
 * canvas page-hosts, etc.); otherwise (no focused BW, or the overlay is focused)
 * the active hybrid host is the target. Null when neither resolves (cmd+W
 * harmless with no window). Pure so both regressions are unit-testable without
 * real OS focus (mirrors `shouldRegisterGlobalEscFallback`).
 *
 * @param focusedBrowserWindowId  `BrowserWindow.getFocusedWindow()?.id ?? null`
 * @param focusedIsHybridOverlay  the focused BrowserWindow is the chrome overlay
 * @param activeHybridWindowId    `getActiveHybridWindowId()`
 */
export function resolveCloseTargetId(
  focusedBrowserWindowId: number | null,
  focusedIsHybridOverlay: boolean,
  activeHybridWindowId: number | null,
): number | null {
  if (focusedBrowserWindowId != null && !focusedIsHybridOverlay) {
    return focusedBrowserWindowId;
  }
  return activeHybridWindowId;
}

/**
 * Resolve "the focused visible window" for tile consumers (the `tag`/`untag`
 * commands' active-window lookup, `view devtools`, etc.).
 *
 * The hybrid-era trap this guards against: `trackHybridWindowFocus` records a
 * focused hybrid page-host in the last-focused-visible tracker, but a hybrid
 * host is a `BaseWindow` and so is INVISIBLE to `getLiveWindow` (see windows.ts)
 * and reported as null by `BrowserWindow.getFocusedWindow()`. A resolver that
 * validates the tracked id only against live BrowserWindows therefore discards
 * the correct hybrid answer and falls through to a wrong/null window — which is
 * why `tag <name>` tagged whichever window happened to sort last instead of the
 * page the user was looking at.
 *
 * Resolution order, most-specific user intent first:
 *   1. tracked id, if it's a live BrowserWindow OR a live hybrid host
 *   2. the focused BrowserWindow (settings/modals/canvas page-hosts)
 *   3. the active hybrid host — the SAME signal the page-host chrome overlay
 *      frames over, so a command and the overlay can't disagree about the
 *      active page (covers a null/stale tracker when a hybrid host is up)
 *   4. the first visible+focusable live window
 *   5. null (no resolvable window)
 *
 * Pure so the hybrid-tracked-id case is unit-testable without real OS focus,
 * which is unobservable under macOS-headless (mirrors the predicates above).
 *
 * @param trackedId                 `getLastFocusedVisibleWindowId()`
 * @param trackedIsLiveWindow       tracked id resolves via `getLiveWindow`
 * @param trackedIsHybridWindow     tracked id is a live hybrid page-host
 * @param focusedBrowserWindowId    `BrowserWindow.getFocusedWindow()?.id ?? null`
 * @param activeHybridWindowId      `getActiveHybridWindowId()`
 * @param firstVisibleFocusableLiveId  first visible+focusable live window id, or null
 */
export function resolveFocusedVisibleWindowId(
  trackedId: number | null,
  trackedIsLiveWindow: boolean,
  trackedIsHybridWindow: boolean,
  focusedBrowserWindowId: number | null,
  activeHybridWindowId: number | null,
  firstVisibleFocusableLiveId: number | null,
): number | null {
  if (typeof trackedId === 'number' && trackedId > 0) {
    if (trackedIsLiveWindow || trackedIsHybridWindow) return trackedId;
  }
  if (focusedBrowserWindowId != null) return focusedBrowserWindowId;
  if (activeHybridWindowId != null) return activeHybridWindowId;
  if (firstVisibleFocusableLiveId != null) return firstVisibleFocusableLiveId;
  return null;
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
