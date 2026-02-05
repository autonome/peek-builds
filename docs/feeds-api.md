# Feeds & Series API

This document covers the APIs for time-series data and external feeds in Peek.

## Overview

Peek uses two item types for temporal data:

- **`series`** - Scalar values over time (numeric or text)
- **`feed`** - Entries from external sources (RSS, APIs, logs)

Both store their data in the `item_events` table. The item defines *what* you're tracking; events record *when* things happened.

## Core Concepts

### Items = Definitions

Items with `type: 'series'` or `type: 'feed'` define what you're tracking:

```javascript
// A series tracks scalar values
const series = await api.datastore.addItem('series', {
  content: 'AAPL Stock Price',
  metadata: JSON.stringify({ unit: 'USD', source: 'yahoo-finance' })
});

// A feed tracks entries from a source
const feed = await api.datastore.addItem('feed', {
  content: 'https://example.com/rss',
  metadata: JSON.stringify({ name: 'Example Blog', format: 'rss' })
});
```

### Events = Facts

Events are append-only records of what happened:

```javascript
// Record a series observation
await api.datastore.addItemEvent(series.data.id, {
  value: 156.32,        // numeric value
  occurredAt: Date.now()
});

// Record a feed entry
await api.datastore.addItemEvent(feed.data.id, {
  content: 'https://example.com/article-123',  // entry URL
  occurredAt: pubDate,
  metadata: JSON.stringify({ title: 'Article Title', author: 'Jane' })
});
```

## API Reference

### Item Operations

Standard item CRUD works for series and feeds:

```javascript
// Create
const result = await api.datastore.addItem('series', { content: 'Mood', metadata: '{}' });

// Read
const item = await api.datastore.getItem(itemId);

// Update
await api.datastore.updateItem(itemId, { metadata: '{"unit":"points"}' });

// Delete (also delete events first)
await api.datastore.deleteItemEvents(itemId);
await api.datastore.deleteItem(itemId);

// Query all series
const series = await api.datastore.queryItems({ type: 'series' });

// Query all feeds
const feeds = await api.datastore.queryItems({ type: 'feed' });
```

### Event Operations

#### `addItemEvent(itemId, options)`

Add an event to a series or feed.

```javascript
await api.datastore.addItemEvent(itemId, {
  content: 'text value or URL',      // optional
  value: 42,                          // optional, for numeric data
  occurredAt: Date.now(),             // optional, defaults to now
  metadata: JSON.stringify({...})     // optional, JSON string
});
```

#### `getItemEvent(eventId)`

Get a single event by ID.

```javascript
const event = await api.datastore.getItemEvent(eventId);
// { id, itemId, content, value, occurredAt, metadata, createdAt }
```

#### `queryItemEvents(filter)`

Query events with filters.

```javascript
const events = await api.datastore.queryItemEvents({
  itemId: 'item_123',           // single item
  // OR
  itemIds: ['item_1', 'item_2'], // multiple items
  since: Date.now() - 86400000,  // after timestamp
  until: Date.now(),             // before timestamp
  limit: 50,                     // max results
  offset: 0,                     // skip first N
  order: 'desc'                  // 'asc' or 'desc' by occurredAt
});
```

#### `deleteItemEvent(eventId)`

Delete a single event.

```javascript
await api.datastore.deleteItemEvent(eventId);
```

#### `deleteItemEvents(itemId)`

Delete all events for an item.

```javascript
const count = await api.datastore.deleteItemEvents(itemId);
```

#### `getLatestItemEvent(itemId)`

Get the most recent event.

```javascript
const latest = await api.datastore.getLatestItemEvent(itemId);
```

#### `countItemEvents(itemId, filter)`

Count events for an item.

```javascript
const count = await api.datastore.countItemEvents(itemId, {
  since: Date.now() - 86400000  // last 24 hours
});
```

## Use-Case Examples

### 1. Stock Price Tracking

Track numeric values over time from a web source.

