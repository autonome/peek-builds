/**
 * Page-side translation helpers (page-translate/content-script.ts) on linkedom DOM fixtures,
 * with a stub translator that uppercases text and leaves markup alone. The test sits at the top
 * level of main/ so the shared `dist/main/*.test.js` glob runs it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { parseHTML } from 'linkedom';

import {
  callSource,
  injectionSource,
  pageTranslator,
  PAGE_TRANSLATOR_GLOBAL,
  type WorkItem,
} from './page-translate/content-script.js';

function page(body: string, lang = 'de') {
  const { document, window } = parseHTML(
    `<!doctype html><html lang="${lang}"><head><title>t</title></head><body>${body}</body></html>`,
  );
  // linkedom's DOM typings mark every lookup nullable; the fixtures make them certain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { document: document as any, window };
}

/** Uppercases text outside tags and entities. */
function upper(s: string, isHTML: boolean): string {
  if (!isHTML) return s.toUpperCase();
  return s.replace(/(^|>)([^<]+)/g, (_m, p: string, t: string) =>
    p + t.replace(/&[a-z0-9#]+;|[^&]+/gi, (x) => (x[0] === '&' ? x : x.toUpperCase())),
  );
}

function translateAll(items: WorkItem[]) {
  return items.map((i) => ({ id: i.id, text: upper(i.text, i.isHTML) }));
}

describe('pageTranslator', () => {
  it('collects block units with inline markup reduced to indexed tags', () => {
    const { document } = page('<p>Hallo <a href="/x" class="k">Welt</a>!</p><div>  </div>');
    const t = pageTranslator(document, { pageLang: 'de' });
    const items = t.collect();
    assert.deepStrictEqual(items.map((i) => [i.text, i.isHTML]), [
      ['Hallo <a data-t="0">Welt</a>!', true],
    ]);
  });

  it('translates in place, keeping elements, attributes and listeners', () => {
    const { document } = page('<p>Hallo <a href="/x" class="k">Welt</a> &amp; <b>mehr</b></p>');
    const link = document.querySelector('a');
    let clicks = 0;
    link.addEventListener('click', () => clicks++);
    const t = pageTranslator(document, { pageLang: 'de' });
    const res = t.apply(translateAll(t.collect()));
    assert.deepStrictEqual(res, { applied: 1, requeued: 0 });
    assert.strictEqual(
      document.body.innerHTML,
      '<p>HALLO <a href="/x" class="k">WELT</a> &amp; <b>MEHR</b></p>',
    );
    assert.strictEqual(document.querySelector('a'), link);
    link.dispatchEvent(new document.defaultView.Event('click'));
    assert.strictEqual(clicks, 1);
  });

  it('follows the engine reordering inline elements', () => {
    const { document } = page('<p>Ich habe <b>ihn</b> gesehen</p>');
    const b = document.querySelector('b');
    const t = pageTranslator(document, { pageLang: 'de' });
    const [item] = t.collect();
    t.apply([{ id: item.id, text: 'I saw <b data-t="0">him</b>' }]);
    assert.strictEqual(document.body.innerHTML, '<p>I saw <b>him</b></p>');
    assert.strictEqual(document.querySelector('b'), b);
  });

  it('restore returns identical HTML and the original nodes', () => {
    const html =
      '<h1 title="Titel">Überschrift</h1><!-- c --><ul><li>Eins <i>zwei</i><ul><li>drei</li></ul></li></ul>' +
      '<p>Text <img src="a.png" alt="Bild"> <code>x()</code> ende</p>' +
      '<input type="submit" value="Senden"><input type="text" placeholder="Suche" value="mein">';
    const { document } = page(html);
    const before = document.body.innerHTML;
    const textNode = document.querySelector('h1').firstChild;
    const t = pageTranslator(document, { pageLang: 'de' });
    t.apply(translateAll(t.collect()));
    const after = document.body.innerHTML;
    assert.notStrictEqual(after, before);
    assert.match(after, /<h1 title="TITEL">ÜBERSCHRIFT<\/h1>/);
    assert.match(after, /alt="BILD"/);
    assert.match(after, /value="SENDEN"/);
    assert.match(after, /placeholder="SUCHE" value="mein"/);
    assert.match(after, /<code>x\(\)<\/code>/);
    assert.match(after, /<li>EINS <i>ZWEI<\/i><ul><li>DREI<\/li><\/ul><\/li>/);
    t.restore();
    assert.strictEqual(document.body.innerHTML, before);
    assert.strictEqual(document.querySelector('h1').firstChild, textNode);
  });

  it('skips excluded content', () => {
    const { document } = page(
      '<p class="notranslate">a</p><p translate="no">b</p><div contenteditable="true"><p>c</p></div>' +
        '<p lang="en">d</p><pre>e</pre><script>f</script><style>g</style><textarea>h</textarea>' +
        '<p lang="de-AT">ok</p>',
    );
    const t = pageTranslator(document, { pageLang: 'de' });
    assert.deepStrictEqual(t.collect().map((i) => i.text), ['ok']);
  });

  it('sends excluded inline content as an empty placeholder and keeps it', () => {
    const { document } = page('<p>Rufe <code>run()</code> auf <span class="notranslate">Peek</span></p>');
    const t = pageTranslator(document, { pageLang: 'de' });
    const items = t.collect();
    assert.strictEqual(items[0].text, 'Rufe <code data-t="0"></code> auf <span data-t="1"></span>');
    t.apply(translateAll(items));
    assert.strictEqual(
      document.body.innerHTML,
      '<p>RUFE <code>run()</code> AUF <span class="notranslate">Peek</span></p>',
    );
  });

  it('appends placeholders the engine dropped', () => {
    const { document } = page('<p>Bild <img src="a.png"> hier</p>');
    const t = pageTranslator(document, { pageLang: 'de' });
    const [item] = t.collect();
    t.apply([{ id: item.id, text: 'Picture here' }]);
    assert.strictEqual(document.body.innerHTML, '<p>Picture here<img src="a.png"></p>');
  });

  it('walks open shadow roots', () => {
    const { document } = page('<div id="host"></div>');
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Schatten</p>';
    const t = pageTranslator(document, { pageLang: 'de' });
    const items = t.collect();
    assert.deepStrictEqual(items.map((i) => i.text), ['Schatten']);
    t.apply(translateAll(items));
    assert.strictEqual(root.innerHTML, '<p>SCHATTEN</p>');
  });

  it('batches, visible units first, and drains the rest', () => {
    const { document } = page('<p id="a">a</p><p id="b">b</p><p id="c">c</p>');
    const visible = new Set(['c']);
    for (const p of Array.from(document.querySelectorAll('p')) as any[]) {
      p.getBoundingClientRect = () =>
        visible.has(p.id) ? { top: 0, bottom: 10, width: 10, height: 10 } : { top: 0, bottom: 0, width: 0, height: 0 };
    }
    const t = pageTranslator(document, { pageLang: 'de', batchSize: 2 });
    assert.deepStrictEqual(t.collect().map((i) => i.text), ['c', 'a']);
    assert.strictEqual(t.pendingCount(), 1);
    assert.deepStrictEqual(t.drain().map((i) => i.text), ['b']);
    assert.deepStrictEqual(t.drain(), []);
  });

  it('reuses cached translations without handing them out again', () => {
    const { document } = page('<p>gleich</p>');
    const t = pageTranslator(document, { pageLang: 'de' });
    t.apply(translateAll(t.collect()));
    const p = document.createElement('p');
    p.textContent = 'gleich';
    document.body.appendChild(p);
    // A fresh scan via drain only sees what the observer queued; simulate it with a re-collect.
    assert.deepStrictEqual(t.collect(), []);
    assert.strictEqual(p.textContent, 'GLEICH');
  });

  it('re-queues a unit whose content changed after it was handed out', () => {
    const { document } = page('<p>alt</p>');
    const t = pageTranslator(document, { pageLang: 'de' });
    const [item] = t.collect();
    document.querySelector('p').textContent = 'neu';
    assert.deepStrictEqual(t.apply(translateAll([item])), { applied: 0, requeued: 1 });
    assert.strictEqual(document.body.innerHTML, '<p>neu</p>');
    const again = t.drain();
    assert.deepStrictEqual(again.map((i) => i.text), ['neu']);
    t.apply(translateAll(again));
    assert.strictEqual(document.body.innerHTML, '<p>NEU</p>');
  });

  it('queues content added after translation and ignores its own writes', async () => {
    const { document } = page('<p>eins</p><div id="feed"></div>');
    const t = pageTranslator(document, { pageLang: 'de' });
    t.apply(translateAll(t.collect()));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(t.drain(), []);
    const p = document.createElement('p');
    p.textContent = 'zwei';
    document.getElementById('feed').appendChild(p);
    await new Promise((r) => setTimeout(r, 10));
    const items = t.drain();
    assert.deepStrictEqual(items.map((i) => i.text), ['zwei']);
    t.apply(translateAll(items));
    assert.strictEqual(document.body.innerHTML, '<p>EINS</p><div id="feed"><p>ZWEI</p></div>');
    t.restore();
    assert.strictEqual(document.body.innerHTML, '<p>eins</p><div id="feed"><p>zwei</p></div>');
  });

  it('translates again after a restore, from the cache', () => {
    const { document } = page('<p>wieder</p><p>anders</p>');
    const t = pageTranslator(document, { pageLang: 'de' });
    t.apply(translateAll(t.collect().filter((i) => i.text === 'wieder')));
    t.restore();
    assert.strictEqual(document.body.innerHTML, '<p>wieder</p><p>anders</p>');
    const items = t.collect();
    assert.deepStrictEqual(items.map((i) => i.text), ['anders']);
    assert.strictEqual(document.body.innerHTML, '<p>WIEDER</p><p>anders</p>');
  });
});

describe('injectionSource and callSource', () => {
  it('evaluate as standalone scripts against a page document', () => {
    const { document } = page('<p>Hallo <b>Welt</b></p>');
    const ctx = vm.createContext({ document });
    assert.strictEqual(vm.runInContext(injectionSource({ pageLang: 'de' }), ctx), true);
    const first = vm.runInContext(`globalThis.${PAGE_TRANSLATOR_GLOBAL}`, ctx);
    assert.strictEqual(vm.runInContext(injectionSource({ pageLang: 'de' }), ctx), true);
    assert.strictEqual(vm.runInContext(`globalThis.${PAGE_TRANSLATOR_GLOBAL}`, ctx), first);
    const items = vm.runInContext(callSource('collect'), ctx) as WorkItem[];
    assert.strictEqual(items.length, 1);
    vm.runInContext(callSource('apply', translateAll(items)), ctx);
    assert.strictEqual(document.body.innerHTML, '<p>HALLO <b>WELT</b></p>');
    assert.strictEqual(vm.runInContext(callSource('restore'), ctx), null);
    assert.strictEqual(document.body.innerHTML, '<p>Hallo <b>Welt</b></p>');
  });

  it('callSource returns null before injection', () => {
    const ctx = vm.createContext({ document: page('<p>x</p>').document });
    assert.strictEqual(vm.runInContext(callSource('drain'), ctx), null);
  });
});
