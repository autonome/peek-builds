/**
 * Electron protocol handling for peek:// scheme
 *
 * Handles:
 * - peek://app/{path} - Core app files
 * - peek://ext/{ext-id}/{path} - Extension content
 * - peek://extensions/{path} - Shared extension infrastructure
 * - peek://theme/{path} - Current theme files (vars.css, manifest.json)
 * - peek://theme/{themeId}/{path} - Specific theme files
 */

import { protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDb } from './datastore.js';
import { DEBUG } from './config.js';

export const APP_SCHEME = 'peek';
export const APP_PROTOCOL = `${APP_SCHEME}:`;

// Extension path cache: extensionId -> filesystem path
const extensionPaths = new Map<string, string>();

// Theme path cache: themeId -> filesystem path
const themePaths = new Map<string, string>();

// Active theme ID (defaults to peek)
let activeThemeId = 'peek';

// Root directory (set during init)
let rootDir: string;

// Bare import map for resolving npm package imports
// Maps bare specifiers (e.g., 'lit') to node_modules paths
const BARE_IMPORT_MAP: Record<string, string> = {
  'lit': 'node_modules/lit/index.js',
  'lit/': 'node_modules/lit/',
  '@lit/reactive-element': 'node_modules/@lit/reactive-element/reactive-element.js',
  '@lit/reactive-element/': 'node_modules/@lit/reactive-element/',
  'lit-html': 'node_modules/lit-html/lit-html.js',
  'lit-html/': 'node_modules/lit-html/',
  'lit-element': 'node_modules/lit-element/lit-element.js',
  'lit-element/': 'node_modules/lit-element/'
};

/**
 * Fetch a local file, logging a warning if it doesn't exist.
 * Replaces bare net.fetch(fileURL) calls so we get visibility into 404s.
 * Returns no-cache headers to prevent Chromium from serving stale app files.
 */
async function fetchFile(absolutePath: string, requestUrl: string): Promise<Response> {
  if (!fs.existsSync(absolutePath)) {
    console.error(`[protocol] FILE NOT FOUND: ${absolutePath} (requested: ${requestUrl})`);
    return new Response('Not Found', { status: 404 });
  }
  const fileURL = pathToFileURL(absolutePath).toString();
  const response = await net.fetch(fileURL);
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
}

/**
 * Resolve a bare import specifier to a file path
 * @param specifier - Bare import like 'lit' or 'lit/decorators.js'
 * @returns Resolved path relative to rootDir, or null if not found
 */
function resolveBareImport(specifier: string): string | null {
  // Direct match
  if (BARE_IMPORT_MAP[specifier]) {
    return BARE_IMPORT_MAP[specifier];
  }

  // Subpath match (e.g., 'lit/decorators.js' matches 'lit/')
  for (const [prefix, basePath] of Object.entries(BARE_IMPORT_MAP)) {
    if (prefix.endsWith('/') && specifier.startsWith(prefix)) {
      const subpath = specifier.slice(prefix.length);
      return basePath + subpath;
    }
  }

  return null;
}

/**
 * Register the peek:// scheme as privileged
 * MUST be called before app.ready
 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: false,
      allowServiceWorkers: false
    }
  }]);
}

/**
 * Register a built-in extension path
 */
export function registerExtensionPath(id: string, fsPath: string): void {
  extensionPaths.set(id, fsPath);
  DEBUG && console.log('Registered extension path:', id, fsPath);
}

/**
 * Get all registered built-in extension IDs
 */
export function getRegisteredExtensionIds(): string[] {
  return Array.from(extensionPaths.keys());
}

/**
 * Register a built-in theme path
 */
export function registerThemePath(id: string, fsPath: string): void {
  themePaths.set(id, fsPath);
  DEBUG && console.log('Registered theme path:', id, fsPath);
}

/**
 * Get all registered theme IDs
 */
export function getRegisteredThemeIds(): string[] {
  return Array.from(themePaths.keys());
}

/**
 * Get theme filesystem path by ID
 * First checks built-in themes, then could check datastore for custom themes
 */
export function getThemePath(id: string): string | null {
  // Check built-in themes first
  const builtinPath = themePaths.get(id);
  if (builtinPath) return builtinPath;

  // TODO: Check datastore for custom themes
  return null;
}

/**
 * Get the active theme ID
 */
