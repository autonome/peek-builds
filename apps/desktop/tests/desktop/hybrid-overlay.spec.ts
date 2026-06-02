import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.4b-1 — singleton hybrid chrome overlay retarget/follow verification.
 *
 * All active-window changes are driven SYNTHETICALLY through the E2E test
 * bridge (`globalThis.__peekHybridOverlayTest`, installed by hybrid-overlay.ts
 * under E2E_TEST + PEEK_PAGEHOST_HYBRID) — never via real OS focus, so this
 * suite cannot steal the user's window focus. We create real (but headless,
 * opacity-0, never-shown) BaseWindow hosts, register them as hybrid windows,
 * then drive the overlay's retarget/follow logic and read the overlay's bounds.
 *
 * Requires the launch env to carry PEEK_PAGEHOST_HYBRID=1; this describe block
 * skips itself if the bridge isn't present (flag off).
 */
test.describe('Hybrid Chrome Overlay (P1.4b-1) @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-overlay'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('retarget is focus-free: overlay frames A, then B, then hides on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const boundsA = { x: 100, y: 120, width: 640, height: 480 };
    const boundsB = { x: 800, y: 200, width: 500, height: 700 };

    const ids = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        a: b.makeFakeHybridWindow((arg as any).boundsA),
        b: b.makeFakeHybridWindow((arg as any).boundsB),
      };
    }, { boundsA, boundsB });

    // Activate A → overlay exists, is shown, framed over A.
    const stateA = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.a });

    expect(stateA).not.toBeNull();
    expect(stateA.visible).toBe(true);
    expect(stateA.bounds).toEqual(boundsA);

    // Activate B → overlay retargets to B's frame.
    const stateB = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.b });

    expect(stateB).not.toBeNull();
    expect(stateB.bounds).toEqual(boundsB);
    expect(stateB.visible).toBe(true);
    // Same overlay window — singleton, not a new one per page.
    expect(stateB.id).toBe(stateA.id);

    // Activate null → overlay hides.
    const stateNull = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
      return b.overlayState();
    });

    expect(stateNull).not.toBeNull();
    expect(stateNull.visible).toBe(false);
  });

  test('follows the active host window move/resize (focus-free)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 50, y: 60, width: 400, height: 300 };
    const moved = { x: 333, y: 222, width: 555, height: 666 };

    const state = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      // Programmatic move+resize fires the host's 'move'/'resize' → overlay follows.
      b.setHostBounds(id, (arg as any).moved);
      return b.overlayState();
    }, { start, moved });

    expect(state).not.toBeNull();
    expect(state.bounds).toEqual(moved);
  });

  test('singleton: exactly one overlay window across many active-changes', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const before = b.browserWindowCount();
      const id1 = b.makeFakeHybridWindow({ x: 10, y: 10, width: 200, height: 200 });
      const id2 = b.makeFakeHybridWindow({ x: 20, y: 20, width: 200, height: 200 });
      const id3 = b.makeFakeHybridWindow({ x: 30, y: 30, width: 200, height: 200 });
      // Flip active many times.
      b.setActive(id1);
      const overlayId1 = b.overlayState()?.id;
      b.setActive(id2);
      const overlayId2 = b.overlayState()?.id;
      b.setActive(id3);
      const overlayId3 = b.overlayState()?.id;
      b.setActive(id1);
      const overlayId4 = b.overlayState()?.id;
      const after = b.browserWindowCount();
      return { before, after, overlayId1, overlayId2, overlayId3, overlayId4 };
    });

    // The overlay id never changes across the flips → one window reused.
    expect(result.overlayId1).toBe(result.overlayId2);
    expect(result.overlayId2).toBe(result.overlayId3);
    expect(result.overlayId3).toBe(result.overlayId4);
    // BrowserWindow count grew by AT MOST one (the overlay) across the whole
    // sequence — the fake hosts are BaseWindows, not BrowserWindows, so they
    // do NOT count. (>= prior test may already have created the overlay, so we
    // assert the delta is 0 or 1, never 2+.)
    expect(result.after - result.before).toBeLessThanOrEqual(1);
  });
});

/**
 * P1.4b-2 — the overlay is now a WORKING shared navbar that reflects and drives
 * the active hybrid content window. All active-window changes are still
 * SYNTHETIC (the E2E bridge), so this suite is focus-free. Navbar/content
 * mediation is asserted by publishing pubsub intents + reading the real content
 * WebContents and the overlay renderer's navbar DOM (executeJavaScript).
 */
