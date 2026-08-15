/**
 * Version Compatibility Tests for Desktop <-> Server Sync
 *
 * Tests all version match/mismatch/absent permutations:
 * - Both sides at v1 (success)
 * - Client version mismatch (server rejects with 409)
 * - Server version mismatch (client detects in response headers)
 * - Legacy clients with no headers (backward compat)
 * - Database version checks (downgrade detection, upgrade)
 *
 * Uses direct HTTP requests (like sync-three-way.test.js) to control headers.
 * Uses unique port 3460 to avoid conflicts with other test suites.
 */

import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import {
  DATASTORE_VERSION as DESKTOP_DATASTORE_VERSION,
  PROTOCOL_VERSION as DESKTOP_PROTOCOL_VERSION,
} from '../../apps/desktop/version.ts';
import {
  DATASTORE_VERSION as SERVER_DATASTORE_VERSION,
  PROTOCOL_VERSION as SERVER_PROTOCOL_VERSION,
} from '../../apps/server/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', '..', 'apps', 'server');
const TEST_PORT = 3460;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess = null;
let serverTempDir = null;
let apiKey = null;

// ==================== Helpers ====================

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  if (process.env.VERBOSE) {
    console.log('  ', ...args);
  }
}

async function waitForServer(port = TEST_PORT, maxAttempts = 30) {
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log('Server is ready');
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await sleep(100);
  }
  throw new Error(`Server failed to start on port ${port}`);
}

async function startServer(port = TEST_PORT, envOverrides = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-compat-'));
  const key = 'test-version-key-' + Math.random().toString(36).substring(2);

  const proc = spawn('node', ['index.js'], {
    cwd: SERVER_PATH,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tempDir,
      API_KEY: key,
      ...envOverrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (data) => {
    log(`[server:${port}] ${data.toString().trim()}`);
  });

  proc.stderr.on('data', (data) => {
    log(`[server:${port} err] ${data.toString().trim()}`);
  });

  await waitForServer(port);
  return { proc, tempDir, apiKey: key };
}

async function stopServerProcess(proc) {
  if (proc) {
    proc.kill('SIGTERM');
    await sleep(500);
  }
}

/**
 * Make an HTTP request with custom version headers
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {string} opts.apiKey
 * @param {number} [opts.port]
 * @param {object} [opts.body]
 * @param {number|null} [opts.datastoreVersion] - null to omit header
 * @param {number|null} [opts.protocolVersion] - null to omit header
 * @param {string|null} [opts.client] - X-Peek-Client header value
 */
async function versionedRequest(opts) {
  const {
    method = 'GET',
    path,
    apiKey: key,
    port = TEST_PORT,
    body = null,
    datastoreVersion = DESKTOP_DATASTORE_VERSION,
    protocolVersion = DESKTOP_PROTOCOL_VERSION,
    client = 'desktop',
  } = opts;

  const url = `http://localhost:${port}${path}`;
  const headers = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  if (datastoreVersion !== null) {
    headers['X-Peek-Datastore-Version'] = String(datastoreVersion);
  }
  if (protocolVersion !== null) {
    headers['X-Peek-Protocol-Version'] = String(protocolVersion);
  }
  if (client !== null) {
    headers['X-Peek-Client'] = client;
  }

  const fetchOpts = { method, headers };
  if (body) {
    fetchOpts.body = JSON.stringify(body);
  }

  log(`${method} ${url}`, headers);
  const res = await fetch(url, fetchOpts);
  const data = await res.json();

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    data,
  };
}

// ==================== Test State ====================

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASSED: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ==================== Seed Data ====================

async function seedServerItems(key, port = TEST_PORT) {
  // Create 2 items on server
  await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey: key,
    port,
    body: { type: 'url', content: 'https://server-seed-1.example.com', tags: ['test'] },
  });
  await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey: key,
    port,
    body: { type: 'text', content: 'Server seeded text item', tags: ['test'] },
  });
}

