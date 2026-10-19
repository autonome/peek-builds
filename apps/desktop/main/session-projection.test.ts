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
 *
 * DELIBERATE BEHAVIOUR CHANGE: maximize is not restored. A maximized record is
 * saved at its pre-maximize rect (`bounds`) with no `maximized` / `preMaxBounds`
 * keys; the oracle was updated WITH the change. Descriptors written by older
 * builds still carry those keys and are converted on restore
 * (`unmaximizedRestoreDescriptor`, tested below).
 *
 * DELIBERATE SHAPE CHANGE (§5 step 11 task 7): a descriptor now also carries
 * `stackIndex` — its position in the machine's bottom→top order at save
 * time — so restore replays the stack that was literally on screen instead of
 * rebuilding it from focus recency. Same migration strategy: the oracle was
 * updated WITH the change (it pins the shape save is supposed to write), the key
 * is ABSENT for a window with no stack position, and a snapshot written before
 * the field falls back to the old focus-recency ordering
 * (`orderRestoredWindowsBottomToTop`, tested below).
 *
 * KERNEL CUTOVER (window-manager.md "The one-order consequence"): the OLD
 * machine's `front`/`stackOrder`/`WindowRecord.focusSeq` are gone — the kernel's
 * `State` (`makeStateSnapshot`) carries no such fields at all. `zOrder`,
 * `stackIndex` and `focused` come from the kernel's single order
 * (`SerializeSessionInput.kernelOrder`) and its topmost content window
 * (`.topmostContentWindowId`), threaded into fixtures via `World.kernelOrder`/
 * `front` below (see `inputFor`). `serializeSession` reads every OTHER
 * window-management fact off `snapshot.order` (per-record `visible` /
 * `maximized` / `preMaxBounds` / `bounds` / `fsMode`), which `makeStateSnapshot`
 * still builds.
 * `World.stackOrder`/`.legacyFront` are a pre-cutover holdover: they used to
 * feed the old machine's now-deleted `front`/`stackOrder` fields so a test
 * could prove the implementation read the kernel fact and not the dead one.
 * `makeStateSnapshot` accepts them for backward source compatibility with
 * every existing `World`/`inputFor` call site but no longer has anywhere to
 * put them — there is no dead field left on `State` to disagree with.
 *
 * ORACLE LIMIT FOR `zOrder`/`stackIndex`/`focused`: these three fields are,
 * post-cutover, definitionally "a position in `kernelOrder`" / "equals
 * `topmostContentWindowId`" — there is no second, independently derivable
 * notion of correctness for `legacySerialize` to restate that isn't the same
 * one-line lookup written a second time. `legacySerialize` still computes them
 * (off `kernelOrderOf`/`front`, the SAME facts `serializeSession` reads) so the
 * on-disk-shape sweep below can still exercise every OTHER field on a world
 * that happens to carry an order/focus fact too — but that computation proves
 * NOTHING about `zOrder`/`stackIndex`/`focused` on its own; a bug confined to
 * those three fields would reproduce identically on both sides and the sweep
 * would stay green. What DOES prove something for those three: the disagreeing
 * `kernelOrder`/`stackOrder` and `front`/`legacyFront` pairs above, checked by
 * dedicated tests against HAND-WRITTEN literal values, never a restatement of
 * the lookup — see the standalone pin after the on-disk-shape describe block,
 * `'focused is the kernel's topmost content window, not the dead snapshot.front
 * field'`, and the SAVE → RESTORE round trip.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  serializeSession,
  addDescriptorsToSnapshot,
  mergeSnapshotIntoWorkspace,
  restorableBoundsFromRecord,
  readPreMaxBounds,
  unmaximizedRestoreDescriptor,
  readStackIndex,
  orderRestoredWindowsBottomToTop,
  sanitizeParams,
  mirrorPlacementIntent,
  planDesktopRestore,
  type SerializeSessionInput,
  type SessionSaveWindow,
  type SessionSavePresentation,
} from './session-projection.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import type { FsMode, Rectangle, State, WindowId, WindowRecord } from './window-kernel.js';
import { initialState, isFrontEligibleWindow } from './window-kernel.js';

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
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    visible: true,
    orderable: true,
    fsMode: { name: 'normal' },
    maximized: false,
    preMaxBounds: null,
    pendingProjectedBounds: null,
    // Runtime registration order; deliberately NOT projected into any
    // descriptor (see `WindowRecord.openSeq`), so the value is arbitrary here.
    openSeq: 0,
    priorKey: null,
    ...over,
  };
}

function makeStateSnapshot(
  windows: WindowRecord[],
  front: WindowId | null = null,
  stackOrder: WindowId[] = defaultStackOrder(windows),
): State {
  // `front`/`stackOrder` are the OLD machine's fields (see the module header's
  // KERNEL CUTOVER note) and have no counterpart on the kernel's `State` —
  // `key` is the nearest field but `serializeSession` reads neither it nor
  // any snapshot-carried order/focus fact, so both params stay accepted only
  // to keep every existing `World`/`inputFor` call site unchanged.
  void stackOrder;
  return {
    ...initialState(),
    key: front,
    order: windows,
  };
}

/**
 * The stack a world gets when it does not name one: record order, filtered to
 * the kernel's own front-eligibility rule (`isFrontEligibleWindow`), so the
 * fixture cannot hand save a stack containing a window the kernel would
 * never put there.
 */
