import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Tag Command @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-cmd'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('creates address if not exists when tagging', async () => {
    // This tests the bug fix: addResult.data.id instead of addResult.id
    // Use unique URI to avoid conflicts with other tests
    // Note: datastore normalizes URLs (adds trailing slash)
    const timestamp = Date.now();
    const testUri = `https://tag-test-new-address-${timestamp}.example.com/`;

    // Create tag with unique name
    const tagResult = await bgWindow.evaluate(async (ts: number) => {
      return await (window as any).app.datastore.getOrCreateTag('test-new-addr-tag-' + ts);
    }, timestamp);
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id;
    expect(tagId).toBeTruthy();

    // Create address
    const addResult = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.addAddress(uri, { title: 'New Tagged Address' });
    }, testUri);
    expect(addResult.success).toBe(true);
    // Bug fix verification: data.id is the correct path
    expect(addResult.data?.id).toBeTruthy();

    // Tag the address using the correct id path
    const linkResult = await bgWindow.evaluate(async ({ addressId, tagId }) => {
      return await (window as any).app.datastore.tagAddress(addressId, tagId);
    }, { addressId: addResult.data.id, tagId });
    expect(linkResult.success).toBe(true);

    // Verify address is tagged
    const taggedAddresses = await bgWindow.evaluate(async (tId: string) => {
      return await (window as any).app.datastore.getAddressesByTag(tId);
    }, tagId);
    expect(taggedAddresses.success).toBe(true);
    expect(taggedAddresses.data.some((a: any) => a.uri === testUri)).toBe(true);
  });

  test('getOrCreateTag returns tag in data.tag', async () => {
    // This tests the bug fix: tagResult.data.tag.id instead of tagResult.data.id
    const tagName = 'test-nested-tag-response';

    const result = await bgWindow.evaluate(async (name: string) => {
      return await (window as any).app.datastore.getOrCreateTag(name);
    }, tagName);

    expect(result.success).toBe(true);
    // Bug fix verification: tag is nested in data.tag
    expect(result.data?.tag).toBeTruthy();
    expect(result.data?.tag?.id).toBeTruthy();
    expect(result.data?.tag?.name).toBe(tagName);
    expect(typeof result.data?.created).toBe('boolean');
  });

  test('tagAddress links tag to address correctly', async () => {
    // Create address
    const addr = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://tag-link-test.example.com', {
        title: 'Tag Link Test'
      });
    });
    expect(addr.success).toBe(true);

    // Create tag
    const tag = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('link-test-tag');
    });
    expect(tag.success).toBe(true);

    // Link them
    const link = await bgWindow.evaluate(async ({ addressId, tagId }) => {
      return await (window as any).app.datastore.tagAddress(addressId, tagId);
    }, { addressId: addr.data.id, tagId: tag.data.tag.id });
    expect(link.success).toBe(true);

    // Verify link exists
    const addressTags = await bgWindow.evaluate(async (addressId: string) => {
      return await (window as any).app.datastore.getAddressTags(addressId);
    }, addr.data.id);
    expect(addressTags.success).toBe(true);
    expect(addressTags.data.some((t: any) => t.name === 'link-test-tag')).toBe(true);
  });

  test('multiple tags can be added to same address', async () => {
    // Create address
    const addr = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://multi-tag-test.example.com', {
        title: 'Multi Tag Test'
      });
    });
    expect(addr.success).toBe(true);

    // Create and link multiple tags
    const tagNames = ['multi-tag-1', 'multi-tag-2', 'multi-tag-3'];

    for (const tagName of tagNames) {
      const tag = await bgWindow.evaluate(async (name: string) => {
        return await (window as any).app.datastore.getOrCreateTag(name);
      }, tagName);
      expect(tag.success).toBe(true);

      const link = await bgWindow.evaluate(async ({ addressId, tagId }) => {
        return await (window as any).app.datastore.tagAddress(addressId, tagId);
      }, { addressId: addr.data.id, tagId: tag.data.tag.id });
      expect(link.success).toBe(true);
    }

    // Verify all tags are linked
    const addressTags = await bgWindow.evaluate(async (addressId: string) => {
      return await (window as any).app.datastore.getAddressTags(addressId);
    }, addr.data.id);
    expect(addressTags.success).toBe(true);
    expect(addressTags.data.length).toBeGreaterThanOrEqual(3);

    for (const tagName of tagNames) {
      expect(addressTags.data.some((t: any) => t.name === tagName)).toBe(true);
    }
  });

  test('untagAddress removes tag from address', async () => {
    // Create address
    const addr = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://untag-test.example.com', {
        title: 'Untag Test'
      });
    });
    expect(addr.success).toBe(true);

    // Create and link tag
    const tag = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('untag-test-tag');
    });
    expect(tag.success).toBe(true);

    await bgWindow.evaluate(async ({ addressId, tagId }) => {
      return await (window as any).app.datastore.tagAddress(addressId, tagId);
    }, { addressId: addr.data.id, tagId: tag.data.tag.id });

    // Verify tag is linked
    let addressTags = await bgWindow.evaluate(async (addressId: string) => {
      return await (window as any).app.datastore.getAddressTags(addressId);
    }, addr.data.id);
    expect(addressTags.data.some((t: any) => t.name === 'untag-test-tag')).toBe(true);

    // Remove tag
    const untag = await bgWindow.evaluate(async ({ addressId, tagId }) => {
      return await (window as any).app.datastore.untagAddress(addressId, tagId);
    }, { addressId: addr.data.id, tagId: tag.data.tag.id });
    expect(untag.success).toBe(true);

    // Verify tag is removed
    addressTags = await bgWindow.evaluate(async (addressId: string) => {
      return await (window as any).app.datastore.getAddressTags(addressId);
    }, addr.data.id);
    expect(addressTags.data.some((t: any) => t.name === 'untag-test-tag')).toBe(false);
  });

  test('getUntaggedAddresses returns addresses without tags', async () => {
    // Use unique URI to avoid conflicts
    // Note: datastore normalizes URLs (adds trailing slash)
    const timestamp = Date.now();
    const testUri = `https://untagged-test-${timestamp}.example.com/`;

    // Create address without tagging it
    const addr = await bgWindow.evaluate(async (uri: string) => {
      return await (window as any).app.datastore.addAddress(uri, {
        title: 'Untagged Test'
      });
    }, testUri);
    expect(addr.success).toBe(true);
    expect(addr.data?.id).toBeTruthy();

    // Query untagged addresses
    const untagged = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getUntaggedAddresses();
    });
    expect(untagged.success).toBe(true);
    expect(untagged.data.some((a: any) => a.uri === testUri)).toBe(true);

    // Tag the address with unique tag name
    const tag = await bgWindow.evaluate(async (ts: number) => {
      return await (window as any).app.datastore.getOrCreateTag('now-tagged-' + ts);
    }, timestamp);
    expect(tag.success).toBe(true);
    expect(tag.data?.tag?.id).toBeTruthy();

    await bgWindow.evaluate(async ({ addressId, tagId }) => {
      return await (window as any).app.datastore.tagAddress(addressId, tagId);
    }, { addressId: addr.data.id, tagId: tag.data.tag.id });

    // Verify it's no longer in untagged list
    const untaggedAfter = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getUntaggedAddresses();
    });
    expect(untaggedAfter.data.some((a: any) => a.uri === testUri)).toBe(false);
  });
});