export function getActiveThemeId(): string {
  return activeThemeId;
}

/**
 * Set the active theme ID
 */
export function setActiveThemeId(id: string): boolean {
  const themePath = getThemePath(id);
  if (!themePath) {
    console.error('Theme not found:', id);
    return false;
  }
  activeThemeId = id;
  DEBUG && console.log('Active theme set to:', id);
  return true;
}

/**
 * Get extension filesystem path by ID
 * First checks built-in extensions, then datastore for external extensions
 */
export function getExtensionPath(id: string): string | null {
  // Check built-in extensions first
  const builtinPath = extensionPaths.get(id);
  if (builtinPath) return builtinPath;

  // Check datastore for external extensions
  try {
    const db = getDb();
    const ext = db.prepare('SELECT * FROM extensions WHERE id = ?').get(id) as { path?: string } | undefined;
    if (ext && ext.path) {
      return ext.path;
    }

    // Also check by shortname (stored in metadata)
    const allExts = db.prepare('SELECT * FROM extensions').all() as Array<{ path?: string; metadata?: string }>;
    for (const extData of allExts) {
      try {
        const metadata = JSON.parse(extData.metadata || '{}');
        if (metadata.shortname === id && extData.path) {
          return extData.path;
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  } catch {
    // Database not initialized yet
  }

  return null;
}

/**
 * The protocol request handler - extracted so it can be registered on multiple sessions
 */
async function handleProtocolRequest(req: Request): Promise<Response> {
  try {
    let { host, pathname } = new URL(req.url);

    // trim leading slash
    pathname = pathname.replace(/^\//, '');

    // Handle bare imports (e.g., peek://lit or peek://app/components/lit)
    // When modules import 'lit', browser resolves relative to module URL
    // So peek://app/components/peek-input.js importing 'lit' becomes peek://app/components/lit
    // We need to extract just the bare specifier part
    const fullPath = pathname ? `${host}/${pathname}` : host;

    // Try direct resolution first (e.g., peek://lit)
    let bareSpecifier = fullPath;
    let resolvedPath = resolveBareImport(bareSpecifier);

    // If that fails, check if pathname contains a known bare import
    // e.g., peek://app/components/lit -> extract 'lit'
    if (!resolvedPath && pathname) {
      const pathParts = pathname.split('/');
      // Check each part from the end to find a bare import
      for (let i = pathParts.length - 1; i >= 0; i--) {
        const candidateSpecifier = pathParts.slice(i).join('/');
        resolvedPath = resolveBareImport(candidateSpecifier);
        if (resolvedPath) {
          bareSpecifier = candidateSpecifier;
          break;
        }
      }
    }

    if (resolvedPath) {
      DEBUG && console.log(`[protocol] Resolved bare import: ${bareSpecifier} -> ${resolvedPath}`);
      const absolutePath = path.resolve(rootDir, resolvedPath);
      return fetchFile(absolutePath, req.url);
    }

    // Handle extension content: peek://ext/{ext-id}/{path}
    if (host === 'ext') {
      const parts = pathname.split('/');
      const extId = parts[0];
      const extPath = parts.slice(1).join('/') || 'index.html';

      const extBasePath = getExtensionPath(extId);
      if (!extBasePath) {
        DEBUG && console.log('Extension not found:', extId);
        return new Response('Extension not found', { status: 404 });
      }

      const absolutePath = path.resolve(extBasePath, extPath);

      // Security: ensure path stays within extension folder
      const normalizedBase = path.normalize(extBasePath);
      if (!absolutePath.startsWith(normalizedBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      DEBUG && console.log(`[protocol] ext ${extId}/${extPath} -> ${absolutePath}`);

      return fetchFile(absolutePath, req.url);
    }

    // Handle extensions infrastructure: peek://extensions/{path}
    // This serves the extension loader and other shared extension code
    if (host === 'extensions') {
      const absolutePath = path.resolve(rootDir, 'features', pathname);

      // Security: ensure path stays within features folder
      const extensionsBase = path.resolve(rootDir, 'features');
      if (!absolutePath.startsWith(extensionsBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      return fetchFile(absolutePath, req.url);
    }

    // Handle theme files: peek://theme/{path} or peek://theme/{themeId}/{path}
    if (host === 'theme') {
      const parts = pathname.split('/');
      let themeId: string;
      let themePath: string;

      // Check if first part is a known theme ID
      const possibleThemeId = parts[0];
      if (possibleThemeId && getThemePath(possibleThemeId)) {
        // peek://theme/{themeId}/{path} - specific theme
        themeId = possibleThemeId;
        themePath = parts.slice(1).join('/') || 'variables.css';
      } else {
        // peek://theme/{path} - active theme
        themeId = activeThemeId;
        themePath = pathname || 'variables.css';
      }

      const themeBasePath = getThemePath(themeId);
      if (!themeBasePath) {
        DEBUG && console.log('Theme not found:', themeId);
        return new Response('Theme not found', { status: 404 });
      }

      const absolutePath = path.resolve(themeBasePath, themePath);

      // Security: ensure path stays within theme folder
      const normalizedBase = path.normalize(themeBasePath);
      if (!absolutePath.startsWith(normalizedBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      // For CSS and font files, add no-cache headers to ensure theme changes take effect
      if (themePath.endsWith('.css') || themePath.endsWith('.woff2') || themePath.endsWith('.woff')) {
        if (!fs.existsSync(absolutePath)) {
          console.error(`[protocol] FILE NOT FOUND: ${absolutePath} (requested: ${req.url})`);
          return new Response('Not Found', { status: 404 });
        }

        // For variables.css: prepend peek theme as base layer so other themes
        // only need to override what they change (colors, etc.). Peek's fonts,
        // typography, and other defaults cascade automatically.
        if (themePath === 'variables.css' && themeId !== 'peek') {
          const peekBasePath = getThemePath('peek');
          const peekCssPath = peekBasePath ? path.resolve(peekBasePath, 'variables.css') : null;

          if (peekCssPath && fs.existsSync(peekCssPath)) {
            let baseCss = fs.readFileSync(peekCssPath, 'utf-8');
            // Rewrite relative font URLs to point to peek's theme path
            baseCss = baseCss.replace(
              /url\(["']?\.\//g,
              'url("peek://theme/peek/'
            );
            // Fix closing quotes for rewritten URLs
            baseCss = baseCss.replace(
              /peek:\/\/theme\/peek\/([^"')]+)["']?\)/g,
              'peek://theme/peek/$1")'
            );
            const themeCss = fs.readFileSync(absolutePath, 'utf-8');
            const combined = `/* Base: peek theme defaults */\n${baseCss}\n\n/* Active theme: ${themeId} */\n${themeCss}\n`;

            return new Response(combined, {
              status: 200,
              headers: {
                'Content-Type': 'text/css',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
              }
            });
          }
        }

        const fileURL = pathToFileURL(absolutePath).toString();
        const response = await net.fetch(fileURL);
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          headers: {
            'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
      }

      return fetchFile(absolutePath, req.url);
    }

    // Handle per-extension hosts: peek://{ext-id}/{path}
    // This gives each extension a unique origin for iframe isolation
    // Check if host matches a registered extension
    const extBasePath = getExtensionPath(host);
    if (extBasePath) {
      const extPath = pathname || 'background.html';
      const absolutePath = path.resolve(extBasePath, extPath);

      // Security: ensure path stays within extension folder
      const normalizedBase = path.normalize(extBasePath);
      if (!absolutePath.startsWith(normalizedBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      return fetchFile(absolutePath, req.url);
    }

    let relativePath = pathname;

    // Handle node_modules paths
    const isNode = pathname.indexOf('node_modules') > -1;

    if (!isNode) {
      relativePath = path.join(host, pathname);
    }

    const absolutePath = path.resolve(rootDir, relativePath);

    return fetchFile(absolutePath, req.url);
  } catch (err) {
    console.error(`[protocol] Failed to handle ${req.url}:`, err);
    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Initialize the protocol handler on the default session
 * Must be called after app.ready
 */
export function initProtocol(appRootDir: string): void {
  rootDir = appRootDir;
  protocol.handle(APP_SCHEME, handleProtocolRequest);
}

/**
 * Register the protocol handler on a specific session
 * Call this for profile sessions to enable peek:// URLs
 */
export function registerProtocolOnSession(session: Electron.Session): void {
  if (!rootDir) {
    console.error('[protocol] Cannot register on session - initProtocol not called yet');
    return;
  }
  session.protocol.handle(APP_SCHEME, handleProtocolRequest);
  DEBUG && console.log('[protocol] Registered peek:// handler on session');
}
