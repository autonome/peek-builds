import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRows, writeSnapshot } from './fixture.mjs';
import { loadSnapshot, openSnapshot } from './load-snapshot.mjs';

function withSnapshot(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'activity-snapshot-'));
  try {
    const path = join(dir, 'snapshot.sqlite');
    const rows = buildRows({ withVisits: options.withVisits });
    writeSnapshot(path, rows, options);
    return fn(path, rows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a snapshot without item_visits loads with visits as []', () => {
  withSnapshot({ withVisits: false }, (path, rows) => {
    const snap = loadSnapshot(path);
    assert.deepEqual(snap.visits, []);
    assert.equal(snap.items.length, rows.items.length);
    assert.equal(snap.events.length, rows.events.length);
    assert.equal(snap.tags.length, rows.tags.length);
    assert.equal(snap.itemTags.length, rows.itemTags.length);
    // a column the snapshot lacks reads as undefined
    assert.equal(snap.items[0].syncId, undefined);
  });
});

test('item_visits is read when present', () => {
  withSnapshot({ withVisits: true }, (path, rows) => {
    assert.equal(loadSnapshot(path).visits.length, rows.visits.length);
  });
});

test('the database is opened read-only', () => {
  withSnapshot({ withVisits: false }, (path) => {
    const db = openSnapshot(path);
    try {
      assert.throws(() => db.exec("INSERT INTO tags (id, name) VALUES ('x', 'y')"));
    } finally {
      db.close();
    }
  });
});
