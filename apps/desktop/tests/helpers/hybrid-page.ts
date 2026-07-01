/**
 * Shared hybrid page-host test helper.
 *
 * The hybrid page-host is the only page-host implementation (the legacy
 * canvas `<webview>` page host was removed). It's an OPAQUE content
 * `BaseWindow` plus a separate transparent OVERLAY window that paints the
 * chrome (navbar + side panels + widgets). Specs that used to assert against
 * the canvas page's in-window DOM (`#navbar` etc.) cannot do that anymore —
 * the chrome lives in a different window owned by the main process.
 *
 * This module packages the existing E2E test bridge
 * (`globalThis.__peekHybridOverlayTest`, installed by `main/hybrid-overlay.ts`
 * under E2E_TEST) so spec authors drive the content/overlay pair through one
 * small, typed surface instead of re-deriving the bridge in every
 * `app.evaluateMain` call.
 *
 * Everything here is FOCUS-FREE: hybrid hosts are real (headless, opacity-0,
 * never-shown) BaseWindows; active-window changes are synthetic (`setActive`),
 * and chrome reveal is driven through the renderer's own trigger-zone /
 * `page:show-navbar` paths via `executeJavaScript` / pubsub — never real OS
 * focus — so a hybrid-driving spec can never steal the user's window focus.
 *
 * Build EXCLUSIVELY on bridge methods that already exist; this file adds no new
 * main-process surface.
 */

import { expect } from '@playwright/test';
import { DesktopApp } from '../fixtures/desktop-app';

/** Handle to an opened hybrid page-host (content window + its content WC). */
export interface HybridPageHandle {
  /** The content `BaseWindow` id (the hybrid window id used by every bridge call). */
  id: number;
  /** The content `WebContents` id, or null if the content WC was unavailable. */
  contentWcId: number | null;
}

/** Painted chrome state read from the overlay renderer DOM (focus-free). */
export interface OverlayChromeState {
  ready: boolean;
  noActive: boolean;
  navbarVisible: boolean;
  url: string;
  inputValue: string | null;
  navbarInputFocused: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  pageTitle: string;
  favicon: string;
  findVisible: boolean;
  findCount: string | null;
  findInputValue: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Is the hybrid overlay E2E bridge present? The hybrid page-host is now the
 * only page-host implementation, so this is only false before any hybrid page
 * has actually been opened (the bridge installs lazily on first use). Specs
 * guard with `test.skip(!(await hybridBridgePresent(app)), '...')`.
 */
export async function hybridBridgePresent(app: DesktopApp): Promise<boolean> {
  return app.evaluateMain!(() =>
    Boolean((globalThis as Record<string, unknown>).__peekHybridOverlayTest),
  );
}

/**
 * Wait until the overlay renderer has loaded + subscribed
 * (`window.__overlayReady`), so chrome-state reads and pubsub-driven reveals
 * (Cmd+L, loading) are observable. The overlay is created lazily on the first
 * `setActive`, then its renderer loads asynchronously.
 */
export async function waitOverlayReady(app: DesktopApp): Promise<void> {
  await expect
    .poll(async () =>
      app.evaluateMain!(async () => {
        const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
          overlayChromeState(): Promise<{ ready?: boolean } | null>;
        };
        const s = await b.overlayChromeState();
        return s ? s.ready === true : false;
      }),
    )
    .toBe(true);
}

/**
 * Open a hybrid page-host on `url`, load its content, and (by default) make it
 * the active window so the singleton chrome overlay frames it. When activated,
 * also waits for the overlay renderer to be ready so chrome-state reads and
 * pubsub-driven reveals are immediately observable.
 *
 * Returns a {@link HybridPageHandle}. The content load runs to completion
 * before resolving; pass a `data:` URL for deterministic, network-free content.
 *
 * @param opts.bounds   content window outer bounds (default 800x600 at 100,100)
 * @param opts.activate make this the active hybrid window after load (default true)
 */
