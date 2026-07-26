/**
 * Unit tests for the pure session-save projection (`session-projection.ts`).
 *
 * The load-bearing test here is `legacySerialize` — a VERBATIM transcription of
 * the pre-extraction `saveSessionSnapshot` loop (plus the two
 * `window-presenter.ts` rules the loop leaned on), wired to the same fixtures
 * `serializeSession` gets. Every fixture world is asserted with
 * `JSON.stringify` on BOTH sides, not `deepStrictEqual`: what lands in the
 * `feature_settings` row is the JSON TEXT, so comparing the text is the only
 * comparison that actually pins the on-disk shape. It catches renamed fields,
 * reordered keys, a `null` where a key used to be absent (JSON.stringify DROPS
 * an `undefined` value but keeps an explicit `null`), and int-vs-float drift —
 * the failure modes that silently wipe a user's saved session.
 *
 * The oracle is deliberately dumb and duplicated. It is not shared code and
 * must never be "simplified" to call the implementation.
 *
 * DELIBERATE SHAPE CHANGE (§5 step 11 task 5): a maximized descriptor's
 * pre-maximize rect used to be four flat numbers in `params`
 * (`preMaxX`/`preMaxY`/`preMaxWidth`/`preMaxHeight`); it is now one nested
 * `params.preMaxBounds` rect, named as `WindowRecord.preMaxBounds` is. The
 * oracle was updated to emit the new shape WITH the change — it pins the shape
 * the save path is supposed to write, and that shape moved on purpose. The old
 * shape is still READ (`readPreMaxBounds`, tested below), so a snapshot written
 * before the change still restores; save rewrites the whole snapshot row on
 * every autosave, so one save cycle converts a profile.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  serializeSession,
  restorableBoundsFromRecord,
  readPreMaxBounds,
  sanitizeParams,
  mirrorPlacementIntent,
  type SerializeSessionInput,
  type SessionSaveWindow,
  type SessionSavePresentation,
} from './session-projection.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import type { FsMode, Rectangle, StateSnapshot, WindowId, WindowRecord } from './window-state.js';

// ============================================================================
// Fixtures
// ============================================================================

const wid = (s: string) => s as WindowId;

function makeRecord(id: string, over: Partial<WindowRecord> = {}): WindowRecord {
  return {
    id: wid(id),
    kind: 'browser',
    role: 'content',
    class: 'primary',
    satellite: false,
    visible: true,
    stackingLevel: 'stacked',
    orderable: true,
    fsMode: { name: 'normal' },
    maximized: false,
    preMaxBounds: null,
    visibleOnAllSpaces: false,
    pendingProjectedBounds: null,
    focusSeq: 0,
    ...over,
  };
}

function makeStateSnapshot(windows: WindowRecord[], front: WindowId | null = null): StateSnapshot {
  return {
    appActive: true,
    session: 'idle',
    front,
    stackOrder: windows.map((w) => w.id),
    switcher: { open: false },
    windows,
  };
}

/**
 * One fixture window: the registry payload + the live facts the boundary
 * gathers + the presenter's non-geometry answers. Both the oracle and the real
 * projection are driven from these, so neither can be fed a different world.
 */
interface Fixture {
  nativeId: number;
  machineId: string | null;
  source: string;
  params: Record<string, unknown>;
  destroyed?: boolean;
  /** The raw early-skip URL (webContents.getURL() / hybrid url()). */
  rawUrl: string;
  /** presentation.address — absent means getWindowPresentation returned null. */
  address?: string;
  title?: string;
  /** The presenter's live-read fallback rect (win.getBounds()). */
  liveBounds?: Rectangle;
  context?: WindowContext;
}

interface World {
  fixtures: Fixture[];
  records: WindowRecord[];
  front?: string | null;
  /** What `getNativeWindowFor(front)?.id` answered — the oracle's `lastFocusedId`. */
  frontNativeId?: number | null;
  registeredTileIds?: string[];
  reason?: 'before-quit' | 'autosave' | 'manual' | 'window-close' | 'window-lifecycle';
  forceForTest?: boolean;
}

const CREATED_AT = 1_700_000_000_000;

