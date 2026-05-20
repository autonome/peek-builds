/**
 * Sheets Extension Background Script
 *
 * Widget sheets with freeform card layouts hosting webviews.
 *
 * Runs in isolated extension process (peek://sheets/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

// Extension content is served from peek://sheets/ (hybrid mode)
const sheetPageUrl = 'peek://sheets/sheet.html';

/**
 * Get all sheet configs from feature_settings
 */
const listSheets = async () => {
  const result = await api.settings.get('sheets');
  if (!result.success || !result.data) return [];

  const sheetsMap = result.data;
  return Object.entries(sheetsMap).map(([key, value]) => ({ key, ...value }));
};

/**
 * Create a new sheet config
 */
const createSheet = async (name) => {
  const sheetId = crypto.randomUUID().slice(0, 8);
  const key = `sheet:${sheetId}`;
  const config = {
    version: 1,
    name: name || 'Untitled Sheet',
    createdAt: Date.now(),
    items: []
  };

  // Load existing sheets, add new one, save back
  const existing = await api.settings.get('sheets');
  const sheetsMap = (existing.success && existing.data) || {};
  sheetsMap[key] = config;
  const result = await api.settings.set('sheets', sheetsMap);
  if (result && result.error) {
    console.error('[ext:sheets] Failed to save sheet:', result.error);
  }
  return { sheetId, key, config };
};

/**
 * Open a sheet window
 */
const openSheet = (sheetId, name) => {
  const url = `${sheetPageUrl}?sheetId=${sheetId}`;
  const params = {
    key: url,
    trackingSource: 'sheets',
    trackingSourceId: sheetId
  };

  api.window.open(url, params)
    .then(win => {
      debug && console.log('[ext:sheets] Sheet opened:', sheetId, name);
    })
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

const init = async () => {
  initCommands();
};

const uninit = () => {
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
