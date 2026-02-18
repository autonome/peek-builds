/**
 * Sheets Extension Background Script
 *
 * Widget sheets with freeform card layouts hosting webviews.
 *
 * Runs in isolated extension process (peek://ext/sheets/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:sheets] background', labels.name);

// Extension content is served from peek://sheets/ (hybrid mode)
const sheetPageUrl = 'peek://sheets/sheet.html';

/**
 * Get all sheet configs from extension_settings
 */
const listSheets = async () => {
  const result = await api.settings.get();
  if (!result.success || !result.data) return [];

  const sheets = [];
  for (const [key, value] of Object.entries(result.data)) {
    if (key.startsWith('sheet:')) {
      sheets.push({ key, ...value });
    }
  }
  return sheets;
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

  await api.settings.setKey(key, config);
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
        console.log('[ext:sheets] No sheets found');
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
      console.log('[ext:sheets] Creating new sheet:', name);
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
        console.log('[ext:sheets] No sheets to open');
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
  console.log('[ext:sheets] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:sheets] Unregistered commands');
};

const init = async () => {
  console.log('[ext:sheets] init');
  initCommands();
};

const uninit = () => {
  console.log('[ext:sheets] uninit');
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