```javascript
// Create the series
const stock = await api.datastore.addItem('series', {
  content: 'AAPL',
  metadata: JSON.stringify({
    name: 'Apple Stock Price',
    unit: 'USD',
    source_url: 'https://finance.yahoo.com/quote/AAPL'
  })
});
const stockId = stock.data.id;

// Record observations (from polling job)
async function recordPrice(price) {
  await api.datastore.addItemEvent(stockId, {
    value: price,
    occurredAt: Date.now()
  });
}

// Query last 7 days
const prices = await api.datastore.queryItemEvents({
  itemId: stockId,
  since: Date.now() - 7 * 24 * 60 * 60 * 1000,
  order: 'asc'
});

// Calculate average
const avg = prices.data.reduce((sum, e) => sum + e.value, 0) / prices.data.length;

// Get latest price
const latest = await api.datastore.getLatestItemEvent(stockId);
console.log(`Current: $${latest.data.value}, 7-day avg: $${avg.toFixed(2)}`);
```

### 2. Mood Tracking (Text Values)

Track non-numeric values like mood or status.

```javascript
// Create the series
const mood = await api.datastore.addItem('series', {
  content: 'Mood',
  metadata: JSON.stringify({ input: 'tag-board' })
});
const moodId = mood.data.id;

// Record mood (from tag button board)
async function recordMood(moodValue) {
  await api.datastore.addItemEvent(moodId, {
    content: moodValue,  // 'great', 'good', 'meh', 'bad'
    occurredAt: Date.now()
  });
}

// Usage
await recordMood('great');
await recordMood('meh');

// Query this week's moods
const moods = await api.datastore.queryItemEvents({
  itemId: moodId,
  since: Date.now() - 7 * 24 * 60 * 60 * 1000
});

// Count by mood
const counts = {};
for (const event of moods.data) {
  counts[event.content] = (counts[event.content] || 0) + 1;
}
console.log('Mood distribution:', counts);
```

### 3. Habit Tracking with Streaks

Track daily habits and calculate streaks.

```javascript
// Create the series
const pushups = await api.datastore.addItem('series', {
  content: 'Pushups',
  metadata: JSON.stringify({ frequency: 'daily', tag: 'pushups' })
});
const pushupId = pushups.data.id;

// Record daily check-in
async function logPushups(count) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  await api.datastore.addItemEvent(pushupId, {
    value: count,
    occurredAt: Date.now(),
    metadata: JSON.stringify({ date: today })
  });
}

// Calculate current streak
async function getStreak() {
  const events = await api.datastore.queryItemEvents({
    itemId: pushupId,
    limit: 365,
    order: 'desc'
  });

  if (!events.success || events.data.length === 0) return 0;

  let streak = 0;
  let expectedDate = new Date();
  expectedDate.setHours(0, 0, 0, 0);

  for (const event of events.data) {
    const meta = JSON.parse(event.metadata || '{}');
    const eventDate = new Date(meta.date);
    eventDate.setHours(0, 0, 0, 0);

    // Check if this is the expected date (consecutive day)
    const diffDays = Math.round((expectedDate - eventDate) / 86400000);

    if (diffDays === 0) {
      streak++;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else if (diffDays === 1) {
      // Skip today if not logged yet
      expectedDate.setDate(expectedDate.getDate() - 1);
      if (expectedDate.getTime() === eventDate.getTime()) {
        streak++;
        expectedDate.setDate(expectedDate.getDate() - 1);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return streak;
}

// Usage
await logPushups(20);
const streak = await getStreak();
console.log(`Current streak: ${streak} days`);

// Get personal best
const allEvents = await api.datastore.queryItemEvents({ itemId: pushupId });
const max = Math.max(...allEvents.data.map(e => e.value || 0));
console.log(`Personal best: ${max} pushups`);
```

### 4. Ticket Availability Trigger

Poll a page and notify when condition is met.

