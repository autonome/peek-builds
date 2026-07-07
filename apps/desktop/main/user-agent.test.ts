/**
 * Unit tests for the User-Agent helper.
 *
 * Imports the REAL implementation (user-agent.ts is a leaf module with no
 * electron imports, so it loads under `ELECTRON_RUN_AS_NODE=1`) — no mirrored
 * copy to drift out of sync.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { toChromeUserAgent } from './user-agent.js';

// The REAL default `app.userAgentFallback` a named Electron app produces on
// macOS (Electron 43 / Chromium 150): the app product token `Peek/0.0.1` sits
// BEFORE the Chrome token, and an `Electron/43.0.0` token trails it. This is the
// exact string the app normalizes at boot — and the `Peek/0.0.1` token is what
// broke WhatsApp Web (peek 080fd433).
const PEEK_DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Peek/0.0.1 Chrome/150.0.7871.46 Electron/43.0.0 Safari/537.36';
const CLEAN_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.46 Safari/537.36';

describe('toChromeUserAgent', () => {
  it('normalizes the real Peek default UA to a clean stock-Chrome UA', () => {
    assert.strictEqual(toChromeUserAgent(PEEK_DEFAULT_UA), CLEAN_CHROME_UA);
  });

  it('removes the leading app product token (Peek/<version>) — the WhatsApp offender', () => {
    assert.ok(!/Peek\//.test(toChromeUserAgent(PEEK_DEFAULT_UA)));
  });

  it('leaves no "Electron" tell in the result', () => {
    assert.ok(!/Electron/i.test(toChromeUserAgent(PEEK_DEFAULT_UA)));
  });

  it('keeps the live Chrome/<version> token intact (so it tracks Chromium upgrades)', () => {
    assert.match(toChromeUserAgent(PEEK_DEFAULT_UA), /Chrome\/150\.0\.7871\.46/);
  });

  it('is generic — strips a different app name + Electron version too (not hardcoded)', () => {
    const future =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/9.9.9 Chrome/160.0.0.0 Electron/50.1.2 Safari/537.36';
    assert.strictEqual(
      toChromeUserAgent(future),
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/160.0.0.0 Safari/537.36',
    );
  });

  it('strips a trailing Electron token even when there is no app token', () => {
    const noApp =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.46 Electron/43.0.0 Safari/537.36';
    assert.strictEqual(toChromeUserAgent(noApp), CLEAN_CHROME_UA);
  });

  it('is a no-op on a UA that is already clean stock Chrome', () => {
    assert.strictEqual(toChromeUserAgent(CLEAN_CHROME_UA), CLEAN_CHROME_UA);
  });
});
