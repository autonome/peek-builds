/**
 * Rule engine reactivity wiring (no UI, no scripts feature).
 *
 * Bug surface: clicking affordances sometimes fails to propagate
 * tag mutations to other open windows. Before chasing the
 * UI/lazy-tile/affordance side, prove the underlying rule engine
 * pipeline behaves deterministically when exercised directly:
 *
 *   register rule  → publish topic → engine matches predicate
 *                  → engine publishes scripts:execute:<id>
 *                  → test subscriber receives payload
 *
 * No affordance:click, no scripts feature, no consumer windows.
 * Pure mainline of: register/list/predicate/dispatch/publish.
 *
 * If this passes consistently, the rule engine wiring is sound and
 * any flake further up the stack is in lazy-tile loading,
 * affordance lib, or consumer subscriptions.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

const TOGGLES = 10;

test.describe('Rule engine wiring @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('rule-engine-wiring'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test(`${TOGGLES} publishes of a matching topic produce ${TOGGLES} script-execute events in order`, async () => {
    const ts = Date.now();
    const topic = `test:tick-${ts}`;
    const scriptId = `test-handler-${ts}`;
    const scriptTopic = `scripts:execute:${scriptId}`;

    // Wire the test in two halves on the bg window:
    //
    //   1. Subscribe to the per-script topic the engine will publish,
    //      collecting every payload into window.__pipeline.received.
    //   2. Register a rule whose match clause filters on a `seq`
    //      field — every publish carries a different seq so we can
    //      assert ordering and exact delivery.
    await bgWindow.evaluate(async ({ topic, scriptId, scriptTopic }) => {
      const api = (window as any).app;
      const w: any = window;
      w.__pipeline = { received: [] as Array<{ seq: number; ts: number }> };

      api.pubsub.subscribe(scriptTopic, (msg: any) => {
        const event = msg?.context?.event ?? null;
        w.__pipeline.received.push({
          seq: event?.seq ?? null,
          ts: Date.now(),
        });
      });

      // Match every event for this topic — the rule fires on each
      // publish regardless of seq value. We could also predicate on
      // seq>=0 but plain {} keeps the test focused on dispatch/order
      // rather than predicate evaluation (which has its own unit
      // tests).
      await api.rules.register({
        id: scriptId,
        topic,
        scriptId,
        match: {},
        config: { tag: 'test' },
        enabled: true,
      });
    }, { topic, scriptId, scriptTopic });

    // Sanity: nothing received yet.
    const beforeCount = await bgWindow.evaluate(() => (window as any).__pipeline.received.length);
    expect(beforeCount).toBe(0);

    // Drive N publishes synchronously. Each carries a unique `seq`.
    // Between publishes, wait for the engine to deliver the
    // corresponding scripts:execute:<id> payload — we assert the
    // delivery happens BEFORE the next publish, so any out-of-order
    // dispatch surfaces immediately.
    for (let i = 0; i < TOGGLES; i++) {
      const seq = i;
      await bgWindow.evaluate(({ topic, seq }) => {
        const api = (window as any).app;
        api.pubsub.publish(topic, { seq });
      }, { topic, seq });

      // Wait for the i-th delivery (received.length === i+1).
      await bgWindow.waitForFunction(
        (expected: number) => (window as any).__pipeline.received.length >= expected,
        i + 1,
        { timeout: 5000 },
      );
    }

    // Final assertions: exactly N deliveries, in seq order, no
    // duplicates, no drops.
    const received = await bgWindow.evaluate(
      () => (window as any).__pipeline.received,
    );
    expect(received).toHaveLength(TOGGLES);
    for (let i = 0; i < TOGGLES; i++) {
      expect(received[i].seq, `delivery #${i} seq mismatch`).toBe(i);
    }
  });

  test('predicate match filters dispatch (only matching events fire script)', async () => {
    const ts = Date.now();
    const topic = `test:filtered-${ts}`;
    const scriptId = `filtered-handler-${ts}`;
    const scriptTopic = `scripts:execute:${scriptId}`;

    await bgWindow.evaluate(async ({ topic, scriptId, scriptTopic }) => {
      const api = (window as any).app;
      const w: any = window;
      w.__filtered = { received: [] as any[] };

      api.pubsub.subscribe(scriptTopic, (msg: any) => {
        w.__filtered.received.push(msg?.context?.event ?? null);
      });

      await api.rules.register({
        id: scriptId,
        topic,
        scriptId,
        match: { kind: 'fire' },
        enabled: true,
      });
    }, { topic, scriptId, scriptTopic });

    // 5 publishes alternating fire/skip. Only "fire" should reach
    // the script handler.
    for (let i = 0; i < 10; i++) {
      const kind = (i % 2 === 0) ? 'fire' : 'skip';
      await bgWindow.evaluate(({ topic, kind, seq }) => {
        const api = (window as any).app;
        api.pubsub.publish(topic, { kind, seq });
      }, { topic, kind, seq: i });
    }

    // Wait until 5 fires have arrived (all the matching ones).
    await bgWindow.waitForFunction(
      () => (window as any).__filtered.received.length >= 5,
      undefined,
      { timeout: 5000 },
    );

    // Give a small grace window in case any spurious extra delivery
    // is in flight, then snapshot.
    await new Promise(r => setTimeout(r, 200));
    const received = await bgWindow.evaluate(
      () => (window as any).__filtered.received,
    );
    expect(received).toHaveLength(5);
    expect(received.every((e: any) => e?.kind === 'fire')).toBe(true);
    expect(received.map((e: any) => e?.seq)).toEqual([0, 2, 4, 6, 8]);
  });
});
