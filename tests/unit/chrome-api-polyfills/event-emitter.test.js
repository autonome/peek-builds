import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'backend', 'electron', 'chrome-api-polyfills', '_event-emitter.js');

const { createChromeEvent } = await import(modulePath);

describe('createChromeEvent', () => {
  it('creates an event with the Chrome API shape', () => {
    const event = createChromeEvent();
    assert.equal(typeof event.addListener, 'function');
    assert.equal(typeof event.removeListener, 'function');
    assert.equal(typeof event.hasListener, 'function');
    assert.equal(typeof event.hasListeners, 'function');
    assert.equal(typeof event._fire, 'function');
  });

  it('addListener registers a callback', () => {
    const event = createChromeEvent();
    const cb = () => {};
    event.addListener(cb);
    assert.equal(event.hasListener(cb), true);
    assert.equal(event.hasListeners(), true);
  });

  it('addListener throws for non-function', () => {
    const event = createChromeEvent();
    assert.throws(() => event.addListener('not a function'), { name: 'TypeError' });
  });

  it('removeListener unregisters a callback', () => {
    const event = createChromeEvent();
    const cb = () => {};
    event.addListener(cb);
    event.removeListener(cb);
    assert.equal(event.hasListener(cb), false);
    assert.equal(event.hasListeners(), false);
  });

  it('removeListener is a no-op for unknown callback', () => {
    const event = createChromeEvent();
    event.removeListener(() => {}); // Should not throw
    assert.equal(event.hasListeners(), false);
  });

  it('_fire calls all listeners with arguments', () => {
    const event = createChromeEvent();
    const calls = [];
    event.addListener((...args) => calls.push(args));
    event.addListener((...args) => calls.push(args));

    event._fire('hello', 42);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['hello', 42]);
    assert.deepEqual(calls[1], ['hello', 42]);
  });

  it('_fire catches listener errors without propagating', () => {
    const event = createChromeEvent();
    const calls = [];

    event.addListener(() => { throw new Error('boom'); });
    event.addListener((...args) => calls.push(args));

    // Should not throw
    event._fire('data');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['data']);
  });

  it('hasListeners returns false when empty', () => {
    const event = createChromeEvent();
    assert.equal(event.hasListeners(), false);
  });

  it('_listeners exposes the internal Set', () => {
    const event = createChromeEvent();
    const cb = () => {};
    event.addListener(cb);
    assert.equal(event._listeners.size, 1);
    assert.equal(event._listeners.has(cb), true);
  });
});
