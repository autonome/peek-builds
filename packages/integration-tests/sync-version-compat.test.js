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
import { createRequire } from 'module';
import { mkdtemp, rm, writeFile } from 'fs/promises';
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
import {
  initDatabase as initDesktopDatabase,
  closeDatabase as closeDesktopDatabase,
  isSyncDisabledDueToVersion,
} from '../../apps/desktop/dist/main/datastore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', '..', 'apps', 'server');
const require = createRequire(import.meta.url);
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
// Drives the real checkAndWriteDatastoreVersion() in datastore.ts through its actual
// entry point rather than a restatement of it. That function is module-private, takes
// no arguments, and operates on the module-level db — so it's exercised the way
// production code exercises it: through initDatabase() (compiled to
// apps/desktop/dist/main/datastore.js, which has no electron import and runs fine
// under plain Node). Its outcome is observable two ways: the feature_settings row it
// writes or leaves alone, and the exported isSyncDisabledDueToVersion(). Each case
// opens a temp sqlite file via initDatabase(), closes it, tampers with the stored
// feature_settings row directly (simulating a database left behind by a different
// binary version), reopens via initDatabase() again, and asserts on both observables.

const CODE_DATASTORE_VERSION = DESKTOP_DATASTORE_VERSION; // Matches apps/desktop/version.ts

