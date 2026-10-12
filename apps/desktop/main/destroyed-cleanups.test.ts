/**
 * Unit tests for `destroyed-cleanups.ts` — teardown steps for one WebContents
 * share a single `destroyed` listener, so adding steps never pushes the
 * WebContents toward Node's MaxListeners limit.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { destroyedCleanups } from './destroyed-cleanups.js';

describe('destroyedCleanups', () => {
  it('registers no listener until a step is added', () => {
    const wc = new EventEmitter();
    destroyedCleanups(wc);
    assert.strictEqual(wc.listenerCount('destroyed'), 0);
  });

  it('adds exactly one destroyed listener however many steps are added', () => {
    const wc = new EventEmitter();
    const add = destroyedCleanups(wc);
    for (let i = 0; i < 20; i++) add(() => {});
    assert.strictEqual(wc.listenerCount('destroyed'), 1);
  });

  it('runs every step once, in the order added, when destroyed fires', () => {
    const wc = new EventEmitter();
    const add = destroyedCleanups(wc);
    const order: number[] = [];
    add(() => order.push(1));
    add(() => order.push(2));
    add(() => order.push(3));
    wc.emit('destroyed');
    wc.emit('destroyed');
    assert.deepStrictEqual(order, [1, 2, 3]);
    assert.strictEqual(wc.listenerCount('destroyed'), 0);
  });

  it('a step that throws does not stop the steps after it', () => {
    const wc = new EventEmitter();
    const add = destroyedCleanups(wc);
    const ran: string[] = [];
    const origError = console.error;
    console.error = () => {};
    try {
      add(() => { throw new Error('boom'); });
      add(() => ran.push('after'));
      wc.emit('destroyed');
    } finally {
      console.error = origError;
    }
    assert.deepStrictEqual(ran, ['after']);
  });
});
