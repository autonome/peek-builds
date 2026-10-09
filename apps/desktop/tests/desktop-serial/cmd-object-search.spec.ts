import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

// Typing an option's name at the top level of the command panel offers one row per
// command + option ("zq open zqalpha"); picking that row runs the command with the option.
test.describe('Command panel search by object @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-object-search'));
    await bgWindow.evaluate(() => {
      const api = (window as any).app;
      (window as any).__zqRuns = [];
      const options = ['zqalpha', 'zqbeta', 'zqgamma', 'zqdelta'].map((v) => ({ value: v, title: v }));
      for (const name of ['zq open', 'zq move']) {
        api.commands.register({
          name,
          description: `test ${name}`,
          params: [{ type: 'enum', options }],
          execute: async (ctx: any) => {
            (window as any).__zqRuns.push({ name, params: ctx.params || [], search: ctx.search || '' });
          },
        });
      }
      api.commands.register({
        name: 'zqbeta tool',
        description: 'test command whose name contains an option name',
        execute: async () => {
          (window as any).__zqRuns.push({ name: 'zqbeta tool', params: [], search: '' });
        },
      });
    });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

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
      const cmds = (window as any)._cmdState.commands;
      return !!(cmds['zq open'] && cmds['zq move'] && cmds['zqbeta tool']);
    }, { timeout: 20000 });
    return { panel, id: opened.id };
  }

  async function closePanel(id: number) {
    await bgWindow.evaluate(async (wid: number) => {
      try { await (window as any).app.window.close(wid); } catch (e) { /* may already be closed */ }
    }, id);
  }

  async function rows(panel: Page, expected: string): Promise<string[]> {
    await panel.waitForFunction((t: string) => {
      return Array.from(document.querySelectorAll('#results .command-item .cmd-name'))
        .some((el) => el.textContent === t);
    }, expected, { timeout: 10000 });
    return panel.$$eval('#results .command-item .cmd-name', (els) => els.map((e) => e.textContent || ''));
  }

  async function runs(): Promise<Array<{ name: string; params: string[]; search: string }>> {
    return bgWindow.evaluate(() => (window as any).__zqRuns.slice());
  }

  async function storedUsage(panel: Page): Promise<Record<string, Record<string, number>>> {
    return panel.evaluate(async () => {
      const r = await (window as any).app.settings.get('paramUsage');
      return (r && r.success && r.data) || {};
    });
  }

  test('typed option name shows one row per command and Enter runs the top row with that option', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'zqalp');
    const shown = await rows(panel, 'zq open zqalpha');
    expect(shown).toContain('zq move zqalpha');
    expect(shown.filter((r) => r.startsWith('zq ')).sort()).toEqual(['zq move zqalpha', 'zq open zqalpha']);
    const top = shown[0];
    const command = top.startsWith('zq open') ? 'zq open' : 'zq move';
    await panel.keyboard.press('Enter');
    await expect.poll(runs, { timeout: 10000 }).toContainEqual(
      expect.objectContaining({ name: command, search: 'zqalpha' }));
    await expect.poll(async () => Object.keys((await storedUsage(panel))[command] || {}), { timeout: 5000 })
      .toContain('zqalpha');
    await closePanel(id);
  });

  test('clicking a pair row runs that command with that option', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'zqgam');
    const shown = await rows(panel, 'zq move zqgamma');
    const index = shown.indexOf('zq move zqgamma');
    await panel.locator('#results .command-item').nth(index).click();
    await expect.poll(runs, { timeout: 10000 }).toContainEqual(
      expect.objectContaining({ name: 'zq move', search: 'zqgamma' }));
    await closePanel(id);
  });

  test('pair rows follow command matches unless the option name is typed exactly', async () => {
    const { panel, id } = await openPanel();
    await panel.fill('input', 'zqbet');
    const partial = await rows(panel, 'zq open zqbeta');
    expect(partial[0]).toBe('zqbeta tool');

    await panel.fill('input', 'zqbeta');
    await panel.waitForFunction(() => {
      const first = document.querySelector('#results .command-item .cmd-name');
      return !!first && first.textContent !== 'zqbeta tool';
    }, null, { timeout: 10000 });
    const exact = await panel.$$eval('#results .command-item .cmd-name', (els) => els.map((e) => e.textContent || ''));
    expect(exact.slice(0, 3).sort()).toEqual(['zq move zqbeta', 'zq open zqbeta', 'zqbeta tool'].sort());
    expect(exact[2]).toBe('zqbeta tool');
    await closePanel(id);
  });

  test('a pick in parameter mode ranks the matching pair row first', async () => {
    let { panel, id } = await openPanel();
    await panel.fill('input', 'zq move zqdelta');
    await panel.waitForFunction(() => (window as any)._cmdState.paramCommand === 'zq move', null, { timeout: 10000 });
    await panel.keyboard.press('Enter');
    await expect.poll(runs, { timeout: 10000 }).toContainEqual(
      expect.objectContaining({ name: 'zq move', search: 'zqdelta' }));
    await closePanel(id);

    ({ panel, id } = await openPanel());
    await panel.fill('input', 'zqdel');
    const shown = await rows(panel, 'zq open zqdelta');
    expect(shown.indexOf('zq move zqdelta')).toBeLessThan(shown.indexOf('zq open zqdelta'));
    await closePanel(id);
  });
});
