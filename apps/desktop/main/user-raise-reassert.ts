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
  private targetId: Id | null = null;

  constructor(private readonly timers: ReassertTimers = realTimers) {}

  // Replaces whatever was pending: there is one pending re-assert at a time.
  arm(id: Id, opSeq: number, delaysMs: number[], fire: (id: Id, opSeq: number, delayMs: number) => void): void {
    this.cancel();
    this.targetId = id;
    for (const delayMs of delaysMs) {
      this.handles.push(this.timers.set(() => fire(id, opSeq, delayMs), delayMs));
    }
  }

  // Drops the pending re-assert only if it targets `id` (the window closed).
  cancelFor(id: Id): void {
    if (this.targetId === id) this.cancel();
  }

  cancel(): void {
    this.targetId = null;
    for (const handle of this.handles) this.timers.clear(handle);
    this.handles = [];
  }
}
