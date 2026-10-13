/**
 * Back/forward history snapshots — the data model, size rules and per-window
 * last-known cache that reopen (undo-close) and session restore both read.
 *
 * NAVIGATION HISTORY IS LOCAL MACHINE STATE. It is not part of any sync schema
 * and is never published on a synced topic: a trail describes one machine's
 * browsing, it is regenerated the moment the user navigates again, and the
 * entries can carry query strings and one-time URLs that have no business
 * leaving the device. It lives only in the local session row / closed-window
 * stack alongside the URL it belongs to.
 *
 * Electron-free, like `session-projection.ts` — it must load under
 * `ELECTRON_RUN_AS_NODE=1`. Nothing here imports `electron`; the webContents a
 * caller passes in is described structurally (`NavHistoryReadTarget` /
 * `NavHistoryRestoreTarget`), which is also what lets the tests drive it with
 * plain objects.
 *
 * Two rules carry the weight:
 *
 *   - WHAT IS KEPT. A kept entry is url + title and nothing else. Chromium's
 *     `pageState` blob (form values, scroll position, the serialized
 *     back/forward item) runs 2-20 KB PER ENTRY, so keeping it would inflate a
 *     session row by roughly two orders of magnitude for a trail the user
 *     mostly never walks back into.
 *
 *   - HOW MUCH IS KEPT. At most `MAX_NAV_HISTORY_ENTRIES`, chosen as a window
 *     that always contains the entry the user was actually on. Slicing the last
 *     50 and clamping the index instead points the restored window at the wrong
 *     page whenever the user had gone back past the tail at close time — the
 *     window they reopen is meant to come back on the page they left.
 *
 * The per-window cache exists because of an ordering fact about page-host
 * close: the content webContents is torn down before the close-finalize tail
 * runs, so by the time anything wants to record the trail there is nothing left
 * to read it from. The trail is therefore refreshed into this cache while the
 * window is alive, and both restore paths read the cache rather than a live
 * webContents.
 */

/** One kept history entry. No `pageState` — see the module header. */
export interface NavHistoryEntry {
  url: string;
  title: string;
}

/**
 * A trail plus the position in it the user was on — the whole payload both
 * restore paths persist and replay. `navHistoryIndex` indexes `navHistory`.
 */
export interface NavHistorySnapshot {
  navHistory: NavHistoryEntry[];
  navHistoryIndex: number;
}

/**
 * How many entries a snapshot keeps. 50 is deep enough that walking back
 * through a reopened window feels like the window that closed, and small
 * enough that a session row with a few dozen windows stays a few hundred KB
 * of url+title text.
 */
export const MAX_NAV_HISTORY_ENTRIES = 50;

/**
 * Titles are truncated at this many characters. A page can set an arbitrarily
 * long title, and a title is only ever shown as a label; 512 is past the point
 * where any surface shows more.
 */
export const MAX_NAV_TITLE_LENGTH = 512;

/**
 * A raw entry as `webContents.navigationHistory.getAllEntries()` returns it.
 * Structural on purpose: `url` is the only field that must be there, `title`
 * is read when it is a string, and everything else (notably `pageState`) is
 * dropped.
 */
