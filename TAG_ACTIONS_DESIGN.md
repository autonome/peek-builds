# Tag Actions Extension — Design Document

## 1. Concept

Tag Actions is a new desktop extension that lets users define custom behaviors triggered by tagging items. Each "tag action" binds a tag (or tag pair) to an action — when an item receives that tag, the action fires. This replaces hardcoded tag-based features (like a future "offline" tag triggering content fetch) with a generic, user-configurable system.

**Examples of tag actions a user could create:**
- Tag `offline` triggers: fetch and cache page content for offline reading
- Tag `archive` triggers: submit URL to the Wayback Machine
- Tag `read-later` shows: an eyeball icon on items in list views
- Tag `important` shows: a star/flag icon on items
- Tag `summarize` triggers: run a script that summarizes the page content

---

## 2. Extension Structure

### File Layout

```
extensions/tag-actions/
  manifest.json           # Extension metadata, commands, shortcuts
  background.html         # Entry point (loads background.js as ES module)
  background.js           # Core logic: event listeners, action execution
  home.html               # Settings/management UI
  home.js                 # Settings UI logic
  home.css                # Settings UI styles
  settings-schema.json    # Schema for extension settings (tag action configs)
```

### manifest.json

```json
{
  "id": "tag-actions",
  "shortname": "tag-actions",
  "name": "Tag Actions",
  "description": "Define custom actions triggered by tags",
  "version": "1.0.0",
  "background": "background.html",
  "builtin": true,
  "settingsSchema": "./settings-schema.json",
  "commands": [
    {
      "name": "open tag actions",
      "description": "Open the tag actions manager",
      "action": {
        "type": "window",
        "url": "peek://ext/tag-actions/home.html",
        "options": {
          "role": "workspace",
          "key": "tag-actions-home",
          "width": 800,
          "height": 600,
          "title": "Tag Actions"
        }
      }
    }
  ],
  "shortcuts": [
    {
      "keys": "Option+Shift+T",
      "command": "open tag actions",
      "global": true
    }
  ]
}
```

### background.html

Standard extension entry point pattern:

```html
<!DOCTYPE html>
<html>
<head>
  <script type="module" src="./background.js"></script>
</head>
<body></body>
</html>
```

---

## 3. Data Model

### Storage Location

Tag action configurations are stored in `extension_settings` via `api.settings` (the standard extension settings API). This is the same pattern used by scripts, sheets, and other extensions.

Key: `actions` (JSON array of action configs)

### Tag Action Config Schema

```json
{
  "actions": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "id":          { "type": "string", "description": "Unique ID (generated)" },
        "name":        { "type": "string", "description": "User-facing label" },
        "enabled":     { "type": "boolean", "default": true },
        "triggerTag":  { "type": "string", "description": "Tag name that triggers this action" },
        "filterTag":   { "type": "string", "description": "Optional second tag required (AND logic)" },
        "triggerOn":   { "type": "string", "enum": ["add", "remove", "both"], "default": "add" },
        "actionType":  { "type": "string", "enum": ["icon", "script", "publish", "open-url", "tag"] },
        "actionConfig": { "type": "object", "description": "Action-type-specific configuration" },
        "itemTypes":   { "type": "array", "items": { "type": "string" }, "description": "Optional filter: only trigger for these item types (url, text, tagset, etc.)" },
        "createdAt":   { "type": "number" },
        "updatedAt":   { "type": "number" }
      }
    }
  }
}
```

### settings-schema.json

```json
{
  "labels": {
    "prefs": {
      "autoExecute": "Auto-execute actions on tag add"
    }
  },
  "prefs": {
    "type": "object",
    "properties": {
      "autoExecute": {
        "type": "boolean",
        "description": "Automatically execute actions when tags are added (vs. manual trigger only)",
        "default": true
      }
    }
  },
  "storageKeys": {
    "PREFS": "prefs",
    "ACTIONS": "actions"
  },
  "defaults": {
    "prefs": {
      "autoExecute": true
    },
    "actions": []
  }
}
```

### Example Stored Actions

