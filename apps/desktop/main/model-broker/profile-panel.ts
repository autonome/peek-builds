import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountVault, ModelAccount } from './contract.js';

export interface TrustedPanelSender {
  readonly mainFrame: object;
  isDestroyed(): boolean;
}
export interface PanelEvent { sender: object; senderFrame: object }
export interface UnknownWorkStore {
  hasUnknown(): boolean;
  acknowledgeUnknown(): void;
}
export interface ProfileConfiguration {
  accountId: string;
  label: string;
  revisionLabel: string;
  url: string;
  adapter: 'openai-text-v1';
  models: Record<string, string>;
  allocation: 'unpriced-owned';
  contactApproved: true;
  acceptsUnverifiedRemoteBounds: true;
}
type Metadata = ProfileConfiguration & { revision: string };
export interface ModelProfilePanelPorts {
  profilePath: string;
  trustedSender: TrustedPanelSender;
  vault: AccountVault & { unlock?(): void };
  store: UnknownWorkStore;
  /** Synchronously revoke approvals and cancel existing work before any change. */
  invalidateApprovals(): void;
}
const invalid = (): never => { throw new Error('MODEL_PANEL_INVALID'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const obj = object(value);
  if (Object.keys(obj).length !== keys.length || keys.some(key => !Object.hasOwn(obj, key))) return invalid();
  return obj;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max ||
      /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
const CONFIG_KEYS = ['accountId', 'label', 'revisionLabel', 'url', 'adapter', 'models',
  'allocation', 'contactApproved', 'acceptsUnverifiedRemoteBounds'];
function validate(value: unknown): ProfileConfiguration {
  const obj = exact(value, CONFIG_KEYS);
  const accountId = text(obj.accountId, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(accountId)) return invalid();
  const url = text(obj.url, 2048);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return invalid(); }
  // Do not canonicalize, infer a path, or permit test HTTP in persisted profiles.
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash || url.includes('?') || url.includes('#') ||
      !/^https:\/\/[^/?#@]+(?:\/|$)/.test(url) || /\s|\\/.test(url)) return invalid();
  if (obj.adapter !== 'openai-text-v1' || obj.allocation !== 'unpriced-owned' ||
      obj.contactApproved !== true || obj.acceptsUnverifiedRemoteBounds !== true) return invalid();
  const mappings = object(obj.models);
  if (Object.keys(mappings).length < 1 || Object.keys(mappings).length > 50) return invalid();
  const models: Record<string, string> = Object.create(null);
  for (const [local, wire] of Object.entries(mappings)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(local) || ['constructor', 'prototype'].includes(local)) return invalid();
    models[local] = text(wire, 256);
  }
  return { accountId, label: text(obj.label, 128), revisionLabel: text(obj.revisionLabel, 128),
    url, adapter: 'openai-text-v1', models, allocation: 'unpriced-owned',
    contactApproved: true, acceptsUnverifiedRemoteBounds: true };
}

/** Offline host-owned controller/port, NOT a shipped Electron window or renderer.
 * Bind only to a dedicated trusted host window. Neither builtin nor tile identity
 * authorizes this port. All presentation values are data, never HTML.
 */
export class ModelProfilePanel {
  private locked = true;
  private metadata: Metadata | null = null;
  private readonly file: string;
  constructor(private readonly ports: ModelProfilePanelPorts) {
    this.file = path.join(ports.profilePath, 'model-broker', 'profile.json');
    try {
      const stat = fs.statSync(this.file);
      if (stat.size > 64 * 1024) return invalid();
      const stored = exact(JSON.parse(fs.readFileSync(this.file, 'utf8')), [...CONFIG_KEYS, 'revision']);
      const { revision, ...config } = stored;
      if (typeof revision !== 'string' || !/^[a-f0-9-]{36}$/.test(revision)) return invalid();
      this.metadata = { ...validate(config), revision };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MODEL_PANEL_STORAGE');
    }
  }
  /** Host lifecycle methods, not renderer commands. */
  unlock(): void {
    this.ports.vault.unlock?.();
    this.locked = false;
  }
  lock(): void {
    this.locked = true;
    this.ports.vault.clear();
    this.ports.invalidateApprovals();
  }
  account(): ModelAccount | null {
    if (this.locked || !this.ports.vault.available() || !this.metadata) return null;
    const { accountId, revision, url, adapter, models, allocation, contactApproved,
      acceptsUnverifiedRemoteBounds } = this.metadata;
    return { accountId, revision, url, adapter, models: { ...models }, allocation,
      contactApproved, acceptsUnverifiedRemoteBounds };
  }
  view(event: PanelEvent) {
    this.authorize(event);
    return {
      configuration: this.metadata ? structuredClone(this.metadata) : null,
      secureStorageAvailable: this.ports.vault.available(),
      remoteUnknown: this.ports.store.hasUnknown(),
      productionNetworkEnabled: false as const,
      disclosure: 'Offline configuration only. Local quotas do not bound remote queue, compute, tokens or cancellation. Other applications and profiles are outside Peek quotas. A local abort does not prove remote work stopped.',
    };
  }
  configure(event: PanelEvent, input: unknown): void {
    this.authorize(event);
    if (!this.ports.vault.available()) throw new Error('MODEL_PANEL_SECURE_STORAGE');
    const metadata = { ...validate(input), revision: randomUUID() };
    this.replace(metadata);
  }
  setKey(event: PanelEvent, input: unknown): void {
    this.authorize(event);
    const { key, allocation, contactApproved, acceptsUnverifiedRemoteBounds } = exact(input,
      ['key', 'allocation', 'contactApproved', 'acceptsUnverifiedRemoteBounds']);
    if (allocation !== 'unpriced-owned' || contactApproved !== true || acceptsUnverifiedRemoteBounds !== true ||
        typeof key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(key) || !this.metadata) return invalid();
    if (!this.ports.vault.available()) throw new Error('MODEL_PANEL_SECURE_STORAGE');
    const metadata = { ...this.metadata, revision: randomUUID() };
    this.ports.invalidateApprovals();
    this.metadata = null;
    try {
      this.ports.vault.set(metadata.accountId, key);
      this.persist(metadata);
      this.metadata = metadata;
    } catch { this.lock(); throw new Error('MODEL_PANEL_STORAGE'); }
  }
  acknowledgeUnknown(event: PanelEvent, input: unknown): void {
    this.authorize(event);
    const obj = exact(input, ['acceptUnresolvedRemoteWork']);
    if (obj.acceptUnresolvedRemoteWork !== true) return invalid();
    this.ports.invalidateApprovals();
    this.ports.store.acknowledgeUnknown();
  }
  private authorize(event: PanelEvent): void {
    if (this.locked || !event || event.sender !== this.ports.trustedSender ||
        this.ports.trustedSender.isDestroyed() || event.senderFrame !== this.ports.trustedSender.mainFrame) {
      throw new Error('MODEL_PANEL_DENIED');
    }
  }
  private replace(metadata: Metadata): void {
    this.ports.invalidateApprovals();
    this.metadata = null;
    try { this.persist(metadata); this.metadata = metadata; }
    catch { this.lock(); throw new Error('MODEL_PANEL_STORAGE'); }
  }
  private persist(metadata: Metadata): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
}
