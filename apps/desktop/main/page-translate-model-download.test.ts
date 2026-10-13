/**
 * model-download tests. Every fetch is a fake that serves bytes built here, so no test touches
 * the network. The test sits at the top level of main/ so the shared `dist/main/*.test.js` glob
 * runs it.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
  attachmentUrl,
  DEFAULT_REMOTE_SETTINGS_SERVER,
  downloadModelFile,
  downloadPair,
  fetchAttachmentBase,
  fetchModelRecords,
  ModelDownloadError,
  readRecordsCache,
  remoteSettingsServerFromEnv,
  writeRecordsCache,
  type FetchLike,
  type FetchResponseLike,
} from './page-translate/model-download.js';
import { cachePath, sha256Hex, type ModelRecord, type PairPlan } from './page-translate/model-store.js';

const ATTACH_BASE = 'https://attachments.example.test/';

function makeRecord(fileType: string, content: string, overrides: Partial<ModelRecord> = {}) {
  const raw = Buffer.from(content);
  const compressed = zlib.zstdCompressSync(raw);
  const record: ModelRecord = {
    id: `id-${fileType}`,
    name: `${fileType}.ende.bin`,
    fileType,
    sourceLanguage: 'en',
    targetLanguage: 'de',
    architecture: 'base',
    version: '3.0',
    decompressedHash: sha256Hex(raw),
    decompressedSize: raw.byteLength,
    attachment: {
      hash: sha256Hex(compressed),
      size: compressed.byteLength,
      filename: `${fileType}.ende.bin.zst`,
      location: `main-workspace/translations-models-v2/${fileType}.zst`,
    },
    ...overrides,
  };
  return { record, raw, compressed };
}

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

/** A fake fetch serving a URL → response table and recording every URL asked for. */
function fakeFetch(routes: Record<string, () => FetchResponseLike | Promise<FetchResponseLike>>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : response({}, 404);
  };
  return { fetch, calls };
}

const serverRoot = { capabilities: { attachments: { base_url: ATTACH_BASE } } };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-model-download-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('model-download server addresses', () => {
  it('reads the attachment base from the default server root', async () => {
    const { fetch, calls } = fakeFetch({ [`${DEFAULT_REMOTE_SETTINGS_SERVER}/`]: () => response(serverRoot) });
    assert.strictEqual(await fetchAttachmentBase({ fetch }), ATTACH_BASE);
    assert.deepStrictEqual(calls, ['https://firefox.settings.services.mozilla.com/v1/']);
  });

  it('a mirror server replaces every address', async () => {
    const mirror = 'https://mirror.example.test/v1';
    const { record, compressed } = makeRecord('lex', 'lex bytes');
    const { fetch, calls } = fakeFetch({
      [`${mirror}/`]: () => response({ capabilities: { attachments: { base_url: 'https://mirror-cdn.example.test' } } }),
      [`${mirror}/buckets/main/collections/translations-models-v2/records`]: () => response({ data: [record] }),
      [`https://mirror-cdn.example.test/${record.attachment.location}`]: () => response(compressed),
    });
    assert.deepStrictEqual(await fetchModelRecords({ fetch, server: `${mirror}/` }), [record]);
    await downloadModelFile(record, { fetch, server: mirror, root });
    assert.ok(calls.every((u) => u.startsWith('https://mirror')), calls.join('\n'));
  });

  it('rejects a server root with no attachments base', async () => {
    const { fetch } = fakeFetch({ [`${DEFAULT_REMOTE_SETTINGS_SERVER}/`]: () => response({ capabilities: {} }) });
    await assert.rejects(fetchAttachmentBase({ fetch }), { code: 'bad-response' });
  });

  it('rejects attachment locations that leave the base', () => {
    for (const location of ['../x.zst', '/abs.zst', 'a/../../b', 'https://evil.test/x', '', 'a\\b']) {
      const { record } = makeRecord('lex', 'x');
      record.attachment.location = location;
      assert.throws(() => attachmentUrl(ATTACH_BASE, record), { code: 'unsafe-location' }, location);
    }
    const { record } = makeRecord('lex', 'x');
    assert.strictEqual(attachmentUrl(ATTACH_BASE, record), `${ATTACH_BASE}${record.attachment.location}`);
  });
});

