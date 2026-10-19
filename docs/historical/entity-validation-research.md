# Entity Validation/Evaluation Framework Research

*Historical: research into validating extracted entity types against external knowledge bases; not current guidance.*

**Date:** 2026-02-18
**Status:** Research — not yet implemented

## Problem Statement

The current entity extraction system uses a growing collection of ad-hoc filters (blocklists, minimum name lengths, confidence thresholds, per-type field requirements) that fail to catch fundamental misclassifications. The core issue: **we have no way to validate that an extracted name is actually the claimed entity type.**

Examples of failures the current system cannot prevent:
- "IndieWeb" extracted as Person from `og:type=profile` (it is a movement/website)
- Wikipedia JSON-LD producing short abbreviation entities (LOC, WI, TA, GR)
- "Main Page" stored as a creative work
- Single-word organization names mistyped as persons
- Sites using `og:type=profile` for non-person pages

The filtering code in `entity-matcher.js` and `structured-data.js` has grown reactively — each new garbage entity type triggers a new heuristic. This document evaluates structured alternatives.

---

## 1. Wikidata API for Entity Type Validation

### How It Works

Wikidata provides a free, open knowledge base with ~110M items. The relevant API flow:

1. **Search:** `wbsearchentities` — find candidate entities by name
   ```
   GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=IndieWeb&language=en&format=json
   ```
   Returns a list of matching Wikidata items with IDs (e.g., Q16917531).

2. **Validate type:** `wbgetentities` — fetch the item and check its `P31` (instance of) claim
   ```
   GET https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q16917531&props=claims&format=json
   ```
   Check if `claims.P31` includes `Q5` (human), `Q43229` (organization), `Q515` (city), etc.

3. **Type mapping:** Map Wikidata class IDs to our entity types:
   - `Q5` (human) -> `person`
   - `Q43229` (organization), `Q4830453` (business) -> `organization`
   - `Q515` (city), `Q6256` (country), `Q35127` (website) -> not person
   - `Q1656682` (event) -> `event`

### Rate Limits

- **Unauthenticated:** Max 1 concurrent request, 5 req/sec per IP
- **Authenticated (OAuth 2.0):** 5,000 req/hour per user, up to 10 req/sec
- **User-Agent required:** Must provide a descriptive User-Agent header or requests get 403'd
- **SPARQL endpoint:** Separate limits, 60-second query timeout, 5 concurrent queries

### Latency

- `wbsearchentities`: ~100-300ms per request
- `wbgetentities`: ~50-200ms per request (less data)
- Two requests needed per validation: search + fetch claims = ~200-500ms total

### Offline/Local Options

- **Wikidata dumps** are available (JSON, ~100GB uncompressed) — impractical for shipping in an app
- **No lightweight local subset** exists for type lookups
- Could build a local cache of previously validated entities (SQLite or in-memory Map)

### Pros
- Extremely comprehensive coverage (~110M entities)
- Authoritative type information via `P31` (instance of)
- Free, no API key required (though User-Agent is mandatory)
- Would definitively resolve the "IndieWeb as Person" class of bugs
- Can disambiguate: "Apple" -> Q312 (company) vs Q89 (fruit)

### Cons
- Requires network access (no offline-first)
- 200-500ms latency per entity validation — not viable for inline/blocking use
- 5 req/sec unauthenticated rate limit means ~10 entities/page is fine, but bulk processing needs throttling
- Search can return multiple candidates — need disambiguation logic
- Not all entities are in Wikidata (obscure people, small businesses)
- Two-request round trip (search + get claims) adds complexity

### Feasibility: HIGH for async validation

Best used as a post-extraction validation step. Extract entities synchronously, store provisionally, validate asynchronously via Wikidata, then update or remove.

---

## 2. Other Knowledge Bases

### DBpedia / DBpedia Spotlight

