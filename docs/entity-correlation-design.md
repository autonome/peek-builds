# Entity Correlation System Design

**Date:** 2026-02-19
**Status:** Design proposal — not yet implemented

---

## 1. Current State Analysis

### How Entities Work Today

Entities are stored as items in the unified `items` table with `type = 'entity'`. Each entity item has:

- **`content`**: The canonical name (e.g., "Elon Musk")
- **`metadata`** (JSON): `entityType`, `aliases[]`, `attributes{}`, `confidence`, `extractor`, `mergedFrom[]`, `feedback{}`
- **`visitCount`** / **`lastVisitAt`** / **`frecencyScore`**: Tracking how often/recently the entity appears

Observations (entity X was seen on page Y) are stored as `item_events` rows:

- **`itemId`**: Points to the entity item
- **`content`**: The source page URL
- **`value`**: Extraction confidence for that observation
- **`occurredAt`**: Timestamp
- **`metadata`** (JSON): `extractor`, `pageTitle`, `extractedText`, `context`

### Entity Types

The system recognizes these entity types: `person`, `organization`, `place`, `event`, `email`, `phone`, `date`, `product`, `creative_work`, `tracking_number`, `price`.

### Extractors

Three extractors run in parallel on each page:

1. **JSON-LD / structured data** (highest confidence, 0.85-0.9): Parses `<script type="application/ld+json">`, maps schema.org types to entity types. Also extracts OG meta tags and standard meta tags (author, publisher).
2. **Microformats** (high confidence, 0.9-0.95): Parses h-card, h-event, h-adr markup.
3. **Regex** (variable confidence, 0.6-0.9): Extracts emails, phone numbers, addresses, tracking numbers from raw text.

### What's Missing

Entities are entirely flat. Each entity knows which pages it appeared on (via `item_events`), but there is no concept of:

- Which entities appear together on the same pages
- How strongly two entities are related
- Clusters of related entities
- Entity identity across name variations (limited alias support exists but is only used at extraction time)

The raw data for co-occurrence already exists in `item_events` — we just need to derive relationships from it.

---

## 2. Co-occurrence Model

### Core Insight

Two entities are related if they appear on the same pages. The more pages they share, and the fewer total pages each appears on independently, the stronger the signal. This is essentially the same statistical reasoning behind TF-IDF, applied to entity pairs instead of document terms.

### Data Structure: Edge Table

The fundamental unit is a **weighted edge** between two entities:

```
entity_correlations:
  entityA TEXT NOT NULL      -- entity item ID (lexicographically smaller)
  entityB TEXT NOT NULL      -- entity item ID (lexicographically larger)
  cooccurrenceCount INTEGER  -- number of pages where both appear
  pmi REAL                   -- pointwise mutual information score
  lastCooccurrence INTEGER   -- timestamp of most recent shared page
  firstCooccurrence INTEGER  -- timestamp of first shared page
  updatedAt INTEGER          -- when this edge was last recalculated
  PRIMARY KEY (entityA, entityB)
```

The canonical ordering (entityA < entityB lexicographically) ensures each pair is stored exactly once.

### Why PMI Over Raw Count

Raw co-occurrence count is misleading. If "Google" appears on 200 of your pages and "Chrome" appears on 150, they'll co-occur frequently just by volume. PMI (Pointwise Mutual Information) corrects for this:

```
PMI(a, b) = log2( P(a,b) / (P(a) * P(b)) )
```

Where:
- `P(a,b)` = pages where both a and b appear / total pages with any entity
- `P(a)` = pages where a appears / total pages with any entity
- `P(b)` = pages where b appears / total pages with any entity

PMI is positive when entities co-occur more than chance, zero when independent, and negative when they avoid each other. For our purposes, we only care about positive PMI.

**Normalized PMI (NPMI)** bounds the score to [-1, 1]:

```
NPMI(a, b) = PMI(a, b) / -log2(P(a,b))
```