function recordsOf(world: World): Map<string, WindowRecord> {
  return new Map(world.records.map((r) => [String(r.id), r]));
}

/**
 * The pre-change `window-presenter.ts` presentation, transcribed: geometry from
 * the restorable-geometry rule with the live read as the fallback, maximize +
 * preMaxBounds straight off the record.
 */
function presentationFor(world: World, f: Fixture): (SessionSavePresentation & {
  maximized: boolean;
  preMaxBounds: Rectangle | null;
}) | null {
  if (f.address === undefined) return null;
  const rec = f.machineId != null ? recordsOf(world).get(f.machineId) : undefined;
  // pre-change getRestorableBounds(machineId): getWindowPreBounds() first
  // (null for a `normal` fsMode), then the record's bounds mirror.
  const pre: Rectangle | null | undefined =
    rec == null ? null : rec.fsMode.name === 'normal' ? null : rec.fsMode.preBounds;
  const restorable: Rectangle | null = pre ? pre : (rec?.bounds ?? null);
  const maximized = rec?.maximized === true;
  return {
    address: f.address,
    title: f.title ?? '',
    bounds: restorable ?? (f.liveBounds ?? { x: 0, y: 0, width: 0, height: 0 }),
    maximized,
    preMaxBounds: maximized ? (rec?.preMaxBounds ?? null) : null,
  };
}

// ============================================================================
// The oracle: the pre-extraction saveSessionSnapshot loop, verbatim
// ============================================================================

function legacySerialize(world: World): { snapshot: unknown; windowCount: number } {
  const reason = world.reason ?? 'before-quit';
  const records = recordsOf(world);

  // (The loop used to gather `params.overlayHiddenWindows` here into an
  // exempt-set for the visibility skip. That side channel was retired — see
  // `session-save-filter.ts` for why the exemption has nothing left to exempt
  // — so the oracle drops it too, deliberately, rather than pinning a rule the
  // shipped code no longer has.)
  const lastFocusedId = world.frontNativeId ?? null;
  const windowDescriptors: WindowDescriptor[] = [];

  for (const f of world.fixtures) {
    const id = f.nativeId;
    const rec = f.machineId != null ? records.get(f.machineId) : undefined;
    const destroyed = f.destroyed === true;
    const visible = destroyed ? false : (rec ? rec.visible : true);
    const url = destroyed ? '' : f.rawUrl;

    // shouldSkipWindowForSaveEarly, inlined (session-save-filter.ts)
    if (destroyed) continue;
    if (!visible && !world.forceForTest) continue;
    if (url.includes('peek://app/background.html')) continue;

    if (f.params.modal) continue;
    if (f.params.role === 'utility' && f.params.focusable === false) continue;
    if (f.params.role === 'overlay' || f.params.overlay === true) continue;

    const presentation = presentationFor(world, f);
    if (!presentation) continue;
    const realUrl = presentation.address;
    const windowBounds = presentation.bounds;
    const canvasMaximized = presentation.maximized;

    const extMatch = realUrl.match(/^peek:\/\/ext\/([^/]+)/);
    if (extMatch) {
      const extId = extMatch[1];
      const knownIds = world.registeredTileIds ?? [];
      if (!knownIds.includes(extId)) continue;
    }

    const windowContext: WindowContext | undefined = f.context;

    const sanitized = legacySanitizeParams(legacyMirrorPlacementIntent(f.params));
    if (canvasMaximized) {
      sanitized.maximized = true;
      if (presentation.preMaxBounds) {
        sanitized.preMaxBounds = {
          x: presentation.preMaxBounds.x,
          y: presentation.preMaxBounds.y,
          width: presentation.preMaxBounds.width,
          height: presentation.preMaxBounds.height,
        };
      } else {
        delete sanitized.preMaxBounds;
      }
    } else {
      delete sanitized.maximized;
      delete sanitized.preMaxBounds;
    }
    delete sanitized.preMaxX;
    delete sanitized.preMaxY;
    delete sanitized.preMaxWidth;
    delete sanitized.preMaxHeight;

    windowDescriptors.push({
      url: realUrl,
      key: (f.params.key as string) || undefined,
      title: presentation.title,
      bounds: windowBounds,
      source: f.source,
      params: sanitized,
      zOrder: f.machineId != null ? (records.get(f.machineId)?.focusSeq ?? 0) : 0,
      focused: lastFocusedId != null && id === lastFocusedId,
      context: windowContext,
    });
  }

  const preFilterCount = windowDescriptors.length;
  const filteredDescriptors = windowDescriptors.filter((d) => {
    const url = d.url;
    if (!url || url.trim() === '' || url === 'about:blank' || url === 'about:newtab') return false;
    return true;
  });

  return {
    snapshot: {
      version: 1,
      createdAt: CREATED_AT,
      reason,
      windows: filteredDescriptors,
    },
    windowCount: preFilterCount,
  };
}

