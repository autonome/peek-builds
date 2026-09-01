/**
 * HTTP implementation of the PeekStore interface (see `./types.js`), talking
 * to the `/mcp/*` API on `apps/server` (docs/mcp-remote-backend-design.md
 * §2.1, §5, §7.1). Every method below is a thin wrapper around one HTTP
 * request against that API; the response shapes it returns are byte-
 * identical to `sqlite-store.js`'s, so `server.js` cannot tell which
 * implementation it is talking to.
 *
 * Three behaviors this file exists to hold the line on:
 *
 *  - No cache, no read-through, no write queue (§7.1). A request that can't
 *    reach the server is a thrown error naming the server — never a
 *    degraded/empty result an agent could mistake for "no matching items".
 *    A short retry (three attempts, exponential backoff, ~2s ceiling) covers
 *    only transient network blips; an HTTP response that DID arrive (even an
 *    error status) is a real answer from a reachable server and is not
 *    retried.
 *  - The unexpanded-`${VAR}` guard (§6). Claude Code expands `${VAR}`
 *    entries in `.mcp.json` from the launching shell's environment; when the
 *    referenced variable is unset it passes the literal text through rather
 *    than failing. `setup.js` writes both `PEEK_MCP_REMOTE_URL` and
 *    `PEEK_MCP_TOKEN` in that reference form, so both are checked here,
 *    once, at open time — before any request goes out — rather than left to
 *    surface as an opaque `401` or a dial to a literal `${...}` host.
 *  - Prefix resolution costs one HTTP request, never one per candidate (§5).
 *    `resolveItemId()` forwards `GET /mcp/items/resolve`'s response body
 *    unchanged — it already IS the `ResolveResult` shape, ambiguity payload
 *    included, so `server.js formatAmbiguous()` (fed via
 *    `resolveItemIdFromArgs()`) keeps producing identical text without this
 *    file knowing anything about that function.
 *
 * The credential (`config.credential`) is treated as an opaque, already-
 * resolved bearer token by this file — never logged, never included in an
 * error message or a thrown stack. Which of §6's two mechanisms produced it
 * (an env var reference vs. the `~/.config/peek/mcp-credentials.json` lookup)
 * is resolved by the caller before `openRemoteStore()` is called.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_CEILING_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Claude Code expands "${VAR}" / "${VAR:-default}" entries in .mcp.json from
// the launching shell's environment (docs/mcp-remote-backend-design.md §6).
// When the referenced variable is unset it warns and passes the literal
// "${VAR}" text through rather than failing — sent unexamined that becomes a
// bearer token of the literal string, or a fetch against the literal host
// "${PEEK_SYNC_URL}". setup.js writes both PEEK_MCP_REMOTE_URL and
// PEEK_MCP_TOKEN in reference form, so both get this guard.
function assertResolved(value, varName) {
  if (typeof value === 'string' && value.startsWith('${')) {
    throw new Error(
      `${varName} was not expanded — the variable is unset in the environment Claude Code was launched from.`
    );
  }
}

function joinTags(tags) {
  return Array.isArray(tags) && tags.length > 0 ? tags.join(',') : undefined;
}

/**
 * Open a `PeekStore` backed by the `/mcp/*` HTTP API.
 *
 * @param {import('./types').StoreConfig} config
 * @returns {Promise<import('./types').PeekStore>}
 */
