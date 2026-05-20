/**
 * Pubsub Repro Home
 *
 * Mirrors websearch home.js: subscribe on GLOBAL, publish on GLOBAL,
 * wait for response to be written back by the background.
 */

const api = window.app;

function onChannel(topic, handler) {
  api.pubsub.subscribe(topic, handler);
}

function emitChannel(topic, data) {
  api.pubsub.publish(topic, data);
}

// Expose for test assertions
window._reproResponse = null;

const handleResponse = (msg) => {
  console.log('[pubsub-repro:home] got response:', msg);
  window._reproResponse = msg;
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  if (statusEl) statusEl.textContent = 'received';
  if (resultEl) resultEl.textContent = JSON.stringify(msg, null, 2);
};

const init = () => {
  console.log('[pubsub-repro:home] init');
  onChannel('reproduce:response', handleResponse);
  // Publish request on GLOBAL — background should receive and echo back
  emitChannel('reproduce:request', { hello: 'world' });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
