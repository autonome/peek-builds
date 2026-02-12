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

## Session Restore
- [ ] `yarn start` → open web pages → move/resize them → Ctrl+C → `yarn start` — restore prompt, correct positions
  - RETEST: fixed page.js to update URL params after drag/resize via history.replaceState()
- [ ] Cmd+Q quit → restart — should NOT show restore prompt (clean shutdown)
  - RETEST: fixed quitApp() to not call shutdown() before app.quit(), so before-quit handler can write cleanShutdown:true
- [ ] Ctrl+C quit → restart — SHOULD show restore prompt (unclean shutdown)
  - RETEST: SIGINT now passes cleanShutdown:false
- [ ] cmd → "save session" → cmd → "restore previous session" — confirmation dialog, restores
  - this is the manual save/restore command (separate from auto-restore on startup)

## Window Dragging
- [ ] Cmd: long-press anywhere in visible bar → drag works
  - RETEST: narrowed exclusions to only focused text inputs; buttons/links/etc now allow drag
- [ ] Tags: long-press on item cards, tag buttons, any non-text-input area → drag works
  - RETEST: same fix
- [ ] Settings: long-press on nav items, labels, non-focused inputs → drag works
  - RETEST: same fix
- [ ] Editor: long-press drag
  - RETEST: same fix
- [ ] Fast cursor movement during drag doesn't drop the drag
  - RETEST: replaced e.buttons check with explicit mouseButtonDown boolean tracking
- [ ] Page host: click on transparent background passes through to windows behind
  - RETEST: BROKEN — setIgnoreMouseEvents brings unrelated windows into focus, needs rework

## Command Palette
- [ ] Type "ta" — ghost text shows "tag" (prefix match on fresh/equal scores)
  - RETEST: added deterministic tiebreakers (prefix > shorter > alphabetical)
- [ ] Use "open tags" many times → type "ta" — adapts to suggest "open tags"
  - RETEST: same fix ensures frecency wins when scores diverge

## Search Engines
- [ ] Set Kagi as default via dropdown → cmd search uses kagi.com
  - RETEST: fixed namespace mismatch (web search vs websearch), defaultEngine now a select dropdown
- [ ] Search suggestions appear as you type in search UI
  - RETEST: added net-fetch IPC using Electron net.fetch() to bypass CORS

## Settings UI
- [ ] Editor, Web Search, Example Gallery sections show human-readable labels
  - RETEST: added labels to extension schema files, settings.js uses them
- [ ] Datastore section renders inline (not new window), shows correct table counts
  - RETEST: renders as pane, updated table list to current schema
- [ ] Diagnostics section renders inline (not new window)
  - RETEST: renders as pane
- [ ] Clear quit shortcut field → resets to default (Cmd+Q visible)
  - RETEST: empty string auto-resets to schema default, placeholder shows default

## HUD
- [ ] HUD only visible when Peek is focused, hides when switching to other app
  - RETEST: added app:focus-changed events, HUD subscribes to show/hide
- [ ] HUD is semi-transparent (content behind visible)
  - RETEST: background rgba(0,0,0,0.65) with backdrop blur
- [ ] HUD expands vertically to show all stats content
  - RETEST: auto-resize via scrollHeight measurement, default 400px

## Smoke Tests
- [ ] Groups: create new group via "+" button
  - RETEST: added create button + inline form
- [ ] Tags: create tagset with "#foo #bar" — creates tagset type, not note
  - RETEST: added parseTagset() detection in note command
- [ ] Tag card: first item no longer has highlight running through it
  - RETEST: removed redundant outline CSS
- [ ] Editor: opens in portrait/document orientation (800x1000)
  - RETEST: changed default from 1200x800 to 800x1000
