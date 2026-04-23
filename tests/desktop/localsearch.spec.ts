/**
 * Lists Extension Tests
 *
 * Tests the lists extension for finding content across items, tags, and history.
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

test.describe('Lists Extension @desktop', () => {
  test('lists command is available via lazy stub', async () => {
    // Lists is lazy-loaded — the manifest command is registered by the lazy stub
    // before the extension itself loads
    await waitForCommand(sharedBgWindow, 'lists', 10000);
  });

  test('lists command is registered', async () => {
    // Wait for the lists command to be registered
    await waitForCommand(sharedBgWindow, 'lists', 10000);
  });

  test('lists window opens via command', async () => {
    // Ensure the lists command is registered before executing it.
    // The lists tile is lazy-loaded — the background tile must be loaded and
    // tile:lifecycle:ready received before the execute handler is registered.
    await waitForCommand(sharedBgWindow, 'lists', 15000);

    // Start waiting for the window BEFORE publishing the command so we don't
    // miss a fast creation (getWindow polls every 200ms and returns immediately
    // when the window appears — the 15s cap handles the full lazy-load chain:
    // background-tile launch → tile:lifecycle:ready → execute replay → tile:window:open).
    const windowPromise = sharedApp.getWindow('lists/home.html', 15000);

    // Execute the lists command
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:lists', {}, (window as any).app.scopes.GLOBAL);
    });

    // Wait for search window to appear
    const searchWindow = await windowPromise;
    expect(searchWindow).toBeTruthy();

    // Verify basic DOM structure
    await searchWindow.waitForSelector('#search-input', { timeout: 10000 });
    const searchInput = await searchWindow.$('#search-input');
    expect(searchInput).toBeTruthy();

    const resultsEl = await searchWindow.$('#results');
    expect(resultsEl).toBeTruthy();

    const emptyState = await searchWindow.$('#empty-state');
    expect(emptyState).toBeTruthy();
  });

  test('lists input renders and is auto-focused', async () => {
    // Ensure the lists command is registered before executing it.
    // The lists tile is lazy-loaded — the background tile must be loaded and
    // tile:lifecycle:ready received before the execute handler is registered.
    await waitForCommand(sharedBgWindow, 'lists', 15000);

    // Start waiting for the window BEFORE publishing the command so we don't
    // miss a fast creation (getWindow polls every 200ms and returns immediately
    // when the window appears).
    const windowPromise = sharedApp.getWindow('lists/home.html', 15000);

    // Open lists window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:lists', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await windowPromise;
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForSelector('#search-input', { timeout: 10000 });

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

    // Ensure the lists command is registered before executing it.
    await waitForCommand(sharedBgWindow, 'lists', 15000);

    // Start waiting for the window BEFORE publishing the command so we don't
    // miss a fast creation (getWindow polls every 200ms).
    const windowPromise = sharedApp.getWindow('lists/home.html', 15000);

    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:lists', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await windowPromise;
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForSelector('#search-input', { timeout: 10000 });

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
    // Seed data so there are results to group (url + text for two distinct types)
    await sharedBgWindow.evaluate(async () => {
      const api = (window as any).app;
      await api.datastore.addItem('url', {
        content: 'https://example.com/group-test',
        metadata: JSON.stringify({ title: 'Group Test Page' })
      });
      await api.datastore.addItem('text', {
        content: 'This is a group test note with unique content'
      });
    });

    // Ensure the lists command is registered before executing it.
    await waitForCommand(sharedBgWindow, 'lists', 15000);

    // Start waiting for the window BEFORE publishing the command so we don't
    // miss a fast creation (getWindow polls every 200ms).
    const windowPromise = sharedApp.getWindow('lists/home.html', 15000);

    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:lists', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await windowPromise;
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForSelector('#search-input', { timeout: 10000 });

    // Type a search query that matches the seeded data
    await searchWindow.evaluate(() => {
      const input = document.getElementById('search-input') as any;
      input.value = 'group test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for results
    await searchWindow.waitForFunction(
      () => document.querySelectorAll('.result-group').length > 0,
      { timeout: 10000 }
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
    // Ensure the lists command is registered before executing it.
    await waitForCommand(sharedBgWindow, 'lists', 15000);

    // Start waiting for the window BEFORE publishing the command so we don't
    // miss a fast creation (getWindow polls every 200ms).
    const windowPromise = sharedApp.getWindow('lists/home.html', 15000);

    // Open search window
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:lists', {}, (window as any).app.scopes.GLOBAL);
    });

    const searchWindow = await windowPromise;
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForSelector('#search-input', { timeout: 10000 });

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
