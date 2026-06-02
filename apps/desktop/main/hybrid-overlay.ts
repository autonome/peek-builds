/**
 * Hybrid page-host shared chrome overlay (P1.4b-1).
 *
 * The hybrid page-host path (behind `PEEK_PAGEHOST_HYBRID=1`) opens each web
 * page as an opaque, content-sized `BaseWindow` + single `WebContentsView`
 * (see the HYBRID PAGE-HOST EARLY BRANCH in `ipc.ts` and
 * `docs/perf/page-host-hybrid-design.md` §2b). In the canvas era, EACH page
 * carried its OWN transparent fullscreen canvas renderer for chrome (navbar,
 * trigger zone, widgets, resize handles, panels) — 46 transparent surfaces =
 * a large WindowServer/GPU idle tax. The hybrid design collapses those into
 * **ONE** shared, transparent chrome overlay window for the whole app that
 * **retargets** over whichever hybrid content window is frontmost.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE OF THIS STEP (P1.4b-1): the overlay INFRASTRUCTURE + retarget/follow
 * mechanics ONLY. This builds the singleton transparent `alwaysOnTop` window,
 * subscribes to the registry's active-window push signal
 * (`onActiveHybridWindowChange`), frames the overlay over the active hybrid
 * window's outer bounds, follows that window's `'move'`/`'resize'`, and hides
 * on active→null. For THIS step the overlay loads a MINIMAL PLACEHOLDER (a
 * translucent top-bar + 1px border via a `data:` URL) just so a visible run
 * confirms it frames correctly.
 *
 * The REAL chrome — loading `page.js` into the overlay and wiring
 * navbar↔content via overlay → main → content webContents mediation — is
 * P1.4b-2 (see `loadChrome()` / the public surface notes at the bottom). It is
 * deliberately NOT done here.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * **Singleton.** Exactly ONE overlay `BrowserWindow` is ever created, lazily,
 * the first time a hybrid window becomes active. It is reused thereafter for
 * every active-window change — never one-per-page.
 *
 * **No focus-STEAL, but focusABLE (P1.4b-3).** The window is `focusable:true`
 * (so a user click into the navbar URL field CAN make it key — required for
 * keyboard input), but it is only ever shown via `showInactive()` and we never
 * proactively call `.focus()`/`.show()`/`.activate()`, so it still never steals
 * focus on appearance. **Full click-through (this step).** The overlay is shown
 * with `showInactive()` (never `.focus()`/`.show()`), and
 * `setIgnoreMouseEvents(true, { forward: true })` so EVERY click passes through
 * to the content window below. Real click-capture for the navbar / resize
 * handles is P1.4b-2's job (with the real chrome); for now everything passes
 * through. It stays above the content via `alwaysOnTop` + a re-raise on each
 * retarget.
 *
 * **Headless-safe.** Under `isHeadless()` the overlay is created with
 * `opacity: 0` and only ever `showInactive()`-n, never `.show()`/`.focus()`,
 * so an agent/CI run never paints a real surface on the physical desktop.
 *
 * **No-op when the flag is off.** `initHybridOverlay()` is gated on
 * `isHybridPageHost()`. With the flag off it returns immediately, subscribes
 * to nothing, and never creates a window — the canvas path is byte-identical.
 */

import { BrowserWindow, BaseWindow as BaseWindowCtor, WebContentsView, screen } from 'electron';
import type { BaseWindow, WebContents } from 'electron';
import { isHeadless, getTilePreloadPath } from './config.js';
import { isHybridPageHost, DEBUG } from './debug-flag.js';
import {
  onActiveHybridWindowChange,
  getHybridWindow,
  getActiveHybridWindowId,
  getActiveHybridWindowBounds,
  registerHybridWindow,
  getAllHybridWindows,
  _setActiveHybridWindowForTests,
} from './hybrid-page-host-registry.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { registerTrustedBuiltinWindow } from './tile-launcher.js';
import { getProfileSession } from './session-partition.js';
import { publish, subscribe, unsubscribe, getSystemAddress } from './pubsub.js';
// P1.5 test bridge only: install the REAL hybrid popup setWindowOpenHandler on
// a test content WC by calling the exact `wireHybridContentEvents` the ipc.ts
// hybrid branch uses, and read the window-registry `address` to assert a popup
// became a NEW hybrid host. ipc.ts/main.ts do NOT import hybrid-overlay, so
// this is a one-way (acyclic) dependency.
import { wireHybridContentEvents } from './ipc.js';
import { getWindowInfo } from './main.js';

