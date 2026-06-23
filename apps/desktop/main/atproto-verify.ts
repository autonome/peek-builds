/**
 * atproto record signature verification (Phase 1 + Phase 2).
 *
 * The naive install path fetched a `space.peek.feature.release` record via
 * `com.atproto.repo.getRecord` and trusted whatever the PDS returned. A
 * malicious (or compromised) PDS could forge a record whose CIDs point at
 * tampered blobs; the downstream `verifyBlobCid()` check would then happily
 * confirm the tampered bytes against the forged CIDs.
 *
 * This module closes that gap cryptographically. atproto does not sign
 * records individually — it signs the **commit** at the root of the repo's
 * Merkle Search Tree (MST). Record trust is transitive via MST inclusion:
 *
 *   publisher signing key  →  signed commit  →  MST path  →  record CID
 *
 * The existing `verifyBlobCid()` then closes the final link (record CID →
 * blob CIDs → blob bytes).
 *
 * Phase 1 verified against the *current* `#atproto` key in the DID document
 * (what most atproto clients do today). Phase 2 (this file) tightens that for
 * `did:plc`: it verifies the commit against the key that was *active at the
 * commit's `rev`* per the PLC audit log
 * (`https://plc.directory/<did>/log/audit`). This closes the stolen-old-key
 * forgery vector — a key rotated out of the repo can no longer be used to
 * forge a current commit. `did:web` has no audit log and stays on the
 * current-key path; if the PLC audit log is unavailable we fall back to the
 * current key (still requiring a valid current-key signature — no downgrade
 * past Phase 1) and log it.
 *
 * The verification proof comes from a single `com.atproto.sync.getRecord`
 * call, which returns a CAR (`application/vnd.ipld.car`) containing the
 * signed commit (the CAR root), the MST path blocks, and the record block.
 *
 * This module is pure + fetch-based (no Electron runtime). The `fetch`
 * implementation is injectable for offline/deterministic tests.
 */

import * as dagCbor from '@ipld/dag-cbor';
import { CID, varint } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import { verifySignature } from '@atproto/crypto';

// ─── Injectable fetch (for tests) ───────────────────────────────────

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args: Parameters<FetchFn>) => fetch(...args);

/** Override the fetch implementation (tests only). Pass nothing to reset. */
export function __setFetchForTest(fn?: FetchFn): void {
  fetchImpl = fn ?? ((...args: Parameters<FetchFn>) => fetch(...args));
}

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * A verification failure. Always carries enough context (DID + atUri +
 * reason) to make the abort actionable. The installer must NEVER fall back
 * to an unverified install on one of these.
 */
export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}

// ─── Signing-key resolution ─────────────────────────────────────────

interface DidDocVerificationMethod {
  id: string;
  type?: string;
  publicKeyMultibase?: string;
}

interface DidDocument {
  verificationMethod?: DidDocVerificationMethod[];
}

/** Result of resolving a DID's repo signing key. */
export interface SigningKey {
  /** `did:key:...` form, usable directly with `@atproto/crypto`. */
  didKey: string;
  /** `secp256k1` or `p256`, inferred from the multibase/multicodec prefix. */
  curve: 'secp256k1' | 'p256';
}

// did:key multibase prefixes (base58btc 'z'). The multicodec prefix on the
// decoded key bytes identifies the curve; the human-readable base58 prefix
// is a stable shorthand:
//   secp256k1 (0xe7 0x01) → keys start with "zQ3sh"
//   P-256     (0x80 0x24) → keys start with "zDna"
const SECP256K1_PREFIX = 'zQ3sh';
const P256_PREFIX = 'zDna';

/**
 * Resolve a DID to its repo signing key (the `#atproto` verification method)
 * and return it as a `did:key:` string plus the curve.
 *
 * Supports `did:plc` (via https://plc.directory) and `did:web`.
 *
 * @throws SignatureVerificationError on resolution failure, a missing
 *   `#atproto` method, or an unsupported key curve.
 */
