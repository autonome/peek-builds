import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, waitForCommandResults, waitForResultsWithContent, waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('Cmd Palette @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-palette'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('open cmd and execute gallery command', async () => {
    // Wait for cmd extension to be ready (critical for packaged mode where startup is slower)
    await waitForExtensionsReady(bgWindow, 15000);

    // Open cmd panel via window API
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    // Find the cmd window (getWindow already polls until found)
    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    expect(cmdWindow).toBeTruthy();

    // Wait for input to be ready and commands to be loaded
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);

    // Type a built-in command first to verify
    // Built-in commands (like 'settings') load faster than extension commands
    await cmdWindow.fill('input', 'settings');
    // Press ArrowDown to show results (panel requires this to display dropdown)
    await cmdWindow.keyboard.press('ArrowDown');
    await waitForCommandResults(cmdWindow, 1, 10000); // Longer timeout for initial load

    // Now search for the extension command
    await cmdWindow.fill('input', 'example:gallery');
    await cmdWindow.keyboard.press('ArrowDown');
    await waitForCommandResults(cmdWindow, 1, 10000);

    // Press Enter to execute
    await cmdWindow.keyboard.press('Enter');

    // Close the cmd window
    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }
  });

  test('edit command Tab-completion shows autocomplete and opens editor', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Create a test note so the edit command has something to autocomplete
    const addResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('text', {
        content: '# Edit Tab Test Note\nThis is a note for testing edit tab-completion.'
      });
    });
    expect(addResult.success).toBe(true);
    const noteId = addResult.data?.id;

    // Set up editor:open event capture BEFORE opening the cmd panel
    await bgWindow.evaluate(() => {
      (window as any).__editorOpenCaptured = [];
      (window as any).__editorOpenUnsub = (window as any).app.subscribe('editor:open', (data: any) => {
        (window as any).__editorOpenCaptured.push(data);
      }, (window as any).app.scopes.GLOBAL);
    });

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    expect(cmdWindow).toBeTruthy();

    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);

    // Type "edit " (with space) to commit to the edit command and enter param mode
    // (Tab would cycle to 'editor' since both "edit" and "editor" match)
    await cmdWindow.fill('input', 'edit ');

    // Wait for param mode and suggestions to populate
    await cmdWindow.waitForFunction(
      () => {
        const state = (window as any)._cmdState;
        return state && state.paramMode === true && state.paramCommand === 'edit'
          && state.paramSuggestions && state.paramSuggestions.length > 0;
      },
      undefined,
      { timeout: 10000 }
    );

    // Verify results are visible with suggestion items
    await waitForResultsWithContent(cmdWindow, 5000);

    // Press Enter to accept the first suggestion
    // This executes the edit command, publishes editor:open, and closes the panel
    await cmdWindow.keyboard.press('Enter');

    // Verify editor:open was published by polling the captured events
    await bgWindow.waitForFunction(() => {
      return (window as any).__editorOpenCaptured && (window as any).__editorOpenCaptured.length > 0;
    }, undefined, { timeout: 10000 });

    const editorOpenData = await bgWindow.evaluate(() => {
      return (window as any).__editorOpenCaptured[0];
    });
    expect(editorOpenData).toBeTruthy();

    // Clean up event listener
    await bgWindow.evaluate(() => {
      if ((window as any).__editorOpenUnsub) {
        (window as any).__editorOpenUnsub();
      }
      delete (window as any).__editorOpenCaptured;
      delete (window as any).__editorOpenUnsub;
    });

    // Close cmd window if still open
    try {
      if (openResult.id) {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      }
    } catch {
      // Panel may have already closed via shutdown()
    }

    // Clean up the test note
    if (noteId) {
      await bgWindow.evaluate(async (id: string) => {
        return await (window as any).app.datastore.deleteItem(id);
      }, noteId);
    }
  });
});
