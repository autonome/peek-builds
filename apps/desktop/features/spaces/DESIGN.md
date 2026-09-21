# Spaces Feature Design

## Overview

Split the current groups feature into two separate features:
- **Groups**: simplified tag browser (tags == groups, no promote/demote)
- **Spaces**: full workspace experience (mode context, border, auto-tagging, session management)

## Status: DRAFT — iterating on design

---

## Core Directive: Lean Backend

The backend must contain NO space-specific logic. All space behavior lives in the feature layer (`features/spaces/`). The backend provides only generic primitives: context API, pubsub, datastore, window management.

---

## Data Model: Machine Tags

### Space identity

A space is identified by a tag with a `space:` prefix (machine tag):
- `space:research`, `space:work`, `space:side-project`

No new tables. No separate registry. Tags are the building block. The `isGroup` metadata flag is removed entirely.

### Space membership

All contents of a space are tagged with the space's machine tag. A URL tagged with `space:research` belongs to the research space. An item can belong to multiple spaces.

Users can manually add/remove the tag on any platform (e.g., tag on mobile, see in space on desktop).

### Space metadata

Stored in the tag's `metadata` JSON field:
```json
{
  "color": "#ff6b6b",
  "displayName": "Research",
  "description": "Papers and references"
}
```

`displayName` is the human-friendly name. If absent, strip the `space:` prefix for display.

### Content types

Spaces can contain any addressable content:
- URLs (web pages)
- Notes
- `peek://` addresses (search views for tag combos, editor, etc.)
- Images/videos (future)

### Groups vs Spaces

| Aspect | Regular tag (group) | Space tag (`space:*`) |
|--------|--------------------|-----------------------|
| Prefix | None | `space:` |
| Browsing | Groups UI shows items | Groups UI shows items (same) |
| Workspace mode | No | Yes — mode indicator, auto-tagging, screen border |
| Auto-tagging | No | New items created while in space get tagged |
| Load behavior | N/A | Load-on-access — items open when user clicks them |
| Session management | No | Close/restore hides/shows open windows |
| Content types | URLs | URLs, notes, peek:// addresses, media (future) |

---

## Groups Feature (simplified: tags == groups)

Every tag is a group. Every group is a tag.

### Changes
- Remove `isGroupTag()`, `promoteTagToGroup()`, promoted/unpromoted split
- `renderGroups()` shows ALL tags (plus untagged pseudo-group)
- Remove promote buttons, "All Tags" toggle section
- Remove all workspace commands and mode context calls
- `open group <name>` navigates groups UI to detail view (no workspace activation)
- Groups is purely a data browser — no mode context

### Files: 4 modified
- `features/groups/home.js` — remove promote/demote, merge all tags, strip mode calls
- `features/groups/background.js` — remove workspace logic, keep tag CRUD and noun
- `features/groups/manifest.json` — remove workspace commands
- `features/groups/home.css` — remove promote/unpromoted styles

---

## Spaces Feature (workspace)

### Mental model
"I enter a space to focus on a project. Everything I do is part of that space until I leave. Items load when I access them."

### Load-on-access pattern
`open space` does NOT open all tagged items as windows. It:
1. Activates space mode (border, auto-tagging context)
2. Opens the spaces home UI (`peek://ext/spaces/home.html`) showing the space's items
3. Items open as windows when the user clicks them, in space mode

This means a space with 50 items doesn't spawn 50 windows. The user browses and opens what they need.

### Commands
| Command | What it does |
|---------|-------------|
| `open space <name>` | Restores the space as you left it (windows, positions). If never opened before, shows spaces home UI. Activates space mode. |
| `close space` | Saves current window state (which windows, positions), deactivates space mode |
| `switch space <name>` | Closes current space, opens target |

### Spaces home UI
Spaces has its own home UI (`features/spaces/home.html`), initially forked from groups home. This will diverge quickly — spaces UI will gain workspace-specific affordances (space settings, member management, layout controls) that don't belong in the simple groups tag browser.

### Page host space widget
The group-mode widget in `app/page/page.js` becomes the **space widget**. Reacts to `currentMode === 'space'`. Shows space name, color dot, ESC-to-close behavior.

