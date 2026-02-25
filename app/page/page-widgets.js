/**
 * Page Widget Host API
 *
 * Manages extension-provided widgets in the page host window. Extensions
 * communicate via pubsub to register, render, update, and close widgets.
 * The host publishes lifecycle events so extensions can react to page
 * navigation and loading.
 *
 * Integration: imported by page.js, which calls init() with the webview
 * element and pubsub api reference.
 *
 * Pubsub topics (extension -> host):
 *   widget:register   - Register a widget type
 *   widget:render     - Populate a widget with content
 *   widget:update     - Update an existing widget
 *   widget:close      - Remove a widget
 *   page:execute-script - Request script execution in page webview
 *
 * Pubsub topics (host -> extension):
 *   page:loaded       - Page finished loading (already exists in page.js)
 *   page:navigated    - In-page navigation occurred
 *   page:will-close   - Page window is about to close
 *   page:script-result - Result of script execution
 *   widget:registered  - Confirmation of widget registration
 */

/**
 * @typedef {Object} WidgetRegistration
 * @property {string} extensionId - The registering extension's ID
 * @property {string} widgetId - Unique widget identifier
 * @property {string} [title] - Widget title
 * @property {string} [position='right'] - 'right' | 'left' | 'bottom'
 * @property {number} [width] - Preferred width in px
 * @property {number} [maxHeight] - Maximum height in px
 */

/**
 * @typedef {Object} PageWidgetHost
 * @property {function} init - Initialize the widget host
 * @property {function} destroy - Tear down subscriptions and widgets
 * @property {function} getWidgets - Get all registered widgets
 * @property {function} publishNavigated - Publish navigation event
 * @property {function} publishWillClose - Publish will-close event
 */

/**
 * Create a page widget host instance.
 *
 * Pure factory function — no global state. All state is local to the
 * returned object, making it testable without DOM.
 *
 * @param {object} deps - Dependencies injected by page.js
 * @param {object} deps.api - The pubsub/IPC API (window.app)
 * @param {HTMLElement} deps.webview - The <webview> element
 * @param {HTMLElement} deps.widgetContainer - Container for right-side widgets
 * @param {function} deps.addWidget - page.js addWidget(id, opts)
 * @param {function} deps.updateWidget - page.js updateWidget(id, opts)
 * @param {function} deps.removeWidget - page.js removeWidget(id)
 * @returns {PageWidgetHost}
 */
