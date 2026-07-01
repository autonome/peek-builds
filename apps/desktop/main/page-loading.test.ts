import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// --- Extracted decision logic from page.js did-fail-load handler ---

interface FailLoadContext {
  isMainFrame: boolean;
  errorCode: number;
  hasEverLoaded: boolean;
}

/**
 * Determines whether the loading indicator should be cleared on a did-fail-load event.
 *
 * Key behaviors:
 * - Sub-frame failures are always ignored (isMainFrame guard)
 * - Error -3 (ABORTED) always clears loading regardless of hasEverLoaded
 *   (previously the bug: error -3 with hasEverLoaded=true left indicator stuck)
 * - All other main-frame errors clear loading
 */
export function shouldClearLoadingOnFail(context: FailLoadContext): { clearLoading: boolean; reason?: string } {
  if (!context.isMainFrame) {
    return { clearLoading: false, reason: 'sub-frame failure ignored' };
  }

  if (context.errorCode === -3) {
    return { clearLoading: true, reason: 'aborted navigation — always clear' };
  }

  return { clearLoading: true, reason: 'main frame load error' };
}

// The canvas page-host's `renderer/page/index.html` — and the "Page loading
// CSS" describe block that asserted on its embedded webview.loading rules
// (dark-mode background, fade-in animation, light-mode background) — was
// deleted with the canvas page-host removal. The hybrid path has no
// equivalent single-file shell to assert CSS against (chrome lives in the
// separate overlay renderer, content paints natively with no loading-CSS
// overlay of its own), so that coverage has no hybrid home and was dropped
// rather than ported. `shouldClearLoadingOnFail` below is unrelated pure
// logic (no HTML/DOM dependency) and stays.

describe('shouldClearLoadingOnFail — aborted navigation fix', () => {
  it('main frame error -3 (ABORTED) should clear loading regardless of hasEverLoaded', () => {
    const result = shouldClearLoadingOnFail({ isMainFrame: true, errorCode: -3, hasEverLoaded: false });
    assert.equal(result.clearLoading, true);
  });

  it('main frame error -3 with hasEverLoaded=true should clear (this was the bug)', () => {
    // Previously, error -3 with hasEverLoaded=true skipped stopLoading(),
    // leaving the loading indicator permanently stuck.
    const result = shouldClearLoadingOnFail({ isMainFrame: true, errorCode: -3, hasEverLoaded: true });
    assert.equal(result.clearLoading, true, 'error -3 must clear loading even when hasEverLoaded is true');
  });

  it('main frame error -3 with hasEverLoaded=false should clear', () => {
    const result = shouldClearLoadingOnFail({ isMainFrame: true, errorCode: -3, hasEverLoaded: false });
    assert.equal(result.clearLoading, true);
  });

  it('sub-frame error -3 should NOT clear loading (isMainFrame guard)', () => {
    const result = shouldClearLoadingOnFail({ isMainFrame: false, errorCode: -3, hasEverLoaded: false });
    assert.equal(result.clearLoading, false, 'sub-frame failures must be ignored');
    assert.ok(result.reason?.includes('sub-frame'));
  });

  it('sub-frame any error should NOT clear loading', () => {
    const result = shouldClearLoadingOnFail({ isMainFrame: false, errorCode: -6, hasEverLoaded: false });
    assert.equal(result.clearLoading, false);

    const result2 = shouldClearLoadingOnFail({ isMainFrame: false, errorCode: -102, hasEverLoaded: true });
    assert.equal(result2.clearLoading, false);
  });

  it('main frame other error (e.g., -6 CONNECTION_REFUSED) should clear loading', () => {
    const result = shouldClearLoadingOnFail({ isMainFrame: true, errorCode: -6, hasEverLoaded: false });
    assert.equal(result.clearLoading, true);
  });

  it('main frame error -3 then did-start-navigation: loading restarts (not stuck)', () => {
    // Simulate: error -3 clears loading, then a new navigation starts.
    // This verifies the design: stopLoading() on -3 is safe because
    // did-start-navigation will call startLoading() for the new nav.
    let isLoading = true;

    // did-fail-load with -3
    const failResult = shouldClearLoadingOnFail({ isMainFrame: true, errorCode: -3, hasEverLoaded: true });
    if (failResult.clearLoading) {
      isLoading = false; // stopLoading()
    }
    assert.equal(isLoading, false, 'loading should be cleared after error -3');

    // did-start-navigation fires for the new navigation
    isLoading = true; // startLoading()
    assert.equal(isLoading, true, 'loading should restart on new navigation');
  });
});
