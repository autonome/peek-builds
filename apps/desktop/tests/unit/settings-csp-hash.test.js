import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// settings.html allowlists its inline importmap script in the CSP by sha256
// hash (see the comment beside the meta tag for the regeneration command),
// rather than 'unsafe-inline'. Nothing enforces that hash stays in sync with
// the importmap content — a future edit to the importmap that forgets to
// rerun the command leaves the CSP hash stale, and the importmap script is
// then silently blocked by the browser (peek-* components never upgrade, no
// thrown error). This test recomputes the hash the same way the regeneration
// command does and asserts it matches what's in the CSP meta tag, so drift
// fails a test run instead of failing silently in the browser.

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsHtmlPath = join(__dirname, '..', '..', 'renderer', 'settings', 'settings.html');

describe('settings.html CSP importmap hash', () => {
  it('matches the sha256 hash of the current importmap script content', () => {
    const html = readFileSync(settingsHtmlPath, 'utf8');

    const openTag = '<script type="importmap">';
    const start = html.indexOf(openTag) + openTag.length;
    assert.ok(start > openTag.length - 1, 'settings.html must contain an inline importmap script');
    const end = html.indexOf('</script>', start);
    assert.ok(end > start, 'importmap script must be closed');
    const importmapContent = html.slice(start, end);

    const computedHash = 'sha256-' + createHash('sha256').update(importmapContent, 'utf8').digest('base64');

    const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
    assert.ok(cspMatch, 'settings.html must have a Content-Security-Policy meta tag');
    const cspContent = cspMatch[1];

    assert.ok(
      cspContent.includes(computedHash),
      `CSP hash is stale — recompute it (see the comment above the importmap's closing </script> tag) ` +
        `and replace it in the CSP meta tag. Expected the CSP to contain ${computedHash}, got: ${cspContent}`
    );
  });
});
