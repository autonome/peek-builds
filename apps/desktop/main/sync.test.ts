/**
 * Unit tests for the event-sync watermark in sync.ts, and (second describe
 * block below) for tag metadata sync (pushTagsToServer/pullTagsFromServer/
 * mergeServerTag).
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
import { DATASTORE_VERSION } from '../version.js';

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
  function setup(name: string, opts: {
    failFirstItemPushMarker?: string;
    // Fails the FIRST POST /events request outright (a 400, regardless of
    // body content) — simulates a whole chunk rejected by the server/network,
    // independent of the per-event validation `failFirstItemPushMarker`-style
    // marker matching exercises. Only fires once per setup(), same shape as
    // the item-push flake above.
    failFirstEventPushOnce?: boolean;
  } = {}) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `evtwm-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    let failedOnce = false;
    let eventChunkFailedOnce = false;
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

      if (
        opts.failFirstEventPushOnce &&
        !eventChunkFailedOnce &&
        method === 'POST' &&
        reqPath.startsWith('/events')
      ) {
        eventChunkFailedOnce = true;
        return new Response(JSON.stringify({ error: 'simulated chunk rejection' }), { status: 400 });
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

  /** Reads back the delivery stamp pushEventsToServer() writes on each event it
   * got the server to accept (item_events.pushedAt; 0 means never delivered). */
  function readEventPushedAt(eventId: string): number {
    const db = datastore.getDb();
    const row = db.prepare(`
      SELECT pushedAt FROM item_events WHERE id = ?
    `).get(eventId) as { pushedAt: number } | undefined;
    return row ? row.pushedAt : 0;
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

  it('a malformed event is dropped, the rest of the batch reaches the server, and syncAll does not throw — and the drop does not strand the row past repair', async () => {
    const { apiKey } = setup('malformed-event-dropped');

    // Parent item already synced on both sides, same shape as 'mid-run-race'
    // above, so this test isolates event validation with no item-push noise.
    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Malformed event series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-malformed-series-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-good', localItemId, 1, now, now);

    // Simulates the NaN an unparseable RSS <pubDate> produces (see
    // features/feeds/background.js): occurredAt is declared NOT NULL, so
    // node:sqlite rejects a literal NULL/NaN outright — a non-numeric string
    // is the value shape that actually lands in the column (SQLite's dynamic
    // typing stores it as-is) and fails the exact same `Number.isFinite`
    // check on the way back out.
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, 'not-a-number', '{}', ?)
    `).run('evt-bad', localItemId, 2, now + 10);

    // Run 1: syncAll must complete without throwing even though one event in
    // the batch is malformed — the server 400s the WHOLE request if a bad row
    // rides along (apps/server/index.js POST /events), so the malformed row
    // must never reach the request body.
    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-good'],
      'run 1: the well-formed event must reach the server; the malformed one must be dropped, not block the batch'
    );

    // Run 2: repair the bad row to a valid timestamp. If the watermark had
    // advanced past its createdAt during run 1 (the row was dropped, not
    // pushed), this event would be permanently excluded from every future
    // run's query even after the underlying data is fixed.
    db.prepare(`UPDATE item_events SET occurredAt = ? WHERE id = ?`).run(now + 10, 'evt-bad');
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-bad', 'evt-good'],
      'run 2: the repaired event must now reach the server — a dropped row must not be stranded past repair'
    );
  });

  it('a chunk the server rejects does not prevent lastSyncTime from advancing, and its events retry on the next run', async () => {
    const { apiKey } = setup('event-chunk-rejected', { failFirstEventPushOnce: true });

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Chunk-rejected series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-chunk-rejected-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-chunk-rejected', localItemId, 1, now, now);

    const profileBefore = profiles.getActiveProfile();
    assert.strictEqual(profileBefore.lastSyncAt || 0, 0, 'precondition: this profile has never synced');

    // Run 1: the event push chunk is rejected outright (simulated 400). The
    // sync run as a whole must still complete without throwing — event push
    // is isolated as its own stage — so updateLastSyncTime/saveSyncServerConfig
    // still run and the failure surfaces as a stage error instead of aborting.
    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const profileAfterRun1 = profiles.getActiveProfile();
    assert.ok(
      (profileAfterRun1.lastSyncAt || 0) > 0,
      'run 1: lastSyncTime must still be written even though the event chunk was rejected'
    );
    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      [],
      'run 1: the rejected chunk must not have reached the server'
    );
    const statusAfterRun1 = sync.getSyncStatus();
    assert.ok(statusAfterRun1.lastError, 'run 1: the event-push stage failure must be recorded as a sync error');

    // Run 2: the same chunk now succeeds (the fetch stub only rejects once) —
    // the failed chunk's events must have stayed eligible, not been swept past
    // by a watermark that advanced despite never delivering them.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-chunk-rejected'],
      'run 2: the previously-rejected event must now reach the server'
    );
    const statusAfterRun2 = sync.getSyncStatus();
    assert.strictEqual(statusAfterRun2.lastError, null, 'run 2: a fully successful run must clear the prior stage error');
  });

  it('an item that can never sync strands only its own events, and a second run re-pushes nothing', async () => {
    const { apiKey } = setup('unsyncable-item-strands-only-itself');

    // Parent item already synced on both sides, so its event is eligible for
    // this run — it is what proves the two unsynced items below hold back only
    // their own events, not everything created after them.
    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Blocked-item watermark series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();

    // Oldest: a DELETED item that never synced (syncId === ''). It never will —
    // pushToServer() only sends a tombstone whose syncId is already set — which is
    // exactly the case that used to pin a global watermark forever and make every
    // run re-push the entire event tail behind it.
    const deletedItemId = 'local-deleted-never-synced-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', '', 0, ?, ?, ?)
    `).run(deletedItemId, now, now, now + 1);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-deleted-item-old', deletedItemId, 1, now, now);

    // Middle: a LIVE item that never synced yet — it could still sync on a later
    // run, so its event must stay eligible rather than being written off.
    const liveItemId = 'local-live-never-synced-item';
    const liveEventCreatedAt = now + 10;
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', '', 0, ?, ?, 0)
    `).run(liveItemId, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-live-item-old', liveItemId, 2, liveEventCreatedAt, liveEventCreatedAt);

    // Newest: an event on the already-synced item — the one that must get
    // through despite being created after both blocked events.
    const syncedItemId = 'local-blocked-watermark-synced-item';
    const syncedEventCreatedAt = now + 20;
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(syncedItemId, serverItemId, now, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-synced-item-new', syncedItemId, 3, syncedEventCreatedAt, syncedEventCreatedAt);

    await sync.pushEventsToServer(FAKE_SERVER_URL, apiKey);

    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-synced-item-new'],
      'only the already-synced item\'s event should reach the server this run — the other two have no server item to belong to yet'
    );

    assert.ok(
      readEventPushedAt('evt-synced-item-new') > 0,
      'the delivered event must be stamped, so no later run sends it again'
    );
    assert.strictEqual(
      readEventPushedAt('evt-deleted-item-old'),
      0,
      `the deleted never-synced item's event (createdAt ${now}) must stay unstamped and eligible — but it holds back nothing else`
    );
    assert.strictEqual(
      readEventPushedAt('evt-live-item-old'),
      0,
      `the live never-synced item's event (createdAt ${liveEventCreatedAt}) must stay eligible — its item could still sync on a later run`
    );

    // The regression this replaces a global watermark to prevent: with one, an
    // item that can never sync held the watermark below its own event forever,
    // so every subsequent run re-selected and re-pushed the entire event tail
    // after it — 24,000 events per run, measured against production. Per-event
    // stamps mean run 2 has nothing to send at all.
    const secondRun = await sync.pushEventsToServer(FAKE_SERVER_URL, apiKey);
    assert.strictEqual(
      secondRun.pushed,
      0,
      'run 2 must push nothing — an unsyncable item must not make already-delivered events eligible again'
    );
    assert.deepStrictEqual(
      await fetchServerEventIds(apiKey),
      ['evt-synced-item-new'],
      'run 2: no new events should have reached the server — the synced item\'s event was already delivered'
    );
  });
});

