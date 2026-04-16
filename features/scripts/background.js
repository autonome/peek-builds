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
import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;

// ===== BroadcastChannel for intra-extension messaging =====
// Falls back to IPC pubsub if BroadcastChannel is unavailable (e.g., custom protocol origins)

let scriptsChannel = null;
const scriptsChannelHandlers = {};

try {
  scriptsChannel = new BroadcastChannel('scripts');
  scriptsChannel.onmessage = (e) => {
    const { topic, data } = e.data;
    if (scriptsChannelHandlers[topic]) {
      for (const handler of scriptsChannelHandlers[topic]) {
        handler(data);
      }
    }
  };
} catch (err) {
  console.warn('[scripts] BroadcastChannel unavailable, using IPC fallback:', err.message);
}

function onChannel(topic, handler) {
  if (!scriptsChannelHandlers[topic]) scriptsChannelHandlers[topic] = [];
  scriptsChannelHandlers[topic].push(handler);
  if (!scriptsChannel) api.pubsub.subscribe(topic, handler, api.scopes.GLOBAL);
}

function emitChannel(topic, data) {
  if (scriptsChannel) {
    scriptsChannel.postMessage({ topic, data });
  } else {
    api.pubsub.publish(topic, data, api.scopes.GLOBAL);
  }
}

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
  let url = 'peek://scripts/manager.html';
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

  // Notify listeners via BroadcastChannel
  emitChannel('scripts:created', { script });

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

  // Notify listeners via BroadcastChannel
  emitChannel('scripts:updated', { scriptId, script: currentSettings.scripts[scriptIndex] });

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

  // Notify listeners via BroadcastChannel
  emitChannel('scripts:deleted', { scriptId });

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
    api.pubsub.publish('scripts:executed', {
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
 * Register commands via noun API
 */
const registerCommands = () => {
  registerNoun({
    name: 'scripts',
    singular: 'script',
    description: 'Userscripts and content scripts',

    query: async ({ search }) => {
      const result = await getScripts();
      if (!result.success) return { success: false };
      let scripts = result.data;
      if (search) {
        const s = search.toLowerCase();
        scripts = scripts.filter(sc => sc.name.toLowerCase().includes(s));
      }
      if (scripts.length === 0) {
        return { output: 'No scripts found.', mimeType: 'text/plain' };
      }
      return {
        success: true,
        output: {
          data: scripts.map(sc => ({
            id: sc.id,
            name: sc.name,
            description: sc.description,
            enabled: sc.enabled,
            matchPatterns: sc.matchPatterns
          })),
          mimeType: 'application/json',
          title: `Scripts (${scripts.length})`
        }
      };
    },

    browse: async () => { openScriptsManager(); },

    open: async (ctx) => {
      if (ctx.search) {
        const result = await getScripts();
        if (result.success) {
          const match = result.data.find(s => s.name.toLowerCase().includes(ctx.search.toLowerCase()));
          if (match) {
            openScriptsManager({ scriptId: match.id });
            return;
          }
        }
      }
      openScriptsManager();
    },

    create: async ({ search }) => {
      const result = await createScript({ name: search || undefined });
      if (result.success) {
        openScriptsManager({ scriptId: result.data.id });
      }
      return result;
    },

    produces: 'application/json'
  });

};

/**
 * Initialize the extension
 */
const init = async () => {
  // Load scripts from datastore
  currentSettings = await loadSettings();

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  registerCommands();

  // Register global shortcut Command+Shift+S
  api.shortcuts.register('Command+Shift+S', () => openScriptsManager());

  // API for manager UI via BroadcastChannel
  onChannel('scripts:create', async (msg) => {
    const result = await createScript(msg);
    emitChannel('scripts:create:response', result);
  });

  onChannel('scripts:update', async (msg) => {
    const result = await updateScript(msg.scriptId, msg.updates);
    emitChannel('scripts:update:response', result);
  });

  onChannel('scripts:delete', async (msg) => {
    const result = await deleteScript(msg.scriptId);
    emitChannel('scripts:delete:response', result);
  });

  onChannel('scripts:get-all', async () => {
    const result = await getScripts();
    emitChannel('scripts:get-all:response', result);
  });

  onChannel('scripts:get', async (msg) => {
    const result = await getScript(msg.scriptId);
    emitChannel('scripts:get:response', result);
  });

  // Keep scripts:execute on IPC for cross-extension access
  api.pubsub.subscribe('scripts:execute', async (msg) => {
    const result = await executeScript(msg.scriptId, msg.context);
    api.pubsub.publish('scripts:execute:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

};

/**
 * Cleanup
 */
const uninit = () => {
  unregisterNoun('scripts');
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
