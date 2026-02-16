# Peek TODO

## How we work

- We track pending items in this file
- In-progress work and current focus goes in WIP.md
- Completed items go in CHANGELOG.md, grouped by week
- This file is not for notes or description - link to documents in ./notes for that
- Checkbox states: `- [ ]` pending, `- [~]` in-progress (move to WIP.md), `- [x]` done (move to CHANGELOG.md)

## Design principles / capabilities / etc

core
- feels like home: trust, comfort, control
- continuous instances of magical mind-reading
- sleep at night because no idea or anything you saw is ever lost
- create, save, classify at the speed of thought

what makes a home / kitchen / workshop
- everything is right where you need it, b/c you control what is where
- when you know what is where, you can make things with less frustration
- you generally know what’s happening - who’s around/coming/going, etc, not too much surprise (but some!)

what makes magical mind-readingness
- frecency everywhere all of the time
- user actions are training data for sorting
- the thing you were thinking of is already at the top of the list

what makes awareness
- actions tracked at the core
- metrics generated, rollups displayed, synthesis emergent
- task context with you at the center (vs asking a companion robot - disempowering!)

synthesis
- frecency + adaptive matching gives experience/feeling of magical mind-readingness
- ability to customize/create/generate interfaces gives the comfort of home

the rules
- files > arcane/opaque boxes/formats
- metadata can be weird non-file, as long as consistent
- external systems require consent to touch my stuff (eg http caching rules)

key capabilities from action/application history chain + addressibility

- record/replay
- state feedback loops
- observability

interface spectrum
- consistent predicable interfaces are easy, off-the-shelf
- weird/generative possible via power trio: backgrounding, wm apis, web surface

cf
- bulthaup - german kitchen maker w/ designs based on carpentry workshops

## Unfiled

context
- [ ] implement old context plan: https://github.com/autonome/context
- [ ] implement as extension, expose as api or data emitter?
- eg https://www.reddit.com/r/hackernews/comments/1qddidm/sun_position_calculator/

peeks on links
- [ ] click modifier to one-off peek a link
- [ ] anchored to cursor w/in window bounds
- [ ] as an extension? hotkey + page viewer

## To make

- [ ] option to flash keyboard shortcuts on screen
- [ ] pop up a board of built-in shortcuts/actions
- [ ] pop up a board of common shortcuts/actions you use

- [ ] daily ribbon along bottom of screen, populated with actions and favicons of pages loaded (filter on web only?)

- [ ] step counter: app level interaction tracing/counting. when is reset? when does action end and new one start?

- may require connector/parameter context for each peek address load and connector invocation in a chained command

- peeks/slides as addresses + metadata? or urls? eg open({json of peek url + context}) => localhost in left slide, or peek://slide?where=top&url=http://localhost? both? opens up the idea of packaging these declaratively, and no-code createable

## UI Componentry

Right now we're replicating/forking html and js across extensions.

problems
- messy, error prone, poor DRY practice
- also means we can't generatively and rapidly build out UIs without whole new piles of html/js/css to manage

What it is
- flexible / reusable system at the ./app layer
- extensions use for creating/generating interfaces
- can override/overlay/inject styling
- easy to make system-consistent ux and themed visual design
- loosely coupled system with deterministic management
- like a set of prebuilt controls
- designed for single-component, or sets
- binds to data source, is reactive to it (events, event-sources, streams, our feed system)

what it isn't
- designed for complex document hierarchies
- js components React-style

usage
- callers instanciate a control
- provide schema/data into a control which has a default template
- template can be replaced by caller

examples/use-cases
- groups, tag ui and windows viewer are all card grids
- chaining is command components + card popups with lists, editors, previews, etc
- after atproto support, this could be used to bind lexicons + data for generated viewing/CRUD interfaces.
- see the Window templates section of this file
- see the Pagestream section of this file
- see the Chaining section of this file
- see the Notes/Editor section of this file
- see the Web page experience section of this file
- see the Unfiled section of this file
- see the Commands section of this file

