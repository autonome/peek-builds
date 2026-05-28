/**
 * Composer Extension Background Script
 *
 * Opens a quick item composer with tag management.
 * Loads lazily on first composer:open event or command invocation.
 */

// Feature detection
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/**
 * Open the composer window
 */
function openComposer(params) {
  if (!hasPeekAPI) return;
  let url = 'peek://composer/compose.html';
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  }
  api.window.open(url, {
    role: 'workspace',
    key: 'composer',
    width: 600,
    height: 500,
    title: 'Compose'
  });
}

const extension = {
  id: 'composer',
  labels: { name: 'Composer' },

  init() {
    if (!hasPeekAPI) return;

    // Register command handler — manifest declares the command,
    // this sets up the execute handler
    api.commands.register({
      name: 'compose',
      description: 'Create a new item',
      execute: () => openComposer()
    });

    // Subscribe to composer:open — open composer with optional params
    api.pubsub.subscribe('composer:open', (msg) => {
      openComposer(msg);
    });
  },

  uninit() {}
};

export default extension;