```json
[
  {
    "id": "ta_1708000000_abc123",
    "name": "Offline Reading",
    "enabled": true,
    "triggerTag": "offline",
    "filterTag": null,
    "triggerOn": "add",
    "actionType": "publish",
    "actionConfig": {
      "topic": "content:fetch-offline",
      "includeItemData": true
    },
    "itemTypes": ["url"],
    "createdAt": 1708000000000,
    "updatedAt": 1708000000000
  },
  {
    "id": "ta_1708000001_def456",
    "name": "Show Read-Later Icon",
    "enabled": true,
    "triggerTag": "read-later",
    "filterTag": null,
    "triggerOn": "add",
    "actionType": "icon",
    "actionConfig": {
      "icon": "eye",
      "color": "#4a9eff",
      "tooltip": "Read later"
    },
    "itemTypes": null,
    "createdAt": 1708000001000,
    "updatedAt": 1708000001000
  },
  {
    "id": "ta_1708000002_ghi789",
    "name": "Archive to Wayback",
    "enabled": true,
    "triggerTag": "archive",
    "filterTag": null,
    "triggerOn": "add",
    "actionType": "open-url",
    "actionConfig": {
      "urlTemplate": "https://web.archive.org/save/{url}",
      "openInBackground": true
    },
    "itemTypes": ["url"],
    "createdAt": 1708000002000,
    "updatedAt": 1708000002000
  }
]
```

---

## 4. Settings UI (home.js)

The settings UI follows the pattern established by groups (home.js) and tags (home.js) — a single-page app with list and detail views, using peek-components.

### UI Structure

```
+-------------------------------------------------------+
| Tag Actions                              [+ New Action] |
+-------------------------------------------------------+
| Search actions...                                      |
+-------------------------------------------------------+
|                                                        |
|  [x] Offline Reading          offline -> fetch content |
|  [x] Read-Later Icon          read-later -> eye icon   |
|  [ ] Archive to Wayback       archive -> open URL      |
|  [x] Run Summarizer           summarize -> run script  |
|                                                        |
+-------------------------------------------------------+
```

### Create/Edit Form

When clicking an action or the [+ New Action] button:

```
+-------------------------------------------------------+
| < Back                                                 |
+-------------------------------------------------------+
| Name:     [  Offline Reading                        ]  |
| Enabled:  [x]                                          |
|                                                        |
| --- Trigger ---                                        |
| Tag:      [ offline         ] (autocomplete from tags) |
| Also requires tag: [            ] (optional AND tag)   |
| Trigger on: ( ) Tag added  ( ) Tag removed  ( ) Both  |
| Item types: [x] URL [ ] Text [ ] Tagset [ ] Image     |
|                                                        |
| --- Action ---                                         |
| Type: [v Publish Event      ]                          |
|                                                        |
| (Type-specific config form appears here)               |
| Topic: [ content:fetch-offline ]                       |
| Include item data: [x]                                 |
|                                                        |
| [Delete Action]                         [Save Action]  |
+-------------------------------------------------------+
```

### Action Type Config Forms

Each action type shows a different config sub-form:

**Icon** — purely visual, no code execution:
- Icon picker (predefined set: eye, star, flag, bookmark, download, archive, clock, check)
- Color picker
- Tooltip text

**Publish** — fires a pubsub event (for other extensions to handle):
- Topic name (string)
- Include item data in payload (boolean)

**Script** — runs an existing user script:
- Script picker (dropdown of scripts from the scripts extension)

**Open URL** — opens a URL template:
- URL template with `{url}`, `{title}`, `{id}` placeholders
- Open in background (boolean)

**Tag** — adds another tag to the item:
- Tag name to add (autocomplete)

### Implementation Notes

- Use `api.datastore.getTagsByFrecency()` to populate tag autocomplete in the trigger field
- Use peek-components (peek-card, peek-input, peek-button, peek-switch, peek-select) per DEVELOPMENT.md guidelines
- Follow the escape handler pattern from groups/tags home.js (list view -> detail view -> back on ESC)
- Persist view state in localStorage (following existing pattern)

---

## 5. Event Flow

### How Tag Additions Trigger Actions

