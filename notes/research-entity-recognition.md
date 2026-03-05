# Entity Recognition System - Implementation Plan

Research and design document for the Entity-centrism / NER indices feature described in `peek-todo.md`.

## 1. Vision Recap

Peek's entity-centrism lifts the apex of understanding from publishers into the user agent. Instead of treating the web as a set of disconnected domains, Peek identifies and indexes real-world entities -- people, places, events, organizations, numbers -- across every page you visit. Over time, Peek builds a personal knowledge graph that reflects your world, scored by frecency, with bidirectional links between entities and their source URLs.

Core insight from `peek-todo.md`:
> "Many significant entities in our lives are singletons. A person, a place, an event. The web makes the publisher the apex of understanding. Browsers do not acknowledge entities across pages."

## 2. Existing Systems to Build On

### 2.1 Data Model

The codebase already has the primitives needed:

- **`items` table** (in `backend/electron/datastore.ts`): Unified content storage with types `url`, `text`, `tagset`, `image`, `series`, `feed`. The `type` CHECK constraint will need a new value: `entity`.
- **`item_tags` junction table**: Many-to-many linking items to tags. Entity types can be modeled as tags initially (e.g., `entity:person`, `entity:place`).
- **`item_events` table**: Append-only time-series data. Entity observations (sightings on pages) map naturally to events on an entity item.
- **`metadata` JSON column** on items: Extensible storage for entity-specific attributes (homepage, email, coordinates, aliases).
- **`tags` with frecency**: The scoring model already exists for tags. Entities will adopt the same frecency calculation from `calculateFrecency()` in the datastore.

### 2.2 Content Access

- **`trackWindowLoad()`** in `backend/electron/datastore.ts`: Called on every `did-navigate` event and new window open. This is the natural hook point for triggering entity extraction on page loads.
- **Scripts extension** (`features/scripts/`): Has `ScriptExecutor` with pattern matching and code execution against page DOM. Entity extraction scripts can run through this pipeline.
- **Feeds extension** (`features/feeds/`): Demonstrates the pattern of using `item_events` for per-item data streams. Entity observations follow the same model.
- **Context API** (`app/context/`): Per-window context with persistence. Could store active entity context per window.

### 2.3 Extension Patterns

- Extensions register commands via `api.commands.register()`.
- Extensions communicate via pubsub: `api.publish()` / `api.subscribe()`.
- Extensions access data via `api.datastore.*` (addItem, queryItems, tagItem, addItemEvent, etc.).
- Extensions open UIs via `api.window.open()` with `peek://ext/{id}/` URLs.
- All extension backgrounds follow the `init()`/`uninit()` lifecycle pattern with `cmd:ready` subscription for command registration.

### 2.4 Sync Architecture

- `schema/v1.json` defines canonical sync columns. Entity tables must decide sync vs. local-only.
- Items sync via `syncId`/`syncedAt`. Entity items should sync; observations may be local-only (high volume).
- `_sync` metadata pattern inside `metadata` JSON for cross-device provenance.

## 3. Entity Types

### 3.1 Phase 1: Structured/Extractable Entities (regex + microformats + structured data)

These have well-defined patterns and can be extracted reliably:

| Entity Type | Detection Method | Example | Stored Attributes |
|-------------|-----------------|---------|-------------------|
| **URL/Link** | Already exists | `https://example.com` | domain, title, path |
| **Email** | Regex `[^\s@]+@[^\s@]+\.[^\s@]+` | `alice@example.com` | address, domain, name context |
| **Phone number** | Regex + libphonenumber patterns | `+1-555-0123` | number, country, type (mobile/work), context |
| **Date/Time** | Regex + chrono-node style parsing | `March 15, 2026`, `next Tuesday` | ISO date, original text, context |
| **Physical address** | Regex + structured data | `123 Main St, Portland, OR` | street, city, region, postal, country |
| **Tracking number** | Regex (carrier patterns) | `1Z999AA10123456784` | carrier, number, context |
| **Price/Currency** | Regex `\$[\d,.]+`, `EUR [\d,.]+` | `$199.99` | amount, currency, context |
| **Code/Reference** | Regex (flight, booking, order) | `UA 1234`, `ORDER-789` | type, number, context |
| **Person** | Microformats `h-card` with `p-name`, JSON-LD Person, vCard | `Alice Smith` | name, url, photo, email, org |
| **Organization** | Microformats `h-card` (org), JSON-LD Organization, meta publisher | `Acme Corp` | name, url, logo, description |
| **Event** | Microformats `h-event`, JSON-LD Event | `PyCon 2026` | name, date, location, url |
| **Place** | Microformats `h-adr`, JSON-LD Place, geo meta | `Portland, OR` | name, address, coordinates |

