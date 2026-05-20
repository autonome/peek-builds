/**
 * Unit tests for command chaining/pipe system
 *
 * Tests extracted pure functions from:
 * - extensions/cmd/panel.js: mimeTypeMatches, findChainingCommands,
 *   buildExecutionContext (chain context), isTextMimeType, chain state
 * - extensions/files/background.js: markdown formatter (heuristic converter)
 *
 * These are logic-only tests -- no DOM, no Electron, no extensions runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// mimeTypeMatches (from extensions/cmd/panel.js)
// ============================================================================

/**
 * Check if a MIME pattern matches an actual MIME type.
 * Supports wildcards like *‌/‌* for any type, text/‌* for text subtypes.
 */
function mimeTypeMatches(pattern: string | null, actual: string | null): boolean {
  if (!pattern || !actual) return false;
  if (pattern === '*/*' || pattern === actual) return true;

  const [pType, pSub] = pattern.split('/');
  const [aType, aSub] = actual.split('/');

  // Wildcard subtype (e.g., "text/*" matches "text/plain")
  return pSub === '*' && pType === aType;
}

// ============================================================================
// isTextMimeType (from extensions/cmd/panel.js)
// ============================================================================

function isTextMimeType(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return mimeType.startsWith('text/');
}

// ============================================================================
// findChainingCommands (from extensions/cmd/panel.js)
// ============================================================================

interface CommandDef {
  name: string;
  description?: string;
  accepts?: string[];
  produces?: string[];
}

function findChainingCommands(commands: { [name: string]: CommandDef }, mimeType: string): CommandDef[] {
  return Object.values(commands).filter(cmd => {
    if (!cmd.accepts?.length) return false;
    return cmd.accepts.some(acceptedType => mimeTypeMatches(acceptedType, mimeType));
  });
}

// ============================================================================
// buildExecutionContext (from extensions/cmd/panel.js)
// ============================================================================

interface ChainContext {
  data: unknown;
  mimeType: string;
  title: string;
  sourceCommand: string;
}

interface ExecutionContext {
  typed: string;
  name: string;
  params: string[];
  search: string | null;
  input?: unknown;
  inputMimeType?: string;
  inputTitle?: string;
  inputSource?: string;
}

function buildExecutionContext(
  name: string,
  typed: string,
  chainMode: boolean,
  chainContext: ChainContext | null
): ExecutionContext {
  const trimmed = typed.trim();
  const rest = trimmed.startsWith(name) ? trimmed.slice(name.length).trim() : trimmed;
  const params = rest.length > 0 ? rest.split(/\s+/) : [];
  const search = rest.length > 0 ? rest : null;

  const context: ExecutionContext = {
    typed,
    name,
    params,
    search,
  };

  // Add chain data if in chain mode
  if (chainMode && chainContext) {
    context.input = chainContext.data;
    context.inputMimeType = chainContext.mimeType;
    context.inputTitle = chainContext.title;
    context.inputSource = chainContext.sourceCommand;
  }

  return context;
}

// ============================================================================
// jsonToCsv (from extensions/files/background.js)
// ============================================================================

function jsonToCsv(data: unknown[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const keys = new Set<string>();
  data.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      Object.keys(item).forEach(key => keys.add(key));
    }
  });

  const headers = Array.from(keys);

  const escapeValue = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines: string[] = [];
  lines.push(headers.map(escapeValue).join(','));

  data.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      const row = headers.map(header => escapeValue((item as Record<string, unknown>)[header]));
      lines.push(row.join(','));
    } else {
      lines.push(escapeValue(item));
    }
  });

  return lines.join('\n');
}

// ============================================================================
// Markdown formatter (from extensions/files/background.js)
// ============================================================================

