/**
 * Web Search Extension Tests
 *
 * Tests the web search extension:
 * - Extension loads and registers commands
 * - Built-in engines are available
 * - Search URL construction works
 * - Search window opens
 * - Per-engine commands are registered
 * - OpenSearch XML parsing works
 *
 * Run with:
 *   yarn test:electron:bg
 */

import { test, expect, DesktopApp, getSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// Shared app and background window
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

// Don't close the shared app -- let subsequent test files reuse it.

// ============================================================================
// Helper: Open web search window
// ============================================================================

async function openWebSearch(bgWindow: Page): Promise<{ searchWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://websearch/home.html', {
      width: 600,
      height: 500
    });
  });
  expect(result.success).toBe(true);

  const searchWindow = await sharedApp.getWindow('websearch/home.html', 5000);
  expect(searchWindow).toBeTruthy();
  await searchWindow.waitForLoadState('domcontentloaded');

  return { searchWindow, windowId: result.id };
}

// ============================================================================
// Helper: Close a window by ID
// ============================================================================

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  try {
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  } catch {
    // Window may already be closed
  }
}

// ============================================================================
// Web Search Tests
// ============================================================================

test.describe('Web Search Extension @desktop', () => {

  test('websearch manifest commands are registered via lazy stub', async () => {
    // Before extension loads, manifest commands should be available via lazy stubs
    const hasManifestCommands = await sharedBgWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const result = await (window as any).app.commands.list();
        if (result.success && result.data) {
          const names = result.data.map((c: { name: string }) => c.name);
          if (names.includes('web search') && names.includes('open web search')) {
            return true;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(hasManifestCommands).toBe(true);
  });

  test('websearch extension loads on first command invocation', async () => {
    // Trigger lazy loading by publishing cmd:execute for the command
    const extensionLoaded = await sharedBgWindow.evaluate(async () => {
      const api = (window as any).app;
      // Trigger the lazy stub — this loads the extension
      api.publish('cmd:execute:open web search', {}, api.scopes.GLOBAL);

      // Wait for the extension to be running
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const result = await api.extensions.list();
        if (result.success && result.data) {
          if (result.data.some(
            (e: { id: string; status: string }) => e.id === 'websearch' && e.status === 'running'
          )) return true;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(extensionLoaded).toBe(true);

    // Close any window that was opened by the command
    await sleep(500);
    const windows = sharedApp.windows();
    for (const w of windows) {
      if (w.url().includes('websearch/home.html')) {
        const id = await sharedBgWindow.evaluate(async (url: string) => {
          const result = await (window as any).app.window.list({ includeInternal: false });
          if (!result.success) return null;
          const win = result.windows.find((w: any) => w.url?.includes('websearch/home.html'));
          return win?.id || null;
        }, w.url());
        if (id) await closeWindow(sharedBgWindow, id);
      }
    }
  });

  test('websearch commands are registered after loading', async () => {
    // After lazy loading, both manifest and per-engine commands should be available
    const hasCommands = await sharedBgWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const result = await (window as any).app.commands.list();
        if (result.success && result.data) {
          const names = result.data.map((c: { name: string }) => c.name);
          if (names.includes('web search') && names.includes('google') && names.includes('ddg')) {
            return true;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(hasCommands).toBe(true);
  });

  test('per-engine commands are registered (google, ddg, bing, wiki, kagi)', async () => {
    const engineCommands = await sharedBgWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const result = await (window as any).app.commands.list();
        if (result.success && result.data) {
          const names = result.data.map((c: { name: string }) => c.name);
          const expected = ['google', 'ddg', 'bing', 'wiki', 'kagi'];
          const found = expected.filter(e => names.includes(e));
          if (found.length === expected.length) {
            return found;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return [];
    });
    expect(engineCommands).toContain('google');
    expect(engineCommands).toContain('ddg');
    expect(engineCommands).toContain('bing');
    expect(engineCommands).toContain('wiki');
    expect(engineCommands).toContain('kagi');
  });

  test('built-in engines are available via settings', async () => {
    // Open a search window and check the engines populated via BroadcastChannel
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      // Wait for engines to be populated in the search window state
      const engines = await searchWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const s = (window as any)._websearchState;
          if (s && s.engines && s.engines.length >= 5) {
            return s.engines;
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return (window as any)._websearchState?.engines || [];
      });

      expect(engines.length).toBeGreaterThanOrEqual(5);

      const ids = engines.map((e: any) => e.id);
      expect(ids).toContain('google');
      expect(ids).toContain('duckduckgo');
      expect(ids).toContain('bing');
      expect(ids).toContain('wikipedia');
      expect(ids).toContain('kagi');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('search URL construction works correctly', async () => {
    // Open a search window and check engine data via BroadcastChannel-populated state
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      const engineData = await searchWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const s = (window as any)._websearchState;
          if (s && s.engines && s.engines.length > 0) {
            const google = s.engines.find((e: any) => e.id === 'google');
            if (google) {
              const query = 'test query';
              const url = google.searchUrl.replace('{searchTerms}', encodeURIComponent(query));
              return {
                template: google.searchUrl,
                constructed: url,
                hasPlaceholder: google.searchUrl.includes('{searchTerms}')
              };
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return null;
      });

      expect(engineData).toBeTruthy();
      expect(engineData.hasPlaceholder).toBe(true);
      expect(engineData.constructed).toBe('https://www.google.com/search?q=test%20query');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('search window opens and shows UI elements', async () => {
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      // Wait for the UI to load
      await searchWindow.waitForSelector('#search-input', { timeout: 5000 });

      // Check UI elements exist
      const uiElements = await searchWindow.evaluate(() => {
        return {
          hasSearchInput: !!document.getElementById('search-input'),
          hasEngineIndicator: !!document.getElementById('engine-indicator'),
          hasEngineName: !!document.getElementById('engine-name'),
          hasEngineIcon: !!document.getElementById('engine-icon'),
          hasSuggestions: !!document.getElementById('suggestions'),
          hasEngineList: !!document.getElementById('engine-list'),
          hasEmptyState: !!document.getElementById('empty-state'),
        };
      });

      expect(uiElements.hasSearchInput).toBe(true);
      expect(uiElements.hasEngineIndicator).toBe(true);
      expect(uiElements.hasEngineName).toBe(true);
      expect(uiElements.hasEngineIcon).toBe(true);
      expect(uiElements.hasSuggestions).toBe(true);
      expect(uiElements.hasEngineList).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('internal state is exposed for testing', async () => {
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      // Wait for init to complete
      await searchWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if ((window as any)._websearchState) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      });

      const stateExists = await searchWindow.evaluate(() => {
        const s = (window as any)._websearchState;
        return s &&
          typeof s.query === 'string' &&
          Array.isArray(s.suggestions) &&
          Array.isArray(s.engines) &&
          typeof s.defaultEngineId === 'string';
      });
      expect(stateExists).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('default engine is DuckDuckGo (privacy default)', async () => {
    // Open a search window and check the default engine via BroadcastChannel-populated state
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      const defaultEngineId = await searchWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const s = (window as any)._websearchState;
          if (s && s.defaultEngineId) {
            return s.defaultEngineId;
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return (window as any)._websearchState?.defaultEngineId || '';
      });

      expect(defaultEngineId).toBe('duckduckgo');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('engine list shows in search window when no query', async () => {
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      // Wait for engines to load in the UI
      const engineCount = await searchWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const items = document.querySelectorAll('.engine-item');
          if (items.length > 0) return items.length;
          await new Promise(r => setTimeout(r, 200));
        }
        return 0;
      });

      // Should have at least the 4 built-in engines
      expect(engineCount).toBeGreaterThanOrEqual(4);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });
});
