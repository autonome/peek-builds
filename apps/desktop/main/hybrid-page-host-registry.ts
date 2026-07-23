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
 * **Active-window / fullscreen tracking has moved.** Front-window, active-hybrid,
 * and native-fullscreen tracking are now owned by the window-state machine
 * (`window-state.ts` + `window-os-adapter.ts` + `window-state-singleton.ts`), not
 * this registry. This module owns object lifecycle/lookup/dedup only.
 */

import type { BaseWindow, WebContents } from 'electron';

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

// ── First-paint tracking (loading card) ──────────────────────────────────────
// A hybrid window's content view shows nothing but its theme background fill
// until its FIRST load settles (fresh open, session restore, deferred-restore
// on focus) — the "black/blank screen while restoring" the user hit. The overlay
// paints a favicon+spinner loading card ONLY for that first-load window; once a
// window has painted a page, an in-page navigation keeps the old page visible,
// so covering it with a card would be a regression. `did-stop-loading` marks the
// window painted (first settle). Cleared on teardown.
const perHostPainted = new Set<number>();

/** Mark that `windowId` has settled at least one load (its view has painted). */
export function markHybridPainted(windowId: number): void {
  perHostPainted.add(windowId);
}

/** True once `windowId` has settled a load — i.e. it has a page to show, so a
 *  subsequent navigation should NOT get the opaque loading card. */
export function hasHybridPainted(windowId: number): boolean {
  return perHostPainted.has(windowId);
}

// ── Same-URL retry cap (load-error "Retry" hammering) ─────────────────────────
// Mashing Retry on a permanently-failing URL used to reload it with zero backoff
// (read as an "infinite loop"). We cap the number of consecutive Retry reloads
// of the SAME failing URL. The record is intentionally SEPARATE from the
// load-error state above, which flickers (cleared on did-start-loading, re-set
// on did-fail-load) — so a fast Retry mash that lands mid-reload can't reset the
// counter. It is cleared only by a genuine load SUCCESS (did-finish-load) or a
// DIFFERENT failing URL, and by teardown. fsm-pilled: attempt-count driven off
// the load lifecycle, no wall-clock timer.
export const HYBRID_SAME_URL_RETRY_CAP = 3;

type HybridRetryRecord = { failedUrl: string; attempts: number };
const perHostRetry = new Map<number, HybridRetryRecord>();

/**
 * Record that `failedUrl` failed to load for `windowId` (did-fail-load /
 * loading-timeout). Resets the attempt counter when the failing URL CHANGES;
 * leaves it intact when the SAME url fails again so retries keep accumulating.
 */
export function noteHybridLoadFailure(windowId: number, failedUrl: string): void {
  const rec = perHostRetry.get(windowId);
  if (!rec || rec.failedUrl !== failedUrl) {
    perHostRetry.set(windowId, { failedUrl, attempts: 0 });
  }
}

/** True when `windowId` currently has an outstanding (unresolved) load failure —
 *  i.e. a `page:reload` is a Retry of a failed URL, subject to the cap. */
export function hasHybridOutstandingFailure(windowId: number): boolean {
  return perHostRetry.has(windowId);
}

/** Increment and return the same-URL Retry attempt count for `windowId`. Callers
 *  guard with `hasHybridOutstandingFailure` first (returns 0 if none). */
export function noteHybridRetryAttempt(windowId: number): number {
  const rec = perHostRetry.get(windowId);
  if (!rec) return 0;
  rec.attempts += 1;
  return rec.attempts;
}

/** Current same-URL Retry attempt count (0 if no outstanding failure). */
export function getHybridRetryAttempts(windowId: number): number {
  return perHostRetry.get(windowId)?.attempts ?? 0;
}

/** Clear the retry record — genuine load success, or navigation elsewhere. */
export function clearHybridRetry(windowId: number): void {
  perHostRetry.delete(windowId);
}

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
  deferredLoad: DeferredLoad | null;
}

const entries = new Map<number, InternalEntry>();

// Active-window tracking, the focus-group model, and native-fullscreen
// tracking now live in the window-state machine (window-state.ts +
// window-os-adapter.ts + window-state-singleton.ts). This module owns object
// lifecycle/lookup/dedup only.

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
  };
}

/**
 * Canonical URL key for dedup matching. Mirrors the SEMANTICS of the canvas
 * path's datastore `normalizeUrl` so two opens that differ only in default
 * port, query-param order, or a trailing slash produce the same key and reuse
 * the same window: parse with `new URL()`, lowercase host, strip default ports
 * (80/443), sort query params, drop a trailing `/` on a non-root path, and drop
 * an empty query/hash. Falls back to the old string-only behavior for inputs
 * that fail to parse (e.g. non-http), so exact-string opens still always match.
 * Kept dependency-free (no datastore import) so the module stays trivially
 * unit-testable and import-safe under `ELECTRON_RUN_AS_NODE=1`.
 */
