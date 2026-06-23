/**
 * Tests for atproto record signature verification (atproto-verify.ts).
 *
 * These run as pure node:test (no Electron) against real, deterministic
 * fixtures captured from burrito.space's repo (see
 * atproto-verify-fixtures.ts). The golden case proves the full chain
 * verifies real on-chain data; the adversarial cases prove every tamper
 * vector is rejected with the right failure mode.
 *
 * The CAR proof is mutated in-memory by re-parsing it, editing one block (and
 * keeping that block reachable under a fresh CID where needed), and
 * re-serializing it. This lets us inject "tampered MST node", "flipped record
 * byte", etc., without touching the golden fixture on disk.
 */

import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';

import * as dagCbor from '@ipld/dag-cbor';
import { CID, varint } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import { Secp256k1Keypair } from '@atproto/crypto';

import {
  fetchAndVerifyRecord,
  resolveSigningKey,
  buildKeyEpochs,
  selectKeyAtTime,
  SignatureVerificationError,
  __setFetchForTest,
} from './atproto-verify.js';
import {
  BURRITO_DID,
  BURRITO_PDS,
  BURRITO_COLLECTION,
  BURRITO_RKEY,
  BURRITO_RECORD_CID,
  BURRITO_GETRECORD,
  BURRITO_DIDDOC,
  BURRITO_PLC_AUDIT,
  BURRITO_CURRENT_KEY,
  BURRITO_ROTATED_OUT_KEY,
  burritoProofCar,
} from './atproto-verify-fixtures.js';

// ─── CAR (de)serialization helpers ──────────────────────────────────

interface CarBlock {
  cid: CID;
  bytes: Uint8Array;
}

interface CarParsed {
  rootBytes: Uint8Array; // raw dag-cbor header bytes (carries roots)
  root: CID;
  blocks: CarBlock[];
}

function parseCarFull(bytes: Uint8Array): CarParsed {
  let offset = 0;
  const [headerLen, n1] = varint.decode(bytes.subarray(offset));
  const headerBytes = bytes.subarray(offset + n1, offset + n1 + headerLen);
  const header = dagCbor.decode<{ roots: CID[] }>(headerBytes);
  offset += n1 + headerLen;
  const blocks: CarBlock[] = [];
  while (offset < bytes.length) {
    const [secLen, n2] = varint.decode(bytes.subarray(offset));
    offset += n2;
    const section = bytes.subarray(offset, offset + secLen);
    const [cid, remainder] = CID.decodeFirst(section);
    const cidLen = secLen - remainder.length;
    blocks.push({ cid, bytes: section.subarray(cidLen) });
    offset += secLen;
  }
  return { rootBytes: headerBytes, root: header.roots[0], blocks };
}

