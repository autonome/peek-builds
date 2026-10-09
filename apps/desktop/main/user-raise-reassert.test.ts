import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { UserRaiseReassert, type ReassertTimers } from './user-raise-reassert.js';

// Manual clock: timers fire in due-time order as `advance` moves time forward.
function fakeClock(): { timers: ReassertTimers; advance(ms: number): void } {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { due: number; fn: () => void }>();
  return {
    timers: {
      set: (fn, ms) => {
        const handle = nextHandle++;
        pending.set(handle, { due: now + ms, fn });
        return handle;
      },
      clear: (handle) => {
        pending.delete(handle as number);
      },
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let next: [number, { due: number; fn: () => void }] | null = null;
        for (const entry of pending) {
          if (entry[1].due <= target && (next === null || entry[1].due < next[1].due)) next = entry;
        }
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
      now = target;
    },
  };
}

describe('UserRaiseReassert', () => {
  it('re-asserts a lone user raise at each delay', () => {
    const clock = fakeClock();
    const reassert = new UserRaiseReassert<string>(clock.timers);
    const fired: string[] = [];
    reassert.arm('wm-3', 1, [250, 600], (id) => fired.push(id));
    clock.advance(700);
    assert.deepStrictEqual(fired, ['wm-3', 'wm-3']);
  });

  it('a newer user raise of another window cancels the earlier raise\'s pending re-asserts', () => {
    const clock = fakeClock();
    const reassert = new UserRaiseReassert<string>(clock.timers);
    const fired: string[] = [];
    const fire = (id: string): void => {
      fired.push(id);
    };
    reassert.arm('wm-3', 1, [250, 600], fire);
    clock.advance(500);
    fired.length = 0;
    reassert.arm('wm-4', 2, [250, 600], fire);
    clock.advance(700);
    assert.deepStrictEqual(fired, ['wm-4', 'wm-4'], 'wm-3 is not re-raised over wm-4');
  });

  it('cancel drops every pending re-assert', () => {
    const clock = fakeClock();
    const reassert = new UserRaiseReassert<string>(clock.timers);
    const fired: string[] = [];
    reassert.arm('wm-3', 1, [250, 600], (id) => fired.push(id));
    reassert.cancel();
    clock.advance(700);
    assert.deepStrictEqual(fired, []);
  });
});
