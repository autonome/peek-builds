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

import { app, BrowserWindow, BaseWindow as BaseWindowCtor, WebContentsView, screen } from 'electron';
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
  setOverlayFocusProvider,
  getActiveHybridWindowId as _getActiveHybridWindowIdForBridge,
  _setActiveHybridWindowForTests,
  _runDeferredBlurForTests,
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
import { getWindowPresentation } from './window-presenter.js';

/** Tile id / entry for the overlay's trustedBuiltin grant + pubsub routing. */
const OVERLAY_TILE_ID = 'page-overlay';
const OVERLAY_ENTRY_ID = 'chrome';

/** The peek:// address that resolves to renderer/page/overlay.html. */
const OVERLAY_URL = 'peek://app/page/overlay.html';

// ── Canvas gutter geometry (the SPEC) ────────────────────────────────────────
// The old canvas era framed ONE transparent window whose outer bounds were the
// content rect EXPANDED by a margin: the `<webview>` was inset, and the chrome
// (navbar at top, trigger zone, resize handles at the edges, side panels +
// widgets in the left/right gutters) lived in that surrounding margin. See
// `ipc.ts` (CANVAS_MARGIN / CANVAS_TRIGGER_ZONE / CANVAS_NAVBAR_HEIGHT, the
// window-expansion the canvas branch applied) and `renderer/page/page.js`
// (`computeWindowBounds`/`updatePositions`, where `extraWidth` widens the window
// so the overhanging side panels have gutter space).
//
// The hybrid path splits that into TWO windows: an OPAQUE content `BaseWindow`
// sized to the INNER content rect, and this transparent overlay framed over it.
// To reproduce the canvas look the overlay must be the content rect expanded by
// the SAME margins so the chrome renders in the gutter AROUND the content (and
// the center stays transparent so the content window shows through).
//
// These mirror the canvas constants 1:1 (do NOT invent new values):
//   MARGIN          = CANVAS_MARGIN            (8px resize-handle margin)
//   TRIGGER_ZONE    = CANVAS_TRIGGER_ZONE      (8px hover strip above the navbar)
//   NAVBAR_HEIGHT   = CANVAS_NAVBAR_HEIGHT     (36px reserved navbar band)
//   PANEL_WIDTH     = page.js PANEL_WIDTH      (280px side-panel width)
//   PANEL_OVERLAP   = page.js PANEL_OVERLAP    (70px = 25% overlaps the content)
//   PANEL_OVERHANG  = page.js PANEL_OVERHANG   (210px extends into the gutter)
// The left/right gutter is `MARGIN + PANEL_OVERHANG` wide — exactly the canvas's
// `extraWidth/2 + MARGIN` per side when both side stacks are shown — so a 280px
// panel that overlaps the content edge by 70px fits the gutter without clipping.
const MARGIN = 8;
const TRIGGER_ZONE = 8;
const NAVBAR_HEIGHT = 36;
const PANEL_WIDTH = 280;
const PANEL_OVERLAP = PANEL_WIDTH * 0.25; // 70
const PANEL_OVERHANG = PANEL_WIDTH - PANEL_OVERLAP; // 210

/** Per-side insets from the overlay frame to the inner content rect. */
const GUTTER_LEFT = MARGIN + PANEL_OVERHANG; // 218
const GUTTER_RIGHT = MARGIN + PANEL_OVERHANG; // 218
const GUTTER_TOP = TRIGGER_ZONE + NAVBAR_HEIGHT; // 44
const GUTTER_BOTTOM = MARGIN; // 8

/**
 * Expand an inner content rect (the content `BaseWindow`'s outer bounds) into
 * the overlay's frame: the content rect grown by the canvas gutters so the
 * chrome has margin to render in AROUND the content. The inner content rect is
 * recovered by the renderer (and tests) by subtracting `GUTTER_LEFT`/`GUTTER_TOP`
 * back off — the renderer is told the gutters via the active handoff so its
 * layout stays a pure function of the content rect.
 */
function expandToOverlayFrame(content: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  // Maximized parity (mirrors the canvas): a window snapped to its display work
  // area gets NO gutter — the chrome renders edge-to-edge over the content, and
  // expanding by gutters would push the overlay off-screen. Detect it by
  // comparing the content rect to the nearest display's work area.
  try {
    const display = screen.getDisplayNearestPoint({
      x: content.x + Math.floor(content.width / 2),
      y: content.y + Math.floor(content.height / 2),
    });
    const wa = display.workArea;
    if (
      content.x === wa.x &&
      content.y === wa.y &&
      content.width === wa.width &&
      content.height === wa.height
    ) {
      return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
    }
  } catch {
    /* screen unavailable in some test envs — fall through to gutter expand */
  }
  return {
    x: Math.round(content.x - GUTTER_LEFT),
    y: Math.round(content.y - GUTTER_TOP),
    width: Math.round(content.width + GUTTER_LEFT + GUTTER_RIGHT),
    height: Math.round(content.height + GUTTER_TOP + GUTTER_BOTTOM),
  };
}

