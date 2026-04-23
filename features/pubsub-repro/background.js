/**
 * Pubsub Repro Background
 *
 * Minimal echo: on receiving `reproduce:request` on GLOBAL scope,
 * publish `reproduce:response` with a fixed payload on GLOBAL scope.
 *
 * Mirrors websearch background.js pattern: api.pubsub.subscribe/publish
 * via onChannel/emitChannel helpers.
 */

const api = window.app;

function onChannel(topic, handler) {
  api.pubsub.subscribe(topic, handler);
}

function emitChannel(topic, data) {
  api.pubsub.publish(topic, data);
}

const handleRequest = (msg) => {
  console.log('[ext:pubsub-repro] bg received request:', msg);
  emitChannel('reproduce:response', { ok: true, payload: [1, 2, 3], echo: msg });
};

// Command to force the extension to load without needing a window
const handleCommand = () => {
  console.log('[ext:pubsub-repro] bg received cmd:execute:pubsub repro');
};

const init = async () => {
  console.log('[ext:pubsub-repro] bg init');
  onChannel('reproduce:request', handleRequest);
  api.commands.register({
    name: 'pubsub repro',
    description: 'Open the pubsub repro window',
    action: { type: 'execute' }
  });
  onChannel('cmd:execute:pubsub repro', handleCommand);
};

const uninit = () => {
  console.log('[ext:pubsub-repro] bg uninit');
};

export default {
  id: 'pubsub-repro',
  init,
  uninit
};
