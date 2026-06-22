/**
 * Main-process AT Protocol DPoP request proxy.
 *
 * Performs the full AT Protocol DPoP request loop in the MAIN process so
 * renderer tiles no longer need `webSecurity:false` to make non-CORS,
 * DPoP-signed XRPC calls against a user's PDS.
 *
 * This is a faithful port of the renderer reference implementation
 * (`apps/desktop/features/lex/atproto.js`, ~lines 268–899): DPoP proof
 * construction, the `DPoP-Nonce` response-header retry, and the
 * 401 → refresh → re-sign → retry loop, plus blob upload with a binary
 * request body.
 *
 * Crypto: the renderer used WebCrypto (`crypto.subtle`) with a P-256
 * ECDSA key exported to JWK. Here we use Node's `node:crypto`
 * (`webcrypto` for ES256 signing, `createHash` for the access-token hash
 * `ath` and the PKCE-style SHA-256, `randomUUID` for the `jti`). This
 * keeps the proxy out of the DOM lib (the desktop tsconfig only includes
 * `ES2022`, not `DOM`) and uses well-typed Node APIs.
 *
 * SCOPE: this module is the proxy ONLY. It does not rewire the existing
 * consumers (publish.js / lex/*); that is a deliberate follow-up.
 *
 * Security note: the proxy enforces its OWN tight atproto host allowlist
 * (see `isAtprotoHostAllowed`) independent of the calling tile's broad
 * `network` capability. The renderer never holds the private key in this
 * design — the key + tokens live in main's `feature_settings` store and
 * the proxy reads them by reference (see `atproto-session-store.ts`).
 */

// Electron's `net` is loaded lazily via createRequire (not a top-level
// `import { net } from 'electron'`) so this module can be imported by unit
// tests running under ELECTRON_RUN_AS_NODE=1, where electron's named ESM
// exports are empty and a value import throws at module parse. Mirrors the
// canonical pattern in tile-ipc-gate.ts. See project_esm_require_gotcha.md.
import type { net as ElectronNet } from 'electron';
import { createRequire } from 'node:module';
import { webcrypto, createHash, randomUUID } from 'node:crypto';

const subtle = webcrypto.subtle;

// Node's webcrypto types are distinct from any ambient global `CryptoKey`
// / `JsonWebKey` (the @types/node + DOM-ish globals collide under
// ES2022 lib). Pin to the node:crypto webcrypto types everywhere.
type WCKey = webcrypto.CryptoKey;
type WCJsonWebKey = webcrypto.JsonWebKey;

const requireElectron = createRequire(import.meta.url);
let _net: typeof ElectronNet | null = null;

/**
 * Resolve Electron's `net`. Overridable in tests via `__setNetForTest`.
 */
function getNet(): typeof ElectronNet {
  if (_net) return _net;
  _net = (requireElectron('electron') as typeof import('electron')).net;
  return _net;
}

/** Test seam: inject a fake `net` (must provide `.fetch`). */
export function __setNetForTest(fake: { fetch: typeof ElectronNet.fetch } | null): void {
  _net = fake as unknown as typeof ElectronNet | null;
}

/** Convenience aliases for the `net.fetch` signature / response shape. */
type NetFetch = typeof ElectronNet.fetch;
type NetResponse = Awaited<ReturnType<NetFetch>>;

// ─── Types ───────────────────────────────────────────────────────────

/** EC P-256 JWK pair as persisted by the renderer OAuth flow. */
export interface DpopKeyPairJwk {
  publicKey: WCJsonWebKey;
  privateKey: WCJsonWebKey;
}

/**
 * The OAuth/DPoP session shape persisted by Lex (see
 * `features/lex/atproto.js` `loginWithOAuth`). Mirrors that structure;
 * only the fields the proxy needs are typed strictly.
 */
