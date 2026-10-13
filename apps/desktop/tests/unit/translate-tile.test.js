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
  offerView,
  primaryLanguage,
  refusalText,
  SHOW_ORIGINAL_ACTION,
  statusHtml,
  statusView,
  TRANSLATE_ACTION,
  widgetActionRequest,
} from '../../features/translate/translate-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '..', 'features', 'translate');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
const background = readFileSync(join(dir, 'background.js'), 'utf-8');

describe('translate manifest', () => {
  it('declares the translate page, show original and manage translation models commands', () => {
    assert.equal(manifest.id, 'translate');
    assert.deepEqual(manifest.commands.map((c) => c.name), ['translate page', 'show original', 'manage translation models']);
  });

  it('has one lazy background tile, not resident, whose url exists', () => {
    const tile = manifest.tiles.find((t) => t.id === 'background');
    assert.equal(tile.lazy, true);
    assert.equal(tile.resident, undefined);
    readFileSync(join(dir, tile.url));
  });

  it('opens the models view as a window with no background tile in between', () => {
    const tile = manifest.tiles.find((t) => t.id === 'models');
    readFileSync(join(dir, tile.url));
    const command = manifest.commands.find((c) => c.name === 'manage translation models');
    assert.equal(command.action.type, 'window');
    assert.equal(command.action.url, `peek://translate/${tile.url}`);
    assert.equal(command.action.options.key, tile.key);
  });

  it('allows every topic background.js subscribes to or publishes', () => {
    const allowed = manifest.capabilities.pubsub.topics;
    const subscribed = [...background.matchAll(/subscribe\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(subscribed.sort(), [
      'cmd:execute:show original',
      'cmd:execute:translate page',
      'page:loaded',
      'page:script-result',
      'page:translatable',
      'translate:state',
      'widget:action',
    ]);
    const published = [...background.matchAll(/publish\(\s*'([^']+)'/g)].map((m) => m[1]);
    for (const topic of [...subscribed, ...published]) {
      assert.ok(allowed.includes(topic), `${topic} missing from capabilities.pubsub.topics`);
    }
  });

  it('wakes on page:translatable', () => {
    const tile = manifest.tiles.find((t) => t.id === 'background');
    assert.deepEqual(tile.lazyEvents, ['page:translatable']);
  });

  it('asks for no network access', () => {
    assert.equal(manifest.capabilities.network, undefined);
  });

  it('subscribes before its first await', () => {
    const initBody = background.slice(background.indexOf('const init = '));
    const firstAwait = initBody.indexOf('await');
    const lastSubscribe = initBody.lastIndexOf("subscribe('widget:action'");
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
    for (const bad of ['', 'german', 'x', 'de AT', 'und', 'zxx', null, undefined, 42]) {
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
    assert.match(statusView({ windowId: 1, phase: 'translated', from: 'de', to: 'en', applied: 12, error: null }).text, /Translated from German to English/);
    assert.match(statusView({ windowId: 1, phase: 'restoring', from: 'de', to: 'en', applied: 12, error: null }).text, /original/);
    assert.match(statusView({ windowId: 1, phase: 'idle', from: 'de', to: 'en', applied: 0, error: 'no-page' }).text, /no web page/);
    assert.match(statusView({ windowId: 1, phase: 'idle', from: 'de', to: 'en', applied: 0, error: 'models-needed' }).text, /manage translation models/);
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

  it('offers Show original while translating or translated, and no button otherwise', () => {
    const at = (phase, error = null) => statusView({ windowId: 1, phase, from: 'de', to: 'en', applied: 0, error });
    for (const phase of ['collecting', 'translating', 'translated']) {
      assert.deepEqual(at(phase).actions.map((a) => a.action), [SHOW_ORIGINAL_ACTION], phase);
    }
    assert.deepEqual(at('restoring').actions, []);
    assert.deepEqual(at('idle', 'no-page').actions, []);
  });

  it('draws each action as a peek-button carrying data-widget-action', () => {
    const html = statusHtml(statusView({ windowId: 1, phase: 'translated', from: 'de', to: 'en', applied: 3, error: null }));
    assert.match(html, /<peek-button[^>]*data-widget-action="show-original"[^>]*>Show original<\/peek-button>/);
    assert.ok(!statusHtml({ title: 't', text: 'x', actions: [] }).includes('peek-button'));
  });
});

describe('offerView', () => {
  it('offers to translate from the page language into the target', () => {
    const view = offerView({ lang: 'es', target: 'en-US' });
    assert.match(view.text, /Spanish/);
    assert.deepEqual(view.actions, [{ action: TRANSLATE_ACTION, label: 'Translate from Spanish', value: 'es en' }]);
  });

  it('offers nothing for a page in the target language or with no usable language', () => {
    assert.equal(offerView({ lang: 'en-GB', target: 'en-US' }), null);
    assert.equal(offerView({ lang: 'und', target: 'en' }), null);
    assert.equal(offerView({ lang: 'es', target: '' }), null);
  });

  it('draws the button with both languages in data-widget-value', () => {
    const html = statusHtml(offerView({ lang: 'de', target: 'en' }));
    assert.match(html, /<peek-button[^>]*data-widget-action="translate" data-widget-value="de en"[^>]*>Translate from German<\/peek-button>/);
  });
});

describe('widgetActionRequest', () => {
  const own = { extensionId: 'translate', widgetId: 'status' };
  const click = { extensionId: 'translate', widgetId: 'status', action: SHOW_ORIGINAL_ACTION, value: null, windowId: 9 };

  it('turns Show original into translate:show-original for the clicked window', () => {
    assert.deepEqual(widgetActionRequest(click, own), { topic: 'translate:show-original', message: { windowId: 9 } });
  });

  it('turns Translate from X into translate:page for the clicked window', () => {
    const translate = { ...click, action: TRANSLATE_ACTION, value: 'es en' };
    assert.deepEqual(widgetActionRequest(translate, own), {
      topic: 'translate:page',
      message: { windowId: 9, from: 'es', to: 'en' },
    });
  });

  it('ignores a Translate click whose value does not name two different languages', () => {
    for (const value of [null, '', 'es', 'es es', 'es en fr', 'Spanish English']) {
      assert.equal(widgetActionRequest({ ...click, action: TRANSLATE_ACTION, value }, own), null, String(value));
    }
  });

  it('ignores other widgets, unknown actions and clicks with no window', () => {
    assert.equal(widgetActionRequest({ ...click, extensionId: 'other' }, own), null);
    assert.equal(widgetActionRequest({ ...click, widgetId: 'other' }, own), null);
    assert.equal(widgetActionRequest({ ...click, action: 'launch' }, own), null);
    assert.equal(widgetActionRequest({ ...click, windowId: null }, own), null);
    assert.equal(widgetActionRequest(null, own), null);
  });
});
