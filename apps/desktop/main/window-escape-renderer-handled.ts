// The producer for `window-escape.ts EscapeKeyPress.rendererHandled` —
// "the renderer already consumed this Escape", mirrored into main and read
// synchronously at keypress time. Real producer: `tile-preload.cts`'s
// `api.escape.onEscape` surface sends the callback's answer to
// `tile:escape:handled` right after answering the round trip's own channel.
// `ipcMain` is injected rather than imported at module scope: `electron`
// provides no `ipcMain` export under `ELECTRON_RUN_AS_NODE=1`, so a static
// value import would fail this module at load time in the `main/*.test.ts` harness.

import type { IpcMain, IpcMainEvent } from 'electron';

const IPC_ESCAPE_HANDLED = 'tile:escape:handled';

const handledByWcId = new Map<number, boolean>();
let registered = false;

// The mirrored fact has exactly one writer — this receiver — and it fires
// only because an ask was sent (`windows.ts askWebContentsToHandleEscape`).
// Register the `tile:escape:handled` IPC receiver exactly once. Idempotent —
// safe to call from every dispatch-site wiring function.
export function initRendererHandledEscapeTracking(ipcMain: IpcMain): void {
  if (registered) return;
  registered = true;
  ipcMain.on(IPC_ESCAPE_HANDLED, (event: IpcMainEvent, handled: unknown) => {
    handledByWcId.set(event.sender.id, handled === true);
  });
}

// True iff the WC last reported that it consumed an Escape press.
export function rendererHandledEscapeForWc(wcId: number): boolean {
  return handledByWcId.get(wcId) === true;
}

// Drop cached state when a WC is destroyed, so a recycled id starts absent.
export function clearRendererHandledEscapeForWc(wcId: number): void {
  handledByWcId.delete(wcId);
}

// Test-only: set the cached state directly without the IPC round-trip.
export function __setRendererHandledEscapeForWcForTest(wcId: number, handled: boolean): void {
  handledByWcId.set(wcId, handled);
}

// Test-only: force `initRendererHandledEscapeTracking` to re-register.
export function __resetRendererHandledEscapeRegistrationForTest(): void {
  registered = false;
  handledByWcId.clear();
}

// Test-only: the channel name, so a test can drive it through a fake `ipcMain`.
export const __TEST_IPC_ESCAPE_HANDLED_CHANNEL = IPC_ESCAPE_HANDLED;
