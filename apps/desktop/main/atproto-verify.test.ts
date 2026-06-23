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

import {
  fetchAndVerifyRecord,
  resolveSigningKey,
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
// fetchAndVerifyRecord makes exactly two requests: the DID doc (plc.directory)
// and the CAR proof (com.atproto.sync.getRecord). We serve fixtures for both,
// with the CAR optionally overridden per-test for tamper cases.

function installStub(carBytes: Uint8Array, didDoc: unknown = BURRITO_DIDDOC): void {
  __setFetchForTest((async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.startsWith('https://plc.directory/')) {
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

  it('rejects when the #atproto key is missing from the DID doc', async () => {
    installStub(burritoProofCar(), { ...BURRITO_DIDDOC, verificationMethod: [] });
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

  it('rejects a wrong-key DID doc (valid-shaped but different key → sig fails)', async () => {
    // A syntactically valid secp256k1 multikey that is NOT burrito's key.
    // verifySignature should return false → Commit signature invalid.
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
    installStub(burritoProofCar(), wrong);
    await assert.rejects(
      fetchAndVerifyRecord(BURRITO_PDS, parts(), atUri()),
      (e: Error) =>
        e instanceof SignatureVerificationError && /Commit signature invalid/.test(e.message)
    );
  });
});
