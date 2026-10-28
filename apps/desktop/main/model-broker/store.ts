import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ModelReservation {
  callId: string;
  /** Canonical host-serialized profile/install/grant/sender identity. */
  owner: string;
  clientRequestId: string;
  requestHash: string;
  inputBytes: number;
  outputBytes: number;
  maxOutputTokens: number;
  maxDurationMs: number;
  accountRevision: string;
}
export interface ModelTerminal {
  localState: string;
  remoteState: string;
  usage: unknown;
  errorCode: string | null;
}
export interface ModelCallMetadata extends ModelReservation, ModelTerminal {
  state: 'prepared' | 'dispatching' | 'terminal';
  createdAt: number;
  updatedAt: number;
}
export type ModelStoreErrorCode = 'STORE_UNAVAILABLE' | 'STORE_OWNED' | 'INVALID_RECORD'
  | 'DEDUPE_CONFLICT' | 'UNKNOWN_REMOTE' | 'QUOTA_EXCEEDED' | 'STORE_FULL'
  | 'CALL_ACTIVE' | 'CALL_NOT_FOUND' | 'INVALID_TRANSITION';

/** Fixed codes only: SQLite errors, paths and caller data never escape. */
export class ModelStoreError extends Error {
  readonly code: ModelStoreErrorCode;
  constructor(code: ModelStoreErrorCode) {
    super(code);
    this.name = 'ModelStoreError';
    this.code = code;
  }
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETENTION = 30 * DAY;
const terminalStates = new Set(['completed', 'truncated', 'refused', 'failed', 'aborted']);
const errorCodes = new Set([
  'AUTH', 'RATE_LIMIT', 'REQUEST_REJECTED', 'PROVIDER', 'TRANSPORT', 'PROTOCOL',
  'CANCELLED', 'CANCELED', 'TIMEOUT', 'DEADLINE', 'HEADERS_TIMEOUT', 'SLOW_CONSUMER',
  'OUTPUT_LIMIT', 'WIRE_LIMIT', 'REVOKED', 'PROFILE_LOCKED', 'PROFILE_SWITCH',
  'SUSPENDED', 'UNLOADED', 'SLEEP', 'SHUTDOWN', 'RECOVERED', 'STORAGE',
  'STORE_UNAVAILABLE', 'INTERNAL', 'OWNER_GONE', 'LIFECYCLE', 'ABORTED',
]);
function invalid(): never { throw new ModelStoreError('INVALID_RECORD'); }
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) invalid();
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
}
/** Persist only numeric token counters, never arbitrary provider objects/messages. */
function safeUsage(value: unknown): Record<string, number> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = new Set(['promptTokens', 'completionTokens', 'totalTokens']);
  if (Object.keys(value).length !== 3 || ![...allowed].every(key => Object.hasOwn(value, key))) invalid();
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!allowed.has(key)) invalid();
    integer(count, Number.MAX_SAFE_INTEGER);
    result[key] = count;
  }
  return result;
}

/** Metadata-only, single-owner store. All methods are synchronous durability barriers. */
export class ModelStore {
  private db!: DatabaseSync;
  private ownership!: DatabaseSync;
  private now: () => number;
  private closed = false;
  private failed = false;

