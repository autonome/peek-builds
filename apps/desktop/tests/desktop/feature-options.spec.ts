/**
 * Per-feature Options affordance in the FEATURES MANAGER.
 *
 * History: feature management was consolidated out of Settings →
 * #section-features into the dedicated Features Manager
 * (peek://features-manager/manage.html) — peek task
 * 6dd88973-b8e9-45dc-8af9-ff46f491e1c5. This spec (formerly driving the
 * deleted Settings Features pane) now asserts the per-feature Options UI
 * renders in its NEW home: each feature card that declares a settings
 * schema (e.g. peeks) gets an "Options" button that, on expand, renders
 * the schema-driven prefs/items controls.
 *
 * Builtins are included in the manager list, so the peeks builtin card is
 * the fixture here.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Features Manager - per-feature Options @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('feature-options'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('peeks feature card shows Options + expanding renders schema-driven prefs', async () => {
    // Open the Features Manager.
    await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://features-manager/manage.html', {
        key: 'features-manage', width: 900, height: 650,
      });
    });

    const manager = await app.getWindow('features-manager/manage.html', 15000);
    await manager.waitForLoadState('domcontentloaded');

    // Wait for the peeks builtin card to render (builtins are merged into the
    // list via api.features.list('builtin')).
    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });

    // The peeks card must expose an Options toggle (it declares a settings schema).
    const hasOptions = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      return !!card?.querySelector('.feature-options-toggle');
    });
    expect(hasOptions).toBe(true);

    // Click Options → panel expands and renders at least one form-section
    // (the schema-driven prefs section).
    await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      (card?.querySelector('.feature-options-toggle') as HTMLElement | null)?.click();
    });

    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      if (!panel || panel.style.display === 'none') return false;
      return !!panel.querySelector('.form-section');
    }, { timeout: 10000 });

    // The prefs section renders the peeks shortcutKeyPrefix control (now a
    // <peek-input>; the native <input> lives in its shadow root).
    const hasPrefsInput = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      return !!panel?.querySelector('.form-group peek-input');
    });
    expect(hasPrefsInput).toBe(true);
  });
});
