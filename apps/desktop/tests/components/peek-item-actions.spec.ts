/**
 * <peek-item-actions> component tests.
 *
 * Self-contained (own static server + inline page) so it never perturbs the
 * shared components test-page. Runs in chromium via the `components` project:
 *   npx playwright test tests/components/peek-item-actions.spec.ts --project=components
 *
 * The component is display-only — it owns which buttons appear, what each
 * click emits, and that a click never reaches the surrounding card. All three
 * are decided inside render()/the handlers, so they are asserted against the
 * real custom element rather than a restatement of its rules.
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../../../..'); // repo root (node_modules live here)

const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// Inline host page. `card` stands in for a consumer's item card: the component
// must stop clicks from reaching it, so a click recorded here is a failure.
const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "lit": "/node_modules/lit/index.js",
    "lit/": "/node_modules/lit/",
    "@lit/reactive-element": "/node_modules/@lit/reactive-element/reactive-element.js",
    "@lit/reactive-element/": "/node_modules/@lit/reactive-element/",
    "lit-html": "/node_modules/lit-html/lit-html.js",
    "lit-html/": "/node_modules/lit-html/",
    "lit-element/lit-element.js": "/node_modules/lit-element/lit-element.js"
  }
}
</script>
<style>body { margin: 40px; background: #1e1e1e; }</style>
</head><body>
<div id="card"><peek-item-actions id="actions"></peek-item-actions></div>
<script type="module">
  import '/apps/desktop/renderer/components/peek-item-actions.js';

  const card = document.getElementById('card');
  window.__events = [];
  window.__cardClicks = 0;

  card.addEventListener('click', () => { window.__cardClicks++; });

  // Both action events are declared bubbles + composed, so a document-level
  // listener is the test of that declaration as well as of the payload.
  for (const type of ['action-open-inline', 'action-delete']) {
    document.addEventListener(type, (e) => {
      const el = document.getElementById('actions');
      window.__events.push({
        type: e.type,
        url: e.detail.url,
        itemId: e.detail.item ? e.detail.item.id : null,
        sameItemObject: e.detail.item === el.item,
        bubbles: e.bubbles,
        composed: e.composed,
      });
    });
  }

  // Configure the element and wait for the render to land.
  window.__setup = async ({ item, showOpenInline, showDelete }) => {
    const el = document.getElementById('actions');
    window.__events = [];
    window.__cardClicks = 0;
    el.item = item === undefined ? null : item;
    el.showOpenInline = !!showOpenInline;
    el.showDelete = !!showDelete;
    await el.updateComplete;
  };

  window.__buttons = () => {
    const sr = document.getElementById('actions').shadowRoot;
    return Array.from(sr.querySelectorAll('.action-btn')).map((b) => ({
      classes: b.className,
      title: b.getAttribute('title'),
    }));
  };

  window.__click = async (selector) => {
    const sr = document.getElementById('actions').shadowRoot;
    const btn = sr.querySelector(selector);
    if (!btn) throw new Error('no button matching ' + selector);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await document.getElementById('actions').updateComplete;
  };

  await customElements.whenDefined('peek-item-actions');
  await document.getElementById('actions').updateComplete;
  document.body.dataset.ready = 'true';
</script>
</body></html>`;

let server: ReturnType<typeof createServer>;
let serverUrl: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (!req.url || req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE_HTML);
        return;
      }
      const filePath = path.join(ROOT, req.url);
      const ext = path.extname(filePath);
      const contentType = mimeTypes[ext] || 'text/plain';
      try {
        if (existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end(`Not found: ${filePath}`);
        }
      } catch (err) {
        res.writeHead(500);
        res.end(`Error: ${err}`);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

type ItemConfig = {
  item: unknown;
  showOpenInline?: boolean;
  showDelete?: boolean;
};

test.describe('peek-item-actions @components', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    serverUrl = await startServer();
    page = await browser.newPage();
    page.on('pageerror', (err) => console.log('Page exception:', err.message));
    await page.goto(serverUrl);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 15000 });
  });

  test.afterAll(async () => {
    await page.close();
    server?.close();
  });

  const setup = (config: ItemConfig) =>
    page.evaluate((c) => (window as any).__setup(c), config);
  const buttons = () => page.evaluate(() => (window as any).__buttons());
  const events = () => page.evaluate(() => (window as any).__events);
  const cardClicks = () => page.evaluate(() => (window as any).__cardClicks);
  const click = (selector: string) =>
    page.evaluate((s) => (window as any).__click(s), selector);

  const classesOf = async () => (await buttons()).map((b: any) => b.classes);

  test.describe('which buttons render', () => {
    test('an https item gets the open-inline button', async () => {
      await setup({ item: { id: '1', uri: 'https://example.com' }, showOpenInline: true });
      expect(await classesOf()).toEqual(['action-btn open-inline']);
    });

    test('an http item gets the open-inline button', async () => {
      await setup({ item: { id: '1', uri: 'http://example.com/path' }, showOpenInline: true });
      expect(await classesOf()).toEqual(['action-btn open-inline']);
    });

    test('a peek:// item gets no open-inline button', async () => {
      await setup({ item: { id: '2', uri: 'peek://app/background.html' }, showOpenInline: true });
      expect(await classesOf()).toEqual([]);
    });

    test('a plain-text item gets no open-inline button', async () => {
      await setup({ item: { id: '3', content: 'just some text' }, showOpenInline: true });
      expect(await classesOf()).toEqual([]);
    });

    test('an item with neither uri nor content gets no open-inline button', async () => {
      await setup({ item: { id: '4' }, showOpenInline: true });
      expect(await classesOf()).toEqual([]);
    });

    test('a null item gets no open-inline button', async () => {
      await setup({ item: null, showOpenInline: true });
      expect(await classesOf()).toEqual([]);
    });

    test('a web item without showOpenInline gets no open-inline button', async () => {
      await setup({ item: { id: '1', uri: 'https://example.com' } });
      expect(await classesOf()).toEqual([]);
    });

    test('showDelete renders the delete button whatever the url is', async () => {
      await setup({ item: { id: '3', content: 'just some text' }, showDelete: true });
      expect(await classesOf()).toEqual(['action-btn delete']);
    });

    test('showDelete renders the delete button even with a null item', async () => {
      await setup({ item: null, showDelete: true });
      expect(await classesOf()).toEqual(['action-btn delete']);
    });

    test('both flags render open-inline before delete', async () => {
      await setup({
        item: { id: '1', uri: 'https://example.com' },
        showOpenInline: true,
        showDelete: true,
      });
      expect(await classesOf()).toEqual(['action-btn open-inline', 'action-btn delete']);
    });

    test('neither flag renders nothing', async () => {
      await setup({ item: { id: '1', uri: 'https://example.com' } });
      expect(await buttons()).toEqual([]);
    });

    test('the buttons carry their hover titles', async () => {
      await setup({
        item: { id: '1', uri: 'https://example.com' },
        showOpenInline: true,
        showDelete: true,
      });
      expect((await buttons()).map((b: any) => b.title)).toEqual(['Open in Peek', 'Delete item']);
    });

    test('the show-* properties reflect to attributes', async () => {
      await setup({
        item: { id: '1', uri: 'https://example.com' },
        showOpenInline: true,
        showDelete: true,
      });
      expect(
        await page.evaluate(() => {
          const el = document.getElementById('actions')!;
          return [el.hasAttribute('show-open-inline'), el.hasAttribute('show-delete')];
        }),
      ).toEqual([true, true]);

      await setup({ item: { id: '1', uri: 'https://example.com' } });
      expect(
        await page.evaluate(() => {
          const el = document.getElementById('actions')!;
          return [el.hasAttribute('show-open-inline'), el.hasAttribute('show-delete')];
        }),
      ).toEqual([false, false]);
    });
  });

  test.describe('what a click emits', () => {
    test('open-inline carries the item and its url', async () => {
      const item = { id: '10', uri: 'https://example.com', title: 'Example' };
      await setup({ item, showOpenInline: true });
      await click('.open-inline');
      expect(await events()).toEqual([
        {
          type: 'action-open-inline',
          url: 'https://example.com',
          itemId: '10',
          sameItemObject: true,
          bubbles: true,
          composed: true,
        },
      ]);
    });

    test('open-inline falls back to content when there is no uri', async () => {
      await setup({
        item: { id: '11', content: 'https://other.com', title: 'Other' },
        showOpenInline: true,
      });
      await click('.open-inline');
      expect((await events()).map((e: any) => e.url)).toEqual(['https://other.com']);
    });

    test('open-inline prefers uri over content', async () => {
      await setup({
        item: { id: '12', uri: 'https://a.com', content: 'https://b.com' },
        showOpenInline: true,
      });
      await click('.open-inline');
      expect((await events()).map((e: any) => e.url)).toEqual(['https://a.com']);
    });

    test('delete carries the item and no url', async () => {
      await setup({ item: { id: '20', title: 'To Delete' }, showDelete: true });
      await click('.delete');
      expect(await events()).toEqual([
        {
          type: 'action-delete',
          url: undefined,
          itemId: '20',
          sameItemObject: true,
          bubbles: true,
          composed: true,
        },
      ]);
    });

    test('clicking delete with a null item emits nothing', async () => {
      await setup({ item: null, showDelete: true });
      await click('.delete');
      expect(await events()).toEqual([]);
    });

    test('a click on either button never reaches the surrounding card', async () => {
      await setup({
        item: { id: '30', uri: 'https://example.com' },
        showOpenInline: true,
        showDelete: true,
      });
      await click('.open-inline');
      await click('.delete');
      expect((await events()).map((e: any) => e.type)).toEqual([
        'action-open-inline',
        'action-delete',
      ]);
      expect(await cardClicks()).toBe(0);
    });
  });
});
