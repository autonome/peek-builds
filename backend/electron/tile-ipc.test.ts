/**
 * Unit tests for tile-ipc.ts — Phase 2 sender-frame cross-check.
 *
 * The central invariant tested here: every `tile:*` IPC handler routes
 * through `verifyTokenSender()`. If the `event.sender` WebContents id
 * differs from the WebContents id bound to `payload.token`, the frame
 * is dropped and a `tile:drift` event is published. Without this check,
 * a tile with an XSS bug that leaked its token could be impersonated
 * by any other tile that learned the leaked token — the capability
 * gate would trust the token field and let the forged frame through.
 *
 * Runs under Electron's Node host (via `yarn test:unit`). `pubsub`
 * works under ELECTRON_RUN_AS_NODE because it has no Electron imports;
 * `verifyTokenSender` imports `electron` only for IpcMainEvent type
 * annotations, which are erased at runtime.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  generateToken,
  setTokenOwner,
  clearAllTokens,
  getTokenOwner,
} from './tile-tokens.js';
import { resolveCapabilities } from './tile-manifest.js';
import { subscribe, unsubscribe, scopes } from './pubsub.js';
import { verifyTokenSender } from './tile-ipc-sender-check.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Fake IpcMainEvent.sender — only the id is load-bearing for the check. */
function fakeEvent(senderWcId: number): Electron.IpcMainEvent {
  return {
    sender: {
      id: senderWcId,
      getURL: () => `peek://fake-sender-${senderWcId}/`,
    },
  } as unknown as Electron.IpcMainEvent;
}

function mintToken(tileId: string): string {
  const grant = resolveCapabilities(tileId, { pubsub: { scopes: ['global'] } }, true);
  return generateToken(tileId, 'background', grant);
}

/**
 * Subscribe to the `tile:drift` topic and collect every payload
 * delivered during the test. Callers inspect `events` after calling
 * `verifyTokenSender` to assert drift emission shape.
 */
function captureDriftEvents(): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const source = `test-drift-listener-${Math.random().toString(36).slice(2, 8)}`;
  subscribe(source, scopes.GLOBAL, 'tile:drift', (msg) => {
    events.push(msg as Record<string, unknown>);
  });
  return {
    events,
    stop: () => { unsubscribe(source, 'tile:drift'); },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('verifyTokenSender (Phase 2: sender-frame cross-check)', () => {
  let drift: ReturnType<typeof captureDriftEvents>;

  beforeEach(() => {
    clearAllTokens();
    drift = captureDriftEvents();
  });

  afterEach(() => {
    drift.stop();
    clearAllTokens();
  });

  it('accepts a frame when sender matches the bound owner', () => {
    const token = mintToken('tile-a');
    setTokenOwner(token, 100);

    const grant = verifyTokenSender(fakeEvent(100), token, 'tile:pubsub:publish');
    assert.ok(grant, 'expected grant returned for legitimate sender');
    assert.strictEqual(grant.tileId, 'tile-a');
    assert.strictEqual(drift.events.length, 0, 'no drift event should have been emitted');
  });

  it('rejects a frame whose sender WebContents id does not match the token owner', () => {
    // Mint a token for tile A. Bind it to wc id 100 (tile A's own window).
    const token = mintToken('tile-a');
    setTokenOwner(token, 100);

    // Simulate tile B (wc id 200) sending a tile:pubsub:publish frame
    // with tile A's leaked token.
    const grant = verifyTokenSender(fakeEvent(200), token, 'tile:pubsub:publish');
    assert.strictEqual(grant, null, 'rejected frame must return null');

    // One drift event published with reason=sender-mismatch and
    // structured context.
    assert.strictEqual(drift.events.length, 1, 'exactly one drift event should have been emitted');
    const evt = drift.events[0];
    assert.strictEqual(evt.reason, 'sender-mismatch');
    assert.strictEqual(evt.op, 'tile:pubsub:publish');
    assert.strictEqual(evt.tokenTileId, 'tile-a');
    assert.strictEqual(evt.ownerWcId, 100);
    assert.strictEqual(evt.senderWcId, 200);
    assert.ok(typeof evt.ts === 'number', 'drift event carries timestamp');
  });

  it('rejects a frame with a token that does not exist', () => {
    const grant = verifyTokenSender(fakeEvent(200), 'nope-token', 'tile:pubsub:publish');
    assert.strictEqual(grant, null);
    assert.strictEqual(drift.events.length, 1);
    assert.strictEqual(drift.events[0].reason, 'invalid-token');
  });

  it('rejects a frame with no token', () => {
    const grant = verifyTokenSender(fakeEvent(200), undefined, 'tile:pubsub:publish');
    assert.strictEqual(grant, null);
    assert.strictEqual(drift.events.length, 1);
    assert.strictEqual(drift.events[0].reason, 'missing-token');
  });

  it('trust-on-first-use: first frame binds the owner when none was set', () => {
    // Mint a token without calling setTokenOwner (mimics webview
    // guests where we can't bind eagerly).
    const token = mintToken('webview-tile');
    assert.strictEqual(getTokenOwner(token), undefined);

    const grant = verifyTokenSender(fakeEvent(300), token, 'tile:pubsub:publish');
    assert.ok(grant, 'TOFU bind must return the grant on first use');
    assert.strictEqual(getTokenOwner(token), 300, 'first sender becomes the bound owner');
    assert.strictEqual(drift.events.length, 0);

    // Second frame from a DIFFERENT wc must now be rejected — the
    // TOFU bind made wc 300 the sole legitimate sender.
    const grant2 = verifyTokenSender(fakeEvent(400), token, 'tile:pubsub:publish');
    assert.strictEqual(grant2, null);
    assert.strictEqual(drift.events.length, 1);
    assert.strictEqual(drift.events[0].reason, 'sender-mismatch');
  });
});

describe('Phase 3: tile:command:result is gone', () => {
  // At runtime under ELECTRON_RUN_AS_NODE=1 the test file lives at
  // dist/backend/electron/tile-ipc.test.js and the compiled handler
  // module is its sibling tile-ipc.js. We assert the compiled output
  // contains no reference to the legacy side-channel — neither the
  // preload send site nor the main-process handler registration can
  // leave a stub behind without this failing.
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const compiledTileIpc = join(hereDir, 'tile-ipc.js');

  it('compiled tile-ipc.js does not register a tile:command:result handler', () => {
    const src = readFileSync(compiledTileIpc, 'utf8');
    assert.ok(
      !src.includes("'tile:command:result'") && !src.includes('"tile:command:result"'),
      'tile-ipc.js still contains a tile:command:result reference — Phase 3 removed that channel'
    );
  });
});
