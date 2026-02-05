# Feeds & Series Architecture

Generalized system for time-series data and external feeds.

## Core Model

Two new item types, one shared events table:

- **series** = scalar values over time (numeric or text)
- **feed** = entries from a source (RSS, ATProto, APIs, internal logs)

Both store their data in `item_events`. Terminology differs by context:
- series → events
- feed → entries

## Schema

```sql
-- items table: add 'series' and 'feed' to type check
-- type IN ('url', 'text', 'tagset', 'image', 'series', 'feed')

-- New table for events/entries
item_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,      -- FK to series or feed item
  content TEXT,               -- text value, URL, or message
  value REAL,                 -- numeric value (optional)
  occurred_at INTEGER NOT NULL, -- when it happened (Unix ms)
  metadata TEXT DEFAULT '{}', -- JSON extras
  created_at INTEGER NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id)
)

CREATE INDEX idx_item_events_item_time ON item_events(item_id, occurred_at DESC);
CREATE INDEX idx_item_events_occurred ON item_events(occurred_at DESC);
```

## Series Examples

```javascript
// Stock price
item: { type: 'series', content: 'AAPL', metadata: { unit: 'USD', source_url: '...' } }
event: { value: 156.32, occurred_at: ... }

// Mood (text value)
item: { type: 'series', content: 'Mood', metadata: { input: 'tag-board' } }
event: { content: 'meh', occurred_at: ... }

// Pushups (from tag input)
item: { type: 'series', content: 'Pushups', metadata: { tag: 'pushups' } }
event: { value: 20, occurred_at: ... }

// Ticket availability (trigger = app-layer logic over events)
item: { type: 'series', content: 'Taylor Swift tickets', metadata: { source_url: '...', condition: { exists: '.buy-button' } } }
event: { value: 1, content: 'Available!', occurred_at: ... }
```

## Feed Examples

```javascript
// RSS
item: { type: 'feed', content: 'https://example.com/rss', metadata: { name: 'Example Blog', format: 'rss' } }
entry: { content: 'https://example.com/article', metadata: { title: '...', author: '...' }, occurred_at: pubDate }

// ATProto (Bluesky)
item: { type: 'feed', content: 'at://did:plc:xxx/app.bsky.feed.generator/whats-hot', metadata: { format: 'atproto' } }
entry: { content: 'at://did:plc:yyy/app.bsky.feed.post/abc', metadata: { text: '...', author: '...' }, occurred_at: ... }

// Spotify listening history
item: { type: 'feed', content: 'spotify:me:recently-played', metadata: { format: 'api', oauth: '...' } }
entry: { content: 'spotify:track:abc123', metadata: { title: 'Song', artist: 'Artist' }, occurred_at: played_at }

// Internal action log
item: { type: 'feed', content: 'peek:system:actions', metadata: { format: 'internal' } }
entry: { content: 'opened settings', metadata: { action: 'navigate', target: 'settings' }, occurred_at: ... }
```

## Key Design Decisions

1. **items = definitions** (singleton, the thing you care about)
2. **item_events = facts** (append-only, many per item)
3. **Terminology is API/docs level** - schema doesn't distinguish event vs entry
4. **Triggers, streaks, alerts = app-layer queries** over events, not special types
5. **Tag input → series event** = future transformer/pipeline concern

## Queries

```javascript
// Last 7 days of stock prices
db.item_events.query({
  item_id: stockItem.id,
  occurred_at: { $gte: now - 7 * DAY }
})

// Recent entries across all feeds
db.item_events.query({
  item_id: { $in: feedItemIds },
  occurred_at: { $gte: now - 24 * HOUR },
  order: 'occurred_at DESC'
})

// Streak calculation (app layer)
const events = await db.item_events.query({ item_id: pushupsSeries.id, order: 'occurred_at DESC' })
const streak = calculateConsecutiveDays(events)
```

## Sync Considerations

- `item_events` can sync like items (has timestamps, soft-delete possible)
- Or keep local-only if volume is high (regenerate from source)
- Decision per-feed via `metadata.sync: true|false`

## Use-Case Summary

| Use-case | Item type | Item content | Event content | Event value |
|----------|-----------|--------------|---------------|-------------|
| Stock price | series | "AAPL" | - | 156.32 |
| Mood tracking | series | "Mood" | "meh" | - |
| Habit (pushups) | series | "Pushups" | - | 20 |
| Ticket trigger | series | "Taylor Swift tickets" | "Available!" | 1 |
| RSS feed | feed | "https://.../rss" | article URL | - |
| ATProto | feed | "at://..." | post URI | - |
| Spotify history | feed | "spotify:me:recently-played" | track URI | - |
| System log | feed | "peek:system:actions" | log message | - |