NPMI = 1 means perfect co-occurrence (they always appear together), NPMI = 0 means independence. This is more interpretable and comparable across entity pairs with different frequencies.

### Temporal Decay

Recent co-occurrences should matter more than old ones. Rather than decaying the PMI score itself (which would require continuous recomputation), we apply decay at query time:

```
effective_score = NPMI * decay_factor
decay_factor = 1 / (1 + days_since_last_cooccurrence / 30)
```

This uses the same decay shape as the existing frecency calculation in the codebase (see `entity-store.js` line 103), with a 30-day half-life instead of 7 days — relationships are stickier than individual entity relevance.

The `lastCooccurrence` timestamp on each edge enables this without recomputing PMI.

---

## 3. Entity Resolution

### The Problem

The same real-world entity appears under different names:
- "Elon Musk" / "Musk" / "@elonmusk" / "Elon R. Musk"
- "United States" / "US" / "USA" / "the United States of America"
- "SpaceX" / "Space Exploration Technologies Corp."

### Current State

The system already has an `aliases` array in entity metadata and `normalizeName()` (lowercase, trim, remove diacritics) for matching. But aliases are only populated when extraction finds an exact match — there's no fuzzy matching or alias discovery.

### Proposed Approach: Layered Resolution

Rather than one complex system, use three simple layers that each catch different cases:

#### Layer 1: Normalized Exact Match (exists today)

`normalizeName()` already handles case, whitespace, and diacritics. This catches "Elon Musk" vs "elon musk" vs "Elon  Musk".

#### Layer 2: Token-Based Similarity

For person names, check if one name is a subset of another:

```javascript
function isNameVariant(nameA, nameB) {
  const tokensA = normalizeName(nameA).split(' ');
  const tokensB = normalizeName(nameB).split(' ');

  // "Musk" matches "Elon Musk" (surname substring)
  if (tokensA.length === 1 && tokensB.includes(tokensA[0])) return true;
  if (tokensB.length === 1 && tokensA.includes(tokensB[0])) return true;

  // "E. Musk" matches "Elon Musk" (initial + surname)
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const lastA = tokensA[tokensA.length - 1];
    const lastB = tokensB[tokensB.length - 1];
    if (lastA === lastB) {
      // Same surname — check if first names are compatible
      const firstA = tokensA[0];
      const firstB = tokensB[0];
      if (firstA[0] === firstB[0]) return true; // Same initial
    }
  }

  return false;
}
```

This is conservative — it won't merge "John Smith" and "Jane Smith" because we require initial match. Apply only within the same `entityType`.

#### Layer 3: Co-occurrence-Based Alias Detection

If two entities of the same type have very high NPMI (> 0.8) and one has significantly fewer observations than the other, the rarer one is likely an alias. This catches "@elonmusk" being an alias of "Elon Musk" — they'll always appear on the same pages (Twitter/X profiles).

Criteria for automatic merge suggestion:
- Same `entityType`
- NPMI > 0.8
- One entity has < 3 observations
- The rarer entity's observations are a subset of the more common entity's observation pages

This should be surfaced as a **suggestion** in the UI rather than automatically merged, at least initially. Users can confirm or reject merges.

#### What We Don't Do

We deliberately avoid:
- **Levenshtein distance**: Too many false positives at short edit distances ("Mars" vs "Musk")
- **External knowledge bases**: Wikidata validation is being researched separately (see `docs/entity-validation-research.md`) and can feed into resolution later
- **ML embeddings**: Overkill for hundreds of entities; adds significant complexity

---

## 4. Signal vs. Noise

### Problem

Not all co-occurrences are meaningful. Boilerplate entities (the publisher name, the site author) co-occur with everything on that site. Generic entities ("United States", "Google") appear everywhere.

### Statistical Filters

#### Minimum Co-occurrence Threshold

