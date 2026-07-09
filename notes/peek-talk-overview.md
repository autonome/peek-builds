<!--
  SLIDESHOW: open peek-talk-slides.html (same folder) — it renders THIS file as slides.
  Slide breaks are headings: every #, ##, or ### begins a new slide; `---` rules are ignored.
  This markdown stays the single source of truth — edit here, reload the page. Arrow keys navigate.
-->

# Peek — Talk Overview

*Speaker's reference for the Peek talk: an overview + live demo of a web user agent that isn't a browser. Author's background threads through everything — Firefox/Mozilla, 2006–2019. Repo: `mpeek`.*

---

## 1. Elevator Pitch

**One line:** "Peek is a web user agent application designed for using the web where, when and how you want." Taglines: *"a workbench for the web / a window manager for the web / what you want it to be."*

**The problem it attacks:** today's browsers are one-size-fits-all, cramming the entire web into "an unmodifiable tabbed-window design." The thesis: we always use the web *with a goal*, and that goal should drive the shape of the interface. The user should be "driver, creator, maker, shaper" of the interface — not the browser vendor.

**What it is NOT** (all-caps in the README for emphasis — stage gold):
- **"PEEK IS NOT A BROWSER."** No tabs, no windows in the tabbed-browser sense. It deliberately drops many browser details "you do not notice until they are missing." Best understood as "an entirely different type of application."
- **"PEEK IS A CONCEPT PREVIEW."** A proof of concept, **"NOT safe for daily use yet."** No security audit. The security model and security UI are explicitly "not yet determined." Be honest about this on stage — it's a research vehicle, not a product you should point people at as their daily browser.

**The felt experience the design chases** (memorable, quotable):
- "Feels like home: trust, comfort, control."
- "Continuous instances of magical mind-reading."
- "Sleep at night because no idea or anything you saw is ever lost."
- **"Create, save, classify at the speed of thought."**
- The magic is engineered, not hand-wavy: *"Frecency everywhere all of the time"* + *"User actions are training data for sorting"* + *"The thing you were thinking of is already at the top of the list."* (Frecency = frequency + recency.)

**Lineage / origin story** (strong narrative arc): Peek descends from four Mozilla initiatives the author worked near — the **Awesomebar** (infinite history + a personal local search index), **Ubiquity** (natural-language commands + chaining), **Jetpack** (web-centric extensibility), and **Panorama/TabCandy** (web pages as *groups* instead of tabs). Peek "has some bits of each." It literally *began* as a browser extension — peek at favorite pages via a keyboard shortcut into a chromeless modal, ESC to close — and was abandoned because "browser extension APIs became increasingly limited" and you couldn't build a decent UX. The conclusion: *"The only way to create the ideal user experience for a web user agent that Does What I Want is to make it a browser-ish application."* That's why Peek is now an app, and why the browser extension survives only as a sync/import satellite (see §3).

---

## 2. Design Decisions, Characteristics & Constraints

### Small core; features ARE the functionality (the central inversion)
Peek inverts the traditional browser model. Instead of a big monolithic core with a bolted-on extension API, Peek is a **minimal core** with features that *are* the functionality. Deliberate language: they say **"features"** (implementation term: **"tiles"**), NOT "extensions" — because "extend implies a larger core that you cannot change. Peek inverts that to small core, with as much changeable as possible." Features "are not extending core functionality, they ARE the functionality." (The architecture doc even flags using "extension" as a synonym for tile as a "smell" — a v1 leftover.)

*"A tile is a feature. Full stop."* A tile = an HTML file in its own Electron `BrowserWindow`, on its own `peek://{tileId}/` origin, with a capability-gated preload and a strict `tile:*` IPC surface. There is no "tile type" or "tile role." The only two axes are **Residency** (resident-at-startup vs lazy) and **Visibility** (shown vs hidden).

Five iterations to get here (a good "we tried everything" slide): (1) all Electron / privileged JS; (2) each feature a separate web app with a tiny custom API + one orchestrator; (3) all features bundled into one web app; (4) MVP core loading features into an opaque origin; (5) **current**: each feature its own BrowserWindow on its own `peek://` origin — one renderer mechanic for every feature *and* for the core renderers themselves.

### IZUI — the signature navigation idea (most demo-able, most distinctive)
**"Inverted Zooming User Interface."** Normal zooming UIs start at a known root and zoom ever further *in*, then back out. IZUI inverts it: you can **enter the window stack at any point** — often from *outside* the app entirely via a global hotkey — and every interface zooms *out* via ESC to go back. **"Enter from anywhere, ESC to go back — predictable at every level."** The killer property: you can peek from another application and ESC returns you to exactly where you were, without breaking task flow. Runtime distinction:
- **Transient** windows (invoked from another app via global hotkey): ESC closes immediately, focus returns to the previous app.
- **Active** windows (invoked within Peek): ESC navigates internally, never closes.
- Transient-ness *propagates* to child windows.

> **DEMO BEAT:** From Safari, hit Opt+Space, act in the peek, press ESC — you're back in Safari exactly where you left off.

### Local-first, files-over-formats, consent-gated (the values slab)
"Files > arcane/opaque boxes/formats." "Metadata can be weird non-file, as long as consistent." "External systems require consent to touch my stuff." "Web user agents should be bounded by the user, not browser vendor business models." "Windows and tabs should have died a long time ago." Security UI "must be a clear articulation of risks and trade-offs, and users should own the decisions." And a deliberate decoupling: html+js+css need not come bundled with http+dns+ssl — that trust/security model is "not a required starting point." "Javascript is ok here."

### Capability security model (enforced by construction)
Every tile **declares** the capabilities it needs in `manifest.json` (schema v3). At load, the main process mints a per-window **capability token**, revoked at unload. Grants are allowlisted and granular: network = per-domain allowlist; datastore = per-table allowlist; filesystem = per-path globs (builtin-only); pubsub = scopes + topic allowlist. `sync` and `filesystem` are restricted to built-in tiles. Core renderers get a `trustedBuiltin: true` grant that short-circuits checks — but the bypass is explicit at every call site (grep-able).

**The IPC chokepoint:** every single `tile:*` IPC frame runs a fixed **6-step validation pipeline** before any handler fires: (1) channel allowlisted; (2) sender frame matches the token owner *(closes forged-token-via-XSS)*; (3) payload schema valid (hand-rolled shape checks — "Zod/Ajv is too slow for the per-frame budget," ~5µs); (4) token valid + capability granted; (5) tile is in a dispatchable lifecycle state; (6) sender role allowlisted. Dev-mode adds two bypass detectors that monkeypatch `WebContents.send` and `BrowserWindow.loadURL` so any back-door attempt is "a loud assertion failure rather than a silent bug."

### FSMs over timing hacks (engineering-philosophy story — memorable)
Three explicit state machines replaced "ad-hoc timing code (sleeps, polling, visibilitychange listeners, retry hacks)." Each makes a bug class *impossible* and is unit-testable as a pure function (deep dive in §6.4/§6.7):
1. **Tile lifecycle FSM** — owns *when* a tile is alive.
2. **PubSub state machine** — owns *what* messages can flow in each state.
3. **Cmd panel state machine** — owns the interactive command-bar UI states.

A fourth (page-host window-state) exists but targeted the now-removed canvas host. Related: **window placement** is also a pure module — bounds are always a *derived projection* of intent against live display state, never stored as truth; cursor position is never consulted.

### Small, portable API surface (non-goal: being a full browser)
The entire API a tile sees is `window.app`, exposed by `tile-preload.cts`. The design question was: "what is the minimum capability set a tile needs?" Namespaces: window, shortcuts, pubsub, commands, datastore, escape, izui, files, settings, themes, sync, profiles, net, session. "Intentionally small and portable — features built on it could run in other environments with minimal adaptation."

### Notable deliberate constraints / sharp edges (hard-won-lessons color)
- **`tile-preload` must stay `.cts` (CommonJS), not `.ts`.** tsconfig `module: NodeNext` emits ESM for `.ts`, and the Electron sandbox preload **silently rejects ESM** — no error, just an empty `window.app` and every tile broken. A great sharp-edge anecdote.
- **`app/` (the core renderer) is backend-agnostic and protected** — it must run unchanged under Electron *and* Tauri; "never modify without explicit review."
- **Electron intercepts ESC at the main-process `before-input-event`** and preventDefaults it — DOM ESC keydown listeners in renderers are *dead code*. ESC is delivered via IPC to an `onEscape` handler.
- **Linux/Wayland: global hotkeys can't fire when Peek is backgrounded** — Wayland forbids apps grabbing keys; `globalShortcut.register()` returns false silently. Mitigations in §6.9.
- Requires **Electron 40, Node 24+.** "Proof of concept is Electron. By far the best option today… There is really nothing else remotely suited (yet)."

