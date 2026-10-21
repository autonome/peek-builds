/**
 * Unit tests for features/connectory/events.js — reading an organizer's iCal
 * calendar or feed entries as events, and deciding which of them have not been
 * saved before.
 *
 * Run via: node --test tests/unit/connectory-events.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  EVENT_NEW_QUERY,
  EVENT_NEW_TAG,
  EVENT_SOURCE_TAG,
  SEEN_PER_SOURCE_LIMIT,
  eventIdentity,
  eventMetadata,
  eventsFromFeedEntries,
  looksLikeICal,
  parseICal,
  planNewEvents,
} = await import(join(__dirname, '../../features/connectory/events.js'));

const fixture = name => readFileSync(join(__dirname, 'fixtures/connectory', name), 'utf8');

/** Every fixture date is in 2026 or later, so they are all still to come here. */
const NOW = Date.parse('2026-01-01T00:00:00Z');

/** An event as either parser hands it over. */
function event(fields) {
  return {
    uid: '',
    title: '',
    startDate: '',
    endDate: '',
    location: '',
    url: '',
    rrule: '',
    publishedAt: '',
    ...fields,
  };
}

describe('looksLikeICal', () => {
  it('reads the kind off the body, not the URL', () => {
    assert.equal(looksLikeICal(fixture('utc.ics')), true);
    assert.equal(looksLikeICal('<?xml version="1.0"?><feed></feed>'), false);
  });

  it('accepts leading whitespace before BEGIN:VCALENDAR', () => {
    assert.equal(looksLikeICal('\r\n  \n BEGIN:VCALENDAR\r\nEND:VCALENDAR'), true);
  });

  it('refuses a body that only mentions a calendar further down', () => {
    assert.equal(looksLikeICal('Not a calendar\nBEGIN:VCALENDAR'), false);
  });
});

describe('parseICal', () => {
  it('joins folded continuation lines, space or tab', () => {
    const [found] = parseICal(fixture('folded.ics'));
    assert.equal(found.title, 'A very long event name that the calendar wrapped across two lines');
    assert.equal(found.location, 'The Hallway Stage');
    assert.equal(found.url, 'https://example.org/events/folded-1');
  });

  it('keeps the wall-clock time of a TZID start, with no offset', () => {
    const [found] = parseICal(fixture('tzid.ics'));
    assert.equal(found.uid, 'tzid-1@example.org');
    assert.equal(found.startDate, '2026-02-20T19:00:00');
    assert.equal(found.endDate, '2026-02-20T21:30:00');
  });

  it('keeps the Z of a UTC start', () => {
    const [found] = parseICal(fixture('utc.ics'));
    assert.equal(found.startDate, '2026-03-01T17:30:00Z');
    assert.equal(found.endDate, '2026-03-01T19:00:00Z');
  });

  it('leaves an all-day event a date with no time', () => {
    const [found] = parseICal(fixture('all-day.ics'));
    assert.equal(found.startDate, '2026-07-04');
    assert.equal(found.endDate, '2026-07-05');
  });

  it('unescapes commas, semicolons and newlines in text', () => {
    const [found] = parseICal(fixture('escaped.ics'));
    assert.equal(found.title, 'Jazz, Funk and Soul; a night out');
    assert.equal(found.location, '12 Rua do Norte, Lisbon\nSecond floor, ring the bell');
  });

  it('finds no events in a calendar that holds none', () => {
    assert.deepEqual(parseICal(fixture('no-events.ics')), []);
  });

  it('ignores a VTODO, and a VALARM nested in an event', () => {
    const found = parseICal(fixture('with-vtodo.ics'));
    assert.equal(found.length, 1);
    assert.equal(found[0].uid, 'doors-1@example.org');
    // The VALARM's own SUMMARY must not land on the event.
    assert.equal(found[0].title, 'Doors open');
    assert.equal(found[0].location, 'The Back Room');
  });

  it('keeps an RRULE as written', () => {
    const [recurring] = parseICal(fixture('recurring.ics'));
    assert.equal(recurring.uid, 'open-mic@example.org');
    assert.equal(recurring.rrule, 'FREQ=WEEKLY;INTERVAL=1');
  });

  it('reads a calendar written with CRLF line endings', () => {
    const found = parseICal(fixture('utc.ics').replace(/\n/g, '\r\n'));
    assert.equal(found.length, 1);
    assert.equal(found[0].startDate, '2026-03-01T17:30:00Z');
  });

  it('finds nothing in a body that is not a calendar', () => {
    assert.deepEqual(parseICal('hello'), []);
    assert.deepEqual(parseICal(''), []);
  });
});

