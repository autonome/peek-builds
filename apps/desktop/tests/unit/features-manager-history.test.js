/**
 * Tests for the features-manager Install History pure data-shaping helpers.
 *
 * Covers the timestamp formatting, event-label/badge mapping, source
 * derivation, and newest-first ordering used by manage.js to draw the
 * Install History section. The functions live in a DOM-free ES module so they
 * run directly under the Node test runner (no Electron).
 *
 * Run via: node --test tests/unit/features-manager-history.test.js
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  eventLabel,
  eventBadgeClass,
  formatHistoryTimestamp,
  formatHistorySource,
  formatHistoryRow,
  buildHistoryRows,
} from '../../features/features-manager/history-format.js';

// ─── eventLabel ─────────────────────────────────────────────────────

describe('eventLabel', () => {
  it('maps known events to human-readable labels', () => {
    assert.equal(eventLabel('install'), 'Installed');
    assert.equal(eventLabel('update'), 'Updated');
    assert.equal(eventLabel('update-failed'), 'Update failed');
    assert.equal(eventLabel('uninstall'), 'Uninstalled');
    assert.equal(eventLabel('remove'), 'Removed');
  });

  it('title-cases an unknown event as a fallback', () => {
    assert.equal(eventLabel('some-weird-event'), 'Some weird event');
    assert.equal(eventLabel('rollback'), 'Rollback');
  });

  it('handles empty / missing event', () => {
    assert.equal(eventLabel(''), 'Unknown');
    assert.equal(eventLabel(undefined), 'Unknown');
    assert.equal(eventLabel(null), 'Unknown');
  });
});

// ─── eventBadgeClass ────────────────────────────────────────────────

describe('eventBadgeClass', () => {
  it('maps events to badge css modifier suffixes', () => {
    assert.equal(eventBadgeClass('install'), 'install');
    assert.equal(eventBadgeClass('update'), 'update');
    assert.equal(eventBadgeClass('update-failed'), 'update-failed');
    assert.equal(eventBadgeClass('uninstall'), 'uninstall');
    assert.equal(eventBadgeClass('remove'), 'uninstall');
  });

  it('falls back to default for unknown events', () => {
    assert.equal(eventBadgeClass('mystery'), 'default');
    assert.equal(eventBadgeClass(undefined), 'default');
  });
});

// ─── formatHistoryTimestamp ─────────────────────────────────────────

describe('formatHistoryTimestamp', () => {
  it('formats an ISO timestamp into an absolute readable string', () => {
    // Use an explicit local-time construction so the assertion is timezone
    // independent: build the ISO string from a known local Date.
    const d = new Date(2026, 5, 22, 15, 4); // Jun 22 2026, 3:04 PM local
    const out = formatHistoryTimestamp(d.toISOString());
    assert.equal(out, 'Jun 22, 2026, 3:04 PM');
  });

  it('pads minutes and handles midnight as 12 AM', () => {
    const d = new Date(2026, 0, 1, 0, 5); // Jan 1 2026, 12:05 AM local
    assert.equal(formatHistoryTimestamp(d.toISOString()), 'Jan 1, 2026, 12:05 AM');
  });

  it('handles noon as 12 PM', () => {
    const d = new Date(2026, 11, 31, 12, 0); // Dec 31 2026, 12:00 PM local
    assert.equal(formatHistoryTimestamp(d.toISOString()), 'Dec 31, 2026, 12:00 PM');
  });

  it('returns the raw input when unparseable, and empty for missing', () => {
    assert.equal(formatHistoryTimestamp('not-a-date'), 'not-a-date');
    assert.equal(formatHistoryTimestamp(''), '');
    assert.equal(formatHistoryTimestamp(undefined), '');
  });
});

// ─── formatHistorySource ────────────────────────────────────────────

describe('formatHistorySource', () => {
  it('prefers publisher over sourceUri, prefixed by sourceType', () => {
    assert.equal(
      formatHistorySource({ sourceType: 'atproto', sourceUri: 'at://x', publisher: 'did:plc:abc' }),
      'atproto · did:plc:abc',
    );
  });

  it('falls back to sourceUri when no publisher', () => {
    assert.equal(
      formatHistorySource({ sourceType: 'atproto', sourceUri: 'at://x' }),
      'atproto · at://x',
    );
  });

  it('shows just the type when there is no detail', () => {
    assert.equal(formatHistorySource({ sourceType: 'dev' }), 'dev');
  });

  it('shows just the detail when there is no type', () => {
    assert.equal(formatHistorySource({ publisher: 'did:plc:abc' }), 'did:plc:abc');
  });

  it('returns empty when nothing is present', () => {
    assert.equal(formatHistorySource({}), '');
    assert.equal(formatHistorySource(null), '');
  });
});

// ─── formatHistoryRow ───────────────────────────────────────────────

describe('formatHistoryRow', () => {
  it('shapes a full row into the renderer-facing object', () => {
    const d = new Date(2026, 5, 22, 15, 4);
    const out = formatHistoryRow({
      featureId: 'my-feature',
      event: 'install',
      version: '1.2.3',
      sourceType: 'atproto',
      sourceUri: 'at://did:plc:abc/space.peek.feature.release/xyz',
      publisher: 'alice.bsky.social',
      timestamp: d.toISOString(),
    });
    assert.equal(out.featureId, 'my-feature');
    assert.equal(out.label, 'Installed');
    assert.equal(out.badgeClass, 'install');
    assert.equal(out.event, 'install');
    assert.equal(out.version, '1.2.3');
    assert.equal(out.source, 'atproto · alice.bsky.social');
    assert.equal(out.timestampLabel, 'Jun 22, 2026, 3:04 PM');
    assert.equal(out.timestamp, d.toISOString());
  });

  it('degrades gracefully for a sparse row', () => {
    const out = formatHistoryRow({ event: 'update' });
    assert.equal(out.featureId, '(unknown)');
    assert.equal(out.label, 'Updated');
    assert.equal(out.badgeClass, 'update');
    assert.equal(out.version, '');
    assert.equal(out.source, '');
    assert.equal(out.timestampLabel, '');
  });

  it('tolerates null/undefined input', () => {
    const out = formatHistoryRow(null);
    assert.equal(out.featureId, '(unknown)');
    assert.equal(out.label, 'Unknown');
    assert.equal(out.badgeClass, 'default');
  });
});

// ─── buildHistoryRows (ordering) ────────────────────────────────────

describe('buildHistoryRows', () => {
  it('sorts newest-first by timestamp regardless of input order', () => {
    const rows = [
      { featureId: 'b', event: 'update', timestamp: '2026-06-20T10:00:00.000Z' },
      { featureId: 'c', event: 'uninstall', timestamp: '2026-06-22T10:00:00.000Z' },
      { featureId: 'a', event: 'install', timestamp: '2026-06-21T10:00:00.000Z' },
    ];
    const out = buildHistoryRows(rows);
    assert.deepEqual(out.map((r) => r.featureId), ['c', 'a', 'b']);
  });

  it('keeps already-DESC input stable and formats each row', () => {
    const rows = [
      { featureId: 'newest', event: 'install', timestamp: '2026-06-22T12:00:00.000Z' },
      { featureId: 'older', event: 'install', timestamp: '2026-06-22T11:00:00.000Z' },
    ];
    const out = buildHistoryRows(rows);
    assert.equal(out[0].featureId, 'newest');
    assert.equal(out[1].featureId, 'older');
    assert.equal(out[0].label, 'Installed');
  });

  it('sorts rows with missing/invalid timestamps to the end, stably', () => {
    const rows = [
      { featureId: 'no-ts-1', event: 'install' },
      { featureId: 'dated', event: 'install', timestamp: '2026-06-22T10:00:00.000Z' },
      { featureId: 'no-ts-2', event: 'install', timestamp: 'garbage' },
    ];
    const out = buildHistoryRows(rows).map((r) => r.featureId);
    assert.deepEqual(out, ['dated', 'no-ts-1', 'no-ts-2']);
  });

  it('returns an empty array for empty / non-array input', () => {
    assert.deepEqual(buildHistoryRows([]), []);
    assert.deepEqual(buildHistoryRows(null), []);
    assert.deepEqual(buildHistoryRows(undefined), []);
  });

  it('does not mutate the input array', () => {
    const rows = [
      { featureId: 'x', event: 'install', timestamp: '2026-06-20T10:00:00.000Z' },
      { featureId: 'y', event: 'install', timestamp: '2026-06-22T10:00:00.000Z' },
    ];
    const snapshot = rows.map((r) => r.featureId);
    buildHistoryRows(rows);
    assert.deepEqual(rows.map((r) => r.featureId), snapshot);
  });
});
