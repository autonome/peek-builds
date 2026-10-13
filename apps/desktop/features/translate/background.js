/**
 * Translate feature background script.
 *
 * Commands:
 *   - `translate page [language]` — asks main (`main/page-translate/translate-topics.ts`) to
 *     translate the web page in front, from the language the page declares into the named
 *     language or the system language.
 *   - `show original` — asks main to put the page's own text back.
 *
 * Main reports every change of a window's translation on `translate:state`; this tile shows it
 * in a page widget while that window is the one in front. The widget's "Show original" button
 * comes back as `widget:action` and is turned into `translate:show-original`.
 *
 * Main publishes `page:translatable {windowId, url, lang}` when a loaded page declares a language
 * other than the system one (`main/page-translate/page-language.ts`); the tile then offers a
 * translation in the same widget, whose "Translate from X" button becomes `translate:page`.
 * The offer closes when that window loads another page.
 *
 * Lazy: the tile boots on the first `cmd:execute:translate page` / `cmd:execute:show original`
 * or `page:translatable`.
 * Every subscription is made synchronously in `init()`, before any await, so the publish that
 * woke the tile is not missed.
 */

import {
  DECLARED_LANGUAGE_SCRIPT,
  buildTranslateRequest,
  languageName,
  offerView,
  refusalText,
  statusHtml,
  statusView,
  widgetActionRequest,
} from './translate-logic.js';

const api = window.app;

const EXTENSION_ID = 'translate';
const WIDGET_ID = 'status';
const SCRIPT_TIMEOUT_MS = 5000;

let requestCounter = 0;

/** Runs `script` in the page in front and resolves with its result, or null on failure. */
function runInFrontPage(script) {
  return new Promise((resolve) => {
    const requestId = `${EXTENSION_ID}-${++requestCounter}-${Date.now()}`;
    let unsub = null;
    const timer = setTimeout(() => finish(null), SCRIPT_TIMEOUT_MS);
    function finish(value) {
      clearTimeout(timer);
      if (typeof unsub === 'function') unsub();
      resolve(value);
    }
    unsub = api.pubsub.subscribe('page:script-result', (msg) => {
      if (!msg || msg.requestId !== requestId) return;
      finish(msg.success ? msg.result : null);
    });
    api.pubsub.publish('page:execute-script', { extensionId: EXTENSION_ID, requestId, script });
  });
}

function reply(msg, text) {
  if (msg && msg.expectResult && msg.resultTopic) {
    api.pubsub.publish(msg.resultTopic, { output: text, mimeType: 'text/plain' });
  }
}

const handleTranslatePage = async (msg) => {
  const windowId = await api.window.getFocusedVisibleWindowId();
  const declared = windowId ? await runInFrontPage(DECLARED_LANGUAGE_SCRIPT) : null;
  const result = buildTranslateRequest({
    windowId,
    declared: typeof declared === 'string' ? declared : null,
    requested: msg?.search || msg?.data?.language || '',
    fallbackTarget: navigator.language,
  });
  if (!result.ok) {
    reply(msg, refusalText(result));
    return;
  }
  api.pubsub.publish('translate:page', result.message);
  const { from, to } = result.message;
  reply(msg, `Translating from ${languageName(from)} to ${languageName(to)} on this device.`);
};

const handleShowOriginal = async (msg) => {
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (!windowId) {
    reply(msg, 'No web page is in front.');
    return;
  }
  api.pubsub.publish('translate:show-original', { windowId });
  reply(msg, 'Showing the original page.');
};

/** The window whose translation offer the widget shows, or null when it shows no offer. */
let offerWindowId = null;

function closeWidget() {
  api.pubsub.publish('widget:close', { extensionId: EXTENSION_ID, widgetId: WIDGET_ID });
}

function drawWidget(view) {
  // Registering is idempotent; repeating it covers a chrome that was rebuilt since init.
  api.pubsub.publish('widget:register', {
    extensionId: EXTENSION_ID,
    widgetId: WIDGET_ID,
    title: view.title,
    position: 'right',
  });
  api.pubsub.publish('widget:render', {
    extensionId: EXTENSION_ID,
    widgetId: WIDGET_ID,
    title: view.title,
    html: statusHtml(view),
  });
}

const handleState = async (state) => {
  if (!state || !Number.isInteger(state.windowId)) return;
  // The widget lives in the chrome of the window in front, so a change in another window must
  // not draw there.
  const front = await api.window.getFocusedVisibleWindowId();
  if (front !== state.windowId) return;
  // The translation's status replaces any offer in the one widget.
  offerWindowId = null;
  const view = statusView(state);
  if (!view) {
    closeWidget();
    return;
  }
  drawWidget(view);
};

/** A page declaring another language finished loading: offer to translate it. */
const handleTranslatable = async (msg) => {
  if (!msg || !Number.isInteger(msg.windowId)) return;
  const front = await api.window.getFocusedVisibleWindowId();
  if (front !== msg.windowId) return;
  const view = offerView({ lang: msg.lang, target: navigator.language });
  if (!view) return;
  offerWindowId = msg.windowId;
  drawWidget(view);
};

/** A new document in the window whose offer is showing: that offer was for the old page. */
const handleLoaded = (msg) => {
  if (offerWindowId === null || !msg || msg.windowId !== offerWindowId) return;
  offerWindowId = null;
  closeWidget();
};

const init = () => {
  api.pubsub.subscribe('cmd:execute:translate page', (msg) => {
    handleTranslatePage(msg).catch((err) => {
      console.error('[ext:translate] translate page failed:', err);
      reply(msg, 'The page could not be translated.');
    });
  });
  api.pubsub.subscribe('cmd:execute:show original', (msg) => {
    handleShowOriginal(msg).catch((err) => {
      console.error('[ext:translate] show original failed:', err);
      reply(msg, 'Could not show the original page.');
    });
  });
  api.pubsub.subscribe('translate:state', (state) => {
    handleState(state).catch((err) => console.error('[ext:translate] state update failed:', err));
  });
  // The lazy wake event: main publishes it when a loaded page declares another language.
  api.pubsub.subscribe('page:translatable', (msg) => {
    handleTranslatable(msg).catch((err) => console.error('[ext:translate] offer failed:', err));
  });
  // page:loaded comes before the next page's page:translatable, so a stale offer closes first.
  api.pubsub.subscribe('page:loaded', handleLoaded);
  // A button in the widget: the window comes with the click, so it acts on the window whose
  // chrome showed the button.
  api.pubsub.subscribe('widget:action', (msg) => {
    const request = widgetActionRequest(msg, { extensionId: EXTENSION_ID, widgetId: WIDGET_ID });
    if (request) api.pubsub.publish(request.topic, request.message);
  });
};

const uninit = () => {
  closeWidget();
};

export default {
  id: EXTENSION_ID,
  labels: {
    name: 'Translate',
    description: 'Translate web pages on this device',
  },
  init,
  uninit,
};
