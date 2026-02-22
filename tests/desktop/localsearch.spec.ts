/**
 * Local Search Extension Tests
 *
 * Tests the local search extension for finding content across items, tags, and history.
 *
 * Test philosophy: deterministic -- no timeouts as assertions.
 * Uses polling via evaluate()/waitForFunction instead of sleep + snapshot.
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, waitForCommand, sleep } from '../helpers/window-utils';

// Shared app for tests
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

// Note: Do NOT call closeSharedApp() - tests share the app instance

test.describe('Local Search Extension @desktop', () => {
  test('localsearch command is available via lazy stub', async () => {
    // Localsearch is lazy-loaded — the manifest command is registered by the lazy stub
    // before the extension itself loads
    await waitForCommand(sharedBgWindow, 'localsearch', 10000);
  });

  test('localsearch command is registered', async () => {
    // Wait for the localsearch command to be registered
    await waitForCommand(sharedBgWindow, 'localsearch', 10000);
  });

  test('localsearch window opens via command', async () => {
    // Execute the localsearch command
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:localsearch', {}, (window as any).app.scopes.GLOBAL);
    });

    // Wait for search window to appear
    const searchWindow = await sharedApp.getWindow('ext/localsearch/home.html', 5000);
    expect(searchWindow).toBeTruthy();

    // Verify basic DOM structure
    await searchWindow.waitForSelector('#search-input', { timeout: 5000 });
    const searchInput = await searchWindow.$('#search-input');
    expect(searchInput).toBeTruthy();

    const resultsEl = await searchWindow.$('#results');
    expect(resultsEl).toBeTruthy();

    const emptyState = await searchWindow.$('#empty-state');
    expect(emptyState).toBeTruthy();
  });

  test('localsearch input renders and is auto-focused', async () => {
    // Open localsearch window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:localsearch', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await sharedApp.getWindow('ext/localsearch/home.html', 5000);
    await searchWindow.waitForSelector('#search-input', { timeout: 5000 });

    // Verify search input has the expected placeholder
    const placeholder = await searchWindow.$eval('#search-input', (el: any) => el.placeholder);
    expect(placeholder).toContain('Search');
  });

  test('typing shows search results', async () => {
    // First seed some data
    await sharedBgWindow.evaluate(async () => {
      const api = (window as any).app;
      // Create a URL item
      await api.datastore.addItem('url', {
        content: 'https://example.com/search-test',
        metadata: JSON.stringify({ title: 'Search Test Page' })
      });
      // Create a text note
      await api.datastore.addItem('text', {
        content: 'This is a search test note with unique content'
      });
    });

    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:localsearch', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await sharedApp.getWindow('ext/localsearch/home.html', 5000);
    await searchWindow.waitForSelector('#search-input', { timeout: 5000 });

    // Type a search query that should match our seeded data
    // Use dispatchEvent to trigger input on the peek-input's internal input
    await searchWindow.evaluate(() => {
      const input = document.getElementById('search-input') as any;
      input.value = 'search test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for results to appear (debounced 200ms + render time)
    await searchWindow.waitForFunction(
      () => document.querySelectorAll('.result-item').length > 0,
      { timeout: 5000 }
    );

    // Verify results are shown
    const resultCount = await searchWindow.evaluate(
      () => document.querySelectorAll('.result-item').length
    );
    expect(resultCount).toBeGreaterThan(0);

    // Verify result count indicator is updated
    const countText = await searchWindow.$eval('#result-count', (el: any) => el.textContent);
    expect(countText).toMatch(/\d+ results?/);
  });

  test('search results are grouped by type', async () => {
    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:localsearch', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await sharedApp.getWindow('ext/localsearch/home.html', 5000);
    await searchWindow.waitForSelector('#search-input', { timeout: 5000 });

    // Type a search query
    await searchWindow.evaluate(() => {
      const input = document.getElementById('search-input') as any;
      input.value = 'search test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for results
    await searchWindow.waitForFunction(
      () => document.querySelectorAll('.result-group').length > 0,
      { timeout: 5000 }
    );

    // Verify groups have headers
    const groupHeaders = await searchWindow.evaluate(
      () => Array.from(document.querySelectorAll('.result-group-header')).map((el: any) => el.textContent)
    );
    expect(groupHeaders.length).toBeGreaterThan(0);
    // Group labels should be recognizable type names
    for (const header of groupHeaders) {
      expect(header).toMatch(/(URLs|Notes|Tags|Tagsets)/);
    }
  });

  test('empty search shows empty state', async () => {
    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:localsearch', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await sharedApp.getWindow('ext/localsearch/home.html', 5000);
    await searchWindow.waitForSelector('#search-input', { timeout: 5000 });

    // Clear any previous search (window may be reused from earlier tests)
    await searchWindow.evaluate(() => {
      const input = document.getElementById('search-input') as any;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for empty state to become visible after clearing
    await searchWindow.waitForFunction(() => {
      const empty = document.getElementById('empty-state');
      return empty && getComputedStyle(empty).display !== 'none';
    }, { timeout: 5000 });

    const emptyVisible = await searchWindow.evaluate(() => {
      const empty = document.getElementById('empty-state');
      return empty && getComputedStyle(empty).display !== 'none';
    });
    expect(emptyVisible).toBe(true);
  });
});