```
User tags item (via cmd, tags UI, groups, sync, etc.)
    |
    v
Backend IPC handler: datastore-tag-item
    |
    v
Backend publishes: tag:item-added { tagId, tagName, itemId, itemType }
    |
    v
tag-actions background.js receives event via api.subscribe('tag:item-added', ...)
    |
    v
Looks up matching actions: actions.filter(a => a.triggerTag === msg.tagName && a.enabled)
    |
    v
For each matching action:
  - Check itemTypes filter (if specified)
  - Check filterTag (if specified, verify item also has this second tag)
  - Execute action based on actionType
```

### background.js Core Logic (Pseudocode)

```javascript
// On init:
api.subscribe('tag:item-added', async (msg) => {
  await handleTagEvent('add', msg);
}, api.scopes.GLOBAL);

api.subscribe('tag:item-removed', async (msg) => {
  await handleTagEvent('remove', msg);
}, api.scopes.GLOBAL);

async function handleTagEvent(eventType, msg) {
  const settings = await api.settings.get();
  const actions = settings.data?.actions || [];

  for (const action of actions) {
    if (!action.enabled) continue;
    if (action.triggerTag !== msg.tagName) continue;
    if (action.triggerOn !== 'both' && action.triggerOn !== eventType) continue;

    // Item type filter
    if (action.itemTypes?.length > 0 && !action.itemTypes.includes(msg.itemType)) continue;

    // Second tag filter (AND logic)
    if (action.filterTag) {
      const itemTags = await api.datastore.getItemTags(msg.itemId);
      if (!itemTags.data?.some(t => t.name === action.filterTag)) continue;
    }

    await executeAction(action, msg);
  }
}

async function executeAction(action, msg) {
  switch (action.actionType) {
    case 'icon':
      // Icons are handled at render time by the item list, not here.
      // Publish an event so list UIs can refresh icon state.
      api.publish('tag-actions:icon-changed', { itemId: msg.itemId }, api.scopes.GLOBAL);
      break;

    case 'publish':
      api.publish(action.actionConfig.topic, {
        itemId: msg.itemId,
        tagName: msg.tagName,
        ...(action.actionConfig.includeItemData ? await getItemData(msg.itemId) : {})
      }, api.scopes.GLOBAL);
      break;

    case 'script':
      api.publish('scripts:execute', {
        scriptId: action.actionConfig.scriptId,
        context: { itemId: msg.itemId, url: msg.itemUrl }
      }, api.scopes.GLOBAL);
      break;

    case 'open-url': {
      const item = await api.datastore.getItem(msg.itemId);
      const url = action.actionConfig.urlTemplate
        .replace('{url}', encodeURIComponent(item.data?.content || ''))
        .replace('{title}', encodeURIComponent(item.data?.title || ''))
        .replace('{id}', msg.itemId);
      api.window.open(url, {
        role: 'content',
        width: 800,
        height: 600
      });
      break;
    }

    case 'tag': {
      const tagResult = await api.datastore.getOrCreateTag(action.actionConfig.addTagName);
      if (tagResult.success) {
        await api.datastore.tagItem(msg.itemId, tagResult.data.tag.id);
      }
      break;
    }
  }
}
```

### Event Ordering Guarantee

The `tag:item-added` event is published synchronously within the IPC handler after the database write completes. The tag-actions extension receives this event in its background.js process. Actions execute asynchronously but are guaranteed to see the tag already persisted in the database.

---

## 6. Item List Integration (Icons/Badges)

### Problem

The tags home.js and groups home.js render item cards. Tag Actions needs to show icons/badges on items that match `icon`-type tag actions. But those UIs are in separate extensions.

### Approach: Pubsub Query Protocol

The tag-actions extension exposes a pubsub-based query API that any item list UI can use:

```javascript
// In tag-actions background.js:
api.subscribe('tag-actions:get-icons', async (msg) => {
  // msg.itemId or msg.itemIds (batch)
  // Returns matching icon configs for items based on their tags
  const icons = await computeIconsForItems(msg.itemIds);
  api.publish('tag-actions:icons-response', { icons }, api.scopes.GLOBAL);
}, api.scopes.GLOBAL);
```

**How it works:**

1. Tag-actions maintains an in-memory index: `tagName -> [icon configs]`
2. When tags home.js renders a card, it can query `tag-actions:get-icons` with the item's tag list
3. The response contains icon configs: `{ itemId: [{ icon: 'eye', color: '#4a9eff', tooltip: 'Read later' }] }`
4. The calling UI renders small SVG icons in the card

