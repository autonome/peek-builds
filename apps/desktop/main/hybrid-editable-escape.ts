/**
 * Pure decision logic for the hybrid page-host ESC editable guard
 * (see hybrid-editable-focus.ts for the cache that feeds it).
 *
 * Kept free of `electron` imports so it can be unit-tested under
 * `electron --test` without a real `ipcMain`.
 */

/** What the content preload reports about the focused element. */
export interface EditableFocusState {
  /** An editable element (input/textarea/contenteditable/...) is focused. */
  editable: boolean;
  /** The focused editable holds no text. Meaningless when `editable` is false. */
  empty: boolean;
}

export const NO_EDITABLE_FOCUS: EditableFocusState = { editable: false, empty: true };

/**
 * Coerce an untrusted `page:editable-focus` payload into a state. A bare
 * boolean (the older payload shape) is read as "editable with text" when true,
 * so an unknown fill level defers to the page rather than stealing ESC.
 */
export function normalizeEditableFocusReport(payload: unknown): EditableFocusState {
  if (payload === true) return { editable: true, empty: false };
  if (payload && typeof payload === 'object') {
    const p = payload as { editable?: unknown; empty?: unknown };
    if (p.editable === true) return { editable: true, empty: p.empty === true };
  }
  return NO_EDITABLE_FOCUS;
}

/**
 * ESC stays with the page only while an editable is focused AND holds text.
 * An empty field has nothing for ESC to clear, so it behaves as if nothing
 * were focused (opens the switcher).
 */
export function shouldDeferEscapeToEditable(state: EditableFocusState | undefined): boolean {
  return !!state && state.editable && !state.empty;
}
