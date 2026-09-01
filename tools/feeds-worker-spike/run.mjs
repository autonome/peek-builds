/**
 * Runs `apps/desktop/features/feeds/background.js` with no window, no Electron
 * and no local database, reaching Peek data over `openRemoteStore()`.
 *
 * A throwaway. The output is evidence for three questions in
 * `docs/workers-design.md` §13 — whether cross-feature imports are bundled or
 * resolved live, whether one API object can serve both halves of a feature, and
 * what a cold start costs — not a runtime anybody should build on.
 *
 * The feature file is imported unmodified. Everything that makes it run is in
 * the host: a `peek://` resolver, a `DOMParser`, a `globalThis.window` for the
 * `const api = window.app` both `background.js` and `renderer/cmd/nouns.js`
 * evaluate at import time, and an API object whose datastore is the remote
 * store wearing the tile API's shape.
 *
 * Phases are run and reported separately, and a failing phase does not stop the
 * next one — a worker that cannot `init()` may still poll perfectly well, and
 * collapsing the two would hide that.
 *
 * Environment:
 *   PEEK_MCP_REMOTE_URL   base URL of the server
 *   PEEK_MCP_CREDENTIAL   lookup key into ~/.config/peek/mcp-credentials.json
 *   PEEK_MCP_TOKEN        the grant credential itself, when there is no file
 *   FEED_URL              feed to poll (default: an RSS feed of HN's front page)
 *   KEEP                  set to leave the created feed item in place
 *   SKIP_LIFECYCLE        set to run the poll alone, for a clean cold start
 *
 * The credential resolves the same two ways `remoteStoreConfig()` in
 * `apps/desktop/features/mcp-server/server.js` resolves it, and the file it
 * reads is the one `setup.js writeCredentialFile()` writes, mode 0600, outside
 * any repository. Nothing here writes a key anywhere.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from 'linkedom';

import { normalizeCredentialKey } from '../../apps/desktop/features/mcp-server/credential-key.js';

import { installPeekResolver, resolvedSpecifiers } from './peek-hooks.mjs';
import { buildWorkerApi, installNetworkGuard, gapLedger, callCount, networkLog } from './worker-api.mjs';
import { openRemoteStore } from '../../apps/desktop/features/mcp-server/store/remote-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FEATURE_DIR = path.resolve(HERE, '../../apps/desktop/features/feeds');
const FEED_URL = process.env.FEED_URL || 'https://hnrss.org/frontpage';

/**
 * Read one token out of the 0600 credential file, by the same key rules
 * `resolveCredentialFromFile()` in `apps/desktop/features/mcp-server/server.js`
 * uses: normalized first, then the raw key, so a file written before the
 * normalization still resolves. The token is returned and never printed.
 */
