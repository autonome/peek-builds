/**
 * Engine resources tests: the engine provider's `estimate`, the resolver that turns a pair into
 * the files a Bergamot request carries (`engine-resources.ts`), the engine host sending them
 * (`engine-host.ts` `resources` option), and the models manager counting the engine in its
 * estimate and download (`model-topics.ts`). Every fetch is a fake, so no test touches the network.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { createEngineProvider } from './page-translate/engine-files.js';
import { createEngineHost, EngineHostError, type EngineProcess } from './page-translate/engine-host.js';
import type { EngineToHost, HostToEngine, TranslateMessage } from './page-translate/engine-protocol.js';
import { createResourceResolver, MODELS_NEEDED, UNSUPPORTED_PAIR } from './page-translate/engine-resources.js';
import { DEFAULT_REMOTE_SETTINGS_SERVER, type FetchLike, type FetchResponseLike } from './page-translate/model-download.js';
import { createModelProvider } from './page-translate/model-provider.js';
import { installModelTopics, MODELS_DOWNLOAD_TOPIC, MODELS_ESTIMATE_TOPIC, MODELS_ESTIMATED_TOPIC, MODELS_PROGRESS_TOPIC } from './page-translate/model-topics.js';
import { sha256Hex, type ModelRecord } from './page-translate/model-store.js';

const SERVER = DEFAULT_REMOTE_SETTINGS_SERVER;
const MODELS_URL = `${SERVER}/buckets/main/collections/translations-models-v2/records`;
const WASM_URL = `${SERVER}/buckets/main/collections/translations-wasm/records`;
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

/** Serves es→en and en→de models and a v3 engine wasm, counting attachment fetches. */
function fakeServer() {
  const records: ModelRecord[] = [];
  const blobs: Record<string, Uint8Array> = {};
  for (const [src, tgt] of [
    ['es', 'en'],
    ['en', 'de'],
  ]) {
    for (const fileType of ['model', 'lex', 'vocab']) {
      const raw = Buffer.from(`${fileType} ${src}${tgt} `.repeat(20));
      const compressed = zlib.zstdCompressSync(raw);
      const location = `m/${src}${tgt}-${fileType}.zst`;
      blobs[`${ATTACH_BASE}${location}`] = compressed;
      records.push({
        id: `${src}${tgt}-${fileType}`,
        name: `${fileType}.${src}${tgt}.intgemm.alphas.bin`,
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
  const wasm = Buffer.from('fake engine wasm bytes');
  const wasmLocation = 'w/bergamot-translator-3.0.wasm';
  blobs[`${ATTACH_BASE}${wasmLocation}`] = wasm;
  const wasmRecord = {
    id: 'bergamot-3.0',
    name: 'bergamot-translator',
    version: '3.0',
    filter_expression: '',
    attachment: { hash: sha256Hex(wasm), size: wasm.byteLength, filename: 'bergamot-translator.wasm', location: wasmLocation },
  };
  const attachmentFetches: string[] = [];
  const fetch: FetchLike = async (url) => {
    if (url === `${SERVER}/`) return response({ capabilities: { attachments: { base_url: ATTACH_BASE } } });
    if (url === MODELS_URL) return response({ data: records });
    if (url === WASM_URL) return response({ data: [wasmRecord] });
    const blob = blobs[url];
    if (blob) attachmentFetches.push(url);
    return blob ? response(blob) : response({}, 404);
  };
  return { fetch, attachmentFetches, wasmBytes: wasm.byteLength };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-engine-resources-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function providers(fetch: FetchLike) {
  const models = createModelProvider({ fetch, root });
  const engine = createEngineProvider({ fetch, root });
  return { models, engine, modelsFn: async () => models, engineFn: async () => engine };
}

describe('engine provider estimate', () => {
  it('names the wasm bytes until the engine is on disk, and never downloads', async () => {
    const server = fakeServer();
    const { engine } = providers(server.fetch);
    const before = await engine.estimate();
    assert.ok(before.ok);
    assert.strictEqual(before.downloadBytes, server.wasmBytes);
    assert.deepStrictEqual(server.attachmentFetches, []);
    await engine.ensure();
    const after = await engine.estimate();
    assert.ok(after.ok);
    assert.strictEqual(after.downloadBytes, 0);
    assert.strictEqual(after.path, before.path);
  });
});

describe('createResourceResolver', () => {
  it('refuses with models-needed while anything is missing, fetching nothing', async () => {
    const server = fakeServer();
    const p = providers(server.fetch);
    const resolver = createResourceResolver({ models: p.modelsFn, engine: p.engineFn });
    await assert.rejects(resolver.resolve('es', 'en'), (err: unknown) => err instanceof EngineHostError && err.code === MODELS_NEEDED && err.message === MODELS_NEEDED);
    await p.models.ensure('es', 'en');
    await assert.rejects(resolver.resolve('es', 'en'), (err: unknown) => (err as EngineHostError).code === MODELS_NEEDED, 'engine still missing');
    const fetchedBefore = server.attachmentFetches.length;
    await p.engine.ensure();
    assert.strictEqual(server.attachmentFetches.length, fetchedBefore + 1);
    const resources = await resolver.resolve('es', 'en');
    assert.strictEqual(server.attachmentFetches.length, fetchedBefore + 1, 'resolving downloads nothing');
    assert.ok(fs.existsSync(resources.wasmPath));
    assert.strictEqual(resources.steps.length, 1);
    assert.deepStrictEqual([resources.steps[0].from, resources.steps[0].to, resources.steps[0].modelName], ['es', 'en', 'model.esen.intgemm.alphas.bin']);
    for (const f of ['model', 'lex', 'vocab'] as const) assert.ok(fs.existsSync(resources.steps[0].files[f]!), f);
  });

  it('pivots through English with both directions', async () => {
    const server = fakeServer();
    const p = providers(server.fetch);
    await p.engine.ensure();
    await p.models.ensure('es', 'de');
    const resources = await createResourceResolver({ models: p.modelsFn, engine: p.engineFn }).resolve('es', 'de');
    assert.deepStrictEqual(
      resources.steps.map((s) => `${s.from}-${s.to}`),
      ['es-en', 'en-de'],
    );
  });

  it('keeps an answer, and resolves again once a file of it is gone', async () => {
    const server = fakeServer();
    const p = providers(server.fetch);
    await p.engine.ensure();
    await p.models.ensure('es', 'en');
    let planCalls = 0;
    const counted = { ...p.models, plan: (...args: Parameters<typeof p.models.plan>) => (planCalls++, p.models.plan(...args)) };
    const resolver = createResourceResolver({ models: async () => counted, engine: p.engineFn });
    const first = await resolver.resolve('es', 'en');
    assert.strictEqual(await resolver.resolve('es', 'en'), first);
    assert.strictEqual(planCalls, 1);
    fs.rmSync(first.steps[0].files.model!);
    await assert.rejects(resolver.resolve('es', 'en'), (err: unknown) => (err as EngineHostError).code === MODELS_NEEDED);
    assert.strictEqual(planCalls, 2);
  });

  it('answers unsupported-pair when no model covers the pair', async () => {
    const p = providers(fakeServer().fetch);
    const resolver = createResourceResolver({ models: p.modelsFn, engine: p.engineFn });
    await assert.rejects(resolver.resolve('fi', 'ja'), (err: unknown) => (err as EngineHostError).code === UNSUPPORTED_PAIR);
  });
});

function fakeProcess() {
  const sent: HostToEngine[] = [];
  let onMessage: (m: EngineToHost) => void = () => {};
  let spawned = 0;
  const spawn = (): EngineProcess => {
    spawned++;
    queueMicrotask(() => onMessage({ type: 'ready', mode: 'bergamot' }));
    return {
      postMessage: (m) => {
        sent.push(m);
        if (m.type === 'translate') queueMicrotask(() => onMessage({ type: 'result', id: m.id, translations: m.segments.map((s) => s.toUpperCase()) }));
      },
      onMessage: (fn) => {
        onMessage = fn;
      },
      onExit: () => {},
      kill: () => {},
    };
  };
  return { spawn, sent, spawnedCount: () => spawned };
}

describe('engine host with a resources resolver', () => {
  const resources = { wasmPath: '/x/engine.wasm', steps: [{ from: 'es', to: 'en', modelName: 'model.esen.intgemm.alphas.bin', files: { model: '/x/m' } }] };

  it('sends the resolved files with the request', async () => {
    const proc = fakeProcess();
    const host = createEngineHost({ spawn: proc.spawn, resources: async () => resources, setTimer: () => 0, clearTimer: () => {} });
    const out = await host.translate({ from: 'es', to: 'en', segments: ['hola'], isHTML: false, signal: new AbortController().signal });
    assert.deepStrictEqual(out, ['HOLA']);
    assert.deepStrictEqual((proc.sent[0] as TranslateMessage).resources, resources);
    host.dispose();
  });

  it('fails with the resolver code and spawns no process', async () => {
    const proc = fakeProcess();
    const host = createEngineHost({
      spawn: proc.spawn,
      resources: async () => {
        throw new EngineHostError(MODELS_NEEDED, MODELS_NEEDED);
      },
    });
    await assert.rejects(
      host.translate({ from: 'es', to: 'en', segments: ['hola'], isHTML: false, signal: new AbortController().signal }),
      (err: unknown) => (err as EngineHostError).code === MODELS_NEEDED,
    );
    assert.strictEqual(proc.spawnedCount(), 0);
    assert.strictEqual(host.running(), false);
  });

  it('a cancel while resolving sends nothing', async () => {
    const proc = fakeProcess();
    let release: () => void = () => {};
    const host = createEngineHost({
      spawn: proc.spawn,
      resources: () => new Promise((r) => (release = () => r(resources))),
    });
    const ac = new AbortController();
    const result = host.translate({ from: 'es', to: 'en', segments: ['hola'], isHTML: false, signal: ac.signal });
    ac.abort();
    await assert.rejects(result, (err: unknown) => (err as EngineHostError).code === 'aborted');
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(proc.sent, []);
    assert.strictEqual(proc.spawnedCount(), 0);
  });
});

function fakePorts() {
  const handlers = new Map<string, (msg: unknown) => void>();
  const published: Array<{ topic: string; msg: any }> = [];
  return {
    of: (topic: string) => published.filter((p) => p.topic === topic).map((p) => p.msg),
    send: (topic: string, msg: unknown) => handlers.get(topic)?.(msg),
    ports: {
      subscribe: (topic: string, cb: (msg: unknown) => void) => void handlers.set(topic, cb),
      unsubscribe: (topic: string) => void handlers.delete(topic),
      publish: (topic: string, msg: unknown) => void published.push({ topic, msg }),
    },
  };
}

describe('models manager with the engine', () => {
  it('counts the engine in the first estimate, downloads it with the pair, and not again', async () => {
    const server = fakeServer();
    const p = providers(server.fetch);
    const bus = fakePorts();
    const topics = installModelTopics(p.modelsFn, bus.ports, p.engineFn);
    bus.send(MODELS_ESTIMATE_TOPIC, { from: 'es', to: 'en' });
    await topics.idle();
    const [first] = bus.of(MODELS_ESTIMATED_TOPIC);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.engineBytes, server.wasmBytes);
    const modelBytes = first.steps.reduce((n: number, s: { downloadBytes: number }) => n + s.downloadBytes, 0);
    assert.strictEqual(first.downloadBytes, modelBytes + server.wasmBytes);

    bus.send(MODELS_DOWNLOAD_TOPIC, { from: 'es', to: 'en' });
    await topics.idle();
    assert.deepStrictEqual(
      bus.of(MODELS_PROGRESS_TOPIC).map((m) => m.phase),
      ['downloading', 'done'],
    );
    assert.ok((await p.engine.estimate()).ok);

    bus.send(MODELS_ESTIMATE_TOPIC, { from: 'en', to: 'de' });
    await topics.idle();
    const second = bus.of(MODELS_ESTIMATED_TOPIC)[1];
    assert.strictEqual(second.engineBytes, 0);
    assert.ok(second.downloadBytes > 0);

    const resources = await createResourceResolver({ models: p.modelsFn, engine: p.engineFn }).resolve('es', 'en');
    assert.ok(fs.existsSync(resources.wasmPath));
    topics.dispose();
  });
});
