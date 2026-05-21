/**
 * Schema drift detector for Peek MCP.
 *
 * The MCP server in this directory issues SQL directly against the columns
 * of items/tags/item_tags/item_events. The canonical schema for those tables
 * is owned by `packages/packages/schema/v1.json` (consumed by the Electron app at startup via
 * `validateSyncSchema`). If a column the MCP writes to is removed or renamed
 * in v1.json, this test fails — before users hit a runtime "no such column"
 * error.
 *
 * What this catches:
 *   - column rename / removal in v1.json that breaks MCP writes
 *   - addition of a NOT NULL column in v1.json that MCP doesn't populate
 *
 * What this doesn't catch:
 *   - behavioral drift (frecency formula changes, soft-delete semantics
 *     changes, etc.). Those are covered by the policy-parity tests in
 *     server.test.js — they assert MCP behavior matches a snapshot of the
 *     app's policy at the time the tests were written. If the app diverges,
 *     those tests keep passing while MCP silently differs from the app.
 *     The longer-term fix is in Peek task 14efdd97.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', '..', '..', '..', 'packages', 'schema', 'v1.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

// Columns the MCP's db.js writes to or filters on. If you add a new column
// write in db.js, add it here too — the test asserts the column exists in
// packages/schema/v1.json. Read-only columns (returned in SELECTs but never written)
// are not listed; their drift surfaces as JS undefined, which is benign.
const MCP_TOUCHED_COLUMNS = {
  items: [
    'id', 'type', 'content', 'title', 'domain', 'metadata',
    'createdAt', 'updatedAt', 'deletedAt',
    // referenced via WHERE/ORDER BY:
    'starred', 'archived', 'visitCount', 'lastVisitAt',
    'frecencyScore', 'mimeType', 'favicon',
  ],
  tags: [
    'id', 'name', 'slug', 'frequency', 'lastUsed',
    'frecencyScore', 'createdAt', 'updatedAt',
    // returned in list_tags:
    'color', 'description',
  ],
  item_tags: ['id', 'itemId', 'tagId', 'createdAt'],
  item_events: ['id', 'itemId', 'content', 'value', 'occurredAt', 'metadata', 'createdAt'],
};

// Indexes the MCP's db.js relies on. If packages/schema/v1.json drops one of these (or
// changes its uniqueness), the MCP's SQL stops behaving correctly — e.g.
// without idx_tags_name_unique the ON CONFLICT(name) upsert in tagItemInTx
// raises "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
// constraint" at runtime, silently breaking every tag operation.
const MCP_REQUIRED_INDEXES = {
  tags: [
    // Each entry: [name, { unique?: true, columns: [...] }]
    ['idx_tags_name_unique', { unique: true, columns: ['name'] }],
  ],
};

describe('schema drift between MCP and packages/schema/v1.json', () => {
  for (const [table, columns] of Object.entries(MCP_TOUCHED_COLUMNS)) {
    describe(`table: ${table}`, () => {
      it(`is defined in v1.json`, () => {
        assert.ok(schema.tables[table], `packages/schema/v1.json missing table "${table}"`);
      });

      for (const col of columns) {
        it(`column "${col}" exists in v1.json`, () => {
          const def = schema.tables[table]?.columns?.[col];
          assert.ok(def, `MCP writes to ${table}.${col} but packages/schema/v1.json has no such column`);
        });
      }
    });
  }

  it('every v1.json NOT NULL column without default is written by MCP createItem', () => {
    // Sanity check the other direction: if v1.json adds a NOT NULL column
    // with no default, the MCP's createItem will start failing inserts.
    // This test surfaces the new column before that happens.
    const itemCols = schema.tables.items?.columns || {};
    const required = Object.entries(itemCols)
      .filter(([_, c]) => c.not_null && c.default === undefined && !c.primary_key)
      .map(([name]) => name);

    // Columns createItem currently writes:
    const written = new Set([
      'id', 'type', 'content', 'title', 'domain', 'metadata',
      'createdAt', 'updatedAt', 'deletedAt',
    ]);

    const missing = required.filter(c => !written.has(c));
    assert.deepEqual(
      missing, [],
      `v1.json requires items columns that MCP createItem doesn't write: ${missing.join(', ')}. ` +
      `Update createItem in db.js to populate them.`
    );
  });

  describe('required indexes', () => {
    for (const [table, indexes] of Object.entries(MCP_REQUIRED_INDEXES)) {
      for (const [indexName, expected] of indexes) {
        it(`${table}.${indexName} is defined in v1.json with expected shape`, () => {
          const tableDef = schema.tables[table];
          assert.ok(tableDef, `packages/schema/v1.json missing table "${table}"`);
          const defs = tableDef.indexes || [];
          const def = defs.find(d => d.name === indexName);
          assert.ok(
            def,
            `MCP relies on index ${table}.${indexName} but packages/schema/v1.json has no such index. ` +
            `Removing it breaks SQL paths in features/mcp-server/db.js.`
          );
          if (expected.unique) {
            assert.equal(
              def.unique, true,
              `${table}.${indexName} must be unique in packages/schema/v1.json — MCP uses ON CONFLICT against it.`
            );
          }
          if (expected.columns) {
            assert.deepEqual(
              def.columns, expected.columns,
              `${table}.${indexName} columns must be ${JSON.stringify(expected.columns)} in packages/schema/v1.json.`
            );
          }
        });
      }
    }
  });
});