function varintEncode(n: number): Uint8Array {
  const buf: number[] = [];
  let v = n;
  while (v >= 0x80) {
    buf.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  buf.push(v);
  return new Uint8Array(buf);
}

function serializeCar(parsed: CarParsed): Uint8Array {
  const chunks: Uint8Array[] = [];
  const headerLenVi = varintEncode(parsed.rootBytes.length);
  chunks.push(headerLenVi, parsed.rootBytes);
  for (const b of parsed.blocks) {
    const cidBytes = b.cid.bytes;
    const secLen = cidBytes.length + b.bytes.length;
    chunks.push(varintEncode(secLen), cidBytes, b.bytes);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function dagCborCid(bytes: Uint8Array): Promise<CID> {
  return CID.create(1, dagCbor.code, await sha256.digest(bytes));
}

// ─── Fetch stub ─────────────────────────────────────────────────────
//
// With Phase 2, fetchAndVerifyRecord (did:plc) makes up to three requests:
// the CAR proof (com.atproto.sync.getRecord), the PLC audit log
// (plc.directory/<did>/log/audit — the key history), and — only on the
// fallback path — the DID doc (plc.directory/<did>). We serve fixtures for
// all three; the CAR, audit, and DID doc are each overridable per-test.

type AuditOpt = unknown[] | 'unavailable';

function installStub(
  carBytes: Uint8Array,
  didDoc: unknown = BURRITO_DIDDOC,
  audit: AuditOpt = BURRITO_PLC_AUDIT
): void {
  __setFetchForTest((async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/log/audit')) {
      if (audit === 'unavailable') {
        return new Response('service unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(audit), { status: 200 });
    }
    if (url.startsWith('https://plc.directory/')) {
      // DID doc — only reached on the current-key fallback path.
      return new Response(JSON.stringify(didDoc), { status: 200 });
    }
    if (url.includes('com.atproto.sync.getRecord')) {
      return new Response(new Uint8Array(carBytes), {
        status: 200,
        headers: { 'content-type': 'application/vnd.ipld.car' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch);
}

function parts() {
  return { did: BURRITO_DID, collection: BURRITO_COLLECTION, rkey: BURRITO_RKEY };
}
function atUri() {
  return `at://${BURRITO_DID}/${BURRITO_COLLECTION}/${BURRITO_RKEY}`;
}

afterEach(() => {
  __setFetchForTest();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('resolveSigningKey', () => {
  it('extracts the #atproto secp256k1 key from the real DID doc', async () => {
    installStub(burritoProofCar());
    const key = await resolveSigningKey(BURRITO_DID);
    assert.strictEqual(key.curve, 'secp256k1');
    assert.ok(key.didKey.startsWith('did:key:zQ3sh'), key.didKey);
  });

  it('rejects a DID doc with no #atproto verificationMethod', async () => {
    const bad = { ...BURRITO_DIDDOC, verificationMethod: [] };
    installStub(burritoProofCar(), bad);
    await assert.rejects(
      resolveSigningKey(BURRITO_DID),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Signing key not found/.test(e.message)
    );
  });

  it('rejects an unsupported key curve', async () => {
    const bad = {
      ...BURRITO_DIDDOC,
      verificationMethod: [
        {
          id: `${BURRITO_DID}#atproto`,
          type: 'Multikey',
          publicKeyMultibase: 'zBOGUSnotacurve',
        },
      ],
    };
    installStub(burritoProofCar(), bad);
    await assert.rejects(
      resolveSigningKey(BURRITO_DID),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Unsupported key curve/.test(e.message)
    );
  });
});

describe('fetchAndVerifyRecord — golden real proof', () => {
  it('verifies cleanly and returns the right record CID + value', async () => {
    installStub(burritoProofCar());
    const result = await fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri());
    assert.strictEqual(result.cid, BURRITO_RECORD_CID);
    // The verified record CID must match the independent getRecord CID.
    assert.strictEqual(result.cid, BURRITO_GETRECORD.cid);
    // And the decoded value matches the independent getRecord value's $type.
    assert.strictEqual(result.value['$type'], BURRITO_GETRECORD.value['$type']);
    assert.strictEqual(result.value['$type'], 'app.bsky.actor.profile');
  });
});

describe('fetchAndVerifyRecord — adversarial cases', () => {
  it('rejects a flipped bit in the commit body (sig fails)', async () => {
    const parsed = parseCarFull(burritoProofCar());
    // The commit is the CAR root block. Flip a byte in its body. We keep the
    // root CID unchanged, so the forged commit is served as "the commit" but
    // re-encoding it minus sig no longer matches the signature.
    const commit = parsed.blocks.find((b) => b.cid.toString() === parsed.root.toString());
    assert.ok(commit, 'commit block present');
    // Flip a low byte deep in the block (avoid the leading CBOR map header).
    const idx = commit!.bytes.length - 5;
    commit!.bytes = Uint8Array.from(commit!.bytes);
    commit!.bytes[idx] ^= 0x01;
    installStub(serializeCar(parsed));
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Commit signature invalid/.test(e.message)
    );
  });

  it('rejects a flipped bit in the signature', async () => {
    const parsed = parseCarFull(burritoProofCar());
    const commitBlock = parsed.blocks.find((b) => b.cid.toString() === parsed.root.toString())!;
    const commit = dagCbor.decode<{ sig: Uint8Array }>(commitBlock.bytes);
    const sig = Uint8Array.from(commit.sig);
    sig[sig.length - 1] ^= 0x01; // flip a bit in the sig
    const forged = { ...commit, sig };
    commitBlock.bytes = dagCbor.encode(forged);
    // Keep the root CID the same so the forged commit is the one we verify.
    installStub(serializeCar(parsed));
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Commit signature invalid/.test(e.message)
    );
  });

  it('rejects a tampered MST node (CID mismatch)', async () => {
    const parsed = parseCarFull(burritoProofCar());
    // Find the MST root node = commit.data. Tamper its bytes but keep its CID,
    // so the walk fetches it by the parent's CID and the re-hash fails.
    const commitBlock = parsed.blocks.find((b) => b.cid.toString() === parsed.root.toString())!;
    const commit = dagCbor.decode<{ data: CID }>(commitBlock.bytes);
    const mstRootKey = commit.data.toString();
    const node = parsed.blocks.find((b) => b.cid.toString() === mstRootKey)!;
    node.bytes = Uint8Array.from(node.bytes);
    node.bytes[node.bytes.length - 1] ^= 0x01; // corrupt bytes, CID unchanged
    installStub(serializeCar(parsed));
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /MST inclusion failed/.test(e.message)
    );
  });

  it('rejects a record/leaf CID mismatch (tampered record bytes)', async () => {
    const parsed = parseCarFull(burritoProofCar());
    // The record block is the one whose CID equals the known record CID.
    const recBlock = parsed.blocks.find((b) => b.cid.toString() === BURRITO_RECORD_CID)!;
    assert.ok(recBlock, 'record block present');
    recBlock.bytes = Uint8Array.from(recBlock.bytes);
    recBlock.bytes[recBlock.bytes.length - 1] ^= 0x01; // CID unchanged → re-hash fails
    installStub(serializeCar(parsed));
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Record CID mismatch/.test(e.message)
    );
  });

  it('rejects on the fallback path when the #atproto key is missing from the DID doc', async () => {
    // PLC audit log unavailable → fall back to the current key → DID doc has
    // no #atproto method → abort (never silently install).
    installStub(burritoProofCar(), { ...BURRITO_DIDDOC, verificationMethod: [] }, 'unavailable');
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Signing key not found/.test(e.message)
    );
  });

  it('rejects when the MST does not contain the requested record', async () => {
    installStub(burritoProofCar());
    // Ask for an rkey that isn't in the committed tree.
    await assert.rejects(
      fetchAndVerifyRecord(
        BURRITO_PDS,
        { did: BURRITO_DID, collection: BURRITO_COLLECTION, rkey: 'does-not-exist' },
        atUri()
      ),
      (e: Error) =>
        e instanceof SignatureVerificationError && /MST inclusion failed/.test(e.message)
    );
  });

  it('rejects a wrong-key DID doc on the fallback path (different key → sig fails)', async () => {
    // PLC audit log unavailable → fall back to the current key from the DID
    // doc, but that key is a syntactically valid secp256k1 multikey that is
    // NOT burrito's key. verifySignature returns false → Commit signature invalid.
    const wrong = {
      ...BURRITO_DIDDOC,
      verificationMethod: [
        {
          id: `${BURRITO_DID}#atproto`,
          type: 'Multikey',
          // a different real secp256k1 did:key multibase (33-byte compressed)
          publicKeyMultibase: 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
        },
      ],
    };
    installStub(burritoProofCar(), wrong, 'unavailable');
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Commit signature invalid/.test(e.message)
    );
  });
});

// ─── Phase 2: PLC key-history selection ─────────────────────────────

describe('Phase 2 — PLC audit-log key selection (pure)', () => {
  it('builds the #atproto key history oldest→newest from the real audit log', () => {
    const epochs = buildKeyEpochs(BURRITO_PLC_AUDIT);
    assert.strictEqual(epochs.length, 5);
    // Oldest is the create-op signing key; newest is the current key.
    assert.ok(epochs[0].didKey.startsWith('did:key:zQ3shP5T'));
    assert.strictEqual(epochs[epochs.length - 1].didKey, BURRITO_CURRENT_KEY);
    // validFrom is monotonic non-decreasing.
    for (let i = 1; i < epochs.length; i++) {
      assert.ok(epochs[i].validFrom >= epochs[i - 1].validFrom);
    }
  });

  it('selects the CURRENT key for a present-day commit time', () => {
    const epochs = buildKeyEpochs(BURRITO_PLC_AUDIT);
    const key = selectKeyAtTime(epochs, new Date('2026-06-23T15:17:00Z'));
    assert.strictEqual(key, BURRITO_CURRENT_KEY);
  });

  it('selects the then-active (now rotated-out) key for a 2024 commit time', () => {
    const epochs = buildKeyEpochs(BURRITO_PLC_AUDIT);
    // Between 2023-11-09 (rotated-out key took effect) and 2026-03-06.
    const key = selectKeyAtTime(epochs, new Date('2024-06-01T00:00:00Z'));
    assert.strictEqual(key, BURRITO_ROTATED_OUT_KEY);
  });

  it('selects the boundary key exactly at the rotation instant', () => {
    const epochs = buildKeyEpochs(BURRITO_PLC_AUDIT);
    // At the precise createdAt of the current key's op → current key.
    const key = selectKeyAtTime(epochs, new Date('2026-03-06T17:50:50.019Z'));
    assert.strictEqual(key, BURRITO_CURRENT_KEY);
    // One ms before → still the rotated-out key.
    const before = selectKeyAtTime(epochs, new Date('2026-03-06T17:50:50.018Z'));
    assert.strictEqual(before, BURRITO_ROTATED_OUT_KEY);
  });

  it('falls back to the earliest key for a time before the DID was created', () => {
    const epochs = buildKeyEpochs(BURRITO_PLC_AUDIT);
    const key = selectKeyAtTime(epochs, new Date('2000-01-01T00:00:00Z'));
    assert.ok(key!.startsWith('did:key:zQ3shP5T'));
  });

  it('skips nullified operations when building the history', () => {
    const withNullified = [
      ...BURRITO_PLC_AUDIT,
      {
        createdAt: '2026-04-01T00:00:00.000Z',
        nullified: true, // an abandoned fork plc.directory superseded
        operation: {
          type: 'plc_operation',
          verificationMethods: { atproto: 'did:key:zQ3shFORKEDKEYmustNOTbeused000000000' },
        },
      },
    ];
    const epochs = buildKeyEpochs(withNullified);
    assert.strictEqual(epochs.length, 5); // nullified op dropped
    const key = selectKeyAtTime(epochs, new Date('2026-06-23T00:00:00Z'));
    assert.strictEqual(key, BURRITO_CURRENT_KEY); // not the forked key
  });
});

describe('Phase 2 — key-at-rev is authoritative over the DID doc', () => {
  it('verifies via the PLC log key even when the DID doc advertises a wrong key', async () => {
    // The DID doc carries a different (wrong) #atproto key, but the audit log
    // is available → Phase 2 selects the log key active at the commit rev (the
    // real signer) and verifies. The DID doc is NOT consulted on this path.
    const wrongDoc = {
      ...BURRITO_DIDDOC,
      verificationMethod: [
        {
          id: `${BURRITO_DID}#atproto`,
          type: 'Multikey',
          publicKeyMultibase: 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
        },
      ],
    };
    installStub(burritoProofCar(), wrongDoc, BURRITO_PLC_AUDIT);
    const result = await fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri());
    assert.strictEqual(result.cid, BURRITO_RECORD_CID);
  });

  it('falls back to the current key and still verifies when the audit log is unavailable', async () => {
    // Audit log 503 → fall back to the (correct) current #atproto key from the
    // DID doc → still verifies. Fallback never weakens past Phase 1.
    installStub(burritoProofCar(), BURRITO_DIDDOC, 'unavailable');
    const result = await fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri());
    assert.strictEqual(result.cid, BURRITO_RECORD_CID);
  });
});

// ─── Phase 2: adversarial — rotated-out key cannot forge a current commit ──
//
// These build genuine, self-signed scenarios with @atproto/crypto: two real
// secp256k1 keypairs (an old one and a current one), a tiny one-leaf MST, and
// a commit signed by a chosen key at a chosen rev. The synthetic PLC audit log
// says oldKey was active 2020→2025 and curKey from 2025 on. This proves the
// time-windowed selection rejects a now-rotated-out key on a CURRENT commit
// while still accepting the genuine current commit (and a genuine historical
// commit by the then-active key).

const SYNTH_DID = 'did:plc:synthadversaryphase2test0';
const SYNTH_OLD_TID = '3i5p64yyc2222'; // → 2021-06-01 (oldKey window)
const SYNTH_CUR_TID = '3moxqvufj6g2u'; // → 2026-06-23 (curKey window)

function synthAudit(oldKey: string, curKey: string): unknown[] {
  return [
    {
      createdAt: '2020-01-01T00:00:00.000Z',
      nullified: false,
      operation: { type: 'create', signingKey: oldKey },
    },
    {
      createdAt: '2025-01-01T00:00:00.000Z',
      nullified: false,
      operation: { type: 'plc_operation', verificationMethods: { atproto: curKey } },
    },
  ];
}

async function buildSyntheticCar(
  signWith: Secp256k1Keypair,
  rev: string
): Promise<{ car: Uint8Array; collection: string; rkey: string }> {
  const collection = 'space.peek.feature.release';
  const rkey = 'synthetic';
  const recordBytes = dagCbor.encode({ $type: collection, name: 'synthetic-feature' });
  const recordCid = await dagCborCid(recordBytes);
  // A single-leaf MST node keyed by `<collection>/<rkey>`.
  const fullKey = new TextEncoder().encode(`${collection}/${rkey}`);
  const mstBytes = dagCbor.encode({ e: [{ p: 0, k: fullKey, v: recordCid, t: null }], l: null });
  const mstCid = await dagCborCid(mstBytes);
  // The commit, signed by the chosen key over dag-cbor(commit-minus-sig).
  const unsigned = { did: SYNTH_DID, version: 3, data: mstCid, rev, prev: null };
  const sig = await signWith.sign(dagCbor.encode(unsigned));
  const commitBytes = dagCbor.encode({ ...unsigned, sig });
  const commitCid = await dagCborCid(commitBytes);
  const car = serializeCar({
    rootBytes: dagCbor.encode({ roots: [commitCid], version: 1 }),
    root: commitCid,
    blocks: [
      { cid: commitCid, bytes: commitBytes },
      { cid: mstCid, bytes: mstBytes },
      { cid: recordCid, bytes: recordBytes },
    ],
  });
  return { car, collection, rkey };
}

describe('Phase 2 — adversarial: rotated-out key cannot forge a current commit', () => {
  it('verifies a CURRENT commit signed by the CURRENT key', async () => {
    const oldKp = await Secp256k1Keypair.create();
    const curKp = await Secp256k1Keypair.create();
    const { car, collection, rkey } = await buildSyntheticCar(curKp, SYNTH_CUR_TID);
    installStub(car, BURRITO_DIDDOC, synthAudit(oldKp.did(), curKp.did()));
    const result = await fetchAndVerifyRecord(
      'https://pds.example',
      { did: SYNTH_DID, collection, rkey },
      `at://${SYNTH_DID}/${collection}/${rkey}`
    );
    assert.ok(result.cid);
    assert.strictEqual(result.value['name'], 'synthetic-feature');
  });

  it('REJECTS a CURRENT commit signed by a now-rotated-out historical key', async () => {
    const oldKp = await Secp256k1Keypair.create();
    const curKp = await Secp256k1Keypair.create();
    // Forged: a current-rev commit signed by the OLD (rotated-out) key.
    const { car, collection, rkey } = await buildSyntheticCar(oldKp, SYNTH_CUR_TID);
    installStub(car, BURRITO_DIDDOC, synthAudit(oldKp.did(), curKp.did()));
    await assert.rejects(
      fetchAndVerifyRecord(
        'https://pds.example',
        { did: SYNTH_DID, collection, rkey },
        `at://${SYNTH_DID}/${collection}/${rkey}`
      ),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Commit signature invalid/.test(e.message)
    );
  });

  it('still verifies a genuine HISTORICAL commit signed by the then-active key', async () => {
    const oldKp = await Secp256k1Keypair.create();
    const curKp = await Secp256k1Keypair.create();
    // A 2021-rev commit signed by oldKey, which WAS active in 2021.
    const { car, collection, rkey } = await buildSyntheticCar(oldKp, SYNTH_OLD_TID);
    installStub(car, BURRITO_DIDDOC, synthAudit(oldKp.did(), curKp.did()));
    const result = await fetchAndVerifyRecord(
      'https://pds.example',
      { did: SYNTH_DID, collection, rkey },
      `at://${SYNTH_DID}/${collection}/${rkey}`
    );
    assert.ok(result.cid);
    assert.strictEqual(result.value['name'], 'synthetic-feature');
  });
});
