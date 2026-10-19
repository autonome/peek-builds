// Hold-to-drag window move: the pure state machine (docs/design/window-drag.md).
//
// Press, hold still for the hold delay, then move: the target window follows
// the pointer. No timers, no platform calls — the runtime
// (window-drag-runtime.ts) runs the hold timer and executes the effects.

export interface DragPoint { x: number; y: number }
export interface DragRect { x: number; y: number; width: number; height: number }

// Pointer movement allowed while the hold runs before the press stops being a
// drag candidate (so a click, a text selection or a link drag proceeds).
export const HOLD_TOLERANCE_PX = 5;
// Movement after the hold elapses before the window starts following.
export const MOVE_THRESHOLD_PX = 3;

export type DragState<Id> =
  | { phase: 'idle' }
  | { phase: 'pending'; source: Id; target: Id; press: DragPoint }
  | { phase: 'ready'; source: Id; target: Id; press: DragPoint; startBounds: DragRect }
  | { phase: 'dragging'; source: Id; target: Id; press: DragPoint; startBounds: DragRect };

export type DragEvent<Id> =
  // A left press landed in `source`. `target` is the window it would move, or
  // null when no window can be moved by this press.
  | { type: 'press'; source: Id; target: Id | null; x: number; y: number; holdMs: number }
  // The hold timer fired. `bounds` is the target's rect now, or null when the
  // target can no longer be moved (maximized, hidden, gone).
  | { type: 'holdElapsed'; bounds: DragRect | null }
  // `buttonHeld` false: the platform reports no button down; null: unknown.
  | { type: 'move'; x: number; y: number; buttonHeld: boolean | null }
  | { type: 'release' }
  // The press in `source` is not a drag (a renderer blocker, or another
  // gesture that owns the press).
  | { type: 'veto'; source: Id }
  | { type: 'windowGone'; id: Id };

export type DragCursor = 'grab' | 'grabbing' | null;

export type DragEffect<Id> =
  | { type: 'startHoldTimer'; ms: number }
  | { type: 'stopHoldTimer' }
  | { type: 'indicator'; ids: Id[]; cursor: DragCursor }
  | { type: 'setBounds'; id: Id; bounds: DragRect }
  | { type: 'dragActive'; active: boolean };

export interface DragStep<Id> {
  state: DragState<Id>;
  effects: DragEffect<Id>[];
}

const IDLE = { phase: 'idle' } as const;

function indicatorIds<Id>(s: { source: Id; target: Id }): Id[] {
  return s.source === s.target ? [s.source] : [s.source, s.target];
}

// The effects that take any state back to idle.
function endEffects<Id>(state: DragState<Id>): DragEffect<Id>[] {
  switch (state.phase) {
    case 'idle':
      return [];
    case 'pending':
      return [{ type: 'stopHoldTimer' }];
    case 'ready':
      return [{ type: 'indicator', ids: indicatorIds(state), cursor: null }];
    case 'dragging':
      return [
        { type: 'indicator', ids: indicatorIds(state), cursor: null },
        { type: 'dragActive', active: false },
      ];
  }
}

function end<Id>(state: DragState<Id>): DragStep<Id> {
  return { state: IDLE, effects: endEffects(state) };
}

function moved(from: DragPoint, x: number, y: number, by: number): boolean {
  return Math.abs(x - from.x) > by || Math.abs(y - from.y) > by;
}

function followRect(s: { press: DragPoint; startBounds: DragRect }, x: number, y: number): DragRect {
  return {
    x: Math.round(s.startBounds.x + (x - s.press.x)),
    y: Math.round(s.startBounds.y + (y - s.press.y)),
    width: s.startBounds.width,
    height: s.startBounds.height,
  };
}

export function stepWindowDrag<Id>(state: DragState<Id>, event: DragEvent<Id>): DragStep<Id> {
  switch (event.type) {
    case 'press': {
      // A press ends whatever came before it: the release that should have
      // ended it may have been delivered to another window.
      const effects = endEffects(state);
      if (event.target === null) return { state: IDLE, effects };
      effects.push({ type: 'startHoldTimer', ms: Math.max(0, event.holdMs) });
      return {
        state: { phase: 'pending', source: event.source, target: event.target, press: { x: event.x, y: event.y } },
        effects,
      };
    }

    case 'holdElapsed': {
      if (state.phase !== 'pending') return { state, effects: [] };
      if (event.bounds === null) return { state: IDLE, effects: [] };
      const next: DragState<Id> = { ...state, phase: 'ready', startBounds: { ...event.bounds } };
      return { state: next, effects: [{ type: 'indicator', ids: indicatorIds(next), cursor: 'grab' }] };
    }

    case 'move': {
      if (state.phase === 'idle') return { state, effects: [] };
      if (state.phase === 'pending') {
        // A buttonless move while the hold runs is the platform re-reporting a
        // still pointer after a window frame moved under it, not a release.
        if (event.buttonHeld === false) return { state, effects: [] };
        if (moved(state.press, event.x, event.y, HOLD_TOLERANCE_PX)) return end(state);
        return { state, effects: [] };
      }
      // Once the hold has elapsed, a buttonless move is a release that landed
      // somewhere this stream never saw.
      if (event.buttonHeld === false) return end(state);
      if (state.phase === 'ready') {
        if (!moved(state.press, event.x, event.y, MOVE_THRESHOLD_PX)) return { state, effects: [] };
        const next: DragState<Id> = { ...state, phase: 'dragging' };
        return {
          state: next,
          effects: [
            { type: 'indicator', ids: indicatorIds(next), cursor: 'grabbing' },
            { type: 'dragActive', active: true },
            { type: 'setBounds', id: next.target, bounds: followRect(next, event.x, event.y) },
          ],
        };
      }
      return { state, effects: [{ type: 'setBounds', id: state.target, bounds: followRect(state, event.x, event.y) }] };
    }

    case 'release':
      return end(state);

    case 'veto':
      if ((state.phase === 'pending' || state.phase === 'ready') && state.source === event.source) return end(state);
      return { state, effects: [] };

    case 'windowGone':
      if (state.phase !== 'idle' && (state.source === event.id || state.target === event.id)) return end(state);
      return { state, effects: [] };
  }
}

export function initialDragState<Id>(): DragState<Id> {
  return IDLE;
}
