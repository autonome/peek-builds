/**
 * Page Widget Extensibility Tests (hybrid page-host).
 *
 * Tests the page widget host API that lets extensions register/render/update/
 * close widgets via pubsub, and react to page lifecycle events.
 *
 * Migrated off the canvas `<webview>` page host. On the canvas path the widget
 * host (`window.__pageWidgetHost`) and its `#widget-container` lived inside each
 * page's CHROME renderer (page.js), and the spec published widget topics from
 * that same page window. On the hybrid page-host there is NO per-page
 * chrome: the widget host lives in the SHARED overlay renderer (overlay.js
 * creates `__pageWidgetHost` via createPageWidgetHost), and the page content is
 * an opaque WebContentsView with no peek `api`. So these tests now drive the
 * widget:register/render/update/close pubsub lifecycle through the overlay
 * (helper `publishOverlayTopic`, the same system-address path the canvas page
 * renderer's `api.publish` reaches) and read the resulting host + container
 * state via `widgetHostState`. The describe block skips itself when the hybrid
 * bridge is absent (flag off).
 *
 * NOTE — page:execute-script: the overlay's widget host is constructed with
 * `webview: null` (overlay.js ~1799), so it can't run page scripts itself.
 * Instead the MAIN process (hybrid-overlay.ts `wireExecuteScript`) subscribes to
 * `page:execute-script` and runs the script against the active hybrid content
 * WebContentsView, publishing `page:script-result` (mirroring the canvas
 * handler's timeout-and-result contract). The two tests below drive that round
 * trip through the `__peekHybridOverlayTest.runPageScript` bridge.
 *
 * Focus-free: hybrid hosts are headless, opacity-0, never-shown BaseWindows;
 * widget pubsub is driven through the overlay's own subscribe path. The describe
 * block skips itself when the hybrid bridge is absent (flag off).
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  hybridBridgePresent,
  openHybridPage,
  widgetHostState,
  publishOverlayTopic,
  closeHybridPage,
} from '../helpers/hybrid-page';

let app: DesktopApp;

test.beforeAll(async () => {
  ({ app } = await createPerDescribeApp('page-widgets'));
});

test.afterAll(async () => {
  if (app) await app.close();
});

// Deterministic, network-free page content for the hybrid content WC.
const PAGE_HTML = 'data:text/html,<title>Example</title><body>hello page-widgets</body>';

test.describe('Page Widgets @desktop', () => {
  test('widget host is initialized for the active hybrid page', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);

    const state = await widgetHostState(app);
    expect(state).not.toBeNull();
    expect(state!.hostPresent).toBe(true);

    await closeHybridPage(app, h);
  });

  test('widget:register creates a widget registration', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);

    await publishOverlayTopic(app, 'widget:register', {
      extensionId: 'test-ext',
      widgetId: 'test-widget',
      title: 'Test Widget',
      position: 'right',
    });

    await expect
      .poll(async () => (await widgetHostState(app))?.registered)
      .toBeGreaterThanOrEqual(1);

    await closeHybridPage(app, h);
  });

  test('widget:render displays a widget in the overlay container', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);

    await publishOverlayTopic(app, 'widget:register', {
      extensionId: 'test-ext',
      widgetId: 'render-test',
      title: 'Render Test',
    });
    await publishOverlayTopic(app, 'widget:render', {
      extensionId: 'test-ext',
      widgetId: 'render-test',
      title: 'Rendered Widget',
      html: '<p class="test-content">Widget content here</p>',
    });

    // The widget card (data-widget-id === "test-ext:render-test") is created in
    // the overlay container with the rendered body.
    await expect
      .poll(async () => (await widgetHostState(app))?.byId['test-ext:render-test']?.present)
      .toBe(true);

    const state = await widgetHostState(app);
    expect(state!.byId['test-ext:render-test'].bodyHtml).toContain('Widget content here');

    await closeHybridPage(app, h);
  });

  test('widget:update modifies existing widget content', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);

    await publishOverlayTopic(app, 'widget:register', {
      extensionId: 'test-ext',
      widgetId: 'update-test',
    });
    await publishOverlayTopic(app, 'widget:render', {
      extensionId: 'test-ext',
      widgetId: 'update-test',
      html: '<p>Original</p>',
    });

    // Wait for the initial render.
    await expect
      .poll(async () => (await widgetHostState(app))?.byId['test-ext:update-test']?.present)
      .toBe(true);

    await publishOverlayTopic(app, 'widget:update', {
      extensionId: 'test-ext',
      widgetId: 'update-test',
      html: '<p>Updated content</p>',
      title: 'New Title',
    });

    await expect
      .poll(async () =>
        (await widgetHostState(app))?.byId['test-ext:update-test']?.bodyHtml.includes('Updated content'),
      )
      .toBe(true);

    await closeHybridPage(app, h);
  });

  test('widget:close removes widget from the overlay container', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);

    await publishOverlayTopic(app, 'widget:register', {
      extensionId: 'test-ext',
      widgetId: 'close-test',
    });
    await publishOverlayTopic(app, 'widget:render', {
      extensionId: 'test-ext',
      widgetId: 'close-test',
      html: '<p>To be closed</p>',
    });

    await expect
      .poll(async () => (await widgetHostState(app))?.byId['test-ext:close-test']?.present)
      .toBe(true);

    await publishOverlayTopic(app, 'widget:close', {
      extensionId: 'test-ext',
      widgetId: 'close-test',
    });

    // The active-widget set drops to zero (removal animation takes ~300ms; the
    // host's activeWidgets map is cleared synchronously on close).
    await expect
      .poll(async () => (await widgetHostState(app))?.active)
      .toBe(0);

    await closeHybridPage(app, h);
  });

  // ── page:execute-script — runs in MAIN against the hybrid content WC ───────
  test('page:execute-script runs code in webview and returns result', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);
    const res = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
        runPageScript(e: string, r: string, s: string): Promise<{ success: boolean; result?: unknown; error?: string }>;
      };
      return b.runPageScript(arg.extensionId, arg.requestId, arg.script);
    }, { extensionId: 'test-ext', requestId: 'req-ok-1', script: 'document.title' });
    expect(res.success).toBe(true);
    expect(res.result).toBe('Example');
    await closeHybridPage(app, h);
  });

  test('page:execute-script returns error for invalid script', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);
    const res = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
        runPageScript(e: string, r: string, s: string): Promise<{ success: boolean; result?: unknown; error?: string }>;
      };
      return b.runPageScript(arg.extensionId, arg.requestId, arg.script);
    }, { extensionId: 'test-ext', requestId: 'req-err-1', script: 'throw new Error("boom")' });
    expect(res.success).toBe(false);
    // NB: WebContents.executeJavaScript (main → content WC) rejects with a
    // GENERIC "Script failed to execute…" string — unlike <webview>.execute-
    // JavaScript it does not surface the thrown Error's own message. So we assert
    // the failure path fired and carries a non-empty error, not the "boom" text.
    expect(typeof res.error).toBe('string');
    expect((res.error as string).length).toBeGreaterThan(0);
    await closeHybridPage(app, h);
  });
});
