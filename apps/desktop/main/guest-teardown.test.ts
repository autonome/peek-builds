/**
 * Unit tests for `guest-teardown.ts` — the bounded "destroy these guests and
 * wait until they are actually gone" helper.
 *
 * The behaviour under test is an ORDERING that a live quit got wrong: the
 * destroys were issued, `destroy()` returned without throwing, and every guest
 * was still alive when the caller moved on. So the assertions here are about
 * WHEN the returned promise resolves relative to the guests' own destruction —
 * not about the calls having been made.
 *
 * Fake WebContents, deliberately: real destruction timing is a Chromium
 * internal, and the point is the shape of the wait, which is platform-free.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  destroyGuestsAndWait,
  GUEST_DESTROY_TIMEOUT_MS,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';

/**
 * A guest that behaves like a real WebContents: `destroy()` returns
 * immediately with `isDestroyed()` STILL FALSE, and only a later turn flips the
 * flag and emits `'destroyed'`. That lag is the whole bug.
 */
class LaggyGuest implements TeardownGuest {
  destroyRequested = false;
  private destroyed = false;
  private listeners: Array<() => void> = [];

  constructor(private readonly delayMs = 0) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(_event: 'destroyed', listener: () => void): void {
    this.listeners.push(listener);
  }

  /** What the backend's `requestDestroy` callback does to this fake. */
  requestDestroy(): void {
    this.destroyRequested = true;
    setTimeout(() => {
      this.destroyed = true;
      for (const l of this.listeners.splice(0)) l();
    }, this.delayMs);
  }
}

/** A guest whose renderer is wedged: destruction is requested and never lands. */
class WedgedGuest implements TeardownGuest {
  destroyRequested = false;
  isDestroyed(): boolean {
    return false;
  }
  once(_event: 'destroyed', _listener: () => void): void {
    /* never emits */
  }
  requestDestroy(): void {
    this.destroyRequested = true;
  }
}

/** An already-gone guest: nothing to destroy, nothing to wait for. */
class DeadGuest implements TeardownGuest {
  destroyRequested = false;
  isDestroyed(): boolean {
    return true;
  }
  once(_event: 'destroyed', _listener: () => void): void {
    throw new Error('once() on a destroyed wc');
  }
  requestDestroy(): void {
    this.destroyRequested = true;
  }
}

type Fake = LaggyGuest | WedgedGuest | DeadGuest;
const destroyFake = (g: TeardownGuest): void => (g as Fake).requestDestroy();

describe('destroyGuestsAndWait — the wait is real', () => {
  it('resolves only AFTER the guests report destroyed (not when destroy() returns)', async () => {
    const guests = [new LaggyGuest(1), new LaggyGuest(3), new LaggyGuest(0)];

    const wait = destroyGuestsAndWait(guests, destroyFake);

    // Synchronously after the call: destroy asked for, nothing gone yet. This
    // is exactly the state the old fire-and-forget quit proceeded from.
    assert.ok(guests.every((g) => g.destroyRequested), 'every guest was asked to destroy');
    assert.ok(guests.every((g) => !g.isDestroyed()), 'nothing is destroyed yet — destroy() is not synchronous');

    await wait;

    assert.ok(guests.every((g) => g.isDestroyed()), 'all guests destroyed by the time the wait resolves');
  });

  it('the caller\'s next step runs after the destruction, not before it', async () => {
    const order: string[] = [];
    const guest = new LaggyGuest(2);
    guest.once('destroyed', () => order.push('guest-destroyed'));

    await destroyGuestsAndWait([guest], (g) => {
      order.push('destroy-requested');
      destroyFake(g);
    });
    order.push('host-closed');

    assert.deepStrictEqual(order, ['destroy-requested', 'guest-destroyed', 'host-closed']);
  });

  it('an already-destroyed guest is a clean no-op (no destroy, no wait)', async () => {
    const dead = new DeadGuest();
    await destroyGuestsAndWait([dead], destroyFake);
    assert.strictEqual(dead.destroyRequested, false, 'a dead wc is not re-destroyed');
  });

  it('no guests resolves immediately', async () => {
    await destroyGuestsAndWait([], destroyFake);
  });
});

describe('destroyGuestsAndWait — the wait is bounded', () => {
  it('a guest that never destroys releases the caller at the per-guest cap', async () => {
    const wedged = new WedgedGuest();
    const started = Date.now();

    await destroyGuestsAndWait([wedged], destroyFake, { perGuestMs: 40 });

    const elapsed = Date.now() - started;
    assert.ok(wedged.destroyRequested, 'destruction was still requested');
    assert.strictEqual(wedged.isDestroyed(), false, 'and it still never landed');
    assert.ok(elapsed >= 35, `waited for the cap (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `but did not wait forever (${elapsed}ms)`);
  });

  it('the batch cap releases the caller even with the per-guest cap far away', async () => {
    const guests = [new WedgedGuest(), new WedgedGuest(), new LaggyGuest(1)];
    const started = Date.now();

    await destroyGuestsAndWait(guests, destroyFake, { perGuestMs: 60_000, overallMs: 40 });

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `bounded by the batch cap, not the per-guest cap (${elapsed}ms)`);
    assert.ok(elapsed >= 35, `and it did wait out the batch cap (${elapsed}ms)`);
  });

  it('a healthy batch is not slowed to the batch cap', async () => {
    const guests = [new LaggyGuest(1), new LaggyGuest(1)];
    const started = Date.now();

    await destroyGuestsAndWait(guests, destroyFake, { perGuestMs: 5000, overallMs: 5000 });

    assert.ok(Date.now() - started < 1000, 'resolves on the guests, not on the cap');
    assert.ok(guests.every((g) => g.isDestroyed()));
  });

  it('a guest that throws on destroy does not hold the batch open', async () => {
    const started = Date.now();
    await destroyGuestsAndWait([new WedgedGuest()], () => {
      throw new Error('wc gone between resolve and destroy');
    }, { perGuestMs: 60_000 });
    assert.ok(Date.now() - started < 1000, 'a failed destroy resolves its guest immediately');
  });

  it('the quit budget is well under a perceptible hang and under the per-guest cap', () => {
    assert.ok(QUIT_GUEST_TEARDOWN_BUDGET_MS <= GUEST_DESTROY_TIMEOUT_MS);
    assert.ok(QUIT_GUEST_TEARDOWN_BUDGET_MS >= 100, 'still generous against a ~7ms real teardown');
  });
});