function defaultStackOrder(windows: WindowRecord[]): WindowId[] {
  return windows.filter(isFrontEligibleWindow).map((w) => w.id);
}

/**
 * The order fed to `SerializeSessionInput.kernelOrder` — the fact `zOrder`
 * and `stackIndex` are read from (both the real implementation's and
 * `legacySerialize`'s, which deliberately reads the same fact — see the
 * module header's ORACLE LIMIT note). Falls back to `defaultStackOrder` when
 * a world names neither order knob.
 */
function kernelOrderOf(world: World): WindowId[] {
  if (world.kernelOrder) return world.kernelOrder.map(wid);
  return defaultStackOrder(world.records);
}

/**
 * The order fed to `StateSnapshot.stackOrder` — the OLD machine's own field.
 * `serializeSession` never reads it (module header, "KERNEL CUTOVER"). Exists
 * on the fixture ONLY so a world can hand it a value that CONTRADICTS
 * `kernelOrderOf`, which is what lets a test prove the implementation reads
 * the kernel fact and not this dead one. Falls back to the same default as
 * `kernelOrderOf` when a world names neither, so an ordinary world still gets
 * one consistent order on both.
 */
function legacyStackOrderOf(world: World): WindowId[] {
  if (world.stackOrder) return world.stackOrder.map(wid);
  return defaultStackOrder(world.records);
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
  /**
   * The kernel's single order, BOTTOM → TOP, as machine ids — feeds
   * `SerializeSessionInput.kernelOrder`, the one lookup `zOrder` and
   * `stackIndex` both read (§5 step 11 kernel cutover — one order, and
   * nothing else orders windows). Defaults to record order filtered to
   * stack members; name it explicitly when the world needs an order that
   * disagrees with record order.
   */
  kernelOrder?: string[];
  /**
   * `StateSnapshot.stackOrder` — the OLD machine's own field, unread by
   * `serializeSession`. Defaults to the same value `kernelOrder` defaults to;
   * name it explicitly ONLY to hand it a value that DISAGREES with
   * `kernelOrder`, proving a test reads the right one — see `kernelOrderOf` /
   * `legacyStackOrderOf`.
   */
  stackOrder?: string[];
  /** The kernel's topmost content window — feeds `SerializeSessionInput.topmostContentWindowId`, THE `focused` target. */
  front?: string | null;
  /**
   * `StateSnapshot.front` — the OLD machine's own field, unread by
   * `serializeSession`. Defaults to `front`; name it explicitly ONLY to hand
   * it a DIFFERENT window than `front`, proving `focused` follows the kernel
   * fact and not this dead one.
   */
  legacyFront?: string | null;
  /** What `getNativeWindowFor(front)?.id` answered — the oracle's `lastFocusedId`. */
  frontNativeId?: number | null;
  registeredTileIds?: string[];
  reason?: 'before-quit' | 'autosave' | 'manual' | 'window-close' | 'window-lifecycle' | 'workspace-switch';
  forceForTest?: boolean;
  /** Feeds `SerializeSessionInput.workspaceKey` — defaults to `'default'`. */
  workspaceKey?: string;
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
  // Position in the kernel's single order, bottom→top; absent for a window
  // that is not in it. `zOrder` and `stackIndex` are BOTH this same lookup —
  // one order, and nothing else orders windows (§5 step 11 kernel cutover).
  const kernelOrderIndexById = new Map<string, number>();
  kernelOrderOf(world).forEach((id, index) => kernelOrderIndexById.set(String(id), index));
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
    const windowBounds = presentation.maximized && presentation.preMaxBounds
      ? presentation.preMaxBounds
      : presentation.bounds;

    const extMatch = realUrl.match(/^peek:\/\/ext\/([^/]+)/);
    if (extMatch) {
      const extId = extMatch[1];
      const knownIds = world.registeredTileIds ?? [];
      if (!knownIds.includes(extId)) continue;
    }

    const windowContext: WindowContext | undefined = f.context;

    const sanitized = legacySanitizeParams(legacyMirrorPlacementIntent(f.params));
    delete sanitized.maximized;
    delete sanitized.preMaxBounds;
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
      zOrder: f.machineId != null ? (kernelOrderIndexById.get(f.machineId) ?? 0) : 0,
      stackIndex: f.machineId != null ? kernelOrderIndexById.get(f.machineId) : undefined,
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
      workspaceKey: world.workspaceKey ?? 'default',
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
  const legacyFrontRaw = world.legacyFront !== undefined ? world.legacyFront : world.front;
  return {
    snapshot: makeStateSnapshot(
      world.records,
      legacyFrontRaw == null ? null : wid(legacyFrontRaw),
      legacyStackOrderOf(world),
    ),
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
    kernelOrder: kernelOrderOf(world),
    topmostContentWindowId: world.front == null ? null : wid(world.front),
    workspaceKey: world.workspaceKey ?? 'default',
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

/**
 * w2 was shown without ever being activated; w1 is the last-focused (key)
 * window. Shared by the on-disk-shape entry below and the standalone kernel
 * pin that follows it, so both read the exact same world.
 */
const BACKGROUND_OPEN_WORLD: World = {
  fixtures: [contentFixture(1, 'w1'), contentFixture(2, 'w2')],
  records: [
    makeRecord('w1', { bounds: { x: 1, y: 1, width: 2, height: 2 } }),
    makeRecord('w2', { bounds: { x: 3, y: 3, width: 4, height: 4 } }),
  ],
  kernelOrder: ['w2', 'w1'],
  // Deliberately the OPPOSITE order, on the OLD machine's dead `stackOrder`
  // field — the standalone pin below asserts LITERAL positions that only
  // match `kernelOrder`, so reading this field instead would fail it.
  stackOrder: ['w1', 'w2'],
  front: 'w1',
  frontNativeId: 1,
};

describe('session-projection — on-disk shape is byte-identical to the pre-extraction save path', () => {
  const worlds: Array<[string, World]> = [
    ['empty state', { fixtures: [], records: [] }],

    ['single plain content window', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', { bounds: { x: 5, y: 6, width: 700, height: 800 } })],
      front: 'w1',
      frontNativeId: 1,
    }],

    ['fullscreen window persists its pre-fullscreen rect', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        fsMode: FULLSCREEN_MODE,
      })],
      front: 'w1',
      frontNativeId: 1,
    }],

    ['maximized window is saved at its pre-maximize rect, unmaximized', {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1512, height: 900 },
        maximized: true,
        preMaxBounds: { x: 100, y: 110, width: 640, height: 480 },
      })],
    }],

    // A window restored from an older snapshot may still carry that
    // snapshot's maximize keys in its params. Re-saving it must not write them.
    ['maximize keys in params do not ride forward', {
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
        makeRecord('w1', { bounds: { x: 1, y: 1, width: 10, height: 10 } }),
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
        makeRecord('w2', { class: 'overlay', role: 'overlay' }),
        makeRecord('w3', { bounds: { x: 5, y: 5, width: 50, height: 50 } }),
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

    // A background open: w2 was shown without ever being activated, w1 is the
    // last-focused (key) window. There is ONE order, and a background open
    // enters it BELOW the window holding key — see the standalone pin right
    // after this describe block for the direct assertion; this entry only
    // carries the world through the same byte-identity sweep every other
    // world here gets.
    ['a background open is saved BELOW the last-focused window', BACKGROUND_OPEN_WORLD],

    // A window save keeps but the machine's stack does not hold (here: a
    // window the machine has no record for at all) leaves the key ABSENT, not
    // null — an explicit null would change the on-disk text.
    ['a window with no stack position leaves the key absent', {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, null as unknown as string, { machineId: null })],
      records: [makeRecord('w1', { bounds: { x: 1, y: 1, width: 2, height: 2 } })],
    }],
  ];

  for (const [label, world] of worlds) {
    it(label, () => assertSameOnDiskShape(world, label));
  }

  // The kernel fact `BACKGROUND_OPEN_WORLD` pins: a window shown without being
  // activated (w2) registers BELOW the key window (w1) in the kernel's single
  // order. `BACKGROUND_OPEN_WORLD.stackOrder` names the OPPOSITE order on the
  // OLD machine's dead field, so the LITERAL positions asserted below only
  // come out right if `serializeSession` reads `kernelOrder` — reading the
  // dead field instead would swap w1 and w2's positions.
  it('a background open registers below the key window in the kernel\'s single order', () => {
    const out = serializeSession(inputFor(BACKGROUND_OPEN_WORLD)).snapshot.windows;
    const [w1, w2] = out;
    assert.strictEqual(w1.focused, true, 'w1 holds key');
    assert.strictEqual(w2.focused, false);
    // kernelOrder = ['w2', 'w1']: w2 is the bottom entry (index 0), w1 the
    // top (index 1) — literal values, not a restatement of the lookup.
    assert.strictEqual(w2.stackIndex, 0, 'the background open (w2) sits at the bottom of the kernel order');
    assert.strictEqual(w1.stackIndex, 1, 'the key window (w1) sits on top of the kernel order');
    assert.strictEqual(w2.zOrder, 0);
    assert.strictEqual(w1.zOrder, 1);
  });
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

  it('a signal-role window (a space’s desktop marker) is never saved', () => {
    // The per-space 2x2 marker window is a desktop anchor, not session
    // content; captured once by an ambient save under the default key, it
    // restored as an ordinary window on every boot
    // (docs/design/space-desktop-return-plan.md, experiment E5).
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { address: 'https://kept.example/' }),
        contentFixture(2, 'w2', { params: { role: 'signal' }, address: 'peek://spaces/signal.html' }),
      ],
      records: [makeRecord('w1'), makeRecord('w2')],
    };
    assert.deepStrictEqual(urlsOf(world), ['https://kept.example/']);
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
    for (const name of ['entering', 'leaving'] as const) {
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

  it('focused is the kernel\'s topmost content window, not the dead snapshot.front field', () => {
    // `zOrder`'s own value — a position in the kernel's single order — is
    // already pinned, byte-for-byte, by every kernel-order-bearing world in
    // the on-disk-shape describe above (e.g. "single plain content window",
    // "a background open is saved BELOW the last-focused window") — this test
    // drops the redundant direct assertion so it isn't the one place a future
    // source change for `zOrder` has to keep matching (window-manager.md
    // "The one-order consequence").
    const world: World = {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, 'w2')],
      records: [makeRecord('w1'), makeRecord('w2')],
      front: 'w2',
      // Deliberately the OTHER window on the OLD machine's dead `front`
      // field — proves `focused` follows `topmostContentWindowId` (`front`
      // above), not `StateSnapshot.front` (this).
      legacyFront: 'w1',
      frontNativeId: 2,
    };
    const out = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(out.map((w) => w.focused), [false, true]);
  });

  it('a window outside the machine stack gets NO stackIndex key at all', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, null as unknown as string, { machineId: null })],
      records: [makeRecord('w1')],
    };
    const out = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual(out[0].stackIndex, 0);
    assert.strictEqual('stackIndex' in out[1], true, 'the key is written, holding undefined');
    assert.strictEqual(out[1].stackIndex, undefined);
    assert.strictEqual(JSON.parse(JSON.stringify(out[1])).stackIndex, undefined, 'and JSON drops it entirely');
  });

  it('the desktop a window was last on is saved from its record; no key when unknown', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, 'w2')],
      records: [makeRecord('w1', { desktop: '3' }), makeRecord('w2')],
    };
    const out = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual(out[0].desktop, '3');
    assert.strictEqual('desktop' in out[1], false, 'an unknown desktop leaves the key absent');
    assert.strictEqual(JSON.parse(JSON.stringify(out[0])).desktop, '3');
  });

  it('the save log line names the desktop when known and is unchanged when not', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1'), contentFixture(2, 'w2')],
      records: [makeRecord('w1', { desktop: '3' }), makeRecord('w2')],
    };
    const lines = serializeSession(inputFor(world)).notices
      .filter((n) => n.message.startsWith('[session:save] Window'))
      .map((n) => n.message);
    assert.match(lines[0], / desktop=3 url=/);
    assert.doesNotMatch(lines[1], /desktop=/);
  });

  it('a snapshot written before the desktop field existed still reads back', () => {
    const old = JSON.parse(JSON.stringify({
      url: 'https://example.com/', key: undefined, title: 't', bounds: { x: 0, y: 0, width: 1, height: 1 },
      source: 's', params: {}, zOrder: 0, stackIndex: 0, focused: false,
    }));
    assert.strictEqual('desktop' in old, false);
    assert.strictEqual(readStackIndex(old), 0);
  });

  it('saved positions are the stack own indices — a skipped window leaves a gap', () => {
    // The machine's stack holds an overlay between two saved windows. Save skips
    // the overlay, so its index is simply unused; only relative order matters.
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1'),
        contentFixture(2, 'w2', { params: { role: 'overlay' } }),
        contentFixture(3, 'w3'),
      ],
      records: [makeRecord('w1'), makeRecord('w2'), makeRecord('w3')],
      kernelOrder: ['w1', 'w2', 'w3'],
    };
    const out = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(out.map((w) => w.stackIndex), [0, 2]);
  });

  it('stale maximize keys in params are stripped when the record is not maximized', () => {
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

  it('a maximized record is saved at its pre-maximize rect with no maximize keys', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', {
        params: { ...CONTENT_PARAMS, maximized: true, preMaxX: 1, preMaxY: 2, preMaxWidth: 3, preMaxHeight: 4 },
      })],
      records: [makeRecord('w1', {
        bounds: { x: 0, y: 0, width: 1512, height: 900 },
        maximized: true,
        preMaxBounds: { x: 100, y: 110, width: 640, height: 480 },
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(d.bounds, { x: 100, y: 110, width: 640, height: 480 });
    for (const k of ['maximized', 'preMaxBounds', 'preMaxX', 'preMaxY', 'preMaxWidth', 'preMaxHeight']) {
      assert.strictEqual(k in d.params, false, `${k} must not be written`);
    }
  });

  it('a maximized record with no stash is saved at its current bounds, unmaximized', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { params: { ...CONTENT_PARAMS, preMaxX: 9 } })],
      records: [makeRecord('w1', {
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        maximized: true,
        preMaxBounds: null,
      })],
    };
    const [d] = serializeSession(inputFor(world)).snapshot.windows;
    assert.deepStrictEqual(d.bounds, { x: 1, y: 1, width: 2, height: 2 });
    assert.strictEqual('maximized' in d.params, false);
    assert.strictEqual('preMaxBounds' in d.params, false);
    assert.strictEqual('preMaxX' in d.params, false);
  });
});

