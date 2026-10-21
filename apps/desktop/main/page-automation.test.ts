/**
 * Unit tests for page automation (page-automation.ts): the manifest shape the
 * capabilities package accepts, the gate `tile:automation:run` applies, and
 * the operations run against a fake webContents. The page scripts built for
 * waitFor and click are run against a tiny fake `document` so their logic is
 * exercised, not just their presence.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import vm from 'node:vm';

import {
  buildClickScript,
  buildWaitForSelectorScript,
  checkAutomationAllowed,
  isAutomationOriginAllowed,
  parseAutomationOp,
  runAutomationOp,
  tileWindowSource,
  type AutomationTarget,
} from './page-automation.js';
import { resolveCapabilities, validateTileManifest, type CapabilityGrant } from './tile-manifest.js';

function grantWith(origins: string[] | null, tileId = 'fixture'): CapabilityGrant {
  return {
    tileId,
    capabilities: origins ? { automation: { origins } } : {},
    denied: [],
  } as unknown as CapabilityGrant;
}

const OWN = tileWindowSource('fixture');

function manifestWith(automation: unknown): Record<string, unknown> {
  return {
    id: 'fixture',
    name: 'Fixture',
    manifestVersion: 3,
    tiles: [{ id: 'main', url: 'peek://fixture/main.html' }],
    capabilities: { automation },
  };
}

/** A fake page: `elements` are the selectors that match, `script` evaluates in a sandbox with that document. */
function fakeTarget(opts: {
  url?: string;
  elements?: string[];
  loadURL?: (url: string) => Promise<void>;
  printToPDF?: () => Promise<Uint8Array>;
} = {}): AutomationTarget & { clicked: string[]; gestures: boolean[]; current: string } {
  const clicked: string[] = [];
  const gestures: boolean[] = [];
  const state = {
    current: opts.url ?? 'https://bank.example/home',
    clicked,
    gestures,
    getURL: () => state.current,
    getTitle: () => 'Fake page',
    isDestroyed: () => false,
    loadURL: opts.loadURL ?? (async (url: string) => { state.current = url; }),
    printToPDF: opts.printToPDF ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    executeJavaScript: async (code: string, userGesture?: boolean) => {
      gestures.push(!!userGesture);
      const elements = new Set(opts.elements ?? []);
      const document = {
        querySelector: (sel: string) => elements.has(sel)
          ? { scrollIntoView: () => {}, click: () => { clicked.push(sel); } }
          : null,
      };
      return vm.runInNewContext(code, { document, setTimeout, Date, Promise });
    },
  };
  return state;
}

describe('automation capability in the manifest', () => {
  it('accepts exact and wildcard origins and grants them to a non-builtin feature', () => {
    const automation = { origins: ['https://bank.example', 'https://*.mail.example', 'http://localhost:8080'] };
    assert.deepStrictEqual(validateTileManifest(manifestWith(automation)), []);
    const grant = resolveCapabilities('fixture', { automation } as never, false);
    assert.deepStrictEqual(grant.capabilities.automation, automation);
    assert.deepStrictEqual(grant.denied, []);
  });

  it('rejects origins with paths, non-http schemes, wildcard http and empty lists', () => {
    for (const bad of [
      { origins: ['https://bank.example/statements'] },
      { origins: ['file:///etc'] },
      { origins: ['http://*.bank.example'] },
      { origins: ['*'] },
      { origins: [] },
      true,
    ]) {
      const errors = validateTileManifest(manifestWith(bad));
      assert.ok(errors.some(e => e.path.startsWith('capabilities.automation')), `expected an error for ${JSON.stringify(bad)}`);
    }
  });
});

describe('isAutomationOriginAllowed', () => {
  const grant = grantWith(['https://bank.example', 'https://*.mail.example']);

  it('matches exact origins on any path, and subdomains of a wildcard', () => {
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://bank.example/a/b?c=1'), true);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://app.mail.example/inbox'), true);
  });

  it('rejects other hosts, schemes, ports and the bare wildcard host', () => {
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://evil.example/'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'http://bank.example/'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://bank.example:8443/'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://bank.example.evil.example/'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'https://mail.example/'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'peek://fixture/main.html'), false);
    assert.strictEqual(isAutomationOriginAllowed(grant, 'not a url'), false);
  });

  it('rejects everything without the capability', () => {
    assert.strictEqual(isAutomationOriginAllowed(grantWith(null), 'https://bank.example/'), false);
  });
});

