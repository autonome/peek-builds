/**
 * Unit tests for command palette and related pure logic
 *
 * Tests extracted pure functions from:
 * - extensions/cmd/panel.js: ESC behavior, shift-tab cycling, frecency sorting
 * - extensions/cmd/commands/note.js: parseTagset, detectType
 * - preload.js: shouldBlockDrag
 *
 * These are logic-only tests -- no DOM, no Electron, no extensions runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// parseTagset (from extensions/cmd/commands/note.js)
// ============================================================================

function parseTagset(text: string | null | undefined): string[] | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return null;
  const allHashtags = tokens.every((t: string) => /^#[^\s#]+$/.test(t));
  if (!allHashtags) return null;
  return tokens.map((t: string) => t.slice(1));
}

// ============================================================================
// detectType (from extensions/cmd/commands/note.js)
// ============================================================================

function detectType(text: string | null | undefined): string | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url';
  if (parseTagset(trimmed)) return 'tagset';
  return 'text';
}

// ============================================================================
// extractInlineHashtags (from extensions/cmd/commands/note.js)
// ============================================================================

function extractInlineHashtags(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:^|\s)#([^\s#]+)/g);
  if (!matches) return [];
  return matches.map((m: string) => m.trim().slice(1));
}

// ============================================================================
// shouldBlockDrag (from preload.js)
// ============================================================================

interface MockElement {
  tagName?: string;
  isContentEditable?: boolean;
  hasAttribute?: (name: string) => boolean;
  closest?: (selector: string) => MockElement | null;
}

function shouldBlockDrag(target: MockElement | null, activeElement: MockElement | null): boolean {
  if (!target) return false;
  if (target.hasAttribute && target.hasAttribute('data-no-drag')) return true;
  if (target.closest && target.closest('[data-no-drag]')) return true;
  const tag = target.tagName?.toLowerCase();
  if ((tag === 'input' || tag === 'textarea') && target === activeElement) return true;
  if (target.isContentEditable) return true;
  return false;
}

// ============================================================================
// ESC state machine (from extensions/cmd/panel.js)
// ============================================================================

interface CmdPanelState {
  outputSelectionMode: boolean;
  chainMode: boolean;
  showResults: boolean;
  inputValue: string;
}

type EscAction = 'exit-output-selection' | 'exit-chain' | 'hide-results' | 'clear-text' | 'shutdown';

function getEscAction(state: CmdPanelState): EscAction {
  if (state.outputSelectionMode) return 'exit-output-selection';
  if (state.chainMode) return 'exit-chain';
  if (state.showResults) return 'hide-results';
  if (state.inputValue) return 'clear-text';
  return 'shutdown';
}

// ============================================================================
// Tab cycling logic (from extensions/cmd/panel.js)
// ============================================================================

interface TabCycleState {
  matches: string[];
  matchIndex: number;
  inputValue: string;
  shiftKey: boolean;
}

function getTabCycleIndex(state: TabCycleState): number {
  if (state.matches.length === 0) return state.matchIndex;

  const currentMatch = state.matches[state.matchIndex];
  const currentValue = state.inputValue.trim();

  const alreadyCompleted = currentValue === currentMatch ||
                          currentValue.startsWith(currentMatch + ' ');

  if (alreadyCompleted && state.matches.length > 1) {
    if (state.shiftKey) {
      return (state.matchIndex - 1 + state.matches.length) % state.matches.length;
    } else {
      return (state.matchIndex + 1) % state.matches.length;
    }
  }

  return state.matchIndex;
}

// ============================================================================
// Adaptive feedback (from extensions/cmd/panel.js)
// ============================================================================

interface AdaptiveFeedback {
  [typed: string]: { [command: string]: number };
}

function updateAdaptiveFeedback(feedback: AdaptiveFeedback, typed: string, name: string): void {
  if (!feedback[typed]) {
    feedback[typed] = {};
  }
  if (!feedback[typed][name]) {
    feedback[typed][name] = 0;
  }
  feedback[typed][name]++;

  for (let i = 1; i < typed.length; i++) {
    const prefix = typed.slice(0, i);
    if (!feedback[prefix]) {
      feedback[prefix] = {};
    }
    if (!feedback[prefix][name]) {
      feedback[prefix][name] = 0;
    }
    feedback[prefix][name]++;
  }
}

function getAdaptiveScore(feedback: AdaptiveFeedback, typed: string, command: string): number {
  const entry = feedback[typed];
  if (!entry) return 0;
  const total = Object.values(entry).reduce((sum: number, n: number) => sum + n, 0);
  if (total === 0) return 0;
  return (entry[command] || 0) / total;
}

// ============================================================================
// Tests
// ============================================================================

describe('Note Command -- parseTagset', () => {
  it('parses simple hashtags', () => {
    assert.deepStrictEqual(parseTagset('#foo #bar'), ['foo', 'bar']);
  });

  it('parses single hashtag', () => {
    assert.deepStrictEqual(parseTagset('#todo'), ['todo']);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseTagset(''), null);
  });

  it('returns null for null/undefined', () => {
    assert.strictEqual(parseTagset(null), null);
    assert.strictEqual(parseTagset(undefined), null);
  });

  it('returns null for mixed text and hashtags', () => {
    assert.strictEqual(parseTagset('hello #foo'), null);
  });

  it('returns null for plain text', () => {
    assert.strictEqual(parseTagset('just some text'), null);
  });

  it('returns null for hashtag with no name', () => {
    assert.strictEqual(parseTagset('#'), null);
  });

  it('handles extra whitespace', () => {
    assert.deepStrictEqual(parseTagset('  #foo   #bar  '), ['foo', 'bar']);
  });

  it('handles hashtags with colons (namespaced tags)', () => {
    assert.deepStrictEqual(parseTagset('#from:cmd #note'), ['from:cmd', 'note']);
  });

  it('returns null for double-hash tokens', () => {
    assert.strictEqual(parseTagset('##invalid'), null);
  });

  it('returns null for hash in middle of word', () => {
    assert.strictEqual(parseTagset('no#hash'), null);
  });
});

describe('Note Command -- detectType', () => {
  it('detects http URLs', () => {
    assert.strictEqual(detectType('http://example.com'), 'url');
  });

  it('detects https URLs', () => {
    assert.strictEqual(detectType('https://example.com/path?q=1'), 'url');
  });

  it('detects tagset input', () => {
    assert.strictEqual(detectType('#todo #important'), 'tagset');
  });

  it('detects plain text', () => {
    assert.strictEqual(detectType('remember to buy milk'), 'text');
  });

  it('returns null for empty input', () => {
    assert.strictEqual(detectType(''), null);
  });

  it('returns null for null/undefined', () => {
    assert.strictEqual(detectType(null), null);
    assert.strictEqual(detectType(undefined), null);
  });

  it('returns text for non-http URLs', () => {
    assert.strictEqual(detectType('ftp://files.example.com'), 'text');
  });

  it('returns text for domain-like strings without protocol', () => {
    assert.strictEqual(detectType('example.com'), 'text');
  });
});

describe('Note Command -- extractInlineHashtags', () => {
  it('extracts hashtags from text', () => {
    assert.deepStrictEqual(extractInlineHashtags('buy milk #grocery #todo'), ['grocery', 'todo']);
  });

  it('extracts hashtag at start of text', () => {
    assert.deepStrictEqual(extractInlineHashtags('#urgent fix the bug'), ['urgent']);
  });

  it('returns empty array for text without hashtags', () => {
    assert.deepStrictEqual(extractInlineHashtags('just regular text'), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(extractInlineHashtags(''), []);
  });

  it('handles multiple hashtags with various spacing', () => {
    const result = extractInlineHashtags('task #work  #priority #q1');
    assert.ok(result.includes('work'));
    assert.ok(result.includes('priority'));
    assert.ok(result.includes('q1'));
  });
});

describe('Command Palette -- ESC Behavior', () => {
  it('exits output selection mode first', () => {
    assert.strictEqual(getEscAction({
      outputSelectionMode: true, chainMode: false, showResults: true, inputValue: 'hello'
    }), 'exit-output-selection');
  });

  it('exits chain mode second', () => {
    assert.strictEqual(getEscAction({
      outputSelectionMode: false, chainMode: true, showResults: true, inputValue: 'hello'
    }), 'exit-chain');
  });

  it('hides results third', () => {
    assert.strictEqual(getEscAction({
      outputSelectionMode: false, chainMode: false, showResults: true, inputValue: 'hello'
    }), 'hide-results');
  });

  it('clears text fourth (before closing)', () => {
    assert.strictEqual(getEscAction({
      outputSelectionMode: false, chainMode: false, showResults: false, inputValue: 'hello'
    }), 'clear-text');
  });

  it('shuts down when everything is already clear', () => {
    assert.strictEqual(getEscAction({
      outputSelectionMode: false, chainMode: false, showResults: false, inputValue: ''
    }), 'shutdown');
  });

  it('priority order: output-selection > chain > results > text > shutdown', () => {
    const allActive: CmdPanelState = {
      outputSelectionMode: true, chainMode: true, showResults: true, inputValue: 'test'
    };
    assert.strictEqual(getEscAction(allActive), 'exit-output-selection');
    assert.strictEqual(getEscAction({ ...allActive, outputSelectionMode: false }), 'exit-chain');
    assert.strictEqual(getEscAction({ ...allActive, outputSelectionMode: false, chainMode: false }), 'hide-results');
    assert.strictEqual(getEscAction({ ...allActive, outputSelectionMode: false, chainMode: false, showResults: false }), 'clear-text');
    assert.strictEqual(getEscAction({ ...allActive, outputSelectionMode: false, chainMode: false, showResults: false, inputValue: '' }), 'shutdown');
  });
});

describe('Command Palette -- Tab Cycling (Shift-Tab reverse)', () => {
  it('Tab cycles forward through matches', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags', 'open groups'],
      matchIndex: 0,
      inputValue: 'open ',
      shiftKey: false,
    });
    assert.strictEqual(idx, 1);
  });

  it('Shift-Tab cycles backward through matches', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags', 'open groups'],
      matchIndex: 1,
      inputValue: 'open tags ',
      shiftKey: true,
    });
    assert.strictEqual(idx, 0);
  });

  it('Tab wraps around to first match', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags', 'open groups'],
      matchIndex: 2,
      inputValue: 'open groups ',
      shiftKey: false,
    });
    assert.strictEqual(idx, 0);
  });

  it('Shift-Tab wraps around to last match', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags', 'open groups'],
      matchIndex: 0,
      inputValue: 'open ',
      shiftKey: true,
    });
    assert.strictEqual(idx, 2);
  });

  it('first Tab does not cycle (stays on current match for autocomplete)', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags'],
      matchIndex: 0,
      inputValue: 'op',
      shiftKey: false,
    });
    assert.strictEqual(idx, 0, 'First Tab should autocomplete, not cycle');
  });

  it('Tab with single match stays on same index', () => {
    const idx = getTabCycleIndex({
      matches: ['unique-command'],
      matchIndex: 0,
      inputValue: 'unique-command ',
      shiftKey: false,
    });
    assert.strictEqual(idx, 0, 'Single match cannot cycle');
  });

  it('Tab with empty matches returns current index', () => {
    const idx = getTabCycleIndex({
      matches: [],
      matchIndex: 0,
      inputValue: '',
      shiftKey: false,
    });
    assert.strictEqual(idx, 0);
  });

  it('value with parameters still counts as completed', () => {
    const idx = getTabCycleIndex({
      matches: ['open', 'open tags'],
      matchIndex: 0,
      inputValue: 'open something.txt',
      shiftKey: false,
    });
    assert.strictEqual(idx, 1, 'Should cycle when input starts with match + space');
  });
});

describe('Frecency -- Adaptive Feedback', () => {
  it('records feedback for typed text', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    assert.strictEqual(feedback['ta']['open tags'], 1);
  });

  it('increments count on repeated use', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    assert.strictEqual(feedback['ta']['open tags'], 2);
  });

  it('tracks multiple commands for same typed text', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open groups');
    assert.strictEqual(feedback['op']['open tags'], 1);
    assert.strictEqual(feedback['op']['open groups'], 1);
  });

  it('updates prefix entries (originalTyped tracking)', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    assert.strictEqual(feedback['t']['open tags'], 1);
  });

  it('adaptive score is proportional to usage', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open groups');

    const tagsScore = getAdaptiveScore(feedback, 'op', 'open tags');
    const groupsScore = getAdaptiveScore(feedback, 'op', 'open groups');

    assert.ok(Math.abs(tagsScore - 2/3) < 0.01, 'tags score ' + tagsScore + ' should be ~0.667');
    assert.ok(Math.abs(groupsScore - 1/3) < 0.01, 'groups score ' + groupsScore + ' should be ~0.333');
  });

  it('returns 0 for unknown typed text', () => {
    const feedback: AdaptiveFeedback = {};
    assert.strictEqual(getAdaptiveScore(feedback, 'xyz', 'anything'), 0);
  });

  it('returns 0 for unknown command with known text', () => {
    const feedback: AdaptiveFeedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    assert.strictEqual(getAdaptiveScore(feedback, 'op', 'unknown-cmd'), 0);
  });
});

describe('Drag System -- shouldBlockDrag', () => {
  it('returns false for null target', () => {
    assert.strictEqual(shouldBlockDrag(null, null), false);
  });

  it('blocks on elements with data-no-drag attribute', () => {
    const el: MockElement = {
      tagName: 'DIV',
      hasAttribute: (name: string) => name === 'data-no-drag',
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, null), true);
  });

  it('blocks on children of data-no-drag elements', () => {
    const parent: MockElement = { tagName: 'DIV' };
    const el: MockElement = {
      tagName: 'SPAN',
      hasAttribute: () => false,
      closest: (sel: string) => sel === '[data-no-drag]' ? parent : null,
    };
    assert.strictEqual(shouldBlockDrag(el, null), true);
  });

  it('blocks on focused input elements', () => {
    const el: MockElement = {
      tagName: 'INPUT',
      hasAttribute: () => false,
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, el), true);
  });

  it('blocks on focused textarea elements', () => {
    const el: MockElement = {
      tagName: 'TEXTAREA',
      hasAttribute: () => false,
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, el), true);
  });

  it('allows drag on unfocused input (not activeElement)', () => {
    const input: MockElement = {
      tagName: 'INPUT',
      hasAttribute: () => false,
      closest: () => null,
    };
    const other: MockElement = { tagName: 'DIV' };
    assert.strictEqual(shouldBlockDrag(input, other), false);
  });

  it('blocks on contentEditable elements', () => {
    const el: MockElement = {
      tagName: 'DIV',
      isContentEditable: true,
      hasAttribute: () => false,
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, null), true);
  });

  it('allows drag on normal div elements', () => {
    const el: MockElement = {
      tagName: 'DIV',
      isContentEditable: false,
      hasAttribute: () => false,
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, null), false);
  });

  it('allows drag on button elements', () => {
    const el: MockElement = {
      tagName: 'BUTTON',
      isContentEditable: false,
      hasAttribute: () => false,
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, el), false);
  });

  it('data-no-drag takes priority over everything', () => {
    const el: MockElement = {
      tagName: 'DIV',
      isContentEditable: false,
      hasAttribute: (name: string) => name === 'data-no-drag',
      closest: () => null,
    };
    assert.strictEqual(shouldBlockDrag(el, null), true);
  });
});
