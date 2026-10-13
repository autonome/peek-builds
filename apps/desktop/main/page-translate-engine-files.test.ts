/**
 * engine-files tests. Every fetch is a fake serving records and bytes built here, so no test
 * touches the network. The record shapes follow the live `translations-wasm` collection.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createEngineProvider,
  engineCachePath,
  resolveEngineRecord,
  type EngineRecord,
} from './page-translate/engine-files.js';
import {
  DEFAULT_REMOTE_SETTINGS_SERVER,
  downloadEngineFile,
  readEngineRecordsCache,
  type FetchLike,
  type FetchResponseLike,
} from './page-translate/model-download.js';
import { sha256Hex } from './page-translate/model-store.js';

const SERVER = DEFAULT_REMOTE_SETTINGS_SERVER;
const WASM_RECORDS_URL = `${SERVER}/buckets/main/collections/translations-wasm/records`;
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

function wasmRecord(name: string, version: string, content: string, extra: Partial<EngineRecord> = {}) {
  const bytes = Buffer.from(content);
  const location = `main-workspace/translations-wasm/${name}-${version}.wasm`;
  const record: EngineRecord = {
    id: `${name}-${version}`,
    name,
    version,
    release: `v${version}`,
    filter_expression: '',
    attachment: { hash: sha256Hex(bytes), size: bytes.byteLength, filename: `${name}.wasm`, location, mimetype: 'application/wasm' },
    ...extra,
  };
  return { record, bytes, url: `${ATTACH_BASE}${location}` };
}

/** The live collection's shape: three bergamot majors and fasttext. */
function fakeServer() {
  const entries = [
    wasmRecord('bergamot-translator', '3.0', 'wasm v3.0'),
    wasmRecord('bergamot-translator', '2.0', 'wasm v2.0'),
    wasmRecord('bergamot-translator', '1.1', 'wasm v1.1'),
    wasmRecord('fasttext-wasm', '1.0', 'fasttext'),
  ];
  const calls: string[] = [];
  let offline = false;
  let corrupt = false;
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    if (offline) throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
    if (url === `${SERVER}/`) return response({ capabilities: { attachments: { base_url: ATTACH_BASE } } });
    if (url === WASM_RECORDS_URL) return response({ data: entries.map((e) => e.record) });
    const entry = entries.find((e) => e.url === url);
    if (!entry) return response({}, 404);
    return response(corrupt ? Buffer.from('tampered!') : entry.bytes);
  };
  return {
    fetch,
    calls,
    v3: entries[0],
    setOffline(v: boolean) {
      offline = v;
    },
    setCorrupt(v: boolean) {
      corrupt = v;
    },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-engine-files-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveEngineRecord', () => {
  it('takes the newest bergamot-translator of major 3 and ignores other wasm', () => {
    const records = [
      wasmRecord('bergamot-translator', '2.0', 'a').record,
      wasmRecord('bergamot-translator', '3.0', 'b').record,
      wasmRecord('bergamot-translator', '3.1', 'c').record,
      wasmRecord('bergamot-translator', '4.0', 'd').record,
      wasmRecord('fasttext-wasm', '3.5', 'e').record,
    ];
    assert.strictEqual(resolveEngineRecord(records)?.version, '3.1');
  });

  it('answers null when no record of the supported major exists', () => {
    assert.strictEqual(resolveEngineRecord([wasmRecord('bergamot-translator', '2.0', 'a').record]), null);
    assert.strictEqual(resolveEngineRecord([]), null);
  });

  it('skips records whose filter does not apply, and malformed ones', () => {
    const nightly = wasmRecord('bergamot-translator', '3.2', 'n', { filter_expression: "env.channel == 'nightly'" }).record;
    const release = wasmRecord('bergamot-translator', '3.0', 'r').record;
    const broken = { ...wasmRecord('bergamot-translator', '3.9', 'x').record, version: 'latest' };
    assert.strictEqual(resolveEngineRecord([nightly, release, broken])?.version, '3.0');
  });
});

describe('engineCachePath', () => {
  it('places the wasm under engine/<name>/<version> with a fixed file name', () => {
    assert.strictEqual(
      engineCachePath(root, { version: '3.0' }),
      path.join(root, 'engine', 'bergamot-translator', '3.0', 'bergamot-translator.wasm'),
    );
  });

  it('refuses a version that is not a version', () => {
    for (const version of ['../x', '3.0/../../y', '', '3']) {
      assert.throws(() => engineCachePath(root, { version }), /unsafe engine version/, version);
    }
  });
});

