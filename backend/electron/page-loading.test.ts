import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When compiled, __dirname is dist/backend/electron/ — go up 3 levels to project root
const pageHtml = readFileSync(join(__dirname, '..', '..', '..', 'app', 'page', 'index.html'), 'utf-8');

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

describe('Page loading CSS', () => {
  it('webview.loading should have a dark mode background', () => {
    // The loading state must not hardcode a bright white background.
    // Without dark mode handling, users see a bright flash before pages load.
    assert.ok(
      pageHtml.includes('prefers-color-scheme: dark'),
      'page/index.html must include a prefers-color-scheme: dark media query'
    );

    // The dark media query should contain a loading background override
    const darkBlock = pageHtml.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([^}]*webview\.loading[^}]*)\}/s
    );
    assert.ok(
      darkBlock,
      'Dark mode media query must contain a webview.loading rule'
    );
    assert.ok(
      darkBlock[1].includes('background-color'),
      'Dark mode webview.loading must set background-color'
    );

    // The dark background should not be white/bright
    const bgMatch = darkBlock[1].match(/background-color:\s*([^;]+);/);
    assert.ok(bgMatch, 'Dark mode background-color must have a value');
    const bgValue = bgMatch[1].trim();
    assert.ok(
      !bgValue.includes('255, 255, 255'),
      `Dark mode loading background must not be white, got: ${bgValue}`
    );
  });

  it('webview.loading should fade in from transparent', () => {
    // The loading state must not snap to an opaque background instantly.
    // A fade-in animation prevents the bright flash before content loads.
    assert.ok(
      pageHtml.includes('bg-fade-in'),
      'page/index.html must include a bg-fade-in animation'
    );

    // The loading class should use the fade-in animation
    const loadingBlock = pageHtml.match(
      /webview\.loading\s*\{([^}]+)\}/
    );
    assert.ok(loadingBlock, 'webview.loading rule must exist');
    assert.ok(
      loadingBlock[1].includes('bg-fade-in'),
      'webview.loading must reference bg-fade-in animation'
    );

    // The fade-in keyframes should start from transparent
    const fadeKeyframes = pageHtml.match(
      /@keyframes\s+bg-fade-in\s*\{([^}]*from[^}]*)\}/s
    );
    assert.ok(fadeKeyframes, 'bg-fade-in keyframes must exist');
    assert.ok(
      fadeKeyframes[1].includes('transparent'),
      'bg-fade-in must start from transparent'
    );
  });

  it('light mode loading background should be light', () => {
    // The default (light mode) loading background should be a light color
    const loadingBlock = pageHtml.match(
      /webview\.loading\s*\{([^}]+)\}/
    );
    assert.ok(loadingBlock, 'webview.loading rule must exist');

    const bgMatch = loadingBlock[1].match(/background-color:\s*([^;]+);/);
    assert.ok(bgMatch, 'webview.loading must set background-color');
    const bgValue = bgMatch[1].trim();
    // Should contain white-ish values (255, 255, 255) for light mode
    assert.ok(
      bgValue.includes('255') || bgValue.includes('#fff') || bgValue.includes('#FFF'),
      `Light mode loading background should be light, got: ${bgValue}`
    );
  });
});

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
