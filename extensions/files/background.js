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
      console.log('[open file] execute:', ctx);

      try {
        const result = await api.files.open();

        if (!result.success) {
          if (result.canceled) {
            console.log('[open file] User cancelled file picker');
            return { success: true, message: 'File picker cancelled' };
          }
          return { success: false, error: result.error || 'Failed to open file' };
        }

        const file = result.data;
        console.log('[open file] Opened:', file.name, file.mimeType, file.size, 'bytes');

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
    description: 'Save data to a file (save dialog)',
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

        // Use the native save dialog
        const result = await api.files.save(content, { filename, mimeType });

        if (result.canceled) {
          console.log('[save] User cancelled save dialog');
          return { success: true, message: 'Save cancelled' };
        }

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to save file' };
        }

        console.log('[save] Saved to:', result.path);
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

        // Fields to skip in metadata display (internal/noise)
        const SKIP_FIELDS = new Set([
          'id', '_id', '_rev',
          'content', // shown as body text
          '_tags', 'tags', // shown separately
          'metadata', // parsed and shown separately
          'createdAt', 'updatedAt', 'deletedAt', 'syncedAt',
          'frecencyScore', 'visitCount', 'lastVisitAt',
          '_sync', 'syncSource', 'sync_source',
          'type', // used for title detection
          'name', 'title', // used for heading
        ]);

        // Detect common type across items
        const types = new Set(data.map(item => item?.type).filter(Boolean));
        const commonType = types.size === 1 ? types.values().next().value : null;

        // Detect common tags across items
        let commonTags = [];
        if (data.length > 0) {
          const allTagSets = data.map(item => new Set(item?._tags || []));
          if (allTagSets.length > 0 && allTagSets[0].size > 0) {
            commonTags = [...allTagSets[0]].filter(tag =>
              allTagSets.every(tagSet => tagSet.has(tag))
            );
          }
        }

        // Build document title
        let docTitle;
        if (ctx.inputTitle) {
          docTitle = ctx.inputTitle;
        } else if (commonType) {
          // Capitalize and pluralize the type
          const typeName = commonType.charAt(0).toUpperCase() + commonType.slice(1) + 's';
          docTitle = typeName;
          if (commonTags.length > 0) {
            docTitle += ' ' + commonTags.map(t => '#' + t).join(' ');
          }
        } else {
          docTitle = 'Export';
        }

        const lines = [];
        lines.push(`# ${docTitle}`);
        lines.push('');

        data.forEach((item, index) => {
          if (typeof item !== 'object' || item === null) {
            lines.push(`- ${String(item)}`);
            lines.push('');
            return;
          }

          // Extract heading from item
          const content = item.content || '';
          const contentLines = content.split('\n');
          let heading = (contentLines[0] || '').replace(/^#+\s*/, '').trim();
          if (!heading) {
            heading = item.name || item.title || `Item ${index + 1}`;
          }
          if (heading.length > 80) {
            heading = heading.substring(0, 77) + '...';
          }

          lines.push(`## ${heading}`);

          // Show tags (filter out common tags to reduce noise)
          const tags = item._tags || [];
          const uniqueTags = tags.filter(t => !commonTags.includes(t));
          if (uniqueTags.length > 0) {
            lines.push(`- Tags: ${uniqueTags.map(t => '#' + t).join(', ')}`);
          } else if (tags.length > 0 && commonTags.length === 0) {
            lines.push(`- Tags: ${tags.map(t => '#' + t).join(', ')}`);
          }

          // Show date
          if (item.createdAt) {
            const date = new Date(item.createdAt);
            if (!isNaN(date.getTime())) {
              lines.push(`- Created: ${date.toLocaleDateString()}`);
            }
          }

          // Show metadata fields (parsed from JSON metadata if present)
          if (item.metadata) {
            try {
              const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
              if (typeof meta === 'object' && meta !== null) {
                for (const [key, value] of Object.entries(meta)) {
                  if (SKIP_FIELDS.has(key) || key.startsWith('_')) continue;
                  if (value === null || value === undefined || value === '') continue;
                  const displayVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
                  if (displayVal.length > 200) continue; // Skip very long values
                  lines.push(`- ${key}: ${displayVal}`);
                }
              }
            } catch (e) {
              // Not valid JSON metadata, skip
            }
          }

          // Show non-standard fields that aren't in the skip list
          for (const [key, value] of Object.entries(item)) {
            if (SKIP_FIELDS.has(key) || key.startsWith('_')) continue;
            if (value === null || value === undefined || value === '') continue;
            if (typeof value === 'object') continue; // Skip complex objects
            const displayVal = String(value);
            if (displayVal.length > 200) continue;
            lines.push(`- ${key}: ${displayVal}`);
          }

          lines.push('');

          // Show content body (skip first line if used as heading)
          const isContentHeading = heading === contentLines[0]?.replace(/^#+\s*/, '').trim();
          const body = isContentHeading
            ? contentLines.slice(1).join('\n').trim()
            : content.trim();

          if (body) {
            lines.push(body);
            lines.push('');
          }

          // Separator between items (skip after last item)
          if (index < data.length - 1) {
            lines.push('---');
            lines.push('');
          }
        });

        const markdownOutput = lines.join('\n');
        console.log('[markdown] Generated markdown document,', markdownOutput.length, 'chars');

        return {
          success: true,
          output: {
            data: markdownOutput,
            mimeType: 'text/markdown',
            title: docTitle,
            interactive: 'peek://ext/cmd/chain-editor.html'
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
