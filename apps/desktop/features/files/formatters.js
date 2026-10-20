/**
 * Output formatters for the files feature's chain commands.
 *
 * `background.js` reads `window.app` at module load, so nothing in it can be
 * imported under node. These two conversions need nothing but their arguments,
 * so they live here and `tests/unit/cmd-chain.test.js` exercises the shipping
 * code instead of a copy of it.
 *
 * No imports: this module must stay loadable on its own.
 */

/**
 * Convert JSON array to CSV string
 */
export function jsonToCsv(data) {
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

/**
 * Render chained items as a markdown document.
 *
 * `input` may be an array of items, a single item, or a JSON string of either;
 * a string that is not JSON becomes one item whose content is that string.
 * `inputTitle` overrides the generated H1.
 *
 * @returns {{ markdown: string, docTitle: string }} the document and its title,
 *   which the caller also reports as the output's title
 */
export function formatAsMarkdown(input, inputTitle) {
  let data = input;
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
  if (inputTitle) {
    docTitle = inputTitle;
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

  return { markdown: lines.join('\n'), docTitle };
}
