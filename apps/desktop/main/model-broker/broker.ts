import { randomUUID } from 'node:crypto';
import type { BrokerPorts, ModelAccount, ModelApproval, ModelEvent, ModelOwner, ModelRequest, Outcome, RemoteState, Usage } from './contract.js';
import { ownerKey } from './contract.js';
import { admitModels, fail, hashText, validateCall, validateStart } from './policy.js';
import { ModelStore } from './store.js';

type LiveCall = {
  callId: string; owner: ModelOwner; controller: AbortController; deadline: number; accountRevision: string; accountBinding: string; grantBinding: string;
  events: Array<{event: ModelEvent; at: number}>; seq: number; ack: number; delivered: number;
  output: number; outputLimit: number; terminal: boolean; pollPending: boolean; deliveryRevision: number;
};
const accountBinding = (account: ModelAccount): string => hashText(JSON.stringify([
  account.accountId, account.revision, account.url, account.adapter,
  Object.entries(account.models).sort(([a], [b]) => a.localeCompare(b)), account.allocation,
  account.contactApproved, account.acceptsUnverifiedRemoteBounds,
]));
const transportCodes = new Set(['AUTH', 'RATE_LIMIT', 'REQUEST_REJECTED', 'PROVIDER', 'TRANSPORT', 'PROTOCOL', 'TIMEOUT', 'ABORTED', 'LIMIT']);