export async function resolveSigningKey(did: string): Promise<SigningKey> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    const host = did.slice('did:web:'.length);
    url = `https://${host}/.well-known/did.json`;
  } else {
    throw new SignatureVerificationError(
      `DID resolution failed: unsupported DID method for ${did} ` +
      `(only did:plc and did:web are supported)`
    );
  }

  let doc: DidDocument;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new SignatureVerificationError(
        `DID resolution failed for ${did}: ${res.status} ${res.statusText}`
      );
    }
    doc = (await res.json()) as DidDocument;
  } catch (err) {
    if (err instanceof SignatureVerificationError) throw err;
    throw new SignatureVerificationError(
      `DID resolution failed for ${did}: ${(err as Error).message}`
    );
  }

  const methods = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
  // The repo signing key is the verification method whose id ends in
  // `#atproto` (fully it's `<did>#atproto`).
  const vm = methods.find((m) => typeof m.id === 'string' && m.id.endsWith('#atproto'));
  if (!vm || !vm.publicKeyMultibase) {
    throw new SignatureVerificationError(
      `Signing key not found: DID document for ${did} has no #atproto ` +
      `verificationMethod with a publicKeyMultibase`
    );
  }

  const mb = vm.publicKeyMultibase;
  let curve: 'secp256k1' | 'p256';
  if (mb.startsWith(SECP256K1_PREFIX)) {
    curve = 'secp256k1';
  } else if (mb.startsWith(P256_PREFIX)) {
    curve = 'p256';
  } else {
    throw new SignatureVerificationError(
      `Unsupported key curve: #atproto key for ${did} has multibase prefix ` +
      `"${mb.slice(0, 6)}" (expected secp256k1 "${SECP256K1_PREFIX}" or ` +
      `P-256 "${P256_PREFIX}")`
    );
  }

  // `did:key:<publicKeyMultibase>` works for both curves; @atproto/crypto's
  // verifySignature dispatches on the embedded multicodec prefix.
  return { didKey: `did:key:${mb}`, curve };
}

// ─── Phase 2: key-history resolution via the PLC audit log ──────────
//
// `did:plc` documents are mutable: the operator can rotate the `#atproto`
// signing key. The current DID doc only shows the *latest* key. A commit
// signed by a now-rotated-out key (e.g. one that was stolen, prompting the
// rotation) must NOT validate a *current* commit. The PLC audit log
// (`/log/audit`) is the authoritative, signed history of every operation,
// each carrying the `#atproto` key that became active at its `createdAt`.
// We pick the key whose validity window contains the commit's `rev`
// timestamp and verify against THAT key only.

/**
 * Convert a commit's `rev` (an atproto TID) to its wall-clock timestamp.
 *
 * A TID is 13 chars of the sortable base32 alphabet encoding a 64-bit int:
 * the high 53 bits are microseconds since the Unix epoch, the low 10 bits are
 * a clock identifier we discard.
 *
 * @returns the Date, or null if `rev` is not a well-formed TID (caller then
 *   falls back to the current key).
 */
const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
function tidToTimestamp(rev: string): Date | null {
  if (typeof rev !== 'string' || rev.length !== 13) return null;
  let n = 0n;
  for (const c of rev) {
    const v = TID_ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 32n + BigInt(v);
  }
  const millis = Number((n >> 10n) / 1000n);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis);
}

/**
 * Turn a `did:key:...` string into a {didKey, curve} SigningKey, validating
 * the curve from the multibase prefix (same rule as resolveSigningKey).
 *
 * @throws SignatureVerificationError if it isn't a supported did:key.
 */
function didKeyToSigningKey(didKey: string, ctx: string): SigningKey {
  const mb = didKey.startsWith('did:key:') ? didKey.slice('did:key:'.length) : '';
  let curve: 'secp256k1' | 'p256';
  if (mb.startsWith(SECP256K1_PREFIX)) {
    curve = 'secp256k1';
  } else if (mb.startsWith(P256_PREFIX)) {
    curve = 'p256';
  } else {
    throw new SignatureVerificationError(
      `Unsupported key curve: ${ctx} — PLC log #atproto key "${didKey}" has ` +
      `multibase prefix "${mb.slice(0, 6)}" (expected secp256k1 ` +
      `"${SECP256K1_PREFIX}" or P-256 "${P256_PREFIX}")`
    );
  }
  return { didKey, curve };
}

