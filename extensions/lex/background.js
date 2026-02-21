/**
 * Lexicon Studio Extension — Background (lightweight)
 *
 * This background page only handles:
 * - Command registration (lexicon studio, new, new {FriendlyName} shortcuts)
 * - Listening for session/collection changes to update command state
 *
 * All XRPC/OAuth/session management is done directly in home.js and chain-form.js
 * via the atproto.js module. No pubsub request/response channels needed.
 */

// Feature detection
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

// ============================================================================
// BroadcastChannel for intra-extension messaging (background.js <-> home.js)
// ============================================================================

let lexChannel = null;
const lexChannelHandlers = {};

try {
  lexChannel = new BroadcastChannel('lex');
  lexChannel.onmessage = (e) => {
    const { topic, data } = e.data;
    if (lexChannelHandlers[topic]) {
      for (const handler of lexChannelHandlers[topic]) {
        handler(data);
      }
    }
  };
} catch (err) {
  console.warn('[lex] BroadcastChannel unavailable, using IPC fallback:', err.message);
}

function onChannel(topic, handler) {
  if (!lexChannelHandlers[topic]) lexChannelHandlers[topic] = [];
  lexChannelHandlers[topic].push(handler);
  if (!lexChannel) api.subscribe(topic, handler, api.scopes.GLOBAL);
}

function emitChannel(topic, data) {
  if (lexChannel) {
    lexChannel.postMessage({ topic, data });
  } else {
    api.publish(topic, data, api.scopes.GLOBAL);
  }
}

// ============================================================================
// Session state (read-only, loaded from storage for command auth checks)
// ============================================================================

let currentSession = null;

const STORAGE_KEY = 'session';

async function loadSession() {
  if (!api) return;
  try {
    const result = await api.settings.getKey(STORAGE_KEY);
    if (result.success && result.data) {
      currentSession = result.data;
      console.log('[lex:bg] Restored session for', currentSession.handle);
    }
  } catch (err) {
    console.warn('[lex:bg] Failed to load session:', err);
  }
}

// ============================================================================
// Commands
// ============================================================================

function openMe() {
  if (hasPeekAPI) {
    api.window.open('peek://lex/home.html', {
      role: 'workspace',
      key: 'lex-home',
      width: 860,
      height: 620,
      title: 'Lexicon Studio',
    });
  }
}

function openMeWithLexicon(nsid) {
  if (!hasPeekAPI) return;
  api.window.open('peek://lex/home.html', {
    role: 'workspace',
    key: 'lex-home',
    width: 860,
    height: 620,
    title: 'Lexicon Studio',
  });
  // Publish after a short delay to let the window load
  setTimeout(() => {
    emitChannel('lex:open-create', { nsid });
  }, 300);
}

// ============================================================================
// "new" command system
// ============================================================================

const RECENT_LEXICONS_KEY = 'recentLexicons';
let registeredNewCommands = [];
let knownCollectionNsids = [];
let knownRecentNsids = [];

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

function nsidToFriendlyName(nsid) {
  if (FRIENDLY_NAMES[nsid]) return FRIENDLY_NAMES[nsid];
  const parts = nsid.split('.');
  const last = parts[parts.length - 1];
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function nsidDomainLabel(nsid) {
  const parts = nsid.split('.');
  return parts.length >= 2 ? parts[1] : parts[0];
}

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

    let displayName;
    if (siblings.length > 1) {
      displayName = `${friendly} (${nsidDomainLabel(nsid)})`;
    } else {
      displayName = friendly;
    }

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
            interactive: 'peek://lex/chain-form.html',
          },
        };
      },
    });
    registeredNewCommands.push(cmdName);
  }

  if (registeredNewCommands.length > 0) {
    console.log('[lex:bg] Registered "new" commands:', registeredNewCommands.length);
  }
}

// ============================================================================
// Extension lifecycle
// ============================================================================

const extension = {
  id: 'lex',
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

    // Base "new" command
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
              interactive: 'peek://lex/chain-form.html',
            },
          };
        }

        // No specific NSID — open the Create panel with its built-in picker
        openMeWithLexicon('');
        return { success: true };
      },
    });

    console.log('[lex:bg] Commands registered');
  },

  async init() {
    console.log('[lex:bg] Initializing...');

    if (!hasPeekAPI) {
      console.log('[lex:bg] Running without Peek API — limited functionality');
      return;
    }

    // Load saved session (read-only, for command auth checks)
    await loadSession();

    // Register commands
    this.registerCommands();

    // Load recent lexicons and register "new" commands
    await loadAndRegisterNewCommands();

    // Listen for session changes from home.js
    onChannel('lex:session-changed', (msg) => {
      if (msg.authenticated) {
        // Reload session from storage to get full session data
        loadSession();
      } else {
        currentSession = null;
      }
    });

    // Listen for recent lexicons changes from home.js / chain-form.js
    onChannel('lex:recent-lexicons-changed', (msg) => {
      if (Array.isArray(msg.nsids)) {
        // Merge new nsids into known recent
        for (const nsid of msg.nsids) {
          if (!knownRecentNsids.includes(nsid)) {
            knownRecentNsids.push(nsid);
          }
        }
        knownRecentNsids.sort();
        rebuildNewCommands();
      }
    });

    // Listen for collections loaded from home.js
    onChannel('lex:collections-loaded', (msg) => {
      if (Array.isArray(msg.collections)) {
        knownCollectionNsids = msg.collections;
        rebuildNewCommands();
      }
    });

    console.log('[lex:bg] Extension loaded', currentSession ? `(session: @${currentSession.handle})` : '(no session)');
  },

  uninit() {
    console.log('[lex:bg] Cleaning up...');
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
