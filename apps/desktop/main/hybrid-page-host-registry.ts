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
 * and native-fullscreen tracking are now owned by the kernel
 * (`window-kernel.ts` + `window-kernel-executor.ts`, fed via
 * `window-kernel-dispatch.ts` + `window-machine.ts`), not this registry.
 * This module owns object lifecycle/lookup/dedup only.
 */

import type { BaseWindow, WebContents } from 'electron';

// ── First-paint tracking ─────────────────────────────────────────────────────
// Whether a hybrid window's content view has settled at least one load. Read by
// session-partition.ts when projecting a host's restore state. `did-stop-loading`
// marks the window painted (first settle). Cleared on teardown.
const perHostPainted = new Set<number>();

/** Mark that `windowId` has settled at least one load (its view has painted). */
export function markHybridPainted(windowId: number): void {
  perHostPainted.add(windowId);
}

/** True once `windowId` has settled a load — i.e. it has a page to show. */
export function hasHybridPainted(windowId: number): boolean {
  return perHostPainted.has(windowId);
}

// ── Hybrid window closed-listener seam ──────────────────────────────────────
// Fires with the windowId whenever a hybrid window leaves the registry — via
// the self-clean 'closed'/'destroyed' hooks OR the explicit
// `unregisterHybridWindow` close-finalize path. Registered by
// hybrid-overlay.ts (initHybridOverlay), which routes it into
// permission-handler's `denyPendingRequestsForWindow` so a hybrid host
// closing with a permission prompt open denies (and resolves) its deferred
// Chromium callbacks. One-way dependency: this pure module never imports the
// consumer.
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
  /**
   * The address of the feature that opened this window — the namespace its
   * `key` belongs to. A key is private to its declaring feature, so two
   * features may both use `'settings'` without colliding.
   */
  source?: string;
  requestedUrl?: string;
  deferredLoad: DeferredLoad | null;
}

const entries = new Map<number, InternalEntry>();

// Active-window tracking, the focus-group model, and native-fullscreen
// tracking now live in the kernel (window-kernel.ts + window-kernel-executor.ts,
// fed via window-kernel-dispatch.ts + window-machine.ts). This module
// owns object lifecycle/lookup/dedup only.

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
    /** The opening feature's address — the namespace `key` is private to. */
    source?: string;
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
  const { baseWin, contentWC, key, source, url } = opts;
  const entry: InternalEntry = {
    windowId, baseWin, contentWC, key, source, requestedUrl: url,
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

// Maximize state (`maximized` / `preMaxBounds`) now lives on the kernel
// record (window-kernel.ts WindowRecord — §5 step 7B), driven by the
// Maximize / Unmaximize / SeedMaximized / MaximizeExitedByResize kernel
// transitions. The rationale that used to live here (frameless hosts never
// fire native 'maximize' events, so the
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
  // Per-host first-paint state.
  perHostPainted.delete(windowId);
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
 * Find a hybrid window opened with dedup `key` by the feature at `source`.
 * Mirrors the canvas path's `findWindowByKey(source, key)`: a key is the
 * per-window identity its declaring feature manages, and it is private to that
 * feature — matching on the bare key made one global space in which two
 * features using the same key string reused each other's windows.
 *
 * `source` is compared, not merely preferred, so an entry registered without
 * one is found only by a lookup that also passes none.
 */
export function findHybridWindowByKey(key: string, source?: string): HybridWindowEntry | null {
  if (!key) return null;
  for (const e of entries.values()) {
    if (e.key === key && e.source === source && !e.baseWin.isDestroyed()) {
      return toPublic(e);
    }
  }
  return null;
}

/** Test-only: clear all registry state. */
export function _resetForTests(): void {
  entries.clear();
  perHostPainted.clear();
}
