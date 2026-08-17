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
      assert.deepStrictEqual(scaled.requestedTimeouts, [15000], 'a per-item push must request the default budget');
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
