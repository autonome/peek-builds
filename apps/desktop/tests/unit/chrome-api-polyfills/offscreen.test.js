import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'backend', 'electron', 'chrome-api-polyfills', 'offscreen.js');

const { getPreloadScript } = await import(modulePath);

describe('chrome.offscreen polyfill', () => {
  describe('getPreloadScript', () => {
    it('returns a non-empty string', () => {
      const script = getPreloadScript();
      assert.ok(script.length > 100);
    });

    it('contains all API methods', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('createDocument'));
      assert.ok(script.includes('closeDocument'));
      assert.ok(script.includes('hasDocument'));
    });

    it('contains Reason enum values', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('CLIPBOARD'));
      assert.ok(script.includes('DOM_PARSER'));
      assert.ok(script.includes('AUDIO_PLAYBACK'));
      assert.ok(script.includes('TESTING'));
      assert.ok(script.includes('WORKERS'));
      assert.ok(script.includes('WEB_RTC'));
    });

    it('references the correct IPC channels', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome-polyfill:offscreen:createDocument'));
      assert.ok(script.includes('chrome-polyfill:offscreen:closeDocument'));
      assert.ok(script.includes('chrome-polyfill:offscreen:hasDocument'));
    });

    it('injects into chrome.offscreen', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome.offscreen'));
    });
  });
});
