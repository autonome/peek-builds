import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'backend', 'electron', 'chrome-api-polyfills', 'index.js');

const { alarms, storageSession, webNavigation, offscreen } = await import(modulePath);

describe('chrome-api-polyfills index', () => {
  it('exports alarms module', () => {
    assert.equal(typeof alarms.setupMainProcess, 'function');
    assert.equal(typeof alarms.getPreloadScript, 'function');
  });

  it('exports storageSession module', () => {
    assert.equal(typeof storageSession.setupMainProcess, 'function');
    assert.equal(typeof storageSession.getPreloadScript, 'function');
  });

  it('exports webNavigation module', () => {
    assert.equal(typeof webNavigation.setupMainProcess, 'function');
    assert.equal(typeof webNavigation.getPreloadScript, 'function');
  });

  it('exports offscreen module', () => {
    assert.equal(typeof offscreen.setupMainProcess, 'function');
    assert.equal(typeof offscreen.getPreloadScript, 'function');
  });
});