describe('Sync progress log — sync:progress emission and the bounded ring buffer', () => {
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

  /** Same shape as the event-sync describe block's setup() above: a fresh
   * profile + fetch stub routed to the real server in-process, optionally
   * rejecting the first POST /events chunk outright. */
  function setup(name: string, opts: {
    failFirstEventPushOnce?: boolean;
    // Called for every POST /items request; returning a string fails THAT
    // request with a 500 whose body is the returned string (so it ends up
    // verbatim as serverFetch()'s thrown error message). Unlike
    // failFirstItemPushMarker in the other describe block, this applies to
    // every call, not just the first — the grouping tests below need many
    // items to fail, not one.
    itemPushFailureFor?: (bodyText: string) => string | undefined;
    // Overrides the HTTP status used for an itemPushFailureFor failure —
    // defaults to 500 (transient) when omitted. Lets a test drive a 4xx
    // (permanent, per isPermanentPushFailure()) failure through the same stub.
    itemPushStatusFor?: (bodyText: string) => number;
    // Answers POST /items/batch with a 404, the way a server predating that
    // route does, so the push falls back to one request per item. The two hooks
    // above describe ONE item's fate, and only the single-item route can express
    // that — a batched chunk gets one status for all 250 of it.
    noBatchRoute?: boolean;
  } = {}) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-progresslog-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `progresslog-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    let eventChunkFailedOnce = false;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      const bodyText = typeof init.body === 'string' ? init.body : '';

      if (opts.noBatchRoute && method === 'POST' && reqPath.startsWith('/items/batch')) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }

      if (opts.itemPushFailureFor && method === 'POST' && reqPath.startsWith('/items')) {
        const failMessage = opts.itemPushFailureFor(bodyText);
        if (failMessage !== undefined) {
          const status = opts.itemPushStatusFor ? opts.itemPushStatusFor(bodyText) : 500;
          return new Response(failMessage, { status });
        }
      }

      if (
        opts.failFirstEventPushOnce &&
        !eventChunkFailedOnce &&
        method === 'POST' &&
        reqPath.startsWith('/events')
      ) {
        eventChunkFailedOnce = true;
        return new Response(JSON.stringify({ error: 'simulated chunk rejection' }), { status: 400 });
      }

      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    return { apiKey };
  }

  it('a full syncAll run emits stage-start and stage-finish entries for all six stages, in order', async () => {
    const { apiKey } = setup('six-stages');

    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    const boundaryKeys = sync.getSyncLog()
      .filter((e) => e.phase === 'start' || e.phase === 'finish')
      .map((e) => `${e.stage}:${e.phase}`);

    // Nothing to pull/push in this run, so no throttled item-push progress
    // entries land between push-items' own start/finish — the sequence
    // below is exactly syncAll()'s own stage order, bracketed by the run
    // itself.
    assert.deepStrictEqual(boundaryKeys, [
      'run:start',
      'pull-tags:start', 'pull-tags:finish',
      'pull-items:start', 'pull-items:finish',
      'pull-events:start', 'pull-events:finish',
      'push-tags:start', 'push-tags:finish',
      'push-items:start', 'push-items:finish',
      'push-events:start', 'push-events:finish',
      'run:finish',
    ]);
  });

  it('item-push progress is throttled: a run pushing many items emits far fewer progress entries than items, and the last entry carries the true final count', async () => {
    const { apiKey } = setup('item-throttle');

    const ITEM_COUNT = 250;
    const db = datastore.getDb();
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `);
    for (let i = 0; i < ITEM_COUNT; i++) {
      insert.run(`local-throttle-item-${i}`, `throttle test item ${i}`, now, now);
    }

    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    const progressEntries = sync.getSyncLog().filter((e) => e.stage === 'push-items' && e.phase === 'progress');

    assert.ok(
      progressEntries.length > 0 && progressEntries.length < ITEM_COUNT / 10,
      `expected a throttled number of progress entries, got ${progressEntries.length} for ${ITEM_COUNT} items`
    );
    const last = progressEntries[progressEntries.length - 1];
    assert.ok(
      last.message.includes(`${ITEM_COUNT} / ${ITEM_COUNT}`),
      `expected the last progress entry to carry the true final count, got: ${last.message}`
    );
  });

  it('several item pushes failing with the SAME error produce one grouped log entry, not one per item', async () => {
    const { apiKey } = setup('item-fail-same-reason', {
      itemPushFailureFor: () => 'simulated identical push failure',
    });

    const ITEM_COUNT = 4;
    const db = datastore.getDb();
    const now = Date.now();
    const CONTENT_MARKER = 'item-content-must-not-leak-into-the-log';
    const insert = db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `);
    for (let i = 0; i < ITEM_COUNT; i++) {
      insert.run(`local-fail-same-${i}`, `${CONTENT_MARKER}-${i}`, now, now);
    }

    // pushToServer() isolates per-item failures — the run as a whole must
    // still complete even though every item in it fails to push.
    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const failureEntries = log.filter((e) => e.stage === 'push-items' && e.phase === 'error');

    assert.strictEqual(
      failureEntries.length,
      1,
      `expected exactly one grouped entry for identical failures, got ${failureEntries.length}: ` +
      JSON.stringify(failureEntries.map((e) => e.message))
    );
    assert.ok(
      failureEntries[0].message.includes(`${ITEM_COUNT} item(s)`),
      `expected the grouped entry to carry the true failure count, got: ${failureEntries[0].message}`
    );
    assert.ok(
      failureEntries[0].message.includes('simulated identical push failure'),
      `expected the grouped entry to carry the failure reason, got: ${failureEntries[0].message}`
    );
    for (let i = 0; i < ITEM_COUNT; i++) {
      assert.ok(
        failureEntries[0].message.includes(`local-fail-same-${i}`),
        `expected the grouped entry to name item local-fail-same-${i} (small failure count), got: ${failureEntries[0].message}`
      );
    }
    assert.ok(
      !log.some((e) => e.message.includes(CONTENT_MARKER)),
      'expected no log entry to contain item content'
    );
  });

  it('six item pushes failing with the SAME error list all six ids — the raised PUSH_FAILURE_IDS_MAX', async () => {
    const { apiKey } = setup('item-fail-six-ids', {
      itemPushFailureFor: () => 'simulated identical push failure',
    });

    // Past the old cap of 5, within the current cap of 20 — the six ids
    // must all be listed, which the old cap would have suppressed entirely.
    const ITEM_COUNT = 6;
    const db = datastore.getDb();
    const now = Date.now();
    const CONTENT_MARKER = 'item-content-must-not-leak-into-the-log';
    const insert = db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `);
    for (let i = 0; i < ITEM_COUNT; i++) {
      insert.run(`local-fail-six-${i}`, `${CONTENT_MARKER}-${i}`, now, now);
    }

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const failureEntries = log.filter((e) => e.stage === 'push-items' && e.phase === 'error');

    assert.strictEqual(
      failureEntries.length,
      1,
      `expected exactly one grouped entry for identical failures, got ${failureEntries.length}: ` +
      JSON.stringify(failureEntries.map((e) => e.message))
    );
    for (let i = 0; i < ITEM_COUNT; i++) {
      assert.ok(
        failureEntries[0].message.includes(`local-fail-six-${i}`),
        `expected the grouped entry to name item local-fail-six-${i} (6 failures, within the raised cap), got: ${failureEntries[0].message}`
      );
    }
    assert.ok(
      !log.some((e) => e.message.includes(CONTENT_MARKER)),
      'expected no log entry to contain item content'
    );
  });

  it('a 4xx item failure logs as permanent and a 5xx item failure logs as retryable in the same run', async () => {
    const PERMANENT_MARKER = 'permanent-marker';
    const TRANSIENT_MARKER = 'transient-marker';
    const { apiKey } = setup('item-fail-mixed-permanence', {
      // Per-item statuses, so the single-item route: one batched chunk carrying
      // both markers could only come back with one status for both.
      noBatchRoute: true,
      itemPushFailureFor: (bodyText) =>
        bodyText.includes(PERMANENT_MARKER)
          ? `content is required for type 'text'`
          : 'simulated server outage',
      itemPushStatusFor: (bodyText) => (bodyText.includes(PERMANENT_MARKER) ? 400 : 500),
    });

    const db = datastore.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `).run('local-permanent-item', PERMANENT_MARKER, now, now);
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `).run('local-transient-item', TRANSIENT_MARKER, now, now);

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const failureEntries = log.filter((e) => e.stage === 'push-items' && e.phase === 'error');

    const permanentEntry = failureEntries.find((e) => e.message.includes('local-permanent-item'));
    assert.ok(permanentEntry, `expected an entry naming the 4xx item, got: ${JSON.stringify(failureEntries.map((e) => e.message))}`);
    assert.ok(
      permanentEntry!.message.includes('parked until the item changes'),
      `expected the 4xx failure to be worded as permanent, got: ${permanentEntry!.message}`
    );

    const transientEntry = failureEntries.find((e) => e.message.includes('local-transient-item'));
    assert.ok(transientEntry, `expected an entry naming the 5xx item, got: ${JSON.stringify(failureEntries.map((e) => e.message))}`);
    assert.ok(
      transientEntry!.message.includes('will retry next run'),
      `expected the 5xx failure to be worded as retryable, got: ${transientEntry!.message}`
    );

    assert.ok(
      !log.some((e) => e.message.includes(PERMANENT_MARKER) || e.message.includes(TRANSIENT_MARKER)),
      'expected no log entry to contain item content'
    );
  });

  it('a 4xx event chunk rejection is logged as permanent, not retryable', async () => {
    const { apiKey } = setup('event-chunk-permanent', { failFirstEventPushOnce: true });

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Event chunk permanence series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-event-chunk-permanent-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-chunk-permanent', localItemId, 1, now, now);

    // setup()'s failFirstEventPushOnce rejects the chunk with a 400 —
    // exercises isPermanentPushFailure()'s 4xx branch for an event chunk.
    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const chunkFailure = log.find((e) => e.stage === 'push-events' && e.phase === 'error');
    assert.ok(chunkFailure, 'expected a log entry for the rejected chunk');
    assert.ok(
      chunkFailure!.message.includes('will not succeed until the events change'),
      `expected the 4xx chunk rejection to be worded as permanent, got: ${chunkFailure!.message}`
    );
  });

  it('item pushes failing with DIFFERENT errors produce one entry per distinct reason, capped with a rolled-up tail', async () => {
    let counter = 0;
    const { apiKey } = setup('item-fail-different-reasons', {
      // A distinct reason per item needs a request per item — batched, all 40
      // would share one chunk-level failure and one log line.
      noBatchRoute: true,
      itemPushFailureFor: () => `distinct push failure #${counter++}`,
    });

    // Comfortably more than any reasonable per-run cap on distinct reasons —
    // proves the summary collapses instead of growing one line per item.
    const ITEM_COUNT = 40;
    const db = datastore.getDb();
    const now = Date.now();
    const CONTENT_MARKER = 'item-content-must-not-leak-into-the-log';
    const insert = db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `);
    for (let i = 0; i < ITEM_COUNT; i++) {
      insert.run(`local-fail-diff-${i}`, `${CONTENT_MARKER}-${i}`, now, now);
    }

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const failureEntries = log.filter((e) => e.stage === 'push-items' && e.phase === 'error');

    assert.ok(
      failureEntries.length > 1 && failureEntries.length < ITEM_COUNT,
      `expected more than one but far fewer than ${ITEM_COUNT} entries (capped + rolled-up tail), got ${failureEntries.length}`
    );
    assert.ok(
      failureEntries.some((e) => e.message.includes('more distinct error')),
      `expected a rolled-up "N more" tail entry among: ${JSON.stringify(failureEntries.map((e) => e.message))}`
    );
    assert.ok(
      !log.some((e) => e.message.includes(CONTENT_MARKER)),
      'expected no log entry to contain item content'
    );
  });

  it('a dropped malformed event and a rejected chunk each produce a log entry', async () => {
    const { apiKey } = setup('dropped-and-failed', { failFirstEventPushOnce: true });

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Progress log series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-progresslog-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    // A well-formed event (rides in the batch the fetch stub rejects once —
    // exercises the rejected-chunk log entry) and a malformed one (dropped
    // before it ever reaches a request — exercises the dropped-event entry).
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-progresslog-good', localItemId, 1, now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, 'not-a-number', '{}', ?)
    `).run('evt-progresslog-bad', localItemId, 2, now + 10);

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();

    const dropped = log.find((e) => e.stage === 'push-events' && e.phase === 'dropped');
    assert.ok(dropped, 'expected a dropped-event log entry for the malformed row');
    assert.ok(
      dropped!.message.includes('evt-progresslog-bad'),
      `expected the dropped entry to name the row, got: ${dropped!.message}`
    );

    const chunkFailure = log.find((e) => e.stage === 'push-events' && e.phase === 'error');
    assert.ok(chunkFailure, 'expected a log entry for the rejected chunk');
    assert.ok(
      chunkFailure!.message.includes('simulated chunk rejection'),
      `expected the rejected-chunk entry to carry the server's own error message, got: ${chunkFailure!.message}`
    );
  });

  it('several malformed events dropped for the SAME reason produce one grouped log entry, not one per event', async () => {
    const { apiKey } = setup('event-drop-same-reason');

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Event drop grouping series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-event-drop-same-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    const CONTENT_MARKER = 'event-content-must-not-leak-into-the-log';
    const EVENT_COUNT = 3;
    const insert = db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, ?, ?, 'not-a-number', '{}', ?)
    `);
    for (let i = 0; i < EVENT_COUNT; i++) {
      insert.run(`evt-drop-same-${i}`, localItemId, `${CONTENT_MARKER}-${i}`, i, now + i);
    }

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const droppedEntries = log.filter((e) => e.stage === 'push-events' && e.phase === 'dropped');

    assert.strictEqual(
      droppedEntries.length,
      1,
      `expected exactly one grouped drop entry for identical reasons, got ${droppedEntries.length}: ` +
      JSON.stringify(droppedEntries.map((e) => e.message))
    );
    assert.ok(
      droppedEntries[0].message.includes(`${EVENT_COUNT} event(s)`),
      `expected the grouped entry to carry the true drop count, got: ${droppedEntries[0].message}`
    );
    assert.ok(
      droppedEntries[0].message.includes('non-numeric occurredAt'),
      `expected the grouped entry to say what was wrong, got: ${droppedEntries[0].message}`
    );
    for (let i = 0; i < EVENT_COUNT; i++) {
      assert.ok(
        droppedEntries[0].message.includes(`evt-drop-same-${i}`),
        `expected the grouped entry to name evt-drop-same-${i} (small drop count), got: ${droppedEntries[0].message}`
      );
    }
    assert.ok(
      !log.some((e) => e.message.includes(CONTENT_MARKER)),
      'expected no log entry to contain event content'
    );
  });

  it('malformed events dropped for DIFFERENT reasons produce one entry per distinct reason', async () => {
    const { apiKey } = setup('event-drop-different-reasons');

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Event drop reasons series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-event-drop-diff-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    const CONTENT_MARKER = 'event-content-must-not-leak-into-the-log';
    // Two independently-bad fields — two distinct reason strings. The second
    // row uses a missing id (rather than a bad createdAt) to keep this test
    // clear of createdAt's role in the watermark math below.
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, ?, ?, 'not-a-number', '{}', ?)
    `).run('evt-drop-diff-occurred', localItemId, `${CONTENT_MARKER}-a`, 1, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES ('', ?, ?, ?, ?, '{}', ?)
    `).run(localItemId, `${CONTENT_MARKER}-b`, 2, now + 2, now + 1);

    await assert.doesNotReject(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const log = sync.getSyncLog();
    const droppedEntries = log.filter((e) => e.stage === 'push-events' && e.phase === 'dropped');

    assert.strictEqual(
      droppedEntries.length,
      2,
      `expected one entry per distinct drop reason, got ${droppedEntries.length}: ` +
      JSON.stringify(droppedEntries.map((e) => e.message))
    );
    assert.ok(
      droppedEntries.some((e) => e.message.includes('non-numeric occurredAt') && e.message.includes('evt-drop-diff-occurred')),
      `expected an entry for the bad-occurredAt row, got: ${JSON.stringify(droppedEntries.map((e) => e.message))}`
    );
    assert.ok(
      droppedEntries.some((e) => e.message.includes('missing id') && e.message.includes('(no id)')),
      `expected an entry for the missing-id row, got: ${JSON.stringify(droppedEntries.map((e) => e.message))}`
    );
    assert.ok(
      !log.some((e) => e.message.includes(CONTENT_MARKER)),
      'expected no log entry to contain event content'
    );
  });

  it('the buffer is bounded across a long run and is cleared at the start of a new run', async () => {
    const { apiKey } = setup('bounded-buffer');

    // Fill the buffer well past its cap through the exact bounded-buffer
    // path production log calls use — no need for thousands of real network
    // round trips to prove the ring buffer trims.
    for (let i = 0; i < 1000; i++) {
      sync.__logSyncProgressForTest('push-items', 'progress', `synthetic entry ${i}`);
    }
    const filled = sync.getSyncLog();
    assert.ok(filled.length < 1000, 'expected the ring buffer to have trimmed older entries');
    assert.strictEqual(
      filled[filled.length - 1].message,
      'synthetic entry 999',
      'the buffer must keep the MOST RECENT entries, not the oldest'
    );
    const cappedLength = filled.length;

    // A second flood must not grow the buffer further.
    for (let i = 0; i < 500; i++) {
      sync.__logSyncProgressForTest('push-items', 'progress', `synthetic entry b${i}`);
    }
    assert.strictEqual(sync.getSyncLog().length, cappedLength, 'the buffer must stay bounded, not grow further');

    // A new syncAll() run must start from an empty log, not append to the
    // synthetic flood above.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);
    const afterRun = sync.getSyncLog();
    assert.ok(
      afterRun.every((e) => !e.message.startsWith('synthetic entry')),
      'syncAll() must clear the previous run\'s log, not append to it'
    );
    assert.strictEqual(afterRun[0].stage, 'run');
    assert.strictEqual(afterRun[0].phase, 'start');
  });

  it('event push progress states the batch plan up front and the last entry carries the true final count across multiple batches', async () => {
    const { apiKey } = setup('event-push-progress');

    const createRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'Event push progress series' } }),
    });
    const { id: serverItemId } = (await createRes.json()) as { id: string };

    const db = datastore.getDb();
    const now = Date.now();
    const localItemId = 'local-event-push-progress-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', ?, ?, ?, ?, 0)
    `).run(localItemId, serverItemId, now, now, now);

    // One more than sync.ts's own MAX_EVENTS_PER_PUSH (500) — forces the chunk
    // loop to run twice, the exact "tens of thousands of events, nothing
    // logged until the finish line" shape this progress logging exists for.
    const MAX_EVENTS_PER_PUSH = 500;
    const EVENT_COUNT = MAX_EVENTS_PER_PUSH + 1;
    const insert = db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `);
    for (let i = 0; i < EVENT_COUNT; i++) {
      insert.run(`evt-push-progress-${i}`, localItemId, i, now + i, now + i);
    }

    await sync.pushEventsToServer(FAKE_SERVER_URL, apiKey);

    const progressEntries = sync.getSyncLog().filter((e) => e.stage === 'push-events' && e.phase === 'progress');

    const planEntry = progressEntries.find(
      (e) => e.message.includes(`${EVENT_COUNT} event(s)`) && e.message.includes('batch(es)')
    );
    assert.ok(
      planEntry,
      `expected an entry stating the total event count and batch count before the chunk loop starts, got: ${JSON.stringify(progressEntries.map((e) => e.message))}`
    );

    // Intermediate per-batch entries are time-throttled (ITEM_PUSH_PROGRESS_INTERVAL_MS)
    // and may not appear at all in a fast test run — assert only that progress
    // reaches the true final count, not on how many intermediate entries land.
    const last = progressEntries[progressEntries.length - 1];
    assert.ok(
      last.message.includes(`${EVENT_COUNT} / ${EVENT_COUNT}`),
      `expected the final progress entry to carry the true final count, got: ${last.message}`
    );
  });

  it('emitting progress with no renderer listening does not throw', () => {
    // No BrowserWindow / pubsub broadcaster exists in this plain `node
    // --test` environment — the exact "no renderer listening" case a real
    // desktop run hits when Settings isn't open.
    assert.doesNotThrow(() => {
      sync.__logSyncProgressForTest('run', 'start', 'no listener test');
    });
  });
});

