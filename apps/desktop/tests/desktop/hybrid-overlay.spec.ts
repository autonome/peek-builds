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

    const setup = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        a: b.makeFakeHybridWindow((arg as any).boundsA),
        b: b.makeFakeHybridWindow((arg as any).boundsB),
        // Expected EXPANDED overlay frames: content rect + canvas gutters, so the
        // chrome has gutter to render in around the content (the gutter fix).
        frameA: b.expectedOverlayFrame((arg as any).boundsA),
        frameB: b.expectedOverlayFrame((arg as any).boundsB),
        gutters: b.overlayGutters(),
      };
    }, { boundsA, boundsB });
    const ids = { a: setup.a, b: setup.b };

    // There IS a gutter (overlay frame strictly larger than the content rect).
    expect(setup.frameA.width).toBeGreaterThan(boundsA.width);
    expect(setup.frameA.height).toBeGreaterThan(boundsA.height);
    expect(setup.gutters.left).toBeGreaterThan(0);
    expect(setup.gutters.top).toBeGreaterThan(0);

    // Activate A → overlay exists, is shown, framed over A EXPANDED by the gutters.
    const stateA = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.a });

    expect(stateA).not.toBeNull();
    expect(stateA.visible).toBe(true);
    // Overlay = content rect + canvas gutters (NOT the bare content rect): the
    // content window stays at boundsA, the overlay extends into the gutter.
    expect(stateA.bounds).toEqual(setup.frameA);

    // Activate B → overlay retargets to B's expanded frame.
    const stateB = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.b });

    expect(stateB).not.toBeNull();
    expect(stateB.bounds).toEqual(setup.frameB);
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

    const result = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      // Programmatic move+resize fires the host's 'move'/'resize' → overlay follows.
      b.setHostBounds(id, (arg as any).moved);
      return {
        host: b.hostBounds(id),
        overlay: b.overlayState()?.bounds ?? null,
        frame: b.expectedOverlayFrame((arg as any).moved),
      };
    }, { start, moved });

    expect(result.overlay).not.toBeNull();
    // Content window is at the moved rect; overlay follows it EXPANDED by gutters.
    expect(result.host).toEqual(moved);
    expect(result.overlay).toEqual(result.frame);
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
        frame: b.expectedOverlayFrame((arg as any).resized),
      };
    }, { start, resized });

    // The content BaseWindow took the requested CONTENT bounds...
    expect(result.host).toEqual(resized);
    // ...and the overlay followed, framed at the content rect + gutters.
    expect(result.overlay).toEqual(result.frame);
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
      return {
        host: b.hostBounds(id),
        overlay: b.overlayState()?.bounds ?? null,
        frame: b.expectedOverlayFrame((arg as any).moved),
      };
    }, { start, moved });

    expect(result.host).toEqual(moved);
    expect(result.overlay).toEqual(result.frame);
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

/**
 * P1.4b-5 — side panels (page-info / tags / entities / extensions) ported to the
 * shared overlay. Focus-free: synthetic active-change + published intents +
 * overlayPanelState() DOM reads (no real OS focus, never visible). The panels are
 * one renderer serving N windows by retargeting, so each test asserts the panel
 * shows the ACTIVE window's data, fully SWAPS on retarget, and CLEARS on null.
 */
