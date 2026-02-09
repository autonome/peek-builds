/**
 * Scripts Extension Background Script
 *
 * Manages userscripts/content scripts system
 *
 * Features:
 * - Script storage and management
 * - Pattern matching and execution
 * - Scripts manager UI
 * - Command registration
 *
 * Runs in isolated extension process (peek://ext/scripts/background.html)
 */

import { scriptExecutor } from './script-executor.js';

const api = window.app;

console.log('[ext:scripts] background loaded');

// Default settings
const defaults = {
  scripts: []
};

// In-memory cache of scripts
let currentSettings = { scripts: [] };

/**
 * Load scripts from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    return {
      scripts: result.data.scripts || defaults.scripts
    };
  }
  return defaults;
};

/**
 * Save scripts to datastore
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set(settings);
  if (!result.success) {
    console.error('[ext:scripts] Failed to save settings:', result.error);
  }
  return result;
};

/**
 * Generate unique ID for script
 */
const generateId = () => {
  return `script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Open scripts manager UI
 */
const openScriptsManager = (params = {}) => {
  console.log('[ext:scripts] Opening scripts manager', params);

  let url = 'peek://ext/scripts/manager.html';
  if (params.scriptId) {
    url += `?scriptId=${params.scriptId}`;
  }

  api.window.open(url, {
    key: 'scripts-manager',
    width: 1200,
    height: 800,
    title: 'Scripts Manager'
  });
};

/**
 * Create a new script
 */
const createScript = async (scriptData) => {
  const script = {
    id: generateId(),
    name: scriptData.name || 'Untitled Script',
    description: scriptData.description || '',
    code: scriptData.code || '// Your script here\nreturn { success: true };',
    matchPatterns: scriptData.matchPatterns || ['*://*/*'],
    excludePatterns: scriptData.excludePatterns || [],
    runAt: scriptData.runAt || 'document-end',
    enabled: scriptData.enabled !== undefined ? scriptData.enabled : true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastExecutedAt: null
  };

  currentSettings.scripts.push(script);
  await saveSettings(currentSettings);

  // Notify listeners
  api.publish('scripts:created', { script }, api.scopes.GLOBAL);

  return { success: true, data: script };
};

/**
 * Update an existing script
 */
const updateScript = async (scriptId, updates) => {
  const scriptIndex = currentSettings.scripts.findIndex(s => s.id === scriptId);
  if (scriptIndex === -1) {
    return { success: false, error: 'Script not found' };
  }

  currentSettings.scripts[scriptIndex] = {
    ...currentSettings.scripts[scriptIndex],
    ...updates,
    updatedAt: Date.now()
  };

  await saveSettings(currentSettings);

  // Notify listeners
  api.publish('scripts:updated', { scriptId, script: currentSettings.scripts[scriptIndex] }, api.scopes.GLOBAL);

  return { success: true, data: currentSettings.scripts[scriptIndex] };
};

/**
 * Delete a script
 */
const deleteScript = async (scriptId) => {
  const scriptIndex = currentSettings.scripts.findIndex(s => s.id === scriptId);
  if (scriptIndex === -1) {
    return { success: false, error: 'Script not found' };
  }

  currentSettings.scripts.splice(scriptIndex, 1);
  await saveSettings(currentSettings);

  // Notify listeners
  api.publish('scripts:deleted', { scriptId }, api.scopes.GLOBAL);

  return { success: true };
};

/**
 * Execute a script against a URL
 */
const executeScript = async (scriptId, executionContext) => {
  const script = currentSettings.scripts.find(s => s.id === scriptId);
  if (!script) {
    return { success: false, error: 'Script not found' };
  }

  if (!script.enabled) {
    return { success: false, error: 'Script is disabled' };
  }

  try {
    const result = await scriptExecutor.executeScript(script, executionContext);

    // Update last executed time
    await updateScript(scriptId, { lastExecutedAt: Date.now() });

    // Publish execution result
    api.publish('scripts:executed', {
      scriptId,
      result,
      url: executionContext.url
    }, api.scopes.GLOBAL);

    return { success: true, data: result };
  } catch (error) {
    console.error('[ext:scripts] Execution error:', error);
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
};

/**
 * Get all scripts
 */
const getScripts = async () => {
  return { success: true, data: currentSettings.scripts };
};

/**
 * Get a single script
 */
const getScript = async (scriptId) => {
  const script = currentSettings.scripts.find(s => s.id === scriptId);
  if (!script) {
    return { success: false, error: 'Script not found' };
  }
  return { success: true, data: script };
};

/**
 * Register commands - called when cmd extension is ready
 */
const registerCommands = () => {
  api.commands.register({
    name: 'scripts',
    description: 'Open scripts manager',
    execute: () => openScriptsManager()
  });

  api.commands.register({
    name: 'scripts: new',
    description: 'Create a new script',
    execute: async () => {
      const result = await createScript({});
      if (result.success) {
        openScriptsManager({ scriptId: result.data.id });
      }
    }
  });

  console.log('[ext:scripts] Commands registered');
};

/**
 * Initialize the extension
 */
const init = async () => {
  console.log('[ext:scripts] init');

  // Load scripts from datastore
  currentSettings = await loadSettings();
  console.log('[ext:scripts] Loaded', currentSettings.scripts.length, 'scripts');

  // Wait for cmd:ready before registering commands
  api.subscribe('cmd:ready', () => {
    registerCommands();
  }, api.scopes.GLOBAL);

  // Query in case cmd is already ready
  api.publish('cmd:query', {}, api.scopes.GLOBAL);

  // Register global shortcut Command+Shift+S
  api.shortcuts.register('Command+Shift+S', () => openScriptsManager());

  // API for other extensions/pages to interact with scripts
  api.subscribe('scripts:create', async (msg) => {
    const result = await createScript(msg);
    api.publish('scripts:create:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('scripts:update', async (msg) => {
    const result = await updateScript(msg.scriptId, msg.updates);
    api.publish('scripts:update:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('scripts:delete', async (msg) => {
    const result = await deleteScript(msg.scriptId);
    api.publish('scripts:delete:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('scripts:execute', async (msg) => {
    const result = await executeScript(msg.scriptId, msg.context);
    api.publish('scripts:execute:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('scripts:get-all', async () => {
    const result = await getScripts();
    api.publish('scripts:get-all:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('scripts:get', async (msg) => {
    const result = await getScript(msg.scriptId);
    api.publish('scripts:get:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  console.log('[ext:scripts] Extension loaded');
};

/**
 * Cleanup
 */
const uninit = () => {
  console.log('[ext:scripts] Cleaning up...');
  api.commands.unregister('scripts');
  api.commands.unregister('scripts: new');
  api.shortcuts.unregister('Command+Shift+S');
};

export default {
  id: 'scripts',
  labels: {
    name: 'Scripts'
  },
  init,
  uninit
};
