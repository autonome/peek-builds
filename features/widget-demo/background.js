/**
 * Widget Demo Extension Background Script
 *
 * Demonstration/playground extension showcasing widget sheet capabilities.
 * Creates a default demo sheet with clock, bookmarks, notes, counter, and
 * color theme widgets on first run.
 *
 * Runs in isolated extension process (peek://ext/widget-demo/background.html)
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:widget-demo] background init');

const DEMO_SHEET_KEY = 'demo_sheet';

// Widget definitions with default layout
const DEMO_WIDGETS = [
  { id: 'clock',     url: 'peek://ext/widget-demo/widgets/clock.html',     width: 200, height: 160 },
  { id: 'counter',   url: 'peek://ext/widget-demo/widgets/counter.html',   width: 200, height: 160 },
  { id: 'note',      url: 'peek://ext/widget-demo/widgets/note.html',      width: 280, height: 220 },
  { id: 'bookmarks', url: 'peek://ext/widget-demo/widgets/bookmarks.html', width: 280, height: 220 },
  { id: 'theme',     url: 'peek://ext/widget-demo/widgets/theme.html',     width: 280, height: 200 },
];

/**
 * Build the default demo sheet config.
 * Arranges widgets in a 2-column grid layout.
 */
const buildDefaultSheetConfig = () => {
  const COL_GAP = 16;
  const ROW_GAP = 16;
  const MARGIN = 16;

  // Layout: two columns
  // Col 1: clock, counter (stacked)
  // Col 2: note, bookmarks (stacked)
  // Full width below: theme
  const items = [
    // Column 1
    { ...DEMO_WIDGETS[0], x: MARGIN, y: MARGIN },
    { ...DEMO_WIDGETS[1], x: MARGIN, y: MARGIN + 160 + ROW_GAP },
    // Column 2
    { ...DEMO_WIDGETS[2], x: MARGIN + 200 + COL_GAP, y: MARGIN },
    { ...DEMO_WIDGETS[3], x: MARGIN + 200 + COL_GAP, y: MARGIN + 220 + ROW_GAP },
    // Bottom row
    { ...DEMO_WIDGETS[4], x: MARGIN, y: MARGIN + 220 + ROW_GAP + 220 + ROW_GAP },
  ];

  return {
    version: 1,
    name: 'Widget Demo',
    createdAt: Date.now(),
    items
  };
};

/**
 * Ensure the demo sheet config exists in feature_settings.
 * Creates a default config if none exists.
 */
const ensureSheetConfig = async () => {
  const result = await api.settings.get(DEMO_SHEET_KEY);
  if (!result.error && result.value) {
    debug && console.log('[ext:widget-demo] Demo sheet config already exists');
    return result.value;
  }

  // Create default config
  const config = buildDefaultSheetConfig();
  await api.settings.set(DEMO_SHEET_KEY, config);
  console.log('[ext:widget-demo] Created default demo sheet config with', config.items.length, 'widgets');
  return config;
};

// ===== Command definitions =====

const SHEET_URL = 'peek://ext/widget-demo/sheet.html';

const openDemoSheet = async () => {
  await ensureSheetConfig();
  api.window.open(SHEET_URL, {
    key: SHEET_URL,
    trackingSource: 'widget-demo'
  });
};

const commandDefinitions = [
  {
    name: 'widget demo',
    description: 'Open the widget demo sheet',
    execute: async (ctx) => {
      console.log('[ext:widget-demo] Opening demo sheet');
      await openDemoSheet();
      return { output: 'Opening widget demo sheet', mimeType: 'text/plain' };
    }
  },
  {
    name: 'demo widgets',
    description: 'Open the widget demo sheet (alias)',
    execute: async (ctx) => {
      console.log('[ext:widget-demo] Opening demo sheet (alias)');
      await openDemoSheet();
      return { output: 'Opening widget demo sheet', mimeType: 'text/plain' };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

const initCommands = () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:widget-demo] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:widget-demo] Unregistered commands');
};

const init = async () => {
  console.log('[ext:widget-demo] init');

  // Ensure demo sheet config exists (create default if needed)
  await ensureSheetConfig();

  // Register commands
  initCommands();

  console.log('[ext:widget-demo] Initialized');
};

const uninit = () => {
  console.log('[ext:widget-demo] uninit');
  uninitCommands();
};

export default {
  id: 'widget-demo',
  labels: {
    name: 'Widget Demo'
  },
  init,
  uninit
};
