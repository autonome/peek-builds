/**
 * Hybrid page-host registry (P1.4a).
 *
 * The hybrid page-host path builds a web
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
 * **Always populated.** The hybrid branch in `ipc.ts` calls
 * `registerHybridWindow` for every page-host window it opens — hybrid is the
 * only page-host implementation, so this registry always reflects the live
 * set of open page hosts. Callers that consult it (window-open dedup,
 * `debug-list-windows`, `debug-eval`) can rely on it unconditionally.
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

import type { BaseWindow, Rectangle, WebContents } from 'electron';

// ── Per-host load-error state (Stage B) ─────────────────────────────────────
// Lives here (not in hybrid-overlay.ts) so BOTH ipc.ts (which sets errors) and
// hybrid-overlay.ts (which reads them for sendActiveHandoff) can import it
// without creating a circular dependency (hybrid-overlay.ts → ipc.ts already).
//
// FSM alignment: error state per host swaps deterministically via the existing
// `sendActiveHandoff` / `paintFromSnapshot` handoff. Live updates for the
// currently-active window are delivered via a registered callback (installed by
// hybrid-overlay.ts); non-active windows are covered by the next retarget.

/** A load failure recorded for a hybrid page-host. */
export type HybridLoadError = {
  failedUrl: string;
  errorCode: string;
  errorDescription: string;
};

const perHostLoadError = new Map<number, HybridLoadError | null>();

// Per-host pending navigation URL. Set by installHybridNavbarActionRouting's
// page:navigate subscriber BEFORE calling loadURL(url), so wireHybridContentEvents
// can read the target URL in did-start-loading (where contentWC.getURL() still
// returns the last COMMITTED URL, not the pending target).
const perHostPendingNavUrl = new Map<number, string>();

/** Record the URL being navigated to for `windowId`. Called before loadURL. */
export function setHybridPendingNavUrl(windowId: number, url: string): void {
  perHostPendingNavUrl.set(windowId, url);
}

/** Consume and clear the pending nav URL for `windowId`. Returns null if not set. */
export function takeHybridPendingNavUrl(windowId: number): string | null {
  const url = perHostPendingNavUrl.get(windowId) ?? null;
  perHostPendingNavUrl.delete(windowId);
  return url;
}

// ── Hybrid window closed-listener seam ──────────────────────────────────────
// Fires with the windowId whenever a hybrid window leaves the registry — via
// the self-clean 'closed'/'destroyed' hooks OR the explicit
// `unregisterHybridWindow` close-finalize path. Registered by
// hybrid-overlay.ts (initHybridOverlay), which routes it into
// permission-handler's `denyPendingRequestsForWindow` so a hybrid host
// closing with a permission prompt open denies (and resolves) its deferred
// Chromium callbacks. Same one-way-dependency shape as the load-error
// listener below: this pure module never imports the consumer.
let windowClosedListener: ((windowId: number) => void) | null = null;

/**
 * Register a callback invoked when a hybrid window is closed/unregistered.
 * Pass null to unregister (e.g. on teardown). May fire more than once for the
 * same windowId (the 'closed' event and an explicit unregister can both run) —
 * consumers must be idempotent.
 */
export function registerHybridWindowClosedListener(
  fn: ((windowId: number) => void) | null,
): void {
  windowClosedListener = fn;
}

function notifyWindowClosed(windowId: number): void {
  if (!windowClosedListener) return;
  try {
    windowClosedListener(windowId);
  } catch {
    /* listener must never break teardown */
  }
}

/** Registered by hybrid-overlay.ts to publish a live `page:load-error` update. */
let loadErrorListener: ((windowId: number, error: HybridLoadError | null) => void) | null = null;

/**
 * Register a callback that hybrid-overlay.ts uses to forward live load-error
 * changes to the overlay renderer for the currently-active window. Called once
 * from `initHybridOverlay()`. Pass null to unregister (e.g. on teardown).
 */
export function registerLoadErrorListener(
  fn: ((windowId: number, error: HybridLoadError | null) => void) | null,
): void {
  loadErrorListener = fn;
}