implementation
- use https://open-ui.org/ as much as possible, should cover a lot, eg, buttons, card/grid, cmd, carousels
- see ~/sync/Sites/base for experiments w/ hud etc

reactive schema+card+data system
- [ ] cards + json schema + data
- [ ] no hierarchy, just single component to start, renders to markup
- [ ] instantiatable with data
- [ ] receive updates to refresh

integration
- [ ] determine how extensions will import from core
- [ ] determine how consumers will apply styles
- [ ] explore node reuse/recycle approaches

ui
- [ ] button
- [ ] button set (eg for tag boards/sets)
- [ ] card
- [ ] list
- [ ] grid
- [ ] vertical carousel of cards (like a chat view w/ interactable focus card)
- [ ] horizontal carousel of cards (eg for command chaining, day ribbons)
- [ ] image viewer
- [ ] command input
- [ ] command suggestion
- [ ] command preview pane
- [ ] search/filters on enumerable items (list, grid)
- [ ] editor
- [ ] column/columns

initial porting
- [ ] groups -> card/cards
- [ ] tags -> card/cards
- [ ] tag sets -> button set
- [ ] cmd -> command input/suggestions
- [ ] cmd chaining -> horizontal carousel, list

popup carousel system
- [ ] horizontal and vertical carousel components
- [ ] see ~/sync/Sites/base/hud.html/css/js for basic ui system
- [ ] active item focused in popup
- [ ] arrow controls and vim directionals
- [ ] port cmd chaining to horizontal carousel popups
- [ ] port cmd previews to vertical carousel popups

button sets
- [ ] set of buttons
- [ ] up/depressed states
- [ ] x endcap option

tags
- [ ] all built on buttons and button sets
- [ ] tag input field
- [ ] combo of selected tags, input w/ filtering search, available tags

## Web page experience (reviewme: partially done)

Page loading core
- [ ] how to load pages - raw browserwindow (what we do now), webview in a default transparent page that hosts overlay??
- [ ] overlay infrastructure for showing metadata, security info
- [ ] interaction with cmd actions (page mode again?)

Basic nav etc
- [ ] hotkey to select url
- [ ] back/forward
- [ ] reload
- [ ] undo last close
- [ ] if url selected in cmd is open in a window already, switch to it (for now)

Page info/metadata/action widgets (depends on window templates maybe?)
- [ ] defaults, eg sec ui
- [ ] metadata (og, whatnot)
- [ ] media (imgs, rss, etc)
- [ ] actions (new extension cmd type?)
- [ ] scripts (tbd)

Titlebar
- [x] show titlebar on hover at top edge of window for all pages

## Feeds, time-series data

We need a generalized system for feeds and time-series data.
It might be two different systems, based on analysis of the use-cases.
It might be a new system + the items system we already have, and using metadata.
The use-cases below cover a variety of feed-like needs.

Use-case: Querying web pages for time-series data
- Pattern: checking urls, collecting web data over time
- Eg a bank account balance, stock price, weather report
- Periodically load a web page in background hiddent window, and run a content script against it, returning a value and writing it to datastore (and metadata like page url, created/updated, custom metadata)
- Have a widget that shows latest value and its age
- Have a widget that shows graph of values over time

Use-case: Checking web page for ticket availability
- Pattern: checking urls for a one-time trigger
- Want to know when tickets go on sale for an event
- Periodically load a page in background, and run a content script against it
- Notify user when page change matched some criteria

Use-case: Pull data from external systems
- Pattern: harvesting 3rd party content feeds
- Eg RSS feeds or importing my posts/etc from other accounts - plays on Soundcloud, or thumbs-ups on Youtube, etc
- Imagine an extension which walks you through Oauth login for various systems, and then pulls their data into Peek via the system's API. Could be URLs with custom metadata (like Soundcloud plays) or non-URL data (like sports scores)
- Or someone could implement a feed reader extension focused on RSS reading

