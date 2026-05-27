export function registerAll(session: any, options?: {
  ipcMain?: any;
  app?: any;
  apis?: string[];
  findExtensionByOrigin?: (origin: string) => string | null;
  getCanonicalChromeIdForOrigin?: (origin: string) => string | null;
}): {
  cleanup: () => void;
  getPreloadScript: () => string;
};
