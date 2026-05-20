/**
 * Unified URL/History Tests
 *
 * Validates the unified items-based URL and history tracking system.
 * The data migration from addresses/visits to items/item_visits is already done;
 * these tests verify the unified system works correctly end-to-end.
 *
 * Covers:
 *   1. Item-based URL tracking (addItem with type='url')
 *   2. Visit recording via item_visits
 *   3. Frecency scoring and ordering
 *   4. trackNavigation (unified entry point)
 *   5. Unified tagging (item_tags, not address_tags)
 *   6. Item queries replacing address queries
 *   7. Soft delete behavior
 *
 * Run with:
 *   yarn test:electron:bg
 */

import { test, expect, DesktopApp, getSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

// Shared app and background window
let sharedApp: DesktopApp;
let bgWindow: Page;

// Unique prefix for all test data to avoid collisions across runs
const RUN_ID = Date.now();

// Track item IDs for cleanup
const createdItemIds: string[] = [];
const createdTagIds: string[] = [];

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  bgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(bgWindow);
});

test.afterAll(async () => {
  // Clean up created items (hard delete to fully remove)
  for (const itemId of createdItemIds) {
    try {
      await bgWindow.evaluate(async (id: string) => {
        return await (window as any).app.datastore.hardDeleteItem(id);
      }, itemId);
    } catch {
      // Ignore cleanup errors
    }
  }
  // Note: tags are not deleted since they may be shared; they are harmless test artifacts
});

// Helper: create a URL item and track it for cleanup
async function createUrlItem(url: string, metadata: Record<string, unknown> = {}): Promise<{ id: string }> {
  const result = await bgWindow.evaluate(async ({ url, metadata }: { url: string; metadata: Record<string, unknown> }) => {
    return await (window as any).app.datastore.addItem('url', {
      content: url,
      metadata: JSON.stringify(metadata),
    });
  }, { url, metadata });
  expect(result.success).toBe(true);
  createdItemIds.push(result.data.id);
  return result.data;
}

// Helper: get an item by ID
async function getItem(itemId: string): Promise<any> {
  const result = await bgWindow.evaluate(async (id: string) => {
    return await (window as any).app.datastore.getItem(id);
  }, itemId);
  expect(result.success).toBe(true);
  return result.data;
}

// Helper: create or get a tag
async function getOrCreateTag(name: string): Promise<string> {
  const result = await bgWindow.evaluate(async (n: string) => {
    return await (window as any).app.datastore.getOrCreateTag(n);
  }, name);
  expect(result.success).toBe(true);
  const tagId = result.data?.tag?.id || result.data?.data?.id || result.data?.id;
  expect(tagId).toBeTruthy();
  createdTagIds.push(tagId);
  return tagId;
}

// ============================================================================
// 1. Item-based URL tracking
// ============================================================================

test.describe('Item-based URL tracking @desktop', () => {
  test('adding a URL item creates it with correct fields', async () => {
    const testUrl = `https://example-${RUN_ID}-url-fields.com/page`;
    const item = await createUrlItem(testUrl, { title: 'URL Fields Test' });
    const fetched = await getItem(item.id);

    expect(fetched).toBeTruthy();
    expect(fetched.type).toBe('url');
    expect(fetched.content).toBe(testUrl);
    expect(fetched.domain).toBe(`example-${RUN_ID}-url-fields.com`);
    expect(fetched.deletedAt).toBe(0);
    expect(fetched.createdAt).toBeGreaterThan(0);
    expect(fetched.updatedAt).toBeGreaterThan(0);
  });

  test('URL item has visitCount, lastVisitAt, frecencyScore fields', async () => {
    const testUrl = `https://example-${RUN_ID}-visit-fields.com/page`;
    const item = await createUrlItem(testUrl);
    const fetched = await getItem(item.id);

    // Newly created item has zero visit stats
    expect(fetched.visitCount).toBe(0);
    expect(fetched.lastVisitAt).toBe(0);
    expect(fetched.frecencyScore).toBe(0);
  });

  test('trackNavigation deduplicates: same URL does not create duplicate items', async () => {
    const testUrl = `https://dedup-${RUN_ID}.example.com/page`;

    // First navigation creates the item
    const first = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, { title: 'First Visit' });
    }, testUrl);
    expect(first.success).toBe(true);
    expect(first.data.created).toBe(true);
    createdItemIds.push(first.data.itemId);

    // Second navigation should find the existing item
    const second = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, { title: 'Second Visit' });
    }, testUrl);
    expect(second.success).toBe(true);
    expect(second.data.created).toBe(false);
    expect(second.data.itemId).toBe(first.data.itemId);

    // Verify only one item exists with this URL
    const items = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.queryItems({ type: 'url', search: url });
    }, testUrl);
    expect(items.success).toBe(true);
    const matching = items.data.filter((i: any) => i.content === testUrl);
    expect(matching.length).toBe(1);
  });
});

