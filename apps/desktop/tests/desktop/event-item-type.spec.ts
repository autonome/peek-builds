/**
 * Regression coverage: items.type === 'event' must be accepted by the
 * datastore (CHECK constraint allowlist) and getItemDisplayInfo must
 * surface the event icon + a sensible subtitle.
 *
 * First slice of the event-type feature — this guards the foundations
 * (schema + icon) before ICS generation and the cal widget land.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('event item type @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('event-item-type'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('addItem accepts type=event and round-trips', async () => {
    const startsAt = Date.now() + 86_400_000; // tomorrow
    const result = await bgWindow.evaluate(async (ts: number) => {
      return await (window as any).app.datastore.addItem('event', {
        content: 'Coffee with Sam',
        title: 'Coffee with Sam',
        metadata: JSON.stringify({ startsAt: ts }),
      });
    }, startsAt);
    expect(result.success).toBe(true);
    const itemId = result.data?.id;
    expect(itemId).toBeTruthy();

    const fetched = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItem(id);
    }, itemId);
    expect(fetched.success).toBe(true);
    expect(fetched.data?.type).toBe('event');
    expect(fetched.data?.content).toBe('Coffee with Sam');
  });

  test('getItemDisplayInfo returns event icon + start-time subtitle', async () => {
    const startsAt = Date.UTC(2030, 5, 1, 14, 30); // 2030-06-01T14:30Z

    const display = await bgWindow.evaluate(async (ts: number) => {
      const mod = await import('peek://app/lib/card-helpers.js');
      return mod.getItemDisplayInfo({
        type: 'event',
        content: 'Conference',
        title: 'Conference',
        metadata: JSON.stringify({ startsAt: ts }),
      });
    }, startsAt);

    expect(display.itemType).toBe('event');
    expect(display.title).toBe('Conference');
    // Subtitle is locale-formatted; just assert it's non-empty and
    // not the literal 'Event' fallback (since startsAt was provided).
    expect(display.subtitle).toBeTruthy();
    expect(display.subtitle).not.toBe('Event');
    expect(display.faviconUrl).toContain('data:image/svg+xml');
    // U+1F4C5 = 📅 (calendar). Embedded literally in the SVG payload.
    expect(display.faviconUrl).toContain('\u{1F4C5}');
    // Negative check: not the unknown fallback "?".
    expect(display.faviconUrl).not.toMatch(/>\?</);
  });
});