Require at least **3 co-occurrences** before storing an edge. A single shared page is noise; two could be coincidence; three starts to be a pattern. At this scale (hundreds of pages), this is a practical cutoff.

```sql
-- Only create/maintain edges where cooccurrenceCount >= 3
```

#### PMI Minimum

Only retain edges with **NPMI > 0.1**. This filters out pairs that co-occur roughly at chance level. NPMI of 0.1 means they co-occur about 10% more than you'd expect by random chance.

#### Maximum Frequency Cap

Entities that appear on more than 30% of all entity-bearing pages are "stopword entities" — too common to be informative. Examples: the user's own name, their employer, "Google", "United States". Exclude them from correlation computation (but don't delete them as entities).

```javascript
const FREQUENCY_CAP = 0.3; // entities on >30% of pages are excluded from correlation
```

This is analogous to TF-IDF's inverse document frequency — the most common terms carry the least information.

#### Per-Site Deduplication

If a user reads 20 articles on nytimes.com, the NYT publisher entity will co-occur with every entity from those articles. To prevent site-level boilerplate from dominating:

Count co-occurrences by **unique domains**, not raw page count. Two entities co-occurring across 3 different domains is a much stronger signal than co-occurring on 3 pages from the same domain.

```
entity_correlations:
  ...
  domainCount INTEGER  -- number of unique domains where both appear
```

Use `domainCount` as the primary co-occurrence signal rather than raw page count for PMI calculation.

---

## 5. Clustering

### Algorithm Choice: Connected Components with Threshold

For the scale of hundreds to low thousands of entities, sophisticated graph community detection (Louvain, Girvan-Newman) is unnecessary. A simple threshold-based approach works well:

1. Build an adjacency graph from edges with NPMI > 0.3
2. Find connected components using BFS/DFS
3. Within each component, identify the "hub" entity (highest degree, i.e., most connections)

This naturally produces clusters like:
- {Elon Musk, Tesla, SpaceX, SEC, Fremont} — a tech/business cluster
- {Biden, Congress, White House, legislation} — a politics cluster
- {React, JavaScript, Node.js, npm} — a tech stack cluster

### Hierarchical Clustering (Future)

For finer-grained clustering within large components, use a simple single-linkage approach:

1. Start with NPMI > 0.6 (tight clusters)
2. If a component has > 20 entities, try a higher threshold (0.5) to break it into subclusters
3. Present as nested groups: "Tech" > "SpaceX ecosystem", "Tesla ecosystem"

This is a future enhancement — connected components at a single threshold is the MVP.

### Cluster Metadata

Each cluster gets derived metadata:

```javascript
{
  id: 'cluster_abc123',
  entities: ['entity_id_1', 'entity_id_2', ...],
  hub: 'entity_id_1',           // most connected entity
  dominantType: 'person',       // most common entity type in cluster
  label: 'Elon Musk',           // hub entity name as default label
  totalObservations: 45,        // sum of entity observations
  lastActivity: 1708300000000,  // most recent observation timestamp
  density: 0.72                 // ratio of actual edges to possible edges
}
```

Clusters are ephemeral — computed on demand from the edge table, not stored permanently. They change as new browsing data arrives.

---

## 6. Schema Design

### New Table: `entity_correlations`

```sql
CREATE TABLE IF NOT EXISTS entity_correlations (
  entityA TEXT NOT NULL,
  entityB TEXT NOT NULL,
  cooccurrenceCount INTEGER NOT NULL DEFAULT 0,
  domainCount INTEGER NOT NULL DEFAULT 0,
  npmi REAL NOT NULL DEFAULT 0,
  lastCooccurrence INTEGER NOT NULL DEFAULT 0,
  firstCooccurrence INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entityA, entityB),
  FOREIGN KEY(entityA) REFERENCES items(id),
  FOREIGN KEY(entityB) REFERENCES items(id)
);

CREATE INDEX IF NOT EXISTS idx_entity_corr_a ON entity_correlations(entityA);
CREATE INDEX IF NOT EXISTS idx_entity_corr_b ON entity_correlations(entityB);
CREATE INDEX IF NOT EXISTS idx_entity_corr_npmi ON entity_correlations(npmi DESC);
CREATE INDEX IF NOT EXISTS idx_entity_corr_updated ON entity_correlations(updatedAt);
```

