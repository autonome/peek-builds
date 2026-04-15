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

import { ipcMain, BrowserWindow, net, dialog, webContents, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { validateToken, getGrantForToken, signalTileReady, getTileWindow } from './tile-launcher.js';
import { publish, subscribe, unsubscribe, scopes, type Scope } from './pubsub.js';
import { DEBUG } from './config.js';
import { getFeatureRegistry } from './feature-startup.js';
import { getAtprotoSource } from './feature-startup.js';
import { getDb } from './datastore.js';
import { installFromBundle } from './feature-installer.js';
import { resolveCapabilities, validateTileManifest, detectManifestVersion } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';
import { invokeWindowOpen } from './ipc.js';
import { getActiveThemeId } from './protocol.js';

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

// ─── Semver Comparison Helper ───────────────────────────────────────

/**
 * Simple semver comparison. Returns -1, 0, or 1.
 */
function compareSemverSimple(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ─── Capability Comparison Helper ───────────────────────────────────

/**
 * Compare two TileCapabilities for expansion detection.
 * Used by feature-update:apply to guard auto-updates.
 */
function compareCapabilitiesSimple(
  currentCaps: TileCapabilities | undefined,
  newCaps: TileCapabilities | undefined
): { changed: boolean; expanded: boolean; added: string[]; removed: string[] } {
  const result = { changed: false, expanded: false, added: [] as string[], removed: [] as string[] };
  const cur = currentCaps || {} as TileCapabilities;
  const nxt = newCaps || {} as TileCapabilities;

  // Boolean capabilities
  const boolCaps: Array<keyof TileCapabilities> = ['commands', 'shortcuts', 'sync', 'theme', 'settings'];
  for (const cap of boolCaps) {
    const had = !!cur[cap];
    const has = !!nxt[cap];
    if (!had && has) { result.changed = true; result.expanded = true; result.added.push(cap); }
    else if (had && !has) { result.changed = true; result.removed.push(cap); }
  }

  // Network domains
  const curDomains = new Set(cur.network?.domains || []);
  const nxtDomains = new Set(nxt.network?.domains || []);
  for (const d of nxtDomains) {
    if (!curDomains.has(d)) { result.changed = true; result.expanded = true; result.added.push(`network:${d}`); }
  }
  for (const d of curDomains) {
    if (!nxtDomains.has(d)) { result.changed = true; result.removed.push(`network:${d}`); }
  }

  // Datastore tables
  const curTables = new Set(cur.datastore?.tables || []);
  const nxtTables = new Set(nxt.datastore?.tables || []);
  for (const t of nxtTables) {
    if (!curTables.has(t)) { result.changed = true; result.expanded = true; result.added.push(`datastore:${t}`); }
  }
  for (const t of curTables) {
    if (!nxtTables.has(t)) { result.changed = true; result.removed.push(`datastore:${t}`); }
  }

  // PubSub scopes
  const curScopes = new Set(cur.pubsub?.scopes || []);
  const nxtScopes = new Set(nxt.pubsub?.scopes || []);
  for (const s of nxtScopes) {
    if (!curScopes.has(s)) { result.changed = true; result.expanded = true; result.added.push(`pubsub.scope:${s}`); }
  }
  for (const s of curScopes) {
    if (!nxtScopes.has(s)) { result.changed = true; result.removed.push(`pubsub.scope:${s}`); }
  }

  // Window
  if (nxt.window && !cur.window) { result.changed = true; result.expanded = true; result.added.push('window'); }
  else if (cur.window && !nxt.window) { result.changed = true; result.removed.push('window'); }
  else if (cur.window && nxt.window) {
    for (const p of ['create', 'query', 'manage'] as const) {
      const had = !!(cur.window as Record<string, boolean>)[p];
      const has = !!(nxt.window as Record<string, boolean>)[p];
      if (!had && has) { result.changed = true; result.expanded = true; result.added.push(`window.${p}`); }
      else if (had && !has) { result.changed = true; result.removed.push(`window.${p}`); }
    }
  }

  // Filesystem
  if (nxt.filesystem && !cur.filesystem) { result.changed = true; result.expanded = true; result.added.push('filesystem'); }
  else if (cur.filesystem && !nxt.filesystem) { result.changed = true; result.removed.push('filesystem'); }

  return result;
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

  ipcMain.handle('tile:window:open', async (event, args: {
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

    // Delegate to the main window-open handler (registered by registerWindowHandlers()
    // in ipc.ts). This is the single source of truth for window creation — handles
    // canvas rendering, mode inheritance, deduping, session registration, etc.
    if (!invokeWindowOpen) {
      console.error('[tile:window:open] invokeWindowOpen not initialized — registerWindowHandlers() must be called before tile IPC is used');
      return { error: 'Window handler not initialized' };
    }

    const source = `peek://${grant.tileId}/background`;
    DEBUG && console.log(`[tile:window:open] ${grant.tileId} opening ${args.url}`);
    try {
      return await invokeWindowOpen(event, {
        source,
        url: args.url,
        options: args.options || {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tile:window:open] failed for ${grant.tileId}:`, message);
      return { success: false, error: message };
    }
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

    // Return real theme state by querying the active theme + color scheme.
    const themeId = getActiveThemeId();
    const isDark = nativeTheme.shouldUseDarkColors;
    return {
      activeTheme: themeId,
      themeId,
      isDark,
      effectiveScheme: isDark ? 'dark' : 'light',
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

    // Scoped to the tile's own feature_settings namespace.
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
      ).get(grant.tileId, args.key) as { value: string } | undefined;
      if (!row) return { value: null };
      try {
        return { value: JSON.parse(row.value) };
      } catch {
        return { value: row.value };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
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

    // Scoped to the tile's own feature_settings namespace.
    try {
      const db = getDb();
      const jsonValue = JSON.stringify(args.value);
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(`${grant.tileId}_${args.key}`, grant.tileId, args.key, jsonValue, Date.now());
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Datastore ──

  // NOTE: tile:datastore:* are not yet implemented. No feature currently uses them.
  // When a feature needs scoped table access, wire these to getDb() with per-tile
  // row filtering (e.g., WHERE source = grant.tileId) and a SQL allow-list per table.
  // Returning explicit errors avoids silent data loss from pretend-successful writes.

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
    return { error: 'tile:datastore:get not yet implemented — use pubsub + ipc to reach core datastore' };
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
    return { success: false, error: 'tile:datastore:set not yet implemented — no feature currently requires it' };
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
    return { rows: [], error: 'tile:datastore:query not yet implemented — no feature currently requires it' };
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
      // Delete feature files (non-builtin, non-dev only)
      // Dev features: source files owned by developer, only unregister
      if (entry.source.type !== 'dev') {
        try {
          if (fs.existsSync(entry.path)) {
            fs.rmSync(entry.path, { recursive: true });
          }
        } catch (err) {
          console.error(`[tile-ipc] Failed to delete feature files at ${entry.path}:`, err);
        }
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
      e.source.type === 'local' || e.source.type === 'builtin' || e.source.type === 'dev'
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

  // ── Feature Update ──

  ipcMain.handle('feature-update:check-all', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    try {
      // Get all atproto-sourced features
      const all = registry.listFeatures();
      const atprotoFeatures = all.filter(e => e.source.type === 'atproto' && e.source.publisher);

      if (atprotoFeatures.length === 0) {
        return { updates: [] };
      }

      // Group by publisher DID
      const byPublisher = new Map<string, typeof atprotoFeatures>();
      for (const feature of atprotoFeatures) {
        const did = feature.source.publisher!;
        if (!byPublisher.has(did)) {
          byPublisher.set(did, []);
        }
        byPublisher.get(did)!.push(feature);
      }

      const updates: Array<{
        id: string;
        name: string;
        currentVersion: string;
        availableVersion: string;
        atUri: string;
      }> = [];

      for (const [did, pubFeatures] of byPublisher) {
        try {
          // Resolve publisher
          const { resolveDid: resolveDidFn } = await import('./atproto-source.js');
          const identity = await resolveDidFn(did);
          if (!identity) continue;

          // List release records
          const params = new URLSearchParams({
            repo: did,
            collection: 'space.peek.feature.release',
            limit: '100',
          });
          const url = `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
          const res = await fetch(url);
          if (!res.ok) continue;

          const data = await res.json() as {
            records: Array<{ uri: string; value: Record<string, unknown> }>;
          };

          // Build featureId -> latest version map
          const featureMap = new Map<string, { uri: string; version: string; createdAt: string }>();
          for (const rec of data.records || []) {
            const val = rec.value;
            const featureId = val.featureId as string;
            if (!featureId) continue;
            const existing = featureMap.get(featureId);
            const createdAt = (val.createdAt as string) || '';
            if (!existing || createdAt > existing.createdAt) {
              featureMap.set(featureId, {
                uri: rec.uri,
                version: (val.version as string) || '0.0.0',
                createdAt,
              });
            }
          }

          // Compare versions
          for (const feature of pubFeatures) {
            const policy = feature.updatePolicy || 'auto';
            if (policy === 'pinned') continue;

            const currentVersion = feature.source.version || '0.0.0';
            const latest = featureMap.get(feature.id);
            if (!latest) continue;

            if (compareSemverSimple(latest.version, currentVersion) > 0) {
              // Update availableVersion in registry
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = latest.version;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }

              updates.push({
                id: feature.id,
                name: feature.name,
                currentVersion,
                availableVersion: latest.version,
                atUri: latest.uri,
              });
            } else {
              // No update — clear availableVersion, update lastUpdateCheck
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = undefined;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }
            }
          }
        } catch (err) {
          console.error(`[tile-ipc] Update check failed for publisher ${did}:`, err);
        }
      }

      registry.saveRegistry();
      return { updates };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Update check failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:check-one', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type !== 'atproto' || !entry.source.publisher) {
      return { error: 'Feature is not from AT Protocol' };
    }

    try {
      const { resolveDid: resolveDidFn } = await import('./atproto-source.js');
      const identity = await resolveDidFn(entry.source.publisher);
      if (!identity) return { error: `Could not resolve publisher: ${entry.source.publisher}` };

      const params = new URLSearchParams({
        repo: entry.source.publisher,
        collection: 'space.peek.feature.release',
        limit: '100',
      });
      const url = `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return { error: `PDS returned ${res.status}` };

      const data = await res.json() as {
        records: Array<{ uri: string; value: Record<string, unknown> }>;
      };

      // Find latest version for this featureId
      let latestUri = '';
      let latestVersion = '0.0.0';
      let latestCreatedAt = '';

      for (const rec of data.records || []) {
        const val = rec.value;
        if ((val.featureId as string) !== entry.id) continue;
        const createdAt = (val.createdAt as string) || '';
        if (createdAt > latestCreatedAt) {
          latestUri = rec.uri;
          latestVersion = (val.version as string) || '0.0.0';
          latestCreatedAt = createdAt;
        }
      }

      const currentVersion = entry.source.version || '0.0.0';
      entry.lastUpdateCheck = new Date().toISOString();

      if (compareSemverSimple(latestVersion, currentVersion) > 0) {
        entry.availableVersion = latestVersion;
        registry.registerFeature(entry);
        registry.saveRegistry();
        return {
          hasUpdate: true,
          currentVersion,
          availableVersion: latestVersion,
          atUri: latestUri,
        };
      }

      entry.availableVersion = undefined;
      registry.registerFeature(entry);
      registry.saveRegistry();
      return { hasUpdate: false, currentVersion };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Update check failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:apply', async (_event, args: {
    token: string;
    id: string;
    userApproved?: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type !== 'atproto' || !entry.source.uri) {
      return { error: 'Feature is not from AT Protocol' };
    }

    try {
      // Resolve to get latest metadata
      const metadata = await source.resolve(entry.source.uri);
      const newManifest = metadata.manifest;
      const newVersion = metadata.source.version || newManifest.version;
      const currentVersion = entry.source.version || '0.0.0';

      // Validate there is actually a newer version
      if (compareSemverSimple(newVersion || '0.0.0', currentVersion) <= 0) {
        return { error: 'No newer version available' };
      }

      // Check for capability expansion
      const capComparison = compareCapabilitiesSimple(
        entry.grantedCapabilities,
        newManifest.capabilities
      );

      if (capComparison.expanded && !args.userApproved) {
        return {
          error: 'Capabilities expanded — user approval required',
          capabilitiesChanged: true,
          added: capComparison.added,
          removed: capComparison.removed,
        };
      }

      // Fetch and install
      const bundle = await source.fetch(entry.source.uri);
      const installResult = installFromBundle(
        bundle,
        metadata.source,
        registry,
        { force: true, userApproved: args.userApproved || !capComparison.expanded }
      );

      if (!installResult.success) {
        // Log failure
        writeFeatureHistory(
          args.id, 'update-failed', newVersion,
          'atproto', entry.source.uri, entry.source.publisher
        );
        return { error: installResult.error };
      }

      // Clear availableVersion
      const updatedEntry = registry.getFeature(args.id);
      if (updatedEntry) {
        updatedEntry.availableVersion = undefined;
        updatedEntry.lastUpdateCheck = new Date().toISOString();
        registry.registerFeature(updatedEntry);
      }

      registry.saveRegistry();

      // Write history
      writeFeatureHistory(
        args.id, 'update', newVersion,
        'atproto', entry.source.uri, entry.source.publisher,
        installResult.entry?.grantedCapabilities as unknown as Record<string, unknown>
      );

      // Publish event
      publish('feature-registry', scopes.GLOBAL, 'feature:updated', {
        id: args.id,
        name: entry.name,
        previousVersion: currentVersion,
        newVersion,
      });

      return { success: true, entry: installResult.entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFeatureHistory(
        args.id, 'update-failed', undefined,
        'atproto', entry.source.uri, entry.source.publisher
      );
      return { error: `Update failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:set-policy', async (_event, args: {
    token: string;
    id: string;
    policy: 'auto' | 'notify' | 'pinned';
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };

    const validPolicies = ['auto', 'notify', 'pinned'];
    if (!validPolicies.includes(args.policy)) {
      return { error: `Invalid policy: ${args.policy}` };
    }

    entry.updatePolicy = args.policy;

    if (args.policy === 'pinned') {
      entry.pinnedVersion = entry.source.version;
    } else {
      entry.pinnedVersion = undefined;
    }

    registry.registerFeature(entry);
    registry.saveRegistry();

    return { success: true, policy: entry.updatePolicy, pinnedVersion: entry.pinnedVersion };
  });

  // ── Feature Dev Workflow ──

  ipcMain.handle('feature-dev:pick-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose directory for new feature',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      return { path: result.filePaths[0] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open directory picker: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:create', async (_event, args: {
    token: string;
    directoryPath: string;
    featureId: string;
    featureName: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Validate featureId: lowercase, alphanumeric + hyphens, no spaces
    const idRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    if (!args.featureId || args.featureId.length < 2 || !idRegex.test(args.featureId)) {
      return { error: 'Feature ID must be lowercase alphanumeric with hyphens (min 2 chars, no leading/trailing hyphens)' };
    }

    if (!args.featureName || !args.featureName.trim()) {
      return { error: 'Feature name is required' };
    }

    // Check the parent directory exists
    const parentDir = path.dirname(args.directoryPath);
    if (!fs.existsSync(parentDir)) {
      return { error: `Parent directory does not exist: ${parentDir}` };
    }

    // Check for conflicts in registry
    const existing = registry.getFeature(args.featureId);
    if (existing) {
      return { error: `Feature "${args.featureId}" is already registered in the registry` };
    }

    try {
      // Create directory if it doesn't exist
      if (!fs.existsSync(args.directoryPath)) {
        fs.mkdirSync(args.directoryPath, { recursive: true });
      }

      const featureId = args.featureId;
      const featureName = args.featureName.trim();

      // Write scaffold files
      const manifestContent = JSON.stringify({
        manifestVersion: 2,
        id: featureId,
        name: featureName,
        version: '0.1.0',
        description: '',
        tiles: [
          {
            id: 'background',
            type: 'background',
            url: 'background.html',
            lazy: true,
          },
          {
            id: 'home',
            type: 'window',
            url: 'home.html',
            windowHints: {
              width: 800,
              height: 600,
              title: featureName,
            },
          },
        ],
        capabilities: {
          pubsub: { scopes: ['self', 'global'] },
          commands: true,
        },
        commands: [
          {
            name: featureId,
            description: `Open ${featureName}`,
            action: { type: 'window', url: 'home.html' },
          },
        ],
      }, null, 2);

      const backgroundHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
  <title>${featureName} Background</title>
</head>
<body>
<script type="module">
  import { init, uninit } from './background.js';

  const api = window.app;
  const hasPeekAPI = !!api;

  if (hasPeekAPI && typeof api.initialize === 'function') {
    // V2 Tile Runtime
    if (api.pubsub && !api.publish) {
      api.publish = api.pubsub.publish;
      api.subscribe = api.pubsub.subscribe;
    }

    await api.initialize();

    if (init) await init();

    api.onShutdown(() => {
      if (uninit) uninit();
    });
  } else if (hasPeekAPI) {
    // V1 Legacy Runtime
    if (init) await init();

    api.publish('ext:ready', {
      id: '${featureId}',
      registeredTopics: Object.keys(window._cmdHandlers || {}).map(n => \`cmd:execute:\${n}\`),
      manifest: { id: '${featureId}', version: '0.1.0' }
    }, api.scopes.SYSTEM);

    api.subscribe('app:shutdown', () => {
      if (uninit) uninit();
    }, api.scopes.SYSTEM);
  }
<${'/'}script>
</body>
</html>`;

      const backgroundJs = `/**
 * ${featureName} — Background script
 *
 * This runs in a hidden background context. Use it for:
 * - Registering commands
 * - Subscribing to events
 * - Background processing
 *
 * Export init() to run setup, uninit() for cleanup.
 */

const api = window.app;

export async function init() {
  console.log('[${featureId}] Background initialized');

  // Register commands, subscribe to events, etc.
  // Example:
  // api.commands.register({
  //   name: '${featureId}',
  //   description: 'Open ${featureName}',
  //   execute: () => {
  //     api.window.open('peek://${featureId}/home.html', {
  //       key: '${featureId}-home',
  //       width: 800,
  //       height: 600,
  //       title: '${featureName}'
  //     });
  //   }
  // });
}

export function uninit() {
  console.log('[${featureId}] Background shutdown');
}
`;

      const homeHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1">
  <title>${featureName}</title>
  <link rel="stylesheet" type="text/css" href="home.css">
</head>
<body>
  <header class="header">
    <h1 class="header-title">${featureName}</h1>
  </header>

  <main class="content">
    <div class="welcome">
      <h2>Welcome to ${featureName}</h2>
      <p>Edit <code>home.html</code>, <code>home.js</code>, and <code>home.css</code> to build your feature UI.</p>
      <p>Use the Reload button in the Features Manager to see changes without restarting.</p>
    </div>
  </main>

  <script>
    // V2 tile runtime compat shims
    (function() {
      const api = window.app;
      if (!api) return;
      const isTileV2 = typeof api.initialize === 'function';
      if (!isTileV2) return;
      if (api.pubsub && !api.publish) {
        api.publish = api.pubsub.publish;
        api.subscribe = api.pubsub.subscribe;
      }
    })();
  <${'/'}script>
  <script type="module" src="home.js"><${'/'}script>
</body>
</html>`;

      const homeJs = `/**
 * ${featureName} — Home page script
 *
 * This is the main UI for your feature.
 * The Peek API is available at window.app
 */

const api = window.app;
const hasPeekAPI = !!api;

async function init() {
  if (hasPeekAPI && typeof api.initialize === 'function') {
    await api.initialize();
  }

  console.log('[${featureId}] Home page loaded');

  // Your UI logic here
}

init();
`;

      const homeCss = `/* Import Peek theme variables */
@import url('peek://theme/variables.css');

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-family: var(--theme-font-sans);
  -webkit-font-smoothing: antialiased;
  font-size: 14px;
  line-height: 1.5;
}

body {
  background: var(--base00);
  color: var(--base05);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--base02);
  -webkit-app-region: drag;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--base05);
}

.content {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

.welcome {
  max-width: 480px;
  margin: 40px auto;
  text-align: center;
}

.welcome h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--base05);
  margin-bottom: 12px;
}

.welcome p {
  font-size: 13px;
  color: var(--base04);
  margin-bottom: 8px;
}

.welcome code {
  background: var(--base01);
  border: 1px solid var(--base02);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: var(--theme-font-mono, monospace);
  font-size: 12px;
}
`;

      // Write all scaffold files
      fs.writeFileSync(path.join(args.directoryPath, 'manifest.json'), manifestContent, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'background.html'), backgroundHtml, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'background.js'), backgroundJs, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.html'), homeHtml, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.js'), homeJs, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.css'), homeCss, 'utf-8');

      // Resolve capabilities (dev = all granted, like builtin)
      const manifestParsed = JSON.parse(manifestContent);
      const capGrant = resolveCapabilities(featureId, manifestParsed.capabilities, true);

      // Register in feature registry
      const entry = {
        id: featureId,
        name: featureName,
        path: args.directoryPath,
        source: {
          type: 'dev' as const,
          version: '0.1.0',
        },
        grantedCapabilities: capGrant.capabilities,
        userApproved: true,
        installedAt: new Date().toISOString(),
      };

      registry.registerFeature(entry);
      registry.saveRegistry();

      // Write history event
      writeFeatureHistory(featureId, 'install', '0.1.0', 'dev');

      // Publish installed event
      publish('feature-registry', scopes.GLOBAL, 'feature:installed', {
        id: featureId,
        name: featureName,
        source: { type: 'dev' },
      });

      return { success: true, entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create feature: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:reload', async (_event, args: {
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
      // Strategy: find any webContents whose URL starts with peek://{featureId}/
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let reloaded = 0;

      for (const wc of allContents) {
        const url = wc.getURL();
        if (url.startsWith(urlPrefix)) {
          wc.reload();
          reloaded++;
          continue;
        }

        // Also check frames in extension host (iframes)
        try {
          const mainFrame = wc.mainFrame;
          for (const frame of mainFrame.framesInSubtree) {
            if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
              // Reload the iframe by navigating it again
              frame.executeJavaScript('location.reload()');
              reloaded++;
            }
          }
        } catch {
          // Some webContents may not have frames accessible
        }
      }

      // Also try the tile launcher's tracked windows
      const manifest = entry.path ? JSON.parse(
        fs.readFileSync(path.join(entry.path, 'manifest.json'), 'utf-8')
      ) : null;

      if (manifest && manifest.tiles) {
        for (const tile of manifest.tiles) {
          const win = getTileWindow(args.featureId, tile.id);
          if (win && !win.isDestroyed()) {
            win.webContents.reload();
            reloaded++;
          }
        }
      }

      if (reloaded === 0) {
        return { success: true, message: 'No active tiles found to reload. Feature will load on next launch.' };
      }

      return { success: true, message: `Reloaded ${reloaded} tile(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to reload feature: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:open-devtools', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let opened = 0;

      // First try direct BrowserWindows with matching URLs
      for (const wc of allContents) {
        const url = wc.getURL();
        if (url.startsWith(urlPrefix)) {
          wc.openDevTools();
          opened++;
        }
      }

      // If no direct match, check extension host frames
      if (opened === 0) {
        for (const wc of allContents) {
          try {
            const mainFrame = wc.mainFrame;
            for (const frame of mainFrame.framesInSubtree) {
              if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
                // For iframes in extension host, open devtools on the host window
                // (Electron doesn't support opening devtools on individual frames)
                wc.openDevTools();
                opened++;
                break;
              }
            }
          } catch {
            // Skip inaccessible webContents
          }
          if (opened > 0) break;
        }
      }

      if (opened === 0) {
        return { error: 'No active tiles found. The feature may not be loaded yet.' };
      }

      return { success: true, message: `Opened DevTools for ${opened} context(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open DevTools: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:validate', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const featurePath = entry.path;

      // Check directory exists
      if (!fs.existsSync(featurePath)) {
        return { valid: false, errors: [`Feature directory not found: ${featurePath}`], warnings: [] };
      }

      // Read and validate manifest
      const manifestPath = path.join(featurePath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { valid: false, errors: ['manifest.json not found'], warnings: [] };
      }

      let raw: Record<string, unknown>;
      try {
        const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
        raw = JSON.parse(manifestJson);
      } catch (parseErr) {
        return { valid: false, errors: [`Invalid JSON in manifest.json: ${parseErr}`], warnings: [] };
      }

      // Check manifest version
      const version = detectManifestVersion(raw);
      if (version !== 'v2') {
        errors.push(`Manifest is ${version}, expected v2`);
      }

      // Run schema validation
      const validationErrors = validateTileManifest(raw);
      for (const ve of validationErrors) {
        errors.push(`${ve.path}: ${ve.message}`);
      }

      // Check that all files referenced in tiles[].url exist on disk
      const tiles = raw.tiles as Array<{ id: string; url: string }> | undefined;
      if (tiles && Array.isArray(tiles)) {
        for (const tile of tiles) {
          if (tile.url) {
            const tilePath = path.join(featurePath, tile.url);
            if (!fs.existsSync(tilePath)) {
              errors.push(`Tile "${tile.id}" references "${tile.url}" which does not exist`);
            }
          }
        }
      }

      // Check settingsSchema file if declared
      const settingsSchema = raw.settingsSchema as string | undefined;
      if (settingsSchema) {
        const schemaPath = path.join(featurePath, settingsSchema);
        if (!fs.existsSync(schemaPath)) {
          errors.push(`Settings schema file "${settingsSchema}" not found`);
        }
      }

      // Warnings for common issues
      if (!raw.description || (raw.description as string).trim() === '') {
        warnings.push('No description set in manifest');
      }
      if (!raw.version) {
        warnings.push('No version set in manifest');
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [`Validation failed: ${message}`], warnings: [] };
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
