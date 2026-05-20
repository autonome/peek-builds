/**
 * Type declarations for runtime-external.js — the chrome.runtime.sendMessage
 * cross-origin / externally_connectable polyfill.
 */

export function setupMainProcess(
  session: import('electron').Session,
  options: { ipcMain: import('electron').IpcMain }
): { cleanup: () => void };

export function getBgInjection(): string;

export function getPreloadPath(): string;

export function getPagePolyfillSource(extId?: string): string;
