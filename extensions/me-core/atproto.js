/**
 * AT Protocol API helpers for the Me extension.
 *
 * Handles authentication via OAuth (PKCE + DPoP) using the generic
 * loopback server, and authenticated XRPC requests against the user's PDS.
 */

// Feature detection
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

// ============================================================================
// Public API (unauthenticated)
// ============================================================================

const PUBLIC_API = 'https://public.api.bsky.app';

/**
 * Search actors via the public Bluesky API (no auth needed).
 * @param {string} query - Search query
 * @returns {Promise<Array<{handle: string, did: string, displayName: string, avatar: string}>>}
 */
export async function searchActors(query) {
  if (!query || query.length < 2) return [];
  const url = `${PUBLIC_API}/xrpc/app.bsky.actor.searchActorsTypeahead?q=${encodeURIComponent(query)}&limit=8`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.actors || []).map(a => ({
      handle: a.handle,
      did: a.did || null,
      displayName: a.displayName || null,
      avatar: a.avatar || null,
    }));
  } catch {
    return [];
  }
}

/**
 * Resolve a handle to a DID via public API.
 * @param {string} handle
 * @returns {Promise<string|null>} DID or null
 */
export async function resolveHandle(handle) {
  try {
    const res = await fetch(
      `${PUBLIC_API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || null;
  } catch {
    return null;
  }
}

/**
 * Get a user's profile from the public API.
 * @param {string} actor - DID or handle
 * @returns {Promise<Object|null>}
 */
export async function getProfile(actor) {
  try {
    const res = await fetch(
      `${PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ============================================================================
// PDS Discovery
// ============================================================================

/**
 * Discover the user's PDS URL from their DID document.
 * @param {string} did
 * @returns {Promise<string|null>} PDS service URL
 */
export async function discoverPds(did) {
  try {
    let didDoc;
    if (did.startsWith('did:web:')) {
      const host = did.replace('did:web:', '');
      const res = await fetch(`https://${host}/.well-known/did.json`);
      if (res.ok) didDoc = await res.json();
    } else if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) didDoc = await res.json();
    }

    if (!didDoc || !didDoc.service) return null;

    const pdsService = didDoc.service.find(
      s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
    );
    return pdsService ? pdsService.serviceEndpoint : null;
  } catch {
    return null;
  }
}

// ============================================================================
// OAuth Authorization Server Discovery
// ============================================================================

/**
 * Discover the OAuth authorization server metadata for a PDS.
 * @param {string} pdsUrl
 * @returns {Promise<Object>} Authorization server metadata
 */
async function discoverAuthServer(pdsUrl) {
  // Step 1: Get the authorization server URL from the PDS
  const resourceRes = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`);
  if (!resourceRes.ok) {
    throw new Error(`PDS does not support OAuth (${resourceRes.status})`);
  }
  const resourceMeta = await resourceRes.json();
  const authServerUrl = resourceMeta.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error('No authorization server found in PDS metadata');
  }

  // Step 2: Get the authorization server metadata
  const authRes = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
  if (!authRes.ok) {
    throw new Error(`Failed to fetch auth server metadata (${authRes.status})`);
  }
  const authMeta = await authRes.json();
  return authMeta;
}

// ============================================================================
// PKCE Helpers (Web Crypto)
// ============================================================================

/**
 * Generate a PKCE code verifier (43-128 chars, unreserved URI chars).
 * @returns {string}
 */
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

/**
 * Generate a PKCE code challenge from a verifier (S256).
 * @param {string} verifier
 * @returns {Promise<string>}
 */
async function generateCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return base64urlEncode(new Uint8Array(hash));
}

// ============================================================================
// DPoP Helpers (Web Crypto)
// ============================================================================

/**
 * Generate a DPoP EC P-256 keypair.
 * @returns {Promise<CryptoKeyPair>}
 */
async function generateDpopKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable for storage
    ['sign', 'verify']
  );
}

/**
 * Export a CryptoKeyPair to JWK format for storage.
 * @param {CryptoKeyPair} keyPair
 * @returns {Promise<{publicKey: Object, privateKey: Object}>}
 */
export async function exportKeyPair(keyPair) {
  const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { publicKey, privateKey };
}

/**
 * Import a JWK keypair back to CryptoKeyPair.
 * @param {{publicKey: Object, privateKey: Object}} jwks
 * @returns {Promise<CryptoKeyPair>}
 */
export async function importKeyPair(jwks) {
  const publicKey = await crypto.subtle.importKey(
    'jwk', jwks.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['verify']
  );
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwks.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign']
  );
  return { publicKey, privateKey };
}

/**
 * Create a DPoP proof JWT.
 * @param {CryptoKeyPair} keyPair
 * @param {string} method - HTTP method (GET, POST)
 * @param {string} url - Target URL
 * @param {string} [nonce] - Server-provided DPoP nonce
 * @param {string} [ath] - Access token hash (for resource requests)
 * @returns {Promise<string>} Signed JWT
 */
async function createDpopProof(keyPair, method, url, nonce, ath) {
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  // Remove private fields from the public JWK
  const { d: _d, ...cleanPublicJwk } = publicJwk;

  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: cleanPublicJwk,
  };

  const payload = {
    jti: generateJti(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (ath) payload.ath = ath;

  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput)
  );

  // ECDSA signature from WebCrypto is in IEEE P1363 format (r||s, 64 bytes for P-256).
  // JWT expects this format, so no conversion needed.
  const sigB64 = base64urlEncode(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

/**
 * Compute access token hash for DPoP proof.
 * @param {string} accessToken
 * @returns {Promise<string>} base64url-encoded SHA-256 hash
 */
async function computeAth(accessToken) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return base64urlEncode(new Uint8Array(hash));
}

// ============================================================================
// Base64url Encoding
// ============================================================================

/**
 * Base64url encode a Uint8Array (no padding).
 * @param {Uint8Array} data
 * @returns {string}
 */
function base64urlEncode(data) {
  const binStr = Array.from(data, b => String.fromCharCode(b)).join('');
  return btoa(binStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateJti() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// OAuth Login Flow
// ============================================================================

/**
 * @typedef {Object} OAuthSession
 * @property {string} did
 * @property {string} handle
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {string} tokenEndpoint
 * @property {string} pdsUrl
 * @property {{publicKey: Object, privateKey: Object}} dpopKeyPairJwk - JWK format for storage
 */

/**
 * Login via OAuth PKCE + DPoP using the loopback server.
 *
 * @param {string} handle
 * @returns {Promise<OAuthSession>}
 */
export async function loginWithOAuth(handle) {
  // 1. Resolve handle → DID → PDS
  const did = await resolveHandle(handle);
  if (!did) throw new Error(`Could not resolve handle: ${handle}`);

  const pdsUrl = await discoverPds(did);
  if (!pdsUrl) throw new Error(`Could not discover PDS for ${handle}`);

  // 2. Discover auth server
  const authMeta = await discoverAuthServer(pdsUrl);
  const authEndpoint = authMeta.authorization_endpoint;
  const tokenEndpoint = authMeta.token_endpoint;
  const pushedAuthEndpoint = authMeta.pushed_authorization_request_endpoint;

  if (!authEndpoint || !tokenEndpoint) {
    throw new Error('Authorization server missing required endpoints');
  }

  // 3. Start loopback server
  const loopback = await api.oauth.startLoopback();
  if (!loopback.success) throw new Error(loopback.error || 'Failed to start loopback server');
  const port = loopback.port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    // 4. Generate PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // 5. Generate DPoP keypair
    const dpopKeyPair = await generateDpopKeyPair();

    // 6. Build client_id (loopback client metadata URL)
    const scope = 'atproto transition:generic';
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;

    // 7. Generate state
    const stateArray = new Uint8Array(16);
    crypto.getRandomValues(stateArray);
    const state = base64urlEncode(stateArray);

    // 8. Build authorization URL or use PAR
    let authUrl;
    if (pushedAuthEndpoint) {
      // Use Pushed Authorization Requests (PAR) — required by many AT Protocol auth servers
      const parBody = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: handle,
      });

      const dpopProof = await createDpopProof(dpopKeyPair, 'POST', pushedAuthEndpoint);
      const parRes = await fetch(pushedAuthEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'DPoP': dpopProof,
        },
        body: parBody.toString(),
      });

      if (!parRes.ok) {
        // Check for DPoP nonce requirement
        const dpopNonce = parRes.headers.get('DPoP-Nonce');
        if (dpopNonce && parRes.status === 400) {
          // Retry with nonce
          const retryProof = await createDpopProof(dpopKeyPair, 'POST', pushedAuthEndpoint, dpopNonce);
          const retryRes = await fetch(pushedAuthEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'DPoP': retryProof,
            },
            body: parBody.toString(),
          });
          if (!retryRes.ok) {
            const err = await retryRes.json().catch(() => ({}));
            throw new Error(err.error_description || err.error || `PAR failed (${retryRes.status})`);
          }
          const parData = await retryRes.json();
          authUrl = `${authEndpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
        } else {
          const err = await parRes.json().catch(() => ({}));
          throw new Error(err.error_description || err.error || `PAR failed (${parRes.status})`);
        }
      } else {
        const parData = await parRes.json();
        authUrl = `${authEndpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
      }
    } else {
      // Direct authorization URL
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: handle,
      });
      authUrl = `${authEndpoint}?${params.toString()}`;
    }

    // 9. Open auth window
    api.window.open(authUrl, {
      width: 600,
      height: 700,
      role: 'modal',
      title: 'AT Protocol Authorization',
    });

    // 10. Wait for callback
    const callbackResult = await api.oauth.awaitCallback(port);
    if (!callbackResult.success) throw new Error(callbackResult.error || 'OAuth callback failed');
    const params = callbackResult.params;

    // 11. Verify state
    if (params.state !== state) {
      throw new Error('OAuth state mismatch — possible CSRF attack');
    }
    if (params.error) {
      throw new Error(params.error_description || params.error);
    }
    const code = params.code;
    if (!code) throw new Error('No authorization code received');

    // Also capture iss if provided
    const iss = params.iss;

    // 12. Exchange code for tokens (with DPoP proof)
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    // Token exchange with DPoP nonce retry
    let dpopNonce;
    let tokenData = await tokenExchange(tokenEndpoint, tokenBody, dpopKeyPair, dpopNonce);

    // 13. Export DPoP keypair for storage
    const dpopKeyPairJwk = await exportKeyPair(dpopKeyPair);

    return {
      did,
      handle,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenEndpoint,
      pdsUrl,
      dpopKeyPairJwk,
      sub: tokenData.sub || did,
    };
  } catch (err) {
    // Cancel the loopback server if still pending
    try { await api.oauth.awaitCallback(port); } catch {}
    throw err;
  }
}

/**
 * Exchange authorization code or refresh token at token endpoint with DPoP.
 * Handles DPoP nonce retry automatically.
 */
async function tokenExchange(tokenEndpoint, body, dpopKeyPair, nonce) {
  let dpopProof = await createDpopProof(dpopKeyPair, 'POST', tokenEndpoint, nonce);

  let res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpopProof,
    },
    body: body.toString(),
  });

  // Handle DPoP nonce requirement (use_dpop_nonce error)
  if (!res.ok) {
    const dpopNonce = res.headers.get('DPoP-Nonce');
    if (dpopNonce) {
      dpopProof = await createDpopProof(dpopKeyPair, 'POST', tokenEndpoint, dpopNonce);
      res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'DPoP': dpopProof,
        },
        body: body.toString(),
      });
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token exchange failed (${res.status})`);
  }

  return res.json();
}

