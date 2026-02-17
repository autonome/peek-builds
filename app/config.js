const id = '8aadaae5-2594-4968-aba0-707f0d371cfb';

const labels = {
  name: 'Settings',
  prefs: {
    shortcutKey: 'Settings shortcut',
    quitShortcut: 'Quit shortcut',
    startupFeature: 'Startup feature',
    showTrayIcon: 'Show tray icon',
    showInDockAndSwitcher: 'Show in dock',
    backupDir: 'Backup directory',
    hideTitleBar: 'Hide title bars',
    restoreSession: 'Restore session on startup',
    sessionAutosaveInterval: 'Autosave interval (minutes)',
    dragHoldDelay: 'Drag hold delay (seconds)',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.prefs.schema.json",
  "title": "Global Settings",
  "description": "Peek user preferences",
  "type": "object",
  "properties": {
    "shortcutKey": {
      "description": "App keyboard shortcut to load settings",
      "type": "string",
      "default": "CommandOrControl+,"
    },
    "height": {
      "description": "User-set or -defined height of Settings page",
      "type": "integer",
      "default": 600
    },
    "width": {
      "description": "User-set or -defined width of Settings page",
      "type": "integer",
      "default": 800
    },
    "startupFeature": {
      "description": "Address of what to load at startup, if anything",
      "type": "string",
      "default": "peek://app/settings/settings.html"
    },
    "showTrayIcon": {
      "description": "Whether to show app icon in system tray",
      "type": "boolean",
      "default": true
    },
    "showInDockAndSwitcher": {
      "description": "Always show in dock/app switcher, even when no windows are open. When disabled, dock icon only appears while windows are visible.",
      "type": "boolean",
      "default": true
    },
    "quitShortcut": {
      "description": "Keyboard shortcut to quit the app",
      "type": "string",
      "default": "CommandOrControl+Q"
    },
    "backupDir": {
      "description": "Directory for daily database backups. Leave empty to disable automatic backups.",
      "type": "string",
      "default": ""
    },
    "hideTitleBar": {
      "description": "Hide window title bars by default (frameless windows)",
      "type": "boolean",
      "default": true
    },
    "restoreSession": {
      "description": "Restore open windows when app restarts",
      "type": "boolean",
      "default": true
    },
    "sessionAutosaveInterval": {
      "description": "Periodically save session state (interval in minutes, 0 = disabled)",
      "type": "integer",
      "default": 5
    },
    "pageWidth": {
      "description": "Default width for new page windows",
      "type": "integer",
      "default": 800
    },
    "pageHeight": {
      "description": "Default height for new page windows",
      "type": "integer",
      "default": 600
    },
    "dragHoldDelay": {
      "description": "Seconds to hold still before drag mode activates (0 = instant)",
      "type": "number",
      "default": 2
    },
  },
  "required": [ "shortcutKey", "startupFeature", "enableTrayIcon", "showInDockAndSwitcher", "quitShortcut" ]
};

const featureSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.settings.feature.schema.json",
  "title": "Feature",
  "description": "Application feature",
  "type": "object",
  "properties": {
    "id": {
      "description": "Unique id of the feature",
      "type": "string"
    },
    "name": {
      "description": "Name of the feature",
      "type": "string"
    },
    "description": {
      "description": "Description of the feature",
      "type": "string"
    },
    "start_url": {
      "description": "Address to load the feature",
      "type": "string",
      "format": "uri"
    },
    "settings_url": {
      "description": "Address to load the feature's settings",
      "type": "string",
      "format": "uri"
    },
    "enabled": {
      "description": "Whether the feature is enabled or not.",
      "type": "boolean",
      "default": true
    },
  },
  "required": [ "id", "name", "description", "start_url", "enabled" ]
};

const featureListSchema = {
  "title": "Features",
  "type": 'array',
  "features": { "$ref": "#/$defs/feature" }
};

const schemas = {
  prefs: prefsSchema,
  feature: featureSchema,
  featureList: featureListSchema
};

const storageKeys = {
  PREFS: 'prefs',
  ITEMS: 'items',
};

// defaults for user-modifiable preferences or data
const defaults = {
  prefs: {
    shortcutKey: 'CommandOrControl+,',
    quitShortcut: 'CommandOrControl+Q',
    height: 850,
    width: 800,
    startupFeature: 'peek://app/settings/settings.html',
    showTrayIcon: true,
    showInDockAndSwitcher: true,
    backupDir: '',
    hideTitleBar: true,
    restoreSession: true,
    sessionAutosaveInterval: 5,
    pageWidth: 800,
    pageHeight: 600,
    dragHoldDelay: 2
  },
  items: [
    { id: '82de735f-a4b7-4fe6-a458-ec29939ae00d',
      name: 'Groups',
      description: 'View your web in groups',
      start_url: 'peek://ext/groups/background.js',
      enabled: false,
      settings_url: 'peek://ext/groups/settings.html',
      extension: true,
    },
    { id: 'ef3bd271-d408-421f-9338-47b615571e43',
      name: 'Peeks',
      description: 'Peek at pages in a transient popup using keyboard shortcuts',
      start_url: 'peek://ext/peeks/background.js',
      enabled: false,
      settings_url: 'peek://ext/peeks/settings.html',
      extension: true,
    },
    { id: '434108f3-18a6-437a-b507-2f998f693bb2',
      name: 'Slides',
      description: 'Open web pages as side/top/bottom bars',
      start_url: 'peek://ext/slides/background.js',
      enabled: false,
      settings_url: 'peek://ext/slides/settings.html',
      extension: true,
    }
  ]
};

export default {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