describe('model-download downloadModelFile', () => {
  it('downloads, decompresses, verifies and writes to cachePath', async () => {
    const { record, raw, compressed } = makeRecord('model', 'model weights '.repeat(500));
    const { fetch, calls } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(compressed) });
    const result = await downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE });
    assert.deepStrictEqual(result, { path: cachePath(root, record), downloaded: true });
    assert.deepStrictEqual(fs.readFileSync(result.path), raw);
    assert.ok(!fs.existsSync(`${result.path}.tmp`));
    assert.strictEqual(calls.length, 1);
  });

  it('reuses a valid cached file without fetching', async () => {
    const { record, compressed } = makeRecord('vocab', 'vocab');
    const { fetch, calls } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(compressed) });
    await downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE });
    const again = await downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE });
    assert.strictEqual(again.downloaded, false);
    assert.strictEqual(calls.length, 1);
  });

  it('replaces a corrupt cached file', async () => {
    const { record, raw, compressed } = makeRecord('vocab', 'vocab');
    const target = cachePath(root, record);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'garbage');
    const { fetch } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(compressed) });
    assert.strictEqual((await downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE })).downloaded, true);
    assert.deepStrictEqual(fs.readFileSync(target), raw);
  });

  it('a download that does not match the attachment hash writes nothing', async () => {
    const { record, compressed } = makeRecord('lex', 'lex');
    const tampered = Buffer.from(compressed);
    tampered[tampered.length - 1] ^= 0xff;
    const { fetch } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(tampered) });
    await assert.rejects(downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE }), { code: 'attachment-mismatch' });
    assert.ok(!fs.existsSync(path.join(root, 'models')));
  });

  it('decompressed bytes that do not match decompressedHash write nothing', async () => {
    const { record, compressed } = makeRecord('lex', 'lex', {});
    record.decompressedHash = sha256Hex(Buffer.from('something else'));
    const { fetch } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(compressed) });
    await assert.rejects(downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE }), { code: 'decompressed-mismatch' });
    assert.ok(!fs.existsSync(cachePath(root, record)));
  });

  it('bytes that are not zstd fail as a decompress error', async () => {
    const notZstd = Buffer.from('plain text, not zstd');
    const { record } = makeRecord('lex', 'lex');
    record.attachment.hash = sha256Hex(notZstd);
    record.attachment.size = notZstd.byteLength;
    const { fetch } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response(notZstd) });
    await assert.rejects(downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE }), { code: 'decompress-failed' });
  });

  it('an interrupted download leaves no file and the next attempt succeeds', async () => {
    const { record, raw, compressed } = makeRecord('model', 'weights');
    let attempt = 0;
    const { fetch } = fakeFetch({
      [`${ATTACH_BASE}${record.attachment.location}`]: () => {
        attempt += 1;
        if (attempt === 1) {
          return { ...response(compressed), arrayBuffer: () => Promise.reject(new Error('connection reset')) };
        }
        return response(compressed);
      },
    });
    await assert.rejects(downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE }), /connection reset/);
    assert.ok(!fs.existsSync(cachePath(root, record)));
    await downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE });
    assert.deepStrictEqual(fs.readFileSync(cachePath(root, record)), raw);
  });

  it('an HTTP error is reported with its status', async () => {
    const { record } = makeRecord('lex', 'lex');
    const { fetch } = fakeFetch({ [`${ATTACH_BASE}${record.attachment.location}`]: () => response({}, 503) });
    await assert.rejects(downloadModelFile(record, { fetch, root, attachmentBase: ATTACH_BASE }), (err: unknown) => {
      assert.ok(err instanceof ModelDownloadError);
      assert.strictEqual(err.code, 'http');
      assert.match(err.message, /503/);
      return true;
    });
  });
});

describe('model-download downloadPair and records cache', () => {
  it('fetches the attachment base once and every file of the model', async () => {
    const files = ['model', 'lex', 'vocab'].map((t) => makeRecord(t, `${t} content`));
    const routes: Record<string, () => FetchResponseLike> = { [`${DEFAULT_REMOTE_SETTINGS_SERVER}/`]: () => response(serverRoot) };
    for (const f of files) routes[`${ATTACH_BASE}${f.record.attachment.location}`] = () => response(f.compressed);
    const { fetch, calls } = fakeFetch(routes);
    const plan: PairPlan = {
      sourceLanguage: 'en',
      targetLanguage: 'de',
      architecture: 'base',
      version: '3.0',
      files: Object.fromEntries(files.map((f) => [f.record.fileType, f.record])),
    };
    const paths = await downloadPair(plan, { fetch, root });
    assert.deepStrictEqual(Object.keys(paths).sort(), ['lex', 'model', 'vocab']);
    for (const f of files) assert.deepStrictEqual(fs.readFileSync(cachePath(root, f.record)), f.raw);
    assert.strictEqual(calls.filter((u) => u === `${DEFAULT_REMOTE_SETTINGS_SERVER}/`).length, 1);

    // Everything cached: no network at all on the second call.
    calls.length = 0;
    await downloadPair(plan, { fetch, root });
    assert.deepStrictEqual(calls, []);
  });

  it('records.json round-trips and reads null when absent', async () => {
    assert.strictEqual(await readRecordsCache(root), null);
    const { record } = makeRecord('lex', 'lex');
    await writeRecordsCache(root, [record]);
    assert.deepStrictEqual(await readRecordsCache(root), [record]);
  });
});

describe('remoteSettingsServerFromEnv', () => {
  it('names a mirror only for an http(s) address', () => {
    assert.strictEqual(remoteSettingsServerFromEnv({}), undefined);
    assert.strictEqual(remoteSettingsServerFromEnv({ PEEK_TRANSLATE_SERVER: '' }), undefined);
    assert.strictEqual(remoteSettingsServerFromEnv({ PEEK_TRANSLATE_SERVER: 'file:///etc' }), undefined);
    assert.strictEqual(remoteSettingsServerFromEnv({ PEEK_TRANSLATE_SERVER: ' http://127.0.0.1:9/v1 ' }), 'http://127.0.0.1:9/v1');
  });
});
