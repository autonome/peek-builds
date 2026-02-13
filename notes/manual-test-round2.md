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

- [ ] no way to clear text in cmd bar. eg i type something, hit tab to inline complete a long suggestion, but then change my mind. esc closes the bar, and upon reopening, the text i don't want is still there. how about we use izui style nav - first escape clears the typed text, second closes cmd
- [ ] shift-tab in cmd bar should cycle through suggestions in reverse
- [ ] adding new note from any method gives the item card the url icon in the tags instead of document icon
- [ ] we lost click-hold-drag on web pages again
- [ ] cmd inline suggestions are auto-autocompleting, eg: cmd: barf -> kagi search for barf -> change default search to ddg, confirm works for new search, eg cmd: blah -> cmd: barf -> i see the autocomplete but don't hit shift, hit enter instead -> loads the suggestion url that i didn't want (expected it to do new search w/ ddg)
- [ ] settings labels are there, but in some cases the layout is bad, crammed in on both sides around checkbox, should do consistent and readable layout across all settings panes, maybe needs dedicated peek- component set

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
  - [x] RETEST: narrowed exclusions to only focused text inputs; buttons/links/etc now allow drag
  - failed, couldn't get it to drag at all
- [ ] Tags: long-press on item cards, tag buttons, any non-text-input area → drag works
  - [x] RETEST: same fix
  - failed, it kinda worked sometimes, but lost it sometimes, and also did select the tag button (for example), but should not do the activation, since the user is only trying to move the window not select a tag
  - same failure
- [ ] Settings: long-press on nav items, labels, non-focused inputs → drag works
  - [ ] RETEST: same fix
  - not tested, needs fix from above
- [ ] Editor: long-press drag
  - [ ] RETEST: same fix
  - not tested, needs fix from above
- [ ] Fast cursor movement during drag doesn't drop the drag
  - [x] RETEST: replaced e.buttons check with explicit mouseButtonDown boolean tracking
  - still broken
  - definitely not fixed, maybe worse even
- [x] Page host: minimal window, no click-through needed (transparent area eliminated)
  - [x] RETEST: replaced fullscreen transparent window with tight-fitting minimal window
- [x] Page host: navbar show/hide doesn't cause webview jump
  - [x] RETEST: window always includes navbar space, show/hide is CSS-only (no setBounds)

## Command Palette
- [ ] Type "ta" — ghost text shows "tag" (prefix match on fresh/equal scores)
  - [ ] RETEST: added deterministic tiebreakers (prefix > shorter > alphabetical)
  - still "tag" as first inline suggestion, no matter how many times i select "open tags"
- [ ] Use "open tags" many times → type "ta" — adapts to suggest "open tags"
  - [ ] RETEST: same fix ensures frecency wins when scores diverge
  - not tested

## Search Engines
- [x] Set Kagi as default via dropdown → cmd search uses kagi.com
  - [x] RETEST: fixed namespace mismatch (web search vs websearch), defaultEngine now a select dropdown
- [x] Search suggestions appear as you type in search UI
  - [x] RETEST: added net-fetch IPC using Electron net.fetch() to bypass CORS

## Settings UI
- [x] Editor, Web Search, Example Gallery sections show human-readable labels
  - [x] RETEST: added labels to extension schema files, settings.js uses them
- [x] Datastore section renders inline (not new window), shows correct table counts
  - [x]RETEST: renders as pane, updated table list to current schema
- [x] Diagnostics section renders inline (not new window)
  - [x] RETEST: renders as pane
- [x] Clear quit shortcut field → resets to default (Cmd+Q visible)
  - [x] RETEST: empty string auto-resets to schema default, placeholder shows default

## HUD
- [ ] HUD only visible when Peek is focused, hides when switching to other app
  - RETEST: added app:focus-changed events, HUD subscribes to show/hide
- [ ] HUD is subtle/unobtrusive (50% opacity bg, muted text, no colored modes)
  - RETEST: toned down from 65% to 50% opacity, removed mode/IZUI colors, muted text
- [ ] HUD expands vertically to show all stats content
  - RETEST: auto-resize via scrollHeight measurement, narrower 240px window

## Smoke Tests

- [ ] Groups: create new group via "+" button
  - RETEST: added create button + inline form
  - failed, did not create the group
- [ ] Tags: create tagset with "#foo #bar" — creates tagset type, not note
  - RETEST: added parseTagset() detection in note command
  - failed, this time it created a note and put the tags on 2nd row after saving, but it was still a note (with a url icon)
- [x] Tag card: first item no longer has highlight running through it
  - RETEST: removed redundant outline CSS
- [x] Editor: opens in portrait/document orientation (800x1000)
  - RETEST: changed default from 1200x800 to 800x1000

## cmd chaining

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
  - [x] NEW: display-watcher.ts monitors display-added/removed/metrics-changed, remaps window positions proportionally
  - not working. tested moving from laptop to big screen as main display. windows in correct place, but as if the top-left of big screen was entire small screen. want to match the layout, while scaling *distance* up/down between screen sizes.