/**
 * The READ half of the descriptor's maximize shape. `serializeSession` no longer
 * writes it; both branches exist only to absorb snapshots written by older
 * builds and are meant to be deleted once those have aged out — these cases pin
 * them while they live.
 */
describe('session-projection — readPreMaxBounds', () => {
  it('reads the nested rect an older snapshot carries', () => {
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

describe('session-projection — readStackIndex + orderRestoredWindowsBottomToTop', () => {
  const desc = (over: Record<string, unknown>) => over as unknown as WindowDescriptor;

  it('reads the position a current snapshot carries, including 0', () => {
    assert.strictEqual(readStackIndex(desc({ stackIndex: 0 })), 0);
    assert.strictEqual(readStackIndex(desc({ stackIndex: 7 })), 7);
  });

  it('returns null for a PRE-FIELD snapshot and for anything that is not a finite number', () => {
    assert.strictEqual(readStackIndex(desc({})), null, 'a descriptor written before the field existed');
    assert.strictEqual(readStackIndex(desc({ stackIndex: undefined })), null);
    assert.strictEqual(readStackIndex(desc({ stackIndex: null })), null);
    assert.strictEqual(readStackIndex(desc({ stackIndex: '2' })), null);
    assert.strictEqual(readStackIndex(desc({ stackIndex: NaN })), null);
    assert.strictEqual(readStackIndex(desc({ stackIndex: Infinity })), null);
  });

  it('orders recorded windows by their saved position, bottom → top', () => {
    // Restore dispatch order is front→back; the saved stack says otherwise.
    assert.deepStrictEqual(
      orderRestoredWindowsBottomToTop([
        { id: 10, stackIndex: 2 },
        { id: 11, stackIndex: 0 },
        { id: 12, stackIndex: 1 },
      ]),
      [11, 12, 10],
    );
  });

  it('gaps in the saved positions are irrelevant — only the relative order is', () => {
    assert.deepStrictEqual(
      orderRestoredWindowsBottomToTop([
        { id: 10, stackIndex: 40 },
        { id: 11, stackIndex: 3 },
      ]),
      [11, 10],
    );
  });

  it('a PRE-FIELD snapshot (every position unrecorded) falls back to reversing dispatch order', () => {
    // Nothing recorded: every entry's stackIndex is null, so the fallback
    // reverses the array exactly as given. This absorbs a snapshot written
    // before the field existed, whatever order its caller dispatched restore
    // in — the fallback does not name that order "focus recency" (the
    // one-order decision retires focus recency as a distinct concept from
    // stack position; see window-manager.md "The one-order consequence").
    assert.deepStrictEqual(
      orderRestoredWindowsBottomToTop([
        { id: 10, stackIndex: null },
        { id: 11, stackIndex: null },
        { id: 12, stackIndex: null },
      ]),
      [12, 11, 10],
    );
  });

  it('a window with no recorded position sits below every recorded one', () => {
    assert.deepStrictEqual(
      orderRestoredWindowsBottomToTop([
        { id: 10, stackIndex: 1 },
        { id: 11, stackIndex: null },
        { id: 12, stackIndex: 0 },
        { id: 13, stackIndex: null },
      ]),
      [13, 11, 12, 10],
    );
  });

  it('names every entry, so the caller\'s drive count stays the restored count', () => {
    for (const entries of [
      [{ id: 1, stackIndex: 0 }, { id: 2, stackIndex: 1 }],
      [{ id: 1, stackIndex: null }, { id: 2, stackIndex: null }],
      [{ id: 1, stackIndex: 5 }, { id: 2, stackIndex: null }],
    ]) {
      assert.strictEqual(orderRestoredWindowsBottomToTop(entries).length, entries.length);
    }
  });

  it('an empty restore produces an empty import', () => {
    assert.deepStrictEqual(orderRestoredWindowsBottomToTop([]), []);
  });

  it('SAVE → RESTORE round trip: a background open comes back BELOW the last-focused window', () => {
    // w1 is the window the user last focused; w2 was opened behind their back.
    // Under the one-order rule (window-manager.md §0.1.10, "a window that was
    // not focused does not go on top") the saved stack already carries w2
    // BELOW w1, so save and restore agree instead of ranking it two opposite
    // ways: restore loads by recency (w1 first) and stacks by the same saved
    // position (w2 stays below).
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { address: 'https://last-focused.example/' }),
                 contentFixture(2, 'w2', { address: 'https://background-open.example/' })],
      records: [makeRecord('w1'), makeRecord('w2')],
      kernelOrder: ['w2', 'w1'],
      // Deliberately the opposite order on the OLD machine's dead field —
      // proves the round trip below is driven by `kernelOrder`, not this.
      stackOrder: ['w1', 'w2'],
      front: 'w1',
      frontNativeId: 1,
    };
    const saved = serializeSession(inputFor(world)).snapshot.windows;

    // `session.ts restoreSessionSnapshot` loading order: focus recency
    // descending, saved-focused descriptor hoisted to the head.
    const byRecency = [...saved].sort((a, b) => b.zOrder - a.zOrder);
    const focused = byRecency.find((w) => w.focused) ?? null;
    const dispatchOrder = focused ? [focused, ...byRecency.filter((w) => w !== focused)] : byRecency;
    assert.deepStrictEqual(
      dispatchOrder.map((w) => w.url),
      ['https://last-focused.example/', 'https://background-open.example/'],
      'the last-focused window still loads first',
    );

    // Each restored window keyed by a stand-in live id.
    const liveId = new Map(dispatchOrder.map((w, i) => [w, 100 + i]));
    const entries = dispatchOrder.map((w) => ({ id: liveId.get(w)!, stackIndex: readStackIndex(w) }));
    const urlOf = new Map([...liveId].map(([w, id]) => [id, w.url]));

    assert.deepStrictEqual(
      orderRestoredWindowsBottomToTop(entries).map((id) => urlOf.get(id)),
      ['https://background-open.example/', 'https://last-focused.example/'],
      'bottom→top: the background open stays below, as it was on screen',
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
      workspaceKey: 'default',
      windows: [],
    });
    assert.strictEqual(projection.windowCount, 0);
    assert.deepStrictEqual(projection.notices, []);
    assert.strictEqual(JSON.stringify(projection.snapshot), `{"version":1,"createdAt":${CREATED_AT},"reason":"before-quit","workspaceKey":"default","windows":[]}`);
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

/**
 * Workspace-keyed snapshots (spec `workspace-session-snapshot.md`, requirement
 * 2 and 3): the one field a workspace needs beyond a plain snapshot is the
 * `workspaceKey` on the written snapshot. Everything a NAMED key filters is
 * derived from the key alone — its own windows only, and never a window
 * pinned across every workspace (which is not the workspace's to save and is
 * skipped by a workspace restore anyway) — so no caller can get a separate
 * flag wrong. The default key saves everything on screen, unfiltered.
 */
describe('serializeSession — workspace-keyed snapshots', () => {
  it('the written snapshot carries the workspaceKey it was asked to save under', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1')],
      workspaceKey: 'space-42',
    };
    const result = serializeSession(inputFor(world));
    assert.strictEqual(result.snapshot.workspaceKey, 'space-42');
  });

  it('defaults workspaceKey to "default" when the caller names no workspace', () => {
    const world: World = { fixtures: [contentFixture(1, 'w1')], records: [makeRecord('w1')] };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.workspaceKey, 'default');
  });

  it('a named workspace\'s save never includes a window pinned across every workspace, even one whose context names that workspace', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { context: { mode: 'space', modeMetadata: { spaceId: 'space-42' }, pinScope: 'global' } }),
        contentFixture(2, 'w2', {
          context: { mode: 'space', modeMetadata: { spaceId: 'space-42' } },
          rawUrl: 'https://example.com/w2', address: 'https://example.com/w2',
        }),
      ],
      records: [makeRecord('w1'), makeRecord('w2')],
      workspaceKey: 'space-42',
    };
    const urls = serializeSession(inputFor(world)).snapshot.windows.map((w) => w.url);
    assert.deepStrictEqual(urls, ['https://example.com/w2']);
  });

  it('a window pinned only to this workspace is saved in its own workspace\'s row', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { context: { mode: 'space', modeMetadata: { spaceId: 'space-42' }, pinScope: 'workspace' } })],
      records: [makeRecord('w1')],
      workspaceKey: 'space-42',
    };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.windows.length, 1);
  });

  it('the default workspace\'s save includes a cross-workspace pin like any other window — with or without a mode row', () => {
    // No mode row at all: a plain window pinned globally without ever being
    // assigned to a space/group (`features/spaces/background.js setPinState()`
    // sets only the 'pin' key for a global pin). `session.ts readSaveContext`
    // yields exactly this shape for it.
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { context: { mode: null, modeMetadata: null, pinScope: 'global' } })],
      records: [makeRecord('w1')],
    };
    const windows = serializeSession(inputFor(world)).snapshot.windows;
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].context?.pinScope, 'global');
  });

  it('a cross-workspace pin with no mode row is still kept out of a named workspace\'s save', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { context: { mode: null, modeMetadata: null, pinScope: 'global' } })],
      records: [makeRecord('w1')],
      workspaceKey: 'space-42',
    };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.windows.length, 0);
  });

  it('a named workspace\'s save excludes a window that does not name it in its own context metadata', () => {
    const world: World = {
      fixtures: [
        contentFixture(1, 'w1', { context: { mode: 'space', modeMetadata: { spaceId: 'space-OTHER' } } }),
        contentFixture(2, 'w2', {
          context: { mode: 'space', modeMetadata: { spaceId: 'space-42' } },
          rawUrl: 'https://example.com/w2', address: 'https://example.com/w2',
        }),
        contentFixture(3, 'w3', {
          rawUrl: 'https://example.com/w3', address: 'https://example.com/w3',
        }),
      ],
      records: [makeRecord('w1'), makeRecord('w2'), makeRecord('w3')],
      workspaceKey: 'space-42',
    };
    const urls = serializeSession(inputFor(world)).snapshot.windows.map((w) => w.url);
    assert.deepStrictEqual(
      urls,
      ['https://example.com/w2'],
      'only the window whose own context names this workspace belongs in its saved snapshot',
    );
  });

  it('a named workspace\'s save also matches on groupId (features/groups/home.js uses "group" mode)', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { context: { mode: 'group', modeMetadata: { groupId: 'tag-9' } } })],
      records: [makeRecord('w1')],
      workspaceKey: 'tag-9',
    };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.windows.length, 1);
  });

  it('the default workspace\'s save stays unfiltered by context metadata (today\'s behavior)', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1')],
      records: [makeRecord('w1')],
    };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.windows.length, 1);
  });

  it('a window opened with persist:false (feature chrome, e.g. the workspace panel) is never saved', () => {
    const world: World = {
      fixtures: [contentFixture(1, 'w1', { params: { ...CONTENT_PARAMS, persist: false } })],
      records: [makeRecord('w1')],
    };
    assert.strictEqual(serializeSession(inputFor(world)).snapshot.windows.length, 0);
  });
});

