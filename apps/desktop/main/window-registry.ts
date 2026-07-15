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

// Type-only imports from 'electron' so this module can be imported by
// unit tests running under ELECTRON_RUN_AS_NODE=1 (where the 'electron'
// module is a string path, not a fully-populated ESM namespace, so a
// value-side `import { BrowserWindow } from 'electron'` throws at parse:
// "The requested module 'electron' does not provide an export named
// 'BrowserWindow'"). Runtime access goes through `getElectron()` via
// createRequire, mirroring the canonical pattern in tile-ipc-gate.ts /
// tile-launcher.ts. See `project_esm_require_gotcha.md`.
import type { BrowserWindow as BrowserWindowType, WebContents } from 'electron';
import { createRequire } from 'node:module';

const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') {
  if (_electron) return _electron;
  _electron = requireElectron('electron') as typeof import('electron');
  return _electron;
}

/**
 * Resolve the BrowserWindow class from the electron runtime, or null
 * when there isn't one. Under `ELECTRON_RUN_AS_NODE=1` (unit tests),
 * `require('electron')` returns the binary path string — no
 * BrowserWindow — and downstream `.fromId` / `.getAllWindows` would
 * throw `TypeError: Cannot read properties of undefined`. Live-window
 * lookups have no work to do in that environment, so callers treat a
 * null return as "no live windows exist."
 */
function getBrowserWindowClass(): typeof BrowserWindowType | null {
  const electron = getElectron() as { BrowserWindow?: typeof BrowserWindowType } | string;
  if (typeof electron !== 'object' || electron === null) return null;
  return electron.BrowserWindow ?? null;
}

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
  /** Focus-recency rank (higher = more recently focused), not a window stacking order. See focus-order.ts. */
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
export function getLiveWindow(id: number): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Returns every non-destroyed BrowserWindow.
 *
 * Use this in place of `BrowserWindow.getAllWindows()` when you intend
 * to operate on live windows. Callers no longer need to filter out
 * destroyed entries.
 */
export function getAllLiveWindows(): BrowserWindowType[] {
  const BW = getBrowserWindowClass();
  if (!BW) return [];
  return BW.getAllWindows().filter(w => !w.isDestroyed());
}

/**
 * Returns the live BrowserWindow that owns `wc`, or null. Use this in
 * place of `BrowserWindow.fromWebContents(wc)` for callers that need
 * the destroyed-window filter.
 *
 * TRAP — the return type lies. `BrowserWindow.fromWebContents` resolves a
 * BaseWindow-hosted WebContentsView's WC (i.e. hybrid page-host content) to its
 * owning **BaseWindow**, which is NOT a BrowserWindow and is absent from
 * `BrowserWindow.getAllWindows()`. The `BrowserWindowType` annotation is
 * Electron's, and it is wrong at runtime; this returns a truthy non-BrowserWindow
 * for hybrid content. Most callers want exactly that (the window hosting the
 * page), which is why the contract is left alone. But a caller asking "is this
 * REALLY a BrowserWindow?" cannot use a truthiness check here — it must test
 * explicitly (e.g. against the hybrid registry, or `getAllLiveWindows()`
 * membership). Assuming null-for-hybrid caused the alt+click bug (peek 02e0a4fa):
 * a BrowserWindow-first branch swallowed every hybrid download and closed the
 * user's page, leaving the hybrid fallback behind it permanently dead.
 */
