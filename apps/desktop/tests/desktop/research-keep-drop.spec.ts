import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';
import { waitOverlayReady } from '../helpers/hybrid-page';

/**
 * Keep or drop a page, with a one-line note.
 *
 * Two surfaces write the same state — a `kept` or `dropped` tag on the page's URL
 * item, plus `metadata.notes` — so both are covered here:
 *
 *  - The `keep` / `drop` / `unjudge` commands, which resolve the window the user is
 *    looking at. Driven the way `tag-command.spec.ts` drives `tag`: publish
 *    `cmd:execute:<name>` with a `resultTopic`, because the main-process test hook
 *    `publishCmdExecute` cannot carry arguments and a note is an argument.
 *    The window is an inert `peek://` page, as in `tag-command.spec.ts` — the command
 *    reads the active window's URL and never loads it, so a real page host would add a
 *    network load without testing anything more.
 *
 *  - The overlay's keep and drop buttons, which live in the shared chrome renderer. The
 *    overlay's panels only key on http(s) URLs, which a fake hybrid host's `data:` URL
 *    can't carry, so the active host is made and then told it navigated to an http URL
 *    (the `makeActiveWithUrl` pattern from `hybrid-overlay.spec.ts`). The buttons are
 *    clicked through `evalInOverlay` — no spec holds a Playwright page for the overlay.
 */

