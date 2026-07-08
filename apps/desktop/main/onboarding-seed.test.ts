/**
 * Unit tests for the first-launch onboarding seeder.
 *
 * Runs against the compiled datastore (dist/main) with a temporary DB, like
 * datastore.test.ts. Covers: fresh-profile seeding + local-only marker + tag,
 * authored ordering, idempotency, and the "never seed a non-empty profile"
 * guard.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, 'test-onboarding-seed.db');

let datastore: typeof import('./datastore.js');
let seed: typeof import('./onboarding-seed.js');
let fixture: typeof import('../onboarding/fixture.js');

function cleanupDb() {
  for (const p of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function itemCount(): number {
  return (datastore.getDb().prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
}

describe('Onboarding seeder', () => {
  before(async () => {
    datastore = await import('./datastore.js');
    seed = await import('./onboarding-seed.js');
    fixture = await import('../onboarding/fixture.js');
  });

  beforeEach(() => {
    datastore.closeDatabase();
    cleanupDb();
    datastore.initDatabase(TEST_DB_PATH);
  });

  after(() => {
    datastore.closeDatabase();
    cleanupDb();
  });

  it('seeds the fixture into a fresh profile, each item local-only and tagged', () => {
    seed.seedOnboardingIfNeeded();

    assert.strictEqual(itemCount(), fixture.FIXTURE.length, 'one item per fixture entry');

    const items = datastore
      .getDb()
      .prepare('SELECT id, metadata FROM items')
      .all() as { id: string; metadata: string }[];

    for (const it of items) {
      const meta = JSON.parse(it.metadata);
      assert.strictEqual(meta.seedSource, 'onboarding', 'seed item is marked local-only');
      const tags = datastore.getItemTags(it.id).map((t) => t.name);
      assert.ok(tags.includes(fixture.ONBOARDING_TAG), 'seed item carries the onboarding tag');
    }
  });

  it('orders seed items by descending createdAt (authored order preserved)', () => {
    seed.seedOnboardingIfNeeded();

    const rows = datastore
      .getDb()
      .prepare('SELECT createdAt FROM items ORDER BY createdAt DESC')
      .all() as { createdAt: number }[];

    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].createdAt > rows[i].createdAt, 'each seed item is strictly newer than the next');
    }
  });

  it('is idempotent — a second call seeds nothing', () => {
    seed.seedOnboardingIfNeeded();
    seed.seedOnboardingIfNeeded();
    assert.strictEqual(itemCount(), fixture.FIXTURE.length, 'no duplicate seeding on the second call');
  });

  it('never seeds a non-empty profile — adopts it as already-onboarded', () => {
    // Simulate an existing user: a real item present, no sentinel yet.
    datastore.addItem('text', { content: 'my real note' });

    seed.seedOnboardingIfNeeded();

    assert.strictEqual(itemCount(), 1, 'no demo content injected into an existing profile');
    const sentinel = datastore
      .getDb()
      .prepare("SELECT 1 FROM feature_settings WHERE featureId = 'onboarding' AND key = 'seeded'")
      .get();
    assert.ok(sentinel, 'sentinel written even when adopting an existing profile');
  });
});
