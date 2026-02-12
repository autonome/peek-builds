/**
 * Files Extension Background Script
 *
 * File and format commands (CSV, save)
 *
 * Runs in isolated extension process (peek://ext/files/background.html)
 */

const api = window.app;
const debug = api.debug;

const id = 'files';
const labels = { name: 'Files' };

console.log('[ext:files] background', labels.name);

// ===== CSV Command =====

/**
 * Convert JSON array to CSV string
 */
function jsonToCsv(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  // Get all unique keys from all objects
  const keys = new Set();
  data.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      Object.keys(item).forEach(key => keys.add(key));
    }
  });

  const headers = Array.from(keys);

  // Escape CSV value
  const escapeValue = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    // If contains comma, newline, or quote, wrap in quotes and escape existing quotes
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  // Build CSV
  const lines = [];

  // Header row
  lines.push(headers.map(escapeValue).join(','));

  // Data rows
  data.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      const row = headers.map(header => escapeValue(item[header]));
      lines.push(row.join(','));
    } else {
      // Simple value, put in first column
      lines.push(escapeValue(item));
    }
  });

  return lines.join('\n');
}

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

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'csv',
    description: 'Convert JSON to CSV format',
    accepts: ['application/json'],
    produces: ['text/csv'],

    execute: async (ctx) => {
      console.log('[csv] execute:', ctx);

      // Check if we have input data from chain
      if (!ctx.input) {
        console.log('[csv] No input data');
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

        console.log('[csv] Converted', data.length, 'items to CSV');

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
    description: 'Save data to a file',
    accepts: ['*/*'], // Accept any MIME type
    produces: [], // End of chain - doesn't produce output

    execute: async (ctx) => {
      console.log('[save] execute:', ctx);

      // Check if we have input data from chain
      if (!ctx.input) {
        console.log('[save] No input data');
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

        // Send to background script to handle download
        // Background persists regardless of panel state
        api.publish('cmd:save-file', {
          content,
          filename,
          mimeType
        }, api.scopes.GLOBAL);

        console.log('[save] Requested download:', filename);
        return {
          success: true,
          message: `Saving ${filename}...`
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
      console.log('[markdown] execute:', ctx);

      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces JSON (e.g. "list notes #todo").'
        };
      }

      try {
        let data = ctx.input;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch (e) {
            // Not JSON - wrap plain text as a single-item array
            data = [{ content: data }];
          }
        }

        if (!Array.isArray(data)) {
          data = [data];
        }

        // Build markdown document
        const lines = [];

        // Title from input context
        const title = ctx.inputTitle || 'Notes';
        lines.push(`# ${title}`);
        lines.push('');
        lines.push(`*${data.length} item${data.length !== 1 ? 's' : ''}*`);
        lines.push('');
        lines.push('---');
        lines.push('');

        data.forEach((item, index) => {
          if (typeof item !== 'object' || item === null) {
            // Primitive value
            lines.push(`- ${String(item)}`);
            lines.push('');
            return;
          }

          // Extract meaningful title from the item
          const content = item.content || '';
          const contentLines = content.split('\n');
          // Use first line as heading (strip markdown heading prefix if present)
          let heading = (contentLines[0] || '').replace(/^#+\s*/, '').trim();
          if (!heading) {
            heading = item.name || item.title || `Item ${index + 1}`;
          }
          // Truncate long headings
          if (heading.length > 80) {
            heading = heading.substring(0, 77) + '...';
          }

          lines.push(`## ${heading}`);
          lines.push('');

          // Show tags if available
          const tags = item._tags || [];
          if (tags.length > 0) {
            lines.push(`**Tags:** ${tags.map(t => '#' + t).join(' ')}`);
            lines.push('');
          }

          // Show date if available
          if (item.createdAt || item.updatedAt) {
            const date = new Date(item.updatedAt || item.createdAt);
            if (!isNaN(date.getTime())) {
              lines.push(`*${date.toLocaleDateString()} ${date.toLocaleTimeString()}*`);
              lines.push('');
            }
          }

          // Show content body (skip first line if it was used as heading)
          const body = contentLines.slice(1).join('\n').trim();
          if (body) {
            lines.push(body);
            lines.push('');
          } else if (content && !heading.startsWith(content.substring(0, 10))) {
            // If heading didn't come from content, show full content
            lines.push(content);
            lines.push('');
          }

          lines.push('---');
          lines.push('');
        });

        const markdownOutput = lines.join('\n');
        console.log('[markdown] Generated markdown document,', markdownOutput.length, 'chars');

        return {
          success: true,
          output: {
            data: markdownOutput,
            mimeType: 'text/markdown',
            title: title
          }
        };
      } catch (err) {
        console.error('[markdown] Error:', err);
        return { success: false, error: err.message };
      }
    }
  },

  // ===== Download Command =====
  {
    name: 'download',
    description: 'Download data to a file (save dialog)',
    accepts: ['text/*', 'application/json'],
    produces: [], // End of chain

    execute: async (ctx) => {
      console.log('[download] execute:', ctx);

      if (!ctx.input) {
        return {
          success: false,
          error: 'No input data. Use this command in a chain after a command that produces output.'
        };
      }

      try {
        const data = ctx.input;
        const mimeType = ctx.inputMimeType || 'text/plain';

        // Determine filename
        let filename = ctx.search?.trim();
        if (!filename) {
          filename = generateFilename(mimeType, ctx.inputTitle);
        }
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

        // Use the native save dialog via api.files.save
        const result = await api.files.save(content, { filename, mimeType });

        if (result.canceled) {
          console.log('[download] User cancelled save dialog');
          return { success: true, message: 'Download cancelled' };
        }

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to save file' };
        }

        console.log('[download] Saved to:', result.path);
        return {
          success: true,
          message: `Saved to ${result.path}`
        };
      } catch (err) {
        console.error('[download] Error:', err);
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
      console.log('[save as note] execute:', ctx);

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
        api.publish('editor:changed', { action: 'add', itemId }, api.scopes.GLOBAL);

        console.log('[save as note] Created note:', itemId);

        return {
          success: true,
          output: {
            data: { id: itemId, type: 'text', content },
            mimeType: 'item',
            title: 'Saved note',
            isNew: true
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
  console.log('[ext:files] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:files] Unregistered commands');
};

const init = async () => {
  console.log('[ext:files] init');

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();
};

const uninit = () => {
  console.log('[ext:files] uninit');
  uninitCommands();
};

export default {
  id,
  init,
  uninit,
  labels
};
