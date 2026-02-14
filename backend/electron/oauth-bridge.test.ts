/**
 * Unit tests for OAuth popup bridge feature
 *
 * Tests extracted pure functions from:
 * - app/page/page.js: isOAuthUrl (OAuth URL detection)
 * - backend/electron/ipc.ts: popup-to-opener bridge logic (popupToOpener Map,
 *   opener-postmessage, opener-close, opener-focus handler logic)
 *
 * These are logic-only tests -- no DOM, no Electron, no IPC runtime.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// isOAuthUrl (from app/page/page.js)
// ============================================================================

const OAUTH_DOMAINS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'auth0.com',
  'appleid.apple.com',
];

const OAUTH_PATH_PATTERNS = [
  '/oauth/',
  '/authorize',
  '/auth/',
  '/login/oauth',
  '/oauth2/',
  '/connect/authorize',
  '/o/oauth2/',
];

function isOAuthUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Check domain-based patterns
    for (const domain of OAUTH_DOMAINS) {
      if (parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    // Check path-based patterns
    const lowerPath = parsed.pathname.toLowerCase();
    for (const pattern of OAUTH_PATH_PATTERNS) {
      if (lowerPath.includes(pattern)) {
        return true;
      }
    }
  } catch (e) {
    // Invalid URL, not OAuth
  }
  return false;
}

// ============================================================================
// Popup-to-Opener bridge logic (from backend/electron/ipc.ts)
// ============================================================================
// The IPC handlers in ipc.ts use a popupToOpener Map<number, number> and
// BrowserWindow lookups. Here we extract the pure mapping/lookup logic into
// testable functions that mirror the handler behavior without Electron deps.

interface BridgeResult {
  success: boolean;
  error?: string;
}

interface MockWindow {
  id: number;
  destroyed: boolean;
  shown: boolean;
  focused: boolean;
  closed: boolean;
  sentMessages: Array<{ channel: string; data: { message: unknown; origin: string; popupWindowId: number } }>;
}

/**
 * Simulates the opener-postmessage handler logic.
 */
function handleOpenerPostMessage(
  popupToOpener: Map<number, number>,
  senderWinId: number | null,
  windows: Map<number, MockWindow>,
  data: { message: unknown; origin?: string },
): BridgeResult {
  if (senderWinId === null) return { success: false, error: 'No sender window' };

  const openerWindowId = popupToOpener.get(senderWinId);
  if (openerWindowId === undefined) {
    return { success: false, error: 'No opener window mapped' };
  }

  const openerWin = windows.get(openerWindowId);
  if (!openerWin || openerWin.destroyed) {
    popupToOpener.delete(senderWinId);
    return { success: false, error: 'Opener window not found' };
  }

  // Forward the message to the opener's renderer
  openerWin.sentMessages.push({
    channel: 'opener-message-received',
    data: {
      message: data.message,
      origin: data.origin || '*',
      popupWindowId: senderWinId,
    },
  });

  return { success: true };
}

/**
 * Simulates the opener-close handler logic.
 */
function handleOpenerClose(
  popupToOpener: Map<number, number>,
  senderWinId: number | null,
  windows: Map<number, MockWindow>,
  closeWindow: (id: number) => void,
): BridgeResult {
  if (senderWinId === null) return { success: false, error: 'No sender window' };

  const openerWindowId = popupToOpener.get(senderWinId);
  if (openerWindowId === undefined) return { success: false, error: 'No opener mapped' };

  const openerWin = windows.get(openerWindowId);
  if (!openerWin || openerWin.destroyed) {
    popupToOpener.delete(senderWinId);
    return { success: false, error: 'Opener window not found' };
  }

  closeWindow(openerWin.id);
  return { success: true };
}

/**
 * Simulates the opener-focus handler logic.
 */
