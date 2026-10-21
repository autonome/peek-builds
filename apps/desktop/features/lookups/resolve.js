/**
 * Lookup job logic — pure, no `api`, no window, no DOM, no network, so a
 * peeklet can run it somewhere other than the desktop.
 *
 * An item tagged `to-watch`, `to-read` or `to-listen` is usually a bare typed
 * title ("Clara and the Sun", "Contact, Carl Sagan", "The Piano Tuner (about
 * Thai Myanmar border)"). This module reads such a title, decides which
 * Wikidata entity it names, and turns that entity into the `metadata.lookup`
 * record the item carries afterwards. Fetching belongs to `background.js`;
 * every decision belongs here.
 *
 * Each tag accepts a fixed set of Wikidata classes, matched on the candidate's
 * direct P31 (instance of) with no subclass walk. Every class id below was
 * checked against Wikidata while this was written.
 */

/** The tags this feature acts on. A text item carrying one is a candidate. */
export const LOOKUP_TAGS = ['to-watch', 'to-read', 'to-listen'];

/** The tag an item carries once its lookup found something. */
export const FOUND_TAG = 'lookup:found';

/** The tag an item carries once its lookup found nothing. */
export const UNRESOLVED_TAG = 'lookup:unresolved';

/** At most this many items per check, to keep the Wikidata load small. */
export const DEFAULT_LIMIT = 20;

/**
 * The Wikidata classes each tag accepts, with the plain word each one becomes
 * as the lookup's `kind`. Order matters: the first P31 found in a candidate
 * that appears here names the kind.
 */
export const CLASSES_BY_TAG = {
  'to-watch': {
    Q11424: 'film',
    Q5398426: 'television series',
    Q1259759: 'miniseries',
    Q93204: 'documentary film',
    Q202866: 'animated film',
  },
  'to-read': {
    Q7725634: 'literary work',
    Q571: 'book',
    Q8261: 'novel',
    Q47461344: 'written work',
  },
  'to-listen': {
    Q482994: 'album',
    Q208569: 'studio album',
    Q215380: 'musical group',
    Q24634210: 'podcast',
    Q7366: 'song',
  },
};

/**
 * Creator properties, in the order they are consulted: author, director,
 * performer, creator. The first one present names the creator.
 */
export const CREATOR_PROPS = ['P50', 'P57', 'P175', 'P170'];

/**
 * External ids that become links, each with the URL it is built into. `$1` is
 * the id. TMDB is absent here because it keeps its type and id rather than
 * becoming a URL — a later watchlist feature sends the id on.
 */
export const LINK_PROPS = {
  P648: { key: 'openLibrary', url: 'https://openlibrary.org/works/$1' },
  P2969: { key: 'goodreads', url: 'https://www.goodreads.com/book/show/$1' },
  P436: { key: 'musicbrainz', url: 'https://musicbrainz.org/release-group/$1' },
  P2205: { key: 'spotify', url: 'https://open.spotify.com/album/$1' },
  // P8055 is Wikidata's Amazon Prime Video ID. Wikidata has no JustWatch
  // property, so this is the "where to watch" id that exists.
  P8055: { key: 'primeVideo', url: 'https://www.amazon.com/gp/video/detail/$1' },
};

/** TMDB ids, which keep their type rather than becoming a URL. */
export const TMDB_PROPS = { P4947: 'movie', P4983: 'tv' };

/** A trailing parenthesis is the typist's own note, not part of the title. */
const DESCRIPTION_RE = /\s*\(([^()]*)\)\s*$/;

/** The two ways a typed title names its creator after the work. */
const SEPARATORS = [/, /, / by /i];

/** The typed text with its trailing description removed. */
function withoutDescription(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const described = DESCRIPTION_RE.exec(trimmed);
  return described ? trimmed.slice(0, described.index).trim() : trimmed;
}

/**
 * Read a typed title.
 *
 * Returns `{ title, creatorHint?, description? }`. A trailing `(…)` is the
 * description and is dropped from the title. Text after the first `, ` or
 * ` by ` is a creator hint. Neither key appears when there is nothing to put
 * in it, and a split that would leave an empty title is not made — so
 * ", Carl Sagan" keeps its comma rather than losing its whole title.
 */
export function parseTitle(text) {
  const parsed = {};
  const trimmed = typeof text === 'string' ? text.trim() : '';

  const described = DESCRIPTION_RE.exec(trimmed);
  if (described) {
    const description = described[1].trim();
    if (description) parsed.description = description;
  }
  const rest = withoutDescription(text);

  let cut = -1;
  let cutLength = 0;
  for (const separator of SEPARATORS) {
    const match = separator.exec(rest);
    if (!match) continue;
    if (cut === -1 || match.index < cut) {
      cut = match.index;
      cutLength = match[0].length;
    }
  }

  if (cut > 0) {
    const title = rest.slice(0, cut).trim();
    const creatorHint = rest.slice(cut + cutLength).trim();
    if (title && creatorHint) {
      parsed.title = title;
      parsed.creatorHint = creatorHint;
      return parsed;
    }
  }

  parsed.title = rest;
  return parsed;
}

/**
 * The searches to try for a typed title, in order.
 *
 * The split title comes first, with its creator hint. When that finds no
 * matching candidate the whole text is searched once more with no hint — the
 * description still dropped — so "Stand by Me", whose ` by ` is part of the
 * title, still resolves. A title with no split has only the one attempt.
 */
export function searchAttempts(text) {
  const { title, creatorHint } = parseTitle(text);
  const whole = withoutDescription(text);
  const attempts = [];
  if (title) attempts.push({ term: title, creatorHint });
  if (creatorHint && whole && whole !== title) attempts.push({ term: whole });
  return attempts;
}