/** One PLC audit-log entry (only the fields we read). */
export interface PlcAuditEntry {
  createdAt: string;
  nullified?: boolean;
  operation?: {
    type?: string;
    /** legacy `create` op carries the signing key here. */
    signingKey?: string;
    /** modern `plc_operation` carries it under verificationMethods.atproto. */
    verificationMethods?: { atproto?: string } | null;
  } | null;
}

/** A `#atproto` key and the instant it became active. */
export interface KeyEpoch {
  /** the `did:key:...` form of the key active from `validFrom` onward. */
  didKey: string;
  /** epoch-ms when this key became active (the op's `createdAt`). */
  validFrom: number;
}

/**
 * Build the `#atproto` signing-key history from a PLC audit log.
 *
 * Nullified operations (abandoned forks that plc.directory superseded) are
 * skipped; the result is the canonical chain ordered oldest→newest. The curve
 * is NOT validated here — only the *selected* key's curve is checked at
 * verification time, so an exotic historical key that isn't the one we verify
 * against can't poison the whole walk.
 */
export function buildKeyEpochs(audit: PlcAuditEntry[]): KeyEpoch[] {
  const epochs: KeyEpoch[] = [];
  const sorted = [...audit].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  for (const entry of sorted) {
    if (entry.nullified) continue;
    const op = entry.operation;
    if (!op) continue;
    const didKey =
      op.type === 'create' ? op.signingKey : op.verificationMethods?.atproto;
    if (!didKey) continue; // e.g. a tombstone / deactivation op
    const validFrom = Date.parse(entry.createdAt);
    if (Number.isNaN(validFrom)) continue;
    epochs.push({ didKey, validFrom });
  }
  return epochs;
}

/**
 * Select the `#atproto` key that was active at time `t` — the latest epoch
 * whose `validFrom` is at or before `t`.
 *
 * If `t` predates the very first operation (clock skew; a real current commit
 * can't be older than its repo's creation) we fall back to the first epoch.
 *
 * @returns the active key's `did:key:...`, or null if there is no history.
 */
export function selectKeyAtTime(epochs: KeyEpoch[], t: Date): string | null {
  if (epochs.length === 0) return null;
  const tt = t.getTime();
  let selected: KeyEpoch | null = null;
  for (const e of epochs) {
    if (e.validFrom <= tt) selected = e;
    else break;
  }
  return (selected ?? epochs[0]).didKey;
}

/**
 * Internal sentinel: the PLC audit log couldn't be fetched/parsed/used for
 * this commit. Distinct from SignatureVerificationError so the caller can
 * fall back to the current key WITHOUT swallowing a genuine verification
 * failure (which is always a SignatureVerificationError and must abort).
 */
class PlcLogUnavailableError extends Error {}

