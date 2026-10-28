import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  onSystemResume, notifySystemResume, __resetSystemResumeForTest,
} from './system-resume.js';

describe('system-resume', () => {
  afterEach(() => __resetSystemResumeForTest());

  it('notifies every listener on each resume', () => {
    const calls: string[] = [];
    onSystemResume(() => calls.push('first'));
    onSystemResume(() => calls.push('second'));
    notifySystemResume();
    notifySystemResume();
    assert.deepStrictEqual(calls, ['first', 'second', 'first', 'second']);
  });

  it('does not notify an unsubscribed listener', () => {
    let calls = 0;
    const unsubscribe = onSystemResume(() => calls++);
    unsubscribe();
    unsubscribe();
    notifySystemResume();
    assert.strictEqual(calls, 0);
  });

  it('logs a throwing listener and continues to the next listener', (t) => {
    const error = new Error('resume listener failed');
    const log = t.mock.method(console, 'error', (..._args: unknown[]) => {});
    let calls = 0;
    onSystemResume(() => { throw error; });
    onSystemResume(() => calls++);
    assert.doesNotThrow(() => notifySystemResume());
    assert.strictEqual(calls, 1);
    assert.strictEqual(log.mock.callCount(), 1);
    assert.ok(log.mock.calls[0].arguments.includes(error));
  });

  it('resets all listeners for tests', () => {
    let calls = 0;
    onSystemResume(() => calls++);
    __resetSystemResumeForTest();
    notifySystemResume();
    assert.strictEqual(calls, 0);
  });
});