function resolveCredentialFromFile(key) {
  const filePath = path.join(os.homedir(), '.config', 'peek', 'mcp-credentials.json');
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.code || 'invalid JSON'}`);
  }
  const credentials = data?.credentials ?? {};
  const entry = credentials[normalizeCredentialKey(key)] || credentials[key];
  if (!entry || typeof entry.token !== 'string') {
    throw new Error(
      `No credential for key "${key}" in ${filePath}. Keys present: ${Object.keys(credentials).join(', ') || '(none)'}.`
    );
  }
  return entry.token;
}

/** Milliseconds since the process started, which is what a cold start means. */
const since = () => Math.round(performance.now());

const marks = [];
function mark(name) {
  marks.push({ name, atMs: since() });
}

const phases = [];
async function phase(name, fn) {
  const started = since();
  try {
    const value = await fn();
    phases.push({ name, ok: true, ms: since() - started, value });
    console.log(`  ok    ${name} (${since() - started}ms)`);
    return value;
  } catch (err) {
    phases.push({ name, ok: false, ms: since() - started, error: `${err?.constructor?.name}: ${err?.message}` });
    console.log(`  FAIL  ${name} (${since() - started}ms)`);
    console.log(`        ${err?.constructor?.name}: ${err?.message}`);
    return undefined;
  }
}

// --- Host setup ---------------------------------------------------------

// `DOMParser` is a browser global that `parseFeed()` constructs directly. Node
// has none; linkedom's is the shim, and whether its selector support is enough
// for real feed XML is one of the things the run finds out.
globalThis.DOMParser = DOMParser;

const manifest = JSON.parse(readFileSync(path.join(FEATURE_DIR, 'manifest.json'), 'utf8'));
const domains = manifest.capabilities?.network?.domains ?? [];
installNetworkGuard(domains);
mark('host globals installed');

// With no credential in the environment the run falls back to the memory store,
// which reproduces the server's item and event semantics but reaches no network.
// A cold-start figure from that run is a floor, not the answer, and it is
// labelled as such in the report.
const credential = process.env.PEEK_MCP_CREDENTIAL
  ? resolveCredentialFromFile(process.env.PEEK_MCP_CREDENTIAL)
  : process.env.PEEK_MCP_TOKEN;
const usingRemote = Boolean(process.env.PEEK_MCP_REMOTE_URL && credential);
if (!usingRemote) {
  console.log('PEEK_MCP_REMOTE_URL / PEEK_MCP_TOKEN are unset — running against the memory store.');
  console.log('Nothing below is evidence about the real server except where it is the feature failing.');
}

const store = usingRemote
  ? await openRemoteStore({ remoteUrl: process.env.PEEK_MCP_REMOTE_URL, credential })
  : await (await import('./memory-store.mjs')).openMemoryStore();
mark(usingRemote ? 'remote store opened' : 'memory store opened');

const session = await store.describe();
console.log(`\nscope tag: ${session.scopeTag}   readonly: ${session.readonly}   backend: ${session.backend}`);
if (session.readonly) {
  console.log('This credential is readonly; the write phases will fail. Use the read-write grant.');
}

const api = buildWorkerApi({ store });

// Both `background.js` and `renderer/cmd/nouns.js` evaluate `const api =
// window.app` at import time, so the global has to exist before the import, not
// before `init()`. A worker host that injected `globalThis.app` alone — the
// shape `docs/workers-design.md` §5 proposes — would fail on the module's first
// line, which is itself an answer to open question 5.
globalThis.app = api;
globalThis.window = globalThis;

installPeekResolver();
mark('resolver installed');

// --- Phase 1: import the feature unmodified -----------------------------

console.log('\n--- import');
const mod = await phase('import feeds/background.js', () =>
  import(path.join(FEATURE_DIR, 'background.js'))
);
mark('feature imported');

if (!mod) {
  console.log('\nThe feature could not be imported; nothing further can run.');
  process.exit(1);
}

const extension = mod.default;

// --- Phase 2: the desktop lifecycle, unchanged --------------------------

// `init()` is run twice, under the two answers open question 5 is choosing
// between, because the difference between them is only visible in what the
// feature does next.
//
//   absent  — `docs/workers-design.md` §5's choice: no `api.window`, no
//             `api.shortcuts`, so the first use is a TypeError naming the
//             namespace.
//   stubbed — the alternative: the namespaces exist and do nothing, so `init()`
//             runs to the end.
//
// Timers are captured rather than counted after the fact, so the report can say
// what `init()` installs and how long it would hold a process open.

function captureTimers(fn) {
  const installed = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (cb, ms, ...rest) => {
    const id = realSetInterval(cb, ms, ...rest);
    installed.push({ kind: 'interval', ms, id });
    return id;
  };
  globalThis.setTimeout = (cb, ms, ...rest) => {
    const id = realSetTimeout(cb, ms, ...rest);
    installed.push({ kind: 'timeout', ms, id });
    return id;
  };
  try {
    fn();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
  }
  return installed;
}

