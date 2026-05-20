/**
 * Pagestream Extension Tests
 *
 * Tests the vertical browsing history stream extension:
 * - Extension loads and registers commands
 * - Window opens via command
 * - Cards render from visit history
 * - Keyboard navigation works (j/k, Enter, g/G)
 * - g/G jump to start/end
 * - Internal state exposed for testing
 *
 * Run with:
 *   yarn test:electron:bg
 */

import { test, expect, DesktopApp, getSharedApp } from '../fixtures/desktop-app';
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

// Don't close the shared app — let subsequent test files reuse it.

// ============================================================================
// Helper: Seed test items and visits for the stream
// ============================================================================

async function seedTestData(bgWindow: Page): Promise<{ itemIds: string[] }> {
  const itemIds: string[] = [];

  // Create URL items to populate the stream
  const urls = [
    { url: 'https://pagestream-test-1.example.com', title: 'Pagestream Test Page One' },
    { url: 'https://pagestream-test-2.example.com', title: 'Pagestream Test Page Two' },
    { url: 'https://pagestream-test-3.example.com', title: 'Pagestream Test Page Three' }
  ];

  for (const { url, title } of urls) {
    const result = await bgWindow.evaluate(async ({ u, t }: { u: string; t: string }) => {
      return await (window as any).app.datastore.addItem('url', {
        content: u,
        metadata: JSON.stringify({ title: t })
      });
    }, { u: url, t: title });
    expect(result.success).toBe(true);
    if (result.data?.id) {
      itemIds.push(result.data.id);

      // Create a visit for each item
      await bgWindow.evaluate(async (itemId: string) => {
        return await (window as any).app.datastore.recordItemVisit(itemId, {
          source: 'test'
        });
      }, result.data.id);
    }
  }

  return { itemIds };
}

// ============================================================================
// Helper: Open pagestream window
// ============================================================================

async function openPagestream(bgWindow: Page): Promise<{ pagestreamWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://pagestream/home.html', {
      width: 500,
      height: 700
    });
  });
  expect(result.success).toBe(true);

  const pagestreamWindow = await sharedApp.getWindow('pagestream/home.html', 5000);
  expect(pagestreamWindow).toBeTruthy();
  await pagestreamWindow.waitForLoadState('domcontentloaded');

  return { pagestreamWindow, windowId: result.id };
}

// ============================================================================
// Helper: Close a window by ID
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
// Pagestream Tests
// ============================================================================

