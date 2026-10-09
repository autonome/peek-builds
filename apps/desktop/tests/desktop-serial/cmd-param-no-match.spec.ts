import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('Command param with no match @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-param-no-match'));
    // The spaces tile is lazy: running one of its commands wakes it, and it
    // then registers the space-name commands with their parameters.
    await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      await new Promise((resolve) => {
        const resultTopic = `cmd:execute:close space:result:${Date.now()}`;
        api.subscribe(resultTopic, () => resolve(null));
        api.publish('cmd:execute:close space', { search: '', params: [], expectResult: true, resultTopic });
        setTimeout(() => resolve(null), 20000);
      });
    });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  async function spaceTagNames(): Promise<string[]> {
    return bgWindow.evaluate(async () => {
      const r = await (window as any).app.datastore.getTagsByFrecency();
      return ((r?.data || []) as any[]).map((t) => t.name as string);
    });
  }

  async function openPanel(): Promise<{ panel: Page; id: number }> {
    const opened = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true, width: 600, height: 400, frame: false, transparent: true, alwaysOnTop: true, center: true,
      });
    });
    expect(opened.success).toBe(true);
    const panel = await app.getWindow('cmd/panel.html', 5000);
    await panel.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(panel);
    await panel.waitForFunction(() => {
      const c = (window as any)._cmdState.commands['open space'];
      return !!(c && c.params && c.params[0] && c.params[0].createCommand);
    }, { timeout: 20000 });
    return { panel, id: opened.id };
  }

  async function closePanel(id: number) {
    await bgWindow.evaluate(async (wid: number) => {
      try { await (window as any).app.window.close(wid); } catch (e) { /* may already be closed */ }
    }, id);
  }

  async function rows(panel: Page, text: string): Promise<string[]> {
    await panel.waitForFunction((t: string) => {
      return Array.from(document.querySelectorAll('#results .command-item .cmd-name'))
        .some((el) => el.textContent === t);
    }, text, { timeout: 10000 });
    return panel.$$eval('#results .command-item .cmd-name', (els) => els.map((e) => e.textContent || ''));
  }

  test('Enter on the create row creates the typed space', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'open space zzzq');
    expect(await rows(panel, 'Create "zzzq"')).toEqual(['Create "zzzq"']);
    await panel.keyboard.press('Enter');
    await expect.poll(spaceTagNames, { timeout: 15000 }).toContain('space:zzzq');
    await closePanel(id);
  });

  test('clicking the create row creates the typed space', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'open space zzzp');
    expect(await rows(panel, 'Create "zzzp"')).toEqual(['Create "zzzp"']);
    await panel.click('#results .command-item');
    await expect.poll(spaceTagNames, { timeout: 15000 }).toContain('space:zzzp');
    await closePanel(id);
  });

  test('a command without a create path shows a no-match row and Enter creates nothing', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'switch space zzzr');
    expect(await rows(panel, 'No match for "zzzr"')).toEqual(['No match for "zzzr"']);
    await bgWindow.evaluate(() => {
      (window as any).__createRuns = [];
      (window as any).app.subscribe('cmd:execute:create space', (m: any) => {
        (window as any).__createRuns.push(m);
      }, { scope: 'global' });
    });
    await panel.keyboard.press('Enter');
    // Enter still runs the command itself, as before; it just never runs the create command.
    await bgWindow.waitForTimeout(1500);
    expect(await bgWindow.evaluate(() => (window as any).__createRuns.length)).toBe(0);
    // Neither does the command itself create the typed space.
    expect(await spaceTagNames()).not.toContain('space:zzzr');
    await closePanel(id);
  });

  async function runWithResult(command: string, name: string): Promise<any> {
    return bgWindow.evaluate(async ({ command, name }) => {
      const api = (window as any).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${command}:result:${Date.now()}`;
        api.subscribe(resultTopic, (r: any) => resolve(r), { scope: 'global' });
        api.publish(`cmd:execute:${command}`, { search: name, params: [name], expectResult: true, resultTopic });
        setTimeout(() => resolve({ timedOut: true }), 20000);
      });
    }, { command, name });
  }

  test('switch space with an unknown name creates nothing and reports an error', async () => {
    const result = await runWithResult('switch space', 'zzzs');
    expect(result.success).toBe(false);
    expect(result.error).toBe('No space named "zzzs"');
    expect(await spaceTagNames()).not.toContain('space:zzzs');
  });

  test('move to space with an unknown name creates nothing and reports an error', async () => {
    const result = await runWithResult('move to space', 'zzzt');
    expect(result.success).toBe(false);
    expect(result.error).toBe('No space named "zzzt"');
    expect(await spaceTagNames()).not.toContain('space:zzzt');
  });
});
