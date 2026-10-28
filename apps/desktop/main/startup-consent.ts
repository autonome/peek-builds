/**
 * Local startup acknowledgment policy. No Electron or normal-runtime imports.
 * This record is a local acknowledgment, not tamper-proof legal evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Increment the version whenever any displayed wording changes. The hash covers
// title, paragraphs, acknowledgments and actions in this canonical order.
export const NOTICE_VERSION = 1;
export const NOTICE = Object.freeze({
  title: 'Before you use Peek',
  paragraphs: Object.freeze([
    'Peek is experimental software. It has not been security audited and may contain unknown security vulnerabilities, serious defects, and unstable behavior. It may lose or corrupt data, expose private information, or cause other harm.',
    'Peek is not a conventional web browser and is not intended to become one. Its ability to display web pages is not a promise of the security, privacy, compatibility, reliability, or protections you may expect from a conventional browser. Do not rely on it as a safe replacement for one.',
    'Peek is provided “as is”, without warranties, to the fullest extent permitted by applicable law. If you choose to use it, you accept the risks and full responsibility for your use and any resulting loss, damage, or other consequences. To the fullest extent permitted by applicable law, its authors and contributors disclaim liability arising from its use. Nothing in this notice excludes rights or liability that applicable law does not permit to be excluded.',
  ]),
  acknowledgments: Object.freeze([
    'I understand that Peek has not been security audited and may be unstable or unsafe.',
    'I understand that Peek is not a conventional browser and must not be relied on as one.',
    'I accept the risks and full responsibility for my use of Peek and its consequences, to the fullest extent permitted by applicable law.',
  ]),
  quit: 'Quit',
  continue: 'Accept risks and continue',
});
export const NOTICE_HASH = createHash('sha256').update(JSON.stringify(NOTICE), 'utf8').digest('hex');

export interface AcceptanceRecord {
  schemaVersion: 1;
  noticeVersion: number;
  noticeHash: string;
  acceptedAt: string;
  buildIdentity?: string;
}

export function allAcknowledged(value: unknown): value is [true, true, true] {
  return Array.isArray(value) && value.length === 3 && value[0] === true && value[1] === true && value[2] === true;
}

export function isValidAcceptanceRecord(value: unknown): value is AcceptanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AcceptanceRecord>;
  if (record.schemaVersion !== 1 || record.noticeVersion !== NOTICE_VERSION || record.noticeHash !== NOTICE_HASH) return false;
  if (typeof record.acceptedAt !== 'string') return false;
  const time = Date.parse(record.acceptedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== record.acceptedAt) return false;
  return record.buildIdentity === undefined || (typeof record.buildIdentity === 'string' && record.buildIdentity.length > 0);
}

export function createAcceptanceRecord(buildIdentity?: string, now = new Date()): AcceptanceRecord {
  const record: AcceptanceRecord = {
    schemaVersion: 1,
    noticeVersion: NOTICE_VERSION,
    noticeHash: NOTICE_HASH,
    acceptedAt: now.toISOString(),
    ...(buildIdentity === undefined ? {} : { buildIdentity }),
  };
  if (!isValidAcceptanceRecord(record)) throw new Error('Invalid startup acknowledgment record');
  return record;
}

/** Call with the installation/user root captured BEFORE profile selection. */
export function consentRecordPath(userDataRoot: string): string {
  return path.join(userDataRoot, 'startup-risk-acknowledgment.json');
}

export async function readAcceptanceRecord(userDataRoot: string): Promise<AcceptanceRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(consentRecordPath(userDataRoot), 'utf8'));
    return isValidAcceptanceRecord(value) ? value : null;
  } catch {
    // Missing, corrupt, unsupported, or inaccessible is never acceptance.
    return null;
  }
}

/** Synchronous variant for the pre-ready decision. Same validity rules. */
export function readAcceptanceRecordSync(userDataRoot: string): AcceptanceRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(consentRecordPath(userDataRoot), 'utf8'));
    return isValidAcceptanceRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const MAX_PENDING_URL_LENGTH = 8192;

/**
 * Pending external work captured while the notice is up is inert data. Only
 * http(s) URLs of bounded length survive validation; file paths and every
 * other scheme are dropped.
 */
export function validatePendingUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PENDING_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export interface PendingWork {
  capture(value: unknown): void;
  /** First validated URL, or null. Clears everything captured. */
  release(): string | null;
  /** Drops everything captured (decline or failure). */
  discard(): void;
  readonly size: number;
}

export function createPendingWork(limit = 16): PendingWork {
  let items: unknown[] = [];
  return {
    capture(value) { if (items.length < limit) items.push(value); },
    release() {
      const taken = items;
      items = [];
      for (const item of taken) {
        const valid = validatePendingUrl(item);
        if (valid) return valid;
      }
      return null;
    },
    discard() { items = []; },
    get size() { return items.length; },
  };
}

