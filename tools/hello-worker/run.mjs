/**
 * Runs `worker.js` the way a worker host does (`docs/workers-design.md`
 * §2–§5): no Electron, no window, no local database. It reads `manifest.json`,
 * builds the API object the manifest's grants describe — absent namespaces
 * are `undefined`, never stubbed — holds the sync credential in a closure the
 * worker cannot reach (`docs/workers-capabilities.md` §2.1), imports
 * `worker.js` and runs its entry function once, and exits non-zero on any
 * throw.
 *
 * Reuses `tools/feeds-worker-spike/`'s harness pieces rather than forking
 * them: `installNetworkGuard()` so the manifest's `network.domains` means
 * something in a plain Node process, and `memory-store.mjs` for the offline
 * mode. The API object itself is hello-worker's own — the feeds one is
 * shaped around `items`/`item_events` this worker never touches.
 *
 * Two store modes:
 *
 *   --memory    an in-memory store, no network — for an offline run.
 *   (default)   the deployed sync server through `openRemoteStore()`, at
 *               PEEK_SYNC_URL, with a credential resolved the same way
 *               `tools/feeds-worker-spike/run.mjs` resolves one: the 0600
 *               file at $HOME/.config/peek/mcp-credentials.json, keyed
 *               "<url>#peek". If no usable credential resolves, this stops
 *               rather than minting a grant.
 *
 * The worker's only capability is `api.datastore.describe()` — one read,
 * mapped straight to `PeekStore.describe()` / `GET /mcp/session`. This host
 * never issues a write against the deployed store.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { normalizeCredentialKey } from '../../apps/desktop/features/mcp-server/credential-key.js';
import { installNetworkGuard, networkLog } from '../feeds-worker-spike/worker-api.mjs';
import { openRemoteStore } from '../../apps/desktop/features/mcp-server/store/remote-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read one token out of the 0600 credential file, by the same key rules
 * `resolveCredentialFromFile()` in `tools/feeds-worker-spike/run.mjs` uses:
 * normalized first, then the raw key. The token is returned and never
 * printed.
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

/**
 * The object `worker.js` sees as `api`. Only what `manifest.json` declares
 * and §5 grants a worker: `log`, and the one `datastore` call this worker
 * uses. The credential lives in `store`, captured by this closure — `api`
 * carries no token anywhere a worker could read one back out.
 */
function buildHelloApi({ store, log = console.log }) {
  return {
    log: (...args) => log('[worker]', ...args),
    datastore: {
      async describe() {
        return store.describe();
      },
    },
    // Deliberately absent, not stubbed: window, shortcuts, izui, filesystem,
    // and every other namespace `docs/workers-design.md` §5 does not grant.
  };
}

const useMemory = process.argv.includes('--memory');

const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const domains = manifest.capabilities?.network?.domains ?? [];
installNetworkGuard(domains);

let store;
if (useMemory) {
  console.log('--memory: no network, the in-memory store stands in for the deployed one.');
  store = await (await import('../feeds-worker-spike/memory-store.mjs')).openMemoryStore();
} else {
  const syncUrl = process.env.PEEK_SYNC_URL;
  if (!syncUrl) {
    console.error(
      'PEEK_SYNC_URL is not set. Pass --memory for an offline run, or set PEEK_SYNC_URL to the deployed sync server.'
    );
    process.exit(1);
  }
  const credentialKey = `${syncUrl}#peek`;
  let credential;
  try {
    credential = resolveCredentialFromFile(credentialKey);
  } catch (err) {
    console.error(`No usable credential resolved for "${credentialKey}": ${err.message}`);
    console.error('Stopping rather than minting a grant.');
    process.exit(1);
  }
  store = await openRemoteStore({ remoteUrl: syncUrl, credential });
}

const api = buildHelloApi({ store });

// No init()/onShutdown lifecycle: hello-worker holds no state between
// invocations, so there is nothing for a shutdown callback to tear down
// (docs/workers-design.md §4). The entry function is imported and run once.
const workerUrl = pathToFileURL(path.join(HERE, manifest.worker.url)).href;
const mod = await import(workerUrl);
const entry = mod[manifest.worker.entry] ?? mod.default;
if (typeof entry !== 'function') {
  console.error(`worker.js does not export an entry function ("${manifest.worker.entry}" or default).`);
  process.exit(1);
}

try {
  await entry(api);
  console.log('\n--- network');
  console.log(`  manifest allows: ${domains.join(', ') || '(nothing)'}`);
  for (const n of networkLog) console.log(`  ${n.allowed ? 'allow' : 'DENY '}  ${n.host}  ${n.url}`);
  console.log('\nhello-worker ok.');
  process.exit(0);
} catch (err) {
  console.error(`\nhello-worker FAILED: ${err?.constructor?.name}: ${err?.message}`);
  process.exit(1);
}
