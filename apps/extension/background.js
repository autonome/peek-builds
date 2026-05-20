/**
 * Peek Browser Extension - Service Worker
 *
 * Handles auto-sync alarms, install events, and message passing.
 */

import { openDatabase } from './datastore.js';
import { ensureDefaultProfile, getCurrentProfile, getSyncConfig, updateProfileEnvironment, enableSync } from './profiles.js';
import { getConfig as getEngineConfig, setConfig as setEngineConfig } from './engine.js';
import { syncAll, getSyncConfig as getFullSyncConfig, getSyncStatus } from './sync.js';
import { DATASTORE_VERSION, PROTOCOL_VERSION } from './version.js';
import { getEnvironment } from './environment.js';
import { initBookmarkSync, activateListener, deactivateListener, importAllBookmarks, getBookmarkStats } from './bookmarks.js';
import { initTabSync, activateListeners as activateTabListeners, deactivateListeners as deactivateTabListeners, importAllTabs, getTabStats } from './tabs.js';
import { initHistorySync, activateListener as activateHistoryListener, deactivateListener as deactivateHistoryListener, importAllHistory, getHistoryStats } from './history.js';

const AUTO_SYNC_ALARM = 'peek-auto-sync';
const SYNC_INTERVAL_MINUTES = 15;

// ==================== Install ====================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[peek:bg] onInstalled:', details.reason);

  try {
    await openDatabase();
    await ensureDefaultProfile();

    // Stamp active profile with environment info
    const profile = await getCurrentProfile();
    if (profile.success && profile.data) {
      const env = await getEnvironment();
      await updateProfileEnvironment(profile.data.id, env);
    }
  } catch (error) {
    console.error('[peek:bg] Init error:', error);
  }

  // Initialize bookmark sync listener if enabled
  await initBookmarkSync();

  // Initialize tab sync listener if enabled
  await initTabSync();

  // Initialize history sync listener if enabled
  await initHistorySync();

  // Set up auto-sync alarm
  chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });

  // Open options page on first install
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ==================== Service Worker Restart ====================

(async () => {
  try {
    await openDatabase();
    await initBookmarkSync();
    await initTabSync();
    await initHistorySync();
  } catch (error) {
    console.error('[peek:bg] Sync init error:', error);
  }
})();

// ==================== Toolbar Button ====================

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ==================== Alarms ====================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_SYNC_ALARM) return;

  console.log('[peek:bg] Auto-sync alarm fired');

  try {
    const configResult = await getFullSyncConfig();
    const config = configResult.data;

    if (!config.autoSync || !config.apiKey) {
      console.log('[peek:bg] Auto-sync skipped (not configured or disabled)');
      return;
    }

    await openDatabase();
    const result = await syncAll();
    console.log('[peek:bg] Auto-sync complete:', result.data);
  } catch (error) {
    console.error('[peek:bg] Auto-sync error:', error);
  }
});

