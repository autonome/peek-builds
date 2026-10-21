/**
 * Unit tests for the Web Tiles protocol registry (main/tile-protocols.ts).
 *
 * What is pinned here is the machinery one protocol declaration buys: a
 * handler per method, a capability check on every call that reports a
 * violation the way the hand-written `tile:*` handlers do, a served module
 * that exports exactly the declared methods, and one indistinguishable
 * failure for "not registered" and "not granted" so an importing tile cannot
 * tell a refusal from an absent API.
 *
 * `registerTileProtocol()` itself reaches `ipcMain` through the IPC gate, so
 * the derived-handler tests drive the handler the gate was given rather than
 * going through Electron, which does not exist under `ELECTRON_RUN_AS_NODE`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  registerTileProtocol,
  getTileProtocol,
  registeredProtocolNames,
  protocolChannel,
  protocolNameFromPath,
  protocolModuleForRequest,
  buildProtocolModuleSource,
  capabilitiesHoldProtocol,
  grantHoldsProtocol,
  unsatisfiedRequiredProtocols,
  clearPendingProtocolEvents,
  __resetTileProtocolsForTest,
  __setIpcRegistrarForTest,
  type TileProtocolDeclaration,
} from './tile-protocols.js';
import { validateTileManifest } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities, TileManifest } from './tile-manifest.js';
import { subscribe, unsubscribe } from './pubsub.js';
import { _resetViolationRateLimit } from './tile-violations.js';

// ─── Fixtures ───────────────────────────────────────────────────────

function grantWith(capabilities: TileCapabilities, trustedBuiltin = false): CapabilityGrant {
  return { tileId: 'fixture', capabilities, denied: [], trustedBuiltin } as unknown as CapabilityGrant;
}

function manifestWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 3,
    id: 'fixture',
    name: 'Fixture',
    version: '1.0.0',
    tiles: [{ id: 'background', url: 'background.html' }],
    capabilities: { network: { domains: ['example.test'] } },
    ...over,
  };
}

/**
 * Capture the handlers `registerTileProtocol` derives, without an `ipcMain`
 * to register them on.
 */
type GatedHandler = (
  event: unknown,
  args: { token: string; args?: unknown[] },
  grant: CapabilityGrant | null,
) => unknown;

const registered = new Map<string, { descriptor: Record<string, unknown>; handler: GatedHandler }>();

function interceptGate(): void {
  registered.clear();
  __setIpcRegistrarForTest(((channel: string, descriptor: Record<string, unknown>, handler: GatedHandler) => {
    registered.set(channel, { descriptor, handler });
  }) as never);
}

function restoreGate(): void {
  __setIpcRegistrarForTest(null);
}

/** Collect `tile:capability-violation` events published during a test. */
function captureViolations(): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const source = `test-tile-protocols-${Math.random().toString(36).slice(2, 8)}`;
  subscribe(source, 'tile:capability-violation', (msg) => {
    events.push(msg as Record<string, unknown>);
  });
  return { events, stop: () => unsubscribe(source, 'tile:capability-violation') };
}

