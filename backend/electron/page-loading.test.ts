import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When compiled, __dirname is dist/backend/electron/ — go up 3 levels to project root
const pageHtml = readFileSync(join(__dirname, '..', '..', '..', 'app', 'page', 'index.html'), 'utf-8');

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
