/**
 * Electron protocol handling for peek:// scheme
 *
 * Handles:
 * - peek://app/{path} - Core app files
 * - peek://ext/{tile-id}/{path} - Tile content (legacy URL prefix; tiles ARE the unit of a feature)
 * - peek://extensions/{path} - Shared tile infrastructure (resolves under features/)
 * - peek://theme/{path} - Current theme files (vars.css, manifest.json)
 * - peek://theme/{themeId}/{path} - Specific theme files
 * - peek://thumbnail/{hash} - Page screenshot thumbnails (JPEG)
 * - peek://local-file/{path} - Local filesystem files (images, documents, media, etc.)
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDb } from './datastore.js';
import { getThumbnailPath } from './thumbnails.js';
import { DEBUG } from './config.js';
import { getTileManifest } from './tile-launcher.js';
import { isLazyTileRegistered, getLazyTileManifest } from './tile-lazy.js';
import { resolveTileOriginCSP, injectCSPHeader } from './tile-csp.js';
import { resolveRendererPath, appPageExists } from './renderer-path.js';
import { protocolModuleForRequest } from './tile-protocols.js';

export const APP_SCHEME = 'peek';
export const APP_PROTOCOL = `${APP_SCHEME}:`;

// Lazy-load `protocol` and `net` via CommonJS require so this module can be
// imported under ELECTRON_RUN_AS_NODE=1 (where electron's named ESM exports
// are empty). Unit tests that only consume pure helpers (e.g. tile path
// resolution via getTilePath) never touch the lazy binding.
const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') {
  if (_electron) return _electron;
  _electron = requireElectron('electron') as typeof import('electron');
  return _electron;
}
const protocol: typeof import('electron').protocol = new Proxy(
  {} as typeof import('electron').protocol,
  { get: (_t, prop) => (getElectron().protocol as any)[prop] }
);
const net: typeof import('electron').net = new Proxy(
  {} as typeof import('electron').net,
  { get: (_t, prop) => (getElectron().net as any)[prop] }
);

// Tile path cache: tileId -> filesystem path. Populated when a tile
// is registered (tile-compat) or when a dev tile is loaded via
// --load-extension. Used by the per-tile origin resolver below
// (`peek://{tileId}/...`) and by anyone needing a tile's on-disk path.
const tilePaths = new Map<string, string>();

// Theme path cache: themeId -> filesystem path
const themePaths = new Map<string, string>();

// Active theme ID (defaults to peek)
let activeThemeId = 'peek';

// Root directory (set during init)
let rootDir: string;
// node_modules lives at the repo root (two levels above apps/desktop)
let nodeModulesDir: string;

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

// Allowed file extensions for peek://local-file/ protocol.
// Maps extension -> MIME type. Only these types are served; everything else is blocked.
const ALLOWED_LOCAL_FILE_EXTS = new Map<string, string>([
  // Images
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  // Documents
  ['.pdf', 'application/pdf'],
  // Fonts
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  // Styles
  ['.css', 'text/css'],
  // Media
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
]);

// Deterministic Content-Type by file extension for peek:// responses served
// via net.fetch(file://…). Electron 43's net.fetch no longer labels `.js` (and
// friends) with a JavaScript MIME type — it returns application/octet-stream,
// which Chromium's strict ES-module MIME check refuses to execute, silently
// killing every module-driven surface (the bgWindow orchestrator never runs).
// So we override the header by extension rather than trusting net.fetch. See
// peek item 06d363fc (Electron 40→43 migration).
const EXT_TO_MIME = new Map<string, string>([
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.map', 'application/json'],
]);

// Resolve a Content-Type for a served file: prefer the deterministic
// extension→MIME map, fall back to whatever net.fetch reported, then octet-stream.
function extToMime(absolutePath: string, fetchedContentType: string | null): string {
  const ext = path.extname(absolutePath).toLowerCase();
  return EXT_TO_MIME.get(ext) || fetchedContentType || 'application/octet-stream';
}

// Explicitly blocked executable/script extensions (for clear error messages)
const BLOCKED_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts',
  '.html', '.htm', '.xhtml',
  '.sh', '.bash', '.zsh', '.fish',
  '.exe', '.bat', '.cmd', '.com', '.msi',
  '.py', '.rb', '.pl', '.php',
  '.jar', '.class',
]);

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
      'Content-Type': extToMime(absolutePath, response.headers.get('Content-Type')),
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
      bypassCSP: true, // Required for peek:// pages to load inline scripts/styles. Tile security enforced via per-response CSP headers instead.
      // peek:// is split into per-host origins (peek://app, peek://cmd, per-tile,
      // peek://node_modules) for CSP/iframe isolation, but they are all our own
      // trusted code and load each other's ES modules cross-origin (every Lit tile
      // imports `lit` → peek://node_modules/…). Electron 43/Chromium enforces CORS
      // on custom standard schemes, so those cross-origin module fetches now need
      // an Access-Control-Allow-Origin header to be honored — hence corsEnabled +
      // the peek-scoped ACAO in applyCrossOriginHeaders(). peek 06d363fc.
      corsEnabled: true,
      allowServiceWorkers: false
    }
  }]);
}

/**
 * Register a built-in tile path
 */