function normalizeForDedup(url: string): string {
  const raw = url.trim();
  try {
    const u = new URL(raw);
    // Lowercase host (URL already lowercases the protocol).
    u.hostname = u.hostname.toLowerCase();
    // Strip default ports.
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    // Strip a trailing slash on a non-root path.
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Sort query params so order doesn't matter; drop a lone trailing `?`.
    if (u.search) {
      const params = new URLSearchParams(u.search);
      const sorted = new URLSearchParams([...params.entries()].sort());
      u.search = sorted.toString();
    } else {
      u.search = ''; // strips a bare `?` delimiter
    }
    // Drop an empty fragment (strips a bare `#` delimiter).
    if (!u.hash) u.hash = '';
    return u.toString();
  } catch {
    // Fallback (non-parseable, e.g. non-http): old string-only behavior.
    let s = raw;
    s = s.replace(/[?#]$/, '');
    s = s.replace(/(?<!:)\/+$/, '');
    return s.toLowerCase();
  }
}

/**
 * Register a hybrid page-host window. Called ONCE from the hybrid branch in
 * `ipc.ts` right after the `BaseWindow` + content `WebContentsView` are built.
 *
 * Wires self-cleanup: the entry is dropped on the `baseWin` `'closed'` event
 * AND on the content `contentWC` `'destroyed'` event (whichever fires first),
 * so a closed hybrid window never lingers in the registry.
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
    deferredLoad: opts.deferredLoad
      ? { url: opts.deferredLoad.url, title: opts.deferredLoad.title || '', started: false }
      : null,
  };
  entries.set(windowId, entry);

  // Object lifecycle only — active-window/focus/fullscreen tracking now lives
  // in the window-state machine (see the module doc comment above).
  const cleanup = () => {
    // Only delete if this exact entry is still the one registered (guards
    // against a re-register having replaced us).
    if (entries.get(windowId) === entry) {
      entries.delete(windowId);
      // Announce the teardown (e.g. deny pending permission prompts). Inside
      // the guard so an entry already dropped by unregisterHybridWindow (which
      // notifies itself) doesn't double-fire; the listener is idempotent anyway.
      notifyWindowClosed(windowId);
    }
  };

  baseWin.once('closed', cleanup);
  contentWC.once('destroyed', cleanup);
}

/** Look up a hybrid window by host window id. Null if not a hybrid window. */
export function getHybridWindow(windowId: number): HybridWindowEntry | null {
  const e = entries.get(windowId);
  return e ? toPublic(e) : null;
}

// Maximize state (`maximized` / `preMaxBounds`) now lives on the window-state
// machine record (window-state.ts WindowRecord — §5 step 7B), driven by the
// MAXIMIZE_REQUESTED / UNMAXIMIZE_REQUESTED / MAXIMIZE_RESTORED /
// MAXIMIZE_EXITED_BY_RESIZE reducer transitions. The rationale that used to
// live here (frameless hosts never fire native 'maximize' events, so the
// app's own intent is the only deterministic signal) is documented on
// `WindowRecord.maximized`. Native-fullscreen tracking/ownership moved to the
// machine earlier (see the module doc comment above).

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
 * Idempotent: a no-op if `windowId` is not (or no longer) registered. It does
 * NOT touch the content webContents; the caller owns that lifecycle.
 */
export function unregisterHybridWindow(windowId: number): void {
  entries.delete(windowId);
  // Stage B: clean up per-host load-error and pending-nav state.
  perHostLoadError.delete(windowId);
  perHostPendingNavUrl.delete(windowId);
  // Loading-card first-paint + retry-cap per-host state.
  perHostPainted.delete(windowId);
  perHostRetry.delete(windowId);
  // Announce the teardown (e.g. deny pending permission prompts).
  notifyWindowClosed(windowId);
}

/** Every registered hybrid window. Empty when no hybrid windows exist (hybrid is the only page-host path now, not a flag-gated one). */
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
 * Returns null when no live entry matches.
 *
 * This is also the authoritative "is this WC hybrid content?" test, and the
 * will-download cleanup depends on it being authoritative.
 * `windowFromWebContents` is NOT a substitute: despite its BrowserWindow return
 * type it resolves a BaseWindow-hosted content WC to its owning BaseWindow, so it
 * answers truthy for hybrid content and cannot distinguish the two window kinds
 * (peek 02e0a4fa; see the warning on it in window-registry.ts). Only the registry
 * knows.
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
 * Matches the canonical (`normalizeForDedup`) target against BOTH keys of each
 * live entry: its static REQUESTED address AND its LIVE content URL. A match on
 * EITHER reuses the window. Matching both is what makes dedup survive in-page
 * navigation / redirects in both directions: re-opening the ORIGINAL address of
 * a window that has since redirected hits `requestedUrl`, while re-opening the
 * address the window has NAVIGATED to (SPA / server redirect) hits the live
 * content URL. Only http(s) urls participate, matching the canvas path. Returns
 * null if none.
 */
export function findHybridWindowByUrl(url: string): HybridWindowEntry | null {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
  const target = normalizeForDedup(url);
  for (const e of entries.values()) {
    if (e.baseWin.isDestroyed()) continue;
    if (e.requestedUrl && normalizeForDedup(e.requestedUrl) === target) {
      return toPublic(e);
    }
    const live = safeUrl(e.contentWC);
    if (live && normalizeForDedup(live) === target) {
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

/** Test-only: clear all registry state. */
export function _resetForTests(): void {
  entries.clear();
  perHostPainted.clear();
  perHostRetry.clear();
}