export interface AtprotoSession {
  did: string;
  handle: string;
  accessToken: string;
  refreshToken: string;
  tokenEndpoint: string;
  pdsUrl: string;
  dpopKeyPairJwk: DpopKeyPairJwk;
  clientId?: string;
  sub?: string;
}

/** Result returned to the renderer for any proxied XRPC request. */
export interface AtprotoProxyResult {
  status: number;
  statusText: string;
  /** Lower-cased response header map, including any `dpop-nonce`. */
  headers: Record<string, string>;
  /**
   * Parsed JSON body when the response is JSON; raw `Uint8Array` bytes
   * otherwise (e.g. a blob fetch). `null` for empty bodies.
   */
  body: unknown;
  /** True when `body` is the raw bytes form rather than parsed JSON. */
  binary: boolean;
  /**
   * Present when the proxy refreshed the session mid-request. The caller
   * (or a `lex:session-changed` listener) is responsible for persisting
   * it. Tokens only — never logged.
   */
  refreshedSession?: AtprotoSession;
}

/** A single proxied request descriptor. */
export interface AtprotoRequest {
  /** HTTP method. */
  method: 'GET' | 'POST';
  /** Fully-qualified target URL (must pass the host allowlist). */
  url: string;
  /** Optional JSON body (mutually exclusive with `binaryBody`). */
  jsonBody?: unknown;
  /** Optional binary body for uploadBlob (mutually exclusive with `jsonBody`). */
  binaryBody?: Uint8Array;
  /** Content-Type for a binary body (e.g. `image/jpeg`). Ignored for JSON. */
  contentType?: string;
}

// ─── Host allowlist ──────────────────────────────────────────────────

/**
 * Tight atproto host allowlist enforced by the proxy itself, on top of
 * the calling tile's `network` capability gate (see tile-ipc.ts). The
 * proxy will only ever talk to:
 *   - the user's own PDS host (derived from the session at call time),
 *   - the session's auth-server token-endpoint host (for refresh),
 *   - bsky network infrastructure (`*.bsky.network`, `*.host.bsky.network`),
 *   - the PLC directory (`plc.directory`) for DID/PDS discovery.
 *
 * Wildcard entries match the host suffix (e.g. `.bsky.network`).
 */
const STATIC_ALLOWED_SUFFIXES = ['.bsky.network', '.host.bsky.network'] as const;
const STATIC_ALLOWED_HOSTS = ['plc.directory'] as const;

/**
 * Decide whether `targetUrl`'s host is allowed given the session's PDS
 * and token-endpoint hosts. Pure — no I/O.
 *
 * @param targetUrl  the request URL
 * @param session    the active session (provides PDS + token-endpoint hosts)
 */
