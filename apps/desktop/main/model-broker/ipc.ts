import { Buffer } from 'node:buffer';
import type { IpcMainInvokeEvent } from 'electron';
import type { CapabilityGrant, ModelsGrant } from '../tile-manifest.js';
import type { registerTileIpc } from '../tile-ipc-gate.js';
import type { ModelOwner, ModelState } from './contract.js';

/** Structural port: no broker construction, Electron loading or transport here. */
export interface ModelIpcBroker {
  start(owner: ModelOwner, request: unknown): Promise<unknown>;
  poll(owner: ModelOwner, request: unknown): Promise<unknown>;
  cancel(owner: ModelOwner, request: unknown): unknown;
  status(owner: ModelOwner, request: unknown): unknown;
}

export interface ModelIpcHost {
  broker: ModelIpcBroker;
  /** Resolve afresh using the actual sender/frame, current token and installed grant.
   * Return null for detached/stale senders or missing persistent revision identities.
   * Never synthesize install/grant revisions from manifest versions or token dates. */
  resolveOwner(event: IpcMainInvokeEvent, token: string, grant: CapabilityGrant): ModelOwner | null;
  /** Real current host probe, also supplied independently to BrokerPorts.probe.
   * Account/contact/export/vault checks and the pre-send recheck remain broker-owned. */
  probe(owner: ModelOwner): ModelState | null;
}

let host: ModelIpcHost | null = null;
/** Runtime must clear this BEFORE profile lock/switch/teardown, then cancel/close
 * its broker through host-only lifecycle paths. Null is the safe startup default.
 * Existing token records have no installRevision/grantRevision; until runtime has
 * authoritative revision identities it MUST leave this null (not infer them). */
export function setModelIpcHost(value: ModelIpcHost | null): void { host = value; }

type Op = 'start' | 'poll' | 'cancel' | 'status';
const deny = (): never => { throw new Error('MODEL_IPC_DENIED'); };
const invalid = (): never => { throw new Error('MODEL_IPC_INVALID'); };
// Never forward arbitrary host/provider exception messages through Electron.
const publicErrors = new Set(['MODEL_IPC_DENIED', 'MODEL_IPC_INVALID', 'CURSOR_EXPIRED',
  'INVALID_REQUEST', 'INVALID_CURSOR', 'POLL_PENDING', 'POLL_ACTIVE', 'POLL_IN_PROGRESS',
  'DENIED', 'CALL_NOT_FOUND', 'DEDUPE_CONFLICT', 'UNKNOWN_REMOTE', 'CALL_ACTIVE',
  'QUOTA_EXCEEDED', 'STORE_UNAVAILABLE', 'STORE_OWNED', 'STORE_FULL']);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
const integer = (value: unknown, max: number, min = 1): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const modelId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function models(value: unknown): value is ModelsGrant {
  if (!exact(value, ['allow', 'maxInputBytes', 'maxOutputBytes', 'maxOutputTokens', 'maxDurationMs', 'maxConcurrent'])
    || !Array.isArray(value.allow) || value.allow.length < 1 || value.allow.length > 50
    || !integer(value.maxInputBytes, 16384) || !integer(value.maxOutputBytes, 32768)
    || !integer(value.maxOutputTokens, 512) || !integer(value.maxDurationMs, 30000)
    || value.maxConcurrent !== 1) return false;
  const seen = new Set<string>();
  return value.allow.every(pair => {
    if (!exact(pair, ['model', 'task']) || !modelId(pair.model) || pair.task !== 'text.generate' || seen.has(pair.model)) return false;
    seen.add(pair.model); return true;
  });
}
function ownerValid(owner: ModelOwner | null): owner is ModelOwner {
  return !!owner && ['profileId', 'installId', 'installRevision', 'grantRevision'].every(key => {
    const value = owner[key as keyof ModelOwner];
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512;
  }) && integer(owner.senderId, Number.MAX_SAFE_INTEGER);
}
function sameOwner(a: ModelOwner, b: ModelOwner): boolean {
  return a.profileId === b.profileId && a.installId === b.installId && a.installRevision === b.installRevision
    && a.grantRevision === b.grantRevision && a.senderId === b.senderId;
}
function validate(op: Op, args: unknown): { token: string; request: Record<string, unknown> } {
  const keys = op === 'start'
    ? ['token', 'model', 'task', 'input', 'maxOutputTokens', 'exportApprovalId', 'clientRequestId']
    : op === 'poll' ? ['token', 'callId', 'afterSeq'] : ['token', 'callId'];
  if (!exact(args, keys) || typeof args.token !== 'string' || !args.token.length || args.token.length > 512) return invalid();
  if (op === 'start') {
    if (!modelId(args.model) || args.task !== 'text.generate' || !exact(args.input, ['text'])
      || typeof args.input.text !== 'string' || !args.input.text.length || Buffer.from(args.input.text, 'utf8').toString('utf8') !== args.input.text
      || Buffer.byteLength(args.input.text, 'utf8') > 16384 || !integer(args.maxOutputTokens, 512)
      || !id(args.exportApprovalId) || typeof args.clientRequestId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,64}$/.test(args.clientRequestId)) return invalid();
  } else if (!id(args.callId) || (op === 'poll' && !integer(args.afterSeq, Number.MAX_SAFE_INTEGER, 0))) return invalid();
  const { token, ...request } = args;
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 24576) return invalid();
  return { token, request };
}

/** Registration injection keeps the offline tests independent of Electron.
 * Production passes the existing registerTileIpc chokepoint, never ipcMain. */
export function registerModelIpc(register: typeof registerTileIpc): void {
  const handler = (op: Op) => async (event: IpcMainInvokeEvent, args: unknown, grant: CapabilityGrant): Promise<unknown> => {
    try {
      const { token, request } = validate(op, args);
      const current = host;
      if (!current || !models(grant.capabilities.models) || event.sender.isDestroyed()) return deny();
      const owner = current.resolveOwner(event, token, grant);
      if (!ownerValid(owner) || owner.senderId !== event.sender.id) return deny();
      const state = current.probe(owner);
      if (!state || !ownerValid(state.owner) || !sameOwner(owner, state.owner)
        || (state.state !== 'ready' && state.state !== 'visible')
        || state.startupAcknowledged !== true || state.profileSelected !== true
        || state.profileUnlocked !== true || state.registryReady !== true || !models(state.grant)) return deny();
      if (op === 'start') {
        for (const cap of [grant.capabilities.models, state.grant]) {
          if (!cap.allow.some(pair => pair.model === request.model && pair.task === request.task)
            || Buffer.byteLength((request.input as { text: string }).text, 'utf8') > cap.maxInputBytes
            || (request.maxOutputTokens as number) > cap.maxOutputTokens) return deny();
        }
      }
      // No await between fresh resolution/probe and broker entry. Broker independently
      // validates every operation and repeats admission checks immediately before send.
      if (host !== current || event.sender.isDestroyed()) return deny();
      return await current.broker[op](owner, request);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new Error(publicErrors.has(code) ? code : 'MODEL_IPC_DENIED');
    }
  };
  const descriptor = { mode: 'handle' as const, requiredCapabilities: ['models' as const],
    stateWindow: ['ready' as const, 'visible' as const] };
  register('tile:models:start', descriptor, handler('start'));
  register('tile:models:poll', descriptor, handler('poll'));
  register('tile:models:cancel', descriptor, handler('cancel'));
  register('tile:models:status', descriptor, handler('status'));
}
