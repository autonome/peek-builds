/**
 * Hybrid page-host registry (P1.4a).
 *
 * The hybrid page-host path (behind `PEEK_PAGEHOST_HYBRID=1`) builds a web
 * page as an opaque, content-sized `BaseWindow` hosting a single
 * `WebContentsView` whose `webContents` is the site (see the HYBRID PAGE-HOST
 * EARLY BRANCH in `ipc.ts` and `docs/perf/page-host-hybrid-design.md` §2a).
 *
 * A `BaseWindow` is NOT a `BrowserWindow`: it has no root `.webContents`, so
 * the existing `window-registry` helpers (`getLiveWindow` /
 * `getAllLiveWindows` / `windowFromWebContents`, all backed by
 * `BrowserWindow.fromId` / `.getAllWindows` / `.fromWebContents`) cannot
 * return it — and most callers of those immediately read `.webContents`, so
 * shoehorning a BaseWindow into that contract would crash them. This module
 * is the SEPARATE indirection layer for hybrid windows: it lets the rest of
 * the codebase enumerate them, dedupe/reuse them by url/key, track which one
 * is frontmost, and target their content webContents — WITHOUT pretending a
 * BaseWindow is a BrowserWindow.
 *
 * **No-op when the flag is off.** Only the hybrid branch in `ipc.ts` calls
 * `registerHybridWindow`, and that branch is gated on `isHybridPageHost()`.
 * So on the old `<webview>` canvas path this registry stays empty and every
 * getter returns nothing / every finder returns null. Callers that consult
 * it (window-open dedup, `debug-list-windows`, `debug-eval`) are therefore
 * byte-identical on the old path.
 *
 * **Active-window tracking.** `getActiveHybridWindowId()` reports which
 * hybrid window is frontmost, fed by the BaseWindow's `'focus'`/`'blur'`
 * events (confirmed emitted by `BaseWindow` in Electron 40 — see
 * `electron.d.ts` `class BaseWindow` `'focus'`/`'blur'` declarations). The
 * content `WebContentsView`'s own `webContents` `'focus'` event is wired as a
 * belt-and-suspenders fallback (clicking into the page focuses the content wc
 * even in edge cases where the host BaseWindow focus event is missed). This
 * is the signal the P1.4b shared overlay uses to decide which content window
 * to frame.
 */

import type { BaseWindow, WebContents } from 'electron';

/**
 * One hybrid page-host window: its host `BaseWindow`, the main-owned content
 * `WebContents`, and the optional dedup `key` it was opened with. `url` /
 * `title` are read live off the content webContents (not cached) so they
 * always reflect the current navigation.
 */
export interface HybridWindowEntry {
  windowId: number;
  baseWin: BaseWindow;
  contentWC: WebContents;
  key?: string;
  /** Current live URL of the content webContents (empty if unavailable). */
  url(): string;
  /** Current live title of the content webContents (empty if unavailable). */
  title(): string;
}

interface InternalEntry {
  windowId: number;
  baseWin: BaseWindow;
  contentWC: WebContents;
  key?: string;
}

const entries = new Map<number, InternalEntry>();

// The id of the hybrid window that most recently gained focus, or null if no
// hybrid window is currently frontmost (or none exists). Cleared on blur of
// the active window and on close/destroy of the active window.
let activeHybridWindowId: number | null = null;

// Push-on-change subscribers for the active-window signal. Fired ONLY when
// `activeHybridWindowId` actually transitions to a different value (see
// `setActiveHybridWindowId`). The P1.4b shared overlay subscribes here so it
// can retarget without polling. Empty (and never fired) when the flag is off,
// because nothing ever calls `registerHybridWindow` / the test hook.
type ActiveChangeListener = (id: number | null) => void;
const activeChangeListeners = new Set<ActiveChangeListener>();

/**
 * Set the active hybrid window id and, IF the value actually changed, notify
 * every `onActiveHybridWindowChange` subscriber. This is the single mutation
 * chokepoint for `activeHybridWindowId` so the push signal can never miss a
 * transition or fire spuriously on a no-op set. Listeners run in a try/catch
 * so one throwing subscriber can't wedge the rest (or the focus handler that
 * triggered the change).
 */
