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
      title: 'Lexicon Studio',
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

      // Add to recent lexicons
      addRecentLexiconFromBackground(collection);
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
// "new" command system — register "new {FriendlyName}" for known lexicons
// ============================================================================

const RECENT_LEXICONS_KEY = 'recentLexicons';
let registeredNewCommands = []; // Track registered "new ..." command names for cleanup
let knownCollectionNsids = []; // NSIDs from user's repo collections
let knownRecentNsids = []; // NSIDs from user's recent lexicons

/**
 * Well-known AT Protocol lexicon NSIDs mapped to human-readable names.
 * Duplicated from lexicon-ui.js since background.js can't easily import it.
 */
const FRIENDLY_NAMES = {
  'app.bsky.feed.post': 'Post',
  'app.bsky.feed.like': 'Like',
  'app.bsky.feed.repost': 'Repost',
  'app.bsky.feed.generator': 'Feed Generator',
  'app.bsky.feed.threadgate': 'Thread Gate',
  'app.bsky.feed.postgate': 'Post Gate',
  'app.bsky.graph.follow': 'Follow',
  'app.bsky.graph.block': 'Block',
  'app.bsky.graph.list': 'List',
  'app.bsky.graph.listitem': 'List Item',
  'app.bsky.graph.listblock': 'List Block',
  'app.bsky.graph.starterpack': 'Starter Pack',
  'app.bsky.actor.profile': 'Profile',
  'app.bsky.labeler.service': 'Labeler',
  'chat.bsky.actor.declaration': 'Chat Settings',
  'com.whtwnd.blog.entry': 'Blog Entry',
  'blue.linkat.board': 'Board',
  'fyi.frontpage.post': 'Frontpage Post',
  'site.standard.publication': 'Publication',
  'site.standard.document': 'Document',
  'site.standard.graph.subscription': 'Subscription',
};

/**
 * Convert an NSID to a friendly name.
 * Uses hardcoded lookup, then falls back to camelCase splitting of the last segment.
 */
function nsidToFriendlyName(nsid) {
  if (FRIENDLY_NAMES[nsid]) return FRIENDLY_NAMES[nsid];
  const parts = nsid.split('.');
  const last = parts[parts.length - 1];
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

/**
 * Extract a short domain label from an NSID for disambiguation.
 * e.g. "app.bsky.feed.post" -> "bsky", "fyi.frontpage.post" -> "frontpage"
 */
function nsidDomainLabel(nsid) {
  const parts = nsid.split('.');
  // Use the second segment which is usually the most identifying part
  // e.g. app.bsky -> "bsky", fyi.frontpage -> "frontpage", site.standard -> "standard"
  return parts.length >= 2 ? parts[1] : parts[0];
}

/**
 * Load recent lexicons from settings and re-register "new" commands.
 */
async function loadAndRegisterNewCommands() {
  if (!api) return;
  try {
    const result = await api.settings.getKey(RECENT_LEXICONS_KEY);
    if (result.success && Array.isArray(result.data)) {
      knownRecentNsids = result.data;
    }
  } catch {}
  rebuildNewCommands();
}

/**
 * Add an NSID to recent lexicons from background (after record creation).
 * Persists to settings and rebuilds commands.
 */
async function addRecentLexiconFromBackground(nsid) {
  if (!api || !nsid) return;
  if (knownRecentNsids.includes(nsid)) return;
  knownRecentNsids.push(nsid);
  knownRecentNsids.sort();
  try {
    await api.settings.setKey(RECENT_LEXICONS_KEY, knownRecentNsids);
  } catch {}
  rebuildNewCommands();
  // Notify any open home UI to refresh sidebar
  api.publish('me:recent-lexicons-changed', { nsids: knownRecentNsids }, api.scopes.GLOBAL);
}

/**
 * Rebuild all "new ..." commands from the combined set of
 * recent lexicons and repo collections, with deduplication
 * and friendly-name collision handling.
 */
function rebuildNewCommands() {
  if (!api) return;

  // Unregister old commands
  for (const name of registeredNewCommands) {
    try { api.commands.unregister(name); } catch {}
  }
  registeredNewCommands = [];

  // Deduplicate NSIDs from both sources
  const allNsids = [...new Set([...knownRecentNsids, ...knownCollectionNsids])];

  if (allNsids.length === 0) return;

  // Build friendly name -> [nsid, ...] map to detect collisions
  const nameToNsids = new Map();
  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    if (!nameToNsids.has(friendly)) {
      nameToNsids.set(friendly, []);
    }
    nameToNsids.get(friendly).push(nsid);
  }

  // Register each NSID as a "new {FriendlyName}" command
  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    const siblings = nameToNsids.get(friendly);

    // Disambiguate if multiple NSIDs produce the same friendly name
    let displayName;
    if (siblings.length > 1) {
      displayName = `${friendly} (${nsidDomainLabel(nsid)})`;
    } else {
      displayName = friendly;
    }

    // Include the full NSID in the command name so the palette can match on it
    const cmdName = `new ${displayName} — ${nsid}`;
    api.commands.register({
      name: cmdName,
      description: `Create ${nsid} record`,
      execute: () => {
        if (!currentSession) {
          openMe();
          return { success: false, message: 'Not logged in. Opening login...' };
        }
        return {
          success: true,
          output: {
            data: { nsid },
            mimeType: 'application/x-lexicon-form',
            title: displayName,
            interactive: 'peek://ext/me-core/chain-form.html',
          },
        };
      },
    });
    registeredNewCommands.push(cmdName);
  }

  if (registeredNewCommands.length > 0) {
    console.log('[me] Registered "new" commands:', registeredNewCommands.length);
  }
}

