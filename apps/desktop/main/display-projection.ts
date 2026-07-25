/**
 * Display Reprojection — the decision half of `display-watcher.ts`
 *
 * When the display layout changes, someone has to answer two questions: WHICH
 * live windows are candidates for a re-placement, and WHERE each one lands.
 * `display-watcher.ts` owns the OS side of that pass (the `screen` snapshot,
 * the registry walks, the `getWindowInfo` join) and the dispatch of the single
 * `DISPLAY_CHANGED` event; this module owns the decision, expressed as a pure
 * function over injected sources.
 *
 * Why it is its own module: `display-watcher.ts` imports the Electron runtime
 * (`screen`) and `main.js`, so it cannot be loaded by the main-process unit
 * runner (which runs under `ELECTRON_RUN_AS_NODE=1`, where `electron` is a
 * path string, not the API). Everything worth testing about the cutover — the
 * per-window filters and the projection math's keep/reposition verdict — lives
 * here instead, reachable from a plain unit test.
 *
 * Placement math itself stays in `window-placement.ts` (`computePlacement`);
 * this module only decides who gets asked and what to do with the answer. It
 * runs AT THE DISPATCH SITE, before the event is built, because the window
 * state machine's reducer keeps zero value imports and cannot do rect math
 * (see `window-state.ts` `DISPLAY_CHANGED`).
 */

import { computePlacement, type Placement } from './window-placement.js';
import { WEB_CORE_ADDRESS } from './config.js';
import type { WindowId, Rectangle } from './window-state.js';

/**
 * The minimum a live window has to answer for a projection pass. The watcher
 * builds one of these per plain window (`window-registry`) and per hybrid
 * page-host (`hybrid-page-host-registry`), which is what lets both kinds share
 * a single pass.
 */
export interface ProjectionWindow {
  /** Electron window id — the key `getWindowInfo` / `getMachineId` join on. */
  nativeId: number;
  /** `'window'` / `'hybrid window'` — the reposition log line only. */
  label: string;
  /** The window's bounds right now (`win.getBounds()`). */
  bounds: Rectangle;
}

/**
 * Everything the pass reads from outside itself. Injected rather than imported
 * so the decision is testable without the Electron runtime, the window
 * registries, or `main.js`.
 */
export interface ProjectionSources {
  /** Every live window, in the order the watcher walks its registries. */
  windows: readonly ProjectionWindow[];
  /** Open-time params for a native window id (`main.ts getWindowInfo`). */
  getWindowInfo(nativeId: number): { params: Record<string, unknown> } | undefined;
  /** The machine id for a native window, or null when unregistered. */
  getMachineId(nativeId: number): WindowId | null;
  /**
   * Bounds of a `parent-centered` placement's parent, or undefined when the
   * parent is gone. `computePlacement` treats an absent parent as "leave it
   * alone", so this never has to throw.
   */
  getParentBounds(parentId: number): Rectangle | undefined;
}

/**
 * One window that IS moving. Carries the `DISPLAY_CHANGED` payload fields
 * (`id` + `bounds`) plus the context the watcher's log line wants, so the
 * watcher never has to re-join a decision back onto its candidate.
 */
export interface ProjectionDecision {
  /** Machine id — what `DISPLAY_CHANGED.projected[].id` carries. */
  id: WindowId;
  /** Target rectangle — what `DISPLAY_CHANGED.projected[].bounds` carries. */
  bounds: Rectangle;
  /** Where it is now, for the log line. */
  from: Rectangle;
  /** `'window'` / `'hybrid window'`, for the log line. */
  label: string;
  /** Electron window id, for the log line. */
  nativeId: number;
  /** The placement intent that produced the move, for the log line. */
  mode: Placement['mode'];
}

/**
 * Decide which windows move, and where, for one display-layout change.
 *
 * A window is dropped — silently, it is a normal outcome — when:
 *  - it has no registry entry, or it is the background window
 *    (`WEB_CORE_ADDRESS`): never positioned, never visible;
 *  - it declared no `placement` intent: nothing to project;
 *  - it has no machine id (unregistered with the window state machine): the
 *    event is keyed by machine id, so there is nothing to name it by;
 *  - `computePlacement` says `no-change`: it is already where its intent
 *    wants it on the new layout.
 *
 * Note what is NOT filtered here: visibility and fullscreen. Both are answered
 * from the state machine's own mirror inside the reducer (`window-state.ts`
 * `DISPLAY_CHANGED`) rather than by asking the OS a second time.
 *
 * Order is preserved: decisions come out in `sources.windows` order, which is
 * the order the resulting `SET_BOUNDS` effects run in.
 */
export function collectDisplayProjection(
  sources: ProjectionSources,
  displays: Electron.Display[],
  primaryDisplayId: number,
): ProjectionDecision[] {
  const decisions: ProjectionDecision[] = [];

  for (const win of sources.windows) {
    const entry = sources.getWindowInfo(win.nativeId);
    // Skip the background window — never positioned, never visible.
    if (!entry || entry.params.address === WEB_CORE_ADDRESS) continue;

    const placement = entry.params.placement as Placement | undefined;
    if (!placement) continue;

    const id = sources.getMachineId(win.nativeId);
    if (id == null) continue;

    const parentBounds =
      placement.mode === 'parent-centered' ? sources.getParentBounds(placement.parentId) : undefined;

    const result = computePlacement({
      placement,
      currentBounds: win.bounds,
      windowSize: { width: win.bounds.width, height: win.bounds.height },
      displays,
      primaryDisplayId,
      parentBounds,
    });

    if (result.kind !== 'reposition') continue;

    decisions.push({
      id,
      bounds: result.bounds,
      from: win.bounds,
      label: win.label,
      nativeId: win.nativeId,
      mode: placement.mode,
    });
  }

  return decisions;
}
