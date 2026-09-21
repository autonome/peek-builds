#!/usr/bin/env node
// Capture one Peek window as a PNG over the Chrome DevTools Protocol.
//
//   node talk/capture-shot.mjs --list
//   node talk/capture-shot.mjs <url-or-title-substring> <out.png>
//
// Expects Peek launched with --remote-debugging-port (CDP_PORT, default 9222).
// Needs Node 22+ for the global WebSocket. Compress the result afterwards:
//   sips -Z 1600 -s format jpeg -s formatOptions 55 <out.png> --out talk/screenshots/<name>.jpg

const port = process.env.CDP_PORT || "9222";
const settleMs = Number(process.env.SETTLE_MS || 400);
const [match, outPath] = process.argv.slice(2);

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
  .filter((t) => t.type === "page");

if (!match || match === "--list") {
  for (const t of targets) console.log(`${t.title}\t${t.url}`);
  process.exit(0);
}
if (!outPath) {
  console.error("usage: capture-shot.mjs <url-or-title-substring> <out.png>");
  process.exit(2);
}

const needle = match.toLowerCase();
const target = targets.find(
  (t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
);
if (!target) {
  console.error(`no page target matches "${match}"; run with --list to see what is open`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error.message));
  else entry.resolve(msg.result);
};
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await new Promise((r) => setTimeout(r, settleMs));
const { data } = await send("Page.captureScreenshot", { format: "png" });
const { writeFile } = await import("node:fs/promises");
await writeFile(outPath, Buffer.from(data, "base64"));
console.log(`${target.title} -> ${outPath}`);
ws.close();