function reportTimers(label, installed) {
  if (installed.length === 0) {
    console.log(`  ${label}: no timers installed`);
    return;
  }
  for (const t of installed) {
    console.log(`  ${label}: ${t.kind} at ${t.ms}ms`);
    // Anything on a human timescale would outlive the invocation and fire a
    // poll into the middle of a later phase; the 16ms noun-batch flush is left
    // alone so the registration it carries still goes out.
    if (t.ms >= 1000) {
      if (t.kind === 'interval') clearInterval(t.id); else clearTimeout(t.id);
    }
  }
}

// The cold-start figure is only honest if nothing but the poll ran before it,
// so the two lifecycle experiments are skippable. A scheduled worker does not
// call `init()` at all.
const skipLifecycle = Boolean(process.env.SKIP_LIFECYCLE);

if (skipLifecycle) console.log('\n--- lifecycle: skipped, so the cold-start figure covers the poll alone');

if (!skipLifecycle) {
console.log('\n--- lifecycle: namespaces absent');
let absentTimers = [];
await phase('extension.init() with api.window and api.shortcuts absent', async () => {
  absentTimers = captureTimers(() => extension.init());
  return 'init() returned';
});
reportTimers('absent', absentTimers);
console.log(`  commands registered: ${JSON.stringify(api._inspect.commands)}`);
console.log(`  topics published:    ${JSON.stringify(api._inspect.pubsub.published)}`);
console.log(`  topics subscribed:   ${JSON.stringify(api._inspect.pubsub.subscribed)}`);

console.log('\n--- lifecycle: namespaces stubbed');
const noop = () => ({ success: true });
const stubApi = buildWorkerApi({ store });
stubApi.window = { open: noop, close: noop };
stubApi.shortcuts = { register: noop, unregister: noop };

globalThis.app = stubApi;
const stubMod = await import(`${pathToFileURL(path.join(FEATURE_DIR, 'background.js')).href}?namespaces=stubbed`);
let stubbedTimers = [];
await phase('extension.init() with the missing namespaces stubbed', async () => {
  stubbedTimers = captureTimers(() => stubMod.default.init());
  return 'init() returned';
});
reportTimers('stubbed', stubbedTimers);
console.log(`  commands registered: ${JSON.stringify(stubApi._inspect.commands)}`);
console.log(`  topics published:    ${JSON.stringify(stubApi._inspect.pubsub.published)}`);
console.log(`  topics subscribed:   ${JSON.stringify(stubApi._inspect.pubsub.subscribed)}`);

// The second instance registered its noun too, and none of it reached `stubApi`.
// `renderer/cmd/nouns.js` evaluates `const api = window.app` once, at its own
// first import, and both instances of `background.js` import it by the same
// resolved URL — so Node hands the second one the module already in cache,
// still holding the first API object. Under live resolution a cross-feature
// module is shared process-wide and binds to whichever API object happened to
// be global when it loaded, which no per-instance host object can override.
const nounTopicsOnFirstApi = api._inspect.pubsub.subscribed.filter((t) => t.startsWith('noun:'));
console.log(`  noun topics that landed on the FIRST api instead: ${JSON.stringify(nounTopicsOnFirstApi)}`);
console.log(`  peek://cmd/nouns.js resolutions so far: ${resolvedSpecifiers.length} (module instances: 1)`);

stubMod.default.uninit();
globalThis.app = api;
}

// --- Phase 3: the worker-shaped invocation ------------------------------
//
// What a scheduled worker would actually do: no init(), no timer, one poll and
// exit. The feature already exports the entry points for it.

console.log('\n--- poll');

let feedId = null;

await phase('find or create the feed subscription', async () => {
  const feeds = await mod.getFeeds();
  const existing = feeds.find((f) => f.url === FEED_URL);
  if (existing) {
    feedId = existing.id;
    return `reused ${existing.id}`;
  }
  const result = await mod.subscribeFeed(FEED_URL);
  if (!result.success) throw new Error(result.error);
  feedId = result.data.id;
  return `created ${result.data.id} — ${result.data.title}`;
});