describe('downloadEngineFile', () => {
  it('downloads, verifies and writes; a second call reuses the file', async () => {
    const server = fakeServer();
    const target = engineCachePath(root, server.v3.record);
    const first = await downloadEngineFile(server.v3.record, target, { fetch: server.fetch, root });
    assert.deepStrictEqual(first, { path: target, downloaded: true });
    assert.deepStrictEqual(fs.readFileSync(target), server.v3.bytes);
    const before = server.calls.length;
    const second = await downloadEngineFile(server.v3.record, target, { fetch: server.fetch, root });
    assert.strictEqual(second.downloaded, false);
    assert.strictEqual(server.calls.length, before);
  });

  it('a mismatching download leaves nothing at the target', async () => {
    const server = fakeServer();
    server.setCorrupt(true);
    const target = engineCachePath(root, server.v3.record);
    await assert.rejects(downloadEngineFile(server.v3.record, target, { fetch: server.fetch, root }), { code: 'attachment-mismatch' });
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(`${target}.tmp`), false);
  });

  it('replaces a cached file that no longer matches its record', async () => {
    const server = fakeServer();
    const target = engineCachePath(root, server.v3.record);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stale bytes');
    const result = await downloadEngineFile(server.v3.record, target, { fetch: server.fetch, root });
    assert.strictEqual(result.downloaded, true);
    assert.deepStrictEqual(fs.readFileSync(target), server.v3.bytes);
  });
});

describe('createEngineProvider', () => {
  it('ensure fetches the records once, downloads the v3 wasm and caches the records', async () => {
    const server = fakeServer();
    const provider = createEngineProvider({ fetch: server.fetch, root });
    const result = await provider.ensure();
    assert.ok(result.ok);
    assert.strictEqual(result.record.version, '3.0');
    assert.strictEqual(result.downloaded, true);
    assert.strictEqual(result.path, engineCachePath(root, { version: '3.0' }));
    assert.deepStrictEqual(server.calls, [WASM_RECORDS_URL, `${SERVER}/`, server.v3.url]);
    assert.strictEqual((await readEngineRecordsCache(root))?.length, 4);
    const again = await provider.ensure();
    assert.ok(again.ok);
    assert.strictEqual(again.downloaded, false);
    assert.strictEqual(server.calls.length, 3);
  });

  it('concurrent ensure calls share one download', async () => {
    const server = fakeServer();
    const provider = createEngineProvider({ fetch: server.fetch, root });
    const [a, b] = await Promise.all([provider.ensure(), provider.ensure()]);
    assert.strictEqual(a, b);
    assert.strictEqual(server.calls.filter((u) => u === server.v3.url).length, 1);
  });

  it('offline, an engine already on disk is found through the cached records', async () => {
    const server = fakeServer();
    await createEngineProvider({ fetch: server.fetch, root }).ensure();
    server.setOffline(true);
    const result = await createEngineProvider({ fetch: server.fetch, root }).ensure();
    assert.ok(result.ok);
    assert.strictEqual(result.downloaded, false);
  });

  it('offline with nothing cached fails with the network error', async () => {
    const server = fakeServer();
    server.setOffline(true);
    await assert.rejects(createEngineProvider({ fetch: server.fetch, root }).ensure(), /ERR_INTERNET_DISCONNECTED/);
  });

  it('answers no-engine when the collection has no supported record', async () => {
    const fetch: FetchLike = async (url) =>
      url === WASM_RECORDS_URL ? response({ data: [wasmRecord('bergamot-translator', '2.0', 'old').record] }) : response({}, 404);
    assert.deepStrictEqual(await createEngineProvider({ fetch, root }).ensure(), { ok: false, reason: 'no-engine' });
  });

  it('a mirror server replaces every address', async () => {
    const mirror = 'https://mirror.example.test/v1';
    const { record, bytes } = wasmRecord('bergamot-translator', '3.0', 'mirror wasm');
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      if (url === `${mirror}/buckets/main/collections/translations-wasm/records`) return response({ data: [record] });
      if (url === `${mirror}/`) return response({ capabilities: { attachments: { base_url: 'https://mirror-cdn.example.test/' } } });
      if (url === `https://mirror-cdn.example.test/${record.attachment.location}`) return response(bytes);
      return response({}, 404);
    };
    const result = await createEngineProvider({ fetch, root, server: mirror }).ensure();
    assert.ok(result.ok);
    assert.ok(calls.every((u) => u.startsWith('https://mirror')), calls.join('\n'));
  });
});
