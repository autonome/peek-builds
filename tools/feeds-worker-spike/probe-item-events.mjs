/**
 * Exercises the `/mcp/*` item-event routes against a deployed `apps/server`.
 *
 * Narrower than `run.mjs`, which drives a whole feature: this writes events with
 * the fields the routes newly accept, reads them back past the twenty the
 * embedded `?events=N` path returns, and deletes them — enough to tell whether a
 * deploy actually carries the routes, and to show what the response shape does
 * with what was written.
 *
 * It creates and removes its own `feed` item, so a clean run leaves the store as
 * it found it. `deleteItem()` in `apps/server/db.js` is a soft delete that does
 * not touch `item_events`, so the events are removed explicitly first — which is
 * the whole point of the delete route existing.
 *
 * Environment matches `run.mjs`:
 *   PEEK_MCP_REMOTE_URL   base URL of the server
 *   PEEK_MCP_CREDENTIAL   lookup key into ~/.config/peek/mcp-credentials.json
 *   PEEK_MCP_TOKEN        the grant credential itself, when there is no file
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeCredentialKey } from '../../apps/desktop/features/mcp-server/credential-key.js';
import { openRemoteStore } from '../../apps/desktop/features/mcp-server/store/remote-store.js';

const ENTRIES = 31; // more than the 20 the embedded ?events= path returns

function resolveCredential() {
  if (!process.env.PEEK_MCP_CREDENTIAL) return process.env.PEEK_MCP_TOKEN;
  const key = process.env.PEEK_MCP_CREDENTIAL;
  const filePath = path.join(os.homedir(), '.config', 'peek', 'mcp-credentials.json');
  const credentials = JSON.parse(readFileSync(filePath, 'utf8'))?.credentials ?? {};
  const entry = credentials[normalizeCredentialKey(key)] || credentials[key];
  if (!entry?.token) throw new Error(`No credential for "${key}" in ${filePath}.`);
  return entry.token;
}

const store = await openRemoteStore({
  remoteUrl: process.env.PEEK_MCP_REMOTE_URL,
  credential: resolveCredential(),
});

const session = await store.describe();
console.log(`scope tag: ${session.scopeTag}   readonly: ${session.readonly}   backend: ${session.backend}`);

const item = await store.createItem({ type: 'feed', content: 'https://example.invalid/probe' });
console.log(`created item ${item.id}`);

// The shape a feed poller needs: a link, the entry's own publication time, and
// structured metadata — none of which the route accepted before.
const publishedAt = 1735689600000;
for (let i = 1; i <= ENTRIES; i += 1) {
  await store.recordEvent(item.id, 'feed-entry', '', {
    content: `https://example.invalid/entry-${i}`,
    occurredAt: publishedAt + i * 1000,
    metadata: JSON.stringify({ guid: `g${i}`, title: `Entry ${i}` }),
  });
}
console.log(`wrote ${ENTRIES} events`);

const paged = await store.listEvents(item.id, { limit: 200 });
const embedded = await store.getItem(item.id, { events: 200 });
console.log(`listEvents returned ${paged.length}; embedded ?events= returned ${embedded.events.length}`);
console.log(`newest event: ${JSON.stringify(paged[0])}`);

// `listEvents()` in `apps/server/mcp-items.js` returns the `content` column
// under its own name. It used to alias it to `type`, which handed a caller that
// supplied content its own string back in a field named `type` while the label
// it wrote was nowhere in the response — the state this line reports on.
const newest = paged[0];
const contentSurvived = newest?.content === `https://example.invalid/entry-${ENTRIES}`;
const aliasedToType = typeof newest?.type === 'string' && newest.type.startsWith('http');
console.log(
  aliasedToType
    ? 'NOTE: `type` in the response is the content column — the paged read is still aliasing.'
    : `content returned under its own name: ${contentSurvived}`
);

const occurredAtHeld = newest?.occurredAt === publishedAt + ENTRIES * 1000;
console.log(`occurredAt preserved rather than stamped with the server clock: ${occurredAtHeld}`);

const deleted = await store.deleteEvents(item.id);
console.log(`deleteEvents: ${JSON.stringify(deleted)}`);
console.log(`after delete, listEvents returns ${(await store.listEvents(item.id, { limit: 200 })).length}`);

await store.deleteItem(item.id);
console.log('item deleted');
