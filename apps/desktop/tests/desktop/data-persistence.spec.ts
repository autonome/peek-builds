import { test, expect, launchDesktopApp } from '../fixtures/desktop-app';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// ============================================================================
// Data Persistence Tests (consolidated - single restart for all persistence checks)
// ============================================================================

test.describe('Data Persistence @desktop', () => {
  test('all data persists across restart (peeks, slides, addresses, tags, theme)', async () => {
    const PROFILE = 'test-all-persist-' + Date.now();

    // ========== PHASE 1: Set up all data ==========
    let app = await launchDesktopApp(PROFILE);
    let bgWindow = await app.getBackgroundWindow();

    // --- Peeks and Slides settings ---
    const testPeeks = [
      { title: 'Test Peek 1', uri: 'https://test-peek-1.example.com', shortcut: 'Option+1' },
      { title: 'Test Peek 2', uri: 'https://test-peek-2.example.com', shortcut: 'Option+2' },
      { title: 'Custom Peek', uri: 'https://custom-peek.example.com', shortcut: 'Option+3' }
    ];

    const testSlides = [
      { title: 'Test Slide 1', uri: 'https://test-slide-1.example.com', position: 'right', size: 400 },
      { title: 'Test Slide 2', uri: 'https://test-slide-2.example.com', position: 'bottom', size: 300 }
    ];

    // Save peeks items
    const savePeeksResult = await bgWindow.evaluate(async (items) => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'peeks:items', {
        featureId: 'peeks',
        key: 'items',
        value: JSON.stringify(items),
        updatedAt: Date.now()
      });
    }, testPeeks);
    expect(savePeeksResult.success).toBe(true);

    // Save slides items
    const saveSlidesResult = await bgWindow.evaluate(async (items) => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'slides:items', {
        featureId: 'slides',
        key: 'items',
        value: JSON.stringify(items),
        updatedAt: Date.now()
      });
    }, testSlides);
    expect(saveSlidesResult.success).toBe(true);

    // Save prefs
    const savePeeksPrefs = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'peeks:prefs', {
        featureId: 'peeks',
        key: 'prefs',
        value: JSON.stringify({ shortcutKeyPrefix: 'Option+' }),
        updatedAt: Date.now()
      });
    });
    expect(savePeeksPrefs.success).toBe(true);

    const saveSlidesPrefs = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'slides:prefs', {
        featureId: 'slides',
        key: 'prefs',
        value: JSON.stringify({ defaultPosition: 'right', defaultSize: 350 }),
        updatedAt: Date.now()
      });
    });
    expect(saveSlidesPrefs.success).toBe(true);

    // --- Addresses and Tags ---
    const addr1 = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://persist-test-1.example.com', {
        title: 'Persist Test 1',
        starred: 1
      });
    });
    expect(addr1.success).toBe(true);

    const addr2 = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://persist-test-2.example.com', {
        title: 'Persist Test 2'
      });
    });
    expect(addr2.success).toBe(true);

    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('persist-tag');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.id;

    if (tagId && addr1.data?.id) {
      await bgWindow.evaluate(async ({ addressId, tagId }) => {
        return await (window as any).app.datastore.tagAddress(addressId, tagId);
      }, { addressId: addr1.data.id, tagId });
    }

    // --- Theme ---
    const setThemeResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.setTheme('peek');
    });
    expect(setThemeResult.success).toBe(true);

    // Verify theme is set before restart
    const themeState1 = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });
    expect(themeState1.themeId).toBe('peek');

    // Ensure data is flushed before closing
    await sleep(500);
    await app.close();

    // Wait for app to fully shut down
    await sleep(1000);

    // ========== PHASE 2: Verify all data persisted ==========
    app = await launchDesktopApp(PROFILE);
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow);

    // --- Verify Peeks and Slides ---
    const persistedSettings = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return await api.datastore.getTable('feature_settings');
    });
    expect(persistedSettings.success).toBe(true);

    const settingsData = persistedSettings.data as Record<string, any>;

    // Peeks items
    const peeksItems = settingsData['peeks:items'];
    expect(peeksItems).toBeTruthy();
    expect(peeksItems.featureId).toBe('peeks');
    const parsedPeeks = JSON.parse(peeksItems.value);
    expect(parsedPeeks.length).toBe(3);
    expect(parsedPeeks[0].title).toBe('Test Peek 1');

    // Slides items
    const slidesItems = settingsData['slides:items'];
    expect(slidesItems).toBeTruthy();
    const parsedSlides = JSON.parse(slidesItems.value);
    expect(parsedSlides.length).toBe(2);

    // Peeks prefs
    const peeksPrefs = settingsData['peeks:prefs'];
    expect(peeksPrefs).toBeTruthy();
    const parsedPeeksPrefs = JSON.parse(peeksPrefs.value);
    expect(parsedPeeksPrefs.shortcutKeyPrefix).toBe('Option+');

    // --- Verify Items (addresses are now stored as URL items) ---
    const itemsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryItems({ type: 'url' });
    });
    expect(itemsResult.success).toBe(true);

    const items = itemsResult.data;
    expect(items.length).toBeGreaterThanOrEqual(2);

    const persistedItem1 = items.find((a: any) =>
      a.content === 'https://persist-test-1.example.com/' ||
      a.content?.includes('persist-test-1')
    );
    expect(persistedItem1).toBeTruthy();
    expect(persistedItem1.title).toBe('Persist Test 1');

    const tagsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getTagsByFrecency(10);
    });
    expect(tagsResult.success).toBe(true);
    const persistTag = tagsResult.data.find((t: any) => t.name === 'persist-tag');
    expect(persistTag).toBeTruthy();

    // --- Verify Theme ---
    const themeState2 = await bgWindow.evaluate(async () => {
      return await (window as any).app.theme.get();
    });
    expect(themeState2.themeId).toBe('peek');

    // Open settings window to verify the theme CSS is loaded correctly
    await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://app/settings/settings.html', {
        width: 800, height: 600
      });
    });

    const settingsWin = await app.getWindow('settings/settings.html', 5000);
    expect(settingsWin).toBeTruthy();

    // Check that the theme CSS loaded (non-empty value for --theme-font-sans,
    // which the peek theme defines in variables.css). Fallback would yield an
    // empty string from getPropertyValue. Theme uses system sans proportional;
    // --theme-font-mono is the one with ServerMono.
    const fontVar = await settingsWin.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--theme-font-sans');
    });
    expect(fontVar.trim().length).toBeGreaterThan(0);
    const monoVar = await settingsWin.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--theme-font-mono');
    });
    expect(monoVar).toContain('ServerMono');

    await app.close();
  });
});
