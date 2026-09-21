#!/usr/bin/env node
// Capture Peek windows as PNGs over the Chrome DevTools Protocol.
//
//   node talk/capture-shot.mjs --list
//   node talk/capture-shot.mjs <url-or-title-substring> <out.png>
//   node talk/capture-shot.mjs <substring>=<out.png> <substring>=<out.png> ...
//
// Expects Peek launched with --remote-debugging-port (CDP_PORT, default 9222).
// Needs Node 22+ for the global WebSocket. Compress the results afterwards:
//   sips -Z 1600 -s format jpeg -s formatOptions 55 <out.png> --out talk/screenshots/<name>.jpg

import { writeFile } from "node:fs/promises";

const port = process.env.CDP_PORT || "9222";
const settleMs = Number(process.env.SETTLE_MS || 400);
const args = process.argv.slice(2);

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
  .filter((t) => t.type === "page");

if (args.length === 0 || args[0] === "--list") {
  for (const t of targets) console.log(`${t.title}\t${t.url}`);
  process.exit(0);
}

// The last "=" splits a pair, since a url substring may itself contain one.
const pairs = args.every((a) => a.includes("="))
  ? args.map((a) => [a.slice(0, a.lastIndexOf("=")), a.slice(a.lastIndexOf("=") + 1)])
  : [[args[0], args[1]]];
if (pairs.some(([, out]) => !out)) {
  console.error("usage: capture-shot.mjs <substring> <out.png>  |  <substring>=<out.png> ...");
  process.exit(2);
}

async function capture(match, outPath) {
  const needle = match.toLowerCase();
  const target = targets.find(
    (t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
  );
  if (!target) throw new Error(`no page target matches "${match}"; run with --list to see what is open`);

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
  await writeFile(outPath, Buffer.from(data, "base64"));
  console.log(`${target.title} -> ${outPath}`);
  ws.close();
}

let failed = false;
for (const [match, outPath] of pairs) {
  try {
    await capture(match, outPath);
  } catch (err) {
    failed = true;
    console.error(err.message);
  }
}
process.exit(failed ? 1 : 0);