/** The gutter insets — published to the overlay renderer so it can place the
 * transparent content hole + chrome relative to the inner content rect, and read
 * by tests to assert the expanded frame. */
const OVERLAY_GUTTERS = {
  left: GUTTER_LEFT,
  right: GUTTER_RIGHT,
  top: GUTTER_TOP,
  bottom: GUTTER_BOTTOM,
} as const;

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

// ── R1 app-active gate ──────────────────────────────────────────────────────
// Whether THE APP (Electron) is currently the frontmost (active) application.
// The overlay is a transparent `alwaysOnTop:'floating'` window that, when Peek
// is backgrounded, can float OVER another app AND — because overlay.js drives
// `setCapture(true)` from forwarded `mousemove`s over the chrome band — capture
// a click meant for that other app (activating Electron and swallowing the
// click). The app-active gate forces the overlay click-through + drops its
// floating level whenever the app resigns active, so it can neither capture nor
// float over other apps; on become-active we restore the floating + default
// click-through and re-frame onto the current active hybrid window. We seed it
// true (the app is normally active at init); `app.isActive?.()` is consulted
// where available as a belt-and-suspenders read. Listeners are installed only
// behind `isHybridPageHost()` (see initHybridOverlay), so this is dead state on
// the canvas path.
let appActive = true;
// The bound resign/become handlers, kept so teardown can detach them.
let onAppResignActive: (() => void) | null = null;
let onAppBecomeActive: (() => void) | null = null;

// R3 test-observability: how many times the `page:show-navbar` handler actually
// called `overlayWin.focus()` (i.e. passed the app-active + active-window gates).
// On macOS-headless `.focus()` does not grant real OS focus (no virtual
// display), so `isFocused()` can't be asserted; this counter lets a focus-free
// test verify the focus INTENT fired exactly when gated correctly (and never
// when backgrounded / for a foreign window — the R1 interaction guard).
let showNavbarFocusCount = 0;

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
    // Drop the focus provider so the registry stops consulting a dead window.
    setOverlayFocusProvider(null);
  });

  // Focus-group: tell the registry how to learn whether THIS overlay window is
  // focused. The registry's deferred content-blur decision consults this so a
  // click into the overlay (navbar URL field, panels, handles) — which blurs the
  // content BaseWindow and focuses the overlay — does NOT deactivate the content
  // window. Without this, interacting with the chrome instantly closes it.
  setOverlayFocusProvider(() => {
    try {
      return !win.isDestroyed() && win.isFocused();
    } catch {
      return false;
    }
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
    // The INNER content rect (content BaseWindow outer bounds). The renderer
    // places the transparent content hole + chrome relative to this, insetting
    // it by the gutters below — so the overlay center sits exactly over the
    // content window and the chrome lives in the surrounding margin.
    bounds,
    gutters: OVERLAY_GUTTERS,
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
    // R1: while the app is backgrounded, NEVER honor a capture request. The
    // renderer's mousemove→setCapture loop fires from forwarded moves even while
    // the pointer is working in another app beneath the floating overlay; if we
    // turned the overlay opaque then, the next click would hit it (activating
    // Electron and swallowing the click meant for the other app). Force
    // click-through until the app is active again (become-active restores it).
    const capture = !!(msg && msg.capture) && appActive;
    lastCaptureState = capture;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (capture) {
      overlayWin.setIgnoreMouseEvents(false);
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
    }
  });
}

/**
 * R1: install the app-active gate. When Electron resigns active (the user
 * clicks into ANOTHER app), the floating overlay must neither capture pointer
 * events nor float above the other app — otherwise a click in the other app
 * lands on the (then-opaque) overlay, activates Electron, and is swallowed. On
 * resign-active we force the overlay click-through AND drop its always-on-top
 * level; on become-active we restore the floating level + default forwarded
 * click-through and re-frame onto the current active hybrid window so the
 * overlay snaps back over it. Idempotent: a second call is a no-op. Every
 * overlayWin access is guarded with isDestroyed().
 */
