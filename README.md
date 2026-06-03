# Peek

Peek is a web user agent application designed for using the web where, when and how you want.

Today's browsers are one-size-fits-all applications, cramming the vast universe of user needs across an unimaginably large web into in an unmodifiable tabbed-window design.

We often use the web with a specific goal in mind - that goal should drive the design of the interface of the web user agent. We should be the driver, creator, maker, shaper of that design and interface.

Peek is designed to allow you to experiment and create flows for task alignment in interfaces that are personal. It aims to make it easy to create new user interface shapes for the web which fit your need in the moment.

Peek is a workbench for the web.
Peek is a window manager for the web.
Peek is what you want it to be.

<img width="969" alt="peek desktop screenshot" src="peek-desktop-screenshot.jpg">

## WARNING!

___PEEK IS NOT A BROWSER___

Peek is not a browser, and will never be a browser in the way you are probably familiar with. There are no tabs, and no windows in the tabbed-browser-like sense of them. Peek likely does not have many other of many details we are used to in web browsers, but do not notice until they are missing. Peek may be most useful to you if you view it as an entirely different type of application than a traditional web browser.

___PEEK IS A CONCEPT PREVIEW___

Peek is not safe for daily use yet! It is a proof of concept. Do not use it for anything critical. Peek does not have the same security approach as traditional web browsers, and its security model and security user interface have not yet been determined. Peek has not had a security audit.

## Core

Built-in capabilities that form the foundation of Peek.

- **IZUI Navigation** — Inverted Zooming User Interface. ESC-key-based navigation model that provides consistent "zoom out" behavior across all interfaces. Enter from anywhere, ESC to go back — predictable at every level.
- **Window Management** — Heterogeneous windowing: chromeless modals, overlays, slides, workspaces and content windows, each with role-specific behavior.
- **Feature Tiles** — Every feature is a **tile**: an HTML file running in its own capability-gated BrowserWindow, talking to the main process over a strict `tile:*` IPC surface. There's no "tile type" or "role" — tiles are resident or lazy, shown or hidden, and that's it. Each declares its own commands, shortcuts, settings, and the capabilities it needs. See [docs/architecture.md](docs/architecture.md).
- **PubSub Messaging** — Cross-window event system for communication between features and windows.
- **Data Persistence** — SQLite datastore with schema management, history tracking, and cross-device sync support.
- **peek:// Protocol** — Custom protocol for internal navigation and cross-origin access.
- **Settings** — Per-feature configuration with live reload. `Cmd/Ctrl+,` or tray icon.

## Features

Peek uses the language of "features" (and, at the implementation level, "tiles") over "extensions". "Extend" implies a larger core that you cannot change. Peek inverts that to small core, with as much changeable as possible. Peek features are modular — they are not *extending* core functionality, they *are* the functionality, each one a **tile** running on a small-as-possible core.

- **Commands** — Global-hotkey-activated graphical command bar (GCLI) for opening pages and features, executing commands, chaining commands. `Opt/Alt+space` (global) and Cmd/Ctrl+k (local)
- **Groups** — Categorize, recall and interact with groups of pages. Groups are tags that've been "promoted" intentionally to a group. Groups are also an app-global "mode" (which isn't entirely implemented yet...) `Cmd/Ctrl+G`
- **Peeks** — Global-hotkey-activated modal chromeless web pages for quickly glancing at or interacting with pages. `Opt+0-9`
- **Slides** — Global-hotkey-activated modal chromeless web pages which slide in from any screen edge. `Opt+Arrow Keys`
- **Editor** — Markdown editor with outline sidebar, live preview, vim mode and an *excellent* folding approach. `Cmd/Ctrl+E`
- **Search** — Search across all items by text and tags.
- **Tags** — Tag, untag, and browse items by tag. Tag visualization and management.
- **Tag Actions** — Define custom actions triggered by tags, enabling automated workflows.
- **Web Search** — Search the web with engine discovery — Google, DuckDuckGo, Kagi, Bing, Wikipedia, and more.
- **Windows** — Full-screen window switcher overlay showing all open windows as cards. `Cmd/Ctrl+Shift+W`
- **Pagestream** — Chat-like vertical navigation interface for browsing history and opening and viewing pages. `Cmd/Ctrl+Shift+P`
- **Entities** — Automatic extraction of people, places, organizations, and events from visited pages.
- **Scripts** — Periodically execute scripts against web pages in the background to extract data, with change notifications.
- **Files** — Open local files, CSV conversion, markdown formatting, save operations.
- **Feeds** — RSS/Atom feed reader.
- **Lexicon Studio** — Lexicon Studio: AT Protocol identity and data browser/editor.
- **Widget Sheets** — Widget sheets with freeform card layouts hosting webviews.
- **Timers** — Countdown timers, alarms, stopwatches, and interval timers.
- **Sync** — Cross-device synchronization of items, tags, and groups.
- **HUD** — Always-on-top heads-up display showing current state and mode. `Ctrl+H`

