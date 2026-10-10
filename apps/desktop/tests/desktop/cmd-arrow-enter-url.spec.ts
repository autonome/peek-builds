/**
 * Enter on a Visited row reached with ArrowDown opens that row's page, the same
 * as a click on it. Typing text that matches both a command and several visited
 * urls puts the url rows below the command rows; ArrowDown moves the highlight
 * onto a url row that is not the first one.
 *
 * The control types the text that makes one visited url the only match; Enter
 * opens it without any arrowing.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

const URL_A = 'https://data.example.com/dashboard';
const URL_B = 'https://data.example.org/reports';

async function openPanel(app: DesktopApp, bgWindow: Page): Promise<Page> {
  const openResult = await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://cmd/panel.html', {
      key: 'peek://cmd/panel.html',
      modal: true,
      width: 600,
      height: 400,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      center: true,
      keepLive: true,
      role: 'palette',
    });
  });
  expect(openResult.success).toBe(true);

  const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
  await cmdWindow.waitForSelector('input', { timeout: 5000 });
  await waitForPanelCommandsLoaded(cmdWindow);
  await cmdWindow.waitForFunction(
    () => {
      const st = (window as any)._cmdState?.currentState;
      return !!st && st !== 'CLOSING';
    },
    undefined,
    { timeout: 5000 }
  );
  return cmdWindow;
}

async function seedUrls(bgWindow: Page): Promise<void> {
  for (const url of [URL_A, URL_B]) {
    const navResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.datastore.trackNavigation(u, {
        source: 'window',
        windowType: 'main',
      });
    }, url);
    expect(navResult.success).toBe(true);
  }
}

async function watchWindowOpened(bgWindow: Page, urlPart: string): Promise<void> {
  await bgWindow.evaluate((part: string) => {
    (window as any).__arrowEnterOpened = null;
    (window as any).app.subscribe('window:opened', (msg: any) => {
      if (msg?.url && (msg.url.includes(part) || msg.url.includes(encodeURIComponent(part)))) {
        (window as any).__arrowEnterOpened = msg;
      }
    });
  }, urlPart);
}

async function expectWindowOpened(bgWindow: Page): Promise<void> {
  await bgWindow.waitForFunction(
    () => (window as any).__arrowEnterOpened !== null,
    undefined,
    { timeout: 10000 }
  );
}

test.describe('cmd Enter on an arrowed Visited row @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-arrow-enter-url'));
    await seedUrls(bgWindow);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('ArrowDown onto a non-top Visited row then Enter opens that row url', async () => {
    const cmdWindow = await openPanel(app, bgWindow);

    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && !!s.commands?.['datastore'];
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.fill('input', 'data');

    // A command row and both url rows.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) >= 1 && (s.urlMatches?.length || 0) >= 2;
      },
      undefined,
      { timeout: 8000 }
    );

    // ArrowDown until the highlight sits on the second url row.
    const target = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return s.matches.length + 1;
    });
    for (let i = 0; i < target + 1; i++) {
      const done = await cmdWindow.evaluate(
        (t: number) => (window as any)._cmdState.matchIndex === t,
        target
      );
      if (done) break;
      await cmdWindow.keyboard.press('ArrowDown');
    }
    await cmdWindow.waitForFunction(
      (t: number) => (window as any)._cmdState.matchIndex === t,
      target,
      { timeout: 5000 }
    );

    // The highlighted row in the DOM is that url row.
    const expectedUrl = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      const item = s.urlMatches[s.matchIndex - s.matches.length];
      return item ? (item.content as string) : null;
    });
    expect(expectedUrl).toBeTruthy();
    const selectedCount = await cmdWindow.evaluate(
      () => document.querySelectorAll('.url-result-item.selected').length
    );
    expect(selectedCount).toBe(1);

    await watchWindowOpened(bgWindow, expectedUrl as string);
    await cmdWindow.keyboard.press('Enter');
    await expectWindowOpened(bgWindow);
  });
});

test.describe('cmd Enter on the top Visited row @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-top-enter-url'));
    await seedUrls(bgWindow);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('typing until one url is the top result then Enter opens it', async () => {
    const cmdWindow = await openPanel(app, bgWindow);

    await cmdWindow.fill('input', 'data.example.com/dash');

    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) === 0 && (s.urlMatches?.length || 0) >= 1;
      },
      undefined,
      { timeout: 8000 }
    );

    await watchWindowOpened(bgWindow, 'data.example.com');
    await cmdWindow.keyboard.press('Enter');
    await expectWindowOpened(bgWindow);
  });
});
