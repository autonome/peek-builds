// Window cycling (cmd+` / cmd+shift+`): which content window a press moves to. Pure reads of the
// kernel snapshot, so the choice is testable without a window. window-machine.ts
// cycleContentWindow() issues the raise.
import { isContentWindow, onCurrentDesktop, type State, type WindowId } from './window-kernel.js';

export type CycleDirection = 'forward' | 'reverse';

// The windows a cycle press can land on: on-screen content windows on a current desktop. In OPEN
// order, not stack order: raising a window reorders the stack, so walking the stack would send
// repeated forward presses back and forth between the two most recent windows. Open order does
// not move when a window is raised, so every window is visited once per lap.
export function cyclableWindowIds(state: State): WindowId[] {
  return state.order
    .filter((r) => isContentWindow(r) && r.transient !== true && onCurrentDesktop(state, r))
    .slice()
    .sort((a, b) => a.openSeq - b.openSeq)
    .map((r) => r.id);
}

// The neighbour of `currentId` in `ids`, wrapping at both ends; forward and reverse are exact
// inverses. A current window not in the list starts the walk at the first (forward) or last
// (reverse) window. Null when there is no other window to move to.
export function cycleTarget(ids: readonly WindowId[], currentId: WindowId | null, direction: CycleDirection): WindowId | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  let target: WindowId;
  if (at === -1) {
    target = direction === 'forward' ? ids[0] : ids[ids.length - 1];
  } else {
    const step = direction === 'forward' ? 1 : -1;
    target = ids[(at + step + ids.length) % ids.length];
  }
  return target === currentId ? null : target;
}