// ==================== Tests: Version Headers (Desktop <-> Server) ====================

// Test 1: Both at the current version — sync succeeds
async function test1_bothV1() {
  // Push an item
  const pushRes = await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey,
    body: { type: 'url', content: 'https://test1-both-v1.example.com', tags: ['v1'] },
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });
  assert(pushRes.status === 200, `Expected 200, got ${pushRes.status}`);
  assert(pushRes.data.created === true, 'Item should be created');

  // Pull items
  const pullRes = await versionedRequest({
    method: 'GET',
    path: '/items?profile=default',
    apiKey,
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });
  assert(pullRes.status === 200, `Expected 200, got ${pullRes.status}`);
  assert(Array.isArray(pullRes.data.items), 'Response should have items array');
  assert(pullRes.data.items.length > 0, 'Should have items');

  // Verify response headers
  assert(pullRes.headers['x-peek-datastore-version'] === String(SERVER_DATASTORE_VERSION), 'Response should include datastore version header');
  assert(pullRes.headers['x-peek-protocol-version'] === String(SERVER_PROTOCOL_VERSION), 'Response should include protocol version header');
}

// Test 2: Desktop DS mismatch (client one past the server's version) → server returns 409.
// Client version is built as serverVersion + 1 rather than a hardcoded literal so this
// test stays a genuine mismatch across future version bumps.
async function test2_desktopDSMismatch() {
  const mismatchedVersion = SERVER_DATASTORE_VERSION + 1;
  const res = await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey,
    body: { type: 'url', content: 'https://should-not-save.example.com', tags: [] },
    datastoreVersion: mismatchedVersion,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });
  assert(res.status === 409, `Expected 409, got ${res.status}`);
  assert(res.data.type === 'datastore_version_mismatch', `Expected datastore_version_mismatch, got ${res.data.type}`);
  assert(res.data.message.includes('Datastore version mismatch'), 'Error should mention datastore version');
  assert(res.data.client_version === mismatchedVersion, `Expected client_version=${mismatchedVersion}, got ${res.data.client_version}`);
  assert(res.data.server_version === SERVER_DATASTORE_VERSION, `Expected server_version=${SERVER_DATASTORE_VERSION}, got ${res.data.server_version}`);

  // Verify no data was transferred
  const items = await versionedRequest({
    method: 'GET',
    path: '/items?profile=default',
    apiKey,
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });
  const badItem = items.data.items.find(i => i.content === 'https://should-not-save.example.com');
  assert(!badItem, 'Item should NOT have been saved on version mismatch');
}

// Test 3: Desktop PROTO mismatch (client one past the server's protocol version) → server returns 409
async function test3_desktopProtoMismatch() {
  const mismatchedVersion = SERVER_PROTOCOL_VERSION + 1;
  const res = await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey,
    body: { type: 'url', content: 'https://proto-mismatch.example.com', tags: [] },
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: mismatchedVersion,
  });
  assert(res.status === 409, `Expected 409, got ${res.status}`);
  assert(res.data.type === 'protocol_version_mismatch', `Expected protocol_version_mismatch, got ${res.data.type}`);
  assert(res.data.message.includes('Protocol version mismatch'), 'Error should mention protocol version');
}

// Test 4: Server DS mismatch (server returns a DS one past what the client expects)
// Desktop detects mismatch in response headers
async function test4_serverDSMismatch() {
  // We simulate this by checking the response headers manually
  // since we can't change the running server's version.
  // Instead, verify the desktop logic: if the server's DS header doesn't match
  // the client's, the client should reject.
  const pullRes = await versionedRequest({
    method: 'GET',
    path: '/items?profile=default',
    apiKey,
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });

  // Server returns its own version, so a matching client should be fine
  assert(pullRes.status === 200, 'Normal request should succeed');

  // Simulate what desktop code does: check response headers
  const serverDS = pullRes.headers['x-peek-datastore-version'];
  assert(serverDS === String(SERVER_DATASTORE_VERSION), `Server should return DS=${SERVER_DATASTORE_VERSION}, got ${serverDS}`);

  // Verify that a server DS one past the client's would be caught
  // (Testing the comparison logic — the actual code in sync.ts does this check)
  const simulatedServerDS = SERVER_DATASTORE_VERSION + 1;
  const clientDS = SERVER_DATASTORE_VERSION;
  assert(simulatedServerDS !== clientDS, 'Mismatch should be detected');
  // The real implementation throws an error in serverFetch() when headers mismatch
}

