/**
 * Regression test for migrateTinyBaseData() migration bug
 *
 * Bug: migrateTinyBaseData() queries the `addresses` table without first
 * checking if it exists. If the `tinybase` table exists but `addresses`
 * doesn't, this crashes with "SqliteError: no such table: addresses".
 *
 * This test creates in-memory databases simulating legacy states and
 * verifies the migration logic handles all cases correctly.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --test packages/integration-tests/migration-regression.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

/**
 * Simulates the migrateTinyBaseData() logic from datastore.ts.
 * This is extracted so we can test both the buggy and fixed versions.
 */
function migrateTinyBaseDataFixed(db) {
  // Check if tinybase table exists
  const tinybaseExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tinybase'`)
    .get();

  if (!tinybaseExists) {
    return { status: 'no-tinybase' };
  }

  // THE FIX: Check if addresses table exists before querying it
  const addressesExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'`)
    .get();

  if (!addressesExists) {
    return { status: 'no-addresses' };
  }

  // Check if we already migrated
  const existingData = db.prepare('SELECT COUNT(*) as count FROM addresses').get();
  if (existingData.count > 0) {
    return { status: 'already-migrated' };
  }

  // Perform migration from tinybase JSON
  const tinybaseRow = db.prepare('SELECT * FROM tinybase').get();
  if (!tinybaseRow) {
    return { status: 'no-data' };
  }

  const rawData = Object.values(tinybaseRow)[1];
  if (!rawData) {
    return { status: 'empty-data' };
  }

  const [tables] = JSON.parse(rawData);
  if (!tables) {
    return { status: 'no-tables' };
  }

  const tablesToMigrate = [
    'addresses', 'visits', 'tags', 'address_tags', 'feature_settings',
    'extensions', 'content', 'blobs', 'scripts_data', 'feeds',
  ];

  let migratedRows = 0;
  for (const tableName of tablesToMigrate) {
    const tableData = tables[tableName];
    if (!tableData || typeof tableData !== 'object') continue;

    const entries = Object.entries(tableData);
    if (entries.length === 0) continue;

    for (const [id, row] of entries) {
      try {
        const fullRow = { id, ...row };
        const columns = Object.keys(fullRow);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => fullRow[col]);

        db.prepare(
          `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`
        ).run(...values);
        migratedRows++;
      } catch (err) {
        // Silently skip rows that fail (matches production behavior)
      }
    }
  }

  db.exec('DROP TABLE IF EXISTS tinybase');
  return { status: 'migrated', migratedRows };
}

/**
 * Simulates the BUGGY version (no addresses table check)
 */
function migrateTinyBaseDataBuggy(db) {
  const tinybaseExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tinybase'`)
    .get();

  if (!tinybaseExists) {
    return { status: 'no-tinybase' };
  }

  // BUG: No check for addresses table existence — this line throws
  const existingData = db.prepare('SELECT COUNT(*) as count FROM addresses').get();
  if (existingData.count > 0) {
    return { status: 'already-migrated' };
  }

  return { status: 'would-migrate' };
}

/**
 * Create legacy schema tables (pre-items migration, circa Jan 2026)
 */
function createLegacySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id TEXT PRIMARY KEY,
      url TEXT,
      title TEXT,
      createdAt INTEGER DEFAULT 0,
      updatedAt INTEGER DEFAULT 0,
      syncedAt INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      addressId TEXT,
      visitedAt INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT,
      frequency INTEGER DEFAULT 0,
      lastUsed INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT 0,
      updatedAt INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS address_tags (
      addressId TEXT,
      tagId TEXT,
      PRIMARY KEY (addressId, tagId)
    );
  `);
}

function createTinybaseTable(db, data) {
  db.exec(`CREATE TABLE IF NOT EXISTS tinybase (id TEXT PRIMARY KEY, data TEXT)`);
  if (data) {
    db.prepare('INSERT INTO tinybase (id, data) VALUES (?, ?)').run('store', JSON.stringify(data));
  }
}

describe('migrateTinyBaseData regression', () => {

  it('BUG REPRODUCTION: buggy version crashes when tinybase exists but addresses does not', () => {
    const db = new Database(':memory:');

    // Create tinybase table with some data, but NO addresses table
    const tinybaseData = [
      { addresses: { 'addr-1': { url: 'https://example.com', title: 'Example' } } },
    ];
    createTinybaseTable(db, tinybaseData);

    // The buggy version should throw "no such table: addresses"
    assert.throws(
      () => migrateTinyBaseDataBuggy(db),
      (err) => {
        return err.message.includes('no such table: addresses');
      },
      'Expected buggy version to throw "no such table: addresses"'
    );

    db.close();
  });

  it('FIXED: handles tinybase exists but addresses table does not', () => {
    const db = new Database(':memory:');

    // Create tinybase table with some data, but NO addresses table
    const tinybaseData = [
      { addresses: { 'addr-1': { url: 'https://example.com', title: 'Example' } } },
    ];
    createTinybaseTable(db, tinybaseData);

    // The fixed version should return gracefully
    const result = migrateTinyBaseDataFixed(db);
    assert.strictEqual(result.status, 'no-addresses');

    db.close();
  });

  it('returns early when no tinybase table exists', () => {
    const db = new Database(':memory:');

    const result = migrateTinyBaseDataFixed(db);
    assert.strictEqual(result.status, 'no-tinybase');

    db.close();
  });

  it('returns already-migrated when addresses table has data', () => {
    const db = new Database(':memory:');

    createLegacySchema(db);
    createTinybaseTable(db, [{ addresses: {} }]);

    // Insert existing data into addresses
    db.prepare('INSERT INTO addresses (id, url, title) VALUES (?, ?, ?)').run(
      'existing-1', 'https://existing.com', 'Existing'
    );

    const result = migrateTinyBaseDataFixed(db);
    assert.strictEqual(result.status, 'already-migrated');

    db.close();
  });

  it('successfully migrates tinybase data into legacy tables', () => {
    const db = new Database(':memory:');

    createLegacySchema(db);

    const tinybaseData = [
      {
        addresses: {
          'addr-1': { url: 'https://example.com', title: 'Example' },
          'addr-2': { url: 'https://test.org', title: 'Test' },
        },
        tags: {
          'tag-1': { name: 'dev', frequency: 5 },
        },
        visits: {
          'visit-1': { addressId: 'addr-1', visitedAt: 1700000000 },
        },
      },
    ];
    createTinybaseTable(db, tinybaseData);

    const result = migrateTinyBaseDataFixed(db);
    assert.strictEqual(result.status, 'migrated');
    assert.strictEqual(result.migratedRows, 4); // 2 addresses + 1 tag + 1 visit

    // Verify data was migrated
    const addresses = db.prepare('SELECT * FROM addresses').all();
    assert.strictEqual(addresses.length, 2);
    assert.strictEqual(addresses[0].url, 'https://example.com');

    const tags = db.prepare('SELECT * FROM tags').all();
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].name, 'dev');

    // Verify tinybase table was dropped
    const tinybaseStillExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tinybase'`)
      .get();
    assert.strictEqual(tinybaseStillExists, undefined);

    db.close();
  });

  it('handles empty tinybase row gracefully', () => {
    const db = new Database(':memory:');

    createLegacySchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS tinybase (id TEXT PRIMARY KEY, data TEXT)`);
    // Insert row with no data
    db.prepare('INSERT INTO tinybase (id, data) VALUES (?, ?)').run('store', '');

    const result = migrateTinyBaseDataFixed(db);
    assert.strictEqual(result.status, 'empty-data');

    db.close();
  });
});
