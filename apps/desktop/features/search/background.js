/**
 * Search Extension Background Script
 *
 * Opens a search view with text and tag-based search.
 * Runs in consolidated extension host (iframe).
 * Loads lazily on first command invocation.
 */

const id = 'search';
const api = window.app;

const baseAddress = 'peek://search/home.html';

// Typing only `#tags` and pressing Enter searches by those tags: every token is `#name`.
const HASHTAG_QUERY_CLAIM = { tokenPattern: '^#[^\\s#]+$' };

let isOpeningSearch = false;

const openSearchWindow = async (query) => {
  if (isOpeningSearch) return;
  isOpeningSearch = true;
  try {
    const url = query
      ? `${baseAddress}?q=${encodeURIComponent(query)}`
      : baseAddress;

    await api.window.open(url, {
      role: 'workspace',
      height: 768,
      width: 700,
      // Transparency can only be set at creation, so this window carries it
      // whether or not the see-through switch is on yet.
      transparent: true,
      trackingSource: 'cmd',
      trackingSourceId: 'search'
    });
  } catch (error) {
    console.error('[ext:search] Failed to open search window:', error);
  } finally {
    isOpeningSearch = false;
  }
};

const init = async () => {
  // Register command handler
  api.commands.register({
    name: 'search',
    description: 'Search items by text and tags',
    claimsInput: HASHTAG_QUERY_CLAIM,
    execute: async (params) => {
      const query = params?.text || params?.search || '';
      openSearchWindow(query);
    }
  });

  // Listen for search requests from cmd palette
  api.pubsub.subscribe('cmd:execute:search', (msg) => {
    const query = msg?.data?.query || msg?.data?.text || '';
    openSearchWindow(query);
  });
};

const uninit = () => {
  // Nothing to clean up
};

export default {
  id,
  init,
  uninit
};
