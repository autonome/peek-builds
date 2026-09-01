/**
 * End-to-End Authentication Tests for the Sync Server
 *
 * Every other spawned-server suite passes E2E_TEST=true, which short-circuits
 * both singleUserMiddleware and multiUserMiddleware in apps/server/auth.js —
 * neither one ever compares the Bearer token or calls users.resolveDevice(),
 * so the 401 paths, key resolution, and per-device revocation are invisible
 * to every other suite. This suite spawns the real server WITHOUT E2E_TEST,
 * in multi-user mode, and drives it with real minted device credentials over
 * a real socket.
 *
 * Multi-user mode (not single-user) is what's under test here: device keys
 * and resolveDevice()/per-device revocation only exist on the multiUserMiddleware
 * path (auth.js). A fresh multi-user server has no registered user, and there
 * is no HTTP route to create one (POST /admin/devices requires an existing
 * user) — the bootstrap is the same one migrateFromLegacyApiKey() already
 * performs on every multi-user boot: an API_KEY env var mints a 'default' user
 * with that key on first start (see apps/server/index.js). That bootstrap key
 * is never used as a test credential itself; it only exists so ADMIN_TOKEN can
 * mint real per-device keys against a real user.
 */

import { spawn } from 'child_process';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Import compiled desktop modules (from dist/) — case 7 needs the real
// client, not a hand-built request.
import * as datastore from '../../apps/desktop/dist/main/datastore.js';
import * as sync from '../../apps/desktop/dist/main/sync.js';
import * as profiles from '../../apps/desktop/dist/main/profiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', '..', 'apps', 'server');
const TEST_PORT = 3461; // Distinct from every other spawned-server suite (3457-3460)
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess = null;
let serverTempDir = null;
let desktopTempDir = null;
let bootstrapUserId = 'default';
let adminToken = null;

// ==================== Helpers ====================

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  if (process.env.VERBOSE) {
    console.log('  ', ...args);
  }
}

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // GET / is public in both middlewares — it must answer with no
      // credential at all, which is also assertion 5 below.
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) {
        console.log('  Server is ready');
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await sleep(100);
  }
  throw new Error('Server failed to start');
}