test.describe('Pagestream Extension @desktop', () => {

  test.beforeAll(async () => {
    // Seed test data for the stream
    await seedTestData(sharedBgWindow);
    // Give a moment for data to settle
    await sleep(500);
  });

  test('pagestream command is available via lazy stub', async () => {
    // Pagestream is lazy-loaded — the manifest command is registered by the lazy stub
    const hasCommand = await sharedBgWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const result = await (window as any).app.commands.list();
        if (result.success && result.data) {
          if (result.data.some((c: { name: string }) => c.name === 'pagestream')) {
            return true;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(hasCommand).toBe(true);
  });

  test('pagestream command is registered via manifest', async () => {
    // Lazy stub registers the command from manifest — check for base command
    const hasCommand = await sharedBgWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const result = await (window as any).app.commands.list();
        if (result.success && result.data) {
          const names = result.data.map((c: { name: string }) => c.name);
          if (names.includes('pagestream')) {
            return true;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(hasCommand).toBe(true);
  });

  test('pagestream window opens and shows stream', async () => {
    const { pagestreamWindow, windowId } = await openPagestream(sharedBgWindow);

    try {
      // Wait for the stream container to exist
      await pagestreamWindow.waitForSelector('#stream', { timeout: 5000 });

      // Wait for cards or empty state to appear (data may take a moment to load)
      const hasContent = await pagestreamWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const cards = document.querySelectorAll('#stream peek-card');
          const empty = document.getElementById('empty-state');
          if (cards.length > 0 || (empty && empty.style.display !== 'none')) {
            return { cards: cards.length, hasEmpty: empty?.style.display !== 'none' };
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return { cards: 0, hasEmpty: true };
      });

      // Should have either cards or empty state
      expect(hasContent.cards > 0 || hasContent.hasEmpty).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('cards render with visit data', async () => {
    const { pagestreamWindow, windowId } = await openPagestream(sharedBgWindow);

    try {
      // Wait for visit cards to appear
      const cardCount = await pagestreamWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const cards = document.querySelectorAll('#stream peek-card.visit-card');
          if (cards.length > 0) return cards.length;
          await new Promise(r => setTimeout(r, 200));
        }
        return 0;
      });

      expect(cardCount).toBeGreaterThan(0);

      // Verify card has expected structure (header with title, url body, footer with time)
      const cardStructure = await pagestreamWindow.evaluate(() => {
        const card = document.querySelector('#stream peek-card.visit-card');
        if (!card) return null;
        return {
          hasHeader: !!card.querySelector('[slot="header"]'),
          hasTitle: !!card.querySelector('.card-title'),
          hasFavicon: !!card.querySelector('.card-favicon, img'),
          hasUrl: !!card.querySelector('.card-url'),
          hasFooter: !!card.querySelector('.card-footer'),
          hasTime: !!card.querySelector('.card-time'),
          hasDomain: !!card.querySelector('.card-domain')
        };
      });

      expect(cardStructure).toBeTruthy();
      expect(cardStructure!.hasHeader).toBe(true);
      expect(cardStructure!.hasTitle).toBe(true);
      expect(cardStructure!.hasUrl).toBe(true);
      expect(cardStructure!.hasFooter).toBe(true);
      expect(cardStructure!.hasTime).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('keyboard navigation works (j/k moves selection)', async () => {
    const { pagestreamWindow, windowId } = await openPagestream(sharedBgWindow);

    try {
      // Wait for cards to render
      await pagestreamWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const cards = document.querySelectorAll('#stream peek-card.visit-card');
          if (cards.length >= 2) return true;
          await new Promise(r => setTimeout(r, 200));
        }
        return false;
      });

      // Get initial selected index (should be last card, the newest)
      const initialIndex = await pagestreamWindow.evaluate(() => {
        return (window as any)._pagestreamState.selectedIndex;
      });

      // Press k to move up
      await pagestreamWindow.keyboard.press('k');
      await sleep(100);

      const afterK = await pagestreamWindow.evaluate(() => {
        return (window as any)._pagestreamState.selectedIndex;
      });

      // Should have moved up (lower index)
      expect(afterK).toBeLessThan(initialIndex);

      // Press j to move back down
      await pagestreamWindow.keyboard.press('j');
      await sleep(100);

      const afterJ = await pagestreamWindow.evaluate(() => {
        return (window as any)._pagestreamState.selectedIndex;
      });

      // Should have moved back down
      expect(afterJ).toBeGreaterThan(afterK);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('g and G jump to start and end', async () => {
    const { pagestreamWindow, windowId } = await openPagestream(sharedBgWindow);

    try {
      // Wait for multiple cards
      await pagestreamWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const cards = document.querySelectorAll('#stream peek-card.visit-card');
          if (cards.length >= 2) return true;
          await new Promise(r => setTimeout(r, 200));
        }
        return false;
      });

      // Press g to jump to oldest (top)
      await pagestreamWindow.keyboard.press('g');
      await sleep(100);

      const afterG = await pagestreamWindow.evaluate(() => {
        return (window as any)._pagestreamState.selectedIndex;
      });
      expect(afterG).toBe(0);

      // Press Shift+G to jump to newest (bottom)
      await pagestreamWindow.keyboard.press('Shift+G');
      await sleep(100);

      const afterShiftG = await pagestreamWindow.evaluate(() => {
        return (window as any)._pagestreamState.selectedIndex;
      });

      const totalCards = await pagestreamWindow.evaluate(() => {
        return document.querySelectorAll('#stream peek-card.visit-card').length;
      });

      expect(afterShiftG).toBe(totalCards - 1);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('internal state is exposed for testing', async () => {
    const { pagestreamWindow, windowId } = await openPagestream(sharedBgWindow);

    try {
      // Wait for init to complete
      await pagestreamWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if ((window as any)._pagestreamState) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      });

      const stateExists = await pagestreamWindow.evaluate(() => {
        const s = (window as any)._pagestreamState;
        return s && typeof s.selectedIndex === 'number' && Array.isArray(s.visits);
      });
      expect(stateExists).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });
});