export function registerTilePath(id: string, fsPath: string): void {
  tilePaths.set(id, fsPath);
  DEBUG && console.log('Registered tile path:', id, fsPath);
}

/**
 * Get all registered built-in tile IDs
 */
export function getRegisteredTileIds(): string[] {
  return Array.from(tilePaths.keys());
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
 * Get tile filesystem path by ID. Built-in + dev-loaded tiles only.
 */
export function getTilePath(id: string): string | null {
  return tilePaths.get(id) ?? null;
}

/**
 * Add a cross-origin grant to a peek:// response, but ONLY for other peek://
 * origins. Our per-host origins (peek://app, peek://cmd, per-tile,
 * peek://node_modules) load each other's ES modules cross-origin, which
 * Electron 43/Chromium now gates behind CORS. We echo the requester's Origin
 * when it is a peek:// origin so peek→peek module imports resolve; an http(s)
 * page rendered in the page-host has a non-peek Origin, gets no grant, and so
 * still cannot read peek:// resources. peek 06d363fc.
 */
function applyCrossOriginHeaders(response: Response, req: Request): void {
  const origin = req.headers.get('origin');
  if (origin && origin.startsWith(`${APP_SCHEME}://`)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
}

/**
 * The protocol request handler - registered on multiple sessions. Delegates to
 * the router, then applies the peek→peek cross-origin grant to every response
 * (success, tile-CSP-wrapped, and error alike).
 */
async function handleProtocolRequest(req: Request): Promise<Response> {
  const response = await routeProtocolRequest(req);
  applyCrossOriginHeaders(response, req);
  return response;
}

async function routeProtocolRequest(req: Request): Promise<Response> {
  // Capture host up-front so an unexpected error below still lets us apply
  // CSP to the fallback 404 when the request targets a tile origin.
  let host: string | null = null;
  try {
    const url = new URL(req.url);
    host = url.host;
    let pathname = url.pathname.replace(/^\//, '');

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
      const absolutePath = path.resolve(nodeModulesDir, resolvedPath);
      return fetchFile(absolutePath, req.url);
    }

    // Handle tile content: peek://ext/{tile-id}/{path}
    // (The `ext/` URL prefix is a legacy shape; the resolver routes to tiles.)
    if (host === 'ext') {
      const parts = pathname.split('/');
      const extId = parts[0];
      const extPath = parts.slice(1).join('/') || 'index.html';

      // Backwards-compat: peek://ext/cmd/{path} resolves to app/cmd/ now that
      // cmd has been extracted out of the features/ directory into core app code.
      // Features across the codebase import `peek://ext/cmd/nouns.js` — preserve
      // that URL contract.
      if (extId === 'cmd') {
        const absolutePath = path.resolve(rootDir, 'renderer', 'cmd', extPath);
        const cmdBase = path.resolve(rootDir, 'renderer', 'cmd');
        if (!absolutePath.startsWith(cmdBase)) {
          console.error('Path traversal attempt blocked:', absolutePath);
          return new Response('Forbidden', { status: 403 });
        }
        DEBUG && console.log(`[protocol] ext/cmd/${extPath} -> ${absolutePath}`);
        return fetchFile(absolutePath, req.url);
      }

      // Backwards-compat: peek://ext/page/{path} resolves to app/page/ now that
      // page has been extracted out of features/ into core app code.
      // The page background iframe URL was peek://ext/page/background.html; we
      // preserve that URL contract so any existing open windows don't break.
      if (extId === 'page') {
        const absolutePath = path.resolve(rootDir, 'renderer', 'page', extPath);
        const pageBase = path.resolve(rootDir, 'renderer', 'page');
        if (!absolutePath.startsWith(pageBase)) {
          console.error('Path traversal attempt blocked:', absolutePath);
          return new Response('Forbidden', { status: 403 });
        }
        DEBUG && console.log(`[protocol] ext/page/${extPath} -> ${absolutePath}`);
        return fetchFile(absolutePath, req.url);
      }

      const tileBasePath = getTilePath(extId);
      if (!tileBasePath) {
        DEBUG && console.log('Tile not found:', extId);
        return new Response('Tile not found', { status: 404 });
      }

      const absolutePath = path.resolve(tileBasePath, extPath);

      // Security: ensure path stays within tile folder
      const normalizedBase = path.normalize(tileBasePath);
      if (!absolutePath.startsWith(normalizedBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      DEBUG && console.log(`[protocol] ext ${extId}/${extPath} -> ${absolutePath}`);

      return fetchFile(absolutePath, req.url);
    }

    // Handle shared tile infrastructure: peek://extensions/{path}
    // Resolves under features/ — used to serve cross-tile shared code.
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
            'Content-Type': extToMime(absolutePath, response.headers.get('Content-Type')),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
      }

      return fetchFile(absolutePath, req.url);
    }

    // Handle thumbnail images: peek://thumbnail/{hash}
    // Serves JPEG thumbnails from userData/thumbnails/ directory
    if (host === 'thumbnail') {
      const hash = pathname.replace(/\.jpg$/, ''); // strip optional .jpg
      const thumbnailFile = getThumbnailPath(hash);

      if (!fs.existsSync(thumbnailFile)) {
        return new Response('Not Found', { status: 404 });
      }

      const fileURL = pathToFileURL(thumbnailFile).toString();
      const response = await net.fetch(fileURL);
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'max-age=86400, immutable',
        }
      });
    }

    // Handle verified feature display blobs: peek://feature-blob/{did}/{cid}
    // Used by the features-manager browse/preview to show icons + screenshots.
    // The bytes are fetched from the publisher's PDS and CID-verified against
    // the (signature-verified) record CID BEFORE serving — closing the gap
    // where a compromised PDS could substitute display media under a signed CID.
    // A miss/mismatch returns 404 so the renderer falls back to the letter
    // avatar; a bad cosmetic blob never blocks a feature whose code verified.
    if (host === 'feature-blob') {
      const parts = pathname.split('/');
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        return new Response('Bad Request', { status: 400 });
      }
      const did = decodeURIComponent(parts[0]);
      const cid = decodeURIComponent(parts[1]);
      const { fetchVerifiedFeatureBlob } = await import('./atproto-source.js');
      const verified = await fetchVerifiedFeatureBlob(did, cid);
      if (!verified) {
        return new Response('Not Found', { status: 404 });
      }
      // Content is addressed by CID, so it can never change — cache immutably.
      return new Response(new Uint8Array(verified.bytes), {
        status: 200,
        headers: {
          'Content-Type': verified.contentType,
          'Cache-Control': 'max-age=86400, immutable',
        },
      });
    }

    // Handle local file access: peek://local-file/{absolute-path}
    // Used by editor preview and other features to serve local files.
    // Only serves files with explicitly allowed MIME types for security.
    if (host === 'local-file') {
      // Decode percent-encoded path segments
      const decodedPathname = decodeURIComponent(pathname);
      const absolutePath = '/' + decodedPathname;

      // Security: reject paths containing null bytes
      if (absolutePath.includes('\0')) {
        console.error(`[protocol] local-file: blocked null byte in path`);
        return new Response('Forbidden: invalid path', { status: 403 });
      }

      // Security: only allow known-safe file extensions
      const ext = path.extname(absolutePath).toLowerCase();
      if (!ALLOWED_LOCAL_FILE_EXTS.has(ext)) {
        const isBlocked = BLOCKED_EXTS.has(ext);
        DEBUG && console.log(`[protocol] local-file: blocked ${isBlocked ? 'executable/script' : 'unknown'} extension: ${ext}`);
        return new Response('Forbidden: file type not allowed', { status: 403 });
      }

      // Security: resolve symlinks to get the real path
      let realPath: string;
      try {
        realPath = fs.realpathSync(absolutePath);
      } catch {
        DEBUG && console.log(`[protocol] local-file: file not found: ${absolutePath}`);
        return new Response('Not Found', { status: 404 });
      }

      // Re-check extension after symlink resolution
      const realExt = path.extname(realPath).toLowerCase();
      if (!ALLOWED_LOCAL_FILE_EXTS.has(realExt)) {
        DEBUG && console.log(`[protocol] local-file: blocked extension after symlink resolution: ${realExt}`);
        return new Response('Forbidden: file type not allowed', { status: 403 });
      }

      DEBUG && console.log(`[protocol] local-file: serving ${realPath}`);

      // Serve with proper MIME type from our allowlist
      const mimeType = ALLOWED_LOCAL_FILE_EXTS.get(realExt) || 'application/octet-stream';
      const fileURL = pathToFileURL(realPath).toString();
      const response = await net.fetch(fileURL);
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // Backwards-compat: peek://cmd/{path} resolves to app/cmd/
    // cmd used to be a consolidated extension served from features/cmd/; it's
    // now core app code in app/cmd/.
    if (host === 'cmd') {
      const cmdPath = pathname || 'background.html';
      const absolutePath = path.resolve(rootDir, 'renderer', 'cmd', cmdPath);
      const cmdBase = path.resolve(rootDir, 'renderer', 'cmd');
      if (!absolutePath.startsWith(cmdBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }
      DEBUG && console.log(`[protocol] cmd/${cmdPath} -> ${absolutePath}`);
      return fetchFile(absolutePath, req.url);
    }

    // Backwards-compat: peek://page/{path} resolves to app/page/
    // page used to be a consolidated extension served from features/page/; it's
    // now core app code in app/page/.
    if (host === 'page') {
      const pagePath = pathname || 'background.html';
      const absolutePath = path.resolve(rootDir, 'renderer', 'page', pagePath);
      const pageBase = path.resolve(rootDir, 'renderer', 'page');
      if (!absolutePath.startsWith(pageBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }
      DEBUG && console.log(`[protocol] page/${pagePath} -> ${absolutePath}`);
      return fetchFile(absolutePath, req.url);
    }

    // peek://test/{path} resolves to app/_test/ — the privileged test
    // fixture renderer used by the Playwright suite. Only launched when
    // E2E_TEST=true, via test-fixture-glue.ts.
    if (host === 'test') {
      const testPath = pathname || 'index.html';
      const absolutePath = path.resolve(rootDir, 'renderer', '_test', testPath);
      const testBase = path.resolve(rootDir, 'renderer', '_test');
      if (!absolutePath.startsWith(testBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }
      DEBUG && console.log(`[protocol] test/${testPath} -> ${absolutePath}`);
      return fetchFile(absolutePath, req.url);
    }

    // Backwards-compat: peek://app/{path} resolves to renderer/
    // The `app/` directory was renamed to `renderer/` in the apps/desktop restructure.
    // Feature renderers and other callers use `peek://app/lib/...` URLs — preserve that contract.
    if (host === 'app') {
      const appPath = pathname;
      const absolutePath = resolveRendererPath(rootDir, appPath);
      if (absolutePath === null) {
        console.error('Path traversal attempt blocked:', appPath);
        return new Response('Forbidden', { status: 403 });
      }
      DEBUG && console.log(`[protocol] app/${appPath} -> ${absolutePath}`);
      return fetchFile(absolutePath, req.url);
    }

    // Handle per-tile hosts: peek://{tile-id}/{path}
    // Each tile gets a unique origin for iframe isolation and CSP scoping.
    const tileBasePath = getTilePath(host);
    if (tileBasePath) {
      const tilePathSuffix = pathname || 'background.html';
      const absolutePath = path.resolve(tileBasePath, tilePathSuffix);

      // A tile origin is identified by having either a loaded manifest
      // (eager tiles) or a registered lazy manifest (not yet instantiated).
      const tileManifest = getTileManifest(host);
      const isTileOrigin = tileManifest !== null || isLazyTileRegistered(host);

      // Web Tiles protocol module:
      //   peek://<tile-id>/.well-known/web-tiles/<name>.js
      // The host names the requesting tile, so the capabilities consulted
      // here are that tile's. A protocol that is not registered, or whose
      // capability the tile does not hold, is served nothing and falls
      // through to the ordinary file lookup below — which 404s, so the tile's
      // `import()` rejects identically in both cases. The legacy
      // `peek://ext/<id>/` form returns from its own branch above and so is
      // never served a protocol.
      const protocolCapabilities =
        (tileManifest ?? getLazyTileManifest(host))?.capabilities ?? null;
      const protocolSource = protocolModuleForRequest(host, tilePathSuffix, protocolCapabilities);
      if (protocolSource !== null) {
        const moduleResponse = new Response(protocolSource, {
          status: 200,
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
        if (!isTileOrigin) return moduleResponse;
        return injectCSPHeader(
          moduleResponse,
          resolveTileOriginCSP(tileManifest, getLazyTileManifest(host)),
        );
      }

      // Security: ensure path stays within the tile folder. For tile origins
      // we still want CSP on the 403, so we synthesize the forbidden response
      // and fall through to the CSP-injection tail instead of returning early.
      const normalizedBase = path.normalize(tileBasePath);
      let response: Response;
      if (!absolutePath.startsWith(normalizedBase)) {
        console.error('Path traversal attempt blocked:', absolutePath);
        response = new Response('Forbidden', { status: 403 });
      } else {
        response = await fetchFile(absolutePath, req.url);
      }

      // CSP injection for tile origins.
      // Apply to EVERY response regardless of status or Content-Type so
      // error responses (404/500), redirects (3xx), and sub-resources
      // (JS/CSS/fonts) cannot be used to escape the tile's declared
      // capability sandbox. `resolveTileOriginCSP` derives the policy from the
      // loaded manifest, or — for a lazy tile whose background hasn't booted
      // yet (e.g. a session-restored window served before `loadedManifests`
      // is populated) — from the lazy registry, falling back to the
      // maximally-restrictive default only for a truly-unknown origin. The
      // lazy fallback prevents silently dropping a lazy tile's `network`
      // capability (which broke Lex login after restore).
      if (isTileOrigin) {
        const csp = resolveTileOriginCSP(tileManifest, getLazyTileManifest(host));
        DEBUG && console.log(`[protocol] Injecting CSP for tile ${host} (status ${response.status}):`, csp);
        return injectCSPHeader(response, csp);
      }

      return response;
    }

    let relativePath = pathname;

    // Handle node_modules paths
    const isNode = pathname.indexOf('node_modules') > -1;

    if (!isNode) {
      relativePath = path.join(host, pathname);
    }

    // node_modules are at the repo root, not under apps/desktop
    const resolveBase = (host === 'node_modules') ? nodeModulesDir : rootDir;
    const absolutePath = path.resolve(resolveBase, relativePath);

    return fetchFile(absolutePath, req.url);
  } catch (err) {
    console.error(`[protocol] Failed to handle ${req.url}:`, err);
    const errResponse = new Response('Not Found', { status: 404 });
    if (host) {
      const tileManifest = getTileManifest(host);
      const isTileOrigin = tileManifest !== null || isLazyTileRegistered(host);
      if (isTileOrigin) {
        // Same lazy-registry fallback as the main path — keep error responses
        // on a lazy tile's declared CSP rather than the default 'self'-only one.
        const csp = resolveTileOriginCSP(tileManifest, getLazyTileManifest(host));
        return injectCSPHeader(errResponse, csp);
      }
    }
    return errResponse;
  }
}

/**
 * Whether a saved `peek://app/...` window URL still points at an existing
 * page. True before `initProtocol()` sets the root, so nothing is dropped early.
 */
export function savedAppPageExists(url: string): boolean {
  if (!rootDir) return true;
  return appPageExists(rootDir, url, fs.existsSync);
}

/**
 * Initialize the protocol handler on the default session
 * Must be called after app.ready
 */
export function initProtocol(appRootDir: string): void {
  rootDir = appRootDir;
  // node_modules is at the repo root (../../ from apps/desktop)
  nodeModulesDir = path.join(rootDir, '../..');
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
