import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { sleep } from '../helpers/window-utils';

// ============================================================================
// Tag Command — window targeting (regression for the wrong-page tag bug)
// ============================================================================
//
// The bug (fixed in 9039383e): `tag <name>` tagged the URL of whatever window
// sorted LAST by id instead of the page the user was looking at. Root cause was
// the active-window lookup — `tile:window:get-focused-visible-id` discarded a
// tracked hybrid page-host id and returned null, so `getActiveWindow()` in
// features/tags/background.js fell to a "highest window id" last resort (since
// removed) and tagged the wrong window's URL.
//
// Layering — what each test home covers:
//   - The pure resolution logic, INCLUDING the hybrid-tracked-id-wins case that
//     was the actual bug, is unit-tested in main/window-state.test.ts and
//     main/window-kernel.test.ts, which is where the assertions of the deleted
//     `resolveFocusedVisibleWindowId` cascade landed when
//     `window-kernel.ts isContentWindow` over `order` replaced it. Real OS
//     focus for a hybrid BaseWindow is
//     UNOBSERVABLE under macOS-headless, so that pure layer is the only place the
//     hybrid-specific decision can be pinned deterministically.
//   - command-execution.spec.ts drives `cmd:execute:tag` end-to-end, but every
//     assertion there is deliberately TAG-CENTRIC ("getActiveWindow() may return
//     a different window") — it never pins WHICH window's URL got tagged.
//   - THIS spec fills that integration gap for the deterministic slice: with two
//     windows open, the `tag` command must tag the FOCUSED window's URL and leave
//     the co-open window's URL untouched. Headless can reliably drive + observe
//     focus only for the most-recently-focused BrowserWindow (refocusing an older
//     window backward does NOT settle the tracker headless — the same focus-event
//     gap), so the focused window here is always the newest-opened one.

test.describe('Tag Command @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-cmd'));
    await sleep(500); // let the app stabilize before opening windows
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  let tagCallSeq = 0;
  const executeTag = (tag: string, search?: string) =>
    bgWindow.evaluate(async (args: { topic: string; search: string }) => {
      const api = (window as any).app;
      return new Promise((resolve) => {
        api.subscribe(args.topic, (r: any) => resolve(r));
        api.publish('cmd:execute:tag', {
          search: args.search, params: [], expectResult: true, resultTopic: args.topic,
        });
        setTimeout(() => resolve({ error: 'timeout' }), 10000);
      });
    }, { topic: `cmd:execute:tag:result:${tag}:${tagCallSeq++}`, search: search ?? `#${tag}` });

  // Open two distinct windows on the same inert peek page (distinguished only by
  // a query string — both load with no network and no lazy-tile boot behavior,
  // and findUrlItem normalizes the query consistently so they map to distinct
  // items). `other` is opened first; `focused` second so it is the newest, then
  // explicitly focused so the tracker reliably settles on it. Returns the ids,
  // the addresses exactly as getActiveWindow() sees them, and the settled
  // tracker id.
  const openFocusedAndOther = () =>
    bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

      const other = await api.window.open('peek://app/settings/settings.html?tagwin=other', {
        role: 'workspace', width: 600, height: 400, key: 'tagcmd-other',
      });
      if (!other.success) return { stage: 'open other', error: other.error };
      await wait(250);

      const focused = await api.window.open('peek://app/settings/settings.html?tagwin=focused', {
        role: 'workspace', width: 600, height: 400, key: 'tagcmd-focused',
      });
      if (!focused.success) return { stage: 'open focused', error: focused.error };
      await wait(250);

      await api.window.focus(focused.id);
      await wait(250);
      const tracked = await api.window.getFocusedVisibleWindowId();

      const list = await api.window.list({ includeInternal: false });
      const focusedUrl = list.windows.find((w: any) => w.id === focused.id)?.url;
      const otherUrl = list.windows.find((w: any) => w.id === other.id)?.url;

      return {
        focusedId: focused.id, otherId: other.id, tracked, focusedUrl, otherUrl,
      };
    });

  const closeWindows = (focusedId: number, otherId: number) =>
    bgWindow.evaluate(async (ids: { focusedId: number; otherId: number }) => {
      const api = (window as any).app;
      try { await api.window.close(ids.focusedId); } catch { /* closing */ }
      try { await api.window.close(ids.otherId); } catch { /* closing */ }
    }, { focusedId, otherId });

  // Does `url`'s item carry `tag`? Uses the same canonical findUrlItem the
  // command uses, so URL normalization can't desync the check.
  const urlHasTag = (url: string, tag: string) =>
    bgWindow.evaluate(async (args: { url: string; tag: string }) => {
      const api = (window as any).app;
      const found = await api.datastore.findUrlItem(args.url);
      if (!found.success || !found.data) return false;
      const tags = await api.datastore.getItemTags(found.data.id);
      return !!tags.success && (tags.data || []).some((t: any) => t.name === args.tag);
    }, { url, tag });

  test('tags the FOCUSED window URL and leaves a co-open window untouched', async () => {
    const tag = `tagcmd-focus-${Date.now()}`;
    const win = await openFocusedAndOther();
    expect(win.error).toBeUndefined();
    // The tracker settled on the window we focused — precondition for the
    // command to even have a chance of targeting it.
    expect(win.tracked).toBe(win.focusedId);

    const result: any = await executeTag(tag);
    expect(result.success).toBe(true);
    expect(result.added).toContain(tag);

    // The contract that broke: the tag lands on the focused window's URL...
    expect(await urlHasTag(win.focusedUrl!, tag)).toBe(true);
    // ...and NOT on the other open window's URL (guards "tag the first/last/all
    // windows" regressions in getActiveWindow's resolution).
    expect(await urlHasTag(win.otherUrl!, tag)).toBe(false);

    await closeWindows(win.focusedId!, win.otherId!);
  });

  test('no-arg `tag` reflects the FOCUSED window tags, not the co-open window', async () => {
    // Read-side counterpart: after tagging the focused window, `tag` with no
    // args must resolve the SAME active window and return its tags — exercising
    // getActiveWindow on the read path too.
    const tag = `tagcmd-reflect-${Date.now()}`;
    const win = await openFocusedAndOther();
    expect(win.error).toBeUndefined();
    expect(win.tracked).toBe(win.focusedId);

    const added: any = await executeTag(tag);
    expect(added.success).toBe(true);

    const shown: any = await executeTag(tag, ''); // no search → list current tags
    expect(shown.success).toBe(true);
    expect(Array.isArray(shown.tags)).toBe(true);
    expect(shown.tags.map((t: any) => t.name)).toContain(tag);

    await closeWindows(win.focusedId!, win.otherId!);
  });
});