test.describe('Hybrid Chrome Overlay side panels (P1.4b-5) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-panels'));
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

  // Make a hybrid window + activate it, WAIT for the overlay renderer to be ready
  // (its page:navigated subscription must be live — the overlay is created lazily
  // on the first setActive in this describe, and a page:navigated published before
  // the renderer subscribes is dropped, leaving the URL-keyed panels un-keyed),
  // THEN set the active URL via a synthetic page:navigated (the panels key on
  // http(s) URLs, which a data: fake can't carry). Returns the window id.
  const makeActiveWithUrl = async (url: string) => {
    const w = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 100, y: 100, width: 700, height: 500 });
      await b.loadFakeContent(id, 'data:text/html,<title>x</title>x');
      b.setActive(id);
      return id;
    });
    await waitOverlayReady();
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:navigated', { windowId: (arg as any).w, url: (arg as any).url });
    }, { w, url });
    return w;
  };

  test('page-info renders the active window data, swaps on retarget, clears on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveWithUrl('https://alpha.example.com/page');
    await waitOverlayReady();

    // Drive the page-info reply on the SAME active-filtered topic main publishes
    // after extracting the content WC's meta tags. (The extract→exec routing is
    // identical to the already-tested OpenSearch exec; here we verify the overlay
    // renders + active-keys the result.)
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:page-info', {
        windowId: (arg as any).id,
        url: 'https://alpha.example.com/page',
        info: { title: 'Alpha Title', hostname: 'alpha.example.com', description: 'Alpha desc' },
      });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s && s.pageInfo ? { hasData: s.pageInfo.hasData, text: s.pageInfo.text } : null;
        }),
      )
      .toEqual(
        expect.objectContaining({
          hasData: true,
        }),
      );

    const txtA = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayPanelState();
      return s?.pageInfo?.text ?? '';
    });
    expect(txtA).toContain('Alpha Title');
    expect(txtA).toContain('alpha.example.com');

    // Retarget to a SECOND window with different data → panel fully swaps and the
    // first window's data is gone.
    const id2 = await makeActiveWithUrl('https://beta.example.com/other');
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:page-info', {
        windowId: (arg as any).id2,
        url: 'https://beta.example.com/other',
        info: { title: 'Beta Title', hostname: 'beta.example.com' },
      });
    }, { id2 });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s?.pageInfo?.text ?? '';
        }),
      )
      .toContain('Beta Title');

    const txtB = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayPanelState();
      return s?.pageInfo?.text ?? '';
    });
    expect(txtB).not.toContain('Alpha Title');

    // A page-info for a FOREIGN windowId must be ignored.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:page-info', {
        windowId: (arg as any).id2 + 99999,
        url: 'https://wrong.example.com/',
        info: { title: 'WRONG TITLE', hostname: 'wrong.example.com' },
      });
    }, { id2 });
    const txtAfterForeign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayPanelState();
      return s?.pageInfo?.text ?? '';
    });
    expect(txtAfterForeign).not.toContain('WRONG TITLE');
    expect(txtAfterForeign).toContain('Beta Title');

    // Active → null clears the panel (no-active, panel loses has-data).
    await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
    });
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s ? { noActive: s.noActive, hasData: s.pageInfo?.hasData } : null;
        }),
      )
      .toEqual({ noActive: true, hasData: false });
  });

  test('entities panel renders active-URL entities and swaps on retarget', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveWithUrl('https://ent-a.example.com/x');
    await waitOverlayReady();

    // Publish an entities response on the SAME topic the entities feature uses,
    // keyed on the active URL → the panel renders it.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishEntities('https://ent-a.example.com/x', [
        { content: 'Ada Lovelace', metadata: JSON.stringify({ entityType: 'person' }) },
      ]);
    });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s?.entities?.text ?? '';
        }),
      )
      .toContain('Ada Lovelace');

    // An entities response for a NON-active URL must be ignored.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishEntities('https://some-other.example.com/y', [
        { content: 'Wrong Person', metadata: JSON.stringify({ entityType: 'person' }) },
      ]);
    });
    const afterForeign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayPanelState();
      return s?.entities?.text ?? '';
    });
    expect(afterForeign).not.toContain('Wrong Person');
    expect(afterForeign).toContain('Ada Lovelace');

    // Retarget → entities clears (new window has no entities until its own
    // response arrives).
    await makeActiveWithUrl('https://ent-b.example.com/z');
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s?.entities?.text ?? '';
        }),
      )
      .not.toContain('Ada Lovelace');
  });

  test('tags + extensions panels gain has-data for an active http window, clear on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    await makeActiveWithUrl('https://tagsite.example.com/p');
    await waitOverlayReady();

    // Tags panel always offers its add-tag input → has-data once an active URL is
    // set. Extensions loads via api.chromeExtensions/api.adblocker → has-data once
    // the (possibly-empty) list resolves.
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s ? { tags: s.tags?.hasData, ext: s.extensions?.hasData } : null;
        }),
      )
      .toEqual({ tags: true, ext: true });

    // Active → null clears both.
    await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
    });
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayPanelState();
          return s ? { tags: s.tags?.hasData, ext: s.extensions?.hasData } : null;
        }),
      )
      .toEqual({ tags: false, ext: false });
  });

  test('panels become visible with the chrome and are in the click-capture set', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveWithUrl('https://vis.example.com/p');
    await waitOverlayReady();
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:page-info', {
        windowId: (arg as any).id,
        url: 'https://vis.example.com/p',
        info: { title: 'Vis', hostname: 'vis.example.com' },
      });
    }, { id });

    // Reveal chrome (synthetic trigger-zone hover) → panels-visible flips on.
    const visible = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.revealOverlayChrome();
    });
    expect(visible).toBe(true);

    // Every panel carries the .interactive class — the exact class the overlay's
    // click-capture loop binds pointer enter/leave on — so an open panel is in
    // the capture set (overlay turns opaque to the pointer over it). The capture
    // toggle itself is exercised by the dedicated click-capture test.
    const interactive = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.overlayPanelsInteractive();
    });
    expect(interactive).toBe(true);
  });
});

/**
 * P1.4b-6 — the NOTES panel + page WIDGETS ported to the shared overlay,
 * COMPLETING overlay parity. Focus-free: synthetic active-change + published
 * intents + overlayNotesWidgetState() DOM reads (no real OS focus, never visible).
 * The notes pane is URL-keyed (datastore), so it loads/swaps/clears with the
 * active window; the OpenSearch widget is gated to the ACTIVE windowId via main's
 * per-window page:search-engine-discovered (P1.3, now windowId-tagged).
 */
