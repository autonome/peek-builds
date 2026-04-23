/**
 * Sender-frame cross-check helper (Phase 2 — docs/pubsub-state-machine.md).
 *
 * This module is intentionally small and Electron-free at runtime so it
 * can be unit-tested under `ELECTRON_RUN_AS_NODE=1`. The only Electron
 * touch point is a type import for `IpcMainEvent` / `IpcMainInvokeEvent`,
 * which the TypeScript compiler erases.
 *
 * Motivation: every `tile:*` IPC handler takes `payload.token` and
 * resolves it to a capability grant. Nothing today checks that
 * `event.sender` (the `WebContents` that delivered the frame) is the
 * same `WebContents` that owns the token. A tile with an XSS bug that
 * leaks its token could be impersonated by any other tile that learned
 * the leaked token — the capability gate would trust the token field
 * and let the forged frame through.
 *
 * Binding model:
 *   - Eager binding: `createTileBrowserWindow` and
 *     `registerTrustedBuiltinWindow` call `setTokenOwner(token,
 *     win.webContents.id)` right after `new BrowserWindow()`. This
 *     covers every regular tile + trustedBuiltin core renderer.
 *   - Trust-on-first-use fallback: for renderers we can't bind at
 *     construction time (e.g. `<webview>` guests minted inside
 *     `will-attach-webview` where Electron doesn't surface the guest
 *     wc id), the first IPC frame that carries the token binds
 *     `event.sender.id` atomically. Legitimate renderers always send
 *     their own first frame (tile:validate-token or tile:lifecycle:ready during
 *     preload) before any other code can access the token, so TOFU is
 *     race-free in practice.
 *
 * Rejection path:
 *   - `missing-token`:   the frame did not carry a token → drop + drift.
 *   - `invalid-token`:   no grant exists for the token → drop + drift.
 *   - `sender-mismatch`: grant is bound to a different wc id → drop + drift.
 *
 * Phase 8 will factor the check into the central `tile-ipc-gate.ts`
 * chokepoint. For Phase 2 the check is duplicated inline at every
 * handler — consistent is simpler than exempt.
 */

import { getGrantForToken, getTokenOwner, setTokenOwner } from './tile-tokens.js';
import { publish, scopes, getSystemAddress } from './pubsub.js';
import type { CapabilityGrant } from './tile-manifest.js';

/**
 * Emit a `tile:drift` event describing an IPC frame that was dropped
 * by the sender-frame cross-check. Logged at warn level so it surfaces
 * in `/tmp/test-electron.log`. Rate-limiting and structured topic
 * ownership land in Phase 8; for now direct publish is fine.
 */
export function emitTileDrift(reason: string, ctx: Record<string, unknown>): void {
  const payload = { reason, ...ctx, ts: Date.now() };
  try {
    publish(getSystemAddress(), scopes.GLOBAL, 'tile:drift', payload);
  } catch (err) {
    // Publishing drift must never throw out of the handler — swallow
    // and log so the original rejection path stays clean.
    console.error('[tile-ipc] Failed to publish tile:drift:', err);
  }
  console.warn(`[tile-ipc] tile:drift reason=${reason}`, ctx);
}

/**
 * Minimal shape of the IPC event we read from. Declared inline so this
 * module doesn't force a direct `import { type IpcMainEvent } from
 * 'electron'` — which would pull the module graph back into Electron
 * territory at type-level (harmless but noisy for tests that stub
 * `Electron.IpcMainEvent`).
 */
export interface SenderFrameEvent {
  sender: {
    id: number;
    getURL(): string;
  };
}

/**
 * Verify that `event.sender` matches the WebContents bound to
 * `token`. Returns the grant on success; returns `null` on failure
 * and emits `tile:drift`. On trust-on-first-use (no owner bound
 * yet), atomically binds `event.sender.id` as the owner.
 *
 * Callers should substitute this for `getGrantForToken(token)` at
 * every `tile:*` handler entry point. A `null` return means the
 * handler MUST NOT perform any side-effect — drop silently.
 *
 * `opName` is the handler's channel name, used for drift telemetry
 * and debugging. Keep it stable across releases so CI can fail on
 * unexpected drift events.
 */
export function verifyTokenSender(
  event: SenderFrameEvent,
  token: string | undefined,
  opName: string,
): CapabilityGrant | null {
  if (!token) {
    emitTileDrift('missing-token', { op: opName, senderWcId: event.sender.id });
    return null;
  }
  const grant = getGrantForToken(token);
  if (!grant) {
    emitTileDrift('invalid-token', { op: opName, senderWcId: event.sender.id });
    return null;
  }
  const ownerWcId = getTokenOwner(token);
  const senderWcId = event.sender.id;
  if (ownerWcId === undefined) {
    // Trust-on-first-use: bind the first sender we see. Legitimate
    // renderers always send their own first frame before leaking the
    // token anywhere.
    setTokenOwner(token, senderWcId);
    return grant;
  }
  if (ownerWcId !== senderWcId) {
    let senderUrl = '';
    try { senderUrl = event.sender.getURL(); } catch { /* wc destroyed */ }
    emitTileDrift('sender-mismatch', {
      op: opName,
      tokenTileId: grant.tileId,
      ownerWcId,
      senderWcId,
      senderUrl,
    });
    return null;
  }
  return grant;
}
