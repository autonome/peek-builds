/**
 * Two switch commands that arrive together must not interleave: the second
 * would save the still-recorded active space while the first has already
 * closed its windows, overwriting that space's saved windows with an empty
 * list. Switches run one at a time.
 *
 * Run via: node --test tests/unit/spaces-switch-serialized.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { createSerialRunner } = await import(modulePath);

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('createSerialRunner', () => {
  it('does not start a call until the previous one has finished', async () => {
    const run = createSerialRunner();
    const events = [];
    const job = (name) => async () => {
      events.push(`start ${name}`);
      await tick();
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([run(job('a')), run(job('b'))]);
    assert.deepEqual(results, ['a', 'b']);
    assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps running later calls after one throws', async () => {
    const run = createSerialRunner();
    const failing = run(async () => { throw new Error('boom'); });
    const after = run(async () => 'ok');
    await assert.rejects(failing, /boom/);
    assert.equal(await after, 'ok');
  });
});
