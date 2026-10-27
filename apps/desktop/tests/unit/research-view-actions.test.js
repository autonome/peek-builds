/**
 * What a research view row does when it is activated: the decisions in
 * `features/research/actions.js`, which are the whole of the choice each row
 * makes. `home.js` keeps only the call each decision turns into.
 *
 *   NODE_ENV=test node --test apps/desktop/tests/unit/research-view-actions.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  urlKey, planPageActivation, searchQueryOf, noteTitleOf, planNoteSave,
} from '../../features/research/actions.js';

describe('urlKey', () => {
  test('matches two spellings of the same page', () => {
    assert.equal(urlKey('https://Example.COM/a/'), urlKey('https://example.com/a'));
  });

  test('ignores the fragment, which names a place on one page rather than a page', () => {
    assert.equal(urlKey('https://example.com/a#top'), urlKey('https://example.com/a'));
  });

  test('keeps the query, which can name a different page altogether', () => {
    assert.notEqual(urlKey('https://example.com/s?q=setts'), urlKey('https://example.com/s?q=diet'));
  });

  test('treats + and %20 in the query as the same space', () => {
    assert.equal(
      urlKey('https://kagi.com/search?q=cat+pictures'),
      urlKey('https://kagi.com/search?q=cat%20pictures'),
    );
  });

  test('ignores query parameter order', () => {
    assert.equal(urlKey('https://example.com/s?a=1&b=2'), urlKey('https://example.com/s?b=2&a=1'));
  });

  test('raises the window open on the %20 spelling from the + spelling', () => {
    const open = new Map([[urlKey('https://kagi.com/search?q=cat%20pictures'), 9]]);
    assert.equal(planPageActivation('https://kagi.com/search?q=cat+pictures', open).kind, 'raise');
  });

  test('answers the empty string for anything that is not a URL', () => {
    assert.equal(urlKey(''), '');
    assert.equal(urlKey(null), '');
    assert.equal(urlKey(undefined), '');
    assert.equal(urlKey(42), '');
  });

  test('falls back to the text it was given when it does not parse as a URL', () => {
    assert.equal(urlKey('NOT a url'), 'not a url');
  });
});

describe('planPageActivation', () => {
  test('raises the window the page is already open in', () => {
    const open = new Map([[urlKey('https://example.com/a'), 7]]);
    assert.deepEqual(planPageActivation('https://example.com/a', open), {
      kind: 'raise', windowId: 7, url: 'https://example.com/a',
    });
  });

  test('raises it for a URL that only differs in the form two spellings share', () => {
    const open = new Map([[urlKey('https://example.com/a'), 7]]);
    const plan = planPageActivation('https://EXAMPLE.com/a/#top', open);
    assert.equal(plan.kind, 'raise');
    assert.equal(plan.windowId, 7);
  });

  test('opens a page that is in no window', () => {
    const open = new Map([[urlKey('https://example.com/a'), 7]]);
    assert.deepEqual(planPageActivation('https://example.com/b', open), {
      kind: 'open', url: 'https://example.com/b',
    });
  });

  test('opens when nothing is known about the open windows', () => {
    assert.deepEqual(planPageActivation('https://example.com/b'), {
      kind: 'open', url: 'https://example.com/b',
    });
    assert.deepEqual(planPageActivation('https://example.com/b', new Map()), {
      kind: 'open', url: 'https://example.com/b',
    });
  });

  test('reads the open windows from a plain object as readily as a Map', () => {
    const open = { [urlKey('https://example.com/a')]: 7 };
    assert.equal(planPageActivation('https://example.com/a', open).windowId, 7);
  });

  test('does nothing for a row carrying no URL, rather than opening the empty string', () => {
    assert.deepEqual(planPageActivation('', new Map()), { kind: 'none' });
    assert.deepEqual(planPageActivation(null, new Map()), { kind: 'none' });
  });

  test('opens rather than raising when the recorded window id is not a window id', () => {
    const open = new Map([[urlKey('https://example.com/a'), 'seven']]);
    assert.equal(planPageActivation('https://example.com/a', open).kind, 'open');
  });
});

describe('searchQueryOf', () => {
  test('is the round item\'s content, which is the query', () => {
    assert.equal(searchQueryOf({ id: 'a', content: 'badger sett depth' }), 'badger sett depth');
  });

  test('trims, so a query stored with space around it runs as itself', () => {
    assert.equal(searchQueryOf({ id: 'a', content: '  badger diet \n' }), 'badger diet');
  });

  test('answers null for a round with no query left to run', () => {
    assert.equal(searchQueryOf({ id: 'a', content: '   ' }), null);
    assert.equal(searchQueryOf({ id: 'a' }), null);
    assert.equal(searchQueryOf(null), null);
  });
});

describe('noteTitleOf', () => {
  test('is the first line', () => {
    assert.equal(noteTitleOf('setts are reused\nfor generations'), 'setts are reused');
  });

  test('drops the leading hashes of a heading', () => {
    assert.equal(noteTitleOf('## Setts\nmore'), 'Setts');
  });

  test('trims what is left', () => {
    assert.equal(noteTitleOf('  spaced  \nmore'), 'spaced');
  });

  test('is the empty string for nothing to title', () => {
    assert.equal(noteTitleOf(''), '');
    assert.equal(noteTitleOf(null), '');
  });
});

describe('planNoteSave', () => {
  const note = { id: 'n1', content: 'setts are reused' };

  test('writes the new text, and a title the row reads as that text', () => {
    assert.deepEqual(planNoteSave(note, 'setts are reused for generations'), {
      itemId: 'n1',
      fields: { content: 'setts are reused for generations', title: 'setts are reused for generations' },
    });
  });

  test('trims what was typed', () => {
    assert.equal(planNoteSave(note, '  latrines  ').fields.content, 'latrines');
  });

  test('titles a note written as a heading by its heading', () => {
    assert.deepEqual(planNoteSave(note, '# Setts\nreused for generations').fields, {
      content: '# Setts\nreused for generations',
      title: 'Setts',
    });
  });

  test('writes nothing when the text did not change', () => {
    assert.equal(planNoteSave(note, 'setts are reused'), null);
  });

  test('writes nothing when only the space around the text changed', () => {
    assert.equal(planNoteSave(note, '  setts are reused  '), null);
  });

  test('leaves an emptied note as it was, because this view does not delete notes', () => {
    assert.equal(planNoteSave(note, ''), null);
    assert.equal(planNoteSave(note, '   '), null);
  });

  test('writes nothing for a note with no item to write to', () => {
    assert.equal(planNoteSave(null, 'text'), null);
    assert.equal(planNoteSave({}, 'text'), null);
  });

  test('writes the text of a note that had none', () => {
    assert.deepEqual(planNoteSave({ id: 'n2' }, 'first words').fields, {
      content: 'first words', title: 'first words',
    });
  });
});