// ==================== Message Handling ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'sync-now') {
    handleSyncNow().then(sendResponse);
    return true; // async response
  }

  if (message.type === 'get-diagnostics') {
    handleGetDiagnostics().then(sendResponse);
    return true;
  }

  if (message.type === 'save-tags') {
    handleSaveTags(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'save-note') {
    handleSaveNote(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'search-items') {
    handleSearchItems(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'bookmark-sync-toggle') {
    handleBookmarkSyncToggle(message.enabled).then(sendResponse);
    return true;
  }

  if (message.type === 'tab-sync-toggle') {
    handleTabSyncToggle(message.enabled).then(sendResponse);
    return true;
  }

  if (message.type === 'history-sync-toggle') {
    handleHistorySyncToggle(message.enabled).then(sendResponse);
    return true;
  }

  if (message.type === 'get-bookmark-stats') {
    handleGetBookmarkStats().then(sendResponse);
    return true;
  }

  if (message.type === 'get-tab-stats') {
    handleGetTabStats().then(sendResponse);
    return true;
  }

  if (message.type === 'get-history-stats') {
    handleGetHistoryStats().then(sendResponse);
    return true;
  }

  if (message.type === 'set-server') {
    handleSetServer(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'set-api-key') {
    handleSetApiKey(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'get-sync-config') {
    handleGetSyncConfig().then(sendResponse);
    return true;
  }
});

async function handleSyncNow() {
  try {
    await openDatabase();
    const result = await syncAll();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleBookmarkSyncToggle(enabled) {
  try {
    await openDatabase();
    if (enabled) {
      activateListener();
      const result = await importAllBookmarks();
      return result;
    } else {
      deactivateListener();
      return { disabled: true };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleTabSyncToggle(enabled) {
  try {
    await openDatabase();
    if (enabled) {
      activateTabListeners();
      const result = await importAllTabs();
      return result;
    } else {
      deactivateTabListeners();
      return { disabled: true };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleHistorySyncToggle(enabled) {
  try {
    await openDatabase();
    if (enabled) {
      activateHistoryListener();
      const result = await importAllHistory();
      return result;
    } else {
      deactivateHistoryListener();
      return { disabled: true };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleGetBookmarkStats() {
  try {
    return await getBookmarkStats();
  } catch (error) {
    return { browserBookmarks: 0, imported: 0, synced: 0 };
  }
}

async function handleGetTabStats() {
  try {
    return await getTabStats();
  } catch (error) {
    return { openTabs: 0, imported: 0, synced: 0 };
  }
}

async function handleGetHistoryStats() {
  try {
    return await getHistoryStats();
  } catch (error) {
    return { historyItems: 0, imported: 0, synced: 0 };
  }
}

// ==================== Command Bar Handlers ====================

async function handleSaveTags(data) {
  const { url, title, tags } = data;

  if (!url || !tags || tags.length === 0) {
    return { success: false, error: 'URL and tags are required' };
  }

  try {
    await openDatabase();

    // Import from datastore
    const { addItem, getOrCreateTag, tagItem, queryItems } = await import('./datastore.js');

    // Check if this URL already exists
    const existing = await queryItems({ type: 'url', url });
    let itemId;

    if (existing.success && existing.data && existing.data.length > 0) {
      itemId = existing.data[0].id;
    } else {
      // Create new URL item
      const result = await addItem('url', { url, title });
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to create item' };
      }
      itemId = result.data.id;
    }

    // Add each tag
    for (const tagName of tags) {
      const tagResult = await getOrCreateTag(tagName);
      if (tagResult.success && tagResult.data) {
        await tagItem(itemId, tagResult.data.tag.id);
      }
    }

    return { success: true, data: { itemId, tags } };
  } catch (error) {
    console.error('[peek:bg] Save tags error:', error);
    return { success: false, error: error.message };
  }
}

async function handleSaveNote(data) {
  const { url, title, note } = data;

  if (!note) {
    return { success: false, error: 'Note content is required' };
  }

  try {
    await openDatabase();

    const { addItem } = await import('./datastore.js');

    // Create a text item for the note
    // Include URL as metadata if provided
    const metadata = url ? { sourceUrl: url, sourceTitle: title } : {};

    const result = await addItem('text', {
      content: note,
      title: title ? `Note: ${title}` : 'Note',
      metadata
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Failed to save note' };
    }

    return { success: true, data: { id: result.data.id } };
  } catch (error) {
    console.error('[peek:bg] Save note error:', error);
    return { success: false, error: error.message };
  }
}

async function handleSearchItems(data) {
  const { query } = data;

  if (!query) {
    return { success: false, error: 'Search query is required' };
  }

  try {
    await openDatabase();

    const { queryItems } = await import('./datastore.js');

    // Search items - the queryItems function should support text search
    // For now, we'll do a simple filter on title/content
    const allItems = await queryItems({});

    if (!allItems.success) {
      return { success: false, error: allItems.error };
    }

    const lowerQuery = query.toLowerCase();
    const results = (allItems.data || []).filter(item => {
      const title = (item.title || '').toLowerCase();
      const content = (item.content || '').toLowerCase();
      const url = (item.url || '').toLowerCase();
      return title.includes(lowerQuery) ||
             content.includes(lowerQuery) ||
             url.includes(lowerQuery);
    }).slice(0, 20).map(item => ({
      id: item.id,
      type: item.type,
      title: item.title,
      url: item.url,
      snippet: item.content ? item.content.substring(0, 100) : null
    }));

    return { success: true, data: results };
  } catch (error) {
    console.error('[peek:bg] Search error:', error);
    return { success: false, error: error.message };
  }
}

async function handleGetDiagnostics() {
  try {
    await openDatabase();
    const status = await getSyncStatus();
    const profile = await getCurrentProfile();
    const environment = await getEnvironment();

    return {
      success: true,
      data: {
        syncStatus: status.data,
        activeProfile: profile.data,
        environment,
        versions: {
          datastore: DATASTORE_VERSION,
          protocol: PROTOCOL_VERSION,
        },
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleSetServer(data) {
  const { serverUrl } = data;

  try {
    await setEngineConfig({ serverUrl });
    return { success: true };
  } catch (error) {
    console.error('[peek:bg] Set server error:', error);
    return { success: false, error: error.message };
  }
}

async function handleSetApiKey(data) {
  const { apiKey } = data;

  if (!apiKey) {
    return { success: false, error: 'API key is required' };
  }

  try {
    const profileResult = await getCurrentProfile();
    if (!profileResult.success || !profileResult.data) {
      return { success: false, error: 'No active profile' };
    }

    const profile = profileResult.data;
    // Enable sync with the API key (serverProfileId defaults to 'default')
    await enableSync(profile.id, apiKey, 'default');

    return { success: true };
  } catch (error) {
    console.error('[peek:bg] Set API key error:', error);
    return { success: false, error: error.message };
  }
}

async function handleGetSyncConfig() {
  try {
    const config = await getEngineConfig();
    return {
      success: true,
      data: {
        serverUrl: config.serverUrl || null,
        apiKey: config.apiKey || null,
      }
    };
  } catch (error) {
    console.error('[peek:bg] Get sync config error:', error);
    return { success: false, error: error.message };
  }
}