test.describe('Hybrid Chrome Overlay notes + widgets (P1.4b-6) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-notes-widgets'));
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

  // Make a hybrid window + activate it, WAIT for the overlay renderer to be ready
  // (so its page:navigated subscription is live — the overlay is created lazily on
  // the first setActive in this describe, and a page:navigated published before the
  // renderer subscribes is dropped), THEN set the active http URL via a synthetic
  // page:navigated. Returns the window id.
  const makeActiveWithUrl = async (url: string) => {
    const w = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 100, y: 100, width: 700, height: 500 });
      await b.loadFakeContent(id, 'data:text/html,<title>x</title>x');
      b.setActive(id);
      return id;
    });
    await waitOverlayReady();
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:navigated', { windowId: (arg as any).w, url: (arg as any).url });
    }, { w, url });
    return w;
  };

  test('notes pane loads for the active URL, swaps on retarget, clears on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Seed a note in the datastore anchored to alpha, via the overlay's own
    // api.datastore (the same path PageNotesPane reads). The note is a 'text' item
    // tagged 'annotation' with metadata.anchor.url.
    const id = await makeActiveWithUrl('https://notes-alpha.example.com/p');
    await waitOverlayReady();

    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      await b.seedNote('https://notes-alpha.example.com/p', 'Alpha note body');
    });

    // The pane (URL-keyed) should pick up the alpha note for the active window.
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayNotesWidgetState();
          return s?.notes ? { hasData: s.notes.hasData, text: s.notes.text } : null;
        }),
      )
      .toEqual(
        expect.objectContaining({ hasData: true }),
      );

    const alphaText = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayNotesWidgetState();
      return s?.notes?.text ?? '';
    });
    expect(alphaText).toContain('Alpha note body');

    // The notes panel is in the click-capture set.
    const notesInteractive = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayNotesWidgetState();
      return s?.notes?.interactive ?? false;
    });
    expect(notesInteractive).toBe(true);

    // Retarget to a SECOND window with its own (different) note → pane swaps.
    await makeActiveWithUrl('https://notes-beta.example.com/q');
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      await b.seedNote('https://notes-beta.example.com/q', 'Beta note body');
    });
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayNotesWidgetState();
          return s?.notes?.text ?? '';
        }),
      )
      .toContain('Beta note body');

    const betaText = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayNotesWidgetState();
      return s?.notes?.text ?? '';
    });
    expect(betaText).not.toContain('Alpha note body');

    // Active → null clears the notes pane (no-active + loses has-data).
    await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
    });
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayNotesWidgetState();
          return s ? { noActive: s.noActive, hasData: s.notes?.hasData } : null;
        }),
      )
      .toEqual({ noActive: true, hasData: false });
  });

  test('OpenSearch widget appears for active windowId, foreign ignored, clears on retarget', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveWithUrl('https://search.example.com/home');
    await waitOverlayReady();

    // FOREIGN-window discovery must NOT arm the widget: a websearch:engine-discovered
    // that follows it is ignored (no card rendered).
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:search-engine-discovered', {
        windowId: (arg as any).id + 99999,
        pageUrl: 'https://wrong.example.com/',
        opensearchUrl: 'https://wrong.example.com/osd.xml',
      });
      b.publishWebsearchEngine({ id: 'wrong-engine', name: 'Wrong Engine' });
    }, { id });

    // Give the (ignored) path a beat; the container must stay empty.
    const afterForeign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayNotesWidgetState();
      return s?.widgets ? { count: s.widgets.count, text: s.widgets.text } : null;
    });
    expect(afterForeign?.text ?? '').not.toContain('Wrong Engine');

    // ACTIVE-window discovery arms the widget; the subsequent confirm renders a card.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:search-engine-discovered', {
        windowId: (arg as any).id,
        pageUrl: 'https://search.example.com/home',
        opensearchUrl: 'https://search.example.com/osd.xml',
      });
      b.publishWebsearchEngine({ id: 'good-engine', name: 'Acme Search' });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayNotesWidgetState();
          return s?.widgets ? { hasData: s.widgets.hasData, text: s.widgets.text, interactive: s.widgets.interactive } : null;
        }),
      )
      .toEqual(
        expect.objectContaining({ hasData: true, interactive: true }),
      );

    const widgetText = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayNotesWidgetState();
      return s?.widgets?.text ?? '';
    });
    expect(widgetText).toContain('Acme Search');

    // Retarget → the widget container is CLEARED (the card belonged to the prior
    // window). New active window starts with an empty container.
    await makeActiveWithUrl('https://other.example.com/x');
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayNotesWidgetState();
          return s?.widgets ? { count: s.widgets.count, hasData: s.widgets.hasData } : null;
        }),
      )
      .toEqual({ count: 0, hasData: false });
  });

  test('gutter fix: widgets render in the right gutter (outside content) and STACK', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveWithUrl('https://gutter.example.com/p');
    await waitOverlayReady();

    // Add ≥2 widgets, reveal the chrome, read their overlay-local geometry.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      await b.addTestWidgets(3);
    });

    const layout = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      // reveal + read (rAF-coalesced relayout settles within a couple frames)
      await b.overlayGutterLayout();
      await new Promise((r) => setTimeout(r, 60));
      return b.overlayGutterLayout();
    });

    expect(layout).not.toBeNull();
    expect(layout.content).not.toBeNull();
    expect(layout.widgets.length).toBeGreaterThanOrEqual(3);

    // 1) IN THE GUTTER, not buried under content: each widget's left edge is at or
    //    past the right-stack anchor (content.right - overlap), i.e. the bulk of
    //    the card sits in the right gutter beyond the content's right edge — NOT
    //    inside the content window border (the reported "widgets inside content"
    //    bug). The right-stack anchor = content.right - PANEL_OVERLAP(70).
    const rightAnchor = layout.content.right - 70;
    for (const wgt of layout.widgets) {
      expect(wgt.left).toBeGreaterThanOrEqual(rightAnchor - 1);
      // And the card extends into the gutter past the content's right edge.
      expect(wgt.right).toBeGreaterThan(layout.content.right);
    }

    // 2) STACKED, not piled: tops are strictly increasing (each below the prior),
    //    and no two cards share a top — the reported "all stacked at the top,
    //    covering each other" bug.
    const tops = layout.widgets.map((w: any) => w.top).sort((a: number, b: number) => a - b);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
    const uniqueTops = new Set(tops);
    expect(uniqueTops.size).toBe(tops.length);
  });
});

