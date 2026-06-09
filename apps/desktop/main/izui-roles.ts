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
 * Roles whose ESC action is `close` (or `close-and-restore`) IRRESPECTIVE of
 * session state — the always-closeable transient/quick surfaces. This is the
 * role set `escPolicy()` resolves to a close (not 'nothing') no matter what the
 * IZUI session state is. Kept here, next to the role taxonomy, so the
 * ESC-target resolver below can reason about "is the active hybrid window one
 * that ESC should close?" without importing the Electron-bound `escPolicy`.
 *
 * MUST stay in sync with `escPolicy()` in windows.ts (the single policy source
 * of truth): quick-view / palette / utility → 'close'; overlay →
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
