/**
 * Onboarding / demo fixture — the curated items seeded into a brand-new
 * profile on first launch so the empty-state teaches the surface instead of
 * being a blank screen.
 *
 * This module is DATA ONLY. The seeder (main/onboarding-seed.ts) owns the
 * insert logic, the local-only marker, the sentinel guard, and ordering.
 *
 * Rules for editing:
 * - Seed items are LOCAL-ONLY: they never sync. The seeder stamps
 *   metadata.seedSource='onboarding'; packages/sync excludes such items from
 *   push, exactly like browser-imports. So a stable syncId is NOT needed and
 *   each device seeds its own copy.
 * - Existing users are NEVER re-seeded: once the onboarding sentinel is
 *   written for a profile, this file is never re-read for it. New users get
 *   whatever content ships in FIXTURE at their install time; established
 *   profiles are left untouched (see onboarding-seed.ts for the guard).
 *
 * WALKING SKELETON: the entries below are placeholders that prove the
 * mechanism end-to-end. The real curated content set (feature notes, more
 * URLs, tagset/entity demos, images) lands in a follow-up.
 */

import type { ItemType } from '../types/index.js';

/** Bump when the curated content changes. Recorded in the sentinel value for diagnostics. */
export const FIXTURE_VERSION = 1;

/** Internal tag on every seed item, so a user can one-gesture archive the demo set. */
export const ONBOARDING_TAG = 'peek:onboarding';

export interface FixtureEntry {
  type: ItemType;
  content: string;
  /** Optional metadata (e.g. { title }). seedSource is added by the seeder, not here. */
  metadata?: Record<string, unknown>;
  /** Extra tag names to apply (ONBOARDING_TAG is added by the seeder). */
  tags: string[];
}

export const FIXTURE: FixtureEntry[] = [
  {
    type: 'text',
    content:
      '# Welcome to Peek\n\n' +
      'Peek keeps what you find — pages, notes, images — and helps you get back to it.\n\n' +
      'This is demo content. Anything tagged `peek:onboarding` can be cleared in one gesture once you’re settled in.',
    metadata: { title: 'Welcome to Peek' },
    tags: ['welcome'],
  },
  {
    type: 'url',
    content: 'https://tangled.org/burrito.space/peek',
    metadata: { title: 'Peek source' },
    tags: ['peek:source'],
  },
];