/** Tile id / entry for the overlay's trustedBuiltin grant + pubsub routing. */
const OVERLAY_TILE_ID = 'page-overlay';
const OVERLAY_ENTRY_ID = 'chrome';

/** The peek:// address that resolves to renderer/page/overlay.html. */
const OVERLAY_URL = 'peek://app/page/overlay.html';

let overlayWin: BrowserWindow | null = null;
let unsubscribeActive: (() => void) | null = null;

// True once the click-capture subscription has been installed (idempotent).
let captureWired = false;

// The last click-capture state applied to the overlay window via the
// `page-overlay:set-capture` subscription (true = capturing pointer events,
// false = click-through). Exposed for focus-free test verification because
// Electron has no getter for `setIgnoreMouseEvents`.
let lastCaptureState = false;

// The hybrid host window the overlay is currently following, plus its bound
// 'move'/'resize' listeners, so we can detach them when the active window
// changes (we only ever track the FRONTMOST window's geometry).
let followedBaseWin: BaseWindow | null = null;
let onFollowedMove: (() => void) | null = null;

/**
 * Lazily create the singleton overlay window and mount the REAL shared chrome
 * (P1.4b-2). Transparent, frameless, alwaysOnTop, focus-free, click-through by
 * default. Headless → opacity 0. Idempotent: returns the existing window if
 * already created (and not destroyed).
 *
 * The overlay renderer (`renderer/page/overlay.html` + `overlay.js`) reuses the
 * existing `<peek-navbar>` Lit component and needs `api.*` (pubsub
 * publish/subscribe) to drive/reflect the active content window. So — exactly
 * like the core background / cmd / hud renderers (see `core-glue.ts`) — it runs
 * with `tile-preload.cjs` + a `createTrustedBuiltinGrant` token and is
 * registered via `registerTrustedBuiltinWindow` so the main pubsub broadcaster
 * forwards topics to it.
 */
