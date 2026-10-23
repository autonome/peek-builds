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
  decideWebContentsIsolation,
  isolationRefusalMessage,
  unsafeWebPreferenceOverrides,
  runRefusedTeardown,
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

describe('isolation refusal — the verdict for a created webContents', () => {
  it('allows a type the policy does not check, whatever its prefs say', () => {
    assert.deepEqual(
      decideWebContentsIsolation({ type: 'backgroundPage', prefs: { nodeIntegration: true } }),
      { decision: 'allow' },
    );
  });

  it('allows a checked type whose prefs are safe', () => {
    assert.deepEqual(
      decideWebContentsIsolation({ type: 'window', prefs: { nodeIntegration: false, contextIsolation: true } }),
      { decision: 'allow' },
    );
  });

  it('asks for a navigation recheck when the prefs are not readable yet', () => {
    // Null prefs used to pass silently, which is how a violating surface could
    // run unchecked; the answer is now "no verdict yet", never "safe".
    assert.deepEqual(
      decideWebContentsIsolation({ type: 'window', prefs: null }),
      { decision: 'recheck-on-navigation' },
    );
  });

  it('refuses a checked type with a violation, naming every one', () => {
    assert.deepEqual(
      decideWebContentsIsolation({
        type: 'window',
        prefs: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
      }),
      {
        decision: 'refuse',
        violations: ['nodeIntegration=true', 'contextIsolation=false', 'webSecurity=false'],
      },
    );
  });

  it('refuses on a single violation', () => {
    assert.deepEqual(
      decideWebContentsIsolation({ type: 'browserView', prefs: { nodeIntegration: true } }),
      { decision: 'refuse', violations: ['nodeIntegration=true'] },
    );
  });
});

describe('isolation refusal — the logged line', () => {
  it('names the webContents, its type, its url and every violation', () => {
    const line = isolationRefusalMessage({
      id: 7,
      type: 'window',
      url: 'data:text/html,x',
      violations: ['nodeIntegration=true'],
    });
    assert.ok(line.startsWith('[SECURITY] '), `must stay greppable as [SECURITY]: ${line}`);
    assert.match(line, /webContents 7 \(type=window, url=data:text\/html,x\)/);
    assert.match(line, /violates isolation policy: nodeIntegration=true/);
  });

  it('stands in a placeholder for a webContents with no url yet', () => {
    const line = isolationRefusalMessage({ id: 2, type: 'window', url: '', violations: ['webSecurity=false'] });
    assert.match(line, /url=<no url yet>/);
  });
});

describe('window-open input — which webPreferences overrides are refused', () => {
  it('names nodeIntegration=true', () => {
    assert.deepEqual(unsafeWebPreferenceOverrides({ nodeIntegration: true }), ['nodeIntegration=true']);
  });

  it('names contextIsolation=false', () => {
    assert.deepEqual(unsafeWebPreferenceOverrides({ contextIsolation: false }), ['contextIsolation=false']);
  });

  it('names webSecurity=false', () => {
    assert.deepEqual(unsafeWebPreferenceOverrides({ webSecurity: false }), ['webSecurity=false']);
  });

  it('names sandbox=false — wider than the isolation check by this one setting', () => {
    assert.deepEqual(unsafeWebPreferenceOverrides({ sandbox: false }), ['sandbox=false']);
  });

  it('names all four together, in order', () => {
    assert.deepEqual(
      unsafeWebPreferenceOverrides({
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
        sandbox: false,
      }),
      ['nodeIntegration=true', 'contextIsolation=false', 'webSecurity=false', 'sandbox=false'],
    );
  });

  it('passes the safe settings — only an explicitly unsafe value is refused', () => {
    assert.deepEqual(
      unsafeWebPreferenceOverrides({
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        sandbox: true,
      }),
      [],
    );
  });

  it('passes empty, absent and non-object input', () => {
    // An absent key means the caller expressed no opinion, so Peek's own
    // defaults apply and there is nothing to refuse.
    assert.deepEqual(unsafeWebPreferenceOverrides({}), []);
    assert.deepEqual(unsafeWebPreferenceOverrides(null), []);
    assert.deepEqual(unsafeWebPreferenceOverrides(undefined), []);
    assert.deepEqual(unsafeWebPreferenceOverrides('nodeIntegration' as unknown as null), []);
  });
});

describe('runRefusedTeardown', () => {
  it('passes the attempt result through without logging', () => {
    for (const result of [true, false]) {
      const logged: string[] = [];
      assert.equal(runRefusedTeardown(() => result, 'webContents 7', (m) => logged.push(m)), result);
      assert.equal(logged.length, 0);
    }
  });

  it('logs a throw once and reports the teardown as done', () => {
    // true after a throw stops the caller retrying on every later navigation.
    const logged: string[] = [];
    const result = runRefusedTeardown(
      () => { throw new Error('Object has been destroyed'); },
      'webContents 7',
      (m) => logged.push(m),
    );
    assert.equal(result, true);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes('webContents 7'), logged[0]);
    assert.ok(logged[0].includes('Object has been destroyed'), logged[0]);
  });
});
