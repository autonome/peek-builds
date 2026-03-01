/**
 * Editor Home - Pure markdown editor with three-panel layout.
 *
 * Features:
 * - Outline sidebar (TOC from headers)
 * - CodeMirror editor with vim mode support
 * - Preview sidebar (live markdown rendering)
 * - Resizable panels
 * - Focus mode
 * - Autosave for datastore items
 */

import { EditorLayout } from './editor-layout.js';
import { getCM, Vim, onVimSetOption } from './codemirror.js';

const api = window.app;
const debug = api?.debug;

// Editor layout instance
let editorLayout = null;

// Settings storage key (matches how Settings app stores under 'prefs' key)
const PREFS_STORAGE_KEY = 'prefs';

// Autosave state
let currentItemId = null;
let currentFilePath = null; // Tracks the open file on disk
let saveStatus = 'saved'; // 'saved' | 'saving' | 'unsaved'
let saveTimer = null;
let deferredNewNote = false; // True when editor opened blank — item creation deferred until content exists
const AUTOSAVE_DELAY_MS = 1500; // 1.5 seconds after typing stops

/**
 * Sample markdown content for testing folding features.
 * Tests: headers (6 levels), nested lists, code blocks.
 */
const SAMPLE_CONTENT = `# Level 1 Header - Main Document

This content is under a level 1 header.

## Level 2 - Features

Content under level 2.

### Level 3 - Folding Types

We support multiple folding types.

#### Level 4 - Header Folding

Headers fold everything until the next header of same or higher level.

##### Level 5 - Deep Nesting

This is deeply nested content.

###### Level 6 - Maximum Depth

This is the deepest header level supported.

Back to level 5 content.

##### Level 5 - Another Section

Another level 5 section.

#### Level 4 - List Folding

Lists with children are foldable:

- Parent item with children
  - Child item one
  - Child item two
    - Grandchild item
    - Another grandchild
  - Child item three
- Simple item (no children)
- Another parent
  - Single child

Numbered lists also fold:

1. First parent
   1. Sub-item one
   2. Sub-item two
2. Second parent
   - Mixed child
   - Another mixed

#### Level 4 - Code Block Folding

Top-level code blocks fold their contents:

\`\`\`javascript
function example() {
    if (condition) {
        doSomething();
    }
    return result;
}

class MyClass {
    constructor() {
        this.x = 1;
    }

    method() {
        return this.x;
    }
}
\`\`\`

### Level 3 - Vim Fold Commands

Test these vim commands (enable vim mode first):

| Command | Action |
|---------|--------|
| \`za\` | Toggle fold under cursor |
| \`zo\` | Open fold under cursor |
| \`zc\` | Close fold under cursor |
| \`zR\` | Open all folds |
| \`zM\` | Close all folds |
| \`zr\` | Reduce folding (open one level) |
| \`zm\` | More folding (close one level) |

## Level 2 - Another Top Section

This tests that level 2 properly ends the previous level 2 section.

### Level 3 - Final Nested

Final nested content.

## Level 2 - Conclusion

End of test document.
`;

/**
 * Initialize the editor
 */