/**
 * Focus-group fix — interacting with the chrome (a SEPARATE focusable overlay
 * window) must NOT deactivate the content window. The prior P1.4b tests drove
 * active-changes synthetically (setActive), bypassing real focus — which is
 * exactly why the "click the navbar → overlay instantly closes" bug slipped
 * through. These tests drive the REAL `'focus'`/`'blur'` event SEQUENCE the OS
 * produces (old window blur BEFORE new window focus) against simulated focus
 * state, exercising the registry's deferred blur decision. Focus-free: headless
 * BaseWindows never take OS focus; the bridge simulates `isFocused()` +
 * overlay-focus deterministically.
 */
test.describe('Hybrid Chrome Overlay focus-group @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-focus-group'));
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

  test('clicking the chrome (overlay focus on content blur) does NOT deactivate', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Content A focused → active = A, overlay shown over A.
    const setup = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const a = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      b.focusHost(a); // real 'focus' event → active = A, overlay retargets
      b.installFocusGroupSim(); // overlay-focus provider reads simulated state
      return { a, active: b.activeId(), overlay: b.overlayState() };
    });
    await waitOverlayReady();
    expect(setup.active).toBe(setup.a);
    expect(setup.overlay).not.toBeNull();
    expect(setup.overlay.visible).toBe(true);

    // THE BUG SEQUENCE: user clicks the navbar → content A blurs, then the
    // overlay focuses. Drive that exact order, then run the deferred decision.
    const afterClick = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.blurHost((arg as any).a); // content A 'blur' → schedules deferred decision
      b.focusOverlay(); // focus lands on the overlay (intra-group)
      const active = b.runDeferredBlur((arg as any).a); // run the deferred decision now
      return { active, overlay: b.overlayState() };
    }, { a: setup.a });

    // Active STAYS A; overlay NOT hidden/cleared.
    expect(afterClick.active).toBe(setup.a);
    expect(afterClick.overlay).not.toBeNull();
    expect(afterClick.overlay.visible).toBe(true);

    // Overlay blurs, content A re-focuses → still active = A.
    const back = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.blurOverlay();
      b.focusHost((arg as any).a);
      return b.activeId();
    }, { a: setup.a });
    expect(back).toBe(setup.a);

    // Focus leaves the whole group (neither overlay nor any hybrid) → null, hide.
    const left = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.blurHost((arg as any).a);
      b.focusElsewhere();
      const active = b.runDeferredBlur((arg as any).a);
      return { active, overlay: b.overlayState() };
    }, { a: setup.a });
    expect(left.active).toBeNull();
    expect(left.overlay).not.toBeNull();
    expect(left.overlay.visible).toBe(false);
  });

  test('real switch between two hybrid windows still retargets (A → B)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const a = b.makeFakeHybridWindow({ x: 100, y: 100, width: 500, height: 400 });
      const bb = b.makeFakeHybridWindow({ x: 700, y: 100, width: 500, height: 400 });
      b.installFocusGroupSim();
      b.focusHost(a);
      const afterA = { active: b.activeId(), overlay: b.overlayState()?.bounds ?? null };
      // Switch to B: A blurs first, then B focuses (B's own focus handler sets
      // active=B and cancels A's pending deferred decision).
      b.blurHost(a);
      b.focusHost(bb);
      const afterFocusB = b.activeId();
      // Even if the deferred decision for A runs late, active stays B.
      const afterDefer = b.runDeferredBlur(a);
      return {
        a,
        bb,
        afterA,
        afterFocusB,
        afterDefer,
        overlayB: b.overlayState()?.bounds ?? null,
        frameB: b.expectedOverlayFrame({ x: 700, y: 100, width: 500, height: 400 }),
      };
    });

    expect(result.afterA.active).toBe(result.a);
    expect(result.afterFocusB).toBe(result.bb);
    expect(result.afterDefer).toBe(result.bb);
    // Overlay retargeted onto B (B's content rect + gutters, distinct from A).
    expect(result.overlayB).toEqual(result.frameB);
  });

  test('back/forward unblocked: nav drives the active content WC held through an overlay interaction', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<title>One</title>page-one');
      b.installFocusGroupSim();
      b.focusHost(w);
      return w;
    });
    await waitOverlayReady();

    // Simulate the user interacting with the chrome (content blur → overlay
    // focus) — active MUST remain the content window so navbar actions work.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.blurHost((arg as any).id);
      b.focusOverlay();
      b.runDeferredBlur((arg as any).id);
    }, { id });

    // activeId still the content window (not nulled by the interaction).
    const heldActive = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return { active: b.activeId(), target: (arg as any).id };
    }, { id });
    expect(heldActive.active).toBe(heldActive.target);

    // Build history: navigate twice.
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

    // page:go-back drives the (still-active) content WC back to page-two.
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

    // page:go-forward returns to page-three.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:go-forward', { windowId: (arg as any).id });
    }, { id });
    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl((arg as any).id);
        }, { id }),
      )
      .toContain('page-three');
  });
});

