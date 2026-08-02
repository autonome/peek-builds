/**
 * Unit tests for `window-escape-renderer-handled.ts` — the producer for
 * `window-escape.ts EscapeKeyPress.rendererHandled`.
 *
 * This is the failing-first proof the task asked for: before this module
 * existed, `rendererHandled` had NO producer anywhere — a test that builds an
 * `EscapeKeyPress` directly (as `window-escape.test.ts` does for the
 * interpreter's pure decision logic) proves nothing about whether the fact
 * ever arrives in practice, which is exactly how the defect survived. These
 * tests instead drive the actual producer path: a fake `ipcMain` stands in
 * for Electron's real one (injected, not imported — see the module docblock
 * for why), a simulated renderer report is fed through the SAME handler
 * `initRendererHandledEscapeTracking` registers, and the assertion reads back
 * through `rendererHandledEscapeForWc` — the exact function each of the four
 * Escape dispatch sites calls.
 */
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import type { IpcMain, IpcMainEvent } from 'electron';
import {
  initRendererHandledEscapeTracking,
  rendererHandledEscapeForWc,
  clearRendererHandledEscapeForWc,
  __resetRendererHandledEscapeRegistrationForTest,
  __TEST_IPC_ESCAPE_HANDLED_CHANNEL,
} from './window-escape-renderer-handled.js';

type Handler = (event: IpcMainEvent, ...args: unknown[]) => void;

/** A fake `ipcMain` that captures the `.on()` handler for the escape channel. */
function fakeIpcMain(): { ipcMain: IpcMain; report: (wcId: number, handled: unknown) => void } {
  let handler: Handler | undefined;
  const ipcMain = {
    on(channel: string, fn: Handler) {
      if (channel === __TEST_IPC_ESCAPE_HANDLED_CHANNEL) handler = fn;
      return ipcMain;
    },
  };
  return {
    ipcMain: ipcMain as unknown as IpcMain,
    report(wcId: number, handled: unknown) {
      assert.ok(handler, 'initRendererHandledEscapeTracking must register the escape-handled channel');
      handler!({ sender: { id: wcId } } as IpcMainEvent, handled);
    },
  };
}

describe('window-escape-renderer-handled (rendererHandled producer)', () => {
  beforeEach(() => {
    __resetRendererHandledEscapeRegistrationForTest();
  });

  it('before any report, a WC reads as not-handled (the pre-producer default)', () => {
    assert.strictEqual(rendererHandledEscapeForWc(101), false);
  });

  it('a renderer report of true updates the cache; the same wc id reads true back', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, true);
    assert.strictEqual(rendererHandledEscapeForWc(101), true);
  });

  it('a renderer report of false reads back false', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, false);
    assert.strictEqual(rendererHandledEscapeForWc(101), false);
  });

  it('a non-boolean payload collapses to false (matches isEditableFocusedForWc\'s `=== true` discipline)', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, 'yes');
    assert.strictEqual(rendererHandledEscapeForWc(101), false);
  });

  it('reports are keyed per-WC — one window reporting true does not leak to another', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, true);
    assert.strictEqual(rendererHandledEscapeForWc(202), false);
    assert.strictEqual(rendererHandledEscapeForWc(101), true);
  });

  it('a later report on the same WC overwrites the earlier one', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, true);
    assert.strictEqual(rendererHandledEscapeForWc(101), true);
    report(101, false);
    assert.strictEqual(rendererHandledEscapeForWc(101), false);
  });

  it('clearRendererHandledEscapeForWc drops the cached value back to absent/false', () => {
    const { ipcMain, report } = fakeIpcMain();
    initRendererHandledEscapeTracking(ipcMain);
    report(101, true);
    assert.strictEqual(rendererHandledEscapeForWc(101), true);
    clearRendererHandledEscapeForWc(101);
    assert.strictEqual(rendererHandledEscapeForWc(101), false);
  });

  it('initRendererHandledEscapeTracking is idempotent — a second call does not re-register', () => {
    const first = fakeIpcMain();
    initRendererHandledEscapeTracking(first.ipcMain);
    let secondOnCalls = 0;
    const second: IpcMain = {
      on() {
        secondOnCalls++;
        return second;
      },
    } as unknown as IpcMain;
    initRendererHandledEscapeTracking(second);
    assert.strictEqual(secondOnCalls, 0, 'second init must not call .on() again');
    // The FIRST registration is still the live one.
    first.report(101, true);
    assert.strictEqual(rendererHandledEscapeForWc(101), true);
  });
});
