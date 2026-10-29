/**
 * Unit tests for features/sheets/sheet-thumbnail.js: when a sheet's
 * thumbnail is retaken, and how it is stored.
 *
 * Run via: node --test tests/unit/sheet-thumbnail.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktop = join(__dirname, '..', '..');
const {
  captureWaitMs, createThumbnailScheduler, captureSheetThumbnail, loadThumbnail, thumbnailKey,
  FIRST_CAPTURE_DELAY_MS, EDIT_SETTLE_MS, MIN_CAPTURE_INTERVAL_MS
} = await import(join(desktop, 'features', 'sheets', 'sheet-thumbnail.js'));

const JPEG = 'data:image/jpeg;base64,AAAA';

const fakeTimers = () => {
  const t = { clock: 0, pending: null, waits: [] };
  t.now = () => t.clock;
  t.setTimer = (fn, ms) => { t.waits.push(ms); t.pending = { fn, ms }; return t.pending; };
  t.clearTimer = (h) => { if (t.pending === h) t.pending = null; };
  t.fire = async () => { const p = t.pending; t.pending = null; await p.fn(); };
  return t;
};

describe('captureWaitMs', () => {
  it('uses the settle time before any capture', () => {
    assert.equal(captureWaitMs(1000, null, 2000), 2000);
  });

  it('holds back a capture that would land inside the minimum interval', () => {
    assert.equal(captureWaitMs(5000, 3000, 2000), MIN_CAPTURE_INTERVAL_MS - 2000);
  });

  it('uses the settle time once the interval has passed', () => {
    assert.equal(captureWaitMs(60000, 3000, 4000), 4000);
  });
});

describe('createThumbnailScheduler', () => {
  it('captures once after the first delay', async () => {
    const t = fakeTimers();
    let count = 0;
    const s = createThumbnailScheduler({ capture: async () => { count++; }, ...t });
    s.requestFirst();
    assert.equal(t.pending.ms, FIRST_CAPTURE_DELAY_MS);
    await t.fire();
    assert.equal(count, 1);
  });

  it('restarts the wait on each edit so a burst captures once', async () => {
    const t = fakeTimers();
    let count = 0;
    const s = createThumbnailScheduler({ capture: async () => { count++; }, ...t });
    s.requestAfterEdit();
    s.requestAfterEdit();
    s.requestAfterEdit();
    assert.deepEqual(t.waits, [EDIT_SETTLE_MS, EDIT_SETTLE_MS, EDIT_SETTLE_MS]);
    await t.fire();
    assert.equal(count, 1);
    assert.equal(t.pending, null);
  });

  it('spaces captures by the minimum interval', async () => {
    const t = fakeTimers();
    const s = createThumbnailScheduler({ capture: async () => {}, ...t });
    s.requestFirst();
    t.clock = 2000;
    await t.fire();
    t.clock = 3000;
    s.requestAfterEdit();
    assert.equal(t.pending.ms, MIN_CAPTURE_INTERVAL_MS - 1000);
  });

  it('cancel drops a pending capture', () => {
    const t = fakeTimers();
    const s = createThumbnailScheduler({ capture: async () => {}, ...t });
    s.requestFirst();
    s.cancel();
    assert.equal(t.pending, null);
  });
});

describe('captureSheetThumbnail / loadThumbnail', () => {
  const fakeApi = (shot) => {
    const store = {};
    return {
      store,
      window: { captureSelf: async () => shot },
      settings: {
        get: async (k) => ({ success: true, data: store[k] ?? null }),
        set: async (k, v) => { store[k] = v; return { success: true }; }
      }
    };
  };

  it('stores the captured image beside the sheet and loads it back', async () => {
    const api = fakeApi({ success: true, data: { dataUrl: JPEG } });
    assert.equal(await captureSheetThumbnail(api, 'abc'), true);
    assert.equal(api.store[thumbnailKey('abc')], JPEG);
    assert.equal(await loadThumbnail(api, 'abc'), JPEG);
  });

  it('stores nothing when the capture failed', async () => {
    const api = fakeApi({ success: false, error: 'Empty capture' });
    assert.equal(await captureSheetThumbnail(api, 'abc'), false);
    assert.equal(await loadThumbnail(api, 'abc'), null);
  });

  it('ignores a stored value that is not a JPEG data URL', async () => {
    const api = fakeApi(null);
    api.store[thumbnailKey('abc')] = 'javascript:alert(1)';
    assert.equal(await loadThumbnail(api, 'abc'), null);
  });
});
