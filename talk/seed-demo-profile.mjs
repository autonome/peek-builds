#!/usr/bin/env node
// Fill a fresh Peek profile with made-up demo data, so deck screenshots never
// show anything from a real profile.
//
//   PEEK_HEADLESS=1 PROFILE=deckdemo <electron> <repo> --remote-debugging-port=9222
//   node talk/seed-demo-profile.mjs
//
// Talks to the running app over the Chrome DevTools Protocol (CDP_PORT, default
// 9222) and evaluates window.app calls inside Peek's own pages. Needs Node 22+.
// Run it once per fresh profile; a second run adds duplicates.

const port = process.env.CDP_PORT || "9222";

const PAGES = [
  ["https://en.wikipedia.org/wiki/Hypertext", "Hypertext — Wikipedia", ["reading", "web-history"]],
  ["https://en.wikipedia.org/wiki/Memex", "Memex — Wikipedia", ["reading", "web-history"]],
  ["https://en.wikipedia.org/wiki/Analytical_engine", "Analytical engine — Wikipedia", ["reading", "computing"]],
  ["https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API", "Web Workers API — MDN", ["reference", "web-platform"]],
  ["https://developer.mozilla.org/en-US/docs/Web/HTML/Microformats", "Microformats — MDN", ["reference", "web-platform"]],
  ["https://servo.org/", "Servo, the embeddable web engine", ["web-platform", "engines"]],
  ["https://www.sqlite.org/whentouse.html", "Appropriate Uses For SQLite", ["reference", "computing"]],
  ["https://indieweb.org/", "IndieWeb", ["web-history", "reading"]],
  ["https://atproto.com/", "AT Protocol", ["web-platform", "reading"]],
  ["https://www.w3.org/TR/activitypub/", "ActivityPub — W3C", ["reference", "web-platform"]],
];
const OPEN_IN_WINDOWS = PAGES.slice(0, 8).map((p) => p[0]);
const GROUP_TAGS = ["reading", "reference", "web-platform", "web-history", "computing"];

const NOTES = [
  "# Talk outline\n\n- the hook: peek, don't switch\n- features all the way down\n- one store, three clients\n- agents on the same datastore\n\n#talk #todo",
  "Try the slide-in panel for the transit map #idea",
  "Reading list for the flight: hypertext history, the Memex essay #reading #later",
  "Conference checklist: adapter, clicker, backup deck on a stick #talk #todo #today",
];

const ENTITIES = [
  ["Ada Lovelace", "person", 0.92, 14],
  ["Charles Babbage", "person", 0.9, 11],
  ["Vannevar Bush", "person", 0.88, 9],
  ["Grace Hopper", "person", 0.91, 8],
  ["Ted Nelson", "person", 0.86, 7],
  ["Douglas Engelbart", "person", 0.87, 6],
  ["World Wide Web Consortium", "organization", 0.9, 12],
  ["Analytical Society", "organization", 0.78, 4],
  ["Example Observatory", "organization", 0.75, 3],
  ["Lisbon", "place", 0.85, 10],
  ["Kyoto", "place", 0.84, 6],
  ["Hypertext '87", "event", 0.8, 3],
  ["hello@example.org", "email", 0.9, 5],
  ["Analytical Engine", "product", 0.8, 9],
];

const FEEDS = [
  ["https://example.org/small-web/feed.xml", "The Small Web Review", [
    "Personal sites are having a moment", "A field guide to blogrolls", "Why your homepage should be weird",
    "Webrings, revisited", "Notes on hand-written HTML"]],
  ["https://example.org/engines/feed.xml", "Browser Engine Notes", [
    "Layout in parallel: a progress report", "What embedders actually need", "Counting renderer processes",
    "A tour of compositor paint loops"]],
  ["https://example.org/local-first/feed.xml", "Local-First Dispatch", [
    "SQLite as an application file format", "Last-write-wins is fine, actually", "Sync without a CRDT"]],
];

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");
}

