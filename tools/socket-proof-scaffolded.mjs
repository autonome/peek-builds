/**
 * Launches the MCP server the way a scaffolded project launches it, and drives
 * it over stdio.
 *
 * The other harnesses construct the remote store directly, which skips the
 * credential resolution `setup.js` actually sets up: an entry holding only
 * `${PEEK_SYNC_URL}` and a lookup key, a 0600 credential file outside the repo,
 * and a child process expected to turn those into a bearer token. A store that
 * works when handed a token proves nothing about that path.
 *
 * Expects the environment a scaffolded project's shell provides:
 *   PEEK_SYNC_URL              the real server URL the entry references
 *   PEEK_MCP_SERVER            path to server.js
 *   PEEK_MCP_SCOPE_TAG         scope the entry was scaffolded with
 *   PEEK_MCP_CREDENTIAL_KEY    lookup key into the credential file
 *
 * No token is passed in. If the child cannot find one, that is the finding.
 */
import { spawn } from 'node:child_process';

const child = spawn('node', [process.env.PEEK_MCP_SERVER], {
  env: {
    ...process.env,
    PEEK_MCP_REMOTE_URL: process.env.PEEK_SYNC_URL,
    PEEK_MCP_SCOPE_TAG: process.env.PEEK_MCP_SCOPE_TAG,
    PEEK_MCP_CREDENTIAL: process.env.PEEK_MCP_CREDENTIAL_KEY,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const pending = new Map();
let buffer = '';
child.stdout.on('data', (d) => {
  buffer += d.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out after 20s`));
      }
    }, 20000);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'socket-proof', version: '0' },
});
console.log(`initialize -> ${init.result ? 'ok' : JSON.stringify(init.error)}`);
notify('notifications/initialized', {});

const tools = await send('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log(`tools/list -> ${names.length} tools: ${names.join(', ')}`);

async function call(name, args) {
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) return { ok: false, text: JSON.stringify(res.error) };
  const text = res.result?.content?.[0]?.text ?? '';
  return { ok: !res.result?.isError, text };
}

// An empty list proves an authenticated round trip and nothing about how a row
// travels, so put a known item in the scope first and take it out afterwards.
console.log('\n--- create, list, delete through the scaffolded child');
const made = await call('create_item', {
  type: 'text',
  content: 'scaffolded socket proof',
  tags: ['socket-proof'],
});
console.log(`  create_item ${made.ok ? 'ok' : 'FAIL'}  ${made.text.split('\n')[0]}`);

const listed = await call('list_items', { limit: 5 });
console.log(`  list_items  ${listed.ok ? 'ok' : 'FAIL'}  ${listed.text.split('\n')[0]}`);

const id = (made.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
if (id) {
  const removed = await call('delete_item', { itemId: id });
  console.log(`  delete_item ${removed.ok ? 'ok' : 'FAIL'}  ${removed.text.split('\n')[0]}`);
} else {
  console.log('  delete_item skipped — no id found in the create_item response');
}

child.stdin.end();
child.kill();

if (stderr.trim()) {
  console.log('\n--- child stderr');
  console.log(stderr.trim().split('\n').slice(0, 20).join('\n'));
}