/** session.ts sanitizeParams, pre-extraction. */
function legacySanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'openDevTools' || key === 'detachedDevTools') continue;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        safe[key] = value;
      }
    }
  }
  return safe;
}

/** session.ts mirrorPlacementIntent, pre-extraction. */
function legacyMirrorPlacementIntent(params: Record<string, unknown>): Record<string, unknown> {
  const placement = params.placement as
    | { mode?: string; edge?: string; relX?: number; relY?: number }
    | undefined;
  const out: Record<string, unknown> = { ...params };
  if (!placement?.mode) return out;
  switch (placement.mode) {
    case 'centered':
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'parent-centered':
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'edge':
      if (typeof placement.edge === 'string') {
        out.placementMode = 'edge';
        out.placementEdge = placement.edge;
        out.screenEdge = placement.edge;
      }
      break;
    case 'proportional':
      out.placementMode = 'proportional';
      if (typeof placement.relX === 'number') out.placementRelX = placement.relX;
      if (typeof placement.relY === 'number') out.placementRelY = placement.relY;
      break;
  }
  return out;
}

// ============================================================================
// Driving the real implementation from the same world
// ============================================================================

function inputFor(world: World): SerializeSessionInput {
  const windows: SessionSaveWindow[] = world.fixtures.map((f) => ({
    nativeId: f.nativeId,
    machineId: f.machineId == null ? null : wid(f.machineId),
    source: f.source,
    params: f.params,
    destroyed: f.destroyed === true,
    url: f.destroyed === true ? '' : f.rawUrl,
  }));
  return {
    snapshot: makeStateSnapshot(world.records, world.front == null ? null : wid(world.front)),
    windows,
    getPresentation: (nativeId) => {
      const f = world.fixtures.find((x) => x.nativeId === nativeId);
      return f ? presentationFor(world, f) : null;
    },
    getContext: (nativeId) => world.fixtures.find((x) => x.nativeId === nativeId)?.context,
    registeredTileIds: world.registeredTileIds ?? [],
    reason: world.reason ?? 'before-quit',
    createdAt: CREATED_AT,
    forceForTest: world.forceForTest,
  };
}

function assertSameOnDiskShape(world: World, label: string): void {
  const legacy = legacySerialize(world);
  const projected = serializeSession(inputFor(world));
  assert.strictEqual(
    JSON.stringify(projected.snapshot),
    JSON.stringify(legacy.snapshot),
    `${label}: on-disk JSON diverged from the pre-extraction save path`,
  );
  assert.strictEqual(
    projected.windowCount,
    legacy.windowCount,
    `${label}: metadata windowCount diverged`,
  );
}

// ============================================================================
// Worlds
// ============================================================================

const CONTENT_PARAMS = { role: 'content', key: 'k1', address: 'https://example.com/' };

function contentFixture(nativeId: number, machineId: string, over: Partial<Fixture> = {}): Fixture {
  return {
    nativeId,
    machineId,
    source: 'peek://app/background.html',
    params: { ...CONTENT_PARAMS },
    rawUrl: 'https://example.com/',
    address: 'https://example.com/',
    title: `W${nativeId}`,
    liveBounds: { x: 1, y: 2, width: 3, height: 4 },
    ...over,
  };
}

const FULLSCREEN_MODE: FsMode = { name: 'fullscreen', preBounds: { x: 10, y: 20, width: 300, height: 400 } };

