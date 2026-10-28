/**
 * Preload for the startup risk notice window. CommonJS TypeScript: the
 * sandbox rejects ESM preloads. Exposes a three-method bridge and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('startupConsent', Object.freeze({
  getNotice: (): Promise<unknown> => ipcRenderer.invoke('startup-consent:get-notice'),
  decide: (action: 'accept' | 'decline', acknowledgments?: boolean[]): void => {
    ipcRenderer.send('startup-consent:decision', {
      action,
      acknowledgments: Array.isArray(acknowledgments) ? Array.from(acknowledgments, v => v === true) : [],
    });
  },
  onError: (callback: (message: string) => void): void => {
    ipcRenderer.on('startup-consent:error', (_event, message: unknown) => {
      callback(typeof message === 'string' ? message : 'Could not save your acknowledgment.');
    });
  },
}));