/** Fetch + JSON-parse a DID's PLC audit log. */
async function fetchPlcAuditLog(did: string): Promise<PlcAuditEntry[]> {
  const url = `https://plc.directory/${did}/log/audit`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new PlcLogUnavailableError((err as Error).message);
  }
  if (!res.ok) {
    throw new PlcLogUnavailableError(`${res.status} ${res.statusText}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new PlcLogUnavailableError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(json)) {
    throw new PlcLogUnavailableError('audit log response was not an array');
  }
  return json as PlcAuditEntry[];
}

/**
 * Resolve the `#atproto` signing key that was active at a `did:plc` commit's
 * `rev`, per the PLC audit log.
 *
 * @throws PlcLogUnavailableError if the rev isn't decodable, the log can't be
 *   fetched/parsed, or it carries no usable key history — the caller falls
 *   back to the current key on these.
 * @throws SignatureVerificationError if the active key has an unsupported
 *   curve — a genuine "cannot verify", must abort (no fallback).
 */
async function resolveSigningKeyAtRev(
  did: string,
  rev: string,
  ctx: string
): Promise<SigningKey> {
  const t = tidToTimestamp(rev);
  if (!t) {
    throw new PlcLogUnavailableError(`commit rev "${rev}" is not a decodable TID`);
  }
  const audit = await fetchPlcAuditLog(did);
  const epochs = buildKeyEpochs(audit);
  const didKey = selectKeyAtTime(epochs, t);
  if (!didKey) {
    throw new PlcLogUnavailableError('PLC audit log carries no #atproto key history');
  }
  return didKeyToSigningKey(didKey, ctx);
}

// ─── CAR parsing ────────────────────────────────────────────────────

interface ParsedCar {
  /** Map of CID-string → raw block bytes. */
  blocks: Map<string, Uint8Array>;
  /** The CAR root CID (the signed commit). */
  root: CID;
}

interface CarHeader {
  version: number;
  roots: CID[];
}

/**
 * Parse a CARv1 byte stream into a block map + root CID.
 *
 * Format: a varint-prefixed dag-cbor header (carrying `roots`), then a
 * sequence of varint-length-prefixed sections, each `<CID><block bytes>`.
 */
function parseCar(bytes: Uint8Array): ParsedCar {
  let offset = 0;

  const [headerLen, n1] = varint.decode(bytes.subarray(offset));
  if (headerLen === 0) {
    throw new SignatureVerificationError('Malformed CAR proof: empty header');
  }
  const headerBytes = bytes.subarray(offset + n1, offset + n1 + headerLen);
  const header = dagCbor.decode<CarHeader>(headerBytes);
  if (!header || !Array.isArray(header.roots) || header.roots.length === 0) {
    throw new SignatureVerificationError('Malformed CAR proof: no roots in header');
  }
  const root = header.roots[0];
  offset += n1 + headerLen;

  const blocks = new Map<string, Uint8Array>();
  while (offset < bytes.length) {
    const [secLen, n2] = varint.decode(bytes.subarray(offset));
    offset += n2;
    const section = bytes.subarray(offset, offset + secLen);
    const [cid, remainder] = CID.decodeFirst(section);
    const cidLen = secLen - remainder.length;
    blocks.set(cid.toString(), section.subarray(cidLen));
    offset += secLen;
  }

  return { blocks, root };
}

// ─── CID + dag-cbor helpers ─────────────────────────────────────────

/**
 * Compute the dag-cbor CIDv1 (codec 0x71, sha2-256) of a block of bytes.
 *
 * IMPORTANT: this is the dag-cbor codec, NOT the raw codec (0x55) used for
 * blobs by `computeCidV1Sha256Raw` in atproto-source.ts. Commits and MST
 * nodes are dag-cbor.
 */
async function dagCborCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, digest).toString();
}

// ─── Commit verification ────────────────────────────────────────────

interface SignedCommit {
  did: string;
  version: number;
  data: CID;
  rev: string;
  prev: CID | null;
  sig: Uint8Array;
}

/**
 * Verify a commit's signature against the signing key.
 *
 * The signed message is `dag-cbor(commit-with-sig-removed)`; low-S ECDSA is
 * enforced by @atproto/crypto's default (we deliberately do NOT pass
 * allowMalleableSig).
 *
 * @throws SignatureVerificationError if the signature does not verify.
 */
async function verifyCommit(commit: SignedCommit, signingKey: SigningKey, ctx: string): Promise<void> {
  if (!(commit.sig instanceof Uint8Array)) {
    throw new SignatureVerificationError(
      `Commit signature invalid: ${ctx} — commit has no sig bytes`
    );
  }
  const { sig, ...unsigned } = commit;
  let ok = false;
  try {
    ok = await verifySignature(signingKey.didKey, dagCbor.encode(unsigned), sig);
  } catch (err) {
    throw new SignatureVerificationError(
      `Commit signature invalid: ${ctx} — ${(err as Error).message}`
    );
  }
  if (!ok) {
    throw new SignatureVerificationError(
      `Commit signature invalid: ${ctx} — the PDS is serving a forged or ` +
      `tampered commit, or the publisher's signing key is compromised`
    );
  }
}

// ─── MST walk ───────────────────────────────────────────────────────

/** A single entry within an MST node (dag-cbor encoded). */
interface MstEntry {
  /** prefixlen — bytes shared with the previous entry's key. */
  p: number;
  /** key suffix bytes. */
  k: Uint8Array;
  /** value CID (the record CID for a leaf entry). */
  v: CID;
  /** right subtree CID (entries with keys > this entry's key, < next), or null. */
  t: CID | null;
}

