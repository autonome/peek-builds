/**
 * Lexicon Studio Background Script
 *
 * Registers a "lex" noun for the command system, providing:
 * - query: filter known NSIDs by search string
 * - create: return lexicon form chaining output for a selected NSID
 * - browse: open the Lexicon Studio window
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';
import { nsidToFriendlyName } from './lexicon-ui.js';

const api = window.app;

// ============================================================================
// Session + NSID discovery
// ============================================================================

const STORAGE_KEY = 'session';
const LEXICON_DIR_KEY = 'lexiconDirectory';
const LEXICON_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let currentSession = null;
let lexiconCache = null;
let lexiconCacheLoading = false;
let knownCollectionNsids = [];

async function loadSession() {
  try {
    const result = await api.settings.get(STORAGE_KEY);
    if (result && !result.error && result.value) {
      currentSession = result.value;
      console.log('[lex:bg] Restored session for', currentSession.handle);
    }
  } catch (err) {
    console.warn('[lex:bg] Failed to load session:', err);
  }
}

async function fetchLexiconDirectoryFromNetwork() {
  const homeRes = await fetch('https://lexidex.bsky.dev/');
  if (!homeRes.ok) throw new Error(`Failed to fetch lexidex: ${homeRes.status}`);

  const homeHtml = await homeRes.text();
  const domainRegex = /href="\/domain\/([^"]+)"/g;
  const domains = [];
  let match;
  while ((match = domainRegex.exec(homeHtml)) !== null) {
    domains.push(match[1]);
  }

  if (domains.length === 0) throw new Error('No domains found on lexidex');

  const allLexicons = [];
  const domainFetches = domains.map(async (domain) => {
    try {
      const res = await fetch(`https://lexidex.bsky.dev/domain/${domain}`);
      if (!res.ok) return;
      const html = await res.text();
      const lexRegex = /href="\/lexicon\/([^"]+)"/g;
      let m;
      while ((m = lexRegex.exec(html)) !== null) {
        allLexicons.push({ nsid: m[1], domain });
      }
    } catch (err) {
      console.warn(`[lex:bg] Failed to fetch lexidex domain ${domain}:`, err);
    }
  });

  await Promise.all(domainFetches);

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

  allLexicons.sort((a, b) => a.nsid.localeCompare(b.nsid));

  try {
    const setResult = await api.settings.set(LEXICON_DIR_KEY, {
      lexicons: allLexicons,
      fetchedAt: Date.now(),
    });
    if (setResult && setResult.error) {
      console.warn('[lex:bg] Failed to persist lexicon directory:', setResult.error);
    }
  } catch (err) {
    console.warn('[lex:bg] Failed to persist lexicon directory:', err);
  }

  lexiconCache = allLexicons;
  console.log(`[lex:bg] Loaded ${allLexicons.length} lexicons from ${domains.length} domains`);
  return allLexicons;
}

async function fetchLexiconDirectory() {
  if (lexiconCache) return lexiconCache;
  if (lexiconCacheLoading) return null;

  try {
    const result = await api.settings.get(LEXICON_DIR_KEY);
    if (result && !result.error && result.value && result.value.lexicons) {
      lexiconCache = result.value.lexicons;
      console.log(`[lex:bg] Restored ${lexiconCache.length} lexicons from persisted cache`);

      const age = Date.now() - (result.value.fetchedAt || 0);
      if (age > LEXICON_DIR_MAX_AGE_MS) {
        console.log('[lex:bg] Lexicon directory cache is stale, refreshing in background...');
        fetchLexiconDirectoryFromNetwork().catch(err => {
          console.warn('[lex:bg] Background lexicon directory refresh failed:', err);
        });
      }

      return lexiconCache;
    }
  } catch (err) {
    console.warn('[lex:bg] Failed to load persisted lexicon directory:', err);
  }

  lexiconCacheLoading = true;
  try {
    return await fetchLexiconDirectoryFromNetwork();
  } catch (err) {
    console.error('[lex:bg] Lexicon directory fetch failed:', err);
    return null;
  } finally {
    lexiconCacheLoading = false;
  }
}

/**
 * Discover collection NSIDs from the user's repo (requires active session).
 */
