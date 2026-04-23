import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForCommandResults, waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('Edit Command Param Mode @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('edit-param'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('Tab in param mode fills text, does NOT execute', async () => {
    // Create a test note so param mode has suggestions
    const createResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('text', {
        content: '# Tab Test Note\nThis is a note for testing Tab in param mode.'
      });
    });
    expect(createResult.success).toBe(true);
    const noteId = createResult.data.id;

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
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
    await waitForPanelCommandsLoaded(cmdWindow);

    // Type 'edit ' (with space) to commit to the edit command and enter param mode
    // (Tab would cycle to 'editor' since both match 'edit')
    await cmdWindow.fill('input', 'edit ');

    // Wait for param mode to activate
    await cmdWindow.waitForFunction(() => {
      const s = (window as any)._cmdState;
      return s.paramMode === true && s.paramCommand === 'edit';
    }, { timeout: 5000 });

    // Wait for param suggestions to load (items query)
    await cmdWindow.waitForFunction(() => {
      return (window as any)._cmdState.paramSuggestions.length > 0;
    }, { timeout: 10000 });

    // Press Tab on a suggestion - should fill text, NOT execute
    await cmdWindow.keyboard.press('Tab');

    // Verify param mode is still active (Tab fills, doesn't execute)
    const stillParamMode = await cmdWindow.evaluate(() => {
      return (window as any)._cmdState.paramMode === true;
    });
    expect(stillParamMode).toBe(true);

    // Verify input text was updated with the suggestion value
    const inputValue = await cmdWindow.$eval('input', (el: HTMLInputElement) => el.value);
    expect(inputValue.startsWith('edit ')).toBe(true);
    expect(inputValue.length).toBeGreaterThan('edit '.length);

    // Close the cmd window
    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }

    // Clean up test note
    await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, noteId);
  });

  test('Enter in param mode executes with correct itemId', async () => {
    // Create a test note
    const createResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('text', {
        content: '# Enter Test Note\nThis is a note for testing Enter in param mode.'
      });
    });
    expect(createResult.success).toBe(true);
    const noteId = createResult.data.id;

    // Set up a listener for editor:open events BEFORE opening cmd panel
    await bgWindow.evaluate(async () => {
      (window as any).__editorOpenEvents = [];
      (window as any).app.subscribe('editor:open', (data: any) => {
        (window as any).__editorOpenEvents.push(data);
      }, { scope: 'global' });
    });

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
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
    await waitForPanelCommandsLoaded(cmdWindow);

    // Type 'edit ' (with space) to commit to the edit command and enter param mode
    await cmdWindow.fill('input', 'edit ');

    // Wait for param mode and suggestions to load
    await cmdWindow.waitForFunction(() => {
      const s = (window as any)._cmdState;
      return s.paramMode === true && s.paramCommand === 'edit' && s.paramSuggestions.length > 0;
    }, { timeout: 10000 });

    // Find the index of our test note in suggestions
    const testNoteIndex = await cmdWindow.evaluate((targetId: string) => {
      const suggestions = (window as any)._cmdState.paramSuggestions;
      return suggestions.findIndex((s: any) => s._item && s._item.id === targetId);
    }, noteId);

    // Navigate to the test note if needed
    if (testNoteIndex > 0) {
      for (let i = 0; i < testNoteIndex; i++) {
        await cmdWindow.keyboard.press('ArrowDown');
      }
    }

    // Press Enter to execute with the selected item
    await cmdWindow.keyboard.press('Enter');

    // Wait for editor:open event to be published
    await bgWindow.waitForFunction(() => {
      return (window as any).__editorOpenEvents && (window as any).__editorOpenEvents.length > 0;
    }, { timeout: 10000 });

    // Verify editor:open was published with the correct itemId
    const editorEvents = await bgWindow.evaluate(() => {
      return (window as any).__editorOpenEvents;
    });
    expect(editorEvents.length).toBeGreaterThan(0);
    const lastEvent = editorEvents[editorEvents.length - 1];
    expect(lastEvent.itemId).toBe(noteId);

    // Close cmd window if still open
    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        try { return await (window as any).app.window.close(id); } catch(e) { /* may already be closed */ }
      }, openResult.id);
    }

    // Clean up
    await bgWindow.evaluate(async (id: string) => {
      delete (window as any).__editorOpenEvents;
      return await (window as any).app.datastore.deleteItem(id);
    }, noteId);
  });

  test('Tab in command mode completes name, does not execute', async () => {
    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
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
    await waitForPanelCommandsLoaded(cmdWindow);

    // Type partial command name 'edi'
    await cmdWindow.fill('input', 'edi');
    await cmdWindow.keyboard.press('ArrowDown');
    await waitForCommandResults(cmdWindow, 1, 10000);

    // Press Tab - should complete command name, not execute
    await cmdWindow.keyboard.press('Tab');

    // Verify input is now 'edit' (completed from 'edi')
    const inputValue = await cmdWindow.$eval('input', (el: HTMLInputElement) => el.value);
    expect(inputValue.toLowerCase().startsWith('edit')).toBe(true);

    // Verify the panel is still open and responsive (no command was executed)
    const panelStillOpen = await cmdWindow.evaluate(() => {
      return document.getElementById('command-input') !== null;
    });
    expect(panelStillOpen).toBe(true);

    // Close the cmd window
    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }
  });
});
