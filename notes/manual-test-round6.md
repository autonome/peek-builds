# Manual Test Checklist — Round 6

Consolidated from rounds 2-5. Only open/unaddressed items carried over.

## BLOCKING: Session Restore + Window Positioning

Round 6 fixes (4 root causes found and fixed):

1. **Settings not saved**: utility window filter was too broad (`role === 'utility'` skipped settings). Now only skips non-focusable utility windows (HUD).
2. **Canvas mode disabled on restore**: saved params (role, escapeMode) leaked into window-open handler, disabling canvas. Now stripped before restore.
3. **Debounce outlasts suppression**: display events queued before suppress could fire during restore. Now cancels pending timers on suppress toggle.
4. **macOS moves windows before debounce**: on display unplug, macOS relocates windows instantly but display-watcher waited 500ms. Now eagerly snapshots bounds on first display-removed event.

### Session Restore

- [ ] Open two web pages (edges of screen) + settings (middle). Close app. Restart. All three restore with correct content and positions.
- [ ] Move windows to screen edges → restart → windows still on edges
- [ ] Session restore doesn't duplicate HUD/utility windows (no double dock bounce)

### Display Switching

- [ ] Unplug external display → windows move to laptop. Plug back in → windows return to external display.
- [ ] Switch between different-sized displays → windows reposition proportionally (not clustered in top-left)

## Window Dragging

Still completely broken after 4 rounds of fixes. Last attempt was full rewrite removing 5px movement threshold, 120ms unconditional hold, RAF-batched IPC.

- [ ] Cmd: long-press anywhere in visible bar → drag works
- [ ] Tags: long-press on item cards, tag buttons, non-text-input area → drag works, does NOT activate button
- [ ] Settings: long-press on nav items, labels, non-focused inputs → drag works
- [ ] Editor: long-press drag
- [ ] Fast cursor movement during drag doesn't drop the drag

## Command Palette — Frecency

- [ ] Type "ta" → ghost text adapts based on usage (frecency)
  - Prefix feedback loop removed in round 4, versioned adaptive data resets stale data
- [ ] Use "open tags" many times → type "ta" → adapts to suggest "open tags"

## HUD

Not tested since round 3 fixes.

- [ ] HUD only visible when Peek is focused, hides when switching to other app
- [ ] HUD is subtle/unobtrusive (50% opacity bg, muted text, no colored modes)
- [ ] HUD expands vertically to show all stats content

## Smoke Tests

- [ ] Groups: create new group via "+" button
  - Round 3: global keyboard handler early-returns when create-group input focused
- [ ] Tags: create tagset with "#foo #bar" — creates tagset type, not note
  - Round 3: tagset returns success message only (no editor open), favicon SVG fix

## Settings UI

- [ ] Settings labels layout: crammed on both sides around checkbox — needs consistent, readable layout across all panes (maybe dedicated peek-component set)
- [ ] Settings/profiles: selected profile should be on top, list sorted by last used

## Dark Mode

- [ ] Web pages respect OS color scheme (not forced dark)
  - nativeTheme.themeSource only set to 'dark' for 'force' mode, 'system' for everything else
  - Not tested yet — needs test steps

## Cmd Chaining (on hold — needs plan/spec)

- [ ] `list notes #tag` → `markdown` → `download` / `save as note` pipeline
- [ ] After tab-completing "list notes" and hitting space, "list groups notes" appears with "groups" not in bold
- [ ] List notes doesn't get whole list or item contents
- [ ] `open file` — native file picker, MIME detection, chaining support
