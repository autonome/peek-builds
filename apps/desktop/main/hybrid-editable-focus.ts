/**
 * Editable-focus tracking for hybrid page-host content (peek 51798bae).
 *
 * The universal content preload (chrome-api-polyfills/runtime-external-preload.cjs)
 * reports, on every focus TRANSITION inside an http(s) page, whether an editable
 * element is currently focused — via `ipcRenderer.send('page:editable-focus', bool)`.
 * This module caches that per content webContents so the hybrid ESC handler
 * (wireHybridContentEvents' before-input-event in ipc.ts) can make a synchronous,
 * deterministic decision: if an editable is focused, ESC belongs to the editing
 * context (blur/dismiss the field) and must NOT be stolen to open the Windows
 * switcher.
 *
 * Keyed by webContents.id (the content WC's own id) — that's exactly what the
 * before-input-event closure has in scope (`contentWC.id`) and what
 * `event.sender.id` is on the IPC, so no host-window mapping is needed.
 *
 * FSM-clean: no timers/polling. The boolean is a lifecycle state pushed on focus
 * transitions and read at ESC time.
 */
import { ipcMain } from 'electron';

const editableByWcId = new Map<number, boolean>();
let registered = false;

/**
 * Register the `page:editable-focus` IPC receiver exactly once. Idempotent —
 * safe to call from every `wireHybridContentEvents` invocation.
 */
export function initHybridEditableFocusTracking(): void {
  if (registered) return;
  registered = true;
  ipcMain.on('page:editable-focus', (event, editable: unknown) => {
    editableByWcId.set(event.sender.id, editable === true);
  });
}

/** True iff the content WC last reported an editable element focused. */
export function isEditableFocusedForWc(wcId: number): boolean {
  return editableByWcId.get(wcId) === true;
}

/** Drop cached state when a content WC is destroyed. */
export function clearEditableFocusForWc(wcId: number): void {
  editableByWcId.delete(wcId);
}

/** Test-only: set the cached state directly without the IPC round-trip. */
export function __setEditableFocusForWcForTest(wcId: number, editable: boolean): void {
  editableByWcId.set(wcId, editable);
}