describe('session-projection — on-disk shape is byte-identical to the pre-extraction save path', () => {
  const worlds: Array<[string, World]> = [
    ['empty state', { fixtures: [], records: [] }],

    ['single plain content window', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', { bounds: { x: 5, y: 6, width: 700, height: 800 }, focusSeq: 42 })],
      front: 'w1',
      frontNativeId: 1,
    }],

    ['fullscreen window persists its pre-fullscreen rect', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        fsMode: FULLSCREEN_MODE,
        focusSeq: 7,
      })],
      front: 'w1',
      frontNativeId: 1,
    }],

    ['maximized window carries the nested preMax rect', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1512, height: 900 },
        maximized: true,
        preMaxBounds: { x: 100, y: 110, width: 640, height: 480 },
      })],
    }],

    // A window restored from a PRE-COLLAPSE snapshot still carries that
    // snapshot's flat bag in its params. Re-saving it must emit the nested
    // rect only — the flat keys do not ride forward, or a profile would never
    // finish converting.
    ['a pre-collapse flat bag in params is replaced by the nested rect', {
      fixtures: [contentFixture(1, 'w1', {
        params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 },
      })],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1512, height: 900 },
        maximized: true,
        preMaxBounds: { x: 100, y: 110, width: 640, height: 480 },
      })],
    }],

    ['maximized with no preMax stash', {
      fixtures: [contentFixture(1, 'w1', { params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 9 } })],
      records: [makeRecord('w1', { bounds: { x: 1, y: 1, width: 2, height: 2 }, maximized: true, preMaxBounds: null })],
    }],

    ['stale params.maximized on a NON-maximized record is stripped', {
      fixtures: [contentFixture(1, 'w1', {
        params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 },
      })],
      records: [makeRecord('w1', { bounds: { x: 1, y: 1, width: 2, height: 2 } })],
    }],

    ['every skip rule at once', {
      fixtures: [
        contentFixture(1, 'w1'),
        contentFixture(2, 'w2', { destroyed: true }),
        contentFixture(3, 'w3'), // invisible via its record
        contentFixture(4, 'w4', { rawUrl: 'peek://app/background.html', address: 'peek://app/background.html' }),
        contentFixture(5, 'w5', { params: { modal: true } }),
        contentFixture(6, 'w6', { params: { role: 'utility', focusable: false } }),
        contentFixture(7, 'w7', { params: { role: 'utility' } }),          // kept
        contentFixture(8, 'w8', { params: { role: 'overlay' } }),
        contentFixture(9, 'w9', { params: { overlay: true } }),
        contentFixture(10, 'w10', { address: undefined }),                  // no presentation
        contentFixture(11, 'w11', { address: 'peek://ext/gone/home.html' }), // stale tile
        contentFixture(12, 'w12', { address: 'peek://ext/known/home.html' }), // kept
        contentFixture(13, null as unknown as string, { machineId: null }),   // machine-unknown
      ],
      records: [
        makeRecord('w1', { bounds: { x: 1, y: 1, width: 10, height: 10 }, focusSeq: 5 }),
        makeRecord('w2'),
        makeRecord('w3', { visible: false }),
        makeRecord('w4'),
        makeRecord('w5'),
        makeRecord('w6'),
        makeRecord('w7', { bounds: { x: 7, y: 7, width: 70, height: 70 } }),
        makeRecord('w8'),
        makeRecord('w9'),
        makeRecord('w10'),
        makeRecord('w11', { bounds: { x: 11, y: 11, width: 110, height: 110 } }),
        makeRecord('w12', { bounds: { x: 12, y: 12, width: 120, height: 120 } }),
      ],
      registeredTileIds: ['known'],
      front: 'w7',
      frontNativeId: 7,
    }],

    // The switcher is open, and a stale `overlayHiddenWindows` key rides along
    // on its params (an old profile, or a caller copying the retired
    // convention). It buys nothing: window 1 is invisible per its record and is
    // skipped, window 2 is the overlay itself and is skipped, window 3 is
    // visible and is saved. Pins that the side channel is inert on BOTH sides.
    ['a stale overlayHiddenWindows key does not exempt an invisible window', {
      fixtures: [
        contentFixture(1, 'w1'),
        {
          nativeId: 2,
          machineId: 'w2',
          source: 'peek://app/background.html',
          params: { role: 'overlay', overlayHiddenWindows: [1] },
          rawUrl: 'peek://windows/windows.html',
          address: 'peek://windows/windows.html',
          title: 'switcher',
        },
        contentFixture(3, 'w3'),
      ],
      records: [
        makeRecord('w1', { visible: false, bounds: { x: 3, y: 3, width: 30, height: 30 } }),
        makeRecord('w2', { class: 'overlay', satellite: true }),
        makeRecord('w3', { bounds: { x: 5, y: 5, width: 50, height: 50 }, focusSeq: 2 }),
      ],
    }],

    ['_forceForTest bypasses the visibility skip', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', { visible: false, bounds: { x: 4, y: 4, width: 40, height: 40 } })],
      forceForTest: true,
    }],

    ['empty / about:blank URLs are dropped but still counted', {
      fixtures: [
        contentFixture(1, 'w1', { address: '' }),
        contentFixture(2, 'w2', { address: 'about:blank' }),
        contentFixture(3, 'w3', { address: 'about:newtab' }),
        contentFixture(4, 'w4', { address: '   ' }),
        contentFixture(5, 'w5'),
      ],
      records: ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => makeRecord(id, { bounds: { x: 1, y: 1, width: 2, height: 2 } })),
    }],

    ['placement intent mirroring + param sanitization', {
      fixtures: [
        contentFixture(1, 'w1', {
          params: {
            role: 'content',
            key: 'kk',
            placement: { mode: 'proportional', relX: 0.25, relY: 0.75 },
            openDevTools: true,
            detachedDevTools: false,
            arr: ['a', 1, true, null],
            badArr: [{ nope: 1 }],
            obj: { nope: 1 },
            fn: () => 1,
            nullish: null,
            num: 3.5,
          },
        }),
        contentFixture(2, 'w2', { params: { placement: { mode: 'edge', edge: 'left' } } }),
        contentFixture(3, 'w3', { params: { placement: { mode: 'parent-centered' } } }),
        contentFixture(4, 'w4', { params: { placement: { mode: 'centered' } } }),
      ],
      records: ['w1', 'w2', 'w3', 'w4'].map((id) => makeRecord(id, { bounds: { x: 1, y: 1, width: 2, height: 2 } })),
    }],

    ['context rows ride along; absent context stays an ABSENT key', {
      fixtures: [
        contentFixture(1, 'w1', { context: { mode: 'space', modeMetadata: { spaceId: 's1', spaceName: 'S' } } }),
        contentFixture(2, 'w2', { context: { mode: 'space', modeMetadata: null } }),
        contentFixture(3, 'w3'),
      ],
      records: ['w1', 'w2', 'w3'].map((id) => makeRecord(id, { bounds: { x: 1, y: 1, width: 2, height: 2 } })),
    }],

    ['machine-unknown window falls back to the live rect and rank 0', {
      fixtures: [contentFixture(1, 'w1', { machineId: null, liveBounds: { x: 9, y: 9, width: 90, height: 90 } })],
      records: [],
    }],

    ['reason + no focused window', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', { bounds: { x: 1, y: 1, width: 2, height: 2 } })],
      reason: 'autosave',
      front: null,
      frontNativeId: null,
    }],
  ];

  for (const [label, world] of worlds) {
    it(label, () => assertSameOnDiskShape(world, label));
  }
});