describe('addDescriptorsToSnapshot', () => {
  const desc = (url: string, over: Partial<WindowDescriptor> = {}): WindowDescriptor => ({
    url,
    key: undefined,
    title: url,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    source: 'test',
    params: {},
    zOrder: 0,
    focused: false,
    ...over,
  });

  it('creates a snapshot holding just the added windows when there is no saved row', () => {
    const snap = addDescriptorsToSnapshot(null, [desc('https://a.test/')], 'tag-1', 'workspace-switch', 5);
    assert.strictEqual(snap.version, 1);
    assert.strictEqual(snap.workspaceKey, 'tag-1');
    assert.strictEqual(snap.createdAt, 5);
    assert.deepStrictEqual(snap.windows.map((d) => d.url), ['https://a.test/']);
  });

  it('keeps the existing windows and appends the new one', () => {
    const existing = addDescriptorsToSnapshot(null, [desc('https://a.test/')], 'tag-1', 'workspace-switch', 1);
    const snap = addDescriptorsToSnapshot(existing, [desc('https://b.test/')], 'tag-1', 'workspace-switch', 2);
    assert.deepStrictEqual(snap.windows.map((d) => d.url), ['https://a.test/', 'https://b.test/']);
  });

  it('keeps two keyless windows at the same address', () => {
    const existing = addDescriptorsToSnapshot(null, [desc('https://a.test/')], 'tag-1', 'workspace-switch', 1);
    const snap = addDescriptorsToSnapshot(existing, [desc('https://a.test/')], 'tag-1', 'workspace-switch', 2);
    assert.strictEqual(snap.windows.length, 2);
  });

  it('does not add a keyed window already in the row (same url and key)', () => {
    const existing = addDescriptorsToSnapshot(null, [desc('https://a.test/', { key: 'k1' })], 'tag-1', 'workspace-switch', 1);
    const snap = addDescriptorsToSnapshot(existing, [desc('https://a.test/', { key: 'k1' })], 'tag-1', 'workspace-switch', 2);
    assert.strictEqual(snap.windows.length, 1);
  });

  it('treats the same url under a different window key as a different window', () => {
    const existing = addDescriptorsToSnapshot(null, [desc('https://a.test/', { key: 'k1' })], 'tag-1', 'workspace-switch', 1);
    const snap = addDescriptorsToSnapshot(existing, [desc('https://a.test/', { key: 'k2' })], 'tag-1', 'workspace-switch', 2);
    assert.strictEqual(snap.windows.length, 2);
  });

  it('does not mutate the existing snapshot', () => {
    const existing = addDescriptorsToSnapshot(null, [desc('https://a.test/')], 'tag-1', 'workspace-switch', 1);
    addDescriptorsToSnapshot(existing, [desc('https://b.test/')], 'tag-1', 'workspace-switch', 2);
    assert.strictEqual(existing.windows.length, 1);
  });
});

