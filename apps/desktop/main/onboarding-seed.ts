/**
 * First-launch onboarding seeder.
 *
 * Seeds a curated demo set (onboarding/fixture.ts) into a brand-new profile
 * so the empty-state teaches the surface. Runs synchronously right after
 * initDatabase, before any window or pubsub broadcaster exists — the fresh UI
 * simply queries the seeded DB when it first renders, so no pubsub is needed.
 *
 * Guard (BOTH must hold to seed):
 *  1. No onboarding sentinel row yet.
 *  2. The items table is empty.
 * The sentinel is written either way, giving two clean invariants:
 *  - an existing (non-empty) profile is adopted as "already onboarded" —
 *    the sentinel is written WITHOUT seeding, so demo content is never
 *    injected into real data (incl. an existing user's new device, where the
 *    DB is empty only until sync pulls; see the sync-policy note below);
 *  - a seeded profile is never re-seeded, even if the user later deletes
 *    every demo item.
 *
 * Sync policy: seed items are LOCAL-ONLY (insertSeedItem stamps
 * metadata.seedSource), so they never sync and each device seeds its own copy.
 * The sentinel is version-agnostic on purpose: a FIXTURE_VERSION bump ships
 * new content to brand-new profiles only; established profiles keep the
 * sentinel and are never re-seeded.
 */

import { getDb, insertSeedItem } from './datastore.js';
import { FIXTURE, FIXTURE_VERSION, ONBOARDING_TAG } from '../onboarding/fixture.js';

const SENTINEL_ID = 'onboarding-seeded';
const SENTINEL_FEATURE = 'onboarding';
const SENTINEL_KEY = 'seeded';

function sentinelPresent(): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM feature_settings WHERE featureId = ? AND key = ? LIMIT 1')
    .get(SENTINEL_FEATURE, SENTINEL_KEY);
  return row != null;
}

function writeSentinel(seededCount: number): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      SENTINEL_ID,
      SENTINEL_FEATURE,
      SENTINEL_KEY,
      JSON.stringify({ version: FIXTURE_VERSION, seeded: seededCount }),
      Date.now()
    );
}

/** Any row (including soft-deleted tombstones) means this is not a fresh profile. */
function itemsTableEmpty(): boolean {
  const row = getDb().prepare('SELECT 1 FROM items LIMIT 1').get();
  return row == null;
}

/**
 * Seed onboarding demo content into a brand-new profile. Idempotent and safe
 * to call on every boot: a no-op once the sentinel is written.
 */
export function seedOnboardingIfNeeded(): void {
  if (sentinelPresent()) return;

  // Adopt an existing (non-empty) profile as already-onboarded: write the
  // sentinel WITHOUT seeding so real data is never mixed with demo content.
  if (!itemsTableEmpty()) {
    writeSentinel(0);
    return;
  }

  const base = Date.now();
  FIXTURE.forEach((entry, i) => {
    insertSeedItem(entry.type, {
      content: entry.content,
      metadata: entry.metadata,
      // Descending createdAt so the fixture keeps its authored order in the
      // recent-sorted view (first entry newest → shown first).
      createdAt: base - i * 1000,
      tags: [ONBOARDING_TAG, ...entry.tags],
    });
  });

  writeSentinel(FIXTURE.length);
  console.log(`[onboarding] Seeded ${FIXTURE.length} demo items (fixture v${FIXTURE_VERSION})`);
}
