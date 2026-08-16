#!/usr/bin/env node
/**
 * Schema Fidelity Tests
 *
 * Verifies that all backend schema implementations match the canonical schema.
 * Run with: node packages/schema/fidelity.test.js
 *           yarn schema:test
 *
 * These tests:
 * 1. Parse CREATE TABLE statements from each backend
 * 2. Compare against required sync columns from packages/schema/v1.json
 * 3. Verify timestamp columns use INTEGER (not TEXT)
 * 4. Verify id columns use TEXT (not INTEGER)
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { test, describe, before } from 'node:test';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load canonical schema
const schema = JSON.parse(readFileSync(join(__dirname, 'v1.json'), 'utf-8'));
const REQUIRED_SYNC_COLUMNS = schema.validation.required_sync_columns;

// apps/tauri-desktop is paused as a project (see apps/tauri-desktop/CLAUDE.md).
// Its fidelity checks are skipped rather than enforced until the project resumes.
const TAURI_DESKTOP_PAUSED = 'apps/tauri-desktop is paused; see apps/tauri-desktop/CLAUDE.md';

/**
 * Parse CREATE TABLE statements and extract column info
 */
function parseCreateTable(sql, tableName) {
  // Find the CREATE TABLE statement for this table
  const regex = new RegExp(
    `CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${tableName}\\s*\\(([^;]+)\\)`,
    'i'
  );
  const match = sql.match(regex);
  if (!match) return null;

  const columnsStr = match[1];
  const columns = {};

  // Split by comma, but be careful about CHECK constraints that contain commas
  const lines = [];
  let depth = 0;
  let current = '';
  for (const char of columnsStr) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      lines.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) lines.push(current.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip constraints (PRIMARY KEY, FOREIGN KEY, etc.)
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)/i.test(trimmed)) continue;

    // Parse column: name TYPE [constraints]
    const colMatch = trimmed.match(/^(\w+)\s+(\w+)/);
    if (colMatch) {
      const [, colName, colType] = colMatch;
      columns[colName] = {
        name: colName,
        type: colType.toUpperCase(),
        definition: trimmed,
      };
    }
  }

  return columns;
}

/**
 * Read schema from Electron datastore.ts
 */
function getElectronSchema() {
  const path = join(__dirname, '../../apps/desktop/main/datastore.ts');
  return readFileSync(path, 'utf-8');
}

/**
 * Read schema from Server db.js
 */
function getServerSchema() {
  const path = join(__dirname, '../../apps/server/db.js');
  return readFileSync(path, 'utf-8');
}

/**
 * Read schema from Tauri Desktop datastore.rs
 */
function getTauriDesktopSchema() {
  const path = join(__dirname, '../../apps/tauri-desktop/src-tauri/src/datastore.rs');
  return readFileSync(path, 'utf-8');
}

/**
 * Read schema from Tauri Mobile lib.rs
 */
function getTauriMobileSchema() {
  const path = join(__dirname, '../../apps/mobile/src-tauri/src/lib.rs');
  return readFileSync(path, 'utf-8');
}

// ==================== Tests ====================

