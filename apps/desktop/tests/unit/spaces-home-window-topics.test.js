/**
 * The Spaces page shows a window count on each space card. home.js is a
 * peek:// page that cannot load under node, so this reads its live-query
 * topic list from source: a window opening or closing must re-run the count,
 * and the manifest must allow the page to subscribe to those topics.
 *
 * Run via: node --test tests/unit/spaces-home-window-topics.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '..', 'features', 'spaces');

const liveQueryTopics = () => {
  const src = readFileSync(join(dir, 'home.js'), 'utf8');
  const block = src.match(/liveQuery\(\{[\s\S]*?topics:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'home.js calls liveQuery with a topics list');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe('Spaces page window counts', () => {
  it('re-run when a window opens or closes', () => {
    const topics = liveQueryTopics();
    assert.ok(topics.includes('window:opened'));
    assert.ok(topics.includes('window:closed'));
  });

  it('are allowed by the manifest to subscribe to those topics', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const text = JSON.stringify(manifest);
    assert.ok(text.includes('window:opened'));
    assert.ok(text.includes('window:closed'));
  });
});