// Two polls back to back, counting the writes each one makes. The second should
// write nothing: `pollFeed()` reads back the existing entries and skips any guid
// it already has, which it can only do for the entries it can see. Reading them
// through `GET /mcp/items/:id?events=N` capped that at 20 whatever the caller
// asked for, so a feed longer than 20 entries re-added the invisible tail on
// every poll, forever. `queryItemEvents()` in worker-api.mjs now reads through
// `GET /mcp/items/:id/events`, which pages to 200. The number below is what is
// left of that leak, measured.
const before1 = callCount('datastore.addItemEvent');
await phase('pollAllFeeds() — first', () => mod.pollAllFeeds());
mark('first poll complete');
const written1 = callCount('datastore.addItemEvent') - before1;

await phase('pollAllFeeds() — second, should write nothing', () => mod.pollAllFeeds());
mark('second poll complete');
const written2 = callCount('datastore.addItemEvent') - before1 - written1;

console.log(`  entries written by the first poll: ${written1}`);
console.log(`  entries written by the second poll: ${written2}  ${written2 === 0 ? '(deduplicated)' : '(RE-ADDED — the dedup read cannot see them)'}`);

await phase('read the entries back', async () => {
  const entries = await mod.getEntries(feedId, 50);
  if (entries.length === 0) throw new Error('no entries readable after a poll that wrote some');
  const sample = entries[0];
  return {
    count: entries.length,
    firstTitle: sample.title,
    firstUrl: sample.url,
    firstPubDate: new Date(sample.pubDate).toISOString(),
  };
});

// --- Phase 4: teardown --------------------------------------------------

console.log('\n--- teardown');
await phase('extension.uninit()', async () => {
  extension.uninit();
  return 'uninit() returned';
});

if (!process.env.KEEP && feedId) {
  await phase('unsubscribeFeed() — removes entries, then the feed', () => mod.unsubscribeFeed(feedId));
  await phase('deleteItem() fallback', () => api.datastore.deleteItem(feedId));
}

// --- Report -------------------------------------------------------------

console.log('\n=== cold start');
for (const m of marks) console.log(`  ${String(m.atMs).padStart(6)}ms  ${m.name}`);

console.log('\n=== peek:// specifiers resolved live');
for (const r of resolvedSpecifiers) console.log(`  ${r.specifier}  ->  ${r.file}  (root ${r.root})`);

console.log('\n=== network');
console.log(`  manifest allows: ${domains.join(', ') || '(nothing)'}`);
for (const n of networkLog) console.log(`  ${n.allowed ? 'allow' : 'DENY '}  ${n.host}  ${n.url}`);

console.log('\n=== datastore gaps');
for (const g of gapLedger()) {
  console.log(`  ${g.verdict.padEnd(12)} ${g.call}  (${g.calls} calls)`);
  console.log(`               ${g.note}`);
}

console.log('\n=== phases');
for (const p of phases) {
  console.log(`  ${p.ok ? 'ok  ' : 'FAIL'}  ${String(p.ms).padStart(6)}ms  ${p.name}`);
  if (p.error) console.log(`               ${p.error}`);
  else if (p.value !== undefined) console.log(`               ${JSON.stringify(p.value)}`);
}

console.log('\n=== deduplication across polls');
console.log(`  feed: ${FEED_URL}`);
console.log(`  first poll wrote ${written1} entries; second poll wrote ${written2}`);
if (written2 > 0) {
  console.log(`  Every poll re-adds ${written2} entries. The dedup read sees 20 events at most;`);
  console.log('  the rest of the feed is invisible to it and gets written again indefinitely.');
}

const failed = phases.filter((p) => !p.ok).length;
console.log(`\n${phases.length - failed}/${phases.length} phases ok; ${failed} failed.`);

// The timers `init()` installed would otherwise keep this alive for 15 minutes.
process.exit(0);