- **What:** Knowledge base extracted from Wikipedia, with an entity annotation API
- **API:** `https://api.dbpedia-spotlight.org/en/annotate` — send text, get back annotated entities with DBpedia types
- **Rate limits:** Poorly documented; users report 403 errors after moderate use. Recommended to self-host for production.
- **Pros:** Could annotate full page text, returns typed entities directly (bypasses our extraction entirely)
- **Cons:** Unreliable public API, self-hosting requires ~8GB RAM Java service, latency ~500ms+
- **Verdict:** Too heavy for our use case. Self-hosting a Java service is not viable for a desktop Electron app.

### OpenCyc / Cyc

- **Status:** OpenCyc was discontinued in 2017. Cyc is proprietary.
- **Verdict:** Not viable.

### Google Knowledge Graph Search API

- **What:** Google's knowledge base API — search entities, get types
- **Rate limits:** 100,000 requests/day free tier
- **Pros:** Fast, reliable, good coverage
- **Cons:** Requires API key, Google TOS restrictions, may not be "free/open-source"
- **Verdict:** TOS-incompatible with our constraints but worth noting as a fallback.

### Verdict on Knowledge Bases

Wikidata is the clear winner for our constraints (free, open, comprehensive). DBpedia Spotlight is interesting but operationally too heavy. No other free knowledge base comes close to Wikidata's coverage.

---

## 3. Name Pattern Heuristics

Well-established heuristics for distinguishing person names from organization/brand names without ML:

### Capitalization Patterns

| Pattern | Likely Type | Example |
|---------|-------------|---------|
| First Last (title case, 2 words) | Person | "John Smith" |
| CamelCase single word | Organization/Brand | "IndieWeb", "GitHub" |
| ALL CAPS | Organization/Acronym | "NASA", "FBI" |
| Single word, title case | Ambiguous | "Apple", "Amazon" |
| 3+ words, mixed case | Organization | "World Health Organization" |
| Title + Name | Person | "Dr. Jane Doe", "Prof. Smith" |

### Structural Rules (No External Data)

1. **Two-word names where both start with uppercase** are likely persons
2. **Names containing "Inc", "LLC", "Corp", "Ltd", "Co.", "Foundation", "Association"** are organizations
3. **Names with internal capitalization (CamelCase)** are brands/products, not persons
4. **Names with "&" or "and" between words** are likely organizations ("Ben & Jerry's")
5. **Names that are a single word** are almost never persons (except in some cultures)
6. **Names starting with "The "** are organizations or creative works
7. **Honorific prefixes** (Mr., Mrs., Dr., Prof., Sir, Lady) strongly indicate person

### Implementation Sketch

```javascript
function classifyNamePattern(name) {
  const words = name.trim().split(/\s+/);

  // Org suffixes
  if (/\b(Inc|LLC|Corp|Ltd|Co|Foundation|Association|Institute|University|Museum)\b/i.test(name))
    return { likelyType: 'organization', confidence: 0.9 };

  // Honorific prefix
  if (/^(Mr|Mrs|Ms|Dr|Prof|Sir|Dame|Lady|Lord|Rev|Fr|Sr|Jr)\b\.?\s/i.test(name))
    return { likelyType: 'person', confidence: 0.85 };

  // "The X" pattern
  if (/^The\s/i.test(name) && words.length >= 2)
    return { likelyType: 'organization', confidence: 0.7 };

  // CamelCase single word
  if (words.length === 1 && /^[A-Z][a-z]+[A-Z]/.test(name))
    return { likelyType: 'organization', confidence: 0.75 };

  // ALL CAPS short word (acronym)
  if (words.length === 1 && /^[A-Z]{2,6}$/.test(name))
    return { likelyType: 'organization', confidence: 0.6 };

  // Two-word title case — needs name database to distinguish
  // "John Smith" vs "World Bank"
  if (words.length === 2 && words.every(w => /^[A-Z][a-z]+$/.test(w)))
    return { likelyType: 'ambiguous', confidence: 0.5 };

  return { likelyType: 'unknown', confidence: 0.3 };
}
```

### Pros
- Zero dependencies, zero latency, zero network
- Easy to implement and test
- Catches obvious cases (CamelCase brands, org suffixes, honorifics)
- Works in any JS environment