describe('mergeSnapshotIntoWorkspace', () => {
  const desc = (url: string, over: Partial<WindowDescriptor> = {}): WindowDescriptor => ({
    url,
    key: undefined,
    title: url,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    source: 'test',
    params: {},
    zOrder: 0,
    focused: false,
    ...over,
  });
  const snap = (key: string, windows: WindowDescriptor[]) =>
    ({ version: 1 as const, createdAt: 1, reason: 'workspace-switch' as const, workspaceKey: key, windows });
  const target = { spaceId: 'tag-default', spaceName: 'default', color: '#999' };
  const inSpace = (spaceId: string, spaceName: string): WindowContext => ({
    mode: 'space',
    modeMetadata: { spaceId, spaceName, color: '#f00', url: 'https://x.test/' },
  });

  it('keeps the target workspace windows first and appends the source windows', () => {
    const merged = mergeSnapshotIntoWorkspace(
      snap('default', [desc('https://a.test/')]),
      snap('tag-1', [desc('https://b.test/', { context: inSpace('tag-1', 'Work') })]),
      'default', target, 7,
    );
    assert.strictEqual(merged.workspaceKey, 'default');
    assert.strictEqual(merged.createdAt, 7);
    assert.deepStrictEqual(merged.windows.map((d) => d.url), ['https://a.test/', 'https://b.test/']);
  });

  it('moves each source window into the target space, keeping its saved url', () => {
    const merged = mergeSnapshotIntoWorkspace(
      null,
      snap('tag-1', [desc('https://b.test/', { context: inSpace('tag-1', 'Work') })]),
      'default', target, 7,
    );
    assert.deepStrictEqual(merged.windows[0].context?.modeMetadata,
      { spaceId: 'tag-default', spaceName: 'default', color: '#999', url: 'https://x.test/' });
    assert.strictEqual(merged.windows[0].context?.mode, 'space');
  });

  it('keeps a workspace pin on a moved window', () => {
    const merged = mergeSnapshotIntoWorkspace(
      null,
      snap('tag-1', [desc('https://b.test/', { context: { ...inSpace('tag-1', 'Work'), pinScope: 'workspace' } })]),
      'default', target, 7,
    );
    assert.strictEqual(merged.windows[0].context?.pinScope, 'workspace');
  });

  it('puts a source window with no saved membership in the target space too', () => {
    const merged = mergeSnapshotIntoWorkspace(null, snap('tag-1', [desc('https://b.test/')]), 'default', target, 7);
    assert.strictEqual(merged.windows[0].context?.mode, 'space');
    assert.strictEqual(merged.windows[0].context?.modeMetadata?.spaceId, 'tag-default');
  });

  it('leaves the target window that had focus as the only focused one', () => {
    const merged = mergeSnapshotIntoWorkspace(
      snap('default', [desc('https://a.test/', { focused: true })]),
      snap('tag-1', [desc('https://b.test/', { focused: true })]),
      'default', target, 7,
    );
    assert.deepStrictEqual(merged.windows.map((d) => d.focused), [true, false]);
  });

  it('does not add a source window the target already holds (same url and key)', () => {
    const merged = mergeSnapshotIntoWorkspace(
      snap('default', [desc('https://a.test/')]),
      snap('tag-1', [desc('https://a.test/')]),
      'default', target, 7,
    );
    assert.strictEqual(merged.windows.length, 1);
  });

  it('with no source snapshot, returns the target windows unchanged', () => {
    const existing = snap('default', [desc('https://a.test/')]);
    const merged = mergeSnapshotIntoWorkspace(existing, null, 'default', target, 7);
    assert.deepStrictEqual(merged.windows, existing.windows);
  });

  it('does not mutate either input', () => {
    const source = snap('tag-1', [desc('https://b.test/', { context: inSpace('tag-1', 'Work'), focused: true })]);
    const existing = snap('default', [desc('https://a.test/')]);
    mergeSnapshotIntoWorkspace(existing, source, 'default', target, 7);
    assert.strictEqual(existing.windows.length, 1);
    assert.strictEqual(source.windows[0].context?.modeMetadata?.spaceId, 'tag-1');
    assert.strictEqual(source.windows[0].focused, true);
  });
});