/**
 * Whether the startup notice must be shown. A run from source (not packaged)
 * is a developer or test run: it skips the notice and neither reads nor writes
 * an acceptance record. Packaged builds require a valid record.
 */
export function noticeRequired(state: { packaged: boolean; accepted: boolean }): boolean {
  return state.packaged && !state.accepted;
}

/** A notice needs a display. On Linux that means an X or Wayland session. */
export function interactiveDisplayAvailable(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform !== 'linux') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * How the notice may appear. A headless launch has nobody to read it, so it is
 * blocked (the launch fails with a logged error). The one exception is a test
 * launch driven by automation, which needs the notice to exist but keeps its
 * window hidden so it never takes focus.
 */
export function noticePresentation(env: Record<string, string | undefined>): 'visible' | 'hidden' | 'blocked' {
  if (!env.PEEK_HEADLESS) return 'visible';
  return env.E2E_TEST === 'true' ? 'hidden' : 'blocked';
}

/**
 * Same-directory exclusive temporary file + flush + atomic replacement. Unique
 * temporary names allow independent consent flows to persist concurrently.
 * Any failure rejects: the caller must never import the runtime after it.
 */
export async function persistAcceptanceRecord(userDataRoot: string, record: AcceptanceRecord): Promise<void> {
  if (!isValidAcceptanceRecord(record)) throw new Error('Invalid startup acknowledgment record');
  await mkdir(userDataRoot, { recursive: true });
  const destination = consentRecordPath(userDataRoot);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true,
    });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function revokeAcceptanceRecord(userDataRoot: string): Promise<void> {
  await unlink(consentRecordPath(userDataRoot)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Retain bootstrap switches, never original navigation operands. */
export function safeRelaunchArgs(argv: string[], sourceApp: string | null, pendingUrl: string | null): string[] {
  const args = sourceApp === null ? [] : [sourceApp];
  for (const arg of argv) {
    // Options are single arguments (Electron's --option=value form). Positional
    // values cannot safely be distinguished from file/navigation operands.
    if (/^--[a-zA-Z][a-zA-Z0-9-]*(?:=.*)?$/.test(arg)) args.push(arg);
  }
  const url = validatePendingUrl(pendingUrl);
  if (url) args.push(url);
  return args;
}

export type ConsentDecision =
  | { action: 'decline' | 'close' }
  | { action: 'accept'; acknowledgments: unknown };

export interface ConsentDependencies {
  readRecord(): Promise<unknown>;
  /** A persistence failure must be explained locally, with retry or Quit. */
  present(context: { persistenceError?: unknown }): Promise<ConsentDecision>;
  persist(record: AcceptanceRecord): Promise<void>;
  /** Cancellation remains live while persistence is in flight. */
  signal?: AbortSignal;
  /** Remove a record that finished committing after cancellation. */
  revoke(): Promise<void>;
  /** The only normal-runtime entry point: use a dynamic import here. */
  loadRuntime(): Promise<unknown>;
  buildIdentity?: string;
}

export type ConsentOutcome =
  | { status: 'accepted' }
  | { status: 'declined' }
  | { status: 'failed'; error: unknown };

/**
 * One invocation per process, including overlapping activation/launch requests.
 * Presentation, persistence, and runtime failures all fail closed. The adapter
 * owns quitting on declined/failed outcomes; neither means permission to start.
 */
export function createStartupConsentGate(dependencies: ConsentDependencies): () => Promise<ConsentOutcome> {
  let result: Promise<ConsentOutcome> | undefined;
  async function run(): Promise<ConsentOutcome> {
    try {
      let existing: unknown;
      try { existing = await dependencies.readRecord(); } catch { existing = null; }
      if (!isValidAcceptanceRecord(existing)) {
        let context: { persistenceError?: unknown } = {};
        for (;;) {
          if (dependencies.signal?.aborted) return { status: 'declined' };
          const decision = await dependencies.present(context);
          if (decision.action === 'decline' || decision.action === 'close') return { status: 'declined' };
          if (decision.action !== 'accept' || !allAcknowledged(decision.acknowledgments)) {
            throw new Error('Startup requires all three explicit risk acknowledgments');
          }
          try {
            await dependencies.persist(createAcceptanceRecord(dependencies.buildIdentity));
          } catch (error) {
            if (dependencies.signal?.aborted) return { status: 'declined' };
            context = { persistenceError: error };
            continue;
          }
          if (dependencies.signal?.aborted) {
            await dependencies.revoke();
            return { status: 'declined' };
          }
          break;
        }
      }
      if (dependencies.signal?.aborted) return { status: 'declined' };
      await dependencies.loadRuntime();
      return { status: 'accepted' };
    } catch (error) {
      return { status: 'failed', error };
    }
  }
  return () => result ??= run();
}
