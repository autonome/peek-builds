/**
 * createVisibilityGate(refreshFn, { doc } = {})
 *
 * Wraps a refresh function so that it is deferred when the document is
 * hidden (the tile's window is backgrounded or occluded).
 *
 * Returns { gated, destroy }.
 *
 * gated():
 *   - If doc.hidden → set a dirty flag, return without calling refreshFn.
 *   - If !doc.hidden → call refreshFn() immediately.
 *
 * On visibilitychange (tab/window becomes visible again) while dirty:
 *   - Clears the dirty flag and calls refreshFn() exactly once.
 *
 * destroy():
 *   - Removes the visibilitychange listener (call when the tile tears down).
 *   - Clears the dirty flag.
 *
 * --- Dependency injection for testability ---
 * Pass a fake `doc` object with { hidden, addEventListener, removeEventListener,
 * and a way to emit 'visibilitychange' } to drive the gate from unit tests
 * without a browser environment.
 *
 * `doc` defaults to globalThis.document. If no document is available (and none
 * is injected), gated() becomes a transparent passthrough so callers work
 * unchanged in non-browser contexts.
 */
export const createVisibilityGate = (refreshFn, { doc } = {}) => {
  const docRef = doc ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : null);

  // Non-browser context with no injection: passthrough, no gating.
  if (!docRef || typeof docRef.addEventListener !== 'function') {
    return {
      gated: refreshFn,
      destroy: () => {},
    };
  }

  let dirty = false;

  const onVisibilityChange = () => {
    if (!docRef.hidden && dirty) {
      dirty = false;
      refreshFn();
    }
  };

  docRef.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /**
     * Call instead of refreshFn from pubsub-driven refresh paths.
     * When hidden, defers the refresh; when visible, runs immediately.
     */
    gated: () => {
      if (docRef.hidden) {
        dirty = true;
        return;
      }
      refreshFn();
    },

    /**
     * Remove the visibilitychange listener. Call when the tile or
     * live-query handle is destroyed.
     */
    destroy: () => {
      docRef.removeEventListener('visibilitychange', onVisibilityChange);
      dirty = false;
    },
  };
};