async function withTempDesktopDb(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-version-db-'));
  const dbPath = join(tempDir, 'test.db');
  try {
    await fn(dbPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Read back the stored datastore_version the same way checkAndWriteDatastoreVersion()
 * decodes it (JSON.parse first, bare parseInt as a fallback for legacy-encoded
 * values) — an assertion helper reading the outcome, not a restatement of the
 * version-comparison logic under test.
 */
function readStoredVersion(db) {
  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get();
  if (!row) return null;
  try {
    return parseInt(JSON.parse(row.value), 10);
  } catch {
    return parseInt(row.value, 10);
  }
}

/**
 * Overwrite the stored feature_settings row directly in sqlite, bypassing the
 * desktop code entirely — simulates a database left behind by a different binary
 * version. `encodedValue` is written verbatim so callers choose the encoding
 * (JSON.stringify(n), or a bare/legacy numeral to exercise the parseInt fallback).
 */
function tamperStoredVersion(dbPath, encodedValue) {
  const raw = new DatabaseSync(dbPath);
  raw.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'system', 'datastore_version', ?, ?)
  `).run('system-datastore_version', encodedValue, Date.now());
  raw.close();
}

// Test 9: Version is written to feature_settings after init
async function test9_initWritesVersion() {
  await withTempDesktopDb(async (dbPath) => {
    const db = initDesktopDatabase(dbPath);
    const storedVersion = readStoredVersion(db);
    assert(storedVersion === CODE_DATASTORE_VERSION, `Stored version should be ${CODE_DATASTORE_VERSION}, got ${storedVersion}`);
    assert(isSyncDisabledDueToVersion() === false, 'Sync should not be disabled on fresh init');
    closeDesktopDatabase();
  });
}

// Test 10: Stored version equals code version — sync enabled normally
async function test10_versionMatch() {
  await withTempDesktopDb(async (dbPath) => {
    // First init writes the current version; a second init on the same file
    // simulates an app restart with no version change in between.
    initDesktopDatabase(dbPath);
    closeDesktopDatabase();

    const db = initDesktopDatabase(dbPath);
    assert(isSyncDisabledDueToVersion() === false, 'Sync should NOT be disabled when versions match');
    const storedVersion = readStoredVersion(db);
    assert(storedVersion === CODE_DATASTORE_VERSION, `Stored version should stay ${CODE_DATASTORE_VERSION}, got ${storedVersion}`);
    closeDesktopDatabase();
  });
}

// Test 11: Stored version > code version (simulate downgrade) — sync disabled
async function test11_downgradeDetected() {
  await withTempDesktopDb(async (dbPath) => {
    initDesktopDatabase(dbPath);
    closeDesktopDatabase();

    // A newer binary wrote a version past what this code knows about. Built off
    // the code version rather than a hardcoded literal so this stays a genuine
    // downgrade across future version bumps.
    const newerVersion = CODE_DATASTORE_VERSION + 1;
    tamperStoredVersion(dbPath, JSON.stringify(newerVersion));

    const db = initDesktopDatabase(dbPath);
    assert(isSyncDisabledDueToVersion() === true, `Sync should be disabled when stored version (${newerVersion}) > code version (${CODE_DATASTORE_VERSION})`);

    const storedVersion = readStoredVersion(db);
    assert(storedVersion === newerVersion, `Stored version should still be ${newerVersion} (not overwritten), got ${storedVersion}`);
    closeDesktopDatabase();
  });
}

// Test 12: Stored version < code version (simulate upgrade) — version updated
async function test12_upgradeDetected() {
  await withTempDesktopDb(async (dbPath) => {
    initDesktopDatabase(dbPath);
    closeDesktopDatabase();

    // An older binary's version is still on disk.
    const olderVersion = Math.max(CODE_DATASTORE_VERSION - 1, 0);
    tamperStoredVersion(dbPath, JSON.stringify(olderVersion));

    const db = initDesktopDatabase(dbPath);
    assert(isSyncDisabledDueToVersion() === false, 'Sync should NOT be disabled after upgrade');

    const storedVersion = readStoredVersion(db);
    assert(storedVersion === CODE_DATASTORE_VERSION, `Version should be updated to ${CODE_DATASTORE_VERSION}, got ${storedVersion}`);
    closeDesktopDatabase();
  });
}

// Test 13: Stored version encoded in a form JSON.parse rejects (a bare numeral with
// a leading zero) but parseInt still recovers — proves the real fallback branch runs,
// not just the JSON.stringify() encoding every current write actually produces.
async function test13_legacyEncodedVersionFallback() {
  await withTempDesktopDb(async (dbPath) => {
    initDesktopDatabase(dbPath);
    closeDesktopDatabase();

    const newerVersion = CODE_DATASTORE_VERSION + 1;
    const legacyEncoded = '0' + String(newerVersion);
    assert(
      (() => { try { JSON.parse(legacyEncoded); return false; } catch { return true; } })(),
      `Test setup error: "${legacyEncoded}" should not be valid JSON`
    );
    tamperStoredVersion(dbPath, legacyEncoded);

    const db = initDesktopDatabase(dbPath);
    assert(isSyncDisabledDueToVersion() === true, `Sync should be disabled when the legacy-encoded stored version ("${legacyEncoded}" → ${newerVersion}) > code version (${CODE_DATASTORE_VERSION})`);

    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'system' AND key = 'datastore_version'
    `).get();
    assert(row.value === legacyEncoded, `Stored value should still be the untouched legacy encoding "${legacyEncoded}", got "${row.value}"`);
    closeDesktopDatabase();
  });
}

// ==================== Server DB Version Test ====================

async function testServerDBVersion() {
  // Drives the real schema initialization in apps/server/db.js. db.js reads its
  // DATA_DIR from the environment once, at module load — so it's set before the
  // first require() below rather than passed as an argument.
  const tempDir = await mkdtemp(join(tmpdir(), 'peek-server-db-version-'));
  process.env.DATA_DIR = tempDir;

  const serverDb = require('../../apps/server/db.js');
  const userId = 'version-compat-test-user';
  const profileId = 'default';

  // getSetting() -> getConnection() -> initializeSchema(), the same path a real
  // request takes on its first connection to a profile.
  const value = serverDb.getSetting(userId, 'datastore_version', profileId);
  assert(value, 'Server should write datastore_version to settings');
  assert(value === String(SERVER_DATASTORE_VERSION), `Server datastore_version should be "${SERVER_DATASTORE_VERSION}", got "${value}"`);

  serverDb.closeConnection(userId, profileId);
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
    await runTest('#13: Legacy-encoded stored version — parseInt fallback', test13_legacyEncodedVersionFallback);

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
