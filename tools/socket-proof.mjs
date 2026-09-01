/**
 * Drives openRemoteStore() against a real Peek server over the network.
 *
 * Every other test of this store stubs `fetch`, and every test of the /mcp/*
 * routes drives them through a mirror app, so nothing until this has exercised
 * the two halves against each other. What it looks for is disagreement: a field
 * the server names differently, a query parameter that encodes differently than
 * the stub expected, a status the client maps to the wrong error.
 *
 * Reads run before writes. Each step reports and the run continues, because one
 * failure early would otherwise hide every later disagreement.
 *
 * Credentials come from the environment and are never written to disk:
 *   PEEK_MCP_REMOTE_URL   base URL of the server
 *   PEEK_MCP_TOKEN        grant credential
 *
 * Writes are confined by the grant's own scope tag; the store cannot widen it.
 */
import { openRemoteStore } from '../apps/desktop/features/mcp-server/store/remote-store.js';

const results = [];
let created = null;

async function step(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true, value });
    console.log(`  ok    ${name}`);
    return value;
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err?.constructor?.name}: ${err?.message}`);
    return undefined;
  }
}

function summarize(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `keys: ${Object.keys(value).join(', ')}`;
  return JSON.stringify(value);
}

const store = await openRemoteStore({
  remoteUrl: process.env.PEEK_MCP_REMOTE_URL,
  credential: process.env.PEEK_MCP_TOKEN,
});

console.log('\n--- reads');
const described = await step('describe', () => store.describe());
await step('queryItems (no filter)', () => store.queryItems({ limit: 5 }));
await step('queryItems (type filter)', () => store.queryItems({ type: 'text', limit: 5 }));
await step('searchItems', () => store.searchItems({ query: 'peek', limit: 5 }));
await step('listTags', () => store.listTags({ limit: 10 }));
await step('listTasks', () => store.listTasks({}));
await step('resolveItemId (miss)', () => store.resolveItemId('zzzzzzzz'));
await step('getItem (miss)', () => store.getItem('zzzzzzzzzzzz'));

console.log('\n--- writes');
created = await step('createItem', () =>
  store.createItem({ type: 'text', content: 'socket proof', tags: ['socket-proof'] }));

if (created?.id) {
  const id = created.id;
  await step('getItem (hit)', () => store.getItem(id));
  await step('getItemTags', () => store.getItemTags(id));
  await step('updateItem', () => store.updateItem(id, { content: 'socket proof, updated' }));
  await step('tagItem', () => store.tagItem(id, 'socket-proof-extra'));
  await step('untagItem', () => store.untagItem(id, 'socket-proof-extra'));
  await step('recordEvent', () => store.recordEvent(id, 'viewed', null));
  await step('getTaskContext', () => store.getTaskContext(id));
  await step('resolveItemId (hit, full id)', () => store.resolveItemId(id));

  // The reads above ran against an empty scope, where an empty array proves the
  // request reached the server but nothing about how a row is shaped on the way
  // back. Repeat the list reads now that the scope holds one known item.
  await step('queryItems (populated)', () => store.queryItems({ limit: 5 }));
  await step('searchItems (populated)', () => store.searchItems({ query: 'socket', limit: 5 }));
  await step('listTags (populated)', () => store.listTags({ limit: 10 }));

  await step('deleteItem', () => store.deleteItem(id));
} else {
  console.log('  skipped every write follow-up: createItem returned no id');
}

await store.close();

console.log('\n--- summary');
for (const r of results) {
  if (r.ok) console.log(`  ok    ${r.name} -> ${summarize(r.value)}`);
  else console.log(`  FAIL  ${r.name} -> ${r.error?.message}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (described) console.log(`describe() said: ${JSON.stringify(described)}`);
process.exit(failed.length > 0 ? 1 : 0);