describe('session-projection — skip rules', () => {
  function urlsOf(world: World): string[] {
    return serializeSession(inputFor(world)).snapshot.windows.map((w) => w.url);
  }

  it('skips destroyed, invisible, background, modal, non-focusable utility and overlay windows', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { address: 'https://kept.example/' }),
        contentFixture(2, 'w2', { destroyed: true, address: 'https://destroyed.example/' }),
        contentFixture(3, 'w3', { address: 'https://invisible.example/' }),
        contentFixture(4, 'w4', { rawUrl: 'peek://app/background.html', address: 'peek://app/background.html' }),
        contentFixture(5, 'w5', { params: { modal: true }, address: 'https://modal.example/' }),
        contentFixture(6, 'w6', { params: { role: 'utility', focusable: false }, address: 'https://hud.example/' }),
        contentFixture(7, 'w7', { params: { role: 'utility' }, address: 'https://settings.example/' }),
        contentFixture(8, 'w8', { params: { role: 'overlay' }, address: 'https://overlay.example/' }),
        contentFixture(9, 'w9', { params: { overlay: true }, address: 'https://flagged.example/' }),
      ],
      records: [
        makeRecord('w1'), makeRecord('w2'), makeRecord('w3', { visible: false }), makeRecord('w4'),
        makeRecord('w5'), makeRecord('w6'), makeRecord('w7'), makeRecord('w8'), makeRecord('w9'),
      ],
    };
    assert.deepStrictEqual(urlsOf(world), ['https://kept.example/', 'https://settings.example/']);
  });

  it('visibility comes from the machine record, and a record-less window defaults to visible', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { address: 'https://hidden.example/' }),
        contentFixture(2, null as unknown as string, { machineId: null, address: 'https://norecord.example/' }),
      ],
      records: [makeRecord('w1', { visible: false })],
    };
    assert.deepStrictEqual(urlsOf(world), ['https://norecord.example/']);
  });

  it('a stale peek://ext/<id> window is skipped, a registered one is kept', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { address: 'peek://ext/gone/home.html' }),
        contentFixture(2, 'w2', { address: 'peek://ext/known/home.html' }),
      ],
      records: [makeRecord('w1'), makeRecord('w2')],
      registeredTileIds: ['known'],
    };
    assert.deepStrictEqual(urlsOf(world), ['peek://ext/known/home.html']);
  });

  it('the retired overlayHiddenWindows side channel no longer defeats the visibility skip', () => {
    // Visibility is a machine-record question and nothing else. The switcher
    // stopped hiding other windows in 9904f113, so the exemption that used to
    // read this params key was retired (§5 step 11 task 6) — a leftover key
    // from an old profile must not resurrect it, and the still-visible sibling
    // must still be saved.
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { address: 'https://invisible.example/' }),
        {
          nativeId: 2, machineId: 'w2', source: 's',
          params: { role: 'overlay', overlayHiddenWindows: [1] },
          rawUrl: 'peek://windows/windows.html', address: 'peek://windows/windows.html', title: 'sw',
        },
        contentFixture(3, 'w3', { address: 'https://visible.example/' }),
      ],
      records: [makeRecord('w1', { visible: false }), makeRecord('w2'), makeRecord('w3')],
    };
    assert.deepStrictEqual(urlsOf(world), ['https://visible.example/']);
  });
});