```javascript
// Create the series (acts as trigger definition)
const tickets = await api.datastore.addItem('series', {
  content: 'Taylor Swift Tickets',
  metadata: JSON.stringify({
    source_url: 'https://ticketmaster.com/event/123',
    selector: '.buy-button',
    condition: 'exists',
    notified: false
  })
});
const ticketId = tickets.data.id;

// Polling function (run periodically)
async function checkTickets() {
  const item = await api.datastore.getItem(ticketId);
  const meta = JSON.parse(item.data.metadata || '{}');

  if (meta.notified) return; // Already notified

  // In a real extension, you'd load the page in a hidden window
  // and run document.querySelector(meta.selector)
  const available = await checkPageForElement(meta.source_url, meta.selector);

  // Record the check
  await api.datastore.addItemEvent(ticketId, {
    value: available ? 1 : 0,
    content: available ? 'Available!' : 'Not available',
    occurredAt: Date.now()
  });

  // Trigger notification
  if (available) {
    meta.notified = true;
    await api.datastore.updateItem(ticketId, {
      metadata: JSON.stringify(meta)
    });

    // Show notification
    new Notification('Tickets Available!', {
      body: 'Taylor Swift tickets are now on sale!'
    });
  }
}
```

### 5. RSS Feed Reader

Subscribe to and poll RSS feeds.

```javascript
// Subscribe to a feed
async function subscribe(url) {
  const response = await fetch(url);
  const xml = await response.text();
  const title = parseFeedTitle(xml); // Your XML parsing function

  const feed = await api.datastore.addItem('feed', {
    content: url,
    metadata: JSON.stringify({
      name: title,
      format: 'rss',
      lastPolledAt: 0
    })
  });

  return feed.data.id;
}

// Poll a feed for new entries
async function pollFeed(feedId) {
  const item = await api.datastore.getItem(feedId);
  const feedUrl = item.data.content;

  const response = await fetch(feedUrl);
  const xml = await response.text();
  const entries = parseFeedEntries(xml); // Your XML parsing function

  // Get existing entries to dedupe
  const existing = await api.datastore.queryItemEvents({ itemId: feedId, limit: 100 });
  const existingGuids = new Set(
    existing.data.map(e => JSON.parse(e.metadata || '{}').guid)
  );

  // Add new entries
  for (const entry of entries) {
    if (existingGuids.has(entry.guid)) continue;

    await api.datastore.addItemEvent(feedId, {
      content: entry.link,
      occurredAt: entry.pubDate,
      metadata: JSON.stringify({
        guid: entry.guid,
        title: entry.title,
        author: entry.author
      })
    });
  }

  // Update last polled
  const meta = JSON.parse(item.data.metadata || '{}');
  meta.lastPolledAt = Date.now();
  await api.datastore.updateItem(feedId, { metadata: JSON.stringify(meta) });
}

// Get all entries across feeds
async function getAllEntries(limit = 50) {
  const feeds = await api.datastore.queryItems({ type: 'feed' });
  const feedIds = feeds.data.map(f => f.id);

  const entries = await api.datastore.queryItemEvents({
    itemIds: feedIds,
    limit: limit,
    order: 'desc'
  });

  return entries.data.map(e => ({
    ...e,
    meta: JSON.parse(e.metadata || '{}')
  }));
}
```

### 6. System Metrics / Action Log

Track internal application events.

```javascript
// Create a log feed
const actionLog = await api.datastore.addItem('feed', {
  content: 'peek:system:actions',
  metadata: JSON.stringify({ format: 'internal' })
});
const logId = actionLog.data.id;

// Log an action
async function logAction(action, details = {}) {
  await api.datastore.addItemEvent(logId, {
    content: action,
    occurredAt: Date.now(),
    metadata: JSON.stringify(details)
  });
}

// Usage
await logAction('page_open', { url: 'https://example.com', source: 'bookmark' });
await logAction('settings_changed', { key: 'theme', value: 'dark' });
await logAction('extension_loaded', { id: 'feeds', version: '1.0.0' });

// Query recent actions
const recent = await api.datastore.queryItemEvents({
  itemId: logId,
  since: Date.now() - 3600000, // last hour
  order: 'desc'
});

// Count actions by type
const counts = {};
for (const event of recent.data) {
  counts[event.content] = (counts[event.content] || 0) + 1;
}
console.log('Action counts:', counts);
```