function setActiveHybridWindowId(id: number | null): void {
  if (id === activeHybridWindowId) return;
  activeHybridWindowId = id;
  for (const cb of activeChangeListeners) {
    try {
      cb(id);
    } catch {
      /* a subscriber throwing must not break focus/blur bookkeeping */
    }
  }
}

function safeUrl(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getURL() || '';
  } catch {
    return '';
  }
}

function safeTitle(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getTitle() || '';
  } catch {
    return '';
  }
}

function toPublic(e: InternalEntry): HybridWindowEntry {
  return {
    windowId: e.windowId,
    baseWin: e.baseWin,
    contentWC: e.contentWC,
    key: e.key,
    url: () => safeUrl(e.contentWC),
    title: () => safeTitle(e.contentWC),
  };
}

/**
 * Best-effort URL normalization for dedup matching. Mirrors the SHAPE of the
 * canvas path's `findWindowByUrl` (which uses datastore `normalizeUrl`): we
 * keep it dependency-free here (lowercased origin+path, trailing slash and a
 * trailing `?`/`#` stripped) so the module stays trivially unit-testable and
 * import-safe under `ELECTRON_RUN_AS_NODE=1`. Exact-string opens always match;
 * the normalization just also catches the common trailing-slash variant.
 */
function normalizeForDedup(url: string): string {
  let u = url.trim();
  // Strip a lone trailing fragment/query marker.
  u = u.replace(/[?#]$/, '');
  // Strip a single trailing slash on the path (but not the scheme's `//`).
  u = u.replace(/(?<!:)\/+$/, '');
  return u.toLowerCase();
}

/**
 * Register a hybrid page-host window. Called ONCE from the hybrid branch in
 * `ipc.ts` right after the `BaseWindow` + content `WebContentsView` are built.
 *
 * Wires self-cleanup: the entry is dropped on the `baseWin` `'closed'` event
 * AND on the content `contentWC` `'destroyed'` event (whichever fires first),
 * so a closed hybrid window never lingers in the registry. Focus/blur
 * listeners maintain `getActiveHybridWindowId()`.
 *
 * Idempotent on `windowId`: re-registering overwrites the prior entry.
 */
export function registerHybridWindow(
  windowId: number,
  opts: { baseWin: BaseWindow; contentWC: WebContents; key?: string },
): void {
  const { baseWin, contentWC, key } = opts;
  const entry: InternalEntry = { windowId, baseWin, contentWC, key };
  entries.set(windowId, entry);

  const cleanup = () => {
    // Only delete if this exact entry is still the one registered (guards
    // against a re-register having replaced us).
    if (entries.get(windowId) === entry) {
      entries.delete(windowId);
    }
    if (activeHybridWindowId === windowId) {
      setActiveHybridWindowId(null);
    }
  };

  baseWin.once('closed', cleanup);
  contentWC.once('destroyed', cleanup);

  // Active-window tracking. BaseWindow emits 'focus'/'blur' in Electron 40.
  baseWin.on('focus', () => {
    if (entries.get(windowId) === entry) {
      setActiveHybridWindowId(windowId);
    }
  });
  baseWin.on('blur', () => {
    if (activeHybridWindowId === windowId) {
      setActiveHybridWindowId(null);
    }
  });
  // Belt-and-suspenders: focusing INTO the page focuses the content wc. Covers
  // edge cases where the host-window focus event is missed (e.g. a click that
  // lands directly in the WebContentsView).
  contentWC.on('focus', () => {
    if (entries.get(windowId) === entry) {
      setActiveHybridWindowId(windowId);
    }
  });

  // If the window is already focused at registration time (it was just
  // shown/focused), seed the active id so the first reader doesn't see null.
  try {
    if (!baseWin.isDestroyed() && baseWin.isFocused()) {
      setActiveHybridWindowId(windowId);
    }
  } catch {
    /* isFocused unsupported in some environments */
  }
}

/** Look up a hybrid window by host window id. Null if not a hybrid window. */
export function getHybridWindow(windowId: number): HybridWindowEntry | null {
  const e = entries.get(windowId);
  return e ? toPublic(e) : null;
}

/** Every registered hybrid window. Empty when the hybrid flag is off. */
export function getAllHybridWindows(): HybridWindowEntry[] {
  return Array.from(entries.values(), toPublic);
}

/**
 * The content `WebContents` for a hybrid window, or null. This is the handle
 * to drive navigation / execute script on the page (P1.4b overlay → main →
 * content mediation).
 */
export function getHybridContentWC(windowId: number): WebContents | null {
  const e = entries.get(windowId);
  return e && !e.contentWC.isDestroyed() ? e.contentWC : null;
}

/**
 * Find a hybrid window whose content currently loads `url` (for dedup/reuse on
 * a repeat open). Matches on normalized url (trailing-slash tolerant) against
 * the content webContents's live URL — mirroring the canvas path's
 * `findWindowByUrl`. Only http(s) urls participate, matching the canvas path.
 * Returns null if none.
 */
export function findHybridWindowByUrl(url: string): HybridWindowEntry | null {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
  const target = normalizeForDedup(url);
  for (const e of entries.values()) {
    if (e.contentWC.isDestroyed()) continue;
    if (normalizeForDedup(safeUrl(e.contentWC)) === target) {
      return toPublic(e);
    }
  }
  return null;
}

/**
 * Find a hybrid window opened with dedup `key`. Mirrors the canvas path's
 * `findWindowByKey` (the key is the per-window identity the caller manages).
 * Returns null if none.
 */
export function findHybridWindowByKey(key: string): HybridWindowEntry | null {
  if (!key) return null;
  for (const e of entries.values()) {
    if (e.key === key && !e.baseWin.isDestroyed()) {
      return toPublic(e);
    }
  }
  return null;
}

/**
 * The id of the frontmost hybrid window, or null if no hybrid window is
 * currently focused. Fed by BaseWindow `'focus'`/`'blur'` (+ content-wc
 * `'focus'` fallback). This is the signal the P1.4b shared overlay consumes
 * to decide which content window to frame/retarget over.
 */
export function getActiveHybridWindowId(): number | null {
  // Defensive: if the recorded active window has since been destroyed, report
  // null rather than a stale id.
  if (activeHybridWindowId != null) {
    const e = entries.get(activeHybridWindowId);
    if (!e || e.baseWin.isDestroyed()) {
      setActiveHybridWindowId(null);
    }
  }
  return activeHybridWindowId;
}

/**
 * Subscribe to active-hybrid-window changes. The callback fires with the new
 * active window id (or null) every time `getActiveHybridWindowId()` would
 * report a DIFFERENT value than before — driven by the BaseWindow
 * `'focus'`/`'blur'` events, content-wc `'focus'` fallback, and close/destroy
 * cleanup. Returns an unsubscribe function.
 *
 * This is the push signal the P1.4b shared chrome overlay consumes so it can
 * retarget over the active content window WITHOUT polling
 * `getActiveHybridWindowId()`. No-op-ish when the flag is off: nothing ever
 * mutates the active id on the canvas path, so a subscriber simply never fires.
 */
export function onActiveHybridWindowChange(cb: ActiveChangeListener): () => void {
  activeChangeListeners.add(cb);
  return () => {
    activeChangeListeners.delete(cb);
  };
}

/**
 * The active hybrid window's host-window OUTER bounds (screen coordinates), or
 * null if there is no active hybrid window / it has no live host. This is the
 * geometry source the overlay frames itself over. Uses `baseWin.getBounds()`
 * (outer frame) rather than the content rect so the overlay can cover the whole
 * window including any future native chrome/shadow region.
 */
export function getActiveHybridWindowBounds():
  | { x: number; y: number; width: number; height: number }
  | null {
  const id = getActiveHybridWindowId();
  if (id == null) return null;
  const e = entries.get(id);
  if (!e || e.baseWin.isDestroyed()) return null;
  try {
    return e.baseWin.getBounds();
  } catch {
    return null;
  }
}

/**
 * Test-only: synthetically set the active hybrid window id and fire the change
 * signal — WITHOUT any real OS focus change. Lets the overlay's retarget logic
 * be exercised deterministically (and without stealing the user's focus) in
 * headless/CI runs. `id` must be a registered hybrid window id (or null); a
 * non-registered id is rejected (returns false) so a test typo can't drive the
 * overlay to a phantom window.
 */
export function _setActiveHybridWindowForTests(id: number | null): boolean {
  if (id != null && !entries.has(id)) return false;
  setActiveHybridWindowId(id);
  return true;
}

/** Test-only: clear all registry state. */
export function _resetForTests(): void {
  entries.clear();
  activeChangeListeners.clear();
  activeHybridWindowId = null;
}
