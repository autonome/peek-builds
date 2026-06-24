import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

// ---------------------------------------------------------------------------
// features/lex/atproto.js authenticated-XRPC migration.
//
// These tests pin the load-bearing contract of the eurosky.social CORS fix:
// the authenticated PDS XRPC paths (xrpcGet / xrpcPost / uploadBlob) MUST go
// through the main-process DPoP proxy (window.app.atproto.*) and MUST NOT call
// plain renderer fetch() against the user's PDS host (which is CORS-blocked
// from the peek:// origin for PDSes that send no Access-Control-Allow-Origin).
//
// The module reads `window.app` at import time, so we stub the renderer
// globals BEFORE importing it. fetch is stubbed to a throwing spy so any
// regression back to plain fetch against the PDS fails loudly here.
// ---------------------------------------------------------------------------

const SESSION = {
  did: 'did:plc:test',
  handle: 'tester.example',
  pdsUrl: 'https://eurosky.social',
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  tokenEndpoint: 'https://eurosky.social/oauth/token',
  dpopKeyPairJwk: { publicKey: {}, privateKey: {} },
};

// --- renderer global stubs -------------------------------------------------
let proxyCalls;
let fetchCalls;

function installGlobals(proxyImpl) {
  proxyCalls = [];
  fetchCalls = [];

  globalThis.window = {
    app: {
      atproto: {
        request: async (method, url, jsonBody) => {
          proxyCalls.push({ kind: 'request', method, url, jsonBody });
          return proxyImpl.request
            ? proxyImpl.request({ method, url, jsonBody })
            : { status: 200, body: {} };
        },
        uploadBlob: async (url, dataBase64, contentType) => {
          proxyCalls.push({ kind: 'uploadBlob', url, dataBase64, contentType });
          return proxyImpl.uploadBlob
            ? proxyImpl.uploadBlob({ url, dataBase64, contentType })
            : { status: 200, body: { blob: { $type: 'blob' } } };
        },
      },
    },
  };

  // Any plain fetch() against the PDS would mean the migration regressed.
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`plain fetch() used against ${url} — regression!`);
  };

  // btoa is needed by uploadBlob's base64 encoder.
  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  }
}

// Fresh module per test so the module-local `authExpired` flag resets.
async function loadModule() {
  return import(`../../features/lex/atproto.js?cachebust=${Math.random()}`);
}

