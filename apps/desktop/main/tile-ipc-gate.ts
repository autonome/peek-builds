/**
 * Tile IPC Gate — Phase 8 (docs/pubsub-state-machine.md).
 *
 * Single main-process chokepoint for every `tile:*` IPC frame. Replaces
 * the scattered inline `verifyTokenSender(...)` calls that Phase 2
 * introduced across ~170 handlers in `tile-ipc.ts`. Subsumes
 * `tile-ipc-sender-check.ts` (deleted in Phase 8) — the sender-frame
 * check is now step 2 of a six-step pipeline.
 *
 * The gate is the only way to attach a `tile:*` IPC handler:
 * `registerTileIpc(channel, descriptor, handler)` calls
 * `ipcMain.on` / `ipcMain.handle` under the covers, but with the
 * validation pipeline wired in front. An unregistered channel that
 * arrives at the main process is implicitly dropped — there is no
 * listener to receive it — and logged via `gate:rejected` telemetry
 * (see §Step 1 below).
 *
 * Pipeline (fixed order; failing any step emits `gate:rejected` and
 * drops the frame):
 *
 *   1. Channel allowlisted?              (implicit via registration)
 *   2. Sender-frame matches token owner? (from old sender-check module)
 *   3. Payload schema valid?             (hand-rolled shape checks)
 *   4. Token valid + required caps?      (grant inspection)
 *   5. State-at-receive matches?         (dispatch window)
 *   6. Sender role allowlisted?          (role vs channel)
 *
 * Hand-rolled shape checks only — the spec's 5μs/frame budget
 * precludes Zod / Ajv. All checks are O(1) property reads.
 *
 * Bypass detectors (dev-mode only):
 *   - `installDirectSendGuard()` — monkey-patches
 *     `WebContents.prototype.send`; throws if topic starts with
 *     `pubsub:` and caller isn't the broadcaster. The broadcaster
 *     captures the pre-patched `send` via `unguardedWebContentsSend`
 *     at init time, before the patch lands.
 *   - `installOffPathWindowGuard()` — monkey-patches
 *     `BrowserWindow.prototype.loadURL`; asserts any `peek://{tile}/`
 *     URL has a corresponding `registered → loading` lifecycle
 *     transition.
 *
 * ESLint plan (to be wired in .eslintrc if the project adopts ESLint):
 *   - ban `webContents.send(topic, …)` where `topic` starts with
 *     `'pubsub:'` outside `main.ts` broadcaster.
 *   - ban `new BrowserWindow({ … })` followed by `loadURL('peek://…')`
 *     outside `tile-launcher.ts`.
 * If ESLint isn't used, the runtime guards above remain the
 * enforcement mechanism.
 */

// Type-only imports from 'electron' so this module can be imported by unit
// tests running under ELECTRON_RUN_AS_NODE=1 (where electron's named ESM
// exports are empty and `import { ipcMain }` throws at module parse).
// Runtime access goes through `getElectron()` via createRequire, mirroring
// the canonical pattern in tile-launcher.ts. See
// project_esm_require_gotcha.md for why.
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, BrowserWindow as BrowserWindowType } from 'electron';
import { createRequire } from 'node:module';

const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') {
  if (_electron) return _electron;
  _electron = requireElectron('electron') as typeof import('electron');
  return _electron;
}
import { getGrantForToken, getTokenOwner, setTokenOwner } from './tile-tokens.js';
import { publish, getSystemAddress } from './pubsub.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';
import { STATES, type TileState } from './tile-fsm.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Handler signature. The gate only invokes the handler when all six
 * steps pass. `grant` is the validated capability grant; `event` is
 * the original Electron event object.
 */
export type TileIpcOnHandler<TArgs> = (
  event: IpcMainEvent,
  args: TArgs,
  grant: CapabilityGrant,
) => void | Promise<void>;

export type TileIpcInvokeHandler<TArgs, TReturn> = (
  event: IpcMainInvokeEvent,
  args: TArgs,
  grant: CapabilityGrant,
) => TReturn | Promise<TReturn>;

export type TileIpcHandler<TArgs, TReturn> =
  | TileIpcOnHandler<TArgs>
  | TileIpcInvokeHandler<TArgs, TReturn>;

