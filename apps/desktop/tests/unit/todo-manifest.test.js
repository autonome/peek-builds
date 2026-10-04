/**
 * The todo feature's manifest must parse, declare its three commands, and
 * allow every `cmd:execute:*` topic background.js subscribes to (the IPC gate
 * silently drops subscriptions whose topic is not in the manifest).
 *
 * Run via: node --test tests/unit/todo-manifest.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '..', 'features', 'todo');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
const background = readFileSync(join(dir, 'background.js'), 'utf-8');

describe('todo manifest', () => {
  it('declares the todo, todos and done commands', () => {
    assert.equal(manifest.id, 'todo');
    assert.deepEqual(manifest.commands.map((c) => c.name), ['todo', 'todos', 'done']);
  });

  it('allows every cmd:execute topic background.js subscribes to', () => {
    const subscribed = [...background.matchAll(/subscribe\(\s*'(cmd:execute:[^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(subscribed.sort(), ['cmd:execute:done', 'cmd:execute:todo', 'cmd:execute:todos']);
    const allowed = manifest.capabilities.pubsub.topics;
    for (const topic of subscribed) {
      assert.ok(allowed.includes(topic), `${topic} missing from capabilities.pubsub.topics`);
    }
  });

  it('has a lazy background tile whose url exists', () => {
    const tile = manifest.tiles.find((t) => t.id === 'background');
    assert.ok(tile, 'background tile declared');
    assert.equal(tile.lazy, true);
    readFileSync(join(dir, tile.url));
  });
});
