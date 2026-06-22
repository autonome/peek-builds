/**
 * Unit tests for the main-process AT Protocol DPoP proxy
 * (`atproto-proxy.ts`).
 *
 * Coverage (pure pieces + the request loop with a mocked `net.fetch`):
 *   1.  DPoP proof construction: header (typ/alg/jwk sans `d`), claims
 *       (htm/htu/jti/iat/exp + nonce/ath), and an ES256 signature that
 *       VERIFIES against the public JWK.
 *   2.  computeAth — base64url SHA-256 of the access token.
 *   3.  Host allowlist gate (PDS host, token-endpoint host,
 *       *.bsky.network, plc.directory; rejects everything else).
 *   4.  Nonce-retry decision + the actual DPoP-Nonce re-sign retry.
 *   5.  401 → refresh → retry, with the refreshed session surfaced.
 *   6.  JSON vs binary body handling (Content-Type, body shape, base64
 *       round-trip is exercised at the IPC layer; here we assert the raw
 *       Uint8Array body + binary flag).
 *
 * Runs under ELECTRON_RUN_AS_NODE=1 (node:test) — `net` is injected via
 * `__setNetForTest`, so no Electron runtime is required.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { webcrypto } from 'node:crypto';

import {
  createDpopProof,
  computeAth,
  isAtprotoHostAllowed,
  shouldRetryWithNonce,
  shouldRefreshOnUnauthorized,
  performAtprotoRequest,
  __setNetForTest,
  type AtprotoSession,
  type DpopKeyPairJwk,
} from './atproto-proxy.js';

const subtle = webcrypto.subtle;
type WCKey = webcrypto.CryptoKey;

// ─── Fixtures ────────────────────────────────────────────────────────

async function makeKeyPairJwk(): Promise<{ jwk: DpopKeyPairJwk; publicKey: WCKey }> {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', kp.publicKey);
  const privateKey = await subtle.exportKey('jwk', kp.privateKey);
  return { jwk: { publicKey, privateKey }, publicKey: kp.publicKey };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function makeSession(over: Partial<AtprotoSession> = {}): Promise<AtprotoSession> {
  const { jwk } = await makeKeyPairJwk();
  return {
    did: 'did:plc:abc',
    handle: 'alice.test',
    accessToken: 'access-tok-1',
    refreshToken: 'refresh-tok-1',
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    pdsUrl: 'https://pds.example.com',
    dpopKeyPairJwk: jwk,
    ...over,
  };
}

/** A minimal fake Response matching the bits of net.fetch's return we use. */
function fakeResponse(opts: {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  dpopNonce?: string;
}): unknown {
  const headers = new Map<string, string>();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  if (opts.dpopNonce) headers.set('dpop-nonce', opts.dpopNonce);
  return {
    status: opts.status,
    statusText: `S${opts.status}`,
    ok: opts.status >= 200 && opts.status < 300,
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
      forEach: (cb: (v: string, k: string) => void) => headers.forEach((v, k) => cb(v, k)),
    },
    json: async () => {
      if (opts.json === undefined) throw new Error('no json');
      return opts.json;
    },
    arrayBuffer: async () => (opts.bytes ?? new Uint8Array()).buffer,
  };
}