/**
 * Record (or clear) the load-error state for a hybrid page-host window.
 *
 * Stores the state in the per-host map and calls the live-update listener
 * (registered by hybrid-overlay.ts) so the overlay can react immediately if
 * the window is currently active. Non-active windows receive the error in the
 * next `sendActiveHandoff` snapshot.
 *
 * Pass `null` to clear: new navigation started, load succeeded, WC destroyed.
 */
export function setHybridLoadError(windowId: number, error: HybridLoadError | null): void {
  perHostLoadError.set(windowId, error);
  if (loadErrorListener) loadErrorListener(windowId, error);
}

/**
 * Read the current load-error state for a hybrid page-host window, or null
 * if no error has been recorded (or it was cleared). Used by `sendActiveHandoff`
 * to include the per-host error in the overlay snapshot.
 */
export function getHybridLoadError(windowId: number): HybridLoadError | null {
  return perHostLoadError.get(windowId) ?? null;
}

// ── Loading-timeout duration (Stage B) ──────────────────────────────────────
// The duration for the per-navigation loading-timeout safety net (mirrors the
// canvas DEFAULT_LOADING_TIMEOUT_MS = 30 000). ipc.ts reads this each time
// `did-start-loading` arms a fresh timer. The test bridge (in hybrid-overlay.ts)
// lowers it to 1.5 s so the hung-load spec doesn't burn the full test budget.
let _hybridLoadingTimeoutMs = 30000;

/** Current loading-timeout duration. Read by `wireHybridContentEvents` per navigation. */
export function getHybridLoadingTimeoutMs(): number { return _hybridLoadingTimeoutMs; }

/** Set a new loading-timeout duration. Test bridge only; production keeps 30 s. */
export function setHybridLoadingTimeoutMs(ms: number): void { _hybridLoadingTimeoutMs = ms; }

/**
 * One hybrid page-host window: its host `BaseWindow`, the main-owned content
 * `WebContents`, the optional dedup `key` it was opened with, and the
 * `requestedUrl` it was opened FOR. `url` / `title` are read live off the
 * content webContents (not cached) so they always reflect the current
 * navigation; `requestedUrl` is the static open address used for dedup.
 */
export interface HybridWindowEntry {
  windowId: number;
  baseWin: BaseWindow;
  contentWC: WebContents;
  key?: string;
  /** The static open address this window was created for (dedup key). */
  requestedUrl?: string;
  /**
   * Current live URL of the content webContents. For a deferred-load window
   * (session restore beyond the eager count) whose content hasn't committed
   * yet, falls back to the saved URL it will load — so window listings and
   * session save present/persist the real address, never an empty string.
   */
  url(): string;
  /**
   * Current live title of the content webContents. Falls back to the saved
   * title for a deferred-load window whose content hasn't loaded yet.
   */
  title(): string;
  /**
   * True while this hybrid window is maximized (snapped to its display's
   * work area via the `page:maximize` intent, or restored into that state
   * on reopen/session-restore). Set/cleared exclusively through
   * `setHybridMaximizeState` — see that function for why this, rather than
   * the BaseWindow's native `'maximize'`/`'unmaximize'` events, is the
   * source of truth.
   */
  maximized: boolean;
  /**
   * The outer bounds this window had immediately before it was maximized,
   * so unmaximize can restore to that exact rect. Null when not maximized.
   */
  preMaxBounds: Rectangle | null;
}

/**
 * Deferred content load for a session-restored hybrid window beyond the
 * eager count (session.ts `restoreBlank`): the URL to load on first
 * activation plus the saved title to present until then. `started` flips
 * true exactly once, in `claimHybridDeferredLoad` — the once-guard for the
 * deferred load. The object is kept (not cleared) after the claim so
 * `url()`/`title()` can keep falling back to the saved values until the
 * content webContents actually commits a real URL (and so a failed deferred
 * load doesn't erase the window's user-facing address).
 */
interface DeferredLoad {
  url: string;
  title: string;
  started: boolean;
}