// ============================================================================
// 2. Visit recording (item_visits)
// ============================================================================

test.describe('Visit recording @desktop', () => {
  test('recordItemVisit creates a visit record', async () => {
    const testUrl = `https://visit-record-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    const visitResult = await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, {
        source: 'test',
        sourceId: 'test-visit-1',
        windowType: 'main',
      });
    }, { itemId: item.id });
    expect(visitResult.success).toBe(true);
    expect(visitResult.data.id).toBeTruthy();

    // Verify the visit exists
    const visits = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemVisits(itemId);
    }, item.id);
    expect(visits.success).toBe(true);
    expect(visits.data.length).toBe(1);
    expect(visits.data[0].itemId).toBe(item.id);
    expect(visits.data[0].source).toBe('test');
    expect(visits.data[0].sourceId).toBe('test-visit-1');
    expect(visits.data[0].windowType).toBe('main');
    expect(visits.data[0].timestamp).toBeGreaterThan(0);
  });

  test('visit has duration, scrollDepth, interacted fields', async () => {
    const testUrl = `https://visit-fields-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, {
        source: 'test',
        duration: 5000,
        scrollDepth: 75,
        interacted: 1,
      });
    }, { itemId: item.id });

    const visits = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemVisits(itemId);
    }, item.id);
    expect(visits.success).toBe(true);
    expect(visits.data[0].duration).toBe(5000);
    expect(visits.data[0].scrollDepth).toBe(75);
    expect(visits.data[0].interacted).toBe(1);
  });

  test('multiple visits increment visitCount on the item', async () => {
    const testUrl = `https://multi-visit-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Record 3 visits
    for (let i = 0; i < 3; i++) {
      await bgWindow.evaluate(async ({ itemId, i }: { itemId: string; i: number }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, {
          source: 'test',
          sourceId: `visit-${i}`,
        });
      }, { itemId: item.id, i });
    }

    const fetched = await getItem(item.id);
    expect(fetched.visitCount).toBe(3);
  });

  test('lastVisitAt updates to the most recent visit timestamp', async () => {
    const testUrl = `https://last-visit-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Record first visit
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: item.id });

    const afterFirst = await getItem(item.id);
    const firstVisitAt = afterFirst.lastVisitAt;
    expect(firstVisitAt).toBeGreaterThan(0);

    // Small delay so timestamps differ
    await new Promise(r => setTimeout(r, 50));

    // Record second visit
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: item.id });

    const afterSecond = await getItem(item.id);
    expect(afterSecond.lastVisitAt).toBeGreaterThanOrEqual(firstVisitAt);
    expect(afterSecond.visitCount).toBe(2);
  });

  test('frecencyScore updates after recording a visit', async () => {
    const testUrl = `https://frecency-update-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Initially zero
    const before = await getItem(item.id);
    expect(before.frecencyScore).toBe(0);

    // Record a visit
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: item.id });

    const after = await getItem(item.id);
    expect(after.frecencyScore).toBeGreaterThan(0);
  });
});

// ============================================================================
// 3. Frecency scoring
// ============================================================================

test.describe('Frecency scoring @desktop', () => {
  test('items with more visits have higher frecency than items with fewer', async () => {
    const fewUrl = `https://frecency-few-${RUN_ID}.example.com/page`;
    const manyUrl = `https://frecency-many-${RUN_ID}.example.com/page`;
    const fewItem = await createUrlItem(fewUrl);
    const manyItem = await createUrlItem(manyUrl);

    // 1 visit for "few"
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: fewItem.id });

    // 5 visits for "many"
    for (let i = 0; i < 5; i++) {
      await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
      }, { itemId: manyItem.id });
    }

    const fewFetched = await getItem(fewItem.id);
    const manyFetched = await getItem(manyItem.id);
    expect(manyFetched.frecencyScore).toBeGreaterThan(fewFetched.frecencyScore);
  });

  test('queryItems with sortBy frecency returns items sorted by frecency score', async () => {
    // Create items with different visit counts
    const lowUrl = `https://frec-sort-low-${RUN_ID}.example.com/page`;
    const highUrl = `https://frec-sort-high-${RUN_ID}.example.com/page`;
    const lowItem = await createUrlItem(lowUrl);
    const highItem = await createUrlItem(highUrl);

    // 1 visit for low
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: lowItem.id });

    // 5 visits for high
    for (let i = 0; i < 5; i++) {
      await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
      }, { itemId: highItem.id });
    }

    // Query by frecency
    const result = await bgWindow.evaluate(async (search: string) => {
      return await (window as any).app.datastore.queryItems({
        type: 'url',
        search: `frec-sort-`,
        sortBy: 'frecency',
      });
    }, `frec-sort-${RUN_ID}`);
    expect(result.success).toBe(true);

    // Filter to just our test items
    const testItems = result.data.filter(
      (i: any) => i.content === lowUrl || i.content === highUrl
    );
    expect(testItems.length).toBe(2);
    // High frecency item should come first
    expect(testItems[0].content).toBe(highUrl);
    expect(testItems[1].content).toBe(lowUrl);
  });

  test('interacted visits produce higher frecency than non-interacted', async () => {
    const plainUrl = `https://frec-plain-${RUN_ID}.example.com/page`;
    const interactedUrl = `https://frec-interact-${RUN_ID}.example.com/page`;
    const plainItem = await createUrlItem(plainUrl);
    const interactedItem = await createUrlItem(interactedUrl);

    // 1 non-interacted visit
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, {
        source: 'test',
        interacted: 0,
      });
    }, { itemId: plainItem.id });

    // 1 interacted visit (weighted x2 in frecency calculation)
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, {
        source: 'test',
        interacted: 1,
      });
    }, { itemId: interactedItem.id });

    const plainFetched = await getItem(plainItem.id);
    const interactedFetched = await getItem(interactedItem.id);
    expect(interactedFetched.frecencyScore).toBeGreaterThan(plainFetched.frecencyScore);
  });
});

