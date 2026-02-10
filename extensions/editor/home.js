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

const api = window.app;
const debug = api?.debug;

// Editor layout instance
let editorLayout = null;

// Settings storage key (matches how Settings app stores under 'prefs' key)
const PREFS_STORAGE_KEY = 'prefs';

// Autosave state
let currentItemId = null;
let saveStatus = 'saved'; // 'saved' | 'saving' | 'unsaved'
let saveTimer = null;
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
  try {
    if (api?.settings?.getKey) {
      const result = await api.settings.getKey(PREFS_STORAGE_KEY);
      if (result.success && result.data && typeof result.data === 'object') {
        vimMode = !!result.data.vimMode;
        debug && console.log('[editor] Loaded vimMode from prefs:', vimMode);
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

  let initialContent = SAMPLE_CONTENT;

  // If content provided via URL param, use it
  if (contentParam) {
    initialContent = contentParam;
  }

  // If file path provided, try to load it
  if (fileParam && api?.fs?.readFile) {
    try {
      const result = await api.fs.readFile(fileParam);
      if (result.success) {
        initialContent = result.data;
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

  // Create editor layout
  editorLayout = new EditorLayout({
    container: rootEl,
    initialContent,
    vimMode,
    onContentChange: handleContentChange,
  });

  // Show save status indicator if editing a datastore item
  if (currentItemId) {
    editorLayout.setSaveStatusVisible(true);
  }

  // Set up escape handler
  if (api?.escape) {
    api.escape.onEscape(() => {
      if (editorLayout?.isInFocusMode()) {
        editorLayout.exitFocusMode();
        return { handled: true };
      }
      return { handled: false };
    });
  }

  // Listen for settings changes from Settings app to live-reload vim mode
  if (api?.subscribe) {
    api.subscribe('editor:settings-changed', async () => {
      debug && console.log('[editor] Settings changed, reloading vim mode');
      try {
        if (api?.settings?.getKey) {
          const result = await api.settings.getKey(PREFS_STORAGE_KEY);
          if (result.success && result.data && typeof result.data === 'object') {
            const newVimMode = !!result.data.vimMode;
            if (editorLayout) {
              editorLayout.setVimMode(newVimMode);
            }
            debug && console.log('[editor] Updated vimMode from settings:', newVimMode);
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
 * Perform autosave to datastore
 */
const performAutosave = async (content) => {
  if (!currentItemId || !api?.datastore?.updateItem) {
    return;
  }

  saveStatus = 'saving';
  updateSaveStatusUI();

  try {
    const result = await api.datastore.updateItem(currentItemId, { content });
    if (result.success) {
      saveStatus = 'saved';
      debug && console.log('[editor] Autosaved item:', currentItemId);

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
 * Schedule autosave with debouncing
 */
const scheduleAutosave = (content) => {
  if (!currentItemId) return;

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
const handleContentChange = (content) => {
  // Publish change event for other extensions
  if (api?.publish) {
    api.publish('editor:contentChanged', { content }, api.scopes.GLOBAL);
  }

  // Schedule autosave if editing a datastore item
  if (currentItemId) {
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