interface InternalEntry {
  windowId: number;
  baseWin: BaseWindow;
  contentWC: WebContents;
  key?: string;
  requestedUrl?: string;
  maximized: boolean;
  preMaxBounds: Rectangle | null;
  deferredLoad: DeferredLoad | null;
}

const entries = new Map<number, InternalEntry>();

// The id of the hybrid window that most recently gained focus, or null if no
// hybrid window is currently frontmost (or none exists). Cleared on blur of
// the active window and on close/destroy of the active window.
let activeHybridWindowId: number | null = null;

// ── Focus-group model ──────────────────────────────────────────────────────
//
// The P1.4b shared chrome overlay is a SEPARATE focusable window that floats
// over whichever content window is active. Clicking the overlay (e.g. the
// navbar URL field) makes the overlay key and BLURS the content BaseWindow. A
// naive `baseWin 'blur' → active = null` therefore destroys the overlay the
// instant the user touches it (and nulls `activeWindowId`, breaking
// back/forward). The OLD canvas chrome never had this because the chrome lived
// in the SAME window as the content — one focus surface.
//
// We reproduce that "one logical surface" by treating the overlay window and
// its active content window as ONE focus group. Focus moving from the content
// window to the overlay (or vice-versa) is INTRA-group and must NOT deactivate.
// We only deactivate when focus leaves the WHOLE group — to a non-hybrid window
// or another app.
//
// Mechanics: Electron fires the OLD window's 'blur' BEFORE the NEW window's
// 'focus'. So on a content 'blur' we cannot yet tell where focus landed. We
// DEFER the decision one tick (`setImmediate`) and then look at the live focus
// state: if the overlay is focused, or another hybrid content window is
// focused, focus stayed in-group → keep/retarget; only if focus landed on
// neither do we null.

// Reports whether the shared chrome overlay window is currently focused. The
// overlay (hybrid-overlay.ts) registers this so the deferred blur decision can
// ask "did focus land on the overlay?" without this module importing the
// overlay (which would create a cycle). Null until the overlay registers.
let isOverlayFocused: (() => boolean) | null = null;

// Per-window pending deferred-blur handles, so a re-focus before the deferred
// check fires can cancel the stale decision (and so cleanup can cancel it).
const pendingBlurChecks = new Map<number, ReturnType<typeof setImmediate>>();

/**
 * Register a predicate the registry calls (inside the deferred blur decision)
 * to learn whether the shared chrome overlay window is currently focused. The
 * overlay window is part of the active window's focus group: while it is
 * focused, the active content window must stay active. Pass `null` to clear
 * (e.g. overlay torn down). One-way dependency: the overlay calls IN here, this
 * module never imports the overlay.
 */
export function setOverlayFocusProvider(fn: (() => boolean) | null): void {
  isOverlayFocused = fn;
}

// Reports the shared chrome overlay window's id (or null if torn down). The
// overlay (hybrid-overlay.ts) registers this so close-resolution can recognise
// "the focused BrowserWindow is the chrome overlay" — the overlay is focusable
// (a Cmd+L / click focuses its URL field), so `getFocusedWindow()` can return it
// while the page-host the user is actually looking at sits behind it. Same
// one-way dependency as `setOverlayFocusProvider`: the overlay calls IN here,
// this module never imports the overlay. Null until the overlay registers.
let overlayWindowIdProvider: (() => number | null) | null = null;

/**
 * Register a getter the registry uses to learn the shared chrome overlay
 * window's id. Pass `null` to clear (overlay torn down). One-way dependency —
 * see `overlayWindowIdProvider`.
 */
export function setOverlayWindowIdProvider(fn: (() => number | null) | null): void {
  overlayWindowIdProvider = fn;
}

/**
 * Is `id` the shared chrome overlay window? Used by the cmd+W close resolver:
 * when the overlay is the focused BrowserWindow (address bar/widgets open),
 * closing it alone would just dismiss the chrome and leave the page-host
 * visible, so the resolver redirects the close to the active hybrid host. False
 * when no overlay is registered (canvas path / overlay torn down).
 */
