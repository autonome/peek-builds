/**
 * Type declarations for runtime-external.js — the chrome.runtime.sendMessage
 * cross-origin / externally_connectable polyfill.
 */

export function setupMainProcess(
  session: import('electron').Session,
  options: {
    ipcMain: import('electron').IpcMain;
    findExtensionByOrigin?: (origin: string) => string | null;
    getCanonicalChromeIdForOrigin?: (origin: string) => string | null;
  }
): { cleanup: () => void };

/**
 * Flag the relay as shutting down. After this the IPC_SEND_FROM_PAGE handler
 * returns an inert error envelope instead of dispatching into session /
 * service-worker natives being torn down at quit (peek 048997b2). Idempotent.
 */
export function markRuntimeExternalQuitting(): void;

/** Test-only: reset the shutdown flag so unit tests stay independent. */
export function _setQuittingForTests(v?: boolean): void;

export function getBgInjection(): string;

export function getPreloadPath(): string;

export function getBridgePreloadPath(): string;

export function getPagePolyfillSource(extId?: string): string;

export function setBridgeWindowsRegistry(
  registry: Map<string, import('electron').BrowserWindow>
): void;
