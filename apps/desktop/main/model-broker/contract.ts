import type { ModelsGrant } from '../../../../packages/capabilities/index.js';

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };
export type Outcome = 'completed' | 'truncated' | 'refused' | 'failed' | 'aborted';
export type RemoteState = 'finished' | 'unknown' | 'not-sent';
export interface ModelRequest {
  model: string; task: 'text.generate'; input: { text: string }; maxOutputTokens: number;
  exportApprovalId: string; clientRequestId: string;
}
export interface ModelOwner {
  profileId: string; installId: string; installRevision: string; grantRevision: string; senderId: number;
}
export type ModelEvent = { callId: string; seq: number; kind: 'delta'; text: string } |
  { callId: string; seq: number; kind: 'terminal'; outcome: Outcome; remoteState: RemoteState;
    usage: Usage | null; errorCode: string | null };
export interface ModelAccount {
  accountId: string; revision: string; url: string; adapter: 'openai-text-v1';
  models: Record<string, string>; allocation: 'unpriced-owned';
  contactApproved: boolean; acceptsUnverifiedRemoteBounds: boolean;
}
export interface ModelApproval {
  id: string; owner: string; accountRevision: string; accountBinding: string; textHash: string; inputBytes: number;
  purpose: 'text.generate'; expiresAt: number;
}
export interface ModelState {
  owner: ModelOwner; state: string | null; startupAcknowledged: boolean; profileSelected: boolean;
  profileUnlocked: boolean; registryReady: boolean; grant: ModelsGrant | undefined;
}
export interface ModelAdapter {
  run(config: {url: string; key: string; wireModel: string; text: string; maxOutputTokens: number},
    signal: AbortSignal, onDelta: (text: string) => void): Promise<{outcome: 'completed'|'truncated'|'refused'; usage: Usage|null}>;
}
export interface AccountVault {
  available(): boolean; get(accountId: string): string | null; set(accountId: string, key: string): void; clear(): void;
}
export interface BrokerPorts {
  now(): number;
  /** Real host probe. Missing state or revisions always deny, including builtins. */
  probe(owner: ModelOwner): ModelState | null;
  account(): ModelAccount | null;
  vault: AccountVault;
  adapter: ModelAdapter;
  /** No production transport is enabled by this implementation. */
  offline: true;
}
export const ownerKey = (owner: ModelOwner): string => JSON.stringify([
  owner.profileId, owner.installId, owner.installRevision, owner.grantRevision, owner.senderId,
]);