function handleOpenerFocus(
  popupToOpener: Map<number, number>,
  senderWinId: number | null,
  windows: Map<number, MockWindow>,
): BridgeResult {
  if (senderWinId === null) return { success: false, error: 'No sender window' };

  const openerWindowId = popupToOpener.get(senderWinId);
  if (openerWindowId === undefined) return { success: false, error: 'No opener mapped' };

  const openerWin = windows.get(openerWindowId);
  if (!openerWin || openerWin.destroyed) {
    popupToOpener.delete(senderWinId);
    return { success: false, error: 'Opener window not found' };
  }

  openerWin.shown = true;
  openerWin.focused = true;
  return { success: true };
}

// ============================================================================
// Tests
// ============================================================================

// --- isOAuthUrl ---

describe('OAuth URL Detection -- isOAuthUrl', () => {
  describe('domain-based detection', () => {
    it('detects accounts.google.com', () => {
      assert.strictEqual(isOAuthUrl('https://accounts.google.com/o/oauth2/auth?client_id=123'), true);
    });

    it('detects login.microsoftonline.com', () => {
      assert.strictEqual(isOAuthUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), true);
    });

    it('detects auth0.com', () => {
      assert.strictEqual(isOAuthUrl('https://auth0.com/authorize?client_id=abc'), true);
    });

    it('detects appleid.apple.com', () => {
      assert.strictEqual(isOAuthUrl('https://appleid.apple.com/auth/authorize'), true);
    });

    it('detects subdomains of OAuth domains', () => {
      assert.strictEqual(isOAuthUrl('https://myapp.auth0.com/login'), true);
    });

    it('detects subdomains of appleid.apple.com', () => {
      assert.strictEqual(isOAuthUrl('https://signin.appleid.apple.com/auth'), true);
    });
  });

  describe('path-based detection', () => {
    it('detects /oauth/ path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/oauth/callback'), true);
    });

    it('detects /authorize path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/authorize?client_id=abc'), true);
    });

    it('detects /auth/ path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/auth/login'), true);
    });

    it('detects /login/oauth path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/login/oauth?state=xyz'), true);
    });

    it('detects /oauth2/ path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/oauth2/authorize'), true);
    });

    it('detects /connect/authorize path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/connect/authorize'), true);
    });

    it('detects /o/oauth2/ path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/o/oauth2/v2/auth'), true);
    });

    it('detects path patterns case-insensitively', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/OAuth/Callback'), true);
      assert.strictEqual(isOAuthUrl('https://example.com/AUTH/login'), true);
    });
  });

  describe('non-OAuth URLs', () => {
    it('returns false for regular websites', () => {
      assert.strictEqual(isOAuthUrl('https://www.google.com/search?q=test'), false);
    });

    it('returns false for GitHub', () => {
      assert.strictEqual(isOAuthUrl('https://github.com/user/repo'), false);
    });

    it('returns false for localhost', () => {
      assert.strictEqual(isOAuthUrl('http://localhost:3000/dashboard'), false);
    });

    it('returns false for pages with "auth" in query but not path', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/page?auth=true'), false);
    });

    it('returns false for URLs with "oauth" only in fragment', () => {
      assert.strictEqual(isOAuthUrl('https://example.com/page#oauth'), false);
    });

    it('returns false for plain domain that contains "auth" substring', () => {
      assert.strictEqual(isOAuthUrl('https://authentication-docs.example.com/'), false);
    });
  });

  describe('edge cases', () => {
    it('returns false for null', () => {
      assert.strictEqual(isOAuthUrl(null), false);
    });

    it('returns false for undefined', () => {
      assert.strictEqual(isOAuthUrl(undefined), false);
    });

    it('returns false for empty string', () => {
      assert.strictEqual(isOAuthUrl(''), false);
    });

    it('returns false for invalid URL', () => {
      assert.strictEqual(isOAuthUrl('not a url'), false);
    });

    it('returns false for URL with no protocol', () => {
      assert.strictEqual(isOAuthUrl('accounts.google.com'), false);
    });
  });
});

// --- Popup-to-Opener Bridge ---

