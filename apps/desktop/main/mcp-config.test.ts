/**
 * Unit tests for the pure MCP config-location migration helper.
 *
 * `applyMcpConfigMigration` moves a legacy `~/.claude/settings.json`
 * `mcpServers.peek` entry into `~/.claude.json` (Claude Code's real
 * user-scope file) and prunes the dead legacy entry. It's pure (no electron
 * `app`) so it runs under `electron --test dist/main/*.test.js` after build.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

// Import the electron-free migration module, NOT mcp-config.js — the latter
// does `import { app } from 'electron'`, which throws under
// ELECTRON_RUN_AS_NODE (the mode `electron --test` uses).
let mcpConfig: typeof import('./mcp-config-migration.js');

const PEEK = { command: 'node', args: ['--experimental-sqlite', '/x/server.js'], env: { PEEK_DB_PATH: '/db' } };

describe('applyMcpConfigMigration', () => {
  before(async () => {
    mcpConfig = await import('./mcp-config-migration.js');
  });

  it('moves a legacy peek entry into an empty target and prunes legacy', () => {
    const legacy = { mcpServers: { peek: PEEK } };
    const current = {};
    const { legacyOut, currentOut, changed } = mcpConfig.applyMcpConfigMigration(legacy, current);

    assert.equal(changed, true);
    // Moved into target.
    assert.deepStrictEqual((currentOut.mcpServers as Record<string, unknown>).peek, PEEK);
    // Legacy pruned — emptied mcpServers removed entirely.
    assert.ok(!('mcpServers' in legacyOut), 'empty legacy mcpServers should be removed');
  });

  it('preserves other legacy mcpServers when pruning peek', () => {
    const legacy = { mcpServers: { peek: PEEK, other: { command: 'y' } }, someKey: 1 };
    const current = {};
    const { legacyOut, currentOut, changed } = mcpConfig.applyMcpConfigMigration(legacy, current);

    assert.equal(changed, true);
    assert.deepStrictEqual((currentOut.mcpServers as Record<string, unknown>).peek, PEEK);
    // legacy keeps `other` and its unrelated top-level key, drops peek.
    const legacyServers = legacyOut.mcpServers as Record<string, unknown>;
    assert.ok(legacyServers.other, 'other server preserved');
    assert.ok(!('peek' in legacyServers), 'legacy peek pruned');
    assert.equal(legacyOut.someKey, 1, 'unrelated legacy key preserved');
  });

  it('keeps an existing target peek entry, still prunes legacy', () => {
    const targetPeek = { command: 'existing', env: {} };
    const legacy = { mcpServers: { peek: PEEK } };
    const current = { mcpServers: { peek: targetPeek }, oauthAccount: { id: 'keep' } };
    const { legacyOut, currentOut, changed } = mcpConfig.applyMcpConfigMigration(legacy, current);

    assert.equal(changed, true);
    // Target's own entry is respected (not overwritten by legacy).
    assert.deepStrictEqual((currentOut.mcpServers as Record<string, unknown>).peek, targetPeek);
    assert.deepStrictEqual(currentOut.oauthAccount, { id: 'keep' }, 'unrelated target key preserved');
    // Legacy still pruned.
    assert.ok(!('mcpServers' in legacyOut), 'legacy peek pruned even when target kept its own');
  });

  it('no-ops (changed:false) when legacy has no peek entry', () => {
    const legacy = { mcpServers: { other: { command: 'z' } } };
    const current = {};
    const { legacyOut, currentOut, changed } = mcpConfig.applyMcpConfigMigration(legacy, current);

    assert.equal(changed, false);
    assert.deepStrictEqual(currentOut, {}, 'target untouched');
    assert.deepStrictEqual(legacyOut, legacy, 'legacy untouched');
  });

  it('no-ops when legacy has no mcpServers at all', () => {
    const { changed } = mcpConfig.applyMcpConfigMigration({ foo: 1 }, {});
    assert.equal(changed, false);
  });

  it('is idempotent — a second pass finds no legacy peek', () => {
    const legacy = { mcpServers: { peek: PEEK } };
    const first = mcpConfig.applyMcpConfigMigration(legacy, {});
    // Feed the pruned legacy back in — nothing left to migrate.
    const second = mcpConfig.applyMcpConfigMigration(first.legacyOut, first.currentOut);
    assert.equal(second.changed, false);
  });
});

describe('planMcpConfigMigration', () => {
  before(async () => {
    mcpConfig = await import('./mcp-config-migration.js');
  });

  it('ABORTS when ~/.claude.json exists but is unparseable (never overwrites CC state)', () => {
    // currentObj===null with currentExists===true means the file is on disk
    // but failed to parse. Overwriting it would destroy Claude Code's auth/
    // state, so the plan must abort rather than write.
    const plan = mcpConfig.planMcpConfigMigration({
      legacyObj: { mcpServers: { peek: PEEK } },
      currentObj: null,
      currentExists: true,
    });
    assert.equal(plan.action, 'abort');
  });

  it('writes (starting from empty) when ~/.claude.json is absent', () => {
    // Absent file → currentObj null but currentExists false: safe to create.
    const plan = mcpConfig.planMcpConfigMigration({
      legacyObj: { mcpServers: { peek: PEEK } },
      currentObj: null,
      currentExists: false,
    });
    assert.equal(plan.action, 'write');
    if (plan.action === 'write') {
      assert.deepStrictEqual((plan.currentOut.mcpServers as Record<string, unknown>).peek, PEEK);
      assert.ok(!('mcpServers' in plan.legacyOut), 'legacy peek pruned');
    }
  });

  it('writes and merges into an existing valid ~/.claude.json', () => {
    const plan = mcpConfig.planMcpConfigMigration({
      legacyObj: { mcpServers: { peek: PEEK } },
      currentObj: { oauthAccount: { id: 'keep' } },
      currentExists: true,
    });
    assert.equal(plan.action, 'write');
    if (plan.action === 'write') {
      assert.deepStrictEqual(plan.currentOut.oauthAccount, { id: 'keep' }, 'unrelated CC state preserved');
      assert.deepStrictEqual((plan.currentOut.mcpServers as Record<string, unknown>).peek, PEEK);
    }
  });

  it('skips when legacy has no peek entry', () => {
    const plan = mcpConfig.planMcpConfigMigration({
      legacyObj: { mcpServers: { other: { command: 'z' } } },
      currentObj: {},
      currentExists: true,
    });
    assert.equal(plan.action, 'skip');
  });

  it('skips when legacy is unreadable (null)', () => {
    const plan = mcpConfig.planMcpConfigMigration({
      legacyObj: null,
      currentObj: {},
      currentExists: true,
    });
    assert.equal(plan.action, 'skip');
  });
});