describe('checkAutomationAllowed', () => {
  const grant = grantWith(['https://bank.example']);

  it('refuses a tile without the capability', () => {
    const r = checkAutomationAllowed(grantWith(null), { op: 'url' }, { windowSource: OWN, currentUrl: 'about:blank' });
    assert.strictEqual(r.ok, false);
  });

  it('refuses a window another tile, or the user, opened', () => {
    for (const windowSource of [tileWindowSource('other'), undefined]) {
      const r = checkAutomationAllowed(grant, { op: 'url' }, { windowSource, currentUrl: 'https://bank.example/' });
      assert.deepStrictEqual(r, { ok: false, error: 'window was not opened by this tile' });
    }
  });

  it('lets url run on any origin, so a login redirect can be noticed', () => {
    const r = checkAutomationAllowed(grant, { op: 'url' }, { windowSource: OWN, currentUrl: 'https://login.other.example/' });
    assert.strictEqual(r.ok, true);
  });

  it('gates navigate on the destination, not the current page', () => {
    const from = { windowSource: OWN, currentUrl: 'about:blank' };
    assert.strictEqual(checkAutomationAllowed(grant, { op: 'navigate', url: 'https://bank.example/x' }, from).ok, true);
    assert.strictEqual(checkAutomationAllowed(grant, { op: 'navigate', url: 'https://evil.example/' }, from).ok, false);
  });

  it('gates scripting on the current page origin, blank pages included', () => {
    const op = { op: 'eval', script: '1' } as const;
    assert.strictEqual(checkAutomationAllowed(grant, op, { windowSource: OWN, currentUrl: 'https://bank.example/s' }).ok, true);
    assert.strictEqual(checkAutomationAllowed(grant, op, { windowSource: OWN, currentUrl: 'https://login.other.example/' }).ok, false);
    assert.strictEqual(checkAutomationAllowed(grant, op, { windowSource: OWN, currentUrl: 'about:blank' }).ok, false);
  });
});

describe('page scripts', () => {
  it('waitFor resolves true for a present element and false after its timeout', async () => {
    const t = fakeTarget({ elements: ['#export'] });
    assert.strictEqual(await t.executeJavaScript(buildWaitForSelectorScript('#export', 1000)), true);
    assert.strictEqual(await t.executeJavaScript(buildWaitForSelectorScript('#missing', 150)), false);
  });

  it('click clicks the match and reports a miss; selectors are quoted, not spliced', async () => {
    const t = fakeTarget({ elements: ['button[data-x="a\'b"]'] });
    assert.strictEqual(await t.executeJavaScript(buildClickScript('button[data-x="a\'b"]')), true);
    assert.deepStrictEqual(t.clicked, ['button[data-x="a\'b"]']);
    assert.strictEqual(await t.executeJavaScript(buildClickScript('#nope')), false);
  });
});

describe('runAutomationOp', () => {
  it('navigates and reports the final URL', async () => {
    const t = fakeTarget({ url: 'about:blank' });
    const r = await runAutomationOp(t, { op: 'navigate', url: 'https://bank.example/statements' });
    assert.deepStrictEqual(r, { ok: true, url: 'https://bank.example/statements', title: 'Fake page' });
  });

  it('clicks as a user gesture and fails cleanly when nothing matches', async () => {
    const t = fakeTarget({ elements: ['#csv'] });
    assert.strictEqual((await runAutomationOp(t, { op: 'click', selector: '#csv' })).ok, true);
    assert.deepStrictEqual(t.gestures, [true]);
    const miss = await runAutomationOp(t, { op: 'click', selector: '#pdf' });
    assert.strictEqual(miss.ok, false);
  });

  it('returns eval values and waitFor misses', async () => {
    const t = fakeTarget();
    const r = await runAutomationOp(t, { op: 'eval', script: '[1, 2].map(n => n * 2)' });
    assert.ok(r.ok);
    // The fake page runs in a vm context, so compare across realms by value.
    assert.strictEqual(JSON.stringify(r.ok && r.value), '[2,4]');
    const miss = await runAutomationOp(t, { op: 'waitFor', selector: '#later', timeoutMs: 150 });
    assert.strictEqual(miss.ok, false);
  });

  it('returns printToPDF bytes', async () => {
    const r = await runAutomationOp(fakeTarget(), { op: 'printToPDF' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.ok && Array.from(r.pdf ?? []), [0x25, 0x50, 0x44, 0x46]);
  });

  it('turns a hung navigation into a timeout error instead of hanging', async () => {
    const t = fakeTarget({ loadURL: () => new Promise<void>(() => {}) });
    const r = await runAutomationOp(t, { op: 'navigate', url: 'https://bank.example/', timeoutMs: 50 });
    assert.strictEqual(r.ok, false);
    assert.match(r.ok ? '' : r.error, /timed out/);
  });
});

describe('parseAutomationOp', () => {
  it('accepts well-formed ops and rejects malformed ones', () => {
    assert.deepStrictEqual(parseAutomationOp({ op: 'click', selector: '#a' }), { op: 'click', selector: '#a', timeoutMs: undefined });
    assert.strictEqual(parseAutomationOp({ op: 'click' }), null);
    assert.strictEqual(parseAutomationOp({ op: 'navigate', url: 5 }), null);
    assert.strictEqual(parseAutomationOp({ op: 'rm -rf' }), null);
    assert.strictEqual(parseAutomationOp(null), null);
  });
});
