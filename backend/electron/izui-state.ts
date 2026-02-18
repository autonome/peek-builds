/**
 * IZUI State Coordinator — Electron adapter
 *
 * Thin wrapper around the shared IZUI state machine (app/lib/izui-state.js).
 * Sets up the Electron-specific WindowProvider using BrowserWindow.
 *
 * All state machine logic lives in the shared module.
 * See docs/izui.md for comprehensive documentation.
 */

import { DEBUG } from './config.js';

// Re-export everything from the shared module
// Path is ../../../ because at runtime this executes from dist/backend/electron/
// @ts-expect-error — shared JS module in app/lib, no .d.ts declaration file
import { IzuiStateCoordinator, getIzuiCoordinator, escPolicy } from '../../../app/lib/izui-state.js';

export { IzuiStateCoordinator, getIzuiCoordinator, escPolicy };

// Re-export types for TypeScript consumers
export type IzuiState = 'idle' | 'transient' | 'active' | 'overlay';

export interface WindowProvider {
  getAllWindows(): Array<{ id: number; isDestroyed(): boolean; isFocused(): boolean; isVisible(): boolean; webContents?: { getURL(): string } }>;
  fromId(id: number): { show(): void; isDestroyed(): boolean } | null;
}

export interface IzuiSession {
  id: string;
  entryMode: 'active' | 'transient';
  windowStack: number[];
  overlayWindowId: number | null;
  hiddenWindowIds: number[];
  focusedWindowId: number | null;
}

// Set up Electron-specific WindowProvider
// Lazy-load to allow testing without Electron
try {
  const electron = await import('electron');
  const BrowserWindow = electron.BrowserWindow;

  const electronWindowProvider = {
    getAllWindows: () => BrowserWindow.getAllWindows(),
    fromId: (id: number) => BrowserWindow.fromId(id),
  };

  getIzuiCoordinator().setWindowProvider(electronWindowProvider);
  DEBUG && console.log('[izui-state] Electron WindowProvider installed');
} catch {
  // Electron not available (e.g., in unit tests)
  DEBUG && console.log('[izui-state] Running without Electron (test mode)');
}