const init = async () => {
  debug && console.log('[editor] Home init');

  const rootEl = document.getElementById('editor-root');
  if (!rootEl) {
    console.error('[editor] Root element not found');
    return;
  }

  // Load vim mode preference from extension settings API (Settings app stores under 'prefs' key)
  let vimMode = false;
  let vimSettings = null; // persisted vim :set settings (wrap, lineNumbers)
  try {
    if (api?.settings?.getKey) {
      const result = await api.settings.getKey(PREFS_STORAGE_KEY);
      if (result.success && result.data && typeof result.data === 'object') {
        vimMode = !!result.data.vimMode;
        debug && console.log('[editor] Loaded vimMode from prefs:', vimMode);

        // Load persisted vim :set settings
        if (result.data.vimSettings && typeof result.data.vimSettings === 'object') {
          vimSettings = result.data.vimSettings;
          debug && console.log('[editor] Loaded vimSettings from prefs:', vimSettings);
        }
      } else {
        debug && console.log('[editor] No prefs found in datastore, using default vimMode:', vimMode);
      }
    }
  } catch (err) {
    debug && console.log('[editor] Failed to load settings:', err);
  }

  // Check URL params for content, file path, or itemId
  const params = new URLSearchParams(window.location.search);
  const contentParam = params.get('content');
  const fileParam = params.get('file');
  const itemIdParam = params.get('itemId');

  let initialContent = '';
  let hasExplicitSource = false;

  // If content provided via URL param, use it
  if (contentParam) {
    initialContent = contentParam;
    hasExplicitSource = true;
  }

  // If file path provided, try to load it
  if (fileParam && api?.files?.readFromPath) {
    try {
      const result = await api.files.readFromPath(fileParam);
      if (result.success && result.data) {
        initialContent = result.data.content;
        currentFilePath = result.data.path;
        hasExplicitSource = true;
        debug && console.log('[editor] Loaded file from path:', currentFilePath);
      }
    } catch (err) {
      debug && console.log('[editor] Failed to load file:', err);
    }
  }

  // If itemId provided, load from datastore
  if (itemIdParam && api?.datastore?.getItem) {
    try {
      const result = await api.datastore.getItem(itemIdParam);
      if (result.success && result.data) {
        initialContent = result.data.content || '';
        currentItemId = itemIdParam;
        hasExplicitSource = true;
        debug && console.log('[editor] Loaded item from datastore:', itemIdParam);

        // Set context to editor mode
        if (api?.context?.setMode) {
          api.context.setMode('editor', { metadata: { itemId: itemIdParam } });
        }
      } else {
        console.error('[editor] Failed to load item:', result.error);
      }
    } catch (err) {
      console.error('[editor] Failed to load item:', err);
    }
  }

  // No explicit source — defer item creation until user actually types content.
  // This prevents empty junk items from being saved to the datastore.
  if (!hasExplicitSource && !currentItemId) {
    deferredNewNote = true;
    debug && console.log('[editor] New blank note — item creation deferred until content is typed');
  }

  // Create editor layout
  editorLayout = new EditorLayout({
    container: rootEl,
    initialContent,
    vimMode,
    vimSettings,
    onContentChange: handleContentChange,
  });

  // Show save status indicator and filename if editing a datastore item or file
  if (currentItemId || currentFilePath) {
    editorLayout.setSaveStatusVisible(true);
  }
  if (currentFilePath) {
    updateWindowTitle();
  }

  // Set up Cmd+O (open file) and Cmd+S (save file) keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd+O: Open file
    if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !e.shiftKey) {
      e.preventDefault();
      openFile();
    }
    // Cmd+S: Save file
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      const content = editorLayout.getContent();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (currentFilePath || currentItemId) {
        performAutosave(content);
      } else {
        saveToFile(content);
      }
    }
  });

  // Persist vim :set option changes (wrap, number) to settings
  onVimSetOption(async (optionName, value) => {
    debug && console.log(`[editor] Vim :set ${optionName}=${value}, persisting`);
    try {
      if (api?.settings?.getKey && api?.settings?.setKey) {
        const result = await api.settings.getKey(PREFS_STORAGE_KEY);
        const prefs = (result.success && result.data && typeof result.data === 'object')
          ? { ...result.data }
          : {};

        // Map vim option names to our settings keys
        const settingsKey = optionName === 'number' ? 'lineNumbers' : optionName;
        if (!prefs.vimSettings || typeof prefs.vimSettings !== 'object') {
          prefs.vimSettings = {};
        }
        prefs.vimSettings[settingsKey] = value;

        await api.settings.setKey(PREFS_STORAGE_KEY, prefs);
        debug && console.log('[editor] Persisted vimSettings:', prefs.vimSettings);
      }
    } catch (err) {
      debug && console.log('[editor] Failed to persist vim setting:', err);
    }
  });

  // Register vim ex-commands for :w, :wq, :e
  Vim.defineEx('write', 'w', () => {
    const content = editorLayout.getContent();
    // Cancel any pending autosave — we're saving now
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (currentFilePath || currentItemId) {
      performAutosave(content);
    } else {
      // No file or item — trigger save-as
      saveToFile(content);
    }
    debug && console.log('[editor:vim] :w — saved');
  });

  Vim.defineEx('quit', 'q', () => {
    if (api?.window?.close) {
      api.window.close();
    } else {
      window.close();
    }
    debug && console.log('[editor:vim] :q — closing window');
  });

  Vim.defineEx('wq', 'wq', async () => {
    const content = editorLayout.getContent();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (currentFilePath || currentItemId) {
      await performAutosave(content);
    } else {
      await saveToFile(content);
    }
    debug && console.log('[editor:vim] :wq — saved');
    // Close the editor window
    if (api?.window?.close) {
      api.window.close();
    } else {
      window.close();
    }
    debug && console.log('[editor:vim] :wq — closing window');
  });

  // :e — open a file
  Vim.defineEx('edit', 'e', () => {
    openFile();
    debug && console.log('[editor:vim] :e — opening file');
  });

  // Set up escape handler
  //
  // ESC cascade (preload intercepts ESC via before-input-event, DOM keydown never fires):
  //   1. Annotation textarea focused -> blur to save+close
  //   2. Vim insert/visual mode -> exit to vim normal mode
  //   3. Vim normal mode (or non-vim) + focus mode -> exit focus mode
  //   4. Otherwise -> not handled (backend decides: close window, etc.)
  if (api?.escape) {
    api.escape.onEscape(() => {
      // Check if an annotation textarea is focused. The preload intercepts
      // ESC via before-input-event, so the textarea's own keydown handler
      // never fires. We blur it here to trigger the save+close logic.
      const focused = document.activeElement;
      if (focused?.tagName === 'TEXTAREA' && focused.classList.contains('annotation-textarea')) {
        debug && console.log('[editor:esc] Annotation textarea focused, blurring to save+close');
        focused.blur();
        return { handled: true };
      }

      // If vim mode is enabled, check if vim is in insert/visual mode.
      // The preload intercepts ESC via before-input-event and calls
      // e.preventDefault(), so the DOM keydown never reaches CodeMirror.
      // We must programmatically send <Esc> to vim here.
      if (editorLayout?.vimMode && editorLayout?.cmEditor) {
        try {
          const cm = getCM(editorLayout.cmEditor);
          if (cm && cm.state && cm.state.vim) {
            const vimState = cm.state.vim;
            if (vimState.insertMode || vimState.visualMode) {
              debug && console.log('[editor:esc] Vim in insert/visual mode, sending <Esc> to vim');
              Vim.handleKey(cm, '<Esc>');
              return { handled: true };
            }
            // In normal mode, fall through to focus mode check / close
            debug && console.log('[editor:esc] Vim in normal mode, checking focus mode');
          }
        } catch (e) {
          debug && console.log('[editor:esc] Could not check vim state:', e);
        }
      }

      if (editorLayout?.isInFocusMode()) {
        editorLayout.exitFocusMode();
        return { handled: true };
      }
      return { handled: false };
    });
  }

  // Listen for settings changes from Settings app to live-reload vim mode and vim settings
  if (api?.subscribe) {
    api.subscribe('editor:settings-changed', async () => {
      debug && console.log('[editor] Settings changed, reloading vim mode and vim settings');
      try {
        if (api?.settings?.getKey) {
          const result = await api.settings.getKey(PREFS_STORAGE_KEY);
          if (result.success && result.data && typeof result.data === 'object') {
            const newVimMode = !!result.data.vimMode;
            if (editorLayout) {
              editorLayout.setVimMode(newVimMode);
            }
            debug && console.log('[editor] Updated vimMode from settings:', newVimMode);

            // Apply vim settings if changed
            if (result.data.vimSettings && editorLayout) {
              editorLayout.applyVimSettings(result.data.vimSettings);
              debug && console.log('[editor] Updated vimSettings from settings:', result.data.vimSettings);
            }
          }
        }
      } catch (err) {
        debug && console.log('[editor] Failed to reload settings:', err);
      }
    }, api.scopes.GLOBAL);
  }

  debug && console.log('[editor] Editor initialized');
};

