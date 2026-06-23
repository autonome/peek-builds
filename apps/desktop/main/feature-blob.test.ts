/**
 * Tests for verified feature display-media serving (atproto-source.ts):
 * fetchVerifiedFeatureBlob + buildFeatureBlobUrl + registerPublisherPds.
 *
 * This is the display-media half of the AT Protocol install integrity chain.
 * The bundle/manifest blobs are CID-gated at install (verifyBlobCid); these
 * tests prove icon/screenshot bytes are gated the SAME way before display:
 *
 *   - genuine bytes (hash == requested CID)        -> served, sniffed type
 *   - tampered bytes (CID correct, bytes flipped)  -> DROPPED (returns null)
 *   - a DID the user never browsed (unregistered)  -> null, no PDS fetch (SSRF
 *                                                     surface not widened)
 *
 * The adversarial case is the one that matters: it is the exact attack the
 * change closes — a compromised PDS serving substituted display media under a
 * signed CID. Pure node:test; the PDS fetch is stubbed via __setFetchForTest.
 */

import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  fetchVerifiedFeatureBlob,
  registerPublisherPds,
  buildFeatureBlobUrl,
  computeCidV1Sha256Raw,
  __setFetchForTest,
} from './atproto-source.js';

// A minimal but well-formed PNG header so the content-type sniffer returns
// image/png; the trailing bytes are arbitrary payload.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GENUINE = Buffer.from([...PNG_MAGIC, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const GENUINE_CID = computeCidV1Sha256Raw(GENUINE);

const DID = 'did:plc:testpublisher000000000000';
const PDS = 'https://pds.test.example';

/** Stub fetch that returns `body` for any getBlob request, recording the call. */
function stubBlob(body: Buffer): { calls: string[] } {
  const calls: string[] = [];
  __setFetchForTest(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(new Uint8Array(body), { status: 200 });
  });
  return { calls };
}

afterEach(() => __setFetchForTest());

describe('buildFeatureBlobUrl', () => {
  it('produces a peek://feature-blob URL with the DID and CID encoded', () => {
    const url = buildFeatureBlobUrl(DID, GENUINE_CID);
    assert.strictEqual(url, `peek://feature-blob/${encodeURIComponent(DID)}/${encodeURIComponent(GENUINE_CID)}`);
    // The DID's colons survive a round-trip through the protocol-handler split.
    const path = url.slice('peek://feature-blob/'.length);
    const [encDid, encCid] = path.split('/');
    assert.strictEqual(decodeURIComponent(encDid), DID);
    assert.strictEqual(decodeURIComponent(encCid), GENUINE_CID);
  });
});

describe('fetchVerifiedFeatureBlob', () => {
  it('serves genuine bytes whose hash matches the requested CID', async () => {
    registerPublisherPds(DID, PDS);
    const { calls } = stubBlob(GENUINE);

    const result = await fetchVerifiedFeatureBlob(DID, GENUINE_CID);

    assert.ok(result, 'expected genuine blob to be served');
    assert.ok(result.bytes.equals(GENUINE), 'served bytes must equal the genuine bytes');
    assert.strictEqual(result.contentType, 'image/png');
    assert.strictEqual(calls.length, 1, 'should fetch the blob exactly once');
    assert.match(calls[0], /com\.atproto\.sync\.getBlob/);
  });

  it('DROPS tampered bytes: correct CID requested but served bytes differ', async () => {
    registerPublisherPds(DID, PDS);
    // Same CID is requested, but the PDS serves substituted bytes.
    const tampered = Buffer.from(GENUINE);
    tampered[PNG_MAGIC.length] ^= 0xff;
    assert.notStrictEqual(computeCidV1Sha256Raw(tampered), GENUINE_CID);
    stubBlob(tampered);

    const result = await fetchVerifiedFeatureBlob(DID, GENUINE_CID);

    assert.strictEqual(result, null, 'tampered display media must be dropped, not served');
  });

  it('returns null for an unbrowsed DID without fetching (no SSRF widening)', async () => {
    const calls: string[] = [];
    __setFetchForTest(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(new Uint8Array(GENUINE), { status: 200 });
    });

    const result = await fetchVerifiedFeatureBlob('did:plc:neverbrowsed00000000000000', GENUINE_CID);

    assert.strictEqual(result, null, 'an unregistered DID must not be served');
    assert.strictEqual(calls.length, 0, 'must not fetch (no DID resolution in the handler path)');
  });

  it('returns null when the PDS fetch fails (graceful, non-fatal)', async () => {
    registerPublisherPds(DID, PDS);
    __setFetchForTest(async () => new Response('nope', { status: 404 }));

    const result = await fetchVerifiedFeatureBlob(DID, GENUINE_CID);

    assert.strictEqual(result, null, 'a failed fetch must drop the image, not throw');
  });
});