/** Install a fake net.fetch that returns successive scripted responses. */
function scriptNet(responses: Array<unknown>): { calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  let i = 0;
  __setNetForTest({
    fetch: (async (url: string, init: unknown) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }) as never,
  });
  return { calls };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('atproto-proxy: createDpopProof', () => {
  it('builds a verifiable ES256 proof with correct header + claims', async () => {
    const { jwk, publicKey } = await makeKeyPairJwk();
    const url = 'https://pds.example.com/xrpc/com.atproto.repo.listRecords';
    const ath = computeAth('access-tok-1');
    const proof = await createDpopProof(jwk, 'GET', url, 'nonce-xyz', ath);

    const [h, p, s] = proof.split('.');
    const header = decodeJwtPart(h);
    const payload = decodeJwtPart(p);

    assert.strictEqual(header.typ, 'dpop+jwt');
    assert.strictEqual(header.alg, 'ES256');
    // Header jwk must be the PUBLIC key (no private `d` component).
    assert.ok(header.jwk && typeof header.jwk === 'object');
    assert.strictEqual((header.jwk as Record<string, unknown>).d, undefined);
    assert.strictEqual((header.jwk as Record<string, unknown>).crv, 'P-256');

    assert.strictEqual(payload.htm, 'GET');
    assert.strictEqual(payload.htu, url);
    assert.strictEqual(payload.nonce, 'nonce-xyz');
    assert.strictEqual(payload.ath, ath);
    assert.strictEqual(typeof payload.jti, 'string');
    assert.strictEqual(typeof payload.iat, 'number');
    assert.strictEqual(payload.exp, (payload.iat as number) + 120);

    // Signature verifies against the public key over `${h}.${p}`.
    const sigBytes = new Uint8Array(Buffer.from(s, 'base64url'));
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      Buffer.from(`${h}.${p}`),
    );
    assert.strictEqual(ok, true);
  });

  it('omits nonce/ath when not supplied', async () => {
    const { jwk } = await makeKeyPairJwk();
    const proof = await createDpopProof(jwk, 'POST', 'https://auth.example.com/oauth/token');
    const payload = decodeJwtPart(proof.split('.')[1]);
    assert.strictEqual(payload.nonce, undefined);
    assert.strictEqual(payload.ath, undefined);
    assert.strictEqual(payload.htm, 'POST');
  });
});

describe('atproto-proxy: computeAth', () => {
  it('is the base64url SHA-256 of the access token', async () => {
    const expected = (await subtle.digest('SHA-256', Buffer.from('access-tok-1')));
    const expectedB64 = Buffer.from(new Uint8Array(expected)).toString('base64url');
    assert.strictEqual(computeAth('access-tok-1'), expectedB64);
  });
});

describe('atproto-proxy: host allowlist', () => {
  let session: AtprotoSession;
  beforeEach(async () => { session = await makeSession(); });

  it('allows the user PDS host', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://pds.example.com/xrpc/x', session), true);
  });
  it('allows the token-endpoint host', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://auth.example.com/oauth/token', session), true);
  });
  it('allows *.bsky.network and *.host.bsky.network', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://morel.us-east.host.bsky.network/x', session), true);
    assert.strictEqual(isAtprotoHostAllowed('https://something.bsky.network/x', session), true);
  });
  it('allows plc.directory', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://plc.directory/did:plc:abc', session), true);
  });
  it('rejects an arbitrary host', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://evil.example.org/steal', session), false);
  });
  it('rejects a malformed URL', () => {
    assert.strictEqual(isAtprotoHostAllowed('not a url', session), false);
  });
  it('does not treat a bsky.network LOOKALIKE suffix as allowed', () => {
    assert.strictEqual(isAtprotoHostAllowed('https://evilbsky.network.attacker.com/x', session), false);
  });
});

describe('atproto-proxy: retry decision helpers', () => {
  it('shouldRetryWithNonce: only when not ok AND a nonce is present', () => {
    assert.strictEqual(shouldRetryWithNonce(400, false, 'n'), true);
    assert.strictEqual(shouldRetryWithNonce(401, false, 'n'), true);
    assert.strictEqual(shouldRetryWithNonce(400, false, null), false);
    assert.strictEqual(shouldRetryWithNonce(200, true, 'n'), false);
  });
  it('shouldRefreshOnUnauthorized: 401 + refresh token present', () => {
    assert.strictEqual(shouldRefreshOnUnauthorized(401, true), true);
    assert.strictEqual(shouldRefreshOnUnauthorized(401, false), false);
    assert.strictEqual(shouldRefreshOnUnauthorized(403, true), false);
  });
});

