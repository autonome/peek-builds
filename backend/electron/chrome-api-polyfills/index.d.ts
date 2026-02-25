export function registerAll(session: any, options?: { ipcMain?: any; app?: any }): {
  cleanup: () => void;
  getPreloadScript: () => string;
};