export interface RawNavHistoryEntry {
  url: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * The half of a webContents the cache refresh reads. Structural so this module
 * stays Electron-free — a real `WebContents` satisfies it.
 */
export interface NavHistoryReadTarget {
  isDestroyed(): boolean;
  navigationHistory: {
    getAllEntries(): RawNavHistoryEntry[];
    getActiveIndex(): number;
  };
}

/**
 * The half of a webContents `restoreNavHistory` drives. Electron's `restore`
 * returns a promise; a test double may return nothing, which is why the return
 * type is widened.
 */
export interface NavHistoryRestoreTarget {
  isDestroyed(): boolean;
  navigationHistory: {
    restore(options: { entries: NavHistoryEntry[]; index: number }): Promise<void> | void;
  };
}

/**
 * The two fields a persisted trail rides in on. Declared for the types that
 * choose to carry it (a closed-window entry, a session descriptor, window-open
 * options) — `readNavHistory` itself takes `unknown`, because the interesting
 * callers pass a row type that predates these fields and has neither of them,
 * which a narrower parameter type rejects at compile time for no good reason.
 */
export interface NavHistoryCarrier {
  navHistory?: NavHistoryEntry[];
  navHistoryIndex?: number;
}

function truncateTitle(title: string): string {
  return title.length > MAX_NAV_TITLE_LENGTH ? title.slice(0, MAX_NAV_TITLE_LENGTH) : title;
}

/**
 * THE size rule: cap a trail at `MAX_NAV_HISTORY_ENTRIES` while keeping the
 * active entry inside the kept window.
 *
 * The window prefers the newest entries — it starts at `len - MAX`, the tail —
 * and slides back only as far as the active entry when the user had gone back
 * past that tail. So a user sitting at the front keeps the 50 most recent
 * pages, and a user 40 pages back keeps their page plus the 49 that follow it.
 * `navHistoryIndex` comes out relative to the kept window.
 *
 * `activeIndex` must already be a finite in-range index; callers normalize
 * first (`captureNavHistory` rejects, `readNavHistory` defaults).
 */
function applySizeRule(entries: NavHistoryEntry[], activeIndex: number): NavHistorySnapshot {
  if (entries.length <= MAX_NAV_HISTORY_ENTRIES) {
    return { navHistory: entries, navHistoryIndex: activeIndex };
  }
  const start = Math.min(entries.length - MAX_NAV_HISTORY_ENTRIES, activeIndex);
  return {
    navHistory: entries.slice(start, start + MAX_NAV_HISTORY_ENTRIES),
    navHistoryIndex: activeIndex - start,
  };
}

/**
 * Turn a live read of a webContents' trail into the persisted payload.
 *
 * Takes exactly what `navigationHistory.getAllEntries()` and `getActiveIndex()`
 * return. Keeps url + title only, truncates titles, and applies the size rule.
 *
 * Returns null when there is no trail worth keeping — fewer than two entries
 * (a window on its first page restores fine from its URL alone), or an index
 * that is not a finite number, which means the read cannot be trusted to point
 * anywhere.
 */
export function captureNavHistory(
  entries: readonly RawNavHistoryEntry[] | null | undefined,
  activeIndex: number,
): NavHistorySnapshot | null {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  if (typeof activeIndex !== 'number' || !Number.isFinite(activeIndex)) return null;

  const kept: NavHistoryEntry[] = entries.map((entry) => ({
    url: entry.url,
    title: truncateTitle(typeof entry.title === 'string' ? entry.title : ''),
  }));

  // An out-of-range live index would slide the window to a nonsense start, so
  // clamp it into the trail before the size rule sees it.
  const clamped = Math.min(Math.max(Math.trunc(activeIndex), 0), kept.length - 1);
  return applySizeRule(kept, clamped);
}

/**
 * Read a trail back out of a persisted row, defensively.
 *
 * Every rejected shape below is a row that really can arrive: a descriptor
 * written before this field existed (no `navHistory` at all), a hand-edited or
 * half-written row (a non-array, an entry with no url), or a row from a build
 * whose size rule differed (an over-long array, re-capped here with the same
 * window rule rather than trusted).
 *
 * A missing or out-of-range index resolves to the LAST entry: the front of the
 * trail is where a window normally sits, and it is the only position that is
 * always valid.
 *
 * Returns null whenever nothing usable is there, which callers read as "restore
 * from the URL alone".
 */
export function readNavHistory(source: unknown): NavHistorySnapshot | null {
  if (source == null || typeof source !== 'object') return null;

  const carrier = source as { navHistory?: unknown; navHistoryIndex?: unknown };
  const raw = carrier.navHistory;
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const kept: NavHistoryEntry[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') return null;
    const url = (entry as { url?: unknown }).url;
    if (typeof url !== 'string' || url === '') return null;
    const title = (entry as { title?: unknown }).title;
    kept.push({ url, title: truncateTitle(typeof title === 'string' ? title : '') });
  }

  const rawIndex = carrier.navHistoryIndex;
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex)
    && rawIndex >= 0 && rawIndex < kept.length
    ? rawIndex
    : kept.length - 1;

  return applySizeRule(kept, index);
}

/**
 * Last-known trail per window, keyed by the Electron window id — see the
 * module header for why a live read at close time is not available.
 *
 * Module state, deliberately: it mirrors the lifetime of the windows the main
 * process already tracks in module-level registries, and there is one set of
 * windows per process.
 */
