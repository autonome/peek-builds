/**
 * Sheets Extension Background Script
 *
 * Widget sheets with freeform card layouts hosting webviews.
 *
 * Runs in isolated extension process (peek://sheets/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { windowParamsForSheet } from './sheet-options.js';
import { buildSheetShortcuts, SHEET_OPEN_TOPIC, SHEETS_CHANGED_TOPIC } from './sheet-hotkeys.js';
import { loadSheetsMap, loadSheet, sheetKey, SHEETS_KEY } from './sheet-store.js';

const api = window.app;

// Extension content is served from peek://sheets/ (hybrid mode)
const sheetPageUrl = 'peek://sheets/sheet.html';

/**
 * Get all sheet configs (migrating legacy per-sheet configs on first read)
 */
const listSheets = async () => {
  const sheetsMap = await loadSheetsMap(api);
  return Object.entries(sheetsMap).map(([key, value]) => ({ key, ...value }));
};

/**
 * Create a new sheet config
 */
const createSheet = async (name) => {
  const sheetId = crypto.randomUUID().slice(0, 8);
  const key = sheetKey(sheetId);
  const config = {
    version: 1,
    name: name || 'Untitled Sheet',
    createdAt: Date.now(),
    items: []
  };

  // Load existing sheets, add new one, save back
  const sheetsMap = await loadSheetsMap(api);
  sheetsMap[key] = { ...config, legacyMerged: true };
  const result = await api.settings.set(SHEETS_KEY, sheetsMap);
  if (result && result.error) {
    console.error('[ext:sheets] Failed to save sheet:', result.error);
  }
  return { sheetId, key, config };
};

/**
 * Open a sheet window
 */
const openSheet = async (sheetId, name) => {
  const url = `${sheetPageUrl}?sheetId=${sheetId}`;
  const config = await loadSheet(api, sheetId);
  const params = {
    key: url,
    // Transparency can only be set at creation, so this window carries it
    // whether or not the see-through switch is on yet.
    transparent: true,
    trackingSource: 'sheets',
    trackingSourceId: sheetId,
    ...windowParamsForSheet(config)
  };

  api.window.open(url, params)
    .catch(error => {
      console.error('[ext:sheets] Failed to open sheet:', error);
    });
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'sheets',
    description: 'List all widget sheets',
    execute: async (ctx) => {
      const sheets = await listSheets();
      if (sheets.length === 0) {
        return { success: true, message: 'No sheets found' };
      }

      // Return sheet names as results for the cmd palette to display
      return {
        success: true,
        results: sheets.map(s => ({
          name: s.name,
          description: `Created ${new Date(s.createdAt).toLocaleDateString()}`,
          execute: () => {
            const sheetId = s.key.replace('sheet:', '');
            openSheet(sheetId, s.name);
          }
        }))
      };
    }
  },
  {
    name: 'new sheet',
    description: 'Create a new widget sheet',
    execute: async (ctx) => {
      const name = ctx?.args || 'Untitled Sheet';
      const { sheetId } = await createSheet(name);
      openSheet(sheetId, name);
    }
  },
  {
    name: 'open sheet',
    description: 'Open an existing widget sheet by name',
    execute: async (ctx) => {
      const sheets = await listSheets();
      if (sheets.length === 0) {
        return { success: true, message: 'No sheets found' };
      }

      const query = (ctx?.args || '').toLowerCase();

      // If a name was provided, try to match it
      if (query) {
        const match = sheets.find(s => s.name.toLowerCase() === query) ||
                      sheets.find(s => s.name.toLowerCase().includes(query));
        if (match) {
          const sheetId = match.key.replace('sheet:', '');
          openSheet(sheetId, match.name);
          return;
        }
      }

      // Return sheet list for selection
      return {
        success: true,
        results: sheets.map(s => ({
          name: s.name,
          description: `Created ${new Date(s.createdAt).toLocaleDateString()}`,
          execute: () => {
            const sheetId = s.key.replace('sheet:', '');
            openSheet(sheetId, s.name);
          }
        }))
      };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

const initCommands = async () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
};

// ===== Per-sheet keys =====

// Resolves once the saved sheets have been read and the key set declared.
// The wake publish that starts this tile lands before that, so the open
// handler waits on it rather than reading nothing.
let resolveSettingsLoaded;
const settingsLoaded = new Promise((resolve) => { resolveSettingsLoaded = resolve; });

let localHotkeys = [];

/**
 * Declare the global keys to main (replace-all, so a removed key goes away)
 * and register the in-app keys locally. Always declares, even an empty set,
 * so main records that this feature has declared and stops waking it at boot.
 */
const declareSheetShortcuts = async () => {
  const sheetsMap = await loadSheetsMap(api);
  const { wake, local, skipped } = buildSheetShortcuts(sheetsMap);
  for (const s of skipped) {
    console.warn(`[ext:sheets] key ${s.keys} for sheet ${s.sheetId} ignored: already used by sheet ${s.keptBy}`);
  }
  api.shortcuts.declareWakeShortcuts(wake);

  localHotkeys.forEach(keys => api.shortcuts.unregister(keys));
  localHotkeys = [];
  for (const { keys, sheetId } of local) {
    api.shortcuts.register(keys, () => { openSheetById(sheetId); });
    localHotkeys.push(keys);
  }
};

/** Open (or bring forward) a saved sheet by id. */
const openSheetById = async (sheetId) => {
  const config = await loadSheet(api, sheetId);
  if (!config) {
    console.warn('[ext:sheets] no sheet with id', sheetId);
    return;
  }
  openSheet(sheetId, config.name);
};

const init = async () => {
  // Subscribe before any await: the publish that woke this tile is delivered
  // as soon as the tile is ready.
  api.pubsub.subscribe(SHEET_OPEN_TOPIC, async (msg) => {
    await settingsLoaded;
    const sheetId = String(msg?.args?.[0] ?? '');
    if (sheetId) openSheetById(sheetId);
  });
  api.pubsub.subscribe(SHEETS_CHANGED_TOPIC, async () => {
    await settingsLoaded;
    declareSheetShortcuts();
  });

  initCommands();

  try {
    await declareSheetShortcuts();
  } finally {
    resolveSettingsLoaded();
  }
};

const uninit = () => {
  localHotkeys.forEach(keys => api.shortcuts.unregister(keys));
  localHotkeys = [];
  uninitCommands();
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
