/**
 * Unit tests for strict `tile:session:*` capability enforcement.
 *
 * Covers `checkSessionAllowed` used by `tile:session:save-workspace-snapshot`.
 * The `session` capability is declared as a boolean — no sub-flags
 * for now, so all session ops require the same grant.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkSessionAllowed } from './tile-session-enforcement.js';
import { DEFAULT_WORKSPACE_KEY } from './session-projection.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

describe('checkSessionAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkSessionAllowed(null, 'save-workspace-snapshot');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no session capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkSessionAllowed(grant, 'save-workspace-snapshot');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /session capability not granted/i);
    }
  });

  it('rejects when session capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { session: false as unknown as boolean },
      denied: [],
    };
    const result = checkSessionAllowed(grant, 'save-workspace-snapshot');
    assert.strictEqual(result.ok, false);
  });
});

describe('checkSessionAllowed — session: true', () => {
  it('allows save-workspace-snapshot when session is true', () => {
    const grant = makeGrant({ session: true });
    const result = checkSessionAllowed(grant, 'save-workspace-snapshot');
    assert.strictEqual(result.ok, true);
  });

  it('allows restore-workspace-snapshot when session is true', () => {
    const grant = makeGrant({ session: true });
    const result = checkSessionAllowed(grant, 'restore-workspace-snapshot');
    assert.strictEqual(result.ok, true);
  });

  it('allows begin-workspace-switch and set-active-workspace when session is true', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'begin-workspace-switch').ok, true);
    assert.strictEqual(checkSessionAllowed(grant, 'set-active-workspace').ok, true);
  });

  it('allows get-workspace-snapshot-info for a named workspace key', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'get-workspace-snapshot-info', { key: 'tag-42' }).ok, true);
  });
});

describe('checkSessionAllowed — the default workspace\'s own snapshot is never readable', () => {
  // `get-workspace-snapshot-info` exists so a feature can read a NAMED
  // workspace's layout without a foreign-settings grant that would also expose
  // the app's whole last-quit window list (the default row). The refusal is a
  // rule about the argument, enforced here for every caller — not a check a
  // handler has to remember.
  it('refuses the default key even with the session capability', () => {
    const grant = makeGrant({ session: true });
    const result = checkSessionAllowed(grant, 'get-workspace-snapshot-info', { key: DEFAULT_WORKSPACE_KEY });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /default workspace/i);
  });

  it('refuses the default key for a trustedBuiltin grant too', () => {
    const grant = makeGrant({ session: true }, true);
    assert.strictEqual(checkSessionAllowed(grant, 'get-workspace-snapshot-info', { key: DEFAULT_WORKSPACE_KEY }).ok, false);
  });

  it('the rule is specific to that op — the default key is a valid save/restore/set-active target', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'save-workspace-snapshot', { key: DEFAULT_WORKSPACE_KEY }).ok, true);
    assert.strictEqual(checkSessionAllowed(grant, 'restore-workspace-snapshot', { key: DEFAULT_WORKSPACE_KEY }).ok, true);
    assert.strictEqual(checkSessionAllowed(grant, 'set-active-workspace', { key: DEFAULT_WORKSPACE_KEY }).ok, true);
  });
});

describe('checkSessionAllowed — get-workspace-snapshot-window-count', () => {
  // Reports only how many windows a workspace's snapshot holds, so unlike the
  // layout read it may answer for the default workspace (no URLs are exposed).
  it('answers for the default key and named keys with the session capability', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'get-workspace-snapshot-window-count', { key: DEFAULT_WORKSPACE_KEY }).ok, true);
    assert.strictEqual(checkSessionAllowed(grant, 'get-workspace-snapshot-window-count', { key: 'tag-42' }).ok, true);
  });

  it('refuses without the session capability', () => {
    const grant = makeGrant({});
    assert.strictEqual(checkSessionAllowed(grant, 'get-workspace-snapshot-window-count', { key: 'tag-42' }).ok, false);
  });
});

describe('checkSessionAllowed — add-window-to-workspace-snapshot', () => {
  // A write-only op: it appends one window to a workspace's row and returns no URLs.
  it('is allowed for named keys and the default key with the session capability', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'add-window-to-workspace-snapshot', { key: 'tag-42' }).ok, true);
    assert.strictEqual(checkSessionAllowed(grant, 'add-window-to-workspace-snapshot', { key: DEFAULT_WORKSPACE_KEY }).ok, true);
  });

  it('refuses without the session capability', () => {
    const grant = makeGrant({});
    assert.strictEqual(checkSessionAllowed(grant, 'add-window-to-workspace-snapshot', { key: 'tag-42' }).ok, false);
  });
});

describe('checkSessionAllowed — merge-workspace-snapshot', () => {
  // Moves a deleted space's saved windows into another workspace's row.
  it('is allowed from a named key into the default key with the session capability', () => {
    const grant = makeGrant({ session: true });
    assert.strictEqual(checkSessionAllowed(grant, 'merge-workspace-snapshot', { key: 'tag-42' }).ok, true);
  });

  it('never merges the default workspace away, even for a trusted caller', () => {
    const trusted = makeGrant({}, true);
    assert.strictEqual(checkSessionAllowed(trusted, 'merge-workspace-snapshot', { key: DEFAULT_WORKSPACE_KEY }).ok, false);
  });

  it('refuses without the session capability', () => {
    const grant = makeGrant({});
    assert.strictEqual(checkSessionAllowed(grant, 'merge-workspace-snapshot', { key: 'tag-42' }).ok, false);
  });
});

describe('resolveCapabilities — session shape preservation', () => {
  it('preserves session: true across resolution', () => {
    const grant = resolveCapabilities('t', { session: true }, false);
    assert.strictEqual(grant.capabilities.session, true);
  });

  it('omits session when not requested', () => {
    const grant = resolveCapabilities('t', {}, false);
    assert.strictEqual(grant.capabilities.session, undefined);
  });
});
