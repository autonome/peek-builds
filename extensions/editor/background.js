/**
 * Editor Extension - Markdown editor with sidebars
 *
 * Provides:
 * - Three-panel layout: outline | editor | preview
 * - CodeMirror-based markdown editing
 * - Optional vim mode
 * - Resizable panels
 * - Pubsub integration
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

// Feature detection
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/**
 * Open the editor window
 */
function openEditor(params) {
  if (hasPeekAPI) {
    let url = 'peek://ext/editor/home.html';
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += '?' + qs;
    }
    api.window.open(url, {
      role: 'workspace',
      key: 'editor-home',
      width: 800,
      height: 1000,
      title: 'Editor'
    });
  } else {
    window.open('./home.html', '_blank');
  }
}

const extension = {
  id: 'editor',
  labels: {
    name: 'Editor'
  },

  /**
   * Register commands - called when cmd extension is ready
   */
  registerCommands() {
    registerNoun({
      name: 'editor',
      singular: 'editor',
      description: 'Markdown editor',
      skipBare: true, // No bare "editor" command
      browse: async () => { openEditor(); },
    });

    console.log('[editor] Commands registered');
  },

  init() {
    console.log('[editor] init - Peek API available:', hasPeekAPI);

    if (!hasPeekAPI) {
      console.log('[editor] Running without Peek API - limited functionality');
      return;
    }

    // Register commands (cmd loads first with its subscribers ready via 100ms head start)
    this.registerCommands();

    // Register global shortcut Option+E (works when Peek is not focused)
    api.shortcuts.register('Option+e', () => openEditor(), { global: true });

    // Register local shortcut Cmd+E (works when a Peek window is focused)
    api.shortcuts.register('CommandOrControl+E', () => openEditor());

    // Subscribe to editor:open — open editor with optional content or itemId
    api.subscribe('editor:open', (msg) => {
      const params = {};
      if (msg?.content) {
        params.content = msg.content;
      }
      if (msg?.file) {
        params.file = msg.file;
      }
      if (msg?.itemId) {
        params.itemId = msg.itemId;
      }
      openEditor(Object.keys(params).length > 0 ? params : undefined);
    }, api.scopes.GLOBAL);

    // Subscribe to editor:add — open a new blank editor document
    api.subscribe('editor:add', (msg) => {
      console.log('[editor] editor:add received:', msg);
      openEditor(); // No params = blank document
    }, api.scopes.GLOBAL);

    console.log('[editor] Extension loaded');
  },

  uninit() {
    console.log('[editor] Cleaning up...');

    if (hasPeekAPI) {
      unregisterNoun('editor');
      api.shortcuts.unregister('Option+e', { global: true });
      api.shortcuts.unregister('CommandOrControl+E');
    }
  }
};

export default extension;