describe('Tag metadata sync — push/pull/merge', () => {
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

  /** Same shape as the event-sync describe block's setup() above, but the
   * failure marker (if given) intercepts POST /tags instead of POST /items —
   * tag push has its own watermark and its own retry-safety guarantee to
   * verify (getTagPushWatermark()'s doc comment in sync.ts). */
  function setup(name: string, opts: { failFirstTagPushMarker?: string } = {}) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-tags-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `tagwm-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    let failedOnce = false;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      const bodyText = typeof init.body === 'string' ? init.body : '';

      if (
        opts.failFirstTagPushMarker &&
        !failedOnce &&
        method === 'POST' &&
        reqPath.startsWith('/tags') &&
        bodyText.includes(opts.failFirstTagPushMarker)
      ) {
        failedOnce = true;
        return new Response(JSON.stringify({ error: 'simulated network failure' }), { status: 500 });
      }

      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    return { apiKey };
  }

  async function fetchServerTags(apiKey: string): Promise<Array<{
    name: string;
    color?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    parentId?: string;
  }>> {
    const res = await serverApp.request('/tags/since/0', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { tags: Array<Record<string, unknown>> };
    return json.tags as never;
  }

  /** Seeds a tag directly on the server (bypassing desktop push) so a test can
   * control pull inputs precisely — the same "seed server, then exercise the
   * client's pull path" shape the event tests use via POST /items. */
  async function pushServerTag(apiKey: string, tag: Record<string, unknown>): Promise<void> {
    await serverApp.request('/tags', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tags: [tag] }),
    });
  }

  function insertLocalTag(fields: {
    id: string;
    name: string;
    color?: string;
    description?: string;
    metadata?: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    const db = datastore.getDb();
    db.prepare(`
      INSERT INTO tags (id, name, slug, color, parentId, description, metadata, createdAt, updatedAt, frequency, lastUsed, frecencyScore)
      VALUES (?, ?, '', ?, '', ?, ?, ?, ?, 0, 0, 0)
    `).run(
      fields.id, fields.name, fields.color || '#999999',
      fields.description || '', fields.metadata || '{}', fields.createdAt, fields.updatedAt
    );
  }

  it('a tag pushes its color, description, and metadata to the server', async () => {
    const { apiKey } = setup('push-metadata');
    const now = Date.now();
    insertLocalTag({
      id: 'local-tag-reading', name: 'reading', color: '#00aaff',
      description: 'Books and articles', metadata: JSON.stringify({ icon: 'book' }),
      createdAt: now, updatedAt: now,
    });

    await sync.pushTagsToServer(FAKE_SERVER_URL, apiKey);

    const serverTags = await fetchServerTags(apiKey);
    const reading = serverTags.find((t) => t.name === 'reading');
    assert.ok(reading, 'the tag must have reached the server');
    assert.strictEqual(reading!.color, '#00aaff');
    assert.strictEqual(reading!.description, 'Books and articles');
    assert.deepStrictEqual(reading!.metadata, { icon: 'book' });
  });

  it('a pull applies a server tag\'s color, description, and metadata locally', async () => {
    const { apiKey } = setup('pull-metadata');
    const now = Date.now();
    await pushServerTag(apiKey, {
      name: 'travel', color: '#ff00aa', description: 'Trips',
      metadata: { icon: 'plane' }, createdAt: now, updatedAt: now,
    });

    await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey);

    const db = datastore.getDb();
    const local = db.prepare('SELECT * FROM tags WHERE name = ?').get('travel') as {
      color: string; description: string; metadata: string;
    } | undefined;
    assert.ok(local, 'the tag must exist locally after pull');
    assert.strictEqual(local!.color, '#ff00aa');
    assert.strictEqual(local!.description, 'Trips');
    assert.deepStrictEqual(JSON.parse(local!.metadata), { icon: 'plane' });
  });

  it('a parent arriving after its child in the same pull still ends up linked', async () => {
    const { apiKey } = setup('parent-after-child');
    const now = Date.now();
    // /tags/since orders by updatedAt ASC, so giving the child the earlier
    // updatedAt reproduces "child before parent" in the pulled batch — the
    // case a single-pass merge would fail (the parent doesn't exist locally
    // yet when the child is processed).
    await pushServerTag(apiKey, { name: 'child-tag', parentId: 'parent-tag', createdAt: now, updatedAt: now });
    await pushServerTag(apiKey, { name: 'parent-tag', createdAt: now, updatedAt: now + 1 });

    await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey);

    const db = datastore.getDb();
    const child = db.prepare('SELECT * FROM tags WHERE name = ?').get('child-tag') as { parentId: string } | undefined;
    const parent = db.prepare('SELECT * FROM tags WHERE name = ?').get('parent-tag') as { id: string } | undefined;
    assert.ok(child && parent);
    assert.strictEqual(child!.parentId, parent!.id);
  });

  it('a cycle in incoming parentId links is broken deterministically, and a second, independent pull of the same input breaks the same link', async () => {
    const { apiKey } = setup('cycle-break-1');
    const now = Date.now();
    // cycle-a -> cycle-b -> cycle-a, with distinct updatedAt so the "newest
    // updatedAt loses its parent link" rule has an unambiguous winner
    // (cycle-b), independent of the id tie-break.
    await pushServerTag(apiKey, { name: 'cycle-a', parentId: 'cycle-b', createdAt: now, updatedAt: now });
    await pushServerTag(apiKey, { name: 'cycle-b', parentId: 'cycle-a', createdAt: now, updatedAt: now + 1000 });

    await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey);

    const db = datastore.getDb();
    const a = db.prepare('SELECT * FROM tags WHERE name = ?').get('cycle-a') as { id: string; parentId: string };
    const b = db.prepare('SELECT * FROM tags WHERE name = ?').get('cycle-b') as { id: string; parentId: string };
    assert.strictEqual(b.parentId, '', 'the newer tag in the cycle must have its parent link cleared');
    assert.strictEqual(a.parentId, b.id, 'the older tag keeps its link to the now-parentless newer one');

    // A second, independent device pulling the exact same server data must
    // break the exact same link: the tie-break is a pure function of the
    // pulled data, not of walk/iteration order.
    const { apiKey: apiKey2 } = setup('cycle-break-2');
    await pushServerTag(apiKey2, { name: 'cycle-a', parentId: 'cycle-b', createdAt: now, updatedAt: now });
    await pushServerTag(apiKey2, { name: 'cycle-b', parentId: 'cycle-a', createdAt: now, updatedAt: now + 1000 });
    await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey2);

    const db2 = datastore.getDb();
    const b2 = db2.prepare('SELECT * FROM tags WHERE name = ?').get('cycle-b') as { parentId: string };
    assert.strictEqual(b2.parentId, '', 'a second, independent pull of the same input must break the same link');
  });

  it('a failed tag push does not advance the watermark, and the next push retries that tag', async () => {
    const FLAKY_MARKER = 'flaky-tag-marker-7c2e';
    const { apiKey } = setup('flaky-tag-push', { failFirstTagPushMarker: FLAKY_MARKER });
    const now = Date.now();
    insertLocalTag({ id: 'local-flaky-tag', name: FLAKY_MARKER, createdAt: now, updatedAt: now });

    // Run 1: the push is rejected (simulated failure) — pushTagsToServer()
    // throws (see its doc comment), so saveTagPushWatermark() is never
    // reached and the watermark stays exactly where it was.
    await assert.rejects(() => sync.pushTagsToServer(FAKE_SERVER_URL, apiKey));

    assert.deepStrictEqual(
      await fetchServerTags(apiKey),
      [],
      'run 1: nothing should have reached the server'
    );

    // Run 2: the same push now succeeds (the fetch stub only fails once).
    await sync.pushTagsToServer(FAKE_SERVER_URL, apiKey);

    const serverTags = await fetchServerTags(apiKey);
    assert.strictEqual(
      serverTags.length, 1,
      'run 2: the tag must now have reached the server — the failed run must not have stranded it'
    );
    assert.strictEqual(serverTags[0].name, FLAKY_MARKER);
  });

  it('an older server tag does not overwrite a newer local one on pull', async () => {
    const { apiKey } = setup('lww-pull');
    const now = Date.now();
    insertLocalTag({
      id: 'local-lww-tag', name: 'shared-name', color: '#111111',
      description: 'Local description', createdAt: now, updatedAt: now + 5000,
    });

    await pushServerTag(apiKey, {
      name: 'shared-name', color: '#999999', description: 'Stale server description',
      createdAt: now, updatedAt: now + 1000,
    });

    await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey);

    const db = datastore.getDb();
    const local = db.prepare('SELECT * FROM tags WHERE name = ?').get('shared-name') as {
      color: string; description: string;
    };
    assert.strictEqual(local.color, '#111111', 'the older server value must not overwrite the newer local one');
    assert.strictEqual(local.description, 'Local description');
  });
});

describe('IPC entry points — tile:sync:push / tile:sync:pull must run all three stages', () => {
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

  /** Same shape as the other describe blocks' setup() — no failure injection
   * needed here, this block is about stage coverage, not retry safety. */
  function setup(name: string) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-ipc-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `ipcsync-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    return { apiKey };
  }

  async function fetchServerEventIds(apiKey: string): Promise<string[]> {
    const res = await serverApp.request('/events/since/0', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { events: Array<{ id: string }> };
    return json.events.map((e) => e.id).sort();
  }

  async function fetchServerTagNames(apiKey: string): Promise<string[]> {
    const res = await serverApp.request('/tags/since/0', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { tags: Array<{ name: string }> };
    return json.tags.map((t) => t.name).sort();
  }

  async function fetchServerItems(apiKey: string): Promise<Array<{ id: string; type: string }>> {
    const res = await serverApp.request('/items', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { items: Array<{ id: string; type: string }> };
    return json.items;
  }

  /**
   * Replays tile-ipc.ts's `tile:sync:push` handler body: tag push, then item
   * push, then event push, then updateLastSyncTime — in that order, with the
   * SAME real sync.ts/profiles.ts functions the registered handler calls.
   *
   * This is a replay, not an invocation of the registered `ipcMain.handle`
   * closure itself — that closure lives behind tile-ipc.ts's static
   * `import { ipcMain, ... } from 'electron'`, which throws at module-parse
   * time under ELECTRON_RUN_AS_NODE (electron's named ESM exports are empty;
   * see tile-ipc-gate.ts's own comment on the same gotcha), so tile-ipc.ts
   * cannot be imported outside a full, live Electron app process — not under
   * plain `node --test`, and not under `electron --test` either. Given that
   * wall, this proves the fix for the wiring bug (the handler used to call
   * pushToServer() alone, silently skipping tags and events) the same way
   * feature-install-handler.test.ts's `runInstallHandler` already does for
   * an equivalent "handler needs a live app to invoke directly" gap: drive
   * the exact real collaborators, in the handler's exact order.
   */
  async function replayTileSyncPush(serverUrl: string, apiKey: string, since: number) {
    const tagPushResult = await sync.pushTagsToServer(serverUrl, apiKey);
    const itemPushResult = await sync.pushToServer(serverUrl, apiKey, since);
    const eventPushResult = await sync.pushEventsToServer(serverUrl, apiKey);
    const activeProfile = profiles.getActiveProfile();
    profiles.updateLastSyncTime(activeProfile.id, Date.now());
    return {
      tagsPushed: tagPushResult.pushed,
      itemsPushed: itemPushResult.pushed,
      eventsPushed: eventPushResult.pushed,
    };
  }

  /** Mirror of replayTileSyncPush() for `tile:sync:pull` — see that function's
   * doc comment for why this is a replay and not a direct closure call. */
  async function replayTileSyncPull(serverUrl: string, apiKey: string, since: number) {
    const tagPullResult = await sync.pullTagsFromServer(serverUrl, apiKey, since);
    const itemPullResult = await sync.pullFromServer(serverUrl, apiKey, since);
    const eventPullResult = await sync.pullEventsFromServer(serverUrl, apiKey, since);
    const activeProfile = profiles.getActiveProfile();
    profiles.updateLastSyncTime(activeProfile.id, Date.now());
    return {
      tagsPulled: tagPullResult.pulled,
      itemsPulled: itemPullResult.pulled,
      eventsPulled: eventPullResult.pulled,
    };
  }

  it('tile:sync:push pushes tags, items, AND events — not just items', async () => {
    const { apiKey } = setup('push-all-three');

    const db = datastore.getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO tags (id, name, slug, color, parentId, description, metadata, createdAt, updatedAt, frequency, lastUsed, frecencyScore)
      VALUES (?, ?, '', '#999999', '', '', '{}', ?, ?, 0, 0, 0)
    `).run('local-ipc-push-tag', 'ipc-push-tag', now, now);

    const itemId = 'local-ipc-push-item';
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'series', NULL, '{}', '', 0, ?, ?, 0)
    `).run(itemId, now, now);

    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, NULL, ?, ?, '{}', ?)
    `).run('evt-ipc-push', itemId, 1, now, now);

    const result = await replayTileSyncPush(FAKE_SERVER_URL, apiKey, 0);
    assert.ok(result.tagsPushed > 0, 'tag stage must have pushed something');
    assert.ok(result.itemsPushed > 0, 'item stage must have pushed something');
    assert.ok(result.eventsPushed > 0, 'event stage must have pushed something — the wiring bug skipped this entirely');

    assert.deepStrictEqual(await fetchServerTagNames(apiKey), ['ipc-push-tag'], 'the tag must have reached the server');
    const serverItems = await fetchServerItems(apiKey);
    assert.strictEqual(serverItems.length, 1, 'the item must have reached the server');
    assert.strictEqual(serverItems[0].type, 'series');
    assert.deepStrictEqual(await fetchServerEventIds(apiKey), ['evt-ipc-push'], 'the event must have reached the server');
  });

  it('tile:sync:pull pulls tags, items, AND events — not just items (mirror of the push test)', async () => {
    const { apiKey } = setup('pull-all-three');

    await serverApp.request('/tags', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tags: [{ name: 'ipc-pull-tag', createdAt: Date.now(), updatedAt: Date.now() }] }),
    });

    const itemRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'series', metadata: { title: 'IPC pull series' } }),
    });
    const { id: serverItemId } = (await itemRes.json()) as { id: string };

    await serverApp.request('/events', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        events: [{ id: 'evt-ipc-pull', itemId: serverItemId, occurredAt: Date.now(), createdAt: Date.now() }],
      }),
    });

    const result = await replayTileSyncPull(FAKE_SERVER_URL, apiKey, 0);
    assert.ok(result.tagsPulled > 0, 'tag stage must have pulled something');
    assert.ok(result.itemsPulled > 0, 'item stage must have pulled something');
    assert.ok(result.eventsPulled > 0, 'event stage must have pulled something — the mirror-image wiring bug skipped this entirely');

    const db = datastore.getDb();
    const localTag = db.prepare('SELECT * FROM tags WHERE name = ?').get('ipc-pull-tag');
    assert.ok(localTag, 'the tag must exist locally after pull');

    const localItem = db.prepare('SELECT * FROM items WHERE syncId = ?').get(serverItemId) as { id: string } | undefined;
    assert.ok(localItem, 'the item must exist locally after pull');

    const localEvent = db.prepare('SELECT * FROM item_events WHERE id = ?').get('evt-ipc-pull');
    assert.ok(localEvent, 'the event must exist locally after pull');
  });
});

describe('Bulk pull timeout budget — serverFetch() timeoutMs', () => {
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

  function setup(name: string) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-timeout-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `timeout-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    return { apiKey };
  }

  // Actually waiting out a 15s/120s budget to prove which side of it a slow
  // response lands on would make this suite unusably slow. Scale every
  // requested budget down by SCALE (ms -> ms/SCALE) so ARTIFICIAL_DELAY_MS of
  // real time falls between the scaled default (15ms) and scaled bulk
  // (120ms) budgets — same ordering, three orders of magnitude faster.
  // AbortSignal.timeout is a writable, configurable static (verified against
  // the Node version this repo runs), so wrapping it also records what
  // serverFetch() actually asked for, for the "which call gets which budget"
  // assertions below.
  const SCALE = 1000;
  const ARTIFICIAL_DELAY_MS = 50;

  function installScaledTimeout(): { requestedTimeouts: number[]; restore: () => void } {
    const requestedTimeouts: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = ((ms: number) => {
      requestedTimeouts.push(ms);
      return originalTimeout(Math.max(1, Math.round(ms / SCALE)));
    }) as typeof AbortSignal.timeout;
    return {
      requestedTimeouts,
      restore: () => {
        (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = originalTimeout;
      },
    };
  }

  /**
   * Fetch stub that delays every response by ARTIFICIAL_DELAY_MS before
   * forwarding to the real server app, honoring the request's own
   * AbortSignal exactly like real fetch would — a request whose (scaled)
   * budget expires before the delay elapses genuinely rejects with the same
   * TimeoutError shape real fetch produces.
   */
  function installDelayedFetch() {
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ARTIFICIAL_DELAY_MS);
        const signal = init.signal;
        if (!signal) return;
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          return;
        }
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      });
      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;
  }

  /** Fetch stub that never resolves on its own — only the request's own
   * AbortSignal ends it — so a call through it exercises serverFetch()'s
   * real timeout-wrapping path end to end. */
  function installHangingFetch() {
    globalThis.fetch = ((_input: unknown, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      });
    }) as typeof fetch;
  }

  it('a bulk pull slower than the default budget but faster than the bulk budget completes, while an equally slow per-item push times out', async () => {
    const { apiKey } = setup('bulk-vs-default');
    const scaled = installScaledTimeout();
    installDelayedFetch();
    try {
      const pullResult = await sync.pullFromServer(FAKE_SERVER_URL, apiKey);
      assert.deepStrictEqual(
        pullResult,
        { pulled: 0, conflicts: 0 },
        'the items/since pull must complete under its larger scaled budget rather than abort'
      );

      const db = datastore.getDb();
      const now = Date.now();
      db.prepare(`
        INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
        VALUES (?, 'text', 'bulk vs default item', '{}', '', 0, ?, ?, 0)
      `).run('local-bulk-vs-default-item', now, now);

      // Force the single-item fallback: a batched push has its own, larger
      // budget, and the per-item one is what this assertion is about.
      const delayedFetch = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.replace(FAKE_SERVER_URL, '').startsWith('/items/batch')) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }
        return delayedFetch(input as RequestInfo, init);
      }) as typeof fetch;

      // pushToServer isolates per-item failures rather than throwing (see its
      // own doc comment), so the same artificial delay that the bulk pull
      // above survived shows up here as a counted failure, not a rejection.
      const pushResult = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
      assert.deepStrictEqual(
        pushResult,
        { pushed: 0, failed: 1 },
        'a per-item push under the same artificial delay must time out at the smaller default budget'
      );
    } finally {
      scaled.restore();
    }
  });

  it('bulk pull calls request the larger timeout budget; a per-item push requests the default', async () => {
    const { apiKey } = setup('timeout-selection');
    const scaled = installScaledTimeout();
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    try {
      await sync.pullFromServer(FAKE_SERVER_URL, apiKey);
      assert.deepStrictEqual(scaled.requestedTimeouts, [120000], 'the items/since pull must request the bulk budget');
      scaled.requestedTimeouts.length = 0;

      await sync.pullTagsFromServer(FAKE_SERVER_URL, apiKey);
      assert.deepStrictEqual(scaled.requestedTimeouts, [120000], 'the tags/since pull must request the bulk budget');
      scaled.requestedTimeouts.length = 0;

      await sync.pullEventsFromServer(FAKE_SERVER_URL, apiKey);
      assert.deepStrictEqual(scaled.requestedTimeouts, [120000], 'the events/since pull must request the bulk budget');
      scaled.requestedTimeouts.length = 0;

      const db = datastore.getDb();
      const now = Date.now();
      db.prepare(`
        INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
        VALUES (?, 'text', 'timeout selection item', '{}', '', 0, ?, ?, 0)
      `).run('local-timeout-selection-item', now, now);
      await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
      assert.deepStrictEqual(
        scaled.requestedTimeouts,
        [60000],
        'a batched item push carries hundreds of items in one body, so it must request the batch budget'
      );
      scaled.requestedTimeouts.length = 0;

      // Against a server with no batch route: the 404 comes back on the batch
      // budget, and each item then goes out on the default one.
      globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : String(input);
        const reqPath = url.replace(FAKE_SERVER_URL, '');
        if (reqPath.startsWith('/items/batch')) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }
        return serverApp.request(reqPath, { method: init.method || 'GET', headers: init.headers, body: init.body });
      }) as typeof fetch;
      db.prepare(`
        INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
        VALUES (?, 'text', 'timeout fallback item', '{}', '', 0, ?, ?, 0)
      `).run('local-timeout-fallback-item', now, now);
      await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
      assert.deepStrictEqual(
        scaled.requestedTimeouts,
        [60000, 15000],
        'the batch attempt asks for the batch budget; the per-item fallback asks for the default'
      );
    } finally {
      scaled.restore();
    }
  });

  it('a timed-out request throws an error naming the request path and the budget it exceeded', async () => {
    const { apiKey } = setup('timeout-message');
    const scaled = installScaledTimeout();
    installHangingFetch();
    try {
      await assert.rejects(
        () => sync.pullFromServer(FAKE_SERVER_URL, apiKey),
        (error: Error) => {
          assert.ok(
            error.message.startsWith('Request to /items?profile='),
            `error must name the request path, got: ${error.message}`
          );
          assert.ok(
            error.message.endsWith('timed out after 120000ms'),
            `error must name the elapsed timeout, got: ${error.message}`
          );
          return true;
        }
      );
    } finally {
      scaled.restore();
    }
  });
});

