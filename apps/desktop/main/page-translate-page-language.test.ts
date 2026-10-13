/**
 * The declared-language read and the `page:translatable` decision in
 * `page-translate/page-language.ts`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  DECLARED_LANGUAGE_SCRIPT,
  PAGE_TRANSLATABLE_TOPIC,
  primaryLanguage,
  translatableLanguage,
} from './page-translate/page-language.js';

describe('page-language primaryLanguage', () => {
  it('keeps the primary subtag, lower-cased', () => {
    assert.equal(primaryLanguage('de-AT'), 'de');
    assert.equal(primaryLanguage(' EN_us '), 'en');
    assert.equal(primaryLanguage('zh-Hans-CN'), 'zh');
  });

  it('refuses values that are not language tags or name no language', () => {
    for (const bad of ['', 'german', 'x', 'de AT', 'und', 'zxx', 'mul', null, undefined, 42]) {
      assert.equal(primaryLanguage(bad), null, String(bad));
    }
  });
});

describe('page-language translatableLanguage', () => {
  it('offers the declared language when it differs from the target', () => {
    assert.equal(translatableLanguage('es', 'en-US'), 'es');
    assert.equal(translatableLanguage('de-DE', 'en'), 'de');
  });

  it('offers nothing for a page in the target language, whatever its region', () => {
    assert.equal(translatableLanguage('en-GB', 'en-US'), null);
  });

  it('offers nothing when either language is unknown', () => {
    assert.equal(translatableLanguage('', 'en'), null);
    assert.equal(translatableLanguage('und', 'en'), null);
    assert.equal(translatableLanguage('es', ''), null);
    assert.equal(translatableLanguage(null, 'en'), null);
  });
});

describe('page-language DECLARED_LANGUAGE_SCRIPT', () => {
  function run(lang: string | null, metaContent?: string): unknown {
    const document = {
      documentElement: { getAttribute: (name: string) => (name === 'lang' ? lang : null) },
      querySelector: () => (metaContent === undefined ? null : { content: metaContent }),
    };
    return vm.runInNewContext(DECLARED_LANGUAGE_SCRIPT, { document });
  }

  it('reads <html lang> first, then the Content-Language meta', () => {
    assert.equal(run(' de-DE '), 'de-DE');
    assert.equal(run('', 'fr, en'), 'fr');
    assert.equal(run(null), '');
  });

  it('names the wake topic the translate tile declares', () => {
    assert.equal(PAGE_TRANSLATABLE_TOPIC, 'page:translatable');
  });
});
