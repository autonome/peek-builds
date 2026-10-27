import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT } from '../../renderer/lib/card-size.js';

test('the default card size is positive', () => {
  assert.ok(DEFAULT_CARD_WIDTH > 0);
  assert.ok(DEFAULT_CARD_HEIGHT > 0);
});

test('the sheet window and the shared card grid take their size from card-size.js', () => {
  const sheet = readFileSync(new URL('../../features/sheets/sheet.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../renderer/lib/card-view.js', import.meta.url), 'utf8');
  assert.match(sheet, /SLOT_W = DEFAULT_CARD_WIDTH/);
  assert.match(sheet, /SLOT_H = DEFAULT_CARD_HEIGHT/);
  assert.match(view, /String\(DEFAULT_CARD_WIDTH\)/);
  assert.match(view, /DEFAULT_CARD_HEIGHT/);
});
