/**
 * Type declarations for runtime-external.js — the chrome.runtime.sendMessage
 * cross-origin / externally_connectable polyfill.
 */

export function setupMainProcess(
  session: import('electron').Session,
  options: {
    ipcMain: import('electron').IpcMain;
    findExtensionByOrigin?: (origin: string) => string | null;
  }
): { cleanup: () => void };

export function getBgInjection(): string;

export function getPreloadPath(): string;

export function getBridgePreloadPath(): string;

export function getPagePolyfillSource(extId?: string): string;

export function setBridgeWindowsRegistry(
  registry: Map<string, import('electron').BrowserWindow>
): void;