// ============================================================================
// Token Refresh
// ============================================================================

/**
 * Refresh an OAuth access token using the refresh token + DPoP.
 * @param {OAuthSession} session
 * @returns {Promise<OAuthSession>} Updated session with new tokens
 */
export async function refreshOAuthSession(session) {
  const dpopKeyPair = await importKeyPair(session.dpopKeyPairJwk);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: `http://localhost?redirect_uri=${encodeURIComponent('http://127.0.0.1/callback')}&scope=${encodeURIComponent('atproto transition:generic')}`,
  });

  const tokenData = await tokenExchange(session.tokenEndpoint, body, dpopKeyPair);

  return {
    ...session,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || session.refreshToken,
  };
}

// ============================================================================
// Authenticated XRPC requests (DPoP)
// ============================================================================

/**
 * Make an authenticated GET request to the user's PDS using DPoP tokens.
 * Automatically retries once with a refreshed token on 401.
 *
 * @param {OAuthSession} session
 * @param {string} nsid - XRPC method
 * @param {Object} [params] - Query parameters
 * @param {function} [onSessionRefresh] - Called with updated session on token refresh
 * @returns {Promise<Object>} Response data
 */
export async function xrpcGet(session, nsid, params = {}, onSessionRefresh = null) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const qsStr = qs.toString();
  const url = `${session.pdsUrl}/xrpc/${nsid}${qsStr ? '?' + qsStr : ''}`;

  const dpopKeyPair = await importKeyPair(session.dpopKeyPairJwk);

  // Compute access token hash for DPoP proof
  const ath = await computeAth(session.accessToken);
  let dpopProof = await createDpopProof(dpopKeyPair, 'GET', url, undefined, ath);

  let res = await fetch(url, {
    headers: {
      'Authorization': `DPoP ${session.accessToken}`,
      'DPoP': dpopProof,
    },
  });

  // Handle DPoP nonce requirement
  if (res.status === 401) {
    const dpopNonce = res.headers.get('DPoP-Nonce');
    if (dpopNonce) {
      dpopProof = await createDpopProof(dpopKeyPair, 'GET', url, dpopNonce, ath);
      res = await fetch(url, {
        headers: {
          'Authorization': `DPoP ${session.accessToken}`,
          'DPoP': dpopProof,
        },
      });
    }
  }

  // Retry once on 401 (expired token)
  if (res.status === 401 && session.refreshToken) {
    try {
      const refreshed = await refreshOAuthSession(session);
      Object.assign(session, refreshed);
      if (onSessionRefresh) onSessionRefresh(refreshed);

      const newAth = await computeAth(refreshed.accessToken);
      dpopProof = await createDpopProof(dpopKeyPair, 'GET', url, undefined, newAth);

      res = await fetch(url, {
        headers: {
          'Authorization': `DPoP ${refreshed.accessToken}`,
          'DPoP': dpopProof,
        },
      });

      // Handle nonce on retry
      if (res.status === 401) {
        const retryNonce = res.headers.get('DPoP-Nonce');
        if (retryNonce) {
          dpopProof = await createDpopProof(dpopKeyPair, 'GET', url, retryNonce, newAth);
          res = await fetch(url, {
            headers: {
              'Authorization': `DPoP ${refreshed.accessToken}`,
              'DPoP': dpopProof,
            },
          });
        }
      }
    } catch {
      // Refresh failed, throw the original 401
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `XRPC ${nsid} failed (${res.status})`);
  }

  return res.json();
}