export function isHybridOverlayWindowId(id: number): boolean {
  if (!overlayWindowIdProvider) return false;
  try {
    return overlayWindowIdProvider() === id;
  } catch {
    return false;
  }
}

/** Is any registered hybrid content BaseWindow currently focused? */
function anyHybridContentFocused(): { focused: boolean; id: number | null } {
  for (const e of entries.values()) {
    try {
      if (!e.baseWin.isDestroyed() && e.baseWin.isFocused()) {
        return { focused: true, id: e.windowId };
      }
    } catch {
      /* isFocused unsupported in some environments */
    }
  }
  return { focused: false, id: null };
}

/**
 * The deferred decision run one tick after a content window's 'blur'. By now
 * Electron has delivered the new window's 'focus', so live `isFocused()` state
 * tells us where focus actually went:
 *   - overlay focused           → stay in-group; keep `blurredId` active.
 *   - another hybrid focused    → real switch; that hybrid's own 'focus' handler
 *                                 already set active to it — do nothing.
 *   - neither                   → focus left the group → null.
 */
function decideAfterBlur(blurredId: number): void {
  pendingBlurChecks.delete(blurredId);

  // If active already moved off the window that blurred (a real switch already
  // set active to the newly-focused hybrid), there is nothing to decide.
  if (activeHybridWindowId !== blurredId) return;

  // Focus landed on the shared chrome overlay → intra-group, keep active.
  if (isOverlayFocused) {
    try {
      if (isOverlayFocused()) return;
    } catch {
      /* provider threw — fall through to the other checks */
    }
  }

  // Focus landed on another hybrid content window → retarget to it (its own
  // 'focus' handler may not have run yet on every platform, so be explicit).
  const other = anyHybridContentFocused();
  if (other.focused && other.id != null) {
    setActiveHybridWindowId(other.id);
    return;
  }

  // Focus left the whole group (non-hybrid window or another app) → deactivate.
  setActiveHybridWindowId(null);
}

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
    requestedUrl: e.requestedUrl,
    url: () => safeUrl(e.contentWC) || e.deferredLoad?.url || '',
    title: () => safeTitle(e.contentWC) || e.deferredLoad?.title || '',
    maximized: e.maximized,
    preMaxBounds: e.preMaxBounds,
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
 * `opts.url` is the static open address this window was created for; it is what
 * `findHybridWindowByUrl` dedups against (canvas-parity — see that function).
 *
 * Idempotent on `windowId`: re-registering overwrites the prior entry.
 */
