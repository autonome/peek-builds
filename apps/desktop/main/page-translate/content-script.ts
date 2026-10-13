/**
 * Page-side half of page translation: finds translatable text in a page, hands it to main as
 * work items, merges translations back onto the original nodes, and restores the original
 * content without a reload.
 *
 * `pageTranslator` is written to be serialised with `Function.prototype.toString` and evaluated
 * in the page's isolated world (`injectionSource`), so it must stay self-contained: no imports,
 * no references to anything outside its own body. Tests call it directly on a DOM fixture.
 *
 * Protocol (main pulls, the page never pushes):
 * - `collect()` scans the document, queues every unit, and returns the first batch.
 * - `drain()` returns the next batch: what is left of the scan, plus content added by mutations.
 *   Units near the viewport come first in every batch.
 * - `apply(results)` merges `[{id, text}]` back. A unit whose source changed since it was handed
 *   out is re-queued instead of overwritten.
 * - `restore()` puts every original node and attribute value back and stops observing.
 *
 * Work items are `{id, text, isHTML}`. Block units carry HTML in which each inline element is
 * reduced to its tag and a `data-t` index; the engine keeps that markup in place, and the merge
 * moves the original elements (with their listeners and attributes) into the translated order.
 * Non-translatable inline content (code, images, nested blocks, `translate="no"`) is sent as an
 * empty placeholder and put back untouched. Attribute units (`title`, `alt`, `placeholder`,
 * `aria-label`, `aria-description`, button `value`) carry plain text.
 */

export interface TranslatorOptions {
  /** The page's language (primary subtag is enough); elements declaring another language are skipped. */
  pageLang?: string;
  /**
   * The language being translated into. The translator does not read it; it is part of the
   * options so `injectionSource` installs a fresh translator, with an empty translation cache,
   * when the target changes.
   */
  targetLang?: string;
  /** Maximum units per `collect`/`drain` batch. */
  batchSize?: number;
  /** Pixels beyond the viewport that still count as near it. */
  viewportMargin?: number;
}

export interface WorkItem {
  id: string;
  text: string;
  isHTML: boolean;
}

export interface TranslationResult {
  id: string;
  text: string;
}