export async function openHybridPage(
  app: DesktopApp,
  url: string,
  opts: { bounds?: Rect; activate?: boolean } = {},
): Promise<HybridPageHandle> {
  const bounds = opts.bounds ?? { x: 100, y: 100, width: 800, height: 600 };
  const activate = opts.activate ?? true;

  const handle = await app.evaluateMain!(
    async (_e, arg) => {
      const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
        makeFakeHybridWindow(b: Rect): number;
        loadFakeContent(id: number, url: string): Promise<boolean>;
        getHybridContentWcIdForTest?: (id: number) => number | null;
        setActive(id: number | null): boolean;
      };
      const id = b.makeFakeHybridWindow(arg.bounds);
      await b.loadFakeContent(id, arg.url);
      if (arg.activate) b.setActive(id);
      // Prefer the dedicated wc-id accessor on the __peek_test bridge; fall back
      // to null if unavailable (the chrome bridge does not expose it directly).
      const pt = (globalThis as Record<string, unknown>).__peek_test as
        | { getHybridContentWcIdForTest?: (id: number) => number | null }
        | undefined;
      const contentWcId =
        pt && typeof pt.getHybridContentWcIdForTest === 'function'
          ? pt.getHybridContentWcIdForTest(id)
          : null;
      return { id, contentWcId };
    },
    { bounds, activate, url } as { bounds: Rect; activate: boolean; url: string },
  );

  // The overlay renderer loads asynchronously after the first setActive; wait
  // for it so the caller's chrome-state reads / Cmd+L reveals are observable.
  if (activate) await waitOverlayReady(app);

  return handle;
}

/** Make a hybrid page-host the active window (frames the overlay over it), or clear with null. */
export async function setActive(
  app: DesktopApp,
  h: HybridPageHandle | null,
): Promise<boolean> {
  const id = h ? h.id : null;
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      setActive(id: number | null): boolean;
    };
    return b.setActive(arg.id);
  }, { id } as { id: number | null });
}

/**
 * The content `WebContents` id for ANY live hybrid page-host window id (not
 * just fake bridge windows — the accessor is keyed by id in the registry, so
 * it works equally for a real window opened via the production
 * `app.window.open` path). Null if `id` isn't a live hybrid window, or the
 * accessor isn't available. Useful for specs that open a REAL hybrid content
 * window and then need to send synthetic input events straight to its content
 * WC (e.g. `webContents.fromId(id).sendInputEvent(...)`).
 */
export async function getHybridContentWcId(
  app: DesktopApp,
  id: number,
): Promise<number | null> {
  return app.evaluateMain!((_e, arg) => {
    const pt = (globalThis as Record<string, unknown>).__peek_test as
      | { getHybridContentWcIdForTest?: (id: number) => number | null }
      | undefined;
    return pt && typeof pt.getHybridContentWcIdForTest === 'function'
      ? pt.getHybridContentWcIdForTest(arg.id)
      : null;
  }, { id } as { id: number });
}

/** The live content URL of a hybrid page-host's content WebContents. */
export async function contentUrl(app: DesktopApp, h: HybridPageHandle): Promise<string> {
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      contentUrl(id: number): string;
    };
    return b.contentUrl(arg.id);
  }, { id: h.id } as { id: number });
}

/**
 * The overlay's painted chrome state (navbar visibility, URL-input focus,
 * loading flag, find-bar, etc.) read straight from the overlay renderer DOM.
 * Reflects the ACTIVE window — call {@link setActive} (or open with
 * `activate:true`) first. Resolves null if no overlay / renderer not ready.
 */
export async function overlayChromeState(
  app: DesktopApp,
  _h?: HybridPageHandle,
): Promise<OverlayChromeState | null> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      overlayChromeState(): Promise<unknown>;
    };
    return b.overlayChromeState() as Promise<OverlayChromeState | null>;
  });
}

/**
 * Synthetically reveal the chrome via the renderer's trigger-zone hover path
 * (the same `showNavbar()` a real pointer hover triggers). Resolves whether the
 * chrome (panels) became visible. Focus-free.
 */
export async function revealOverlayChrome(
  app: DesktopApp,
  _h?: HybridPageHandle,
): Promise<boolean> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      revealOverlayChrome(): Promise<boolean>;
    };
    return b.revealOverlayChrome();
  });
}

/** The content window's current OUTER bounds (the inner content rect), or null. */
export async function hostBounds(
  app: DesktopApp,
  h: HybridPageHandle,
): Promise<Rect | null> {
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      hostBounds(id: number): Rect | null;
    };
    return b.hostBounds(arg.id);
  }, { id: h.id } as { id: number });
}

/**
 * The hybrid host BaseWindow's current visibility, opacity, and focus, or null
 * if `id` isn't a live hybrid window. The hybrid content window is a BaseWindow,
 * invisible to `BrowserWindow.fromId`, so headless-flash / focus-theft specs
 * read its visible/opacity/focused state here instead of via `fromId(id)`.
 */
export async function hostVisibility(
  app: DesktopApp,
  id: number,
): Promise<{ visible: boolean; opacity: number; focused: boolean } | null> {
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      hostVisibility(
        id: number,
      ): { visible: boolean; opacity: number; focused: boolean } | null;
    };
    return b.hostVisibility(arg.id);
  }, { id } as { id: number });
}