### 3.2 Phase 2: Heuristic NER (coarse scoring, no ML)

Extract people/orgs/places from unstructured text using simple signals. The goal is high-confidence entities in the common case without ML.

**Approach: Coarse heuristic with signal stacking.**

For each candidate proper noun phrase in page text:

| Signal | Score Bump | Example |
|--------|-----------|---------|
| **Proper noun** (capitalized multi-word not at sentence start) | base 0.3 | "John McEntire" |
| **Is linked** (appears as anchor text with href) | +0.2 | `<a href="...">John McEntire</a>` |
| **Mentioned >1 time on page** | +0.15 | "McEntire" appears 3 times |
| **Matches existing entity** (already in our store) | +0.2 | Previously extracted from another page |
| **Has org suffix** (Inc, LLC, Ltd, Corp, Foundation) | +0.2 (→ org type) | "Mozilla Foundation" |
| **Context clue** (preceded by Mr/Mrs/Dr/CEO/etc) | +0.15 (→ person type) | "Dr. Smith" |

Confidence >= 0.5 → store. This catches the common case: a person or org mentioned multiple times and linked at least once is almost certainly a real entity.

| Entity Type | Detection Method | Wikidata Mapping |
|-------------|-----------------|-----------------|
| **Person** | Proper noun + context clues (title, role) + link/mention scoring | Q5 (human) |
| **Organization** | Proper noun + org suffixes + link/mention scoring | Q43229 (organization) |
| **Place/Location** | Proper noun + gazetteer matching (common city/country names) | Q17334923 (location) |
| **Product** | LD+JSON Product, schema.org markup | Q2424752 (product) |
| **Creative Work** | LD+JSON, og:type=article/book/music | Q17537576 (creative work) |

### 3.3 Phase 3: ML NER Models

- Experiment with small offline models (e.g., ONNX-exported spaCy/Transformers models).
- Train micro-models from accumulated entity data.
- Run in Web Workers or background processes to avoid blocking UI.

## 4. Architecture

### 4.1 New Extension: `features/entities/`

Entity recognition is implemented as a built-in extension, following the established extension pattern:

```
features/entities/
  manifest.json            # Extension metadata
  background.html          # Entry point
  background.js            # Core logic: lifecycle, commands, pubsub
  extractors/
    regex.js               # Regex-based extractors (email, phone, date, etc.)
    microformats.js        # Microformat parser (h-card, h-event, h-adr)
    structured-data.js     # JSON-LD / schema.org extraction
    readability.js         # Mozilla Readability for content extraction
  entity-store.js          # Entity CRUD via api.datastore
  entity-matcher.js        # Dedup / approximate matching / confidence scoring
  wikidata.js              # Wikidata validation and triangulation
  home.html                # Entity browser UI
  home.js                  # Entity browser logic
  entity-detail.html       # Single entity detail view
  entity-detail.js         # Detail view logic
```

### 4.2 Storage Model

#### Option A: Entities as Items (Recommended)

Add `entity` to the items type CHECK constraint. Each entity is an `items` row:

```sql
-- Entity item
items: {
  id: 'entity_17123...',
  type: 'entity',
  content: 'Tortoise',           -- canonical name / primary label
  metadata: JSON.stringify({
    entityType: 'organization',  -- person, place, org, event, product, etc.
    subtype: 'band',             -- optional finer classification
    aliases: ['Tortoise (band)', 'Tortoise Chicago'],
    wikidata: 'Q1400189',        -- Wikidata QID if matched
    attributes: {                -- type-specific structured data
      homepage: 'https://...',
      genres: ['post-rock'],
      location: 'Chicago, IL'
    },
    confidence: 0.85,            -- overall confidence score
    mergedFrom: [],              -- IDs of entities merged into this one
    _sync: { createdBy: 'device-uuid', ... }
  }),
  frecencyScore: 42,             -- based on observation frequency + recency
  createdAt: ...,
  updatedAt: ...
}
```