const lastKnownNavHistory = new Map<number, NavHistorySnapshot>();

/**
 * Re-read a live window's trail into the cache.
 *
 * Called while the window is alive and navigating. Every failure mode leaves
 * the cache no worse than it was:
 *   - a destroyed webContents, or one that throws on either read, is ignored;
 *   - a webContents reporting ZERO entries is a window whose content has not
 *     loaded yet (a deferred restore is exactly this), so a trail seeded from
 *     a persisted row survives instead of being erased by the window that is
 *     about to replay it;
 *   - a webContents reporting ONE entry is a window that genuinely has no
 *     trail, so its cache entry goes away rather than going stale.
 */
export function refreshWindowNavHistory(windowId: number, wc: NavHistoryReadTarget | null | undefined): void {
  if (!wc) return;
  let entries: RawNavHistoryEntry[];
  let activeIndex: number;
  try {
    if (wc.isDestroyed()) return;
    entries = wc.navigationHistory.getAllEntries();
    activeIndex = wc.navigationHistory.getActiveIndex();
  } catch {
    return;
  }

  if (!Array.isArray(entries) || entries.length === 0) return;
  if (entries.length === 1) {
    lastKnownNavHistory.delete(windowId);
    return;
  }

  const captured = captureNavHistory(entries, activeIndex);
  // A trail of two-or-more that still fails to capture means an untrustworthy
  // index; leave what is cached alone rather than trade it for nothing.
  if (captured) lastKnownNavHistory.set(windowId, captured);
}

/**
 * Put a trail in the cache without a live read — the restore side of the same
 * cache. A window reopened with a persisted trail seeds it here, so a close
 * before its content ever loads still records the trail it came back with.
 *
 * A null trail clears the window's entry, so a caller threading an optional
 * `readNavHistory` result through needs no branch.
 */
export function seedWindowNavHistory(windowId: number, history: NavHistorySnapshot | null | undefined): void {
  if (!history) {
    lastKnownNavHistory.delete(windowId);
    return;
  }
  lastKnownNavHistory.set(windowId, history);
}

/** The last-known trail for a window, or null if none was ever recorded. */
export function getWindowNavHistory(windowId: number): NavHistorySnapshot | null {
  return lastKnownNavHistory.get(windowId) ?? null;
}

/** Forget a window's trail — called when the window is gone for good. */
export function clearWindowNavHistory(windowId: number): void {
  lastKnownNavHistory.delete(windowId);
}

/**
 * How a trail replay ended.
 *
 *   - `restored`: the trail was accepted and its active entry finished loading.
 *   - `refused`: the trail never went in — no target, a destroyed one, or a
 *     restore that threw or rejected before any navigation began. Nothing is
 *     loading, so the caller should fall back to a plain load of the leaf URL.
 *   - `load-failed`: the trail went in and the navigation to its active entry
 *     started, but did not finish — it failed, or a later navigation (the user
 *     pressing Back before the page loaded) superseded it. The trail is in place
 *     and the page-host's own load-failure handling owns what is shown; a
 *     fallback load here would land on top of whatever the user did next.
 */
export type NavHistoryRestoreOutcome = 'restored' | 'refused' | 'load-failed';

/**
 * Whether a rejection from `navigationHistory.restore` is the outcome of the
 * navigation it started rather than a refusal of the trail. Electron rejects a
 * started navigation that fails or is superseded with an error carrying the
 * Chromium net error number as `errno` (ERR_ABORTED is -3); a refused trail
 * rejects or throws a plain error without one.
 */
function isNavigationOutcomeError(err: unknown): boolean {
  return err != null && typeof err === 'object'
    && typeof (err as { errno?: unknown }).errno === 'number';
}

/** Replay a trail into a webContents. See `NavHistoryRestoreOutcome`. */
export async function restoreNavHistory(
  wc: NavHistoryRestoreTarget | null | undefined,
  history: NavHistorySnapshot,
): Promise<NavHistoryRestoreOutcome> {
  if (!wc) return 'refused';
  try {
    if (wc.isDestroyed()) return 'refused';
    await wc.navigationHistory.restore({
      entries: history.navHistory,
      index: history.navHistoryIndex,
    });
    return 'restored';
  } catch (err) {
    return isNavigationOutcomeError(err) ? 'load-failed' : 'refused';
  }
}
