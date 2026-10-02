/**
 * Policy tests for the new-window security decisions in web-contents-policy.ts.
 *
 * These pin the three checks that keep a raw window from running with elevated
 * privileges: which webContents types get their isolation prefs checked, which
 * prefs count as a violation (and in which order the log line names them),
 * which types get the deny-all window.open fallback, and which schemes an
 * extension popup may route through Peek's window pipeline.
 *
 * Before this suite the only coverage was the launched-app Playwright spec
 * `tests/desktop/no-raw-browserwindow.spec.ts`, which reaches two of the
 * branches. Narrowing any list here now turns this suite red at the gate.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  isIsolationCheckedType,
  evaluateIsolationViolations,
  hasDefaultDenyWindowOpen,
  decideExtensionPopupOpen,
} from './web-contents-policy.js';

describe('isolation check — which webContents types are checked', () => {
  it('skips the Electron-managed types', () => {
    assert.equal(isIsolationCheckedType('backgroundPage'), false);
    assert.equal(isIsolationCheckedType('offscreen'), false);
  });

  it('checks the types Peek constructs, plus anything unrecognised', () => {
    for (const type of ['window', 'webview', 'browserView', 'remote']) {
      assert.equal(isIsolationCheckedType(type), true, `type=${type} must be checked`);
    }
  });
});

describe('isolation check — which prefs are violations', () => {
  it('names nodeIntegration=true', () => {
    assert.deepEqual(evaluateIsolationViolations({ nodeIntegration: true }), ['nodeIntegration=true']);
  });

  it('names contextIsolation=false', () => {
    assert.deepEqual(evaluateIsolationViolations({ contextIsolation: false }), ['contextIsolation=false']);
  });

  it('names webSecurity=false', () => {
    assert.deepEqual(evaluateIsolationViolations({ webSecurity: false }), ['webSecurity=false']);
  });

  it('names all three in the order the log line lists them', () => {
    assert.deepEqual(
      evaluateIsolationViolations({ nodeIntegration: true, contextIsolation: false, webSecurity: false }),
      ['nodeIntegration=true', 'contextIsolation=false', 'webSecurity=false'],
    );
  });

  it('passes null prefs (not readable yet) and empty prefs', () => {
    assert.deepEqual(evaluateIsolationViolations(null), []);
    assert.deepEqual(evaluateIsolationViolations({}), []);
  });

  it('passes the safe settings — only an explicitly wrong value is a violation', () => {
    assert.deepEqual(
      evaluateIsolationViolations({ nodeIntegration: false, contextIsolation: true, webSecurity: true }),
      [],
    );
  });
});

describe('default-deny window.open — which types get the fallback handler', () => {
  it('installs it on top-level windows and webview guests', () => {
    assert.equal(hasDefaultDenyWindowOpen('window'), true);
    assert.equal(hasDefaultDenyWindowOpen('webview'), true);
  });

  it('leaves every other type alone', () => {
    for (const type of ['browserView', 'remote', 'backgroundPage', 'offscreen']) {
      assert.equal(hasDefaultDenyWindowOpen(type), false, `type=${type} must not get the fallback`);
    }
  });
});

describe('extension popup window.open — which schemes route', () => {
  it('routes http and https through Peek', () => {
    assert.equal(decideExtensionPopupOpen('https://example.com'), 'route');
    assert.equal(decideExtensionPopupOpen('http://example.com/x'), 'route');
  });

  it('denies every other scheme', () => {
    for (const url of [
      'chrome-extension://abc/p.html',
      'data:text/html,x',
      'javascript:alert(1)',
      'blob:https://x/y',
      'about:blank',
      '',
    ]) {
      assert.equal(decideExtensionPopupOpen(url), 'deny', `${url || '<empty string>'} must be denied`);
    }
  });
});
