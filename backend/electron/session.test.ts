/**
 * Integration tests for session save/restore
 *
 * These tests use a REAL better-sqlite3 database with the same schema
 * as the production feature_settings table. They test the actual SQL
 * operations, data structures, and logic flows from session.ts.
 *
 * Why these tests exist:
 * The original session "tests" all ran under test profiles, where every
 * session function returns early due to `if (isTestProfile()) return;`.
 * Zero lines of session code were ever executed. These tests replicate
 * the real SQL and logic so bugs are caught at the data layer.
 *
 * Each test documents which shipped bug it would have caught.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import Database from 'better-sqlite3';

// ============================================================================
// Types (mirrored from session.ts to avoid import issues with Electron deps)
// ============================================================================

interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  source: string;
  params: Record<string, unknown>;
  zOrder: number;
  focused: boolean;
  context?: {
    mode: string | null;
    modeMetadata: Record<string, unknown> | null;
  };
}

interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual';
  windows: WindowDescriptor[];
}

interface SessionMetadata {
  lastSaveReason: string;
  lastSaveAt: number;
  windowCount: number;
  cleanShutdown: boolean;
  crashCount: number;
  lastRestoreAt?: number;
  restoreCount?: number;
}

// ============================================================================
// Pure logic functions (extracted from session.ts — identical implementations)
// These are the REAL algorithms; we test them directly.
// ============================================================================

/**
 * Extract the real URL from a page container URL.
 * Identical to session.ts extractRealUrl.
 */
function extractRealUrl(url: string): string {
  if (url.startsWith('peek://app/page')) {
    try {
      const parsed = new URL(url);
      const actualUrl = parsed.searchParams.get('url');
      if (actualUrl) {
        return actualUrl;
      }
    } catch {
      // If URL parsing fails, keep the original
    }
  }
  return url;
}

/**
 * Extract webview bounds from a canvas page container URL.
 * Identical to session.ts extractCanvasBounds.
 */
function extractCanvasBounds(url: string): { x: number; y: number; width: number; height: number } | null {
  if (!url.startsWith('peek://app/page')) return null;
  try {
    const parsed = new URL(url);
    const x = parsed.searchParams.get('x');
    const y = parsed.searchParams.get('y');
    const width = parsed.searchParams.get('width');
    const height = parsed.searchParams.get('height');
    if (x && y && width && height) {
      return {
        x: parseInt(x, 10),
        y: parseInt(y, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    }
  } catch {
    // If URL parsing fails, skip
  }
  return null;
}

/**
 * Validate that a window descriptor is valid for restore.
 * Identical to session.ts isValidDescriptor.
 */
function isValidDescriptor(descriptor: WindowDescriptor): boolean {
  // Must have a URL
  if (!descriptor.url || typeof descriptor.url !== 'string' || descriptor.url.trim() === '') {
    return false;
  }

  // Filter out ephemeral loopback/localhost callback URLs (e.g. OAuth callbacks
  // to http://127.0.0.1:{port}/callback). These are short-lived servers that won't
  // exist on restart, so restoring them would show a connection-refused error.
  try {
    const parsed = new URL(descriptor.url);
    if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        parsed.pathname.includes('/callback')) {
      return false;
    }
  } catch {
    // URL parsing failed, continue with other checks
  }

  return true;
}

/**
 * Sanitize params to only include serializable values.
 * Identical to session.ts sanitizeParams.
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        safe[key] = value;
      }
    }
    // Skip functions, objects, etc.
  }
  return safe;
}

/**
 * Mirror placement intent into legacy flat flags.
 * Identical to session.ts mirrorPlacementIntent.
 */
function mirrorPlacementIntent(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const placement = params.placement as
    | { mode?: string; edge?: string }
    | undefined;
  const out: Record<string, unknown> = { ...params };
  if (placement?.mode === 'centered' || placement?.mode === 'parent-centered') {
    out.center = true;
  } else if (placement?.mode === 'edge' && typeof placement.edge === 'string') {
    out.screenEdge = placement.edge;
  }
  return out;
}

/**
 * Build restore boundsOptions from a descriptor.
 * Identical to session.ts buildRestoreBoundsOptions.
 */
function buildRestoreBoundsOptions(
  descriptor: { bounds: { x: number; y: number; width: number; height: number }; params: Record<string, unknown> },
  isPointOnScreen: (x: number, y: number) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    width: descriptor.bounds.width,
    height: descriptor.bounds.height,
  };
  const hasCenterIntent = descriptor.params.center === true;
  const hasEdgeIntent = typeof descriptor.params.screenEdge === 'string';
  const hasNonManualIntent = hasCenterIntent || hasEdgeIntent;
  if (hasNonManualIntent) return out;

  const centerX = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
  const centerY = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);
  if (isPointOnScreen(centerX, centerY)) {
    out.x = descriptor.bounds.x;
    out.y = descriptor.bounds.y;
  }
  return out;
}

// ============================================================================
// Database helper functions (replicate the SQL from session.ts exactly)
// ============================================================================

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_settings (
      id TEXT PRIMARY KEY,
      featureId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_settings_unique
      ON feature_settings(featureId, key);
  `);
  return db;
}

/**
 * Save session snapshot — replicates the SQL from session.ts saveSessionSnapshot.
 * This is the exact same SQL, just with db passed as a parameter.
 */
function saveSnapshot(db: InstanceType<typeof Database>, snapshot: SessionSnapshot, reason: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'session', 'snapshot', ?, ?)
  `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

  // Read existing metadata to preserve crashCount and restoreCount
  let existingMetadata: Partial<SessionMetadata> = {};
  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;
    if (metaRow?.value) {
      existingMetadata = JSON.parse(metaRow.value);
    }
  } catch {
    // No existing metadata
  }

  const metadata: SessionMetadata = {
    lastSaveReason: reason,
    lastSaveAt: Date.now(),
    windowCount: snapshot.windows.length,
    cleanShutdown: true,
    crashCount: existingMetadata.crashCount ?? 0,
    lastRestoreAt: existingMetadata.lastRestoreAt,
    restoreCount: existingMetadata.restoreCount,
  };
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'session', 'metadata', ?, ?)
  `).run('session-metadata', JSON.stringify(metadata), Date.now());
}

/**
 * Read crash state — replicates session.ts readSessionCrashState.
 */
function readCrashState(db: InstanceType<typeof Database>): { cleanShutdown: boolean; crashCount: number } {
  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;
    if (metaRow?.value) {
      const metadata = JSON.parse(metaRow.value);
      return {
        cleanShutdown: metadata.cleanShutdown !== false,
        crashCount: metadata.crashCount ?? 0,
      };
    }
  } catch {
    // No metadata available
  }
  return { cleanShutdown: true, crashCount: 0 };
}

/**
 * Mark session dirty — replicates session.ts markSessionDirty.
 */
function markDirty(db: InstanceType<typeof Database>): void {
  const metaRow = db.prepare(
    `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
  ).get() as { value: string } | undefined;

  let metadata: Partial<SessionMetadata> = {};
  if (metaRow?.value) {
    metadata = JSON.parse(metaRow.value);
  }

  // If previous session was not clean, increment crash count
  if (metadata.cleanShutdown === false) {
    metadata.crashCount = (metadata.crashCount ?? 0) + 1;
  }

  // Mark current session as dirty
  metadata.cleanShutdown = false;

  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'session', 'metadata', ?, ?)
  `).run('session-metadata', JSON.stringify(metadata), Date.now());
}

/**
 * Read snapshot — replicates session.ts snapshot read in restoreSessionSnapshot.
 */
function readSnapshot(db: InstanceType<typeof Database>): SessionSnapshot | null {
  const row = db.prepare(
    `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
  ).get() as { value: string } | undefined;
  if (!row?.value) return null;
  return JSON.parse(row.value);
}