  constructor(profileDir: string, now: () => number = Date.now) {
    this.now = now;
    let owner: DatabaseSync | undefined;
    let db: DatabaseSync | undefined;
    let locking = false;
    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      // Never unlink this sidecar: the transaction (not file existence) owns it.
      owner = new DatabaseSync(join(profileDir, 'model-broker-owner.sqlite'));
      owner.exec('PRAGMA busy_timeout=0;');
      locking = true;
      owner.exec('BEGIN EXCLUSIVE;');
      locking = false;
      db = new DatabaseSync(join(profileDir, 'model-broker.sqlite'));
      db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS model_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
          highwater INTEGER NOT NULL, unknown_latch INTEGER NOT NULL);
        INSERT OR IGNORE INTO model_meta VALUES(1,1,0,0);
        CREATE TABLE IF NOT EXISTS model_calls (
          call_id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_key TEXT NOT NULL,
          request_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          state TEXT NOT NULL, metadata TEXT NOT NULL, UNIQUE(owner, client_key));
        CREATE TABLE IF NOT EXISTS model_quota (
          period TEXT NOT NULL, bucket INTEGER NOT NULL, calls INTEGER NOT NULL,
          input_bytes INTEGER NOT NULL, output_bytes INTEGER NOT NULL,
          PRIMARY KEY(period,bucket));`);
      this.db = db;
      this.ownership = owner;
      const version = db.prepare('SELECT version FROM model_meta WHERE id=1').get();
      if (version?.version !== 1) throw new ModelStoreError('STORE_UNAVAILABLE');
      this.transaction(() => {
        const time = this.clock();
        const rows = this.db.prepare("SELECT metadata FROM model_calls WHERE state != 'terminal'").all();
        for (const row of rows) {
          const call = JSON.parse(row.metadata as string) as ModelCallMetadata;
          const dispatched = call.state === 'dispatching';
          call.state = 'terminal';
          call.localState = 'aborted';
          call.remoteState = dispatched ? 'unknown' : 'not-sent';
          call.errorCode = 'RECOVERED';
          call.updatedAt = time;
          this.save(call);
          if (dispatched) this.latch();
        }
      });
      this.maintain();
    } catch (error) {
      try { db?.close(); } catch { /* preserve redaction */ }
      try { owner?.close(); } catch { /* preserve redaction */ }
      throw new ModelStoreError(locking ? 'STORE_OWNED' : 'STORE_UNAVAILABLE');
    }
  }

  private guard<T>(operation: () => T): T {
    if (this.closed || this.failed) throw new ModelStoreError('STORE_UNAVAILABLE');
    try { return operation(); } catch (error) {
      if (error instanceof ModelStoreError) throw error;
      this.failed = true;
      throw new ModelStoreError('STORE_UNAVAILABLE');
    }
  }
  private transaction<T>(operation: () => T): T {
    return this.guard(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { this.failed = true; }
        throw error;
      }
    });
  }
  private clock(): number {
    const wall = this.now();
    if (!Number.isSafeInteger(wall) || wall < 0) throw new ModelStoreError('STORE_UNAVAILABLE');
    const previous = this.db.prepare('SELECT highwater FROM model_meta WHERE id=1').get();
    if (!previous) throw new Error('metadata');
    const time = Math.max(wall, Number(previous.highwater));
    this.db.prepare('UPDATE model_meta SET highwater=? WHERE id=1').run(time);
    return time;
  }
  private latch(): void {
    this.db.exec('UPDATE model_meta SET unknown_latch=1 WHERE id=1');
  }
  private get(callId: string): ModelCallMetadata | undefined {
    const row = this.db.prepare('SELECT metadata FROM model_calls WHERE call_id=?').get(callId);
    return row ? JSON.parse(row.metadata as string) as ModelCallMetadata : undefined;
  }
  private save(call: ModelCallMetadata): void {
    this.db.prepare('UPDATE model_calls SET state=?, updated_at=?, metadata=? WHERE call_id=?')
      .run(call.state, call.updatedAt, JSON.stringify(call), call.callId);
  }

  private maintain(): void {
    this.transaction(() => {
      const time = this.clock();
      this.db.prepare("DELETE FROM model_calls WHERE state='terminal' AND created_at <= ?").run(time - RETENTION);
      this.db.prepare("DELETE FROM model_quota WHERE (period='day' AND bucket < ?) OR (period='hour' AND bucket < ?)")
        .run(Math.floor((time - RETENTION) / DAY), Math.floor((time - RETENTION) / HOUR));
    });
  }

  prepare(record: ModelReservation): { callId: string; fresh: boolean } {
    // Maintenance/high-water survives even when admission is refused by a latch or quota.
    this.maintain();
    return this.transaction(() => {
      text(record.callId, 256); text(record.owner, 4096); text(record.clientRequestId, 256);
      text(record.requestHash, 256); text(record.accountRevision, 256);
      integer(record.inputBytes, 16 * 1024); integer(record.outputBytes, 32 * 1024);
      integer(record.maxOutputTokens, 512); integer(record.maxDurationMs, 30_000);
      if (!record.maxOutputTokens || !record.maxDurationMs) invalid();
      const time = this.clock();
      const existing = this.db.prepare('SELECT metadata FROM model_calls WHERE owner=? AND client_key=?')
        .get(record.owner, record.clientRequestId);
      if (existing) {
        const old = JSON.parse(existing.metadata as string) as ModelCallMetadata;
        // The host hash commits the complete approved request/configuration. A
        // duplicate is a lookup, not a new reservation or permission to dispatch.
        if (old.requestHash !== record.requestHash) {
          throw new ModelStoreError('DEDUPE_CONFLICT');
        }
        return { callId: old.callId, fresh: false };
      }
      if (this.get(record.callId)) throw new ModelStoreError('DEDUPE_CONFLICT');
      if (this.db.prepare('SELECT unknown_latch FROM model_meta WHERE id=1').get()?.unknown_latch !== 0) {
        throw new ModelStoreError('UNKNOWN_REMOTE');
      }
      if (this.db.prepare("SELECT 1 FROM model_calls WHERE state!='terminal' LIMIT 1").get()) {
        throw new ModelStoreError('CALL_ACTIVE');
      }
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM model_calls').get();
      if (Number(count?.n) >= 3000) throw new ModelStoreError('STORE_FULL');
      for (const [period, width, limit] of [['hour', HOUR, 10], ['day', DAY, 100]] as const) {
        const bucket = Math.floor(time / width);
        const row = this.db.prepare('SELECT * FROM model_quota WHERE period=? AND bucket=?').get(period, bucket);
        if (Number(row?.calls ?? 0) >= limit || (period === 'day'
          && (Number(row?.input_bytes ?? 0) + record.inputBytes > 1024 * 1024
            || Number(row?.output_bytes ?? 0) + record.outputBytes > 2 * 1024 * 1024))) {
          throw new ModelStoreError('QUOTA_EXCEEDED');
        }
        this.db.prepare(`INSERT INTO model_quota VALUES(?,?,1,?,?)
          ON CONFLICT(period,bucket) DO UPDATE SET calls=calls+1,
          input_bytes=input_bytes+excluded.input_bytes, output_bytes=output_bytes+excluded.output_bytes`)
          .run(period, bucket, record.inputBytes, record.outputBytes);
      }
      // Deliberately copy only declared fields (never persist extra caller keys).
      const call: ModelCallMetadata = {
        callId: record.callId, owner: record.owner, clientRequestId: record.clientRequestId,
        requestHash: record.requestHash, inputBytes: record.inputBytes, outputBytes: record.outputBytes,
        maxOutputTokens: record.maxOutputTokens, maxDurationMs: record.maxDurationMs,
        accountRevision: record.accountRevision, createdAt: time, updatedAt: time,
        state: 'prepared', localState: 'prepared', remoteState: 'not-sent', usage: null, errorCode: null,
      };
      this.db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?,?)').run(call.callId, call.owner,
        call.clientRequestId, call.requestHash, time, time, call.state, JSON.stringify(call));
      return { callId: call.callId, fresh: true };
    });
  }

  dispatch(callId: string): void {
    this.transaction(() => {
      const call = this.get(callId);
      if (!call) throw new ModelStoreError('CALL_NOT_FOUND');
      if (call.state !== 'prepared') throw new ModelStoreError('INVALID_TRANSITION');
      call.state = 'dispatching'; call.localState = 'dispatching'; call.remoteState = 'unknown';
      call.updatedAt = this.clock();
      this.save(call);
    });
  }

  terminal(callId: string, result: ModelTerminal): void {
    this.transaction(() => {
      const call = this.get(callId);
      if (!call) throw new ModelStoreError('CALL_NOT_FOUND');
      // First terminal wins: late cancel/transport races cannot overwrite it.
      if (call.state === 'terminal') return;
      if (!terminalStates.has(result.localState)
        || !['not-sent', 'unknown', 'finished'].includes(result.remoteState)) invalid();
      if (call.state === 'prepared' && result.remoteState !== 'not-sent') invalid();
      if (call.state === 'dispatching' && result.remoteState === 'not-sent') invalid();
      const usage = safeUsage(result.usage);
      call.state = 'terminal'; call.localState = result.localState; call.remoteState = result.remoteState;
      call.usage = usage;
      call.errorCode = result.errorCode === null ? null
        : errorCodes.has(result.errorCode) ? result.errorCode : 'INTERNAL';
      call.updatedAt = this.clock();
      this.save(call);
      if (call.remoteState === 'unknown') this.latch();
    });
  }

  find(owner: string, clientRequestId: string): ModelCallMetadata | undefined {
    return this.guard(() => {
      const row = this.db.prepare('SELECT metadata FROM model_calls WHERE owner=? AND client_key=?').get(owner, clientRequestId);
      return row ? JSON.parse(row.metadata as string) as ModelCallMetadata : undefined;
    });
  }

  hasUnknown(): boolean {
    return this.guard(() => this.db.prepare('SELECT unknown_latch FROM model_meta WHERE id=1').get()?.unknown_latch !== 0);
  }

  status(callId: string): ModelCallMetadata | undefined {
    return this.guard(() => this.get(callId));
  }

  acknowledgeUnknown(): void {
    this.transaction(() => {
      // Acknowledgment is of unresolved *terminal* work, never an active dispatch.
      if (this.db.prepare("SELECT 1 FROM model_calls WHERE state!='terminal' LIMIT 1").get()) {
        throw new ModelStoreError('CALL_ACTIVE');
      }
      this.clock();
      this.db.exec('UPDATE model_meta SET unknown_latch=0 WHERE id=1');
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failed = false;
    try { this.db.close(); } catch { failed = true; }
    try { this.ownership.close(); } catch { failed = true; }
    if (failed) throw new ModelStoreError('STORE_UNAVAILABLE');
  }
}
