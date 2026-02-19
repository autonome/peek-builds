/**
 * Me Extension — AT Protocol identity and data browser
 *
 * Provides:
 * - Login via AT Protocol OAuth (PKCE + DPoP)
 * - View repo collections (lexicons) with record counts
 * - Account search with typeahead
 * - Commands: me login, me logout, me status, me lexicons
 */

import {
  searchActors,
  loginWithOAuth,
  getCollections,
  getAllCollectionCounts,
  getProfile,
  xrpcPost,
  uploadBlob,
} from './atproto.js';

// Feature detection
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

// ============================================================================
// Session state
// ============================================================================

let currentSession = null; // { did, handle, accessToken, refreshToken, tokenEndpoint, pdsUrl, dpopKeyPairJwk }
let currentProfile = null; // { displayName, avatar, handle, ... }

const STORAGE_KEY = 'session';
const PROFILE_KEY = 'profile';

/**
 * Persist session to extension storage
 */
async function saveSession() {
  if (!api) return;
  try {
    await api.settings.setKey(STORAGE_KEY, currentSession);
    if (currentProfile) {
      await api.settings.setKey(PROFILE_KEY, currentProfile);
    }
  } catch (err) {
    console.warn('[me] Failed to save session:', err);
  }
}

/**
 * Load session from extension storage
 */
async function loadSession() {
  if (!api) return;
  try {
    const result = await api.settings.getKey(STORAGE_KEY);
    if (result.success && result.data) {
      currentSession = result.data;
      console.log('[me] Restored session for', currentSession.handle);
    }
    const profileResult = await api.settings.getKey(PROFILE_KEY);
    if (profileResult.success && profileResult.data) {
      currentProfile = profileResult.data;
    }
  } catch (err) {
    console.warn('[me] Failed to load session:', err);
  }
}

/**
 * Clear session
 */
async function clearSession() {
  currentSession = null;
  currentProfile = null;
  if (api) {
    try {
      await api.settings.setKey(STORAGE_KEY, null);
      await api.settings.setKey(PROFILE_KEY, null);
    } catch (err) {
      console.warn('[me] Failed to clear session:', err);
    }
  }
}

/**
 * Callback for when the session tokens are refreshed.
 * Updates our stored session with new tokens.
 */
function onSessionRefresh(refreshedSession) {
  currentSession = refreshedSession;
  saveSession();
}

// ============================================================================
// Lexicon directory (lexidex) cache
// ============================================================================

let lexiconCache = null; // Array of { nsid, domain }
let lexiconCacheLoading = false;

const LEXICON_DIR_KEY = 'lexiconDirectory';
const LEXICON_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the lexicon directory from network (lexidex.bsky.dev).
 * Returns the array and persists it to settings.
 */
