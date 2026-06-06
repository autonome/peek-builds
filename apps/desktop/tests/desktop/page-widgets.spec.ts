/**
 * Page Widget Extensibility Tests (hybrid page-host).
 *
 * Tests the page widget host API that lets extensions register/render/update/
 * close widgets via pubsub, and react to page lifecycle events.
 *
 * Migrated off the canvas `<webview>` page host. On the canvas path the widget
 * host (`window.__pageWidgetHost`) and its `#widget-container` lived inside each
 * page's CHROME renderer (page.js), and the spec published widget topics from
 * that same page window. Under PEEK_PAGEHOST_HYBRID=1 there is NO per-page
 * chrome: the widget host lives in the SHARED overlay renderer (overlay.js
 * creates `__pageWidgetHost` via createPageWidgetHost), and the page content is
 * an opaque WebContentsView with no peek `api`. So these tests now drive the
 * widget:register/render/update/close pubsub lifecycle through the overlay
 * (helper `publishOverlayTopic`, the same system-address path the canvas page
 * renderer's `api.publish` reaches) and read the resulting host + container
 * state via `widgetHostState`. The describe block skips itself when the hybrid
 * bridge is absent (flag off).
 *
 * NOTE — page:execute-script is a deliberate hybrid GAP, not migrated: the
 * overlay's widget host is constructed with `webview: null` (overlay.js ~1799),
 * so script-exec requests are answered only with `{success:false, error:'No
 * webview available'}`. Extensions that need page-script execution run against
 * the canvas path today. Asserting on the no-webview error would test the gap,
 * not the feature, so those two tests are skipped with a TODO (Batch D ticket).
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
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const h = await openHybridPage(app, PAGE_HTML);

    const state = await widgetHostState(app);
    expect(state).not.toBeNull();
    expect(state!.hostPresent).toBe(true);

    await closeHybridPage(app, h);
  });

  test('widget:register creates a widget registration', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

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
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

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
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

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
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

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

  // ── page:execute-script — deliberate hybrid GAP (NOT migrated) ────────────
  test('page:execute-script runs code in webview and returns result', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');
    test.skip(
      true,
      'hybrid page-host: page-script execution is not implemented on the overlay (widget host has webview:null; answers only "No webview available"); deferred to canvas path — see Batch D ticket',
    );
  });

  test('page:execute-script returns error for invalid script', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');
    test.skip(
      true,
      'hybrid page-host: page-script execution is not implemented on the overlay (widget host has webview:null); deferred to canvas path — see Batch D ticket',
    );
  });
});