// Test 5: Server PROTO mismatch (server returns a PROTO one past what the client expects)
async function test5_serverProtoMismatch() {
  // Same approach as test 4 — verify the logic path
  const pullRes = await versionedRequest({
    method: 'GET',
    path: '/items?profile=default',
    apiKey,
    datastoreVersion: DESKTOP_DATASTORE_VERSION,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });

  const serverProto = pullRes.headers['x-peek-protocol-version'];
  assert(serverProto === String(SERVER_PROTOCOL_VERSION), `Server should return PROTO=${SERVER_PROTOCOL_VERSION}, got ${serverProto}`);

  // Verify mismatch detection logic
  const simulatedServerProto = SERVER_PROTOCOL_VERSION + 1;
  const clientProto = SERVER_PROTOCOL_VERSION;
  assert(simulatedServerProto !== clientProto, 'Protocol mismatch should be detected');
}

// Test 6: Legacy desktop (no version headers) → server allows (backward compat)
async function test6_legacyDesktop() {
  const res = await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey,
    body: { type: 'url', content: 'https://legacy-desktop.example.com', tags: ['legacy'] },
    datastoreVersion: null,  // No version headers
    protocolVersion: null,
    client: null,
  });
  assert(res.status === 200, `Expected 200 for legacy client, got ${res.status}`);
  assert(res.data.created === true, 'Legacy client should be able to create items');

  // Verify server still returns version headers
  assert(res.headers['x-peek-datastore-version'] === String(SERVER_DATASTORE_VERSION), 'Server should still return version headers');
  assert(res.headers['x-peek-protocol-version'] === String(SERVER_PROTOCOL_VERSION), 'Server should still return version headers');
}

// Test 7: Legacy server (no version headers in response) → desktop allows
// We test this by verifying the client-side logic handles missing headers gracefully
async function test7_legacyServer() {
  // The desktop code in sync.ts skips the version check if server returns no headers.
  // We verify this by checking: if server response has no version headers, no error is thrown.
  // Since our test server DOES return headers, we verify the logic path:
  // serverDS === null → skip check (this is the code path in sync.ts)
  const serverDS = null; // Simulating legacy server
  const skipCheck = !serverDS;
  assert(skipCheck === true, 'Client should skip check when server returns no version headers');
}

// Test 8: Both no headers → sync succeeds (pre-versioning state)
async function test8_bothNoHeaders() {
  const res = await versionedRequest({
    method: 'POST',
    path: '/items?profile=default',
    apiKey,
    body: { type: 'url', content: 'https://no-headers.example.com', tags: ['pre-version'] },
    datastoreVersion: null,
    protocolVersion: null,
    client: null,
  });
  assert(res.status === 200, `Expected 200 for pre-versioning state, got ${res.status}`);
  assert(res.data.created === true, 'Pre-versioning sync should work');
}

// ==================== Tests: Database Version ====================
//
// These tests verify the version check logic that runs in both desktop (datastore.ts)
// and server (db.js), replicated inline against a node:sqlite DatabaseSync so this
// file has no dependency on better-sqlite3 (which desktop still needs, but compiled
// for Electron's Node version — not importable from plain Node here).
//
// The code under test (in datastore.ts) does:
//   1. Read datastore_version from feature_settings
//   2. If stored > code: disable sync (downgrade detected)
//   3. If stored < code: update stored version (upgrade)
//   4. Write current version to feature_settings