export function createPageWidgetHost(deps) {
  const { api, webview, widgetContainer, addWidget, updateWidget, removeWidget } = deps;

  /** @type {Map<string, WidgetRegistration>} */
  const registrations = new Map();

  /** @type {Map<string, object>} widget handles from addWidget */
  const activeWidgets = new Map();

  /** @type {Array<function>} unsubscribe callbacks */
  const unsubs = [];

  /** @type {Map<string, {resolve: function, reject: function}>} pending script requests */
  const pendingScripts = new Map();

  const DEBUG = false;

  // --- Subscription helpers ---

  function subscribe(topic, handler) {
    const unsub = api.subscribe(topic, handler, api.scopes.GLOBAL);
    unsubs.push(unsub);
    return unsub;
  }

  // --- Widget registration ---

  function handleRegister(msg) {
    if (!msg || !msg.extensionId || !msg.widgetId) {
      DEBUG && console.log('[page-widgets] Invalid register message:', msg);
      return;
    }

    const key = `${msg.extensionId}:${msg.widgetId}`;
    const registration = {
      extensionId: msg.extensionId,
      widgetId: msg.widgetId,
      title: msg.title || msg.widgetId,
      position: msg.position || 'right',
      width: msg.width || undefined,
      maxHeight: msg.maxHeight || undefined,
    };

    registrations.set(key, registration);

    DEBUG && console.log('[page-widgets] Registered widget:', key, registration);

    api.publish('widget:registered', {
      extensionId: msg.extensionId,
      widgetId: msg.widgetId,
      success: true,
    }, api.scopes.GLOBAL);
  }

  // --- Widget rendering ---

  function handleRender(msg) {
    if (!msg || !msg.extensionId || !msg.widgetId) {
      DEBUG && console.log('[page-widgets] Invalid render message:', msg);
      return;
    }

    const key = `${msg.extensionId}:${msg.widgetId}`;
    const registration = registrations.get(key);
    if (!registration) {
      console.warn('[page-widgets] Cannot render unregistered widget:', key);
      return;
    }

    // Remove existing widget if re-rendering
    if (activeWidgets.has(key)) {
      removeWidget(key);
      activeWidgets.delete(key);
    }

    const handle = addWidget(key, {
      title: msg.title || registration.title,
      content: msg.html || msg.content || '',
      autoDismiss: msg.autoDismiss || 0,
      onClose: () => {
        activeWidgets.delete(key);
        api.publish('widget:closed', {
          extensionId: msg.extensionId,
          widgetId: msg.widgetId,
        }, api.scopes.GLOBAL);
      },
    });

    if (handle) {
      activeWidgets.set(key, handle);
      DEBUG && console.log('[page-widgets] Rendered widget:', key);
    }
  }

  // --- Widget update ---

  function handleUpdate(msg) {
    if (!msg || !msg.extensionId || !msg.widgetId) return;

    const key = `${msg.extensionId}:${msg.widgetId}`;
    if (!activeWidgets.has(key)) {
      DEBUG && console.log('[page-widgets] Cannot update inactive widget:', key);
      return;
    }

    updateWidget(key, {
      title: msg.title,
      content: msg.html || msg.content,
    });

    DEBUG && console.log('[page-widgets] Updated widget:', key);
  }

  // --- Widget close ---

  function handleClose(msg) {
    if (!msg || !msg.extensionId || !msg.widgetId) return;

    const key = `${msg.extensionId}:${msg.widgetId}`;
    if (activeWidgets.has(key)) {
      removeWidget(key);
      activeWidgets.delete(key);
      DEBUG && console.log('[page-widgets] Closed widget:', key);
    }
  }

  // --- Content script execution ---

  function handleExecuteScript(msg) {
    if (!msg || !msg.extensionId || !msg.requestId || !msg.script) {
      DEBUG && console.log('[page-widgets] Invalid execute-script message:', msg);
      return;
    }

    if (!webview) {
      api.publish('page:script-result', {
        requestId: msg.requestId,
        extensionId: msg.extensionId,
        error: 'No webview available',
      }, api.scopes.GLOBAL);
      return;
    }

    // Execute the script in the webview and publish the result
    webview.executeJavaScript(msg.script)
      .then((result) => {
        api.publish('page:script-result', {
          requestId: msg.requestId,
          extensionId: msg.extensionId,
          result,
          success: true,
        }, api.scopes.GLOBAL);
      })
      .catch((err) => {
        api.publish('page:script-result', {
          requestId: msg.requestId,
          extensionId: msg.extensionId,
          error: err.message || String(err),
          success: false,
        }, api.scopes.GLOBAL);
      });
  }

  // --- Lifecycle event publishers ---

  function publishNavigated(url, title) {
    api.publish('page:navigated', { url, title }, api.scopes.GLOBAL);
  }

  function publishWillClose(url) {
    api.publish('page:will-close', { url }, api.scopes.GLOBAL);
  }

  // --- Init / Destroy ---

  function init() {
    subscribe('widget:register', handleRegister);
    subscribe('widget:render', handleRender);
    subscribe('widget:update', handleUpdate);
    subscribe('widget:close', handleClose);
    subscribe('page:execute-script', handleExecuteScript);

    DEBUG && console.log('[page-widgets] Initialized');
  }

  function destroy() {
    // Publish will-close before tearing down
    try {
      const url = webview?.getURL?.();
      if (url) publishWillClose(url);
    } catch {
      // webview may not be ready
    }

    // Remove all active widgets
    for (const key of activeWidgets.keys()) {
      removeWidget(key);
    }
    activeWidgets.clear();
    registrations.clear();

    // Clear pending script requests
    for (const [, pending] of pendingScripts) {
      pending.reject(new Error('Widget host destroyed'));
    }
    pendingScripts.clear();

    // Unsubscribe all
    for (const unsub of unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    unsubs.length = 0;

    DEBUG && console.log('[page-widgets] Destroyed');
  }

  function getWidgets() {
    return new Map(registrations);
  }

  function getActiveWidgets() {
    return new Map(activeWidgets);
  }

  return {
    init,
    destroy,
    getWidgets,
    getActiveWidgets,
    publishNavigated,
    publishWillClose,
    // Exposed for testing
    _handleRegister: handleRegister,
    _handleRender: handleRender,
    _handleUpdate: handleUpdate,
    _handleClose: handleClose,
    _handleExecuteScript: handleExecuteScript,
  };
}