### Cons
- Cannot distinguish "John Smith" (person) from "World Bank" (org) without external data
- Culture-dependent — many non-Western names don't follow FirstName LastName pattern
- CamelCase heuristic fails for compound proper nouns
- Low confidence on ambiguous cases

### Feasibility: HIGH as a first-pass filter

Should be combined with name databases (see section 5) for the ambiguous cases.

---

## 4. Lightweight NER Options

### compromise.js

- **What:** Client-side NLP library for English text processing
- **Size:** ~210KB minified (estimated ~75KB gzipped) — the library includes built-in lexicon data
- **NER:** Recognizes persons, places, organizations, dates, values natively
- **Speed:** Processes ~1MB/sec (~10 Wikipedia pages per second)
- **API:**
  ```javascript
  import nlp from 'compromise';
  const doc = nlp('Barack Obama visited the United Nations in New York');
  doc.people().out('array');       // ['Barack Obama']
  doc.organizations().out('array'); // ['United Nations']
  doc.places().out('array');        // ['New York']
  ```
- **Pros:**
  - Pure JavaScript, works in browser and Node.js
  - No model files to load — lexicon is built into the library
  - Decent accuracy for well-known entities
  - Can be used to *validate* extracted names: "is 'IndieWeb' recognized as a person?"
  - Active maintenance (Spencer Kelly)
- **Cons:**
  - English only
  - ~210KB adds to bundle size (acceptable for Electron, but not tiny)
  - Accuracy is modest compared to transformer models — relies on lexicon + grammar rules, not ML
  - May not recognize obscure entities
  - Cannot classify arbitrary names it hasn't seen
- **Best use:** Run compromise on extracted entity names to cross-check type claims. If we extracted "IndieWeb" as a person, run `nlp('IndieWeb').people().length === 0` to flag it.

### winkNLP + wink-eng-lite-web-model

- **What:** Performant NLP pipeline with POS tagging and NER
- **Size:** Core ~10KB + model ~1MB (gzipped) = ~1MB total
- **NER entities:** CARDINAL, DATE, DURATION, EMAIL, EMOJI, HASHTAG, MENTION, MONEY, ORDINAL, PERCENT, TIME, URL
- **Speed:** ~650K tokens/sec
- **Limitation:** NER recognizes value types (dates, money, emails) but **does NOT recognize person/organization/place entities**. This makes it unsuitable for our core validation need.
- **Verdict:** Not useful for entity type validation. Its NER is focused on value extraction, not named entity classification.

### wink-ner (standalone)

- **What:** Language-agnostic named entity recognizer using a gazetteer approach
- **Size:** Very small (~5KB), but requires you to supply your own gazetteer (entity dictionary)
- **How it works:** You train it with a list of `{text, entityType}` entries, then it recognizes those exact strings in text
- **Pros:** Tiny, fast, flexible
- **Cons:** Only recognizes entities you've pre-loaded — not useful for validating unknown entities
- **Verdict:** Could be useful for building a local known-entity cache, but doesn't solve the validation problem on its own.

### ONNX Runtime Web + Small NER Model

- **What:** Run a pre-trained NER model (e.g., distilled BERT-NER) via ONNX in the browser
- **Size:** ONNX Runtime Web ~2-5MB + smallest viable NER model ~10-30MB
- **Speed:** Depends on model, typically 10-100ms per sentence on modern hardware
- **Pros:** Real ML-based NER, good accuracy
- **Cons:**
  - 15-35MB total is too large for our "keep the app lightweight" constraint
  - Model loading time adds startup latency
  - ONNX Runtime Web adds complexity (WASM compilation, model management)
  - Overkill for validating extracted entities — we don't need to run NER on raw text, we already have candidate entities
- **Verdict:** Too heavy. We already extract entities via structured data; we need validation, not extraction.

### Recommendation

**compromise.js is the best fit** for lightweight entity type cross-checking. It can verify whether a name "reads as" a person, organization, or place using English grammar and lexicon rules. It is not an authoritative validator, but it catches obvious misclassifications at zero network cost.

---

## 5. Common Name Databases

### Available Datasets