async function fetchLexiconDirectoryFromNetwork() {
  // Step 1: Fetch homepage to get domain list
  const homeRes = await fetch('https://lexidex.bsky.dev/');

  if (!homeRes.ok) {
    throw new Error(`Failed to fetch lexidex: ${homeRes.status}`);
  }

  const homeHtml = await homeRes.text();

  // Parse domains from homepage: <a href="/domain/xxx">
  const domainRegex = /href="\/domain\/([^"]+)"/g;
  const domains = [];
  let match;
  while ((match = domainRegex.exec(homeHtml)) !== null) {
    domains.push(match[1]);
  }

  if (domains.length === 0) {
    throw new Error('No domains found on lexidex');
  }

  // Step 2: Fetch each domain page in parallel
  const allLexicons = [];
  const domainFetches = domains.map(async (domain) => {
    try {
      const res = await fetch(`https://lexidex.bsky.dev/domain/${domain}`);

      if (!res.ok) return;

      const html = await res.text();

      // Parse lexicon NSIDs: <a href="/lexicon/NSID">NSID</a>
      const lexRegex = /href="\/lexicon\/([^"]+)"/g;
      let m;
      while ((m = lexRegex.exec(html)) !== null) {
        allLexicons.push({ nsid: m[1], domain });
      }
    } catch (err) {
      console.warn(`[me] Failed to fetch lexidex domain ${domain}:`, err);
    }
  });

  await Promise.all(domainFetches);

  // Add known lexicons not yet indexed by lexidex
  const EXTRA_LEXICONS = [
    { nsid: 'site.standard.publication', domain: 'standard.site' },
    { nsid: 'site.standard.document', domain: 'standard.site' },
    { nsid: 'site.standard.graph.subscription', domain: 'standard.site' },
  ];
  for (const extra of EXTRA_LEXICONS) {
    if (!allLexicons.some(l => l.nsid === extra.nsid)) {
      allLexicons.push(extra);
    }
  }

  // Sort by NSID
  allLexicons.sort((a, b) => a.nsid.localeCompare(b.nsid));

  // Persist to settings
  if (api) {
    try {
      await api.settings.setKey(LEXICON_DIR_KEY, {
        lexicons: allLexicons,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[me] Failed to persist lexicon directory:', err);
    }
  }

  lexiconCache = allLexicons;
  console.log(`[me] Loaded ${allLexicons.length} lexicons from ${domains.length} domains`);
  return allLexicons;
}

/**
 * Fetch and parse the lexidex directory.
 * Uses persisted cache for instant loading, with background refresh if stale.
 */
async function fetchLexiconDirectory() {
  if (lexiconCache) return lexiconCache;
  if (lexiconCacheLoading) return null;

  // Check persisted cache first
  if (api) {
    try {
      const result = await api.settings.getKey(LEXICON_DIR_KEY);
      if (result.success && result.data && result.data.lexicons) {
        lexiconCache = result.data.lexicons;
        console.log(`[me] Restored ${lexiconCache.length} lexicons from persisted cache`);

        // If stale, refresh in background (don't block)
        const age = Date.now() - (result.data.fetchedAt || 0);
        if (age > LEXICON_DIR_MAX_AGE_MS) {
          console.log('[me] Lexicon directory cache is stale, refreshing in background...');
          fetchLexiconDirectoryFromNetwork().catch(err => {
            console.warn('[me] Background lexicon directory refresh failed:', err);
          });
        }

        return lexiconCache;
      }
    } catch (err) {
      console.warn('[me] Failed to load persisted lexicon directory:', err);
    }
  }

  // No persisted cache — fetch from network
  lexiconCacheLoading = true;
  try {
    return await fetchLexiconDirectoryFromNetwork();
  } catch (err) {
    console.error('[me] Lexicon directory fetch failed:', err);
    throw err;
  } finally {
    lexiconCacheLoading = false;
  }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Open the Me home window
 */
function openMe() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/me-core/home.html', {
      role: 'workspace',
      key: 'me-home',
      width: 860,
      height: 620,
      title: 'Me',
    });
  }
}

/**
 * Login command — opens the Me home window for login
 */
async function executeLogin(ctx) {
  openMe();
  return { success: true, message: 'Opening login...' };
}

/**
 * Logout command
 */
async function executeLogout(ctx) {
  if (!currentSession) {
    return { success: true, message: 'Not logged in' };
  }
  const handle = currentSession.handle;
  await clearSession();
  api.publish('me:session-changed', { authenticated: false }, api.scopes.GLOBAL);
  return { success: true, message: `Logged out from @${handle}` };
}

/**
 * Status command
 */
async function executeStatus(ctx) {
  if (!currentSession) {
    return {
      success: true,
      output: 'Not logged in. Use "me login" to connect your AT Protocol account.',
      mimeType: 'text/plain',
    };
  }

  const name = currentProfile?.displayName || currentSession.handle;
  return {
    success: true,
    output: {
      data: {
        handle: currentSession.handle,
        did: currentSession.did,
        pds: currentSession.pdsUrl,
        displayName: currentProfile?.displayName || null,
      },
      mimeType: 'application/json',
      title: `Logged in as @${name}`,
    },
  };
}

/**
 * Lexicons command — show collections in the repo
 */