/**
 * Navbar reveal — Cmd+L forwarding + reliable trigger-zone hover.
 *
 * Reproduces the canvas reveal behavior on the hybrid path:
 *  1. Cmd+L on the content WC is forwarded by main (wireHybridContentEvents'
 *     before-input-event) as `page:show-navbar {windowId}`; the overlay reveals
 *     the navbar AND focuses the URL field. A foreign windowId is ignored.
 *  2. Trigger-zone hover reliably reveals the navbar — driven through the
 *     RELIABLY-forwarded `mousemove` path (the flaky-hover fix), not the
 *     boundary-crossing `mouseenter` that misses on a click-through window — and
 *     a move from the trigger zone INTO the navbar does NOT collapse the chrome
 *     (no flicker); a move off all chrome schedules the hide.
 *
 * Focus-free: synthetic active-change + published topic (Cmd+L) and dispatched
 * `mousemove` (trigger zone), DOM reads via the bridge. No real OS focus.
 */
test.describe('Hybrid Chrome Overlay navbar reveal @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-navbar-reveal'));
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

  const makeActive = async (url: string) => {
    const id = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 140, y: 140, width: 700, height: 460 });
      await b.loadFakeContent(w, (arg as any).url);
      b.setActive(w);
      return w;
    }, { url });
    await waitOverlayReady();
    return id;
  };

  test('Cmd+L (page:show-navbar) reveals the navbar AND focuses the URL field; foreign windowId ignored', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActive('data:text/html,<body>cmd-l target</body>');

    // The content WC's Cmd+L forward is `page:show-navbar {windowId}`.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:show-navbar', { windowId: (arg as any).id });
    }, { id });

    // Navbar becomes visible AND the URL input takes shadow-DOM focus (focusUrl()
    // is rAF-deferred, so poll). This is what makes Cmd+L typeable end-to-end.
    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? { vis: s.navbarVisible, focused: s.navbarInputFocused } : null;
        }),
      )
      .toEqual({ vis: true, focused: true });

    // A Cmd+L forward for a FOREIGN windowId must be ignored (overlay gates on the
    // active window) — the navbar stays as it was, no off-target re-reveal/refocus.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:show-navbar', { windowId: (arg as any).id + 99999 });
    }, { id });
    const afterForeign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayChromeState();
      return s ? { vis: s.navbarVisible, focused: s.navbarInputFocused } : null;
    });
    expect(afterForeign).toEqual({ vis: true, focused: true });
  });

  test('trigger-zone hover reliably reveals the navbar via the forwarded mousemove path', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    await makeActive('data:text/html,<body>hover target</body>');

    // The reliable-reveal path: a `mousemove` landing in the trigger-zone band
    // (the click-through window's forwarded move stream) reveals the navbar.
    // Repeat to prove it is RELIABLE — every entry reveals, not "sometimes".
    for (let i = 0; i < 5; i++) {
      // Move off chrome first (so each iteration starts hidden), then into the zone.
      await app.evaluateMain!(async () => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.moveOffChromeSchedulesHide();
      });
      const revealed = await app.evaluateMain!(async () => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.moveOverTriggerZone();
      });
      expect(revealed).toBe(true);
    }
  });

  test('trigger-zone → navbar move keeps the chrome open (no flicker); move off schedules hide', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    await makeActive('data:text/html,<body>flicker target</body>');

    // Enter the trigger zone → navbar revealed.
    const revealed = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.moveOverTriggerZone();
    });
    expect(revealed).toBe(true);

    // Move from the trigger zone INTO the navbar — the contiguous hit-test spans
    // both regions, so the chrome must STAY open (no trigger-zone↔navbar flicker).
    const stillOpen = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.moveOverNavbar();
    });
    expect(stillOpen).toBe(true);

    // Move off all chrome (center of content) → a hide is SCHEDULED (timer-deferred
    // 400ms grace, same as the canvas), proving the move-out path fires.
    const hidePending = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.moveOffChromeSchedulesHide();
    });
    expect(hidePending).toBe(true);
  });
});