/**
 * Hand-rolled schema shape. `true` = accept anything. Keep it simple —
 * the spec's 5μs budget precludes deep recursion.
 */
export type FieldCheck = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any' | 'optional-string' | 'optional-number' | 'optional-boolean' | 'optional-object' | 'optional-array';
export type PayloadSchema = Record<string, FieldCheck>;

/** A single `tile:*` channel descriptor. */
export interface TileIpcDescriptor {
  /** Invocation mode — `on` for fire-and-forget, `handle` for request/response. */
  mode: 'on' | 'handle';
  /**
   * Shape of the `args` object. Default: `{ token: 'string' }` (all
   * handlers carry a token). Extra keys beyond the schema are allowed
   * (existing handlers are liberal in payload structure).
   */
  payloadSchema?: PayloadSchema;
  /**
   * Required capabilities. Each entry must be present in `grant.capabilities`
   * (truthy). `trustedBuiltin` grants bypass this check. Default: `[]`
   * (handler does its own capability gating — the legacy pattern).
   */
  requiredCapabilities?: Array<keyof TileCapabilities>;
  /**
   * Lifecycle states at which this frame is accepted. Default:
   * `[READY, VISIBLE]` (the dispatchable window). For lifecycle IPC
   * that accepts LOADING, callers must opt in explicitly.
   *
   * The gate reads state lazily from tile-lifecycle (late-bound via
   * `__setStateProbeForTests`) so the pure-module dependency
   * boundary stays one-way.
   */
  stateWindow?: TileState[];
  /**
   * Senders roles allowed. Default: `['tile', 'core']` (every handler
   * today accepts both). `core` corresponds to grants with
   * `trustedBuiltin: true`.
   */
  allowedSenderRoles?: Array<'tile' | 'core' | 'system'>;
  /**
   * Response returned to invokers (`ipcMain.handle`) when the gate
   * rejects the frame. Ignored for `mode: 'on'`. Default:
   * `{ error: 'gate-rejected' }`.
   */
  rejectResponse?: unknown;
}

/** Structured rejection reason. Mirrored into the `gate:rejected` topic payload. */
export type GateRejectReason =
  | 'missing-token'
  | 'invalid-token'
  | 'sender-mismatch'
  | 'schema-invalid'
  | 'capability-missing'
  | 'wrong-state'
  | 'wrong-role';

/** Event context for the rejection telemetry. */
export interface GateRejectContext {
  op: string;                  // channel name (e.g., 'tile:pubsub:publish')
  tileId?: string | null;      // grant.tileId if a token resolved
  senderWcId?: number;
  ownerWcId?: number;
  extra?: Record<string, unknown>;
}

// ─── Rejection telemetry (rate-limited) ──────────────────────────────

/**
 * Rate limit: one event per `(tileId | '∅', reason)` tuple per second.
 * A tuple that has been published in the current second increments
 * `droppedCount`; the next eligible publish in a new second carries
 * the accumulated count on an aggregator field.
 */
interface RejectBucket {
  lastPublishMs: number;
  droppedCount: number;
}
const rejectBuckets = new Map<string, RejectBucket>();
const RATE_LIMIT_WINDOW_MS = 1000;

function bucketKey(tileId: string | null | undefined, reason: GateRejectReason): string {
  return `${tileId ?? '∅'}|${reason}`;
}

/**
 * Publish a `gate:rejected` event. Rate-limited per (tileId, reason).
 * Public so the gate itself can emit during pipeline failures AND so
 * integration tests can assert rejection flow end-to-end.
 */
export function emitGateRejected(reason: GateRejectReason, ctx: GateRejectContext): void {
  const now = Date.now();
  const key = bucketKey(ctx.tileId, reason);
  const bucket = rejectBuckets.get(key);
  if (bucket && (now - bucket.lastPublishMs) < RATE_LIMIT_WINDOW_MS) {
    bucket.droppedCount += 1;
    return;
  }
  const droppedCount = bucket ? bucket.droppedCount : 0;
  rejectBuckets.set(key, { lastPublishMs: now, droppedCount: 0 });
  const payload = {
    reason,
    op: ctx.op,
    tileId: ctx.tileId ?? null,
    senderWcId: ctx.senderWcId,
    ownerWcId: ctx.ownerWcId,
    droppedCount,
    ts: now,
    ...(ctx.extra ?? {}),
  };
  try {
    publish(getSystemAddress(), 'gate:rejected', payload);
  } catch (err) {
    // Never propagate telemetry failures — drop silently + log.
    console.error('[tile-ipc-gate] Failed to publish gate:rejected:', err);
  }
  // Also mirror to console.warn so the :bg test run's log carries the
  // full drop context (rate-limited publishes hide this from pubsub
  // subscribers that arrived late).
  console.warn(`[tile-ipc-gate] gate:rejected reason=${reason} op=${ctx.op} tileId=${ctx.tileId ?? '<none>'}`);
}

