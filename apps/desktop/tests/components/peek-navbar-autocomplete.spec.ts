/**
 * peek-navbar URL-history autocomplete tests.
 *
 * Self-contained (own static server + inline page) so it never perturbs the
 * shared components test-page. Runs in chromium via the `components` project:
 *   npx playwright test tests/components/peek-navbar-autocomplete.spec.ts --project=components
 *
 * The component queries `window.app.datastore` in production; here we inject
 * `navbar.urlSuggestionProvider` with a deterministic history fixture so the
 * ghost + dropdown are exercised without a live datastore.
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

// Inline host page. The navbar imports url-completion.js via a RELATIVE path
// (../cmd/url-completion.js), which resolves against the served renderer/
// tree, so no custom-scheme importmap entry is needed.
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
<peek-navbar id="navbar"></peek-navbar>
<script type="module">
  import '/apps/desktop/renderer/components/peek-navbar.js';

  const HISTORY = [
    { content: 'https://github.com/anthropics/claude', title: 'GitHub Claude', domain: 'github.com', favicon: '' },
    { content: 'https://gitlab.com/explore', title: 'GitLab Explore', domain: 'gitlab.com', favicon: '' },
    { content: 'https://developer.mozilla.org/en-US/docs/Web', title: 'MDN Web Docs', domain: 'developer.mozilla.org', favicon: '' },
  ];

  const navbar = document.getElementById('navbar');
  navbar.shortcuts = false;
  navbar.visible = true;
  window.__navEvents = [];
  navbar.addEventListener('navigate', (e) => window.__navEvents.push(e.detail.url));
  navbar.urlSuggestionProvider = async (search) => {
    const s = (search || '').toLowerCase();
    return HISTORY.filter((it) => (it.content + ' ' + it.title).toLowerCase().includes(s));
  };

  await customElements.whenDefined('peek-navbar');
  await navbar.updateComplete;
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

test.describe('peek-navbar URL autocomplete @components', () => {
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

  // Focus the URL input, clear it, and type `text`, then wait for the debounced
  // suggestion query to apply. Returns after the ghost/dropdown state settles.
  async function typeUrl(text: string) {
    await page.evaluate(() => {
      const nb = document.getElementById('navbar') as any;
      nb._closeDropdown();
      nb.inputElement.value = '';
      nb._typedAnchor = '';
      nb.inputElement.focus();
    });
    // `_onUrlFocus` schedules a select-all on the next animation frame. A
    // keystroke landing before that frame is selected by it and replaced by the
    // next one ("git" arrives as "it"), so let the frame pass before typing.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.keyboard.type(text);
    // Debounce (150ms) + async provider resolution; wait for the state to settle.
    await page.waitForFunction(
      () => {
        const nb = document.getElementById('navbar') as any;
        return nb && nb._suggestions.length > 0;
      },
      { timeout: 5000 },
    );
    await page.evaluate(() => (document.getElementById('navbar') as any).updateComplete);
  }

  test('inline ghost fills the input and natively selects the completion suffix', async () => {
    await typeUrl('git');
    const state = await page.evaluate(() => {
      const input = (document.getElementById('navbar') as any).inputElement;
      return {
        value: input.value,
        selStart: input.selectionStart,
        selEnd: input.selectionEnd,
        selDir: input.selectionDirection,
      };
    });
    // frecency-best is github.com; host granularity → "github.com".
    expect(state.value).toBe('github.com');
    expect(state.selStart).toBe(3); // typed "git"
    expect(state.selEnd).toBe('github.com'.length);
    expect(state.selDir).toBe('backward');
  });

  test('dropdown lists URL-history matches', async () => {
    await typeUrl('git');
    const rows = await page.evaluate(() => {
      const sr = (document.getElementById('navbar') as any).shadowRoot;
      return Array.from(sr.querySelectorAll('.url-suggestion')).map(
        (el: any) => el.querySelector('.url-subtitle')?.textContent,
      );
    });
    expect(rows).toEqual(['github.com', 'gitlab.com']);
  });

  test('Tab advances the ghost granularity (host → path1)', async () => {
    await typeUrl('git');
    await page.keyboard.press('Tab');
    const value = await page.evaluate(
      () => (document.getElementById('navbar') as any).inputElement.value,
    );
    expect(value).toBe('github.com/anthropics');
  });

  test('ArrowDown highlights a row and collapses the inline ghost', async () => {
    await typeUrl('git');
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => (document.getElementById('navbar') as any).updateComplete);
    const result = await page.evaluate(() => {
      const nb = document.getElementById('navbar') as any;
      return {
        selectedIndex: nb._selectedIndex,
        value: nb.inputElement.value,
        hasSelectedRow: !!nb.shadowRoot.querySelector('.url-suggestion.selected'),
      };
    });
    expect(result.selectedIndex).toBe(0);
    expect(result.value).toBe('git'); // ghost collapsed to typed text
    expect(result.hasSelectedRow).toBe(true);
  });

  test('Enter on a highlighted row emits navigate with that URL', async () => {
    await page.evaluate(() => ((window as any).__navEvents = []));
    await typeUrl('git');
    await page.keyboard.press('ArrowDown'); // select github.com row
    await page.keyboard.press('Enter');
    const events = await page.evaluate(() => (window as any).__navEvents);
    expect(events).toEqual(['https://github.com/anthropics/claude']);
  });

  test('clicking a suggestion row emits navigate (survives overlay drag-block marker)', async () => {
    await page.evaluate(() => ((window as any).__navEvents = []));
    await typeUrl('git');
    // The dropdown carries data-no-drag; the row keeps input focus via
    // mousedown preventDefault, so the click lands and navigates.
    await page.evaluate(() => {
      const sr = (document.getElementById('navbar') as any).shadowRoot;
      const rows = sr.querySelectorAll('.url-suggestion');
      rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    const events = await page.evaluate(() => (window as any).__navEvents);
    expect(events).toEqual(['https://gitlab.com/explore']);
  });

  test('Escape closes the dropdown before exiting the bar', async () => {
    await typeUrl('git');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.getElementById('navbar') as any).updateComplete);
    const open = await page.evaluate(() => {
      const nb = document.getElementById('navbar') as any;
      return { suggestions: nb._suggestions.length, ghost: !!nb._ghost };
    });
    expect(open.suggestions).toBe(0);
    expect(open.ghost).toBe(false);
  });
});
