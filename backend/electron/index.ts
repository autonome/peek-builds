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
  IPC_CHANNELS,
  TOPICS,
  setPreloadPath,
  setProfile,
  getPreloadPath,
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
  registerExtensionPath,
  getExtensionPath,
  getRegisteredExtensionIds,
  registerThemePath,
  getThemePath,
  getRegisteredThemeIds,
  getActiveThemeId,
  setActiveThemeId,
  initProtocol,
} from './protocol.js';

// Extension management
export {
  discoverExtensions,
  loadExtensionManifest,
  isBuiltinExtensionEnabled,
  getExternalExtensions,
} from './extensions.js';

export type {
  ExtensionManifest,
  DiscoveredExtension,
} from './extensions.js';

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
  scopes,
  publish,
  subscribe,
  unsubscribe,
  unsubscribeAll,
  setExtensionBroadcaster,
  getSystemAddress,
} from './pubsub.js';

export type { Scope } from './pubsub.js';

// Main process orchestration
export {
  configure,
  initialize,
  discoverBuiltinExtensions,
  discoverBuiltinThemes,
  createExtensionWindow,
  loadEnabledExtensions,
  loadExtensions,
  getRunningExtensions,
  destroyExtensionWindow,
  getExtensionWindow,
  // Dev extension support (CLI --load-extension)
  registerDevExtension,
  loadDevExtension,
  loadDevExtensions,
  cleanupDevExtensions,
  isDevExtension,
  getDevExtensionIds,
  reloadExtension,
  registerWindow,
  getWindowInfo,
  findWindowByKey,
  removeWindow,
  getChildWindows,
  getAllWindows,
  shutdown,
  // External URL handling
  handleExternalUrl,
  setAppReady,
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
} from './main.js';

export type { AppConfig } from './main.js';

// IPC handlers
export {
  registerDatastoreHandlers,
  registerExtensionHandlers,
  registerDarkModeHandlers,
  registerWindowHandlers,
  registerMiscHandlers,
  registerAllHandlers,
  restoreSavedTheme,
  getDarkModeSetting,
  applyDarkModeSetting,
} from './ipc.js';

// Window helpers
export {
  setPrefsGetter,
  modWindow,
  addEscHandler,
  winDevtoolsConfig,
  closeWindow,
  getVisibleWindowCount,
  updateDockVisibility,
  maybeHideApp,
  closeOrHideWindow,
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

// Re-export frontend API types (the contract that preload.js implements)
export type {
  IPeekApi,
  ApiResult,
  ApiScope,
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