### New Table: `entity_page_map` (Denormalized Lookup)

The existing `item_events` table already stores entity-page relationships, but querying "which entities appeared on page X" requires scanning all events. A denormalized lookup table makes co-occurrence computation fast:

```sql
CREATE TABLE IF NOT EXISTS entity_page_map (
  entityId TEXT NOT NULL,
  pageUrl TEXT NOT NULL,
  pageDomain TEXT NOT NULL,
  observedAt INTEGER NOT NULL,
  PRIMARY KEY (entityId, pageUrl),
  FOREIGN KEY(entityId) REFERENCES items(id)
);

CREATE INDEX IF NOT EXISTS idx_entity_page_url ON entity_page_map(pageUrl);
CREATE INDEX IF NOT EXISTS idx_entity_page_domain ON entity_page_map(pageDomain);
```

This table is populated from `item_events` during initial setup and kept in sync as new observations arrive. It's a materialized view — the source of truth remains `item_events`.

### New Table: `entity_merge_suggestions`

```sql
CREATE TABLE IF NOT EXISTS entity_merge_suggestions (
  id TEXT PRIMARY KEY,
  entityA TEXT NOT NULL,
  entityB TEXT NOT NULL,
  reason TEXT NOT NULL,         -- 'name_variant', 'high_cooccurrence', 'manual'
  confidence REAL NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'accepted', 'rejected'
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER DEFAULT 0,
  FOREIGN KEY(entityA) REFERENCES items(id),
  FOREIGN KEY(entityB) REFERENCES items(id)
);
```

### Query Patterns

The schema is designed around these primary queries:

**"Show me everything related to entity X":**
```sql
SELECT entityB AS relatedId, npmi, cooccurrenceCount, domainCount
FROM entity_correlations
WHERE entityA = ? AND npmi > 0.1
UNION ALL
SELECT entityA AS relatedId, npmi, cooccurrenceCount, domainCount
FROM entity_correlations
WHERE entityB = ? AND npmi > 0.1
ORDER BY npmi DESC
LIMIT 20;
```

**"What clusters exist" (all edges above threshold):**
```sql
SELECT entityA, entityB, npmi
FROM entity_correlations
WHERE npmi > 0.3
ORDER BY npmi DESC;
```

Then compute connected components in JavaScript — the result set will be small (hundreds of edges at most).

**"What's trending" (recently active correlations):**
```sql
SELECT entityA, entityB, npmi, lastCooccurrence
FROM entity_correlations
WHERE lastCooccurrence > ? AND npmi > 0.2
ORDER BY lastCooccurrence DESC
LIMIT 50;
```

**"Which entities co-occurred on this page":**
```sql
SELECT entityId FROM entity_page_map WHERE pageUrl = ?;
```

---

## 7. Incremental Update Strategy

### Trigger: New Observation

When `addObservation()` records that entity X was seen on page Y:

1. **Update `entity_page_map`**: Insert or ignore `(X, Y, domain(Y), now)`
2. **Find co-occurring entities**: Query `entity_page_map` for all other entities on page Y
3. **Update edges**: For each co-occurring entity Z, upsert `entity_correlations(X, Z)`:
   - Increment `cooccurrenceCount`
   - Recalculate `domainCount` from `entity_page_map`
   - Update `lastCooccurrence`
   - Recalculate NPMI (requires total page count — cache this)

### Batch Recomputation

NPMI depends on global statistics (total pages, per-entity page counts) that change with every page visit. Rather than recomputing every edge on every observation, use a two-tier strategy:

**Tier 1 — Immediate (per observation):**
- Update `cooccurrenceCount` and `lastCooccurrence` for affected edges
- Use cached global stats for approximate NPMI

**Tier 2 — Periodic (background):**
- Every 50 new observations (or on app startup), recompute NPMI for all edges
- Update global stats cache
- Prune edges below minimum thresholds
- Generate merge suggestions from high-NPMI same-type pairs

The periodic recomputation is fast — at the scale of hundreds of entities, the correlation table will have at most a few thousand edges. A full recompute takes milliseconds in SQLite.

### Initial Bootstrap

On first run (or when the feature is enabled), populate `entity_page_map` from existing `item_events`:

```sql
INSERT OR IGNORE INTO entity_page_map (entityId, pageUrl, pageDomain, observedAt)
SELECT ie.itemId, ie.content, ?, ie.occurredAt
FROM item_events ie
JOIN items i ON ie.itemId = i.id
WHERE i.type = 'entity' AND i.deletedAt = 0;
```

Then compute all pairwise co-occurrences and NPMI scores. For N entities, the worst case is N*(N-1)/2 pairs, but the minimum co-occurrence threshold of 3 will prune most of these.

### Where This Code Lives

The correlation engine should be a **backend module** (`apps/desktop/main/entity-correlations.ts`), not an extension. Reasons:

- It needs direct SQLite access for efficient batch queries
- It runs on the main process, not in extension renderer
- The entity extension calls it via IPC

The extension side (`extensions/entities/`) handles UI and user interaction. The backend handles data and computation.

---

## 8. UI Concepts

### 8.1 Related Entities Panel (MVP)

The simplest useful UI: when viewing an entity's detail page (which already exists in `home.js`), show a "Related Entities" section below "Source Pages":

```
─── Related Entities ───────────────────
  Elon Musk        ████████░░  0.82  (person)
  SEC              ██████░░░░  0.61  (organization)
  Fremont, CA      █████░░░░░  0.54  (place)
  NHTSA            ████░░░░░░  0.41  (organization)
```

Each row is clickable, navigating to that entity's detail view. The bar represents NPMI score. This requires minimal UI changes — just a new section in the existing detail view.

### 8.2 Cluster View

A new tab/mode in the entities browser that shows clusters instead of individual entities:

```
Clusters
─────────────────────────────────
┌──────────────────────┐  ┌──────────────────────┐
│ Tesla Ecosystem      │  │ Web Standards         │
│ 8 entities           │  │ 5 entities            │
│ ───────────────────  │  │ ───────────────────   │
│ Elon Musk (hub)      │  │ W3C (hub)             │
│ Tesla, SpaceX, SEC   │  │ WHATWG, IndieWeb       │
│ + 4 more             │  │ + 2 more              │
│                      │  │                       │
│ Last active: 2h ago  │  │ Last active: 1d ago   │
└──────────────────────┘  └──────────────────────┘
```

Clicking a cluster expands it to show all member entities and their interconnections.

### 8.3 Graph Visualization (Future)

A force-directed graph where:
- Nodes are entities (sized by observation count, colored by type)
- Edges are correlations (thickness proportional to NPMI)
- Clusters naturally separate in the layout

This is the most visually compelling but also the most complex to implement. Use a lightweight library like `d3-force` (already reasonable in an Electron renderer).

This should be a later phase — the related entities panel and cluster view provide most of the value with far less implementation effort.

### 8.4 Contextual Correlation Display

When browsing a web page, show a subtle indicator of how the entities on the current page relate to the user's existing knowledge graph. This could be:
- A sidebar showing "You've seen these entities before, and they're related to X, Y, Z"
- A badge on the entities extension icon showing how many correlated entities were found

This is speculative and depends on the page-level entity display being implemented first.

---

## 9. Implementation Phases

### Phase 1: Foundation (MVP)

**Goal:** Build the correlation data pipeline and show basic "related entities" in the UI.