Coming:
- "native" web apps — using Peek as a way to "install" web pages on the local device as separate applications
- "Peeklets" HUD — select parts of pages to add to a collection rendered as an overlay

## Keyboard Shortcuts

### Global (work from any application)

| Shortcut | Action |
|----------|--------|
| `Opt+Space` | Open command bar |
| `Opt+0-9` | Open Peeks (configurable, not all registered by default — configure in settings) |
| `Opt+Arrow Keys` | Open Slides (configurable, not all registered by default — configure in settings) |

### Application

| Shortcut | Action |
|----------|--------|
| `ESC` | IZUI navigation — zoom out, go back, close dialogs. At root, opens Windows switcher. Also closes windows depending on role and session state. |
| `Cmd/Ctrl+K` | Open command bar (within app) |
| `Cmd/Ctrl+L` | Command bar URL mode |
| `Cmd/Ctrl+G` | Groups |
| `Cmd/Ctrl+E` | Editor |
| `Cmd/Ctrl+H` | HUD |
| `Cmd/Ctrl+Shift+P` | Pagestream |
| `Cmd/Ctrl+Shift+W` | Windows switcher |
| `Cmd/Ctrl+Shift+F` | Lists search |
| `Cmd/Ctrl+Shift+T` | Undo close window (works for all window types) |
| `Cmd/Ctrl+W` | Close window |
| `Cmd/Ctrl+,` | Settings |
| `Cmd/Ctrl+Q` | Quit |