### Scale / maturity signals (credibility)
~2,000 tests across 69 files (README); the current canonical desktop gate `yarn test:desktop:electron` runs **all 6 runners, ~3,190 unique tests, ~10 min wall-clock** (the newer, desktop-scoped figure, including ~1,950 main-process unit tests). 146+ package.json scripts. License MIT. Primary git remote is Tangled; GitHub is Railway-deploy only. Local workflow uses **jj (Jujutsu)**, not git.

---

## 3. Multi-Device & Platform Topology

**In one breath:** Desktop (Electron — the workbench) + Mobile (Tauri "Peek Save," capture-focused, with a Swift share extension) + Extension (MV3, one-way browser import) are three **clients**. They all speak a shared sync schema (`packages/schema`, single source of truth) via a shared sync engine (`packages/sync`) to a passive Hono/SQLite store on Railway (`apps/server`). Tauri-desktop is a paused proof that the core is backend-agnostic. `packages/integration-tests` proves the whole mesh converges.

Monorepo layout (current, verified): `apps/{desktop, mobile, server, extension, tauri-desktop}` + `packages/{schema, sync, integration-tests}`. *(Note: README/DEVELOPMENT.md still describe an older `app/` + `backend/` layout — stale. `docs/architecture.md` uses the current `apps/…` paths.)*

