---
enabled: true
touches: [apps/desktop/features/entities/extractors/map-url.js, apps/desktop/features/entities/background.js, apps/desktop/tests/unit/entities-map-url.test.js, apps/desktop/tests/desktop/entities-map-place.spec.ts]
depends-on: []
---

# A saved map link becomes a place entity

Peek items `0ca5afae` and `28914048` (peeklets). When a URL item is saved, the entities feature
already wakes and extracts entities from the page. A map link yields almost nothing that way,
because a map page's HTML holds no structured place data, so this spec reads the place from the
URL itself. It is the start of a Places feature; classifying every saved URL is a later slice.

Decisions:

- The place is read from the URL alone, with no page fetch, so a full map URL becomes a place even
  offline or when the page fetch fails.
- Recognised shapes: Google Maps (`google.<tld>/maps/place/<name>/@<lat>,<lng>,…`, `/maps/search/`,
  `?q=` and `?query=`, and `@<lat>,<lng>` alone), Apple Maps (`maps.apple.com` with `q`, `ll`,
  `address`), OpenStreetMap (`mlat`/`mlon` query, `#map=<zoom>/<lat>/<lon>`), and Bing Maps (`cp=<lat>~<lng>`,
  `q`). Anything else returns no place.
- A short link (`maps.app.goo.gl`, `goo.gl/maps`) is expanded by following its redirect once
  with the feature's existing network capability, and the final URL is parsed. If expansion
  fails, no place is created and nothing else changes.
- A place with coordinates but no name is named by its coordinates (`52.3731, 4.8922`), so it is
  still listed and can be renamed later.
- Confidence is 0.9: the URL states the place outright. Two saves of the same place match the
  existing entity through the usual name + type matching in `entity-matcher.js`, and each save
  adds an observation.

## What the code does now

- `features/entities/manifest.json` has a rule on `item:created` with `itemType: "url"` that
  publishes `scripts:execute:entities-extract`, a `lazyEvents` topic, so saving a URL wakes the
  sleeping background tile.
- `features/entities/background.js schedulePageExtraction()` debounces and runs
  `extractEntities(url, title)`, which calls `getPageContent(url)` and **returns `[]` when no
  content comes back**, before any extractor runs. The extractors (`extractors/regex.js`,
  `microformats.js`, `structured-data.js`) take page HTML or text, and their raw entities go to
  `entity-matcher.js processEntities(rawEntities, { url, title }, CONFIDENCE_THRESHOLD)`.
- `structured-data.js` already stores a place's coordinates as `attributes.latitude` /
  `attributes.longitude` and its address as `attributes.address`; `entity-store.js createEntity()`
  tags each entity `entity:<entityType>`.

## What changes

- New `features/entities/extractors/map-url.js`: a pure `extractMapUrlEntities(url)` returning
  zero or one raw entity `{ name, entityType: 'place', confidence: 0.9, extractor: 'map-url',
  attributes: { latitude, longitude, address?, mapProvider, mapUrl } }`, in the shape the other
  extractors return. It does no network and no DOM work (job logic stays portable off the
  desktop). A separate `isMapShortLink(url)` names the short-link hosts.
- `background.js extractEntities()`: before fetching the page, expand a short link (one fetch,
  `redirect: 'follow'`, read `response.url`), then run `extractMapUrlEntities` on the resulting
  URL. Its entities are processed even when `getPageContent` returns nothing, and are merged
  with the page extractors' results when it returns content. Observations record the URL as
  saved, not the expanded one.
- No new manifest wake: the existing `item:created` rule and `lazyEvents` topic already wake the
  tile.

## Tests to change

New `tests/unit/entities-map-url.test.js` (import pattern as in `name-validator.test.js`), table
cases for each recognised shape: name and coordinates read correctly, URL-encoded names (`+` and
`%20`) decoded, coordinates-only naming, a negative latitude or longitude, a non-map Google URL
(`google.com/search?q=…`) and an unrelated URL returning none, and `isMapShortLink` true for both
short-link hosts and false for full map URLs.

New `tests/desktop/entities-map-place.spec.ts`: on a test profile, save a URL item for a full
Google Maps place URL (no short link, so no network is needed); within the extraction delay plus a
margin, an `entity` item exists for that place with the `entity:place` tag, the parsed latitude and
longitude in its metadata attributes, and an observation pointing at the saved URL. Saving the
same URL a second time creates no second entity.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "entities|entity|rule-engine"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