// ==================== Datastore-version-bump reset must keep item identity (duplicate-row regression) ====================
//
// resetPerItemSyncState() used to clear BOTH syncedAt and syncId on a datastore-version
// bump — the recovery a server-URL/profile change needs, but not what a version bump
// needs: the row identity (`syncId`) on the SAME server is still valid, only what was
// last pushed is stale. Clearing it anyway meant the next push sent the desktop's own
// local id instead, which matches neither the server row's own id nor its stored syncId
// column (db.js saveItem(), no content-based fallback on the sync path) for any item
// that originated elsewhere (pushed by another device, or pulled down from the server) —
// so the server inserted a duplicate row instead of updating the existing one. See
// sync.ts resetPerItemSyncState()'s `clearSyncId` doc comment for the fix.
describe('Datastore-version-bump reset must keep item identity (duplicate-row regression)', () => {
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

  function setup(name: string) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-dsver-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `dsver-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    installRealServerFetch();

    return { apiKey };
  }

  // Routes every call through the real app via app.request() — parses with the WHATWG
  // URL API rather than stripping a literal base string, so it works unchanged for
  // whichever server URL a given test passes syncAll() (the server-URL-change test
  // deliberately passes a DIFFERENT one than the one syncAll() was previously called
  // with, to trigger resetSyncStateIfServerChanged()).
  function installRealServerFetch(): void {
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const parsed = new URL(url);
      return serverApp.request(parsed.pathname + parsed.search, { method: init.method || 'GET', headers: init.headers, body: init.body });
    }) as typeof fetch;
  }

  // Simulates total network failure — every request rejects before reaching the server.
  // resetSyncStateIfServerChanged()/resetSyncStateIfDatastoreVersionChanged() both run
  // synchronously, before syncAll()'s first network call, so a run that fails this way
  // still applies the reset; it just never gets far enough for the push stages to
  // overwrite what the reset itself wrote (syncedAt/syncId, the event/tag push
  // watermarks) — letting the tests below read the reset's own effect directly,
  // undisturbed by anything downstream of it.
  function installAlwaysFailingFetch(): void {
    globalThis.fetch = (async () => {
      throw new Error('simulated total network failure');
    }) as typeof fetch;
  }

  async function fetchServerItems(apiKey: string): Promise<Array<{ id: string; content: string | null }>> {
    const res = await serverApp.request('/items', { headers: authHeaders(apiKey) });
    const json = (await res.json()) as { items: Array<{ id: string; content: string | null }> };
    return json.items;
  }

  /** Force the next syncAll() onto the datastore-version-changed path by back-dating the
   * client's own recorded DATASTORE_VERSION — the signal
   * resetSyncStateIfDatastoreVersionChanged() reads (see its doc comment in sync.ts). */
  function backdateStoredDatastoreVersion(): void {
    const db = datastore.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES ('sync-lastSyncDatastoreVersion', 'sync', 'lastSyncDatastoreVersion', ?, ?)
    `).run(JSON.stringify(DATASTORE_VERSION - 1), Date.now());
  }

  function readFeatureSetting(key: string): unknown {
    const db = datastore.getDb();
    const row = db.prepare(`
      SELECT value FROM feature_settings WHERE featureId = 'sync' AND key = ?
    `).get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  it('a version-bump sync updates the existing server row instead of duplicating it, for an item that originated elsewhere', async () => {
    const { apiKey } = setup('regression');

    // Seed the server directly with an item carrying a syncId from a DIFFERENT device —
    // the "originated elsewhere" case: neither the server row's own id nor its stored
    // syncId column will ever match this desktop's own local id.
    const seedRes = await serverApp.request('/items', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ type: 'text', content: 'from another device', tags: [], sync_id: 'other-device-local-id-001' }),
    });
    const { id: serverItemId } = (await seedRes.json()) as { id: string };

    // First sync: pulls the seeded item down. mergeServerItem() inserts it locally with
    // syncId = the server's own row id — this is what "hold it locally" means for an
    // item that originated elsewhere. Also establishes the client's own
    // lastSyncDatastoreVersion baseline (first-sync path, no reset triggered).
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    assert.strictEqual(
      (await fetchServerItems(apiKey)).length,
      1,
      'sanity: exactly one row on the server before the version-bump sync'
    );

    const db = datastore.getDb();
    const localBefore = db.prepare("SELECT syncId FROM items WHERE type = 'text'").get() as { syncId: string };
    assert.strictEqual(localBefore.syncId, serverItemId, 'sanity: the pulled item is linked to the server row by syncId');

    // Simulate a datastore version bump between app launches.
    backdateStoredDatastoreVersion();

    // Second sync: takes the version-changed reset path, then re-pushes the item.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    const itemsAfter = await fetchServerItems(apiKey);
    assert.strictEqual(
      itemsAfter.length,
      1,
      'a version-bump sync must update the existing server row, not insert a duplicate'
    );
    assert.strictEqual(
      itemsAfter[0].id,
      serverItemId,
      'the single remaining row must still be the original server row, not a new one'
    );
  });

  it('a version-bump reset clears syncedAt but leaves syncId populated, and clears the event stamps and tag watermark', async () => {
    const { apiKey } = setup('version-bump-scope');

    const db = datastore.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', 'version bump scope item', '{}', '', 0, ?, ?, 0)
    `).run('local-version-bump-scope-item', now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, 'version bump scope event', NULL, ?, '{}', ?)
    `).run('evt-version-bump-scope', 'local-version-bump-scope-item', now, now);

    const eventPushedAt = (): number => {
      const row = db.prepare('SELECT pushedAt FROM item_events WHERE id = ?')
        .get('evt-version-bump-scope') as { pushedAt: number } | undefined;
      return row ? row.pushedAt : 0;
    };

    // Baseline sync: pushes the item and its event, establishing a non-empty syncId,
    // a non-zero syncedAt, a stamped event and a non-zero lastTagPushAt to contrast
    // against after the reset.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    const baseline = db.prepare('SELECT syncId, syncedAt FROM items WHERE id = ?').get('local-version-bump-scope-item') as
      { syncId: string; syncedAt: number };
    assert.notStrictEqual(baseline.syncId, '', 'sanity: baseline push recorded a syncId');
    assert.notStrictEqual(baseline.syncedAt, 0, 'sanity: baseline push recorded a syncedAt');
    assert.notStrictEqual(eventPushedAt(), 0, 'sanity: baseline push stamped the event as delivered');
    assert.notStrictEqual(readFeatureSetting('lastTagPushAt'), 0, 'sanity: baseline push advanced the tag watermark past 0');

    backdateStoredDatastoreVersion();
    installAlwaysFailingFetch();

    // The run fails at the first network call (pull), right after the reset runs — see
    // installAlwaysFailingFetch()'s doc comment for why that leaves the reset's own
    // writes readable, undisturbed by the push stages.
    await assert.rejects(() => sync.syncAll(FAKE_SERVER_URL, apiKey));

    const afterReset = db.prepare('SELECT syncId, syncedAt FROM items WHERE id = ?').get('local-version-bump-scope-item') as
      { syncId: string; syncedAt: number };
    assert.strictEqual(afterReset.syncId, baseline.syncId, 'version-bump reset must leave syncId populated — the row identity is still valid on the same server');
    assert.strictEqual(afterReset.syncedAt, 0, 'version-bump reset must clear syncedAt so the item is re-pushed');
    assert.strictEqual(eventPushedAt(), 0, 'version-bump reset must clear every event delivery stamp so events re-push under the new schema (see resetPerItemSyncState() doc comment)');
    assert.strictEqual(readFeatureSetting('lastTagPushAt'), 0, 'version-bump reset must reset the tag push watermark to 0, for the same schema catch-up reason');
  });

  it('a server-URL-change reset still clears both syncedAt and syncId, and clears the event stamps and tag watermark', async () => {
    const { apiKey } = setup('server-change-scope');

    const db = datastore.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', 'server change scope item', '{}', '', 0, ?, ?, 0)
    `).run('local-server-change-scope-item', now, now);
    db.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, 'server change scope event', NULL, ?, '{}', ?)
    `).run('evt-server-change-scope', 'local-server-change-scope-item', now, now);

    const eventPushedAt = (): number => {
      const row = db.prepare('SELECT pushedAt FROM item_events WHERE id = ?')
        .get('evt-server-change-scope') as { pushedAt: number } | undefined;
      return row ? row.pushedAt : 0;
    };

    // Baseline sync against FAKE_SERVER_URL — records it as the last-known server, so a
    // later sync against a DIFFERENT url is a genuine "server changed" signal.
    await sync.syncAll(FAKE_SERVER_URL, apiKey);

    const baseline = db.prepare('SELECT syncId, syncedAt FROM items WHERE id = ?').get('local-server-change-scope-item') as
      { syncId: string; syncedAt: number };
    assert.notStrictEqual(baseline.syncId, '', 'sanity: baseline push recorded a syncId');
    assert.notStrictEqual(baseline.syncedAt, 0, 'sanity: baseline push recorded a syncedAt');
    assert.notStrictEqual(eventPushedAt(), 0, 'sanity: baseline push stamped the event as delivered');

    installAlwaysFailingFetch();

    const CHANGED_SERVER_URL = `${FAKE_SERVER_URL}-changed`;
    // The run fails at the first network call, right after the reset runs — same
    // reasoning as the version-bump test above.
    await assert.rejects(() => sync.syncAll(CHANGED_SERVER_URL, apiKey));

    const afterReset = db.prepare('SELECT syncId, syncedAt FROM items WHERE id = ?').get('local-server-change-scope-item') as
      { syncId: string; syncedAt: number };
    assert.strictEqual(afterReset.syncId, '', 'server-URL-change reset must clear syncId — the old value has no meaning on a different server');
    assert.strictEqual(afterReset.syncedAt, 0, 'server-URL-change reset must clear syncedAt so the item is re-pushed');
    assert.strictEqual(eventPushedAt(), 0, 'server-URL-change reset must clear every event delivery stamp — a different server has none of them');
    assert.strictEqual(readFeatureSetting('lastTagPushAt'), 0, 'server-URL-change reset must reset the tag push watermark to 0');
  });
});

