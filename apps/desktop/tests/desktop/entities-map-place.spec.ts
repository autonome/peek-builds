import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

// ============================================================================
// A saved map link becomes a place (@desktop)
//
// Saving a URL item fires the entities feature's `item:created` rule, which wakes its
// sleeping background tile. A map page's HTML holds no structured place data, so the
// place is read from the URL itself — before, and independently of, the page fetch.
// This is a full Google Maps place URL, so no redirect has to be followed.
//
// The tile debounces extraction by 2s and may attempt a page fetch that has nothing to
// contribute, so every assertion here polls.
// ============================================================================

const MAP_URL = 'https://www.google.com/maps/place/Rijksmuseum/@52.3600,4.8852,17z/data=!3m1!4b1';
const PLACE_NAME = 'Rijksmuseum';
const EXTRACTION_TIMEOUT_MS = 30000;

type PlaceEntity = {
  id: string;
  content: string;
  attributes: Record<string, unknown>;
  entityType: string;
  extractor: string;
};

test.describe('A saved map link becomes a place @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('entities-map-place'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  async function saveMapUrl(): Promise<void> {
    const saved = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.addItem('url', {
        content: url,
        title: 'Rijksmuseum - Google Maps',
      });
    }, MAP_URL);
    expect(saved.success).toBe(true);
  }

  async function placesNamed(name: string): Promise<PlaceEntity[]> {
    return await bgWindow.evaluate(async (wanted: string) => {
      const res = await (window as any).app.datastore.queryItems({ type: 'entity' });
      const items = res?.data || [];
      return items
        .filter((item: any) => item.content === wanted)
        .map((item: any) => {
          let metadata: any = {};
          try {
            metadata = item.metadata ? JSON.parse(item.metadata) : {};
          } catch {
            metadata = {};
          }
          return {
            id: item.id,
            content: item.content,
            attributes: metadata.attributes || {},
            entityType: metadata.entityType || '',
            extractor: metadata.extractor || '',
          };
        });
    }, name);
  }

  test('the place, its coordinates, its tag and its observation all come from the URL', async () => {
    await saveMapUrl();

    await expect
      .poll(async () => (await placesNamed(PLACE_NAME)).length, { timeout: EXTRACTION_TIMEOUT_MS })
      .toBe(1);

    const [place] = await placesNamed(PLACE_NAME);
    expect(place.entityType).toBe('place');
    expect(place.extractor).toBe('map-url');
    expect(place.attributes.latitude).toBe(52.36);
    expect(place.attributes.longitude).toBe(4.8852);
    expect(place.attributes.mapProvider).toBe('google');
    expect(place.attributes.mapUrl).toBe(MAP_URL);

    const tags = await bgWindow.evaluate(async (id: string) => {
      const res = await (window as any).app.datastore.getItemTags(id);
      return (res?.data || []).map((tag: any) => tag.name || tag.tag?.name);
    }, place.id);
    expect(tags).toContain('entity:place');

    // The observation records the URL as saved.
    const observationUrls = await bgWindow.evaluate(async (id: string) => {
      const res = await (window as any).app.datastore.queryItemEvents({
        itemId: id,
        limit: 50,
        order: 'desc',
      });
      return (res?.data || []).map((evt: any) => evt.content);
    }, place.id);
    expect(observationUrls).toContain(MAP_URL);
  });

  test('saving the same URL again creates no second place', async () => {
    await saveMapUrl();

    // Give a second extraction the same room the first one had before re-counting.
    await bgWindow.waitForTimeout(6000);
    expect((await placesNamed(PLACE_NAME)).length).toBe(1);
  });
});
