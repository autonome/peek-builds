/**
 * Unit tests for the dead-space double-click decision shared by the hybrid
 * page-host content preload and the plain peek:// tile preload
 * (chrome-api-polyfills/dead-space-gesture.cjs), against fake DOM nodes.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('./chrome-api-polyfills/dead-space-gesture.cjs') as {
  isInteractiveTarget(el: unknown, extraTags?: string[]): boolean;
  gestureSuppressed(e: unknown, win: unknown, extraTags?: string[]): boolean;
  installDeadSpaceGesture(doc: unknown, win: unknown, send: (p: unknown) => void, extraTags?: string[]): void;
};

function el(tag: string, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isContentEditable: false,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    ...extra,
  };
}
const noSelection = { getSelection: () => null };
const click = (path: unknown[], x = 10, y = 10, detail = 2) =>
  ({ composedPath: () => path, clientX: x, clientY: y, detail });

describe('isInteractiveTarget / gestureSuppressed', () => {
  it('dead space (div, body) is not suppressed', () => {
    assert.strictEqual(shared.gestureSuppressed(click([el('div'), el('body')]), noSelection), false);
  });
  it('inputs, textareas, buttons, links, roles and editable content suppress', () => {
    for (const n of [
      el('input', { type: 'text' }), el('textarea'), el('button'), el('a'),
      el('div', { role: 'button' }), el('div', {}, { isContentEditable: true }),
    ]) {
      assert.strictEqual(shared.gestureSuppressed(click([n, el('body')]), noSelection), true);
    }
  });
  it('a checkbox input is interactive even though it is not editable', () => {
    assert.strictEqual(shared.isInteractiveTarget(el('input', { type: 'checkbox' })), false);
    assert.strictEqual(shared.isInteractiveTarget(el('button')), true);
  });
  it('a card (extra tag) anywhere on the path suppresses, only when listed', () => {
    const path = [el('div'), el('peek-card'), el('body')];
    assert.strictEqual(shared.gestureSuppressed(click(path), noSelection), false);
    assert.strictEqual(shared.gestureSuppressed(click(path), noSelection, ['peek-card']), true);
  });
  it('a click inside the selected text suppresses; a selection elsewhere does not', () => {
    const sel = (r: { left: number; right: number; top: number; bottom: number }) => ({
      getSelection: () => ({
        isCollapsed: false, rangeCount: 1, toString: () => 'word',
        getRangeAt: () => ({ getClientRects: () => [r] }),
      }),
    });
    const rect = { left: 0, right: 50, top: 0, bottom: 20 };
    assert.strictEqual(shared.gestureSuppressed(click([el('p')], 10, 10), sel(rect)), true);
    assert.strictEqual(shared.gestureSuppressed(click([el('p')], 300, 300), sel(rect)), false);
  });
});

describe('installDeadSpaceGesture', () => {
  function setup(extra?: string[]) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const doc = { addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; } };
    const sent: unknown[] = [];
    shared.installDeadSpaceGesture(doc, noSelection, (p) => sent.push(p), extra);
    return { handlers, sent };
  }
  it('reports a dead-space double-click with the press-to-release travel', () => {
    const { handlers, sent } = setup();
    handlers.mousedown({ clientX: 8, clientY: 10 });
    handlers.click(click([el('div')], 10, 10));
    assert.deepStrictEqual(sent, [{ detent: 2, dragDx: 2, dragDy: 0 }]);
  });
  it('does not report single clicks or double-clicks over interactive targets', () => {
    const { handlers, sent } = setup();
    handlers.click(click([el('div')], 10, 10, 1));
    handlers.click(click([el('button')], 10, 10, 2));
    assert.deepStrictEqual(sent, []);
  });
  it('a press point belongs to exactly one click', () => {
    const { handlers, sent } = setup();
    handlers.mousedown({ clientX: 100, clientY: 100 });
    handlers.click(click([el('div')], 100, 100, 1));
    handlers.click(click([el('div')], 10, 10, 2));
    assert.deepStrictEqual(sent, [{ detent: 2, dragDx: 0, dragDy: 0 }]);
  });
});
