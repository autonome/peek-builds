/**
 * Permission prompt — hybrid overlay integration spec.
 *
 * The web-permission prompt UI lives in the SHARED chrome overlay
 * (renderer/page/overlay.js), not a per-page chrome: the hybrid page-host is
 * an opaque BaseWindow + WebContentsView, and ONE transparent overlay window
 * retargets over whichever hybrid window is active. This spec drives the full
 * deferred-callback flow end-to-end:
 *
 *   1. Open a REAL hybrid page-host on a test HTTP origin (production
 *      `app.window.open` path — registerGuest + wireHybridContentEvents).
 *   2. Call navigator.geolocation.getCurrentPosition inside the content WC.
 *   3. permission-handler resolves the policy to 'prompt', stores the deferred
 *      Chromium callback, and publishes `page:permission-request`.
 *   4. The overlay renders `.permission-prompt` for the ACTIVE window.
 *   5. Click Deny/Allow (DOM click via the E2E bridge — a real pointer click
 *      needs OS focus/capture a headless run can't grant) → overlay publishes
 *      `page:permission-response`, backend resolves the callback, geolocation
 *      settles in the content WC.
 *
 * Queue mechanics (one visible prompt + "+N more pending" badge) and
 * background-window deferral are driven with SYNTHETIC
 * `page:permission-request` publishes — the queueing UX lives entirely in
 * overlay.js, independent of which Chromium permission triggered it (mirrors
 * the old canvas Phase-5 test). Window-close cleanup asserts the backend's
 * pending map drains (`denyPendingRequestsForWindow` via the hybrid
 * registry's closed-listener) and the overlay prunes on
 * `page:permission-resolved`.
 *
 * Focus-free throughout: active-window changes are synthetic (`setActive`),
 * prompts are read/clicked via executeJavaScript in the overlay renderer.
 * All waits are expect.poll against deterministic DOM/backend state.
 *
 * Run with: yarn test:grep "Permission Prompt"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  openHybridPage,
  setActive,
  closeHybridPage,
  waitOverlayReady,
  getHybridContentWcId,
  publishOverlayTopic,
} from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

/** Overlay prompt state read via the E2E bridge (hybrid-overlay.ts). */
interface PromptState {
  ready: boolean;
  present: boolean;
  promptCount: number;
  requestId: string | null;
  origin: string | null;
  text: string;
  badgeVisible: boolean;
  badgeText: string | null;
  faviconSrc: string | null;
  queuedCount: number | null;
  queuedIds: string[] | null;
}

async function promptState(): Promise<PromptState | null> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      overlayPermissionPromptState(): Promise<unknown>;
    };
    return b.overlayPermissionPromptState() as Promise<PromptState | null>;
  });
}

async function promptPresent(): Promise<boolean> {
  const s = await promptState();
  return s ? s.present : false;
}

/** DOM-click Allow/Deny (optionally checking Remember first) via the bridge. */
async function clickPrompt(allow: boolean, remember = false): Promise<boolean> {
  return app.evaluateMain!((_e, arg) => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      clickPermissionPrompt(allow: boolean, remember?: boolean): Promise<boolean>;
    };
    return b.clickPermissionPrompt(arg.allow, arg.remember);
  }, { allow, remember } as { allow: boolean; remember: boolean });
}

/** permission-handler's pending deferred-callback count (backend truth). */
async function pendingCount(): Promise<number> {
  return app.evaluateMain!(() => {
    const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
      pendingPermissionRequestCount(): number;
    };
    return b.pendingPermissionRequestCount();
  });
}

/**
 * Open a REAL hybrid page-host on the local test origin via the production
 * window-open path (so registerGuest → findHostWindowId attribution works),
 * make it the active window synthetically, and wait until the test page's
 * `window.__requestGeo` hook is live in the content WC.
 */
