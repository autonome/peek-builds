/**
 * Unit tests for renderer/cmd/noun-registry.js — pure command generation from noun definitions
 *
 * Tests generateCommandsFromNoun() and validateNounDef() logic.
 * These are logic-only tests — no DOM, no Electron, no extensions runtime.
 *
 * The module is plain ES-module JS with no imports and no window/document access, so it loads
 * directly. The path is computed rather than statically imported because a `main/*.test.ts` has
 * no `allowJs` and no declaration file for the renderer tree.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { validateNounDef, generateCommandsFromNoun } = await import(
  resolve(projectRoot, 'renderer', 'cmd', 'noun-registry.js')
);

// ============================================================================
// validateNounDef tests
// ============================================================================

describe('validateNounDef', () => {
  it('valid with name + singular + query', () => {
    const result = validateNounDef({ name: 'tags', singular: 'tag', hasQuery: true });
    assert.deepStrictEqual(result, { valid: true });
  });

  it('valid with name + singular + browse', () => {
    const result = validateNounDef({ name: 'feeds', singular: 'feed', hasBrowse: true });
    assert.deepStrictEqual(result, { valid: true });
  });

  it('valid with name + singular + create', () => {
    const result = validateNounDef({ name: 'notes', singular: 'note', hasCreate: true });
    assert.deepStrictEqual(result, { valid: true });
  });

  it('invalid without name', () => {
    const result = validateNounDef({ singular: 'tag', hasQuery: true });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('name'));
  });

  it('invalid without singular', () => {
    const result = validateNounDef({ name: 'tags', hasQuery: true });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('singular'));
  });

  it('invalid without any capability', () => {
    const result = validateNounDef({ name: 'tags', singular: 'tag' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('capability'));
  });
});

// ============================================================================
// generateCommandsFromNoun tests
// ============================================================================

describe('generateCommandsFromNoun', () => {
  it('generates all 5 commands for full capability noun', () => {
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      description: 'Saved tab groups',
      hasQuery: true,
      hasBrowse: true,
      hasOpen: true,
      hasCreate: true,
    });

    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, [
      'groups',        // bare (browse wins)
      'list groups',
      'open groups',
      'open group',
      'new group',
    ]);
  });

  it('bare noun uses browse when both browse and query exist', () => {
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      hasQuery: true,
      hasBrowse: true,
    });

    const bare = cmds.find((c: any) => c.name === 'groups');
    assert.strictEqual(bare?._nounCapability, 'browse');
  });

  it('bare noun uses query when only query exists', () => {
    const cmds = generateCommandsFromNoun({
      name: 'items',
      singular: 'item',
      hasQuery: true,
    });

    const bare = cmds.find((c: any) => c.name === 'items');
    assert.strictEqual(bare?._nounCapability, 'query');
  });

  it('skipBare suppresses bare noun command but not list/open', () => {
    const cmds = generateCommandsFromNoun({
      name: 'tags',
      singular: 'tag',
      hasQuery: true,
      hasBrowse: true,
      skipBare: true,
    });

    const names = cmds.map((c: any) => c.name);
    assert.ok(!names.includes('tags'), 'bare "tags" should be suppressed');
    assert.ok(names.includes('list tags'), 'list tags should exist');
    assert.ok(names.includes('open tags'), 'open tags should exist');
  });

  it('open singular requires both query and open', () => {
    // Only open, no query — should NOT generate "open group"
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      hasOpen: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.ok(!names.includes('open group'));
  });

  it('passes through produces, params, modes, source', () => {
    const cmds = generateCommandsFromNoun({
      name: 'feeds',
      singular: 'feed',
      source: 'ext:feeds',
      hasQuery: true,
      produces: 'application/rss+xml',
      params: [{ type: 'tag', multiple: true }],
      modes: ['reader'],
    });

    const listCmd = cmds.find((c: any) => c.name === 'list feeds');
    assert.ok(listCmd);
    assert.strictEqual(listCmd.source, 'ext:feeds');
    assert.deepStrictEqual(listCmd.produces, ['application/rss+xml']);
    assert.deepStrictEqual(listCmd.params, [{ type: 'tag', multiple: true }]);
    assert.deepStrictEqual(listCmd.modes, ['reader']);
  });

  it('no capabilities generates no commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'empty',
      singular: 'empt',
    });
    assert.strictEqual(cmds.length, 0);
  });

  it('query-only noun generates bare + list (no open/new)', () => {
    const cmds = generateCommandsFromNoun({
      name: 'logs',
      singular: 'log',
      hasQuery: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['logs', 'list logs']);
  });

  it('browse-only noun generates bare + open (no list/new)', () => {
    const cmds = generateCommandsFromNoun({
      name: 'settings',
      singular: 'setting',
      hasBrowse: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['settings', 'open settings']);
  });

  it('create-only noun generates only new', () => {
    const cmds = generateCommandsFromNoun({
      name: 'notes',
      singular: 'note',
      hasCreate: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['new note']);
  });

  it('all generated commands have _nounName set', () => {
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      hasQuery: true,
      hasBrowse: true,
      hasOpen: true,
      hasCreate: true,
    });

    for (const cmd of cmds) {
      assert.strictEqual(cmd._nounName, 'groups');
    }
  });

  it('default produces is application/json for query commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'items',
      singular: 'item',
      hasQuery: true,
    });

    const listCmd = cmds.find((c: any) => c.name === 'list items');
    assert.deepStrictEqual(listCmd?.produces, ['application/json']);
  });
});

// ============================================================================
// Real-world extension migration tests
// Verify the exact command sets generated for each converted extension
// ============================================================================

describe('generateCommandsFromNoun — extension migrations', () => {

  it('tags noun (skipBare + query + browse) → list tags, open tags', () => {
    const cmds = generateCommandsFromNoun({
      name: 'tags',
      singular: 'tag',
      description: 'Tags for organizing items',
      skipBare: true,
      hasQuery: true,
      hasBrowse: true,
      produces: 'application/json',
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['list tags', 'open tags']);
    // list tags should produce JSON
    assert.deepStrictEqual(cmds[0].produces, ['application/json']);
    // open tags should have browse capability
    assert.strictEqual(cmds[1]._nounCapability, 'browse');
  });

  it('groups noun (all 4 capabilities) → 5 commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      description: 'Saved tab groups',
      hasQuery: true,
      hasBrowse: true,
      hasOpen: true,
      hasCreate: true,
      produces: 'application/json',
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, [
      'groups', 'list groups', 'open groups', 'open group', 'new group'
    ]);
    assert.strictEqual(cmds[0]._nounCapability, 'browse'); // bare → browse
    assert.strictEqual(cmds[3]._nounCapability, 'open');    // open group → open
    assert.strictEqual(cmds[4]._nounCapability, 'create');  // new group → create
  });

  it('feeds noun (query + browse + create) → 4 commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'feeds',
      singular: 'feed',
      description: 'RSS/Atom feed subscriptions',
      hasQuery: true,
      hasBrowse: true,
      hasCreate: true,
      produces: 'application/json',
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, [
      'feeds', 'list feeds', 'open feeds', 'new feed'
    ]);
    assert.strictEqual(cmds[0]._nounCapability, 'browse');
    assert.strictEqual(cmds[3]._nounCapability, 'create');
  });

  it('entities noun (skipBare + query + browse) → list entities, open entities', () => {
    const cmds = generateCommandsFromNoun({
      name: 'entities',
      singular: 'entity',
      description: 'Extracted people, places, organizations',
      skipBare: true,
      hasQuery: true,
      hasBrowse: true,
      produces: 'application/json',
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['list entities', 'open entities']);
  });

  it('scripts noun (all 4 capabilities) → 5 commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'scripts',
      singular: 'script',
      description: 'Userscripts and content scripts',
      hasQuery: true,
      hasBrowse: true,
      hasOpen: true,
      hasCreate: true,
      produces: 'application/json',
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, [
      'scripts', 'list scripts', 'open scripts', 'open script', 'new script'
    ]);
  });

  it('pagestream noun (browse only) → 2 commands', () => {
    const cmds = generateCommandsFromNoun({
      name: 'pagestream',
      singular: 'pagestream',
      description: 'Browsing history stream',
      hasBrowse: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['pagestream', 'open pagestream']);
    assert.strictEqual(cmds[0]._nounCapability, 'browse');
    assert.strictEqual(cmds[1]._nounCapability, 'browse');
  });

  it('editor noun (skipBare + browse only) → open editor', () => {
    const cmds = generateCommandsFromNoun({
      name: 'editor',
      singular: 'editor',
      description: 'Markdown editor',
      skipBare: true,
      hasBrowse: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.deepStrictEqual(names, ['open editor']);
    assert.strictEqual(cmds[0]._nounCapability, 'browse');
  });
});

// ============================================================================
// Edge cases and consistency tests
// ============================================================================

describe('generateCommandsFromNoun — edge cases', () => {

  it('same singular and plural still generates correct commands', () => {
    // pagestream uses same word for both
    const cmds = generateCommandsFromNoun({
      name: 'pagestream',
      singular: 'pagestream',
      hasBrowse: true,
      hasQuery: true,
    });
    const names = cmds.map((c: any) => c.name);
    // "open pagestream" appears only once (not duplicated by open {name} and open {singular})
    assert.deepStrictEqual(names, ['pagestream', 'list pagestream', 'open pagestream']);
  });

  it('browse-only with skipBare generates only open command', () => {
    const cmds = generateCommandsFromNoun({
      name: 'editor',
      singular: 'editor',
      skipBare: true,
      hasBrowse: true,
    });
    assert.strictEqual(cmds.length, 1);
    assert.strictEqual(cmds[0].name, 'open editor');
  });

  it('create with custom produces propagates to new command', () => {
    const cmds = generateCommandsFromNoun({
      name: 'feeds',
      singular: 'feed',
      hasCreate: true,
      produces: 'application/rss+xml',
    });
    const newCmd = cmds.find((c: any) => c.name === 'new feed');
    assert.ok(newCmd);
    assert.deepStrictEqual(newCmd.produces, ['application/rss+xml']);
  });

  it('create without produces generates empty produces', () => {
    const cmds = generateCommandsFromNoun({
      name: 'tasks',
      singular: 'task',
      hasCreate: true,
    });
    const newCmd = cmds.find((c: any) => c.name === 'new task');
    assert.ok(newCmd);
    assert.deepStrictEqual(newCmd.produces, []);
  });

  it('open singular not generated when only open (no query)', () => {
    // open {singular} requires query+open because you need query to resolve the name
    const cmds = generateCommandsFromNoun({
      name: 'feeds',
      singular: 'feed',
      hasOpen: true,
      hasBrowse: true,
    });
    const names = cmds.map((c: any) => c.name);
    assert.ok(!names.includes('open feed'), 'open feed should not exist without query');
    assert.ok(names.includes('open feeds'), 'open feeds should exist from browse');
  });

  it('all commands have consistent accepts: empty array', () => {
    const cmds = generateCommandsFromNoun({
      name: 'groups',
      singular: 'group',
      hasQuery: true,
      hasBrowse: true,
      hasOpen: true,
      hasCreate: true,
    });
    for (const cmd of cmds) {
      assert.deepStrictEqual(cmd.accepts, []);
    }
  });
});
