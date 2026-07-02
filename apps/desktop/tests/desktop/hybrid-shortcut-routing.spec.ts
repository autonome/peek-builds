import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regressions R2 / R3 (Cluster B), 2026-06-08.
 *
 *   R3 (peek bd00bf01) — cmd+N stopped opening a new empty page-host.
 *   R2 (peek b1dd4e7c) — keyboard shortcuts for peeks/slides (and any other
 *       LOCAL shortcut) no longer fired with a hybrid host frontmost.
 *
 * Root cause (shared): when the hybrid page-host became the default, a focused
 * hybrid host makes its content `WebContentsView` the macOS first responder
 * (A's R4 fix). Keystrokes therefore flow to the content WC's
 * `before-input-event` handler (ipc.ts `wireHybridContentEvents`) — NOT to the
 * per-BrowserWindow `before-input-event` in main.ts that routes to
 * `handleLocalShortcut`. That hybrid handler ONLY published the page-specific
 * accelerators (cmd+L/R/F/G/[/]); every other registered LOCAL shortcut —
 * cmd+N (new empty page-host) included — was silently dropped. The fix routes
 * the leftover modifier keystrokes through the SAME `handleLocalShortcut`
 * dispatcher the canvas/core windows use.
 *
 * (peeks Option+0 / slides Option+Up are OS-level GLOBAL grabs that pre-empt
 * before-input-event and were never swallowed by the content WC — see the
 * "global accelerators unaffected" note below. R2's user-visible breakage was
 * the LOCAL-shortcut gap this closes.)
 *
 * Focus-free: we drive the content WC's before-input-event synthetically via
 * the test bridge (a macOS-headless run can't grant the real OS focus a live
 * keystroke needs) and assert the SAME dispatch the real path produces.
 */
test.describe('Hybrid page-host shortcut routing (R2/R3) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-shortcut-routing'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // R3: cmd+N over a focused hybrid host reaches the local-shortcut dispatcher.
  // We register a probe local shortcut on the primary modifier + 'n' and assert
  // it fires when the content WC's before-input-event is driven — proving the
  // leftover-modifier branch routes to handleLocalShortcut (the same path that
  // carries the real cmd+N → openNewPageWindow binding). The event is also
  // preventDefault()-ed (consumed), matching the canvas/core dispatch contract.
  test('cmd+N over a hybrid host reaches the local-shortcut dispatcher (R3)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      // makeWiredHybrid installs the REAL wireHybridContentEvents (the same
      // before-input-event handler the ipc.ts hybrid branch wires), so we drive
      // the actual production routing — not a stand-in.
      const id = await b.makeWiredHybrid('data:text/html,<title>N</title>x');
      b.setActive(id);
      // Bind a probe under the cmd+N accelerator (CommandOrControl+N — meta on
      // darwin, control elsewhere), then drive the content WC's keystroke path.
      b.registerProbeShortcut('CommandOrControl+N');
      const prevented = b.dispatchContentKey(id, 'n');
      const fired = b.probeShortcutFireCount();
      b.unregisterProbeShortcut('CommandOrControl+N');
      return { fired, prevented };
    });

    // The local shortcut fired exactly once via the hybrid content WC path...
    expect(result.fired).toBe(1);
    // ...and the keystroke was consumed (preventDefault), like canvas/core.
    expect(result.prevented).toBe(true);
  });

  // R2: a generic LOCAL feature shortcut (here a probe on cmd+J, standing in for
  // any feature's local binding) also fires through the hybrid content WC path.
  // Before the fix, only the page-specific accelerators reached the handler, so
  // these were dead with a hybrid host focused.
  test('a generic local shortcut fires through the hybrid content WC path (R2)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeWiredHybrid('data:text/html,<title>J</title>x');
      b.setActive(id);
      b.registerProbeShortcut('CommandOrControl+J');
      const prevented = b.dispatchContentKey(id, 'j');
      const fired = b.probeShortcutFireCount();
      b.unregisterProbeShortcut('CommandOrControl+J');
      return { fired, prevented };
    });

    expect(result.fired).toBe(1);
    expect(result.prevented).toBe(true);
  });

  // Guard: a page-specific accelerator (cmd+R → page:reload) is still handled
  // INLINE by the hybrid handler and must NOT also be routed to a same-key local
  // shortcut — i.e. the inline page set takes precedence (no double-dispatch).
  test('page-specific accelerators stay inline, not double-dispatched (guard)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeWiredHybrid('data:text/html,<title>R</title>x');
      b.setActive(id);
      // Register a probe on cmd+R — a page-specific key. The inline branch must
      // win, so the probe must NOT fire even though it's registered.
      b.registerProbeShortcut('CommandOrControl+R');
      const prevented = b.dispatchContentKey(id, 'r');
      const fired = b.probeShortcutFireCount();
      b.unregisterProbeShortcut('CommandOrControl+R');
      return { fired, prevented };
    });

    // cmd+R is consumed by the inline page:reload branch (preventDefault)...
    expect(result.prevented).toBe(true);
    // ...and the same-key local probe never fires (no double-dispatch).
    expect(result.fired).toBe(0);
  });
});