export function isAtprotoHostAllowed(targetUrl: string, session: AtprotoSession): boolean {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  const dynamicHosts: string[] = [];
  try {
    dynamicHosts.push(new URL(session.pdsUrl).hostname.toLowerCase());
  } catch { /* malformed pdsUrl — fall through to static set */ }
  try {
    dynamicHosts.push(new URL(session.tokenEndpoint).hostname.toLowerCase());
  } catch { /* malformed tokenEndpoint */ }

  if (dynamicHosts.includes(host)) return true;
  if ((STATIC_ALLOWED_HOSTS as readonly string[]).includes(host)) return true;
  for (const suffix of STATIC_ALLOWED_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

// ─── Base64url helpers ───────────────────────────────────────────────

/** Base64url-encode bytes with no padding. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// ─── DPoP proof construction ─────────────────────────────────────────

/** Import a stored JWK into a non-extractable ES256 signing key. */
async function importPrivateKey(jwk: WCJsonWebKey): Promise<WCKey> {
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Build and sign a DPoP proof JWT.
 *
 * Faithful port of `createDpopProof` in features/lex/atproto.js:
 *   - header: { typ: 'dpop+jwt', alg: 'ES256', jwk: <public JWK sans `d`> }
 *   - payload: { jti, htm, htu, iat, exp (+120s), nonce?, ath? }
 *   - signature: ES256 over `${headerB64}.${payloadB64}`. WebCrypto emits
 *     IEEE-P1363 (r||s, 64 bytes) which is exactly the JWS ES256 format.
 *
 * Exported for unit testing — the proof is verifiable with the public JWK.
 */
export async function createDpopProof(
  keyPairJwk: DpopKeyPairJwk,
  method: string,
  url: string,
  nonce?: string,
  ath?: string,
): Promise<string> {
  // Strip the private component from the public JWK that goes in the header.
  const { d: _d, ...cleanPublicJwk } = keyPairJwk.publicKey as WCJsonWebKey & { d?: string };

  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: cleanPublicJwk };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    jti: randomUUID().replace(/-/g, ''),
    htm: method,
    htu: url,
    iat: now,
    exp: now + 120,
  };
  if (nonce) payload.nonce = nonce;
  if (ath) payload.ath = ath;

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await importPrivateKey(keyPairJwk.privateKey);
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    Buffer.from(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/** Compute the base64url SHA-256 access-token hash (`ath`) for DPoP. */
export function computeAth(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('base64url');
}

// ─── Retry decision logic ────────────────────────────────────────────

/**
 * Should we re-sign + retry because the server handed us a fresh DPoP
 * nonce? Mirrors the renderer logic: any non-OK response that carries a
 * `DPoP-Nonce` header is retried once with that nonce. Pure.
 */
export function shouldRetryWithNonce(_status: number, ok: boolean, nonce: string | null | undefined): boolean {
  return !ok && !!nonce;
}

/**
 * Should we attempt a token refresh? Mirrors the renderer: a 401 with a
 * refresh token present triggers refresh → re-sign → retry. Pure.
 */
export function shouldRefreshOnUnauthorized(status: number, hasRefreshToken: boolean): boolean {
  return status === 401 && hasRefreshToken;
}

// ─── Token refresh (DPoP-signed token-endpoint call) ─────────────────

/**
 * Refresh the OAuth session. Port of `refreshOAuthSession` +
 * `tokenExchange` from features/lex/atproto.js — itself a DPoP-signed
 * POST to the token endpoint, with the use_dpop_nonce retry.
 *
 * Returns the updated session (new access/refresh tokens). Throws on a
 * non-OK token response (caller decides expiry vs transient).
 */
export async function refreshSession(session: AtprotoSession): Promise<AtprotoSession> {
  const clientId = session.clientId
    || `http://localhost?redirect_uri=${encodeURIComponent('http://127.0.0.1/callback')}&scope=${encodeURIComponent('atproto transition:generic')}`;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: clientId,
  }).toString();

  const tokenData = await tokenExchange(session.dpopKeyPairJwk, session.tokenEndpoint, body);

  return {
    ...session,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || session.refreshToken,
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  [k: string]: unknown;
}

/** POST to the token endpoint with DPoP + use_dpop_nonce retry. */
async function tokenExchange(
  keyPairJwk: DpopKeyPairJwk,
  tokenEndpoint: string,
  body: string,
): Promise<TokenResponse> {
  let proof = await createDpopProof(keyPairJwk, 'POST', tokenEndpoint);
  let res = await getNet().fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
    body,
  });

  if (!res.ok) {
    const nonce = res.headers.get('DPoP-Nonce');
    if (nonce) {
      proof = await createDpopProof(keyPairJwk, 'POST', tokenEndpoint, nonce);
      res = await getNet().fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
        body,
      });
    }
  }

  if (!res.ok) {
    let err: { error?: string; error_description?: string } = {};
    try { err = (await res.json()) as typeof err; } catch { /* non-JSON body */ }
    throw new Error(err.error_description || err.error || `Token exchange failed (${res.status})`);
  }
  return (await res.json()) as TokenResponse;
}

// ─── Core request loop ───────────────────────────────────────────────

