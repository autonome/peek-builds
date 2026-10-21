/**
 * Unit tests for the cmd palette's pure logic and the note command's input
 * classification.
 *
 * Exercises the shipping code:
 * - renderer/lib/note-tags.js: parseTagset, detectType
 * - renderer/cmd/panel-logic.js: getTabCycleIndex, updateAdaptiveFeedback,
 *   getAdaptiveScore, getFrecencyScore
 * - renderer/index.js + renderer/settings/settings.js, read as source: the
 *   settings command's pane list against the sections that actually exist
 *
 * Run via: node --test tests/unit/cmd-logic.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTagset, detectType } from '../../renderer/lib/note-tags.js';
import {
  getTabCycleIndex,
  updateAdaptiveFeedback,
  getAdaptiveScore,
  getFrecencyScore,
} from '../../renderer/cmd/panel-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    assert.strictEqual(feedback['ta']['open tags'], 1);
  });

  it('builds on the previous count when the same pick repeats', () => {
    // Each record decays what is already there, so a second pick lands just
    // under 2 rather than exactly on it.
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    assert.strictEqual(feedback['ta']['open tags'], 1.95);
  });

  it('tracks multiple commands for same typed text, decaying the older one', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open groups');
    assert.strictEqual(feedback['op']['open tags'], 0.95);
    assert.strictEqual(feedback['op']['open groups'], 1);
  });

  it('gives sub-prefixes of each word of the command name a smaller share', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    // 'open' is neither a prefix of 'ta' nor prefixed by it, so its own
    // sub-prefixes get credited.
    assert.strictEqual(feedback['op']['open tags'], 0.25);
    assert.strictEqual(feedback['ope']['open tags'], 0.25);
    assert.strictEqual(feedback['open']['open tags'], 0.25);
  });

  it('skips the word the typed text is already a prefix of', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'ta', 'open tags');
    // 'tags' starts with 'ta', so crediting 'ta'/'tag'/'tags' would add nothing
    // the exact entry does not already say.
    assert.strictEqual(feedback['tag'], undefined);
    assert.strictEqual(feedback['tags'], undefined);
  });

  it('drops an entry that decays below the prune threshold', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'q', 'alpha');
    for (let i = 0; i < 60; i++) updateAdaptiveFeedback(feedback, 'q', 'beta');
    assert.strictEqual(feedback['q']['alpha'], undefined, 'stale pick is forgotten');
    assert.ok(feedback['q']['beta'] > 1, 'repeated pick survives');
  });

  it('adaptive score rises with usage and saturates below 1', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    updateAdaptiveFeedback(feedback, 'op', 'open groups');

    const tagsScore = getAdaptiveScore(feedback, 'op', 'open tags');
    const groupsScore = getAdaptiveScore(feedback, 'op', 'open groups');

    assert.ok(tagsScore > groupsScore, `tags ${tagsScore} should outrank groups ${groupsScore}`);
    // weight / (weight + 3), where the twice-picked entry has decayed to 1.8525
    assert.ok(Math.abs(tagsScore - 1.8525 / 4.8525) < 0.01, 'tags score ' + tagsScore);
    assert.ok(Math.abs(groupsScore - 1 / 4) < 0.01, 'groups score ' + groupsScore);
    assert.ok(tagsScore < 1 && groupsScore < 1, 'scores never reach 1');
  });

  it('returns 0 for unknown typed text', () => {
    assert.strictEqual(getAdaptiveScore({}, 'xyz', 'anything'), 0);
  });

  it('returns 0 for unknown command with known text', () => {
    const feedback = {};
    updateAdaptiveFeedback(feedback, 'op', 'open tags');
    assert.strictEqual(getAdaptiveScore(feedback, 'op', 'unknown-cmd'), 0);
  });
});

describe('URL Frecency -- matchCounts boost URL ranking', () => {
  it('URL with matchCounts gets positive frecency score', () => {
    const matchCounts = { 'http://localhost:3000': 5 };
    const score = getFrecencyScore(matchCounts, 'http://localhost:3000');
    assert.ok(score > 0, 'URL with 5 uses should have positive frecency');
    assert.ok(Math.abs(score - 5 / 15) < 0.01, 'score should be ~0.333');
  });

  it('URL without matchCounts gets zero frecency score', () => {
    assert.strictEqual(getFrecencyScore({}, 'http://localhost:3000'), 0);
  });

  it('frequently used URL ranks above unused URL', () => {
    const matchCounts = { 'http://localhost:3000': 10 };
    const usedScore = getFrecencyScore(matchCounts, 'http://localhost:3000');
    const unusedScore = getFrecencyScore(matchCounts, 'https://other.com');
    assert.ok(usedScore > unusedScore, 'Used URL should rank above unused URL');
  });
});

// ============================================================================
// Settings command -- pane list integrity
//
// Regression guard: commit cdc19eda removed individual per-pane commands and
// replaced them with a single parameterized 'settings' command, but also left
// a bare 'settings' registration before it that blocked the params from
// reaching the cmd panel (tile-preload deduplication early-returns on duplicate
// name). The fix removes the duplicate registration. These tests pin the pane
// list against the sections that really exist, in both directions: a pane with
// no section would open an empty settings window, and a section missing from
// the list would be unreachable from the palette.
//
// Both lists are read out of the product source, because neither file can be
// imported under node: index.js assigns to `window` at load, and settings.js is
// a DOM renderer.
// ============================================================================

/** The `{ value, title, subtitle }` entries of SETTINGS_PANES in renderer/index.js. */
function readSettingsPanes() {
  const src = readFileSync(join(__dirname, '../../renderer/index.js'), 'utf-8');
  const block = src.match(/const SETTINGS_PANES = \[([\s\S]*?)\n\s*\];/);
  assert.ok(block, 'SETTINGS_PANES array not found in renderer/index.js');
  const body = block[1];
  const panes = [...body.matchAll(
    /\{\s*value:\s*'([^']*)',\s*title:\s*'([^']*)',\s*subtitle:\s*'([^']*)'\s*\}/g
  )].map(([, value, title, subtitle]) => ({ value, title, subtitle }));
  // If an entry is written in a shape this parser misses, fail loudly instead
  // of silently testing a short list.
  const declared = (body.match(/\bvalue:/g) || []).length;
  assert.strictEqual(panes.length, declared, 'could not parse every SETTINGS_PANES entry');
  assert.ok(panes.length > 0, 'SETTINGS_PANES parsed as empty');
  return panes;
}

