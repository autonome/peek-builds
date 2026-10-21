/**
 * Unit tests for features/lookups/resolve.js — reading a typed title, choosing
 * the Wikidata entity it names, and turning that entity into the item's
 * `metadata.lookup`.
 *
 * The entities and search results come from `fixtures/lookups/`, recorded once
 * from Wikidata by hand. Nothing here reaches the network.
 *
 * Run via: node --test tests/unit/lookups-resolve.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  parseTitle,
  searchAttempts,
  pickCandidate,
  lookupFromEntity,
  unresolvedLookup,
  selectItemsToLookUp,
  lookupTagFor,
  CREATOR_PROPS,
} = await import(join(__dirname, '../../features/lookups/resolve.js'));

const FIXTURES = join(__dirname, 'fixtures/lookups');

const NOW = 1_700_000_000_000;

/** A recorded `wbsearchentities` response, by the term it was recorded for. */
function searchFixture(term) {
  const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const path = join(FIXTURES, 'search', `${slug}.json`);
  assert.ok(existsSync(path), `no recorded search for "${term}"`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The candidate ids a recorded search returned, in the order Wikidata ranked them. */
function searchIds(term) {
  return (searchFixture(term).search || []).map(hit => hit.id);
}

/** A recorded entity, with its claims, sitelinks and label. */
function entity(id) {
  const path = join(FIXTURES, 'entities', `${id}.json`);
  assert.ok(existsSync(path), `no recorded entity ${id}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The candidates for a term, as `pickCandidate` is given them. */
function candidates(term) {
  return searchIds(term).map(entity);
}

/** The creator labels for a set of candidates, as one `wbgetentities` call gives them. */
function labelsFor(entities) {
  const labels = {};
  for (const e of entities) {
    for (const property of CREATOR_PROPS) {
      for (const claim of e.claims?.[property] || []) {
        const id = claim?.mainsnak?.datavalue?.value?.id;
        if (!id) continue;
        const path = join(FIXTURES, 'labels', `${id}.json`);
        if (existsSync(path)) labels[id] = JSON.parse(readFileSync(path, 'utf8'));
      }
    }
  }
  return labels;
}

/** An item as `selectItemsToLookUp` is given it, metadata already parsed. */
function item(type, content, metadata = {}) {
  return { id: content, type, content, metadata };
}

describe('parseTitle', () => {
  it('leaves a bare title alone', () => {
    assert.deepEqual(parseTitle('Clara and the Sun'), { title: 'Clara and the Sun' });
  });

  it('reads the creator after a comma', () => {
    assert.deepEqual(parseTitle('Contact, Carl Sagan'), {
      title: 'Contact',
      creatorHint: 'Carl Sagan',
    });
  });

  it('reads the creator after "by"', () => {
    assert.deepEqual(parseTitle('Beloved by Toni Morrison'), {
      title: 'Beloved',
      creatorHint: 'Toni Morrison',
    });
  });

  it('drops a trailing description', () => {
    assert.deepEqual(parseTitle('The Piano Tuner (about Thai Myanmar border)'), {
      title: 'The Piano Tuner',
      description: 'about Thai Myanmar border',
    });
  });

  it('drops the description before splitting off the creator', () => {
    assert.deepEqual(parseTitle('Contact, Carl Sagan (the novel, not the film)'), {
      title: 'Contact',
      creatorHint: 'Carl Sagan',
      description: 'the novel, not the film',
    });
  });

  it('splits at the first separator, whichever comes first', () => {
    assert.deepEqual(parseTitle('Dune, Frank Herbert by the way'), {
      title: 'Dune',
      creatorHint: 'Frank Herbert by the way',
    });
  });

  it('reads "By" the same as "by"', () => {
    assert.deepEqual(parseTitle('Beloved By Toni Morrison'), {
      title: 'Beloved',
      creatorHint: 'Toni Morrison',
    });
  });

  it('keeps the whole text when a split would leave no title', () => {
    assert.deepEqual(parseTitle(', Carl Sagan'), { title: ', Carl Sagan' });
  });

  it('keeps the whole text when a split would leave no creator', () => {
    assert.deepEqual(parseTitle('Contact by '), { title: 'Contact by' });
  });

  it('answers an empty title for text it cannot read', () => {
    assert.deepEqual(parseTitle(''), { title: '' });
    assert.deepEqual(parseTitle(undefined), { title: '' });
  });
});

describe('searchAttempts', () => {
  it('searches a bare title once', () => {
    assert.deepEqual(searchAttempts('Clara and the Sun'), [
      { term: 'Clara and the Sun', creatorHint: undefined },
    ]);
  });

  it('searches the split title first and the whole text second', () => {
    assert.deepEqual(searchAttempts('Stand by Me'), [
      { term: 'Stand', creatorHint: 'Me' },
      { term: 'Stand by Me' },
    ]);
  });

  it('drops the description from both attempts', () => {
    assert.deepEqual(searchAttempts('Contact, Carl Sagan (the novel)'), [
      { term: 'Contact', creatorHint: 'Carl Sagan' },
      { term: 'Contact, Carl Sagan' },
    ]);
  });

  it('has nothing to search for empty text', () => {
    assert.deepEqual(searchAttempts('   '), []);
  });
});

describe('pickCandidate', () => {
  it('takes the first candidate whose class the tag accepts', () => {
    const entities = candidates('Stand by Me');
    const chosen = pickCandidate('to-watch', entities, undefined, labelsFor(entities));
    // Two results rank above it, a sound recording and a creative work.
    assert.equal(entities[0].id, 'Q122341926');
    assert.equal(chosen.id, 'Q494722');
  });

  it('passes over non-matching results to reach the tag\'s class', () => {
    const entities = candidates('The Expanse');
    // The video game ranks first and the TV series second; neither is read.
    assert.equal(entities[0].id, 'Q110029348');
    const chosen = pickCandidate('to-read', entities, undefined, labelsFor(entities));
    assert.equal(chosen.id, 'Q7732812');
  });

  it('prefers a candidate whose creator answers the hint', () => {
    const entities = candidates('Arrival');
    const labels = labelsFor(entities);
    // Without a hint the Journey album wins on search order.
    assert.equal(pickCandidate('to-listen', entities, undefined, labels).id, 'Q2578989');
    // With one, the ABBA album does.
    assert.equal(pickCandidate('to-listen', entities, 'ABBA', labels).id, 'Q162392');
  });

  it('matches a creator hint whatever its case', () => {
    const entities = candidates('Arrival');
    const chosen = pickCandidate('to-listen', entities, 'abba', labelsFor(entities));
    assert.equal(chosen.id, 'Q162392');
  });

  it('keeps search order when no candidate answers the hint', () => {
    const entities = candidates('Arrival');
    const chosen = pickCandidate('to-listen', entities, 'Nobody At All', labelsFor(entities));
    assert.equal(chosen.id, 'Q2578989');
  });

  it('honours each tag\'s own class set over the same candidates', () => {
    const entities = candidates('The Expanse');
    const labels = labelsFor(entities);
    assert.equal(pickCandidate('to-watch', entities, undefined, labels).id, 'Q18389644');
    assert.equal(pickCandidate('to-read', entities, undefined, labels).id, 'Q7732812');
    assert.equal(pickCandidate('to-listen', entities, undefined, labels), null);
  });

  it('refuses a work of the wrong kind for the tag', () => {
    // The 1986 film, asked for as something to read.
    assert.equal(pickCandidate('to-read', [entity('Q494722')], undefined, {}), null);
  });

  it('answers null when nothing matches', () => {
    const entities = candidates('Stand');
    assert.equal(pickCandidate('to-watch', entities, undefined, labelsFor(entities)), null);
  });

  it('answers null for no candidates and for an unknown tag', () => {
    assert.equal(pickCandidate('to-watch', [], undefined, {}), null);
    assert.equal(pickCandidate('to-visit', candidates('Arrival'), undefined, {}), null);
  });
});

describe('lookupFromEntity', () => {
  it('builds the record for a film, with its Wikipedia page and creator', () => {
    const chosen = entity('Q494722');
    assert.deepEqual(lookupFromEntity(chosen, 'to-watch', labelsFor([chosen]), NOW), {
      wikidataId: 'Q494722',
      label: 'Stand by Me',
      kind: 'film',
      links: {
        wikipedia: 'https://en.wikipedia.org/wiki/Stand_by_Me_(film)',
        tmdb: { type: 'movie', id: '235' },
      },
      resolvedAt: NOW,
      creator: 'Rob Reiner',
    });
  });

  it('types a television series\' TMDB id as tv, and links Prime Video', () => {
    const chosen = entity('Q18389644');
    const lookup = lookupFromEntity(chosen, 'to-watch', labelsFor([chosen]), NOW);
    assert.equal(lookup.kind, 'television series');
    assert.deepEqual(lookup.links.tmdb, { type: 'tv', id: '63639' });
    assert.equal(lookup.links.primeVideo, 'https://www.amazon.com/gp/video/detail/B08MMJTJSH');
  });

  it('builds the Open Library link for a written work', () => {
    const chosen = entity('Q2882166');
    const lookup = lookupFromEntity(chosen, 'to-read', labelsFor([chosen]), NOW);
    assert.equal(lookup.kind, 'written work');
    assert.equal(lookup.links.openLibrary, 'https://openlibrary.org/works/OL5956196W');
    assert.equal(lookup.creator, 'Daniel Mason');
  });

  it('builds the Goodreads link', () => {
    const lookup = lookupFromEntity(entity('Q54826011'), 'to-read', {}, NOW);
    assert.equal(lookup.links.goodreads, 'https://www.goodreads.com/book/show/422909');
  });

  it('builds the MusicBrainz and Spotify links for an album', () => {
    const chosen = entity('Q162392');
    const lookup = lookupFromEntity(chosen, 'to-listen', labelsFor([chosen]), NOW);
    assert.equal(lookup.kind, 'album');
    assert.equal(
      lookup.links.musicbrainz,
      'https://musicbrainz.org/release-group/e464e167-83ab-3b59-88bd-262cf552056e',
    );
    assert.equal(lookup.links.spotify, 'https://open.spotify.com/album/79ZX48114T8NH36MnOTtl7');
    assert.equal(lookup.creator, 'ABBA');
  });

  it('leaves wikipedia out when the entity has no English page', () => {
    const chosen = entity('Q3201414');
    const lookup = lookupFromEntity(chosen, 'to-watch', labelsFor([chosen]), NOW);
    assert.equal(chosen.sitelinks?.enwiki, undefined);
    assert.equal('wikipedia' in lookup.links, false);
    assert.deepEqual(lookup.links.tmdb, { type: 'movie', id: '190681' });
  });

  it('leaves the creator out when no creator label was fetched', () => {
    const lookup = lookupFromEntity(entity('Q494722'), 'to-watch', {}, NOW);
    assert.equal('creator' in lookup, false);
  });
});

describe('unresolvedLookup', () => {
  it('records only that the item was checked', () => {
    assert.deepEqual(unresolvedLookup(NOW), { unresolved: true, checkedAt: NOW });
  });
});

describe('lookupTagFor', () => {
  it('names the lookup tag an item carries', () => {
    assert.equal(lookupTagFor(['todo', 'to-read']), 'to-read');
    assert.equal(lookupTagFor([{ name: 'to-listen' }]), 'to-listen');
  });

  it('names nothing for another to- tag', () => {
    assert.equal(lookupTagFor(['to-visit', 'to-do']), undefined);
  });
});

describe('selectItemsToLookUp', () => {
  it('names a tagged text item', () => {
    const tags = { a: ['to-watch'] };
    const items = { a: item('text', 'Stand by Me') };
    assert.deepEqual(selectItemsToLookUp(tags, items), ['a']);
  });

  it('skips URL and image items', () => {
    const tags = { page: ['to-read'], shot: ['to-watch'], typed: ['to-listen'] };
    const items = {
      page: item('url', 'https://example.com/a-review'),
      shot: item('image', 'poster.png'),
      typed: item('text', 'Arrival'),
    };
    assert.deepEqual(selectItemsToLookUp(tags, items), ['typed']);
  });

  it('skips the other to- tags', () => {
    const tags = { a: ['to-visit'], b: ['to-do'], c: ['to-read'] };
    const items = {
      a: item('text', 'Lisbon'),
      b: item('text', 'Call the dentist'),
      c: item('text', 'Beloved'),
    };
    assert.deepEqual(selectItemsToLookUp(tags, items), ['c']);
  });

  it('skips an item that already carries a lookup', () => {
    const tags = { found: ['to-watch'], unresolved: ['to-watch'], fresh: ['to-watch'] };
    const items = {
      found: item('text', 'Arrival', { lookup: { wikidataId: 'Q20382729' } }),
      unresolved: item('text', 'Clara and the Sun', { lookup: { unresolved: true } }),
      fresh: item('text', 'The Expanse'),
    };
    // Removing lookup:unresolved does not retry it — the metadata is the record.
    assert.deepEqual(selectItemsToLookUp(tags, items), ['fresh']);
  });

  it('keeps other metadata from standing in for a lookup', () => {
    const tags = { a: ['to-read'] };
    const items = { a: item('text', 'Beloved', { reminder: { tag: 'remind:3d', dueAt: NOW } }) };
    assert.deepEqual(selectItemsToLookUp(tags, items), ['a']);
  });

  it('skips a tagged id with no item behind it', () => {
    assert.deepEqual(selectItemsToLookUp({ gone: ['to-read'] }, {}), []);
  });

  it('caps the pass at the limit, in the order given', () => {
    const tags = {};
    const items = {};
    for (let n = 0; n < 25; n += 1) {
      tags[`i${n}`] = ['to-read'];
      items[`i${n}`] = item('text', `Title ${n}`);
    }
    assert.equal(selectItemsToLookUp(tags, items).length, 20);
    assert.deepEqual(selectItemsToLookUp(tags, items, 3), ['i0', 'i1', 'i2']);
  });

  it('accepts tags as records with a name, and a Map of items', () => {
    const tags = new Map([['a', [{ name: 'to-listen' }]]]);
    const items = new Map([['a', item('text', 'Arrival')]]);
    assert.deepEqual(selectItemsToLookUp(tags, items), ['a']);
  });
});