describe('planDesktopRestore — which desktop each window goes to and whether to switch', () => {
  const layout = { desktops: [{ id: '1' }, { id: '2' }, { id: '3' }] };

  it('a window goes to its saved desktop when that desktop still exists', () => {
    const plan = planDesktopRestore([{ desktop: '2' }], layout, '1');
    assert.deepStrictEqual(plan.targets, ['2']);
  });

  it('a window whose saved desktop is gone, or never recorded, goes to the active desktop', () => {
    const plan = planDesktopRestore([{ desktop: '9' }, {}], layout, '1');
    assert.deepStrictEqual(plan.targets, ['1', '1']);
  });

  it('stays when the active desktop holds any of the windows', () => {
    const plan = planDesktopRestore([{ desktop: '2', focused: true }, { desktop: '1' }], layout, '1');
    assert.strictEqual(plan.switchTo, null);
  });

  it('switches to the desktop of the focused window when none is on the active desktop', () => {
    const plan = planDesktopRestore([{ desktop: '2' }, { desktop: '3', focused: true }], layout, '1');
    assert.strictEqual(plan.switchTo, '3');
  });

  it('switches to the desktop of the first window when none is focused', () => {
    const plan = planDesktopRestore([{ desktop: '3' }, { desktop: '2' }], layout, '1');
    assert.strictEqual(plan.switchTo, '3');
  });

  it('a window whose saved desktop is gone counts as on the active desktop, so the space stays', () => {
    const plan = planDesktopRestore([{ desktop: '9' }, { desktop: '2' }], layout, '1');
    assert.deepStrictEqual(plan, { targets: ['1', '2'], switchTo: null });
  });

  it('with no active desktop known, nothing is placed or switched', () => {
    const plan = planDesktopRestore([{ desktop: '2' }], layout, null);
    assert.deepStrictEqual(plan, { targets: [null], switchTo: null });
  });

  it('with no windows there is nothing to switch to', () => {
    assert.deepStrictEqual(planDesktopRestore([], layout, '1'), { targets: [], switchTo: null });
  });
});


