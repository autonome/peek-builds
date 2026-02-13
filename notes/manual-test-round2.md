# Manual Test Checklist — Round 2

Re-test items that had fixes applied. Passed items from Round 1 removed.

## Additional Issues Found in Round 1

Status of each item from the original list:

- [x] page host clicks pass through transparent background — FIXED but BROKEN: brings unrelated windows into focus, needs rework
- [x] cmd+q quit causes session restore prompt every time — FIXED, retest below
- [x] window dragging gets lost with quick cursor movement — FIXED, retest below
- [x] no suggestions in search ui — FIXED, retest below
- [x] web search settings: select dropdown not text input — FIXED, retest below
- [x] web search settings: description labels — FIXED, retest below
- [x] datastore/diagnostic should be panes not windows — FIXED, retest below
- [x] datastore not working, needs schema update — FIXED, retest below
- [x] first tag card highlight regression — FIXED, retest below
- [x] editor default size: portrait not landscape — FIXED, retest below
- [x] HUD only show when peek focused — FIXED, retest below
- [x] HUD semi-transparent and unobtrusive — FIXED, retest below
- [x] HUD expand vertically to show content — FIXED, retest below

## new items in round 2

- [x] no way to clear text in cmd bar. eg i type something, hit tab to inline complete a long suggestion, but then change my mind. esc closes the bar, and upon reopening, the text i don't want is still there. how about we use izui style nav - first escape clears the typed text, second closes cmd
  - [x] RETEST round 3: first ESC clears input text, second ESC closes panel
  - failed - cmd: type something -> esc -> cmd closes
  - [x] RETEST round 5: root cause was dead code — Electron main process intercepts ESC via before-input-event, blocks DOM keydown. Fixed by registering api.escape.onEscape() callback that returns {handled:true} when clearing text.
- [x] shift-tab in cmd bar should cycle through suggestions in reverse
  - [x] RETEST round 3: Shift-Tab cycles backward with modular wrap
- [x] adding new note from any method gives the item card the url icon in the tags instead of document icon
  - [x] RETEST round 3: fixed escapeHtml corrupting SVG data URIs, set img.src via DOM property
- [x] we lost click-hold-drag on web pages again
  - [x] RETEST round 4: proper mouse event bridge — webview injects mousedown/mouseup/mousemove via console.log, parent handles 150ms hold
- [x] cmd inline suggestions are auto-autocompleting, eg: cmd: barf -> kagi search for barf -> change default search to ddg, confirm works for new search, eg cmd: blah -> cmd: barf -> i see the autocomplete but don't hit shift, hit enter instead -> loads the suggestion url that i didn't want (expected it to do new search w/ ddg)
  - [x] RETEST round 4: Enter now requires userCommittedToCommand (exact match, cmd+params, or explicit results browsing). Ghost suggestion alone won't trigger command — falls through to web search.
- [ ] settings labels are there, but in some cases the layout is bad, crammed in on both sides around checkbox, should do consistent and readable layout across all settings panes, maybe needs dedicated peek- component set
  - not fixed yet — needs design work

## new items in round 4

- [x] mode leaks into global OS scope, eg cmd: (open page, to trigger page mode) -> switch to some other app -> cmd hotkey -> cmd should be in default mode, but says page
  - [x] RETEST round 5: changed from coordinator.isTransient() (one-way ratchet, never downgrades) to !coordinator.isAppFocused() (real-time OS focus state). Mode resets to default when app loses focus.
- [x] open windows don't come to front, eg: cmd: settings -> cmd: (open web page) -> cmd: settings -> nothing happens, still see web page (this even happens when app not focused - it focuses app, but not correct window)
  - [x] RETEST round 5: added win.focus() after win.show() in keepLive window reuse path. macOS show() makes visible but doesn't raise — focus() brings to front.
- [ ] settings/profiles -> selected profile should be on top, list sorted by last used
  - not fixed yet
