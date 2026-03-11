/**
 * Base service interface for OAuth integrations.
 *
 * All service modules follow this pattern. To add a new service:
 * 1. Create a new file in services/ that exports a class extending this pattern
 * 2. Define the OAuth config (authUrl, tokenUrl, scopes, clientId)
 * 3. Import and register in services/index.js
 *
 * Token storage uses api.settings.setKey() / getKey() with a per-service key.
 */

const api = typeof window !== 'undefined' && window.app ? window.app : null;

/**
 * Create a service definition object.
 * Each service must provide:
 *   id         - unique identifier (e.g., 'youtube')
 *   name       - display name
 *   icon       - emoji or short label for the card
 *   color      - hex color for the card accent
 *   oauth      - { authUrl, tokenUrl, clientId, scopes, extraParams? }
 */
export function createService({ id, name, icon, color, oauth }) {
  const STORAGE_KEY = `wonderwall:${id}`;

  return {
    id,
    name,
    icon,
    color,
    oauth,

    /** Retrieve stored token data (or null). */
    async getToken() {
      if (!api) return null;
      try {
        const result = await api.settings.getKey(STORAGE_KEY);
        if (result.success && result.data) return result.data;
      } catch (err) {
        console.warn(`[wonderwall:${id}] Failed to load token:`, err);
      }
      return null;
    },

    /** Persist token data. */
    async setToken(tokenData) {
      if (!api) return;
      await api.settings.setKey(STORAGE_KEY, tokenData);
    },

    /** Remove stored token data (disconnect). */
    async clearToken() {
      if (!api) return;
      await api.settings.setKey(STORAGE_KEY, null);
    },

    /** Check whether the service has a stored token. */
    async isConnected() {
      const token = await this.getToken();
      return token !== null;
    },

    /**
     * Start the OAuth authorization flow.
     * Uses the generic loopback server from the Electron backend.
     *
     * @returns {Promise<Object>} Token response data from the provider.
     */
    async connect() {
      if (!api) throw new Error('Peek API not available');

      // 1. Start loopback server
      const loopback = await api.oauth.startLoopback();
      if (!loopback.success) {
        throw new Error(loopback.error || 'Failed to start loopback server');
      }
      const port = loopback.port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      try {
        // 2. Generate state for CSRF protection
        const stateArray = new Uint8Array(16);
        crypto.getRandomValues(stateArray);
        const state = Array.from(stateArray, b => b.toString(16).padStart(2, '0')).join('');

        // 3. Build authorization URL
        const params = new URLSearchParams({
          client_id: oauth.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: oauth.scopes,
          state,
          ...(oauth.extraParams || {})
        });
        const authUrl = `${oauth.authUrl}?${params.toString()}`;

        // 4. Open auth window
        api.window.open(authUrl, {
          width: 600,
          height: 700,
          role: 'modal',
          title: `Connect ${name}`,
        });

        // 5. Wait for callback
        const callbackResult = await api.oauth.awaitCallback(port);
        if (!callbackResult.success) {
          throw new Error(callbackResult.error || 'OAuth callback failed');
        }
        const callbackParams = callbackResult.params;

        // 6. Verify state
        if (callbackParams.state !== state) {
          throw new Error('OAuth state mismatch');
        }
        if (callbackParams.error) {
          throw new Error(callbackParams.error_description || callbackParams.error);
        }
        const code = callbackParams.code;
        if (!code) throw new Error('No authorization code received');

        // 7. Exchange code for tokens
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: oauth.clientId,
        });

        // Include client_secret if provided (some services require it)
        if (oauth.clientSecret) {
          tokenBody.set('client_secret', oauth.clientSecret);
        }

        const tokenRes = await fetch(oauth.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.json().catch(() => ({}));
          throw new Error(errBody.error_description || errBody.error || `Token exchange failed (${tokenRes.status})`);
        }

        const tokenData = await tokenRes.json();

        // 8. Store the token
        const stored = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt: tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : null,
          scope: tokenData.scope || oauth.scopes,
          connectedAt: Date.now(),
        };

        await this.setToken(stored);
        return stored;

      } catch (err) {
        // Cancel the loopback server if still pending
        try { await api.oauth.awaitCallback(port); } catch {}
        throw err;
      }
    },

    /** Disconnect: remove stored tokens. */
    async disconnect() {
      await this.clearToken();
    },
  };
}
