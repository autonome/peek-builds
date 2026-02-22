/**
 * Editor Extension - Markdown editor with sidebars
 *
 * Provides:
 * - Three-panel layout: outline | editor | preview
 * - CodeMirror-based markdown editing
 * - Optional vim mode
 * - Resizable panels
 * - Pubsub integration
 *
 * Commands and shortcuts are declared in manifest.json.
 * This extension loads lazily on first command invocation.
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

    // Use item-specific key so each item gets its own window.
    // If editing the same item again, the existing window is reused and focused.
    // Blank editors (no itemId) get a unique key so multiple can coexist.
    const key = params?.itemId
      ? `editor-${params.itemId}`
      : `editor-${Date.now()}`;

    api.window.open(url, {
      role: 'workspace',
      key,
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

  init() {
    if (!hasPeekAPI) return;

    // Register "editor" command handler — manifest declares the command,
    // lazy stub registers metadata, this sets up the execute handler
    api.commands.register({
      name: 'editor',
      description: 'Open markdown editor',
      execute: () => openEditor()
    });

    // Register noun for browse/list commands (not in manifest)
    registerNoun({
      name: 'editor',
      singular: 'editor',
      description: 'Markdown editor',
      skipBare: true,
      browse: async () => { openEditor(); },
    });

    // Shortcuts declared in manifest.json — no imperative registration needed

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
    api.subscribe('editor:add', () => {
      openEditor();
    }, api.scopes.GLOBAL);
  },

  uninit() {
    if (hasPeekAPI) {
      unregisterNoun('editor');
      // Shortcuts are managed by manifest — no imperative unregister needed
    }
  }
};

export default extension;
