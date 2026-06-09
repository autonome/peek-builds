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
