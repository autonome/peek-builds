// Navigation history tracking helper
// Uses the unified items/item_visits system
import api from '../api.js';

/**
 * Track a navigation event using the unified trackNavigation API.
 * This delegates to the backend's trackNavigation() which finds or creates
 * an item for the URL and records a visit in item_visits.
 * @param {string} uri - The URL navigated to
 * @param {Object} options - Navigation options
 * @param {string} options.source - Source of navigation (peek, slide, direct, etc.)
 * @param {string} options.sourceId - ID of the source feature
 * @param {string} options.windowType - Type of window (modal, persistent, main)
 * @param {string} options.title - Page title
 */
export const trackNavigation = async (uri, options = {}) => {
  try {
    const result = await api.datastore.trackNavigation(uri, {
      source: options.source || 'direct',
      sourceId: options.sourceId || '',
      windowType: options.windowType || 'main',
      title: options.title || '',
    });

    if (!result.success) {
      console.error('Failed to track navigation:', result.error);
      return null;
    }

    const data = result.data;
    console.log('Tracked navigation:', {
      visitId: data.visitId,
      itemId: data.itemId,
      uri,
      source: options.source
    });

    return { visitId: data.visitId, itemId: data.itemId, addressId: data.itemId };
  } catch (error) {
    console.error('Error tracking navigation:', error);
    return null;
  }
};

/**
 * Get navigation history using item_visits
 * @param {Object} filter - Query filter options
 * @returns {Array} Array of visit records with item details
 */
export const getHistory = async (filter = {}) => {
  try {
    const visitsResult = await api.datastore.queryItemVisits(filter);
    if (!visitsResult.success) {
      console.error('Failed to query item visits:', visitsResult.error);
      return [];
    }

    const visits = visitsResult.data;

    // Enrich with item details
    const enriched = await Promise.all(visits.map(async visit => {
      const itemResult = await api.datastore.getItem(visit.itemId);
      const item = itemResult.success ? itemResult.data : null;
      return {
        ...visit,
        // Provide backward-compatible address-like shape
        address: item ? {
          id: item.id,
          uri: item.content,
          title: item.title,
          domain: item.domain,
          favicon: item.favicon,
          mimeType: item.mimeType,
        } : null
      };
    }));

    return enriched;
  } catch (error) {
    console.error('Error getting history:', error);
    return [];
  }
};

/**
 * Get URL items sorted by visit frequency
 * @param {number} limit - Number of results to return
 * @returns {Array} Array of items with visit counts
 */
export const getFrequentAddresses = async (limit = 10) => {
  try {
    const result = await api.datastore.queryItems({
      type: 'url',
      sortBy: 'visitCount',
      limit
    });

    return result.success ? result.data : [];
  } catch (error) {
    console.error('Error getting frequent URLs:', error);
    return [];
  }
};

/**
 * Get recently visited URL items
 * @param {number} limit - Number of results to return
 * @returns {Array} Array of items sorted by last visit
 */
export const getRecentAddresses = async (limit = 10) => {
  try {
    const result = await api.datastore.queryItems({
      type: 'url',
      sortBy: 'lastVisit',
      limit
    });

    return result.success ? result.data : [];
  } catch (error) {
    console.error('Error getting recent URLs:', error);
    return [];
  }
};

export default {
  trackNavigation,
  getHistory,
  getFrequentAddresses,
  getRecentAddresses
};