function ensureOverlay(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  // Mint a trustedBuiltin token so every tile:* IPC (incl. pubsub) the overlay
  // invokes bypasses capability enforcement — it is trusted core chrome.
  const grant = createTrustedBuiltinGrant(OVERLAY_TILE_ID);
  const token = generateToken(OVERLAY_TILE_ID, OVERLAY_ENTRY_ID, grant);
  const tilePreloadPath = getTilePreloadPath();

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    // P1.4b-3: focusable MUST be true. A `focusable:false` window can never
    // become key on macOS, so the navbar URL input could not receive keyboard
    // focus — typing a URL into the overlay was broken. We keep it focusable so
    // a USER CLICK into the URL field can focus it, but never proactively call
    // `.focus()`/`.show()`/`.activate()`: the overlay still only ever appears
    // via `showInactive()` (see `frameBounds`), so it never STEALS focus on
    // appearance — it can only take focus on explicit user interaction.
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    opacity: isHeadless() ? 0 : 1,
    webPreferences: {
      // Same mechanics as the other core renderers: tile-preload + token in
      // additionalArguments, profile session for storage parity.
      contextIsolation: true,
      sandbox: true,
      preload: tilePreloadPath,
      session: getProfileSession(),
      additionalArguments: [
        `--tile-id=${OVERLAY_TILE_ID}`,
        `--tile-entry=${OVERLAY_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  });

  // Register with the tile launcher so the pubsub broadcaster forwards messages
  // to this window (without this, `api.subscribe` in overlay.js never fires).
  registerTrustedBuiltinWindow(OVERLAY_TILE_ID, OVERLAY_ENTRY_ID, win, token);

  // Float above normal windows. ('floating' keeps it above the content
  // BaseWindow without sitting over OS panels.)
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch {
    /* level arg unsupported on some platforms */
  }

  // Default click-through: every pointer event passes to the content window
  // below. `forward: true` keeps move events flowing so the overlay renderer's
  // pointer enter/leave handlers fire over the (otherwise click-through) chrome
  // layer — that's how it knows to ask main to enable capture (see
  // `wireClickCapture`). Real navbar/handle interaction toggles this off/on.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(OVERLAY_URL).catch((err) => {
    DEBUG && console.log('[hybrid-overlay] overlay chrome load failed:', err);
  });

  // First-paint race: the renderer subscribes to `page-overlay:active` only
  // after its module loads, which is AFTER the first `retarget()` may have
  // already published the handoff. Re-send the current active state once the
  // renderer has finished loading (and on every reload) so the navbar paints.
  win.webContents.on('did-finish-load', () => {
    const currentId = getActiveHybridWindowId();
    if (currentId != null) sendActiveHandoff(currentId);
  });

  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  overlayWin = win;
  DEBUG && console.log('[hybrid-overlay] created singleton overlay window', win.id);
  return win;
}

/**
 * Push the active-window handoff to the overlay renderer: which `windowId` is
 * now active, plus a snapshot of its current url / title / nav-state / loading
 * so the navbar can paint instantly with no flash of the previous window's
 * state. Passing `null` clears + hides the chrome. Published on the system
 * address — the overlay is the only subscriber to `page-overlay:active`, so the
 * broadcast is effectively directed.
 */
function sendActiveHandoff(id: number | null): void {
  if (id == null) {
    publish(getSystemAddress(), 'page-overlay:active', null);
    return;
  }
  const entry = getHybridWindow(id);
  if (!entry) {
    publish(getSystemAddress(), 'page-overlay:active', null);
    return;
  }
  const wc: WebContents = entry.contentWC;
  let canGoBack = false;
  let canGoForward = false;
  let loading = false;
  try {
    if (!wc.isDestroyed()) {
      canGoBack = wc.navigationHistory.canGoBack();
      canGoForward = wc.navigationHistory.canGoForward();
      loading = wc.isLoading();
    }
  } catch {
    /* wc torn down between active-change and snapshot */
  }
  // P1.4b-3: include the host window's current outer bounds so the overlay's
  // resize/move chrome can seed its drag math (page.js tracks `screenBounds`
  // locally; the hybrid overlay seeds the same from the handoff). Safe-guarded
  // because the baseWin may be torn down between active-change and snapshot.
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  try {
    if (!entry.baseWin.isDestroyed()) bounds = entry.baseWin.getBounds();
  } catch {
    /* baseWin gone */
  }
  publish(getSystemAddress(), 'page-overlay:active', {
    windowId: id,
    url: entry.url(),
    title: entry.title(),
    canGoBack,
    canGoForward,
    loading,
    bounds,
  });
}

/**
 * Subscribe (once) to the overlay renderer's click-capture toggle. When the
 * pointer is over an interactive chrome region (navbar / trigger zone) the
 * renderer publishes `{capture:true}`; main flips the overlay window to CAPTURE
 * pointer events (`setIgnoreMouseEvents(false)`). When the pointer leaves chrome
 * it publishes `{capture:false}` and we restore click-through
 * (`setIgnoreMouseEvents(true,{forward:true})`) so the content window below
 * stays fully interactive everywhere the chrome isn't.
 */
function wireClickCapture(): void {
  if (captureWired) return;
  captureWired = true;
  subscribe(getSystemAddress(), 'page-overlay:set-capture', (raw) => {
    const msg = raw as { capture?: boolean } | null;
    const capture = !!(msg && msg.capture);
    lastCaptureState = capture;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (capture) {
      overlayWin.setIgnoreMouseEvents(false);
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
    }
  });
}

/** Stop following the currently-followed host window (detach move/resize). */
function unfollow(): void {
  if (followedBaseWin && onFollowedMove && !followedBaseWin.isDestroyed()) {
    try {
      followedBaseWin.removeListener('move', onFollowedMove);
      followedBaseWin.removeListener('resize', onFollowedMove);
    } catch {
      /* listener already gone */
    }
  }
  followedBaseWin = null;
  onFollowedMove = null;
}

/**
 * Position + size the overlay to FRAME the given bounds (full-frame for now),
 * then raise it above the content window. Focus-free.
 */
function frameBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  const win = ensureOverlay();
  if (win.isDestroyed()) return;
  // setBounds in one shot avoids an intermediate paint (R2: no double-paint /
  // flicker on retarget).
  win.setBounds(bounds);

  // Raise above the content window WITHOUT taking focus. Toggling alwaysOnTop
  // re-asserts the floating level above any window that may have come forward.
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch {
    /* level arg unsupported */
  }

  // showInactive: visible but never focused. Headless keeps opacity 0 so this
  // paints nothing on the physical desktop.
  if (!win.isVisible()) {
    win.showInactive();
  } else {
    // Already visible: re-raise above the now-frontmost content window.
    try {
      win.moveTop();
    } catch {
      /* moveTop unsupported on some platforms */
    }
  }
}

/**
 * Retarget the overlay onto a newly-active hybrid window (or hide on null).
 * Detaches follow-listeners from the previous window and attaches to the new
 * one so we only ever track the frontmost window's geometry.
 */
function retarget(id: number | null): void {
  unfollow();

  if (id == null) {
    // No active hybrid window — clear the overlay chrome, then hide the window
    // (centralized show/hide, the natural fix for the old per-canvas
    // overlay-stays-visible bug 88797f2d).
    sendActiveHandoff(null);
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      overlayWin.hide();
    }
    return;
  }

  const entry = getHybridWindow(id);
  if (!entry || entry.baseWin.isDestroyed()) {
    // Active window vanished between signal and handling — clear + hide.
    sendActiveHandoff(null);
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      overlayWin.hide();
    }
    return;
  }

  const baseWin = entry.baseWin;

  // Initial frame.
  const initial = getActiveHybridWindowBounds();
  if (initial) frameBounds(initial);

  // Follow the active window's move/resize. We re-read getBounds() each time
  // (rather than the event payload) so the overlay matches the window's true
  // current outer bounds even if multiple move/resize events coalesce.
  const follow = () => {
    if (baseWin.isDestroyed()) return;
    try {
      frameBounds(baseWin.getBounds());
    } catch {
      /* window torn down mid-move */
    }
  };
  baseWin.on('move', follow);
  baseWin.on('resize', follow);
  followedBaseWin = baseWin;
  onFollowedMove = follow;

  // Tell the overlay renderer which window is now active + a state snapshot so
  // it fully swaps its navbar for the new window (instant paint, no flash).
  // The renderer may not be loaded yet on the very first retarget; in that case
  // overlay.js seeds nothing — but it also subscribes synchronously at module
  // load, and the broadcaster only delivers to already-subscribed windows, so a
  // re-send after did-finish-load guarantees the first paint. We re-send below
  // for that race.
  sendActiveHandoff(id);

  DEBUG && console.log('[hybrid-overlay] retargeted onto hybrid window', id);
}

/**
 * Start the shared-overlay manager: subscribe to the registry's active-window
 * push signal so the overlay retargets/follows as the frontmost hybrid window
 * changes. Gated on `isHybridPageHost()` — a no-op (no window, no subscription)
 * when the flag is off. Idempotent: a second call while already initialized is
 * ignored.
 *
 * Wire this from the main-process setup path that runs once the hybrid feature
 * is active (see `ipc.ts` `registerAllHandlers` / `entry.ts onReady`).
 */
export function initHybridOverlay(): void {
  if (!isHybridPageHost()) return;
  if (unsubscribeActive) return; // already initialized

  // Subscribe to the overlay renderer's click-capture toggle before any window
  // exists — the subscription is on the main pubsub registry, independent of
  // the overlay window's lifetime.
  wireClickCapture();

  unsubscribeActive = onActiveHybridWindowChange((id) => {
    try {
      retarget(id);
    } catch (err) {
      DEBUG && console.log('[hybrid-overlay] retarget failed:', err);
    }
  });

  // E2E test bridge: expose the focus-free verification surface on a global so
  // a Playwright `evaluateMain` can drive active-window changes synthetically
  // (no real OS focus) and read the overlay's resulting state. Gated on
  // E2E_TEST so it never installs in a normal run.
  if (process.env.E2E_TEST === 'true') {
    installTestBridge();
  }

  // Seed off the current active window in case one is already frontmost at
  // init time (e.g. session restore opened a hybrid window before this ran).
  const currentId = getActiveHybridWindowId();
  if (currentId != null) {
    retarget(currentId);
  }
  DEBUG && console.log('[hybrid-overlay] initialized (subscribed to active-window changes)');
}

/**
 * Tear down the overlay manager: unsubscribe, detach follow-listeners, and
 * destroy the singleton window. Self-contained; safe to call when never
 * initialized. (Not currently wired to any lifecycle hook — the overlay lives
 * for the app's lifetime, like the old chrome — but provided for completeness
 * and test isolation.)
 */
export function teardownHybridOverlay(): void {
  if (unsubscribeActive) {
    unsubscribeActive();
    unsubscribeActive = null;
  }
  unfollow();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
  }
  overlayWin = null;
  // Drop the click-capture subscription so a later re-init re-wires cleanly.
  try {
    unsubscribe(getSystemAddress(), 'page-overlay:set-capture');
  } catch {
    /* never throw on teardown */
  }
  captureWired = false;
}

/**
 * Test-only: read the singleton overlay's state for focus-free verification.
 * Returns null if no overlay window has been created yet.
 */
export function _getOverlayStateForTests():
  | {
      id: number;
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      alwaysOnTop: boolean;
    }
  | null {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  return {
    id: overlayWin.id,
    visible: overlayWin.isVisible(),
    bounds: overlayWin.getBounds(),
    alwaysOnTop: overlayWin.isAlwaysOnTop(),
  };
}

/**
 * E2E-only: install a focus-free verification bridge on `globalThis`. A
 * Playwright `evaluateMain` (which runs in the main process but cannot import
 * our ESM modules directly) reaches these through the global. Everything here
 * drives the registry/overlay SYNTHETICALLY — no real OS focus is ever taken.
 *
 *   makeFakeHybridWindow({x,y,width,height}) → number
 *       Creates a real headless BaseWindow + WebContentsView (opacity 0, never
 *       shown/focused), registers it as a hybrid window, returns its id.
 *   setActive(id|null) → boolean
 *       Calls `_setActiveHybridWindowForTests` (sets active id + fires the push
 *       signal the overlay listens to). No focus change.
 *   setHostBounds(id, {x,y,width,height}) → boolean
 *       Programmatically resizes/moves a fake host's BaseWindow (fires its
 *       'move'/'resize' so the overlay's follow logic runs).
 *   overlayState() → {id,visible,bounds,alwaysOnTop} | null
 *   browserWindowCount() → number   (to assert the singleton)
 */
function installTestBridge(): void {
  const fakeHosts = new Map<number, BaseWindow>();
  (globalThis as Record<string, unknown>).__peekHybridOverlayTest = {
    makeFakeHybridWindow(bounds: { x: number; y: number; width: number; height: number }): number {
      const baseWin = new BaseWindowCtor({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        show: false,
        opacity: 0,
      });
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, sandbox: true },
      });
      baseWin.contentView.addChildView(view);
      // Fill the view to the window's content size (matches the real hybrid
      // path's fillView). Without non-zero view bounds the content has no
      // layout, so findInPage would report 0 matches.
      try {
        const [w, h] = baseWin.getContentSize();
        view.setBounds({ x: 0, y: 0, width: w, height: h });
      } catch { /* getContentSize unsupported in some envs */ }
      registerHybridWindow(baseWin.id, { baseWin, contentWC: view.webContents });
      fakeHosts.set(baseWin.id, baseWin);
      return baseWin.id;
    },
    setActive(id: number | null): boolean {
      return _setActiveHybridWindowForTests(id);
    },
    setHostBounds(
      id: number,
      bounds: { x: number; y: number; width: number; height: number },
    ): boolean {
      const w = fakeHosts.get(id);
      if (!w || w.isDestroyed()) return false;
      w.setBounds(bounds);
      return true;
    },
    /**
     * P1.4b-3: read a fake host BaseWindow's current OUTER bounds. Used to
     * assert that a published `page:set-bounds` / `page:maximize` /
     * `page:unmaximize` intent actually moved/resized the content window.
     */
    hostBounds(id: number): { x: number; y: number; width: number; height: number } | null {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return null;
      try {
        return entry.baseWin.getBounds();
      } catch {
        return null;
      }
    },
    /**
     * P1.4b-3: the work area of the display the given host currently sits on.
     * Maximize snaps the host to exactly this rect, so the maximize test can
     * compare `hostBounds(id)` against it (the hybrid path maximizes via explicit
     * work-area bounds, not native `maximize()`, so `isMaximized()` is unreliable
     * for frameless windows — same reason page.js sets work-area bounds directly).
     */
    hostWorkArea(id: number): { x: number; y: number; width: number; height: number } | null {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return null;
      try {
        const b = entry.baseWin.getBounds();
        const display = screen.getDisplayNearestPoint({
          x: b.x + Math.floor(b.width / 2),
          y: b.y + Math.floor(b.height / 2),
        });
        return display.workArea;
      } catch {
        return null;
      }
    },
    overlayState() {
      return _getOverlayStateForTests();
    },
    /**
     * P1.4b-3: read the overlay window's focusABLE / focusED state directly off
     * the singleton (focus-free assertion). The overlay must be focusable:true
     * (so a click into the URL field can make it key) yet never focused on
     * appearance (shown via showInactive, nothing proactively focuses it).
     */
    overlayFocus(): { focusable: boolean; focused: boolean } | null {
      if (!overlayWin || overlayWin.isDestroyed()) return null;
      try {
        return { focusable: overlayWin.isFocusable(), focused: overlayWin.isFocused() };
      } catch {
        return null;
      }
    },
    browserWindowCount(): number {
      return BrowserWindow.getAllWindows().length;
    },
    /**
     * Load a URL into a fake hybrid window's content webContents (so tests can
     * exercise the navbar→content navigate/back/forward/reload routing against
     * a real WebContents). Returns a promise that resolves once loaded.
     */
    loadFakeContent(id: number, url: string): Promise<boolean> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(false);
      return entry.contentWC
        .loadURL(url)
        .then(() => true)
        .catch(() => false);
    },
    /** The current live URL of a fake hybrid window's content webContents. */
    contentUrl(id: number): string {
      const entry = getHybridWindow(id);
      return entry ? entry.url() : '';
    },
    /**
     * P1.4b-4: drive find-in-page end-to-end via the SAME pubsub path the
     * overlay find bar uses — publish `page:find-exec {windowId, text}` (which
     * installHybridNavbarActionRouting routes to contentWC.findInPage) and
     * resolve with the content WC's first `found-in-page` result. Proves the
     * publish → main-routing → findInPage chain hits the right content WC.
     * Resolves null on timeout / no live content. Focus-free (no OS focus).
     */
    findInContent(id: number, text: string): Promise<{ matches: number; activeMatchOrdinal: number } | null> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(null);
      const wc = entry.contentWC;
      return new Promise((resolve) => {
        let done = false;
        // Electron fires found-in-page multiple times per search (preliminary
        // results then a `finalUpdate:true`); resolve on the final one so the
        // match count is settled.
        const onFound = (_e: Electron.Event, result: Electron.Result) => {
          if (done || !result.finalUpdate) return;
          done = true;
          clearTimeout(timer);
          try { wc.off('found-in-page', onFound); } catch { /* gone */ }
          resolve({ matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { wc.off('found-in-page', onFound); } catch { /* gone */ }
          resolve(null);
        }, 3000);
        wc.on('found-in-page', onFound);
        publish(getSystemAddress(), 'page:find-exec', { windowId: id, text, options: {} });
      });
    },
    /**
     * P1.4b-4: publish the routed `page:find-next` topic and resolve with the
     * content WC's next `found-in-page` result (proves next advances the active
     * match via main → findInPage({forward:true,findNext:true})). Requires a
     * prior findInContent so main has the last-search text for this window.
     */
    nextFindAndWait(id: number): Promise<{ matches: number; activeMatchOrdinal: number } | null> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(null);
      const wc = entry.contentWC;
      return new Promise((resolve) => {
        let done = false;
        const onFound = (_e: Electron.Event, result: Electron.Result) => {
          if (done || !result.finalUpdate) return;
          done = true;
          clearTimeout(timer);
          try { wc.off('found-in-page', onFound); } catch { /* gone */ }
          resolve({ matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { wc.off('found-in-page', onFound); } catch { /* gone */ }
          resolve(null);
        }, 3000);
        wc.on('found-in-page', onFound);
        publish(getSystemAddress(), 'page:find-next', { windowId: id });
      });
    },
    /** P1.4b-4: stop find-in-page via the routed `page:find-stop` topic. */
    stopFindInContent(id: number): void {
      publish(getSystemAddress(), 'page:find-stop', { windowId: id });
    },
    /** Whether a fake hybrid window's content can go back (post-navigation). */
    contentCanGoBack(id: number): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return false;
      try {
        return entry.contentWC.navigationHistory.canGoBack();
      } catch {
        return false;
      }
    },
    /**
     * Read the overlay navbar's painted chrome state from the renderer DOM.
     * Resolves null if no overlay window / renderer not ready. Focus-free:
     * pure executeJavaScript, no OS focus.
     */
    overlayChromeState(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const nb = document.getElementById('navbar');
            if (!nb) return null;
            const input = nb.shadowRoot && nb.shadowRoot.querySelector('.url-text');
            const findBar = document.getElementById('find-bar');
            const findCount = document.getElementById('find-count');
            const findInput = document.getElementById('find-input');
            return {
              ready: window.__overlayReady === true,
              noActive: document.body.classList.contains('no-active'),
              navbarVisible: nb.classList.contains('visible'),
              url: nb.url || '',
              inputValue: input ? input.value : null,
              canGoBack: !!nb.canGoBack,
              canGoForward: !!nb.canGoForward,
              loading: !!nb.loading,
              pageTitle: nb.pageTitle || '',
              favicon: nb.favicon || '',
              findVisible: document.body.classList.contains('find-visible'),
              findCount: findCount ? findCount.textContent : '',
              findInputValue: findInput ? findInput.value : null,
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Synthetically toggle click-capture by publishing the same topic the
     * renderer would, then read back the overlay window's ignore-mouse state via
     * the structural assertion the test makes. (We can't read ignoreMouseEvents
     * directly off BrowserWindow in Electron, so the test asserts the publish
     * path drives setIgnoreMouseEvents by checking it does not throw + the
     * subscription exists; the renderer-driven path is covered separately.)
     */
    publishCapture(capture: boolean): void {
      publish(getSystemAddress(), 'page-overlay:set-capture', { capture });
    },
    /** The last click-capture state applied to the overlay window. */
    captureState(): boolean {
      return lastCaptureState;
    },
    /**
     * Publish an arbitrary `page:*` topic on the system address (the same path
     * the overlay renderer / HUD use). Lets the navbar→content + content→chrome
     * mediation be exercised from a test without resolving the pubsub module by
     * path inside `electronApp.evaluate`.
     */
    publishTopic(topic: string, msg: unknown): void {
      publish(getSystemAddress(), topic, msg);
    },
    /**
     * P1.5: create a hybrid page-host whose content WC has the REAL popup
     * `setWindowOpenHandler` under test installed by `wireHybridContentEvents`
     * (the same code the ipc.ts hybrid EARLY BRANCH calls). We build the
     * BaseWindow+WebContentsView exactly like `makeFakeHybridWindow`, register
     * it, then call the exported `wireHybridContentEvents` so the popup handler
     * is wired, and load a `data:` opener (deterministic, network-free). Returns
     * the new hybrid window id. Focus-free (opacity 0, never shown).
     */
    makeWiredHybrid(dataUrl: string): Promise<number | null> {
      const baseWin = new BaseWindowCtor({
        x: 100, y: 100, width: 600, height: 400, frame: false, show: false, opacity: 0,
      });
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, sandbox: true },
      });
      baseWin.contentView.addChildView(view);
      try {
        const [w, h] = baseWin.getContentSize();
        view.setBounds({ x: 0, y: 0, width: w, height: h });
      } catch { /* getContentSize unsupported in some envs */ }
      registerHybridWindow(baseWin.id, { baseWin, contentWC: view.webContents });
      // Install the popup handler under test (+ the other wired events). This
      // is the EXACT function the real hybrid branch calls.
      wireHybridContentEvents(view.webContents, baseWin.id, dataUrl, {});
      return view.webContents
        .loadURL(dataUrl)
        .then(() => baseWin.id)
        .catch(() => baseWin.id);
    },
    /**
     * P1.5: trigger a scripted `window.open(popupUrl)` INSIDE a hybrid window's
     * content webContents. This exercises the real `setWindowOpenHandler`
     * installed by `wireHybridContentEvents`. Returns true if the script ran.
     */
    triggerWindowOpen(id: number, popupUrl: string): Promise<boolean> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(false);
      return entry.contentWC
        .executeJavaScript(`(() => { window.open(${JSON.stringify(popupUrl)}, '_blank'); return true; })()`)
        .then(() => true)
        .catch(() => false);
    },
    /**
     * P1.5: trigger a `target="_blank"` link click inside a hybrid window's
     * content webContents (the other path into setWindowOpenHandler). Returns
     * true if the script ran.
     */
    triggerBlankLinkClick(id: number, popupUrl: string): Promise<boolean> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(false);
      return entry.contentWC
        .executeJavaScript(
          `(() => {
            const a = document.createElement('a');
            a.href = ${JSON.stringify(popupUrl)};
            a.target = '_blank';
            a.textContent = 'open';
            document.body.appendChild(a);
            a.click();
            return true;
          })()`,
        )
        .then(() => true)
        .catch(() => false);
    },
    /**
     * P1.5: wait until a NEW hybrid page-host whose REQUESTED address (window
     * registry `address` param, set by the ipc.ts hybrid branch) equals `url`
     * appears — and is NOT in the `excludeIds` set. Network-free: matches on the
     * requested address, not the (possibly-pending) live content URL. Resolves
     * its id, or null on timeout.
     */
    waitHybridForUrl(url: string, excludeIds: number[] = [], timeoutMs = 8000): Promise<number | null> {
      const excluded = new Set(excludeIds);
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
          const match = getAllHybridWindows().find((e) => {
            if (excluded.has(e.windowId)) return false;
            const info = getWindowInfo(e.windowId);
            const addr = info ? (info.params?.address as string | undefined) : undefined;
            return addr === url || (e.url() && e.url().startsWith(url));
          });
          if (match) return resolve(match.windowId);
          if (Date.now() > deadline) return resolve(null);
          setTimeout(poll, 50);
        };
        poll();
      });
    },
    /** P1.5: count of currently-registered hybrid page-host windows. */
    hybridCount(): number {
      return getAllHybridWindows().length;
    },
    /** P1.5: ids of every currently-registered hybrid page-host window. */
    hybridIds(): number[] {
      return getAllHybridWindows().map((e) => e.windowId);
    },
    /**
     * P1.5: the REQUESTED address (window-registry `address` param) of every
     * registered hybrid window — the URL the hybrid branch was asked to open,
     * independent of whether the live content load has resolved.
     */
    hybridAddresses(): string[] {
      return getAllHybridWindows()
        .map((e) => {
          const info = getWindowInfo(e.windowId);
          return info ? ((info.params?.address as string) || '') : '';
        })
        .filter(Boolean);
    },
  };
}
