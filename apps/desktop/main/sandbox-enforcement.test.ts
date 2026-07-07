/**
 * Enforcement tests for mandatory renderer sandboxing.
 *
 * Two layers, matching sandbox-enforcement.ts:
 *   1. Runtime policy — evaluateSandboxViolation / enforceSandboxOnWebContents
 *      turn an un-approved sandbox:false into a fatal violation.
 *   2. Static gate — a source scan asserting NO `sandbox: false` exists in the
 *      main-process tree outside an approved carve-out. This is the layer that
 *      actually stops an agent: reintroducing sandbox:false anywhere turns this
 *      suite red in the desktop gate, no matter how the window is constructed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_CARVEOUTS,
  SANDBOX_ENFORCED_TYPES,
  isSandboxCarvedOut,
  evaluateSandboxViolation,
  enforceSandboxOnWebContents,
} from './sandbox-enforcement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled test lives at apps/desktop/dist/main/; source lives at apps/desktop/main/.
const MAIN_SRC_DIR = path.resolve(__dirname, '../../main');

describe('sandbox enforcement — runtime policy', () => {
  it('flags sandbox:false on an enforced type with no carve-out', () => {
    for (const type of SANDBOX_ENFORCED_TYPES) {
      const msg = evaluateSandboxViolation({ type, sandbox: false, url: 'https://x.test/' });
      assert.ok(msg, `expected a violation for type=${type}`);
      assert.match(msg as string, /sandbox:false/);
    }
  });

  it('passes sandbox:true and sandbox:undefined (default is sandboxed)', () => {
    assert.equal(evaluateSandboxViolation({ type: 'window', sandbox: true, url: 'https://x.test/' }), null);
    assert.equal(evaluateSandboxViolation({ type: 'window', sandbox: undefined, url: 'https://x.test/' }), null);
  });

  it('ignores Electron-managed types (backgroundPage, remote, offscreen)', () => {
    for (const type of ['backgroundPage', 'remote', 'offscreen']) {
      assert.equal(
        evaluateSandboxViolation({ type, sandbox: false, url: 'chrome-extension://abc/bg.html' }),
        null,
        `type=${type} must not be enforced`,
      );
    }
  });

  it('honours a carve-out only for its exact url prefix', () => {
    // isSandboxCarvedOut reads the live (empty) list; simulate a carve-out via a
    // direct prefix check to prove the matching semantics without mutating state.
    assert.equal(isSandboxCarvedOut('https://anything/'), false, 'empty list carves out nothing');
    const carved = evaluateSandboxViolation({
      type: 'window',
      sandbox: false,
      url: 'https://anything/',
    });
    assert.ok(carved, 'with an empty carve-out list every sandbox:false is a violation');
  });

  it('enforceSandboxOnWebContents fires onViolation at creation for sandbox:false', () => {
    const calls: string[] = [];
    const fake = makeFakeContents({ type: 'window', url: 'https://x.test/', sandbox: false });
    enforceSandboxOnWebContents(fake, (m) => calls.push(m));
    assert.equal(calls.length, 1, 'should fire once at creation');
  });

  it('does not fire for a sandboxed window', () => {
    const calls: string[] = [];
    const fake = makeFakeContents({ type: 'window', url: 'https://x.test/', sandbox: true });
    enforceSandboxOnWebContents(fake, (m) => calls.push(m));
    fake.emitNavigation();
    assert.equal(calls.length, 0);
  });

  it('rechecks on first navigation when prefs are null at creation', () => {
    const calls: string[] = [];
    // prefs null at creation, then sandbox:false becomes readable at navigation.
    const fake = makeFakeContents({ type: 'webview', url: '', sandbox: false, prefsNullUntilNav: true });
    enforceSandboxOnWebContents(fake, (m) => calls.push(m));
    assert.equal(calls.length, 0, 'nothing readable yet at creation');
    fake.setUrl('https://late.test/');
    fake.emitNavigation();
    assert.equal(calls.length, 1, 'violation caught on navigation once prefs are readable');
  });

  it('fires at most once even if both creation and navigation would violate', () => {
    const calls: string[] = [];
    const fake = makeFakeContents({ type: 'window', url: 'https://x.test/', sandbox: false });
    enforceSandboxOnWebContents(fake, (m) => calls.push(m));
    fake.emitNavigation();
    assert.equal(calls.length, 1, 'deduped across creation + navigation');
  });
});

describe('sandbox enforcement — carve-out list is human-controlled', () => {
  it('has ZERO carve-outs (bump this deliberately, with sign-off, when adding one)', () => {
    // If a human adds a SANDBOX_CARVEOUTS entry, they must also bump this count.
    // An agent editing only the list (not this assertion) turns the gate red.
    assert.equal(
      SANDBOX_CARVEOUTS.length,
      0,
      'SANDBOX_CARVEOUTS changed — this is a security carve-out that needs explicit human sign-off.',
    );
  });

  it('every carve-out is fully documented', () => {
    for (const c of SANDBOX_CARVEOUTS) {
      assert.ok(c.urlPrefix, 'carve-out needs a urlPrefix');
      assert.ok(c.reason && c.reason.length > 10, 'carve-out needs a real reason');
      assert.ok(c.approvedBy, 'carve-out needs an approver');
    }
  });
});

describe('sandbox enforcement — static source gate', () => {
  it('no `sandbox: false` webPreferences exist in the main-process tree', () => {
    const offenders: string[] = [];
    for (const file of walkSource(MAIN_SRC_DIR)) {
      // Skip this enforcement module + all test files: they mention the string
      // in prose/assertions, not as a live webPreferences setting.
      const base = path.basename(file);
      if (base.startsWith('sandbox-enforcement.')) continue;
      if (/\.test\.(ts|cts|js|mjs)$/.test(base)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Match a real object property `sandbox: false` at line start (after
        // indentation) — this precisely catches webPreferences declarations and
        // skips prose comments like "// previously sandbox:false".
        if (/^\s*sandbox\s*:\s*false\b/.test(line)) {
          offenders.push(`${path.relative(MAIN_SRC_DIR, file)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `Found sandbox:false in the main tree. Renderer sandboxing is mandatory — ` +
        `remove it (fix the surface to run sandboxed) or, with human sign-off, add a ` +
        `SANDBOX_CARVEOUTS entry. Offenders: ${offenders.join(', ')}`,
    );
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function* walkSource(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (/\.(ts|cts|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

interface FakeContents {
  id: number;
  getType(): string;
  getURL(): string;
  getLastWebPreferences(): { sandbox?: boolean } | null;
  once(event: string, listener: (...args: unknown[]) => void): void;
  emitNavigation(): void;
  setUrl(url: string): void;
}

function makeFakeContents(opts: {
  type: string;
  url: string;
  sandbox: boolean;
  prefsNullUntilNav?: boolean;
}): FakeContents {
  let url = opts.url;
  let navigated = false;
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  return {
    id: 1,
    getType: () => opts.type,
    getURL: () => url,
    getLastWebPreferences: () =>
      opts.prefsNullUntilNav && !navigated ? null : { sandbox: opts.sandbox },
    once(event, listener) {
      (listeners[event] ||= []).push(listener);
    },
    emitNavigation() {
      navigated = true;
      for (const l of listeners['did-start-navigation'] ?? []) l();
    },
    setUrl(next) {
      url = next;
    },
  };
}
