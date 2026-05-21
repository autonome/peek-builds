/**
 * Unit tests for the page widget host module.
 *
 * Tests the widget registration, rendering, update, close, content script
 * execution, and lifecycle event publishing without requiring DOM or IPC.
 *
 * Run via: node --test tests/unit/page-widgets.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'page', 'page-widgets.js');

const { createPageWidgetHost } = await import(modulePath);

// --- Mock factories ---

function createMockApi() {
  const subscriptions = new Map();
  const published = [];

  return {
    scopes: { GLOBAL: 'GLOBAL' },

    subscribe(topic, handler, scope) {
      if (!subscriptions.has(topic)) subscriptions.set(topic, []);
      subscriptions.get(topic).push(handler);
      // Return unsubscribe function
      return () => {
        const handlers = subscriptions.get(topic);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      };
    },

    publish(topic, data, scope) {
      published.push({ topic, data, scope });
      // Also trigger local subscribers for testing
      const handlers = subscriptions.get(topic);
      if (handlers) {
        for (const h of handlers) h(data);
      }
    },

    // Test helpers
    _published: published,
    _subscriptions: subscriptions,

    getPublished(topic) {
      return published.filter(p => p.topic === topic);
    },

    clearPublished() {
      published.length = 0;
    },
  };
}

function createMockWebview() {
  let scriptResult = null;
  let scriptError = null;
  let currentUrl = 'https://example.com';

  return {
    executeJavaScript(script) {
      if (scriptError) return Promise.reject(new Error(scriptError));
      return Promise.resolve(scriptResult);
    },
    getURL() {
      return currentUrl;
    },
    // Test helpers
    _setScriptResult(result) { scriptResult = result; scriptError = null; },
    _setScriptError(err) { scriptError = err; scriptResult = null; },
    _setUrl(url) { currentUrl = url; },
  };
}

function createMockWidgetFns() {
  const added = [];
  const updated = [];
  const removed = [];

  return {
    addWidget(id, opts) {
      const handle = { id, ...opts, element: {}, body: {}, timers: [], close: () => {} };
      added.push({ id, opts });
      return handle;
    },
    updateWidget(id, opts) {
      updated.push({ id, opts });
    },
    removeWidget(id) {
      removed.push(id);
    },
    _added: added,
    _updated: updated,
    _removed: removed,
  };
}

function createHost(overrides = {}) {
  const api = createMockApi();
  const webview = createMockWebview();
  const widgetFns = createMockWidgetFns();

  const host = createPageWidgetHost({
    api,
    webview,
    widgetContainer: {},
    addWidget: widgetFns.addWidget,
    updateWidget: widgetFns.updateWidget,
    removeWidget: widgetFns.removeWidget,
    ...overrides,
  });

  return { host, api, webview, widgetFns };
}

// --- Tests ---

describe('createPageWidgetHost', () => {
  describe('init and destroy', () => {
    it('subscribes to pubsub topics on init', () => {
      const { host, api } = createHost();
      host.init();

      assert.ok(api._subscriptions.has('widget:register'));
      assert.ok(api._subscriptions.has('widget:render'));
      assert.ok(api._subscriptions.has('widget:update'));
      assert.ok(api._subscriptions.has('widget:close'));
      assert.ok(api._subscriptions.has('page:execute-script'));
    });

    it('unsubscribes and cleans up on destroy', () => {
      const { host, api } = createHost();
      host.init();

      // Register a widget
      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      assert.equal(host.getWidgets().size, 1);

      host.destroy();
      assert.equal(host.getWidgets().size, 0);
    });

    it('publishes page:will-close on destroy', () => {
      const { host, api, webview } = createHost();
      host.init();
      webview._setUrl('https://example.com/test');

      host.destroy();

      const willCloseMessages = api.getPublished('page:will-close');
      assert.equal(willCloseMessages.length, 1);
      assert.equal(willCloseMessages[0].data.url, 'https://example.com/test');
    });
  });

  describe('widget registration', () => {
    it('registers a widget with valid data', () => {
      const { host, api } = createHost();
      host.init();

      host._handleRegister({
        extensionId: 'myext',
        widgetId: 'mywidget',
        title: 'My Widget',
        position: 'right',
      });

      const widgets = host.getWidgets();
      assert.equal(widgets.size, 1);
      assert.ok(widgets.has('myext:mywidget'));

      const reg = widgets.get('myext:mywidget');
      assert.equal(reg.extensionId, 'myext');
      assert.equal(reg.widgetId, 'mywidget');
      assert.equal(reg.title, 'My Widget');
      assert.equal(reg.position, 'right');
    });

    it('publishes widget:registered confirmation', () => {
      const { host, api } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });

      const confirms = api.getPublished('widget:registered');
      assert.equal(confirms.length, 1);
      assert.equal(confirms[0].data.extensionId, 'ext1');
      assert.equal(confirms[0].data.widgetId, 'w1');
      assert.equal(confirms[0].data.success, true);
    });

    it('defaults position to right and title to widgetId', () => {
      const { host } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });

      const reg = host.getWidgets().get('ext1:w1');
      assert.equal(reg.position, 'right');
      assert.equal(reg.title, 'w1');
    });

    it('rejects registration with missing extensionId', () => {
      const { host, api } = createHost();
      host.init();

      host._handleRegister({ widgetId: 'w1' });

      assert.equal(host.getWidgets().size, 0);
      assert.equal(api.getPublished('widget:registered').length, 0);
    });

    it('rejects registration with missing widgetId', () => {
      const { host, api } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1' });

      assert.equal(host.getWidgets().size, 0);
    });

    it('rejects null message', () => {
      const { host } = createHost();
      host.init();

      host._handleRegister(null);
      host._handleRegister(undefined);

      assert.equal(host.getWidgets().size, 0);
    });

    it('allows multiple widgets from same extension', () => {
      const { host } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRegister({ extensionId: 'ext1', widgetId: 'w2' });

      assert.equal(host.getWidgets().size, 2);
    });

    it('allows same widget ID from different extensions', () => {
      const { host } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRegister({ extensionId: 'ext2', widgetId: 'w1' });

      assert.equal(host.getWidgets().size, 2);
    });
  });

  describe('widget rendering', () => {
    it('renders a registered widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1', title: 'Test' });
      host._handleRender({
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>Hello</p>',
      });

      assert.equal(widgetFns._added.length, 1);
      assert.equal(widgetFns._added[0].id, 'ext1:w1');
      assert.equal(widgetFns._added[0].opts.content, '<p>Hello</p>');
      assert.equal(widgetFns._added[0].opts.title, 'Test');
    });

    it('uses msg.title over registration title', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1', title: 'Original' });
      host._handleRender({
        extensionId: 'ext1',
        widgetId: 'w1',
        title: 'Updated Title',
        html: '<p>Content</p>',
      });

      assert.equal(widgetFns._added[0].opts.title, 'Updated Title');
    });

    it('rejects render for unregistered widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRender({
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>Hello</p>',
      });

      assert.equal(widgetFns._added.length, 0);
    });

    it('removes existing widget before re-rendering', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRender({ extensionId: 'ext1', widgetId: 'w1', html: '<p>V1</p>' });
      host._handleRender({ extensionId: 'ext1', widgetId: 'w1', html: '<p>V2</p>' });

      assert.equal(widgetFns._added.length, 2);
      assert.equal(widgetFns._removed.length, 1);
      assert.equal(widgetFns._removed[0], 'ext1:w1');
    });

    it('publishes widget:closed when onClose callback fires', () => {
      const { host, api, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRender({ extensionId: 'ext1', widgetId: 'w1', html: '<p>Test</p>' });

      // Simulate the close callback being invoked
      api.clearPublished();
      const onClose = widgetFns._added[0].opts.onClose;
      assert.ok(typeof onClose === 'function');
      onClose();

      const closedMsgs = api.getPublished('widget:closed');
      assert.equal(closedMsgs.length, 1);
      assert.equal(closedMsgs[0].data.extensionId, 'ext1');
      assert.equal(closedMsgs[0].data.widgetId, 'w1');
    });

    it('passes autoDismiss to addWidget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRender({
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>Temp</p>',
        autoDismiss: 5000,
      });

      assert.equal(widgetFns._added[0].opts.autoDismiss, 5000);
    });

    it('rejects render with missing extensionId', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRender({ widgetId: 'w1', html: '<p>Nope</p>' });
      assert.equal(widgetFns._added.length, 0);
    });
  });

  describe('widget update', () => {
    it('updates an active widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRender({ extensionId: 'ext1', widgetId: 'w1', html: '<p>V1</p>' });
      host._handleUpdate({
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>V2</p>',
        title: 'New Title',
      });

      assert.equal(widgetFns._updated.length, 1);
      assert.equal(widgetFns._updated[0].id, 'ext1:w1');
      assert.equal(widgetFns._updated[0].opts.content, '<p>V2</p>');
      assert.equal(widgetFns._updated[0].opts.title, 'New Title');
    });

    it('ignores update for inactive widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleUpdate({
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>Ghost</p>',
      });

      assert.equal(widgetFns._updated.length, 0);
    });
  });

  describe('widget close', () => {
    it('closes an active widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleRegister({ extensionId: 'ext1', widgetId: 'w1' });
      host._handleRender({ extensionId: 'ext1', widgetId: 'w1', html: '<p>Bye</p>' });
      host._handleClose({ extensionId: 'ext1', widgetId: 'w1' });

      // One from re-render removal is 0 (first render), one from close
      assert.ok(widgetFns._removed.includes('ext1:w1'));
      assert.equal(host.getActiveWidgets().size, 0);
    });

    it('ignores close for non-existent widget', () => {
      const { host, widgetFns } = createHost();
      host.init();

      host._handleClose({ extensionId: 'ext1', widgetId: 'w1' });
      assert.equal(widgetFns._removed.length, 0);
    });
  });

  describe('content script execution', () => {
    it('executes script and publishes result', async () => {
      const { host, api, webview } = createHost();
      host.init();

      webview._setScriptResult({ title: 'Test Page' });

      host._handleExecuteScript({
        extensionId: 'ext1',
        requestId: 'req-1',
        script: 'document.title',
      });

      // Wait for the async executeJavaScript to resolve
      await new Promise(r => setTimeout(r, 10));

      const results = api.getPublished('page:script-result');
      const result = results.find(r => r.data.requestId === 'req-1');
      assert.ok(result);
      assert.equal(result.data.success, true);
      assert.deepEqual(result.data.result, { title: 'Test Page' });
      assert.equal(result.data.extensionId, 'ext1');
    });

    it('publishes error when script fails', async () => {
      const { host, api, webview } = createHost();
      host.init();

      webview._setScriptError('ReferenceError: foo is not defined');

      host._handleExecuteScript({
        extensionId: 'ext1',
        requestId: 'req-2',
        script: 'foo()',
      });

      await new Promise(r => setTimeout(r, 10));

      const results = api.getPublished('page:script-result');
      const result = results.find(r => r.data.requestId === 'req-2');
      assert.ok(result);
      assert.equal(result.data.success, false);
      assert.ok(result.data.error.includes('ReferenceError'));
    });

    it('publishes error when no webview', () => {
      const api = createMockApi();
      const widgetFns = createMockWidgetFns();

      const host = createPageWidgetHost({
        api,
        webview: null,
        widgetContainer: {},
        addWidget: widgetFns.addWidget,
        updateWidget: widgetFns.updateWidget,
        removeWidget: widgetFns.removeWidget,
      });
      host.init();

      host._handleExecuteScript({
        extensionId: 'ext1',
        requestId: 'req-3',
        script: 'document.title',
      });

      const results = api.getPublished('page:script-result');
      const result = results.find(r => r.data.requestId === 'req-3');
      assert.ok(result);
      assert.ok(result.data.error.includes('No webview'));
    });

    it('rejects invalid execute-script messages', () => {
      const { host, api } = createHost();
      host.init();

      api.clearPublished();

      host._handleExecuteScript(null);
      host._handleExecuteScript({ extensionId: 'ext1' });
      host._handleExecuteScript({ extensionId: 'ext1', requestId: 'req-4' });

      assert.equal(api.getPublished('page:script-result').length, 0);
    });
  });

  describe('lifecycle events', () => {
    it('publishNavigated emits page:navigated', () => {
      const { host, api } = createHost();
      host.init();

      host.publishNavigated('https://example.com/new', 'New Page');

      const msgs = api.getPublished('page:navigated');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].data.url, 'https://example.com/new');
      assert.equal(msgs[0].data.title, 'New Page');
    });

    it('publishWillClose emits page:will-close', () => {
      const { host, api } = createHost();
      host.init();

      host.publishWillClose('https://example.com');

      const msgs = api.getPublished('page:will-close');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].data.url, 'https://example.com');
    });
  });

  describe('pubsub integration', () => {
    it('responds to widget:register pubsub messages after init', () => {
      const { host, api } = createHost();
      host.init();

      // Publish directly via API (simulates an extension sending a message)
      api.publish('widget:register', {
        extensionId: 'ext-pubsub',
        widgetId: 'w-pubsub',
        title: 'Pubsub Widget',
      });

      assert.equal(host.getWidgets().size, 1);
      assert.ok(host.getWidgets().has('ext-pubsub:w-pubsub'));
    });

    it('responds to widget:render pubsub messages', () => {
      const { host, api, widgetFns } = createHost();
      host.init();

      api.publish('widget:register', {
        extensionId: 'ext1',
        widgetId: 'w1',
      });

      api.publish('widget:render', {
        extensionId: 'ext1',
        widgetId: 'w1',
        html: '<p>Pubsub rendered</p>',
      });

      assert.equal(widgetFns._added.length, 1);
    });

    it('full lifecycle: register -> render -> update -> close', () => {
      const { host, api, widgetFns } = createHost();
      host.init();

      // Register
      api.publish('widget:register', {
        extensionId: 'ext1', widgetId: 'w1', title: 'Lifecycle'
      });
      assert.equal(host.getWidgets().size, 1);

      // Render
      api.publish('widget:render', {
        extensionId: 'ext1', widgetId: 'w1', html: '<p>V1</p>'
      });
      assert.equal(widgetFns._added.length, 1);
      assert.equal(host.getActiveWidgets().size, 1);

      // Update
      api.publish('widget:update', {
        extensionId: 'ext1', widgetId: 'w1', html: '<p>V2</p>', title: 'Updated'
      });
      assert.equal(widgetFns._updated.length, 1);

      // Close
      api.publish('widget:close', {
        extensionId: 'ext1', widgetId: 'w1'
      });
      assert.equal(host.getActiveWidgets().size, 0);
    });
  });
});