export async function openRemoteStore({ remoteUrl, credential } = {}) {
  assertResolved(remoteUrl, 'PEEK_MCP_REMOTE_URL');
  const baseUrl = (remoteUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('openRemoteStore() requires remoteUrl.');
  }

  assertResolved(credential, 'PEEK_MCP_TOKEN');
  const token = (credential || '').trim();

  // --- Transport ---
  //
  // The single request path every method below funnels through. Retries
  // cover only a `fetch()` that never got a response at all (DNS failure,
  // connection refused, timeout) — never a response that arrived with an
  // error status, which is a real answer from a reachable server.
  async function request(method, path, { query, body } = {}) {
    let url = `${baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let lastErr;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        const text = await res.text();
        let parsed = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch { /* non-JSON body, leave null */ }
        }
        return { status: res.status, body: parsed };
      } catch (err) {
        // Transport-level failure only (fetch threw before/without a
        // response) — the case §7.1 covers with a short retry.
        lastErr = err;
        if (attempt < RETRY_ATTEMPTS) {
          const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CEILING_MS);
          await sleep(delay);
        }
      }
    }
    // Retries exhausted: surface a tool error naming the unreachable server,
    // never a degraded/empty result (§7.1). `lastErr.message` is a transport
    // diagnostic (ECONNREFUSED, timeout, …) — never the token.
    throw new Error(`Peek remote store unreachable at ${baseUrl}: ${lastErr.message}`);
  }

  // A response that DID arrive but wasn't handled by a route's own status
  // branches (401 unauthorized, 500, …) — still a tool error, not a network
  // one, so it gets its own wording rather than "unreachable".
  function unexpectedStatus(action, status, body) {
    const detail = body && body.error ? body.error : `unexpected response`;
    return new Error(`Peek remote store: ${action} failed (HTTP ${status}): ${detail}`);
  }

  // --- Reads ---

  async function queryItems({ tags, type, limit, offset, sort } = {}) {
    const { status, body } = await request('GET', '/mcp/items', {
      query: { tags: joinTags(tags), type, limit, offset, sort },
    });
    if (status !== 200) throw unexpectedStatus('list_items', status, body);
    return body.items;
  }

  async function searchItems({ query, tags, type, limit, offset } = {}) {
    const { status, body } = await request('GET', '/mcp/items/search', {
      query: { q: query || '', tags: joinTags(tags), type, limit, offset },
    });
    if (status !== 200) throw unexpectedStatus('search_items', status, body);
    return body.items;
  }

  // Ambiguity here is not exercised by server.js's current dispatch — it
  // always resolves via resolveItemId() first (see the module doc comment)
  // — but a caller that hands getItem()/getTaskContext() a raw prefix
  // directly still gets a clear error rather than a silently wrong item.
  function ambiguousError(prefix, candidates, truncated) {
    const lines = (candidates || []).map((c) => `  ${c.id}  ${c.title || '(untitled)'}`);
    return new Error(
      `Ambiguous item id prefix "${prefix}" matches ${candidates.length}${truncated ? '+' : ''} items:\n` +
      lines.join('\n') +
      `\nPass more of the id (or the full id) to disambiguate.`
    );
  }

  async function getItem(id, opts = {}) {
    const { status, body } = await request('GET', `/mcp/items/${encodeURIComponent(id)}`, {
      query: {
        maxContentLength: opts.maxContentLength,
        contentOffset: opts.contentOffset,
        events: opts.events,
      },
    });
    if (status === 404) return null;
    if (status === 409) throw ambiguousError(id, body?.candidates, body?.truncated);
    if (status !== 200) throw unexpectedStatus('get_item', status, body);
    return body.item;
  }

  async function getItemTags(id) {
    // No standalone tags-only endpoint exists (design doc §3.3's table) —
    // fetch the item and read its tags. Costs a fuller response than the
    // sqlite path's dedicated query, but the tag list is the only thing
    // read.
    const item = await getItem(id);
    return item ? item.tags : [];
  }

  async function resolveItemId(prefix) {
    const { status, body } = await request('GET', '/mcp/items/resolve', { query: { prefix } });
    if (status !== 200) throw unexpectedStatus('resolve item id', status, body);
    // Byte-identical ResolveResult shape already (design doc §5) — forward
    // as-is so server.js formatAmbiguous() keeps producing identical text.
    return body || { id: null };
  }

  async function listTags({ search, limit } = {}) {
    const { status, body } = await request('GET', '/mcp/tags', { query: { search, limit } });
    if (status !== 200) throw unexpectedStatus('list_tags', status, body);
    return body.tags;
  }

  async function listTasks({ tags = ['todo'], project } = {}) {
    // Composes to the same list_items call the sqlite path uses (design doc
    // §3.3: "no endpoint" for list_tasks) — no separate request.
    const allTags = [...tags];
    if (project) allTags.push(project);
    return queryItems({ tags: allTags, sort: 'recent' });
  }

  async function getTaskContext(id) {
    // Always requests events — matches getTaskContextSync()'s fixed 20-row
    // window; there is no per-call events option on this tool's surface.
    const { status, body } = await request('GET', `/mcp/items/${encodeURIComponent(id)}`, {
      query: { events: 20 },
    });
    if (status === 404) return null;
    if (status === 409) throw ambiguousError(id, body?.candidates, body?.truncated);
    if (status !== 200) throw unexpectedStatus('get_task_context', status, body);
    return body.item;
  }

  async function describe() {
    const { status, body } = await request('GET', '/mcp/session');
    if (status !== 200) throw unexpectedStatus('describe', status, body);
    return {
      scopeTag: body.scopeTag,
      readonly: body.readonly,
      profileId: body.profileId,
      datastoreVersion: body.datastoreVersion,
      backend: 'remote',
    };
  }

  // --- Writes ---

  async function createItem(input) {
    const { status, body } = await request('POST', '/mcp/items', { body: input });
    if (status !== 200) throw unexpectedStatus('create_item', status, body);
    return body.item;
  }

  async function updateItem(id, patch) {
    const { status, body } = await request('PATCH', `/mcp/items/${encodeURIComponent(id)}`, { body: patch });
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('update_item', status, body);
    return body.item;
  }

  async function deleteItem(id) {
    const { status, body } = await request('DELETE', `/mcp/items/${encodeURIComponent(id)}`);
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('delete_item', status, body);
    return body;
  }

  async function tagItem(id, tagName) {
    const { status, body } = await request('POST', `/mcp/items/${encodeURIComponent(id)}/tags`, {
      body: { name: tagName },
    });
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('tag_item', status, body);
    return body;
  }

  async function untagItem(id, tagName) {
    const { status, body } = await request(
      'DELETE',
      `/mcp/items/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagName)}`
    );
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('untag_item', status, body);
    // 200 covers both {success:true,...} and the sqlite-parity
    // {success:false, error:'Tag not found'} shape — forwarded as-is.
    return body;
  }

  async function recordEvent(id, type, value, opts = {}) {
    const { content, occurredAt, metadata } = opts;
    const { status, body } = await request('POST', `/mcp/items/${encodeURIComponent(id)}/events`, {
      body: { type, value, content, occurredAt, metadata },
    });
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('record_event', status, body);
    return body;
  }

  async function listEvents(id, { limit, offset } = {}) {
    const { status, body } = await request('GET', `/mcp/items/${encodeURIComponent(id)}/events`, {
      query: { limit, offset },
    });
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('list_events', status, body);
    return body.events;
  }

  async function deleteEvent(id, eventId) {
    const { status, body } = await request(
      'DELETE',
      `/mcp/items/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}`
    );
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('delete_event', status, body);
    // 200 covers both {success:true,...} and the sqlite-parity
    // {success:false, error:'Event not found'} shape — forwarded as-is.
    return body;
  }

  async function deleteEvents(id) {
    const { status, body } = await request('DELETE', `/mcp/items/${encodeURIComponent(id)}/events`);
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('delete_events', status, body);
    return body;
  }

  async function completeTask(id, notes) {
    const { status, body } = await request('POST', `/mcp/tasks/${encodeURIComponent(id)}/complete`, {
      body: { notes },
    });
    if (status === 404) throw new Error(`No item found with id "${id}".`);
    if (status !== 200) throw unexpectedStatus('complete_task', status, body);
    return body.item;
  }

  async function close() {
    // No persistent connection to release — each request is a standalone
    // fetch.
  }

  return {
    queryItems,
    searchItems,
    getItem,
    getItemTags,
    resolveItemId,
    createItem,
    updateItem,
    deleteItem,
    listTags,
    tagItem,
    untagItem,
    recordEvent,
    listEvents,
    deleteEvent,
    deleteEvents,
    listTasks,
    completeTask,
    getTaskContext,
    describe,
    close,
  };
}