/** Claim values for one property, in the order Wikidata returned them. */
function claimValues(entity, property) {
  const claims = entity?.claims?.[property];
  if (!Array.isArray(claims)) return [];
  const values = [];
  for (const claim of claims) {
    const value = claim?.mainsnak?.datavalue?.value;
    if (value !== undefined && value !== null) values.push(value);
  }
  return values;
}

/** The entity's own English label. */
function englishLabel(entity) {
  const label = entity?.labels?.en?.value;
  return typeof label === 'string' ? label : undefined;
}

/**
 * The class this candidate is accepted under for a tag, as the plain word it
 * becomes, or `undefined` when none of its P31 values is accepted.
 */
function kindFor(entity, tag) {
  const classes = CLASSES_BY_TAG[tag];
  if (!classes) return undefined;
  for (const value of claimValues(entity, 'P31')) {
    if (value?.id && classes[value.id]) return classes[value.id];
  }
  return undefined;
}

/** The entity ids this candidate names as its creator, in property order. */
function creatorIds(entity) {
  const ids = [];
  for (const property of CREATOR_PROPS) {
    for (const value of claimValues(entity, property)) {
      if (value?.id) ids.push(value.id);
    }
  }
  return ids;
}

/** The creator's English label, from the labels the caller fetched. */
function creatorName(entity, labelsById) {
  for (const id of creatorIds(entity)) {
    const label = englishLabel(labelsById?.[id]);
    if (label) return label;
  }
  return undefined;
}

/** Does any of this candidate's creators answer to the hint? */
function matchesCreatorHint(entity, creatorHint, labelsById) {
  const wanted = creatorHint.toLowerCase();
  for (const id of creatorIds(entity)) {
    const label = englishLabel(labelsById?.[id]);
    if (label && label.toLowerCase().includes(wanted)) return true;
  }
  return false;
}

/**
 * Choose the entity a title names.
 *
 * `entities` are the candidates in search order. The first one whose direct
 * P31 is in the tag's class set wins; when a creator hint is present, one
 * whose creator's English label contains the hint wins over one whose creator
 * does not. Nothing matching the class set returns `null`.
 */
export function pickCandidate(tag, entities, creatorHint, labelsById) {
  const candidates = (Array.isArray(entities) ? entities : []).filter(
    entity => kindFor(entity, tag) !== undefined,
  );
  if (candidates.length === 0) return null;

  if (creatorHint) {
    const named = candidates.find(entity => matchesCreatorHint(entity, creatorHint, labelsById));
    if (named) return named;
  }
  return candidates[0];
}

/** The English Wikipedia address for a sitelink title. */
function wikipediaUrl(title) {
  return `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`;
}

/**
 * Build the `metadata.lookup` record for a chosen entity.
 *
 * `labelsById` supplies the creator's label. `now` is the time of the lookup;
 * it is a parameter so the result is a function of its input alone.
 */
export function lookupFromEntity(entity, tag, labelsById, now = Date.now()) {
  const links = {};

  const sitelink = entity?.sitelinks?.enwiki?.title;
  if (typeof sitelink === 'string' && sitelink) links.wikipedia = wikipediaUrl(sitelink);

  for (const [property, type] of Object.entries(TMDB_PROPS)) {
    if (links.tmdb) break;
    const [id] = claimValues(entity, property);
    if (typeof id === 'string' && id) links.tmdb = { type, id };
  }

  for (const [property, { key, url }] of Object.entries(LINK_PROPS)) {
    const [id] = claimValues(entity, property);
    if (typeof id === 'string' && id) links[key] = url.replace('$1', id);
  }

  const lookup = {
    wikidataId: entity?.id,
    label: englishLabel(entity),
    kind: kindFor(entity, tag),
    links,
    resolvedAt: now,
  };

  const creator = creatorName(entity, labelsById);
  if (creator) lookup.creator = creator;

  return lookup;
}

/** The `metadata.lookup` record for a title nothing was found for. */
export function unresolvedLookup(now = Date.now()) {
  return { unresolved: true, checkedAt: now };
}

/** Tag names off whatever shape the caller holds them in. */
function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  const names = [];
  for (const tag of tags) {
    if (typeof tag === 'string') names.push(tag);
    else if (tag && typeof tag.name === 'string') names.push(tag.name);
  }
  return names;
}

/** The lookup tag an item carries, or `undefined`. The first one wins. */
export function lookupTagFor(tags) {
  for (const name of tagNames(tags)) {
    if (LOOKUP_TAGS.includes(name)) return name;
  }
  return undefined;
}

/**
 * The ids of the items due a lookup, in the order they were given, at most
 * `limit` of them.
 *
 * `itemTags` maps an item id to its tags; `itemsById` maps an item id to the
 * item, read for its type and `metadata.lookup`. An item qualifies when it is
 * a text item, carries one of the lookup tags, and has no `metadata.lookup`
 * yet — so a lookup happens once, and removing `lookup:unresolved` does not
 * retry it. Other `to-*` tags, URL items and image items are left untouched.
 */
export function selectItemsToLookUp(itemTags, itemsById, limit = DEFAULT_LIMIT) {
  const tagsFor = asMap(itemTags);
  const items = asMap(itemsById);

  const due = [];
  for (const [itemId, tags] of tagsFor) {
    if (due.length >= limit) break;
    if (!lookupTagFor(tags)) continue;
    const item = items.get(itemId);
    if (!item || item.type !== 'text') continue;
    if (item.metadata?.lookup) continue;
    due.push(itemId);
  }
  return due;
}

function asMap(source) {
  if (source instanceof Map) return source;
  const map = new Map();
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) map.set(key, value);
  }
  return map;
}
