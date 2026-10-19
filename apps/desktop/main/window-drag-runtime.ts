// Hold-to-drag window move: the runtime around the pure state machine
// (window-drag.ts, docs/design/window-drag.md). Holds the one live gesture —
// there is one pointer — runs the hold timer, and executes effects through
// injected deps, so nothing here names a platform.

import { stepWindowDrag, initialDragState } from './window-drag.js';
import type { DragCursor, DragEffect, DragEvent, DragRect, DragState } from './window-drag.js';
import { windowById } from './window-kernel.js';
import type { State, WindowId } from './window-kernel.js';

export interface WindowDragDeps {
  // The window a press landing in `source` moves, or null when none can.
  resolveTarget(source: WindowId): WindowId | null;
  // `target`'s current rect when it can still be moved, else null.
  movableBounds(target: WindowId): DragRect | null;
  holdMs(): number;
  setBounds(id: WindowId, bounds: DragRect): void;
  paintIndicator(id: WindowId, cursor: DragCursor): void;
  announceActive(active: boolean): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

// A pointer event as the backend reports it, in screen coordinates.
export type WindowPointerEvent =
  | { type: 'press'; x: number; y: number }
  | { type: 'move'; x: number; y: number; buttonHeld: boolean | null }
  | { type: 'release' };

// The target a press in `source` moves: the window it is chrome for, else
// itself. Null when that window cannot be moved right now.
export function resolveDragTarget(state: State, source: WindowId): WindowId | null {
  const record = windowById(state, source);
  if (!record) return null;
  // Until the tile windows move to this path, only page hosts and their chrome arm here.
  if (record.kind !== 'page-host' && record.overlayFor === undefined) return null;
  const targetId = record.overlayFor ?? source;
  return movableRecord(state, targetId) ? targetId : null;
}

export function movableRecord(state: State, id: WindowId): boolean {
  const record = windowById(state, id);
  return !!record && record.visible && record.pendingHidden !== true && !record.maximized && record.fsMode.name === 'normal';
}

let deps: WindowDragDeps | null = null;
let state: DragState<WindowId> = initialDragState();
let holdTimer: unknown = null;
// Presses another gesture claimed before this runtime saw them. Cleared at the
// end of the current task, so the claim covers only the press being dispatched.
const preClaimed = new Set<WindowId>();

export function initWindowDrag(next: WindowDragDeps): void {
  deps = next;
}

export function _resetWindowDragForTests(): void {
  if (holdTimer !== null && deps) clearTimer(holdTimer);
  deps = null;
  state = initialDragState();
  holdTimer = null;
  preClaimed.clear();
}

export function _windowDragStateForTests(): DragState<WindowId> {
  return state;
}

function setTimer(fn: () => void, ms: number): unknown {
  return deps?.setTimer ? deps.setTimer(fn, ms) : setTimeout(fn, ms);
}

function clearTimer(handle: unknown): void {
  if (deps?.clearTimer) deps.clearTimer(handle);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function dispatch(event: DragEvent<WindowId>): void {
  if (!deps) return;
  const step = stepWindowDrag(state, event);
  state = step.state;
  for (const effect of step.effects) run(effect);
}

function run(effect: DragEffect<WindowId>): void {
  const d = deps;
  if (!d) return;
  try {
    switch (effect.type) {
      case 'startHoldTimer':
        if (holdTimer !== null) clearTimer(holdTimer);
        holdTimer = setTimer(onHoldElapsed, effect.ms);
        break;
      case 'stopHoldTimer':
        if (holdTimer !== null) clearTimer(holdTimer);
        holdTimer = null;
        break;
      case 'indicator':
        for (const id of effect.ids) d.paintIndicator(id, effect.cursor);
        break;
      case 'setBounds':
        d.setBounds(effect.id, effect.bounds);
        break;
      case 'dragActive':
        d.announceActive(effect.active);
        break;
    }
  } catch {
    /* a window gone mid-effect ends nothing else */
  }
}

function onHoldElapsed(): void {
  holdTimer = null;
  if (!deps || state.phase !== 'pending') return;
  dispatch({ type: 'holdElapsed', bounds: deps.movableBounds(state.target) });
}

export function windowDragPointer(source: WindowId, event: WindowPointerEvent): void {
  if (!deps) return;
  if (event.type === 'press') {
    const target = preClaimed.has(source) ? null : deps.resolveTarget(source);
    dispatch({ type: 'press', source, target, x: event.x, y: event.y, holdMs: deps.holdMs() });
    return;
  }
  // Moves and releases from a window other than the one the press landed in
  // belong to no gesture this runtime holds.
  if (state.phase === 'idle' || state.source !== source) return;
  dispatch(event.type === 'move' ? event : { type: 'release' });
}

// The renderer of `source` judged the current press not draggable.
export function windowDragVeto(source: WindowId): void {
  dispatch({ type: 'veto', source });
}

// Another gesture owns the press landing in `source` (an edge resize). Works
// whichever of the two input listeners runs first for the same press.
export function claimWindowPress(source: WindowId): void {
  dispatch({ type: 'veto', source });
  if (preClaimed.has(source)) return;
  preClaimed.add(source);
  queueMicrotask(() => preClaimed.delete(source));
}

export function windowDragWindowClosed(id: WindowId): void {
  dispatch({ type: 'windowGone', id });
}
