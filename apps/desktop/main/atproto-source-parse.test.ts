/**
 * Tests for the REAL `parseAtUri` exported by atproto-source.ts.
 *
 * History: the former `tests/unit/atproto-source.test.js` shipped an INLINE
 * COPY of parseAtUri plus a pile of mock-fetch assertions that only exercised
 * the test's own stubs (never the product code). That file was deleted; the
 * AtprotoSource network path (resolve/fetch happy path + CID-tamper abort) is
 * now covered for real — against signed CAR proofs — by
 * `atproto-install-hardening.test.ts` and `feature-install-handler.test.ts`.
 *
 * This file keeps the one genuinely useful, pure-function slice — AT URI
 * parsing — but pointed at the REAL exported `parseAtUri` so a divergence in
 * the product implementation would actually fail here.
 *
 * Runs under Electron's Node host (ELECTRON_RUN_AS_NODE=1 electron --test).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseAtUri } from './atproto-source.js';

describe('parseAtUri (real product function)', () => {
  it('parses a valid AT URI with a DID repo', () => {
    assert.deepStrictEqual(
      parseAtUri('at://did:plc:abc123/space.peek.feature.release/tid123'),
      { repo: 'did:plc:abc123', collection: 'space.peek.feature.release', rkey: 'tid123' }
    );
  });

  it('parses a valid AT URI with a handle repo', () => {
    assert.deepStrictEqual(
      parseAtUri('at://alice.bsky.social/space.peek.feature.release/tid456'),
      { repo: 'alice.bsky.social', collection: 'space.peek.feature.release', rkey: 'tid456' }
    );
  });

  it('parses a did:web repo', () => {
    assert.deepStrictEqual(
      parseAtUri('at://did:web:example.com/app.bsky.feed.post/abc'),
      { repo: 'did:web:example.com', collection: 'app.bsky.feed.post', rkey: 'abc' }
    );
  });

  it('keeps a multi-segment collection intact (everything between repo and rkey)', () => {
    // collection segments are joined with "/" — only the last segment is rkey.
    assert.deepStrictEqual(
      parseAtUri('at://did:plc:abc/a.b.c/extra/rkey'),
      { repo: 'did:plc:abc', collection: 'a.b.c/extra', rkey: 'rkey' }
    );
  });

  it('throws when the at:// prefix is missing', () => {
    assert.throws(() => parseAtUri('https://example.com'), /must start with "at:\/\/"/);
  });

  it('throws for an empty string', () => {
    assert.throws(() => parseAtUri(''), /must start with "at:\/\/"/);
  });

  it('throws when only a repo is present', () => {
    assert.throws(() => parseAtUri('at://did:plc:abc123'), /expected at:\/\//);
  });

  it('throws when only repo and collection are present', () => {
    assert.throws(() => parseAtUri('at://did:plc:abc123/collection'), /expected at:\/\//);
  });

  it('throws on an empty rkey component', () => {
    assert.throws(() => parseAtUri('at://did:plc:abc123/collection/'), /empty component/);
  });
});
