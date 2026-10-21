/**
 * Unit tests for the auto-update capability-expansion gate.
 *
 * This is the security boundary that stops a feature publisher from silently
 * broadening permissions via an "auto" update. The functions exercised here
 * (`compareCapabilities`, `compareSemver`, `evaluateUpdateGate`) are the
 * EXACT functions the `tile:features:update-apply` handler in tile-ipc.ts
 * calls — so a green test here means the live gate is verified, not a
 * divergent copy. (Before this, the gate had zero tests while a separate
 * renderer copy in features-manager/updater.js was the only thing covered.)
 *
 * Runs under Electron's Node host via `yarn test:unit` (or
 * `node --test dist/main/capability-compare.test.js`). No Electron runtime
 * APIs are touched — capability-compare.ts imports only a `type` from
 * tile-manifest.ts, which erases at runtime.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  compareCapabilities,
  compareSemver,
  evaluateUpdateGate,
} from './capability-compare.js';
import type { TileCapabilities } from './tile-manifest.js';

// Cast helper — the test fixtures are partial capability shapes.
const caps = (c: Record<string, unknown>): TileCapabilities => c as TileCapabilities;

// ─── compareSemver ──────────────────────────────────────────────────

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  });
  it('returns 1 / -1 across major, minor, patch', () => {
    assert.equal(compareSemver('2.0.0', '1.0.0'), 1);
    assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
    assert.equal(compareSemver('1.2.0', '1.1.0'), 1);
    assert.equal(compareSemver('1.0.2', '1.0.1'), 1);
  });
  it('treats missing version as 0.0.0', () => {
    assert.equal(compareSemver(null, '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0', null), 1);
    assert.equal(compareSemver(null, null), 0);
  });
});

// ─── compareCapabilities (migrated from updater.test.js — now tests the
//     real gate impl) ────────────────────────────────────────────────

describe('compareCapabilities', () => {
  it('reports identical capabilities as unchanged', () => {
    const c = caps({
      commands: true,
      network: { domains: ['api.example.com'] },
      pubsub: { scopes: ['global'], topics: ['foo:*'] },
    });
    const result = compareCapabilities(c, c);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
  });

  it('reports identical-by-value capabilities as unchanged', () => {
    const current = caps({ commands: true, network: { domains: ['api.example.com'] } });
    const next = caps({ commands: true, network: { domains: ['api.example.com'] } });
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
  });

  it('detects a removed network domain as reduced (not expanded)', () => {
    const current = caps({ network: { domains: ['api.example.com', 'cdn.example.com'] } });
    const next = caps({ network: { domains: ['api.example.com'] } });
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.some((r) => r.includes('cdn.example.com')));
  });

  it('detects an added network domain as expanded', () => {
    const current = caps({ network: { domains: ['api.example.com'] } });
    const next = caps({ network: { domains: ['api.example.com', 'evil.com'] } });
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('evil.com')));
  });

  it('detects an added page-automation origin as expanded', () => {
    const current = caps({ automation: { origins: ['https://bank.example'] } });
    const next = caps({ automation: { origins: ['https://bank.example', 'https://evil.example'] } });
    const result = compareCapabilities(current, next);
    assert.equal(result.expanded, true);
    assert.deepEqual(result.added, ['automation:https://evil.example']);
    assert.equal(compareCapabilities(caps({}), current).expanded, true);
  });

  it('detects an added boolean capability as expanded', () => {
    const result = compareCapabilities(caps({ commands: true }), caps({ commands: true, shortcuts: true }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.includes('shortcuts'));
  });

  it('detects a removed boolean capability as changed but not expanded', () => {
    const result = compareCapabilities(caps({ commands: true, shortcuts: true }), caps({ commands: true }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.includes('shortcuts'));
  });

  it('detects an entirely new capability type (filesystem) as expanded', () => {
    const result = compareCapabilities(caps({ commands: true }), caps({ commands: true, filesystem: { read: ['/tmp/*'] } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('filesystem')));
  });

  it('detects an added pubsub scope as expanded', () => {
    const result = compareCapabilities(caps({ pubsub: { scopes: ['global'] } }), caps({ pubsub: { scopes: ['global', 'system'] } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('system')));
  });

  it('detects a removed pubsub scope as changed but not expanded', () => {
    const result = compareCapabilities(caps({ pubsub: { scopes: ['global', 'system'] } }), caps({ pubsub: { scopes: ['global'] } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.some((r) => r.includes('system')));
  });

  it('detects an added datastore table as expanded', () => {
    const result = compareCapabilities(caps({ datastore: { tables: ['items'] } }), caps({ datastore: { tables: ['items', 'secrets'] } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('secrets')));
  });

  it('detects an added window sub-permission as expanded', () => {
    const result = compareCapabilities(caps({ window: { create: true } }), caps({ window: { create: true, manage: true } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('window.manage')));
  });

  it('detects a brand-new pubsub capability as expanded', () => {
    const result = compareCapabilities(caps({}), caps({ pubsub: { scopes: ['global'] } }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.includes('pubsub'));
  });

  it('detects a removed pubsub capability as changed but not expanded', () => {
    const result = compareCapabilities(caps({ pubsub: { scopes: ['global'] } }), caps({}));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.includes('pubsub'));
  });

  it('handles null/undefined inputs gracefully', () => {
    const result = compareCapabilities(null, null);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
  });

  it('treats null -> some capabilities as expanded', () => {
    const result = compareCapabilities(null, caps({ commands: true }));
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
  });

  it('treats some capabilities -> null as reduced (not expanded)', () => {
    const result = compareCapabilities(caps({ commands: true }), null);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
  });

  it('detects an added pubsub topic as expanded', () => {
    const result = compareCapabilities(
      caps({ pubsub: { scopes: ['global'], topics: ['foo:*'] } }),
      caps({ pubsub: { scopes: ['global'], topics: ['foo:*', 'bar:*'] } }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some((a) => a.includes('bar:*')));
  });

  it('handles complex mixed changes', () => {
    const current = caps({
      commands: true,
      shortcuts: true,
      network: { domains: ['api.old.com', 'cdn.old.com'] },
      pubsub: { scopes: ['global'] },
    });
    const next = caps({
      commands: true,
      // shortcuts removed
      network: { domains: ['api.old.com', 'api.new.com'] }, // cdn.old.com removed, api.new.com added
      pubsub: { scopes: ['global', 'system'] }, // system added
      filesystem: { read: ['/tmp/*'] }, // entirely new
    });
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.length >= 3); // api.new.com, pubsub system scope, filesystem
    assert.ok(result.removed.length >= 2); // shortcuts, cdn.old.com
  });

  // ── Superset coverage the OLD renderer copy missed entirely ──
  it('detects newly-requested oauth / session / rules as expanded (gate-only caps)', () => {
    for (const cap of ['oauth', 'session', 'rules', 'context', 'dialogs', 'features', 'theme']) {
      const result = compareCapabilities(caps({}), caps({ [cap]: true }));
      assert.equal(result.expanded, true, `${cap} turning on must be an expansion`);
      assert.ok(result.added.includes(cap), `${cap} should appear in added`);
    }
  });
});

// ─── evaluateUpdateGate — THE LIVE GATE DECISION ────────────────────
//
// These are the cases the task names: expanded+auto+no-approval BLOCKED,
// unchanged/reduced installs, expanded+approved installs, and version
// monotonicity. evaluateUpdateGate is exactly what the update-apply handler
// calls, so passing here means the handler's decision is verified.

describe('evaluateUpdateGate — auto-update privilege-escalation boundary', () => {
  const base = {
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    currentCapabilities: caps({ commands: true }),
  };

  it('BLOCKS an expanded update with no user approval (the silent-escalation case)', () => {
    const decision = evaluateUpdateGate({
      ...base,
      newCapabilities: caps({ commands: true, filesystem: { write: ['/etc/'] } }),
      userApproved: false,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'capabilities-expanded');
    if (decision.allow === false && decision.reason === 'capabilities-expanded') {
      assert.ok(decision.comparison.expanded);
      assert.ok(decision.comparison.added.some((a) => a.includes('filesystem')));
    }
  });

  it('BLOCKS an expanded update when userApproved is omitted (default = not approved)', () => {
    const decision = evaluateUpdateGate({
      ...base,
      newCapabilities: caps({ commands: true, network: { domains: ['evil.com'] } }),
    });
    assert.equal(decision.allow, false);
    assert.equal((decision as { reason: string }).reason, 'capabilities-expanded');
  });

  it('ALLOWS an expanded update when the user explicitly approved', () => {
    const decision = evaluateUpdateGate({
      ...base,
      newCapabilities: caps({ commands: true, filesystem: { write: ['/etc/'] } }),
      userApproved: true,
    });
    assert.equal(decision.allow, true);
  });

  it('ALLOWS an unchanged-capability update under auto (no approval needed)', () => {
    const decision = evaluateUpdateGate({
      ...base,
      newCapabilities: caps({ commands: true }),
      userApproved: false,
    });
    assert.equal(decision.allow, true);
    if (decision.allow) assert.equal(decision.comparison.expanded, false);
  });

  it('ALLOWS a reduced-capability update under auto (no approval needed)', () => {
    const decision = evaluateUpdateGate({
      currentVersion: '1.0.0',
      newVersion: '1.1.0',
      currentCapabilities: caps({ commands: true, shortcuts: true, network: { domains: ['a.com'] } }),
      newCapabilities: caps({ commands: true }),
      userApproved: false,
    });
    assert.equal(decision.allow, true);
    if (decision.allow) {
      assert.equal(decision.comparison.expanded, false);
      assert.equal(decision.comparison.changed, true);
    }
  });

  it('REJECTS a same-version update (version monotonicity)', () => {
    const decision = evaluateUpdateGate({
      currentVersion: '1.2.3',
      newVersion: '1.2.3',
      currentCapabilities: caps({ commands: true }),
      newCapabilities: caps({ commands: true }),
      userApproved: false,
    });
    assert.equal(decision.allow, false);
    assert.equal((decision as { reason: string }).reason, 'not-newer');
  });

  it('REJECTS an older-version (downgrade/replay) update even with approval', () => {
    const decision = evaluateUpdateGate({
      currentVersion: '2.0.0',
      newVersion: '1.9.9',
      currentCapabilities: caps({ commands: true }),
      newCapabilities: caps({ commands: true }),
      userApproved: true,
    });
    assert.equal(decision.allow, false);
    assert.equal((decision as { reason: string }).reason, 'not-newer');
  });

  it('checks version BEFORE capabilities: an older version with reduced caps is still rejected as not-newer', () => {
    const decision = evaluateUpdateGate({
      currentVersion: '2.0.0',
      newVersion: '1.0.0',
      currentCapabilities: caps({ commands: true, shortcuts: true }),
      newCapabilities: caps({ commands: true }),
      userApproved: false,
    });
    assert.equal(decision.allow, false);
    assert.equal((decision as { reason: string }).reason, 'not-newer');
  });

  it('treats a missing newVersion (0.0.0) against a real current version as not-newer', () => {
    const decision = evaluateUpdateGate({
      currentVersion: '1.0.0',
      newVersion: null,
      currentCapabilities: caps({ commands: true }),
      newCapabilities: caps({ commands: true }),
    });
    assert.equal(decision.allow, false);
    assert.equal((decision as { reason: string }).reason, 'not-newer');
  });
});
