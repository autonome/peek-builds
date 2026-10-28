import { randomUUID } from 'node:crypto';
import type { ModelAccount, ModelOwner } from './contract.js';
import type { ModelBroker } from './broker.js';

export interface SelectionEvent { sender: object; senderFrame: object }
export interface SelectionHarnessPorts {
  broker: ModelBroker;
  trustedSender: { readonly mainFrame: object; isDestroyed(): boolean };
  owner: ModelOwner;
  /** Same authoritative host account source supplied to the broker; never renderer config. */
  account(): ModelAccount | null;
  model: string;
  maxOutputTokens: number;
}
const denied = (): never => { throw new Error('SELECTION_DENIED'); };
const escape = (text: string): string => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const disclosure = 'Offline test only; unpriced owned compute. Remote token, queue, compute and cancellation bounds are unverified. Local abort does not prove remote work stopped.';

/** Test-only host controller. No IPC registration, transport, credentials or panel configuration.
 * present() is an explicit selected snapshot, never a page/profile reader. approve()
 * must be a separate trusted user action after presenting that exact view.
 */
export class SelectionHarness {
  private readonly ports: SelectionHarnessPorts;
  private snapshot: { id: string; text: string; account: ModelAccount; approval: string | null } | null = null;
  private callId: string | null = null;
  private afterSeq = 0;
  private output = '';
  private starting = false;
  private polling = false;
  constructor(ports: SelectionHarnessPorts) {
    this.ports = { ...ports, owner: { ...ports.owner } };
  }
  private authorize(event: SelectionEvent): void {
    if (!event || event.sender !== this.ports.trustedSender || this.ports.trustedSender.isDestroyed()
      || event.senderFrame !== this.ports.trustedSender.mainFrame) denied();
  }
  private current(id: string) {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== id || JSON.stringify(this.ports.account()) !== JSON.stringify(snapshot.account)) return denied();
    return snapshot;
  }
  present(event: SelectionEvent, selectedText: string) {
    this.authorize(event);
    if (this.starting || this.callId || typeof selectedText !== 'string' || !selectedText.length
      || Buffer.byteLength(selectedText) > 16384 || Buffer.from(selectedText).toString('utf8') !== selectedText) return denied();
    const account = this.ports.account();
    if (!account || account.allocation !== 'unpriced-owned' || !account.contactApproved
      || !account.acceptsUnverifiedRemoteBounds || !Object.hasOwn(account.models, this.ports.model)) return denied();
    this.snapshot = { id: randomUUID(), text: selectedText, account: structuredClone(account), approval: null };
    return this.view(event);
  }
  approve(event: SelectionEvent, presentationId: string): void {
    this.authorize(event);
    if (this.starting || this.callId) return denied();
    const snapshot = this.current(presentationId);
    if (snapshot.approval) return denied();
    snapshot.approval = this.ports.broker.approve(this.ports.owner, snapshot.text);
  }
  async start(event: SelectionEvent, presentationId: string): Promise<{ callId: string }> {
    this.authorize(event);
    if (this.starting || this.callId) return denied();
    const snapshot = this.current(presentationId);
    if (!snapshot.approval) return denied();
    this.starting = true;
    try {
      const result = await this.ports.broker.start(this.ports.owner, {
        model: this.ports.model, task: 'text.generate', input: { text: snapshot.text },
        maxOutputTokens: this.ports.maxOutputTokens, exportApprovalId: snapshot.approval,
        clientRequestId: snapshot.id,
      });
      this.authorize(event);
      this.callId = result.callId;
      snapshot.approval = null;
      return result;
    } finally { this.starting = false; }
  }
  async poll(event: SelectionEvent): Promise<void> {
    this.authorize(event);
    if (!this.callId || this.polling) return denied();
    this.polling = true;
    try {
      const result = await this.ports.broker.poll(this.ports.owner, { callId: this.callId, afterSeq: this.afterSeq });
      this.authorize(event);
      for (const item of result.events) {
        if (item.seq <= this.afterSeq) continue;
        if (item.kind === 'delta') {
          if (Buffer.byteLength(this.output) + Buffer.byteLength(item.text) > 32768) {
            this.ports.broker.cancel(this.ports.owner, { callId: this.callId });
            return denied();
          }
          this.output += item.text;
        }
        this.afterSeq = item.seq;
      }
    } finally { this.polling = false; }
  }
  cancel(event: SelectionEvent) {
    this.authorize(event);
    if (!this.callId) return denied();
    return this.ports.broker.cancel(this.ports.owner, { callId: this.callId });
  }
  /** Metadata-only reopen, including after broker/store restart. Never retries or restores content. */
  status(event: SelectionEvent, callId: string) {
    this.authorize(event);
    return this.ports.broker.status(this.ports.owner, { callId });
  }
  view(event: SelectionEvent) {
    this.authorize(event);
    const snapshot = this.snapshot;
    return {
      presentationId: snapshot?.id ?? null,
      selectedText: snapshot?.text ?? '', destination: snapshot?.account.url ?? null,
      accountRevision: snapshot?.account.revision ?? null, model: this.ports.model,
      wireModel: snapshot?.account.models[this.ports.model] ?? null,
      allocation: snapshot?.account.allocation ?? null,
      acceptsUnverifiedRemoteBounds: snapshot?.account.acceptsUnverifiedRemoteBounds ?? false,
      disclosure, productionNetworkEnabled: false as const,
      output: this.output,
      status: this.callId ? this.status(event, this.callId) : null,
      // Only fixed markup plus escaped text nodes. Never markdown, HTML passthrough,
      // scripts, links, tools, datastore commands or provider-supplied attributes.
      html: `<section><p>${escape(disclosure)}</p><pre>${escape(snapshot?.account.url ?? '')}</pre><pre>${escape(snapshot?.text ?? '')}</pre><pre>${escape(this.output)}</pre></section>`,
    };
  }
}