- [ ] perhaps related to the multi-display-positioning, we lost window positioning correctness over session restores. i tried moving two windows to edges to see if they'd still be on edges, then restart peek, and neither were on edges
  - [ ] RETEST round 5: added suppressDisplayRepositioning() during session restore. macOS workArea changes on app activation were triggering false "display changed" events that repositioned restored windows.
  - worse, and weirder: open two web pages, move one to each side edge of screen. open settings. close app. yarn start. all are positioned correctly, but the middle page that was settings app is now another instance of the page on left edge!!!
  - add a task to do full review of session restore + window positioning in an agent dedicated to shaking things out here

## Session Restore
- [x] `yarn start` → open web pages → move/resize them → Ctrl+C → `yarn start` — silently restores, correct positions
  - [x] RETEST: fixed page.js URL params, crash dialog now requires crashCount > 0 (single unclean shutdown silently restores)
- [x] Cmd+Q quit → restart — silently restores (clean shutdown, no dialog)
  - [x] RETEST: fixed quitApp() to not call shutdown() before app.quit()
- [x] Ctrl+C quit → restart — silently restores (single unclean shutdown, no dialog)
  - [x] RETEST: changed crash dialog condition to require crashCount > 0
- [x] Session restore doesn't duplicate HUD/utility windows (no double dock bounce)
  - [x] RETEST: utility-role windows skipped during session save
- [x] cmd → "save session" → cmd → "restore previous session" — confirmation dialog, restores
  - this is the manual save/restore command (separate from auto-restore on startup)

## Window Dragging

- [ ] Cmd: long-press anywhere in visible bar → drag works
  - [x] RETEST round 2: narrowed exclusions to only focused text inputs — failed, couldn't drag at all
  - [x] RETEST round 3: shouldBlockDrag checks e.target not document.activeElement — failed, same
  - [x] RETEST round 4: FULL REWRITE — removed 5px movement threshold (root cause: hand tremor cancelled hold timer silently), hold fires unconditionally after 120ms, snapshots position at fire time, RAF-batched IPC
  - still completely broken
- [ ] Tags: long-press on item cards, tag buttons, any non-text-input area → drag works, does NOT activate button
  - [x] RETEST round 2: same fix — failed, kinda worked sometimes, activated buttons
  - [x] RETEST round 3: suppressNextClick flag — failed, same
  - [ ] RETEST round 4: same full rewrite as above, click suppression preserved
- [ ] Settings: long-press on nav items, labels, non-focused inputs → drag works
  - [ ] RETEST round 4: same full rewrite
- [ ] Editor: long-press drag
  - [ ] RETEST round 4: same full rewrite
- [ ] Fast cursor movement during drag doesn't drop the drag
  - [x] RETEST round 2: mouseButtonDown boolean — failed, worse even
  - [x] RETEST round 3: window-level capture — failed, still broken
  - [ ] RETEST round 4: removed movement threshold entirely + RAF batching
- [x] Page host: minimal window, no click-through needed (transparent area eliminated)
  - [x] RETEST: replaced fullscreen transparent window with tight-fitting minimal window
- [x] Page host: navbar show/hide doesn't cause webview jump
  - [x] RETEST: window always includes navbar space, show/hide is CSS-only (no setBounds)

## Command Palette
- [ ] Type "ta" → ghost text adapts based on usage (frecency)
  - [x] RETEST round 2: deterministic tiebreakers — failed, still always "tag"
  - [x] RETEST round 3: originalTyped tracking — failed, still always "tag"
  - [ ] RETEST round 4: removed prefix feedback loop cross-contaminating "ta"→"tag" scores, versioned adaptive data resets stale data, frecency alone now ranks "open tags" (58 uses) above "tag" (17 uses)
- [ ] Use "open tags" many times → type "ta" — adapts to suggest "open tags"
  - [ ] RETEST round 4: same fix — stale data cleared, clean adaptive tracking going forward

