# Lex Studio: Configurable Template System Design

## Table of Contents

1. [Current State](#1-current-state)
2. [Template Set Data Model](#2-template-set-data-model)
3. [Fiddle UI Design](#3-fiddle-ui-design)
4. [Template Language Options](#4-template-language-options)
5. [Templates as Lexicons](#5-templates-as-lexicons)
6. [Widget System](#6-widget-system)
7. [Discovery and Sharing](#7-discovery-and-sharing)
8. [Implementation Phases](#8-implementation-phases)
9. [Open Questions](#9-open-questions)

---

## 1. Current State

### Lex Extension Architecture

The lex extension lives in `extensions/lex/` and is a **fully declarative extension** (`"background": false` in manifest). No background.js — all logic runs in the UI pages directly. Files:

- **`manifest.json`** -- Declares two commands: "lexicon studio" (opens workspace window) and "new" (also opens studio). Both open `peek://lex/home.html` as a workspace window with `webSecurity: false` (needed for cross-origin lexicon fetches).
- **`home.js`** -- The main studio UI. Handles OAuth login, PDS browsing (collections, records), lexicon exploration, record creation/deletion, and the "Recent Lexicons" sidebar. Imports from `lexicon-ui.js` and `atproto.js`.
- **`chain-form.js`** -- A compact popup form for cmd palette chaining. Opened by cmd panel's `openChainPopup()` as a modal child window. Receives an NSID via pubsub, resolves the schema, generates a form, and creates the record directly via XRPC. The "chain" refers to cmd palette chaining, not nested definitions.
- **`lexicon-ui.js`** -- The core form generation engine. Contains: lexicon schema resolution (layered: memory cache → persisted settings → GitHub raw URLs → lexicon.store API → domain-based resolution), dynamic form generation from schemas, form data collection, rich text facet detection, and raw JSON editor fallback.
- **`atproto.js`** -- AT Protocol client: OAuth login, XRPC calls, blob upload, record CRUD, actor search.
- **`home.css`** -- Studio UI styling.

### Current Form Generation (lexicon-ui.js)

The `generateForm(nsid, schema, lexicon, options)` function takes a lexicon record schema and produces a DOM `<form>` element. It:

1. **Sorts fields**: required first, then alphabetical, `createdAt` always last
2. **Renders each field** via `renderField()` → `renderInput()` which dispatches by type:
   - **string**: text input, with format-specific variants: `datetime` → `datetime-local`, `uri` → url input, `did` → text with placeholder, `handle` → text, `language` → dropdown of 20 languages + custom BCP-47. Long text (maxLength > 500 or field name matches content/body/text/description) → textarea with character counter. `enum` → closed dropdown, `knownValues` → open dropdown with "Other..." option.
   - **integer/number**: number input with min/max/step constraints
   - **boolean**: checkbox
   - **blob**: file upload with size info
   - **ref**: resolves the `$ref` (local `#name` or external `nsid#name`), renders the resolved type inline. Recursive up to depth 4.
   - **union**: type selector dropdown, then renders the selected variant's fields inline
   - **array**: "Add item" button, renders each item's input, "Remove" buttons, item counter with optional maxLength
   - **object**: renders nested properties recursively
   - **unknown/bytes/fallback**: raw JSON textarea
3. **Auto-fills** `createdAt` with current datetime
4. **Data collection** via `collectFormData()` mirrors the rendering structure — walks the DOM collecting values by type, handles unions ($type tagging), arrays, nested objects, blob files, and datetime ISO conversion. Special-cases `app.bsky.feed.post` for rich text facet detection (URLs, @mentions, #hashtags with byte-level indexing).

### Schema Resolution

Lexicon schemas are resolved via a layered strategy in `resolveLexicon(nsid)`:
1. In-memory `Map` cache
2. Persisted cache in extension settings (`lexiconSchemas` key) — restored on first cache miss
3. GitHub raw URLs for known prefixes: `app.bsky.*`, `com.atproto.*`, `chat.bsky.*`, `tools.ozone.*`, `fyi.frontpage.*`, `community.lexicon.*`
4. `api.lexicon.store` REST API
5. Domain-based resolution: NSID authority → domain → `/lexicons/{path}.json`

Resolved schemas are persisted to extension settings with `fetchedAt` timestamps.

### What the Studio Looks Like

The home.js UI has multiple view states managed by navigation:
- **Login/Identity panel** — OAuth login to a PDS, profile display
- **My Lexicons** — browsable list of collections on the user's PDS with record counts
- **Records list** — paginated record list within a collection, with delete capability
- **Record detail** — raw JSON view of a single record
- **Create Record** — either the generated form (via `generateForm()`) or raw JSON editor
- **Explore** — browse known lexicon registries, search for lexicons
- **Recent Lexicons** — sidebar section (always visible) showing recently interacted-with lexicons sorted by recency

### Dynamic Command Registration

The studio dynamically registers `new {FriendlyName}` commands in the cmd palette for every known collection NSID. This means users can type "new Post" or "new Follow" to get a chain-form popup for that lexicon type. Commands are rebuilt when collections change.

### AT Protocol Lexicon Format

Lexicons are JSON schema files with this structure:

```json
{
  "lexicon": 1,
  "id": "com.example.calendar.event",
  "defs": {
    "main": {
      "type": "record",
      "description": "A calendar event",
      "record": {
        "type": "object",
        "required": ["title", "startDate"],
        "properties": {
          "title": { "type": "string", "maxLength": 256 },
          "startDate": { "type": "string", "format": "datetime" },
          "endDate": { "type": "string", "format": "datetime" },
          "description": { "type": "string", "maxLength": 10000 },
          "location": { "type": "string" },
          "attendees": {
            "type": "array",
            "items": { "type": "string", "format": "did" }
          }
        }
      }
    }
  }
}
```

**Lexicon field types available:**
- Primitives: `string`, `integer`, `boolean`, `number`
- Binary: `bytes`, `blob`
- Structured: `object`, `array`, `ref`, `union`
- String formats: `datetime`, `uri`, `at-uri`, `did`, `handle`, `cid`, `at-identifier`, `nsid`, `tid`, `record-key`, `language`
- Constraints: `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `const`, `default`

---

## 2. Template Set Data Model

### Core Concept

A **template set** is a bundle of three templates bound to one or more lexicon NSIDs:

```
TemplateSet
  |-- targets: [nsid, ...]          // which lexicon(s) this applies to
  |-- list: ListTemplate            // collection display
  |-- detail: DetailTemplate        // single record display
  |-- edit: EditTemplate            // record editor
  |-- metadata: { author, version, description, ... }
```

### Schema

```json
{
  "lexicon": 1,
  "id": "app.peek.lex.templateSet",
  "defs": {
    "main": {
      "type": "record",
      "record": {
        "type": "object",
        "required": ["targets", "name"],
        "properties": {
          "name": { "type": "string", "maxLength": 128 },
          "description": { "type": "string", "maxLength": 1024 },
          "version": { "type": "string", "maxLength": 32 },
          "targets": {
            "type": "array",
            "items": { "type": "string", "format": "nsid" },
            "description": "Lexicon NSIDs this template set applies to"
          },
          "listTemplate": { "type": "ref", "ref": "#listTemplate" },
          "detailTemplate": { "type": "ref", "ref": "#detailTemplate" },
          "editTemplate": { "type": "ref", "ref": "#editTemplate" }
        }
      }
    },
    "listTemplate": {
      "type": "object",
      "required": ["layout", "itemTemplate"],
      "properties": {
        "layout": {
          "type": "string",
          "knownValues": ["table", "grid", "calendar", "timeline", "kanban", "list"]
        },
        "columns": {
          "type": "array",
          "items": { "type": "ref", "ref": "#columnDef" },
          "description": "For table/grid layouts, column definitions"
        },
        "itemTemplate": {
          "type": "string",
          "description": "HTML template string for each item in the list"
        },
        "sortDefault": { "type": "string" },
        "groupBy": { "type": "string" }
      }
    },
    "detailTemplate": {
      "type": "object",
      "required": ["template"],
      "properties": {
        "template": {
          "type": "string",
          "description": "HTML template string for the detail view"
        },
        "sections": {
          "type": "array",
          "items": { "type": "ref", "ref": "#sectionDef" }
        }
      }
    },
    "editTemplate": {
      "type": "object",
      "required": ["fields"],
      "properties": {
        "fields": {
          "type": "array",
          "items": { "type": "ref", "ref": "#fieldDef" }
        },
        "layout": {
          "type": "string",
          "knownValues": ["vertical", "horizontal", "grid", "tabs", "wizard"]
        },
        "validation": {
          "type": "string",
          "description": "Optional extra validation rules beyond lexicon constraints"
        }
      }
    },
    "fieldDef": {
      "type": "object",
      "required": ["path", "widget"],
      "properties": {
        "path": {
          "type": "string",
          "description": "Dot-notation path to the field in the record, e.g. 'startDate'"
        },
        "widget": {
          "type": "string",
          "knownValues": [
            "text", "textarea", "richtext", "number", "toggle",
            "date", "datetime", "time", "daterange",
            "select", "multiselect", "radio", "checkbox",
            "did-picker", "handle-picker", "uri-input",
            "blob-upload", "image-upload",
            "json-editor", "color-picker", "slider",
            "tag-picker", "location-picker"
          ]
        },
        "label": { "type": "string" },
        "placeholder": { "type": "string" },
        "helpText": { "type": "string" },
        "hidden": { "type": "boolean" },
        "readOnly": { "type": "boolean" },
        "width": { "type": "string", "knownValues": ["full", "half", "third", "quarter"] }
      }
    },
    "columnDef": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": { "type": "string" },
        "label": { "type": "string" },
        "width": { "type": "string" },
        "sortable": { "type": "boolean" },
        "formatter": { "type": "string", "description": "Named formatter: date, relative-time, truncate, etc." }
      }
    },
    "sectionDef": {
      "type": "object",
      "required": ["title", "fields"],
      "properties": {
        "title": { "type": "string" },
        "fields": { "type": "array", "items": { "type": "string" } },
        "collapsed": { "type": "boolean" }
      }
    }
  }
}
```

### Template Resolution Order

When displaying a lexicon record, resolve the template in this order:

1. **User-selected template** -- explicitly chosen for this lexicon in settings
2. **Pinned template** -- user has pinned a template for this NSID
3. **Community default** -- highest-rated template for this NSID (if discovery is available)
4. **Auto-generated** -- the current default form generation (always available as fallback)

---

## 3. Fiddle UI Design

### Layout: Four-Pane Split View

```
+------------------------------------------+
|  Studio Toolbar                          |
|  [Lexicon Selector] [Template Selector]  |
+----------+----------+-------------------+
|          |          |                   |
|  Raw     | Generated|  Template         |
|  JSON    | Form     |  Editor           |
|          | (current |                   |
|          |  default)|                   |
|          |          |                   |
+----------+----------+-------------------+
|                     |                   |
|  Template Rendered  |  (Editor cont'd   |
|  Preview            |   or Logs/Errors) |
|                     |                   |
+---------------------+-------------------+
```

### Pane Descriptions

**Pane 1: Raw JSON (top-left)**
- Shows the raw lexicon schema definition and/or a sample record instance
- Toggle between schema view and record view
- Editable -- changes propagate to the other panes live
- Syntax highlighting with JSON validation
- Can load example records from a PDS or generate sample data from the schema

**Pane 2: Generated Form (top-center)**
- The current auto-generated editor -- always available as baseline
- Shows what the default `chain-form.js` produces
- Non-editable in this context (it is the reference implementation)
- Useful for comparing against the template-rendered version

**Pane 3: Template Editor (right side, full height)**
- Code editor for the active template (list, detail, or edit -- tab selector at top)
- Template syntax with autocomplete for field paths from the active lexicon
- Widget palette sidebar: drag-and-drop widgets onto the template
- Validation indicators showing template errors
- "Insert field" button that shows available fields from the lexicon schema

**Pane 4: Template Rendered Preview (bottom-left)**
- Live preview of the template applied to the current JSON data
- Hot-reloads as the template editor or JSON changes
- Toggle between list/detail/edit views
- Shows the template as the end user would see it
- Includes a sample data generator for list views (N items)

### Interaction Model

- **Resize handles** between all panes (drag to resize)
- **Collapse/expand** any pane (double-click divider or button)
- **Tab bar** at top of template editor switches between list/detail/edit templates
- **Sync indicator** shows when panes are in sync vs. when changes are pending
- **Keyboard shortcuts**: Cmd+1/2/3/4 to focus panes, Cmd+S to save template, Cmd+P to toggle preview
- **Error overlay** on preview pane when template has syntax errors, with clickable error messages that jump to the template editor line

### Data Flow

```
Lexicon Schema ──> Auto-generate sample data ──> Raw JSON pane
     |                                              |
     v                                              v
  Generated Form                            Template Engine
     (default chain-form)                       |
                                                v
                                         Rendered Preview
                                                ^
                                                |
                                         Template Editor
```

---

## 4. Template Language Options

### Option A: HTML Templates with Mustache-style Bindings

```html
<!-- Detail template for a calendar event -->
<div class="event-detail">
  <h1>{{title}}</h1>
  <div class="event-dates">
    <peek-date value="{{startDate}}" format="long" />
    {{#if endDate}}
      <span> to </span>
      <peek-date value="{{endDate}}" format="long" />
    {{/if}}
  </div>
  <div class="description">{{description}}</div>
  {{#each attendees}}
    <peek-identity did="{{this}}" />
  {{/each}}
</div>
```

**Pros:**
- Familiar to web developers
- Easy to implement (many template engines available: Handlebars, Mustache, lit-html)
- Full styling control via CSS
- Can reuse Peek's existing web component library (peek-card, peek-input, etc.)
- Easy to render in a sandboxed context

**Cons:**
- Security concerns with arbitrary HTML (XSS risk if templates come from untrusted sources)
- Requires sanitization layer
- Templates can become complex and hard to validate
- Not inherently typed -- template can reference fields that don't exist

### Option B: Declarative JSON Schema (Recommended for Edit Templates)

```json
{
  "layout": "vertical",
  "fields": [
    { "path": "title", "widget": "text", "label": "Event Title", "width": "full" },
    {
      "layout": "horizontal",
      "fields": [
        { "path": "startDate", "widget": "datetime", "label": "Start" },
        { "path": "endDate", "widget": "datetime", "label": "End" }
      ]
    },
    { "path": "description", "widget": "richtext", "label": "Description" },
    { "path": "attendees", "widget": "did-picker", "label": "Attendees", "multiple": true },
    { "path": "location", "widget": "location-picker", "label": "Location" }
  ]
}
```

**Pros:**
- Fully type-safe and validatable against the lexicon schema
- No XSS risk -- it is pure data
- Can be auto-generated from lexicon schema as a starting point
- Easy to build a visual editor on top of (drag-and-drop)
- Naturally serializable as a lexicon record (templates-as-lexicons)

**Cons:**
- Limited expressiveness for complex layouts
- Custom styling requires a separate mechanism
- Harder to do fully custom detail/list views

### Option C: DASL Web Tiles

Web Tiles (from the DASL specification by Robin Berjon) are composable, sandboxed web documents packaged with content-addressed manifests. A tile is essentially:

- A MASL manifest (CBOR metadata document) listing all resources by CID
- HTML/CSS/JS content served from content-addressed storage
- Sandboxed execution (no network egress beyond pre-listed resources)
- Composable -- tiles can be nested and communicate via message passing

```
Tile Manifest (MASL):
{
  name: "Calendar Event Template",
  resources: {
    "/": { $type: "blob", ref: { $link: "bafy..." }, mimeType: "text/html" },
    "/style.css": { $type: "blob", ref: { $link: "bafy..." }, mimeType: "text/css" }
  }
}
```

**Pros:**
- Content-addressed and verifiable -- users can trust that a template has not been tampered with
- Sandboxed -- no exfiltration risk even with arbitrary HTML/JS
- Native to the atproto ecosystem (uses CIDs, CBOR, same primitives)
- Excellent for discovery and sharing (tiles are self-contained packages)
- `@dasl/tiles` npm package provides `renderCard()` and `renderContent()` APIs
- Publishing via `atile publish` command

**Cons:**
- Heavy dependency for what could be simple templates
- MASL is a metadata/manifest format, not a template language -- you still need HTML templates inside the tile
- Content addressing adds complexity (CIDs, CAR files, IPFS)
- Overkill for simple field-to-widget mappings
- Young specification, limited ecosystem maturity
- The tile sandbox may make it harder to integrate with Peek's existing component library

### Option D: Hybrid Approach (Recommended)

Use a **layered system** with increasing expressiveness:

| Layer | Format | Use Case |
|-------|--------|----------|
| **Field mappings** | Declarative JSON | Edit templates -- mapping lexicon fields to widgets |
| **Layout templates** | HTML with Handlebars + Peek web components | Detail and list templates -- expressive rendering |
| **Packaged templates** | DASL Web Tiles | Shared/published templates -- sandboxed, content-addressed |

This gives:
- Simple templates stay simple (JSON field mappings)
- Complex templates have full HTML expressiveness
- Published templates get the security and addressing benefits of Web Tiles
- The fiddle UI can work at any layer

### Building on lexicon-ui.js (Key Insight)

The existing `renderInput()` dispatch in `lexicon-ui.js` is already a primitive widget system — it maps schema types to DOM elements. The template system should **extend this, not replace it**:

1. **Edit templates** are essentially a configuration layer over `renderInput()`. Instead of the hardcoded type→input mapping, an edit template specifies which widget to use per field, plus layout. The auto-generated default becomes: "for each field, pick the widget that `renderInput()` would have picked, arrange vertically."

2. **The `generateForm()` function already handles**: field sorting, required markers, descriptions, labels, auto-fill, recursive depth limits. Templates should be able to override these defaults per-field while inheriting the rest.

3. **`collectFormData()` already handles**: type coercion, union $type tagging, nested objects, arrays, blob files, datetime normalization, facet detection. New widgets need to implement the same `getValue()` contract so the collection logic works unchanged.

4. **Schema resolution is already solved**: `resolveLexicon()` with its layered cache handles cross-reference resolution. The template system gets this for free.

The practical path: add a `templateOverrides` parameter to `generateForm()` that lets fields be remapped to different widgets, reordered, grouped into sections, or hidden. This preserves the existing auto-generation as the default while allowing progressive customization.

### MASL Evaluation Summary

MASL (Metadata for Arbitrary Structures and Links) is specifically a **metadata and manifest format**, not a template definition language. It describes resources (files, blobs) with their CIDs, sizes, and MIME types. It is the manifest format for Web Tiles, not the template language itself.

**MASL is NOT suitable as a template definition format** because:
- It describes metadata about resources, not how to render them
- It has no concept of field bindings, layouts, or widgets
- It is CBOR-based, not human-editable

**However**, MASL is the right format for **packaging and distributing** template sets. A published template set would be a Web Tile with a MASL manifest, containing the actual template files (HTML, JSON, CSS) as content-addressed resources inside.

---

## 5. Templates as Lexicons (Meta-Circular Design)

### The Meta-Circular Property

Template sets should themselves be lexicon records. This means:

1. A template set for `com.example.calendar.event` is itself a record of type `app.peek.lex.templateSet`
2. That record can be stored in a user's PDS
3. Other users can create template sets for `app.peek.lex.templateSet` itself (templates for templates)
4. The lex studio can use its own template system to render template records

### Storage Architecture

```
User's PDS Repository
  |
  |-- app.peek.lex.templateSet/
  |     |-- 3k2... (template set record for com.example.calendar.event)
  |     |-- 3k3... (template set record for app.bsky.feed.post)
  |     |-- 3k4... (template set record for another lexicon)
  |
  |-- app.peek.lex.templateSetPreference/
  |     |-- 3k5... (which template set is active for which lexicon)
```

### Template Set Record Structure

```json
{
  "$type": "app.peek.lex.templateSet",
  "name": "Calendar Pro",
  "description": "Rich calendar views for event lexicons",
  "version": "1.2.0",
  "author": "did:plc:abc123...",
  "targets": ["com.example.calendar.event"],
  "listTemplate": {
    "layout": "calendar",
    "itemTemplate": "<div class=\"cal-event\" style=\"background: {{color}}\">...",
    "sortDefault": "startDate"
  },
  "detailTemplate": {
    "template": "<article class=\"event-detail\">...",
    "sections": [
      { "title": "When", "fields": ["startDate", "endDate"] },
      { "title": "Where", "fields": ["location"] },
      { "title": "Who", "fields": ["attendees"] }
    ]
  },
  "editTemplate": {
    "layout": "tabs",
    "fields": [
      { "path": "title", "widget": "text", "label": "Event Title" },
      { "path": "startDate", "widget": "datetime", "label": "Starts" },
      { "path": "endDate", "widget": "datetime", "label": "Ends" },
      { "path": "attendees", "widget": "did-picker", "label": "Invite", "multiple": true }
    ]
  },
  "createdAt": "2026-02-23T10:00:00Z"
}
```

### Self-Hosting Bootstrap

The system needs a bootstrap template for `app.peek.lex.templateSet` itself. This ships as a built-in default:

```
app.peek.lex.templateSet (the lexicon for template sets)
  |-- Built-in default template (list: table of template sets, detail: preview, edit: template editor)
  |-- Users can override with their own template for template sets
```

### Sharing Flow

1. User creates a template set in the fiddle UI
2. Saves it to their PDS as an `app.peek.lex.templateSet` record
3. (Optional) Publishes as a Web Tile for content-addressed distribution
4. Other users discover via feed, search, or direct link
5. Other users save a copy to their own PDS (or reference the original)

---

## 6. Widget System

### Field Type to Widget Mapping

The widget system maps lexicon field types and formats to appropriate UI widgets. The "Current" column shows what `lexicon-ui.js` does today; "Template upgrade" shows what a template could specify instead.

| Lexicon Type | Format/Constraint | Current (lexicon-ui.js) | Template Upgrade |
|---|---|---|---|
| `string` | (none) | `<input type="text">` | `richtext`, `select`, `code` |
| `string` | long text (>500 chars or name matches content/body/text) | `<textarea>` with char counter | `richtext` with markdown toolbar |
| `string` | `const` | `<input type="hidden">` | (keep hidden) |
| `string` | `enum` | closed `<select>` dropdown | `radio` buttons, pill selector |
| `string` | `knownValues` | open `<select>` + "Other..." text input | same + autocomplete |
| `string` | `datetime` | `<input type="datetime-local" step="1">` | date picker, daterange, relative |
| `string` | `uri` | `<input type="url">` | link preview, embed picker |
| `string` | `at-uri` | `<input type="text">` placeholder | record picker with search |
| `string` | `did` | `<input type="text">` placeholder | `did-picker` with avatar/search |
| `string` | `handle` | `<input type="text">` placeholder | `handle-picker` with search |
| `string` | `language` | 20-language `<select>` + custom BCP-47 | same (already good) |
| `string` | `cid`, `nsid`, `tid`, `record-key` | `<input type="text">` | (keep as-is, niche types) |
| `integer`/`number` | (none) | `<input type="number">` with min/max/step | `slider`, `rating` |
| `boolean` | (none) | `<input type="checkbox">` | `toggle` switch |
| `blob` | (none) | `<input type="file">` with size info | drag-drop with preview, image crop |
| `bytes` | (none) | JSON textarea fallback | hex editor, base64 |
| `array` | any items | "Add item" button + per-item inputs + "Remove" + counter | `tag-picker`, `multiselect`, sortable list |
| `ref` | (none) | resolves and renders inline (recursive to depth 4) | `ref-picker` with search, inline collapse |
| `union` | (none) | type `<select>` + renders selected variant inline | tabbed variants, visual type selector |
| `object` | (none) | renders nested properties recursively | collapsible sections, tabs |
| unknown/fallback | (none) | JSON `<textarea>` | `json-editor` with syntax highlighting |

### Widget Interface

Each widget should implement a standard interface compatible with `collectFormData()`:

```
Widget Contract:
  - render(value, schema, options) -> DOM element
  - getValue() -> field value  // must match what collectFieldValue() expects
  - validate(value, schema) -> { valid: boolean, errors: string[] }
  - onChange(callback) -> void
  - setReadOnly(boolean) -> void
```

**Compatibility note**: The existing `collectFormData()` collects values by querying DOM elements (`input`, `textarea`, `select`) by name attribute. New widgets MUST either:
- Use standard form elements with `name` attributes (simplest — works with existing collection)
- OR register a custom collector in a widget registry that `collectFormData()` consults

### Custom Widgets

Users (and template authors) should be able to create custom widgets. A custom widget is essentially a small Web Tile:

```json
{
  "widget": "custom",
  "customWidget": {
    "name": "color-swatch-picker",
    "tile": "bafy...abc",
    "config": { "palette": ["#ff0000", "#00ff00", "#0000ff"] }
  }
}
```

### Built-in Widget Library

The following widgets should ship with the studio:

**Text Inputs:** `text`, `textarea`, `richtext` (with markdown toolbar), `code` (with syntax highlighting)

**Selectors:** `select` (dropdown), `multiselect` (tags), `radio`, `checkbox`, `toggle`

**Date/Time:** `date`, `time`, `datetime`, `daterange` (two dates with visual range)

**Identity:** `did-picker` (search for users by handle, shows avatar), `handle-picker`

**Media:** `blob-upload` (drag-drop file), `image-upload` (with preview and crop)

**Numeric:** `number`, `slider`, `rating` (star rating)

**Structured:** `json-editor` (raw JSON with validation), `nested-form` (recursive form generation), `ref-picker` (search and select a record by AT URI)

**Special:** `tag-picker` (integrates with Peek's tag system), `location-picker` (map-based), `color-picker`

### Display Formatters (for List/Detail Views)

| Formatter | Input | Output |
|---|---|---|
| `date` | ISO datetime string | Localized date (e.g., "Feb 23, 2026") |
| `relative-time` | ISO datetime string | Relative (e.g., "3 hours ago") |
| `truncate` | Long string | First N chars with ellipsis |
| `identity` | DID string | Display name + avatar |
| `link` | URI string | Clickable link |
| `image` | Blob ref | Thumbnail image |
| `markdown` | Markdown string | Rendered HTML |
| `json` | Any value | Syntax-highlighted JSON |
| `filesize` | Integer (bytes) | Human-readable (e.g., "2.3 MB") |
| `boolean` | Boolean | Check/cross icon |

---

## 7. Discovery and Sharing

### Storage Layers

**Local Storage (Extension Settings)**
- User's active template set preferences
- Draft templates in progress
- Recently used templates

**PDS Storage (Lexicon Records)**
- Published template sets as `app.peek.lex.templateSet` records
- Template set preferences as `app.peek.lex.templateSetPreference` records
- Synced across devices via Peek's sync infrastructure

**Content-Addressed Distribution (Web Tiles)**
- Published templates packaged as DASL Web Tiles
- Immutable, verifiable, self-contained
- Discoverable via CID

### Discovery Mechanisms

**1. Built-in Template Gallery**
- Ships with templates for common lexicon types (bsky post, bsky profile, calendar events, etc.)
- Curated list maintained by Peek

**2. Community Feed**
- A dedicated feed/collection of template set records
- Users can "like" or "repost" template sets
- Sorted by popularity, recency, or relevance to the user's installed lexicons

**3. Lexicon-Scoped Search**
- When viewing a lexicon in the studio, show available templates for that NSID
- "Find templates for this lexicon" button
- Query user's PDS, followed templates, and (if available) a template index

**4. Direct Sharing**
- Share via AT URI: `at://did:plc:abc/app.peek.lex.templateSet/3k2...`
- Share via CID (for Web Tile version)
- Import from URL or file

### Publishing Flow

```
[Create in Fiddle] --> [Save to PDS] --> [Optional: Package as Web Tile]
                           |                         |
                           v                         v
                   [Visible to followers]    [Content-addressed, shareable]
                           |
                           v
                   [Discoverable in gallery]
```

### Trust and Safety

- Templates from untrusted sources run in sandboxed iframes (Web Tile model)
- Locally authored templates can run with full access to Peek components
- Template metadata includes author DID for accountability
- Users can report problematic templates
- Built-in templates are signed/verified

---

## 8. Implementation Phases

### Phase 1: Foundation (Edit Templates Only)

**Goal:** Make the existing form generation configurable without breaking it.

- Add a `templateOverrides` parameter to `generateForm()` in `lexicon-ui.js` — an optional JSON object that can override widget type, label, placeholder, hidden, readOnly, order, and width per field path
- Build a widget registry that `renderInput()` consults before falling back to its hardcoded type dispatch. Initially register the existing renderers as named widgets (text, textarea, number, checkbox, select, datetime-local, file, json-fallback)
- Add 3-4 new widgets that are clear upgrades: `toggle` (replaces checkbox for booleans), `did-picker` (search by handle, show avatar — replaces plain text input for DIDs), `richtext` (markdown toolbar — replaces plain textarea for long text)
- Auto-generate a default `editTemplate` JSON from any lexicon schema (captures what `generateForm()` would do, as serializable JSON)
- Add a "Customize Form" button in the studio's Create Record view that opens a simple field editor (reorder fields, change widgets, set labels)
- Store custom edit templates in extension settings keyed by NSID
- `chain-form.js` also reads templates via the same path — so cmd palette "new" commands get customized forms too

**Validates:** Widget registry works, existing forms don't break, customization UX is usable, templates serialize correctly.

### Phase 2: Fiddle UI (Two-Pane Start)

**Goal:** A side-by-side editor for templates.

- Build a split-pane view: template JSON editor on one side, rendered preview on the other
- Add the Raw JSON pane (schema + sample data)
- Live preview updates as template changes
- Tab bar for switching between edit/detail/list template editing
- Basic detail template support using HTML with Handlebars syntax
- Integrate display formatters for the detail view

**Validates:** The fiddle interaction model, live preview, template editing workflow.

### Phase 3: List Templates and Layouts

**Goal:** Collection-level display templates.

- Implement list template rendering engine with layout types: `table`, `grid`, `list`
- Column definitions with sortable headers
- Item template rendering (HTML per item)
- Calendar layout for datetime-heavy lexicons
- Sample data generation: create N records from a schema for list preview

**Validates:** List views work across layout types, template expressiveness is sufficient.

### Phase 4: Templates as Lexicons

**Goal:** Store and sync templates via PDS.

- Define and register `app.peek.lex.templateSet` lexicon
- Save/load templates to/from user's PDS
- Template set selection UI: per-lexicon template picker
- Sync template preferences across devices via existing Peek sync
- Import templates from AT URI

**Validates:** Meta-circular storage works, sync integration, multi-device experience.

### Phase 5: Full Fiddle (Four-Pane)

**Goal:** Complete the studio experience.

- Four-pane layout with resizable panels
- Generated form pane (reference view)
- Widget palette with drag-and-drop into templates
- Template validation and error reporting
- Field autocomplete in the template editor
- Keyboard shortcuts and power-user features

**Validates:** Full editing workflow, developer experience is productive.

### Phase 6: Web Tile Packaging and Discovery

**Goal:** Share templates with the community.

- Integrate `@dasl/tiles` for packaging templates as Web Tiles
- Publish workflow: template -> Web Tile -> sharable CID
- Template gallery UI within the studio
- Search and browse templates by target lexicon
- Install templates from gallery to local PDS
- Sandboxed rendering for third-party templates

**Validates:** End-to-end sharing flow, security model for untrusted templates.

### Phase 7: Custom Widgets and Advanced Features

**Goal:** Extensibility and polish.

- Custom widget API: register new widgets as Web Tiles
- Widget marketplace (discover and install community widgets)
- Template inheritance: extend a template set rather than replacing it entirely
- Template versioning and migration
- Conditional field visibility in edit templates
- Computed/derived fields in detail/list templates

---

## 9. Open Questions

### Template Language

1. **Handlebars vs. lit-html vs. something else?** Handlebars is logic-less and safe but limited. lit-html is more powerful but requires a JS runtime in the template. A purpose-built mini-language could thread the needle.

2. **CSS in templates:** Should templates include their own CSS? Scoped styles? Or must they use a predefined set of utility classes / Peek's design tokens?

3. **Should edit templates also support HTML mode?** Or is the declarative JSON schema sufficient? Some edit UIs (e.g., a multi-step wizard with conditional fields) may need more expressiveness.

### Security

4. **Sandboxing model for HTML templates:** If a template includes `<script>`, how is it sandboxed? Web Tiles solve this for published templates, but what about locally-authored ones?

5. **Template validation:** How strictly should templates be validated? Can a template reference fields not in the lexicon schema? (Useful for forward-compatibility, risky for errors.)

### Data and Storage

6. **Template size limits:** How large can a template set be as a PDS record? Lexicon records have size constraints. Large templates with embedded CSS/images may need blob references.

7. **Template versioning:** When a lexicon schema changes (new fields added), should existing templates auto-update? How to handle schema migrations in templates?

8. **Template set inheritance:** Can a template set extend another? (e.g., "like Calendar Pro but with a dark theme") What is the override/merge model?

### UX

9. **Visual template editor:** Phase 1 uses a code editor for templates. Should there eventually be a WYSIWYG / drag-and-drop editor? How complex can that get before it becomes a full app builder?

10. **Mobile/responsive:** How do templates behave on Peek mobile? Are separate mobile templates needed, or should templates be responsive by default?

### Ecosystem

11. **Compatibility with other atproto clients:** If templates are stored as lexicon records, could other atproto apps also use them? Should the template format be standardized beyond Peek?

12. **DASL maturity:** Web Tiles is a young specification. Is it stable enough to build on? What is the fallback if the spec changes significantly?

13. **Relationship to existing atproto lexicon tooling:** Tools like `@atproto/lex` already generate types from lexicons. Can we leverage that for template validation and autocomplete?

14. **Community governance:** Who curates the template gallery? How are templates moderated? What prevents a popular template from being updated maliciously?

---

## References

- [AT Protocol Lexicon Specification](https://atproto.com/specs/lexicon)
- [Lexicon Schema System (DeepWiki)](https://deepwiki.com/bluesky-social/atproto/2.3-lexicon-schema-system)
- [DASL -- Data-Addressed Structures and Links](https://dasl.ing/)
- [DASL: MASL Specification](https://dasl.ing/masl.html)
- [DASL: Web Tiles Specification](https://dasl.ing/tiles.html)
- [Web Tiles (webtil.es)](https://webtil.es/)
- [Web Tiles Explainer (Robin Berjon)](https://berjon.com/web-tiles/)
- [Web Tiles Explainer (HackMD)](https://hackmd.io/@robin-berjon/tiles)
- [@dasl/tiles npm Package](https://www.npmjs.com/package/@dasl/tiles)
- [Lexicon Style Guide Discussion](https://github.com/bluesky-social/atproto/discussions/4245)