/**
 * Is `id` a live hybrid page-host (BaseWindow) window? Thin wrapper over the
 * `__peek_test.isHybridWindowForTest` bridge so a spec can branch its lookup
 * (hybrid registry vs `BrowserWindow.fromId`) without re-deriving the bridge.
 */
export async function isHybridWindow(app: DesktopApp, id: number): Promise<boolean> {
  return app.evaluateMain!((_e, arg) => {
    const pt = (globalThis as Record<string, unknown>).__peek_test as
      | { isHybridWindowForTest?: (id: number) => boolean }
      | undefined;
    return !!(pt && typeof pt.isHybridWindowForTest === 'function'
      ? pt.isHybridWindowForTest(arg.id)
      : false);
  }, { id } as { id: number });
}

/**
 * Forward a Cmd+L to the active hybrid window: publish `page:show-navbar`
 * (windowId-tagged), exactly as the content WC's before-input-event forward
 * does. The overlay reveals the navbar and DOM-focuses its URL field (gated on
 * the active window). The page-host MUST be active first (see {@link setActive}).
 */
export async function sendShowNavbar(
  app: DesktopApp,
  h: HybridPageHandle,
): Promise<void> {
  await app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      publishTopic(topic: string, msg: unknown): void;
    };
    b.publishTopic('page:show-navbar', { windowId: arg.id });
  }, { id: h.id } as { id: number });
}

/**
 * Drive a pointer move OFF the chrome (into the content area): the renderer's
 * reliable-reveal hit-test reads this as "outside" and SCHEDULES the navbar
 * hide. Resolves whether a hide was scheduled (a pending hide timer) — the
 * class removal itself is timer-deferred, so we assert the schedule rather than
 * racing the timer. Focus-free.
 */
export async function scheduleChromeHide(
  app: DesktopApp,
  _h?: HybridPageHandle,
): Promise<boolean> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      moveOffChromeSchedulesHide(): Promise<boolean>;
    };
    return b.moveOffChromeSchedulesHide();
  });
}

/**
 * Publish a `page:loading` state for a hybrid window through the same pubsub the
 * content WC's did-start/did-stop-loading forwards use, so a test can assert the
 * overlay navbar reflects the loading lifecycle. Page-host must be active.
 */
export async function publishLoading(
  app: DesktopApp,
  h: HybridPageHandle,
  loading: boolean,
): Promise<void> {
  await app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      publishTopic(topic: string, msg: unknown): void;
    };
    b.publishTopic('page:loading', { windowId: arg.id, loading: arg.loading });
  }, { id: h.id, loading } as { id: number; loading: boolean });
}

/** Painted extension-widget host state read from the overlay renderer. */
export interface WidgetHostState {
  hostPresent: boolean;
  registered: number | null;
  active: number | null;
  domCount: number;
  byId: Record<string, { present: boolean; title: string; bodyHtml: string }>;
}

/**
 * Read the overlay's extension widget HOST state (`__pageWidgetHost` +
 * widget-container DOM). On the hybrid path the widget host lives in the SHARED
 * overlay renderer, not a per-page chrome — so a page-widgets spec drives the
 * widget:register/render/update/close pubsub lifecycle via
 * {@link publishOverlayTopic} and reads the result here. Requires an active
 * hybrid page (open with `activate:true`); resolves null if the overlay/renderer
 * isn't ready.
 */
export async function widgetHostState(app: DesktopApp): Promise<WidgetHostState | null> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      widgetHostState(): Promise<unknown>;
    };
    return b.widgetHostState() as Promise<WidgetHostState | null>;
  });
}

/**
 * Publish an arbitrary `page:*` / `widget:*` topic on the overlay's system
 * address (the same path the canvas page renderer's `api.publish` reaches). Used
 * to drive the overlay widget host's pubsub lifecycle from a test without a
 * per-page chrome. The overlay's widget host subscribes globally (not
 * windowId-gated), so an active hybrid page is enough.
 */
export async function publishOverlayTopic(
  app: DesktopApp,
  topic: string,
  msg: unknown,
): Promise<void> {
  await app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      publishTopic(topic: string, msg: unknown): void;
    };
    b.publishTopic(arg.topic, arg.msg);
  }, { topic, msg } as { topic: string; msg: unknown });
}

/** Destroy a hybrid page-host (fires the registry's 'closed' cleanup). */
export async function closeHybridPage(
  app: DesktopApp,
  h: HybridPageHandle,
): Promise<boolean> {
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      destroyFakeHybridWindow(id: number): boolean;
    };
    return b.destroyFakeHybridWindow(arg.id);
  }, { id: h.id } as { id: number });
}
