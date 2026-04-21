import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

test.describe('Scripts Extension @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('scripts'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('create, save, and execute script', async () => {
    // Wait for scripts extension to be ready
    await waitForExtensionsReady(bgWindow, 15000);

    // Create a new script directly via datastore
    const scriptId = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const scriptId = `script_test_${Date.now()}`;

      // Get current settings from datastore
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];

      // Add new script
      const newScript = {
        id: scriptId,
        name: 'Test Script',
        description: 'A test script',
        code: 'const h1 = document.querySelector("h1"); return { title: h1?.textContent || "No h1 found" };',
        matchPatterns: ['https://example.com/*'],
        excludePatterns: [],
        runAt: 'document-end',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastExecutedAt: null
      };

      scripts.push(newScript);

      // Save back to datastore
      await api.datastore.setRow('feature_settings', 'scripts:scripts', {
        featureId: 'scripts',
        key: 'scripts',
        value: JSON.stringify(scripts),
        updatedAt: Date.now()
      });

      return scriptId;
    });

    expect(scriptId).toBeTruthy();

    // Verify script was saved
    const savedScript = await bgWindow.evaluate(async (scriptId) => {
      const api = (window as any).app;
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
      return scripts.find((s: any) => s.id === scriptId);
    }, scriptId);

    expect(savedScript).toBeTruthy();
    expect(savedScript.name).toBe('Test Script');

    // Execute script - test executor directly
    const executeResult = await bgWindow.evaluate(async (scriptId) => {
      const api = (window as any).app;
      const { scriptExecutor } = await import('peek://scripts/script-executor.js');

      // Get the script from datastore
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
      const script = scripts.find((s: any) => s.id === scriptId);

      if (!script) {
        return { success: false, error: 'Script not found' };
      }

      // Execute directly
      const result = await scriptExecutor.executeScript(script, {
        url: 'https://example.com/test',
        pageDOM: document,
        pageWindow: window
      });

      return { success: true, data: result };
    }, scriptId);

    expect(executeResult).toHaveProperty('success', true);
    expect((executeResult as any).data.status).toBe('success');

    // Clean up - delete script
    await bgWindow.evaluate(async (scriptId) => {
      const api = (window as any).app;
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
      const filtered = scripts.filter((s: any) => s.id !== scriptId);
      await api.datastore.setRow('feature_settings', 'scripts:scripts', {
        featureId: 'scripts',
        key: 'scripts',
        value: JSON.stringify(filtered),
        updatedAt: Date.now()
      });
    }, scriptId);
  });

  test('script pattern matching works', async () => {
    // Test pattern matching directly
    const patternTests = await bgWindow.evaluate(async () => {
      // Import the script executor module
      const { ScriptExecutor } = await import('peek://scripts/script-executor.js');
      const executor = new ScriptExecutor();

      return {
        exactMatch: executor.matchPattern('https://example.com/*', 'https://example.com/page'),
        noMatch: executor.matchPattern('https://example.com/*', 'https://other.com/page'),
        wildcardProtocol: executor.matchPattern('*://example.com/*', 'https://example.com/page'),
        wildcardAll: executor.matchPattern('*', 'https://anything.com/page')
      };
    });

    expect(patternTests.exactMatch).toBe(true);
    expect(patternTests.noMatch).toBe(false);
    expect(patternTests.wildcardProtocol).toBe(true);
    expect(patternTests.wildcardAll).toBe(true);
  });

  test('script timeout protection works', async () => {
    // Create a script that runs forever
    const scriptId = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const scriptId = `script_timeout_test_${Date.now()}`;

      // Get current settings from datastore
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];

      // Add timeout test script
      const newScript = {
        id: scriptId,
        name: 'Timeout Test',
        code: 'while(true) {}', // Infinite loop
        matchPatterns: ['*'],
        excludePatterns: [],
        runAt: 'document-end',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastExecutedAt: null
      };

      scripts.push(newScript);
      await api.datastore.setRow('feature_settings', 'scripts:scripts', {
        featureId: 'scripts',
        key: 'scripts',
        value: JSON.stringify(scripts),
        updatedAt: Date.now()
      });

      return scriptId;
    });

    // Execute with short timeout - test executor directly
    const executeResult = await bgWindow.evaluate(async (scriptId) => {
      const api = (window as any).app;
      const { scriptExecutor } = await import('peek://scripts/script-executor.js');

      // Get the script from datastore
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
      const script = scripts.find((s: any) => s.id === scriptId);

      if (!script) {
        return { success: false, error: 'Script not found' };
      }

      // Execute directly with timeout
      const result = await scriptExecutor.executeScript(script, {
        url: 'https://example.com',
        pageDOM: document,
        pageWindow: window,
        timeout: 100 // 100ms timeout
      });

      return { success: true, data: result };
    }, scriptId);

    expect(executeResult).toHaveProperty('success', true);
    expect((executeResult as any).data.status).toBe('error');
    expect((executeResult as any).data.error).toContain('timeout');

    // Clean up
    await bgWindow.evaluate(async (scriptId) => {
      const api = (window as any).app;
      const settingsTable = await api.datastore.getTable('feature_settings');
      const scriptsRow = settingsTable.data?.['scripts:scripts'];
      const scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
      const filtered = scripts.filter((s: any) => s.id !== scriptId);
      await api.datastore.setRow('feature_settings', 'scripts:scripts', {
        featureId: 'scripts',
        key: 'scripts',
        value: JSON.stringify(filtered),
        updatedAt: Date.now()
      });
    }, scriptId);
  });
});
