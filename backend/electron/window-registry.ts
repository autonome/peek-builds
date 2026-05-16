/**
 * Central indirection layer for window lookups.
 *
 * Backend code looks up windows through this module instead of reaching
 * for `BrowserWindow.fromId` / `BrowserWindow.getAllWindows` directly.
 * That gives us one place to teach the codebase about windows that
 * aren't live BrowserWindow instances yet — "pending" windows that hold
 * a descriptor but haven't been constructed.
 *
 * As of this phase, pending windows are a defined concept (see WindowRef
 * below) but nothing produces one in production yet. The legacy
 * `getLiveWindow` / `getAllLiveWindows` helpers continue to return only
 * Live windows; new `getWindowRef` / `getAllWindowRefs` callers can opt
 * into the union when they want to act on both.
 *
 * Future phases will: (a) wire `realize()` to construct the BrowserWindow
 * for a Pending ref on demand, (b) have session restore register Pending
 * refs instead of constructing eagerly, and (c) audit each
 * `getAllLiveWindows()` call site to decide whether it should iterate
 * Live-only or All.
 */

import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';

/**
 * Side-channel session state that needs to survive a window's lifecycle.
 * Today only used by session restore (to bring back the active mode +
 * its metadata). Held alongside the window's descriptor so a Pending
 * (not-yet-realized) window can carry it forward too.
 */
export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
}

/**
 * Everything needed to recreate a window. A WindowDescriptor is what
 * `saveSessionSnapshot` persists for each open window and what
 * `restoreSessionSnapshot` reads back to call the window-open handler.
 *
 * In phase 2+ this will also be the payload carried by a Pending
 * WindowRef so the registry can serve "fake" windows from descriptors
 * until they're realized on demand.
 */
export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
  zOrder: number;
  focused: boolean;
  context?: WindowContext;
}

/**
 * Returns the live BrowserWindow for `id`, or null if there is no such
 * window or it has been destroyed.
 *
 * Use this in place of `BrowserWindow.fromId(id)`; callers no longer
 * need to gate on `isDestroyed()`.
 */
export function getLiveWindow(id: number): BrowserWindow | null {
  const win = BrowserWindow.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Returns every non-destroyed BrowserWindow.
 *
 * Use this in place of `BrowserWindow.getAllWindows()` when you intend
 * to operate on live windows. Callers no longer need to filter out
 * destroyed entries.
 */
export function getAllLiveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
}

/**
 * Returns the live BrowserWindow that owns `wc`, or null. Use this in
 * place of `BrowserWindow.fromWebContents(wc)` for callers that need
 * the destroyed-window filter.
 */
export function windowFromWebContents(wc: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(wc);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Send `channel` (with optional args) to every live window. Equivalent
 * to iterating `getAllLiveWindows()` and calling `webContents.send` on
 * each — use this when the message is meant for all renderers
 * regardless of role (theme changes, dark-mode toggles, etc.).
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of getAllLiveWindows()) {
    win.webContents.send(channel, ...args);
  }
}

// ─────────────────────────────────────────────────────────────────────
// WindowRef abstraction
// ─────────────────────────────────────────────────────────────────────

/**
 * A reference to a window, in one of two states:
 *
 *   - `live`: backed by an actual Electron `BrowserWindow`. `id` is the
 *     `BrowserWindow.id` value Electron auto-allocated.
 *   - `pending`: backed only by a `WindowDescriptor` — no `BrowserWindow`
 *     has been constructed yet. `id` is a synthetic value from the top
 *     of the safe-integer range (see `allocateSyntheticId`). Calling
 *     `realize(ref)` will construct the BrowserWindow on demand.
 *
 * Synthetic and Electron IDs occupy disjoint ranges so they never
 * collide. The mapping between a Pending ref's synthetic ID and the
 * Electron ID assigned at realization time is a phase-5 concern — at
 * that point we'll either translate at lookup time or migrate callers
 * to treat the synthetic ID as canonical for the window's lifetime.
 */
export type WindowRef =
  | { kind: 'live'; id: number; window: BrowserWindow }
  | { kind: 'pending'; id: number; descriptor: WindowDescriptor };

// Pending refs live in this module. Live refs are projected on demand
// from Electron's BrowserWindow registry.
const pendingWindows = new Map<number, WindowRef & { kind: 'pending' }>();

// Synthetic IDs count down from MAX_SAFE_INTEGER so they sort above
// any Electron-allocated ID (which start at 1 and grow). ~9 quadrillion
// IDs before we'd loop — far beyond any realistic process lifetime.
let nextSyntheticId = Number.MAX_SAFE_INTEGER;

function allocateSyntheticId(): number {
  return nextSyntheticId--;
}

/**
 * Register a not-yet-realized window from a descriptor. Returns a
 * Pending WindowRef whose `id` can be used in any registry lookup. The
 * descriptor is held by reference — mutating it after registration
 * affects subsequent reads.
 *
 * No production code calls this yet; the function exists so phase 4
 * (session restore via Pending refs) can light it up with no further
 * registry changes.
 */
export function registerPendingWindow(descriptor: WindowDescriptor): WindowRef {
  const id = allocateSyntheticId();
  const ref: WindowRef & { kind: 'pending' } = { kind: 'pending', id, descriptor };
  pendingWindows.set(id, ref);
  return ref;
}

/**
 * Look up a window by id. Pending IDs (synthetic, high range) resolve
 * to a Pending ref; Electron IDs resolve to a Live ref backed by the
 * BrowserWindow; unknown or destroyed IDs return null.
 */
export function getWindowRef(id: number): WindowRef | null {
  const pending = pendingWindows.get(id);
  if (pending) return pending;

  const win = BrowserWindow.fromId(id);
  if (win && !win.isDestroyed()) {
    return { kind: 'live', id: win.id, window: win };
  }
  return null;
}

/**
 * Every known window — live (Electron's) first in `getAllWindows()`
 * order, then pending (ours) in registration order.
 */
export function getAllWindowRefs(): WindowRef[] {
  const refs: WindowRef[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      refs.push({ kind: 'live', id: win.id, window: win });
    }
  }
  for (const ref of pendingWindows.values()) {
    refs.push(ref);
  }
  return refs;
}

/**
 * Resolve a WindowRef to a live BrowserWindow. For a Live ref this is
 * a synchronous no-op wrapped in a Promise. For a Pending ref this
 * would construct the BrowserWindow from its descriptor via the
 * window-open handler — but that wiring is phase 5. Today, calling
 * `realize()` on a Pending ref throws.
 */
export async function realize(ref: WindowRef): Promise<BrowserWindow> {
  if (ref.kind === 'live') return ref.window;

  throw new Error(
    'window-registry: realize() for pending windows is not implemented yet. ' +
      'Phase 2 ships only the signature; phase 5 will wire it to invokeWindowOpen.'
  );
}

// ─────────────────────────────────────────────────────────────────────
// Test hooks
// ─────────────────────────────────────────────────────────────────────

/**
 * Reset internal state. Tests only — do not call from production code.
 */
export function _resetForTests(): void {
  nextSyntheticId = Number.MAX_SAFE_INTEGER;
  pendingWindows.clear();
}
