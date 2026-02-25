import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'lib', 'chrome-api-polyfills', 'web-navigation.js');

const { getPreloadScript } = await import(modulePath);

describe('chrome.webNavigation polyfill', () => {
  describe('getPreloadScript', () => {
    it('returns a non-empty string', () => {
      const script = getPreloadScript();
      assert.ok(script.length > 100);
    });

    it('contains all navigation event names', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('onBeforeNavigate'));
      assert.ok(script.includes('onCommitted'));
      assert.ok(script.includes('onCompleted'));
      assert.ok(script.includes('onDOMContentLoaded'));
      assert.ok(script.includes('onErrorOccurred'));
    });

    it('contains getFrame and getAllFrames methods', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('getFrame'));
      assert.ok(script.includes('getAllFrames'));
    });

    it('contains URL filter support', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('hostContains'));
      assert.ok(script.includes('hostEquals'));
      assert.ok(script.includes('urlMatches'));
      assert.ok(script.includes('urlContains'));
    });

    it('references the correct IPC channels', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome-polyfill:webNavigation:getFrame'));
      assert.ok(script.includes('chrome-polyfill:webNavigation:getAllFrames'));
    });

    it('injects into chrome.webNavigation', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome.webNavigation'));
    });
  });
});
