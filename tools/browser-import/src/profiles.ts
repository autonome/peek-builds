/**
 * Browser profile discovery
 *
 * Scans known browser profile directories on macOS, Linux, and Windows
 * to find all browser profiles and their available data files.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import type { BrowserProfile, BrowserName, DataFileInfo, DataType } from './types.js';

interface BrowserPaths {
  mac: string;
  linux: string;
  windows: string;
}

const BROWSER_PATHS: Record<BrowserName, BrowserPaths> = {
  firefox: {
    mac: join(homedir(), 'Library/Application Support/Firefox/Profiles'),
    linux: join(homedir(), '.mozilla/firefox'),
    windows: join(homedir(), 'AppData/Roaming/Mozilla/Firefox/Profiles'),
  },
  chrome: {
    mac: join(homedir(), 'Library/Application Support/Google/Chrome'),
    linux: join(homedir(), '.config/google-chrome'),
    windows: join(homedir(), 'AppData/Local/Google/Chrome/User Data'),
  },
  brave: {
    mac: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    linux: join(homedir(), '.config/BraveSoftware/Brave-Browser'),
    windows: join(homedir(), 'AppData/Local/BraveSoftware/Brave-Browser/User Data'),
  },
};

/** Firefox data files to look for */
const FIREFOX_DATA_FILES: Array<{ type: DataType; filename: string; importable: boolean }> = [
  { type: 'history', filename: 'places.sqlite', importable: true },
  { type: 'bookmarks', filename: 'places.sqlite', importable: true },
  { type: 'sessions', filename: 'sessionstore-backups', importable: true },
  { type: 'passwords', filename: 'logins.json', importable: false },
  { type: 'cookies', filename: 'cookies.sqlite', importable: false },
  { type: 'formdata', filename: 'formhistory.sqlite', importable: false },
  { type: 'extensions', filename: 'extensions.json', importable: false },
];

/** Chromium data files to look for */
const CHROMIUM_DATA_FILES: Array<{ type: DataType; filename: string; importable: boolean }> = [
  { type: 'history', filename: 'History', importable: true },
  { type: 'bookmarks', filename: 'Bookmarks', importable: true },
  { type: 'sessions', filename: 'Preferences', importable: true },
  { type: 'passwords', filename: 'Login Data', importable: false },
  { type: 'cookies', filename: 'Cookies', importable: false },
  { type: 'formdata', filename: 'Web Data', importable: false },
];

function getPlatformKey(): 'mac' | 'linux' | 'windows' {
  const p = platform();
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

function checkDataFiles(profilePath: string, dataFiles: Array<{ type: DataType; filename: string; importable: boolean }>): DataFileInfo[] {
  const results: DataFileInfo[] = [];
  const seen = new Set<DataType>();

  for (const df of dataFiles) {
    // Avoid duplicate entries (e.g., history and bookmarks both use places.sqlite in Firefox)
    if (seen.has(df.type)) continue;
    seen.add(df.type);

    const filePath = join(profilePath, df.filename);
    results.push({
      type: df.type,
      path: filePath,
      exists: existsSync(filePath),
      importable: df.importable,
    });
  }

  return results;
}

/**
 * Discover Firefox profiles by reading profiles.ini
 */
function discoverFirefoxProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  const platformKey = getPlatformKey();
  const profilesDir = BROWSER_PATHS.firefox[platformKey];

  // Firefox uses profiles.ini one level up from the Profiles directory
  const firefoxRoot = join(profilesDir, '..');
  const profilesIniPath = join(firefoxRoot, 'profiles.ini');

  if (existsSync(profilesIniPath)) {
    try {
      const content = readFileSync(profilesIniPath, 'utf-8');
      const sections = content.split(/\[([^\]]+)\]/);

      for (let i = 1; i < sections.length; i += 2) {
        const sectionName = sections[i];
        const sectionContent = sections[i + 1];

        if (!sectionName.startsWith('Profile')) continue;

        const pathMatch = sectionContent.match(/Path=(.+)/);
        const nameMatch = sectionContent.match(/Name=(.+)/);
        const isRelative = sectionContent.match(/IsRelative=(\d)/);

        if (pathMatch) {
          const profilePath = isRelative && isRelative[1] === '1'
            ? join(firefoxRoot, pathMatch[1].trim())
            : pathMatch[1].trim();

          if (existsSync(profilePath)) {
            profiles.push({
              browser: 'firefox',
              profileName: nameMatch ? nameMatch[1].trim() : basename(profilePath),
              profilePath,
              dataFiles: checkDataFiles(profilePath, FIREFOX_DATA_FILES),
            });
          }
        }
      }
    } catch {
      // Can't read profiles.ini
    }
  }

  // Fallback: scan the Profiles directory directly
  if (profiles.length === 0 && existsSync(profilesDir)) {
    try {
      const entries = readdirSync(profilesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const profilePath = join(profilesDir, entry.name);
          // Check if it looks like a Firefox profile (has places.sqlite)
          if (existsSync(join(profilePath, 'places.sqlite'))) {
            profiles.push({
              browser: 'firefox',
              profileName: entry.name,
              profilePath,
              dataFiles: checkDataFiles(profilePath, FIREFOX_DATA_FILES),
            });
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }

  return profiles;
}

/**
 * Discover Chromium-based browser profiles (Chrome, Brave).
 * Profile directories are "Default", "Profile 1", "Profile 2", etc.
 */
function discoverChromiumProfiles(browser: 'chrome' | 'brave'): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  const platformKey = getPlatformKey();
  const browserDir = BROWSER_PATHS[browser][platformKey];

  if (!existsSync(browserDir)) return profiles;

  try {
    const entries = readdirSync(browserDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Chrome profiles are named "Default", "Profile 1", "Profile 2", etc.
      if (entry.name === 'Default' || entry.name.startsWith('Profile ')) {
        const profilePath = join(browserDir, entry.name);
        // Verify it's a real profile by checking for History file
        if (existsSync(join(profilePath, 'History')) || existsSync(join(profilePath, 'Bookmarks'))) {
          profiles.push({
            browser,
            profileName: entry.name,
            profilePath,
            dataFiles: checkDataFiles(profilePath, CHROMIUM_DATA_FILES),
          });
        }
      }
    }
  } catch {
    // Can't read directory
  }

  return profiles;
}

/**
 * Discover all browser profiles on this system
 */
export function discoverAllProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];

  profiles.push(...discoverFirefoxProfiles());
  profiles.push(...discoverChromiumProfiles('chrome'));
  profiles.push(...discoverChromiumProfiles('brave'));

  return profiles;
}

/**
 * Find a profile by a search string (browser/name, path, or partial match)
 */
export function findProfile(query: string, profiles: BrowserProfile[]): BrowserProfile | null {
  // Exact path match
  const byPath = profiles.find(p => p.profilePath === query);
  if (byPath) return byPath;

  // Browser/name match (e.g., "firefox/default-release")
  const byBrowserName = profiles.find(p =>
    `${p.browser}/${p.profileName}`.toLowerCase() === query.toLowerCase()
  );
  if (byBrowserName) return byBrowserName;

  // Partial name match
  const byPartialName = profiles.find(p =>
    p.profileName.toLowerCase().includes(query.toLowerCase()) ||
    p.browser.toLowerCase().includes(query.toLowerCase())
  );
  if (byPartialName) return byPartialName;

  return null;
}