### Web Page Navigation

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+L` | Focus URL bar |
| `Cmd/Ctrl+R` | Reload page |
| `Cmd+[` / `Cmd+Left` | Go back |
| `Cmd+]` / `Cmd+Right` | Go forward |

## Design

Some thoughts driving the design of Peek

Core
- Feels like home: trust, comfort, control
- Continuous instances of magical mind-reading
- Sleep at night because no idea or anything you saw is ever lost
- Create, save, classify at the speed of thought

What makes a home / kitchen / workshop
- Everything is right where you need it, b/c you control what is where
- When you know what is where, you can make things with less frustration
- You generally know what’s happening - who’s around/coming/going, etc, not too much surprise

What makes magical mind-readingness
- Frecency everywhere all of the time
- User actions are training data for sorting
- The thing you were thinking of is already at the top of the list

What makes awareness
- Actions tracked at the core
- Metrics generated, rollups displayed, synthesis emergent
- Task context with you at the center (vs asking a companion robot - disempowering!)

Synthesis
- Frecency + adaptive matching gives experience/feeling of magical mind-readingness
- Ability to customize/create/generate interfaces gives the comfort of home

The rules
- Files > arcane/opaque boxes/formats
- Metadata can be weird non-file, as long as consistent
- External systems require consent to touch my stuff

Key capabilities from action/application history chain + addressibility
- Record/replay
- State feedback loops
- Observability

Interface spectrum
- Consistent predicable interfaces are easy, off-the-shelf
- Weird/generative possible via power trio: backgrounding, wm apis, web surface

Difference from browsers
- Web user agents should be bounded by the user, not browser vendor business models
- Windows and tabs should have died a long time ago, a mixed metaphor constraining the ability of the web to grow/thrive/change and meet user needs
- Security user interface must be a clear articulation of risks and trade-offs, and users should own the decisions

### Task alignment

Many user tasks on the web are either transient, chained or persistent, data oriented, or some mix of those. Neither the document-oriented nor application-centric web meets those needs. Traditional browser makers can't meet those needs well, for many reasons.

Characteristics of how we use the web, that are not addressed in contemporary web browsers:

- transient
- chained
- persistent
- data-centric
- archival / evidential

### Escape IZUI

TODO: articulate the escape-to-leave aspect, eg you can peek from *other* applications and ESC to go back to exactly where you were without breaking the task flow.

Escape is an inverted zooming user interface (IZUI) design for a flexible window manager that makes possible a web user agent application than can have multiple entry points and a heterogeneous windowing ecosystem.

IZUI vs ZUI

* ZUIs navigate by starting from a known root and user navigates by zooming ever further in, and then back out
* Escape can enter a window stack at any point, and via a variety of methods, often from outside the application
* Instead of navigating by zooming in, all interfaces can zoom out to go back, using the Escape key
* This design allows unbounded and diverse entry points, but with predictable behavior
* Regardless of the entry point, the user always has a consistent path to familiar ground

Escape navigation model
* navigation base can start at any level in stack
* forward navigations are added on top of stack
* backwards navigations walk the stack in reverse up the tree to the root

## Architecture / Implementation

About this space:

- Web pages can themselves be navigators of the web
- Embrace the app-ness of the web platform, as a way to efficiently access the document-ness
- Decouple html+js+css from http+dns+ssl - not entirely, but that trust+security model is not a required starting point
- Javascript is ok here

Peek is designed to be modular and configurable around the idea that parts of it
can run in different environments.

For example:
- Planning on a mobile app which syncs and runs your peeks/slides/scripts
- I'd like to have a decentralized compute option for running your scripts outside of your clients and syncing the data
- Want cloud storage for all config and data, esp infinite history, so can do fun things with it

### Feature architecture

Peek inverts the traditional browser model. Instead of a large monolithic core with an extension API bolted on, Peek has a minimal core with features that *are* the functionality. A feature is a **tile** — an HTML file in its own BrowserWindow, loaded through a capability-gated preload, talking to the main process over a strict `tile:*` IPC surface. Tiles are not extending something — they are the thing. For a full walkthrough of the tile model, the three runtime state machines, and a comparison to the [webtil.es / DASL Tiles](https://dasl.ing/tiles.html) spec, see [docs/architecture.md](docs/architecture.md).

### State machines

Three explicit FSMs replace the ad-hoc timing code (sleeps, polling, retry hacks) that used to govern Peek's runtime. Each has its own design doc; the headlines:

- **Tile lifecycle FSM** — owns *when a tile is alive*. States: `unregistered → registered → loading → ready → visible` plus `unloading` and `crashed`. Replaces the year-long bug class of "tile loaded but its commands haven't appeared yet" / "spinner hangs forever because the dispatch target was never live". Lives in [`backend/electron/tile-lifecycle.ts`](backend/electron/tile-lifecycle.ts) + [`backend/electron/tile-fsm.ts`](backend/electron/tile-fsm.ts); design in [docs/tile-lifecycle-fsm.md](docs/tile-lifecycle-fsm.md).
- **PubSub state machine** — owns *what messages can flow between tiles in each state*. Every `tile:*` IPC frame runs through a 6-step validation pipeline (channel → sender frame → schema → token + grant → tile state → sender role) before any handler fires. Replaces "a publish was dropped somewhere in the fabric" as a debuggable bug class — if a message doesn't flow, the pipeline names which step rejected it. Lives in [`backend/electron/pubsub.ts`](backend/electron/pubsub.ts) + [`backend/electron/tile-ipc-gate.ts`](backend/electron/tile-ipc-gate.ts); design in [docs/pubsub-state-machine.md](docs/pubsub-state-machine.md).
- **Cmd panel state machine** — owns the interactive command bar's UI states (`IDLE`, `TYPING`, `RESULTS_OPEN`, `PARAM_MODE`, `EXECUTING`, `OUTPUT_SELECTION`, `CHAIN_MODE`, `CHAIN_POPUP`, `ERROR`, `CLOSING`). Replaces the previous "every panel.js bug fix added another boolean flag" model — each prior regression cycle (param-mode escape, Tab-fills-vs-Enter-executes, output-selection cancel) collapses to one transition entry plus a test. Pure module in [`app/cmd/state-machine.js`](app/cmd/state-machine.js); design in [docs/cmd-state-machine.md](docs/cmd-state-machine.md).

### Peek tiles vs webtil.es / DASL Tiles

Peek's tiles share the word and the instinct of the [DASL Tiles spec](https://dasl.ing/tiles.html) but sit at a different point in the design space: DASL is a **portable distribution format** (how a tile is identified, signed, and loaded into any host); Peek's tile is an **in-process runtime contract** (how a feature lives inside the Peek desktop app). A teaser:

| Axis | DASL Tiles | Peek tiles |
|---|---|---|
| Lifecycle | Not specified | 7-state FSM + crash recovery |
| Capabilities | Deferred to future spec; network locked off entirely | Required manifest declaration; per-domain / per-table allowlists; per-frame IPC gating |
| Inter-tile messaging | "Future version" — not in current spec | First-class pubsub with subscribe-before-publish guarantees |
| Identity | Content-addressed (CID) | String `id` unique within the install |
| Sandbox | Browser-native (sandbox flags, CSP, COOP/COEP) | Electron-native (`sandbox: true`, `contextIsolation: true`, per-tile preload) |
| Distribution | First-class (AT Protocol records, signed, fetchable from any PDS) | Local disk (built-in or installed); not yet portable |

The two models are largely complementary — see [docs/architecture.md#peek-tiles-vs-webtiles--dasl-tiles](docs/architecture.md#peek-tiles-vs-webtiles--dasl-tiles) for the full row-by-row comparison and the terminology Peek could adopt from the spec.

A modular feature system for achieving "personal web workbench" requires a few things:
- UI modularity requires OS-level window capabilities beyond what the web allows today (also a baby step towards a minimal OS user interface)
- Data harvest/transform/process/publish requires a method of moving data between features (web apps) *locally*, cf Web Actions/Intents/Applets, MCP, pubsub, MQTT etc
- Portable ways of accessing network, storage and compute

The current implementation has gone through a few iterations:
- first proof of concept was all Electron — privileged JS
- second experiment moved each feature to a separate web app running in own window scope, with access to smallest possible custom API, with one main web app loading and orchestrating the others, using pubsub for cross-app communication
- third approach bundled all features into one web app, with access to smallest possible custom API for platform-level capabilities
- fourth approach implemented a minimum viable core in a single web app which loaded "features" into an opaque origin
- fifth and current approach: each feature is a **tile** — its own BrowserWindow on its own `peek://{tileId}/` origin, with a capability-gated preload and a strict `tile:*` IPC surface. One renderer mechanic for every feature and for the core renderers themselves. See [docs/architecture.md](docs/architecture.md).

