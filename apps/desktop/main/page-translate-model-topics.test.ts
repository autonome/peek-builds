/**
 * Models manager tests: the on-disk inventory (`model-inventory.ts`), the folder-name parser
 * (`model-store.ts parsePairDirName`) and the pubsub topics (`model-topics.ts`). Every fetch is a
 * fake, so no test touches the network.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { DEFAULT_REMOTE_SETTINGS_SERVER, type FetchLike, type FetchResponseLike } from './page-translate/model-download.js';
import { deleteInstalledDirection, estimateDownload, listInstalledDirections } from './page-translate/model-inventory.js';
import { createModelProvider } from './page-translate/model-provider.js';
import {
  installModelTopics,
  MODELS_DELETE_TOPIC,
  MODELS_DOWNLOAD_TOPIC,
  MODELS_ESTIMATE_TOPIC,
  MODELS_ESTIMATED_TOPIC,
  MODELS_LIST_TOPIC,
  MODELS_LISTED_TOPIC,
  MODELS_PROGRESS_TOPIC,
} from './page-translate/model-topics.js';
import { cachePath, pairCacheDir, parsePairDirName, sha256Hex, type ModelRecord } from './page-translate/model-store.js';

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

function fakeServer(pairs: Array<[string, string]>) {
  const records: ModelRecord[] = [];
  const blobs: Record<string, Uint8Array> = {};
  for (const [src, tgt] of pairs) {
    for (const fileType of ['model', 'lex', 'vocab']) {
      const raw = Buffer.from(`${fileType} ${src}${tgt} `.repeat(20));
      const compressed = zlib.zstdCompressSync(raw);
      const location = `m/${src}${tgt}-${fileType}.zst`;
      blobs[`${ATTACH_BASE}${location}`] = compressed;
      records.push({
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
      });
    }
  }
  let offline = false;
  const fetch: FetchLike = async (url) => {
    if (offline) throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
    if (url === `${SERVER}/`) return response({ capabilities: { attachments: { base_url: ATTACH_BASE } } });
    if (url === RECORDS_URL) return response({ data: records });
    const blob = blobs[url];
    return blob ? response(blob) : response({}, 404);
  };
  return {
    fetch,
    records,
    setOffline(v: boolean) {
      offline = v;
    },
  };
}

function fakePorts() {
  const handlers = new Map<string, (msg: unknown) => void>();
  const published: Array<{ topic: string; msg: any }> = [];
  return {
    handlers,
    published,
    of(topic: string) {
      return published.filter((p) => p.topic === topic).map((p) => p.msg);
    },
    send(topic: string, msg: unknown) {
      handlers.get(topic)?.(msg);
    },
    ports: {
      subscribe: (topic: string, cb: (msg: unknown) => void) => void handlers.set(topic, cb),
      unsubscribe: (topic: string) => void handlers.delete(topic),
      publish: (topic: string, msg: unknown) => void published.push({ topic, msg }),
    },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-model-topics-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parsePairDirName', () => {
  it('splits simple and multi-subtag directions', () => {
    assert.deepStrictEqual(parsePairDirName('es-en'), { sourceLanguage: 'es', targetLanguage: 'en' });
    assert.deepStrictEqual(parsePairDirName('zh-Hans-en'), { sourceLanguage: 'zh-Hans', targetLanguage: 'en' });
    assert.deepStrictEqual(parsePairDirName('en-zh-Hans'), { sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
  });

  it('answers null for anything else', () => {
    for (const name of ['en', 'records.json', '..-en', 'EN-de', '']) assert.strictEqual(parsePairDirName(name), null, name);
  });

  it('pairCacheDir refuses an unsafe tag', () => {
    assert.throws(() => pairCacheDir(root, '..', 'en'), /unsafe language tag/);
  });
});

describe('model inventory', () => {
  it('lists downloaded directions with their size, and deletes one', async () => {
    const server = fakeServer([['es', 'en'], ['en', 'de']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    assert.ok((await provider.ensure('es', 'de')).ok);
    fs.mkdirSync(path.join(root, 'models', 'not a pair'), { recursive: true });

    const listed = await listInstalledDirections(root);
    const expected = (src: string, tgt: string) =>
      server.records.filter((r) => r.sourceLanguage === src && r.targetLanguage === tgt).reduce((n, r) => n + r.decompressedSize, 0);
    assert.deepStrictEqual(listed, [
      { sourceLanguage: 'en', targetLanguage: 'de', bytes: expected('en', 'de') },
      { sourceLanguage: 'es', targetLanguage: 'en', bytes: expected('es', 'en') },
    ]);

    assert.strictEqual(await deleteInstalledDirection(root, 'en', 'de'), true);
    assert.strictEqual(await deleteInstalledDirection(root, 'en', 'de'), false);
    assert.deepStrictEqual((await listInstalledDirections(root)).map((d) => d.targetLanguage), ['en']);
  });

  it('an empty cache lists nothing', async () => {
    assert.deepStrictEqual(await listInstalledDirections(root), []);
  });

  it('estimates download bytes from attachments, counting files on disk as free', async () => {
    const server = fakeServer([['es', 'en'], ['en', 'de']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    const sum = (src: string, key: 'attachment' | 'decompressed') =>
      server.records
        .filter((r) => r.sourceLanguage === src)
        .reduce((n, r) => n + (key === 'attachment' ? r.attachment.size : r.decompressedSize), 0);

    const before = await estimateDownload(root, await provider.plan('es', 'de'));
    assert.ok(before.ok);
    assert.strictEqual(before.downloadBytes, sum('es', 'attachment') + sum('en', 'attachment'));
    assert.strictEqual(before.diskBytes, sum('es', 'decompressed') + sum('en', 'decompressed'));

    await provider.ensure('es', 'en');
    const after = await estimateDownload(root, await provider.plan('es', 'de'));
    assert.ok(after.ok);
    assert.strictEqual(after.downloadBytes, sum('en', 'attachment'));
    assert.deepStrictEqual(after.steps.map((s) => s.downloadBytes), [0, sum('en', 'attachment')]);

    // A file of the wrong size is not counted as present.
    const lex = server.records.find((r) => r.sourceLanguage === 'es' && r.fileType === 'lex') as ModelRecord;
    fs.writeFileSync(cachePath(root, lex), 'short');
    const damaged = await estimateDownload(root, await provider.plan('es', 'de'));
    assert.ok(damaged.ok);
    assert.strictEqual(damaged.steps[0].downloadBytes, lex.attachment.size);
  });

  it('passes an unsupported plan through', async () => {
    const plan = { ok: false as const, reason: 'unsupported' as const, missing: [{ sourceLanguage: 'en', targetLanguage: 'xx' }] };
    assert.deepStrictEqual(await estimateDownload(root, plan), plan);
  });
});

describe('model topics', () => {
  it('list answers with what is on disk and, when asked, the catalogue', async () => {
    const server = fakeServer([['es', 'en'], ['en', 'de']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    await provider.ensure('es', 'en');
    const t = fakePorts();
    const topics = installModelTopics(async () => provider, t.ports);

    t.send(MODELS_LIST_TOPIC, {});
    await topics.idle();
    t.send(MODELS_LIST_TOPIC, { catalogue: true });
    await topics.idle();
    const [local, full] = t.of(MODELS_LISTED_TOPIC);
    assert.deepStrictEqual(local.installed.map((d: any) => `${d.sourceLanguage}-${d.targetLanguage}`), ['es-en']);
    assert.strictEqual(local.available, null);
    assert.strictEqual(local.error, null);
    assert.deepStrictEqual(full.available, [
      { sourceLanguage: 'en', targetLanguage: 'de' },
      { sourceLanguage: 'es', targetLanguage: 'en' },
    ]);
  });

  it('estimate answers with the sizes for the pair', async () => {
    const server = fakeServer([['es', 'en']]);
    const t = fakePorts();
    const topics = installModelTopics(async () => createModelProvider({ fetch: server.fetch, root }), t.ports);
    t.send(MODELS_ESTIMATE_TOPIC, { from: 'es', to: 'en' });
    t.send(MODELS_ESTIMATE_TOPIC, { from: 'es', to: 'es' });
    t.send(MODELS_ESTIMATE_TOPIC, { from: '../x', to: 'en' });
    await topics.idle();
    const answers = t.of(MODELS_ESTIMATED_TOPIC);
    assert.strictEqual(answers.length, 1);
    assert.strictEqual(answers[0].ok, true);
    assert.strictEqual(answers[0].from, 'es');
    assert.strictEqual(answers[0].downloadBytes, server.records.reduce((n, r) => n + r.attachment.size, 0));
  });

  it('estimate reports a catalogue that cannot be read', async () => {
    const server = fakeServer([]);
    server.setOffline(true);
    const t = fakePorts();
    const topics = installModelTopics(async () => createModelProvider({ fetch: server.fetch, root }), t.ports);
    t.send(MODELS_ESTIMATE_TOPIC, { from: 'es', to: 'en' });
    await topics.idle();
    const [answer] = t.of(MODELS_ESTIMATED_TOPIC);
    assert.strictEqual(answer.ok, false);
    assert.strictEqual(answer.reason, 'error');
    assert.match(answer.error, /ERR_INTERNET_DISCONNECTED/);
  });

  it('download reports progress, then lists the new direction', async () => {
    const server = fakeServer([['es', 'en']]);
    const t = fakePorts();
    const topics = installModelTopics(async () => createModelProvider({ fetch: server.fetch, root }), t.ports);
    t.send(MODELS_DOWNLOAD_TOPIC, { from: 'es', to: 'en' });
    await topics.idle();
    assert.deepStrictEqual(
      t.of(MODELS_PROGRESS_TOPIC).map((m) => m.phase),
      ['downloading', 'done'],
    );
    assert.deepStrictEqual(t.of(MODELS_LISTED_TOPIC)[0].installed.map((d: any) => d.sourceLanguage), ['es']);
    assert.ok(fs.existsSync(pairCacheDir(root, 'es', 'en')));
  });

  it('a failed download is reported as failed', async () => {
    const server = fakeServer([['es', 'en']]);
    const t = fakePorts();
    const topics = installModelTopics(async () => createModelProvider({ fetch: server.fetch, root }), t.ports);
    t.send(MODELS_DOWNLOAD_TOPIC, { from: 'es', to: 'de' });
    await topics.idle();
    const progress = t.of(MODELS_PROGRESS_TOPIC);
    assert.deepStrictEqual(progress.at(-1), { from: 'es', to: 'de', phase: 'failed', error: 'unsupported' });
  });

  it('delete removes the direction and lists again', async () => {
    const server = fakeServer([['es', 'en']]);
    const provider = createModelProvider({ fetch: server.fetch, root });
    await provider.ensure('es', 'en');
    const t = fakePorts();
    const topics = installModelTopics(async () => provider, t.ports);
    t.send(MODELS_DELETE_TOPIC, { from: 'es', to: 'en' });
    await topics.idle();
    assert.deepStrictEqual(t.of(MODELS_LISTED_TOPIC)[0].installed, []);
    assert.strictEqual(fs.existsSync(pairCacheDir(root, 'es', 'en')), false);
  });

  it('dispose unsubscribes every request topic', () => {
    const t = fakePorts();
    installModelTopics(async () => createModelProvider({ fetch: fakeServer([]).fetch, root }), t.ports).dispose();
    assert.strictEqual(t.handlers.size, 0);
  });
});
