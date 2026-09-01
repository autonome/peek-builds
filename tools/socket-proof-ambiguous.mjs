/**
 * Exercises the prefix-ambiguity path of openRemoteStore() against a real server.
 *
 * Prefix resolution returning 409 with a candidate list is the most intricate
 * shape crossing the seam: the server answers with a status the client has to
 * recognise, a candidate array it has to reshape, and a truncation flag it has
 * to carry into the error text `formatAmbiguous()` builds. Nothing else in the
 * store turns a non-200 into a value-bearing error, so nothing else can catch a
 * mismapping here.
 *
 * Triggering it needs two items whose ids share a prefix, which means creating
 * enough items that a short prefix collides, then asking for that prefix.
 *
 * Environment, as for the main harness: PEEK_MCP_REMOTE_URL, PEEK_MCP_TOKEN.
 */
import { openRemoteStore } from '../apps/desktop/features/mcp-server/store/remote-store.js';

const COUNT = 8;

const store = await openRemoteStore({
  remoteUrl: process.env.PEEK_MCP_REMOTE_URL,
  credential: process.env.PEEK_MCP_TOKEN,
});

const ids = [];
for (let i = 0; i < COUNT; i++) {
  const item = await store.createItem({
    type: 'text',
    content: `ambiguity probe ${i}`,
    tags: ['socket-proof'],
  });
  ids.push(item.id);
}
console.log(`created ${ids.length} items`);

// Longest prefix shared by at least two ids — the shortest input that must
// produce a 409 rather than a hit.
function sharedPrefix(list) {
  let best = '';
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      let k = 0;
      while (k < list[i].length && list[i][k] === list[j][k]) k++;
      if (k > best.length) best = list[i].slice(0, k);
    }
  }
  return best;
}

const prefix = sharedPrefix(ids);
console.log(`shared prefix: ${JSON.stringify(prefix)} (${prefix.length} chars)`);

if (!prefix) {
  console.log('no two ids share a prefix; cannot probe ambiguity with this sample');
} else {
  console.log('\n--- resolveItemId(prefix) expecting an ambiguity error');
  try {
    const result = await store.resolveItemId(prefix);
    console.log(`  NO ERROR — returned ${JSON.stringify(result)}`);
  } catch (err) {
    console.log(`  threw ${err?.constructor?.name}: ${err.message}`);
    console.log(`  candidates carried: ${JSON.stringify(err.candidates ?? null)}`);
    console.log(`  truncated flag:     ${JSON.stringify(err.truncated ?? null)}`);
  }

  console.log('\n--- getItem(prefix), same expectation through the item route');
  try {
    const item = await store.getItem(prefix);
    console.log(`  NO ERROR — returned ${item ? `item ${item.id}` : 'null'}`);
  } catch (err) {
    console.log(`  threw ${err?.constructor?.name}: ${err.message}`);
  }
}

console.log('\n--- cleanup');
for (const id of ids) {
  await store.deleteItem(id);
}
console.log(`deleted ${ids.length} items`);

await store.close();
