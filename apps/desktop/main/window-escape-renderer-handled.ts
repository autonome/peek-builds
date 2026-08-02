/**
 * The producer for `window-escape.ts EscapeKeyPress.rendererHandled` (peek
 * 7fffa286 companion) — "the renderer already consumed this Escape", mirrored
 * into main and read synchronously at keypress time.
 *
 * Before this module, that fact had no writer anywhere in the tree: the type
 * declared it, every dispatch site read it as permanently absent, and the
 * interpreter's `renderer-handled` outcome was structurally unreachable — see
 * `window-escape.ts`'s file docblock, "THE RENDERER ROUND TRIP IS GONE".
 *
 * Mechanism is copied from `hybrid-editable-focus.ts isEditableFocusedForWc`
 * (the closer of that file docblock's two precedents — same
 * `before-input-event` handler, same synchronous-read constraint): a plain
 * `Map<webContentsId, boolean>`, written by a renderer-initiated IPC send,
 * read synchronously with no round trip. No timers, no polling, no
 * per-keystroke ask.
 *
 * Real producer: `tile-preload.cts`'s `api.escape.onEscape` surface, which
 * already owns the "did this window's tile handle Escape?" question for the
 * tile-escape round trip. Its `escape-pressed` receiver now ALSO sends the
 * callback's answer to `tile:escape:handled` right after it answers the
 * round trip's `responseChannel`, so the cache holds that window's most
 * recently reported answer — real, not constructed, and requiring no new
 * per-tile opt-in beyond the existing `onEscape` registration.
 *
 * `ipcMain` is INJECTED rather than imported at module scope (unlike
 * `hybrid-editable-focus.ts`, which imports it directly and has no unit test
 * for exactly that reason — `electron` provides no `ipcMain` export under
 * `ELECTRON_RUN_AS_NODE=1`, so a static value import fails the whole module at
 * load time in the `main/*.test.ts` harness). The injection mirrors
 * `chrome-api-polyfills/runtime-external.ts setupMainProcess(session,
 * { ipcMain })` — an existing precedent in this tree for the same constraint —
 * and is what makes `window-escape-renderer-handled.test.ts` possible at all.
 */
import type { IpcMain, IpcMainEvent } from 'electron';

const IPC_ESCAPE_HANDLED = 'tile:escape:handled';

const handledByWcId = new Map<number, boolean>();
let registered = false;

/**
 * Register the `tile:escape:handled` IPC receiver exactly once. Idempotent —
 * safe to call from every dispatch-site wiring function.
 */
export function initRendererHandledEscapeTracking(ipcMain: IpcMain): void {
  if (registered) return;
  registered = true;
  ipcMain.on(IPC_ESCAPE_HANDLED, (event: IpcMainEvent, handled: unknown) => {
    handledByWcId.set(event.sender.id, handled === true);
  });
}

/** True iff the WC last reported that it consumed an Escape press. */
export function rendererHandledEscapeForWc(wcId: number): boolean {
  return handledByWcId.get(wcId) === true;
}

/** Drop cached state when a WC is destroyed, so a recycled id starts absent. */
export function clearRendererHandledEscapeForWc(wcId: number): void {
  handledByWcId.delete(wcId);
}

/** Test-only: set the cached state directly without the IPC round-trip. */
export function __setRendererHandledEscapeForWcForTest(wcId: number, handled: boolean): void {
  handledByWcId.set(wcId, handled);
}

/** Test-only: force `initRendererHandledEscapeTracking` to re-register. */
export function __resetRendererHandledEscapeRegistrationForTest(): void {
  registered = false;
  handledByWcId.clear();
}

/** Test-only: the channel name, so a test can drive it through a fake `ipcMain`. */
export const __TEST_IPC_ESCAPE_HANDLED_CHANNEL = IPC_ESCAPE_HANDLED;