export interface PageTranslator {
  collect(): WorkItem[];
  drain(): WorkItem[];
  apply(results: TranslationResult[]): { applied: number; requeued: number };
  restore(): void;
  pendingCount(): number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pageTranslator(doc: any, opts: TranslatorOptions = {}): PageTranslator {
  const win = doc.defaultView || null;
  const batchSize = opts.batchSize || 50;
  const margin = opts.viewportMargin == null ? 600 : opts.viewportMargin;
  const pageLang = String(opts.pageLang || '').toLowerCase().split('-')[0];

  const ELEMENT = 1;
  const TEXT = 3;
  const SKIP = new Set([
    'code', 'kbd', 'samp', 'var', 'pre', 'script', 'style', 'noscript', 'template', 'textarea',
    'iframe', 'svg', 'math', 'canvas', 'video', 'audio', 'object', 'embed', 'select', 'head',
  ]);
  const INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'mark',
    'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'label',
  ]);
  const ATTRS = ['title', 'alt', 'placeholder', 'aria-label', 'aria-description'];
  const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);

  // Per-session state.
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Unit = { id: string; isHTML: boolean; el: any; attr?: string; source: string; slots?: any[] };
  const units = new Map<string, Unit>();
  const queued: string[] = [];
  const handedOut = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unitOf = new WeakMap<any, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const savedChildren = new Map<any, any[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const savedAttrs: Array<{ el: any; attr: string; value: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ours = new WeakSet<any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let attrSeen = new WeakMap<any, Set<string>>();
  const cache = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let observer: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tag(el: any): string {
    return String(el.localName || el.tagName || '').toLowerCase();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function excluded(el: any): boolean {
    if (SKIP.has(tag(el))) return true;
    const ga = (n: string) => (el.getAttribute ? el.getAttribute(n) : null);
    if (ga('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    const ce = ga('contenteditable');
    if (ce !== null && ce !== 'false') return true;
    const lang = ga('lang');
    if (pageLang && lang && lang.toLowerCase().split('-')[0] !== pageLang) return true;
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function isInline(el: any): boolean {
    return INLINE.has(tag(el)) && !el.shadowRoot;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function hasOwnText(el: any): boolean {
    for (const child of Array.from(el.childNodes) as any[]) {
      if (child.nodeType === TEXT && /\S/.test(child.data)) return true;
      if (child.nodeType === ELEMENT && isInline(child) && !excluded(child) && hasOwnText(child)) return true;
    }
    return false;
  }

  function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Serialises a unit's content. Inline elements become `<tag data-t="n">…</tag>`; anything
  // else becomes an empty placeholder. `slots[n]` is the original element for index n.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function serialize(el: any, slots: any[]): string {
    let out = '';
    for (const child of Array.from(el.childNodes) as any[]) {
      if (child.nodeType === TEXT) {
        out += escapeText(child.data);
      } else if (child.nodeType === ELEMENT) {
        const n = slots.length;
        slots.push(child);
        const t = tag(child);
        const inner = isInline(child) && !excluded(child) ? serialize(child, slots) : '';
        out += `<${t} data-t="${n}">${inner}</${t}>`;
      }
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addAttrUnits(el: any, out: Unit[]): void {
    let seen = attrSeen.get(el);
    const names = ATTRS.slice();
    if (tag(el) === 'input' && BUTTON_TYPES.has(String(el.getAttribute('type') || '').toLowerCase())) {
      names.push('value');
    }
    for (const name of names) {
      const value = el.getAttribute(name);
      if (!value || !/\S/.test(value)) continue;
      if (seen && seen.has(name)) continue;
      if (!seen) attrSeen.set(el, (seen = new Set()));
      seen.add(name);
      const id = `a${++seq}`;
      out.push({ id, isHTML: false, el, attr: name, source: value });
    }
  }

  // Walks a subtree (and open shadow roots) collecting units in document order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function scan(root: any, out: Unit[], insideUnit: boolean): void {
    for (const child of Array.from(root.childNodes) as any[]) {
      if (child.nodeType !== ELEMENT) continue;
      if (excluded(child)) continue;
      addAttrUnits(child, out);
      let here = insideUnit;
      if (!isInline(child) || !insideUnit) {
        if (!unitOf.has(child) && hasOwnText(child)) {
          const slots: unknown[] = [];
          const source = serialize(child, slots);
          const id = `b${++seq}`;
          unitOf.set(child, id);
          out.push({ id, isHTML: true, el: child, source, slots });
          here = true;
        } else if (unitOf.has(child)) {
          here = true;
        } else {
          here = false;
        }
      }
      if (child.shadowRoot) scan(child.shadowRoot, out, false);
      scan(child, out, here);
    }
  }

  function enqueue(found: Unit[]): void {
    for (const u of found) {
      units.set(u.id, u);
      queued.push(u.id);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function nearViewport(el: any): boolean {
    if (!win || typeof el.getBoundingClientRect !== 'function') return true;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return false;
    const h = win.innerHeight || 0;
    return r.bottom >= -margin && r.top <= h + margin;
  }

  // Applies cached translations straight away; returns the rest as work items.
  function nextBatch(): WorkItem[] {
    const live = queued.splice(0).filter((id) => units.has(id));
    const near: Unit[] = [];
    const far: Unit[] = [];
    for (const id of live) {
      const u = units.get(id)!;
      (nearViewport(u.el) ? near : far).push(u);
    }
    const ordered = near.concat(far);
    const batch: WorkItem[] = [];
    const rest: string[] = [];
    for (const u of ordered) {
      const key = (u.isHTML ? 'h:' : 't:') + u.source;
      if (cache.has(key)) {
        handedOut.add(u.id);
        applyOne(u, cache.get(key)!);
        continue;
      }
      if (batch.length < batchSize) {
        handedOut.add(u.id);
        batch.push({ id: u.id, text: u.source, isHTML: u.isHTML });
      } else {
        rest.push(u.id);
      }
    }
    queued.push(...rest);
    return batch;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function detach(el: any): any[] {
    const kids = Array.from(el.childNodes);
    for (const k of kids) el.removeChild(k);
    return kids;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function saveChildren(el: any): void {
    if (!savedChildren.has(el)) savedChildren.set(el, Array.from(el.childNodes));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function text(s: string): any {
    const node = doc.createTextNode(s);
    ours.add(node);
    return node;
  }

  // Rebuilds `target`'s children from the translated node `from`, reusing original elements.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function merge(target: any, from: any, slots: any[], used: Set<number>): void {
    saveChildren(target);
    detach(target);
    for (const child of Array.from(from.childNodes) as any[]) {
      if (child.nodeType === TEXT) {
        target.appendChild(text(child.data));
        continue;
      }
      if (child.nodeType !== ELEMENT) continue;
      const n = Number(child.getAttribute('data-t'));
      const orig = Number.isInteger(n) ? slots[n] : undefined;
      if (orig && !used.has(n)) {
        used.add(n);
        if (isInline(orig) && !excluded(orig)) merge(orig, child, slots, used);
        target.appendChild(orig);
      } else if (child.textContent) {
        target.appendChild(text(child.textContent));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseFragment(html: string): any {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    return tpl.content || tpl;
  }

  function applyOne(u: Unit, translated: string): void {
    if (!u.isHTML) {
      savedAttrs.push({ el: u.el, attr: u.attr!, value: u.source });
      u.el.setAttribute(u.attr, translated);
      return;
    }
    const slots = u.slots!;
    const used = new Set<number>();
    merge(u.el, parseFragment(translated), slots, used);
    // Top-level placeholders the engine dropped are appended so nothing disappears.
    for (let n = 0; n < slots.length; n++) {
      if (!used.has(n) && slots[n].parentNode == null) u.el.appendChild(slots[n]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onMutations(records: any[]): void {
    const found: Unit[] = [];
    for (const rec of records) {
      for (const node of Array.from(rec.addedNodes || []) as any[]) {
        if (ours.has(node) || node.nodeType !== ELEMENT) continue;
        if (savedChildren.has(node) || unitOf.has(node)) continue;
        // Content added inside a translated unit is left alone: the unit already holds translated text.
        // Content under an excluded ancestor stays untranslated.
        let p = node.parentNode;
        let skip = false;
        while (p && p.nodeType === ELEMENT) {
          if (unitOf.has(p) || excluded(p)) { skip = true; break; }
          p = p.parentNode;
        }
        if (skip) continue;
        const wrapper = { childNodes: [node] };
        scan(wrapper, found, false);
      }
    }
    enqueue(found);
  }

  function observe(): void {
    if (observer || !win || typeof win.MutationObserver !== 'function' || !doc.body) return;
    observer = new win.MutationObserver(onMutations);
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  return {
    collect() {
      const found: Unit[] = [];
      const root = doc.body || doc.documentElement;
      // Wrapped so text sitting directly in <body> forms a unit of its own.
      if (root) scan({ childNodes: [root] }, found, false);
      enqueue(found);
      observe();
      return nextBatch();
    },
    drain() {
      return nextBatch();
    },
    apply(results) {
      let applied = 0;
      let requeued = 0;
      for (const r of results || []) {
        const u = units.get(r.id);
        if (!u || !handedOut.has(r.id)) continue;
        handedOut.delete(r.id);
        const current = u.isHTML ? serialize(u.el, []) : u.el.getAttribute(u.attr);
        if (current !== u.source || (u.isHTML && savedChildren.has(u.el))) {
          // Changed since it was handed out: re-scan it as a fresh unit.
          units.delete(r.id);
          if (u.isHTML && !savedChildren.has(u.el)) {
            unitOf.delete(u.el);
            const found: Unit[] = [];
            scan({ childNodes: [u.el] }, found, false);
            enqueue(found.filter((f) => f.isHTML));
            requeued++;
          }
          continue;
        }
        cache.set((u.isHTML ? 'h:' : 't:') + u.source, r.text);
        applyOne(u, r.text);
        applied++;
      }
      return { applied, requeued };
    },
    restore() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      for (const [el, kids] of savedChildren) {
        detach(el);
        for (const k of kids) el.appendChild(k);
      }
      for (let i = savedAttrs.length - 1; i >= 0; i--) {
        const s = savedAttrs[i];
        s.el.setAttribute(s.attr, s.value);
      }
      savedChildren.clear();
      savedAttrs.length = 0;
      units.clear();
      queued.length = 0;
      handedOut.clear();
      unitOf = new WeakMap();
      attrSeen = new WeakMap();
    },
    pendingCount() {
      return queued.length;
    },
  };
}

/** The global the injected translator lives under in the page's isolated world. */
export const PAGE_TRANSLATOR_GLOBAL = '__peekPageTranslator';

/** The global holding the options the installed translator was created with. */
export const PAGE_TRANSLATOR_OPTIONS_GLOBAL = '__peekPageTranslatorOptions';

/**
 * Script that installs the translator in the isolated world and evaluates to `true`. Running it
 * again with the same options keeps the existing instance, its saved originals and its
 * translation cache. Different options (another source or target language) replace it, which
 * is safe only once the old instance has restored the page: `page-session.ts` injects only
 * from idle, after a restore or on a fresh document.
 */
export function injectionSource(opts: TranslatorOptions = {}): string {
  const json = JSON.stringify(opts);
  const key = JSON.stringify(json);
  return `(() => { if (!globalThis.${PAGE_TRANSLATOR_GLOBAL} || globalThis.${PAGE_TRANSLATOR_OPTIONS_GLOBAL} !== ${key}) { globalThis.${PAGE_TRANSLATOR_GLOBAL} = (${pageTranslator.toString()})(document, ${json}); globalThis.${PAGE_TRANSLATOR_OPTIONS_GLOBAL} = ${key}; } return true; })()`;
}

/** Script that calls one translator method; evaluates to its JSON-safe return value. */
export function callSource(method: 'collect' | 'drain' | 'apply' | 'restore' | 'pendingCount', arg?: unknown): string {
  const a = arg === undefined ? '' : JSON.stringify(arg);
  return `(() => { const t = globalThis.${PAGE_TRANSLATOR_GLOBAL}; return t ? t.${method}(${a}) ?? null : null; })()`;
}