Entity observations (sightings) use `item_events`:

```sql
-- Entity observation: "entity X was seen on page Y"
item_events: {
  id: 'evt_17123...',
  itemId: 'entity_17123...',     -- FK to entity item
  content: 'https://pitchfork.com/reviews/tortoise-tnt',  -- source URL
  value: 0.92,                   -- extraction confidence for this observation
  occurredAt: 1707500000000,     -- when the page was loaded
  metadata: JSON.stringify({
    extractedText: 'Tortoise released their album...',
    extractor: 'regex',          -- which extractor found it
    context: 'article body',     -- where on the page
    pageTitle: 'Tortoise - TNT Review',
    itemId: 'item_abc...'        -- FK to the URL item if it exists
  })
}
```

This approach:
- Reuses existing items/item_events infrastructure completely.
- Entity frecency uses the same `calculateFrecency()` function.
- Tags work naturally (tag entities like any item: `entity:person`, `music`, `chicago`).
- Groups work (create a group of entities).
- Sync works via the existing items sync pipeline.
- Search works against items content/metadata.
- Commands work via existing `api.datastore.queryItems({ type: 'entity' })`.

#### Schema Migration

```sql
-- Migration: allow 'entity' type in items CHECK constraint
-- Same pattern as migrateItemTypes() in datastore.ts
-- Recreate items table with updated CHECK:
--   type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity')
```

#### New Indexes for Entity Queries

```sql
-- Fast lookup by entity type within entities
CREATE INDEX IF NOT EXISTS idx_items_entity_type
  ON items((json_extract(metadata, '$.entityType')))
  WHERE type = 'entity';

-- Fast Wikidata QID lookup
CREATE INDEX IF NOT EXISTS idx_items_wikidata
  ON items((json_extract(metadata, '$.wikidata')))
  WHERE type = 'entity' AND json_extract(metadata, '$.wikidata') IS NOT NULL;

-- item_events by source URL (find all entities on a page)
CREATE INDEX IF NOT EXISTS idx_item_events_content
  ON item_events(content)
  WHERE content LIKE 'http%';
```

### 4.3 Extraction Pipeline

```
Page Load (trackWindowLoad / did-navigate)
  |
  v
[1] URL recorded in items (existing behavior)
  |
  v
[2] Entity extraction triggered (async, non-blocking)
  |
  +---> Regex extractors (emails, phones, dates, prices, tracking#s)
  |
  +---> Structured data extractors (JSON-LD, microformats, meta tags)
  |
  +---> (Phase 2) NER heuristics (capitalization, context)
  |
  +---> (Phase 3) ML models (Web Worker)
  |
  v
[3] Raw extractions collected
  |
  v
[4] Entity matching / dedup
  |     - Normalize names (lowercase, trim, alias matching)
  |     - Check existing entities by content + entityType
  |     - Confidence threshold filtering (discard < 0.3)
  |
  v
[5] Entity items created or updated
  |     - New entity -> addItem('entity', {...})
  |     - Existing entity -> addItemEvent(entityId, {observation})
  |     - Update frecencyScore based on new observation
  |
  v
[6] Publish events
      - entities:extracted { url, entities: [...] }
      - entities:updated { entityId, observation }
```

### 4.4 When Extraction Happens

| Trigger | What Runs | Priority |
|---------|-----------|----------|
| **Page load (did-navigate)** | Full extraction pipeline | Primary - this is the main trigger |
| **Item save (note/url via cmd)** | Regex extractors only | Secondary - lightweight scan of saved content |
| **Background re-process** | All extractors on unprocessed URLs | Batch - fills gaps, retries failures |
| **Manual "extract entities" command** | Full pipeline on current page | On-demand - user initiated |
| **Feed entry ingestion** | Regex extractors on feed content | Feed event - triggered by feeds extension |

For page loads, extraction should be deferred to avoid blocking the page rendering:

```javascript
// In entities/background.js
api.subscribe('page:loaded', async (msg) => {
  // Debounce: don't re-extract if we processed this URL recently
  const key = `extracted:${msg.url}`;
  const lastExtracted = extractionCache.get(key);
  if (lastExtracted && Date.now() - lastExtracted < REEXTRACT_COOLDOWN_MS) {
    return;
  }

  // Run extraction after short delay (let page finish rendering)
  setTimeout(async () => {
    const entities = await extractEntities(msg.url, msg.pageContent);
    await storeEntities(entities, msg.url);
    extractionCache.set(key, Date.now());
  }, 2000);
}, api.scopes.GLOBAL);
```

### 4.5 Content Access Strategy

Entity extraction needs access to page content. Three approaches, in order of preference:

1. **Content script injection** (via `webContents.executeJavaScript`): Extract text content, structured data, and microformats from the page DOM. The `trackWindowLoad` hook in `ipc.ts` already has access to the `BrowserWindow` and its `webContents`. Add a content extraction step after visit recording.

2. **Readability extraction**: Use Mozilla Readability (already mentioned in `peek-todo.md`) to extract clean article text. This gives better content for NER than raw DOM text.

3. **Metadata only**: For a minimal first pass, extract only from the page's `<meta>` tags, `<title>`, JSON-LD, and microformats. This requires minimal DOM access and yields high-quality structured entities.

Recommended first implementation: approach 3 (metadata only), then layer in approaches 1 and 2 as extraction quality needs grow.

## 5. Entity Matching and Deduplication

### 5.1 Approximate Equivalency

The core challenge: "Tortoise" on pitchfork.com and "Tortoise (band)" on wikipedia.org should resolve to the same entity.

Matching strategy:

```javascript
function matchEntity(candidate, entityType) {
  // 1. Exact content match (normalized)
  const normalized = normalize(candidate.name); // lowercase, trim, remove diacritics
  const exact = await queryItems({
    type: 'entity',
    contentMatch: normalized
  });
  if (exact.length === 1) return { match: exact[0], confidence: 1.0 };

  // 2. Alias match
  for (const existing of allEntitiesOfType) {
    const aliases = JSON.parse(existing.metadata).aliases || [];
    if (aliases.some(a => normalize(a) === normalized)) {
      return { match: existing, confidence: 0.95 };
    }
  }

  // 3. Wikidata match (if candidate has QID)
  if (candidate.wikidataId) {
    const wdMatch = await queryByWikidata(candidate.wikidataId);
    if (wdMatch) return { match: wdMatch, confidence: 0.99 };
  }

  // 4. Fuzzy match (edit distance, token overlap)
  const fuzzy = findFuzzyMatches(normalized, entityType, 0.8);
  if (fuzzy.length === 1) return { match: fuzzy[0], confidence: fuzzy[0].score };

  // 5. No match - new entity
  return { match: null, confidence: 0 };
}
```

### 5.2 Confidence Scoring

Each entity extraction gets a confidence score:

- **1.0**: Structured data (JSON-LD Person with explicit name)
- **0.95**: Microformat (h-card with p-name)
- **0.9**: Email/phone regex (unambiguous patterns)
- **0.8**: Date/time regex (common formats)
- **0.7**: Wikidata-validated named entity
- **0.5**: Capitalized multi-word phrase in article text
- **0.3**: Single capitalized word (high false positive rate)

Threshold for storage: **0.5** (configurable in extension settings).

### 5.3 Entity Merging

When two entities are later determined to be the same:

```javascript
async function mergeEntities(keepId, mergeId) {
  const keep = await getItem(keepId);
  const merge = await getItem(mergeId);

  // Combine aliases
  const keepMeta = JSON.parse(keep.metadata);
  const mergeMeta = JSON.parse(merge.metadata);
  keepMeta.aliases = [...new Set([
    ...(keepMeta.aliases || []),
    merge.content,  // add merged entity's name as alias
    ...(mergeMeta.aliases || [])
  ])];
  keepMeta.mergedFrom = [...(keepMeta.mergedFrom || []), mergeId];

  // Move observations
  const observations = await queryItemEvents({ itemId: mergeId });
  for (const obs of observations.data) {
    await addItemEvent(keepId, {
      content: obs.content,
      value: obs.value,
      occurredAt: obs.occurredAt,
      metadata: obs.metadata
    });
    await deleteItemEvent(obs.id);
  }

  // Update entity
  await updateItem(keepId, { metadata: JSON.stringify(keepMeta) });
  await deleteItem(mergeId); // soft delete
}
```

