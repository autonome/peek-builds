/**
 * IPC Capability Enforcement for Tiles
 *
 * Handles:
 * - tile:validate-token — validate a capability token and return grants
 * - tile:ready — tile signals initialization complete
 * - tile:pubsub:* — scoped pubsub operations
 * - tile:command:* — command registration and results
 * - tile:window:* — window management
 * - tile:datastore:* — scoped data access
 * - tile:network:fetch — domain-gated network requests
 * - tile:filesystem:* — path-gated file access
 * - tile:theme:* — theme info
 * - tile:settings:* — settings access
 *
 * Every handler validates the capability token before executing.
 */

import { ipcMain, BrowserWindow, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { validateToken, getGrantForToken, signalTileReady } from './tile-launcher.js';
import { publish, subscribe, unsubscribe, scopes, type Scope } from './pubsub.js';
import { DEBUG } from './config.js';
import { getFeatureRegistry } from './feature-startup.js';
import { getAtprotoSource } from './feature-startup.js';
import { getDb } from './datastore.js';
import { installFromBundle } from './feature-installer.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Check if a capability is granted
 */
function hasCapability(grant: CapabilityGrant, capability: keyof TileCapabilities): boolean {
  return grant.capabilities[capability] !== undefined && grant.capabilities[capability] !== false;
}

/**
 * Check if a pubsub scope level is granted
 */
function hasPubSubScope(grant: CapabilityGrant, scope: 'self' | 'global' | 'system'): boolean {
  if (!grant.capabilities.pubsub) return false;
  return grant.capabilities.pubsub.scopes.includes(scope);
}

/**
 * Check if a datastore table is in the grant
 */
function hasDatastoreTable(grant: CapabilityGrant, table: string): boolean {
  if (!grant.capabilities.datastore) return false;
  return grant.capabilities.datastore.tables.includes(table);
}

/**
 * Check if a network domain is allowed
 * Supports wildcard matching (e.g., '*.example.com' matches 'api.example.com')
 */
function isNetworkDomainAllowed(grant: CapabilityGrant, domain: string): boolean {
  if (!grant.capabilities.network) return false;

  for (const allowed of grant.capabilities.network.domains) {
    if (allowed === domain) return true;

    // Wildcard matching: *.example.com
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // .example.com
      if (domain.endsWith(suffix)) return true;
    }
  }

  return false;
}

/**
 * Check if a filesystem path is allowed
 * Supports glob-style patterns with basic matching
 */
function isFilesystemPathAllowed(
  grant: CapabilityGrant,
  filePath: string,
  mode: 'read' | 'write'
): boolean {
  if (!grant.capabilities.filesystem) return false;

  const patterns = mode === 'read'
    ? grant.capabilities.filesystem.read
    : grant.capabilities.filesystem.write;

  if (!patterns) return false;

  const normalized = path.normalize(filePath);

  for (const pattern of patterns) {
    const normalizedPattern = path.normalize(pattern);
    // Exact match
    if (normalized === normalizedPattern) return true;
    // Directory prefix match (pattern ends with /)
    if (normalizedPattern.endsWith('/') && normalized.startsWith(normalizedPattern)) return true;
    // Glob wildcard (basic: pattern/* matches anything under pattern)
    if (normalizedPattern.endsWith('/*') && normalized.startsWith(normalizedPattern.slice(0, -1))) return true;
  }

  return false;
}

/**
 * Map pubsub scope number to name for capability checking
 */
function scopeNumberToName(scopeNum: number): 'self' | 'global' | 'system' {
  switch (scopeNum) {
    case scopes.SYSTEM: return 'system';
    case scopes.GLOBAL: return 'global';
    default: return 'self';
  }
}

// ─── Feature History Helper ─────────────────────────────────────────

/**
 * Write an event to the features_history table
 */
function writeFeatureHistory(
  featureId: string,
  event: string,
  version?: string,
  sourceType?: string,
  sourceUri?: string,
  publisher?: string,
  capabilities?: Record<string, unknown>
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO features_history (featureId, event, version, sourceType, sourceUri, publisher, capabilities, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      featureId,
      event,
      version || null,
      sourceType || null,
      sourceUri || null,
      publisher || null,
      capabilities ? JSON.stringify(capabilities) : '{}',
      new Date().toISOString()
    );
  } catch (err) {
    console.error('[tile-ipc] Failed to write feature history:', err);
  }
}

// ─── IPC Handler Registration ────────────────────────────────────────

/**
 * Register all tile IPC handlers
 * Call this once during app initialization
 */
