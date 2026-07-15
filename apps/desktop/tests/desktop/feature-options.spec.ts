/**
 * Feature card affordances in the FEATURES MANAGER.
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
 * Also covers the rest of the card surface, which is fed by the
 * manifest-cache join on `tile:features:list`:
 *   - "Open" — one button per feature declaring a `type: 'window'`
 *     command (tags), none for a feature that declares none (peeks).
 *   - "Reload" — now unconditional, no longer dev-source-only.
 *   - Options schema loading is LAZY: the list render must issue zero
 *     settingsSchema calls.
 *
 * Builtins are included in the manager list, so builtin cards (peeks,
 * tags) are the fixtures here.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Features Manager - per-feature Options @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let manager: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('feature-options'));

    // Open the Features Manager once for the whole describe — every test
    // below reads the same rendered list.
    await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://features-manager/manage.html', {
        key: 'features-manage', width: 900, height: 650,
      });
    });

    manager = await app.getWindow('features-manager/manage.html', 15000);
    await manager.waitForLoadState('domcontentloaded');

    // Wait for the peeks builtin card to render (builtins are merged into the
    // list via api.features.list('builtin')).
    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('peeks feature card shows Options + expanding renders schema-driven prefs', async () => {

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

  // ── Open ──────────────────────────────────────────────────────────
  //
  // The Open button is driven by `openCommand`, resolved in the main
  // process from the manifest cache (feature-list-entries.ts). `tags`
  // declares `open tags` with action.type 'window'; `peeks` declares no
  // commands at all.

  test('tags card shows exactly one Open button, wired to its window command url', async () => {
    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'tags');
    }, { timeout: 15000 });

    const open = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'tags');
      const btns = card ? Array.from(card.querySelectorAll('.feature-open-btn')) : [];
      return {
        count: btns.length,
        label: btns[0]?.textContent?.trim() ?? null,
      };
    });

    expect(open.count,
      'tags declares a type:window command and must render exactly one Open button',
    ).toBe(1);
    expect(open.label).toBe('Open');
  });

  test('peeks card shows NO Open button (declares no commands)', async () => {
    const count = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      return card ? card.querySelectorAll('.feature-open-btn').length : -1;
    });
    expect(count,
      'peeks declares no commands — an Open button here would open nothing',
    ).toBe(0);
  });

  test('every rendered card has at most one Open button', async () => {
    const offenders = await manager.evaluate(() => {
      return Array.from(document.querySelectorAll('.feature-card'))
        .map(c => ({
          id: (c as HTMLElement).dataset.featureId,
          n: c.querySelectorAll('.feature-open-btn').length,
        }))
        .filter(x => x.n > 1);
    });
    expect(offenders, 'a feature declaring several window commands must still get ONE Open button')
      .toEqual([]);
  });

  // ── Reload ────────────────────────────────────────────────────────
  //
  // Regression guard: Reload was gated behind `if (ext.isRunning)` over a
  // hardcoded `isRunning: false` (rendered for zero features), then behind
  // `isDev` (dev-source features only). peeks is a builtin, not dev — if it
  // has a Reload button, the gate is genuinely gone.

  test('Reload renders for every feature, not just dev-source ones', async () => {
    const withoutReload = await manager.evaluate(() => {
      return Array.from(document.querySelectorAll('.feature-card'))
        .filter(c => !c.querySelector('.feature-reload-btn'))
        .map(c => (c as HTMLElement).dataset.featureId);
    });
    expect(withoutReload,
      'REGRESSION: Reload is ungated — every feature card must render one',
    ).toEqual([]);

    const peeksReload = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const btn = card?.querySelector('.feature-reload-btn');
      return { present: !!btn, label: btn?.textContent?.trim() ?? null };
    });
    expect(peeksReload.present,
      'peeks is a builtin (source.type=builtin, not dev) and must still get Reload',
    ).toBe(true);
    expect(peeksReload.label).toBe('Reload');
  });

  // ── Lazy Options schema ───────────────────────────────────────────

  test('rendering the list issues ZERO settingsSchema calls (they are lazy now)', async () => {
    // loadFeatures() used to fan out one api.features.settingsSchema call per
    // feature (~34 builtins), each a sync readFileSync + full manifest
    // validation on the main thread, to return null for the ~24 that declare
    // no schema. The declared schema PATH now rides the list response, so the
    // list render must not touch settingsSchema at all.
    const calls = await manager.evaluate(async () => {
      const api = (window as any).app;
      const original = api.features.settingsSchema;
      let count = 0;
      api.features.settingsSchema = (...args: unknown[]) => {
        count++;
        return original.apply(api.features, args);
      };

      // Mark the current list so we can detect the re-render, then trigger
      // loadFeatures via the refresh topic the page already subscribes to
      // ('feature:updated' is inside features-manager's pubsub allowlist).
      document.querySelector('.feature-list')?.setAttribute('data-stale', '1');
      api.publish('feature:updated', { featureId: 'peeks' });

      // Wait for a fresh .feature-list (render() replaces contentEl wholesale).
      let rerendered = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const list = document.querySelector('.feature-list');
        if (list && !list.hasAttribute('data-stale')) { rerendered = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      // Let any stray in-flight enrichment settle before sampling.
      await new Promise(r => setTimeout(r, 500));

      const cards = document.querySelectorAll('.feature-card').length;
      api.features.settingsSchema = original;
      return { count, cards, rerendered };
    });

    // Guard against a vacuous pass: a zero count means nothing if the list
    // never actually re-rendered under the instrumented api.
    expect(calls.rerendered,
      'the list must have re-rendered for the call count to be meaningful',
    ).toBe(true);
    expect(calls.cards).toBeGreaterThan(0);
    expect(calls.count,
      'REGRESSION: loadFeatures is fanning out per-feature settingsSchema calls again. ' +
      'The schema path comes from the manifest-cache join; contents load on Options expand only.',
    ).toBe(0);
  });

  test('Options toggle still renders from the cached schema path, and expands lazily', async () => {
    // The toggle gate is now `feature.settingsSchema` (the declared relative
    // path from the manifest cache) rather than fetched schema contents.
    // peeks declares one; tags does not.
    const toggles = await manager.evaluate(() => {
      const has = (id: string) => {
        const card = Array.from(document.querySelectorAll('.feature-card'))
          .find(c => (c as HTMLElement).dataset.featureId === id);
        return card ? !!card.querySelector('.feature-options-toggle') : null;
      };
      return { peeks: has('peeks'), tags: has('tags') };
    });
    expect(toggles.peeks, 'peeks declares settingsSchema — Options toggle must render').toBe(true);
    expect(toggles.tags, 'tags declares no settingsSchema — no Options toggle').toBe(false);
  });
});