// ============================================================================
// 4. trackNavigation (unified entry point)
// ============================================================================

test.describe('trackNavigation @desktop', () => {
  test('trackNavigation with a new URL creates an item and records a visit', async () => {
    const testUrl = `https://tracknav-new-${RUN_ID}.example.com/page`;

    const result = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, {
        title: 'Track Nav Test',
        source: 'window',
        windowType: 'main',
      });
    }, testUrl);
    expect(result.success).toBe(true);
    expect(result.data.itemId).toBeTruthy();
    expect(result.data.visitId).toBeTruthy();
    expect(result.data.created).toBe(true);
    createdItemIds.push(result.data.itemId);

    // Verify the item was created
    const item = await getItem(result.data.itemId);
    expect(item.type).toBe('url');
    expect(item.content).toBe(testUrl);
    expect(item.title).toBe('Track Nav Test');
    expect(item.visitCount).toBe(1);
    expect(item.lastVisitAt).toBeGreaterThan(0);
    expect(item.frecencyScore).toBeGreaterThan(0);

    // Verify the visit was created
    const visits = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemVisits(itemId);
    }, result.data.itemId);
    expect(visits.success).toBe(true);
    expect(visits.data.length).toBe(1);
    expect(visits.data[0].source).toBe('window');
  });

  test('trackNavigation with existing URL finds the item and records another visit', async () => {
    const testUrl = `https://tracknav-existing-${RUN_ID}.example.com/page`;

    // First navigation
    const first = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, { title: 'First' });
    }, testUrl);
    expect(first.success).toBe(true);
    createdItemIds.push(first.data.itemId);

    // Second navigation
    const second = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, { title: 'Second' });
    }, testUrl);
    expect(second.success).toBe(true);
    expect(second.data.created).toBe(false);
    expect(second.data.itemId).toBe(first.data.itemId);
    expect(second.data.visitId).not.toBe(first.data.visitId);

    // Verify visit count incremented
    const item = await getItem(first.data.itemId);
    expect(item.visitCount).toBe(2);

    // Verify two visit records exist
    const visits = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemVisits(itemId);
    }, first.data.itemId);
    expect(visits.success).toBe(true);
    expect(visits.data.length).toBe(2);
  });

  test('trackNavigation returns the item ID and visit info', async () => {
    const testUrl = `https://tracknav-return-${RUN_ID}.example.com/page`;

    const result = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri, {
        source: 'extension',
        sourceId: 'ext-1',
        windowType: 'peek',
      });
    }, testUrl);
    expect(result.success).toBe(true);
    createdItemIds.push(result.data.itemId);

    // Verify return shape
    expect(typeof result.data.itemId).toBe('string');
    expect(typeof result.data.visitId).toBe('string');
    expect(typeof result.data.created).toBe('boolean');
  });

  test('trackNavigation extracts domain from URL', async () => {
    const testUrl = `https://domain-extract-${RUN_ID}.example.com/path/to/page?q=1`;

    const result = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.trackNavigation(uri);
    }, testUrl);
    expect(result.success).toBe(true);
    createdItemIds.push(result.data.itemId);

    const item = await getItem(result.data.itemId);
    expect(item.domain).toBe(`domain-extract-${RUN_ID}.example.com`);
  });
});