#### US SSA Baby Names
- **Source:** https://www.ssa.gov/oact/babynames/names.zip
- **Content:** Every first name given to 5+ babies in the US, by year, 1880-present
- **Size:** ~8MB compressed, ~30MB uncompressed (yearly CSV files)
- **Format:** `name,sex,count` per year
- **Coverage:** ~100K unique first names with frequency data

#### US Census Bureau Surnames
- **Source:** https://www.census.gov/data/developers/data-sets/surnames.html
- **Content:** Surnames occurring 100+ times in the 2010 census
- **Size:** ~3MB
- **Coverage:** ~160K surnames
- **Format:** CSV with name, rank, count, frequency

#### Philippe Remy's Name Dataset (Facebook-derived)
- **Source:** https://github.com/philipperemy/name-dataset
- **Content:** 730K first names, 983K last names from 106 countries
- **Size:** 3.3GB full, but can be filtered to top-N per country
- **Format:** CSV with country codes

### Practical Approach for Our App

We do NOT need the full datasets. A curated, compact subset would suffice:

1. **Top 5,000 first names** (covers >95% of US/UK names encountered on the web): ~50KB JSON
2. **Top 5,000 surnames** (covers vast majority): ~50KB JSON
3. **Total: ~100KB** shipped with the app

### Implementation Sketch

```javascript
// Shipped as JSON files, loaded once at startup
import firstNames from './data/first-names.json'; // Set of ~5000 names
import surnames from './data/surnames.json';       // Set of ~5000 names

const firstNameSet = new Set(firstNames);
const surnameSet = new Set(surnames);

function isLikelyPersonName(name) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return false;

  const first = words[0];
  const last = words[words.length - 1];

  const firstMatch = firstNameSet.has(first.toLowerCase());
  const lastMatch = surnameSet.has(last.toLowerCase());

  if (firstMatch && lastMatch) return { likely: true, confidence: 0.9 };
  if (firstMatch) return { likely: true, confidence: 0.7 };
  if (lastMatch) return { likely: true, confidence: 0.5 };
  return { likely: false, confidence: 0.3 };
}
```

### Pros
- Fast: O(1) Set lookups, no network
- Compact: ~100KB for useful coverage
- Culturally broad if using the Facebook-derived dataset (106 countries)
- Combined with pattern heuristics, resolves most person vs. org ambiguity

### Cons
- Western-name-biased (SSA/Census are US-centric; Facebook dataset is broader but still skewed)
- False positives: some first names are also common words ("Faith", "Grace", "Hope")
- False negatives: unusual names not in top-5000 won't match
- Needs periodic updates (though name frequency is slow-changing)

### Feasibility: HIGH

This is the highest-value, lowest-effort improvement we can make. A 100KB name database + simple Set lookup would catch the majority of "is this a person name?" questions.

---

## 6. Schema.org Misuse Detection

### The Problem

Many sites misuse schema.org types:
- `og:type=profile` used for organization pages, brand pages, or topic pages
- JSON-LD `@type: Person` for author bylines that are actually organization names
- Overly broad use of `CreativeWork` for navigation elements

### Known Research

A 2015 paper from University of Mannheim ("Heuristics for Fixing Common Errors in Deployed schema.org Microdata") found that heuristics can fix ~71% of type errors in deployed schema.org markup. Common error patterns include:

1. **Type confusion:** Using `Person` when `Organization` is meant (and vice versa)
2. **Overly generic types:** Using `Thing` or `CreativeWork` for everything
3. **Property-type mismatch:** Properties that don't make sense for the claimed type

### Practical Heuristics We Can Apply

