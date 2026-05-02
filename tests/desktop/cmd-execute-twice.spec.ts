/**
 * Repro: dispatching the same `cmd:execute:X` topic twice in a row
 * should work both times. Manual testing shows the second invocation
 * stalls — the result never comes back. This test pins that behavior
 * down so the fix is verifiable.
 *
 * Uses the hello-world tile because its `hello world` command is the
 * simplest programmatic command in the codebase: a single tile entry
 * (resident `home`) that registers `hello world` via
 * `api.commands.register(...)` with an async execute that returns a
 * plain object.
 */

import { test, expect, getSharedApp, type DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

let sharedApp: DesktopApp;
let sharedBg: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBg = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBg);

  // Wait for hello-world's command registration to actually reach the
  // main-process pubsub bus. `waitForExtensionsReady` gates on feature
  // *load* but not on the `cmd:register`/`cmd:register-batch` round-
  // trip that announces `hello world` to the cmd panel. Firing before that
  // round-trip means zero subscribers exist for `cmd:execute:hello world`.
  //
  // Approach: poll `api.features.list('builtin')` for hello-world
  // presence, THEN do a single pubsub query-round-trip to confirm the
  // command is registered.
  await sharedBg.waitForFunction(async () => {
    const api = (window as { app?: Record<string, unknown> }).app as unknown as {
      features: { list: (sourceType?: string) => Promise<{ entries?: Array<{ id: string }> }> };
      subscribe: (topic: string, cb: (msg: unknown) => void, scope: number) => () => void;
      publish: (topic: string, data: unknown, scope: number) => void;
      scopes: { GLOBAL: number };
    };
    try {
      const list = await api.features.list('builtin');
      const registered = list?.entries?.some(e => e.id === 'hello-world');
      if (!registered) return false;
    } catch {
      return false;
    }
    // Now verify `hello` is in the cmd-panel's known command set.
    return await new Promise<boolean>((resolve) => {
      const unsubscribe = api.subscribe('cmd:query-commands-response', (msg: unknown) => {
        unsubscribe?.();
        const cmds = (msg as { commands?: Array<{ name: string }> })?.commands || [];
        resolve(cmds.some(c => c.name === 'hello world'));
      });
      api.publish('cmd:query-commands', {});
      setTimeout(() => { unsubscribe?.(); resolve(false); }, 200);
    });
  }, null, { timeout: 15000 });
});

/**
 * Publish `cmd:execute:<name>` with a fresh resultTopic; await the
 * reply or resolve undefined after `timeoutMs`. Mirrors what the cmd
 * panel's proxy-command does in app/cmd/commands.js.
 */
async function invoke(bg: Page, name: string, timeoutMs = 5000): Promise<unknown> {
  return bg.evaluate(async ({ cmdName, timeout }) => {
    const api = (window as { app?: Record<string, unknown> }).app as unknown as {
      subscribe: (topic: string, cb: (msg: unknown) => void, scope: number) => () => void;
      publish: (topic: string, data: unknown, scope: number) => void;
      scopes: { GLOBAL: number };
    };
    return new Promise<unknown>((resolve) => {
      const resultTopic = `cmd:execute:${cmdName}:result:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      let settled = false;
      const unsubscribe = api.subscribe(resultTopic, (result: unknown) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        resolve(result);
      });
      api.publish(`cmd:execute:${cmdName}`, { expectResult: true, resultTopic });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        resolve(undefined);
      }, timeout);
    });
  }, { cmdName: name, timeout: timeoutMs });
}

test('cmd:execute:hello world returns a result on repeat invocations', async () => {
  // First invocation — expected to succeed per manual repro.
  const first = await invoke(sharedBg, 'hello world', 10000);
  expect(first, 'first invocation result').toBeDefined();

  // Second invocation — user-reported stall happens here.
  const second = await invoke(sharedBg, 'hello world', 10000);
  expect(second, 'second invocation result (user-reported stall)').toBeDefined();

  // Third invocation — sanity check that it's not just a "works once" fluke.
  const third = await invoke(sharedBg, 'hello world', 10000);
  expect(third, 'third invocation result').toBeDefined();
});