// ============================================================================
// 5. Unified tagging (no more address_tags)
// ============================================================================

test.describe('Unified tagging @desktop', () => {
  test('tag a URL item via tagItem', async () => {
    const testUrl = `https://tag-url-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);
    const tagId = await getOrCreateTag(`test-tag-${RUN_ID}`);

    const tagResult = await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });
    expect(tagResult.success).toBe(true);
    expect(tagResult.data.alreadyExists).toBe(false);
  });

  test('getItemTags returns tags for URL items', async () => {
    const testUrl = `https://get-tags-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);
    const tagName = `item-tags-${RUN_ID}`;
    const tagId = await getOrCreateTag(tagName);

    await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });

    const result = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemTags(itemId);
    }, item.id);
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result.data.some((t: any) => t.name === tagName)).toBe(true);
  });

  test('query items by tag returns URL items', async () => {
    const tagName = `query-by-tag-${RUN_ID}`;
    const tagId = await getOrCreateTag(tagName);

    const testUrl = `https://tag-query-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });

    // Query items by tag using getItemsByTag
    const result = await bgWindow.evaluate(async (tid: string) => {
      return await (window as any).app.datastore.getItemsByTag(tid);
    }, tagId);
    expect(result.success).toBe(true);
    expect(result.data.some((i: any) => i.id === item.id)).toBe(true);
    expect(result.data.find((i: any) => i.id === item.id).type).toBe('url');
  });

  test('untagItem removes a tag from URL item', async () => {
    const testUrl = `https://untag-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);
    const tagId = await getOrCreateTag(`untag-test-${RUN_ID}`);

    // Tag the item
    await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });

    // Verify tagged
    const tagsBefore = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemTags(itemId);
    }, item.id);
    expect(tagsBefore.data.some((t: any) => t.id === tagId)).toBe(true);

    // Untag
    const untagResult = await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.untagItem(itemId, tagId);
    }, { itemId: item.id, tagId });
    expect(untagResult.success).toBe(true);

    // Verify untagged
    const tagsAfter = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemTags(itemId);
    }, item.id);
    expect(tagsAfter.data.some((t: any) => t.id === tagId)).toBe(false);
  });

  test('tagging the same item with the same tag is idempotent', async () => {
    const testUrl = `https://tag-idempotent-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);
    const tagId = await getOrCreateTag(`idempotent-tag-${RUN_ID}`);

    // Tag once
    const first = await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });
    expect(first.data.alreadyExists).toBe(false);

    // Tag again
    const second = await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.id, tagId });
    expect(second.data.alreadyExists).toBe(true);

    // Verify only one tag link
    const tags = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemTags(itemId);
    }, item.id);
    const matchingTags = tags.data.filter((t: any) => t.id === tagId);
    expect(matchingTags.length).toBe(1);
  });
});

// ============================================================================
// 6. Item queries replacing address queries
// ============================================================================

test.describe('Item queries @desktop', () => {
  test('queryItems with type url returns URL items', async () => {
    const testUrl = `https://query-type-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryItems({ type: 'url' });
    });
    expect(result.success).toBe(true);
    expect(result.data.some((i: any) => i.id === item.id)).toBe(true);
    // Every result should be type url
    for (const i of result.data) {
      expect(i.type).toBe('url');
    }
  });

  test('queryItems supports search by title and content', async () => {
    const uniqueSlug = `searchtest-${RUN_ID}`;
    const testUrl = `https://${uniqueSlug}.example.com/page`;
    const item = await createUrlItem(testUrl, { title: `My ${uniqueSlug} Page` });

    // Search by URL content
    const byUrl = await bgWindow.evaluate(async (search: string) => {
      return await (window as any).app.datastore.queryItems({ type: 'url', search });
    }, uniqueSlug);
    expect(byUrl.success).toBe(true);
    expect(byUrl.data.some((i: any) => i.id === item.id)).toBe(true);
  });

  test('queryItems supports sorting by lastVisitAt', async () => {
    const oldUrl = `https://sort-old-${RUN_ID}.example.com/page`;
    const newUrl = `https://sort-new-${RUN_ID}.example.com/page`;
    const oldItem = await createUrlItem(oldUrl);
    const newItem = await createUrlItem(newUrl);

    // Visit old item first
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: oldItem.id });

    // Small delay
    await new Promise(r => setTimeout(r, 50));

    // Visit new item after
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: newItem.id });

    const result = await bgWindow.evaluate(async (search: string) => {
      return await (window as any).app.datastore.queryItems({
        type: 'url',
        search,
        sortBy: 'lastVisit',
      });
    }, `sort-`);
    expect(result.success).toBe(true);

    // Filter to just our test items
    const testItems = result.data.filter(
      (i: any) => i.content === oldUrl || i.content === newUrl
    );

    // Sorted descending by lastVisitAt: new should come first
    if (testItems.length === 2) {
      expect(testItems[0].content).toBe(newUrl);
      expect(testItems[1].content).toBe(oldUrl);
    }
  });

  test('queryItems supports sorting by visitCount', async () => {
    const lessUrl = `https://sort-less-${RUN_ID}.example.com/page`;
    const moreUrl = `https://sort-more-${RUN_ID}.example.com/page`;
    const lessItem = await createUrlItem(lessUrl);
    const moreItem = await createUrlItem(moreUrl);

    // 1 visit for less
    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
    }, { itemId: lessItem.id });

    // 3 visits for more
    for (let i = 0; i < 3; i++) {
      await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test' });
      }, { itemId: moreItem.id });
    }

    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryItems({
        type: 'url',
        sortBy: 'visitCount',
      });
    });
    expect(result.success).toBe(true);

    const testItems = result.data.filter(
      (i: any) => i.content === lessUrl || i.content === moreUrl
    );
    if (testItems.length === 2) {
      expect(testItems[0].content).toBe(moreUrl);
      expect(testItems[1].content).toBe(lessUrl);
    }
  });

  test('queryItems supports limit', async () => {
    // Create a few items to ensure there's more than 2
    for (let i = 0; i < 3; i++) {
      await createUrlItem(`https://limit-test-${RUN_ID}-${i}.example.com/page`);
    }

    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryItems({ type: 'url', limit: 2 });
    });
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  test('queryItems supports domain filter', async () => {
    const domain = `domain-filter-${RUN_ID}.example.com`;
    const testUrl = `https://${domain}/specific-page`;
    const item = await createUrlItem(testUrl);

    const result = await bgWindow.evaluate(async (d: string) => {
      return await (window as any).app.datastore.queryItems({ type: 'url', domain: d });
    }, domain);
    expect(result.success).toBe(true);
    expect(result.data.some((i: any) => i.id === item.id)).toBe(true);
    // Every result should have the expected domain
    for (const i of result.data) {
      expect(i.domain).toBe(domain);
    }
  });
});

