/**
 * Unit tests for entity observation frecency ranking (Clustering Phase 1)
 *
 * Tests:
 * - Frecency score calculation (calculateFrecency formula)
 * - Entity frecency update logic (visitCount, lastVisitAt, frecencyScore)
 * - Sort by frequency (sortEntities from home.js)
 * - "Seen on N pages" display text
 * - Phone number extraction filters (bare digits rejected)
 * - Date extraction filters (directory listings, filenames rejected)
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

// Module references loaded in before()
let calculateFrecency: (frequency: number, lastUsed: number) => number;
let extractRegexEntities: (text: string, url: string) => any[];

describe('Entity Frecency Ranking', () => {
  before(async () => {
    // Load calculateFrecency from compiled datastore
    const datastoreMod = await import('./datastore.js');
    calculateFrecency = datastoreMod.calculateFrecency;

    // Load regex extractor
    const extensionsDir = resolve(projectRoot, 'features', 'entities');
    const regexMod = await import(resolve(extensionsDir, 'extractors', 'regex.js'));
    extractRegexEntities = regexMod.extractRegexEntities;
  });

  // ─── calculateFrecency formula ────────────────────────────────────

  describe('calculateFrecency formula', () => {
    it('should return 0 for zero frequency regardless of recency', () => {
      const score = calculateFrecency(0, Date.now());
      assert.strictEqual(score, 0, 'Zero frequency should always produce zero score');
    });

    it('should return frequency * 10 when just used (decay = 1)', () => {
      // When lastUsed is right now, daysSinceUse ~ 0, decayFactor ~ 1
      const now = Date.now();
      const score = calculateFrecency(5, now);
      assert.strictEqual(score, 50, 'frequency=5, just used => 5 * 10 * 1 = 50');
    });

    it('should return frequency * 10 for frequency=1 just used', () => {
      const score = calculateFrecency(1, Date.now());
      assert.strictEqual(score, 10, 'frequency=1, just used => 1 * 10 * 1 = 10');
    });

    it('should decay score for older last-used timestamps', () => {
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const score = calculateFrecency(10, sevenDaysAgo);
      // daysSinceUse = 7, decayFactor = 1 / (1 + 7/7) = 1/2 = 0.5
      // score = 10 * 10 * 0.5 = 50
      assert.strictEqual(score, 50, 'frequency=10, 7 days ago => 10 * 10 * 0.5 = 50');
    });

    it('should decay more for 14-day-old usage', () => {
      const now = Date.now();
      const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
      const score = calculateFrecency(10, fourteenDaysAgo);
      // daysSinceUse = 14, decayFactor = 1 / (1 + 14/7) = 1/3 ~ 0.333
      // score = 10 * 10 * 0.333 = 33.3 => rounded to 33
      assert.strictEqual(score, 33, 'frequency=10, 14 days ago => ~33');
    });

    it('should produce higher score for recent use vs old use (same frequency)', () => {
      const now = Date.now();
      const recent = calculateFrecency(5, now - 1 * 24 * 60 * 60 * 1000);
      const old = calculateFrecency(5, now - 30 * 24 * 60 * 60 * 1000);
      assert.ok(recent > old, `Recent score (${recent}) should exceed old score (${old})`);
    });

    it('should produce higher score for higher frequency (same recency)', () => {
      const lastUsed = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const lowFreq = calculateFrecency(2, lastUsed);
      const highFreq = calculateFrecency(10, lastUsed);
      assert.ok(highFreq > lowFreq, `High freq (${highFreq}) should exceed low freq (${lowFreq})`);
    });

    it('should handle very old timestamps gracefully (no NaN/Infinity)', () => {
      const veryOld = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year ago
      const score = calculateFrecency(5, veryOld);
      assert.ok(Number.isFinite(score), 'Score should be finite');
      assert.ok(score >= 0, 'Score should be non-negative');
      assert.ok(score < 50, 'Score should be significantly decayed');
    });

    it('should handle lastUsed of 0 (never used) without error', () => {
      const score = calculateFrecency(3, 0);
      assert.ok(Number.isFinite(score), 'Score should be finite');
      // lastUsed=0 means a very long time ago, score should be near 0
      assert.ok(score < 5, 'Score with lastUsed=0 should be very small');
    });
  });

  // ─── Entity frecency update logic ─────────────────────────────────

  describe('entity frecency update logic (entity-store)', () => {
    /**
     * This tests the pure calculation logic used in addObservation()
     * from entity-store.js, without requiring the full datastore/IPC.
     *
     * The logic is:
     *   newVisitCount = (item.visitCount || 0) + 1
     *   daysSinceUse = 0 (just used now)
     *   decayFactor = 1 / (1 + 0/7) = 1
     *   frecencyScore = Math.round(newVisitCount * 10 * decayFactor)
     */

    function simulateObservation(currentVisitCount: number): { visitCount: number; frecencyScore: number } {
      const newVisitCount = (currentVisitCount || 0) + 1;
      const daysSinceUse = 0;
      const decayFactor = 1 / (1 + daysSinceUse / 7);
      const frecencyScore = Math.round(newVisitCount * 10 * decayFactor);
      return { visitCount: newVisitCount, frecencyScore };
    }

    it('should set visitCount=1 and frecencyScore=10 on first observation', () => {
      const result = simulateObservation(0);
      assert.strictEqual(result.visitCount, 1);
      assert.strictEqual(result.frecencyScore, 10);
    });

    it('should set visitCount=2 and frecencyScore=20 on second observation', () => {
      const result = simulateObservation(1);
      assert.strictEqual(result.visitCount, 2);
      assert.strictEqual(result.frecencyScore, 20);
    });

    it('should increment visitCount linearly', () => {
      const counts = [0, 1, 2, 3, 4, 5, 10, 50, 100];
      for (const count of counts) {
        const result = simulateObservation(count);
        assert.strictEqual(result.visitCount, count + 1,
          `visitCount should be ${count + 1} after observation`);
      }
    });

    it('should produce frecencyScore = visitCount * 10 for immediate observations', () => {
      // When daysSinceUse=0, decayFactor=1, so frecencyScore = visitCount * 10
      for (let i = 0; i < 20; i++) {
        const result = simulateObservation(i);
        assert.strictEqual(result.frecencyScore, (i + 1) * 10,
          `frecencyScore should be ${(i + 1) * 10} for visitCount=${i + 1}`);
      }
    });

    it('should handle undefined visitCount (new entity)', () => {
      const visitCount: number | undefined = undefined;
      const newVisitCount = (visitCount || 0) + 1;
      assert.strictEqual(newVisitCount, 1);
    });
  });

  // ─── Sort by frequency ────────────────────────────────────────────

  describe('sort by frequency', () => {
    /**
     * Replicates the sort logic from home.js sortEntities for 'frequency' mode.
     */
    function sortByFrequency(entities: any[], direction: 'asc' | 'desc' = 'desc') {
      const dir = direction === 'asc' ? 1 : -1;
      return [...entities].sort((a, b) => {
        const fa = a.visitCount || 0;
        const fb = b.visitCount || 0;
        if (fa !== fb) return dir * (fa - fb);
        return dir * ((a.frecencyScore || 0) - (b.frecencyScore || 0));
      });
    }

    it('should sort entities by visitCount descending by default', () => {
      const entities = [
        { content: 'A', visitCount: 1, frecencyScore: 10 },
        { content: 'B', visitCount: 5, frecencyScore: 50 },
        { content: 'C', visitCount: 3, frecencyScore: 30 },
      ];
      const sorted = sortByFrequency(entities);
      assert.strictEqual(sorted[0].content, 'B');
      assert.strictEqual(sorted[1].content, 'C');
      assert.strictEqual(sorted[2].content, 'A');
    });

    it('should sort entities by visitCount ascending when direction is asc', () => {
      const entities = [
        { content: 'A', visitCount: 1, frecencyScore: 10 },
        { content: 'B', visitCount: 5, frecencyScore: 50 },
        { content: 'C', visitCount: 3, frecencyScore: 30 },
      ];
      const sorted = sortByFrequency(entities, 'asc');
      assert.strictEqual(sorted[0].content, 'A');
      assert.strictEqual(sorted[1].content, 'C');
      assert.strictEqual(sorted[2].content, 'B');
    });

    it('should use frecencyScore as tiebreaker when visitCount is equal', () => {
      const entities = [
        { content: 'A', visitCount: 3, frecencyScore: 10 },
        { content: 'B', visitCount: 3, frecencyScore: 30 },
        { content: 'C', visitCount: 3, frecencyScore: 20 },
      ];
      const sorted = sortByFrequency(entities);
      assert.strictEqual(sorted[0].content, 'B');
      assert.strictEqual(sorted[1].content, 'C');
      assert.strictEqual(sorted[2].content, 'A');
    });

    it('should handle entities with missing visitCount (treat as 0)', () => {
      const entities = [
        { content: 'A' },
        { content: 'B', visitCount: 2, frecencyScore: 20 },
        { content: 'C', visitCount: 0, frecencyScore: 0 },
      ];
      const sorted = sortByFrequency(entities);
      assert.strictEqual(sorted[0].content, 'B');
      // A and C both have visitCount=0
      assert.ok(['A', 'C'].includes(sorted[1].content));
      assert.ok(['A', 'C'].includes(sorted[2].content));
    });

    it('should handle empty array', () => {
      const sorted = sortByFrequency([]);
      assert.deepStrictEqual(sorted, []);
    });

    it('should handle single entity', () => {
      const entities = [{ content: 'A', visitCount: 5, frecencyScore: 50 }];
      const sorted = sortByFrequency(entities);
      assert.strictEqual(sorted.length, 1);
      assert.strictEqual(sorted[0].content, 'A');
    });

    it('should not mutate the original array', () => {
      const entities = [
        { content: 'B', visitCount: 1 },
        { content: 'A', visitCount: 5 },
      ];
      const sorted = sortByFrequency(entities);
      assert.strictEqual(entities[0].content, 'B', 'Original array should be unchanged');
      assert.strictEqual(sorted[0].content, 'A', 'Sorted array should differ');
    });
  });

  // ─── getEntities default sort ─────────────────────────────────────

  describe('getEntities default sort (frecencyScore then createdAt)', () => {
    /**
     * Replicates the sort from entity-store.js getEntities():
     *   entities.sort((a, b) => {
     *     if (b.frecencyScore !== a.frecencyScore) return b.frecencyScore - a.frecencyScore;
     *     return b.createdAt - a.createdAt;
     *   });
     */
    function defaultSort(entities: any[]) {
      return [...entities].sort((a, b) => {
        if (b.frecencyScore !== a.frecencyScore) return b.frecencyScore - a.frecencyScore;
        return b.createdAt - a.createdAt;
      });
    }

    it('should sort by frecencyScore descending', () => {
      const entities = [
        { content: 'Low', frecencyScore: 10, createdAt: 1000 },
        { content: 'High', frecencyScore: 100, createdAt: 1000 },
        { content: 'Mid', frecencyScore: 50, createdAt: 1000 },
      ];
      const sorted = defaultSort(entities);
      assert.strictEqual(sorted[0].content, 'High');
      assert.strictEqual(sorted[1].content, 'Mid');
      assert.strictEqual(sorted[2].content, 'Low');
    });

    it('should use createdAt descending as tiebreaker', () => {
      const entities = [
        { content: 'Older', frecencyScore: 50, createdAt: 1000 },
        { content: 'Newer', frecencyScore: 50, createdAt: 2000 },
      ];
      const sorted = defaultSort(entities);
      assert.strictEqual(sorted[0].content, 'Newer');
      assert.strictEqual(sorted[1].content, 'Older');
    });

    it('should handle entities with frecencyScore=0', () => {
      const entities = [
        { content: 'Zero', frecencyScore: 0, createdAt: 3000 },
        { content: 'Some', frecencyScore: 10, createdAt: 1000 },
      ];
      const sorted = defaultSort(entities);
      assert.strictEqual(sorted[0].content, 'Some');
      assert.strictEqual(sorted[1].content, 'Zero');
    });
  });

  // ─── "Seen on N pages" display ────────────────────────────────────

  describe('"Seen on N pages" display text', () => {
    /**
     * Replicates the display logic from home.js:
     *   const pageCount = entity.visitCount || 0;
     *   const pageCountText = pageCount > 0
     *     ? `Seen on ${pageCount} page${pageCount !== 1 ? 's' : ''}`
     *     : '';
     */
    function getPageCountText(visitCount: number | undefined): string {
      const pageCount = visitCount || 0;
      return pageCount > 0
        ? `Seen on ${pageCount} page${pageCount !== 1 ? 's' : ''}`
        : '';
    }

    it('should show "Seen on 1 page" for visitCount=1 (singular)', () => {
      assert.strictEqual(getPageCountText(1), 'Seen on 1 page');
    });

    it('should show "Seen on 2 pages" for visitCount=2 (plural)', () => {
      assert.strictEqual(getPageCountText(2), 'Seen on 2 pages');
    });

    it('should show "Seen on 100 pages" for visitCount=100', () => {
      assert.strictEqual(getPageCountText(100), 'Seen on 100 pages');
    });

    it('should return empty string for visitCount=0', () => {
      assert.strictEqual(getPageCountText(0), '');
    });

    it('should return empty string for undefined visitCount', () => {
      assert.strictEqual(getPageCountText(undefined), '');
    });
  });

  // ─── Detail view "Observed On" text ───────────────────────────────

  describe('detail view "Observed On" display', () => {
    /**
     * Replicates the logic from showDetailView in home.js:
     *   const detailPageCount = entity.visitCount || 0;
     *   `${detailPageCount} page${detailPageCount !== 1 ? 's' : ''}`
     */
    function getDetailObservedText(visitCount: number | undefined): string {
      const count = visitCount || 0;
      return `${count} page${count !== 1 ? 's' : ''}`;
    }

    it('should show "1 page" for visitCount=1', () => {
      assert.strictEqual(getDetailObservedText(1), '1 page');
    });

    it('should show "5 pages" for visitCount=5', () => {
      assert.strictEqual(getDetailObservedText(5), '5 pages');
    });

    it('should show "0 pages" for visitCount=0', () => {
      assert.strictEqual(getDetailObservedText(0), '0 pages');
    });

    it('should show "0 pages" for undefined visitCount', () => {
      assert.strictEqual(getDetailObservedText(undefined), '0 pages');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ENTITY REGEX EXTRACTION FILTER TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Entity Regex Extraction Filters', () => {
  let extractRegexEntities: (text: string, url: string) => any[];

  before(async () => {
    const extensionsDir = resolve(projectRoot, 'features', 'entities');
    const regexMod = await import(resolve(extensionsDir, 'extractors', 'regex.js'));
    extractRegexEntities = regexMod.extractRegexEntities;
  });

  // ─── Phone number: bare digit sequences ───────────────────────────

  describe('phone numbers: bare digit sequences should NOT be detected', () => {
    it('should NOT detect bare 10-digit sequence as phone (e.g. "2262633506")', () => {
      const text = 'ID number: 2262633506';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.strictEqual(phones.length, 0,
        'Bare digits "2262633506" should not be a phone number');
    });

    it('should NOT detect bare 11-digit sequence starting with 1 as phone', () => {
      const text = 'Reference: 15551234567';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.strictEqual(phones.length, 0,
        'Bare digits "15551234567" should not be a phone number');
    });

    it('should NOT detect bare 7-digit sequence as phone', () => {
      const text = 'Code: 5551234';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.strictEqual(phones.length, 0,
        'Bare 7-digit sequence should not be a phone number');
    });
  });

  // ─── Phone number: formatted numbers SHOULD be detected ──────────

  describe('phone numbers: formatted numbers SHOULD be detected', () => {
    it('should detect "(226) 263-3506" as a phone number', () => {
      const text = 'Call us at (226) 263-3506';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'Formatted "(226) 263-3506" should be detected');
    });

    it('should detect "226-263-3506" as a phone number', () => {
      const text = 'Phone: 226-263-3506';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'Dashed "226-263-3506" should be detected');
    });

    it('should detect "226.263.3506" as a phone number', () => {
      const text = 'Phone: 226.263.3506';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'Dotted "226.263.3506" should be detected');
    });

    it('should detect "+1 226 263 3506" as a phone number', () => {
      const text = 'International: +1 226 263 3506';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'International format should be detected');
    });

    it('should detect "+1-555-123-4567" as a phone number', () => {
      const text = 'Call +1-555-123-4567';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'Plus-prefixed dashed format should be detected');
    });

    it('should detect "555 123 4567" as a phone number (space-separated)', () => {
      const text = 'Dial 555 123 4567';
      const result = extractRegexEntities(text, 'https://example.com');
      const phones = result.filter((e: any) => e.entityType === 'phone');
      assert.ok(phones.length >= 1, 'Space-separated format should be detected');
    });
  });

  // ─── Date: directory listing context ──────────────────────────────

  describe('dates: directory listing context should NOT produce date entities', () => {
    it('should NOT detect date preceded by directory name ending with "/"', () => {
      const text = 'elephant/ 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date in directory listing context (trailing /) should be ignored');
    });

    it('should NOT detect date preceded by path-like directory "images/"', () => {
      const text = 'images/ 2026-03-15';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after directory-like name ending with / should be ignored');
    });

    it('should NOT detect date preceded by "build/"', () => {
      const text = 'build/ 2026-01-20';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after "build/" directory context should be ignored');
    });
  });

  // ─── Date: filename context ───────────────────────────────────────

  describe('dates: filename context should NOT produce date entities', () => {
    it('should NOT detect date preceded by a filename like "report.pdf"', () => {
      const text = 'report.pdf 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after filename context should be ignored');
    });

    it('should NOT detect date preceded by "image.png"', () => {
      const text = 'image.png 2026-05-01';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after "image.png" filename should be ignored');
    });

    it('should NOT detect date preceded by "data.json"', () => {
      const text = 'data.json 2026-04-20';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after "data.json" filename should be ignored');
    });
  });

  // ─── Date: single-token identifiers ───────────────────────────────

  describe('dates: short single-token identifiers should NOT produce date entities', () => {
    it('should NOT detect date preceded by a short single word like "createdAt"', () => {
      const text = 'createdAt 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after metadata identifier "createdAt" should be ignored');
    });

    it('should NOT detect date preceded by "updatedAt"', () => {
      const text = 'updatedAt 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after "updatedAt" should be ignored');
    });

    it('should NOT detect date preceded by "timestamp"', () => {
      const text = 'timestamp 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0,
        'Date after "timestamp" should be ignored');
    });
  });

  // Date regex extraction was intentionally disabled (too noisy).
  // These tests now verify that no dates are returned via regex.
  describe('dates: regex extraction disabled (no date entities from regex)', () => {
    it('should NOT extract date via regex even with meaningful context', () => {
      const text = 'Team Meeting 2026-02-10';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0, 'Date regex extraction is disabled');
    });

    it('should NOT extract date with "Project Deadline" context', () => {
      const text = 'Project Deadline 2026-03-15';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0, 'Date regex extraction is disabled');
    });

    it('should NOT extract date with US format via regex', () => {
      const text = 'Conference Talk February 15, 2026';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0, 'Date regex extraction is disabled');
    });

    it('should NOT extract slash-format date via regex', () => {
      const text = 'Invoice Due Date: 02/10/2026';
      const result = extractRegexEntities(text, 'https://example.com');
      const dates = result.filter((e: any) => e.entityType === 'date');
      assert.strictEqual(dates.length, 0, 'Date regex extraction is disabled');
    });
  });

  // ─── Address/place: true positives SHOULD be detected ────────────

  describe('addresses: valid street addresses SHOULD be detected as places', () => {
    it('should detect "123 Main Street"', () => {
      const text = 'Our office is at 123 Main Street';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"123 Main Street" should be detected');
    });

    it('should detect "456 Oak Avenue"', () => {
      const text = 'Located at 456 Oak Avenue';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"456 Oak Avenue" should be detected');
    });

    it('should detect "789 Elm Boulevard"', () => {
      const text = 'Visit 789 Elm Boulevard';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"789 Elm Boulevard" should be detected');
    });

    it('should detect "1600 Pennsylvania Ave"', () => {
      const text = 'The address is 1600 Pennsylvania Ave';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"1600 Pennsylvania Ave" should be detected');
    });

    it('should detect "42 Wallaby Way"', () => {
      const text = 'Find us at 42 Wallaby Way';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"42 Wallaby Way" should be detected');
    });

    it('should detect "100 Technology Drive, Suite 200"', () => {
      const text = 'Headquarters: 100 Technology Drive, Suite 200';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, '"100 Technology Drive, Suite 200" should be detected');
    });

    it('should detect full address with city, state, zip', () => {
      const text = 'Leavening Heaven, 123 Main St, Dorktown, IA 52001';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, 'Full address should be detected');
      assert.ok(places[0].attributes.address.includes('Dorktown'), 'Should include city');
      assert.ok(places[0].attributes.address.includes('IA'), 'Should include state');
      assert.ok(places[0].attributes.label === 'Leavening Heaven', 'Should extract label');
    });

    it('should detect address with city and state but no zip', () => {
      const text = '456 Oak Avenue, Portland, OR';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, 'Address with city/state should be detected');
      assert.ok(places[0].attributes.address.includes('Portland'), 'Should include city');
      assert.ok(places[0].attributes.address.includes('OR'), 'Should include state');
    });

    it('should detect address with zip+4', () => {
      const text = '789 Elm Boulevard, Austin, TX 78701-1234';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, 'Address with zip+4 should be detected');
      assert.ok(places[0].attributes.address.includes('78701-1234'), 'Should include full zip');
    });
  });

  // ─── Address/place: false positives should NOT be detected ───────

  describe('addresses: non-address text should NOT be detected as places', () => {
    it('should NOT detect "16 yarn test" as a place', () => {
      const text = '16 yarn test';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"16 yarn test" should not be a place');
    });

    it('should NOT detect "9 yarn test" as a place', () => {
      const text = '9 yarn test';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"9 yarn test" should not be a place');
    });

    it('should NOT detect "90 npx playwright test" as a place', () => {
      const text = '90 npx playwright test';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"90 npx playwright test" should not be a place');
    });

    it('should NOT detect numbered list items as places', () => {
      const text = '3 Configure Settings';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        'Numbered list item should not be a place');
    });

    it('should NOT detect "5 Install Dependencies" as a place', () => {
      const text = '5 Install Dependencies';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"5 Install Dependencies" should not be a place');
    });

    it('should NOT detect "10 Create Account" as a place', () => {
      const text = '10 Create Account';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"10 Create Account" should not be a place');
    });

    it('should NOT detect "2 Run Tests" as a place', () => {
      const text = '2 Run Tests';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.strictEqual(places.length, 0,
        '"2 Run Tests" should not be a place');
    });
  });

  // ─── Address/place: label/name context extraction ────────────────

  describe('addresses: label/name context extraction', () => {
    it('should extract label from text before address (newline-separated)', () => {
      const text = "Madison Square Garden\n4 Pennsylvania Ave";
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, 'Should detect the address');
      assert.ok(places[0].attributes.label, 'Should have a label');
      assert.ok(places[0].attributes.label.includes('Madison Square Garden'));
      assert.ok(places[0].name.includes('Madison Square Garden'));
    });

    it('should extract label from "at" pattern', () => {
      const text = "Joe's Pizza at 123 Doughy Ln";
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1, 'Should detect the address');
      assert.ok(places[0].attributes.label, 'Should have a label');
      assert.ok(places[0].attributes.label.includes("Joe's Pizza"));
    });

    it('should store address separately in attributes', () => {
      const text = "Acme Corp\n456 Oak Avenue";
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1);
      assert.ok(places[0].attributes.address.includes('456 Oak Avenue'));
      assert.ok(places[0].attributes.label === 'Acme Corp');
    });

    it('should have no label when no context precedes address', () => {
      const text = '123 Main Street';
      const result = extractRegexEntities(text, 'https://example.com');
      const places = result.filter((e: any) => e.entityType === 'place');
      assert.ok(places.length >= 1);
      assert.strictEqual(places[0].attributes.label, undefined);
      assert.strictEqual(places[0].name, '123 Main Street');
    });
  });
});