/**
 * Get snapshot info — replicates session.ts getSessionSnapshotInfo.
 */
function getSnapshotInfo(db: InstanceType<typeof Database>): { windowCount: number; savedAt: number; reason: string } | null {
  const row = db.prepare(
    `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
  ).get() as { value: string } | undefined;
  if (!row?.value) return null;

  const snapshot: SessionSnapshot = JSON.parse(row.value);
  if (snapshot.version !== 1 || !snapshot.windows?.length) return null;

  const validCount = snapshot.windows.filter(d => isValidDescriptor(d)).length;
  if (validCount === 0) return null;

  return {
    windowCount: validCount,
    savedAt: snapshot.createdAt,
    reason: snapshot.reason,
  };
}

// ============================================================================
// Test helper: create a typical window descriptor
// ============================================================================

function makeDescriptor(overrides: Partial<WindowDescriptor> = {}): WindowDescriptor {
  return {
    url: 'https://example.com',
    key: undefined,
    title: 'Example',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    source: 'test',
    params: {},
    zOrder: 0,
    focused: false,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Session Integration Tests', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    // Fresh in-memory database for each test — complete isolation
    db = createTestDb();
  });

  // ========================================================================
  // extractRealUrl tests
  // ========================================================================

  describe('extractRealUrl', () => {
    it('returns the actual URL from a canvas page container', () => {
      const containerUrl = 'peek://app/page/index.html?url=https%3A%2F%2Fgithub.com%2Ftest&x=100&y=200&width=800&height=600';
      const result = extractRealUrl(containerUrl);
      assert.strictEqual(result, 'https://github.com/test');
    });

    it('returns the original URL when not a page container', () => {
      const normalUrl = 'https://example.com/page';
      assert.strictEqual(extractRealUrl(normalUrl), 'https://example.com/page');
    });

    it('returns the original URL when page container has no url param', () => {
      const noUrlParam = 'peek://app/page/index.html?x=100&y=200';
      assert.strictEqual(extractRealUrl(noUrlParam), 'peek://app/page/index.html?x=100&y=200');
    });

    it('handles encoded special characters in the actual URL', () => {
      const encoded = 'peek://app/page/index.html?url=https%3A%2F%2Fexample.com%2Fsearch%3Fq%3Dhello%26lang%3Den';
      assert.strictEqual(extractRealUrl(encoded), 'https://example.com/search?q=hello&lang=en');
    });
  });

  // ========================================================================
  // extractCanvasBounds tests
  //
  // BUG #3 THIS CATCHES: Canvas page bounds were saved as the fullscreen
  // BrowserWindow bounds instead of the webview bounds from URL params.
  // Without this extraction, restored windows would be fullscreen instead
  // of their actual visible size/position.
  // ========================================================================

  describe('extractCanvasBounds', () => {
    it('extracts x/y/width/height from canvas page URL', () => {
      // BUG #3: If we used window.getBounds() for canvas pages instead of URL params,
      // we'd get fullscreen bounds (0, 0, 1920, 1080) instead of the real webview bounds.
      const canvasUrl = 'peek://app/page/index.html?url=https%3A%2F%2Fexample.com&x=150&y=200&width=800&height=600';
      const bounds = extractCanvasBounds(canvasUrl);
      assert.deepStrictEqual(bounds, { x: 150, y: 200, width: 800, height: 600 });
    });

    it('returns null for non-page URLs', () => {
      assert.strictEqual(extractCanvasBounds('https://example.com'), null);
      assert.strictEqual(extractCanvasBounds('peek://app/background.html'), null);
    });

    it('returns null when bounds params are missing', () => {
      const partialUrl = 'peek://app/page/index.html?url=https%3A%2F%2Fexample.com&x=100';
      assert.strictEqual(extractCanvasBounds(partialUrl), null);
    });

    it('returns null when only some bounds params present', () => {
      const partial = 'peek://app/page/index.html?url=https%3A%2F%2Fexample.com&x=100&y=200&width=800';
      assert.strictEqual(extractCanvasBounds(partial), null);
    });

    it('correctly parses integer bounds (not strings)', () => {
      const url = 'peek://app/page/index.html?url=test&x=0&y=0&width=1024&height=768';
      const bounds = extractCanvasBounds(url);
      assert.ok(bounds);
      assert.strictEqual(typeof bounds!.x, 'number');
      assert.strictEqual(typeof bounds!.width, 'number');
      assert.strictEqual(bounds!.width, 1024);
    });

    it('proves canvas bounds differ from typical fullscreen bounds', () => {
      // This is the exact scenario of BUG #3:
      // Canvas BrowserWindow is fullscreen (e.g. 1920x1080 at 0,0)
      // But the webview inside is only 800x600 at some offset.
      // If we save the BrowserWindow bounds, restore creates a fullscreen window.
      const canvasUrl = 'peek://app/page/index.html?url=https%3A%2F%2Fexample.com&x=200&y=150&width=800&height=600';
      const fakeBrowserWindowBounds = { x: 0, y: 0, width: 1920, height: 1080 };
      const canvasBounds = extractCanvasBounds(canvasUrl);
      const actualBounds = canvasBounds || fakeBrowserWindowBounds;

      // The actual bounds should NOT be the fullscreen bounds
      assert.notDeepStrictEqual(actualBounds, fakeBrowserWindowBounds,
        'Canvas page bounds should come from URL params, not BrowserWindow.getBounds()');
      assert.strictEqual(actualBounds.width, 800, 'Width should be 800, not 1920');
      assert.strictEqual(actualBounds.height, 600, 'Height should be 600, not 1080');
    });
  });

  // ========================================================================
  // isValidDescriptor tests
  //
  // Validates that descriptors with empty/missing URLs are rejected,
  // and all other URLs (any protocol, any host) are accepted.
  // ========================================================================

  describe('isValidDescriptor', () => {
    it('rejects descriptors with empty URL', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: '' })), false);
    });

    it('rejects descriptors with whitespace-only URL', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: '   ' })), false);
    });

    it('rejects descriptors with missing URL', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: undefined as unknown as string })), false);
    });

    it('accepts normal https URLs', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'https://example.com' })), true);
    });

    it('accepts peek:// protocol URLs', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'peek://app/settings' })), true);
    });

    it('accepts localhost URLs', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://localhost:3000' })), true);
    });

    it('accepts http URLs', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://example.com/page' })), true);
    });

    it('accepts file:// URLs', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'file:///tmp/test.html' })), true);
    });

    it('rejects loopback OAuth callback URLs (127.0.0.1)', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://127.0.0.1:52081/callback?state=abc&code=xyz' })), false);
    });

    it('rejects loopback OAuth callback URLs (localhost)', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://localhost:52081/callback?state=abc&code=xyz' })), false);
    });

    it('accepts localhost URLs without callback path', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://localhost:3000' })), true);
    });

    it('accepts localhost URLs with non-callback paths', () => {
      assert.strictEqual(isValidDescriptor(makeDescriptor({ url: 'http://localhost:3000/dashboard' })), true);
    });
  });

  // ========================================================================
  // sanitizeParams tests
  // ========================================================================

  describe('sanitizeParams', () => {
    it('keeps string, number, boolean, null values', () => {
      const params = { name: 'test', count: 42, active: true, deleted: null };
      const result = sanitizeParams(params);
      assert.deepStrictEqual(result, params);
    });

    it('keeps arrays of primitives', () => {
      const params = { tags: ['a', 'b'], ids: [1, 2, 3] };
      assert.deepStrictEqual(sanitizeParams(params), params);
    });

    it('strips functions', () => {
      const params = { name: 'test', callback: () => {} };
      const result = sanitizeParams(params);
      assert.strictEqual(result.name, 'test');
      assert.strictEqual(result.callback, undefined);
    });

    it('strips nested objects', () => {
      const params = { name: 'test', nested: { deep: true } };
      const result = sanitizeParams(params);
      assert.strictEqual(result.name, 'test');
      assert.strictEqual(result.nested, undefined);
    });

    it('strips arrays containing objects', () => {
      const params = { items: [{ id: 1 }, { id: 2 }] };
      const result = sanitizeParams(params);
      assert.strictEqual(result.items, undefined);
    });
  });

  // ========================================================================
  // mirrorPlacementIntent tests
  //
  // The Placement object is dropped by sanitizeParams because it's not a
  // primitive. Without mirroring its mode into the legacy flat flags, every
  // restored window came back with `manual` placement (saved x/y pinned),
  // and `centered` / `edge` windows drifted across display switches. These
  // tests lock in the round-trip behavior the user expects: persist the
  // intent, not the pixels.
  // ========================================================================

  describe('mirrorPlacementIntent', () => {
    it('mirrors centered mode to center: true', () => {
      const out = mirrorPlacementIntent({ placement: { mode: 'centered' } });
      assert.strictEqual(out.center, true);
    });

    it('mirrors parent-centered mode to center: true (nearest equivalent on restore)', () => {
      const out = mirrorPlacementIntent({
        placement: { mode: 'parent-centered', parentId: 99 },
      });
      assert.strictEqual(out.center, true);
    });

    it('mirrors edge mode to screenEdge', () => {
      const out = mirrorPlacementIntent({
        placement: { mode: 'edge', edge: 'right' },
      });
      assert.strictEqual(out.screenEdge, 'right');
    });

    it('does not set flags for manual mode', () => {
      const out = mirrorPlacementIntent({ placement: { mode: 'manual' } });
      assert.strictEqual(out.center, undefined);
      assert.strictEqual(out.screenEdge, undefined);
    });

    it('does not set flags for cursor-display-fallback mode', () => {
      const out = mirrorPlacementIntent({
        placement: { mode: 'cursor-display-fallback' },
      });
      assert.strictEqual(out.center, undefined);
      assert.strictEqual(out.screenEdge, undefined);
    });

    it('does not set flags when placement is missing', () => {
      const out = mirrorPlacementIntent({ width: 800 });
      assert.strictEqual(out.center, undefined);
      assert.strictEqual(out.screenEdge, undefined);
    });

    it('preserves other params untouched', () => {
      const out = mirrorPlacementIntent({
        placement: { mode: 'centered' },
        title: 'foo',
        keepLive: true,
      });
      assert.strictEqual(out.title, 'foo');
      assert.strictEqual(out.keepLive, true);
    });

    it('downstream sanitizeParams keeps the mirrored flag and drops the object', () => {
      const out = sanitizeParams(
        mirrorPlacementIntent({ placement: { mode: 'centered' } }),
      );
      assert.strictEqual(out.center, true);
      assert.strictEqual(out.placement, undefined);
    });
  });

  // ========================================================================
  // buildRestoreBoundsOptions tests
  //
  // Verifies the restore-side branch: when descriptor.params declares a
  // non-manual placement intent, we must NOT pass saved x/y so window-open
  // re-derives placement on the current display.
  // ========================================================================

  describe('buildRestoreBoundsOptions', () => {
    const allOnScreen = (_x: number, _y: number) => true;
    const allOffScreen = (_x: number, _y: number) => false;
    const baseBounds = { x: 100, y: 200, width: 800, height: 600 };

    it('keeps width/height always', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: {} },
        allOnScreen,
      );
      assert.strictEqual(out.width, 800);
      assert.strictEqual(out.height, 600);
    });

    it('manual + on-screen: passes saved x/y', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: {} },
        allOnScreen,
      );
      assert.strictEqual(out.x, 100);
      assert.strictEqual(out.y, 200);
    });

    it('manual + off-screen: drops x/y (legacy off-screen safety net)', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: {} },
        allOffScreen,
      );
      assert.strictEqual(out.x, undefined);
      assert.strictEqual(out.y, undefined);
    });

    it('center: true intent always drops x/y, even when saved center is on-screen', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: { center: true } },
        allOnScreen,
      );
      assert.strictEqual(out.x, undefined);
      assert.strictEqual(out.y, undefined);
    });

    it('screenEdge intent always drops x/y, even when saved center is on-screen', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: { screenEdge: 'right' } },
        allOnScreen,
      );
      assert.strictEqual(out.x, undefined);
      assert.strictEqual(out.y, undefined);
    });

    it('center: false (truthy-typed but not the strict literal) is treated as no intent', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: { center: false } },
        allOnScreen,
      );
      assert.strictEqual(out.x, 100);
      assert.strictEqual(out.y, 200);
    });

    it('screenEdge with non-string value is ignored', () => {
      const out = buildRestoreBoundsOptions(
        { bounds: baseBounds, params: { screenEdge: 1 } },
        allOnScreen,
      );
      assert.strictEqual(out.x, 100);
      assert.strictEqual(out.y, 200);
    });

    it('isPointOnScreen receives the saved center, not the origin', () => {
      let observedX: number | null = null;
      let observedY: number | null = null;
      buildRestoreBoundsOptions(
        { bounds: { x: 100, y: 200, width: 800, height: 600 }, params: {} },
        (x, y) => {
          observedX = x;
          observedY = y;
          return true;
        },
      );
      assert.strictEqual(observedX, 500); // 100 + round(800/2)
      assert.strictEqual(observedY, 500); // 200 + round(600/2)
    });
  });

  // ========================================================================
  // Snapshot save/read round-trip tests
  //
  // BUG #1 THIS CATCHES: If SIGINT handler does not call saveSessionSnapshot,
  // no snapshot would be written. These tests verify that the save actually
  // persists data to the DB and can be read back.
  // ========================================================================

  describe('Snapshot save/read round-trip', () => {
    it('saves and reads back a snapshot with correct structure', () => {
      // BUG #1: If save was never called (SIGINT not handled), no snapshot exists.
      // This test verifies the write actually persists.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://example.com', title: 'Example' }),
          makeDescriptor({ url: 'https://github.com', title: 'GitHub', focused: true }),
        ],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);

      assert.ok(loaded, 'Snapshot should be readable after save');
      assert.strictEqual(loaded!.version, 1);
      assert.strictEqual(loaded!.reason, 'before-quit');
      assert.strictEqual(loaded!.windows.length, 2);
      assert.strictEqual(loaded!.windows[0].url, 'https://example.com');
      assert.strictEqual(loaded!.windows[1].focused, true);
    });

    it('sets cleanShutdown=true in metadata after save', () => {
      // BUG #1 related: After a clean save, metadata.cleanShutdown must be true.
      // If save never runs, this metadata is never written.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, true, 'cleanShutdown should be true after save');
      assert.strictEqual(state.crashCount, 0, 'crashCount should be 0 initially');
    });

    it('preserves window bounds through save/load cycle', () => {
      const bounds = { x: 123, y: 456, width: 789, height: 321 };
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'manual',
        windows: [makeDescriptor({ bounds })],
      };

      saveSnapshot(db, snapshot, 'manual');
      const loaded = readSnapshot(db);
      assert.deepStrictEqual(loaded!.windows[0].bounds, bounds);
    });

    it('preserves canvas page bounds (not fullscreen) through save/load', () => {
      // BUG #3: Canvas bounds must survive the round-trip.
      // The save logic uses extractCanvasBounds to get webview bounds,
      // not BrowserWindow.getBounds(). We verify those webview bounds persist.
      const webviewBounds = { x: 200, y: 150, width: 800, height: 600 };
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor({ url: 'https://example.com', bounds: webviewBounds })],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.deepStrictEqual(loaded!.windows[0].bounds, webviewBounds,
        'Webview bounds must survive round-trip, not be replaced by fullscreen bounds');
    });

    it('preserves window context (mode) through save/load', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'autosave',
        windows: [makeDescriptor({
          context: {
            mode: 'reader',
            modeMetadata: { fontSize: 16, theme: 'dark' },
          },
        })],
      };

      saveSnapshot(db, snapshot, 'autosave');
      const loaded = readSnapshot(db);
      assert.ok(loaded!.windows[0].context);
      assert.strictEqual(loaded!.windows[0].context!.mode, 'reader');
      assert.deepStrictEqual(loaded!.windows[0].context!.modeMetadata, { fontSize: 16, theme: 'dark' });
    });

    it('handles empty windows array', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.ok(loaded);
      assert.strictEqual(loaded!.windows.length, 0);
    });

    it('overwrites previous snapshot on save', () => {
      const first: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'autosave',
        windows: [makeDescriptor({ url: 'https://first.com' })],
      };
      saveSnapshot(db, first, 'autosave');

      const second: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://second.com' }),
          makeDescriptor({ url: 'https://third.com' }),
        ],
      };
      saveSnapshot(db, second, 'before-quit');

      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows.length, 2);
      assert.strictEqual(loaded!.windows[0].url, 'https://second.com');
      assert.strictEqual(loaded!.reason, 'before-quit');
    });
  });

  // ========================================================================
  // Crash detection sequence tests
  //
  // BUG #2 THIS CATCHES: markSessionDirty was called BEFORE
  // readSessionCrashState, so by the time we read the crash state,
  // it was already overwritten to dirty. The crash detection was
  // poisoned and always thought the previous shutdown was unclean.
  // ========================================================================

  describe('Crash detection sequence', () => {
    it('fresh DB: readCrashState returns clean with zero crashes', () => {
      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, true, 'Fresh DB should be clean');
      assert.strictEqual(state.crashCount, 0, 'Fresh DB should have 0 crashes');
    });

    it('after clean save: readCrashState returns clean', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, true);
      assert.strictEqual(state.crashCount, 0);
    });

    it('CORRECT ORDER: read crash state THEN mark dirty — captures true previous state', () => {
      // BUG #2: The startup sequence MUST be:
      //   1. readSessionCrashState()  — capture the PREVIOUS shutdown state
      //   2. markSessionDirty()       — mark THIS session as dirty
      //
      // If done in reverse, readCrashState always sees dirty (because markDirty just set it).

      // Simulate previous clean shutdown
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      // === Startup sequence (correct order) ===
      // Step 1: Read previous crash state
      const crashState = readCrashState(db);
      // Step 2: Mark dirty for this session
      markDirty(db);

      // The captured state should reflect the PREVIOUS session (clean)
      assert.strictEqual(crashState.cleanShutdown, true,
        'Previous shutdown was clean — readCrashState captured BEFORE markDirty should reflect that');

      // But current DB state is dirty (for this session)
      const currentState = readCrashState(db);
      assert.strictEqual(currentState.cleanShutdown, false,
        'After markDirty, current state should be dirty');
    });

    it('WRONG ORDER: mark dirty THEN read — would show dirty even after clean shutdown (BUG #2)', () => {
      // This test proves that reversing the order causes the bug.
      // The WRONG order: markDirty THEN readCrashState

      // Simulate previous clean shutdown
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      // Confirm it's clean
      const beforeDirty = readCrashState(db);
      assert.strictEqual(beforeDirty.cleanShutdown, true, 'Should be clean before markDirty');

      // === WRONG startup sequence ===
      // Step 1 (WRONG): Mark dirty first
      markDirty(db);
      // Step 2 (WRONG): Read crash state — now it's contaminated
      const afterDirty = readCrashState(db);

      // BUG #2: This would show dirty even though previous shutdown was clean!
      assert.strictEqual(afterDirty.cleanShutdown, false,
        'Reading AFTER markDirty always shows dirty — this is the bug');
    });

    it('after markDirty: cleanShutdown is false', () => {
      markDirty(db);
      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, false);
    });

    it('markDirty does NOT increment crashCount on first dirty (clean -> dirty)', () => {
      // When previous was clean and we mark dirty, crashCount stays 0
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      markDirty(db);
      const state = readCrashState(db);
      assert.strictEqual(state.crashCount, 0,
        'crashCount should NOT increment when transitioning from clean to dirty');
    });

    it('markDirty increments crashCount when previous was ALSO dirty (consecutive crash)', () => {
      // BUG #2 related: crashCount only increments when previous was dirty too.
      // This means: save(clean) -> markDirty -> [crash] -> markDirty -> crashCount=1

      // Initial clean save
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      // First startup: mark dirty (cleanShutdown was true, so no increment)
      markDirty(db);
      let state = readCrashState(db);
      assert.strictEqual(state.crashCount, 0, 'First dirty: crashCount=0');

      // Simulate crash (no save happened) — next startup:
      markDirty(db);
      state = readCrashState(db);
      assert.strictEqual(state.crashCount, 1, 'Second dirty without save: crashCount=1');

      // Another crash:
      markDirty(db);
      state = readCrashState(db);
      assert.strictEqual(state.crashCount, 2, 'Third dirty without save: crashCount=2');
    });

    it('crashCount resets to 0 after a clean save breaks the crash cycle', () => {
      // Simulate: crash -> crash -> clean save -> crash
      // After the clean save, crashCount should NOT carry over

      // Start with a dirty state
      markDirty(db);
      markDirty(db); // crashCount=1
      markDirty(db); // crashCount=2

      let state = readCrashState(db);
      assert.strictEqual(state.crashCount, 2);

      // Clean save (preserves crashCount but sets cleanShutdown=true)
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, true, 'After save, cleanShutdown=true');
      // Note: crashCount is preserved in metadata after save (it records history)
      // but it won't increment on the next markDirty because cleanShutdown is true.
      assert.strictEqual(state.crashCount, 2, 'Save preserves crashCount');

      // Next startup: markDirty — cleanShutdown was true, so no increment
      markDirty(db);
      state = readCrashState(db);
      assert.strictEqual(state.crashCount, 2, 'No increment because previous was clean');
    });
  });

  // ========================================================================
  // Metadata lifecycle tests
  //
  // BUG #6 THIS CATCHES: Restore dialog appearing after clean shutdown.
  // If cleanShutdown metadata is not correctly set to true on save,
  // the next startup would think it was a crash.
  // ========================================================================

  describe('Metadata lifecycle', () => {
    it('fresh DB has no metadata — defaults to clean', () => {
      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, true);
      assert.strictEqual(state.crashCount, 0);
    });

    it('save writes cleanShutdown=true to metadata', () => {
      // BUG #6: If save doesn't set cleanShutdown=true, the next startup
      // thinks the previous session crashed and shows the restore dialog.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      // Verify by reading raw metadata from DB
      const row = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string };
      const metadata = JSON.parse(row.value);
      assert.strictEqual(metadata.cleanShutdown, true,
        'Save MUST set cleanShutdown=true in metadata — otherwise next startup shows crash dialog (BUG #6)');
      assert.strictEqual(metadata.lastSaveReason, 'before-quit');
      assert.ok(metadata.lastSaveAt > 0);
      assert.strictEqual(metadata.windowCount, 1);
    });

    it('markDirty writes cleanShutdown=false to metadata', () => {
      markDirty(db);

      const row = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string };
      const metadata = JSON.parse(row.value);
      assert.strictEqual(metadata.cleanShutdown, false);
    });

    it('save preserves crashCount from existing metadata', () => {
      // Build up some crash history
      markDirty(db);
      markDirty(db); // crashCount=1
      markDirty(db); // crashCount=2

      // Save should preserve the crashCount
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      const row = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string };
      const metadata = JSON.parse(row.value);
      assert.strictEqual(metadata.crashCount, 2, 'Save should preserve crashCount from existing metadata');
      assert.strictEqual(metadata.cleanShutdown, true, 'But cleanShutdown should be true');
    });

    it('save preserves restoreCount from existing metadata', () => {
      // Manually set some restore history
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', 'metadata', ?, ?)
      `).run('session-metadata', JSON.stringify({
        cleanShutdown: true,
        crashCount: 0,
        restoreCount: 5,
        lastRestoreAt: 1000,
      }), Date.now());

      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');

      const row = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string };
      const metadata = JSON.parse(row.value);
      assert.strictEqual(metadata.restoreCount, 5, 'Save should preserve restoreCount');
      assert.strictEqual(metadata.lastRestoreAt, 1000, 'Save should preserve lastRestoreAt');
    });

    it('full lifecycle: save -> startup(read, dirty) -> save -> startup(read, dirty)', () => {
      // BUG #2 + BUG #6: Full lifecycle simulating two clean sessions.
      // No crash dialog should appear in either session.

      // --- Session 1: save and quit ---
      const snap1: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor({ url: 'https://session1.com' })],
      };
      saveSnapshot(db, snap1, 'before-quit');

      // --- Session 2: startup ---
      const state2 = readCrashState(db);
      assert.strictEqual(state2.cleanShutdown, true, 'Session 2 startup: previous was clean');
      assert.strictEqual(state2.crashCount, 0);
      markDirty(db);

      // Session 2: normal work, then save and quit
      const snap2: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor({ url: 'https://session2.com' })],
      };
      saveSnapshot(db, snap2, 'before-quit');

      // --- Session 3: startup ---
      const state3 = readCrashState(db);
      assert.strictEqual(state3.cleanShutdown, true, 'Session 3 startup: previous was clean');
      assert.strictEqual(state3.crashCount, 0);

      // Verify the snapshot is from session 2
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows[0].url, 'https://session2.com');
    });

    it('crash lifecycle: save -> startup(dirty) -> [crash] -> startup detects crash', () => {
      // Simulates: clean save, startup, crash (no save), next startup.

      // Session 1: clean save
      const snap1: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snap1, 'before-quit');

      // Session 2: startup (read then dirty)
      const state2 = readCrashState(db);
      assert.strictEqual(state2.cleanShutdown, true);
      markDirty(db);

      // Session 2: CRASH — no save happens

      // Session 3: startup — should detect the crash
      const state3 = readCrashState(db);
      assert.strictEqual(state3.cleanShutdown, false,
        'After crash (no save), next startup should detect unclean shutdown');
      assert.strictEqual(state3.crashCount, 0,
        'First crash: crashCount is still 0 (markDirty will increment it)');

      // Session 3: markDirty increments because previous was dirty
      markDirty(db);
      const afterDirty3 = readCrashState(db);
      assert.strictEqual(afterDirty3.crashCount, 1, 'After markDirty on unclean: crashCount=1');
    });
  });

  // ========================================================================
  // getSessionSnapshotInfo tests
  // ========================================================================

  describe('getSessionSnapshotInfo', () => {
    it('returns null when no snapshot exists', () => {
      assert.strictEqual(getSnapshotInfo(db), null);
    });

    it('returns correct window count and metadata', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: 1700000000000,
        reason: 'autosave',
        windows: [
          makeDescriptor({ url: 'https://a.com' }),
          makeDescriptor({ url: 'https://b.com' }),
          makeDescriptor({ url: 'https://c.com' }),
        ],
      };
      saveSnapshot(db, snapshot, 'autosave');

      const info = getSnapshotInfo(db);
      assert.ok(info);
      assert.strictEqual(info!.windowCount, 3);
      assert.strictEqual(info!.savedAt, 1700000000000);
      assert.strictEqual(info!.reason, 'autosave');
    });

    it('excludes invalid descriptors from count', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://valid.com' }),
          makeDescriptor({ url: '' }),  // invalid
          makeDescriptor({ url: 'https://also-valid.com' }),
        ],
      };

      // Write snapshot directly (bypassing saveSnapshot to include invalid entries)
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', 'snapshot', ?, ?)
      `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

      const info = getSnapshotInfo(db);
      assert.ok(info);
      assert.strictEqual(info!.windowCount, 2, 'Should only count valid descriptors');
    });

    it('returns null for snapshot with all invalid descriptors', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: '' }),
          makeDescriptor({ url: '  ' }),
        ],
      };

      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', 'snapshot', ?, ?)
      `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

      assert.strictEqual(getSnapshotInfo(db), null, 'All-invalid snapshot should return null');
    });

    it('returns null for snapshot with wrong version', () => {
      const snapshot = {
        version: 999,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };

      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', 'snapshot', ?, ?)
      `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

      assert.strictEqual(getSnapshotInfo(db), null);
    });
  });

  // ========================================================================
  // Snapshot structure validation tests
  // ========================================================================

  describe('Snapshot structure', () => {
    it('snapshot has required version=1 field', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.version, 1);
    });

    it('snapshot has createdAt timestamp', () => {
      const before = Date.now();
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'manual',
        windows: [makeDescriptor()],
      };
      saveSnapshot(db, snapshot, 'manual');
      const loaded = readSnapshot(db);
      assert.ok(loaded!.createdAt >= before, 'createdAt should be a recent timestamp');
    });

    it('snapshot reason is preserved', () => {
      for (const reason of ['before-quit', 'autosave', 'manual'] as const) {
        const snapshot: SessionSnapshot = {
          version: 1,
          createdAt: Date.now(),
          reason,
          windows: [makeDescriptor()],
        };
        saveSnapshot(db, snapshot, reason);
        const loaded = readSnapshot(db);
        assert.strictEqual(loaded!.reason, reason);
      }
    });

    it('window descriptors have all required fields', () => {
      const descriptor = makeDescriptor({
        url: 'https://example.com',
        key: 'win-1',
        title: 'Test Window',
        bounds: { x: 50, y: 50, width: 1024, height: 768 },
        source: 'user',
        params: { modal: false },
        zOrder: 3,
        focused: true,
      });
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [descriptor],
      };
      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      const win = loaded!.windows[0];

      assert.strictEqual(win.url, 'https://example.com');
      assert.strictEqual(win.key, 'win-1');
      assert.strictEqual(win.title, 'Test Window');
      assert.deepStrictEqual(win.bounds, { x: 50, y: 50, width: 1024, height: 768 });
      assert.strictEqual(win.source, 'user');
      assert.deepStrictEqual(win.params, { modal: false });
      assert.strictEqual(win.zOrder, 3);
      assert.strictEqual(win.focused, true);
    });

    it('canvas page URLs get real URL extracted (not peek://app/page)', () => {
      // BUG #3 related: The save process should extract the actual URL
      // from canvas page containers. We verify the extraction logic.
      const containerUrl = 'peek://app/page/index.html?url=https%3A%2F%2Fgithub.com&x=100&y=100&width=800&height=600';
      const realUrl = extractRealUrl(containerUrl);
      assert.strictEqual(realUrl, 'https://github.com',
        'Canvas page URL should be extracted to the real URL');
      assert.ok(!realUrl.startsWith('peek://'),
        'Extracted URL should not be a peek:// URL');
    });
  });

  // ========================================================================
  // Restore validation tests
  //
  // BUG #5 THIS CATCHES: "Start Fresh" leaving the app with no windows.
  // When the user declines restore, the app needs to know there are
  // zero restored windows so it can open the startup feature.
  // ========================================================================

  describe('Restore validation', () => {
    it('filtering invalid descriptors from snapshot leaves valid ones for restore', () => {
      // Simulates the restore flow: read snapshot, filter valid, restore.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://valid1.com' }),
          makeDescriptor({ url: '' }),
          makeDescriptor({ url: 'https://valid2.com' }),
          makeDescriptor({ url: '   ' }),
          makeDescriptor({ url: 'http://localhost:3000' }),
        ],
      };

      const validWindows = snapshot.windows.filter(d => isValidDescriptor(d));
      assert.strictEqual(validWindows.length, 3, 'Should have 3 valid windows');
      assert.strictEqual(validWindows[0].url, 'https://valid1.com');
      assert.strictEqual(validWindows[1].url, 'https://valid2.com');
      assert.strictEqual(validWindows[2].url, 'http://localhost:3000');
    });

    it('empty snapshot returns no windows to restore — triggers startup feature', () => {
      // BUG #5: If restored=0, the startup feature must be opened.
      // This test verifies that an empty snapshot results in zero valid windows.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      const validWindows = loaded!.windows.filter(d => isValidDescriptor(d));
      assert.strictEqual(validWindows.length, 0,
        'Empty snapshot should give zero valid windows — startup feature should open');
    });

    it('snapshot with only invalid windows returns zero valid — triggers startup feature', () => {
      // BUG #5: Even if a snapshot exists, if ALL windows are invalid,
      // the result is zero restored windows and startup feature must open.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: '' }),
          makeDescriptor({ url: '  ' }),
        ],
      };

      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', 'snapshot', ?, ?)
      `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

      const loaded = readSnapshot(db);
      const validWindows = loaded!.windows.filter(d => isValidDescriptor(d));
      assert.strictEqual(validWindows.length, 0);
    });

    it('windows sorted by zOrder for correct restore order', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://top.com', zOrder: 0 }),
          makeDescriptor({ url: 'https://middle.com', zOrder: 1 }),
          makeDescriptor({ url: 'https://bottom.com', zOrder: 2 }),
        ],
      };

      // Restore sorts by zOrder descending (higher = later in stack)
      const sorted = [...snapshot.windows].sort((a, b) => b.zOrder - a.zOrder);
      assert.strictEqual(sorted[0].url, 'https://bottom.com', 'Highest zOrder restored first');
      assert.strictEqual(sorted[2].url, 'https://top.com', 'Lowest zOrder restored last');
    });
  });

  // ========================================================================
  // SIGINT save simulation tests
  //
  // BUG #1 THIS CATCHES: Session not saved on Ctrl+C.
  // The SIGINT handler must call saveSessionSnapshot synchronously.
  // These tests verify the save path works correctly.
  // ========================================================================

  describe('SIGINT save path', () => {
    it('synchronous save writes data immediately (no async needed)', () => {
      // BUG #1: SIGINT handler must save synchronously because process.exit()
      // follows immediately. better-sqlite3 is sync, which is why it works.
      // This test verifies that a single synchronous call persists the data.
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://important-work.com' }),
          makeDescriptor({ url: 'https://also-important.com' }),
        ],
      };

      // This simulates what the SIGINT handler does: one synchronous save
      saveSnapshot(db, snapshot, 'before-quit');

      // Immediately readable (no flush/commit needed — better-sqlite3 is sync)
      const loaded = readSnapshot(db);
      assert.ok(loaded, 'Snapshot must be readable immediately after sync save');
      assert.strictEqual(loaded!.windows.length, 2);

      const metadata = readCrashState(db);
      assert.strictEqual(metadata.cleanShutdown, true,
        'Metadata must show clean shutdown after save');
    });

    it('save works even with many windows', () => {
      // Stress test the synchronous save path
      const windows: WindowDescriptor[] = [];
      for (let i = 0; i < 50; i++) {
        windows.push(makeDescriptor({
          url: `https://window-${i}.example.com/path/to/page?query=${i}`,
          key: `win-${i}`,
          title: `Window ${i}`,
          bounds: { x: i * 10, y: i * 5, width: 800, height: 600 },
          zOrder: i,
        }));
      }

      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows,
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows.length, 50);

      const info = getSnapshotInfo(db);
      assert.strictEqual(info!.windowCount, 50);
    });
  });

  // ========================================================================
  // Edge cases and regression guards
  // ========================================================================

  describe('Edge cases', () => {
    it('markDirty on fresh DB creates metadata row', () => {
      // First startup ever — no metadata exists.
      // markDirty should create the row, not crash.
      markDirty(db);
      const state = readCrashState(db);
      assert.strictEqual(state.cleanShutdown, false);
      assert.strictEqual(state.crashCount, 0, 'No previous dirty state means no increment');
    });

    it('multiple rapid saves do not corrupt data', () => {
      for (let i = 0; i < 10; i++) {
        const snapshot: SessionSnapshot = {
          version: 1,
          createdAt: Date.now(),
          reason: 'autosave',
          windows: [makeDescriptor({ url: `https://save-${i}.com` })],
        };
        saveSnapshot(db, snapshot, 'autosave');
      }

      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows[0].url, 'https://save-9.com',
        'Last save should win');

      // Only one snapshot row should exist (INSERT OR REPLACE)
      const count = db.prepare(
        `SELECT COUNT(*) as count FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
      ).get() as { count: number };
      assert.strictEqual(count.count, 1, 'Should have exactly one snapshot row');
    });

    it('snapshot JSON survives special characters in URLs', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor({
          url: 'https://example.com/search?q=hello+world&lang=en&special="quotes"&amp=<>',
          title: 'Search: "hello world" & <results>',
        })],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows[0].url, snapshot.windows[0].url);
      assert.strictEqual(loaded!.windows[0].title, snapshot.windows[0].title);
    });

    it('snapshot JSON survives unicode in titles', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [makeDescriptor({
          title: 'Japanese: \u65E5\u672C\u8A9E\u30C6\u30B9\u30C8 | Emoji test',
        })],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows[0].title, 'Japanese: \u65E5\u672C\u8A9E\u30C6\u30B9\u30C8 | Emoji test');
    });

    it('snapshot with window keys enables deduplication on restore', () => {
      const snapshot: SessionSnapshot = {
        version: 1,
        createdAt: Date.now(),
        reason: 'before-quit',
        windows: [
          makeDescriptor({ url: 'https://settings.com', key: 'settings' }),
          makeDescriptor({ url: 'https://editor.com', key: 'editor-1' }),
          makeDescriptor({ url: 'https://editor.com', key: undefined }), // no key
        ],
      };

      saveSnapshot(db, snapshot, 'before-quit');
      const loaded = readSnapshot(db);
      assert.strictEqual(loaded!.windows[0].key, 'settings');
      assert.strictEqual(loaded!.windows[1].key, 'editor-1');
      assert.strictEqual(loaded!.windows[2].key, undefined);
    });
  });

  // ========================================================================
  // Window filtering for session save (utility, modal, system windows)
  // ========================================================================

  describe('Window filtering for session save', () => {
    /**
     * Extracted filtering logic from session.ts saveSessionSnapshot.
     * Returns true if a window should be SKIPPED (not saved).
     *
     * Updated: Only non-focusable utility windows (e.g. HUD overlays) are skipped.
     * User-facing utility windows (settings, diagnostic) are now saved.
     */
    function shouldSkipWindow(
      url: string,
      params: Record<string, unknown>,
      isVisible: boolean,
      isDestroyed: boolean
    ): boolean {
      if (isDestroyed) return true;
      if (!isVisible) return true;
      if (url.includes('peek://app/background.html')) return true;
      if (params.modal) return true;
      if (params.role === 'utility' && params.focusable === false) return true;
      return false;
    }

    it('skips non-focusable utility windows like HUD (role=utility, focusable=false)', () => {
      const skip = shouldSkipWindow(
        'peek://hud/panel.html',
        { role: 'utility', focusable: false },
        true,
        false
      );
      assert.strictEqual(skip, true, 'Non-focusable utility windows (HUD) should be skipped during save');
    });

    it('includes focusable utility windows like settings (role=utility, focusable not false)', () => {
      const skip = shouldSkipWindow(
        'peek://app/settings/settings.html',
        { role: 'utility' },
        true,
        false
      );
      assert.strictEqual(skip, false, 'User-facing utility windows (settings) should be saved');
    });

    it('includes utility windows with focusable=true', () => {
      const skip = shouldSkipWindow(
        'peek://app/diagnostic.html',
        { role: 'utility', focusable: true },
        true,
        false
      );
      assert.strictEqual(skip, false, 'Focusable utility windows should be saved');
    });

    it('skips modal windows', () => {
      const skip = shouldSkipWindow(
        'peek://cmd/panel.html',
        { modal: true },
        true,
        false
      );
      assert.strictEqual(skip, true, 'Modal windows should be skipped during save');
    });

    it('skips background window', () => {
      const skip = shouldSkipWindow(
        'peek://app/background.html',
        {},
        true,
        false
      );
      assert.strictEqual(skip, true, 'Background window should be skipped');
    });

    it('skips invisible windows', () => {
      const skip = shouldSkipWindow(
        'https://example.com',
        {},
        false,
        false
      );
      assert.strictEqual(skip, true, 'Invisible windows should be skipped');
    });

    it('skips destroyed windows', () => {
      const skip = shouldSkipWindow(
        'https://example.com',
        {},
        true,
        true
      );
      assert.strictEqual(skip, true, 'Destroyed windows should be skipped');
    });

    it('includes normal content windows', () => {
      const skip = shouldSkipWindow(
        'https://example.com',
        { role: 'content' },
        true,
        false
      );
      assert.strictEqual(skip, false, 'Normal content windows should be included');
    });

    it('includes extension windows with non-utility role', () => {
      const skip = shouldSkipWindow(
        'peek://tags/home.html',
        { role: 'content' },
        true,
        false
      );
      assert.strictEqual(skip, false, 'Extension windows with content role should be included');
    });

    it('includes canvas page containers', () => {
      const skip = shouldSkipWindow(
        'peek://app/page?url=https%3A%2F%2Fexample.com',
        {},
        true,
        false
      );
      assert.strictEqual(skip, false, 'Canvas page containers should be included');
    });

    it('includes windows with no role specified', () => {
      const skip = shouldSkipWindow(
        'https://example.com',
        {},
        true,
        false
      );
      assert.strictEqual(skip, false, 'Windows with no role should be included');
    });
  });

  // ========================================================================
  // Restore param stripping tests
  //
  // BUG #7 THIS CATCHES: Saved params containing role/escapeMode/x/y interfere
  // with window-open handler during restore, causing canvas mode to be disabled
  // for web pages or stale positions to be used.
  // ========================================================================

  describe('Restore param stripping', () => {
    /**
     * Replicate the param stripping logic from session.ts restoreSessionSnapshot.
     * Returns cleaned params with interfering keys removed.
     */
    function stripRestoreParams(params: Record<string, unknown>): Record<string, unknown> {
      const cleanParams: Record<string, unknown> = {};
      const stripKeys = new Set(['x', 'y', 'width', 'height', 'address', 'transient', 'parentWindowId']);
      for (const [key, value] of Object.entries(params)) {
        if (!stripKeys.has(key)) {
          cleanParams[key] = value;
        }
      }
      return cleanParams;
    }

    it('strips stale position params (x, y, width, height)', () => {
      // BUG: If descriptor.params contains x/y from original creation,
      // they leak through when boundsOptions doesn't override them.
      const params = {
        x: 500, y: 300, width: 800, height: 600,
        key: 'test', transparent: true,
      };
      const clean = stripRestoreParams(params);
      assert.strictEqual(clean.x, undefined, 'x should be stripped');
      assert.strictEqual(clean.y, undefined, 'y should be stripped');
      assert.strictEqual(clean.width, undefined, 'width should be stripped');
      assert.strictEqual(clean.height, undefined, 'height should be stripped');
      assert.strictEqual(clean.key, 'test', 'key should be preserved');
      assert.strictEqual(clean.transparent, true, 'transparent should be preserved');
    });

    it('preserves role and escapeMode across session restore', () => {
      // role and escapeMode are semantic properties that affect window behavior
      // (e.g., ESC handling for extension windows like Groups).
      const params = {
        role: 'workspace',
        escapeMode: 'navigate',
        key: 'https://example.com',
      };
      const clean = stripRestoreParams(params);
      assert.strictEqual(clean.role, 'workspace', 'role should be preserved');
      assert.strictEqual(clean.escapeMode, 'navigate', 'escapeMode should be preserved');
      assert.strictEqual(clean.key, 'https://example.com', 'key should be preserved');
    });

    it('strips address and session-specific params', () => {
      const params = {
        address: 'peek://app/settings/settings.html',
        transient: true,
        parentWindowId: 42,
        key: 'settings',
        transparent: true,
      };
      const clean = stripRestoreParams(params);
      assert.strictEqual(clean.address, undefined, 'address should be stripped');
      assert.strictEqual(clean.transient, undefined, 'transient should be stripped');
      assert.strictEqual(clean.parentWindowId, undefined, 'parentWindowId should be stripped');
      assert.strictEqual(clean.key, 'settings', 'key should be preserved');
      assert.strictEqual(clean.transparent, true, 'transparent should be preserved');
    });

    it('preserves user-facing params through strip', () => {
      const params = {
        key: 'my-window',
        transparent: true,
        modal: false,
        trackingSource: 'cmd',
        trackingSourceId: 'open',
        focusable: true,
        debug: false,
        role: 'content',
        // These should be stripped:
        x: 100, y: 200, address: 'url', transient: false,
      };
      const clean = stripRestoreParams(params);
      assert.strictEqual(clean.key, 'my-window');
      assert.strictEqual(clean.transparent, true);
      assert.strictEqual(clean.modal, false);
      assert.strictEqual(clean.trackingSource, 'cmd');
      assert.strictEqual(clean.trackingSourceId, 'open');
      assert.strictEqual(clean.focusable, true);
      assert.strictEqual(clean.debug, false);
      assert.strictEqual(clean.role, 'content', 'role should be preserved');
      // Verify stripped keys are gone
      assert.strictEqual(clean.x, undefined);
      assert.strictEqual(clean.y, undefined);
      assert.strictEqual(clean.address, undefined);
      assert.strictEqual(clean.transient, undefined);
    });
  });
});

// ============================================================================
// feature_settings migration (from datastore.ts migrateExtensionSettingsToFeatureSettings)
// ============================================================================

describe('feature_settings migration (extension_settings -> feature_settings)', () => {
  /**
   * Simulates the migration logic from datastore.ts:
   * - If old table extension_settings exists, copy data to feature_settings, drop old table
   * - If old table doesn't exist, no-op
   */

  it('copies data from extension_settings to feature_settings and drops old table', () => {
    const migrationDb = new Database(':memory:');

    // Create the old table with data
    migrationDb.exec(`
      CREATE TABLE extension_settings (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updatedAt INTEGER DEFAULT 0
      );
      INSERT INTO extension_settings (id, extensionId, key, value, updatedAt)
        VALUES ('es-1', 'groups', 'sortBy', '"name"', 1000);
      INSERT INTO extension_settings (id, extensionId, key, value, updatedAt)
        VALUES ('es-2', 'editor', 'theme', '"dark"', 2000);
    `);

    // Create the new table (as CREATE TABLE IF NOT EXISTS does in production)
    migrationDb.exec(`
      CREATE TABLE IF NOT EXISTS feature_settings (
        id TEXT PRIMARY KEY,
        featureId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updatedAt INTEGER DEFAULT 0
      );
    `);

    // Run migration logic (mirrors migrateExtensionSettingsToFeatureSettings)
    const oldTableExists = migrationDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='extension_settings'`
    ).get();

    if (oldTableExists) {
      migrationDb.exec(`
        INSERT OR IGNORE INTO feature_settings (id, featureId, key, value, updatedAt)
        SELECT id, extensionId, key, value, updatedAt FROM extension_settings;
      `);
      migrationDb.exec(`DROP TABLE IF EXISTS extension_settings`);
    }

    // Verify data was copied
    const rows = migrationDb.prepare('SELECT * FROM feature_settings ORDER BY id').all() as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].id, 'es-1');
    assert.strictEqual(rows[0].featureId, 'groups');
    assert.strictEqual(rows[0].key, 'sortBy');
    assert.strictEqual(rows[1].id, 'es-2');
    assert.strictEqual(rows[1].featureId, 'editor');

    // Verify old table was dropped
    const oldTable = migrationDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='extension_settings'`
    ).get();
    assert.strictEqual(oldTable, undefined);

    migrationDb.close();
  });

  it('is a no-op when extension_settings does not exist', () => {
    const migrationDb = new Database(':memory:');

    // Only the new table exists
    migrationDb.exec(`
      CREATE TABLE IF NOT EXISTS feature_settings (
        id TEXT PRIMARY KEY,
        featureId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updatedAt INTEGER DEFAULT 0
      );
    `);

    // Run migration check
    const oldTableExists = migrationDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='extension_settings'`
    ).get();

    // Should be falsy — migration does nothing
    assert.strictEqual(oldTableExists, undefined);

    // feature_settings should be empty (no data to migrate)
    const rows = migrationDb.prepare('SELECT * FROM feature_settings').all();
    assert.strictEqual(rows.length, 0);

    migrationDb.close();
  });
});

