import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as shared from './index.js';

const require = createRequire(import.meta.url);
const server = require('../../apps/server/capabilities.js');
const models = () => ({
  allow: [{ model: 'operator:text-v1', task: 'text.generate' }],
  maxInputBytes: 16384, maxOutputBytes: 32768, maxOutputTokens: 512,
  maxDurationMs: 30000, maxConcurrent: 1,
});
const manifest = value => ({
  manifestVersion: 3, id: 'test', name: 'Test',
  tiles: [{ id: 'main', url: 'index.html' }], capabilities: { models: value },
});

for (const [name, api] of [['shared', shared], ['server', server]]) {
  test(`${name}: valid models fragment, existing tiles requirement`, () => {
    assert.deepEqual(api.validateTileManifest(manifest(models())), []);
    const missingTiles = manifest(models());
    delete missingTiles.tiles;
    assert(api.validateTileManifest(missingTiles).some(e => e.path === 'tiles'));
    assert.equal(api.parseManifestJSON(missingTiles), null);
  });

  test(`${name}: strict models schema rejects malformed shapes and identifiers`, () => {
    const invalid = [null, true, false, [], 'models', {},
      { ...models(), extra: true }, { ...models(), allow: [] },
      { ...models(), allow: Array.from({ length: 51 }, (_, i) => ({ model: `m${i}`, task: 'text.generate' })) },
      { ...models(), allow: [null] }, { ...models(), allow: [[]] },
      { ...models(), allow: [models().allow[0], models().allow[0]] },
      { ...models(), allow: [{ ...models().allow[0], provider: 'x' }] },
    ];
    for (const model of ['', '*', 'operator:*', 'https://host/model', 'a b', 'é', 'a'.repeat(129), 42, null]) {
      invalid.push({ ...models(), allow: [{ model, task: 'text.generate' }] });
    }
    for (const task of [undefined, null, 'chat', 'image.generate', '*']) {
      invalid.push({ ...models(), allow: [{ model: 'm', task }] });
    }
    for (const key of Object.keys(models()).filter(k => k !== 'allow')) {
      for (const value of [undefined, null, true, '1', NaN, Infinity, -Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, models()[key] + 1]) {
        invalid.push({ ...models(), [key]: value });
      }
      const missing = models();
      delete missing[key];
      invalid.push(missing);
    }
    for (const value of invalid) {
      assert(api.validateTileManifest(manifest(value)).length > 0);
      assert.equal(api.parseManifestJSON(manifest(value)), null);
      for (const builtin of [false, true]) {
        assert.equal(api.resolveCapabilities('test', { models: value }, builtin, { models: models() }).capabilities.models, undefined);
        assert.equal(api.resolveCapabilities('test', { models: models() }, builtin, { models: value }).capabilities.models, undefined);
      }
    }
  });

  test(`${name}: request never grants, including builtin and legacy privileged capabilities`, () => {
    for (const builtin of [false, true]) {
      for (const consent of [undefined, null, true, {}, { models: true }]) {
        const result = api.resolveCapabilities('test', { models: models() }, builtin, consent);
        assert.deepEqual(result.capabilities, {});
        assert.deepEqual(result.denied, ['models']);
      }
      const result = api.resolveCapabilities('test', { models: models() }, builtin, { models: models() });
      assert.deepEqual(result.capabilities, { models: models() });
      for (const key of ['network', 'secrets', 'jobs']) assert.equal(result.capabilities[key], undefined);
      assert.deepEqual(api.resolveCapabilities('test', {}, builtin, { models: models() }).capabilities, {});
    }
    assert.equal(api.createTrustedBuiltinGrant('core').capabilities.models, undefined);
    assert.deepEqual(api.resolveCapabilities('test', { network: { domains: ['example.com'] }, secrets: true }, false).capabilities,
      { network: { domains: ['example.com'] }, secrets: true });
  });

  test(`${name}: allowlists intersect exactly, lower limits win, results are detached`, () => {
    const request = models();
    request.allow.push({ model: 'requested-only', task: 'text.generate' });
    request.maxInputBytes = 100;
    const consent = models();
    consent.allow.push({ model: 'consent-only', task: 'text.generate' });
    consent.maxOutputBytes = 200;
    consent.maxOutputTokens = 64;
    consent.maxDurationMs = 1000;
    const result = api.resolveCapabilities('test', { models: request }, true, { models: consent });
    assert.deepEqual(result.capabilities.models, {
      allow: models().allow, maxInputBytes: 100, maxOutputBytes: 200,
      maxOutputTokens: 64, maxDurationMs: 1000, maxConcurrent: 1,
    });
    assert.deepEqual(result.denied, []);
    request.allow[0].model = 'changed';
    consent.allow[0].model = 'also-changed';
    assert.equal(result.capabilities.models.allow[0].model, 'operator:text-v1');
    const denied = api.resolveCapabilities('test', { models: request }, false, { models: consent });
    assert.equal(denied.capabilities.models, undefined);
    assert.deepEqual(denied.denied, ['models']);
  });
}
