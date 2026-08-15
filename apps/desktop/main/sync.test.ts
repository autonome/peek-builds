/**
 * Unit tests for the event-sync watermark in sync.ts.
 *
 * Drives the REAL production sync functions (pushEventsToServer,
 * pushToServer, syncAll) against the REAL server app (apps/server/index.js —
 * same routes, same db.js persistence, same validation the server route
 * tests exercise) with no TCP listener: a `globalThis.fetch` stub routes
 * every call through `app.request()` (Hono's in-process dispatch, the exact
 * mechanism apps/server/test.js already uses for its own "real route" tests)
 * instead of a socket. The one deliberately-injected failure (see
 * `failFirstItemPushMarker`) is delivered as a real HTTP 500 that
 * `serverFetch()`'s real error-handling path throws on — nothing about
 * pushToServer/pushEventsToServer/syncAll themselves is stubbed.
 *
 * Must run under plain `node --test` against the compiled output
 * (`dist/main/sync.test.js`) — the desktop datastore/profiles modules use
 * `node:sqlite` directly and have no Electron dependency, so no build+launch
 * of the full Electron test gate is needed to exercise this module.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-sync-events-server-'));
process.env.DATA_DIR = TEST_DATA_DIR;

// The server (apps/server/) is a separate CommonJS project — require() it
// directly rather than trying to make TypeScript's ESM resolution reach
// across package boundaries. Set DATA_DIR (above) before this ever runs.
const require = createRequire(import.meta.url);

// Resolved from THIS file's own runtime location, not written as a literal
// relative specifier: this test only ever runs compiled (dist/main/, three
// levels below apps/desktop/), never from the main/ source tree directly
// (see file header), so a literal '../../server' would be one level short at
// runtime even though it reads correctly against the source layout.
const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../server');

// A URL that is never actually connected to — every desktop -> "server" call
// in this file is intercepted by the fetch stub installed in setup() below
// and routed to the real Hono app in-process.
const FAKE_SERVER_URL = 'http://fake-sync-test-server';

let serverApp: { request: (path: string, init?: RequestInit) => Promise<Response> };
let users: { createUser: (userId: string) => { userId: string; apiKey: string } };
let datastore: typeof import('./datastore.js');
let profiles: typeof import('./profiles.js');
let sync: typeof import('./sync.js');
let originalFetch: typeof fetch;

describe('Event push watermark — cross-run stranding regression', () => {
  before(async () => {
    ({ app: serverApp } = require(path.join(SERVER_DIR, 'index.js')));
    users = require(path.join(SERVER_DIR, 'users.js'));
    datastore = await import('./datastore.js');
    profiles = await import('./profiles.js');
    sync = await import('./sync.js');
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  function authHeaders(apiKey: string) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  }

  /**
   * Wires a fresh desktop datastore + profile (both are module-level
   * singletons in datastore.ts/profiles.ts, so each call replaces the
   * previous test's instance — safe because node:test runs this file's
   * tests sequentially, matching the rest of this describe block) and a
   * fresh server-side user. Installs a fetch stub that routes every call
   * through the real app via `app.request()`, EXCEPT: if
   * `failFirstItemPushMarker` is given, the first POST /items request whose
   * body contains that marker is answered with a real HTTP 500 instead of
   * being forwarded — simulating exactly the "item push fails once, then
   * succeeds on retry" case pushToServer()'s own per-item try/catch already
   * has to tolerate in production.
   */
  function setup(name: string, opts: { failFirstItemPushMarker?: string } = {}) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `evtwm-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    let failedOnce = false;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      const bodyText = typeof init.body === 'string' ? init.body : '';

      if (
        opts.failFirstItemPushMarker &&
        !failedOnce &&
        method === 'POST' &&
        reqPath.startsWith('/items') &&
        bodyText.includes(opts.failFirstItemPushMarker)
      ) {
        failedOnce = true;
        return new Response(JSON.stringify({ error: 'simulated network failure' }), { status: 500 });
      }

      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    return { apiKey };
  }

  async function fetchServerEventIds(apiKey: string): Promise<string[]> {
    const res = await serverApp.request('/events/since/0', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { events: Array<{ id: string }> };
    return json.events.map((e) => e.id).sort();
  }

  async function fetchServerItemCount(apiKey: string): Promise<number> {
    const res = await serverApp.request('/items', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { items: unknown[] };
    return json.items.length;
  }

  it('an item whose push fails on run 1 still gets its events synced once its own push succeeds on run 2', async () => {
    const FLAKY_MARKER = 'flaky-series-marker-9f3a';
    const { apiKey } = setup('run1-item-failure', { failFirstItemPushMarker: FLAKY_MARKER });

    const db = datastore.getDb();
    const now = Date.now();
    const itemId = 'local-flaky-series-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, ?, '', 0, ?, ?, 0)
    `).run(itemId, JSON.stringify({ marker: FLAKY_MARKER, title: 'Flaky series' }), now, now);

    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-a', itemId, 100, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-b', itemId, 101, now + 10, now + 10);

    // Run 1: the item's own push is rejected (simulated failure). The sync
    // run as a whole still completes without throwing — pushToServer()
    // isolates per-item failures — so the watermark(s) still advance.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    assert.strictEqual(
      await fetchServerItemCount(apiKey),
      0,
      'run 1: the flaky item must not have reached the server'
    );
    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      [],
      'run 1: nothing should have reached the server — the parent item never got a syncId'
    );

    // Run 2: the same item push now succeeds (the fetch stub only fails once).
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    assert.strictEqual(
      await fetchServerItemCount(apiKey),
      1,
      'run 2: the item must now have reached the server'
    );
    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-a', 'evt-b'],
      'run 2: both events must reach the server now that their parent item has synced — ' +
      'a watermark that advanced past their createdAt during run 1 must not strand them forever'
    );
  });

  it('an event created between the push query and the watermark write is not lost on the next run', async () => {
    const { apiKey } = setup('mid-run-race');

    // Establish a parent item that is ALREADY synced on both sides, so this
    // test can control the exact moment event B is created relative to
    // pushEventsToServer()'s own SELECT without any item-push noise.
    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Mid-run race series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-midrun-series-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-race-a', localItemId, 1, now, now);

    // Start the push WITHOUT awaiting it yet. pushEventsToServer's own
    // SELECT runs synchronously before its first `await`, so event B —
    // inserted on the very next line, before this call is ever awaited — is
    // guaranteed to be created strictly after that SELECT already ran, and
    // therefore cannot be part of this run's batch no matter its timestamp.
    const pushPromise = sync.pushEventsToServer(FAKE_SERVER_URL, apiKey);

    const eventBCreatedAt = Date.now();
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-race-b', localItemId, 2, eventBCreatedAt, eventBCreatedAt);

    await pushPromise;

    // Next run: pushEventsToServer reads back whatever watermark the FIRST
    // call just persisted. If that watermark advanced past event B's
    // createdAt even though event B was never sent, it is lost here.
    await sync.pushEventsToServer(FAKE_SERVER_URL, apiKey);

    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-race-a', 'evt-race-b'],
      'an event created while a push is in flight must not be permanently skipped by ' +
      'the watermark that same push advances to afterward'
    );
  });
});