describe('lex/atproto authenticated XRPC uses the DPoP proxy', () => {
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('xrpcGet routes through window.app.atproto.request and returns body', async () => {
    installGlobals({
      request: () => ({ status: 200, body: { collections: ['app.bsky.feed.post'] } }),
    });
    const mod = await loadModule();
    const data = await mod.xrpcGet(SESSION, 'com.atproto.repo.describeRepo', { repo: SESSION.did });

    assert.equal(fetchCalls.length, 0, 'must not use plain fetch against the PDS');
    assert.equal(proxyCalls.length, 1);
    assert.equal(proxyCalls[0].kind, 'request');
    assert.equal(proxyCalls[0].method, 'GET');
    assert.match(proxyCalls[0].url, /^https:\/\/eurosky\.social\/xrpc\/com\.atproto\.repo\.describeRepo\?repo=/);
    assert.deepEqual(data, { collections: ['app.bsky.feed.post'] });
  });

  it('getCollections returns the collections array via the proxy', async () => {
    installGlobals({
      request: () => ({ status: 200, body: { collections: ['a.b.c', 'd.e.f'] } }),
    });
    const mod = await loadModule();
    const collections = await mod.getCollections(SESSION, () => {});
    assert.deepEqual(collections, ['a.b.c', 'd.e.f']);
    assert.equal(proxyCalls[0].method, 'GET');
  });

  it('xrpcPost routes through the proxy with the JSON body', async () => {
    installGlobals({
      request: () => ({ status: 200, body: { uri: 'at://x', cid: 'bafy' } }),
    });
    const mod = await loadModule();
    const body = { repo: SESSION.did, collection: 'app.bsky.feed.post', record: {} };
    const res = await mod.xrpcPost(SESSION, 'com.atproto.repo.createRecord', body);

    assert.equal(fetchCalls.length, 0);
    assert.equal(proxyCalls[0].method, 'POST');
    assert.deepEqual(proxyCalls[0].jsonBody, body);
    assert.deepEqual(res, { uri: 'at://x', cid: 'bafy' });
  });

  it('uploadBlob routes through the proxy as base64 + content type', async () => {
    installGlobals({
      uploadBlob: () => ({ status: 200, body: { blob: { $type: 'blob', mimeType: 'image/png' } } }),
    });
    const mod = await loadModule();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await mod.uploadBlob(SESSION, bytes, 'image/png');

    assert.equal(fetchCalls.length, 0);
    assert.equal(proxyCalls[0].kind, 'uploadBlob');
    assert.equal(proxyCalls[0].contentType, 'image/png');
    assert.equal(proxyCalls[0].dataBase64, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(res, { blob: { $type: 'blob', mimeType: 'image/png' } });
  });

  it('maps a surviving 401 (proxy already retried refresh) to AuthExpiredError', async () => {
    installGlobals({
      request: () => ({ status: 401, body: { error: 'ExpiredToken' } }),
    });
    const mod = await loadModule();
    await assert.rejects(
      () => mod.xrpcGet(SESSION, 'com.atproto.repo.describeRepo', { repo: SESSION.did }),
      (err) => err instanceof mod.AuthExpiredError,
    );
    assert.equal(mod.isAuthExpired(), true, 'sets the module authExpired flag');
  });

  it('maps a proxy {error: "No AT Protocol session"} to AuthExpiredError', async () => {
    installGlobals({
      request: () => ({ error: 'No AT Protocol session — sign in via Lexicon Studio first' }),
    });
    const mod = await loadModule();
    await assert.rejects(
      () => mod.xrpcPost(SESSION, 'com.atproto.repo.createRecord', {}),
      (err) => err instanceof mod.AuthExpiredError,
    );
    assert.equal(mod.isAuthExpired(), true);
  });

  it('maps a proxy invalid_grant error to AuthExpiredError', async () => {
    installGlobals({
      request: () => ({ error: 'invalid_grant: refresh token revoked' }),
    });
    const mod = await loadModule();
    await assert.rejects(
      () => mod.xrpcGet(SESSION, 'com.atproto.repo.describeRepo', {}),
      (err) => err instanceof mod.AuthExpiredError,
    );
  });

  it('non-2xx, non-expiry status throws a generic Error (not AuthExpiredError)', async () => {
    installGlobals({
      request: () => ({ status: 400, body: { error: 'InvalidRequest', message: 'bad collection' } }),
    });
    const mod = await loadModule();
    await assert.rejects(
      () => mod.xrpcGet(SESSION, 'com.atproto.repo.listRecords', {}),
      (err) => err instanceof Error
        && !(err instanceof mod.AuthExpiredError)
        && /bad collection/.test(err.message),
    );
    assert.equal(mod.isAuthExpired(), false);
  });

  it('a transient proxy {error} does NOT flip authExpired', async () => {
    installGlobals({
      request: () => ({ error: 'net::ERR_CONNECTION_RESET' }),
    });
    const mod = await loadModule();
    await assert.rejects(
      () => mod.xrpcGet(SESSION, 'com.atproto.repo.describeRepo', {}),
      (err) => err instanceof Error && !(err instanceof mod.AuthExpiredError),
    );
    assert.equal(mod.isAuthExpired(), false);
  });

  it('listRecords returns {records, cursor} shape via the proxy', async () => {
    installGlobals({
      request: () => ({ status: 200, body: { records: [{ uri: 'at://1' }], cursor: 'c1' } }),
    });
    const mod = await loadModule();
    const out = await mod.listRecords(SESSION, 'app.bsky.feed.post', { limit: 10 });
    assert.deepEqual(out, { records: [{ uri: 'at://1' }], cursor: 'c1' });
  });
});