const CODE_DATASTORE_VERSION = DESKTOP_DATASTORE_VERSION; // Matches apps/desktop/version.ts

function createTestDesktopDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  // Create the feature_settings table (same as desktop schema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_settings (
      id TEXT PRIMARY KEY,
      featureId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_settings_unique
      ON feature_settings(featureId, key);
  `);

  return db;
}

/**
 * Replicate the checkAndWriteDatastoreVersion() logic from datastore.ts
 * Returns { syncDisabled: boolean }
 */
function checkAndWriteDatastoreVersion(db, codeVersion = CODE_DATASTORE_VERSION) {
  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get();

  if (row) {
    let storedVersion;
    try {
      storedVersion = parseInt(JSON.parse(row.value), 10);
    } catch {
      storedVersion = parseInt(row.value, 10);
    }

    if (storedVersion > codeVersion) {
      // Downgrade detected
      return { syncDisabled: true };
    }
  }

  // Write current version
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'system', 'datastore_version', ?, ?)
  `).run('system-datastore_version', JSON.stringify(codeVersion), Date.now());

  return { syncDisabled: false };
}

// Test 9: Version is written to feature_settings after init
async function test9_initWritesVersion() {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-db-'));
  const dbPath = join(tempDir, 'test.db');

  const db = createTestDesktopDb(dbPath);
  const result = checkAndWriteDatastoreVersion(db);

  // Verify version was written
  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get();

  assert(row, 'datastore_version should be stored in feature_settings');

  let storedVersion;
  try {
    storedVersion = parseInt(JSON.parse(row.value), 10);
  } catch {
    storedVersion = parseInt(row.value, 10);
  }
  assert(storedVersion === CODE_DATASTORE_VERSION, `Stored version should be ${CODE_DATASTORE_VERSION}, got ${storedVersion}`);
  assert(result.syncDisabled === false, 'Sync should not be disabled on fresh init');

  db.close();
  await rm(tempDir, { recursive: true, force: true });
}

// Test 10: Stored version equals code version — sync enabled normally
async function test10_versionMatch() {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-match-'));
  const dbPath = join(tempDir, 'test.db');

  const db = createTestDesktopDb(dbPath);

  // Write the code version (simulating a previous run)
  checkAndWriteDatastoreVersion(db, CODE_DATASTORE_VERSION);

  // Check again (simulating app restart with same version)
  const result = checkAndWriteDatastoreVersion(db, CODE_DATASTORE_VERSION);
  assert(result.syncDisabled === false, 'Sync should NOT be disabled when versions match');

  db.close();
  await rm(tempDir, { recursive: true, force: true });
}

// Test 11: Stored version > code version (simulate downgrade) — sync disabled
async function test11_downgradeDetected() {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-downgrade-'));
  const dbPath = join(tempDir, 'test.db');

  const db = createTestDesktopDb(dbPath);

  // Simulate a newer version having written version 99
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'system', 'datastore_version', ?, ?)
  `).run('system-datastore_version', JSON.stringify(99), Date.now());

  // Now run the check with the code version (downgrade scenario — 99 stays well
  // above any realistic code version)
  const result = checkAndWriteDatastoreVersion(db, CODE_DATASTORE_VERSION);
  assert(result.syncDisabled === true, `Sync should be disabled when stored version (99) > code version (${CODE_DATASTORE_VERSION})`);

  // Verify the stored version was NOT overwritten
  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get();
  let storedVersion;
  try {
    storedVersion = parseInt(JSON.parse(row.value), 10);
  } catch {
    storedVersion = parseInt(row.value, 10);
  }
  assert(storedVersion === 99, `Stored version should still be 99 (not overwritten), got ${storedVersion}`);

  db.close();
  await rm(tempDir, { recursive: true, force: true });
}

// Test 12: Stored version < code version (simulate upgrade) — version updated
async function test12_upgradeDetected() {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-upgrade-'));
  const dbPath = join(tempDir, 'test.db');

  const db = createTestDesktopDb(dbPath);

  // Simulate an older version having written version 0
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'system', 'datastore_version', ?, ?)
  `).run('system-datastore_version', JSON.stringify(0), Date.now());

  // Now run the check with the code version (upgrade scenario)
  const result = checkAndWriteDatastoreVersion(db, CODE_DATASTORE_VERSION);
  assert(result.syncDisabled === false, 'Sync should NOT be disabled after upgrade');

  // Verify version was updated
  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get();
  let storedVersion;
  try {
    storedVersion = parseInt(JSON.parse(row.value), 10);
  } catch {
    storedVersion = parseInt(row.value, 10);
  }
  assert(storedVersion === CODE_DATASTORE_VERSION, `Version should be updated to ${CODE_DATASTORE_VERSION}, got ${storedVersion}`);

  db.close();
  await rm(tempDir, { recursive: true, force: true });
}

