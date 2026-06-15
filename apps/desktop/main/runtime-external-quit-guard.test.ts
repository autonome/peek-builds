/**
 * Unit tests for the runtime-external relay's shutdown guard (peek 048997b2).
 *
 * Crash: the `peek:runtime-external:send` IPC handler stays registered through
 * app quit (cleanup() deliberately leaves it — removing it would log cosmetic
 * "No handler" errors for in-flight invokes). So a late content-script
 * LOG_EVENT, fired AFTER before-quit has begun tearing down the session /
 * service workers / bridge windows, still reaches the handler. Pre-fix it then
 * enumerated `session.serviceWorkers` and called `swMain.send()` into those
 * half-destroyed natives → SIGSEGV on CrBrowserMain during teardown.
 *
 * The native fault is unobservable in headless (see apps/desktop/CLAUDE.md
 * LESSON), so we assert the DECISION instead: once quitting, the handler
 * returns an inert error envelope and NEVER touches `session.serviceWorkers`.
 *
 * No real `BrowserWindow` / `Session` is constructed — the handler's only
 * native reach on the no-bridge path is `session.serviceWorkers.getAllRunning`,
 * so a fake that counts that call proves whether the guard short-circuited
 * before any native access.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  setupMainProcess,
  markRuntimeExternalQuitting,
  _setQuittingForTests,
} from './chrome-api-polyfills/runtime-external.js';

const IPC_SEND_FROM_PAGE = 'peek:runtime-external:send';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

/**
 * Wire setupMainProcess against a fake ipcMain (captures the invoke handler)
 * and a fake session whose serviceWorkers.getAllRunning is counted — the only
 * native surface the no-bridge dispatch path reaches.
 */
function wire() {
  let handler: Handler | undefined;
  const ipcMain = {
    handle(channel: string, fn: Handler) {
      if (channel === IPC_SEND_FROM_PAGE) handler = fn;
    },
    on() {},
  };
  let getAllRunningCalls = 0;
  const session = {
    serviceWorkers: {
      getAllRunning() {
        getAllRunningCalls++;
        return {}; // no running SWs → handler returns the no-match error
      },
    },
  };
  // Fakes only implement the surface the handler touches; cast through unknown
  // so we don't have to stub all of Electron's Session / IpcMain.
  setupMainProcess(session as unknown as Electron.Session, {
    ipcMain: ipcMain as unknown as Electron.IpcMain,
  });
  assert.ok(handler, 'setupMainProcess must register the IPC_SEND_FROM_PAGE handler');
  return {
    invoke: (payload: unknown) => handler!({ sender: { id: 1 } }, payload),
    getAllRunningCalls: () => getAllRunningCalls,
  };
}

describe('runtime-external shutdown guard (048997b2)', () => {
  beforeEach(() => {
    _setQuittingForTests(false);
  });

  it('NOT quitting: dispatches and reaches session.serviceWorkers (no bridge → SW fallback)', async () => {
    const { invoke, getAllRunningCalls } = wire();
    const res = (await invoke({ extId: 'some-ext-id', message: { type: 'PROBE' } })) as {
      __peekRuntimeExternalError?: string;
    };
    // With no bridge window and no running SW, the handler falls through to the
    // SW path, enumerates service workers, finds nothing, and returns the
    // no-match error — proving the native enumeration DID run when not quitting.
    assert.equal(getAllRunningCalls(), 1, 'should enumerate service workers when not quitting');
    assert.match(res.__peekRuntimeExternalError ?? '', /no bridge window or running service worker/);
  });

  it('quitting: short-circuits to an inert error and NEVER touches session.serviceWorkers', async () => {
    const { invoke, getAllRunningCalls } = wire();
    markRuntimeExternalQuitting();
    const res = (await invoke({ extId: 'some-ext-id', message: { type: 'LOG_EVENT' } })) as {
      __peekRuntimeExternalError?: string;
    };
    assert.equal(res.__peekRuntimeExternalError, 'shutting down');
    assert.equal(
      getAllRunningCalls(),
      0,
      'must NOT enumerate service workers (or reach any native session object) during shutdown',
    );
  });
});
