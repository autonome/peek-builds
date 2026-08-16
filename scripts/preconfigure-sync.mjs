/**
 * Pre-configure sync settings and run initial sync for test profile
 *
 * This script must still be run with Electron (not Node): it loads
 * apps/desktop/dist/main/datastore.js and profiles.js, which open the
 * desktop's datastore with better-sqlite3 compiled for Electron's Node
 * version. The sync package's own adapter (packages/sync/adapters/node-sqlite.js)
 * no longer needs better-sqlite3 — it runs on node:sqlite — but that doesn't
 * remove the constraint here, since it's the desktop datastore/profiles
 * modules driving it under the hood.
 *
 * Usage: electron scripts/preconfigure-sync.mjs
 *
 * Environment variables:
 * - PROFILE: Profile name (required)
 * - SERVER_URL: Sync server URL (required)
 * - API_KEY: Server API key (required)
 */

import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

// Prevent Electron from showing a window
app.disableHardwareAcceleration();

const PROFILE = process.env.PROFILE;
const SERVER_URL = process.env.SERVER_URL;
const API_KEY = process.env.API_KEY;

if (!PROFILE || !SERVER_URL || !API_KEY) {
  console.error('Missing required environment variables: PROFILE, SERVER_URL, API_KEY');
  process.exit(1);
}

app.whenReady().then(async () => {
  // Import compiled modules (after app is ready)
  const datastore = await import('../apps/desktop/dist/main/datastore.js');
  const profiles = await import('../apps/desktop/dist/main/profiles.js');

  // Import sync engine
  const { createEngine, createNodeSqliteAdapter } = await import('../packages/sync/index.js');

  // Paths
  const userDataPath = join(homedir(), 'Library', 'Application Support', 'Peek');
  const profileDir = join(userDataPath, PROFILE);
  const dbPath = join(profileDir, 'datastore.sqlite');

  console.log(`  Profile: ${PROFILE}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Server: ${SERVER_URL}`);

  // Create profile directory if needed
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
    console.log('  Created profile directory');
  }

  // Initialize profiles database (uses .dev-profiles.db for dev builds)
  profiles.initProfilesDb(userDataPath, '.dev-profiles.db');
  profiles.migrateExistingProfiles();
  profiles.ensureDefaultProfile();

  // Create the test profile if it doesn't exist
  try {
    const existingProfile = profiles.getProfileByFolder(PROFILE);
    if (!existingProfile) {
      profiles.createProfile(PROFILE);
      console.log('  Created test profile in profiles.db');
    }
  } catch (error) {
    // Profile might already exist with different name
    console.log(`  Profile setup: ${error.message}`);
  }

  // Set this profile as active
  try {
    profiles.setActiveProfile(PROFILE);
    console.log('  Set active profile');
  } catch (error) {
    console.log(`  Could not set active profile: ${error.message}`);
  }

  // Initialize datastore (creates schema including settings table)
  const dbInstance = datastore.initDatabase(dbPath);
  console.log('  Database initialized');

  // Enable sync for this profile
  const activeProfile = profiles.getActiveProfile();
  profiles.enableSync(activeProfile.id, API_KEY, process.env.SERVER_PROFILE_ID || 'default');

  // Create sync engine wrapping the same db instance (still a better-sqlite3
  // handle from the desktop datastore — the adapter itself just needs
  // exec/prepare().run/get/all, which both drivers provide)
  const adapter = createNodeSqliteAdapter(dbInstance);
  await adapter.open();

  const { sync } = createEngine(adapter, {
    getConfig: () => ({
      serverUrl: SERVER_URL,
      apiKey: API_KEY,
      serverProfileId: process.env.SERVER_PROFILE_ID || 'default',
      lastSyncTime: 0,
    }),
    setConfig: async (updates) => {
      if (updates.lastSyncTime !== undefined) {
        try {
          profiles.updateLastSyncTime(activeProfile.id, updates.lastSyncTime);
        } catch (error) {
          console.log(`  Could not update lastSyncTime: ${error.message}`);
        }
      }
    },
  });

  console.log('  Sync engine configured');

  // Run sync (full bidirectional if SYNC_MODE=full, otherwise pull-only)
  try {
    if (process.env.SYNC_MODE === 'full') {
      const result = await sync.syncAll();
      console.log(`  Full sync: ${result.pulled} pulled, ${result.pushed} pushed`);
    } else {
      const result = await sync.pullFromServer();
      console.log(`  Pulled ${result.pulled} items from server`);
    }
  } catch (error) {
    console.error('  Sync failed:', error.message);
    datastore.closeDatabase();
    profiles.closeProfilesDb();
    app.exit(1);
    return;
  }

  // Close databases
  datastore.closeDatabase();
  profiles.closeProfilesDb();
  console.log('  Pre-configuration complete');

  app.exit(0);
});

// Handle window-all-closed to prevent default behavior
app.on('window-all-closed', () => {
  // Do nothing - we'll exit manually
});
