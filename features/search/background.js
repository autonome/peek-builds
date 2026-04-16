/**
 * Search Extension Background Script
 *
 * Opens a search view with text and tag-based search.
 * Runs in consolidated extension host (iframe).
 * Loads lazily on first command invocation.
 */

const id = 'search';
const api = window.app;
const debug = api.debug;

const baseAddress = 'peek://ext/search/home.html';

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
      key: 'search-home',
      height: 768,
      width: 700,
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
    execute: async (params) => {
      const query = params?.text || '';
      openSearchWindow(query);
    }
  });

  // Listen for search requests from cmd palette
  api.pubsub.subscribe('cmd:execute:search', (msg) => {
    const query = msg?.data?.query || msg?.data?.text || '';
    openSearchWindow(query);
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  // Nothing to clean up
};

export default {
  id,
  init,
  uninit
};
