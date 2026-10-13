/**
 * The translate feature tile: its manifest (lazy, both commands, every topic it subscribes to
 * allowed) and the pure request and widget helpers in `features/translate/translate-logic.js`.
 *
 * Run via: node --test tests/unit/translate-tile.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  DECLARED_LANGUAGE_SCRIPT,
  buildTranslateRequest,
  escapeHtml,
  primaryLanguage,
  refusalText,
  statusHtml,
  statusView,
} from '../../features/translate/translate-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '..', 'features', 'translate');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
const background = readFileSync(join(dir, 'background.js'), 'utf-8');

describe('translate manifest', () => {
  it('declares the translate page and show original commands', () => {
    assert.equal(manifest.id, 'translate');
    assert.deepEqual(manifest.commands.map((c) => c.name), ['translate page', 'show original']);
  });

  it('has one lazy background tile, not resident, whose url exists', () => {
    assert.equal(manifest.tiles.length, 1);
    const tile = manifest.tiles[0];
    assert.equal(tile.lazy, true);
    assert.equal(tile.resident, undefined);
    readFileSync(join(dir, tile.url));
  });

  it('allows every topic background.js subscribes to or publishes', () => {
    const allowed = manifest.capabilities.pubsub.topics;
    const subscribed = [...background.matchAll(/subscribe\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(subscribed.sort(), [
      'cmd:execute:show original',
      'cmd:execute:translate page',
      'page:script-result',
      'translate:state',
    ]);
    const published = [...background.matchAll(/publish\(\s*'([^']+)'/g)].map((m) => m[1]);
    for (const topic of [...subscribed, ...published]) {
      assert.ok(allowed.includes(topic), `${topic} missing from capabilities.pubsub.topics`);
    }
  });

  it('asks for no network access', () => {
    assert.equal(manifest.capabilities.network, undefined);
  });

  it('subscribes before its first await', () => {
    const initBody = background.slice(background.indexOf('const init = '));
    const firstAwait = initBody.indexOf('await');
    const lastSubscribe = initBody.lastIndexOf("subscribe('translate:state'");
    assert.ok(lastSubscribe > 0);
    assert.ok(firstAwait === -1 || firstAwait > lastSubscribe);
  });
});

describe('primaryLanguage', () => {
  it('keeps the primary subtag, lower-cased', () => {
    assert.equal(primaryLanguage('de-AT'), 'de');
    assert.equal(primaryLanguage(' EN_us '), 'en');
    assert.equal(primaryLanguage('zh-Hans-CN'), 'zh');
  });

  it('refuses anything not shaped like a language tag', () => {
    for (const bad of ['', 'german', 'x', 'de AT', null, undefined, 42]) {
      assert.equal(primaryLanguage(bad), null, String(bad));
    }
  });
});

describe('buildTranslateRequest', () => {
  const base = { windowId: 7, declared: 'de', requested: '', fallbackTarget: 'en-US' };

  it('translates from the declared language into the system language by default', () => {
    assert.deepEqual(buildTranslateRequest(base), { ok: true, message: { windowId: 7, from: 'de', to: 'en' } });
  });

  it('uses the language named in the command', () => {
    const r = buildTranslateRequest({ ...base, requested: 'fr' });
    assert.deepEqual(r.message, { windowId: 7, from: 'de', to: 'fr' });
  });

  it('refuses with a reason for each missing piece', () => {
    assert.equal(buildTranslateRequest({ ...base, windowId: null }).reason, 'no-window');
    assert.equal(buildTranslateRequest({ ...base, requested: 'French' }).reason, 'bad-target');
    assert.equal(buildTranslateRequest({ ...base, fallbackTarget: '' }).reason, 'no-target');
    assert.equal(buildTranslateRequest({ ...base, declared: '' }).reason, 'no-language');
    assert.equal(buildTranslateRequest({ ...base, declared: 'en-GB' }).reason, 'same-language');
  });

  it('has a sentence for every refusal', () => {
    for (const reason of ['no-window', 'bad-target', 'no-target', 'no-language', 'same-language']) {
      const text = refusalText({ ok: false, reason, to: 'en' });
      assert.ok(text.length > 10, reason);
    }
    assert.match(refusalText({ ok: false, reason: 'same-language', to: 'en' }), /English/);
  });
});

describe('DECLARED_LANGUAGE_SCRIPT', () => {
  function run(lang, metaContent) {
    const document = {
      documentElement: { getAttribute: (name) => (name === 'lang' ? lang : null) },
      querySelector: () => (metaContent === undefined ? null : { content: metaContent }),
    };
    return vm.runInNewContext(DECLARED_LANGUAGE_SCRIPT, { document });
  }

  it('reads <html lang> first, then the Content-Language meta', () => {
    assert.equal(run(' de-DE '), 'de-DE');
    assert.equal(run('', 'fr, en'), 'fr');
    assert.equal(run(null), '');
  });
});

describe('statusView', () => {
  it('reports progress, the finished translation, restoring and errors', () => {
    assert.match(statusView({ windowId: 1, phase: 'collecting', from: 'de', to: 'en', applied: 0, error: null }).text, /Translating from German to English/);
    assert.match(statusView({ windowId: 1, phase: 'translating', from: 'de', to: 'en', applied: 12, error: null }).text, /12 passages/);
    assert.match(statusView({ windowId: 1, phase: 'translated', from: 'de', to: 'en', applied: 12, error: null }).text, /show original/);
    assert.match(statusView({ windowId: 1, phase: 'restoring', from: 'de', to: 'en', applied: 12, error: null }).text, /original/);
    assert.match(statusView({ windowId: 1, phase: 'idle', from: 'de', to: 'en', applied: 0, error: 'no-page' }).text, /no web page/);
    assert.match(statusView({ windowId: 1, phase: 'idle', from: 'de', to: 'en', applied: 0, error: 'engine-unavailable' }).text, /engine-unavailable/);
  });

  it('closes the widget when the page is back to its original with nothing to report', () => {
    assert.equal(statusView({ windowId: 1, phase: 'idle', from: 'de', to: 'en', applied: 0, error: null }), null);
    assert.equal(statusView({ windowId: 1, phase: 'closed', from: null, to: null, applied: 0, error: null }), null);
    assert.equal(statusView(null), null);
  });

  it('escapes the text it puts in the widget', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.ok(!statusHtml({ title: 't', text: '<script>' }).includes('<script>'));
  });
});