describe('session-projection — machine-derived descriptor fields', () => {
  it('a fullscreen window persists fsMode.preBounds, NOT the fullscreen rect', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { liveBounds: { x: 0, y: 0, width: 1, height: 1 } })],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        fsMode: { name: 'fullscreen', preBounds: { x: 10, y: 20, width: 300, height: 400 } },
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(d.bounds, { x: 10, y: 20, width: 300, height: 400 });
  });

  it('mid-transition fullscreen (entering/leaving) also persists the stash', () => {
    for (const name of ['entering-fullscreen', 'leaving-fullscreen'] as const) {
      const world: World = {
        fixtures: [contentFixture(1, 'w1')],
        records: [makeRecord('w1', {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          fsMode: { name, preBounds: { x: 1, y: 2, width: 3, height: 4 } },
        })],
      };
      const [d] = serializeSession(inputFor(world)).snapshot.windows;
      assert.deepStrictEqual(d.bounds, { x: 1, y: 2, width: 3, height: 4 }, name);
    }
  });

  it('a fullscreen record with NO stash falls back to the bounds mirror', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        fsMode: { name: 'fullscreen', preBounds: null },
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(d.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('zOrder is the record focusSeq and focused is the machine front', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, 'w2')],
      records: [makeRecord('w1', { focusSeq: 3 }), makeRecord('w2', { focusSeq: 9 })],
      front: 'w2',
      frontNativeId: 2,
    };
    const out = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(out.map((w) => [w.zOrder, w.focused]), [[3, false], [9, true]]);
  });

  it('maximize + the preMax rect come from the record, overriding stale params', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', {
        params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 },
      })],
      records: [makeRecord('w1', { bounds: { x: 0, y: 0, width: 9, height: 9 } })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual('maximized' in d.params, false);
    assert.strictEqual('preMaxBounds' in d.params, false);
    assert.strictEqual('preMaxX' in d.params, false);
  });

  it('a maximized record writes ONE nested preMaxBounds and no flat keys', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', {
        // A window restored from a pre-collapse snapshot: the flat bag is
        // still on its params and must not survive the re-save.
        params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 },
      })],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1512, height: 900 },
        maximized: true,
        preMaxBounds: { x: 100, y: 110, width: 640, height: 480 },
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual(d.params.maximized, true);
    assert.deepStrictEqual(d.params.preMaxBounds, { x: 100, y: 110, width: 640, height: 480 });
    for (const k of ['preMaxX', 'preMaxY', 'preMaxWidth', 'preMaxHeight']) {
      assert.strictEqual(k in d.params, false, `${k} must not ride forward`);
    }
  });

  it('maximized with no stash writes maximized alone — no preMaxBounds key at all', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { params: { ...CONTENT_PARAMS, preMaxX: 9 } })],
      records: [makeRecord('w1', {
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        maximized: true,
        preMaxBounds: null,
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual(d.params.maximized, true);
    assert.strictEqual('preMaxBounds' in d.params, false);
    assert.strictEqual('preMaxX' in d.params, false);
  });
});