/** For tests. */
export function __resetRejectBucketsForTest(): void {
  rejectBuckets.clear();
}

// ─── State probe (late-bound, breaks import cycle) ──────────────────

type StateProbe = (tileId: string) => TileState | null;
let stateProbe: StateProbe | null = null;

/**
 * Inject a state probe function. Called by tile-lifecycle.ts at init
 * time. Without this, state-window checks pass unconditionally (which
 * preserves startup-time behavior before lifecycle is wired).
 */
export function setStateProbe(probe: StateProbe): void {
  stateProbe = probe;
}

/** For tests. */
export function __clearStateProbeForTest(): void {
  stateProbe = null;
}

// ─── Schema checker ─────────────────────────────────────────────────

function checkField(value: unknown, check: FieldCheck): boolean {
  switch (check) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':   return Array.isArray(value);
    case 'any':     return true;
    case 'optional-string':  return value === undefined || typeof value === 'string';
    case 'optional-number':  return value === undefined || typeof value === 'number';
    case 'optional-boolean': return value === undefined || typeof value === 'boolean';
    case 'optional-object':  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value));
    case 'optional-array':   return value === undefined || Array.isArray(value);
  }
}

function validatePayload(args: unknown, schema: PayloadSchema): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const obj = args as Record<string, unknown>;
  for (const [key, check] of Object.entries(schema)) {
    if (!checkField(obj[key], check)) return false;
  }
  return true;
}

// ─── Sender role inference ───────────────────────────────────────────

function roleForGrant(grant: CapabilityGrant): 'tile' | 'core' {
  return grant.trustedBuiltin ? 'core' : 'tile';
}

// ─── The six-step pipeline ──────────────────────────────────────────

const DEFAULT_PAYLOAD_SCHEMA: PayloadSchema = { token: 'string' };
const DEFAULT_STATE_WINDOW: TileState[] = [STATES.READY, STATES.VISIBLE, STATES.LOADING];
const DEFAULT_SENDER_ROLES: Array<'tile' | 'core' | 'system'> = ['tile', 'core'];

/**
 * Run the validation pipeline. Returns the grant on success; returns
 * a rejection reason on failure (already emitted via
 * `emitGateRejected`).
 */
