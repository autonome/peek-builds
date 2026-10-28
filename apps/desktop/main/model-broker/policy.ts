import { createHash } from 'node:crypto';
import type { BrokerPorts, ModelAccount, ModelOwner, ModelRequest, ModelState } from './contract.js';
import { ownerKey } from './contract.js';
import { validateTileManifest } from '../../../../packages/capabilities/index.js';

export const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const fail = (code = 'DENIED'): never => { throw new Error(code); };
export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && own.every(key => typeof key === 'string' && !Object.getOwnPropertyDescriptor(value, key)?.get
      && !Object.getOwnPropertyDescriptor(value, key)?.set);
}
export const identifier = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
export function validateStart(value: unknown): ModelRequest {
  if (!exact(value, ['model', 'task', 'input', 'maxOutputTokens', 'exportApprovalId', 'clientRequestId'])
    || !identifier(value.model) || value.task !== 'text.generate' || !exact(value.input, ['text'])
    || typeof value.input.text !== 'string' || !value.input.text.length
    || Buffer.from(value.input.text, 'utf8').toString('utf8') !== value.input.text
    || Buffer.byteLength(value.input.text, 'utf8') > 16384
    || !Number.isSafeInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 1
    || (value.maxOutputTokens as number) > 512 || !identifier(value.exportApprovalId)
    || !identifier(value.clientRequestId, 64) || Buffer.byteLength(JSON.stringify(value)) > 24576) return fail('INVALID_REQUEST');
  // Copy the approved schema so subsequent caller mutation cannot change the send.
  return { model: value.model, task: 'text.generate', input: { text: value.input.text },
    maxOutputTokens: value.maxOutputTokens as number, exportApprovalId: value.exportApprovalId,
    clientRequestId: value.clientRequestId };
}
export function validateCall(value: unknown, poll = false): {callId: string; afterSeq: number} {
  if (!exact(value, poll ? ['callId', 'afterSeq'] : ['callId']) || !identifier(value.callId)
    || (poll && (!Number.isSafeInteger(value.afterSeq) || (value.afterSeq as number) < 0))) return fail('INVALID_REQUEST');
  return { callId: value.callId, afterSeq: poll ? value.afterSeq as number : 0 };
}
export function validOwner(owner: ModelOwner): boolean {
  return !!owner && ['profileId', 'installId', 'installRevision', 'grantRevision'].every(key => {
    const value = owner[key as keyof ModelOwner];
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512;
  }) && Number.isSafeInteger(owner.senderId) && owner.senderId > 0;
}
export function admitModels(ports: BrokerPorts, owner: ModelOwner): { state: ModelState; account: ModelAccount } {
  if (ports.offline !== true || !validOwner(owner)) return fail();
  const state = ports.probe(owner);
  const account = ports.account();
  if (!state || ownerKey(state.owner) !== ownerKey(owner) || !['ready', 'visible'].includes(state.state ?? '')
    || state.startupAcknowledged !== true || state.profileSelected !== true || state.profileUnlocked !== true
    || state.registryReady !== true || !state.grant || validateTileManifest({ id: 'model-policy', name: 'model-policy', tiles: [], capabilities: { models: state.grant } }).length
    || !ports.vault.available() || !account || account.allocation !== 'unpriced-owned'
    || !account.contactApproved || !account.acceptsUnverifiedRemoteBounds || account.adapter !== 'openai-text-v1'
    || !identifier(account.accountId) || !identifier(account.revision)) return fail();
  let url: URL;
  try { url = new URL(account.url); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /[?#\\\s]/.test(account.url)) return fail();
  return { state, account: structuredClone(account) };
}
