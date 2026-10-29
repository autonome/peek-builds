/**
 * Files Extension Background Script
 *
 * File and format commands (CSV, save)
 *
 * Runs in isolated extension process (peek://files/background.html)
 */

import { jsonToCsv, formatAsMarkdown } from './formatters.js';

const api = window.app;

const id = 'files';
const labels = { name: 'Files' };

// ===== Save Command =====

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(mimeType) {
  const mimeToExt = {
    'application/json': 'json',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/html': 'html',
    'application/xml': 'xml',
    'text/xml': 'xml'
  };
  return mimeToExt[mimeType] || 'txt';
}

/**
 * Generate default filename
 */
function generateFilename(mimeType, title) {
  const ext = getExtensionFromMime(mimeType);
  const timestamp = new Date().toISOString().slice(0, 10);

  if (title) {
    // Sanitize title for filename
    const safeTitle = title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);
    return `${safeTitle}-${timestamp}.${ext}`;
  }

  return `export-${timestamp}.${ext}`;
}

/**
 * Get MIME type from file extension
 */
function getMimeFromExtension(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  const extToMime = {
    'md': 'text/markdown',
    'markdown': 'text/markdown',
    'txt': 'text/plain',
    'json': 'application/json',
    'html': 'text/html',
    'htm': 'text/html',
    'csv': 'text/csv',
    'xml': 'application/xml',
    'yaml': 'text/yaml',
    'yml': 'text/yaml',
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'css': 'text/css',
    'py': 'text/x-python',
    'rb': 'text/x-ruby',
    'sh': 'text/x-shellscript',
    'c': 'text/x-c',
    'cpp': 'text/x-c++',
    'h': 'text/x-c',
    'java': 'text/x-java',
    'go': 'text/x-go',
    'rs': 'text/x-rust',
    'swift': 'text/x-swift',
    'svg': 'image/svg+xml'
  };
  return extToMime[ext] || 'text/plain';
}

// ===== Command definitions =====

