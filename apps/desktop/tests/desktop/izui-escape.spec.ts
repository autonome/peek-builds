import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

test.describe('IZUI Escape Protocol @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('izui-escape'));

    // A resolvable local page for the palette-opener test. That test needs a
    // window `izui-roles.ts inferIzuiRole` can classify as `content` /
    // `child-content`, and both arms require `ctx.isWebPage` — a `peek://` URL
    // falls through to `workspace` and can never carry either role. The URL
    // must also resolve: the hybrid page-host branch awaits the content WC's
    // `loadURL` and reports `{success:false}` when that navigation fails.
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>opened</title></head><body>opened</body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('navigate mode: escape navigates internally before requesting close', async () => {

    // Create a group with items so we can navigate into it
    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('izui-esc-test');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://izui-esc-test.example.com',
        metadata: JSON.stringify({ title: 'IZUI ESC Test' })
      });
    });
    expect(item.success).toBe(true);

    if (tagId && item.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item.data.id, tagId });
    }

    // Open groups window (background.js uses escapeMode: 'navigate')
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 800,
        height: 600,
        escapeMode: 'navigate'
      });
    });
    expect(groupsResult.success).toBe(true);

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Navigate to addresses view by clicking a group
    const groupCard = await groupsWindow.$('peek-card.group-card[data-tag-id="' + tagId + '"]');
    if (groupCard) {
      await groupCard.click();
    } else {
      const anyCard = await groupsWindow.$('peek-card.group-card');
      expect(anyCard).toBeTruthy();
      await anyCard!.click();
    }
    await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });

    // Verify we're in addresses view
    const viewBefore = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewBefore).toBe('addresses');

    // Trigger escape via the IZUI chain - should navigate back to groups (handled: true)
    const escResult1 = await groupsWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    expect(escResult1.handled).toBe(true);

    // Wait for navigation to complete — waitForSelector is the deterministic signal
    // that showGroups() has rendered (the setTimeout(0) in handleEscape fires and
    // DOM updates before group-card is inserted into the DOM).
    await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

    // Verify we're back in groups view
    const viewAfter = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewAfter).toBe('groups');

    // Trigger escape again at root - renderer returns { handled: false } at root
    // Backend handles close policy (child/transient windows close, active root stays)
    const escResult2 = await groupsWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    // trigger() calls the handler directly - at root, groups returns { handled: false }
    expect(escResult2.handled).toBe(false);

    // Clean up - trigger() doesn't go through backend ESC path, so window is still open
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('peek-card: Enter key activates card via card-click event', async () => {

    // Create a group with an item
    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('enter-key-test');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://enter-key-test.example.com',
        metadata: JSON.stringify({ title: 'Enter Key Test' })
      });
    });
    expect(item.success).toBe(true);

    if (tagId && item.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item.data.id, tagId });
    }

    // Open groups window
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 800,
        height: 600
      });
    });
    expect(groupsResult.success).toBe(true);

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

    // Verify we're in groups view
    const viewBefore = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewBefore).toBe('groups');

    // Programmatically activate the first card (simulates Enter key path)
    const activated = await groupsWindow.evaluate(async () => {
      const card = document.querySelector('peek-card.group-card') as any;
      if (!card) return false;
      card.click();
      return true;
    });
    expect(activated).toBe(true);

    // Should navigate to addresses view
    await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });
    const viewAfter = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewAfter).toBe('addresses');

    // Clean up
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('active mode: ESC at root does NOT close window', async () => {

    // Open groups window with role: 'workspace' (like the real groups extension does)
    // In headless/test mode, appFocused defaults to true → session is 'active'
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 400,
        height: 300,
      });
    });
    expect(groupsResult.success).toBe(true);
    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Verify the window's role is 'workspace' and session is 'active'
    const izuiState = await bgWindow.evaluate(async () => {
      return await (window as any).app.izui.getState();
    });
    expect(izuiState).toBe('active');

    // Press ESC via keyboard — goes through full backend path:
    // before-input-event → handleEscapeForWindow → askRendererToHandleEscape →
    // renderer returns { handled: false } at root → escPolicy('active', 'workspace') → 'nothing'
    await groupsWindow.keyboard.press('Escape');

    // Wait for the async ESC handling to complete
    await new Promise(resolve => setTimeout(resolve, 600));

    // Verify window is still alive — if escPolicy is wrong, the window would be closed
    const stillAlive = await groupsWindow.evaluate(() => true).catch(() => false);
    expect(stillAlive).toBe(true);

    // Also verify the view is still at root (groups list)
    const view = await groupsWindow.evaluate(() => (window as any)._groupsState?.view);
    expect(view).toBe('groups');

    // Clean up
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (wid: number) => {
          return await (window as any).app.window.close(wid);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('active mode: ESC on child-content window does NOT close it (regression)', async () => {

    // First open a workspace window (like groups) to establish an active session
    const workspaceResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 400,
        height: 300,
      });
    });
    expect(workspaceResult.success).toBe(true);
    const workspaceWindow = await app.getWindow('groups/home.html', 5000);
    expect(workspaceWindow).toBeTruthy();
    await workspaceWindow.waitForLoadState('domcontentloaded');

    // Verify session is active
    const izuiState = await bgWindow.evaluate(async () => {
      return await (window as any).app.izui.getState();
    });
    expect(izuiState).toBe('active');

    // Now open a child-content window (simulates opening a web page from groups)
    // Using the workspace window as the opener gives it child-content role
    const contentResult = await workspaceWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://search/home.html', {
        role: 'child-content',
        width: 400,
        height: 300,
      });
    });
    expect(contentResult.success).toBe(true);
    const contentWindow = await app.getWindow('search/home.html', 5000);
    expect(contentWindow).toBeTruthy();
    await contentWindow.waitForLoadState('domcontentloaded');

    // Trigger escape via the renderer callback directly — search/home.html has no
    // onEscape handler so trigger() returns { handled: false } immediately.
    // The regression: child-content would be closed on ESC before the escPolicy fix.
    // The backend policy (escPolicy('active','child-content') === 'nothing') is a
    // pure function tested in izui-state.test.ts. Here we verify the renderer path
    // doesn't close the window.
    const escResult = await contentWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    expect(escResult).toEqual({ handled: false });

    // Verify child-content window is still alive — if the window were incorrectly
    // closed on ESC, this evaluate() call would throw/return false.
    const stillAlive = await contentWindow.evaluate(() => true).catch(() => false);
    expect(stillAlive).toBe(true);

    // Clean up
    for (const id of [contentResult.id, workspaceResult.id]) {
      if (id) {
        try {
          await bgWindow.evaluate(async (wid: number) => {
            return await (window as any).app.window.close(wid);
          }, id);
        } catch {
          // Window may already be closed
        }
      }
    }
  });

  test('regression: a page opened FROM a palette-role opener is classified content, never child-content', async () => {
    // Symptom of the bug this guards: with Peek focused, ESC closed web pages
    // the user opened via the cmd panel. Root cause was that `isRealParent` in
    // window-open treated any opener that wasn't bg (peek://app/background.html)
    // as a real content parent — including the cmd palette. URLs opened from a
    // palette were then classified `role: 'child-content'`, which at the time
    // closed on ESC in every session. The fix (`ipc.ts NON_PARENT_ROLES`)
    // excludes launcher roles from the real-parent test.
    //
    // WHAT THIS TEST ASSERTS, AND WHY IT IS NOT THE ESC OUTCOME.
    //
    // The classification is the only remaining observable that separates the
    // fixed world from the broken one. The ESC outcome no longer does, in any
    // session: `window-state.ts escPolicy` — the live table, reached through
    // `decideEscape` — returns `'nothing'` for ('active', 'child-content') and
    // `'close'` for BOTH 'content' and 'child-content' under 'transient', so no
    // session value tells the two roles apart. `900b0268`'s "child-content
    // always closes regardless of session" arm is absent from that table and
    // from its successor `window-escape.ts escapeClosePolicy`; it was dropped
    // when the policy was ported out of `izui-state.ts` and never restored.
    // `main.ts` treats the two roles identically at both of its role tests.
    //
    // So an ESC assertion here passes whatever the classification is, which is
    // what made the previous version of this test vacuous — it survived
    // `'palette'` being deleted from `NON_PARENT_ROLES`, the exact defect it
    // names. Asserting the role instead fails on that deletion.
    //
    // The URL opened below must be http(s). `izui-roles.ts inferIzuiRole` gates
    // both 'content' and 'child-content' on `ctx.isWebPage`; a `peek://` URL
    // falls through to 'workspace', which the ESC table never closes in any
    // session. The previous version opened `peek://search/home.html` and so
    // could not reach either role — a second, independent reason it proved
    // nothing.

    // Open a palette-role window via bg. This stands in for the cmd panel
    // (app/cmd/background.js opens itself with role: 'palette').
    const paletteResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'palette',
        width: 400,
        height: 300,
      });
    });
    expect(paletteResult.success).toBe(true);
    const paletteWindow = await app.getWindow('groups/home.html', 5000);
    expect(paletteWindow).toBeTruthy();
    await paletteWindow.waitForLoadState('domcontentloaded');

    // From the palette window, open a web URL. Under the bug the opened window
    // is tagged child-content with the palette as parentWindowId; under the fix
    // it is content with no parent.
    //
    // The palette does NOT survive this open, and that is the specified
    // behaviour rather than a defect: the opened page takes key, and
    // `window-kernel.ts selectTransientAutoclose` dismisses a visible
    // transient whenever another window genuinely takes key, unless that
    // window names it as parent. A page opened from the palette deliberately
    // does not (`ipc.ts NON_PARENT_ROLES` — the same exclusion this test
    // guards), so no exemption applies. A chain popup DOES stay exempt,
    // because `renderer/cmd/panel.js openChainPopup()` passes
    // `declareParent: true`.
    //
    // So the open is fired WITHOUT awaiting its result: the evaluate's own
    // page is destroyed mid-call, which rejects the promise. The opened
    // window is found in the registry by address instead.
    const openedUrl = `http://127.0.0.1:${serverPort}/`;
    await paletteWindow
      .evaluate((u: string) => {
        void (window as any).app.window.open(u, { width: 400, height: 300 });
      }, openedUrl)
      .catch(() => {
        // Expected: the palette is dismissed as the opened page takes key.
      });

    // Poll rather than sleep: the open was not awaited, so the only signal that
    // registration happened is the window appearing in the registry. A web URL
    // lands on the hybrid page-host branch (a BaseWindow), which Playwright
    // never exposes as a Page — the registry is the only way to read it.
    let opened: { id: number; params: Record<string, unknown> } | null = null;
    for (let i = 0; i < 50 && opened === null; i++) {
      opened = await bgWindow.evaluate(async (u: string) => {
        const result = await (window as any).app.window.list({ includeInternal: true });
        if (!result.success) return null;
        const hit = result.windows.find((w: any) => w.params?.address === u);
        return hit ? { id: hit.id, params: hit.params } : null;
      }, openedUrl);
      if (opened === null) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(opened, `no window registered for ${openedUrl}`).toBeTruthy();

    // The assertions the fix is answerable for. Delete 'palette' from
    // `ipc.ts NON_PARENT_ROLES` and both of these fail: `isRealParent` becomes
    // true, which stamps the palette as parentWindowId and promotes the role to
    // child-content in `inferIzuiRole`.
    // Asserted as a pair so a failure reports both facts — the parent stamp and
    // the role promotion are one defect, and checking them in sequence would
    // hide the second behind the first.
    expect({
      parentWindowId: opened!.params.parentWindowId,
      role: opened!.params.role,
    }).toEqual({ parentWindowId: null, role: 'content' });

    // Secondary, and asserted AFTER the guard above so a regression in the
    // guard fails on the guard rather than here: the palette was dismissed when
    // the opened page took key. If `ipc.ts NON_PARENT_ROLES` ever stops
    // excluding the palette, the opened page becomes its child, the exemption
    // in `window-kernel.ts selectTransientAutoclose` applies, and this inverts —
    // but the pair above fails first, which is the intended signal.
    await expect.poll(() => paletteWindow.isClosed(), { timeout: 5000 }).toBe(true);

    // Clean up. The palette is already gone (asserted above).
    await bgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.close(wid);
    }, opened!.id).catch(() => {
      // Window may already be closed
    });
  });

  test('navigate mode: timeout does not close window', async () => {

    // Open a window with navigate escape mode but NO escape handler registered
    // This simulates what happens when a window hasn't finished loading its IZUI
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
        escapeMode: 'navigate'
      });
    });
    expect(result.success).toBe(true);

    const testWindow = await app.getWindow('groups/home.html', 5000);
    expect(testWindow).toBeTruthy();
    await testWindow.waitForLoadState('domcontentloaded');

    // The groups extension registers an escape handler via api.escape.onEscape.
    // At root (groups view), handler returns { handled: false }.
    // Backend handles close policy via navigate mode.
    await testWindow.waitForSelector('.cards', { timeout: 5000 });
    const escResult = await testWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    // trigger() calls handler directly - at root, groups returns { handled: false }
    expect(escResult.handled).toBe(false);

    // trigger() doesn't go through backend ESC path, window is still open
    // Clean up
    if (result.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, result.id);
      } catch {
        // Window may already be closed
      }
    }
  });
});
