/**
 * Hybrid page-host shared chrome overlay (P1.4b-1).
 *
 * The hybrid page-host path opens each web
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
 */

import { app, BrowserWindow, BaseWindow as BaseWindowCtor, WebContentsView, screen } from 'electron';
import type { BaseWindow, WebContents } from 'electron';
import { isHeadless, getTilePreloadPath } from './config.js';
import { DEBUG } from './debug-flag.js';
import {
  getHybridWindow,
  getHybridContentWC,
  registerHybridWindow,
  getAllHybridWindows,
  // Stage B: per-host load-error state + timeout (lives in registry to avoid circular dep)
  registerLoadErrorListener,
  getHybridLoadError,
  hasHybridPainted,
  hasHybridOutstandingFailure,
  getHybridRetryAttempts,
  getHybridLoadingTimeoutMs,
  setHybridLoadingTimeoutMs as _setHybridLoadingTimeoutMs,
  // Hybrid teardown → deny pending web-permission prompts (see initHybridOverlay)
  registerHybridWindowClosedListener,
} from './hybrid-page-host-registry.js';
import { __setEditableFocusForWcForTest } from './hybrid-editable-focus.js';
import {
  denyPendingRequestsForWindow,
  _pendingRequestCountForTests,
  _resetForTests as _resetPermissionHandlerForTests,
} from './permission-handler.js';
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
import {
  getFrontPageHostId,
  subscribeFrontChange,
  dispatchWindowEvent,
  waitForMode,
  registerWindowWithMachine,
  getWindowModeName,
  getWindowIdFor,
  getNativeWindowFor,
  getMachineWindowRecord,
  waitForPendingWindowEffects,
  getAppActive,
  subscribeAppActive,
} from './window-state-singleton.js';
import { classifyWindowRegistration } from './window-state.js';
import { getFaviconForUrl } from './datastore.js';
import { getWindowInfo, registerWindow } from './main.js';
import { getWindowPresentation } from './window-presenter.js';
import { hybridShowIntent, showHybridHost, closeFocusedWindow, closeOrHideWindow } from './windows.js';
import { expandToOverlayFrame, OVERLAY_GUTTERS } from './overlay-frame.js';
import { headlessActivationPolicy } from './headless-policy.js';
import { registerLocalShortcut, unregisterLocalShortcut } from './shortcuts.js';

/**
 * The front page-host as an ELECTRON window id, or null. The machine's surface
 * speaks WM WindowId only; this module's internals (the hybrid registry it
 * frames over, the pubsub payloads its renderer speaks) are still keyed by
 * Electron window ids, so every read of the front converts here — through the
 * singleton's sanctioned mapping, never a private map. A later migration step
 * re-keys the hybrid registry and deletes this shim.
 */
function frontPageHostOsId(): number | null {
  const front = getFrontPageHostId();
  if (front == null) return null;
  const win = getNativeWindowFor(front);
  return win ? win.id : null;
}

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

// ── R1 app-active gate ──────────────────────────────────────────────────────
// Whether THE APP (Electron) is currently the frontmost (active) application is
// NOT tracked here: it is `AppWindowState.appActive` in the window-state
// machine, read through `getAppActive()` and observed through
// `subscribeAppActive()`. This module used to keep a module-level `appActive`
// fed by its own `app.on('did-resign-active'/'did-become-active')` pair — a
// second copy of a boolean the machine already owns.
//
// The GATE itself still lives here: the overlay is a transparent
// `alwaysOnTop:'floating'` window that, when Peek is backgrounded, can float
// OVER another app AND — because overlay.js drives `setCapture(true)` from
// forwarded `mousemove`s over the chrome band — capture a click meant for that
// other app (activating Electron and swallowing the click). So on the
// resign edge we force the overlay click-through + drop its floating level, and
// on the become edge we restore the floating + default click-through and
// re-frame onto the current active hybrid window. Wired by `initHybridOverlay`.
let unsubscribeAppActive: (() => void) | null = null;

// R3 (Cluster B) probe-shortcut fire counter (module scope so the bridge
// closure + the registered local-shortcut callback share it). Test-only.
let __probeShortcutFireCount = 0;

// R3 test-observability: how many times the `page:show-navbar` handler actually
// called `overlayWin.focus()` (i.e. passed the app-active + active-window gates).
// On macOS-headless `.focus()` does not grant real OS focus (no virtual
// display), so `isFocused()` can't be asserted; this counter lets a focus-free
// test verify the focus INTENT fired exactly when gated correctly (and never
// when backgrounded / for a foreign window — the R1 interaction guard).
let showNavbarFocusCount = 0;

