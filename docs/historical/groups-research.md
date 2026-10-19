# Groups: Making Workspaces Excellent

*Historical: a February 2026 roadmap for the groups feature; not current guidance.*

Status: **Roadmap** | Feb 2026

## Current Capabilities

Groups are promoted tags that serve as workspaces:

- **Group = promoted tag** — create from tags or cmd palette
- **Open group** — restores all URLs with saved window positions/z-order
- **Auto-tag** — new items created in group context are auto-tagged
- **Mode indicator** — "group: Name" badge on windows
- **Workspace persistence** — saves/restores window layouts per group
- **Keyboard nav** — vim keys, search, sort, view modes in Groups UI
- **Cmd palette** — `groups`, `open group <name>`, `new group <name>`
- **Reactive updates** — Groups UI updates on tag/item/sync events

## Roadmap

### Quick Wins

1. **Close/suspend group** — hide all group windows at once, restore later. Currently you can open but not close a group as a unit. Add `close group` cmd palette command that hides all windows in the group context.

2. **Group-scoped search** — search only within a group's items. When in group mode, search should default to filtering by the group's tag. Add a search scope indicator.

3. **Switch group** — close current group, open another in one command. `switch group <name>` = close current + open target. Smooth transition without manual cleanup.

4. **Pin items** — mark key URLs in a group as "pinned" so they always open first/prominently. Pinned items restore even if they weren't in the last workspace snapshot.

### Medium Effort

5. **Group dashboard** — each group gets a widget sheet showing its items, recent activity, notes. The widget sheet system (Phase 2+3) enables this. Auto-create a default sheet per group.

6. **Group scratchpad/notes** — quick notes attached to a group. Auto-tagged note in group context. Accessible via cmd palette (`group notes`) or keyboard shortcut.

7. **Group activity timeline** — what you did when, using item_events data. Show recent visits, items added/removed, time spent. Useful for daily standup or context switching.

### Bigger

8. **Focus mode** — when a group is active, only show group windows in window switcher, dim/hide others. Reduces distraction. Toggle via cmd palette or shortcut.

9. **Group-specific shortcuts** — mode-conditional keybindings per group. Different groups can have different shortcut sets. Uses the existing mode-conditional shortcut infrastructure.
