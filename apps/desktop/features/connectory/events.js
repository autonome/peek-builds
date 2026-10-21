/**
 * Connectory event logic — pure, no `api`, no window, no DOM, so a peeklet can
 * run it somewhere other than the desktop.
 *
 * An item tagged `event:source` holds the URL of an organizer's calendar or
 * event feed. The kind of source is read from the response body rather than the
 * URL: a body starting with `BEGIN:VCALENDAR` is iCal and goes through
 * `parseICal`, anything else is handed to an RSS/Atom parser and its entries
 * come back here through `eventsFromFeedEntries`. Both produce the same event
 * shape, so `planNewEvents` decides what is new without knowing which kind of
 * source it came from.
 *
 * An event's identity is its iCal `UID`, else the feed entry's `guid`/`id`,
 * else its link, else its title plus its start. The identities already saved
 * are kept per source by the caller, so removing `event:new` from an event
 * dismisses it for good.
 */

/** Tag naming an item whose URL is an event source. */
export const EVENT_SOURCE_TAG = 'event:source';

/** Tag an event carries until it is dismissed. */
export const EVENT_NEW_TAG = 'event:new';

/** The query the `events` command opens the search window on. */
export const EVENT_NEW_QUERY = '#event:new';

/** Identities kept per source. Older ones fall off and could be saved again. */
export const SEEN_PER_SOURCE_LIMIT = 500;

/** Title given to an event whose source left it unnamed. */
export const UNTITLED_EVENT = 'Untitled event';

const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Recurrence frequencies projected by whole periods of the written date. */
const PERIOD_MS = {
  DAILY: DAY_MS,
  WEEKLY: 7 * DAY_MS,
  MONTHLY: 30.436875 * DAY_MS,
  YEARLY: 365.2425 * DAY_MS,
};

/**
 * Periods tried past the first estimate when projecting a recurrence. The
 * estimate lands within a step or two of the answer, so this only has to cover
 * an interval the estimate misjudges, never the whole history of the series.
 */
const MAX_PROJECTION_STEPS = 400;

/** Is this body an iCal calendar? Read from the body, never from the URL. */
export function looksLikeICal(text) {
  return /^\s*BEGIN:VCALENDAR/i.test(String(text ?? ''));
}

/**
 * Content lines, with folded continuations joined back on. A line starting
 * with a space or tab continues the one before it (RFC 5545 §3.1).
 */
function unfold(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
    if (lines.length > 0 && /^[ \t]/.test(raw)) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

/** `DTSTART;TZID=Europe/Lisbon:20260115T183000` → name, params, value. */
function splitLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const parts = line.slice(0, colon).split(';');
  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase().trim(), params, value: line.slice(colon + 1) };
}

/** `\,` `\;` `\\` and `\n` in a TEXT value (RFC 5545 §3.3.11). */
function unescapeText(value) {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\') {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    i += 1;
    if (next === undefined) out += '\\';
    else if (next === 'n' || next === 'N') out += '\n';
    else out += next;
  }
  return out;
}

/**
 * An iCal date or date-time as an ISO 8601 string.
 *
 * `20260115` stays a date with no time, `20260115T183000Z` keeps its `Z`, and a
 * time carrying a `TZID` keeps the wall-clock time the calendar wrote with no
 * offset: naming the zone would need a timezone database the job does not have,
 * and the written time is what the organizer means.
 */