/** The section ids rendered by renderer/settings/settings.js, as `section-<id>`. */
function readSectionIds() {
  const src = readFileSync(join(__dirname, '../../renderer/settings/settings.js'), 'utf-8');
  const ids = new Set();
  // Sections built through createSection(<id>, ...), which sets `section-${id}`.
  for (const [, id] of src.matchAll(/createSection\(\s*'([a-z0-9-]+)'/g)) ids.add(id);
  // Sections that assign the element id directly.
  for (const [, id] of src.matchAll(/\.id\s*=\s*'section-([a-z0-9-]+)'/g)) ids.add(id);
  assert.ok(ids.size > 0, 'no section ids found in settings.js');
  return ids;
}

// Sections deliberately not offered as a pane of the 'settings' command.
const SECTIONS_WITHOUT_A_PANE = new Set(['devices']);

// IDs that existed in the old per-command era or were never valid sections.
// They must NOT be present in SETTINGS_PANES.
const STALE_PANE_IDS = ['features', 'peeks', 'slides', 'groups'];

describe('Settings command -- pane list integrity', () => {
  it('every pane names a section that settings.js actually renders', () => {
    const paneIds = readSettingsPanes().map(p => p.value);
    const sectionIds = readSectionIds();
    for (const id of paneIds) {
      assert.ok(sectionIds.has(id), `SETTINGS_PANES pane '${id}' has no section-${id} in settings.js`);
    }
  });

  it('every section settings.js renders is reachable as a pane', () => {
    const paneIds = new Set(readSettingsPanes().map(p => p.value));
    for (const id of readSectionIds()) {
      if (SECTIONS_WITHOUT_A_PANE.has(id)) continue;
      assert.ok(paneIds.has(id), `section-${id} exists in settings.js but no SETTINGS_PANES pane opens it`);
    }
  });

  it('does not contain stale section IDs (features, peeks, slides, groups)', () => {
    const paneIds = new Set(readSettingsPanes().map(p => p.value));
    for (const id of STALE_PANE_IDS) {
      assert.ok(!paneIds.has(id), `SETTINGS_PANES contains stale section '${id}' — it has no section-${id} element in settings.js`);
    }
  });

  it('contains no duplicate pane values', () => {
    const seen = new Set();
    for (const pane of readSettingsPanes()) {
      assert.ok(!seen.has(pane.value), `Duplicate pane value '${pane.value}' in SETTINGS_PANES`);
      seen.add(pane.value);
    }
  });

  it('every pane has non-empty title and subtitle', () => {
    for (const pane of readSettingsPanes()) {
      assert.ok(pane.title && pane.title.length > 0, `Pane '${pane.value}' missing title`);
      assert.ok(pane.subtitle && pane.subtitle.length > 0, `Pane '${pane.value}' missing subtitle`);
    }
  });
});
