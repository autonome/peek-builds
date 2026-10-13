/**
 * model-provider tests. Every fetch is a fake serving records and zstd bytes built here, so no
 * test touches the network.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { DEFAULT_REMOTE_SETTINGS_SERVER, readRecordsCache, type FetchLike, type FetchResponseLike } from './page-translate/model-download.js';
import { createModelProvider } from './page-translate/model-provider.js';
import { cachePath, sha256Hex, type ModelRecord } from './page-translate/model-store.js';
import { translationUserAgent, withUserAgent, type HeaderFetchLike } from './page-translate/translation-fetch.js';

const SERVER = DEFAULT_REMOTE_SETTINGS_SERVER;
const RECORDS_URL = `${SERVER}/buckets/main/collections/translations-models-v2/records`;
const ATTACH_BASE = 'https://attachments.example.test/';

function response(body: Uint8Array | object, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => {
      const bytes = body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    json: async () => body,
  };
}

/** Three files (model, lex, vocab) for one direction, with their compressed attachments. */
function pairRecords(src: string, tgt: string) {
  const blobs: Record<string, Uint8Array> = {};
  const records: ModelRecord[] = ['model', 'lex', 'vocab'].map((fileType) => {
    const raw = Buffer.from(`${fileType} ${src}${tgt}`);
    const compressed = zlib.zstdCompressSync(raw);
    const location = `main-workspace/translations-models-v2/${src}${tgt}-${fileType}.zst`;
    blobs[`${ATTACH_BASE}${location}`] = compressed;
    return {
      id: `${src}${tgt}-${fileType}`,
      name: `${fileType}.${src}${tgt}.bin`,
      fileType,
      sourceLanguage: src,
      targetLanguage: tgt,
      architecture: 'base-memory',
      version: '3.0',
      decompressedHash: sha256Hex(raw),
      decompressedSize: raw.byteLength,
      attachment: { hash: sha256Hex(compressed), size: compressed.byteLength, filename: `${fileType}.zst`, location },
    };
  });
  return { records, blobs };
}

function fakeServer(pairs: Array<[string, string]>) {
  const records: ModelRecord[] = [];
  const blobs: Record<string, Uint8Array> = {};
  for (const [s, t] of pairs) {
    const p = pairRecords(s, t);
    records.push(...p.records);
    Object.assign(blobs, p.blobs);
  }
  const calls: string[] = [];
  let offline = false;
  let gate: Promise<void> | null = null;
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    if (gate) await gate;
    if (offline) throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
    if (url === `${SERVER}/`) return response({ capabilities: { attachments: { base_url: ATTACH_BASE } } });
    if (url === RECORDS_URL) return response({ data: records });
    const blob = blobs[url];
    return blob ? response(blob) : response({}, 404);
  };
  return {
    fetch,
    calls,
    records,
    setOffline(v: boolean) {
      offline = v;
    },
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-model-provider-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('model-provider records', () => {
  it('fetches the catalogue once per session and writes records.json', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    assert.strictEqual((await provider.records()).length, 3);
    await provider.records();
    assert.deepStrictEqual(server.calls, [RECORDS_URL]);
    assert.strictEqual((await readRecordsCache(root))?.length, 3);
  });

  it('refresh fetches again', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    await provider.records();
    await provider.records({ refresh: true });
    assert.deepStrictEqual(server.calls, [RECORDS_URL, RECORDS_URL]);
  });

  it('offline, the last records.json is used', async () => {
    const server = fakeServer([['es', 'en']]);
    await createModelProvider({ fetch: server.fetch, root }).records();
    server.setOffline(true);
    const offline = createModelProvider({ fetch: server.fetch, root });
    assert.strictEqual((await offline.records()).length, 3);
  });

  it('offline with no records.json fails with the network error', async () => {
    const server = fakeServer([]);
    server.setOffline(true);
    await assert.rejects(createModelProvider({ fetch: server.fetch, root }).records(), /ERR_INTERNET_DISCONNECTED/);
  });

  it('a mirror server replaces the default address', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return response({ data: [] });
    };
    await createModelProvider({ fetch, root, server: 'https://mirror.example.test/v1' }).records();
    assert.deepStrictEqual(calls, ['https://mirror.example.test/v1/buckets/main/collections/translations-models-v2/records']);
  });
});

