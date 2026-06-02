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
 * **No focus-steal / full click-through (this step).** The overlay is shown
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

import { BrowserWindow, BaseWindow as BaseWindowCtor, WebContentsView } from 'electron';
import type { BaseWindow } from 'electron';
import { isHeadless } from './config.js';
import { isHybridPageHost, DEBUG } from './debug-flag.js';
import {
  onActiveHybridWindowChange,
  getHybridWindow,
  getActiveHybridWindowId,
  getActiveHybridWindowBounds,
  registerHybridWindow,
  _setActiveHybridWindowForTests,
} from './hybrid-page-host-registry.js';

/**
 * Minimal placeholder chrome for P1.4b-1. A translucent top "navbar zone" bar
 * plus a thin border so a visible run shows the overlay framing the active
 * content window. Fully click-through (pointer-events:none belt-and-suspenders
 * on top of `setIgnoreMouseEvents`). REPLACED by page.js in P1.4b-2.
 */
const PLACEHOLDER_CHROME = `data:text/html,${encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;pointer-events:none;overflow:hidden}
    .frame{position:fixed;inset:0;border:1px solid rgba(120,120,255,.45);box-sizing:border-box;border-radius:8px}
    .bar{position:fixed;top:0;left:0;right:0;height:36px;background:rgba(40,40,60,.28);
         border-top-left-radius:8px;border-top-right-radius:8px;
         backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  </style></head><body><div class="frame"></div><div class="bar" id="navbar-zone"></div></body></html>`,
)}`;

let overlayWin: BrowserWindow | null = null;
let unsubscribeActive: (() => void) | null = null;

// The hybrid host window the overlay is currently following, plus its bound
// 'move'/'resize' listeners, so we can detach them when the active window
// changes (we only ever track the FRONTMOST window's geometry).
let followedBaseWin: BaseWindow | null = null;
let onFollowedMove: (() => void) | null = null;

/**
 * Lazily create the singleton overlay window. Transparent, frameless,
 * alwaysOnTop, focus-free, click-through. Headless → opacity 0. Idempotent:
 * returns the existing window if already created (and not destroyed).
 */
function ensureOverlay(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false, // never steal focus, even if something calls focus()
    skipTaskbar: true,
    alwaysOnTop: true,
    opacity: isHeadless() ? 0 : 1,
    webPreferences: {
      // Placeholder only loads a data: URL; no preload / node here. P1.4b-2
      // swaps in page.js's chrome renderer (with its tile-preload + grant).
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Float above normal windows. (P1.4b-2 may tune the level; 'floating' keeps
  // it above the content BaseWindow without sitting over OS panels.)
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch {
    /* level arg unsupported on some platforms */
  }

  // Full click-through: every pointer event passes to the content window
  // below. `forward: true` keeps move events flowing so a future chrome that
  // re-enables capture on hot zones can still receive hover. Real navbar/handle
  // click-capture is P1.4b-2.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(PLACEHOLDER_CHROME).catch((err) => {
    DEBUG && console.log('[hybrid-overlay] placeholder load failed:', err);
  });

  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  overlayWin = win;
  DEBUG && console.log('[hybrid-overlay] created singleton overlay window', win.id);
  return win;
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
    // No active hybrid window — hide the overlay (centralized show/hide, the
    // natural fix for the old per-canvas overlay-stays-visible bug 88797f2d).
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      overlayWin.hide();
    }
    return;
  }

  const entry = getHybridWindow(id);
  if (!entry || entry.baseWin.isDestroyed()) {
    // Active window vanished between signal and handling — hide.
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
    overlayState() {
      return _getOverlayStateForTests();
    },
    browserWindowCount(): number {
      return BrowserWindow.getAllWindows().length;
    },
  };
}