async function executeLexicons(ctx) {
  if (!currentSession) {
    return { success: false, message: 'Not logged in. Use "me login" first.' };
  }

  try {
    const collections = await getCollections(currentSession, onSessionRefresh);
    const counts = await getAllCollectionCounts(currentSession, collections, onSessionRefresh);

    // Save updated session if tokens were refreshed
    await saveSession();

    return {
      success: true,
      output: {
        data: counts.map(c => ({
          lexicon: c.nsid,
          records: c.hasMore ? `${c.count}+` : c.count,
        })),
        mimeType: 'application/json',
        title: `${collections.length} collections in repo`,
      },
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ============================================================================
// PubSub API for the home UI
// ============================================================================

function setupPubSub() {
  if (!api) return;

  // Home UI requests session state
  api.subscribe('me:get-session', async () => {
    if (currentSession) {
      api.publish('me:session-state', {
        authenticated: true,
        handle: currentSession.handle,
        did: currentSession.did,
        pdsUrl: currentSession.pdsUrl,
        profile: currentProfile,
      }, api.scopes.GLOBAL);
    } else {
      api.publish('me:session-state', {
        authenticated: false,
      }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);

  // Home UI requests actor search
  api.subscribe('me:search-actors', async (msg) => {
    const results = await searchActors(msg.query);
    api.publish('me:search-actors:response', { results }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Home UI requests login via OAuth
  api.subscribe('me:do-login', async (msg) => {
    try {
      currentSession = await loginWithOAuth(msg.handle);

      // Fetch profile
      currentProfile = await getProfile(currentSession.did);

      await saveSession();

      api.publish('me:session-changed', {
        authenticated: true,
        handle: currentSession.handle,
        did: currentSession.did,
        pdsUrl: currentSession.pdsUrl,
        profile: currentProfile,
      }, api.scopes.GLOBAL);

      console.log('[me] Logged in as', currentSession.handle);
    } catch (err) {
      api.publish('me:login-error', { message: err.message }, api.scopes.GLOBAL);
      console.error('[me] Login failed:', err);
    }
  }, api.scopes.GLOBAL);

  // Home UI requests logout
  api.subscribe('me:do-logout', async () => {
    await clearSession();
    api.publish('me:session-changed', { authenticated: false }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Home UI requests explore lexicons (lexidex directory)
  api.subscribe('me:search-lexicons', async () => {
    try {
      const lexicons = await fetchLexiconDirectory();
      api.publish('me:search-lexicons:response', { lexicons: lexicons || [] }, api.scopes.GLOBAL);
    } catch (err) {
      api.publish('me:search-lexicons:response', { error: err.message }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);

  // Home UI requests collections/lexicons
  api.subscribe('me:get-collections', async () => {
    if (!currentSession) {
      api.publish('me:collections:response', { error: 'Not logged in' }, api.scopes.GLOBAL);
      return;
    }
    try {
      const collections = await getCollections(currentSession, onSessionRefresh);
      const counts = await getAllCollectionCounts(currentSession, collections, onSessionRefresh);
      await saveSession();
      api.publish('me:collections:response', { collections: counts }, api.scopes.GLOBAL);
    } catch (err) {
      api.publish('me:collections:response', { error: err.message }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);

  // Home UI requests record creation
  api.subscribe('me:create-record', async (msg) => {
    if (!currentSession) {
      api.publish('me:create-record:response', { error: 'Not logged in' }, api.scopes.GLOBAL);
      return;
    }
    try {
      const { collection, record } = msg;

      // Handle blob uploads if any field has __file marker
      const processedRecord = await processBlobs(record);

      const result = await xrpcPost(currentSession, 'com.atproto.repo.createRecord', {
        repo: currentSession.did,
        collection,
        record: processedRecord,
      }, onSessionRefresh);

      await saveSession();
      api.publish('me:create-record:response', {
        success: true,
        uri: result.uri,
        cid: result.cid,
        validationStatus: result.validationStatus,
      }, api.scopes.GLOBAL);
      console.log('[me] Record created:', result.uri);
    } catch (err) {
      api.publish('me:create-record:response', { error: err.message }, api.scopes.GLOBAL);
      console.error('[me] Record creation failed:', err);
    }
  }, api.scopes.GLOBAL);
}

/**
 * Process a record object, uploading any blob fields.
 * Blob fields are marked with { __file: File } during form collection.
 * This is handled in the home UI before sending to background.
 */
async function processBlobs(record) {
  // For now, blobs are uploaded by the UI before sending.
  // This is a passthrough in case we need server-side processing later.
  return record;
}

// ============================================================================
// Extension lifecycle
// ============================================================================

const extension = {
  id: 'me-core',
  labels: {
    name: 'Me',
  },

  registerCommands() {
    api.commands.register({
      name: 'me:core',
      description: 'Open AT Protocol identity panel',
      execute: () => {
        openMe();
        return { success: true };
      },
    });

    console.log('[me] Commands registered');
  },

  async init() {
    console.log('[me] Initializing...');

    if (!hasPeekAPI) {
      console.log('[me] Running without Peek API — limited functionality');
      return;
    }

    // Load saved session
    await loadSession();

    // If we have a saved session, refresh profile info
    if (currentSession) {
      try {
        const profile = await getProfile(currentSession.did);
        if (profile) {
          currentProfile = profile;
          await saveSession();
        }
      } catch {
        // Profile refresh is best-effort
      }
    }

    // Register commands
    this.registerCommands();

    // Set up pubsub for UI communication
    setupPubSub();

    console.log('[me] Extension loaded', currentSession ? `(session: @${currentSession.handle})` : '(no session)');
  },

  uninit() {
    console.log('[me] Cleaning up...');
    if (hasPeekAPI) {
      api.commands.unregister('me:core');
    }
  },
};

export default extension;
