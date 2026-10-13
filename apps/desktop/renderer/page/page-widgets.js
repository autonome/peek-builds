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
 *   widget:render     - Show a widget, or update it in place if it is already
 *                       showing (an `autoDismiss` on a re-render restarts the
 *                       dismiss countdown)
 *   widget:update     - Update an existing widget
 *   widget:close      - Remove a widget
 *
 * Only `widget:close` or a user dismissal (or an expired autoDismiss) takes a
 * card away. A re-render never tears the card down and rebuilds it: that would
 * fade it out and in, reset its collapse state, and publish a false
 * `widget:closed`, so an owner that re-renders on every progress tick would
 * make the card blink.
 *   page:execute-script - Request script execution in page webview
 *
 * Pubsub topics (host -> extension):
 *   page:loaded       - Page finished loading (already exists in page.js)
 *   page:navigated    - In-page navigation occurred
 *   page:will-close   - Page window is about to close
 *   page:script-result - Result of script execution
 *   widget:registered  - Confirmation of widget registration
 *   widget:closed      - The user dismissed a widget
 *   widget:action      - The user clicked an element inside a widget that carries
 *                        `data-widget-action`; payload `{extensionId, widgetId,
 *                        action, value, windowId}`. `value` is the element's
 *                        `data-widget-value` (or null); `windowId` is the window the
 *                        widget was drawn for, when the host knows it (or null).
 *                        A widget's HTML gets clickable controls this way without
 *                        any script of its own, since widget markup is inert HTML.
 */

/**
 * The action a click inside a widget body asks for: the innermost element on the
 * event's path, up to (not including) `boundary`, that carries a non-empty
 * `data-widget-action`. A disabled element (or one inside a disabled element)
 * answers null, so a disabled `<peek-button>` cannot fire its action through a
 * click on its host box.
 *
 * Takes the event path as an array (`event.composedPath()`), so a click inside a
 * component's shadow root still finds the attribute on the component's host.
 *
 * @param {Array<object>} path - event.composedPath(), innermost first
 * @param {object} boundary - the widget body; the walk stops there
 * @returns {{action: string, value: string|null}|null}
 */
export function widgetActionFromPath(path, boundary) {
  if (!Array.isArray(path)) return null;
  for (const node of path) {
    if (!node || node === boundary) return null;
    if (typeof node.getAttribute !== 'function') continue;
    if (node.hasAttribute?.('disabled')) return null;
    const action = node.getAttribute('data-widget-action');
    if (typeof action === 'string' && action.trim()) {
      for (const outer of path.slice(path.indexOf(node) + 1)) {
        if (!outer || outer === boundary) break;
        if (outer.hasAttribute?.('disabled')) return null;
      }
      const value = node.getAttribute('data-widget-value');
      return { action: action.trim(), value: typeof value === 'string' ? value : null };
    }
  }
  return null;
}

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
 * @param {function} [deps.getActiveWindowId] - the window widgets are drawn for,
 *   carried on `widget:action` so a tile acts on the window the user clicked in
 * @returns {PageWidgetHost}
 */
export function createPageWidgetHost(deps) {
  const { api, webview, widgetContainer, addWidget, updateWidget, removeWidget } = deps;
  const getActiveWindowId = typeof deps.getActiveWindowId === 'function' ? deps.getActiveWindowId : () => null;

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
    const unsub = api.subscribe(topic, handler);
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
    });
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

    const title = msg.title || registration.title;
    const content = msg.html || msg.content || '';

    // A widget already showing is updated in place: the card keeps its element,
    // its collapse state and its listeners, and no widget:closed goes out.
    const shown = activeWidgets.get(key);
    if (shown) {
      updateWidget(key, { title, content });
      if (msg.autoDismiss > 0) restartDismissTimer(key, shown, msg.autoDismiss);
      DEBUG && console.log('[page-widgets] Re-rendered widget in place:', key);
      return;
    }

    const handle = addWidget(key, {
      title,
      content,
      autoDismiss: msg.autoDismiss || 0,
      onClose: () => {
        activeWidgets.delete(key);
        api.publish('widget:closed', {
          extensionId: msg.extensionId,
          widgetId: msg.widgetId,
        });
      },
      onAction: ({ action, value }) => {
        const windowId = getActiveWindowId();
        api.publish('widget:action', {
          extensionId: msg.extensionId,
          widgetId: msg.widgetId,
          action,
          value: value ?? null,
          windowId: Number.isInteger(windowId) ? windowId : null,
        });
      },
    });

    if (handle) {
      activeWidgets.set(key, handle);
      DEBUG && console.log('[page-widgets] Rendered widget:', key);
    }
  }

  /**
   * Restart a showing widget's dismiss countdown from now, because new content
   * deserves a full read time. updateWidget does not touch timers, so the host
   * replaces them here; the handle's `timers` array is the one removeWidget
   * clears, so a later remove still cancels the new timer.
   */
  function restartDismissTimer(key, handle, ms) {
    if (!Array.isArray(handle.timers)) handle.timers = [];
    for (const timer of handle.timers) clearTimeout(timer);
    handle.timers.length = 0;
    handle.timers.push(setTimeout(() => {
      if (activeWidgets.get(key) !== handle) return;
      removeWidget(key);
      activeWidgets.delete(key);
    }, ms));
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

    if (!webview || typeof webview.executeJavaScript !== 'function') {
      api.publish('page:script-result', {
        requestId: msg.requestId,
        extensionId: msg.extensionId,
        error: 'No webview available',
        success: false,
      });
      return;
    }

    const SCRIPT_TIMEOUT = 10000; // 10s timeout for script execution

    // Execute the script in the webview and publish the result.
    // Wrap in try-catch for synchronous errors (e.g., webview not attached).
    let promise;
    try {
      promise = webview.executeJavaScript(msg.script);
    } catch (err) {
      api.publish('page:script-result', {
        requestId: msg.requestId,
        extensionId: msg.extensionId,
        error: err.message || String(err),
        success: false,
      });
      return;
    }

    // Race against a timeout to guarantee a response even if the webview
    // guest process is unresponsive or the script execution hangs.
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Script execution timed out')), SCRIPT_TIMEOUT);
    });

    Promise.race([promise, timeout])
      .then((result) => {
        api.publish('page:script-result', {
          requestId: msg.requestId,
          extensionId: msg.extensionId,
          result,
          success: true,
        });
      })
      .catch((err) => {
        api.publish('page:script-result', {
          requestId: msg.requestId,
          extensionId: msg.extensionId,
          error: err.message || String(err),
          success: false,
        });
      });
  }

  // --- Lifecycle event publishers ---

  function publishNavigated(url, title) {
    api.publish('page:navigated', { url, title });
  }

  function publishWillClose(url) {
    api.publish('page:will-close', { url });
  }

  // --- Init / Destroy ---

  function init() {
    subscribe('widget:register', handleRegister);
    subscribe('widget:render', handleRender);
    subscribe('widget:update', handleUpdate);
    subscribe('widget:close', handleClose);
    // Only the canvas page host (real <webview>) services page-script exec here.
    // The hybrid overlay host has webview:null — the MAIN process runs the script
    // against the content WebContentsView instead (see hybrid-overlay.ts). Without
    // this guard the overlay would answer "No webview available" and race the
    // main handler's real result.
    if (webview && typeof webview.executeJavaScript === 'function') {
      subscribe('page:execute-script', handleExecuteScript);
    }

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
