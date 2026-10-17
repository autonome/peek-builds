/**
 * Editable-focus tracking for hybrid page-host content (peek 51798bae).
 *
 * The universal content preload (chrome-api-polyfills/runtime-external-preload.cjs)
 * reports, on every focus TRANSITION and every `input` inside an http(s) page,
 * whether an editable element is focused and whether it is empty — via
 * `ipcRenderer.send('page:editable-focus', { editable, empty })`.
 * This module caches that per content webContents so the hybrid ESC handler
 * (wireHybridContentEvents' before-input-event in ipc.ts) can make a synchronous,
 * deterministic decision: if an editable holding text is focused, ESC belongs to
 * the editing context and must NOT be stolen to open the Windows switcher; an
 * empty field behaves as if nothing were focused.
 *
 * Keyed by webContents.id (the content WC's own id) — that's exactly what the
 * before-input-event closure has in scope (`contentWC.id`) and what
 * `event.sender.id` is on the IPC, so no host-window mapping is needed.
 *
 * FSM-clean: no timers/polling. The boolean is a lifecycle state pushed on focus
 * transitions and read at ESC time.
 */
import { ipcMain } from 'electron';
import {
  normalizeEditableFocusReport,
  shouldDeferEscapeNow,
  type EditableFocusState,
} from './hybrid-editable-escape.js';

const editableByWcId = new Map<number, EditableFocusState>();
let registered = false;

/**
 * Register the `page:editable-focus` IPC receiver exactly once. Idempotent —
 * safe to call from every `wireHybridContentEvents` invocation.
 */
export function initHybridEditableFocusTracking(): void {
  if (registered) return;
  registered = true;
  ipcMain.on('page:editable-focus', (event, report: unknown) => {
    editableByWcId.set(event.sender.id, normalizeEditableFocusReport(report));
  });
}

/**
 * True iff ESC should stay with the page: the content WC last reported an
 * editable element focused AND holding text. An empty field defers nothing.
 * Always false while `DEFER_ESCAPE_TO_EDITABLE` is off.
 */
export function shouldDeferEscapeToPageForWc(wcId: number): boolean {
  return shouldDeferEscapeNow(editableByWcId.get(wcId));
}

/** Drop cached state when a content WC is destroyed. */
export function clearEditableFocusForWc(wcId: number): void {
  editableByWcId.delete(wcId);
}

/** Test-only: set the cached state directly without the IPC round-trip. */
export function __setEditableFocusForWcForTest(wcId: number, editable: boolean, empty = false): void {
  editableByWcId.set(wcId, { editable, empty });
}
