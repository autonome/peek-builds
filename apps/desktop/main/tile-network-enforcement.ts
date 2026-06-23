/**
 * Network-fetch domain enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:network:fetch` IPC handler in `tile-ipc.ts` to decide
 * whether a capability grant may fetch a given host. This is the gate that
 * REPLACES `webSecurity:false`: non-CORS hosts are reached via the
 * main-process `net.fetch` (which bypasses renderer SOP), so that fetch must
 * be domain-gated here instead of relying on the renderer's same-origin policy.
 *
 * Extracted into its own module (rather than living inside tile-ipc.ts) so it
 * can be unit-tested without importing tile-ipc's Electron dependencies
 * (ipcMain, BrowserWindow, net, dialog, webContents) — matching the pattern of
 * the sibling tile-*-enforcement.ts modules.
 *
 * NOTE: a `trustedBuiltin` grant (e.g. Lex) bypasses this allowlist entirely,
 * so a builtin's manifest `network.domains` list is advisory/defense-in-depth,
 * not enforced. Non-builtin tiles are strictly gated.
 */

import type { CapabilityGrant } from './tile-manifest.js';

/**
 * Check if a network domain is allowed.
 * Supports wildcard matching (e.g., '*.example.com' matches 'api.example.com').
 * Trusted-builtin core renderers bypass the domain allowlist.
 */
export function isNetworkDomainAllowed(grant: CapabilityGrant, domain: string): boolean {
  if (grant.trustedBuiltin) return true;
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
