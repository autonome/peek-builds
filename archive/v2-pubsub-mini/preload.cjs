// V2 tile-style preload: contextBridge + ipcRenderer.send for pubsub
// Mirrors Peek's tile-preload.cts pattern.
const { contextBridge, ipcRenderer } = require('electron');

const subscribers = new Map(); // topic -> Set<callback>
const log = (...args) => {
  const msg = `[preload pid=${process.pid}] ${args.join(' ')}`;
  console.error(msg);
};

log('preload loaded');

// Forward main-process broadcasts to in-renderer subscribers.
// We listen on a single fan-in channel: 'pubsub:message' carrying {topic, data}.
ipcRenderer.on('pubsub:message', (_evt, payload) => {
  log('renderer got pubsub:message', JSON.stringify(payload));
  const { topic, data } = payload || {};
  const cbs = subscribers.get(topic);
  if (!cbs) return;
  for (const cb of cbs) {
    try { cb(data); } catch (e) { log('subscriber callback error', e.message); }
  }
});

contextBridge.exposeInMainWorld('app', {
  pid: process.pid,
  publish(topic, data) {
    log('publish() called', topic);
    try {
      ipcRenderer.send('tile:pubsub:publish', { topic, data });
      return { published: true };
    } catch (e) {
      log('publish() threw', e.message);
      return { published: false, error: e.message };
    }
  },
  subscribe(topic, callback) {
    log('subscribe() called', topic);
    if (!subscribers.has(topic)) subscribers.set(topic, new Set());
    subscribers.get(topic).add(callback);
    try {
      ipcRenderer.send('tile:pubsub:subscribe', { topic });
    } catch (e) {
      log('subscribe() send threw', e.message);
    }
    return () => {
      subscribers.get(topic)?.delete(callback);
      ipcRenderer.send('tile:pubsub:unsubscribe', { topic });
    };
  },
  // Renderer-side log function so HTML pages can write to main stdout
  rlog(msg) {
    ipcRenderer.send('mini:log', msg);
  },
});