function icalDateToIso(value) {
  const text = String(value ?? '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(text);
  if (!stamp) return '';
  const base = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6] || '00'}`;
  return stamp[7] ? `${base}Z` : base;
}

/** The event shape both sources produce. Every key is present, `''` when absent. */
function emptyEvent() {
  return {
    uid: '',
    title: '',
    startDate: '',
    endDate: '',
    location: '',
    url: '',
    rrule: '',
    publishedAt: '',
  };
}

/**
 * The `VEVENT`s of an iCal calendar. Other components — `VTODO`, `VTIMEZONE`,
 * a `VALARM` nested in an event — are skipped, so their own `SUMMARY` or
 * `DTSTART` never leaks into an event.
 */
export function parseICal(text) {
  const events = [];
  const components = [];
  let current = null;

  for (const line of unfold(text)) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, value } = parsed;

    if (name === 'BEGIN') {
      components.push(value.toUpperCase().trim());
      if (components[components.length - 1] === 'VEVENT') current = emptyEvent();
      continue;
    }
    if (name === 'END') {
      const ended = components.pop();
      if (ended === 'VEVENT' && current) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || components[components.length - 1] !== 'VEVENT') continue;

    switch (name) {
      case 'UID':
        current.uid = value.trim();
        break;
      case 'SUMMARY':
        current.title = unescapeText(value).trim();
        break;
      case 'LOCATION':
        current.location = unescapeText(value).trim();
        break;
      case 'URL':
        current.url = value.trim();
        break;
      case 'DTSTART':
        current.startDate = icalDateToIso(value);
        break;
      case 'DTEND':
        current.endDate = icalDateToIso(value);
        break;
      case 'RRULE':
        current.rrule = value.trim();
        break;
      default:
        break;
    }
  }

  return events;
}

/** A date the feed wrote, as an ISO 8601 string. */
function publishedToIso(published) {
  if (published === undefined || published === null || published === '') return '';
  const ms = typeof published === 'number' ? published : Date.parse(String(published));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Already-parsed feed entries (`{ id, title, link, published }`) as events.
 *
 * A feed tagged `event:source` is by that tag an organizer's event feed, so
 * every entry is an event. An entry carries no event date, so `startDate` stays
 * absent and only `publishedAt` is kept.
 */
export function eventsFromFeedEntries(entries) {
  const events = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const event = emptyEvent();
    if (typeof entry.id === 'string') event.uid = entry.id.trim();
    if (typeof entry.title === 'string') event.title = entry.title.trim();
    if (typeof entry.link === 'string') event.url = entry.link.trim();
    event.publishedAt = publishedToIso(entry.published);
    events.push(event);
  }
  return events;
}

/**
 * What an event is known by: its iCal `UID`, else the feed entry's `guid`/`id`,
 * else its link, else its title plus its start. An entry with none of those —
 * no id, no link, no title and no start — has no identity and cannot be
 * tracked, so it returns `''` and `planNewEvents` passes it over.
 */
export function eventIdentity(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.uid) return event.uid;
  if (event.url) return event.url;
  const title = event.title || '';
  const startDate = event.startDate || '';
  if (!title && !startDate) return '';
  return `${title}|${startDate}`;
}

function startMs(iso) {
  if (!iso) return NaN;
  const ms = DATE_ONLY_RE.test(iso) ? Date.parse(`${iso}T00:00:00`) : Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * When an event stops being still to come: its end, else its start. An all-day
 * event with no end runs to the end of the day it names; an all-day `DTEND` is
 * already the day after the last one (RFC 5545 §3.6.1), so it stands as it is.
 */
function overMs(event) {
  const end = startMs(event.endDate);
  if (Number.isFinite(end)) return end;
  const start = startMs(event.startDate);
  if (!Number.isFinite(start)) return NaN;
  return DATE_ONLY_RE.test(event.startDate) ? start + DAY_MS : start;
}

function isPast(event, now) {
  const over = overMs(event);
  return Number.isFinite(over) && over <= now;
}

/** `FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T235959Z` → the parts projection needs. */
function parseRRule(rrule) {
  const rule = { freq: '', interval: 1, count: 0, untilMs: NaN };
  for (const part of String(rrule ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toUpperCase().trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'FREQ') rule.freq = value.toUpperCase();
    else if (key === 'INTERVAL') {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1) rule.interval = n;
    } else if (key === 'COUNT') {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1) rule.count = n;
    } else if (key === 'UNTIL') {
      rule.untilMs = startMs(icalDateToIso(value));
    }
  }
  return rule;
}

/**
 * An ISO date-time moved on by whole periods, keeping the time of day and the
 * form it was written in. Moving the written date rather than a millisecond
 * count is what makes a weekly 18:30 event stay at 18:30 across a DST change.
 */
function shiftIsoByPeriods(iso, freq, periods) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(iso || '');
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  let shifted;
  if (freq === 'DAILY') shifted = new Date(Date.UTC(year, month, day + periods));
  else if (freq === 'WEEKLY') shifted = new Date(Date.UTC(year, month, day + periods * 7));
  else if (freq === 'MONTHLY') shifted = new Date(Date.UTC(year, month + periods, day));
  else if (freq === 'YEARLY') shifted = new Date(Date.UTC(year + periods, month, day));
  else return '';
  const pad = (n, width) => String(n).padStart(width, '0');
  return [
    pad(shifted.getUTCFullYear(), 4),
    pad(shifted.getUTCMonth() + 1, 2),
    pad(shifted.getUTCDate(), 2),
  ].join('-') + match[4];
}

/**
 * A recurring event as its first occurrence still to come, or `null` when the
 * series is over.
 *
 * Expanding recurrences is out of scope, so the projection steps whole periods
 * of `FREQ` and `INTERVAL` and ignores the `BY*` parts that would refine an
 * occurrence within its period — a weekly event keeps the weekday its `DTSTART`
 * names. A frequency finer than a day, or one that does not parse, leaves the
 * event at its `DTSTART` and saves it, since a series recurring that often
 * always has an occurrence to come.
 */
function projectRecurrence(event, now) {
  const rule = parseRRule(event.rrule);
  const stepMs = PERIOD_MS[rule.freq];
  if (!stepMs) return event;

  const over = overMs(event);
  const behind = Number.isFinite(over) && over <= now ? (now - over) / (stepMs * rule.interval) : 0;
  const firstStep = Math.max(0, Math.floor(behind) - 2);
  const lastStep = rule.count ? rule.count - 1 : firstStep + MAX_PROJECTION_STEPS;

  for (let step = firstStep; step <= lastStep; step += 1) {
    const startDate = shiftIsoByPeriods(event.startDate, rule.freq, step * rule.interval);
    if (!startDate) return isPast(event, now) ? null : event;
    if (Number.isFinite(rule.untilMs) && startMs(startDate) > rule.untilMs) return null;
    const endDate = event.endDate
      ? shiftIsoByPeriods(event.endDate, rule.freq, step * rule.interval)
      : '';
    const occurrence = { ...event, startDate, endDate };
    if (!isPast(occurrence, now)) return occurrence;
  }
  return null;
}

/**
 * The occurrence of an event worth saving, or `null` when there is none: an
 * event already over, or a recurring one whose series has ended.
 *
 * An undated event — every feed entry — is never over.
 */
function occurrenceStillToCome(event, now) {
  if (!event.startDate) return event;
  if (event.rrule) return projectRecurrence(event, now);
  return isPast(event, now) ? null : event;
}

/**
 * Decide which of a source's events have not been saved before.
 *
 * `seenUids` is the source's stored identity list, newest first. The returned
 * `seen` is that list with the identities now saved put in front and the oldest
 * past `SEEN_PER_SOURCE_LIMIT` dropped.
 *
 * Each saved event carries the identity it was matched by as `uid` and the
 * source it came from as `sourceItemId`, and a recurring event carries the
 * occurrence that is still to come rather than its `DTSTART`.
 *
 * A past event is not recorded as seen: the time test rejects it on every check
 * without taking a place in the list that a new event could use.
 */
export function planNewEvents(sourceItemId, events, seenUids, now) {
  const seen = (Array.isArray(seenUids) ? seenUids : []).filter(uid => typeof uid === 'string' && uid);
  const known = new Set(seen);
  const toSave = [];
  const added = [];

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const uid = eventIdentity(event);
    if (!uid || known.has(uid)) continue;
    const occurrence = occurrenceStillToCome(event, now);
    if (!occurrence) continue;
    known.add(uid);
    added.push(uid);
    toSave.push({ ...occurrence, uid, sourceItemId });
  }

  return { toSave, seen: [...added, ...seen].slice(0, SEEN_PER_SOURCE_LIMIT) };
}

/**
 * The `metadata.event` an event item carries. `startDate`, `endDate` and
 * `location` use the attribute names
 * `features/entities/extractors/structured-data.js` gives `event` entities, so
 * a view over what is on reads both kinds with one shape. An attribute the
 * source did not give is left out rather than written empty.
 */
export function eventMetadata(event) {
  const metadata = {
    uid: event?.uid || '',
    sourceItemId: event?.sourceItemId || '',
    title: event?.title || '',
  };
  if (event?.startDate) metadata.startDate = event.startDate;
  if (event?.endDate) metadata.endDate = event.endDate;
  if (event?.location) metadata.location = event.location;
  if (event?.publishedAt) metadata.publishedAt = event.publishedAt;
  return metadata;
}