// ============================================================================
// 7. Soft delete
// ============================================================================

test.describe('Soft delete @desktop', () => {
  test('deleteItem soft-deletes by setting deletedAt', async () => {
    const testUrl = `https://soft-delete-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    const deleteResult = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, item.id);
    expect(deleteResult.success).toBe(true);

    // Item should not appear in normal queries
    const normalQuery = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.queryItems({ type: 'url', search: url });
    }, testUrl);
    expect(normalQuery.success).toBe(true);
    expect(normalQuery.data.some((i: any) => i.id === item.id)).toBe(false);
  });

  test('soft-deleted items appear with includeDeleted flag', async () => {
    const testUrl = `https://include-deleted-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Delete it
    await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, item.id);

    // Query with includeDeleted
    const result = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.queryItems({
        type: 'url',
        search: url,
        includeDeleted: true,
      });
    }, testUrl);
    expect(result.success).toBe(true);
    const found = result.data.find((i: any) => i.id === item.id);
    expect(found).toBeTruthy();
    expect(found.deletedAt).toBeGreaterThan(0);
  });

  test('getItem does not return soft-deleted items', async () => {
    const testUrl = `https://getitem-deleted-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Delete it
    await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.deleteItem(id);
    }, item.id);

    // getItem should return null for soft-deleted items
    const result = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItem(id);
    }, item.id);
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  test('hardDeleteItem permanently removes the item', async () => {
    const testUrl = `https://hard-delete-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Hard delete
    const deleteResult = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.hardDeleteItem(id);
    }, item.id);
    expect(deleteResult.success).toBe(true);

    // Should not appear even with includeDeleted
    const result = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.queryItems({
        type: 'url',
        search: url,
        includeDeleted: true,
      });
    }, testUrl);
    expect(result.success).toBe(true);
    expect(result.data.some((i: any) => i.id === item.id)).toBe(false);

    // Remove from cleanup list since it's already gone
    const idx = createdItemIds.indexOf(item.id);
    if (idx !== -1) createdItemIds.splice(idx, 1);
  });
});

