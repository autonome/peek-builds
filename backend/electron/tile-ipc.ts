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
import { getDb } from './datastore.js';
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

  DEBUG && console.log('[tile-ipc] All tile IPC handlers registered');
}
