/**
 * Preload for the peek-bridge hidden BrowserWindow.
 *
 * The bridge window loads `chrome-extension://<ext-id>/peek-bridge.html` so
 * it lives inside the extension's origin and has native access to
 * `chrome.runtime.connect()` for same-extension Port communication with the
 * BG service worker. This preload exposes a minimal `ipcRenderer` surface via
 * contextBridge so the bridge page can receive forwarded messages from the
 * main process and relay them into the BG SW through the long-lived
 * chrome.runtime Port.
 *
 * Architecture:
 *   page (cross-origin) → main IPC → bridge window IPC → chrome.runtime.Port → BG SW
 *
 * CJS because Electron preloads run in a sandboxed CJS context. Keep this
 * file self-contained — it cannot import from ESM siblings at preload time.
 *
 * @see apps/desktop/main/chrome-api-polyfills/runtime-external.js
 * @see apps/desktop/main/chrome-extensions.ts (bridge window spawn)
 */
'use strict';

const { ipcRenderer, contextBridge } = require('electron');

const IPC_FORWARD_CHANNEL = 'peek:auth-ext:forward';
const IPC_RESPONSE_CHANNEL = 'peek:auth-ext:response';

console.error('[peek:bridge:preload] loaded for', location.href);

/**
 * Expose a narrow bridge API to the extension page's MAIN world via
 * contextBridge. The page registers a handler for forwarded messages and
 * sends responses back.
 */
contextBridge.exposeInMainWorld('peekBridge', {
  /**
   * Register a listener for messages forwarded from the main process.
   * The listener receives the payload and a sendResponse callback.
   *
   * @param {function} listener - Called with (payload, sendResponse)
   */
  onForward(listener) {
    ipcRenderer.on(IPC_FORWARD_CHANNEL, (_event, payload) => {
      console.error('[peek:bridge:preload] forward received reqId=', payload && payload.reqId);
      const sendResponse = (response) => {
        ipcRenderer.send(IPC_RESPONSE_CHANNEL, {
          reqId: payload && payload.reqId,
          response,
        });
      };
      try {
        listener(payload, sendResponse);
      } catch (err) {
        console.error('[peek:bridge:preload] listener threw:', err && err.message);
        ipcRenderer.send(IPC_RESPONSE_CHANNEL, {
          reqId: payload && payload.reqId,
          error: (err && err.message) || String(err),
        });
      }
    });
    console.error('[peek:bridge:preload] onForward listener registered');
  },

  /**
   * Log from the bridge page to main stderr (console.error in renderers
   * forwards to main stderr via Electron's built-in log forwarding).
   */
  log(...args) {
    console.error('[peek:bridge:page]', ...args);
  },
});
