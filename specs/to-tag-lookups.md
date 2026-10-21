---
enabled: true
touches: [apps/desktop/features/lookups/, apps/desktop/tests/unit/lookups-resolve.test.js, apps/desktop/tests/unit/fixtures/lookups/, apps/desktop/tests/desktop/lookups-resolve.spec.ts]
depends-on: []
---

# Items tagged `to-watch`, `to-read` or `to-listen` are resolved to what they name, with links

Peek item `7c16a5da` (to-* lookups), served by Connectory (Peek `2a8bcc3f`), peeklets under
`28914048`. Most of these items are bare typed titles ("Clara and the Sun", "Contact, Carl
Sagan", "The Piano Tuner (about Thai Myanmar border)"). A lookup works out which work the title
names and attaches its Wikipedia page, its creator, and where to read, watch or listen.

Decisions:

- Source of truth is Wikidata, through its public API, with no key. One Wikidata entity gives
  the English Wikipedia page (sitelink `enwiki`), the creator (P50 author, P57 director, P175
  performer, P170 creator), and the external ids that become links: TMDB movie (P4947) and TV
  (P4983), Open Library (P648), Goodreads (P2969), MusicBrainz release group (P436), Spotify album
  (P2205) and JustWatch (P8055). The TMDB id is what a later hzz watchlist feature sends (Peek
  `c97fa48b`), so no TMDB key is needed here.
- Scope of this slice: text items tagged `to-watch`, `to-read` or `to-listen`. URL items and
  image items, and the other `to-*` tags (`to-visit` is mostly photos), are skipped and left
  untouched.
- Each tag accepts a fixed set of Wikidata classes, matched on the candidate's direct P31
  (instance of), with no subclass walk:
  - `to-watch`: film (Q11424), television series (Q5398426), miniseries (Q1259759),
    documentary film (Q93204), animated film (Q202866).
  - `to-read`: literary work (Q7725634), book (Q571), novel (Q8261), written work (Q47461344).
  - `to-listen`: album (Q482994), studio album (Q208569), musical group (Q215380), podcast
    (Q24634210), song (Q7366).

  Any class id above is checked against Wikidata while implementing; a wrong one is replaced and
  noted in the handoff.
- Reading a title: text after `, ` or ` by ` is a creator hint, and a trailing `(…)` is a
  description, dropped from the search. When the split title finds no matching candidate, the
  whole text (description still dropped) is searched once more with no hint, so "Stand by Me"
  still resolves. The search is `wbsearchentities` on the remaining title
  (language `en`, up to 10 candidates), then `wbgetentities` for their claims and sitelinks.
- Choosing: the first candidate, in search order, whose P31 is in the tag's class set. When a
  creator hint is present, a candidate whose creator's English label contains the hint
  (case-insensitive) wins over one whose creator does not. No candidate matching → unresolved.
- Result on the item: `metadata.lookup = { wikidataId, label, kind, creator?, links: { wikipedia?,
  tmdb?: { type: 'movie'|'tv', id }, openLibrary?, goodreads?, musicbrainz?, spotify?, justwatch? },
  resolvedAt }` and the tag `lookup:found`; or `metadata.lookup = { unresolved: true, checkedAt }`
  and the tag `lookup:unresolved`. Links are full URLs built from the ids, except `tmdb`, which
  keeps type and id.
- An item is looked up once. One with `metadata.lookup` is skipped, so removing
  `lookup:unresolved` does not retry it; deleting `metadata.lookup` (or the `lookup` command on a
  selected item, later) does. Each check handles at most 20 items to keep the Wikidata load small.
- Each resolved item with a TMDB id publishes `lookups:resolved` with `{ itemId, tmdb }`, for a
  later consumer; nothing subscribes in this slice.
- Requests send an `Api-User-Agent` header naming Peek, as Wikimedia asks of browser clients.
  The API base URL is a feature setting (`apiBase`, default `https://www.wikidata.org/w/api.php`)
  so tests point it at a local server.

## What the code does now

- `features/reminders/` is the model for a lazy built-in background tile with a manifest
  `schedule`, a pure decision module (`remind.js`) and a `background.js` that applies its
  actions through `api.datastore`.
- `features/feeds/manifest.json` shows the `network: { domains: ["*"] }` capability; this feature
  declares only `www.wikidata.org` (plus whatever host `apiBase` names in tests, if the capability
  check needs it; the implementer notes how tests are allowed through).
- No Wikidata client exists in the app.

## What changes

New built-in feature `features/lookups/` (`manifest.json`, `background.html`, `background.js`,
`resolve.js`, `settings-schema.json`), laid out like `features/reminders/`.

- Manifest: one lazy background tile with `"schedule": [{ "topic": "lookups:check",
  "everyMinutes": 360 }]`, the command `lookups` (runs a check now), pubsub topics
  `lookups:check`, `lookups:resolved`, `ext:ready` and `app:shutdown`, datastore tables `items`,
  `tags` and `item_tags`, and the network capability above.
- `resolve.js`, pure (no `api`, `fetch`, window or DOM):
  - `parseTitle(text)` returns `{ title, creatorHint?, description? }`.
  - `pickCandidate(tag, entities, creatorHint, labelsById)` applies the class sets and the
    creator preference and returns an entity or `null`.
  - `lookupFromEntity(entity, tag, labelsById)` builds `metadata.lookup` with its links.
  - `selectItemsToLookUp(itemTags, itemsById, limit)` returns the item ids due a lookup.
- `background.js` registers `lookups:check` and `lookups` synchronously in `init()`, before any
  `await` (`apps/desktop/CLAUDE.md`, lazy tile init-order rule). It does the fetching (search,
  then entities, then the creator labels in one `wbgetentities` call), calls the pure functions,
  writes the metadata and tag, and publishes `lookups:resolved`. A failed request leaves that
  item without `metadata.lookup` so the next check tries it again.

## Tests to change

New `tests/unit/lookups-resolve.test.js` (import pattern as in
`tests/unit/reminders-remind.test.js`), using recorded Wikidata responses saved under
`tests/unit/fixtures/lookups/` (recorded once by hand; tests never call Wikidata):

- `parseTitle`: a bare title, `Title, Creator`, `Title by Creator`, and a trailing description.
  `background.js` covers the whole-text retry; the desktop spec includes one title containing
  ` by ` that resolves only on the retry.
- `pickCandidate`: the first matching class wins; a non-matching first result is passed over; a
  creator hint reorders; nothing matching returns `null`; each tag's class set is honoured.
- `lookupFromEntity`: each link type built from its id, a TV TMDB id typed `tv`, a missing
  `enwiki` leaves `wikipedia` out.
- `selectItemsToLookUp`: skips URL and image items, other `to-*` tags, items already carrying
  `metadata.lookup`, and caps at the limit.

New `tests/desktop/lookups-resolve.spec.ts`, on a test profile: a local HTTP server started by the
spec answers `wbsearchentities` and `wbgetentities` from the fixtures, `apiBase` points at it, and
three text items are tagged `to-watch`, `to-read` and `to-listen` with titles the fixtures cover,
plus one the fixtures cannot resolve. Publish `lookups:check` and confirm each item's
`metadata.lookup` and tag, and that `lookups:resolved` was published once, for the `to-watch`
item.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "lookups|reminders|feeds-schedule"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff, and list any Wikidata class id that was
corrected.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Job logic stays free of
window, DOM and network calls so a peeklet can later run off the desktop. Tests never reach
Wikidata. Run one command per Bash call.
