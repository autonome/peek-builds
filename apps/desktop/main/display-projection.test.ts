/**
 * Unit tests for apps/desktop/main/display-projection.ts — the decision half
 * of the display watcher (window-manager.md §5 step 10).
 *
 * What this covers: the translation a display-layout change goes through
 * before it becomes ONE `DISPLAY_CHANGED` event — which live windows are
 * candidates, which are filtered out at the dispatch site, and which of them
 * `computePlacement` says actually move. `display-watcher.ts` itself is not
 * importable here (it pulls the Electron runtime + `main.js`), so its
 * remaining job — the `screen` snapshot, the two registry walks, the log lines
 * and the single `dispatchWindowEvent` call — is thin wiring around this
 * function and is NOT covered by these tests.
 *
 * The complementary half — what the reducer does with the batch (dropping
 * unknown / hidden / non-normal-fsMode entries, emitting one `SET_BOUNDS`
 * each) — lives in `window-state.test.ts` "DISPLAY_CHANGED".
 *
 * All display data is fabricated; no real Electron `screen` API is touched.
 * Runs under ELECTRON_RUN_AS_NODE=1 via `yarn test:unit`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  collectDisplayProjection,
  type ProjectionSources,
  type ProjectionWindow,
} from './display-projection.js';
import { WEB_CORE_ADDRESS } from './config.js';
import type { Placement } from './window-placement.js';
import type { Rectangle, WindowId } from './window-state.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function wid(n: number): WindowId {
  return `wm-${n}` as WindowId;
}

interface DisplaySpec {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function fakeDisplays(specs: DisplaySpec[]): Electron.Display[] {
  return specs.map((s) => {
    const bounds = { x: s.x, y: s.y, width: s.width, height: s.height };
    return {
      id: s.id,
      bounds,
      workArea: { ...bounds },
      workAreaSize: { width: bounds.width, height: bounds.height },
      size: { width: bounds.width, height: bounds.height },
      scaleFactor: 1,
      rotation: 0,
      internal: false,
      label: `display-${s.id}`,
    } as unknown as Electron.Display;
  });
}

/** Single 1000x1000 display at the origin. */
const ONE_DISPLAY = fakeDisplays([{ id: 1, x: 0, y: 0, width: 1000, height: 1000 }]);

/** A window sitting well away from where a `centered` intent wants it. */
const OFF_CENTER: Rectangle = { x: 0, y: 0, width: 200, height: 100 };
/** Where `centered` puts a 200x100 window on ONE_DISPLAY. */
const CENTERED: Rectangle = { x: 400, y: 450, width: 200, height: 100 };

function win(nativeId: number, over: Partial<ProjectionWindow> = {}): ProjectionWindow {
  return { nativeId, label: 'window', bounds: OFF_CENTER, ...over };
}

/**
 * Build sources with sane defaults: every window is registered, machine-known
 * (`wm-<nativeId>`), centered, and has no parent. Each dependency is
 * overridable per test.
 */
function sources(
  windows: ProjectionWindow[],
  over: Partial<ProjectionSources> = {},
): ProjectionSources {
  return {
    windows,
    getWindowInfo: (nativeId) => ({ params: { address: `peek://w/${nativeId}`, placement: { mode: 'centered' } } }),
    getMachineId: (nativeId) => wid(nativeId),
    getParentBounds: () => undefined,
    ...over,
  };
}

function run(s: ProjectionSources, displays = ONE_DISPLAY, primary = 1) {
  return collectDisplayProjection(s, displays, primary);
}

/** The `{ id, bounds }` pairs that would ride the DISPLAY_CHANGED event. */
function payload(decisions: ReturnType<typeof run>) {
  return decisions.map(({ id, bounds }) => ({ id, bounds }));
}

// ---------------------------------------------------------------------------