/**
 * Open the Me home window with the Create panel pre-loaded for a specific lexicon.
 */
function openMeWithLexicon(nsid) {
  if (!hasPeekAPI) return;
  api.window.open('peek://ext/me-core/home.html', {
    role: 'workspace',
    key: 'me-home',
    width: 860,
    height: 620,
    title: 'Lexicon Studio',
  });
  // Publish after a short delay to let the window load
  setTimeout(() => {
    api.publish('me:open-create', { nsid }, api.scopes.GLOBAL);
  }, 300);
}

// ============================================================================
// Extension lifecycle
// ============================================================================

const extension = {
  id: 'me-core',
  labels: {
    name: 'Lexicon Studio',
  },

  registerCommands() {
    api.commands.register({
      name: 'lexicon studio',
      description: 'Open AT Protocol identity panel',
      execute: () => {
        openMe();
        return { success: true };
      },
    });

    // Base "new" command — opens create panel, optionally with a specific NSID
    api.commands.register({
      name: 'new',
      description: 'Create a new AT Protocol record',
      execute: async (ctx) => {
        if (!currentSession) {
          openMe();
          return { success: false, message: 'Not logged in. Opening login...' };
        }

        // If search text contains a dotted NSID, open chain form popup
        if (ctx.search && ctx.search.includes('.')) {
          const nsid = ctx.search.trim();
          const friendlyName = nsidToFriendlyName(nsid);
          return {
            success: true,
            output: {
              data: { nsid },
              mimeType: 'application/x-lexicon-form',
              title: friendlyName,
              interactive: 'peek://ext/me-core/chain-form.html',
            },
          };
        }

        // No specific NSID — open the Create panel with its built-in picker
        openMeWithLexicon('');
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

    // Load recent lexicons and register "new" commands
    await loadAndRegisterNewCommands();

    // Listen for recent lexicons changes to re-register "new" commands
    api.subscribe('me:recent-lexicons-changed', (msg) => {
      if (Array.isArray(msg.nsids)) {
        knownRecentNsids = msg.nsids;
        rebuildNewCommands();
      }
    }, api.scopes.GLOBAL);

    // Listen for collections responses to register "new" commands for repo collections
    api.subscribe('me:collections:response', (msg) => {
      if (Array.isArray(msg.collections)) {
        knownCollectionNsids = msg.collections.map(c => c.nsid);
        rebuildNewCommands();
      }
    }, api.scopes.GLOBAL);

    console.log('[me] Extension loaded', currentSession ? `(session: @${currentSession.handle})` : '(no session)');
  },

  uninit() {
    console.log('[me] Cleaning up...');
    if (hasPeekAPI) {
      api.commands.unregister('lexicon studio');
      api.commands.unregister('new');
      for (const name of registeredNewCommands) {
        try { api.commands.unregister(name); } catch {}
      }
      registeredNewCommands = [];
    }
  },
};

export default extension;