describe('Schema Fidelity Tests', () => {
  let electronSql;
  let serverSql;
  let tauriDesktopSql;
  let tauriMobileSql;

  before(() => {
    electronSql = getElectronSchema();
    serverSql = getServerSchema();
    tauriDesktopSql = getTauriDesktopSchema();
    tauriMobileSql = getTauriMobileSchema();
  });

  describe('Electron Backend', () => {
    for (const [tableName, requiredCols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
      test(`${tableName} has all required sync columns`, () => {
        const columns = parseCreateTable(electronSql, tableName);
        assert.ok(columns, `Table ${tableName} not found in Electron schema`);

        const missing = requiredCols.filter(col => !columns[col]);
        assert.deepStrictEqual(missing, [], `Missing columns in Electron ${tableName}: ${missing.join(', ')}`);
      });
    }

    test('items.createdAt is INTEGER', () => {
      const columns = parseCreateTable(electronSql, 'items');
      assert.ok(columns, 'Table items not found');
      assert.ok(columns.createdAt, 'Column createdAt not found');
      assert.strictEqual(columns.createdAt.type, 'INTEGER', 'createdAt should be INTEGER');
    });

    test('items.id is TEXT', () => {
      const columns = parseCreateTable(electronSql, 'items');
      assert.ok(columns, 'Table items not found');
      assert.ok(columns.id, 'Column id not found');
      assert.strictEqual(columns.id.type, 'TEXT', 'id should be TEXT');
    });

    test('tags.id is TEXT (not INTEGER)', () => {
      const columns = parseCreateTable(electronSql, 'tags');
      assert.ok(columns, 'Table tags not found');
      assert.ok(columns.id, 'Column id not found');
      assert.strictEqual(columns.id.type, 'TEXT', 'tags.id should be TEXT (not INTEGER AUTOINCREMENT)');
    });

    test('item_tags.tagId is TEXT', () => {
      const columns = parseCreateTable(electronSql, 'item_tags');
      assert.ok(columns, 'Table item_tags not found');
      assert.ok(columns.tagId, 'Column tagId not found');
      assert.strictEqual(columns.tagId.type, 'TEXT', 'tagId should be TEXT');
    });
  });

  describe('Server Backend', () => {
    for (const [tableName, requiredCols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
      test(`${tableName} has all required sync columns`, () => {
        const columns = parseCreateTable(serverSql, tableName);
        assert.ok(columns, `Table ${tableName} not found in Server schema`);

        const missing = requiredCols.filter(col => !columns[col]);
        assert.deepStrictEqual(missing, [], `Missing columns in Server ${tableName}: ${missing.join(', ')}`);
      });
    }

    test('items.createdAt is INTEGER', () => {
      const columns = parseCreateTable(serverSql, 'items');
      assert.ok(columns, 'Table items not found');
      assert.ok(columns.createdAt, 'Column createdAt not found');
      assert.strictEqual(columns.createdAt.type, 'INTEGER', 'createdAt should be INTEGER');
    });

    test('tags.id is TEXT', () => {
      const columns = parseCreateTable(serverSql, 'tags');
      assert.ok(columns, 'Table tags not found');
      assert.ok(columns.id, 'Column id not found');
      assert.strictEqual(columns.id.type, 'TEXT', 'tags.id should be TEXT');
    });
  });

  describe('Tauri Desktop Backend', () => {
    for (const [tableName, requiredCols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
      test(`${tableName} has all required sync columns`, { skip: TAURI_DESKTOP_PAUSED }, () => {
        const columns = parseCreateTable(tauriDesktopSql, tableName);
        assert.ok(columns, `Table ${tableName} not found in Tauri Desktop schema`);

        const missing = requiredCols.filter(col => !columns[col]);
        assert.deepStrictEqual(missing, [], `Missing columns in Tauri Desktop ${tableName}: ${missing.join(', ')}`);
      });
    }

    test('items.createdAt is INTEGER', { skip: TAURI_DESKTOP_PAUSED }, () => {
      const columns = parseCreateTable(tauriDesktopSql, 'items');
      assert.ok(columns, 'Table items not found');
      assert.ok(columns.createdAt, 'Column createdAt not found');
      assert.strictEqual(columns.createdAt.type, 'INTEGER', 'createdAt should be INTEGER');
    });

    test('tags.id is TEXT', { skip: TAURI_DESKTOP_PAUSED }, () => {
      const columns = parseCreateTable(tauriDesktopSql, 'tags');
      assert.ok(columns, 'Table tags not found');
      assert.ok(columns.id, 'Column id not found');
      assert.strictEqual(columns.id.type, 'TEXT', 'tags.id should be TEXT');
    });
  });

  // NOTE: Tauri Mobile has known schema drift - these tests document the current state
  // and will fail until mobile schema migration is implemented
  describe('Tauri Mobile Backend (KNOWN DRIFT)', () => {
    test('items table exists', () => {
      const columns = parseCreateTable(tauriMobileSql, 'items');
      assert.ok(columns, 'Table items not found in Tauri Mobile schema');
    });

    // Document the known drift - mobile uses snake_case. These are not real checks
    // (they assert nothing about pass/fail), so they're skipped rather than left as
    // always-true tests that would mask a real regression going unnoticed.
    test('items uses snake_case columns (KNOWN DRIFT)', { skip: 'known drift, not enforced - see describe block name' }, () => {
      const columns = parseCreateTable(tauriMobileSql, 'items');
      assert.ok(columns, 'Table items not found');

      // Mobile has snake_case, should have camelCase
      const hasSnakeCase = columns.sync_id || columns.created_at || columns.deleted_at;
      const hasCamelCase = columns.syncId && columns.createdAt && columns.deletedAt;

      if (hasSnakeCase && !hasCamelCase) {
        console.log('    [DRIFT] Mobile uses snake_case (sync_id, created_at) instead of camelCase');
      }
    });

    test('items uses TEXT timestamps (KNOWN DRIFT)', { skip: 'known drift, not enforced - see describe block name' }, () => {
      const columns = parseCreateTable(tauriMobileSql, 'items');
      assert.ok(columns, 'Table items not found');

      const timestampCol = columns.created_at || columns.createdAt;
      if (timestampCol && timestampCol.type === 'TEXT') {
        console.log('    [DRIFT] Mobile uses TEXT timestamps instead of INTEGER');
      }
    });

    test('tags.id is INTEGER (KNOWN DRIFT - should be TEXT)', { skip: 'known drift, not enforced - see describe block name' }, () => {
      const columns = parseCreateTable(tauriMobileSql, 'tags');
      assert.ok(columns, 'Table tags not found');
      assert.ok(columns.id, 'Column id not found');

      if (columns.id.type === 'INTEGER') {
        console.log('    [DRIFT] Mobile tags.id is INTEGER AUTOINCREMENT, should be TEXT UUID');
      }
    });
  });

  describe('Generated Schema Consistency', () => {
    test('sqlite-sync.sql matches canonical schema', () => {
      const generatedSql = readFileSync(join(__dirname, 'generated/sqlite-sync.sql'), 'utf-8');

      for (const [tableName, requiredCols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
        const columns = parseCreateTable(generatedSql, tableName);
        assert.ok(columns, `Table ${tableName} not found in generated SQL`);

        const missing = requiredCols.filter(col => !columns[col]);
        assert.deepStrictEqual(missing, [], `Missing columns in generated ${tableName}: ${missing.join(', ')}`);
      }
    });

    test('generated types.ts exports REQUIRED_SYNC_COLUMNS', () => {
      const typesTs = readFileSync(join(__dirname, 'generated/types.ts'), 'utf-8');
      assert.ok(typesTs.includes('REQUIRED_SYNC_COLUMNS'), 'types.ts should export REQUIRED_SYNC_COLUMNS');
    });

    test('generated validate.js has validateSyncSchema function', () => {
      const validateJs = readFileSync(join(__dirname, 'generated/validate.js'), 'utf-8');
      assert.ok(validateJs.includes('validateSyncSchema'), 'validate.js should export validateSyncSchema');
      assert.ok(validateJs.includes('assertValidSyncSchema'), 'validate.js should export assertValidSyncSchema');
    });
  });

  describe('CHECK Constraint Validation', () => {
    /**
     * Parse CHECK constraint values from a type IN (...) expression.
     * Returns sorted array of allowed values, or null if no CHECK found.
     */
    function parseCheckValues(sql, tableName, columnName) {
      const columns = parseCreateTable(sql, tableName);
      if (!columns || !columns[columnName]) return null;
      const def = columns[columnName].definition;
      const match = def.match(/CHECK\s*\(\s*\w+\s+IN\s*\(([^)]+)\)\s*\)/i);
      if (!match) return null;
      return match[1].split(',').map(v => v.trim().replace(/'/g, '')).sort();
    }

    /**
     * Parse CHECK constraint values from v1.json schema definition.
     */
    function parseSchemaCheckValues(tableName, columnName) {
      const table = schema.tables[tableName];
      if (!table) return null;
      const col = table.columns[columnName];
      if (!col || !col.check) return null;
      const match = col.check.match(/\w+\s+IN\s*\(([^)]+)\)/i);
      if (!match) return null;
      return match[1].split(',').map(v => v.trim().replace(/'/g, '')).sort();
    }

    test('items.type CHECK values match between v1.json and Electron', () => {
      const schemaValues = parseSchemaCheckValues('items', 'type');
      const electronValues = parseCheckValues(electronSql, 'items', 'type');

      assert.ok(schemaValues, 'v1.json items.type should have a CHECK constraint');
      assert.ok(electronValues, 'Electron items.type should have a CHECK constraint');
      assert.deepStrictEqual(
        electronValues,
        schemaValues,
        `items.type CHECK values diverged:\n  v1.json:   [${schemaValues.join(', ')}]\n  Electron:  [${electronValues.join(', ')}]`
      );
    });

    test('items.type CHECK values match between v1.json and Server', () => {
      const schemaValues = parseSchemaCheckValues('items', 'type');
      const serverValues = parseCheckValues(serverSql, 'items', 'type');

      assert.ok(schemaValues, 'v1.json items.type should have a CHECK constraint');
      assert.ok(serverValues, 'Server items.type should have a CHECK constraint');
      assert.deepStrictEqual(
        serverValues,
        schemaValues,
        `items.type CHECK values diverged:\n  v1.json:  [${schemaValues.join(', ')}]\n  Server:   [${serverValues.join(', ')}]`
      );
    });

    test('items.type CHECK values match between v1.json and generated SQL', () => {
      const schemaValues = parseSchemaCheckValues('items', 'type');
      const generatedSql = readFileSync(join(__dirname, 'generated/sqlite-full.sql'), 'utf-8');
      const generatedValues = parseCheckValues(generatedSql, 'items', 'type');

      assert.ok(schemaValues, 'v1.json items.type should have a CHECK constraint');
      assert.ok(generatedValues, 'Generated SQL items.type should have a CHECK constraint');
      assert.deepStrictEqual(
        generatedValues,
        schemaValues,
        `items.type CHECK values diverged:\n  v1.json:    [${schemaValues.join(', ')}]\n  Generated:  [${generatedValues.join(', ')}]`
      );
    });

    test('ItemType in types/index.ts matches v1.json CHECK values', () => {
      const schemaValues = parseSchemaCheckValues('items', 'type');
      assert.ok(schemaValues, 'v1.json items.type should have a CHECK constraint');

      const typesTs = readFileSync(join(__dirname, '../../apps/desktop/types/index.ts'), 'utf-8');
      const match = typesTs.match(/export type ItemType\s*=\s*([^;]+);/);
      assert.ok(match, 'ItemType should be defined in types/index.ts');

      const tsValues = match[1].match(/'([^']+)'/g).map(v => v.replace(/'/g, '')).sort();
      assert.deepStrictEqual(
        tsValues,
        schemaValues,
        `ItemType diverged from v1.json:\n  v1.json:        [${schemaValues.join(', ')}]\n  types/index.ts: [${tsValues.join(', ')}]`
      );
    });
  });

  describe('Table Completeness', () => {
    test('all tables in Electron createTableStatements are in TypeScript TableName', () => {
      const typesTs = readFileSync(join(__dirname, '../../apps/desktop/types/index.ts'), 'utf-8');

      // Extract TableName union values
      const tableNameMatch = typesTs.match(/export type TableName\s*=([^;]+);/s);
      assert.ok(tableNameMatch, 'TableName type should be defined in types/index.ts');
      const tsTableNames = tableNameMatch[1].match(/'([^']+)'/g).map(v => v.replace(/'/g, ''));

      // Extract CREATE TABLE names from Electron datastore (skip migration temp tables).
      // Require the opening `(` of the column list so comments that mention
      // "CREATE TABLE IF NOT EXISTS above" etc. don't register as tables.
      const createTableRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
      const electronTables = new Set();
      let m;
      while ((m = createTableRegex.exec(electronSql)) !== null) {
        const name = m[1];
        // Skip temporary migration tables (contain _new, _mig, _old suffixes)
        if (/_new$|_mig$|_old$|_backup$/.test(name)) continue;
        // Skip context_history (created in migration, not createTableStatements)
        if (name === 'context_history') continue;
        electronTables.add(name);
      }

      const missingFromTypes = [...electronTables].filter(t => !tsTableNames.includes(t));
      assert.deepStrictEqual(
        missingFromTypes,
        [],
        `Tables in Electron but missing from TableName type: ${missingFromTypes.join(', ')}`
      );
    });

    test('tableNames array matches TableName union', () => {
      const typesTs = readFileSync(join(__dirname, '../../apps/desktop/types/index.ts'), 'utf-8');

      // Extract TableName union values
      const tableNameMatch = typesTs.match(/export type TableName\s*=([^;]+);/s);
      assert.ok(tableNameMatch, 'TableName type should be defined');
      const unionValues = tableNameMatch[1].match(/'([^']+)'/g).map(v => v.replace(/'/g, '')).sort();

      // Extract tableNames array values
      const arrayMatch = typesTs.match(/export const tableNames:\s*TableName\[\]\s*=\s*\[([^\]]+)\]/s);
      assert.ok(arrayMatch, 'tableNames array should be defined');
      const arrayValues = arrayMatch[1].match(/'([^']+)'/g).map(v => v.replace(/'/g, '')).sort();

      assert.deepStrictEqual(
        arrayValues,
        unionValues,
        `tableNames array does not match TableName union:\n  Union: [${unionValues.join(', ')}]\n  Array: [${arrayValues.join(', ')}]`
      );
    });
  });

  describe('Column Completeness', () => {
    test('Electron items table has all columns from v1.json', () => {
      const schemaColumns = Object.keys(schema.tables.items.columns);
      const electronCols = parseCreateTable(electronSql, 'items');
      assert.ok(electronCols, 'Table items not found in Electron');

      // Some columns may be added via migrations, so also search for ALTER TABLE ADD COLUMN
      const alterRegex = /ALTER TABLE items ADD COLUMN (\w+)/g;
      const migratedCols = new Set();
      let m;
      while ((m = alterRegex.exec(electronSql)) !== null) {
        migratedCols.add(m[1]);
      }

      const allElectronCols = new Set([...Object.keys(electronCols), ...migratedCols]);
      const missing = schemaColumns.filter(col => !allElectronCols.has(col));
      assert.deepStrictEqual(
        missing,
        [],
        `Columns in v1.json items but missing from Electron (CREATE TABLE + migrations): ${missing.join(', ')}`
      );
    });

    test('Electron tags table has all columns from v1.json', () => {
      const schemaColumns = Object.keys(schema.tables.tags.columns);
      const electronCols = parseCreateTable(electronSql, 'tags');
      assert.ok(electronCols, 'Table tags not found in Electron');

      const alterRegex = /ALTER TABLE tags ADD COLUMN (\w+)/g;
      const migratedCols = new Set();
      let m;
      while ((m = alterRegex.exec(electronSql)) !== null) {
        migratedCols.add(m[1]);
      }

      const allElectronCols = new Set([...Object.keys(electronCols), ...migratedCols]);
      const missing = schemaColumns.filter(col => !allElectronCols.has(col));
      assert.deepStrictEqual(
        missing,
        [],
        `Columns in v1.json tags but missing from Electron (CREATE TABLE + migrations): ${missing.join(', ')}`
      );
    });

    test('Electron item_tags table has all columns from v1.json', () => {
      const schemaColumns = Object.keys(schema.tables.item_tags.columns);
      const electronCols = parseCreateTable(electronSql, 'item_tags');
      assert.ok(electronCols, 'Table item_tags not found in Electron');

      const missing = schemaColumns.filter(col => !electronCols[col]);
      assert.deepStrictEqual(
        missing,
        [],
        `Columns in v1.json item_tags but missing from Electron: ${missing.join(', ')}`
      );
    });

    test('Electron item_events table has all columns from v1.json', () => {
      const schemaColumns = Object.keys(schema.tables.item_events.columns);
      const electronCols = parseCreateTable(electronSql, 'item_events');
      assert.ok(electronCols, 'Table item_events not found in Electron');

      const missing = schemaColumns.filter(col => !electronCols[col]);
      assert.deepStrictEqual(
        missing,
        [],
        `Columns in v1.json item_events but missing from Electron: ${missing.join(', ')}`
      );
    });

    test('all v1.json tables have column completeness tests', () => {
      // Meta-test: ensure we don't forget to add column tests for new schema tables
      const schemaTables = Object.keys(schema.tables);
      const testedTables = ['items', 'tags', 'item_tags', 'item_events'];
      const untested = schemaTables.filter(t => !testedTables.includes(t));
      assert.deepStrictEqual(
        untested,
        [],
        `v1.json tables without column completeness tests: ${untested.join(', ')}. Add tests above.`
      );
    });
  });

  describe('Cross-Backend Consistency', () => {
    test('Electron and Server have matching required columns', () => {
      for (const [tableName, requiredCols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
        const electronCols = parseCreateTable(electronSql, tableName);
        const serverCols = parseCreateTable(serverSql, tableName);

        assert.ok(electronCols, `Table ${tableName} not found in Electron`);
        assert.ok(serverCols, `Table ${tableName} not found in Server`);

        for (const col of requiredCols) {
          assert.ok(electronCols[col], `Electron ${tableName}.${col} missing`);
          assert.ok(serverCols[col], `Server ${tableName}.${col} missing`);
        }
      }
    });

    test('Timestamp columns use same type', () => {
      const timestampCols = ['createdAt', 'updatedAt', 'deletedAt', 'syncedAt'];

      for (const col of timestampCols) {
        const electronCols = parseCreateTable(electronSql, 'items');
        const serverCols = parseCreateTable(serverSql, 'items');

        if (electronCols[col] && serverCols[col]) {
          assert.strictEqual(
            electronCols[col].type,
            serverCols[col].type,
            `items.${col} type mismatch: Electron=${electronCols[col].type}, Server=${serverCols[col].type}`
          );
        }
      }
    });
  });
});

// Run tests if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  console.log('Running schema fidelity tests...\n');
}