describe('eventsFromFeedEntries', () => {
  it('takes an entry with a guid as that guid', () => {
    const [found] = eventsFromFeedEntries([{
      id: 'https://example.org/?p=41',
      title: 'Saturday night',
      link: 'https://example.org/saturday',
      published: 'Mon, 05 Jan 2026 10:00:00 GMT',
    }]);
    assert.equal(found.uid, 'https://example.org/?p=41');
    assert.equal(found.title, 'Saturday night');
    assert.equal(found.url, 'https://example.org/saturday');
    assert.equal(found.publishedAt, '2026-01-05T10:00:00.000Z');
    // A feed entry carries no event date, so only publishedAt is kept.
    assert.equal(found.startDate, '');
    assert.equal(found.endDate, '');
  });

  it('takes an entry with only a link as that link', () => {
    const [found] = eventsFromFeedEntries([{ title: 'Sunday', link: 'https://example.org/sunday' }]);
    assert.equal(found.uid, '');
    assert.equal(found.url, 'https://example.org/sunday');
    assert.equal(eventIdentity(found), 'https://example.org/sunday');
  });

  it('takes an entry with neither by its title', () => {
    const [found] = eventsFromFeedEntries([{ title: 'Unnumbered night' }]);
    assert.equal(found.uid, '');
    assert.equal(found.url, '');
    assert.equal(eventIdentity(found), 'Unnumbered night|');
  });

  it('leaves publishedAt empty when the entry has no date it can read', () => {
    const [none, nonsense] = eventsFromFeedEntries([{ title: 'a' }, { title: 'b', published: 'soon' }]);
    assert.equal(none.publishedAt, '');
    assert.equal(nonsense.publishedAt, '');
  });

  it('passes over anything that is not an entry', () => {
    assert.deepEqual(eventsFromFeedEntries([null, 'x', 7]), []);
    assert.deepEqual(eventsFromFeedEntries(undefined), []);
  });
});

describe('eventIdentity', () => {
  it('prefers the uid over the link and the title', () => {
    assert.equal(eventIdentity(event({
      uid: 'uid-1',
      url: 'https://example.org/a',
      title: 'A',
      startDate: '2026-05-01',
    })), 'uid-1');
  });

  it('falls back to the link when there is no uid', () => {
    assert.equal(eventIdentity(event({
      url: 'https://example.org/a',
      title: 'A',
      startDate: '2026-05-01',
    })), 'https://example.org/a');
  });

  it('falls back to the title plus the start when there is neither', () => {
    assert.equal(eventIdentity(event({ title: 'A', startDate: '2026-05-01' })), 'A|2026-05-01');
  });

  it('has no identity for an event with nothing to go by', () => {
    assert.equal(eventIdentity(event({})), '');
    assert.equal(eventIdentity(null), '');
  });
});

