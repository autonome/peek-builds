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
import { waitForExtensionsReady } from '../helpers/window-utils';

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
    // Before extension loads, manifest commands should be available via lazy
    // stubs. Synchronize on the command registry actually containing the
    // manifest commands (a real data predicate on app.commands.list), not a
    // clock — the deadline is a failure deadline only.
    await sharedBgWindow.waitForFunction(async () => {
      const result = await (window as any).app.commands.list();
      if (!result.success || !result.data) return false;
      const names = result.data.map((c: { name: string }) => c.name);
      return names.includes('web search') && names.includes('open web search');
    }, undefined, { timeout: 5000 });
  });

  test('websearch extension loads on first command invocation', async () => {
    // Arm the FSM observer for the websearch tile reaching READY BEFORE we
    // publish the lazy-wake command, so the cold-boot transition can't race
    // ahead of us. waitForTileState resolves on the System-owned
    // `tile:state-changed` topic — a REAL FSM transition, not a timer. The
    // 15s deadline is a failure deadline only.
    const readyPromise = sharedApp.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.waitForTileState('websearch', 'ready', 15000)) as any);

    // Trigger lazy loading by publishing cmd:execute for the command.
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:open web search', {});
    });

    // Synchronize on the LOADING → READY transition of the websearch tile.
    const transition = (await readyPromise) as { tileId: string; to: string };
    expect(transition.tileId).toBe('websearch');
    expect(transition.to).toBe('ready');

    // The command handler's visible side-effect is the search window — wait
    // on its committed presence (getWindow), not a clock.
    const searchWindow = await sharedApp.getWindow('websearch/home.html', 15000);
    expect(searchWindow).toBeTruthy();

    // Close the window the command opened, resolving its id from committed
    // window-list state.
    const id = await sharedBgWindow.evaluate(async () => {
      const result = await (window as any).app.window.list({ includeInternal: false });
      if (!result.success) return null;
      const win = result.windows.find((w: any) => w.url?.includes('websearch/home.html'));
      return win?.id || null;
    });
    if (id) await closeWindow(sharedBgWindow, id);
  });

  test('websearch commands are registered after loading', async () => {
    // After lazy loading, both manifest and per-engine commands should be
    // available. Synchronize on the registry actually carrying them (real
    // data predicate on app.commands.list), not a clock.
    await sharedBgWindow.waitForFunction(async () => {
      const result = await (window as any).app.commands.list();
      if (!result.success || !result.data) return false;
      const names = result.data.map((c: { name: string }) => c.name);
      return names.includes('web search') && names.includes('google') && names.includes('ddg');
    }, undefined, { timeout: 5000 });
  });

  test('per-engine commands are registered (google, ddg, bing, wiki, kagi)', async () => {
    // Wait until all five per-engine commands are present in the registry,
    // then read them out for assertion. The predicate is the real populated
    // command set, not elapsed time.
    await sharedBgWindow.waitForFunction(async () => {
      const result = await (window as any).app.commands.list();
      if (!result.success || !result.data) return false;
      const names = result.data.map((c: { name: string }) => c.name);
      return ['google', 'ddg', 'bing', 'wiki', 'kagi'].every(e => names.includes(e));
    }, undefined, { timeout: 5000 });

    const engineCommands = await sharedBgWindow.evaluate(async () => {
      const result = await (window as any).app.commands.list();
      const names = result.data.map((c: { name: string }) => c.name);
      return ['google', 'ddg', 'bing', 'wiki', 'kagi'].filter(e => names.includes(e));
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
      // Wait for the engines to be populated in the search window state — a
      // real data predicate (>=5 engines), not a clock.
      await searchWindow.waitForFunction(() => {
        const s = (window as any)._websearchState;
        return !!(s && s.engines && s.engines.length >= 5);
      }, undefined, { timeout: 5000 });
      const engines = await searchWindow.evaluate(() => (window as any)._websearchState.engines);

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
      // Wait until the google engine is present in the populated state, then
      // read it — predicate is the real engine entry, not elapsed time.
      await searchWindow.waitForFunction(() => {
        const s = (window as any)._websearchState;
        return !!(s && s.engines && s.engines.some((e: any) => e.id === 'google'));
      }, undefined, { timeout: 5000 });
      const engineData = await searchWindow.evaluate(() => {
        const google = (window as any)._websearchState.engines.find((e: any) => e.id === 'google');
        const url = google.searchUrl.replace('{searchTerms}', encodeURIComponent('test query'));
        return {
          template: google.searchUrl,
          constructed: url,
          hasPlaceholder: google.searchUrl.includes('{searchTerms}'),
        };
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
      // Wait for init to complete — predicate is the populated state object
      // existing, not elapsed time.
      await searchWindow.waitForFunction(
        () => !!(window as any)._websearchState,
        undefined,
        { timeout: 5000 },
      );

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
      // Wait until defaultEngineId is populated in state, then read it — real
      // data predicate, not a clock.
      await searchWindow.waitForFunction(() => {
        const s = (window as any)._websearchState;
        return !!(s && s.defaultEngineId);
      }, undefined, { timeout: 5000 });
      const defaultEngineId = await searchWindow.evaluate(
        () => (window as any)._websearchState.defaultEngineId,
      );

      expect(defaultEngineId).toBe('duckduckgo');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('engine list shows in search window when no query', async () => {
    const { searchWindow, windowId } = await openWebSearch(sharedBgWindow);

    try {
      // Wait for the engine items to render in the UI — predicate keyed on
      // at least the 4 built-in engine rows existing, not a clock.
      await searchWindow.waitForFunction(
        () => document.querySelectorAll('.engine-item').length >= 4,
        undefined,
        { timeout: 5000 },
      );
      const engineCount = await searchWindow.evaluate(
        () => document.querySelectorAll('.engine-item').length,
      );

      // Should have at least the 4 built-in engines
      expect(engineCount).toBeGreaterThanOrEqual(4);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });
});