Use-case: System metrics
- Pattern: aggregating system metadata
- We need to be able to log and reflect all kinds of system information
- See the "Metadata, QS and reflection" section in this document for examples
- Other examples: datastore size-on-disk, ongoing performance and resource usage data
- Surface these in diagnostic panels, widgets, HUDs, etc

Use-case: Tag streaks, group change feeds
- Pattern: aggregating sysetm user data
- tag streaks - eg one day you add tags "pushups, 10", next day "pushups, 20", then be able to query feed data for number of days in a row, max pushups, graph of pushups over time, longest streak, etc
- show in widgets
- push individual records or any rollup as an atproto record to get social streaking

## Entity-centrism (aka NER indices)

Many significant entities in our lives are singletons.
A person, a place, an event.
Even replaceable objects are singletons, eg "my Ford Escort".
The web makes the publisher the apex of understanding.
Browsers do not not acknowledge entities across pages.
If you load two pages about the band Tortoise, the browser only knows you loaded two different domains.
Peek's entity-centrism projects uplifts the apex of understanding from publishers, into the user agent.

The application identifies and records entities in the pages you load.
Aims for approximate equivalancy via confidence threshold scoring.
The expirement starts with coarse types, eg person, place, event, organization.
Stores these in indices in local datastore.
The indicies are syncable with other Peek instances. 
The indices store references to the URLs entities were detected on.
The source references provide reproducibility, entity history/context, and bidirectional linking and interactions.
Provides APIs for building on top of the indexes in Peek extensions.
Uses Wikidata for a first experiment in entity validation and triangulation.
Uses the sourcing data to infer links between entities.
Scores entities based on frecency of observation and interaction.

Entity detection first take is using regexes against page content.
Can experiment also with https://github.com/mozilla/readability which we'll need for other features as well.
Can harvest microformats with https://github.com/microformats/microformats-parser, index as the relevant entity type.
We'll experiment with offline NER machine learning models as well, including training micro-models here from the data we're collecting.

We'll cast a wide net to start, recording everything.
Over time, we'll learn more about our needs and the limits of this approach.
Then we can design expiration policies, archiving, import/export, etc.
But the default should be to never lose anything.

Initial entities to harvest:

- [ ] people and related info, eg homepage, nick, social, email
- [ ] places
- [ ] dates/times/events
- [ ] meaningful numbers and their label, eg phone numbers, tracking numbers, booking numbers

- [ ] extract a table as csv
- [ ] layer outside of web page, and in between pages (eg event page -> event -> any calendar page)

- [ ] Entity catalog definition (eg Wikidata defs, or custom to start?)
- [ ] Datastore support
- [ ] Basic NER testing (regex, etc)
- [ ] Page metadata viz
- [ ] Entity search/browse
- [ ] ML NER

## Widgets

notes/questions
- maybe just cards in a sheet, fillable
- api for extensions to publish into
- fill either template+data
- or extension publishing into, iframe-like
- review w3c spec
- are widgets mini-apps (in spec sense)
- what aspects of tiles do they have?
- should be called widgets, or something else?

core uses
- page metadata panels
- command previews
- observability hud
- calculators

helpers
- widget sheets? overlays of widgets, etc - like window manager views/templates, which don't require extensions, reusable

- fun with feeds + widgets
- daytum style custom tracking/displaying

- sheet widgets - tabular data in a reactive resizable widget view (chain query -> tabular -> sheet -> widget)

## Modes/scopes

notes
- Pages have a specific mode, with specific hotkeys, etc.
- Commands like "theme dark here" operate on the "target window".
- Target window is usually what the user was looking at before opening cmd.
- Currently this works but there's no visual indication.

examples
- web page viewing has a mode w/ special actions and hotkeys
- when "in" a group, we need special mode optimized for working w/ the group's set of pages
- cmd might operate differently depending on if it's in a mode or not

- [ ] How to do page "mode" (for example) with conditional context/hotkeys/actions
- [ ] Should commands declare `scope: 'window' | 'page' | 'global'` in registration?
- [ ] How does cmd indicate scope/target?
   - [ ] eg "Target: [window title]" header when window-scoped command is selected?

