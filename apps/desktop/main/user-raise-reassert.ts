// Bookkeeping for the delayed re-asserts that follow a user-intended raise.
// The backend arms one after activating the app, since macOS can hand key to
// the previously key window once activation settles. Only the newest user
// raise may re-assert: an earlier one firing after a later raise would pull
// its window back to the front over the one the user just chose.

export interface ReassertTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ReassertTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class UserRaiseReassert<Id> {
  private handles: unknown[] = [];

  constructor(private readonly timers: ReassertTimers = realTimers) {}

  arm(id: Id, opSeq: number, delaysMs: number[], fire: (id: Id, opSeq: number) => void): void {
    for (const delayMs of delaysMs) {
      this.handles.push(this.timers.set(() => fire(id, opSeq), delayMs));
    }
  }

  cancel(): void {
    for (const handle of this.handles) this.timers.clear(handle);
    this.handles = [];
  }
}