async function openRealHybridPage(slug: string): Promise<{ winId: number; wcId: number }> {
  const url = `http://127.0.0.1:${serverPort}/${slug}`;
  const result = await bgWindow.evaluate(async (u: string) => {
    return await (window as any).app.window.open(u, { width: 800, height: 600 });
  }, url);
  expect(result.success).toBe(true);
  const winId: number = result.id;
  expect(winId).toBeTruthy();

  await setActive(app, { id: winId, contentWcId: null });
  await waitOverlayReady(app);

  const wcId = await getHybridContentWcId(app, winId);
  expect(wcId).not.toBeNull();

  await expect
    .poll(async () =>
      app.evaluateMain!((e, arg) => {
        const wc = e.webContents.fromId(arg.wcId);
        if (!wc || wc.isDestroyed()) return false;
        return wc
          .executeJavaScript("typeof window.__requestGeo === 'function'")
          .catch(() => false);
      }, { wcId: wcId! } as { wcId: number }),
    )
    .toBe(true);

  return { winId, wcId: wcId! };
}

/**
 * Kick off a geolocation request inside the content WC WITHOUT awaiting it
 * (it blocks until the user responds). The result promise is stashed on a
 * main-process global keyed by `key`; read it back with geoResult() AFTER
 * resolving the prompt.
 */
async function startGeoRequest(wcId: number, key: string): Promise<void> {
  await app.evaluateMain!((e, arg) => {
    const wc = e.webContents.fromId(arg.wcId);
    if (!wc || wc.isDestroyed()) throw new Error('content WC gone');
    (globalThis as Record<string, unknown>)[arg.key] = wc.executeJavaScript('window.__requestGeo()');
  }, { wcId, key } as { wcId: number; key: string });
}

async function geoResult(key: string): Promise<string> {
  return app.evaluateMain!(
    (_e, arg) => (globalThis as Record<string, unknown>)[arg.key] as Promise<string>,
    { key } as { key: string },
  );
}

async function closeWindow(winId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    await (window as any).app.window.close(id);
  }, winId);
}

test.describe('Permission Prompt @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('permission-prompt'));

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<body>
<h1>perm test</h1>
<script>
  window.__lastGeoResult = null;
  window.__requestGeo = function() {
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        () => { window.__lastGeoResult = 'allowed'; resolve('allowed'); },
        (err) => {
          window.__lastGeoResult = 'denied:' + err.code;
          resolve('denied:' + err.code);
        },
        { timeout: 5000 }
      );
    });
  };
  window.__requestMedia = function() {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(() => 'allowed')
      .catch(err => 'denied:' + (err && err.name ? err.name : 'unknown'));
  };
