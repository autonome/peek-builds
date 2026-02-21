# Research: Generating UIs from AT Protocol Lexicons

**Date:** 2026-02-19
**Goal:** Enable users to select any lexicon and get an auto-generated form to create and publish records to their AT Protocol repo, all from within Peek's lex extension.

---

## Table of Contents

1. [Lexicon Schema Format](#1-lexicon-schema-format)
2. [Fetching Lexicon Definitions at Runtime](#2-fetching-lexicon-definitions-at-runtime)
3. [Schema-to-Form Mapping](#3-schema-to-form-mapping)
4. [Creating Records via XRPC](#4-creating-records-via-xrpc)
5. [Practical Considerations](#5-practical-considerations)
6. [Existing Prior Art](#6-existing-prior-art)
7. [Proposed Architecture for lex](#7-proposed-architecture-for-lex)
8. [Phased Implementation Plan](#8-phased-implementation-plan)
9. [Open Questions and Gotchas](#9-open-questions-and-gotchas)

---

## 1. Lexicon Schema Format

### Structure Overview

Every lexicon is a JSON file with this top-level shape:

```json
{
  "lexicon": 1,
  "id": "app.bsky.feed.post",
  "defs": {
    "main": { ... },
    "someOtherDef": { ... }
  }
}
```

- `lexicon`: Always `1` (current version)
- `id`: The NSID (Namespaced Identifier) — reverse-domain format like `app.bsky.feed.post`
- `defs`: Map of definition names to schema objects. `main` is the primary definition.

### Primary Types

| Type | Purpose |
|------|---------|
| `record` | Data objects stored in repositories — **this is what we generate forms for** |
| `query` | XRPC GET endpoint |
| `procedure` | XRPC POST endpoint |
| `subscription` | Event stream (WebSocket) |

### Record Definition Structure

A `record` definition contains a `record` field which is an `object` schema:

```json
{
  "main": {
    "type": "record",
    "description": "Record containing a Bluesky post.",
    "key": "tid",
    "record": {
      "type": "object",
      "required": ["text", "createdAt"],
      "properties": {
        "text": {
          "type": "string",
          "maxLength": 3000,
          "maxGraphemes": 300
        },
        "createdAt": {
          "type": "string",
          "format": "datetime"
        }
      }
    }
  }
}
```

### Complete Field Type Reference

Gathered from the official Lexicon spec at atproto.com/specs/lexicon:

#### Concrete Types

| Type | Attributes | Notes |
|------|-----------|-------|
| `boolean` | `default`, `const` | |
| `integer` | `minimum`, `maximum`, `enum`, `default`, `const` | Signed integer |
| `string` | `format`, `maxLength`, `minLength`, `maxGraphemes`, `minGraphemes`, `knownValues`, `enum`, `default`, `const` | Unicode, lengths in UTF-8 bytes |
| `bytes` | `minLength`, `maxLength` | JSON: `{"$bytes": "<base64>"}` |
| `cid-link` | (none) | Content hash reference. JSON: `{"$link": "<cid>"}` |
| `blob` | `accept` (MIME types, supports `image/*` globs), `maxSize` (bytes) | Reference to uploaded binary data |

#### Container Types

| Type | Attributes | Notes |
|------|-----------|-------|
| `array` | `items` (schema), `minLength`, `maxLength` | Elements described by `items` |
| `object` | `properties` (map), `required` (string[]), `nullable` (string[]) | Nested object |

#### Meta Types

| Type | Purpose |
|------|---------|
| `ref` | Reference to another definition. Has `ref` field with value like `#localDef` or `com.atproto.repo.strongRef` |
| `union` | One of several types. Has `refs` array. Each referenced type must be an object-like type with `$type` discriminator |
| `unknown` | Any value, no validation. Used for the `record` field in `createRecord` |
| `token` | Named constant, used for enum-like values in `knownValues` |

#### String Formats

| Format | Meaning |
|--------|---------|
| `datetime` | ISO 8601 with timezone (e.g., `2024-01-15T10:30:00.000Z`) |
| `uri` | Any valid URI (RFC 3986) |
| `at-uri` | AT Protocol URI (e.g., `at://did:plc:xxx/app.bsky.feed.post/abc123`) |
| `did` | Decentralized Identifier (`did:plc:...` or `did:web:...`) |
| `handle` | AT Protocol handle (e.g., `alice.bsky.social`) |
| `at-identifier` | Either a handle or DID |
| `cid` | Content Identifier hash string |
| `language` | BCP-47 language tag |
| `record-key` | Repository record key |
| `nsid` | Namespaced Identifier |
| `tid` | Timestamp ID |

### Real Lexicon Examples

#### app.bsky.feed.post (Bluesky Post)

```json
{
  "lexicon": 1,
  "id": "app.bsky.feed.post",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["text", "createdAt"],
        "properties": {
          "text": {
            "type": "string",
            "maxLength": 3000,
            "maxGraphemes": 300
          },
          "facets": {
            "type": "array",
            "items": { "type": "ref", "ref": "app.bsky.richtext.facet" }
          },
          "reply": { "type": "ref", "ref": "#replyRef" },
          "embed": {
            "type": "union",
            "refs": [
              "app.bsky.embed.images",
              "app.bsky.embed.video",
              "app.bsky.embed.external",
              "app.bsky.embed.record",
              "app.bsky.embed.recordWithMedia"
            ]
          },
          "langs": {
            "type": "array",
            "maxLength": 3,
            "items": { "type": "string", "format": "language" }
          },
          "labels": {
            "type": "union",
            "refs": ["com.atproto.label.defs#selfLabels"]
          },
          "tags": {
            "type": "array",
            "maxLength": 8,
            "items": { "type": "string", "maxLength": 640, "maxGraphemes": 64 }
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

#### community.lexicon.calendar.event (Community Events)

This lexicon was migrated from `events.smokesignal.calendar.event` to the community-owned `community.lexicon` namespace:

```json
{
  "lexicon": 1,
  "id": "community.lexicon.calendar.event",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["createdAt", "name"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "createdAt": { "type": "string", "format": "datetime" },
          "startsAt": { "type": "string", "format": "datetime" },
          "endsAt": { "type": "string", "format": "datetime" },
          "mode": {
            "type": "ref",
            "ref": "community.lexicon.calendar.event#mode"
          },
          "status": {
            "type": "ref",
            "ref": "community.lexicon.calendar.event#status"
          },
          "locations": {
            "type": "array",
            "items": {
              "type": "union",
              "refs": [
                "community.lexicon.calendar.event#uri",
                "community.lexicon.location.address",
                "community.lexicon.location.fsq",
                "community.lexicon.location.geo",
                "community.lexicon.location.hthree"
              ]
            }
          },
          "uris": {
            "type": "array",
            "items": { "type": "ref", "ref": "community.lexicon.calendar.event#uri" }
          }
        }
      }
    },
    "mode": {
      "type": "string",
      "default": "community.lexicon.calendar.event#inperson",
      "knownValues": [
        "community.lexicon.calendar.event#hybrid",
        "community.lexicon.calendar.event#inperson",
        "community.lexicon.calendar.event#virtual"
      ]
    },
    "status": {
      "type": "string",
      "default": "community.lexicon.calendar.event#scheduled",
      "knownValues": [
        "community.lexicon.calendar.event#cancelled",
        "community.lexicon.calendar.event#planned",
        "community.lexicon.calendar.event#postponed",
        "community.lexicon.calendar.event#rescheduled",
        "community.lexicon.calendar.event#scheduled"
      ]
    },
    "uri": {
      "type": "object",
      "required": ["uri"],
      "properties": {
        "uri": { "type": "string", "format": "uri" },
        "name": { "type": "string" }
      }
    }
  }
}
```

#### fyi.frontpage.feed.post (Frontpage Link Aggregator)

```json
{
  "lexicon": 1,
  "id": "fyi.frontpage.feed.post",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["title", "createdAt", "subject"],
        "properties": {
          "title": { "type": "string", "maxLength": 3000, "maxGraphemes": 300 },
          "subject": {
            "type": "union",
            "refs": ["#urlSubject"]
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "urlSubject": {
      "type": "object",
      "required": ["url"],
      "properties": {
        "url": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

#### community.lexicon.bookmarks.bookmark

```json
{
  "lexicon": 1,
  "id": "community.lexicon.bookmarks.bookmark",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "createdAt"],
        "properties": {
          "subject": { "type": "string", "format": "uri" },
          "createdAt": { "type": "string", "format": "datetime" },
          "tags": {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      }
    }
  }
}
```

#### Simple interaction records (like, repost, vote)

These follow a common pattern: `subject` (strongRef) + `createdAt`:

```json
// app.bsky.feed.like
{
  "required": ["subject", "createdAt"],
  "properties": {
    "subject": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
    "createdAt": { "type": "string", "format": "datetime" }
  }
}

// com.atproto.repo.strongRef
{
  "required": ["uri", "cid"],
  "properties": {
    "uri": { "type": "string", "format": "at-uri" },
    "cid": { "type": "string", "format": "cid" }
  }
}
```

---

## 2. Fetching Lexicon Definitions at Runtime

### The Problem

There is no single canonical API endpoint to fetch a lexicon definition given an NSID. The protocol was originally designed with lexicons as compile-time artifacts, not runtime-resolved resources. However, this is actively evolving.

### Available Strategies

#### Strategy A: Lexicon Resolution via DNS (RFC 3074, Emerging Standard)

The official resolution process (described in the RFC at github.com/bluesky-social/atproto/discussions/3074):

1. Parse the NSID into an authority domain. E.g., `app.bsky.feed.post` -> authority domain `feed.bsky.app`
2. DNS TXT lookup for `_lexicon.<authority-domain>` -> returns a DID (e.g., `did=did:plc:xxx`)
3. Resolve that DID to get a PDS endpoint
4. Fetch the lexicon record from that PDS via `com.atproto.repo.getRecord`

**Pros:** Protocol-native, works for any published lexicon.
**Cons:** Requires DNS lookup (not available in browser context without a proxy), not all lexicons have DNS records yet, still an RFC.

A library exists: `resolve-lexicon` at resolve-lexicon.pages.dev.

#### Strategy B: Lexicon Store API (lexicon.store)

The Lexicon Store (prtlsrl.com / api.lexicon.store) is a centralized index that:
- Crawls and indexes lexicon schemas
- Provides a REST API to query schemas by NSID, DID, or domain
- Handles the DNS resolution on the backend

```bash
# Request indexing
curl -X POST https://api.lexicon.store/requestIndex \
  -H "Content-Type: application/json" \
  -d '{"type": "nsid", "value": "community.lexicon.calendar.event"}'
```

**Pros:** Simple HTTP API, browser-compatible.
**Cons:** Third-party dependency, may not have all lexicons indexed.

#### Strategy C: Known GitHub Raw URLs

For well-known lexicons, fetch directly from their source repos:

| NSID Prefix | GitHub Repo |
|-------------|-------------|
| `app.bsky.*`, `com.atproto.*` | `bluesky-social/atproto/lexicons/` |
| `fyi.frontpage.*` | `frontpagefyi/frontpage/lexicons/` |
| `community.lexicon.*` | `lexicon-community/lexicon/` |

URL pattern: `https://raw.githubusercontent.com/<org>/<repo>/main/lexicons/<nsid-as-path>.json`

Where NSID `app.bsky.feed.post` becomes path `app/bsky/feed/post.json`.

**Pros:** Reliable for known lexicons, no DNS needed.
**Cons:** Only works for lexicons we know about, hardcoded mapping.

#### Strategy D: lexidex.bsky.dev (Already Implemented in lex)

The existing `fetchLexiconDirectory()` in `background.js` scrapes lexidex.bsky.dev for a list of known NSIDs grouped by domain. This gives us NSID discovery but NOT the actual schema definitions.

**Pros:** Already built.
**Cons:** Only gives NSIDs, not schemas. Needs to be combined with another strategy.

### Recommended Approach: Layered Resolution

```
1. Check local cache (in-memory + extension storage)
2. Try Lexicon Store API (api.lexicon.store)
3. Try known GitHub raw URLs (hardcoded map for popular lexicons)
4. Try DNS-based resolution via a server-side proxy (future)
5. Fall back to "raw JSON editor" if schema unavailable
```

---

## 3. Schema-to-Form Mapping

### Mapping Table

| Lexicon Type | Form Widget | Notes |
|---|---|---|
| `string` | `<input type="text">` or `<textarea>` | Use textarea if `maxGraphemes > 100` or description mentions "content"/"body"/"text" |
| `string` + `format: "datetime"` | `<input type="datetime-local">` | Auto-fill with current time for `createdAt` |
| `string` + `format: "uri"` | `<input type="url">` | URL validation |
| `string` + `format: "at-uri"` | AT URI picker/input | Could offer record browser |
| `string` + `format: "did"` | DID input with handle resolver | Typeahead using `searchActors` |
| `string` + `format: "handle"` | Handle input with typeahead | Typeahead using `searchActors` |
| `string` + `format: "at-identifier"` | Handle/DID input | Combined input |
| `string` + `format: "language"` | Language picker dropdown | BCP-47 tags |
| `string` + `format: "cid"` | Text input (advanced) | Usually auto-populated, not user-entered |
| `string` + `format: "nsid"` | Text input | NSID validation |
| `string` + `format: "tid"` | Hidden/auto-generated | Timestamp IDs are generated client-side |
| `string` + `format: "record-key"` | Hidden/auto-generated | Usually `tid` type |
| `string` + `knownValues` | `<select>` dropdown | With "Other..." option since knownValues is open |
| `string` + `enum` | `<select>` dropdown | Closed set, no "Other" |
| `integer` | `<input type="number">` | With `min`/`max` attributes from `minimum`/`maximum` |
| `integer` + `enum` | `<select>` dropdown | |
| `boolean` | Toggle switch / `<input type="checkbox">` | |
| `blob` | File upload `<input type="file">` | Use `accept` attribute from blob's `accept` field |
| `bytes` | File upload or base64 input | Rare in practice |
| `cid-link` | Text input (advanced) | Rarely user-entered |
| `ref` (local `#name`) | Inline nested form fields | Resolve from same lexicon's `defs` |
| `ref` (external NSID) | Inline nested form OR reference picker | Fetch the referenced lexicon schema |
| `union` | Type selector dropdown + dynamic form | Dropdown lists the union's `refs`, selecting one renders that type's fields |
| `array` | Repeatable field group | "Add item" / "Remove" buttons |
| `object` | Nested fieldset | Render all properties as sub-fields |
| `unknown` | Raw JSON textarea | For advanced users |

### Special Cases

#### Rich Text Facets (app.bsky.richtext.facet)

Facets annotate byte ranges of text with mentions, links, or hashtags. These should NOT be rendered as a form field. Instead:

1. User types text into the main text field
2. On submit, parse the text to detect:
   - `@handle` patterns -> resolve handle to DID, create mention facet
   - `https://...` URL patterns -> create link facet
   - `#hashtag` patterns -> create tag facet
3. Compute byte offsets (UTF-8) for each detected pattern
4. Generate the `facets` array automatically

```javascript
// Facet detection example
function detectFacets(text) {
  const encoder = new TextEncoder();
  const facets = [];

  // Detect mentions: @handle
  const mentionRegex = /@([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    facets.push({
      index: {
        byteStart: beforeBytes.length,
        byteEnd: beforeBytes.length + matchBytes.length,
      },
      features: [{
        $type: 'app.bsky.richtext.facet#mention',
        did: null, // resolve later
      }],
      _handle: match[1], // temporary, for resolution
    });
  }

  // Detect URLs
  const urlRegex = /https?:\/\/[^\s)]+/g;
  while ((match = urlRegex.exec(text)) !== null) {
    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    facets.push({
      index: {
        byteStart: beforeBytes.length,
        byteEnd: beforeBytes.length + matchBytes.length,
      },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: match[0],
      }],
    });
  }

  // Detect hashtags
  const tagRegex = /#([^\s#]+)/g;
  while ((match = tagRegex.exec(text)) !== null) {
    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    facets.push({
      index: {
        byteStart: beforeBytes.length,
        byteEnd: beforeBytes.length + matchBytes.length,
      },
      features: [{
        $type: 'app.bsky.richtext.facet#tag',
        tag: match[1],
      }],
    });
  }

  return facets;
}
```

#### createdAt Fields

Any field named `createdAt` with `format: "datetime"` should be auto-populated with the current timestamp. Show it as read-only or hidden with an "edit" option.

#### strongRef Fields

`com.atproto.repo.strongRef` requires both a `uri` (AT URI) and `cid`. These are typically obtained by browsing/searching for existing records. A good UX would be a record picker or paste field that accepts an AT URI and resolves the CID automatically.

#### knownValues vs enum

- `knownValues`: Open set with suggestions. Render as a `<select>` with an "Other..." option that reveals a text input.
- `enum`: Closed set. Render as a `<select>` with no custom option.

#### Token Definitions

Token definitions (like `community.lexicon.calendar.event#inperson`) are named constants used with `knownValues`. The form should display the token's `description` as the label, and use the full token reference as the value.

---

## 4. Creating Records via XRPC

### com.atproto.repo.createRecord

```javascript
/**
 * Create a record in the user's repo.
 * @param {OAuthSession} session - Authenticated session
 * @param {string} collection - NSID of the collection (e.g., 'app.bsky.feed.post')
 * @param {Object} record - The record data (must include $type)
 * @param {string} [rkey] - Optional record key (auto-generated if omitted)
 */
async function createRecord(session, collection, record, rkey) {
  const body = {
    repo: session.did,
    collection,
    record: {
      $type: collection,
      ...record,
    },
  };
  if (rkey) body.rkey = rkey;

  // Use xrpcPost (needs to be added to atproto.js)
  return await xrpcPost(session, 'com.atproto.repo.createRecord', body);
}
```

The request body for `com.atproto.repo.createRecord`:

```json
{
  "repo": "did:plc:abc123...",
  "collection": "app.bsky.feed.post",
  "record": {
    "$type": "app.bsky.feed.post",
    "text": "Hello from Peek!",
    "createdAt": "2026-02-19T12:00:00.000Z",
    "facets": [],
    "langs": ["en"]
  }
}
```

**Key details:**
- `repo`: The user's DID (from session)
- `collection`: The NSID of the record type
- `record.$type`: MUST match `collection` (without `#main` suffix)
- `validate`: Can be set to `false` to skip server-side lexicon validation for unknown lexicons. Default behavior validates only for known lexicons.
- Response returns `{ uri, cid, validationStatus }` where `validationStatus` is `"valid"` or `"unknown"`

### xrpcPost (needs to be added to atproto.js)

The existing `atproto.js` only has `xrpcGet`. We need an `xrpcPost`:

```javascript
/**
 * Make an authenticated POST request to the user's PDS.
 * Handles DPoP proof and automatic token refresh.
 */
export async function xrpcPost(session, nsid, body, onSessionRefresh = null) {
  const url = `${session.pdsUrl}/xrpc/${nsid}`;
  const dpopKeyPair = await importKeyPair(session.dpopKeyPairJwk);
  const ath = await computeAth(session.accessToken);
  let dpopProof = await createDpopProof(dpopKeyPair, 'POST', url, undefined, ath);

  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `DPoP ${session.accessToken}`,
      'DPoP': dpopProof,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Handle DPoP nonce
  if (res.status === 401) {
    const dpopNonce = res.headers.get('DPoP-Nonce');
    if (dpopNonce) {
      dpopProof = await createDpopProof(dpopKeyPair, 'POST', url, dpopNonce, ath);
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `DPoP ${session.accessToken}`,
          'DPoP': dpopProof,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }
  }

  // Token refresh retry on 401
  if (res.status === 401 && session.refreshToken) {
    const refreshed = await refreshOAuthSession(session);
    Object.assign(session, refreshed);
    if (onSessionRefresh) onSessionRefresh(refreshed);

    const newAth = await computeAth(refreshed.accessToken);
    dpopProof = await createDpopProof(dpopKeyPair, 'POST', url, undefined, newAth);
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `DPoP ${refreshed.accessToken}`,
        'DPoP': dpopProof,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `XRPC POST ${nsid} failed (${res.status})`);
  }

  return res.json();
}
```

### Blob Upload (com.atproto.repo.uploadBlob)

For images and other binary data, blobs must be uploaded first, then referenced in the record:

```javascript
/**
 * Upload a blob to the user's PDS.
 * @param {OAuthSession} session
 * @param {Blob|File} data - The binary data
 * @param {string} mimeType - MIME type (e.g., 'image/jpeg')
 * @returns {Promise<{blob: Object}>} - Blob reference to include in record
 */
export async function uploadBlob(session, data, mimeType) {
  const url = `${session.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`;
  const dpopKeyPair = await importKeyPair(session.dpopKeyPairJwk);
  const ath = await computeAth(session.accessToken);
  const dpopProof = await createDpopProof(dpopKeyPair, 'POST', url, undefined, ath);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `DPoP ${session.accessToken}`,
      'DPoP': dpopProof,
      'Content-Type': mimeType,
    },
    body: data,
  });

  // (Handle DPoP nonce retry and token refresh same as xrpcPost)

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Blob upload failed (${res.status})`);
  }

  return res.json(); // { blob: { $type: "blob", ref: { $link: "..." }, mimeType, size } }
}
```

The returned blob reference is then embedded in the record:

```json
{
  "$type": "app.bsky.embed.images",
  "images": [{
    "image": {
      "$type": "blob",
      "ref": { "$link": "bafkrei..." },
      "mimeType": "image/jpeg",
      "size": 123456
    },
    "alt": "Description of the image"
  }]
}
```

**Important:** Blobs are deleted if not referenced in a record within a time window (usually minutes). Upload immediately before creating the record.

### Does the PDS Accept Arbitrary Lexicon Types?

**Yes.** The `validate` parameter on `createRecord` controls this:

- `validate: true` — Server validates against known lexicons, rejects unknown ones
- `validate: false` — Server skips validation entirely, accepts any record shape
- `validate: undefined` (default) — Server validates only for lexicons it knows about; unknown lexicons pass with `validationStatus: "unknown"`

For arbitrary third-party lexicons, using the default behavior (omit `validate`) is the right choice. The record will be stored regardless, and the response will indicate whether the server could validate it.

---

## 5. Practical Considerations

### Most Useful Lexicons to Support First

**Tier 1 — High impact, simple schemas:**

| Lexicon | Why | Complexity |
|---------|-----|-----------|
| `app.bsky.feed.post` | Most impactful — post to Bluesky | Medium (facets, embeds) |
| `community.lexicon.bookmarks.bookmark` | Simple, useful | Low |
| `community.lexicon.calendar.event` | Events are a killer app | Medium (unions for locations) |
| `community.lexicon.calendar.rsvp` | Complements events | Low |

**Tier 2 — Interaction records (usually auto-generated, not manually created):**

| Lexicon | Why | Complexity |
|---------|-----|-----------|
| `app.bsky.feed.like` | Reaction record | Low (but needs record picker) |
| `app.bsky.feed.repost` | Share record | Low |
| `fyi.frontpage.feed.post` | Link sharing | Low |
| `fyi.frontpage.feed.vote` | Voting | Low |

**Tier 3 — Generic form for any lexicon:**

The generic form renderer should handle any lexicon with a `record` type definition.

### Lexicons Requiring Special Handling

| Lexicon | Special Handling |
|---------|-----------------|
| `app.bsky.feed.post` | Rich text facet detection, image embed upload, language detection |
| `app.bsky.embed.images` | Multi-file upload (max 4), alt text per image, aspect ratio calculation |
| `app.bsky.embed.video` | Video upload (complex, size limits, processing) |
| `app.bsky.embed.external` | URL card preview (fetch OG metadata) |
| Any with `blob` fields | Upload flow, MIME type validation, size limits |
| Any with `ref` to `strongRef` | Need AT URI + CID resolution |

### Validation Constraints

Lexicons specify these constraints that should be enforced client-side:

| Constraint | Applies To | Form Behavior |
|------------|-----------|---------------|
| `required` | Any field | Mark with asterisk, prevent submit if empty |
| `maxLength` / `minLength` | strings (UTF-8 bytes), bytes, arrays | Character counter, validation message |
| `maxGraphemes` / `minGraphemes` | strings | Grapheme counter (more user-friendly than byte count) |
| `minimum` / `maximum` | integers | `min`/`max` on number input |
| `enum` | strings, integers | Restrict to dropdown choices |
| `knownValues` | strings | Dropdown with "Other" option |
| `default` | strings, integers, booleans | Pre-fill form field |
| `const` | strings, integers, booleans | Hidden field with fixed value |
| `accept` | blobs | File input `accept` attribute |
| `maxSize` | blobs | Client-side file size check |

---

## 6. Existing Prior Art

### pdsls.dev

The most relevant prior art. PDSls (pdsls.dev) allows logged-in users to:
- Browse all records in their PDS
- Edit existing records as raw JSON
- Create new records

It does NOT generate structured forms from lexicon schemas — it uses a raw JSON editor. But it demonstrates that the createRecord flow works for arbitrary lexicons.

### Lexicon Store (prtlsrl.com / lexicon.store)

A centralized index and registry for lexicon schemas. Provides:
- Indexing API to request schema indexing by NSID/DID/domain
- Schema retrieval API
- DNS authority verification

Could serve as our runtime schema resolution backend.

### resolve-lexicon (resolve-lexicon.pages.dev)

A minimal library that resolves NSIDs to Lexicon schemas over the network using the DNS-based resolution process. Not configurable, no verification. Could be useful as a reference implementation.

### @atproto/lexicon (npm)

Official TypeScript library for working with Lexicon schemas:
- `Lexicons` class with validation methods (`assertValidRecord`, etc.)
- Schema parsing and type checking
- Runtime validation

**Caveat:** This is a Node.js library. Using it in a browser extension context would require bundling. The validation logic could be useful but the schema format is well-documented enough to implement our own lightweight parser.

### @atproto/lex-cli (npm)

Code generation tool that reads lexicon JSON files and generates TypeScript types, validators, and client methods. Not useful at runtime, but good reference for how schemas are interpreted.

### atproto-browser (atproto-browser.vercel.app)

Web app for browsing atproto data. Useful reference for how to display records.

### Awesome Lexicons (github.com/lexicon-community/awesome-lexicons)

Community-curated list of known lexicons and their apps/repos. Key entries:
- WhtWnd (long-form blog): `com.whtwnd.blog.*`
- Smoke Signal (events): `events.smokesignal.*` -> `community.lexicon.calendar.*`
- Frontpage (link aggregator): `fyi.frontpage.*`
- LinkAT Blue (link-in-bio): `blue.linkat.*`
- Skylights (book reviews): skylights.my
- Picosky (chat): psky.social
- PinkSea (art): pinksea.art
- ATFile (file upload): `blue.zio.atfile.*`
- Recipe Exchange: recipe.exchange
- Flushes: `im.flushing.right.now`

---

## 7. Proposed Architecture for lex

### Component Overview

```
lex extension
├── background.js          (existing — session mgmt, pubsub)
├── atproto.js             (existing — OAuth, XRPC GET)
├── lexicon-resolver.js    (NEW — fetch & cache lexicon schemas)
├── record-creator.js      (NEW — form generation & record submission)
├── home.html/js           (existing — account & collections UI)
└── create-record.html/js  (NEW — form UI for creating records)
```

### lexicon-resolver.js — Schema Resolution

```javascript
/**
 * Resolves a lexicon NSID to its full schema definition.
 * Uses layered resolution: cache -> Lexicon Store -> GitHub -> DNS.
 */
class LexiconResolver {
  constructor() {
    this.cache = new Map(); // NSID -> schema JSON
    this.pending = new Map(); // NSID -> Promise (dedup in-flight)
  }

  async resolve(nsid) {
    // 1. Cache hit
    if (this.cache.has(nsid)) return this.cache.get(nsid);

    // 2. Dedup concurrent requests
    if (this.pending.has(nsid)) return this.pending.get(nsid);

    const promise = this._doResolve(nsid);
    this.pending.set(nsid, promise);
    try {
      const result = await promise;
      this.cache.set(nsid, result);
      return result;
    } finally {
      this.pending.delete(nsid);
    }
  }

  async _doResolve(nsid) {
    // Try Lexicon Store API
    try {
      const res = await fetch(`https://api.lexicon.store/lexicon/${nsid}`);
      if (res.ok) return await res.json();
    } catch {}

    // Try known GitHub URLs
    const githubUrl = this._githubUrl(nsid);
    if (githubUrl) {
      try {
        const res = await fetch(githubUrl);
        if (res.ok) return await res.json();
      } catch {}
    }

    return null; // Could not resolve
  }

  _githubUrl(nsid) {
    const parts = nsid.split('.');
    const path = parts.join('/') + '.json';

    // Known mappings
    const mappings = {
      'app.bsky': 'bluesky-social/atproto/main/lexicons',
      'com.atproto': 'bluesky-social/atproto/main/lexicons',
      'fyi.frontpage': 'frontpagefyi/frontpage/main/lexicons',
      'community.lexicon': 'lexicon-community/lexicon/main',
    };

    for (const [prefix, repo] of Object.entries(mappings)) {
      if (nsid.startsWith(prefix)) {
        return `https://raw.githubusercontent.com/${repo}/${path}`;
      }
    }

    return null;
  }

  /**
   * Resolve a ref string to a schema definition.
   * Handles both local (#name) and external (nsid or nsid#name) refs.
   */
  async resolveRef(ref, currentLexicon) {
    if (ref.startsWith('#')) {
      // Local ref
      const defName = ref.slice(1);
      return currentLexicon.defs?.[defName] || null;
    }

    // External ref: "com.atproto.repo.strongRef" or "com.example.defs#someDef"
    const [nsid, fragment] = ref.split('#');
    const lexicon = await this.resolve(nsid);
    if (!lexicon) return null;

    const defName = fragment || 'main';
    return lexicon.defs?.[defName] || null;
  }
}
```

### record-creator.js — Form Generation Engine

```javascript
/**
 * Generate a form element tree from a lexicon record schema.
 *
 * @param {Object} schema - The record's object schema (from defs.main.record)
 * @param {Object} lexicon - The full lexicon JSON (for resolving local refs)
 * @param {LexiconResolver} resolver - For resolving external refs
 * @returns {HTMLElement} - The generated form
 */
async function generateForm(schema, lexicon, resolver) {
  const form = document.createElement('form');
  form.className = 'lexicon-form';

  const { properties, required = [], nullable = [] } = schema;

  for (const [name, fieldSchema] of Object.entries(properties)) {
    const isRequired = required.includes(name);
    const isNullable = nullable.includes(name);
    const fieldEl = await renderField(name, fieldSchema, isRequired, lexicon, resolver);
    form.appendChild(fieldEl);
  }

  return form;
}

async function renderField(name, schema, isRequired, lexicon, resolver) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-field';
  wrapper.dataset.fieldName = name;

  const label = document.createElement('label');
  label.textContent = formatFieldName(name);
  if (isRequired) label.classList.add('required');
  if (schema.description) label.title = schema.description;
  wrapper.appendChild(label);

  if (schema.description) {
    const hint = document.createElement('small');
    hint.className = 'field-hint';
    hint.textContent = schema.description;
    wrapper.appendChild(hint);
  }

  switch (schema.type) {
    case 'string':
      wrapper.appendChild(renderStringField(name, schema));
      break;
    case 'integer':
      wrapper.appendChild(renderIntegerField(name, schema));
      break;
    case 'boolean':
      wrapper.appendChild(renderBooleanField(name, schema));
      break;
    case 'blob':
      wrapper.appendChild(renderBlobField(name, schema));
      break;
    case 'bytes':
      wrapper.appendChild(renderBytesField(name, schema));
      break;
    case 'cid-link':
      wrapper.appendChild(renderCidLinkField(name, schema));
      break;
    case 'ref':
      wrapper.appendChild(await renderRefField(name, schema, lexicon, resolver));
      break;
    case 'union':
      wrapper.appendChild(await renderUnionField(name, schema, lexicon, resolver));
      break;
    case 'array':
      wrapper.appendChild(await renderArrayField(name, schema, lexicon, resolver));
      break;
    case 'unknown':
      wrapper.appendChild(renderUnknownField(name, schema));
      break;
  }

  return wrapper;
}

function renderStringField(name, schema) {
  // knownValues or enum -> dropdown
  if (schema.enum || schema.knownValues) {
    return renderEnumField(name, schema);
  }

  // format-specific inputs
  if (schema.format === 'datetime') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = name;
    if (name === 'createdAt') {
      input.value = new Date().toISOString().slice(0, 16);
    }
    return input;
  }

  if (schema.format === 'uri') {
    const input = document.createElement('input');
    input.type = 'url';
    input.name = name;
    input.placeholder = 'https://...';
    return input;
  }

  if (schema.format === 'at-uri') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.placeholder = 'at://did:plc:.../collection/rkey';
    return input;
  }

  if (schema.format === 'did' || schema.format === 'handle' || schema.format === 'at-identifier') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.placeholder = schema.format === 'did' ? 'did:plc:...' : '@handle.example.com';
    return input;
  }

  if (schema.format === 'language') {
    return renderLanguageField(name, schema);
  }

  // Long text -> textarea
  const isLongText = (schema.maxGraphemes && schema.maxGraphemes > 100)
    || (schema.maxLength && schema.maxLength > 500)
    || /content|body|text|description/i.test(name);

  if (isLongText) {
    const textarea = document.createElement('textarea');
    textarea.name = name;
    textarea.rows = 4;
    if (schema.maxLength) textarea.maxLength = schema.maxLength;
    return textarea;
  }

  // Default: text input
  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  if (schema.default !== undefined) input.value = schema.default;
  if (schema.maxLength) input.maxLength = schema.maxLength;
  return input;
}
```

### Form Data Collection

```javascript
/**
 * Collect form data into a record object, handling nested structures.
 */
function collectFormData(form, schema, lexicon) {
  const record = {};
  const { properties, required = [] } = schema;

  for (const [name, fieldSchema] of Object.entries(properties)) {
    const value = collectFieldValue(form, name, fieldSchema, lexicon);

    // Only include if non-empty (unless required)
    if (value !== undefined && value !== null && value !== '') {
      record[name] = value;
    } else if (required.includes(name)) {
      record[name] = value; // Include even if empty for validation error
    }
  }

  return record;
}
```

### UI Flow

1. User clicks "Create Record" on a lexicon in the browse view
2. Extension resolves the lexicon schema
3. Form is dynamically generated from the schema
4. User fills in the form
5. On submit:
   a. Collect form values into a record object
   b. Upload any blobs (images, files)
   c. Process special fields (facets for rich text, auto-fill createdAt)
   d. Call `createRecord` with the assembled record
   e. Show success/error with the AT URI of the created record

---

## 8. Phased Implementation Plan

### Phase 1: Foundation (xrpcPost + Schema Resolution)

**Goal:** Add the ability to make authenticated POST requests and resolve lexicon schemas.

1. Add `xrpcPost` and `uploadBlob` to `atproto.js`
2. Implement `LexiconResolver` with cache + GitHub + Lexicon Store resolution
3. Add PubSub messages for record creation flow
4. Add basic "Create Record" button to lexicon browse view

### Phase 2: Generic Form Renderer

**Goal:** Auto-generate forms from any lexicon schema.

1. Implement the core `generateForm()` engine covering:
   - All concrete types (string, integer, boolean)
   - String formats (datetime, uri, did, handle, language)
   - Enum/knownValues dropdowns
   - Simple refs (inline object fields)
   - Arrays (add/remove items)
2. Implement `collectFormData()` to extract values
3. Add a "Raw JSON" toggle for advanced users
4. Build the `create-record.html` UI with the form renderer
5. Wire up the submit flow: collect -> validate -> createRecord

### Phase 3: Bluesky Post (Special Handling)

**Goal:** First-class Bluesky post creation.

1. Rich text facet detection (mentions, links, hashtags)
2. Handle resolution for @mentions (using existing `searchActors`)
3. Image embed support (multi-file upload, alt text, aspect ratio)
4. Character/grapheme counter
5. Language selector
6. Post preview

### Phase 4: Advanced Types

**Goal:** Handle the remaining complex schema types.

1. Union type rendering (type selector dropdown + dynamic sub-form)
2. External ref resolution (fetch referenced lexicons)
3. strongRef picker (browse records, resolve CID from AT URI)
4. Blob upload for arbitrary blob fields
5. Nested object forms

### Phase 5: Polish and Ecosystem

**Goal:** Make it production-ready.

1. Client-side validation (all constraints from the schema)
2. Error messages with field-level feedback
3. Record templates / presets for common operations
4. "Edit Record" support (putRecord)
5. Record deletion support (deleteRecord)
6. DNS-based lexicon resolution (via proxy)
7. Offline lexicon caching in extension storage

---

## 9. Open Questions and Gotchas

### Open Questions

1. **Lexicon Store API stability:** Is `api.lexicon.store` reliable enough for production use? Do we need a fallback index?

2. **Union type UX:** When a field is a union of many types (like `embed` in posts), what's the best UX? A dropdown selector, or smart detection based on what the user provides?

3. **Ref resolution depth:** How deep should we resolve refs? A record might reference an object that references another object in another lexicon. Infinite depth is impractical — likely 2-3 levels is sufficient.

4. **Validation strictness:** Should we enforce all constraints client-side, or let the PDS validate and show server errors? Client-side is better UX but more work.

5. **Browser CORS:** Can we fetch from `api.lexicon.store` and GitHub raw URLs from an Electron extension context? Electron's `webRequest` might need CORS headers added. The existing `api.net.fetch` in Peek might bypass this.

6. **Facet detection accuracy:** The simple regex approach for mention/link/tag detection may not match Bluesky's exact behavior. Should we port the official `@atproto/api` rich text detection logic?

### Gotchas

1. **UTF-8 byte counting:** Facet byte indices must be in UTF-8 bytes, not JavaScript string indices (which are UTF-16 code units). Always use `TextEncoder` for byte offset calculation.

2. **Blob timing:** Uploaded blobs expire if not referenced quickly. Upload blobs immediately before `createRecord`, not when the user selects the file.

3. **$type field:** Every record MUST have a `$type` field matching the collection NSID. Every object within a union MUST have a `$type` field matching its schema ref. Forgetting `$type` is a common error.

4. **createdAt timezone:** Must include timezone info. `new Date().toISOString()` produces UTC (ending in `Z`), which is correct. Never use local time without timezone.

5. **knownValues is open:** Unlike `enum`, `knownValues` allows any string value. The form must permit custom values, not just the listed ones.

6. **Nullable vs optional:** In Lexicon, omitting a field and including it with `null` are semantically different. Fields in the `nullable` array can be explicitly `null`. Fields not in `nullable` should be omitted, not set to `null`.

7. **Record key generation:** Most records use `tid` (Timestamp ID) as the key type, which means the key is auto-generated. Some lexicons might use `any` or specific key types — check the `key` field on the record definition.

8. **DPoP nonce handling:** Every authenticated request may trigger a DPoP nonce requirement. The existing `xrpcGet` handles this, and `xrpcPost` must too. The nonce retry pattern needs to be consistent.

9. **Legacy NSID migration:** `events.smokesignal.calendar.event` has been sunset (August 2025). The replacement is `community.lexicon.calendar.event`. Any lexicon directory should show the current NSIDs.

10. **Cross-lexicon dependencies:** A lexicon like `community.lexicon.calendar.event` depends on `community.lexicon.location.geo`, `community.lexicon.location.address`, etc. The resolver must handle recursive fetching of dependency schemas.

---

## Sources

- AT Protocol Lexicon Spec: https://atproto.com/specs/lexicon
- AT Protocol Data Model: https://atproto.com/specs/data-model
- RFC: Lexicon Resolution: https://github.com/bluesky-social/atproto/discussions/3074
- Bluesky atproto lexicons: https://github.com/bluesky-social/atproto/tree/main/lexicons
- Frontpage lexicons: https://github.com/frontpagefyi/frontpage/tree/main/lexicons
- Community lexicons: https://github.com/lexicon-community/lexicon
- Awesome Lexicons: https://github.com/lexicon-community/awesome-lexicons
- Smoke Signal community lexicons blog: https://blog.smokesignal.events/posts/3lthgjbbhyk2c-community-lexicons
- Lexicon Store: https://www.prtlsrl.com/
- resolve-lexicon: https://resolve-lexicon.pages.dev/
- @atproto/lexicon npm: https://www.npmjs.com/package/@atproto/lexicon
- PDSls: https://pdsls.dev/