async function startServer() {
  console.log('Starting server...');

  serverTempDir = await mkdtemp(join(tmpdir(), 'peek-auth-e2e-server-'));
  log(`Server temp directory: ${serverTempDir}`);

  // Bootstrap credential: mints the 'default' user via migrateFromLegacyApiKey()
  // on startup (multi-user mode only). Not used as a test credential — it only
  // exists so a real user exists for ADMIN_TOKEN to mint devices against.
  const bootstrapKey = 'bootstrap-' + crypto.randomBytes(16).toString('hex');
  adminToken = 'admin-' + crypto.randomBytes(16).toString('hex');

  serverProcess = spawn('node', ['index.js'], {
    cwd: SERVER_PATH,
    env: {
      ...process.env,
      PORT: TEST_PORT.toString(),
      DATA_DIR: serverTempDir,
      API_KEY: bootstrapKey,
      ADMIN_TOKEN: adminToken,
      // Deliberately NOT set: SINGLE_USER_MODE, E2E_TEST. Real multiUserMiddleware,
      // real Bearer-token comparison, real users.resolveDevice().
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    if (process.env.VERBOSE) {
      console.log(`  [server] ${data.toString().trim()}`);
    }
  });
  serverProcess.stderr.on('data', (data) => {
    if (process.env.VERBOSE) {
      console.log(`  [server] ${data.toString().trim()}`);
    }
  });
  serverProcess.on('error', (error) => {
    console.error(`[server] Process error:`, error);
  });
  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[server] Process exited with code ${code}, signal ${signal}`);
    }
  });

  await waitForServer();
  console.log(`  Server running on port ${TEST_PORT}`);
}

async function stopServer() {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
    await sleep(500);
    serverProcess = null;
  }

  if (serverTempDir) {
    log('Cleaning up server temp directory...');
    await rm(serverTempDir, { recursive: true, force: true });
    serverTempDir = null;
  }
}

async function initDesktopDatastore() {
  console.log('Initializing desktop datastore...');

  desktopTempDir = await mkdtemp(join(tmpdir(), 'peek-auth-e2e-desktop-'));
  const dbPath = join(desktopTempDir, 'default', 'datastore.sqlite');
  await mkdir(join(desktopTempDir, 'default'), { recursive: true });
  log(`Desktop database: ${dbPath}`);

  profiles.initProfilesDb(desktopTempDir);
  profiles.ensureDefaultProfile();
  profiles.setActiveProfile('default');

  datastore.initDatabase(dbPath);

  console.log('  Desktop datastore initialized');
}

async function cleanupDesktop() {
  if (desktopTempDir) {
    log('Cleaning up desktop temp directory...');
    datastore.closeDatabase();
    profiles.closeProfilesDb();
    await rm(desktopTempDir, { recursive: true, force: true });
    desktopTempDir = null;
  }
}

// ==================== Raw HTTP helper ====================
//
// Deliberately hand-rolled rather than routed through the desktop sync
// module: cases 1-6 are about the SERVER's credential handling in isolation,
// independent of any one client's header construction. Case 7 is the one
// that goes through the real client.

async function rawRequest(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined && token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // Non-JSON body (shouldn't happen here); leave data null.
  }
  return { status: res.status, data };
}

/** Mint a real device key for bootstrapUserId via the admin API. */
async function mintDevice(label) {
  const { status, data } = await rawRequest('POST', '/admin/devices', {
    token: adminToken,
    body: { userId: bootstrapUserId, label },
  });
  if (status !== 200) {
    throw new Error(`mintDevice failed: ${status} ${JSON.stringify(data)}`);
  }
  return data.device; // { deviceId, userId, label, apiKey }
}

async function revokeDevice(deviceId) {
  const { status, data } = await rawRequest(
    'DELETE',
    `/admin/devices/${deviceId}?userId=${encodeURIComponent(bootstrapUserId)}`,
    { token: adminToken }
  );
  if (status !== 200) {
    throw new Error(`revokeDevice failed: ${status} ${JSON.stringify(data)}`);
  }
  return data.revoked;
}

async function createServerProfile(token, name) {
  const { status, data } = await rawRequest('POST', '/profiles', {
    token,
    body: { name },
  });
  if (status !== 200) {
    throw new Error(`createServerProfile failed: ${status} ${JSON.stringify(data)}`);
  }
  return data.profile.id;
}

// ==================== Test Functions ====================

async function testNoAuthHeaderIs401() {
  console.log('\n--- Test: No Authorization Header Is 401 ---');

  const { status } = await rawRequest('GET', '/items');
  if (status !== 401) {
    throw new Error(`Expected 401 with no Authorization header, got ${status}`);
  }

  console.log('  PASSED');
}

async function testWrongBearerTokenIs401() {
  console.log('\n--- Test: Well-Formed But Wrong Bearer Token Is 401 ---');

  const wrongToken = crypto.randomBytes(32).toString('hex'); // same shape as a real key, never minted
  const { status } = await rawRequest('GET', '/items', { token: wrongToken });
  if (status !== 401) {
    throw new Error(`Expected 401 for an unminted bearer token, got ${status}`);
  }

  console.log('  PASSED');
}

async function testMintedDeviceKeySucceeds() {
  console.log('\n--- Test: A Minted Device Key Authenticates ---');

  const device = await mintDevice('test-device-succeeds');
  log(`Minted device ${device.deviceId}`);

  const { status, data } = await rawRequest('GET', '/items', { token: device.apiKey });
  if (status !== 200) {
    throw new Error(`Expected 200 for a freshly minted device key, got ${status}: ${JSON.stringify(data)}`);
  }
  if (!Array.isArray(data.items)) {
    throw new Error(`Expected an items array, got ${JSON.stringify(data)}`);
  }

  console.log('  PASSED');
}

async function testRevokedDeviceKeyIs401() {
  console.log('\n--- Test: A Revoked Device Key Is Rejected After Revocation ---');

  const device = await mintDevice('test-device-revoked');
  log(`Minted device ${device.deviceId}`);

  // Confirm the key works before revocation, so the later 401 is proven to be
  // caused BY the revocation rather than the key never having worked at all.
  const before = await rawRequest('GET', '/items', { token: device.apiKey });
  if (before.status !== 200) {
    throw new Error(`Expected 200 before revocation, got ${before.status}`);
  }

  const revoked = await revokeDevice(device.deviceId);
  if (!revoked) {
    throw new Error('revokeDevice() reported no device was revoked');
  }
  log('Device revoked');

  const after = await rawRequest('GET', '/items', { token: device.apiKey });
  if (after.status !== 401) {
    throw new Error(`Expected 401 after revocation, got ${after.status}`);
  }

  console.log('  PASSED');
}

async function testHealthCheckIsPublic() {
  console.log('\n--- Test: Health Check Answers Without Any Credential ---');

  const { status, data } = await rawRequest('GET', '/');
  if (status !== 200) {
    throw new Error(`Expected 200 for GET / with no credential, got ${status}`);
  }
  if (data.status !== 'ok') {
    throw new Error(`Expected status 'ok', got ${JSON.stringify(data)}`);
  }

  console.log('  PASSED');
}

async function testCredentialNamespacesDoNotCross() {
  console.log('\n--- Test: Device Keys and ADMIN_TOKEN Are Separate Namespaces ---');

  const device = await mintDevice('test-device-namespace');

  // A device key must never authenticate /admin/*.
  const adminAttempt = await rawRequest('POST', '/admin/devices', {
    token: device.apiKey,
    body: { userId: bootstrapUserId, label: 'should-not-be-created' },
  });
  if (adminAttempt.status !== 401) {
    throw new Error(`Expected 401 using a device key against /admin/devices, got ${adminAttempt.status}`);
  }

  // ADMIN_TOKEN must never authenticate a user-authed sync route.
  const itemsAttempt = await rawRequest('GET', '/items', { token: adminToken });
  if (itemsAttempt.status !== 401) {
    throw new Error(`Expected 401 using ADMIN_TOKEN against /items, got ${itemsAttempt.status}`);
  }

  console.log('  PASSED');
}

/**
 * The important one: the REAL desktop client authenticates correctly over a
 * real socket, both for a genuinely minted key (success) and a bad one
 * (failure that is not silently reported as success).
 */
async function testRealDesktopClientAuthenticates() {
  console.log('\n--- Test: Real Desktop Client Authenticates Over the Wire ---');

  const device = await mintDevice('test-desktop-client');
  const serverProfileId = await createServerProfile(device.apiKey, 'Auth E2E');
  log(`Minted device ${device.deviceId}, server profile ${serverProfileId}`);

  const activeProfile = profiles.getActiveProfile();
  profiles.enableSync(activeProfile.id, device.apiKey, serverProfileId);
  sync.setSyncConfig({
    serverUrl: BASE_URL,
    apiKey: device.apiKey,
    lastSyncTime: 0,
    autoSync: false,
  });

  // Push an item with the real key and confirm it lands.
  const content = 'https://real-client-auth-' + Date.now() + '.example.com';
  datastore.addItem('url', { content });

  const goodResult = await sync.pushToServer(BASE_URL, device.apiKey, 0);
  log(`Push with real key: pushed=${goodResult.pushed}, failed=${goodResult.failed}`);
  if (goodResult.pushed !== 1 || goodResult.failed !== 0) {
    throw new Error(`Expected 1 pushed / 0 failed with a valid key, got pushed=${goodResult.pushed} failed=${goodResult.failed}`);
  }

  const check = await rawRequest('GET', `/items?profile=${encodeURIComponent(serverProfileId)}`, { token: device.apiKey });
  if (check.status !== 200 || !check.data.items.some((i) => i.content === content)) {
    throw new Error('Item pushed by the real client was not found on the server');
  }
  log('Item confirmed on server');

  // Reconfigure with a bad key and confirm the push FAILS rather than
  // silently reporting success — this is what proves the client's own header
  // construction is exercised on the wire, not just the server's reading of
  // a hand-built header.
  const badKey = crypto.randomBytes(32).toString('hex');
  sync.setSyncConfig({
    serverUrl: BASE_URL,
    apiKey: badKey,
    lastSyncTime: 0,
    autoSync: false,
  });

  const badContent = 'https://real-client-auth-bad-key-' + Date.now() + '.example.com';
  datastore.addItem('url', { content: badContent });

  const badResult = await sync.pushToServer(BASE_URL, badKey, 0);
  log(`Push with bad key: pushed=${badResult.pushed}, failed=${badResult.failed}`);
  if (badResult.pushed !== 0 || badResult.failed < 1) {
    throw new Error(`Expected 0 pushed with a bad key, got pushed=${badResult.pushed} failed=${badResult.failed}`);
  }

  const badCheck = await rawRequest('GET', `/items?profile=${encodeURIComponent(serverProfileId)}`, { token: device.apiKey });
  if (badCheck.data.items.some((i) => i.content === badContent)) {
    throw new Error('Item pushed with a bad key should not have reached the server');
  }

  console.log('  PASSED');
}

// ==================== Test Runner ====================

async function runTests() {
  console.log('='.repeat(60));
  console.log('Sync Server Authentication E2E Tests');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;
  const failures = [];

  try {
    await startServer();
    await initDesktopDatastore();

    const tests = [
      ['No Authorization Header Is 401', testNoAuthHeaderIs401],
      ['Wrong Bearer Token Is 401', testWrongBearerTokenIs401],
      ['Minted Device Key Succeeds', testMintedDeviceKeySucceeds],
      ['Revoked Device Key Is 401', testRevokedDeviceKeyIs401],
      ['Health Check Is Public', testHealthCheckIsPublic],
      ['Credential Namespaces Do Not Cross', testCredentialNamespacesDoNotCross],
      ['Real Desktop Client Authenticates', testRealDesktopClientAuthenticates],
    ];

    for (const [name, testFn] of tests) {
      try {
        await testFn();
        passed++;
      } catch (error) {
        failed++;
        failures.push({ name, error: error.message });
        console.error(`  FAILED: ${name}`);
        console.error(`    Error: ${error.message}`);
        if (process.env.VERBOSE) {
          console.error(error.stack);
        }
      }
    }
  } finally {
    await cleanupDesktop();
    await stopServer();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`  - ${name}: ${error}`);
    }
    console.log('='.repeat(60));
    process.exit(1);
  } else {
    console.log('\nAll tests passed!');
    console.log('='.repeat(60));
    process.exit(0);
  }
}

process.on('SIGINT', async () => {
  console.log('\nInterrupted, cleaning up...');
  await cleanupDesktop();
  await stopServer();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await cleanupDesktop();
  await stopServer();
  process.exit(1);
});

runTests().catch(async (error) => {
  console.error('Test runner error:', error);
  await cleanupDesktop();
  await stopServer();
  process.exit(1);
});