const commandDefinitions = [
  // ===== Open File Command =====
  {
    name: 'open file',
    description: 'Open a file from disk (native file picker)',
    accepts: [],
    produces: ['text/plain', 'text/markdown', 'text/html', 'text/csv', 'application/json'],

    execute: async (ctx) => {
      try {
        const result = await api.dialogs.open();

        if (!result.success) {
          if (result.canceled) {
            return { success: true, message: 'File picker cancelled' };
          }
          return { success: false, error: result.error || 'Failed to open file' };
        }

        const file = result.data;

        // If the file is not text, we can't chain it
        if (!file.isText || file.content === null) {
          return {
            success: false,
            error: `Cannot read binary file: ${file.name} (${file.mimeType})`
          };
        }

        // Determine the best chainable MIME type
        // Use the detected MIME type if it's a text type, otherwise fallback to text/plain
        let chainMimeType = file.mimeType;
        if (!chainMimeType.startsWith('text/') &&
            chainMimeType !== 'application/json' &&
            chainMimeType !== 'application/xml' &&
            chainMimeType !== 'image/svg+xml') {
          chainMimeType = 'text/plain';
        }

        const sizeLabel = file.size < 1024
          ? `${file.size} B`
          : file.size < 1024 * 1024
            ? `${(file.size / 1024).toFixed(1)} KB`
            : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

        return {
          success: true,
          output: {
            data: file.content,
            mimeType: chainMimeType,
            title: `${file.name} (${sizeLabel})`
          }
        };
      } catch (err) {
        console.error('[open file] Error:', err);
        return { success: false, error: err.message };
      }
    }
  },

  {
    name: 'csv',
    description: 'Convert JSON to CSV format',
    accepts: ['application/json'],
    produces: ['text/csv'],

    execute: async (ctx) => {
      // Check if we have input data from chain
      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces JSON.'
        };
      }

      try {
        // Parse input if it's a string
        let data = ctx.input;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch (e) {
            // Not JSON, treat as plain text
            return {
              success: false,
              error: 'Input is not valid JSON'
            };
          }
        }

        // Ensure we have an array
        if (!Array.isArray(data)) {
          // If it's an object with an 'items' property, use that
          if (data && Array.isArray(data.items)) {
            data = data.items;
          } else {
            // Wrap single object in array
            data = [data];
          }
        }

        // Convert to CSV
        const csvOutput = jsonToCsv(data);

        return {
          success: true,
          output: {
            data: csvOutput,
            mimeType: 'text/csv',
            title: `CSV (${data.length} rows)`
          }
        };
      } catch (err) {
        console.error('[csv] Error:', err);
        return { success: false, error: err.message };
      }
    }
  },
  {
    name: 'save',
    description: 'Save data to a file (save dialog)',
    accepts: ['*/*'], // Accept any MIME type
    produces: [], // End of chain - doesn't produce output

    execute: async (ctx) => {
      // Check if we have input data from chain
      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces output.'
        };
      }

      try {
        const data = ctx.input;
        const mimeType = ctx.inputMimeType || 'text/plain';

        // Determine filename - use search arg if provided, otherwise generate
        let filename = ctx.search?.trim();
        if (!filename) {
          filename = generateFilename(mimeType, ctx.inputTitle);
        }

        // Ensure proper extension
        if (!filename.includes('.')) {
          filename += '.' + getExtensionFromMime(mimeType);
        }

        // Stringify data if needed
        let content;
        if (typeof data === 'string') {
          content = data;
        } else {
          content = JSON.stringify(data, null, 2);
        }

        // Use the native save dialog
        const result = await api.dialogs.save(content, { filename, mimeType });

        if (result.canceled) {
          return { success: true, message: 'Save cancelled' };
        }

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to save file' };
        }
        return {
          success: true,
          message: `Saved to ${result.path}`
        };
      } catch (err) {
        console.error('[save] Error:', err);
        return { success: false, error: err.message };
      }
    }
  },

  // ===== Markdown Command =====
  {
    name: 'markdown',
    description: 'Format items as a markdown document',
    accepts: ['application/json'],
    produces: ['text/markdown'],

    execute: async (ctx) => {
      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces JSON (e.g. "list notes #todo").'
        };
      }

      try {
        const { markdown, docTitle } = formatAsMarkdown(ctx.input, ctx.inputTitle);

        return {
          success: true,
          output: {
            data: markdown,
            mimeType: 'text/markdown',
            title: docTitle,
            interactive: 'peek://cmd/chain-editor.html'
          }
        };
      } catch (err) {
        console.error('[markdown] Error:', err);
        return { success: false, error: err.message };
      }
    }
  },

  // ===== Save as Note Command =====
  {
    name: 'save as note',
    description: 'Save text content as a new note in the datastore',
    accepts: ['text/*'],
    produces: ['item'], // Produces item for potential editor routing

    execute: async (ctx) => {
      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces text.'
        };
      }

      try {
        // Get text content
        let content;
        if (typeof ctx.input === 'string') {
          content = ctx.input;
        } else {
          content = JSON.stringify(ctx.input, null, 2);
        }

        // Create the note item
        const result = await api.datastore.addItem('text', { content });
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to save note' };
        }

        const itemId = result.data.id;

        // Tag with 'note' and 'from:cmd'
        const noteTags = ['note', 'from:cmd'];
        for (const tagName of noteTags) {
          const tagResult = await api.datastore.getOrCreateTag(tagName);
          if (tagResult.success) {
            await api.datastore.tagItem(itemId, tagResult.data.tag.id);
          }
        }

        // Notify editor of the new item
        api.publish('editor:changed', { action: 'add', itemId });

        return {
          success: true,
          output: {
            data: { id: itemId, type: 'text', content },
            mimeType: 'item',
            publish: [
              { topic: 'editor:open', payload: { itemId } },
              { topic: 'editor:changed', payload: { action: 'add', itemId } }
            ],
            title: 'Saved note'
          }
        };
      } catch (err) {
        console.error('[save as note] Error:', err);
        return { success: false, error: err.message };
      }
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
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
};

const init = async () => {
  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();
};

const uninit = () => {
  uninitCommands();
};

export default {
  id,
  init,
  uninit,
  labels
};