function wireAppActiveGate(): void {
  if (onAppResignActive || onAppBecomeActive) return;

  onAppResignActive = () => {
    appActive = false;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    try {
      // Force click-through (no forwarding either — we don't want the renderer's
      // mousemove loop to fire while we're backgrounded), so no click over the
      // overlay can hit it / activate Electron.
      overlayWin.setIgnoreMouseEvents(true, { forward: false });
      lastCaptureState = false;
    } catch {
      /* setIgnoreMouseEvents unsupported in some envs */
    }
    try {
      // Drop the floating level so the overlay no longer sits above other apps.
      overlayWin.setAlwaysOnTop(false);
    } catch {
      /* level arg unsupported on some platforms */
    }
  };

  onAppBecomeActive = () => {
    appActive = true;
    if (!overlayWin || overlayWin.isDestroyed()) {
      // No overlay yet — re-frame below will lazily create it if there is an
      // active hybrid window.
      const currentId = getActiveHybridWindowId();
      if (currentId != null) retarget(currentId);
      return;
    }
    try {
      // Restore the floating level above the content window.
      overlayWin.setAlwaysOnTop(true, 'floating');
    } catch {
      /* level arg unsupported */
    }
    try {
      // Restore default click-through WITH forwarding (so the renderer's
      // mousemove loop can re-arm capture over the chrome band as normal).
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      lastCaptureState = false;
    } catch {
      /* unsupported */
    }
    // Re-frame onto the current active hybrid window so the overlay snaps back
    // over it (its geometry/level was just restored).
    const currentId = getActiveHybridWindowId();
    if (currentId != null) {
      try {
        retarget(currentId);
      } catch {
        /* retarget guarded internally */
      }
    }
  };

  app.on('did-resign-active', onAppResignActive);
  app.on('did-become-active', onAppBecomeActive);
}

/**
 * R3: focus the overlay WINDOW when Cmd+L (forwarded as `page:show-navbar`)
 * targets the active hybrid window, so the overlay becomes key and the
 * DOM-focused URL input (openNavbarFocused → focusUrl) is actually typeable.
 * Without this the overlay is only ever `showInactive()`'d, so keystrokes keep
 * going to the content WebContents and never reach the URL field.
 *
 * The focus-group (registry `setOverlayFocusProvider` + deferred blur) keeps the
 * content window active while the overlay holds focus, so this does NOT
 * deactivate/hide the content. R1 interaction: we gate on `appActive` and on the
 * message targeting the ACTIVE hybrid window, so a `page:show-navbar` for a
 * background/foreign window — or one that arrives while the app is backgrounded
 * — never steals focus (which would re-introduce the R1 focus theft).
 */
