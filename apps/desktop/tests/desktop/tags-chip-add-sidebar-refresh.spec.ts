/**
 * Regression coverage: clicking an Available Tags chip in the detail view
 * adds the tag to the note (visible immediately in the detail view) but,
 * before the fix, leaves the tag sidebar stale until the window reloads.
 *
 * `addTag()` (the chip click handler) only re-rendered the detail view
 * (`renderCurrentTags` / `renderAvailableTags`); `removeTag()` and
 * `addNewTag()` both also call `renderTagSidebar()`, so the chip path was
 * the one gap. Zero-usage tags are excluded from the sidebar at load time
 * (`loadData`'s in-use filter), so a tag that has never been tagged onto
 * any item is used here — its first-ever use must make it appear in the
 * sidebar without a reload.
 *
 * Since a never-used tag can't reach the Available Tags list through the
 * normal load path (the in-use filter drops it before render), this test
 * injects it into the tags window's exposed debug state (`window._tagsState`,
 * home.js) after the initial render, mirroring the state a tag reaches via
 * home.js's own `tag:created` pubsub handler (which pushes newly created
 * tags into `state.tags` unconditionally, before any usage exists).
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

test.describe('tags/home available-tags chip refreshes sidebar @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tags-chip-sidebar-refresh'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('adding a never-used tag via an available-tags chip shows it in the sidebar immediately', async () => {
    const ts = Date.now();
    const carrierTagName = `carrier-${ts}`;
    const loneTagName = `lone-${ts}`;

    // Seed: an item with one tag (so it renders as a card in the list view —
    // an untagged item is filtered out of the card grid entirely) and a
    // second tag that has never been applied to anything.
    const setup = await bgWindow.evaluate(async ({ carrierName, loneName }: { carrierName: string; loneName: string }) => {
      const api = (window as any).app;
      const carrierTag = await api.datastore.getOrCreateTag(carrierName);
      const loneTag = await api.datastore.getOrCreateTag(loneName);
      const item = await api.datastore.addItem('text', { content: `seed item ${carrierName}` });
      await api.datastore.tagItem(item.data.id, carrierTag.data.tag.id);
      return { itemId: item.data.id, loneTagId: loneTag.data.tag.id };
    }, { carrierName: carrierTagName, loneName: loneTagName });
    expect(setup.itemId).toBeTruthy();
    expect(setup.loneTagId).toBeTruthy();

    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://tags/home.html', {
        width: 900, height: 700, key: 'tags-chip-sidebar-refresh-test',
      });
    });
    expect(open.success).toBe(true);

    const tagsWindow = await app.getWindow('tags/home.html', 10000);
    expect(tagsWindow).toBeTruthy();
    await tagsWindow.waitForLoadState('domcontentloaded');

    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    await tagsWindow.waitForSelector(cardSelector, { timeout: 10000 });

    // Sanity: the never-used tag isn't in the sidebar yet — the initial
    // render happened before we inject it below.
    const sidebarBefore = await tagsWindow.$$eval('.tag-list .tag-name', els => els.map(el => el.textContent));
    expect(sidebarBefore).not.toContain(loneTagName);

    // Inject the never-used tag into the live state the way home.js's own
    // `tag:created` pubsub handler would (push into state.tags with no
    // usage yet) — the in-use filter in loadData() would otherwise strip
    // a zero-usage tag before it ever reaches state.tags.
    await tagsWindow.evaluate(({ id, name }: { id: string; name: string }) => {
      const state = (window as any)._tagsState;
      state.tags.push({ id, name });
    }, { id: setup.loneTagId, name: loneTagName });

    // Open the detail view for the seeded item — this re-renders the
    // available-tags list from the (now-mutated) state.tags, so the
    // never-used tag shows up as a clickable chip.
    await tagsWindow.click(cardSelector);
    const chipSelector = '.available-tags .available-tag';
    await tagsWindow.waitForSelector(chipSelector, { timeout: 10000 });

    const loneChip = tagsWindow.locator(chipSelector).filter({ hasText: loneTagName });
    await expect(loneChip).toHaveCount(1);
    await expect(loneChip).not.toHaveClass(/already-added/);

    await loneChip.click();

    // The detail view reflects the add right away in both cases.
    await expect(tagsWindow.locator('.current-tags .current-tag', { hasText: loneTagName })).toHaveCount(1);

    // The sidebar must show the newly-used tag without any reload.
    await expect
      .poll(
        async () => tagsWindow.$$eval('.tag-list .tag-name', els => els.map(el => el.textContent)),
        { timeout: 5000, message: 'sidebar did not pick up the tag added via the available-tags chip' },
      )
      .toContain(loneTagName);

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });
});
