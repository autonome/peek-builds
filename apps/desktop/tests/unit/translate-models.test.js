/**
 * The translation models manager view: its page (lit importmap, `<peek-*>` components, every
 * topic it uses allowed by the manifest) and the pure state in
 * `features/translate/models-logic.js`.
 *
 * Run via: node --test tests/unit/translate-models.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INITIAL_MODELS_STATE,
  MODELS_TOPICS,
  answerPrompt,
  applyEstimated,
  applyListed,
  applyProgress,
  directionKey,
  formatBytes,
  modelsView,
  promptText,
  requestDelete,
  requestDownload,
} from '../../features/translate/models-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '..', 'features', 'translate');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
const html = readFileSync(join(dir, 'models.html'), 'utf-8');
const script = readFileSync(join(dir, 'models.js'), 'utf-8');

const ES_EN = { sourceLanguage: 'es', targetLanguage: 'en' };
const EN_DE = { sourceLanguage: 'en', targetLanguage: 'de' };
const DE_EN = { sourceLanguage: 'de', targetLanguage: 'en' };

function listed(state, installed, available) {
  return applyListed(state, { installed, available, error: null });
}

describe('models page', () => {
  it('maps lit for the components it imports', () => {
    assert.match(html, /<script type="importmap">[\s\S]*"lit": "peek:\/\/node_modules\/lit\/index\.js"/);
    for (const name of ['peek-card', 'peek-button', 'peek-dialog']) {
      assert.ok(html.includes(`peek://app/components/${name}.js`), `${name} not imported`);
      assert.ok(html.includes(`<${name}`) || script.includes(`'${name}'`), `${name} not used`);
    }
  });

  it('allows every topic the view uses', () => {
    const allowed = manifest.capabilities.pubsub.topics;
    for (const [name, topic] of Object.entries(MODELS_TOPICS)) {
      assert.ok(allowed.includes(topic), `${name} (${topic}) missing from capabilities.pubsub.topics`);
    }
  });

  it('asks for the catalogue once on open', () => {
    assert.match(script, /publish\(MODELS_TOPICS\.list, \{ catalogue: true \}\)/);
  });
});

describe('formatBytes', () => {
  it('uses decimal units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(4600), '5 KB');
    assert.equal(formatBytes(37_012_345), '37.0 MB');
    assert.equal(formatBytes(2_500_000_000), '2.50 GB');
    assert.equal(formatBytes(undefined), '0 B');
  });
});

describe('applyListed', () => {
  it('fills installed and available', () => {
    const s = listed(INITIAL_MODELS_STATE, [{ ...ES_EN, bytes: 37e6 }], [ES_EN, EN_DE]);
    assert.equal(s.loaded, true);
    assert.equal(s.installed.length, 1);
    assert.equal(s.available.length, 2);
  });

  it('keeps the catalogue when an answer carries none', () => {
    const s1 = listed(INITIAL_MODELS_STATE, [], [ES_EN, EN_DE]);
    const s2 = listed(s1, [{ ...ES_EN, bytes: 1 }], null);
    assert.equal(s2.available.length, 2);
    assert.equal(s2.installed.length, 1);
  });

  it('settles deletes but not downloads', () => {
    let s = listed(INITIAL_MODELS_STATE, [{ ...ES_EN, bytes: 1 }], [ES_EN, EN_DE]);
    s = requestDelete(s, 'es', 'en').state;
    s = requestDownload(s, 'en', 'de').state;
    s = listed(s, [], null);
    assert.deepEqual(s.busy, { [directionKey('en', 'de')]: 'estimating' });
  });

  it('records the error', () => {
    const s = applyListed(INITIAL_MODELS_STATE, { installed: [], available: null, error: 'offline' });
    assert.equal(s.error, 'offline');
    assert.match(modelsView(s).status, /offline/);
  });
});

describe('download flow', () => {
  const base = listed(INITIAL_MODELS_STATE, [], [ES_EN, EN_DE]);

  it('estimates before anything is fetched', () => {
    const r = requestDownload(base, 'es', 'en');
    assert.deepEqual(r.publish, { topic: MODELS_TOPICS.estimate, message: { from: 'es', to: 'en' } });
    assert.equal(r.state.busy[directionKey('es', 'en')], 'estimating');
  });

  it('a second click while busy publishes nothing', () => {
    const s = requestDownload(base, 'es', 'en').state;
    assert.equal(requestDownload(s, 'es', 'en').publish, null);
  });

  it('names the engine and its bytes when the first download brings it', () => {
    const s = requestDownload(base, 'es', 'en').state;
    const r = applyEstimated(s, { from: 'es', to: 'en', ok: true, downloadBytes: 30_000_000, engineBytes: 5_000_000, diskBytes: 42_000_000, steps: [] });
    assert.equal(r.state.prompt.engineBytes, 5_000_000);
    const text = promptText(r.state.prompt);
    assert.match(text, /model and the translation engine/);
    assert.match(text, /30\.0 MB \(5\.0 MB of it is the engine/);
  });

  it('asks before downloading, naming the bytes, and downloads only on yes', () => {
    let s = requestDownload(base, 'es', 'en').state;
    const r = applyEstimated(s, { from: 'es', to: 'en', ok: true, downloadBytes: 25_000_000, diskBytes: 37_000_000, steps: [] });
    assert.equal(r.publish, null);
    assert.deepEqual(r.state.prompt, { from: 'es', to: 'en', downloadBytes: 25_000_000, diskBytes: 37_000_000, engineBytes: 0 });
    assert.match(promptText(r.state.prompt), /25\.0 MB/);
    assert.match(promptText(r.state.prompt), /37\.0 MB on disk/);
    assert.doesNotMatch(promptText(r.state.prompt), /engine/);
    s = r.state;
    const yes = answerPrompt(s, true);
    assert.deepEqual(yes.publish, { topic: MODELS_TOPICS.download, message: { from: 'es', to: 'en' } });
    assert.equal(yes.state.prompt, null);
    assert.equal(yes.state.busy[directionKey('es', 'en')], 'downloading');
  });

  it('a no publishes nothing and frees the row', () => {
    let s = requestDownload(base, 'es', 'en').state;
    s = applyEstimated(s, { from: 'es', to: 'en', ok: true, downloadBytes: 1000, diskBytes: 1000 }).state;
    const no = answerPrompt(s, false);
    assert.equal(no.publish, null);
    assert.equal(no.state.prompt, null);
    assert.deepEqual(no.state.busy, {});
    assert.equal(answerPrompt(no.state, true).publish, null);
  });

  it('downloads at once when every file is already on disk', () => {
    const s = requestDownload(base, 'es', 'en').state;
    const r = applyEstimated(s, { from: 'es', to: 'en', ok: true, downloadBytes: 0, diskBytes: 37e6 });
    assert.equal(r.state.prompt, null);
    assert.deepEqual(r.publish, { topic: MODELS_TOPICS.download, message: { from: 'es', to: 'en' } });
  });

  it('ignores an estimate it did not ask for', () => {
    const r = applyEstimated(base, { from: 'es', to: 'en', ok: true, downloadBytes: 5 });
    assert.equal(r.state, base);
    assert.equal(r.publish, null);
  });

  it('shows a refused estimate on the row', () => {
    const s = requestDownload(base, 'es', 'en').state;
    const r = applyEstimated(s, { from: 'es', to: 'en', ok: false, reason: 'unsupported', missing: [ES_EN] });
    assert.equal(r.publish, null);
    const row = modelsView(r.state).available.find((x) => x.from === 'es');
    assert.equal(row.busy, null);
    assert.match(row.failure, /No model/);
  });

  it('follows progress to done and to failed', () => {
    let s = applyProgress(base, { from: 'es', to: 'en', phase: 'downloading', error: null });
    assert.equal(modelsView(s).available.find((x) => x.from === 'es').busyText, 'Downloading…');
    assert.deepEqual(applyProgress(s, { from: 'es', to: 'en', phase: 'done', error: null }).busy, {});
    s = applyProgress(s, { from: 'es', to: 'en', phase: 'failed', error: 'hash mismatch' });
    assert.deepEqual(s.busy, {});
    assert.equal(s.failures[directionKey('es', 'en')], 'Download failed: hash mismatch');
  });
});

describe('requestDelete', () => {
  it('publishes the direction', () => {
    const s = listed(INITIAL_MODELS_STATE, [{ ...ES_EN, bytes: 1 }], null);
    const r = requestDelete(s, 'es', 'en');
    assert.deepEqual(r.publish, { topic: MODELS_TOPICS.delete, message: { from: 'es', to: 'en' } });
    assert.equal(modelsView(r.state).installed[0].busyText, 'Deleting…');
  });
});

describe('modelsView', () => {
  it('says it is loading before the first answer', () => {
    assert.equal(modelsView(INITIAL_MODELS_STATE).status, 'Loading…');
  });

  it('leaves installed directions out of available, sorted by name, with sizes and a total', () => {
    const s = listed(
      INITIAL_MODELS_STATE,
      [{ ...ES_EN, bytes: 37_000_000 }, { ...EN_DE, bytes: 36_000_000 }],
      [ES_EN, EN_DE, DE_EN],
    );
    const view = modelsView(s);
    assert.deepEqual(view.installed.map((r) => r.key), ['en>de', 'es>en']);
    assert.equal(view.installed[0].label, 'English → German');
    assert.equal(view.installed[0].size, '36.0 MB');
    assert.deepEqual(view.available.map((r) => r.key), ['de>en']);
    assert.equal(view.total, '73.0 MB');
    assert.equal(view.status, null);
  });

  it('has no available list until the catalogue answers', () => {
    const view = modelsView(listed(INITIAL_MODELS_STATE, [], null));
    assert.equal(view.available, null);
    assert.match(view.status, /Reading the list/);
  });
});