async function waitForTarget(urlPart, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hit = (await targets()).find((t) => t.url.includes(urlPart));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no window with "${urlPart}" in its url`);
}

// Evaluate an async function body inside the page whose url contains urlPart.
async function evalIn(urlPart, body, arg) {
  const target = await waitForTarget(urlPart);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const expression = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`;
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || "page threw"));
      else resolve(msg.result.result.value);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return result;
}

const CORE = "peek://app/background.html";

// SEED_ONLY=feeds,windows reruns just those steps after a partial run.
const only = (process.env.SEED_ONLY || "").split(",").filter(Boolean);
const want = (step) => only.length === 0 || only.includes(step);

if (want("items")) console.log("items, tags and groups:", await evalIn(CORE, `
  const ds = window.app.datastore;
  const tagIds = {};
  async function tag(itemId, name) {
    if (!tagIds[name]) tagIds[name] = (await ds.getOrCreateTag(name)).data.tag;
    await ds.tagItem(itemId, tagIds[name].id);
  }
  for (const [url, title, tags] of arg.pages) {
    const r = await ds.addItem('url', { content: url, metadata: { title } });
    for (const t of tags) await tag(r.data.id, t);
  }
  for (const content of arg.notes) await ds.addItem('text', { content });
  for (const name of arg.groups) {
    const row = tagIds[name];
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}') || {}; } catch (e) {}
    meta.isGroup = true;
    await ds.setRow('tags', row.id, { ...row, metadata: JSON.stringify(meta) });
  }
  return Object.keys(tagIds).length + ' tags';
`, { pages: PAGES, notes: NOTES, groups: GROUP_TAGS }));

// Wake the lazy features whose own pages hold the functions used below.
await evalIn(CORE, `
  for (const name of ['open entities', 'open feeds', 'timers']) window.app.publish('cmd:execute:' + name);
  return 'ok';
`);

if (want("entities")) console.log("entities:", await evalIn("peek://entities/background.html", `
  const store = await import('peek://entities/entity-store.js');
  for (const [name, entityType, confidence, sightings] of arg) {
    const r = await store.createEntity({ name, entityType, confidence, aliases: [], extractor: 'seed' });
    for (let i = 0; i < sightings; i++) {
      await store.addObservation(r.data.id, {
        url: 'https://example.org/articles/' + encodeURIComponent(name) + '/' + i,
        confidence, extractor: 'seed', pageTitle: 'Article ' + (i + 1) + ' mentioning ' + name,
      });
    }
  }
  return arg.length + ' entities';
`, ENTITIES));

// The feed reader has no background page of its own, so its rows go in through the core page.
if (want("feeds")) console.log("feeds:", await evalIn(CORE, `
  const ds = window.app.datastore;
  let n = 0;
  for (const [url, name, titles] of arg) {
    const feed = await ds.addItem('feed', { content: url, metadata: JSON.stringify({ name, format: 'rss', lastPolledAt: Date.now(), errorCount: 0 }) });
    for (const [i, title] of titles.entries()) {
      const link = url.replace('feed.xml', 'post-' + (i + 1));
      await ds.addItemEvent(feed.data.id, {
        content: link, occurredAt: Date.now() - i * 86400000,
        metadata: JSON.stringify({ guid: link, title, author: name, description: title + '.' }),
      });
      n++;
    }
  }
  return n + ' entries';
`, FEEDS));

if (want("windows")) console.log("sheet and page windows:", await evalIn(CORE, `
  // No timers: the datastore rejects item type 'timer', so the timers feature cannot create any.
  window.app.publish('cmd:execute:new sheet', { args: 'Conference budget' });
  for (const url of arg) window.app.window.open(url, { key: url });   // not awaited: a slow page would stall the script
  return arg.length + ' windows';
`, OPEN_IN_WINDOWS));