/** An MST node (dag-cbor encoded). */
interface MstNode {
  /** leftmost subtree CID (entries with keys < the first entry), or null. */
  l: CID | null;
  /** entries, byte-ordered by full key. */
  e: MstEntry[];
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Byte-wise lexicographic comparison, like atproto MST key ordering. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Fetch an MST node (or any dag-cbor block) from the block map by CID and
 * confirm its bytes actually re-hash to that CID. This is the integrity
 * check that makes the walk trustworthy rather than merely self-consistent:
 * every block we descend into is the exact block the parent CID committed to.
 *
 * @throws SignatureVerificationError if the block is missing or its bytes
 *   don't hash to the expected CID.
 */
async function loadBlockChecked(
  blocks: Map<string, Uint8Array>,
  cid: CID,
  ctx: string
): Promise<Uint8Array> {
  const key = cid.toString();
  const bytes = blocks.get(key);
  if (!bytes) {
    throw new SignatureVerificationError(
      `MST inclusion failed: ${ctx} — proof is missing block ${key}`
    );
  }
  const actual = await dagCborCid(bytes);
  if (actual !== key) {
    throw new SignatureVerificationError(
      `MST inclusion failed: ${ctx} — block bytes hash to ${actual} but the ` +
      `parent pointed at ${key} (tampered MST node)`
    );
  }
  return bytes;
}

/**
 * Walk the MST from `rootCid` to the leaf with full key === `targetKey`.
 *
 * At every node, full keys are reconstructed from the compressed entry form:
 * entry i's full key = (first `p` bytes of entry i-1's full key) ++ `k`.
 * Keys are byte-ordered, so we descend left of the first entry whose key
 * exceeds the target, or right of the last entry whose key is below it.
 *
 * @returns the record CID at the leaf, or throws if the key isn't present.
 */
async function walkMst(
  blocks: Map<string, Uint8Array>,
  rootCid: CID,
  targetKey: Uint8Array,
  ctx: string
): Promise<CID> {
  let cid: CID | null = rootCid;

  while (cid) {
    const bytes = await loadBlockChecked(blocks, cid, ctx);
    const node = dagCbor.decode<MstNode>(bytes);

    // Default descent: leftmost subtree (keys below the first entry).
    let descend: CID | null = node.l ?? null;
    let prevKey: Uint8Array = new Uint8Array(0);

    for (const e of node.e) {
      const fullKey = concatBytes(prevKey.subarray(0, e.p), e.k);
      prevKey = fullKey;
      const c = compareBytes(targetKey, fullKey);
      if (c === 0) {
        return e.v; // exact leaf
      }
      if (c < 0) {
        // target sorts before this entry → it lives in `descend` (the subtree
        // just left of this entry: node.l for the first entry, else the prior
        // entry's t). Stop scanning and descend there.
        break;
      }
      // target sorts after this entry → its subtree is e.t; keep scanning, and
      // if no later entry overtakes the target, we descend into e.t.
      descend = e.t ?? null;
    }

    // Broke early on c < 0 → `descend` holds the left-of boundary. Ran off the
    // end (target greater than every entry) → `descend` holds the last e.t.
    cid = descend;
  }

  throw new SignatureVerificationError(
    `MST inclusion failed: ${ctx} — record key not present in the committed tree`
  );
}

// ─── AT URI parsing (minimal; mirrors atproto-source) ───────────────

interface AtUriParts {
  did: string; // must already be a DID (caller resolves handles first)
  collection: string;
  rkey: string;
}

// ─── Public entry point ─────────────────────────────────────────────

/** A verified record, shape-compatible with the old getRecord result. */
export interface VerifiedRecord {
  uri: string;
  /** the record CID, proven via the MST chain. */
  cid: string;
  value: Record<string, unknown>;
}

/**
 * Fetch a record AND cryptographically verify it before returning.
 *
 * Replaces the unverified `getRecord()` call. The full chain:
 *   1. Fetch the CAR proof (commit + MST path + record) in one
 *      `com.atproto.sync.getRecord` call.
 *   2. Decode the commit (the CAR root).
 *   3. Resolve the #atproto signing key active at commit.rev (PLC audit log
 *      for did:plc; current key for did:web / fallback).
 *   4. Verify the commit signature. FAIL → abort.
 *   5. Walk the MST from commit.data to the leaf for `<collection>/<rkey>`,
 *      re-hashing every node against its parent's CID. FAIL → abort.
 *   6. Re-hash the record block against the leaf's value CID, decode it.
 *
 * Any failure throws SignatureVerificationError — callers must NEVER fall
 * back to an unverified install.
 *
 * @param pdsUrl  the PDS endpoint discovered for the DID
 * @param parts   { did, collection, rkey } — did MUST be a DID, not a handle
 * @param atUri   the original at:// URI (for error context only)
 */
export async function fetchAndVerifyRecord(
  pdsUrl: string,
  parts: AtUriParts,
  atUri: string
): Promise<VerifiedRecord> {
  const { did, collection, rkey } = parts;
  const ctx = `${did} ${atUri}`;

  // 1. Fetch the CAR proof.
  const url =
    `${pdsUrl}/xrpc/com.atproto.sync.getRecord` +
    `?did=${encodeURIComponent(did)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&rkey=${encodeURIComponent(rkey)}`;

  let carBytes: Uint8Array;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SignatureVerificationError(
        `Failed to fetch verification proof for ${ctx}: ` +
        `${res.status} ${res.statusText} — ${body}`
      );
    }
    carBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof SignatureVerificationError) throw err;
    throw new SignatureVerificationError(
      `Failed to fetch verification proof for ${ctx}: ${(err as Error).message}`
    );
  }

  const { blocks, root } = parseCar(carBytes);

  // 2. Decode the commit. The CAR root is the commit. Its authenticity comes
  //    from the SIGNATURE (checked in step 4), not from a CID match — the root
  //    CID is asserted by the same (untrusted) CAR header, so a self-hash
  //    check would be circular.
  const commitKey = root.toString();
  const commitBytes = blocks.get(commitKey);
  if (!commitBytes) {
    throw new SignatureVerificationError(
      `Commit signature invalid: ${ctx} — CAR proof is missing the commit ` +
      `block ${commitKey}`
    );
  }
  const commit = dagCbor.decode<SignedCommit>(commitBytes);
  if (commit.did !== did) {
    throw new SignatureVerificationError(
      `Commit signature invalid: ${ctx} — commit.did (${commit.did}) does ` +
      `not match the requested DID`
    );
  }

  // 3. Resolve the signing key that was ACTIVE AT commit.rev (Phase 2). For
  //    did:plc we walk the PLC audit log and pick the key valid at the rev's
  //    timestamp — a rotated-out key can't forge a current commit. did:web has
  //    no audit log → current key. If the log is unavailable we fall back to
  //    the current key (still a real current-key signature check) and log it.
  let signingKey: SigningKey;
  if (did.startsWith('did:plc:')) {
    try {
      signingKey = await resolveSigningKeyAtRev(did, commit.rev, ctx);
    } catch (err) {
      if (!(err instanceof PlcLogUnavailableError)) throw err; // real verify failure → abort
      console.warn(
        `[atproto-verify] PLC audit log unusable for ${ctx} (${err.message}); ` +
        `falling back to the current #atproto key`
      );
      signingKey = await resolveSigningKey(did);
    }
  } else {
    // did:web (and any other supported method): current #atproto key.
    signingKey = await resolveSigningKey(did);
  }

  // 4. Verify the commit signature against the resolved key.
  await verifyCommit(commit, signingKey, ctx);

  // 5. Walk the MST to the record leaf.
  const targetKey = new TextEncoder().encode(`${collection}/${rkey}`);
  const recordCid = await walkMst(blocks, commit.data, targetKey, ctx);

  // 6. Re-hash the record block against the leaf's value CID, then decode.
  const recordKey = recordCid.toString();
  const recordBytes = blocks.get(recordKey);
  if (!recordBytes) {
    throw new SignatureVerificationError(
      `Record CID mismatch: ${ctx} — record block ${recordKey} is missing ` +
      `from the proof`
    );
  }
  const recordActual = await dagCborCid(recordBytes);
  if (recordActual !== recordKey) {
    throw new SignatureVerificationError(
      `Record CID mismatch: ${ctx} — record bytes hash to ${recordActual} ` +
      `but the MST leaf pointed at ${recordKey}`
    );
  }
  const value = dagCbor.decode<Record<string, unknown>>(recordBytes);

  return {
    uri: atUri,
    cid: recordCid.toString(),
    value,
  };
}