export function registerHybridWindow(
  windowId: number,
  opts: {
    baseWin: BaseWindow;
    contentWC: WebContents;
    key?: string;
    url?: string;
    /**
     * Session-restore deferred content load (`restoreBlank`): the window is
     * built and shown but its content webContents is NOT navigated until the
     * first genuine activation (host BaseWindow 'focus'), when
     * `claimHybridDeferredLoad` releases this URL exactly once. `title` is
     * the saved title to present until then.
     */
    deferredLoad?: { url: string; title?: string };
  },
): void {
  const { baseWin, contentWC, key, url } = opts;
  const entry: InternalEntry = {
    windowId, baseWin, contentWC, key, requestedUrl: url,
    maximized: false,
    preMaxBounds: null,
    deferredLoad: opts.deferredLoad
      ? { url: opts.deferredLoad.url, title: opts.deferredLoad.title || '', started: false }
      : null,
  };
  entries.set(windowId, entry);

  const cleanup = () => {
    // Cancel any in-flight deferred blur decision for this window.
    const pending = pendingBlurChecks.get(windowId);
    if (pending) {
      clearImmediate(pending);
      pendingBlurChecks.delete(windowId);
    }
    // Only delete if this exact entry is still the one registered (guards
    // against a re-register having replaced us).
    if (entries.get(windowId) === entry) {
      entries.delete(windowId);
      // Announce the teardown (e.g. deny pending permission prompts). Inside
      // the guard so an entry already dropped by unregisterHybridWindow (which
      // notifies itself) doesn't double-fire; the listener is idempotent anyway.
      notifyWindowClosed(windowId);
    }
    if (activeHybridWindowId === windowId) {
      setActiveHybridWindowId(null);
    }
  };

  baseWin.once('closed', cleanup);
  contentWC.once('destroyed', cleanup);

  // Active-window tracking. BaseWindow emits 'focus'/'blur' in Electron 40.
  // Focusing a content window makes it active AND cancels any pending deferred
  // blur (e.g. focus bounced content→overlay→content within a tick).
  const onContentFocus = () => {
    if (entries.get(windowId) !== entry) return;
    const pending = pendingBlurChecks.get(windowId);
    if (pending) {
      clearImmediate(pending);
      pendingBlurChecks.delete(windowId);
    }
    setActiveHybridWindowId(windowId);
  };
  baseWin.on('focus', onContentFocus);
  // DO NOT null immediately on blur — the overlay (a separate focusable window)
  // and other hybrid windows are part of the focus group. Defer the decision one
  // tick so Electron has delivered the NEW window's 'focus' and we can read live
  // focus state (see decideAfterBlur / the focus-group note above).
  baseWin.on('blur', () => {
    if (activeHybridWindowId !== windowId) return;
    if (pendingBlurChecks.has(windowId)) return;
    pendingBlurChecks.set(
      windowId,
      setImmediate(() => decideAfterBlur(windowId)),
    );
  });
  // Belt-and-suspenders: focusing INTO the page focuses the content wc. Covers
  // edge cases where the host-window focus event is missed (e.g. a click that
  // lands directly in the WebContentsView).
  contentWC.on('focus', onContentFocus);

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

/**
 * Record a hybrid window's maximize state: `maximized` plus (when maximized)
 * the outer bounds it had immediately before — the rect a later unmaximize
 * restores to. No-op if `windowId` isn't registered (window closed mid-flight).
 *
 * This is the SINGLE place hybrid maximize state changes. It is driven by
 * the `page:maximize`/`page:unmaximize` pubsub handlers in `ipc.ts` (the
 * user toggling maximize via the overlay navbar) and by the hybrid window
 * construction branch when reopening/restoring a window that was maximized
 * at close/save time.
 *
 * Deliberately NOT driven by the BaseWindow's native `'maximize'`/
 * `'unmaximize'` events: hybrid page-hosts are `frame: false` (see the
 * `BaseWindow` construction in `ipc.ts`) with no OS-drawn title bar, so
 * there is no native affordance (double-click title bar, green button) that
 * could ever set the OS-level maximized style — the ONLY way a hybrid
 * window becomes "maximized" is the app's own `page:maximize` intent, which
 * snaps bounds to the display's work area via `setBounds()` rather than
 * calling `baseWin.maximize()` (frameless/panel-style windows don't reliably
 * flip Electron's native maximize flag on macOS — same rationale as
 * tile-ipc.ts's generic BrowserWindow maximize handler). So the native
 * events would simply never fire; the pubsub intent IS the deterministic
 * signal here, not a substitute for one.
 */
export function setHybridMaximizeState(
  windowId: number,
  maximized: boolean,
  preMaxBounds: Rectangle | null,
): void {
  const e = entries.get(windowId);
  if (!e) return;
  e.maximized = maximized;
  e.preMaxBounds = maximized ? preMaxBounds : null;
}

/**
 * Claim the deferred content load for `windowId`: returns the URL to load
 * the FIRST time it is called for a window registered with `deferredLoad`,
 * and null on every subsequent call (and for windows with no deferred load,
 * or unregistered ids). This is the once-guard — the single mutation point
 * for the deferred-load state, driven by the host BaseWindow's 'focus'
 * handler in ipc.ts (first genuine activation). The saved url/title stay on
 * the entry after the claim so `url()`/`title()` keep falling back to them
 * until the content webContents commits a real URL.
 */
export function claimHybridDeferredLoad(windowId: number): string | null {
  const e = entries.get(windowId);
  if (!e || !e.deferredLoad || e.deferredLoad.started) return null;
  e.deferredLoad.started = true;
  return e.deferredLoad.url;
}

/**
 * Explicitly drop a hybrid window's registry entry.
 *
 * Self-cleanup is normally wired to `baseWin 'closed'` / content-wc
 * `'destroyed'` (see `registerHybridWindow`), but in Electron 40 a hybrid
 * page-host closed via `baseWin.close()` tears the BaseWindow down
 * SYNCHRONOUSLY without ever emitting `'closed'`, and leaves its main-owned
 * content `WebContents` orphaned (so `'destroyed'` never fires either). Neither
 * self-clean hook runs, so the entry would leak for the life of the process.
 * The close-finalize seam in `ipc.ts` calls this from the once-guarded hybrid
 * `'close'` handler to drop the entry deterministically (and separately
 * destroys the orphaned content wc).
 *
 * Idempotent: a no-op if `windowId` is not (or no longer) registered. Performs
 * the same teardown the self-clean closure does — cancels any pending deferred
 * blur decision and clears the active-window id if it pointed at this window.
 * It does NOT touch the content webContents; the caller owns that lifecycle.
 */
export function unregisterHybridWindow(windowId: number): void {
  const pending = pendingBlurChecks.get(windowId);
  if (pending) {
    clearImmediate(pending);
    pendingBlurChecks.delete(windowId);
  }
  entries.delete(windowId);
  // Stage B: clean up per-host load-error and pending-nav state.
  perHostLoadError.delete(windowId);
  perHostPendingNavUrl.delete(windowId);
  // Announce the teardown (e.g. deny pending permission prompts).
  notifyWindowClosed(windowId);
  if (activeHybridWindowId === windowId) {
    setActiveHybridWindowId(null);
  }
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
 * Reverse lookup: find the hybrid window whose content WebContents IS `wc`.
 * Used by the will-download cleanup to resolve a BaseWindow-hosted content WC
 * (windowFromWebContents can't — it only knows BrowserWindows) back to its host
 * so a download-trigger page-host can be closed. Returns null when no live entry
 * matches (and always null when the flag is off — the registry is empty).
 */
export function getHybridWindowByContentWC(wc: WebContents): HybridWindowEntry | null {
  for (const e of entries.values()) {
    if (e.contentWC === wc && !e.baseWin.isDestroyed()) {
      return toPublic(e);
    }
  }
  return null;
}

/**
 * Find a hybrid window opened FOR `url` (for dedup/reuse on a repeat open).
 * Matches on the normalized REQUESTED address (the static open url the window
 * was created with), trailing-slash tolerant — exactly mirroring the canvas
 * path's `findWindowByUrl`, which dedups on the stored `params.address` rather
 * than the live webview URL. Matching the requested address (not the live
 * content URL) is what makes dedup survive in-page navigation / redirects: a
 * window opened for `https://x/` that then redirects to `https://x/login`
 * still dedups a repeat open of `https://x/`. Only http(s) urls participate,
 * matching the canvas path. Returns null if none.
 */
export function findHybridWindowByUrl(url: string): HybridWindowEntry | null {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
  const target = normalizeForDedup(url);
  for (const e of entries.values()) {
    if (e.baseWin.isDestroyed()) continue;
    if (e.requestedUrl && normalizeForDedup(e.requestedUrl) === target) {
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
  for (const t of pendingBlurChecks.values()) clearImmediate(t);
  pendingBlurChecks.clear();
  entries.clear();
  activeChangeListeners.clear();
  activeHybridWindowId = null;
  isOverlayFocused = null;
  overlayWindowIdProvider = null;
}

/**
 * Test-only: synchronously run the deferred blur decision for a window WITHOUT
 * waiting for the real `setImmediate` tick. Lets a focus-free test drive the
 * exact blur→(overlay-focus?|other-hybrid?|none) sequence deterministically.
 * Returns the active id after the decision. No-op (returns current active) if
 * there is no pending blur for `windowId`.
 */
export function _runDeferredBlurForTests(windowId: number): number | null {
  const pending = pendingBlurChecks.get(windowId);
  if (pending) {
    clearImmediate(pending);
    decideAfterBlur(windowId);
  }
  return activeHybridWindowId;
}