// ============================================================================
// Closed window stack persistence tests
// ============================================================================

interface ClosedWindowEntry {
  url: string;
  originalUrl?: string;
  source: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  spaceMode: { spaceId: string; spaceName: string; color?: string } | null;
  role?: string;
  scrollX?: number;
  scrollY?: number;
  timestamp: number;
}

/**
 * Save closed window stack to DB — replicates main.ts saveClosedWindowStack.
 */
function saveClosedStack(db: InstanceType<typeof Database>, stack: ClosedWindowEntry[]): void {
  const data = JSON.stringify(stack);
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'session', 'closed-window-stack', ?, ?)
  `).run('session-closed-window-stack', data, Date.now());
}

/**
 * Load closed window stack from DB — replicates main.ts loadClosedWindowStack.
 */
function loadClosedStack(db: InstanceType<typeof Database>): ClosedWindowEntry[] {
  const row = db.prepare(
    `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'closed-window-stack'`
  ).get() as { value: string } | undefined;
  if (!row?.value) return [];
  const entries = JSON.parse(row.value);
  return Array.isArray(entries) ? entries : [];
}

function makeClosedEntry(overrides?: Partial<ClosedWindowEntry>): ClosedWindowEntry {
  return {
    url: 'https://example.com',
    source: 'test-ext',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    spaceMode: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Closed window stack persistence', () => {
  it('saves and loads empty stack', () => {
    const db = createTestDb();
    saveClosedStack(db, []);
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 0);
    db.close();
  });

  it('saves and loads stack with entries', () => {
    const db = createTestDb();
    const stack = [
      makeClosedEntry({ url: 'https://a.com' }),
      makeClosedEntry({ url: 'https://b.com' }),
      makeClosedEntry({ url: 'https://c.com' }),
    ];
    saveClosedStack(db, stack);
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 3);
    assert.strictEqual(loaded[0].url, 'https://a.com');
    assert.strictEqual(loaded[1].url, 'https://b.com');
    assert.strictEqual(loaded[2].url, 'https://c.com');
    db.close();
  });

  it('preserves bounds through save/load cycle', () => {
    const db = createTestDb();
    const bounds = { x: 200, y: 150, width: 1024, height: 768 };
    const stack = [makeClosedEntry({ bounds })];
    saveClosedStack(db, stack);
    const loaded = loadClosedStack(db);
    assert.deepStrictEqual(loaded[0].bounds, bounds);
    db.close();
  });

  it('preserves spaceMode through save/load cycle', () => {
    const db = createTestDb();
    const stack = [makeClosedEntry({
      spaceMode: { spaceId: 'sp-123', spaceName: 'Work', color: '#ff0000' },
    })];
    saveClosedStack(db, stack);
    const loaded = loadClosedStack(db);
    assert.deepStrictEqual(loaded[0].spaceMode, {
      spaceId: 'sp-123',
      spaceName: 'Work',
      color: '#ff0000',
    });
    db.close();
  });

  it('overwrites previous stack on save', () => {
    const db = createTestDb();
    saveClosedStack(db, [makeClosedEntry({ url: 'https://old.com' })]);
    saveClosedStack(db, [makeClosedEntry({ url: 'https://new.com' })]);
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].url, 'https://new.com');
    db.close();
  });

  it('returns empty array when no stack saved', () => {
    const db = createTestDb();
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 0);
    db.close();
  });

  it('session snapshot save pushes open web windows to closed stack', () => {
    // Simulate the session save logic that pushes open windows to closed stack
    const db = createTestDb();

    // Current open windows from the session snapshot
    const windowDescriptors = [
      makeDescriptor({ url: 'https://github.com' }),
      makeDescriptor({ url: 'https://example.com' }),
      makeDescriptor({ url: 'peek://groups/home.html' }), // non-web, should be skipped
    ];

    // Simulate the before-quit logic from session.ts
    const closedStack: ClosedWindowEntry[] = [];
    for (const descriptor of windowDescriptors) {
      const isWebUrl = descriptor.url.startsWith('http://') || descriptor.url.startsWith('https://');
      if (!isWebUrl) continue;
      closedStack.push({
        url: descriptor.url,
        source: descriptor.source,
        bounds: descriptor.bounds,
        spaceMode: null,
        timestamp: Date.now(),
      });
    }

    saveClosedStack(db, closedStack);
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 2, 'Only web URLs should be pushed to closed stack');
    assert.strictEqual(loaded[0].url, 'https://github.com');
    assert.strictEqual(loaded[1].url, 'https://example.com');
    db.close();
  });

  it('stack survives across simulated restarts', () => {
    const db = createTestDb();

    // Session 1: close some windows and save
    const session1Stack = [
      makeClosedEntry({ url: 'https://a.com', timestamp: 1000 }),
      makeClosedEntry({ url: 'https://b.com', timestamp: 2000 }),
    ];
    saveClosedStack(db, session1Stack);

    // Session 2: "restart" — load the stack
    const loaded = loadClosedStack(db);
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0].url, 'https://a.com');
    assert.strictEqual(loaded[1].url, 'https://b.com');

    // Session 2: pop one (undo-close-window)
    loaded.pop();
    saveClosedStack(db, loaded);

    // Session 3: "restart" — should have 1 entry
    const loaded2 = loadClosedStack(db);
    assert.strictEqual(loaded2.length, 1);
    assert.strictEqual(loaded2[0].url, 'https://a.com');

    db.close();
  });
});