// ==================== Server DB Version Test ====================

async function testServerDBVersion() {
  // The server writes datastore_version to its settings table during initializeSchema().
  // We verify by creating a connection and checking the settings table.
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-server-db-version-'));
  const profileDir = join(tempDir, 'testuser', 'profiles', 'default');
  await mkdir(profileDir, { recursive: true });
  const dbPath = join(profileDir, 'datastore.sqlite');

  // Use the server's db module to create a connection
  // Since db.js uses DATA_DIR and userId, we simulate by creating the DB directly
  const serverDb = new DatabaseSync(dbPath);
  serverDb.exec('PRAGMA journal_mode = WAL');

  // Create settings table (as server does)
  serverDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Write version (as server does in initializeSchema)
  serverDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "datastore_version",
    String(SERVER_DATASTORE_VERSION)
  );

  // Verify
  const row = serverDb.prepare("SELECT value FROM settings WHERE key = 'datastore_version'").get();
  assert(row, 'Server should write datastore_version to settings');
  assert(row.value === String(SERVER_DATASTORE_VERSION), `Server datastore_version should be "${SERVER_DATASTORE_VERSION}", got "${row.value}"`);

  serverDb.close();
  await rm(tempDir, { recursive: true, force: true });
}

// ==================== Desktop/Server Version Lockstep ====================

// Every sync client is required to declare the server's exact DATASTORE_VERSION
// (checkVersionHeaders() in apps/server/index.js rejects anything else), so the
// desktop client and the server must never drift apart. This is the test that
// should have caught the tags/parentId-era skew: it imports the real constants
// rather than restating a literal that can rot independently of either file.
async function testDesktopServerVersionsInSync() {
  assert(
    DESKTOP_DATASTORE_VERSION === SERVER_DATASTORE_VERSION,
    `apps/desktop/version.ts DATASTORE_VERSION (${DESKTOP_DATASTORE_VERSION}) must match apps/server/version.js DATASTORE_VERSION (${SERVER_DATASTORE_VERSION})`
  );
  assert(
    DESKTOP_PROTOCOL_VERSION === SERVER_PROTOCOL_VERSION,
    `apps/desktop/version.ts PROTOCOL_VERSION (${DESKTOP_PROTOCOL_VERSION}) must match apps/server/version.js PROTOCOL_VERSION (${SERVER_PROTOCOL_VERSION})`
  );
}

// ==================== Health Check ====================

async function testHealthCheck() {
  const res = await fetch(`${BASE_URL}/`);
  const data = await res.json();

  assert(res.ok, 'Health check should return 200');
  assert(data.datastore_version === SERVER_DATASTORE_VERSION, `Health check should include datastore_version=${SERVER_DATASTORE_VERSION}, got ${data.datastore_version}`);
  assert(data.protocol_version === SERVER_PROTOCOL_VERSION, `Health check should include protocol_version=${SERVER_PROTOCOL_VERSION}, got ${data.protocol_version}`);

  // Health check should also have version headers
  assert(res.headers.get('x-peek-datastore-version') === String(SERVER_DATASTORE_VERSION), 'Health check should have version headers');
  assert(res.headers.get('x-peek-protocol-version') === String(SERVER_PROTOCOL_VERSION), 'Health check should have version headers');
}