describe('collectDisplayProjection — the display-change dispatch-site translation', () => {
  it('projects a window whose intent no longer matches where it sits', () => {
    const decisions = run(sources([win(7)]));
    assert.deepStrictEqual(payload(decisions), [{ id: wid(7), bounds: CENTERED }]);
  });

  it('carries the log context (label / native id / from / mode) alongside the payload', () => {
    const [d] = run(sources([win(7, { label: 'hybrid window' })]));
    assert.strictEqual(d.label, 'hybrid window');
    assert.strictEqual(d.nativeId, 7);
    assert.strictEqual(d.mode, 'centered');
    assert.deepStrictEqual(d.from, OFF_CENTER);
  });

  it('drops a window that is already where its intent wants it (computePlacement no-change)', () => {
    const decisions = run(sources([win(7, { bounds: CENTERED })]));
    assert.deepStrictEqual(decisions, [], 'a settled window contributes no entry');
  });

  it('an all-settled pass produces an empty batch (the watcher then dispatches nothing)', () => {
    const decisions = run(sources([win(1, { bounds: CENTERED }), win(2, { bounds: CENTERED })]));
    assert.deepStrictEqual(decisions, []);
  });

  it('preserves registry order — that is the order the SET_BOUNDS effects run in', () => {
    const decisions = run(sources([win(3), win(1), win(2)]));
    assert.deepStrictEqual(decisions.map((d) => d.id), [wid(3), wid(1), wid(2)]);
  });

  it('drops the background window (WEB_CORE_ADDRESS) — never positioned, never visible', () => {
    const s = sources([win(1), win(2)], {
      getWindowInfo: (nativeId) => ({
        params: {
          address: nativeId === 1 ? WEB_CORE_ADDRESS : 'peek://w/2',
          placement: { mode: 'centered' },
        },
      }),
    });
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(2), bounds: CENTERED }]);
  });

  it('drops a window with no registry entry at all', () => {
    const s = sources([win(1), win(2)], {
      getWindowInfo: (nativeId) =>
        nativeId === 1 ? undefined : { params: { address: 'peek://w/2', placement: { mode: 'centered' } } },
    });
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(2), bounds: CENTERED }]);
  });

  it('drops a window that declared no placement intent (nothing to project)', () => {
    const s = sources([win(1), win(2)], {
      getWindowInfo: (nativeId) => ({
        params: nativeId === 1 ? { address: 'peek://w/1' } : { address: 'peek://w/2', placement: { mode: 'centered' } },
      }),
    });
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(2), bounds: CENTERED }]);
  });

  it('drops a window with no machine id — the event is keyed by machine id', () => {
    const s = sources([win(1), win(2)], {
      getMachineId: (nativeId) => (nativeId === 1 ? null : wid(nativeId)),
    });
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(2), bounds: CENTERED }]);
  });

  it('one dropped window does not drop the rest of the pass', () => {
    const s = sources([win(1), win(2), win(3)], {
      getMachineId: (nativeId) => (nativeId === 2 ? null : wid(nativeId)),
    });
    assert.deepStrictEqual(run(s).map((d) => d.id), [wid(1), wid(3)]);
  });

  it('resolves parent bounds ONLY for a parent-centered intent', () => {
    const asked: number[] = [];
    const s = sources([win(1), win(2)], {
      getWindowInfo: (nativeId) => ({
        params: {
          address: `peek://w/${nativeId}`,
          placement:
            nativeId === 1
              ? ({ mode: 'parent-centered', parentId: 42 } as Placement)
              : ({ mode: 'centered' } as Placement),
        },
      }),
      getParentBounds: (parentId) => {
        asked.push(parentId);
        return { x: 0, y: 0, width: 600, height: 600 };
      },
    });
    const decisions = run(s);
    assert.deepStrictEqual(asked, [42], 'only the parent-centered window asks');
    assert.deepStrictEqual(decisions[0].bounds, { x: 200, y: 250, width: 200, height: 100 });
  });

  it('a parent-centered window whose parent is gone still projects (engine falls back to primary)', () => {
    // The lookup returning undefined is the destroyed-parent case, and it is
    // NOT a drop here: `computePlacement` documents the fallback (primary
    // display, centered), so the window is re-placed rather than stranded.
    const s = sources([win(1)], {
      getWindowInfo: () => ({
        params: { address: 'peek://w/1', placement: { mode: 'parent-centered', parentId: 42 } },
      }),
      getParentBounds: () => undefined,
    });
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(1), bounds: CENTERED }]);
  });

  it('re-projects onto the surviving display when a window\'s display disappears', () => {
    // The window sits on the (now removed) second display; only display 1 is
    // in the snapshot, so `centered` lands it on the primary.
    const s = sources([win(1, { bounds: { x: 1200, y: 100, width: 200, height: 100 } })]);
    assert.deepStrictEqual(payload(run(s)), [{ id: wid(1), bounds: CENTERED }]);
  });

  it('an empty window list produces an empty batch', () => {
    assert.deepStrictEqual(run(sources([])), []);
  });

  it('is pure: the same sources projected twice give the same answer', () => {
    const windows = [win(1), win(2, { bounds: CENTERED })];
    const first = run(sources(windows));
    const second = run(sources(windows));
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(windows[0].bounds, OFF_CENTER, 'candidate bounds not mutated');
  });
});