// ── Per-host load-error live-update publisher (Stage B) ─────────────────────
// The per-host load-error STATE lives in hybrid-page-host-registry.ts (shared
// between ipc.ts and this file without creating a circular import — see the
// `registerLoadErrorListener` / `setHybridLoadError` exports there). This
// module's sole job is to publish the LIVE update to the overlay when the
// registry calls back and the affected window is currently active. The active
// handoff (`sendActiveHandoff`) carries the state for the non-active case.

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
    // Page-host fullscreen black-screen fix (7fffa286): the overlay must NEVER
    // be eligible for macOS native fullscreen. When a host entered its
    // fullscreen Space, the follow() → frameBounds() resize handler re-bounded
    // the overlay to cover the (now display-sized) host and re-showed/raised it
    // mid-transition — and AppKit promoted the overlay into its OWN fullscreen
    // tile (observed live: overlayWin.isFullScreen() === true). A transparent
    // window that AppKit fullscreens gets an opaque BLACK backing store, so the
    // frontmost Space was the overlay's all-black tile — the "fullscreen =
    // black screen" bug. The content host's own Space composited fine the whole
    // time (verified by pixel capture in a minimal harness and by
    // contentWC.capturePage() live). fullscreenable:false makes the promotion
    // impossible at the AppKit level; frameBounds() additionally hides the
    // overlay while the followed host is in native fullscreen.
    fullscreenable: false,
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
    const currentId = frontPageHostOsId();
    if (currentId != null) sendActiveHandoff(currentId);
  });

  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  // Register the chrome overlay with the window-state machine as a SATELLITE: it
  // can hold OS focus (Cmd+L into the navbar) but must never become `front`.
  // - The machine's deferred-blur settle (adapter) checks EVERY registered
  //   window's focus, so a click into the overlay keeps the content host `front`
  //   — replacing the registry's `setOverlayFocusProvider` focus-group.
  // - The close resolver reads `front` (which excludes this satellite) —
  //   replacing `setOverlayWindowIdProvider` + `isHybridOverlayWindowId`.
  registerWindowWithMachine({
    kind: 'browser',
    role: 'overlay',
    class: 'overlay',
    satellite: true,
    win,
    contentWC: win.webContents,
    // The overlay owns Escape in its own renderer (dismissing the address bar /
    // widgets). A main-process `before-input-event` interceptor would
    // preventDefault the keystroke before the page ever sees it, so the shared
    // chrome is the one browser window that opts out of the machine's attach.
    attachEscHandler: false,
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
  // Last-known favicon for this URL (from the datastore), so the loading card
  // can paint the site's icon the instant it's active — before the live
  // `page-favicon-updated` arrives. '' when unknown (spinner-only card).
  let favicon = '';
  try {
    const u = entry.url();
    if (u) favicon = getFaviconForUrl(u);
  } catch {
    /* datastore unavailable / bad url — spinner-only */
  }
  // Maximize state lives on the machine record (§5 step 7B); the registry
  // entry is Electron-id-keyed, so convert through the sanctioned mapping.
  const activeMachineId = getWindowIdFor(id);
  const activeMachineRec = activeMachineId != null ? getMachineWindowRecord(activeMachineId) : undefined;
  publish(getSystemAddress(), 'page-overlay:active', {
    windowId: id,
    url: entry.url(),
    title: entry.title(),
    favicon,
    // The overlay shows the favicon+spinner loading card only for a window that
    // has never painted (fresh/restore/deferred) — see registry perHostPainted.
    firstLoad: !hasHybridPainted(id),
    canGoBack,
    canGoForward,
    // Stage B: include per-host load-error so the overlay paints the error card
    // (or clears it) instantly on active-window switch with no flash. Rides the
    // SAME deterministic handoff path as `navbar.loading` — no extra timer.
    loadError: getHybridLoadError(id),
    loading,
    // Maximize-state hand-off: the window-state machine record is the single
    // source of truth for a hybrid window's maximized flag + pre-maximize
    // bounds (§5 step 7B — written only by the reducer's maximize
    // transitions). Ship BOTH on every active-window handoff so the
    // overlay RECONCILES its own maximize state to the newly-active window's
    // instead of blindly resetting it — otherwise a maximized window that loses
    // and regains active (window switching) has its overlay `maximized` clobbered
    // to false and forgets it was maximized. Deterministic state hand-off, no
    // timer/visibilitychange (see fsm-pilled).
    maximized: activeMachineRec?.maximized === true,
    preMaxBounds: activeMachineRec?.maximized === true ? activeMachineRec.preMaxBounds : null,
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
    const capture = !!(msg && msg.capture) && getAppActive();
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
 *
 * The EDGE comes from the machine (`subscribeAppActive`, edge-deduped over
 * `AppWindowState.appActive`), not from a private `app.on('did-resign-active')`
 * pair — the backend's `attachAppListeners` is the one producer of that OS
 * signal.
 */
function wireAppActiveGate(): void {
  if (unsubscribeAppActive) return;

  const onAppResignActive = () => {
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
    try {
      // R6 (peek item 88797f2d): hide the chrome entirely while Peek is not the
      // active app. The overlay is chrome for the ACTIVE page; when the user
      // switches to another app it must not linger on screen. become-active
      // re-frames + re-shows it over the current active hybrid window.
      if (overlayWin.isVisible()) overlayWin.hide();
    } catch {
      /* hide unsupported in some envs */
    }
  };

  const onAppBecomeActive = () => {
    if (!overlayWin || overlayWin.isDestroyed()) {
      // No overlay yet — re-frame below will lazily create it if there is an
      // active hybrid window.
      const currentId = frontPageHostOsId();
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
    const currentId = frontPageHostOsId();
    if (currentId != null) {
      try {
        retarget(currentId);
      } catch {
        /* retarget guarded internally */
      }
    }
  };

  // One subscription, both edges. The test bridge (`simAppResignActive` /
  // `simAppBecomeActive`) drives the same edges by dispatching `APP_RESIGNED` /
  // `APP_ACTIVATED` into the machine, so headless tests exercise the production
  // path rather than a parallel one.
  unsubscribeAppActive = subscribeAppActive((active) => {
    if (active) onAppBecomeActive();
    else onAppResignActive();
  });
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
    if (!getAppActive()) return; // never steal focus while backgrounded (R1)
    if (msg.windowId !== frontPageHostOsId()) return; // active window only
    if (!overlayWin || overlayWin.isDestroyed()) return;
    showNavbarFocusCount++;
    try {
      overlayWin.focus();
    } catch {
      /* focus unsupported / window gone */
    }
  });
}

/**
 * Run extension page-script execution against the active hybrid content
 * WebContents. The hybrid overlay widget host is built with `webview: null`
 * (the page content is a MAIN-owned WebContentsView, not an in-window
 * `<webview>`), so the renderer overlay can only ever answer
 * "No webview available". This main handler mirrors the canvas
 * `handleExecuteScript` contract (10s timeout race; publishes
 * `page:script-result`) but targets the active hybrid content WC.
 */
function wireExecuteScript(): void {
  subscribe(getSystemAddress(), 'page:execute-script', (raw) => {
    const msg = raw as { extensionId?: string; requestId?: string; script?: string };
    if (!msg || !msg.extensionId || !msg.requestId || !msg.script) return;
    // Resolve the page the script should run in: the active hybrid content WC.
    // No active hybrid window → this request isn't for us (canvas path or none) →
    // stay silent so we don't publish a spurious result.
    const activeId = frontPageHostOsId();
    if (activeId == null) return;
    const wc = getHybridContentWC(activeId);
    if (!wc || wc.isDestroyed()) return;

    const SCRIPT_TIMEOUT = 10000;
    let promise: Promise<unknown>;
    try {
      promise = wc.executeJavaScript(msg.script);
    } catch (err) {
      publish(getSystemAddress(), 'page:script-result', {
        requestId: msg.requestId, extensionId: msg.extensionId,
        error: err instanceof Error ? err.message : String(err), success: false,
      });
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Script execution timed out')), SCRIPT_TIMEOUT);
    });
    Promise.race([promise, timeout])
      .then((result) => {
        publish(getSystemAddress(), 'page:script-result', {
          requestId: msg.requestId, extensionId: msg.extensionId, result, success: true,
        });
      })
      .catch((err) => {
        publish(getSystemAddress(), 'page:script-result', {
          requestId: msg.requestId, extensionId: msg.extensionId,
          error: err instanceof Error ? err.message : String(err), success: false,
        });
      });
  });
}

/** Stop following the currently-followed host window (detach move/resize). */
function unfollow(): void {
  if (followedBaseWin && onFollowedMove && !followedBaseWin.isDestroyed()) {
    try {
      followedBaseWin.removeListener('move', onFollowedMove);
      followedBaseWin.removeListener('resize', onFollowedMove);
      followedBaseWin.removeListener('enter-full-screen', onFollowedMove);
      followedBaseWin.removeListener('leave-full-screen', onFollowedMove);
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
 *
 * `hostFullScreen` is the followed host's `isFullScreen()` — it flips
 * synchronously the instant `setFullScreen(true)` is called, so it is true for
 * every mid-transition 'resize' the fullscreen animation emits. While the host
 * is in (or entering) native fullscreen the overlay must NOT be re-bounded /
 * shown / raised over it: a normal-level window pushed over a fullscreen Space
 * is what AppKit used to promote into an all-black fullscreen tile (see the
 * `fullscreenable: false` note in ensureOverlay — that flag is the hard AppKit
 * guarantee; this gate keeps the overlay's own show/hide state honest). The
 * chrome is simply unavailable in native fullscreen — Esc / the fullscreen
 * command exit it via the content WC's before-input-event, which never needed
 * the overlay. On leave-full-screen the host emits 'resize' again with
 * `isFullScreen()` already false, so the SAME follow path re-frames and
 * re-shows the overlay — no extra listener.
 */
/**
 * The display work area nearest a content rect's center, or `null` when
 * `screen` is unavailable (some test envs) — `expandToOverlayFrame` skips its
 * maximized-parity branch + clamp in that case.
 */
function workAreaNearest(content: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } | null {
  try {
    return screen.getDisplayNearestPoint({
      x: content.x + Math.floor(content.width / 2),
      y: content.y + Math.floor(content.height / 2),
    }).workArea;
  } catch {
    /* screen unavailable in some test envs — skip maximized parity + clamp */
    return null;
  }
}

function frameBounds(
  content: { x: number; y: number; width: number; height: number },
  hostFullScreen: boolean,
): void {
  const win = ensureOverlay();
  if (win.isDestroyed()) return;
  if (hostFullScreen) {
    if (win.isVisible()) win.hide();
    return;
  }
  const bounds = expandToOverlayFrame(content, workAreaNearest(content));
  // setBounds in one shot avoids an intermediate paint (R2: no double-paint /
  // flicker on retarget).
  win.setBounds(bounds);

  // R6 (peek 71cfde09 item 7): while the app is INACTIVE, position/size only —
  // never reveal the chrome or float it over the foreground app. A non-activating
  // (type:'panel') peek can become the active hybrid window without Electron ever
  // firing did-become-active, so retarget()→frameBounds() runs with appActive
  // still false. The resign handler (onAppResignActive) already dropped the
  // floating level and hid the overlay; re-asserting always-on-top or calling
  // showInactive() here would re-introduce the exact asymmetry that leaked the
  // overlay over other apps. When the app later becomes active, onAppBecomeActive
  // → retarget() → frameBounds() runs with appActive=true and reveals it via the
  // existing lifecycle transition (no timer/poll needed). The machine seeds
  // `appActive` true, so a boot-time reveal is unaffected.
  if (!getAppActive()) return;

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
  }
  // Already visible: nothing more to do. The overlay is PINNED (§4.3 dim 3 —
  // stacking level 'pinned'): the setAlwaysOnTop(true,'floating') re-assert
  // just above both holds it at the floating level AND order-fronts it within
  // that level, and the machine's SET_STACKING raises are relative raises of
  // NORMAL-level content windows, which can never cross a floating-level
  // window. The old `win.moveTop()` here was redundant with the pin re-assert
  // and was the last ordering write outside the machine (§5 step 5 part B).
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

  // Initial frame — read the target host's outer bounds directly (replaces the
  // registry's `getActiveHybridWindowBounds`, which just read the active host).
  let initial: { x: number; y: number; width: number; height: number } | null = null;
  try { if (!baseWin.isDestroyed()) initial = baseWin.getBounds(); } catch { /* host gone */ }
  if (initial) frameBounds(initial, baseWin.isFullScreen());

  // Follow the active window's move/resize. We re-read getBounds() each time
  // (rather than the event payload) so the overlay matches the window's true
  // current outer bounds even if multiple move/resize events coalesce.
  const follow = () => {
    if (baseWin.isDestroyed()) return;
    try {
      frameBounds(baseWin.getBounds(), baseWin.isFullScreen());
    } catch {
      /* window torn down mid-move */
    }
  };
  baseWin.on('move', follow);
  baseWin.on('resize', follow);
  // Fullscreen edges route through the SAME follow path (frameBounds reads
  // isFullScreen() and hides/re-shows the overlay accordingly). A host whose
  // bounds already fill the work area can enter/leave native fullscreen with
  // NO bounds change, so 'resize' alone cannot be trusted to fire — these
  // events are the deterministic edge signals. isFullScreen() flips
  // synchronously at setFullScreen() time, so any mid-animation 'resize' that
  // does fire is gated identically; there is no window state where the overlay
  // is shown over a fullscreen host.
  baseWin.on('enter-full-screen', follow);
  baseWin.on('leave-full-screen', follow);
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
 * changes. Idempotent: a second call while already initialized is ignored.
 *
 * Wire this from the main-process setup path that runs once the hybrid feature
 * is active (see `ipc.ts` `registerAllHandlers` / `entry.ts onReady`).
 */
export function initHybridOverlay(): void {
  if (unsubscribeActive) return; // already initialized

  // Subscribe to the overlay renderer's click-capture toggle before any window
  // exists — the subscription is on the main pubsub registry, independent of
  // the overlay window's lifetime.
  wireClickCapture();

  // R1: install the resign/become gate so a backgrounded overlay can neither
  // capture clicks nor float over other apps. No seed here any more — the
  // app-active boolean is `AppWindowState.appActive` (seeded true at machine
  // construction, driven by the backend's app listeners); the overlay's old
  // `app.isActive()` read was the seed for its own private copy.
  wireAppActiveGate();

  // R3: focus the overlay window on a Cmd+L (page:show-navbar) for the active
  // hybrid window so the URL field is typeable (gated on app-active, see above).
  wireShowNavbarFocus();

  // cmd+W overlay redirect is now structural: the overlay registers as a
  // satellite (see ensureOverlay), so it can never be `front` and the close
  // resolver (`resolveFocusedWindowIdForClose` → `getFrontWindowId`) always
  // targets the content host — no `setOverlayWindowIdProvider` needed.

  // Run extension page-script execution against the active hybrid content WC
  // (the overlay host has webview:null and cannot service it; see above).
  wireExecuteScript();

  unsubscribeActive = subscribeFrontChange((front) => {
    try {
      // The machine hands back a WM WindowId; retarget (and the hybrid
      // registry behind it) still speaks Electron ids — convert at the seam.
      const win = front != null ? getNativeWindowFor(front) : null;
      retarget(win ? win.id : null);
    } catch (err) {
      DEBUG && console.log('[hybrid-overlay] retarget failed:', err);
    }
  });

  // Stage B: live-update the overlay when a load error arrives or clears FOR
  // THE CURRENTLY-ACTIVE window. Non-active windows are handled by the next
  // `sendActiveHandoff` snapshot; no extra mechanism needed for them.
  registerLoadErrorListener((windowId, error) => {
    if (windowId !== frontPageHostOsId()) return;
    publish(getSystemAddress(), 'page:load-error', { windowId, error });
  });

  // Hybrid window teardown → deny any pending web-permission requests for that
  // window. permission-handler's own close-cleanup only knows BrowserWindow
  // hosts (getLiveWindow); hybrid hosts are BaseWindows, so a hybrid close
  // would otherwise leak the deferred Chromium callbacks forever and strand
  // the overlay's queued prompt. Registered through the registry's
  // closed-listener seam so the registry stays free of runtime electron deps
  // and permission-handler stays decoupled from the hybrid registry — this
  // module (already the registry↔chrome bridge) is the one wiring site.
  registerHybridWindowClosedListener((windowId) => denyPendingRequestsForWindow(windowId));

  // E2E test bridge: expose the focus-free verification surface on a global so
  // a Playwright `evaluateMain` can drive active-window changes synthetically
  // (no real OS focus) and read the overlay's resulting state. Gated on
  // E2E_TEST so it never installs in a normal run.
  if (process.env.E2E_TEST === 'true') {
    installTestBridge();
  }

  // Seed off the current active window in case one is already frontmost at
  // init time (e.g. session restore opened a hybrid window before this ran).
  const currentId = frontPageHostOsId();
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
  // R1: drop the app-active gate subscription (the machine keeps owning the
  // boolean — there is nothing to reset here).
  if (unsubscribeAppActive) {
    try { unsubscribeAppActive(); } catch { /* gone */ }
    unsubscribeAppActive = null;
  }
  showNavbarFocusCount = 0;
  // (No overlay-id / focus provider to clear — the overlay's satellite
  // registration with the machine handles close-resolution + focus-group.)
  // Drop the hybrid-teardown permission-deny listener (re-registered on init).
  registerHybridWindowClosedListener(null);
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
  try {
    unsubscribe(getSystemAddress(), 'page:execute-script');
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
 *       Drives the window-state machine synthetically: WINDOW_SHOWN{focused}
 *       for an id (the host becomes `front`, the overlay retargets), or — for
 *       null — WINDOW_HIDDEN of the front page-host(s) until no page-host is
 *       front (the overlay hides). No focus change.
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
  // Lazily-created hidden non-page-host machine window that `focusElsewhere`
  // moves `front` onto (see its doc) — the machine-native encoding of "focus
  // landed on a non-hybrid window".
  let elsewhereWin: BaseWindow | null = null;
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
      // Register with the window-state machine too — `setActive` drives the
      // machine (`WINDOW_SHOWN`), so a fake host the machine has never seen
      // resolves to no WindowId and setActive() silently no-ops: the overlay
      // then never binds (gate fallout of the WindowId cutover — the old
      // bridge drove the registry's synthetic active id, which needed no
      // registration). Mirrors `makeWiredHybridHost` below.
      registerWindowWithMachine({ kind: 'page-host', role: 'content', class: classifyWindowRegistration('content'), satellite: false, win: baseWin, contentWC: view.webContents });
      fakeHosts.set(baseWin.id, baseWin);
      return baseWin.id;
    },
    /**
     * Like `makeFakeHybridWindow` but ALSO installs the REAL
     * `wireHybridContentEvents` (the exact function the ipc.ts hybrid EARLY BRANCH
     * calls) on the content WC, so the content WC's `input-event` reveal stream is
     * driven by the production code — not a bridge stub. Tracked in `fakeHosts`
     * (so setHostBounds / hostWorkArea / showFakeHybridWindowInactive work), which
     * `makeWiredHybrid` (untracked, popup-focused) is not. Used by the top-border
     * reveal spec to exercise the idle-move→reveal forward end-to-end.
     */
    makeWiredHybridHost(bounds: { x: number; y: number; width: number; height: number }): number {
      const baseWin = new BaseWindowCtor({
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        frame: false, show: false, opacity: 0,
      });
      installFocusSim(baseWin);
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, sandbox: true },
      });
      baseWin.contentView.addChildView(view);
      try {
        const [w, h] = baseWin.getContentSize();
        view.setBounds({ x: 0, y: 0, width: w, height: h });
      } catch { /* getContentSize unsupported in some envs */ }
      registerHybridWindow(baseWin.id, { baseWin, contentWC: view.webContents });
      registerWindowWithMachine({ kind: 'page-host', role: 'content', class: classifyWindowRegistration('content'), satellite: false, win: baseWin, contentWC: view.webContents });
      fakeHosts.set(baseWin.id, baseWin);
      // Install the REAL content→overlay event forwarding (incl. the idle
      // top-band reveal path under test).
      wireHybridContentEvents(view.webContents, baseWin.id, 'about:blank', {});
      return baseWin.id;
    },
    setActive(id: number | null): boolean {
      // Machine equivalent of the old synthetic active-id set: dispatch a
      // synthetic show+focus (or, for null, hide the front page-host(s)). The
      // fake host is registered with the machine in makeFakeHybridWindow /
      // makeWiredHybridHost above.
      // The old bridge kept a SINGLE active-id slot: activating one host (or
      // null) meant no other host was active. The machine has no such slot —
      // `front` falls to the MRU successor on WINDOW_HIDDEN, and synthetically
      // activated fakes stay machine-visible forever (they are never OS-shown,
      // so no native 'hide' can fire). To keep the bridge's contract, EVERY
      // setActive first drives the page-host front to null by hiding whatever
      // page-host is front — repeatedly, since the closing assertion promotes
      // (and re-raises) the MRU successor each time. Bounded; each pass hides
      // one machine-visible page-host, so it terminates.
      const wid = id == null ? null : getWindowIdFor(id);
      if (id != null && wid == null) return false;
      for (let i = 0; i < 100; i++) {
        const front = getFrontPageHostId();
        if (front == null) break;
        dispatchWindowEvent({ type: 'WINDOW_HIDDEN', id: front });
      }
      if (wid != null) {
        dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: wid, focused: true });
      }
      return true;
    },
    /**
     * Drive the overlay's maximize TOGGLE for a window through the REAL content
     * gesture topic (`page:request-toggle-maximize`) — the exact signal the
     * content double-click publishes. The overlay's subscriber runs
     * `toggleMaximize()` (flips its `maximized` flag, publishes
     * `page:maximize`/`page:unmaximize`, which main resizes the host on). Used by
     * the maximize-state-sync spec to maximize a fake host and later toggle it,
     * so the overlay's own state is exercised end-to-end. `id` must be the active
     * hybrid window (the subscriber ignores non-active ids). Async (pubsub hop) —
     * callers poll the host bounds for the effect.
     */
    requestToggleMaximize(id: number): void {
      publish(getSystemAddress(), 'page:request-toggle-maximize', { windowId: id });
    },
    /**
     * Stage B: override the loading-timeout duration for the hung-load spec so
     * the 30 s production timer doesn't run the full test budget. The new value
     * is read by `wireHybridContentEvents` each time `did-start-loading` arms a
     * fresh timer — set this BEFORE navigating to the hung endpoint.
     */
    setHybridLoadingTimeoutMs(ms: number): void {
      _setHybridLoadingTimeoutMs(ms);
    },
    /**
     * Make a fake hybrid host visible WITHOUT stealing OS focus (`showInactive`,
     * stays opacity 0). Lets the keepLive close test assert the host was
     * actively HIDDEN (`isVisible()` true→false), not merely never shown.
     */
    showFakeHybridWindowInactive(id: number): boolean {
      const w = fakeHosts.get(id);
      if (!w || w.isDestroyed()) return false;
      try {
        w.showInactive();
      } catch {
        return false;
      }
      return true;
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
      // A host GAINING focus is by definition on screen, but the fake host was
      // never OS-shown, so the machine's record is not `visible` and the raw
      // OS_FOCUS_GAINED from the emit below would be front-INELIGIBLE (the
      // reducer gates front on visibility). Import the shown+focused state
      // explicitly, exactly like a real focused show does.
      {
        const wid = getWindowIdFor(w);
        if (wid != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: wid, focused: true });
      }
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
    /**
     * R5: drive ONLY the content WebContentsView's `'focus'` event (the
     * belt-and-suspenders signal a fresh non-headless show produces via
     * `contentWC.focus()`), NOT the host BaseWindow focus. The registry must
     * treat content-WC focus as activating so the active-hybrid id is set and the
     * overlay can reveal — even when the host-window focus event is missed.
     */
    focusContentWC(id: number): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return false;
      simFocus = id;
      simOverlayFocused = false;
      // Same visibility import as focusHost: content-WC focus implies the host
      // is on screen; without it the emit's OS_FOCUS_GAINED is front-ineligible.
      {
        const wid = getWindowIdFor(id);
        if (wid != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: wid, focused: true });
      }
      entry.contentWC.emit('focus');
      return true;
    },
    /**
     * R4/R7: the PURE hybrid show decision for a given headless-ness — what the
     * fresh-open show path WOULD do. Lets a focus-free test assert BOTH modes
     * (real OS focus is unobservable in a macOS-headless test): non-headless must
     * activate + focus the content WC; headless must stay inactive.
     */
    hybridShowIntent(
      headless: boolean,
      opts?: { inactive?: boolean; nonActivating?: boolean },
    ): {
      activated: boolean;
      contentFocused: boolean;
      showInactive: boolean;
    } {
      return hybridShowIntent(headless, {
        inactive: opts?.inactive === true,
        nonActivating: opts?.nonActivating === true,
      });
    },
    /**
     * R4/R7: drive the REAL ipc.ts show seam (`showHybridHost`) against a fake
     * host and return the applied intent. Under headless it must take the
     * inactive, focus-free branch. `opts.inactive` exercises the session-restore
     * path: a `show:false` open must NOT activate even in a NON-headless run —
     * each restored hybrid window activating itself is the wrong-focus-on-restart
     * regression.
     */
    showHybridHost(id: number, opts?: { inactive?: boolean; nonActivating?: boolean }): {
      activated: boolean;
      contentFocused: boolean;
      showInactive: boolean;
    } | null {
      const w = fakeHosts.get(id);
      const entry = getHybridWindow(id);
      if (!w || w.isDestroyed() || !entry || entry.contentWC.isDestroyed()) return null;
      return showHybridHost(w, entry.contentWC, opts);
    },
    /** Whether THIS run is headless (so the applied-show test asserts the right branch). */
    isHeadlessRun(): boolean {
      return isHeadless();
    },
    /**
     * R7 regression guard: the macOS activation policy the app applies for a
     * given headless-ness. null → leave default ('regular'); the REAL app must
     * NEVER be 'accessory'/'prohibited'. Pure decision (no getter exists in
     * Electron 40), so the invariant is assertable for both modes focus-free.
     */
    headlessActivationPolicy(headless: boolean): 'regular' | 'accessory' | 'prohibited' | null {
      return headlessActivationPolicy(headless);
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
      // "Focus landed on a non-hybrid window." Under the machine this is a real
      // front move (the old registry nulled its active id instead): drive focus
      // onto a lazily-created hidden NON-page-host machine window, so `front`
      // leaves the page-host set → getFrontPageHostId() goes null → the
      // overlay hides and activeId() reports null, exactly the old bridge
      // contract. (The other "left the group" case — focus moving to ANOTHER
      // APP — keeps `front` by design and hides the chrome via
      // did-resign-active; tests drive that path with appResignActive.)
      if (!elsewhereWin || elsewhereWin.isDestroyed()) {
        elsewhereWin = new BaseWindowCtor({ show: false, frame: false, opacity: 0, width: 60, height: 40 });
        registerWindowWithMachine({
          kind: 'browser',
          role: 'workspace',
          class: classifyWindowRegistration('workspace'),
          satellite: false,
          win: elsewhereWin,
          // A bare BaseWindow has no root webContents for the Esc interceptor.
          attachEscHandler: false,
        });
      }
      const wid = getWindowIdFor(elsewhereWin);
      if (wid != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: wid, focused: true });
    },
    runDeferredBlur(_id: number): number | null {
      // The machine's deferred-blur settle lives in the OS adapter (setImmediate)
      // and keeps `front` on an app-switch (design divergence #2), so there is no
      // synchronous per-window "decide after blur" hook. Best-effort: report the
      // current front page host.
      return frontPageHostOsId();
    },
    activeId(): number | null {
      return frontPageHostOsId();
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
      // The focus-group is now structural: the chrome overlay registers with the
      // machine as a satellite, so its OS focus is accounted for by the adapter's
      // deferred-blur settle. No provider to install — kept as a no-op so the
      // E2E bridge surface is unchanged.
      void simOverlayFocused;
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
     * The host BaseWindow's native fullscreen state + the machine record's
     * maximize bookkeeping (`maximized` / `preMaxBounds` — §5 step 7B). The
     * content triple-click fullscreen-desync spec (peek d8ce0ddf) uses
     * `isFullScreen` to sequence around the ASYNC native enter/leave-full-screen
     * transitions (confirmed to fire in macOS-headless) and
     * `maximized`/`preMaxBounds` to assert the state machine stays consistent
     * with the window's actual bounds across a fullscreen round-trip. Returns
     * null if the id is not a live hybrid window.
     */
    hostFullscreenState(
      id: number,
    ): {
      isFullScreen: boolean;
      nativeFullScreen: boolean;
      maximized: boolean;
      preMaxBounds: { x: number; y: number; width: number; height: number } | null;
    } | null {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return null;
      const machineId = getWindowIdFor(id);
      const machineRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;
      try {
        return {
          isFullScreen: entry.baseWin.isFullScreen(),
          nativeFullScreen: machineId != null && getWindowModeName(machineId) === 'fullscreen',
          maximized: machineRec?.maximized === true,
          preMaxBounds: machineRec?.maximized === true ? machineRec.preMaxBounds : null,
        };
      } catch {
        return null;
      }
    },
    /**
     * Batch C (headless-flash / focus-theft gates): read a hybrid host
     * BaseWindow's current visibility, opacity, and focus. The hybrid content
     * window is a BaseWindow, invisible to `BrowserWindow.fromId`, so the
     * headless-no-permission-flash / headless-no-focus-theft specs can no longer
     * read `fromId(id).isVisible()/getOpacity()/isFocused()`. They read them here
     * instead to assert the host stays hidden (never painted: opacity 0 or not
     * shown — never a 0→nonzero flash) and never steals OS focus on open.
     * Returns null if the id is not a live hybrid window.
     */
    hostVisibility(
      id: number,
    ): { visible: boolean; opacity: number; focused: boolean } | null {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return null;
      try {
        return {
          visible: entry.baseWin.isVisible(),
          opacity: entry.baseWin.getOpacity(),
          focused: entry.baseWin.isFocused(),
        };
      } catch {
        return null;
      }
    },
    /**
     * The host BaseWindow's current background color (hex). Used by the
     * load-start-show spec to assert the hybrid host paints an opaque theme
     * loading-fill (light #ffffff / dark #1e1e1e) the moment it's shown — so the
     * early frame reads as a loading surface, not an empty white box. Returns
     * null if the host is gone or getBackgroundColor is unsupported.
     */
    hostBackgroundColor(id: number): string | null {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return null;
      try {
        return entry.baseWin.getBackgroundColor();
      } catch {
        return null;
      }
    },
    /** Test: has this window painted a frame yet (firstLoad gate for the loading card). */
    hybridHasPainted(id: number): boolean {
      return hasHybridPainted(id);
    },
    /** Test: current same-URL Retry attempt count for the window (retry-cap spec). */
    hybridRetryAttempts(id: number): number {
      return getHybridRetryAttempts(id);
    },
    /** Test: does the window currently have an outstanding load failure (retry-cap spec). */
    hybridHasOutstandingFailure(id: number): boolean {
      return hasHybridOutstandingFailure(id);
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
     * dispatch the SAME events the backend's `attachAppListeners` emits for
     * `'did-resign-active'`/`'did-become-active'` — the machine flips
     * `appActive` and the overlay's `subscribeAppActive` edge runs the very
     * production handler. After resign: the overlay must be forced
     * click-through (captureState false) and drop its floating level
     * (overlayState().alwaysOnTop false). After become: floating restored
     * (alwaysOnTop true) and click-through re-armed with forwarding.
     */
    simAppResignActive(): boolean {
      dispatchWindowEvent({ type: 'APP_RESIGNED' });
      return true;
    },
    simAppBecomeActive(): boolean {
      dispatchWindowEvent({ type: 'APP_ACTIVATED' });
      return true;
    },
    /** R1: whether the machine currently considers the app active. */
    appActiveState(): boolean {
      return getAppActive();
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
      return expandToOverlayFrame(content, workAreaNearest(content));
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
     * Regression repro (peek bebfd212): drive a REAL modified left-click on a
     * hybrid host's content WC at (x,y). A synthetic JS `.click()` with `metaKey`
     * set does NOT carry modifier state into Chromium's navigation-disposition
     * computation — only a real `sendInputEvent` does — so this is the only way
     * to reproduce the cmd/ctrl+click "background-tab" open path, where the
     * content `setWindowOpenHandler`'s `createWindow` callback receives NO opener
     * `webContents` to adopt (Chromium defers the guest) and must load the target
     * URL itself. Returns true if the events dispatched. Focus-free.
     */
    sendContentModifiedClick(id: number, x: number, y: number, modifier: string): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return false;
      const wc = entry.contentWC;
      try {
        const mods = [modifier] as unknown as Electron.MouseInputEvent['modifiers'];
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers: mods });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers: mods });
        return true;
      } catch {
        return false;
      }
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
    /**
     * Read the overlay renderer's live maximize state ({maximized, preMaxBounds})
     * for the active window — the state the page-overlay:active handoff must
     * RECONCILE (not clobber) when a maximized window loses+regains active.
     * Resolves null if no overlay window / renderer not ready.
     */
    overlayMaximizeState(): Promise<{ maximized: boolean; preMaxBounds: unknown } | null> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(window.__overlayMaximizeStateForTests ? window.__overlayMaximizeStateForTests() : null)`,
        )
        .catch(() => null);
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
     * Permission-prompt verification: read the overlay's `.permission-prompt`
     * DOM state (visible prompt, origin/label text, pending badge, favicon) plus
     * the renderer's full request queue (via the overlay.js test hook), so a
     * spec can assert "exactly one visible prompt + N queued" focus-free.
     * Resolves null if no overlay / renderer not ready. Pure executeJavaScript.
     */
    overlayPermissionPromptState(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const prompts = Array.from(document.querySelectorAll('.permission-prompt'));
            const p = prompts[0] || null;
            const badge = p ? p.querySelector('.permission-prompt-pending-badge') : null;
            const favicon = p ? p.querySelector('.permission-prompt-favicon') : null;
            const origin = p ? p.querySelector('.permission-prompt-origin') : null;
            const q = typeof window.__permissionPromptQueueForTests === 'function'
              ? window.__permissionPromptQueueForTests()
              : null;
            return {
              ready: window.__overlayReady === true,
              present: prompts.length > 0,
              promptCount: prompts.length,
              requestId: p ? (p.dataset.requestId || null) : null,
              origin: origin ? origin.textContent : null,
              text: p ? p.textContent : '',
              badgeVisible: !!(badge && badge.style.display !== 'none'),
              badgeText: badge ? badge.textContent : null,
              faviconSrc: favicon ? favicon.getAttribute('src') : null,
              queuedCount: q ? q.length : null,
              queuedIds: q ? q.map((r) => r.requestId) : null,
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Permission-prompt verification: drive the visible prompt's Allow/Deny
     * button via a DOM click in the overlay renderer (the sanctioned focus-free
     * stand-in for a real pointer click — real clicks need OS focus/capture a
     * headless run can't grant). Optionally checks the "Remember this decision"
     * checkbox first (also via click, the same event path a user takes).
     * Resolves true if a prompt existed and the button was clicked.
     */
    clickPermissionPrompt(allow: boolean, remember?: boolean): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const p = document.querySelector('.permission-prompt');
            if (!p) return false;
            if (${remember === true}) {
              const cb = p.querySelector('.permission-prompt-remember input[type="checkbox"]');
              if (cb && !cb.checked) cb.click();
            }
            const btn = p.querySelector(${allow ? "'.permission-prompt-allow'" : "'.permission-prompt-deny'"});
            if (!btn) return false;
            btn.click();
            return true;
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Permission-prompt test hygiene: clear the overlay renderer's request
     * queue + prompt DOM (overlay.js test hook), so per-test state can't bleed
     * across specs sharing the singleton overlay. Resolves false when there is
     * no overlay renderer yet (nothing to reset).
     */
    resetPermissionPromptsForTests(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            if (typeof window.__resetPermissionPromptsForTests !== 'function') return false;
            window.__resetPermissionPromptsForTests();
            return true;
          })()`,
        )
        .catch(() => false);
    },
    /** Backend assertion hook: permission-handler's pending-request count. */
    pendingPermissionRequestCount(): number {
      return _pendingRequestCountForTests();
    },
    /** Backend test hygiene: clear permission-handler's pending-request map. */
    resetPermissionHandlerForTests(): void {
      _resetPermissionHandlerForTests();
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
     * Top-border reveal (peek 363e7cff): drive the REAL content→overlay reveal
     * path the maximized / no-gutter case depends on. Emits a genuine idle
     * (no-button) `input-event` `mouseMove` on the fake host's content
     * WebContentsView at `dyBelowTop` px below the host window's top edge (screen
     * coords) — exactly the event Electron delivers when the pointer hovers the
     * content top border. The `wireHybridContentEvents` input-event handler then
     * decides whether to forward `page-overlay:content-pointer {phase:'reveal'}`,
     * which the overlay's content-pointer subscriber turns into showNavbar().
     *
     * This is the path that was DEAD before the fix: idle moves were never
     * forwarded (only button-held moves), so a content-WC-starved overlay never
     * revealed on a top-border gesture. The publish→overlay delivery is async
     * (cross-process pubsub), so the caller polls `overlayChromeState().navbarVisible`
     * after this resolves. Focus-free (no OS pointer / focus). Returns whether the
     * event was emitted (false if the host / content WC is gone).
     */
    /**
     * Force the overlay navbar HIDDEN immediately (no 400ms grace timer) so a
     * shared-app test can deterministically reset to the hidden state between
     * reveal assertions. Dispatches `mouseleave` on the navbar then removes the
     * `visible` class directly. Returns the navbar's visible state (should be
     * false). Focus-free.
     */
    hideOverlayChrome(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const nb = document.getElementById('navbar');
            if (!nb) return false;
            nb.classList.remove('visible');
            document.body.classList.remove('chrome-visible');
            document.body.classList.remove('panels-visible');
            window.__overlayHidePending = false;
            return nb.classList.contains('visible');
          })()`,
        )
        .catch(() => false);
    },
    /**
     * Cmd+L repeat-press regression (peek a500e36f): dispatch a real Cmd+L keydown
     * INTO the overlay renderer's document — the exact event that lands there on the
     * SECOND+ Cmd+L press (once press 1 has focused the overlay window, the content
     * WC is no longer first-responder, so its before-input stops firing and the
     * keydown is delivered to the overlay renderer instead). Exercises the overlay's
     * own capture-phase keydown handler → openNavbarFocused re-reveal path. Focus-free:
     * pure executeJavaScript, no OS key event. Resolves true if dispatched.
     */
    dispatchOverlayCmdL(): Promise<boolean> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(false);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'l', metaKey: true, bubbles: true, cancelable: true, composed: true,
            }));
            return true;
          })()`,
        )
        .catch(() => false);
    },
    emitContentTopEdgeHover(id: number, dyBelowTop: number): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed() || entry.baseWin.isDestroyed()) return false;
      try {
        const top = entry.baseWin.getBounds().y;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry.contentWC as unknown as { emit: (...a: unknown[]) => void }).emit(
          'input-event',
          {},
          { type: 'mouseMove', globalX: 100, globalY: top + dyBelowTop },
        );
      } catch {
        return false;
      }
      return true;
    },
    /**
     * Emit ONE raw mouse `input-event` on a wired host's content WC in SCREEN
     * coords — the same payload shape the native stream delivers (see
     * `emitContentTopEdgeHover`, same technique). Sequence mouseDown →
     * mouseMove… → mouseUp to drive a real edge/corner resize drag through
     * `wireHybridContentEvents`' production handler (resizeDirAt → applyResize,
     * and the resize-start maximize exit).
     *
     * Deliberately NOT `sendInputEvent`: the resize path reads globalX/globalY,
     * and whether sendInputEvent echoes those back onto `input-event` is
     * unestablished here (Electron's `InputEvent` payload type doesn't even
     * declare them). The emit path is what the top-edge-hover bridge already
     * proves out, so it's the known-good way to exercise this code.
     *
     * Only meaningful on a host built by `makeWiredHybridHost` — an unwired
     * `makeFakeHybridWindow` host has no `input-event` listener to receive it.
     */
    emitContentMouse(id: number, type: string, globalX: number, globalY: number): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed() || entry.baseWin.isDestroyed()) return false;
      try {
        (entry.contentWC as unknown as { emit: (...a: unknown[]) => void }).emit(
          'input-event',
          {},
          { type, button: 'left', globalX, globalY },
        );
      } catch {
        return false;
      }
      return true;
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
     * Pure executeJavaScript; instead of guessing a wall-clock margin for the
     * hold timer, it POLLS the live FSM until `pending → ready` actually fires
     * (the overlay is opacity:0/occluded in headless, so Chromium
     * background-throttles its threshold setTimeout — a fixed sleep would let the
     * first move land while still `pending`, reading as a pre-threshold cancel).
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
            // Wait for the hold transition to ACTUALLY fire (pending → ready),
            // not a fixed sleep: under a loaded/occluded renderer the threshold
            // setTimeout is throttled and can land well past any guessed margin,
            // and a pre-threshold move cancels candidacy. Poll the live FSM (it
            // sends no movement, so it can't cancel). The 8s bound only backstops
            // a stuck timer; the Playwright test timeout is the real ceiling.
            const deadline = Date.now() + 8000;
            let held = false;
            while (Date.now() < deadline) {
              if (t.holdDrag._state().ready) { held = true; break; }
              await new Promise((r) => setTimeout(r, 25));
            }
            if (!held) return false;
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
     * Regression repro for the hold-to-drag flake (peek 73681521 / 7064b15c):
     * a stray `buttons:0` mousemove landing DURING the hold window must NOT
     * cancel a legitimate held-still press. Identical to `holdDragNavbar`, but
     * immediately after the mousedown (guaranteed `pending`, before the threshold
     * timer fires) it dispatches a zero-button document mousemove — the exact OS
     * jitter event (overlay retarget → synthesized buttons=0 move) that used to
     * reset the FSM mid-hold. Pre-fix that stray move calls `onUp()` → `reset()`
     * so the hold never fires and this resolves false; post-fix the FSM ignores
     * a buttons-cleared signal while pending, the hold fires, and the drag runs.
     * Determinism: we inject the stray move ourselves (not waiting for real
     * jitter) and still POLL the live FSM for `ready` exactly like holdDragNavbar.
     */
    holdDragNavbarStrayZeroButton(dxScreen: number, dyScreen: number): Promise<boolean> {
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
            // STRAY zero-button move DURING pending (before the hold timer fires).
            // Same position (pure jitter, no travel). This is the regressor: a
            // synthesized buttons=0 move from the overlay window retargeting.
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 0, screenX: startX, screenY: startY, bubbles: true,
            }));
            // Now wait for the hold to fire, exactly like holdDragNavbar. If the
            // stray move reset the FSM (pre-fix), buttonDown is cleared and the
            // timer body no-ops, so 'ready' never arrives and we time out false.
            const deadline = Date.now() + 8000;
            let held = false;
            while (Date.now() < deadline) {
              if (t.holdDrag._state().ready) { held = true; break; }
              await new Promise((r) => setTimeout(r, 25));
            }
            if (!held) return false;
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
     * Start-surface guard coverage (gap 2), PURE + focus-free. Exercises the
     * overlay's exported `shouldBlockOverlayDrag` — which walks `composedPath`
     * (shadow-aware) and blocks only actively-focused inputs / [data-no-drag]
     * sub-elements — with synthetic element descriptors carrying a fake
     * composedPath. No dependency on real DOM focus (unreliable in an occluded
     * headless overlay); the composedPath SHADOW-piercing itself is provided by
     * the browser at the real call site, so it needs no runtime test. Resolves a
     * map of {case → wouldBlock}: false means hold-drag STARTS, true means BLOCKED.
     */
    overlayDragBlockCases(): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      return overlayWin.webContents
        .executeJavaScript(
          `(() => {
            const t = globalThis.__peekHoldDragTest;
            if (!t || typeof t.shouldBlockOverlayDrag !== 'function') return null;
            const block = t.shouldBlockOverlayDrag;
            const mkEl = (o) => {
              const el = {
                nodeType: 1,
                tagName: (o.tag || 'div').toUpperCase(),
                isContentEditable: !!o.contentEditable,
                closest: (sel) => (o.noDrag && sel === '[data-no-drag]') ? el : null,
                getRootNode: () => ({ activeElement: o.active ? el : null }),
              };
              return el;
            };
            const evt = (el) => ({ composedPath: () => [el] });
            const run = (o) => block(evt(mkEl(o)));
            return {
              urlInputUnfocused: run({ tag: 'input', active: false }),
              urlInputFocused: run({ tag: 'input', active: true }),
              widget: run({ tag: 'div' }),
              dataNoDrag: run({ tag: 'div', noDrag: true }),
              focusedTextarea: run({ tag: 'textarea', active: true }),
              focusedEditable: run({ tag: 'div', active: true, contentEditable: true }),
            };
          })()`,
        )
        .catch(() => null);
    },
    /**
     * Cursor-signal coverage (gap 1). Drives the LIVE hold-to-drag gesture (real
     * FSM + real effects) through the SAME poll-for-`ready` path holdDragNavbar
     * uses, while a main-side subscription (unique source, so it coexists with the
     * production page:drag-cursor handler) records every published
     * `page:drag-cursor {windowId, state}`. A genuine hold→drag→release must emit
     * exactly ['grab' (hold fired), 'grabbing' (drag started), null (released)],
     * each tagged with the active host id. Resolves { ran, signals }. Determinism:
     * polls the live FSM for `ready` (not a fixed sleep), then polls the recorded
     * array until the terminal null arrives over the async renderer→main pubsub.
     */
    holdDragCursorSignals(dxScreen: number, dyScreen: number): Promise<unknown> {
      if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve(null);
      const src = 'test-dragcursor-' + Date.now();
      const rec: Array<{ windowId: number; state: string | null }> = [];
      subscribe(src, 'page:drag-cursor', (raw) => {
        const m = raw as { windowId?: number; state?: string | null };
        if (typeof m.windowId === 'number') {
          rec.push({ windowId: m.windowId, state: m.state ?? null });
        }
      });
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
            const deadline = Date.now() + 8000;
            let held = false;
            while (Date.now() < deadline) {
              if (t.holdDrag._state().ready) { held = true; break; }
              await new Promise((r) => setTimeout(r, 25));
            }
            if (!held) return false;
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 1, screenX: startX + 1, screenY: startY + 1, bubbles: true,
            }));
            document.dispatchEvent(new MouseEvent('mousemove', {
              buttons: 1,
              screenX: startX + ${Math.round(dxScreen)},
              screenY: startY + ${Math.round(dyScreen)},
              bubbles: true,
            }));
            document.dispatchEvent(new MouseEvent('mouseup', {
              button: 0, buttons: 0, bubbles: true,
            }));
            return true;
          })()`,
        )
        .then(async (ran) => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            if (rec.some((r) => r.state === null)) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          unsubscribe(src, 'page:drag-cursor');
          return { ran, signals: rec };
        })
        .catch(() => {
          unsubscribe(src, 'page:drag-cursor');
          return null;
        });
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
     * Test-only: publish page:execute-script and resolve with the matching
     * page:script-result. Exercises the SAME main pubsub path the extension uses.
     */
    runPageScript(extensionId: string, requestId: string, script: string): Promise<unknown> {
      return new Promise((resolve) => {
        const src = 'test-exec-' + requestId;
        subscribe(src, 'page:script-result', (raw) => {
          const m = raw as { requestId?: string };
          if (m.requestId !== requestId) return;
          unsubscribe(src, 'page:script-result');
          resolve(m);
        });
        publish('test-exec', 'page:execute-script', { extensionId, requestId, script });
      });
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
     * OAuth bridge: evaluate arbitrary `code` inside a hybrid window's content
     * webContents and resolve with its result. Resolves `undefined` if the
     * window is gone/destroyed or the script throws.
     */
    evalInHybridContent(id: number, code: string): Promise<unknown> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(undefined);
      return entry.contentWC.executeJavaScript(code, true).catch(() => undefined);
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
    /**
     * The window-state machine's WindowId for an Electron window id, or null if
     * the machine has never seen the window. Lets specs assert the registration
     * invariant ("every window registers with the machine") — e.g. that a
     * window.open popup adopted into a hybrid host is machine-registered.
     */
    machineWindowIdFor(id: number): string | null {
      return getWindowIdFor(id);
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
     * page in the list. Empty only when no hybrid windows are registered
     * (hybrid is the only page-host path now, not a flag-gated one).
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

    // ── Cluster B (R1/R2/R3) menu + accelerator routing, focus-free ──────────
    /**
     * R1: the id `BrowserWindow.getFocusedWindow()` reports — null for a hybrid
     * page-host (a BaseWindow), which is the whole reason cmd+W's old
     * getFocusedWindow()-based close handler no-op'd on a hybrid host. A test
     * asserts this is null while a hybrid window is the active one, proving the
     * close path can't rely on it.
     */
    focusedBrowserWindowId(): number | null {
      const w = BrowserWindow.getFocusedWindow();
      return w ? w.id : null;
    },
    /** R1: whether a hybrid host id still has a live (non-destroyed) BaseWindow. */
    hybridWindowExists(id: number): boolean {
      const entry = getHybridWindow(id);
      return !!entry && !entry.baseWin.isDestroyed();
    },
    /**
     * R1: drive the EXACT cmd+W close path the menu item / non-darwin shortcut
     * use — `closeFocusedWindow()` resolves a focused BrowserWindow OR (none →)
     * the registry's active-hybrid window and closes it. Returns the id it acted
     * on (or null). A focus-free test sets a fake hybrid window active (no real
     * BrowserWindow is focused in a headless run, so getFocusedWindow() is null —
     * the real-world hybrid-frontmost condition) and asserts this closes it.
     */
    closeFocusedWindow(): number | null {
      return closeFocusedWindow();
    },
    /**
     * cmd+W overlay redirect: whether the registry recognises `id` as the shared
     * chrome overlay window. Proves `initHybridOverlay` registered the
     * overlay-id provider against the REAL singleton, so when the overlay is the
     * focused BrowserWindow (address bar/widgets open) the close resolver
     * redirects to the active hybrid host instead of closing the chrome alone.
     * (The overlay-IS-focused case itself needs real OS focus — unobservable
     * headless — so the redirect decision is covered by the `resolveCloseTargetId`
     * unit; this verifies the wiring that feeds it.)
     */
    isHybridOverlayWindowId(id: number): boolean {
      return overlayWin != null && !overlayWin.isDestroyed() && overlayWin.id === id;
    },
    /**
     * ESC-close (peek e8081cce companion): build a wired hybrid page-host AND
     * register it in the shared window registry with the given window params
     * (role / escapeMode / address), so the ESC policy path resolves role the
     * SAME way it does for a real peek/slide (`role:'quick-view'`). `makeWiredHybrid`
     * alone never registers window params, so its `getWindowInfo` is empty and
     * the policy can't classify it. Returns the new hybrid window id.
     */
    makeRoledHybrid(
      dataUrl: string,
      params: Record<string, unknown>,
    ): Promise<number | null> {
      // Same build as makeWiredHybrid (installs the REAL wireHybridContentEvents
      // before-input-event handler), plus a shared-registry window record so the
      // ESC policy can resolve role/escapeMode.
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
      const roledRole = (params.role as string) || 'content';
      registerWindowWithMachine({
        kind: 'page-host',
        role: roledRole,
        class: classifyWindowRegistration(roledRole),
        satellite: roledRole === 'overlay' || roledRole === 'palette',
        escapeMode: params.escapeMode as ('auto' | 'close' | 'navigate' | 'ignore' | undefined),
        win: baseWin,
        contentWC: view.webContents,
      });
      wireHybridContentEvents(view.webContents, baseWin.id, dataUrl, {});
      registerWindow(baseWin.id, 'test-esc', { address: dataUrl, ...params });
      return view.webContents
        .loadURL(dataUrl)
        .then(() => baseWin.id)
        .catch(() => baseWin.id);
    },
    /**
     * ESC-close: drive the EXACT hybrid ESC policy path (`handleHybridEscape` →
     * escPolicy/escUnhandledPolicy → closeOrHideWindow), awaitable so a test is
     * deterministic (no polling for the async renderer-ask timeout). A roled
     * hybrid whose content WC registered no `onEscape` resolves once the policy
     * decision (and any close) has run. Returns the window id (or null when the
     * hybrid window is gone).
     */
    runHybridEscape(id: number): Promise<number | null> {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return Promise.resolve(null);
      // Decision now lives in the machine — dispatch ESC_PRESSED (the landed id
      // is first-responder noise; decideEscape targets `front`).
      dispatchWindowEvent({ type: 'ESC_PRESSED', landedId: getWindowIdFor(id) ?? 'global' });
      // Honor the pre-cutover contract (the old impl AWAITED the full
      // handleHybridEscape round trip) DETERMINISTICALLY: the adapter tracks
      // the async work its effects spawned — the ASK_RENDERER `escape-pressed`
      // round trip and a policy-close's `closeOrHideWindow` — and this awaits
      // that same-channel settlement (`waitForPendingWindowEffects`). No timer
      // loop, and no deadline re-derived from (and silently coupled to)
      // `askWebContentsToHandleEscape`'s ask timeout: a non-closing ESC
      // (renderer handled / pass-through / switcher) resolves as soon as its
      // round trip does, and if the ask timeout ever changes this waits
      // exactly as long as the real path does. The cutover's fire-and-forget
      // version resolved before the ask timeout ever fired, so every
      // policy-path ESC spec read state too early.
      return waitForPendingWindowEffects().then(() => id);
    },
    /**
     * ESC-close: resolve once a hybrid host id is GONE from the registry (its
     * BaseWindow destroyed), or false on timeout. Lets a test that drove the REAL
     * `before-input-event` (fire-and-forget `handleHybridEscape`) await the
     * async close deterministically instead of fixed-sleeping.
     */
    waitHybridGone(id: number, timeoutMs = 4000): Promise<boolean> {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
          const entry = getHybridWindow(id);
          if (!entry || entry.baseWin.isDestroyed()) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 25);
        };
        poll();
      });
    },
    /**
     * R2/R3: drive the hybrid content WC's `before-input-event` handler
     * SYNTHETICALLY with a parsed key (focus-free; real keystrokes need OS focus
     * a headless run can't grant). Emits the same `(event, input)` shape Electron
     * delivers; the handler's leftover-modifier branch routes to
     * handleLocalShortcut. Returns whether the synthetic event was
     * `preventDefault()`-ed (i.e. a local shortcut consumed it).
     *
     * `key` is the logical key (e.g. 'n'); modifiers default to the
     * platform's primary (meta on darwin, control elsewhere). `code` is derived
     * for the common letters so before-input-event matching (which keys on
     * `input.code`) works the same as a real keystroke.
     */
    dispatchContentKey(
      id: number,
      key: string,
      opts?: { meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean },
    ): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return false;
      const isDarwin = process.platform === 'darwin';
      const meta = opts?.meta ?? (isDarwin ? true : false);
      const control = opts?.control ?? (isDarwin ? false : true);
      const code =
        key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
      let prevented = false;
      const fakeEvent = {
        preventDefault() {
          prevented = true;
        },
      };
      const input = {
        type: 'keyDown',
        key,
        code,
        meta,
        control,
        alt: opts?.alt ?? false,
        shift: opts?.shift ?? false,
      };
      try {
        entry.contentWC.emit('before-input-event', fakeEvent, input);
      } catch {
        /* handler threw — treat as not prevented */
      }
      return prevented;
    },
    /**
     * peek 51798bae: simulate the universal content preload reporting whether an
     * editable element is focused. The data: URLs these tests use get no preload
     * (non-http(s)), so the real focusin/focusout → page:editable-focus signal
     * never fires; this seeds the SAME cache that IPC feeds, keyed by the content
     * WC id the hybrid ESC gate reads (isEditableFocusedForWc(contentWC.id)).
     * Returns false if the id is not a live hybrid host.
     */
    setContentEditableFocus(id: number, editable: boolean): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.contentWC.isDestroyed()) return false;
      __setEditableFocusForWcForTest(entry.contentWC.id, editable);
      return true;
    },
    /**
     * R3: register a probe LOCAL shortcut and return a token a test can use to
     * assert it fired (via `probeShortcutFireCount`) when driven through the
     * hybrid content WC's before-input-event. Proves the leftover-modifier
     * branch reaches the SAME handleLocalShortcut dispatcher the canvas/core
     * windows use. The probe is registered under a throwaway source so it never
     * collides with a real binding.
     */
    registerProbeShortcut(accelerator: string): void {
      __probeShortcutFireCount = 0;
      registerLocalShortcut(accelerator, '__cluster-b-probe', () => {
        __probeShortcutFireCount++;
      });
    },
    unregisterProbeShortcut(accelerator: string): void {
      unregisterLocalShortcut(accelerator, '__cluster-b-probe');
    },
    probeShortcutFireCount(): number {
      return __probeShortcutFireCount;
    },
    /**
     * keepLive regression (2026-06-09): `makeFakeHybridWindow` registers the
     * window in the hybrid registry but NOT in the window-manager registry
     * (`registerWindow`), so `getWindowInfo(id)` is undefined and the close path
     * can't read `params.keepLive`. The real hybrid open ALWAYS calls
     * `registerWindow(baseWin.id, source, windowParams)` (ipc.ts ~2211). This
     * hook seeds the same registry entry so a test can mark a fake hybrid host
     * `keepLive: true` (the music-slide case) or `false` and then drive a close
     * path that must hide-vs-destroy on that flag. Returns false if the id is
     * not a live fake hybrid host.
     */
    registerHybridWindowParams(id: number, params: Record<string, unknown>): boolean {
      const entry = getHybridWindow(id);
      if (!entry || entry.baseWin.isDestroyed()) return false;
      registerWindow(id, params.source ? String(params.source) : 'page', params);
      return true;
    },
    /**
     * keepLive regression: drive the EXACT close path that app-switch dismissal
     * (`window-state.ts selectAppResignTransients`) and focus-driven autoclose
     * (`selectTransientAutoclose`) funnel a hybrid peek/slide through —
     * `closeOrHideWindow(id)`. A keepLive:true hybrid host must be HIDDEN (its
     * BaseWindow stays live, just `isVisible() === false`); a keepLive:false one
     * must be CLOSED (BaseWindow destroyed, dropped from the registry). The test
     * reads the outcome via `hybridWindowExists(id)` / `hostVisibility(id)`.
     */
    closeOrHideHybrid(id: number): Promise<void> {
      // Async now (hybrid branch awaits a fullscreen exit before the terminal
      // hide/close). Return the promise so a test can await the full close.
      return closeOrHideWindow(id);
    },
    /**
     * Drive a hybrid host's native fullscreen through the SINGLE production owner
     * (`setHybridHostFullScreen`) — the exact code the `fullscreen` command runs
     * via tile:window:fullscreen. Lets the disruptive fullscreen spec exercise the
     * command's transition (enter/leave settle on the native events) without
     * fabricating a token/grant. Resolves when the transition settles (or the
     * bounded timeout fires). Read the outcome via `hostFullscreenState(id)`.
     */
    driveHostFullscreen(id: number, desired: boolean): Promise<void> {
      // Drive through the machine (the single setFullScreen owner) exactly as the
      // `fullscreen` command does. Pass current bounds for the preBounds stash.
      const boundsWin = getHybridWindow(id)?.baseWin ?? null;
      let bounds: { x: number; y: number; width: number; height: number } | null = null;
      try { if (boundsWin && !boundsWin.isDestroyed()) bounds = boundsWin.getBounds(); } catch { /* gone */ }
      const machineId = getWindowIdFor(id);
      if (machineId == null) return Promise.resolve();
      dispatchWindowEvent({ type: 'FULLSCREEN_REQUESTED', id: machineId, desired, bounds });
      return waitForMode(machineId, desired ? 'fullscreen' : 'normal');
    },
  };
}
