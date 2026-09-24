/**
 * Features Manager persistence contracts (peek task
 * 6dd88973-b8e9-45dc-8af9-ff46f491e1c5).
 *
 * When feature management moved from Settings into the Features Manager,
 * two persistence contracts had to be carried over verbatim. These specs
 * pin them against the real manage.js product code:
 *
 *  1. Toggling a BUILTIN feature writes the `enabled` flag into the
 *     core-store ITEMS list (feature_settings featureId='core', key='items')
 *     AND publishes `core:feature:toggle` so the bgWindow orchestrator
 *     loads/unloads the tile-backed builtin.
 *
 *  2. Saving a per-feature Option publishes `<shortname>:settings-changed`
 *     (GLOBAL, so the live feature hot-reloads) AND persists to the
 *     feature's own feature_settings namespace.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

async function openManager(app: DesktopApp, bgWindow: Page): Promise<Page> {
  await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://features-manager/manage.html', {
      key: 'features-manage', width: 900, height: 650,
    });
  });
  const manager = await app.getWindow('features-manager/manage.html', 15000);
  await manager.waitForLoadState('domcontentloaded');
  return manager;
}

test.describe('Features Manager - persistence contracts @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('features-manager-persistence'));
  });

  test.afterAll(async () => {
    // The devtools-affordance test attaches detached DevTools. That is not
    // observable headless, but on a real display it would leak windows into
    // the rest of the suite.
    if (app?.evaluateMain) {
      await app.evaluateMain(((electron: typeof import('electron')) => {
        for (const wc of electron.webContents.getAllWebContents()) {
          try {
            if (wc.isDevToolsOpened()) wc.closeDevTools();
          } catch {
            // webContents already gone
          }
        }
      }) as any).catch(() => { /* app already down */ });
    }
    if (app) await app.close();
  });

  /** Resolve once the `windows` card's DevTools button exists in the manager. */
  async function waitForWindowsDevtoolsButton(manager: Page): Promise<void> {
    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'windows');
      return !!card?.querySelector('.feature-devtools-btn');
    }, { timeout: 15000 });
  }

  // Runs first in this describe, before any other test's button clicks move
  // focus elsewhere — the fix focuses the search field only ONCE (guarded),
  // right after the initial feature list render, so this assertion is only
  // meaningful against a freshly opened manager window.
  test('search field is focused once the initial feature list has rendered', async () => {
    const manager = await openManager(app, bgWindow);

    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });

    // search-input is a <peek-input> — the focused element in the light DOM
    // is the host, and the shadow root's own activeElement must be its inner
    // native <input>.
    const focusState = await manager.evaluate(() => {
      const input = document.getElementById('search-input') as any;
      const innerInput = input?.shadowRoot?.querySelector('input') ?? null;
      return {
        activeIsHost: document.activeElement === input,
        shadowActiveIsInner: input?.shadowRoot?.activeElement === innerInput,
      };
    });
    expect(focusState.activeIsHost).toBe(true);
    expect(focusState.shadowActiveIsInner).toBe(true);
  });

  test('builtin toggle writes core-store ITEMS enabled flag + publishes core:feature:toggle', async () => {
    // Seed the core-store ITEMS list with a peeks entry (this is what the
    // bgWindow / old Settings pane would have persisted). The builtin toggle
    // path matches the entry by name (case-insensitive) and flips `enabled`.
    await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const items = [{ id: 'test-peeks', name: 'Peeks', enabled: true }];
      await api.datastore.setRow('feature_settings', 'core:items', {
        featureId: 'core', key: 'items',
        value: JSON.stringify(items), updatedAt: Date.now(),
      });
    });

    // Capture the core:feature:toggle publish from the bgWindow side.
    await bgWindow.evaluate(() => {
      (window as any).__toggleEvents = [];
      (window as any).app.subscribe('core:feature:toggle', (msg: any) => {
        (window as any).__toggleEvents.push(msg);
      });
    });

    const manager = await openManager(app, bgWindow);

    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });

    // Click Disable on the peeks card. Action buttons are <peek-button>
    // (the native <button> lives in shadow DOM), so match on the host's
    // text content and call its public click().
    await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const btn = Array.from(card?.querySelectorAll('peek-button') || [])
        .find(b => (b.textContent || '').trim() === 'Disable') as HTMLElement | undefined;
      (btn as any)?.click();
    });

    // (a) core-store ITEMS row now has peeks enabled=false.
    await manager.waitForTimeout(500);
    const persistedEnabled = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const table = await api.datastore.getTable('feature_settings');
      const row = table.data?.['core:items'];
      if (!row) return undefined;
      const items = JSON.parse(row.value);
      const peeks = items.find((f: any) => (f.name || '').toLowerCase() === 'peeks');
      return peeks?.enabled;
    });
    expect(persistedEnabled).toBe(false);

    // (b) a core:feature:toggle publish fired for peeks, enabled=false.
    const toggleEvents = await bgWindow.evaluate(() => (window as any).__toggleEvents);
    const peeksToggle = toggleEvents.find((m: any) => m.featureId === 'peeks');
    expect(peeksToggle).toBeTruthy();
    expect(peeksToggle.enabled).toBe(false);
  });

  test('options save publishes <shortname>:settings-changed + persists to feature_settings', async () => {
    // Subscribe to peeks:settings-changed on the bgWindow before editing.
    await bgWindow.evaluate(() => {
      (window as any).__peeksSettingsChanged = 0;
      (window as any).app.subscribe('peeks:settings-changed', () => {
        (window as any).__peeksSettingsChanged++;
      });
    });

    const manager = await openManager(app, bgWindow);

    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });

    // Expand the peeks Options panel.
    await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      (card?.querySelector('.feature-options-toggle') as HTMLElement | null)?.click();
    });

    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      return !!panel && panel.style.display !== 'none' && !!panel.querySelector('.form-group peek-input');
    }, { timeout: 10000 });

    // Change the shortcutKeyPrefix prefs input and fire a change event (the
    // save() in renderFeatureOptions runs on 'change'). The control is a
    // <peek-input>; set its .value property and dispatch a composed `change`
    // on its inner native input the way a real edit does.
    const newPrefix = 'Option+Shift+';
    await manager.evaluate((prefix) => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      const input = panel?.querySelector('.form-group peek-input') as any;
      if (input) {
        input.value = prefix;
        const native = input.shadowRoot?.querySelector('input') as HTMLInputElement | null;
        (native ?? input).dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    }, newPrefix);

    // (a) the peeks:settings-changed publish fired.
    await manager.waitForTimeout(500);
    const changedCount = await bgWindow.evaluate(() => (window as any).__peeksSettingsChanged);
    expect(changedCount).toBeGreaterThan(0);

    // (b) the new prefs landed in the peeks feature_settings namespace
    //     (featureId='peeks', key='prefs').
    const persistedPrefix = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const table = await api.datastore.getTable('feature_settings');
      const row = table.data?.['peeks:prefs'];
      if (!row) return undefined;
      return JSON.parse(row.value).shortcutKeyPrefix;
    });
    expect(persistedPrefix).toBe(newPrefix);
  });

  test('typing into an Options text field with the keyboard and blurring persists the value', async () => {
    // Regression coverage for the real editing gesture, not a synthetic
    // dispatchEvent: focus the native <input> inside the peek-input shadow
    // root, type with the keyboard, then blur (Tab). The native `change`
    // fired by the browser on blur is not composed, so it never reaches a
    // host-side `change` listener unless peek-input re-dispatches it.
    await bgWindow.evaluate(() => {
      (window as any).__peeksSettingsChangedTyped = 0;
      (window as any).app.subscribe('peeks:settings-changed', () => {
        (window as any).__peeksSettingsChangedTyped++;
      });
    });

    const manager = await openManager(app, bgWindow);

    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'peeks');
    }, { timeout: 15000 });

    // Expand the peeks Options panel (idempotent — a no-op if it's already
    // open from an earlier test sharing this window via the reused key).
    await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      if (panel && panel.style.display === 'none') {
        (card?.querySelector('.feature-options-toggle') as HTMLElement | null)?.click();
      }
    });

    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'peeks');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      return !!panel && panel.style.display !== 'none' && !!panel.querySelector('.form-group peek-input');
    }, { timeout: 15000 });

    const nativeInput = manager
      .locator('.feature-card[data-feature-id="peeks"] .feature-options-panel .form-group peek-input input')
      .first();

    const newPrefix = 'Option+Ctrl+';
    await nativeInput.click({ clickCount: 3 }); // focus + select existing text
    await manager.keyboard.type(newPrefix);
    await manager.keyboard.press('Tab'); // blur — fires the native change

    // (a) the peeks:settings-changed publish fired.
    await manager.waitForTimeout(500);
    const changedCount = await bgWindow.evaluate(() => (window as any).__peeksSettingsChangedTyped);
    expect(changedCount).toBeGreaterThan(0);

    // (b) the typed value landed in the peeks feature_settings namespace.
    const persistedPrefix = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const table = await api.datastore.getTable('feature_settings');
      const row = table.data?.['peeks:prefs'];
      if (!row) return undefined;
      return JSON.parse(row.value).shortcutKeyPrefix;
    });
    expect(persistedPrefix).toBe(newPrefix);
  });

  // ── DevTools affordance (peek item 621e283f) ──────────────────────────
  //
  // `windows` is the subject because windows-lazy-wake.spec.ts already pins
  // it as non-resident at boot, so "not woken yet" is a fact about the app
  // rather than an assumption of this file.

  test('devtools affordance is disabled for a lazy feature that has not been woken', async () => {
    const manager = await openManager(app, bgWindow);
    await waitForWindowsDevtoolsButton(manager);

    const state = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'windows');
      const btn = card!.querySelector('.feature-devtools-btn') as any;
      return { disabled: btn.disabled, title: btn.title };
    });

    expect(state.disabled).toBe(true);
    expect(state.title).toContain("isn't running");
  });

  test('devtools affordance enables after the tile wakes and resolves success on repeated clicks', async () => {
    const manager = await openManager(app, bgWindow);
    await waitForWindowsDevtoolsButton(manager);

    // Arm the FSM observer BEFORE waking, so the cold-boot READY transition
    // can't race ahead. Same deterministic hook windows-lazy-wake.spec uses.
    const readyPromise = app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.waitForTileState('windows', 'ready', 15000)) as any);

    await app.evaluateMain!(((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    }) as any);

    const transition = (await readyPromise) as { tileId: string; to: string };
    expect(transition.tileId).toBe('windows');
    expect(transition.to).toBe('ready');

    // The state transition itself is already awaited above — what remains is
    // the RENDERER-PROCESS boundary: the `tile:state-changed` publish has to
    // cross from main into the manager's renderer, and a Playwright client
    // has no handle on that delivery from outside. The button's own
    // `disabled` flag IS the post-delivery state, so polling it is reading
    // the end state rather than guessing at a duration; the 15s is a failure
    // deadline, not a settle-wait. The manager is never reloaded here, so
    // only the subscription can flip it.
    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'windows');
      const btn = card?.querySelector('.feature-devtools-btn') as any;
      return !!btn && btn.disabled === false;
    }, { timeout: 15000 });

    // The item reported the "No active tile found" error as intermittent, so
    // one call proves nothing. Assert the IPC result rather than a visible
    // DevTools window — detached DevTools is not observable headless.
    const results = await manager.evaluate(async () => {
      const out: any[] = [];
      for (let i = 0; i < 5; i++) {
        out.push(await (window as any).app.features.devtoolsOpen('windows'));
      }
      return out;
    });

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    }
  });
});