function wireShowNavbarFocus(): void {
  subscribe(getSystemAddress(), 'page:show-navbar', (raw) => {
    const msg = raw as { windowId?: number } | null;
    if (!msg || msg.windowId == null) return;
    if (!appActive) return; // never steal focus while backgrounded (R1)
    if (msg.windowId !== getActiveHybridWindowId()) return; // active window only
    if (!overlayWin || overlayWin.isDestroyed()) return;
    showNavbarFocusCount++;
    try {
      overlayWin.focus();
    } catch {
      /* focus unsupported / window gone */
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
 * Position + size the overlay to FRAME the given INNER content rect: the content
 * `BaseWindow`'s outer bounds expanded by the canvas gutters
 * (`expandToOverlayFrame`), so the chrome renders in the margin AROUND the
 * content and the transparent center sits exactly over the content window. Then
 * raise the overlay above the content window. Focus-free.
 */
function frameBounds(content: { x: number; y: number; width: number; height: number }): void {
  const win = ensureOverlay();
  if (win.isDestroyed()) return;
  const bounds = expandToOverlayFrame(content);
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

  // R1: seed the app-active state (the app is normally active at init) and
  // install the resign/become gate so a backgrounded overlay can neither
  // capture clicks nor float over other apps. `app.isActive()` exists at
  // runtime on macOS but is absent from this Electron's type defs, so read it
  // through a guarded cast (it stays `true` when the method is unavailable).
  try {
    const maybeIsActive = (app as unknown as { isActive?: () => boolean }).isActive;
    appActive = typeof maybeIsActive === 'function' ? maybeIsActive.call(app) : true;
  } catch {
    appActive = true;
  }
  wireAppActiveGate();

  // R3: focus the overlay window on a Cmd+L (page:show-navbar) for the active
  // hybrid window so the URL field is typeable (gated on app-active, see above).
  wireShowNavbarFocus();

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
  // R1: detach the app-active gate listeners.
  if (onAppResignActive) {
    try { app.removeListener('did-resign-active', onAppResignActive); } catch { /* gone */ }
    onAppResignActive = null;
  }
  if (onAppBecomeActive) {
    try { app.removeListener('did-become-active', onAppBecomeActive); } catch { /* gone */ }
    onAppBecomeActive = null;
  }
  appActive = true;
  showNavbarFocusCount = 0;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
  }
  overlayWin = null;
  // Drop the click-capture + show-navbar-focus subscriptions so a later re-init
  // re-wires cleanly.
  try {
    unsubscribe(getSystemAddress(), 'page-overlay:set-capture');
  } catch {
    /* never throw on teardown */
  }
  try {
    unsubscribe(getSystemAddress(), 'page:show-navbar');
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
  // Focus-group verification (focus-free): headless opacity-0 BaseWindows never
  // take REAL OS focus, so the focus-group logic — which reads `isFocused()` and
  // the overlay-focus provider — can't be exercised by real clicks here. We
  // SIMULATE focus deterministically: `simFocus` holds which fake host id (if
  // any) is "focused", and `simOverlayFocused` whether the overlay is. Each fake
  // host's `isFocused()` is overridden to read `simFocus`; an override on the
  // overlay focus provider reads `simOverlayFocused`. This drives the EXACT
  // blur→deferred-decision path the real focus events trigger (the prior tests
  // bypassed focus entirely, which is why this bug slipped through).
  let simFocus: number | null = null;
  let simOverlayFocused = false;
  const installFocusSim = (baseWin: BaseWindow) => {
    try {
      (baseWin as unknown as { isFocused: () => boolean }).isFocused = () =>
        simFocus === baseWin.id;
    } catch {
      /* property non-configurable in some envs */
    }
  };
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
      installFocusSim(baseWin);
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
    /**
     * Tear down a fake hybrid host: destroy its BaseWindow (firing the 'closed'
     * cleanup that drops it from the hybrid registry). Lets a test return the
     * registry to its empty (flag-off-equivalent) state and assert the
     * windows-feature hybrid loop is then additive-empty.
     */
    destroyFakeHybridWindow(id: number): boolean {
      const w = fakeHosts.get(id);
      if (!w) return false;
      try {
        if (!w.isDestroyed()) w.destroy();
      } catch {
        /* already torn down */
      }
      fakeHosts.delete(id);
      return true;
    },
    /**
     * Focus-group verification: drive the REAL `'focus'`/`'blur'` event sequence
     * on a fake host BaseWindow (the click-the-navbar sequence Electron produces:
     * old window blur BEFORE new window focus). Unlike `setActive` (synthetic, no
     * focus), these exercise the registry's deferred blur decision.
     *
     *   focusHost(id)        — set simulated focus to id + emit its 'focus'
     *   blurHost(id)         — clear simulated focus (if it was id) + emit 'blur';
     *                          the registry schedules the deferred decision
     *   focusOverlay()       — simulate focus moving to the overlay window
     *   blurOverlay()        — simulate overlay losing focus
     *   focusElsewhere()     — simulate focus leaving the whole group (non-hybrid)
     *   runDeferredBlur(id)  — synchronously run the registry's deferred decision
     *                          for id (no waiting on setImmediate); returns active id
     *   activeId()           — current registry active id
     */
    focusHost(id: number): boolean {
      const w = fakeHosts.get(id);
      if (!w || w.isDestroyed()) return false;
      simFocus = id;
      simOverlayFocused = false;
      w.emit('focus');
      return true;
    },
    blurHost(id: number): boolean {
      const w = fakeHosts.get(id);
      if (!w || w.isDestroyed()) return false;
      if (simFocus === id) simFocus = null;
      w.emit('blur');
      return true;
    },
    focusOverlay(): void {
      simFocus = null;
      simOverlayFocused = true;
    },
    blurOverlay(): void {
      simOverlayFocused = false;
    },
    focusElsewhere(): void {
      simFocus = null;
      simOverlayFocused = false;
    },
    runDeferredBlur(id: number): number | null {
      return _runDeferredBlurForTests(id);
    },
    activeId(): number | null {
      return _getActiveHybridWindowIdForBridge();
    },
    /**
     * Focus-group verification: replace the registry's overlay-focus provider
     * with one that reads the bridge's simulated `simOverlayFocused`, so the
     * deferred blur decision sees the overlay as focused when we say it is
     * (the real provider reads the overlay window's OS focus, which a headless
     * test never grants). Call once before driving the blur→overlay-focus
     * sequence.
     */
    installFocusGroupSim(): void {
      setOverlayFocusProvider(() => simOverlayFocused);
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
     * R1 (app-active gate) verification, focus-free. A headless test cannot
     * drive REAL app resign/become-active (no virtual display on macOS), so we
     * invoke the SAME handlers the `app` `'did-resign-active'`/`'did-become-active'`
     * events would run. After resign: the overlay must be forced click-through
     * (captureState false) and drop its floating level (overlayState().alwaysOnTop
     * false). After become: floating restored (alwaysOnTop true) and click-through
     * re-armed with forwarding.
     */
    simAppResignActive(): boolean {
      if (!onAppResignActive) return false;
      onAppResignActive();
      return true;
    },
    simAppBecomeActive(): boolean {
      if (!onAppBecomeActive) return false;
      onAppBecomeActive();
      return true;
    },
    /** R1: whether the app-active gate currently considers the app active. */
    appActiveState(): boolean {
      return appActive;
    },
    /**
     * R3: how many times the `page:show-navbar` handler called `overlayWin.focus()`
     * (passed the app-active + active-window gates). Lets a focus-free test verify
     * the overlay-window focus INTENT fires when Cmd+L targets the active window —
     * and NEVER when the app is backgrounded or the target is a foreign window —
     * without relying on real OS focus (unobservable on macOS-headless).
     */
    showNavbarFocusCount(): number {
      return showNavbarFocusCount;
    },
    /**
     * Gutter geometry verification: the per-side insets from the overlay frame to
     * the inner content rect, plus the expected overlay frame for a given content
     * rect. A test asserts `overlayState().bounds` equals
     * `expectedOverlayFrame(hostBounds(id))` (overlay = content + gutters) so
     * there IS a gutter for the chrome — and the content BaseWindow stays at the
     * inner rect (`hostBounds(id)` unchanged).
     */
    overlayGutters(): { left: number; right: number; top: number; bottom: number } {
      return { ...OVERLAY_GUTTERS };
    },
    expectedOverlayFrame(content: { x: number; y: number; width: number; height: number }) {
      return expandToOverlayFrame(content);
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
              // Cmd+L verification: whether the navbar's URL input currently holds
              // shadow-DOM focus (DOM focus is set by focusUrl() regardless of OS
              // window focus, so this is observable focus-free in a headless run).
              navbarInputFocused: !!(input && nb.shadowRoot &&
                nb.shadowRoot.activeElement === input),
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
     * P1.4b-5: read the overlay's SIDE-PANEL DOM state for focus-free panel
     * verification. Returns per-panel { hasData, text } plus the panels-visible
     * body flag. `hasData` mirrors the `.has-data` opacity gate (a panel only
     * paints once it has data for the active window); `text` is the panel body's
     * textContent so a test can assert the right URL's data is shown. Resolves
     * null if no overlay / renderer not ready. Pure executeJavaScript, no OS focus.
     */
    overlayPanelState(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const pick = (id) => {
              const p = document.getElementById(id);
              const body = p && p.querySelector('.panel-body');
              return p ? { hasData: p.classList.contains('has-data'), text: body ? body.textContent.trim() : '' } : null;
            };
            return {
              panelsVisible: document.body.classList.contains('panels-visible'),
              noActive: document.body.classList.contains('no-active'),
              pageInfo: pick('page-info-panel'),
              tags: pick('tags-panel'),
              entities: pick('entities-panel'),
              extensions: pick('extensions-panel'),
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * P1.4b-5: whether every side panel carries the `.interactive` class — the
     * exact class the overlay's click-capture loop binds pointer enter/leave on,
     * so an `.interactive` panel is in the capture set (turns the overlay opaque
     * to the pointer when hovered). Focus-free DOM read.
     */
    overlayPanelsInteractive(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const ids = ['page-info-panel','tags-panel','entities-panel','extensions-panel'];
            return ids.every((id) => {
              const p = document.getElementById(id);
              return !!p && p.classList.contains('interactive');
            });
          })()`,
        )
        .catch(() => false);
    },
    /**
     * P1.4b-6: read the overlay NOTES panel + WIDGET container DOM state for
     * focus-free verification. `notes` mirrors the panel's `.has-data` gate +
     * body textContent; `widgets` reports the container's `.has-data` flag, the
     * live widget count, the joined widget text, and whether the container carries
     * `.interactive` (the click-capture class). Resolves null if no overlay /
     * renderer not ready. Pure executeJavaScript, no OS focus.
     */
    overlayNotesWidgetState(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const notesPanel = document.getElementById('notes-panel');
            const notesBody = notesPanel && notesPanel.querySelector('.notes-body');
            const wc = document.getElementById('widget-container');
            const cards = wc ? Array.from(wc.querySelectorAll('.widget')) : [];
            return {
              noActive: document.body.classList.contains('no-active'),
              notes: notesPanel ? {
                hasData: notesPanel.classList.contains('has-data'),
                interactive: notesPanel.classList.contains('interactive'),
                text: notesBody ? notesBody.textContent.trim() : '',
              } : null,
              widgets: wc ? {
                hasData: wc.classList.contains('has-data'),
                interactive: wc.classList.contains('interactive'),
                count: cards.length,
                text: cards.map((c) => c.textContent.trim()).join(' | '),
              } : null,
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Read the overlay's extension widget HOST state (the `__pageWidgetHost`
     * created by overlay.js from createPageWidgetHost) for the page-widgets spec
     * migrated off the canvas page chrome. On the hybrid path the widget host
     * lives in the SHARED overlay renderer (not a per-page chrome), so a test
     * drives the widget:register/render/update/close pubsub lifecycle through the
     * system address and reads the resulting state here.
     *
     * Returns:
     *   - hostPresent: `__pageWidgetHost` is wired
     *   - registered / active: registered-widget count and rendered-widget count
     *   - byId[<extensionId:widgetId>]: { present, title, bodyHtml } read straight
     *     off the overlay widget container DOM (data-widget-id === the key)
     * Resolves null if no overlay / renderer not ready. Pure executeJavaScript.
     */
    widgetHostState(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const host = window.__pageWidgetHost;
            const wc = document.getElementById('widget-container');
            const cards = wc ? Array.from(wc.querySelectorAll('.widget')) : [];
            const byId = {};
            for (const c of cards) {
              const id = c.dataset.widgetId;
              const body = c.querySelector('.widget-body');
              const title = c.querySelector('.widget-title');
              byId[id] = {
                present: true,
                title: title ? title.textContent : '',
                bodyHtml: body ? body.innerHTML : '',
              };
            }
            return {
              hostPresent: host != null,
              registered: host && typeof host.getWidgets === 'function' ? host.getWidgets().size : null,
              active: host && typeof host.getActiveWidgets === 'function' ? host.getActiveWidgets().size : null,
              domCount: cards.length,
              byId,
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Gutter-placement verification (the gutter fix). Reveals the chrome and reads
     * the overlay-local geometry: the inner content rect (where the content
     * window shows through), each widget card's top/left/right, and each
     * right-stack panel's top. A test asserts widgets render OUTSIDE the content
     * rect (in the right gutter: card.left >= content.right - overlap, i.e. not
     * buried under content) and STACK (distinct, increasing top offsets — not all
     * piled at the same top). Pure executeJavaScript, no OS focus.
     */
    /** Test-only: add N plain widgets to the overlay's widget container (gutter
     * placement / stacking verification). Resolves the live widget count. */
    addTestWidgets(n: number): Promise<number> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(0);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const N = ${Math.max(0, Math.floor(n))};
            for (let i = 0; i < N; i++) {
              window.__overlayTestAddWidget('test-widget-' + i, 'Widget ' + i, '<div class="widget-body">Body of widget ' + i + ' with enough text to give it real height in the gutter.</div>');
            }
            const wc = document.getElementById('widget-container');
            return wc ? wc.querySelectorAll('.widget').length : 0;
          })()`,
        )
        .catch(() => 0);
    },
    overlayGutterLayout(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const tz = document.getElementById('trigger-zone');
            if (tz) tz.dispatchEvent(new Event('mouseenter'));
            const wc = document.getElementById('widget-container');
            const cards = wc ? Array.from(wc.querySelectorAll('.widget')) : [];
            const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
            // The content rect within the overlay: gutters inset. Recover it from
            // the window inner size minus the known gutters via the trigger zone
            // (which spans the content width at content.left/top).
            const tzr = tz ? tz.getBoundingClientRect() : null;
            return {
              content: tzr ? { left: Math.round(tzr.left), top: Math.round(tzr.bottom), right: Math.round(tzr.right) } : null,
              widgets: cards.map((c) => ({ ...rect(c), text: c.textContent.trim() })),
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * P1.4b-6: publish the websearch feature's confirm event (the same topic +
     * payload the websearch tile emits after it fetches/parses/records an
     * OpenSearch descriptor) so the overlay's OpenSearch widget can be verified
     * without the real websearch tile present. The overlay only renders a card if
     * a matching `page:search-engine-discovered` for the ACTIVE window armed it
     * first (publish that via publishTopic).
     */
    publishWebsearchEngine(engine: { id: string; name: string; searchUrl?: string }): void {
      publish(getSystemAddress(), 'websearch:engine-discovered', { engine });
    },
    /**
     * P1.4b-6: seed a Notes item anchored to `url` through the overlay renderer's
     * OWN api.datastore (the same datastore PageNotesPane reads). The datastore
     * write emits item:created / tag:item-added pubsub, which the mounted notes
     * pane subscribes to → it reloads and shows the note if `url` is its active
     * URL. Returns the created item id (or null on failure). Focus-free.
     */
    seedNote(url: string, content: string): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(async () => {
            const ds = window.app.datastore;
            const tag = await ds.getOrCreateTag('annotation');
            const tagId = tag && tag.data && tag.data.tag && tag.data.tag.id;
            if (!tagId) return null;
            const meta = JSON.stringify({ anchor: { url: ${JSON.stringify(url)}, text: '' } });
            const created = await ds.addItem('text', { content: ${JSON.stringify(content)}, metadata: meta });
            const itemId = created && created.data && created.data.id;
            if (!itemId) return null;
            await ds.tagItem(itemId, tagId);
            return itemId;
          })()`,
        )
        .catch(() => null);
    },
    /**
     * P1.4b-5: synthetically reveal the chrome (navbar + panels) without a real
     * pointer hover — drives the same showNavbar() path the trigger-zone hover
     * would, so a test can assert panels become visible. Focus-free.
     */
    revealOverlayChrome(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const tz = document.getElementById('trigger-zone');
            if (!tz) return false;
            tz.dispatchEvent(new Event('mouseenter'));
            return document.body.classList.contains('panels-visible');
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Trigger-zone RELIABILITY verification: drive the navbar reveal through the
     * RELIABLY-forwarded `mousemove` path (the flaky-hover fix), not the
     * boundary-crossing `mouseenter` that misses on a click-through window.
     * Dispatches a document-level `mousemove` whose coordinates land in the CENTER
     * of the trigger-zone band, then returns the navbar's visible state. Focus-free.
     */
    moveOverTriggerZone(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const tz = document.getElementById('trigger-zone');
            if (!tz) return false;
            const r = tz.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: x, clientY: y, bubbles: true,
            }));
            return document.getElementById('navbar').classList.contains('visible');
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Trigger-zone NO-FLICKER verification: dispatch a `mousemove` whose
     * coordinates land in the CENTER of the (now-visible) navbar — i.e. the
     * pointer moved from the trigger zone INTO the navbar. The reliable-reveal
     * mousemove hit-test spans both regions, so this must NOT schedule a hide:
     * the navbar stays visible (no trigger-zone↔navbar flicker). Returns the
     * navbar's visible state. Focus-free.
     */
    moveOverNavbar(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const nb = document.getElementById('navbar');
            const r = nb.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: x, clientY: y, bubbles: true,
            }));
            return nb.classList.contains('visible');
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Trigger-zone reveal/hide verification: dispatch a `mousemove` far OUTSIDE
     * any chrome region (center of the content area), which the reliable-reveal
     * path reads as "outside" → schedules the navbar hide. Returns whether the
     * hide was SCHEDULED (a pending hide timer), proving the move-out path fires;
     * the actual class removal is timer-deferred (the same 400ms grace page.js
     * uses) so we assert the schedule rather than racing the timer. Focus-free.
     */
    moveOffChromeSchedulesHide(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const x = Math.round(window.innerWidth / 2);
            const y = Math.round(window.innerHeight / 2);
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: x, clientY: y, bubbles: true,
            }));
            return window.__overlayHidePending === true;
          })()`,
        )
        .catch(() => false);
    },
    /**
     * P1.4b-5: publish an entities response on the SAME topic the entities
     * feature would, so the overlay's Entities panel can be verified without the
     * real entities tile present. `url` MUST equal the active window's URL for
     * the panel to accept it (active-URL-keyed filter).
     */
    publishEntities(url: string, entities: unknown[]): void {
      publish(getSystemAddress(), 'entities:get-for-url:response', { url, entities });
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
     * Hold-to-drag (navbar-background) verification, focus-free. Drives the
     * UNIFORM hold-to-drag gesture the overlay now binds: a `mousedown` on the
     * navbar BACKGROUND (not a button/URL field), HOLD still for the
     * `dragHoldDelay` threshold (read live from the overlay's FSM), THEN a
     * document `mousemove` translated by (dxScreen,dyScreen) in SCREEN coords,
     * then `mouseup`. The renderer's hold-drag FSM begins the window drag only
     * after the hold fires, computes new bounds and publishes `page:set-bounds`,
     * which main routes to the host BaseWindow — so a test can assert
     * `hostBounds(id)` moved by the delta. Resolves true if the gesture dragged.
     * Pure executeJavaScript (waits the real threshold inside the renderer).
     */
    holdDragNavbar(dxScreen: number, dyScreen: number): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(async () => {
            const nb = document.getElementById('navbar');
            const t = globalThis.__peekHoldDragTest;
            if (!nb || !t) return false;
            const startX = 500, startY = 30;
            nb.dispatchEvent(new MouseEvent('mousedown', {
              button: 0, buttons: 1, screenX: startX, screenY: startY, bubbles: true,
            }));
            // Hold STILL past the threshold (read from the live prefs-driven FSM,
            // default 1000ms) so the hold fires; generous margin for the timer to
            // fire under a loaded test run before we move.
            await new Promise((r) => setTimeout(r, 1500));
            // First post-hold move begins the drag; a second move drives it to
            // the destination delta.
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 1, screenX: startX + 1, screenY: startY + 1, bubbles: true,
            }));
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 1,
              screenX: startX + ${Math.round(dxScreen)},
              screenY: startY + ${Math.round(dyScreen)},
              bubbles: true,
            }));
            const wasDragging = t.holdDrag.isDragging();
            document.dispatchEvent(new MouseEvent('mouseup', {
              button: 0, buttons: 0, bubbles: true,
            }));
            return wasDragging;
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Pure hold-to-drag FSM coverage (no real timers / pointer): drive the
     * exported `createHoldDrag` factory with an INJECTED manual clock + recording
     * effects, and assert both transitions deterministically:
     *   - press → hold-fires → move ⇒ a window drag starts + moves
     *   - press → move-before-threshold ⇒ candidacy cancels, no drag even after
     *     the threshold would have elapsed
     * Resolves the recorded effects so the test can assert the exact behavior.
     */
    holdDragFsmUnit(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const t = globalThis.__peekHoldDragTest;
            if (!t) return null;
            const make = (canStart) => {
              const rec = { starts: [], moves: [], ends: 0, grab: 0 };
              let pending = null; // queued scheduled fn (manual clock)
              const fsm = t.createHoldDrag({
                getThreshold: () => 1000,
                getTolerance: () => 5,
                canStart: () => canStart,
                onDragStart: (x, y) => rec.starts.push([x, y]),
                onDragMove: (x, y) => rec.moves.push([x, y]),
                onDragEnd: () => { rec.ends++; },
                setGrabCursor: () => { rec.grab++; },
                clearCursor: () => {},
                setSchedule: (fn) => { pending = fn; return 1; },
                clearSchedule: () => { pending = null; },
              });
              return { fsm, rec, fire: () => { if (pending) { const f = pending; pending = null; f(); } } };
            };

            // Case 1: press → hold fires → move → drag starts + moves.
            const a = make(true);
            a.fsm.onDown(100, 100);
            a.fire();                 // hold threshold elapses (still held, no move)
            a.fsm.onMove(140, 130);   // first post-hold move begins the drag
            a.fsm.onMove(160, 150);   // drives it
            const draggedDuringA = a.fsm.isDragging();
            a.fsm.onUp();

            // Case 2: press → move BEFORE threshold → cancelled (no drag).
            const b = make(true);
            b.fsm.onDown(100, 100);
            b.fsm.onMove(110, 100);   // 10px > tolerance, before fire → cancel
            b.fire();                 // threshold elapses, but candidacy cancelled
            const stateB = b.fsm._state();
            b.fsm.onMove(200, 200);   // further move must NOT drag
            b.fsm.onUp();

            return {
              caseDrag: {
                grab: a.rec.grab,
                starts: a.rec.starts,
                moves: a.rec.moves,
                draggedDuring: draggedDuringA,
                ends: a.rec.ends,
              },
              caseCancel: {
                state: stateB,
                starts: b.rec.starts,
                moves: b.rec.moves,
              },
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Pre-threshold-move CANCELS the window-drag candidacy (dnd / selection /
     * click safety). Drives: mousedown on the navbar background, then an
     * IMMEDIATE move beyond tolerance (before the hold fires), then a settle past
     * the threshold. Resolves the FSM state — `dragging`/`ready`/`pending` must
     * all be false (candidacy was cancelled, so no window move starts even though
     * the threshold elapsed). Pure executeJavaScript.
     */
    holdDragCancelByEarlyMove(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(async () => {
            const nb = document.getElementById('navbar');
            const t = globalThis.__peekHoldDragTest;
            if (!nb || !t) return null;
            const startX = 500, startY = 30;
            nb.dispatchEvent(new MouseEvent('mousedown', {
              button: 0, buttons: 1, screenX: startX, screenY: startY, bubbles: true,
            }));
            // Move FAR beyond tolerance immediately (pre-threshold) → cancel.
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 1, screenX: startX + 60, screenY: startY + 60, bubbles: true,
            }));
            // Let the (now-cleared) threshold window elapse; nothing should fire.
            await new Promise((r) => setTimeout(r, 1200));
            const st = t.holdDrag._state();
            document.dispatchEvent(new MouseEvent('mouseup', {
              button: 0, buttons: 0, bubbles: true,
            }));
            return st;
          })()`,
        )
        .catch(() => null);
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
    /**
     * Windows-feature enumeration check: replicate the EXACT hybrid loop the
     * `tile:window:list` handler runs (getAllHybridWindows → getWindowPresentation
     * → the windows-feature entry shape). Returns the same `{ id, url, title,
     * visible, focused, favicon, ... }` entries the feature's renderer receives,
     * so a test can assert a hybrid window is indistinguishable from a canvas
     * page in the list. Empty when the hybrid flag is off (registry empty).
     */
    windowsFeatureHybridEntries(): Array<{
      id: number;
      url: string;
      title: string;
      visible: boolean;
      focused: boolean;
      favicon: string;
      thumbnail: string;
    }> {
      const out: Array<{
        id: number;
        url: string;
        title: string;
        visible: boolean;
        focused: boolean;
        favicon: string;
        thumbnail: string;
      }> = [];
      for (const h of getAllHybridWindows()) {
        const p = getWindowPresentation(h.windowId);
        if (!p) continue;
        out.push({
          id: p.id,
          url: p.address,
          title: p.title,
          visible: p.visible,
          focused: p.focused,
          favicon: p.favicon,
          thumbnail: p.thumbnail,
        });
      }
      return out;
    },
  };
}