describe('Batched item push — one request per chunk, not per item', () => {
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

  /**
   * Records the path of every POST the push makes, so a test can assert how many
   * requests a set of items actually cost — the whole point of batching. With
   * `noBatchRoute`, POST /items/batch answers 404 the way a server predating the
   * route does.
   */
  function setup(name: string, opts: { noBatchRoute?: boolean } = {}) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-batch-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `batch-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    const posts: string[] = [];
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      const method = init.method || 'GET';
      if (method === 'POST') {
        posts.push(reqPath.split('?')[0]);
      }
      if (opts.noBatchRoute && method === 'POST' && reqPath.startsWith('/items/batch')) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      return serverApp.request(reqPath, { method, headers: init.headers, body: init.body });
    }) as typeof fetch;

    return { apiKey, posts };
  }

  function insertItems(prefix: string, count: number): void {
    const db = datastore.getDb();
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', ?, '{}', '', 0, ?, ?, 0)
    `);
    for (let i = 0; i < count; i++) {
      insert.run(`${prefix}-${i}`, `note ${i}`, now, now);
    }
  }

  it('sends a whole chunk in one request and records the server id returned for each item', async () => {
    const { apiKey, posts } = setup('one-request');
    insertItems('local-batched-item', 5);

    const result = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);

    assert.deepStrictEqual(result, { pushed: 5, failed: 0 });
    assert.deepStrictEqual(
      posts.filter((p) => p === '/items/batch').length,
      1,
      `five items must cost ONE request, not five: ${JSON.stringify(posts)}`
    );
    assert.strictEqual(posts.filter((p) => p === '/items').length, 0, 'nothing should have gone out on the single-item route');

    const unsynced = datastore.getDb().prepare(`
      SELECT COUNT(*) as count FROM items WHERE syncId = '' OR syncedAt = 0
    `).get() as { count: number };
    assert.strictEqual(unsynced.count, 0, 'every item must have recorded the server id the batch returned');
  });

  it('falls back to one request per item against a server that has no batch route', async () => {
    const { apiKey, posts } = setup('fallback', { noBatchRoute: true });
    insertItems('local-fallback-item', 3);

    const result = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);

    assert.deepStrictEqual(result, { pushed: 3, failed: 0 }, 'an old server must still receive every item');
    assert.strictEqual(posts.filter((p) => p === '/items').length, 3, 'one request per item on the fallback path');
    assert.strictEqual(
      posts.filter((p) => p === '/items/batch').length,
      1,
      'the batch route is tried once and not again for the rest of the run'
    );
  });

  it('parks only the row the server refuses, and stores the rest of the chunk', async () => {
    const { apiKey } = setup('partial-rejection');
    const db = datastore.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', 'a fine note', '{}', '', 0, ?, ?, 0)
    `).run('local-batch-good-1', now, now);
    // A url item with no content: the server refuses it per row, in a chunk
    // whose other items it accepts.
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'url', '', '{}', '', 0, ?, ?, 0)
    `).run('local-batch-bad', now, now);
    db.prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'text', 'another fine note', '{}', '', 0, ?, ?, 0)
    `).run('local-batch-good-2', now, now);

    const result = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);

    assert.deepStrictEqual(result, { pushed: 2, failed: 1 }, 'one refused row must not cost the rest of the chunk');

    const parked = db.prepare('SELECT syncError, syncErrorAt FROM items WHERE id = ?').get('local-batch-bad') as
      { syncError: string; syncErrorAt: number };
    assert.ok(parked.syncError.includes('content is required'), `the refused row must be parked with its reason; got ${JSON.stringify(parked.syncError)}`);
    assert.strictEqual(parked.syncErrorAt, now);

    for (const id of ['local-batch-good-1', 'local-batch-good-2']) {
      const stored = db.prepare('SELECT syncId, syncError FROM items WHERE id = ?').get(id) as
        { syncId: string; syncError: string };
      assert.notStrictEqual(stored.syncId, '', `${id} must have been stored and its server id recorded`);
      assert.strictEqual(stored.syncError, '', `${id} must not be parked because a different row was refused`);
    }
  });
});

describe('An item the server permanently rejects is parked until it changes', () => {
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

  /**
   * Same harness as the blocks above — fresh desktop datastore and profile,
   * fresh server-side user, every call routed to the real server app in-process.
   * No injected failure: the rejection these tests turn on is a real one from
   * the real route, since CONTENT_REQUIRED_TYPES in apps/server/index.js answers
   * a `url` item with no content with a 400.
   */
  function setup(name: string) {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), `peek-desktop-park-${name}-`));
    datastore.initDatabase(path.join(desktopDir, 'datastore.sqlite'));
    profiles.initProfilesDb(desktopDir);
    profiles.ensureDefaultProfile();
    const activeProfile = profiles.getActiveProfile();

    const userId = `park-${name}-${crypto.randomUUID()}`;
    const { apiKey } = users.createUser(userId);
    profiles.enableSync(activeProfile.id, apiKey, 'default');

    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const reqPath = url.replace(FAKE_SERVER_URL, '');
      return serverApp.request(reqPath, {
        method: init.method || 'GET',
        headers: init.headers,
        body: init.body,
      });
    }) as typeof fetch;

    return { apiKey };
  }

  function readPark(itemId: string): { syncError: string; syncErrorAt: number } {
    return datastore.getDb().prepare(`
      SELECT syncError, syncErrorAt FROM items WHERE id = ?
    `).get(itemId) as { syncError: string; syncErrorAt: number };
  }

  /** A `url` item with no content — the server rejects it with a 400, every time. */
  function insertUnsyncableItem(id: string, updatedAt: number): void {
    datastore.getDb().prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'url', '', '{}', '', 0, ?, ?, 0)
    `).run(id, updatedAt, updatedAt);
  }

  it('stops being re-pushed after the rejection', async () => {
    const { apiKey } = setup('rejected-once');
    const now = Date.now();
    insertUnsyncableItem('local-unsyncable-item', now);

    const firstRun = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
    assert.strictEqual(firstRun.failed, 1, 'sanity: the server must actually reject this item');

    const park = readPark('local-unsyncable-item');
    assert.ok(
      park.syncError.startsWith('Server error 400:'),
      `the server's own message must be recorded, so the log can say why; got ${JSON.stringify(park.syncError)}`
    );
    assert.strictEqual(park.syncErrorAt, now, 'the park records the updatedAt it was rejected at, which is what a later edit has to move past');

    const secondRun = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
    assert.strictEqual(
      secondRun.failed,
      0,
      'a parked item must not be sent again — retrying a row the server has already refused, on every run forever, is what this replaces'
    );
    assert.strictEqual(secondRun.pushed, 0, 'and nothing else should have gone out either');
  });

  it('is eligible again as soon as it is edited, with no edit path having to know about parking', async () => {
    const { apiKey } = setup('edited-after-rejection');
    const now = Date.now();
    insertUnsyncableItem('local-fixable-item', now);

    await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
    assert.notStrictEqual(readPark('local-fixable-item').syncError, '', 'sanity: the first push parked it');

    // What any edit does: new content, and updatedAt moves. Nothing here clears
    // the park explicitly — moving past syncErrorAt is what un-parks it.
    datastore.getDb().prepare(`
      UPDATE items SET content = ?, updatedAt = ? WHERE id = ?
    `).run('https://example.com/fixed', now + 1000, 'local-fixable-item');

    const afterEdit = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
    assert.strictEqual(afterEdit.pushed, 1, 'the edited item must be pushed — a park that outlives the problem is silent data loss');
    assert.strictEqual(afterEdit.failed, 0);

    const park = readPark('local-fixable-item');
    assert.strictEqual(park.syncError, '', 'a successful push clears the recorded rejection');
    assert.strictEqual(park.syncErrorAt, 0);
  });

  it('is not parked by a network failure, which an unchanged retry can clear', async () => {
    const { apiKey } = setup('transient-failure');
    const now = Date.now();
    datastore.getDb().prepare(`
      INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt)
      VALUES (?, 'url', 'https://example.com/fine', '{}', '', 0, ?, ?, 0)
    `).run('local-transient-item', now, now);

    globalThis.fetch = (async () => {
      throw new Error('simulated total network failure');
    }) as typeof fetch;

    const failedRun = await sync.pushToServer(FAKE_SERVER_URL, apiKey, 0);
    assert.strictEqual(failedRun.failed, 1, 'sanity: the push must have failed');
    assert.strictEqual(
      readPark('local-transient-item').syncError,
      '',
      'a timeout or dropped link says nothing about the row itself, so the item must stay eligible'
    );
  });
});