test.describe('Research keep/drop @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('research-keep-drop'));
    await waitForExtensionsReady(bgWindow, 15000);
    await sleep(500); // let the app stabilize before opening windows
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  let callSeq = 0;

  /** Run a research command with its argument text and wait for its result. */
  const runCommand = (command: string, search = '') =>
    bgWindow.evaluate(async (args: { command: string; topic: string; search: string }) => {
      const api = (window as any).app;
      return new Promise((resolve) => {
        api.subscribe(args.topic, (r: any) => resolve(r));
        api.publish(`cmd:execute:${args.command}`, {
          search: args.search, params: [], expectResult: true, resultTopic: args.topic,
        });
        setTimeout(() => resolve({ error: 'timeout' }), 15000);
      });
    }, { command, search, topic: `cmd:execute:${command}:result:${callSeq++}` }) as Promise<any>;

  /** The tag names on `url`'s item, sorted; `null` when the item does not exist. */
  const tagsForUrl = (url: string) =>
    bgWindow.evaluate(async (target: string) => {
      const api = (window as any).app;
      const found = await api.datastore.findUrlItem(target);
      if (!found.success || !found.data) return null;
      const tags = await api.datastore.getItemTags(found.data.id);
      return tags.success ? (tags.data || []).map((t: any) => t.name).sort() : [];
    }, url) as Promise<string[] | null>;

  /** `metadata.notes` on `url`'s item; metadata is stored as JSON text. */
  const noteForUrl = (url: string) =>
    bgWindow.evaluate(async (target: string) => {
      const api = (window as any).app;
      const found = await api.datastore.findUrlItem(target);
      if (!found.success || !found.data) return null;
      const raw = found.data.metadata;
      let metadata: any = {};
      try { metadata = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { /* keep {} */ }
      return metadata.notes ?? null;
    }, url) as Promise<string | null>;

  test('keep and drop record the state and the note on the active page', async () => {
    const pageUrl = `peek://app/settings/settings.html?research=${Date.now()}`;

    const win = await bgWindow.evaluate(async (url: string) => {
      const api = (window as any).app;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const opened = await api.window.open(url, {
        role: 'workspace', width: 600, height: 400, key: 'research-keep-drop-page',
      });
      if (!opened.success) return { error: opened.error };
      await wait(250);
      await api.window.focus(opened.id);
      await wait(250);
      const tracked = await api.window.getFocusedVisibleWindowId();
      const list = await api.window.list({ includeInternal: false });
      return { id: opened.id, tracked, url: list.windows.find((w: any) => w.id === opened.id)?.url };
    }, pageUrl);

    expect(win.error).toBeUndefined();
    expect(win.tracked).toBe(win.id);
    const activeUrl = win.url!;

    // keep with a note
    const kept = await runCommand('keep', 'too long');
    expect(kept.success).toBe(true);
    expect(kept.state).toBe('kept');
    expect(await tagsForUrl(activeUrl)).toContain('kept');
    expect(await noteForUrl(activeUrl)).toBe('too long');

    // drop with no note: the state swaps, the note stays
    const dropped = await runCommand('drop');
    expect(dropped.success).toBe(true);
    expect(dropped.state).toBe('dropped');
    const afterDrop = await tagsForUrl(activeUrl);
    expect(afterDrop).toContain('dropped');
    expect(afterDrop).not.toContain('kept');
    expect(await noteForUrl(activeUrl)).toBe('too long');

    // unjudge clears the state and leaves the note
    const unjudged = await runCommand('unjudge');
    expect(unjudged.success).toBe(true);
    expect(unjudged.state).toBeNull();
    const afterUnjudge = await tagsForUrl(activeUrl);
    expect(afterUnjudge).not.toContain('kept');
    expect(afterUnjudge).not.toContain('dropped');
    expect(await noteForUrl(activeUrl)).toBe('too long');

    await bgWindow.evaluate(async (id: number) => {
      try { await (window as any).app.window.close(id); } catch { /* closing */ }
    }, win.id!);
  });

  test("the overlay's keep button sets the state and clicking it again clears it", async () => {
    const pageUrl = `https://research-keep-drop-${Date.now()}.example.com/page`;

    // A fake hybrid host, made active, then told it navigated to an http URL — the
    // overlay's panels key on the URL, not on what the fake host actually loaded.
    const hostId = await app.evaluateMain!(async () => {
      const bridge = (globalThis as any).__peekHybridOverlayTest;
      const id = bridge.makeFakeHybridWindow({ x: 100, y: 100, width: 700, height: 500 });
      await bridge.loadFakeContent(id, 'data:text/html,<title>research</title>research');
      bridge.setActive(id);
      return id;
    });
    await waitOverlayReady(app);
    await app.evaluateMain!(async (_e, arg: { id: number; url: string }) => {
      (globalThis as any).__peekHybridOverlayTest.publishTopic('page:navigated', {
        windowId: arg.id, url: arg.url,
      });
    }, { id: hostId, url: pageUrl });

    // The overlay has retargeted once its tags panel reports the new URL's state.
    await expect.poll(
      () => app.evaluateMain!(async () =>
        (globalThis as any).__peekHybridOverlayTest.evalInOverlay(
          'document.getElementById("page-keep-btn") ? "present" : "absent"')),
      { timeout: 15000 },
    ).toBe('present');

    const clickKeep = () => app.evaluateMain!(async () =>
      (globalThis as any).__peekHybridOverlayTest.evalInOverlay(
        '(() => { const b = document.getElementById("page-keep-btn"); if (!b) return false; b.click(); return true; })()'));

    expect(await clickKeep()).toBe(true);
    await expect.poll(() => tagsForUrl(pageUrl), { timeout: 15000 }).toContain('kept');

    // The button now reads as active, which is what the second click acts on.
    await expect.poll(
      () => app.evaluateMain!(async () =>
        (globalThis as any).__peekHybridOverlayTest.evalInOverlay(
          'document.getElementById("page-keep-btn").classList.contains("is-active")')),
      { timeout: 15000 },
    ).toBe(true);

    expect(await clickKeep()).toBe(true);
    await expect.poll(
      async () => (await tagsForUrl(pageUrl)) ?? [],
      { timeout: 15000 },
    ).not.toContain('kept');
    expect(await tagsForUrl(pageUrl)).not.toContain('dropped');

    await app.evaluateMain!(async (_e, id: number) => {
      (globalThis as any).__peekHybridOverlayTest.destroyFakeHybridWindow(id);
    }, hostId);
  });
});