Features are loaded into the custom `peek` scheme, which provides access to a few special APIs noted in the next section, allows cross-origin network access (gated by the tile's declared `network` capability), and other things.

The API surface area is small and portable — features built on it could run in other environments with minimal adaptation.

### Feature API

Features are tiles running in the `peek://` scheme. Each tile gets its own per-window capability token at load time; every call on `window.app` routes through [`backend/electron/tile-preload.cts`](backend/electron/tile-preload.cts) over the strict `tile:*` IPC surface, and is gated on the capabilities the tile declared in its manifest. The question driving the API design: what's the minimum capability set a tile needs to build a feature?

The API is exposed as `window.app` in the tile's execution context:

- **Windows** — open, close, modify, and track windows with role-based behavior
- **Shortcuts** — register global and local keyboard shortcuts
- **PubSub** — publish and subscribe to messages across features and windows, with scoping (self, global, window)
- **Commands** — register commands for the command bar, with parameter modes and chaining
- **Datastore** — SQLite-backed persistent storage with schema management
- **Escape** — register ESC key handlers for IZUI navigation
- **IZUI** — query and interact with the navigation state machine
- **Files** — open/save dialogs, read/write by path
- **Settings** — per-feature preferences with schema validation
- **Themes** — access current theme, dark mode state
- **Sync** — cross-device synchronization
- **Profiles** — user identity and profile management
- **Net** — network requests (fetch with cross-origin access)
- **Session** — session state and restore

The API surface is intentionally small and portable — features built on it could run in other environments with minimal adaptation. See [docs/tile-api.md](docs/tile-api.md) for the current preload surface and [docs/architecture.md](docs/architecture.md) for the tile model, capability system, and state machines. [docs/api.md](docs/api.md) contains older API notes that are still largely accurate but may lag.

### Desktop App

Proof of concept is Electron. By far the best option today for cross-platform desktop apps which need a web rendering engine. There's really nothing else remotely suited (yet).

User interface:
- the built-in features are all modal chromeless web pages at this point
- settings UI uses custom sidebar navigation with dark mode support

TODO
- Need to look at whether could library-ize some of what Agregore implemented for non-HTTP protocol support.
- Min browser might be interesting as a forkable base to work from and contribute to, if they're open to it. At least, should look more at the architecture.

## Contribution

- In proto stage
- All dragons, no promises

## Mobile

There's a LOT already done here and I haven't even begun to describe it yet.

## Server/Cloud

Server component is a very passive sync+store service right now.

Runs on Railway, I use it daily with few problems (that I know of).

## History

In working on Firefox and related things at Mozilla from 2006 - 2019, there were a few specific initiatives which best aligned with my needs as a user on the web:

- The Awesomebar: infinite history + personalized local search index
- Ubiquity: Natural language commands + chaining
- Jetpack: The Mozilla Labs version - web-platfrom-centric extensibility
- Panorama: née TabCandy, web pages as groups instead of tabs in windows

A few others which were in the right direction but didn't achieve their optimal form:

- Greasemonkey
- Microsummaries
- Contacts extension

The first version of the Peek application has some bits of each of these, and the original Peek browser extension.

### Peek browser extension

Peek was a browser extension that let you quickly peek at your favorite web pages without breaking your flow - loading pages mapped to keyboard shortcuts into a modal window with no controls, closable via the `Escape` key.

However, as browser extension APIs became increasingly limited, it was not possible to create a decent user experience and I abandoned it. The original extension source is no longer in this repo; see git history if you want to dig.

The only way to create the ideal user experience for a web user agent that *Does What I Want* is to make it a browser-ish application, and that's what Peek is now.

---

## Automated Summary (somewhat outdated, but some correct stuff too)

### Developer Quick Start

```bash
# Requirements: Node.js 24+
nvm use 24

# Install and run
yarn install
yarn debug        # Development mode with devtools
yarn start        # Normal mode
```
Look at package.json for a long list of commands for each of the back-ends and testing.

See [DEVELOPMENT.md](DEVELOPMENT.md) for full development guide.

### Architecture

Peek supports multiple backends sharing the same storage/api approach:

```
peek/
├── app/                    # Core renderer (backend-agnostic): bgWindow, cmd, hud, page
├── features/               # Feature tiles (one directory per tile, each with manifest.json)
├── backend/
│   ├── electron/           # Desktop (primary) — tile-lifecycle, tile-ipc-gate, tile-preload.cts
│   ├── tauri/              # Desktop (Rust alternative)
│   ├── tauri-mobile/       # iOS/Android
│   └── server/             # Sync server (Node.js/Hono)
└── docs/                   # Documentation (architecture.md, tile-api.md, *-state-machine.md)
```

### Documentation

| Doc | Description |
|-----|-------------|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development setup, commands, architecture |
| [docs/architecture.md](docs/architecture.md) | **Start here.** Tile model, state machines, and comparison to webtil.es / DASL Tiles spec |
| [docs/tile-api.md](docs/tile-api.md) | Current tile preload surface (`window.app`) |
| [docs/api.md](docs/api.md) | Older API reference (some content still accurate) |
| [docs/features.md](docs/features.md) | Feature development |
| [docs/cmd.md](docs/cmd.md) | Command palette feature |
| [docs/themes.md](docs/themes.md) | Theme system |
| [docs/datastore.md](docs/datastore.md) | Data storage and schema |
| [docs/sync.md](docs/sync.md) | Cross-device sync |
| [docs/mobile.md](docs/mobile.md) | Mobile development (iOS/Android) |

### Tests

~2,000 tests across 69 files, using Node.js test runner, Playwright, and Cargo test.

| Suite | Runner | Tests | Command |
|-------|--------|------:|---------|
| **Electron Unit (TS)** | Node `--test` via Electron | 764 | `yarn test:unit` |
| **Unit (JS)** | Node `--test` | 459 | `yarn test:unit` |
| **Playwright Desktop** | Playwright | 211 | part of `yarn test:desktop:electron` |
| **Playwright Components** | Playwright | 56 | `npx playwright test tests/components/` |
| **Playwright Editor** | Playwright | 90 | `npx playwright test tests/editor/` |
| **Playwright Extension** | Playwright | 41 | `yarn test:extension:chrome` |
| **Extension Backend** | Node `--test` | 130 | `yarn test:extension` |
| **Server** | Node `--test` | 110 | `yarn server:test` |
| **Schema Fidelity** | Node `--test` | 40 | `yarn schema:test` |
| **Sync Integration** | Script-style | 59 | `yarn test:sync` and variants |
| **Mobile (JS)** | Script-style | 9 | `yarn test:mobile` |
| **Mobile (Rust)** | `cargo test` | 19 | In `backend/tauri-mobile/` |
| **Tauri Desktop (Rust)** | `cargo test` | 16 | `yarn test:desktop:tauri:rust` |
| **Lex** | Node `--test` | 38 | `node --test features/lex/tests/` |

**Electron Unit (TS)** — Backend logic: entities extraction, session management, IZUI state, cmd palette logic, cmd chaining, OAuth bridge, display watcher, noun registry, shortcuts, datastore, completers, tag affordances, page loading.

**Unit (JS)** — Frontend logic: cmd state machine, groups, name validation, tags search, editor outline/preview, page widgets, item queries, Chrome API polyfills (storage, alarms, events, navigation, IPC, offscreen).

**Playwright Desktop** — End-to-end: smoke tests (window lifecycle, navigation, IZUI escape protocol, cards, groups), history, cmd state machine, web search, HUD, local search, pagestream, page widgets, groups context, page navbar.

**Playwright Components** — Web component rendering and behavior tests for shared UI components.

**Playwright Editor** — Editor pane layout and code folding tests.

**Playwright Extension** — Browser extension options page and popup UI tests.

**Extension Backend** — Browser extension logic: datastore, tabs, history, bookmarks, sync, profiles, environment.

**Server** — Sync server: API endpoints, backup, migration.

**Schema Fidelity** — Validates schema consistency across desktop, mobile, server, and browser extension datastores.

**Sync Integration** — Cross-device sync: integration tests, E2E tests, three-way merge, version compatibility.

**Lex** — Lexicon feature: UI logic and background processing.

Background test commands: `yarn test:desktop:electron:bg` runs the full desktop (electron) gate headless in background (logs to `/tmp/test-electron.log`).

### Notes

Design thinking, research, and implementation notes in `notes/`:

| Note | Topic |
|------|-------|
| [extensibility](notes/extensibility.md) | Extension model design |
| [escape-navigation](notes/escape-navigation.md) | IZUI navigation model |
| [commands](notes/commands.md) | Command palette design |
| [cmd-backend-notes](notes/cmd-backend-notes.md) | Cmd chaining backend implementation |
| [core-api](notes/core-api.md) | API design notes |
| [shortcuts-api](notes/shortcuts-api.md) | Keyboard shortcuts |
| [groups-model](notes/groups-model.md) | Tab groups / Panorama |
| [page-model](notes/page-model.md) | Page abstraction |
| [ux-rules](notes/ux-rules.md) | UX guidelines |
| [backup](notes/backup.md) | Backup strategy |

### License

MIT