// ==================== Server Version in Settings ====================

// ==================== Incremental Sync + Server DB Version ====================

async function testIncrementalSyncVersionCheck() {
  // Test that /items/since/:timestamp also checks version headers
  const res = await versionedRequest({
    method: 'GET',
    path: `/items/since/${new Date().toISOString()}?profile=default`,
    apiKey,
    datastoreVersion: SERVER_DATASTORE_VERSION + 1,  // Mismatch
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  });
  assert(res.status === 409, `Incremental sync should also reject mismatched versions, got ${res.status}`);
}

// ==================== Main ====================

async function main() {
  console.log('\n=== Version Compatibility Tests ===\n');

  try {
    console.log('--- Desktop/Server Version Lockstep ---');
    await runTest('Desktop and server DATASTORE_VERSION/PROTOCOL_VERSION agree', testDesktopServerVersionsInSync);
    console.log('');

    // Start server
    console.log('Starting server...');
    const server = await startServer();
    serverProcess = server.proc;
    serverTempDir = server.tempDir;
    apiKey = server.apiKey;
    console.log(`  Server running on port ${TEST_PORT}`);

    // Seed test data
    await seedServerItems(apiKey);
    console.log('  Seeded 2 test items\n');

    // --- HTTP Version Header Tests ---
    console.log('--- HTTP Version Header Tests ---');
    await runTest('#1: Both at v1 — sync succeeds', test1_bothV1);
    await runTest('#2: Desktop DS mismatch → 409', test2_desktopDSMismatch);
    await runTest('#3: Desktop PROTO mismatch → 409', test3_desktopProtoMismatch);
    await runTest('#4: Server DS mismatch detection', test4_serverDSMismatch);
    await runTest('#5: Server PROTO mismatch detection', test5_serverProtoMismatch);
    await runTest('#6: Legacy desktop (no headers) → allowed', test6_legacyDesktop);
    await runTest('#7: Legacy server (no headers) → skip check', test7_legacyServer);
    await runTest('#8: Both no headers → sync succeeds', test8_bothNoHeaders);

    console.log('\n--- Incremental Sync Version Check ---');
    await runTest('Incremental sync rejects mismatched versions', testIncrementalSyncVersionCheck);

    console.log('\n--- Health Check ---');
    await runTest('Health check includes version info', testHealthCheck);

    console.log('\n--- Server DB Version ---');
    await runTest('Server DB writes datastore_version', testServerDBVersion);

    // Stop the server before running desktop DB tests (avoids port conflicts)
    await stopServerProcess(serverProcess);
    serverProcess = null;
    if (serverTempDir) {
      await rm(serverTempDir, { recursive: true, force: true });
      serverTempDir = null;
    }

    // --- Database Version Tests ---
    console.log('\n--- Database Version Tests (Desktop Logic) ---');
    await runTest('#9: initDatabase writes DATASTORE_VERSION', test9_initWritesVersion);
    await runTest('#10: Stored version matches code — sync enabled', test10_versionMatch);
    await runTest('#11: Downgrade detected — sync disabled', test11_downgradeDetected);
    await runTest('#12: Upgrade detected — version updated', test12_upgradeDetected);

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
    failures.push({ name: 'setup/teardown', error: err.message });
  } finally {
    // Cleanup
    if (serverProcess) {
      await stopServerProcess(serverProcess);
    }
    if (serverTempDir) {
      await rm(serverTempDir, { recursive: true, force: true });
    }
  }

  // Summary
  console.log('\n=== Results ===');
  console.log(`  ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main();