## 6. Integration Points

### 6.1 Command Palette

Register commands in `entities/background.js`:

| Command | Description | Behavior |
|---------|-------------|----------|
| `entities` | Open entity browser | Opens `peek://ext/entities/home.html` |
| `entity <name>` | Search entities by name | Fuzzy search, show matches |
| `entity:extract` | Extract entities from current page | Run pipeline on focused window |
| `entity:people` | Browse person entities | Filter entity browser to type=person |
| `entity:places` | Browse place entities | Filter entity browser to type=place |
| `entity:merge` | Merge two entities | Interactive merge workflow |

### 6.2 Tags Integration

Entity types map to tags:
- Every entity item gets tagged with `entity:{type}` (e.g., `entity:person`, `entity:place`).
- Users can add additional tags to entities like any item.
- Tag-based filtering in the tags extension works out of the box: click `entity:person` to see all person entities.

### 6.3 Groups Integration

- Create smart groups based on entity relationships: "All pages mentioning Alice" = group with query on entity observations.
- Entities found on pages in a group could surface in group metadata.

### 6.4 Search Integration

Entities participate in the existing search infrastructure:
- `queryItems({ type: 'entity', search: 'tortoise' })` for direct entity search.
- When searching URLs/notes, also show entities found on matching pages.
- Entity names as search suggestions in cmd.

### 6.5 Context Object + HUD Integration

Entities surface in the per-window **context object** (`app/context/`), making them available to any UI that reads context — including the HUD.

```javascript
// In entities/background.js, after extraction completes:
api.context.update(windowId, {
  entities: extractedEntities.map(e => ({
    id: e.id,
    name: e.name,
    type: e.entityType,
    confidence: e.confidence
  }))
});
```

**HUD ambient awareness**: The HUD can show entities from context as ambient info — people/orgs/places detected on the current page, without the user explicitly asking. This is a test of the "ambient awareness" concept: does passively surfacing entities feel useful or noisy?

- HUD reads `context.entities` and renders a compact entity chip list
- Only show entities above a confidence threshold (e.g., 0.7)
- Clicking an entity chip opens detail view or shows "also seen on" pages
- This replaces the previous "page info overlay" concept — entities flow through context, not a separate overlay

### 6.6 Page Info / Metadata Overlay

When viewing a page, show detected entities in the page info overlay:
- List of entities found on the current page.
- Each entity links to its detail view.
- "Also seen on" links showing other pages where the entity appears.
- This ties into the "Page info/metadata/action widgets" todo.

### 6.7 Feeds Integration

When feeds pull in new entries, run entity extraction on entry content:
- Extract entities from RSS item descriptions.
- Link entity observations to the feed entry's URL.
- Over time, feeds become a rich source of entity observations.

### 6.8 Sync + Mobile Visibility

- Entity items sync like any other item (via `syncId`/`syncedAt`).
- Entity observations (`item_events`) are local-only by default (high volume). Can opt-in to sync via `metadata.sync: true` per entity.
- Wikidata QIDs provide stable cross-device entity identity.

**Mobile: hide entities from default views.** Entities should not appear in the main mobile item lists. Same treatment as navigational URL visits — they exist in the data but are filtered out of default queries. Mobile can expose entities through a dedicated "entities" view later, but they must not clutter the primary save/capture workflow.