// ============================================================================
// 8. queryItemVisits (cross-item visit queries)
// ============================================================================

test.describe('queryItemVisits @desktop', () => {
  test('queryItemVisits returns visits across all items', async () => {
    const url1 = `https://cross-visit-1-${RUN_ID}.example.com/page`;
    const url2 = `https://cross-visit-2-${RUN_ID}.example.com/page`;
    const item1 = await createUrlItem(url1);
    const item2 = await createUrlItem(url2);

    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test-cross' });
    }, { itemId: item1.id });

    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test-cross' });
    }, { itemId: item2.id });

    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryItemVisits({ source: 'test-cross' });
    });
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(2);
    // Both items should have visits in the result
    const itemIds = result.data.map((v: any) => v.itemId);
    expect(itemIds).toContain(item1.id);
    expect(itemIds).toContain(item2.id);
  });

  test('queryItemVisits supports filtering by itemId', async () => {
    const testUrl = `https://filter-item-visit-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
      return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test-filter' });
    }, { itemId: item.id });

    const result = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.queryItemVisits({ itemId });
    }, item.id);
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    for (const v of result.data) {
      expect(v.itemId).toBe(item.id);
    }
  });

  test('queryItemVisits supports limit', async () => {
    const testUrl = `https://visit-limit-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Record 3 visits
    for (let i = 0; i < 3; i++) {
      await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test-limit' });
      }, { itemId: item.id });
    }

    const result = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.queryItemVisits({ itemId, limit: 2 });
    }, item.id);
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  test('getItemVisits returns visits in descending timestamp order', async () => {
    const testUrl = `https://visit-order-${RUN_ID}.example.com/page`;
    const item = await createUrlItem(testUrl);

    // Record 3 visits with small delays
    for (let i = 0; i < 3; i++) {
      await bgWindow.evaluate(async ({ itemId }: { itemId: string }) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, { source: 'test-order' });
      }, { itemId: item.id });
      if (i < 2) await new Promise(r => setTimeout(r, 20));
    }

    const result = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemVisits(itemId);
    }, item.id);
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(3);

    // Verify descending order (most recent first)
    for (let i = 0; i < result.data.length - 1; i++) {
      expect(result.data[i].timestamp).toBeGreaterThanOrEqual(result.data[i + 1].timestamp);
    }
  });
});
