import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const polyfillsDir = join(__dirname, '..', '..', 'main', 'chrome-api-polyfills');
const modulePath = join(polyfillsDir, '_external-url.js');

const { isWebUrl, openExternalIfWebUrl } = await import(modulePath);

describe('chrome-api-polyfills/_external-url isWebUrl', () => {
  it('accepts http(s) URLs, case-insensitively', () => {
    assert.equal(isWebUrl('https://example.com/a?b=1'), true);
    assert.equal(isWebUrl('HTTP://example.com'), true);
  });

  it('refuses every other scheme', () => {
    assert.equal(isWebUrl('peek://groups/home.html'), false);
    assert.equal(isWebUrl('chrome-extension://abc/page.html'), false);
    assert.equal(isWebUrl('file:///etc/passwd'), false);
    assert.equal(isWebUrl('javascript:alert(1)'), false);
    assert.equal(isWebUrl('data:text/html,x'), false);
    assert.equal(isWebUrl('about:blank'), false);
  });

  it('refuses non-strings and strings that do not parse', () => {
    assert.equal(isWebUrl(''), false);
    assert.equal(isWebUrl(undefined), false);
    assert.equal(isWebUrl(42), false);
    assert.equal(isWebUrl('not a url'), false);
  });
});

describe('chrome-api-polyfills/_external-url openExternalIfWebUrl', () => {
  it('hands a web URL to the injected shell exactly once', () => {
    const shell = { openExternal: mock.fn() };
    const result = openExternalIfWebUrl(shell, 'https://example.com/a?b=1');
    assert.equal(result, true);
    assert.equal(shell.openExternal.mock.callCount(), 1);
    assert.deepEqual(shell.openExternal.mock.calls[0].arguments, ['https://example.com/a?b=1']);
  });

  it('hands a plain http URL to the shell too', () => {
    const shell = { openExternal: mock.fn() };
    assert.equal(openExternalIfWebUrl(shell, 'http://example.com/'), true);
    assert.equal(shell.openExternal.mock.callCount(), 1);
  });

  it('does not call the shell for a custom scheme', () => {
    const shell = { openExternal: mock.fn() };
    const result = openExternalIfWebUrl(shell, 'peek://groups/home.html');
    assert.equal(result, false);
    assert.equal(shell.openExternal.mock.callCount(), 0);
  });

  it('refuses every non-web scheme, so none of them reaches the OS', () => {
    // http(s) is the whole allowance. `file:` and `javascript:` have no
    // business at the default handler at all, and `peek:` / `chrome-extension:`
    // would re-enter the app through the OS, outside the tile path.
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'peek://groups/home.html',
      'chrome-extension://abc/page.html',
      'data:text/html,x',
      'about:blank',
    ]) {
      const shell = { openExternal: mock.fn() };
      assert.equal(openExternalIfWebUrl(shell, url), false, `${url} must be refused`);
      assert.equal(shell.openExternal.mock.callCount(), 0, `${url} must not reach the shell`);
    }
  });
});

// The create handler imports electron, so it cannot be loaded under `node --test`.
// Assert on its source instead that the gate is the only route to the OS.
describe('chrome-api-polyfills/tabs.js routes openExternal through the gate', () => {
  const source = readFileSync(join(polyfillsDir, 'tabs.js'), 'utf8');

  it('has no direct _shell.openExternal( call', () => {
    assert.equal(source.includes('_shell.openExternal('), false);
  });

  it('imports from ./_external-url.js', () => {
    assert.match(source, /from '\.\/_external-url\.js'/);
  });
});
