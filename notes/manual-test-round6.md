# Manual Test Checklist — Round 6

Consolidated from rounds 2-5. Only open/unaddressed items carried over.

## BLOCKING: Session Restore + Window Positioning

Full review needed — these interact and compound each other.

- [ ] Session restore restores wrong window content: open two web pages (one on each side edge) + settings in middle. Close app. Restart. All positioned correctly BUT settings window now shows a duplicate of the left-edge page instead of settings.
- [ ] Session restore loses edge positions: windows moved to screen edges aren't on edges after restore
  - suppressDisplayRepositioning() added in round 5 but still broken
- [ ] Display switching: unplug external display, plug back in — windows stay on laptop instead of returning to external
  - Home display tracking added in round 5 (saves display ID + relative position, matches on re-add) but still broken
- [ ] Display switching: windows cluster in top-left when switching between different-sized displays
  - Three iterations so far (ratio mapping → group scaling → home tracking), none fully working

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
