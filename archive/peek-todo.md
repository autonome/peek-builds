# Peek TODO

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

## Papercut / use-case log

Core high level actions
- open a web page on top/bottom/left/right
- keep web pages persistent in the background
- quickly open a web page modally, and close it

Misc specific
- open bandcamp in a window, move over to 2nd display, accidently close it while moving around between other windows
- recent books or recipes from newsletters i subscribe to (but probably didn't read)
- extract a table from a page periodically, send it somewhere as csv or whatever (chained actions)
- collect microformats, metadata, events
- web page w/ some locations as an input to a map (creates overlay) "map this page"
- be able to see where a book/etc recommendation came from
- save a tweet, with URL / image / relevant text, but not whole page webrecorder style
- "watch local event listings, rate against my music listening patterns and send me shows i might be interested in going to"

Content scripts
- extract+log shazams
- extract+log spotify playlist

Calculators (variant of script + cmd?)
- page -> table
- page -> summary
- page -> microsummaries
- page -> dates
- page -> events

Workflow deconstructing a "why" task flavour of bookmarking
- save https://www.criterionchannel.com/hong-kong-in-new-york
- extract the movies
- get reference metadata for each (?!)
- add to "to watch list", with pointer back to source url

## Groups

- panorama/tabcandy-ish
- all browser history
- smart groups vs curated groups
- autoclustering on topic/date
- escape from a new page enters default group?

Groups + Cmds
- top/bottom inputs for filtering/grouping/etc
- implemented is a cmd input?
- cmds for opening/searching/finding/viewing/filtering/piping
- cmds for moving pages into groups
- groups -> {x} (eg export/pipe) could depend on the chaining/piping bit (see below)

Architecture
- internally is tags?
- static vs dynamic groups tho?

Publishing
- publishing groups as internal/public feeds?
- to pinboard?

## History view/search

A lot of groups work depends on history being in place, and being accessable and annotate-able.

ideally use chromium history

storage+access
- check out Agregore history viewing approach
- check out state of electron+webext
- other way of accessing underlying chromium history?

features
- awesomebar algo scoring
- adaptive matching

## Chaining / piping

investigate: vague thought re chaining:
- dynamic interstitial representations
- mime type detection?
- eg image previews
- or a table of data
- previews of cmds?

interfaces
- horizontal vs vertical chains
- back/forward navigation?
- each step is a cmd+preview?
- dynamic cmd+previews?

import/export/undo/redo
- record/replay?
- save a chain as a compound action (cmd)?

architecture
- look at web actions/intents/applets
- xml pipeline language

## Mobile

- some of the features don't make sense as-is on mobile
- but maybe quick access on mobile to slides/peeks would be nice
- and seeing output of content scripts, or ability to re-run locally on demand
- needs some sync facility (inevitable anyway)

## Use-cases

Peeks
- translate
- calendar
- ai chat
- currency conversion
- everytimezone
- tldraw

Slides
- music: Soundcloud, Hypem
- stock prices
- notepad
- todo list

Scripts
- weather change, eg upcoming weather
- crypto prices

Cmd - web
- open url
- web search
- image search
- conversions?
- ddg !actions

Cmd - system
- search browser history
- set peeks/slides
- open settings
- restart app
- llm prompts

Future
- address something to switch between
- pipe from/to?

Publishing high level
- author web content
- pull in bits from the web
- share preview for feedback
- publish (or at least get output)

Publishing examples
- writing an event recap

Publishing: event recap post
- make a new markdown doc
- sections titled for each video title
- each video's embed code in each section
- navigate around the document for review and updates
- need to easily preview rendered content
- share preview link
- publish (somewhere?)

Music
- commands
- views
- last.fm of my own, to POSSE out

## Unfiled

markdown hot reload previewer w/ toc
- markdown support, with sidebar nav
- reader mode
- hot reload for file:// (other?)
- add side-by-side view
- once md and side-by-side, add side-by-side so the md is the nav, content is the preview
- what's the cmd chain for this?

content types + chaining
- cmd: view as… table, feed, markdown, data points, named entities
- chain: static archive, publish, save, share (os), mailto
- cmd params, eg {url}, which can themselves autocomplete (eg history)

multiprotocol
- at
- ipfs/ipns
- pragmatic addressing+rendering for data (r/d/masl + mime handlers)

broader patterns (chatting w/ luke)
- why do we have to copy/paste?
- devtools and ide are divorced

chainframe/framechain
- (web intents/applets/actions) + (webxdc/miniapps/tiles/farcasterframes)

Small examples of agency

- users can move, resize, change things to their requirements
  - eg, browsers restrict min-height of a window, but i should be able make as short as i like