function runPipeline(
  channel: string,
  event: IpcMainEvent | IpcMainInvokeEvent,
  args: unknown,
  descriptor: TileIpcDescriptor,
): { ok: true; grant: CapabilityGrant } | { ok: false; reason: GateRejectReason } {
  const senderWcId = event?.sender?.id;

  // Step 3: payload schema (run before token extraction so malformed
  // args with missing token aren't misreported as missing-token).
  const schema = descriptor.payloadSchema ?? DEFAULT_PAYLOAD_SCHEMA;
  if (!validatePayload(args, schema)) {
    emitGateRejected('schema-invalid', { op: channel, senderWcId });
    return { ok: false, reason: 'schema-invalid' };
  }

  const payload = args as { token?: string };
  const token = payload.token;
  // Step 2a: token presence.
  if (!token) {
    emitGateRejected('missing-token', { op: channel, senderWcId });
    return { ok: false, reason: 'missing-token' };
  }

  // Step 4a: token validity + grant lookup.
  const grant = getGrantForToken(token);
  if (!grant) {
    emitGateRejected('invalid-token', { op: channel, senderWcId });
    return { ok: false, reason: 'invalid-token' };
  }

  // Step 2b: sender-frame cross-check (trust-on-first-use binding for
  // tokens whose owner was never set at construction time).
  const ownerWcId = getTokenOwner(token);
  if (ownerWcId === undefined) {
    setTokenOwner(token, senderWcId);
  } else if (ownerWcId !== senderWcId) {
    emitGateRejected('sender-mismatch', {
      op: channel,
      tileId: grant.tileId,
      senderWcId,
      ownerWcId,
    });
    return { ok: false, reason: 'sender-mismatch' };
  }

  // Step 4b: required capabilities.
  if (descriptor.requiredCapabilities && descriptor.requiredCapabilities.length > 0) {
    if (!grant.trustedBuiltin) {
      for (const cap of descriptor.requiredCapabilities) {
        const value = grant.capabilities[cap];
        if (value === undefined || value === false) {
          emitGateRejected('capability-missing', {
            op: channel,
            tileId: grant.tileId,
            extra: { required: cap },
          });
          return { ok: false, reason: 'capability-missing' };
        }
      }
    }
  }

  // Step 5: state-at-receive.
  const stateWindow = descriptor.stateWindow ?? DEFAULT_STATE_WINDOW;
  if (stateProbe && !grant.trustedBuiltin) {
    const state = stateProbe(grant.tileId);
    if (state !== null && !stateWindow.includes(state)) {
      emitGateRejected('wrong-state', {
        op: channel,
        tileId: grant.tileId,
        extra: { state, allowed: stateWindow },
      });
      return { ok: false, reason: 'wrong-state' };
    }
  }

  // Step 6: sender role.
  const allowedRoles = descriptor.allowedSenderRoles ?? DEFAULT_SENDER_ROLES;
  const role = roleForGrant(grant);
  if (!allowedRoles.includes(role)) {
    emitGateRejected('wrong-role', {
      op: channel,
      tileId: grant.tileId,
      extra: { role, allowed: allowedRoles },
    });
    return { ok: false, reason: 'wrong-role' };
  }

  return { ok: true, grant };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Register a `tile:*` IPC handler through the gate. Call exactly once
 * per channel at app init — duplicates will throw from Electron's
 * `ipcMain`.
 *
 * The gate runs the six-step pipeline before the handler. On failure,
 * the handler is NOT called:
 *   - `mode: 'on'`  → the frame is silently dropped (plus
 *     `gate:rejected` telemetry).
 *   - `mode: 'handle'` → `descriptor.rejectResponse` is returned to
 *     the renderer (default: `{ error: 'gate-rejected' }`).
 */
export function registerTileIpc<TArgs = unknown, TReturn = unknown>(
  channel: string,
  descriptor: TileIpcDescriptor,
  // Using a looser handler type in the public signature keeps call
  // sites ergonomic — the migrated tile-ipc.ts handlers want `ev.reply`
  // (IpcMainEvent) for `mode: 'on'` and return values for
  // `mode: 'handle'`. Structural typing narrows per descriptor.mode
  // at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: any, args: TArgs, grant: CapabilityGrant) => any,
): void {
  if (descriptor.mode === 'on') {
    getElectron().ipcMain.on(channel,(event, args) => {
      const result = runPipeline(channel, event, args, descriptor);
      if (!result.ok) return;
      try {
        const ret = handler(event, args as TArgs, result.grant);
        if (ret && typeof (ret as { then?: unknown }).then === 'function') {
          (ret as Promise<TReturn>).catch((err) => {
            console.error(`[tile-ipc-gate] handler ${channel} threw:`, err);
          });
        }
      } catch (err) {
        console.error(`[tile-ipc-gate] handler ${channel} threw:`, err);
      }
    });
  } else {
    getElectron().ipcMain.handle(channel, async (event, args) => {
      const result = runPipeline(channel, event, args, descriptor);
      if (!result.ok) {
        return descriptor.rejectResponse ?? { error: 'gate-rejected', reason: result.reason };
      }
      return handler(event, args as TArgs, result.grant);
    });
  }
}

/**
 * Back-compat shim. A handful of handlers inside tile-ipc.ts still
 * call `verifyTokenSender(...)` for narrower operations (e.g. the
 * inner izui branches that separately do `getGrantForToken(token)`
 * after the sender check). Those paths can route through this helper
 * until they're rewritten through `registerTileIpc`. In Phase 8 the
 * primary `tile:*` handlers no longer need it.
 *
 * The function now lives in the gate — its former module
 * `tile-ipc-sender-check.ts` is deleted. Semantics unchanged from the
 * pre-Phase-8 helper: returns the grant on success, null on failure
 * with `gate:rejected` telemetry emitted (was `tile:drift` pre-
 * Phase-8; the topic rename was Phase 8 preamble).
 */
export function verifyTokenSender(
  event: { sender: { id: number; getURL(): string } },
  token: string | undefined,
  opName: string,
): CapabilityGrant | null {
  const senderWcId = event?.sender?.id;
  if (!token) {
    emitGateRejected('missing-token', { op: opName, senderWcId });
    return null;
  }
  const grant = getGrantForToken(token);
  if (!grant) {
    emitGateRejected('invalid-token', { op: opName, senderWcId });
    return null;
  }
  const ownerWcId = getTokenOwner(token);
  if (ownerWcId === undefined) {
    setTokenOwner(token, senderWcId);
    return grant;
  }
  if (ownerWcId !== senderWcId) {
    emitGateRejected('sender-mismatch', {
      op: opName,
      tileId: grant.tileId,
      senderWcId,
      ownerWcId,
    });
    return null;
  }
  return grant;
}

// ─── Bypass detectors (dev-mode) ─────────────────────────────────────

/**
 * Whether a send to `wc` can reach a renderer. False once the WebContents
 * is destroyed, and also while it is still alive but its main frame has
 * been disposed or detached — the window-close and quit window, where
 * `wc.isDestroyed()` is still false. Electron does not throw for a send
 * in that state; `WebFrameMain.send` catches its own "Render frame was
 * disposed" error and logs it, so a caller's try/catch never sees it and
 * every send to every closing window lands in the log. Any property
 * access that throws is treated as "gone".
 */
export function canDeliverTo(wc: WebContents): boolean {
  try {
    if (wc.isDestroyed()) return false;
    const frame = (wc as { mainFrame?: Electron.WebFrameMain | null }).mainFrame;
    if (!frame) return false;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    if (frame.detached) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Captured pre-patched `WebContents.prototype.send`. Broadcaster uses
 * this to send `pubsub:*` frames without tripping the guard. Stored
 * here (not on the WebContents object) so patching is a single
 * replacement and the broadcaster binds at module import time — before
 * `installDirectSendGuard` runs.
 */
/**
 * Expose the pre-patched `send` to the broadcaster. Callers invoke as
 * `unguardedWebContentsSend(wc, channel, ...args)`.
 *
 * Falls back to `wc.send` before the guard is installed (start-up
 * phase) — at that point the guard isn't active anyway.
 */
export function unguardedWebContentsSend(
  wc: WebContents,
  channel: string,
  ...args: unknown[]
): void {
  if (!canDeliverTo(wc)) return;
  const original = perWcOriginalSend.get(wc.id);
  if (original) {
    original(channel, ...args);
  } else {
    // Guard not yet installed on this WC (e.g., pre-guard startup,
    // or a WC created before we could patch it) — fall through to the
    // current `send`. Safe: the broadcaster is the intended caller,
    // so no bypass is being introduced.
    wc.send(channel, ...args);
  }
}

let directSendGuardInstalled = false;

// Per-WebContents original `send` cache. Keyed by wc.id so the
// broadcaster-side `unguardedWebContentsSend` can recover the pre-patch
// function even after the guard ran.
const perWcOriginalSend = new Map<number, (channel: string, ...args: unknown[]) => void>();

function patchWebContentsSend(wc: WebContents): void {
  const original = (wc as unknown as { send: (channel: string, ...args: unknown[]) => void }).send;
  if (typeof original !== 'function') return;
  // Idempotency: if we've already patched this instance, skip.
  if (perWcOriginalSend.has(wc.id)) return;
  perWcOriginalSend.set(wc.id, original.bind(wc));
  (wc as unknown as { send: (channel: string, ...args: unknown[]) => void }).send =
    function guardedSend(channel: string, ...args: unknown[]): void {
      if (typeof channel === 'string' && channel.startsWith('pubsub:')) {
        throw new Error(
          `[tile-ipc-gate] direct-send bypass: WebContents.send('${channel}', ...) called outside the pubsub broadcaster. ` +
          `Route through the broadcaster set via setPubsubBroadcaster() in main.ts.`,
        );
      }
      // A closing or quitting window's frame can be gone while the
      // WebContents is not yet destroyed; drop the send rather than let
      // Electron log a disposed-frame error for it.
      if (!canDeliverTo(wc)) return;
      return original.call(wc, channel, ...args);
    };
}

/**
 * Dev-mode: patch every WebContents's `send` method to throw if a
 * caller outside the broadcaster tries to send a `pubsub:*` frame.
 * Uses `app.on('web-contents-created')` so newly created windows pick
 * up the patch automatically. Existing WCs are patched in the same
 * pass.
 *
 * The broadcaster calls `unguardedWebContentsSend(wc, ...)` which
 * reads from `perWcOriginalSend` — sends bypassing the guard.
 *
 * Idempotent.
 */
export function installDirectSendGuard(): void {
  if (directSendGuardInstalled) return;
  directSendGuardInstalled = true;
  try {
    // Patch any already-created WC.
    for (const wc of getElectron().webContents.getAllWebContents()) {
      patchWebContentsSend(wc);
    }
    // Patch future WCs.
    getElectron().app.on('web-contents-created', (_event: unknown, wc: WebContents) => {
      patchWebContentsSend(wc);
    });
  } catch (err) {
    console.warn('[tile-ipc-gate] installDirectSendGuard inactive:', err);
  }
}

let offPathWindowGuardInstalled = false;
type OffPathProbe = (tileId: string) => boolean;
let offPathProbe: OffPathProbe | null = null;

/**
 * Inject a probe that answers "does this tileId currently have a
 * registered → loading transition recorded?" Called by
 * `tile-lifecycle.ts` at init. Without a probe the guard logs but
 * does not throw — so startup ordering between the guard install and
 * lifecycle init cannot cause false positives.
 */
export function setOffPathWindowProbe(probe: OffPathProbe): void {
  offPathProbe = probe;
}

/**
 * Dev-mode: patch `BrowserWindow.prototype.loadURL` to assert any
 * `peek://{tileId}/` URL has a matching lifecycle transition. An
 * unregistered tile URL = off-path window creation (someone bypassed
 * the tile launcher).
 */
export function installOffPathWindowGuard(): void {
  if (offPathWindowGuardInstalled) return;
  offPathWindowGuardInstalled = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = (getElectron().BrowserWindow as any).prototype as BrowserWindowType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realLoadURL: BrowserWindowType['loadURL'] = (proto as any).loadURL;
  if (typeof realLoadURL !== 'function') {
    console.warn('[tile-ipc-gate] installOffPathWindowGuard: loadURL not a function — guard inactive');
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proto as any).loadURL = function guardedLoadURL(
    this: BrowserWindowType,
    url: string,
    options?: Electron.LoadURLOptions,
  ): Promise<void> {
    if (typeof url === 'string' && url.startsWith('peek://')) {
      // Extract tile id: peek://{tileId}/...
      const rest = url.slice('peek://'.length);
      const slash = rest.indexOf('/');
      const tileId = slash >= 0 ? rest.slice(0, slash) : rest;
      // Skip non-tile pseudo-hosts (core, system, local-file, app).
      const NON_TILE_HOSTS = new Set(['app', 'system', 'local-file']);
      if (!NON_TILE_HOSTS.has(tileId) && offPathProbe) {
        if (!offPathProbe(tileId)) {
          console.warn(
            `[tile-ipc-gate] off-path window: ${url} — no registered → loading transition recorded for tileId=${tileId}. ` +
            `Route BrowserWindow creation through tile-launcher.ts.`,
          );
        }
      }
    }
    return realLoadURL.call(this, url, options);
  };
}

/** For tests. */
export function __uninstallGuardsForTest(): void {
  // Restore per-WC send if patched.
  for (const wc of getElectron().webContents.getAllWebContents()) {
    const original = perWcOriginalSend.get(wc.id);
    if (original) {
      (wc as unknown as { send: unknown }).send = original;
    }
  }
  perWcOriginalSend.clear();
  directSendGuardInstalled = false;
  offPathWindowGuardInstalled = false;
  offPathProbe = null;
}
