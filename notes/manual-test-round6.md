# Manual Test Checklist — Round 6

Consolidated from rounds 2-5. Only open/unaddressed items carried over.

## BLOCKING: Session Restore + Window Positioning

Round 6 fixes (4 root causes found and fixed):

1. **Settings not saved**: utility window filter was too broad (`role === 'utility'` skipped settings). Now only skips non-focusable utility windows (HUD).
2. **Canvas mode disabled on restore**: saved params (role, escapeMode) leaked into window-open handler, disabling canvas. Now stripped before restore.
3. **Debounce outlasts suppression**: display events queued before suppress could fire during restore. Now cancels pending timers on suppress toggle.
4. **macOS moves windows before debounce**: on display unplug, macOS relocates windows instantly but display-watcher waited 500ms. Now eagerly snapshots bounds on first display-removed event.

### Session Restore

- [x] Open two web pages (edges of screen) + settings (middle). Close app. Restart. All three restore with correct content and positions.
- [x] Move windows to screen edges → restart → windows still on edges
- [x] Session restore doesn't duplicate HUD/utility windows (no double dock bounce)

### Display Switching

- [ ] Unplug external display → windows move to laptop. Plug back in → windows return to external display.
- [ ] Switch between different-sized displays → windows reposition proportionally (not clustered in top-left)

## Window Dragging

Still completely broken after 4 rounds of fixes. Last attempt was full rewrite removing 5px movement threshold, 120ms unconditional hold, RAF-batched IPC.

- [ ] Cmd: long-press anywhere in visible bar → drag works
  - failed, works but drag icon doesn't show when initial click was in the input area, only works when i'm in the border
- [ ] Tags: long-press on item cards, tag buttons, non-text-input area → drag works, does NOT activate button
  - kinda works, but also still loses drag entirely and selects text. the selection might be hint to what the problem is. feels like this is less about the motion than it is events getting lost/stolen/captured.
- [ ] Settings: long-press on nav items, labels, non-focused inputs → drag works
  - this is same as above issue in tags ui
- [ ] Editor: long-press drag
  - failed, does not work at all in the editor area, and when it worked from long-pressing a border area, it lost the drag easily by moving cursor around even a little bit (see above note)
- [ ] Fast cursor movement during drag doesn't drop the drag
  - this, inverted, is a key issue. it's usually the oppsite. move the cursor around, it works a little and then loses the drag. drops too early, or something else interrupts somehow.

## Command Palette — Frecency

- [ ] Type "ta" → ghost text adapts based on usage (frecency)
  - Prefix feedback loop removed in round 4, versioned adaptive data resets stale data
- [ ] Use "open tags" many times → type "ta" → adapts to suggest "open tags"
- [ ] somehow we lost web pages. i've typed http://localhost and https://example.com in more than anything else (or selected them from autocomplete), but now *neither* is showing up at all.
  - [x] RETEST: root cause was frecency recorded against generic `'open'` command instead of actual URL. URLs never accumulated scores. Now records against the matching URL command name (e.g. `http://localhost:3000`).
  - no, we're not storing the history. those urls are loaded over and over, yet do not show up at all now

## HUD

Not tested since round 3 fixes.

- [ ] HUD only visible when Peek is focused, hides when switching to other app
  - failed — browser-window-blur/focus are per-window events, unreliable with utility windows
  - [ ] RETEST: switched to macOS `did-resign-active`/`did-become-active` — app-level focus events that fire on OS app switch, not between Peek windows
  - hud still visible when app is not focused.
- [x] HUD is subtle/unobtrusive (65% opacity bg, muted text, no colored modes)
  - 50% was too transparent, bumped to 65%
  - [x] RETEST: `rgba(0, 0, 0, 0.65)` background
- [x] HUD expands vertically to show all stats content

## Smoke Tests

- [ ] Groups: create new group via "+" button
  - [x] Round 3: global keyboard handler early-returns when create-group input focused
  - failed, groups -> new group -> type name -> hit enter -> new group does not shows
  - [ ] RETEST: root cause was `renderGroups()` filtering out tags with `addressCount === 0`. New groups have 0 items so were immediately hidden. Fixed by including all tags.
- [ ] Tags: create tagset with "#foo #bar" — creates tagset type, not note
  - Round 3: tagset returns success message only (no editor open), favicon SVG fix
  - failed: tags -> + -> editor: type only "#foo #bar" -> esc -> shows in list as a note
  - put this on hold, note isn't really right way to do this

## Settings UI

- [ ] Settings labels layout: crammed on both sides around checkbox — needs consistent, readable layout across all panes (maybe dedicated peek-component set)
  - not fixed, cf web search
- [ ] Settings/profiles: selected profile should be on top, list sorted by last used
  - not fixed yet

## Dark Mode

- [ ] Web pages respect OS color scheme (not forced dark)
  - nativeTheme.themeSource only set to 'dark' for 'force' mode, 'system' for everything else
  - Not tested yet — needs test steps

## Entities

Round 6: prices and dates now require context (standalone ones skipped), expanded JSON-LD coverage, UI shows source pages + detail pane, migration purges old noisy entities.

### Entity Recognition

- [ ] Browse a product page (e.g. Amazon item) → price entity created with product name (not just "$X.XX")
- [ ] Browse a page with standalone prices (e.g. pricing table, calendar widget) → no noisy standalone price/date entities
- [ ] Browse a page with event dates → date entities created with event context (e.g. "Conference Talk Feb 15")
- [ ] Browse a recipe page → recipe extracted as creative_work entity with author, cook time, etc.
- [ ] Browse a page with JSON-LD structured data (software app, course, review) → entities extracted
- [ ] After first launch: old standalone price/date entities purged by migration

### Entities UI

- [ ] Entity cards show at least one source page (title, clickable to open)
- [ ] Cards with multiple sources show "+N more" count
- [ ] Click entity card → detail pane shows: all attributes, aliases, confidence, extractor, first/last seen, all source pages
- [ ] Source pages in detail pane are clickable (opens page)
- [ ] ESC from detail pane → back to entity list

## Tags Reactivity

Round 6: sync operations now publish `sync:pull-completed` event. Tags, groups, pagestream UIs subscribe and refresh.

- [ ] Open tags view → sync (pull new items from server) → tags view updates without manual reload
- [ ] Same test for groups view
- [ ] Same test for pagestream view

## Cmd Chaining (on hold — needs plan/spec)

- [ ] `list notes #tag` → `markdown` → `download` / `save as note` pipeline
- [ ] After tab-completing "list notes" and hitting space, "list groups notes" appears with "groups" not in bold
- [ ] List notes doesn't get whole list or item contents
- [ ] `open file` — native file picker, MIME detection, chaining support
