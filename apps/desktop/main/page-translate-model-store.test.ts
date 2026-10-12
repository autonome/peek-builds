/**
 * model-store catalogue tests, on a trimmed recording of Mozilla's `translations-models-v2`
 * collection (page-translate/fixtures/translations-models-v2.json, records copied verbatim).
 * The test sits at the top level of main/ so the shared `dist/main/*.test.js` glob runs it.
 * The pairs kept:
 * es-en, en-de, de-en (plain pairs and the es→de pivot), en-ja (split srcvocab/trgvocab),
 * en-ko and en-ru (two models split by an Android/desktop filter), nb-en (a release model and a
 * nightly-only pre-release), nn-en (nightly-only, so missing on release), en-gl (3.1 and 3.0).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';

import catalogue from './page-translate/fixtures/translations-models-v2.json' with { type: 'json' };
import {
  cachePath,
  candidatesForPair,
  compareModelVersions,
  recordApplies,
  resolvePlan,
  sha256Hex,
  verifyAttachment,
  verifyDecompressed,
  type ModelRecord,
  type PairPlan,
} from './page-translate/model-store.js';

const records = catalogue.data as ModelRecord[];

function summary(step: PairPlan): string {
  const types = Object.keys(step.files).sort().join(',');
  return `${step.sourceLanguage}-${step.targetLanguage} ${step.architecture} ${step.version} [${types}]`;
}

function steps(src: string, tgt: string, options = {}): string[] {
  const plan = resolvePlan(src, tgt, records, options);
  assert.ok(plan.ok, `expected a plan for ${src}-${tgt}, got ${JSON.stringify(plan)}`);
  return plan.steps.map(summary);
}

describe('resolvePlan', () => {
  it('uses the direct model for a pair that has one', () => {
    assert.deepStrictEqual(steps('en', 'de'), ['en-de base-memory 3.0 [lex,model,vocab]']);
  });

  it('pivots through English when the pair has no direct model', () => {
    assert.deepStrictEqual(steps('es', 'de'), [
      'es-en base-memory 3.0 [lex,model,vocab]',
      'en-de base-memory 3.0 [lex,model,vocab]',
    ]);
  });

  it('carries the split source and target vocab files', () => {
    const plan = resolvePlan('en', 'ja', records);
    assert.ok(plan.ok);
    const files = plan.steps[0].files;
    assert.deepStrictEqual(Object.keys(files).sort(), ['lex', 'model', 'srcvocab', 'trgvocab']);
    assert.strictEqual(files.srcvocab?.name, 'srcvocab.enja.spm');
    assert.strictEqual(files.trgvocab?.name, 'trgvocab.enja.spm');
  });

  it('picks the desktop model when a pair has an Android-only one beside it', () => {
    assert.deepStrictEqual(steps('en', 'ru'), ['en-ru base 3.0 [lex,model,vocab]']);
    assert.deepStrictEqual(steps('en', 'ko'), ['en-ko base 3.0 [lex,model,vocab]']);
  });

  it('picks the Android model for an Android environment', () => {
    const env = { os: 'Android', channel: 'release' };
    assert.deepStrictEqual(steps('en', 'ko', { env }), ['en-ko base-memory 3.1 [lex,model,srcvocab,trgvocab]']);
  });

  it('picks the newest version when two models both apply', () => {
    assert.deepStrictEqual(steps('en', 'gl'), ['en-gl base-memory 3.1 [lex,model,vocab]']);
  });

  it('skips nightly-only pre-releases on release, takes them on nightly', () => {
    assert.deepStrictEqual(steps('nb', 'en'), ['nb-en tiny 3.0 [lex,model,vocab]']);
    const nightly = { os: 'Desktop', channel: 'nightly' };
    assert.deepStrictEqual(steps('nn', 'en', { env: nightly }), ['nn-en tiny 3.0a1 [lex,model,vocab]']);
  });

  it('reports a pair with no model at all as unsupported, naming it', () => {
    assert.deepStrictEqual(resolvePlan('en', 'xx', records), {
      ok: false,
      reason: 'unsupported',
      missing: [{ sourceLanguage: 'en', targetLanguage: 'xx' }],
    });
  });

  it('reports a nightly-only pair as unsupported on release', () => {
    assert.deepStrictEqual(resolvePlan('nn', 'en', records), {
      ok: false,
      reason: 'unsupported',
      missing: [{ sourceLanguage: 'nn', targetLanguage: 'en' }],
    });
  });

  it('names only the missing leg of a failed pivot', () => {
    assert.deepStrictEqual(resolvePlan('es', 'xx', records), {
      ok: false,
      reason: 'unsupported',
      missing: [{ sourceLanguage: 'en', targetLanguage: 'xx' }],
    });
    assert.deepStrictEqual(resolvePlan('nn', 'de', records), {
      ok: false,
      reason: 'unsupported',
      missing: [{ sourceLanguage: 'nn', targetLanguage: 'en' }],
    });
  });

  it('refuses a same-language request', () => {
    assert.deepStrictEqual(resolvePlan('de', 'de', records), { ok: false, reason: 'same-language' });
  });

  it('prefers the requested architecture over a newer version', () => {
    const extra: ModelRecord[] = records
      .filter((r) => r.sourceLanguage === 'en' && r.targetLanguage === 'gl' && r.version === '3.0')
      .map((r) => ({ ...r, id: `${r.id}-tiny`, architecture: 'tiny' }));
    const all = [...records, ...extra];
    const plan = resolvePlan('en', 'gl', all, { architecture: 'tiny' });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.steps.map(summary), ['en-gl tiny 3.0 [lex,model,vocab]']);
  });

  it('drops a model missing a file the engine needs', () => {
    const noLex = records.filter((r) => !(r.sourceLanguage === 'en' && r.targetLanguage === 'de' && r.fileType === 'lex'));
    assert.strictEqual(resolvePlan('en', 'de', noLex).ok, false);
  });

  it('drops a model newer than the engine reads', () => {
    const v4 = records
      .filter((r) => r.sourceLanguage === 'en' && r.targetLanguage === 'de')
      .map((r) => ({ ...r, id: `${r.id}-v4`, version: '4.0' }));
    const plan = resolvePlan('en', 'de', [...records, ...v4]);
    assert.ok(plan.ok);
    assert.strictEqual(plan.steps[0].version, '3.0');
    const newerEngine = resolvePlan('en', 'de', [...records, ...v4], { maxMajorVersion: 4 });
    assert.ok(newerEngine.ok);
    assert.strictEqual(newerEngine.steps[0].version, '4.0');
  });
});

describe('candidatesForPair', () => {
  it('lists both desktop-visible models of en-gl, newest first', () => {
    assert.deepStrictEqual(candidatesForPair('en', 'gl', records).map(summary), [
      'en-gl base-memory 3.1 [lex,model,vocab]',
      'en-gl base-memory 3.0 [lex,model,vocab]',
    ]);
  });
});

describe('recordApplies', () => {
  const desktop = { os: 'Desktop', channel: 'release' };
  it('reads every filter shape the collection uses', () => {
    assert.strictEqual(recordApplies({ filter_expression: '' }, desktop), true);
    assert.strictEqual(recordApplies({ filter_expression: "env.appinfo.OS == 'Android'" }, desktop), false);
    assert.strictEqual(recordApplies({ filter_expression: "env.appinfo.OS != 'Android'" }, desktop), true);
    assert.strictEqual(recordApplies({ filter_expression: "env.channel == 'default' || env.channel == 'nightly'" }, desktop), false);
  });

  it('excludes a filter it cannot read', () => {
    assert.strictEqual(recordApplies({ filter_expression: "env.locale == 'de'" }, desktop), false);
    assert.strictEqual(recordApplies({ filter_expression: "env.appinfo.OS != 'Android' && env.channel == 'nightly'" }, desktop), false);
  });

  it('every filter in the fixture is one it can read', () => {
    const unread = records.filter((r) => {
      const expr = r.filter_expression ?? '';
      return expr !== '' && !recordApplies(r, { os: 'Android', channel: 'nightly' }) && !recordApplies(r, desktop);
    });
    assert.deepStrictEqual(unread.map((r) => r.filter_expression), []);
  });
});

describe('compareModelVersions', () => {
  it('orders pre-releases below their release', () => {
    assert.deepStrictEqual(['3.1', '3.0', '3.0a1', '3.0b1', '2.9'].sort(compareModelVersions), ['2.9', '3.0a1', '3.0b1', '3.0', '3.1']);
  });
});

describe('cachePath', () => {
  const root = path.join('/profile', 'translations');
  it('lays out models/<src>-<tgt>/<architecture>/<version>/<fileType>', () => {
    const rec = records.find((r) => r.sourceLanguage === 'en' && r.targetLanguage === 'ja' && r.fileType === 'srcvocab')!;
    assert.strictEqual(cachePath(root, rec), path.join(root, 'models', 'en-ja', 'base-memory', '3.0', 'srcvocab'));
  });

  it('accepts every record in the fixture', () => {
    for (const r of records) assert.ok(cachePath(root, r).startsWith(root + path.sep));
  });

  it('rejects a record that would leave the cache root', () => {
    const rec = records[0];
    assert.throws(() => cachePath(root, { ...rec, version: '..' }), /unsafe path segment/);
    assert.throws(() => cachePath(root, { ...rec, architecture: '../../etc' }), /unsafe path segment/);
    assert.throws(() => cachePath(root, { ...rec, sourceLanguage: '../x' }), /unsafe language tag/);
    assert.throws(() => cachePath(root, { ...rec, fileType: 'passwd' }), /unknown model file type/);
  });
});

describe('hash check', () => {
  const bytes = new TextEncoder().encode('model bytes');
  const good = { decompressedHash: sha256Hex(bytes), decompressedSize: bytes.byteLength };

  it('accepts matching size and SHA-256', () => {
    assert.strictEqual(sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.strictEqual(verifyDecompressed(bytes, good), true);
    assert.strictEqual(verifyDecompressed(bytes, { ...good, decompressedHash: good.decompressedHash.toUpperCase() }), true);
  });

  it('rejects a changed byte or a wrong size', () => {
    const changed = bytes.slice();
    changed[0] ^= 1;
    assert.strictEqual(verifyDecompressed(changed, good), false);
    assert.strictEqual(verifyDecompressed(bytes.subarray(1), good), false);
  });

  it('checks the compressed attachment against its own hash and size', () => {
    const rec = { attachment: { ...records[0].attachment, hash: sha256Hex(bytes), size: bytes.byteLength } };
    assert.strictEqual(verifyAttachment(bytes, rec), true);
    assert.strictEqual(verifyAttachment(bytes, records[0]), false);
  });
});