const DEMO: TileProtocolDeclaration = {
  name: 'demo',
  capability: 'network',
  methods: {
    ping: async () => ({ pong: true }),
    echo: async (_grant, args) => ({ echoed: args[0] }),
  },
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('tile protocol registry — derived handlers', () => {
  beforeEach(() => {
    __resetTileProtocolsForTest();
    _resetViolationRateLimit();
    interceptGate();
  });

  afterEach(() => {
    restoreGate();
    __resetTileProtocolsForTest();
  });

  it('derives one handler per declared method', () => {
    registerTileProtocol(DEMO);
    assert.deepStrictEqual(
      [...registered.keys()].sort(),
      ['tile:protocol:demo:echo', 'tile:protocol:demo:ping'],
    );
    assert.deepStrictEqual(registeredProtocolNames(), ['demo']);
    assert.strictEqual(getTileProtocol('demo')?.capability, 'network');
  });

  it('names the channel after the protocol and the method', () => {
    assert.strictEqual(protocolChannel('atproto', 'sessionInfo'), 'tile:protocol:atproto:sessionInfo');
  });

  it('declares the token and args payload schema the gate checks', () => {
    registerTileProtocol(DEMO);
    const entry = registered.get('tile:protocol:demo:ping')!;
    assert.strictEqual(entry.descriptor.mode, 'handle');
    assert.deepStrictEqual(entry.descriptor.payloadSchema, { token: 'string', args: 'optional-array' });
  });

  it('refuses a second declaration of the same protocol name', () => {
    registerTileProtocol(DEMO);
    assert.throws(() => registerTileProtocol(DEMO), /already registered/);
  });

  it('runs the declared handler with the caller grant and arguments', async () => {
    registerTileProtocol(DEMO);
    const handler = registered.get('tile:protocol:demo:echo')!.handler;
    const result = await handler({}, { token: 't', args: ['hi'] }, grantWith({ network: { domains: [] } }));
    assert.deepStrictEqual(result, { echoed: 'hi' });
  });

  it('passes an empty argument list when the caller sends none', async () => {
    registerTileProtocol({
      name: 'args',
      capability: 'network',
      methods: { count: async (_grant, args) => ({ n: args.length }) },
    });
    const handler = registered.get('tile:protocol:args:count')!.handler;
    assert.deepStrictEqual(
      await handler({}, { token: 't' }, grantWith({ network: { domains: [] } })),
      { n: 0 },
    );
  });

  it('refuses a call from a tile lacking the capability, and reports it', async () => {
    registerTileProtocol(DEMO);
    const seen = captureViolations();
    try {
      const handler = registered.get('tile:protocol:demo:ping')!.handler;
      const result = await handler({}, { token: 'tok-1', args: [] }, grantWith({ commands: true }));
      assert.deepStrictEqual(result, { error: 'network capability not granted' });
      assert.strictEqual(seen.events.length, 1);
      assert.strictEqual(seen.events[0].capability, 'network');
      assert.strictEqual(seen.events[0].op, 'protocol:demo:ping');
      assert.strictEqual(seen.events[0].token, 'tok-1');
      assert.strictEqual(seen.events[0].tileId, 'fixture');
    } finally {
      seen.stop();
    }
  });

  it('refuses a call with no grant at all, which is how an invalid token arrives', async () => {
    registerTileProtocol(DEMO);
    _resetViolationRateLimit();
    const seen = captureViolations();
    try {
      const handler = registered.get('tile:protocol:demo:ping')!.handler;
      const result = await handler({}, { token: 'bad', args: [] }, null);
      assert.deepStrictEqual(result, { error: 'network capability not granted' });
      assert.strictEqual(seen.events.length, 1);
      assert.strictEqual(seen.events[0].tileId, null);
    } finally {
      seen.stop();
    }
  });

  it('lets a trustedBuiltin grant through without the capability', async () => {
    registerTileProtocol(DEMO);
    const handler = registered.get('tile:protocol:demo:ping')!.handler;
    assert.deepStrictEqual(
      await handler({}, { token: 't', args: [] }, grantWith({}, true)),
      { pong: true },
    );
  });

  it('answers grantHoldsProtocol only for a registered protocol', () => {
    registerTileProtocol(DEMO);
    const granted = grantWith({ network: { domains: [] } });
    assert.strictEqual(grantHoldsProtocol(granted, 'demo'), true);
    assert.strictEqual(grantHoldsProtocol(granted, 'nonexistent'), false);
    assert.strictEqual(grantHoldsProtocol(grantWith({ commands: true }), 'demo'), false);
    assert.strictEqual(grantHoldsProtocol(null, 'demo'), false);
  });
});

describe('tile protocol registry — served module', () => {
  beforeEach(() => {
    __resetTileProtocolsForTest();
    interceptGate();
    registerTileProtocol(DEMO);
  });

  afterEach(() => {
    restoreGate();
    __resetTileProtocolsForTest();
  });

  const GRANTED: TileCapabilities = { network: { domains: ['example.test'] } };

  /** The names a module source exports, excluding its default export. */
  function exportedNames(source: string): string[] {
    return [...source.matchAll(/^export const (\w+) =/gm)].map((m) => m[1]).sort();
  }

  it('exports exactly the declared methods for a granted tile', () => {
    const source = protocolModuleForRequest('fixture', '.well-known/web-tiles/demo.js', GRANTED);
    assert.ok(source !== null);
    assert.deepStrictEqual(exportedNames(source!), ['echo', 'ping']);
    assert.match(source!, /export default \{ ping, echo \};/);
  });

  it('routes every method through the one preload bridge', () => {
    const source = buildProtocolModuleSource('demo', ['ping']);
    assert.match(source, /globalThis\.app && globalThis\.app\.tileProtocol/);
    assert.match(source, /__bridge\("demo", method, args\)/);
  });

  it('serves nothing — the same answer — for an ungranted and an unknown protocol', () => {
    const ungranted = protocolModuleForRequest('fixture', '.well-known/web-tiles/demo.js', { commands: true });
    const unknown = protocolModuleForRequest('fixture', '.well-known/web-tiles/nonexistent.js', GRANTED);
    assert.strictEqual(ungranted, null);
    assert.strictEqual(unknown, null);
    assert.strictEqual(ungranted, unknown);
  });

  it('never serves a protocol on the legacy shared host', () => {
    assert.strictEqual(
      protocolModuleForRequest('ext', '.well-known/web-tiles/demo.js', GRANTED),
      null,
    );
  });

  it('recognises only a single-segment protocol module path', () => {
    assert.strictEqual(protocolNameFromPath('.well-known/web-tiles/demo.js'), 'demo');
    assert.strictEqual(protocolNameFromPath('.well-known/web-tiles/demo.txt'), null);
    assert.strictEqual(protocolNameFromPath('.well-known/web-tiles/.js'), null);
    assert.strictEqual(protocolNameFromPath('.well-known/web-tiles/nested/demo.js'), null);
    assert.strictEqual(protocolNameFromPath('.well-known/web-tiles/../../secret.js'), null);
    assert.strictEqual(protocolNameFromPath('publish.html'), null);
  });

  it('answers capabilitiesHoldProtocol from the manifest capabilities', () => {
    assert.strictEqual(capabilitiesHoldProtocol('demo', GRANTED), true);
    assert.strictEqual(capabilitiesHoldProtocol('demo', { commands: true }), false);
    assert.strictEqual(capabilitiesHoldProtocol('demo', null), false);
    assert.strictEqual(capabilitiesHoldProtocol('nonexistent', GRANTED), false);
  });

  it('forgets a tile queued protocol events without disturbing the registry', () => {
    clearPendingProtocolEvents('fixture');
    assert.deepStrictEqual(registeredProtocolNames(), ['demo']);
  });
});

describe('manifest protocols field', () => {
  beforeEach(() => {
    __resetTileProtocolsForTest();
    interceptGate();
    registerTileProtocol(DEMO);
  });

  afterEach(() => {
    restoreGate();
    __resetTileProtocolsForTest();
  });

  it('accepts required and optional', () => {
    assert.deepStrictEqual(
      validateTileManifest(manifestWith({ protocols: { demo: 'required', other: 'optional' } })),
      [],
    );
  });

  it('accepts a manifest with no protocols field', () => {
    assert.deepStrictEqual(validateTileManifest(manifestWith()), []);
  });

  it('rejects any other requirement value', () => {
    const errors = validateTileManifest(manifestWith({ protocols: { demo: 'maybe' } }));
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].path, 'protocols.demo');
    assert.match(errors[0].message, /expected "required" or "optional"/);
  });

  it('rejects a protocols field that is not an object', () => {
    for (const bad of ['demo', 42, ['demo'], null]) {
      const errors = validateTileManifest(manifestWith({ protocols: bad }));
      if (bad === null) {
        // `null` is an object-typed absence; it is still not a valid map.
        assert.strictEqual(errors.length, 1, `expected an error for ${JSON.stringify(bad)}`);
      }
      assert.ok(errors.some((e) => e.path === 'protocols'), `expected a protocols error for ${JSON.stringify(bad)}`);
    }
  });

  it('blocks opening a tile whose required protocol is not registered', () => {
    const manifest = manifestWith({ protocols: { nonexistent: 'required' } }) as unknown as TileManifest;
    assert.deepStrictEqual(unsatisfiedRequiredProtocols(manifest), ['nonexistent']);
  });

  it('blocks opening a tile that requires a protocol whose capability it lacks', () => {
    const manifest = manifestWith({
      protocols: { demo: 'required' },
      capabilities: { commands: true },
    }) as unknown as TileManifest;
    assert.deepStrictEqual(unsatisfiedRequiredProtocols(manifest), ['demo']);
  });

  it('does not block opening on a missing optional protocol', () => {
    const manifest = manifestWith({
      protocols: { nonexistent: 'optional', demo: 'optional' },
      capabilities: { commands: true },
    }) as unknown as TileManifest;
    assert.deepStrictEqual(unsatisfiedRequiredProtocols(manifest), []);
  });

  it('does not block opening when the required protocol is available', () => {
    const manifest = manifestWith({ protocols: { demo: 'required' } }) as unknown as TileManifest;
    assert.deepStrictEqual(unsatisfiedRequiredProtocols(manifest), []);
  });
});