---

## What Lives Where

### Feature layer (`features/spaces/background.js`) — ALL space logic

**Auto-tagging**: Subscribe to `item:created` (enriched with `windowId`). Check originating window's mode via `api.context.get('mode', windowId)`. If mode is `'space'`, tag item with space tag.

**Screen border**: Feature-owned overlay window via `api.window.open()` with special options. Subscribes to `window:focused`, `window:closed`, `context:changed`, `app:focus-changed`. Owns debounce logic, color resolution, label rendering.

**Tag removal reset**: Subscribe to `tag:item-removed`. If removed tag matches active space, reset window mode to `'page'`.

**Session management**: `close space` hides windows + saves positions. `restore space` re-shows them. No "open everything" pattern.

### Backend — ONLY generic primitives

- **Context API**: `setMode`, `getContextEntry`, `getWindowsMatchingContext`. No space awareness.
- **Mode inheritance**: Generic — inherits opener's mode if `metadata.inherit !== false`. Not space-specific.
- **`item:created` with `windowId`**: Generic enrichment, 6 call sites.
- **Window primitives**: `setIgnoreMouseEvents()`, `setVisibleOnAllWorkspaces()`, `getPrimaryDisplay()`.
- **`detectModeFromUrl`**: Just `http(s) → 'page'`, else `'default'`.

### Removed from backend (~250 lines from ipc.ts)
- `autoTagIfGroupMode()` and all 6 inline auto-tag call sites
- All screen border functions and variables
- `VIVID_GROUP_COLORS`, `resolveGroupBorderColor`
- Border-related pubsub subscriptions in `registerModesHandlers()`
- `tag:item-removed` mode reset subscription
- `cleanupGroupScreenBorder()` from quit handler

---

## Naming Renames

### 1. `extension_settings` → `feature_settings`

SQL migration: `ALTER TABLE extension_settings RENAME TO feature_settings`, rename `extensionId` → `featureId`.

~15 files. The `api.settings.*` methods (`get`, `set`, `getKey`) don't contain "extension" so 30+ feature files need no changes — only IPC transport layer and SQL.

### 2. Backend mode: `group` → `space`

~10 files, ~200 mechanical changes. Mode value, metadata fields (`spaceId`, `spaceName`), IPC names, preload methods, page host widget CSS, test file rename.

### 3. Storage keys
- `group-workspaces` → `spaces`

---

## Implementation Phases

### Phase 1: Naming renames (foundation)
- 1a: `extension_settings` → `feature_settings` (~15 files + SQL migration)
- 1b: Backend `group` → `space` (~10 files, ~200 changes)
- 1c: Storage key renames (~4 files)

### Phase 2: Backend generic enrichments
- Add `windowId` to `item:created` payloads (6 sites)
- Expose `setIgnoreMouseEvents`, `setVisibleOnAllWorkspaces`, `getPrimaryDisplay` in preload
- Generalize mode inheritance to use `inherit` metadata flag

### Phase 3a: Create spaces feature (parallel with 3b)
- `features/spaces/` — manifest, config, background, home.html, home.js, home.css
- Home UI forked from groups (will diverge)
- Machine tag resolution (`space:` prefix)
- Auto-tagging via `item:created` subscription
- Screen border as feature-owned window
- Session management (close/restore window positions)

### Phase 3b: Strip backend space logic (parallel with 3a)
- Remove ~250 lines from `ipc.ts`
- Remove quit handler cleanup
- Simplify `detectModeFromUrl`

### Phase 4: Simplify groups (parallel with 3)
- Tags == groups, remove promote/demote
- Strip mode context from home.js
- ~4 files

### Phase 5: Integration
- "Open as space" action on group cards (creates `space:` tag, opens spaces home)
- Page host widget rename (CSS classes)
- Test updates

---

## The Default Workspace

Every workspace is named, and there is one named default workspace: what is open when no other
workspace is active. It is a real space — a `space:default` tag plus its own saved window
session, written and read through the exact same `space-workspaces` row (`workspace:<tagId>`)
every named workspace uses — not an implicit "no space" state layered on top of the mechanism
above. `features/spaces/background.js` resolves it once per profile through the same
`getOrCreateTag()` every other space goes through; nothing about the default lives in a separate
table or a separate code path.

