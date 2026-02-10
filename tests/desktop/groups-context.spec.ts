/**
 * Groups Mode Context Propagation Tests
 *
 * Verifies that group mode context is correctly set, inherited by child pages,
 * and preserved through navigation flows.
 *
 * Run with:
 *   yarn test:electron:bg
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// Shared app and background window
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

// ============================================================================
// Helper: Create a group (tag) with tagged URL items
// ============================================================================

async function createGroupWithItems(
  bgWindow: Page,
  groupName: string,
  urls: string[]
): Promise<{ tagId: string; itemIds: string[] }> {
  const tagResult = await bgWindow.evaluate(async (name: string) => {
    return await (window as any).app.datastore.getOrCreateTag(name);
  }, groupName);
  expect(tagResult.success).toBe(true);
  const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;
  expect(tagId).toBeTruthy();

  const itemIds: string[] = [];
  for (const url of urls) {
    const itemResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.datastore.addItem('url', {
        content: u,
        metadata: JSON.stringify({ title: `Test: ${u}` })
      });
    }, url);
    expect(itemResult.success).toBe(true);

    if (tagId && itemResult.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }: { itemId: string; tagId: string }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: itemResult.data.id, tagId });
      itemIds.push(itemResult.data.id);
    }
  }

  return { tagId, itemIds };
}

// ============================================================================
// Helper: Open groups home window
// ============================================================================

async function openGroupsHome(bgWindow: Page): Promise<{ groupsWindow: Page; windowId: number }> {
  const groupsResult = await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://ext/groups/home.html', {
      width: 800,
      height: 600
    });
  });
  expect(groupsResult.success).toBe(true);

  const groupsWindow = await sharedApp.getWindow('groups/home.html', 5000);
  expect(groupsWindow).toBeTruthy();
  await groupsWindow.waitForLoadState('domcontentloaded');
  await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

  return { groupsWindow, windowId: groupsResult.id };
}

// ============================================================================
// Helper: Navigate into a group by clicking its card
// ============================================================================

async function navigateIntoGroup(groupsWindow: Page, tagId: string): Promise<void> {
  // Try to click the specific group card, fall back to any group card
  const groupCard = await groupsWindow.$(`peek-card.group-card[data-tag-id="${tagId}"]`);
  if (groupCard) {
    await groupCard.click();
  } else {
    const anyGroupCard = await groupsWindow.$('peek-card.group-card');
    expect(anyGroupCard).toBeTruthy();
    await anyGroupCard!.click();
  }

  // Wait for address cards to appear (addresses view loaded)
  await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });
}

// ============================================================================
// Helper: Close a window by ID from the background window
// ============================================================================

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  try {
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  } catch {
    // Window may already be closed
  }
}

// ============================================================================
// Helper: Wait for context mode to match expected value
// Uses polling via waitForFunction to avoid timeouts-as-assertions
// ============================================================================

async function waitForMode(
  bgWindow: Page,
  windowId: number,
  expectedMode: string,
  timeout = 5000
): Promise<{ value: string; metadata: any }> {
  const result = await bgWindow.evaluate(
    async ([wid, mode, timeoutMs]) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const entry = await (window as any).app.context.get('mode', wid);
        if (entry.success && entry.data && entry.data.value === mode) {
          return { value: entry.data.value, metadata: entry.data.metadata };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      // Return whatever we have for debugging
      const final = await (window as any).app.context.get('mode', wid);
      return final.success && final.data
        ? { value: final.data.value, metadata: final.data.metadata }
        : { value: null, metadata: null };
    },
    [windowId, expectedMode, timeout] as [number, string, number]
  );
  return result;
}

// ============================================================================
// Group Mode Context Tests
// ============================================================================

test.describe('Group Mode Context @desktop', () => {

  // State shared across tests in this describe block
  let tagId: string;
  let groupName: string;

  test.beforeAll(async () => {
    groupName = `ctx-test-group-${Date.now()}`;
    const result = await createGroupWithItems(sharedBgWindow, groupName, [
      'https://ctx-group-test-1.example.com',
      'https://ctx-group-test-2.example.com'
    ]);
    tagId = result.tagId;
  });

  test('group mode is set when viewing a group\'s addresses', async () => {
    const { groupsWindow, windowId } = await openGroupsHome(sharedBgWindow);

    try {
      // Verify initial mode is default (groups list view)
      const initialMode = await waitForMode(sharedBgWindow, windowId, 'default', 3000);
      // Mode may be 'default' or null at this point - either is acceptable for groups list
      // The key assertion is that after navigating into a group, mode becomes 'group'

      // Navigate into the group
      await navigateIntoGroup(groupsWindow, tagId);

      // Verify mode is now 'group' with correct metadata
      const groupMode = await waitForMode(sharedBgWindow, windowId, 'group', 5000);
      expect(groupMode.value).toBe('group');
      expect(groupMode.metadata).toBeTruthy();
      expect(groupMode.metadata.groupId).toBe(tagId);
      expect(groupMode.metadata.groupName).toBe(groupName);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('child page inherits group context', async () => {
    const { groupsWindow, windowId } = await openGroupsHome(sharedBgWindow);
    let childWindowId: number | null = null;

    try {
      // Navigate into the group
      await navigateIntoGroup(groupsWindow, tagId);

      // Verify group mode is set on the groups window
      const groupMode = await waitForMode(sharedBgWindow, windowId, 'group', 5000);
      expect(groupMode.value).toBe('group');

      // Open a child page directly from the groups window with groupMode option
      // (matching what home.js does on address card click)
      const childResult = await groupsWindow.evaluate(async ({ gId, gName }: { gId: string; gName: string }) => {
        return await (window as any).app.window.open('https://ctx-group-test-1.example.com', {
          role: 'content',
          width: 800,
          height: 600,
          groupMode: {
            groupId: gId,
            groupName: gName
          }
        });
      }, { gId: tagId, gName: groupName });
      expect(childResult.success).toBe(true);
      childWindowId = childResult.id;

      // Query the child window's context from the background window
      // (child may not have fully loaded since it's an external URL)
      const childMode = await waitForMode(sharedBgWindow, childWindowId, 'group', 5000);
      expect(childMode.value).toBe('group');
      expect(childMode.metadata).toBeTruthy();
      expect(childMode.metadata.groupId).toBe(tagId);
      expect(childMode.metadata.groupName).toBe(groupName);
    } finally {
      // Clean up child window
      if (childWindowId) {
        await closeWindow(sharedBgWindow, childWindowId);
      }
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('mode preserved after group -> page -> back to group', async () => {
    const { groupsWindow, windowId } = await openGroupsHome(sharedBgWindow);
    let childWindowId: number | null = null;

    try {
      // Navigate into the group
      await navigateIntoGroup(groupsWindow, tagId);

      // Verify mode is 'group'
      const groupModeInitial = await waitForMode(sharedBgWindow, windowId, 'group', 5000);
      expect(groupModeInitial.value).toBe('group');
      expect(groupModeInitial.metadata.groupId).toBe(tagId);

      // Open a child page from the groups window (simulating address card click)
      const childResult = await groupsWindow.evaluate(async ({ gId, gName }: { gId: string; gName: string }) => {
        return await (window as any).app.window.open('https://ctx-group-test-2.example.com', {
          role: 'content',
          width: 800,
          height: 600,
          groupMode: {
            groupId: gId,
            groupName: gName
          }
        });
      }, { gId: tagId, gName: groupName });
      expect(childResult.success).toBe(true);
      childWindowId = childResult.id;

      // Verify child has group mode
      const childMode = await waitForMode(sharedBgWindow, childWindowId, 'group', 5000);
      expect(childMode.value).toBe('group');

      // Close the child page
      await closeWindow(sharedBgWindow, childWindowId);
      childWindowId = null;

      // The groups window should re-assert group mode on focus
      // Trigger a focus event since closing a child may not reliably trigger it in test
      await groupsWindow.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
      });

      // Wait for the mode re-assertion to complete
      const groupModeAfter = await waitForMode(sharedBgWindow, windowId, 'group', 5000);
      expect(groupModeAfter.value).toBe('group');
      expect(groupModeAfter.metadata.groupId).toBe(tagId);
      expect(groupModeAfter.metadata.groupName).toBe(groupName);

      // Also verify the groups window internal state still shows addresses view
      const viewState = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
      expect(viewState).toBe('addresses');
    } finally {
      if (childWindowId) {
        await closeWindow(sharedBgWindow, childWindowId);
      }
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('mode resets to default when navigating back to groups list', async () => {
    const { groupsWindow, windowId } = await openGroupsHome(sharedBgWindow);

    try {
      // Navigate into the group
      await navigateIntoGroup(groupsWindow, tagId);

      // Verify mode is 'group'
      const groupMode = await waitForMode(sharedBgWindow, windowId, 'group', 5000);
      expect(groupMode.value).toBe('group');

      // Navigate back to groups list using the exposed showGroups function
      await groupsWindow.evaluate(async () => {
        const showGroups = (window as any).showGroups;
        if (showGroups) {
          await showGroups();
        }
      });

      // Wait for groups view to render
      await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

      // Mode should be reset to 'default' when back at groups list
      const defaultMode = await waitForMode(sharedBgWindow, windowId, 'default', 5000);
      expect(defaultMode.value).toBe('default');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('HUD displays group mode with name', async () => {
    // This test verifies HUD rendering of group mode.
    // The existing HUD test in hud.spec.ts sets mode directly via context API.
    // Here we verify it works through the actual groups navigation flow.

    // Open HUD
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
    });
    await sleep(1000);

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();
    await hudWindow.waitForSelector('#mode-value', { timeout: 5000 });

    const { groupsWindow, windowId } = await openGroupsHome(sharedBgWindow);

    try {
      // Navigate into the group - this sets mode via context API
      await navigateIntoGroup(groupsWindow, tagId);

      // Wait for group mode to be set
      await waitForMode(sharedBgWindow, windowId, 'group', 5000);

      // Give HUD time to update via subscription
      await sleep(500);

      // Verify HUD shows group mode with group name
      const modeText = await hudWindow.$eval('#mode-value', (el: Element) => el.textContent);
      expect(modeText).toContain('group');
      expect(modeText).toContain(groupName);

      // Verify the group mode CSS class is applied
      const modeClasses = await hudWindow.$eval('#mode-value', (el: Element) => el.className);
      expect(modeClasses).toContain('mode-group');
    } finally {
      await closeWindow(sharedBgWindow, windowId);

      // Close HUD
      await sharedBgWindow.evaluate(async () => {
        (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
      });
      await sleep(500);
    }
  });
});
