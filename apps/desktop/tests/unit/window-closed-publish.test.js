/**
 * Space window counts drop when a window closes only if `window:closed`
 * reaches subscribers for every kind of window, after the window has left the
 * registry and its context entries are gone. main.ts cannot load under node, so
 * this reads the close tail from source: a hybrid page-host (a BaseWindow)
 * finalizes through `finalizeWindowClose` and never through the BrowserWindow
 * drain, so the publish has to live in `finalizeWindowClose`, after the
 * registry and context cleanup.
 *
 * Run via: node --test tests/unit/window-closed-publish.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', '..', 'main', 'main.ts'), 'utf8');

const functionBody = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.ts defines ${name}`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport function ', start + 1);
  const ends = [next, nextExport].filter((i) => i > start);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
};

describe('window:closed publish', () => {
  it('is made by finalizeWindowClose, which every window kind finalizes through', () => {
    assert.match(functionBody('finalizeWindowClose'), /'window:closed'/);
  });

  it('is not made by the BrowserWindow-only drain', () => {
    assert.doesNotMatch(functionBody('drainWindowClose'), /'window:closed'/);
  });

  it('follows the registry removal and the context cleanup', () => {
    const body = functionBody('finalizeWindowClose');
    const published = body.indexOf("'window:closed'");
    assert.ok(published > body.indexOf('removeWindowOpenPayload(wmId)'));
    assert.ok(published > body.indexOf('cleanupWindowContext(windowId)'));
  });
});