describe('session-projection — unmaximizedRestoreDescriptor', () => {
  const MAXIMIZED_RECT = { x: 0, y: 0, width: 1512, height: 900 };
  const PRE_MAX = { x: 100, y: 110, width: 640, height: 480 };
  const MAX_KEYS = ['maximized', 'preMaxBounds', 'preMaxX', 'preMaxY', 'preMaxWidth', 'preMaxHeight'];

  it('an older maximized descriptor with a nested preMaxBounds restores at that rect', () => {
    const out = unmaximizedRestoreDescriptor({
      bounds: MAXIMIZED_RECT,
      params: { keep: 'me', maximized: true, preMaxBounds: PRE_MAX },
    });
    assert.deepStrictEqual(out.bounds, PRE_MAX);
    assert.deepStrictEqual(out.params, { keep: 'me' });
  });

  it('an older maximized descriptor with the flat preMaxX/Y/Width/Height restores at that rect', () => {
    const out = unmaximizedRestoreDescriptor({
      bounds: MAXIMIZED_RECT,
      params: { maximized: true, preMaxX: 100, preMaxY: 110, preMaxWidth: 640, preMaxHeight: 480 },
    });
    assert.deepStrictEqual(out.bounds, PRE_MAX);
    for (const k of MAX_KEYS) assert.strictEqual(k in out.params, false, `${k} must be dropped`);
  });

  it('a maximized descriptor with no stash keeps its saved bounds, unmaximized', () => {
    const out = unmaximizedRestoreDescriptor({ bounds: MAXIMIZED_RECT, params: { maximized: true } });
    assert.deepStrictEqual(out.bounds, MAXIMIZED_RECT);
    assert.strictEqual('maximized' in out.params, false);
  });

  it('a descriptor that is not maximized keeps its bounds and loses only stray maximize keys', () => {
    const out = unmaximizedRestoreDescriptor({
      bounds: MAXIMIZED_RECT,
      params: { keep: 1, preMaxBounds: PRE_MAX },
    });
    assert.deepStrictEqual(out.bounds, MAXIMIZED_RECT);
    assert.deepStrictEqual(out.params, { keep: 1 });
  });

  it('does not mutate its input and keeps other descriptor fields', () => {
    const input = { url: 'https://a.test', bounds: MAXIMIZED_RECT, params: { maximized: true, preMaxBounds: PRE_MAX } };
    const out = unmaximizedRestoreDescriptor(input);
    assert.strictEqual(out.url, 'https://a.test');
    assert.strictEqual(input.params.maximized, true);
    assert.deepStrictEqual(input.bounds, MAXIMIZED_RECT);
  });
});
