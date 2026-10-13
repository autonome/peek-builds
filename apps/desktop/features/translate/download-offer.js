/**
 * Pure state for asking, from the page, to download the models a translation lacks. No
 * `window.app` here, so `tests/unit/translate-tile.test.js` runs it under Node.
 *
 * When main answers a translation with `error: 'models-needed'` (`main/page-translate/
 * engine-resources.ts`), the tile asks main how much the pair would fetch
 * (`translate:models:estimate`), then shows in its page widget a prompt naming the size, with
 * Download and Not now buttons. Download publishes `translate:models:download`; when main
 * reports that pair `done`, the tile asks for the translation again (`translate:page`).
 *
 * The tile holds at most one such offer, `offer = {windowId, from, to, phase, prompt?, stale?}`
 * with phase `estimating` → `asking` → `downloading`. Every step answers
 * `{offer, publish: [{topic, message}], view}` where `view` is a widget view to draw, `null` to
 * close the widget, or `undefined` to leave it as it is.
 *
 * Consent is asked once per direction in a session: a pair accepted once downloads again
 * without a prompt (its files went missing, say), and a download of nothing (every file already
 * on disk) never asks.
 */

import { MODELS_TOPICS, directionKey, directionLabel, promptText } from './models-logic.js';

export const MODELS_NEEDED = 'models-needed';
/** Widget actions of the prompt (`widget:action` `action`). */
export const DOWNLOAD_ACTION = 'download-models';
export const DECLINE_ACTION = 'decline-download';

const TITLE = 'Translation';

const NOTHING = Object.freeze({ publish: [], view: undefined });

function estimatingView(offer) {
  return { title: TITLE, text: `Checking the download for ${directionLabel(offer.from, offer.to)}…`, actions: [] };
}

function askingView(offer) {
  return {
    title: TITLE,
    text: promptText(offer.prompt),
    actions: [
      { action: DOWNLOAD_ACTION, label: 'Download' },
      { action: DECLINE_ACTION, label: 'Not now' },
    ],
  };
}

function downloadingView(offer) {
  return { title: TITLE, text: `Downloading the ${directionLabel(offer.from, offer.to)} translation model…`, actions: [] };
}

function viewOf(offer) {
  if (offer.phase === 'estimating') return estimatingView(offer);
  if (offer.phase === 'asking') return askingView(offer);
  return downloadingView(offer);
}

function download(offer) {
  const next = { windowId: offer.windowId, from: offer.from, to: offer.to, phase: 'downloading', stale: offer.stale === true };
  return {
    offer: next,
    publish: [{ topic: MODELS_TOPICS.download, message: { from: offer.from, to: offer.to } }],
    view: downloadingView(next),
  };
}

/**
 * A `translate:state` for the window in front. Starts an offer when the translation stopped for
 * want of models; null when the state is not about missing models (the caller draws it as usual).
 */
export function offerOnState(offer, state) {
  if (!state || state.error !== MODELS_NEEDED || typeof state.from !== 'string' || typeof state.to !== 'string') return null;
  // Main reports the failure twice (while restoring, then idle); one offer serves both.
  if (offer && offer.windowId === state.windowId && offer.from === state.from && offer.to === state.to) {
    return { offer, publish: [], view: viewOf(offer) };
  }
  const next = { windowId: state.windowId, from: state.from, to: state.to, phase: 'estimating' };
  return {
    offer: next,
    publish: [{ topic: MODELS_TOPICS.estimate, message: { from: state.from, to: state.to } }],
    view: estimatingView(next),
  };
}

const ESTIMATE_FAILURE_TEXT = {
  unsupported: 'No translation model covers these languages.',
  'same-language': 'No translation model covers these languages.',
  'no-engine': 'The translation engine is not available.',
};

/** A `translate:models:estimated` answer; ignored unless it is for the offer's pair. */
export function offerOnEstimated(offer, msg, consented) {
  if (!offer || offer.phase !== 'estimating' || !msg || msg.from !== offer.from || msg.to !== offer.to) return { offer, ...NOTHING };
  if (!msg.ok) {
    const text = ESTIMATE_FAILURE_TEXT[msg.reason] || (msg.error ? `Could not check the download: ${msg.error}` : 'Could not check the download.');
    return { offer: null, publish: [], view: { title: TITLE, text, actions: [] } };
  }
  const downloadBytes = Number(msg.downloadBytes) || 0;
  if (downloadBytes <= 0 || consented.has(directionKey(offer.from, offer.to))) return download(offer);
  const next = {
    ...offer,
    phase: 'asking',
    prompt: {
      from: offer.from,
      to: offer.to,
      downloadBytes,
      diskBytes: Number(msg.diskBytes) || 0,
      engineBytes: Number(msg.engineBytes) || 0,
    },
  };
  return { offer: next, publish: [], view: askingView(next) };
}

/**
 * A click on the prompt. `accepted` is true when the answer adds the pair to the session's
 * consented directions; the caller keeps that set.
 */
export function offerOnAction(offer, msg) {
  if (!offer || offer.phase !== 'asking' || !msg || msg.windowId !== offer.windowId) return { offer, accepted: false, ...NOTHING };
  if (msg.action === DOWNLOAD_ACTION) return { ...download(offer), accepted: true };
  if (msg.action === DECLINE_ACTION) return { offer: null, accepted: false, publish: [], view: null };
  return { offer, accepted: false, ...NOTHING };
}

/** A `translate:models:progress` report; only `done` and `failed` for the offer's pair matter. */
export function offerOnProgress(offer, msg) {
  if (!offer || offer.phase !== 'downloading' || !msg || msg.from !== offer.from || msg.to !== offer.to) return { offer, ...NOTHING };
  if (msg.phase === 'done') {
    // A page that changed during the download did not ask for this translation.
    if (offer.stale) return { offer: null, publish: [], view: null };
    return {
      offer: null,
      publish: [{ topic: 'translate:page', message: { windowId: offer.windowId, from: offer.from, to: offer.to } }],
      view: undefined,
    };
  }
  if (msg.phase === 'failed') {
    const text = `The download failed${msg.error ? `: ${msg.error}` : '.'}`;
    return { offer: null, publish: [], view: offer.stale ? null : { title: TITLE, text, actions: [] } };
  }
  return { offer, ...NOTHING };
}

/**
 * The offer's window loaded another page. An unanswered prompt was for the old page and closes;
 * a download under way finishes but does not translate the new page.
 */
export function offerOnLoaded(offer, msg) {
  if (!offer || !msg || msg.windowId !== offer.windowId) return { offer, ...NOTHING };
  if (offer.phase === 'downloading') return { offer: { ...offer, stale: true }, publish: [], view: undefined };
  return { offer: null, publish: [], view: null };
}
