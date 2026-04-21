import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Peeks @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('peeks'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('add a peek and test it opens', async () => {
    // Add a peek address to the datastore
    const addResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://example.com', {
        title: 'Example Peek',
        description: 'Test peek for smoke tests'
      });
    });
    expect(addResult.success).toBe(true);

    // Verify peeks extension is loaded (hybrid mode: may be iframe or separate window)
    const runningExts = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.list();
    });
    const peeksRunning = runningExts.data?.some((ext: any) => ext.id === 'peeks');
    expect(peeksRunning).toBe(true);

    // Open a peek window for the address we created
    const peekResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        width: 800,
        height: 600,
        key: 'test-peek'
      });
    });
    expect(peekResult.success).toBe(true);

    // Wait for window to open (getWindow polls)
    const peekWindow = await app.getWindow('example.com', 5000);
    expect(peekWindow).toBeTruthy();

    // Close the peek
    if (peekResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, peekResult.id);
    }
  });
});