test.describe('Hybrid Chrome Overlay working navbar (P1.4b-2) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-navbar'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // Wait until the overlay renderer has loaded + subscribed (window.__overlayReady).
  const waitOverlayReady = async () => {
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? s.ready === true : false;
        }),
      )
      .toBe(true);
  };

  test('active handoff paints navbar for A, swaps to B, clears on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Two real (headless) hybrid windows; load distinct content so url() differs.
    const ids = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const a = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      const bb = b.makeFakeHybridWindow({ x: 700, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(a, 'data:text/html,<title>Alpha</title>A');
      await b.loadFakeContent(bb, 'data:text/html,<title>Beta</title>B');
      return { a, bb };
    });

    // Activate A → renderer ready, navbar painted with A's url.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
    }, { id: ids.a });
    await waitOverlayReady();

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s && !s.noActive ? s.url : null;
        }),
      )
      .toContain('Alpha');

    // Activate B → navbar fully swaps to B's url.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
    }, { id: ids.bb });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? s.url : null;
        }),
      )
      .toContain('Beta');

    // Activate null → navbar clears + body marked no-active.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
    });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? { noActive: s.noActive, url: s.url } : null;
        }),
      )
      .toEqual({ noActive: true, url: '' });
  });

  test('navbar intents drive the active content WebContents (navigate/back/reload)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<title>One</title>page-one');
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();

    // page:navigate → contentWC.loadURL: the content URL actually changes.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:navigate', {
        windowId: (arg as any).id,
        url: 'data:text/html,<title>Two</title>page-two',
      });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl((arg as any).id);
        }, { id }),
      )
      .toContain('page-two');

    // Drive a 3rd nav so there is history, then page:go-back returns to page-two.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:navigate', {
        windowId: (arg as any).id,
        url: 'data:text/html,<title>Three</title>page-three',
      });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl((arg as any).id);
        }, { id }),
      )
      .toContain('page-three');

    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:go-back', { windowId: (arg as any).id });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl((arg as any).id);
        }, { id }),
      )
      .toContain('page-two');

    // page:reload does not throw and the URL stays page-two.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:reload', { windowId: (arg as any).id });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl((arg as any).id);
        }, { id }),
      )
      .toContain('page-two');
  });

  test('content events repaint the active window navbar (nav-state, title)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<title>Init</title>init');
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();

    // Publish page:nav-state for the active window → navbar back/forward + url.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:nav-state', {
        windowId: (arg as any).id,
        url: 'https://example.com/navstate',
        canGoBack: true,
        canGoForward: false,
      });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? { url: s.url, canGoBack: s.canGoBack } : null;
        }),
      )
      .toEqual({ url: 'https://example.com/navstate', canGoBack: true });

    // A nav-state for a DIFFERENT windowId must be ignored (filtering works).
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:nav-state', {
        windowId: (arg as any).id + 99999,
        url: 'https://wrong.example.com/',
        canGoBack: false,
        canGoForward: true,
      });
    }, { id });

    // URL still the active window's, not the foreign one.
    const after = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayChromeState();
      return s ? s.url : null;
    });
    expect(after).toBe('https://example.com/navstate');
  });

  test('overlay is focusable but not focused after a retarget (P1.4b-3)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Make + activate a hybrid window → overlay retargets onto it.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 120, y: 140, width: 600, height: 400 });
      b.setActive(w);
    });
    await waitOverlayReady();

    // The overlay window itself must be focusABLE (so a user click into the URL
    // field can make it key) yet never FOCUSED on appearance (shown via
    // showInactive, nothing proactively focuses it).
    const focusState = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.overlayFocus();
    });
    expect(focusState).not.toBeNull();
    expect(focusState.focusable).toBe(true);
    expect(focusState.focused).toBe(false);
  });

  test('resize intent resizes the content window + overlay reframes (P1.4b-3)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 100, y: 120, width: 500, height: 400 };
    const resized = { x: 100, y: 120, width: 760, height: 560 };

    const result = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      // Renderer would compute these from a resize-handle drag; publish directly.
      b.publishTopic('page:set-bounds', { windowId: id, bounds: (arg as any).resized });
      return {
        id,
        host: b.hostBounds(id),
        overlay: b.overlayState()?.bounds ?? null,
      };
    }, { start, resized });

    // The content BaseWindow took the requested bounds...
    expect(result.host).toEqual(resized);
    // ...and the overlay followed (P1.4b-1 follow on the host 'resize').
    expect(result.overlay).toEqual(resized);
  });

  test('move intent moves the content window + overlay follows (P1.4b-3)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 200, y: 200, width: 480, height: 360 };
    const moved = { x: 640, y: 330, width: 480, height: 360 };

    const result = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      b.publishTopic('page:set-bounds', { windowId: id, bounds: (arg as any).moved });
      return { host: b.hostBounds(id), overlay: b.overlayState()?.bounds ?? null };
    }, { start, moved });

    expect(result.host).toEqual(moved);
    expect(result.overlay).toEqual(moved);
  });

  test('maximize snaps to work area; restore returns to prior bounds (P1.4b-3)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 150, y: 160, width: 520, height: 380 };

    const max = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      b.publishTopic('page:maximize', { windowId: id });
      return { id, host: b.hostBounds(id), workArea: b.hostWorkArea(id) };
    }, { start });

    // Maximize snaps the content window to its display's work area.
    expect(max.host).toEqual(max.workArea);

    const restored = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:unmaximize', { windowId: (arg as any).id });
      return b.hostBounds((arg as any).id);
    }, { id: max.id });

    // Restore returns to the exact pre-maximize bounds.
    expect(restored).toEqual(start);
  });

  test('geometry intents for a non-hybrid windowId are a no-op (P1.4b-3)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // A windowId that is not a registered hybrid window must not throw and must
    // leave any real hybrid window untouched.
    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 300, y: 300, width: 400, height: 300 });
      b.setActive(id);
      const before = b.hostBounds(id);
      // Publish a set-bounds for a bogus windowId → baseWinFor returns null → no-op.
      b.publishTopic('page:set-bounds', {
        windowId: id + 987654,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });
      return { before, after: b.hostBounds(id) };
    });
    expect(result.after).toEqual(result.before);
  });

  test('click-capture toggles overlay window between capture and click-through', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Ensure an overlay exists.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      b.setActive(w);
    });
    await waitOverlayReady();

    // Default after clear/init is click-through (false).
    // Publish capture-on (as the renderer would on pointer-enter over navbar).
    const capturedOn = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishCapture(true);
      return b.captureState();
    });
    expect(capturedOn).toBe(true);

    // Publish capture-off (pointer left chrome → content stays interactive).
    const capturedOff = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishCapture(false);
      return b.captureState();
    });
    expect(capturedOff).toBe(false);
  });
});

