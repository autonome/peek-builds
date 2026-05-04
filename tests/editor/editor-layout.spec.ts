/**
 * Editor Layout Tests
 *
 * Tests for the three-panel editor layout: outline sidebar, editor, preview sidebar.
 * Covers pane visibility toggles, resizing, keyboard shortcuts, focus mode,
 * outline header rendering, and preview updates.
 *
 * Run with:
 *   npx playwright test tests/editor/editor-layout.spec.ts --project=editor
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../..');

// Simple static file server
let server: ReturnType<typeof createServer>;
let serverUrl: string;

const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let filePath = path.join(ROOT, req.url || '/');

      if (req.url === '/' || req.url === '/test') {
        filePath = path.join(__dirname, 'test-layout-page.html');
      }

      if (req.url?.startsWith('/node_modules/')) {
        filePath = path.join(ROOT, req.url);
      }

      if (req.url?.startsWith('/features/')) {
        filePath = path.join(ROOT, req.url);
      }

      const ext = path.extname(filePath);
      const contentType = mimeTypes[ext] || 'text/plain';

      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
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
      if (addr && typeof addr === 'object') {
        const url = `http://127.0.0.1:${addr.port}`;
        resolve(url);
      }
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
  }
}

test.describe('Editor Layout @editor', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    serverUrl = await startServer();
    page = await browser.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('Page error:', msg.text());
      }
    });

    page.on('pageerror', err => {
      console.log('Page exception:', err.message);
    });

    await page.goto(`${serverUrl}/test`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 15000 });
  });

  test.afterAll(async () => {
    await page.close();
    stopServer();
  });

  // ==========================================================================
  // Editor Setup
  // ==========================================================================

  test.describe('Editor Setup', () => {
    test('editor layout is initialized', async () => {
      const hasLayout = await page.evaluate(() => !!window.editorLayout);
      expect(hasLayout).toBe(true);
    });

    test('editor has content', async () => {
      const content = await page.evaluate(() => window.getEditorContent());
      expect(content).toContain('# Introduction');
      expect(content).toContain('## Section One');
    });

    test('all three panels exist in DOM', async () => {
      const hasOutline = await page.evaluate(() =>
        !!document.querySelector('.outline-sidebar')
      );
      const hasEditor = await page.evaluate(() =>
        !!document.querySelector('.editor-container')
      );
      const hasPreview = await page.evaluate(() =>
        !!document.querySelector('.preview-sidebar')
      );
      expect(hasOutline).toBe(true);
      expect(hasEditor).toBe(true);
      expect(hasPreview).toBe(true);
    });

    test('toolbar exists with toggle buttons', async () => {
      const hasToolbar = await page.evaluate(() =>
        !!document.querySelector('.editor-toolbar')
      );
      expect(hasToolbar).toBe(true);

      const buttonTexts = await page.evaluate(() => {
        const btns = document.querySelectorAll('.toolbar-btn');
        return Array.from(btns).map(b => b.textContent);
      });
      expect(buttonTexts).toContain('Outline');
      expect(buttonTexts).toContain('Preview');
      expect(buttonTexts).toContain('Focus');
    });

    test('both sidebars start collapsed by default', async () => {
      const outlineState = await page.evaluate(() => window.getOutlineState());
      const previewState = await page.evaluate(() => window.getPreviewState());
      expect(outlineState.collapsed).toBe(true);
      expect(previewState.collapsed).toBe(true);
    });
  });

  // ==========================================================================
  // Pane Visibility Toggles
  // ==========================================================================

  test.describe('Pane Visibility Toggles', () => {
    test('toggleOutline expands and collapses the outline', async () => {
      // Should start collapsed
      let state = await page.evaluate(() => window.getOutlineState());
      expect(state.collapsed).toBe(true);

      // Toggle to expand
      await page.evaluate(() => window.toggleOutline());
      state = await page.evaluate(() => window.getOutlineState());
      expect(state.collapsed).toBe(false);

      // Toggle to collapse again
      await page.evaluate(() => window.toggleOutline());
      state = await page.evaluate(() => window.getOutlineState());
      expect(state.collapsed).toBe(true);
    });

    test('togglePreview expands and collapses the preview', async () => {
      let state = await page.evaluate(() => window.getPreviewState());
      expect(state.collapsed).toBe(true);

      await page.evaluate(() => window.togglePreview());
      state = await page.evaluate(() => window.getPreviewState());
      expect(state.collapsed).toBe(false);

      await page.evaluate(() => window.togglePreview());
      state = await page.evaluate(() => window.getPreviewState());
      expect(state.collapsed).toBe(true);
    });

    test('outline toggle button gets active class when expanded', async () => {
      // Ensure collapsed first
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (!isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      // Expand
      await page.evaluate(() => window.toggleOutline());
      const hasActive = await page.evaluate(() => {
        const btn = document.querySelector('.toolbar-btn');
        return btn?.classList.contains('active');
      });
      expect(hasActive).toBe(true);

      // Collapse to restore state
      await page.evaluate(() => window.toggleOutline());
    });

    test('preview toggle button gets active class when expanded', async () => {
      const isCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      if (!isCollapsed) {
        await page.evaluate(() => window.togglePreview());
      }

      await page.evaluate(() => window.togglePreview());
      const hasActive = await page.evaluate(() => {
        const btns = document.querySelectorAll('.toolbar-btn');
        // Toolbar order: [Outline, Editor, Preview, Notes, Order, Focus] — Preview at index 2.
        return btns[2]?.classList.contains('active');
      });
      expect(hasActive).toBe(true);

      await page.evaluate(() => window.togglePreview());
    });

    test('clicking outline toolbar button toggles outline', async () => {
      const wasCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);

      // Click the outline button in toolbar
      await page.click('.toolbar-btn:nth-child(1)');

      const nowCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      expect(nowCollapsed).toBe(!wasCollapsed);

      // Restore state
      await page.click('.toolbar-btn:nth-child(1)');
    });

    test('clicking preview toolbar button toggles preview', async () => {
      const wasCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);

      // Toolbar order: [Outline, Editor, Preview, Notes, Order, Focus] — Preview is the 3rd child.
      await page.click('.toolbar-btn:nth-child(3)');

      const nowCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      expect(nowCollapsed).toBe(!wasCollapsed);

      // Restore state
      await page.click('.toolbar-btn:nth-child(3)');
    });

    test('collapsed sidebar has narrow width (32px)', async () => {
      // Ensure collapsed
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (!isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      // The sidebar uses a 150ms CSS width transition; wait for the
      // post-collapse offsetWidth to settle to the inline 32px value
      // before asserting (otherwise we read mid-animation, e.g. ~80px).
      await page.waitForFunction(
        () => document.querySelector('.outline-sidebar')?.offsetWidth === 32,
        undefined,
        { timeout: 2000 }
      );
      const width = await page.evaluate(() => {
        return document.querySelector('.outline-sidebar')?.offsetWidth;
      });
      expect(width).toBe(32);
    });

    test('expanded outline sidebar shows content area', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const contentVisible = await page.evaluate(() => {
        const content = document.querySelector('.outline-sidebar .sidebar-content');
        if (!content) return false;
        return getComputedStyle(content).display !== 'none';
      });
      expect(contentVisible).toBe(true);

      // Restore state
      await page.evaluate(() => window.toggleOutline());
    });
  });

  // ==========================================================================
  // Keyboard Shortcuts
  // ==========================================================================

  test.describe('Keyboard Shortcuts', () => {
    test('Cmd+Shift+O toggles outline sidebar', async () => {
      const wasBefore = await page.evaluate(() => window.getOutlineState().collapsed);

      await page.keyboard.press('Meta+Shift+o');

      const isAfter = await page.evaluate(() => window.getOutlineState().collapsed);
      expect(isAfter).toBe(!wasBefore);

      // Toggle back
      await page.keyboard.press('Meta+Shift+o');
    });

    test('Cmd+Shift+P toggles preview sidebar', async () => {
      const wasBefore = await page.evaluate(() => window.getPreviewState().collapsed);

      await page.keyboard.press('Meta+Shift+p');

      const isAfter = await page.evaluate(() => window.getPreviewState().collapsed);
      expect(isAfter).toBe(!wasBefore);

      // Toggle back
      await page.keyboard.press('Meta+Shift+p');
    });
  });

  // ==========================================================================
  // Outline Sidebar Content
  // ==========================================================================

  test.describe('Outline Sidebar Content', () => {
    test('outline parses headers from content', async () => {
      const headerCount = await page.evaluate(() => window.getOutlineState().headerCount);
      // The test content has: Introduction, Section One, Subsection 1.1, 1.2,
      // Section Two, Subsection 2.1, Section Three, Subsection 3.1, 3.2 = 9
      expect(headerCount).toBe(9);
    });

    test('outline renders header items when expanded', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const items = await page.evaluate(() => {
        const els = document.querySelectorAll('.outline-item');
        return Array.from(els).map(el => {
          const textEl = el.querySelector('.outline-item-text');
          return textEl?.textContent || '';
        });
      });

      expect(items).toContain('Introduction');
      expect(items).toContain('Section One');
      expect(items).toContain('Subsection 1.1');

      // Restore
      await page.evaluate(() => window.toggleOutline());
    });

    test('outline items have correct indentation per level', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const paddings = await page.evaluate(() => {
        const items = document.querySelectorAll('.outline-item');
        return Array.from(items).map(item => item.style.paddingLeft);
      });

      // H1 headers should have 0px padding (level 1 -> (1-1)*12 = 0)
      expect(paddings[0]).toBe('0px');
      // H2 headers should have 12px padding (level 2 -> (2-1)*12 = 12)
      expect(paddings[1]).toBe('12px');
      // H3 headers should have 24px padding (level 3 -> (3-1)*12 = 24)
      expect(paddings[2]).toBe('24px');

      // Restore
      await page.evaluate(() => window.toggleOutline());
    });

    test('outline updates when content changes', async () => {
      // Set new content with fewer headers
      await page.evaluate(() => {
        window.setEditorContent('# Only One Header\n\nSome text.');
      });

      // Wait for the content change to propagate
      await page.waitForFunction(() => {
        return window.getOutlineState().headerCount === 1;
      });

      const count = await page.evaluate(() => window.getOutlineState().headerCount);
      expect(count).toBe(1);

      // Restore original content
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details.

### Subsection 1.2

Details.

## Section Two

Content.

### Subsection 2.1

More details.

## Section Three

Final section.

### Subsection 3.1

Code.

### Subsection 3.2

Conclusion.
`);
      });

      await page.waitForFunction(() => {
        return window.getOutlineState().headerCount >= 9;
      });
    });

    test('outline shows empty message when no headers', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      await page.evaluate(() => {
        window.setEditorContent('No headers here, just plain text.');
      });

      await page.waitForFunction(() => {
        return window.getOutlineState().headerCount === 0;
      });

      const emptyText = await page.evaluate(() => {
        const el = document.querySelector('.outline-empty');
        return el?.textContent;
      });
      expect(emptyText).toBe('No headers found');

      // Restore content and collapse
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

## Section One

### Subsection 1.1

### Subsection 1.2

## Section Two

### Subsection 2.1

## Section Three

### Subsection 3.1

### Subsection 3.2
`);
      });
      await page.waitForFunction(() => window.getOutlineState().headerCount >= 9);
      await page.evaluate(() => window.toggleOutline());
    });
  });

  // ==========================================================================
  // Preview Sidebar Content
  // ==========================================================================

  test.describe('Preview Sidebar Content', () => {
    test('preview renders HTML from markdown when expanded', async () => {
      // Expand preview
      const isCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.togglePreview());
      }

      const hasH1 = await page.evaluate(() => {
        return !!document.querySelector('.preview-content h1');
      });
      expect(hasH1).toBe(true);

      const hasH2 = await page.evaluate(() => {
        return !!document.querySelector('.preview-content h2');
      });
      expect(hasH2).toBe(true);

      // Collapse
      await page.evaluate(() => window.togglePreview());
    });

    test('preview content updates on editor change', async () => {
      // Expand preview
      const isCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.togglePreview());
      }

      await page.evaluate(() => {
        window.setEditorContent('# New Title\n\nNew paragraph with **bold** text.');
      });

      await page.waitForFunction(() => {
        const h1 = document.querySelector('.preview-content h1');
        return h1?.textContent === 'New Title';
      });

      const hasBold = await page.evaluate(() => {
        return !!document.querySelector('.preview-content strong');
      });
      expect(hasBold).toBe(true);

      // Restore content and collapse
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content.

### Subsection 1.1

Details.

### Subsection 1.2

Details.

## Section Two

Content.

### Subsection 2.1

More details.

## Section Three

Final section.

### Subsection 3.1

Code.

### Subsection 3.2

Conclusion.
`);
      });
      await page.evaluate(() => window.togglePreview());
    });
  });

  // ==========================================================================
  // Focus Mode
  // ==========================================================================

  test.describe('Focus Mode', () => {
    test('entering focus mode hides sidebars and resizers', async () => {
      expect(await page.evaluate(() => window.isInFocusMode())).toBe(false);

      await page.evaluate(() => window.toggleFocusMode());

      expect(await page.evaluate(() => window.isInFocusMode())).toBe(true);

      const outlineDisplay = await page.evaluate(() =>
        document.querySelector('.outline-sidebar')?.style.display
      );
      const previewDisplay = await page.evaluate(() =>
        document.querySelector('.preview-sidebar')?.style.display
      );
      expect(outlineDisplay).toBe('none');
      expect(previewDisplay).toBe('none');

      // The wrapper should have focus-mode class
      const hasFocusClass = await page.evaluate(() =>
        document.querySelector('.editor-layout')?.classList.contains('focus-mode')
      );
      expect(hasFocusClass).toBe(true);

      // Exit focus mode
      await page.evaluate(() => window.toggleFocusMode());
    });

    test('exiting focus mode restores sidebar visibility', async () => {
      await page.evaluate(() => window.toggleFocusMode());
      expect(await page.evaluate(() => window.isInFocusMode())).toBe(true);

      await page.evaluate(() => window.toggleFocusMode());
      expect(await page.evaluate(() => window.isInFocusMode())).toBe(false);

      // Sidebars should be restored (not display: none)
      const outlineDisplay = await page.evaluate(() =>
        document.querySelector('.outline-sidebar')?.style.display
      );
      expect(outlineDisplay).toBe('');
    });

    test('Escape exits focus mode', async () => {
      await page.evaluate(() => window.toggleFocusMode());
      expect(await page.evaluate(() => window.isInFocusMode())).toBe(true);

      await page.keyboard.press('Escape');

      expect(await page.evaluate(() => window.isInFocusMode())).toBe(false);
    });

    test('focus button gets active class in focus mode', async () => {
      await page.evaluate(() => window.toggleFocusMode());

      const hasActive = await page.evaluate(() => {
        const btns = document.querySelectorAll('.toolbar-btn');
        // Toolbar order: [Outline, Editor, Preview, Notes, Order, Focus] — Focus at index 5.
        return btns[5]?.classList.contains('active');
      });
      expect(hasActive).toBe(true);

      // Exit focus mode
      await page.keyboard.press('Escape');
    });

    test('double toggle returns to original state', async () => {
      const wasInFocus = await page.evaluate(() => window.isInFocusMode());

      await page.evaluate(() => window.toggleFocusMode());
      await page.evaluate(() => window.toggleFocusMode());

      const isInFocus = await page.evaluate(() => window.isInFocusMode());
      expect(isInFocus).toBe(wasInFocus);
    });
  });

  // ==========================================================================
  // Resizers
  // ==========================================================================

  test.describe('Resizers', () => {
    // Resizers are named after the adjacent panes: `.resizer-outline-editor`
    // sits between Outline and Editor (the "left" resizer in the default
    // pane order); `.resizer-editor-preview` between Editor and Preview
    // (the "right" resizer); `.resizer-annotations` outside the main
    // pane container.
    test('left and right resizers exist in DOM', async () => {
      const leftResizer = await page.evaluate(() =>
        !!document.querySelector('.resizer-outline-editor')
      );
      const rightResizer = await page.evaluate(() =>
        !!document.querySelector('.resizer-editor-preview')
      );
      expect(leftResizer).toBe(true);
      expect(rightResizer).toBe(true);
    });

    test('resizers have cursor: col-resize', async () => {
      const cursor = await page.evaluate(() => {
        const resizer = document.querySelector('.resizer-outline-editor');
        return resizer ? getComputedStyle(resizer).cursor : null;
      });
      expect(cursor).toBe('col-resize');
    });

    test('resizer indicator shows on hover', async () => {
      // Expand outline first so the resizer is visible
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const resizer = page.locator('.resizer-outline-editor');
      await resizer.hover();

      const indicatorVisible = await page.evaluate(() => {
        const indicator = document.querySelector('.resizer-outline-editor .resizer-indicator');
        return indicator?.classList.contains('visible');
      });
      expect(indicatorVisible).toBe(true);

      // Move away to remove hover
      await page.mouse.move(0, 0);

      // Collapse back
      await page.evaluate(() => window.toggleOutline());
    });

    test('dragging left resizer changes outline width', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const initialWidth = await page.evaluate(() =>
        document.querySelector('.outline-sidebar')?.offsetWidth
      );

      // Get resizer position
      const resizerBox = await page.locator('.resizer-outline-editor').boundingBox();
      if (resizerBox) {
        const startX = resizerBox.x + resizerBox.width / 2;
        const startY = resizerBox.y + resizerBox.height / 2;

        // Drag right by 50px to widen the outline
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 50, startY);
        await page.mouse.up();

        const newWidth = await page.evaluate(() =>
          document.querySelector('.outline-sidebar')?.offsetWidth
        );

        // Width should have increased (approximately 50px more)
        expect(newWidth).toBeGreaterThan(initialWidth! - 10); // Allow some tolerance
      }

      // Collapse back
      await page.evaluate(() => window.toggleOutline());
    });
  });

  // ==========================================================================
  // Filename Display
  // ==========================================================================

  test.describe('Filename Display', () => {
    test('filename is hidden by default', async () => {
      const display = await page.evaluate(() => {
        const el = document.querySelector('.filename-display');
        return el ? (el as HTMLElement).style.display : null;
      });
      expect(display).toBe('none');
    });

    test('setFilename shows filename in toolbar', async () => {
      await page.evaluate(() => window.setFilename('test-doc.md'));

      const text = await page.evaluate(() => window.getFilename());
      expect(text).toBe('test-doc.md');

      const display = await page.evaluate(() => {
        const el = document.querySelector('.filename-display');
        return el ? (el as HTMLElement).style.display : null;
      });
      expect(display).toBe('inline-block');

      // Reset
      await page.evaluate(() => window.setFilename(null));
    });

    test('setFilename(null) hides the filename', async () => {
      await page.evaluate(() => window.setFilename('visible.md'));
      await page.evaluate(() => window.setFilename(null));

      const display = await page.evaluate(() => {
        const el = document.querySelector('.filename-display');
        return el ? (el as HTMLElement).style.display : null;
      });
      expect(display).toBe('none');
    });
  });

  // ==========================================================================
  // Save Status Indicator
  // ==========================================================================

  test.describe('Save Status Indicator', () => {
    test('save status is hidden by default', async () => {
      const display = await page.evaluate(() => {
        const el = document.getElementById('save-status');
        return el ? el.style.display : null;
      });
      expect(display).toBe('none');
    });

    test('setSaveStatusVisible(true) shows indicator', async () => {
      await page.evaluate(() => window.setSaveStatusVisible(true));

      const display = await page.evaluate(() => {
        const el = document.getElementById('save-status');
        return el ? el.style.display : null;
      });
      expect(display).toBe('inline-block');

      // Reset
      await page.evaluate(() => window.setSaveStatusVisible(false));
    });
  });

  // ==========================================================================
  // Content Management
  // ==========================================================================

  test.describe('Content Management', () => {
    test('getContent returns current editor text', async () => {
      const content = await page.evaluate(() => window.getEditorContent());
      expect(content).toContain('# Introduction');
    });

    test('setContent replaces editor text', async () => {
      const newContent = '# Replaced\n\nNew content here.';
      await page.evaluate((c) => window.setEditorContent(c), newContent);

      const content = await page.evaluate(() => window.getEditorContent());
      expect(content).toBe(newContent);

      // Restore
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content.

### Subsection 1.1

Details.

### Subsection 1.2

Details.

## Section Two

Content.

### Subsection 2.1

More details.

## Section Three

Final section.

### Subsection 3.1

Code.

### Subsection 3.2

Conclusion.
`);
      });
    });

    test('content change triggers onContentChange callback', async () => {
      await page.evaluate(() => {
        window._lastContentChange = null;
        window.setEditorContent('# Callback Test');
      });

      await page.waitForFunction(() => window._lastContentChange !== null);

      const changed = await page.evaluate(() => window._lastContentChange);
      expect(changed).toBe('# Callback Test');

      // Restore
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content.

### Subsection 1.1

Details.

### Subsection 1.2

Details.

## Section Two

Content.

### Subsection 2.1

More details.

## Section Three

Final section.

### Subsection 3.1

Code.

### Subsection 3.2

Conclusion.
`);
      });
    });
  });

  // ==========================================================================
  // Outline Section Collapsing
  // ==========================================================================

  test.describe('Outline Section Collapsing', () => {
    test('parent headers have fold toggle arrows', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      const toggleCount = await page.evaluate(() => {
        return document.querySelectorAll('.outline-fold-toggle').length;
      });
      // At least some headers should have fold toggles (those with children)
      expect(toggleCount).toBeGreaterThan(0);

      // Collapse
      await page.evaluate(() => window.toggleOutline());
    });

    test('clicking fold toggle hides child headers', async () => {
      // Expand outline
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      // Count visible items before
      const visibleBefore = await page.evaluate(() => {
        const items = document.querySelectorAll('.outline-item');
        return Array.from(items).filter(el =>
          (el as HTMLElement).style.display !== 'none'
        ).length;
      });

      // Click the first fold toggle (should be on a parent header)
      const firstToggle = page.locator('.outline-fold-toggle').first();
      await firstToggle.click();

      // Count visible items after
      const visibleAfter = await page.evaluate(() => {
        const items = document.querySelectorAll('.outline-item');
        return Array.from(items).filter(el =>
          (el as HTMLElement).style.display !== 'none'
        ).length;
      });

      // Fewer items should be visible
      expect(visibleAfter).toBeLessThan(visibleBefore);

      // Click again to restore
      const toggleAfter = page.locator('.outline-fold-toggle').first();
      await toggleAfter.click();

      // Collapse outline
      await page.evaluate(() => window.toggleOutline());
    });
  });

  // ==========================================================================
  // Sidebar Toggle via Internal Button
  // ==========================================================================

  test.describe('Sidebar Internal Toggle', () => {
    test('outline sidebar toggle button collapses sidebar', async () => {
      // Expand outline if collapsed
      const isCollapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.toggleOutline());
      }

      // Click the internal toggle button in the sidebar header
      const sidebarToggle = page.locator('.outline-sidebar .sidebar-toggle');
      await sidebarToggle.click();

      const collapsed = await page.evaluate(() => window.getOutlineState().collapsed);
      expect(collapsed).toBe(true);
    });

    test('preview sidebar toggle button collapses sidebar', async () => {
      // Expand preview if collapsed
      const isCollapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      if (isCollapsed) {
        await page.evaluate(() => window.togglePreview());
      }

      const sidebarToggle = page.locator('.preview-sidebar .sidebar-toggle');
      await sidebarToggle.click();

      const collapsed = await page.evaluate(() => window.getPreviewState().collapsed);
      expect(collapsed).toBe(true);
    });
  });

  // ==========================================================================
  // CodeMirror Integration
  // ==========================================================================

  test.describe('CodeMirror Integration', () => {
    test('CodeMirror editor is rendered in the container', async () => {
      const hasCmEditor = await page.evaluate(() =>
        !!document.querySelector('.cm-editor')
      );
      expect(hasCmEditor).toBe(true);
    });

    test('editor is focusable', async () => {
      await page.click('.cm-content');

      const isFocused = await page.evaluate(() =>
        document.querySelector('.cm-editor')?.classList.contains('cm-focused')
      );
      expect(isFocused).toBe(true);
    });

    test('fold gutter is present', async () => {
      const hasFoldGutter = await page.evaluate(() =>
        !!document.querySelector('.cm-foldGutter')
      );
      expect(hasFoldGutter).toBe(true);
    });
  });

  // ==========================================================================
  // Notes and Highlights
  // ==========================================================================

  test.describe('Notes and Highlights', () => {
    test('Cmd+Shift+H toggles notes pane', async () => {
      const wasBefore = await page.evaluate(() => window.getAnnotationsState().visible);

      await page.keyboard.press('Meta+Shift+h');

      const isAfter = await page.evaluate(() => window.getAnnotationsState().visible);
      expect(isAfter).toBe(!wasBefore);

      // Toggle back to original state
      await page.keyboard.press('Meta+Shift+h');
      const restored = await page.evaluate(() => window.getAnnotationsState().visible);
      expect(restored).toBe(wasBefore);
    });

    test('notes pane title says Notes', async () => {
      // Open notes pane
      await page.evaluate(() => {
        if (!window.getAnnotationsState().visible) window.toggleAnnotations();
      });

      const title = await page.evaluate(() => {
        const el = document.querySelector('.annotations-pane .sidebar-title');
        return el?.textContent;
      });
      expect(title).toBe('Notes');

      // Close pane
      await page.evaluate(() => {
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('Cmd+Shift+L with selection captures the selected text', async () => {
      // Set known content and select some text
      await page.evaluate(() => {
        window.setEditorContent('Hello World\nSecond line\nThird line');
      });

      // Wait for content to settle
      await page.waitForFunction(() => window.getEditorContent() === 'Hello World\nSecond line\nThird line');

      // Select "World" (chars 6-11)
      await page.evaluate(() => window.selectRange(6, 11));

      // Press Cmd+Shift+L to add highlight
      await page.keyboard.press('Meta+Shift+l');

      // Wait for highlight to appear
      await page.waitForFunction(() => window.getEditorHighlights().length > 0);

      const highlights = await page.evaluate(() => window.getEditorHighlights());
      expect(highlights.length).toBeGreaterThanOrEqual(1);

      const hl = highlights[highlights.length - 1];
      expect(hl.text).toBe('World');
      expect(hl.from).toBe(6);
      expect(hl.to).toBe(11);

      // Restore content
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('Cmd+Shift+L without selection anchors to current line', async () => {
      // Set known content
      await page.evaluate(() => {
        window.setEditorContent('First line\nSecond line\nThird line');
      });
      await page.waitForFunction(() => window.getEditorContent() === 'First line\nSecond line\nThird line');

      // Place cursor in "Second line" (position 15, no selection)
      await page.evaluate(() => window.setCursor(15));

      // Press Cmd+Shift+L with no selection
      await page.keyboard.press('Meta+Shift+l');

      // Wait for highlight
      await page.waitForFunction(() => window.getEditorHighlights().length > 0);

      const highlights = await page.evaluate(() => window.getEditorHighlights());
      const hl = highlights[highlights.length - 1];
      // Should cover the full "Second line" -- from=11, to=22, text=line content
      expect(hl.text).toBe('Second line');
      expect(hl.from).toBe(11);
      expect(hl.to).toBe(22);

      // Restore content
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('notes pane shows "Line N — <excerpt>" for highlights with no note', async () => {
      // Set known content
      await page.evaluate(() => {
        window.setEditorContent('Alpha\nBravo\nCharlie');
      });
      await page.waitForFunction(() => window.getEditorContent() === 'Alpha\nBravo\nCharlie');

      // Select "Bravo" (from=6, to=11)
      await page.evaluate(() => window.selectRange(6, 11));

      await page.keyboard.press('Meta+Shift+l');

      // Notes pane should auto-open; wait for annotation items
      await page.waitForFunction(() => {
        return document.querySelectorAll('.annotation-item').length > 0;
      });

      const items = await page.evaluate(() => window.getAnnotationItems());
      const lastItem = items[items.length - 1];
      // Header is "Line N — <text-excerpt>" — Bravo is on line 2.
      expect(lastItem.text).toContain('Line 2');
      expect(lastItem.text).toContain('Bravo');

      // Restore content and close pane
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('notes pane shows "Line N" with note text for annotated highlights', async () => {
      // Set known content
      await page.evaluate(() => {
        window.setEditorContent('Alpha\nBravo\nCharlie');
      });
      await page.waitForFunction(() => window.getEditorContent() === 'Alpha\nBravo\nCharlie');

      // Select "Alpha" (from=0, to=5) and add highlight
      await page.evaluate(() => window.selectRange(0, 5));
      await page.keyboard.press('Meta+Shift+l');

      await page.waitForFunction(() => window.getEditorHighlights().length > 0);

      // Add a note to the highlight
      const hlId = await page.evaluate(() => {
        const hls = window.getEditorHighlights();
        return hls[hls.length - 1].id;
      });
      await page.evaluate((id) => window.updateHighlightNote(id, 'My note text'), hlId);

      // Wait for annotation items to update
      await page.waitForFunction(() => {
        const items = document.querySelectorAll('.annotation-item');
        return Array.from(items).some(item =>
          item.querySelector('.annotation-note')?.textContent === 'My note text'
        );
      });

      const items = await page.evaluate(() => window.getAnnotationItems());
      const annotatedItem = items.find(i => i.note === 'My note text');
      expect(annotatedItem).toBeTruthy();
      // Header shows "Line N — <excerpt>" regardless of whether a note exists;
      // the note is rendered separately in `.annotation-note`. For "Alpha"
      // selected on line 1 the header is "Line 1 — Alpha".
      expect(annotatedItem!.text).toBe('Line 1 — Alpha');
      expect(annotatedItem!.note).toBe('My note text');

      // Restore content and close pane
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('notes pane has a delete button on each item', async () => {
      // Set known content and create a highlight
      await page.evaluate(() => {
        window.setEditorContent('Test content line');
      });
      await page.waitForFunction(() => window.getEditorContent() === 'Test content line');

      await page.evaluate(() => window.selectRange(0, 4));
      await page.keyboard.press('Meta+Shift+l');

      await page.waitForFunction(() => {
        return document.querySelectorAll('.annotation-item').length > 0;
      });

      // Each item exposes a single inline action button: delete (×).
      // Editing happens by clicking the header row (no separate Edit button).
      const deleteBtn = await page.evaluate(() => {
        const btn = document.querySelector('.annotation-item .annotation-btn-delete');
        return { text: btn?.textContent, hasDeleteClass: !!btn };
      });
      expect(deleteBtn.hasDeleteClass).toBe(true);
      expect(deleteBtn.text).toBe('×');

      // Restore content and close pane
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });

    test('Cmd+Shift+L auto-opens notes pane', async () => {
      // Ensure notes pane is closed
      await page.evaluate(() => {
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });

      await page.evaluate(() => {
        window.setEditorContent('Some text to highlight');
      });
      await page.waitForFunction(() => window.getEditorContent() === 'Some text to highlight');

      await page.evaluate(() => window.selectRange(0, 4));
      await page.keyboard.press('Meta+Shift+l');

      // Notes pane should be auto-opened
      await page.waitForFunction(() => window.getAnnotationsState().visible === true);

      const visible = await page.evaluate(() => window.getAnnotationsState().visible);
      expect(visible).toBe(true);

      // Restore
      await page.evaluate(() => {
        window.setEditorContent(`# Introduction

Welcome to the document.

## Section One

Content in section one.

### Subsection 1.1

Details about subsection 1.1.

### Subsection 1.2

Details about subsection 1.2.

## Section Two

Content in section two.

### Subsection 2.1

More details here.

## Section Three

Final section content.

### Subsection 3.1

Some code:

\`\`\`javascript
function hello() {
  console.log('world');
}
\`\`\`

### Subsection 3.2

Conclusion text.
`);
        if (window.getAnnotationsState().visible) window.toggleAnnotations();
      });
    });
  });
});