/**
 * The READ half of the descriptor's maximize shape. The nested branch is the
 * shape `serializeSession` writes today; the flat branch exists only to absorb
 * snapshots written before the collapse and is meant to be deleted once those
 * have aged out — these cases pin it while it lives.
 */
describe('session-projection — readPreMaxBounds', () => {
  it('reads the nested rect a current snapshot carries', () => {
    assert.deepStrictEqual(
      readPreMaxBounds({ maximized: true, preMaxBounds: { x: 1, y: 2, width: 3, height: 4 } }),
      { x: 1, y: 2, width: 3, height: 4 },
    );
  });

  it('reads the flat bag a PRE-COLLAPSE snapshot carries', () => {
    assert.deepStrictEqual(
      readPreMaxBounds({ maximized: true, preMaxX: 100, preMaxY: 110, preMaxWidth: 640, preMaxHeight: 480 }),
      { x: 100, y: 110, width: 640, height: 480 },
    );
  });

  it('prefers the nested rect when a params bag somehow carries both', () => {
    assert.deepStrictEqual(
      readPreMaxBounds({
        preMaxBounds: { x: 1, y: 2, width: 3, height: 4 },
        preMaxX: 9, preMaxY: 9, preMaxWidth: 9, preMaxHeight: 9,
      }),
      { x: 1, y: 2, width: 3, height: 4 },
    );
  });

  it('returns a fresh object, not the caller\'s (the rect must not alias params)', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const out = readPreMaxBounds({ preMaxBounds: rect });
    assert.deepStrictEqual(out, rect);
    assert.notStrictEqual(out, rect);
  });

  it('returns null for "maximized with no stash" — no rect in either shape', () => {
    assert.strictEqual(readPreMaxBounds({ maximized: true }), null);
    assert.strictEqual(readPreMaxBounds({}), null);
  });

  it('returns null for an incomplete or wrong-typed rect in either shape', () => {
    assert.strictEqual(readPreMaxBounds({ preMaxBounds: { x: 1, y: 2, width: 3 } }), null);
    assert.strictEqual(readPreMaxBounds({ preMaxBounds: { x: 1, y: 2, width: 3, height: '4' } }), null);
    assert.strictEqual(readPreMaxBounds({ preMaxBounds: null }), null);
    assert.strictEqual(readPreMaxBounds({ preMaxBounds: 5 }), null);
    assert.strictEqual(readPreMaxBounds({ preMaxX: 9 }), null);
    assert.strictEqual(readPreMaxBounds({ preMaxX: 1, preMaxY: 2, preMaxWidth: 3 }), null);
  });

  it('falls through to the flat bag when the nested field is present but unusable', () => {
    assert.deepStrictEqual(
      readPreMaxBounds({ preMaxBounds: null, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 }),
      { x: 1, y: 2, width: 3, height: 4 },
    );
  });
});