## Search Engines
- [x] Set Kagi as default via dropdown → cmd search uses kagi.com
  - [x] RETEST: fixed namespace mismatch (web search vs websearch), defaultEngine now a select dropdown
- [x] Search suggestions appear as you type in search UI
  - [x] RETEST: added net-fetch IPC using Electron net.fetch() to bypass CORS

## Settings UI
- [x] Editor, Web Search, Example Gallery sections show human-readable labels
  - [x] RETEST: added labels to extension schema files, settings.js uses them
- [x] Datastore section renders inline (not new window), shows correct table counts
  - [x] RETEST: renders as pane, updated table list to current schema
- [x] Diagnostics section renders inline (not new window)
  - [x] RETEST: renders as pane
- [x] Clear quit shortcut field → resets to default (Cmd+Q visible)
  - [x] RETEST: empty string auto-resets to schema default, placeholder shows default

## HUD
- [ ] HUD only visible when Peek is focused, hides when switching to other app
  - [ ] RETEST round 3: main process directly hides/shows utility windows on blur/focus (showInactive on focus)
- [ ] HUD is subtle/unobtrusive (50% opacity bg, muted text, no colored modes)
  - [ ] RETEST round 3: toned down from 65% to 50% opacity, removed mode/IZUI colors, muted text
- [ ] HUD expands vertically to show all stats content
  - [ ] RETEST round 3: auto-resize via scrollHeight measurement, narrower 240px window

## Smoke Tests

- [ ] Groups: create new group via "+" button
  - [x] RETEST round 2: added create button + inline form — failed, did not create the group
  - [ ] RETEST round 3: global keyboard handler early-returns when create-group input focused
- [ ] Tags: create tagset with "#foo #bar" — creates tagset type, not note
  - [x] RETEST round 2: added parseTagset() detection — failed, created note with url icon
  - [ ] RETEST round 3: tagset returns success message only (no editor open), favicon SVG fix
- [x] Tag card: first item no longer has highlight running through it
  - RETEST: removed redundant outline CSS
- [x] Editor: opens in portrait/document orientation (800x1000)
  - RETEST: changed default from 1200x800 to 800x1000

## cmd chaining (on hold — needs plan/spec work)

eg `list notes #tag` → `markdown` → `download` or `save as note`
NEW: full pipeline with produces/accepts MIME types

- [ ] cmd: list -> then hit tab until it suggests "list notes" -> hit space so i can add tag filters -> after hitting space, the cmd bar contains "list groups notes" where "groups" is not in bold but the others are. typing more chars does not make it go away.
- [ ] i need to get the whole list of notes into markdown, but it seems not to get the whole list, or even the contents of the items.
- [ ] cmd: `open file` — native file picker, MIME detection, chaining support
  - NEW: opens file dialog, detects MIME, chains to markdown/download

lots of issues with the whole flow. this is a challenging feature, maybe we stop and go back to plan/spec work on it.

## New Features (since Round 1)

- [ ] Dark mode: web pages respect OS color scheme (not forced dark)
  - FIX: nativeTheme.themeSource only set to 'dark' for 'force' mode, 'system' for everything else
  - [ ] not tested yet, need better test steps
- [x] Note inline hashtags: `#foo #bar` in note text creates tag associations
  - FIX: extractInlineHashtags() scans text content for hashtag patterns
- [ ] Display switching: windows reposition proportionally when changing displays
  - [x] RETEST round 2: display-watcher.ts per-window ratio mapping — failed, windows clustered in top-left
  - [x] RETEST round 4: group-based center-of-group distance scaling — scales inter-window distances proportionally, preserves spatial arrangement
  - worse! is a regression. now when i am in external display as main, and unplug it then plug back in, all windows still on laptop instead of main display.
  - [ ] RETEST round 5: added home display tracking — saves each window's "home" display ID + relative position. On display remove, remembers where windows were. On display re-add, matches by ID then resolution (5% tolerance) and restores windows back to their home display.