/** Lower-case header map + the dpop nonce convenience read. */
function collectHeaders(res: NetResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

/** Read a response body as parsed JSON or raw bytes. */
async function readBody(res: NetResponse): Promise<{ body: unknown; binary: boolean }> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json') || ct.includes('+json')) {
    try { return { body: await res.json(), binary: false }; }
    catch { return { body: null, binary: false }; }
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { body: buf, binary: true };
}

/**
 * Build the headers + body for a single fetch attempt.
 */
function buildRequestInit(
  req: AtprotoRequest,
  accessToken: string,
  proof: string,
): Parameters<NetFetch>[1] {
  const headers: Record<string, string> = {
    Authorization: `DPoP ${accessToken}`,
    DPoP: proof,
  };
  let body: string | Uint8Array | undefined;
  if (req.binaryBody !== undefined) {
    headers['Content-Type'] = req.contentType || 'application/octet-stream';
    body = req.binaryBody;
  } else if (req.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.jsonBody);
  }
  return {
    method: req.method,
    headers,
    // Electron's net.fetch accepts a Uint8Array body; cast keeps the
    // shared RequestInit type (BodyInit) happy for both branches.
    body: body as BodyInit | undefined,
  };
}

/**
 * Perform the full DPoP request loop for a single XRPC call.
 *
 * Sequence (mirrors xrpcGet / xrpcPost / uploadBlob):
 *   1. sign with ath, send.
 *   2. if !ok and a DPoP-Nonce came back → re-sign with nonce, resend.
 *   3. if 401 and we have a refresh token → refresh, re-sign with new ath,
 *      resend; handle a nonce on that retry too.
 *
 * The session is treated as immutable input; a refreshed session (if any)
 * is returned in the result so the caller can persist it.
 */
export async function performAtprotoRequest(
  session: AtprotoSession,
  req: AtprotoRequest,
): Promise<AtprotoProxyResult> {
  if (req.jsonBody !== undefined && req.binaryBody !== undefined) {
    throw new Error('performAtprotoRequest: jsonBody and binaryBody are mutually exclusive');
  }

  let activeSession = session;
  let refreshedSession: AtprotoSession | undefined;

  const ath = computeAth(activeSession.accessToken);
  let proof = await createDpopProof(activeSession.dpopKeyPairJwk, req.method, req.url, undefined, ath);
  let res = await getNet().fetch(req.url, buildRequestInit(req, activeSession.accessToken, proof));

  // Step 2: DPoP nonce retry.
  if (!res.ok) {
    const nonce = res.headers.get('DPoP-Nonce');
    if (nonce) {
      proof = await createDpopProof(activeSession.dpopKeyPairJwk, req.method, req.url, nonce, ath);
      res = await getNet().fetch(req.url, buildRequestInit(req, activeSession.accessToken, proof));
    }
  }

  // Step 3: 401 → refresh → retry.
  if (shouldRefreshOnUnauthorized(res.status, !!activeSession.refreshToken)) {
    const refreshed = await refreshSession(activeSession);
    activeSession = refreshed;
    refreshedSession = refreshed;

    const newAth = computeAth(refreshed.accessToken);
    proof = await createDpopProof(refreshed.dpopKeyPairJwk, req.method, req.url, undefined, newAth);
    res = await getNet().fetch(req.url, buildRequestInit(req, refreshed.accessToken, proof));

    if (!res.ok) {
      const retryNonce = res.headers.get('DPoP-Nonce');
      if (retryNonce) {
        proof = await createDpopProof(refreshed.dpopKeyPairJwk, req.method, req.url, retryNonce, newAth);
        res = await getNet().fetch(req.url, buildRequestInit(req, refreshed.accessToken, proof));
      }
    }
  }

  const { body, binary } = await readBody(res);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: collectHeaders(res),
    body,
    binary,
    refreshedSession,
  };
}
