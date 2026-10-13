/**
 * Translation models manager view (`peek://translate/models.html`, opened by the
 * `manage translation models` command). Lists the model directions on disk with their sizes and
 * a delete button, and the catalogue's other directions with a download button. A download asks
 * first, naming the bytes it would fetch; only a yes publishes `translate:models:download`.
 *
 * All state changes go through the pure functions in `models-logic.js`; this file only wires
 * them to pubsub and the DOM.
 */

import {
  INITIAL_MODELS_STATE,
  MODELS_TOPICS,
  answerPrompt,
  applyEstimated,
  applyListed,
  applyProgress,
  modelsView,
  promptText,
  requestDelete,
  requestDownload,
} from './models-logic.js';

const api = window.app;

let state = INITIAL_MODELS_STATE;

const $ = (selector) => document.querySelector(selector);

function publish(request) {
  if (request) api.pubsub.publish(request.topic, request.message);
}

function setState(next) {
  state = next;
  render();
}

function step(result) {
  setState(result.state);
  publish(result.publish);
}

function rowElement(row, button) {
  const el = document.createElement('div');
  el.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = row.label;
  text.append(label);
  const detail = row.failure || row.busyText || row.size || '';
  if (detail) {
    const d = document.createElement('span');
    d.className = row.failure ? 'row-detail row-failure' : 'row-detail';
    d.textContent = detail;
    text.append(d);
  }
  el.append(text);

  const b = document.createElement('peek-button');
  b.setAttribute('size', 'sm');
  b.setAttribute('variant', button.variant);
  b.dataset.action = button.action;
  b.dataset.from = row.from;
  b.dataset.to = row.to;
  b.textContent = button.label;
  if (row.busy) {
    b.setAttribute('disabled', '');
    b.setAttribute('loading', '');
  }
  el.append(b);
  return el;
}

function fillRows(container, rows, button, emptyText) {
  container.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const row of rows) container.append(rowElement(row, button));
}

function render() {
  const view = modelsView(state);

  const status = $('.status');
  status.hidden = !view.status;
  status.textContent = view.status || '';

  $('.total').textContent = view.installed.length > 0 ? view.total : '';
  fillRows($('.installed-rows'), view.installed, { action: 'delete', label: 'Delete', variant: 'secondary' },
    'No translation models are on this device yet.');
  $('.available-section').hidden = view.available === null;
  if (view.available) {
    fillRows($('.available-rows'), view.available, { action: 'download', label: 'Download', variant: 'primary' },
      'Every model in the catalogue is on this device.');
  }

  const dialog = $('.download-prompt');
  if (state.prompt) {
    $('.prompt-text').textContent = promptText(state.prompt);
    if (!dialog.open) dialog.show();
  } else if (dialog.open) {
    dialog.close();
  }
}

function onRowsClick(event) {
  const button = event.target.closest('peek-button[data-action]');
  if (!button || button.hasAttribute('disabled')) return;
  const { action, from, to } = button.dataset;
  if (action === 'download') step(requestDownload(state, from, to));
  else if (action === 'delete') step(requestDelete(state, from, to));
}

async function init() {
  await api.initialize();

  api.pubsub.subscribe(MODELS_TOPICS.listed, (msg) => setState(applyListed(state, msg)));
  api.pubsub.subscribe(MODELS_TOPICS.estimated, (msg) => step(applyEstimated(state, msg)));
  api.pubsub.subscribe(MODELS_TOPICS.progress, (msg) => setState(applyProgress(state, msg)));

  $('.installed-rows').addEventListener('click', onRowsClick);
  $('.available-rows').addEventListener('click', onRowsClick);
  $('.prompt-accept').addEventListener('click', () => step(answerPrompt(state, true)));
  $('.prompt-cancel').addEventListener('click', () => step(answerPrompt(state, false)));
  // Escape, the backdrop or the close button: the same as Cancel. After Download or Cancel the
  // prompt is already cleared, so this does nothing.
  $('.download-prompt').addEventListener('close', () => {
    if (state.prompt) step(answerPrompt(state, false));
  });

  render();
  // Reading the catalogue may contact Mozilla's server; opening this view is the request for it.
  api.pubsub.publish(MODELS_TOPICS.list, { catalogue: true });
}

init().catch((err) => {
  console.error('[ext:translate] models view failed to start:', err);
  state = { ...state, loaded: true, error: String(err?.message || err) };
  render();
});
