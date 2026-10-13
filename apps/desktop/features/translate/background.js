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
 * Every page window shares one chrome, so the tile keeps the view of each window
 * (`window-views.js`) and draws the one for the window in front, following main's
 * `page-overlay:active` reports: another window coming forward shows its own view or none, and
 * the first window's view comes back with it.
 *
 * A translation that stops for want of models (`error: 'models-needed'`) turns into a download
 * prompt in the same widget, naming the size main estimates; Download fetches the models and
 * then translates again (`download-offer.js`).
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
import {
  offerOnAction,
  offerOnEstimated,
  offerOnLoaded,
  offerOnProgress,
  offerOnState,
} from './download-offer.js';
import { directionKey } from './models-logic.js';
import { createWindowViews } from './window-views.js';

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

/** The view each window's widget shows, and which window is in front (`window-views.js`). */
const views = createWindowViews();
/** Windows whose view is the "Translate from X" offer, which their next page load ends. */
const offerWindows = new Set();
/**
 * Whether main has reported the window in front on `page-overlay:active` since the tile woke.
 * Until then the window query stands in for it.
 */
let frontReported = false;

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

/** Draws or closes the widget as a `window-views.js` answer says. */
function applyWidgetStep(step) {
  if (!step) return;
  if (step.draw) drawWidget(step.draw);
  else closeWidget();
}

/**
 * Sets the view `windowId` shows (null for none); it is drawn only while that window is in
 * front. `offer` marks the "Translate from X" offer, which the window's next page load ends.
 */
function showView(windowId, view, { offer = false } = {}) {
  if (offer && view) offerWindows.add(windowId);
  else offerWindows.delete(windowId);
  applyWidgetStep(views.setView(windowId, view));
}

/** Another window came in front: its own view replaces the widget. */
function syncFront(windowId) {
  applyWidgetStep(views.setFront(windowId));
}

/**
 * The window in front. Main's `page-overlay:active` reports keep it current; before the first
 * report since the tile woke, the window query answers and seeds it.
 */
async function frontWindow() {
  if (frontReported) return views.front();
  const queried = await api.window.getFocusedVisibleWindowId();
  // A report that arrived during the query is newer than its answer.
  if (frontReported) return views.front();
  syncFront(queried);
  return views.front();
}

/** The download offer in progress (`download-offer.js`), or null. */
let downloadOffer = null;
/** Directions whose download was accepted in this session: they download without asking. */
const consented = new Set();

/**
 * Applies a `download-offer.js` step: keeps its offer, publishes, and sets the view of the
 * offer's window. A new offer for another window ends the previous one, whose window then shows
 * nothing.
 */
function applyOfferStep(step) {
  const previous = downloadOffer;
  downloadOffer = step.offer;
  for (const { topic, message } of step.publish) api.pubsub.publish(topic, message);
  const windowId = step.offer ? step.offer.windowId : previous ? previous.windowId : null;
  if (previous && step.offer && previous.windowId !== step.offer.windowId) showView(previous.windowId, null);
  if (windowId !== null && step.view !== undefined) showView(windowId, step.view);
}

const handleState = async (state) => {
  if (!state || !Number.isInteger(state.windowId)) return;
  const front = await frontWindow();
  // The download prompt is offered only for the window in front, because it answers a
  // translation the user just asked for there.
  if (front === state.windowId) {
    const step = offerOnState(downloadOffer, state);
    if (step) {
      applyOfferStep(step);
      return;
    }
  }
  // Any other news for the window ends an unanswered download prompt there.
  if (downloadOffer && downloadOffer.windowId === state.windowId && downloadOffer.phase !== 'downloading') {
    downloadOffer = null;
  }
  // The translation's status replaces any offer in the window's widget.
  showView(state.windowId, statusView(state));
};

/** A page declaring another language finished loading: offer to translate it. */
const handleTranslatable = async (msg) => {
  if (!msg || !Number.isInteger(msg.windowId)) return;
  await frontWindow();
  const view = offerView({ lang: msg.lang, target: navigator.language });
  if (!view) return;
  showView(msg.windowId, view, { offer: true });
};

/** A new document in a window: its offer and unanswered prompt were for the old page. */
const handleLoaded = (msg) => {
  applyOfferStep(offerOnLoaded(downloadOffer, msg));
  if (!msg || !offerWindows.has(msg.windowId)) return;
  showView(msg.windowId, null);
};

/** Main's report of the page window in front (null when none is). */
const handleFrontWindow = (msg) => {
  frontReported = true;
  syncFront(msg && Number.isInteger(msg.windowId) ? msg.windowId : null);
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
  // Main's answers about models; the models manager view reads them too, so answers for a pair
  // the tile did not ask about are ignored.
  api.pubsub.subscribe('translate:models:estimated', (msg) => {
    applyOfferStep(offerOnEstimated(downloadOffer, msg, consented));
  });
  api.pubsub.subscribe('translate:models:progress', (msg) => {
    applyOfferStep(offerOnProgress(downloadOffer, msg));
  });
  // The page window in front changed (`main/hybrid-overlay.ts sendActiveHandoff`): the widget
  // follows it.
  api.pubsub.subscribe('page-overlay:active', handleFrontWindow);
  // A button in the widget: the window comes with the click, so it acts on the window whose
  // chrome showed the button.
  api.pubsub.subscribe('widget:action', (msg) => {
    if (msg && msg.extensionId === EXTENSION_ID && msg.widgetId === WIDGET_ID) {
      const step = offerOnAction(downloadOffer, msg);
      if (step.accepted) consented.add(directionKey(step.offer.from, step.offer.to));
      if (step.offer !== downloadOffer || step.view !== undefined) {
        applyOfferStep(step);
        return;
      }
    }
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