describe('planNewEvents', () => {
  it('saves an event it has not seen, carrying its identity and its source', () => {
    const events = parseICal(fixture('utc.ics'));
    const { toSave, seen } = planNewEvents('src-1', events, [], NOW);
    assert.equal(toSave.length, 1);
    assert.equal(toSave[0].uid, 'utc-1@example.org');
    assert.equal(toSave[0].sourceItemId, 'src-1');
    assert.deepEqual(seen, ['utc-1@example.org']);
  });

  it('does not save an event already seen, and keeps it in the seen list', () => {
    const events = parseICal(fixture('utc.ics'));
    const { toSave, seen } = planNewEvents('src-1', events, ['utc-1@example.org'], NOW);
    assert.deepEqual(toSave, []);
    assert.deepEqual(seen, ['utc-1@example.org']);
  });

  it('does not save an event whose end has passed', () => {
    const over = event({ uid: 'over', startDate: '2025-12-30T19:00:00', endDate: '2025-12-30T21:00:00' });
    const { toSave, seen } = planNewEvents('src-1', [over], [], NOW);
    assert.deepEqual(toSave, []);
    // A past event takes no place in the list, so it never crowds out a new one.
    assert.deepEqual(seen, []);
  });

  it('does not save an event whose start has passed and that names no end', () => {
    const over = event({ uid: 'over', startDate: '2025-12-30T19:00:00' });
    assert.deepEqual(planNewEvents('src-1', [over], [], NOW).toSave, []);
  });

  it('saves an all-day event on the day it names, and not the day after', () => {
    const noon = Date.parse('2026-01-01T12:00:00');
    const today = event({ uid: 'today', startDate: '2026-01-01' });
    const yesterday = event({ uid: 'yesterday', startDate: '2025-12-31' });
    assert.equal(planNewEvents('src-1', [today], [], noon).toSave.length, 1);
    assert.deepEqual(planNewEvents('src-1', [yesterday], [], noon).toSave, []);
  });

  it('saves an undated feed entry whatever the time', () => {
    const entry = eventsFromFeedEntries([{ id: 'e-1', title: 'Night' }])[0];
    assert.equal(planNewEvents('src-1', [entry], [], NOW).toSave.length, 1);
  });

  it('saves a recurring event once, as its first occurrence still to come', () => {
    const events = parseICal(fixture('recurring.ics'));
    const { toSave, seen } = planNewEvents('src-1', events, [], NOW);
    // The weekly event is saved and last year's one-off is not.
    assert.deepEqual(toSave.map(e => e.uid), ['open-mic@example.org']);
    // DTSTART is a Tuesday in January 2025; the occurrence keeps the weekday
    // and the time of day, and lands after NOW.
    assert.equal(toSave[0].startDate, '2026-01-06T20:30:00');
    assert.equal(toSave[0].endDate, '2026-01-06T22:30:00');
    assert.deepEqual(seen, ['open-mic@example.org']);

    // The second check knows it, so the series is not saved again.
    assert.deepEqual(planNewEvents('src-1', events, seen, NOW).toSave, []);
  });

  it('saves a recurring event whose series has not started yet at its DTSTART', () => {
    const later = event({
      uid: 'later',
      startDate: '2026-06-01T18:00:00',
      rrule: 'FREQ=MONTHLY',
    });
    const { toSave } = planNewEvents('src-1', [later], [], NOW);
    assert.equal(toSave[0].startDate, '2026-06-01T18:00:00');
  });

  it('does not save a recurring event whose UNTIL has passed', () => {
    const ended = event({
      uid: 'ended',
      startDate: '2025-01-07T20:30:00',
      rrule: 'FREQ=WEEKLY;UNTIL=20250601T000000Z',
    });
    assert.deepEqual(planNewEvents('src-1', [ended], [], NOW).toSave, []);
  });

  it('does not save a recurring event whose COUNT is used up', () => {
    const ended = event({
      uid: 'ended',
      startDate: '2025-01-07T20:30:00',
      rrule: 'FREQ=WEEKLY;COUNT=4',
    });
    assert.deepEqual(planNewEvents('src-1', [ended], [], NOW).toSave, []);
  });

  it('keeps a yearly series going, on its own date', () => {
    const yearly = event({
      uid: 'yearly',
      startDate: '2019-08-15T10:00:00',
      rrule: 'FREQ=YEARLY',
    });
    const { toSave } = planNewEvents('src-1', [yearly], [], NOW);
    assert.equal(toSave[0].startDate, '2026-08-15T10:00:00');
  });

  it('matches the identity fallback order when deciding what it has seen', () => {
    const byLink = event({ url: 'https://example.org/a', title: 'A', startDate: '2026-05-01' });
    const byTitle = event({ title: 'B', startDate: '2026-05-02' });
    assert.deepEqual(
      planNewEvents('src-1', [byLink, byTitle], ['https://example.org/a'], NOW).toSave.map(e => e.uid),
      ['B|2026-05-02'],
    );
    assert.deepEqual(
      planNewEvents('src-1', [byLink, byTitle], ['B|2026-05-02'], NOW).toSave.map(e => e.uid),
      ['https://example.org/a'],
    );
  });

  it('passes over an event with no identity at all', () => {
    assert.deepEqual(planNewEvents('src-1', [event({ startDate: '' })], [], NOW).toSave, []);
  });

  it('saves one event per identity when a source repeats it', () => {
    const twice = [event({ uid: 'u-1', startDate: '2026-05-01' }), event({ uid: 'u-1', startDate: '2026-05-01' })];
    const { toSave, seen } = planNewEvents('src-1', twice, [], NOW);
    assert.equal(toSave.length, 1);
    assert.deepEqual(seen, ['u-1']);
  });

  it(`keeps the newest ${SEEN_PER_SOURCE_LIMIT} identities and drops the oldest`, () => {
    const stored = Array.from({ length: SEEN_PER_SOURCE_LIMIT }, (_, i) => `old-${i}`);
    const fresh = ['n-1', 'n-2', 'n-3'].map(uid => event({ uid, startDate: '2026-05-01' }));
    const { toSave, seen } = planNewEvents('src-1', fresh, stored, NOW);
    assert.equal(toSave.length, 3);
    assert.equal(seen.length, SEEN_PER_SOURCE_LIMIT);
    assert.deepEqual(seen.slice(0, 3), ['n-1', 'n-2', 'n-3']);
    assert.equal(seen[3], 'old-0');
    assert.equal(seen[SEEN_PER_SOURCE_LIMIT - 1], `old-${SEEN_PER_SOURCE_LIMIT - 4}`);
    assert.equal(seen.includes(`old-${SEEN_PER_SOURCE_LIMIT - 1}`), false);
  });

  it('survives a source that parsed to nothing', () => {
    assert.deepEqual(planNewEvents('src-1', [], ['u-1'], NOW), { toSave: [], seen: ['u-1'] });
    assert.deepEqual(planNewEvents('src-1', undefined, undefined, NOW), { toSave: [], seen: [] });
  });
});

