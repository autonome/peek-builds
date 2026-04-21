import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Themes @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('themes'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('theme API is available', async () => {
    const hasThemeApi = await bgWindow.evaluate(() => {
      const api = (window as any).app;
      return !!(api.theme && api.theme.get && api.theme.setTheme && api.theme.getAll);
    });
    expect(hasThemeApi).toBe(true);
  });

  test('get current theme state', async () => {
    const themeState = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });

    expect(themeState).toBeTruthy();
    expect(themeState.themeId).toBeTruthy();
    expect(themeState.colorScheme).toBeTruthy();
    expect(['system', 'light', 'dark']).toContain(themeState.colorScheme);
    expect(typeof themeState.isDark).toBe('boolean');
    expect(['light', 'dark']).toContain(themeState.effectiveScheme);
  });

  test('list available themes', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.getAll();
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(2); // basic and peek

    // Verify built-in themes exist
    const themeIds = result.data.map((t: any) => t.id);
    expect(themeIds).toContain('basic');
    expect(themeIds).toContain('peek');

    // Verify theme structure
    for (const theme of result.data) {
      expect(theme.id).toBeTruthy();
      expect(theme.name).toBeTruthy();
      expect(theme.version).toBeTruthy();
    }
  });

  test('switch themes', async () => {
    // Get initial theme
    const initialState = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });

    // Switch to a different theme
    const targetTheme = initialState.themeId === 'basic' ? 'peek' : 'basic';
    const switchResult = await bgWindow.evaluate(async (themeId: string) => {
      return await (window as any).app.theme.setTheme(themeId);
    }, targetTheme);

    expect(switchResult.success).toBe(true);
    expect(switchResult.themeId).toBe(targetTheme);

    // Verify theme changed
    const newState = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });
    expect(newState.themeId).toBe(targetTheme);

    // Switch back to original
    await bgWindow.evaluate(async (themeId: string) => {
      return await (window as any).app.theme.setTheme(themeId);
    }, initialState.themeId);
  });

  test('switch color scheme', async () => {
    // Get initial state
    const initialState = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });

    // Switch to light mode
    const lightResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setColorScheme('light');
    });
    expect(lightResult.success).toBe(true);
    expect(lightResult.colorScheme).toBe('light');

    // Verify it changed
    let state = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });
    expect(state.colorScheme).toBe('light');
    expect(state.effectiveScheme).toBe('light');

    // Switch to dark mode
    const darkResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setColorScheme('dark');
    });
    expect(darkResult.success).toBe(true);
    expect(darkResult.colorScheme).toBe('dark');

    state = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });
    expect(state.colorScheme).toBe('dark');
    expect(state.effectiveScheme).toBe('dark');

    // Switch back to system
    const systemResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setColorScheme('system');
    });
    expect(systemResult.success).toBe(true);
    expect(systemResult.colorScheme).toBe('system');

    // Restore original color scheme
    await bgWindow.evaluate(async (scheme: string) => {
      return await (window as any).app.theme.setColorScheme(scheme);
    }, initialState.colorScheme);
  });

  test('invalid theme returns error', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setTheme('nonexistent-theme');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('invalid color scheme returns error', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setColorScheme('invalid');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