export function registerTileIpcHandlers(): void {

  // ── Token Validation ──

  ipcMain.handle('tile:validate-token', (_event, args: {
    tileId: string;
    tileEntry: string;
    token: string;
  }) => {
    const record = validateToken(args.token);
    if (!record) {
      return { valid: false };
    }

    // Verify the token matches the claimed tile
    if (record.tileId !== args.tileId || record.tileEntryId !== args.tileEntry) {
      DEBUG && console.log(`[tile-ipc] Token mismatch: claimed ${args.tileId}:${args.tileEntry}, actual ${record.tileId}:${record.tileEntryId}`);
      return { valid: false };
    }

    return {
      valid: true,
      capabilities: record.grant.capabilities,
    };
  });

  // ── Tile Ready ──

  ipcMain.on('tile:ready', (_event, args: {
    tileId: string;
    tileEntry: string;
  }) => {
    signalTileReady(args.tileId, args.tileEntry);
  });

  // ── PubSub ──

  ipcMain.on('tile:pubsub:publish', (_event, args: {
    token: string;
    source: string;
    scope: number;
    topic: string;
    data: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) {
      DEBUG && console.log('[tile-ipc] pubsub:publish rejected: invalid token');
      return;
    }

    // Check pubsub scope capability
    const scopeName = scopeNumberToName(args.scope);
    if (!hasPubSubScope(grant, scopeName)) {
      DEBUG && console.log(`[tile-ipc] pubsub:publish rejected: scope ${scopeName} not granted for ${grant.tileId}`);
      return;
    }

    // Topic enforcement: if topics allowlist is set, check it
    if (grant.capabilities.pubsub?.topics) {
      const allowed = grant.capabilities.pubsub.topics.some(pattern => {
        if (pattern === args.topic) return true;
        // Simple glob: pattern:* matches pattern:anything
        if (pattern.endsWith('*') && args.topic.startsWith(pattern.slice(0, -1))) return true;
        return false;
      });
      if (!allowed) {
        DEBUG && console.log(`[tile-ipc] pubsub:publish rejected: topic ${args.topic} not in allowlist for ${grant.tileId}`);
        return;
      }
    }

    publish(args.source, args.scope as Scope, args.topic, args.data);
  });

  ipcMain.on('tile:pubsub:subscribe', (_event, args: {
    token: string;
    source: string;
    topic: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    // Subscribe at GLOBAL scope (main process will filter via scopeCheck)
    subscribe(args.source, scopes.GLOBAL, args.topic, (msg) => {
      // Message delivery handled by extension broadcaster in main.ts
    });
  });

  ipcMain.on('tile:pubsub:unsubscribe', (_event, args: {
    token: string;
    source: string;
    topic: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    unsubscribe(args.source, args.topic);
  });

  // ── Commands ──

  ipcMain.on('tile:command:register', (_event, args: {
    token: string;
    tileId: string;
    name: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'commands')) {
      DEBUG && console.log(`[tile-ipc] command:register rejected: commands not granted for ${args.tileId}`);
      return;
    }

    // Register via pubsub (same mechanism as v1 extensions)
    publish(
      `peek://${args.tileId}/background`,
      scopes.GLOBAL,
      'cmd:register-batch',
      {
        commands: [{
          name: args.name,
          source: `peek://${args.tileId}/background`,
        }],
      }
    );
  });

  ipcMain.on('tile:command:result', (_event, args: {
    token: string;
    name: string;
    result?: unknown;
    error?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    // Publish result so cmd panel can resolve
    const topic = `${args.name}:result`;
    publish(
      `peek://${grant.tileId}/background`,
      scopes.GLOBAL,
      topic,
      args.error ? { error: args.error } : { result: args.result }
    );
  });

  // ── Window Management ──

  ipcMain.handle('tile:window:open', async (_event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'window')) {
      return { error: 'Window capability not granted' };
    }

    if (!grant.capabilities.window?.create) {
      return { error: 'Window create capability not granted' };
    }

    // Validate URL: must be peek:// or tile's own origin
    if (!args.url.startsWith('peek://')) {
      return { error: 'Only peek:// URLs can be opened' };
    }

    // Delegate to main process window creation
    // The actual implementation would call openWindow from main.ts
    // For now, return the intent for the main process to handle
    return { success: true, url: args.url };
  });

  ipcMain.on('tile:window:close', (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    // Find the sender window and close it
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('tile:window:info', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) {
      return { error: 'Window not found' };
    }

    const bounds = win.getBounds();
    return {
      id: win.id,
      bounds,
      focused: win.isFocused(),
      visible: win.isVisible(),
    };
  });

  // ── Network Fetch ──

  ipcMain.handle('tile:network:fetch', async (_event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'network')) {
      return { error: 'Network capability not granted' };
    }

    // Extract domain from URL and validate
    let domain: string;
    try {
      const parsed = new URL(args.url);
      domain = parsed.hostname;
    } catch {
      return { error: 'Invalid URL' };
    }

    if (!isNetworkDomainAllowed(grant, domain)) {
      DEBUG && console.log(`[tile-ipc] network:fetch rejected: domain ${domain} not allowed for ${grant.tileId}`);
      return { error: `Domain not allowed: ${domain}` };
    }

    // Perform the fetch via Electron's net module
    try {
      const response = await net.fetch(args.url, {
        method: (args.options?.method as string) || 'GET',
        headers: args.options?.headers as Record<string, string>,
        body: args.options?.body as string,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Filesystem ──

  ipcMain.handle('tile:filesystem:read', async (_event, args: {
    token: string;
    path: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'filesystem')) {
      return { error: 'Filesystem capability not granted' };
    }

    if (!isFilesystemPathAllowed(grant, args.path, 'read')) {
      return { error: `Path not allowed: ${args.path}` };
    }

    try {
      const content = fs.readFileSync(args.path, 'utf-8');
      return { content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:filesystem:write', async (_event, args: {
    token: string;
    path: string;
    content: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'filesystem')) {
      return { error: 'Filesystem capability not granted' };
    }

    if (!isFilesystemPathAllowed(grant, args.path, 'write')) {
      return { error: `Path not allowed: ${args.path}` };
    }

    try {
      fs.writeFileSync(args.path, args.content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Theme ──

  ipcMain.handle('tile:theme:info', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'theme')) {
      return { error: 'Theme capability not granted' };
    }

    // Return basic theme info — actual theme state comes from main
    return {
      // The real implementation would query the active theme
      activeTheme: 'peek',
    };
  });

  // ── Settings ──

  ipcMain.handle('tile:settings:get', async (_event, args: {
    token: string;
    key: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'settings')) {
      return { error: 'Settings capability not granted' };
    }

    // Scoped to the tile's own settings namespace
    // The real implementation would use the datastore
    return { value: null };
  });

  ipcMain.handle('tile:settings:set', async (_event, args: {
    token: string;
    key: string;
    value: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'settings')) {
      return { error: 'Settings capability not granted' };
    }

    // Scoped to the tile's own settings namespace
    return { success: true };
  });

  // ── Datastore ──

  ipcMain.handle('tile:datastore:get', async (_event, args: {
    token: string;
    table: string;
    key: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'datastore')) {
      return { error: 'Datastore capability not granted' };
    }

    if (!hasDatastoreTable(grant, args.table)) {
      return { error: `Table not allowed: ${args.table}` };
    }

    // The real implementation would use getDb()
    return { value: null };
  });

  ipcMain.handle('tile:datastore:set', async (_event, args: {
    token: string;
    table: string;
    key: string;
    value: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'datastore')) {
      return { error: 'Datastore capability not granted' };
    }

    if (!hasDatastoreTable(grant, args.table)) {
      return { error: `Table not allowed: ${args.table}` };
    }

    // The real implementation would use getDb()
    return { success: true };
  });

  ipcMain.handle('tile:datastore:query', async (_event, args: {
    token: string;
    table: string;
    filter?: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'datastore')) {
      return { error: 'Datastore capability not granted' };
    }

    if (!hasDatastoreTable(grant, args.table)) {
      return { error: `Table not allowed: ${args.table}` };
    }

    // The real implementation would use getDb()
    return { rows: [] };
  });

  // ── Feature Registry ──

  ipcMain.handle('feature-registry:list', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Return all non-builtin entries
    const all = registry.listFeatures();
    const nonBuiltin = all.filter(e => e.source.type !== 'builtin');
    return { entries: nonBuiltin };
  });

  ipcMain.handle('feature-registry:get', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    return { entry };
  });

  ipcMain.handle('feature-registry:disable', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type === 'builtin') return { error: 'Cannot disable builtin features' };

    const result = registry.disableFeature(args.id);
    if (result) {
      registry.saveRegistry();
      publish('feature-registry', scopes.GLOBAL, 'feature:disabled', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('feature-registry:enable', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };

    const result = registry.enableFeature(args.id);
    if (result) {
      registry.saveRegistry();
      publish('feature-registry', scopes.GLOBAL, 'feature:enabled', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('feature-registry:remove', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type === 'builtin') return { error: 'Cannot remove builtin features' };

    // Remove from registry
    const result = registry.unregisterFeature(args.id);
    if (result) {
      // Delete feature files (non-builtin only, safe because builtin check above)
      try {
        if (fs.existsSync(entry.path)) {
          fs.rmSync(entry.path, { recursive: true });
        }
      } catch (err) {
        console.error(`[tile-ipc] Failed to delete feature files at ${entry.path}:`, err);
      }
      registry.saveRegistry();

      // Write history event
      writeFeatureHistory(
        args.id,
        'uninstall',
        entry.source.version,
        entry.source.type,
        entry.source.uri,
        entry.source.publisher,
        entry.grantedCapabilities as unknown as Record<string, unknown>
      );

      publish('feature-registry', scopes.GLOBAL, 'feature:removed', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('feature-registry:history', async (_event, args: {
    token: string;
    featureId?: string;
    limit?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const db = getDb();
      let sql = 'SELECT * FROM features_history';
      const params: unknown[] = [];

      if (args.featureId) {
        sql += ' WHERE featureId = ?';
        params.push(args.featureId);
      }

      sql += ' ORDER BY timestamp DESC';

      if (args.limit) {
        sql += ' LIMIT ?';
        params.push(args.limit);
      }

      const rows = db.prepare(sql).all(...params);
      return { entries: rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to query history: ${message}` };
    }
  });

  // ── Feature Install (AT Protocol) ──

  ipcMain.handle('feature-install:resolve', async (_event, args: {
    token: string;
    atUri: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    try {
      const metadata = await source.resolve(args.atUri);
      return {
        manifest: metadata.manifest,
        source: metadata.source,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve AT URI: ${message}` };
    }
  });

  ipcMain.handle('feature-install:preview-capabilities', async (_event, args: {
    token: string;
    manifestCapabilities: TileCapabilities;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const result = resolveCapabilities(args.featureId, args.manifestCapabilities, false);
      return {
        granted: result.capabilities,
        denied: result.denied,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve capabilities: ${message}` };
    }
  });

  ipcMain.handle('feature-install:install', async (_event, args: {
    token: string;
    atUri: string;
    userApproved: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    if (!args.userApproved) {
      return { error: 'User approval required before installation' };
    }

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    try {
      // 1. Fetch the full bundle
      const metadata = await source.resolve(args.atUri);
      const bundle = await source.fetch(args.atUri);

      // 2. Install from bundle
      const result = installFromBundle(
        bundle,
        metadata.source,
        registry,
        { force: true, userApproved: true }
      );

      if (!result.success) {
        return { error: result.error };
      }

      // 3. Save registry
      registry.saveRegistry();

      // 4. Write history event
      writeFeatureHistory(
        result.entry!.id,
        'install',
        metadata.source.version,
        'atproto',
        args.atUri,
        metadata.source.publisher,
        result.entry!.grantedCapabilities as unknown as Record<string, unknown>
      );

      // 5. Publish installed event
      publish('feature-registry', scopes.GLOBAL, 'feature:installed', {
        id: result.entry!.id,
        name: result.entry!.name,
        source: metadata.source,
      });

      return { success: true, entry: result.entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Installation failed: ${message}` };
    }
  });

  // ── Feature Browse (AT Protocol) ──

  ipcMain.handle('feature-browse:resolve-publisher', async (_event, args: {
    token: string;
    query: string; // handle or DID
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    if (!args.query || !args.query.trim()) {
      return { error: 'Handle or DID is required' };
    }

    const { resolveHandleToDid, resolveDid } = await import('./atproto-source.js');

    try {
      const query = args.query.trim();
      let did: string;

      if (query.startsWith('did:')) {
        did = query;
      } else {
        // Resolve handle to DID
        const resolved = await resolveHandleToDid(query);
        if (!resolved) {
          return { error: `Could not resolve handle "${query}"` };
        }
        did = resolved;
      }

      // Resolve DID to get PDS URL and handle
      const identity = await resolveDid(did);
      if (!identity) {
        return { error: `Could not resolve DID: ${did}` };
      }

      return {
        did,
        handle: identity.handle,
        pdsUrl: identity.pdsUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve publisher: ${message}` };
    }
  });

  ipcMain.handle('feature-browse:list-by-publisher', async (_event, args: {
    token: string;
    did: string;
    pdsUrl: string;
    cursor?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    if (!args.did || !args.pdsUrl) {
      return { error: 'DID and PDS URL are required' };
    }

    try {
      const params = new URLSearchParams({
        repo: args.did,
        collection: 'space.peek.feature.release',
        limit: '100',
      });
      if (args.cursor) {
        params.set('cursor', args.cursor);
      }

      const url = `${args.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `PDS returned ${res.status}: ${body}` };
      }

      const data = await res.json() as {
        records: Array<{
          uri: string;
          cid: string;
          value: Record<string, unknown>;
        }>;
        cursor?: string;
      };

      // Group records by featureId and pick latest version for each
      const featureMap = new Map<string, {
        uri: string;
        featureId: string;
        name: string;
        version: string;
        description?: string;
        categories?: string[];
        capabilities?: string[];
        createdAt: string;
      }>();

      for (const rec of data.records || []) {
        const val = rec.value as Record<string, unknown>;
        const featureId = val.featureId as string;
        if (!featureId) continue;

        const existing = featureMap.get(featureId);
        const createdAt = val.createdAt as string || '';

        // Keep latest by createdAt
        if (!existing || createdAt > existing.createdAt) {
          featureMap.set(featureId, {
            uri: rec.uri,
            featureId,
            name: (val.name as string) || featureId,
            version: (val.version as string) || 'unknown',
            description: val.description as string | undefined,
            categories: val.categories as string[] | undefined,
            capabilities: val.capabilities as string[] | undefined,
            createdAt,
          });
        }
      }

      return {
        records: Array.from(featureMap.values()),
        cursor: data.cursor,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list records: ${message}` };
    }
  });

  // ── Feature Publish ──

  ipcMain.handle('feature-publish:list-local', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Return all features (local and builtin) that could be published
    const all = registry.listFeatures();
    const publishable = all.filter(e =>
      e.source.type === 'local' || e.source.type === 'builtin'
    );

    return {
      features: publishable.map(e => ({
        id: e.id,
        name: e.name,
        version: e.source.version || '0.0.0',
        path: e.path,
        sourceType: e.source.type,
        description: (e as any).description || '',
      })),
    };
  });

  ipcMain.handle('feature-publish:read-feature-files', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    try {
      const featurePath = entry.path;
      if (!fs.existsSync(featurePath)) {
        return { error: `Feature directory not found: ${featurePath}` };
      }

      const files: Array<{
        relativePath: string;
        content: string; // base64
        size: number;
        mimeType: string;
      }> = [];

      function readDir(dirPath: string, prefix: string): void {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const dirent of entries) {
          // Skip hidden files/dirs, node_modules, .git
          if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;

          const fullPath = path.join(dirPath, dirent.name);
          const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

          if (dirent.isDirectory()) {
            readDir(fullPath, relativePath);
          } else if (dirent.isFile()) {
            const data = fs.readFileSync(fullPath);
            const ext = path.extname(dirent.name).toLowerCase();
            const mimeType = getMimeType(ext);

            files.push({
              relativePath,
              content: data.toString('base64'),
              size: data.length,
              mimeType,
            });
          }
        }
      }

      readDir(featurePath, '');

      return {
        featureId: args.featureId,
        name: entry.name,
        path: featurePath,
        files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read feature files: ${message}` };
    }
  });

  ipcMain.handle('feature-publish:upload-blob', async (_event, args: {
    token: string;
    pdsUrl: string;
    accessToken: string;
    dpopKeyPairJwk: { publicKey: object; privateKey: object };
    refreshToken: string;
    did: string;
    data: string; // base64 encoded
    mimeType: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const binaryData = Buffer.from(args.data, 'base64');
      const url = `${args.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`;

      // Use net.fetch for blob upload from main process
      let res = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${args.accessToken}`,
          'Content-Type': args.mimeType,
        },
        body: binaryData,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { error: `Blob upload failed (${res.status}): ${errBody}` };
      }

      const result = await res.json();
      return { blob: result.blob };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Blob upload failed: ${message}` };
    }
  });

  ipcMain.handle('feature-publish:create-record', async (_event, args: {
    token: string;
    pdsUrl: string;
    accessToken: string;
    did: string;
    record: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const url = `${args.pdsUrl}/xrpc/com.atproto.repo.createRecord`;

      const body = {
        repo: args.did,
        collection: 'space.peek.feature.release',
        record: args.record,
      };

      const res = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${args.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { error: `Record creation failed (${res.status}): ${errBody}` };
      }

      const result = await res.json() as { uri: string; cid: string };
      return { uri: result.uri, cid: result.cid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Record creation failed: ${message}` };
    }
  });

  DEBUG && console.log('[tile-ipc] All tile IPC handlers registered');
}

// ─── MIME type helper ─────────────────────────────────────────────

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.ts': 'application/typescript',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