Implementation:
- Server sync delivers entity items normally (they're just items with `type: 'entity'`).
- Mobile `queryItems` default filter excludes `type = 'entity'` (same pattern as filtering navigational visits via `metadata.navigational`).
- Dedicated entity UI on mobile is a future phase — not needed until entity data proves useful on desktop first.

## 7. Wikidata Integration

### 7.1 Validation

After extracting a named entity, check Wikidata for validation:

```javascript
async function validateWithWikidata(entityName, entityType) {
  // Use Wikidata search API
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(entityName)}&language=en&format=json&limit=5`;
  const response = await fetch(url);
  const data = await response.json();

  // Filter by entity type (instance-of mapping)
  const typeMap = {
    person: 'Q5',
    organization: 'Q43229',
    place: 'Q17334923',
    event: 'Q1656682'
  };

  // Return best match with QID
  return data.search.map(result => ({
    qid: result.id,
    label: result.label,
    description: result.description,
    confidence: calculateWikidataConfidence(result, entityName)
  }));
}
```

### 7.2 Triangulation

Use Wikidata relationships to infer entity connections:
- "Tortoise" (Q1400189) -> has member -> "John McEntire" (Q3182157)
- If both entities are observed, create inferred relationship.
- Store inferred links in entity metadata: `relationships: [{ entityId, type, wikidataProperty, confidence }]`.

### 7.3 Enrichment

Pull attributes from Wikidata to fill entity details:
- Person: birth date, occupation, image
- Place: coordinates, population, country
- Organization: founding date, headquarters, website

Cache Wikidata responses locally. Re-validate periodically.

## 8. Extension API

### 8.1 Pubsub Topics

```javascript
// Published by entities extension
'entities:extracted'     // { url, entities: [{ id, name, type, confidence }] }
'entities:created'       // { entityId, name, type }
'entities:updated'       // { entityId, observation }
'entities:merged'        // { keepId, mergedId }

// Subscribed by entities extension
'entities:extract'       // { url, content? } - request extraction
'entities:search'        // { query, type? } - search entities
'entities:get-for-url'   // { url } - get entities found on a URL
```

### 8.2 Datastore Queries

Other extensions query entities using existing `api.datastore` methods:

```javascript
// Get all person entities
const people = await api.datastore.queryItems({ type: 'entity', metadata: { entityType: 'person' } });

// Get entities observed on a specific URL
const observations = await api.datastore.queryItemEvents({
  content: 'https://example.com/page'
});
const entityIds = observations.data.map(o => o.itemId);

