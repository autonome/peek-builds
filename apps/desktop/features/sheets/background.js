/**
 * Sheets Extension Background Script
 *
 * Widget sheets with freeform card layouts hosting webviews.
 *
 * Runs in isolated extension process (peek://sheets/background.html)
 */

import { cardViewWindowParams } from 'peek://app/lib/card-view-params.js';
import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { windowParamsForSheet } from './sheet-options.js';
import { buildSheetShortcuts, SHEET_OPEN_TOPIC, SHEETS_CHANGED_TOPIC } from './sheet-hotkeys.js';
import { loadSheetsMap, loadSheet, createSheet as createSheetInStore } from './sheet-store.js';
import {
  argsFromCommandMessage, sheetNameOptions, findSheetByName, normalizeSheetName, sheetIdOfKey
} from './sheet-commands.js';

const api = window.app;

// Extension content is served from peek://sheets/ (hybrid mode)
const sheetPageUrl = 'peek://sheets/sheet.html';
const sheetsGridUrl = 'peek://sheets/home.html';

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
  const created = await createSheetInStore(api, normalizeSheetName(name));
  if (created.result && created.result.error) {
    console.error('[ext:sheets] Failed to save sheet:', created.result.error);
  }
  return created;
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

/** Open the card grid that lists every sheet. */
const openSheetsGrid = () => {
  api.window.open(sheetsGridUrl, cardViewWindowParams({ url: sheetsGridUrl, title: 'Sheets' })).catch(error => {
    console.error('[ext:sheets] Failed to open sheets grid:', error);
  });
};

/**
 * Open the sheet a command message names. With no name, open the grid so the
 * user can pick one. Command results must be plain data (they cross a process
 * boundary), so a pick comes back as a name, never as a function.
 */
const openSheetForCommand = async (msg, commandName) => {
  const sheets = await listSheets();
  const query = argsFromCommandMessage(msg, commandName);
  if (!query) {
    openSheetsGrid();
    return { success: true };
  }
  const match = findSheetByName(sheets, query);
  if (!match) {
    return { success: false, error: `No sheet named "${query}"` };
  }
  openSheet(sheetIdOfKey(match.key), match.name);
  return { success: true };
};

const SHEET_PICK_COMMANDS = [
  { name: 'sheets', description: 'List all widget sheets' },
  { name: 'list sheets', description: 'List all widget sheets' },
  { name: 'open sheet', description: 'Open an existing widget sheet by name' }
];

const commandDefinitions = [
  ...SHEET_PICK_COMMANDS.map(({ name, description }) => ({
    name,
    description,
    execute: (msg) => openSheetForCommand(msg, name)
  })),
  {
    name: 'new sheet',
    description: 'Create a new widget sheet, optionally named',
    execute: async (msg) => {
      const name = normalizeSheetName(argsFromCommandMessage(msg, 'new sheet'));
      const { sheetId } = await createSheet(name);
      openSheet(sheetId, name);
      // Refreshes the sheet name options and any open sheets grid.
      api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
      return { success: true };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

/**
 * Tell the command panel which sheet names to offer for the name argument.
 * Re-publishing a command's registration replaces the earlier one, so this
 * runs again whenever the set of sheets changes.
 */
const refreshNameCommands = async () => {
  try {
    const options = sheetNameOptions(await listSheets());
    for (const { name, description } of SHEET_PICK_COMMANDS) {
      api.pubsub.publish('cmd:register', {
        name,
        description,
        source: 'sheets',
        scope: 'global',
        params: [{
          name: 'name',
          type: 'enum',
          options,
          required: false,
          description: 'Sheet name'
        }]
      });
    }
  } catch (err) {
    console.error('[ext:sheets] Failed to publish sheet name options:', err);
  }
};

const initCommands = async () => {
  // Registration is asynchronous and publishes its own (parameter-less)
  // entry, so wait for it before publishing the name options over it.
  await Promise.all(commandDefinitions.map(cmd => {
    registeredCommands.push(cmd.name);
    return api.commands.register(cmd);
  }));
  await refreshNameCommands();
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
    refreshNameCommands();
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
