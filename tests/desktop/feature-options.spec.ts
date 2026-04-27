/**
 * Regression: per-feature Options accordion in Settings → Features.
 *
 * Bug surfaced 2026-04-26: features with `settingsSchema` declared in
 * their manifest (e.g. peeks) had no expandable Options bit. Cause —
 * `app/settings/settings.js::refreshFeaturesList` constructed each
 * feature's `manifest` object without a `schemas` field, then gated the
 * accordion on `manifest.schemas && (manifest.schemas.prefs || manifest.schemas.item)`,
 * so the gate was always false. Fix: fetch each feature's schema via
 * `api.features.settingsSchema(id)` and populate `manifest.schemas`
 * (+ storageKeys + defaults) from it.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Settings - per-feature Options @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('feature-options'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('peeks feature card shows Options accordion + expanding renders prefs', async () => {
    // Open settings
    await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://app/settings/settings.html', {
        width: 900, height: 700,
      });
    });

    const settingsWindow = await app.getWindow('settings/settings.html', 10000);
    await settingsWindow.waitForLoadState('domcontentloaded');
    await settingsWindow.waitForSelector('#section-features', { state: 'attached', timeout: 10000 });

    // Switch to Features section
    await settingsWindow.evaluate(() => {
      const link = Array.from(document.querySelectorAll('.nav-item'))
        .find(a => (a as HTMLElement).textContent === 'Features') as HTMLElement | undefined;
      link?.click();
    });

    // Wait for features list to populate (async after section render).
    // We look for the peeks card title text inside the features list.
    await settingsWindow.waitForFunction(() => {
      const titles = Array.from(document.querySelectorAll('#section-features .item-card-title'));
      return titles.some(t => (t.textContent || '').trim().startsWith('Peeks'));
    }, { timeout: 15000 });

    // Find the peeks card and assert it has an Options toggle.
    const hasOptionsToggle = await settingsWindow.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#section-features .item-card'));
      const peeksCard = cards.find(c => {
        const title = c.querySelector('.item-card-title');
        return title && (title.textContent || '').trim().startsWith('Peeks');
      });
      if (!peeksCard) return null;
      const toggle = peeksCard.querySelector('.ext-options-toggle');
      return !!toggle;
    });
    expect(hasOptionsToggle).toBe(true);

    // Click the Options toggle and confirm the content panel becomes visible
    // and renders at least one form-section (the prefs section from the schema).
    await settingsWindow.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#section-features .item-card'));
      const peeksCard = cards.find(c => {
        const title = c.querySelector('.item-card-title');
        return title && (title.textContent || '').trim().startsWith('Peeks');
      });
      const toggle = peeksCard?.querySelector('.ext-options-toggle') as HTMLElement | null;
      toggle?.click();
    });

    await settingsWindow.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#section-features .item-card'));
      const peeksCard = cards.find(c => {
        const title = c.querySelector('.item-card-title');
        return title && (title.textContent || '').trim().startsWith('Peeks');
      });
      const content = peeksCard?.querySelector('.ext-options-content') as HTMLElement | null;
      if (!content || content.style.display === 'none') return false;
      // Schema-driven content has at least one form-section (prefs or items).
      return !!content.querySelector('.form-section');
    }, { timeout: 5000 });

    // Per-item peek cards inside the Options accordion must show an
    // expand/collapse arrow (▶/▼) via .item-card-title::before. Regression
    // protection: a descendant `.item-card.no-collapse .item-card-title::before
    // { content: none }` rule used to cascade into these nested titles and
    // strip the arrow.
    const arrow = await settingsWindow.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#section-features .item-card'));
      const peeksCard = cards.find(c => {
        const title = c.querySelector('.item-card-title');
        return title && (title.textContent || '').trim().startsWith('Peeks');
      });
      const content = peeksCard?.querySelector('.ext-options-content') as HTMLElement | null;
      const innerCard = content?.querySelector('.item-card');
      const title = innerCard?.querySelector('.item-card-title') as HTMLElement | null;
      return title ? getComputedStyle(title, '::before').content : null;
    });
    // CSS escape `\25B6 ` parses the trailing space as terminator → "▶".
    expect(['"▶"', '"▼"']).toContain(arrow);
  });
});