export function windowFromWebContents(wc: WebContents): BrowserWindowType | null {
  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromWebContents(wc);
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
 *     canonical window id (synthetic if this ref started as Pending and
 *     was realized; Electron's auto-allocated id otherwise).
 *   - `pending`: backed only by a `WindowDescriptor` — no `BrowserWindow`
 *     has been constructed yet. `id` is a synthetic value from the top
 *     of the safe-integer range. Calling `realize(ref)` will construct
 *     the BrowserWindow on demand.
 *
 * **Canonical ID stability:** once a Pending ref is realized, its
 * synthetic `id` continues to be the canonical id for the lifetime of
 * the window — callers holding it can keep using it through
 * `getWindowRef(syntheticId)` and the lookup will return the now-Live
 * ref. The Electron BrowserWindow's own auto-allocated id is exposed
 * via `ref.window.id` but should be considered internal; render-facing
 * IPC payloads should carry `ref.id`. (Phase 5 will audit IPC payload
 * shapes to enforce this.)
 *
 * Synthetic and Electron IDs occupy disjoint ranges (synthetic counts
 * down from MAX_SAFE_INTEGER, Electron auto-allocates from 1 up) so
 * they never collide.
 */
export type WindowRef =
  | { kind: 'live'; id: number; window: BrowserWindowType }
  | { kind: 'pending'; id: number; descriptor: WindowDescriptor };

// Unified registry of windows whose canonical id is synthetic — covers
// both pending refs (never realized) and realized-from-pending refs.
// Windows opened natively (e.g. cmd-N) are NOT in this map; they're
// looked up directly via BrowserWindow.fromId in getWindowRef.
const refs = new Map<number, WindowRef>();

// Electron BrowserWindow.id values that have a synthetic alias in
// `refs`. Used by getAllWindowRefs to avoid double-counting realized
// windows when it enumerates Electron's native registry.
const aliasedElectronIds = new Set<number>();

// Synthetic IDs count down from MAX_SAFE_INTEGER. ~9 quadrillion IDs
// before wraparound — well beyond any realistic process lifetime.
let nextSyntheticId = Number.MAX_SAFE_INTEGER;

function allocateSyntheticId(): number {
  return nextSyntheticId--;
}

/**
 * Register a not-yet-realized window from a descriptor. Returns a
 * Pending WindowRef whose synthetic `id` can be used in any registry
 * lookup for the lifetime of the window — including after realization.
 *
 * The descriptor is held by reference; mutating it after registration
 * affects subsequent reads.
 */
export function registerPendingWindow(descriptor: WindowDescriptor): WindowRef {
  const id = allocateSyntheticId();
  const ref: WindowRef = { kind: 'pending', id, descriptor };
  refs.set(id, ref);
  return ref;
}

/**
 * Look up a window by id. Synthetic IDs resolve via the unified
 * registry (pending or realized). Electron-native IDs (windows opened
 * outside the pending-realize path) resolve via `BrowserWindow.fromId`.
 * Unknown or destroyed IDs return null.
 *
 * Stale Live refs (BrowserWindow destroyed but registry not yet
 * cleaned) are reaped on demand here.
 */
export function getWindowRef(id: number): WindowRef | null {
  const ref = refs.get(id);
  if (ref) {
    if (ref.kind === 'live' && ref.window.isDestroyed()) {
      refs.delete(id);
      aliasedElectronIds.delete(ref.window.id);
      return null;
    }
    return ref;
  }

  const BW = getBrowserWindowClass();
  if (!BW) return null;
  const win = BW.fromId(id);
  if (win && !win.isDestroyed() && !aliasedElectronIds.has(win.id)) {
    return { kind: 'live', id: win.id, window: win };
  }
  return null;
}

/**
 * Every known window. Realized-from-pending and pending refs come from
 * our registry; Electron-native windows are projected from
 * `BrowserWindow.getAllWindows()`, minus those aliased by a synthetic.
 */
export function getAllWindowRefs(): WindowRef[] {
  const result: WindowRef[] = [];
  for (const ref of refs.values()) {
    if (ref.kind === 'live' && ref.window.isDestroyed()) {
      refs.delete(ref.id);
      aliasedElectronIds.delete(ref.window.id);
      continue;
    }
    result.push(ref);
  }
  const BW = getBrowserWindowClass();
  if (BW) {
    for (const win of BW.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (aliasedElectronIds.has(win.id)) continue;
      result.push({ kind: 'live', id: win.id, window: win });
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Realization
// ─────────────────────────────────────────────────────────────────────

/**
 * The function that turns a descriptor into a live BrowserWindow.
 *
 * window-registry can't import the window-open handler directly (the
 * handler lives in `ipc.ts`, which imports through `main.ts` which
 * imports from here — cycle). Instead, the session/IPC layer registers
 * a realizer at startup and `realize()` delegates to it. This also
 * means tests can swap in a stub.
 */
export type WindowRealizer = (descriptor: WindowDescriptor) => Promise<BrowserWindowType>;

let registeredRealizer: WindowRealizer | null = null;

/**
 * Register the function that constructs a BrowserWindow from a
 * descriptor. Must be called once during app startup, after the
 * window-open handler is in place. Calling twice throws.
 */
export function registerRealizer(fn: WindowRealizer): void {
  if (registeredRealizer) {
    throw new Error('window-registry: realizer already registered');
  }
  registeredRealizer = fn;
}

/**
 * Resolve a `WindowRef` to a live BrowserWindow. For a Live ref this
 * is an immediate no-op. For a Pending ref this constructs the
 * BrowserWindow via the registered realizer, updates the registry so
 * subsequent lookups by the synthetic id return the Live ref, and
 * arms a `closed` listener so the entry is reaped when the window
 * goes away.
 *
 * Idempotent: realizing an already-Live ref (or a synthetic id whose
 * pending entry was already realized by someone else) returns the
 * existing BrowserWindow.
 */
export async function realize(ref: WindowRef): Promise<BrowserWindowType> {
  if (ref.kind === 'live') return ref.window;

  // Re-read in case caller has a stale ref (race between two realize
  // calls on the same synthetic id).
  const current = refs.get(ref.id);
  if (!current) {
    throw new Error(`window-registry: realize() called for unknown synthetic id ${ref.id}`);
  }
  if (current.kind === 'live') {
    return current.window;
  }

  if (!registeredRealizer) {
    throw new Error('window-registry: realize() called but no realizer registered');
  }

  const win = await registeredRealizer(current.descriptor);

  const liveRef: WindowRef = { kind: 'live', id: ref.id, window: win };
  refs.set(ref.id, liveRef);
  aliasedElectronIds.add(win.id);

  win.once('closed', () => {
    refs.delete(ref.id);
    aliasedElectronIds.delete(win.id);
  });

  return win;
}

// ─────────────────────────────────────────────────────────────────────
// Test hooks
// ─────────────────────────────────────────────────────────────────────

/**
 * Reset internal state. Tests only — do not call from production code.
 */
export function _resetForTests(): void {
  nextSyntheticId = Number.MAX_SAFE_INTEGER;
  refs.clear();
  aliasedElectronIds.clear();
  registeredRealizer = null;
}