function formatAsMarkdown(
  data: unknown,
  inputTitle?: string
): string {
  let items: unknown[];

  if (typeof data === 'string') {
    try {
      items = JSON.parse(data);
    } catch (e) {
      items = [{ content: data }];
    }
  } else if (Array.isArray(data)) {
    items = data;
  } else {
    items = [data];
  }

  if (!Array.isArray(items)) {
    items = [items];
  }

  // Fields to skip in metadata display (internal/noise)
  const SKIP_FIELDS = new Set([
    'id', '_id', '_rev',
    'content',
    '_tags', 'tags',
    'metadata',
    'createdAt', 'updatedAt', 'deletedAt', 'syncedAt',
    'frecencyScore', 'visitCount', 'lastVisitAt',
    '_sync', 'syncSource', 'sync_source',
    'type',
    'name', 'title',
  ]);

  // Detect common type across items
  const types = new Set(items.map((item: any) => item?.type).filter(Boolean));
  const commonType = types.size === 1 ? types.values().next().value : null;

  // Detect common tags across items
  let commonTags: string[] = [];
  if (items.length > 0) {
    const allTagSets = items.map((item: any) => new Set(item?._tags || []));
    if (allTagSets.length > 0 && allTagSets[0].size > 0) {
      commonTags = ([...allTagSets[0]] as string[]).filter((tag: string) =>
        allTagSets.every(tagSet => tagSet.has(tag))
      );
    }
  }

  // Build document title
  let docTitle: string;
  if (inputTitle) {
    docTitle = inputTitle;
  } else if (commonType) {
    const typeName = commonType.charAt(0).toUpperCase() + commonType.slice(1) + 's';
    docTitle = typeName;
    if (commonTags.length > 0) {
      docTitle += ' ' + commonTags.map((t: string) => '#' + t).join(' ');
    }
  } else {
    docTitle = 'Export';
  }

  const lines: string[] = [];
  lines.push(`# ${docTitle}`);
  lines.push('');

  items.forEach((item: any, index: number) => {
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
    const uniqueTags = tags.filter((t: string) => !commonTags.includes(t));
    if (uniqueTags.length > 0) {
      lines.push(`- Tags: ${uniqueTags.map((t: string) => '#' + t).join(', ')}`);
    } else if (tags.length > 0 && commonTags.length === 0) {
      lines.push(`- Tags: ${tags.map((t: string) => '#' + t).join(', ')}`);
    }

    // Show date
    if (item.createdAt) {
      const date = new Date(item.createdAt);
      if (!isNaN(date.getTime())) {
        lines.push(`- Created: ${date.toLocaleDateString()}`);
      }
    }

    // Show metadata fields
    if (item.metadata) {
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        if (typeof meta === 'object' && meta !== null) {
          for (const [key, value] of Object.entries(meta)) {
            if (SKIP_FIELDS.has(key) || key.startsWith('_')) continue;
            if (value === null || value === undefined || value === '') continue;
            const displayVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
            if (displayVal.length > 200) continue;
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
      if (typeof value === 'object') continue;
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
    if (index < items.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });

  return lines.join('\n');
}

// ============================================================================
// Tests: MIME Type Matching
// ============================================================================

describe('Command Chain -- mimeTypeMatches', () => {
  it('exact match returns true', () => {
    assert.strictEqual(mimeTypeMatches('application/json', 'application/json'), true);
  });

  it('wildcard */* matches any type', () => {
    assert.strictEqual(mimeTypeMatches('*/*', 'application/json'), true);
    assert.strictEqual(mimeTypeMatches('*/*', 'text/plain'), true);
    assert.strictEqual(mimeTypeMatches('*/*', 'image/png'), true);
  });

  it('text/* matches text subtypes', () => {
    assert.strictEqual(mimeTypeMatches('text/*', 'text/plain'), true);
    assert.strictEqual(mimeTypeMatches('text/*', 'text/markdown'), true);
    assert.strictEqual(mimeTypeMatches('text/*', 'text/csv'), true);
    assert.strictEqual(mimeTypeMatches('text/*', 'text/html'), true);
  });

  it('text/* does not match non-text types', () => {
    assert.strictEqual(mimeTypeMatches('text/*', 'application/json'), false);
    assert.strictEqual(mimeTypeMatches('text/*', 'image/png'), false);
  });

  it('application/* matches application subtypes', () => {
    assert.strictEqual(mimeTypeMatches('application/*', 'application/json'), true);
    assert.strictEqual(mimeTypeMatches('application/*', 'application/xml'), true);
  });

  it('mismatched types return false', () => {
    assert.strictEqual(mimeTypeMatches('text/plain', 'text/markdown'), false);
    assert.strictEqual(mimeTypeMatches('application/json', 'text/plain'), false);
  });

  it('null or empty values return false', () => {
    assert.strictEqual(mimeTypeMatches(null, 'text/plain'), false);
    assert.strictEqual(mimeTypeMatches('text/plain', null), false);
    assert.strictEqual(mimeTypeMatches(null, null), false);
    assert.strictEqual(mimeTypeMatches('', 'text/plain'), false);
    assert.strictEqual(mimeTypeMatches('text/plain', ''), false);
  });
});

// ============================================================================
// Tests: isTextMimeType
// ============================================================================

describe('Command Chain -- isTextMimeType', () => {
  it('text/ prefix is text', () => {
    assert.strictEqual(isTextMimeType('text/plain'), true);
    assert.strictEqual(isTextMimeType('text/markdown'), true);
    assert.strictEqual(isTextMimeType('text/csv'), true);
    assert.strictEqual(isTextMimeType('text/html'), true);
  });

  it('application/json is not text', () => {
    assert.strictEqual(isTextMimeType('application/json'), false);
  });

  it('image types are not text', () => {
    assert.strictEqual(isTextMimeType('image/png'), false);
  });

  it('null returns false', () => {
    assert.strictEqual(isTextMimeType(null), false);
  });

  it('empty string returns false', () => {
    assert.strictEqual(isTextMimeType(''), false);
  });
});

// ============================================================================
// Tests: findChainingCommands
// ============================================================================

describe('Command Chain -- findChainingCommands', () => {
  const commands: { [name: string]: CommandDef } = {
    'csv': {
      name: 'csv',
      description: 'Convert JSON to CSV',
      accepts: ['application/json'],
      produces: ['text/csv'],
    },
    'markdown': {
      name: 'markdown',
      description: 'Format items as markdown',
      accepts: ['application/json'],
      produces: ['text/markdown'],
    },
    'save': {
      name: 'save',
      description: 'Save data to file',
      accepts: ['*/*'],
      produces: [],
    },
    'download': {
      name: 'download',
      description: 'Download data',
      accepts: ['text/*', 'application/json'],
      produces: [],
    },
    'save as note': {
      name: 'save as note',
      description: 'Save text as note',
      accepts: ['text/*'],
      produces: ['item'],
    },
    'list notes': {
      name: 'list notes',
      description: 'List all notes',
      accepts: [],
      produces: ['application/json'],
    },
    'open file': {
      name: 'open file',
      description: 'Open file from disk',
      produces: ['text/plain', 'text/markdown'],
    },
  };

  it('finds commands accepting application/json', () => {
    const result = findChainingCommands(commands, 'application/json');
    const names = result.map(c => c.name);
    assert.ok(names.includes('csv'), 'csv accepts application/json');
    assert.ok(names.includes('markdown'), 'markdown accepts application/json');
    assert.ok(names.includes('save'), 'save accepts */*');
    assert.ok(names.includes('download'), 'download accepts application/json');
  });

  it('finds commands accepting text/markdown', () => {
    const result = findChainingCommands(commands, 'text/markdown');
    const names = result.map(c => c.name);
    assert.ok(names.includes('save'), 'save accepts */*');
    assert.ok(names.includes('download'), 'download accepts text/*');
    assert.ok(names.includes('save as note'), 'save as note accepts text/*');
    assert.ok(!names.includes('csv'), 'csv does not accept text/markdown');
    assert.ok(!names.includes('markdown'), 'markdown does not accept text/markdown');
  });

  it('finds commands accepting text/plain', () => {
    const result = findChainingCommands(commands, 'text/plain');
    const names = result.map(c => c.name);
    assert.ok(names.includes('save'), 'save accepts */*');
    assert.ok(names.includes('download'), 'download accepts text/*');
    assert.ok(names.includes('save as note'), 'save as note accepts text/*');
  });

  it('excludes commands with no accepts', () => {
    const result = findChainingCommands(commands, 'application/json');
    const names = result.map(c => c.name);
    assert.ok(!names.includes('list notes'), 'list notes has empty accepts');
    assert.ok(!names.includes('open file'), 'open file has no accepts');
  });

  it('returns empty array for unknown mime type with no wildcard commands', () => {
    // Remove wildcard command to test pure matching
    const noWildcard: { [name: string]: CommandDef } = {
      'csv': commands['csv'],
      'markdown': commands['markdown'],
    };
    const result = findChainingCommands(noWildcard, 'image/png');
    assert.strictEqual(result.length, 0);
  });

  it('wildcard */* command matches any type', () => {
    const result = findChainingCommands(commands, 'image/png');
    const names = result.map(c => c.name);
    assert.ok(names.includes('save'), 'save with */* should match image/png');
    assert.strictEqual(names.length, 1, 'only save should match image/png');
  });
});

// ============================================================================
// Tests: buildExecutionContext
// ============================================================================

describe('Command Chain -- buildExecutionContext', () => {
  it('builds basic context without chain data', () => {
    const ctx = buildExecutionContext('csv', 'csv', false, null);
    assert.strictEqual(ctx.typed, 'csv');
    assert.strictEqual(ctx.name, 'csv');
    assert.deepStrictEqual(ctx.params, []);
    assert.strictEqual(ctx.search, null);
    assert.strictEqual(ctx.input, undefined);
    assert.strictEqual(ctx.inputMimeType, undefined);
  });

  it('extracts parameters from typed text', () => {
    const ctx = buildExecutionContext('save', 'save output.csv', false, null);
    assert.strictEqual(ctx.name, 'save');
    assert.deepStrictEqual(ctx.params, ['output.csv']);
    assert.strictEqual(ctx.search, 'output.csv');
  });

  it('includes chain context when in chain mode', () => {
    const chainContext: ChainContext = {
      data: [{ id: '1', content: 'hello' }],
      mimeType: 'application/json',
      title: 'Notes',
      sourceCommand: 'list notes',
    };

    const ctx = buildExecutionContext('csv', 'csv', true, chainContext);
    assert.strictEqual(ctx.name, 'csv');
    assert.deepStrictEqual(ctx.input, chainContext.data);
    assert.strictEqual(ctx.inputMimeType, 'application/json');
    assert.strictEqual(ctx.inputTitle, 'Notes');
    assert.strictEqual(ctx.inputSource, 'list notes');
  });

  it('does not include chain data when chainMode is false', () => {
    const chainContext: ChainContext = {
      data: 'some data',
      mimeType: 'text/plain',
      title: 'Test',
      sourceCommand: 'test',
    };

    const ctx = buildExecutionContext('save', 'save', false, chainContext);
    assert.strictEqual(ctx.input, undefined);
    assert.strictEqual(ctx.inputMimeType, undefined);
  });

  it('does not include chain data when chainContext is null', () => {
    const ctx = buildExecutionContext('save', 'save', true, null);
    assert.strictEqual(ctx.input, undefined);
    assert.strictEqual(ctx.inputMimeType, undefined);
  });

  it('handles command with multiple parameters', () => {
    const ctx = buildExecutionContext('save', 'save my-file.md --force', false, null);
    assert.deepStrictEqual(ctx.params, ['my-file.md', '--force']);
    assert.strictEqual(ctx.search, 'my-file.md --force');
  });
});

// ============================================================================
// Tests: Chain State Tracking
// ============================================================================

describe('Command Chain -- chain state tracking', () => {
  it('chain stack records step history', () => {
    const chainStack: ChainContext[] = [];

    // Step 1: list notes produces JSON
    const step1: ChainContext = {
      data: [{ id: '1', content: 'note 1' }, { id: '2', content: 'note 2' }],
      mimeType: 'application/json',
      title: 'Notes #todo',
      sourceCommand: 'list notes',
    };
    chainStack.push({ ...step1 });

    assert.strictEqual(chainStack.length, 1);
    assert.strictEqual(chainStack[0].sourceCommand, 'list notes');

    // Step 2: markdown converts JSON to markdown
    const step2: ChainContext = {
      data: '# Notes\n\n## note 1\n\n## note 2\n',
      mimeType: 'text/markdown',
      title: 'Notes #todo',
      sourceCommand: 'markdown',
    };
    chainStack.push({ ...step2 });

    assert.strictEqual(chainStack.length, 2);
    assert.strictEqual(chainStack[1].mimeType, 'text/markdown');
    assert.strictEqual(chainStack[1].sourceCommand, 'markdown');
  });

  it('chain undo pops the last step', () => {
    const chainStack: ChainContext[] = [];

    chainStack.push({
      data: [{ id: '1' }],
      mimeType: 'application/json',
      title: 'Notes',
      sourceCommand: 'list notes',
    });
    chainStack.push({
      data: '# Notes\n...',
      mimeType: 'text/markdown',
      title: 'Notes',
      sourceCommand: 'markdown',
    });

    assert.strictEqual(chainStack.length, 2);

    // Undo: pop current, restore previous
    chainStack.pop();
    const restored = chainStack[chainStack.length - 1];

    assert.strictEqual(chainStack.length, 1);
    assert.strictEqual(restored.mimeType, 'application/json');
    assert.strictEqual(restored.sourceCommand, 'list notes');
  });

  it('undo exits chain mode when stack has one item', () => {
    const chainStack: ChainContext[] = [];

    chainStack.push({
      data: [{ id: '1' }],
      mimeType: 'application/json',
      title: 'Notes',
      sourceCommand: 'list notes',
    });

    // When stack has <= 1 item, undo should exit chain mode
    assert.ok(chainStack.length <= 1, 'Stack with one item should signal exit');
  });
});

// ============================================================================
// Tests: jsonToCsv
// ============================================================================

describe('Command Chain -- jsonToCsv', () => {
  it('converts array of objects to CSV', () => {
    const data = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ];
    const csv = jsonToCsv(data);
    const lines = csv.split('\n');
    assert.strictEqual(lines[0], 'name,age');
    assert.strictEqual(lines[1], 'Alice,30');
    assert.strictEqual(lines[2], 'Bob,25');
  });

  it('returns empty string for empty array', () => {
    assert.strictEqual(jsonToCsv([]), '');
  });

  it('escapes values containing commas', () => {
    const data = [{ text: 'hello, world' }];
    const csv = jsonToCsv(data);
    assert.ok(csv.includes('"hello, world"'));
  });

  it('escapes values containing quotes', () => {
    const data = [{ text: 'say "hello"' }];
    const csv = jsonToCsv(data);
    assert.ok(csv.includes('"say ""hello"""'));
  });

  it('escapes values containing newlines', () => {
    const data = [{ text: 'line1\nline2' }];
    const csv = jsonToCsv(data);
    assert.ok(csv.includes('"line1\nline2"'));
  });

  it('handles null and undefined values', () => {
    const data = [{ a: null, b: undefined, c: 'ok' }];
    const csv = jsonToCsv(data);
    const lines = csv.split('\n');
    assert.strictEqual(lines[1], ',,ok');
  });

  it('handles objects with different keys (union of all keys)', () => {
    const data = [
      { name: 'Alice', role: 'admin' },
      { name: 'Bob', age: 25 },
    ];
    const csv = jsonToCsv(data);
    const header = csv.split('\n')[0];
    assert.ok(header.includes('name'));
    assert.ok(header.includes('role'));
    assert.ok(header.includes('age'));
  });
});

// ============================================================================
// Tests: Markdown Formatter
// ============================================================================

describe('Command Chain -- markdown formatter', () => {
  it('formats a list of notes with tags into markdown', () => {
    const notes = [
      {
        type: 'text',
        content: 'Buy groceries\nMilk, eggs, bread',
        _tags: ['todo', 'personal'],
        createdAt: '2025-01-15T10:00:00Z',
      },
      {
        type: 'text',
        content: 'Review PR\nCheck tests and coverage',
        _tags: ['todo', 'work'],
        createdAt: '2025-01-16T14:30:00Z',
      },
    ];

    const md = formatAsMarkdown(notes);

    // H1 with type + common tags
    assert.ok(md.startsWith('# Texts #todo'), 'Should start with H1 containing type and common tag');

    // H2 per item (first line of content as heading)
    assert.ok(md.includes('## Buy groceries'), 'Should have H2 for first note');
    assert.ok(md.includes('## Review PR'), 'Should have H2 for second note');

    // Unique tags as bullets (common tag "todo" filtered out)
    assert.ok(md.includes('- Tags: #personal'), 'Should show unique tag for first note');
    assert.ok(md.includes('- Tags: #work'), 'Should show unique tag for second note');

    // Created dates
    assert.ok(md.includes('- Created:'), 'Should include created date');

    // Content body (second line onward)
    assert.ok(md.includes('Milk, eggs, bread'), 'Should include content body');
    assert.ok(md.includes('Check tests and coverage'), 'Should include content body');

    // Separator between items
    assert.ok(md.includes('---'), 'Should have separator between items');
  });

  it('handles single item (not a list)', () => {
    const item = {
      type: 'text',
      content: 'Solo note\nWith details',
      _tags: ['idea'],
    };

    const md = formatAsMarkdown(item);

    assert.ok(md.startsWith('# Texts'), 'Should have H1 with type');
    assert.ok(md.includes('## Solo note'), 'Should have H2 for the item');
    assert.ok(md.includes('With details'), 'Should include body content');
    assert.ok(!md.includes('---'), 'Single item should not have separator');
  });

  it('handles items without content field', () => {
    const items = [
      { type: 'url', name: 'Example Site', url: 'https://example.com' },
      { type: 'url', name: 'GitHub', url: 'https://github.com' },
    ];

    const md = formatAsMarkdown(items);

    // Should use name for heading when content is empty
    assert.ok(md.includes('## Example Site'), 'Should use name as heading');
    assert.ok(md.includes('## GitHub'), 'Should use name as heading');

    // Non-standard fields like "url" should appear as metadata
    assert.ok(md.includes('- url: https://example.com'), 'Should show non-standard fields');
    assert.ok(md.includes('- url: https://github.com'), 'Should show non-standard fields');
  });

  it('handles empty input (empty array)', () => {
    const md = formatAsMarkdown([]);

    // Should still have a title
    assert.ok(md.startsWith('# Export'), 'Empty array without type should use "Export"');
    // Should not have any H2 headings
    assert.ok(!md.includes('## '), 'Should have no item headings for empty input');
  });

  it('produces valid markdown structure', () => {
    const notes = [
      {
        type: 'text',
        content: 'First note\nBody of first note',
        _tags: ['tag1', 'tag2'],
      },
      {
        type: 'text',
        content: 'Second note\nBody of second note',
        _tags: ['tag3'],
      },
    ];

    const md = formatAsMarkdown(notes);
    const lines = md.split('\n');

    // First line should be H1
    assert.ok(lines[0].startsWith('# '), 'First line must be H1');

    // Should contain H2 headings
    const h2Lines = lines.filter(l => l.startsWith('## '));
    assert.strictEqual(h2Lines.length, 2, 'Should have exactly 2 H2 headings');

    // Metadata lines should be bulleted
    const metadataLines = lines.filter(l => l.startsWith('- Tags:') || l.startsWith('- Created:'));
    assert.ok(metadataLines.length > 0, 'Should have bulleted metadata');

    // Separator should exist between items
    const separators = lines.filter(l => l === '---');
    assert.strictEqual(separators.length, 1, 'Should have 1 separator between 2 items');
  });

  it('uses inputTitle when provided', () => {
    const md = formatAsMarkdown([{ content: 'test' }], 'My Custom Title');
    assert.ok(md.startsWith('# My Custom Title'), 'Should use provided inputTitle');
  });

  it('handles items with metadata JSON field', () => {
    const items = [
      {
        type: 'text',
        content: 'Note with metadata',
        metadata: JSON.stringify({ source: 'clipboard', priority: 'high', _internal: 'skip' }),
      },
    ];

    const md = formatAsMarkdown(items);

    assert.ok(md.includes('- source: clipboard'), 'Should display metadata fields');
    assert.ok(md.includes('- priority: high'), 'Should display metadata fields');
    assert.ok(!md.includes('_internal'), 'Should skip fields starting with _');
  });

  it('handles items with metadata as object (not JSON string)', () => {
    const items = [
      {
        type: 'text',
        content: 'Note with object metadata',
        metadata: { source: 'web', priority: 'low' },
      },
    ];

    const md = formatAsMarkdown(items);

    assert.ok(md.includes('- source: web'), 'Should display metadata object fields');
    assert.ok(md.includes('- priority: low'), 'Should display metadata object fields');
  });

  it('truncates long headings at 80 chars', () => {
    const longHeading = 'A'.repeat(100);
    const items = [{ content: longHeading }];

    const md = formatAsMarkdown(items);
    const h2Line = md.split('\n').find(l => l.startsWith('## '));

    assert.ok(h2Line, 'Should have an H2 line');
    // 3 for "## " prefix + 77 for truncated heading + 3 for "..."
    assert.ok(h2Line!.length <= 83, 'Heading should be truncated');
    assert.ok(h2Line!.includes('...'), 'Truncated heading should end with ...');
  });

  it('strips markdown heading prefix from content first line', () => {
    const items = [{ content: '## My Heading\nBody text' }];
    const md = formatAsMarkdown(items);

    // The heading should be "My Heading" (stripped of ##)
    assert.ok(md.includes('## My Heading'), 'Should strip content heading markers');
    // Should NOT have "## ## My Heading"
    assert.ok(!md.includes('## ## '), 'Should not double the heading markers');
  });

  it('handles primitive array items', () => {
    const items = ['string item 1', 'string item 2'];
    const md = formatAsMarkdown(items);

    assert.ok(md.includes('- string item 1'), 'Should render primitives as list items');
    assert.ok(md.includes('- string item 2'), 'Should render primitives as list items');
  });

  it('skips internal fields in output', () => {
    const items = [
      {
        id: 'abc123',
        _id: 'internal',
        _rev: '1-xyz',
        type: 'text',
        content: 'Test note',
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-15T10:00:00Z',
        syncedAt: 0,
        frecencyScore: 0.5,
        visitCount: 3,
        _sync: { modified: true },
      },
    ];

    const md = formatAsMarkdown(items);

    // None of the skip fields should appear as metadata bullets
    assert.ok(!md.includes('- id:'), 'Should skip id field');
    assert.ok(!md.includes('- _id:'), 'Should skip _id field');
    assert.ok(!md.includes('- _rev:'), 'Should skip _rev field');
    assert.ok(!md.includes('- type:'), 'Should skip type field');
    assert.ok(!md.includes('- updatedAt:'), 'Should skip updatedAt field');
    assert.ok(!md.includes('- syncedAt:'), 'Should skip syncedAt field');
    assert.ok(!md.includes('- frecencyScore:'), 'Should skip frecencyScore field');
    assert.ok(!md.includes('- visitCount:'), 'Should skip visitCount field');
  });

  it('filters common tags from individual items', () => {
    const items = [
      { type: 'text', content: 'Note A', _tags: ['shared', 'unique-a'] },
      { type: 'text', content: 'Note B', _tags: ['shared', 'unique-b'] },
    ];

    const md = formatAsMarkdown(items);

    // "shared" should be in the H1 title, not in individual items
    assert.ok(md.includes('# Texts #shared'), 'Common tag should be in title');
    // Individual items should only show their unique tags
    assert.ok(md.includes('- Tags: #unique-a'), 'Should show unique tags per item');
    assert.ok(md.includes('- Tags: #unique-b'), 'Should show unique tags per item');
    // "shared" should not appear in individual tag lists
    const tagLines = md.split('\n').filter(l => l.startsWith('- Tags:'));
    for (const line of tagLines) {
      assert.ok(!line.includes('#shared'), 'Common tag should be filtered from per-item tags');
    }
  });

  it('handles mixed types (no common type)', () => {
    const items = [
      { type: 'text', content: 'A text note' },
      { type: 'url', content: 'https://example.com' },
    ];

    const md = formatAsMarkdown(items);

    // No common type, should use "Export" as title
    assert.ok(md.startsWith('# Export'), 'Mixed types should use "Export" title');
  });

  it('handles data passed as JSON string', () => {
    const jsonStr = JSON.stringify([
      { type: 'text', content: 'Parsed from string', _tags: ['test'] },
    ]);

    const md = formatAsMarkdown(jsonStr);

    assert.ok(md.includes('## Parsed from string'), 'Should parse JSON string input');
  });

  it('handles non-JSON string as single item with content', () => {
    const plainText = 'Just a plain text string, not JSON';
    const md = formatAsMarkdown(plainText);

    assert.ok(md.includes(plainText), 'Should include the plain text as content');
  });
});