Display name: the tag strips to `"default"` the same way any space tag with no `displayName`
metadata does — no special-cased label.

### First launch

The very first time `getOrCreateTag('space:default')` creates the tag (`created: true` in its
result — the same signal `main/onboarding-seed.ts` uses for its own once-per-profile sentinel,
though this one rides the tag's own creation rather than a separate row), whatever windows a
general session restore already opened before this feature ran become the default workspace's
membership from that moment on: `adoptOpenWindowsIntoDefault()` walks `api.window.list()` and
tags anything with no mode of its own **and role `'content'`** into `space:default` — the same
role `features/windows/windows.js loadWindows()` uses to tell user content from dedicated chrome
(palette, overlays, switcher, workspace panel) and background pages, so nothing skips by matching
a URL substring. Every later launch skips adoption — the default workspace's membership from then
on is whatever was tagged into it explicitly, the same as any other space.

### Enter and exit

`enterWorkspace(tag, name)` is the one function that makes a workspace — named or default — the
active one: restore its saved session if it has one, otherwise open one new empty group (a single
window) to start from. The default is the one exception to the empty-group fallback: an empty
default is genuinely empty, since it is what is left when nothing else is active rather than a
workspace being entered for the first time. The default also shows no border and no workspace
panel — chrome that announces "you are in a workspace" would be backwards for the state that
means the opposite.

`openSpace(name)` — "entering" — first calls `closeCurrentWorkspaceWindows()` on whatever
workspace is active now, the default included, saving and closing its windows (skipping any
window pinned across every workspace), then calls `enterWorkspace()` on the target. `switchSpace()`
is now a thin wrapper over `openSpace()`: entering already closes the outgoing workspace, so
"switching" and "opening while something else is active" are the same operation.

`closeSpace()` — "leaving" — is `openSpace('default')` with a guard: leaving when the default is
already active is an error (nothing to leave), the same as the old "no active space" error before
a default existed at all. Leaving does not keep the workspace panel; entering a named workspace
from another named workspace does, so the panel only closes when there is no longer any workspace
to name.

A window pinned across every workspace is never touched by either direction — it is not scoped to
one workspace's membership in the first place. A window pinned to one workspace closes with it and
comes back, pinned, from that workspace's own saved row, exactly like an unpinned window in the
same space.

### External links

A URL from another app — macOS `open-url`, the Windows/Linux second-instance handoff, a CLI arg,
or `peek-cli open-url` — always opens into `space:default`, whichever workspace is active, and
without leaving that workspace: it does not call `openSpace('default')`, which would save-and-close
whatever the user is in the middle of just because a link arrived from outside it. All of these
sources funnel through one place, `main/main.ts handleExternalUrl()` → the `external:open-url`
pubsub event → `renderer/index.js`'s subscriber, which is where the window actually gets opened.

That subscriber resolves `space:default` itself (`api.datastore.getOrCreateTag('space:default')`,
the same generic tag primitive `features/spaces/background.js bootstrapDefaultSpace()` uses to
create it) and passes the result as the window's explicit `spaceMode` option, tagging the window
into the default at the moment it opens — the same mechanism `enterWorkspace()` uses to restore a
saved workspace's windows into their space. This runs in core rather than being left to the spaces
feature to tag after the fact: that feature loads lazily (`manifest.json`'s background tile), woken
only by its own commands (`open space` / `close space` / `switch space` / the pin commands), so a
link arriving before the user has ever touched a workspace command would reach a spaces feature
that isn't running yet. Core's background window is never lazy, so resolving the tag itself removes
that race entirely, at the cost of core knowing one space-specific fact (the tag name
`space:default`) that would otherwise live only in the feature layer — a deliberate trade of a
single literal for correctness on a cold start.

Passing `spaceMode` only works because `main/ipc.ts`'s window-open handler now honors it on both
window-host implementations it has: the plain `BrowserWindow` branch already read
`options.spaceMode`, but the hybrid page-host branch — which is what actually serves every
http/https/file content URL (`usePageHost`, decided by URL scheme) — silently dropped it. Since
external links are ordinary web URLs, they went through the exact branch where `spaceMode` didn't
work; the hybrid branch now sets the same `mode` context entry the plain branch does when the
option is present. This also fixes `spaceMode` for any other caller restoring a real web-page URL
into a workspace (`enterWorkspace()`'s saved-session restore, for one) — previously silent for any
saved window whose URL was a real web page rather than a `peek://` tile.

---

## Open Questions

- Mode inheritance opt-in (`inherit: true`) vs opt-out? Recommend opt-in.
- ESC behavior when space tag removed from page?
- Multi-monitor border? (future)
- Space extensibility/theming/personalization APIs? (future)
- How should tag combos auto-import into spaces? (future)
- Search views as space members (e.g., "all items tagged X+Y") — what's the item representation?

---

## Specification

Testable requirements for the Spaces feature. Each item follows the form WHEN [trigger], THEN [expected result].

The mode value is `'space'` (replacing `'group'`). Metadata fields use `spaceId` and `spaceName`.

### 1. Space Identity and Data Model

**1.1** WHEN a tag is created with name `space:research`, THEN it is discoverable by querying tags with the `space:` prefix.

**1.2** WHEN a space tag has metadata `{"displayName": "Work"}`, THEN display name resolves to `"Work"`.

**1.3** WHEN a space tag has no `displayName` in metadata, THEN display name is derived by stripping the `space:` prefix.

**1.4** WHEN an item is tagged with `space:research`, THEN it is a member of the research space.

**1.5** WHEN an item is tagged with both `space:research` and `space:work`, THEN it belongs to both spaces.

**1.6** WHEN querying for spaces, THEN only tags starting with exactly `space:` match (not `spaceship` or `myspace:foo`).

### 2. `open space` Command

**2.1** WHEN `open space <name>` is executed with no saved state, THEN the spaces home UI opens showing the space's tagged items.

**2.2** WHEN `open space <name>` is executed with saved state (URLs + positions), THEN the saved windows are restored at their saved positions.

**2.3** WHEN windows are restored by `open space`, THEN each has `context.mode = 'space'` with `spaceId` and `spaceName`.

**2.4** WHEN `open space` executes, THEN the screen border becomes visible with the space's color and name.

**2.5** WHEN `open space` executes, THEN auto-tagging activates for space-mode windows.

**2.6** WHEN `open space` executes for a space with 50 tagged items and no saved state, THEN exactly one window opens (spaces home UI), not 50.

### 3. `close space` Command

**3.1** WHEN `close space` is executed, THEN current window state (URLs, positions, sizes) is saved.

**3.2** WHEN `close space` is executed, THEN all space-mode windows for the active space are closed.

**3.3** WHEN `close space` is executed, THEN space mode is deactivated on all affected windows.

**3.4** WHEN `close space` is executed, THEN the screen border is hidden.

**3.5** WHEN `close space` is executed, THEN the spaces home window is also closed.

### 4. `switch space` Command

**4.1** WHEN `switch space <target>` is executed, THEN the current space is closed (equivalent to `close space`).

**4.2** WHEN `switch space <target>` is executed, THEN the target space is opened (equivalent to `open space <target>`).

**4.3** WHEN `switch space` completes, THEN the border color and label reflect the target space.

### 5. Auto-tagging

**5.1** WHEN a new item is created from a space-mode window, THEN it is tagged with the space's tag.

**5.2** WHEN a new item is created from a non-space window, THEN it is NOT tagged, even if space windows exist elsewhere.

**5.3** WHEN a new item is created from the cmd palette, THEN it is NOT auto-tagged (cmd palette has no space mode context).

**5.4** WHEN a new item is created from an external app, THEN it is NOT auto-tagged.

**5.5** WHEN auto-tagging fires, THEN a `tag:item-added` event is published for reactive UI updates.

### 6. Screen Border

**6.1** WHEN focused window has `context.mode = 'space'`, THEN border is visible with space color and name.

**6.2** WHEN focused window has mode `'page'` or `'default'`, THEN border is hidden (debounced).

**6.3** WHEN no window is focused, THEN border is hidden.

**6.4** WHEN focused window is destroyed, THEN border is hidden.

**6.5** WHEN app loses OS focus, THEN border is hidden.

**6.6** WHEN app regains OS focus, THEN border state is re-evaluated from focused window's mode.

**6.7** WHEN a modal window (cmd palette) gains focus while border was visible, THEN border remains visible (modals are transparent).

**6.8** WHEN a modal window gains focus while border was hidden, THEN border remains hidden.

**6.9** WHEN border would hide, THEN a 600ms debounce applies; cancelled if a space-mode window regains focus.

**6.10** WHEN border would show, THEN it appears immediately (no delay).

**6.11** WHEN focus switches from space A to space B, THEN border color and label update immediately.

**6.12** WHEN space color has chroma ≤ 40, THEN a vivid fallback is selected deterministically from palette.

**6.13** WHEN space color has chroma > 40, THEN the actual color is used.

### 7. Mode Inheritance

**7.1** WHEN a window is opened from a space-mode window, THEN it inherits space mode with the same metadata.

**7.2** WHEN a window is opened with explicit `spaceMode` option, THEN it receives that mode regardless of opener.

**7.3** WHEN a window is opened from a non-space window with no `spaceMode` option, THEN it does NOT get space mode.

**7.4** WHEN a window is opened with no opener and no `spaceMode`, THEN it does NOT get space mode (no lastFocusedVisible fallback).

**7.5** WHEN explicit `spaceMode` option AND opener space mode conflict, THEN explicit option wins.

**7.6** WHEN a popup is spawned from a space-mode page, THEN the popup inherits space mode.

### 8. Page Host Space Widget

**8.1** WHEN page has `context.mode = 'space'`, THEN space widget is visible with name and color dot.

**8.2** WHEN page has mode `'page'` or `'default'`, THEN space widget is hidden.

**8.3** WHEN ESC is pressed on a space-mode page, THEN the window closes.

### 9. Tag Removal and Mode Reset

**9.1** WHEN a space tag is removed from an item AND a matching space-mode window displays that URL, THEN that window's mode resets to `'page'`.

**9.2** WHEN a removed tag doesn't match any window's `spaceId`, THEN no windows are affected.

**9.3** WHEN a removed tag matches `spaceId` but the item URL doesn't match any window URL (after normalization), THEN no windows are affected.

**9.4** WHEN URLs are compared for tag-removal matching, THEN trailing slashes, default ports, and query param order are normalized.

**9.5** WHEN a window resets from space to page mode, THEN the border re-evaluates and hides if needed.

### 10. Groups Feature (Simplified)

**10.1** WHEN groups home opens, THEN ALL tags are displayed (no promoted/unpromoted distinction).

**10.2** WHEN a group card is clicked, THEN groups UI shows the tag's items. No mode context is set.

**10.3** WHEN viewing a group detail, THEN window mode stays `'default'`.

**10.4** WHEN viewing a group detail, THEN no screen border appears.

**10.5** WHEN "Open as space" is triggered on a group, THEN a `space:` tag is created and `open space` executes.

### 11. Spaces Home UI

**11.1** WHEN spaces home opens, THEN it loads at `peek://ext/spaces/home.html`.

**11.2** WHEN spaces home is active, THEN its window has `context.mode = 'space'`.

**11.3** WHEN items are added/removed from the space tag, THEN spaces home updates reactively.

**11.4** WHEN a user clicks an item in spaces home, THEN a window opens with space mode.

**11.5** WHEN a user clicks an item already open, THEN the existing window is focused (not duplicated).

### 12. Backend Boundary

**12.1** WHEN backend `ipc.ts` is inspected, THEN it contains NO space-specific functions or variables.

**12.2** WHEN backend emits `item:created`, THEN payload includes `windowId`.

**12.3** WHEN `detectModeFromUrl` is called, THEN it returns only `'page'` (http/s) or `'default'`. Never `'space'`.

**12.4** WHEN mode inheritance runs in the window-open handler, THEN it uses a generic `inherit` metadata flag, not space-specific logic.
