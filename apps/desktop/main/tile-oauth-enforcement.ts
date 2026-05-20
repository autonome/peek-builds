/**
 * Strict OAuth Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:oauth:start-loopback` / `tile:oauth:await-callback`
 * IPC handlers in `tile-ipc.ts` to decide whether a capability grant
 * may drive an OAuth loopback flow.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-dialogs-enforcement.ts` so
 * these checks can be unit-tested without pulling in `tile-ipc`'s
 * Electron dependencies.
 *
 * Background: the v1-compat surface exposes `api.oauth.startLoopback()`
 * and `api.oauth.awaitCallback(port)` via the `oauth-start-loopback` /
 * `oauth-await-callback` IPC channels with NO capability check — any
 * extension could bind a loopback HTTP server on 127.0.0.1 with a random
 * port and harvest a browser-redirected OAuth code. Used today by
 * `features/wonderwall/services/base.js` (YouTube/SoundCloud/Reddit)
 * and `features/lex/atproto.js`. The strict handlers gate the same
 * underlying `createLoopbackServer` flow behind a declared `oauth`
 * capability plus an optional per-provider allowlist.
 */

import type { CapabilityGrant, OAuthCapability } from './tile-manifest.js';

export type OAuthOp = 'start-loopback' | 'await-callback';

export type OAuthCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Normalise an oauth-capability grant into an `OAuthCapability` object
 * shape. `oauth: true` becomes `{}` (unrestricted — any provider).
 * Any falsy/invalid value returns `null` so the caller can short-circuit
 * with "capability not granted".
 */
function normaliseGrant(grant: CapabilityGrant | null): OAuthCapability | null {
  if (!grant) return null;
  const oc = grant.capabilities.oauth;
  if (!oc) return null;
  if (oc === true) return {};
  if (typeof oc === 'object') return oc;
  return null;
}

/**
 * Validate whether a grant may perform the given oauth operation.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `oauth` capability must be present.
 *   3. If `provider` is supplied AND `providers` allowlist is declared,
 *      the provider must appear in the list (or `'*'` in the list grants
 *      blanket access).
 *
 * `await-callback` never carries a provider hint (the callback is keyed
 * by the loopback port the caller received from `start-loopback`), so
 * the provider check is skipped for that op.
 *
 * Treats `oauth: true` and `oauth: {}` (object without `providers`) as
 * unrestricted. Treats `oauth: { providers: [] }` as fully locked — no
 * provider is allowed. This matches the manifest author's intent: an
 * explicit empty allowlist means "I declared the capability but block
 * everything".
 */
export function checkOAuthAllowed(
  grant: CapabilityGrant | null,
  op: OAuthOp,
  provider?: string,
): OAuthCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass every oauth gate.
  if (grant.trustedBuiltin) return { ok: true };

  const cap = normaliseGrant(grant);
  if (!cap) return { ok: false, error: 'oauth capability not granted' };

  // Per-provider allowlist is only consulted on start-loopback (the only
  // op where a provider hint is meaningful). The await-callback op
  // resolves a pending flow by port and has no provider semantics.
  if (op === 'start-loopback' && cap.providers && provider !== undefined) {
    if (cap.providers.includes('*')) return { ok: true };
    if (!cap.providers.includes(provider)) {
      return {
        ok: false,
        error: `oauth provider "${provider}" not in capability providers allowlist`,
      };
    }
  }

  return { ok: true };
}