### 7. Spotify Listening History

Pull data from external APIs.

```javascript
// Create the feed
const spotify = await api.datastore.addItem('feed', {
  content: 'spotify:me:recently-played',
  metadata: JSON.stringify({
    format: 'api',
    service: 'spotify',
    lastSyncedAt: 0
  })
});
const spotifyId = spotify.data.id;

// Sync from Spotify API (requires OAuth token)
async function syncSpotify(accessToken) {
  const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const data = await response.json();

  // Get existing to dedupe
  const existing = await api.datastore.queryItemEvents({ itemId: spotifyId, limit: 100 });
  const existingIds = new Set(
    existing.data.map(e => JSON.parse(e.metadata || '{}').playedAt)
  );

  // Add new plays
  for (const item of data.items) {
    const playedAt = new Date(item.played_at).getTime();
    if (existingIds.has(item.played_at)) continue;

    await api.datastore.addItemEvent(spotifyId, {
      content: item.track.uri,
      occurredAt: playedAt,
      metadata: JSON.stringify({
        playedAt: item.played_at,
        trackName: item.track.name,
        artistName: item.track.artists[0]?.name,
        albumName: item.track.album?.name,
        durationMs: item.track.duration_ms
      })
    });
  }

  // Update sync time
  const meta = JSON.parse((await api.datastore.getItem(spotifyId)).data.metadata || '{}');
  meta.lastSyncedAt = Date.now();
  await api.datastore.updateItem(spotifyId, { metadata: JSON.stringify(meta) });
}

// Get top artists from listening history
async function getTopArtists(days = 30) {
  const plays = await api.datastore.queryItemEvents({
    itemId: spotifyId,
    since: Date.now() - days * 24 * 60 * 60 * 1000
  });

  const artistCounts = {};
  for (const play of plays.data) {
    const meta = JSON.parse(play.metadata || '{}');
    const artist = meta.artistName || 'Unknown';
    artistCounts[artist] = (artistCounts[artist] || 0) + 1;
  }

  return Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}
```

## Schema Reference

### items table (existing, extended)

```sql
items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'url', 'text', 'tagset', 'image', 'series', 'feed'
  content TEXT,        -- identifier, URL, or name
  metadata TEXT,       -- JSON with type-specific data
  ...
)
```

### item_events table (new)

```sql
item_events (
  id TEXT PRIMARY KEY,
  itemId TEXT NOT NULL,     -- FK to series or feed
  content TEXT,             -- text value, URL, or message
  value REAL,               -- numeric value (optional)
  occurredAt INTEGER,       -- when it happened (Unix ms)
  metadata TEXT,            -- JSON extras
  createdAt INTEGER         -- when recorded
)

-- Indexes
CREATE INDEX idx_item_events_item_time ON item_events(itemId, occurredAt DESC);
CREATE INDEX idx_item_events_occurred ON item_events(occurredAt DESC);
```

## Best Practices

1. **Use `value` for numbers, `content` for text/URLs** - Makes queries and aggregations simpler.

2. **Store dedup keys in metadata** - For feeds, store `guid` to avoid duplicate entries.

3. **Set `occurredAt` to event time, not record time** - For RSS entries, use `pubDate`; for API data, use the original timestamp.

4. **Keep metadata lightweight** - Truncate descriptions, store only what you need for display.

5. **Delete events when deleting items** - Always call `deleteItemEvents(itemId)` before `deleteItem(itemId)`.

6. **Use `order: 'desc'` for recent-first** - Most UIs want newest first.

7. **Batch queries with `itemIds`** - When showing entries from multiple feeds, query once with all IDs.