async function discoverCollections() {
  if (!currentSession) return;
  try {
    const data = await xrpcGet('com.atproto.repo.describeRepo', {
      repo: currentSession.did,
    });
    knownCollectionNsids = data.collections || [];
    console.log(`[lex:bg] Discovered ${knownCollectionNsids.length} collections`);
  } catch (err) {
    console.warn('[lex:bg] Failed to discover collections:', err);
  }
}

/**
 * Simple unauthenticated XRPC GET (used for repo describe which is public).
 */
async function xrpcGet(method, params) {
  const pdsUrl = currentSession?.pdsUrl || 'https://bsky.social';
  const qs = new URLSearchParams(params).toString();
  const url = `${pdsUrl}/xrpc/${method}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`XRPC ${method} failed: ${res.status}`);
  return res.json();
}

// ============================================================================
// Helpers
// ============================================================================

function openLexWindow() {
  api.window.open('peek://lex/home.html', {
    role: 'workspace',
    key: 'lex-home',
    width: 860,
    height: 620,
    title: 'Lexicon Studio',
    webPreferences: { webSecurity: false },
  });
}

/**
 * Get all known NSIDs — merge collection NSIDs with lexicon directory.
 */
async function getAllNsids() {
  const dirLexicons = await fetchLexiconDirectory();
  const dirNsids = dirLexicons ? dirLexicons.map(l => l.nsid) : [];
  return [...new Set([...knownCollectionNsids, ...dirNsids])].sort();
}

// ============================================================================
// Noun registration
// ============================================================================

function registerCommands() {
  registerNoun({
    name: 'lex',
    singular: 'lex',
    description: 'AT Protocol lexicons',
    produces: 'application/x-lexicon-form',

    query: async ({ search }) => {
      const allNsids = await getAllNsids();
      let filtered = allNsids;
      if (search) {
        const q = search.toLowerCase();
        filtered = allNsids.filter(nsid => {
          const friendly = nsidToFriendlyName(nsid).toLowerCase();
          return nsid.toLowerCase().includes(q) || friendly.includes(q);
        });
      }
      return {
        success: true,
        output: {
          data: filtered.slice(0, 30).map(nsid => ({
            name: `${nsidToFriendlyName(nsid)} — ${nsid}`,
            nsid,
          })),
          mimeType: 'application/json',
          title: `Lexicons (${filtered.length})`,
        },
      };
    },

    create: async ({ search }) => {
      if (!currentSession) {
        openLexWindow();
        return { success: false, message: 'Not logged in. Opening Lexicon Studio...' };
      }
      // If search contains a dot, treat it as an NSID
      const nsid = (search && search.includes('.'))
        ? search.trim()
        // Otherwise try to extract NSID from a query result name like "Post — app.bsky.feed.post"
        : (search && search.includes(' — '))
          ? search.split(' — ').pop().trim()
          : null;

      if (!nsid) {
        openLexWindow();
        return { success: true };
      }

      const friendlyName = nsidToFriendlyName(nsid);
      return {
        success: true,
        output: {
          data: { nsid },
          mimeType: 'application/x-lexicon-form',
          title: friendlyName,
          interactive: 'peek://lex/chain-form.html',
        },
      };
    },

    browse: async () => {
      openLexWindow();
    },
  });

  console.log('[lex:bg] Noun registered: lex');
}

// ============================================================================
// Extension lifecycle
// ============================================================================

const extension = {
  id: 'lex',
  labels: { name: 'Lexicon Studio' },

  async init() {
    console.log('[lex:bg] init');

    await loadSession();
    registerCommands();

    // Discover collections in background (non-blocking)
    discoverCollections();

    // Listen for session changes from the UI window
    api.pubsub.subscribe('lex:session-changed', (msg) => {
      if (msg.session) {
        currentSession = msg.session;
        console.log('[lex:bg] Session updated for', currentSession.handle);
        discoverCollections();
      } else {
        currentSession = null;
        knownCollectionNsids = [];
        console.log('[lex:bg] Session cleared');
      }
    }, api.scopes.GLOBAL);
  },

  uninit() {
    unregisterNoun('lex');
    console.log('[lex:bg] Noun unregistered: lex');
  },
};

export default extension;