// Get entity with observations
const entity = await api.datastore.getItem(entityId);
const history = await api.datastore.queryItemEvents({ itemId: entityId, limit: 50 });
```

## 9. UI Design

### 9.1 Entity Browser (`home.html`)

A card grid (using `peek-grid` and `peek-card` components) showing all entities:

- **Filter bar**: Type filter (All / People / Places / Events / Organizations / Numbers)
- **Search input**: Fuzzy search across entity names and aliases
- **Sort**: By frecency (default), alphabetical, recently seen, most observed
- **Cards**: Entity name, type icon, observation count, last seen date, confidence indicator
- **Click**: Opens entity detail view

### 9.2 Entity Detail View (`entity-detail.html`)

- **Header**: Entity name, type badge, Wikidata link, confidence score
- **Aliases**: List of known aliases, editable
- **Attributes**: Type-specific structured data (email, phone, address, etc.)
- **Source URLs**: List of pages where entity was observed, sorted by recency
  - Each with visit timestamp, extraction confidence, extracted text snippet
- **Related entities**: Other entities frequently co-occurring on the same pages
- **Tags**: Standard tag editing (shared with existing tag editing UI)
- **Actions**: Merge, delete, re-extract, open Wikidata

### 9.3 Page Entity Overlay

When viewing a web page, the page info overlay shows:
- Count of entities detected on this page
- List of entity cards (inline, compact)
- Click entity to open detail view

### 9.4 Cmd Entity Suggestions

When typing in cmd, entity names appear as suggestions alongside URLs and commands. Selecting an entity opens its detail view or offers actions (open source URLs, view related, etc.).

## 10. Implementation Phases

### Phase 1: Foundation + Structured Data (regex + microformats + JSON-LD)

1. **Schema migration**: Add `entity` to items type CHECK constraint.
2. **`features/entities/` skeleton**: Manifest, background script, init/uninit lifecycle.
3. **Regex extractors**: Email, phone, date/time, tracking numbers, prices.
4. **Structured data extractors**: JSON-LD, microformats (h-card, h-event, h-adr), Open Graph. People and orgs come "free" from microformats on many pages — include from day one.
5. **Entity store**: CRUD operations using `api.datastore` item and item_event APIs.
6. **Basic matching**: Exact name + type dedup.
7. **Confidence scoring**: Multi-signal confidence calculation.
8. **Extraction trigger**: Hook into `page:loaded` pubsub or `trackWindowLoad`.
9. **Context object integration**: Populate `context.entities` per window after extraction.
10. **Commands**: `entities`, `entity:extract`.
11. **Basic browser UI**: Card grid listing all entities, filter by type.
12. **HUD ambient awareness**: Show entity chips from context in HUD.

**Deliverable**: Structured entities (emails, phones, dates, people, orgs, places, events) automatically extracted from visited pages via regex + microformats + JSON-LD. Entities visible in entity browser and as ambient HUD chips.

### Phase 2: Heuristic NER + Wikidata

1. **Coarse heuristic NER**: Proper noun detection with signal stacking — linked (+score), mentioned multiple times (+score), org suffix (+score), title/role context (+score). No ML needed.
2. **Readability integration**: Clean text extraction for better NER input.
3. **Wikidata validation**: API integration for entity validation/enrichment.
4. **Entity detail view**: Full detail page with observations, attributes, related entities.
5. **Search integration**: Entity names as cmd suggestions.
6. **Observation dedup + expiration**: One observation per entity per URL per day, prune old observations.

**Deliverable**: High-confidence people/orgs/places extracted from unstructured text using simple heuristics, validated against Wikidata, browsable with full detail views.

### Phase 3: Relationships + Polish

1. **Approximate matching**: Fuzzy dedup, alias resolution.
2. **Entity merging**: UI and API for merging duplicate entities.
3. **Relationship inference**: Co-occurrence analysis, Wikidata relationship mining.
4. **Smart groups**: Auto-generated groups from entity clusters.
5. **Feeds integration**: Entity extraction from feed entries.
6. **Expiration policies**: Archiving low-confidence, stale entities.
7. **Performance tuning**: Extraction throttling, index optimization, cache strategies.

**Deliverable**: Entity relationship graph, cross-page entity linking, production-ready performance.

### Phase 4: ML (optional, only if heuristics hit ceiling)

1. **ML NER models**: ONNX models in Web Workers for offline NER.
2. **Micro-model training**: Train specialized models from accumulated entity data.
3. **Import/export**: Entity data portability.
4. **Sync optimization**: Selective entity sync, conflict resolution.

**Deliverable**: ML-powered entity extraction, self-improving models. Only pursue if Phase 2 heuristics prove insufficient for the entity types we care about.

## 11. Technical Considerations

### 11.1 Performance

- Entity extraction must never block page rendering. All extraction runs asynchronously after page load.
- Debounce re-extraction: if a URL was processed within the last hour, skip (configurable).
- Batch entity creation: collect all extractions from a page, then write to datastore in a single transaction.
- SQLite JSON functions (`json_extract`) are fast but should not be in hot paths. Denormalize entity type into a tag for fast filtering.
- Consider a background re-processing queue for pages visited before the extension was installed.

### 11.2 Content Access Challenges

- **Webview content**: Pages loaded in webviews (`<webview>` tags in `app/page/page.js`) require `executeJavaScript` calls into the guest page. This is available via Electron's webview API.
- **Cross-origin restrictions**: Content scripts can read DOM of the loaded page, but not iframes from different origins. Accept this limitation.
- **SPAs**: Single-page apps change content without navigation. The `did-navigate` hook misses these. Consider `did-navigate-in-page` for hash changes, but full SPA content observation requires MutationObserver-based approaches (Phase 3+).

### 11.3 Privacy

- All entity data stays local by default (sync opt-in per entity).
- No telemetry or external API calls except Wikidata (user-visible, rate-limited).
- Entity extraction can be globally toggled off in extension settings.
- Individual entity types can be toggled (e.g., disable person detection).
- Private/incognito windows should skip entity extraction.

### 11.4 Storage Volume

**Concern: items table overload.** Entity observations will generate high volume data. The items table is the core of Peek — it must stay fast.

Mitigation strategies:
- **Observations are item_events, not items.** The `item_events` table is append-only and designed for high volume. Entity *items* grow slowly (Zipf distribution), but *observations* grow linearly with browsing. Keep them separate.
- **Batch writes**: Collect all extractions from a page, write in a single transaction.
- **Expiration policy**: Observations older than N days can be pruned while preserving the entity item and its frecency. Old observations are low-value — the entity's existence and score matter more than individual sightings.
- **Lazy extraction**: Start with metadata-only extraction (structured data, microformats). Full-text NER generates far more observations — gate behind user opt-in or Phase 2+.
- **Dedup observations**: One observation per entity per URL per day. Don't re-record if the same entity was already seen on the same page today.

Conservative estimates:
- Average page yields 3-5 entity observations (metadata-only extraction).
- 100 pages/day = 300-500 observations/day.
- Each observation is ~200 bytes in item_events.
- 365 days = ~36-73 MB of observations. Manageable for SQLite.
- Unique entities grow slowly (Zipf distribution): ~20-50 new entities/day initially, declining.
- With dedup + expiration, steady-state storage stays well under 100 MB.

### 11.5 Extension Settings Schema

```json
{
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean", "default": true },
    "extractOnPageLoad": { "type": "boolean", "default": true },
    "confidenceThreshold": { "type": "number", "default": 0.5, "minimum": 0.1, "maximum": 1.0 },
    "reextractCooldownMinutes": { "type": "integer", "default": 60 },
    "enabledTypes": {
      "type": "object",
      "properties": {
        "email": { "type": "boolean", "default": true },
        "phone": { "type": "boolean", "default": true },
        "date": { "type": "boolean", "default": true },
        "address": { "type": "boolean", "default": true },
        "person": { "type": "boolean", "default": true },
        "organization": { "type": "boolean", "default": true },
        "place": { "type": "boolean", "default": true },
        "event": { "type": "boolean", "default": true },
        "trackingNumber": { "type": "boolean", "default": true },
        "price": { "type": "boolean", "default": true }
      }
    },
    "wikidataValidation": { "type": "boolean", "default": true },
    "skipInternalPages": { "type": "boolean", "default": true }
  }
}
```

## 12. Dependencies

### External Libraries (Evaluate)

| Library | Purpose | Size | Notes |
|---------|---------|------|-------|
| [microformats-parser](https://github.com/microformats/microformats-parser) | Parse microformats2 | ~15 KB | Mentioned in peek-todo.md |
| [@mozilla/readability](https://github.com/mozilla/readability) | Clean text extraction | ~30 KB | Mentioned in peek-todo.md |
| [chrono-node](https://github.com/wanasit/chrono) | Natural language date parsing | ~150 KB | For date/time entity extraction |
| [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js) | Phone number parsing | ~90 KB (min) | For phone number extraction |

### No External Dependencies Needed For

- Email extraction (regex, already in `app/components/schema.js` FORMATS)
- URL extraction (already exists in multiple places)
- JSON-LD extraction (DOM query + JSON.parse)
- Open Graph extraction (DOM meta tag queries)
- Basic NER heuristics (custom code)
- Wikidata API (fetch + JSON)

## 13. Open Questions

1. **Entity type as tag vs. metadata field**: Using `metadata.entityType` keeps entity classification in structured data. Using tags (e.g., `entity:person`) makes it filterable through existing tag UI. Recommendation: both -- store in metadata AND auto-tag.

2. **Entity identity across devices**: Wikidata QIDs provide stable identity. For entities without Wikidata matches (e.g., "my friend Alice"), identity relies on name + type + device sync. Potential for duplicates across devices -- merge UI is essential.

3. **Table extraction**: The todo mentions "extract a table as CSV." This is a chaining/connector concern more than an entity concern. Tables could be extracted by the lists/csv command pipeline, with entities extracted from table cell contents.

4. **Calendar integration**: The todo mentions "layer outside of web page, and in between pages (eg event page -> event -> any calendar page)." This is entity-triggered action: detect event entity -> offer "add to calendar" action. Implementation depends on calendar connector (Phase 3+).

5. **Observation granularity**: Should we record one observation per entity per page load, or one per occurrence on the page? Recommendation: one per page load (observation = "entity X was seen on page Y at time T"), with occurrence count in observation metadata.

6. **Background reprocessing**: Should the extension reprocess historical URLs? Yes, but as a low-priority background task, processing a few URLs per minute to avoid resource contention. Gate behind user opt-in.