describe('Popup-to-Opener Bridge -- popupToOpener Map', () => {
  let popupToOpener: Map<number, number>;
  let windows: Map<number, MockWindow>;

  function createWindow(id: number): MockWindow {
    const win: MockWindow = {
      id,
      destroyed: false,
      shown: false,
      focused: false,
      closed: false,
      sentMessages: [],
    };
    windows.set(id, win);
    return win;
  }

  beforeEach(() => {
    popupToOpener = new Map();
    windows = new Map();
  });

  describe('mapping lifecycle', () => {
    it('stores popup-to-opener mapping', () => {
      popupToOpener.set(100, 1);
      assert.strictEqual(popupToOpener.get(100), 1);
    });

    it('cleans up mapping on popup close', () => {
      popupToOpener.set(100, 1);
      // Simulates popupWin.on('closed', ...)
      popupToOpener.delete(100);
      assert.strictEqual(popupToOpener.has(100), false);
    });

    it('supports multiple popups from same opener', () => {
      popupToOpener.set(100, 1);
      popupToOpener.set(101, 1);
      assert.strictEqual(popupToOpener.get(100), 1);
      assert.strictEqual(popupToOpener.get(101), 1);
    });

    it('supports popups from different openers', () => {
      popupToOpener.set(100, 1);
      popupToOpener.set(200, 2);
      assert.strictEqual(popupToOpener.get(100), 1);
      assert.strictEqual(popupToOpener.get(200), 2);
    });
  });

  describe('opener-postmessage handler', () => {
    it('routes message from popup to opener', () => {
      createWindow(1);
      createWindow(100);
      popupToOpener.set(100, 1);

      const result = handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: { type: 'oauth-token', token: 'abc123' },
        origin: 'https://accounts.google.com',
      });

      assert.deepStrictEqual(result, { success: true });
      const openerWin = windows.get(1)!;
      assert.strictEqual(openerWin.sentMessages.length, 1);
      assert.deepStrictEqual(openerWin.sentMessages[0], {
        channel: 'opener-message-received',
        data: {
          message: { type: 'oauth-token', token: 'abc123' },
          origin: 'https://accounts.google.com',
          popupWindowId: 100,
        },
      });
    });

    it('defaults origin to * when not provided', () => {
      createWindow(1);
      createWindow(100);
      popupToOpener.set(100, 1);

      handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: 'hello',
      });

      const openerWin = windows.get(1)!;
      assert.strictEqual(openerWin.sentMessages[0].data.origin, '*');
    });

    it('fails when sender window is null', () => {
      const result = handleOpenerPostMessage(popupToOpener, null, windows, {
        message: 'test',
      });
      assert.deepStrictEqual(result, { success: false, error: 'No sender window' });
    });

    it('fails when no opener mapping exists', () => {
      createWindow(100);
      const result = handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: 'test',
      });
      assert.deepStrictEqual(result, { success: false, error: 'No opener window mapped' });
    });

    it('fails and cleans up when opener window is destroyed', () => {
      const openerWin = createWindow(1);
      openerWin.destroyed = true;
      createWindow(100);
      popupToOpener.set(100, 1);

      const result = handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: 'test',
      });

      assert.deepStrictEqual(result, { success: false, error: 'Opener window not found' });
      assert.strictEqual(popupToOpener.has(100), false, 'Mapping should be cleaned up');
    });

    it('fails and cleans up when opener window does not exist', () => {
      createWindow(100);
      popupToOpener.set(100, 999); // opener window 999 doesn't exist

      const result = handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: 'test',
      });

      assert.deepStrictEqual(result, { success: false, error: 'Opener window not found' });
      assert.strictEqual(popupToOpener.has(100), false, 'Mapping should be cleaned up');
    });

    it('includes popupWindowId in forwarded message', () => {
      createWindow(1);
      createWindow(42);
      popupToOpener.set(42, 1);

      handleOpenerPostMessage(popupToOpener, 42, windows, {
        message: 'data',
      });

      const msg = windows.get(1)!.sentMessages[0];
      assert.strictEqual(msg.data.popupWindowId, 42);
    });
  });

  describe('opener-close handler', () => {
    it('closes the opener window', () => {
      createWindow(1);
      createWindow(100);
      popupToOpener.set(100, 1);

      let closedId: number | null = null;
      const result = handleOpenerClose(popupToOpener, 100, windows, (id) => {
        closedId = id;
      });

      assert.deepStrictEqual(result, { success: true });
      assert.strictEqual(closedId, 1);
    });

    it('fails when sender window is null', () => {
      const result = handleOpenerClose(popupToOpener, null, windows, () => {});
      assert.deepStrictEqual(result, { success: false, error: 'No sender window' });
    });

    it('fails when no opener mapping exists', () => {
      createWindow(100);
      const result = handleOpenerClose(popupToOpener, 100, windows, () => {});
      assert.deepStrictEqual(result, { success: false, error: 'No opener mapped' });
    });

    it('fails and cleans up when opener is destroyed', () => {
      const openerWin = createWindow(1);
      openerWin.destroyed = true;
      createWindow(100);
      popupToOpener.set(100, 1);

      const result = handleOpenerClose(popupToOpener, 100, windows, () => {});

      assert.deepStrictEqual(result, { success: false, error: 'Opener window not found' });
      assert.strictEqual(popupToOpener.has(100), false);
    });
  });

  describe('opener-focus handler', () => {
    it('shows and focuses the opener window', () => {
      const openerWin = createWindow(1);
      createWindow(100);
      popupToOpener.set(100, 1);

      const result = handleOpenerFocus(popupToOpener, 100, windows);

      assert.deepStrictEqual(result, { success: true });
      assert.strictEqual(openerWin.shown, true);
      assert.strictEqual(openerWin.focused, true);
    });

    it('fails when sender window is null', () => {
      const result = handleOpenerFocus(popupToOpener, null, windows);
      assert.deepStrictEqual(result, { success: false, error: 'No sender window' });
    });

    it('fails when no opener mapping exists', () => {
      createWindow(100);
      const result = handleOpenerFocus(popupToOpener, 100, windows);
      assert.deepStrictEqual(result, { success: false, error: 'No opener mapped' });
    });

    it('fails and cleans up when opener is destroyed', () => {
      const openerWin = createWindow(1);
      openerWin.destroyed = true;
      createWindow(100);
      popupToOpener.set(100, 1);

      const result = handleOpenerFocus(popupToOpener, 100, windows);

      assert.deepStrictEqual(result, { success: false, error: 'Opener window not found' });
      assert.strictEqual(popupToOpener.has(100), false);
    });
  });

  describe('cross-handler consistency', () => {
    it('postMessage cleanup prevents subsequent close from succeeding', () => {
      const openerWin = createWindow(1);
      openerWin.destroyed = true;
      createWindow(100);
      popupToOpener.set(100, 1);

      // postMessage handler cleans up the mapping
      handleOpenerPostMessage(popupToOpener, 100, windows, { message: 'test' });
      assert.strictEqual(popupToOpener.has(100), false);

      // Subsequent close should fail with "no opener mapped"
      const result = handleOpenerClose(popupToOpener, 100, windows, () => {});
      assert.deepStrictEqual(result, { success: false, error: 'No opener mapped' });
    });

    it('multiple popups can independently message their openers', () => {
      const opener1 = createWindow(1);
      const opener2 = createWindow(2);
      createWindow(100);
      createWindow(200);
      popupToOpener.set(100, 1);
      popupToOpener.set(200, 2);

      handleOpenerPostMessage(popupToOpener, 100, windows, {
        message: 'msg-for-opener-1',
      });
      handleOpenerPostMessage(popupToOpener, 200, windows, {
        message: 'msg-for-opener-2',
      });

      assert.strictEqual(opener1.sentMessages.length, 1);
      assert.strictEqual(opener1.sentMessages[0].data.message, 'msg-for-opener-1');
      assert.strictEqual(opener2.sentMessages.length, 1);
      assert.strictEqual(opener2.sentMessages[0].data.message, 'msg-for-opener-2');
    });
  });
});
