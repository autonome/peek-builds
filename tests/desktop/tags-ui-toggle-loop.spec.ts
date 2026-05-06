/**
 * tags/home toggle UI — 10-toggle e2e loop.
 *
 * Earlier specs covered the rule engine, the bg-tile + datastore
 * path, and cross-window event delivery. This one is the full UI
 * stack: real click on the rendered checkbox button, real
 * affordance:click publish, real bg-tile swap, real tag events,
 * real re-render.
 *
 * After every click we assert:
 *   - the toggle's visual state (checked / unchecked)
 *   - the DB tag set on the item
 *   - the item still appears in tags/home (it should — the window
 *     isn't filtered by `todo` or `done`)
 *
 * Repeat 10 times. Any flake or off-by-one in the click→event→
 * re-render path surfaces here.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

const TOGGLES = 10;

test.describe('tags/home toggle UI loop @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tags-ui-toggle-loop'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test(`${TOGGLES} clicks on the rendered toggle flip checked-state + DB tags consistently`, async () => {
    const ts = Date.now();
    const testUri = `https://tags-ui-toggle-${ts}.example.com/`;

    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      await api.datastore.getOrCreateTag('done');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'tags-ui toggle test' }),
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);
      return { itemId: item.data.id };
    }, testUri);
    expect(setup.itemId).toBeTruthy();

    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://tags/home.html', {
        width: 900, height: 700, key: 'tags-ui-toggle-test',
      });
    });
    expect(open.success).toBe(true);

    const tagsWindow = await app.getWindow('tags/home.html', 10000);
    expect(tagsWindow).toBeTruthy();
    await tagsWindow.waitForLoadState('domcontentloaded');

    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    const toggleSelector = `${cardSelector} .tag-action-affordances .tag-action-toggle`;

    await tagsWindow.waitForSelector(cardSelector, { timeout: 10000 });
    await tagsWindow.waitForSelector(toggleSelector, { timeout: 10000 });

    async function visualChecked(): Promise<boolean> {
      return await tagsWindow.$eval(toggleSelector, (el) => el.classList.contains('checked'));
    }

    async function tagsOnItem(): Promise<string[]> {
      return await bgWindow.evaluate(async (id: string) => {
        const r = await (window as any).app.datastore.getItemTags(id);
        return r.success ? r.data.map((t: any) => t.name).sort() : [];
      }, setup.itemId);
    }

    // Sanity: starting state.
    expect(await visualChecked(), 'starts unchecked (item has todo, not done)').toBe(false);
    expect(await tagsOnItem()).toEqual(['todo']);

    for (let i = 0; i < TOGGLES; i++) {
      const willCheck = !(await visualChecked()); // flip from current state
      const expectedTags = willCheck ? ['done'] : ['todo'];

      await tagsWindow.click(toggleSelector);

      // Wait for the visual state to land first (optimistic flip is
      // synchronous; this should be near-instant).
      await tagsWindow.waitForFunction(
        ({ sel, want }) => {
          const btn = document.querySelector(sel) as HTMLElement | null;
          return btn?.classList.contains('checked') === want;
        },
        { sel: toggleSelector, want: willCheck },
        { timeout: 5000 },
      );

      // Then wait for the DB to converge — the bg tile may need a
      // moment on cold-start for the very first click.
      await expect.poll(
        async () => tagsOnItem(),
        { timeout: 8000, message: `toggle #${i + 1}: DB tags didn't converge` },
      ).toEqual(expectedTags);

      // Card should still be present in tags/home (the window is the
      // global tag browser, not filtered).
      const stillPresent = await tagsWindow.$$eval(cardSelector, els => els.length);
      expect(stillPresent, `toggle #${i + 1}: card disappeared from tags/home`).toBe(1);

      // Visual + DB consistency — visual must match what we asserted
      // above (no rebuild between the visual wait and now).
      expect(await visualChecked(), `toggle #${i + 1}: visual mismatch`).toBe(willCheck);
    }

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });
});
