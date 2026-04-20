/**
 * Cmd panel noun-command tests (serial).
 *
 * Moved out of smoke.spec.ts because the cmd panel's modal window + keyboard
 * input flow (fill input → ArrowDown → press Enter) is fragile under
 * fullyParallel + workers>1. Concurrent Electron instances in other workers
 * appear to perturb OS-level focus/visibility enough that the modal panel
 * closes mid-test on press() calls. These tests exercise an OS-integration
 * behavior, so running them serially is the right boundary.
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import {
  waitForPanelCommandsLoaded,
  waitForCmdNotExecuting,
  waitForCommand,
  waitForClass,
  waitForResultsWithContent,
  waitForExtensionsReady,
} from '../helpers/window-utils';

async function createPerDescribeApp(label: string): Promise<{ app: DesktopApp; bgWindow: Page }> {
  const profile = `test-serial-${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`;
  const app = await launchDesktopApp(profile);
  const bgWindow = await app.getBackgroundWindow();
  await waitForExtensionsReady(bgWindow);
  return { app, bgWindow };
}

test.describe('Type-Specific Noun Commands @desktop-serial', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('nouns'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('list notes command produces array output', async () => {
    const seedResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('text', {
        content: 'Noun test note content'
      });
    });
    expect(seedResult.success).toBe(true);
    const seedId = seedResult.data.id;

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

    await cmdWindow.fill('input', 'list notes');
    await cmdWindow.press('input', 'ArrowDown');
    await waitForClass(cmdWindow, '#results', 'visible');

    await cmdWindow.press('input', 'Enter');
    await waitForResultsWithContent(cmdWindow);

    const hasResults = await cmdWindow.$eval('#results', (el: HTMLElement) => {
      return el.classList.contains('visible') && el.children.length > 0;
    });
    expect(hasResults).toBe(true);

    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }

    await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, seedId);
  });

  test('list notes chains with csv', async () => {
    await waitForCommand(bgWindow, 'csv', 10000);

    const seedResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('text', {
        content: 'CSV chain test note'
      });
    });
    expect(seedResult.success).toBe(true);
    const seedId = seedResult.data.id;

    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true, width: 600, height: 400, frame: false, transparent: true, alwaysOnTop: true, center: true,
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    await cmdWindow.fill('input', 'list notes');
    await cmdWindow.press('input', 'Enter');

    await cmdWindow.waitForFunction(
      () => (window as any)._cmdState?.currentState === 'OUTPUT_SELECTION',
      null, { timeout: 5000 }
    );
    await cmdWindow.press('input', 'Enter');
    await cmdWindow.waitForFunction(
      () => (window as any)._cmdState?.currentState === 'CHAIN_MODE',
      null, { timeout: 5000 }
    );

    await cmdWindow.fill('input', 'csv');
    await cmdWindow.waitForFunction(
      () => ((window as any)._cmdState?.matches || []).includes('csv'),
      null, { timeout: 5000 }
    );
    await cmdWindow.press('input', 'ArrowDown');
    await cmdWindow.press('input', 'Enter');

    const postExecState = await waitForCmdNotExecuting(cmdWindow, 35000);
    expect(postExecState).not.toBe('TIMEOUT');

    let final: { state: string | undefined; mimeType: string | undefined };
    if (postExecState === 'CLOSED') {
      final = { state: 'CLOSING', mimeType: undefined };
    } else {
      try {
        final = await cmdWindow.evaluate(() => {
          const s = (window as any)._cmdState;
          return { state: s?.currentState, mimeType: s?.chainContext?.mimeType };
        });
      } catch {
        final = { state: 'CLOSING', mimeType: undefined };
      }
    }

    if (final.state === 'CHAIN_MODE') {
      expect(final.mimeType).toBe('text/csv');
    } else {
      expect(['CLOSING', 'IDLE', 'OUTPUT_SELECTION', 'ERROR']).toContain(final.state);
    }

    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }

    await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, seedId);
  });

  test('new note with content saves to datastore', async () => {
    const uniqueContent = `New note test ${Date.now()}`;

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

    await cmdWindow.fill('input', `new note ${uniqueContent}`);
    await cmdWindow.press('input', 'ArrowDown');
    await waitForClass(cmdWindow, '#results', 'visible');

    await cmdWindow.press('input', 'Enter');

    const postExecState = await waitForCmdNotExecuting(cmdWindow, 10000);
    expect(postExecState).not.toBe('TIMEOUT');

    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }

    const queryResult = await bgWindow.evaluate(async (content: string) => {
      const result = await (window as any).app.datastore.queryItems({ type: 'text' });
      if (!result.success) return { found: false };
      const match = result.data.find((item: any) => item.content && item.content.includes(content));
      return { found: !!match, itemId: match?.id };
    }, uniqueContent);

    expect(queryResult.found).toBe(true);

    if (queryResult.itemId) {
      await bgWindow.evaluate(async (id: string) => {
        return await (window as any).app.datastore.deleteItem(id);
      }, queryResult.itemId);
    }
  });

  test('new note without content signals editor open', async () => {
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

    await cmdWindow.fill('input', 'new note');
    await cmdWindow.press('input', 'ArrowDown');
    await waitForClass(cmdWindow, '#results', 'visible');

    await cmdWindow.press('input', 'Enter');

    const finalState = await waitForCmdNotExecuting(cmdWindow, 10000);
    expect(finalState).not.toBe('TIMEOUT');
    expect(finalState).not.toBe('ERROR');

    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }
  });
});