1. **Cross-validate OG type with JSON-LD type:** If `og:type=profile` but JSON-LD says `Organization`, trust JSON-LD (it's more specific)

2. **Check property coherence:**
   - A `Person` should have person-like properties (givenName, familyName, jobTitle)
   - An `Organization` should have org-like properties (logo, foundingDate, numberOfEmployees)
   - If a "Person" has no person-like properties, downgrade confidence

3. **URL pattern heuristics:**
   - `/about`, `/team`, `/staff` pages with `og:type=profile` are likely organization/team pages
   - `/wiki/` pages with short entity names are likely Wikipedia navigation artifacts

4. **Name-type cross-check:** Use the name pattern heuristics (section 3) and name databases (section 5) to validate the claimed type

### Implementation

This doesn't require new infrastructure — it's enhancements to the existing `structured-data.js` extractor:

```javascript
function validateEntityType(entity, html, url) {
  // Cross-check: does the name pattern match the claimed type?
  if (entity.entityType === 'person') {
    const nameCheck = isLikelyPersonName(entity.name);
    if (!nameCheck.likely) {
      // Name doesn't look like a person — check if it looks like an org
      const patternCheck = classifyNamePattern(entity.name);
      if (patternCheck.likelyType === 'organization') {
        entity.entityType = 'organization';
        entity.confidence *= 0.8; // reduce confidence for reclassified entities
      }
    }
  }

  // OG type "profile" without person-like properties → likely misuse
  if (entity.extractor === 'opengraph' && entity.entityType === 'person') {
    const hasPersonProps = entity.attributes.email ||
                           entity.attributes.jobTitle ||
                           entity.attributes.organization;
    if (!hasPersonProps && !isLikelyPersonName(entity.name).likely) {
      return null; // reject
    }
  }

  return entity;
}
```

### Feasibility: HIGH

These are refinements to existing code, not new systems. Low effort, high impact.

---

## 7. Recommended Hybrid Approach

Based on the analysis above, here is the recommended multi-layer validation architecture:

### Layer 1: Name Pattern Heuristics (synchronous, inline)
- **When:** During extraction, before storing
- **What:** Check capitalization patterns, org suffixes, honorifics, CamelCase
- **Effect:** Reject or reclassify obvious mismatches
- **Effort:** ~2 hours, pure JS, no dependencies
- **Files:** New `extensions/entities/validators/name-patterns.js`

### Layer 2: Name Database Lookup (synchronous, inline)
- **When:** During extraction, for person-type entities
- **What:** Check if name follows firstname+lastname pattern using local name sets
- **Effect:** High-confidence person validation; flag non-matching "person" entities for review
- **Effort:** ~4 hours (curate datasets, build lookup, integrate)
- **Data files:** `extensions/entities/data/first-names.json` (~50KB), `extensions/entities/data/surnames.json` (~50KB)
- **Source data:** SSA baby names (top 5000 by frequency) + Census surnames (top 5000)

### Layer 3: compromise.js Cross-Check (synchronous, inline, optional)
- **When:** For borderline entities that pass Layers 1-2 but have moderate confidence
- **What:** Run the entity name through compromise.js to see if it classifies as the expected type
- **Effect:** Catches cases where name databases miss but English grammar patterns help
- **Effort:** ~3 hours (add dependency, integrate, test)
- **Trade-off:** Adds ~210KB to bundle. Could be made optional/lazy-loaded.
- **Recommendation:** Defer this to Phase 2. Layers 1+2 will catch 80%+ of issues.

### Layer 4: Wikidata Async Validation (asynchronous, post-storage)
- **When:** After entities are stored provisionally, in background
- **What:** Query Wikidata to validate entity type claims for entities with confidence < 0.9
- **Effect:** Authoritative type correction; can reclassify or remove mistyped entities
- **Effort:** ~8 hours (API client with caching, rate limiting, type mapping, cache persistence)
- **Files:** New `extensions/entities/validators/wikidata.js`, cache in datastore
- **Rate limiting:** Queue-based, max 3 req/sec, with local cache to avoid re-querying known entities
- **Cache:** Store Wikidata validation results permanently per entity name. Most entities will only need one lookup ever.

### Layer 5: Schema.org Coherence Checks (synchronous, inline)
- **When:** During structured-data extraction
- **What:** Validate that claimed types have coherent properties; cross-check OG vs JSON-LD
- **Effect:** Reject incoherent type claims at source
- **Effort:** ~3 hours (enhancements to existing `structured-data.js`)

### Processing Flow

```
Page HTML
  |
  v
[Extractors: regex, microformats, JSON-LD, OG tags]
  |
  v
[Layer 5: Schema.org coherence check]  -- reject incoherent extractions
  |
  v
[Layer 1: Name pattern heuristics]      -- reclassify obvious mismatches
  |
  v
[Layer 2: Name database lookup]         -- validate person claims
  |
  v
[Existing: blocklist, confidence threshold, dedup]
  |
  v
[Store entity provisionally]
  |
  v (async, background)
[Layer 4: Wikidata validation]           -- authoritative type check
  |
  v
[Update entity type/confidence OR mark as invalid]
```

---

## Implementation Plan

### Phase 1 (Immediate, ~1 week)

**Goal:** Eliminate the most common garbage entities with zero new dependencies.

1. **Name pattern heuristics** (`validators/name-patterns.js`)
   - CamelCase detection, org suffix detection, honorific detection
   - Integrate into `entity-matcher.js` `processEntities()` pipeline

2. **Name database** (`data/first-names.json`, `data/surnames.json`)
   - Curate top-5000 lists from SSA + Census data
   - `validators/name-lookup.js` — `isLikelyPersonName(name)` function
   - Gate person-type entities: reject if name doesn't match person pattern AND has no person-specific properties

3. **Schema.org coherence** (enhance `structured-data.js`)
   - Reject `og:type=profile` entities that fail person-name check
   - Add property-coherence scoring per type
   - Cross-validate OG vs JSON-LD when both present

**Estimated impact:** Resolves ~80% of current misclassification issues.

### Phase 2 (Follow-up, ~1 week)

**Goal:** Add authoritative async validation for borderline cases.

4. **Wikidata validator** (`validators/wikidata.js`)
   - Queue-based async validation with rate limiting
   - Local cache (in datastore) for validated entities
   - Background process: validate stored entities with confidence < 0.9
   - Update entity type/confidence based on Wikidata `P31` claims
   - Respect Wikimedia User-Agent policy

5. **Validation status in UI**
   - Show validation status on entity cards (pending, validated, rejected)
   - Allow manual override of auto-validation results

### Phase 3 (Optional)

6. **compromise.js integration** — lazy-loaded, for edge cases Layer 1+2 miss
7. **International name support** — broader name datasets from Facebook-derived data
8. **Learning from feedback** — use thumbs-up/down data to tune confidence thresholds per extractor

---

## Estimated Total Effort

| Phase | Component | Effort | Dependencies |
|-------|-----------|--------|-------------|
| 1 | Name pattern heuristics | 2h | None |
| 1 | Name database + lookup | 4h | SSA/Census data curation |
| 1 | Schema.org coherence | 3h | None |
| 2 | Wikidata validator | 8h | Network, caching |
| 2 | UI validation status | 3h | Phase 2 validator |
| 3 | compromise.js | 3h | npm dependency (~210KB) |
| **Total** | | **~23h** | |

Phase 1 alone (9 hours) delivers the majority of the value with zero new runtime dependencies and zero network requirements.

---

## Summary of Approaches

| Approach | Type | Latency | Accuracy | Size Impact | Best For |
|----------|------|---------|----------|-------------|----------|
| Name patterns | Local, sync | <1ms | Medium | 0 | Obvious mismatches |
| Name databases | Local, sync | <1ms | High (for Western names) | ~100KB | Person validation |
| compromise.js | Local, sync | ~5ms | Medium | ~210KB | English grammar validation |
| winkNLP | Local, sync | ~2ms | N/A (no person/org NER) | ~1MB | NOT useful for this |
| Wikidata API | Remote, async | 200-500ms | Very high | 0 (+ cache) | Authoritative validation |
| DBpedia Spotlight | Remote, async | 500ms+ | High | 0 | NOT viable (unreliable API) |
| ONNX NER model | Local, sync | 10-100ms | High | 15-35MB | Too heavy for us |

**Recommended path: Phase 1 (name patterns + name DB + schema coherence) for immediate wins, Phase 2 (Wikidata async) for authoritative coverage.**
