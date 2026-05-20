/**
 * Unit tests for quick-add draft persistence logic.
 *
 * Tests the localStorage read/write/clear logic that mirrors what App.tsx does.
 * No browser/Playwright needed — we simulate the localStorage contract directly.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const QUICK_ADD_DRAFT_KEY = 'peek:mobile:quickAddDraft';

// Minimal localStorage simulation (synchronous Map-backed)
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

// Mirrors the persist logic from the useEffect in App.tsx
function persistDraft(ls, { addInputExpanded, addInputText, addInputTags, addInputNewTag }) {
  if (!addInputExpanded) return;
  const hasContent = addInputText || addInputTags.size > 0 || addInputNewTag;
  if (hasContent) {
    ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({
      text: addInputText,
      tags: Array.from(addInputTags),
      newTag: addInputNewTag,
    }));
  } else {
    ls.removeItem(QUICK_ADD_DRAFT_KEY);
  }
}

// Mirrors loadInitialQuickAddDraft() from App.tsx (module-scope helper, mount-time read)
function loadInitialQuickAddDraft(ls) {
  try {
    const raw = ls.getItem(QUICK_ADD_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const hasContent = d.text || (Array.isArray(d.tags) && d.tags.length > 0) || d.newTag;
    if (!hasContent) return null;
    return {
      text: typeof d.text === 'string' ? d.text : '',
      tags: Array.isArray(d.tags) ? d.tags : [],
      newTag: typeof d.newTag === 'string' ? d.newTag : '',
    };
  } catch {
    return null;
  }
}

// Mirrors resetAddInput() in App.tsx (called after successful save)
function resetAndClear(ls) {
  ls.removeItem(QUICK_ADD_DRAFT_KEY);
}

describe('quick-add draft persistence', () => {
  let ls;

  beforeEach(() => {
    ls = makeLocalStorage();
  });

  describe('persist on change', () => {
    it('writes draft when panel is expanded and text is present', () => {
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: 'draft text test 12345',
        addInputTags: new Set(),
        addInputNewTag: '',
      });
      const raw = ls.getItem(QUICK_ADD_DRAFT_KEY);
      assert.ok(raw, 'draft should be written');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.text, 'draft text test 12345');
    });

    it('writes draft with tags', () => {
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: '',
        addInputTags: new Set(['foo', 'bar']),
        addInputNewTag: '',
      });
      const parsed = JSON.parse(ls.getItem(QUICK_ADD_DRAFT_KEY));
      assert.deepEqual(parsed.tags.sort(), ['bar', 'foo']);
    });

    it('writes draft with newTag only', () => {
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: '',
        addInputTags: new Set(),
        addInputNewTag: 'pending',
      });
      const parsed = JSON.parse(ls.getItem(QUICK_ADD_DRAFT_KEY));
      assert.equal(parsed.newTag, 'pending');
    });

    it('removes draft when panel is expanded but all fields empty', () => {
      // First write something
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: 'old', tags: [], newTag: '' }));
      // Then clear
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: '',
        addInputTags: new Set(),
        addInputNewTag: '',
      });
      assert.equal(ls.getItem(QUICK_ADD_DRAFT_KEY), null, 'draft should be removed when empty');
    });

    it('does nothing when panel is not expanded', () => {
      persistDraft(ls, {
        addInputExpanded: false,
        addInputText: 'draft text test 12345',
        addInputTags: new Set(),
        addInputNewTag: '',
      });
      assert.equal(ls.getItem(QUICK_ADD_DRAFT_KEY), null, 'should not write when panel closed');
    });
  });

  describe('load on mount', () => {
    it('returns null when storage is empty', () => {
      const result = loadInitialQuickAddDraft(ls);
      assert.equal(result, null);
    });

    it('returns draft with text only', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: 'draft text test 12345', tags: [], newTag: '' }));
      const result = loadInitialQuickAddDraft(ls);
      assert.ok(result, 'should return draft');
      assert.equal(result.text, 'draft text test 12345');
      assert.deepEqual(result.tags, []);
      assert.equal(result.newTag, '');
    });

    it('returns draft with tags only', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: '', tags: ['alpha', 'beta'], newTag: '' }));
      const result = loadInitialQuickAddDraft(ls);
      assert.ok(result);
      assert.deepEqual(result.tags.sort(), ['alpha', 'beta']);
      assert.equal(result.text, '');
      assert.equal(result.newTag, '');
    });

    it('returns draft with all three fields', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: 'hello', tags: ['foo'], newTag: 'bar' }));
      const result = loadInitialQuickAddDraft(ls);
      assert.ok(result);
      assert.equal(result.text, 'hello');
      assert.deepEqual(result.tags, ['foo']);
      assert.equal(result.newTag, 'bar');
    });

    it('returns draft with newTag only', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: '', tags: [], newTag: 'pending-tag' }));
      const result = loadInitialQuickAddDraft(ls);
      assert.ok(result);
      assert.equal(result.newTag, 'pending-tag');
    });

    it('returns null on corrupt JSON (does not remove from storage)', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, 'not-json{{{');
      const result = loadInitialQuickAddDraft(ls);
      assert.equal(result, null);
      // loadInitialQuickAddDraft does NOT remove on corrupt — that's intentional
    });

    it('returns null when all fields are empty', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: '', tags: [], newTag: '' }));
      const result = loadInitialQuickAddDraft(ls);
      assert.equal(result, null);
    });
  });

  describe('clear on save', () => {
    it('removes draft after successful save (resetAddInput)', () => {
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({ text: 'draft text test 12345', tags: [], newTag: '' }));
      resetAndClear(ls);
      assert.equal(ls.getItem(QUICK_ADD_DRAFT_KEY), null, 'draft should be cleared after save');
    });
  });

  describe('dismiss preserves draft (cancel path)', () => {
    it('draft remains in storage after dismiss (not calling resetAndClear)', () => {
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: 'draft text test 12345',
        addInputTags: new Set(),
        addInputNewTag: '',
      });
      // Dismiss without calling resetAndClear (mirrors setAddInputExpanded(false) directly)
      // Draft should still be there
      const raw = ls.getItem(QUICK_ADD_DRAFT_KEY);
      assert.ok(raw, 'draft should survive dismiss');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.text, 'draft text test 12345');
    });

    it('reopening panel restores the dismissed draft', () => {
      // Step 1: expand, type, persist
      persistDraft(ls, {
        addInputExpanded: true,
        addInputText: 'draft text test 12345',
        addInputTags: new Set(),
        addInputNewTag: '',
      });
      // Step 2: dismiss (no clear)
      // Step 3: next mount reads draft via loadInitialQuickAddDraft
      const state = loadInitialQuickAddDraft(ls);
      assert.ok(state, 'should restore after dismiss+reopen');
      assert.equal(state.text, 'draft text test 12345');
    });

    it('draft survives simulated page reload (data in storage)', () => {
      // Write the draft (as would happen before iOS kill)
      ls.setItem(QUICK_ADD_DRAFT_KEY, JSON.stringify({
        text: 'draft text test 12345',
        tags: [],
        newTag: '',
      }));
      // Simulate reload: mount reads draft via loadInitialQuickAddDraft
      const stateAfterReload = loadInitialQuickAddDraft(ls);
      assert.ok(stateAfterReload, 'draft should survive reload');
      assert.equal(stateAfterReload.text, 'draft text test 12345');
    });
  });
});