/**
 * P1.4b-4 — the small navbar completions: find-in-page + title/favicon display
 * in the shared overlay. Focus-free: synthetic active-change + published intents
 * + content-WC reads (no real OS focus, never visible).
 */
test.describe('Hybrid Chrome Overlay find + title/favicon (P1.4b-4) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-find'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  const waitOverlayReady = async () => {
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? s.ready === true : false;
        }),
      )
      .toBe(true);
  };

  test('page:find-exec routes to the active content WC and finds a match; next advances; stop clears', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // A page with the term "needle" appearing 3 times.
    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(
        w,
        'data:text/html,<body>needle one needle two needle three</body>',
      );
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();

    // Drive find via the SAME pubsub path the overlay find bar uses; assert the
    // content WC reported matches (proves page:find-exec → main → findInPage).
    const found = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.findInContent((arg as any).id, 'needle');
    }, { id });
    expect(found).not.toBeNull();
    expect(found.matches).toBe(3);
    expect(found.activeMatchOrdinal).toBe(1);

    // page:find-next advances the active match ordinal on the same content WC.
    const advanced = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.nextFindAndWait((arg as any).id);
    }, { id });
    expect(advanced).not.toBeNull();
    expect((advanced as any).activeMatchOrdinal).toBe(2);

    // Stop clears the active find (no throw; subsequent state is clean).
    const stopped = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.stopFindInContent((arg as any).id);
      return true;
    }, { id });
    expect(stopped).toBe(true);
  });

  test('Cmd+F forward (page:find) opens the overlay find bar for the active window', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 120, y: 120, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<body>findme findme</body>');
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();

    // The content WC's Cmd+F forward is `page:find {windowId}` → overlay opens bar.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:find', { windowId: (arg as any).id });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? s.findVisible : false;
        }),
      )
      .toBe(true);

    // A find-open for a FOREIGN windowId must not toggle the bar back/off-target.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:find', { windowId: (arg as any).id + 99999 });
    }, { id });
    const stillVisible = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayChromeState();
      return s ? s.findVisible : null;
    });
    expect(stillVisible).toBe(true);
  });

  test('page:title-updated + page:favicon surface in the navbar (foreign windowId ignored)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 140, y: 140, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<title>Init</title>x');
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();

    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:title-updated', {
        windowId: (arg as any).id,
        url: 'https://example.com/page',
        title: 'My Page Title',
      });
      b.publishTopic('page:favicon', {
        windowId: (arg as any).id,
        url: 'https://example.com/page',
        favicon: 'https://example.com/favicon.ico',
      });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? { t: s.pageTitle, f: s.favicon } : null;
        }),
      )
      .toEqual({ t: 'My Page Title', f: 'https://example.com/favicon.ico' });

    // Foreign windowId → ignored (title/favicon unchanged).
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:title-updated', {
        windowId: (arg as any).id + 99999,
        url: 'https://wrong.example.com/',
        title: 'WRONG TITLE',
      });
      b.publishTopic('page:favicon', {
        windowId: (arg as any).id + 99999,
        url: 'https://wrong.example.com/',
        favicon: 'https://wrong.example.com/favicon.ico',
      });
    }, { id });

    const after = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayChromeState();
      return s ? { t: s.pageTitle, f: s.favicon } : null;
    });
    expect(after).toEqual({ t: 'My Page Title', f: 'https://example.com/favicon.ico' });
  });
});
