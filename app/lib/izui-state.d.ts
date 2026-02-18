export type IzuiState = 'idle' | 'transient' | 'active' | 'overlay';

export interface WindowInfo {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
}

export interface WindowProvider {
  getAllWindows(): WindowInfo[];
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

export declare class IzuiStateCoordinator {
  setWindowProvider(provider: WindowProvider): void;
  _setWindowProvider(provider: WindowProvider): void;
  resetWindowProvider(): void;
  _resetWindowProvider(): void;
  setAppFocused(focused: boolean): void;
  isAppFocused(): boolean;
  _resetAll(): void;
  startSession(entryMode: 'active' | 'transient'): void;
  endSession(): void;
  evaluateOnShow(excludeWindowId?: number): 'active' | 'transient';
  enterOverlay(windowId: number, hiddenIds: number[]): void;
  exitOverlay(): void;
  setFocusedWindow(windowId: number): void;
  clearFocusedWindow(windowId: number): void;
  pushWindow(windowId: number): void;
  popWindow(windowId: number): void;
  isTransient(): boolean;
  getState(): IzuiState;
  getSession(): IzuiSession | null;
  getEffectiveMode(targetWindowId?: number): 'default' | 'active';
  isOverlay(): boolean;
  getFocusedWindowId(): number | null;
}

export declare function getIzuiCoordinator(): IzuiStateCoordinator;
export declare function escPolicy(
  sessionState: string,
  role: string
): 'close' | 'close-and-restore' | 'nothing';
