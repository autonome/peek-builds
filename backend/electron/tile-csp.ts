/**
 * Content Security Policy generation for tiles
 *
 * Generates CSP headers based on tile manifest capabilities.
 * The protocol handler calls buildCSPForTile() when serving HTML
 * files for tile manifests.
 */

import type { TileCapabilities, TileManifest } from './tile-manifest.js';

// ─── CSP Directive Builders ──────────────────────────────────────────

/**
 * Default CSP for tiles — extremely restrictive baseline
 * Tiles can only load resources from their own origin
 *
 * `img-src` allows arbitrary https: / http: image sources because tiles
 * routinely render item cards with favicons sourced from external favicon
 * services (Google s2, DuckDuckGo, etc.) and per-domain favicon URLs. This
 * is not a meaningful privacy expansion — tiles already have a `network`
 * capability that lets them `fetch()` arbitrary URLs. Restricting <img>
 * doesn't constrain what code on the page can reach. If we ever want a
 * tighter posture for community-published tiles, route favicons through a
 * `peek://favicon/<domain>` proxy so the CSP can stay 'self' + data:.
 */
const DEFAULT_CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'https:', 'http:'],
  'font-src': ["'self'"],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
  'worker-src': ["'none'"],
};

/**
 * Build a CSP string from a directives map
 */
function directivesToString(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Build a CSP header value for a tile based on its capabilities
 *
 * Network domains -> connect-src allowlist
 * Window capability -> allows peek:// frame-src for managed windows
 * Theme capability -> allows peek://theme/ in style-src and font-src
 */
export function buildCSPForTile(capabilities: TileCapabilities): string {
  // Start with a deep copy of defaults
  const directives: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(DEFAULT_CSP_DIRECTIVES)) {
    directives[key] = [...values];
  }

  // Network capability: expand connect-src with allowed domains
  if (capabilities.network) {
    for (const domain of capabilities.network.domains) {
      // Convert wildcard domains to CSP format
      // '*.example.com' -> 'https://*.example.com'
      // 'api.github.com' -> 'https://api.github.com'
      const cspDomain = domain.startsWith('http')
        ? domain
        : `https://${domain}`;
      directives['connect-src'].push(cspDomain);
    }
  }

  // Theme capability: allow loading theme resources
  if (capabilities.theme) {
    directives['style-src'].push('peek://theme');
    directives['font-src'].push('peek://theme');
    directives['img-src'].push('peek://theme');
  }

  // Window capability: allow peek:// frames for window management UI
  if (capabilities.window) {
    directives['frame-src'] = ["'self'", 'peek:'];
  }

  return directivesToString(directives);
}

/**
 * Build the default CSP string (no capabilities)
 * Used when capabilities are unknown or for maximum restriction
 */
export function buildDefaultCSP(): string {
  return directivesToString(DEFAULT_CSP_DIRECTIVES);
}

/**
 * Inject CSP header into a Response
 * Creates a new Response with the CSP header added
 */
export function injectCSPHeader(response: Response, csp: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', csp);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Check if a response is an HTML document (should get CSP injected)
 */
export function isHTMLResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') || '';
  return contentType.includes('text/html');
}