// ============================================================================
// Repo / Lexicon helpers
// ============================================================================

/**
 * Describe a repo to get the list of collection NSIDs.
 * @param {OAuthSession} session
 * @param {function} [onSessionRefresh]
 * @returns {Promise<string[]>} Array of collection NSIDs
 */
export async function getCollections(session, onSessionRefresh) {
  const data = await xrpcGet(session, 'com.atproto.repo.describeRepo', {
    repo: session.did,
  }, onSessionRefresh);
  return data.collections || [];
}

/**
 * Count records in a collection.
 * @param {OAuthSession} session
 * @param {string} collection - Collection NSID
 * @param {function} [onSessionRefresh]
 * @returns {Promise<{count: number, hasMore: boolean}>}
 */
export async function getCollectionCount(session, collection, onSessionRefresh) {
  const data = await xrpcGet(session, 'com.atproto.repo.listRecords', {
    repo: session.did,
    collection,
    limit: 100,
  }, onSessionRefresh);

  const records = data.records || [];
  return {
    count: records.length,
    hasMore: !!data.cursor,
  };
}

/**
 * Get all collection counts in parallel.
 * @param {OAuthSession} session
 * @param {string[]} collections
 * @param {function} [onSessionRefresh]
 * @returns {Promise<Array<{nsid: string, count: number, hasMore: boolean}>>}
 */
export async function getAllCollectionCounts(session, collections, onSessionRefresh) {
  const results = await Promise.allSettled(
    collections.map(async (nsid) => {
      const { count, hasMore } = await getCollectionCount(session, nsid, onSessionRefresh);
      return { nsid, count, hasMore };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => b.count - a.count);
}