describe('atproto-proxy: performAtprotoRequest', () => {
  let session: AtprotoSession;
  beforeEach(async () => { session = await makeSession(); });
  afterEach(() => { __setNetForTest(null); });

  it('GET happy path returns parsed JSON body', async () => {
    const { calls } = scriptNet([
      fakeResponse({ status: 200, json: { records: [] }, contentType: 'application/json' }),
    ]);
    const res = await performAtprotoRequest(session, {
      method: 'GET',
      url: 'https://pds.example.com/xrpc/com.atproto.repo.listRecords',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.binary, false);
    assert.deepStrictEqual(res.body, { records: [] });
    assert.strictEqual(calls.length, 1);
    // Authorization header carries the DPoP access token.
    const init = calls[0].init as { headers: Record<string, string> };
    assert.strictEqual(init.headers.Authorization, 'DPoP access-tok-1');
    assert.ok(init.headers.DPoP);
  });

  it('retries once with the server DPoP-Nonce on a non-OK first response', async () => {
    const { calls } = scriptNet([
      fakeResponse({ status: 400, dpopNonce: 'srv-nonce-1', json: { error: 'use_dpop_nonce' }, contentType: 'application/json' }),
      fakeResponse({ status: 200, json: { ok: true }, contentType: 'application/json' }),
    ]);
    const res = await performAtprotoRequest(session, {
      method: 'GET',
      url: 'https://pds.example.com/xrpc/x',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
    // Second proof must carry the nonce.
    const init2 = calls[1].init as { headers: Record<string, string> };
    const payload = decodeJwtPart(init2.headers.DPoP.split('.')[1]);
    assert.strictEqual(payload.nonce, 'srv-nonce-1');
  });

  it('on 401 refreshes the token, retries, and surfaces the refreshed session', async () => {
    const { calls } = scriptNet([
      // 1. initial request → 401
      fakeResponse({ status: 401, json: { error: 'invalid_token' }, contentType: 'application/json' }),
      // 2. token refresh POST → 200 with new tokens
      fakeResponse({ status: 200, json: { access_token: 'access-tok-2', refresh_token: 'refresh-tok-2' }, contentType: 'application/json' }),
      // 3. retried request with new token → 200
      fakeResponse({ status: 200, json: { done: true }, contentType: 'application/json' }),
    ]);
    const res = await performAtprotoRequest(session, {
      method: 'POST',
      url: 'https://pds.example.com/xrpc/com.atproto.repo.createRecord',
      jsonBody: { repo: 'did:plc:abc' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { done: true });
    assert.strictEqual(calls.length, 3);
    // The refresh hit the token endpoint.
    assert.strictEqual(calls[1].url, session.tokenEndpoint);
    // Refreshed session surfaced with the new tokens.
    assert.ok(res.refreshedSession);
    assert.strictEqual(res.refreshedSession?.accessToken, 'access-tok-2');
    assert.strictEqual(res.refreshedSession?.refreshToken, 'refresh-tok-2');
    // The final retry used the NEW access token.
    const init3 = calls[2].init as { headers: Record<string, string> };
    assert.strictEqual(init3.headers.Authorization, 'DPoP access-tok-2');
  });

  it('binary (uploadBlob) request sends the bytes + content-type and reads bytes back', async () => {
    const responseBytes = new Uint8Array([1, 2, 3, 4]);
    const { calls } = scriptNet([
      fakeResponse({ status: 200, bytes: responseBytes, contentType: 'application/octet-stream' }),
    ]);
    const upload = new Uint8Array([9, 8, 7]);
    const res = await performAtprotoRequest(session, {
      method: 'POST',
      url: 'https://pds.example.com/xrpc/com.atproto.repo.uploadBlob',
      binaryBody: upload,
      contentType: 'image/jpeg',
    });
    assert.strictEqual(res.binary, true);
    assert.ok(res.body instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(res.body as Uint8Array), [1, 2, 3, 4]);
    const init = calls[0].init as { headers: Record<string, string>; body: unknown };
    assert.strictEqual(init.headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(init.body, upload);
  });

  it('rejects mixing jsonBody and binaryBody', async () => {
    scriptNet([fakeResponse({ status: 200, json: {}, contentType: 'application/json' })]);
    await assert.rejects(
      performAtprotoRequest(session, {
        method: 'POST',
        url: 'https://pds.example.com/xrpc/x',
        jsonBody: {},
        binaryBody: new Uint8Array([1]),
      }),
      /mutually exclusive/,
    );
  });
});