/**
 * Top-border GESTURE reveal — the last hybrid dead-focus cluster item (peek
 * 363e7cff). Distinct from the trigger-zone test above (which dispatches a DOM
 * `mousemove` DIRECTLY on the overlay's document and so always works): this
 * drives the REAL content→overlay path that the maximized / no-gutter case
 * depends on.
 *
 * Root cause: when the content `WebContentsView` is the macOS first responder
 * AND fills the overlay frame (maximized / no-gutter — overlay frame == content
 * rect, so the trigger strip sits directly over the content WC), the content WC
 * CAPTURES the idle (no-button) `mousemove` the overlay's click-through
 * forwarded-move reveal loop needs. The loop is starved → hovering the top
 * border never reveals the navbar. Before the fix, `wireHybridContentEvents`
 * forwarded content moves ONLY while a button was held (for hold-to-drag), so an
 * idle top-border hover produced NO signal at all → the overlay could never
 * reveal there.
 *
 * Fix: main forwards idle top-band moves as `page-overlay:content-pointer
 * {phase:'reveal'}` (it owns the host geometry, so the band check works
 * edge-to-edge incl. maximized); the overlay's content-pointer subscriber turns
 * that into the same showNavbar() the trigger-zone hover uses.
 *
 * FAILING-FIRST: before the fix, `emitContentTopEdgeHover` drives a real idle
 * top-edge `input-event` on the content WC, but no `reveal` is forwarded, so the
 * navbar never becomes visible — this test's `toBe(true)` assertion fails.
 *
 * Focus-free: real `input-event` emit on the content WC, DOM read via the
 * bridge, synthetic active-change. No real OS focus/pointer.
 */
test.describe('Hybrid Chrome Overlay top-border gesture reveal (363e7cff) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-topborder-reveal'));
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

  const navbarVisible = async () =>
    app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = await b.overlayChromeState();
      return s ? s.navbarVisible : null;
    });

  // The describe shares ONE app (beforeAll), and a reveal leaves the navbar
  // visible — setting a NEW active window does not auto-hide it. Reset to hidden
  // deterministically (immediate, no 400ms grace) so each test starts clean.
  const resetHidden = async () => {
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hideOverlayChrome();
    });
    expect(await navbarVisible()).toBe(false);
  };

  // The maximized / no-gutter case is the WORST one (overlay frame == content
  // rect, so the trigger strip sits directly over the content WC). We frame the
  // host onto the display work area so expandToOverlayFrame takes its maximized
  // branch (overlay == work area, no gutter).
  const makeActiveMaximized = async () => {
    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      // Make a WIRED host (real wireHybridContentEvents installed, so the content
      // WC's idle-move reveal stream is driven by production code), set it active
      // so the overlay frames over it, then snap it to the work area so the
      // overlay is the no-gutter (maximized) frame — the worst case.
      const tmp = b.makeWiredHybridHost({ x: 100, y: 100, width: 600, height: 400 });
      b.setActive(tmp);
      const wa = b.hostWorkArea(tmp);
      b.setHostBounds(tmp, wa);
      await b.loadFakeContent(tmp, 'data:text/html,<body>top-border target</body>');
      return tmp;
    });
    await waitOverlayReady();
    return id;
  };

  test('idle top-border hover over the content WC reveals the navbar (no-gutter/maximized)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveMaximized();
    await resetHidden();

    // A real idle (no-button) move 4px below the host top edge — squarely inside
    // the 8px enter strip — drives the content WC's input-event handler, which
    // forwards `page-overlay:content-pointer {phase:'reveal'}`.
    const emitted = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.emitContentTopEdgeHover((arg as any).id, 4);
    }, { id });
    expect(emitted).toBe(true);

    // The navbar reveals (cross-process pubsub delivery is async → poll).
    await expect.poll(navbarVisible).toBe(true);
  });

  test('idle move BELOW the reveal band does not reveal; entering it does', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveMaximized();
    await resetHidden();

    // A move far below the top edge (200px) is outside the 44px band → no reveal.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 200);
    }, { id });
    // Give any (erroneous) reveal a chance to land, then assert still hidden.
    await app.evaluateMain!(() => new Promise((r) => setTimeout(r, 100)));
    expect(await navbarVisible()).toBe(false);

    // Now move INTO the band (5px below the top) → reveals.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 5);
    }, { id });
    await expect.poll(navbarVisible).toBe(true);
  });

  test('top-border reveal also works in the GUTTERED (non-maximized) case', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeWiredHybridHost({ x: 160, y: 160, width: 700, height: 460 });
      await b.loadFakeContent(w, 'data:text/html,<body>guttered target</body>');
      b.setActive(w);
      return w;
    });
    await waitOverlayReady();
    await resetHidden();

    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.emitContentTopEdgeHover((arg as any).id, 4);
    }, { id });
    await expect.poll(navbarVisible).toBe(true);
  });

  test('idle move within the navbar band but past the 8px trigger strip does NOT reveal', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveMaximized();
    await resetHidden();

    // 30px is inside the old 44px band but past the new 8px enter threshold — must stay hidden.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 30);
    }, { id });
    await app.evaluateMain!(() => new Promise((r) => setTimeout(r, 100)));
    expect(await navbarVisible()).toBe(false);
  });

  test('boundary: a move at the trigger strip edge (<=8px) reveals', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveMaximized();
    await resetHidden();

    // 6px — inside the 8px enter strip — should reveal.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 6);
    }, { id });
    await expect.poll(navbarVisible).toBe(true);
  });

  test('hysteresis: once revealed, moving within the navbar band keeps it revealed, then clears past 44px', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActiveMaximized();
    await resetHidden();

    // Reveal via the 8px strip.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 4);
    }, { id });
    await expect.poll(navbarVisible).toBe(true);

    // 30px — past the 8px enter threshold but within the 44px exit threshold — navbar stays visible.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 30);
    }, { id });
    await app.evaluateMain!(() => new Promise((r) => setTimeout(r, 100)));
    expect(await navbarVisible()).toBe(true);

    // 60px — past the 44px exit threshold — navbar hides.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.emitContentTopEdgeHover((arg as any).id, 60);
    }, { id });
    await expect.poll(navbarVisible).toBe(false);
  });
});

