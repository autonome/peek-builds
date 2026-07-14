/**
 * TAG-on-page-host regression (#2, item 8430bd05) — REAL OS FOCUS, opt-in.
 *
 * The bug: on a live page host, `tag <name>` does nothing. Synthetic-focus tests
 * miss it because they never BLUR the host — they only poke the active-hybrid id
 * directly. Under REAL macOS focus the user flow is:
 *
 *   1. a page host is visible (frontmost, OR opened NON-ACTIVATING — session
 *      restore / show:false — so it never fired a content 'focus' event)
 *   2. the command palette opens (Opt+Space) and takes REAL focus, so the
 *      palette is the focused BrowserWindow and the host's active-hybrid id is null
 *   3. `tag #x` runs → resolveFocusedVisibleWindowId(). If the host was never
 *      focus-tracked, the pre-fix resolver returned the focused PALETTE's id →
 *      getActiveWindow() (which excludes internal windows) found nothing → no tag.
 *
 * The fix (izui-roles.ts + tile-ipc.ts): a focused MODAL surface (palette/dialog)
 * is never a command target, and the resolver falls back to the current visible
 * hybrid page host — the page the user is viewing regardless of focus.
 *
 * This runs under NON-HEADLESS real focus (so it grabs your screen — the only way
 * to reproduce the palette blur that headless can't observe). The oracle is DB
 * state (deterministic), NOT human/OS-focus observation. Both cases pass post-fix;
 * the `nonActivating` case fails pre-fix.
 *
 * SKIPS unless PEEK_FOCUS_TAGHOST=1. Gate-excluded (tools/focus-probes/), run on demand:
 *   PEEK_FOCUS_TAGHOST=1 HEADLESS=0 BACKEND=electron PEEK_TEST_WORKERS=1 \
 *     npx playwright test --config tools/focus-probes/playwright.config.ts \
 *     tools/focus-probes/tag-host-repro.spec.ts --workers=1 --headed
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';

test.skip(
  process.env.PEEK_FOCUS_TAGHOST !== '1',
  'opt-in real-focus tag repro — set PEEK_FOCUS_TAGHOST=1 and run non-headless with --workers=1 (it grabs your screen focus)',
);

test.describe('Tag-on-page-host repro @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-host-repro'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // `activating`: host self-activates on open (control — proven to WORK).
  // `nonActivating`: host opens show:false → showInactive → contentFocused:false,
  // so trackHybridWindowFocus NEVER fires (the session-restore / non-activating
  // path). This is the suspected repro: step 1 (tracked==host) is empty, so the
  // resolver falls to step 2 and returns the focused PALETTE id → no tag.
  for (const mode of ['activating', 'nonActivating'] as const) {
  test(`tag on a ${mode} page host under a focused palette`, async () => {
    test.setTimeout(90_000);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const hostUrl = `https://example.com/?taghost=${mode}`;
    const tag = `taghost-${mode}-${Date.now()}`;

    // 1. Open the page host (hybrid). show:false → non-activating (no real focus).
    const host = await bgWindow.evaluate(async (args: { url: string; show: boolean }) => {
      const api = (window as any).app;
      const opts: any = { width: 800, height: 600, key: `taghost-${args.show}` };
      if (!args.show) opts.show = false;
      const res = await api.window.open(args.url, opts);
      return res;
    }, { url: hostUrl, show: mode === 'activating' });
    console.log(`[tag-repro:${mode}] host open ->`, JSON.stringify(host));
    expect((host as any).success).toBe(true);
    await wait(2500); // let it load + settle focus + (maybe) fire trackHybridWindowFocus

    // Capture the URL exactly as the window list (and getActiveWindow) see it.
    const hostInfo = await bgWindow.evaluate(async (id: number) => {
      const api = (window as any).app;
      const list = await api.window.list({ includeInternal: false });
      const w = list.windows.find((x: any) => x.id === id);
      return { url: w?.url, tracked: await api.window.getFocusedVisibleWindowId() };
    }, (host as any).id);
    console.log(`[tag-repro:${mode}] host info ->`, JSON.stringify(hostInfo));
    const targetUrl = (hostInfo.url as string) || hostUrl;

    // 2. Open the REAL command palette exactly as cmd/background.js does — it
    //    takes real focus and BLURS the host (the step synthetic tests skip).
    const palette = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const res = await api.window.open('peek://cmd/panel.html', {
        role: 'palette', key: 'peek://cmd/panel.html',
        height: 60, maxHeight: 400, width: 600,
        keepLive: true, frame: false, transparent: true, alwaysOnTop: true,
        center: true, minWidth: 400, minHeight: 50, hasShadow: true,
        skipTaskbar: true, resizable: false, fullscreenable: false,
        modal: true, type: 'panel',
      });
      return res;
    });
    console.log(`[tag-repro:${mode}] palette open ->`, JSON.stringify(palette));
    await wait(1500); // let the blur + deferred decideAfterBlur() run (nulls step 3)

    // 3. Run `tag #x` — this resolves the active window under the focused palette.
    const result = await bgWindow.evaluate(async (args: { topic: string; search: string }) => {
      const api = (window as any).app;
      return new Promise((resolve) => {
        api.subscribe(args.topic, (r: any) => resolve(r));
        api.publish('cmd:execute:tag', {
          search: args.search, params: [], expectResult: true, resultTopic: args.topic,
        });
        setTimeout(() => resolve({ error: 'timeout' }), 10000);
      });
    }, { topic: `cmd:execute:tag:result:${tag}`, search: `#${tag}` });
    console.log(`[tag-repro:${mode}] tag result ->`, JSON.stringify(result));

    await wait(500);

    // 4. DB oracle: did the FOCUSED host's URL get the tag?
    const dbHasTag = await bgWindow.evaluate(async (args: { url: string; tag: string }) => {
      const api = (window as any).app;
      const found = await api.datastore.findUrlItem(args.url);
      if (!found.success || !found.data) return { found: false };
      const tags = await api.datastore.getItemTags(found.data.id);
      return {
        found: true,
        itemId: found.data.id,
        tags: (tags.data || []).map((t: any) => t.name),
        hasTag: !!tags.success && (tags.data || []).some((t: any) => t.name === args.tag),
      };
    }, { url: targetUrl, tag });
    console.log(`[tag-repro:${mode}] DB oracle ->`, JSON.stringify(dbHasTag));

    // The contract: the tag lands on the host's URL. Pre-fix the nonActivating
    // case FAILS (resolver returns the palette id → getActiveWindow finds nothing).
    expect((dbHasTag as any).hasTag).toBe(true);

    // Clean up so the next mode starts fresh.
    if ((host as any).id != null) {
      await bgWindow.evaluate(async (id: number) => {
        try { await (window as any).app.window.close(id); } catch { /* gone */ }
      }, (host as any).id);
    }
  });
  }
});