describe('eventMetadata', () => {
  it('names the attributes structured-data.js gives an event entity', () => {
    const [found] = parseICal(fixture('tzid.ics'));
    assert.deepEqual(eventMetadata({ ...found, uid: found.uid, sourceItemId: 'src-1' }), {
      uid: 'tzid-1@example.org',
      sourceItemId: 'src-1',
      title: 'Evening in Lisbon',
      startDate: '2026-02-20T19:00:00',
      endDate: '2026-02-20T21:30:00',
      location: 'Praca do Comercio',
    });
  });

  it('leaves out an attribute the source did not give', () => {
    const entry = eventsFromFeedEntries([{
      id: 'e-1',
      title: 'Night',
      published: '2026-01-05T10:00:00Z',
    }])[0];
    assert.deepEqual(eventMetadata({ ...entry, sourceItemId: 'src-2' }), {
      uid: 'e-1',
      sourceItemId: 'src-2',
      title: 'Night',
      publishedAt: '2026-01-05T10:00:00.000Z',
    });
  });
});

describe('the tags and the query the feature surfaces through', () => {
  it('are the ones the spec names', () => {
    assert.equal(EVENT_SOURCE_TAG, 'event:source');
    assert.equal(EVENT_NEW_TAG, 'event:new');
    assert.equal(EVENT_NEW_QUERY, '#event:new');
  });
});
