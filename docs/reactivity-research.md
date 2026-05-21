# Reactivity Research: Tag-Centric & Item Events

Status: **Implemented (Phase 1 & 2)** | Priority: Active

## Problem

Extensions load data once at init and never refresh. Example: tag a URL while groups is open, groups shows stale data until closed and reopened.

## Root Cause

Three disconnected layers:
1. **Signals** (UI) - implemented but extensions don't use them for datastore state
2. **PubSub** - works, but no datastore change events were published
3. **Extensions** - load data once at init, never refresh

## Solution: Datastore Event Emission

Thin event layer on top of existing IPC handlers. When tag/item operations succeed, publish events via existing PubSub system.

### Tag Events (Phase 1 - Implemented)

Emitted from `apps/desktop/main/ipc.ts` IPC handlers:

```javascript
'tag:created'         → { tagId, tagName }
'tag:item-added'      → { tagId, tagName, itemId, itemType }
'tag:item-removed'    → { tagId, tagName, itemId }
'tag:address-added'   → { tagId, tagName, addressId }
'tag:address-removed' → { tagId, tagName, addressId }
```

### Item Events (Phase 2 - Implemented)

```javascript
'item:created'  → { itemId, itemType, content }
'item:updated'  → { itemId, itemType }
'item:deleted'  → { itemId, itemType }
```

### Why IPC Handler Level

- Centralizes event emission with IPC routing
- Matches existing patterns (modes:changed, context:changed)
- Single source of truth for all changes
- No changes needed to datastore.ts layer
- PubSub GLOBAL scope broadcasts to all extension windows

## Extension Subscriptions

### groups/home.js

Subscribes to tag and item events, debounced:

```javascript
const debouncedRefresh = debounce(async () => {
  await loadTags();
  if (state.view === VIEW_GROUPS) renderGroups();
  else if (state.view === VIEW_ADDRESSES) renderAddresses();
}, 150);

api.subscribe('tag:item-added', debouncedRefresh, api.scopes.GLOBAL);
api.subscribe('tag:item-removed', debouncedRefresh, api.scopes.GLOBAL);
api.subscribe('tag:created', debouncedRefresh, api.scopes.GLOBAL);
api.subscribe('item:created', debouncedRefresh, api.scopes.GLOBAL);
api.subscribe('item:deleted', debouncedRefresh, api.scopes.GLOBAL);
```

### tags/home.js

Same pattern with targeted state updates where possible:

```javascript
api.subscribe('tag:item-added', (msg) => {
  // Update specific item's tags in state
  state.itemTags.get(msg.itemId).push({ id: msg.tagId, name: msg.tagName });
  render();
}, api.scopes.GLOBAL);

api.subscribe('item:deleted', (msg) => {
  state.items = state.items.filter(i => i.id !== msg.itemId);
  state.itemTags.delete(msg.itemId);
  render();
}, api.scopes.GLOBAL);
```

## Debouncing

Simple debounce wrapper prevents rapid re-renders when multiple events fire in quick succession (e.g., batch tagging):

```javascript
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
```

150ms debounce balances responsiveness with efficiency.

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| IPC handler level (not datastore) | Reuses PubSub, no datastore changes |
| Separate tag vs item events | Different consumers, different update logic |
| GLOBAL scope | Cross-window reactivity |
| Debounce in extensions | Extensions control their own refresh rate |
| Include names in payloads | Extensions don't need extra lookups |

## What This Doesn't Cover

- **editor:changed** remains a separate extension-level event (correct - editor publishes its own)
- No feed-level events yet (feeds are poll-based)
- No signal-based reactive queries (Phase 3, future)

## Approaches Considered & Rejected

### Feeds as Tags
Modeling tags as feeds with item_events. Rejected: overcomplicates tags with feed language/APIs. Tags are tags.

### editor:changed for Everything
Using the generic editor event. Rejected: too coarse, semantically wrong, causes full reloads.

### Datastore-Level Emission
Publishing from datastore.ts functions. Rejected: would require importing PubSub into datastore layer, crossing concerns.

## Test Coverage

Integration tests in `tests/desktop/smoke.spec.ts`:

**Tag Events:**
- tag:created emitted when new tag created
- tag:item-added emitted when item tagged
- tag:item-removed emitted when item untagged
- tag:item-added NOT emitted for duplicate tag

**Item Events:**
- item:created emitted when item added
- item:updated emitted when item updated
- item:deleted emitted when item deleted

## Files

| File | Purpose |
|------|---------|
| `apps/desktop/main/ipc.ts` | Event emission (IPC handlers) |
| `apps/desktop/main/pubsub.ts` | PubSub engine (unchanged) |
| `extensions/groups/home.js` | Tag + item event subscriptions |
| `extensions/tags/home.js` | Tag + item event subscriptions |
| `tests/desktop/smoke.spec.ts` | Integration tests |

## Future Work

- **Phase 3**: Reactive queries using Signals
- **Address events**: `address:created`, `address:updated`, `address:deleted`
- **Batch events**: Optional `tag:batch-complete` for large operations
- **Feed change events**: When feeds infrastructure evolves