/** Profile-local offline core. All admission/durability barriers precede the sole adapter call. */
export class ModelBroker {
  private approvals = new Map<string, ModelApproval>();
  private live: LiveCall | null = null;
  private closed = false;
  private failed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly ports: BrokerPorts, private readonly store: ModelStore) {
    if (ports.offline !== true) fail();
    this.timer = setInterval(() => this.tick(), 50);
    this.timer.unref?.();
  }
  /** Host-only explicit selected snapshot approval. Never registered as tile IPC. */
  approve(owner: ModelOwner, text: string): string {
    this.guard();
    const { account, state } = admitModels(this.ports, owner);
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > state.grant!.maxInputBytes
      || Buffer.from(text).toString('utf8') !== text) return fail('INVALID_REQUEST');
    const now = this.ports.now();
    for (const [id, approval] of this.approvals) if (approval.expiresAt <= now) this.approvals.delete(id);
    if (this.approvals.size >= 100) return fail('QUOTA_EXCEEDED');
    const id = randomUUID();
    this.approvals.set(id, { id, owner: ownerKey(owner), accountRevision: account.revision,
      accountBinding: accountBinding(account), textHash: hashText(text), inputBytes: Buffer.byteLength(text), purpose: 'text.generate', expiresAt: now + 60_000 });
    return id;
  }
  async start(owner: ModelOwner, input: unknown): Promise<{callId: string}> {
    this.guard();
    const request = validateStart(input);
    const { account, state } = admitModels(this.ports, owner);
    const grant = state.grant!;
    if (!grant.allow.some(pair => pair.model === request.model && pair.task === request.task)
      || !Object.hasOwn(account.models, request.model) || Buffer.byteLength(request.input.text) > grant.maxInputBytes
      || request.maxOutputTokens > grant.maxOutputTokens) return fail();
    const binding = accountBinding(account);
    const requestHash = hashText(JSON.stringify([request, binding]));
    const existing = this.store.find(ownerKey(owner), request.clientRequestId);
    if (existing) {
      if (existing.requestHash !== requestHash) return fail('DEDUPE_CONFLICT');
      return { callId: existing.callId };
    }
    const approval = this.approvals.get(request.exportApprovalId);
    if (!approval || approval.owner !== ownerKey(owner) || approval.accountRevision !== account.revision
      || approval.accountBinding !== binding
      || approval.expiresAt <= this.ports.now() || approval.textHash !== hashText(request.input.text)
      || approval.inputBytes !== Buffer.byteLength(request.input.text)) return fail();
    const key = this.ports.vault.get(account.accountId);
    if (!key) return fail();
    const reservation = this.store.prepare({ callId: randomUUID(), owner: ownerKey(owner),
      clientRequestId: request.clientRequestId, requestHash, inputBytes: approval.inputBytes,
      outputBytes: grant.maxOutputBytes, maxOutputTokens: request.maxOutputTokens,
      maxDurationMs: grant.maxDurationMs, accountRevision: account.revision });
    if (!reservation.fresh) return { callId: reservation.callId };
    // Synchronous admission makes approval consumption and durable prepare indivisible
    // to other windows in this process. A crash loses approvals, never replays intent.
    this.approvals.delete(request.exportApprovalId);
    this.live = { callId: reservation.callId, owner: { ...owner }, controller: new AbortController(),
      deadline: this.ports.now() + grant.maxDurationMs, accountRevision: account.revision,
      accountBinding: binding, grantBinding: JSON.stringify(grant),
      events: [], seq: 0, ack: 0, delivered: 0, output: 0, outputLimit: grant.maxOutputBytes,
      terminal: false, pollPending: false, deliveryRevision: 0 };
    const call = this.live;
    try {
      const fresh = admitModels(this.ports, owner);
      if (accountBinding(fresh.account) !== binding || JSON.stringify(fresh.state.grant) !== JSON.stringify(grant)
        || fresh.account.url !== account.url || !this.ports.vault.available()) fail();
      this.store.dispatch(call.callId);
    } catch {
      this.finish(call, 'aborted', 'not-sent', null, 'REVOKED');
      return { callId: call.callId };
    }
    // No retry, fallback, discovery, receipt lookup or automatic re-approval.
    void this.run(call, request, account.url, account.models[request.model], key);
    return { callId: call.callId };
  }
  private async run(call: LiveCall, request: ModelRequest, url: string, wireModel: string, key: string): Promise<void> {
    try {
      const result = await this.ports.adapter.run({ url, wireModel, key, text: request.input.text,
        maxOutputTokens: request.maxOutputTokens }, call.controller.signal, text => this.delta(call, text));
      if (!this.accept(call)) return;
      this.finish(call, result.outcome, 'finished', result.usage, null);
    } catch (error) {
      if (call.terminal) return;
      const code = error instanceof Error && transportCodes.has(error.message) ? error.message : 'TRANSPORT';
      this.finish(call, 'failed', 'unknown', null, code === 'LIMIT' ? 'OUTPUT_LIMIT' : code);
    }
  }
  private accept(call: LiveCall): boolean {
    if (this.closed || this.failed || call.terminal || this.live !== call) return false;
    if (this.ports.now() >= call.deadline) { this.abort(call, 'TIMEOUT'); return false; }
    try {
      const {account, state} = admitModels(this.ports, call.owner);
      if (accountBinding(account) !== call.accountBinding || JSON.stringify(state.grant) !== call.grantBinding) throw new Error('DENIED');
    } catch { this.cancelOwner(call.owner, 'REVOKED'); return false; }
    return true;
  }
  private delta(call: LiveCall, text: string): void {
    if (!this.accept(call)) return;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || Buffer.from(text).toString('utf8') !== text
      || call.output + Buffer.byteLength(text) > call.outputLimit) { this.abort(call, 'OUTPUT_LIMIT'); return; }
    const event: ModelEvent = { callId: call.callId, seq: call.seq + 1, kind: 'delta', text };
    if (call.events.length >= 15 || this.ringBytes(call) + Buffer.byteLength(JSON.stringify(event)) > 63 * 1024) {
      this.abort(call, 'SLOW_CONSUMER'); return;
    }
    call.output += Buffer.byteLength(text);
    call.seq++;
    call.events.push({event, at: this.ports.now()});
  }
  private ringBytes(call: LiveCall): number {
    return call.events.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.event)), 0);
  }
  private finish(call: LiveCall, outcome: Outcome, remoteState: RemoteState, usage: Usage|null, errorCode: string|null): void {
    if (call.terminal) return;
    // Terminal must be durable before it is visible. Storage failure clears all
    // content, aborts transport and leaves dispatching for conservative recovery.
    try { this.store.terminal(call.callId, {localState: outcome, remoteState, usage, errorCode}); }
    catch { this.failed = true; call.events = []; call.terminal = true; call.controller.abort(); return; }
    call.terminal = true;
    call.controller.abort();
    const event: ModelEvent = {callId: call.callId, seq: ++call.seq, kind: 'terminal', outcome, remoteState, usage, errorCode};
    call.events.push({event, at: this.ports.now()});
  }
  private abort(call: LiveCall, reason: string): void {
    this.finish(call, 'aborted', 'unknown', null, reason);
  }
  async poll(owner: ModelOwner, input: unknown): Promise<{events: ModelEvent[]; lastSeq: number}> {
    const args = validateCall(input, true);
    this.authorizeCall(owner, args.callId);
    const call = this.live;
    if (!call || call.callId !== args.callId) {
      if (args.afterSeq === 0) return { events: [], lastSeq: 0 };
      return fail('CURSOR_EXPIRED');
    }
    if (call.pollPending) return fail('POLL_PENDING');
    call.pollPending = true;
    const deliveryRevision = call.deliveryRevision;
    try {
      if (args.afterSeq < call.ack) return fail('CURSOR_EXPIRED');
      if (args.afterSeq > call.delivered) return fail('INVALID_CURSOR');
      call.ack = args.afterSeq;
      call.events = call.events.filter(item => item.event.seq > call.ack);
      const events: ModelEvent[] = [];
      for (const item of call.events) {
        if (events.length >= 8 || Buffer.byteLength(JSON.stringify({ events: [...events, item.event], lastSeq: item.event.seq })) > 32768) break;
        events.push(structuredClone(item.event));
      }
      const lastSeq = events.at(-1)?.seq ?? call.ack;
      call.delivered = Math.max(call.delivered, lastSeq);
      // Keep the pending guard through one promise turn; concurrent invocations deny.
      await Promise.resolve();
      this.authorizeCall(owner, args.callId);
      if (call.deliveryRevision !== deliveryRevision || this.live !== call) return fail();
      return { events, lastSeq };
    } finally { call.pollPending = false; }
  }
  status(owner: ModelOwner, input: unknown) {
    const {callId} = validateCall(input);
    const call = this.authorizeCall(owner, callId);
    return {callId, localState: call.localState, remoteState: call.remoteState, usage: call.usage, errorCode: call.errorCode};
  }
  cancel(owner: ModelOwner, input: unknown) {
    const {callId} = validateCall(input);
    this.authorizeCall(owner, callId);
    if (this.live?.callId === callId && !this.live.terminal) this.abort(this.live, 'CANCELLED');
    const {localState, remoteState} = this.status(owner, input);
    return {callId, localState, remoteState};
  }
  private authorizeCall(owner: ModelOwner, callId: string) {
    this.guard();
    const { account, state } = admitModels(this.ports, owner);
    if (this.live?.callId === callId && (!this.live.terminal || this.live.events.length > 0)
      && (accountBinding(account) !== this.live.accountBinding
      || JSON.stringify(state.grant) !== this.live.grantBinding)) this.cancelOwner(owner, 'REVOKED');
    const call = this.store.status(callId);
    if (!call || call.owner !== ownerKey(owner)) return fail('CALL_NOT_FOUND');
    return call;
  }
  /** Host-only lifecycle cleanup: cannot admit any requests or bypass start. */
  cancelOwner(owner: ModelOwner, reason = 'LIFECYCLE'): void {
    if (this.live && ownerKey(this.live.owner) === ownerKey(owner)) {
      if (!this.live.terminal) this.abort(this.live, reason);
      this.live.events = [];
      this.live.deliveryRevision++;
    }
    for (const [id, approval] of this.approvals) if (approval.owner === ownerKey(owner)) this.approvals.delete(id);
  }
  invalidateApprovals(): void {
    this.approvals.clear();
    if (this.live) this.cancelOwner(this.live.owner);
  }
  sleep(): void { if (this.live) this.cancelOwner(this.live.owner, 'SLEEP'); }
  private tick(): void {
    const call = this.live;
    if (!call || this.closed || this.failed) return;
    if (!call.terminal) {
      if (!this.accept(call)) return;
      const first = call.events[0];
      if (first && this.ports.now() - first.at >= 5000) this.abort(call, 'SLOW_CONSUMER');
    } else if (call.events.length && this.ports.now() - call.events.at(-1)!.at >= 5000) {
      call.ack = call.seq; call.events = [];
    }
  }
  private guard(): void { if (this.closed || this.failed) fail('STORE_UNAVAILABLE'); }
  close(): void {
    if (this.closed) return;
    this.invalidateApprovals(); this.ports.vault.clear(); this.closed = true;
    clearInterval(this.timer); this.live = null; this.store.close();
  }
}