- **apps/desktop — Electron, the flagship.** The whole tile model, capability system, IZUI, the 3 FSMs, cmd bar, editor, entities, MCP, etc. Data: SQLite via **better-sqlite3**.
- **apps/mobile — Tauri Mobile "Peek Save" (iOS + Android).** A *narrower* app than desktop: a save/capture + browse companion, not the full workbench. React + TypeScript + Vite frontend; Rust + Tauri v2 backend; a shared platform-agnostic `peek-core` Rust crate. The iOS Share Extension is full custom Swift UI; it and the main app run the *same* `peek-core` Rust logic via **UniFFI** against the *same* SQLite DB in an iOS App Group container. Detail in §5.
- **apps/server — webhook/sync server (Hono, Railway).** "A very passive sync+store service… I use it daily with few problems." Multi-user (per-user isolated DB) or single-user self-host; Bearer API keys, SHA-256 hashed. Explicitly *does not implement the Peek API* — it's a standalone Node server sharing only the schema/sync contract. Deploy is a `git subtree split` into a `deploy/server` branch that Railway watches (must use npm, not yarn — yarn.lock breaks Nixpacks).
- **apps/extension — MV3 (Chrome + Firefox).** Loaded as source, no build step. Provides sync, profile management, and **one-way browser → Peek import** (three importers: bookmarks / tabs / history, each tagging `from:*`). This is the spiritual heir to the *original* Peek — now demoted to a sync/import satellite because extension APIs can't deliver the core UX.
- **apps/tauri-desktop — Rust desktop alternative, OFF the critical path.** "Months out of date, not actively maintained." Exists only as evidence of the backend-agnostic ambition. Mention, don't demo.
- **packages/** — `schema` (canonical `v1.json`; server + desktop validate on startup and fail fast on drift), `sync` (the shared JS sync engine + adapters), `integration-tests` (three-way merge, version-compat, migration-regression — where the multi-device promise is actually verified).

**How it syncs:** hub-and-spoke, **server is source of truth**, last-write-wins on `updatedAt`. Not peer-to-peer, not CRDT. Per-item sync metadata (`_sync: {createdBy, modifiedBy, …}`) lives *inside* the item's metadata JSON so it survives the trip. Two integer version gates — `DATASTORE_VERSION` (schema shape) and `PROTOCOL_VERSION` (wire format) — return HTTP 409 on mismatch. Device IDs are raw UUIDs.

**Profiles** (isolation model, spans desktop + server): each is an isolated workspace with its own SQLite DB, its own Chromium session, its own sync config. Production builds use `default`; dev builds (`yarn start`) *always* use `dev` (isolated from prod data — a deliberate safety choice). Switching requires a restart.

---

## 4. Cross-System: Classification (and entities/sync as cross-cutting themes)

**Classification is the design centerpiece** — it's how "Create, save, **classify** at the speed of thought" and "continuous instances of magical mind-reading" become real. It's what turns the unstructured web into a personal, queryable knowledge store. Peek classifies at **three distinct layers.**

**Layer A — Item TYPE (structural, on-capture, SHIPPED).** One unified `items` table, discriminated by a hard `type` CHECK constraint: `url, text, tagset, image, series, feed, entity, event`. The creator picks the type (browser capture → `url`, note → `text`, tag-only → `tagset`, RSS → `feed`, entity extraction → `entity`). The coarse cut.

**Layer B — TAG classification (heuristic / rule-driven, SHIPPED).** Tags are the primary categorization mechanism. Auto-applied provenance tags on browser import (`from:history`, `from:tab`, `from:bookmark`). Groups are "tags promoted to a group." Hashtag extraction (`#word` → tag). The **rules engine** (`rules` table) is a declarative classify-on-event system: an event `topic` + a JSON `match` predicate → a `scriptId`. Rule sources: `manifest` (feature-declared, id = SHA-256 content hash), `user` (rule-editor UI), or `runtime`. This lets features react to captured content *without staying resident* — e.g. the entities feature declares rules on `page:content-ready` and `item:created`.

**Layer C — ENTITY TYPE classification (heuristic + local name DB, SHIPPED — the interesting part).** When content is captured, extracted names are classified into a typed taxonomy: `person, organization, place, event, product, creative_work, email, phone, date, tracking_number, price`. Crucially, this is **rules + heuristics + a shipped local name database — NOT ML, NOT a remote service.** It runs **client-side on the desktop** in a lazy background tile, triggered by the rules engine. Concrete mechanisms:
- **Schema.org type map** — ~70 JSON-LD `@type` strings folded into the 11 entity types (`Corporation/Restaurant/SportsTeam → organization`; `City/TouristAttraction → place`; `NewsArticle/Movie/Podcast → creative_work`; etc.).
- **Name-pattern heuristics** (pure JS, zero deps): org suffixes (`Inc|LLC|Corp|University|…`), honorifics (`Dr|Prof|…` → person), CamelCase single word (`YouTube` → org/brand), ALL_CAPS (acronym → org), `The X` → org. Each returns `{likelyType, confidence, reason}`.
- **Local name database** (~2,000 first names + ~1,000 surnames, loaded lazily): O(1) Set lookups for "is this a person's name?"
- **`validateEntityType(name, claimedType)`** is the gate — it can *reject* a misclassification or *re-type* it (a JSON-LD "Person" named "IndieWeb" gets reclassified to organization, confidence ×0.8), alongside a ~60-name blocklist ('home', 'about', 'privacy policy', …), a min-length filter, and a 0.7 confidence threshold.

Why it's a centerpiece: it turns passive browsing into a structured, typed, self-classifying knowledge base **with no user effort** — the literal "magical mind-reading" pitch.

**Cross-cutting theme — entities (what's shipped vs. researched):**
- **SHIPPED:** extraction + typed classification + storage + a browser UI. Feature "Entity Recognition" v3.0.0. Three extractors run in parallel (structured-data JSON-LD/OG/microdata; h-card/h-event microformats; regex for emails/phones/addresses/tracking numbers/prices). Entities *are* items (`type='entity'`); each sighting is an `item_events` row, so "which pages mention X" and "which entities on page Y" are already derivable. Dedup by normalized name + aliases; thumbs-up/down feedback suppresses entities.
- **RESEARCH / DESIGN ONLY — confirmed absent from code:** the **entity correlation graph** (`docs/entity-correlation-design.md`, "Design proposal — not yet implemented"): a co-occurrence relationship graph scored with PMI/NPMI, temporal decay, clustering into groups like {Elon Musk, Tesla, SpaceX, SEC}, a force-directed d3 view. And **authoritative Wikidata validation** (`docs/entity-validation-research.md`, "Research — not yet implemented"): async P31 instance-of checks post-storage. Note: **Phase 1 of that validation research (name-patterns + name-DB + schema-coherence) IS the shipped `name-validator.js` above**; Phase 2 (Wikidata) is not. On stage: entities-as-live is real; the knowledge-graph vision is the *next chapter*, not a shipped feature.

**Cross-cutting theme — sync** (detail in §6.18): local-first + central server + last-write-wins; the *same protocol re-implemented in four places* (JS×2 patterns + Rust×2) is a genuine risk worth naming. Push failures are logged but **not retried** (a known high-severity limitation). Mobile still carries schema drift (snake_case, ISO timestamps) — but sync still works because **the wire format (JSON) is independent of local schema.**

---

## 5. Mobile App — Features & Flows

**"Peek Save"** — save and organize URLs, notes, images, and tag-sets with frecency scoring. A capture-and-browse companion, not the full desktop workbench. React 19 + Vite frontend; Rust + Tauri v2 backend; a shared `peek-core` Rust crate (schema, item CRUD, tags, sync, profiles, offline). The key design choice: **`peek-core` is compiled into both the main Tauri app *and* the iOS Share Extension via UniFFI**, so a save from the share sheet and a save from the app run identical business logic against the same App Group SQLite DB.

**Item types (4), tabbed browse:** Pages (URLs), Notes (free text with inline `#hashtags` auto-parsed; markdown rendered, live checkboxes), Tag Sets (reusable tag combinations), Images (with thumbnails, mime, dimensions).

**Capture:**
- Global quick-add bar at the bottom — one field that becomes a page, a #tagged note, or a tagset depending on content. Draft persisted.
- Camera capture → image item.
- **iOS Share Extension** (full custom Swift UI): save from any app's share sheet — URLs, text, images — *without opening the app*, writing straight into the shared App Group SQLite via UniFFI.
- **Android share intents**: `ACTION_SEND`/`ACTION_SEND_MULTIPLE` persisted to a file-based queue, drained on next focus (deterministic across cold launch).

**Tagging + frecency intelligence:** frecency-scored tag suggestions (`frequency × 10 × decay`, decay `= 1/(1 + days_since_use/7)`); **domain-affinity boost** (tags previously used on the same domain get a 2× multiplier so relevant tags surface first); URL de-dup with set-union tag merge on re-save.

**Triage widgets (per-card one-tap toggles):** configurable tag *pairs* — todo/done checkbox, readme/read book icon, today/later (! vs 💤). Each renders only when the item already carries one of the pair's tags.

**Viewing:** native in-app WebView (WKWebView / Android WebView) via a custom Tauri plugin, Reader mode (readable article extraction), Open in Safari / in app, and **offline reading** (download a page, read it later with no network). Opens are recorded via `record_visit` (feeds frecency/history).

**Browse UX:** SQL-side filtering/sorting/pagination (`query_items`, 30/page, infinite scroll); search + multi-select tag chips + sort; config-driven hiding of archived / `from:history` rows; pull-to-refresh hold gesture; swipe-down-to-dismiss editors; auto-continuing markdown lists in the note editor.

**Sync:** bidirectional, per-bucket routed by `synced_profile_id` (an item re-pushes if never synced, modified since, or last synced to a *different* bucket); LWW on `updated_at`; offline-aware. **Selective types** — only user-curated types (`url/text/tagset/image`) push by default; locally-derived types (entity/series/feed, produced on desktop) are pulled/skipped, never pushed.

**Profiles:** multiple, each its own SQLite DB + sync config; dev builds → `dev`, TestFlight/App Store → `default`.

**Headline flows to demo:**
> **DEMO BEAT:** In Safari, Share → "Peek Save" → the custom share-ext UI appears → pick/create frecency-sorted tags (dup detection merges tags if already saved) → save, no app launch.

**Planned / researched (NOT shipped — roadmap, don't demo as done):** WebView bottom-sheet presentation (current impl is full-screen modal); a Tauri Vision-framework image-analysis plugin; a Safari Web Extension one-tap save. All plan/research only.

---

## 6. Desktop Deep Dive

*This is the heart of the talk. The desktop app is where the tile model, capability system, IZUI, the FSMs, the cmd bar, the editor, entities, and MCP all live.*

### 6.1 The "Minimal Core" vs a Full Browser

Peek is **not** a browser — it's a minimal *platform* core, and browsing is one feature (a tile) bolted onto that core. The design inverts the usual stack: instead of "a browser that can run extensions," Peek is "a small trusted runtime + capability system, on which *every* user-facing thing — including web page rendering — is a tile."

**Everything that's a FEATURE (= a tile):** web page rendering, websearch, peeks, slides, groups, tags, editor, entities, mcp-server, windows, and dozens more. Each lives in `features/<id>/` with a `manifest.json`.

**What's CORE (`app/` — not a feature, can't be uninstalled, no manifest, no sandbox):**
- **bgWindow** (`peek://app/background.html` → `app/index.js`) — the core orchestrator. Hosts the cmd registry, page controller, HUD, session mgmt, pubsub. Every pubsub publish must reach it.
- **cmd, page, hud** — the three surfaces, consolidated into the core renderer via `initCmd()` / `initPage()` / `initHud()` in `app/index.js` (consolidated April 2026).
- The **main process** (`apps/desktop/main/`): `datastore.ts`, IPC, the `peek://` protocol, plus the tile lifecycle / pubsub / gate machinery.

**Why cmd/page/hud can't be tiles** (the extraction argument): (1) they can't be uninstalled — no cmd = no invocation, no page = no web rendering; (2) they can't be published — "a cmd on atproto makes no sense," they *are* the Peek interface; (3) they need deep platform integration (cmd needs global shortcuts, hud needs main-process focus handling, page needs WebContentsView embedding) — sandboxing them is actively harmful; (4) the capability model is for *untrusted* code and breaks down when the code *is* the trusted platform. "The friction is a signal."

**Shipped vs planned:** the tile model + bgWindow-as-core + `trustedBuiltin` + consolidation into the core renderer are **SHIPPED** (v1 fully removed April 2026). The *physical move* of cmd/page/hud out of `features/` into `app/cmd/`, `app/page/`, `app/hud/` with thin per-backend glue files (`cmd-glue.ts`, etc.) is **PLANNED** — sequenced after the remaining features become tiles. Don't present the physical extraction as done.

### 6.2 The Cross-Backend API

The API is **`window.app`** (aka `api`), exposed to *every* `peek://` renderer by the preload. Why backend-agnostic? "Implemented by both the Electron and Tauri backends, ensuring frontend code works unchanged across backends." The runtime is transparent to callers.

**Target backends:** Electron main (shipped canonical), Tauri desktop (off critical path), Mobile via Tauri, Server (shares the datastore schema/sync contract, not a `window.app` host), Web (referenced for settings).

**The stable surface each backend implements:**
- `window.app.window.*` — open/close/hide/show/focus/list/exists; window-animate, set-always-on-top. Options: key (reuse), geometry, modal, transparent, decorations, alwaysOnTop, keepLive, escapeMode.
- `window.app.datastore.*` — items/visits/tags/generic-table/stats.
- `window.app.publish/subscribe` + scopes.
- `window.app.shortcuts.register/unregister` (local + `{global:true}`).
- `window.app.commands.register/unregister/getAll`.
- `window.app.theme.*`, `.escape.onEscape`, `.izui.*`, `.log`, `.quit/.restart`, `.extensions.*` (core-only), `.settings.*`.
- **Uniform response envelope everywhere:** `{ success, data?, error? }`.

**How the SAME feature code runs in different runtimes:** feature code only ever touches `window.app.*` (bare Electron IPC is a smell, and only works on Electron). Each backend ships its own preload/impl of the identical shape (Electron = contextBridge in `tile-preload.cts`; Tauri = injected initialization script). Backend-specific mechanics (global shortcuts, focus, webview embedding) live *behind* the API in per-backend glue. Datastore is IPC-based specifically so renderer code stays portable and storage can be swapped per backend.

**Caveat:** the *tile runtime itself* (launcher, preload, csp, ipc, tokens) is currently Electron-specific; running tiles on Tauri needs equivalent modules. Documented as future work, not blocking. Also: `docs/api.md` is partly stale (describes the removed v1 "hybrid extension / iframe" model) — trust `docs/architecture.md`.

### 6.3 Datastore

**The datastore is better-sqlite3** — synchronous SQLite in the main process. *(TinyBase is legacy: it survives only as a one-time migration path from old profiles — a `migrateTinyBaseData()` that decodes an old serialized blob into SQL tables then drops the `tinybase` table. No live TinyBase dependency exists. If you see TinyBase in older docs, it's drift.)*

DB file: `{app_data}/{profile}/datastore.sqlite`. All ops run in the main process; renderers go through IPC via `window.app.datastore.*`. Per-backend impls: `datastore.ts` (Electron), `datastore.rs` (Tauri), `db.js` (server); canonical schema JSON at `packages/schema/v1.json` (loaded for sync-column validation).

**Core tables (unified item model):**
- **`items`** — all content types. Columns: id (UUID PK), type, content, mimeType, metadata (JSON), syncId, syncedAt, createdAt, updatedAt, deletedAt (soft-delete, 0 = active), starred, archived, visitCount, lastVisitAt, frecencyScore, plus denormalized title/domain/favicon for URLs.
- **`item_visits`** — navigation history (local-only, NOT synced): itemId, timestamp, duration, source, windowType, scrollDepth, prevId/nextId (visit chaining).
- **`tags`** (id, name unique, frecency), **`item_tags`** (junction).
- **`item_events`** — append-only time-series/observations (entity sightings live here).
- **`extension_settings`** — key/value JSON for feature + core settings.
- Lazy-wake shortcut tables. (Legacy `addresses`/`visits` tables were dropped and migrated to items/item_visits.)

Storage/query: synchronous prepared statements — `addItem`, `queryItems` (filters + sortBy created/updated/frecency/lastVisit/visitCount), `updateItem`, `deleteItem` (soft). `trackNavigation(url, opts)` finds/creates the item + records the visit + updates frecency. **Frecency is computed per-device from local visits via time-decay weighting.**

**Reactivity:** there is *no* reactive-store binding layer (exactly what TinyBase would have given). Instead: **SQL is the source of truth; pubsub is the change-notification bus; renderers re-read on event.** The datastore IPC handlers publish domain events (`item:created`, `tag:created`, `tag:item-added`, `sync:pull-completed`, …) as System pubsub; UIs subscribe and re-query. Gotcha: a direct `tagItem()` does *not* publish — you must use `tagItemAndPublish()` for reactive UI updates.

### 6.4 The Cross-Runtime Core: Settings, Cmd, Page-Host

The core is the set of cross-runtime subsystems shared by every backend, sitting under `app/` (frontend) with per-backend glue. bgWindow (`app/index.js`) wires them at boot.

**SETTINGS.** *Per-tile* settings (`api.settings.get/set/getKey/setKey`, scoped to the calling feature) are **SHIPPED**. A *global* app-settings API is **PLANNED**, not built: today there are **7 divergent ad-hoc mechanisms** for reading global settings, several Electron-only. The design is a new `api.settings.global` namespace (`get`/`set`/`subscribe`) with a single-source-of-truth `settings-registry.js` and public/internal key scoping, reactive via a `settings:global:changed` diff pubsub. *(Confirmed absent: no `settings-registry.js` file, no `settings.global` in the preload. Frame it as real present-day friction with a designed-but-unbuilt fix.)*

**CMD** (deep dive §6.10–6.15) — the command palette, Peek's primary invocation surface. Global hotkey opens it; type-ahead with frecency matching; any tile registers commands (statically in manifest or dynamically at runtime); commands can *chain* by declaring accepts/produces MIME types. It's **core infra**, not a feature (panel UI in `app/cmd/`).

**PAGE-HOST** (deep dive §6.16) — the subsystem that renders web content ("browsing is a feature" surface). The current impl is the **hybrid page-host**: a `BaseWindow` holding a positioned `WebContentsView` + one shared chrome overlay. **The old canvas page-host was REMOVED 2026-07 — hybrid is now the ONLY page-host, no flag, no fallback.** It does web-URL rewriting on open, page-info/entities panels, and emits semantic core page events (`page:search-engine-discovered`, `page:loaded`) that lazy features wake on. Core, not a feature — deep WebContentsView + focus + first-responder integration is exactly why it can't be a sandboxed tile.

**The FSMs** (philosophy: replace timing hacks with deterministic transition tables; each makes a bug class impossible, each is a pure testable function):
- **FSM 1 — Tile lifecycle** (`tile-lifecycle.ts` enforcer + `tile-fsm.ts` pure table): owns *when* a tile is alive. 7 states (see §6.7). Manifest cache populated on `unregistered→registered` so a tile's commands appear in the palette *before it ever runs*; token minted on `loading→ready`, revoked on unload/crash; **one** code path for window creation regardless of trigger.
- **FSM 2 — PubSub** (`pubsub.ts` + `tile-ipc-gate.ts`, rolled out in 8 phases): owns *what* messages flow in each state. Central trick — **the token IS the capability handle**: the pubsub path never reads lifecycle state, it only runs `validateToken(t) → grant | null`; because lifecycle mints/revokes the token exactly on ready/unload, token-validity implicitly enforces the whole policy and the "was the publish checked before or after the state change?" race becomes *unaskable*. One hub, subscriber-indexed delivery (O(subscribers-of-topic), not O(windows) — the biggest perf lever at 60 Hz topics). A startup latch guarantees subscribe-before-publish. Every rejection emits `gate:rejected` telemetry — never silent.
- **FSM 3 — Cmd panel** (`app/cmd/state-machine.js`, pure module, no DOM/IPC): 10 states (see §6.12). Replaces the old "every panel.js bug fix added another boolean flag" model.
- **FSM 4 (bonus) — Page-host window state** — written for the *canvas* era, which is gone. Cite as the FSM pattern applied to the page surface, but note its target was removed.

### 6.5 Everything-Is-a-Feature as a Paradigm

Stated plainly in `apps/desktop/CLAUDE.md`: *"Every UI surface — browser tabs, cmd panel, settings, everything — is a tile: a `BrowserWindow` loaded through `tile-preload.cts` and the capability-gated `tile:*` IPC. There is no 'tile type' or 'tile role' distinction."*

So "feature" ≈ "tile": a feature is a directory under `features/<id>/` with a `manifest.json`; a tile is the runtime BrowserWindow (or iframe) it spins up. The core app is thin — a loader, an IPC capability gate, and a few always-on registries (cmd, manifest cache, pubsub bus). Almost nothing is baked into the shell — browsing chrome, the command palette, settings panels, the editor, tag management, window switching, OAuth — all features, all loaded the same way as a demo extension.

**How radical, concretely:**
- The command palette is itself a feature — special-cased only for *load order* (everything depends on it to register commands), not for privilege.
- **Per-feature settings panels are generated dynamically at runtime** from each feature's own `settings-schema.json` — core doesn't know in advance what settings a feature has.
- Even dev/diagnostic surfaces (`hello-world`, `pubsub-repro`, `debug`, `widget-demo`) ship as *real features* in the same directory structure — there's no separate "internal tools" mechanism.

**What it buys:** crash containment (external features get their own process — "one extension crashing doesn't affect others"); origin isolation (`peek://ext/{id}/`); uniformity (one manifest schema, one capability model, one lifecycle FSM, one API — a third-party author writes to the *same contract* built-ins use; there is no privileged internal API); a hot-reload path (`{featureId}:settings-changed`); and a memory/perf dial (hybrid loading + lazy activation).

**The honest tension** (good talk beat): this radical uniformity is genuinely *young*. The lifecycle-FSM doc opens by cataloguing real bugs that came from *drift* from the policy. "Everything is a feature" only pays off once the loader/FSM/capability layers are airtight — *"the interesting part isn't the idea, it's making the idea safe."*

### 6.6 The Feature API

**`manifest.json` (schema `manifestVersion: 3`)** — canonical fields across ~34 real manifests:

| Field | Purpose |
|---|---|
| `id` / `shortname` / `name` / `description` / `version` | identity; `id` doubles as the `peek://` URL host |
| `builtin` | ships with Peek vs user-installed |
| `hidden` | excluded from user-facing lists (infra features: `mcp-server`, `sync`) |
| `tiles[]` | window/iframe surfaces this feature owns |
| `capabilities` | the sandbox contract (below) |
| `commands[]` / `shortcuts[]` | cmd-palette + static keyboard declarations |
| `rules[]` | declarative pubsub-triggered script/action rules |
| `settingsSchema` | path to `settings-schema.json` |
| `wakeShortcutsFromSettings` | opt-in: real hotkeys come from user settings, not the manifest (`peeks`, `slides`) |

`tiles[]` entries carry: `id`, `url`, `role` (`workspace`|`panel`|`overlay`), `key` (dedupe/reuse), size/title, `transparent`, `frame`, `focusable`, `alwaysOnTop`, `resizable`, `keepLive`, `lazy`, `lazyEvents[]`.

**`capabilities` — nothing is ambient; a feature must declare everything it touches:**
- `pubsub: { scopes, topics }` — **every topic published *or subscribed to* must be listed.** A consumer that only lists producer topics fails silently.
- `datastore: { tables }` — explicit table allowlist.
- `window`, `context` (shared IZUI-ish state), `filesystem` (path globs), `network: { domains }` (fetch allowlist — for `builtin` features this is *advisory/defense-in-depth only*, since builtins get the `trustedBuiltin` bypass; it's enforced for installed features), `dialogs`, `commands`/`shortcuts`/`settings`/`sync`/`oauth`/`rules`/`izui` (boolean flags), `settings.readForeign` (cross-feature read grant), and `features` (only `features-manager` — the feature that manages *other* features).

**`window.app`** namespaces: window, datastore, publish/subscribe, shortcuts, commands, theme, escape, izui, log, debug, quit/restart, extensions (core-only), settings (extension-only). Two API styles coexist: a flat legacy shim (`api.publish(...)`, "v1-compat, don't use in new code") and the strict namespaced form (`api.pubsub.publish(...)`, `api.datastore.*`).

**Init contract (a sharp edge):** every tile must `await api.initialize()` before touching any gated API (validates the token). **Wake handlers (`commands.register`, lazy-event `pubsub.subscribe`) must be registered synchronously in `init()` *before any await*** — the preload signals `tile:lifecycle:ready` on a `setTimeout(0)` that can beat an async init's first await, so a handler registered after that await can miss the very event that woke the tile.

**Reference features:** `example/` — the explicit "reference template for new Peek extensions" (feature-detects the Peek API and also runs standalone as a plain website, mime-typed command registration, storage fallback, `uninit()` cleanup). `todo/` — shipped-but-disabled by design: its manifest is named `manifest.json.disabled` so `discoverFeatures()` walks past it — re-enabling is a one-line `mv`. A nice demo of "shipped-but-off with zero runtime cost, gated by the file's *name*, not a flag inside it."

### 6.7 Feature Lifecycle

Governed by `tile-fsm.ts` (pure transition table) + `tile-lifecycle.ts` (enforcement) + `manifest-cache.ts` (SQLite-backed cache) — **confirmed shipped**, despite a doc header that says "design, pre-implementation."

**7 states:**

| State | Meaning |
|---|---|
| `unregistered` | never installed / removed; no cache row |
| `registered` | manifest parsed + cached; static declarations wired into main-process registries; renderer NOT loaded |
| `loading` | BrowserWindow created, URL loading, awaiting the renderer's `tile:ready` |
| `ready` | renderer initialized, token validated, dynamic registrations accepted; window not necessarily shown |
| `visible` | `ready` + on screen |
| `unloading` | shutdown grace window → token revoke → close → subscription cleanup |
| `crashed` | render process died; awaiting cleanup or (manual-only, never automatic) relaunch |

**Key invariants:** static declarations wire on `unregistered→registered` *only* (so a feature's commands appear in the palette *before its tile ever runs*); dynamic registrations accepted only in `ready`/`visible` (a publish outside those is a rejected violation, not a silent drop); window creation happens only on `registered→loading` via one unified code path; **command dispatch guarantees state ≥ ready** — dispatching to a not-yet-loaded tile forces `registered→loading→ready` first, and failure surfaces as an explicit error, *never a silent spinner hang* (literally the bug class that motivated the FSM).

**Lazy activation** (the default for most built-ins now — *"production fixed boot was cut from 6 to 2 windows"*):
- Making a tile lazy = drop `resident: true`; a tile with no commands but event-driven behavior also needs `lazyEvents: [...]`.
- **Wake triggers:** a `cmd:execute:<command>` for any declared command, OR any topic in the tile's `lazyEvents[]`. A matching publish calls `ensureTileLoaded` → `waitForTileReady`, then redelivers the deferred publish.
- **Global hotkeys with no renderer running:** OS accelerators are registered at boot even for unloaded lazy tiles; a shortcut can publish `cmd:execute:<command>` or a `wakeTopic` directly (e.g. `peeks`' `Option+0 → cli:peek-open`).
- **Core-emitted semantic wake events:** e.g. `page:search-engine-discovered` wakes `websearch` exactly when a page advertises an OpenSearch descriptor — detection stays in core, feature logic stays in the lazy feature.

**Loading mode (memory vs crash-isolation trade):** built-in *consolidated* features (`cmd`, `groups`, `peeks`, `slides`) load as **iframes inside one shared host window** (~80–120 MB total vs ~200–400 MB for separate windows), still origin-isolated. *External* features (including the built-in `example`, deliberately, and all user-installed features) get their **own separate BrowserWindow/process** — full crash isolation. **`cmd` loads first and synchronously and cannot be disabled** ("required infrastructure, not optional functionality"); everything else loads in parallel.

### 6.8 Survey of the Features We Use

35 directories under `features/`; 34 have an active `manifest.json`, `todo` is shipped-but-disabled. (There are also **theme** features — `theme-basic`, `theme-peek`, `theme-shichijuni` — which use a *different* manifest shape, `type: "theme"`. "Shichijūnikō / 七十二候" keys colors to Japan's 72 traditional micro-seasons — a whimsical demo of the theme system's range.)

| Feature | What it does | Keybinding | Shipped? |
|---|---|---|---|
| **cmd** | The command palette all features register into; loads first, can't be disabled | Opt+Space (global) / Cmd+K | ✅ |
| **groups** | Tag-based grouping of pages (saved tab groups; Panorama heritage) | — | ✅ |
| **spaces** | Workspace mode w/ auto-tagging, screen-border overlay, session mgmt | — | ✅ |
| **windows** | Full-screen window switcher, transparent overlay (only feature with `izui:true`) | Cmd+Shift+W | ✅ |
| **peeks** | Chromeless modal web-page windows via hotkey | Opt+0–9 | ✅ |
| **slides** | Edge-anchored slide-in panels via hotkey | Opt+arrows | ✅ |
| **editor** | Markdown editor: outline, live preview, vim mode (broadest capability grant) | Cmd+E | ✅ |
| **entities** | Auto-extract/index people/places/orgs/events from visited pages | — | ✅ |
| **tags** | Tag visualization + management | — | ✅ |
| **tag-actions** | Custom actions triggered by tags (ships todo/done + readme/read rules) | — | ✅ |
| **search** / **lists** | Search items by text/tags; search across items+tags+history | — | ✅ |
| **pagestream** | Vertical, chat-like navigational history browser | — | ✅ |
| **composer** | Quick item composer with tag management | — | ✅ |
| **dropzone** | Drop anything to inspect its metadata/content | — | ✅ |
| **files** | File/format commands (CSV, save) — MIME accepts/produces chain targets | — | ✅ |
| **websearch** | Web search from the palette w/ engine discovery (`kagi`,`google`,`ddg`,`bing`,`wiki`) | — | ✅ |
| **feeds** | RSS/Atom reader (demo of the series+feeds APIs) | — | ✅ |
| **sheets** | Widget sheets: freeform card layouts hosting webviews | — | ✅ |
| **timers** | Countdown/alarm/stopwatch/interval timers | — | ✅ |
| **scripts** | Userscripts/content-scripts system (Tampermonkey-ish) | — | ✅ |
| **lex** (Lexicon Studio) | Your AT Protocol identity + data; `oauth:true` | — | ✅ |
| **wonderwall** | OAuth account manager for connected services | — | ✅ |
| **mcp-server** | Expose Peek data to Claude Code via MCP; `hidden:true` | — | ✅ |
| **sync** | Sync commands (`Sync now` → pubsub); `hidden:true`, no tiles | — | ✅ |
| **features-manager** | Browse/install/manage/publish features (sources incl. `atproto`, `url`) | — | ✅ |
| **todo** | Quick `todo`/`done` commands | — | ⛔ disabled (`.disabled`) |
| **example** | Reference template for new features | — | ✅ (dev) |
| **hello-world**, **pubsub-repro**, **debug**, **widget-demo**, **pagewidgets-sample** | Tutorial/diagnostic/dev tiles, shipped like any other feature | — | ✅ (dev/meta) |

Note: **AT Protocol feature publishing/browsing is real, not aspirational** — `features-manager` has `sources: [builtin, local, atproto, url, dev]` and real `bsky.network`/`plc.directory` network grants.

### 6.9 OS-Integration UX — Global Hotkeys that Peek but Don't Steal Focus

**The core UX bet:** a global hotkey summons the cmd palette or a peek **without** the OS switching your active app or macOS Space. You're in Safari, you hit the hotkey, a small window appears on top, you act, it vanishes, you're back in Safari with zero context-switch cost. Default hotkey: **Option+Space** (macOS/Windows); **Cmd/Ctrl+Space** on Linux (GNOME reserves Alt+Space). This is IZUI's "transient" mode — the defining interaction of the whole app.

**How "don't steal focus" actually works (three cooperating mechanisms):**
1. Modal windows are created as macOS **`type: 'panel'`** — panel `show()`/`focus()` skip `activateIgnoringOtherApps`, so showing a panel doesn't force-activate Peek.
2. **`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`** on modal/alwaysOnTop windows — visible regardless of which Space/app you're on.
3. **Headless-safe show discipline** in the hybrid page-host: `show()` + `contentWC.focus()` for a real user show; `showInactive()` + `opacity:0` only for headless/test runs. Getting this wrong produces the "dead focus" bug class (NSBeep on keypress, no first responder) — root-caused across five regression passes in mid-2026.

**A real upstream wall (good "we hit the edge" beat):** the macOS Spaces bug — user on Space 2 hits the hotkey and macOS yanks them to Space 1. Root cause: `setVisibleOnAllWorkspaces(true)` sets `CanJoinAllSpaces` (window is *visible* everywhere) but **not** `MoveToActiveSpace` (window *moves to* the active Space) — and **Electron doesn't expose the latter flag at all** (electron/electron#8734, open since 2016). A genuine, cited, unresolved API gap.

**Wayland: global hotkeys are impossible by design.** `globalShortcut.register()` silently returns false; Wayland forbids apps grabbing keys system-wide. Peek ships three layered answers: (1) try global anyway (works on macOS/Windows/X11); (2) register every global shortcut *also* as a local one (fires when a Peek window already has focus); (3) **CLI-verb dispatch** — a Unix-socket daemon + a tiny non-Electron Node helper the user binds to a key in their *own* DE settings; verbs `cmd-open`, `peek-open <n>`, `slide-open <edge>`. The OS owns the keygrab, sidestepping Wayland entirely. The "correct" XDG `GlobalShortcuts` portal was investigated and *rejected* (GNOME backend not shipping on target LTSes; app_id instability for non-Flatpak Electron).

**Window placement — why peeks always land right:** four modes only (`centered` for peeks/cmd, `edge` for slides, `proportional` for user-dragged content, `parent-centered` for popups). **Intent is the source of truth; bounds are always a derived projection** via a pure `project()` function, called synchronously on every display add/remove. Display selection *never* consults cursor position (racy) — it uses the OS primary display. That's *why* "peek opens on your main screen" feels reliable on multi-monitor.

> **DEMO BEAT:** Summon the cmd bar with Opt+Space over another app, act, dismiss — your active app and Space never change.

### 6.10 Peeks / Slides, and "Cmd → Anything"

**Peeks** and **slides** are both transient, modal, quick-access `BrowserWindow`s hosting a *real web page* (`pageHost:true`) bound to a keyboard shortcut. The only difference is placement/shape:

| | Peeks | Slides |
|---|---|---|
| Placement | `centered` | `edge` (anchored to a screen edge) |
| Trigger | `Option+<0–9>` | `Option+Up/Down/Left/Right` |
| Window opts | `modal, type:'panel', pageHost, keepLive, persistState` | same, `screenEdge` instead of `center` |

Both are **lazy tiles** (no resident renderer at boot), woken by `cli:peek-open` / `cli:slide-open`. Both use `wakeShortcutsFromSettings:true` — real hotkeys come from user settings, with self-healing backfill for migrated profiles (a real shipped bug-and-fix).

**"Cmd → anything": one keystroke, N surface shapes.** The cmd palette isn't just a launcher — a command's `execute()` result decides what opens next:
- **no output** → panel just closes (silent success — a documented UX gap).
- **single `item`/`new-item`** → opens the **editor**.
- **array output** → **OUTPUT_SELECTION** (arrow-navigable list + preview pane, inside the panel).
- **chainable output** (declares a MIME type another command `accepts`) → **CHAIN_MODE**.
- Commands can also be **window**-action (open a full tile window) or **publish**-action (fire a declarative pubsub event, e.g. `Sync now`).

So the same `Opt+Space` entry point can terminate in: a note saved silently, a full window, an in-panel array browser, a markdown editor, or a multi-step data pipeline. That fan-out is the "cmd → anything" idea.

**Page widgets (a fourth surface flavor):** extensions register small chrome-anchored widget panels that dock to a hosted page and can execute content scripts inside that page's webview (correlated by `requestId`). They share the navbar's show/hide lifecycle — page chrome, not independent windows.

> **DEMO BEAT:** Opt+3 peeks a page centered; Opt+Left slides one in from the edge; ESC dismisses either.

### 6.11 The Windows Switcher

**IZUI = "Invocable Zoom User Interface"** — the state machine governing how any Peek window behaves based on *how it was invoked* (was the app focused when triggered?): `active` (already in Peek), `transient` (from another app — ESC closes immediately, focus returns, hidden windows NOT restored), `overlay` (full-screen — hides other Peek windows, ESC closes and *restores* them), `idle`. Coordinator: `IzuiStateCoordinator` singleton (54 unit tests). Transient state **propagates** down a session's whole window tree.

**The switcher itself (`features/windows/`)** — the windows-overlay tile is `role:'overlay'`, transparent, alwaysOnTop.
- **Invocation:** the `windows` command (Cmd/Ctrl+Shift+W), *or* **ESC as a global fallback** when no Peek window has OS focus — a focus-gated `globalShortcut('Escape')` that publishes `cmd:execute:windows`. It's a *global* OS-level Escape grab that's live only when nothing Peek-owned is focused, so it never eats ESC from an actually-focused peek/slide.
- **What it shows:** every open window as a card — favicon, title, thumbnail (real screenshot if captured, else a hostname-initial placeholder), a "Hidden" badge. Core/settings/itself are filtered out.
- **Navigation:** vim-style `hjkl` or arrows move a grid cursor; `Enter` activates; `/` or `Cmd+F` focuses search (filter by title/URL); sort toolbar; two view modes (`fit` = Exposé-style auto-resize is default; `columns`). Pre-selects the card for whichever window was focused before the overlay opened.
- **Closing:** the backend restores hidden windows and focuses the target (overlay semantics, not transient). Opening any new window while the switcher is up auto-dismisses it.

> **DEMO BEAT:** With nothing Peek-focused, press ESC → the switcher zooms out over everything; hjkl to a card, Enter to jump.

### 6.12 The Cmd Bar UX

Invocation: **Option+Space** (Cmd/Ctrl+Space on Linux). Renders as a small translucent pill (60px tall), a keepLive window (created once, hidden/shown, state reset on each show). Files: `panel.js` (DOM adapter), `state-machine.js` (pure 10-state FSM, no DOM/IPC — unit-testable in isolation), `commands.js` (local command cache, populated via pubsub), `completers.js` (param suggestions).

**The 10 FSM states:** `IDLE → TYPING → RESULTS_OPEN → PARAM_MODE → EXECUTING → {OUTPUT_SELECTION, CHAIN_MODE, CHAIN_POPUP} → CLOSING`, plus `ERROR`.
- **IDLE** — empty input, placeholder "Feed meeeee."
- **TYPING** — two-tone ghost text (bold for what you typed, dim for the top match's tail). *Dropdown does not auto-open on typing* (you press ArrowDown) — a flagged discoverability gap.
- **RESULTS_OPEN** — up to ~50 matches, scope badges (`⊞` window-scoped, `⧉` page-scoped), chain produces/accepts MIME badges.
- **PARAM_MODE** — entered by `Tab` or a trailing space; dropdown switches to parameter suggestions (tag/item/enum). `Tab` fills text only; `Enter` executes.
- **EXECUTING** — spinner after 150 ms if slow; blocks input.
- **OUTPUT_SELECTION** — array output, arrow-navigable + live preview pane.
- **CHAIN_MODE** — see §6.15. **ERROR** — red, auto-dismiss after 5s.

**Keyboard model:** ArrowDown/Up navigate (results/params/chain/output depending on state); `Tab` autocompletes / enters param mode / cycles chain command; `Enter` executes/selects/accepts; **Escape is layered** — paramMode → outputSelect → chain → results → clear text → close.

**Known, audited UX gaps (treat as current/open):** no affordance in IDLE that commands exist at all; keyboard-selected vs mouse-hover rows are nearly indistinguishable (opacity-only, bad in dark mode); no weight distinction between committed command name and param text; scope chips under-designed; **no success feedback** — a command that saves silently just closes the panel (a `result.message` exists but is discarded); chaining is real but nearly undiscoverable. These are audited gaps, not bugs to hide — good "the honest state of the UX" material.

### 6.13 Commands We Use a Lot (+ survey)

Live count: **73 commands across 35 feature dirs** with a `commands[]` array, *plus* a set baked into the cmd module itself. High-frequency ones first.

**Built into the cmd module** (`renderer/cmd/commands/*.js`, not feature-registered): `note`/`notes` (Peek's core capture verb — high frequency), `url`/`urls`, `edit`, `email`, `bookmark`/`bookmarklets`, `history`, `template`, `containertab`, `sendtowindow`/`switchtowindow`, `googledocs`, `debug`, `extract-title`, `item-query`.

| Command(s) | What it does | Key | Shipped? |
|---|---|---|---|
| `note` / `notes` | Save/list notes — the core capture verb | — | ✅ |
| `windows` | The window switcher | Cmd+Shift+W | ✅ |
| `center/maximize/unmaximize window`, `fullscreen` | Window management | — | ✅ |
| `groups`, `open/close/switch/restore group`, `pin`/`unpin` | Saved tab-group sessions | — | ✅ |
| `open/close/switch space`, `open spaces` | Heavier workspace snapshots | — | ✅ |
| `tag`, `tags`, `untag`, `tagset`, `open tags` | Tagging — a first-class primitive | — | ✅ |
| `lists`, `search` | Search items/tags/history | — | ✅ |
| `pagestream` | Browsing-history stream | — | ✅ |
| `editor` | Opens the markdown editor | Cmd+E | ✅ |
| `web search`, `kagi`/`google`/`ddg`/`bing`/`wiki` | Param-mode web search (`google <query>`) | — | ✅ |
| `timer countdown/alarm/stopwatch/interval` | Typed-param timers (`30m`, `6pm`) | — | ✅ |
| `open file`, `csv`, `save`, `markdown`, `save as note` | File I/O + chain targets | — | ✅ |
| `features`, `browse/publish/update feature` | In-app feature marketplace + self-update | — | ✅ |
| `mcp server setup` | Wires Claude Code to Peek as an MCP server | — | ✅ |
| `lex` / `lexicon studio` | AT Protocol identity/lexicon browsing | — | ✅ |
| `sheets`, `feeds`, `entities`/`extract entities`, `accounts`, `sync`/`Sync now` | Misc content + integrations | — | ✅ |

### 6.14 The Editor

A **markdown editor** (NOT rich-text, NOT block-based) built on **CodeMirror 6**, laid out as a three-panel workspace. Location: `features/editor/`. **Shortcut is `Cmd/Ctrl+E`** per the manifest. *(README says `Option+E` and references an old `extensions/editor/` path — both stale; trust the code.)*

**Layout:** outline sidebar (left, TOC from headers, click to jump) · CodeMirror editor (center, syntax highlighting, folding, search) · preview sidebar (right, live-rendered markdown). Plus **vim mode** (toggleable, persisted per-session) and **focus mode** (hides both sidebars, ESC exits). Panels are resizable.

**What it edits:** notes/items from the datastore — opened via `editor:open` pubsub, or as the terminal surface for a cmd command returning `item`/`new-item`. It's a **lazy tile** woken by `editor:open`/`editor:add` — historically fragile (a command firing `editor:open` before the tile loaded used to silently drop the event; fixed via lazy-event interceptors).

**Vim fidelity:** *implemented and tested* (33 Playwright tests): folditall-style folding (headers, nested lists, fenced code), vim fold commands (`za`/`zc`/`zo`/`zM`/`zR`/`<Space>`), a vim-mode status line. *Explicitly missing (high priority):* text objects (`iw`/`aw`/`i"`), character search (`f`/`t`/`;`), word search (`*`/`#`), replace mode (`R`), bracket/paragraph/viewport motion — though many may already ship free via the underlying `@replit/codemirror-vim` dep and just need verification. Ex commands and case/join operators are also missing.

**Annotations, highlights & clickable links (shipped since the docs — code-verified):** three capabilities that shipped after both editor docs were last written, all wired into the live editor:
- **Highlights + Notes pane** — *shipped, demoable, Playwright-tested.* Select text → `Cmd/Ctrl+Shift+L` marks a persistent colored highlight (6-color palette, positions re-map across edits); a collapsible right-edge **"Notes" pane** lists each highlight (`Line N — excerpt`) with an inline note textarea, click-to-jump, two-click delete. Covered by a `Notes and Highlights` test block in `editor-layout.spec.ts`. *Caveat worth a footnote: highlights persist to renderer `localStorage` keyed by `itemId`, NOT the SQLite datastore — so they don't sync and are tied to that browser profile.*
- **Clickable links** — *shipped, demoable, but rough.* `Cmd/Ctrl+click` opens `http(s)://` / bare `www.` URLs in the viewport (viewport-only regex scan, underline + cyan hover). **Zero test coverage** — real and working but the least-hardened of the three; demo it, don't lean on it.

### 6.15 Cmd Chaining

**STATUS: mechanically WORKING today, discoverability-poor. NOT broken** — correct that common misconception.

**The model:** commands declare `accepts: [mimeTypes]` / `produces: [mimeType]`. Three flavors — **producer** (`accepts:[]`, e.g. `lists`), **transformer** (both, e.g. `csv`), **consumer** (`produces:[]`, e.g. `save`). MIME matching supports wildcards (`*/*`, `text/*`, exact). Canonical flow: `list urls` → array of URLs → select a row → `csv` → CSV text → `save` → native save dialog.

**The fix that landed:** the OUTPUT_SELECTION-vs-CHAIN_MODE routing used to be guard-order-dependent (three tests in direct tension — fixing one broke another). Current code has array output **always** enter OUTPUT_SELECTION first; CHAIN_MODE is reached only via explicit row selection (or directly from EXECUTING for non-array single-value chainable output). **Tests confirm it:** `command-chaining.spec.ts` (9 tests) + `cmd-chain.spec.ts`, **no `.skip`**, both inside the canonical `yarn test:desktop:electron` gate.

**What's still open — discoverability (audited Gap I):** nothing signals "this output is chainable" beyond a tiny 10px/60%-opacity `→ mimeType` badge; the chain indicator shows a raw MIME string, not a human label; there's no way to *start* a chain except by running a producer and noticing you can pipe it; and `CHAIN_POPUP` (the interactive chain-editor sub-state) has a known hardcoded-300ms timing fragility (candidate for removal independent of the main flow).

> **DEMO BEAT:** `list urls` → arrow to a row → Enter → `csv` → `save` — it works live. Just don't claim the discoverability story is solved.

### 6.16 The Page Host — Architecture & UX

**As of 2026-07, the hybrid page-host is the ONLY page-host.** The legacy transparent-canvas `<webview>` architecture was **deleted outright — no flag, no fallback.** (`docs/page-host-state-machine.md` describes the *old canvas-era* FSM — historically accurate for that era, superseded for what ships.)

**Why it changed (hard perf numbers, real 46-page prod session, same session before/after):**

| Metric (idle, settled) | Canvas | Hybrid | Δ |
|---|---|---|---|
| Renderer processes | 107 | 63 | −41% |
| Renderer RSS | ~15.4 GB | ~10.5 GB | −32% |
| Electron CPU @ idle | ~118% | ~1–3% | essentially eliminated |
| WindowServer CPU @ idle | ~47% | ~12–16% | −68% |
| GPU CPU @ idle | ~33% | ~0% | eliminated |

Old (canvas): a fullscreen *transparent* BrowserWindow hosting chrome as a sibling of a `<webview>` = **2 renderer processes per page + an always-alpha-composited transparent window**, ×N pages, strictly linear cost. New (hybrid): one **opaque, positioned `WebContentsView`** attached directly to its window (no wrapper renderer — content keeps its own session+preload so the extension compat layer re-attaches cleanly) **+ a single shared chrome overlay for the whole app**, repositioned over whichever content window is active. **The idle-CPU collapse is the standout demo number:** transparent canvases ran a continuous compositor paint loop even sitting idle; opaque static content has nothing to repaint. All three CPU metrics collapsed in lockstep — cross-validating evidence it's a real architectural win, not sampling noise.

**Invariants that replaced the old model** (each tied to a real shipped regression — the migration broke almost every focus/ESC/menu assumption; the invariants now live as a hard-won regression log in `apps/desktop/CLAUDE.md`):
- **`getFocusedWindow()`/`fromId()` return `null` for a hybrid host** (a `BaseWindow`, not `BrowserWindow`). "What's the current window?" must fall back to `getActiveHybridWindowId()`. This one invariant broke cmd+W, the global ESC fallback, and window-close resolution.
- **Show discipline:** `show()` + `contentWC.focus()` for a real show (makes the content view the macOS first responder); `showInactive()`+`opacity:0` for headless. Missing `contentWC.focus()` on a *re-raise* caused a class of "ESC is dead until I click the page" bugs.
- Local shortcuts route through the content WC's `before-input-event`; the chrome overlay must hide on `did-resign-active`.
- Five sequential regression passes closed keepLive-slides-destroyed-instead-of-hidden, ESC-not-closing-peeks, wrong-page-focus-on-restore, ESC-opening-switcher-instead-of-closing-overlay, etc. Notably, real macOS first-responder behavior is **unobservable in headless test runs** — several bugs were only found via live `fs-diag` instrumentation in a real `yarn start` session.

**UX:** a "content window" is a real OS window whose body *is* the site (WebContentsView, isolated session, own preload — so extension compat, content scripts, page widgets all attach per-page). The nav chrome (address bar, widgets, navbar) is NOT per-page DOM anymore — it's a single shared floating overlay Peek repositions over the active content window, revealed via a top-edge hover/gesture band and hidden otherwise, so **pages read as full-bleed content most of the time.**

### 6.17 Entities

*(Full cross-system treatment in §4; desktop-specific recap here.)*

**SHIPPED:** feature "Entity Recognition" v3.0.0, `builtin:true`, a **lazy background tile** (`features/entities/background.js`) woken by the rules engine (`scripts:execute:entities-extract` on `page:content-ready` / `item:created`-URL) or imperative topics. Debounced (2s), cooldowned (1h re-extract). Three extractors run **in parallel** — structured-data (JSON-LD/OG/microdata, conf 0.85–0.9), microformats (h-card/h-event, 0.9–0.95), regex (emails/phones/addresses/tracking/prices, 0.6–0.9).

**Storage:** entities *are* items (`type='entity'`, `content`=canonical name, metadata carries `entityType`/`aliases`/`attributes`/`confidence`/`extractor`/`feedback`). Each sighting is an `item_events` row (`itemId`→entity, `content`=source URL, `value`=confidence) — so "which pages mention X" and "which entities on page Y" are already derivable. Dedup by normalized name + aliases; thumbs-up/down suppresses. UX: an entities browser window (900×700 workspace tile) + per-page entity display; publishes `entities:extracted`.

**NOT shipped (design/research only):** the entity **correlation graph** (co-occurrence, PMI/NPMI, clustering, d3 view) and authoritative **Wikidata validation**. See §4 for the shipped-vs-planned split — don't present the graph as live.

### 6.18 Sync

**Architecture:** hub-and-spoke, **server is source of truth**, last-write-wins on `updatedAt`. Local-first, NOT peer-to-peer, NOT CRDT. Mobile (Tauri/Rust + Swift share ext) and Desktop (Electron) each hold local SQLite; all push/pull via the server REST API.

**Transport (shipped, live in prod):** Hono on Node + better-sqlite3 on Railway (project `amusing-courtesy`, service `peek-node`). Multi-user (one DB per user) or single-user self-host; Bearer tokens, keys SHA-256-hashed. Version headers (`X-Peek-Datastore-Version`/`-Protocol-Version`) gate sync with HTTP 409 on mismatch — lenient about *missing* headers (rollout compat), strict about *mismatched*.

**Endpoints:** `GET /items`, `GET /items/since/:timestamp` (always includes tombstones), `POST /items`, `PATCH /items/:id/tags`, `DELETE /items/:id` (hard). Server-side profiles are UUIDs = on-disk folder names.

**Conflict handling:** pull matches local by `syncId` == server `id` (insert if new, update if server newer, skip if local newer, soft-delete if `deleted_at` set). Push: items where `syncedAt=0 OR updatedAt>syncedAt`. **Delete propagation via tombstones** (soft-delete sets `deletedAt`, never hard-deleted by sync, pushed like any item). **What syncs:** items (sync columns), tags, item_tags, item_events. **Local-only (not synced):** frecencyScore, title, domain, favicon, visitCount, slug, color, tag hierarchy.

**A talk-worthy wrinkle — the same protocol is re-implemented in FOUR places:** `packages/sync/sync.js` (the unified cross-platform JS `SyncEngine`, used by mobile-web/extension, with better-sqlite3/indexeddb/memory adapters), `apps/desktop/main/sync.ts` (Electron), plus Rust in Tauri-desktop and mobile. That 4-way re-implementation is a recurring risk worth naming.

**Known limitations (shipped):** **push failures are logged but NOT retried** (high severity — `lastSyncTime` advances so failed items are skipped next sync). Mobile carries schema drift (snake_case, ISO timestamps, INTEGER tag ids) vs the canonical camelCase/INTEGER-ms/TEXT-uuid — deferred because migrating means synchronized ~4,000-line Rust + ~2,000-line Swift changes; **sync still works because the wire format (JSON) is independent of local schema** (a nice architectural point). A `syncSource`-overload refactor is partially done (done for desktop + unified JS + better-sqlite3 adapter; still pending in Tauri-desktop + iOS Rust).

**Testing:** a clean-room three-way E2E (server + desktop + iOS-simulator) covering tombstone propagation. Gotcha: all Node sync tests must run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`) for the better-sqlite3 ABI.

### 6.19 MCP

**SHIPPED.** Peek exposes a **Model Context Protocol server** so Claude Code (and any MCP client) can read/write the *same* SQLite datastore the desktop app uses. Feature dir `features/mcp-server/`.

**Architecture:** `Claude Code ⇄ stdio (JSON-RPC 2.0) ⇄ peek-mcp launcher ⇄ server.js ⇄ db.js ⇄ SQLite`. The `peek-mcp` launcher is an **Electron-as-Node wrapper** so external clients don't need system Node. `db.js` mirrors the datastore policy in `main/datastore.ts` (frecency/slug/hashtag/cascade) — if it diverges, the MCP server misbehaves.

**13 tools:** 6 read-only always-on (`list_items`, `search_items`, `get_item`, `list_tags`, `list_tasks`, `get_task_context`); 7 mutating, enabled only with `--writes` (`create_item`, `update_item`, `delete_item` [soft], `tag_item`, `untag_item`, `record_event`, `complete_task`). Resources: `peek://tasks`, `peek://tasks/{tag}`, `peek://tags`.

**Notable mechanics:** `search_items` is tokenized, ranked, multi-field (per-term field weights title 10 > tag 6 > domain 4 > content 2 + multi-field bonus, frecency/updatedAt tiebreak, returns score + snippet). **Git-short-hash item-id prefix resolution** — any `itemId` accepts a unique leading prefix; ambiguous prefixes hard-error with candidates (mutations never act on a guess). **Content windowing** — `get_item` returns only the first 4,000 chars by default so a page-capture can't blow the caller's context. Results JSON-serialized compact.

**Scoping (the key safety mechanism):** `PEEK_MCP_SCOPE_TAG=<scope>` confines a session to items tagged `<scope>` or `<scope>:*`. Reads filter to in-scope; writes **force-add** `<scope>`; foreign-namespace tags are rejected so an agent can't poison a sibling project; untagged items are invisible; out-of-scope prefix matches read as not-found (no existence leak). Installed per-project via `peek-mcp-init <scope> [--writes]`, which scaffolds `.mcp.json`, `.claude/settings.local.json`, and `.claude/skills/peek.md`.

**Lifecycle wrinkles:** env (scope/readonly/db-path) is **frozen at spawn** — settings changes require a full Claude Code restart. The server does **drift self-exit**: before each message it compares its spawn env against on-disk config and `exit(0)` if none matches, so the client respawns with fresh env (but a Peek *rebuild* doesn't self-heal). Dev/prod isolation: the Settings toggle writes real `~/.claude.json` only when Peek is packaged *and* on the `default` profile; dev builds write to a sandbox.

**Value framing:** Peek becomes an **agent-writable personal knowledge + task backend** — Claude reads your saved pages/notes, searches them, and manages a scoped task queue, over *the same SQLite the human UI reads live*. The peek repo dogfoods this: its own `peek:*`-tagged tasks are driven through these tools.

> **DEMO BEAT:** Run `mcp server setup`, then show Claude Code reading and tagging items in the same store the Peek UI is displaying — human and agent on one live datastore.