## Content-/User-scripts

- [ ] Command support for blocking on a content script running
- [ ] Extension api for executing arbitrary scripts against a page
- [ ] Timeouts for page scripts in commands
- [ ] Support for scheduling scripts (or maybe that's just in the extension... harder to manage tho)
- [ ] Page load triggers for background scripts


## Browser status quo extensibility

Status quo
- [ ] Browser extensions (limited, to get a couple of popular ones working)
- [ ] Opensearch plugins
- [ ] Quicksearch
- [ ] Bookmark keywords (equivalent)
- [ ] Bookmarklets (equivalent)
- [ ] Userscripts (cf general approach to content/user scripts)
- [ ] Language packs (cf general approach to i18n/l10n)

Search
- [ ] Local
- [ ] OpenSearch

Web extensions
- [x] WebExtension integration for bundled extensions (Electron, using electron-chrome-extensions)
- [x] @cliqz/adblocker-electron for native ad blocking
- [x] Consent-O-Matic for automatic cookie consent handling (MIT, Aarhus University)
- [ ] Proton Pass for password management
- [ ] Enable/disable toggles in Settings UI

## Metadata, QS and reflection

- [ ] basically tabstats but for peek: https://github.com/autonome/tabstatistics
- [ ] view: a page of different widgets showing this info, or a hud/dashboard

collections (depends on feeds?)
- interaction count
- page load count
- page open
- page switch
- page close
- open window count
- hidden+visible window count

interaction tracing/counting
- [ ] when is reset? what makes a discrete action start/stop/change?

hud playground
- [ ] hud for system data (number of windows, etc
- [ ] using timeseries/feeds api
- [ ] each as widgets

## History 

- [ ] history views (again using groups ui, maybe plug that into an extension itself?)

History (depends on ui primitives)
- [ ] history viewer
- [ ] history search
- [ ] Infinite lossless personal encrypted archive of web history

## Files-ness

- [ ] access to notes folder(s) on filesystem to import+sync
- [ ] syncing peek-only ontes as markdown files in specified dir (or library, boo)

manual imports
- [ ] import signal note-to-self archive into peek notes
- [ ] stickiets

## Accounts/profiles/sync safety/fidelity

api key (accounts)
- [ ] how initiated (manually my operator only for now, just document it)

syncing history
- [ ] how to sync/merge frencency and adaptive matching?

## Extension dev

- [ ] shared libs, eg utils
- [ ] language: call them feature or apps? other? extensions? mods?


## Window templates

- [ ] declarative sets of ui components?
- [ ] eg page info hud overlay (~/sync/Sites/base/)
- [ ] explode: windows using groups ui with transparent background and vi directionals, enter opens
- [ ] tile/untile, eg the Explode extension

## Pagestream

A web navigational system with a vertical chat-like view of web history.

- vertical up/down chat-style history of pages/actions
- but floating cards, not chat bubbles in a column
- left/right for page-specific metadata/actions
- uses vertical carousel component + page view
- vim navigational keys
- active card pops up/open
- screenshots for pages
- open new page == scroll to bottom == open a "new tab" kind of view
- cmd+L -> url, adds to bottom of "chat"

## Notes & Editor

Description and core requirements 
- editor that can be used standalone or embedded
- markdown by default
- vim mode as global configuration option
- custom folding approach
- supports peek connectors (mime in -> edit -> mime out)

Used for
- editing notes
- editing in command chaining interstitials (edit cmd can apply to anything text-ish)
- OS level handler for editing files on filesystem

Implementation
- [x] CodeMirror integrated with three-panel layout (outline, editor, preview)
- [x] Vim mode toggle with settings persistence
- [x] Live markdown preview sidebar
- [x] Outline navigation from headers

Features
- [ ] add support for paste operations
- [ ] settings option for url to external editor (expects peek connector support), defaults to built-in editor
- [ ] tags in content detected, added/removed from tag system

Notes app
- [ ] see all notes
- [ ] filtering search on notes
- [ ] click to edit
- [ ] how to address a specific note in the editor?
- [ ] maybe we need path or name-based ways of addressing "docs" in datastore?

Integrations
- [ ] local dir sync
- [ ] import macos stickies

Stickies
- [ ] cards layout primitive (requires UI componentry?)
- [ ] "pin" notes to stickies using a tag

Requires chaining and connectors
- [ ] List editor

## Groups & Tags UX

- [ ] Define relationship between page groups and tags (are they the same? different views?)
- [ ] new page while in group mode adds to that group

Groups
- [ ] Visually communicate group-active (a "mode"? see Mode/scope section)
- [ ] Determine which new-page routes qualify for staying in group vs not
- [ ] When group-active, qualifying new pages are automatically tagged as in the group
- [ ] Determine how/when to exit group for new pages opened (eg from external app)

mobile
- [ ] filtering search of tags in tag input box
- [ ] view tag groups

cmd
- [ ] port tagging ui from mobile, eg:
  - [ ] see and be able to remove already added tags
  - [ ] input box for typing new tags and filtering unselected tag list
  - [ ] unselected tag list, each as clickable button

tagsets
- [ ] 

general
- [ ] space vs group (language)

desktop
- [ ] figure out group mode (maybe needs cmd+l)
- [ ] groups header overhaul

## Commands

- [ ] detect URL input without http(s):// prefix, auto-add https:// and open
- [ ] command tags {str} to load tag in group view
- [ ] peek addresses as cmds by title (http too?)
- [ ] cmd/peek history (they don't show up in cmd!)
- [ ] map cmd using OSM
- [ ] open kagi via cmd
- [ ] search history via cmd
- [ ] all commands as a button board

- [ ] app+browser history swiss army knife for querying and generating url lists via chaining, saving for offline (->txt) etc, maybe using connectors


## Chaining / Connecting

Now that we have commands, we need to be able to chain them together for more complex "workbench-y" interactions. Chaining reqs inputs/outputs (eg activities/intents/applets), so that API unlocks the rest.

Example flow:
- open a web page
- cmd: show lists -> shows list of lists detected in the page
- arrow up/down and choose one -> shows preview of the selected list
- cmd: csv -> shows preview of csv
- cmd: save file -> prompts to download

- [ ] Connector API: Chaining reqs inputs/outputs (eg activities/intents/applets)
  - [ ] Determine if this should be a new API or reuses command registration
  - [ ] Extension API to register as a connector handler for a set of mime/types
  - [ ] Extension API to emit data to handlers for the specified mime type output (or maybe we allow multiple like the web clipboard API does)
- [ ] Cmd support for chaining flow using "connectors"
  - [ ] Add Connector Handler support, so data can move one-way from a command to another
  - [ ] Filter first on mime type matches
  - [ ] Policy for determing best matching command order (using frecency + adaptive matching)
- [ ] Support previewing of the data in between steps
  - [ ] Modular system for plugging renderers in for generating previews/editors of mime types
  - [ ] Doesn't need to be an extension API yet, but we'll need a way for that later maybe
  - [ ] Preview panel is visually connected to the cmd panel, which should stay visible or visually connected somehow
- [ ] Cmd UI updates
  - [ ] Cmd panel can show dropdown listing matching commands
  - [ ] User can navigate list w/ arrow up/down, j/k and tab/shift-tab
  - [ ] If cmd response has a previewAddress property, show a preview pane w/ that address

examples
- [ ] execute a command which executes a userScript against a loaded page, detects list/table-ish things (with previews), lets you select one, which it exports as a "list" out (CSV? JSON?)
- [ ] links on page -> list -> button cloud -> kb activate (then shorten to "link cloud" cmd)
- [ ] compound cmds (like "link cloud". uses chaining? like a chain package?)

## Media: images/videos, favicon/screenshot cache

Media storage architecture
- [ ] review use-cases for images/videos/favicons/screenshot
- [ ] files or other, hybrid?
- [ ] addressing scheme
- [ ] platform-specific integrations (eg mobile)

Image saving
- [ ] media storage for images
- [ ][mobile] complete image sharing/tag-editing/viewing support

- [ ] store screenshots and favicons for any page loaded through window system
- [ ] save on disk in profile
- [ ] investigate how media caches store/address for url-based high performance lookup
- [ ] store location of files as url metadata
- [ ] integrate lookups in groups, url cards, page info, etc

- [ ] per-profile favicon cache dir
- [ ] take and save favicon of any address loaded through window system
- [ ] store in profile favicon cache, and save location as metadata record on the address

- [ ] per-profile screenshot cache dir
- [ ] take and save screenshot of loaded windows for any new address
- [ ] store in profile screenshot cache, and save that as metadata record on the address


## Server Backend

agent mode
- [ ] agent mode: explore running application logic in a headless node

diagnostics
- [ ] diagnostic/status API: resource usage, overall disk usage, per-user disk stats, request volume and data types
- [ ] make widget on desktop

misc
- [ ] Add migration dry-run mode
- [ ] Add automatic backup cleanup after grace period

## Extension: harvester

- [ ] push all services to peek node webhook, eg bsky likes, reddit

- oauthwonderwall?

## Extension: hearts and stars

- tweetdeck-like column set, but narrower and each a feed

## Mobile

- [ ] in url saves/views, show oembed, or at least page title
- [ ] for url saves, save title and any other metadata
- [ ] investigate detecting which app a share came from

## Session & State Management

- [ ] export/import
- [ ] session restore

## Archiving / expiration

- [ ] archived notes (lower score, hidden by default)

## Sorting/scoring/magic

Generally default is based on the old Firefox "awesomebar" scoring/search algorithms.

Frecency + adaptive matching.

The app *learns* you, and what you want magically appears w/o AI as requirement.

## Desktop Performance

- [ ] Reduce startup time (currently ~550ms build)
- [ ] Pre-compiled TypeScript: skip tsc during dev if no changes
- [ ] Lazy extension loading: load on first access instead of startup
- [ ] Suspend inactive tabs (reduce memory for background pages)
- [ ] Performant BrowserWindow unloading (fully release resources when not needed)

## Identity and privacy

keys
- [ ] server-less identity system
- [ ] key backup/restore/rotation

encrypted storage
- [ ] account unlocks its profiles
- [ ] profile switching/opening screen

point-of-use privacy
- [ ] private items, eg gift ideas, cf archived - visible with magic tag (which itself doesn't show in history)
- [ ] private links - click not tracked, opens page in private mode
- [ ] private profiles

## Demos / Tutorials / Comms

Demo reel
- [ ] Define demo reel
- [ ] Peeks: translate, calendar, ai chat, currency conversion, everytimezone, tldraw
- [ ] Slides: soundcloud, crypto prices, notepad, todo list
- [ ] Scripts: stock price, weather change

## Publishing, Provenance, Remote Extensions

misc ideas
- [ ] share system
- [ ] poke at remote loading + provenance
- [ ] publish pages/apps?

experiment: helia
- [ ] local publishing, eg use editor to write a blog post, hit publish… and share (handwave)

## Minimum viable web workbench

- [ ] Design philosophy write-up w/ driving principles and characteristics
- [ ] Multi-protocol architecture
- [ ] Content publishing
- [ ] Event model
- [ ] Chaining
- [ ] Images
- [ ] Lists/feeds

## Devtools

- [ ] Devtools button in extension settings cards (open devtools for extension window)
- [ ] Devtools command to open devtools for a specific extension or window
- [ ] Fix `api.extensions.devtools()` - currently not working for consolidated extensions

## Storage

- [ ] try DuckDB as datastore storage backend instead of SQLite


## Parking lot

- [ ] Identities system
- [ ] Contacts integration
- [ ] Collaboration

desktop
- [ ] Tray work

