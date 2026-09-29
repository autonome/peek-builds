/**
 * Electron Backend Entry Point
 *
 * Exports database functions and types for the Electron main process.
 */

// Configuration
export {
  APP_DEF_WIDTH,
  APP_DEF_HEIGHT,
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
  TOPICS,
  setProfile,
  getProfile,
  isTestProfile,
  isDevProfile,
  isHeadless,
} from './config.js';

// Database lifecycle and helpers
export {
  initDatabase,
  closeDatabase,
  getDb,
  generateId,
  now,
  parseUrl,
  normalizeUrl,
  isValidTable,
  calculateFrecency,
} from './datastore.js';

// Datastore operations
export {
  // Content
  addContent,
  queryContent,
  // Tags
  getOrCreateTag,
  getTagsByFrecency,
  // Generic
  getTable,
  setRow,
  getStats,
} from './datastore.js';

// Re-export shared data types
export type {
  Content,
  Tag,
  Item,
  ItemTag,
  ItemType,
  ItemOptions,
  ItemFilter,
  ItemVisit,
  ItemVisitFilter,
  ItemVisitOptions,
  Extension,
  ExtensionSetting,
  DatastoreStats,
  TableName,
  ContentFilter,
  ContentOptions,
  BackupConfig,
  BackupResult,
} from '../types/index.js';

export { tableNames } from '../types/index.js';

// Protocol handling
export {
  APP_SCHEME,
  APP_PROTOCOL,
  registerScheme,
  registerTilePath,
  getTilePath,
  getRegisteredTileIds,
  registerThemePath,
  getThemePath,
  getRegisteredThemeIds,
  getActiveThemeId,
  setActiveThemeId,
  initProtocol,
} from './protocol.js';

// Feature/tile state queries
export {
  discoverFeatures,
  loadFeatureManifest,
  isBuiltinFeatureEnabled,
} from './tile-feature-state.js';

export type {
  DiscoveredFeature,
} from './tile-feature-state.js';

// System tray
export {
  initTray,
  getTray,
  destroyTray,
} from './tray.js';

export type { TrayOptions } from './tray.js';

// Shortcuts
export {
  parseShortcut,
  inputMatchesShortcut,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  registerLocalShortcut,
  unregisterLocalShortcut,
  handleLocalShortcut,
  unregisterShortcutsForAddress,
  getGlobalShortcutSource,
  isGlobalShortcutRegistered,
} from './shortcuts.js';

export type { InputEvent } from './shortcuts.js';

// PubSub messaging
export {
  publish,
  subscribe,
  unsubscribe,
  unsubscribeAll,
  setPubsubBroadcaster,
  getSystemAddress,
} from './pubsub.js';


// Main process orchestration
export {
  configure,
  initialize,
  discoverBuiltinFeatures,
  discoverBuiltinThemes,
  loadFeatures,
  getRunningTiles,
  // Dev tile support (CLI --load-extension)
  registerDevTile,
  loadDevTile,
  loadDevTiles,
  cleanupDevTiles,
  isDevTile,
  getDevTileIds,
  reloadTile,
  attachWindowOpenPayload,
  getWindowInfo,
  findWindowsByKey,
  findWindowsByUrl,
  removeWindow,
  getChildWindows,
  getAllWindows,
  shutdown,
  // External URL handling
  handleExternalUrl,
  setAppReady,
  notifyFrontendReady,
  notifySessionRestoreDone,
  registerExternalUrlHandlers,
  registerSecondInstanceHandler,
  handleCliUrl,
  // Background window
  createBackgroundWindow,
  getBackgroundWindow,
  // App lifecycle
  registerWindowAllClosedHandler,
  registerActivateHandler,
  requestSingleInstance,
  quitApp,
  validateThemeCSS,
  loadClosedWindowStack,
  saveClosedWindowStack,
  getClosedWindowStack,
  getClosedWindowCount,
  flushPendingCloseSave,
} from './main.js';

export type { AppConfig } from './main.js';

// IPC handlers
export {
  registerDarkModeHandlers,
  registerWindowHandlers,
  registerAllHandlers,
  restoreSavedTheme,
  getDarkModeSetting,
  applyDarkModeSetting,
  reopenLastClosedWindow,
  openNewPageWindow,
  installHybridNavbarActionRouting,
} from './ipc.js';

// Window helpers
export {
  setPrefsGetter,
  modWindow,
  showWindowHeadlessSafe,
  addEscHandler,
  winDevtoolsConfig,
  closeWindow,
  applyDockPreference,
  closeOrHideWindow,
  closeFocusedWindow,
  resolveFocusedWindowIdForClose,
  closeChildWindows,
  getSystemThemeBackgroundColor,
} from './windows.js';

// Backup module
export {
  getBackupConfig,
  setBackupConfig,
  createBackup,
  checkAndRunDailyBackup,
  cleanOldBackups,
  listBackups,
} from './backup.js';

// Re-export frontend API types (the contract that tile-preload.cjs implements)
export type {
  IPeekApi,
  ApiResult,
  IShortcutsApi,
  IWindowApi,
  IDatastoreApi,
  IPubSubApi,
  ICommandsApi,
  IExtensionsApi,
  ISettingsApi,
  IEscapeApi,
} from '../types/api.js';

// Adblocker module
export {
  initAdblocker,
  enableBlocking,
  disableBlocking,
  toggleBlocking,
  isBlockingEnabled,
  getBlockedCount,
  resetBlockedCount,
  getAdblockerStatus,
  applyAdblockerConfig,
  cleanupAdblocker,
  enableBlockingInSession,
  disableBlockingInSession,
} from './adblocker.js';

export type { AdblockerConfig } from './adblocker.js';

// Chrome extension manager
export {
  initChromeExtensionManager,
  loadEnabledChromeExtensions,
  getChromeExtensions,
  enableChromeExtension,
  disableChromeExtension,
  isChromeExtensionEnabled,
  isChromeExtensionLoaded,
  getChromeExtensionStatus,
  getChromeExtensionUiEntries,
  openChromeExtensionPage,
  cleanupChromeExtensions,
} from './chrome-extensions.js';

export type {
  ChromeManifest,
  ChromeExtensionInfo,
  ChromeExtensionUiEntry,
  LoadedChromeExtension,
  ChromeExtensionSetting,
} from './chrome-extensions.js';

// Session partition module
export {
  initSessionPartition,
  getProfileSession,
  getPartitionString,
  getCurrentProfileId,
  isPartitionInitialized,
  getPartitionInfo,
} from './session-partition.js';

// Display change watcher
export {
  initDisplayWatcher,
  cleanupDisplayWatcher,
} from './display-watcher.js';