/**
 * Update save status indicator in the UI
 */
const updateSaveStatusUI = () => {
  const statusEl = document.getElementById('save-status');
  if (!statusEl) return;

  statusEl.className = `save-status save-status-${saveStatus}`;
  switch (saveStatus) {
    case 'saved':
      statusEl.textContent = 'Saved';
      break;
    case 'saving':
      statusEl.textContent = 'Saving...';
      break;
    case 'unsaved':
      statusEl.textContent = 'Unsaved';
      break;
  }
};

/**
 * Extract a title from the first line of content.
 * Strips leading markdown heading markers (e.g., "# Title" -> "Title").
 */
const extractTitleFromContent = (content) => {
  if (!content) return '';
  const firstLine = content.split('\n')[0].trim();
  // Strip leading markdown heading markers
  return firstLine.replace(/^#+\s*/, '');
};

/**
 * Extract filename from a full file path.
 */
const extractFilename = (filePath) => {
  if (!filePath) return '';
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
};

/**
 * Update the window title and filename display to show the current filename.
 */
const updateWindowTitle = () => {
  const filename = currentFilePath ? extractFilename(currentFilePath) : null;
  const title = filename || 'Editor';
  document.title = title;
  if (api?.window?.setTitle) {
    api.window.setTitle(title);
  }
  if (editorLayout) {
    editorLayout.setFilename(filename);
  }
};

/**
 * Open a file from disk via the native file picker.
 */
const openFile = async () => {
  if (!api?.files?.open) return;

  try {
    const result = await api.files.open();
    if (!result.success || result.canceled || !result.data) return;

    const { content, path: filePath, name, isText } = result.data;
    if (!isText || content === null) {
      debug && console.log('[editor] Cannot open non-text file:', name);
      return;
    }

    // Clear any pending autosave for previous content
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    // Switch to file mode (no datastore item)
    currentItemId = null;
    currentFilePath = filePath;

    // Load content into editor
    if (editorLayout) {
      editorLayout.setContent(content);
      editorLayout.setSaveStatusVisible(true);
    }

    saveStatus = 'saved';
    updateSaveStatusUI();
    updateWindowTitle();
    debug && console.log('[editor] Opened file:', filePath);
  } catch (err) {
    console.error('[editor] Failed to open file:', err);
  }
};

/**
 * Save content to the current file path, or show save-as dialog if no path.
 */
const saveToFile = async (content) => {
  if (!content && editorLayout) {
    content = editorLayout.getContent();
  }
  if (!content && content !== '') return;

  // If we have a file path, write directly
  if (currentFilePath && api?.files?.writeToPath) {
    saveStatus = 'saving';
    updateSaveStatusUI();

    try {
      const result = await api.files.writeToPath(currentFilePath, content);
      if (result.success) {
        saveStatus = 'saved';
        debug && console.log('[editor] Saved to file:', currentFilePath);
      } else {
        console.error('[editor] File save failed:', result.error);
        saveStatus = 'unsaved';
      }
    } catch (err) {
      console.error('[editor] File save error:', err);
      saveStatus = 'unsaved';
    }

    updateSaveStatusUI();
    return;
  }

  // No file path — show save-as dialog
  if (api?.files?.save) {
    saveStatus = 'saving';
    updateSaveStatusUI();

    try {
      const result = await api.files.save(content, { filename: 'untitled.md' });
      if (result.success && result.path) {
        currentFilePath = result.path;
        saveStatus = 'saved';
        updateWindowTitle();
        if (editorLayout) {
          editorLayout.setSaveStatusVisible(true);
        }
        debug && console.log('[editor] Saved as:', currentFilePath);
      } else if (result.canceled) {
        saveStatus = 'unsaved';
      } else {
        console.error('[editor] Save-as failed:', result.error);
        saveStatus = 'unsaved';
      }
    } catch (err) {
      console.error('[editor] Save-as error:', err);
      saveStatus = 'unsaved';
    }

    updateSaveStatusUI();
  }
};

/**
 * Perform autosave to datastore
 */
const performAutosave = async (content) => {
  // File-based autosave
  if (currentFilePath) {
    await saveToFile(content);
    return;
  }

  if (!currentItemId || !api?.datastore?.updateItem) {
    return;
  }

  saveStatus = 'saving';
  updateSaveStatusUI();

  try {
    // Extract title from first line and save alongside content
    const title = extractTitleFromContent(content);
    const result = await api.datastore.updateItem(currentItemId, { content, title });
    if (result.success) {
      saveStatus = 'saved';
      debug && console.log('[editor] Autosaved item:', currentItemId, 'title:', title);

      // Publish change event
      if (api?.publish) {
        api.publish('editor:changed', { action: 'update', itemId: currentItemId }, api.scopes.GLOBAL);
      }
    } else {
      console.error('[editor] Autosave failed:', result.error);
      saveStatus = 'unsaved';
    }
  } catch (err) {
    console.error('[editor] Autosave error:', err);
    saveStatus = 'unsaved';
  }

  updateSaveStatusUI();
};

/**
 * Create a new note item in the datastore (deferred from init).
 * Called on first real content change when editor was opened blank.
 */
const createDeferredNoteItem = async (content) => {
  if (!deferredNewNote || !api?.datastore?.addItem) return false;

  deferredNewNote = false; // Prevent re-entry

  try {
    const title = extractTitleFromContent(content);
    const result = await api.datastore.addItem('text', { content, title });
    if (result.success && result.data) {
      currentItemId = result.data.id;
      debug && console.log('[editor] Created new note item on first content:', currentItemId);

      // Tag with 'note' and 'from:cmd'
      if (api?.datastore?.getOrCreateTag && api?.datastore?.tagItem) {
        for (const tagName of ['note', 'from:cmd']) {
          const tagResult = await api.datastore.getOrCreateTag(tagName);
          if (tagResult.success) {
            await api.datastore.tagItem(currentItemId, tagResult.data.tag.id);
          }
        }
      }

      // Notify that a new item was created
      if (api?.publish) {
        api.publish('editor:changed', { action: 'add', itemId: currentItemId }, api.scopes.GLOBAL);
      }

      // Set context to editor mode
      if (api?.context?.setMode) {
        api.context.setMode('editor', { metadata: { itemId: currentItemId } });
      }

      // Show save status now that we have an item
      if (editorLayout) {
        editorLayout.setSaveStatusVisible(true);
      }

      saveStatus = 'saved';
      updateSaveStatusUI();
      return true;
    }
  } catch (err) {
    debug && console.log('[editor] Failed to create deferred note item:', err);
  }
  return false;
};

/**
 * Schedule autosave with debouncing
 */
const scheduleAutosave = (content) => {
  if (!currentItemId && !currentFilePath) return;

  // Mark as unsaved
  saveStatus = 'unsaved';
  updateSaveStatusUI();

  // Clear existing timer
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  // Schedule save after delay
  saveTimer = setTimeout(() => {
    performAutosave(content);
  }, AUTOSAVE_DELAY_MS);
};

/**
 * Handle content changes
 */
const handleContentChange = async (content) => {
  // Publish change event for other extensions
  if (api?.publish) {
    api.publish('editor:contentChanged', { content }, api.scopes.GLOBAL);
  }

  // If this is a deferred new note and user typed real content, create the item now
  if (deferredNewNote && content && content.trim().length > 0) {
    await createDeferredNoteItem(content);
    // Item was just created with this content — no need to schedule another save
    return;
  }

  // Schedule autosave if editing a datastore item or a file
  if (currentItemId || currentFilePath) {
    scheduleAutosave(content);
  }
};

/**
 * Clean up on unload
 */
const cleanup = () => {
  // Clear any pending autosave timer
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  // Reset deferred state
  deferredNewNote = false;

  // Reset context when leaving editor
  if (currentItemId && api?.context?.setMode) {
    api.context.setMode('default');
  }

  if (editorLayout) {
    editorLayout.destroy();
    editorLayout = null;
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);

// Clean up on unload
window.addEventListener('beforeunload', cleanup);
