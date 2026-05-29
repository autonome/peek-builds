import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, waitForPanelCommandsLoaded } from '../helpers/window-utils';

// ============================================================================
// Enter-runs-inline-suggestion preference (@desktop)
//
// Pref `enterRunsInlineSuggestion` (default true): pressing Enter runs the
// inline-suggested command when the typed text is a genuine PREFIX completion
// of the selected command — even though the user only typed a prefix.
//
// SAFETY: this must NEVER fire for substring/fuzzy matches. findMatchingCommands
// matches by substring (indexOf !== -1), so state.matches[0] may be a fuzzy
// match the user never intended. The panel guard only auto-runs when
// nameLower.startsWith(typedLower). These tests assert both halves.
//
// Target command: `datastore` — a core, NO-PARAM command (registered in
// renderer/index.js) that opens peek://app/datastore/viewer.html. Clean
// prefix target (no `://`), longer than a typeable prefix, observable via the
// window:opened pubsub event (same pattern as external-url.spec.ts).
// ============================================================================

const PANEL_OPEN_OPTS = {
  modal: true,
  width: 600,
  height: 50,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  center: true,
};

const VIEWER_MATCH = 'datastore/viewer.html';

test.describe('Cmd Enter runs inline suggestion @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-enter-suggestion'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // Open the panel and wait for input + commands loaded. Also assert that the
  // `datastore` command is actually registered and has no params, so the test
  // fails loudly if the command surface changes rather than silently passing.
  async function openPanel(): Promise<{ cmdWindow: Page; panelId: number }> {
    await waitForExtensionsReady(bgWindow, 15000);
    const openResult = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('peek://cmd/panel.html', opts);
    }, PANEL_OPEN_OPTS);
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);

    // Wait until the datastore command is registered.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return s && s.commands && s.commands['datastore'];
      },
      undefined,
      { timeout: 10000 }
    );

    const datastoreInfo = await cmdWindow.evaluate(() => {
      const cmd = (window as any)._cmdState.commands['datastore'];
      return { exists: !!cmd, params: (cmd?.params || []).length };
    });
    expect(datastoreInfo.exists).toBe(true);
    // The auto-run-on-prefix path only EXECUTEs for no-param commands; if
    // datastore ever grows params this test's premise is invalid.
    expect(datastoreInfo.params).toBe(0);

    return { cmdWindow, panelId: openResult.id };
  }

  async function closePanel(panelId: number) {
    if (!panelId) return;
    try {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, panelId);
    } catch {
      // Panel may have already closed via shutdown() after executing a command.
    }
  }

  // Subscribe (on the bg window) to window:opened for the datastore viewer.
  // Mirrors external-url.spec.ts: subscribe BEFORE the trigger to avoid a race.
  async function armViewerWatch() {
    await bgWindow.evaluate((match: string) => {
      (window as any).__datastoreViewerOpened = null;
      (window as any).__datastoreViewerUnsub = (window as any).app.subscribe(
        'window:opened',
        (msg: any) => {
          if (msg?.url && msg.url.includes(match)) {
            (window as any).__datastoreViewerOpened = msg;
          }
        }
      );
    }, VIEWER_MATCH);
  }

  async function disarmViewerWatch() {
    await bgWindow.evaluate(() => {
      if ((window as any).__datastoreViewerUnsub) (window as any).__datastoreViewerUnsub();
      delete (window as any).__datastoreViewerUnsub;
      delete (window as any).__datastoreViewerOpened;
    });
  }

  async function closeAnyViewerWindows() {
    const list = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const viewers = (list.windows || []).filter(
      (w: any) => w.url && w.url.includes(VIEWER_MATCH)
    );
    for (const w of viewers) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, w.id);
    }
  }

  test('Enter runs the suggested no-param command from a strict prefix (pref on, default)', async () => {
    await armViewerWatch();
    const { cmdWindow, panelId } = await openPanel();

    // Type a STRICT prefix of "datastore" (not the full name).
    await cmdWindow.fill('input', 'datast');

    // Deterministically wait until the inline suggestion (selected match) is
    // `datastore` and it is a genuine prefix completion of what we typed.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        const sel = s?.matches?.[s.matchIndex];
        return sel === 'datastore' && 'datastore'.startsWith('datast') && 'datastore' !== 'datast';
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.keyboard.press('Enter');

    // The datastore viewer window should open — Enter ran the suggestion even
    // though only a prefix was typed.
    await bgWindow.waitForFunction(
      () => (window as any).__datastoreViewerOpened !== null,
      undefined,
      { timeout: 10000 }
    );

    await disarmViewerWatch();
    await closeAnyViewerWindows();
    await closePanel(panelId);
  });

  test('Enter does NOT run a substring (non-prefix) fuzzy match (safety)', async () => {
    await armViewerWatch();
    const { cmdWindow, panelId } = await openPanel();

    // "atastore" is a SUBSTRING of "datastore" but NOT a prefix
    // ("datastore".includes("atastore") === true; startsWith === false).
    // findMatchingCommands will surface datastore as a fuzzy match, but the
    // guard must refuse to auto-run it.
    await cmdWindow.fill('input', 'atastore');

    // Confirm the selected suggestion is indeed a substring-but-not-prefix
    // match — i.e. exactly the dangerous case the guard protects against.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        const sel = s?.matches?.[s.matchIndex];
        if (!sel) return false;
        const selLower = sel.toLowerCase();
        const typed = 'atastore';
        return selLower.includes(typed) && !selLower.startsWith(typed);
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.keyboard.press('Enter');

    // Deterministic fence (no sleep): type a benign key after Enter. Key events
    // process in order, so once 'x' is reflected in panel state the Enter has
    // already been fully handled. If Enter had wrongly executed the command, the
    // panel would have shut down and this wait would time out — failing loudly.
    await cmdWindow.keyboard.type('x');
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return typeof s?.typed === 'string' && s.typed.endsWith('x');
      },
      undefined,
      { timeout: 5000 }
    );

    const opened = await bgWindow.evaluate(() => (window as any).__datastoreViewerOpened);
    expect(opened).toBeNull();

    // Also assert no datastore viewer window exists in the window list.
    const list = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const viewer = (list.windows || []).find(
      (w: any) => w.url && w.url.includes(VIEWER_MATCH)
    );
    expect(viewer).toBeFalsy();

    await disarmViewerWatch();
    await closePanel(panelId);
  });

  test('Pref off: Enter does NOT run the suggestion from a strict prefix', async () => {
    // The panel's `prefs` settings are stored under the cmd extension's own
    // tile scope, so we can't flip the stored value from the bg (core) window.
    // But the panel ALSO subscribes to the `settings:changed` pubsub and
    // updates its cached `enterRunsInlineSuggestion` directly from the payload.
    // Publishing that event from inside the panel's own context drives the
    // exact same code path the settings UI uses, deterministically.
    await armViewerWatch();
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('settings:changed', { prefs: { enterRunsInlineSuggestion: false } });
    });

    await cmdWindow.fill('input', 'datast');
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return s?.matches?.[s.matchIndex] === 'datastore';
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.keyboard.press('Enter');

    // Deterministic fence (no sleep): type a benign key after Enter. Key events
    // process in order, so once 'x' is reflected in panel state the Enter has
    // already been fully handled. If Enter had wrongly executed the command, the
    // panel would have shut down and this wait would time out — failing loudly.
    await cmdWindow.keyboard.type('x');
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return typeof s?.typed === 'string' && s.typed.endsWith('x');
      },
      undefined,
      { timeout: 5000 }
    );

    const opened = await bgWindow.evaluate(() => (window as any).__datastoreViewerOpened);
    expect(opened).toBeNull();

    await disarmViewerWatch();
    await closeAnyViewerWindows();
    await closePanel(panelId);
  });
});