1. Add `entity_correlations` and `entity_page_map` tables via datastore migration
2. Implement `entity-correlations.ts` backend module with:
   - `updateCorrelationsForPage(pageUrl, entityIds[])` — called after extraction
   - `getRelatedEntities(entityId, limit)` — query for UI
   - `recomputeAllCorrelations()` — batch recompute
3. Bootstrap from existing `item_events` data
4. Add "Related Entities" section to entity detail view in `home.js`
5. Wire extraction pipeline to call `updateCorrelationsForPage` after `processEntities`

**Estimated scope:** ~500 lines of backend code, ~100 lines of UI additions.

### Phase 2: Signal Quality

**Goal:** Improve correlation quality with noise filtering and domain-aware scoring.

1. Implement domain-based co-occurrence counting
2. Add frequency cap filtering (>30% entities excluded)
3. Periodic NPMI recomputation on app startup
4. Prune stale/weak edges (NPMI < threshold and no co-occurrence in 90 days)

### Phase 3: Entity Resolution

**Goal:** Detect and suggest entity merges.

1. Implement token-based name variant detection (Layer 2)
2. Implement co-occurrence-based alias detection (Layer 3)
3. Add `entity_merge_suggestions` table and UI for accepting/rejecting
4. Merge operation: combine observations, update aliases, redirect correlations

### Phase 4: Clustering & Visualization

**Goal:** Surface higher-level structure.

1. Implement connected-component clustering
2. Add cluster view to entities browser
3. Cluster metadata computation (hub, label, density)
4. Optional: force-directed graph visualization with d3-force

### Phase 5: Contextual Integration

**Goal:** Surface correlations during browsing.

1. After entity extraction, check how page entities relate to existing clusters
2. Show contextual "related to your interests" indicators
3. Integration with groups/workspaces — suggest grouping related pages by entity cluster

---

## 10. Performance Considerations

### Scale Estimates

For a personal browser:
- **Entities:** 100-2,000 (after months of use)
- **Pages with entities:** 200-5,000
- **Entity-page pairs:** 500-20,000
- **Correlation edges:** 200-5,000 (after threshold filtering)
- **Clusters:** 10-100

### SQLite Performance

All operations are well within SQLite's comfort zone:

- **Pairwise co-occurrence computation**: For 1,000 entities across 2,000 pages, the entity_page_map has ~10,000 rows. Finding all pairs for a single page (say 5 entities = 10 pairs) is a simple index lookup. The full batch recompute touches at most a few thousand edges.

- **NPMI calculation**: Pure arithmetic on cached counts. Sub-millisecond per edge.

- **Cluster computation**: Loading all edges above threshold (a few hundred rows) into memory and running BFS takes microseconds.

### Memory

The correlation engine maintains in memory:
- Global page count (one integer)
- Per-entity page count cache (Map of ~1,000 entries)
- Nothing else — everything else is queried from SQLite on demand

---

## 11. Open Questions

1. **Should correlations cross entity types?** A person and an organization co-occurring is interesting ("Elon Musk" + "Tesla"). But should a person and a phone number be correlated? Probably yes — if an email address always appears with a person name, that's a useful signal. Start with cross-type correlations and filter in the UI if needed.

2. **How to handle entity deletion?** When a user thumbs-down an entity (existing feature), should its correlations be removed? Probably yes — cascade the deletion to `entity_correlations` and `entity_page_map`. This keeps the graph clean.

3. **Extension vs. backend boundary:** The correlation engine does heavy SQL work and should live in the backend. But the entity extraction pipeline lives in the extension. The cleanest boundary: the extension publishes `entities:extracted` events (already happens), and the backend subscribes to compute correlations. The extension queries correlations via IPC for display.

4. **Privacy implications:** The correlation graph is a dense summary of browsing interests. It should follow the same data storage and sync policies as other Peek data. No new privacy concerns beyond what entity extraction already introduces.