describe('model-provider ensure', () => {
  it('downloads every file of a direct pair into the cache and returns their paths', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    const result = await provider.ensure('es', 'en');
    assert.ok(result.ok);
    assert.strictEqual(result.steps.length, 1);
    const [step] = result.steps;
    assert.strictEqual(step.plan.sourceLanguage, 'es');
    for (const record of server.records) {
      const file = cachePath(root, record);
      assert.strictEqual(step.files[record.fileType as 'model' | 'lex' | 'vocab'], file);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), `${record.fileType} esen`);
    }
  });

  it('pivots through English with one download per step', async () => {
    const server = fakeServer([['es', 'en'], ['en', 'de']]);
    const result = await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'de');
    assert.ok(result.ok);
    assert.deepStrictEqual(
      result.steps.map((s) => `${s.plan.sourceLanguage}-${s.plan.targetLanguage}`),
      ['es-en', 'en-de'],
    );
    assert.strictEqual(fs.readFileSync(result.steps[1].files.model as string, 'utf8'), 'model ende');
  });

  it('a pair already on disk fetches nothing but the catalogue', async () => {
    const server = fakeServer([['es', 'en']]);
    await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'en');
    server.calls.length = 0;
    const result = await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'en');
    assert.ok(result.ok);
    assert.deepStrictEqual(server.calls, [RECORDS_URL]);
  });

  it('offline, a pair already on disk is still ready', async () => {
    const server = fakeServer([['es', 'en']]);
    await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'en');
    server.setOffline(true);
    const result = await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'en');
    assert.ok(result.ok);
  });

  it('an unsupported pair answers with what is missing and downloads nothing', async () => {
    const server = fakeServer([['es', 'en']]);
    const result = await createModelProvider({ fetch: server.fetch, root }).ensure('es', 'de');
    assert.deepStrictEqual(result, { ok: false, reason: 'unsupported', missing: [{ sourceLanguage: 'en', targetLanguage: 'de' }] });
    assert.deepStrictEqual(server.calls, [RECORDS_URL]);
  });

  it('concurrent calls for one pair share one download', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    const release = server.hold();
    const a = provider.ensure('es', 'en');
    const b = provider.ensure('es', 'en');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra, rb);
    assert.strictEqual(server.calls.filter((u) => u.startsWith(ATTACH_BASE)).length, 3);
  });

  it('a failed download is retried by the next call', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    await provider.records();
    server.setOffline(true);
    await assert.rejects(provider.ensure('es', 'en'), /ERR_INTERNET_DISCONNECTED/);
    server.setOffline(false);
    assert.ok((await provider.ensure('es', 'en')).ok);
  });
});

describe('model-provider over the translation fetch', () => {
  it('sends the Peek user agent on the records, server-root and attachment requests', async () => {
    const server = fakeServer([['es', 'en']]);
    const seen: Array<[string, string | undefined]> = [];
    const headerFetch: HeaderFetchLike = async (url, init) => {
      seen.push([url, init.headers['User-Agent']]);
      return server.fetch(url, { signal: init.signal });
    };
    const ua = translationUserAgent('1.2.3');
    assert.strictEqual(ua, 'Peek/1.2.3 (on-device translation)');
    const provider = createModelProvider({ fetch: withUserAgent(headerFetch, ua), root });
    assert.ok((await provider.ensure('es', 'en')).ok);
    const urls = seen.map(([url]) => url);
    assert.ok(urls.includes(RECORDS_URL), 'records request');
    assert.ok(urls.includes(`${SERVER}/`), 'server-root request');
    assert.ok(urls.some((url) => url.startsWith(ATTACH_BASE)), 'attachment request');
    for (const [url, agent] of seen) assert.strictEqual(agent, ua, url);
  });
});
