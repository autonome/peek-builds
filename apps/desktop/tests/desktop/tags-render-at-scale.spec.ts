/**
 * Tags renders cards at scale — regression lock for the "tags shows no cards"
 * report (fixed in commit 44ed9996).
 *
 * Root cause that this guards against: the tags page used to offer (and persist)
 * a `fit` view mode that packs every filtered item into one no-scroll viewport.
 * With a large tag set (~9.8K items) each cell collapsed to sub-pixel height —
 * the cards were all in the DOM but `offsetHeight === 0`, i.e. invisible. The
 * fix removed `fit` from the tags toolbar (`TAGS_VIEW_MODES`, home.js) and
 * migrates any profile already pinned to `fit` back to the virtualized
 * `columns` default on load (loadViewPrefs, home.js:415).
 *
 * Why the height assertion is load-bearing: a count-only check
 * (`querySelectorAll('peek-card').length > 0`) would have PASSED during the bug,
 * because 9,782 zero-height cards were in the DOM. The bug was height-0, so the
 * non-zero `offsetHeight` assertion is the one that actually catches a regress.
 *
 * Tests:
 *   1. Default `columns` mode renders virtualized, non-zero-height cards at scale.
 *   2. The tags toolbar does NOT offer the `fit` view mode.
 *   3. A profile persisted on the removed `fit` mode migrates to `columns` on load.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// Enough tagged items that the virtual window is a strict subset of the total —
// proves the virtualized path is active (a ~700px window shows ~50 cards).
const ITEM_COUNT = 200;

test.describe('Tags renders cards at scale @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tags-render-at-scale'));

    // Seed ITEM_COUNT items all under one tag so the default (no tag selected)
    // tags view shows them all. The bg window is a core renderer, so
    // api.datastore.* bypasses the per-feature capability check.
    await bgWindow.evaluate(async (n: number) => {
      const api = (window as any).app;
      const tag = await api.datastore.getOrCreateTag('scale-test');
      for (let i = 0; i < n; i++) {
        const item = await api.datastore.addItem('url', {
          content: `https://tags-scale-test-${i}.example.com/`,
          metadata: JSON.stringify({ title: `Scale item ${i}` }),
        });
        await api.datastore.tagItem(item.data.id, tag.data.tag.id);
      }
    }, ITEM_COUNT);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open a fresh tags/home window with a unique workspace key. */
  async function openTags(key: string): Promise<{ window: Page; id: number }> {
    const open = await bgWindow.evaluate(async (k: string) => {
      return await (window as any).app.window.open('peek://tags/home.html', {
        width: 900, height: 700, key: k,
      });
    }, key);
    expect(open.success).toBe(true);
    const window = await app.getWindow('tags/home.html', 10000);
    expect(window).toBeTruthy();
    await window.waitForLoadState('domcontentloaded');
    return { window, id: open.id };
  }

  async function closeWindow(id: number) {
    if (!id) return;
    try {
      await bgWindow.evaluate(async (wid: number) => {
        return await (window as any).app.window.close(wid);
      }, id);
    } catch { /* may already be closed */ }
  }

  test('default columns mode renders virtualized, non-zero-height cards', async () => {
    const { window, id } = await openTags('tags-scale-default');
    try {
      // Cards must actually appear (the regression was zero visible cards).
      await window.waitForSelector('.cards peek-card', { timeout: 15000 });

      // LOAD-BEARING: the bug left thousands of zero-height cards in the DOM,
      // so a count check alone passed. Assert real, non-zero height instead.
      const probe = await window.evaluate(() => {
        const grid = document.querySelector('.cards') as any;
        const cards = Array.from(document.querySelectorAll('.cards peek-card')) as HTMLElement[];
        return {
          viewMode: grid?.viewMode,
          total: grid?.getVirtualItemCount?.(),
          rendered: cards.length,
          firstHeight: cards[0]?.offsetHeight ?? 0,
          minHeight: cards.reduce((m, c) => Math.min(m, c.offsetHeight), Infinity),
        };
      });

      expect(probe.viewMode).toBe('columns');
      // At least the items we seeded (a fresh profile may carry a stray tagged item).
      expect(probe.total).toBeGreaterThanOrEqual(ITEM_COUNT);
      expect(probe.rendered).toBeGreaterThan(0);
      // Virtualized: only a window of cards is in the DOM, not all of them.
      expect(probe.rendered).toBeLessThan(probe.total);
      // The actual regression guard — cards have real height.
      expect(probe.firstHeight).toBeGreaterThan(40);
      expect(probe.minHeight).toBeGreaterThan(40);
    } finally {
      await closeWindow(id);
    }
  });

  test('tags toolbar does not offer the fit view mode', async () => {
    const { window, id } = await openTags('tags-scale-nofit');
    try {
      await window.waitForSelector('.cards peek-card', { timeout: 15000 });

      const toolbar = await window.evaluate(() => {
        const tb = document.querySelector('peek-grid-toolbar') as any;
        const btns = Array.from(
          tb?.shadowRoot?.querySelectorAll('.view-btn') ?? []
        ) as HTMLElement[];
        return {
          viewModes: tb?.viewModes ?? null,
          buttonTitles: btns.map((b) => b.getAttribute('title') || ''),
        };
      });

      // Property contract: tags opts out of fit.
      expect(toolbar.viewModes).not.toContain('fit');
      expect(toolbar.viewModes).toContain('columns');
      // Rendered contract: no view button triggers fit (its title starts "Fit view").
      expect(toolbar.buttonTitles.some((t) => t.startsWith('Fit view'))).toBe(false);
    } finally {
      await closeWindow(id);
    }
  });

  test('a profile persisted on the removed fit mode migrates to columns on load', async () => {
    // This test mutates the shared peek:// localStorage, so it runs last.
    const { window, id } = await openTags('tags-scale-migrate');
    try {
      await window.waitForSelector('.cards peek-card', { timeout: 15000 });

      // Simulate a profile stuck on the old broken mode, then reload so
      // loadViewPrefs() runs the migration at init.
      await window.evaluate(() => {
        localStorage.setItem(
          'viewPrefs',
          JSON.stringify({ viewMode: 'fit', sortBy: 'modified', sortDirection: 'desc' })
        );
      });
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      await window.waitForSelector('.cards peek-card', { timeout: 15000 });

      const probe = await window.evaluate(() => {
        const grid = document.querySelector('.cards') as any;
        const cards = Array.from(document.querySelectorAll('.cards peek-card')) as HTMLElement[];
        let persisted: any = null;
        try { persisted = JSON.parse(localStorage.getItem('viewPrefs') || 'null'); } catch {}
        return {
          gridViewMode: grid?.viewMode,
          persistedViewMode: persisted?.viewMode,
          firstHeight: cards[0]?.offsetHeight ?? 0,
        };
      });

      // Migration both self-heals the live grid and rewrites the persisted pref,
      // so a user already stuck on fit recovers and stays recovered.
      expect(probe.gridViewMode).toBe('columns');
      expect(probe.persistedViewMode).toBe('columns');
      expect(probe.firstHeight).toBeGreaterThan(40);
    } finally {
      await closeWindow(id);
    }
  });
});