### Alternative: CSS Custom Properties + Data Attributes

A simpler approach that avoids cross-extension queries:

1. Tag-actions publishes `tag-actions:icon-rules` on init with the current icon action configs
2. Other UIs listen and store the rules locally
3. When rendering cards, check item tags against rules and render icons inline

This is simpler and avoids async round-trips during render.

### Recommended Approach

Use the CSS/data-attribute approach (alternative above) for v1. It avoids pubsub latency during card rendering and is simpler to implement. The icon rules are small (usually <10 entries) and rarely change.

```javascript
// Tag-actions publishes rules on init and on change:
api.publish('tag-actions:icon-rules', {
  rules: [
    { tag: 'read-later', icon: 'eye', color: '#4a9eff', tooltip: 'Read later' },
    { tag: 'important', icon: 'star', color: '#ffd700', tooltip: 'Important' }
  ]
}, api.scopes.GLOBAL);

// Tags home.js / groups home.js subscribe:
api.subscribe('tag-actions:icon-rules', (msg) => {
  iconRules = msg.rules;
  // Re-render if currently visible
}, api.scopes.GLOBAL);

// During card rendering, check:
const itemTags = state.itemTags.get(item.id) || [];
const icons = iconRules.filter(rule => itemTags.some(t => t.name === rule.tag));
// Render small SVG icons next to the card title
```

---

## 7. Action Types — Initial Set

### 7.1 Icon (Visual Only)

**Purpose:** Show a visual indicator on items with the trigger tag.

**Config:**
- `icon`: One of a predefined set (`eye`, `star`, `flag`, `bookmark`, `download`, `archive`, `clock`, `check`, `heart`, `pin`)
- `color`: Hex color string
- `tooltip`: Hover text

**Execution:** No runtime action. The icon rules are broadcast via pubsub and rendered by item list UIs.

### 7.2 Publish Event

**Purpose:** Fire a pubsub event for other extensions to handle. This is the generic hook for arbitrary integrations.

**Config:**
- `topic`: Pubsub topic name (string)
- `includeItemData`: Whether to include full item data in the payload (boolean)

**Execution:** `api.publish(topic, payload, api.scopes.GLOBAL)`

**Use cases:**
- `content:fetch-offline` could be handled by a future offline extension
- `reader:open` could trigger a reader mode view
- Custom inter-extension communication

### 7.3 Run Script

**Purpose:** Execute an existing user script from the scripts extension.

**Config:**
- `scriptId`: ID of the script to run

**Execution:** Publishes `scripts:execute` with the script ID and item context.

### 7.4 Open URL

**Purpose:** Open a URL template, substituting item data.

**Config:**
- `urlTemplate`: URL with `{url}`, `{title}`, `{id}` placeholders
- `openInBackground`: Whether to focus the new window (boolean)

**Execution:** Substitutes placeholders and calls `api.window.open()`.

**Use cases:**
- Archive to Wayback Machine: `https://web.archive.org/save/{url}`
- Search for related content: `https://www.google.com/search?q={title}`
- Open in a specific service: `https://getpocket.com/save?url={url}`

### 7.5 Add Tag

**Purpose:** Automatically add another tag when the trigger tag is applied.

**Config:**
- `addTagName`: Name of the tag to add

**Execution:** Calls `api.datastore.getOrCreateTag()` then `api.datastore.tagItem()`.

**Use cases:**
- Tag `work-project` auto-adds `work` parent tag
- Tag `recipe` auto-adds `food` category tag

**Guard:** Must check for circular triggers (tag A adds tag B which triggers an action that adds tag A). Implement a per-event execution set to prevent re-entry.

---

## 8. Migration Path

### Current Hardcoded Tag-Based Features

Currently there are no fully-implemented tag-based action systems in the desktop app. The mobile app (`backend/tauri-mobile/src-tauri/src/lib.rs`) has some offline-related code, but desktop does not. This means:

1. **No migration needed for v1.** The tag-actions extension is purely additive.
2. **Future offline reading feature** should be built as a separate extension that listens for a `content:fetch-offline` pubsub event, rather than hardcoding the tag name. Then a default tag action can bridge `offline` tag -> `content:fetch-offline` event.
3. **Groups extension** already uses tag metadata (`isGroup: true`) to distinguish group-tags from regular tags. Tag-actions should not conflict — it operates on a different dimension (what happens when a tag is applied, not what the tag IS).

### Recommended Migration Strategy for Future Features

When building new tag-triggered features:

1. Build the feature as a standalone extension that listens for a pubsub event
2. Create a default tag action (shipped as a preset, not hardcoded) that maps the tag to the event
3. Users can disable, reconfigure, or replace the default tag action

This keeps features decoupled — the offline extension does not need to know about tags, and the tags system does not need to know about offline reading.

### Shipping Default Actions

The extension should include a set of suggested/default actions that users can enable:

```javascript
const PRESET_ACTIONS = [
  {
    name: 'Read Later Icon',
    triggerTag: 'read-later',
    actionType: 'icon',
    actionConfig: { icon: 'eye', color: '#4a9eff', tooltip: 'Read later' }
  },
  {
    name: 'Archive to Wayback Machine',
    triggerTag: 'archive',
    actionType: 'open-url',
    actionConfig: { urlTemplate: 'https://web.archive.org/save/{url}', openInBackground: true },
    itemTypes: ['url']
  }
];
```

On first run (no stored actions), the home.js UI could show these as "suggested actions" the user can add with one click.

---

## 9. Open Questions

### For User Input

1. **Should icon-type actions be toggleable in item lists?** E.g., clicking the eye icon could remove the `read-later` tag (acting as a checkbox). Or should icons be purely visual?

2. **Should tag actions support conditions beyond tag matching?** E.g., "only for URLs matching pattern X" or "only for items created in the last 24 hours". This adds power but also complexity.

3. **Should there be a "confirm before executing" option for destructive actions?** E.g., archiving to Wayback Machine might warrant a confirmation dialog.

4. **What icon set to use?** Options:
   - Inline SVG from a predefined set (simplest, no dependencies)
   - Single emoji character (cross-platform but rendering varies)
   - Reference to an external icon library

5. **Should tag actions support "on schedule" triggers?** E.g., "every day, for items tagged `daily-review`, do X". This is a different trigger model (cron-based vs event-based).

6. **Priority/ordering** — if multiple actions match the same tag event, should users be able to control execution order?

7. **Keyboard shortcut for quick-tagging** — should tag actions expose a way to tag the current window's URL with a single keypress? E.g., Option+1 = tag with `read-later`, Option+2 = tag with `archive`. This could be a feature of the tag-actions extension using `api.shortcuts.register()`.

### Technical Decisions

8. **Circular trigger prevention** — The "add tag" action type can create chains. Proposed solution: maintain a per-event Set of already-triggered action IDs. If an action is already in the set, skip it. Reset the set when the original event handler returns.

9. **Error handling** — If an action fails (e.g., script errors, network timeout on URL open), should the extension:
   - Log silently (current scripts extension pattern)
   - Show a notification
   - Store error state on the action config (like feeds' `errorCount`)

10. **Batch operations** — Sync pulls can import many items at once, each potentially triggering tag actions. Should actions be debounced per tag (process once after all sync items are tagged) or fire for every individual item?

---

## 10. Summary of Patterns Used

| Aspect | Pattern Source | Notes |
|--------|---------------|-------|
| Extension structure | All extensions | manifest.json + background.html + background.js |
| Settings storage | scripts, sheets | `api.settings.get/set` with JSON in `extension_settings` |
| Settings schema | editor, example | `settings-schema.json` with labels, prefs, defaults |
| Settings UI | groups/home.js, tags/home.js | peek-components, ESC navigation, list/detail views |
| Event listening | tags/home.js, groups/home.js | `api.subscribe('tag:item-added', ...)` |
| Cross-extension query | scripts (execute) | Pubsub request/response pattern |
| Noun registration | tags, feeds, scripts | `registerNoun()` for auto-generated commands |
| Command registration | all extensions | `api.commands.register()` in init |
| Window management | feeds, scripts | `api.window.open()` with role/key/dimensions |