</script>
</body>
</html>`);
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

  // Reset per-test state so each test is hermetic: stored decisions (the
  // Remember tests persist for this origin), the backend pending-request map,
  // and the overlay renderer's queue/prompt DOM (singleton across tests).
  test.beforeEach(async () => {
    await bgWindow.evaluate(async () => {
      await (window as any).app.permissions.forgetAll();
    });
    await app.evaluateMain!(() => {
      const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
        resetPermissionHandlerForTests(): void;
        resetPermissionPromptsForTests(): Promise<boolean>;
      };
      b.resetPermissionHandlerForTests();
      return b.resetPermissionPromptsForTests();
    });
  });

  test('geolocation request renders overlay prompt with origin + favicon; Deny resolves PERMISSION_DENIED', async () => {
    const { winId, wcId } = await openRealHybridPage('perm-deny');

    await startGeoRequest(wcId, '__permGeoDeny');

    // The deferred request surfaces as the overlay's visible prompt.
    await expect.poll(() => promptPresent()).toBe(true);
    const st = (await promptState())!;
    expect(st.promptCount).toBe(1);
    expect(st.text).toContain('know your location');
    expect(st.origin).toContain('127.0.0.1');
    // Favicon rides the same google-s2 + globe-fallback approach as the canvas.
    expect(st.faviconSrc).toMatch(/google\.com\/s2\/favicons\?domain=127\.0\.0\.1/);
    expect(await pendingCount()).toBe(1);

    // Deny → prompt removes itself, backend resolves the deferred callback.
    expect(await clickPrompt(false)).toBe(true);
    await expect.poll(() => promptPresent()).toBe(false);
    expect(await geoResult('__permGeoDeny')).toBe('denied:1');
    await expect.poll(() => pendingCount()).toBe(0);

    await closeWindow(winId);
  });

  test('replay: a pending request the overlay renderer never received surfaces on the next handoff', async () => {
    // pubsub keeps no history, so a `page:permission-request` published before
    // the overlay renderer subscribed reached nobody and the prompt stayed
    // invisible until window close auto-denied it. Every `page-overlay:active`
    // handoff now carries the window's still-pending requests, so the next
    // handoff recovers it. A REAL host is required here: fake hosts
    // (makeFakeHybridWindow) fail on Linux for an unrelated reason.
    const { winId, wcId } = await openRealHybridPage('perm-replay');

    await startGeoRequest(wcId, '__permGeoReplay');
    await expect.poll(() => promptPresent()).toBe(true);
    const requestId = (await promptState())!.requestId;
    expect(requestId).toBeTruthy();

    // Wipe the renderer's queue and its settled-id tombstones. That is exactly
    // the state a fresh overlay renderer starts in — the publish already
    // happened and it was not there to hear it — while the backend still holds
    // the deferred Chromium callback.
    await app.evaluateMain!(() => {
      const b = (globalThis as Record<string, unknown>).__peekHybridOverlayTest as {
        resetPermissionPromptsForTests(): Promise<boolean>;
      };
      return b.resetPermissionPromptsForTests();
    });
    const wiped = (await promptState())!;
    expect(wiped.present).toBe(false);
    expect(wiped.queuedCount).toBe(0);
    expect(await pendingCount()).toBe(1);

    // `page-overlay:ready` is what a freshly-loaded overlay renderer publishes.
    // It reaches main's wireOverlayReady subscriber, which re-sends the active
    // handoff — so the path under test is the production one, not a test-only
    // shortcut.
    await publishOverlayTopic(app, 'page-overlay:ready', {});

    await expect.poll(() => promptPresent()).toBe(true);
    const replayed = (await promptState())!;
    expect(replayed.requestId).toBe(requestId);
    expect(replayed.queuedCount).toBe(1);

    // A second handoff must not duplicate: enqueue dedups on requestId.
    await publishOverlayTopic(app, 'page-overlay:ready', {});
    await expect.poll(async () => (await promptState())?.queuedCount).toBe(1);
    expect((await promptState())!.requestId).toBe(requestId);

    // The replayed prompt is the real thing — answering it resolves the
    // deferred callback that has been waiting in the backend all along.
    expect(await clickPrompt(false)).toBe(true);
    await expect.poll(() => promptPresent()).toBe(false);
    expect(await geoResult('__permGeoReplay')).toMatch(/^denied:/);
    await expect.poll(() => pendingCount()).toBe(0);

    // Nothing left to replay: the entry is gone from the backend, and the
    // settled-id tombstone would refuse it even if a stale listing arrived.
    await publishOverlayTopic(app, 'page-overlay:ready', {});
    await expect.poll(async () => (await promptState())?.queuedCount).toBe(0);
    expect(await promptPresent()).toBe(false);

    await closeWindow(winId);
  });

  test('Allow path: geolocation proceeds (result is NOT PERMISSION_DENIED)', async () => {
    // Allowing geolocation makes Chromium run the REAL navigator.geolocation
    // lookup. On a macOS host with Location Services enabled that surfaces the
    // native OS Location prompt — a focus-stealing, system-hanging TCC dialog
    // on the user's physical desktop. CI (Linux/Xvfb, or macOS with Location
    // Services off) has no such service, so the call fails gracefully. Skip
    // the allow-path on macOS-headless; deny/render paths still cover the UI.
    test.skip(
      process.env.HEADLESS === '1' && process.platform === 'darwin',
      'Allow-path triggers a real geolocation call → macOS Location Services prompt; covered on Linux/Xvfb',
    );
    const { winId, wcId } = await openRealHybridPage('perm-allow');

    await startGeoRequest(wcId, '__permGeoAllow');
    await expect.poll(() => promptPresent()).toBe(true);

    expect(await clickPrompt(true)).toBe(true);
    await expect.poll(() => promptPresent()).toBe(false);

    // After Allow, Chromium proceeds with the actual lookup. In a test env it
    // typically fails with POSITION_UNAVAILABLE (2) or TIMEOUT (3) — but it
    // MUST NOT be PERMISSION_DENIED (1). That proves Allow actually allowed.
    expect(await geoResult('__permGeoAllow')).not.toBe('denied:1');
    await expect.poll(() => pendingCount()).toBe(0);

    await closeWindow(winId);
  });

  test('Remember + Deny persists: second same-origin request auto-resolves promptless; decision listed', async () => {
    // First window: deny with "Remember this decision" checked.
    const first = await openRealHybridPage('perm-remember-1');
    await startGeoRequest(first.wcId, '__permGeoRem1');
    await expect.poll(() => promptPresent()).toBe(true);

    expect(await clickPrompt(false, /* remember */ true)).toBe(true);
    await expect.poll(() => promptPresent()).toBe(false);
    expect(await geoResult('__permGeoRem1')).toBe('denied:1');

    // The remembered decision is visible via api.permissions.list.
    const listed = await bgWindow.evaluate(async () => {
      return await (window as any).app.permissions.list();
    });
    expect(listed.success).toBe(true);
    const row = (listed.data as Array<{ origin: string; permission: string; allowed: boolean }>)
      .find((r) => r.permission === 'geolocation' && r.origin.includes('127.0.0.1'));
    expect(row).toBeTruthy();
    expect(row!.allowed).toBe(false);

    // Second window on the SAME origin (same host:port, different path): the
    // stored decision short-circuits — geolocation settles with NO prompt and
    // NO pending deferred callback.
    const second = await openRealHybridPage('perm-remember-2');
    await startGeoRequest(second.wcId, '__permGeoRem2');
    expect(await geoResult('__permGeoRem2')).toBe('denied:1');
    const st = (await promptState())!;
    expect(st.present).toBe(false);
    expect(st.queuedCount).toBe(0);
    expect(await pendingCount()).toBe(0);

    await closeWindow(first.winId);
    await closeWindow(second.winId);
  });

  test('Remember + Allow persists: second same-origin request auto-allows promptless', async () => {
    // Same TCC hazard as the Allow-path test above: clicking Allow (and the
    // auto-allowed second request) runs the REAL geolocation lookup. The
    // Deny+Remember test covers the persistence logic on macOS-headless.
    test.skip(
      process.env.HEADLESS === '1' && process.platform === 'darwin',
      'Allow-path triggers a real geolocation call → macOS Location Services prompt; covered on Linux/Xvfb',
    );
    const first = await openRealHybridPage('perm-allow-remember-1');
    await startGeoRequest(first.wcId, '__permGeoAllowRem1');
    await expect.poll(() => promptPresent()).toBe(true);

    expect(await clickPrompt(true, /* remember */ true)).toBe(true);
    await expect.poll(() => promptPresent()).toBe(false);
    expect(await geoResult('__permGeoAllowRem1')).not.toBe('denied:1');

    const second = await openRealHybridPage('perm-allow-remember-2');
    await startGeoRequest(second.wcId, '__permGeoAllowRem2');
    expect(await geoResult('__permGeoAllowRem2')).not.toBe('denied:1');
    const st = (await promptState())!;
    expect(st.present).toBe(false);
    expect(st.queuedCount).toBe(0);

    await closeWindow(first.winId);
    await closeWindow(second.winId);
  });

  test('queueing: two requests show ONE prompt + "+1 more pending" badge; resolving surfaces the next', async () => {
    // Synthetic requests (mirrors the old canvas Phase-5 test): the queueing
    // UX lives entirely in overlay.js, independent of which Chromium
    // permission triggered it — publishing the same topic the backend does
    // isolates the renderer logic from the (headless-flaky) media-device path.
    const h = await openHybridPage(app, 'data:text/html,<title>perm-queue</title><body>q</body>');

    await publishOverlayTopic(app, 'page:permission-request', {
      requestId: 'q1', windowId: h.id,
      permission: 'geolocation', origin: 'https://example.com',
      label: 'know your location',
    });
    await publishOverlayTopic(app, 'page:permission-request', {
      requestId: 'q2', windowId: h.id,
      permission: 'media', origin: 'https://meet.example.com',
      label: 'use your camera and microphone',
    });

    // Exactly ONE visible prompt (the queue head) + badge showing +1 pending.
    await expect.poll(async () => {
      const s = await promptState();
      return s && s.promptCount === 1 && s.queuedCount === 2
        && s.badgeVisible && /\+1 more pending/.test(s.badgeText || '');
    }).toBe(true);

    // The visible prompt is the FIRST request (geolocation @ example.com).
    let st = (await promptState())!;
    expect(st.requestId).toBe('q1');
    expect(st.text).toContain('know your location');
    expect(st.text).toContain('https://example.com');

    // Deny the first — the second takes its place; badge gone.
    expect(await clickPrompt(false)).toBe(true);
    await expect.poll(async () => (await promptState())?.requestId).toBe('q2');
    st = (await promptState())!;
    expect(st.promptCount).toBe(1);
    expect(st.text).toContain('camera and microphone');
    expect(st.badgeVisible).toBe(false);

    // Resolve the second — queue empty, no prompts left.
    expect(await clickPrompt(false)).toBe(true);
    await expect.poll(async () => {
      const s = await promptState();
      return s ? s.promptCount === 0 && s.queuedCount === 0 : false;
    }).toBe(true);

    await closeHybridPage(app, h);
  });

  test('background-window deferral: request for a non-active window stays queued; surfaces on setActive', async () => {
    const hA = await openHybridPage(app, 'data:text/html,<title>perm-bg-a</title><body>a</body>');
    const hB = await openHybridPage(app, 'data:text/html,<title>perm-bg-b</title><body>b</body>', {
      activate: false,
      bounds: { x: 150, y: 150, width: 700, height: 500 },
    });

    // Request arrives for the NON-active window B: queued, no prompt.
    await publishOverlayTopic(app, 'page:permission-request', {
      requestId: 'bg1', windowId: hB.id,
      permission: 'geolocation', origin: 'https://background.example.com',
      label: 'know your location',
    });
    // Deterministic delivery signal: the queue holds it before we assert
    // nothing is rendered (never auto-denied, never shown for window A).
    await expect.poll(async () => (await promptState())?.queuedCount).toBe(1);
    let st = (await promptState())!;
    expect(st.present).toBe(false);

    // B becomes the active window → its queued request surfaces.
    await setActive(app, hB);
    await expect.poll(() => promptPresent()).toBe(true);
    st = (await promptState())!;
    expect(st.requestId).toBe('bg1');
    expect(st.origin).toContain('background.example.com');

    // Retarget back to A: prompt is taken down but stays queued (no auto-deny).
    await setActive(app, hA);
    await expect.poll(() => promptPresent()).toBe(false);
    await expect.poll(async () => (await promptState())?.queuedCount).toBe(1);

    // Clean up: resolve it on B so nothing leaks into the next test.
    await setActive(app, hB);
    await expect.poll(() => promptPresent()).toBe(true);
    expect(await clickPrompt(false)).toBe(true);
    await expect.poll(async () => (await promptState())?.queuedCount).toBe(0);

    await closeHybridPage(app, hB);
    await closeHybridPage(app, hA);
  });

  test('window close auto-denies: pending count drops to 0 and no stale prompt remains', async () => {
    const { winId, wcId } = await openRealHybridPage('perm-close');

    await startGeoRequest(wcId, '__permGeoClose');
    await expect.poll(() => promptPresent()).toBe(true);
    expect(await pendingCount()).toBe(1);

    // Close the hybrid window with the prompt still open. The hybrid
    // registry's closed-listener routes into denyPendingRequestsForWindow:
    // the deferred Chromium callback is denied (no leak), and the published
    // page:permission-resolved prunes the overlay's queued prompt.
    await closeWindow(winId);

    await expect.poll(() => pendingCount()).toBe(0);
    await expect.poll(async () => {
      const s = await promptState();
      return s ? s.promptCount === 0 && s.queuedCount === 0 : false;
    }).toBe(true);
  });
});