/**
 * Regression fixes R1 / R2 / R3.
 *
 *  R1 — overlay no longer steals APP focus when backgrounded. The transparent
 *       alwaysOnTop:'floating' overlay must, while the app is NOT frontmost,
 *       force click-through AND drop its floating level so a click in another
 *       app can neither hit it nor be swallowed by an Electron activation. On
 *       become-active the floating level + forwarded click-through are restored.
 *  R2 — click-and-hold on the navbar BACKGROUND drags the active hybrid window
 *       (the canvas gesture), publishing page:set-bounds which main routes to
 *       the host BaseWindow. The old dedicated #drag-zone was occluded by the
 *       navbar/trigger zone and never fired.
 *  R3 — Cmd+L (page:show-navbar) for the active window focuses the overlay
 *       WINDOW so the DOM-focused URL input is typeable — but ONLY when the app
 *       is active and the target is the active hybrid window (so it never
 *       reintroduces R1 focus theft).
 *
 * Focus-free: app resign/become and navbar-background drag are driven through
 * the test bridge (no real OS focus / app-active change), and R3 asserts the
 * focus INTENT count (real OS focus is unobservable on macOS-headless).
 */
test.describe('Hybrid Chrome Overlay regressions R1/R2/R3 @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-overlay-r1r2r3'));
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

  const makeActive = async (url: string) => {
    const id = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 160, y: 160, width: 700, height: 460 });
      await b.loadFakeContent(w, (arg as any).url);
      b.setActive(w);
      return w;
    }, { url });
    await waitOverlayReady();
    return id;
  };

  test('R1: app resign-active forces click-through + drops floating; become-active restores', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    await makeActive('data:text/html,<body>r1 target</body>');

    // Baseline (app active): the overlay floats and capture CAN be armed by the
    // renderer's pointer-over-chrome path.
    const baseline = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishCapture(true); // renderer would do this on chrome hover
      const st = b.overlayState();
      return { appActive: b.appActiveState(), alwaysOnTop: st?.alwaysOnTop, capture: b.captureState() };
    });
    expect(baseline.appActive).toBe(true);
    expect(baseline.alwaysOnTop).toBe(true);
    expect(baseline.capture).toBe(true);

    // App resigns active (user clicked into another app). The overlay must drop
    // its floating level AND be forced click-through so it cannot capture / float.
    const afterResign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const ok = b.simAppResignActive();
      const st = b.overlayState();
      return { ok, appActive: b.appActiveState(), alwaysOnTop: st?.alwaysOnTop, capture: b.captureState() };
    });
    expect(afterResign.ok).toBe(true);
    expect(afterResign.appActive).toBe(false);
    expect(afterResign.alwaysOnTop).toBe(false);
    expect(afterResign.capture).toBe(false);

    // While backgrounded, a renderer capture request (its mousemove loop firing
    // over the chrome band beneath another app) must be IGNORED — capture stays
    // off, so a click in the other app falls through.
    const capWhileBg = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishCapture(true);
      return b.captureState();
    });
    expect(capWhileBg).toBe(false);

    // App becomes active again → floating level restored, click-through re-armed.
    const afterBecome = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const ok = b.simAppBecomeActive();
      const st = b.overlayState();
      return { ok, appActive: b.appActiveState(), alwaysOnTop: st?.alwaysOnTop };
    });
    expect(afterBecome.ok).toBe(true);
    expect(afterBecome.appActive).toBe(true);
    expect(afterBecome.alwaysOnTop).toBe(true);

    // After become-active, capture can be armed again.
    const capAfterBecome = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishCapture(true);
      return b.captureState();
    });
    expect(capAfterBecome).toBe(true);
  });

  test('hold-to-drag FSM: hold-then-move drags; pre-threshold move cancels (pure, manual clock)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Ensure the overlay renderer exists + is ready (the FSM factory lives there).
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      b.setActive(w);
    });
    await waitOverlayReady();

    const r = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.holdDragFsmUnit();
    });
    expect(r).not.toBeNull();
    const res = r as any;

    // Case 1 — press → hold fires → move drags: grab cursor shown once on fire,
    // a drag started from the press point, and subsequent moves drove it.
    expect(res.caseDrag.grab).toBe(1);
    expect(res.caseDrag.starts).toEqual([[100, 100]]);
    expect(res.caseDrag.draggedDuring).toBe(true);
    expect(res.caseDrag.moves).toEqual([[140, 130], [160, 150]]);
    expect(res.caseDrag.ends).toBe(1);

    // Case 2 — press → move BEFORE threshold cancels: even after the threshold
    // would elapse, the FSM never becomes ready/dragging and never starts/moves.
    expect(res.caseCancel.state).toEqual({
      buttonDown: true, pending: false, ready: false, dragging: false,
    });
    expect(res.caseCancel.starts).toEqual([]);
    expect(res.caseCancel.moves).toEqual([]);
  });

  test('hold-to-drag: navbar background HOLD then move publishes page:set-bounds and moves the host', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 200, y: 220, width: 520, height: 400 };
    const id = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow((arg as any).start);
      await b.loadFakeContent(w, 'data:text/html,<body>drag target</body>');
      b.setActive(w);
      return w;
    }, { start });
    await waitOverlayReady();

    // Reveal the chrome so the navbar is interactive (the drag binds on it).
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.revealOverlayChrome();
    });

    const before = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds((arg as any).id);
    }, { id });

    // Press-and-HOLD the navbar background (still, past the threshold), THEN move
    // +120,+80 in screen coords. Only the deliberate hold-then-move drags.
    const dragged = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.holdDragNavbar(120, 80);
    });
    expect(dragged).toBe(true);

    // The host BaseWindow moved by the drag delta (size unchanged).
    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.hostBounds((arg as any).id);
        }, { id }),
      )
      .toEqual({ x: before.x + 120, y: before.y + 80, width: start.width, height: start.height });
  });

  test('hold-to-drag: a stray buttons=0 mousemove during the hold does NOT cancel the press (flake regression 73681521/7064b15c)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 240, y: 240, width: 520, height: 400 };
    const id = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow((arg as any).start);
      await b.loadFakeContent(w, 'data:text/html,<body>jitter target</body>');
      b.setActive(w);
      return w;
    }, { start });
    await waitOverlayReady();

    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.revealOverlayChrome();
    });

    const before = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds((arg as any).id);
    }, { id });

    // Press-and-HOLD, but a stray zero-button mousemove (OS jitter from the
    // overlay retargeting) lands DURING the hold window. The held-still press
    // must survive it and still drag +120,+80. Pre-fix the stray move reset the
    // FSM mid-hold → the hold never fired → dragged=false (the flake).
    const dragged = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.holdDragNavbarStrayZeroButton(120, 80);
    });
    expect(dragged).toBe(true);

    await expect
      .poll(async () =>
        app.evaluateMain!(async (_e, arg) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.hostBounds((arg as any).id);
        }, { id }),
      )
      .toEqual({ x: before.x + 120, y: before.y + 80, width: start.width, height: start.height });
  });

  test('hold-to-drag: pre-threshold movement CANCELS candidacy (dnd / selection / click preserved) and does NOT move the host', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 260, y: 280, width: 500, height: 380 };
    const id = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow((arg as any).start);
      await b.loadFakeContent(w, 'data:text/html,<body>no drag</body>');
      b.setActive(w);
      return w;
    }, { start });
    await waitOverlayReady();
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.revealOverlayChrome();
    });

    const before = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds((arg as any).id);
    }, { id });

    // Press, move beyond tolerance BEFORE the hold fires → candidacy cancels even
    // though the threshold then elapses: FSM never enters ready/dragging.
    const fsm = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.holdDragCancelByEarlyMove();
    });
    expect(fsm).toEqual({ buttonDown: true, pending: false, ready: false, dragging: false });

    // Host did NOT move (no page:set-bounds from a window drag).
    const after = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds((arg as any).id);
    }, { id });
    expect(after).toEqual(before);
  });

  test('R3: Cmd+L focuses the overlay window for the active window only, never when backgrounded', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const id = await makeActive('data:text/html,<body>cmd-l focus target</body>');

    const start = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.showNavbarFocusCount();
    });

    // Cmd+L for the ACTIVE window → overlay window focus intent fires once, AND
    // the navbar URL input takes shadow-DOM focus (typeable end-to-end).
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:show-navbar', { windowId: (arg as any).id });
    }, { id });

    await expect
      .poll(async () =>
        app.evaluateMain!(async () => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const s = await b.overlayChromeState();
          return s ? { vis: s.navbarVisible, focused: s.navbarInputFocused } : null;
        }),
      )
      .toEqual({ vis: true, focused: true });

    const afterActive = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.showNavbarFocusCount();
    });
    expect(afterActive).toBe(start + 1);

    // A Cmd+L for a FOREIGN windowId must NOT focus the overlay window.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:show-navbar', { windowId: (arg as any).id + 99999 });
    }, { id });
    const afterForeign = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.showNavbarFocusCount();
    });
    expect(afterForeign).toBe(afterActive);

    // R1×R3 interaction: while the app is BACKGROUNDED a Cmd+L for the active
    // window must NOT steal focus (no overlay-window focus intent).
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.simAppResignActive();
    });
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:show-navbar', { windowId: (arg as any).id });
    }, { id });
    const afterBg = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.showNavbarFocusCount();
    });
    expect(afterBg).toBe(afterActive);

    // Restore app-active so a later describe / teardown isn't left backgrounded.
    await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.simAppBecomeActive();
    });
  });
});