describe('session-projection — empty state and the snapshot envelope', () => {
  it('projects an empty snapshot from an empty world', () => {
    const projection = serializeSession(inputFor({ fixtures: [], records: [] }));
    assert.deepStrictEqual(projection.snapshot, {
      version: 1,
      createdAt: CREATED_AT,
      reason: 'before-quit',
      windows: [],
    });
    assert.strictEqual(projection.windowCount, 0);
    assert.deepStrictEqual(projection.notices, []);
    assert.strictEqual(JSON.stringify(projection.snapshot), `{"version":1,"createdAt":${CREATED_AT},"reason":"before-quit","windows":[]}`);
  });

  it('projects an empty snapshot when every window is skipped', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { rawUrl: 'peek://app/background.html', address: 'peek://app/background.html' })],
      records: [makeRecord('w1')],
    };
    assert.deepStrictEqual(serializeSession(inputFor(world)).snapshot.windows, []);
  });

  it('windowCount is the PRE-guard count; snapshot.windows is post-guard', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { address: '' }), contentFixture(2, 'w2')],
      records: [makeRecord('w1'), makeRecord('w2')],
    };
    const projection = serializeSession(inputFor(world));
    assert.strictEqual(projection.windowCount, 2);
    assert.strictEqual(projection.snapshot.windows.length, 1);
  });

  it('emits the always-on per-window log line and the guard warnings', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { title: 'Kept', address: 'https://kept.example/' }),
        contentFixture(2, 'w2', { address: '' }),
        contentFixture(3, 'w3', { params: { role: 'overlay' } }),
      ],
      records: [
        makeRecord('w1', { bounds: { x: 5, y: 6, width: 70, height: 80 } }),
        makeRecord('w2'), makeRecord('w3'),
      ],
    };
    const notices = serializeSession(inputFor(world)).notices;
    assert.deepStrictEqual(notices, [
      { level: 'info', message: '[session:save] Window 1 "Kept" bounds: (5,6) 70x80 url=https://kept.example/' },
      { level: 'info', message: '[session:save] Window 2 "W2" bounds: (1,2) 3x4 url=' },
      { level: 'debug', message: '[session:save] Skipping overlay window 3' },
      { level: 'warn', message: '[session:guard] Filtering window with empty/blank URL from snapshot (reason: before-quit)' },
      { level: 'warn', message: '[session:guard] Dropped 1 window(s) with empty/blank URLs from snapshot (reason: before-quit)' },
    ]);
  });
});

describe('session-projection — the extracted pure helpers', () => {
  it('restorableBoundsFromRecord: fullscreen stash wins, else the mirror, else null', () => {
    assert.strictEqual(restorableBoundsFromRecord(undefined), null);
    assert.strictEqual(restorableBoundsFromRecord(makeRecord('a')), null);
    assert.deepStrictEqual(
      restorableBoundsFromRecord(makeRecord('a', { bounds: { x: 1, y: 2, width: 3, height: 4 } })),
      { x: 1, y: 2, width: 3, height: 4 },
    );
    assert.deepStrictEqual(
      restorableBoundsFromRecord(makeRecord('a', {
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        fsMode: { name: 'fullscreen', preBounds: { x: 9, y: 9, width: 9, height: 9 } },
      })),
      { x: 9, y: 9, width: 9, height: 9 },
    );
  });

  it('sanitizeParams keeps primitives + primitive arrays and drops devtools flags', () => {
    const out = sanitizeParams({
      s: 'a', n: 1, b: true, nul: null,
      arr: ['a', 1, true, null], badArr: [{}], obj: {}, fn: () => 1,
      openDevTools: true, detachedDevTools: true,
    });
    assert.deepStrictEqual(out, { s: 'a', n: 1, b: true, nul: null, arr: ['a', 1, true, null] });
  });

  it('mirrorPlacementIntent mirrors each placement mode', () => {
    assert.deepStrictEqual(mirrorPlacementIntent({ placement: { mode: 'edge', edge: 'top' } }).screenEdge, 'top');
    assert.strictEqual(mirrorPlacementIntent({ placement: { mode: 'parent-centered' } }).center, true);
    assert.strictEqual(mirrorPlacementIntent({}).placementMode, undefined);
  });
});
