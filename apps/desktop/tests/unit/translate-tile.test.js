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
import {
  DECLINE_ACTION,
  DOWNLOAD_ACTION,
  offerOnAction,
  offerOnEstimated,
  offerOnLoaded,
  offerOnProgress,
  offerOnState,
} from '../../features/translate/download-offer.js';
import { createWindowViews } from '../../features/translate/window-views.js';

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
      'page-overlay:active',
      'page:loaded',
      'page:script-result',
      'page:translatable',
      'translate:models:estimated',
      'translate:models:progress',
      'translate:state',
      'widget:action',
    ]);
    // Published through a variable by the download offer.
    for (const topic of ['translate:models:estimate', 'translate:models:download', 'translate:page']) {
      assert.ok(allowed.includes(topic), `${topic} missing from capabilities.pubsub.topics`);
    }
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

describe('download offer', () => {
  const needed = { windowId: 7, phase: 'idle', from: 'es', to: 'en', applied: 0, error: 'models-needed' };
  const estimated = { from: 'es', to: 'en', ok: true, downloadBytes: 42_000_000, diskBytes: 42_000_000, engineBytes: 5_000_000 };

  function asking() {
    const start = offerOnState(null, needed);
    return offerOnEstimated(start.offer, estimated, new Set()).offer;
  }

  it('asks main for the size when a translation lacks its models', () => {
    const step = offerOnState(null, needed);
    assert.deepEqual(step.publish, [{ topic: 'translate:models:estimate', message: { from: 'es', to: 'en' } }]);
    assert.equal(step.offer.phase, 'estimating');
    assert.match(step.view.text, /Checking the download for Spanish → English/);
    // The second report of the same failure keeps the one offer and asks nothing more.
    const again = offerOnState(step.offer, { ...needed, phase: 'restoring' });
    assert.equal(again.offer, step.offer);
    assert.deepEqual(again.publish, []);
  });

  it('leaves other states to the status widget', () => {
    assert.equal(offerOnState(null, { ...needed, error: 'no-engine' }), null);
    assert.equal(offerOnState(null, { ...needed, error: null, phase: 'translated' }), null);
  });

  it('prompts with the size, the engine named, and Download / Not now buttons', () => {
    const start = offerOnState(null, needed);
    const step = offerOnEstimated(start.offer, estimated, new Set());
    assert.equal(step.offer.phase, 'asking');
    assert.deepEqual(step.publish, []);
    assert.match(step.view.text, /fetches 42\.0 MB \(5\.0 MB of it is the engine/);
    assert.deepEqual(step.view.actions.map((a) => a.action), [DOWNLOAD_ACTION, DECLINE_ACTION]);
    const html = statusHtml(step.view);
    assert.match(html, /data-widget-action="download-models"/);
  });

  it('ignores estimates for another pair or when not estimating', () => {
    const start = offerOnState(null, needed);
    assert.equal(offerOnEstimated(start.offer, { ...estimated, to: 'de' }, new Set()).offer, start.offer);
    assert.equal(offerOnEstimated(null, estimated, new Set()).offer, null);
  });

  it('downloads without asking when nothing is fetched or the direction was accepted before', () => {
    const start = offerOnState(null, needed);
    const free = offerOnEstimated(start.offer, { ...estimated, downloadBytes: 0 }, new Set());
    assert.equal(free.offer.phase, 'downloading');
    assert.deepEqual(free.publish, [{ topic: 'translate:models:download', message: { from: 'es', to: 'en' } }]);
    const known = offerOnEstimated(start.offer, estimated, new Set(['es>en']));
    assert.equal(known.offer.phase, 'downloading');
  });

  it('names the reason when the size cannot be had', () => {
    const start = offerOnState(null, needed);
    const step = offerOnEstimated(start.offer, { from: 'es', to: 'en', ok: false, reason: 'unsupported' }, new Set());
    assert.equal(step.offer, null);
    assert.equal(step.view.text, 'No translation model covers these languages.');
  });

  it('Download publishes the download and reports the consent; Not now closes', () => {
    const offer = asking();
    const yes = offerOnAction(offer, { windowId: 7, action: DOWNLOAD_ACTION });
    assert.equal(yes.accepted, true);
    assert.equal(yes.offer.phase, 'downloading');
    assert.deepEqual(yes.publish, [{ topic: 'translate:models:download', message: { from: 'es', to: 'en' } }]);
    assert.match(yes.view.text, /Downloading the Spanish → English translation model/);
    const no = offerOnAction(offer, { windowId: 7, action: DECLINE_ACTION });
    assert.equal(no.accepted, false);
    assert.equal(no.offer, null);
    assert.deepEqual(no.publish, []);
    assert.equal(no.view, null);
    // A click from another window's chrome or another button changes nothing.
    assert.equal(offerOnAction(offer, { windowId: 8, action: DOWNLOAD_ACTION }).offer, offer);
    assert.equal(offerOnAction(offer, { windowId: 7, action: 'show-original' }).view, undefined);
  });

  it('translates again once the download is done, and reports a failure', () => {
    const downloading = offerOnAction(asking(), { windowId: 7, action: DOWNLOAD_ACTION }).offer;
    assert.equal(offerOnProgress(downloading, { from: 'es', to: 'en', phase: 'downloading' }).offer, downloading);
    const done = offerOnProgress(downloading, { from: 'es', to: 'en', phase: 'done' });
    assert.equal(done.offer, null);
    assert.deepEqual(done.publish, [{ topic: 'translate:page', message: { windowId: 7, from: 'es', to: 'en' } }]);
    const failed = offerOnProgress(downloading, { from: 'es', to: 'en', phase: 'failed', error: 'HTTP 500' });
    assert.equal(failed.offer, null);
    assert.equal(failed.view.text, 'The download failed: HTTP 500');
    assert.equal(offerOnProgress(downloading, { from: 'es', to: 'de', phase: 'done' }).offer, downloading);
  });

  it('a new page closes an unanswered prompt; a download under way finishes without translating it', () => {
    const closed = offerOnLoaded(asking(), { windowId: 7 });
    assert.equal(closed.offer, null);
    assert.equal(closed.view, null);
    const downloading = offerOnAction(asking(), { windowId: 7, action: DOWNLOAD_ACTION }).offer;
    const stale = offerOnLoaded(downloading, { windowId: 7 }).offer;
    assert.equal(stale.stale, true);
    const done = offerOnProgress(stale, { from: 'es', to: 'en', phase: 'done' });
    assert.deepEqual(done.publish, []);
    assert.equal(done.view, null);
    assert.equal(offerOnLoaded(downloading, { windowId: 8 }).offer, downloading);
  });
});

describe('window views', () => {
  const offerA = { title: 'Translation', text: 'This page is in Spanish.', actions: [] };
  const statusB = { title: 'Translation', text: 'Translated from German to English.', actions: [] };

  it('draws a view only while its window is in front', () => {
    const views = createWindowViews();
    assert.deepEqual(views.setFront(1), { close: true });
    assert.deepEqual(views.setView(1, offerA), { draw: offerA });
    assert.equal(views.setView(2, statusB), null);
    assert.equal(views.viewOf(2), statusB);
  });

  it('hides the widget when a window without a view comes forward, and brings it back with its window', () => {
    const views = createWindowViews();
    views.setFront(1);
    views.setView(1, offerA);
    assert.deepEqual(views.setFront(3), { close: true });
    assert.deepEqual(views.setFront(1), { draw: offerA });
  });

  it('shows the view of the window that comes forward', () => {
    const views = createWindowViews();
    views.setFront(1);
    views.setView(1, offerA);
    views.setView(2, statusB);
    assert.deepEqual(views.setFront(2), { draw: statusB });
    assert.deepEqual(views.setFront(1), { draw: offerA });
  });

  it('does not redraw when the same window is reported in front again', () => {
    const views = createWindowViews();
    views.setFront(1);
    views.setView(1, offerA);
    assert.equal(views.setFront(1), null);
    assert.equal(views.front(), 1);
  });

  it('closes the widget when no page window is in front', () => {
    const views = createWindowViews();
    views.setFront(1);
    views.setView(1, offerA);
    assert.deepEqual(views.setFront(null), { close: true });
    assert.equal(views.front(), null);
    assert.equal(views.setView(1, statusB), null);
    assert.deepEqual(views.setFront(1), { draw: statusB });
  });

  it('clearing a view closes the widget only for the window in front', () => {
    const views = createWindowViews();
    views.setFront(1);
    views.setView(1, offerA);
    views.setView(2, statusB);
    assert.equal(views.setView(2, null), null);
    assert.equal(views.viewOf(2), null);
    assert.deepEqual(views.setView(1, null), { close: true });
    assert.deepEqual(views.setFront(2), { close: true });
  });

  it('ignores a view for no window', () => {
    const views = createWindowViews();
    assert.equal(views.setView(null, offerA), null);
    assert.equal(views.setView(undefined, offerA), null);
  });
});
